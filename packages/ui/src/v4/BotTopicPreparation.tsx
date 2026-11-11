import { pendingTopicPreparations } from "@/v4/topicPreparationRenderUnits.js";
import { useContext, useMemo } from "react";
import { LoaderCircle } from "lucide-react";
import type { BotTopicPreparation as Preparation, FeishuBotProvider } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DeliveryContext } from "@/v4/botGroupDeliveryContext.js";
import { ConversationUserInputBubble } from "@/v4/ConversationUserInputBubble.js";

const EMPTY_ROWS: readonly ConversationRow[] = [];
const EMPTY_PREPARATIONS: readonly Preparation[] = [];

export function useBotTopicPreparations(): readonly Preparation[] {
  const value = useContext(DeliveryContext);
  if (!value?.context?.group?.threadId || value.context.activeTaskId !== value.taskId)
    return EMPTY_PREPARATIONS;
  return value.context.group.preparation ?? EMPTY_PREPARATIONS;
}

export function BotTopicPreparationList({
  items,
  acceptedRows = EMPTY_ROWS,
  provider,
}: {
  items: readonly Preparation[];
  acceptedRows?: readonly ConversationRow[];
  provider?: FeishuBotProvider;
}) {
  const { intl } = useZCodeIntl();
  const pending = useMemo(
    () => pendingTopicPreparations(items, acceptedRows),
    [items, acceptedRows],
  );
  if (!pending.length) return null;
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      {pending.map((item) => (
        <div
          key={item.messageId}
          data-topic-preparation={item.messageId}
          className="flex min-w-0 flex-col items-end"
        >
          <div
            data-topic-preparation-source="true"
            className="mb-2 flex min-w-0 max-w-full items-center gap-1.5 text-ui-sm text-foreground-subtle"
          >
            <span className="min-w-0 truncate" title={item.senderName}>
              {provider
                ? `${provider === "lark" ? "Lark" : intl.formatMessage({ id: "bots.group.provider.feishu" })} · `
                : ""}
              {item.senderName}
            </span>
            {item.status !== "failed" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    role="img"
                    aria-label={intl.formatMessage({ id: `chat.topicPreparation.${item.status}` })}
                    data-topic-preparation-loading="true"
                    className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm focus-visible:outline focus-visible:outline-ring"
                  >
                    <LoaderCircle
                      aria-hidden="true"
                      className="size-3 animate-spin motion-reduce:animate-none"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {intl.formatMessage({ id: `chat.topicPreparation.${item.status}` })}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <ConversationUserInputBubble
            text={item.text}
            contentParts={item.contentParts}
            rowId={item.messageId}
          />
        </div>
      ))}
    </div>
  );
}

export function BotTopicPreparation({ items }: { items: readonly Preparation[] }) {
  const value = useContext(DeliveryContext);
  if (!value?.context?.group?.threadId || value.context.activeTaskId !== value.taskId) return null;
  return <BotTopicPreparationList items={items} provider={value.provider} />;
}
