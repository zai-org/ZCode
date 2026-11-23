import { createTestAgentRuntime, createTestModelSelection } from "./helpers/test-agent-runtime.js";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import type { DwfArtifactItem, DwfRunSessionListItem } from "@zcode/adapters/storage";
import {
  CoreErrorType,
  ESCALATE_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
  createSessionId,
  type CollaborationMode,
  type CreateSessionTaskLinkInput,
  type DynamicWorkflowRunProgressPayload,
  type SessionEventStorePort,
  type SessionId,
  type SessionStorePort,
  type ToolArtifactStorePort,
} from "@zcode/contracts";
import {
  InMemoryJournalStore,
  refToString,
  type JournalStorePort,
  type NodeRecord,
  type RunRecord,
  type RunStatus,
  type RunStopReason,
} from "@zcode/dynamic-workflow";
import {
  createDynamicWorkflowRunService,
  type DynamicWorkflowActorRuntimeInput,
} from "../src/app/dynamic-workflow-run-service.js";
import { type WorkflowConcurrencyPort } from "../src/app/workflow-concurrency-governor.js";
import { workflowActorModelPolicy } from "../src/app/workflow-actor-model.js";
import { workflowActorToolPolicy } from "../src/app/workflow-actor-tools.js";
import {
  fakeFileSystemPort,
  unsupportedExecutionPort,
  type PlannedResponse,
} from "./workflow-driver.helpers.js";
import type { ExecutionPort } from "@zcode/contracts";

/** 一个 typed ask 的最小脚本；actor ref 为 actor#1@1，ask 站点为 ask#1。 */
export const TYPED_SCRIPT = [
  "interface Answer { text: string }",
  'const a = await agent("worker").ask<Answer>("do the thing");',
  "return a.text;",
].join("\n");

/**
 * 本文件的模型计划比 helpers 的多一种：`escalate` 发一次真的 `escalate` 工具调用。
 * 它让「actor 撞墙 → 提问 → 拿到答案 → 继续干活」整条线经**真实工具层**跑一遍，而不是由
 * 测试直接持端口扮演模型（那样漏掉注册门、allowlist 补回、工具结果回灌三段）。
 */
export type ActorPlan =
  | PlannedResponse
  | { kind: "escalate"; question: string; context?: string }
  // 一次真的 `Write` 工具调用：让「子代理写文件 → 执行器发 ToolCallStarted → driver 上报 → 引擎关导入缓存」
  // 整条线经真实工具层跑一遍（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Amend-resume」）。
  | { kind: "write"; path: string; content: string }
  // 挂起，但**理会取消**：turn 随 abort 信号 reject，与真实 provider 一样。
  //
  // 与 `hang` 的区别不是细节而是分水岭：`hang` 模拟的是一个连 AbortSignal 都不看的 provider，
  // 它的 turn 永远落不了地，于是那个会话「写完了没有」永远答不上来（driver 的静默账因此
  // 拒绝接续它的在飞 ask，见 workflow-driver-quiescence.ts）。本种类才是正常形状。
  | { kind: "hang-until-cancelled" }
  // 模型请求以 adapter 错误 reject（模型侧错误收容用例）。
  | { kind: "throw"; error: unknown };

/** 一次 generateText 请求的观察面：模型这一轮看见的消息与被提供的工具。 */
export interface ModelRequestLog {
  requests: { messages?: unknown; tools?: readonly { name: string }[] }[];
}

