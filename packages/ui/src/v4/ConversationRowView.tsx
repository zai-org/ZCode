import { getLocalTtftObserver } from "@/v4/telemetry/local-ttft/contract.js";
import { GenUiMessageResponse } from "@/gen-ui/index.js";
import { ConversationUserInputBubble } from "@/v4/ConversationUserInputBubble.js";
import { expandTopicInputMessages } from "@/v4/topicInputMessages.js";
import { ConnectedBotGroupDeliveryAction } from "@/v4/BotGroupDeliveryAction.js";
/* oxlint-disable eslint(max-lines) -- v4 逐行 row 渲染分发集中收口（每种 row 一个 memo 叶子 + timelineMarker 分隔线），拆分会打散行类型对照。 */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  type ComponentProps,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CheckIcon,
  Clock,
  CopyIcon,
  FileIcon,
  InfoIcon,
  PencilIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TrendingUpDownIcon,
  XIcon,
} from "lucide-react";
import { parseAutomationRunId } from "@zcode/shared";
import {
  TID_V4_EDIT,
  TID_V4_EDIT_ATTACHMENT_REMOVE,
  TID_V4_EDIT_IN_COMPOSER_HINT,
  TID_V4_FEEDBACK_DISLIKE,
  TID_V4_FEEDBACK_LIKE,
  TID_V4_FORK,
  TID_V4_ROW,
  TID_V4_ROW_ATTACHMENTS,
  testId,
} from "@zcode/shared/test-ids";
import type {
  AttachmentRef,
  ArtifactRow,
  AssistantTextRow,
  ConversationRow,
  ConversationInputSource,
  ConversationRowTarget,
  HookInvocationRow,
  ReasoningRow,
  SubagentRow,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow,
  UnreadableConversationRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { AssistantPreviewCards } from "@/AssistantPreviewCards.js";
import { AssistantCodeCommentCards } from "@/AssistantCodeCommentCards.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";
import type { PdfViewerRangeSource } from "@/components/ui/pdf-viewer.js";
import { MessageAction, MessageActions } from "@/components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import { cn } from "@/components/lib/utils.js";
import { composerEditSessionKey, useComposerEditStore } from "@/composer-edit-mode/index.js";
import { WorkflowToolSummary } from "@/v4/WorkflowToolSummary.js";
import {
  readWorkflowName,
  readWorkflowRetuneCall,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import { WorkflowRetuneRow } from "@/ToolCallBlocks/renderers/WorkflowRetuneRow.js";
import { workflowRunDefaultConcurrency } from "@/components/workflow-timeline/workflowRunSettings.js";
import { isAmendWorkflowToolCall, isFillWorkflowHoleToolCall } from "@/lib/workflowToolNames.js";
import {
  readWorkflowHoleTarget,
  workflowFillCounts,
} from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { resolveWorkflowRunOpenToolCallId } from "@/v4/workflowRunCardJoin.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { requestTaskNavigation } from "@/store/zcodeSessionStoreNavigation.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { logger } from "@/logger.js";
import { PluginUiModelContextChip, formatPluginDisplayName } from "@/plugin-ui/index.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import {
  FileDisplayIcon,
  FileDisplayInline,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import {
  projectAssistantCodeComments,
  type AssistantCodeCommentCard,
} from "@/lib/assistantCodeComment.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  isConversationReasoningRowVisible,
  type ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import {
  countComposerPromptContexts,
  parseComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import { BotGroupSourceLabel } from "@/v4/BotGroupSourceLabel.js";
import { splitUserInputEpilogue } from "@/v4/ConversationUserInputEpilogue.js";
import { ConversationHookDetailsAction } from "@/v4/ConversationHookDetailsAction.js";
import { ConversationTimelineMarkerDivider } from "@/v4/ConversationShareReadonlyTimeline.js";
import { formatMessageTimeLabel } from "@/v4/messageTimeLabel.js";
import { parseConversationShareContext } from "@/lib/conversationShareContext.js";
import {
  ForkDestinationMenu,
  WorktreeCreatedMarker,
  useForkDestination,
} from "@/managed-worktrees/index.js";

function RowShell({
  rowId,
  children,
  className = "",
}: {
  rowId: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-row-id={rowId}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className={cn(className)}
    >
      {children}
    </div>
  );
}

const ArtifactRowView = memo(function ArtifactRowView({ row }: { row: ArtifactRow }) {
  return (
    <RowShell rowId={row.rowId} className="px-4 py-1">
      <div className="flex items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2">
        <FileIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-base text-foreground">{row.displayName}</p>
          <p className="text-ui-sm text-foreground-subtle">
            {row.artifactType.toUpperCase()} · {row.sizeBytes} bytes
          </p>
        </div>
      </div>
    </RowShell>
  );
});

type SessionSource = Extract<ConversationInputSource, { kind: "session" }>;

// 目录树的 tasks 是数组，而来源只有 sessionId。每个提示每次渲染都遍历一遍会随任务规模线性变差，
// 所以按数组引用缓存一份反查表：stabilizeProjectTree 只在内容真变化时换引用，缓存因此自动失效。
const taskByIdCache = new WeakMap<object, Map<string, ProjectTask>>();
function findTaskById(tasks: readonly ProjectTask[], taskId: string): ProjectTask | undefined {
  let index = taskByIdCache.get(tasks);
  if (!index) {
    index = new Map<string, ProjectTask>();
    for (const task of tasks) if (!index.has(task.taskId)) index.set(task.taskId, task);
    taskByIdCache.set(tasks, index);
  }
  return index.get(taskId);
}

/**
 * 跨会话发送的来源提示（规格 0.13）。
 *
 * 标题按「当前事实 → 旧快照 → 身份」回落：持久化载荷只带 sessionId，标题在这里按 id 解析。
 * 旧数据里的 `source.title` 是发送那一刻的快照，多半停在 titleSource=default 档（= 首条提示词
 * 原文），所以只作为解析不到时的兜底，不优先于当前标题。
 *
 * 解析用项目目录树——侧栏与 App 控制工具的 OpenSession 用的是同一份跨项目权威列表，
 * 不另起一份任务索引。全量目录 Context 会随任务活动变化，但只有带会话来源的行才挂这个组件，
 * 重渲染面限于这几条提示本身。
 *
 * 解析不到来源会话（已删除、嵌入 pane 没有目录 owner）时保持可读但不可点击：
 * 跳转需要的 workspacePath 与标题同源，猜路径会把「打不开」变成「打开了别的会话」。
 */
const SessionSourceHint = memo(function SessionSourceHint({ source }: { source: SessionSource }) {
  const { intl } = useZCodeIntl();
  const directory = useOptionalProjectDirectory();
  const task = directory ? findTaskById(directory.tree.tasks, source.sessionId) : undefined;
  const workspacePath = task?.workspacePath;
  const workspaceIdentity = task?.workspaceIdentity;
  const handleOpen = useCallback(() => {
    if (!workspacePath) return;
    requestTaskNavigation({
      taskId: source.sessionId,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
  }, [source.sessionId, workspaceIdentity, workspacePath]);
  const label = intl.formatMessage(
    { id: "conversation.fromSession" },
    { name: task?.title || source.title || source.sessionId },
  );
  return (
    <div
      className="mt-1 text-right text-ui-sm text-foreground-subtlest"
      data-v4-user-input-source="session"
      data-source-session-id={source.sessionId}
    >
      {workspacePath ? (
        <button
          type="button"
          onClick={handleOpen}
          title={intl.formatMessage({ id: "conversation.fromSession.open" })}
          data-source-session-navigable="true"
          className="rounded-sm underline-offset-2 hover:text-foreground-subtle hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {label}
        </button>
      ) : (
        label
      )}
    </div>
  );
});

/**
 * 「这一行读不懂」的占位行（10-protocol-spec §4.4.9，04-sync-and-recovery 封闭规则 13）。
 *
 * 为什么必须画出来而不是返回 null：静默跳过会让用户以为消息丢了，那比显示一条说明更失真。
 * rowId 与 turnId 都保留，所以它就停在原来那条消息的位置上，前后文不会错位。
 *
 * 用中性信息语义而不是 warning 色：会话本身没出错，只是这个 build 认不出其中一行——与
 * ConversationShareReadonlyTimeline 的「部分内容需要更新 ZCode 查看」是同一视觉语言。
 */
const UnreadableRowView = memo(function UnreadableRowView({
  row,
}: {
  row: UnreadableConversationRow;
}) {
  const { intl } = useZCodeIntl();
  return (
    <RowShell rowId={row.rowId} className="px-4 py-1">
      <div
        data-conversation-unreadable-row={row.sourceKind}
        className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-ui-xs text-foreground-subtle"
      >
        <InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          {intl.formatMessage({ id: "conversation.row.unreadable" })}
        </span>
      </div>
    </RowShell>
  );
});

/** 复制行文本：图标 ghost 按钮 + 1200ms 打勾态（对齐旧版 message copy）。
 *  label/tooltip 必须由调用方传入 i18n 文案，禁止硬编码语言。 */
const CopyRowAction = memo(function CopyRowAction({
  text,
  rowId,
  label,
  tooltip = label,
}: {
  text: string;
  rowId: number;
  label: string;
  tooltip?: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (!text || !navigator.clipboard) return;
    void runUserActionAsync({
      input: { featureId: "conversation.history.feedback", action: "copy", trigger: "button" },
      operation: () => navigator.clipboard.writeText(text),
      completed: { resultSource: "platform_result" },
      failureStage: "clipboard_write",
    }).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [text]);
  return (
    <MessageAction
      aria-label={label}
      label={label}
      tooltip={tooltip}
      data-testid={`v4-copy-${rowId}`}
      disabled={text.length === 0}
      onClick={handleCopy}
    >
      {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
    </MessageAction>
  );
});

/** 请求在底部 composer 编辑该 user 行（docs/ui/composer-edit-mode.md）；提交由 composer 完成。 */
export type UserInputEditHandler = (target: ConversationRowTarget) => Promise<void> | void;

type AssistantMessageFeedback = "like" | "dislike";

function getAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

export type AssistantFeedbackHandler = (
  target: ConversationRowTarget,
  feedback: AssistantMessageFeedback | null,
) => Promise<boolean | void> | boolean | void;

export function readAssistantFeedback(row: AssistantTextRow): AssistantMessageFeedback | null {
  // feedback 是 additive V4 row 字段；兼容旧 CLI 的 row 时缺省为 null。
  const feedback = row.feedback;
  return feedback === "like" || feedback === "dislike" ? feedback : null;
}

export interface EditWorkspaceRewindAvailability {
  enabled: boolean;
  reason: "available" | "noFiles" | "reverted" | "running" | "unavailable";
}

export interface ConversationRowViewProps {
  row: ConversationRow;
  /** 渲染上下文（theme/codePreviewSettings/workspacePath）；宿主保证引用稳定。 */
  context: ConversationRowRenderContext;
  /** 完成态 assistant 行的 fork 入口（forkAssistant command）。 */
  onFork?: (target: ConversationRowTarget) => void;
  /** assistant entity 反馈 CAS；UI 先乐观更新，命令失败时回滚。 */
  onFeedbackChange?: AssistantFeedbackHandler;
  /** 协议兼容：上层仍可提供 retryTurn capability，但产品 UI 不渲染普通重试入口。 */
  onRetry?: (target: ConversationRowTarget) => void;
  /** user 行的 edit 入口：进入底部 composer 编辑态，提交走 editUserQuery。 */
  onEdit?: UserInputEditHandler;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  /** 嵌套在工具 Group 内时去掉 Reasoning 内容的重复左导线与缩进。 */
  reasoningContentVariant?: "default" | "nested";
  /** renderer-only 提交状态；不写入协议 row，也不冒充已 drain 的历史事实。 */
  userInputStatus?: string;
  /**
   * 一轮对用户是一个回复：非最后一段 text 不显示任何
   * action（复制/fork 都没有），入口只在轮尾段。
   */
  hideAssistantActions?: boolean;
  /** TurnGroup 需要把轮级 action 延后到文件 summary 后渲染。 */
  deferAssistantActions?: boolean;
  /** 轮尾段的复制内容 = 整轮全部 text 段合并（不是只复制最后一段）。 */
  assistantCopyText?: string;
  /** Assistant Preview Cards 只由 TurnGroup 为轮尾 terminal assistant text 计算后下发。 */
  assistantPreviewCards?: AssistantPreviewCard[];
  /** 仅当前 renderer 观察到 running -> complete 时下发的一次性自动打开身份。 */
  assistantPreviewCardsAutoOpenKey?: string;
  /** Assistant code-comment cards 只由 TurnGroup 为轮尾终态 assistant text 计算后下发。 */
  assistantCodeCommentCards?: AssistantCodeCommentCard[];
  /** 由 TurnGroup 统一裁决整轮正文是否隐藏 code-comment 协议原文。 */
  assistantCodeCommentProjectionEnabled?: boolean;
}

// ── 每种行拆成独立 memo 叶子：虚拟列表下父级重渲染时，只有 props 真变的行重渲染；
// 需要 hook 的行类型（assistantText/toolCall）hook 调用留在各自组件内，避免
// switch 分发组件里出现条件 hook。──

/**
 * 附件渲染：row 仍只保存 AttachmentRef；图片挂载时按 session/ref 分块读取缩略图，点击后复用已加载 URL 进入共享预览。
 * 非图片与失败后的图片保持纯展示，避免无动作的假手型。
 */
const UserInputAttachmentList = memo(function UserInputAttachmentList({
  attachments,
  attachmentIndices,
  entityId,
  attachmentKind = "all",
  directItems = false,
  onRemove,
  rowId,
  sessionId,
  readAttachment,
  readAttachmentRange,
}: {
  attachments: readonly AttachmentRef[] | undefined;
  /** 编辑态删除附件后仍保留其在持久 FilePart 列表中的原序号。 */
  attachmentIndices?: readonly number[];
  entityId?: string;
  attachmentKind?: "all" | "media" | "file";
  directItems?: boolean;
  onRemove?: (index: number) => void;
  rowId: number;
  sessionId?: string;
  readAttachment?: NonNullable<ConversationRowRenderContext["readAttachment"]>;
  readAttachmentRange?: NonNullable<ConversationRowRenderContext["readAttachmentRange"]>;
}) {
  const { intl } = useZCodeIntl();
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [failedRefs, setFailedRefs] = useState<ReadonlySet<string>>(() => new Set());
  const [thumbnailUrls, setThumbnailUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  // 可见消息行预取 image/video Blob：图片直接显示，视频由无控件播放器展示首帧；
  // video URL 同时供 gallery 复用，避免用户点击后再次读取大文件。
  const [videoPreview, setVideoPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [videoPreviewRef, setVideoPreviewRef] = useState<string | null>(null);
  const [videoPreviewLoading, setVideoPreviewLoading] = useState(false);
  const [videoPreviewError, setVideoPreviewError] = useState(false);
  const [textPreview, setTextPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState(false);
  const textReadAbort = useRef<AbortController | null>(null);
  useEffect(() => () => textReadAbort.current?.abort(), []);
  const closeTextPreview = () => {
    textReadAbort.current?.abort();
    textReadAbort.current = null;
    setTextPreview(null);
  };
  const openTextPreview = async (attachment: AttachmentRef, index: number) => {
    if (!sessionId || !readAttachment) return;
    textReadAbort.current?.abort();
    const controller = new AbortController();
    textReadAbort.current = controller;
    setTextPreview({ filename: attachment.fileName, mediaType: "text/plain" });
    setTextLoading(true);
    setTextError(false);
    try {
      const result = await readAttachment({
        sessionId,
        ref: attachment.ref,
        mediaType: attachment.mime,
        ...(entityId ? { target: { rowId, entityId }, attachmentIndex: index } : {}),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!("bytes" in result)) throw new Error("Text attachment bytes unavailable");
      setTextPreview({
        filename: attachment.fileName,
        mediaType: "text/plain",
        textContent: new TextDecoder().decode(result.bytes),
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setTextError(true);
        logger.warn("Text attachment preview failed", error);
      }
    } finally {
      if (!controller.signal.aborted) setTextLoading(false);
    }
  };
  const [pdfPreview, setPdfPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfPreviewLoading, setPdfPreviewLoading] = useState(false);
  const [pdfPreviewError, setPdfPreviewError] = useState(false);
  const [pdfPreviewRef, setPdfPreviewRef] = useState<string | null>(null);
  const pdfPreviewUrlRef = useRef<string | null>(null);
  const pdfPreviewRequestRef = useRef(0);
  const pdfPreviewAbortRef = useRef<AbortController | null>(null);
  const videoPreviewUrlRef = useRef<string | null>(null);
  const videoPreviewRequestRef = useRef(0);
  const videoPreviewAbortRef = useRef<AbortController | null>(null);
  const thumbnailUrlsRef = useRef<Map<string, string>>(new Map());
  const thumbnailObjectUrlsRef = useRef<Set<string>>(new Set());
  const previewOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });
  const previewVideoOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  const previewPdfOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.openPdf",
  });
  const previewUnavailableLabel = intl.formatMessage({
    id: "chat.attachments.preview.unavailable",
  });

  useEffect(() => {
    if (attachmentKind === "file" || !attachments || !sessionId || !readAttachment) {
      return;
    }
    let cancelled = false;
    // 只丢弃读取结果不会停止底层分块传输，消息行卸载后仍可能拉取完整视频。
    // 预取生命周期必须通过 AbortSignal 贯穿 transport，及时释放文件 IO 与 IPC 资源。
    const controller = new AbortController();
    const mediaAttachments = attachments.flatMap((attachment, index) =>
      attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/")
        ? [{ attachment, index }]
        : [],
    );

    // V4 虚拟列表只挂载可见行，避免扫描整段历史。视频仍使用稳定 row target，
    // 保证同一路径多次发送时缩略图来自当前消息的 durable artifact。
    void Promise.all(
      mediaAttachments.map(async ({ attachment, index }) => {
        const ref = attachment.previewRef ?? attachment.ref;
        const isVideo = attachment.mime.startsWith("video/");
        try {
          const result = await readAttachment({
            sessionId,
            ref,
            signal: controller.signal,
            ...(isVideo ? { mediaType: attachment.mime } : {}),
            ...(isVideo && entityId
              ? {
                  target: { rowId, entityId },
                  attachmentIndex: attachmentIndices?.[index] ?? index,
                }
              : {}),
          });
          if (cancelled) return;
          const isLocalUrl = "url" in result;
          const url = isLocalUrl
            ? result.url
            : URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], {
                  type: result.mediaType,
                }),
              );
          if (!isLocalUrl) thumbnailObjectUrlsRef.current.add(url);
          if (cancelled) {
            if (!isLocalUrl) {
              thumbnailObjectUrlsRef.current.delete(url);
              URL.revokeObjectURL(url);
            }
            return;
          }
          thumbnailUrlsRef.current.set(ref, url);
          setThumbnailUrls(new Map(thumbnailUrlsRef.current));
        } catch (error) {
          if (cancelled || controller.signal.aborted) return;
          if (!isVideo) setFailedRefs((current) => new Set(current).add(ref));
          logger.warn(
            `[v4-attachment-preview] failed to read sent ${isVideo ? "video" : "image"} thumbnail`,
            error,
          );
        }
      }),
    );

    return () => {
      controller.abort();
      cancelled = true;
      // Desktop local video 返回自定义协议 URL，不是 renderer 创建的 Blob；
      // 只释放本 effect 创建的 object URL，避免把本地媒体 URL 当成 Blob 生命周期管理。
      for (const url of thumbnailObjectUrlsRef.current) URL.revokeObjectURL(url);
      thumbnailObjectUrlsRef.current.clear();
      thumbnailUrlsRef.current.clear();
    };
  }, [attachmentIndices, attachmentKind, attachments, entityId, readAttachment, rowId, sessionId]);

  // ── sent video 预览读取：staging 语义原样保留 ──
  const releaseVideoPreviewUrl = useCallback(() => {
    if (!videoPreviewUrlRef.current) return;
    URL.revokeObjectURL(videoPreviewUrlRef.current);
    videoPreviewUrlRef.current = null;
  }, []);

  const cancelVideoPreviewRead = useCallback(() => {
    videoPreviewRequestRef.current += 1;
    videoPreviewAbortRef.current?.abort();
    videoPreviewAbortRef.current = null;
  }, []);

  useEffect(
    () => () => {
      cancelVideoPreviewRead();
      releaseVideoPreviewUrl();
    },
    [cancelVideoPreviewRead, releaseVideoPreviewUrl],
  );

  const closeVideoPreview = useCallback(() => {
    cancelVideoPreviewRead();
    releaseVideoPreviewUrl();
    setVideoPreview(null);
    setVideoPreviewRef(null);
    setVideoPreviewLoading(false);
    setVideoPreviewError(false);
  }, [cancelVideoPreviewRead, releaseVideoPreviewUrl]);

  const closePdfPreview = useCallback(() => {
    pdfPreviewRequestRef.current += 1;
    pdfPreviewAbortRef.current?.abort();
    pdfPreviewAbortRef.current = null;
    if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
    pdfPreviewUrlRef.current = null;
    setPdfPreview(null);
    setPdfPreviewRef(null);
    setPdfPreviewLoading(false);
    setPdfPreviewError(false);
  }, []);

  useEffect(
    () => () => {
      closePdfPreview();
    },
    [closePdfPreview],
  );

  const openVideoPreview = useCallback(
    async (attachment: AttachmentRef, attachmentIndex: number, galleryIndex: number) => {
      if (!sessionId || !readAttachment) return;
      const ref = attachment.previewRef ?? attachment.ref;
      cancelVideoPreviewRead();
      const thumbnailUrl = thumbnailUrlsRef.current.get(ref);
      if (thumbnailUrl) {
        releaseVideoPreviewUrl();
        setPreviewIndex(galleryIndex);
        setPreviewOpen(true);
        setVideoPreviewRef(ref);
        setVideoPreview({
          filename: attachment.fileName,
          mediaType: attachment.mime,
          url: thumbnailUrl,
        });
        setVideoPreviewLoading(false);
        setVideoPreviewError(false);
        return;
      }
      const requestId = videoPreviewRequestRef.current;
      const abortController = new AbortController();
      videoPreviewAbortRef.current = abortController;
      releaseVideoPreviewUrl();
      setPreviewIndex(galleryIndex);
      setPreviewOpen(true);
      setVideoPreviewRef(ref);
      setVideoPreview({
        filename: attachment.fileName,
        mediaType: attachment.mime,
      });
      setVideoPreviewLoading(true);
      setVideoPreviewError(false);
      try {
        const result = await readAttachment({
          sessionId,
          ref,
          mediaType: attachment.mime,
          // 有 entityId 时按稳定 row target 精确读取；否则退回按 ref 匹配。
          ...(entityId ? { target: { rowId, entityId }, attachmentIndex } : {}),
          signal: abortController.signal,
        });
        if (videoPreviewRequestRef.current !== requestId) return;
        const isLocalUrl = "url" in result;
        const url = isLocalUrl
          ? result.url
          : URL.createObjectURL(
              new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
            );
        if (videoPreviewRequestRef.current !== requestId) {
          if (!isLocalUrl) URL.revokeObjectURL(url);
          return;
        }
        videoPreviewUrlRef.current = isLocalUrl ? null : url;
        setVideoPreview({
          filename: attachment.fileName,
          mediaType: result.mediaType,
          url,
        });
      } catch (error) {
        if (videoPreviewRequestRef.current !== requestId) return;
        // 一次 read 失败曾永久禁用附件入口，把可否打开 Dialog 错绑到读取结果。
        // 失败只属于本次预览；保留入口，让每次打开都重新读取并在 Dialog 内展示错误。
        setVideoPreviewError(true);
        logger.warn("[v4-attachment-preview] failed to read sent media", error);
      } finally {
        if (videoPreviewRequestRef.current === requestId) {
          videoPreviewAbortRef.current = null;
          setVideoPreviewLoading(false);
        }
      }
    },
    [cancelVideoPreviewRead, entityId, readAttachment, releaseVideoPreviewUrl, rowId, sessionId],
  );

  const openPdfPreview = useCallback(
    async (attachment: AttachmentRef, attachmentIndex: number) => {
      if (!sessionId || (!readAttachment && !readAttachmentRange)) return;
      const ref = attachment.previewRef ?? attachment.ref;
      pdfPreviewRequestRef.current += 1;
      const requestId = pdfPreviewRequestRef.current;
      pdfPreviewAbortRef.current?.abort();
      const abortController = new AbortController();
      pdfPreviewAbortRef.current = abortController;
      if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
      pdfPreviewUrlRef.current = null;
      setPdfPreviewRef(ref);
      setPdfPreview({ filename: attachment.fileName, mediaType: "application/pdf" });
      setPdfPreviewLoading(true);
      setPdfPreviewError(false);
      try {
        const target = entityId ? { target: { rowId, entityId }, attachmentIndex } : {};
        if (readAttachmentRange) {
          const firstRange = await readAttachmentRange({
            sessionId,
            ref,
            ...target,
            offset: 0,
            limit: 256 * 1024,
            signal: abortController.signal,
          });
          const source: PdfViewerRangeSource = {
            totalBytes: firstRange.totalBytes,
            initialData: firstRange.bytes,
            requestRange: async (offset, limit) => {
              const range = await readAttachmentRange({
                sessionId,
                ref,
                ...target,
                offset,
                limit,
                signal: abortController.signal,
              });
              return range.bytes;
            },
          };
          if (pdfPreviewRequestRef.current !== requestId) return;
          setPdfPreview({
            filename: attachment.fileName,
            mediaType: firstRange.mediaType,
            pdfSource: source,
          });
          return;
        }
        if (!readAttachment) return;
        const result = await readAttachment({
          sessionId,
          ref,
          ...target,
          signal: abortController.signal,
        });
        if (pdfPreviewRequestRef.current !== requestId) return;
        const url =
          "url" in result
            ? result.url
            : URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
              );
        if (!("url" in result)) pdfPreviewUrlRef.current = url;
        setPdfPreview({
          filename: attachment.fileName,
          mediaType: result.mediaType,
          url,
        });
      } catch (error) {
        if (pdfPreviewRequestRef.current !== requestId) return;
        setPdfPreviewError(true);
        logger.warn("[v4-attachment-preview] failed to read sent PDF", error);
      } finally {
        if (pdfPreviewRequestRef.current === requestId) {
          pdfPreviewAbortRef.current = null;
          setPdfPreviewLoading(false);
        }
      }
    },
    [entityId, readAttachment, readAttachmentRange, rowId, sessionId],
  );

  const visibleAttachments = (attachments ?? [])
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => {
      if (attachmentKind === "all") return true;
      const isMedia = attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/");
      return attachmentKind === "media" ? isMedia : !isMedia;
    });
  if (attachmentKind === "all") {
    // 行内编辑器过去直接沿用只读消息的通用附件列表，既没有按输入框的
    // “媒体 → 文件”视觉顺序排列，也误用了已发送消息的 pill。排序只改变渲染顺序，
    // index 仍指向原数组，避免删除后提交错误的附件。
    visibleAttachments.sort(
      ({ attachment: left }, { attachment: right }) =>
        Number(right.mime.startsWith("image/") || right.mime.startsWith("video/")) -
        Number(left.mime.startsWith("image/") || left.mime.startsWith("video/")),
    );
  }
  if (visibleAttachments.length === 0) return null;
  const previewEntries = (attachments ?? []).flatMap((attachment, index) => {
    const isImage = attachment.mime.startsWith("image/");
    const isVideo = attachment.mime.startsWith("video/");
    if (!isImage && !isVideo) return [];
    const ref = attachment.previewRef ?? attachment.ref;
    const src = thumbnailUrls.get(ref);
    if (isImage && !src) return [];
    return [
      {
        attachment,
        index,
        persistedAttachmentIndex: attachmentIndices?.[index] ?? index,
      },
    ];
  });
  const previewItems = previewEntries.map(({ attachment }) => {
    const ref = attachment.previewRef ?? attachment.ref;
    const isVideo = attachment.mime.startsWith("video/");
    return {
      alt: attachment.fileName,
      filename: attachment.fileName,
      mediaType: attachment.mime,
      src: isVideo && videoPreviewRef === ref ? videoPreview?.url : thumbnailUrls.get(ref),
      loading: isVideo && videoPreviewRef === ref && videoPreviewLoading,
      error: isVideo && videoPreviewRef === ref && videoPreviewError,
    };
  });
  const selectPreviewItem = (galleryIndex: number) => {
    const entry = previewEntries[galleryIndex];
    if (!entry) return;
    if (entry.attachment.mime.startsWith("video/")) {
      void openVideoPreview(entry.attachment, entry.persistedAttachmentIndex, galleryIndex);
      return;
    }
    cancelVideoPreviewRead();
    releaseVideoPreviewUrl();
    setVideoPreview(null);
    setVideoPreviewRef(null);
    setVideoPreviewLoading(false);
    setVideoPreviewError(false);
    setPreviewIndex(galleryIndex);
    setPreviewOpen(true);
  };
  const items = visibleAttachments.map(({ attachment, index }) => {
    const isTextMaterial =
      attachment.sourceKind === "topic-history" || attachment.sourceKind === "clipboard-text";
    const ref = attachment.previewRef ?? attachment.ref;
    const isImage = attachment.mime.startsWith("image/");
    const isVideo = attachment.mime.startsWith("video/");
    const isPdf = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
    const isMedia = isImage || isVideo;
    const isEditingAttachment = attachmentKind === "all";
    const isThumbnail = attachmentKind === "media" || (isEditingAttachment && isMedia);
    const fileDisplayDescriptor = resolveFileDisplayDescriptor(attachment.fileName);
    const isUnavailable = failedRefs.has(ref);
    const thumbnailUrl = thumbnailUrls.get(ref) ?? "";
    const previewItemIndex = previewEntries.findIndex((entry) => entry.index === index);
    // 图片与视频共用当前消息的媒体 gallery；video 首次成为 active item 时再读取。
    const canOpen =
      (isTextMaterial && Boolean(sessionId && readAttachment)) ||
      (isImage && !isUnavailable && previewItemIndex >= 0) ||
      (isVideo && Boolean(sessionId && readAttachment)) ||
      (isPdf && Boolean(sessionId && (readAttachment || readAttachmentRange)));
    return (
      <Attachment
        key={`${attachment.ref}-${index}`}
        variant={isThumbnail ? "grid" : "inline"}
        data-v4-user-edit-attachment-kind={
          isEditingAttachment
            ? isImage
              ? "image"
              : isVideo
                ? "video"
                : isPdf
                  ? "pdf"
                  : "file"
            : undefined
        }
        data-v4-user-input-attachment-pill={isThumbnail ? undefined : "true"}
        data-v4-user-input-media-attachment={isThumbnail ? "true" : undefined}
        className={cn(
          isThumbnail &&
            (isEditingAttachment
              ? "relative size-12 overflow-hidden rounded-lg bg-surface p-0 after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-[''] hover:bg-surface-hover"
              : "relative size-20 overflow-hidden rounded-xl bg-surface p-0 after:pointer-events-none after:absolute after:inset-0 after:rounded-xl after:border after:border-border after:content-[''] hover:bg-surface-hover"),
          !isThumbnail &&
            (isEditingAttachment
              ? "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover"
              : "rounded-full border-0 bg-surface px-3 py-1.5 hover:bg-surface-hover"),
        )}
        onRemove={onRemove ? () => onRemove(index) : undefined}
        onOpen={
          canOpen
            ? () =>
                isTextMaterial
                  ? void openTextPreview(attachment, attachmentIndices?.[index] ?? index)
                  : isPdf
                    ? void openPdfPreview(attachment, attachmentIndices?.[index] ?? index)
                    : selectPreviewItem(previewItemIndex)
            : undefined
        }
        openLabel={
          canOpen
            ? isTextMaterial
              ? intl.formatMessage({ id: "chat.attachments.preview.openText" })
              : isVideo
                ? previewVideoOpenLabel
                : isPdf
                  ? previewPdfOpenLabel
                  : previewOpenLabel
            : undefined
        }
        title={isUnavailable ? previewUnavailableLabel : undefined}
        data={{
          id: `${rowId}-${index}`,
          type: "file",
          filename: attachment.fileName,
          mediaType: attachment.mime,
          url: thumbnailUrl,
        }}
      >
        {isThumbnail ? (
          <div className="relative size-full">
            <AttachmentPreview className="size-full rounded-none" />
          </div>
        ) : isEditingAttachment ? (
          <>
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background">
              <FileDisplayIcon
                src={fileDisplayDescriptor.fileIconSrc}
                size={16}
                className="size-4 shrink-0"
              />
            </div>
            <div className="min-w-0 max-w-40 flex-1">
              <span
                className="block truncate text-ui-base font-medium text-foreground"
                title={attachment.fileName}
              >
                {attachment.fileName}
              </span>
              <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                {getAttachmentTypeLabel(attachment.fileName, attachment.mime)}
              </span>
            </div>
          </>
        ) : attachment.sourceKind === "topic-history" ? (
          <span className="truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage(
              { id: "chat.attachments.topicHistory" },
              { count: attachment.messageCount ?? 0 },
            )}
          </span>
        ) : (
          <FileDisplayInline
            path={attachment.fileName}
            options={{
              className: "inline-flex min-w-0 max-w-40 items-center gap-1.5",
              iconSize: 16,
              fileNameClassName: "truncate text-ui-base font-medium text-foreground",
            }}
          />
        )}
        {onRemove && isEditingAttachment ? (
          <AttachmentRemove
            placement="corner"
            size="icon"
            variant="default"
            aria-label={intl.formatMessage({ id: "chat.attachments.remove" })}
            label={intl.formatMessage({ id: "chat.attachments.remove" })}
            data-testid={testId(TID_V4_EDIT_ATTACHMENT_REMOVE, `${rowId}-${index}`)}
            className="absolute top-0.5 right-0.5 z-10 size-3.5 rounded-full p-0 text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <XIcon className="size-2.5" />
          </AttachmentRemove>
        ) : null}
      </Attachment>
    );
  });
  return (
    <>
      {directItems ? (
        items
      ) : (
        <Attachments
          variant="inline"
          data-testid={testId(TID_V4_ROW_ATTACHMENTS, String(rowId))}
          className="max-w-full gap-2"
        >
          {items}
        </Attachments>
      )}
      <ChatMediaAttachmentPreviewDialog
        attachment={textPreview}
        open={textPreview !== null}
        onOpenChange={(open) => {
          if (!open) closeTextPreview();
        }}
        loading={textLoading}
        error={textError}
      />
      <ImagePreviewDialog
        initialIndex={previewIndex}
        items={previewItems}
        onActiveIndexChange={selectPreviewItem}
        onOpenChange={(open) => {
          if (open) {
            setPreviewOpen(true);
            return;
          }
          setPreviewOpen(false);
          closeVideoPreview();
        }}
        open={previewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfPreview}
        open={pdfPreviewRef !== null}
        loading={pdfPreviewLoading}
        error={pdfPreviewError}
        onOpenChange={(open) => {
          if (!open) closePdfPreview();
        }}
      />
    </>
  );
});

