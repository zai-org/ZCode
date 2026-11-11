/* oxlint-disable eslint(max-lines) -- 确认、发布进度和结构化失败详情必须共享同一 dock 状态与操作上下文。 */
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  LoaderCircle,
  ShieldCheck,
  X,
  MessagesSquare,
  ChevronRight,
} from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationShareAccessMode, ConversationShareTtlOptions } from "@zcode/shared";
import { ConversationSharePermissionPicker } from "@/ConversationSharePermissionPicker.js";
import { ConversationShareExpiryPicker } from "@/conversation-share-interaction/ConversationShareExpiryPicker.js";
import {
  DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
  type ConversationShareDisplayError,
  type ConversationShareDisplayWarnings,
  type ConversationShareProgressPhase,
} from "@/store/conversationShareSelectionStore.js";
import {
  formatConversationShareAllowedArtifacts,
  formatConversationShareArtifactType,
  resolveConversationShareIssueMessageId,
  resolveConversationShareWarningMessageId,
} from "@/lib/conversationShareError.js";

const SHARE_PROGRESS_PHASES: readonly ConversationShareProgressPhase[] = [
  "collecting",
  "uploading",
  "checking",
];

const SHARE_PHASE_LABEL_IDS: Record<ConversationShareProgressPhase, string> = {
  collecting: "conversationShare.phase.collecting",
  uploading: "conversationShare.phase.uploading",
  checking: "conversationShare.phase.checking",
};

export interface ConversationShareConfirmationDockProps {
  selectionEditing?: boolean;
  publishDisabled?: boolean;
  preflightChecking?: boolean;
  preflightContent?: ReactNode;

  selectedCount: number;
  totalCount: number;
  title?: string;
  accessMode?: ConversationShareAccessMode;
  /** 发布方服务端声明的有效期范围；缺省时不显示有效期选择。 */
  ttlOptions?: ConversationShareTtlOptions;
  ttlMs?: number | null;
  progressLabel?: string;
  progressPhase?: ConversationShareProgressPhase;
  completedArtifacts?: number;
  totalArtifacts?: number;
  onCancel: () => void;
  onEditSelection: () => void;
  onConfirm: () => void;
  onTitleChange?: (title: string) => void;
  onAccessModeChange?: (accessMode: ConversationShareAccessMode) => void;
  onTtlChange?: (ttlMs: number) => void;
  disclosureAccepted?: boolean;
  onDisclosureAcceptedChange?: (accepted: boolean) => void;
  pending?: boolean;
  error?: ConversationShareDisplayError | null;
  warnings?: ConversationShareDisplayWarnings | null;
  /** 整轮取消选择，按 productTurnId 定位（turnOrdinal 只用于展示文案）。 */
  onDeselectTurn?: (productTurnId: string) => void;
  onDismissError?: () => void;
  onDismissWarnings?: () => void;
  onCopyRequestId?: () => void;
}

const NOOP = () => {};