/** 脚本化 model adapter（同 workflow-driver.helpers 的模式，本文件按 actor 键取计划）。 */
export function scriptedModelAdapter(
  responses: ActorPlan[],
  onCall?: () => void,
  log?: ModelRequestLog,
): unknown {
  let index = 0;
  return {
    async generateText(request?: {
      abortSignal?: AbortSignal;
      messages?: unknown;
      tools?: readonly { name: string }[];
    }) {
      onCall?.();
      log?.requests.push({ messages: request?.messages, tools: request?.tools });
      const planned: ActorPlan = responses[index++] ?? {
        kind: "text",
        text: "(no further scripted response)",
      };
      // 挂起：模拟一个在飞 turn（取消/恢复用例靠它把 run 停在可预测的节点上）。
      if (planned.kind === "hang") return new Promise(() => {});
      if (planned.kind === "hang-until-cancelled") {
        const signal = request?.abortSignal;
        // 没有信号就退化成 hang（不该发生：driver 每个 ask 都建 AbortController）。
        if (signal === undefined) return new Promise(() => {});
        return new Promise((_resolve, reject) => {
          const fail = (): void => reject(new Error("model request aborted"));
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail, { once: true });
        });
      }
      if (planned.kind === "throw") throw planned.error;
      const usage = { inputTokens: 12, outputTokens: 8, totalTokens: 20 };
      if (planned.kind === "submit") {
        return {
          finishReason: "tool-calls",
          model: "scripted",
          providerMetadata: undefined,
          text: "",
          toolCalls: [
            {
              id: `submit-call-${index}`,
              name: SUBMIT_RESULT_TOOL_NAME,
              input: { result: planned.result },
            },
          ],
          usage,
        };
      }
      if (planned.kind === "write") {
        return {
          finishReason: "tool-calls",
          model: "scripted",
          providerMetadata: undefined,
          text: "",
          toolCalls: [
            {
              id: `write-call-${index}`,
              name: "Write",
              input: { file_path: planned.path, content: planned.content },
            },
          ],
          usage,
        };
      }
      if (planned.kind === "escalate") {
        return {
          finishReason: "tool-calls",
          model: "scripted",
          providerMetadata: undefined,
          text: "",
          toolCalls: [
            {
              id: `escalate-call-${index}`,
              name: ESCALATE_TOOL_NAME,
              input: {
                question: planned.question,
                ...(planned.context === undefined ? {} : { context: planned.context }),
              },
            },
          ],
          usage,
        };
      }
      return {
        finishReason: "stop",
        model: "scripted",
        providerMetadata: undefined,
        text: planned.text,
        usage,
      };
    },
  };
}

export interface HarnessOptions {
  actorScripts?: Record<string, ActorPlan[]>;
  availableParallelism?: () => number;
  /** 进程级治理器的窄端口；缺省不接（actor 不受闸门约束，launch 也不登记上界）。 */
  concurrency?: WorkflowConcurrencyPort;
  journal?: JournalStorePort;
  /** 让 actor runtime 的 turn 永不自行结束，用于取消用例。 */
  hangActors?: boolean;
  actorCleanup?: () => Promise<void>;
  /**
   * 会话静默的有界等待上界（缺省 {@link AMEND_TRANSCRIPT_QUIESCE_MS} = 5 秒）。只有「修订一个
   * turn 落不了地的在飞前驱」这一条路会真的等满，所以只有那组用例需要把它缩下来。
   */
  quiesceMs?: number;
  onRunEvent?: (progress: DynamicWorkflowRunProgressPayload) => void;
  /** 父会话当前的权限模式（docs/dynamic-workflow/launch.md「Permissions inside a run」）；缺省不接。 */
  permissionMode?: () => CollaborationMode;
  /** 本服务实例的父会话（孤儿收敛的作用域）。 */
  parentSessionId?: string;
  /**
   * 常驻登记钩子（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Engine ownership」规则一）。
   * **缺省不接**：本文件其余全部用例因此同时充当「宿主无常驻概念时行为不变」的回归。
   */
  registerResidencyBlockingWork?: (work: Promise<unknown>) => void;
  /** 发起锚点解析（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Token telemetry for subagents」）：缺省即宿主没有活动轮。 */
  resolveLaunchInputId?: (trace: { turnId?: string }) => string | undefined;
  /** 让 resumeFromStore 抛 SessionNotFound（会话被清理的回退用例）。 */
  resumeSessionMissing?: boolean;
  /**
   * 真实会话存储：接上它，actor 的消息才真的落库，service 也才把转录面交到 driver 手上
   * （ask 边界记账的前提，apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）。缺省不接。
   */
  sessionStore?: SessionStorePort;
  /** 用户面产物的落点。缺省不接——内容成员因此以 ArtifactStoreUnavailable 拒绝。 */
  artifactStore?: ToolArtifactStorePort;
  taskLinkStore?: { createSessionTaskLink(input: CreateSessionTaskLinkInput): Promise<unknown> };
  /** 补全落在没有草稿的 run 上时铸草稿的注入点（留白那组用例）；缺省不接。 */
  writeWorkflowDraft?: Parameters<typeof createDynamicWorkflowRunService>[0]["writeWorkflowDraft"];
  /** world.run 的执行端口；缺省触及即失败（本文件绝大多数用例不该跑命令）。 */
  executionPort?: ExecutionPort;
}

