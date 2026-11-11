import { CollapsedChangeSummary } from "@/ToolCallBlocks/renderers.js";
import { SummaryGroupBoundaryContext } from "@/v4/conversationRowContext.js";
import { ConsecutiveSummaryGroup } from "@/ToolCallBlocks/ToolSummaryRow.js";
/* oxlint-disable eslint(max-lines) -- Share 与 Desktop 共用的只读 Row/turn presentation 需要保持在同一安全边界。
 * 安全边界约束：本文件被匿名公开分享页（packages/web/src/share）直接引用，新增依赖必须考虑
 * 公开页 bundle 体积与无 Desktop 宿主（window.zcode / PlatformProvider / tab store）的运行环境；
 * Desktop 专属能力（如 open-with 子树）一律由消费方经组件注入，不得静态 import。 */
import { ToolPresentation } from "@/ToolCallBlocks/ToolPresentation.js";
import {
  useToolPresentationCapabilities,
  ToolPresentationCapabilitiesProvider,
} from "@/ToolCallBlocks/presentationCapabilities.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import type { ShareToolPresentationPayload } from "@zcode/shared";
import {
  createContext,
  Fragment,
  memo,
  type ComponentType,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ArchiveIcon,
  ArrowRightLeftIcon,
  ChevronRightIcon,
  FileTextIcon,
  GitBranchIcon,
  GoalIcon,
  InfoIcon,
} from "lucide-react";
import {
  conversationShareContentEnvelopeSchema,
  decodeConversationShareContentBlocks,
  type Locale,
} from "@zcode/shared";
import type {
  ArtifactRow,
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  TimelineMarkerRow,
  ToolCallRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { TID_V4_ROW, testId } from "@zcode/shared/test-ids";
import type { ModelSelectionView } from "@zcode/services";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { MessageResponse, type MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import {
  ConversationShareWorkflow,
  hasConversationShareWorkflowDisplay,
} from "@/v4/ConversationShareWorkflow.js";
import { ConversationUserInputBody } from "@/v4/ConversationUserInputBody.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import { PluginReferenceIconProvider } from "@/v4/pluginReferenceIconContext.js";
import {
  buildAssistantWorkRenderItems,
  groupConsecutiveAssistantSummaries,
  formatAssistantSummaryStatistics,
  getAssistantSummaryTailRowId,
  getActiveAssistantSummaryItem,
  getAssistantSummaryIconItem,
  getAssistantSummaryChangeFiles,
  type ConversationAssistantWorkRenderItem,
} from "@/v4/conversationAssistantWorkItems.js";
import {
  buildConversationTurnRenderUnits,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import type { ConversationTurnWorkSegment } from "@/v4/conversationTurnWorkSegments.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import { normalizeConversationShareMarkdown } from "@/v4/conversationShareMarkdown.js";
import {
  DEFAULT_CODE_PREVIEW_SETTINGS,
  type CodePreviewSettings,
} from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { Theme } from "@/useTheme.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { formatAttachmentSize } from "@/lib/chatAttachmentMetadata.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
// 仅类型引用，构建期擦除：静态 import OpenSplitButton 会把其整棵 open-with 子树
// （platform hooks、tab store、workspace-file-tree/model、editorPreference）打进匿名
// 公开页 bundle，因此打开动作组件改由 Desktop 消费方经 artifactOpenAction 注入。
import type { OpenSplitButtonTarget } from "@/OpenSplitButton.js";

import { ConversationShareContent } from "@/v4/ConversationShareContent.js";
import { logger } from "@/logger.js";

export interface ConversationShareReadonlyTimelineProps {
  contentBlocks?: readonly unknown[];
  rows: readonly ConversationRow[];
  locale?: Locale;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  artifactUrls?: ReadonlyMap<string, string>;
  artifactNames?: ReadonlyMap<string, string>;
  artifactWorkspaceRelativePaths?: ReadonlyMap<string, string>;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /**
   * Desktop 侧注入的 artifact 打开动作组件（实现即 OpenSplitButton）。
   * 公开分享页不传：一是公开页没有本地打开能力，二是避免 open-with 子树进公开页 bundle。
   */
  artifactOpenAction?: ConversationShareArtifactOpenAction;
  /**
   * 本 build 认不出、已被跳过的行数（见 decodeConversationShareRows）。
   *
   * >0 时在时间线顶部出一条中性提示。必须提示：分享内容是跨版本流动的，老客户端/老落地页
   * 镜像遇到新 row kind 时会静默少几行，用户没法自己发现——他会以为分享者就发了这些。
   */
  unsupportedRowCount?: number;
}

/** 注入契约：Desktop 侧提供的「带本地打开动作」组件，与 OpenSplitButton 的关键 props 对齐。 */
export type ConversationShareArtifactOpenAction = ComponentType<{
  target: OpenSplitButtonTarget;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}>;

interface ReadonlyLabels {
  artifactPreview: string;
  unsupportedRows: string;
}

/** 分隔线图标（对齐旧版 synthetic-timeline dividers：size-3.5 subtle）。 */
const MARKER_ARCHIVE_ICON = (
  <ArchiveIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_FORK_ICON = (
  <GitBranchIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_GOAL_ICON = (
  <GoalIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_MODEL_ICON = (
  <ArrowRightLeftIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);

/**
 * 系统标记分隔线壳：两侧细横线 + 居中「图标 + 文案」pill，视觉对齐旧版
 * ChatMessage synthetic-timeline dividers（fork / compaction / goal 同款）。
 * running（压缩/校验进行中）隐藏图标、文案走 animated-gradient-text 流光（同旧版）。
 */
function MarkerDividerRow({
  rowId,
  markerType,
  markerStatus,
  markerOrigin,
  markerSourceCommandId,
  icon,
  label,
  running = false,
  onClick,
}: {
  rowId: number;
  markerType: TimelineMarkerRow["marker"]["type"];
  markerStatus: string;
  markerOrigin?: string;
  markerSourceCommandId?: string;
  icon: ReactNode;
  label: ReactNode;
  running?: boolean;
  /** 传入即整行可点（fork→跳父会话）；不传为静态分隔线。 */
  onClick?: () => void;
}) {
  const clickable = Boolean(onClick);
  const rowClassName =
    "flex w-full items-center gap-3 px-4 py-2 text-ui-base text-[var(--color-foreground-subtle)]";
  const inner = (
    <>
      <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
      <span className="inline-flex min-w-0 shrink items-center justify-center gap-1.5 text-center leading-5">
        {running ? null : icon}
        <span
          className={`min-w-0 break-words${running ? " animated-gradient-text font-medium" : ""}${clickable ? " underline-offset-4 group-hover/marker:underline" : ""}`}
        >
          {label}
        </span>
      </span>
      <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
    </>
  );
  if (onClick) {
    // 整行 <button>（对齐旧版 fork divider）：hover 变亮 + 文案下划线示意可点。
    return (
      <button
        type="button"
        data-row-id={rowId}
        data-row-kind="timelineMarker"
        data-marker-type={markerType}
        data-status={markerStatus}
        data-origin={markerOrigin}
        data-source-command-id={markerSourceCommandId}
        data-testid={testId(TID_V4_ROW, String(rowId))}
        onClick={onClick}
        className={`group/marker ${rowClassName} text-left transition-colors hover:text-[var(--color-foreground)]`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div
      data-row-id={rowId}
      data-row-kind="timelineMarker"
      data-marker-type={markerType}
      data-status={markerStatus}
      data-origin={markerOrigin}
      data-source-command-id={markerSourceCommandId}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className={rowClassName}
    >
      {inner}
    </div>
  );
}

/**
 * timelineMarker 行渲染：compact / forkNotice / goalVerify / modelChange 画成分隔线。
 * modelChange 可见化 = 裁决（切换后实际发送出去的轮才落分隔，含
 * model-only 续跑轮）；goalSet/forkCreated 已在投影层停产（隐形行清零），
 * retryNotice·checkpointRestored 无 UI，default 分支兜底不渲染。
 *
 * 从 ConversationRowView 移入本安全边界文件：分享只读页原先自绘一套无图标、无 from→to 的
 * 简化分隔线，与 App 对话页长期不一致；两端改为共用本组件，Office 模式、模型目录、fork 跳转
 * 等宿主能力由调用方注入，本组件不读 store。
 */
export const ConversationTimelineMarkerDivider = memo(function ConversationTimelineMarkerDivider({
  row,
  isOfficeMode = false,
  modelSelectionView = null,
  onNavigateToRow,
}: {
  row: TimelineMarkerRow;
  isOfficeMode?: boolean;
  /** 模型目录；只读页没有目录，provider 名称回退到 ID。 */
  modelSelectionView?: ModelSelectionView | null;
  /** fork 跳父会话；只读页不传。 */
  onNavigateToRow?: (sessionId: string, rowId: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const marker = row.marker;
  const view = useMemo((): {
    icon: ReactNode;
    label: ReactNode;
    running: boolean;
  } | null => {
    switch (marker.type) {
      case "compact": {
        const running = marker.status === "running";
        const automaticOptimization = isOfficeMode && marker.origin === "auto";
        const scope = automaticOptimization ? "chat.contextOptimization" : "chat.contextCompaction";
        const statusMessage =
          marker.status === "running"
            ? "started"
            : marker.status === "noop"
              ? "skipped"
              : marker.status === "cancelled"
                ? "interrupted"
                : marker.status === "failed"
                  ? "failed"
                  : marker.origin === "auto" && !automaticOptimization
                    ? "completedAuto"
                    : "completed";
        return {
          icon: MARKER_ARCHIVE_ICON,
          label: intl.formatMessage({ id: `${scope}.${statusMessage}` }),
          running,
        };
      }
      case "forkNotice":
        return {
          icon: MARKER_FORK_ICON,
          label: intl.formatMessage({ id: "chat.message.fork.derivedFrom" }),
          running: false,
        };
      case "modelChange": {
        // marker 已携带完整 provider/model 元组，旧渲染却只读取 model，
        // 且没有订阅 provider snapshot，导致同名模型无差异、目录水合后名称不刷新。
        // 这里保留 provider ID fallback，并让现有 marker 随目录更新。
        const fromProvider = resolveProviderLabel(marker.fromProvider, modelSelectionView);
        const toProvider = resolveProviderLabel(marker.toProvider, modelSelectionView);
        const to = formatModelChangeLabel(marker.toProvider, toProvider, marker.toModel, intl);
        if (marker.fromProvider === undefined || marker.fromModel === undefined) {
          return {
            // source-less 表示首次使用的模型事实，不是模型切换，因此不显示切换箭头。
            icon: null,
            label: intl.formatMessage({ id: "chat.modelChange.using" }, { model: to }),
            running: false,
          };
        }
        return {
          icon: MARKER_MODEL_ICON,
          label: intl.formatMessage(
            { id: "chat.modelChange.switched" },
            {
              from: formatModelChangeLabel(
                marker.fromProvider,
                fromProvider,
                marker.fromModel,
                intl,
              ),
              to,
            },
          ),
          running: false,
        };
      }
      case "goalVerify": {
        const running = marker.outcome === "running";
        // pass→完成；notSatisfied/failed→未完成（沿用旧版 failed_closed 归「未完成」的处理）。
        const statusId =
          marker.outcome === "running"
            ? "chat.goalVerification.checking"
            : marker.outcome === "pass"
              ? "chat.goalVerification.complete"
              : "chat.goalVerification.incomplete";
        return {
          icon: MARKER_GOAL_ICON,
          running,
          // innerText 形如「第 1 次迭代 · 目标校验中」，对齐 goal-timeline 待命 e2e 断言。
          label: (
            <>
              <span>
                {intl.formatMessage(
                  { id: "chat.summaryPanel.goalIterationValue" },
                  { count: String(marker.iteration) },
                )}
              </span>
              <span aria-hidden="true"> · </span>
              {intl.formatMessage({ id: statusId })}
            </>
          ),
        };
      }
      default:
        return null;
    }
  }, [intl, isOfficeMode, marker, modelSelectionView]);

  // fork 跳父会话（Tier 1）：仅 forkNotice 且宿主提供 onNavigateToRow 时可点，
  // 切到 marker.parentSessionId（rowId 预留 Tier 2 精确滚动，当前恒 0 占位）。
  const handleClick = useMemo(() => {
    if (marker.type !== "forkNotice" || !onNavigateToRow) {
      return undefined;
    }
    return () => onNavigateToRow(marker.parentSessionId, marker.parentRowId);
  }, [marker, onNavigateToRow]);

  if (!view) {
    return null;
  }
  return (
    <MarkerDividerRow
      rowId={row.rowId}
      markerType={marker.type}
      markerStatus={
        marker.type === "compact"
          ? marker.status
          : marker.type === "goalVerify"
            ? marker.outcome
            : marker.type === "forkNotice"
              ? "created"
              : "applied"
      }
      markerOrigin={marker.type === "compact" ? marker.origin : undefined}
      markerSourceCommandId={row.sourceCommandId}
      icon={view.icon}
      label={view.label}
      running={view.running}
      onClick={handleClick}
    />
  );
});

const EMPTY_ARTIFACT_URLS: ReadonlyMap<string, string> = new Map();
const EMPTY_ARTIFACT_NAMES: ReadonlyMap<string, string> = new Map();
const EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS: ReadonlyMap<string, string> = new Map();
const EMPTY_ATTACHMENTS: readonly unknown[] = [];

interface ArtifactOpenContextValue {
  artifactWorkspaceRelativePaths: ReadonlyMap<string, string>;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  openAction?: ConversationShareArtifactOpenAction;
}

const ArtifactOpenContext = createContext<ArtifactOpenContextValue | null>(null);

function resolveImportedArtifactPath(
  workspacePath: string,
  workspaceRelativePath: string | undefined,
): string | null {
  // 取舍：这里只校验形状（.zcode-share/<dir>/shared-artifacts/<file> 四段），刻意不把
  // 段 2 与导入记录的 shareId 交叉比对。元数据由本端导入服务自写（conversationShareService
  // 落盘时用 sanitizeFileSegment(share_id) 作目录名），自洽；若在 UI 侧比对，就得复制
  // service 层的 sanitize 规则，两边漂移会让合法导入静默丢打开按钮，而收益仅是防住
  // 「指向另一 share 目录」这种一致性噪声——路径仍被限制在 workspace 的
  // .zcode-share/*/shared-artifacts/ 内，无越权读放大。
  const normalizedPath = workspaceRelativePath?.trim();
  if (!normalizedPath || isAbsoluteFilePath(normalizedPath)) {
    return null;
  }

  const segments = normalizedPath.replace(/\\/g, "/").split("/");
  if (
    segments.length !== 4 ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    segments[0] !== ".zcode-share" ||
    segments[2] !== "shared-artifacts"
  ) {
    return null;
  }

  return joinFilePath(workspacePath, segments.join("/"));
}

function UserInputAttachment({
  attachment,
  artifactUrls,
}: {
  attachment: NonNullable<UserInputRow["attachments"]>[number];
  artifactUrls: ReadonlyMap<string, string>;
}) {
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string>();
  const url = artifactUrls.get(attachment.ref.split("/").at(-1) ?? "");
  const previewUrl = attachment.previewRef
    ? artifactUrls.get(attachment.previewRef.split("/").at(-1) ?? "")
    : undefined;
  const imageSrc = attachment.mime.startsWith("image/") ? (previewUrl ?? url) : undefined;
  // Bug 根因：只读分享把所有输入附件都画成文件 pill，丢失了已上传图片的展示。
  // 复用公开 manifest 地址取图；不读取原宿主文件，失败时仍保留原附件下载入口。
  if (imageSrc && failedPreviewUrl !== imageSrc) {
    return (
      <a
        href={url}
        target={url ? "_blank" : undefined}
        rel={url ? "noopener noreferrer" : undefined}
        aria-disabled={url ? undefined : "true"}
        title={attachment.fileName}
        className="block size-24 max-w-full overflow-hidden rounded-lg border border-border bg-surface hover:border-border-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      >
        <img
          src={imageSrc}
          alt={attachment.fileName}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => {
            setFailedPreviewUrl(imageSrc);
            // 签名下载地址可能含凭据，诊断仅记录 MIME，不输出 URL 或附件名。
            logger.warn("[share-input-image] preview failed", { mime: attachment.mime });
          }}
        />
      </a>
    );
  }
  return (
    <a
      href={url}
      target={url ? "_blank" : undefined}
      rel={url ? "noopener noreferrer" : undefined}
      aria-disabled={url ? undefined : "true"}
      className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-foreground hover:bg-surface-hover"
      data-v4-user-input-attachment-pill="true"
    >
      <FileTextIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 max-w-64 truncate">{attachment.fileName}</span>
      <span className="shrink-0 text-foreground-subtlest">
        {formatAttachmentSize(attachment.bytes)}
      </span>
    </a>
  );
}

function UserInputPresentation({
  row,
  artifactUrls,
}: {
  row: UserInputRow;
  artifactUrls: ReadonlyMap<string, string>;
}) {
  const attachments = row.attachments ?? [];
  return (
    <div className="flex flex-col items-end" data-conversation-share-row-kind="userInput">
      {attachments.length > 0 ? (
        <div
          className="mb-2 flex w-full max-w-xl flex-wrap items-start justify-end gap-2"
          data-v4-user-input-attachments="true"
        >
          {attachments.map((attachment, index) => (
            <UserInputAttachment
              key={`${attachment.ref}-${index}`}
              attachment={attachment}
              artifactUrls={artifactUrls}
            />
          ))}
        </div>
      ) : null}
      <div
        data-v4-user-input-bubble="true"
        className="flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground @min-[624px]/conversation:max-w-xl"
      >
        <ConversationUserInputBody contentText={row.text} rowId={row.rowId}>
          <ConversationUserInputContent
            text={row.text}
            attachments={row.attachments ?? EMPTY_ATTACHMENTS}
          />
        </ConversationUserInputBody>
      </div>
    </div>
  );
}

const AssistantTextPresentation = memo(function AssistantTextPresentation({
  row,
  theme,
  codePreviewSettings,
  artifactNames,
  onOpenExternalUrl,
}: {
  row: AssistantTextRow;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactNames: ReadonlyMap<string, string>;
  onOpenExternalUrl: (url: string) => void;
}) {
  const markdown = useMemo(
    () => normalizeConversationShareMarkdown(row.text, artifactNames),
    [artifactNames, row.text],
  );
  return (
    <div data-conversation-share-row-kind="assistantText" className="group/assistant-row">
      <div data-conversation-selectable="true" className="w-full text-ui-base">
        <MessageResponse
          streaming={false}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          renderZCodeFileCitations={false}
          onOpenExternalUrl={onOpenExternalUrl}
        >
          {markdown}
        </MessageResponse>
      </div>
    </div>
  );
});

const ReasoningPresentation = memo(function ReasoningPresentation({ row }: { row: ReasoningRow }) {
  const durationSeconds =
    row.durationMs === undefined ? undefined : Math.max(1, Math.ceil(row.durationMs / 1000));
  return (
    <div data-conversation-share-row-kind="reasoning">
      <Reasoning
        className="w-full"
        isStreaming={false}
        autoCollapseKey={row.state}
        {...(durationSeconds === undefined ? {} : { duration: durationSeconds })}
      >
        <ReasoningTrigger streamingText={row.text} />
        <div data-conversation-selectable="true">
          <ReasoningContent>{row.text}</ReasoningContent>
        </div>
      </Reasoning>
    </div>
  );
});

const ToolSnapshotContext = createContext<ReadonlyMap<number, ShareToolPresentationPayload>>(
  new Map(),
);
function toolNodeWithSnapshot(
  row: ToolCallRow,
  snapshot: ShareToolPresentationPayload | undefined,
  resourceUrl: (ref: string) => string | undefined,
) {
  const node = toolCallRowToLegacyNode(row);
  if (!snapshot) return node;
  const images = snapshot.images?.flatMap((image) => {
    const src = resourceUrl(image.resource_id);
    return src ? [{ src, mimeType: image.mime_type }] : [];
  });
  node.toolCall.raw = {
    ...(node.toolCall.raw as Record<string, unknown>),
    ...(snapshot.display ? { display: snapshot.display } : {}),
    ...(images?.length ? { sharedImages: images, sharedImageSrc: images[0]!.src } : {}),
    ...(snapshot.app_name ? { cuaApp: { name: snapshot.app_name } } : {}),
  };
  return node;
}
const ToolCallPresentation = memo(function ToolCallPresentation({
  row,
  theme,
  codePreviewSettings,
  artifactNames: _artifactNames,
  onOpenExternalUrl,
}: {
  row: ToolCallRow;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactNames: ReadonlyMap<string, string>;
  onOpenExternalUrl: (url: string) => void;
}) {
  const snapshots = useContext(ToolSnapshotContext);
  const { resourceUrl } = useToolPresentationCapabilities();
  const snapshot = snapshots.get(row.rowId);
  const node = useMemo(
    () => toolNodeWithSnapshot(row, snapshot, resourceUrl ?? (() => undefined)),
    [row, snapshot, resourceUrl],
  );
  if (hasConversationShareWorkflowDisplay(row))
    return (
      <div data-conversation-share-row-kind="toolCall" data-conversation-selectable="true">
        <ConversationShareWorkflow row={row} theme={theme} />
      </div>
    );
  return (
    <div data-conversation-share-row-kind="toolCall" data-conversation-selectable="true">
      <ToolPresentation
        toolCallNode={node}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenBrowserUrl={onOpenExternalUrl}
        authoritativeAgentType={snapshot?.agent_type}
        showTodoToolCalls={false}
      />
    </div>
  );
});

/** 与正文的 AssistantPreviewCards 对齐：同一套 chat.previewCards.* 副标题词汇。 */
const ARTIFACT_SUBTITLE_MESSAGE_IDS: Readonly<Record<string, string>> = {
  pdf: "chat.previewCards.pdf",
  docx: "chat.previewCards.docx",
  xlsx: "chat.previewCards.xlsx",
  pptx: "chat.previewCards.pptx",
  md: "chat.previewCards.markdown",
  text: "chat.previewCards.text",
  html: "chat.previewCards.htmlWebsite",
};

const ArtifactPresentation = memo(function ArtifactPresentation({
  row,
  url,
  previewLabel,
}: {
  row: ArtifactRow;
  url?: string;
  previewLabel: string;
}) {
  const { intl } = useZCodeIntl();
  const artifactOpenContext = useContext(ArtifactOpenContext);
  const OpenAction = artifactOpenContext?.openAction;
  // 与 AssistantPreviewCards 保持同一视觉：44px 图标底板 + 真实文件类型图标 + 中粗标题 + 类型副标题。
  const descriptor = resolveFileDisplayDescriptor(row.displayName);
  const subtitleMessageId = ARTIFACT_SUBTITLE_MESSAGE_IDS[row.artifactType];
  const typeLabel = subtitleMessageId
    ? intl.formatMessage({ id: subtitleMessageId })
    : row.artifactType.toUpperCase();
  const localPath =
    artifactOpenContext && !url
      ? resolveImportedArtifactPath(
          artifactOpenContext.workspacePath,
          artifactOpenContext.artifactWorkspaceRelativePaths.get(row.artifactVersionId),
        )
      : null;
  const previewSource: CodeViewerSource | null =
    artifactOpenContext && localPath
      ? {
          type: "file",
          title: row.displayName,
          path: localPath,
          workspacePath: artifactOpenContext.workspacePath,
          ...(artifactOpenContext.workspaceIdentity
            ? { workspaceIdentity: artifactOpenContext.workspaceIdentity }
            : {}),
          ...(artifactOpenContext.workspaceRemoteSessionId
            ? { workspaceRemoteSessionId: artifactOpenContext.workspaceRemoteSessionId }
            : {}),
        }
      : null;
  return (
    // ReadonlyTurn 已提供与正文一致的水平 inset，这里再加 px-4 会让资源卡片两侧各多缩进 16px。
    <div data-conversation-share-row-kind="artifact" className="py-1">
      <div className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 pr-4 text-foreground">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-background text-foreground-subtle">
          {descriptor ? (
            <FileDisplayIcon src={descriptor.fileIconSrc} size={24} />
          ) : (
            <FileTextIcon className="size-6" aria-hidden="true" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-ui-base font-medium leading-5">{row.displayName}</p>
          <p className="truncate text-ui-base leading-5 text-foreground-subtlest">
            {typeLabel} · {formatAttachmentSize(row.sizeBytes)}
          </p>
        </div>
        {url ? (
          // 与正文卡片右侧的 OpenSplitButton 同一视觉（h-7 圆角描边 + input 底色）；
          // 资源 URL 实际触发下载，原「预览文件」文案会误导用户；分享页只保留「下载文件」动作。
          // data-share-preview-button 是测试断言用的结构性标记：语义锁定不依赖 Tailwind 类字符串。
          <div
            data-share-preview-button="true"
            className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
          >
            <button
              type="button"
              className="flex h-7 items-center gap-1 px-2 text-ui-sm text-foreground"
              onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
            >
              {previewLabel}
            </button>
          </div>
        ) : previewSource && OpenAction ? (
          <OpenAction
            target={{
              type: "file",
              path: previewSource.path,
              title: row.displayName,
              label: row.displayName,
              previewSource,
            }}
            onOpenFileLink={artifactOpenContext?.onOpenFileLink}
            onOpenCodeViewer={artifactOpenContext?.onOpenCodeViewer}
          />
        ) : null}
      </div>
    </div>
  );
});

function renderReadonlyRow(
  row: ConversationRow,
  theme: Theme,
  codePreviewSettings: CodePreviewSettings,
  artifactUrls: ReadonlyMap<string, string>,
  artifactNames: ReadonlyMap<string, string>,
  labels: ReadonlyLabels,
  onOpenExternalUrl: (url: string) => void,
): ReactNode {
  switch (row.kind) {
    case "userInput":
      return <UserInputPresentation key={row.rowId} row={row} artifactUrls={artifactUrls} />;
    case "assistantText":
      return (
        <AssistantTextPresentation
          key={row.rowId}
          row={row}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          artifactNames={artifactNames}
          onOpenExternalUrl={onOpenExternalUrl}
        />
      );
    case "reasoning":
      return <ReasoningPresentation key={row.rowId} row={row} />;
    case "toolCall":
      return (
        <ToolCallPresentation
          key={row.rowId}
          row={row}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          artifactNames={artifactNames}
          onOpenExternalUrl={onOpenExternalUrl}
        />
      );
    case "artifact":
      return (
        <ArtifactPresentation
          key={row.rowId}
          row={row}
          url={artifactUrls.get(row.artifactVersionId)}
          previewLabel={labels.artifactPreview}
        />
      );
    case "timelineMarker":
      // 分享页原先自绘无图标、只有「上下文已压缩 / 模型已切换」两种文案的简化分隔线，
      // 与 App 对话页不一致；改为共用 App 的分隔线组件，识别不了的类型仍整行不渲染。
      return (
        <div key={row.rowId} data-conversation-share-row-kind="timelineMarker">
          <ConversationTimelineMarkerDivider row={row} />
        </div>
      );
    case "subagent":
    case "hookInvocation":
    case "turnHeader":
      return null;
  }
}

function ReadonlyAssistantWorkItems({
  rows,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
  historyOpen,
}: {
  rows: readonly AssistantWorkRow[];
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
  /** 传入时作为外层过程收纳的内容渲染；与 App 一样只在确有可见工作项时才挂载收纳容器。 */
  historyOpen?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const summaryBoundary = useContext(SummaryGroupBoundaryContext);
  const items = useMemo(
    () => buildAssistantWorkRenderItems(rows, { messageStreamShowReasoning: true }),
    [rows],
  );
  // 与 App 对话页同一修复（2ce7dc9c9c）：过程行全被投影隐藏（如只有 Todo）时，原先仍挂载
  // CollapsibleContent + pt-5 + 空列表，留下空白间距；投影为空时整块不渲染。
  if (items.length === 0) return null;
  const renderItem = (item: ConversationAssistantWorkRenderItem) =>
    item.kind === "row" ? (
      renderReadonlyRow(
        item.row,
        theme,
        codePreviewSettings,
        artifactUrls,
        artifactNames,
        labels,
        onOpenExternalUrl,
      )
    ) : (
      <ToolCallPresentation
        key={item.key}
        row={item.row}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        artifactNames={artifactNames}
        onOpenExternalUrl={onOpenExternalUrl}
      />
    );
  const content = (
    <div
      className="flex flex-col gap-1"
      data-conversation-share-work-items
      data-conversation-work-items
    >
      {groupConsecutiveAssistantSummaries(items).map((group) => {
        if (group.items.length < 2) return renderItem(group.items[0]!);
        const last = group.items.at(-1)!;
        const active = getActiveAssistantSummaryItem(group.items);
        const current = active ?? last;
        const iconItem = getAssistantSummaryIconItem(group.items);
        const completed = !(
          summaryBoundary.taskRunning && summaryBoundary.tailRowId === last.row.rowId
        );
        const statistics = formatAssistantSummaryStatistics(
          group.items,
          intl,
          undefined,
          completed,
        );
        const changes = getAssistantSummaryChangeFiles(group.items);
        return (
          <ConsecutiveSummaryGroup
            key={group.key}
            statistics={statistics}
            collapsedStatistics={
              changes ? (
                <CollapsedChangeSummary
                  files={changes.files}
                  label={
                    changes.files.length === 1 && changes.unresolved === 0
                      ? intl.formatMessage({
                          id: completed
                            ? "chat.summaryGroup.change.completed.label"
                            : "chat.summaryGroup.change.label",
                        })
                      : statistics
                  }
                />
              ) : undefined
            }
            lastRowId={last.row.rowId}
            hasActiveItem={active !== undefined}
            contentKey={current.key}
            refreshVersion={current.row}
            statisticsIcon={iconItem ? renderItem(iconItem) : undefined}
            summary={renderItem(current)}
          >
            {group.items.map(renderItem)}
          </ConsecutiveSummaryGroup>
        );
      })}
    </div>
  );
  if (historyOpen === undefined) return content;
  return (
    <CollapsibleContent
      // 与主对话保持相同的徽标绘制边界，不改变内容左对齐。
      className="-mx-1 -mb-1 px-1 pb-1"
      data-history-open={String(historyOpen)}
    >
      <div className="pt-5">{content}</div>
    </CollapsibleContent>
  );
}

function ReadonlyHistoryStatus({
  segment,
  open,
  locale,
}: {
  segment: ConversationTurnWorkSegment;
  open: boolean;
  locale: Locale;
}) {
  const { intl } = useZCodeIntl();
  const duration = formatConversationWorkDuration(segment.workStatus?.durationMs, intl, locale);
  const label =
    segment.workStatus?.state === "interrupted"
      ? intl.formatMessage({ id: "chat.history.stopped" })
      : segment.workStatus?.state === "running"
        ? intl.formatMessage({ id: "chat.history.workingFor" }, { duration: duration ?? "" })
        : duration
          ? intl.formatMessage({ id: "chat.history.workedFor" }, { duration })
          : intl.formatMessage({ id: "chat.history.worked" });
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          data-conversation-share-history-trigger="true"
          data-history-open={String(open)}
          className="group/history-message inline-flex max-w-full items-center gap-2 text-left text-ui-base text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        >
          <span className="truncate">{label}</span>
          {!segment.assistantHistoryDefaultOpen ? (
            <ChevronRightIcon
              aria-hidden="true"
              className={`size-4 shrink-0 text-foreground-subtlest opacity-70 transition-transform ${open ? "rotate-90" : "rotate-0"}`}
            />
          ) : null}
        </button>
      </CollapsibleTrigger>
    </div>
  );
}

function ReadonlySegment({
  segment,
  turnRunning,
  locale,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  segment: ConversationTurnWorkSegment;
  turnRunning: boolean;
  locale: Locale;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  // 外层过程收纳由工作段独立控制，不能由内部工具分组隐藏入口或强制展开。
  const [historyOpen, setHistoryOpen] = useState(segment.assistantHistoryDefaultOpen);
  useEffect(() => {
    setHistoryOpen(segment.assistantHistoryDefaultOpen);
  }, [segment.assistantHistoryDefaultOpen, segment.key]);
  // 与 App 对话页同一判据：入口跟随工作段状态，而不是「有无可折叠过程」。原先只在有
  // assistantHistory 时显示，导致只有正文的轮缺少「已工作 N」，与 App 不一致。
  const showStatus =
    !turnRunning && segment.workStatus !== undefined && segment.workStatus.state !== "running";
  const open = turnRunning || segment.assistantHistoryDefaultOpen || historyOpen;
  const firstAssistantFlowItemIndex = segment.flowItems.findIndex(
    (flowItem) => flowItem.kind !== "userInput",
  );
  return (
    <Collapsible
      open={open}
      onOpenChange={turnRunning || segment.assistantHistoryDefaultOpen ? undefined : setHistoryOpen}
      className="history-message flex flex-col [&>*+*:not([data-slot='collapsible-content'])]:mt-5"
    >
      {segment.flowItems.map((item: ConversationTurnFlowItem, index) => {
        let content: ReactNode;
        if (item.kind === "userInput") {
          content = <UserInputPresentation row={item.row} artifactUrls={artifactUrls} />;
        } else if (item.kind === "assistantText") {
          content = (
            <AssistantTextPresentation
              row={item.row}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactNames={artifactNames}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
        } else if (item.kind === "assistantHistory") {
          content = (
            <ReadonlyAssistantWorkItems
              rows={item.rows}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactUrls={artifactUrls}
              artifactNames={artifactNames}
              labels={labels}
              onOpenExternalUrl={onOpenExternalUrl}
              historyOpen={open}
            />
          );
        } else {
          content = (
            <ReadonlyAssistantWorkItems
              rows={item.rows}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactUrls={artifactUrls}
              artifactNames={artifactNames}
              labels={labels}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          );
        }
        const showHistoryStatus = showStatus && index === firstAssistantFlowItemIndex;
        return (
          <Fragment key={`${segment.key}:${item.kind}:${index}`}>
            {showHistoryStatus ? (
              <ReadonlyHistoryStatus segment={segment} open={open} locale={locale} />
            ) : null}
            {content}
          </Fragment>
        );
      })}
      {showStatus && firstAssistantFlowItemIndex < 0 ? (
        <ReadonlyHistoryStatus segment={segment} open={open} locale={locale} />
      ) : null}
    </Collapsible>
  );
}

function fallbackWorkSegment(unit: ConversationTurnRenderUnit): ConversationTurnWorkSegment {
  return {
    key: unit.key,
    flowItems: unit.flowItems,
    assistantWorkRows: unit.assistantWorkRows,
    assistantHistoryRows: unit.assistantHistoryRows,
    assistantFollowingRows: unit.assistantFollowingRows,
    assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
    ...(unit.workStatus ? { workStatus: unit.workStatus } : {}),
  };
}

function ReadonlyTurn({
  unit,
  locale,
  theme,
  codePreviewSettings,
  artifactUrls,
  artifactNames,
  labels,
  onOpenExternalUrl,
}: {
  unit: ConversationTurnRenderUnit;
  locale: Locale;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  artifactUrls: ReadonlyMap<string, string>;
  artifactNames: ReadonlyMap<string, string>;
  labels: ReadonlyLabels;
  onOpenExternalUrl: (url: string) => void;
}) {
  const segments = unit.workSegments?.length ? unit.workSegments : [fallbackWorkSegment(unit)];
  return (
    <SummaryGroupBoundaryContext.Provider
      value={{
        taskRunning: unit.isRunning,
        tailRowId: getAssistantSummaryTailRowId(unit.renderRows, {
          messageStreamShowReasoning: true,
        }),
      }}
    >
      <section
        data-conversation-share-turn={unit.turnId}
        className="mx-auto flex w-full flex-col gap-5 px-4 pb-5 pt-14 @md/conversation:px-6 [content-visibility:auto] [contain-intrinsic-size:0_420px]"
      >
        {unit.leadingBoundaryRows.map((row) =>
          renderReadonlyRow(
            row,
            theme,
            codePreviewSettings,
            artifactUrls,
            artifactNames,
            labels,
            onOpenExternalUrl,
          ),
        )}
        <div className="group/assistant-turn flex w-full flex-col gap-5">
          {unit.timelineOnly ? (
            // 与 App 对话页一致：只有分隔线的维护轮（如压缩）直接渲染 marker，不走工作段，
            // 否则会在分隔线上方多出一条「已工作 N」。
            <ReadonlyAssistantWorkItems
              rows={unit.assistantWorkRows}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactUrls={artifactUrls}
              artifactNames={artifactNames}
              labels={labels}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          ) : (
            segments.map((segment) => (
              <ReadonlySegment
                key={segment.key}
                segment={segment}
                turnRunning={unit.isRunning}
                locale={locale}
                theme={theme}
                codePreviewSettings={codePreviewSettings}
                artifactUrls={artifactUrls}
                artifactNames={artifactNames}
                labels={labels}
                onOpenExternalUrl={onOpenExternalUrl}
              />
            ))
          )}
          {unit.browserTurnEndRows.length > 0 ? (
            <ReadonlyAssistantWorkItems
              rows={unit.browserTurnEndRows}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactUrls={artifactUrls}
              artifactNames={artifactNames}
              labels={labels}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          ) : null}
          {unit.assistantTailRows.length > 0 ? (
            <ReadonlyAssistantWorkItems
              rows={unit.assistantTailRows}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              artifactUrls={artifactUrls}
              artifactNames={artifactNames}
              labels={labels}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          ) : null}
        </div>
      </section>
    </SummaryGroupBoundaryContext.Provider>
  );
}

export function ConversationShareReadonlyTimeline(props: ConversationShareReadonlyTimelineProps) {
  return (
    <ZCodeIntlProvider initialLocale={props.locale ?? "zh-CN"}>
      <ConversationShareReadonlyTimelineContent {...props} />
    </ZCodeIntlProvider>
  );
}

function ConversationShareReadonlyTimelineContent({
  rows,
  contentBlocks,
  locale = "zh-CN",
  theme = "system",
  codePreviewSettings = DEFAULT_CODE_PREVIEW_SETTINGS,
  artifactUrls = EMPTY_ARTIFACT_URLS,
  artifactNames = EMPTY_ARTIFACT_NAMES,
  artifactWorkspaceRelativePaths = EMPTY_ARTIFACT_WORKSPACE_RELATIVE_PATHS,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenFileLink,
  onOpenCodeViewer,
  artifactOpenAction,
  unsupportedRowCount = 0,
}: ConversationShareReadonlyTimelineProps) {
  const { intl } = useZCodeIntl();
  const rowsById = new Map(rows.map((row) => [row.rowId, row] as const));
  const allBlocks = decodeConversationShareContentBlocks(contentBlocks).filter((block) => {
    const row = rowsById.get(block.fallback_row_id);
    return (
      row?.productTurnId === block.product_turn_id &&
      row.kind === (block.type === "tool-presentation" ? "toolCall" : "assistantText")
    );
  });
  const toolSnapshots = new Map(
    allBlocks.flatMap((block) =>
      block.type === "tool-presentation" &&
      rows.some(
        (row) =>
          row.kind === "toolCall" &&
          row.rowId === block.fallback_row_id &&
          row.productTurnId === block.product_turn_id,
      )
        ? [[block.fallback_row_id, block.payload] as const]
        : [],
    ),
  );
  const blocks = allBlocks
    .filter((block) => block.type === "workflow")
    .filter((block) =>
      rows.some(
        (row) =>
          row.rowId === block.fallback_row_id &&
          row.kind === "assistantText" &&
          row.productTurnId === block.product_turn_id,
      ),
    );
  const envelopes = (contentBlocks ?? []).flatMap((raw) => {
    const parsed = conversationShareContentEnvelopeSchema.safeParse(raw);
    return parsed.success &&
      rows.some(
        (row) =>
          row.kind === "assistantText" &&
          row.rowId === parsed.data.fallback_row_id &&
          row.productTurnId === parsed.data.product_turn_id,
      )
      ? [parsed.data]
      : [];
  });
  const claimed = new Set(envelopes.map((block) => block.fallback_row_id));
  const claimedResources = new Set(allBlocks.flatMap((block) => block.resource_ids));
  const fallbacks = new Map(
    rows.flatMap((row) => (row.kind === "assistantText" ? [[row.rowId, row.text] as const] : [])),
  );
  const allUnits = buildConversationTurnRenderUnits(rows);
  const units = new Map(
    buildConversationTurnRenderUnits(
      rows.filter(
        (row) =>
          !claimed.has(row.rowId) &&
          !(row.kind === "artifact" && claimedResources.has(row.artifactVersionId)),
      ),
    ).map((unit) => [unit.key, unit]),
  );

  const openShareExternalUrl = useCallback((url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      if (/^(localhost|127\..*|0\.0\.0\.0|\[::1\])$/iu.test(parsed.hostname)) return;
      window.open(parsed.toString(), "_blank", "noopener,noreferrer");
    } catch {
      // 外链来自不可信 Markdown；解析失败时保持不可操作，不交给浏览器未知协议。
    }
  }, []);
  const labels: ReadonlyLabels = {
    artifactPreview: intl.formatMessage({ id: "conversationShare.readonly.artifactPreview" }),
    unsupportedRows: intl.formatMessage({ id: "conversationShare.readonly.unsupportedRows" }),
  };
  const artifactOpenContext = useMemo<ArtifactOpenContextValue | null>(() => {
    if (
      !workspacePath ||
      artifactWorkspaceRelativePaths.size === 0 ||
      (!onOpenFileLink && !onOpenCodeViewer) ||
      !artifactOpenAction
    ) {
      return null;
    }

    return {
      artifactWorkspaceRelativePaths,
      workspacePath,
      openAction: artifactOpenAction,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
      ...(onOpenFileLink ? { onOpenFileLink } : {}),
      ...(onOpenCodeViewer ? { onOpenCodeViewer } : {}),
    };
  }, [
    artifactOpenAction,
    artifactWorkspaceRelativePaths,
    onOpenCodeViewer,
    onOpenFileLink,
    workspaceIdentity,
    workspacePath,
    workspaceRemoteSessionId,
  ]);
  return (
    <ToolSnapshotContext.Provider value={toolSnapshots}>
      <ToolPresentationCapabilitiesProvider
        value={{
          readonly: true,
          resourceUrl: (ref) => artifactUrls.get(ref),
          normalizeOutputText: (text) => normalizeConversationShareMarkdown(text, artifactNames),
        }}
      >
        <TooltipProvider delayDuration={0}>
          <PluginReferenceIconProvider value={null}>
            <ArtifactOpenContext.Provider value={artifactOpenContext}>
              <div
                className="@container/conversation flex flex-col"
                data-conversation-share-timeline
              >
                {unsupportedRowCount > 0 ? (
                  // 中性信息语义，不用黄色 warning：分享本身没出错，只是这个 build 认不出其中几行。
                  <div
                    data-conversation-share-unsupported-notice="true"
                    className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-ui-xs text-foreground-subtle"
                  >
                    <InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{labels.unsupportedRows}</span>
                  </div>
                ) : null}
                {allUnits.map((original) => {
                  const unit = units.get(original.key);
                  const turnBlocks = blocks.filter(
                    (block) =>
                      block.product_turn_id === original.header?.productTurnId &&
                      !(
                        block.payload.unavailable &&
                        !block.payload.run &&
                        block.payload.artifacts.length === 0
                      ),
                  );
                  // 已知但隐藏的占位块仍认领摘要，避免删卡后占位文字又作为 fallback 出现。
                  const fallbackBlocks = envelopes.filter(
                    (block) =>
                      block.product_turn_id === original.header?.productTurnId &&
                      !blocks.some((known) => known.id === block.id),
                  );
                  return (
                    <Fragment key={original.key}>
                      {unit ? (
                        <ReadonlyTurn
                          unit={unit}
                          locale={locale}
                          theme={theme}
                          codePreviewSettings={codePreviewSettings}
                          artifactUrls={artifactUrls}
                          artifactNames={artifactNames}
                          labels={labels}
                          onOpenExternalUrl={openShareExternalUrl}
                        />
                      ) : null}
                      {turnBlocks.length ? (
                        <div className="min-w-0 px-4 pb-5 @md/conversation:px-6">
                          <ConversationShareContent
                            blocks={turnBlocks}
                            fallbacks={fallbacks}
                            artifactUrls={artifactUrls}
                            locale={locale}
                            onOpenResource={
                              artifactOpenContext && onOpenFileLink
                                ? (id) => {
                                    const path = workspacePath
                                      ? resolveImportedArtifactPath(
                                          workspacePath,
                                          artifactWorkspaceRelativePaths.get(id),
                                        )
                                      : null;
                                    if (path && workspacePath)
                                      onOpenFileLink({
                                        path,
                                        label: artifactNames.get(id) ?? path,
                                        workspacePath,
                                        workspaceIdentity,
                                        workspaceRemoteSessionId,
                                      });
                                  }
                                : undefined
                            }
                          />
                        </div>
                      ) : null}
                      {fallbackBlocks.map((block) => (
                        <div
                          key={block.id}
                          className="px-4 pb-5 @md/conversation:px-6"
                          data-share-content-fallback={block.id}
                        >
                          <MessageResponse>
                            {fallbacks.get(block.fallback_row_id) ?? ""}
                          </MessageResponse>
                        </div>
                      ))}
                    </Fragment>
                  );
                })}
              </div>
            </ArtifactOpenContext.Provider>
          </PluginReferenceIconProvider>
        </TooltipProvider>
      </ToolPresentationCapabilitiesProvider>
    </ToolSnapshotContext.Provider>
  );
}
