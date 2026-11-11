import { buildEditCodeViewerSource } from "@/ToolCallBlocks/renderers/edit.js";
import { CollapsedChangeSummary } from "@/ToolCallBlocks/renderers.js";
import { SummaryGroupBoundaryContext } from "@/v4/conversationRowContext.js";
import { ConsecutiveSummaryGroup } from "@/ToolCallBlocks/ToolSummaryRow.js";
import { useShallow } from "zustand/react/shallow";
import { BotTopicPreparation } from "@/v4/BotTopicPreparation.js";
import { useBotTopicInterruption } from "@/v4/botGroupDeliveryContext.js";
import { ConnectedBotGroupDeliveryAction } from "@/v4/BotGroupDeliveryAction.js";
/* eslint-disable max-lines -- turn group 需要在同一处维护普通 assistant 与后台结果的严格行序，拆分会重复 actions/preview/tail 协议。 */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  Fragment,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { ChevronRightIcon, EyeIcon } from "lucide-react";
import {
  zcodeProviderRuntimeHeadersErrorCode,
  type HighspeedMessageMeta,
  type ZCodeApiRetryStatus,
} from "@zcode/shared";
import {
  TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_BACKGROUND_RESULT_TITLE,
  TID_CHAT_LOADING,
  testId,
} from "@zcode/shared/test-ids";
import type { ApiRetryState, ConversationRowTarget } from "@zcode/shared/zcode-protocol-v4";
import { ChatLoading } from "@/components/ai-elements/chat-loading.js";
import { ChatApiRetryStatus } from "@/chat-input-toolbar/display.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { MessageActions } from "@/components/ai-elements/message.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import {
  CronCreateAutomationCard,
  isCronAutomationCardToolCall,
  readCronCreateAutomationSummary,
  type CronCreateAutomationSummary,
} from "@/ToolCallBlocks/renderers/cron-create.js";
import {
  isOffPeakCreateToolCall,
  OffPeakCreateTaskCard,
  readOffPeakCreateTaskSummary,
  type OffPeakCreateTaskSummary,
} from "@/ToolCallBlocks/renderers/offpeak-create.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { HighspeedShareDialog } from "@/highspeed/HighspeedShareNoticeCard.js";
import { isHighspeedShareEligible } from "@/highspeed/highspeedShare.js";
import {
  aggregateHighspeedCardMetrics,
  getHighspeedTurnByCommandId,
  getHighspeedTurnDependencies,
  subscribeHighspeedTurns,
  type HighspeedShareMetrics,
} from "@/highspeed/highspeedTurnStore.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  buildAssistantCodeCommentCards,
  projectAssistantCodeComments,
  type AssistantCodeCommentCard,
} from "@/lib/assistantCodeComment.js";
import { useAssistantPreviewCardsForAssistantTextRow } from "@/v4/useAssistantPreviewCardsForRow.js";
import { shouldShowTurnChatLoading } from "@/v4/chatLoadingVisibility.js";
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
import { ConversationAgentToolCallRow } from "@/v4/ConversationAgentToolCallRow.js";
import { ConversationFileSummaryPanel } from "@/v4/ConversationFileSummaryPanel.js";
import {
  WorkflowNotificationToolRow,
  workflowRowNotification,
  type WorkflowRowNotification,
} from "@/v4/WorkflowNotificationToolRow.js";
import { ConversationWorkflowDigests } from "@/v4/ConversationWorkflowDigests.js";
import { ConversationWorkflowCompletion } from "@/v4/ConversationWorkflowCompletion.js";
import { resolveWorkflowTurnDigests } from "@/v4/workflowTurnDigests.js";
import { resolveWorkflowTurnCompletion } from "@/v4/workflowTurnCompletion.js";
import {
  ConversationAssistantTextActions,
  type UserInputEditHandler,
} from "@/v4/ConversationRowView.js";
import { readAssistantFeedback } from "@/v4/ConversationRowView.js";
import type {
  AssistantFeedbackHandler,
  EditWorkspaceRewindAvailability,
} from "@/v4/ConversationRowView.js";
import { type ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type {
  AssistantWorkRow,
  ConversationTurnRenderUnit,
  ConversationTurnWorkSegment,
} from "@/v4/conversationTurnRenderUnits.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import { ConversationTurnRow, resolveAssistantCopyText } from "@/v4/ConversationTurnRow.js";
import { ConversationHookDetailsAction } from "@/v4/ConversationHookDetailsAction.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

interface ConversationTurnGroupProps {
  unit: ConversationTurnRenderUnit;
  /** Timeline 的共享 UI 时钟；用于在 Highspeed 过期边界立即撤销运行态紫色流光。 */
  nowMs?: number;
  /** 仅由 Timeline 注入给当前 live turn；历史 turn 永远不携带运行时 retry。 */
  apiRetry?: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onEdit?: UserInputEditHandler;
  /** 会话首轮：顶部留白由 Timeline 的状态胶囊 inset 提供，本轮不再留顶部 padding。 */
  topClearedByTimeline?: boolean;
}

interface CronAutomationTurnCard {
  rowId: number;
  toolCallId: string;
  automation: CronCreateAutomationSummary;
}

interface OffPeakTurnCard {
  rowId: number;
  toolCallId: string;
  task: OffPeakCreateTaskSummary;
}

const MIN_VISIBLE_API_RETRY_ATTEMPT = 3;

interface HighspeedOutputFooterProps {
  generatedLabel: string;
  shareLabel: string;
  shareAriaLabel: string;
  shareEnabled: boolean;
  sharePending: boolean;
  onShare: () => void;
}

function HighspeedOutputFooter({
  generatedLabel,
  shareLabel,
  shareAriaLabel,
  shareEnabled,
  sharePending,
  onShare,
}: HighspeedOutputFooterProps) {
  return (
    <div
      data-highspeed-output-footer="true"
      className="relative flex w-full items-center justify-center py-[18px] opacity-80"
    >
      <div aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-border" />
      <div className="relative flex items-center gap-2 bg-background px-3">
        <span className="text-ui-base text-foreground-subtle">{generatedLabel}</span>
        {shareEnabled ? (
          <Button
            type="button"
            variant="ghost"
            size="default"
            className="h-7 gap-1 rounded-[8px] bg-black/5 px-2 py-1 text-ui-base font-medium leading-5 text-foreground hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
            data-highspeed-output-share="true"
            disabled={sharePending}
            aria-label={shareAriaLabel}
            onClick={onShare}
          >
            <EyeIcon
              className="size-4 text-foreground/85"
              strokeWidth={4 / 3}
              aria-hidden="true"
              data-highspeed-output-share-icon="true"
            />
            {shareLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function toRetryStatus(apiRetry: ApiRetryState): ZCodeApiRetryStatus {
  const attempt = Math.max(1, Math.floor(apiRetry.attempt));
  // v4 maxAttempts 包含首次请求，而展示口径是重试次数；直接展示会把
  // 默认 10 次重试写成 1/11。
  const maxRetries = Math.max(Math.floor(apiRetry.maxAttempts) - 1, attempt);
  return {
    kind: "api_retry",
    attempt,
    maxRetries,
    retryDelayMs: 0,
    errorStatus: null,
    error: apiRetry.reasonCode,
  };
}

function TurnChatLoadingSlot({
  apiRetry,
  eligible,
  initialElapsedMs,
}: {
  apiRetry: ApiRetryState | null;
  eligible: boolean;
  initialElapsedMs: number;
}) {
  const { intl, locale } = useZCodeIntl();
  const retryStatus = useMemo(() => (apiRetry ? toRetryStatus(apiRetry) : null), [apiRetry]);
  // 配置读取尚未发出模型请求，首次恢复就显示进度，避免用户误以为消息已发送。
  // 其余前两次短暂恢复对用户等价于普通加载；保留 apiRetry 运行态，但只在
  // 第三次重试开始后显示计数。必须在 retry/loading 分支前收敛，否则会留下空 slot，
  // 而不是回退到 ChatLoading。
  const visibleRetryStatus =
    retryStatus &&
    (apiRetry?.reasonCode === zcodeProviderRuntimeHeadersErrorCode.configNetwork ||
      retryStatus.attempt >= MIN_VISIBLE_API_RETRY_ATTEMPT)
      ? retryStatus
      : null;
  if (!visibleRetryStatus && !eligible) return null;
  return (
    <div data-zcode-chat-loading-slot="true" className="min-h-5">
      {visibleRetryStatus ? (
        <ChatApiRetryStatus apiRetry={visibleRetryStatus} intl={intl} locale={locale} />
      ) : (
        // running 是 ChatLoading 的权威事实；额外静默计时会让 projection
        // 更新反复重启可见性，并使 UI 晚于真实状态。
        <ChatLoading loading data-testid={TID_CHAT_LOADING} initialElapsedMs={initialElapsedMs} />
      )}
    </div>
  );
}

function useConversationAssistantWorkItems(
  rows: readonly AssistantWorkRow[],
  context: ConversationRowRenderContext,
  stageTailIsRunning = false,
) {
  const showReasoning = context.messageStreamShowReasoning === true;
  const firstReasoningRowId = context.messageStreamFirstReasoningRowId;
  return useMemo(
    () =>
      buildAssistantWorkRenderItems(rows, {
        messageStreamShowReasoning: showReasoning,
        messageStreamShowTodos: context.messageStreamShowTodos,
        ...(firstReasoningRowId !== undefined
          ? { messageStreamFirstReasoningRowId: firstReasoningRowId }
          : {}),
      }),
    [firstReasoningRowId, rows, showReasoning, context.messageStreamShowTodos],
  );
}

function ConversationAssistantWorkItems({
  rows,
  stageTailIsRunning = false,
  ...props
}: {
  rows: readonly AssistantWorkRow[];
  stageTailIsRunning?: boolean;
} & Omit<React.ComponentProps<typeof ConversationAssistantWorkContent>, "items">) {
  const items = useConversationAssistantWorkItems(rows, props.context, stageTailIsRunning);
  return <ConversationAssistantWorkContent items={items} {...props} />;
}

function ConversationAssistantWorkContent({
  items,
  context,
  assistantCodeCommentProjectionEnabled = false,
  historyContainer,
}: {
  items: readonly ConversationAssistantWorkRenderItem[];
  context: ConversationRowRenderContext;
  /** running turn 的正文可能暂时落在 history renderer，仍需隐藏特化协议原文。 */
  assistantCodeCommentProjectionEnabled?: boolean;
  historyContainer?: { chunkKey: string; open: boolean };
}) {
  const { intl } = useZCodeIntl();
  const summaryBoundary = useContext(SummaryGroupBoundaryContext);
  const groups = useMemo(() => groupConsecutiveAssistantSummaries(items), [items]);
  const groupKeys = useContinuousGroupKeys(groups, (group) => ({
    kind: "summary",
    rowIds: group.items.map((item) => item.row.rowId),
    key: group.items.length < 2 ? group.items[0]!.key : undefined,
  }));
  // history 外壳不能在这层投影前创建：当 CUA 消费原 message
  // 或运行中 shell 被延迟分类时，会留下 pt-5 和空的 gap-4 容器。只有确认
  // 内层存在可渲染项后才创建 CollapsibleContent，让外壳与内容一起消失。
  if (items.length === 0) {
    return null;
  }

  const renderItem = (item: ConversationAssistantWorkRenderItem) =>
    item.kind === "row" ? (
      <ConversationTurnRow
        key={item.key}
        row={item.row}
        context={context}
        hideAssistantActions={item.row.kind === "assistantText"}
        assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
      />
    ) : (
      <ConversationAgentToolCallRow key={item.key} item={item} context={context} />
    );
  const content = (
    <div className="flex flex-col gap-1" data-conversation-work-items>
      {groups.map((group, index) => {
        if (group.items.length < 2) return renderItem(group.items[0]!);
        const last = group.items.at(-1)!;
        const active = getActiveAssistantSummaryItem(group.items);
        const current = active ?? last;
        const iconItem = getAssistantSummaryIconItem(group.items);
        // 文案与组头共用结构闭合条件，不能以子工具是否运行判断完成。
        const completed = !(
          summaryBoundary.taskRunning && summaryBoundary.tailRowId === last.row.rowId
        );
        const statistics = formatAssistantSummaryStatistics(
          group.items,
          intl,
          context.workspacePath,
          completed,
        );
        const changes = getAssistantSummaryChangeFiles(group.items, context.workspacePath);
        return (
          <ConsecutiveSummaryGroup
            key={groupKeys[index]}
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
                  basePath={context.workspacePath}
                  onOpenFile={
                    context.onOpenCodeViewer
                      ? (file) => context.onOpenCodeViewer?.(buildEditCodeViewerSource(file))
                      : undefined
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

  if (!historyContainer) {
    return content;
  }

  return (
    <CollapsibleContent
      // 运行时确认此处 overflow-hidden 裁掉外叠徽标；扩展绘制边界并抵消位移，保留折叠裁切。
      className="-mx-1 -mb-1 px-1 pb-1"
      data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_CONTENT, historyContainer.chunkKey)}
      data-history-open={String(historyContainer.open)}
    >
      <div className="pt-5">{content}</div>
    </CollapsibleContent>
  );
}

function resolveCronAutomationTurnCards(
  rows: readonly AssistantWorkRow[],
): CronAutomationTurnCard[] {
  let cards: CronAutomationTurnCard[] = [];

  for (const row of rows) {
    if (row.kind !== "toolCall" || row.status !== "success") {
      continue;
    }

    const normalizedToolName = row.toolName.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (normalizedToolName === "crondelete") {
      const deletedAutomationId = readCronDeleteAutomationId(row);
      if (deletedAutomationId) {
        // 只累计本轮成功的 Create/Update 会忽略后续 CronDelete，导致已经
        // 撤销的中间结果仍被提升成轮尾成功卡片。
        cards = cards.filter((card) => card.automation.automationId !== deletedAutomationId);
      }
      continue;
    }

    const node = toolCallRowToLegacyNode(row);
    if (!isCronAutomationCardToolCall(node.toolCall)) {
      continue;
    }

    const automation = readCronCreateAutomationSummary(node.toolCall);
    if (!automation) {
      continue;
    }

    if (automation.automationId) {
      cards = cards.filter((card) => card.automation.automationId !== automation.automationId);
    }
    cards.push({
      rowId: row.rowId,
      toolCallId: row.toolCallId,
      automation,
    });
  }

  return cards;
}

// 只收本轮 status==="success" 的 OffPeakCreate；同 id 重复输出保留最新一次。
// 刻意不复用 resolveCronAutomationTurnCards——那套带 CronDelete 撤销过滤语义，闲时无对应工具。
function resolveOffPeakTurnCards(rows: readonly AssistantWorkRow[]): OffPeakTurnCard[] {
  let cards: OffPeakTurnCard[] = [];

  for (const row of rows) {
    if (row.kind !== "toolCall" || row.status !== "success") {
      continue;
    }
    const node = toolCallRowToLegacyNode(row);
    if (!isOffPeakCreateToolCall(node.toolCall)) {
      continue;
    }
    const task = readOffPeakCreateTaskSummary(node.toolCall);
    if (!task) {
      continue;
    }
    if (task.offPeakTaskId) {
      cards = cards.filter((card) => card.task.offPeakTaskId !== task.offPeakTaskId);
    }
    cards.push({
      rowId: row.rowId,
      toolCallId: row.toolCallId,
      task,
    });
  }

  return cards;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

function readCronDeleteAutomationId(
  row: Extract<AssistantWorkRow, { kind: "toolCall" }>,
): string | undefined {
  for (const candidate of [row.output?.text, row.input, row.inputText]) {
    const record = parseJsonRecord(candidate);
    const id = record?.id;
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
  }
  return undefined;
}

function CronAutomationTurnCards({
  cards,
  context,
}: {
  cards: readonly CronAutomationTurnCard[];
  context: ConversationRowRenderContext;
}) {
  if (cards.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map((card) => (
        <CronCreateAutomationCard
          key={`${card.rowId}:${card.toolCallId}`}
          automation={card.automation}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
        />
      ))}
    </div>
  );
}

function OffPeakTurnCards({
  cards,
  context,
}: {
  cards: readonly OffPeakTurnCard[];
  context: ConversationRowRenderContext;
}) {
  if (cards.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map((card) => (
        <OffPeakCreateTaskCard
          key={`${card.rowId}:${card.toolCallId}`}
          task={card.task}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
        />
      ))}
    </div>
  );
}

function AssistantHistoryStatus({
  segment,
  open,
  highspeed,
  highspeedMeta,
  sourceCommandIds,
  collapsible = true,
}: {
  segment: ConversationTurnWorkSegment;
  open: boolean;
  highspeed: boolean;
  highspeedMeta?: HighspeedMessageMeta;
  sourceCommandIds: readonly string[];
  collapsible?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const topicInterrupted = useBotTopicInterruption(sourceCommandIds);
  const durationLabel = formatConversationWorkDuration(
    segment.workStatus?.durationMs,
    intl,
    locale,
  );
  const savedDurationLabel =
    segment.workStatus?.state === "completed" &&
    highspeedMeta?.savedDurationMs !== undefined &&
    highspeedMeta.savedDurationMs > 0
      ? formatConversationWorkDuration(highspeedMeta.savedDurationMs, intl, locale)
      : null;
  const label =
    segment.workStatus?.state === "interrupted"
      ? intl.formatMessage({
          id: topicInterrupted ? "chat.history.topicInterrupted" : "chat.history.stopped",
        })
      : segment.workStatus?.state === "running"
        ? intl.formatMessage({ id: "chat.history.workingFor" }, { duration: durationLabel ?? "" })
        : durationLabel
          ? intl.formatMessage({ id: "chat.history.workedFor" }, { duration: durationLabel })
          : intl.formatMessage({ id: "chat.history.worked" });

  const Status = collapsible ? CollapsibleTrigger : "span";

  return (
    <div
      className={cn(
        "flex w-full flex-wrap items-center justify-between gap-2 border-b",
        highspeed ? "border-icon-purple/30 pb-3 pl-1" : "border-[var(--color-border)]/50 pb-2",
      )}
    >
      <Status
        data-testid={
          collapsible ? testId(TID_CHAT_ASSISTANT_HISTORY_TRIGGER, segment.key) : undefined
        }
        data-history-open={collapsible ? String(open) : undefined}
        className="group/history-message inline-flex max-w-full items-center gap-2 text-left text-ui-base text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
      >
        <span
          className={cn("truncate", highspeed && "font-medium leading-5 text-icon-purple")}
          data-highspeed-duration={highspeed ? "true" : undefined}
        >
          {label}
        </span>
        {collapsible && !segment.assistantHistoryDefaultOpen ? (
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-[var(--color-foreground-subtlest)] opacity-70 transition-transform",
              open ? "rotate-90" : "rotate-0",
            )}
          />
        ) : null}
      </Status>
      {highspeed ? (
        <div className="ml-auto flex shrink-0 items-center gap-2 text-icon-purple">
          {savedDurationLabel ? (
            <span className="text-ui-sm font-medium leading-4" data-highspeed-saved-duration="true">
              {intl.formatMessage(
                { id: "chat.highspeed.savedDuration" },
                { duration: savedDurationLabel },
              )}
            </span>
          ) : null}
          <span
            className="rounded-full bg-hover px-2 py-0.5 text-ui-sm leading-4"
            data-highspeed-status-tag="true"
          >
            {intl.formatMessage({ id: "chat.highspeed.statusTag" })}
          </span>
        </div>
      ) : null}
    </div>
  );
}

interface GroupIdentity<T> {
  items: readonly T[];
  keys: string[];
  nextId: number;
}

function useContinuousGroupKeys<T>(
  items: readonly T[],
  describe: (item: T) => { kind: string; rowIds: readonly number[]; key?: string },
): string[] {
  const reconcile = (previous?: GroupIdentity<T>): GroupIdentity<T> => {
    const previousRows = new Map<number, { kind: string; key: string }>();
    previous?.items.forEach((item, index) => {
      const group = describe(item);
      // 独立行没有分组组件；不能让新增的分组误继承独立行身份。
      if (group.key !== undefined) return;
      const identity = { kind: group.kind, key: previous.keys[index]! };
      for (const rowId of group.rowIds) previousRows.set(rowId, identity);
    });
    const usedKeys = new Set<string>();
    let nextId = previous?.nextId ?? 0;
    const keys = items.map((item) => {
      const group = describe(item);
      if (group.key !== undefined) return group.key;
      const inherited = group.rowIds
        .map((rowId) => previousRows.get(rowId))
        .find((identity) => identity?.kind === group.kind && !usedKeys.has(identity.key));
      const key = inherited?.key ?? `${group.kind}:${group.rowIds[0]}:${nextId++}`;
      usedKeys.add(key);
      return key;
    });
    return { items, keys, nextId };
  };
  const [previous, setIdentity] = useState(() => reconcile());
  const identity = previous.items === items ? previous : reconcile(previous);
  // 首行会随补页变化，右边界会随追加变化。工作段和内层摘要都按共有行延续身份；
  // 拆分时原 key 仅复用一次。条件式 render state 让 React 一起提交/丢弃投影与身份，
  // 避免 effect 闪帧及 ref 并发污染；各列表只持有上一版身份，随列表卸载释放。
  if (identity !== previous) setIdentity(identity);
  return identity.keys;
}

function ConversationWorkSegmentFlow({
  segment,
  turnRunning,
  sourceCommandIds,
  context,
  onFork,
  onRetry,
  onEdit,
  editWorkspaceRewindAvailability,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  canForkLatestAssistant,
  canRetryLatestAssistant,
  highspeed,
  highspeedMeta,
}: {
  segment: ConversationTurnWorkSegment;
  turnRunning: boolean;
  sourceCommandIds: readonly string[];
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onEdit?: ConversationTurnGroupProps["onEdit"];
  editWorkspaceRewindAvailability: EditWorkspaceRewindAvailability;
  assistantCopyText?: string;
  assistantPreviewCards: AssistantPreviewCard[];
  assistantPreviewCardsAutoOpenKey?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  canForkLatestAssistant: boolean;
  canRetryLatestAssistant: boolean;
  highspeed: boolean;
  highspeedMeta?: HighspeedMessageMeta;
}) {
  // 外层过程收纳由工作段独立控制，不能由内部工具分组隐藏入口或强制展开。
  const [historyOpen, setHistoryOpen] = useState(segment.assistantHistoryDefaultOpen);
  const flowItemKeys = useContinuousGroupKeys(segment.flowItems, (item) =>
    item.kind === "userInput" || item.kind === "assistantText"
      ? { kind: item.kind, rowIds: [item.row.rowId], key: `${item.kind}:${item.row.rowId}` }
      : { kind: item.kind, rowIds: item.rows.map((row) => row.rowId) },
  );
  useEffect(() => {
    setHistoryOpen(segment.assistantHistoryDefaultOpen);
  }, [segment.assistantHistoryDefaultOpen, segment.key]);

  // 恢复外层收纳时曾覆盖 staging 的去重条件，导致 Working 标题与 ChatLoading 同时显示。
  // 整轮运行中只保留加载提示，过程内容展开；内部工具分组仍独立管理自己的收纳。
  const shouldShowHistoryStatus =
    !turnRunning && segment.workStatus !== undefined && segment.workStatus.state !== "running";
  const firstAssistantFlowItemIndex = segment.flowItems.findIndex(
    (item) => item.kind !== "userInput",
  );
  let historyChunkIndex = 0;
  const open = turnRunning || segment.assistantHistoryDefaultOpen || historyOpen;

  return (
    <Collapsible
      open={open}
      onOpenChange={turnRunning || segment.assistantHistoryDefaultOpen ? undefined : setHistoryOpen}
      // 外层 flex gap 不属于 Radix 测量的 content 高度，收起到 0 后会在
      // display:none 的最后一帧再少 20px。普通兄弟用外边距保持原盒模型，history
      // 的间距则放进动画层。
      className="history-message flex flex-col [&>*+*:not([data-slot='collapsible-content'])]:mt-5"
    >
      {segment.flowItems.map((item, index) => {
        const showHistoryStatus = shouldShowHistoryStatus && index === firstAssistantFlowItemIndex;
        let content: React.ReactNode;

        if (item.kind === "userInput") {
          const userRow = (
            <ConversationTurnRow
              row={item.row}
              context={context}
              onEdit={item.row.actions?.canEdit === true ? onEdit : undefined}
              editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
            />
          );
          content = userRow;
        } else if (item.kind === "assistantHistory") {
          const chunkKey =
            historyChunkIndex === 0 ? segment.key : `${segment.key}:chunk-${historyChunkIndex}`;
          historyChunkIndex += 1;
          content = (
            <ConversationAssistantWorkItems
              rows={item.rows}
              context={context}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
              historyContainer={{ chunkKey, open }}
            />
          );
        } else if (item.kind === "assistantText") {
          content = (
            <ConversationTurnRow
              row={item.row}
              context={context}
              onFork={item.latest && canForkLatestAssistant ? onFork : undefined}
              onRetry={item.latest && canRetryLatestAssistant ? onRetry : undefined}
              hideAssistantActions={!item.latest}
              deferAssistantActions={item.latest}
              assistantCopyText={item.latest ? assistantCopyText : undefined}
              assistantPreviewCards={item.latest ? assistantPreviewCards : undefined}
              assistantPreviewCardsAutoOpenKey={
                item.latest ? assistantPreviewCardsAutoOpenKey : undefined
              }
              assistantCodeCommentCards={item.latest ? assistantCodeCommentCards : undefined}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          );
        } else {
          content = (
            <ConversationAssistantWorkItems
              rows={item.rows}
              context={context}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          );
        }

        return (
          <Fragment key={flowItemKeys[index]}>
            {showHistoryStatus ? (
              <AssistantHistoryStatus
                segment={segment}
                open={open}
                highspeed={highspeed}
                highspeedMeta={highspeedMeta}
                sourceCommandIds={sourceCommandIds}
              />
            ) : null}
            {content}
          </Fragment>
        );
      })}
      {shouldShowHistoryStatus && firstAssistantFlowItemIndex < 0 ? (
        <AssistantHistoryStatus
          segment={segment}
          sourceCommandIds={sourceCommandIds}
          open={open}
          highspeed={highspeed}
          highspeedMeta={highspeedMeta}
        />
      ) : null}
    </Collapsible>
  );
}

function ConversationTurnFlow({
  unit,
  apiRetry,
  context,
  onFork,
  onRetry,
  onEdit,
  editWorkspaceRewindAvailability,
  assistantCopyText,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  assistantPreviewCardsAutoOpenKey,
  highspeed,
  highspeedMeta,
}: {
  unit: ConversationTurnRenderUnit;
  apiRetry: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onEdit?: ConversationTurnGroupProps["onEdit"];
  editWorkspaceRewindAvailability: EditWorkspaceRewindAvailability;
  assistantCopyText?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  assistantPreviewCardsAutoOpenKey?: string;
  highspeed: boolean;
  highspeedMeta?: HighspeedMessageMeta;
}) {
  // 产品语义：可见正文或工具不代表主轮已经结束；ChatLoading 跟随最后一轮
  // running 生命周期，但等待用户回答/授权时由交互 UI 独占进度反馈。
  const showLoading = shouldShowTurnChatLoading({
    blockedByActiveWork: context.chatLoadingBlockedByActiveWork === true,
    blockedByInteraction: context.chatLoadingBlockedByInteraction === true,
    isLastTurn: unit.isLastTurn,
    isRunning: unit.isRunning,
    rows: unit.assistantWorkRows,
  });
  const assistantPreviewCards = useAssistantPreviewCardsForAssistantTextRow({
    row: unit.latestAssistantTextRow,
    assistantTextRows: unit.assistantTextRows,
    latestAssistantTextRow: unit.latestAssistantTextRow,
    workspacePath: context.workspacePath,
    workspaceHomePath: context.workspaceHomePath,
    compactForRemoteControl: context.compactForRemoteControl,
    fileChangesTarget: unit.header?.entityId
      ? { rowId: unit.header.rowId, entityId: unit.header.entityId }
      : null,
    fileChangesState: unit.header?.fileChanges?.state,
    fetchFileChanges: context.fetchFileChanges,
  });

  if (unit.timelineOnly) {
    return (
      <div className="flex flex-col gap-2">
        <ConversationAssistantWorkItems
          rows={unit.assistantWorkRows}
          context={context}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
        <TurnChatLoadingSlot
          apiRetry={apiRetry}
          eligible={showLoading}
          initialElapsedMs={unit.workStatus?.durationMs ?? 0}
        />
      </div>
    );
  }

  const projectedWorkSegments = unit.workSegments ?? [];
  const workSegments: ConversationTurnWorkSegment[] =
    projectedWorkSegments.length > 0
      ? projectedWorkSegments.length === 1
        ? [
            {
              ...projectedWorkSegments[0]!,
              // 兼容仍直接构造/覆写旧 render unit 的调用方；真实 guide 多段不走这个分支。
              assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
            },
          ]
        : projectedWorkSegments
      : [
          {
            key: unit.key,
            flowItems: unit.flowItems,
            assistantWorkRows: unit.assistantWorkRows,
            assistantHistoryRows: unit.assistantHistoryRows,
            assistantFollowingRows: unit.assistantFollowingRows,
            assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
            ...(unit.workStatus ? { workStatus: unit.workStatus } : {}),
          },
        ];
  if (
    workSegments.every(
      (segment) => segment.flowItems.length === 0 && segment.workStatus === undefined,
    ) &&
    !showLoading
  ) {
    return null;
  }

  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const canRetryLatestAssistant = latestAssistantTextRow?.actions?.canRetry === true;
  const canForkLatestAssistant = latestAssistantTextRow?.actions?.canFork === true;

  // 即使恢复了 guide 的 row 全序，也不能让所有 history chunk 共享同一个
  // Collapsible。accepted guide 现在由 CLI workSegments 定界，每段组件自行维护折叠状态。
  return (
    <div className="flex flex-col gap-5 [&>[data-zcode-chat-loading-slot]:not(:first-child)]:-mt-2">
      {workSegments.map((segment) => (
        <ConversationWorkSegmentFlow
          key={segment.key}
          segment={segment}
          turnRunning={unit.isRunning}
          sourceCommandIds={[
            ...segment.flowItems.flatMap((item) =>
              item.kind === "userInput" && item.row.sourceCommandId
                ? [item.row.sourceCommandId]
                : [],
            ),
            ...(segment === workSegments[0] && unit.header?.sourceCommandId
              ? [unit.header.sourceCommandId]
              : []),
          ]}
          context={context}
          onFork={onFork}
          onRetry={onRetry}
          onEdit={onEdit}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          assistantCopyText={assistantCopyText}
          assistantPreviewCards={assistantPreviewCards}
          assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          canForkLatestAssistant={canForkLatestAssistant}
          canRetryLatestAssistant={canRetryLatestAssistant}
          highspeed={highspeed}
          highspeedMeta={highspeedMeta}
        />
      ))}
      <TurnChatLoadingSlot
        apiRetry={apiRetry}
        eligible={showLoading}
        initialElapsedMs={unit.workStatus?.durationMs ?? 0}
      />
    </div>
  );
}

/**
 * 能撑起「后台结果头」这套渲染的来源白名单。
 *
 * 这里刻意仍是白名单而不是直接信任 schema：`originMeta` 在 userInputRow 上是 optional，
 * 跨版本仍可能出现第四个取值，而没见过的来源拿不到合适的标题语义，退回普通 assistant
 * 分支比谎报一个标题好。
 *
 * workflow run 的 `backgroundSource` 是 `"workflow"`（CLI 侧
 * `background-tasks.ts` 在 CreateWorkflow 终态上报，title 由 `workflowTaskSubject` 铸造），
 * 原本落在白名单外，于是一条 run 跑完之后那一轮**既没有标题、也退化成按工时折叠的普通
 * assistant 段落**——后台结果分组整个消失。标题不需要本地化：它由 CLI 权威给出，
 * bash / subagent 同样直接透传。
 */
const BACKGROUND_RESULT_TITLE_SOURCES: ReadonlySet<string> = new Set([
  "bash",
  "subagent",
  "workflow",
]);

function resolveBackgroundResultTitle(unit: ConversationTurnRenderUnit): string | undefined {
  if (unit.header?.origin !== "backgroundResult") return undefined;
  const originMeta = unit.header.originMeta;
  if (!originMeta?.workId.trim() || !originMeta.title.trim()) return undefined;
  if (!BACKGROUND_RESULT_TITLE_SOURCES.has(originMeta.backgroundSource)) {
    return undefined;
  }
  return originMeta.title.trim();
}

/**
 * 该轮是否以 workflow 通知卡（ToolLayout 行）开头。
 *
 * 用于两处：`ConversationBackgroundResultWork` 决定渲染通知行还是裸标题行；轮容器决定是否
 * 去掉轮顶 `pt-14`。后台结果轮没有可见的 user 行，通知卡就是轮内第一个节点——若照常保留
 * 轮顶 padding，卡片上方会叠出 56px + 上一轮 pb-5 共约 76px 的空白，用户判为多余。
 */
function resolveWorkflowNotification(
  unit: ConversationTurnRenderUnit,
): WorkflowRowNotification | undefined {
  if (unit.header?.origin !== "backgroundResult") return undefined;
  return workflowRowNotification(unit.header.originMeta);
}

function ConversationBackgroundResultWork({
  unit,
  apiRetry,
  context,
  onFork,
  onRetry,
  title,
  assistantCopyText,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  assistantPreviewCardsAutoOpenKey,
}: {
  unit: ConversationTurnRenderUnit;
  apiRetry: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  title: string;
  assistantCopyText?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  assistantPreviewCardsAutoOpenKey?: string;
}) {
  const [historyOpen, setHistoryOpen] = useState(unit.assistantHistoryDefaultOpen);
  useEffect(() => {
    setHistoryOpen(unit.assistantHistoryDefaultOpen);
  }, [unit.assistantHistoryDefaultOpen, unit.key]);
  const open =
    !unit.workStatus || unit.isRunning || unit.assistantHistoryDefaultOpen || historyOpen;
  const historySegment: ConversationTurnWorkSegment = {
    key: unit.key,
    flowItems: unit.flowItems,
    assistantWorkRows: unit.assistantWorkRows,
    assistantHistoryRows: unit.assistantHistoryRows,
    assistantFollowingRows: unit.assistantFollowingRows,
    assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
    ...(unit.workStatus ? { workStatus: unit.workStatus } : {}),
  };
  // 后台通知可能有结果，但主模型没有可见过程；原来的空容器仍占外层 gap，
  // 点击收起会在 display:none 时跳 20px。入口与内容共用同一份可见工作项投影。
  const historyItems = useConversationAssistantWorkItems(unit.assistantHistoryRows, context);
  const hasHistory = historyItems.length > 0;
  const hasFollowing = unit.assistantFollowingRows.length > 0;
  const showLoading = shouldShowTurnChatLoading({
    blockedByActiveWork: context.chatLoadingBlockedByActiveWork === true,
    blockedByInteraction: context.chatLoadingBlockedByInteraction === true,
    isLastTurn: unit.isLastTurn,
    isRunning: unit.isRunning,
    rows: unit.assistantWorkRows,
  });
  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const assistantPreviewCards = useAssistantPreviewCardsForAssistantTextRow({
    row: latestAssistantTextRow,
    assistantTextRows: unit.assistantTextRows,
    latestAssistantTextRow,
    workspacePath: context.workspacePath,
    workspaceHomePath: context.workspaceHomePath,
    compactForRemoteControl: context.compactForRemoteControl,
    fileChangesTarget: unit.header?.entityId
      ? { rowId: unit.header.rowId, entityId: unit.header.entityId }
      : null,
    fileChangesState: unit.header?.fileChanges?.state,
    fetchFileChanges: context.fetchFileChanges,
  });

  // 后台唤醒轮与普通回复使用相同的完成态折叠；耗时只统计本次唤醒轮。
  //
  // workflow run 的 workflow 通知带结构化载荷时改渲染既有工具卡语法的通知行（替换裸标题行）；
  // 载荷缺席（批量轮、旧 transcript、bash/subagent）→ 原样退回标题行。
  const workflowNotification = resolveWorkflowNotification(unit);
  const workflowRunId = unit.header?.originMeta?.workId;
  // 打开 run 详情：宿主注入 onOpenWorkflowRun + 联查到 toolCallId 才可点；冷恢复查不到时
  // 展开体内不渲染链接。toolCallId 走投影/journal 联查表，与 CreateWorkflow 工具卡同一条打开路径。
  const workflowRunSummary =
    workflowNotification && workflowRunId
      ? context.workflowRunByRunId?.get(workflowRunId)
      : undefined;
  const openWorkflowRun =
    workflowNotification &&
    workflowRunId &&
    context.onOpenWorkflowRun &&
    context.sessionId &&
    workflowRunSummary?.toolCallId
      ? () =>
          context.onOpenWorkflowRun?.({
            parentSessionId: context.sessionId!,
            toolCallId: workflowRunSummary.toolCallId!,
            runId: workflowRunId,
            workflowName: title,
          })
      : undefined;
  const workflowPendingQids =
    workflowNotification && workflowRunId
      ? context.workflowRunPendingQuestionsByRunId?.get(workflowRunId)
      : undefined;
  // 产物 chip → 全尺寸查看 tab。门比 `openWorkflowRun` 松一格：产物 tab 只需要
  // (parentSessionId, runId, artifactId)，**不需要** toolCallId——它不画因果图，也就不必
  // 回到那条 CreateWorkflow 工具行。冷恢复后联查不到 toolCallId 的通知行因此仍能开产物。
  const openWorkflowArtifact =
    workflowNotification && workflowRunId && context.onOpenWorkflowArtifact && context.sessionId
      ? (artifactId: string) => {
          // 载荷里那一枚的 `contentType`（终态通知才有产物清单）：宿主据它决定 html 产物
          // 直接开浏览器 tab 还是开产物 tab，所以这里带得到就带上。载荷刻意不带 `sourcePath`
          // （状态帧体积），宿主缺席时自己查 journal 补。
          const contentType =
            workflowNotification.kind === "terminal"
              ? workflowNotification.artifacts?.find((candidate) => candidate.id === artifactId)
                  ?.contentType
              : undefined;
          context.onOpenWorkflowArtifact?.({
            parentSessionId: context.sessionId!,
            runId: workflowRunId,
            artifactId,
            ...(contentType === undefined ? {} : { contentType }),
          });
        }
      : undefined;

  return (
    <Collapsible
      open={open}
      onOpenChange={hasHistory ? setHistoryOpen : undefined}
      // 与普通工作段一致，历史间距进入动画层，避免收起末帧才删除 flex gap。
      className="history-message flex flex-col [&>*+*:not([data-slot='collapsible-content'])]:mt-5 [&>[data-zcode-chat-loading-slot]:not(:first-child)]:mt-3"
    >
      {!unit.isRunning && unit.workStatus ? (
        <AssistantHistoryStatus
          segment={historySegment}
          collapsible={hasHistory}
          open={open}
          highspeed={false}
          sourceCommandIds={unit.header?.sourceCommandId ? [unit.header.sourceCommandId] : []}
        />
      ) : null}
      {workflowNotification ? (
        <WorkflowNotificationToolRow
          notification={workflowNotification}
          runName={title}
          testIdKey={unit.key}
          theme={context.theme}
          onOpenRun={openWorkflowRun}
          onOpenArtifact={openWorkflowArtifact}
          pendingQids={workflowPendingQids}
          // 留白行的三态（docs/dynamic-workflow/transcript-and-notifications.md「The hole row's live state」）：
          // run 在活投影里就递它的留白表（可能为空 = 已补全 / 没记录），不在场即 undefined → 中性词。
          holes={
            workflowRunSummary?.run === undefined ? undefined : (workflowRunSummary.run.holes ?? [])
          }
        />
      ) : (
        <div className="flex w-full">
          <div
            data-testid={testId(TID_CHAT_BACKGROUND_RESULT_TITLE, unit.key)}
            className="min-w-0 whitespace-pre-wrap break-words text-left text-ui-base text-[var(--color-foreground-subtle)]"
          >
            {title}
          </div>
        </div>
      )}
      <ConversationAssistantWorkContent
        items={historyItems}
        context={context}
        assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        historyContainer={{ chunkKey: unit.key, open }}
      />
      {latestAssistantTextRow ? (
        <ConversationTurnRow
          key={`${latestAssistantTextRow.rowId}:${latestAssistantTextRow.entityId ?? ""}`}
          row={latestAssistantTextRow}
          context={context}
          onFork={latestAssistantTextRow.actions?.canFork === true ? onFork : undefined}
          onRetry={latestAssistantTextRow.actions?.canRetry === true ? onRetry : undefined}
          deferAssistantActions
          assistantCopyText={assistantCopyText}
          assistantPreviewCards={assistantPreviewCards}
          assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      ) : null}
      {hasFollowing ? (
        <ConversationAssistantWorkItems
          rows={unit.assistantFollowingRows}
          context={context}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      ) : null}
      <TurnChatLoadingSlot
        apiRetry={apiRetry}
        eligible={showLoading}
        initialElapsedMs={unit.workStatus?.durationMs ?? 0}
      />
    </Collapsible>
  );
}

function ConversationTurnGroupImpl({
  unit,
  nowMs = Date.now(),
  apiRetry = null,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  topClearedByTimeline = false,
}: ConversationTurnGroupProps) {
  const isOfficeMode = useIsOfficeMode();
  const { intl } = useZCodeIntl();
  const visibleUserRows = useMemo(() => unit.visibleUserInputs, [unit.visibleUserInputs]);
  const sourceCommandId = unit.header?.sourceCommandId ?? visibleUserRows[0]?.sourceCommandId;
  const selectHighspeed = useShallow(getHighspeedTurnDependencies);
  const highspeedState = useSyncExternalStore(
    subscribeHighspeedTurns,
    () => selectHighspeed(sourceCommandId),
    () => selectHighspeed(sourceCommandId),
  );
  const highspeedTurn = getHighspeedTurnByCommandId(sourceCommandId);
  // Bug 根因：历史标识过去只依赖 Renderer 内存；卡过期或冷恢复后记录不可用，
  // 即使 transcript 已持久化 highspeed metadata，也会把 accelerated output 渲染成普通工时。
  const isHighspeed = highspeedTurn !== null || visibleUserRows.some((row) => row.highspeed);
  const highspeedExpiresAt = Math.max(
    highspeedTurn?.card.expiresAt ?? Number.NEGATIVE_INFINITY,
    ...visibleUserRows.flatMap((row) => (row.highspeed ? [row.highspeed.expiresAt] : [])),
  );
  // Bug 根因：紫色流光过去只看“本轮曾使用 Highspeed”，卡过期后 metadata 仍会保留，
  // 导致 fallback 阶段仍在执行的 Tool 被永久染成紫色。运行态样式必须同时服从卡片有效期。
  const showHighspeedAnimatedGradient = isHighspeed && unit.isRunning && highspeedExpiresAt > nowMs;
  // 完成态统计即使因 replayable 事件先到，也必须等整轮停止生成后才能进入 UI。
  const highspeedMeta = unit.isRunning
    ? undefined
    : visibleUserRows.find((row) => row.highspeed)?.highspeed;
  const highspeedShareTarget = useMemo(() => {
    let target: { cardId: string; metrics: HighspeedShareMetrics } | null = null;
    if (
      highspeedTurn?.metrics &&
      highspeedTurn.metricsPersistedAt !== undefined &&
      highspeedTurn.metrics.regularTps > 0 &&
      highspeedTurn.metrics.highspeedTps !== undefined &&
      highspeedTurn.metrics.highspeedTps > 0
    ) {
      target = {
        cardId: highspeedTurn.card.cardId,
        metrics: aggregateHighspeedCardMetrics(highspeedTurn.card.cardId),
      };
    } else if (unit.highspeedOutputFooterTarget) {
      target = unit.highspeedOutputFooterTarget;
    } else if (
      highspeedMeta?.outputTokens !== undefined &&
      highspeedMeta.outputTokens > 0 &&
      highspeedMeta.highspeedTps !== undefined &&
      highspeedMeta.highspeedTps > 0 &&
      highspeedMeta.regularTps !== undefined &&
      highspeedMeta.regularTps > 0
    ) {
      // Bug 原因：冷恢复后 Renderer 内存记录为空，但 transcript 已持久化完整分享统计；
      // 只依赖 highspeedTurn 会让可见的历史分享按钮永久 disabled。
      target = {
        cardId: highspeedMeta.cardId,
        metrics: {
          outputTokens: highspeedMeta.outputTokens,
          // 分享接口不要求 durationMs；缺失时仅让本地耗时降级为 0，不阻塞分享。
          durationMs: highspeedMeta.durationMs ?? 0,
          regularTps: highspeedMeta.regularTps,
          highspeedTps: highspeedMeta.highspeedTps,
          ...(highspeedMeta.savedDurationMs !== undefined
            ? { savedDurationMs: highspeedMeta.savedDurationMs }
            : {}),
        },
      };
    }
    // 卡片和历史标识继续保留，但不超过 1.2x 或缺少完整耗时数据时不提供分享入口。
    return target && isHighspeedShareEligible(target.metrics) ? target : null;
  }, [highspeedMeta, highspeedTurn, highspeedState, unit.highspeedOutputFooterTarget]);
  const [highspeedShareDialogOpen, setHighspeedShareDialogOpen] = useState(false);
  const firstReasoningRowId = useMemo(
    () => unit.assistantWorkRows.find((row) => row.kind === "reasoning")?.rowId,
    [unit.assistantWorkRows],
  );
  const assistantRowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      ...context,
      ...(firstReasoningRowId !== undefined
        ? { messageStreamFirstReasoningRowId: firstReasoningRowId }
        : {}),
    }),
    [context, firstReasoningRowId],
  );
  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const assistantPreviewPptxAutoOpenTarget = context.assistantPreviewPptxAutoOpenTarget;
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const assistantCodeCommentProjectionEnabled =
    codeCommentCardsEnabled &&
    (unit.isRunning ||
      latestAssistantTextRow?.state === "complete" ||
      latestAssistantTextRow?.state === "interrupted");
  // 性能：copyText 的消费方全部卡在终态——行内 actions 要求 row.state === "complete"
  // （ConversationRowView），轮尾 actions 走 canRenderAssistantActions 同样要求 complete。
  // 流式期间算出来没有任何人读，但 resolveAssistantCopyText 要合并整轮文本，
  // 后面的 projectAssistantCodeComments 还要再扫一遍全文，每 30ms 白跑一轮。
  // 判据用 latestAssistantTextRow.state 而不是 unit.isRunning：回合可能还在跑
  // （模型说完一段正在调工具），但最新文本行已经终态，那时 copyText 仍须可用。
  const assistantTextTerminal =
    latestAssistantTextRow?.state === "complete" ||
    latestAssistantTextRow?.state === "interrupted";
  const assistantRawCopyText = useMemo(
    () => (assistantTextTerminal ? resolveAssistantCopyText(unit) : undefined),
    [
      assistantTextTerminal,
      unit.assistantTextRows,
      unit.assistantWorkRows,
      unit.latestAssistantTextRow,
    ],
  );
  const assistantFileSummaryText = useMemo(
    () => unit.assistantTextRows.map((row) => row.text).join("\n\n"),
    [unit.assistantTextRows],
  );
  const assistantCopyText = useMemo(
    () =>
      assistantCodeCommentProjectionEnabled && assistantRawCopyText !== undefined
        ? projectAssistantCodeComments(assistantRawCopyText, {
            streaming: unit.isRunning,
          }).visibleText
        : assistantRawCopyText,
    [assistantRawCopyText, assistantCodeCommentProjectionEnabled, unit.isRunning],
  );
  const assistantCodeCommentCards = useMemo(
    () =>
      codeCommentCardsEnabled &&
      assistantRawCopyText !== undefined &&
      // 卡片与 zcode-file-citation 的预览卡片保持一致：流式期间只投影正文，
      // 只有终态 row 才生成卡片，避免运行中卡片先出现又因模型续写而回滚。
      (latestAssistantTextRow?.state === "complete" ||
        latestAssistantTextRow?.state === "interrupted")
        ? buildAssistantCodeCommentCards(assistantRawCopyText, context.workspacePath, 50, {
            homePath: context.workspaceHomePath,
          })
        : [],
    [
      assistantRawCopyText,
      codeCommentCardsEnabled,
      context.workspaceHomePath,
      context.workspacePath,
      latestAssistantTextRow?.state,
    ],
  );
  const cronAutomationTurnCards = useMemo(
    () => (unit.isRunning ? [] : resolveCronAutomationTurnCards(unit.assistantWorkRows)),
    [unit.assistantWorkRows, unit.isRunning],
  );
  // 上方已是工具摘要；下方运行卡在联接到 run 后立即显示，不能再等主代理回复结束。
  // 依赖联接表保持实时更新，并由解析器按 runId 去重。直接启动轮
  // 的 run 卡也从这里出：那一轮没有用户气泡、没有助手内容，run 卡就是它的全部呈现。
  const workflowRunByToolCallId = context.workflowRunByToolCallId;
  const workflowRunByRunId = context.workflowRunByRunId;
  const workflowGraphByToolCallId = context.workflowGraphByToolCallId;
  const workflowFillGraphByRunId = context.workflowFillGraphByRunId;
  const workflowTurnDigests = useMemo(
    () =>
      resolveWorkflowTurnDigests(unit, {
        byToolCallId: workflowRunByToolCallId,
        byRunId: workflowRunByRunId,
        graphByToolCallId: workflowGraphByToolCallId,
        fillGraphByRunId: workflowFillGraphByRunId,
      }),
    [
      unit,
      workflowFillGraphByRunId,
      workflowGraphByToolCallId,
      workflowRunByRunId,
      workflowRunByToolCallId,
    ],
  );
  // 完成卡：主代理消化 completed 通知的那一轮，轮尾落卡。
  // 同一条门（轮结束）；联接只认 byRunId——通知轮里没有 CreateWorkflow 行可按 toolCallId 联。
  const workflowTurnCompletion = useMemo(
    () =>
      unit.isRunning
        ? undefined
        : resolveWorkflowTurnCompletion(unit.header, { byRunId: workflowRunByRunId }),
    [unit.header, unit.isRunning, workflowRunByRunId],
  );
  const offPeakTurnCards = useMemo(
    () => (unit.isRunning ? [] : resolveOffPeakTurnCards(unit.assistantWorkRows)),
    [unit.assistantWorkRows, unit.isRunning],
  );
  const canRenderAssistantActions =
    !unit.timelineOnly &&
    latestAssistantTextRow?.state === "complete" &&
    assistantCopyText !== undefined;
  // runtime turnId 与产品轮次 ID 不同；用 CLI 行上的命令归因关联投递，包含被裁剪输入的 header。
  const deliverySourceCommandIds = [
    ...(unit.header?.sourceCommandId ? [unit.header.sourceCommandId] : []),
    ...unit.visibleUserInputs.flatMap((row) => (row.sourceCommandId ? [row.sourceCommandId] : [])),
  ];
  const hasHookActions =
    // Hook action 与 copy/feedback/fork 共用 turn eligibility；
    // timelineOnly 维护 turn（compact/modelChange marker 轮）即使带历史遗留的
    // didExecute=true Hook row 也不得露出图标，否则 /compact 轮会凭 SessionStart
    // Hook 误挂出一个不可解释的操作栏。
    !unit.timelineOnly &&
    !unit.isRunning &&
    unit.hookInvocations.some((row) => row.executions.some((execution) => execution.didExecute));
  const canRetryLatestAssistant = latestAssistantTextRow?.actions?.canRetry === true;
  const canForkLatestAssistant = latestAssistantTextRow?.actions?.canFork === true;
  const backgroundResultTitle = resolveBackgroundResultTitle(unit);
  const showHighspeedOutputFooter =
    unit.showHighspeedOutputFooter === true && isHighspeed && !unit.timelineOnly && !unit.isRunning;
  const hasAssistantWorkContent = unit.timelineOnly
    ? unit.assistantWorkRows.length > 0
    : unit.assistantWorkRows.length > 0 ||
      unit.workSegments?.some((segment) => segment.workStatus?.state === "running") === true ||
      unit.workStatus?.state === "running";
  const hasAssistantTurnContent =
    hasAssistantWorkContent ||
    Boolean(unit.header?.fileChanges) ||
    canRenderAssistantActions ||
    hasHookActions ||
    showHighspeedOutputFooter ||
    workflowTurnDigests.length > 0;
  const editWorkspaceRewindAvailability = useMemo<EditWorkspaceRewindAvailability>(() => {
    const fileChanges = unit.header?.fileChanges;
    if (!fileChanges || fileChanges.files <= 0) return { enabled: false, reason: "noFiles" };
    if (fileChanges.state === "reverted") return { enabled: false, reason: "reverted" };
    if (unit.isRunning) return { enabled: false, reason: "running" };
    // 行级 canRewindFiles 不含 session 锁；锁关闭时 pane 才下发文件撤销回调（SessionPane
    // workspaceFileRewindEnabled），编辑并撤销文件与文件摘要的撤销按钮共用这道门。
    if (unit.header?.actions?.canRewindFiles !== true || !context.applyFileRewind) {
      return { enabled: false, reason: "unavailable" };
    }
    return { enabled: true, reason: "available" };
  }, [
    context.applyFileRewind,
    unit.header?.actions?.canRewindFiles,
    unit.header?.fileChanges,
    unit.isRunning,
  ]);

  // workflow 通知卡开头的轮去掉轮顶 padding：卡片只贴上一轮 pb-5 的常规流内间距。
  const startsWithWorkflowNotificationCard =
    backgroundResultTitle !== undefined && resolveWorkflowNotification(unit) !== undefined;
  // 同一条规则的另外两个来源：中枢直接启动轮与「配置」的设置轮（docs/dynamic-workflow/presentation.md
  // 「The run card」）。它们的用户行是写给模型的规范句，conversationTurnRenderUnits 会裁掉，
  // 卡 / 「已调整设置」那一行于是成了轮内第一个节点。
  //
  // Bug 根因：`pt-14` 是给用户气泡留的呼吸，判据却一直是「有没有轮」而不是「有没有气泡」；
  // 没有气泡时这 56px 叠上一轮的 pb-5，在行上方堆出约 76px 空白（设置轮总落在对话中段，最显眼）。
  const startsWithoutUserBubble =
    startsWithWorkflowNotificationCard || unit.workflowLaunch !== undefined;

  // 性能：context 变更会绕过下游所有 memo bailout，所以 provider 的 value 必须保持引用稳定。
  // 之前这里是 inline 对象字面量，每个流式帧（桌面 30ms 一帧）都换新身份，
  // 导致当前轮内每个已完成的工具卡都跟着重渲染摘要行，而它们的 props 其实一个都没变。
  // tailRowId 是 rowId 原始值、taskRunning 是布尔，语义不变时 value 身份就不变。
  const summaryTailRowId = useMemo(
    () => getAssistantSummaryTailRowId(unit.renderRows, assistantRowContext),
    [unit.renderRows, assistantRowContext],
  );
  const summaryGroupBoundary = useMemo(
    () => ({ taskRunning: unit.isRunning, tailRowId: summaryTailRowId }),
    [unit.isRunning, summaryTailRowId],
  );

  return (
    <SummaryGroupBoundaryContext.Provider value={summaryGroupBoundary}>
      <section
        data-turn-id={unit.turnId}
        data-turn-key={unit.key}
        data-highspeed-gradient={showHighspeedAnimatedGradient ? "true" : undefined}
        className={cn(
          "relative mx-auto flex w-full flex-col gap-5 px-4 @md/conversation:px-6 pb-5",
          startsWithoutUserBubble || topClearedByTimeline ? "pt-0" : "pt-14",
          showHighspeedAnimatedGradient && "highspeed-animated-gradient-text",
        )}
      >
        {unit.leadingBoundaryRows.map((row) => (
          <ConversationTurnRow
            key={`${row.rowId}:${row.entityId ?? ""}`}
            row={row}
            context={context}
          />
        ))}
        {hasAssistantTurnContent ? (
          // deferAssistantActions 后工具栏被移到文件 summary 之后，
          // 之前 hover group 只包住工具栏自己，导致必须悬停到不可见按钮位置才出现。
          // 这里把 assistant work、summary 和工具栏放进同一轮 hover 容器，对齐旧版。
          <div className="group/assistant-turn flex w-full flex-col gap-5">
            {backgroundResultTitle ? (
              <>
                {visibleUserRows.map((row) => (
                  <ConversationTurnRow
                    key={`${row.rowId}:${row.entityId ?? ""}`}
                    row={row}
                    context={context}
                    onEdit={row.actions?.canEdit === true ? onEdit : undefined}
                    editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
                  />
                ))}
                <ConversationBackgroundResultWork
                  unit={unit}
                  apiRetry={apiRetry}
                  context={assistantRowContext}
                  onFork={canForkLatestAssistant ? onFork : undefined}
                  onRetry={onRetry}
                  title={backgroundResultTitle}
                  assistantCopyText={assistantCopyText}
                  assistantCodeCommentCards={assistantCodeCommentCards}
                  assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
                  assistantPreviewCardsAutoOpenKey={
                    assistantPreviewPptxAutoOpenTarget?.turnId === unit.turnId
                      ? assistantPreviewPptxAutoOpenTarget.key
                      : undefined
                  }
                />
              </>
            ) : (
              <ConversationTurnFlow
                unit={unit}
                apiRetry={apiRetry}
                context={assistantRowContext}
                onFork={canForkLatestAssistant ? onFork : undefined}
                onRetry={onRetry}
                onEdit={onEdit}
                editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
                assistantCopyText={assistantCopyText}
                assistantCodeCommentCards={assistantCodeCommentCards}
                assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
                highspeed={isHighspeed}
                highspeedMeta={highspeedMeta}
                assistantPreviewCardsAutoOpenKey={
                  assistantPreviewPptxAutoOpenTarget?.turnId === unit.turnId
                    ? assistantPreviewPptxAutoOpenTarget.key
                    : undefined
                }
              />
            )}
            {/* 完成卡：这一轮消化的那条 run 做了什么、花了多少，紧跟最后一段正文。 */}
            {workflowTurnCompletion === undefined ? null : (
              <ConversationWorkflowCompletion
                completion={workflowTurnCompletion}
                context={context}
                turnKey={unit.key}
              />
            )}
            {/* 轮尾摘要：这一轮留下在跑的 run，排在完成卡之后、其余轮尾块之前。 */}
            <ConversationWorkflowDigests
              context={context}
              digests={workflowTurnDigests}
              turnKey={unit.key}
            />
            {/* 修复原因：CronCreate/CronUpdate 工具本身仍按普通工具行展示；成功卡片属于整轮
              完成后的结果摘要，必须等回复结束再跟随最终 assistant 正文收尾。 */}
            <CronAutomationTurnCards cards={cronAutomationTurnCards} context={context} />
            <OffPeakTurnCards cards={offPeakTurnCards} context={context} />
            {!isOfficeMode && unit.header?.fileChanges ? (
              <ConversationFileSummaryPanel
                header={unit.header}
                context={context}
                assistantText={assistantFileSummaryText}
              />
            ) : null}
            {unit.browserTurnEndRows.length > 0 ? (
              // 自动截图表达轮次结束时页面最终状态；放在 assistant work 内会
              // 穿插到 Website 预览和 file diff 摘要之间。它应是操作栏之前的最后一个内容块。
              <ConversationAssistantWorkItems
                rows={unit.browserTurnEndRows}
                context={assistantRowContext}
                assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
              />
            ) : null}
            {canRenderAssistantActions && latestAssistantTextRow ? (
              // 文件 summary 是整轮完成后的聚合结果；轮尾工具栏如果跟着
              // assistant text 内联渲染，会插到 summary 前面，读起来像 summary 不是本轮收尾。
              <ConversationAssistantTextActions
                rowId={latestAssistantTextRow.rowId}
                entityId={latestAssistantTextRow.entityId}
                text={assistantCopyText}
                createdAt={latestAssistantTextRow.createdAt}
                compactForRemoteControl={context.compactForRemoteControl}
                feedback={readAssistantFeedback(latestAssistantTextRow)}
                sessionId={context.sessionId}
                onFork={canForkLatestAssistant ? onFork : undefined}
                onRetry={canRetryLatestAssistant ? onRetry : undefined}
                onFeedbackChange={onFeedbackChange}
                hookInvocations={unit.hookInvocations}
                turnId={unit.turnId}
                sourceCommandIds={deliverySourceCommandIds}
                className={cn(
                  "flex items-center gap-1",
                  context.compactForRemoteControl
                    ? "opacity-100"
                    : "opacity-0 transition-opacity group-hover/assistant-turn:opacity-100 focus-within:opacity-100 has-[[data-bot-group-delivery]]:opacity-100",
                )}
              />
            ) : (hasHookActions || !unit.isRunning) && !canRenderAssistantActions ? (
              // 冲突合并曾把此兜底接到 Highspeed 页脚的 else，导致普通回复重复入口，
              // Highspeed 无正文轮又丢失入口；它只与普通操作栏互斥，页脚独立渲染。
              <MessageActions
                className={cn(
                  context.compactForRemoteControl
                    ? "opacity-100"
                    : "opacity-0 transition-opacity group-hover/assistant-turn:opacity-100 focus-within:opacity-100 has-[[data-bot-group-delivery]]:opacity-100",
                )}
              >
                {hasHookActions ? (
                  <ConversationHookDetailsAction rows={unit.hookInvocations} turnId={unit.turnId} />
                ) : null}
                <ConnectedBotGroupDeliveryAction
                  turnId={unit.turnId}
                  sourceCommandIds={deliverySourceCommandIds}
                />
              </MessageActions>
            ) : null}
            {showHighspeedOutputFooter ? (
              <HighspeedOutputFooter
                generatedLabel={intl.formatMessage({ id: "chat.highspeed.generatedBy" })}
                shareLabel={intl.formatMessage({ id: "chat.highspeed.viewAction" })}
                shareAriaLabel={intl.formatMessage({ id: "chat.highspeed.share" })}
                shareEnabled={highspeedShareTarget !== null}
                sharePending={false}
                onShare={() => setHighspeedShareDialogOpen(true)}
              />
            ) : null}
            {highspeedShareTarget ? (
              <HighspeedShareDialog
                metrics={highspeedShareTarget.metrics}
                open={highspeedShareDialogOpen}
                onOpenChange={setHighspeedShareDialogOpen}
              />
            ) : null}
            {unit.assistantTailRows.length > 0 ? (
              // turnTailBoundary 之前虽然从工作历史中拆出，却仍在 flow 内渲染，
              // 使 CronCreate、文件 summary 与操作栏看起来落在 fork 分割线之后。boundary
              // 必须统一收在全部 turn-local 附属 UI 之后，才是真正的 logical turn 结尾。
              <ConversationAssistantWorkItems
                rows={unit.assistantTailRows}
                context={assistantRowContext}
                assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
              />
            ) : null}
          </div>
        ) : (
          <ConversationTurnFlow
            unit={unit}
            apiRetry={apiRetry}
            context={assistantRowContext}
            onEdit={onEdit}
            editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
            assistantCopyText={assistantCopyText}
            assistantCodeCommentCards={assistantCodeCommentCards}
            assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            highspeed={isHighspeed}
            highspeedMeta={highspeedMeta}
          />
        )}
        {unit.topicPreparations?.length ? (
          <BotTopicPreparation items={unit.topicPreparations} />
        ) : null}
      </section>
    </SummaryGroupBoundaryContext.Provider>
  );
}

export const ConversationTurnGroup = memo(ConversationTurnGroupImpl);