const SingleUserInputRowView = memo(function SingleUserInputRowView({
  row,
  context,
  onEdit,
  editWorkspaceRewindAvailability,
  status,
}: {
  row: UserInputRow;
  context: ConversationRowRenderContext;
  onEdit?: UserInputEditHandler;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  status?: string;
}) {
  const { intl } = useZCodeIntl();
  // 引擎尾注折叠：正文只到 epilogueStart，
  // 之后的引擎文本折进气泡底部的披露。提示词上下文解析也只看正文——尾注里没有用户引用。
  const { body: bodyText, epilogue } = splitUserInputEpilogue(row.text, row.epilogueStart);
  const parsedPrompt = useMemo(
    () => ({
      ...parseComposerPromptContexts(bodyText, {
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      }),
      ...(row.conversationQuotes ? { conversationSelections: row.conversationQuotes } : {}),
    }),
    [context.workspaceIdentity, context.workspacePath, bodyText, row.conversationQuotes],
  );
  // 只用于把历史消息里的 share URL 尾块从可见正文里剥掉。
  // 该块已不再产出（见 ConversationComposer 的 promptText 注释）；这里保留解析，是为了让
  // 接线修复到本次删除之间发出的消息不至于把裸 markup 当正文显示出来。
  const parsedShareContext = useMemo(
    () => parseConversationShareContext(parsedPrompt.visibleContent),
    [parsedPrompt.visibleContent],
  );
  const editSessionKey = context.sessionId
    ? composerEditSessionKey(
        context.workspaceIdentity?.trim() || context.workspacePath,
        context.sessionId,
      )
    : null;
  // 只订阅本行是否为编辑目标，避免编辑态变化让整条时间线重渲染。
  const editingInComposer = useComposerEditStore((state) => {
    const target = editSessionKey ? state.sessions[editSessionKey]?.target : undefined;
    return target?.kind === "userQuery" && target.rowId === row.rowId;
  });
  useEffect(() => {
    if (!editingInComposer || !editSessionKey || !editWorkspaceRewindAvailability) return;
    // 「对话 + 文件重置」的可用性只有本行知道；编辑期间同步给 composer 状态条。
    useComposerEditStore.getState().update(editSessionKey, {
      workspaceRewind: {
        enabled: editWorkspaceRewindAvailability.enabled,
        reason: editWorkspaceRewindAvailability.reason,
      },
    });
  }, [editSessionKey, editWorkspaceRewindAvailability, editingInComposer]);
  const handleFocusComposerEdit = useCallback(() => {
    if (editSessionKey) useComposerEditStore.getState().requestFocus(editSessionKey);
  }, [editSessionKey]);
  const visibleText = parsedShareContext.visibleContent;
  const codeCommentContexts = parsedPrompt.codeComments;
  // 设计稿元素在正文里已经画成 token，卡片只给普通网页「选择元素」的引用
  const webElementContexts = useMemo(
    () => parsedPrompt.webElements.filter((context) => !context.inline),
    [parsedPrompt.webElements],
  );
  const pptxElementReferences = parsedPrompt.pptxElements;
  const conversationSelections = parsedPrompt.conversationSelections;
  const hasAttachments = (row.attachments?.length ?? 0) > 0;
  const hasMediaAttachments =
    row.attachments?.some(
      (attachment) => attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasFileAttachments =
    row.attachments?.some(
      (attachment) =>
        !attachment.mime.startsWith("image/") && !attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasVisibleText = visibleText.trim().length > 0;
  const pluginUiContexts = parsedPrompt.pluginUiContexts;
  // nudge 轮整条都是引擎文本：正文为空但气泡仍要画，里面只有那一枚披露。
  const hasBubble = hasVisibleText || epilogue !== undefined;
  const hasContextReferences =
    codeCommentContexts.length > 0 ||
    webElementContexts.length > 0 ||
    pptxElementReferences.length > 0 ||
    conversationSelections.length > 0 ||
    pluginUiContexts.length > 0;
  const hasAttachmentArea = hasAttachments || hasContextReferences;
  const hasAttachmentPills =
    hasFileAttachments ||
    codeCommentContexts.length > 0 ||
    webElementContexts.length > 0 ||
    pptxElementReferences.length > 0 ||
    (!row.botGroupSource && conversationSelections.length > 0);
  // Bug 根因：旧逻辑只接受 schedule runId，导致用户点击「立即运行」产生的 manual run
  // 没有来源标识。两种合法 automation runId 都应展示；普通会话输入仍因解析失败而不展示。
  const isScheduledAutomationPrompt = parseAutomationRunId(row.sourceCommandId ?? "") !== null;
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath: context.workspacePath,
    workspaceIdentity: context.workspaceIdentity,
    remoteSessionId: context.workspaceRemoteSessionId,
    onOpenCodeViewer: context.onOpenCodeViewer,
  });

  const handleOpenEdit = useCallback(() => {
    if (!onEdit || !row.entityId) return;
    void onEdit({ rowId: row.rowId, entityId: row.entityId });
  }, [onEdit, row.entityId, row.rowId]);

  return (
    <RowShell rowId={row.rowId} className="group/user-row flex flex-col items-end">
      {isScheduledAutomationPrompt ? (
        <div
          data-v4-user-input-automation-origin="schedule"
          className="mb-1 flex max-w-xl items-center gap-1 text-ui-sm text-foreground-subtle"
        >
          <Clock data-cron-task-icon="true" aria-hidden="true" className="size-3.5 shrink-0" />
          <span>{intl.formatMessage({ id: "chat.message.sentByScheduledTask" })}</span>
        </div>
      ) : null}
      {row.botGroupSource ? (
        // 群来源原先插在材料与正文之间，割裂同一输入；统一放在材料之前。
        <div data-v4-user-input-source="true" className="mb-2 flex min-w-0 max-w-full">
          <BotGroupSourceLabel source={row.botGroupSource} />
        </div>
      ) : null}

      {hasAttachmentArea ? (
        <div
          data-v4-user-input-attachments="true"
          data-testid={testId(TID_V4_ROW_ATTACHMENTS, String(row.rowId))}
          className="mb-2 flex max-w-xl flex-col items-end gap-2"
        >
          {row.botGroupSource && conversationSelections.length > 0 ? (
            <div data-v4-user-input-quotes="true" className="flex max-w-full justify-end">
              <ConversationSelectionReferenceChip
                references={conversationSelections}
                contentAlign="end"
              />
            </div>
          ) : null}
          {hasMediaAttachments ? (
            <div
              data-v4-user-input-media-attachments="true"
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              <UserInputAttachmentList
                attachments={row.attachments}
                entityId={row.entityId}
                attachmentKind="media"
                directItems
                rowId={row.rowId}
                sessionId={context.sessionId ?? undefined}
                readAttachment={context.readAttachment}
                readAttachmentRange={context.readAttachmentRange}
              />
            </div>
          ) : null}
          {hasAttachmentPills ? (
            <div
              data-v4-user-input-attachment-pills="true"
              // 非媒体文件与上下文引用必须共享这一层，才能在换行时
              // 保持“文件→评论→网页→PPT→对话引用”的顺序和统一右对齐。
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              {hasFileAttachments ? (
                <UserInputAttachmentList
                  attachments={row.attachments}
                  entityId={row.entityId}
                  attachmentKind="file"
                  directItems
                  rowId={row.rowId}
                  sessionId={context.sessionId ?? undefined}
                  readAttachment={context.readAttachment}
                  readAttachmentRange={context.readAttachmentRange}
                />
              ) : null}
              <CodeCommentAttachmentChip comments={codeCommentContexts} contentAlign="end" />
              <WebElementContextAttachmentChip contexts={webElementContexts} contentAlign="end" />
              <PptxElementReferenceChip
                references={pptxElementReferences}
                contentAlign="end"
                onOpen={context.onOpenCodeViewer ? openPptxElementReference : undefined}
              />
              {!row.botGroupSource ? (
                <ConversationSelectionReferenceChip
                  references={conversationSelections}
                  contentAlign="end"
                />
              ) : null}
              <PluginUiModelContextChip contexts={pluginUiContexts} contentAlign="end" />
            </div>
          ) : null}
        </div>
      ) : null}
      {hasBubble ? (
        // 附件和上下文引用只属于消息行，不属于气泡；否则仅附件消息会留下空气泡。
        // 同一 row 会渲染在主会话和 Subagent 侧栏，固定宽度会忽略实际宿主宽度。
        // 气泡保留 flex item 的自动宽度；宿主至少 624px 时再以 36rem 封顶并保留 48px 余量。
        <ConversationUserInputBubble
          text={visibleText}
          imagePreviewContext={context}
          contentParts={row.botGroupSource?.contentParts}
          rowId={row.rowId}
          epilogue={epilogue}
          attachments={row.attachments}
          contextAttachmentCount={countComposerPromptContexts(parsedPrompt)}
        />
      ) : null}
      {row.source?.kind === "session" && <SessionSourceHint source={row.source} />}
      {row.source?.kind === "genUi" && (
        <div
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
          data-v4-user-input-source="genUi"
        >
          {intl.formatMessage({ id: "genUi.from" }, { name: row.source.title || "Gen UI" })}
        </div>
      )}
      {row.source?.kind === "pluginUi" || row.source?.kind === "extension" ? (
        // 插件 UI 或扩展（docs/plugins/extension-host.md §17.8）代发：来源标记来自 CLI 持久化的 intent.source，
        // 不由 renderer 推断。两者同一句文案；名字取插件 id 的名字部分，手机没有扩展静态表，桌面与手机一致。
        <div
          data-v4-user-input-source={row.source.pluginId}
          data-v4-user-input-source-kind={row.source.kind}
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
        >
          {intl.formatMessage(
            { id: "pluginUi.fromPlugin" },
            { name: formatPluginDisplayName(row.source.pluginId) },
          )}
        </div>
      ) : null}
      {status ? (
        <div
          data-v4-user-input-status="true"
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
          aria-live="polite"
        >
          {status}
        </div>
      ) : null}
      {/* Bugfix：手机远控没有 hover，v4 迁移时漏掉了旧 UserMessage 的常显分支，
          导致复制和编辑入口不可发现；远控直接显示，桌面端继续通过 hover/focus 降噪。 */}
      <MessageActions
        className={cn(
          "mt-1",
          context.compactForRemoteControl
            ? "opacity-100"
            : "opacity-0 transition-opacity group-hover/user-row:opacity-100 focus-within:opacity-100",
        )}
      >
        <CopyRowAction
          text={row.text}
          rowId={row.rowId}
          label={intl.formatMessage({ id: "chat.message.copy" })}
        />
        {onEdit && row.entityId && !editingInComposer ? (
          <MessageAction
            label={intl.formatMessage({ id: "chat.message.edit" })}
            tooltip={intl.formatMessage({ id: "chat.message.edit" })}
            data-testid={testId(TID_V4_EDIT, String(row.rowId))}
            onClick={handleOpenEdit}
          >
            <PencilIcon className="size-3.5" />
          </MessageAction>
        ) : null}
      </MessageActions>
      {editingInComposer ? (
        <button
          type="button"
          data-testid={testId(TID_V4_EDIT_IN_COMPOSER_HINT, String(row.rowId))}
          className="mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ui-sm text-foreground-subtle hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          onClick={handleFocusComposerEdit}
        >
          <PencilIcon className="size-3.5" aria-hidden />
          {intl.formatMessage({ id: "chat.composerEdit.inComposerHint" })}
        </button>
      ) : null}
    </RowShell>
  );
});

