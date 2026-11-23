import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  SessionEventType,
  type DynamicWorkflowRunProgressPayload,
  type SessionEvent,
} from "@zcode/contracts";
import { createDenyPermissionBroker } from "@zcode/core";
import type { GlobalOptions } from "@zcode/shared-types";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import { readRuntimeFunction } from "./runtime-event-subscriber.js";

/**
 * headless（`-p`）下的 CreateWorkflow 审批旁路。
 *
 * 为什么需要它：headless 从不构造 permissionBroker，core 因此退到
 * `createDenyPermissionBroker()`（`core/src/runtime/agent-runtime.ts`、
 * `core/src/tool/executor/impl.ts`），而 CreateWorkflow 的 `alwaysAsk` gate
 * 在任何模式下都要过 broker（`yolo` 也不能跳，`core/src/permission/service.ts`
 * 的 alwaysAsk 分支在模式分支之前）。合起来的结果是 dwf 在 `-p` 下**必然被立即拒绝**，
 * 错误文案是 "ZCode requested permissions to use CreateWorkflow, but you haven't granted it yet."——不是挂起、不是超时。
 *
 * 旁路只按工具名放行 CreateWorkflow 一个，其余工具**委托给同一个 deny broker**：
 * 复用而不是复写它的拒绝语义，让「其余工具维持今日语义」成为结构性事实而不是巧合
 * （文案漂移不可能发生，因为只有一份）。
 *
 * 这不是权限旁路，只是 gate 旁路：
 * core 零改动，PermissionRequest hook 仍先于 broker 应答（`permission-flow.ts`
 * 的 `??` 短路），权限事件照常发射，run 内 actor 照旧继承会话的权限 profile。
 */
export const createHeadlessPermissionBroker = (): NonNullable<
  ZCodeAppOptions["permissionBroker"]
> => {
  const denyBroker = createDenyPermissionBroker();
  return {
    requestPermission: async (request, options) => {
      // AmendWorkflow 与 CreateWorkflow 同一道门、同一条例外。
      if (
        request.toolName !== CREATE_WORKFLOW_TOOL_NAME &&
        request.toolName !== AMEND_WORKFLOW_TOOL_NAME
      ) {
        return await denyBroker.requestPermission(request, options);
      }
      return {
        decision: "allow",
        reason: `Headless CLI auto-approves ${request.toolName}: no interactive gate exists in -p mode.`,
        resolvedAt: new Date(),
      };
    },
  };
};

/**
 * stream-json 里 dwf 进度行的 `type`。
 *
 * 刻意**不**进 `zcodeSessionEventTypeSchema`（`shared/src/zcode-protocol/index.ts`）：
 * 那是个闭集 `z.enum` 且喂给 `zcodeSessionEventSchema` 的 discriminated union，加值等于让
 * v3 app-server 在类型面上宣告一个它永不发出的事件。stream-json 是 CLI 私有输出格式，
 * 不受协议 strict schema 约束。
 */
export const WORKFLOW_RUN_PROGRESS_STREAM_TYPE = "workflow.run.progress";

/**
 * 一行定型的 dwf 进度 NDJSON。信封字段与 `mapSessionEvent` 逐字对齐（同一批 key、同样的
 * `String()`/`getTime()` 规范化），这样行读者不需要为这一种行换一套信封解释规则；
 * `payload` 是 contracts 的有界载荷**原样**，不重塑字段名。
 */
interface WorkflowRunProgressStreamLine {
  type: typeof WORKFLOW_RUN_PROGRESS_STREAM_TYPE;
  eventId: string;
  sessionId: string;
  seq: number;
  timestamp: number;
  traceId: string;
  payload: DynamicWorkflowRunProgressPayload;
}

/** 这条会话事件是 dwf 进度吗？stream-json 与 stderr 进度共用这道判别。 */
export const isDynamicWorkflowRunProgressEvent = (event: SessionEvent): boolean =>
  event.type === SessionEventType.DynamicWorkflowRunProgress;

const progressPayloadOf = (event: SessionEvent): DynamicWorkflowRunProgressPayload =>
  event.payload as DynamicWorkflowRunProgressPayload;

