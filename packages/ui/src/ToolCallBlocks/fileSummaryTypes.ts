import type { PluginUiToolBinding } from "@/plugin-ui/contract.js";
import type { ComponentType, ReactNode } from "react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { countPatchFileDiffs } from "@/lib/patchDiffPreview.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { ToolDisplayModel } from "@/lib/toolDisplay.js";
import type { Theme } from "@/useTheme.js";
import type { OpenPlanDetailSideTabRequest } from "@/lib/workspaceSidePane.js";
// Bugfix：这里曾写成类型位置的内联动态 import 写法（在 typeof 后跟圆括号包模块名）。
// TS 编译期会擦除它，但 share 闭包守卫（shareBuildBoundary.test）的动态 import 正则
// 不区分类型/值与注释，把它当成值导入后，整个 ToolCallBlocks.tsx 大桶（含 plugin-ui
// 桶 → services/provider）被误判进 web-share 闭包。顶层 import type 同样不产生运行时
// 边，且能被守卫正确跳过。注释里也不要出现该字面写法，正则同样会命中注释文本。
import type { ToolCallBlock } from "@/ToolCallBlocks.js";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

export function readUnifiedDiffField(value: unknown): string | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  return readStringField(value, ["unified_diff", "unifiedDiff", "patch", "diff"]);
}

export function normalizeSingleFilePatch(
  patch: string | undefined,
  fileLabel: string,
): string | undefined {
  if (!patch) {
    return undefined;
  }

  const trimmedPatch = patch.trim();
  if (!trimmedPatch) {
    return undefined;
  }

  if (countPatchFileDiffs(trimmedPatch) > 1) {
    // sub-agent 二次编辑同一文件时，工具层有时会把多段 diff 拼在同一个字段返回。
    // PatchDiff 只能解析单文件 patch，直接渲染会抛错并让“点击文件名查看变更”失败。
    // 这里先丢弃多文件 patch，让上层回退到 old/newText 生成的单文件 diff（或文件内容预览）。
    return undefined;
  }

  if (/^---\s+/m.test(trimmedPatch) && /^\+\+\+\s+/m.test(trimmedPatch)) {
    return trimmedPatch;
  }

  if (trimmedPatch.startsWith("@@ ")) {
    const firstHeader = trimmedPatch.match(/^@@\s-(\d+)(?:,(\d+))?\s\+(\d+)(?:,(\d+))?\s@@/m);
    const deletedCount = Number(firstHeader?.[2] ?? firstHeader?.[1] ?? "1");
    const addedCount = Number(firstHeader?.[4] ?? firstHeader?.[3] ?? "1");

    // 工具返回的 unified_diff 经常只有 hunk 片段，没有文件头。
    // 对“新建文件”场景，如果继续补成 --- a/file，PatchDiff 会按普通变更解析，
    // 大整文件新增时更容易把页面拖死。这里根据首个 hunk 判断是否为纯新增，补成 /dev/null 头。
    return [
      deletedCount === 0 && addedCount > 0 ? "--- /dev/null" : `--- a/${fileLabel}`,
      addedCount === 0 && deletedCount > 0 ? "+++ /dev/null" : `+++ b/${fileLabel}`,
      trimmedPatch,
    ].join("\n");
  }

  // apply_patch 原文也可能包含 @@，但它不是标准 unified diff。
  // 不能给这类内容强行补 ---/+++ 头，否则 summary 打开文件时会把畸形 patch 送进 PatchDiff。
  return trimmedPatch;
}

export function readRawToolCallInput(raw: unknown): unknown {
  if (!isPlainRecord(raw)) {
    return null;
  }

  if ("rawInput" in raw && raw.rawInput !== undefined) {
    return raw.rawInput;
  }

  // ZCode protocol 的 permission/request payload 按 schema 把工具参数放在 input，
  // 旧 UI 只读兼容输入字段 rawInput，Write/Edit 会退化成整段 JSON 展示而不是文件 diff。
  return "input" in raw ? raw.input : null;
}

