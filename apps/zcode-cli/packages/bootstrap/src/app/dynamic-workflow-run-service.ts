// ============================================================
// Dynamic Workflow Run Service（DynamicWorkflowRunPort 的生产实现）
// ============================================================
// 本服务负责：
// 编译一次 → 注册 AbortController → 启动引擎（fire-and-forget，执行体在
// dynamic-workflow-run-launch.ts）→ 把 run 的观察面（快照 / 等待 / 取消 / 恢复 / 枚举 /
// 事件分页）经窄端口交出去。
//
// 七条不变式，违反任何一条都会以「离成因很远」的方式表现，所以写在文件头：
//
//   1. **引擎独占 createRun**。本服务绝不预插 dwf_run 行。预先存在的行会把引擎构造函数翻进
//      resume 分支（engine.ts）：节点计数按已完结记录重算、预算从记录恢复、状态被
//      updateRunStatus 覆写。一个全新的 run 走 resume 分支不报错，只会静默从一份空 journal
//      「恢复」。resume 恰恰反过来**依赖**这条机制：它对既有 runId 重新 launch，让引擎命中
//      已存在的行。两个入口方向相反，绝不共用门。
//   2. **编译恰好一次**。一个 ts.Program 同时喂站点表、schema 合成与 lowering；scriptHash 由
//      本服务算（harness 刻意不算——它若哈希「自己看到的文本」，lowered 路径落库的就是
//      lowered 函数体的哈希，resume 校验的比对对象就静默错了）。
//   3. **没有 journal 就不构造本服务**。durability 是 run 的前提：一个静默丢失持久化的 run
//      比没有 run 更糟（resume 无据、详情页无源、取消后无记录）。narrowing 失败时
//      {@link createDynamicWorkflowRunService} 的调用方拿到 undefined，CreateWorkflow 因此
//      回到占位诊断路径——这是一个可见的降级，而不是一个坏掉的功能。
//   4. **构造时收敛本会话的孤儿 run，且只收敛本会话的**。见 {@link reconcileOrphanRuns}：
//      死进程留下的 `running` 行只有在这一刻才可判定，而「本会话」是唯一安全的作用域。
//      收敛写成 `stopped(interrupted)`（携 `Interrupted` 失败编码），与其余 stopped 同为可恢复。
//   5. **resume 先替换注册表条目，再启动**。`waitForTask` 对不在注册表里的 runId 直接回
//      journal 快照——条目晚一步，重臂的通知 watcher 会立刻对着旧的终态行结算。
//   6. **每次启动都在启动的同一同步片登记为常驻阻塞工作**。引擎是父会话 App 的闭包，不进
//      runtime task registry；常驻池因此只看见「registry 已退休」而把带着在飞引擎的
//      App 按 idle 关掉（10 分钟），resume 又起了第二个引擎。登记点只有一个——
//      {@link trackSettlement}，submit / amend / resume 共用它——计数在 launch 的同一同步片
//      增加、在结算的 finally 释放。
//   7. **close 停下自己拥有的每一个 run，而那一笔由引擎自己写**。App 关闭时本服务以
//      `"interrupted"` abort 每个在飞条目并**等它们结算**（不是超时、不是轮询），harness 把
//      这个原因归一成 `engine.stop("interrupted", Interrupted)`，于是行经引擎正常的 finishRun
//      尾巴落成可 resume 的 `stopped(interrupted)`。service 绝不自己写终态行：绕过引擎写，就会
//      造出 dwf_run 的第二个写入者（同不变式 1 的论证），且 journal 里不会有对应的 run-settled。
//      关闭之后 submit / amend / resume 直接抛——常驻池的关闭闸门本就挡住了命令，走到这里是
//      接线错误，不该让 contracts 的拒绝枚举为它变宽（同不变式 1 的论证）。