/**
 * dwf 进度事件 → 定型 NDJSON 行。
 *
 * 取代今天的裸漏：`mapSessionEventType` 的 default 把这个类型落成 catch-all
 * `session.updated`（`session-mapper.ts`），于是 stream-json 的消费者收到一行
 * 与「会话有什么东西变了」同名、却携带 run 内部载荷的行——无从分辨、也无法只订阅它。
 *
 * 注意 dwf 事件是**出回合**的（`turnId` 恒空），所以信封里不带
 * `turnId`：写一个恒为 undefined 的键只会让读者以为它有时有值。
 */
export const mapWorkflowRunProgressStreamLine = (
  event: SessionEvent,
): WorkflowRunProgressStreamLine => ({
  type: WORKFLOW_RUN_PROGRESS_STREAM_TYPE,
  eventId: String(event.id),
  sessionId: String(event.sessionId),
  seq: event.sequenceNumber,
  timestamp: event.timestamp.getTime(),
  traceId: String(event.traceId),
  payload: progressPayloadOf(event),
});

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const instanceLabel = (payload: Record<string, unknown>): string | undefined => {
  const instance = asRecord(payload.instance);
  const siteId = instance.siteId;
  if (typeof siteId !== "string") return undefined;
  const ordinal = instance.ordinal;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
};

/**
 * 引擎事件种类中的**状态迁移**面（`text` 模式 stderr 只讲这些 + `log`）。
 *
 * 词汇表来自 `toProtocolEvent` 的契约注释（`bootstrap/src/app/dynamic-workflow-run-launch.ts`）：
 * run-started / actor-created / node-queued / node-dispatched / node-repairing /
 * node-nudged / node-settled / usage-updated / log / run-settled。
 * `usage-updated` 与 `actor-created` 刻意不打印：前者是纯计数、后者不是迁移。
 */
const describeProgress = (payload: DynamicWorkflowRunProgressPayload): string | undefined => {
  const inner = asRecord(payload.payload);
  switch (payload.eventType) {
    case "run-started":
      return "started";
    case "run-settled": {
      // 终态词汇 completed / errored / stopped；
      // stopped 带原因：`stopped/provider: …`。
      const rawStatus = typeof inner.status === "string" ? inner.status : "settled";
      const status =
        typeof inner.stopReason === "string" ? `${rawStatus}/${inner.stopReason}` : rawStatus;
      const error = asRecord(inner.error).message;
      return typeof error === "string" ? `${status}: ${error}` : status;
    }
    case "log":
      return typeof inner.message === "string" ? `log: ${inner.message}` : undefined;
    case "node-queued":
    case "node-dispatched":
    case "node-repairing":
    case "node-nudged": {
      const label = instanceLabel(inner);
      return label ? `${payload.eventType.slice("node-".length)} ${label}` : undefined;
    }
    case "node-settled": {
      const label = instanceLabel(inner);
      const outcome = typeof inner.outcome === "string" ? inner.outcome : "settled";
      return label ? `settled ${label} (${outcome})` : undefined;
    }
    default:
      return undefined;
  }
};

/**
 * 迁移是否属于**必打**面。run 的开始与结算是这条进度流的两个端点，任何节流都不得吃掉它们
 * ——否则 `text` 模式可能在整个等待期间一个字都不打，然后突然打印最终答案。
 * `log` 是脚本作者显式发出的（`log()` facade），同样不节流：它的频率由脚本决定，
 * 而作者写下它就是为了被看到。
 */
const isUnthrottledProgress = (eventType: string): boolean =>
  eventType === "run-started" || eventType === "run-settled" || eventType === "log";

interface WorkflowProgressReporterInput {
  /** 进度只写 stderr——stdout 属于结果（`text` 模式在 stderr 打简短进度）。 */
  write: (line: string) => void;
  /** 注入时钟，让节流可被无睡眠单测穷举。 */
  now?: () => number;
  /** 节点相位迁移的最小间隔；`log` 与 run 端点不受它约束。 */
  throttleMs?: number;
}

/** 节点相位迁移的默认节流间隔。一个 100 节点的 run 约 5×100 条事件。 */
const DEFAULT_WORKFLOW_PROGRESS_THROTTLE_MS = 400;

/**
 * `--output-format text` 下的 stderr 进度打印器。
 * 只认 dwf 进度事件，其余会话事件直接忽略（返回后无副作用）。
 */
