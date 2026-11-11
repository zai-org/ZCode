/**
 * dwf run service 的集成测试。装配照 workflow-driver.helpers.ts 的 runDriverScript：真实脚本 →
 * 真实编译 / schema 合成 / validate / lowering → 沙箱子进程 → 引擎核心 → 真实 AgentRuntime
 * driver，只把模型换成可预测的脚本化 adapter。被测对象是 run service 本身：编译一次、
 * 引擎独占 createRun、run 元数据落库、actor 会话真实化、取消语义、caps 默认值、事件分页。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestAgentRuntime, createTestModelSelection } from "./helpers/test-agent-runtime.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import type {
  DwfArtifactItem,
  DwfRunIntrospectionQueries,
  DwfRunLifeSpan,
  DwfRunSessionListItem,
} from "@zcode/adapters/storage";
import {
  CoreErrorType,
  ESCALATE_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS,
  LIST_WORKFLOW_RUNS_MAX_LIMIT,
  type CollaborationMode,
  type CreateSessionTaskLinkInput,
  type DynamicWorkflowRunDetail,
  type DynamicWorkflowRunListQuery,
  type DynamicWorkflowRunListResult,
  type DynamicWorkflowRunProgressPayload,
  type MessageWithParts,
  type ModelSelection,
  type SessionEventStorePort,
  type SessionId,
  type SessionStorePort,
  type ToolArtifactStorePort,
  type ToolArtifactWriteRequest,
  type WorkflowEscalatePort,
} from "@zcode/contracts";
import {
  AgentRuntime,
  PermissionService,
  builtInTools,
  createToolExecutor,
  createToolRegistry,
  defaultPermissionConfig,
} from "@zcode/core";
import {
  reduceWorkflowRunsState,
  WORKFLOW_RUN_EVENTS_PAGE_LIMITS,
  workflowRunsStateSchema,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunsState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  holeSiteId,
  InMemoryJournalStore,
  refToString,
  type JournalStorePort,
  type NodeRecord,
  type RunEvent,
  type RunRecord,
  type RunStatus,
  type RunStopReason,
} from "@zcode/dynamic-workflow";

import {
  createDynamicWorkflowRunService,
  resolveDynamicWorkflowJournalStore,
  type DynamicWorkflowActorRuntimeInput,
} from "../src/app/dynamic-workflow-run-service.js";
import {
  createWorkflowConcurrencyGovernor,
  type WorkflowConcurrencyPort,
} from "../src/app/workflow-concurrency-governor.js";
import { resolveWorkflowDefaultConcurrency } from "../src/app/workflow-default-concurrency.js";
import { replayRunProgress } from "../src/app/dynamic-workflow-run-replay.js";
import { workflowActorModelPolicy } from "../src/app/workflow-actor-model.js";
import { workflowActorToolPolicy } from "../src/app/workflow-actor-tools.js";
import {
  WORKFLOW_QUOTA_RESUME_MARGIN_MS,
  startWorkflowQuotaAutoResume,
} from "../src/app/dynamic-workflow-quota-resume.js";
import {
  fakeFileSystemPort,
  unsupportedExecutionPort,
  type PlannedResponse,
} from "./workflow-driver.helpers.js";
import type { ExecutionPort } from "@zcode/contracts";
import { mkdtempSync, readFileSync } from "node:fs";
/**
 * 独立的 run cwd：harness 把入口文件写到 `<cwd>/.zcode/workflow-runs/<runId>.mjs` 且保留，
 * 用 process.cwd() 会把存档留在包目录里，并让并行测试文件互相覆写同名入口文件。
 */
const TEST_CWD: string = mkdtempSync(join(tmpdir(), "dwf-bootstrap-test-cwd-"));

// 数真实的 ts.Program 建了几次，让「编译一次」成为可断言的事实。用 importOriginal 保持
// 编译本身是真的——其余用例依赖真实的 lowering 与 schema 合成。
const { compiledScripts } = vi.hoisted(() => ({ compiledScripts: [] as string[] }));

vi.mock("@zcode/dynamic-workflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zcode/dynamic-workflow")>();
  return {
    ...actual,
    createWorkflowProgram: (scriptText: string) => {
      compiledScripts.push(scriptText);
      return actual.createWorkflowProgram(scriptText);
    },
  };
});

/** 一个 typed ask 的最小脚本；actor ref 为 actor#1@1，ask 站点为 ask#1。 */
const TYPED_SCRIPT = [
  "interface Answer { text: string }",
  'const a = await agent("worker").ask<Answer>("do the thing");',
  "return a.text;",
].join("\n");

const BROKEN_SCRIPT = 'const x: number = "definitely not a number";';

/**
 * 发布一个用户面产物（docs/dynamic-workflow/authoring.md）。用 markdown 而不是 file：这条用例
 * 要证的是**接线**（service → launch → driver → store），而 markdown 不需要工作区里真有一个
 * 文件——文件那一侧的路径 / 上限 / 类型语义归 workflow-driver-artifacts.test.ts。
 */
const ARTIFACT_SCRIPT = ['artifact.markdown("summary", "# 结论");', 'return "done";'].join("\n");

function traceFor(name: string) {
  const sessionId = createSessionId(name);
  return createRootTraceContext({ sessionId, turnId: createTurnId(name) });
}

/**
 * 本文件的模型计划比 helpers 的多一种：`escalate` 发一次真的 `escalate` 工具调用。
 * 它让「actor 撞墙 → 提问 → 拿到答案 → 继续干活」整条线经**真实工具层**跑一遍，而不是由
 * 测试直接持端口扮演模型（那样漏掉注册门、allowlist 补回、工具结果回灌三段）。
 */
type ActorPlan =
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
interface ModelRequestLog {
  requests: { messages?: unknown; tools?: readonly { name: string }[] }[];
}

/** 脚本化 model adapter（同 workflow-driver.helpers 的模式，本文件按 actor 键取计划）。 */
function scriptedModelAdapter(
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

interface HarnessOptions {
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

interface Harness {
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
const HARNESS_PARENT_SESSION = createSessionId("harness-parent");
/**
 * harness 里「父会话当前模型」：与 createTestAgentRuntime 的缺省 selection 同一个值，于是
 * 「不覆盖」与「覆盖成父模型」在这里落到同一条记录——照生产（create-app.ts 把
 * `getRuntime().getSessionModelSelection()` 交给模型策略作 parentSelection）。
 */
const HARNESS_PARENT_MODEL = createTestModelSelection("test/default-runtime-model");

/**
 * 带孤儿收敛窄查询的 journal 替身。真正的 SQL 语义（按父会话预筛非终态行）在
 * `adapters/tests/dwf-journal-store.test.ts` 里对真库钉住；这里只要一个能被 run service
 * 的能力探测认出来的实现，好让「收敛什么、写什么失败」这层策略可以被单独断言。
 */
class SweepableJournalStore extends InMemoryJournalStore {
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
function preloadRun(
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

function makeHarness(options: HarnessOptions = {}): Harness {
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

/**
 * submit 并断言被接受，回 runId。submit 的结果是判别联合（amend-resume 的三道门可以拒绝一次
 * 提交，见 contracts 的 DynamicWorkflowRunSubmitResult），所以「提交成功」在每个用例里都得
 * 先成立；把这个断言收在一处，用例正文才不必逐个写 if (!result.ok)。
 * 拒绝路径由 amend 那组用例直接对 service.submit 断言。
 */
async function submitRun(
  harness: Harness,
  request: Parameters<Harness["service"]["submit"]>[0],
): Promise<string> {
  const result = await harness.service.submit(request);
  return result.runId;
}

/** amend 入口的成功路径（refusal 在专门的用例里断言）。 */
async function amendRun(
  harness: Harness,
  request: Parameters<NonNullable<Harness["service"]["amend"]>>[0],
): Promise<{ runId: string; supersededRunId?: string }> {
  const result = await harness.service.amend!(request);
  if (!result.ok) throw new Error(`amend refused unexpectedly: ${result.reason}`);
  return result;
}

/** 等某个 run 结算（waitForTask 是端口自己的等待面，顺带被这些用例覆盖）。 */
async function settle(harness: Harness, runId: string): Promise<void> {
  await harness.service.waitForTask(runId);
}

describe("dynamic workflow run service — 在飞计数与结算订阅（registry 安全边界的读面）", () => {
  it("submit 后 countLiveRuns 为 1；结算后归零，监听器恰好收到一次、计数已扣掉本 run", async () => {
    const harness = makeHarness();
    const notices: { runId: string; liveRunCount: number }[] = [];
    const unsubscribe = harness.service.subscribeRunSettled((notice) => {
      notices.push(notice);
    });

    expect(harness.service.countLiveRuns()).toBe(0);
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("live-count-parent"),
      scriptText: TYPED_SCRIPT,
      toolCallId: createToolCallId("live-count-call"),
      trace: traceFor("live-count"),
    });
    expect(harness.service.countLiveRuns()).toBe(1);
    expect(notices).toEqual([]);

    await settle(harness, runId);

    expect(harness.service.countLiveRuns()).toBe(0);
    expect(notices).toEqual([{ runId, liveRunCount: 0 }]);

    // 退订后再跑一个 run：不再通知，但计数照常。
    unsubscribe();
    const second = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("live-count-parent"),
      scriptText: TYPED_SCRIPT,
      toolCallId: createToolCallId("live-count-call-2"),
      trace: traceFor("live-count-2"),
    });
    await settle(harness, second);
    expect(notices).toHaveLength(1);
    expect(harness.service.countLiveRuns()).toBe(0);
  });

  it("监听器抛错只记日志，不影响结算与其他监听器", async () => {
    const harness = makeHarness();
    const seen: string[] = [];
    harness.service.subscribeRunSettled(() => {
      throw new Error("listener boom");
    });
    harness.service.subscribeRunSettled((notice) => {
      seen.push(notice.runId);
    });

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("listener-throw-parent"),
      scriptText: TYPED_SCRIPT,
      toolCallId: createToolCallId("listener-throw-call"),
      trace: traceFor("listener-throw"),
    });
    await settle(harness, runId);

    expect((await harness.service.getTask(runId))?.status).toBe("completed");
    expect(seen).toEqual([runId]);
    expect(
      harness.logs.some(
        (log) =>
          log.level === "warn" &&
          log.context?.event === "dynamic_workflow.run.settled_listener_failed",
      ),
    ).toBe(true);
  });
});

/**
 * 常驻登记（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Engine ownership」规则一）。
 *
 * Bug 根因（2026-09-15）：引擎活在会话 App 的闭包里、不进 runtime task registry，而常驻池只读
 * registry——一个仍在跑的 run 被读成 idle，App 被关闭（10 分钟空闲），resume 起了第二个引擎。
 * 登记必须落在**启动的同一同步片**，所以下面两条用例都在 await 入口 promise **之前**断言。
 */
describe("dynamic workflow run service — 常驻登记（Engine ownership 规则一）", () => {
  /** 记录登记过的 promise 与它们是否已结算；后者证明登记的不是注册表条目上的占位 promise。 */
  function recorder(): {
    register: (work: Promise<unknown>) => void;
    settled: boolean[];
    works: Promise<unknown>[];
  } {
    const works: Promise<unknown>[] = [];
    const settled: boolean[] = [];
    return {
      settled,
      works,
      register: (work: Promise<unknown>) => {
        const index = works.push(work) - 1;
        settled[index] = false;
        void work.then(() => {
          settled[index] = true;
        });
      },
    };
  }

  it("submit 在同一同步片登记恰好一次，登记的 promise 随 run 结算解除", async () => {
    const hook = recorder();
    const harness = makeHarness({ registerResidencyBlockingWork: hook.register });

    const submitted = harness.service.submit({
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("residency-submit"),
    });
    // submit 的 promise 尚未被 await，登记已经发生：落在这里的常驻再平衡看得见这个 run。
    expect(hook.works).toHaveLength(1);

    const runId = (await submitted).runId;
    // 登记的是真结算 promise，不是条目上那个同步可见的占位 Promise.resolve。
    expect(hook.settled[0]).toBe(false);
    expect(harness.service.countLiveRuns()).toBe(1);

    await settle(harness, runId);
    await hook.works[0];
    expect(hook.settled[0]).toBe(true);
    // 恰好一次：submit 只经 trackSettlement 这一个登记点。
    expect(hook.works).toHaveLength(1);
    expect(harness.journal.getRun(runId)?.status).toBe("completed");
  });

  it("resume 同样在同一同步片登记一次（登记的是新起的那条结算）", async () => {
    const hook = recorder();
    const journal = new SweepableJournalStore();
    const runId = "dwfrun-residency-resume";
    preloadRun(journal, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      runId,
      scriptText: TYPED_SCRIPT,
      status: "stopped",
      stopReason: "user",
    });
    const harness = makeHarness({
      journal,
      registerResidencyBlockingWork: hook.register,
    });

    const resumed = harness.service.resume!(runId);
    expect(hook.works).toHaveLength(1);

    expect(await resumed).toMatchObject({ ok: true, runId });
    expect(hook.settled[0]).toBe(false);

    await settle(harness, runId);
    await hook.works[0];
    expect(hook.settled[0]).toBe(true);
    expect(hook.works).toHaveLength(1);
    expect(harness.journal.getRun(runId)?.status).toBe("completed");
  });
});

describe("dynamic workflow run service — submit", () => {
  it("返回 runId 并把 run 跑到 completed", async () => {
    const harness = makeHarness();

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("submit-parent"),
      scriptText: TYPED_SCRIPT,
      toolCallId: createToolCallId("submit-call"),
      trace: traceFor("submit-ok"),
    });

    expect(runId).toBeTruthy();
    await settle(harness, runId);

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    // 脚本的顶层返回值就是 run 的产物（Answer.text）。
    expect(snapshot?.output).toBe("done");
  });

  // GUI「配置」读快照取 run 名字（launch.md「The settings turn」）；快照曾不带 name，设置轮与通知退成 run id。
  it("快照带 run 的名字；没起名的 run 不带", async () => {
    const harness = makeHarness();

    const named = await submitRun(harness, {
      cwd: TEST_CWD,
      name: "triage",
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-named"),
    });
    const unnamed = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-unnamed"),
    });
    await settle(harness, named);
    await settle(harness, unnamed);

    expect((await harness.service.getTask(named))?.name).toBe("triage");
    expect("name" in (await harness.service.getTask(unnamed))!).toBe(false);
  });

  it("快照说明引擎在不在本进程：别的进程的在飞 run 为假，终态的 run 不带", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-live-here"),
    });
    await settle(harness, runId);
    expect("liveInThisProcess" in (await harness.service.getTask(runId))!).toBe(false);

    preloadRun(harness.journal, {
      runId: "dwfrun-other-process",
      cwd: TEST_CWD,
      status: "running",
      parentSessionId: "sess_other",
    });
    expect((await harness.service.getTask("dwfrun-other-process"))?.liveInThisProcess).toBe(false);
  });

  it("runId 字符集安全：无 # @ /", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-charset"),
    });
    await settle(harness, runId);

    expect(runId).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  // 「编译一次」：一个 ts.Program 喂站点表 / schema 合成 / lowering。三个便捷入口各建自己的
  // program，串起来会 typecheck 三遍——这条断言就是防止有人把链换回便捷入口。
  it("一次 submit 只建一个 ts.Program", async () => {
    const harness = makeHarness();
    compiledScripts.length = 0;

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-compile-once"),
    });
    await settle(harness, runId);

    expect(compiledScripts.filter((script) => script === TYPED_SCRIPT)).toHaveLength(1);
  });

  // 引擎独占 createRun：submit 路径绝不预插 dwf_run 行，否则引擎构造翻进 resume 分支，
  // 静默从一份空 journal「恢复」。
  it("submit 不预插 dwf_run 行，run 由引擎创建", async () => {
    const journal = new InMemoryJournalStore();
    const createRun = vi.spyOn(journal, "createRun");
    const getRun = vi.spyOn(journal, "getRun");
    const harness = makeHarness({ journal });

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-create-run"),
    });
    await settle(harness, runId);

    // createRun 恰好一次，且发生在引擎构造里——它之前那次 getRun 必须返回 undefined
    // （那正是引擎判断「新 run 而非 resume」的依据）。
    expect(createRun).toHaveBeenCalledTimes(1);
    const firstGetRunResult = getRun.mock.results[0];
    expect(firstGetRunResult?.value).toBeUndefined();
  });

  // run 元数据落库：没有这四个字段，resume 的 script_hash 校验没有比对对象。
  it("scriptText / scriptHash / parentSessionId / cwd 落库", async () => {
    const harness = makeHarness();
    const parentSessionId = createSessionId("meta-parent");

    const runId = await submitRun(harness, {
      cwd: "/tmp/dwf-meta",
      parentSessionId,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-meta"),
    });
    await settle(harness, runId);

    const record = harness.journal.getRun(runId);
    expect(record?.scriptText).toBe(TYPED_SCRIPT);
    expect(record?.parentSessionId).toBe(parentSessionId);
    expect(record?.cwd).toBe("/tmp/dwf-meta");
    // scriptHash 由调用方（本服务）算：sha256 hex over 作者原文，不是 lowered 函数体。
    const { createHash } = await import("node:crypto");
    expect(record?.scriptHash).toBe(
      createHash("sha256").update(TYPED_SCRIPT, "utf8").digest("hex"),
    );
  });

  // 防御性：脏脚本不该走到 submit（handler 只在 ok 时调），走到了就硬失败且不建 run。
  it("脏脚本硬失败且不建 run", async () => {
    const journal = new InMemoryJournalStore();
    const createRun = vi.spyOn(journal, "createRun");
    const harness = makeHarness({ journal });

    await expect(
      harness.service.submit({
        cwd: TEST_CWD,
        scriptText: BROKEN_SCRIPT,
        trace: traceFor("submit-broken"),
      }),
    ).rejects.toThrow(/does not typecheck/);

    // 一行 dwf_run 都没建：脏脚本在编译阶段就被挡下，引擎从未被构造。
    expect(createRun).not.toHaveBeenCalled();
    // actor 会话也从未开始。
    expect(harness.actorRuntimeInputs).toEqual([]);
  });

  it("caps 只剩并发上界；双核机器的默认并发地板为 4", async () => {
    const harness = makeHarness({ availableParallelism: () => 2 });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-caps"),
    });
    await settle(harness, runId);

    const record = harness.journal.getRun(runId);
    expect(record?.caps).toEqual({ maxConcurrency: 4 });
  });

  it("默认并发的硬顶为 16", async () => {
    const harness = makeHarness({ availableParallelism: () => 64 });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-caps-ceiling"),
    });
    await settle(harness, runId);

    expect(harness.journal.getRun(runId)?.caps.maxConcurrency).toBe(16);
  });
});

// ── 请求的并发上界（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）─────────────
// `max_concurrency` 高于低于默认并发都照用、没有上限：缺席即默认并发。这一组把
// 「请求 → 取整 → 落 dwf_run.caps_max_concurrency → 两条读面 → run-started 载荷」整条路钉住。
describe("dynamic workflow run service — 请求的并发上界", () => {
  /** 10 核 → 默认并发 8：既高于地板 4、又低于硬顶 16。 */
  const TEN_CORES = () => 10;
  const DEFAULT_OF_TEN_CORES = 8;

  async function submitWithLimit(
    harness: Harness,
    name: string,
    maxConcurrency?: number,
  ): Promise<string> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
      trace: traceFor(name),
    });
    await settle(harness, runId);
    return runId;
  }

  it("请求低于默认并发 → 原样落 dwf_run.caps_max_concurrency", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    const runId = await submitWithLimit(harness, "limit-3", 3);
    expect(harness.journal.getRun(runId)?.caps).toEqual({ maxConcurrency: 3 });
  });

  it("请求高于默认并发 → 原样照用（没有上限：默认是起点不是天花板）", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    const runId = await submitWithLimit(harness, "limit-99", 99);
    expect(harness.journal.getRun(runId)?.caps.maxConcurrency).toBe(99);
  });

  it("缺席 → 默认并发", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    const runId = await submitWithLimit(harness, "limit-absent");
    expect(harness.journal.getRun(runId)?.caps.maxConcurrency).toBe(DEFAULT_OF_TEN_CORES);
  });

  it("0 / 负数 → 地板 1；非整数向下取整（绝不偷偷越过用户说的数）", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    const zero = await submitWithLimit(harness, "limit-zero", 0);
    expect(harness.journal.getRun(zero)?.caps.maxConcurrency).toBe(1);
    const negative = await submitWithLimit(harness, "limit-negative", -5);
    expect(harness.journal.getRun(negative)?.caps.maxConcurrency).toBe(1);
    const fractional = await submitWithLimit(harness, "limit-fractional", 3.7);
    expect(harness.journal.getRun(fractional)?.caps.maxConcurrency).toBe(3);
  });

  it("amend 把上界带到后继 run（前驱的值不被继承——三态归一在工具层）", async () => {
    // 挂住 actor：前驱没有已完结的 ask，于是预检不需要消息边界（无转录存储的装配里本就没有
    // 边界记账，与既有 amend 用例同款）。
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const predecessor = await submitRun(harness, {
      cwd: TEST_CWD,
      maxConcurrency: 2,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-limit-a"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getRun(predecessor)?.caps.maxConcurrency).toBe(2);
    });

    const amended = await amendRun(harness, {
      cwd: TEST_CWD,
      maxConcurrency: 5,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-limit-b"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getRun(amended.runId)?.caps.maxConcurrency).toBe(5);
    });
    expect(await harness.service.cancel(amended.runId)).toBe(true);
    await settle(harness, amended.runId);

    // 同一个前驱、这次不带字段：后继跑在默认并发上（缺席 ≠ 沿用前驱的 2）。
    const inherited = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-limit-c"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getRun(inherited.runId)?.caps.maxConcurrency).toBe(
        DEFAULT_OF_TEN_CORES,
      );
    });
    expect(await harness.service.cancel(inherited.runId)).toBe(true);
    await settle(harness, inherited.runId);
  });

  it("defaultConcurrency() 与默认并发的唯一实现同值（必须与缺省落库的那个数对得上）", () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    expect(harness.service.defaultConcurrency!()).toBe(
      resolveWorkflowDefaultConcurrency(TEN_CORES),
    );
    expect(harness.service.defaultConcurrency!()).toBe(DEFAULT_OF_TEN_CORES);
  });

  it("快照只在不等于默认并发时带 maxConcurrency（高于、低于都带）", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    const limited = await submitWithLimit(harness, "snapshot-limited", 2);
    expect(await harness.service.getTask(limited)).toMatchObject({ maxConcurrency: 2 });
    const raised = await submitWithLimit(harness, "snapshot-raised", 20);
    expect(await harness.service.getTask(raised)).toMatchObject({ maxConcurrency: 20 });

    // 跑在默认值上的 run 没有可说的：字段整个缺席，而不是报一个等于默认值的数。
    const unlimited = await submitWithLimit(harness, "snapshot-unlimited");
    const snapshot = await harness.service.getTask(unlimited);
    expect("maxConcurrency" in snapshot!).toBe(false);
    const explicitDefault = await submitWithLimit(
      harness,
      "snapshot-default",
      DEFAULT_OF_TEN_CORES,
    );
    expect("maxConcurrency" in (await harness.service.getTask(explicitDefault))!).toBe(false);
  });

  // 间隙（submit 已返回、dwf_run 行还没落）是 AmendWorkflow 的 resolveInput 最可能读到快照的
  // 时刻——修订一个刚起步的 run。注册表副本必须与行给出同一个答案。
  it("间隙里的快照与详情读注册表副本，答案与落行后一致", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({
        availableParallelism: TEN_CORES,
        hangActors: true,
        journal,
      });

      const runId = await submitRun(harness, {
        cwd: projectCwd,
        maxConcurrency: 2,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("limit-gap"),
      });
      hidden.add(runId);

      expect(await harness.service.getTask(runId)).toMatchObject({ maxConcurrency: 2 });
      expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
        maxConcurrency: 2,
      });

      hidden.delete(runId);
      await vi.waitFor(async () => {
        expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
          maxConcurrency: 2,
        });
      });

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("getRunDetail 带 maxConcurrency，列表行不带（很少设置的字段不该把每一行加宽）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ availableParallelism: TEN_CORES, journal });
      const limited = await submitRun(harness, {
        cwd: projectCwd,
        maxConcurrency: 2,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("detail-limited"),
      });
      await settle(harness, limited);
      const unlimited = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("detail-unlimited"),
      });
      await settle(harness, unlimited);

      const introspection = introspectionOf(harness);
      expect(await introspection.getRunDetail(limited)).toMatchObject({ maxConcurrency: 2 });
      const plain = await introspection.getRunDetail(unlimited);
      expect("maxConcurrency" in plain!).toBe(false);

      const { runs } = await introspection.listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs).toHaveLength(2);
      for (const row of runs) expect("maxConcurrency" in row).toBe(false);
    });
  });

  // 跨切片的线契约：`run-started` 载荷上的 `concurrencyCeiling` 是共享 reducer 判断
  // 「这个 run 有没有自己的上界」的另一半（另一半是引擎自己的 caps.maxConcurrency）。
  it("run-started 载荷带 concurrencyCeiling，与引擎的 caps 并列", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES });
    const runId = await submitWithLimit(harness, "payload-ceiling", 2);

    const started = harness.runEvents.find(
      (event) => event.runId === runId && event.eventType === "run-started",
    );
    expect(started?.payload).toMatchObject({
      caps: { maxConcurrency: 2 },
      concurrencyCeiling: DEFAULT_OF_TEN_CORES,
    });
  });
});

// ── 就地改一个在飞 run 的上界（docs/dynamic-workflow/concurrency.md「Retuning a live run」）──
// 一次只改 `max_concurrency` 的修订不铸后继：同一个 runId、不 supersede、在飞 ask 一个不丢。
// 这一组钉住端口这一侧的全部可观察后果——行、注册表副本、事件（含宿主派生的默认并发）、两种拒绝、
// 钳制，以及「resume 从新上界起跑」。引擎内部那半边（caps 现读、pumpAll、no-op）由
// dynamic-workflow 的 engine-retune-concurrency 测试负责。
describe("dynamic workflow run service — retuneConcurrency", () => {
  const TEN_CORES = () => 10;
  const DEFAULT_OF_TEN_CORES = 8;

  /** 起一个挂住的 run（actor 永不返回 ⇒ run 一直在飞），并等引擎把 dwf_run 行落下来。 */
  async function liveRun(harness: Harness, name: string, maxConcurrency?: number): Promise<string> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
      trace: traceFor(name),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getRun(runId)?.caps).toBeDefined();
    });
    return runId;
  }

  function retune(harness: Harness, runId: string, maxConcurrency: number | null) {
    return harness.service.retuneConcurrency!({ maxConcurrency, runId });
  }

  async function stop(harness: Harness, runId: string): Promise<void> {
    await harness.service.cancel(runId);
    await settle(harness, runId);
  }

  it("在飞 run：行、注册表副本与事件三处同时挪动，同一个 runId、没有后继", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const runId = await liveRun(harness, "retune-ok", 4);

    expect(await retune(harness, runId, 2)).toEqual({
      ok: true,
      maxConcurrency: 2,
      previous: 4,
      defaultConcurrency: DEFAULT_OF_TEN_CORES,
    });
    // resume 沿用行里的 caps，所以不落库就等于什么都没改。
    expect(harness.journal.getRun(runId)?.caps).toEqual({ maxConcurrency: 2 });
    // 注册表副本：快照优先读它，不挪就会在 retune 之后继续报提交时那个数，而
    // `AmendWorkflow` 的 resolveInput 正是读这张快照判「沿用什么」。
    expect(await harness.service.getTask(runId)).toMatchObject({ maxConcurrency: 2 });

    const changed = harness.runEvents.filter(
      (event) => event.runId === runId && event.eventType === "run-caps-changed",
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]?.payload).toMatchObject({
      runId,
      caps: { maxConcurrency: 2 },
      previous: { maxConcurrency: 4 },
      // 宿主派生字段：读侧据它判断新上界该写下还是该清掉，与 `run-started` 同一条缝。
      concurrencyCeiling: DEFAULT_OF_TEN_CORES,
    });
    await stop(harness, runId);
  });

  it("同一个值 ⇒ unchanged，点名此刻生效的上界；什么都不写、什么都不发", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const runId = await liveRun(harness, "retune-unchanged", 3);

    expect(await retune(harness, runId, 3)).toEqual({ ok: false, reason: "unchanged", current: 3 });
    expect(harness.journal.getRun(runId)?.caps).toEqual({ maxConcurrency: 3 });
    expect(
      harness.runEvents.filter((event) => event.eventType === "run-caps-changed"),
    ).toHaveLength(0);
    await stop(harness, runId);
  });

  it("高于默认并发照用、没有上限；等于默认时读面把字段整个撤掉", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const runId = await liveRun(harness, "retune-clamp", 2);

    expect(await retune(harness, runId, 99)).toEqual({
      ok: true,
      maxConcurrency: 99,
      previous: 2,
      defaultConcurrency: DEFAULT_OF_TEN_CORES,
    });
    expect(await harness.service.getTask(runId)).toMatchObject({ maxConcurrency: 99 });
    expect(await retune(harness, runId, DEFAULT_OF_TEN_CORES)).toMatchObject({ ok: true });
    const snapshot = await harness.service.getTask(runId);
    expect("maxConcurrency" in snapshot!).toBe(false);
    // 地板同规：0 与负数都落到 1。
    expect(await retune(harness, runId, 0)).toMatchObject({ ok: true, maxConcurrency: 1 });
    await stop(harness, runId);
  });

  it("null = 默认并发 = 解除本 run 自己的界", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const runId = await liveRun(harness, "retune-null", 2);

    expect(await retune(harness, runId, null)).toEqual({
      ok: true,
      maxConcurrency: DEFAULT_OF_TEN_CORES,
      previous: 2,
      defaultConcurrency: DEFAULT_OF_TEN_CORES,
    });
    expect(harness.journal.getRun(runId)?.caps.maxConcurrency).toBe(DEFAULT_OF_TEN_CORES);
    // 已经在默认值上，再要一次「解除」就是同一个值。
    expect(await retune(harness, runId, null)).toMatchObject({ ok: false, reason: "unchanged" });
    await stop(harness, runId);
  });

  // 治理器那一侧（docs/dynamic-workflow/concurrency.md「The governor」「The control path」）：
  // launch 把本 run 的上界登记给治理器（抬它用过的 key 的增长上限），retune 经控制面覆盖，
  // launch 结算时清掉——三处与调度器、座位闸门同一刻换值。
  it("launch 登记上界、retune 覆盖、结算清掉：治理器上的增长上限跟着 run 走", async () => {
    const governor = createWorkflowConcurrencyGovernor({
      defaultConcurrency: DEFAULT_OF_TEN_CORES,
    });
    const calls: string[] = [];
    const concurrency: WorkflowConcurrencyPort = {
      tryAdmit: (runId, key) => governor.tryAdmit(runId, key),
      admit: (runId, key, signal) => governor.admit(runId, key, signal),
      subscribe: (runId, listener) => governor.subscribe(runId, listener),
      setRunBound: (runId, bound) => {
        calls.push(`set:${runId}:${bound}`);
        governor.setRunBound(runId, bound);
      },
      clearRunBound: (runId) => {
        calls.push(`clear:${runId}`);
        governor.clearRunBound(runId);
      },
    };
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true, concurrency });
    const runId = await liveRun(harness, "retune-governor", 30);
    await vi.waitFor(() => {
      expect(calls).toContain(`set:${runId}:30`);
    });
    expect(await retune(harness, runId, 40)).toMatchObject({ ok: true, maxConcurrency: 40 });
    expect(calls).toContain(`set:${runId}:40`);
    await stop(harness, runId);
    await vi.waitFor(() => {
      expect(calls.at(-1)).toBe(`clear:${runId}`);
    });
  });

  it("结算之后与未知 run 都是 not_live（调用方回落到一次真正的修订）", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const runId = await liveRun(harness, "retune-settled", 4);
    await stop(harness, runId);

    expect(await retune(harness, runId, 2)).toEqual({ ok: false, reason: "not_live" });
    expect(await retune(harness, "dwfrun-nobody", 2)).toEqual({ ok: false, reason: "not_live" });
    // 拒绝即零副作用：行还是停止那一刻的那一份。
    expect(harness.journal.getRun(runId)?.caps).toEqual({ maxConcurrency: 4 });
  });

  it("resume 从 retune 之后的上界起跑（行是 caps 的权威，条目抄的也是它）", async () => {
    const harness = makeHarness({ availableParallelism: TEN_CORES, hangActors: true });
    const runId = await liveRun(harness, "retune-resume", 4);
    expect(await retune(harness, runId, 2)).toMatchObject({ ok: true, maxConcurrency: 2 });
    await stop(harness, runId);

    const resumed = await harness.service.resume!(runId);
    expect(resumed).toMatchObject({ ok: true, runId });
    await vi.waitFor(() => {
      expect(harness.journal.getRun(runId)?.caps).toEqual({ maxConcurrency: 2 });
    });
    // 新一世的注册表条目抄的是行里那个数，所以 `previous` 说的是 retune 之后的上界。
    expect(await harness.service.getTask(runId)).toMatchObject({ maxConcurrency: 2 });
    expect(await retune(harness, runId, 5)).toMatchObject({ ok: true, previous: 2 });
    await stop(harness, runId);
  });

  // 同一条契约的**端到端**那一半：live 侧是 launch 的 emit 钩子铸的（toProgressPayload 的
  // `run-caps-changed` 分支），冷侧是 replayRunProgress 铸的。两者必须逐字节相等——live 路只给
  // `run-started` 拼默认并发、冷路给每条事件都拼，这个差别正是这条用例要挡住的。
  it("live 与冷回放为同一条 run-caps-changed 铸出逐字节相同的载荷", async () => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({
      availableParallelism: TEN_CORES,
      hangActors: true,
      journal,
    });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      maxConcurrency: 4,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("retune-live-vs-cold"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getRun(runId)?.caps).toBeDefined();
    });
    expect(await retune(harness, runId, 2)).toMatchObject({ ok: true });
    await stop(harness, runId);

    const live = harness.runEvents.find(
      (event) => event.runId === runId && event.eventType === "run-caps-changed",
    );
    // 冷侧：同一份 journal、新的 service（本进程没有这个 run 的条目，所以它会被回放）。
    const cold = makeHarness({ availableParallelism: TEN_CORES, journal });
    const replayed = await cold.service.replayProgressForSession!({ excludeRunIds: new Set() });
    const coldEvent = replayed.find(
      (event) => event.runId === runId && event.eventType === "run-caps-changed",
    );

    expect(live).toBeDefined();
    expect(coldEvent).toEqual(live);
  });

  // 冷回放的契约：同一条铸造链、同一个默认并发，所以 `run-caps-changed` 在重启前后逐字节相等。
  it("冷回放给 run-caps-changed 铸上同一个 concurrencyCeiling", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      runId: "dwfrun-retuned",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      status: "stopped",
      stopReason: "user",
      caps: { maxConcurrency: 2 },
    });
    journal.appendEvent("dwfrun-retuned", {
      type: "run-started",
      caps: { maxConcurrency: 4 },
    } as never);
    journal.appendEvent("dwfrun-retuned", {
      type: "run-caps-changed",
      runId: "dwfrun-retuned",
      caps: { maxConcurrency: 2 },
      previous: { maxConcurrency: 4 },
    } as never);

    const harness = makeHarness({ availableParallelism: TEN_CORES, journal });
    const replayed = await harness.service.replayProgressForSession!({ excludeRunIds: new Set() });
    const changed = replayed.find((event) => event.eventType === "run-caps-changed");
    expect(changed?.payload).toEqual({
      runId: "dwfrun-retuned",
      caps: { maxConcurrency: 2 },
      previous: { maxConcurrency: 4 },
      concurrencyCeiling: DEFAULT_OF_TEN_CORES,
    });
  });
});

// ── 端到端：真 AmendWorkflow 工具 → 真 run service → 真引擎 → journal / 事件 ─────────────
// docs/dynamic-workflow/launch.md「Changing only the parallelism of a live run」。上面那一组
// 直接对 service 断言，core 那一侧的用例又把端口换成了 stub——两条缝之间没有任何东西证明它们
// 真的对得上。这一组把工具执行器、resolveInput 的路由、handler、端口、引擎与 journal 串成一条。
//
// **哪些是真的**：工具注册表与执行器、AmendWorkflow 的 resolveInput / 权限步 / handler、
// `createDynamicWorkflowRunService`、引擎与调度器、driver、journal 行与事件流、进度载荷。
// **哪些是替身**：actor 的模型适配器（`hangActors`：generateText 永不 resolve，于是三个 ask
// 稳定停在在飞状态），以及并发探测（固定 10 核 → 默认并发 8）。
//
// **这里不证停驻**：让子代理真的发出「下一个 turn step」需要一个可外部拨动的假模型，本 harness
// 的脚本化 adapter 给不了那个控制点。座位闸门那一半由 workflow-driver-seat-gate.test.ts 用真
// 治理器 + 真 driver 证（压低 4→1 停驻、FIFO 放行、工具侧不停驻、取消不腾座位）；本组证的是
// 「工具的一次调用真的把上界改到了引擎与 journal 上，而且一个在飞 ask 都没动」。
describe("dynamic workflow run service — AmendWorkflow 就地 retune（端到端）", () => {
  const TEN_CORES = () => 10;
  const DEFAULT_OF_TEN_CORES = 8;

  /** 三个子代理同时在飞：压低上界要有「超出的那些」才说得上话。 */
  const THREE_PARALLEL_SCRIPT = [
    "interface Answer { text: string }",
    'const one = agent("one");',
    'const two = agent("two");',
    'const three = agent("three");',
    "const [a, b, c] = await Promise.all([",
    '  one.ask<Answer>("first"),',
    '  two.ask<Answer>("second"),',
    '  three.ask<Answer>("third"),',
    "]);",
    "return `${a.text}|${b.text}|${c.text}`;",
  ].join("\n");

  interface AmendOutcome {
    success: boolean;
    message: string;
    output: { response: string; diagnostics?: unknown[]; retuned?: Record<string, unknown> };
  }

  it("只带 max_concurrency 的一次调用：同一个 run 被就地改低，在飞 ask 一个不停", async () => {
    const journal = new SweepableJournalStore();
    const sessionId = createSessionId("retune-e2e");
    const harness = makeHarness({
      availableParallelism: TEN_CORES,
      hangActors: true,
      journal,
      parentSessionId: sessionId,
    });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: sessionId,
      scriptText: THREE_PARALLEL_SCRIPT,
      trace: traceFor("retune-e2e"),
    });
    // 三个 ask 都已派发并卡在模型请求里；run 起于默认并发（提交时没给 max_concurrency）。
    await vi.waitFor(() => {
      expect(
        journal
          .listNodes(runId, { kinds: "all", withResult: true })
          .filter((node) => node.status === "running"),
      ).toHaveLength(3);
    });
    expect(journal.getRun(runId)?.caps.maxConcurrency).toBe(DEFAULT_OF_TEN_CORES);
    const runsBefore = journal.listRunsByParentSession(sessionId, 50).length;

    // ——— 真工具执行器 ———
    const registry = createToolRegistry();
    const amendEntry = builtInTools.find((entry) => entry.metadata.name === "AmendWorkflow");
    expect(amendEntry).toBeDefined();
    registry.register(amendEntry!);
    const turnId = createTurnId("retune-e2e");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const permissionAsks: unknown[] = [];
    const executor = createToolExecutor({
      emitEvent: async () => {},
      dynamicWorkflowRunPort: harness.service,
      mode: "build",
      permissionBroker: {
        async requestPermission(request) {
          permissionAsks.push(request);
          return { decision: "allow" as const };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
      workingDirectory: TEST_CWD,
    });
    const amend = async (maxConcurrency: number | null): Promise<AmendOutcome> => {
      const result = await executor.execute(
        {
          id: createToolCallId(`retune-e2e-${String(maxConcurrency)}`),
          input: { max_concurrency: maxConcurrency, run_id: runId },
          name: "AmendWorkflow",
        },
        { traceContext },
      );
      return {
        success: result.success,
        message: String(result.error?.message ?? ""),
        output: result.output as AmendOutcome["output"],
      };
    };

    // ——— 1. 压低到 1 ———
    const lowered = await amend(1);
    expect(lowered.success).toBe(true);
    expect(lowered.output.response).toBe(
      `Applied to the running run ${runId}; at most 1 subagent runs at once. ` +
        `Run ${runId} keeps running under it: nothing was stopped and no new run was started.`,
    );
    expect(lowered.output.retuned).toEqual({
      runId,
      maxConcurrency: 1,
      previous: DEFAULT_OF_TEN_CORES,
      defaultConcurrency: DEFAULT_OF_TEN_CORES,
    });
    // 不是一次修订：没有后台任务、没有编译产物、没有诊断。
    expect(lowered.output).not.toHaveProperty("backgroundTaskId");
    expect(lowered.output).not.toHaveProperty("status");
    expect(lowered.output).not.toHaveProperty("causalityGraph");
    expect(lowered.output.diagnostics).toEqual([]);
    // 本会话自己的在飞 run：不该弹确认窗（docs/dynamic-workflow/launch.md 的归属规则）。
    expect(permissionAsks).toEqual([]);

    // 同一个 run、没有后继、没有人被 supersede。
    expect(journal.listRunsByParentSession(sessionId, 50)).toHaveLength(runsBefore);
    const row = journal.getRun(runId);
    expect(row?.status).toBe("running");
    expect(row?.supersededBy).toBeUndefined();
    expect(row?.caps.maxConcurrency).toBe(1);
    expect(harness.runEvents.filter((event) => event.eventType === "run-settled")).toEqual([]);

    // 恰好一条 run-caps-changed，带着宿主拼上的默认并发。
    const changed = harness.runEvents.filter(
      (event) => event.runId === runId && event.eventType === "run-caps-changed",
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]?.payload).toEqual({
      runId,
      caps: { maxConcurrency: 1 },
      previous: { maxConcurrency: DEFAULT_OF_TEN_CORES },
      concurrencyCeiling: DEFAULT_OF_TEN_CORES,
    });

    // 快照立刻报新值（`AmendWorkflow` 的 resolveInput 判「沿用什么」读的就是它）。详情面与
    // `GetWorkflowRun` 读的是同一个 `runConcurrencyField`，取数来自下面断言的那一行 caps；
    // 那条读面需要带内省查询的 journal，由本文件「getRunDetail 带 maxConcurrency」一组覆盖。
    expect(await harness.service.getTask(runId)).toMatchObject({ maxConcurrency: 1 });

    // 在飞的三个 ask 一个都没被停：行还是 running，一条 node-settled 都没有。
    expect(
      journal
        .listNodes(runId, { kinds: "all", withResult: true })
        .filter((node) => node.status === "running"),
    ).toHaveLength(3);
    expect(
      harness.runEvents.filter(
        (event) => event.runId === runId && event.eventType === "node-settled",
      ),
    ).toEqual([]);

    // ——— 2. 同一个值再来一次 ———
    const again = await amend(1);
    expect(again.success).toBe(false);
    expect(again.message.startsWith("workflow_retune_unchanged:")).toBe(true);
    expect(again.message).toContain(runId);
    // 拒绝即零副作用：行没动，也没有第二条事件。
    expect(journal.getRun(runId)?.caps.maxConcurrency).toBe(1);
    expect(
      harness.runEvents.filter(
        (event) => event.runId === runId && event.eventType === "run-caps-changed",
      ),
    ).toHaveLength(1);

    // ——— 3. null 回到默认并发 ———
    const raised = await amend(null);
    expect(raised.success).toBe(true);
    expect(raised.output.response).toBe(
      `Applied to the running run ${runId}; at most ${DEFAULT_OF_TEN_CORES} subagents run at once ` +
        `(the default). ` +
        `Run ${runId} keeps running under it: nothing was stopped and no new run was started.`,
    );
    expect(journal.getRun(runId)?.caps.maxConcurrency).toBe(DEFAULT_OF_TEN_CORES);
    // 回到默认并发 ⇒ 读面把字段整个撤掉（「无则缺席」）。
    const snapshot = await harness.service.getTask(runId);
    expect("maxConcurrency" in snapshot!).toBe(false);
    expect(
      harness.runEvents.filter(
        (event) => event.runId === runId && event.eventType === "run-caps-changed",
      ),
    ).toHaveLength(2);

    // 三次调用之后 run 仍然健康、仍归本 service 所有：照常停得下来，落成可恢复的 stopped(user)。
    expect(
      journal
        .listNodes(runId, { kinds: "all", withResult: true })
        .filter((node) => node.status === "running"),
    ).toHaveLength(3);
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
    expect(journal.getRun(runId)).toMatchObject({ status: "stopped", stopReason: "user" });
    expect(journal.listRunsByParentSession(sessionId, 50)).toHaveLength(runsBefore);
  });
});

// ── 本 run 的子代理模型（docs/dynamic-workflow/launch.md）─────────────────────────────
// `subagent_model` 只描述**子代理**跑在哪个模型上，主代理照旧在会话模型上。这一组把
// 「请求 → 归一成规范串 → 记进 journal 事件 run-launched → 两条读面 → run-started 载荷 →
// actor runtime 工厂」整条路钉住。缺席即子代理跑在会话模型上，且每一处的键都真的不出现。
//
// 落点是**事件而不是列**（用户裁决不做迁移）：与发起锚点、阶段表同住 `run-launched`，
// 只在建 run 那一世写一次，宿主从事件头读回。
describe("dynamic workflow run service — 本 run 的子代理模型", () => {
  /** 带档位的选择：`$level` 是选择的一部分，规范串里必须带着它走完全程。 */
  const FLASH: ModelSelection = {
    providerId: "zhipu",
    modelId: "glm-5.3-flash",
    options: { reasoningLevel: "high" },
  };
  const FLASH_CANONICAL = "zhipu/glm-5.3-flash$high";
  /** 不带档位的选择：规范串因此只有两段。 */
  const HAIKU: ModelSelection = { providerId: "anthropic", modelId: "haiku" };

  /** 本 run 的 `run-launched` 事件：子代理模型就住在这里（dwf_run 上没有这一列）。 */
  const launchedOf = (harness: Harness, runId: string): RunEvent | undefined =>
    harness.journal
      .listEvents(runId, { types: "all", reportItems: "all" })
      .map((stored) => stored.event)
      .find((event) => event.type === "run-launched");

  const subagentModelOf = (harness: Harness, runId: string): string | undefined => {
    const launched = launchedOf(harness, runId);
    return launched?.type === "run-launched" ? launched.subagentModel : undefined;
  };

  it("submit 把规范 picker 串记进 run-launched（含 reasoning 档位），行上没有这条事实", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      subagentModel: FLASH,
      trace: traceFor("subagent-model-submit"),
    });
    await settle(harness, runId);

    expect(subagentModelOf(harness, runId)).toBe(FLASH_CANONICAL);
    // 零 SQL：记录行上没有这条事实，读侧一律走事件（用户裁决不做迁移）。
    expect("subagentModel" in harness.journal.getRun(runId)!).toBe(false);
  });

  it("没有档位的选择记成两段；不设即整个键缺席（不是 undefined）", async () => {
    const harness = makeHarness();
    const levelled = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      subagentModel: HAIKU,
      trace: traceFor("subagent-model-two-part"),
    });
    await settle(harness, levelled);
    expect(subagentModelOf(harness, levelled)).toBe("anthropic/haiku");

    const plain = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("subagent-model-absent"),
    });
    await settle(harness, plain);
    // 键缺席而不是 `undefined`：读侧据「在不在场」判断这个 run 有没有设过子代理模型。
    expect("subagentModel" in launchedOf(harness, plain)!).toBe(false);
  });

  it("快照与详情给出同一个规范串；不设时两条读面都不带这个键", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const chosen = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        subagentModel: FLASH,
        trace: traceFor("subagent-model-read-set"),
      });
      await settle(harness, chosen);
      const plain = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("subagent-model-read-absent"),
      });
      await settle(harness, plain);

      const introspection = introspectionOf(harness);
      expect(await harness.service.getTask(chosen)).toMatchObject({
        subagentModel: FLASH_CANONICAL,
      });
      expect(await introspection.getRunDetail(chosen)).toMatchObject({
        subagentModel: FLASH_CANONICAL,
      });

      const snapshot = await harness.service.getTask(plain);
      expect("subagentModel" in snapshot!).toBe(false);
      const detail = await introspection.getRunDetail(plain);
      expect("subagentModel" in detail!).toBe(false);

      // 列表行不带：与并发上界同规——很少设置的字段不该把枚举面的每一行都加宽。
      const { runs } = await introspection.listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs).toHaveLength(2);
      for (const row of runs) expect("subagentModel" in row).toBe(false);

      // 重启（新服务、空注册表、同一个 journal）：内存副本没有了，两条读面只能从
      // `run-launched` 事件读回——这条断言就是「零 SQL 也能冷读」的证据。
      const cold = makeHarness({ journal });
      const coldIntrospection = introspectionOf(cold);
      expect(await cold.service.getTask(chosen)).toMatchObject({
        subagentModel: FLASH_CANONICAL,
      });
      expect(await coldIntrospection.getRunDetail(chosen)).toMatchObject({
        subagentModel: FLASH_CANONICAL,
      });
      expect("subagentModel" in (await cold.service.getTask(plain))!).toBe(false);
      expect("subagentModel" in (await coldIntrospection.getRunDetail(plain))!).toBe(false);
    });
  });

  // 间隙（submit 已返回、dwf_run 行还没落）：`AmendWorkflow` 的 resolveInput 读快照判「沿用
  // 什么」，而修订一个刚起步的 run 恰好落在这里。注册表副本必须与落行后同一个答案。
  it("间隙里的快照与详情读注册表副本，答案与落行后一致", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({ hangActors: true, journal });

      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        subagentModel: FLASH,
        trace: traceFor("subagent-model-gap"),
      });
      hidden.add(runId);

      expect(await harness.service.getTask(runId)).toMatchObject({
        subagentModel: FLASH_CANONICAL,
      });
      expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
        subagentModel: FLASH_CANONICAL,
      });

      hidden.delete(runId);
      await vi.waitFor(async () => {
        expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
          subagentModel: FLASH_CANONICAL,
        });
      });

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("amend 用请求里的值，绝不继承前驱的（三态归一在工具层）", async () => {
    const harness = makeHarness({ hangActors: true });
    const predecessor = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      subagentModel: FLASH,
      trace: traceFor("subagent-model-amend-a"),
    });
    await vi.waitFor(() => {
      expect(subagentModelOf(harness, predecessor)).toBe(FLASH_CANONICAL);
    });

    // 换一个模型：后继落新值。
    const amended = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      subagentModel: HAIKU,
      trace: traceFor("subagent-model-amend-b"),
    });
    await vi.waitFor(() => {
      expect(subagentModelOf(harness, amended.runId)).toBe("anthropic/haiku");
    });
    expect(await harness.service.cancel(amended.runId)).toBe(true);
    await settle(harness, amended.runId);

    // 同一个前驱、这次不带字段：后继回到会话模型（缺席 ≠ 沿用前驱的 FLASH）。端口若在这里
    // 继承一次，工具面的 `null`（「回到会话模型」）就永远到不了落库这一步。
    const cleared = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("subagent-model-amend-c"),
    });
    await vi.waitFor(() => {
      expect(launchedOf(harness, cleared.runId)).toBeDefined();
    });
    expect("subagentModel" in launchedOf(harness, cleared.runId)!).toBe(false);
    expect(await harness.service.cancel(cleared.runId)).toBe(true);
    await settle(harness, cleared.runId);
  });

  it("run-started 载荷带 subagentModel，与 concurrencyCeiling 并列；不设即不出", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      subagentModel: FLASH,
      trace: traceFor("subagent-model-payload"),
    });
    await settle(harness, runId);

    const started = harness.runEvents.find(
      (event) => event.runId === runId && event.eventType === "run-started",
    );
    expect(started?.payload).toMatchObject({ subagentModel: FLASH_CANONICAL });

    const plain = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("subagent-model-payload-absent"),
    });
    await settle(harness, plain);
    const plainStarted = harness.runEvents.find(
      (event) => event.runId === plain && event.eventType === "run-started",
    );
    expect("subagentModel" in plainStarted!.payload).toBe(false);
  });

  it("actor runtime 工厂拿到解析回来的整条选择（含档位），不设时缺席", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      subagentModel: FLASH,
      trace: traceFor("subagent-model-factory"),
    });
    await settle(harness, runId);

    // 工厂收的是结构化选择而不是那个串：pin 只记身份两段，档位只能从这里下去。
    expect(harness.actorRuntimeInputs.at(-1)?.runSubagentModel).toEqual(FLASH);

    const plain = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("subagent-model-factory-absent"),
    });
    await settle(harness, plain);
    expect("runSubagentModel" in harness.actorRuntimeInputs.at(-1)!).toBe(false);
  });

  it("resume 从 run-launched 事件读回选择，交给工厂并抄进注册表条目", async () => {
    // resume 沿用记下来的那一份，与 caps / args 同一条纪律：一次 run 的身份包含它跑在哪个模型上。
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      subagentModel: FLASH,
      trace: traceFor("subagent-model-resume"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs).toHaveLength(1);
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    const resumed = await harness.service.resume!(runId);
    expect(resumed).toMatchObject({ ok: true, runId });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(1);
    });
    // 续跑那一世的工厂输入：选择整条回来了（档位没掉），而 resume 入口根本没有这个形参。
    expect(harness.actorRuntimeInputs.at(-1)?.runSubagentModel).toEqual(FLASH);

    // 续跑那一世的条目也带上了这份选择，于是读面只剩一条规则：有条目就读条目，只有冷行才
    // 去扫事件头。spy 是这条规则的证据——快照答得出模型，却一次 listEvents 都没发。
    const listEvents = vi.spyOn(harness.journal, "listEvents");
    expect(await harness.service.getTask(runId)).toMatchObject({
      subagentModel: FLASH_CANONICAL,
    });
    expect(listEvents).not.toHaveBeenCalled();
    listEvents.mockRestore();

    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
  });

  it("amend 带 subagentModel：run 选择压过前驱承袭的 pin，新 run 的 resolved_model 记的是新选择", async () => {
    // 回归用例（2026-09-17 testfield，dwf-assets/workflow-subagent-model-precedence-brief.md）：
    // 前驱的子代理跑在 pin 上；AmendWorkflow 带 `subagent_model` 换模型，run-launched 记下新选择、
    // 确认窗说「Subagents run on Z」，而 driver 仍按 pin 造会话——每个有 live 工作的续跑子代理都
    // 跑错模型。省略即继承，显式值即替换：pin 只守没有 run 选择时的隐式缺省。
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-model-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      // 前驱：worker 两问都 live，会话与边界真的落库——修订时第二问分歧，第一问作为已完成前缀
      // 让导入表带上转录种子，pin 就是随种子承袭过来的（seq 0 就分歧的 actor 没有前缀、没有种子）。
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [
            { kind: "submit", result: { text: "one" } },
            { kind: "submit", result: { text: "two" } },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: amendScript("second question"),
        trace: traceFor("subagent-model-over-pin-a"),
      });
      await settle(before, runA);

      // 前驱 worker 跑在会话模型上。把它的记录改成哨兵，好让 pin ≠ 会话模型 ≠ 本次选择——
      // 三个来源两两不同，「谁赢」才是可断言的事实。
      const workerRow = journal.getActor(runA, "actor#1", 1)!;
      expect(workerRow.resolvedModel).toBe("test/default-runtime-model");
      journal.putActor({ ...workerRow, resolvedModel: "pinned/from-predecessor" });

      // 修订：只改第二问，并给出新的子代理模型。
      const after = makeHarness({
        actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "revised" } }] },
        journal,
        sessionStore: store as never,
      });
      const amended = await amendRun(after, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: amendScript("second question, revised"),
        subagentModel: HAIKU,
        trace: traceFor("subagent-model-over-pin-b"),
      });
      await settle(after, amended.runId);
      expect((await after.service.getTask(amended.runId))?.output).toBe("one|revised|0");

      // worker 只在分歧那一问建了一次会话，工厂同时拿到承袭的 pin 与本 run 的选择——两者都在场，
      // 断言的才是优先级而不是某一方缺席。
      expect(after.actorRuntimeInputs).toHaveLength(1);
      expect(after.actorRuntimeInputs[0]).toMatchObject({
        pinnedModel: "pinned/from-predecessor",
        runSubagentModel: HAIKU,
      });
      // 回归点：新 run 自己的记录写的是 run 选择（修复前这里读到 pin）。
      expect(journal.getActor(amended.runId, "actor#1", 1)?.resolvedModel).toBe("anthropic/haiku");
      // 前驱的记录一个字节不动：lineage 因此保留「换过模型」这段历史，没有什么是静默的。
      expect(journal.getActor(runA, "actor#1", 1)?.resolvedModel).toBe("pinned/from-predecessor");
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

// ── 脚本点名的模型（docs/dynamic-workflow/launch.md「Models the script names」）─────────────
// persona 的 `model` 名字 → run-launched 上的绑定表 → 建会话时查表、压过 run 的子代理模型 →
// dwf_actor.resolved_model 记下实际用上的那一个。resume 从同一条事件读回同一张表。
describe("dynamic workflow run service — 脚本点名的模型", () => {
  const LIGHT: ModelSelection = { providerId: "zhipu", modelId: "GLM-5.3-Flash" };
  const STRONG: ModelSelection = {
    providerId: "zhipu",
    modelId: "GLM-5.3",
    options: { reasoningLevel: "high" },
  };
  const RUN_DEFAULT: ModelSelection = { providerId: "anthropic", modelId: "haiku" };
  const ROUTED_SCRIPT = [
    "interface Answer { text: string }",
    'const MODELS = { light: model("GLM-5.3-Flash"), strong: model("GLM-5.3$high") };',
    'const judge = await agent("评审员", { model: MODELS.light }).ask<Answer>("judge");',
    'const writer = await agent("写手", { model: MODELS.strong }).ask<Answer>("write");',
    'const plain = await agent("旁观者").ask<Answer>("watch");',
    'return [judge.text, writer.text, plain.text].join(",");',
  ].join("\n");

  const launchedOf = (harness: Harness, runId: string): RunEvent | undefined =>
    harness.journal
      .listEvents(runId, { types: "all", reportItems: "all" })
      .map((stored) => stored.event)
      .find((event) => event.type === "run-launched");

  it("每个子代理跑在自己 persona 点名的模型上，压过 run 的子代理模型；没点名的照旧跑 run 的", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: ROUTED_SCRIPT,
      subagentModel: RUN_DEFAULT,
      modelBindings: { "GLM-5.3-Flash": LIGHT, "GLM-5.3$high": STRONG },
      trace: traceFor("script-models-routed"),
    });
    await settle(harness, runId);
    expect((await harness.service.getTask(runId))?.runStatus).toBe("completed");

    const launched = launchedOf(harness, runId);
    expect(launched).toMatchObject({
      modelBindings: {
        "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash",
        "GLM-5.3$high": "zhipu/GLM-5.3$high",
      },
    });
    // 工厂收到的是整条选择（档位在内），没点名模型的子代理没有这一键。
    const byActor = new Map(
      harness.actorRuntimeInputs.map((input) => [refToString(input.actor), input]),
    );
    expect(byActor.get("actor#1@1")?.actorModel).toEqual(LIGHT);
    expect(byActor.get("actor#2@1")?.actorModel).toEqual(STRONG);
    expect("actorModel" in byActor.get("actor#3@1")!).toBe(false);
    // 落库的是 runtime 实际拿到的那一个：persona 的模型压过 run 的子代理模型。
    expect(harness.journal.getActor(runId, "actor#1", 1)?.resolvedModel).toBe(
      "zhipu/GLM-5.3-Flash",
    );
    expect(harness.journal.getActor(runId, "actor#2", 1)?.resolvedModel).toBe("zhipu/GLM-5.3");
    expect(harness.journal.getActor(runId, "actor#3", 1)?.resolvedModel).toBe("anthropic/haiku");
    // persona 里记的是脚本逐字写下的名字（ModelRef 在 lowering 里已抹成名字）。
    expect(harness.journal.getActor(runId, "actor#2", 1)?.persona).toMatchObject({
      model: "GLM-5.3$high",
    });
  });

  it("actor-created 载荷派生出子代理的规范模型串；没点名模型的不带", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: ROUTED_SCRIPT,
      modelBindings: { "GLM-5.3-Flash": LIGHT, "GLM-5.3$high": STRONG },
      trace: traceFor("script-models-payload"),
    });
    await settle(harness, runId);
    const created = harness.runEvents.filter(
      (event) => event.runId === runId && event.eventType === "actor-created",
    );
    expect(created.map((event) => event.payload.model)).toEqual([
      "zhipu/GLM-5.3-Flash",
      "zhipu/GLM-5.3$high",
      undefined,
    ]);
    expect("model" in created[2]!.payload).toBe(false);
    // 派发重复出生事实：引擎带 persona 的名字（actorPersonaModel），宿主派生规范串（actorModel），
    // 读面据它把派发时收回表的子代理连模型一起建出来。
    const dispatched = harness.runEvents.filter(
      (event) =>
        event.runId === runId &&
        event.eventType === "node-dispatched" &&
        event.payload.kind === "ask",
    );
    expect(
      dispatched.map((event) => [event.payload.actorPersonaModel, event.payload.actorModel]),
    ).toEqual([
      ["GLM-5.3-Flash", "zhipu/GLM-5.3-Flash"],
      ["GLM-5.3$high", "zhipu/GLM-5.3$high"],
      [undefined, undefined],
    ]);
  });

  it("绑定表里没有的名字（只有绕过 9010 的断言做得到）让那一问以 DriverError 失败，不退回别的模型", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: [
        "interface Answer { text: string }",
        'const name = "GLM-9" as unknown as ModelRef;',
        'const a = await agent("评审员", { model: name }).ask<Answer>("judge");',
        "return a.text;",
      ].join("\n"),
      subagentModel: RUN_DEFAULT,
      trace: traceFor("script-models-unbound"),
    });
    await settle(harness, runId);
    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.runStatus).toBe("errored");
    expect(JSON.stringify(snapshot)).toContain('\\"GLM-9\\"');
    expect(harness.actorRuntimeInputs).toHaveLength(0);
  });

  const TABLE = { "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash", "GLM-5.3$high": "zhipu/GLM-5.3$high" };

  it("快照与详情带出绑定表：热路径读条目，冷行扫事件头", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: ROUTED_SCRIPT,
        modelBindings: { "GLM-5.3-Flash": LIGHT, "GLM-5.3$high": STRONG },
        trace: traceFor("script-models-read"),
      });
      await settle(harness, runId);
      expect(await harness.service.getTask(runId)).toMatchObject({ modelBindings: TABLE });
      expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
        modelBindings: TABLE,
      });
      // 冷行（另一个进程，没有条目）：从 run-launched 读回同一张表。
      const cold = makeHarness({ journal });
      expect(await cold.service.getTask(runId)).toMatchObject({ modelBindings: TABLE });
      expect(await introspectionOf(cold).getRunDetail(runId)).toMatchObject({
        modelBindings: TABLE,
      });
    });
  });

  it("resume 从 run-launched 读回同一张表交给工厂，并抄进注册表条目", async () => {
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: ROUTED_SCRIPT,
      modelBindings: { "GLM-5.3-Flash": LIGHT, "GLM-5.3$high": STRONG },
      trace: traceFor("script-models-resume"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs).toHaveLength(1);
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    const resumed = await harness.service.resume!(runId);
    expect(resumed).toMatchObject({ ok: true, runId });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(1);
    });
    expect(harness.actorRuntimeInputs.at(-1)?.actorModel).toEqual(LIGHT);
    expect(await harness.service.getTask(runId)).toMatchObject({ modelBindings: TABLE });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
  });

  it("不点名模型的 run：事件、快照、载荷与工厂输入里都没有这些键", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("script-models-absent"),
    });
    await settle(harness, runId);
    expect("modelBindings" in launchedOf(harness, runId)!).toBe(false);
    expect("modelBindings" in (await harness.service.getTask(runId))!).toBe(false);
    expect("actorModel" in harness.actorRuntimeInputs.at(-1)!).toBe(false);
  });
});

// ── 本 run 子代理的权限模式（docs/dynamic-workflow/launch.md「Permissions inside a run」）──
// 建 run 那一世把发起会话的权限模式记进 `run-launched.subagentPermissionMode`，resume 从同一条
// 事件读回；会话此后怎么换模式都不改变这个 run。plan 不带进 run。
describe("dynamic workflow run service — 本 run 子代理的权限模式", () => {
  const launchedOf = (harness: Harness, runId: string): RunEvent | undefined =>
    harness.journal
      .listEvents(runId, { types: "all", reportItems: "all" })
      .map((stored) => stored.event)
      .find((event) => event.type === "run-launched");

  it("发起会话的模式原样记下并交给 actor 工厂；旧 plan 值记为 build", async () => {
    let mode: CollaborationMode = "guarded";
    const harness = makeHarness({ permissionMode: () => mode });
    const cases: ReadonlyArray<readonly [CollaborationMode, string]> = [
      ["guarded", "guarded"],
      ["build", "build"],
      ["edit", "edit"],
      ["yolo", "yolo"],
      ["auto", "auto"],
      ["plan", "build"],
    ];
    for (const [sessionMode, recorded] of cases) {
      mode = sessionMode;
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        scriptText: TYPED_SCRIPT,
        trace: traceFor(`permission-mode-${sessionMode}`),
      });
      await settle(harness, runId);
      expect(launchedOf(harness, runId)).toMatchObject({ subagentPermissionMode: recorded });
      expect(harness.actorRuntimeInputs.at(-1)?.subagentPermissionMode).toBe(recorded);
      // 零 SQL：记录行上没有这条事实。
      expect("subagentPermissionMode" in harness.journal.getRun(runId)!).toBe(false);
    }
  });

  it("没接模式读取的宿主（CLI、测试装配）照旧 YOLO：键缺席", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("permission-mode-unwired"),
    });
    await settle(harness, runId);
    expect("subagentPermissionMode" in launchedOf(harness, runId)!).toBe(false);
    expect("subagentPermissionMode" in harness.actorRuntimeInputs.at(-1)!).toBe(false);
  });

  it("resume 以 run-launched 为准：会话已换到 yolo，续跑的子代理仍是 guarded", async () => {
    let mode: CollaborationMode = "guarded";
    const harness = makeHarness({ hangActors: true, permissionMode: () => mode });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("permission-mode-resume"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs).toHaveLength(1);
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    mode = "yolo";
    const resumed = await harness.service.resume!(runId);
    expect(resumed).toMatchObject({ ok: true, runId });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(1);
    });
    expect(harness.actorRuntimeInputs.at(-1)?.subagentPermissionMode).toBe("guarded");
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
  });

  it("amend 是新 run：取修订那一刻的会话模式，不继承前驱的", async () => {
    let mode: CollaborationMode = "yolo";
    const harness = makeHarness({ hangActors: true, permissionMode: () => mode });
    const predecessor = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("permission-mode-amend-a"),
    });
    await vi.waitFor(() => {
      expect(launchedOf(harness, predecessor)).toBeDefined();
    });
    expect(launchedOf(harness, predecessor)).toMatchObject({ subagentPermissionMode: "yolo" });

    mode = "guarded";
    const guarded = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("permission-mode-amend-b"),
    });
    await vi.waitFor(() => {
      expect(launchedOf(harness, guarded.runId)).toMatchObject({
        subagentPermissionMode: "guarded",
      });
    });

    mode = "build";
    const relaxed = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: guarded.runId,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("permission-mode-amend-c"),
    });
    await vi.waitFor(() => {
      expect(launchedOf(harness, relaxed.runId)).toBeDefined();
    });
    expect(launchedOf(harness, relaxed.runId)).toMatchObject({ subagentPermissionMode: "build" });
    expect(await harness.service.cancel(relaxed.runId)).toBe(true);
    await settle(harness, relaxed.runId);
  });
});

// ── 本 run 的脚本文件（docs/dynamic-workflow/launch.md「Script files」的 Provenance）───────
// `scriptPath` 记的是「这个 run 的脚本从哪个文件来的」，绝对路径。与子代理模型逐条同规：
// 随 `run-launched` 记一次、引擎不读、零 SQL、两条读面读回（有条目读条目，冷行扫事件头）。
// 唯一的不同是它**没有三态**：修订记的永远是新脚本的文件，绝不沿用前驱的——前驱的路径
// 指向旧脚本，沿用它就是让模型下次去编辑一个已经不在跑的文件。
describe("dynamic workflow run service — 本 run 的脚本文件", () => {
  const DRAFT = "/repo/.zcode/workflow-drafts/audit.dwf.ts";
  const REVISED = "/repo/.zcode/workflow-drafts/audit-2.dwf.ts";

  const launchedOf = (harness: Harness, runId: string): RunEvent | undefined =>
    harness.journal
      .listEvents(runId, { types: "all", reportItems: "all" })
      .map((stored) => stored.event)
      .find((event) => event.type === "run-launched");

  const scriptPathOf = (harness: Harness, runId: string): string | undefined => {
    const launched = launchedOf(harness, runId);
    return launched?.type === "run-launched" ? launched.scriptPath : undefined;
  };

  it("submit 把绝对路径记进 run-launched，行上没有这条事实；不给即整个键缺席", async () => {
    const harness = makeHarness();
    const withFile = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      scriptPath: DRAFT,
      trace: traceFor("script-path-submit"),
    });
    await settle(harness, withFile);
    expect(scriptPathOf(harness, withFile)).toBe(DRAFT);
    // 零 SQL：记录行上没有这条事实（用户裁决不做迁移），读侧一律走事件。
    expect("scriptPath" in harness.journal.getRun(withFile)!).toBe(false);

    const without = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("script-path-submit-absent"),
    });
    await settle(harness, without);
    // 键缺席而不是 `undefined`：模型面据「在不在场」决定说哪一句下一步。
    expect("scriptPath" in launchedOf(harness, without)!).toBe(false);
  });

  it("快照与详情给出同一个绝对路径；不给时两条读面都不带这个键（冷重启后照样）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const withFile = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        scriptPath: DRAFT,
        trace: traceFor("script-path-read-set"),
      });
      await settle(harness, withFile);
      const without = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("script-path-read-absent"),
      });
      await settle(harness, without);

      const introspection = introspectionOf(harness);
      expect(await harness.service.getTask(withFile)).toMatchObject({ scriptPath: DRAFT });
      expect(await introspection.getRunDetail(withFile)).toMatchObject({ scriptPath: DRAFT });
      expect("scriptPath" in (await harness.service.getTask(without))!).toBe(false);
      expect("scriptPath" in (await introspection.getRunDetail(without))!).toBe(false);

      // 列表行不带：与子代理模型、并发上界同规——只有 AmendWorkflow 用得上的字段不该把
      // 枚举面的每一行都加宽。
      const { runs } = await introspection.listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs).toHaveLength(2);
      for (const row of runs) expect("scriptPath" in row).toBe(false);

      // 重启（新服务、空注册表、同一个 journal）：内存副本没有了，两条读面只能从
      // `run-launched` 事件读回——「零 SQL 也能冷读」的证据。
      const cold = makeHarness({ journal });
      const coldIntrospection = introspectionOf(cold);
      expect(await cold.service.getTask(withFile)).toMatchObject({ scriptPath: DRAFT });
      expect(await coldIntrospection.getRunDetail(withFile)).toMatchObject({ scriptPath: DRAFT });
      expect("scriptPath" in (await cold.service.getTask(without))!).toBe(false);
      expect("scriptPath" in (await coldIntrospection.getRunDetail(without))!).toBe(false);
    });
  });

  // 间隙（submit 已返回、dwf_run 行还没落）：与子代理模型同一条论证——注册表副本必须与
  // 落行后给出同一个答案。
  it("间隙里的快照与详情读注册表副本，答案与落行后一致", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({ hangActors: true, journal });

      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        scriptPath: DRAFT,
        trace: traceFor("script-path-gap"),
      });
      hidden.add(runId);

      expect(await harness.service.getTask(runId)).toMatchObject({ scriptPath: DRAFT });
      expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
        scriptPath: DRAFT,
      });

      hidden.delete(runId);
      await vi.waitFor(async () => {
        expect(await introspectionOf(harness).getRunDetail(runId)).toMatchObject({
          scriptPath: DRAFT,
        });
      });

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("amend 用请求里的路径，绝不继承前驱的（不给即缺席，不是沿用）", async () => {
    const harness = makeHarness({ hangActors: true });
    const predecessor = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      scriptPath: DRAFT,
      trace: traceFor("script-path-amend-a"),
    });
    await vi.waitFor(() => {
      expect(scriptPathOf(harness, predecessor)).toBe(DRAFT);
    });

    const amended = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      scriptPath: REVISED,
      trace: traceFor("script-path-amend-b"),
    });
    await vi.waitFor(() => {
      expect(scriptPathOf(harness, amended.runId)).toBe(REVISED);
    });
    expect(await harness.service.cancel(amended.runId)).toBe(true);
    await settle(harness, amended.runId);

    // 同一个前驱、这次不带字段：后继没有文件（缺席 ≠ 沿用前驱的 DRAFT）。前驱的路径指向的
    // 是旧脚本，端口若在这里继承一次，模型下次就会去编辑一个已经不在跑的文件。
    const cleared = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("script-path-amend-c"),
    });
    await vi.waitFor(() => {
      expect(launchedOf(harness, cleared.runId)).toBeDefined();
    });
    expect("scriptPath" in launchedOf(harness, cleared.runId)!).toBe(false);
    expect(await harness.service.cancel(cleared.runId)).toBe(true);
    await settle(harness, cleared.runId);
  });

  it("resume 从 run-launched 事件读回路径抄进条目：读面照旧「有条目就读条目」", async () => {
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      scriptPath: DRAFT,
      trace: traceFor("script-path-resume"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs).toHaveLength(1);
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    expect(await harness.service.resume!(runId)).toMatchObject({ ok: true, runId });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(1);
    });

    // 续跑那一世的条目带上了这个路径（resume 入口根本没有这个形参，唯一来源是事件）。
    // spy 是「有条目就读条目」的证据：快照答得出路径，却一次 listEvents 都没发。
    const listEvents = vi.spyOn(harness.journal, "listEvents");
    expect(await harness.service.getTask(runId)).toMatchObject({ scriptPath: DRAFT });
    expect(listEvents).not.toHaveBeenCalled();
    listEvents.mockRestore();

    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
  });
});

describe("dynamic workflow run service — 发起锚点（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Token telemetry for subagents」）", () => {
  const anchoredEvents = (harness: Harness) =>
    harness.runEvents.filter(
      (event) => event.eventType === "actor-created" || event.eventType === "run-settled",
    );

  it("活动轮命中 → journal 首条 run-launched 与 actor-created / run-settled 载荷带同一锚点", async () => {
    const trace = traceFor("anchor-active");
    const harness = makeHarness({
      resolveLaunchInputId: (candidate) =>
        candidate.turnId === trace.turnId ? "launch-input-active" : undefined,
    });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("anchor-parent"),
      scriptText: TYPED_SCRIPT,
      toolCallId: "tool-anchor",
      trace,
    });
    await settle(harness, runId);

    const events = harness.journal.listEvents(runId, { types: "all", reportItems: "all" });
    expect(events.slice(0, 2).map((stored) => stored.event.type)).toEqual([
      "run-started",
      "run-launched",
    ]);
    expect(events[1]?.event).toMatchObject({
      inputId: "launch-input-active",
      toolCallId: "tool-anchor",
    });
    const anchored = anchoredEvents(harness);
    expect(anchored.map((event) => event.eventType)).toEqual(["actor-created", "run-settled"]);
    expect(anchored.every((event) => event.launchInputId === "launch-input-active")).toBe(true);
    // 其余事件不带派生字段：锚点只在归属的两个时刻需要。
    expect(
      harness.runEvents
        .filter((event) => event.eventType === "node-queued")
        .every((event) => event.launchInputId === undefined),
    ).toBe(true);
  });

  it("submit 的 phaseNames 落进 run-launched（journal 是唯一副本，冷重放免费重建）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      launchInputId: "launch-input-phases",
      phaseNames: ["Research", "Write"],
      scriptText: TYPED_SCRIPT,
      trace: traceFor("anchor-phases"),
    });
    await settle(harness, runId);
    expect(
      harness.journal.listEvents(runId, { types: "all", reportItems: "all" })[1]?.event,
    ).toEqual({
      type: "run-launched",
      inputId: "launch-input-phases",
      phaseNames: ["Research", "Write"],
    });
  });

  it("submit 的 phaseAlongside 与阶段表同车落 journal（service 只转发，不加工）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      launchInputId: "launch-input-alongside",
      phaseNames: ["A", "B", "C"],
      phaseAlongside: [[], [0], []],
      scriptText: TYPED_SCRIPT,
      trace: traceFor("anchor-alongside"),
    });
    await settle(harness, runId);
    expect(
      harness.journal.listEvents(runId, { types: "all", reportItems: "all" })[1]?.event,
    ).toEqual({
      type: "run-launched",
      inputId: "launch-input-alongside",
      phaseNames: ["A", "B", "C"],
      phaseAlongside: [[], [0], []],
    });
  });

  it("显式 launchInputId（中枢直接启动）优先于活动轮解析", async () => {
    const harness = makeHarness({ resolveLaunchInputId: () => "active-should-lose" });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      launchInputId: "launch-input-direct",
      scriptText: TYPED_SCRIPT,
      trace: traceFor("anchor-direct"),
    });
    await settle(harness, runId);
    expect(
      harness.journal.listEvents(runId, { types: "all", reportItems: "all" })[1]?.event,
    ).toMatchObject({
      inputId: "launch-input-direct",
    });
    expect(
      anchoredEvents(harness).every((event) => event.launchInputId === "launch-input-direct"),
    ).toBe(true);
  });

  it("没有解析器也没有显式值 → 铸 UUID v7 锚点", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("anchor-minted"),
    });
    await settle(harness, runId);
    const launched = harness.journal.listEvents(runId, { types: "all", reportItems: "all" })[1]
      ?.event;
    expect(launched?.type).toBe("run-launched");
    const inputId = launched?.type === "run-launched" ? launched.inputId : "";
    expect(inputId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(anchoredEvents(harness).every((event) => event.launchInputId === inputId)).toBe(true);
  });
});

describe("dynamic workflow run service — 产物存储的接线", () => {
  /** 记录写入参数的 fake store（只需文本写：脚本发的是 markdown）。 */
  function recordingArtifactStore(): {
    store: ToolArtifactStorePort;
    writes: ToolArtifactWriteRequest[];
  } {
    const writes: ToolArtifactWriteRequest[] = [];
    return {
      writes,
      store: {
        writeToolResultArtifact: async (request) => {
          writes.push(request);
          return {
            id: "artifact-1",
            uri: "zcode-artifact://harness/artifact-1",
            bytes: Buffer.byteLength(request.content, "utf8"),
            contentType: request.contentType ?? "text/plain",
            createdAt: new Date(0),
          };
        },
        readToolResultArtifact: async () => {
          throw new Error("readToolResultArtifact 不应被本用例触及");
        },
      },
    };
  }

  it("store 经 service → launch → driver 送达，会话作用域是本服务的父会话", async () => {
    const { store, writes } = recordingArtifactStore();
    const harness = makeHarness({ artifactStore: store });

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("some-other-session"),
      scriptText: ARTIFACT_SCRIPT,
      trace: traceFor("artifact-wiring"),
    });
    await settle(harness, runId);

    expect(harness.journal.getRun(runId)?.status).toBe("completed");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      // **本服务的**父会话，不是 submit 请求里那个可选的 parentSessionId：生产里两者同值，
      // 而只有前者是必填的（字节写进哪个会话的目录不该有 undefined 分支）。
      sessionId: HARNESS_PARENT_SESSION,
      toolName: "CreateWorkflow",
      retention: "project",
      contentType: "text/markdown",
    });
    expect(String(writes[0]?.toolCallId)).toBe(`${runId}:artifact#1@1`);
  });

  it("不接 store 的装配里，发布以 ArtifactStoreUnavailable 拒绝而 run 照常结算", async () => {
    const harness = makeHarness();

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      // 脚本 catch 住拒绝并把错误码当结果交出来：这正是 spec 的门控习语。
      scriptText: [
        "let code = 'none';",
        'try { await artifact.markdown("summary", "# 结论"); }',
        "catch (error) { code = (error as { code?: string }).code ?? 'unknown'; }",
        "return code;",
      ].join("\n"),
      trace: traceFor("artifact-no-store"),
    });
    await settle(harness, runId);

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.output).toBe("ArtifactStoreUnavailable");
  });
});

// ── 用户面产物的读面（docs/dynamic-workflow/authoring.md「How the user sees them」）──────────────
// ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给**用户**看的产出，不是端口上的 `output`
// （脚本顶层返回值，引擎内部对它的同名叫法）。
//
// 三个端口方法：listArtifacts（清单）/ listArtifactItems（看板取数）/ readArtifact（字节）。
// readArtifact 的授权链是本节的重点：run 属于本会话 ∧ journal 有该版本的 completed 行 ⇒
// 才拿**行上的** uri 去 store 读。每一条负例都断言 store **一次都没被碰过**。
describe("dynamic workflow run service — 用户面产物的读面", () => {
  /** 记录读写的 fake store；`readToolResultBinaryArtifact` 按 uri 回它写过的字节。 */
  function readableArtifactStore(): {
    store: ToolArtifactStorePort;
    reads: string[];
  } {
    const bytesByUri = new Map<string, Uint8Array>();
    const reads: string[] = [];
    let next = 0;
    return {
      reads,
      store: {
        writeToolResultArtifact: async (request) => {
          next += 1;
          const uri = `zcode-artifact://harness/artifact-${next}`;
          bytesByUri.set(uri, new TextEncoder().encode(request.content));
          return {
            id: `artifact-${next}`,
            uri,
            bytes: Buffer.byteLength(request.content, "utf8"),
            contentType: request.contentType ?? "text/plain",
            createdAt: new Date(0),
          };
        },
        readToolResultArtifact: async () => {
          throw new Error(
            "字节读回必须走 readToolResultBinaryArtifact（文本读会毁掉 office 文件）",
          );
        },
        readToolResultBinaryArtifact: async (request) => {
          reads.push(request.uri);
          const bytes = bytesByUri.get(request.uri);
          if (bytes === undefined) throw new Error(`unknown uri: ${request.uri}`);
          // store 侧按文件名再推一次 contentType，故意给一个**错的**：读面必须用 journal
          // 记录上的那一份（UI 分派渲染器的精确匹配契约）。
          return { uri: request.uri, bytes, contentType: "application/json" };
        },
      },
    };
  }

  /** 声明一块看板、喂它两条标签 report，再发布两版 markdown。 */
  const MIXED_SCRIPT = [
    'artifact.chart("perf", { x: { field: "round" }, y: { field: "ms" } });',
    'report({ round: 1, ms: 40 }, "perf");',
    'report({ round: 2, ms: 31 }, "perf");',
    "report({ untagged: true });",
    'await artifact.markdown("summary", "# 第一版");',
    'await artifact.markdown("summary", "# 第二版");',
    'return "done";',
  ].join("\n");

  async function runMixed(overrides: { parentSessionId?: SessionId } = {}) {
    const { store, reads } = readableArtifactStore();
    const harness = makeHarness({ artifactStore: store });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: overrides.parentSessionId ?? HARNESS_PARENT_SESSION,
      scriptText: MIXED_SCRIPT,
      trace: traceFor("artifact-reads"),
    });
    await settle(harness, runId);
    expect(harness.journal.getRun(runId)?.status).toBe("completed");
    return { harness, runId, reads };
  }

  it("listArtifacts 按 id 分组、版本升序，顶层取最新版；看板带 itemCount、内容产物恒 0", async () => {
    const { harness, runId } = await runMixed();
    const artifacts = await harness.service.listArtifacts!(runId);

    expect(artifacts).toHaveLength(2);
    // 顺序 = 首次出现顺序：看板先声明，markdown 后发布。
    const [chart, summary] = artifacts!;
    // 未打标签的那条 report 不算进任何产物。
    expect(chart).toMatchObject({ id: "perf", kind: "chart", version: 1, itemCount: 2 });
    expect(chart?.versions).toHaveLength(1);
    expect(summary).toMatchObject({
      id: "summary",
      kind: "markdown",
      version: 2,
      contentType: "text/markdown",
      itemCount: 0,
    });
    expect(summary?.versions.map((entry) => entry.version)).toEqual([1, 2]);
  });

  it("listArtifactItems 按 sequence 升序分页，afterSequence 严格大于，hasMore 由存储层判定", async () => {
    const { harness, runId } = await runMixed();
    const read = (page: { afterSequence?: number; limit: number }, artifactId = "perf") =>
      harness.service.listArtifactItems!(runId, artifactId, { ...page, maxBytes: 1 << 30 });
    const all = await read({ limit: 10 });
    expect(all.items.map((entry) => entry.item)).toEqual([
      { round: 1, ms: 40 },
      { round: 2, ms: 31 },
    ]);
    expect(all.items[0]?.siteId).toBe("report#1");
    expect(all.hasMore).toBe(false);

    // limit 精确：存储层绝不自己钳，且说得出页之后还有没有。
    const firstPage = await read({ limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    // 游标严格大于。
    const secondPage = await read({ afterSequence: firstPage.items[0]!.sequence, limit: 10 });
    expect(secondPage.items.map((entry) => entry.item)).toEqual([{ round: 2, ms: 31 }]);
    // 越界 cursor 得到空页，不是错误——翻到尾巴是正常的翻页结局。
    expect(await read({ afterSequence: 9_999, limit: 10 })).toEqual({ items: [], hasMore: false });
    // 未知 id 同样是空页（未打标签的那条 report 不属于任何 id）。
    expect(await read({ limit: 10 }, "ghost")).toEqual({ items: [], hasMore: false });
  });

  it("readArtifact 回字节 + **journal 记录上的** contentType（不是 store 再推的那份）", async () => {
    const { harness, runId, reads } = await runMixed();
    const first = await harness.service.readArtifact!(runId, "summary", 1);
    const second = await harness.service.readArtifact!(runId, "summary", 2);

    expect(new TextDecoder().decode(first!.bytes)).toBe("# 第一版");
    expect(new TextDecoder().decode(second!.bytes)).toBe("# 第二版");
    // store 的替身故意回 application/json；记录上的 text/markdown 才是 UI 的分派契约。
    expect(first!.contentType).toBe("text/markdown");
    // 两个版本各自的 uri——版本历史是真的，不是同一份字节换个号。
    expect(new Set(reads).size).toBe(2);
  });

  it("授权负例：run 的父会话不是本服务的 ⇒ 拒绝，且 store 一次都没被碰", async () => {
    // 这是 spec 行 177 的授权链第 ② 步。服务实例按父会话构造，一个别的会话的 run 的字节
    // 绝不能经本服务流出去。
    const { harness, runId, reads } = await runMixed({
      parentSessionId: createSessionId("some-other-session"),
    });
    expect(await harness.service.readArtifact!(runId, "summary", 1)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("授权负例：未知 runId / 未知 artifactId / 未知版本 ⇒ 拒绝，store 未被碰", async () => {
    const { harness, runId, reads } = await runMixed();
    expect(await harness.service.readArtifact!("dwfrun-nope", "summary", 1)).toBeUndefined();
    expect(await harness.service.readArtifact!(runId, "ghost", 1)).toBeUndefined();
    // 只发布过两版，第 3 版不存在——版本号是授权链的一部分，不是一个可以越过的提示。
    expect(await harness.service.readArtifact!(runId, "summary", 3)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("授权负例：预置看板没有字节 ⇒ 拒绝（它的数据是 journal 里的标签 report 行）", async () => {
    const { harness, runId, reads } = await runMixed();
    expect(await harness.service.readArtifact!(runId, "perf", 1)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("store 缺席 / 不带二进制读回 ⇒ 整条读回缺席，绝不退回文本读再解码", async () => {
    // 退回文本读正是 2026-09-04 记录在 ToolBinaryArtifactReadResult 上的那条 bug：
    // store 按文件名推 contentType，office 扩展名落到 application/json 被当 utf8 解码即损坏。
    const textOnly: ToolArtifactStorePort = {
      writeToolResultArtifact: async (request) => ({
        id: "a1",
        uri: "zcode-artifact://harness/a1",
        bytes: Buffer.byteLength(request.content, "utf8"),
        contentType: request.contentType ?? "text/plain",
        createdAt: new Date(0),
      }),
      readToolResultArtifact: async () => {
        throw new Error("不带二进制能力的 store 不得被退回文本读");
      },
    };
    const harness = makeHarness({ artifactStore: textOnly });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: ARTIFACT_SCRIPT,
      trace: traceFor("artifact-read-textonly"),
    });
    await settle(harness, runId);
    expect(await harness.service.readArtifact!(runId, "summary", 1)).toBeUndefined();
  });

  it("引擎发出的事件真的能被共享 reducer 归约成 workflowRuns.artifacts（两半的接缝）", async () => {
    // 这条钉的是**接缝**，不是任何一半：reducer 假设 `artifact-published` 的载荷是
    // `{ instance, artifact: ArtifactVersionRecord }`，而载荷实际由引擎发、经
    // toProgressPayload 有界化。两边各自的单测都绿、形状却对不上，是这类分层最典型的
    // 静默失败——症状是侧板永远空着，而没有任何一处报错。
    const { harness, runId } = await runMixed();

    const published = harness.runEvents.filter((event) => event.eventType === "artifact-published");
    // 一块看板声明 + 两版 markdown = 三条；失败的发布才走 artifact-failed（本脚本没有）。
    expect(published).toHaveLength(3);
    expect(harness.runEvents.some((event) => event.eventType === "artifact-failed")).toBe(false);
    // 产物站点不发任何节点生命周期事件（slice 1 的裁决：否则投影会把它归约进 nodes[]，
    // 侧板上就多出一个没人能等的 untracked 节点）。
    expect(
      published.every((event) => (event.payload as { instance?: unknown }).instance !== undefined),
    ).toBe(true);

    let state: WorkflowRunsState | undefined;
    for (const event of harness.runEvents) {
      state = reduceWorkflowRunsState(state, event as WorkflowRunProgressEnvelope) ?? state;
    }
    expect(state?.runs[0]?.artifacts).toEqual([
      { id: "perf", kind: "chart", version: 1, itemCount: 2 },
      // bytes 随记录带上来（卡片要显示大小）；11 = "# 第二版" 的 UTF-8 字节数。
      { id: "summary", kind: "markdown", version: 2, contentType: "text/markdown", bytes: 11 },
    ]);
    // 归约出来的状态过 strict schema——线上那一帧不会因为多带/少带一个键被整帧丢掉。
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
    // 打了标签的 report 仍然进 Results 区（一条通道一套上限），未打标签的也在。
    expect(state?.runs[0]?.reports?.map((report) => report.artifactId)).toEqual([
      "perf",
      "perf",
      undefined,
    ]);
  });

  it("零产物的 run：listArtifacts 整个缺席（不是空数组）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("artifact-none"),
    });
    await settle(harness, runId);
    expect(await harness.service.listArtifacts!(runId)).toBeUndefined();
  });
});

describe("dynamic workflow run service — actor sessions", () => {
  it("两个持久化调用都发生，且 task link 在会话落库之后", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("actor-parent"),
      scriptText: TYPED_SCRIPT,
      trace: traceFor("actor-persist"),
    });
    await settle(harness, runId);

    // 1. ensureSessionPersistedForExternalActivity
    expect(harness.persistedTitles).toHaveLength(1);
    expect(harness.persistedTitles[0]).toContain("actor#1@1");
    // 2. createSessionTaskLink
    expect(harness.taskLinks).toHaveLength(1);
    const link = harness.taskLinks[0]!;
    expect(link.role).toBe("workflow_actor");
    expect(link.parentSessionId).toBe(createSessionId("actor-parent"));
    // run 身份走无 FK 的 path 列：rootWorkflowRunId 对 legacy workflow_run(id) 有 FK，
    // 填 dwf runId 会以 FOREIGN KEY constraint failed 拒掉每一个 link。
    expect(link.rootWorkflowRunId).toBeUndefined();
    expect(link.path).toContain(runId);
  });

  /**
   * 生产接线的绊线（amend-resume）：转录面从 service deps 一路交到 driver 手上，边界才写得下来。
   * 中间任何一环忘了透传，都不会有编译错误、run 照常跑完——只是这个 run 从此**不能作修订的
   * 前驱**（service 的「无 marker 前驱整体拒绝」门会挡下来），而症状离成因很远。所以这条用例
   * 走真库：actor 的消息真的落库，边界必须等于同一个存取面数出来的长度。
   */
  it("接上会话存储后，ask 节点带上消息数边界（service → launch → driver 的透传）", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-boundary-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    try {
      const harness = makeHarness({ sessionStore: store as never });
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("actor-boundary"),
      });
      await settle(harness, runId);

      const node = harness.journal.getNode(runId, "ask#1", 1);
      const actorSessionId = harness.actorRuntimeInputs[0]!.sessionId;
      const persisted = await store.messages({ sessionID: actorSessionId });
      expect(persisted.length).toBeGreaterThan(0);
      expect(node?.messageBoundary).toBe(persisted.length);
      // 读改写：引擎写下的字段一个不许掉。
      expect(node?.status).toBe("completed");
      expect(node?.actorSeq).toBe(0);
      expect(node?.stats?.tokens).toBeGreaterThan(0);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // transcript 直播只剩一条通道：child runtime 的**构造期** eventSink。run service 不再
  // 自己订阅——旧的 `onActorSessionEvent` + `subscribeEvents` 装在 persist 之后，而
  // persist 写下的 SessionTitleUpdated 就是 seq 1，v4 网关只排水连续 seq，于是那条
  // 订阅从 seq 2 起永远等一个再也不会来的 seq 1（transcript 永久空白）。
  // driver 的限流观察订阅（每 actor 恰好一次）不是直播通道：它只读 ModelNetworkStatus，
  // 漏掉 seq 1 无关紧要——所以这里钉的是「恰好每 actor 一次」，而不是零。
  it("actor 事件只经构造期 sink 直播，subscribeEvents 只有 driver 的两个观察面（每 actor 各一次）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("actor-live-channel"),
    });
    await settle(harness, runId);

    const actorSessionId = harness.actorRuntimeInputs[0]!.sessionId;
    expect(harness.sessionEvents.length).toBeGreaterThan(0);
    expect(
      harness.sessionEvents.every(
        (event) => (event as { sessionId: string }).sessionId === actorSessionId,
      ),
    ).toBe(true);
    expect(harness.actorSubscribeCalls).toEqual([actorSessionId, actorSessionId]);
    // 共享 store 的一面：actor 事件按自己的 sessionId 落在（生产里是父 runtime 的）store 里，
    // 这正是 v4 `loadPersistedEvents(actorSessionId)` 读的地方。
    const stored = await harness.actorEventStore.getEvents(actorSessionId);
    expect(stored.length).toBe(harness.sessionEvents.length);
  });

  it("actor 会话 id 含 runId 且字符集安全", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("actor-session-id"),
    });
    await settle(harness, runId);

    expect(harness.actorRuntimeInputs).toHaveLength(1);
    const sessionId = harness.actorRuntimeInputs[0]!.sessionId;
    expect(sessionId).toContain(runId);
    // refToString(actor) 是 `actor#1@1`：# 与 @ 必须已被折叠掉。
    expect(sessionId).not.toMatch(/[#@/]/);
  });

  // 持久化序列必须是**每 actor、创建时、原子**的：绝不批到 submit，也绝不推迟到第一次 ask 之后。
  // 这条钉的正是那个退化——若将来有人把工厂改回 fire-and-forget，落库与建链就会与第一个
  // turn 竞速，而 session_task_link.child_session_id 的 FK 要求会话行先存在。
  it("持久化在该 actor 的首个 turn 之前完成（不是 fire-and-forget）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: createSessionId("order-parent"),
      scriptText: TYPED_SCRIPT,
      trace: traceFor("actor-order"),
    });
    await settle(harness, runId);

    const persistIndex = harness.order.findIndex((entry) => entry.startsWith("persist:"));
    const linkIndex = harness.order.findIndex((entry) => entry.startsWith("link:"));
    const turnIndex = harness.order.findIndex((entry) => entry.startsWith("turn:"));
    const constructIndex = harness.order.findIndex((entry) => entry.startsWith("construct:"));

    expect(persistIndex).toBeGreaterThanOrEqual(0);
    expect(linkIndex).toBeGreaterThanOrEqual(0);
    expect(turnIndex).toBeGreaterThanOrEqual(0);
    expect(constructIndex).toBeGreaterThanOrEqual(0);
    // runtime 构造（= 直播 sink 装好）必须早于 persist：persist 写的 SessionTitleUpdated
    // 是 seq 1，晚于它才生效的 sink 会让 v4 网关的连续排水从 seq 2 起永远等 seq 1。
    expect(constructIndex).toBeLessThan(persistIndex);
    // 落会话行 → 建 link（FK 顺序）→ 才允许第一个 turn 起跑。
    expect(persistIndex).toBeLessThan(linkIndex);
    expect(linkIndex).toBeLessThan(turnIndex);
  });

  it("dwf_actor.session_id 收到 driver 铸的会话 id", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("actor-journal"),
    });
    await settle(harness, runId);

    const actors = harness.journal.listActors(runId, { withPersona: true });
    expect(actors).toHaveLength(1);
    expect(actors[0]!.sessionId).toBe(harness.actorRuntimeInputs[0]!.sessionId);
  });

  // 旧方案 `wf-actor-${refToString(actor)}` 不含 runId，并发两个 run 的同 site×ordinal
  // actor 会撞成同一个会话 id。
  it("并发两个 run 的同 site×ordinal actor 不撞会话 id", async () => {
    const harness = makeHarness();
    const [first, second] = await Promise.all([
      submitRun(harness, {
        cwd: TEST_CWD,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("collide-a"),
      }),
      submitRun(harness, {
        cwd: TEST_CWD,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("collide-b"),
      }),
    ]);
    await Promise.all([settle(harness, first), settle(harness, second)]);

    expect(first).not.toBe(second);
    const sessionIds = harness.actorRuntimeInputs.map((input) => input.sessionId);
    expect(sessionIds).toHaveLength(2);
    expect(new Set(sessionIds).size).toBe(2);
  });
});

describe("dynamic workflow run service — cancellation", () => {
  it("cancel 使 run 结算为 cancelled 而不是 failed，且保留已完结 journal 条目", async () => {
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("cancel-run"),
    });

    // 等 actor 会话建起来（说明 ask 已派发、turn 在飞），再取消。
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });

    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    const snapshot = await harness.service.getTask(runId);
    // 失败绝不编码成停止，停止也绝不编码成失败：journal 里两者语义与 resume UX 不同。
    // 快照基类的 status 是后台任务追踪器的通用词汇（stopped → cancelled）；真实词在 runStatus。
    expect(snapshot?.status).toBe("cancelled");
    expect(snapshot?.runStatus).toBe("stopped");
    expect(snapshot?.stopReason).toBe("user");
    expect(harness.journal.getRun(runId)?.status).toBe("stopped");
    expect(harness.journal.getRun(runId)?.stopReason).toBe("user");

    // 已落库的 actor 记录保留（取消的 run 可 resume）。
    expect(harness.journal.listActors(runId, { withPersona: true })).toHaveLength(1);
  });

  it("未知 run 的 cancel 返回 false", async () => {
    const harness = makeHarness();
    expect(await harness.service.cancel("dwfrun-does-not-exist")).toBe(false);
  });

  it("已结算 run 的 cancel 返回 false", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("cancel-settled"),
    });
    await settle(harness, runId);

    expect(await harness.service.cancel(runId)).toBe(false);
  });
});

/**
 * 关闭（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Engine ownership」规则二）。
 *
 * 引擎是本 App 的闭包，App 一关它就没了宿主。所以关闭要主动停：以 `"interrupted"` abort 每个
 * 在飞条目并等结算，那一笔**由引擎自己写**（updateRunStatus + run-settled + driver dispose），
 * service 一个字都不补——绕过引擎写就会造出 dwf_run 的第二个写入者。
 */
describe("dynamic workflow run service — close（Engine ownership 规则二）", () => {
  /** journal 里该 run 目前的最大事件 sequence；用来证明「关闭之后不再有事件」。 */
  function maxSequence(harness: Harness, runId: string): number {
    return harness.journal
      .listEvents(runId, { types: "all", reportItems: "all" })
      .reduce((max, entry) => Math.max(max, entry.sequence), 0);
  }

  it("close 停下在飞 run：行为 stopped(interrupted) + Interrupted，且由引擎写下", async () => {
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("close-live"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });
    expect(harness.service.countLiveRuns()).toBe(1);

    await harness.service.close();

    // close 解析时结算已经完成：不需要再等 waitForTask。
    expect(harness.service.countLiveRuns()).toBe(0);
    const record = harness.journal.getRun(runId);
    expect(record?.status).toBe("stopped");
    // interrupted 而不是 user：UI 上 user 读作「用户按了停止」，而这是宿主替它停的。
    expect(record?.stopReason).toBe("interrupted");
    expect(record?.failure?.code).toBe("Interrupted");
    expect(record?.failure?.message).toContain("the owning session closed");
    expect(record?.failure?.message).toContain(runId);

    // 条目终态已就位，快照按 stopped 讲（可 resume）。
    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.runStatus).toBe("stopped");
    expect(snapshot?.stopReason).toBe("interrupted");

    // 引擎自己那一笔：journal 里有 run-settled，而不是 service 补写的一行裸状态。
    const settled = harness.journal
      .listEvents(runId, { types: "all", reportItems: "all" })
      .filter(({ event }) => event.type === "run-settled");
    expect(settled).toHaveLength(1);

    // 关闭之后 journal 不再长：结算写在 close 解析之前，之后没有任何落后的事件。
    const sequenceAtClose = maxSequence(harness, runId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(maxSequence(harness, runId)).toBe(sequenceAtClose);
  });

  it("close 等结算：在飞 run 未结算前 close 不解析", async () => {
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("close-awaits"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });

    let settledFirst: string | undefined;
    const unsubscribe = harness.service.subscribeRunSettled((notice) => {
      settledFirst ??= `settled:${notice.runId}`;
    });
    let resolved = false;
    const closing = harness.service.close().then(() => {
      resolved = true;
    });
    // 结算靠真实的 abort → 引擎 stop → finishRun 链路，不是一个微任务就能走完。
    expect(resolved).toBe(false);
    await closing;
    expect(resolved).toBe(true);
    // 结算通知先于 close 解析：close 等的正是那条链路的末端。
    expect(settledFirst).toBe(`settled:${runId}`);
    unsubscribe();
  });

  it("关闭之后 submit / amend / resume 抛接线错误（而不是结构化拒绝）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("close-refuses"),
    });
    await settle(harness, runId);
    await harness.service.close();

    await expect(
      harness.service.submit({
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("close-refuses-submit"),
      }),
    ).rejects.toThrow(/service is closed/);
    await expect(harness.service.resume!(runId)).rejects.toThrow(/service is closed/);
    await expect(
      harness.service.amend!({
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        predecessorRunId: runId,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("close-refuses-amend"),
      }),
    ).rejects.toThrow(/service is closed/);
  });

  it("零在飞 run 时 close 直接解析；第二次 close 返回同一个 promise，不再 abort", async () => {
    const harness = makeHarness();
    const first = harness.service.close();
    const second = harness.service.close();
    // 幂等靠记住 promise，而不是靠再走一遍关闭流程。
    expect(second).toBe(first);
    await first;
    const closing = harness.logs.filter(
      (entry) => entry.context?.event === "dynamic_workflow.service.closing",
    );
    expect(closing).toHaveLength(1);
    expect(closing[0]?.context?.liveRunCount).toBe(0);
  });
});

/**
 * 外来终态行（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Engine ownership」规则三）。
 *
 * Bug 根因（2026-09-04 / 2026-09-15）：第二个桌面实例冷恢复了同一个会话，它的孤儿收敛在本进程
 * 引擎**仍然活着**的 run 上写下终态行。本进程照单全收：追踪器拿到终态快照、通知模型 run 已
 * 结束、把任务标完，真正的完成随后被丢弃，而行以 completed 收场却还带着那份陈旧失败。
 *
 * 装配用升级问答把 run 停在一个真活着的节点上（escalate 不终止 turn，答完继续干活），
 * 因此同一个 run 既能被观察，也能被放行跑到 completed。
 */
describe("dynamic workflow run service — 外来终态行（Engine ownership 规则三）", () => {
  const FOREIGN_FAILURE = { code: "Interrupted" as const, message: "owning process exited" };

  /** 起一个 run 并停在升级问答上；回 runId 与 qid。 */
  async function parkedRun(
    harness: Harness,
    name: string,
  ): Promise<{ runId: string; qid: string }> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor(name),
    });
    await vi.waitFor(async () => {
      expect((await harness.service.getTask(runId))?.pendingQuestions).toHaveLength(1);
    });
    const qid = (await harness.service.getTask(runId))?.pendingQuestions?.[0]?.qid;
    if (qid === undefined) throw new Error("停驻的问题没有出现在快照里");
    return { runId, qid };
  }

  function parkedHarness(answer: string, journal?: JournalStorePort): Harness {
    return makeHarness({
      actorScripts: {
        "actor#1@1": [
          { kind: "escalate", question: "外来写入期间先停在这里" },
          { kind: "submit", result: { text: answer } },
        ],
      },
      ...(journal === undefined ? {} : { journal }),
    });
  }

  // 走真库：四条读面里有两条（listRuns / getRunDetail）靠能力探测接上，替身里没有它们；
  // 而这条用例要证的正是**四条读面同一个答案**。
  it("四条读面都忽略活条目下的外来终态行，警告每个条目只记一次", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = parkedHarness("真正的结果", journal);
      const { runId } = await parkedRun(harness, "foreign-row");

      // 第二个实例的孤儿收敛：直接在 journal 上写终态行，本进程的注册表毫不知情。
      harness.journal.updateRunStatus(runId, "stopped", {
        stopReason: "interrupted",
        failure: FOREIGN_FAILURE,
      });
      expect(harness.journal.getRun(runId)?.status).toBe("stopped");

      // (1) 快照：仍然在跑，三个终态字段一个都不出。
      const snapshot = await harness.service.getTask(runId);
      expect(snapshot?.status).toBe("running");
      expect(snapshot).not.toHaveProperty("runStatus");
      expect(snapshot).not.toHaveProperty("stopReason");
      expect(snapshot).not.toHaveProperty("failure");
      expect(snapshot).not.toHaveProperty("error");

      // (2) 列表与 (3) 详情：与快照同一个答案（三处分叉比三处都错更难查）。
      const introspection = introspectionOf(harness);
      const { runs: listed } = await introspection.listRuns({ cwd: TEST_CWD, limit: 20 });
      const row = listed.find((item) => item.runId === runId);
      expect(row?.status).toBe("running");
      expect(row).not.toHaveProperty("stopReason");
      const detail = await introspection.getRunDetail(runId);
      expect(detail?.status).toBe("running");
      expect(detail).not.toHaveProperty("stopReason");
      expect(detail).not.toHaveProperty("error");
      expect(detail).not.toHaveProperty("result");

      // (4) 会话枚举面（它自己没有注册表，靠 service 把条目递进去）。
      const sessionRows = await harness.service.listRunsForSession(20);
      const sessionRow = sessionRows.find((item) => item.runId === runId);
      expect(sessionRow?.status).toBe("running");
      expect(sessionRow).not.toHaveProperty("stopReason");
      expect(sessionRow).not.toHaveProperty("failureCode");
      expect(sessionRow?.resumable).toBe(false);

      // 留痕但不刷屏：追踪器每秒轮询，警告每个条目只记一次。
      await harness.service.getTask(runId);
      await harness.service.getTask(runId);
      const warns = harness.logs.filter(
        (entry) => entry.context?.event === "dynamic_workflow.run.foreign_terminal_row",
      );
      expect(warns).toHaveLength(1);
      expect(warns[0]?.context).toMatchObject({
        journalStatus: "stopped",
        runId,
        stopReason: "interrupted",
      });

      // 收尾：让 run 真的结束，别把一个在飞引擎留给下一条用例。
      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("引擎自己的结算改写那一行：completed 且不带陈旧失败", async () => {
    const harness = parkedHarness("真正的结果");
    const { runId, qid } = await parkedRun(harness, "foreign-row-then-settle");
    harness.journal.updateRunStatus(runId, "stopped", {
      stopReason: "interrupted",
      failure: FOREIGN_FAILURE,
    });

    // 放行：actor 拿到答案继续干活并提交。
    expect(await harness.service.resolveQuestion(qid, "继续")).toMatchObject({ ok: true });
    await settle(harness, runId);

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.runStatus).toBe("completed");
    expect(snapshot?.output).toBe("真正的结果");
    expect(snapshot).not.toHaveProperty("failure");
    // 存储侧的另一半（journal 契约的「clears a stale failure…」）：completed 的行不带失败。
    const record = harness.journal.getRun(runId);
    expect(record?.status).toBe("completed");
    expect(record?.failure).toBeUndefined();
    expect(record?.stopReason).toBeUndefined();
  });

  it("外来终态行期间 waitForTask 仍然等真正的结算", async () => {
    const harness = parkedHarness("等到了");
    const { runId, qid } = await parkedRun(harness, "foreign-row-wait");
    harness.journal.updateRunStatus(runId, "stopped", {
      stopReason: "interrupted",
      failure: FOREIGN_FAILURE,
    });

    let resolved = false;
    const waiting = harness.service.waitForTask(runId).then((snapshot) => {
      resolved = true;
      return snapshot;
    });
    // 行已经是终态，但等的是条目的结算 promise——它还没有兑现。
    await Promise.resolve();
    expect(resolved).toBe(false);

    expect(await harness.service.resolveQuestion(qid, "继续")).toMatchObject({ ok: true });
    expect((await waiting)?.status).toBe("completed");
    expect(resolved).toBe(true);
  });
});

describe("dynamic workflow run service — observation", () => {
  it("未知 run 的 getTask 返回 undefined", async () => {
    const harness = makeHarness();
    expect(await harness.service.getTask("dwfrun-unknown")).toBeUndefined();
  });

  // submit 返回后追踪器会立刻轮询，而 dwf_run 行要等引擎构造。这一刻快照必须是 running，
  // 否则第一次轮询就把刚启动的 run 判成 lost。
  it("submit 刚返回时快照已是 running", async () => {
    const harness = makeHarness({ hangActors: true });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("snapshot-immediate"),
    });

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("running");
    expect(snapshot?.runId).toBe(runId);

    await harness.service.cancel(runId);
    await settle(harness, runId);
  });

  // 桌面实测 bug 的重启恢复面：进程重启后注册表为空，快照只能由 journal 记录合成。
  // completed 记录带 result 时必须把它当 output 回出来，否则 TaskOutput 在重启后永远拿不到产物。
  it("重启恢复：注册表为空时 completed 记录的 result 作为 output 回出", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, { runId: "dwfrun-restart", status: "running" });
    journal.updateRunStatus("dwfrun-restart", "completed", {
      result: { report: "final answer", steps: 3 },
    });
    const harness = makeHarness({ journal });

    const snapshot = await harness.service.getTask("dwfrun-restart");
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.output).toEqual({ report: "final answer", steps: 3 });
  });

  it("重启恢复：非 record 产物（字符串）同样回出", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, { runId: "dwfrun-restart-string", status: "running" });
    journal.updateRunStatus("dwfrun-restart-string", "completed", { result: "plain answer" });
    const harness = makeHarness({ journal });

    expect((await harness.service.getTask("dwfrun-restart-string"))?.output).toBe("plain answer");
  });

  it("重启恢复：completed 但记录无 result 时 output 缺席", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, { runId: "dwfrun-restart-empty", status: "running" });
    journal.updateRunStatus("dwfrun-restart-empty", "completed");
    const harness = makeHarness({ journal });

    const snapshot = await harness.service.getTask("dwfrun-restart-empty");
    expect(snapshot?.status).toBe("completed");
    expect(snapshot && "output" in snapshot).toBe(false);
  });

  it("重启恢复：failed 记录不回 output", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, { runId: "dwfrun-restart-failed", status: "running" });
    journal.updateRunStatus("dwfrun-restart-failed", "errored", {
      failure: { code: "DriverError", message: "script threw" },
    });
    const harness = makeHarness({ journal });

    const snapshot = await harness.service.getTask("dwfrun-restart-failed");
    expect(snapshot?.status).toBe("failed");
    expect(snapshot?.runStatus).toBe("errored");
    expect(snapshot && "output" in snapshot).toBe(false);
    expect(snapshot?.error).toBe("script threw");
  });

  // ── 终态快照携带渐进产物（完成通知的数据源）──
  //
  // 条目取自 journal 的 kind="report" 行，而不是 memory-only 的 workflowRuns 投影：那是这些
  // 条目的持久家，重启后依然在。通知因此在 failed / cancelled 上也能捞回半途的产物。

  function preloadReports(journal: JournalStorePort, runId: string, items: unknown[]): void {
    items.forEach((item, index) => {
      journal.putNode({
        runId,
        siteId: "report#1",
        ordinal: index + 1,
        kind: "report",
        inputHash: `hash-${index}`,
        status: "completed",
        result: item,
      });
    });
  }

  it("终态快照带 journal 里的 report 条目，按报告顺序", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, { runId: "dwfrun-reports", status: "running" });
    preloadReports(journal, "dwfrun-reports", ["first finding", { file: "a.ts" }]);
    journal.updateRunStatus("dwfrun-reports", "completed", { result: "done" });
    const harness = makeHarness({ journal });

    const snapshot = await harness.service.getTask("dwfrun-reports");
    expect(snapshot?.reports).toEqual(["first finding", { file: "a.ts" }]);
    expect(snapshot?.output).toBe("done");
  });

  it("失败与取消的 run 一样带 reports（这条是 report 特性的目的）", async () => {
    for (const [status, taskStatus] of [
      ["errored", "failed"],
      ["stopped", "cancelled"],
    ] as const) {
      const journal = new SweepableJournalStore();
      const runId = `dwfrun-reports-${status}`;
      preloadRun(journal, { runId, status: "running" });
      preloadReports(journal, runId, ["finding before the end"]);
      journal.updateRunStatus(journal.getRun(runId)!.runId, status, {
        ...(status === "stopped" ? { stopReason: "user" as const } : {}),
        failure: { code: "DriverError", message: "boom" },
      });
      const harness = makeHarness({ journal });

      const snapshot = await harness.service.getTask(runId);
      expect(snapshot?.status).toBe(taskStatus);
      expect(snapshot?.runStatus).toBe(status);
      expect(snapshot?.reports).toEqual(["finding before the end"]);
    }
  });

  it("ask / world-read 节点不混进 reports；零条时字段整个缺席", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, { runId: "dwfrun-reports-mixed", status: "running" });
    journal.putNode({
      runId: "dwfrun-reports-mixed",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "hash-ask",
      status: "completed",
      result: "an ask result, not a report",
    });
    journal.updateRunStatus("dwfrun-reports-mixed", "completed");
    const harness = makeHarness({ journal });

    const snapshot = await harness.service.getTask("dwfrun-reports-mixed");
    expect(snapshot?.status).toBe("completed");
    // 缺席而不是空数组：通知端据此让整节 <reports> 消失，不发空节。
    expect(snapshot && "reports" in snapshot).toBe(false);
  });

  /**
   * 在飞时不读：`getTask` 会被后台追踪器反复轮询，而 `listNodes` 是一次全表扫。唯一的消费者
   * 是终态通知，运行中读它没有读者、只有成本。
   */
  it("running 的快照不读 report 节点（避免每次轮询扫全表）", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, { runId: "dwfrun-reports-running", status: "running" });
    preloadReports(journal, "dwfrun-reports-running", ["mid-run finding"]);
    const harness = makeHarness({ journal });
    const listNodes = vi.spyOn(journal, "listNodes");

    const snapshot = await harness.service.getTask("dwfrun-reports-running");
    expect(snapshot?.status).toBe("running");
    expect(snapshot && "reports" in snapshot).toBe(false);
    expect(listNodes).not.toHaveBeenCalled();
  });

  // 内存终态优先：本进程刚结算的 run 以引擎交回的 artifact 为准，不退回 journal 记录。
  it("内存终态的 artifact 优先于 journal 记录的 result", async () => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({ journal });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("in-memory-wins"),
    });
    await settle(harness, runId);
    // journal 侧被改写成另一个值；内存终态仍然是权威。
    journal.updateRunStatus(runId, "completed", { result: "journal-side value" });

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.output).toBe("done");
  });

  it("listEvents 按 cursor 分页且越界返回空页", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("list-events"),
    });
    await settle(harness, runId);

    const { events: all, hasMore: allHasMore } = await harness.service.listEvents(runId, {});
    expect(allHasMore).toBe(false);
    expect(all.length).toBeGreaterThan(0);
    // sequence 单调，payload 是事件对象去掉 type 后的其余字段。
    expect(all[0]!.type).toBe("run-started");
    expect(all[0]!.payload).toMatchObject({ runId });
    expect(all.map((event) => event.sequence)).toEqual(
      [...all.map((event) => event.sequence)].sort((a, b) => a - b),
    );

    const { events: firstPage, hasMore } = await harness.service.listEvents(runId, { limit: 2 });
    expect(firstPage).toHaveLength(2);
    expect(hasMore).toBe(true);
    const { events: secondPage } = await harness.service.listEvents(runId, {
      afterSequence: firstPage[1]!.sequence,
      limit: 2,
    });
    // 页边界不重不漏。
    expect(secondPage[0]!.sequence).toBeGreaterThan(firstPage[1]!.sequence);

    const beyond = await harness.service.listEvents(runId, {
      afterSequence: all[all.length - 1]!.sequence + 1000,
    });
    expect(beyond).toEqual({ events: [], hasMore: false });
  });

  it("listEvents 不给 limit 时一页 500 条（事件日志从不一次读完）", async () => {
    // docs/execution-engine.md「Reading the journal」：v4 workflowRunEvents 的 limit 是可选的，
    // 缺省曾经意味着整条事件日志一次读完——一个报满 report 的 run 是 GiB 量级的 item。
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("list-events-page-cap"),
    });
    await settle(harness, runId);
    for (let i = 0; i < 600; i += 1) {
      harness.journal.appendEvent(runId, { type: "log", message: `line ${i}` });
    }

    const page = await harness.service.listEvents(runId, {});
    expect(page.events).toHaveLength(500);
    expect(page.hasMore).toBe(true);
    // 显式 limit 原样尊重（v4 网关已按 schema 钳过）。
    const asked = await harness.service.listEvents(runId, { limit: 501 });
    expect(asked.events).toHaveLength(501);
    const small = await harness.service.listEvents(runId, { limit: 3 });
    expect(small.events).toHaveLength(3);
  });

  it("journal 能按字节翻页时，listEvents 走它并带上协议的两道缺省界", async () => {
    // 字节界只有 SQLite 的 listEventPage 兑现得了（它从行头读载荷长度，不读载荷）；
    // 调用方不给界时，服务按协议上限给全两者，hasMore 原样取存储层的判定。
    const calls: Array<{ afterSequence?: number; limit: number; maxBytes: number }> = [];
    class PagingJournal extends SweepableJournalStore {
      listEventPage(
        runId: string,
        query: { afterSequence?: number; limit: number; maxBytes: number },
      ) {
        calls.push(query);
        const events = this.listEvents(runId, { types: "all", reportItems: "all" }).slice(0, 1);
        return { events, hasMore: true };
      }
    }
    const harness = makeHarness({ journal: new PagingJournal() });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("list-events-byte-pages"),
    });
    await settle(harness, runId);

    const page = await harness.service.listEvents(runId, {});
    expect(calls).toEqual([
      {
        limit: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
        maxBytes: WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
      },
    ]);
    expect(page.events).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it("run 事件经 onRunEvent 钩子扇出", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("run-events"),
    });
    await settle(harness, runId);

    expect(harness.runEvents.every((event) => event.runId === runId)).toBe(true);
    const types = harness.runEvents.map((event) => event.eventType);
    expect(types).toContain("run-started");
    expect(types).toContain("run-settled");
  });

  // ── 进度投影的接缝（docs/dynamic-workflow/presentation.md「The run state the pane draws」）──
  // 钩子交出的是**已经准备好的会话事件载荷**：journal sequence、有界载荷、以及两个
  // Boundary C 上不存在的派生字段。create-app 只负责把它追加到父会话。

  it("钩子携带的 sequence 就是 journal sequence（与 listEvents 同一把尺）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      toolCallId: createToolCallId(),
      trace: traceFor("run-progress-sequence"),
    });
    await settle(harness, runId);

    const { events: journalPage } = await harness.service.listEvents(runId, {});
    // 逐条对齐：同一条事件在两个消费者那里必须是同一个 sequence 与同一个种类。
    expect(harness.runEvents.map((event) => [event.sequence, event.eventType])).toEqual(
      journalPage.map((event) => [event.sequence, event.type]),
    );
    // 单调且从 0 起（appendEvent 的分配语义）。
    expect(harness.runEvents.map((event) => event.sequence)).toEqual(
      harness.runEvents.map((_, index) => index),
    );
  });

  it("actor-created 携带 actor 会话 id，且与 driver 真正使用的那个一致", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("run-progress-actor"),
    });
    await settle(harness, runId);

    const created = harness.runEvents.find((event) => event.eventType === "actor-created");
    // 这条断言是"确定性铸造"与"driver 实际铸造"之间的绊线：会话 id 是 phase 5 下钻的入口，
    // 两边一旦漂移，详情页会打开一个不存在的会话。
    expect(created?.actorSessionId).toBe(harness.actorRuntimeInputs[0]?.sessionId);
    expect(created?.actorSessionId).toContain(runId);
  });

  it("usage-updated 载荷自带已花 token，且等于 journal 列值（同一同步步骤产生）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("run-progress-usage"),
    });
    await settle(harness, runId);

    const usage = harness.runEvents.filter((event) => event.eventType === "usage-updated");
    expect(usage.length).toBeGreaterThan(0);
    const last = usage.at(-1)!;
    // docs/dynamic-workflow/authoring.md「Usage, not budget」：事件载荷与 dwf_run.spent_tokens 永远相等。
    expect(last.payload.spentTokens).toBe(harness.journal.getRun(runId)?.spentTokens);
    expect(last.payload.spentTokens).toBeGreaterThan(0);
    // 不再有派生字段：载荷就是引擎发的原样。
    expect("spentTokens" in last).toBe(false);
  });

  it("载荷有界：超长 persona system prompt 被截断并置 truncated", async () => {
    const harness = makeHarness();
    const longPrompt = "x".repeat(5_000);
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: [
        "interface Answer { text: string }",
        `const a = await agent("worker", ${JSON.stringify(longPrompt)}).ask<Answer>("go");`,
        "return a.text;",
      ].join("\n"),
      trace: traceFor("run-progress-bounds"),
    });
    await settle(harness, runId);

    const created = harness.runEvents.find((event) => event.eventType === "actor-created");
    const persona = created?.payload.persona as { system?: string } | undefined;
    expect(created?.truncated).toBe(true);
    expect(persona?.system?.length).toBe(DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength);
    // 同一次序列化也喂给 listEvents：两个消费者拿到同一份有界载荷。
    const { events: page } = await harness.service.listEvents(runId, {});
    const pageCreated = page.find((event) => event.type === "actor-created");
    expect((pageCreated?.payload.persona as { system?: string }).system?.length).toBe(
      DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength,
    );
    expect(pageCreated?.truncated).toBe(true);
  });

  it("终态事件永远落地：run-settled 是权威收口", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("run-progress-terminal"),
    });
    await settle(harness, runId);

    const settled = harness.runEvents.at(-1);
    expect(settled?.eventType).toBe("run-settled");
    expect(settled?.payload.status).toBe("completed");
  });

  it("钩子的 routing 携带 parentSessionId：事件必须落在发起该 run 的会话里", async () => {
    // 身份闸门的另一半在 createDynamicWorkflowRunProgressSink 里；这里证明 run service
    // 真的把身份交了出去（否则闸门只能靠"缺席即本会话"的宽松分支放行，形同没有闸门）。
    const harness = makeHarness();
    const parentSessionId = createSessionId("run-progress-routing-parent");
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("run-progress-routing"),
    });
    await settle(harness, runId);

    expect(harness.runEventRoutings.length).toBe(harness.runEvents.length);
    expect(new Set(harness.runEventRoutings.map((routing) => routing.parentSessionId))).toEqual(
      new Set([parentSessionId]),
    );
  });

  it("submit 未带 parentSessionId 时 routing 里就没有它（缺席，不是空串）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("run-progress-routing-absent"),
    });
    await settle(harness, runId);

    expect(harness.runEventRoutings.every((routing) => !("parentSessionId" in routing))).toBe(true);
  });

  it("钩子抛错不打挂 run（观察者边界吞异常）", async () => {
    const harness = makeHarness({
      onRunEvent: () => {
        throw new Error("hook blew up");
      },
    });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("run-progress-hook-throws"),
    });
    await settle(harness, runId);
    expect((await harness.service.getTask(runId))?.status).toBe("completed");
  });
});

describe("dynamic workflow run service — 孤儿 run 收敛", () => {
  // 桌面实测 bug（2026-08-19，dwfrun-734d1f9d）：run-started 之后进程被关掉，dwf_run 行
  // **永远停在 running**——getTask/waitForTask 对不在本进程注册表里的 run 直接回 journal
  // 快照，于是恢复会话后每个 journal 读面都被告知「还在跑」，永不自愈。收敛的时机是下一次
  // 这个父会话的 app 构造：那一刻本服务实例名下零个在飞 run，journal 里本会话的任何非终态行
  // 都只可能是死进程的遗物。
  it("构造时把本会话的非终态 run 收敛成 failed（interrupted 编码）", () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-running",
      status: "running",
    });
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-pending",
      status: "pending",
    });

    makeHarness({ journal });

    for (const runId of ["dwfrun-orphan-running", "dwfrun-orphan-pending"]) {
      const record = journal.getRun(runId);
      expect(record?.status).toBe("stopped");
      expect(record?.stopReason).toBe("interrupted");
      // 失败编码沿用引擎的 WorkflowErrorJson 形态，且 code 必须同时区别于「脚本真失败」
      // （harness 把脚本抛错编码成 DriverError）与「用户取消」（stopped(user)，可 resume）。
      expect(record?.failure?.code).toBe("Interrupted");
      expect(record?.failure?.message).toContain(runId);
    }
  });

  it("每个被收敛的 run 记一条 warn（带 runId）", () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-logged",
      status: "running",
    });

    const harness = makeHarness({ journal });

    const warnings = harness.logs.filter(
      (entry) => entry.level === "warn" && entry.context?.runId === "dwfrun-orphan-logged",
    );
    expect(warnings).toHaveLength(1);
  });

  it("本会话的终态 run 一律不动", () => {
    const journal = new SweepableJournalStore();
    for (const status of ["completed", "errored", "stopped"] as const) {
      preloadRun(journal, {
        parentSessionId: HARNESS_PARENT_SESSION,
        runId: `dwfrun-terminal-${status}`,
        status,
      });
    }

    makeHarness({ journal });

    for (const status of ["completed", "errored", "stopped"] as const) {
      const record = journal.getRun(`dwfrun-terminal-${status}`);
      expect(record?.status).toBe(status);
      // 终态行连失败原因都不许被补写：stopped 是「用户取消、可 resume」，不是 interrupted。
      expect(record?.failure).toBeUndefined();
    }
  });

  // 绝不全局清扫：run service 是 per-app（= per 父会话）构造的，同进程兄弟会话各有各的
  // 内存注册表、共用同一个 sqlite。不带 parentSessionId 的清扫会把别的会话**正在飞**的 run
  // 标死。父会话缺席的行同理不属于本会话。
  it("别的会话（以及无父会话）的非终态 run 不动", () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: createSessionId("sibling-session"),
      runId: "dwfrun-sibling-live",
      status: "running",
    });
    preloadRun(journal, { runId: "dwfrun-orphaned-parentless", status: "running" });

    makeHarness({ journal });

    expect(journal.getRun("dwfrun-sibling-live")?.status).toBe("running");
    expect(journal.getRun("dwfrun-orphaned-parentless")?.status).toBe("running");
  });

  it("构造后 submit 的 run 不受收敛影响", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-before-submit",
      status: "running",
    });
    const harness = makeHarness({ journal });

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("sweep-then-submit"),
    });
    await settle(harness, runId);

    expect((await harness.service.getTask(runId))?.status).toBe("completed");
    expect(journal.getRun(runId)?.failure).toBeUndefined();
    expect(journal.getRun("dwfrun-orphan-before-submit")?.status).toBe("stopped");
  });

  // 这条就是 bug 的用户可见面：journal 快照回什么，恢复会话后的 TaskOutput 就显示什么。
  it("getTask 对被收敛的 run 回 stopped(interrupted) 并带失败原因", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-snapshot",
      status: "running",
    });
    const harness = makeHarness({ journal });

    const snapshot = await harness.service.getTask("dwfrun-orphan-snapshot");
    // 追踪器词汇：stopped → cancelled；真实词与原因在 runStatus / stopReason 上。
    expect(snapshot?.status).toBe("cancelled");
    expect(snapshot?.runStatus).toBe("stopped");
    expect(snapshot?.stopReason).toBe("interrupted");
    expect(snapshot?.failure?.code).toBe("Interrupted");
    expect(snapshot?.error).toContain("dwfrun-orphan-snapshot");
  });

  // 不合成 dwf_event：事件日志的契约是「引擎发过什么」，状态权威在 run 行上。
  // run-settled 是引擎的收口，不是清扫者的。
  it("收敛不给事件日志添任何一条事件", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-events",
      status: "running",
    });
    journal.appendEvent("dwfrun-orphan-events", {
      caps: { maxConcurrency: 4 },
      runId: "dwfrun-orphan-events",
      type: "run-started",
    });

    const harness = makeHarness({ journal });

    const { events } = await harness.service.listEvents("dwfrun-orphan-events", {});
    expect(events.map((event) => event.type)).toEqual(["run-started"]);
  });

  it("二次构造幂等：没有可收敛项时一次写入都没有", () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-orphan-idempotent",
      status: "running",
    });

    makeHarness({ journal });
    expect(journal.getRun("dwfrun-orphan-idempotent")?.status).toBe("stopped");

    const updateRunStatus = vi.spyOn(journal, "updateRunStatus");
    makeHarness({ journal });
    expect(updateRunStatus).not.toHaveBeenCalled();
  });

  // journal 实现不带窄查询时不能崩、也不能假装收敛过：跳过并记下原因（可见降级）。
  it("journal 不带窄查询时跳过收敛并记原因", () => {
    const journal = new InMemoryJournalStore();
    preloadRun(journal, {
      parentSessionId: HARNESS_PARENT_SESSION,
      runId: "dwfrun-no-query",
      status: "running",
    });

    const harness = makeHarness({ journal });

    expect(journal.getRun("dwfrun-no-query")?.status).toBe("running");
    expect(
      harness.logs.some((entry) => JSON.stringify(entry.context ?? {}).includes("non_terminal")),
    ).toBe(true);
  });

  // 生产接线的绊线。窄查询是**能力探测**出来的（它不在引擎的 JournalStorePort 上），所以
  // 方法名或签名一旦漂移，不会有任何编译错误——只会让收敛静默跳过，退回「孤儿 run 永远
  // running」那个 bug。这条用例因此走真实的 sqlite session store，即生产那条
  // resolveDynamicWorkflowJournalStore 路径。
  it("真实 sqlite journal 上收敛生效，且只碰本会话", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-sweep-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    try {
      const journal = resolveDynamicWorkflowJournalStore(store as never);
      expect(journal).toBeDefined();

      preloadRun(journal!, {
        parentSessionId: HARNESS_PARENT_SESSION,
        runId: "dwfrun-sqlite-orphan",
        status: "running",
      });
      preloadRun(journal!, {
        parentSessionId: createSessionId("sqlite-sibling"),
        runId: "dwfrun-sqlite-sibling",
        status: "running",
      });
      journal!.appendEvent("dwfrun-sqlite-orphan", {
        caps: { maxConcurrency: 4 },
        runId: "dwfrun-sqlite-orphan",
        type: "run-started",
      });

      const harness = makeHarness({ journal: journal! });

      const reconciled = journal!.getRun("dwfrun-sqlite-orphan");
      expect(reconciled?.status).toBe("stopped");
      expect(reconciled?.stopReason).toBe("interrupted");
      expect(reconciled?.failure?.code).toBe("Interrupted");
      expect(journal!.getRun("dwfrun-sqlite-sibling")?.status).toBe("running");
      // 状态权威在 run 行上，事件日志仍然只有引擎发过的那一条。
      expect((await harness.service.listEvents("dwfrun-sqlite-orphan", {})).events).toHaveLength(1);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

// ————————————————————————————————————————————————————————————————
// run 内省（listRuns / getRunDetail）
// 见 docs/dynamic-workflow/launch.md
// ————————————————————————————————————————————————————————————————

/**
 * 本项目的 cwd 与"别的项目"的 cwd（cwd 是字面等值匹配的项目键）。
 *
 * 必须是**真实存在的目录**：真跑起来的 run 会以它作为沙箱子进程的 cwd，不存在的路径让
 * spawn 直接失败、run 结算 failed——那时被测的就不是真相合成了。（这一条是写这些用例时
 * 真实踩到的：原先用两个字面量假路径，在飞用例里的 run 全部变成 failed。）
 */
let projectCwd = "";
let otherCwd = "";
let introspectCwdRoot = "";

beforeAll(async () => {
  introspectCwdRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-cwd-"));
  projectCwd = join(introspectCwdRoot, "project");
  otherCwd = join(introspectCwdRoot, "other");
  await mkdir(projectCwd, { recursive: true });
  await mkdir(otherCwd, { recursive: true });
});

afterAll(async () => {
  await rm(introspectCwdRoot, { force: true, recursive: true });
});

/**
 * 真实 sqlite journal 上跑内省用例。
 *
 * 这一族**必须走真库**：四条内省查询不在引擎的 JournalStorePort 上，是靠能力探测接上的，
 * 在替身里用 JS 重写它们等于把被测语义换成复制品——而漂移的症状恰恰是「能力静默缺席」或
 * 「计数/尾巴看起来对但 SQL 是另一回事」。查询自身的语义（cwd 下推、排序、limit 钳制）在
 * `adapters/tests/dwf-journal-store.test.ts` 里对真库钉住；这里钉的是 service 侧的**真相合成**。
 */
async function withSqliteJournal(
  run: (journal: JournalStorePort & DwfRunIntrospectionQueries) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-introspect-"));
  const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
  try {
    const journal = resolveDynamicWorkflowJournalStore(store as never);
    expect(journal).toBeDefined();
    await run(journal as JournalStorePort & DwfRunIntrospectionQueries);
  } finally {
    store.close();
    await rm(tempRoot, { force: true, recursive: true });
  }
}

/** 端口的两个可选成员：能力在场时必须实现，缺席即用例失败（而不是静默跳过断言）。 */
function introspectionOf(harness: Harness): {
  getRunDetail: (runId: string) => Promise<DynamicWorkflowRunDetail | undefined>;
  listRuns: (query: DynamicWorkflowRunListQuery) => Promise<DynamicWorkflowRunListResult>;
} {
  const { getRunDetail, listRuns } = harness.service;
  return { getRunDetail: getRunDetail!, listRuns: listRuns! };
}

/**
 * 把若干 runId 从**读面**藏起来的转发层：模拟 submit → createRun 的微任务间隙（注册表已有
 * 条目、journal 还没有行）。
 *
 * 为什么是"藏读"而不是"扣住写"：dwf_event / dwf_node 都对 dwf_run(id) 有 FK，真扣住 createRun
 * 会让引擎的第一条 run-started 事件插入失败、run 直接变成 failed——那测的就不是间隙了。藏读
 * 造出的正是间隙里 service 能看到的状态：注册表命中、`getRun` 与 `listRuns` 都不认识它。
 *
 * 逐方法显式转发（不用展开）：两个 journal 实现都是 class，`{...journal}` 只拷自有属性，
 * 原型上的方法会全部丢掉（createJournalSequenceCapture 的同一条论证）。
 */
function hideRunsFromReads(
  journal: JournalStorePort & DwfRunIntrospectionQueries,
  hidden: ReadonlySet<string>,
): JournalStorePort & DwfRunIntrospectionQueries {
  return {
    createRun: (record) => journal.createRun(record),
    getRun: (runId) => (hidden.has(runId) ? undefined : journal.getRun(runId)),
    updateRunStatus: (runId, status, settlement) =>
      journal.updateRunStatus(runId, status, settlement),
    updateRunUsage: (runId, spentTokens) => journal.updateRunUsage(runId, spentTokens),
    updateRunCaps: (runId, caps) => journal.updateRunCaps(runId, caps),
    putActor: (record) => journal.putActor(record),
    getActor: (runId, siteId, ordinal) => journal.getActor(runId, siteId, ordinal),
    listActors: (runId, opts) => journal.listActors(runId, opts),
    putNode: (record) => journal.putNode(record),
    getNode: (runId, siteId, ordinal, opts) => journal.getNode(runId, siteId, ordinal, opts),
    listNodes: (runId, opts) => journal.listNodes(runId, opts),
    countNodes: (runId, kind) => journal.countNodes(runId, kind),
    appendEvent: (runId, event) => journal.appendEvent(runId, event),
    listEvents: (runId, opts) => journal.listEvents(runId, opts),
    countNodesByStatus: (runId) => journal.countNodesByStatus(runId),
    getRunRow: (runId) => (hidden.has(runId) ? undefined : journal.getRunRow(runId)),
    listRecentLogEvents: (runId, limit) => journal.listRecentLogEvents(runId, limit),
    listRuns: (query) => journal.listRuns(query).filter((row) => !hidden.has(row.runId)),
    // 产物读面（迁移 0029 之后 DwfRunIntrospectionQueries 的两条新查询）。这里必须**逐条
    // 转发**而不能展开 `...journal`：两个 journal 实现都是 class，展开只拷自有属性、原型上的
    // 方法会整片丢掉。hidden 不参与——这个替身只藏 run 行，产物按 runId 取数，被藏的 run
    // 本就取不到自己的行。
    listArtifactRows: (runId) => journal.listArtifactRows(runId),
    countTaggedReports: (runId) => journal.countTaggedReports(runId),
    listArtifactItems: (runId, artifactId, query) =>
      journal.listArtifactItems(runId, artifactId, query),
    listEventPage: (runId, query) => journal.listEventPage(runId, query),
  };
}

describe("dynamic workflow run service — run name 落库", () => {
  // input.name 此前只活在工具行与任务标题的兜底链上，不落 dwf_run，于是跨会话枚举出来的
  // run 只能是一串裸 runId。这条钉的是 submit → EngineConfig → createRun 的整条路。
  it("submit 带 name → dwf_run.name 落库", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      name: "nightly triage",
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-name"),
    });
    await settle(harness, runId);

    expect(harness.journal.getRun(runId)?.name).toBe("nightly triage");
  });

  it("未命名的 submit 不写 name（键缺席，读侧走脚本首行兜底）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("submit-no-name"),
    });
    await settle(harness, runId);

    expect("name" in harness.journal.getRun(runId)!).toBe(false);
  });
});

describe("dynamic workflow run service — 内省能力探测", () => {
  // 「没有 run」与「没有能力」必须可分辨：journal 不带内省查询时两个可选成员**整个缺席**，
  // 工具层的 typeof 探测据此回业务失败，而不是一个看起来"这个项目没跑过 workflow"的空列表。
  it("journal 不带内省查询时两个可选成员缺席", () => {
    const harness = makeHarness({ journal: new InMemoryJournalStore() });
    expect(harness.service.listRuns).toBeUndefined();
    expect(harness.service.getRunDetail).toBeUndefined();
  });
});

describe("dynamic workflow run service — listRuns 真相合成", () => {
  it("本会话在飞的 run：running、归本会话、不标 possiblyInterrupted", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ hangActors: true, journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        name: "in flight",
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("list-in-flight"),
      });
      await vi.waitFor(() => {
        expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
      });

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        label: "in flight",
        labelSource: "name",
        ownedByThisSession: true,
        runId,
        status: "running",
      });
      // 在飞的 run 绝不能被标成「可能已中断」——那是列表面对模型说谎的第一种方式。
      expect("possiblyInterrupted" in runs[0]!).toBe(false);

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  // 注册表命中即归属，**哪怕 journal 行记着另一个会话**。这一档正是 possiblyInterrupted 不该
  // 误标的那一档：同进程的兄弟会话共用一个 sqlite，各有各的注册表。
  it("注册表命中即归本会话，即使 journal 行记的是别的会话", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ hangActors: true, journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: createSessionId("some-other-session"),
        scriptText: TYPED_SCRIPT,
        trace: traceFor("list-registry-owned"),
      });
      await vi.waitFor(() => {
        expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
      });

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs[0]).toMatchObject({ ownedByThisSession: true, runId, status: "running" });
      expect("possiblyInterrupted" in runs[0]!).toBe(false);

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  // 状态优先级的第一档：内存终态 > journal 状态。内存里的结算是本进程刚从引擎手里接过的，
  // journal 行可能还没写完（或被别的东西改过）。
  it("内存终态优先于 journal 状态", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("list-memory-wins"),
      });
      await settle(harness, runId);
      // 人为把 journal 行拨回非终态，制造两个真相源的分歧。
      journal.updateRunStatus(runId, "running");

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs[0]).toMatchObject({ runId, status: "completed" });
      // 归本会话 + 有内存终态 ⇒ 无论 journal 说什么都不该带这个疑虑。
      expect("possiblyInterrupted" in runs[0]!).toBe(false);
    });
  });

  it("他会话的非终态 run 标 possiblyInterrupted 且不归本会话", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        cwd: projectCwd,
        parentSessionId: createSessionId("sibling-session"),
        runId: "dwfrun-sibling-running",
        status: "running",
      });

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs[0]).toMatchObject({
        ownedByThisSession: false,
        possiblyInterrupted: true,
        runId: "dwfrun-sibling-running",
        status: "running",
      });
      // 只标注、绝不改写：journal 行必须还是 running（替兄弟会话在飞的 run 收尸 = 把活着的
      // run 标死；孤儿收敛的执行权只属于 owning 会话的构造时刻）。
      expect(journal.getRun("dwfrun-sibling-running")?.status).toBe("running");
    });
  });

  it("他会话的终态 run 不标 possiblyInterrupted", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      for (const status of ["completed", "errored", "stopped"] as const) {
        preloadRun(journal, {
          cwd: projectCwd,
          parentSessionId: createSessionId("sibling-session"),
          runId: `dwfrun-sibling-${status}`,
          status,
          ...(status === "stopped" ? { stopReason: "user" as const } : {}),
        });
      }

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs).toHaveLength(3);
      for (const item of runs) {
        expect(item.ownedByThisSession).toBe(false);
        expect("possiblyInterrupted" in item).toBe(false);
      }
    });
  });

  it("别的项目的 run 不可见（cwd 是字面等值的项目键）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        cwd: projectCwd,
        runId: "dwfrun-here",
        status: "completed",
      });
      preloadRun(journal, {
        cwd: otherCwd,
        runId: "dwfrun-elsewhere",
        status: "completed",
      });

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs.map((item) => item.runId)).toEqual(["dwfrun-here"]);
    });
  });

  it("statuses 过滤与 limit 都下推到查询", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      for (const status of ["completed", "errored"] as const) {
        preloadRun(journal, { cwd: projectCwd, runId: `dwfrun-${status}`, status });
      }
      const introspection = introspectionOf(harness);

      const filtered = await introspection.listRuns({
        cwd: projectCwd,
        limit: 20,
        statuses: ["errored"],
      });
      expect(filtered.runs.map((item) => item.runId)).toEqual(["dwfrun-errored"]);

      const limited = await introspection.listRuns({ cwd: projectCwd, limit: 1 });
      expect(limited.runs).toHaveLength(1);
    });
  });

  // truncated 的判据是「多取一条」而不是「取满 limit」：后者在条数正好等于 limit 时误报，
  // 而误报会让模型去追一页不存在的历史。
  describe("truncated", () => {
    it("为真当且仅当还有 run 没进这一页", async () => {
      await withSqliteJournal(async (journal) => {
        const harness = makeHarness({ journal });
        for (const index of [1, 2, 3]) {
          preloadRun(journal, {
            cwd: projectCwd,
            runId: `dwfrun-page-${index}`,
            status: "completed",
          });
        }
        const introspection = introspectionOf(harness);

        const firstPage = await introspection.listRuns({ cwd: projectCwd, limit: 2 });
        expect(firstPage.runs).toHaveLength(2);
        expect(firstPage.truncated).toBe(true);

        // 条数正好等于 limit：一条都没落下，所以字段整个缺席（不是 false）。
        const exactPage = await introspection.listRuns({ cwd: projectCwd, limit: 3 });
        expect(exactPage.runs).toHaveLength(3);
        expect("truncated" in exactPage).toBe(false);

        const roomyPage = await introspection.listRuns({ cwd: projectCwd, limit: 20 });
        expect("truncated" in roomyPage).toBe(false);
      });
    });

    /**
     * 钳制上限那一页。这条看着像是上一条的重复，其实钉的是一个别处测不到的耦合：truncated
     * 的判定依赖存储查询接受「上限 + 1」。若将来有人在 SqliteDwfJournalStore.listRuns 里加一个
     * `Math.min(50, limit)` 的防御性天花板，探测行会被吃掉，truncated 就在**恰好** limit = 50
     * 时永久缺席——而 2 / 3 / 20 的边界用例一个都不会失败。上限取自契约常量，工具面调高上限
     * 时这条用例自动跟着走。
     */
    it("在钳制上限那一页仍然标 truncated（探测行必须能过存储层）", async () => {
      await withSqliteJournal(async (journal) => {
        const harness = makeHarness({ journal });
        const overflow = LIST_WORKFLOW_RUNS_MAX_LIMIT + 1;
        for (let index = 0; index < overflow; index += 1) {
          preloadRun(journal, {
            cwd: projectCwd,
            runId: `dwfrun-max-${String(index).padStart(3, "0")}`,
            status: "completed",
          });
        }

        const page = await introspectionOf(harness).listRuns({
          cwd: projectCwd,
          limit: LIST_WORKFLOW_RUNS_MAX_LIMIT,
        });
        expect(page.runs).toHaveLength(LIST_WORKFLOW_RUNS_MAX_LIMIT);
        expect(page.truncated).toBe(true);
      });
    });

    it("空项目与被 statuses 过滤空的页都不标 truncated", async () => {
      await withSqliteJournal(async (journal) => {
        const harness = makeHarness({ journal });
        preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-only", status: "completed" });
        const introspection = introspectionOf(harness);

        expect(await introspection.listRuns({ cwd: otherCwd, limit: 20 })).toEqual({ runs: [] });
        expect(
          await introspection.listRuns({ cwd: projectCwd, limit: 20, statuses: ["errored"] }),
        ).toEqual({ runs: [] });
      });
    });

    // 补集也算在页内：间隙里的 run 顶掉最旧的 journal 行时，被顶掉的那条就是「还有更多」。
    it("注册表补集把 journal 行挤出页时标 truncated", async () => {
      await withSqliteJournal(async (real) => {
        const hidden = new Set<string>();
        const journal = hideRunsFromReads(real, hidden);
        const harness = makeHarness({ hangActors: true, journal });
        preloadRun(real, { cwd: projectCwd, runId: "dwfrun-older", status: "completed" });

        const runId = await submitRun(harness, {
          cwd: projectCwd,
          parentSessionId: HARNESS_PARENT_SESSION,
          scriptText: TYPED_SCRIPT,
          trace: traceFor("gap-truncates"),
        });
        hidden.add(runId);

        const page = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 1 });
        expect(page.runs.map((item) => item.runId)).toEqual([runId]);
        expect(page.truncated).toBe(true);

        await harness.service.cancel(runId);
        await settle(harness, runId);
      });
    });
  });

  it("label 兜底：无 name 的老行取脚本首个非空行", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        cwd: projectCwd,
        runId: "dwfrun-unnamed",
        scriptText: "\n  // triage the failing tests\nreturn 1;",
        status: "completed",
      });

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs[0]).toMatchObject({
        label: "// triage the failing tests",
        labelSource: "script",
      });
      // 读时派生，绝不回写：落库等于把一个展示启发式固化成数据。
      expect("name" in journal.getRun("dwfrun-unnamed")!).toBe(false);
    });
  });

  // 只读不变式的正面断言：两条读面之后 journal 上一次写入都没有发生过。
  it("合成过程不写 journal（写入面零调用、行逐字段不变）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        cwd: projectCwd,
        parentSessionId: createSessionId("sibling-session"),
        runId: "dwfrun-readonly",
        status: "running",
      });
      const before = journal.getRun("dwfrun-readonly");

      const createRun = vi.spyOn(journal, "createRun");
      const updateRunStatus = vi.spyOn(journal, "updateRunStatus");
      const updateRunUsage = vi.spyOn(journal, "updateRunUsage");
      const appendEvent = vi.spyOn(journal, "appendEvent");
      const putNode = vi.spyOn(journal, "putNode");
      const putActor = vi.spyOn(journal, "putActor");

      const introspection = introspectionOf(harness);
      await introspection.listRuns({ cwd: projectCwd, limit: 20 });
      await introspection.getRunDetail("dwfrun-readonly");

      for (const spy of [
        createRun,
        updateRunStatus,
        updateRunUsage,
        appendEvent,
        putNode,
        putActor,
      ]) {
        expect(spy).not.toHaveBeenCalled();
      }
      expect(journal.getRun("dwfrun-readonly")).toEqual(before);
    });
  });
});

describe("dynamic workflow run service — submit → createRun 的间隙", () => {
  // journal 尚无行的 run 必须以 pending 出现在列表里：少了这一支，模型刚起的 run 会在自己
  // 项目的列表里整个消失（而它明明刚拿到 runId）。
  it("注册表-only 的 run 以 pending 附加，且排在 journal 行之前", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({ hangActors: true, journal });
      preloadRun(real, {
        cwd: projectCwd,
        parentSessionId: createSessionId("sibling-session"),
        runId: "dwfrun-already-journaled",
        status: "completed",
      });

      const runId = await submitRun(harness, {
        cwd: projectCwd,
        name: "just submitted",
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("list-gap"),
      });
      hidden.add(runId);

      const { runs } = await introspectionOf(harness).listRuns({ cwd: projectCwd, limit: 20 });
      expect(runs.map((item) => item.runId)).toEqual([runId, "dwfrun-already-journaled"]);
      expect(runs[0]).toMatchObject({
        label: "just submitted",
        labelSource: "name",
        ownedByThisSession: true,
        spentTokens: 0,
        status: "pending",
      });
      expect("possiblyInterrupted" in runs[0]!).toBe(false);

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("间隙里的 run 不受 cwd 与 statuses 过滤的豁免", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({ hangActors: true, journal });

      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("list-gap-filters"),
      });
      hidden.add(runId);
      const introspection = introspectionOf(harness);

      // 别的项目问起时它不该出现（注册表条目自带 cwd）。
      expect((await introspection.listRuns({ cwd: otherCwd, limit: 20 })).runs).toEqual([]);
      // 显式的状态过滤器同样管得住它——补集不是过滤器的豁免通道。
      expect(
        (await introspection.listRuns({ cwd: projectCwd, limit: 20, statuses: ["completed"] }))
          .runs,
      ).toEqual([]);

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  // 间隙里的 run 报 not_found 会是一句谎：它刚刚把 runId 交给了调用方。
  it("getRunDetail 对间隙里的 run 回 pending 详情而不是 not_found", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({ hangActors: true, journal });

      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("detail-gap"),
      });
      hidden.add(runId);

      const detail = await introspectionOf(harness).getRunDetail(runId);
      expect(detail).toMatchObject({
        actors: [],
        logTail: [],
        ownedByThisSession: true,
        runId,
        status: "pending",
      });
      // 计数还没有权威来源时诚实地报 0。
      expect(detail?.usage).toEqual({
        nodesCompleted: 0,
        nodesFailed: 0,
        nodesObserved: 0,
        nodesRunning: 0,
        spentTokens: 0,
      });
      expect("result" in detail!).toBe(false);
      expect("error" in detail!).toBe(false);

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });
});

describe("dynamic workflow run service — getRunDetail 组合", () => {
  // ── 产物截面（docs/dynamic-workflow/authoring.md 的 `GetWorkflowRun` 行）─────────────
  // ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给**用户**看的产出，不是详情里的 `result`
  // （脚本顶层返回值，引擎内部对它的同名叫法）。两者在同一个返回对象上并列，所以这里必须写明。
  //
  // getRunDetail 有**两条**返回分支，两条都要带产物：journal 行分支（常态）与注册表间隙分支
  // （run 已提交、dwf_run 行还没落）。漏掉任一条的症状都是「模型看不见这个 run 产出了什么」，
  // 而间隙那条最容易漏——它读起来像个纯兜底。
  const DETAIL_ARTIFACT_SCRIPT = [
    'artifact.chart("perf", { x: { field: "round" }, y: { field: "ms" } });',
    'report({ round: 1, ms: 40 }, "perf");',
    'await artifact.markdown("summary", "# 结论");',
    'return "done";',
  ].join("\n");

  /** 只写文本的 fake store（脚本发的是 markdown）。 */
  function detailArtifactStore(): ToolArtifactStorePort {
    return {
      writeToolResultArtifact: async (request) => ({
        id: "artifact-1",
        uri: "zcode-artifact://harness/artifact-1",
        bytes: Buffer.byteLength(request.content, "utf8"),
        contentType: request.contentType ?? "text/plain",
        createdAt: new Date(0),
      }),
      readToolResultArtifact: async () => {
        throw new Error("本用例不读字节");
      },
    };
  }

  it("journal 行分支带 artifacts 截面（看板 + 内容产物，版本与 itemCount 齐全）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ artifactStore: detailArtifactStore(), journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: DETAIL_ARTIFACT_SCRIPT,
        trace: traceFor("detail-artifacts"),
      });
      await settle(harness, runId);

      const detail = await introspectionOf(harness).getRunDetail(runId);
      expect(detail?.artifacts).toHaveLength(2);
      expect(detail?.artifacts?.[0]).toMatchObject({
        id: "perf",
        kind: "chart",
        version: 1,
        itemCount: 1,
      });
      expect(detail?.artifacts?.[1]).toMatchObject({
        id: "summary",
        kind: "markdown",
        version: 1,
        contentType: "text/markdown",
        itemCount: 0,
      });
      // 与端口的 listArtifacts 是**同一个** artifactsOf，所以两处逐字节相同——
      // 三处各归并一份迟早会在「失败行算不算一版」这种地方分叉。
      expect(detail?.artifacts).toEqual(await harness.service.listArtifacts!(runId));
    });
  });

  it("间隙分支也带 artifacts：dwf_run 行还没落，节点行却可能已经落了", async () => {
    // 引擎在 createRun 之后立刻就能 putNode 一条 artifact 行，所以「行还没落」不等于
    // 「什么都没产出」。这条分支读起来像纯兜底，恰恰是最容易被漏掉产物的那条。
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      const harness = makeHarness({ artifactStore: detailArtifactStore(), journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: DETAIL_ARTIFACT_SCRIPT,
        trace: traceFor("detail-artifacts-gap"),
      });
      await settle(harness, runId);
      // 藏掉 dwf_run 行：getRunRow 回 undefined，注册表条目仍在 ⇒ 走间隙分支。
      hidden.add(runId);

      const detail = await introspectionOf(harness).getRunDetail(runId);
      // 间隙分支的招牌：计数诚实地为 0、actors / logTail 为空。
      expect(detail?.usage).toMatchObject({ nodesObserved: 0, spentTokens: 0 });
      expect(detail?.actors).toEqual([]);
      // 但产物照样在。
      expect(detail?.artifacts?.map((entry) => entry.id)).toEqual(["perf", "summary"]);
    });
  });

  it("零产物的 run：两条分支都让 artifacts 整个字段缺席（不是空数组）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("detail-artifacts-none"),
      });
      await settle(harness, runId);

      const detail = await introspectionOf(harness).getRunDetail(runId);
      expect(detail).toBeDefined();
      expect("artifacts" in detail!).toBe(false);
    });
  });

  it("未知 runId 回 undefined（工具层归一成 run_not_found）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      expect(await introspectionOf(harness).getRunDetail("dwfrun-nope")).toBeUndefined();
    });
  });

  it("节点三态计数、nodesObserved 为三者之和、用量直读 journal 行", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        spentTokens: 4_321,
        caps: { maxConcurrency: 4 },
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        runId: "dwfrun-counts",
        status: "completed",
      });
      const nodes: { ordinal: number; status: "completed" | "failed" | "running" }[] = [
        { ordinal: 1, status: "completed" },
        { ordinal: 2, status: "completed" },
        { ordinal: 3, status: "failed" },
        { ordinal: 4, status: "running" },
      ];
      for (const node of nodes) {
        journal.putNode({
          runId: "dwfrun-counts",
          siteId: "ask#1",
          ordinal: node.ordinal,
          kind: "ask",
          inputHash: `hash-${node.ordinal}`,
          status: node.status,
        });
      }

      const detail = await introspectionOf(harness).getRunDetail("dwfrun-counts");
      expect(detail?.usage).toEqual({
        nodesCompleted: 2,
        nodesFailed: 1,
        // 「已落库节点的行数」，不是「总步数」——动态工作流没有静态总数。
        nodesObserved: 4,
        nodesRunning: 1,
        spentTokens: 4_321,
      });
    });
  });

  // ── 情势截面（docs/dynamic-workflow/launch.md「`GetWorkflowRun`」）────────────────
  // 规则本身由 dynamic-workflow-run-roster.test.ts 手搓事件钉死；这里只证明**接线通了**：
  // 真 journal 的事件、节点行、actor 行确实被读出来喂进了那套规则，而不是三个空字段。
  it("journal 行分支带情势截面：子代理的当前 ask 带任务摘要与进度读数，阶段表按声明序", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = "dwfrun-roster-wired";
      preloadRun(journal, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        runId,
        status: "running",
      });
      journal.putActor({ runId, siteId: "agent#1", ordinal: 1, name: "scout" });
      journal.putNode({
        runId,
        siteId: "ask#1",
        ordinal: 1,
        kind: "ask",
        actorSiteId: "agent#1",
        actorOrdinal: 1,
        actorSeq: 1,
        inputHash: "hash-ask-1",
        status: "running",
      });
      for (const event of [
        { type: "run-started", runId, caps: { maxConcurrency: 4 } },
        { type: "run-launched", inputId: "in-wired", phaseNames: ["collect", "verify"] },
        { type: "phase-entered", name: "collect", ordinal: 1 },
        { type: "actor-created", actor: { siteId: "agent#1", ordinal: 1 }, name: "scout" },
        {
          type: "node-queued",
          instance: { siteId: "ask#1", ordinal: 1 },
          kind: "ask",
          actor: { siteId: "agent#1", ordinal: 1 },
          actorSeq: 1,
          phaseName: "collect",
          instructionsHead: "Collect every regression named in the release notes.",
        },
        { type: "node-dispatched", instance: { siteId: "ask#1", ordinal: 1 } },
        { type: "node-executing", instance: { siteId: "ask#1", ordinal: 1 } },
        {
          type: "node-progress",
          instance: { siteId: "ask#1", ordinal: 1 },
          turn: 2,
          toolCalls: 7,
          lastTool: { name: "Read", target: "docs/release.md" },
        },
      ] as RunEvent[]) {
        journal.appendEvent(runId, event);
      }

      const detail = await introspectionOf(harness).getRunDetail(runId);
      expect(detail?.subagents).toHaveLength(1);
      expect(detail?.subagents[0]).toMatchObject({
        siteId: "agent#1",
        name: "scout",
        state: "executing",
        phaseName: "collect",
        currentAsk: {
          siteId: "ask#1",
          ordinal: 1,
          actorSeq: 1,
          instructionsHead: "Collect every regression named in the release notes.",
          turn: 2,
          toolCalls: 7,
          lastTool: { name: "Read", target: "docs/release.md" },
        },
      });
      // 时刻来自 dwf_event.time_created，所以真库里它必须是一个真实的毫秒数。
      expect(detail?.subagents[0]?.currentAsk?.startedAt).toBeGreaterThan(0);
      expect(detail?.phases).toMatchObject([
        { name: "collect", state: "current", rounds: 1, nodesRunning: 1 },
        { name: "verify", state: "ahead", rounds: 0 },
      ]);
      // 行写着本会话是发起方，但本会话的注册表里没有它——也就是重启后的遗物：进程内那张
      // 停驻表早随上一个进程没了，所以这次读**答不出**有没有问题在等，只能如实说不知道。
      expect(detail?.ownedByThisSession).toBe(true);
      expect(detail?.health).toMatchObject({
        consecutiveFailures: 0,
        cachedSteps: 0,
        pendingQuestionsKnown: false,
      });
    });
  });

  it("终态 run：pendingQuestionsKnown 为真（没有人还在听），遗留的 running 行被数出来", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = "dwfrun-roster-terminal";
      preloadRun(journal, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        runId,
        status: "stopped",
        stopReason: "interrupted",
      });
      journal.putActor({ runId, siteId: "agent#1", ordinal: 1, name: "worker" });
      journal.putNode({
        runId,
        siteId: "ask#1",
        ordinal: 1,
        kind: "ask",
        actorSiteId: "agent#1",
        actorOrdinal: 1,
        actorSeq: 1,
        inputHash: "hash-ask-1",
        status: "running",
      });
      for (const event of [
        { type: "run-started", runId, caps: { maxConcurrency: 4 } },
        { type: "actor-created", actor: { siteId: "agent#1", ordinal: 1 }, name: "worker" },
        {
          type: "node-queued",
          instance: { siteId: "ask#1", ordinal: 1 },
          kind: "ask",
          actor: { siteId: "agent#1", ordinal: 1 },
          actorSeq: 1,
        },
        { type: "node-dispatched", instance: { siteId: "ask#1", ordinal: 1 } },
      ] as RunEvent[]) {
        journal.appendEvent(runId, event);
      }

      const detail = await introspectionOf(harness).getRunDetail(runId);
      // 终态 run 按定义没有还在听的人，所以「没有待答问题」是一句确定的话。
      expect(detail?.health).toMatchObject({ pendingQuestionsKnown: true, leftoverRunning: 1 });
      expect(detail?.subagents[0]).toMatchObject({ name: "worker", state: "unfinished" });
      // 脚本没有 phase() 标记、也没进过任何阶段 ⇒ 整个字段缺席。
      expect("phases" in detail!).toBe(false);
    });
  });

  it("actors 全列出（siteId / ordinal / name），persona 不出", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-actors", status: "completed" });
      journal.putActor({
        runId: "dwfrun-actors",
        siteId: "actor#1",
        ordinal: 1,
        name: "worker",
        persona: { system: "a very long system prompt" },
      });
      journal.putActor({ runId: "dwfrun-actors", siteId: "actor#2", ordinal: 3 });

      const detail = await introspectionOf(harness).getRunDetail("dwfrun-actors");
      expect(detail?.actors).toEqual([
        { siteId: "actor#1", ordinal: 1, name: "worker" },
        { siteId: "actor#2", ordinal: 3 },
      ]);
    });
  });

  it("logTail：只取 log 事件、末 20 条、按时序、逐条 2048 字符界", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-logs", status: "completed" });
      journal.appendEvent("dwfrun-logs", {
        caps: { maxConcurrency: 4 },
        runId: "dwfrun-logs",
        type: "run-started",
      });
      for (let index = 1; index <= 25; index += 1) {
        journal.appendEvent("dwfrun-logs", { message: `step ${index}`, type: "log" });
      }
      const overlong = "x".repeat(5_000);
      journal.appendEvent("dwfrun-logs", { message: overlong, type: "log" });

      const detail = await introspectionOf(harness).getRunDetail("dwfrun-logs");
      const logTail = detail!.logTail;
      expect(logTail).toHaveLength(20);
      // 时序（sequence 升序），且尾巴取的是**末** 20 条：最早保留的是 step 7。
      expect(logTail.map((entry) => entry.sequence)).toEqual(
        [...logTail].sort((left, right) => left.sequence - right.sequence).map((e) => e.sequence),
      );
      expect(logTail[0]?.message).toBe("step 7");
      expect(logTail.at(-1)?.message).toHaveLength(
        DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS.maxStringLength,
      );
      // run-started 不是 log：类型过滤下推到 SQL，不能靠"反正模型看不懂"混进来。
      expect(logTail.some((entry) => entry.message.includes("run-started"))).toBe(false);
      // 每条叙事带着自己的落库时刻（dwf_event.time_created）：读面据它算「多久以前」，
      // 而不是用读时的 Date.now() 把一周前的历史全标成「刚刚」。
      for (const entry of logTail) {
        expect(typeof entry.at).toBe("number");
        expect(entry.at).toBeLessThanOrEqual(Date.now());
      }
    });
  });

  it("没有 log 事件时 logTail 是空数组", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-nologs", status: "completed" });

      expect((await introspectionOf(harness).getRunDetail("dwfrun-nologs"))?.logTail).toEqual([]);
    });
  });

  // 时间戳直读 journal 行，刻意绕开快照面的 new Date(0) 兜底：内存条目蒸发后那个起始时间
  // 是假的，而模型据它判断「这个 run 是多久以前的」。
  it("createdAt / updatedAt 来自 journal 行", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const before = Date.now();
      preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-times", status: "running" });
      journal.updateRunStatus("dwfrun-times", "completed");
      const after = Date.now();

      const detail = await introspectionOf(harness).getRunDetail("dwfrun-times");
      expect(detail!.createdAt).toBeGreaterThanOrEqual(before);
      expect(detail!.updatedAt).toBeGreaterThanOrEqual(detail!.createdAt);
      expect(detail!.updatedAt).toBeLessThanOrEqual(after);
    });
  });

  it("running 的 run 既无 result 也无 error", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        cwd: projectCwd,
        parentSessionId: createSessionId("sibling-session"),
        runId: "dwfrun-running",
        status: "running",
      });

      const detail = await introspectionOf(harness).getRunDetail("dwfrun-running");
      expect("result" in detail!).toBe(false);
      expect("error" in detail!).toBe(false);
    });
  });

  it("completed：内存终态的产物原样交出（不序列化）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({
        actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "the answer" } }] },
        journal,
      });
      const runId = await submitRun(harness, {
        cwd: projectCwd,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("detail-result-memory"),
      });
      await settle(harness, runId);

      const detail = await introspectionOf(harness).getRunDetail(runId);
      expect(detail?.status).toBe("completed");
      // 原值，不是 JSON 文本：面向模型的序列化在 core 有唯一实现（完成通知与 TaskOutput
      // 共用它），端口再做一次就会出现"同一个产物两种长相"。
      expect(detail?.result).toBe("the answer");
      expect("error" in detail!).toBe(false);
    });
  });

  it("completed：注册表蒸发后退回 journal 的 result_json", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-result-json", status: "running" });
      journal.updateRunStatus("dwfrun-result-json", "completed", {
        result: { report: "final answer", steps: 3 },
      });

      const detail = await introspectionOf(harness).getRunDetail("dwfrun-result-json");
      expect(detail?.result).toEqual({ report: "final answer", steps: 3 });
    });
  });

  it("completed 但产物是 undefined → result 整字段缺席", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, { cwd: projectCwd, runId: "dwfrun-void", status: "completed" });

      expect("result" in (await introspectionOf(harness).getRunDetail("dwfrun-void"))!).toBe(false);
    });
  });

  // 模型必须能分辨「进程死了」（Interrupted）与「脚本真失败」（DriverError）：code 原样透出，
  // 绝不折叠成一个通用失败。
  it("errored / stopped(interrupted)：failure_json 的 code 原样透出（含 Interrupted）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      for (const code of ["Interrupted", "DriverError"] as const) {
        preloadRun(journal, {
          cwd: projectCwd,
          failure: { code, message: `failed with ${code}` },
          runId: `dwfrun-failed-${code}`,
          ...(code === "Interrupted"
            ? { status: "stopped" as const, stopReason: "interrupted" as const }
            : { status: "errored" as const }),
        });
      }
      const introspection = introspectionOf(harness);

      expect((await introspection.getRunDetail("dwfrun-failed-Interrupted"))?.error).toEqual({
        code: "Interrupted",
        message: "failed with Interrupted",
      });
      expect((await introspection.getRunDetail("dwfrun-failed-DriverError"))?.error).toEqual({
        code: "DriverError",
        message: "failed with DriverError",
      });
    });
  });

  it("cancelled：带 error（失败编码在场时）", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      preloadRun(journal, {
        cwd: projectCwd,
        failure: { code: "Cancelled", message: "cancelled by user" },
        runId: "dwfrun-cancelled",
        status: "stopped",
        stopReason: "user",
      });

      expect((await introspectionOf(harness).getRunDetail("dwfrun-cancelled"))?.error).toEqual({
        code: "Cancelled",
        message: "cancelled by user",
      });
    });
  });
});

describe("resolveDynamicWorkflowJournalStore", () => {
  // 没有 journal 就不构造服务：一个静默丢失持久化的 run 比没有 run 更糟。
  it("store 缺少 workflowJournalStore 时返回 undefined 并记原因", () => {
    const messages: string[] = [];
    const resolved = resolveDynamicWorkflowJournalStore(
      {} as never,
      {
        info: (message: string) => {
          messages.push(message);
        },
      } as never,
    );

    expect(resolved).toBeUndefined();
    expect(messages.join(" ")).toContain("dwf journal");
  });

  it("store 提供 workflowJournalStore 时透出该 journal", () => {
    const journal = new InMemoryJournalStore();
    const resolved = resolveDynamicWorkflowJournalStore({
      workflowJournalStore: () => journal,
    } as never);

    expect(resolved).toBe(journal);
  });
});

describe("dynamic workflow run service — resume", () => {
  const TWO_ASK_SCRIPT = [
    "interface Answer { text: string }",
    'const worker = agent("worker");',
    'const first = await worker.ask<Answer>("step one");',
    "const second = await worker.ask(`step two after ${first.text}`);",
    "return `${first.text}+${second}`;",
  ].join("\n");

  const RESUME_TOOL_CALL = createToolCallId("resume-origin");

  /**
   * 阶段一：把一个 run 跑到「ask#1 已完结、ask#2 在飞」再取消。
   * journal 里留下：actor（带会话 id）、completed 的 ask#1、running 的 ask#2——
   * 正是 resume 要接手的形态。options 对象被 makeHarness 闭包持有，测试可在两阶段之间
   * 改写 actorScripts（阶段二的 fresh runtime 按当时的值取剧本）。
   */
  async function cancelledMidFlight(options: HarnessOptions = {}) {
    options.actorScripts = {
      "actor#1@1": [{ kind: "submit", result: { text: "one" } }, { kind: "hang" }],
    };
    const harness = makeHarness(options);
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TWO_ASK_SCRIPT,
      toolCallId: RESUME_TOOL_CALL,
      trace: traceFor("resume-phase1"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getNode(runId, "ask#2", 1)?.status).toBe("running");
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
    expect(harness.journal.getRun(runId)?.status).toBe("stopped");
    expect(harness.journal.getNode(runId, "ask#1", 1)?.status).toBe("completed");
    expect(harness.journal.getActor(runId, "actor#1", 1)?.sessionId).toBeDefined();
    return { harness, runId };
  }

  it("恢复被取消的 run：完结节点短路、在飞节点重派发、run 跑到 completed", async () => {
    const options: HarnessOptions = {};
    const { harness, runId } = await cancelledMidFlight(options);
    const linksAfterPhaseOne = harness.taskLinks.length;
    const persistsAfterPhaseOne = harness.persistedTitles.length;

    // 阶段二剧本：fresh runtime 只需要应答重派发的 ask#2（untyped → 一段文本）。
    options.actorScripts = { "actor#1@1": [{ kind: "text", text: "two" }] };
    const result = await harness.service.resume?.(runId);
    expect(result).toMatchObject({ ok: true, runId, toolCallId: RESUME_TOOL_CALL });

    await settle(harness, runId);
    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.output).toBe("one+two");
    expect(harness.journal.getRun(runId)?.status).toBe("completed");

    // ask#1 未重跑：两阶段共 3 次模型请求（submit + hang + 阶段二的 text），
    // 若 ask#1 被重派发会是 4 次。actor runtime 每阶段各构造一次。
    expect(harness.order.filter((entry) => entry.startsWith("turn:")).length).toBe(3);
    expect(harness.order.filter((entry) => entry.startsWith("construct:")).length).toBe(2);
    // 重水化：journaled actor 经 resumeFromStore 重挂；会话行与 task link 不再重建。
    expect(harness.resumeCalls).toHaveLength(1);
    expect(harness.taskLinks.length).toBe(linksAfterPhaseOne);
    expect(harness.persistedTitles.length).toBe(persistsAfterPhaseOne);

    // 事件面：sequence 跨两阶段单调续编；run-started 出现两次；ask#1 以 cached 短路结算。
    const sequences = harness.runEvents.map((event) => event.sequence);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
    }
    expect(harness.runEvents.filter((event) => event.eventType === "run-started")).toHaveLength(2);
    const cachedSettles = harness.runEvents.filter(
      (event) =>
        event.eventType === "node-settled" &&
        (event.payload as { cached?: boolean }).cached === true,
    );
    expect(cachedSettles.length).toBeGreaterThanOrEqual(1);
  });

  it("恢复后 cancel 依然可用（注册表条目被替换成新的 AbortController）", async () => {
    const options: HarnessOptions = {};
    const { harness, runId } = await cancelledMidFlight(options);

    options.actorScripts = { "actor#1@1": [{ kind: "hang" }] };
    const result = await harness.service.resume?.(runId);
    expect(result).toMatchObject({ ok: true });

    // 等重派发的 ask#2 真正在飞（阶段二的第 3 次模型请求）。
    await vi.waitFor(() => {
      expect(harness.order.filter((entry) => entry.startsWith("turn:")).length).toBe(3);
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);
    expect((await harness.service.getTask(runId))?.status).toBe("cancelled");
    expect(harness.journal.getRun(runId)?.status).toBe("stopped");
  });

  it("resume 返回后 getTask 立即报 running（journal 状态已翻回）", async () => {
    const options: HarnessOptions = {};
    const { harness, runId } = await cancelledMidFlight(options);

    options.actorScripts = { "actor#1@1": [{ kind: "hang" }] };
    await harness.service.resume?.(runId);
    // 不等结算：launch 的同步前缀已让引擎构造走完 resume 分支（updateRunStatus running）。
    expect((await harness.service.getTask(runId))?.status).toBe("running");

    await harness.service.cancel(runId);
    await settle(harness, runId);
  });

  it("孤儿收敛出的 stopped(interrupted) run 可恢复，且恢复清掉陈旧 failure", async () => {
    const { createHash } = await import("node:crypto");
    const journal = new SweepableJournalStore();
    const runId = "dwfrun-interrupted";
    journal.createRun({
      runId,
      parentSessionId: HARNESS_PARENT_SESSION,
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      scriptHash: createHash("sha256").update(TYPED_SCRIPT, "utf8").digest("hex"),
      toolCallId: "call-interrupted",
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "stopped",
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
    });

    const harness = makeHarness({
      journal,
      actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "revived" } }] },
    });
    const result = await harness.service.resume?.(runId);
    expect(result).toMatchObject({ ok: true, runId, toolCallId: "call-interrupted" });

    await settle(harness, runId);
    const record = harness.journal.getRun(runId);
    expect(record?.status).toBe("completed");
    // 非终态翻转清掉了 Interrupted 残留（updateRunStatus 的新语义走真实路径）。
    expect(record?.failure).toBeUndefined();
    expect(record?.stopReason).toBeUndefined();
    expect((await harness.service.getTask(runId))?.output).toBe("revived");
    // 空 journal（无 actor 记录）→ 全新持久化路径，不走重水化。
    expect(harness.resumeCalls).toHaveLength(0);
    expect(harness.persistedTitles).toHaveLength(1);
  });

  it("回退：resumeFromStore 抛 SessionNotFound 时退回全新持久化路径", async () => {
    const options: HarnessOptions = { resumeSessionMissing: true };
    const { harness, runId } = await cancelledMidFlight(options);
    const persistsAfterPhaseOne = harness.persistedTitles.length;

    options.actorScripts = { "actor#1@1": [{ kind: "text", text: "two" }] };
    const result = await harness.service.resume?.(runId);
    expect(result).toMatchObject({ ok: true });

    await settle(harness, runId);
    expect((await harness.service.getTask(runId))?.status).toBe("completed");
    // 重水化被尝试过（journaled actor），失败后回退：会话重新持久化了一次。
    expect(harness.resumeCalls).toHaveLength(1);
    expect(harness.persistedTitles.length).toBe(persistsAfterPhaseOne + 1);
    // 回退有迹可循（warn），而不是静默。
    expect(
      harness.logs.some(
        (log) =>
          log.level === "warn" &&
          log.context?.event === "dynamic_workflow.actor.rehydrate_fallback",
      ),
    ).toBe(true);
  });
});

/**
 * 实参的持久与重放（docs/dynamic-workflow/launch.md「Running a saved workflow」）。
 *
 * 这一组守的是一句话：**resume 重放存下来的实参，永不接受新的**。失败形态很安静——一个
 * 恢复出来的 run 带着 `{}` 再跑一遍，脚本走进另一条分支，而 run 面板上什么都看不出来。
 */
describe("dynamic workflow run service — run args", () => {
  // 产物里带上实参：这样「实参有没有到沙箱」是一个可以从 getTask 直接看到的事实，
  // 而不是一个要靠间接计数去推断的东西。
  const ARGS_SCRIPT = [
    "interface Answer { text: string }",
    'const a = await agent("worker").ask<Answer>(`work on ${String(args.target)}`);',
    "return `${String(args.target)}:${a.text}`;",
  ].join("\n");

  it("落库 submit 收到的实参，并把它注入沙箱", async () => {
    const harness = makeHarness({
      actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "done" } }] },
    });

    const runId = await submitRun(harness, {
      args: { target: "packages/core" },
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: ARGS_SCRIPT,
      trace: traceFor("args-submit"),
    });
    await settle(harness, runId);

    expect(harness.journal.getRun(runId)?.args).toEqual({ target: "packages/core" });
    // 落库只是一半：产物证明这份实参真的被注入了沙箱、被脚本读到了。
    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.output).toBe("packages/core:done");
  });

  it("内联 run 不落实参列（老行与无参 run 走同一条缺席路径）", async () => {
    const harness = makeHarness({
      actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "x" } }] },
    });

    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("args-absent"),
    });
    await settle(harness, runId);

    expect(harness.journal.getRun(runId)?.args).toBeUndefined();
  });

  it("resume 重放持久化的实参，且 resume 入口根本收不下新实参", async () => {
    const options: HarnessOptions = {
      actorScripts: { "actor#1@1": [{ kind: "hang" }] },
    };
    const harness = makeHarness(options);
    const runId = await submitRun(harness, {
      args: { target: "original-target" },
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: ARGS_SCRIPT,
      trace: traceFor("args-resume"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getNode(runId, "ask#1", 1)?.status).toBe("running");
    });
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    options.actorScripts = { "actor#1@1": [{ kind: "submit", result: { text: "resumed" } }] };
    // resume 的签名只收 runId：换实参在这条入口上**无从表达**，而那正是设计——
    // 换实参 = 一次新的 run = 一次新的确认窗。
    expect(await harness.service.resume?.(runId)).toMatchObject({ ok: true, runId });
    await settle(harness, runId);

    // 恢复出来的 run 用的还是被批准的那一份实参，且记录没有被 resume 改写。
    expect(harness.journal.getRun(runId)?.args).toEqual({ target: "original-target" });
    const resumed = await harness.service.getTask(runId);
    expect(resumed?.status).toBe("completed");
    // 产物里的实参就是**第一次批准的**那一份：resume 重放它，不重新征集。
    expect(resumed?.output).toBe("original-target:resumed");
  });

  // GUI「配置」重跑前驱自己的脚本（docs/dynamic-workflow/launch.md「Changing a run's settings from the
  // GUI」）：`inheritArgs` 让修订沿用前驱落库的实参；工具路径不传，修订照旧不带实参。
  it("amend 默认不带实参；inheritArgs 沿用前驱落库的那一份并注入沙箱", async () => {
    const options: HarnessOptions = {
      actorScripts: { "actor#1@1": [{ kind: "hang" }] },
    };
    const harness = makeHarness(options);
    const runA = await submitRun(harness, {
      args: { target: "packages/core" },
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: ARGS_SCRIPT,
      trace: traceFor("args-amend-a"),
    });
    await vi.waitFor(() => {
      expect(harness.journal.getNode(runA, "ask#1", 1)?.status).toBe("running");
    });

    options.actorScripts = { "actor#1@1": [{ kind: "submit", result: { text: "kept" } }] };
    const inherited = await amendRun(harness, {
      cwd: TEST_CWD,
      inheritArgs: true,
      parentSessionId: HARNESS_PARENT_SESSION,
      predecessorRunId: runA,
      scriptText: ARGS_SCRIPT,
      trace: traceFor("args-amend-b"),
    });
    await settle(harness, inherited.runId);
    expect(harness.journal.getRun(inherited.runId)?.args).toEqual({ target: "packages/core" });
    expect((await harness.service.getTask(inherited.runId))?.output).toBe("packages/core:kept");

    // 工具路径（不传 inheritArgs）：再从同一个前驱修订一次，新 run 不带实参。前驱挂起时没有已完成
    // 的 ask，边界预检自然通过。
    const plain = await amendRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      predecessorRunId: runA,
      scriptText: ARGS_SCRIPT,
      trace: traceFor("args-amend-c"),
    });
    await settle(harness, plain.runId);
    expect(harness.journal.getRun(plain.runId)?.args).toBeUndefined();
  });
});

describe("dynamic workflow run service — resume 门", () => {
  it("未知 runId → not_found", async () => {
    const harness = makeHarness();
    await expect(harness.service.resume?.("dwfrun-nope")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("completed run → not_resumable", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("gate-completed"),
    });
    await settle(harness, runId);
    await expect(harness.service.resume?.(runId)).resolves.toEqual({
      ok: false,
      reason: "not_resumable",
    });
  });

  it("errored → not_resumable（脚本真失败 replay 只会逐字复现）", async () => {
    const journal = new SweepableJournalStore();
    journal.createRun({
      runId: "dwfrun-script-failed",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "errored",
      failure: { code: "DriverError", message: "script threw" },
    });
    const harness = makeHarness({ journal });
    await expect(harness.service.resume?.("dwfrun-script-failed")).resolves.toEqual({
      ok: false,
      reason: "not_resumable",
    });
  });

  it("记录缺 scriptText → script_missing", async () => {
    const journal = new SweepableJournalStore();
    journal.createRun({
      runId: "dwfrun-old",
      parentSessionId: HARNESS_PARENT_SESSION,
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "stopped",
      stopReason: "user",
    });
    const harness = makeHarness({ journal });
    await expect(harness.service.resume?.("dwfrun-old")).resolves.toEqual({
      ok: false,
      reason: "script_missing",
    });
  });

  it("scriptHash 与原文不自洽 → script_mismatch，journal 状态不被触碰", async () => {
    const journal = new SweepableJournalStore();
    journal.createRun({
      runId: "dwfrun-tampered",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      scriptHash: "bogus-hash",
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "stopped",
      stopReason: "user",
    });
    const harness = makeHarness({ journal });
    await expect(harness.service.resume?.("dwfrun-tampered")).resolves.toEqual({
      ok: false,
      reason: "script_mismatch",
    });
    // 拒绝不建注册表条目、不启动引擎：记录保持 stopped，仍可在修复记录后恢复。
    expect(harness.journal.getRun("dwfrun-tampered")?.status).toBe("stopped");
  });

  // facade 重构后的老 run（2026-09-15）：原文按当时的 facade 写，当前类型检查不再通过。
  it("原文在当前 facade 下编不过 → compile_failed 携有界诊断，journal 状态不被触碰", async () => {
    const journal = new SweepableJournalStore();
    const legacyScript =
      "const planner = agent('planner');\nawait planner.askWithOldFacade('x');\n";
    journal.createRun({
      runId: "dwfrun-legacy-facade",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: legacyScript,
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "stopped",
      stopReason: "interrupted",
    });
    const harness = makeHarness({ journal });
    const result = await harness.service.resume?.("dwfrun-legacy-facade");
    expect(result).toMatchObject({ ok: false, reason: "compile_failed" });
    expect((result as { message?: string }).message).toMatch(/no longer compiles/);
    expect((result as { message?: string }).message).toMatch(/L\d+:C\d+/);
    expect(harness.journal.getRun("dwfrun-legacy-facade")?.status).toBe("stopped");
  });

  it("同 runId 在飞 → already_running", async () => {
    const harness = makeHarness({
      actorScripts: { "actor#1@1": [{ kind: "hang" }] },
    });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("gate-inflight"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });
    await expect(harness.service.resume?.(runId)).resolves.toEqual({
      ok: false,
      reason: "already_running",
    });
    await harness.service.cancel(runId);
    await settle(harness, runId);
  });
});

// 冷回放（docs/dynamic-workflow/presentation.md）：journal → 与 live 同一种进度载荷。
// 「重启前后一致」在这里成为可断言的事实：同一份 sqlite journal 上跑完一个 run，live 时 onRunEvent
// 交出的载荷序列，与一个**新** service 实例（注册表为空 = 重启）的回放序列逐字节相等；两者经共享
// reducer 归约出的 workflowRuns 自然也相等。
describe("dynamic workflow run service — replayProgressForSession（冷回放）", () => {
  const REPLAY_SCRIPT = [
    "interface Answer { text: string }",
    'const a = await agent("worker").ask<Answer>("do the thing");',
    'await artifact.markdown("summary", a.text);',
    "return a.text;",
  ].join("\n");

  /** 最小产物存储：只为让 `artifact.markdown` 能发布（读面不在本组用例的范围里）。 */
  function artifactStore(): ToolArtifactStorePort {
    let next = 0;
    return {
      writeToolResultArtifact: async (request) => {
        next += 1;
        return {
          id: `artifact-${next}`,
          uri: `zcode-artifact://replay/artifact-${next}`,
          bytes: Buffer.byteLength(request.content, "utf8"),
          contentType: request.contentType ?? "text/plain",
          createdAt: new Date(0),
        };
      },
      readToolResultArtifact: async () => {
        throw new Error("not read in replay tests");
      },
      readToolResultBinaryArtifact: async () => {
        throw new Error("not read in replay tests");
      },
    };
  }

  function reduceAll(payloads: readonly DynamicWorkflowRunProgressPayload[]) {
    let state: WorkflowRunsState | undefined;
    for (const payload of payloads) {
      state = reduceWorkflowRunsState(state, payload as WorkflowRunProgressEnvelope) ?? state;
    }
    return state;
  }

  it("跑完一个 run 后，新实例的回放载荷与 live 载荷逐字节相等，归约态深等且过 strict schema", async () => {
    await withSqliteJournal(async (journal) => {
      const live = makeHarness({ artifactStore: artifactStore(), journal });
      const toolCallId = createToolCallId("call-replay");
      const runId = await submitRun(live, {
        cwd: projectCwd,
        name: "replay me",
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: REPLAY_SCRIPT,
        toolCallId,
        trace: traceFor("replay-live"),
      });
      await settle(live, runId);
      expect(journal.getRun(runId)?.status).toBe("completed");
      // 有东西可比：actor、节点、用量、产物、settle 都在这条 run 上。
      const kinds = new Set(live.runEvents.map((event) => event.eventType));
      for (const kind of [
        "run-started",
        "actor-created",
        "node-settled",
        "usage-updated",
        "artifact-published",
        "run-settled",
      ]) {
        expect(kinds.has(kind)).toBe(true);
      }

      // 「重启」= 同一份 journal 上再造一个 service：注册表为空，内存里没有任何事件。
      const cold = makeHarness({ artifactStore: artifactStore(), journal });
      const replayed = await cold.service.replayProgressForSession!({ excludeRunIds: new Set() });

      expect(replayed).toEqual(live.runEvents);
      // 宿主派生字段也要两侧一致：`concurrencyCeiling` 只活在载荷里（引擎不知道机器有几个核），
      // 冷回放少铸一个键就是一次静默的投影分叉——上面那条相等断言正是它的护栏，这里把「它确实
      // 在场且是默认并发」单独钉住，免得两侧一起缺席时相等断言依然通过。
      const startedCeiling = (event: DynamicWorkflowRunProgressPayload | undefined) =>
        (event?.payload as { concurrencyCeiling?: number } | undefined)?.concurrencyCeiling;
      const liveStarted = live.runEvents.find((event) => event.eventType === "run-started");
      const coldStarted = replayed.find((event) => event.eventType === "run-started");
      expect(startedCeiling(liveStarted)).toBe(resolveWorkflowDefaultConcurrency());
      expect(startedCeiling(coldStarted)).toBe(startedCeiling(liveStarted));
      const liveState = reduceAll(live.runEvents);
      const coldState = reduceAll(replayed);
      expect(coldState).toEqual(liveState);
      expect(coldState?.runs[0]).toMatchObject({
        runId,
        status: "completed",
        toolCallId: String(toolCallId),
      });
      expect(coldState?.runs[0]?.actors.length).toBeGreaterThan(0);
      expect(coldState?.runs[0]?.nodes.length).toBeGreaterThan(0);
      expect(coldState?.runs[0]?.usage.spentTokens).toBeGreaterThan(0);
      expect(workflowRunsStateSchema.parse(coldState)).toEqual(coldState);
    });
  });

  it("被打断的 run（行 stopped/interrupted、事件流没有 run-settled）：追加内存态合成 settle，携 resumable；journal 不动", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      runId: "dwfrun-interrupted",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      status: "running",
    });
    journal.appendEvent("dwfrun-interrupted", {
      type: "run-started",
      caps: { maxConcurrency: 4 },
    } as never);
    journal.appendEvent("dwfrun-interrupted", {
      type: "actor-created",
      actor: { siteId: "actor#1", ordinal: 1 },
      name: "worker",
    } as never);
    journal.appendEvent("dwfrun-interrupted", {
      type: "node-queued",
      instance: { siteId: "ask#1", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#1", ordinal: 1 },
    } as never);
    journal.appendEvent("dwfrun-interrupted", {
      type: "escalation-raised",
      qid: "dwfq-1",
      actor: { siteId: "actor#1", ordinal: 1 },
      question: "which branch?",
      askedAt: 1,
    } as never);
    const before = journal.listEvents("dwfrun-interrupted", {
      types: "all",
      reportItems: "all",
    }).length;

    // 构造即孤儿收敛：行被改写成 stopped/interrupted，事件流原样（收敛者不合成事件）。
    const harness = makeHarness({ journal });
    expect(journal.getRun("dwfrun-interrupted")).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
      failure: { code: "Interrupted" },
    });
    const replayed = await harness.service.replayProgressForSession!({ excludeRunIds: new Set() });

    expect(
      journal.listEvents("dwfrun-interrupted", { types: "all", reportItems: "all" }),
    ).toHaveLength(before);
    const last = replayed.at(-1);
    expect(last).toMatchObject({
      runId: "dwfrun-interrupted",
      sequence: before,
      eventType: "run-settled",
      payload: {
        status: "stopped",
        stopReason: "interrupted",
        error: { code: "Interrupted" },
        resumable: true,
      },
    });
    expect(replayed.filter((event) => event.eventType === "run-settled")).toHaveLength(1);
    const state = reduceAll(replayed);
    expect(state?.runs[0]).toMatchObject({ status: "stopped", resumable: true });
    expect(state?.runs[0]?.error).toContain("exited");
    // 停驻问题随终态清空：进程亡故后没有人在等答案。
    expect(state?.runs[0]?.pendingQuestions).toBeUndefined();
    expect(state?.runs[0]?.actors[0]?.status).toBe("completed");
  });

  it("cancelled 行同样携 resumable；行终态且事件流已含 run-settled 时不再合成第二条", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      runId: "dwfrun-cancelled",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      status: "stopped",
      stopReason: "user",
    });
    journal.appendEvent("dwfrun-cancelled", {
      type: "run-started",
      caps: { maxConcurrency: 4 },
    } as never);
    journal.appendEvent("dwfrun-cancelled", {
      type: "run-settled",
      status: "stopped",
      stopReason: "user",
    } as never);
    preloadRun(journal, {
      runId: "dwfrun-crashed",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      status: "errored",
      failure: { code: "DriverError", message: "script threw" },
    });
    journal.appendEvent("dwfrun-crashed", {
      type: "run-started",
      caps: { maxConcurrency: 4 },
    } as never);

    const harness = makeHarness({ journal });
    const replayed = await harness.service.replayProgressForSession!({ excludeRunIds: new Set() });
    const byRun = new Map<string, DynamicWorkflowRunProgressPayload[]>();
    for (const event of replayed) {
      byRun.set(event.runId, [...(byRun.get(event.runId) ?? []), event]);
    }
    // 已含 settle：恰一条，且按行谓词补上 resumable（老 journal 的 settle 事件不带该位）。
    const cancelled = byRun.get("dwfrun-cancelled") ?? [];
    expect(cancelled.filter((event) => event.eventType === "run-settled")).toHaveLength(1);
    expect(cancelled.at(-1)?.payload).toMatchObject({
      status: "stopped",
      stopReason: "user",
      resumable: true,
    });
    // 脚本真失败：合成 settle 不带 resumable。
    const crashed = byRun.get("dwfrun-crashed") ?? [];
    expect(crashed.at(-1)?.payload).toEqual({
      status: "errored",
      error: { code: "DriverError", message: "script threw" },
    });
  });

  it("排除集：内存里已有的 runId 与注册表在飞的 run 不回放；兄弟会话的 run 不进；上界 8 且最旧优先", async () => {
    const journal = new SweepableJournalStore();
    for (let index = 1; index <= 10; index += 1) {
      preloadRun(journal, {
        runId: `dwfrun-old-${index}`,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        status: "completed",
      });
      journal.appendEvent(`dwfrun-old-${index}`, {
        type: "run-started",
        caps: { maxConcurrency: 4 },
      } as never);
      journal.appendEvent(`dwfrun-old-${index}`, {
        type: "run-settled",
        status: "completed",
      } as never);
    }
    preloadRun(journal, {
      runId: "dwfrun-sibling",
      parentSessionId: "ses_other",
      scriptText: TYPED_SCRIPT,
      status: "completed",
    });
    journal.appendEvent("dwfrun-sibling", {
      type: "run-started",
      caps: { maxConcurrency: 4 },
    } as never);

    const harness = makeHarness({ hangActors: true, journal });
    const inFlight = await submitRun(harness, {
      cwd: projectCwd,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("replay-in-flight"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });

    const replayed = await harness.service.replayProgressForSession!({
      excludeRunIds: new Set(["dwfrun-old-10"]),
    });
    const order: string[] = [];
    for (const event of replayed) {
      if (order.at(-1) !== event.runId) order.push(event.runId);
    }
    // 枚举面给最近 8 条（old-3..old-10 与在飞的那条里最近的 8 条），回放最旧优先；
    // 在飞的与被排除的都不在，兄弟会话的更不在。
    expect(order).not.toContain(inFlight);
    expect(order).not.toContain("dwfrun-old-10");
    expect(order).not.toContain("dwfrun-sibling");
    expect(order).toEqual([
      "dwfrun-old-4",
      "dwfrun-old-5",
      "dwfrun-old-6",
      "dwfrun-old-7",
      "dwfrun-old-8",
      "dwfrun-old-9",
    ]);

    expect(await harness.service.cancel(inFlight)).toBe(true);
    await settle(harness, inFlight);
  });

  it("内存 journal（无枚举面）：回放回空", async () => {
    const harness = makeHarness({ journal: new InMemoryJournalStore() });
    await expect(
      harness.service.replayProgressForSession!({ excludeRunIds: new Set() }),
    ).resolves.toEqual([]);
  });
});

describe("dynamic workflow run service — listRunsForSession", () => {
  it("回本会话的 run 摘要，resumable 与 resume 门同源", async () => {
    const journal = new SweepableJournalStore();
    const seed = (input: {
      runId: string;
      status: RunStatus;
      failure?: { code: string; message: string };
      stopReason?: RunStopReason;
      toolCallId?: string;
      parentSessionId?: string;
    }): void => {
      journal.createRun({
        runId: input.runId,
        parentSessionId: input.parentSessionId ?? HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        caps: { maxConcurrency: 4 },
        spentTokens: 0,
        status: input.status,
        ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason }),
        ...(input.failure === undefined ? {} : { failure: input.failure as never }),
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      });
    };
    seed({ runId: "dwfrun-done", status: "completed", toolCallId: "call-done" });
    seed({
      runId: "dwfrun-stopped",
      status: "stopped",
      stopReason: "user",
      toolCallId: "call-stopped",
    });
    seed({
      runId: "dwfrun-interrupted",
      status: "stopped",
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
    });
    seed({
      runId: "dwfrun-crashed",
      status: "errored",
      failure: { code: "DriverError", message: "script threw" },
    });
    seed({
      runId: "dwfrun-other",
      status: "stopped",
      stopReason: "user",
      parentSessionId: "ses_other",
    });

    const harness = makeHarness({ journal });
    const summaries = await harness.service.listRunsForSession?.();

    expect(summaries?.map((summary) => summary.runId).sort()).toEqual([
      "dwfrun-crashed",
      "dwfrun-done",
      "dwfrun-interrupted",
      "dwfrun-stopped",
    ]);
    const byId = new Map(summaries?.map((summary) => [summary.runId, summary]));
    expect(byId.get("dwfrun-stopped")).toMatchObject({
      resumable: true,
      status: "stopped",
      stopReason: "user",
      toolCallId: "call-stopped",
    });
    expect(byId.get("dwfrun-interrupted")).toMatchObject({
      failureCode: "Interrupted",
      resumable: true,
      status: "stopped",
      stopReason: "interrupted",
    });
    expect(byId.get("dwfrun-done")).toMatchObject({ resumable: false, status: "completed" });
    expect(byId.get("dwfrun-crashed")).toMatchObject({
      failureCode: "DriverError",
      resumable: false,
    });
  });

  it("journal 无枚举能力（内存实现）时回空列表而不是抛错", async () => {
    const harness = makeHarness({ journal: new InMemoryJournalStore() });
    await expect(harness.service.listRunsForSession?.()).resolves.toEqual([]);
  });

  // label 与工具面共用 resolveDynamicWorkflowRunLabel：枚举面自己拼一次兜底，同一个 run
  // 就会在 /dwf list 与工具卡上显示两个名字（docs/dynamic-workflow/launch.md「`/dwf`」）。
  it("label 走 name → 脚本首行 → runId 的同一条派生链", async () => {
    const journal = new SweepableJournalStore();
    const seed = (input: { runId: string; name?: string; scriptText?: string }): void => {
      journal.createRun({
        runId: input.runId,
        parentSessionId: HARNESS_PARENT_SESSION,
        ...(input.scriptText === undefined ? {} : { scriptText: input.scriptText }),
        ...(input.name === undefined ? {} : { name: input.name }),
        caps: { maxConcurrency: 4 },
        spentTokens: 0,
        status: "completed",
      });
    };
    seed({ runId: "dwfrun-named", name: "nightly audit", scriptText: TYPED_SCRIPT });
    seed({ runId: "dwfrun-unnamed", scriptText: TYPED_SCRIPT });
    // 全空白的 name 与没起名等价——否则列表里是一行不可点的空白。
    seed({ runId: "dwfrun-blank", name: "   ", scriptText: TYPED_SCRIPT });
    seed({ runId: "dwfrun-bare" });

    const harness = makeHarness({ journal });
    const byId = new Map(
      (await harness.service.listRunsForSession?.())?.map((summary) => [summary.runId, summary]),
    );

    expect(byId.get("dwfrun-named")?.label).toBe("nightly audit");
    expect(byId.get("dwfrun-unnamed")?.label).toBe("interface Answer { text: string }");
    expect(byId.get("dwfrun-blank")?.label).toBe("interface Answer { text: string }");
    expect(byId.get("dwfrun-bare")?.label).toBe("dwfrun-bare");
  });

  // updatedAt 直读 journal 行的 time_updated：`RunRecord` 不带时间，所以枚举面必须走窄投影
  // 的行类型（DwfRunSessionListItem）——回退到 RunRecord 会让这个字段静默变成 undefined。
  it("updatedAt 透传 journal 行的 time_updated", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      runId: "dwfrun-timed",
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      status: "completed",
    });

    const harness = makeHarness({ journal });
    const [summary] = (await harness.service.listRunsForSession?.()) ?? [];

    expect(summary?.updatedAt).toBe(journal.rowTimeOf("dwfrun-timed"));
  });

  // failure 必须活过窄投影：模型面要报 failureCode / failureMessage（「进程死了」这条事实
  // 以 Interrupted 码为第二证据），resumable 由 status === "stopped" 判定。
  it("窄投影仍带 failure，stopped(interrupted) 判可恢复", async () => {
    const journal = new SweepableJournalStore();
    preloadRun(journal, {
      runId: "dwfrun-interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: TYPED_SCRIPT,
      status: "stopped",
      stopReason: "interrupted",
    });

    const harness = makeHarness({ journal });
    const [summary] = (await harness.service.listRunsForSession?.()) ?? [];

    expect(summary).toMatchObject({
      failureCode: "Interrupted",
      failureMessage: "owning process exited",
      resumable: true,
      status: "stopped",
      stopReason: "interrupted",
    });
  });
});

// ————————————————————————————————————————————————————————————————
// amend-resume（修订续跑）：apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
// ————————————————————————————————————————————————————————————————

/**
 * 一个具名 actor 问两次 + 一次 world-read 的脚本；`tail` 参数改的是**第二问**的正文，
 * 因此 seq 0 恒命中、seq 1 恒分歧——这正是「前缀命中 / 分歧点起 live」要观察的形状。
 */
function amendScript(tail: string): string {
  return [
    "interface Answer { text: string }",
    'const w = agent("worker");',
    'const paths = await files.glob("src/**/*.ts");',
    'const first = await w.ask<Answer>("first question");',
    `const last = await w.ask<Answer>(${JSON.stringify(tail)});`,
    "return `${first.text}|${last.text}|${paths.length}`;",
  ].join("\n");
}

/**
 * 两个具名 actor 各问一次：崩溃后重建用例靠它把「未消费的导入」留在 beta 上。
 *
 * 追记 2026-09-12：persona 不再声明工具档位，所以任一 ask 分歧转 live 都会**关闭**导入缓存
 * （apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）。修订 alpha 之后 beta 的导入永远作废——崩溃后重建
 * 出来的表在这条路径上只用来证明「关门判定从事件恢复」，命中路径见 world 节点用例。
 */
const TWO_ACTOR_SCRIPT = [
  "interface Answer { text: string }",
  'const alpha = agent("alpha");',
  'const beta = agent("beta");',
  'const a = await alpha.ask<Answer>("alpha question");',
  'const b = await beta.ask<Answer>("beta question");',
  "return `${a.text}|${b.text}`;",
].join("\n");

/** 某个 run 的 node-settled 事件（含 cached 标志），按发生序。 */
function settledEvents(
  harness: Harness,
  runId: string,
): { siteId: string; ordinal: number; cached: boolean }[] {
  return harness.runEvents
    .filter((event) => event.runId === runId && event.eventType === "node-settled")
    .map((event) => {
      const instance = event.payload.instance as { siteId: string; ordinal: number };
      return { ...instance, cached: event.payload.cached === true };
    });
}

/** 模型真的被调了几次（scriptedModelAdapter 的每一轮 turn）。 */
function turnCount(harness: Harness): number {
  return harness.order.filter((entry) => entry.startsWith("turn:")).length;
}

/**
 * 把某个 run 从 `getRun` 上藏起来（前驱被清理的情形）。内存 journal 没有删除面，而这条
 * 降级路径的观察点恰好只有 getRun——Proxy 只改这一个方法，其余（含孤儿收敛 / 枚举的能力探测）
 * 原样转发。
 */
function withHiddenRun(journal: JournalStorePort, hiddenRunId: string): JournalStorePort {
  return new Proxy(journal, {
    get(target, prop) {
      if (prop === "getRun") {
        return (runId: string) => (runId === hiddenRunId ? undefined : journal.getRun(runId));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  }) as JournalStorePort;
}

// docs/dynamic-workflow/launch.md「Keeping the predecessor's script」：省略 `script` 的 AmendWorkflow
// 在 resolveInput 里经 getScript 读前驱存档的脚本——与 resume 重放的是同一份字节；`path` 修订的
// `script_unchanged` 预检读的也是它（要比**字节**，不是哈希）。它是一条单独的读面，
// 不进 getTask 快照：快照被后台追踪器轮询，脚本是端口上最大的字符串。
describe("dynamic workflow run service — getScript（修订沿用前驱的脚本）", () => {
  it("回 journal 行上逐字节的 script_text（不 trim、不改换行）", async () => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({ journal });
    const script = `${TYPED_SCRIPT}\r\n// 尾注：逐字节\n\n`;
    preloadRun(journal, { runId: "dwfrun-stored", scriptText: script, status: "errored" });

    expect(await harness.service.getScript!("dwfrun-stored")).toBe(script);
  });

  it("行上没有脚本（落库之前的老 run）与未知 run 都回 undefined", async () => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({ journal });
    preloadRun(journal, { runId: "dwfrun-scriptless", status: "completed" });

    expect(await harness.service.getScript!("dwfrun-scriptless")).toBeUndefined();
    expect(await harness.service.getScript!("dwfrun-nope")).toBeUndefined();
  });

  it("submit → createRun 的间隙里读注册表条目上的脚本", async () => {
    await withSqliteJournal(async (real) => {
      const hidden = new Set<string>();
      const harness = makeHarness({ hangActors: true, journal: hideRunsFromReads(real, hidden) });
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("get-script-gap"),
      });
      hidden.add(runId);

      expect(await harness.service.getScript!(runId)).toBe(TYPED_SCRIPT);

      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("关闭之后仍可读：它是只读面，不是启动入口", async () => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({ journal });
    preloadRun(journal, { runId: "dwfrun-closed", scriptText: TYPED_SCRIPT, status: "completed" });
    await harness.service.close();

    expect(await harness.service.getScript!("dwfrun-closed")).toBe(TYPED_SCRIPT);
  });
});

describe("dynamic workflow run service — amend 的门", () => {
  it("前驱不存在 → run_not_found，且不建任何 run", async () => {
    const journal = new SweepableJournalStore();
    const createRun = vi.spyOn(journal, "createRun");
    const harness = makeHarness({ journal });

    const result = await harness.service.amend!({
      cwd: TEST_CWD,
      predecessorRunId: "dwfrun-nope",
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-missing"),
    });

    expect(result).toEqual({ ok: false, reason: "run_not_found" });
    // 拒绝即零副作用：没有行、没有注册表条目、没有在飞引擎。
    expect(createRun).not.toHaveBeenCalled();
    expect(harness.actorRuntimeInputs).toEqual([]);
  });

  // docs/execution-engine.md「Amend-resume」：在飞的前驱不再被拒（旧 `not_amendable`），而是被 amend
  // 以 `{ superseded: newRunId }` 停下、等它结算、再导入并启动后继——一次调用，没有「停止后轮询到
  // stopped 再重提交」的竞态。
  it("前驱仍在飞 → 停下成 stopped(superseded, supersededBy)、等结算、再启动后继", async () => {
    const harness = makeHarness({ hangActors: true });
    const runA = await submitRun(harness, {
      cwd: TEST_CWD,
      name: "triage",
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-live-a"),
    });
    // 等 actor 会话建起来（ask 已派发、turn 在飞），再修订。
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });

    const amended = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: runA,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-live-b"),
    });
    const runB = amended.runId;
    expect(runB).not.toBe(runA);
    expect(amended.supersededRunId).toBe(runA);

    // amend 返回时前驱已经结算（await 的是它自己的 settlement promise，不是超时）。
    const a = harness.journal.getRun(runA);
    expect(a).toMatchObject({ status: "stopped", stopReason: "superseded", supersededBy: runB });
    expect(a?.failure).toBeUndefined();
    const snapshotA = await harness.service.getTask(runA);
    expect(snapshotA).toMatchObject({
      runStatus: "stopped",
      stopReason: "superseded",
      supersededBy: runB,
    });
    // 被替代的 run 不可恢复；后继带 lineage 指针、沿用前驱的名字。
    expect(await harness.service.resume(runA)).toEqual({ ok: false, reason: "superseded" });
    expect((await harness.service.getTask(runB))?.resumedFrom).toBe(runA);
    await vi.waitFor(() => {
      expect(harness.journal.getRun(runB)).toMatchObject({ resumedFrom: runA, name: "triage" });
    });

    // 进度载荷：前驱的 run-settled 带 supersededBy 且**不带** resumable；后继的 run-started 带 resumedFrom。
    const settledA = harness.runEvents.find(
      (event) => event.runId === runA && event.eventType === "run-settled",
    );
    expect(settledA?.payload).toMatchObject({ stopReason: "superseded", supersededBy: runB });
    expect(settledA?.payload).not.toHaveProperty("resumable");
    const startedB = harness.runEvents.find(
      (event) => event.runId === runB && event.eventType === "run-started",
    );
    expect(startedB?.payload).toMatchObject({ resumedFrom: runA });

    // 收尾：后继也挂着（同一份挂住的 actor 脚本），用户取消它。
    expect(await harness.service.cancel(runB)).toBe(true);
    await settle(harness, runB);
  });

  it("预检失败时在飞前驱不被停下", async () => {
    const harness = makeHarness({ hangActors: true });
    const runA = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-preflight-a"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });
    // 让前驱的一个已完结 ask 缺边界：预检必须在停止之前拒绝。
    harness.journal.putNode({
      runId: runA,
      siteId: "ask#99",
      ordinal: 99,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 7,
      inputHash: "h99",
      status: "completed",
      result: { text: "done" },
    });

    const result = await harness.service.amend!({
      cwd: TEST_CWD,
      predecessorRunId: runA,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-preflight-b"),
    });
    expect(result).toEqual({ ok: false, reason: "missing_boundaries" });
    expect(harness.journal.getRun(runA)?.status).toBe("running");
    expect(harness.service.countLiveRuns()).toBe(1);

    expect(await harness.service.cancel(runA)).toBe(true);
    await settle(harness, runA);
  });

  it("前驱的已完结 ask 缺边界 marker → missing_boundaries", async () => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({ journal });
    preloadRun(journal, { runId: "dwfrun-old", scriptText: TYPED_SCRIPT, status: "completed" });
    journal.putActor({
      runId: "dwfrun-old",
      siteId: "actor#1",
      ordinal: 1,
      name: "worker",
      persona: { name: "worker" },
      sessionId: "sess-old",
    });
    journal.putNode({
      runId: "dwfrun-old",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: "h0",
      status: "completed",
      result: { text: "done" },
    });

    const result = await harness.service.amend!({
      cwd: TEST_CWD,
      predecessorRunId: "dwfrun-old",
      scriptText: TYPED_SCRIPT,
      trace: traceFor("amend-no-marker"),
    });

    expect(result).toEqual({ ok: false, reason: "missing_boundaries" });
  });

  // 可修订集 = 任意终态。completed 与「脚本真失败」恰恰是 plain resume 排除、而修订最有用的两类。
  it.each(["completed", "errored", "stopped"] as const)("终态 %s 的前驱通过门", async (status) => {
    const journal = new SweepableJournalStore();
    const harness = makeHarness({ journal });
    preloadRun(journal, { runId: `dwfrun-${status}`, scriptText: TYPED_SCRIPT, status });

    const result = await harness.service.amend!({
      cwd: TEST_CWD,
      predecessorRunId: `dwfrun-${status}`,
      scriptText: TYPED_SCRIPT,
      trace: traceFor(`amend-${status}`),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 前驱早已结算：没有 supersededRunId。
    expect(result.supersededRunId).toBeUndefined();
    await settle(harness, result.runId);
    expect(harness.journal.getRun(result.runId)?.resumedFrom).toBe(`dwfrun-${status}`);
  });
});

describe("dynamic workflow run service — amend-resume 的温启动", () => {
  // docs/dynamic-workflow/launch.md「Keeping the predecessor's script」的端到端证据：真实的 AmendWorkflow
  // 工具（executor → resolveInput → getScript → prepareApproval → handler）接真实的 run service。
  // 只改并发上界的修订跑的是前驱逐字节的脚本，所以每一问都命中缓存：零 turn，上界却换成了新值。
  it("AmendWorkflow 省略 script：工具经 getScript 沿用前驱脚本，全部命中缓存、只换上界", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-keep-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      const script = amendScript("second question");
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [
            { kind: "submit", result: { text: "one" } },
            { kind: "submit", result: { text: "two" } },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: script,
        trace: traceFor("amend-keep-predecessor"),
      });
      await settle(before, runA);
      expect(journal.getRun(runA)?.caps.maxConcurrency).not.toBe(1);

      // 修订 run 的 actor 没有任何脚本化回答：只要有一问转 live，它就拿不到结果。
      const after = makeHarness({ journal, sessionStore: store as never });
      const registry = createToolRegistry();
      const amendEntry = builtInTools.find((entry) => entry.metadata.name === "AmendWorkflow");
      expect(amendEntry).toBeDefined();
      registry.register(amendEntry!);
      const sessionId = createSessionId("amend-keep-tool");
      const turnId = createTurnId("amend-keep-tool");
      const traceContext = createRootTraceContext({ sessionId, turnId });
      const permissionAsks: string[] = [];
      const executor = createToolExecutor({
        emitEvent: async () => {},
        dynamicWorkflowRunPort: after.service,
        mode: "build",
        // 前驱不属于本会话（submit 没带 parentSessionId）：会弹窗，这里一律同意。
        permissionBroker: {
          async requestPermission(request) {
            permissionAsks.push(JSON.stringify(request));
            return { decision: "allow" as const };
          },
        },
        permissionService: new PermissionService(defaultPermissionConfig),
        registry,
        sessionId,
        turnId,
        traceContext,
        workingDirectory: TEST_CWD,
      });

      const result = await executor.execute(
        {
          id: createToolCallId("amend-keep-tool"),
          input: { run_id: runA, max_concurrency: 1 },
          name: "AmendWorkflow",
        },
        { traceContext },
      );

      expect(result.success).toBe(true);
      // 确认窗审的是将要跑的那一份脚本（回填进入参），并带着「沿用」的 flag。
      expect(permissionAsks).toHaveLength(1);
      expect(permissionAsks[0]).toContain('"script_inherited":true');
      const output = result.output as { backgroundTaskId?: string; response: string };
      const runB = output.backgroundTaskId;
      expect(runB).toBeDefined();
      expect(output.response).toContain(`The script of run ${runA} started unchanged`);
      await settle(after, runB!);

      const rowB = journal.getRun(runB!);
      expect(rowB?.scriptText).toBe(script);
      expect(rowB?.caps.maxConcurrency).toBe(1);
      expect(rowB?.resumedFrom).toBe(runA);
      // 沿用的脚本也有家（docs/dynamic-workflow/launch.md「Provenance」）：前驱没记过文件，所以工具
      // 把存档的脚本落成草稿，新 run 记的就是它——下一次修订去编辑这个文件，不必内联重抄。
      const recordedScriptPath = (await after.service.getTask(runB!))?.scriptPath;
      expect(recordedScriptPath).toBeDefined();
      expect(readFileSync(recordedScriptPath!, "utf8")).toBe(script);
      expect((await after.service.getTask(runB!))?.output).toBe("one|two|0");
      expect(turnCount(after)).toBe(0);
      expect(settledEvents(after, runB!)).toEqual([
        { siteId: "world-read#1", ordinal: 1, cached: true },
        { siteId: "ask#1", ordinal: 1, cached: true },
        { siteId: "ask#2", ordinal: 1, cached: true },
      ]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // docs/dynamic-workflow/presentation.md「Subagent transcripts」与「Reduction」的端到端证据：
  // 修订 run 从空表开始，缓存命中又没有 node-queued——命中的结算必须自己点名子代理，否则 GUI 上
  // 一个全部 ask 都命中的子代理是「待开始」，点开是「尚未启动」（2026-09-22 用户报告）。
  it("修订 run 的缓存命中归到子代理名下，transcript 指向前驱里真有消息的那条会话；分歧后换回本 run 的", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-attrib-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [
            { kind: "submit", result: { text: "one" } },
            { kind: "submit", result: { text: "two" } },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: amendScript("second question"),
        trace: traceFor("amend-attrib-predecessor"),
      });
      await settle(before, runA);
      const predecessorSession = before.runEvents.find(
        (event) => event.runId === runA && event.eventType === "actor-created",
      )?.actorSessionId;
      expect(predecessorSession).toBeDefined();
      expect((await store.messages({ sessionID: predecessorSession! })).length).toBeGreaterThan(0);

      // —— 同一份脚本的修订：每一问都命中，零 turn。
      const same = makeHarness({ journal, sessionStore: store as never });
      const unchanged = await amendRun(same, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: amendScript("second question"),
        trace: traceFor("amend-attrib-same"),
      });
      await settle(same, unchanged.runId);
      expect(turnCount(same)).toBe(0);
      const ownSession = same.runEvents.find(
        (event) => event.runId === unchanged.runId && event.eventType === "actor-created",
      )?.actorSessionId;
      expect(ownSession).toBeDefined();
      expect(ownSession).not.toBe(predecessorSession);

      const cachedRun = reduceAll(same)?.runs.find((run) => run.runId === unchanged.runId);
      expect(
        cachedRun?.nodes.map((node) => [
          node.siteId,
          node.cached === true,
          node.actorSiteId === undefined ? null : `${node.actorSiteId}@${node.actorOrdinal}`,
        ]),
      ).toEqual([
        ["world-read#1", true, null],
        ["ask#1", true, "actor#1@1"],
        ["ask#2", true, "actor#1@1"],
      ]);
      expect(cachedRun?.nodes.find((node) => node.siteId === "ask#2")?.instructionsHead).toBe(
        "second question",
      );
      // 本 run 从未给它建会话：transcript 要去前驱里读，而那条会话真有消息。
      expect(cachedRun?.actors).toMatchObject([
        { siteId: "actor#1", ordinal: 1, status: "completed", sessionId: predecessorSession },
      ]);

      // —— 改了第二问的修订：第一问命中（前驱会话），第二问 live（本 run 的会话，种子里有前缀）。
      const diverged = makeHarness({
        actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "revised" } }] },
        journal,
        sessionStore: store as never,
      });
      const revised = await amendRun(diverged, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: amendScript("second question, revised"),
        trace: traceFor("amend-attrib-revised"),
      });
      await settle(diverged, revised.runId);
      const revisedSession = diverged.runEvents.find(
        (event) => event.runId === revised.runId && event.eventType === "actor-created",
      )?.actorSessionId;
      const firstSettle = diverged.runEvents.find(
        (event) =>
          event.runId === revised.runId &&
          event.eventType === "node-settled" &&
          (event.payload.instance as { siteId: string }).siteId === "ask#1",
      );
      expect(firstSettle?.payload).toMatchObject({
        cached: true,
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
        sourceSessionId: predecessorSession,
      });
      const revisedRun = reduceAll(diverged)?.runs.find((run) => run.runId === revised.runId);
      expect(revisedRun?.actors).toMatchObject([
        { siteId: "actor#1", status: "completed", sessionId: revisedSession },
      ]);
      expect((await store.messages({ sessionID: revisedSession! })).length).toBeGreaterThan(0);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("前缀零派发命中、分歧点起 live、边界与 lineage 落库", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      // —— 前驱 run：两问都 live，边界与会话都真的落库。
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [
            { kind: "submit", result: { text: "one" } },
            { kind: "submit", result: { text: "two" } },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: amendScript("second question"),
        trace: traceFor("amend-predecessor"),
      });
      await settle(before, runA);
      expect((await before.service.getTask(runA))?.output).toBe("one|two|0");
      expect(turnCount(before)).toBe(2);

      // —— 修订 run：只改第二问。
      const after = makeHarness({
        actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "revised" } }] },
        journal,
        sessionStore: store as never,
      });
      const submitted = await after.service.amend!({
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: amendScript("second question, revised"),
        trace: traceFor("amend-run"),
      });
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      const runB = submitted.runId;
      await settle(after, runB);

      // 第一问的答案原样来自前驱，第二问是新跑出来的。
      expect((await after.service.getTask(runB))?.output).toBe("one|revised|0");
      // 分歧之后的这一次派发是**唯一**一次：前缀零 token、零调用。
      expect(turnCount(after)).toBe(1);

      // world-read 与 seq 0 的 ask 都以 cached 结算；分歧的 seq 1 不是。
      const settledB = settledEvents(after, runB);
      expect(settledB).toEqual([
        { siteId: "world-read#1", ordinal: 1, cached: true },
        { siteId: "ask#1", ordinal: 1, cached: true },
        { siteId: "ask#2", ordinal: 1, cached: false },
      ]);

      // 命中必落**真行**，且边界一起拷过去——否则 runB 自己就不能再被修订（链式修订的根基）。
      const cachedNode = journal.getNode(runB, "ask#1", 1);
      const sourceNode = journal.getNode(runA, "ask#1", 1);
      expect(cachedNode?.status).toBe("completed");
      expect(cachedNode?.result).toEqual({ text: "one" });
      expect(cachedNode?.messageBoundary).toBe(sourceNode?.messageBoundary);
      expect(cachedNode?.actorSeq).toBe(0);

      // lineage 是行级事实：确认窗与详情页的「续自 run X」从它渲染。
      expect(journal.getRun(runB)?.resumedFrom).toBe(runA);
      // 前驱只读：runA 的行与节点一个字节没动。
      expect(journal.getRun(runA)?.status).toBe("completed");
      expect(journal.getRun(runA)?.resumedFrom).toBeUndefined();

      // 分歧 actor 的会话是**截断复制**出来的：新会话 id、内容为源会话的前 N 条。
      const sourceSession = journal.getActor(runA, "actor#1", 1)?.sessionId;
      const amendedSession = after.actorRuntimeInputs[0]!.sessionId;
      expect(amendedSession).not.toBe(sourceSession);
      // 会话里先有复制来的前缀，再有分歧那一问自己产的消息，所以长度**严格大于**边界。
      const seeded = await store.messages({ sessionID: amendedSession });
      expect(seeded.length).toBeGreaterThan(sourceNode!.messageBoundary!);
      // 记账在复制出来的前缀之上接着数：新 run 自己的边界 = 此刻的会话长度。count offset
      // 跨前缀复制不变，正是这条让 runB 也能再作前驱（链式修订）。
      expect(journal.getNode(runB, "ask#2", 1)?.messageBoundary).toBe(seeded.length);
      // 复制之后走既有的重水化机器，而不是另造一条水化路径。
      expect(after.resumeCalls).toContain(amendedSession);

      // pin 承袭：修订 run 的第一次派发时本 run 还没有解析结果，pin 只能来自前驱。
      expect(after.actorRuntimeInputs[0]!.pinnedModel).toBe(
        journal.getActor(runA, "actor#1", 1)?.resolvedModel,
      );
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // ————————————————————————————————————————————————————————————————
  // 在飞 ask 的接续（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
  // 「What is imported」「How the engine consumes the cache」）
  // ————————————————————————————————————————————————————————————————

  /** 一个会话里每条消息的「角色 + 正文」；种子复制会重铸 id，所以只有正文经得起跨会话比对。 */
  async function transcriptOf(
    store: { messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> },
    sessionId: SessionId,
  ): Promise<string[]> {
    const messages = await store.messages({ sessionID: sessionId });
    return messages.map((message) => {
      const text = message.parts
        .map((part) => (part.type === "text" ? part.text : `<${part.type}>`))
        .join("");
      return `${message.info.role}:${text}`;
    });
  }

  /**
   * 前驱跑到「第一问已完结、第二问在飞」再停下，用**逐字节相同**的脚本修订它。
   *
   * 这正是本特性要救的那半场对话：第二问从未结算、没有边界可导入，但它已经跑出来的那段转录
   * 仍在前驱的会话里。修订在同一位置重发同一条指令（inputHash 相符），所以新会话要从那段
   * 转录接着跑，而不是把它扔掉重来。
   */
  /**
   * 「第一问已完结、第二问在飞」的前驱，跑在**同一个** service 上（修订一个在飞 run 只能由
   * 拥有它的那个 service 停下，见 amendDynamicWorkflowRun 的在飞判定）。
   *
   * `plan` 是一张**可变**的计划表：前驱的 adapter 已经把它的挂起 promise 交出去了，不会再读；
   * 修订 run 的 actor runtime 是新造的，从下标 0 重新读这张表。所以换掉表的内容，就等于给
   * 后继换了一套回答。
   */
  async function liveMidAskPredecessor(input: {
    journal: SweepableJournalStore;
    label: string;
    quiesceMs?: number;
    script: string;
    /** 第二问的挂法：理会取消（正常 provider）还是连取消都不理（会话永远写不完）。 */
    stall: "hang-until-cancelled" | "hang";
    store: Awaited<ReturnType<typeof createSqliteSessionStore>>;
  }): Promise<{ harness: Harness; plan: ActorPlan[]; prefixBoundary: number; runA: string }> {
    const { journal, label, script, stall, store } = input;
    const plan: ActorPlan[] = [{ kind: "submit", result: { text: "one" } }, { kind: stall }];
    const harness = makeHarness({
      actorScripts: { "actor#1@1": plan },
      journal,
      ...(input.quiesceMs === undefined ? {} : { quiesceMs: input.quiesceMs }),
      sessionStore: store as never,
    });
    const runA = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: script,
      trace: traceFor(`${label}-a`),
    });
    // 等到第二问真的派发出去（第二轮 turn 已经起了）且第一问的边界已经写下。
    await vi.waitFor(() => {
      expect(turnCount(harness)).toBe(2);
      expect(journal.getNode(runA, "ask#1", 1)?.messageBoundary).toBeDefined();
    });
    // 在飞的那条 ask 有行、是 running、没有自己的边界——它正是要被接续的那一条。
    expect(journal.getNode(runA, "ask#2", 1)).toMatchObject({ status: "running", actorSeq: 1 });
    expect(journal.getNode(runA, "ask#2", 1)?.messageBoundary).toBeUndefined();
    plan.length = 0;
    plan.push({ kind: "submit", result: { text: "revised" } });
    return {
      harness,
      plan,
      prefixBoundary: journal.getNode(runA, "ask#1", 1)!.messageBoundary!,
      runA,
    };
  }

  it("前驱在飞的 ask 被同一条指令续上：新会话以前驱**整段**转录开场", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-inflight-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    const script = amendScript("second question");
    try {
      const { harness, prefixBoundary, runA } = await liveMidAskPredecessor({
        journal,
        label: "amend-inflight",
        script,
        stall: "hang-until-cancelled",
        store,
      });

      // —— 修订：脚本逐字节相同，所以第二问的 inputHash 与在飞的那条相符。
      const amended = await amendRun(harness, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: script,
        trace: traceFor("amend-inflight-b"),
      });
      const runB = amended.runId;
      expect(amended.supersededRunId).toBe(runA);
      await settle(harness, runB);

      // 前驱那半场对话确实比第一问的边界长——否则这条用例什么都没证明。
      const sourceSession = journal.getActor(runA, "actor#1", 1)!.sessionId! as SessionId;
      const predecessorTranscript = await transcriptOf(store, sourceSession);
      expect(predecessorTranscript.length).toBeGreaterThan(prefixBoundary);

      // 第一问照旧命中缓存；第二问是 live 跑的（它是那条被接续的 ask）。
      expect((await harness.service.getTask(runB))?.output).toBe("one|revised|0");
      expect(settledEvents(harness, runB)).toEqual([
        { siteId: "world-read#1", ordinal: 1, cached: true },
        { siteId: "ask#1", ordinal: 1, cached: true },
        { siteId: "ask#2", ordinal: 1, cached: false },
      ]);

      // 核心断言：新会话的开头**逐条**就是前驱的整段转录（含那半场未完的问答），
      // 而不是只到第一问的边界为止。
      const amendedSession = journal.getActor(runB, "actor#1", 1)!.sessionId! as SessionId;
      expect(amendedSession).not.toBe(sourceSession);
      const amendedTranscript = await transcriptOf(store, amendedSession);
      expect(amendedTranscript.slice(0, predecessorTranscript.length)).toEqual(
        predecessorTranscript,
      );
      // 接续之后 ask 照常 live 跑，所以会话还要更长。
      expect(amendedTranscript.length).toBeGreaterThan(predecessorTranscript.length);

      // 接续过的 ask 的 stats 不记 worldToolCalls：它的转录早于本次派发就存在，
      // 内存里的工具计数只数得到自己跑的那几轮，报 0 会被后来的修订读成「纯」。
      const carried = journal.getNode(runB, "ask#2", 1);
      expect(carried?.status).toBe("completed");
      expect(carried?.stats?.worldToolCalls).toBeUndefined();
      // 记账仍在接续来的转录之上接着数，所以 runB 也能再作前驱（链式修订的根基）。
      expect(carried?.messageBoundary).toBe(amendedTranscript.length);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  /**
   * 同一个形状，只把第二问的正文改掉：inputHash 不再相符，那半场对话就**不是**这条指令的
   * 上文了。新会话只接到第一问的边界为止，在飞那段被丢弃——也就是本特性之前的行为。
   */
  it("修订改掉了在飞的那条指令：不接续，新会话只到完结前缀的边界", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-inflight-miss-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      const { harness, prefixBoundary, runA } = await liveMidAskPredecessor({
        journal,
        label: "amend-inflight-miss",
        script: amendScript("second question"),
        stall: "hang-until-cancelled",
        store,
      });

      const amended = await amendRun(harness, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: amendScript("second question, revised"),
        trace: traceFor("amend-inflight-miss-b"),
      });
      await settle(harness, amended.runId);

      const sourceSession = journal.getActor(runA, "actor#1", 1)!.sessionId! as SessionId;
      const predecessorTranscript = await transcriptOf(store, sourceSession);
      // 前驱确实有一段在飞转录可丢（对照组与实验组面对的是同一个形状）。
      expect(predecessorTranscript.length).toBeGreaterThan(prefixBoundary);

      // 新会话的开场恰好是**前缀**那几条，在飞那段一条都没带过来。
      const amendedSession = journal.getActor(amended.runId, "actor#1", 1)!.sessionId! as SessionId;
      const amendedTranscript = await transcriptOf(store, amendedSession);
      expect(amendedTranscript.slice(0, prefixBoundary)).toEqual(
        predecessorTranscript.slice(0, prefixBoundary),
      );
      // 接续那条用例的核心断言的**直接否定**：新会话不以前驱的整段转录开场。
      expect(amendedTranscript.slice(0, predecessorTranscript.length)).not.toEqual(
        predecessorTranscript,
      );
      // 指令变了，所以前驱那半场的提问正文在新会话里根本不出现。
      expect(amendedTranscript).not.toContain(predecessorTranscript[prefixBoundary]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  /**
   * 静默闸门的端到端证据（driver 的账 → amend → 构建器）：前驱的第二问连取消都不理会，
   * 它的 turn 永远落不了地，于是那个会话「写完了没有」永远答不上来。
   *
   * 闸门到点后**不**把它当静默继续用：接续取消，完结前缀照旧导入——正是本特性之前的行为。
   */
  it("前驱会话到点仍在被写 → 不接续，完结前缀照旧导入", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-inflight-noisy-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    const script = amendScript("second question");
    try {
      const { harness, prefixBoundary, runA } = await liveMidAskPredecessor({
        journal,
        label: "amend-inflight-noisy",
        // 真等满 5 秒没有意义：闸门的上界可注入，正是为了让这条路可测。
        quiesceMs: 5,
        script,
        stall: "hang",
        store,
      });

      const amended = await amendRun(harness, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        // 指令逐字节相同——所以**只有**静默闸门能解释「没接上」。
        scriptText: script,
        trace: traceFor("amend-inflight-noisy-b"),
      });
      await settle(harness, amended.runId);

      // 前缀照旧命中（它的边界是 journal 事实，与会话此刻长不长无关）。
      expect(settledEvents(harness, amended.runId)).toEqual([
        { siteId: "world-read#1", ordinal: 1, cached: true },
        { siteId: "ask#1", ordinal: 1, cached: true },
        { siteId: "ask#2", ordinal: 1, cached: false },
      ]);
      const sourceSession = journal.getActor(runA, "actor#1", 1)!.sessionId! as SessionId;
      const predecessorTranscript = await transcriptOf(store, sourceSession);
      // 前驱确实有一段在飞转录**可以**被带走，所以「没带走」只能是闸门的功劳。
      expect(predecessorTranscript.length).toBeGreaterThan(prefixBoundary);
      const amendedSession = journal.getActor(amended.runId, "actor#1", 1)!.sessionId! as SessionId;
      const amendedTranscript = await transcriptOf(store, amendedSession);
      expect(amendedTranscript.slice(0, prefixBoundary)).toEqual(
        predecessorTranscript.slice(0, prefixBoundary),
      );
      // 指令逐字节相同，所以提问正文本来就会再出现一次——能分辨「接没接上」的只有这一条：
      // 新会话不以前驱的**整段**转录开场（在飞那半场的回答没被带过来）。
      expect(amendedTranscript.slice(0, predecessorTranscript.length)).not.toEqual(
        predecessorTranscript,
      );
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

describe("dynamic workflow run service — 脚本读到的 run 身份", () => {
  // facade 的 `run`（docs/dynamic-workflow/authoring.md「The run's identity」）：修订得到新 id、
  // `resumedFrom` 指向前驱；resume 沿用同一个 id，前驱 id 从 journal 读回——resume 的入参里
  // 没有它，读不回来脚本就会在续跑那一世看到 undefined。
  // run 身份只进返回值、不进 ask 指令（缓存键）；修订靠改问题文本分叉，好让子代理真的派发。
  const identityScript = (question: string): string =>
    [
      "interface Answer { text: string }",
      `const a = await agent("worker").ask<Answer>(${JSON.stringify(question)});`,
      'return `${run.id}|${run.resumedFrom ?? "-"}|${a.text}`;',
    ].join("\n");

  it("新 run 无前驱；amend 得新 id 并指向前驱；resume 沿用 id 与前驱", async () => {
    // amend 要读前驱的消息边界，所以会话真的落库（同「前缀零派发命中」那条用例）。
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-run-identity-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    try {
      await runIdentityLifecycle(store);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  async function runIdentityLifecycle(
    store: Awaited<ReturnType<typeof createSqliteSessionStore>>,
  ): Promise<void> {
    const journal = new SweepableJournalStore();
    const options: HarnessOptions = {
      journal,
      sessionStore: store as never,
      actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "a" } }] },
    };
    const harness = makeHarness(options);

    const runA = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: identityScript("first"),
      trace: traceFor("run-identity-a"),
    });
    await settle(harness, runA);
    expect((await harness.service.getTask(runA))?.output).toBe(`${runA}|-|a`);

    // 修订后子代理挂住，好让 run 停在可恢复的位置。
    options.actorScripts = { "actor#1@1": [{ kind: "hang" }] };
    const { runId: runB } = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: runA,
      scriptText: identityScript("amended"),
      trace: traceFor("run-identity-b"),
    });
    expect(runB).not.toBe(runA);
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs).toHaveLength(2);
    });
    expect(await harness.service.cancel(runB)).toBe(true);
    await settle(harness, runB);

    options.actorScripts = { "actor#1@1": [{ kind: "submit", result: { text: "b" } }] };
    expect(await harness.service.resume!(runB)).toMatchObject({ ok: true, runId: runB });
    await settle(harness, runB);
    expect((await harness.service.getTask(runB))?.output).toBe(`${runB}|${runA}|b`);
  }
});

describe("dynamic workflow run service — 用量沿 lineage 累计", () => {
  /**
   * 一轮 scripted turn 的 token 数（见本文件顶部 scriptedModelAdapter 的 usage）。
   * 用量断言要的是准确数字而不是「大于零」：继承来的那部分与本次现跑的那部分必须分得开。
   */
  const TOKENS_PER_TURN = 20;

  it("后继 run 从前驱总量起账：命中不加钱、live turn 才加，前驱行分文不动；链式修订按构造求和", async () => {
    // docs/dynamic-workflow/launch.md「The AmendWorkflow tool」：完成卡与详情页上的 token 是
    // **整条 lineage** 的花费。真 session store：命中要拷消息边界，而预检要求每个完结 ask 都有边界，
    // 链式修订（runB 再作前驱）全靠这条。
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-lineage-tokens-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      // —— 前驱 runA：两问都 live = 两轮 turn。
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [
            { kind: "submit", result: { text: "one" } },
            { kind: "submit", result: { text: "two" } },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: amendScript("second question"),
        trace: traceFor("lineage-tokens-a"),
      });
      await settle(before, runA);
      expect(turnCount(before)).toBe(2);
      const totalA = 2 * TOKENS_PER_TURN;
      expect(journal.getRun(runA)?.spentTokens).toBe(totalA);

      // —— 修订 runB：第一问命中、第二问 live = 一轮 turn。
      const after = makeHarness({
        actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "revised" } }] },
        journal,
        sessionStore: store as never,
      });
      const runB = await amendRun(after, {
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: amendScript("second question, revised"),
        trace: traceFor("lineage-tokens-b"),
      });
      await settle(after, runB.runId);
      expect(turnCount(after)).toBe(1);

      // 继承 + 本次现跑的一轮。命中的那一问一分钱都没有再加（它的账在继承值里）。
      const totalB = totalA + TOKENS_PER_TURN;
      expect(journal.getRun(runB.runId)?.spentTokens).toBe(totalB);
      expect(settledEvents(after, runB.runId)).toEqual([
        { siteId: "world-read#1", ordinal: 1, cached: true },
        { siteId: "ask#1", ordinal: 1, cached: true },
        { siteId: "ask#2", ordinal: 1, cached: false },
      ]);

      // 前驱只读：lineage 因此保留「上一版花了多少」这段历史。
      expect(journal.getRun(runA)?.spentTokens).toBe(totalA);

      // 投影面：run-started 把用量清零，紧跟其后的第一条 usage-updated 必须已经是继承值——
      // 否则卡片在第一轮 live turn 落地之前会显示 0（也就是「这次修订还没花钱」的假象）。
      const usageB = after.runEvents.filter(
        (event) => event.runId === runB.runId && event.eventType === "usage-updated",
      );
      expect(usageB[0]?.payload.spentTokens).toBe(totalA);
      expect(usageB.at(-1)?.payload.spentTokens).toBe(totalB);
      const typesB = after.runEvents
        .filter((event) => event.runId === runB.runId)
        .map((event) => event.eventType);
      // 补发那条落在起手序幕里：它之前只允许出现 run-started 与 run-launched（修订路一定带锚点），
      // 绝不允许任何 actor / node 事件——否则卡片在第一次派发时就已经显示过 0。
      expect(typesB.slice(0, typesB.indexOf("usage-updated"))).toEqual([
        "run-started",
        "run-launched",
      ]);

      // —— 链式修订 runC：每个前驱的数字本身已是累计值，所以求和是构造出来的，没人走 resumedFrom 链。
      const third = makeHarness({
        actorScripts: { "actor#1@1": [{ kind: "submit", result: { text: "revised twice" } }] },
        journal,
        sessionStore: store as never,
      });
      const runC = await amendRun(third, {
        cwd: TEST_CWD,
        predecessorRunId: runB.runId,
        scriptText: amendScript("second question, revised twice"),
        trace: traceFor("lineage-tokens-c"),
      });
      await settle(third, runC.runId);
      expect(turnCount(third)).toBe(1);
      expect(journal.getRun(runC.runId)?.spentTokens).toBe(totalB + TOKENS_PER_TURN);
      expect(journal.getRun(runB.runId)?.spentTokens).toBe(totalB);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("全新 submit 从零起账（继承只发生在 amend 路上）", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("lineage-tokens-fresh"),
    });
    await settle(harness, runId);
    // 头一条 usage-updated 就是本 run 自己第一轮的花费，不是继承值（缺席即零，不发补发那条）。
    const usage = harness.runEvents.filter(
      (event) => event.runId === runId && event.eventType === "usage-updated",
    );
    expect(usage[0]?.payload.spentTokens).toBe(TOKENS_PER_TURN);
    expect(harness.journal.getRun(runId)?.spentTokens).toBe(turnCount(harness) * TOKENS_PER_TURN);
  });

  it("间隙读面（dwf_run 行藏起来）报继承值而不是 0", async () => {
    // 间隙 = 注册表已有条目、journal 还没有行（藏读模拟，见 hideRunsFromReads）。修订 run 在这里
    // 报 0 会说「这条 lineage 没花钱」，而它的起点在 amend 那一刻就已确定。
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-lineage-gap-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    try {
      const real = resolveDynamicWorkflowJournalStore(store as never) as JournalStorePort &
        DwfRunIntrospectionQueries;
      const hidden = new Set<string>();
      const journal = hideRunsFromReads(real, hidden);
      // 前驱：第一问 submit（一轮 turn 的用量 + 一条消息边界，预检要它），第二问挂住后被取消。
      const harness = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "one" } }, { kind: "hang" }],
        },
        journal,
        // `hang` 的 turn 连取消都不理会，所以 amend 的静默闸门会等满上界才放行
        // （workflow-driver-quiescence.ts）。本用例算的是 token，不必陪它等 5 秒。
        quiesceMs: 5,
        sessionStore: store as never,
      });
      const predecessor = await submitRun(harness, {
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: amendScript("second question"),
        trace: traceFor("lineage-gap-a"),
      });
      await vi.waitFor(() => {
        expect(real.getRun(predecessor)?.spentTokens).toBe(TOKENS_PER_TURN);
      });
      expect(await harness.service.cancel(predecessor)).toBe(true);
      await settle(harness, predecessor);
      const inherited = real.getRun(predecessor)!.spentTokens;
      expect(inherited).toBe(TOKENS_PER_TURN);

      const amended = await amendRun(harness, {
        cwd: TEST_CWD,
        predecessorRunId: predecessor,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: amendScript("second question, revised"),
        trace: traceFor("lineage-gap-b"),
      });
      await settle(harness, amended.runId);
      // 落行后：继承值 + 本次现跑的一轮。
      expect(real.getRun(amended.runId)?.spentTokens).toBe(inherited + TOKENS_PER_TURN);

      // 藏掉行 ⇒ 走注册表间隙分支：报得出继承值（条目只知道起点，这已经比 0 诚实）。
      hidden.add(amended.runId);
      const gap = await introspectionOf(harness).getRunDetail(amended.runId);
      expect(gap?.usage).toMatchObject({ nodesObserved: 0, spentTokens: inherited });
      const listed = await introspectionOf(harness).listRuns({ cwd: TEST_CWD, limit: 8 });
      const gapRow = listed.runs.find((row) => row.runId === amended.runId);
      expect(gapRow?.spentTokens).toBe(inherited);

      // 全新 submit 的条目没有起点 ⇒ 间隙照旧报 0（继承只发生在 amend 路上）。
      const fresh = await submitRun(harness, {
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("lineage-gap-fresh"),
      });
      hidden.add(fresh);
      expect((await introspectionOf(harness).getRunDetail(fresh))?.usage.spentTokens).toBe(0);
      hidden.delete(fresh);
      await harness.service.cancel(fresh);
      await settle(harness, fresh);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

describe("dynamic workflow run service — amend-resume 的崩溃后重建", () => {
  it("崩溃后 resume：alpha 曾 live 但没写过工作区 ⇒ 门没关，beta 仍从导入表结算；journal pin 压过承袭的 seed pin", async () => {
    // apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Amend-resume」：runB 里 alpha 分歧转 live 并挂住；进程没了。
    // 转 live 本身不关门——alpha 一个字节都没写，beta 读的工作区就是前驱留下的那个。resume 重建导入表后
    // beta 照常命中。（这条曾断言相反的结论：那时「任一 ask live 即关门」，是拿时钟代替依赖。）
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-resume-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "alpha-1" } }],
          "actor#2@1": [{ kind: "submit", result: { text: "beta-1" } }],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: TWO_ACTOR_SCRIPT,
        trace: traceFor("amend-two-actor"),
      });
      await settle(before, runA);

      // 修订：只改 alpha 的问题 → alpha 在 seq 0 分歧转 live 并挂住，beta 尚未排队。
      const crashed = makeHarness({ hangActors: true, journal, sessionStore: store as never });
      const submitted = await crashed.service.amend!({
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: TWO_ACTOR_SCRIPT.replace("alpha question", "alpha question, revised"),
        trace: traceFor("amend-crash"),
      });
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      const runB = submitted.runId;
      await vi.waitFor(() => {
        expect(crashed.actorRuntimeInputs.length).toBeGreaterThan(0);
      });
      expect(await crashed.service.cancel(runB)).toBe(true);
      await settle(crashed, runB);
      // 取消发生在 beta 之前：beta 在 runB 的 journal 里没有任何行；也没有关门事件。
      expect(
        journal
          .listNodes(runB, { kinds: "all", withResult: true })
          .some((node) => node.actorSiteId === "actor#2"),
      ).toBe(false);
      expect(
        journal
          .listEvents(runB, { types: "all", reportItems: "all" })
          .some(({ event }) => event.type === "import-cache-closed"),
      ).toBe(false);

      // journal pin 必须压过承袭的 seed pin：本 run 里实际跑过的模型比前驱的更具体。
      // 两者本应相等，所以这里把 runB 的记录改成一个哨兵值，好让「谁赢」成为可断言的事实。
      const alphaRow = journal.getActor(runB, "actor#1", 1)!;
      journal.putActor({ ...alphaRow, resolvedModel: "sentinel/from-journal" });

      const resumed = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "alpha-2" } }],
          "actor#2@1": [{ kind: "submit", result: { text: "beta-2" } }],
        },
        journal,
        sessionStore: store as never,
      });
      const outcome = await resumed.service.resume?.(runB);
      expect(outcome?.ok).toBe(true);
      await settle(resumed, runB);

      // beta 从重建出来的导入表结算：门从未关过，只有 alpha 真的跑了。
      expect((await resumed.service.getTask(runB))?.output).toBe("alpha-2|beta-1");
      expect(turnCount(resumed)).toBe(1);
      expect(resumed.actorRuntimeInputs.map((input) => refToString(input.actor))).toEqual([
        "actor#1@1",
      ]);
      expect(settledEvents(resumed, runB)).toContainEqual({
        siteId: "ask#2",
        ordinal: 1,
        cached: true,
      });
      expect(journal.getNode(runB, "ask#2", 1)?.result).toEqual({ text: "beta-1" });

      expect(resumed.actorRuntimeInputs[0]!.pinnedModel).toBe("sentinel/from-journal");
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("崩溃后 resume：alpha 真的写了文件 ⇒ 执行器 → driver → 引擎关门；beta live 重跑（关门判定从 import-cache-closed 恢复）", async () => {
    // 同一场景，两处不同：
    //   1. runA 的 beta **用过工具**（一次 Write），所以它的缓存条目不是「纯」的——它可能读过工作区；
    //   2. runB 的 alpha 挂住之前先调了一次真的 `Write`。执行器在 handler 之前发出带
    //      readOnly:false / sideEffectScope:"workspace" 的 ToolCallStarted，driver 的工具活动观察上报
    //      askMutating，引擎记下 import-cache-closed。
    // resume 只认那条事件；beta 于是 live 重跑——它读的工作区可能已被 alpha 改过。
    // （工具在这套夹具里会因 fakeFileSystemPort 而失败，无妨：ToolCallStarted 在 handler 之前就发了，
    //   而这条链要验的正是「调用发生过」。）
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-resume-write-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "alpha-1" } }],
          "actor#2@1": [
            { kind: "write", path: join(TEST_CWD, "beta-notes.md"), content: "beta was here" },
            { kind: "submit", result: { text: "beta-1" } },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: TWO_ACTOR_SCRIPT,
        trace: traceFor("amend-two-actor-write"),
      });
      await settle(before, runA);
      // 夹具前提：beta 在 runA 里确实碰过外部世界（一次 Write），所以它的条目在关门后不再命中；
      // alpha 只交了结果，它的 worldToolCalls 是 0（`submit_result` 只计入 toolCalls）——纯条目，
      // 关门后照样命中（上一条用例走的正是这条路）。
      expect(journal.getNode(runA, "ask#2", 1)?.stats?.worldToolCalls ?? 0).toBeGreaterThan(0);
      expect(journal.getNode(runA, "ask#1", 1)?.stats?.worldToolCalls).toBe(0);

      const crashed = makeHarness({
        actorScripts: {
          "actor#1@1": [
            { kind: "write", path: join(TEST_CWD, "notes.md"), content: "alpha was here" },
            { kind: "hang" },
          ],
        },
        journal,
        sessionStore: store as never,
      });
      const submitted = await crashed.service.amend!({
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: TWO_ACTOR_SCRIPT.replace("alpha question", "alpha question, revised"),
        trace: traceFor("amend-crash-write"),
      });
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      const runB = submitted.runId;
      // 等到关门事件落 journal：这是整条链（工具层 → driver → 引擎）跑通的证据。
      await vi.waitFor(() => {
        expect(
          journal
            .listEvents(runB, { types: "all", reportItems: "all" })
            .some(({ event }) => event.type === "import-cache-closed"),
        ).toBe(true);
      });
      const closed = journal
        .listEvents(runB, { types: "all", reportItems: "all" })
        .find(({ event }) => event.type === "import-cache-closed")!.event;
      expect(closed).toMatchObject({
        type: "import-cache-closed",
        instance: { siteId: "ask#1", ordinal: 1 },
        cause: "mutating-tool",
        actorName: "alpha",
      });
      expect(await crashed.service.cancel(runB)).toBe(true);
      await settle(crashed, runB);
      expect(
        journal
          .listNodes(runB, { kinds: "all", withResult: true })
          .some((node) => node.actorSiteId === "actor#2"),
      ).toBe(false);

      const resumed = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "alpha-2" } }],
          "actor#2@1": [{ kind: "submit", result: { text: "beta-2" } }],
        },
        journal,
        sessionStore: store as never,
      });
      const outcome = await resumed.service.resume?.(runB);
      expect(outcome?.ok).toBe(true);
      await settle(resumed, runB);

      expect((await resumed.service.getTask(runB))?.output).toBe("alpha-2|beta-2");
      expect(turnCount(resumed)).toBe(2);
      expect(resumed.actorRuntimeInputs.map((input) => refToString(input.actor))).toEqual([
        "actor#1@1",
        "actor#2@1",
      ]);
      expect(settledEvents(resumed, runB)).toContainEqual({
        siteId: "ask#2",
        ordinal: 1,
        cached: false,
      });
      expect(journal.getNode(runB, "ask#2", 1)?.result).toEqual({ text: "beta-2" });
      // resume 不重发关门事件：判定是恢复出来的，不是新发生的。
      expect(
        resumed.runEvents.filter(
          (event) => event.runId === runB && event.eventType === "import-cache-closed",
        ),
      ).toHaveLength(0);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("前驱被清理 → resume 仍成功，未消费的导入降级为 live 重跑", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-amend-lost-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      const before = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "alpha-1" } }],
          "actor#2@1": [{ kind: "submit", result: { text: "beta-1" } }],
        },
        journal,
        sessionStore: store as never,
      });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: TWO_ACTOR_SCRIPT,
        trace: traceFor("amend-lost-predecessor"),
      });
      await settle(before, runA);

      const crashed = makeHarness({ hangActors: true, journal, sessionStore: store as never });
      const submitted = await crashed.service.amend!({
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: TWO_ACTOR_SCRIPT.replace("alpha question", "alpha question, revised"),
        trace: traceFor("amend-lost-crash"),
      });
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      const runB = submitted.runId;
      await vi.waitFor(() => {
        expect(crashed.actorRuntimeInputs.length).toBeGreaterThan(0);
      });
      await crashed.service.cancel(runB);
      await settle(crashed, runB);

      // 前驱 journal 是修订 run 的**存续依赖，但只是加速结构**：丢了变贵，不变错。
      const resumed = makeHarness({
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "alpha-2" } }],
          "actor#2@1": [{ kind: "submit", result: { text: "beta-live" } }],
        },
        journal: withHiddenRun(journal, runA),
        sessionStore: store as never,
      });
      const outcome = await resumed.service.resume?.(runB);
      expect(outcome?.ok).toBe(true);
      await settle(resumed, runB);

      // beta 这次真的跑了模型，答案随之不同——退化的是账单，不是正确性。
      expect((await resumed.service.getTask(runB))?.output).toBe("alpha-2|beta-live");
      expect(turnCount(resumed)).toBe(2);
      expect(
        resumed.logs.some(
          (entry) => entry.context?.event === "dynamic_workflow.amend.rebuild_skipped",
        ),
      ).toBe(true);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

describe("dynamic workflow run service — 升级问答（escalation）", () => {
  /**
   * 起一个 run、等它把 ask 派下去，回 actor 会话的升级端口。
   *
   * `hangActors` 让模型永不 resolve——那正是一次被升级问答阻塞住的 turn 的形状，也是唯一
   * 能让「问题停驻期间 run 照常在飞」成为可断言事实的装配。
   */
  async function inflightEscalatePort(
    harness: Harness,
    name: string,
  ): Promise<{ runId: string; port: WorkflowEscalatePort }> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor(name),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0);
    });
    // ask 真正派下去（driver 记下 currentInstance）之后才谈得上停驻。
    await vi.waitFor(() => {
      expect(harness.runEvents.some((event) => event.eventType === "node-dispatched")).toBe(true);
    });
    const port = harness.actorRuntimeInputs[0]?.escalatePort;
    if (port === undefined) throw new Error("actor runtime 输入里没有 escalatePort");
    return { runId, port };
  }

  it("停驻的问题出现在快照的 pendingQuestions 里，作答后就地清空", async () => {
    const harness = makeHarness({ hangActors: true });
    const { runId, port } = await inflightEscalatePort(harness, "escalation-snapshot");

    const answered = port.escalate({
      toolCallId: createToolCallId("escalate-1"),
      question: "评分上限 95 而通过门槛 96，这个门是不是坏了？",
      trace: traceFor("escalation-snapshot"),
    });

    // 快照兜底：通知被丢弃时，主代理仍能从这里重新发现待答问题。
    const blocked = await harness.service.getTask(runId);
    expect(blocked?.pendingQuestions).toHaveLength(1);
    const question = blocked?.pendingQuestions?.[0];
    expect(question).toMatchObject({
      actor: "actor#1@1",
      // 脚本是 `agent("worker")`，所以有效名一路到达快照——通知面与侧栏因此不必各自
      // 回查 journal.listActors（那份重复迟早会与实时轨对不上）。
      actorName: "worker",
      question: "评分上限 95 而通过门槛 96，这个门是不是坏了？",
    });
    // run 状态全程不动：升级是 ask 内部的一次慢工具调用，不是 run 生命周期事件。
    expect(blocked?.status).toBe("running");
    // 实时轨（侧栏据它渲染）与快照兜底（通知丢弃后据它自愈）报同一个提问时刻——
    // 两条读面上的「已等待 N 分钟」因此不会各说各话。
    const raisedPayload = harness.runEvents.find(
      (event) => event.eventType === "escalation-raised",
    )?.payload;
    expect(raisedPayload?.askedAt).toBe(question?.askedAt);

    const outcome = await harness.service.resolveQuestion?.(question!.qid, "门坏了，按 95 通过。");
    expect(outcome).toEqual({ ok: true, qid: question!.qid });
    await expect(answered).resolves.toMatchObject({
      kind: "answered",
      answer: "门坏了，按 95 通过。",
    });

    const after = await harness.service.getTask(runId);
    // 零条时整字段缺席（与 reports 同规），不发空数组。
    expect(after).not.toHaveProperty("pendingQuestions");
    expect(after?.status).toBe("running");
  });

  // 通知丢弃后的**查询兜底**，也是模型侧唯一的发现面：`ResolveWorkflowQuestion` 只认 qid，
  // 而升级通知有两条已知的丢弃路径（stale branch generation / shutdown）。快照面服务后台
  // 任务追踪器，本条服务 `GetWorkflowRun`——两条读面同源同投影，缺了这一条，通知文案与
  // `unknown_question` 的服务端文案都会指向一个什么都不返回的工具。
  it("停驻的问题同样出现在 getRunDetail 里（GetWorkflowRun 的取数面）", async () => {
    // sqlite journal：getRunDetail / listRuns 是内省查询面，内存 journal 不带它们。
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ hangActors: true, journal });
      const { runId, port } = await inflightEscalatePort(harness, "escalation-detail");

      const answered = port.escalate({
        toolCallId: createToolCallId("escalate-detail"),
        question: "两条指令互相矛盾，先满足哪一条？",
        context: "第 3 步要求保留原文，第 5 步要求改写。",
        trace: traceFor("escalation-detail"),
      });

      const detail = await introspectionOf(harness).getRunDetail(runId);
      expect(detail?.pendingQuestions).toHaveLength(1);
      const question = detail?.pendingQuestions?.[0];
      expect(question).toMatchObject({
        actor: "actor#1@1",
        actorName: "worker",
        question: "两条指令互相矛盾，先满足哪一条？",
        context: "第 3 步要求保留原文，第 5 步要求改写。",
      });
      // 与快照同源同投影：同一个 run 在两条读面上必须给出同一个 qid 与同一个提问时刻，
      // 否则「已等待多久」在两处各说各话。
      const snapshotQuestion = (await harness.service.getTask(runId))?.pendingQuestions?.[0];
      expect(question?.qid).toBe(snapshotQuestion?.qid);
      expect(question?.askedAt).toBe(snapshotQuestion?.askedAt);
      // run 状态全程不动。
      expect(detail?.status).toBe("running");

      await harness.service.resolveQuestion?.(question!.qid, "以第 5 步为准。");
      await expect(answered).resolves.toMatchObject({ kind: "answered" });

      // 零条时整字段缺席（与快照同规，不发空数组）。
      expect(await introspectionOf(harness).getRunDetail(runId)).not.toHaveProperty(
        "pendingQuestions",
      );

      // actor 的 turn 仍然挂着（hangActors）；收口后再关库，避免写进一个已关闭的 store。
      await harness.service.cancel(runId);
      await settle(harness, runId);
    });
  });

  it("raised / resolved 两类事件都进了实时轨与事件分页", async () => {
    const harness = makeHarness({ hangActors: true });
    const { runId, port } = await inflightEscalatePort(harness, "escalation-events");

    const answered = port.escalate({
      toolCallId: createToolCallId("escalate-2"),
      question: "这个门坏了吗？",
      trace: traceFor("escalation-events"),
    });
    const qid = (await harness.service.getTask(runId))?.pendingQuestions?.[0]?.qid;
    await harness.service.resolveQuestion?.(qid!, "坏了。");
    await answered;

    // 实时轨：progress sink 收到的载荷（Slice 2 的通知生产者读的就是它）。
    const raised = harness.runEvents.find((event) => event.eventType === "escalation-raised");
    // 通知生产者（Slice 2）读的就是这份载荷：结构 ref 定位、actorName 供人读、askedAt 供算等待时长。
    expect(raised?.payload).toMatchObject({
      qid,
      actorName: "worker",
      question: "这个门坏了吗？",
    });
    expect(typeof raised?.payload.askedAt).toBe("number");
    expect(
      harness.runEvents.find((event) => event.eventType === "escalation-resolved")?.payload,
    ).toMatchObject({ answer: "坏了。", qid });

    // durable 轨：既有的事件分页面原样承载新种类（协议层 type 是不透明字符串，契约零加值）。
    const { events: page } = await harness.service.listEvents(runId, {});
    expect(
      page.filter((event) => event.type.startsWith("escalation-")).map((one) => one.type),
    ).toEqual(["escalation-raised", "escalation-resolved"]);
    // sequence 与 journal 的分配一致（driver 侧的 record 与引擎的 record 走同一条截取）。
    expect(page.find((one) => one.type === "escalation-raised")?.sequence).toBe(raised?.sequence);
  });

  it("三类结构化拒绝：未知 id / 已回答 / 不在飞", async () => {
    const harness = makeHarness({ hangActors: true });
    const { runId, port } = await inflightEscalatePort(harness, "escalation-refusals");

    // (1) 未知 id（含死 run 的陈旧 id：停驻项不持久化，重启后都长这样）。
    expect(await harness.service.resolveQuestion?.("dwfq-nonesuch-1", "答案")).toMatchObject({
      ok: false,
      reason: "unknown_question",
    });

    // (2) 已回答。
    const answered = port.escalate({
      toolCallId: createToolCallId("escalate-3"),
      question: "第一个问题",
      trace: traceFor("escalation-refusals"),
    });
    const firstQid = (await harness.service.getTask(runId))?.pendingQuestions?.[0]?.qid;
    await harness.service.resolveQuestion?.(firstQid!, "答案一");
    await answered;
    expect(await harness.service.resolveQuestion?.(firstQid!, "答案二")).toMatchObject({
      ok: false,
      reason: "already_resolved",
    });

    // (3) run 被取消 → 停驻项随 cancelAsk 撤下 → 之后作答得到 run_not_in_flight。
    const cancelled = port.escalate({
      toolCallId: createToolCallId("escalate-4"),
      question: "第二个问题",
      trace: traceFor("escalation-refusals"),
    });
    const secondQid = (await harness.service.getTask(runId))?.pendingQuestions?.[0]?.qid;
    expect(await harness.service.cancel(runId)).toBe(true);
    await expect(cancelled).rejects.toMatchObject({ code: "Cancelled" });
    await settle(harness, runId);

    expect(await harness.service.resolveQuestion?.(secondQid!, "答案三")).toMatchObject({
      ok: false,
      reason: "run_not_in_flight",
    });
    // 取消的语义与今天逐字节一致：ask 拒 Cancelled，run 结算 cancelled（因而可 resume）。
    expect((await harness.service.getTask(runId))?.status).toBe("cancelled");
  });

  it("一张停驻表跨本服务的多个在飞 run，qid 互不碰撞且 pendingQuestions 按 run 隔离", async () => {
    const harness = makeHarness({ hangActors: true });
    const first = await inflightEscalatePort(harness, "escalation-multi-a");
    const secondRunId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("escalation-multi-b"),
    });
    await vi.waitFor(() => {
      expect(harness.actorRuntimeInputs.length).toBe(2);
    });
    await vi.waitFor(() => {
      expect(
        harness.runEvents.filter((event) => event.eventType === "node-dispatched").length,
      ).toBe(2);
    });
    const secondPort = harness.actorRuntimeInputs[1]!.escalatePort;

    void first.port
      .escalate({
        toolCallId: createToolCallId("escalate-a"),
        question: "A 的问题",
        trace: traceFor("escalation-multi-a"),
      })
      .catch(() => {});
    void secondPort
      .escalate({
        toolCallId: createToolCallId("escalate-b"),
        question: "B 的问题",
        trace: traceFor("escalation-multi-b"),
      })
      .catch(() => {});

    const left = (await harness.service.getTask(first.runId))?.pendingQuestions;
    const right = (await harness.service.getTask(secondRunId))?.pendingQuestions;
    expect(left?.map((one) => one.question)).toEqual(["A 的问题"]);
    expect(right?.map((one) => one.question)).toEqual(["B 的问题"]);
    // qid 全局唯一正是「resolveQuestion 只收一个不透明 token」的前提。
    expect(left?.[0]?.qid).not.toBe(right?.[0]?.qid);
  });
});

// ————————————————————————————————————————————————
// 升级问答的端到端闭环（Slice 4）。
//
// 上面那组用例由测试自己持端口扮演模型；这一组把两端都交给真东西：actor 的**模型**发一次
// `escalate` 工具调用，主会话的**模型**发一次 `ResolveWorkflowQuestion` 工具调用，两条路各自
// 经真实工具层（注册门 → 权限 → handler → 端口）落到同一张停驻表上。
//
// 只有在这一层才证明得了、而端口层用例结构上看不见的三件事：
//   1. `escalate` 真的出现在 actor 那一轮的工具面上（端口在场 → includeEscalate → 注册表）。
//      中间任何一环漏掉，端口层的断言仍然全绿，而 actor 撞上坏门时手里根本没有这个工具；
//   2. 答案**逐字**作为工具结果回到 actor 的下一次模型请求——那是「带着答案继续干活」的唯一
//      物理通道，也是 spec 里「问答对整体生活在 actor 轮次转录内部」这条缓存不变式的实处；
//   3. 主代理侧零新接线：一个手上只有 qid 的普通会话，用既有工具面就能把 actor 放行。
// ————————————————————————————————————————————————
describe("dynamic workflow run service — 升级问答的端到端闭环", () => {
  /**
   * 主会话的替身：一个真实 AgentRuntime，注入本服务作为 dwf run 端口（生产里主代理就是这样
   * 拿到 `ResolveWorkflowQuestion` 的——该工具无注册门，端口缺席时才回结构化失败）。模型按
   * 计划先发一次工具调用，再收一段文本结束 turn。
   */
  function mainSessionRuntime(
    service: Harness["service"],
    call: () => { question_id: string; answer: string },
  ): { runtime: AgentRuntime; log: ModelRequestLog } {
    const log: ModelRequestLog = { requests: [] };
    let index = 0;
    const usage = { inputTokens: 9, outputTokens: 4, totalTokens: 13 };
    const runtime = createTestAgentRuntime(
      createSessionId("escalation-main"),
      {
        systemPrompt: "You created this workflow.",
        mode: "yolo",
        subagents: { enabled: false },
        workingDirectory: TEST_CWD,
      },
      {
        dynamicWorkflowRunPort: service,
        eventStore: createInMemorySessionEventStore(),
        fileSystemPort: fakeFileSystemPort({}),
        modelAdapter: {
          async generateText(request?: {
            messages?: unknown;
            tools?: readonly { name: string }[];
          }) {
            log.requests.push({ messages: request?.messages, tools: request?.tools });
            if (index++ > 0) {
              return {
                finishReason: "stop",
                model: "scripted",
                providerMetadata: undefined,
                text: "answered.",
                usage,
              };
            }
            return {
              finishReason: "tool-calls",
              model: "scripted",
              providerMetadata: undefined,
              text: "",
              toolCalls: [
                {
                  id: "resolve-question-call-1",
                  name: RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
                  input: call(),
                },
              ],
              usage,
            };
          },
        } as never,
      },
    );
    return { runtime, log };
  }

  /** 起 run 并等第一个问题停驻（主代理侧的发现面就是这张快照）。 */
  async function runUntilParked(
    harness: Harness,
    name: string,
  ): Promise<{
    runId: string;
    question: NonNullable<DynamicWorkflowRunDetail["pendingQuestions"]>[number];
  }> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor(name),
    });
    await vi.waitFor(async () => {
      expect((await harness.service.getTask(runId))?.pendingQuestions).toHaveLength(1);
    });
    const question = (await harness.service.getTask(runId))?.pendingQuestions?.[0];
    if (question === undefined) throw new Error("停驻的问题没有出现在快照里");
    return { runId, question };
  }

  const QUESTION = "评分上限 95 而通过门槛 96，这个门是不是坏了？";
  const CONTEXT = "每一项都已拉满，总分仍然是 95。";
  const ANSWER = "门确实坏了：按 95 分通过即可，不要为了凑 96 去改评分口径。";

  it("actor 的模型提问 → 主代理的模型作答 → 答案逐字回到 actor → ask 照常 settle", async () => {
    const harness = makeHarness({
      actorScripts: {
        "actor#1@1": [
          { kind: "escalate", question: QUESTION, context: CONTEXT },
          // 拿到答案之后 actor 继续干活并提交——escalate 不终止 turn，这一步就是证据。
          { kind: "submit", result: { text: "按 95 通过" } },
        ],
      },
    });

    const { runId, question } = await runUntilParked(harness, "escalation-loop");
    expect(question).toMatchObject({
      actor: "actor#1@1",
      actorName: "worker",
      question: QUESTION,
      context: CONTEXT,
    });
    expect(question.qid).toMatch(/^dwfq-/);

    // (1) 工具面：actor 的第一次模型请求里真的带着 escalate。
    const actorRequests = harness.actorModelRequests["actor#1@1"];
    expect(actorRequests?.requests[0]?.tools?.map((tool) => tool.name)).toContain(
      ESCALATE_TOOL_NAME,
    );

    // (2) 主代理侧：一次真的 ResolveWorkflowQuestion 工具调用（手上只有 qid）。
    const main = mainSessionRuntime(harness.service, () => ({
      question_id: question.qid,
      answer: ANSWER,
    }));
    await main.runtime.executeTurn(
      `工作流 run ${runId} 有一个待答问题 ${question.qid}，去回答它。`,
    );

    await settle(harness, runId);
    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.output).toBe("按 95 通过");
    // 结算后停驻表就地清空（零条时整字段缺席）。
    expect(snapshot).not.toHaveProperty("pendingQuestions");

    // (3) 答案逐字回到 actor 的下一次模型请求：这是 actor「带着答案继续」的唯一通道。
    expect(actorRequests?.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(actorRequests?.requests[1]?.messages)).toContain(ANSWER);

    // 主代理拿到的回执带着 qid（「答案已送达、run 并没有因此停下」）。
    expect(JSON.stringify(main.log.requests[1]?.messages)).toContain(question.qid);

    // 事件双轨按序：raised 在前，resolved 在后。
    expect(
      harness.runEvents
        .filter((event) => event.eventType.startsWith("escalation-"))
        .map((event) => event.eventType),
    ).toEqual(["escalation-raised", "escalation-resolved"]);
  });

  it("停驻期间取消 run：actor 的 escalate 调用被打断，之后作答得到 run_not_in_flight", async () => {
    // spec 的「无答案 = 无限期阻塞」有且只有一个逃生舱，就是既有的 cancel。这条用例把它钉在
    // 工具层：停驻的不是一个测试持有的 promise，而是 actor 真实轮次里的一次工具调用。
    const harness = makeHarness({
      actorScripts: {
        "actor#1@1": [
          { kind: "escalate", question: "要不要干脆跳过这个检查？" },
          { kind: "submit", result: { text: "不该走到这里" } },
        ],
      },
    });

    const { runId, question } = await runUntilParked(harness, "escalation-loop-cancel");
    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("cancelled");
    expect(snapshot).not.toHaveProperty("pendingQuestions");
    // 陈旧 qid 的作答得到结构化拒绝，而不是静默成功——静默成功会让主代理以为自己已经答过了。
    expect(await harness.service.resolveQuestion?.(question.qid, "太晚了")).toMatchObject({
      ok: false,
      reason: "run_not_in_flight",
    });
  });
});

// 阶段进入记录的接缝（docs/dynamic-workflow/presentation.md）：引擎发的
// phase-entered 经 toProgressPayload 有界化后，共享 reducer 真的能归约出 phases / currentPhase。
describe("dynamic workflow run service · phase-entered", () => {
  it("引擎发出的 phase-entered 经进度管线归约成 workflowRuns.phases 与 currentPhase", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: [
        'phase("Prepare");',
        'log("start");',
        "for (let i = 0; i < 2; i++) {",
        '  phase("Work");',
        "  report({ round: i });",
        "}",
        'phase("Wrap up");',
        'return "done";',
      ].join("\n"),
      trace: traceFor("phase-entered"),
    });
    await settle(harness, runId);
    expect(harness.journal.getRun(runId)).toMatchObject({ status: "completed" });

    const entered = harness.runEvents.filter((event) => event.eventType === "phase-entered");
    expect(entered.map((event) => event.payload)).toEqual([
      { name: "Prepare", ordinal: 1 },
      { name: "Work", ordinal: 1 },
      { name: "Work", ordinal: 2 },
      { name: "Wrap up", ordinal: 1 },
    ]);

    let state: WorkflowRunsState | undefined;
    for (const event of harness.runEvents) {
      state = reduceWorkflowRunsState(state, event as WorkflowRunProgressEnvelope) ?? state;
    }
    expect(state?.runs[0]?.phases).toEqual([
      { name: "Prepare", rounds: 1 },
      { name: "Work", rounds: 2 },
      { name: "Wrap up", rounds: 1 },
    ]);
    expect(state?.runs[0]?.currentPhase).toBe("Wrap up");
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });
});

// ————————————————————————————————————————————————————————————————
// 出生阶段（docs/dynamic-workflow/presentation.md）
// ————————————————————————————————————————————————————————————————

/**
 * 一个横跨「标记之前 / Prepare / Work」的脚本：每段各建一个 actor 并问一次，Prepare 里另有
 * 一次 world-read。三类出生事件（actor-created / node-queued / cached node-settled）与
 * 「标记之前不带戳」在同一条脚本上同时可观察。
 */
const BIRTH_PHASE_SCRIPT = [
  "interface Answer { text: string }",
  'const solo = agent("solo");',
  'const s = await solo.ask<Answer>("before any marker");',
  'phase("Prepare");',
  'const prep = agent("prep");',
  'const p = await prep.ask<Answer>("prepare question");',
  'const paths = await files.glob("src/**/*.ts");',
  'phase("Work");',
  'const worker = agent("worker");',
  'const w = await worker.ask<Answer>("work question");',
  "return `${s.text}|${p.text}|${w.text}|${paths.length}`;",
].join("\n");

/**
 * 出生事件上的阶段坐标：把 `actor-created` / `node-queued` / `node-settled` 压成
 * (类型, 实例, 戳) 三元组。`phaseName` **缺席**与「值为 undefined」在这里是两件事——引擎只在
 * 出生事件上打戳，其余事件必须一个键都不带——所以按 in 判断条件展开，断言侧用 toStrictEqual。
 */
function birthStamps(harness: Harness): { type: string; ref: string; phaseName?: string }[] {
  return harness.runEvents
    .filter(
      (event) =>
        event.eventType === "actor-created" ||
        event.eventType === "node-queued" ||
        event.eventType === "node-settled",
    )
    .map((event) => {
      const payload = event.payload as {
        actor?: { siteId: string; ordinal: number };
        instance?: { siteId: string; ordinal: number };
        phaseName?: string;
      };
      // instance 优先：node-* 的载荷两个键都有，出生的是 instance 那个。
      const ref = payload.instance ?? payload.actor;
      return {
        type: `${event.eventType}${event.payload.cached === true ? "(cached)" : ""}`,
        ref: `${ref?.siteId}@${ref?.ordinal}`,
        ...("phaseName" in payload ? { phaseName: payload.phaseName } : {}),
      };
    });
}

/** 载荷点名的实例键（`instance` 优先，没有就取 `actor`）。 */
function refOfPayload(payload: Record<string, unknown>): string {
  const ref = (payload.instance ?? payload.actor) as
    | { siteId: string; ordinal: number }
    | undefined;
  return `${ref?.siteId}@${ref?.ordinal}`;
}

/** 归约后的实例 → 阶段坐标（缺席即 undefined）。 */
function reducedPhaseNames(state: WorkflowRunsState | undefined): {
  actors: [string, string | undefined][];
  nodes: [string, string | undefined][];
} {
  const run = state?.runs[0];
  return {
    actors: (run?.actors ?? []).map((actor) => [
      `${actor.siteId}@${actor.ordinal}`,
      actor.phaseName,
    ]),
    nodes: (run?.nodes ?? []).map((node) => [`${node.siteId}@${node.ordinal}`, node.phaseName]),
  };
}

/** 事件流逐条归约（每个用例都要走一遍完整的进度管线）。 */
function reduceAll(harness: Harness): WorkflowRunsState | undefined {
  let state: WorkflowRunsState | undefined;
  for (const event of harness.runEvents) {
    state = reduceWorkflowRunsState(state, event as WorkflowRunProgressEnvelope) ?? state;
  }
  return state;
}

/**
 * 运行时实例带阶段坐标的接缝（追记 2026-09-09）：引擎在**出生事件**上打的 `phaseName` 经
 * `toProgressPayload` 原样过境，再由共享 reducer 落到 `actors[*]` / `nodes[*]` 上。
 *
 * 这条接缝正是「所有子代理出现在所有阶段」那个 bug 的修复面：静态图按阶段拷贝站点，运行时
 * 实例必须带同一个坐标，UI 才能按 (站点, 阶段) 而不是按车道绑定。
 */
describe("dynamic workflow run service · 出生阶段（phaseName）", () => {
  it("标记前出生的实例不带戳、Prepare / Work 各带各的；派发与 live 结算不带，且归约后落到 actors / nodes 上", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: BIRTH_PHASE_SCRIPT,
      trace: traceFor("birth-phase"),
    });
    await settle(harness, runId);
    expect(harness.journal.getRun(runId)).toMatchObject({ status: "completed" });

    // 出生事件：标记之前的一个键都不带；标记之后的按**出生时**所在阶段带。
    // live 的 node-settled 不是出生事件，因此同样不带（戳靠 reducer 从 queued 向前携带）。
    expect(birthStamps(harness)).toStrictEqual([
      { type: "actor-created", ref: "actor#1@1" },
      { type: "node-queued", ref: "ask#1@1" },
      { type: "node-settled", ref: "ask#1@1" },
      { type: "actor-created", ref: "actor#2@1", phaseName: "Prepare" },
      { type: "node-queued", ref: "ask#2@1", phaseName: "Prepare" },
      { type: "node-settled", ref: "ask#2@1" },
      { type: "node-queued", ref: "world-read#1@1", phaseName: "Prepare" },
      { type: "node-settled", ref: "world-read#1@1" },
      { type: "actor-created", ref: "actor#3@1", phaseName: "Work" },
      { type: "node-queued", ref: "ask#3@1", phaseName: "Work" },
      { type: "node-settled", ref: "ask#3@1" },
    ]);

    // ask 的 node-dispatched 重复自己的出生事实（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
    // 「Events」）：戳与它的 node-queued 同源，标记之前出生的那个照样一个键都不带；
    // world-read 的派发始终是裸的。
    const dispatched = harness.runEvents.filter((event) => event.eventType === "node-dispatched");
    expect(
      dispatched.map((event) => ({
        ref: refOfPayload(event.payload),
        ...("phaseName" in event.payload ? { phaseName: event.payload.phaseName } : {}),
        ...("actorPhaseName" in event.payload
          ? { actorPhaseName: event.payload.actorPhaseName }
          : {}),
      })),
    ).toStrictEqual([
      { ref: "ask#1@1" },
      { ref: "ask#2@1", phaseName: "Prepare", actorPhaseName: "Prepare" },
      { ref: "world-read#1@1" },
      { ref: "ask#3@1", phaseName: "Work", actorPhaseName: "Work" },
    ]);
    // 点名子代理的事件都带上会话 id：读面据这一条就能把一个开跑的实例连同它的子代理收进表。
    const askDispatch = dispatched.find((event) => refOfPayload(event.payload) === "ask#3@1");
    expect(askDispatch).toMatchObject({
      actorSessionId: expect.any(String),
      payload: { kind: "ask", actorName: "worker", instructionsHead: "work question" },
    });
    expect(askDispatch?.actorSessionId).toBe(
      harness.runEvents.find(
        (event) =>
          event.eventType === "actor-created" && refOfPayload(event.payload) === "actor#3@1",
      )?.actorSessionId,
    );
    // world-read 的那条没有 actor，也就没有转录可开。
    expect(
      dispatched.find((event) => refOfPayload(event.payload) === "world-read#1@1"),
    ).not.toHaveProperty("actorSessionId");

    // 归约面：actor 从 actor-created 取；节点从 node-queued 取并在 dispatched / settled 上携带。
    const state = reduceAll(harness);
    expect(reducedPhaseNames(state)).toEqual({
      actors: [
        ["actor#1@1", undefined],
        ["actor#2@1", "Prepare"],
        ["actor#3@1", "Work"],
      ],
      nodes: [
        ["ask#1@1", undefined],
        ["ask#2@1", "Prepare"],
        ["world-read#1@1", "Prepare"],
        ["ask#3@1", "Work"],
      ],
    });
    // 节点确实走完了整条生命周期（否则上面的「携带」只是恰好没被覆盖）。
    expect(state?.runs[0]?.nodes.every((node) => node.phase === "settled")).toBe(true);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("resume 时 cached 的 node-settled 带回与前一世相同的出生阶段", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-birth-phase-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const journal = new SweepableJournalStore();
    try {
      // —— 前驱：三个 ask 与 world-read 都 live 跑一遍，边界真的落库（resume 的门槛）。
      const before = makeHarness({ journal, sessionStore: store as never });
      const runA = await submitRun(before, {
        cwd: TEST_CWD,
        scriptText: BIRTH_PHASE_SCRIPT,
        trace: traceFor("birth-phase-predecessor"),
      });
      await settle(before, runA);
      expect(before.journal.getRun(runA)).toMatchObject({ status: "completed" });

      // —— 续跑：脚本逐字节相同，于是每个节点都命中导入缓存，一次真派发都没有。
      const after = makeHarness({ journal, sessionStore: store as never });
      const submitted = await after.service.amend!({
        cwd: TEST_CWD,
        predecessorRunId: runA,
        scriptText: BIRTH_PHASE_SCRIPT,
        trace: traceFor("birth-phase-resume"),
      });
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      await settle(after, submitted.runId);
      expect(turnCount(after)).toBe(0);

      // 命中的节点没有 queued，那条 cached settle 就是它的出生事件——戳与前一世逐个相同，
      // 因为脚本重跑前缀时 phase() 沿同一轨迹重走，每个铸造点上的 currentPhase 不变。
      expect(birthStamps(after)).toStrictEqual([
        { type: "actor-created", ref: "actor#1@1" },
        { type: "node-settled(cached)", ref: "ask#1@1" },
        { type: "actor-created", ref: "actor#2@1", phaseName: "Prepare" },
        { type: "node-settled(cached)", ref: "ask#2@1", phaseName: "Prepare" },
        { type: "node-settled(cached)", ref: "world-read#1@1", phaseName: "Prepare" },
        { type: "actor-created", ref: "actor#3@1", phaseName: "Work" },
        { type: "node-settled(cached)", ref: "ask#3@1", phaseName: "Work" },
      ]);

      const state = reduceAll(after);
      expect(reducedPhaseNames(state)).toEqual({
        actors: [
          ["actor#1@1", undefined],
          ["actor#2@1", "Prepare"],
          ["actor#3@1", "Work"],
        ],
        nodes: [
          ["ask#1@1", undefined],
          ["ask#2@1", "Prepare"],
          ["world-read#1@1", "Prepare"],
          ["ask#3@1", "Work"],
        ],
      });
      expect(workflowRunsStateSchema.parse(state)).toEqual(state);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("dynamic workflow run service — 模型侧错误的收容（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）", () => {
  const PARALLEL_SCRIPT = [
    "interface Answer { text: string }",
    'const alpha = agent("alpha");',
    'const beta = agent("beta");',
    "const [a, b] = await Promise.all([",
    '  alpha.ask<Answer>("first"),',
    '  beta.ask<Answer>("second"),',
    "]);",
    "return a.text + b.text;",
  ].join("\n");

  const adapterError = (context: Record<string, unknown>, message: string) =>
    Object.assign(new Error(message), {
      name: "AiSdkModelAdapterError",
      code: "model_request_failed",
      context,
    });

  it("一个子代理撞上确定性模型错误 → run stopped(provider)，兄弟在飞 ask 被 abort，可恢复", async () => {
    const harness = makeHarness({
      actorScripts: {
        "actor#1@1": [
          {
            kind: "throw",
            error: adapterError(
              {
                reason: "auth_failed",
                providerId: "prov",
                modelId: "alpha",
                providerCode: "1006",
                retryable: false,
              },
              "[1006] token expired",
            ),
          },
        ],
        "actor#2@1": [{ kind: "hang" }],
      },
    });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      scriptText: PARALLEL_SCRIPT,
      trace: traceFor("provider-stop"),
    });
    await settle(harness, runId);

    const record = harness.journal.getRun(runId);
    expect(record?.status).toBe("stopped");
    expect(record?.stopReason).toBe("provider");
    expect(record?.failure?.code).toBe("ProviderStop");
    expect(record?.failure?.providerStop).toMatchObject({
      kind: "auth",
      reason: "auth_failed",
      providerCode: "1006",
      subagent: "actor#1@1",
      subagentName: "alpha",
      rawMessage: "[1006] token expired",
    });
    // 节点：触发者与兄弟都以 node-settled(cancelled) 收场（与 cancel 同），没有 failed 节点；
    // journal 的节点行保持 running（与 cancel 同：resume 时重新派发）。
    const settledNodes = harness.runEvents.filter(
      (event) => event.runId === runId && event.eventType === "node-settled",
    );
    expect(settledNodes.map((event) => event.payload.outcome)).toEqual(["cancelled", "cancelled"]);
    const nodes = harness.journal
      .listNodes(runId, { kinds: "all", withResult: true })
      .filter((node) => node.kind === "ask");
    expect(nodes.map((node) => node.status)).toEqual(["running", "running"]);

    // 快照：追踪器词汇 cancelled，真实词 stopped(provider) + 结构化失败。
    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("cancelled");
    expect(snapshot?.runStatus).toBe("stopped");
    expect(snapshot?.stopReason).toBe("provider");
    expect(snapshot?.failure?.code).toBe("ProviderStop");
    expect(snapshot?.failure?.providerStop?.kind).toBe("auth");

    // run-settled 载荷：resumable + stopReason 随事件透出（UI 的 Resume 控件与原因行读它）。
    const settled = harness.runEvents.find((event) => event.eventType === "run-settled");
    expect(settled?.payload).toMatchObject({
      status: "stopped",
      stopReason: "provider",
      resumable: true,
      error: { code: "ProviderStop" },
    });
    expect((await harness.service.listRunsForSession?.())?.[0]).toMatchObject({
      runId,
      status: "stopped",
      stopReason: "provider",
      failureCode: "ProviderStop",
      resumable: true,
    });
  });

  it('cancel(runId, "model")（TaskStop）→ stopped(model)；缺省 initiator 是 user', async () => {
    const harness = makeHarness({ hangActors: true });
    const byModel = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("stop-by-model"),
    });
    expect(await harness.service.cancel(byModel, "model")).toBe(true);
    await settle(harness, byModel);
    expect(harness.journal.getRun(byModel)).toMatchObject({
      status: "stopped",
      stopReason: "model",
    });
    expect((await harness.service.getTask(byModel))?.stopReason).toBe("model");
    const settled = harness.runEvents.find(
      (event) => event.runId === byModel && event.eventType === "run-settled",
    );
    expect(settled?.payload).toMatchObject({
      status: "stopped",
      stopReason: "model",
      resumable: true,
    });

    const byUser = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("stop-by-user"),
    });
    expect(await harness.service.cancel(byUser)).toBe(true);
    await settle(harness, byUser);
    expect(harness.journal.getRun(byUser)).toMatchObject({ status: "stopped", stopReason: "user" });
  });
});

/**
 * 完成卡的时长口径（docs/dynamic-workflow/transcript-and-notifications.md「How long it took」）：
 * 快照在终态携带整条 lineage 的活动时长，终态之前不带。
 *
 * 求和规则本身在 `dynamic-workflow-run-elapsed.test.ts` 里单测，每一世的 SQL 在
 * `adapters/tests/dwf-journal-store.test.ts` 里对真库钉住；这里钉的是**接线**——读面在场时那个数
 * 真的走到了快照上（终态通知只读快照），以及读面缺席时字段整个不出。
 */
class LifeSpanJournalStore extends SweepableJournalStore {
  /** 每个 run 的世；缺席即「这个 run 没有可读的世」。 */
  readonly lifeSpans = new Map<string, DwfRunLifeSpan[]>();

  listRunLifeSpans(runId: string): DwfRunLifeSpan[] {
    return this.lifeSpans.get(runId) ?? [];
  }
}

describe("dynamic workflow run service — 快照上的 lineage 活动时长", () => {
  it("终态快照带 activeDurationMs（逐世求和），运行中不带", async () => {
    const journal = new LifeSpanJournalStore();
    const harness = makeHarness({ hangActors: true, journal });
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("lifespan-terminal"),
    });
    // 两世：第一世跑了一小时被打断，这一世（重放）两分钟。世与世之间的死时间不计。
    journal.lifeSpans.set(runId, [
      { startedAt: 0, lastActivityAt: 3_600_000 },
      { startedAt: 200_000_000, lastActivityAt: 200_120_000 },
    ]);

    // 运行中：与 reports / artifacts 同一道终态闸门——快照被后台追踪器反复轮询，
    // 而这个数的唯一消费者是终态通知。
    const running = await harness.service.getTask(runId);
    expect(running?.status).toBe("running");
    expect(running?.activeDurationMs).toBeUndefined();

    expect(await harness.service.cancel(runId)).toBe(true);
    await settle(harness, runId);

    expect((await harness.service.getTask(runId))?.activeDurationMs).toBe(3_600_000 + 120_000);
  });

  it("修订链：快照报的是整条 lineage 的活动时长，不只是这一次修订的那一世", async () => {
    // 挂住 actor：前驱没有已完结的 ask，预检因此不要求消息边界（与本文件其余 amend 用例同款）。
    const journal = new LifeSpanJournalStore();
    const harness = makeHarness({ hangActors: true, journal });
    const predecessor = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("lifespan-predecessor"),
    });
    // 前驱跑了四小时。
    journal.lifeSpans.set(predecessor, [{ startedAt: 0, lastActivityAt: 4 * 3_600_000 }]);

    const amended = await amendRun(harness, {
      cwd: TEST_CWD,
      predecessorRunId: predecessor,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("lifespan-amendment"),
    });
    // 修订出来的这一世几乎全是缓存重放：12 秒。
    journal.lifeSpans.set(amended.runId, [
      { startedAt: 10 * 3_600_000, lastActivityAt: 10 * 3_600_000 + 12_000 },
    ]);
    expect(await harness.service.cancel(amended.runId)).toBe(true);
    await settle(harness, amended.runId);

    // 缺陷原因：只报这一世 → 四小时的活在完成卡上写成 12 秒，而同卡 tokens 是 lineage 总数。
    expect(journal.getRun(amended.runId)?.resumedFrom).toBe(predecessor);
    expect((await harness.service.getTask(amended.runId))?.activeDurationMs).toBe(
      4 * 3_600_000 + 12_000,
    );
    // 前驱自己的卡不受影响（它被 supersede 停下，也是终态）。
    expect((await harness.service.getTask(predecessor))?.activeDurationMs).toBe(4 * 3_600_000);
  });

  it("journal 没有这条读面（引擎的内存实现）：字段整个缺席，通知退回本世", async () => {
    const harness = makeHarness();
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      scriptText: TYPED_SCRIPT,
      trace: traceFor("lifespan-absent"),
    });
    await settle(harness, runId);

    const snapshot = await harness.service.getTask(runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.activeDurationMs).toBeUndefined();
    expect("activeDurationMs" in (snapshot ?? {})).toBe(false);
  });
});

describe("dynamic workflow run service — 留白（FillWorkflowHole）", () => {
  /** 一处开放的留白，prompt 带着前一步的值；阶段表 ["准备", "裁决"]，留白按名字站在第 1 位。 */
  const HOLE_SCRIPT = [
    'phase("准备");',
    'const a = await agent("worker").ask<{ text: string }>("do the thing");',
    'const v = await hole<string>("裁决", `decide on ${a.text}`);',
    "return v;",
  ].join("\n");
  const HOLE_PHASES = ["准备", "裁决"];
  // 留白 id 是名字键（docs/analysis.md「Sites」）：按名字取，不写死哈希。
  const VERDICT = holeSiteId("裁决");
  const LEFT = holeSiteId("左");
  const RIGHT = holeSiteId("右");
  const DECIDE = holeSiteId("决定");
  const REFINE = holeSiteId("细化");

  /** 提交并等到 run 停在留白处（`hole-reached` 进度事件到达即停驻已成立：引擎先停驻再记事件）。 */
  async function submitAndReachHole(
    harness: Harness,
    name: string,
    extra: Partial<Parameters<Harness["service"]["submit"]>[0]> = {},
  ): Promise<string> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      phaseNames: HOLE_PHASES,
      scriptText: HOLE_SCRIPT,
      trace: traceFor(name),
      ...extra,
    });
    await vi.waitFor(() => {
      expect(
        harness.runEvents.some(
          (event) => event.runId === runId && event.eventType === "hole-reached",
        ),
      ).toBe(true);
    });
    return runId;
  }

  function fill(harness: Harness, runId: string, body: string, holeId = VERDICT) {
    return harness.service.fillHole!({
      runId,
      holeId,
      body,
      parentSessionId: HARNESS_PARENT_SESSION,
      trace: traceFor("fill"),
    });
  }

  it("停在留白处：run-launched 的 holes 下标、快照的 waiting 条目、hole-reached 载荷的 type / reachedAt", async () => {
    // 真库：详情面（getRunDetail）只在带内省查询的 journal 上装，且 `updateRunScript` 的 SQLite
    // 实现在这里跟着整条链路走一遍。
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = await submitAndReachHole(harness, "hole-wait");

      // 声明阶段表里第 1 位是开放的留白（按名字对出）。
      const launched = harness.journal.listEvents(runId, {
        types: ["run-launched"],
        reportItems: { limit: 0 },
      })[0]?.event;
      expect(launched).toMatchObject({ type: "run-launched", phaseNames: HOLE_PHASES, holes: [1] });

      // 进度载荷：类型来自编译产物，到达时刻来自 journal 的戳；prompt 带着上一步的值。
      const reached = harness.runEvents.find((event) => event.eventType === "hole-reached");
      expect(reached?.payload).toMatchObject({
        instance: { siteId: VERDICT, ordinal: 1 },
        name: "裁决",
        prompt: "decide on done",
        type: "string",
      });
      expect(typeof reached?.payload.reachedAt).toBe("number");

      // 快照：waiting 只因为引擎的停驻表里有它；line 是调用在草稿里的行，before 是前一个阶段。
      const waiting = await harness.service.getTask(runId);
      expect(waiting?.status).toBe("running");
      expect(waiting?.holes).toEqual([
        {
          siteId: VERDICT,
          ordinal: 1,
          name: "裁决",
          type: "string",
          state: "waiting",
          since: reached?.payload.reachedAt,
          line: 3,
          before: "准备",
        },
      ]);
      // 详情面同源同投影。
      const detail = await harness.service.getRunDetail?.(runId);
      expect(detail?.holes).toEqual(waiting?.holes);

      const result = await fill(harness, runId, 'return "verdict";');
      expect(result).toMatchObject({ ok: true, phasesAdded: [] });
      if (!result.ok) throw new Error(result.message);
      expect(result.scriptText).toContain(
        'hole<string>("裁决", `decide on ${a.text}`, async () => {',
      );
      expect(result.scriptText).toContain('  return "verdict";\n})');

      await settle(harness, runId);
      const done = await harness.service.getTask(runId);
      expect(done?.status).toBe("completed");
      expect(done?.output).toBe("verdict");
      // 补全后：filled 来自 hole-filled 事件，带补全它的会话。函数体没有站点也没有阶段标记，但留白
      // 自己的阶段靠 mark 节点留在有效脚本的阶段表里（analysis.md「Sites」），所以仍念得出前邻居。
      expect(done?.holes).toEqual([
        {
          before: "准备",
          siteId: VERDICT,
          ordinal: 1,
          name: "裁决",
          type: "string",
          state: "filled",
          filledAt: expect.any(Number),
          filledBy: HARNESS_PARENT_SESSION,
          line: 3,
        },
      ]);
      // run 行上是有效脚本，两列同一笔（哈希对文本），getScript 给的也是它。
      const record = harness.journal.getRun(runId);
      expect(record?.scriptText).toBe(result.scriptText);
      expect(record?.scriptHash).toBe(
        createHash("sha256").update(result.scriptText, "utf8").digest("hex"),
      );
      expect(await harness.service.getScript(runId)).toBe(result.scriptText);
      // hole-filled 与 phase-entered 一样原样转发，带有效脚本的阶段表。
      const filledEvent = harness.runEvents.find((event) => event.eventType === "hole-filled");
      expect(filledEvent?.payload).toMatchObject({
        siteId: VERDICT,
        filledBy: HARNESS_PARENT_SESSION,
        // 无站点、无标记的补全：留白自己的阶段仍在表里（analysis.md「Sites」）。
        phaseNames: ["准备", "裁决"],
      });
    });
  });

  it("函数体可以带阶段与子代理：新站点带留白自己的一层前缀，phasesAdded 列出函数体的阶段", async () => {
    const harness = makeHarness({
      actorScripts: { [`${VERDICT}/actor#1@1`]: [{ kind: "submit", result: { text: "judged" } }] },
    });
    const runId = await submitAndReachHole(harness, "hole-body-phases");
    const result = await fill(
      harness,
      runId,
      [
        'phase("复核");',
        'const j = await agent("judge").ask<{ text: string }>("judge it");',
        "return j.text;",
      ].join("\n"),
    );
    expect(result).toMatchObject({ ok: true, phasesAdded: ["复核"] });
    await settle(harness, runId);
    const done = await harness.service.getTask(runId);
    expect(done?.output).toBe("judged");
    expect(
      harness.runEvents.find((event) => event.eventType === "actor-created")?.payload,
    ).toMatchObject({ actor: { siteId: "actor#1", ordinal: 1 } });
    expect(
      harness.runEvents
        .filter((event) => event.eventType === "actor-created")
        .map((event) => (event.payload.actor as { siteId: string }).siteId),
    ).toEqual(["actor#1", `${VERDICT}/actor#1`]);
    expect(
      harness.runEvents.find((event) => event.eventType === "hole-filled")?.payload,
      // 函数体以 `phase("复核")` 开头：留白自己的阶段没有成员，但仍留在表里（analysis.md「Sites」）。
      // 修复原因：它曾被丢掉，接龙的每一步名字因此从侧栏与 phaseNames 消失。
    ).toMatchObject({ phaseNames: ["准备", "裁决", "复核"] });
  });

  it("函数体里可以跑种子脚本没有的命令：world.run 的授权只在编译期，driver 没有第二份名单", async () => {
    // 回归：driver 曾持有 launch 时从种子脚本收集的 declaredRunCommands，补全编译的是有效脚本、
    // driver 手里却还是种子那份，函数体里第一次出现的 `world.run("echo", …)` 被当"接线错误"拒掉，
    // 整个 run 因此失败（workflow-world-read.ts 文件头第 2 条；authoring.md「Running commands」）。
    const ran: string[] = [];
    const stream = (text: string) => ({
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: false,
    });
    const executionPort: ExecutionPort = {
      run: async (request) => {
        ran.push(request.command.mode === "argv" ? request.command.file : request.command.command);
        return {
          status: "completed",
          exitCode: 0,
          stdout: stream("hi\n"),
          stderr: stream(""),
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: new Date(0),
          completedAt: new Date(1),
        } as never;
      },
    };
    const harness = makeHarness({ executionPort });
    const runId = await submitAndReachHole(harness, "hole-body-new-command");
    const result = await fill(
      harness,
      runId,
      ['const r = await world.run("echo", ["hi"]);', "return r.stdout.trim();"].join("\n"),
    );
    expect(result).toMatchObject({ ok: true });
    await settle(harness, runId);
    const done = await harness.service.getTask(runId);
    expect(done?.status).toBe("completed");
    expect(done?.output).toBe("hi");
    expect(ran).toEqual(["echo"]);
  });

  it("编不过的函数体是拒绝：诊断落在函数体坐标上，什么都没写，留白照旧在等", async () => {
    const harness = makeHarness();
    const runId = await submitAndReachHole(harness, "hole-diagnostics");
    const before = harness.journal.getRun(runId)?.scriptText;
    const refused = await fill(
      harness,
      runId,
      ['const x: number = "no";', 'return "v";'].join("\n"),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected compile_failed");
    expect(refused.reason).toBe("compile_failed");
    expect(refused.diagnostics).toEqual([
      // 分析器把 2322 锚在声明名 `x` 上（第 7 列），拼接垫的缩进已经扣掉。
      expect.objectContaining({ inFill: true, line: 1, column: 7, code: 2322 }),
    ]);
    expect(harness.journal.getRun(runId)?.scriptText).toBe(before);
    expect((await harness.service.getTask(runId))?.holes?.[0]?.state).toBe("waiting");
    expect(harness.runEvents.some((event) => event.eventType === "hole-filled")).toBe(false);

    // 改好再交：同一处留白照常接受。
    expect(await fill(harness, runId, 'return "v";')).toMatchObject({ ok: true });
    await settle(harness, runId);
  });

  describe("函数体点名的模型只能取本 run 的绑定表（MR !2837 评审 CR-01）", () => {
    const LIGHT: ModelSelection = { providerId: "zhipu", modelId: "GLM-5.3-Flash" };
    const judgeBody = (name: string) =>
      [
        `const j = await agent("judge", { model: model(${JSON.stringify(name)}) }).ask<{ text: string }>("judge it");`,
        "return j.text;",
      ].join("\n");

    it("表外的名字是 9011 拒绝：落在函数体坐标上，什么都没写，留白照旧在等", async () => {
      const harness = makeHarness();
      const runId = await submitAndReachHole(harness, "hole-model-unbound", {
        modelBindings: { "GLM-5.3-Flash": LIGHT },
      });
      const before = harness.journal.getRun(runId)?.scriptText;
      const refused = await fill(harness, runId, judgeBody("GLM-5.3$high"));
      if (refused.ok) throw new Error("expected compile_failed");
      expect(refused.reason).toBe("compile_failed");
      expect(refused.diagnostics).toEqual([
        expect.objectContaining({ inFill: true, line: 1, code: 9011 }),
      ]);
      expect(refused.diagnostics?.[0]?.message).toContain('"GLM-5.3$high"');
      expect(refused.diagnostics?.[0]?.message).toContain('"GLM-5.3-Flash" = zhipu/GLM-5.3-Flash');
      expect(harness.journal.getRun(runId)?.scriptText).toBe(before);
      expect((await harness.service.getTask(runId))?.holes?.[0]?.state).toBe("waiting");
      expect(harness.runEvents.some((event) => event.eventType === "hole-filled")).toBe(false);
      expect(harness.actorRuntimeInputs.some((input) => "actorModel" in input)).toBe(false);
    });

    it("run 没点名过任何模型时，函数体点名模型同样被拒", async () => {
      const harness = makeHarness();
      const runId = await submitAndReachHole(harness, "hole-model-no-table");
      const refused = await fill(harness, runId, judgeBody("GLM-5.3-Flash"));
      if (refused.ok) throw new Error("expected compile_failed");
      expect(refused.diagnostics).toEqual([expect.objectContaining({ inFill: true, code: 9011 })]);
      expect(refused.diagnostics?.[0]?.message).toContain("without naming any model");
      expect((await harness.service.getTask(runId))?.holes?.[0]?.state).toBe("waiting");
    });

    it("表里的名字照常接受，子代理跑在绑定的模型上", async () => {
      const harness = makeHarness({
        actorScripts: {
          [`${VERDICT}/actor#1@1`]: [{ kind: "submit", result: { text: "judged" } }],
        },
      });
      const runId = await submitAndReachHole(harness, "hole-model-bound", {
        modelBindings: { "GLM-5.3-Flash": LIGHT },
      });
      expect(await fill(harness, runId, judgeBody("GLM-5.3-Flash"))).toMatchObject({ ok: true });
      await settle(harness, runId);
      expect((await harness.service.getTask(runId))?.output).toBe("judged");
      const judge = harness.actorRuntimeInputs.find(
        (input) => refToString(input.actor) === `${VERDICT}/actor#1@1`,
      );
      expect(judge?.actorModel).toEqual(LIGHT);
    });
  });

  it("不在等的种种：未知 run、未知留白、还没到达、已补过、已停下（指向 ResumeWorkflowRun）", async () => {
    expect(await fill(makeHarness(), "dwfrun-nope", "return 1;")).toMatchObject({
      ok: false,
      reason: "run_not_found",
    });

    // 还没到达：子代理挂着，脚本停在留白之前的 ask 上。
    const hanging = makeHarness({ hangActors: true });
    const pending = await submitRun(hanging, {
      cwd: TEST_CWD,
      phaseNames: HOLE_PHASES,
      scriptText: HOLE_SCRIPT,
      trace: traceFor("hole-not-reached"),
    });
    await vi.waitFor(() => {
      expect(hanging.runEvents.some((event) => event.eventType === "node-dispatched")).toBe(true);
    });
    const notReached = await fill(hanging, pending, 'return "v";');
    expect(notReached).toMatchObject({ ok: false, reason: "hole_not_waiting" });
    expect((await hanging.service.getTask(pending))?.holes).toBeUndefined();
    await hanging.service.cancel(pending);
    await settle(hanging, pending);

    const harness = makeHarness();
    const runId = await submitAndReachHole(harness, "hole-refusals");
    const unknownHole = await fill(harness, runId, "return 1;", "hole#9");
    expect(unknownHole).toMatchObject({ ok: false, reason: "hole_not_waiting" });
    if (unknownHole.ok) throw new Error("unreachable");
    expect(unknownHole.message).toContain("hole#9");

    expect(await fill(harness, runId, 'return "v";')).toMatchObject({ ok: true });
    const again = await fill(harness, runId, 'return "w";');
    expect(again).toMatchObject({ ok: false, reason: "hole_not_waiting" });
    if (again.ok) throw new Error("unreachable");
    expect(again.message).toContain("already filled");
    await settle(harness, runId);

    // 在留白处停下的 run：停驻的分支随取消撤下，补全指向 resume。
    const stopped = makeHarness();
    const stoppedRun = await submitAndReachHole(stopped, "hole-stopped");
    await stopped.service.cancel(stoppedRun);
    await settle(stopped, stoppedRun);
    expect((await stopped.service.getTask(stoppedRun))?.status).toBe("cancelled");
    const afterStop = await fill(stopped, stoppedRun, 'return "v";');
    expect(afterStop).toMatchObject({ ok: false, reason: "hole_not_waiting" });
    if (afterStop.ok) throw new Error("unreachable");
    expect(afterStop.message).toContain("ResumeWorkflowRun");
    // 死掉的停驻不报 waiting：没有引擎在等，快照上这处留白整个不出。
    expect((await stopped.service.getTask(stoppedRun))?.holes).toBeUndefined();
  });

  it("草稿就地改写成有效脚本、路径不变；没有草稿的 run 由注入的铸造器补一份", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dwf-hole-draft-"));
    const draftPath = join(dir, "裁决.dwf.ts");
    await writeFile(draftPath, HOLE_SCRIPT, "utf8");
    const harness = makeHarness();
    const runId = await submitAndReachHole(harness, "hole-draft", { scriptPath: draftPath });
    const result = await fill(harness, runId, 'return "v";');
    if (!result.ok) throw new Error(result.message);
    expect(result.scriptPath).toBe(draftPath);
    expect(await readFile(draftPath, "utf8")).toBe(result.scriptText);
    expect((await harness.service.getTask(runId))?.scriptPath).toBe(draftPath);
    await settle(harness, runId);

    // 没有草稿的 run：铸造器先于引擎落盘，路径随 hole-filled 进 journal，冷读面重启后照样找得到。
    await withSqliteJournal(async (journal) => {
      const minted: { cwd: string; name: string; source: string }[] = [];
      const mintPath = join(dir, "minted.dwf.ts");
      const minting = makeHarness({
        journal,
        writeWorkflowDraft: async (input) => {
          minted.push(input);
          return { path: mintPath };
        },
      });
      const draftless = await submitAndReachHole(minting, "hole-mint", { name: "夜间审阅" });
      const mintedResult = await fill(minting, draftless, 'return "v";');
      if (!mintedResult.ok) throw new Error(mintedResult.message);
      expect(mintedResult.scriptPath).toBe(mintPath);
      expect(minted).toEqual([
        { cwd: TEST_CWD, name: "夜间审阅", source: mintedResult.scriptText },
      ]);
      expect((await minting.service.getTask(draftless))?.scriptPath).toBe(mintPath);
      expect(
        minting.runEvents.find((event) => event.eventType === "hole-filled")?.payload,
      ).toMatchObject({ siteId: VERDICT, scriptPath: mintPath });
      await settle(minting, draftless);
      // 冷读：另一个 service 实例（没有条目）从 journal 事件读回补全铸的那份，而不是 run-launched
      // 上的缺席。
      const cold = makeHarness({ journal });
      expect((await cold.service.getTask(draftless))?.scriptPath).toBe(mintPath);
      expect((await cold.service.getRunDetail?.(draftless))?.scriptPath).toBe(mintPath);
    });
    await rm(dir, { recursive: true, force: true });
  });

  /** 两个 future 各停在一处留白：两处可以同时在等，模型也会把两次补全放进同一个并行批里。 */
  const TWO_HOLES_SCRIPT = [
    'phase("准备");',
    "const left = future(async () => {",
    '  const a = await agent("l").ask<{ text: string }>("left");',
    '  return await hole<string>("左", `l ${a.text}`);',
    "});",
    "const right = future(async () => {",
    '  const b = await agent("r").ask<{ text: string }>("right");',
    '  return await hole<string>("右", `r ${b.text}`);',
    "});",
    "const [x, y] = await Promise.all([left, right]);",
    'return x + "+" + y;',
  ].join("\n");

  async function submitAndReachBothHoles(harness: Harness, name: string): Promise<string> {
    const runId = await submitRun(harness, {
      cwd: TEST_CWD,
      parentSessionId: HARNESS_PARENT_SESSION,
      phaseNames: ["准备", "左", "右"],
      scriptText: TWO_HOLES_SCRIPT,
      trace: traceFor(name),
    });
    await vi.waitFor(() => {
      expect(
        harness.runEvents.filter(
          (event) => event.runId === runId && event.eventType === "hole-reached",
        ),
      ).toHaveLength(2);
    });
    return runId;
  }

  it("同一个 run 的两次并发补全串行执行：journal 的有效脚本同时带着两个函数体，两个分支都完成", async () => {
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({ journal });
      const runId = await submitAndReachBothHoles(harness, "hole-concurrent");
      expect((await harness.service.getTask(runId))?.holes?.map((hole) => hole.state)).toEqual([
        "waiting",
        "waiting",
      ]);
      const [first, second] = await Promise.all([
        fill(harness, runId, 'return "L";', LEFT),
        fill(harness, runId, 'return "R";', RIGHT),
      ]);
      expect(first).toMatchObject({ ok: true });
      expect(second).toMatchObject({ ok: true });
      if (!second.ok || !first.ok) throw new Error("unreachable");
      // 第二次是在第一次的有效脚本上拼的：它交出的文本包含两个函数体，journal 行就是它。
      expect(second.scriptText).toContain('hole<string>("左", `l ${a.text}`, async () => {');
      expect(second.scriptText).toContain('hole<string>("右", `r ${b.text}`, async () => {');
      expect(second.scriptText).toContain('return "L";');
      expect(second.scriptText).toContain('return "R";');
      const record = journal.getRun(runId);
      expect(record?.scriptText).toBe(second.scriptText);
      expect(record?.scriptHash).toBe(
        createHash("sha256").update(second.scriptText, "utf8").digest("hex"),
      );
      await settle(harness, runId);
      const done = await harness.service.getTask(runId);
      expect(done?.status).toBe("completed");
      expect(done?.output).toBe("L+R");
      expect(done?.holes?.map((hole) => [hole.siteId, hole.state])).toEqual([
        [LEFT, "filled"],
        [RIGHT, "filled"],
      ]);
      expect(
        harness.runEvents
          .filter((event) => event.eventType === "hole-filled")
          .map((event) => event.payload.siteId),
      ).toEqual([LEFT, RIGHT]);
    });
  });

  it("被拒绝的第一次补全不阻塞排在它后面的第二次", async () => {
    const harness = makeHarness();
    const runId = await submitAndReachBothHoles(harness, "hole-refused-first");
    const [refused, accepted] = await Promise.all([
      // `hole<string>` 的体返回 number：编译期拒绝。
      fill(harness, runId, "return 1;", LEFT),
      fill(harness, runId, 'return "R";', RIGHT),
    ]);
    expect(refused).toMatchObject({ ok: false, reason: "compile_failed" });
    expect(accepted).toMatchObject({ ok: true });
    if (!accepted.ok) throw new Error("unreachable");
    expect(accepted.scriptText).not.toContain("return 1;");
    expect(accepted.scriptText).toContain('return "R";');
    expect(
      (await harness.service.getTask(runId))?.holes?.map((hole) => [hole.siteId, hole.state]),
    ).toEqual([
      [LEFT, "waiting"],
      [RIGHT, "filled"],
    ]);
    const retried = await fill(harness, runId, 'return "L";', LEFT);
    expect(retried).toMatchObject({ ok: true });
    if (!retried.ok) throw new Error("unreachable");
    expect(retried.scriptText).toContain('return "R";');
    await settle(harness, runId);
    expect((await harness.service.getTask(runId))?.output).toBe("L+R");
  });

  it("递归补全：外层函数体里再开一处留白，内层体读到外层体与留白之前的绑定；两次补全都就地改写草稿；停下后 resume 不再请求任何留白", async () => {
    const NESTED_SCRIPT = [
      "interface Plan { step: string }",
      'phase("探索");',
      'const seed = await agent("scout").ask<{ text: string }>("scout it");',
      'const plan = await hole<Plan>("决定", `plan for ${seed.text}`);',
      'phase("执行");',
      'const done = await agent("worker").ask<{ text: string }>(`execute ${plan.step}`);',
      "return done.text;",
    ].join("\n");
    const dir = await mkdtemp(join(tmpdir(), "dwf-hole-nested-"));
    const draftPath = join(dir, "决定.dwf.ts");
    await writeFile(draftPath, NESTED_SCRIPT, "utf8");
    // worker 的计划是一个**共享的**数组：第一世挂起（好让 run 在两次补全之后停下），resume 之前
    // 换成一次提交——重水化出来的新 runtime 拿到的是同一个数组引用。
    const workerPlan: ActorPlan[] = [{ kind: "hang-until-cancelled" }];
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({
        journal,
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "seed" } }],
          [`${DECIDE}/actor#1@1`]: [{ kind: "submit", result: { text: "draft" } }],
          "actor#2@1": workerPlan,
        },
      });
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        phaseNames: ["探索", "决定", "执行"],
        scriptPath: draftPath,
        scriptText: NESTED_SCRIPT,
        trace: traceFor("hole-nested"),
      });
      const reachedIds = () =>
        harness.runEvents
          .filter((event) => event.runId === runId && event.eventType === "hole-reached")
          .map((event) => (event.payload.instance as { siteId: string }).siteId);
      await vi.waitFor(() => expect(reachedIds()).toEqual([DECIDE]));

      // 第一次补全：体里先开一个阶段、问一次，再以内层留白的结果返回；内层留白的 prompt 读体内的 const。
      const outer = await fill(
        harness,
        runId,
        [
          'phase("初步");',
          'const draft = await agent("drafter").ask<{ text: string }>("draft it");',
          "const x = draft.text;",
          'return await hole<Plan>("细化", `refine ${x}`);',
        ].join("\n"),
        DECIDE,
      );
      if (!outer.ok) throw new Error(outer.message);
      expect(outer.phasesAdded).toEqual(["初步", "细化"]);
      expect(outer.scriptPath).toBe(draftPath);
      expect(await readFile(draftPath, "utf8")).toBe(outer.scriptText);

      // run 停在嵌套的留白处：id 是它自己的名字键（不带外层前缀），类型来自有效脚本，前后邻居是
      // 有效脚本的阶段。
      await vi.waitFor(() => expect(reachedIds()).toEqual([DECIDE, REFINE]));
      const nestedReached = harness.runEvents.find(
        (event) =>
          event.eventType === "hole-reached" &&
          reachedIds().length === 2 &&
          (event.payload.instance as { siteId: string }).siteId === REFINE,
      );
      expect(nestedReached?.payload).toMatchObject({
        name: "细化",
        prompt: "refine draft",
        type: "Plan",
        reachedAt: expect.any(Number),
      });
      const parked = await harness.service.getTask(runId);
      expect(parked?.holes).toEqual([
        expect.objectContaining({
          siteId: DECIDE,
          state: "filled",
          filledBy: HARNESS_PARENT_SESSION,
        }),
        expect.objectContaining({
          siteId: REFINE,
          ordinal: 1,
          name: "细化",
          type: "Plan",
          state: "waiting",
          before: "初步",
          after: "执行",
        }),
      ]);
      expect(
        harness.runEvents.find((event) => event.eventType === "hole-filled")?.payload,
        // 外层留白的函数体以标记开头，它自己的阶段仍留在表里（「决定」不再从 phaseNames 消失）。
      ).toMatchObject({
        siteId: DECIDE,
        phaseNames: ["探索", "决定", "初步", "细化", "执行"],
        holes: [3],
      });

      // 第二次补全：内层体读外层体的 `x` 与外层留白之前的 `seed`；新 id 带内层留白自己的前缀。
      const inner = await fill(harness, runId, "return { step: `${seed.text}/${x}` };", REFINE);
      if (!inner.ok) throw new Error(inner.message);
      expect(inner.phasesAdded).toEqual([]);
      expect(inner.scriptPath).toBe(draftPath);
      expect(await readFile(draftPath, "utf8")).toBe(inner.scriptText);
      expect(inner.scriptText).toContain('hole<Plan>("细化", `refine ${x}`, async () => {');
      expect(inner.scriptText).toContain("return { step: `${seed.text}/${x}` };");
      // journal 的 run 行：两个函数体嵌套在有效脚本里，哈希对文本。
      const record = journal.getRun(runId);
      expect(record?.scriptText).toBe(inner.scriptText);
      expect(record?.scriptHash).toBe(
        createHash("sha256").update(inner.scriptText, "utf8").digest("hex"),
      );
      expect((await harness.service.getTask(runId))?.holes?.map((hole) => hole.state)).toEqual([
        "filled",
        "filled",
      ]);

      // 内层体的值流进了外层留白之后的阶段：worker 的问句里带着 seed/draft。
      await vi.waitFor(() => {
        expect(harness.actorModelRequests["actor#2@1"]?.requests.length ?? 0).toBeGreaterThan(0);
      });
      expect(
        JSON.stringify(harness.actorModelRequests["actor#2@1"]?.requests[0]?.messages),
      ).toContain("execute seed/draft");

      // 两次补全之后停下，再 resume：有效脚本的两个函数体内联执行，一次留白请求都没有。
      await harness.service.cancel(runId);
      await settle(harness, runId);
      expect((await harness.service.getTask(runId))?.status).toBe("cancelled");
      workerPlan.splice(0, workerPlan.length, { kind: "submit", result: { text: "shipped" } });
      const eventsBeforeResume = harness.runEvents.length;
      const resumed = await harness.service.resume(runId);
      expect(resumed).toMatchObject({ ok: true, runId });
      await settle(harness, runId);
      const secondLife = harness.runEvents.slice(eventsBeforeResume);
      expect(secondLife.some((event) => event.eventType === "hole-reached")).toBe(false);
      const finished = await harness.service.getTask(runId);
      expect(finished?.status).toBe("completed");
      expect(finished?.output).toBe("shipped");
      expect(finished?.scriptPath).toBe(draftPath);
      expect(
        JSON.stringify(harness.actorModelRequests["actor#2@1"]?.requests.at(-1)?.messages),
      ).toContain("execute seed/draft");
    });
    await rm(dir, { recursive: true, force: true });
  });

  // 修复原因：留白 id 曾逐层拼接（`hole#1/hole#1/…`，每层 7 个字符），十层的接龙里最里层的 id 就过了
  // 协议的 64 字符上界。这里在真实的 SQLite journal 上跑一条十步的尾巴留白接龙：每一步都是一次
  // FillWorkflowHole，最后一步派一个子代理并返回；每条到达事件、每个子代理、run 的留白快照里的 id
  // 都在 64 以内，且与深度无关。
  it("十步的尾巴留白接龙跑到完成：每一步一个名字键 id，深度不进 id，所有 id 都在 64 字符以内", async () => {
    const STEPS = 10;
    const stepName = (k: number) => `第${k}步`;
    const SEED = [
      'phase("起步");',
      'const seed = await agent("勘察员").ask<{ text: string }>("look");',
      `return await hole<string>("${stepName(1)}", \`from \${seed.text}\`);`,
    ].join("\n");
    const last = holeSiteId(stepName(STEPS));
    await withSqliteJournal(async (journal) => {
      const harness = makeHarness({
        journal,
        actorScripts: {
          "actor#1@1": [{ kind: "submit", result: { text: "seed" } }],
          [`${last}/actor#1@1`]: [{ kind: "submit", result: { text: "shipped" } }],
        },
      });
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        phaseNames: ["起步", stepName(1)],
        scriptText: SEED,
        trace: traceFor("hole-chain-ten"),
      });
      const reached = () =>
        harness.runEvents
          .filter((event) => event.runId === runId && event.eventType === "hole-reached")
          .map((event) => (event.payload.instance as { siteId: string }).siteId);
      for (let k = 1; k <= STEPS; k += 1) {
        const id = holeSiteId(stepName(k));
        await vi.waitFor(() => expect(reached()).toContain(id));
        const body =
          k === STEPS
            ? 'const done = await agent("收尾").ask<{ text: string }>(`finish ${seed.text}`);\nreturn done.text;'
            : `return await hole<string>("${stepName(k + 1)}", "progress ${k}");`;
        const result = await fill(harness, runId, body, id);
        if (!result.ok) throw new Error(`step ${k}: ${result.message}`);
      }
      await settle(harness, runId);
      const done = await harness.service.getTask(runId);
      expect(done?.status).toBe("completed");
      expect(done?.output).toBe("shipped");

      // 每一步恰好到达一次，按接龙次序。
      expect(reached()).toEqual(
        Array.from({ length: STEPS }, (_, i) => holeSiteId(stepName(i + 1))),
      );
      // 所有进过事件的 id：到达的留白、创建的子代理，都在协议上界以内，而且最长的与深度无关。
      const actorIds = harness.runEvents
        .filter((event) => event.eventType === "actor-created")
        .map((event) => (event.payload.actor as { siteId: string }).siteId);
      expect(actorIds).toEqual(["actor#1", `${last}/actor#1`]);
      for (const id of [...reached(), ...actorIds]) expect(id.length, id).toBeLessThanOrEqual(64);
      expect(Math.max(...[...reached(), ...actorIds].map((id) => id.length))).toBe(
        `${last}/actor#1`.length,
      );
      // 快照：十个留白都补全了；有效脚本的阶段表念得出每一步的名字。
      expect(done?.holes?.map((hole) => [hole.siteId, hole.state])).toEqual(
        Array.from({ length: STEPS }, (_, i) => [holeSiteId(stepName(i + 1)), "filled"]),
      );
      const lastFilled = harness.runEvents
        .filter((event) => event.eventType === "hole-filled")
        .at(-1);
      expect(lastFilled?.payload.phaseNames).toEqual([
        "起步",
        ...Array.from({ length: STEPS }, (_, i) => stepName(i + 1)),
      ]);
    });
  });

  it("冷回放为 hole-reached 铸出与 live 逐字节相同的载荷（type 从行里的有效脚本重建）", async () => {
    const harness = makeHarness();
    const runId = await submitAndReachHole(harness, "hole-replay");
    expect(await fill(harness, runId, 'return "v";')).toMatchObject({ ok: true });
    await settle(harness, runId);
    const live = harness.runEvents.filter(
      (event) => event.eventType === "hole-reached" || event.eventType === "hole-filled",
    );
    const row = (harness.journal as SweepableJournalStore)
      .listRunsByParentSession(HARNESS_PARENT_SESSION, 16)
      .find((item) => item.runId === runId);
    const replayed = replayRunProgress(
      row!,
      harness.journal,
      resolveWorkflowDefaultConcurrency(),
    ).filter((event) => event.eventType === "hole-reached" || event.eventType === "hole-filled");
    expect(replayed).toEqual(live);
  });
});

describe("dynamic workflow run service — 额度停止后到点自动续跑", () => {
  // apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Resuming after a quota
  // reset」：真实格式的 1308 原文（没有 Retry-After）→ 停止记录带上重置时刻 → 到点自动续跑。
  const SCRIPT = [
    "interface Answer { text: string }",
    'const a = await agent("worker").ask<Answer>("go");',
    "return a.text;",
  ].join("\n");

  /** 北京时间的「YYYY-MM-DD HH:MM:SS」，与服务端文案同形。 */
  const beijingText = (at: number): string => {
    const iso = new Date(at + 8 * 60 * 60 * 1000).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
  };

  it("原文里的重置时刻落进停止记录，到点后续跑并跑完", async () => {
    const resetAt = Math.floor((Date.now() + 2 * 60 * 60 * 1000) / 1000) * 1000;
    const quotaError = Object.assign(
      new Error(
        `[1308][已达到 5 小时的使用上限。您的限额将在 ${beijingText(resetAt)} 重置。][20261019120000abc]`,
      ),
      {
        name: "AiSdkModelAdapterError",
        code: "model_rate_limited",
        context: { reason: "rate_limited", providerCode: "1308", retryable: false },
      },
    );
    const options: HarnessOptions = {
      actorScripts: { "actor#1@1": [{ kind: "throw", error: quotaError }] },
    };
    const harness = makeHarness(options);

    let now = Date.now();
    const timers: { at: number; callback: () => void }[] = [];
    const auto = startWorkflowQuotaAutoResume({
      journal: harness.journal,
      parentSessionId: HARNESS_PARENT_SESSION,
      resume: (runId) => harness.service.resume!(runId),
      subscribeRunSettled: (listener) => harness.service.subscribeRunSettled(listener),
      clock: {
        now: () => now,
        schedule: (callback, delayMs) => {
          timers.push({ at: now + delayMs, callback });
          return () => {};
        },
      },
    });
    try {
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: SCRIPT,
        trace: traceFor("quota-auto-resume"),
      });
      await settle(harness, runId);
      expect(harness.journal.getRun(runId)).toMatchObject({
        status: "stopped",
        stopReason: "provider",
        failure: { providerStop: { kind: "quota", providerCode: "1308", resetAt } },
      });
      await vi.waitFor(() => {
        expect(timers).toHaveLength(1);
      });
      expect(timers[0]!.at).toBe(resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS);

      // 额度恢复了：子代理这次能答。时钟拨到重置时刻之后，定时器触发续跑。
      options.actorScripts = { "actor#1@1": [{ kind: "submit", result: { text: "after reset" } }] };
      now = timers[0]!.at;
      timers.shift()!.callback();
      await vi.waitFor(() => {
        expect(harness.journal.getRun(runId)?.status).toBe("completed");
      });
      expect((await harness.service.getTask(runId))?.output).toBe("after reset");
    } finally {
      auto.dispose();
    }
  });
});

describe("session close waits for workflow actor resources", () => {
  it.each([true, false])(
    "drains actors even when run was already terminal=%s",
    async (terminal) => {
      let finish!: () => void;
      const cleanup = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let cleanupStarted = false;
      const harness = makeHarness({
        hangActors: !terminal,
        actorCleanup: async () => {
          cleanupStarted = true;
          await cleanup;
        },
      });
      const runId = await submitRun(harness, {
        cwd: TEST_CWD,
        parentSessionId: HARNESS_PARENT_SESSION,
        scriptText: TYPED_SCRIPT,
        trace: traceFor("owned-workflow-close"),
      });
      await vi.waitFor(() => expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0));
      if (terminal) await settle(harness, runId);
      let closed = false;
      const closing = harness.service.close().then(() => {
        closed = true;
      });
      try {
        await vi.waitFor(() => expect(cleanupStarted).toBe(true));
        expect(closed).toBe(false);
        finish();
        await closing;
        expect(closed).toBe(true);
      } finally {
        finish();
        await closing;
      }
    },
  );
});

it("owner close prevents an in-flight amend from launching a successor", async () => {
  const harness = makeHarness({ hangActors: true });
  const runId = await submitRun(harness, {
    cwd: TEST_CWD,
    parentSessionId: HARNESS_PARENT_SESSION,
    scriptText: TYPED_SCRIPT,
    trace: traceFor("close-amend-race"),
  });
  await vi.waitFor(() => expect(harness.actorRuntimeInputs.length).toBeGreaterThan(0));
  const amending = harness.service.amend!({
    cwd: TEST_CWD,
    parentSessionId: HARNESS_PARENT_SESSION,
    predecessorRunId: runId,
    scriptText: TYPED_SCRIPT,
    trace: traceFor("closing-amend"),
  });
  const rejected = expect(amending).rejects.toThrow(/closed/);
  await harness.service.close();
  await rejected;
  expect(harness.service.countLiveRuns()).toBe(0);
});