const UserInputRowView = memo(function UserInputRowView(
  props: ComponentProps<typeof SingleUserInputRowView>,
) {
  const rows = useMemo(() => expandTopicInputMessages(props.row), [props.row]);
  if (rows.length === 1) return <SingleUserInputRowView {...props} row={rows[0]!} />;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-v4-topic-messages="true">
      {rows.map((row) => (
        <div
          key={row.botGroupSource!.messageId}
          data-topic-message-id={row.botGroupSource!.messageId}
        >
          {/* 多条原文共用一个已接收输入，不能把局部编辑误当作替换整批。 */}
          <SingleUserInputRowView {...props} row={row} onEdit={undefined} />
        </div>
      ))}
    </div>
  );
});

// memo 组件的数组默认值必须是模块级常量：内联 [] 每次渲染都是新引用，会让 memo 比较失效。
const EMPTY_SOURCE_COMMAND_IDS: readonly string[] = [];

export const ConversationAssistantTextActions = memo(function ConversationAssistantTextActions({
  rowId,
  entityId,
  text,
  createdAt,
  compactForRemoteControl = false,
  feedback = null,
  hookInvocations,
  sessionId,
  turnId,
  sourceCommandIds = EMPTY_SOURCE_COMMAND_IDS,
  onFork,
  onFeedbackChange,
  className,
}: {
  rowId: number;
  entityId?: string;
  text: string;
  createdAt: number;
  compactForRemoteControl?: boolean;
  feedback?: AssistantMessageFeedback | null;
  hookInvocations?: readonly HookInvocationRow[];
  sessionId?: string | null;
  turnId?: string;
  sourceCommandIds?: readonly string[];
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  className?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [localFeedback, setLocalFeedback] = useState<AssistantMessageFeedback | null>(feedback);
  const copyLabel = intl.formatMessage({ id: "chat.message.copy" });
  const likeLabel = intl.formatMessage({
    id: localFeedback === "like" ? "chat.message.liked" : "chat.message.like",
  });
  const dislikeLabel = intl.formatMessage({
    id: localFeedback === "dislike" ? "chat.message.disliked" : "chat.message.dislike",
  });
  const forkLabel = intl.formatMessage({ id: "chat.message.fork" });
  const timeLabel = formatMessageTimeLabel(createdAt, locale, intl);
  const resolveTooltip = (label: string): string | undefined =>
    compactForRemoteControl ? undefined : label;

  useEffect(() => {
    setLocalFeedback(feedback);
  }, [feedback]);

  const handleFeedback = useCallback(
    (nextFeedback: AssistantMessageFeedback) => {
      const previousFeedback = localFeedback;
      const resolvedFeedback = previousFeedback === nextFeedback ? null : nextFeedback;
      setLocalFeedback(resolvedFeedback);
      logger.info("[ConversationRowView] 用户反馈 assistant 消息", {
        messageId: entityId ?? null,
        reaction: resolvedFeedback ?? "none",
      });
      if (entityId) {
        void Promise.resolve(onFeedbackChange?.({ rowId, entityId }, resolvedFeedback)).then(
          (result) => {
            if (result === false) setLocalFeedback(previousFeedback);
          },
          (error: unknown) => {
            setLocalFeedback(previousFeedback);
            // V4 初版只改 renderer local state，command 失败后会显示并不存在的反馈。
            // 失败必须回滚到点击前投影值，等待后续权威 row 再校正。
            logger.warn("[ConversationRowView] 持久化 assistant 反馈失败", {
              error: error instanceof Error ? error.message : String(error),
              messageId: entityId,
            });
          },
        );
      }
      if (platform && entityId) {
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "assistant_message_feedback",
            eventRegion: "chat",
            eventType: "ck",
            eventExtraDetail: { reaction: resolvedFeedback ?? "none" },
            ...(sessionId ? { talkId: sessionId } : {}),
            messageId: entityId,
          },
          "ConversationRowView",
        );
      }
    },
    [entityId, localFeedback, onFeedbackChange, platform, rowId, sessionId],
  );
  const handleFork = useCallback(() => {
    if (entityId) {
      runUserAction({
        input: { featureId: "conversation.history.branch", action: "fork", trigger: "button" },
        operation: () => onFork?.({ rowId, entityId }),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "fork",
      });
    }
  }, [entityId, onFork, rowId]);
  const forkDestination = useForkDestination();
  const forkToWorktree = forkDestination.forkToWorktree;
  const handleForkToWorktree = useCallback(() => {
    if (entityId && forkToWorktree) forkToWorktree({ rowId, entityId });
  }, [entityId, forkToWorktree, rowId]);
  return (
    <MessageActions className={cn(className, "has-[[data-bot-group-delivery]]:opacity-100")}>
      <CopyRowAction
        text={text}
        rowId={rowId}
        label={copyLabel}
        tooltip={resolveTooltip(copyLabel)}
      />
      {entityId && onFeedbackChange ? (
        <>
          <MessageAction
            aria-label={likeLabel}
            aria-pressed={localFeedback === "like"}
            label={likeLabel}
            tooltip={resolveTooltip(likeLabel)}
            data-testid={testId(TID_V4_FEEDBACK_LIKE, String(rowId))}
            className={localFeedback === "like" ? "!bg-success/10" : undefined}
            onClick={() => handleFeedback("like")}
          >
            <span
              className={cn(
                "relative inline-flex",
                localFeedback === "like" && "zcode-reaction-burst",
              )}
            >
              <ThumbsUpIcon className="size-3.5" />
            </span>
          </MessageAction>
          <MessageAction
            aria-label={dislikeLabel}
            aria-pressed={localFeedback === "dislike"}
            label={dislikeLabel}
            tooltip={resolveTooltip(dislikeLabel)}
            data-testid={testId(TID_V4_FEEDBACK_DISLIKE, String(rowId))}
            className={localFeedback === "dislike" ? "!bg-warning/10" : undefined}
            onClick={() => handleFeedback("dislike")}
          >
            <span
              className={cn(
                "relative inline-flex",
                localFeedback === "dislike" && "zcode-reaction-burst",
              )}
            >
              <ThumbsDownIcon className="size-3.5" />
            </span>
          </MessageAction>
        </>
      ) : null}
      {onFork && entityId ? (
        forkToWorktree ? (
          <ForkDestinationMenu
            rowId={rowId}
            label={forkLabel}
            tooltip={resolveTooltip(forkLabel)}
            worktreeAvailable={forkDestination.available}
            inWorktree={forkDestination.inWorktree}
            onForkHere={handleFork}
            onForkToWorktree={handleForkToWorktree}
          />
        ) : (
          <MessageAction
            aria-label={forkLabel}
            label={forkLabel}
            tooltip={resolveTooltip(forkLabel)}
            data-testid={testId(TID_V4_FORK, String(rowId))}
            onClick={handleFork}
          >
            <TrendingUpDownIcon className="size-3.5" />
          </MessageAction>
        )
      ) : null}
      {turnId && hookInvocations ? (
        <ConversationHookDetailsAction rows={hookInvocations} turnId={turnId} />
      ) : null}
      {/* Bugfix: 旧 conversation surface 删除后，V4 动作栏漏掉了消息创建时间；
          时间是 row.createdAt 的只读派生展示，不新增 renderer 状态。 */}
      {timeLabel ? (
        <span className="select-none text-ui-sm text-foreground-subtlest">{timeLabel}</span>
      ) : null}
      {turnId ? (
        <ConnectedBotGroupDeliveryAction turnId={turnId} sourceCommandIds={sourceCommandIds} />
      ) : null}
    </MessageActions>
  );
});