export interface Harness {
  /** actor runtime 共享的 event store（生产里就是**父 runtime 的** store）。 */
  actorEventStore: SessionEventStorePort;
  /** 每个 actor 的模型请求流水（键为 actor ref 串）；工具面与工具结果的观察面。 */
  actorModelRequests: Record<string, ModelRequestLog>;
  actorRuntimeInputs: DynamicWorkflowActorRuntimeInput[];
  /**
   * 对 actor runtime 调 subscribeEvents 的会话。run service 自己**一次都不许**（旧死接缝）；
   * driver 为限流观察每个 actor 订阅恰好一次（docs/dynamic-workflow/concurrency.md「Protocol and UI」），
   * 那条订阅只读 ModelNetworkStatus，不是 transcript 直播通道。
   */
  actorSubscribeCalls: SessionId[];
  journal: JournalStorePort;
  /** 服务记下的日志（孤儿收敛要求逐条 warn）。 */
  logs: { level: string; message: string; context?: Record<string, unknown> }[];
  /** 每个 actor 的构造/持久化/直播/建链/首轮模型调用的**发生顺序**。 */
  order: string[];
  persistedTitles: string[];
  /** resumeFromStore 被调用的 actor 会话（rehydration 用例的观察面）。 */
  resumeCalls: SessionId[];
  runEvents: DynamicWorkflowRunProgressPayload[];
  runEventRoutings: { parentSessionId?: string }[];
  service: ReturnType<typeof createDynamicWorkflowRunService>;
  sessionEvents: unknown[];
  taskLinks: CreateSessionTaskLinkInput[];
}

/** 本服务实例的默认父会话；孤儿收敛的用例围绕它与「别的会话」对照。 */
export const HARNESS_PARENT_SESSION = createSessionId("harness-parent");
/**
 * harness 里「父会话当前模型」：与 createTestAgentRuntime 的缺省 selection 同一个值，于是
 * 「不覆盖」与「覆盖成父模型」在这里落到同一条记录——照生产（create-app.ts 把
 * `getRuntime().getSessionModelSelection()` 交给模型策略作 parentSelection）。
 */
export const HARNESS_PARENT_MODEL = createTestModelSelection("test/default-runtime-model");

/**
 * 带孤儿收敛窄查询的 journal 替身。真正的 SQL 语义（按父会话预筛非终态行）在
 * `adapters/tests/dwf-journal-store.test.ts` 里对真库钉住；这里只要一个能被 run service
 * 的能力探测认出来的实现，好让「收敛什么、写什么失败」这层策略可以被单独断言。
 */
export class SweepableJournalStore extends InMemoryJournalStore {
  private readonly createdRunIds: string[] = [];
  /** 行时间戳的替身：真库由 SQL 维护 time_created/time_updated，内存实现不带时间。 */
  private readonly rowTimes = new Map<string, number>();
  private clock = 1_700_000_000_000;

  override createRun(record: RunRecord): void {
    super.createRun(record);
    this.createdRunIds.push(record.runId);
    // 每行递增一毫秒：让「最近更新在前」在替身里也是一个可断言的事实。
    this.clock += 1;
    this.rowTimes.set(record.runId, this.clock);
  }

  /** 某行的替身时间戳（测试据它断言 updatedAt 透传）。 */
  rowTimeOf(runId: string): number {
    const time = this.rowTimes.get(runId);
    if (time === undefined) throw new Error(`no row time for ${runId}`);
    return time;
  }