export function readStructuredDiffBlock(
  value: unknown,
): { path?: string; oldText: string; newText: string } | null {
  if (!isPlainRecord(value) || value.type !== "diff" || typeof value.newText !== "string") {
    return null;
  }

  return {
    path: typeof value.path === "string" && value.path.trim() ? value.path : undefined,
    oldText:
      typeof value.oldText === "string"
        ? value.oldText
        : value.oldText == null
          ? ""
          : String(value.oldText),
    newText: value.newText,
  };
}

export function readRawToolCallChanges(raw: unknown) {
  if (!isPlainRecord(raw)) {
    return {
      directChanges: null,
      rawInputChanges: null,
      rawOutputChanges: null,
    };
  }

  const rawInputSource = readRawToolCallInput(raw);
  const rawInput = isPlainRecord(rawInputSource) ? rawInputSource : null;
  const rawOutput = isPlainRecord(raw.rawOutput) ? raw.rawOutput : null;

  return {
    directChanges: isPlainRecord(raw.changes) ? raw.changes : null,
    rawInputChanges: rawInput && isPlainRecord(rawInput.changes) ? rawInput.changes : null,
    rawOutputChanges: rawOutput && isPlainRecord(rawOutput.changes) ? rawOutput.changes : null,
  };
}

export interface RawToolCallFileSummary {
  path: string;
  actionLabel: "Created" | "Edited" | "Deleted";
  operationKind: EditOperationKind;
  fileName: string;
  filePath: string | null;
  fileIconSrc: string;
  changeStat?: { added: number; removed: number };
  patch?: string | null;
}

/**
 * 聊天区工具卡渲染 run 态所需的全部 workflow run 事实。宿主按 `toolCallId` 联接 `workflowRuns` 投影时一并算好。
 *
 * 刻意只有这四个字段：卡片承担的是**入口与摘要**，预算、事件日志、结果与失败面板都归详情页。
 */
export interface WorkflowRunCardSummary {
  runId: string;
  /**
   * 发起这个 run 的 **CreateWorkflow 行** id（投影 `run.toolCallId`）。打开侧栏 run 视图的
   * 请求必须带它——`WorkflowRunSidePane` 用这个 id 去行窗口找发起行（causalityGraph 与脚本
   * 原文都挂在那条行上）。只在 byRunId 联接表里填充（byToolCallId 表的键即该值）；
   * resume 行自己的 toolCallId **不是**这个值（resume 行的 display 里没有图）。
   */
  toolCallId?: string;
  status: WorkflowRunState["status"];
  /** `stopped` 的原因；投影带才带。 */
  stopReason?: WorkflowRunState["stopReason"];
  /** 已结算（`phase === "settled"`）的节点数，**含**撞界后没进表的那些。 */
  nodesSettled: number;
  /**
   * 已排程（observed）节点数，**不是**全程总数——动态工作流的节点数由脚本在运行时决定，
   * 静态总数不存在。所以进度读作「已排程的里结算了几个」，绝不冒充完成百分比。
   *
   * 两个数都出自 `workflowRunStepCounts`（@zcode/shared）：`nodes` 表内 + `usage.nodesUnlisted`
   * 表外。撞过 1024 界的 run 在这里仍报真实步数，少的是**每一步的详情**，卡与详情页各有一句
   * 「仅展示 n/m 步的详情」说这件事。
   */
  nodesTotal: number;
  /**
   * 子代理数（投影 `run.actors.length`）。卡上的计数只说阶段与子代理。
   *
   * 仍是可选的：联接表两个建表函数恒填它，但类型不强求——冷回放落地后
   * journal 兜底的两条 merge 已删除，今天没有第二个生产者；消费侧照旧对缺席宽容，不写计数。
   */
  agents?: number;
  /**
   * 活投影里的这条 run：卡片据此建
   * 时间线模型（灯、药丸、墨迹）。journal 兜底命中时缺席——那时只有状态词，时间线画静态的。
   */
  run?: WorkflowRunState;
  /**
   * 可恢复（活投影 `cancelled`，或 journal 摘要按 CLI 的 resume 门算出的 `resumable`）。
   * 卡片页脚的 Resume 只在它在场时渲染；UI 绝不自行按 status + failureCode 推导。
   */
  resumable?: true;
}

