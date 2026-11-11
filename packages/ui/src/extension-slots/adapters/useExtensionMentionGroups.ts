import { useMemo } from "react";
import { ZCODE_PLUGIN_MENTION_ERROR_CODES } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveLocalizedText } from "@/extension-slots/domain/slotSelectors.js";
import { useComposerMentionSlot } from "@/extension-slots/adapters/useComposerMentionSlot.js";
import type { ComposerMentionSlotProps } from "@/extension-slots/contract.js";
import type { MentionResultGroup } from "@/mentions/mentionSearch.js";
import type { MentionItem } from "@/mentions/mentionTypes.js";

/**
 * `@` 面板的插件分组（docs/plugins/extension-host.md §16.6），给 mentions/MentionPlugin 当一个候选来源：
 * 每个 composer.mention 条目一组，
 * 排在内置分组之后，总是显示组名。候选项由插件按 query 提供，这里不再过滤；
 * 选中后插入 extensions 类别的提及块，序列化为 insertText 原文（CLI 收到普通文本）。
 */
export function useExtensionMentionGroups(
  props: ComposerMentionSlotProps,
): MentionResultGroup<MentionItem>[] {
  const { intl, locale } = useZCodeIntl();
  const groups = useComposerMentionSlot(props);
  return useMemo(
    () =>
      groups.map((group) => {
        const seen = new Set<string>();
        return {
          id: `extension:${group.itemId}`,
          title: resolveLocalizedText(group.title, locale) || group.pluginName,
          showHeader: true,
          // 候选项 id 只在插件内有意义：同一组里重复的 id 只留第一项，面板按 id 定位行。
          items: group.items.flatMap((item): MentionItem[] => {
            if (seen.has(item.id)) return [];
            seen.add(item.id);
            return [
              {
                id: `ext:${group.itemId}:${item.id}`,
                category: "extensions",
                label: item.label,
                description: item.description ?? "",
                value: item.id,
                markdown: item.insertText,
                ...(item.icon ? { data: { icon: item.icon } } : {}),
              },
            ];
          }),
          loading: group.state === "loading",
          errorText: null,
          // 失败只在组内显示一行弱提示，不用错误行的红底（DESIGN.md「Extension slots」）。
          noticeText:
            group.state === "stopped"
              ? intl.formatMessage({ id: "extensions.launcher.stopped" })
              : group.state === "error"
                ? intl.formatMessage({
                    id:
                      group.errorCode === ZCODE_PLUGIN_MENTION_ERROR_CODES.toolDenied
                        ? "extensions.mention.denied"
                        : "extensions.mention.failed",
                  })
                : null,
          emptyText: "",
        };
      }),
    [groups, intl, locale],
  );
}