import type { DwfRunSessionListItem } from "@zcode/adapters/storage";
import type {
  CollaborationMode,
  TraceContext,
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItemPage,
  DynamicWorkflowRunArtifactItemsResult,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
  DynamicWorkflowRunEventPage,
  DynamicWorkflowRunEventsResult,
  DynamicWorkflowResolveQuestionResult,
  DynamicWorkflowRunPort,
  DynamicWorkflowRunProgressPayload,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunRetuneRequest,
  DynamicWorkflowRunRetuneResult,
  DynamicWorkflowRunSessionSummary,
  DynamicWorkflowRunSnapshot,
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunCancelInitiator,
  DynamicWorkflowRunFillHoleRequest,
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitResult,
  FillWorkflowHoleResult,
  ExecutionPort,
  FileSystemPort,
  Logger,
  SessionId,
  ModelRequestAdmission,
  ModelSelection,
  ToolArtifactStorePort,
  WorkflowEscalatePort,
  WorkflowWebSearchBudgetPort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import {
  WORKFLOW_RUN_EVENTS_PAGE_LIMITS,
  WORKFLOW_RUNS_LIMITS,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ActorSubmitProfile,
  ActorRef,
  Caps,
  JournalStorePort,
  PersonaSpec,
} from "@zcode/dynamic-workflow";
import { toProtocolEvent } from "./dynamic-workflow-run-launch.js";
import { readWorkflowArtifactBytes } from "./dynamic-workflow-run-artifact-read.js";
import { replayRunProgress } from "./dynamic-workflow-run-replay.js";
import { listArtifactItemsFrom } from "./dynamic-workflow-run-artifact-queries.js";
import {
  pageByCountOnly,
  supportsEventPages,
  supportsRunEnumeration,
  supportsRunIntrospection,
  type DynamicWorkflowTaskLinkStore,
} from "./dynamic-workflow-run-journal.js";
import { createRunIntrospectionMethods } from "./dynamic-workflow-run-introspection.js";
import { reconcileOrphanRuns } from "./dynamic-workflow-run-reconcile.js";
import {
  resumeDynamicWorkflowRun,
  amendDynamicWorkflowRun,
  submitDynamicWorkflowRun,
  type DynamicWorkflowRunEntryContext,
} from "./dynamic-workflow-run-submit.js";
import {
  listWorkspaceNodesFrom,
  readWorkspaceNodeResultFrom,
} from "./dynamic-workflow-run-workspace.js";
import {
  artifactsOf,
  settleOrAbort,
  snapshotOf,
  toSessionSummary,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";
import {
  createRunServiceLifecycle,
  type DynamicWorkflowRunSettledNotice,
} from "./dynamic-workflow-run-lifecycle.js";
import { retuneRunConcurrency } from "./dynamic-workflow-run-retune.js";
import { fillDynamicWorkflowHole } from "./dynamic-workflow-run-fill.js";
import { runHolesOf } from "./dynamic-workflow-run-holes.js";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";
import {
  normalizeRunConcurrency,
  resolveWorkflowDefaultConcurrency,
} from "./workflow-default-concurrency.js";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
import type { WorkflowSubagentPermissionMode } from "./workflow-actor-permission.js";
import type { AgentRuntimeWorkflowDriverDeps } from "./workflow-driver-types.js";
import {
  createWorkflowEscalationRegistry,
  type WorkflowEscalationRegistry,
} from "./workflow-escalation-registry.js";

/** listRunsForSession 的默认/上限条数（枚举面有界，绝不无界扫库）。 */
const DEFAULT_LIST_RUNS_LIMIT = 16;
const MAX_LIST_RUNS_LIMIT = 64;

/** actor runtime 工厂的输入。runId 在内，因为会话 id 与 task link 都要 run 作用域。 */
export interface DynamicWorkflowActorRuntimeInput {
  runId: string;
  sessionId: SessionId;
  actor: ActorRef;
  persona: PersonaSpec;
  submitPort: WorkflowSubmitPort;
  /**
   * 该 actor 的 submit profile：`untyped` 不注入
   * submitPort（无工具），`mono` 注入端口 + typed 声明，`generic` 只注入端口。工厂是这条映射的
   * 唯一落点（与子代理工具面的固定 disallowlist 同一处 seam）。
   */
  submitProfile: ActorSubmitProfile;
  /**
   * 会话级升级端口：注入即为该 actor 会话注册 `escalate`
   * 工具，与 submitPort 完全同构。**恒在场**，不做 opt-in——最可能撞上未预见之墙的 actor
   * 恰是作者没标记的那一个。
   */
  escalatePort: WorkflowEscalatePort;
  /**
   * 每个 ask 的 WebSearch 预算端口：计数在 driver 的会话状态里（startAsk 归零），上限取
   * persona 的 `budget.webSearch`，缺席用默认值。恒注入，与升级端口同路下传到 runtime deps。
   */
  webSearchBudgetPort: WorkflowWebSearchBudgetPort;
  /**
   * 这个 actor 上一次解析出的模型（journal 里的 `resolvedModel`，`providerId/modelId`），
   * 只有 resume 会带上它。没有 {@link DynamicWorkflowActorRuntimeInput.runSubagentModel} 时工厂
   * 必须优先于父会话模型采用它：见 `workflow-actor-model.ts` 里 pin 的理由（persona 冻结不变式
   * 的持久化那一半）。
   */
  pinnedModel?: string;
  /**
   * 本 run 自己的子代理模型（`CreateWorkflow` / `AmendWorkflow` 的 `subagent_model`，从
   * journal 的 `run-launched` 事件解析回来）。整条选择，含 reasoning 档位。
   *
   * 优先级**最高**，在 {@link DynamicWorkflowActorRuntimeInput.pinnedModel} 与父会话模型之上
   * （workflow-actor-model.ts 的 `workflowActorModelPolicy`）：这一条是用户对这一次 run 的显式
   * 表态，pin 只守没有它时的隐式缺省。只管子代理、不动主代理。缺席即跑在 pin 或会话模型上。
   */
  runSubagentModel?: ModelSelection;
  /**
   * 这个 actor 的 persona 点名的模型，已按本 run 的绑定表（run-launched 的 `modelBindings`）解析成整条
   * 选择（docs/dynamic-workflow/launch.md「Models the script names」）。优先级在 {@link runSubagentModel}
   * 之上：它是为这一个子代理写下的选择。缺席即 persona 没点名模型。
   */
  actorModel?: ModelSelection;
  /**
   * 本 run 子代理的权限模式（journal 的 `run-launched` 上的那一个；docs/dynamic-workflow/launch.md
   * 「Permissions inside a run」）。工厂让 actor 跑在这个模式上（workflow-actor-permission.ts），
   * 缺席即 YOLO。
   */
  subagentPermissionMode?: WorkflowSubagentPermissionMode;
  /**
   * 该 actor runtime 的模型请求准入端口（docs/dynamic-workflow/concurrency.md「One ticket per request attempt」）：
   * driver 在治理器端口在场时给出；工厂原样放进 runtime deps。缺席即不受闸门约束。
   */
  modelRequestAdmission?: ModelRequestAdmission;
}

export interface DynamicWorkflowRunServiceDeps {
  /** durable journal（dwf_* 表）。缺失即不构造本服务，见文件头不变式 3。 */
  journal: JournalStorePort;
  /**
   * 发起锚点的解析：给出 submit 那一刻父 runtime 活动轮的
   * inputId；`trace.turnId` 与活动轮不一致或没有活动轮时回 `undefined`（submit 侧兜底铸值）。
   * 缺席即宿主没有「当前轮」概念（CLI、测试装配）。
   */
  resolveLaunchInputId?: (trace: TraceContext) => string | undefined;
  /**
   * 本服务实例的父会话 id（= 本 app 的会话，见 create-app.ts）。
   *
   * 它是**孤儿收敛与枚举的作用域**，所以不是可选项：缺席只剩两条路——全局清扫（会把同进程
   * 兄弟会话正在飞的 run 标死，两者共用同一个 sqlite、各有各的内存注册表）或干脆不收敛
   * （就是那个「run 永远停在 running」的 bug）。宁可让接线错误在编译期出现。
   */
  parentSessionId: string;
  /**
   * 父会话**此刻**的权限模式（create-app 接 `runtime.getMode()`）。只在建 run 那一世读一次
   * （submit / amend），记进 `run-launched`（docs/dynamic-workflow/launch.md
   * 「Permissions inside a run」）；resume 只读事件、不读它。惰性：run service 先于 runtime 构造。
   * 缺席即宿主没有模式概念（CLI 测试装配），子代理照旧 YOLO。
   */
  permissionMode?: () => CollaborationMode;
  /** world-read（files.glob / files.read / files.grep）落到的文件系统端口。 */
  fileSystemPort: FileSystemPort;
  /** git.* world-read 落到的子进程执行端口（cwd = run 的工作区）。 */
  executionPort: ExecutionPort;
  /**
   * 用户面产物（`artifact.file` / `artifact.markdown`）的字节落点，原样转交 driver。⚠ 这里的 artifact 指**交付给用户看的
   * 产出**，不是引擎内部那个顶层返回值。
   *
   * **可选**：不带 store 的装配（测试、最小 stub）照旧能跑 run，只是内容成员会以命名的
   * `ArtifactStoreUnavailable` 拒绝——一条脚本可 catch 的失败，不是静默降级。会话作用域
   * 用的是本服务的 {@link DynamicWorkflowRunServiceDeps.parentSessionId}（= 本 app 的会话，
   * 也就是父会话）。
   */
  artifactStore?: ToolArtifactStorePort;
  /** 造一个 actor 的 child AgentRuntime（生产包装 createScriptWorkflowAgentRuntime）。 */
  createActorRuntime: (input: DynamicWorkflowActorRuntimeInput) => AgentRuntime;
  /** actor 会话的 task link 落库面；缺席则跳过建 link（会话本身仍落库）。 */
  taskLinkStore?: DynamicWorkflowTaskLinkStore;
  /**
   * actor 会话的转录存取面（生产就是 session store 本身）。driver 用它做两件事：ask 边界记账的
   * 计数，与 amend-resume 分歧 actor 的转录截断复制。
   *
   * 缺席时边界记账整体缺席——run 照常跑完，只是**不能再作为修订的前驱**（service 的
   * 「无 marker 前驱整体拒绝」门会挡下来）。可选而非必填，是因为不带会话存储的装配里本来就没有
   * 转录可数；带种子的会话创建在缺席时由 driver 大声失败。
   */
  actorTranscriptStore?: ActorTranscriptStore;
  /**
   * 引擎事件钩子：交出的是**已经准备好的会话事件载荷**（有界 payload + journal sequence +
   * 两个派生字段），调用方只负责把它追加到父会话（create-app 接 runtime 的 record 方法）。
   *
   * 为什么由本服务准备而不是让调用方拼：sequence 与 spentTokens 都只能从 journal 读，
   * 而 journal 是本服务的依赖；actor 会话 id 只能由铸造它的那个函数算。把这三件事推给
   * 调用方，等于把三个契约复制到一个没有 journal 的层里。
   *
   * 第二个参数是**路由**信息，刻意与载荷分开：`parentSessionId` 决定事件该落到哪个会话，
   * 但它不属于载荷本身（事件已经在那个会话里了，再存一份是冗余）。调用方据它做身份闸门，
   * 见 {@link createDynamicWorkflowRunProgressSink}。
   */
  onRunEvent?: (
    progress: DynamicWorkflowRunProgressPayload,
    routing: { parentSessionId?: string },
  ) => void;
  logger?: Logger;
  /** 注入并发度探测，供 caps 默认值测试固定双核（地板必须是 1）。 */
  availableParallelism?: () => number;
  /**
   * 进程级并发治理器的窄端口。原样转交 driver：
   * 有效并发 = min(本 run 的 caps.maxConcurrency, 该 provider key 的共享 live cap)。缺席即只有
   * per-run 上界（测试装配、无治理器的宿主）。
   */
  concurrency?: WorkflowConcurrencyPort;
  /**
   * 把一次启动登记为父 runtime 的**常驻阻塞工作**。
   *
   * 引擎活在会话 App 的闭包里、不进 runtime task registry，而常驻池当时
   * 只读 registry——一个仍在跑的 run 被读成 idle，App 被关闭，resume 起了第二个引擎。登记走
   * runtime 唯一的那个口（`trackResidencyBlockingWork`），常驻池因此不必再对 sidecar 做猜测。
   *
   * 缺席即宿主没有常驻概念（CLI 一次性执行、测试装配）：run 照常跑完，只是不挡关闭。
   */
  registerResidencyBlockingWork?: (work: Promise<unknown>) => void;
  /**
   * driver 的时钟与定时器：run 级
   * stall 时钟与瞬态失败的退避重驱都读它。**只为测试注入**（故障矩阵把 2s→60s 的重驱曲线与
   * 20 分钟的 stall 窗缩到毫秒级）；生产装配永不设置，缺席即 driver 用真时间。
   */
  driverClock?: AgentRuntimeWorkflowDriverDeps["clock"];
  /**
   * 按内联规则铸一份草稿（docs/dynamic-workflow/launch.md「The draft after a fill」）：一次补全
   * 落在一个没有草稿的 run 上时，有效脚本要有个家。规则（slug、`-2`/`-3` 顺延、独占创建、目录
   * 的 `.gitignore`）只在工具层有一份实现，宿主装配时注入，本服务不复制它。写不成回 `undefined`
   * （绝不抛）。缺席即不铸——补全照常成功，只是回话里没有路径。
   */
  writeWorkflowDraft?: (input: {
    cwd: string;
    name: string;
    source: string;
  }) => Promise<{ path: string } | undefined>;
}

export {
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
  supportsRunIntrospection,
  type DynamicWorkflowTaskLinkStore,
} from "./dynamic-workflow-run-journal.js";

/**
 * 本服务的完整面：{@link DynamicWorkflowRunPort}（引擎 / 工具层用）加两条**会话级**生命周期
 * 读面。后者的唯一消费者是宿主的 provider registry 安全边界：
 * 子代理共用父会话的 live adapter，一个在飞的 run 就是父会话的一段 active Loop——
 * registry replace 必须等它结算。
 */
interface DynamicWorkflowRunService extends DynamicWorkflowRunPort {
  /** 此刻仍未结算的 run 数（registry 里 `terminal === undefined` 的条目）。 */
  countLiveRuns(): number;
  /**
   * 订阅结算：每个 run 进终态（completed / errored / stopped，含 launch 前失败）后恰好通知
   * 一次，簿记已经完成（计数已经扣掉它）。返回退订函数。监听器抛错只记日志，不影响结算。
   */
  subscribeRunSettled(listener: (notice: DynamicWorkflowRunSettledNotice) => void): () => void;
  /**
   * 停下本服务拥有的每一个在飞 run 并等它们结算（文件头不变式 7）。**不在 contracts 的
   * {@link DynamicWorkflowRunPort} 上**：它是宿主 App 的生命周期动作，不是引擎与工具层的能力。
   * 幂等——第二次调用返回同一个 promise，不再 abort 任何东西。
   */
  close(): Promise<void>;
}

/**
 * 造 workflow run 服务。返回 {@link DynamicWorkflowRunService}：端口实现 + 两条会话级的
 * 生命周期读面（在飞 run 计数、结算订阅），后者不进 contracts 的窄端口——它们服务的是
 * 宿主的 registry 安全边界，不是引擎与工具层。
 */
export function createDynamicWorkflowRunService(
  deps: DynamicWorkflowRunServiceDeps,
): DynamicWorkflowRunService {
  const runs = new Map<string, RunRegistryEntry>();
  /**
   * 升级问答的停驻表。**一张，跨本服务名下所有在飞 run**：
   * qid 全局唯一正是为此——`resolveQuestion` 只收一个不透明 token，多 run 并发时让模型自己配对
   * `(runId, qid)` 是错配的温床。纯内存，与停驻的 deferred 同命（进程亡故即清空，靠 resume
   * 后 actor 重新提问自愈；持久化一张 pending 表只会说谎）。
   */
  const escalations: WorkflowEscalationRegistry = createWorkflowEscalationRegistry();
  /** 每个 run 的补全串行链（dynamic-workflow-run-fill.ts 文件头）；排空即删键。 */
  const fillQueues = new Map<string, Promise<unknown>>();

  // 构造即收敛：本实例名下此刻零个在飞 run，所以本会话的非终态行都是死进程的遗物。
  // 见文件头不变式 4 与 {@link reconcileOrphanRuns}。
  reconcileOrphanRuns(deps);

  /**
   * 本进程的默认并发 D（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）。
   * 与进程级治理器的桶起点同一份实现（决策 30）：run 的默认上界与桶的起点永远对得上。
   *
   * 本服务里它有四个读者，全部经这一个函数：新 run 的 caps 缺省、端口上的
   * {@link DynamicWorkflowRunPort.defaultConcurrency}（工具层据它写「（默认）」与判断「值不值得一提」）、
   * 两条读面的 `maxConcurrency` 判据，以及 `run-started` 载荷上的派生字段。
   */
  const defaultConcurrency = (): number =>
    resolveWorkflowDefaultConcurrency(deps.availableParallelism);

  // caps 只剩并发上界（docs/dynamic-workflow/authoring.md：token 预算与节点上限整体移除，
  // 无墙钟超时；取消是唯一的停止手段）。缺席即默认并发；给了就照用（向下取整、至少 1），
  // 高于默认也照用——没有上限（docs/dynamic-workflow/concurrency.md）。
  const caps = (requested?: number): Caps => {
    return { maxConcurrency: normalizeRunConcurrency(requested, defaultConcurrency()) };
  };

  // 内省面按能力探测接上（那四条查询不在引擎端口上）。缺席时下面两个**可选成员整个不实现**：
  // 消费方的 `typeof port.listRuns === "function"` 探测因此为假，工具层把它归一成
  // 「本会话没有这个能力」的业务失败——而不是一个静默的空列表。
  const introspection = supportsRunIntrospection(deps.journal) ? deps.journal : undefined;

  // 生命周期簿记（结算 / 关闭 / 关闭闸门 / 外来终态行留痕；文件头不变式 6、7）的实现体在
  // dynamic-workflow-run-lifecycle.ts：它们只借用这里的注册表与 journal，经窄依赖递过去。
  const {
    countLiveRuns,
    subscribeRunSettled,
    trackSettlement,
    close,
    assertOpen,
    trackOperation,
    noteForeignTerminalRow,
  } = createRunServiceLifecycle({
    journal: deps.journal,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    parentSessionId: deps.parentSessionId,
    ...(deps.registerResidencyBlockingWork === undefined
      ? {}
      : { registerResidencyBlockingWork: deps.registerResidencyBlockingWork }),
    runs,
  });

  // 两条入口（submit / resume）的实现体在 dynamic-workflow-run-submit.ts：它们只借用这里的
  // 注册表、停驻表、caps 与结算簿记，经 ctx 显式递过去，本文件不再复制那两段。
  const entryContext: DynamicWorkflowRunEntryContext = {
    deps,
    runs,
    escalations,
    caps,
    assertOpen,
    trackSettlement,
  };

  return {
    countLiveRuns,
    subscribeRunSettled,
    close,

    // 三条入口的关闭门。`async` 只为把这个接线错误变成 rejection 而不是同步抛；门与随后的
    // 委托之间没有 await，所以不变式 6 的「登记与 launch 同一同步片」不受影响。
    async submit(
      request: DynamicWorkflowRunSubmitRequest,
    ): Promise<DynamicWorkflowRunSubmitResult> {
      assertOpen();
      return trackOperation(() => submitDynamicWorkflowRun(entryContext, request));
    },

    async amend(request: DynamicWorkflowRunAmendRequest): Promise<DynamicWorkflowRunAmendResult> {
      assertOpen();
      return trackOperation(() => amendDynamicWorkflowRun(entryContext, request));
    },

    /**
     * 本进程的默认并发（端口契约见 {@link DynamicWorkflowRunPort.defaultConcurrency}）。
     * 与 caps 的缺省是**同一个** {@link defaultConcurrency}：确认窗写的「默认 N」必须就是一个没设
     * 上界的 run 将要跑的那个数。
     */
    defaultConcurrency,

    /**
     * 就地改一个在飞 run 自己的并发上界（端口契约见
     * {@link DynamicWorkflowRunPort.retuneConcurrency}；实现体在 dynamic-workflow-run-retune.ts）。
     *
     * 刻意**不过关闭门**：三条启动入口要 `assertOpen` 是因为它们会起引擎，而这一条什么都不起——
     * 关闭中的 service 里每个条目都在结算，存活判定自己会把它报成 `not_live`。
     */
    async retuneConcurrency(
      request: DynamicWorkflowRunRetuneRequest,
    ): Promise<DynamicWorkflowRunRetuneResult> {
      return retuneRunConcurrency({ runs, journal: deps.journal, defaultConcurrency }, request);
    },

    async resume(runId: string): Promise<DynamicWorkflowRunResumeResult> {
      assertOpen();
      return trackOperation(() => resumeDynamicWorkflowRun(entryContext, runId));
    },

    async listRunsForSession(limit?: number): Promise<DynamicWorkflowRunSessionSummary[]> {
      if (!supportsRunEnumeration(deps.journal)) {
        // 无枚举查询（如内存 journal）：空列表是诚实答案——内存 journal 里的 run 本就
        // 不会活过进程，重启后的发现面没有可还原的东西。
        return [];
      }
      const capped = Math.max(1, Math.min(limit ?? DEFAULT_LIST_RUNS_LIMIT, MAX_LIST_RUNS_LIMIT));
      let rows: DwfRunSessionListItem[];
      try {
        rows = deps.journal.listRunsByParentSession(deps.parentSessionId, capped);
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run enumeration failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.list_failed",
          module: "bootstrap.app",
        });
        return [];
      }
      // 活条目一并交给摘要：会话枚举面与快照 / 列表 / 详情共用同一条优先级（规则三），
      // 否则这一面会独自显示一个被外来写入标死的 run。
      return rows.map((row) => toSessionSummary(row, runs.get(row.runId)));
    },

    async replayProgressForSession(input: {
      excludeRunIds: ReadonlySet<string>;
    }): Promise<DynamicWorkflowRunProgressPayload[]> {
      if (!supportsRunEnumeration(deps.journal)) return [];
      let rows: DwfRunSessionListItem[];
      try {
        // 上界与投影的淘汰同一个常量：冷态 = 一个长寿进程此刻会持有的状态。
        rows = deps.journal.listRunsByParentSession(
          deps.parentSessionId,
          WORKFLOW_RUNS_LIMITS.maxRuns,
        );
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run replay enumeration failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.replay_failed",
          module: "bootstrap.app",
        });
        return [];
      }
      const payloads: DynamicWorkflowRunProgressPayload[] = [];
      // 枚举面最近更新在前；回放要最旧优先，reducer 的淘汰才与 live 时的到达顺序同形。
      for (const row of [...rows].reverse()) {
        // 调用方内存里已有事件的 run（本进程跑过）与注册表在飞的 run 都不回放：
        // 它们的事件全在内存 store 里，再喂一遍只会让 run-started 把相位打回起点。
        if (input.excludeRunIds.has(row.runId) || runs.has(row.runId)) continue;
        // 默认并发与 live 侧同源：冷回放的 `run-started` 载荷必须与 live 那一条逐字节相等。
        payloads.push(...replayRunProgress(row, deps.journal, defaultConcurrency()));
      }
      return payloads;
    },

    async getTask(taskId: string): Promise<DynamicWorkflowRunSnapshot | undefined> {
      noteForeignTerminalRow(taskId);
      return snapshotOf(
        taskId,
        runs,
        deps.journal,
        escalations.pendingFor(taskId),
        defaultConcurrency(),
        // 留白与停驻问题同规由这里投影好递进去：`waiting` 读的是引擎的停驻表（经条目的控制面）。
        runHolesOf(taskId, runs.get(taskId), deps.journal),
      );
    },

    /**
     * 给一处正在等的留白补上函数体（端口契约见 {@link DynamicWorkflowRunPort.fillHole}；实现体在
     * dynamic-workflow-run-fill.ts）。与 `retuneConcurrency` 同规地**不过关闭门**：它什么都不起，
     * 关闭中的 service 里引擎自己会以 `settled` 拒绝。
     */
    async fillHole(request: DynamicWorkflowRunFillHoleRequest): Promise<FillWorkflowHoleResult> {
      return fillDynamicWorkflowHole({ deps, runs, fillQueues }, request);
    },

    /**
     * run 存档的脚本（端口契约见 {@link DynamicWorkflowRunPort.getScript}）。注册表条目在前：
     * submit → createRun 的间隙里 journal 还没有行，条目上的就是同一份字节。journal 那一份也是
     * resume 的哈希校验读的字节，所以 `AmendWorkflow` 的沿用、`script_unchanged` 预检与 resume
     * 对「这个 run 在跑什么」不会有两个答案。
     */
    async getScript(runId: string): Promise<string | undefined> {
      return runs.get(runId)?.scriptText ?? deps.journal.getRun(runId)?.scriptText;
    },

    async waitForTask(
      taskId: string,
      options?: { signal?: AbortSignal },
    ): Promise<DynamicWorkflowRunSnapshot | undefined> {
      const entry = runs.get(taskId);
      // 不在注册表里：可能是本进程之前的 run（journal 有记录）或全然未知。两种都不可等待。
      if (entry === undefined) {
        return snapshotOf(
          taskId,
          runs,
          deps.journal,
          escalations.pendingFor(taskId),
          defaultConcurrency(),
          runHolesOf(taskId, undefined, deps.journal),
        );
      }
      if (entry.terminal === undefined) await settleOrAbort(entry.settlement, options?.signal);
      // 停驻项在**等待之后**重新投影：等待期间问题可能已被作答或随取消撤下。
      return snapshotOf(
        taskId,
        runs,
        deps.journal,
        escalations.pendingFor(taskId),
        defaultConcurrency(),
        runHolesOf(taskId, entry, deps.journal),
      );
    },

    /**
     * 回答一个 actor 升级上来的阻塞问题。查表 → driver 结算 → `escalate` 的工具结果变成这段
     * 答案，actor 的轮次就地继续。**run 状态全程不动**：升级是 ask 内部的一次慢工具调用，
     * 不是 run 生命周期事件（按设计 escalate 不终结/冻结 run）。
     *
     * 三类结构化拒绝的判别与文案都在注册表里（它才知道一个 qid 是从没存在过、已被回答，
     * 还是随 ask 一起撤下了）。本方法刻意不加二次判断——两处各判一次，同一个 qid 迟早会在
     * 两个层上得到不同的解释。
     */
    async resolveQuestion(
      qid: string,
      answer: string,
    ): Promise<DynamicWorkflowResolveQuestionResult> {
      return escalations.resolve(qid, answer);
    },

    async cancel(
      runId: string,
      initiator: DynamicWorkflowRunCancelInitiator = "user",
    ): Promise<boolean> {
      const entry = runs.get(runId);
      // 未知 run（或已结算）没有可中止的东西。返回 false 让上层归一成结构化的 not_found，
      // 而不是报告一次没发生的取消。
      if (entry === undefined || entry.terminal !== undefined) return false;
      // abort 是 harness 里唯一的「真停止」：中止在飞 ask、kill 子进程，引擎经 stop(initiator)
      // 结算 stopped（已完结 journal 条目保留 → 可 resume）。abort 的 reason 就是 initiator——
      // harness 读 `signal.reason` 决定 stopped(user) 还是 stopped(model)，从此原因落库，
      // 不再只活在后台任务注册表里。
      entry.controller.abort(initiator);
      return true;
    },

    async listEvents(
      runId: string,
      options: DynamicWorkflowRunEventPage,
    ): Promise<DynamicWorkflowRunEventsResult> {
      // 审计面要的是逐字节的事件（report 的 item 也在内，线上再经载荷界裁剪），但一页的条数与
      // 字节数都有界（docs/execution-engine.md「Reading the journal」）：调用方不给时取协议的
      // 两道上限。网关总是给全两者，这里的缺省只防别的调用方写出一次无界读。
      const page = {
        ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
        limit: options.limit ?? WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
        maxBytes: options.maxBytes ?? WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
      };
      const { events, hasMore } = supportsEventPages(deps.journal)
        ? deps.journal.listEventPage(runId, page)
        : pageByCountOnly(deps.journal, runId, page);
      return {
        events: events.map((stored) => toProtocolEvent(stored.sequence, stored.event)),
        hasMore,
      };
    },

    /**
     * 本 run 的用户面产物清单。UI 冷恢复与中枢详情的
     * durable 读法：`workflowRuns.artifacts` 投影是 memory-only，重启后为空，而版本历史的
     * 持久家一直是 journal 的 `kind = "artifact"` 行。
     *
     * 归并规则整段复用 {@link artifactsOf}——终态快照（`getTask`）与本方法必须给出**同一份**
     * 清单，两处各归并一份迟早会在「失败行算不算一版」这种地方分叉。
     *
     * ⚠ 术语：这里的 artifact 是脚本发布给用户看的产出，不是端口上的 `output`（脚本顶层
     * 返回值，引擎内部也叫 artifact）。
     *
     * 未知 runId 与「本 journal 没有产物读面」都回 `undefined`：对调用方是同一个业务事实。
     */
    async listArtifacts(runId: string): Promise<readonly DynamicWorkflowRunArtifact[] | undefined> {
      return artifactsOf(runId, deps.journal).artifacts;
    },

    /**
     * 喂给某个预置产物的 `report` 条目，按 journal sequence 升序分页（看板的取数面）。
     * 越界 cursor 得到空页而不是错误——翻到尾巴是正常的翻页结局。
     */
    async listArtifactItems(
      runId: string,
      artifactId: string,
      page: DynamicWorkflowRunArtifactItemPage,
    ): Promise<DynamicWorkflowRunArtifactItemsResult> {
      return listArtifactItemsFrom(deps.journal, runId, artifactId, page);
    },

    /**
     * 读某个产物版本的字节。授权链（run 属于本会话 ∧ journal 有该版本的 completed 行 ⇒ 取
     * 行上的 uri）整段在 {@link readWorkflowArtifactBytes}，那里画了链路图。
     *
     * `parentSessionId` 用**本服务的**那一个（= 本 app 的会话），刻意不收参数：服务实例本就
     * 按父会话构造，让调用方传任意会话等于开一个跨会话读洞——与 `listRunsForSession` 同一条
     * 论证，只是那边是枚举、这边是字节。
     */
    async readArtifact(
      runId: string,
      artifactId: string,
      version: number,
    ): Promise<DynamicWorkflowRunArtifactBytes | undefined> {
      return readWorkflowArtifactBytes(
        {
          journal: deps.journal,
          parentSessionId: deps.parentSessionId,
          ...(deps.artifactStore === undefined ? {} : { artifactStore: deps.artifactStore }),
        },
        runId,
        artifactId,
        version,
      );
    },

    /**
     * 工作区 transcript 的清单与正文。授权链
     * 与 readArtifact 同一条（run 属于本会话），两条都走——清单上的 args 已经是路径与命令行。
     * 整段在 dynamic-workflow-run-workspace.ts。
     */
    async listWorkspaceNodes(
      runId: string,
    ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined> {
      return listWorkspaceNodesFrom(
        { journal: deps.journal, parentSessionId: deps.parentSessionId },
        runId,
      );
    },

    async readWorkspaceNodeResult(
      runId: string,
      siteId: string,
      ordinal: number,
      query: DynamicWorkflowRunWorkspaceNodeResultQuery,
    ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined> {
      return readWorkspaceNodeResultFrom(
        { journal: deps.journal, parentSessionId: deps.parentSessionId },
        runId,
        siteId,
        ordinal,
        query,
      );
    },

    ...(introspection === undefined
      ? {}
      : createRunIntrospectionMethods({
          introspection,
          journal: deps.journal,
          parentSessionId: deps.parentSessionId,
          runs,
          escalations,
          defaultConcurrency,
        })),
  };
}
