import { modeTriggerColor } from "@/chat-input-toolbar/display-help.js";
import { useYoloModeConfirmation } from "@/hooks/useConfirmDialog.js";
import { useToolPresentationHostCapabilities } from "@/hooks/useToolPresentationHostCapabilities.js";
import { ToolPresentationCapabilitiesProvider } from "@/ToolCallBlocks/presentationCapabilities.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
/* eslint-disable max-lines */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME,
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
  type ZCodeProvider,
} from "@zcode/shared";
import { resolveModeOptionIcon } from "@/chat-input-toolbar/display.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu.js";
import {
  MAX_PERMISSION_FEEDBACK_CHARS,
  PERMISSION_FULL_ACCESS_OPTION_ID,
  PERMISSION_GUARDED_OPTION_ID,
} from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Textarea } from "@/components/ui/textarea.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import {
  resolveMobileInputTextSizeClassName,
  shouldAvoidIosInputFocusZoom,
  useIsMobileTextInputViewport,
} from "@/lib/mobileTextInput.js";
import {
  getPermissionOptionDisplayKind,
  getPermissionRequestPreview,
  shouldPreferPermissionOptionName,
  sortPermissionOptions,
  type PermissionRequestScope,
} from "@/lib/permissionRequest.js";
import type { TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";
import {
  readRawToolCallFileSummaries,
  type ToolCallBlockRenderContext,
} from "@/ToolCallBlocks/shared.js";
import { isPlainRecord, readRawToolCallInput } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { EditToolCallBlock } from "@/ToolCallBlocks/renderers/edit.js";
import { ExecuteToolCallBlock } from "@/ToolCallBlocks/renderers/execute.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { WebFetchToolCallBlock } from "@/ToolCallBlocks/renderers/web-fetch.js";
import { SearchToolCallBlock } from "@/ToolCallBlocks/renderers/search.js";
import { SkillToolCallBlock } from "@/ToolCallBlocks/renderers/skill.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { InteractionRequestOriginBadge } from "@/InteractionRequestOriginBadge.js";
import { WorkflowPermissionBlock } from "@/WorkflowPermissionBlock.js";
import {
  focusLastWorkflowSettingsControl,
  isWorkflowSettingsCarrier,
  usePermissionWorkflowSettings,
  workflowAdjustedOptionDescriptionId,
} from "@/permissionWorkflowSettings.js";
import { SaveWorkflowPermissionBlock } from "@/SaveWorkflowPermissionBlock.js";
import { isSaveWorkflowToolCall } from "@/lib/workflowToolNames.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { ChevronDownIcon, Info, LoaderCircle, WrenchIcon } from "lucide-react";

const MCP_PERMISSION_TOOL_ICON = <WrenchIcon className="size-4 shrink-0 text-foreground-subtle" />;

type PermissionBlockKind =
  | "edit"
  | "execute"
  | "mcp"
  | "web-fetch"
  | "search"
  | "skill"
  | "workflow"
  | "saveWorkflow"
  | "fallback";

interface PermissionBlockInteraction {
  canToggle: boolean;
  forceOpen: boolean;
}

interface PermissionRuleScope {
  display: string;
  truncated: boolean;
}

const PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS = 160;
const NON_USER_FACING_PERMISSION_REASONS = new Set([
  "High risk tools require explicit approval",
  "Tool has side effects and requires approval",
]);

function formatPermissionRuleScope(content: string): PermissionRuleScope {
  const lineBreakIndex = content.search(/\r?\n/);
  const firstLine = lineBreakIndex === -1 ? content : content.slice(0, lineBreakIndex);
  const truncated =
    lineBreakIndex !== -1 || firstLine.length > PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS;

  const suffix = " …";
  const visible = firstLine
    .slice(0, PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS - suffix.length)
    .trimEnd();
  return { display: `${visible}${suffix}`, truncated };
}

function readPermissionRuleScopes(option: ZCodePermissionOption): PermissionRuleScope[] {
  const scopes: PermissionRuleScope[] = [];
  for (const update of option.response?.permissionUpdates ?? []) {
    if (update.type !== "addRules" || update.behavior !== "allow") continue;
    for (const rule of update.rules) {
      if (rule.toolName.toLowerCase() !== "bash") continue;
      const content = rule.ruleContent?.trim();
      if (!content?.endsWith(":*")) continue;
      scopes.push(formatPermissionRuleScope(content.slice(0, -2)));
    }
  }
  return scopes.slice(0, 5);
}

function isOfficialCuaProjectPermission(option: ZCodePermissionOption): boolean {
  return (option.response?.permissionUpdates ?? []).some(
    (update) =>
      update.type === "addRules" &&
      update.behavior === "allow" &&
      update.rules.some((rule) => rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME),
  );
}

/**
 * workflow Refine（拒绝并附修改意见）。
 * 该选项不渲染成按钮，而是作为反馈行的应答目标：用户在其他确认窗同一行编号输入行里写修改意见，
 * 提交时应答携带 freeText，CLI broker 据此把 deny 升级为带 workflow_refine_feedback 的用户反馈。
 */
function isWorkflowRefineOption(option: ZCodePermissionOption): boolean {
  return option.optionId === WORKFLOW_REFINE_PERMISSION_OPTION_ID;
}

function InlinePermissionPrefixScopes({ scopes }: { scopes: readonly PermissionRuleScope[] }) {
  if (scopes.length === 0) return null;
  return (
    <span
      className="flex min-w-0 flex-1 basis-48 flex-col gap-1"
      data-permission-rule-scopes="true"
      data-permission-rule-prefixes="true"
    >
      {scopes.map((scope, index) => (
        <code
          key={`${scope.display}:${index}`}
          className="min-w-0 whitespace-pre-wrap break-all font-mono text-ui-base leading-5 text-foreground-subtle"
          data-permission-rule-scope="prefix"
          data-permission-rule-scope-truncated={scope.truncated ? "true" : undefined}
        >
          {scope.display}
        </code>
      ))}
    </span>
  );
}

function getOptionLabelMessageId(kind: string): string | null {
  switch (getPermissionOptionDisplayKind(kind)) {
    case "allowOnce":
      return "chat.permission.approve";
    case "allowAlways":
      return "chat.permission.approveAlways";
    case "rejectOnce":
      return "chat.permission.deny";
    case "rejectAlways":
      return "chat.permission.denyAlways";
    default:
      return null;
  }
}

const PROVIDER_PERMISSION_OPTION_NAME_LABELS: Partial<
  Record<ZCodeProvider, Record<string, string>>
> = {
  glm: {
    // GLM/ZCode Agent 通过 ZCode Agent 发来的项目级记忆授权文案是英文原文。
    // 这里把已知 provider-native 权限文案统一归一到 i18n，避免被当成自定义选项直出英文。
    "always allow in this project": "chat.permission.allowForProject",
  },
};

interface PermissionOptionNameMessageIds {
  label: string;
  /** 按 name 命中时可覆盖 kind 推导的描述：会话级选项不能沿用「相同请求不再询问」的项目级文案。 */
  description?: string;
}

const GLOBAL_PERMISSION_OPTION_NAME_LABELS: Record<string, PermissionOptionNameMessageIds> = {
  "full access": {
    label: "chat.permission.fullAccess",
    description: "chat.permission.fullAccess.description",
  },
  "always allow in this project": { label: "chat.permission.allowForProject" },
  "always allow computer use in this project": { label: "chat.permission.cua.allowForProject" },
  // workflow 运行确认窗的会话免确认：
  // CLI 侧 name 是匹配键，wire kind 是 allowAlways（排序 / 样式同 always allow）。
  "always allow in this session": {
    label: "chat.permission.workflow.allowForSession",
    description: "chat.permission.workflow.allowForSession.description",
  },
};

function getProviderOptionNameMessageIds(
  provider: ZCodeProvider | undefined,
  name: string,
): PermissionOptionNameMessageIds | null {
  const normalizedName = name.trim().replace(/\s+/g, " ").toLowerCase();
  const global = GLOBAL_PERMISSION_OPTION_NAME_LABELS[normalizedName];
  if (global) {
    return global;
  }
  const providerLabel = provider
    ? PROVIDER_PERMISSION_OPTION_NAME_LABELS[provider]?.[normalizedName]
    : undefined;
  return providerLabel ? { label: providerLabel } : null;
}

function getOptionDescriptionMessageId(kind: string, scope: PermissionRequestScope): string | null {
  switch (getPermissionOptionDisplayKind(kind)) {
    case "allowOnce":
      return "chat.permission.allowOnce.description";
    case "allowAlways":
      return `chat.permission.allowAlways.description.${scope}`;
    case "rejectOnce":
      return "chat.permission.denyOnce.description";
    case "rejectAlways":
      return `chat.permission.denyAlways.description.${scope}`;
    default:
      return null;
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readUserFacingPermissionReason(value: unknown): string | null {
  const reason = readNonEmptyString(value);
  // 通用权限策略原因用于协议诊断，不是能帮助用户判断本次操作的具体说明。
  // 之前 UI 无差别展示 reason，导致权限弹窗重复出现和“等待确认”语义相同的英文文案。
  return reason && !NON_USER_FACING_PERMISSION_REASONS.has(reason) ? reason : null;
}

function getPermissionDisplayReason(request: ZCodePermissionRequest): string | null {
  const rawInput = readRawToolCallInput(request.raw);
  const inputReason = isPlainRecord(rawInput)
    ? (readUserFacingPermissionReason(rawInput.description) ??
      readUserFacingPermissionReason(rawInput.reason) ??
      readUserFacingPermissionReason(rawInput.summary))
    : null;
  const rawReason = isPlainRecord(request.raw)
    ? readUserFacingPermissionReason(request.raw.reason)
    : null;

  return inputReason ?? readUserFacingPermissionReason(request.description) ?? rawReason;
}

function getMcpPermissionToolName(toolCall: TaskChatToolCall): string | null {
  const rawToolName = isPlainRecord(toolCall.raw)
    ? (readNonEmptyString(toolCall.raw.toolName) ?? readNonEmptyString(toolCall.raw.tool_name))
    : null;
  const toolName =
    readNonEmptyString(toolCall.toolName) ??
    rawToolName ??
    readNonEmptyString(toolCall.kind) ??
    readNonEmptyString(toolCall.title);

  return toolName?.startsWith("mcp__") ? toolName : null;
}

function getMcpPermissionReason(toolCall: TaskChatToolCall): string | null {
  return isPlainRecord(toolCall.raw) ? readNonEmptyString(toolCall.raw.reason) : null;
}

function resolvePermissionBlockKind(
  preview: ReturnType<typeof getPermissionRequestPreview>,
  toolCall: TaskChatToolCall,
  rawFileSummaries: ToolCallBlockRenderContext["rawFileSummaries"],
): PermissionBlockKind {
  // SaveWorkflow 按**工具名**最先判定，早于文件摘要与 family 分流。它归一化入参里带着 `path`
  // 与完整 `script`，任何一条「看起来像写文件」的启发式都可能把它吸进 edit 块；而 workflow
  // family 一旦登记这个名字，它又会掉进运行确认块（图 + Refine，对一次写盘完全是错的语言）。
  if (isSaveWorkflowToolCall(toolCall)) {
    return "saveWorkflow";
  }

  if (rawFileSummaries.length > 0 || preview.fileChanges.length > 0) {
    return "edit";
  }

  const identity = resolveToolCallIdentity(toolCall);

  if (getMcpPermissionToolName(toolCall)) {
    // MCP 权限请求不是普通未知工具；以前走 fallback 会把 raw JSON 摊开，并把工具名显示两次。
    // 这里单独展示 MCP 名称和协议里的 reason，避免用户在审批时读调试 payload。
    return "mcp";
  }

  // 权限弹窗之前单独猜 kind/title/rawInput.skill，和聊天区分流规则会漂移。
  // 这里复用固定 tool identity，让 Skill 权限请求在确认前后都走同一套语义。
  if (identity.family === "skill") {
    return "skill";
  }

  if (identity.family === "workflow") {
    // 工作流确认窗的主体是因果图 + 折叠脚本，和聊天区同一 tool identity 分流；
    // 必须早于 search/execute 判定，否则脚本里的命令片段会把它误判成普通命令确认。
    return "workflow";
  }

  if (identity.family === "web-fetch") return "web-fetch";
  if (identity.family === "search") {
    // WebFetch/WebSearch 权限请求以前落到 fallback，会把整包 toolCall JSON 打出来。
    // 这里和聊天区一样走 search renderer，只展示用户关心的 URL/query 摘要。
    return "search";
  }

  if (preview.command) {
    return "execute";
  }

  return "fallback";
}

function getPermissionBlockInteraction(blockKind: PermissionBlockKind): PermissionBlockInteraction {
  switch (blockKind) {
    case "edit":
      return {
        canToggle: false,
        forceOpen: false,
      };
    case "mcp":
    case "skill":
    case "web-fetch":
    case "search":
    case "execute":
    case "workflow":
    case "saveWorkflow":
    case "fallback":
      // 这里是权限弹窗的中间态展示，不提供收起/展开交互，避免用户把关键内容藏起来。
      // workflow / saveWorkflow 只为穷尽性列在这里：它们由各自的专用块直接渲染，不走通用块，
      // 块内脚本折叠是 spec 记录的刻意例外（图、名称与落点仍不可折叠）。
      return {
        canToggle: false,
        forceOpen: true,
      };
  }
}

function buildPermissionToolCall(
  request: ZCodePermissionRequest,
  preview: ReturnType<typeof getPermissionRequestPreview>,
): TaskChatToolCall {
  const rawInput = readRawToolCallInput(request.raw);

  return {
    toolId: `permission:${request.requestId}`,
    kind: request.kind,
    title: request.title ?? request.description ?? preview.title,
    input: rawInput ?? preview.command ?? request.raw,
    status: "completed",
    raw: request.raw,
  };
}

function buildPermissionBlockContext(
  toolCall: TaskChatToolCall,
  rawFileSummaries: ToolCallBlockRenderContext["rawFileSummaries"],
  workspacePath: string,
  blockKind: PermissionBlockKind,
  kindLabelOverride: ReactNode,
  theme: ToolCallBlockRenderContext["theme"],
  codePreviewSettings: ToolCallBlockRenderContext["codePreviewSettings"],
): ToolCallBlockRenderContext {
  const { canToggle, forceOpen } = getPermissionBlockInteraction(blockKind);

  return {
    nestedToolRenderer: ToolCallBlock,
    toolCallNode: {
      toolCall,
      childToolCalls: [],
    } as ToolCallBlockRenderContext["toolCallNode"],
    workspacePath,
    // store 耦合剥离：展示组件不再自取 store，主题/代码预览设置由对话框宿主注入。
    theme,
    codePreviewSettings,
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries,
    // 权限弹窗等待用户确认时工具还没有执行，不能复用 running 状态。
    // 之前 Bash 权限会显示“执行中”并带 loading，遮住真正的申请原因。
    isRunning: false,
    // 权限预览使用合成 completed 节点，必须显式区分，避免误报“没有输出”。
    isPermissionPreview: true,
    statusLabel: "",
    childToolList: null,
    showIcon: true,
    kindLabelOverride,
    canToggle,
    forceOpen,
    onOpenCodeViewer: undefined,
    onOpenBrowserUrl: undefined,
  };
}

function McpPermissionBlock(context: ToolCallBlockRenderContext) {
  const { toolCall } = context.toolCallNode;
  const toolName = getMcpPermissionToolName(toolCall) ?? toolCall.title ?? toolCall.kind;
  const reason = getMcpPermissionReason(toolCall);
  const hasKindLabelOverride = context.kindLabelOverride != null;
  const primaryText = useMemo(
    () =>
      hasKindLabelOverride ? (
        <span className="min-w-0 truncate text-foreground-subtle">{toolName}</span>
      ) : reason ? (
        <span className="min-w-0 truncate text-foreground-subtle">{reason}</span>
      ) : null,
    [hasKindLabelOverride, reason, toolName],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={MCP_PERMISSION_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={false}
      kindLabel={context.kindLabelOverride ?? toolName}
      primaryText={primaryText}
      isRunning={context.isRunning}
      content={null}
    />
  );
}

/**
 * 保存确认窗：聚焦滚动区里最后一个控件（区内只有展开钮与脚本开关）。区不在或没有控件即返回 false，
 * 交回选项列表自己的循环。
 */
function focusLastSaveWorkflowControl(root: HTMLElement | null): boolean {
  const controls = root?.querySelectorAll<HTMLElement>(
    "[data-permission-dialog-scroll] button:not([disabled])",
  );
  const last = controls === undefined ? undefined : controls[controls.length - 1];
  if (last === undefined) return false;
  last.focus();
  return true;
}

export function PermissionDialog({
  request,
  onRespond,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  workflowSessionModel,
  provider,
  isWebRemoteControl = false,
  responding = false,
  responseError,
  permissionMode,
  committedMode,
  modeSwitch,
}: {
  request: ZCodePermissionRequest;
  responding?: boolean;
  permissionMode?: string;
  committedMode?: "guarded" | "yolo";
  modeSwitch?: "choose" | "fullAccessOnly";
  responseError?: string;
  /**
   * `content` 只在工作流确认窗的放行应答上出现：用户在窗里改过的设置（docs/dynamic-workflow/launch.md
   * 「Adjusting the settings in the window」）。没改过即不传。
   */
  onRespond: (
    requestId: string,
    option: ZCodePermissionOption,
    feedback?: string,
    content?: Record<string, unknown>,
  ) => void;
  workspacePath: string;
  /** 工作流确认窗的模型清单作用域与会话模型（宿主给）。 */
  workspaceIdentity?: string;
  remoteSessionId?: string;
  workflowSessionModel?: { providerId: string; modelId: string };
  provider?: ZCodeProvider;
  isWebRemoteControl?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [pickedMode, setPickedMode] = useState<"guarded" | "yolo">("guarded");
  const canPickMode =
    !committedMode &&
    modeSwitch === "choose" &&
    permissionMode !== "guarded" &&
    permissionMode !== "yolo";
  const targetMode = committedMode ?? (canPickMode ? pickedMode : "yolo");
  const modeLabel = (mode: "guarded" | "yolo") =>
    intl.formatMessage({
      id: mode === "guarded" ? "mode.label.glm.guarded" : "mode.label.glm.yolo",
    });
  const switchLabel = (mode: string) =>
    intl.formatMessage({ id: "chat.permission.allowAndSwitch" }, { mode });
  // 可选模式是独立控件；固定模式在完整句子的占位位置显示带颜色的徽标。
  const [switchBeforeMode, switchAfterMode] = intl
    .formatMessage({ id: "chat.permission.allowAndSwitch" })
    .split("{mode}");
  const TargetIcon = resolveModeOptionIcon(targetMode);
  const confirmMode = useYoloModeConfirmation(
    JSON.stringify([
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      request.taskId,
      request.requestId,
      responding,
    ]),
    modeSwitch === "fullAccessOnly" ? "guarded" : permissionMode,
  );
  const presentationCapabilities = useToolPresentationHostCapabilities(workspacePath);
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  // Bug 根因：反馈输入也会渲染在手机 Web 远控的 PermissionDialog 中，14px 输入框聚焦时会触发 iOS 页面放大。
  // 与 composer 复用同一套视口判断和 16px 兼容 token，桌面和非远控 Web 保持原有字号。
  const avoidIosInputFocusZoom = shouldAvoidIosInputFocusZoom({
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  // M5②.5 store 耦合剥离：主题/代码预览设置在宿主处取 store，向下走 props/render context。
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  // 工作流确认窗的 Refine 选项不进按钮列表：它就是这个窗的反馈行（见 feedbackOption）。
  const refineOption = useMemo(
    () => request.options.find(isWorkflowRefineOption),
    [request.options],
  );
  const orderedOptions = useMemo(
    () =>
      sortPermissionOptions(request.options).filter((option) => !isWorkflowRefineOption(option)),
    [request.options],
  );
  const preview = useMemo(() => getPermissionRequestPreview(request), [request]);
  const toolCall = useMemo(() => buildPermissionToolCall(request, preview), [preview, request]);
  const rawFileSummaries = useMemo(
    () =>
      // 权限弹窗之前只认 preview.fileChanges，Write 请求如果只带 file_path/content，
      // 这里就会丢失文件摘要；改成复用聊天区同一套 edit 解析，避免两个入口展示结果不一致。
      readRawToolCallFileSummaries(toolCall.raw, {
        kind: toolCall.kind,
        title: toolCall.title,
        input: toolCall.input,
        output: toolCall.output,
        raw: toolCall.raw,
      }),
    [toolCall],
  );
  const blockKind = useMemo(
    () => resolvePermissionBlockKind(preview, toolCall, rawFileSummaries),
    [preview, rawFileSummaries, toolCall],
  );
  const blockContext = useMemo(
    () =>
      buildPermissionBlockContext(
        toolCall,
        rawFileSummaries,
        workspacePath,
        blockKind,
        intl.formatMessage({ id: "chat.permission.awaitingApproval" }),
        theme,
        codePreviewSettings,
      ),
    [blockKind, codePreviewSettings, intl, rawFileSummaries, theme, toolCall, workspacePath],
  );
  const displayReason = useMemo(() => getPermissionDisplayReason(request), [request]);
  // 工作流确认窗的两项 run 设置（WorkflowPermissionBlock 画，这里只存改过的值与「模型不可用」）。
  const isWorkflowAsk = blockKind === "workflow";
  const workflowSettings = usePermissionWorkflowSettings(request.requestId);
  const workflowSettingsContent = isWorkflowAsk ? workflowSettings.content : undefined;
  const isOptionBlocked = useCallback(
    (option: ZCodePermissionOption) =>
      isWorkflowAsk && workflowSettings.blocked && isWorkflowSettingsCarrier(option),
    [isWorkflowAsk, workflowSettings.blocked],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [feedback, setFeedback] = useState("");
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const feedbackInputRef = useRef<HTMLTextAreaElement | null>(null);
  const feedbackCompositionActiveRef = useRef(false);
  const feedbackInputFocusedRef = useRef(false);
  const denyOption = useMemo(
    () =>
      orderedOptions.find((option) =>
        getPermissionOptionDisplayKind(option.kind).startsWith("reject"),
      ),
    [orderedOptions],
  );
  // 反馈行的应答目标：工作流确认窗是 Refine（拒绝 + 修改意见升级为真实 user message），
  // 其他确认窗是 Deny（拒绝 + 反馈）。两种确认窗共用同一行输入，只换应答目标与文案，
  // 不再各画一套输入框——同一停靠区里两种反馈输入长得不一样是设计债。
  // 原因：复用 Deny 索引会让拒绝按钮和输入框同时高亮；输入行独立导航，提交才用目标选项。
  const feedbackOption = refineOption ?? (request.freeText === true ? denyOption : undefined);
  const hasFeedbackInput = Boolean(feedbackOption);
  const feedbackIndex = orderedOptions.length;
  const selectableCount = orderedOptions.length + (hasFeedbackInput ? 1 : 0);
  const isFeedbackSelected = hasFeedbackInput && selectedIndex === feedbackIndex;

  useEffect(() => {
    setSelectedIndex(0);
    setPickedMode("guarded");
    // 草稿按 requestId 归零，避免一个请求的反馈（或工作流修改意见）泄漏进下一个确认窗。
    setFeedback("");
  }, [request.requestId]);

  useEffect(() => {
    if (orderedOptions.length === 0) {
      return;
    }
    if (feedbackInputFocusedRef.current) {
      return;
    }

    // 反馈输入框新增后，旧的 RAF 可能在用户获得输入焦点后才回调，重新抢回选项焦点。
    // 回调执行时再次确认焦点状态，避免打断用户输入。
    const frameId = requestAnimationFrame(() => {
      if (!feedbackInputFocusedRef.current) {
        if (isFeedbackSelected) feedbackInputRef.current?.focus();
        else optionRefs.current[selectedIndex]?.focus();
      }
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [isFeedbackSelected, orderedOptions.length, request.requestId, selectedIndex]);

  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      if (selectableCount === 0) {
        return;
      }

      feedbackInputFocusedRef.current = false;
      setSelectedIndex(
        (currentIndex) => (currentIndex + direction + selectableCount) % selectableCount,
      );
    },
    [selectableCount],
  );

  const respondWithOption = useCallback(
    (option: ZCodePermissionOption) => {
      // 所选子代理模型已不可用：放行要等用户换一个，与「配置」弹层的 Apply 同一条规则。
      if (responding || isOptionBlocked(option)) return;
      const selectedKind = getPermissionOptionDisplayKind(option.kind);
      // 通用确认窗里 Deny 顺带把反馈行草稿作为拒绝理由发出；工作流确认窗的草稿属于 Refine，
      // 点 Deny 就是普通拒绝——否则一段修改意见会以普通拒绝理由的身份发出，
      // 模型收不到 workflow_refine_feedback 的升级递送。
      const trimmedFeedback =
        !refineOption && selectedKind.startsWith("reject") ? feedback.trim() : "";
      const content =
        workflowSettingsContent !== undefined && isWorkflowSettingsCarrier(option)
          ? { ...workflowSettingsContent }
          : undefined;
      const switchMode = option.optionId === PERMISSION_FULL_ACCESS_OPTION_ID;
      if (switchMode && targetMode === "guarded")
        option = { ...option, optionId: PERMISSION_GUARDED_OPTION_ID };
      confirmMode(switchMode ? targetMode : "unchanged", () => {
        if (content === undefined) {
          onRespond(request.requestId, option, trimmedFeedback || undefined);
        } else {
          onRespond(request.requestId, option, trimmedFeedback || undefined, content);
        }
      });
    },
    [
      confirmMode,
      targetMode,
      feedback,
      isOptionBlocked,
      onRespond,
      refineOption,
      request.requestId,
      responding,
      workflowSettingsContent,
    ],
  );

  const submitFeedback = useCallback(() => {
    // 提交前 trim：CLI broker 对空白 freeText 落普通 deny，不能把纯空白当反馈。
    const trimmedFeedback = feedback.trim();
    if (responding || !feedbackOption || !trimmedFeedback) {
      return;
    }
    onRespond(request.requestId, feedbackOption, trimmedFeedback);
  }, [feedback, feedbackOption, onRespond, request.requestId, responding]);

  const confirmSelection = useCallback(() => {
    if (isFeedbackSelected) {
      submitFeedback();
      return;
    }
    const selectedOption = orderedOptions[selectedIndex];
    if (selectedOption) respondWithOption(selectedOption);
  }, [isFeedbackSelected, orderedOptions, respondWithOption, selectedIndex, submitFeedback]);

  const handleFeedbackKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      event.stopPropagation();
      if (
        isImeComposingKeyEvent({
          compositionActive: feedbackCompositionActiveRef.current,
          nativeEvent: event.nativeEvent,
        })
      ) {
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Tab") {
        event.preventDefault();
        moveSelection(event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        submitFeedback();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        feedbackInputRef.current?.blur();
      }
    },
    [moveSelection, submitFeedback],
  );

  const handleOptionKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (hasFeedbackInput && event.key === String(feedbackIndex + 1)) {
        event.preventDefault();
        setSelectedIndex(feedbackIndex);
        return;
      }
      if (event.key === "1" || event.key === "2" || event.key === "3") {
        const shortcutIndex = Number(event.key) - 1;
        const shortcutOption = orderedOptions[shortcutIndex];
        if (!shortcutOption) {
          return;
        }

        event.preventDefault();
        setSelectedIndex(shortcutIndex);
        respondWithOption(shortcutOption);
        return;
      }

      switch (event.key) {
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          moveSelection(-1);
          return;
        case "ArrowDown":
        case "ArrowRight":
          event.preventDefault();
          moveSelection(1);
          return;
        case "Tab":
          if (!event.shiftKey && event.currentTarget.dataset.testid === "permission-allow-switch") {
            const picker = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
              '[data-testid="permission-target-picker"]',
            );
            if (picker) {
              event.preventDefault();
              picker.focus();
              return;
            }
          }
          // 长命令新增了阅读按钮，旧的选项循环会困住焦点；第一项反向 Tab 交还浏览器，
          // 按 DOM 顺序进入上方命令按钮，其正向 Tab 自然回到当前第一项，不触发授权。
          if (
            event.shiftKey &&
            optionRefs.current.indexOf(event.currentTarget) === 0 &&
            rootRef.current?.querySelector("[data-command-preview-toggle]")
          ) {
            return;
          }
          // 工作流确认窗：第一个选项上的 Shift+Tab 离开列表、回到上方的设置控件（阅读次序即焦点次序）。
          // 按事件落在哪个按钮上判，不读 selectedIndex：聚焦与按键可能在同一帧，状态还没提交。
          if (
            event.shiftKey &&
            optionRefs.current.indexOf(event.currentTarget) === 0 &&
            isWorkflowAsk &&
            focusLastWorkflowSettingsControl(rootRef.current)
          ) {
            event.preventDefault();
            return;
          }
          // 保存确认窗同理：第一个选项上的 Shift+Tab 回到上方滚动区的最后一个控件，正向 Tab 再按 DOM
          // 次序走回当前选项。Bugfix：这里原先没有出口，选项循环困住焦点，折叠起来的说明、参数与脚本
          // 只能用鼠标展开。
          if (
            event.shiftKey &&
            optionRefs.current.indexOf(event.currentTarget) === 0 &&
            blockKind === "saveWorkflow" &&
            focusLastSaveWorkflowControl(rootRef.current)
          ) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          moveSelection(event.shiftKey ? -1 : 1);
          return;
        case "Enter":
          event.preventDefault();
          confirmSelection();
          return;
        default:
          return;
      }
    },
    [
      blockKind,
      confirmSelection,
      feedbackIndex,
      hasFeedbackInput,
      isWorkflowAsk,
      moveSelection,
      orderedOptions,
      respondWithOption,
    ],
  );

  const PermissionBlock =
    blockKind === "edit"
      ? EditToolCallBlock
      : blockKind === "mcp"
        ? McpPermissionBlock
        : blockKind === "skill"
          ? SkillToolCallBlock
          : blockKind === "web-fetch"
            ? WebFetchToolCallBlock
            : blockKind === "search"
              ? SearchToolCallBlock
              : blockKind === "execute"
                ? ExecuteToolCallBlock
                : FallbackToolCallBlock;
  // 当前 ZCode Agent 的 ExitPlanMode 权限请求不再传 legacy switch_mode。
  // 这里复用 tool identity，避免审批弹窗和聊天区的计划模式工具分流再次漂移。
  const shouldUseSwitchModePlaceholder = resolveToolCallIdentity(toolCall).family === "switch-mode";
  // 工作流确认窗自带本地化标题（「运行此工作流？」）和图主体，走独立块而不是通用预览块。
  const shouldUseWorkflowBlock = isWorkflowAsk;
  // 保存确认窗同理，但问句、内容与选项都不同：没有图、没有 Refine，主体是落点 + 元数据 + 脚本。
  const shouldUseSaveWorkflowBlock = blockKind === "saveWorkflow";
  // 限高布局目前只给保存确认窗（docs/dynamic-workflow/launch.md「`SaveWorkflow`」第 4 步）：窗口上限与
  // 问答窗（ElicitationDialog）相同；选项以上全部内容是**唯一**的纵向滚动区，选项、反馈行与确认
  // 隔一条细线钉在下面。滚动区用负外边距铺满窗宽，滚动条贴窗口边缘、细线横贯整窗。
  // Bugfix：上一版问句钉顶、中段滚动、段内三块各自滚动、窗口再兜底滚动，最多五层滚动容器叠在
  // 一起，一次滚轮手势的去向取决于指针恰好在哪个框上；块内的长内容改为折叠后，这里只剩一层。
  // 钉底只在屏幕够高（≥36rem）时成立：选项、最多 5 行的反馈、错误行与确认栏本身就有约 320px，
  // 矮屏（如横屏手机）上它们会高过上限、被窗口裁掉，确认按钮跟着消失。所以基础布局是整窗一个
  // 滚动区（选项随内容滚动），够高才切到「选项以上滚、选项钉底」；两种高度下都只有一个滚动容器。
  const bounded = shouldUseSaveWorkflowBlock;
  return (
    <div ref={rootRef} className="w-full shrink-0 relative z-1">
      <div
        className={cn(
          "w-full rounded-2xl border border-border bg-popover shadow-xs",
          bounded
            ? "max-h-[min(72dvh,42rem)] overflow-y-auto overscroll-contain [@media(min-height:36rem)]:flex [@media(min-height:36rem)]:flex-col [@media(min-height:36rem)]:overflow-hidden"
            : "overflow-hidden",
        )}
        {...(bounded ? { "data-permission-dialog-bounded": "true" } : {})}
      >
        <div
          className={cn(
            "flex flex-col gap-3 p-3",
            bounded && "[@media(min-height:36rem)]:min-h-0 [@media(min-height:36rem)]:flex-1",
          )}
        >
          <div
            className={cn(
              "space-y-4",
              bounded &&
                "-mx-3 -mt-3 border-b border-border p-3 [@media(min-height:36rem)]:min-h-0 [@media(min-height:36rem)]:overflow-y-auto [@media(min-height:36rem)]:overscroll-contain",
            )}
            {...(bounded ? { "data-permission-dialog-scroll": "true" } : {})}
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-ui-base font-medium leading-tight text-foreground-subtle">
                {intl.formatMessage({ id: "chat.permission.title" })}
              </p>
              <InteractionRequestOriginBadge origin={request.origin} />
            </div>
            {!shouldUseSwitchModePlaceholder &&
            !shouldUseWorkflowBlock &&
            !shouldUseSaveWorkflowBlock &&
            displayReason ? (
              <p className="text-ui-base leading-5 text-foreground">{displayReason}</p>
            ) : null}
            {shouldUseSwitchModePlaceholder ? (
              <div className="flex items-center gap-2 text-ui-base text-foreground">
                <LoaderCircle className="size-4 shrink-0 animate-spin text-foreground-subtle" />
                <span className="animated-gradient-text font-medium">
                  {intl.formatMessage({
                    id: "chat.permission.switchMode.placeholder",
                  })}
                </span>
              </div>
            ) : shouldUseWorkflowBlock ? (
              // CLI 侧的 reason 是给协议诊断用的（"createWorkflow.runConfirmation: ..."），
              // 这里刻意不渲染 displayReason：块内的本地化标题才是给用户看的那句问句。
              <WorkflowPermissionBlock
                onSettingsBlockedChange={workflowSettings.onBlockedChange}
                onSettingsChange={workflowSettings.onContentChange}
                request={request}
                settingsDisabled={responding}
                workspacePath={workspacePath}
                {...(workspaceIdentity === undefined ? {} : { workspaceIdentity })}
                {...(remoteSessionId === undefined ? {} : { remoteSessionId })}
                {...(workflowSessionModel === undefined
                  ? {}
                  : { sessionModel: workflowSessionModel })}
              />
            ) : shouldUseSaveWorkflowBlock ? (
              // 同上：保存 gate 的问句（保存 / 覆盖两句）由块自己给出，不复用协议 reason。
              <SaveWorkflowPermissionBlock request={request} />
            ) : (
              // 审批直接使用 renderer，绕过 ToolCallBlock 时也必须提供宿主展示能力。
              <ToolPresentationCapabilitiesProvider value={presentationCapabilities}>
                <PermissionBlock {...blockContext} />
              </ToolPresentationCapabilitiesProvider>
            )}
          </div>

          {/* 反馈行曾被外层 gap-3 隔开；用同一 4px 视觉分组，保留 listbox 的权限选项边界。 */}
          <div className="shrink-0 space-y-1">
            <div
              role="listbox"
              aria-label={intl.formatMessage({ id: "chat.permission.title" })}
              className="space-y-1"
            >
              {orderedOptions.map((option, index) => {
                const isSelected = index === selectedIndex;
                const officialCuaProjectPermission = isOfficialCuaProjectPermission(option);
                const labelMessageId = officialCuaProjectPermission
                  ? "chat.permission.cua.allowForProject"
                  : option.name.trim().toLowerCase() === "always allow in this project" &&
                      preview.scope === "command"
                    ? "chat.permission.allowCommand"
                    : getOptionLabelMessageId(option.kind);
                const nameMessageIds = getProviderOptionNameMessageIds(provider, option.name);
                const baseDescriptionMessageId = officialCuaProjectPermission
                  ? "chat.permission.cua.allowForProject.description"
                  : labelMessageId === "chat.permission.allowCommand"
                    ? "chat.permission.allowCommand.description"
                    : (nameMessageIds?.description ??
                      getOptionDescriptionMessageId(option.kind, preview.scope));
                // 工作流确认窗改过设置：放行的两项改口说「按调整后的设置」（docs/dynamic-workflow/launch.md
                // 「The options」）。
                const descriptionMessageId =
                  workflowSettingsContent === undefined
                    ? baseDescriptionMessageId
                    : workflowAdjustedOptionDescriptionId(baseDescriptionMessageId);
                const blocked = isOptionBlocked(option);
                const fallbackLabel = labelMessageId
                  ? intl.formatMessage({ id: labelMessageId })
                  : null;
                const knownNameLabel = nameMessageIds
                  ? intl.formatMessage({ id: nameMessageIds.label })
                  : null;
                // ZCode Agent 协议里 option.name 才是给用户看的真实选项文案，kind 只表示按钮语义。
                // 之前这里一律按 kind 本地化，像 switch_mode 这类不同语义但同属 allow_always 的选项，
                // 会被错误压成两条一模一样的“始终允许”。
                const preferOptionName = shouldPreferPermissionOptionName(option);
                const label =
                  (labelMessageId === "chat.permission.allowCommand"
                    ? fallbackLabel
                    : knownNameLabel) ??
                  (preferOptionName ? option.name : (fallbackLabel ?? option.name));
                const description =
                  (preferOptionName && !knownNameLabel) || !descriptionMessageId
                    ? null
                    : intl.formatMessage({ id: descriptionMessageId });
                const ruleScopes =
                  getPermissionOptionDisplayKind(option.kind) === "allowAlways"
                    ? readPermissionRuleScopes(option)
                    : [];

                const switchRow =
                  modeSwitch !== undefined && option.optionId === PERMISSION_FULL_ACCESS_OPTION_ID;
                const indexLabel = (
                  <span
                    className={cn(
                      "w-5 shrink-0 text-ui-base font-medium self-center",
                      isSelected ? "text-foreground" : "text-foreground-subtlest",
                    )}
                  >
                    {index + 1}.
                  </span>
                );
                const button = (
                  <button
                    key={option.optionId}
                    data-testid={switchRow ? "permission-allow-switch" : undefined}
                    // exact rule 按产品语义不展示后，E2E 不能再靠可见规则文本猜 option；
                    // 暴露规范化语义供无障碍自动化稳定选择，不泄露原始命令内容。
                    data-permission-option-kind={getPermissionOptionDisplayKind(option.kind)}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    type="button"
                    role="option"
                    aria-label={switchRow ? switchLabel(modeLabel(targetMode)) : label}
                    aria-selected={isSelected}
                    {...(blocked ? { "aria-disabled": true } : {})}
                    tabIndex={isSelected ? 0 : -1}
                    onClick={() => {
                      if (isSelected || switchRow) {
                        respondWithOption(option);
                      } else {
                        setSelectedIndex(index);
                      }
                    }}
                    onFocus={() => setSelectedIndex(index)}
                    onKeyDown={handleOptionKeyDown}
                    className={cn(
                      switchRow
                        ? "inline-flex items-center gap-1 text-left text-ui-base font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-xl"
                        : "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors focus-visible:bg-selected",
                      !switchRow && (isSelected ? "bg-selected" : "hover:bg-hover"),
                      blocked && "cursor-not-allowed",
                      blocked && !switchRow && "opacity-50",
                    )}
                  >
                    {switchRow ? (
                      canPickMode ? (
                        intl.formatMessage({ id: "chat.permission.switchAction" })
                      ) : (
                        <>
                          {switchBeforeMode}
                          <span
                            className={cn(
                              "inline-flex items-center gap-1",
                              modeTriggerColor(targetMode),
                            )}
                          >
                            <TargetIcon className="size-4" />
                            {modeLabel(targetMode)}
                          </span>
                          {switchAfterMode}
                        </>
                      )
                    ) : (
                      <>
                        {indexLabel}
                        <span className="min-w-0 flex flex-1 flex-col">
                          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                            <span className="inline-flex items-center gap-1 text-ui-base font-medium text-foreground">
                              {label}
                            </span>
                            {ruleScopes.length > 0 ? (
                              <InlinePermissionPrefixScopes scopes={ruleScopes} />
                            ) : description ? (
                              <span className="text-ui-base leading-4 text-foreground-subtle">
                                {description}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </>
                    )}
                  </button>
                );
                if (!switchRow) return button;
                // Bugfix: 模式菜单是独立按钮，不能嵌进提交按钮。旧实现的提交 button 只包住「3. 允许，并切换为」，
                // 外层 div 和它各画一层 bg-selected，叠出一块更亮的胶囊，hover 也只亮半行；说明另起一行。
                // 现在背景只由外层画，提交按钮用 after 覆盖整行作为点击区，菜单抬到覆盖层之上；
                // 序号、文案和说明沿用其他选项的两列布局，窄屏换行时说明与文案左对齐。
                return (
                  <div
                    key={option.optionId}
                    className={cn(
                      "relative flex w-full items-center gap-3 rounded-xl px-3 py-2 transition-colors",
                      isSelected ? "bg-selected" : "hover:bg-hover",
                      blocked && "opacity-50",
                    )}
                  >
                    {indexLabel}
                    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="inline-flex items-center gap-1">
                        {button}
                        {canPickMode && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={responding}
                                data-testid="permission-target-picker"
                                data-mode={targetMode}
                                aria-label={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
                                onKeyDown={(event) => {
                                  if (event.key === "Tab") {
                                    event.preventDefault();
                                    optionRefs.current[event.shiftKey ? index : index + 1]?.focus();
                                  }
                                }}
                                className={cn(
                                  "relative z-1 h-7 gap-1 rounded-lg px-2 text-ui-base",
                                  modeTriggerColor(targetMode),
                                )}
                              >
                                <TargetIcon className="size-4" />
                                {modeLabel(targetMode)}
                                <ChevronDownIcon className="size-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent side="top" align="start">
                              <DropdownMenuRadioGroup
                                value={targetMode}
                                onValueChange={(value) => {
                                  if (value === "guarded" || value === "yolo") {
                                    setPickedMode(value);
                                    // 菜单只选目标；底部确认键应提交本行，而不是先前高亮的允许一次。
                                    setSelectedIndex(index);
                                  }
                                }}
                              >
                                {(["guarded", "yolo"] as const).map((mode) => {
                                  const Icon = resolveModeOptionIcon(mode);
                                  return (
                                    <DropdownMenuRadioItem
                                      key={mode}
                                      value={mode}
                                      data-testid={`permission-target-${mode}`}
                                    >
                                      <span
                                        className={cn(
                                          "inline-flex items-center gap-1",
                                          modeTriggerColor(mode),
                                        )}
                                      >
                                        <Icon className="size-4" />
                                        {modeLabel(mode)}
                                      </span>
                                    </DropdownMenuRadioItem>
                                  );
                                })}
                              </DropdownMenuRadioGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </span>
                      <span className="text-ui-base leading-4 text-foreground-subtle">
                        {intl.formatMessage({ id: "chat.permission.switchProjectHint" })}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>

            {feedbackOption ? (
              <div
                onClick={(event) => {
                  if (event.target !== feedbackInputRef.current) {
                    feedbackInputRef.current?.focus();
                  }
                }}
                className={cn(
                  "flex w-full cursor-text items-center gap-3 rounded-xl px-3 py-2 transition-colors",
                  isFeedbackSelected ? "bg-selected" : "hover:bg-hover",
                )}
              >
                <span
                  className={cn(
                    // 匹配 textarea 的首行行高和 1px 边框；手机输入行高不同，但序号字号不变。
                    "mt-px w-5 shrink-0 self-start text-ui-base font-medium md:leading-relaxed",
                    avoidIosInputFocusZoom ? "leading-6" : "leading-5",
                    isFeedbackSelected ? "text-foreground" : "text-foreground-subtlest",
                  )}
                >
                  {feedbackIndex + 1}.
                </span>
                <Textarea
                  ref={feedbackInputRef}
                  rows={1}
                  wrap="soft"
                  value={feedback}
                  maxLength={MAX_PERMISSION_FEEDBACK_CHARS}
                  // Refine 行的文案按稳定 optionId 本地化：协议里的 name 是服务端英文兜底。
                  aria-label={intl.formatMessage({
                    id: refineOption
                      ? "chat.permission.workflow.refine"
                      : "chat.permission.feedback.ariaLabel",
                  })}
                  placeholder={intl.formatMessage({
                    id: refineOption
                      ? "chat.permission.workflow.refine.placeholder"
                      : "chat.permission.feedback.placeholder",
                  })}
                  data-permission-feedback-option={feedbackOption.optionId}
                  onFocus={() => {
                    feedbackInputFocusedRef.current = true;
                    setSelectedIndex(feedbackIndex);
                  }}
                  onBlur={() => {
                    feedbackInputFocusedRef.current = false;
                  }}
                  onChange={(event) => {
                    setFeedback(event.target.value);
                  }}
                  onCompositionStart={() => {
                    feedbackCompositionActiveRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    feedbackCompositionActiveRef.current = false;
                  }}
                  onKeyDown={handleFeedbackKeyDown}
                  className={cn(
                    // Bugfix: 拒绝反馈自动换行，但限制为 5 行并在输入框内滚动，避免窄屏遮住权限选项和确认按钮。
                    "h-auto !min-h-5 max-h-[5lh] min-w-0 max-w-full overflow-y-auto rounded-none border-transparent bg-transparent !px-0 !py-0 font-medium shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0",
                    resolveMobileInputTextSizeClassName({ avoidIosInputFocusZoom }),
                  )}
                />
              </div>
            ) : null}
          </div>

          {responseError ? (
            <p role="alert" className="shrink-0 text-ui-base text-destructive">
              {responseError}
            </p>
          ) : null}
          <div className="flex shrink-0 items-center justify-between gap-2 px-1">
            <p className="flex gap-2 text-ui-base items-center text-foreground-subtle">
              <Info className="text-foreground size-4 shrink-0" />
              {intl.formatMessage({ id: "chat.permission.keyboardHint" })}
            </p>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "common.confirm" })}
              size="lg"
              onClick={confirmSelection}
              disabled={
                responding ||
                (isFeedbackSelected
                  ? !feedback.trim()
                  : orderedOptions[selectedIndex] === undefined ||
                    isOptionBlocked(orderedOptions[selectedIndex]))
              }
              className="bg-brand text-foreground-inverse hover:bg-brand/80"
            >
              {intl.formatMessage({ id: "common.confirm" })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