  listNonTerminalRuns(parentSessionId: string): RunRecord[] {
    return this.createdRunIds
      .map((runId) => this.getRun(runId))
      .filter(
        (run): run is RunRecord =>
          run !== undefined &&
          run.parentSessionId === parentSessionId &&
          !["completed", "errored", "stopped"].includes(run.status),
      );
  }

  /**
   * 枚举面替身：创建序反转近似「最近更新在前」；真正的 SQL 排序在 adapters 侧钉住。
   * 回窄投影 + 时间戳（{@link DwfRunSessionListItem}）——`result` 刻意不带，与真库
   * 不 select result_json 同规。
   */
  listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[] {
    return this.createdRunIds
      .map((runId) => this.getRun(runId))
      .filter(
        (run): run is RunRecord => run !== undefined && run.parentSessionId === parentSessionId,
      )
      .reverse()
      .slice(0, Math.max(0, limit))
      .map((run) => {
        const { result: _result, ...rest } = run;
        return {
          ...rest,
          timeCreated: this.rowTimeOf(run.runId),
          timeUpdated: this.rowTimeOf(run.runId),
        };
      });
  }

  /**
   * 产物读面替身（真库的两条 SQL 在 adapters 侧钉住；这里只要**语义**一致）。
   *
   * `listArtifactRows` = 该 run 的 `kind = "artifact"` 节点行，按插入序（= 版本序）。
   * **含失败行**：调用方自己按 status 过滤——「失败的发布不算一版」这条裁决属于读侧，
   * 让存储层替它做掉就没人能测到它。
   */
  listArtifactRows(runId: string): NodeRecord[] {
    return this.listNodes(runId, { kinds: "all", withResult: true }).filter(
      (node) => node.kind === "artifact",
    );
  }

  /**
   * `listArtifactItems` = 该 run 里 `type = "report"` 且 `artifactId` 相符的**事件**行，
   * 按 sequence 升序的一页。`limit` **精确**兑现且绝不自己钳（真库同规），`hasMore` 由这里判定。
   * 字节界不在替身里模拟——真库的字节规则由 adapters 的测试钉住。
   */
  listArtifactItems(
    runId: string,
    artifactId: string,
    query: { afterSequence?: number; limit: number; maxBytes: number },
  ): { items: DwfArtifactItem[]; hasMore: boolean } {
    if (query.limit <= 0) return { items: [], hasMore: false };
    const after = query.afterSequence ?? -1;
    const items: DwfArtifactItem[] = [];
    for (const stored of this.listEvents(runId, { types: "all", reportItems: "all" })) {
      if (stored.sequence <= after) continue;
      const event = stored.event as {
        type?: string;
        instance?: unknown;
        item?: unknown;
        artifactId?: unknown;
      };
      if (event.type !== "report" || event.artifactId !== artifactId) continue;
      if (items.length >= query.limit) return { items, hasMore: true };
      const instance = event.instance as { siteId?: string; ordinal?: number } | undefined;
      items.push({
        item: event.item,
        ordinal: instance?.ordinal ?? 0,
        sequence: stored.sequence,
        siteId: instance?.siteId ?? "report#1",
      });
    }
    return { items, hasMore: false };
  }
}