export const createWorkflowProgressReporter = (
  input: WorkflowProgressReporterInput,
): ((event: SessionEvent) => void) => {
  const now = input.now ?? Date.now;
  const throttleMs = input.throttleMs ?? DEFAULT_WORKFLOW_PROGRESS_THROTTLE_MS;
  let lastThrottledAt: number | undefined;
  return (event) => {
    if (!isDynamicWorkflowRunProgressEvent(event)) return;
    const payload = progressPayloadOf(event);
    const description = describeProgress(payload);
    if (description === undefined) return;
    if (!isUnthrottledProgress(payload.eventType)) {
      const at = now();
      if (lastThrottledAt !== undefined && at - lastThrottledAt < throttleMs) return;
      lastThrottledAt = at;
    }
    input.write(`workflow ${payload.runId}: ${description}\n`);
  };
};

interface HeadlessWriteStream {
  write: (chunk: string) => unknown;
}

interface HeadlessSessionObserverInput {
  options: Pick<GlobalOptions, "json" | "outputFormat">;
  stderr: HeadlessWriteStream;
  stdout: HeadlessWriteStream;
  /** 仅 `--output-format stream-json` 需要；缺席即不写 NDJSON。 */
  mapSessionEvent?: (event: SessionEvent) => unknown;
}

interface HeadlessSessionObserver {
  /** 唯一的会话事件消费者。装在**一个** sink 上——两个 sink 各写一次就是重复行。 */
  observe: (event: SessionEvent) => void;
  /**
   * 开始记录回合文本。必须在 `submitPrompt` 返回后**同步**调用：那一刻起到第一个 await
   * 之间没有任何事件能插队，所以通知驱动回合的第一条事件不会漏。
   * `excludeTurnId` 是首个回合的 id——它的文本已由 `submitPrompt` 的返回值给出，
   * 万一它的 `turn_complete` 迟到，靠这个 id 挡住重复计数。
   */
  beginWaitPhase: (excludeTurnId?: string) => void;
  /** 等待期内每个已完成回合的文本，按到达序。 */
  waitPhaseTurnResponses: () => readonly string[];
}

/**
 * headless 的会话事件观察者：把「按输出格式该做什么」与「等待需要知道什么」收在一处。
 *
 * 三种格式的分工：
 *   stream-json → 每条事件一行 NDJSON 到 stdout，dwf 进度走定型行；stderr 不重复。
 *   text        → 只有 dwf 进度，且只到 stderr（stdout 属于结果）。
 *   json        → 不写任何事件（契约是"恰好一个对象"）。
 *
 * 三种格式**都**要观察事件——即使 json 一个字都不打，等待期仍要靠这里记录回合文本。
 * 所以这个函数永远返回一个观察者，不再返回 undefined。
 */
export const createHeadlessSessionObserver = (
  input: HeadlessSessionObserverInput,
): HeadlessSessionObserver => {
  const { mapSessionEvent, options, stderr, stdout } = input;
  const writeStreamEvent = mapSessionEvent
    ? (event: SessionEvent) => {
        // One event per line, written as it happens. Deliberately not formatJson:
        // that pretty-prints with an indent, which would spread a single event
        // over several lines and break every line-oriented reader downstream.
        //
        // dwf 进度走定型行：mapSessionEvent 的 default 会把它落成 catch-all
        // `session.updated`（session-mapper.ts），读者既无从分辨、也没法
        // 只订阅它。
        const line = isDynamicWorkflowRunProgressEvent(event)
          ? mapWorkflowRunProgressStreamLine(event)
          : mapSessionEvent(event);
        stdout.write(`${JSON.stringify(line)}\n`);
      }
    : undefined;
  const reportProgress =
    mapSessionEvent === undefined && wantsWorkflowProgress(options)
      ? createWorkflowProgressReporter({ write: (line) => void stderr.write(line) })
      : undefined;

  let waiting = false;
  let excludedTurnId: string | undefined;
  const turnResponses: string[] = [];

  return {
    beginWaitPhase: (excludeTurnId) => {
      waiting = true;
      excludedTurnId = excludeTurnId;
    },
    waitPhaseTurnResponses: () => turnResponses,
    observe: (event) => {
      writeStreamEvent?.(event);
      reportProgress?.(event);
      if (!waiting || event.type !== SessionEventType.TurnComplete) return;
      // 首个回合的文本来自 submitPrompt 的返回值；它的 turn_complete 若迟到就会重复计数。
      if (event.turnId !== undefined && String(event.turnId) === excludedTurnId) return;
      const response = (event.payload as { response?: unknown }).response;
      if (typeof response === "string" && response.trim().length > 0) turnResponses.push(response);
    },
  };
};

