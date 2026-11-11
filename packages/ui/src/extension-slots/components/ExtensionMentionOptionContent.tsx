import { resolveExtensionIcon } from "@/extension-slots/components/extensionIcons.js";
import type { MentionItem } from "@/mentions/mentionTypes.js";

/** 插件 composer.mention 候选行：白名单图标 + 标题 + 说明，与 skills 行同一密度（DESIGN.md「Extension slots」）。 */
export function ExtensionMentionOptionContent({ item }: { item: MentionItem }) {
  const Icon = resolveExtensionIcon(item.data?.icon);
  return (
    <span className="min-w-0 flex flex-1 items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-foreground" aria-hidden />
      <span className="min-w-0 max-w-1/2 shrink-0 truncate whitespace-nowrap text-ui-base font-medium text-foreground">
        {item.label}
      </span>
      <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
        {item.description}
      </span>
    </span>
  );
}
