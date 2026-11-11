// ============================================================
// Dynamic Workflow Run Port - dwf 引擎 run 的提交 / 观察 / 取消边界
// ============================================================

import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentView,
} from "./dynamic-workflow-run-roster.port.js";
import type {
  DynamicWorkflowRunRetuneRequest,
  DynamicWorkflowRunRetuneResult,
} from "./dynamic-workflow-run-retune.port.js";
import type {
  DynamicWorkflowRunFillHoleRequest,
  DynamicWorkflowRunHole,
  FillWorkflowHoleResult,
} from "./dynamic-workflow-run-hole.port.js";
import type {
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
} from "./dynamic-workflow-run-workspace.port.js";
import type { DynamicWorkflowRunProgressPayload } from "../events/session.events.js";
import type { ModelSelection } from "../model/model.js";
import type { SessionId, ToolCallId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { WorkflowTaskSnapshot } from "./workflow.port.js";

/**
 * 一次 workflow run 的提交请求。脚本文本是权威输入（编译、site 表、schema 合成、lowering
 * 都从它派生），因此这里只递脚本与执行上下文，不递任何编译产物——「编译一次」发生在
 * 端口实现侧（run service），调用方不该有编译产物的概念。
 */
export interface DynamicWorkflowRunSubmitRequest {
  /** workflow 脚本源码。逐字节落库（dwf_run.script_text），resume 以其哈希为前提。 */
  scriptText: string;
  /** run 的工作目录（沙箱子进程 cwd、world-read 的根）。 */
  cwd: string;
  /**
   * run 的展示名（`CreateWorkflow` 的可选 `input.name`）。落 `dwf_run.name`，供枚举面当标签。
   * 纯展示元数据：不参与执行、不参与 resume 校验；缺席即没起名（读侧按脚本首行兜底）。
   */
  name?: string;
  /**
   * 本次 run 的实参（saved workflow 的声明式参数，工具侧已按声明校验并回填默认值）。
   *
   * 与 `name` 不同，这**不是**展示元数据：它落 `dwf_run.args_json` 并注入沙箱成为脚本可读
   * 的 `args` 全局，是 run 身份的一部分——resume 重放存下的这一份，永不接受新的。内联脚本
   * 没有实参，字段缺席即 `{}`。
   */
  args?: Record<string, unknown>;
  /** 发起这次 run 的会话；引擎事件投影回该会话。 */
  parentSessionId?: SessionId | string;
  /** 发起这次 run 的 CreateWorkflow 工具调用（工具卡→详情页的关联键）。 */
  toolCallId?: ToolCallId | string;
  /**
   * 发起 run 那一轮的 inputId：子代理的
   * `agent_step` 归到这个 message 下。只有中枢直接启动填它（`startSavedWorkflowRun` 铸的
   * UUID v7，与 controlOnly 启动轮共用）；聊天路径缺席，由 run service 从父 runtime 的活动轮解析。
   */
  launchInputId?: string;
  /**
   * 脚本声明的阶段表（因果图有名阶段，声明序，≤ 32 × 128；`createWorkflowPhaseNames`）。引擎把它
   * 与锚点一起记进 `run-launched`，sessions-index 投影据此给侧栏迷你轨道画出前方的站点。纯展示元数据：不参与执行、
   * 不参与 resume 校验；脚本没有 `phase()` 标记时缺席。
   */
  phaseNames?: string[];
  /**
   * 本 run 自己的并发上界（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）：同时在飞的
   * ask 数，落 `dwf_run.caps_max_concurrency`、resume 照用。**缺席即默认并发**（机器推导值，
   * `resolveWorkflowDefaultConcurrency`）；给了就向下取整、至少 1，**没有上限**——高于或低于默认都行。
   * 工具层在 `resolveInput` 里已经取整过一次（确认窗要显示实际生效的值），这里再取整是端口自己的契约。
   */
  maxConcurrency?: number;
  /**
   * 本 run 的子代理跑在哪个模型上。记进 journal 事件
   * `run-launched` 的那个规范形的来源、resume 照用；**缺席即继承发起会话的模型**。
   *
   * 收的是结构化 {@link ModelSelection} 而不是字符串：工具层**已经**把用户说的名字经模型目录
   * 解析过一次（解不出来在确认窗之前就退回了），端口不该再做一次名字匹配——那会让「解析在哪
   * 发生」有两个答案。主代理自己不受影响：它恒留在会话模型上。
   */
  subagentModel?: ModelSelection;
  /**
   * 脚本里点名的模型（docs/dynamic-workflow/launch.md「Models the script names」）：键是脚本逐字
   * 写下的名字（运行期 persona 里带的就是它），值是工具层已经对着模型目录解析好的选择。与
   * {@link subagentModel} 同一条路、同一个理由收结构化选择：随 `run-launched` 记一次（规范串）、
   * 引擎从不读，宿主建子代理会话时按 persona 的名字查它。脚本没点名任何模型时缺席。
   */
  modelBindings?: Record<string, ModelSelection>;
  /**
   * 本 run 的脚本**来自哪个文件**的绝对路径。与 {@link subagentModel} 走同一条路：随 `run-launched` 记一次、引擎从不读、
   * 零 SQL（`dwf_run` 上没有这一列），两条读面再从事件读回。
   *
   * ⚠ 与本文件里产物的 `sourcePath` 无关：那是产物落盘的位置，这里是**脚本**的家。
   *
   * 缺席即这个 run 没有可编辑的脚本文件（草稿写不下去的项目、升级前发起的 run），模型面
   * 因此退回「改好脚本再内联提交」的老话。纯模型面元数据：桌面与 TUI 一概不显示它。
   */
  scriptPath?: string;
  /**
   * 与 {@link DynamicWorkflowRunSubmitRequest.phaseNames} **按位置对齐**的「同时在跑」表
   * （`createWorkflowPhaseAlongside`）：`phaseAlongside[i]` 是进入 `phaseNames[i]` 时 strand 仍在
   * 跑的其他阶段的**下标**（下标落在同一张 `phaseNames` 里）。侧栏迷你轨道据此把并行的两站画成
   * 双线段。
   *
   * 与 `phaseNames` 同一姿态：纯展示元数据，随锚点落 `run-launched`，引擎不读；没有阶段并行时
   * 整个字段缺席（缺席就是「这条轨道是一条直线」）。
   */
  phaseAlongside?: number[][];
  trace: TraceContext;
}

export interface DynamicWorkflowRunSubmitOptions {
  signal?: AbortSignal;
}

/**
 * submit 的结果。成功只有 runId：它同时是 backgroundTaskId 与 cancelBackgroundWork 的
 * workId（runId ≡ taskId ≡ workId），所以三条路径不需要各自的身份映射表。全新 run 没有可拒之处：
 * 接线故障（编译产物损坏、journal 不可用）仍然上抛。
 */
export type DynamicWorkflowRunSubmitResult = { ok: true; runId: string };

/**
 * {@link DynamicWorkflowRunPort.amend} 的请求。
 *
 * 修订是 **supersede**：以新脚本铸**新 run**，从前驱 journal 导入「每具名 actor 的已完结 ask
 * 前缀」与 world 节点作缓存。前驱**可以仍在飞**——那正是本方法存在的理由：service 先停下它、
 * 等它结算，再导入、再启动，一次调用完成，模型不再需要 TaskStop + 轮询 + 重提交三步。
 * 与 `scriptText` 完全正交：修订 run 重新声明脚本；实参（saved 来源才有）不随修订传递。
 */
export interface DynamicWorkflowRunAmendRequest {
  scriptText: string;
  cwd: string;
  /** 被修订的前驱 run。任意状态。 */
  predecessorRunId: string;
  /** 新 run 的展示名；缺席时 service 沿用前驱的 name。 */
  name?: string;
  parentSessionId?: SessionId | string;
  /** 发起这次修订的 AmendWorkflow 工具调用（新 run 的工具卡 → 详情页关联键）。 */
  toolCallId?: ToolCallId | string;
  /** **新脚本**的声明阶段表；语义同 {@link DynamicWorkflowRunSubmitRequest.phaseNames}。 */
  phaseNames?: string[];
  /**
   * 新 run 的并发上界；语义同 {@link DynamicWorkflowRunSubmitRequest.maxConcurrency}（缺席即天花板）。
   * 「省略即沿用前驱、`null` 即解除」是**工具面**的三态，在 `AmendWorkflow` 的 `resolveInput`
   * 里归一成这里的一个数或缺席——确认窗要显示沿用下来的值，所以那条规则只能住在 handler 之前。
   */
  maxConcurrency?: number;
  /**
   * 新 run 的子代理模型；语义同 {@link DynamicWorkflowRunSubmitRequest.subagentModel}（缺席即
   * 继承会话模型）。「省略即沿用前驱、`null` 即清除」是**工具面**的三态，在 `AmendWorkflow` 的
   * `resolveInput` 里连同一次重新解析归一成这里的一个选择或缺席。
   */
  subagentModel?: ModelSelection;
  /**
   * **新脚本**点名的模型；语义同 {@link DynamicWorkflowRunSubmitRequest.modelBindings}。「同名沿用
   * 前驱的绑定」是**工具面**的规则，在 `AmendWorkflow` 的 `resolveInput` 里连同重新解析归一成这里
   * 的一张表；端口不从前驱继承任何绑定。
   */
  modelBindings?: Record<string, ModelSelection>;
  /**
   * **新脚本**来自哪个文件的绝对路径；语义同 {@link DynamicWorkflowRunSubmitRequest.scriptPath}。
   *
   * 与并发上界、子代理模型不同，它**没有三态**：修订记的永远是这一次修订的脚本来自哪个文件
   * （`path` 提交就是那个文件，内联提交就是刚写下的草稿），绝不沿用前驱的——前驱的路径指向
   * 的是**旧脚本**，把它记到新 run 上就是让模型下次去编辑一个已经不在跑的文件。
   */
  scriptPath?: string;
  /**
   * **新脚本**的「同时在跑」表；语义同 {@link DynamicWorkflowRunSubmitRequest.phaseAlongside}
   * （下标落在本请求的 `phaseNames` 上，不是前驱的那张表）。
   */
  phaseAlongside?: number[][];
  /**
   * 新 run 沿用前驱落库的实参（`dwf_run.args_json`）。缺席即修订不带实参（工具路径的契约不变）。
   * 只有 GUI 的「配置」传它：它重跑的是前驱自己的脚本，脚本读的正是前驱启动时的那份实参；不沿用的话，一个带实参
   * 从中枢启动的已保存工作流会以空 `args` 重跑。
   */
  inheritArgs?: true;
  trace: TraceContext;
}

/**
 * amend 被拒的结构化理由。两者对模型是**两个不同的下一步**（换一个 run id / 放弃修订走一次
 * 全新 run），所以必须可分辨。可操作文案在工具层，端口只承载判别键。
 *
 * 没有「前驱仍在飞」这一条：在飞的前驱被停下而不是被拒（旧版的 `not_amendable` 与随之而来的
 * 「停止后轮询到 stopped 再重提交」竞态由此消失）。
 *
 * **拒绝即零副作用**：预检在停止前驱**之前**跑完，被拒时没有 dwf_run 行、没有注册表条目、
 * 前驱照旧在跑。
 */
export type DynamicWorkflowRunAmendRefusalReason =
  /** journal 里没有这个前驱 run。 */
  | "run_not_found"
  /** 前驱有已完结却缺消息边界记账的 ask，导入的转录截断无从谈起（整体拒绝，无降级回退）。 */
  | "missing_boundaries";

export type DynamicWorkflowRunAmendResult =
  | {
      ok: true;
      runId: string;
      /** 前驱在飞、被本次修订停下时在场（= predecessorRunId）；前驱早已结算则缺席。 */
      supersededRunId?: string;
    }
  | { ok: false; reason: DynamicWorkflowRunAmendRefusalReason };

/**
 * 取消的发起方。`user` / `model` 是两条停止入口的 initiator；`{ superseded }` 是 amend 路径
 * 停下在飞前驱时传的：新 run 的 id 随原因一起落进前驱的结算袋（`supersededBy`）。
 */
export type DynamicWorkflowRunCancelInitiator = "user" | "model" | { superseded: string };

/**
 * 终态快照带的 report item 上限（`reports` 的长度上界）。取 256——report 条数上限从 256 提到
 * 65,536 之前的值：报告条数不超过它的 run，快照与通知逐字节不变；更大的 run 由 `reportCount`
 * 说出真实总数。完成通知那一节的字符预算（8000）本来也容不下更多条。
 */
export const DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS = 256;

/**
 * 终态快照带的 report item 的字节上界（按 journal 里 `result_json` 的字节计）。取 8 MiB——
 * 单条上限 32 KiB 时 256 条的最坏情形，所以单条上限提到 1 MiB 之后快照的内存不涨。快照只喂
 * 完成通知，而通知每条最多展示 2,000 字符、整节 8,000 字符，8 MiB 远超它能用上的部分。
 * 第一条总是带上，所以一条 1 MiB 的报告不会让快照一条都不带。
 */
export const DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES = 8 * 1024 * 1024;

/**
 * run 快照：沿用 {@link WorkflowTaskSnapshot} 的形状（后台任务追踪器与通知管线按它读），
 * 只把 `output` 放宽——workflow run 的产物是脚本的顶层返回值，形状由脚本决定，不是 legacy
 * `Workflow` 工具的输出类型。legacy 端口本身不加宽（两套 workflow 机制不共用端口）。
 *
 * `reports` 是脚本 `report(item)` 交出的渐进产物**原值**，按报告顺序，来自 journal 的
 * `kind = "report"` 节点行——那是这些条目的持久家（`workflowRuns.reports` 只是有界的
 * memory-only 展示面）。完成通知据此在 completed / failed / cancelled 三态下一律回投：
 * 一个死在第 12 个 ask 上的 run 仍然做完了 11 个 ask 的活，捞回它正是 `report` 存在的理由。
 * 它只带**前** {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS} 条、且至多
 * {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES} 字节；真实总数在 `reportCount`
 * （docs/execution-engine.md「Reading the journal」）。
 */
export type DynamicWorkflowRunSnapshot = Omit<WorkflowTaskSnapshot, "output"> & {
  output?: unknown;
  /**
   * run 的真实终态词。基类的 `status` 是后台任务
   * 追踪器的通用词汇（`stopped` 折成 `cancelled`、`errored` 折成 `failed`），通知与工具文案
   * 要说真话必须读这两个字段；`stopReason` 只在 `runStatus === "stopped"` 时在场。
   */
  runStatus?: DynamicWorkflowRunLifecycleStatus;
  stopReason?: DynamicWorkflowRunStopReason;
  /** 发起这个 run 的会话（journal 的 parent_session_id；注册表条目在场时取它的）。 */
  parentSessionId?: string;
  /**
   * 引擎是不是在本进程手里，只对未终态的 run 在场。为假时 journal 说它在跑，引擎却在别的进程
   * （或死进程）：这里补不了它的留白，也修订不了它，FillWorkflowHole 与 AmendWorkflow 据此在开窗前拒绝。
   */
  liveInThisProcess?: boolean;
  /** 本 run 修订自哪个 run；不是修订则缺席。 */
  resumedFrom?: string;
  /** 本 run 被哪次修订停下并替代；未被替代则缺席。 */
  supersededBy?: string;
  /**
   * 本 run 自己的并发上界（`dwf_run.caps_max_concurrency`），**只在低于当前天花板时在场**：
   * 跑在天花板上的 run 没有可说的（「无则缺席」，与 `reports` 同规）。`AmendWorkflow` 的
   * `resolveInput` 据它决定省略 `max_concurrency` 时沿用什么。
   */
  maxConcurrency?: number;
  /**
   * 本 run 的子代理模型（journal 事件 `run-launched` 上的那一个），规范形
   * `providerId/modelId[$reasoningLevel]`，**只在设过时在场**：继承会话模型的 run 没有可说的
   * （「无则缺席」，与 `maxConcurrency` 同规）。
   * 这里是字符串而不是 {@link ModelSelection}：读面只用来显示与原样回填，没有人按字段取值。
   */
  subagentModel?: string;
  /**
   * 本 run 的脚本点名的模型（journal 事件 `run-launched` 上的那张表）：脚本逐字写下的名字 →
   * 规范串。**只在脚本点名过模型时在场**。`AmendWorkflow` 的 `resolveInput` 与 GUI「配置」据它让
   * 同名的绑定沿用下去（docs/dynamic-workflow/launch.md「Models the script names」）。
   */
  modelBindings?: Record<string, string>;
  /**
   * 本 run 的脚本文件（绝对路径，journal 事件 `run-launched` 上的那一个）。**只在这个 run 记下过文件时在场**。
   *
   * 终态通知据它把「改好脚本再内联提交」换成「就地编辑那个文件、再 `path` 修订」，所以它必须
   * 能从快照读到；用户面一概不显示（与 `subagentModel` 不同，后者会进桌面的 run 面板）。
   */
  scriptPath?: string;
  /** 结构化失败（与 {@link DynamicWorkflowRunDetail.error} 同源）；基类的 `error` 是它的 message。 */
  failure?: DynamicWorkflowRunError;
  /**
   * 本 run 及其 lineage 的**活动**时长（毫秒）：本 run 的每一世加上每个前驱的每一世，世与世
   * 之间的空档不计（口径与理由见 docs/dynamic-workflow/transcript-and-notifications.md
   * 「How long it took」）。完成卡的「时间」格报的就是它。
   *
   * 与 `reports` / `artifacts` 同规**只在终态在场**（`getTask` 被反复轮询，而消费者只有终态
   * 通知），且 journal 说不出话时整字段缺席——不是 0。缺席即读侧退回 `completedAt − startedAt`：
   * 那是结算它的那个进程自己看到的一世，一个更保守但永不虚报的答案。
   */
  activeDurationMs?: number;
  /** 前 {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS} 条 report item，按报告顺序；零条时缺席。 */
  reports?: readonly unknown[];
  /**
   * 本 run 的 report 真实总条数（`count(*)`），与 `reports` 同在同缺。通知与 manifest 的
   * `count` 读它：`reports` 被截在上限处时，`count ≠ shown` 就是「还有更多」的信号。
   */
  reportCount?: number;
  /**
   * 此刻停驻在这个 run 上、等主代理作答的升级问题。
   *
   * **从内存注册表投影，不是 journal 重放**：journal 里有 `escalation-raised` 与
   * `escalation-resolved` 两类事件，但「现在还欠谁一个答案」是进程内的活事实——重放出来的
   * 未配对 raised 在进程亡故后只会说谎（停驻的 deferred 早已随进程消失，resume 会让 actor
   * 重新提问、得新 qid）。
   *
   * 这是通知被丢弃（stale branch generation / shutdown drop）之后的**查询兜底**：主代理任何
   * 时候都能经既有观察面重新发现待答问题。零条时整字段缺席（不发空数组）。
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * 本 run 的留白（{@link DynamicWorkflowRunHole}）：到达过的每一处，等着的与补过的。与
   * `pendingQuestions` 同规——零条整字段缺席、`waiting` 从引擎的停驻表投影而不是单靠事件重放；
   * 留白通知的发射器与 `FillWorkflowHole` 的 resolveInput 都读它。
   */
  holes?: readonly DynamicWorkflowRunHole[];
  /**
   * 本 run 发布的**用户面产物**，按首次出现顺序，来自
   * journal 的 `kind = "artifact"` 行——那是版本历史的持久家（`workflowRuns.artifacts` 只带
   * 最新版元数据）。与 `reports` 同规：**只在终态**读（`getTask` 被反复轮询，而产物行的
   * 消费者是终态通知与 GetWorkflowRun）；零件时整字段缺席。
   *
   * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，与本类型的 `output`
   * （脚本顶层返回值，引擎内部叫 `RunSettlement.artifact`）无关。
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
};

/**
 * 一个用户面产物的一个版本（journal `dwf_node.result_json` 上 `ArtifactVersionRecord` 的
 * JSON 镜像）。**刻意在这里重新声明**而不是从 @zcode/dynamic-workflow import：端口只承载
 * JSON 形状（与 {@link DynamicWorkflowRunLifecycleStatus} 同一条论证）。
 *
 * 内容产物（`file` / `markdown`）填 `contentType` / `bytes` / `uri` / `sourcePath`；预置看板
 * （`chart` / `table` / `metrics` / `board`）填 `spec`。字节永不在这里——`uri` 指向
 * tool-artifact store。
 */
export interface DynamicWorkflowRunArtifactVersion {
  version: number;
  title?: string;
  description?: string;
  contentType?: string;
  bytes?: number;
  uri?: string;
  sourcePath?: string;
  spec?: unknown;
  /** 发布时刻（epoch 毫秒）。driver 恒写入。 */
  publishedAt: number;
  /** 这一版属于 run 的交付物。 */
  primary?: true;
}

/** 用户面产物的成员种类（facade `artifact.*` 的六个成员）。 */
export type DynamicWorkflowRunArtifactKind =
  | "file"
  | "markdown"
  | "chart"
  | "table"
  | "metrics"
  | "board";

/**
 * 一个用户面产物：id 下的全部版本（按版本号升序）+ 喂给它的标签 report 计数。
 * `title` / `description` / `contentType` / `sourcePath` / `spec` 取**最新版**的值，方便
 * 只关心「现在是什么」的读者不必自己翻 versions。
 */
export interface DynamicWorkflowRunArtifact {
  id: string;
  kind: DynamicWorkflowRunArtifactKind;
  title?: string;
  description?: string;
  contentType?: string;
  sourcePath?: string;
  spec?: unknown;
  /** 最新版号（= versions 末项的 version）。 */
  version: number;
  versions: readonly DynamicWorkflowRunArtifactVersion[];
  /** 打了这个 id 标签的 `report` 条目数（预置看板的数据量；内容产物恒 0）。 */
  itemCount: number;
  /** run 的交付物（至多一件）。`artifacts` 清单以它带头，其余按首次发布顺序。 */
  primary?: true;
}

/** 喂给某个预置产物的一条 `report` 条目，按 journal sequence 定位（看板的取数面）。 */
export interface DynamicWorkflowRunArtifactItem {
  sequence: number;
  siteId: string;
  ordinal: number;
  /** 整条 item；请求点名了 `fields` 时缺席。 */
  item?: unknown;
  /** 请求点名了 `fields` 时：路径 → 值，走不通的路径不在表里。 */
  fields?: Record<string, unknown>;
}

/**
 * {@link DynamicWorkflowRunPort.listArtifactItems} 的分页袋（cursor = journal sequence，严格大于）。
 * 两道界的语义同 {@link DynamicWorkflowRunEventPage}：条数到 `limit`、或再加一条就超过
 * `maxBytes` 时收尾，第一条总是带上。两者都由调用方（网关）给定，实现方精确兑现、不再钳。
 */
export interface DynamicWorkflowRunArtifactItemPage {
  afterSequence?: number;
  limit: number;
  maxBytes: number;
  /**
   * 只取这些字段路径（`readWorkflowArtifactField` 的规则，由 SQLite 取出），结果每条带 `fields`
   * 而不带 `item`，`maxBytes` 按取出的字段值计。缺省 = 整条 item。
   */
  fields?: readonly string[];
}

/** 看板条目的一页。`hasMore` 由存储层判定：页之后是否还有条目。 */
export interface DynamicWorkflowRunArtifactItemsResult {
  items: readonly DynamicWorkflowRunArtifactItem[];
  hasMore: boolean;
}

/** {@link DynamicWorkflowRunPort.readArtifact} 的返回：某个版本的全部字节。 */
export interface DynamicWorkflowRunArtifactBytes {
  bytes: Uint8Array;
  contentType: string;
}

/** 一个停驻中的升级问题。字段与 `escalation-raised` 事件同源，另加提问时刻。 */
export interface DynamicWorkflowRunPendingQuestion {
  /** 全局唯一的问题 id（形如 `dwfq-<runId 片段>-<seq>`）；`resolveQuestion` 只认它。 */
  qid: string;
  /** 提问的 actor，`refToString` 形态（如 `actor#1@1`）。恒在场，且在 run 内唯一定位。 */
  actor: string;
  /**
   * 这个 actor 的人类可读名（脚本里 `agent("poet")` 的 `"poet"`）。
   *
   * **匿名 actor 缺席本字段，且这里不合成任何兜底标签**：兜底是渲染决策，通知面与侧栏各有
   * 各的合适写法（一个要读成句子，一个要塞进一列）。在这里合成一个「actor#1@1」当名字，
   * 只会让两个消费者都拿不回「这个 actor 其实没有名字」这条事实。
   */
  actorName?: string;
  question: string;
  /** actor 补充的上下文（`escalate` 的可选 `context`）。 */
  context?: string;
  /** 提问时刻（epoch ms）。主代理据它判断「这个问题已经等了多久」。 */
  askedAt: number;
}

/**
 * {@link DynamicWorkflowRunPort.resolveQuestion} 的结构化拒绝理由。三者对模型是**三个不同的
 * 下一步**，所以必须可分辨：去快照里取正确的 id / 什么都不用做 / 这个 run 已经不需要答案了。
 */
export type DynamicWorkflowResolveQuestionRefusalReason =
  /** 注册表里没有这个 qid：拼错了，或来自已亡故进程的陈旧 id（停驻项不持久化）。 */
  | "unknown_question"
  /** 这个问题已经被回答过，actor 早已带着那次答案继续。 */
  | "already_resolved"
  /** qid 所属的 run / ask 已不在飞行中（被取消、失败或已结束），没有人在等这个答案。 */
  | "run_not_in_flight";

/**
 * `resolveQuestion` 的结构化结果。失败走 reason 而不是 throw，与
 * {@link DynamicWorkflowRunSubmitResult} 同一条论证：三种理由全是调用方可预期的业务分支。
 *
 * `message` 由实现侧写好（陈述现状与下一步）而不是留给工具层拼：判别键与文案分开维护，
 * 两处迟早会说不同的话，而这里的读者是模型——它读到的就是它的下一步。
 */
export type DynamicWorkflowResolveQuestionResult =
  | { ok: true; qid: string }
  | { ok: false; reason: DynamicWorkflowResolveQuestionRefusalReason; message: string };

export interface DynamicWorkflowRunWaitOptions {
  signal?: AbortSignal;
}

/**
 * 事件日志的分页参数；cursor = journal sequence（appendEvent 单调分配）。
 *
 * 两道界同时生效（docs/execution-engine.md「Reading the journal」）：页在条数到 `limit`、或
 * 再加一条就会让存储里的序列化字节超过 `maxBytes` 时收尾；第一条总是带上，所以一条超过
 * `maxBytes` 的事件自成一页。实现方缺省两者时各取一个有界的默认值——事件日志一页永远有界。
 */
export interface DynamicWorkflowRunEventPage {
  /** 只取 sequence 严格大于该值的事件；缺省从头取。 */
  afterSequence?: number;
  limit?: number;
  maxBytes?: number;
}

/** 事件日志的一页。`hasMore` 由存储层判定：页之后是否还有事件。 */
export interface DynamicWorkflowRunEventsResult {
  events: DynamicWorkflowRunEvent[];
  hasMore: boolean;
}

/**
 * 一条 run 事件的**协议形态**：sequence + 事件种类 + JSON 载荷。
 *
 * 刻意不复用引擎的 `RunEvent`：那是领域包（@zcode/dynamic-workflow）的词汇表，把它
 * import 进 contracts 会让每一个持有端口的层都编译期依赖引擎内部类型。端口只承载
 * JSON 形状，`type` 是不透明字符串，`payload` 由读端按需解释。
 */
export interface DynamicWorkflowRunEvent {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  /** 载荷经 {@link boundDynamicWorkflowRunEventPayload} 裁剪过（原始事实仍在 journal）。 */
  truncated?: boolean;
}

/**
 * run 事件载荷的界。**协议边界上的所有载荷有界**，而引擎的事件
 * 里有两个天然无界的字段：`actor-created` 的 `persona.system`（整段 system prompt）与
 * node 级错误的 `finalText`（一整轮模型输出）。它们不该按「大概不会很长」放行。
 *
 * 界是**结构性的**（字符串长度 / 数组条数 / 键数 / 深度）而不是字节总量：结构界可以
 * 逐字段就地施加，不需要先序列化一遍再回退，也不会因为一个巨大字段把其余字段一起丢掉。
 */
export const DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS = {
  maxStringLength: 2_048,
  maxArrayItems: 32,
  maxKeys: 32,
  maxDepth: 6,
} as const;

/**
 * 把一条 run 事件的载荷裁到 {@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS} 之内，
 * 并顺带规范成**可 JSON 序列化**的形状。
 *
 * 两个消费者共用这一次序列化：
 *   1. `listEvents` 返回的事件页（详情页的事件日志）；
 *   2. 追加到父会话的 `dynamic_workflow_run_progress` 会话事件（→ `workflowRuns` 投影）。
 *
 * 规范化不是可选的顺带工作，而是必需的：任何非有限数（`Infinity` / `NaN`）经 `JSON.stringify`
 * 都会变成 `null`——那意味着「同一个载荷，落库前后不等」。与其让每个读端各自面对这个不一致，
 * 这里一次性把它折叠成 `null`，使返回值满足 `JSON.parse(JSON.stringify(x)) === x` 的结构等价。
 */
export function boundDynamicWorkflowRunEventPayload(payload: Record<string, unknown>): {
  payload: Record<string, unknown>;
  truncated: boolean;
} {
  let truncated = false;
  const markTruncated = (): void => {
    truncated = true;
  };
  const bounded = boundJsonValue(payload, 0, markTruncated);
  return {
    payload: isJsonRecord(bounded) ? bounded : {},
    truncated,
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 递归裁剪。返回 `undefined` 表示该值不可承载（调用方从对象/数组里省略它）。 */
function boundJsonValue(value: unknown, depth: number, markTruncated: () => void): unknown {
  const limits = DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS;

  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    // Infinity / NaN 不是合法 JSON 数字；折叠成 null 而不是让 JSON.stringify 偷偷做这件事。
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    if (value.length <= limits.maxStringLength) return value;
    markTruncated();
    return truncateSurrogateSafe(value, limits.maxStringLength);
  }
  if (typeof value !== "object") {
    // undefined / function / symbol / bigint：省略（bigint 亦不可 JSON 序列化）。
    return undefined;
  }

  if (depth >= limits.maxDepth) {
    markTruncated();
    return undefined;
  }

  if (Array.isArray(value)) {
    const items =
      value.length > limits.maxArrayItems ? value.slice(0, limits.maxArrayItems) : value;
    if (items.length < value.length) markTruncated();
    const out: unknown[] = [];
    for (const item of items) {
      const boundedItem = boundJsonValue(item, depth + 1, markTruncated);
      // 数组里的空洞会改变下标语义，所以不可承载的元素落成 null 而不是被跳过。
      out.push(boundedItem === undefined ? null : boundedItem);
    }
    return out;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const kept = entries.length > limits.maxKeys ? entries.slice(0, limits.maxKeys) : entries;
  if (kept.length < entries.length) markTruncated();
  const out: Record<string, unknown> = {};
  for (const [key, item] of kept) {
    const boundedItem = boundJsonValue(item, depth + 1, markTruncated);
    if (boundedItem !== undefined) out[key] = boundedItem;
  }
  return out;
}

/**
 * 按 UTF-16 码元截断，但绝不留下孤立代理项（lone surrogate）——那既不是合法文本，
 * 也会让下游 JSON 编解码在某些运行时上报错。落在代理对中间时宁可少一个码元。
 */
function truncateSurrogateSafe(value: string, maxLength: number): string {
  const cut = value.slice(0, maxLength);
  const lastCode = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}

/**
 * workflow run 里**任意脚本值**（顶层返回的产物、`report(item)` 的条目）→ 给模型或读者看的
 * 文本。实现已随共享 workflowRuns reducer 搬进 `@zcode/shared/zcode-protocol-v4`
 * （workflow-artifact.ts，规则与来龙去脉见那边的注释）：`reports[].preview` 的归约下沉到
 * shared 后成了第四个消费者，而依赖方向是 contracts → shared，只能函数跟着搬。这里保留
 * re-export，既有的三个消费者（完成通知、TaskOutput 的 resultText、v4 投影）一行不改。
 */
export { serializeWorkflowArtifact } from "@zcode/shared/zcode-protocol-v4";

/**
 * workflow run 的窄端口。与 legacy {@link import("./workflow.port.js").WorkflowPort} 并列而非
 * 合并：后者服务 `Workflow` 工具与 `workflow_*` 旧表，共用一个端口等于在接口层把
 * 「独立于既有 workflow 机制」这条边界重新耦合回去。
 *
 * 取消没有专属 RPC：详情页按钮与后台面板的停止共用既有的 v4 `cancelBackgroundWork`
 * 命令，它落到这里的 {@link cancel}（runId ≡ workId）。
 */
export interface DynamicWorkflowRunPort {
  /** 编译一次并启动引擎；返回 runId（即 backgroundTaskId）。 */
  submit(
    request: DynamicWorkflowRunSubmitRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunSubmitResult>;
  /**
   * 修订一个 run：预检前驱 → 铸新 id → 前驱在飞则以 `{ superseded: newRunId }` 取消并等它结算
   * → 从前驱导入缓存 → 启动新 run（见 {@link DynamicWorkflowRunAmendRequest}）。预检被拒即
   * 结构化失败且**什么都没动**。老宿主可能没有这个方法（可选成员）：工具层按能力探测归一成
   * 「本会话不支持修订」。
   */
  amend?(
    request: DynamicWorkflowRunAmendRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunAmendResult>;
  /**
   * 默认并发 D（docs/dynamic-workflow/concurrency.md「Two bounds on a run」：
   * `max(4, min(16, availableParallelism() − 2))`，每进程一个值）。同步、无副作用。它是**起点**
   * 不是上限：没设 `max_concurrency` 的 run 跑在它上面，设了的高于低于都行。
   *
   * 工具层的读者：确认窗与回话（「（默认）」「默认 N」）、`AmendWorkflow` 的同值判定（`null` 要
   * 折算成数才比得了），以及 `GetWorkflowRun` 据它决定一个 run 的上界是否值得一提（≠ 默认才提）。
   * **可选成员**（消费方 `typeof` 探测）：端口 stub 不必为它陪跑，缺席时工具层只是不知道默认是几。
   */
  defaultConcurrency?(): number;
  /**
   * 就地改一个**在飞** run 自己的并发上界（docs/dynamic-workflow/concurrency.md「Retuning a live
   * run」）：同一个 runId、不铸后继、不 supersede、不导入缓存、在飞 ask 一个不丢。
   *
   * 与 {@link amend} 并列而非合并：修订换的是**脚本**，代价是停下前驱、铸新 run、从缓存重放；
   * 而「只把这个 run 调慢一点」不该付那笔账。两个调用方（`AmendWorkflow` 的 handler 与 GUI 的
   * `amendWorkflowRunSettings`）读同一个答案，于是「什么算一次 retune」只有一个定义。
   *
   * 三件事在一个同步片里发生或者一件都不发生：换引擎的 caps（调度器现读）、写
   * `dwf_run.caps_max_concurrency`（resume 因此续在新上界上）、记一条 `run-caps-changed`。
   * 服务另把自己那份内存上界一并挪动，于是快照、详情与 `GetWorkflowRun` 立刻报新值。
   *
   * **可选成员**（消费方 `typeof` 探测），理由同 {@link resume}：端口 stub 不必为一条控制面全员
   * 陪跑，而「端口缺席」与「方法缺席」对调用方是同一个业务事实——回落到一次真正的修订。
   */
  retuneConcurrency?(
    request: DynamicWorkflowRunRetuneRequest,
  ): Promise<DynamicWorkflowRunRetuneResult>;
  getTask(taskId: string): Promise<DynamicWorkflowRunSnapshot | undefined>;
  waitForTask(
    taskId: string,
    options?: DynamicWorkflowRunWaitOptions,
  ): Promise<DynamicWorkflowRunSnapshot | undefined>;
  /**
   * 停下一个 run：中止在飞 ask 并 kill 子进程，run 结算 `stopped(initiator)`。`initiator`
   * 缺省 `user`；主代理经 TaskStop 停的传 `model`（原因从此落库，不再只活在后台任务注册表里）；amend 路径传 `{ superseded: newRunId }`。
   * 未知 runId 返回 false。
   */
  cancel(runId: string, initiator?: DynamicWorkflowRunCancelInitiator): Promise<boolean>;
  /** 按 cursor 翻取事件日志；越界 cursor 返回空页而非报错。 */
  listEvents(
    runId: string,
    options: DynamicWorkflowRunEventPage,
  ): Promise<DynamicWorkflowRunEventsResult>;
  /**
   * 按项目（cwd）枚举 run，最近更新的在前。服务 `ListWorkflowRuns` 工具。
   *
   * **可选成员**，照 {@link cancel} 之前的先例（消费方 `typeof` 探测）：实现方只有在 journal
   * 带内省查询时才提供它，既有的端口 stub 也不必为一个只读枚举面全员陪跑。消费方对
   * 「端口缺席」与「方法缺席」给同一个业务失败——对模型这是同一件事（本会话没有这个能力）。
   */
  listRuns?(query: DynamicWorkflowRunListQuery): Promise<DynamicWorkflowRunListResult>;
  /**
   * 单 run 详情（进度摘要 + 产物 / 失败）。服务 `GetWorkflowRun` 工具。未知 runId 返回
   * `undefined`（消费方归一成 `run_not_found`），**不做 wait/block 语义**——等待是
   * {@link waitForTask} 的活，这里是即时快照。可选成员的理由同 {@link listRuns}。
   */
  getRunDetail?(runId: string): Promise<DynamicWorkflowRunDetail | undefined>;
  /**
   * run 存档的脚本原文（`dwf_run.script_text`，resume 重放的同一份字节），逐字节、不做任何处理。
   * `AmendWorkflow` 的两处读它：省略脚本时把前驱的脚本回填进
   * 入参，以及 `path` 修订的 `script_unchanged` 预检——
   * 那必须比字节而不能比哈希，工具侧读到的是文件内容，不是编译产物。GUI「配置」走同一条读路。
   *
   * 单独一条读面而不是 {@link DynamicWorkflowRunSnapshot} 的字段：快照被后台追踪器反复轮询，而
   * 脚本是端口上最大的一个字符串（{@link DynamicWorkflowRunSummary.label} 同一条理由）。未知 run
   * 与「记录里没有脚本」（落库之前的老 run）都回 `undefined`——对调用方是同一个事实：没有可沿用的
   * 脚本。只读、不看服务是否已关闭。**可选成员**（消费方 `typeof` 探测），理由同 {@link listRuns}：
   * 缺席时省略脚本的修订当场失败，`script_unchanged` 预检则被跳过（它是网，不是门）。
   */
  getScript?(runId: string): Promise<string | undefined>;
  /**
   * 恢复一个已取消 / 被进程死亡打断的 run：同 runId 重跑（引擎走 resume 分支，journal
   * 命中短路、未完结节点重新派发）。门在实现侧：只有 `cancelled` 或 `failed` 且失败编码为
   * `Interrupted` 的 run 可恢复。
   *
   * **可选成员**，照 {@link listEvents} 之前 cancel 的先例（消费方 `typeof` 探测）：
   * 端口 stub 不必为 resume 面全员陪跑；对消费方「端口缺席」与「方法缺席」是同一个业务失败。
   */
  resume?(runId: string): Promise<DynamicWorkflowRunResumeResult>;
  /**
   * 枚举**本服务父会话**名下的 run 摘要（最近更新在前，journal-backed）。UI 的重启后发现面：
   * `workflowRuns` 投影跨进程不存活，工具卡 join 与 Resume 按钮的可用性只能从这里还原。
   * 刻意不收 parentSessionId 参数——服务实例本就按父会话构造（per-app），让调用方传任意
   * 会话等于开一个跨会话读洞。可选成员的理由同 {@link resume}。
   */
  listRunsForSession?(limit?: number): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * 冷回放：把**本服务父会话**名下、本进程
   * 没跑过的 run 从 journal 回放成进度事件载荷——与 live 时 `onRunEvent` 交出的是**同一种**
   * 载荷、同一条铸造链，冷物化把它们当内存事件喂给同一个 reducer，`workflowRuns` 投影因此
   * 在重启前后逐字节一致。
   *
   *   - 上界与投影的淘汰同（最近更新的 8 条），最旧的 run 在前；
   *   - `excludeRunIds`：调用方内存里已有事件的 run（本进程跑过 / 正在跑）不回放；
   *   - 行是终态而事件流没有 `run-settled` 的 run（进程死亡后被孤儿收敛改写的行）追加一条
   *     **内存态**合成 settle 载荷（携行的 status / failure / resumable），绝不写进 journal。
   *
   * 可选成员的理由同 {@link listRunsForSession}：内存 journal 没有枚举面，回放无物可还原。
   */
  replayProgressForSession?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * 回答一个 actor 升级上来的阻塞问题。服务
   * `ResolveWorkflowQuestion` 工具。
   *
   * 只收一个不透明 token 而不是 `(runId, qid)` 对：qid 全局唯一（跨 run），多 run 并发时
   * 让模型自己配对是错配的温床。答案原样成为 actor 那次 `escalate` 调用的工具结果，
   * actor 的轮次随即继续；run 状态全程不动（升级是 ask 内部的一次慢工具调用，
   * 不是 run 生命周期事件）。
   *
   * **可选成员**，照 {@link resume} 的先例（消费方 `typeof` 探测）：端口 stub 不必为一个
   * 应答面全员陪跑；对消费方「端口缺席」与「方法缺席」是同一个业务失败。
   */
  resolveQuestion?(qid: string, answer: string): Promise<DynamicWorkflowResolveQuestionResult>;
  /**
   * 给一个正在等的留白补上函数体（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」；
   * 引擎文档「The fill service's checks」）。服务 `FillWorkflowHole` 工具。
   *
   * 实现侧一条龙：读 run 存档的脚本 → 按站点 id 找到留白调用、把函数体拼成它的最后一个实参 →
   * 整体编译（诊断 → `compile_failed`，坐标按 `inFill` 分到函数体内 / 脚本）→ 站点稳定性检查
   * （→ `fill_ids_unstable`）→ 引擎 `fillHole`（→ `hole_not_waiting`）→ 把 run 的草稿就地改写成
   * 有效脚本。**拒绝即零副作用**：留白照旧在等。
   *
   * **可选成员**（消费方 `typeof` 探测），理由同 {@link resolveQuestion}：端口 stub 不必为它陪跑；
   * 对消费方「端口缺席」与「方法缺席」是同一个业务失败（本会话不能补全留白）。
   */
  fillHole?(request: DynamicWorkflowRunFillHoleRequest): Promise<FillWorkflowHoleResult>;
  /**
   * 本 run 的用户面产物清单（journal `kind = "artifact"` 行按 id 分组、版本升序）。UI 冷恢复与中枢详情的 durable 读法。
   * 未知 runId 返回 `undefined`。**可选成员**，理由同 {@link listRuns}（journal 带产物
   * 读面时才提供；消费方 `typeof` 探测）。
   */
  listArtifacts?(runId: string): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  /**
   * 喂给某个预置产物的 `report` 条目，按 journal sequence 升序分页（看板的取数面）。
   * 越界 cursor 返回空页而非报错。可选成员，理由同 {@link listArtifacts}。
   */
  listArtifactItems?(
    runId: string,
    artifactId: string,
    page: DynamicWorkflowRunArtifactItemPage,
  ): Promise<DynamicWorkflowRunArtifactItemsResult>;
  /**
   * 读某个产物版本的字节：**先**在 journal 里确认 `(runId, artifactId, version)` 有一行
   * `completed` 记录，再按行上的 `uri` 经 tool-artifact store 取——调用方传来的任何 id 都
   * 不直接成为路径。无此版本 / 非内容产物 /
   * store 缺席 → `undefined`。分块归网关（v4 `workflowRunArtifactRead`，≤ 512 KiB 一块）。
   * 可选成员，理由同 {@link listArtifacts}。
   */
  readArtifact?(
    runId: string,
    artifactId: string,
    version: number,
  ): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * 本 run 的工作区 transcript：journal 里
   * `kind ∈ {world-read, world-run}` 的行按落库先后，**不带正文**。
   *
   * 授权与 {@link readArtifact} 同一条链：run 必须属于本服务的父会话，否则 `undefined`
   * （与「无此 run」同一个答案——不告诉越权的调用方它猜对了哪一半）。正文可能含工作区文件
   * 内容，所以清单也不放行别的会话。可选成员，理由同 {@link listArtifacts}。
   */
  listWorkspaceNodes?(
    runId: string,
  ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  /**
   * 一个工作区节点的正文，按 `maxBytes` 保形有界化。授权链同 {@link listWorkspaceNodes}；
   * 无此节点 / 非 world 行 / 不是你的 run → `undefined`。可选成员，理由同 {@link listArtifacts}。
   */
  readWorkspaceNodeResult?(
    runId: string,
    siteId: string,
    ordinal: number,
    query: DynamicWorkflowRunWorkspaceNodeResultQuery,
  ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
}

// ————————————————————————————————————————————————————————————————
// run 内省（ListWorkflowRuns / GetWorkflowRun 的取数面）
// ————————————————————————————————————————————————————————————————

/**
 * run 的生命周期状态。字面与 journal 的 `dwf_run.status` 同集，但**刻意在这里重新声明**
 * 而不是从 @zcode/dynamic-workflow import：端口只承载 JSON 形状，引擎的词汇表一旦进
 * contracts，每个持有端口的层都会编译期依赖引擎内部类型（与 {@link DynamicWorkflowRunEvent}
 * 的 `type` 同一条论证）。
 *
 * 与 {@link DynamicWorkflowRunSnapshot} 的 status 刻意不同：后者是后台任务追踪器的词汇表，
 * 把 `pending` 折进 `running`。内省面必须保留 `pending`——「已提交、引擎还没建行」是一个
 * 模型能看懂且有意义的区别。
 */
export type DynamicWorkflowRunLifecycleStatus =
  | "completed"
  | "errored"
  | "pending"
  | "running"
  | "stopped";

/**
 * `stopped` 的原因：`user` 用户取消 / `model` 主代理
 * TaskStop / `provider` 确定性模型侧错误 / `interrupted` 持有进程亡故或沙箱故障 / `superseded`
 * 被一次 AmendWorkflow 停下并替代。前四者可 resume，`superseded` 不可（活的是它的后继）；
 * `errored`（脚本之错）不可。字面与引擎 `RunStopReason` 同集，刻意在这里重新声明。
 */
export type DynamicWorkflowRunStopReason =
  | "user"
  | "model"
  | "provider"
  | "interrupted"
  | "superseded";

/** {@link DynamicWorkflowRunPort.listRuns} 的查询袋。 */
export interface DynamicWorkflowRunListQuery {
  /**
   * 项目键，**必填**。字面等值匹配 `dwf_run.cwd`（写入侧原样落、读侧原样查）。
   * 端口不替调用方猜一个默认 cwd：工具面恒查 `context.workingDirectory`，模型无权跨项目扫库。
   */
  cwd: string;
  /** 返回条数上限，**必填**。钳制策略属于工具面（[1, 50]）；端口不做无界枚举。 */
  limit: number;
  /** 可选状态子集。缺省即不过滤；空数组即「不匹配任何状态」（回空列表）。 */
  statuses?: readonly DynamicWorkflowRunLifecycleStatus[];
}

/**
 * 列表与详情**共同的截面**。标签、归属标注与时间戳三者在两条读面上必须逐字段同源——
 * 同一个 run 在列表里和详情里显示不同的名字或归属，是最难被测试抓住、又最直接损害信任的
 * 那类不一致。所以这里是一个共享的基接口，而不是两份各自演化的字段表。
 */
export interface DynamicWorkflowRunSummary {
  runId: string;
  /**
   * 展示标签。**已烹熟**：实现侧（run service）按 name → 脚本首行 → runId 的顺序派生好，
   * 消费方直接展示。之所以不把原料（name / scriptText）交出去让工具层自己拼：那条兜底链
   * 是读时启发式，两个工具各拼一次就会漂移，而 scriptText 是端口上最大的一个字符串
   * （列表面根本不该为了取首行把 50 份脚本搬过边界）。
   */
  label: string;
  /** 标签来源：`"name"` = 用户起的名字；`"script"` = 读时从脚本派生（含 runId 兜底）。 */
  labelSource: "name" | "script";
  status: DynamicWorkflowRunLifecycleStatus;
  /** `status === "stopped"` 才在场。 */
  stopReason?: DynamicWorkflowRunStopReason;
  /** 本 run 修订自哪个 run（`dwf_run.resumed_from`）；不是修订则缺席。 */
  resumedFrom?: string;
  /** 本 run 被哪次修订停下并替代（`stopped(superseded)` 的结算袋）；未被替代则缺席。 */
  supersededBy?: string;
  /** 本会话是否是这个 run 的发起方（journal 的 parent_session_id 命中，或在本会话注册表里）。 */
  ownedByThisSession: boolean;
  /**
   * 「本会话无法证实它还活着」：journal 非终态 ∧ 非本会话 ∧ 不在本会话注册表。可能是死进程
   * 的遗物，也可能是同进程兄弟会话正在飞的 run——所以这是**标注而非状态改写**，读面绝不
   * 替别人收尸（孤儿收敛的执行权只属于 owning 会话的构造时刻）。为真时才在场。
   */
  possiblyInterrupted?: boolean;
  /** journal 的 `time_created` / `time_updated`（epoch ms）。 */
  createdAt: number;
  updatedAt: number;
}

/** 列表的一项：共同截面 + 用量。刻意轻——无 actors、无节点计数、无产物预览。 */
export interface DynamicWorkflowRunListItem extends DynamicWorkflowRunSummary {
  /** 直读 `dwf_run.spent_tokens`（run 级 token 用量的唯一权威）。 */
  spentTokens: number;
}

/**
 * `listRuns` 的返回。刻意是一个对象而不是裸数组：页级字段（如 {@link truncated}）是纯追加
 * 改动，而裸数组只能整体换形状。
 */
export interface DynamicWorkflowRunListResult {
  runs: DynamicWorkflowRunListItem[];
  /**
   * 这个项目还有更多 run 没进这一页。**为真时才在场**。
   *
   * 判据是「多取一条」（实现侧按 `limit + 1` 查询后回落），不是 `length === limit`：后者在
   * 条数正好等于 limit 时误报，而误报会让模型去追一页不存在的历史。同一个惯例在 v4 网关的
   * 事件分页上（`hasMore`）已经用过一次。
   */
  truncated?: boolean;
}

/**
 * run 的进度与用量（观察面，没有任何上限）。`nodesObserved`
 * 是**已落库节点的行数**（三态之和），绝不冒充「总步数」：动态工作流没有静态总数，而
 * `queued` 只存在于事件相位、不落库。
 */
export interface DynamicWorkflowRunUsage {
  spentTokens: number;
  nodesObserved: number;
  nodesRunning: number;
  nodesCompleted: number;
  nodesFailed: number;
}

/** 一个 actor 站点实例。`persona` 刻意不出：整段 system prompt 是端口上天然无界的字段。 */
export interface DynamicWorkflowRunActor {
  siteId: string;
  ordinal: number;
  name?: string;
}

/** 一条 `log()` 叙事。 */
export interface DynamicWorkflowRunLogEntry {
  sequence: number;
  /** 已按端口的字符串上限（{@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS}）有界化。 */
  message: string;
  /**
   * 这条事件落 journal 的时刻（`dwf_event.time_created`）。序号定位，时刻回答「多久以前」——
   * 情势截面的三组字段都按这一把尺算年龄，叙事尾巴没有理由用另一把。**没有这一列的老
   * journal 上缺席**，读侧据此不给年龄，绝不用读时的 `Date.now()` 兜底。
   */
  at?: number;
}

/** 结构化失败。`code` 是稳定判别键——模型必须能分辨「进程死了」与「脚本真失败」。 */
export interface DynamicWorkflowRunError {
  code: string;
  message: string;
  /** 只在 `code === "ProviderStop"` 时在场（引擎 `ProviderStopDetails` 的 JSON 镜像）。 */
  providerStop?: DynamicWorkflowRunProviderStop;
}

/** `ProviderStop` 的结构化明细（引擎 `ProviderStopDetails` 的镜像，端口只承载 JSON 形状）。 */
export interface DynamicWorkflowRunProviderStop {
  kind: "auth" | "not_configured" | "model_unavailable" | "invalid_request" | "quota" | "other";
  reason: string;
  providerId?: string;
  providerLabel?: string;
  modelId?: string;
  providerCode?: string;
  subagent?: string;
  subagentName?: string;
  phase?: string;
  rawMessage?: string;
  resetAt?: number;
}

// 情势截面（阶段 / 子代理 / 健康）的类型住在 dynamic-workflow-run-roster.port.ts（同上），
// 此处原样再导出以保持 `@zcode/contracts` 的导入路径不变。
export type * from "./dynamic-workflow-run-roster.port.js";

// retune（就地改在飞 run 的并发上界）的三个类型住在 dynamic-workflow-run-retune.port.ts，
// 同上原样再导出。
export type * from "./dynamic-workflow-run-retune.port.js";
// 留白（快照条目、fillHole 的请求 / 结果）的类型住在 dynamic-workflow-run-hole.port.ts，同一条拆分先例。
export type * from "./dynamic-workflow-run-hole.port.js";

// 工作区 transcript 的六个类型住在 dynamic-workflow-run-workspace.port.ts，同上原样再导出。
export type * from "./dynamic-workflow-run-workspace.port.js";

/** 单 run 详情：共同截面 + 进度 + 情势截面 + 按终态分叉的产物 / 失败。 */
export interface DynamicWorkflowRunDetail extends DynamicWorkflowRunSummary {
  usage: DynamicWorkflowRunUsage;
  /**
   * 本 run 自己的并发上界，语义同 {@link DynamicWorkflowRunSnapshot.maxConcurrency}：只在低于当前
   * 天花板时在场。刻意不进 {@link DynamicWorkflowRunSummary}——列表行不该为一个很少设置的字段加宽。
   */
  maxConcurrency?: number;
  /**
   * 本 run 的子代理模型，语义同 {@link DynamicWorkflowRunSnapshot.subagentModel}：只在设过时
   * 在场。与 `maxConcurrency` 同理不进 {@link DynamicWorkflowRunSummary}——列表行不该为一个
   * 很少设置的字段加宽。
   */
  subagentModel?: string;
  /** 本 run 的脚本点名的模型，语义同 {@link DynamicWorkflowRunSnapshot.modelBindings}。 */
  modelBindings?: Record<string, string>;
  /**
   * 本 run 的脚本文件，语义同 {@link DynamicWorkflowRunSnapshot.scriptPath}：只在记下过文件时
   * 在场。`GetWorkflowRun` 据它在 `<amendable>` 里把下一步说成「就地编辑这个文件」。
   */
  scriptPath?: string;
  actors: DynamicWorkflowRunActor[];
  /** `log()` 事件的尾巴，按时序（sequence 升序）。无 log 事件即空数组。 */
  logTail: DynamicWorkflowRunLogEntry[];
  /**
   * 阶段表：声明序的已声明阶段，后面接上「进过但没声明」的那些
   *
   * **脚本没声明阶段、也一个都没进过时整字段缺席**——那样的 run 没有阶段这回事，
   * 发一个空数组读起来像「阶段表是空的」，是另一句话。
   */
  phases?: DynamicWorkflowRunPhaseView[];
  /**
   * 子代理花名册，按 actor 行的顺序（= 铸造顺序）。**恒在场**，一个 actor 都没有的 run 是空
   * 数组：与 `phases` 不同，「这个 run 有几个子代理」永远是个有答案的问题，而 0 就是那个答案。
   *
   * 与并列的 `actors` 刻意不合并：`actors` 是一张恒定的身份表（siteId / ordinal / name），
   * 消费者已经按它 join；这里的每一项都是**读时快照**，同一个 run 隔一秒读就不一样。
   */
  subagents: DynamicWorkflowRunSubagentView[];
  /** run 整体还在不在动（见 {@link DynamicWorkflowRunHealth}）。恒在场。 */
  health: DynamicWorkflowRunHealth;
  /**
   * 脚本的顶层返回值，**原值**（未序列化）。只有 completed 的 run 才在场；`undefined` 产物
   * 即整字段缺席。
   *
   * 为什么不在这里序列化：面向模型的文本投影已经有唯一实现（core 的
   * `serializeWorkflowArtifact`，完成通知与 TaskOutput 共用它）。端口再做一次，就会出现
   * 「同一个 run 的产物在通知里和在本工具里长得不一样」——正是那份共用要排除的损失类别。
   * 所以序列化留在 core，端口只负责把原值送到边界。
   */
  result?: unknown;
  /** errored 恒在场；stopped 只对 provider / interrupted 在场。code 原样透出，不折叠。 */
  error?: DynamicWorkflowRunError;
  /**
   * 此刻停驻在这个 run 上、等主代理作答的升级问题。
   *
   * 与 {@link DynamicWorkflowRunSnapshot.pendingQuestions} **同源同投影**（都读进程内的升级
   * 停驻表，都在零条时整字段缺席），只是换了一条读面：快照服务后台任务追踪器，本字段服务
   * `GetWorkflowRun`——而后者是**模型侧唯一的发现面**。这条链路不是可选的锦上添花：升级通知
   * 有两条已知的丢弃路径（stale branch generation / shutdown），查询是这两条路径的兜底，`resolveQuestion` 的 `unknown_question` 文案也明确让模型来这里找 qid。
   * 缺了它，那两处承诺都会指向一个什么都不返回的工具。
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * 本 run 的留白，与 {@link DynamicWorkflowRunSnapshot.holes} **同源同投影**（零条整字段缺席），
   * 只是换了一条读面：本字段服务 `GetWorkflowRun`——留白通知丢失后模型侧唯一的发现面。
   */
  holes?: readonly DynamicWorkflowRunHole[];
  /**
   * 本 run 的用户面产物（任意状态都附；journal-backed，与 {@link DynamicWorkflowRunSnapshot.artifacts}
   * 同源）。`GetWorkflowRun` 据此告诉模型「这些已经以卡片呈现给用户了，按标题引用即可」。
   * 零件时整字段缺席。
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
}

/** {@link DynamicWorkflowRunPort.resume} 的结构化失败原因。 */
export type DynamicWorkflowRunResumeErrorReason =
  /** journal 里没有这个 run。 */
  | "not_found"
  /** run 不在可恢复集里（completed 或 errored；只有 stopped 可恢复）。 */
  | "not_resumable"
  /** run 被一次 AmendWorkflow 停下并替代：活的是后继，重放它等于把同一件事做两遍。 */
  | "superseded"
  /** 同 runId 的 run 正在本进程内飞行。 */
  | "already_running"
  /** 记录缺 scriptText（落库该字段之前的老 run），没有可重跑的脚本。 */
  | "script_missing"
  /** 记录的 scriptHash 与按 scriptText 重算的不一致（记录自身被外力改写过）。 */
  | "script_mismatch"
  /**
   * 记录的 scriptText 在**当前** facade 下不再通过类型检查（facade 重构后的老 run）。逐字重放
   * 只会失败；出路是按当前 facade 改写脚本后走 AmendWorkflow。`message` 携带有界诊断。
   */
  | "compile_failed";

/**
 * resume 的结构化结果。失败走 reason 而不是 throw：五种原因全是调用方可预期的业务分支
 * （错误码而非错误文本做流程判断，house rule），throw 只留给真正的接线故障。
 */
export type DynamicWorkflowRunResumeResult =
  | { ok: true; runId: string; toolCallId?: string }
  | { ok: false; reason: DynamicWorkflowRunResumeErrorReason; message?: string };

/**
 * {@link DynamicWorkflowRunPort.listRunsForSession} 的 run 摘要。字面与 journal 的
 * `dwf_run.status` 同集，但**刻意在这里重新声明**：端口只承载 JSON 形状，引擎词汇表一旦
 * 进 contracts，每个持有端口的层都会编译期依赖引擎内部类型。
 */
export interface DynamicWorkflowRunSessionSummary {
  runId: string;
  /** 发起 run 的 CreateWorkflow 工具调用 id（工具卡 → 详情页/Resume 的关联键）；老 run 缺席。 */
  toolCallId?: string;
  /**
   * 展示标签，服务端读时派生（`name` → 脚本首行 → runId，见 bootstrap 的
   * `resolveDynamicWorkflowRunLabel`）。可选是为了**偏斜安全**：老服务端不发这个键，
   * 读侧回落到 runId 即可——列表少一个标签是退化，不是错误。
   *
   * 与 `resumable` 同理由集中在服务端：两处各拼一次兜底，同一个 run 在
   * `/dwf list` 与工具卡上会显示不同的名字。
   */
  label?: string;
  /**
   * 最后更新时间（epoch 毫秒，来自 journal 的 `dwf_run.time_updated`）。可选同上：
   * 老服务端缺席，读侧不显示时间列。列表排序仍由存储层负责（最近更新在前），
   * 这个字段只供展示——读侧不要拿它重排，否则与服务端的 tie-break 漂移。
   */
  updatedAt?: number;
  status: "completed" | "errored" | "pending" | "running" | "stopped";
  /** `status === "stopped"` 才在场。 */
  stopReason?: DynamicWorkflowRunStopReason;
  /** 本 run 修订自哪个 run；不是修订则缺席。 */
  resumedFrom?: string;
  /** 本 run 被哪次修订停下并替代；未被替代则缺席。 */
  supersededBy?: string;
  /** errored / stopped(provider|interrupted) 的结构化失败编码（`ProviderStop` / `Interrupted` …）。 */
  failureCode?: string;
  failureMessage?: string;
  /**
   * 是否可恢复。**服务端按 resume 门的同一个谓词算好**：UI 若自行按 status+failureCode
   * 重新推导，两处谓词总有一天不一致——按钮亮着但命令被拒。
   */
  resumable: boolean;
}