/** 预置一行 dwf_run（模拟上一个进程留下的记录）。 */
export function preloadRun(
  journal: JournalStorePort,
  input: {
    spentTokens?: number;
    caps?: { maxConcurrency: number };
    cwd?: string;
    failure?: { code: string; message: string };
    name?: string;
    parentSessionId?: string;
    result?: unknown;
    runId: string;
    scriptText?: string;
    status: RunStatus;
    stopReason?: RunStopReason;
  },
): void {
  journal.createRun({
    runId: input.runId,
    ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason }),
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.scriptText === undefined ? {} : { scriptText: input.scriptText }),
    ...(input.failure === undefined ? {} : { failure: input.failure as never }),
    ...("result" in input ? { result: input.result } : {}),
    caps: input.caps ?? { maxConcurrency: 4 },
    spentTokens: input.spentTokens ?? 0,
    status: input.status,
  });
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const journal = options.journal ?? new SweepableJournalStore();
  const actorRuntimeInputs: DynamicWorkflowActorRuntimeInput[] = [];
  const logs: { level: string; message: string; context?: Record<string, unknown> }[] = [];
  const persistedTitles: string[] = [];
  const runEvents: DynamicWorkflowRunProgressPayload[] = [];
  const runEventRoutings: { parentSessionId?: string }[] = [];
  const sessionEvents: unknown[] = [];
  const actorSubscribeCalls: SessionId[] = [];
  const resumeCalls: SessionId[] = [];
  const actorEventStore = createInMemorySessionEventStore();
  const taskLinks: CreateSessionTaskLinkInput[] = [];
  const order: string[] = [];
  const actorModelRequests: Record<string, ModelRequestLog> = {};

  const fileSystemPort = fakeFileSystemPort({});
  const logger = {
    debug: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "debug", message, context }),
    error: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "error", message, context }),
    info: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "info", message, context }),
    warn: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "warn", message, context }),
  };

  const service = createDynamicWorkflowRunService({
    ...(options.availableParallelism ? { availableParallelism: options.availableParallelism } : {}),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.resolveLaunchInputId === undefined
      ? {}
      : { resolveLaunchInputId: options.resolveLaunchInputId }),
    ...(options.sessionStore === undefined ? {} : { actorTranscriptStore: options.sessionStore }),
    ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
    // 只为把「会话静默」的有界等待缩到毫秒级（amend 接续在飞 ask 的闸门，见
    // workflow-driver-quiescence.ts）。其余 driver 时钟行为一概走真时间。
    ...(options.quiesceMs === undefined ? {} : { driverClock: { quiesceMs: options.quiesceMs } }),
    createActorRuntime: (input) => {
      actorRuntimeInputs.push(input);
      const key = refToString(input.actor);
      const responses: ActorPlan[] = options.hangActors
        ? []
        : (options.actorScripts?.[key] ?? [{ kind: "submit", result: { text: "done" } }]);
      order.push(`construct:${key}`);
      const modelRequests: ModelRequestLog = { requests: [] };
      actorModelRequests[key] = modelRequests;
      const runtime = createTestAgentRuntime(
        input.sessionId,
        {
          systemPrompt: input.persona.system ?? "You are a workflow actor.",
          mode: "yolo",
          taskType: "workflow_child",
          subagents: { enabled: false },
          ...workflowActorToolPolicy(input.persona),
          // 模型面照生产工厂（create-app.ts）展开：pin 与本 run 的 subagentModel 都进策略，
          // runtime 实际拿到的 selection 才是 journalActorResolvedModel 落库的那一条。少了这一层，
          // 「哪个来源赢」在 run service 层面就只能看工厂输入，看不到落库结果。
          ...workflowActorModelPolicy(
            {
              parentSelection: HARNESS_PARENT_MODEL,
              ...(input.runSubagentModel === undefined
                ? {}
                : { runSelection: input.runSubagentModel }),
              ...(input.actorModel === undefined ? {} : { actorSelection: input.actorModel }),
            },
            input.pinnedModel,
          ).configOverrides,
        },
        {
          // 生产接线的两个要点，照 script-workflow-child-runtime.ts：
          // (1) event store 与父 runtime 共享（这里用一个 harness 级 store 代表父的）；
          // (2) 直播 sink 是**构造期** dep，而不是事后 subscribeEvents。
          eventStore: actorEventStore,
          eventSink: {
            onSessionEvent: (event) => {
              if (sessionEvents.length === 0) order.push("sink");
              sessionEvents.push(event);
            },
          },
          modelAdapter: (options.hangActors
            ? {
                // 模拟真实适配器：取消时结束请求，否则新的关闭合同会正确地一直等待它。
                generateText: (request: { abortSignal?: AbortSignal }) =>
                  new Promise((_resolve, reject) => {
                    const signal = request.abortSignal;
                    if (signal?.aborted) reject(signal.reason);
                    else
                      signal?.addEventListener("abort", () => reject(signal.reason), {
                        once: true,
                      });
                  }),
              }
            : scriptedModelAdapter(
                responses,
                () => order.push(`turn:${refToString(input.actor)}`),
                modelRequests,
              )) as never,
          workflowSubmitPort: input.submitPort,
          // 照生产（script-workflow-child-runtime.ts）：两个控制端口一起进 actor 会话。
          // 端口在场 = `escalate` 进注册表，这是 actor 侧升级通道的唯一开关。
          workflowEscalatePort: input.escalatePort,
          fileSystemPort,
          ...(options.sessionStore === undefined ? {} : { sessionStore: options.sessionStore }),
        },
      );
      // 旧的死接缝：run service 曾在 persist 之后 subscribeEvents 当 transcript 直播通道。那条
      // 必须一次都不再发生（装在 seq 1 之后的订阅会让 v4 网关永远等 seq 1）。今天的订阅者只有
      // driver 的两个观察面（每 actor 各一次：限流观察读 ModelNetworkStatus，工具活动观察读
      // ToolCallStarted），下面的用例按此计数。
      if (options.actorCleanup) {
        const closeBrowserSession = runtime.closeBrowserSession.bind(runtime);
        runtime.closeBrowserSession = async () => {
          await closeBrowserSession();
          await options.actorCleanup!();
        };
      }
      const originalSubscribe = runtime.subscribeEvents.bind(runtime);
      runtime.subscribeEvents = (sink) => {
        actorSubscribeCalls.push(input.sessionId);
        return originalSubscribe(sink);
      };
      // ensureSessionPersistedForExternalActivity 在无 sessionStore 时是 no-op，
      // 所以这里包一层记录调用事实（顺序断言靠 taskLinks 与它的相对次序）。
      const original = runtime.ensureSessionPersistedForExternalActivity.bind(runtime);
      runtime.ensureSessionPersistedForExternalActivity = async (title, opts) => {
        persistedTitles.push(title);
        order.push(`persist:${key}`);
        return original(title, opts);
      };
      // resumeFromStore 全量替身（不调 original）：harness 的 runtime 没有 sessionStore，
      // 真实实现必抛配置错误。这里只钉「rehydration 被调/没被调」与回退路径；
      // 真实的 messageHistory 水化语义由 core 的 resume 测试负责。
      runtime.resumeFromStore = async () => {
        order.push(`resume:${key}`);
        resumeCalls.push(input.sessionId);
        if (options.resumeSessionMissing) {
          const gone = new Error("session not found (harness)");
          (gone as unknown as { type: unknown }).type = CoreErrorType.SessionNotFound;
          throw gone;
        }
        return { resumed: true } as never;
      };
      return runtime;
    },
    executionPort: options.executionPort ?? unsupportedExecutionPort(),
    fileSystemPort,
    journal,
    logger: logger as never,
    onRunEvent: (progress, routing) => {
      runEvents.push(progress);
      runEventRoutings.push(routing);
      options.onRunEvent?.(progress);
    },
    parentSessionId: options.parentSessionId ?? HARNESS_PARENT_SESSION,
    ...(options.writeWorkflowDraft === undefined
      ? {}
      : { writeWorkflowDraft: options.writeWorkflowDraft }),
    ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
    ...(options.registerResidencyBlockingWork === undefined
      ? {}
      : { registerResidencyBlockingWork: options.registerResidencyBlockingWork }),
    ...(options.taskLinkStore
      ? { taskLinkStore: options.taskLinkStore }
      : {
          taskLinkStore: {
            async createSessionTaskLink(input) {
              order.push(`link:${input.childSessionId}`);
              taskLinks.push(input);
              return input;
            },
          },
        }),
  });

  return {
    actorEventStore,
    actorModelRequests,
    actorRuntimeInputs,
    actorSubscribeCalls,
    journal,
    logs,
    order,
    persistedTitles,
    resumeCalls,
    runEventRoutings,
    runEvents,
    service,
    sessionEvents,
    taskLinks,
  };
}
