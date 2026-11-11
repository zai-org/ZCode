import { createContext } from "react";
// v4 行渲染上下文（ai-elements / ToolCallBlocks 回接所需的宿主注入面）。
// 注入模式对齐 PermissionDialog（store 耦合剥离）：展示组件不自取 store，
// theme / codePreviewSettings 在宿主（SessionPane）处取，向下走稳定 props。
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunSettingsChange } from "@/components/workflow-timeline/workflowRunSettings.js";
import type { WorkflowDraftPosition, WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import type { WorkflowFillGraph } from "@/v4/workflowRunCardJoin.js";
import type { Theme } from "@/useTheme.js";
import type { ModelSelectionView } from "@zcode/services";
import type { ZCodeWorkflowsForRunCandidate } from "@zcode/shared";
import type { ConversationAttachmentReadParams, ConversationTransport } from "@/v4/transport.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenWorkflowActorSessionSideTabRequest,
  OpenWorkflowArtifactSideTabRequest,
  OpenWorkflowRunSideTabRequest,
  OpenWorkflowWorkspaceSideTabRequest,
  OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import type {
  CommandAck,
  ConversationRowTarget,
  TurnHeaderRow,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";

export type ConversationFileChangesState = Exclude<
  NonNullable<TurnHeaderRow["fileChanges"]>["state"],
  undefined
>;

export interface ConversationRowRenderContext {
  logEpoch?: string;
  workspacePath: string;
  /** 当前 workspace Host 的用户 Home，用于解析 Assistant 输出中的 ~/ 路径。 */
  workspaceHomePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  /** SessionPane 从目标 Host 读取的同一份模型选择 View。 */
  modelSelectionView?: ModelSelectionView | null;
  theme: Theme;
  /** 需保持引用稳定（MessageResponse/ToolCallBlock 的 memo 依赖）。 */
  codePreviewSettings: CodePreviewSettings;
  /** 当前 pane 绑定的父 session；subagent 右侧 tab 用它做父任务分组。 */
  sessionId?: string | null;
  /** 当前下钻树的顶层 session；详情 tab 跨嵌套层级按该 id 分组。 */
  rootSessionId?: string | null;
  /** @deprecated 旧内联下钻标记；新的子会话统一打开侧栏详情。 */
  inSubagentDrilldown?: boolean;
  /** 手机 /remote 紧凑模式：隐藏外部 App 打开下拉，只保留应用内预览。 */
  compactForRemoteControl?: boolean;
  /** 当前 session 正在 compact 或 goal verify；专用状态 UI 独占进度反馈。 */
  chatLoadingBlockedByActiveWork?: boolean;
  /** 当前 session 正在等待权限确认或 AskUserQuestion 回答，隐藏底部 ChatLoading。 */
  chatLoadingBlockedByInteraction?: boolean;
  /** 常规设置：是否在对话消息流中渲染 reasoning / thought 行。 */
  messageStreamShowReasoning?: boolean;
  /** 当前 assistant 轮次的第一条 reasoning row；关闭完整思考时仍需展示。 */
  messageStreamFirstReasoningRowId?: number;
  /** 常规设置：是否在对话消息流中渲染 Todo 工具卡片。 */
  messageStreamShowTodos?: boolean;
  /**
   * Tier 1 fork 跳转：把当前 pane 切到目标会话（forkNotice → 父会话，复用 onSessionCreated
   * 原地切换）。rowId 预留 Tier 2 精确滚动——当前 forkNotice.parentRowId 恒为 0 占位、暂忽略。
   * 需保持引用稳定（rowContext 的 memo 依赖）。
   */
  onNavigateToRow?: (sessionId: string, rowId: number) => void;
  /** Assistant Preview Cards：Website 卡片预览入口，由 app shell 注入 side pane 行为。 */
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  /** Assistant Preview Cards：Markdown/文件卡片预览入口，由 app shell 注入 code viewer 行为。 */
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /** Desktop 完成态 PPTX：由 shell 原子创建多个右侧 Preview Tab。 */
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  /** 当前 renderer 观察到 running → completedSuccess 后，锁定到具体 turn。 */
  assistantPreviewPptxAutoOpenTarget?: { turnId: string; key: string } | null;
  /** Assistant markdown 本地文件链接入口：由 shell 统一 stat 后分流到预览或文件树。 */
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
  /** 插件 UI：内联卡片请求在侧栏打开；RowView 补 parentSessionId 与 workspace 字段。 */
  onOpenWorkflowRun?: (request: OpenWorkflowRunSideTabRequest) => void;
  /**
   * 产物的全尺寸查看 tab 入口。
   *
   * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是引擎内部那个
   * 「脚本顶层返回值」的同名词。
   *
   * 与 `onOpenWorkflowRun` 同构：行只发意图（哪个 run 的哪个产物），会话与 workspace 身份
   * 由宿主补齐。**不带版本号**——chip 的语义是「让我看这个产物」，落点恒为最新版。
   */
  onOpenWorkflowArtifact?: (request: OpenWorkflowArtifactSideTabRequest) => void;
  /**
   * 取消一项后台工作（`cancelBackgroundWork{workId}`），由宿主绑定 dispatchCommand + sessionId。
   *
   * 轮尾 run 卡用它做「Stop run」：run 的
   * `runId ≡ workId`，与详情侧板 / 任务列表同一条取消路径。通知行已是终态、不需要
   * 取消入口，所以该能力在 context 上缺席；run 卡是第一个在 running 态就渲染停止按钮的
   * 转写行，故新增此可选字段。宿主（SessionPane）在只读会话下不注入即整卡无取消。
   */
  onCancelBackgroundWork?: (workId: string) => void;
  /**
   * 工具卡页脚的 Resume：与详情页同一条
   * v4 `resumeWorkflowRun {workId ≡ runId}`。只读会话下宿主不注入。
   */
  onResumeWorkflowRun?: (workId: string, name?: string) => void;
  /**
   * run 卡的「配置」：v4
   * `amendWorkflowRunSettings {workId ≡ runId, ...改过的设置}`，回 ACK 给弹层显示拒绝理由。与 Resume
   * 同两道门（只读、灰度）：缺席即卡上没有 Configure。
   */
  onAmendWorkflowRunSettings?: (
    workId: string,
    change: WorkflowRunSettingsChange,
  ) => Promise<CommandAck>;
  /**
   * 完成卡的「保存」/「再次运行」（docs/dynamic-workflow/transcript-and-notifications.md
   * 「Saving the run, and running it again」）：把 GUI 写好的那条用户消息发进本会话，交给 ZCode
   * 去提炼保存。与 Resume 同两道门（只读、灰度）且**同一个供给点**——写文件与起引擎都属于
   * 「Resume 被收走的地方一并收走」。缺席即卡上只剩「已保存」芯片那条事实。
   */
  onSendWorkflowSaveRequest?: (text: string) => Promise<void>;
  /**
   * runId → 转写里认领过这次 run 的 SaveWorkflow 候选（`workflowRunCardJoin.buildWorkflowSaveCandidatesByRunId`），
   * 由宿主从行窗口一遍建立。它是「模型另起名字存下的那份定义」与这次 run 之间仅有的联系
   * （模型不会用 run 名当工作流名），所以必须从转写里读。
   */
  workflowSaveCandidatesByRunId?: ReadonlyMap<string, readonly ZCodeWorkflowsForRunCandidate[]>;
  /** 会话当前模型（「配置」弹层首项「会话模型」的名字）；读不到即缺席，首项只写「会话模型」。 */
  workflowSessionModel?: { providerId: string; modelId: string };
  /**
   * 工具卡上的子代理药丸 → 该子代理的 transcript tab：与详情页子代理行同一条打开路径，宿主补齐 workspace 身份。
   */
  onOpenWorkflowActor?: (request: OpenWorkflowActorSessionSideTabRequest) => void;
  /**
   * 工具卡上的脚本药丸 → 该 run 的脚本 transcript tab：
   * 与详情页脊线上的脚本行同一条打开路径，宿主补齐 workspace 身份。
   */
  onOpenWorkflowWorkspace?: (request: OpenWorkflowWorkspaceSideTabRequest) => void;
  /**
   * CreateWorkflow 工具调用 → workflow run 摘要的解析表，由宿主从 `workflowRuns` 投影建立。
   *
   * run 身份必须走投影而不是工具输出：`workflowRunSchema.toolCallId` 就是为这个关联而存在的
   * （「工具卡 → 详情页的关联键」），而 v4 工具行的 output 只剩一句散文，
   * `status` / `backgroundTaskId` 这些结构化字段被 formatModelContent 丢掉了。
   *
   * 值带状态与步数而不只是 runId：命中即卡片进入 run 态（紧凑可点卡），那张卡要渲染
   * 实时状态词与进度，联接一次就把它们算完（`workflowRunCardJoin.ts`）。
   */
  workflowRunByToolCallId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  /**
   * runId 键的同源联接表（`workflowRunCardJoin.buildWorkflowRunByRunId`）。给
   * ResumeWorkflowRun 的工具行用：投影里 run.toolCallId 跨 resume 沿用**原始
   * CreateWorkflow 行**（join 不断链的刻意语义），resume 行按 toolCallId 永远查不到，
   * 但它的 display 载荷带着 runId——按 runId 联接同一份投影。
   */
  workflowRunByRunId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  /**
   * runId → 该 run 当前停驻的 qid 集合，由宿主从**活投影**（不掺 journal 兜底）建立
   * （`workflowRunCardJoin.buildWorkflowRunPendingQuestionsByRunId`）。Workflow 通知 manifest
   * 的升级条目据此做 Waiting→Answered 翻转：键在场 ⟺ run 在活投影里，值含 qid = Waiting、
   * 不含 = Answered、整键缺席 = run 不在场（中性 Question）。
   */
  workflowRunPendingQuestionsByRunId?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * 发起 toolCallId → 该 run 的静态图（`workflowRunCardJoin.buildWorkflowGraphByToolCallId`），由宿主
   * 从行窗口建立。图是 run 的属性：轮尾 run 卡不论挂在 CreateWorkflow 行、ResumeWorkflowRun 行还是
   * 直接启动轮上，都按 run 的发起 toolCallId 到这张表取图。
   */
  workflowGraphByToolCallId?: ReadonlyMap<string, WorkflowCausalityGraphData>;
  /**
   * runId → 最新一次成功补全的有效脚本图（`workflowRunCardJoin.buildWorkflowFillGraphByRunId`）：补全之后
   * run 卡与侧板取它，而不是发起行的图（docs/dynamic-workflow/presentation.md「Holes on the timeline」）。
   */
  workflowFillGraphByRunId?: ReadonlyMap<string, WorkflowFillGraph>;
  /**
   * CreateWorkflow / AmendWorkflow 行 → 草稿位置（稿号、是否已被替代），由宿主从行窗口一遍建立
   * （`workflowDraftJoin.buildWorkflowDraftByToolCallId`）。编译反馈行据此写「第 n 稿」并决定空环灯的
   * 颜色；缺席时卡片不编号。
   */
  workflowDraftByToolCallId?: ReadonlyMap<string, WorkflowDraftPosition>;
  fetchFileChanges?: (
    target: ConversationRowTarget,
    options: ConversationFileChangesRequestOptions,
  ) => Promise<V4ConversationFileChangesResult>;
  previewFileRewind?: (
    target: ConversationRowTarget,
  ) => Promise<V4ConversationFileRewindPreviewResult>;
  applyFileRewind?: (target: ConversationRowTarget) => Promise<CommandAck>;
  /**
   * 文件撤销被 session 锁住（availability.rewindFiles 拒绝），且锁一解除就能撤销。锁住时 pane
   * 不下发上面两个回调；只读 pane、运行时未就绪时为 false，禁用按钮不显示锁定提示。
   */
  fileRewindLocked?: boolean;
  /** 已发送 image/video 预览；由 pane 绑定的 workspace transport 注入。 */
  readAttachment?: (
    params: ConversationAttachmentReadParams,
  ) => ReturnType<ConversationTransport["attachmentRead"]>;
  readAttachmentRange?: (
    params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
  ) => ReturnType<ConversationTransport["attachmentReadRange"]>;
}

export interface ConversationFileChangesRequestOptions {
  /**
   * 运行中 turn 的结果仍会随 projection revision 增长，只能复用进行中的请求；
   * 终态 turn 才允许在虚拟行复挂载后继续复用成功结果。
   */
  cachePolicy: "in-flight" | "terminal";
  /** rewind 会在同一 logEpoch 内切换 active/reverted，终态缓存必须按该语义状态隔离。 */
  fileChangesState?: ConversationFileChangesState;
}

export type ConversationReasoningVisibility = Pick<
  ConversationRowRenderContext,
  "messageStreamShowReasoning" | "messageStreamFirstReasoningRowId"
>;

export function isConversationReasoningRowVisible(
  rowId: number,
  visibility: ConversationReasoningVisibility,
): boolean {
  return (
    visibility.messageStreamShowReasoning === true ||
    visibility.messageStreamFirstReasoningRowId === rowId
  );
}

// Context 独立于组件热更新边界，避免提供方和已挂载工具消费方持有不同实例，
// 将整条工具摘要误渲染到统计组头的图标槽。
export const SummaryIconOnlyContext = createContext(false);
export const SummaryPreviewContext = createContext(false);
export const SummaryGroupBoundaryContext = createContext<{
  taskRunning: boolean;
  tailRowId?: number;
}>({ taskRunning: false });