/**
 * 一条 CreateWorkflow / AmendWorkflow 行在编译反馈循环里的位置。宿主按行序从行窗口一遍算好（`v4/workflowDraftJoin.ts`），renderer 只读。
 */
export interface WorkflowDraftPosition {
  /** 第几稿：同谱系、同一轮里自上次编过以来的第几次提交，从 1 起。 */
  ordinal: number;
  /** 同谱系后面还有一行：反馈行的空环灯从警示色褪成中性。 */
  superseded: boolean;
}

export interface ToolCallBlockRenderContext {
  nestedToolRenderer: ComponentType<Parameters<typeof ToolCallBlock>[0]>;
  isOfficeMode?: boolean;
  toolCallNode: TaskChatToolCallTreeNode;
  workspacePath: string;
  /**
   * 插件 UI：scope 是沙箱登记需要的 session 范围，onOpenSidePane 是"在侧栏打开"回调；
   * 由 PluginUiSessionProvider 在边界注入。缺省表示宿主不提供，带 ui:// 资源的工具回退普通 MCP 卡片。
   */
  pluginUi?: PluginUiToolBinding;
  /**
   * 应用主题（store 耦合剥离）：由构建 render context 的宿主
   * （ToolCallBlock / PermissionDialog 等）从上层状态传入，供
   * MessageResponse / EditInlineDiffContent 等展示组件做 light/dark 分流。
   * 缺省时展示组件按 "system" 兜底。
   */
  theme?: Theme;
  /** 代码预览设置（store 耦合剥离）：同上，由宿主传入并保持引用稳定。 */
  codePreviewSettings?: CodePreviewSettings;
  displayModel: ToolDisplayModel;
  viewerSource: CodeViewerSource | null;
  rawFileSummaries: RawToolCallFileSummary[];
  isRunning: boolean;
  /** 权限预览尚未执行，不展示任何输出或空输出占位。 */
  isPermissionPreview?: boolean;
  statusLabel: string;
  sourceLabel?: string;
  errorText?: string;
  childToolList: ReactNode;
  showIcon?: boolean;
  /** CUA Group 子项显式放大 App Icon；独立 CUA 保持默认尺寸。 */
  cuaAppIconClassName?: "size-4" | "size-5";
  kindLabelOverride?: ReactNode;
  showTodoToolCalls?: boolean;
  disableSummaryContentAnimation?: boolean;
  /** Changes 子项可能在 diff 已存在后才挂载，首次数字也需要播放进入动画。 */
  animateDiffCountOnMount?: boolean;
  canToggle?: boolean;
  forceOpen?: boolean;
  /**
   * v4 subagent child session 的只读观察入口。Agent renderer 将摘要行改成
   * 直接打开右侧 tab 的动作；非 Agent 工具忽略。
   */
  agentSummaryAction?: {
    onActivate: () => void;
    testId?: string;
  };
  /** v4 已配对 subagentRow 投影出的 runtime 权威类型；流式 input 尚未完整时优先使用。 */
  authoritativeAgentType?: string;
  /** ExitPlanMode 计划卡片：由会话宿主绑定 parent/session scope 后打开 Side Pane。 */
  onOpenPlanDetail?: (request: Omit<OpenPlanDetailSideTabRequest, "parentSessionId">) => void;
  /**
   * CreateWorkflow 运行详情入口。
   *
   * 卡片只发展示名——`toolCallId`、`runId` 与会话身份全部由宿主绑定。**它的存在本身就是门控**：
   * 宿主只在该工具调用确实有一个可打开的 run 时才注入它（run 身份来自 `workflowRuns` 投影，
   * 见 `workflowRunSchema.toolCallId` 那条注释：它就是「工具卡 → 详情页的关联键」）。
   * 刻意不从工具输出里读 `backgroundTaskId`：v4 行的 `output.text` 只有
   * `formatCreateWorkflowModelContent` 挑出来的那句 `response` 散文，结构化字段并不在行上。
   */
  onOpenWorkflowRun?: (request: { workflowName?: string; phaseId?: string }) => void;
  /**
   * 卡片页脚的 Resume：与详情页同一条
   * v4 `resumeWorkflowRun {workId}` 命令，宿主绑定 runId 与会话。缺席即不渲染按钮。
   */
  onResumeWorkflowRun?: (request: { workflowName?: string }) => void;
  /**
   * 点一枚子代理药丸直接开它的 transcript：卡片交出槽位身份（run、站点、序号、运行时名，会话 id 有则随行；
   * 还没启动的药丸也可开，落到占位 tab），会话与 workspace 身份由宿主绑定。缺席即药丸不可点。
   */
  onOpenWorkflowActor?: (request: {
    runId: string;
    actorSessionId?: string;
    siteId: string;
    ordinal: number;
    actorName?: string;
  }) => void;
  /**
   * 脚本药丸 → 脚本 transcript tab：卡片只交出
   * 这一站的阶段 id（落点）与展示名，run、发起行与会话身份由宿主绑定（同 `onOpenWorkflowRun`）。
   * 缺席即脚本药丸不可点。
   */
  onOpenWorkflowWorkspace?: (request: { phaseId: string; workflowName?: string }) => void;
  /**
   * 时间线下的产物药丸 → 产物 tab：
   * 卡片只交出产物 id，run 与会话身份由宿主绑定。缺席即药丸禁用。
   */
  onOpenWorkflowArtifact?: (artifactId: string) => void;
  /**
   * 该工具调用已联接到的 workflow run 摘要；存在即卡片进入 run 态（紧凑可点卡）。
   *
   * 卡片不自己去翻 `workflowRuns` 投影：联接（按 `toolCallId`）与计数都在宿主侧一次算完
   * （`workflowRunCardJoin.ts`），renderer 只读。`nodesTotal` 是**已排程**（observed）节点数——
   * 动态工作流没有静态总数，所以进度读作「已排程的里结算了几个」，不是全程百分比。
   */
  workflowRun?: WorkflowRunCardSummary;
  /**
   * 该工具调用的草稿位置；缺席（宿主没有行窗口，如只读分享）时卡片不编号、灯保持警示色。
   * 与 `workflowRun` 一样不向子工具卡透传：位置按 toolCallId 联接，给别的行就是别人的稿号。
   */
  workflowDraft?: WorkflowDraftPosition;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
  /** 定时任务工具卡片跳转到管理页；automationId 存在时直接打开详情。 */
  onOpenAutomationsMain?: (automationId?: string) => void;
  onLoadFullToolCallFields?: (toolId: string) => Promise<boolean | void> | boolean | void;
}

export interface EditKindSource {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  input?: unknown;
  output?: unknown;
  raw?: unknown;
}

export type EditOperationKind = "write" | "edit" | "update" | "delete";
export type EditKindLabelId =
  | "chat.toolCall.edit.wrote"
  | "chat.toolCall.edit.deleted"
  | "chat.toolCall.edit.edited"
  | "chat.toolCall.edit.writing"
  | "chat.toolCall.edit.updating"
  | "chat.toolCall.edit.deleting"
  | "chat.toolCall.edit.editing"
  | "chat.toolCall.kind.write"
  | "chat.toolCall.kind.delete"
  | "chat.toolCall.kind.edit";
