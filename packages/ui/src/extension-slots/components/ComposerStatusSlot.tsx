import { memo } from "react";
import { TID_EXTENSION_COMPOSER_STATUS } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveLocalizedText } from "@/extension-slots/domain/slotSelectors.js";
import { useComposerStatusSlot } from "@/extension-slots/adapters/useExtensionSlots.js";
import { resolveExtensionIcon } from "@/extension-slots/components/extensionIcons.js";
import type { ComposerStatusSlotProps, ExtensionSlotEntry } from "@/extension-slots/contract.js";

/**
 * composer.status 插槽：输入框工具栏、上下文用量圆环左边。
 * 只在桌面本机 Host 提供扩展门面时有内容；Web 与手机远控不渲染。
 */
function ComposerStatusSlotImpl(props: ComposerStatusSlotProps) {
  const model = useComposerStatusSlot(props);
  if (!model || model.items.length === 0) return null;
  return (
    <>
      {model.items.map((entry) => (
        <ComposerStatusItem key={entry.item.id} entry={entry} runCommand={model.runCommand} />
      ))}
    </>
  );
}

function ComposerStatusItem({
  entry,
  runCommand,
}: {
  entry: ExtensionSlotEntry;
  runCommand: (commandId: string) => void;
}) {
  const { locale } = useZCodeIntl();
  const { item, value } = entry;
  const Icon = resolveExtensionIcon(item.icon);
  const title = resolveLocalizedText(item.title, locale);
  const tooltip = value.tooltip || title || value.text || "";
  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="default"
        data-testid={TID_EXTENSION_COMPOSER_STATUS}
        data-extension-item={item.id}
        // 扩展条目在工具栏空间不足时最先收起（只留图标），见 composer-toolbar-layout/CONTRACT.md。
        data-composer-collapse-priority="extension"
        aria-label={tooltip}
        // composer.status 只接受 command target（EXTENSION_SLOTS）。
        onClick={item.target.kind === "command" ? () => runCommand(item.target.id) : undefined}
        className="group/ext h-7 w-fit max-w-40 shrink-0 justify-center gap-1 rounded-lg px-1.5 text-ui-sm text-foreground-subtle data-[composer-compact=true]:size-7 data-[composer-compact=true]:gap-0 data-[composer-compact=true]:p-0"
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate whitespace-nowrap tabular-nums group-data-[composer-compact=true]/ext:hidden">
          {value.text}
        </span>
      </Button>
    </ControlHintTooltip>
  );
}

export const ComposerStatusSlot = memo(ComposerStatusSlotImpl);