/** runtime 的两个 busy 权威事实。窄接口而不是整个 AgentRuntime——等待只读这两个布尔。 */
interface HeadlessRuntimeFacts {
  hasActiveOrQueuedTurnWork: () => boolean;
  hasRunningBackgroundTasks: () => boolean;
}

/** 轮询间隔。等待期是分钟量级的，这个粒度的开销可忽略，而它决定退出的响应度。 */
const HEADLESS_SETTLE_POLL_INTERVAL_MS = 100;

/**
 * 等后台工作（Agent、Bash、workflow）结束 **+ 完成通知驱动的回合跑完**。
 *
 * 为什么轮询这两个布尔就够（无竞窗，这是本机制的关键论证）：后台任务转终态
 * （`background-tasks.ts` 的 `updateRuntimeBackgroundTask`）与通知命令入队
 * （`runtime-command-queue.ts`，经 `maybeEnqueueBackgroundTaskNotification` →
 * `enqueueBackgroundTaskNotification` → `enqueueRuntimeCommand`）之间**没有任何 await**，
 * 而 `drainRuntimeCommandQueue` 也在第一个 await 前就把 `runtimeCommandDrainActive` 置真。
 * 于是「任务已不 running」与「回合工作已 pending」在同一个同步块内翻转，轮询者无法落在中间。
 * 后台任务在启动它的回合内登记，所以 submitPrompt 返回时已经能读到。
 *
 * 每次运行都进等待：没有后台工作时第一次读就两者皆空，立即返回，输出与不等待相同。
 * 不按任务种类分开等：各种后台任务的通知回合交织在同一条队列上，分开等没有意义。
 *
 * 不设超时、不设 env 逃生口：永不结束的后台 Bash（开发服务器等）会让进程一直等，停止交给
 * 外层（Ctrl-C、信号、调用方的运行时限）。Ctrl-C 经既有孤儿收敛把 workflow run 记成
 * `stopped(interrupted)`（失败码 `Interrupted`，可 resume）。signal 一旦 abort 就立刻返回，绝不吞信号。
 */
export const waitForHeadlessSettle = async (input: {
  intervalMs?: number;
  runtime: HeadlessRuntimeFacts;
  signal: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> => {
  const intervalMs = input.intervalMs ?? HEADLESS_SETTLE_POLL_INTERVAL_MS;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (!input.signal.aborted) {
    if (!input.runtime.hasRunningBackgroundTasks() && !input.runtime.hasActiveOrQueuedTurnWork()) {
      return;
    }
    await sleep(intervalMs);
  }
};

/**
 * 这个 app 的 runtime 能提供 busy 事实吗？
 *
 * 动态读取的理由见 `runtime-event-subscriber.ts` 的 `readRuntimeFunction`（同一个
 * `RunDependencies.createZCodeApp` 注入点边界）。
 *
 * **不静默降级**：拿不到 busy 事实就不进等待——"这个宿主没有这个能力"的诚实答复，
 * 而不是假装等过了。
 */
export const readHeadlessRuntimeFacts = (runtime: unknown): HeadlessRuntimeFacts | undefined => {
  const turnWork = readRuntimeFunction(runtime, "hasActiveOrQueuedTurnWork");
  const backgroundTasks = readRuntimeFunction(runtime, "hasRunningBackgroundTasks");
  if (!turnWork || !backgroundTasks) return undefined;
  return {
    hasActiveOrQueuedTurnWork: () => turnWork.call(runtime) === true,
    hasRunningBackgroundTasks: () => backgroundTasks.call(runtime) === true,
  };
};

/**
 * 这次运行要不要在 stderr 打 workflow 进度？
 *
 * 只有 `text` 有这个位置：`json` 的契约是恰好一个对象，`stream-json` 已经把每条进度
 * 定型成 stdout 上的一行。缺省（无 --output-format、无 --json）就是 text，所以它也打。
 */
const wantsWorkflowProgress = (options: Pick<GlobalOptions, "json" | "outputFormat">): boolean =>
  options.outputFormat === undefined ? !options.json : options.outputFormat === "text";