const AssistantTextRowView = memo(function AssistantTextRowView({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  hideActions,
  deferActions,
  copyText,
  previewCards,
  previewCardsAutoOpenKey,
  codeCommentCards,
  codeCommentProjectionEnabled,
}: {
  row: AssistantTextRow;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  hideActions?: boolean;
  deferActions?: boolean;
  copyText?: string;
  previewCards?: AssistantPreviewCard[];
  previewCardsAutoOpenKey?: string;
  codeCommentCards?: AssistantCodeCommentCard[];
  codeCommentProjectionEnabled?: boolean;
}) {
  const streaming = row.state === "streaming";
  const isOfficeMode = useIsOfficeMode();
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const projectsCodeComments = codeCommentCardsEnabled && codeCommentProjectionEnabled === true;
  const visibleText = useMemo(
    () =>
      projectsCodeComments
        ? projectAssistantCodeComments(row.text, { streaming }).visibleText
        : row.text,
    [projectsCodeComments, row.text, streaming],
  );
  const visiblePreviewCards = previewCards && previewCards.length > 0 ? previewCards : null;
  const textElement = useRef<HTMLDivElement>(null);
  const paintFrames = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const frame of paintFrames.current) cancelAnimationFrame(frame);
    },
    [],
  );
  useLayoutEffect(() => {
    if (context.workspaceIdentity || !context.sessionId) return;
    const observer = getLocalTtftObserver();
    const args = [context.workspacePath, context.sessionId, row.turnId, row.rowId] as const;
    if (!observer?.needsTextRender(...args)) return;
    const element = textElement.current;
    if (!element?.textContent?.trim()) return;
    const visible = () => {
      if (
        !element.isConnected ||
        document.visibilityState !== "visible" ||
        !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      )
        return false;
      const rect = element.getBoundingClientRect();
      return (
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };
    if (!observer.textRendered(...args, "committed", visible())) return;
    // 接收帧早于 React 提交；两次 rAF 只代表经过绘制机会，不能声称像素已上屏。
    // 流式文本更新不能取消首帧观察，仅组件卸载取消，避免高频更新把计时拖到整轮结束。
    paintFrames.current.push(
      requestAnimationFrame(() => {
        paintFrames.current.push(
          requestAnimationFrame(() => {
            observer.textRendered(...args, "paint_estimate", visible());
          }),
        );
      }),
    );
  }, [
    context.workspaceIdentity,
    context.workspacePath,
    context.sessionId,
    row.turnId,
    row.rowId,
    visibleText,
  ]);
  return (
    <RowShell rowId={row.rowId} className="group/assistant-row">
      {/* M5④ 阶段2：assistant 文本走 streamdown（MessageResponse），
          markdown/代码块正式渲染；streaming 模式对未闭合 markdown 容错。 */}
      {/* Bugfix：MessageResponse 只消费自身声明的 props，不会把 data-* 透传到真实 DOM，
          导致 assistant 正文虽然在 JSX 上标了 selectable，框选逻辑却永远找不到该区域。
          selectable 语义必须放在稳定的 DOM 包装层上，完成态和 streaming 共用同一路径。 */}
      <div ref={textElement} data-conversation-selectable="true" className="w-full text-ui-base">
        <GenUiMessageResponse
          completed={row.state === "complete"}
          messageKey={`${row.rowId}:${row.entityId ?? ""}`}
          renderZCodeFileCitations
          streaming={streaming}
          workspacePath={context.workspacePath}
          workspaceIdentity={context.workspaceIdentity}
          workspaceRemoteSessionId={context.workspaceRemoteSessionId}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          forceCodeWrap={isOfficeMode}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenExternalUrl={context.onOpenBrowserUrl}
          sessionId={context.sessionId ?? undefined}
          readAttachment={context.readAttachment}
        >
          {visibleText}
        </GenUiMessageResponse>
      </div>
      {codeCommentCardsEnabled && codeCommentCards && codeCommentCards.length > 0 ? (
        <div className="mt-3">
          <AssistantCodeCommentCards
            cards={codeCommentCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenCodeViewer={context.onOpenCodeViewer}
          />
        </div>
      ) : null}
      {visiblePreviewCards ? (
        <div className="mt-3">
          <AssistantPreviewCards
            cards={visiblePreviewCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            autoOpenPptxKey={previewCardsAutoOpenKey}
            onAutoOpenPptx={context.onAutoOpenAssistantPptx}
            compactForRemoteControl={context.compactForRemoteControl}
          />
        </div>
      ) : null}
      {/* 完成态动作行悬停显现（对齐旧 MessageActions）：复制 + fork（图标 ghost）。
          一轮对用户是一个回复：action 只在轮尾段（hideActions 由 TurnGroup 裁决），
          复制内容 = 整轮全部 text 段合并（copyText 覆盖）。 */}
      {row.state === "complete" && !hideActions && !deferActions ? (
        <ConversationAssistantTextActions
          rowId={row.rowId}
          entityId={row.entityId}
          text={copyText ?? row.text}
          createdAt={row.createdAt}
          compactForRemoteControl={context.compactForRemoteControl}
          feedback={readAssistantFeedback(row)}
          sessionId={context.sessionId}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          className={cn(
            "mt-1",
            context.compactForRemoteControl
              ? "opacity-100"
              : "opacity-0 transition-opacity group-hover/assistant-row:opacity-100 focus-within:opacity-100",
          )}
        />
      ) : null}
    </RowShell>
  );
});

const ReasoningRowView = memo(function ReasoningRowView({
  row,
  contentVariant,
}: {
  row: ReasoningRow;
  contentVariant?: "default" | "nested";
}) {
  const streaming = row.state === "streaming";
  // 外观对齐旧 ThoughtBlock（旧版 chatMessageParts）：ai-elements Reasoning
  // 折叠组件。交互调整原因：流式 reasoning 默认展开会持续挤压工具和正文空间；
  // 现在 streaming/complete 都默认收起，只保留运行态文案，用户可手动展开。
  // autoCollapseKey 仍保证状态边界不会覆盖已经发生过的用户交互。
  const durationSeconds =
    row.durationMs !== undefined ? Math.max(1, Math.ceil(row.durationMs / 1000)) : undefined;
  if (streaming && row.text.length === 0) {
    return null;
  }
  return (
    <RowShell rowId={row.rowId}>
      <Reasoning
        className="w-full"
        isStreaming={streaming}
        autoCollapseKey={streaming ? null : row.state}
        {...(durationSeconds !== undefined ? { duration: durationSeconds } : {})}
      >
        {/* Bug 原因：附件重构合并时误丢了 streamingText 接线，导致摘要组件仍在但永远收到空文本。 */}
        <ReasoningTrigger streamingText={row.text} />
        <div data-conversation-selectable="true">
          <ReasoningContent variant={contentVariant}>{row.text}</ReasoningContent>
        </div>
      </Reasoning>
    </RowShell>
  );
});

const TurnHeaderRowView = memo(function TurnHeaderRowView({ row }: { row: TurnHeaderRow }) {
  return (
    <RowShell
      rowId={row.rowId}
      className="border-b border-[var(--color-border)] py-1 text-ui-sm text-[var(--color-foreground-subtle)]"
    >
      turn · {row.origin} · {row.state}
    </RowShell>
  );
});

/** timelineMarker 分隔线与分享只读页共用；这里只注入 App 宿主能力。 */
const TimelineMarkerRowView = memo(function TimelineMarkerRowView({
  row,
  context,
}: {
  row: TimelineMarkerRow;
  context: ConversationRowRenderContext;
}) {
  const isOfficeMode = useIsOfficeMode();
  // "已创建 worktree"是可展开的输出块，不是分隔线（docs/git/worktree.md §3.3）。
  // 它依赖 App 侧 managed-worktrees 能力，留在宿主这里，不进分享只读页共用的分隔线组件。
  if (row.marker.type === "worktreeCreated") {
    return <WorktreeCreatedMarker rowId={row.rowId} output={row.marker.output} />;
  }
  return (
    <ConversationTimelineMarkerDivider
      row={row}
      isOfficeMode={isOfficeMode}
      modelSelectionView={context.modelSelectionView ?? null}
      onNavigateToRow={context.onNavigateToRow}
    />
  );
});

const ToolCallRowView = memo(function ToolCallRowView({
  row,
  context,
}: {
  row: ToolCallRow;
  context: ConversationRowRenderContext;
}) {
  // toolCall 行回接 ToolCallBlocks（execute/read/edit/... renderer 按
  // tool identity 分流）。适配 memo 按 row 引用：row.delta/upserted 换新对象才重建。
  const toolCallNode = useMemo(() => toolCallRowToLegacyNode(row), [row]);
  // workflow run 详情入口的门控：run 身份走 workflowRuns 投影（schema 里 toolCallId 就是
  // 「工具卡 → 详情页的关联键」），不从工具输出里读——v4 行的 output 只剩一句散文。
  // 命中的摘要同时决定卡片形态：有 run 就是紧凑可点卡，没有就是可展开卡。
  const workflowRun =
    context.workflowRunByToolCallId?.get(row.toolCallId) ??
    // ResumeWorkflowRun 行按 runId 联接：display 载荷带 runId（≡ backgroundTaskId），而投影
    // 的 run.toolCallId 跨 resume 沿用原始 CreateWorkflow 行——resume 行按 toolCallId 永远
    // 查不到。命中后 onOpenWorkflowRun 的收窄走同一条路径，tab 身份 runId 键、幂等。
    (row.display?.kind === "resume_workflow_run"
      ? context.workflowRunByRunId?.get(row.display.runId)
      : undefined);
  // 已接进 run 的补全行（docs/dynamic-workflow/presentation.md「The fill row」）：「留白已补全 · {name} ·
  // {k} 个阶段 · {m} 个子代理 ↗」。按入参的 `run_id` 联接投影（补全行的 toolCallId 不是发起行的），只认成功
  // 且编过的行——编不过的补全走下面的编译反馈行，什么都没接进 run。卡下方随之长出新的站（轮尾摘要
  // 取的是这一行的图）。
  // 名字来自 display 的 `fill` 块（行的入参没有名字——transcript 只存模型自己的入参）。
  const fillTarget = isFillWorkflowHoleToolCall(row)
    ? readWorkflowHoleTarget(
        row.input,
        row.display?.kind === "create_workflow" ? row.display.fill : undefined,
      )
    : undefined;
  const fillRun =
    fillTarget?.runId === undefined ? undefined : context.workflowRunByRunId?.get(fillTarget.runId);
  if (
    fillTarget !== undefined &&
    fillTarget.holeId !== undefined &&
    fillRun !== undefined &&
    row.status === "success" &&
    row.display?.kind === "create_workflow" &&
    row.display.ok
  ) {
    const sessionId = context.sessionId;
    const counts = workflowFillCounts(row.display.causalityGraph, fillTarget.holeId);
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowToolSummary
          toolCallId={row.toolCallId}
          summary={fillRun}
          fill={{
            name: fillTarget.name ?? fillTarget.holeId,
            ...counts,
          }}
          onOpen={
            context.onOpenWorkflowRun && sessionId
              ? () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, fillRun),
                    runId: fillRun.runId,
                  })
              : undefined
          }
        />
      </RowShell>
    );
  }
  // 原因：已启动的工具卡与轮尾摘要重复画同一条实时进度；上方改为普通摘要入口。
  // 只替换成功关联的发起行，编译诊断及 Resume 等其他工具仍走原有渲染。
  if (
    workflowRun &&
    context.workflowRunByToolCallId?.has(row.toolCallId) &&
    row.status !== "error"
  ) {
    const workflowName = readWorkflowName(row.input);
    const sessionId = context.sessionId;
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowToolSummary
          toolCallId={row.toolCallId}
          summary={workflowRun}
          amend={isAmendWorkflowToolCall(row)}
          onOpen={
            context.onOpenWorkflowRun && sessionId
              ? () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                    ...(workflowName === undefined ? {} : { workflowName }),
                  })
              : undefined
          }
        />
      </RowShell>
    );
  }
  // 就地生效的修订（docs/dynamic-workflow/concurrency.md）：只改并发上限、run 又在飞时这次调用
  // 不编译、不铸新 run，结果只有一句话。判据全在已经上线的字段上——入参的形状、**没有** display、
  // 成功且非错误；工具的结构化输出不过 v4，而三处 create_workflow display schema 都是冻结字段集
  // 的 `.strict()`，多一个键会让旧端把整条工具结果丢掉，所以这条路不新增任何协议字段。
  // 退回真修订的那一条（run 已结算）两条判据都不成立：它有 display，也铸出一条按 toolCallId
  // 联接得上的 run，上面那个分支先接走它。
  const retune = isAmendWorkflowToolCall(row) ? readWorkflowRetuneCall(row.input) : undefined;
  if (
    retune !== undefined &&
    row.status === "success" &&
    (row.output?.display ?? row.display) === undefined &&
    !context.workflowRunByToolCallId?.has(row.toolCallId)
  ) {
    const sessionId = context.sessionId;
    // 被调整那条 run 的投影：只为两件事——默认并发（措辞据它把「等于默认」念成「恢复为默认」）与
    // 打开请求里那条 run 的发起行 id。它不进上面的 `workflowRun`：那个变量回答的是「这一行是不是
    // 某条 run 的发起行」，而这一行不是。
    const retuned = context.workflowRunByRunId?.get(retune.runId);
    const defaultConcurrency =
      retuned?.run === undefined ? undefined : workflowRunDefaultConcurrency(retuned.run);
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowRetuneRow
          requested={retune.requested}
          runId={retune.runId}
          {...(defaultConcurrency === undefined ? {} : { defaultConcurrency })}
          {...(context.onOpenWorkflowRun && sessionId
            ? {
                onOpen: () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, retuned),
                    runId: retune.runId,
                  }),
              }
            : {})}
        />
      </RowShell>
    );
  }
  // 工具行去掉纵向内边距（对齐 z-code-2 无 per-tool padding）；连续工具间距由
  // ConversationAssistantWorkItems 的 gap-4 组容器统一给。
  return (
    <RowShell rowId={row.rowId} className="py-0">
      <div data-conversation-selectable="true">
        <ToolCallBlock
          toolCallNode={toolCallNode}
          workspacePath={context.workspacePath}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          showTodoToolCalls={context.messageStreamShowTodos === true}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenBrowserUrl={context.onOpenBrowserUrl}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
          onOpenPlanDetail={
            context.onOpenPlanDetail && context.sessionId
              ? (request) =>
                  context.onOpenPlanDetail?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                  })
              : undefined
          }
          onOpenWorkflowRun={
            context.onOpenWorkflowRun && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowRun?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    // 打开请求的关联键是发起行（CreateWorkflow）id，不是点中行的 id——
                    // resume 行点开时两者不同，详情页拿它找 causalityGraph/脚本。
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          onOpenWorkflowActor={
            context.onOpenWorkflowActor && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowActor?.({ ...request, parentSessionId: context.sessionId! })
              : undefined
          }
          // 脚本药丸 → 脚本 transcript：关联键同 onOpenWorkflowRun（发起行 id + runId）。
          onOpenWorkflowWorkspace={
            context.onOpenWorkflowWorkspace && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowWorkspace?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          onResumeWorkflowRun={
            context.onResumeWorkflowRun && workflowRun?.resumable
              ? (request) => context.onResumeWorkflowRun?.(workflowRun.runId, request.workflowName)
              : undefined
          }
          // 产物药丸 → 产物 tab：与通知行的 chips 同一条打开路径（不带版本号，打开即最新版）。
          onOpenWorkflowArtifact={
            context.onOpenWorkflowArtifact && context.sessionId && workflowRun
              ? (artifactId) => {
                  // 活投影的产物摘要带最新版的 `contentType`（宿主据它把 html 产物直接开成
                  // 浏览器 tab）；`sourcePath` 那份摘要刻意不带，缺席时宿主自己查 journal。
                  const artifact = workflowRun.run?.artifacts?.find(
                    (candidate) => candidate.id === artifactId,
                  );
                  context.onOpenWorkflowArtifact?.({
                    parentSessionId: context.sessionId!,
                    runId: workflowRun.runId,
                    artifactId,
                    ...(artifact?.title === undefined ? {} : { title: artifact.title }),
                    ...(artifact?.contentType === undefined
                      ? {}
                      : { contentType: artifact.contentType }),
                  });
                }
              : undefined
          }
          workflowRun={workflowRun}
          workflowDraft={context.workflowDraftByToolCallId?.get(row.toolCallId)}
        />
      </div>
    </RowShell>
  );
});

