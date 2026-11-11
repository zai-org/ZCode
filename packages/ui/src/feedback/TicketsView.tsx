import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CopyIcon, Inbox, LoaderCircle, PlusCircle, RefreshCcw } from "lucide-react";
import type { FeedbackTicketSummary } from "@zcode/shared";
import type { IFeedbackService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { FeedbackErrorTip, StatusIndicator } from "@/feedback/feedbackBadges.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { formatRelativeTime } from "@/feedback/feedbackUserView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

export function TicketsView({
  feedbackService,
  onCreateNew,
}: {
  feedbackService: IFeedbackService;
  onCreateNew: () => void;
}) {
  const selectedTicketId = useFeedbackStore((state) => state.selectedTicketId);
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  const copiedResetTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const [items, setItems] = useState<FeedbackTicketSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedTicketId, setCopiedTicketId] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const result = await feedbackService.list({ mine: true, limit: 50 });
      setItems(result.items);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoadingList(false);
    }
  }, [feedbackService]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current !== null) {
        globalThis.clearTimeout(copiedResetTimerRef.current);
      }
    };
  }, []);

  const handleCopyTicketId = useCallback(
    (ticketId: string) => {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        logger.warn(formatMessage({ id: "feedback.detail.issueCopyFailed" }), {
          issueId: ticketId,
          reason: "clipboard-unavailable",
        });
        return;
      }

      void navigator.clipboard.writeText(ticketId).then(
        () => {
          setCopiedTicketId(ticketId);
          if (copiedResetTimerRef.current !== null) {
            globalThis.clearTimeout(copiedResetTimerRef.current);
          }
          copiedResetTimerRef.current = globalThis.setTimeout(() => {
            setCopiedTicketId(null);
            copiedResetTimerRef.current = null;
          }, 1600);
        },
        (copyError: unknown) => {
          logger.warn(formatMessage({ id: "feedback.detail.issueCopyFailed" }), {
            issueId: ticketId,
            error: copyError instanceof Error ? copyError.message : String(copyError),
          });
        },
      );
    },
    [formatMessage],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-popover">
      {loadingList && items.length === 0 ? (
        <TicketsInitialLoadingState />
      ) : (
        <ScrollFadeViewport className="px-6 pb-4 pt-3">
          {error && items.length === 0 ? (
            <div className="pb-2">
              <FeedbackErrorTip message={error} />
            </div>
          ) : null}
          {!loadingList && items.length === 0 && !error ? (
            <EmptyState onCreateNew={onCreateNew} />
          ) : null}
          <FeedbackTicketList
            items={items}
            selectedTicketId={selectedTicketId}
            copiedTicketId={copiedTicketId}
            onCopyTicketId={handleCopyTicketId}
          />
          {loadingList && items.length > 0 ? (
            <div className="flex items-center justify-center py-2 text-ui-xs text-foreground-subtle">
              <LoaderCircle className="mr-1.5 size-3 animate-spin" />
              {formatMessage({ id: "common.loading" })}
            </div>
          ) : null}
        </ScrollFadeViewport>
      )}
      <div className="flex shrink-0 items-center justify-between gap-2 px-6 pb-6 pt-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          onClick={() => void loadList()}
          disabled={loadingList}
          aria-label={formatMessage({ id: "common.refresh" })}
          className="rounded-xl text-foreground-subtle hover:text-foreground"
        >
          {loadingList ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <RefreshCcw className="size-4" />
          )}
        </Button>
        <Button size="lg" onClick={onCreateNew} className="rounded-lg">
          <PlusCircle />
          {formatMessage({ id: "feedback.tickets.newFeedback" })}
        </Button>
      </div>
    </div>
  );
}

export function TicketsInitialLoadingState() {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center text-ui-base text-foreground-subtle">
      <LoaderCircle className="size-4 animate-spin text-primary" />
      <span>{intl.formatMessage({ id: "common.loading" })}</span>
    </div>
  );
}

export function FeedbackTicketList({
  items,
  selectedTicketId,
  copiedTicketId,
  onCopyTicketId,
}: {
  items: FeedbackTicketSummary[];
  selectedTicketId: string | null;
  copiedTicketId: string | null;
  onCopyTicketId: (ticketId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  if (items.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="hidden grid-cols-[7.5rem_minmax(0,1fr)_13rem] gap-3 border-b border-border px-3 py-2 text-ui-xs font-medium text-foreground-subtle md:grid">
        <span>{formatMessage({ id: "feedback.tickets.column.status" })}</span>
        <span>{formatMessage({ id: "feedback.tickets.column.description" })}</span>
        <span>{formatMessage({ id: "feedback.tickets.column.id" })}</span>
      </div>
      <ul className="divide-y divide-border">
        {items.map((item) => {
          const selected = selectedTicketId === item.id;
          const copied = copiedTicketId === item.id;
          const copyLabel = formatMessage({
            id: copied ? "feedback.detail.issueCopied" : "feedback.detail.issueCopy",
          });
          return (
            <li
              key={item.id}
              className={cn(
                "grid gap-2 px-3 py-2.5 md:grid-cols-[7.5rem_minmax(0,1fr)_13rem] md:items-center md:gap-3",
                selected ? "bg-card-selected" : "bg-card",
              )}
            >
              <div className="flex min-w-0 items-center justify-between gap-2 md:block">
                <StatusIndicator status={item.status} />
                <span className="shrink-0 text-ui-xs text-foreground-subtle md:hidden">
                  {formatRelativeTime(item.created_at, formatMessage)}
                </span>
              </div>
              <div className="min-w-0">
                <div className="line-clamp-2 text-ui-base leading-5 text-foreground md:truncate">
                  {item.title}
                </div>
                <div className="mt-1 hidden text-ui-xs text-foreground-subtle md:block">
                  {formatRelativeTime(item.created_at, formatMessage)}
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-ui-xs text-foreground-subtle md:hidden">
                  {formatMessage({ id: "feedback.tickets.issuePrefix" })}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-foreground">
                  {item.id}
                </span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={copyLabel}
                  title={copyLabel}
                  onClick={() => onCopyTicketId(item.id)}
                  className="shrink-0 text-foreground-subtle hover:text-foreground"
                >
                  {copied ? (
                    <Check className="size-3 text-success" />
                  ) : (
                    <CopyIcon className="size-3" />
                  )}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EmptyState({ onCreateNew }: { onCreateNew: () => void }) {
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 pt-12 text-center">
      <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-card">
        <Inbox className="size-4 text-foreground-subtle" />
      </div>
      <div className="text-ui-base font-medium text-foreground">
        {formatMessage({ id: "feedback.tickets.empty.title" })}
      </div>
      <p className="text-ui-base leading-5 text-foreground-subtle">
        {formatMessage({ id: "feedback.tickets.empty.description" })}
      </p>
      <Button size="sm" variant="outline" onClick={onCreateNew} className="mt-1 rounded-lg">
        <PlusCircle />
        {formatMessage({ id: "feedback.tickets.empty.action" })}
      </Button>
    </div>
  );
}
