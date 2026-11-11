import { conversationShareTtlChoices, type ConversationShareTtlOptions } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 有效期按整天优先展示，否则按小时；服务端默认值可能不在预设里，也要能读。 */
export function formatConversationShareTtl(
  intl: Pick<IntlInstance, "formatMessage">,
  ttlMs: number,
) {
  if (ttlMs % DAY_MS === 0) {
    const count = ttlMs / DAY_MS;
    return intl.formatMessage(
      { id: count === 1 ? "conversationShare.ttl.day" : "conversationShare.ttl.days" },
      { count },
    );
  }
  const count = Math.max(1, Math.round(ttlMs / HOUR_MS));
  return intl.formatMessage(
    { id: count === 1 ? "conversationShare.ttl.hour" : "conversationShare.ttl.hours" },
    { count },
  );
}

/**
 * 发布时实际提交的有效期：草稿值必须仍在当前服务端选项内才发送，否则交给服务端默认值。
 * 草稿可能沿用了切换账号或服务端改配置之前的值；选择器展示与发布都以此为准，避免显示与提交不一致。
 */
export function resolveConversationSharePublishTtlMs(
  ttlMs: number | null,
  options: ConversationShareTtlOptions | undefined,
): number | undefined {
  if (ttlMs === null || !options) return undefined;
  return conversationShareTtlChoices(options).includes(ttlMs) ? ttlMs : undefined;
}

export function ConversationShareExpiryPicker({
  options,
  ttlMs,
  onChange,
  disabled = false,
}: {
  options: ConversationShareTtlOptions;
  /** null 表示沿用服务端默认值。 */
  ttlMs: number | null;
  onChange: (ttlMs: number) => void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const choices = conversationShareTtlChoices(options);
  const selected = resolveConversationSharePublishTtlMs(ttlMs, options) ?? options.defaultMs;
  const label = intl.formatMessage({ id: "conversationShare.ttlLabel" });
  return (
    <div className="grid gap-1" data-testid="conversation-share-expiry-picker">
      <span className="text-ui-base text-foreground-subtle">{label}</span>
      <Select
        value={String(selected)}
        onValueChange={(value) => onChange(Number(value))}
        disabled={disabled}
      >
        <SelectTrigger size="lg" className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent data-conversation-share-keep-open="expiry">
          {choices.map((value) => (
            <SelectItem key={value} value={String(value)} data-conversation-share-ttl={value}>
              {formatConversationShareTtl(intl, value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