function ConversationShareConfirmationDockImpl({
  selectionEditing = false,
  publishDisabled = false,
  preflightChecking = false,
  preflightContent,
  selectedCount,
  totalCount,
  title = "Share",
  accessMode = DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
  ttlOptions,
  ttlMs = null,
  progressLabel,
  progressPhase = "collecting",
  completedArtifacts = 0,
  totalArtifacts = 0,
  onCancel,
  onEditSelection,
  onConfirm,
  onTitleChange = NOOP,
  onAccessModeChange = NOOP,
  onTtlChange = NOOP,
  disclosureAccepted = false,
  onDisclosureAcceptedChange = NOOP,
  pending = false,
  error = null,
  warnings = null,
  onDeselectTurn,
  onDismissError,
  onDismissWarnings,
  onCopyRequestId,
}: ConversationShareConfirmationDockProps) {
  const { intl, locale } = useZCodeIntl();
  const errorDetailsLabel = intl.formatMessage({
    id: "conversationShare.issue.details",
  });
  const disclosureRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const checkboxRef = useRef<HTMLButtonElement>(null);
  const reviewRowRef = useRef<HTMLLabelElement>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const invalidDisclosure = reviewRequired && !disclosureAccepted;
  const reviewAnimationRef = useRef<Animation | null>(null);
  useEffect(() => () => reviewAnimationRef.current?.cancel(), []);
  const handleConfirm = () => {
    if (!error && !disclosureAccepted) {
      setReviewRequired(true);
      // 仅对确认行做 transform 提示并滚动正文，不改变布局或牵动外层页面。
      const body = bodyRef.current;
      const disclosure = disclosureRef.current;
      if (body && disclosure) {
        const bodyBounds = body.getBoundingClientRect();
        const bounds = disclosure.getBoundingClientRect();
        if (bounds.top < bodyBounds.top) body.scrollTop += bounds.top - bodyBounds.top;
        else if (bounds.bottom > bodyBounds.bottom)
          body.scrollTop += bounds.bottom - bodyBounds.bottom;
      }
      checkboxRef.current?.focus({ preventScroll: true });
      reviewAnimationRef.current?.cancel();
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        reviewAnimationRef.current =
          reviewRowRef.current?.animate(
            [
              { transform: "translateX(0)" },
              { transform: "translateX(-4px)" },
              { transform: "translateX(4px)" },
              { transform: "translateX(-2px)" },
              { transform: "translateX(2px)" },
              { transform: "translateX(0)" },
            ],
            { duration: 280, easing: "ease-out" },
          ) ?? null;
      }
      return;
    }
    onConfirm();
  };
  const publishView = pending || error !== null;
  const compactProgress = pending && !error;
  const progressPercent =
    progressPhase === "collecting" ? 20 : progressPhase === "uploading" ? 58 : 82;
  const failedProgressMessageId =
    progressPhase === "collecting"
      ? "conversationShare.progress.collectingFailed"
      : progressPhase === "uploading"
        ? "conversationShare.progress.uploadingFailed"
        : "conversationShare.progress.checkingFailed";
  const progressPhaseIndex = SHARE_PROGRESS_PHASES.indexOf(progressPhase);
  const accessSummaryMessageId =
    accessMode === "public_readonly"
      ? "conversationShare.permission.linkViewerSummary"
      : accessMode === "public_importable"
        ? "conversationShare.permission.linkEditorSummary"
        : "conversationShare.permission.privateSummary";
  const footerMetaMessageId = error
    ? "conversationShare.publish.failedFooter"
    : pending
      ? "conversationShare.publish.footerMeta"
      : "conversationShare.partial.selectionCount";
  const footerMetaValues: Record<string, string | number> =
    pending && !error
      ? {
          selected: selectedCount,
          access: intl.formatMessage({ id: accessSummaryMessageId }),
        }
      : { selected: selectedCount, total: totalCount };
  const formatValue = (value: number | undefined, code: string): string => {
    if (value === undefined) return "—";
    if (code.includes("size") || code === "payload_size_limit") {
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
      if (value >= 1024) return `${Math.round(value / 1024)} KB`;
      return `${value} B`;
    }
    return String(value);
  };

  return (
    // 分享 dock 曾在同一输入区额外叠加 popover ring、阴影和固定宽度，
    // 切换时会产生不必要的层级光晕；这里只继承普通 Composer 的基础输入 surface。
    <section
      data-conversation-share-keep-open="confirmation-dock"
      data-testid="conversation-share-confirmation-dock"
      className={cn(
        "@container/share flex max-h-[70dvh] w-full min-w-0 flex-col overflow-hidden text-foreground",
        "bg-popover",
      )}
    >
      {/* 窄面板下表单会增高；正文独立滚动，避免把发布操作挤出视口。 */}
      <div
        ref={bodyRef}
        data-testid="conversation-share-confirmation-body"
        className="min-h-0 overflow-y-auto overscroll-contain"
      >
        <div
          data-testid="conversation-share-confirmation-header"
          className={cn("flex flex-wrap items-center justify-between gap-3 p-3")}
        >
          <div className="min-w-0">
            <p
              className={cn(
                "flex items-center gap-1.5 font-medium",
                "text-ui-lg",
                error && "text-destructive",
              )}
            >
              {error ? <CircleX className="size-4 shrink-0" aria-hidden="true" /> : null}
              {intl.formatMessage({
                id: error
                  ? "conversationShare.publish.failedTitle"
                  : pending
                    ? "conversationShare.generatingLink"
                    : "conversationShare.popover.title",
              })}
            </p>
            {error ? (
              <p className="mt-1 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({
                  id: "conversationShare.publish.failedDescription",
                })}
              </p>
            ) : null}
          </div>
          {
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={pending}
              onClick={onCancel}
              aria-label={intl.formatMessage({
                id: "conversationShare.result.dismiss",
              })}
            >
              <X className="size-4" />
            </Button>
          }
        </div>
        {error ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onEditSelection}
            data-testid="conversation-share-adjust"
          >
            {intl.formatMessage({ id: "conversationShare.range.adjust" })}
          </Button>
        ) : null}
        {publishView ? (
          <div
            data-testid="conversation-share-publish-progress"
            className={cn("grid gap-3", compactProgress ? "px-3 pb-3" : "p-3 pb-4")}
          >
            {compactProgress ? (
              <p className="line-clamp-2 break-words text-ui-base" title={title}>
                {title}
              </p>
            ) : null}
            <div className="grid gap-2">
              <p role="status" className={compactProgress ? "sr-only" : "text-ui-base font-medium"}>
                {error ? intl.formatMessage({ id: failedProgressMessageId }) : progressLabel}
              </p>
              <div
                className={cn(
                  "overflow-hidden rounded-full bg-background-subtle",
                  compactProgress ? "h-1" : "h-1.5",
                )}
                role="progressbar"
                aria-label={intl.formatMessage({
                  id: "conversationShare.generatingLink",
                })}
                aria-valuenow={progressPercent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  data-testid="conversation-share-progress-fill"
                  className={cn(
                    "h-full rounded-full transition-[width]",
                    error ? "bg-destructive" : "bg-primary",
                  )}
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
            <div
              className={cn(
                "grid gap-3 text-ui-sm",
                !compactProgress && "@min-[640px]/share:grid-cols-3",
              )}
            >
              {SHARE_PROGRESS_PHASES.map((phase, index) => {
                const completed = index < progressPhaseIndex;
                const failed = error !== null && phase === progressPhase;
                const active = !error && phase === progressPhase;
                const phaseState = completed
                  ? "complete"
                  : failed
                    ? "failed"
                    : active
                      ? "active"
                      : "pending";
                const PhaseIcon = completed
                  ? CircleCheck
                  : failed
                    ? CircleX
                    : active
                      ? LoaderCircle
                      : phase === "checking"
                        ? ShieldCheck
                        : Circle;
                const phaseDescription = failed
                  ? intl.formatMessage({ id: "conversationShare.phase.failed" })
                  : completed
                    ? intl.formatMessage({
                        id:
                          phase === "collecting"
                            ? "conversationShare.phase.collectingComplete"
                            : "conversationShare.phase.uploadingComplete",
                      })
                    : active && phase === "uploading" && totalArtifacts > 0
                      ? intl.formatMessage(
                          { id: "conversationShare.phase.uploadingActive" },
                          {
                            completed: completedArtifacts,
                            total: totalArtifacts,
                          },
                        )
                      : active
                        ? progressLabel
                        : intl.formatMessage({
                            id:
                              phase === "collecting"
                                ? "conversationShare.phase.collectingPending"
                                : phase === "uploading"
                                  ? "conversationShare.phase.uploadingPending"
                                  : "conversationShare.phase.checkingPending",
                          });
                return (
                  <div
                    key={phase}
                    data-testid={`conversation-share-publish-phase-${phase}`}
                    data-phase-state={phaseState}
                    className={cn(
                      "flex min-w-0 items-start gap-2",
                      failed
                        ? "text-destructive"
                        : completed || active
                          ? "text-foreground"
                          : "text-foreground-subtlest",
                    )}
                    aria-current={active || failed ? "step" : undefined}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <PhaseIcon
                        className={cn(
                          "size-4",
                          compactProgress && active && "animate-spin motion-reduce:animate-none",
                          completed
                            ? "text-success"
                            : failed
                              ? "text-destructive"
                              : active
                                ? "text-foreground"
                                : "text-foreground-subtle",
                        )}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="grid min-w-0 gap-1">
                      <strong
                        className={cn(
                          "text-ui-base",
                          !compactProgress || active ? "font-medium" : "font-normal",
                        )}
                      >
                        {intl.formatMessage({
                          id: SHARE_PHASE_LABEL_IDS[phase],
                        })}
                      </strong>
                      {!compactProgress || active ? (
                        <span
                          className={cn(
                            "text-foreground-subtle",
                            compactProgress && "text-ui-base",
                          )}
                        >
                          {phaseDescription}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <div className={cn("grid px-3", "gap-3")}>
              <label className={cn("grid gap-1 text-foreground-subtle", "text-ui-base")}>
                {intl.formatMessage({ id: "conversationShare.shareTitle" })}
                <Input
                  size="lg"
                  value={title}
                  onChange={(event) => onTitleChange(event.currentTarget.value)}
                  className={undefined}
                />
              </label>
              {
                <div className="grid gap-1 text-ui-base">
                  <span className="text-foreground-subtle">
                    {intl.formatMessage({
                      id: "conversationShare.range.label",
                    })}
                  </span>
                  <Button
                    size="lg"
                    variant="outline"
                    onClick={onEditSelection}
                    disabled={selectionEditing}
                    data-testid="conversation-share-adjust"
                    aria-expanded={selectionEditing}
                    aria-busy={preflightChecking}
                    className="w-full justify-start gap-2 border-input-border bg-input pl-3 pr-2 font-normal hover:border-input-border-hover"
                  >
                    {preflightChecking ? (
                      <LoaderCircle
                        className="size-4 shrink-0 animate-spin text-foreground-subtle"
                        aria-hidden="true"
                      />
                    ) : (
                      <MessagesSquare
                        className="size-4 shrink-0 text-foreground-subtle"
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className="min-w-0 flex-1 truncate text-left"
                      data-testid="conversation-share-range-summary"
                    >
                      {preflightChecking
                        ? intl.formatMessage({ id: "conversationShare.partial.preflightChecking" })
                        : intl.formatMessage(
                            {
                              id:
                                selectedCount === totalCount
                                  ? "conversationShare.range.all"
                                  : "conversationShare.range.selected",
                            },
                            { count: selectedCount },
                          )}
                    </span>
                    <ChevronRight
                      className="size-3.5 shrink-0 text-foreground-subtle"
                      aria-hidden="true"
                    />
                  </Button>
                  {preflightContent}
                </div>
              }
              <ConversationSharePermissionPicker
                permission={
                  accessMode === "public_readonly"
                    ? "link-viewer"
                    : accessMode === "public_importable"
                      ? "link-editor"
                      : "private"
                }
                onChange={(permission) =>
                  onAccessModeChange(
                    permission === "link-viewer"
                      ? "public_readonly"
                      : permission === "link-editor"
                        ? "public_importable"
                        : "private",
                  )
                }
              />
              {ttlOptions ? (
                <ConversationShareExpiryPicker
                  options={ttlOptions}
                  ttlMs={ttlMs}
                  onChange={onTtlChange}
                />
              ) : null}
            </div>
            {/* 设计原因：敏感信息确认需要保留警示语义，但把详细检查范围收进锚定浮层，避免确认 dock 被长文案撑高。 */}
            <section
              ref={disclosureRef}
              data-testid="conversation-share-disclosure"
              role="note"
              className={cn("mx-3 mt-3 text-ui-sm text-foreground", "py-1")}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div
                    data-testid="conversation-share-disclosure-content-row"
                    className={cn("flex min-w-0 gap-y-1", "flex-col items-start")}
                  >
                    <label
                      ref={reviewRowRef}
                      className={cn(
                        "flex min-w-0 items-start gap-2 text-ui-base",
                        invalidDisclosure && "text-warning",
                      )}
                    >
                      <Checkbox
                        ref={checkboxRef}
                        data-testid="conversation-share-disclosure-checkbox"
                        aria-invalid={invalidDisclosure}
                        checked={disclosureAccepted}
                        onCheckedChange={(checked) => {
                          setReviewRequired(false);
                          reviewAnimationRef.current?.cancel();
                          onDisclosureAcceptedChange(checked === true);
                        }}
                        className="mt-0.5"
                      />
                      <span className={"leading-5"}>
                        {intl.formatMessage({
                          id: "conversationShare.disclosure.checkbox",
                        })}
                      </span>
                    </label>
                    <div
                      data-testid="conversation-share-disclosure-supporting-row"
                      className={cn(
                        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm leading-5",
                        "pl-6",
                      )}
                    >
                      <span
                        data-testid="conversation-share-disclosure-description"
                        className="min-w-0 text-ui-sm leading-5 text-foreground-subtle"
                      >
                        {intl.formatMessage({
                          id: "conversationShare.disclosure.description",
                        })}
                      </span>
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            data-testid="conversation-share-disclosure-scope-trigger"
                            className="inline-flex shrink-0 items-center text-ui-sm leading-5 text-foreground-subtle underline underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                          >
                            {intl.formatMessage({
                              id: "conversationShare.disclosure.scope.trigger",
                            })}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          side="top"
                          align="end"
                          data-testid="conversation-share-disclosure-scope-content"
                          className="w-[22.5rem] max-w-[calc(100vw-1rem)] max-h-(--radix-popover-content-available-height) gap-3 overflow-y-auto border-popover-border p-3"
                        >
                          <PopoverTitle className="text-ui-base font-medium">
                            {intl.formatMessage({ id: "conversationShare.disclosure.scope.title" })}
                          </PopoverTitle>
                          <div className="grid gap-1">
                            <p className="text-ui-sm font-medium text-foreground-subtle">
                              {intl.formatMessage({
                                id: "conversationShare.disclosure.scope.reviewLabel",
                              })}
                            </p>
                            <ul className="grid gap-1 text-ui-base">
                              {(["conversation", "tools", "generated"] as const).map((scope) => (
                                <li key={scope}>
                                  {intl.formatMessage({
                                    id: `conversationShare.disclosure.scope.${scope}`,
                                  })}
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div className="grid gap-1">
                            <p className="text-ui-sm font-medium text-foreground-subtle">
                              {intl.formatMessage({
                                id: "conversationShare.disclosure.scope.sensitiveLabel",
                              })}
                            </p>
                            <p className="text-ui-base">
                              {intl.formatMessage({
                                id: "conversationShare.disclosure.scope.sensitive",
                              })}
                            </p>
                          </div>
                          <p className="text-ui-sm text-foreground-subtle">
                            {intl.formatMessage({ id: "conversationShare.disclosure.scope.note" })}
                          </p>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </>
        )}
        {error ? (
          // 单行 Toast 无法同时承载文件、轮次和限制上限；详情固定留在分享面板，避免用户丢失修复路径。
          <section
            role="alert"
            data-testid="conversation-share-error-details"
            className={cn(
              "mx-4 max-h-40 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/5 text-ui-base text-foreground",
              error.messageId ? "mb-2 p-2" : "mb-3 p-2.5",
            )}
          >
            <div
              data-testid="conversation-share-error-row"
              className={cn(
                "flex justify-between gap-3",
                error.messageId ? "items-center" : "mb-1.5 items-start",
              )}
            >
              <p
                data-testid="conversation-share-error-message"
                className="flex min-w-0 flex-1 items-center gap-1.5 font-medium leading-6"
              >
                <span className="min-w-0 flex-1">
                  {error.messageId
                    ? intl.formatMessage({ id: error.messageId }, { status: error.status ?? "—" })
                    : intl.formatMessage(
                        { id: "conversationShare.error.summary" },
                        { count: error.issueCount },
                      )}
                </span>
                {/* 修复原因：服务端 request ID 属于诊断信息，常驻错误区会拉高 dock 并分散修复文案注意力；改为按需 Popover 展示。 */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-testid="conversation-share-request-id-trigger"
                      aria-label={errorDetailsLabel}
                      title={errorDetailsLabel}
                      className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-destructive/30"
                    >
                      <CircleAlert className="size-4" aria-hidden="true" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    side="top"
                    sideOffset={6}
                    collisionPadding={16}
                    data-testid="conversation-share-request-id-content"
                    className="w-80 max-w-[calc(100vw-1rem)] gap-2 p-3"
                  >
                    <PopoverTitle className="text-ui-base font-medium">
                      {errorDetailsLabel}
                    </PopoverTitle>
                    {(
                      [
                        ["HTTP", error.status],
                        [
                          intl.formatMessage({
                            id: "conversationShare.issue.codeLabel",
                          }),
                          error.code,
                        ],
                        [
                          intl.formatMessage({
                            id: "conversationShare.issue.clientRequestIdLabel",
                          }),
                          error.clientRequestId,
                        ],
                        ["operationId", error.operationId],
                        [
                          intl.formatMessage({ id: "conversationShare.issue.ruleLabel" }),
                          error.rejection?.rule,
                        ],
                        [
                          intl.formatMessage({ id: "conversationShare.issue.pathLabel" }),
                          error.rejection?.path,
                        ],
                        [
                          intl.formatMessage({ id: "conversationShare.issue.fieldLabel" }),
                          error.rejection?.field,
                        ],
                        [
                          intl.formatMessage({ id: "conversationShare.issue.rowLabel" }),
                          error.rejection?.row_index === undefined
                            ? undefined
                            : error.rejection.row_index + 1,
                        ],
                        [
                          intl.formatMessage({ id: "conversationShare.issue.rowKindLabel" }),
                          error.rejection?.row_kind,
                        ],
                      ] as const
                    ).map(([label, value]) =>
                      value === undefined ? null : (
                        <p
                          key={label}
                          className="break-all text-ui-sm text-foreground-subtle select-text"
                        >
                          {label}: {value}
                        </p>
                      ),
                    )}
                    {error.requestId ? (
                      <div className="grid gap-2">
                        <p className="text-ui-sm text-foreground-subtle">
                          {intl.formatMessage({
                            id: "conversationShare.issue.requestIdLabel",
                          })}
                        </p>
                        <div className="flex min-w-0 items-start gap-2">
                          <code className="min-w-0 flex-1 break-all font-mono text-ui-base text-foreground select-text">
                            {error.requestId}
                          </code>
                          {onCopyRequestId ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={intl.formatMessage({
                                id: "conversationShare.issue.copyRequestId",
                              })}
                              onClick={onCopyRequestId}
                              className="shrink-0 px-2"
                            >
                              {intl.formatMessage({
                                id: "conversationShare.issue.copyRequestId",
                              })}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <p className="text-ui-sm text-foreground-subtle">
                        {intl.formatMessage({
                          id: "conversationShare.issue.requestIdMissing",
                        })}
                      </p>
                    )}
                  </PopoverContent>
                </Popover>
              </p>
              {onDismissError ? (
                <button
                  type="button"
                  data-testid="conversation-share-error-dismiss"
                  className="shrink-0 text-ui-sm leading-6 text-foreground-subtle underline underline-offset-2"
                  onClick={onDismissError}
                >
                  {intl.formatMessage({ id: "common.close" })}
                </button>
              ) : null}
            </div>
            {error.messageId ? null : (
              <ul className="grid gap-1.5">
                {error.issues.map((issue, index) => {
                  const messageId = resolveConversationShareIssueMessageId(issue);
                  const values = {
                    turnOrdinal: issue.turnOrdinal ?? "—",
                    artifactDisplayName: issue.artifactDisplayName ?? "—",
                    artifactType: formatConversationShareArtifactType(issue, locale),
                    extension: issue.extension ?? "—",
                    mimeType: issue.mimeType ?? "—",
                    allowedFormats: formatConversationShareAllowedArtifacts(issue, locale),
                    actual: formatValue(issue.actual, issue.code),
                    limit: formatValue(issue.limit, issue.code),
                    phase: issue.phase ?? "—",
                  };
                  return (
                    <li
                      key={`${issue.code}-${issue.rowId ?? "global"}-${index}`}
                      className="grid gap-1"
                    >
                      <p className="leading-5">{intl.formatMessage({ id: messageId }, values)}</p>
                      {issue.productTurnId !== undefined && onDeselectTurn ? (
                        <button
                          type="button"
                          className="w-fit text-ui-sm font-medium text-foreground underline underline-offset-2"
                          onClick={() => onDeselectTurn?.(issue.productTurnId!)}
                        >
                          {intl.formatMessage({
                            id: "conversationShare.issue.deselectTurn",
                          })}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {error.omittedIssueCount ? (
              <p className="mt-2 text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: "conversationShare.issue.more" },
                  { count: error.omittedIssueCount },
                )}
              </p>
            ) : null}
          </section>
        ) : null}
        {warnings && warnings.issues.length > 0 && !pending ? (
          // 发布已成功，只是部分正文引用的文件读不到被跳过；与失败区分开，也不提供「取消该轮」。
          <section
            role="status"
            data-testid="conversation-share-warning-details"
            className="mx-4 mb-3 max-h-40 overflow-y-auto rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-ui-base text-foreground"
          >
            <div className="mb-2 flex items-start justify-between gap-3">
              <p className="font-medium">
                {intl.formatMessage(
                  { id: "conversationShare.warning.summary" },
                  { count: warnings.issueCount },
                )}
              </p>
              {onDismissWarnings ? (
                <button
                  type="button"
                  className="shrink-0 text-ui-sm text-foreground-subtle underline underline-offset-2"
                  onClick={onDismissWarnings}
                >
                  {intl.formatMessage({ id: "common.close" })}
                </button>
              ) : null}
            </div>
            <ul className="grid gap-1.5">
              {warnings.issues.map((issue, index) => (
                <li key={`${issue.code}-${issue.rowId ?? "global"}-${index}`} className="leading-5">
                  {intl.formatMessage(
                    { id: resolveConversationShareWarningMessageId(issue) },
                    {
                      turnOrdinal: issue.turnOrdinal ?? "—",
                      artifactDisplayName: issue.artifactDisplayName ?? "—",
                      artifactType: formatConversationShareArtifactType(issue, locale),
                      extension: issue.extension ?? "—",
                      mimeType: issue.mimeType ?? "—",
                      allowedFormats: formatConversationShareAllowedArtifacts(issue, locale),
                      actual: formatValue(issue.actual, issue.code),
                      limit: formatValue(issue.limit, issue.code),
                      phase: issue.phase ?? "—",
                    },
                  )}
                </li>
              ))}
            </ul>
            {warnings.omittedIssueCount ? (
              <p className="mt-2 text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: "conversationShare.issue.more" },
                  { count: warnings.omittedIssueCount },
                )}
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
      <div
        data-testid="conversation-share-confirmation-actions"
        className={cn(
          "flex shrink-0 flex-wrap content-center items-center justify-between gap-2 p-3",
          compactProgress && "pt-0",
        )}
      >
        <p
          role="status"
          className={cn(
            "min-w-0 text-ui-sm leading-4 tabular-nums",
            compactProgress && "text-foreground-subtle",
            !publishView && "sr-only",
          )}
        >
          {intl.formatMessage({ id: footerMetaMessageId }, footerMetaValues)}
        </p>
        {!compactProgress ? (
          <div className="grid w-full min-w-0 grid-cols-2 gap-2 @min-[480px]/share:flex @min-[480px]/share:w-auto @min-[480px]/share:flex-1 @min-[480px]/share:flex-wrap @min-[480px]/share:justify-end">
            {/* 根因：内层按钮强制横排时仍会被外层裁切；窄屏主操作与次要操作分行。 */}
            <Button
              type="button"
              size="lg"
              disabled={
                pending ||
                selectionEditing ||
                publishDisabled ||
                selectedCount === 0 ||
                !title.trim()
              }
              onClick={handleConfirm}
              data-testid="conversation-share-confirm"
              className={cn(
                "col-span-2 whitespace-normal break-words px-3 @min-[480px]/share:order-last",
                "h-10",
              )}
            >
              {intl.formatMessage({
                id: error
                  ? "conversationShare.publish.retry"
                  : pending
                    ? "conversationShare.partial.publishing"
                    : "conversationShare.partial.confirm",
              })}
            </Button>
            {null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export const ConversationShareConfirmationDock = memo(ConversationShareConfirmationDockImpl);