const SubagentRowView = memo(function SubagentRowView({ row }: { row: SubagentRow }) {
  // subagent 行已经和 Agent/Task 工具行配对渲染；裸行只保留异常兜底摘要，
  // 避免再生成一个“子会话”卡片或第二套下钻入口。
  const summary = (
    <>
      {row.subagentType} · {row.status}
      {row.summaryText ? ` — ${row.summaryText}` : ""}
    </>
  );
  return (
    <RowShell rowId={row.rowId}>
      <div className="text-ui-sm text-[var(--color-foreground-subtle)]">{summary}</div>
    </RowShell>
  );
});

/**
 * v4 row 渲染分发。memo：虚拟列表逐行渲染，父投影变化时只有 props 真正变化的行才重渲染
 * （前提是 onFork/onRetry/onEdit 为稳定引用 + context 引用稳定，见 SessionPane 的
 * useCallback/useMemo）。
 */
function ConversationRowViewImpl({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  editWorkspaceRewindAvailability,
  hideAssistantActions,
  deferAssistantActions,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  reasoningContentVariant,
  userInputStatus,
}: ConversationRowViewProps) {
  switch (row.kind) {
    case "userInput":
      return (
        <UserInputRowView
          row={row}
          context={context}
          onEdit={onEdit}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          status={userInputStatus}
        />
      );
    case "assistantText":
      return (
        <AssistantTextRowView
          row={row}
          context={context}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          hideActions={hideAssistantActions}
          deferActions={deferAssistantActions}
          copyText={assistantCopyText}
          previewCards={assistantPreviewCards}
          previewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          codeCommentCards={assistantCodeCommentCards}
          codeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      );
    case "reasoning":
      // 关闭“显示思考过程”只隐藏每轮后续 reasoning；首条 reasoning
      // 是该轮最小必要思考提示，必须由 turn 全序派生的 rowId 保留下来。
      return isConversationReasoningRowVisible(row.rowId, context) ? (
        <ReasoningRowView row={row} contentVariant={reasoningContentVariant} />
      ) : null;
    case "turnHeader":
      return <TurnHeaderRowView row={row} />;
    case "timelineMarker":
      return <TimelineMarkerRowView row={row} context={context} />;
    case "toolCall":
      // 只在 ToolCallBlock 内返回 null 会留下空 RowShell 和多余间距；
      // 在行分发处按同一工具身份规则裁剪，设置关闭时不产生任何 Todo DOM。
      if (
        context.messageStreamShowTodos !== true &&
        resolveToolCallIdentity({ toolName: row.toolName, kind: row.toolName }).family === "todo"
      ) {
        return null;
      }
      return <ToolCallRowView row={row} context={context} />;
    case "subagent":
      return <SubagentRowView row={row} />;
    case "artifact":
      return <ArtifactRowView row={row} />;
    case "unreadable":
      return <UnreadableRowView row={row} />;
    default:
      return null;
  }
}

export const ConversationRowView = memo(ConversationRowViewImpl);
