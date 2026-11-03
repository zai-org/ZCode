import type { SessionLifecycleSnapshot } from "@zcode/shared";
import {
  WorkspaceHookPendingIndicator,
  WorkspaceMcpPendingIndicator,
} from "@/v4/WorkspaceHookPendingBanner.js";
import { StoreContext } from "@/store/StoreProvider.js";
import { toTelemetryUiMode } from "@/lib/appTelemetry.js";
import { ComposerSubmissionPendingContext } from "@/project-sidebar/index.js";
/* oxlint-disable eslint(max-lines) -- composer 集中收口输入区 wiring（附件/草稿/历史/mention），拆分会打散收口粒度。 */
import { useRemoteProjectReconnect } from "@/hooks/RemoteProjectPresentationContext.js";
import { useOptionalRemoteWorkspaceController } from "@/remote/useRemoteWorkspaceController.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useRemoteConversationAvailable } from "@/v4/RemoteConversationAvailability.js";
import { getLocalTtftObserver } from "@/v4/telemetry/local-ttft/contract.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
/**
 * v4 会话 composer（composer parity）。
 *
 * 壳：ChatPromptEditor（Lexical 编辑器 + 动作菜单 + 拖拽反馈 + sticky 底座视觉），
 * 附件预览网格/大图预览/错误提示区一并提供。
 *
 * 芯：全新 v4 wiring——
 * - 路由/状态一律读 v4 投影 snapshot.inputRouting / control / config / usage；
 * - 发送键状态机对齐旧 UI：canSend（有文本或附件+路由允许）/ pending spinner /
 *   running+空草稿 → Stop（v4 stop 命令）/ 暂停队列（choice）→ 发送后弹清空/保留确认框；
 * - 附件全链路见 useComposerAttachments（发送经 v4 sendText attachments）；
 * - mention（@ 文件/画板、# 会话、$ 技能）与 slash 目录全集在 LexicalChatInput 内接线；
 * - 草稿 per-session 持久化（composerDraftStore）+ prompt history（promptHistoryStorage）；
 * - 工具条（模型/思考深度/模式/context usage）见 V4ComposerToolbar。
 */
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { HighspeedComposerBackground } from "@/highspeed/HighspeedActivationVisual.js";
import { useHighspeedComposerEntrance } from "@/highspeed/useHighspeedComposerEntrance.js";
import {
  type HighspeedCardSnapshot,
  type PlanIdentitySnapshot,
  type ZCodeProvider,
} from "@zcode/shared";
import {
  TID_CHAT_ATTACHMENT_BUTTON,
  TID_CHAT_ATTACHMENT_MENU_ITEM,
  TID_V4_COMPOSER,
  TID_V4_COMPOSER_CLEAR_QUEUE_SEND,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  TID_V4_COMPOSER_SEND,
  TID_V4_PAUSED_QUEUE_SEND_DIALOG,
  TID_V4_ATTACHMENT,
  TID_V4_ATTACHMENT_UPLOAD_PROGRESS,
  TID_V4_ATTACHMENT_UPLOAD_RETRY,
  TID_V4_STOP,
  testId,
} from "@zcode/shared/test-ids";
import type {
  AttachmentRef,
  ConversationSnapshot,
  SessionConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ArrowUpIcon,
  ClipboardPenLineIcon,
  InfoIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  ChatErrorBanner,
  resolveChatErrorBannerDisplayMessage,
  shouldSuppressChatErrorBanner,
  type ChatErrorBannerModelConfigTarget,
} from "@/ChatErrorBanner.js";
import {
  Attachment,
  Attachments,
  AttachmentInfo,
  AttachmentPreview,
} from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Spinner } from "@/components/ui/spinner.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { usePromptEditorDragState } from "@/prompt-editor/usePromptEditorDragState.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { advanceComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { runUserAction, startUserAction } from "@/lib/userActionTelemetry.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import {
  isImageChatComposerAttachment,
  isPdfChatComposerAttachment,
  isMediaChatComposerAttachment,
  isVideoChatComposerAttachment,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import { resolveChatPlaceholderKey } from "@/lib/chatPlaceholder.js";
import {
  resolveChatEnterShortcut,
  resolveChatEnterSubmits,
  shouldAvoidIosInputFocusZoom,
  useIsMobileTextInputViewport,
} from "@/lib/mobileTextInput.js";
import { appendPromptHistoryEntry } from "@/lib/promptHistory.js";
import {
  persistPromptHistoryEntries,
  readPromptHistoryEntries,
} from "@/lib/promptHistoryStorage.js";
import {
  WORKSPACE_FILE_ADD_TO_CHAT_EVENT,
  readWorkspaceFileDragPayload,
  isWorkspaceFileAddToChatEvent,
} from "@/lib/workspaceFileDrag.js";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";
import { resolveProviderBaseURL } from "@/lib/registryProviderView.js";
import type { ModelSelectionView } from "@zcode/services";
import type {
  ModelSelectionState,
  ModelSelectionRefreshResult,
} from "@/hooks/useModelSelectionView.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import {
  resolveComposerAutoFocus,
  type ComposerAutoFocusOptions,
} from "@/v4/composer/composerAutoFocus.js";
import type {
  ComposerDraftContent,
  ComposerSubmissionDraftTransaction,
} from "@/v4/composer/useDraftConfigControl.js";
import { V4_DRAFT_SCOPE_ROOT, type V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import {
  resolveOppositeFollowupDelivery,
  resolveFollowupModifierTooltip,
  shouldEnableModifiedEnterSubmit,
  shouldReverseFollowupDeliveryForPointer,
} from "@/v4/composer/followupModeSettings.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { usePrimaryFollowupModifier } from "@/v4/composer/usePrimaryFollowupModifier.js";
import {
  consumeV4ComposerDraftAttachments,
  registerV4ComposerDraftReader,
  consumeV4ComposerDraftWorkspaceTransferRequest,
} from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { useComposerAttachments } from "@/v4/composer/useComposerAttachments.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import { removeCodeCommentPreview } from "@/v4/composer/codeCommentPreviewSync.js";
import {
  countComposerPromptContexts,
  serializeComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import { useCodeCommentContexts } from "@/v4/composer/useCodeCommentContexts.js";
import { useWebElementContexts } from "@/v4/composer/useWebElementContexts.js";
import {
  PluginUiModelContextChip,
  usePluginUiContextImages,
  usePluginUiModelContexts,
} from "@/plugin-ui/index.js";
import { usePptxElementReferences } from "@/v4/composer/usePptxElementReferences.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { useConversationSelectionReferences } from "@/v4/composer/useConversationSelectionReferences.js";
import { ConversationBackgroundWorkTrigger } from "@/v4/composer/ConversationBackgroundWorkTrigger.js";
import { V4ComposerCuaEntry } from "@/v4/composer/V4ComposerCuaEntry.js";
import {
  V4ComposerModeSwitch,
  V4ComposerModelControls,
  type ModelSelectionSource,
} from "@/v4/composer/V4ComposerToolbar.js";
import {
  resolveV4ComposerConfigPickerState,
  type V4ComposerConfigPicker,
} from "@/v4/composer/configPickerState.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import type { AttachmentPutFn } from "@/v4/composer/attachmentUpload.js";
import { useScopedConversationTelemetrySupervisor } from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { buildV4ConversationPromptTelemetryExtraDetail } from "@/v4/telemetry/conversationPromptTelemetry.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import {
  subscribeComposerSubmissionSettled,
  trackUnsettledComposerSubmission,
} from "@/v4/composer/composerSubmissionSettlement.js";
import { resolveAttachableShareContext } from "@/lib/conversationShareContext.js";

const MODEL_SELECTION_LOADING_STATE: ModelSelectionState = { status: "loading" };

export interface ConversationComposerSendOptions {
  /** 原始正文供接纳恢复对账；协议正文可能已经附加文件或页面上下文。 */
  submittedDraftText?: string;
  /** 点击发送时复制的配置；null 表示未完成选择，Host 不得从 Session 补齐。 */
  submission?: ComposerSubmissionConfig | null;
  heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
  /** 发送确认框打开时看到的暂停队列 ID；CLI 用它拦截跨端增删竞态。 */
  expectedHeldQueueItemIds?: readonly string[];
  /** 附件命令面：已序列化附件（宿主转 AttachmentRef 后随 v4 sendText/createSession 发送）。 */
  attachments?: AttachmentRef[];
  /** Prompt 文本内携带的上下文附件数量；用于阻止 /goal 等本地命令误消费。 */
  contextAttachmentCount?: number;
  conversationQuotes?: import("@zcode/shared").ConversationSelectionText[];
  /** renderer-only：ACK accepted 后由 SessionPane 绑定真实 commandId/sessionId。 */
  telemetrySeed?: ConversationPromptTelemetrySeed;
  /** 本次 busy input 的一次性投递覆盖，不改 session 偏好。 */
  requestedDelivery?: "startNow" | "queue" | "guide";
  /** 提交命令创建后由 Composer 订阅权威 projection，覆盖 ACK 丢失后的收口。 */
  onCommandCreated?: (commandId: string) => void;
  sharedContextRefs?: Array<{ kind: "shared_context_import"; context_id: string }>;
  /** 插件 UI 代发：随 sendText 持久化，用户消息卡片显示"来自插件 X"。 */
  source?: import("@zcode/shared/zcode-protocol-v4").ConversationInputSource;
}

export type ConversationComposerSendResult = "sent" | "blocked" | "confirmationRequired";
function getComposerAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

export interface ExternalTextInsertRequest {
  requestId: number;
  text: string;
  mention?: ComposerMentionPrefill;
  mode?: "replace" | "prepend-if-missing";
}

export function restorePersistedComposerDraftIntoInput({
  draft,
  inputApi,
  onEditorStateError,
}: {
  draft: Pick<V4ComposerDraft, "editorStateJson" | "mention" | "text">;
  inputApi: Pick<
    LexicalChatInputHandle,
    "getMarkdown" | "setEditorStateJson" | "setMention" | "setText"
  >;
  onEditorStateError?: (error: unknown) => void;
}): string {
  if (draft.editorStateJson) {
    try {
      inputApi.setEditorStateJson(draft.editorStateJson);
      return inputApi.getMarkdown();
    } catch (error) {
      onEditorStateError?.(error);
    }
  }
  if (draft.mention && draft.text.startsWith(draft.mention.markdown)) {
    // Workspace 插件详情会卸载聊天 Composer。结构化 mention 必须从共享草稿事实源恢复，
    // 不能只依赖一次性插入事件，否则重挂载时会退化成 canonical 普通文本。
    inputApi.setMention(draft.mention, draft.text.slice(draft.mention.markdown.length));
    return draft.text;
  }
  inputApi.setText(draft.text);
  return draft.text;
}

export function applyExternalTextInsertRequestToComposer({
  appliedRequestId,
  inputApi,
  request,
  requestFocus,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  inputApi: Pick<
    LexicalChatInputHandle,
    | "getMarkdown"
    | "prependMentionIfMissing"
    | "setMention"
    | "setText"
    | "setTextWithPluginMentions"
  > | null;
  request: ExternalTextInsertRequest | null | undefined;
  requestFocus: () => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (!inputApi) {
    return appliedRequestId;
  }
  if (request.mode === "prepend-if-missing" && request.mention) {
    if (!inputApi.prependMentionIfMissing(request.mention)) {
      return request.requestId;
    }
    // Bug 原因：安装完成后若回放点击时保存的旧 prompt，会覆盖用户安装期间的编辑。
    // 节点级前置保留编辑器当前的 mention 与段落结构，再从编辑器读取 canonical 草稿。
    updateText(inputApi.getMarkdown());
    scheduleDraftPersist();
    requestFocus();
    return request.requestId;
  }
  if (request.mention && request.text.startsWith(request.mention.markdown)) {
    // 根因：商店试用以前只传 canonical 文本，Lexical 无法知道开头链接是结构化 Plugin mention。
    // request 同时携带 display-only 节点数据；发送与草稿事实源仍使用 request.text 原文。
    inputApi.setMention(request.mention, request.text.slice(request.mention.markdown.length));
  } else if (request.text.includes("](plugin://")) {
    // 推荐任务可在正文中组合多个插件；按原位置构造成真实提及节点。
    inputApi.setTextWithPluginMentions(request.text);
  } else {
    inputApi.setText(request.text);
  }
  updateText(request.text);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}

export interface ComposerRestoreRequest {
  requestId: number;
  sessionId: string;
  workspaceKey: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: Pick<V4ComposerDraft, "mode" | "planEnabled" | "modelSelection">;
}

export function applyComposerRestoreRequestToComposer({
  appliedRequestId,
  currentSessionId,
  currentWorkspaceKey,
  hasDraftContent,
  inputApi,
  request,
  requestFocus,
  restoreSessionOwnedAttachments,
  restoreDraftConfig,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  currentSessionId: string | null;
  currentWorkspaceKey: string;
  hasDraftContent: boolean;
  inputApi: Pick<LexicalChatInputHandle, "setText"> | null;
  request: ComposerRestoreRequest | null | undefined;
  requestFocus: () => void;
  restoreSessionOwnedAttachments: (attachments: readonly AttachmentRef[]) => boolean;
  restoreDraftConfig?: (config: NonNullable<ComposerRestoreRequest["config"]>) => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (
    request.sessionId !== currentSessionId ||
    request.workspaceKey !== currentWorkspaceKey ||
    hasDraftContent ||
    !inputApi
  ) {
    return appliedRequestId;
  }
  if (!restoreSessionOwnedAttachments(request.attachments)) {
    return appliedRequestId;
  }
  inputApi.setText(request.text);
  updateText(request.text);
  if (request.config) restoreDraftConfig?.(request.config);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}

function arePromptHistoryEntriesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export interface ConversationComposerProps {
  snapshot: ConversationSnapshot | null;
  /** 真实命令已发出、权威输入投影尚未接管；直接消费 projection store，不另存展示状态。 */
  inputPending?: boolean;
  /** 草稿 scope（sessionId；draft 态 null → "__draft__" scope）。 */
  lifecycle?: SessionLifecycleSnapshot;
  sessionId?: string | null;
  /** Skill catalog authority；草稿预热完成后为 prewarmSessionId，不改变 task/draft 身份。 */
  skillCatalogSessionId?: string | null;
  pluginUiSessionId?: string | null;
  /** draft 态无 snapshot，但仍可 createSession 首发。 */
  draftMode?: boolean;
  /** renderer 当前草稿配置意图；只在 draftMode 下覆盖迟到的 prewarm projection。 */
  draftConfig?: Partial<SessionConfigState>;
  /** SessionPane 注入的完整 Draft owner；生产路径不再由编辑器直接覆盖持久记录。 */
  composerDraft: V4ComposerDraft;
  rootDraftScopeKey?: string;
  /** 当前草稿 scope incarnation；A₁→B→A₂ 时 token 不复用。 */
  composerDraftScopeToken: symbol;
  /** 输入热路径只暂存当前 scope 正文，不触发父级 render 或同步写盘。 */
  stageComposerContent: (content: ComposerDraftContent) => void;
  /** effect setup 捕获一次性生命周期收口；切换后仍只写回对应旧 scope。 */
  captureComposerContentLifecycleCommit: () => (content: ComposerDraftContent) => void;
  captureComposerSubmissionDraftTransaction: (
    content: ComposerDraftContent,
  ) => ComposerSubmissionDraftTransaction;
  persistComposerContent: (content: ComposerDraftContent) => void;
  updateComposerContent: (content: ComposerDraftContent) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 当前 Composer 是否能构造完整 Submission；空模型或空 Reasoning 时为 false。 */
  submissionReady?: boolean;
  createSubmissionFromComposer?: () => ComposerSubmissionConfig | null;
  /** 仅供发送埋点冻结模型维度；包含草稿初始化 config 与显式 intent 的合并值。 */
  telemetryDraftConfig?: Partial<SessionConfigState>;
  /**
   * 空态 contextHeader（m5-composer-parity）：workspace 切换菜单 + Git 分支
   * 切换器，渲染在编辑器上方（旧 ChatViewComposer contextHeaderContent 同位）。
   * 仅草稿态由宿主下发；会话建立后为空。
   */
  contextHeader?: ReactNode;
  /** 居中草稿布局（旧 shouldUseCenteredDraftChatLayout）：收窄 max-w-2xl、去 sticky。 */
  centered?: boolean;
  /** 输入框布局，见 ChatPromptEditor；inline 是 Side Pane 完整视图浮窗的单行形态。 */
  layout?: "stacked" | "inline";
  /**
   * 单行布局下对话运行中的工作时长（与流式消息「工作中 N 秒」同值），
   * 占位文字改为「工作中 {时长}」；undefined 时沿用原占位。
   */
  workingDurationMs?: number;
  /**
   * v4 bottom dock 阻塞交互 id。存在时 composer 只隐藏不卸载，保留草稿、附件与编辑器实例。
   */
  blockingRequestId?: string | null;
  disabled?: boolean;
  onRetryInitialization?: () => void;
  onRetryError?: () => void;
  /** 当前 Task 可用的 Highspeed 卡；只影响静态标识和模型锁定。 */
  highspeedCard?: HighspeedCardSnapshot | null;
  /**
   * 发送路径 draw 新命中登记的一次性激活请求（值为 cardId）。
   * 命中当前卡时才播放激活动效，composer 锁定入场方式后经回调消费；切回、恢复与重挂载不重播。
   */
  highspeedActivationCardId?: string | null;
  onHighspeedActivationApplied?: (cardId: string) => void;
  /**
   * 是否在新建任务 / 切换会话 / 挂载后自动把光标聚焦到输入框（默认开）。
   * 竖切多 pane 时由宿主传入 SessionPane.focused，仅焦点 pane 聚焦、后台 pane 不抢焦点。
   */
  autoFocusEnabled?: boolean;
  /** 当前 composer 是否运行在手机 Web 远控壳中。 */
  isWebRemoteControl?: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** SessionPane 从目标 Host 原子读取的选择事实；Composer 不自行解析 Host。 */
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionState?: ModelSelectionState;
  /** Model Selection 首次读取失败后的显式重试入口。 */
  modelSelectionReload?: () => void;
  modelSelectionRefresh?: () => Promise<ModelSelectionRefreshResult>;
  /** 草稿态使用预热 session 作附件 transaction 载体。 */
  attachmentSessionId?: string | null;
  attachmentPut: AttachmentPutFn;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /** 承载 transport 暴露 runtime 存活态时优先用它，替代 onRuntimeRestart。 */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  provider?: ZCodeProvider;
  /** 宿主 pane 与 workspace 遮罩共同裁决的真实可见性，仅用于 visible-only telemetry。 */
  telemetryVisible?: boolean;
  /** 点击发送时读取套餐身份；二次确认会继续复用同一份冻结 seed。 */
  readPlanIdentitySnapshot?: () => PlanIdentitySnapshot;
  onSendText: (
    text: string,
    options?: ConversationComposerSendOptions,
  ) => Promise<ConversationComposerSendResult | void>;
  /** 把当前输入文本上抛给父组件（editUserQuery 用 composer 文本作 newText）。 */
  onTextChange?: (text: string) => void;
  /** queue 撤回 admission 读取的完整 composer 占用态；附件包含上传中状态。 */
  onDraftStateChange?: (state: { hasContent: boolean; busy: boolean }) => void;
  onStop: () => void;
  /** 目录选中模型（providerId/modelId）；thought/revision 由宿主从最新投影补齐。 */
  onSelectModel: (
    provider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
    reasoningLevel?: string,
  ) => void;
  /** 选中思考深度；同时带上用户操作时看到的模型，避免异步回流后把 thought 归到另一模型。 */
  onSelectThought: (thought: string, modelContext: { provider: string; model: string }) => void;
  onSwitchMode: (mode: string) => void;
  /** 打开当前 session 的 Status panel，并直达 Running 明细。 */
  onOpenRunningBackgroundWorks?: () => void;
  /**
   * 后台任务入口点击的落点：`"workflow-run"` = 唯一在跑的工作流直达详情页（宿主判定），
   * 缺省 `"panel"` = 展开状态胶囊。入口据此换 tooltip；行为本身在 onOpenRunningBackgroundWorks 里。
   */
  backgroundWorkOpenTarget?: "panel" | "workflow-run";
  runningSubagentCount?: number;
  /** prepare/configOptions 失败时，custom provider 选择走 workspace recovery 链。 */
  onRecoverCustomModelSelection?: (
    value: string,
    sourceModel: ModelSelectionSource | null,
  ) => Promise<void> | void;
  /** context usage 面板的 /compact 入口（宿主走 v4 compact 命令）。 */
  onSendCompressionCommand?: (command: string) => void;
  /** v4 会话级错误（snapshot.control.lastError），展示在输入框上方。 */
  error?: ZCodeUiError | null;
  onDismissError?: () => void;
  /** 无可用模型横幅的恢复动作；由 SessionPane 注入壳层导航，组件不直接操作 tab。 */
  onOpenModelSettings?: () => void;
  onOpenModelUpgrade?: () => void;
  modelConfigTarget?: ChatErrorBannerModelConfigTarget;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /**
   * 是否监听全局「加入对话」事件（workspace file tree / 画板按钮）。
   * 分屏时仅 primary pane 监听，避免一次点击插入两份。
   */
  listenAddToChatEvents?: boolean;
  /**
   * 外部一次性文本预填请求（Example Prompt 等）。
   * requestId 保证同一文本可连续取回两次时仍能触发回填。
   */
  externalTextInsertRequest?: ExternalTextInsertRequest | null;
  onExternalTextInsertApplied?: (requestId: number) => void;
  /**
   * 队列“编辑”在 delete ACK 后把完整未来意图取回输入框。
   * requestId + session/workspace binding 保证幂等且不会串写其他 task。
   */
  composerRestoreRequest?: ComposerRestoreRequest | null;
  onComposerRestoreApplied?: (requestId: number) => void;
  /** 副屏会话不提供 goal 能力；协议层仍会拒绝直接调用。 */
  suppressGoalCommands?: boolean;
  /** App 层本地斜杠命令（如 `/side`），由 SessionPane 按门禁组装后透传。 */
  appSlashCommands?: readonly AppSlashCommand[];
  /** 把 composer 的 drop 路由暴露给整个对话 pane / 桌面草稿标题栏。 */
  onDropTargetControllerChange?: (controller: ConversationDropTargetController | null) => void;
}

function formatAttachmentLineCount(attachment: ChatComposerAttachment, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return formatter.format(typeof attachment.lineCount === "number" ? attachment.lineCount : 0);
}

function ConversationComposerImpl({
  snapshot,
  inputPending = false,
  lifecycle,
  sessionId = null,
  skillCatalogSessionId = sessionId,
  pluginUiSessionId = sessionId,
  draftMode = false,
  draftConfig,
  composerDraft,
  composerDraftScopeToken,
  rootDraftScopeKey,
  stageComposerContent,
  captureComposerContentLifecycleCommit,
  captureComposerSubmissionDraftTransaction,
  updateComposerContent,
  persistComposerContent,
  replaceComposerDraft,
  submissionReady = true,
  createSubmissionFromComposer,
  telemetryDraftConfig,
  contextHeader,
  centered = false,
  layout = "stacked",
  workingDurationMs,
  blockingRequestId = null,
  disabled: disabledProp = false,
  onRetryInitialization,
  onRetryError,
  highspeedCard = null,
  highspeedActivationCardId = null,
  onHighspeedActivationApplied,
  autoFocusEnabled = true,
  isWebRemoteControl = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  modelSelectionView = null,
  modelSelectionState = MODEL_SELECTION_LOADING_STATE,
  modelSelectionReload,
  modelSelectionRefresh,
  attachmentSessionId = null,
  attachmentPut,
  onRuntimeRestart,
  onRuntimeLifecycle,
  provider,
  telemetryVisible = true,
  readPlanIdentitySnapshot,
  onSendText,
  onTextChange,
  onDraftStateChange,
  onStop,
  onSelectModel,
  onSelectThought,
  onSwitchMode,
  onOpenRunningBackgroundWorks,
  backgroundWorkOpenTarget = "panel",
  runningSubagentCount = 0,
  onRecoverCustomModelSelection,
  onSendCompressionCommand,
  error,
  onDismissError,
  onOpenModelSettings,
  onOpenModelUpgrade,
  modelConfigTarget = "local",
  onOpenCodeViewer,
  listenAddToChatEvents = true,
  externalTextInsertRequest = null,
  onExternalTextInsertApplied,
  composerRestoreRequest = null,
  onComposerRestoreApplied,
  suppressGoalCommands = false,
  appSlashCommands,
  onDropTargetControllerChange,
}: ConversationComposerProps) {
  const remoteAvailable = useRemoteConversationAvailable();
  const remoteController = useOptionalRemoteWorkspaceController();
  const reconnectProject = useRemoteProjectReconnect();
  const remoteKind = useOptionalTabStore((state) =>
    state.tabs.find(
      (tab) =>
        tab.kind === "workspace" &&
        (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
          (workspaceIdentity?.trim() || workspacePath),
    ),
  );
  const [targetSelectionPending, setTargetSelectionPending] = useState(false);
  const targetSelectionPendingRef = useRef(false);
  const updateTargetSelectionPending = useCallback((pending: boolean) => {
    targetSelectionPendingRef.current = pending;
    setTargetSelectionPending(pending);
  }, []);
  const disabled = disabledProp || !remoteAvailable || targetSelectionPending;
  const { intl, locale } = useZCodeIntl();
  const services = useOptionalServices();
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const draftScopeId =
    sessionId ??
    (rootDraftScopeKey ? `${V4_DRAFT_SCOPE_ROOT}:${rootDraftScopeKey}` : V4_DRAFT_SCOPE_ROOT);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const configPickerScopeKey = `${workspaceKey}\0${draftScopeId}`;
  const [reloadText, setReloadText] = useState(false);
  const reloadTextRef = useRef(false);
  const [textPresence, setTextPresence] = useState({ raw: false, trimmed: false });
  const textPresenceRef = useRef(textPresence);
  textPresenceRef.current = textPresence;
  const [pending, setPending] = useState(false);
  const [presentedHighspeedCardId, setPresentedHighspeedCardId] = useState<string | null>(null);
  const [highspeedSweepActive, setHighspeedSweepActive] = useState(false);
  const highspeedCardId = highspeedCard?.cardId ?? null;
  const highspeedEntrance = useHighspeedComposerEntrance({
    cardId: highspeedCardId,
    activationCardId: highspeedActivationCardId,
    onActivationApplied: onHighspeedActivationApplied,
  });
  const highspeedEntranceAnimated = highspeedEntrance === "activation";
  // 恢复入场（切回 Task、快照恢复、重挂载）不经扩散交接，卡片出现即呈现模型与倒计时。
  const highspeedPresented =
    highspeedCardId !== null &&
    (!highspeedEntranceAnimated || presentedHighspeedCardId === highspeedCardId);
  const handleHighspeedModelTransitionStart = useCallback(() => {
    // 只记录已完成视觉交接的卡片身份，不改变卡片有效性或发送状态。
    setPresentedHighspeedCardId(highspeedCardId);
  }, [highspeedCardId]);
  useEffect(() => {
    // 扫光属于激活动效，只在 draw 新命中的交接后播放一次。
    if (!highspeedPresented || !highspeedEntranceAnimated) {
      setHighspeedSweepActive(false);
      return;
    }
    const timer = window.setTimeout(() => setHighspeedSweepActive(true), 1_900);
    return () => window.clearTimeout(timer);
  }, [highspeedEntranceAnimated, highspeedPresented]);
  const [configPickerState, setConfigPickerState] = useState<{
    scopeKey: string;
    activePicker: V4ComposerConfigPicker | null;
  }>(() => ({
    scopeKey: configPickerScopeKey,
    activePicker: null,
  }));
  // 固定 key 的 SessionPane 会跨 task/draft 复用 composer，旧 picker owner
  // 因此跟着实例进入新 scope。提交新 scope portal 前同步归零，避免菜单闪现一帧；
  // 旧 Radix layer 随后到达的 close 事件由下方 scope guard 丢弃。
  if (configPickerState.scopeKey !== configPickerScopeKey) {
    setConfigPickerState({
      scopeKey: configPickerScopeKey,
      activePicker: null,
    });
  }
  const activeConfigPicker =
    configPickerState.scopeKey === configPickerScopeKey ? configPickerState.activePicker : null;
  const handleConfigPickerOpenChange = useCallback(
    (picker: V4ComposerConfigPicker, open: boolean) => {
      // composer 内容为导航 rail 恢复 pointer-events 后，三个 Radix modal
      // picker 的独立 open 状态会在同一次 pointerdown 中竞争，旧 layer 无法可靠 dismiss。
      // 关闭回调可能晚于兄弟 picker 的打开回调，只允许它清理自己，避免误关接管者。
      setConfigPickerState((current) => {
        if (current.scopeKey !== configPickerScopeKey) {
          return current;
        }
        return {
          scopeKey: current.scopeKey,
          activePicker: resolveV4ComposerConfigPickerState(current.activePicker, picker, open),
        };
      });
    },
    [configPickerScopeKey],
  );
  const [heldQueueConfirmation, setHeldQueueConfirmation] = useState<{
    queueItemIds: readonly string[];
    telemetrySeed: ConversationPromptTelemetrySeed;
    requestedDelivery?: "startNow" | "queue" | "guide";
  } | null>(null);
  const [sendTooltipOpen, setSendTooltipOpen] = useState(false);
  // submit 经 ref 读取最新文本/pending，避免回调随每次输入变更引用。
  const textRef = useRef("");
  const contentRevisionRef = useRef(0);
  const pendingRef = useRef(false);
  const uiStore = useContext(StoreContext);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  // 这条线断过一次：composer 原本读一个平行的 sharedContextImport prop，而 SessionPane 从没
  // 传过它（全仓 `sharedContextImport=` 零命中），于是首条消息永远不带 sharedContextRefs。
  // 现在从必然拿到的 snapshot 推导，理由与边界见 resolveAttachableShareContext。
  const activeShareContext = resolveAttachableShareContext(snapshot?.sharedContextImport);
  const pendingShareContext = activeShareContext?.status === "pending" ? activeShareContext : null;
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const commandResolutionCleanupsRef = useRef(new Set<() => void>());
  const reportedErrorKeysRef = useRef(new Set<string>());
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  const primaryModifierPressed = usePrimaryFollowupModifier();
  const appleKeyboardPlatform = isAppleKeyboardPlatform();
  // Bugfix：M3 删除旧 ChatView 后，M5 只恢复了桌面端的 false 硬编码，已登记的手机远控
  // 接线没有补回，导致 Enter 误发送。恢复旧语义：手机视口下 Enter 换行并用按钮发送；
  // 桌面端仍由 resolveChatEnterSubmits 的视口门禁保持 Enter 发送。
  const enterSubmits = resolveChatEnterSubmits({
    isMobileTextInputViewport,
    preferEnterNewline: isWebRemoteControl,
  });
  // 修复原因：旧 ChatView 删除后，iOS 防聚焦放大的接线没有迁到 v4 composer，
  // 手机 Web 远控输入框会重新触发 Safari 的页面缩放。
  const avoidIosInputFocusZoom = shouldAvoidIosInputFocusZoom({
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  // Bugfix：手机远控把完整能力说明放进绝对定位 placeholder 后，三行英文会越过
  // 40px 编辑区并覆盖工具栏。手机端改用短文案并限制两行；桌面端继续保留完整提示。
  const compactMobilePlaceholder = isWebRemoteControl && isMobileTextInputViewport;
  const sendShortcut = resolveChatEnterShortcut({ enterSubmits });
  const updateText = useCallback(
    (next: string) => {
      textRef.current = next;
      const reload = next.trim() === "/reload";
      if (reloadTextRef.current !== reload) {
        reloadTextRef.current = reload;
        setReloadText(reload);
      }
      contentRevisionRef.current += 1;
      advanceComposerDraftRevision(workspacePath, workspaceIdentity);
      const nextPresence = { raw: next.length > 0, trimmed: next.trim().length > 0 };
      const currentPresence = textPresenceRef.current;
      if (
        currentPresence.raw !== nextPresence.raw ||
        currentPresence.trimmed !== nextPresence.trimmed
      ) {
        textPresenceRef.current = nextPresence;
        setTextPresence(nextPresence);
      }
      onTextChange?.(next);
    },
    [onTextChange, workspaceIdentity, workspacePath],
  );

  const initialization = snapshot?.runtimeInitialization;
  const runtimeBlocked =
    (initialization !== undefined && initialization.status !== "ready") ||
    (lifecycle !== undefined && lifecycle.state !== "ready");

  // ── 附件全链路（选择/粘贴/拖拽/画板/预传/门禁）──
  const attachmentsApi = useComposerAttachments({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeId: draftScopeId,
    attachmentSessionId,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    disabled: disabled || runtimeBlocked,
    listenAddToChatEvents: listenAddToChatEvents && !disabled && !runtimeBlocked,
  });
  // 对齐旧版 useChatComposer：窗口级 dragover 会在指针进入 ChatView 前预先点亮
  // 整个聊天区与桌面草稿标题栏；workspace payload 的文案优先于系统附件。
  const { externalFileDragging, workspaceFileDragging } = usePromptEditorDragState({
    enableExternalFileDrop: true,
    enableWorkspaceFileDrop: true,
  });
  const handleConversationDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      attachmentsApi.handleDragOverComposer(event);
    },
    [attachmentsApi.handleDragOverComposer],
  );
  const handleConversationDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      attachmentsApi.handleDragLeaveComposer(event);
    },
    [attachmentsApi.handleDragLeaveComposer],
  );
  const handleConversationDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const workspaceFilePayload = readWorkspaceFileDragPayload(event.dataTransfer);
      if (workspaceFilePayload) {
        // 文件树 payload 与 OS File[] 语义不同：只插入 mention，绝不能进入上传队列。
        event.preventDefault();
        attachmentsApi.handleDropComposer(event);
        appendWorkspaceFileMentionToComposer({
          inputApiRef,
          currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
          payload: workspaceFilePayload,
          workspacePath,
          workspaceIdentity,
          onTextChange: updateText,
        });
        return;
      }
      attachmentsApi.handleDropComposer(event);
    },
    [attachmentsApi.handleDropComposer, updateText, workspaceIdentity, workspacePath],
  );
  const conversationDragKind = workspaceFileDragging
    ? "workspace"
    : externalFileDragging
      ? "attachment"
      : (attachmentsApi.composerDragKind ??
        (attachmentsApi.isDraggingOverComposer ? "attachment" : null));
  const dropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: conversationDragKind !== null,
      kind: conversationDragKind,
      onDragOver: handleConversationDragOver,
      onDragLeave: handleConversationDragLeave,
      onDrop: handleConversationDrop,
    }),
    [
      conversationDragKind,
      handleConversationDragLeave,
      handleConversationDragOver,
      handleConversationDrop,
    ],
  );
  useEffect(() => {
    onDropTargetControllerChange?.(dropTargetController);
    return () => onDropTargetControllerChange?.(null);
  }, [dropTargetController, onDropTargetControllerChange]);
  const [attachmentPreviewIndex, setAttachmentPreviewIndex] = useState(0);
  const [attachmentPreviewOpen, setAttachmentPreviewOpen] = useState(false);
  const [pdfAttachmentPreview, setPdfAttachmentPreview] =
    useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfAttachmentPreviewOpen, setPdfAttachmentPreviewOpen] = useState(false);
  const attachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });
  const videoAttachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  const hasAttachments = attachmentsApi.hasAttachments;
  const {
    contexts: webElementContexts,
    hasContexts: hasWebElementContexts,
    removeContext: removeWebElementContext,
    clearContexts: clearWebElementContexts,
  } = useWebElementContexts({
    workspacePath,
    workspaceIdentity,
    // queue 撤回等待 ACK 时 composer 处于 disabled；此时也要阻止全局 add-to-chat
    // 写入网页上下文，避免权威删除成功后撞上 ACK 窗口内的新草稿。
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  // 插件 UI 经 ui/update-model-context 附加的上下文；按 sessionId 接收，随发送清空。
  const {
    contexts: pluginUiContexts,
    hasContexts: hasPluginUiContexts,
    removeContext: removePluginUiContext,
    clearContexts: clearPluginUiContexts,
  } = usePluginUiModelContexts({ sessionId: pluginUiSessionId, workspacePath, workspaceIdentity });
  // 上下文里的 image 块 → 本 composer 的图片附件，随下一回合发送。
  usePluginUiContextImages(pluginUiContexts, attachmentsApi);
  const {
    references: pptxElementReferences,
    hasReferences: hasPptxElementReferences,
    removeReference: removePptxElementReference,
    clearReferences: clearPptxElementReferences,
  } = usePptxElementReferences({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onOpenCodeViewer,
  });
  const {
    references: conversationSelectionReferences,
    limitReason: conversationSelectionLimitReason,
    removeReference: removeConversationSelectionReference,
    clearReferences: clearConversationSelectionReferences,
  } = useConversationSelectionReferences({
    sessionId,
    workspaceKey,
    draftScopeKey: rootDraftScopeKey,
  });
  const hasConversationSelectionReferences = conversationSelectionReferences.length > 0;

  // ── 草稿 per-session 持久化（切会话/刷新不丢；mention pill 经 editorStateJson 保真）──
  const draftScopeRef = useRef(draftScopeId);
  const draftTargetRef = useRef({
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
    scopeToken: composerDraftScopeToken,
  });
  const ownerDraftRef = useRef({
    draft: composerDraft,
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
  });
  const draftPersistTimerRef = useRef<number | null>(null);
  const activeSubmissionDraftTransactionRef = useRef<ComposerSubmissionDraftTransaction | null>(
    null,
  );

  const snapshotDraftOfEditor = useCallback((): {
    text: string;
    editorStateJson?: string;
  } => {
    let currentText = textRef.current;
    let editorStateJson: string | undefined;
    try {
      const inputApi = inputApiRef.current;
      const editorState = inputApi?.getEditorState();
      if (inputApi && editorState) {
        // Bug 根因：IME 候选阶段不向 React 发布正文，textRef 会暂时落后于 Lexical。
        // 生命周期 flush 必须直接读取编辑器事实，否则 compositionend 前切任务或关窗会丢草稿。
        currentText = inputApi.getMarkdown();
        editorStateJson = JSON.stringify(editorState.toJSON());
      }
    } catch (error) {
      logger.warn(`[v4-composer] 草稿 editorState 序列化失败: ${String(error)}`);
    }
    return currentText.trim()
      ? { text: currentText, ...(editorStateJson ? { editorStateJson } : {}) }
      : { text: "" };
  }, []);

  useEffect(() => {
    // 新建 scope 已包含项目身份；不能只匹配旧的裸 __draft__ 而漏掉当前编辑器。
    if (!draftScopeId.startsWith(V4_DRAFT_SCOPE_ROOT)) return;
    return registerV4ComposerDraftReader(workspaceKey, () => ({
      draft: { ...ownerDraftRef.current.draft, ...snapshotDraftOfEditor() },
      attachments: attachmentsApi.attachments,
    }));
  }, [draftScopeId, workspaceKey, snapshotDraftOfEditor, attachmentsApi.attachments]);

  const persistDraftNow = useCallback(
    (scopeId: string) => {
      if (activeSubmissionDraftTransactionRef.current?.matchesTarget(composerDraftScopeToken)) {
        return;
      }
      const content = snapshotDraftOfEditor();
      if (scopeId === draftScopeRef.current) {
        persistComposerContent(content);
        return;
      }
    },
    [composerDraftScopeToken, snapshotDraftOfEditor, persistComposerContent],
  );

  const scheduleDraftPersist = useCallback(() => {
    if (typeof window === "undefined") return;
    stageComposerContent({ text: textRef.current });
    if (draftPersistTimerRef.current !== null) {
      window.clearTimeout(draftPersistTimerRef.current);
    }
    draftPersistTimerRef.current = window.setTimeout(() => {
      draftPersistTimerRef.current = null;
      persistDraftNow(draftScopeRef.current);
    }, 350);
  }, [persistDraftNow, stageComposerContent]);

  // ── 自动聚焦（新建任务 / 切会话 / 挂载后把光标交还输入框）──
  // 触发源：startDraft 递增的 draftFocusVersion（覆盖 Cmd/Ctrl+N 与所有「新建任务」入口）、
  // sessionId→draftScopeId 变化（切会话/切草稿）、以及挂载。三者置位聚焦意图；因切到需
  // 连接的会话时 composer 短暂 disabled，聚焦意图暂存，待可编辑时兑现一次。
  const draftFocusVersion = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspacePath, workspaceIdentity).draftFocusVersion,
  );
  useEffect(() => {
    if (!draftScopeId.startsWith(V4_DRAFT_SCOPE_ROOT)) return;
    const attachments = consumeV4ComposerDraftAttachments(workspaceKey, draftFocusVersion);
    if (attachments) attachmentsApi.restoreDraftAttachments(attachments);
  }, [draftFocusVersion, draftScopeId, workspaceKey, attachmentsApi.restoreDraftAttachments]);
  const pendingFocusRef = useRef(false);
  // 本次 focus 是否由程序触发（见 flushPendingFocus），供 send_input_focus 过滤非用户动作。
  const programmaticFocusRef = useRef(false);
  // 发送键与 Enter 共用同一个 form submit；按钮 onClick 早于 submit 触发，
  // 借此区分 send_click 的 send_trigger，读取后立刻复位回默认的 shortcut。
  const sendTriggerRef = useRef<"button" | "shortcut">("shortcut");
  // 修饰键点击先于 form submit；这里只保存这一拍的 delivery 反转意图，submit 消费后清零。
  const reversePointerDeliveryRef = useRef(false);
  const appliedComposerRestoreRequestRef = useRef<number | null>(null);
  const appliedExternalTextInsertRequestRef = useRef<number | null>(null);
  // 决策入参经 ref 读取，避免把 autoFocusEnabled/disabled/viewport 灌进 scope effect 依赖，
  // 触发多余的草稿重恢复（disabled 变化本不应重放草稿）。
  const focusOptsRef = useRef<ComposerAutoFocusOptions>({
    autoFocusEnabled,
    disabled,
    isMobileViewport: isMobileTextInputViewport,
  });
  focusOptsRef.current = {
    autoFocusEnabled,
    disabled,
    isMobileViewport: isMobileTextInputViewport,
  };
  const flushPendingFocus = useCallback(() => {
    if (!pendingFocusRef.current) return;
    if (resolveComposerAutoFocus(focusOptsRef.current) !== "focus-now") return;
    if (!inputApiRef.current) return;
    pendingFocusRef.current = false;
    // 程序性聚焦与用户点击输入框会触发同一个 DOM focus 事件；置位后由 handleEditorFocus
    // 消费，避免把「切会话 / 挂载回焦 / 上下文块移除后回焦」误报成 send_input_focus。
    programmaticFocusRef.current = true;
    // Lexical root 可能晚一帧就绪，聚焦排到下一帧（与草稿回填同款时序）。
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => inputApiRef.current?.focus());
    } else {
      inputApiRef.current.focus();
    }
  }, []);
  const requestComposerFocus = useCallback(() => {
    if (resolveComposerAutoFocus(focusOptsRef.current) === "skip") return;
    pendingFocusRef.current = true;
    flushPendingFocus();
  }, [flushPendingFocus]);

  const handleCodeCommentRemoved = useCallback(
    (comment: Parameters<typeof removeCodeCommentPreview>[0]) => {
      removeCodeCommentPreview(comment, services?.broadcastService);
    },
    [services?.broadcastService],
  );
  const {
    contexts: codeCommentContexts,
    hasContexts: hasCodeCommentContexts,
    removeContext: removeCodeCommentContext,
    clearContexts: clearCodeCommentContexts,
    getContexts: getCodeCommentContexts,
  } = useCodeCommentContexts({
    // queue 撤回等待 ACK 时 composer 处于 disabled；与网页上下文保持同一写入门禁。
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    onContextRemoved: handleCodeCommentRemoved,
    requestFocus: requestComposerFocus,
    scopeKey: `${workspaceKey}\0${draftScopeId}`,
  });

  useEffect(() => {
    if (!composerRestoreRequest) return;
    const applyRequest = () => {
      const nextAppliedRequestId = applyComposerRestoreRequestToComposer({
        appliedRequestId: appliedComposerRestoreRequestRef.current,
        currentSessionId: sessionId,
        currentWorkspaceKey: workspaceKey,
        hasDraftContent:
          textRef.current.length > 0 ||
          attachmentsApi.attachments.length > 0 ||
          codeCommentContexts.length > 0 ||
          webElementContexts.length > 0 ||
          pptxElementReferences.length > 0 ||
          conversationSelectionReferences.length > 0 ||
          pluginUiContexts.length > 0,
        inputApi: inputApiRef.current,
        request: composerRestoreRequest,
        requestFocus: requestComposerFocus,
        restoreSessionOwnedAttachments: attachmentsApi.restoreSessionOwnedAttachments,
        // 撤回项携带独立 Submission 配置；沿用草稿 owner，一次恢复且保留已处理授权标记。
        restoreDraftConfig: (config) =>
          replaceComposerDraft({
            ...ownerDraftRef.current.draft,
            ...config,
            text: composerRestoreRequest.text,
            editorStateJson: undefined,
            mention: undefined,
          }),
        scheduleDraftPersist,
        updateText,
      });
      const appliedNow =
        nextAppliedRequestId === composerRestoreRequest.requestId &&
        appliedComposerRestoreRequestRef.current !== composerRestoreRequest.requestId;
      appliedComposerRestoreRequestRef.current = nextAppliedRequestId;
      if (appliedNow) onComposerRestoreApplied?.(composerRestoreRequest.requestId);
      return nextAppliedRequestId === composerRestoreRequest.requestId;
    };
    if (applyRequest()) return;
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(applyRequest);
    return () => cancelAnimationFrame(frame);
  }, [
    attachmentsApi.attachments.length,
    attachmentsApi.restoreSessionOwnedAttachments,
    codeCommentContexts.length,
    composerRestoreRequest,
    conversationSelectionReferences.length,
    onComposerRestoreApplied,
    replaceComposerDraft,
    requestComposerFocus,
    scheduleDraftPersist,
    sessionId,
    updateText,
    webElementContexts.length,
    pptxElementReferences.length,
    pluginUiContexts.length,
    workspaceKey,
  ]);

  // scope 切换：先落旧 scope 草稿，再恢复新 scope（editorStateJson 优先，退纯文本）。
  useEffect(() => {
    const previousTarget = draftTargetRef.current;
    const targetChanged =
      previousTarget.scopeId !== draftScopeId ||
      previousTarget.workspacePath !== workspacePath ||
      previousTarget.workspaceIdentity !== workspaceIdentity;
    let transferredDraft: ReturnType<typeof snapshotDraftOfEditor> | null = null;
    if (
      targetChanged &&
      !activeSubmissionDraftTransactionRef.current?.matchesTarget(previousTarget.scopeToken)
    ) {
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      const previousDraft = snapshotDraftOfEditor();
      const shouldTransferDraft =
        previousTarget.scopeId.startsWith(V4_DRAFT_SCOPE_ROOT) &&
        draftScopeId.startsWith(V4_DRAFT_SCOPE_ROOT) &&
        consumeV4ComposerDraftWorkspaceTransferRequest({
          sourceWorkspacePath: previousTarget.workspacePath,
          sourceWorkspaceIdentity: previousTarget.workspaceIdentity,
          targetWorkspacePath: workspacePath,
          targetWorkspaceIdentity: workspaceIdentity,
        });
      if (shouldTransferDraft) {
        // 项目解绑只改变草稿的 cwd；输入正文、mention editor state 和组件内附件继续保留。
        replaceComposerDraft({ ...ownerDraftRef.current.draft, ...previousDraft });
        transferredDraft = previousDraft;
      }
    }
    draftScopeRef.current = draftScopeId;
    draftTargetRef.current = {
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
      scopeToken: composerDraftScopeToken,
    };

    const draft = transferredDraft ?? composerDraft;
    const restoreDraftInto = (api: LexicalChatInputHandle) => {
      if (!draft) {
        if (textRef.current) {
          api.clear();
          updateText("");
        }
        return;
      }
      updateText(
        restorePersistedComposerDraftIntoInput({
          draft,
          inputApi: api,
          onEditorStateError: (error) => {
            logger.warn(`[v4-composer] 草稿 editorState 恢复失败，退纯文本: ${String(error)}`);
          },
        }),
      );
    };
    let unsubscribeSettled: (() => void) | null = null;
    const applyDraft = () => {
      const api = inputApiRef.current;
      if (!api) return;
      restoreDraftInto(api);
      // Bug 根因（R3A-B-07）：ACK 丢失时传输先 reject，提交正文被恢复回草稿；随即断连让
      // SessionPane 连同本组件卸载，闭包里的结算订阅一起消失。重连重挂后正文从草稿回填，
      // 权威 projection 到达却无人清空，用户再点发送就重复归属。这里在回填后向模块级账本
      // 认领该 scope 尚未结算的提交：结算已到则同步清空，否则等它到达。
      const restoredText = draft?.text ?? "";
      const restoredRevision = contentRevisionRef.current;
      unsubscribeSettled = subscribeComposerSubmissionSettled(
        `${workspaceKey}\0${draftScopeId}`,
        (submission) => {
          // 只清"确实是那次提交、且用户还没在其上继续编辑"的正文；编辑器把回填正文
          // 重新序列化后若与提交原文一致，也视为未编辑。
          if (submission.text !== restoredText) return;
          if (
            contentRevisionRef.current !== restoredRevision &&
            textRef.current !== submission.text
          ) {
            return;
          }
          inputApiRef.current?.clear();
          updateText("");
          updateComposerContent({ text: "" });
        },
      );
      // 草稿恢复后把光标交还输入框（切会话/切草稿/挂载）；连接中会话待可编辑后兑现。
      requestComposerFocus();
    };
    // Lexical root 可能晚一帧就绪；draft 恢复排到下一帧（与旧 initialValue 回填同款时序）。
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(applyDraft);
      return () => {
        cancelAnimationFrame(frame);
        unsubscribeSettled?.();
      };
    }
    applyDraft();
    return () => unsubscribeSettled?.();
    // 依赖收敛到 scope/workspace：draft 恢复只应发生在 scope 切换或 workspace 切换。
  }, [
    draftScopeId,
    composerDraftScopeToken,
    persistDraftNow,
    requestComposerFocus,
    snapshotDraftOfEditor,
    updateText,
    updateComposerContent,
    workspaceIdentity,
    workspacePath,
    replaceComposerDraft,
  ]);

  useEffect(() => {
    ownerDraftRef.current = {
      draft: composerDraft,
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
    };
  }, [composerDraft, draftScopeId, workspaceIdentity, workspacePath]);

  // 外部预填和 scope 恢复可能在同一轮发生。若预填 effect 先执行，后续恢复会用旧草稿
  // 覆盖用户刚点的 Example Prompt；因此必须在 scope 恢复之后应用并确认单次插入请求。
  useEffect(() => {
    if (!externalTextInsertRequest) return;
    const applyRequest = () => {
      const nextAppliedRequestId = applyExternalTextInsertRequestToComposer({
        appliedRequestId: appliedExternalTextInsertRequestRef.current,
        inputApi: inputApiRef.current,
        request: externalTextInsertRequest,
        requestFocus: requestComposerFocus,
        scheduleDraftPersist,
        updateText,
      });
      const applied = nextAppliedRequestId === externalTextInsertRequest.requestId;
      appliedExternalTextInsertRequestRef.current = nextAppliedRequestId;
      if (applied) {
        onExternalTextInsertApplied?.(externalTextInsertRequest.requestId);
      }
      return applied;
    };
    if (applyRequest()) return;
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(applyRequest);
    return () => cancelAnimationFrame(frame);
  }, [
    externalTextInsertRequest,
    onExternalTextInsertApplied,
    requestComposerFocus,
    scheduleDraftPersist,
    updateText,
  ]);

  // 新建任务（含已在草稿态重复 Cmd/Ctrl+N，scope 未变）：startDraft 递增 nonce 即重新聚焦。
  const lastFocusVersionRef = useRef(draftFocusVersion);
  useEffect(() => {
    if (lastFocusVersionRef.current === draftFocusVersion) return;
    lastFocusVersionRef.current = draftFocusVersion;
    requestComposerFocus();
  }, [draftFocusVersion, requestComposerFocus]);

  // 切到需连接的会话时 disabled=true，聚焦意图 defer；连接完成 disabled→false 时兑现一次。
  useEffect(() => {
    flushPendingFocus();
  }, [disabled, flushPendingFocus]);

  // 刷新/关窗前落盘当前草稿。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const commitLifecycleContent = captureComposerContentLifecycleCommit();
    const flush = () => persistDraftNow(draftScopeRef.current);
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    return () => {
      if (!activeSubmissionDraftTransactionRef.current?.matchesTarget(composerDraftScopeToken)) {
        commitLifecycleContent(snapshotDraftOfEditor());
      }
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("blur", flush);
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      for (const cleanup of commandResolutionCleanupsRef.current) cleanup();
      commandResolutionCleanupsRef.current.clear();
    };
  }, [
    captureComposerContentLifecycleCommit,
    composerDraftScopeToken,
    persistDraftNow,
    snapshotDraftOfEditor,
  ]);

  // ── prompt history（per-workspace localStorage，↑/↓ 导航由 PromptHistoryPlugin 消费）──
  const [promptHistory, setPromptHistory] = useState<readonly string[]>(() =>
    readPromptHistoryEntries(workspacePath),
  );
  useEffect(() => {
    setPromptHistory(readPromptHistoryEntries(workspacePath));
  }, [workspacePath]);

  const mode = snapshot?.inputRouting.mode ?? "startNow";
  const modifiedEnterSubmits = shouldEnableModifiedEnterSubmit({
    inputRoutingMode: mode,
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  const canStop = Boolean(snapshot?.control.canStop);
  const modifiedEnterReversesDelivery = modifiedEnterSubmits && canStop;
  const hasText = textPresence.trimmed;
  const hasDraftToSubmit =
    hasText ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    hasPluginUiContexts ||
    Boolean(pendingShareContext);
  const hasComposerDraftContent =
    textPresence.raw ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    hasPluginUiContexts ||
    Boolean(pendingShareContext);
  useEffect(() => {
    onDraftStateChange?.({
      hasContent: hasComposerDraftContent,
      busy: pending,
    });
  }, [hasComposerDraftContent, onDraftStateChange, pending]);
  // choice 保留正常发送按钮；提交后由 SessionPane 按 slash 语义决定是否弹确认框。
  // V4 重构时把 guide 当成“不可提交”状态，导致按钮和 Enter 同时失效；
  // guide 是 CLI 已授权的 busy 输入路由，是否最终 steer 或回退 queue 由命令层裁决。
  const routingAllowsSend = draftMode || (snapshot !== null && mode !== "reject");
  const attachmentsReady = !attachmentsApi.hasUnreadyAttachments;
  const recoveryCommand = appSlashCommands?.find(
    (command) => command.recovery && command.value === "reload",
  );
  // 面板选择是 AppSlashCommand 操作，草稿不是参数；只有文本提交才要求独立命令。
  const recoveryAvailable = Boolean(recoveryCommand) && remoteAvailable;
  const recoveryAllowed =
    recoveryAvailable &&
    !hasAttachments &&
    !hasCodeCommentContexts &&
    !hasWebElementContexts &&
    !hasPptxElementReferences &&
    !hasConversationSelectionReferences &&
    !hasPluginUiContexts &&
    !pendingShareContext;
  const canReload = recoveryAllowed && reloadText && remoteAvailable;
  const canSend =
    !disabled &&
    !pending &&
    hasDraftToSubmit &&
    (canReload || (routingAllowsSend && attachmentsReady && submissionReady && !runtimeBlocked));
  // 旧 UI 状态机：streaming + 空草稿 → Stop；有草稿 → 发送键（入队）。
  const showStopControl = canStop && !hasDraftToSubmit;

  useEffect(() => {
    if (!canSend) setSendTooltipOpen(false);
  }, [canSend]);

  const submit = useCallback(
    async (
      heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend",
      expectedHeldQueueItemIds?: readonly string[],
      existingTelemetrySeed?: ConversationPromptTelemetrySeed,
      requestedDelivery?: "startNow" | "queue" | "guide",
    ) => {
      const submittedAt = performance.timeOrigin + performance.now();
      // IME 候选期间 textRef 尚未接收最终 onChange；提交必须与 claim/恢复共用 Lexical 快照。
      const submittedDraft = snapshotDraftOfEditor();
      const trimmed = submittedDraft.text.trim();
      const submittedQueueItemIds =
        snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
      const hasPendingAttachments = attachmentsApi.attachments.length > 0;
      const currentCodeCommentContexts = getCodeCommentContexts();
      const hasPendingCodeCommentContexts = currentCodeCommentContexts.length > 0;
      const currentWebElementContexts = webElementContexts;
      const hasPendingWebElementContexts = currentWebElementContexts.length > 0;
      const currentPluginUiContexts = pluginUiContexts;
      const hasPendingPluginUiContexts = currentPluginUiContexts.length > 0;
      const currentPptxElementReferences = pptxElementReferences;
      const hasPendingPptxElementReferences = currentPptxElementReferences.length > 0;
      const currentConversationSelections = conversationSelectionReferences;
      const hasPendingConversationSelections = currentConversationSelections.length > 0;
      const submittedShareContext = pendingShareContext;
      // /reload 是本地操作，在模型配置、队列和消息历史处理之前截获；参数和附件不发给模型。
      if (/^\/reload(?:\s|$)/.test(trimmed)) {
        if (
          trimmed !== "/reload" ||
          !recoveryCommand ||
          !recoveryAllowed ||
          !remoteAvailable ||
          pendingRef.current
        )
          return;
        const revision = contentRevisionRef.current;
        const scope = draftScopeRef.current;
        pendingRef.current = true;
        setPending(true);
        try {
          const completed = await recoveryCommand.run();
          if (
            completed !== false &&
            scope === draftScopeRef.current &&
            revision === contentRevisionRef.current
          ) {
            inputApiRef.current?.clear();
            updateText("");
            persistDraftNow(scope);
          }
        } finally {
          pendingRef.current = false;
          setPending(false);
        }
        return;
      }
      // 草稿首发 accepted 后同一 composer 会原地从 __draft__ promotion 到
      // session scope；若成功清理时再读可变 ref，会误清新 scope，并把首条输入残留在
      // __draft__，下次新建任务又恢复。发送开始时冻结真正提交的 scope。
      const submissionDraftTransaction = captureComposerSubmissionDraftTransaction(submittedDraft);
      const submittedScopeId = draftScopeRef.current;
      const submittedScopeKey = `${workspaceKey}\0${submittedScopeId}`;
      let cleanupRevision = contentRevisionRef.current;
      const submission = createSubmissionFromComposer?.() ?? null;
      const submittedAttachmentIds = attachmentsApi.attachments.map((item) => item.id);
      if (
        (!trimmed &&
          !hasPendingAttachments &&
          !hasPendingCodeCommentContexts &&
          !hasPendingWebElementContexts &&
          !hasPendingPptxElementReferences &&
          !hasPendingConversationSelections &&
          !hasPendingPluginUiContexts &&
          !submittedShareContext) ||
        pendingRef.current ||
        targetSelectionPendingRef.current ||
        !remoteAvailable ||
        !submissionReady ||
        runtimeBlocked ||
        (createSubmissionFromComposer !== undefined && submission === null) ||
        attachmentsApi.hasUnreadyAttachments
      ) {
        return;
      }
      const sendAction = startUserAction({
        featureId: "conversation.composer.message",
        action: "send",
        trigger: sendTriggerRef.current === "button" ? "button" : "shortcut",
        workspaceKind: workspaceIdentity?.trim() ? "remote" : "local",
      });
      pendingRef.current = true;
      setPending(true);
      // Bug 根因：草稿 intent 只保存用户显式改动，正常继承模型位于冻结初始化 config。
      // prewarm snapshot 尚未到达时若只读 draftConfig，send_btn 会错误落成空模型/glm。
      const telemetryConfig = telemetryDraftConfig ?? snapshotRef.current?.config ?? draftConfig;
      let telemetrySeed: ConversationPromptTelemetrySeed;
      if (existingTelemetrySeed) {
        // 队列二次确认复用首次点击的 seed：不重报 send_click，也不重置发送触发来源，
        // 保证 send_click 与 send_result 严格 1:1。
        telemetrySeed = existingTelemetrySeed;
        if (telemetrySeed.localTtft)
          getLocalTtftObserver()?.confirmation(telemetrySeed.localTtft, false);
      } else {
        const freshSeed: ConversationPromptTelemetrySeed = {
          sendTime: Date.now(),
          localTtft: !workspaceIdentity?.trim()
            ? getLocalTtftObserver()?.start(
                workspacePath,
                (snapshotRef.current !== null &&
                  snapshotRef.current.inputRouting.mode !== "startNow") ||
                  false,
                trimmed.startsWith("/"),
                submittedAt,
              )
            : undefined,
          extraDetail: buildV4ConversationPromptTelemetryExtraDetail({
            // 与首次发送 seed 一起冻结，排队确认和执行中切换界面都不能改写本轮归属。
            uiMode: toTelemetryUiMode(uiStore?.getState().interfaceMode),
            askMode: telemetryConfig?.mode,
            modelName: telemetryConfig?.model,
            configProvider: telemetryConfig?.provider,
            agentProvider: provider,
            providerBaseURL: resolveProviderBaseURL(telemetryConfig?.provider, modelSelectionView),
            planIdentitySnapshot: readPlanIdentitySnapshot?.(),
          }),
        };
        const sendTrigger = sendTriggerRef.current;
        sendTriggerRef.current = "shortcut";
        // recordSendClick 回填 sendClickId，必须用它的返回值作为后续 seed，
        // 否则落定时拿不到关联键，send_result 会被当成后台任务跳过。
        telemetrySeed =
          conversationTelemetry?.recordSendClick({
            sessionId: sessionId ?? null,
            seed: freshSeed,
            trigger: sendTrigger,
          }) ?? freshSeed;
      }
      let promptHistoryBeforeSend: readonly string[] | null = null;
      let promptHistoryAfterAppend: readonly string[] | null = null;
      let promptHistoryWasPersisted = false;
      let editorClearedOptimistically = false;
      let submittedCommandId: string | null = null;
      const claimSubmittedDraft = () => {
        if (draftPersistTimerRef.current !== null) {
          window.clearTimeout(draftPersistTimerRef.current);
          draftPersistTimerRef.current = null;
        }
        // 首发 promotion 会在 onSendText 返回前切换 scope 或重建 Composer。
        // 若仍允许旧 scope effect 落盘，新 Composer 会把已经发送的正文当草稿恢复。
        // 提交前先占用并隐藏该草稿；失败路径再恢复，避免用等待时间掩盖竞态。
        activeSubmissionDraftTransactionRef.current = submissionDraftTransaction.claim()
          ? submissionDraftTransaction
          : null;
      };
      const restoreSubmittedDraft = (awaitsAuthority = false) => {
        const result = submissionDraftTransaction.restore();
        const shouldRestoreEditor =
          result.applied && result.current && draftScopeRef.current === submittedScopeId;
        if (result.applied && submittedCommandId && awaitsAuthority) {
          // 传输层失败不等于 CLI 未 admission（ACK 丢失即如此）。正文虽已恢复回草稿，
          // 该 command 仍待权威结论；登记到模块级账本，让卸载重挂后的 composer 也能收口。
          trackUnsettledComposerSubmission(submittedScopeKey, {
            commandId: submittedCommandId,
            text: submittedDraft.text,
          });
        }
        // 正文已恢复给用户后，写盘抑制立即结束；事务闭包仍等待迟到的权威结算。
        activeSubmissionDraftTransactionRef.current = null;
        if (editorClearedOptimistically && shouldRestoreEditor) {
          if (submittedDraft.editorStateJson) {
            inputApiRef.current?.setEditorStateJson(submittedDraft.editorStateJson);
          } else {
            inputApiRef.current?.setText(submittedDraft.text);
          }
          updateText(submittedDraft.text);
          // 程序化恢复不是用户新编辑；迟到 authoritative 仍应能清除这份原文。
          cleanupRevision = contentRevisionRef.current;
          editorClearedOptimistically = false;
        } else if (
          !result.applied &&
          result.current &&
          draftScopeRef.current === submittedScopeId
        ) {
          // 原 scope 在等待期间已产生新正文；claim 解除后只补当前 A₂ 的 owner flush。
          persistDraftNow(submittedScopeId);
        }
      };
      const settleSubmittedContent = async () => {
        const result = submissionDraftTransaction.finalize();
        if (!result) return;
        activeSubmissionDraftTransactionRef.current = null;
        if (
          result.applied &&
          result.current &&
          draftScopeRef.current === submittedScopeId &&
          contentRevisionRef.current === cleanupRevision
        ) {
          inputApiRef.current?.clear();
          updateText("");
        }
        // 正文先按事务结算；附件交接失败或发送 Promise 迟到异常，都不能复活已接纳的正文。
        await attachmentsApi.adoptSentAttachments(submittedAttachmentIds);
        attachmentsApi.clearAttachments(submittedAttachmentIds);
        currentCodeCommentContexts.forEach(removeCodeCommentContext);
        currentWebElementContexts.forEach((context) => removeWebElementContext(context.id));
        currentPluginUiContexts.forEach((context) => removePluginUiContext(context.id));
        currentPptxElementReferences.forEach((reference) =>
          removePptxElementReference(reference.id),
        );
        currentConversationSelections.forEach((reference) =>
          removeConversationSelectionReference(reference.id),
        );
      };
      const subscribeToCommandResolution = (commandId: string) => {
        let active = true;
        let cleanup = () => undefined;
        submittedCommandId = commandId;
        const unsubscribe = pendingCommandRegistry.subscribeResolution(commandId, (resolution) => {
          if (!active) return;
          cleanup();
          if (
            resolution !== "accepted" &&
            resolution !== "duplicate" &&
            resolution !== "authoritative"
          ) {
            // 直接 rejected/failed 时 claim 仍持有空草稿；先恢复正文，再释放事务。
            restoreSubmittedDraft();
            submissionDraftTransaction.release();
            activeSubmissionDraftTransactionRef.current = null;
            return;
          }
          void settleSubmittedContent().catch((error) => {
            logger.warn("[v4-composer] 已接纳输入的附件交接失败", error);
          });
        });
        cleanup = () => {
          if (!active) return;
          active = false;
          unsubscribe();
          commandResolutionCleanupsRef.current.delete(cleanup);
        };
        commandResolutionCleanupsRef.current.add(cleanup);
      };
      const rollbackPromptHistory = () => {
        if (!promptHistoryWasPersisted || !promptHistoryBeforeSend || !promptHistoryAfterAppend) {
          return;
        }
        const currentPromptHistory = readPromptHistoryEntries(workspacePath);
        if (arePromptHistoryEntriesEqual(currentPromptHistory, promptHistoryAfterAppend)) {
          persistPromptHistoryEntries(workspacePath, promptHistoryBeforeSend);
          setPromptHistory(promptHistoryBeforeSend);
          return;
        }
        setPromptHistory(currentPromptHistory);
      };
      try {
        // 二次门禁：只消费预传完成的 ref，不在点击发送时回落上传。
        const readyAttachmentRefs = await attachmentsApi.prepareForSend();
        if (readyAttachmentRefs === null) {
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "rejected");
          // send_click 已上报，此处不落定会留下无配对的悬空样本，污染成功率分母。
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: sessionId ?? null,
            status: "fail",
            reasonCode: "attachment_not_ready",
          });
          sendAction.fail({ failureStage: "attachment_not_ready" });
          return;
        }
        // 外部上下文不走协议附件；按 selection -> code comment -> web -> PPTX 的固定尾块顺序
        // 序列化，历史 user row 才能按相反顺序无损解析并隐藏内部 prompt block。
        //
        // 分享 handover 不在这里序列化：share URL 块纯粹是 renderer 自产自销（CLI/shared
        // 里没有任何东西解析它），唯一作用是驱动一个已被产品裁掉的 chip，代价却是把一个
        // share URL 塞进发给模型的正文。模型侧内容由隐藏的 shared_context 消息经
        // inputIntent.sharedContextRefs 注入，与正文无关。
        const promptText = serializeComposerPromptContexts(trimmed, {
          codeComments: currentCodeCommentContexts,
          conversationSelections: [],
          webElements: currentWebElementContexts,
          pptxElements: currentPptxElementReferences,
          pluginUiContexts: currentPluginUiContexts,
        });
        const contextAttachmentCount =
          countComposerPromptContexts({
            codeComments: currentCodeCommentContexts,
            conversationSelections: currentConversationSelections,
            webElements: currentWebElementContexts,
            pptxElements: currentPptxElementReferences,
            pluginUiContexts: currentPluginUiContexts,
          }) + (submittedShareContext ? 1 : 0);
        if (trimmed) {
          promptHistoryBeforeSend = readPromptHistoryEntries(workspacePath);
          promptHistoryAfterAppend = appendPromptHistoryEntry(promptHistoryBeforeSend, trimmed);
          if (!arePromptHistoryEntriesEqual(promptHistoryBeforeSend, promptHistoryAfterAppend)) {
            // 预热首发 accepted 后，SessionPane 会立即 promote 到新 session，
            // draft composer 可能在 await 恢复前卸载；不能把写盘藏在 React state updater 里。
            // 这里继续沿用旧 UI 的 localStorage history，不接 input_history 数据库：
            // 发起真实发送前先同步写盘，若发送失败再恢复到发送前快照。
            persistPromptHistoryEntries(workspacePath, promptHistoryAfterAppend);
            promptHistoryWasPersisted = true;
            setPromptHistory(promptHistoryAfterAppend);
          }
        }
        claimSubmittedDraft();
        if (requestedDelivery === "startNow") {
          // 原子抢占需要等旧 turn 退出并提交新 TurnStarted ACK；
          // 若编辑器也等整条链路才清空，用户会误以为快捷键未生效。
          // 先清空可见正文；命令拒绝时用冻结 editor state 原样恢复。
          inputApiRef.current?.clear();
          updateText("");
          cleanupRevision = contentRevisionRef.current;
          editorClearedOptimistically = true;
        }
        const sendResult = await onSendText(promptText, {
          submittedDraftText: submittedDraft.text,
          submission,
          ...(currentConversationSelections.length
            ? {
                conversationQuotes: currentConversationSelections.map(
                  ({ text, path, senderName, senderId, messageId, sentAt }) => ({
                    text,
                    path,
                    senderName,
                    senderId,
                    messageId,
                    sentAt,
                  }),
                ),
              }
            : {}),
          telemetrySeed,
          onCommandCreated: subscribeToCommandResolution,
          ...(requestedDelivery ? { requestedDelivery } : {}),
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          ...(readyAttachmentRefs.length > 0 ? { attachments: readyAttachmentRefs } : {}),
          ...(contextAttachmentCount > 0 ? { contextAttachmentCount } : {}),
          ...(submittedShareContext
            ? {
                sharedContextRefs: [
                  {
                    kind: "shared_context_import" as const,
                    context_id: submittedShareContext.contextId,
                  },
                ],
              }
            : {}),
        });
        if (sendResult === "blocked") {
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "rejected");
          // 产品 guard 是一次正常拒绝，不应借异常路径表达；回滚发送前暂记的 history，
          // 同时不 clear editor/draft/附件，让用户切换模式后可以直接重试。
          rollbackPromptHistory();
          restoreSubmittedDraft();
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: sessionId ?? null,
            status: "fail",
            reasonCode: "blocked",
          });
          sendAction.reject({ resultSource: "authority_ack", admissionResult: "rejected" });
          return;
        }
        if (sendResult === "confirmationRequired") {
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.confirmation(telemetrySeed.localTtft, true);
          rollbackPromptHistory();
          restoreSubmittedDraft();
          const latestQueueItemIds =
            snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
          // 首次提交冻结当前队列；跨端 stale 后用最新投影替换，要求用户重新确认。
          setHeldQueueConfirmation({
            // 标记 queueConfirmed：确认后复用该 seed 落定，send_cost_ms 含用户在弹窗上的停留。
            telemetrySeed: { ...telemetrySeed, queueConfirmed: true },
            ...(requestedDelivery ? { requestedDelivery } : {}),
            queueItemIds:
              latestQueueItemIds.length > 0 ? latestQueueItemIds : submittedQueueItemIds,
          });
          sendAction.noop();
          return;
        }
        setHeldQueueConfirmation(null);
        // 发送成功或 ACK 丢失后由权威 projection 结算：清本次提交捕获的内容，
        // prompt history 已在真实发送前同步写盘，避免首发 promote 丢失或误清新 scope。
        await settleSubmittedContent();
        sendAction.complete({ resultSource: "authority_ack", admissionResult: "accepted" });
      } catch (error) {
        rollbackPromptHistory();
        // 已结算事务不会恢复；只有未确定命令结果的传输失败才保留迟到权威结算订阅。
        restoreSubmittedDraft(true);
        if (telemetrySeed.localTtft)
          getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "failed");
        // 发送失败草稿保留在输入框（不清空），仅记录原因。
        logger.warn(`[v4-composer] 发送失败: ${String(error)}`);
        // ACK 侧失败已由 SessionPane 落定；能走到这里的是 composer 自身链路异常。
        conversationTelemetry?.settleSendResult({
          seed: telemetrySeed,
          sessionId: sessionId ?? null,
          status: "fail",
          reasonCode: "composer_error",
        });
        sendAction.fail({ failureStage: "composer_send" });
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [
      recoveryCommand,
      recoveryAllowed,
      uiStore,
      attachmentsApi,
      captureComposerSubmissionDraftTransaction,
      conversationSelectionReferences,
      conversationTelemetry,
      draftConfig,
      createSubmissionFromComposer,
      submissionReady,
      remoteAvailable,
      runtimeBlocked,
      getCodeCommentContexts,
      telemetryDraftConfig,
      modelSelectionView,
      onSendText,
      pendingShareContext,
      persistDraftNow,
      provider,
      readPlanIdentitySnapshot,
      removeCodeCommentContext,
      removeConversationSelectionReference,
      removePptxElementReference,
      removeWebElementContext,
      removePluginUiContext,
      pluginUiContexts,
      sessionId,
      snapshotDraftOfEditor,
      updateText,
      updateComposerContent,
      webElementContexts,
      pptxElementReferences,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleUserInputClear = useCallback(() => {
    conversationTelemetry?.resetComposerInputStart();
  }, [conversationTelemetry]);

  const handleUserInputPresenceChange = useCallback(
    (presence: { raw: boolean; trimmed: boolean }) => {
      const currentPresence = textPresenceRef.current;
      if (currentPresence.raw === presence.raw && currentPresence.trimmed === presence.trimmed) {
        return;
      }
      textPresenceRef.current = presence;
      setTextPresence(presence);
    },
    [],
  );

  const handleUserInputStart = useCallback(() => {
    conversationTelemetry?.recordComposerInputStart();
  }, [conversationTelemetry]);

  // Lexical onChange（首字符也稳定回传，见 LexicalChatInput.TextContentPlugin）。
  const handleEditorChange = useCallback(
    (value: string) => {
      updateText(value);
      scheduleDraftPersist();
    },
    [scheduleDraftPersist, updateText],
  );

  const handleEditorFocus = useCallback(() => {
    conversationTelemetry?.recordComposerFocus();
    // 程序性聚焦不算「点击输入框」；标记一次性消费，之后的手动 focus 照常上报。
    if (programmaticFocusRef.current) {
      programmaticFocusRef.current = false;
      return;
    }
    conversationTelemetry?.recordComposerFocusClick({
      sessionId: sessionId ?? null,
    });
  }, [conversationTelemetry, sessionId]);

  // 编辑器提交（Enter / 发送键 form submit 同路径）。返回 false：编辑器不自行 reset，
  // 由 submit 成功后经 inputApiRef.clear() 清空——失败时草稿留在输入框。
  const handleEditorSubmit = useCallback(
    (value: string) => {
      textRef.current = value;
      const reverseDelivery = reversePointerDeliveryRef.current;
      reversePointerDeliveryRef.current = false;
      const followupMode = snapshotRef.current?.config.followupMode;
      void submit(
        undefined,
        undefined,
        undefined,
        reverseDelivery && followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  const handleModifiedEditorSubmit = useCallback(
    (value: string) => {
      const followupMode = snapshotRef.current?.config.followupMode;
      textRef.current = value;
      // inputRouting 在 turn 启动初期可能仍为 startNow，不能用它
      // 推断空闲。组合键始终表达单次反向 delivery；空闲时 CLI 自然 startNow。
      void submit(
        undefined,
        undefined,
        undefined,
        followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  const handleClearQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "clearQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.telemetrySeed,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  const handleKeepQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "keepQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.telemetrySeed,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  const handleStopClick = useCallback(() => {
    runUserAction({
      input: { featureId: "conversation.composer.message", action: "stop", trigger: "button" },
      operation: onStop,
      completed: { resultSource: "optimistic_projection" },
      failureStage: "stop_generation",
    });
  }, [onStop]);

  // 发送键是 type="submit"，与 Enter 共用 handleEditorSubmit；DOM 事件顺序保证 click 早于
  // submit，故这里只置标记，由 submit() 读取并复位。
  const handleSendButtonClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      sendTriggerRef.current = "button";
      reversePointerDeliveryRef.current = shouldReverseFollowupDeliveryForPointer({
        enabled: modifiedEnterReversesDelivery,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isApplePlatform: appleKeyboardPlatform,
      });
    },
    [appleKeyboardPlatform, modifiedEnterReversesDelivery],
  );

  // ── 「加入对话」全局事件（workspace file tree 右键/按钮）→ mention 插入 ──
  useEffect(() => {
    if (!listenAddToChatEvents || typeof window === "undefined") {
      return;
    }
    const handleWorkspaceFileAddToChat = (event: Event) => {
      if (!isWorkspaceFileAddToChatEvent(event)) {
        return;
      }
      event.preventDefault();
      appendWorkspaceFileMentionToComposer({
        inputApiRef,
        currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
        payload: event.detail,
        workspacePath,
        workspaceIdentity,
        onTextChange: updateText,
      });
    };
    window.addEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    return () => {
      window.removeEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    };
  }, [listenAddToChatEvents, updateText, workspaceIdentity, workspacePath]);

  // ACK 清空正文与消息投影不是同一时刻；提交及待投影命令共同覆盖首发交接窗口。
  // 完整视图浮窗（单行）运行中使用整秒摘要；消息流底部独立显示十分之一秒。
  const workingDurationLabel =
    layout === "inline" && canStop
      ? formatConversationWorkDuration(workingDurationMs, intl, locale)
      : null;
  // 切回已有会话时 lease 先切换、快照后到；未知历史不能当作新草稿，
  // 否则运行中的输入框会闪出新任务提示。只等待当前快照，不复用上一会话状态。
  const normalPlaceholder =
    sessionId !== null && snapshot === null
      ? ""
      : workingDurationLabel
        ? intl.formatMessage({ id: "chat.history.workingFor" }, { duration: workingDurationLabel })
        : intl.formatMessage({
            id: resolveChatPlaceholderKey({
              hasHistoryMessages: (snapshot?.rows.totalCount ?? 0) > 0,
              isTaskProcessing: pending || inputPending || canStop,
              // 单行输入框放不下完整的新任务提示，沿用手机远控的短文案。
              compactNewTask: compactMobilePlaceholder || layout === "inline",
            }),
          });
  const sendTooltipTitle = intl.formatMessage({
    id: mode === "enqueue" ? "chat.queue.enqueue" : "chat.send",
  });
  const modifierTooltip = resolveFollowupModifierTooltip({
    enabled: modifiedEnterReversesDelivery,
    canSend,
    modifierPressed: primaryModifierPressed,
    followupMode: snapshot?.config.followupMode,
    isApplePlatform: appleKeyboardPlatform,
  });
  const resolvedSendTooltipTitle = modifierTooltip
    ? intl.formatMessage({ id: modifierTooltip.titleId })
    : sendTooltipTitle;
  const resolvedSendTooltipShortcut = modifierTooltip?.shortcut ?? sendShortcut;
  const stopTooltipTitle = intl.formatMessage({ id: "chat.stop" });
  const visibleError = error && !shouldSuppressChatErrorBanner(error) ? error : null;

  useEffect(() => {
    if (!visibleError || !conversationTelemetry || !telemetryVisible) return;
    const telemetryKey = [
      visibleError.taskId ?? sessionId ?? "",
      visibleError.code ?? "",
      visibleError.traceId ?? "",
      visibleError.message,
    ].join(":");
    if (reportedErrorKeysRef.current.has(telemetryKey)) return;
    reportedErrorKeysRef.current.add(telemetryKey);
    // 错误只有经过 suppression 后真实进入 render 才曝光；同一 composer mount 相同 key 一次。
    conversationTelemetry.reportVisibleChatError({
      errorKey: telemetryKey,
      displayMessage: resolveChatErrorBannerDisplayMessage(visibleError, intl),
      error: visibleError,
    });
  }, [conversationTelemetry, intl, sessionId, telemetryVisible, visibleError]);

  const attachmentAction = useMemo(
    () => ({
      label: intl.formatMessage({ id: "chat.composer.attachment" }),
      menuItemTestId: TID_CHAT_ATTACHMENT_MENU_ITEM,
      onSelect: () =>
        runUserAction({
          input: {
            featureId: "conversation.composer.attachment",
            action: "add",
            trigger: "button",
          },
          operation: attachmentsApi.openAttachmentPicker,
          completed: { resultSource: "local_commit" },
          failureStage: "attachment_picker",
        }),
      testId: TID_CHAT_ATTACHMENT_BUTTON,
    }),
    [intl, attachmentsApi.openAttachmentPicker],
  );

  // ── 附件预览网格 ──
  const composerAttachments = attachmentsApi.attachments;
  const orderedComposerAttachments = useMemo(() => {
    // 媒体组（图片/视频）优先、文件在后；组内保持添加顺序。
    const media: (typeof composerAttachments)[number][] = [];
    const files: (typeof composerAttachments)[number][] = [];
    for (const attachment of composerAttachments) {
      (isMediaChatComposerAttachment(attachment) ? media : files).push(attachment);
    }
    return [...media, ...files];
  }, [composerAttachments]);
  const composerMediaPreviewItems = useMemo(
    () =>
      composerAttachments.flatMap((attachment) =>
        attachment.objectUrl && isMediaChatComposerAttachment(attachment)
          ? [
              {
                alt: attachment.filename,
                filename: attachment.filename,
                mediaType: attachment.mimeType,
                src: attachment.objectUrl,
              },
            ]
          : [],
      ),
    [composerAttachments],
  );
  const topContentNode = useMemo(() => {
    if (
      composerAttachments.length === 0 &&
      codeCommentContexts.length === 0 &&
      webElementContexts.length === 0 &&
      pptxElementReferences.length === 0 &&
      conversationSelectionReferences.length === 0 &&
      pluginUiContexts.length === 0
    ) {
      return null;
    }
    return (
      <div className="flex max-w-full flex-col items-start gap-2">
        {composerAttachments.length > 0 ? (
          <Attachments
            variant="inline"
            className="flex max-w-full flex-wrap gap-2"
            data-composer-file-attachments-row="true"
          >
            {orderedComposerAttachments.map((attachment) => {
              const isClipboardTextAttachment = attachment.sourceKind === "clipboard-text";
              const isMediaAttachment = isMediaChatComposerAttachment(attachment);
              const isVideoAttachment = isVideoChatComposerAttachment(attachment);
              const isPdfAttachment = isPdfChatComposerAttachment(attachment);
              const mediaType = attachment.objectUrl
                ? attachment.mimeType
                : attachment.mimeType.startsWith("image/")
                  ? "application/octet-stream"
                  : attachment.mimeType;
              const canPreviewImageAttachment =
                Boolean(attachment.objectUrl) && isImageChatComposerAttachment(attachment);
              const canPreviewVideoAttachment = Boolean(attachment.objectUrl) && isVideoAttachment;
              const canPreviewPdfAttachment = Boolean(attachment.objectUrl) && isPdfAttachment;
              const fileDisplayDescriptor = resolveFileDisplayDescriptor(
                attachment.localPath ?? attachment.filename,
              );
              const uploadStatusLabel =
                attachment.uploadStatus === "uploading"
                  ? intl.formatMessage(
                      { id: "chat.attachments.upload.uploading" },
                      { progress: String(attachment.uploadProgress) },
                    )
                  : attachment.uploadStatus === "failed"
                    ? intl.formatMessage(
                        { id: "chat.attachments.upload.failed" },
                        { message: attachment.uploadError ?? "unknown" },
                      )
                    : intl.formatMessage({
                        id: `chat.attachments.upload.${attachment.uploadStatus}`,
                      });
              const showUploadStatus =
                !attachment.localZeroCopy &&
                (attachment.uploadStatus !== "ready" || attachment.showComplete);
              return (
                <Attachment
                  key={attachment.id}
                  variant={isMediaAttachment ? "grid" : "inline"}
                  data-composer-attachment-kind={
                    isVideoAttachment
                      ? "video"
                      : isMediaAttachment
                        ? "image"
                        : isPdfAttachment
                          ? "pdf"
                          : "file"
                  }
                  data-testid={testId(TID_V4_ATTACHMENT, attachment.id)}
                  data-upload-status={attachment.uploadStatus}
                  className={
                    isMediaAttachment
                      ? "relative size-12 overflow-hidden rounded-lg bg-surface after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-['']"
                      : "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover"
                  }
                  data={{
                    id: attachment.id,
                    type: "file",
                    filename: attachment.filename,
                    ...(isClipboardTextAttachment
                      ? {
                          description: intl.formatMessage(
                            {
                              id: "chat.attachments.clipboardText.description",
                            },
                            {
                              lineCount: formatAttachmentLineCount(attachment, locale),
                            },
                          ),
                          displayName: intl.formatMessage({
                            id: "chat.attachments.clipboardText",
                          }),
                          sourceKind: "clipboard-text" as const,
                        }
                      : {}),
                    mediaType,
                    url: attachment.objectUrl ?? "",
                  }}
                  onRemove={() => attachmentsApi.removeAttachment(attachment.id)}
                  // 附件支持非图片格式，PDF 走独立 PdfViewer，
                  // 其他文件展示类型图标和文件名，避免 doc 等普通文件被当成图片渲染失败。
                  // 图片与视频统一按添加顺序进入发送前 gallery，
                  // 保证同一组媒体可以连续导航。
                  onOpen={
                    canPreviewImageAttachment || canPreviewVideoAttachment
                      ? () => {
                          const previewIndex = composerMediaPreviewItems.findIndex(
                            (item) => item.src === attachment.objectUrl,
                          );
                          if (previewIndex < 0) return;
                          setAttachmentPreviewIndex(previewIndex);
                          setAttachmentPreviewOpen(true);
                        }
                      : canPreviewPdfAttachment
                        ? () => {
                            setPdfAttachmentPreview({
                              filename: attachment.filename,
                              mediaType: "application/pdf",
                              url: attachment.objectUrl,
                            });
                            setPdfAttachmentPreviewOpen(true);
                          }
                        : undefined
                  }
                  openLabel={
                    canPreviewVideoAttachment
                      ? videoAttachmentPreviewTitle
                      : canPreviewImageAttachment
                        ? attachmentPreviewTitle
                        : canPreviewPdfAttachment
                          ? intl.formatMessage({ id: "chat.attachments.preview.openPdf" })
                          : undefined
                  }
                >
                  <div
                    className={cn(
                      "relative shrink-0",
                      isMediaAttachment ? "size-full" : "size-9 rounded-md bg-background",
                    )}
                  >
                    <AttachmentPreview
                      className={cn(
                        isMediaAttachment ? "size-full rounded-none" : "size-9 rounded-md",
                      )}
                      fallbackIcon={
                        isClipboardTextAttachment ? (
                          <ClipboardPenLineIcon className="size-3.5 text-muted-foreground" />
                        ) : (
                          <FileDisplayIcon
                            src={fileDisplayDescriptor.fileIconSrc}
                            size={16}
                            className="size-4 shrink-0"
                          />
                        )
                      }
                    />
                    {showUploadStatus && isMediaAttachment ? (
                      <span
                        data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                        role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                        aria-label={uploadStatusLabel}
                        className="absolute inset-0 grid place-items-center rounded-lg bg-background/85 text-[7px] font-semibold text-foreground"
                      >
                        <svg
                          aria-hidden="true"
                          className="absolute inset-0 size-full -rotate-90 text-brand"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="stroke-border"
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeWidth="2"
                          />
                          <circle
                            className={
                              attachment.uploadStatus === "failed"
                                ? "stroke-destructive"
                                : "stroke-current"
                            }
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeDasharray={`${attachment.uploadProgress} 100`}
                            strokeLinecap="round"
                            strokeWidth="2"
                          />
                        </svg>
                        <span className="relative">
                          {attachment.uploadStatus === "failed"
                            ? "!"
                            : `${attachment.uploadProgress}%`}
                        </span>
                      </span>
                    ) : null}
                  </div>
                  {!isMediaAttachment ? (
                    isClipboardTextAttachment ? (
                      <AttachmentInfo className="max-w-48 text-ui-base text-foreground" />
                    ) : (
                      <div className="min-w-0 max-w-40 flex-1">
                        <span
                          className="block truncate text-ui-base font-medium text-foreground"
                          title={attachment.filename}
                        >
                          {attachment.sourceKind === "topic-history"
                            ? intl.formatMessage(
                                { id: "chat.attachments.topicHistory" },
                                { count: attachment.messageCount ?? 0 },
                              )
                            : attachment.filename}
                        </span>
                        <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                          {getComposerAttachmentTypeLabel(attachment.filename, attachment.mimeType)}
                        </span>
                      </div>
                    )
                  ) : null}
                  {showUploadStatus && !isMediaAttachment ? (
                    <span
                      data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                      role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                      title={uploadStatusLabel}
                      className={cn(
                        "max-w-28 truncate text-ui-sm font-normal text-foreground-subtle",
                        attachment.uploadStatus === "failed" && "text-destructive",
                      )}
                    >
                      {attachment.uploadStatus === "uploading"
                        ? `${attachment.uploadProgress}%`
                        : uploadStatusLabel}
                    </span>
                  ) : null}
                  {attachment.uploadStatus === "failed" ? (
                    <button
                      type="button"
                      data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_RETRY, attachment.id)}
                      aria-label={intl.formatMessage({
                        id: "chat.attachments.upload.retry",
                      })}
                      title={uploadStatusLabel}
                      className="grid size-5 shrink-0 place-items-center rounded-md text-destructive hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        attachmentsApi.retryAttachment(attachment.id);
                      }}
                    >
                      <RotateCcwIcon className="size-3" />
                    </button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-composer-attachment-remove={attachment.id}
                    aria-label={intl.formatMessage({
                      id: "chat.attachments.remove",
                    })}
                    className="absolute right-0.5 top-0.5 z-20 size-3.5 rounded-full bg-primary p-0 text-primary-foreground opacity-0 transition-opacity hover:bg-primary/80 hover:text-primary-foreground group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      attachmentsApi.removeAttachment(attachment.id);
                    }}
                  >
                    <XIcon className="size-2.5" />
                  </Button>
                </Attachment>
              );
            })}
          </Attachments>
        ) : null}
        {codeCommentContexts.length > 0 ||
        webElementContexts.length > 0 ||
        pptxElementReferences.length > 0 ||
        conversationSelectionReferences.length > 0 ||
        pluginUiContexts.length > 0 ? (
          <div
            className="flex max-w-full flex-wrap items-center gap-2"
            data-composer-context-attachments-row="true"
          >
            <CodeCommentAttachmentChip
              comments={codeCommentContexts}
              onRemove={removeCodeCommentContext}
              onRemoveAll={clearCodeCommentContexts}
            />
            <WebElementContextAttachmentChip
              contexts={webElementContexts}
              onRemove={removeWebElementContext}
              onRemoveAll={clearWebElementContexts}
            />
            <PluginUiModelContextChip
              contexts={pluginUiContexts}
              onRemove={removePluginUiContext}
              onRemoveAll={clearPluginUiContexts}
            />
            <PptxElementReferenceChip
              references={pptxElementReferences}
              onOpen={onOpenCodeViewer ? openPptxElementReference : undefined}
              onRemove={removePptxElementReference}
              onRemoveAll={clearPptxElementReferences}
            />
            <ConversationSelectionReferenceChip
              references={conversationSelectionReferences}
              onRemove={removeConversationSelectionReference}
              onRemoveAll={clearConversationSelectionReferences}
            />
          </div>
        ) : null}
      </div>
    );
  }, [
    attachmentPreviewTitle,
    attachmentsApi,
    clearCodeCommentContexts,
    clearConversationSelectionReferences,
    clearWebElementContexts,
    clearPluginUiContexts,
    clearPptxElementReferences,
    codeCommentContexts,
    composerAttachments,
    composerMediaPreviewItems,
    orderedComposerAttachments,
    intl,
    locale,
    removeCodeCommentContext,
    removeConversationSelectionReference,
    removeWebElementContext,
    removePluginUiContext,
    removePptxElementReference,
    conversationSelectionReferences,
    pendingShareContext,
    webElementContexts,
    pluginUiContexts,
    pptxElementReferences,
    onOpenCodeViewer,
    openPptxElementReference,
  ]);

  // 发送/停止控制簇（对齐旧 ChatViewComposer.submitControlNode 结构：
  // 左侧 model/thought/usage 簇 + 右侧 stop 或 send）。
  // useMemo：composer 随流式 snapshot 高频重渲染，控制簇只在语义依赖变化时重建，
  // 避免每个 token 批次都重建 Tooltip/Select 子树。
  const composerUsage = snapshot?.usage ?? null;
  const composerPhase = snapshot?.control.phase ?? null;
  const handleSelectModelTrace = useCallback(
    (
      nextProvider: string,
      nextModel: string,
      sourceModel: ModelSelectionSource | null,
      reasoningLevel?: string,
    ) =>
      runUserAction({
        input: {
          featureId: "conversation.composer.config",
          action: "change_model",
          trigger: "select",
        },
        operation: () =>
          reasoningLevel === undefined
            ? onSelectModel(nextProvider, nextModel, sourceModel)
            : onSelectModel(nextProvider, nextModel, sourceModel, reasoningLevel),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "model_change",
      }),
    [onSelectModel],
  );
  const submitControlNode = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-1">
        {!remoteAvailable ? (
          <span
            data-testid="remote-send-unavailable"
            className="max-w-40 text-right text-ui-sm text-foreground-subtle"
          >
            {intl.formatMessage({ id: "remote.conversation.sendUnavailable" })}
          </span>
        ) : null}
        {remoteAvailable ? (
          <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden empty:hidden">
            <V4ComposerModelControls
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              modelSelectionView={modelSelectionView}
              modelSelectionState={modelSelectionState}
              modelSelectionReload={modelSelectionReload}
              modelSelectionRefresh={modelSelectionRefresh}
              sessionId={sessionId ?? null}
              phase={composerPhase}
              provider={provider}
              isWebRemoteControl={isWebRemoteControl}
              isMobileViewport={isMobileTextInputViewport}
              draftMode={draftMode}
              draftConfig={draftConfig}
              usage={composerUsage}
              disabled={disabled || runtimeBlocked}
              modelLocked={highspeedCard !== null}
              highspeedPresented={highspeedPresented}
              highspeedEntranceAnimated={highspeedEntranceAnimated}
              highspeedSweepActive={highspeedSweepActive}
              highspeedExpiresAt={highspeedCard?.expiresAt}
              highspeedModel={highspeedCard?.model}
              activeConfigPicker={activeConfigPicker}
              onConfigPickerOpenChange={handleConfigPickerOpenChange}
              onSelectModel={handleSelectModelTrace}
              onSelectThought={onSelectThought}
              onSwitchMode={onSwitchMode}
              onRecoverCustomModelSelection={onRecoverCustomModelSelection}
              onSendCompressionCommand={onSendCompressionCommand}
            />
          </span>
        ) : null}
        {showStopControl ? (
          <ControlHintTooltip title={stopTooltipTitle} shortcut="Esc">
            <Button
              type="button"
              variant="secondary"
              size="icon-md"
              onClick={handleStopClick}
              data-testid={TID_V4_STOP}
              className="rounded-full"
              aria-label={stopTooltipTitle}
            >
              <SquareIcon className="size-4 fill-current" />
              <span className="sr-only">{stopTooltipTitle}</span>
            </Button>
          </ControlHintTooltip>
        ) : (
          <ControlHintTooltip
            title={resolvedSendTooltipTitle}
            shortcut={resolvedSendTooltipShortcut}
            open={Boolean(modifierTooltip) || sendTooltipOpen}
            onOpenChange={setSendTooltipOpen}
          >
            <Button
              type="submit"
              size="icon-md"
              disabled={!canSend}
              onClick={handleSendButtonClick}
              data-testid={TID_V4_COMPOSER_SEND}
              aria-label={resolvedSendTooltipTitle}
              className="cursor-pointer gap-1 rounded-full bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
            >
              {pending ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
              <span className="sr-only">{resolvedSendTooltipTitle}</span>
            </Button>
          </ControlHintTooltip>
        )}
      </div>
    ),
    [
      canSend,
      activeConfigPicker,
      composerPhase,
      composerUsage,
      disabled,
      runtimeBlocked,
      draftConfig,
      draftMode,
      handleStopClick,
      handleSendButtonClick,
      handleConfigPickerOpenChange,
      highspeedCard,
      highspeedEntranceAnimated,
      highspeedPresented,
      highspeedSweepActive,
      isWebRemoteControl,
      mode,
      handleSelectModelTrace,
      modelSelectionReload,
      modelSelectionRefresh,
      modelSelectionState,
      modelSelectionView,
      onSelectThought,
      onRecoverCustomModelSelection,
      onSendCompressionCommand,
      onSwitchMode,
      pending,
      provider,
      modifierTooltip,
      resolvedSendTooltipShortcut,
      resolvedSendTooltipTitle,
      sendTooltipOpen,
      remoteAvailable,
      sendShortcut,
      sendTooltipTitle,
      sessionId,
      showStopControl,
      stopTooltipTitle,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // 左下：模式选择 + CUA 入口 + 当前 session 后台任务入口。followupMode 由 app 设置页同步到 CLI，
  // 不在 composer 暴露局部开关；后台入口只消费同一 snapshot，不维护第二份任务状态。
  const leadingActionsNode = useMemo(
    () => (
      <>
        <V4ComposerModeSwitch
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          provider={provider}
          draftConfig={draftConfig}
          disabled={disabled || runtimeBlocked}
          activeConfigPicker={activeConfigPicker}
          onConfigPickerOpenChange={handleConfigPickerOpenChange}
          onSwitchMode={onSwitchMode}
        />
        {sessionId && snapshot?.workspaceHookAdmission ? (
          <WorkspaceHookPendingIndicator
            key={JSON.stringify([sessionId, snapshot.workspaceHookAdmission.bundleDigest])}
            sessionId={sessionId}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            admission={snapshot.workspaceHookAdmission}
          />
        ) : null}
        {sessionId && snapshot?.workspaceMcpAdmission ? (
          <WorkspaceMcpPendingIndicator
            key={JSON.stringify([
              workspaceIdentity,
              workspacePath,
              sessionId,
              snapshot.workspaceMcpAdmission.bundleDigest,
            ])}
            sessionId={sessionId}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            admission={snapshot.workspaceMcpAdmission}
          />
        ) : null}
        {/* Bug 原因：附件画廊 rebase 曾整段覆盖 leadingActions，误删 staging 的 CUA 常驻入口。
            入口自身继续负责平台、远程与设置可见性，不在 composer 重复判定。 */}
        <V4ComposerCuaEntry
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
          isWebRemoteControl={isWebRemoteControl}
          currentSessionBusy={canStop}
        />
        <ConversationBackgroundWorkTrigger
          backgroundWorks={snapshot?.backgroundWorks ?? []}
          runningSubagentCount={runningSubagentCount}
          onOpen={onOpenRunningBackgroundWorks}
          openTarget={backgroundWorkOpenTarget}
        />
      </>
    ),
    [
      activeConfigPicker,
      canStop,
      disabled,
      runtimeBlocked,
      draftConfig,
      handleConfigPickerOpenChange,
      isWebRemoteControl,
      backgroundWorkOpenTarget,
      onOpenRunningBackgroundWorks,
      onSwitchMode,
      provider,
      remoteSessionId,
      runningSubagentCount,
      sessionId,
      snapshot?.workspaceHookAdmission,
      snapshot?.workspaceMcpAdmission,
      snapshot?.backgroundWorks,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const isBlockedByInteraction = blockingRequestId !== null;

  // v4 pendingInteractions 是 bottom dock 阻塞态；composer 必须保留挂载，
  // 只在视觉和可访问树中隐藏，避免权限/问答卡片出现时丢失草稿和编辑器内部状态。
  return (
    // 外层 bottom dock 负责 sticky 与横向主列宽度；composer 自身组织错误提示与输入壳。
    // centered（居中草稿布局，m5）：收窄 max-w-2xl（旧
    // getChatViewComposerWidthClassName 的 draft 档），由宿主的居中容器摆位。
    // 有 contextHeader（草稿态）时，内层输入 surface 套旧 ChatViewComposer 同款卡：
    // rounded-2xl bg-surface shadow-xl/5；会话态回落不透明页面底色。
    // 错误横幅虽然排在 contextHeader 前面，但不能与输入区共用同一个圆角 surface，
    // 视觉上会被误认为输入卡标题栏；将 surface 边界收窄到工作区头和编辑器后，桌面与手机
    // Web 仍共享同一 DOM 顺序，同时恢复错误提示与输入卡之间的独立层级。
    <div
      data-testid={TID_V4_COMPOSER}
      data-input-routing={mode}
      aria-hidden={isBlockedByInteraction ? true : undefined}
      style={isBlockedByInteraction ? { display: "none" } : undefined}
      className={cn(
        "chat-composer-region z-20 w-full shrink-0 @container/composer",
        centered && "max-w-2xl",
      )}
    >
      {/* 旧 ChatViewComposer 同款隐藏 file input（web/无 native picker 平台回退）。 */}
      <input
        ref={attachmentsApi.attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={attachmentsApi.handleAttachmentInputChange}
      />
      {visibleError ? (
        // 仅展示附件错误会漏掉会话级 lastError，任务失败后也应在输入框上方显示原因。
        // 这里复用旧 ChatErrorBanner 壳，只接收 SessionPane 已归一化后的当前错误。
        // 错误横幅独立于输入 surface，并先于桌面和手机共用的 contextHeader。
        <div className="mb-6 w-full shrink-0">
          <ChatErrorBanner
            error={visibleError}
            remoteKind={
              remoteKind?.kind === "workspace" ? remoteKind.remoteTarget?.kind : undefined
            }
            onReconnect={
              reconnectProject || remoteController
                ? () => {
                    const request = reconnectProject
                      ? reconnectProject(workspaceKey)
                      : remoteController?.dispatch({ type: "reconnect-workspace", workspaceKey });
                    void request?.catch((error: unknown) =>
                      logger.warn("[v4-composer] 项目重连失败", { error }),
                    );
                  }
                : undefined
            }
            onRetry={onRetryError}
            onDismiss={onDismissError}
            onOpenModelSettings={onOpenModelSettings}
            onOpenUpgrade={onOpenModelUpgrade}
            modelConfigTarget={modelConfigTarget}
          />
        </div>
      ) : null}
      {initialization?.status === "failed" ? (
        // 初始化中只限制执行，不额外显示提示；失败时才显示错误和重试。
        // 状态条悬在可滚动正文上方；必须使用不透明 card，避免历史文字透入错误提示。
        <div
          data-testid="v4-session-initialization"
          role="alert"
          className="mb-2 flex w-full flex-wrap items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
        >
          <span className="min-w-0 flex-1">
            {intl.formatMessage({ id: "chat.initialization.failed" })}
          </span>
          {onRetryInitialization ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="v4-session-initialization-retry"
              onClick={onRetryInitialization}
            >
              {intl.formatMessage({ id: "chat.initialization.retry" })}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        data-highspeed-composer={highspeedCard ? "true" : undefined}
        data-highspeed-entrance={highspeedCard ? highspeedEntrance : undefined}
        className={cn(
          "chat-composer-input-surface relative w-full",
          contextHeader && "rounded-2xl bg-surface shadow-xl/5",
          highspeedCard && "highspeed-composer-surface",
          highspeedPresented && "highspeed-placeholder-presented",
        )}
      >
        {highspeedCard ? (
          <HighspeedComposerBackground
            key={highspeedCard.cardId}
            animated={highspeedEntranceAnimated}
            onModelTransitionStart={handleHighspeedModelTransitionStart}
          />
        ) : null}
        {contextHeader ? (
          // 旧 ChatViewComposer contextHeaderContent 同款包装（workspace 菜单 + Git 分支）。
          <div className="relative z-10 p-1.5 flex min-w-0 flex-wrap items-center gap-0">
            <ComposerSubmissionPendingContext.Provider value={updateTargetSelectionPending}>
              {contextHeader}
            </ComposerSubmissionPendingContext.Provider>
          </div>
        ) : null}
        {conversationSelectionLimitReason ? (
          <div
            role="alert"
            className="relative z-10 mb-2 w-full rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-3 py-2 text-ui-base text-foreground"
          >
            {intl.formatMessage({
              id: `chat.selections.limit.${conversationSelectionLimitReason}`,
            })}
          </div>
        ) : null}
        <ChatPromptEditor
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          taskId={sessionId}
          skillCatalogSessionId={skillCatalogSessionId}
          placeholder={
            remoteAvailable
              ? normalPlaceholder
              : intl.formatMessage({ id: "remote.conversation.sendUnavailable" })
          }
          disabled={disabled || (mode === "reject" && !recoveryAvailable)}
          submitting={pending}
          submitDisabled={
            pending ||
            (!canReload &&
              (runtimeBlocked || !routingAllowsSend || !attachmentsReady || !submissionReady))
          }
          allowSubmitWhenEmpty={
            // 发送按钮已把代码评论视为可发送上下文，但这里曾漏掉同一状态，
            // 导致空文本仅附代码评论时 Enter 被编辑器判为空，必须改点发送按钮。
            hasCodeCommentContexts ||
            hasAttachments ||
            hasWebElementContexts ||
            hasPptxElementReferences ||
            hasConversationSelectionReferences ||
            hasPluginUiContexts
          }
          enterSubmits={enterSubmits}
          onModifiedSubmit={modifiedEnterSubmits ? handleModifiedEditorSubmit : undefined}
          submitLabel={sendTooltipTitle}
          showSlashButton
          // @ 是 Plugin / 文件 / 对话 / 画板主入口；# 会话与 $ / ¥ / ￥ Skills
          // 仍由 MentionPlugin 保留兼容触发，但不在 + 菜单重复展示。
          showMentionButton
          topContent={topContentNode}
          attachmentAction={runtimeBlocked ? undefined : attachmentAction}
          inputTestId={TID_V4_COMPOSER_INPUT}
          inputApiRef={inputApiRef}
          promptHistory={promptHistory}
          avoidIosInputFocusZoom={avoidIosInputFocusZoom}
          compactPlaceholder={compactMobilePlaceholder}
          // Bugfix 原因：命令目录必须完整来自 CLI workspace slash catalog；UI 只在
          // secondary pane 按产品能力隐藏 goal，不再追加任何内建命令或别名。
          excludedSlashCommandNames={suppressGoalCommands ? ["goal"] : undefined}
          appSlashCommands={appSlashCommands?.filter((command) =>
            command.recovery ? recoveryAvailable : !runtimeBlocked,
          )}
          enableMentionPanel
          leadingActions={leadingActionsNode}
          submitControl={submitControlNode}
          layout={layout}
          className="p-0"
          shellClassName={
            highspeedCard
              ? "relative z-10 !rounded-none !border-0 !bg-transparent !transition-none hover:!border-transparent focus-within:!border-transparent focus-within:!bg-transparent"
              : undefined
          }
          onChange={handleEditorChange}
          onUserInputClear={handleUserInputClear}
          onUserInputPresenceChange={handleUserInputPresenceChange}
          onUserInputStart={handleUserInputStart}
          onFocus={handleEditorFocus}
          onSubmit={handleEditorSubmit}
          onWhiteboardMentionSelected={attachmentsApi.handleWhiteboardMentionSelected}
          onPaste={attachmentsApi.handlePaste}
        />
        {attachmentsApi.attachmentError ? (
          <p className="flex items-start gap-2 p-3 text-ui-base text-warning">
            <InfoIcon className="mt-0.5 size-4 shrink-0" />
            <span>{attachmentsApi.attachmentError}</span>
          </p>
        ) : null}
      </div>
      <ImagePreviewDialog
        initialIndex={attachmentPreviewIndex}
        items={composerMediaPreviewItems}
        onOpenChange={setAttachmentPreviewOpen}
        open={attachmentPreviewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfAttachmentPreview}
        open={pdfAttachmentPreviewOpen}
        onOpenChange={(open) => {
          setPdfAttachmentPreviewOpen(open);
          if (!open) setPdfAttachmentPreview(null);
        }}
      />
      <Dialog
        open={heldQueueConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && !pendingRef.current) {
            if (heldQueueConfirmation?.telemetrySeed.localTtft)
              getLocalTtftObserver()?.exclude(
                heldQueueConfirmation.telemetrySeed.localTtft,
                "cancelled",
              );
            setHeldQueueConfirmation(null);
          }
        }}
      >
        <DialogContent
          data-testid={TID_V4_PAUSED_QUEUE_SEND_DIALOG}
          showCloseButton={false}
          className="max-w-xl gap-6 p-6 sm:p-8"
        >
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              disabled={pending}
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute top-4 right-4"
            >
              <XIcon className="size-5" />
            </Button>
          </DialogClose>
          <DialogHeader className="gap-3 pr-8">
            <DialogTitle className="text-xl font-semibold sm:text-2xl">
              {intl.formatMessage({ id: "chat.queue.sendConfirm.title" })}
            </DialogTitle>
            <DialogDescription className="text-ui-base sm:text-ui-lg">
              {intl.formatMessage(
                { id: "chat.queue.sendConfirm.description" },
                {
                  count: String(heldQueueConfirmation?.queueItemIds.length ?? 0),
                },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3 sm:gap-3">
            <Button
              type="button"
              variant="destructive"
              size="lg"
              data-testid={TID_V4_COMPOSER_CLEAR_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleClearQueueSend}
            >
              {intl.formatMessage({ id: "chat.queue.sendConfirm.clear" })}
            </Button>
            <Button
              type="button"
              size="lg"
              data-testid={TID_V4_COMPOSER_KEEP_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleKeepQueueSend}
            >
              {pending ? <Spinner className="size-4" /> : null}
              {intl.formatMessage({ id: "chat.queue.sendConfirm.keep" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const ConversationComposer = memo(ConversationComposerImpl);
