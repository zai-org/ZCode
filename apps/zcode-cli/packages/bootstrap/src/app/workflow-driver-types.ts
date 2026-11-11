// ============================================================
// AgentRuntime-backed WorkflowDriver：共享类型
// ============================================================
// workflow-driver.ts 顶到 oxlint max-lines 上限（400 行），把 driver 的依赖包
// （AgentRuntimeWorkflowDriverDeps）、runtime 工厂签名（ActorRuntimeFactory）与每个 actor 会话的
// 运行态（SessionState）拆到本文件，供 workflow-driver.ts / workflow-driver-escalation.ts /
// workflow-driver-helpers.ts 三处共用；公开面（ActorRuntimeFactory）仍从 workflow-driver.ts 导出。
// 这里只有类型，零运行时代码。

import type {
  ExecutionPort,
  FileSystemPort,
  Logger,
  ModelRequestAdmission,
  SessionId,
  SubmitVerdict as ContractsSubmitVerdict,
  ToolArtifactStorePort,
  WorkflowEscalatePort,
  WorkflowWebSearchBudgetPort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type {
  ActorSubmitProfile,
  ActorRef,
  ActorSessionSeed,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
  RunEvent,
  SessionRef,
} from "@zcode/dynamic-workflow";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
import type { ActorModelActivity, WorkflowClock } from "./workflow-driver-concurrency.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import type { WorkflowRunSeatGate } from "./workflow-seat-gate.js";

/** 一个可外部结算的 promise。 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * actor runtime 工厂：给定会话 id / actor / persona / 会话级 submit 端口，产出一个已装配好的
 * child AgentRuntime。注入 submitPort 即为该会话注册 submit_result 工具（core 的注册门以端口存在为准）。
 *
 * 把「如何构造 runtime」抽成注入点：生产侧包装 createScriptWorkflowAgentRuntime（携真实 model adapter
 * 与全套 deps）；测试侧用最小 deps bag + 脚本化 model adapter。driver 本体只管生命周期与桥接。
 *
 * 允许返回 Promise：生产侧要在返回前把 actor 会话落库并建 task link，而
 * `session_task_link.child_session_id` 对 `session(id)` 有 FK，因此「建会话行」必须先于「建 link」。
 * 引擎的 ensureSession 会 await createActorSession，所以 await 在此处天然安全——第一次 ask
 * 派发前，会话已完成持久化。
 */
export type ActorRuntimeFactory = (input: {
  sessionId: SessionId;
  actor: ActorRef;
  persona: PersonaSpec;
  submitPort: WorkflowSubmitPort;
  /**
   * 该 actor 的 submit profile。工厂据此决定注册哪一种 submit_result：`untyped` → **不注入** submitPort（core 的
   * 注册门是端口在场，于是没有工具）；`mono` → 注入端口 + `workflowSubmitSchema`（typed 声明）；
   * `generic` → 只注入端口（今天的通用声明）。driver 从 deps.actorSubmitProfiles 按 actor 站点查得，
   * 缺席即 generic。
   */
  submitProfile: ActorSubmitProfile;
  /**
   * 会话级升级端口。注入方式与 submitPort 完全同构：
   * 端口在场即为该会话注册 `escalate` 工具（core 的注册门以端口存在为准），**恒注入、不做
   * opt-in**——最可能撞上未预见之墙的 actor 恰是作者没标记的那一个。
   */
  escalatePort: WorkflowEscalatePort;
  /**
   * 每个 ask 的 WebSearch 预算端口：计数在 driver 的会话状态里（startAsk 归零），上限取
   * persona 的 `budget.webSearch`，缺席用默认值。恒注入，与升级端口同路下传到 runtime deps。
   */
  webSearchBudgetPort: WorkflowWebSearchBudgetPort;
  /**
   * amend-resume 的会话种子，仅当本 actor 消费了 ≥1 条导入 ask 条目时在场。
   *
   * 工厂只需要它的一件事：`resolvedModel` 是**前驱解析出的模型 pin**，要像 journal 里的 pin 一样
   * 压过档位重解析（转录接续下静默换模型，正是 pin 要防的身份突变）。转录复制本身不归工厂——那是 driver 在工厂返回**之后**做的事（会话行要先存在，
   * `message.session_id` 对 `session(id)` 有 FK）。
   */
  seed?: ActorSessionSeed;
  /**
   * 该 actor runtime 的模型请求准入端口：
   * 只在 driver 拿到治理器端口时在场；工厂把它放进 runtime deps 的 `modelRequestAdmission`，
   * runner 每次模型请求尝试先经它过闸门。缺席即该 runtime 不受闸门约束。
   */
  modelRequestAdmission?: ModelRequestAdmission;
}) => AgentRuntime | Promise<AgentRuntime>;

/** 构造 AgentRuntime-backed driver 所需的依赖（journal 与 emit 由调用方/harness 提供并持有）。 */
export interface AgentRuntimeWorkflowDriverDeps {
  journal: JournalStorePort;
  emit: (event: RunEvent) => void;
  /** world-read（files.glob / files.read / files.grep）落到的文件系统端口。 */
  fileSystemPort: FileSystemPort;
  /**
   * git.* world-read 落到的子进程执行端口（cwd = 工作区根）。
   *
   * **必填而非可选**：可选会给出一条静默降级的运行路径——`git.*` 在生产里能用、在某个忘了
   * 接线的装配里静默变成"不是 git 仓库"，而那两种失败在脚本里长得一模一样。宁可让接线错误
   * 在编译期出现（这也是本包对 fileSystemPort 的既有做法）。
   */
  executionPort: ExecutionPort;
  /**
   * 升级问答的停驻注册表。driver 在这里登记停驻中的问题，
   * run service 的 `resolveQuestion` 经同一张表把答案送回来。
   *
   * **必填而非可选**，理由同上面的 executionPort：可选会给出一条静默降级的运行路径——没有表
   * 时 `escalate` 要么永久悬挂（最坏），要么静默退化成「这个能力不存在」，而那与「作者没给
   * actor 升级权」在模型眼里长得一模一样。宁可让接线错误在编译期出现。
   */
  escalationRegistry: WorkflowEscalationRegistry;
  /** world-read 与产物发布共用的路径解析基准目录（workspace 根）。 */
  cwd: string;
  /**
   * 用户面产物（`artifact.file` / `artifact.markdown`）的
   * 字节落点。⚠ 这里的 artifact 是**交付给用户看的产出**，不是引擎内部那个 artifact
   * （`RunSettlement.artifact` 的顶层返回值，那是给模型看的）。
   *
   * **可选**，与 `actorTranscriptStore` 同款论证：不带 store 的装配（纯 replay、fake driver、
   * 最小 stub）本来就没有地方放字节。缺席**不是静默降级**——内容成员以命名的
   * `ArtifactStoreUnavailable` 拒绝该节点（脚本可 catch、节点以 failed 落 journal），而不是
   * 退回写工作区，也不是发布一个空产物。预置成员（chart/table/…）不受影响：它们是声明，
   * 根本不经 driver。
   */
  artifactStore?: ToolArtifactStorePort;
  /**
   * 本 run 的父会话 id，**只有产物发布用它**：store 的写入按会话作用域记账
   * （`zcode-artifact://<session>/<id>`），这个作用域就是父会话。
   *
   * 与 `artifactStore` 成对出现（生产装配由 run service 同时给出，两者都来自同一个 app
   * 会话）；只给一半时发布同样以 `ArtifactStoreUnavailable` 大声失败，见
   * {@link ArtifactPublishDeps}。actor 会话 id 不走这个字段——那是 mintActorSessionId 铸的。
   */
  parentSessionId?: SessionId;
  /**
   * 每个 actor 站点的 submit profile，编译期由 `deriveActorSubmitProfiles` 算出（run 提交路径的
   * compileOnce）。可选：缺席 = 每个 actor 都 generic（历史行为），不算 profile 的装配
   * （snippet、fake driver、既有测试）因此一字不改。
   */
  actorSubmitProfiles?: ReadonlyMap<string, ActorSubmitProfile>;
  runtimeFactory: ActorRuntimeFactory;
  /**
   * 进程级并发治理器的窄端口。在场时
   * driver 给每个 actor runtime 一个 `ModelRequestAdmission`（经 runtimeFactory 入参下传到 runtime
   * deps）：runner 的**每次模型请求尝试**先过闸门；并订阅本 run 的 cap 变化扇出成
   * `concurrency-changed`。缺席即 actor 不受闸门约束（fake / 纯 replay 装配零改动）。引擎侧对此无感
   * （v1 的 `acquireSlot` 已删）。
   */
  concurrency?: WorkflowConcurrencyPort;
  /**
   * 本 run 的座位闸门（docs/dynamic-workflow/concurrency.md「Retuning a live run」）：本 run
   * **自己**的并发上界中途被改低时，超出的子代理在下一个 turn step 前停住。在场时 driver 做两件
   * 事——把每个 actor 的准入端口包进闸门，以及把 ask 的起止喂给它（startAsk 与引擎的
   * `node-settled`，见 workflow-driver.ts）。
   *
   * 可选：缺席即这个 run 的上界从不中途变动（snippet、fake driver、既有测试装配），准入端口与
   * 从前逐字相同。**在场也不改变从未被改低过的 run 的行为**：上界之上的请求原地通过，闸门不发
   * 任何事件、不持任何票。
   */
  seatGate?: WorkflowRunSeatGate;
  /**
   * actor 会话的转录存取面（生产是 session store 本身）。两个用途共用它，且**必须**是同一个：
   * ask 边界记账的计数，与种子截断的复制（见 workflow-actor-transcript.ts 的模块说明）。
   *
   * 可选，因为不带会话存储的装配（纯 replay 测试、最小 stub runtime）本来就没有转录可数：
   * 缺席时边界记账整体缺席，代价是**该 run 不能再作为修订的前驱**（service 侧的「无 marker
   * 前驱整体拒绝」门会挡下来），而不是一条错误的边界。带种子的会话创建则在缺席时大声失败——
   * 引擎已经据导入事实认定要接转录，此时没有存取面就是接线错误。
   */
  actorTranscriptStore?: ActorTranscriptStore;
  logger?: Logger;
  /**
   * 本 run 的 id。actor 会话 id 以它为作用域——不含 runId 的方案会让并发两个 run 的同
   * site×ordinal actor 撞成同一个会话 id（`createSessionId("wf-actor-" + refToString(actor))`
   * 就是这个 bug）。缺省 "run" 只为不破坏既有测试装配。
   */
  runId?: string;
  /**
   * 时钟与定时器（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）：run 级 stall 时钟、瞬态失败的退避
   * 重驱与会话静默的有界等待都用它。可注入只为测试假时间；`stallAfterMs` 缺省 20 分钟；
   * `quiesceMs` 缺省 {@link AMEND_TRANSCRIPT_QUIESCE_MS}；`random` 供退避抖动。
   */
  clock?: WorkflowClock & {
    stallAfterMs?: number;
    quiesceMs?: number;
    random?: () => number;
  };
  /**
   * 交出本 driver 的**会话静默探针**（workflow-driver-quiescence.ts）。构造时恰好调一次，
   * 调用方把探针挂到自己那条 run 的注册表条目上——amend 接续在飞 ask 之前要问它。
   *
   * 走回调而不是让 `createAgentRuntimeWorkflowDriver` 返回一个二元组：driver 实例由**引擎**
   * 在 `makeDriver(sink)` 时才造出来，装配方拿不到那个返回值。缺席即调用方不关心静默
   * （测试装配、直接用 harness 的路径）。
   */
  onQuiescenceProbe?: (probe: ActorSessionQuiescence) => void;
}

/**
 * 每个 actor 会话的运行态。per-actor FIFO（引擎保证）→ 每会话至多一个在飞 ask，因此
 * currentInstance / pendingSubmit / accepted / cancelled 都是「当前实例」语义，无需按 instance 细分。
 */
export interface SessionState {
  readonly ref: SessionRef;
  /** 与 `ref.id` 同值，只是保留了品牌类型（转录存取面按 SessionId 取数）。 */
  readonly sessionId: SessionId;
  readonly runtime: AgentRuntime;
  /**
   * 该会话实际注册的 submit_result 形态。创建时取自静态 profile；**唯一**会变的路径是运行时守卫
   * （workflow-driver.ts 的 ensureSubmitProfileFits）：mono 声明与实际 ask 的 schema 不符时降级成
   * generic，此后不再升回。
   */
  submitProfile: ActorSubmitProfile;
  /** 当前在飞 ask 的实例；startAsk 设置。 */
  currentInstance?: InstanceRef;
  /** 当前 ask 是否 typed（untyped 不走 submit 桥接）。 */
  currentTyped: boolean;
  /** submit_result handler 阻塞其上的裁决 deferred；至多一个（单前实例）。 */
  pendingSubmit?: Deferred<ContractsSubmitVerdict>;
  /**
   * 停驻中的升级问答，键 = qid。与 pendingSubmit 不同**必须是多个**：一轮里模型可以并行发出
   * 几个 escalate 工具调用，每个都是一次独立的问答（上限由 escalationsUsed 管）。
   */
  readonly pendingEscalations: Map<string, Deferred<string>>;
  /**
   * 本次 ask 已用掉的升级次数（含被上限短路掉的那几次不计——见 makeEscalatePort）。
   * per-ask 计数，startAsk 归零；nudge 轮**不归零**（nudge 仍在同一个 ask 里）。
   */
  escalationsUsed: number;
  /**
   * 本次 ask 已发起的 WebSearch 次数（被预算拒掉的不计）。与 escalationsUsed 同族：per-ask，
   * startAsk 归零，nudge / repair 轮不归零。
   */
  webSearchesUsed: number;
  /** 本子代理每个 ask 的 WebSearch 上限：persona 的 `budget.webSearch` 或默认值，建会话时定下。 */
  readonly webSearchLimit: number;
  /** 当前 ask 的 turn 取消控制器；startAsk 每 ask 重建。 */
  abortController?: AbortController;
  /** 当前 ask 已被引擎 accept：其 turn resolve 时不再上报 askTurnEnded（已由引擎结算）。 */
  accepted: boolean;
  /** 当前 ask 被引擎主动取消：turn reject 不上报 askFailed（引擎已结算 failed/cancelled）。 */
  cancelled: boolean;
  /**
   * 本会话上已发起的 turn 轮次。用途只有一个：分辨 `askTurnEnded` 之后引擎是否**又起了一轮**
   * （nudge 走的正是这条路），从而判断这次 ask 的交换是不是真的结束了——边界记账要的是整段
   * 交换的末尾，不是任意一个 turn 的末尾。
   */
  turnGeneration: number;
  /**
   * 当前在飞 turn 的收尾链（executeTurn 连同 onTurnResolved / onTurnRejected）。只有一个读者：
   * dispose 要等它落地再关 runtime——accept 路径的 askStats 在 settle 之后才到（turn 在 submit
   * 之后才 resolve），同步关会与这条尾巴竞争。
   */
  turn?: Promise<void>;
  /**
   * 该 actor 的模型活动面：准入端口 + 会话事件观察（waiting / executing 徽标的来源）。
   */
  modelActivity: ActorModelActivity;
  /** 本会话的 actor 身份（ProviderStop 明细点名触发停止的子代理）。 */
  readonly actor: ActorRef;
  readonly actorName: string | undefined;
  /**
   * 当前 ask 里 driver 侧瞬态重驱的次数：runner 放过来的瞬态失败（流恢复耗尽等）不结算节点，按退避曲线再起一轮。
   * startAsk 归零。
   */
  transientAttempts: number;
  /** 退避等待中的重驱闹钟；cancelAsk / dispose 撤掉。 */
  cancelRedrive?: () => void;
}
