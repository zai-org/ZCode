import { memo } from "react";
import { TID_NAV_PRIMARY_ITEM } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNavPrimarySlot } from "@/extension-slots/adapters/useNavPrimarySlot.js";
import { resolveExtensionIcon } from "@/extension-slots/components/extensionIcons.js";
import type { NavPrimarySlotProps } from "@/extension-slots/contract.js";

/** 未读数超过它时显示「99+」。 */
const NAV_BADGE_DISPLAY_MAX = 99;

/**
 * nav.primary 插槽：左侧主导航「插件市场」之后，一个插件一项（docs/plugins/extension-host.md §16.4）。
 * 样式与内置导航行相同（ghost、lg、整行宽），但没有选中态：点击在右侧面板打开，主视图仍是对话。
 * 扩展进程已停止时 view 条目带「已停止」与「重新加载」（悬停说明是「扩展已停止」），点击重新加载；
 * MCP App 条目不受影响。
 * 只在桌面本机 Host 提供扩展门面时有内容；Web 与手机远控不渲染。
 */
export const NavPrimarySlot = memo(function NavPrimarySlot(props: NavPrimarySlotProps) {
  const { intl } = useZCodeIntl();
  const model = useNavPrimarySlot(props);
  if (!model || model.items.length === 0) return null;
  // 导航行很窄：行内只放短标签「已停止」与「重新加载」，标题才放得下；完整的「扩展已停止」在悬停说明里。
  const stoppedTag = intl.formatMessage({ id: "extensions.nav.stopped" });
  const stoppedLabel = intl.formatMessage({ id: "extensions.launcher.stopped" });
  const reloadLabel = intl.formatMessage({ id: "extensions.launcher.reload" });
  return (
    <>
      {model.items.map((item) => {
        const Icon = resolveExtensionIcon(item.icon);
        const hint = item.hostStopped ? `${stoppedLabel} · ${reloadLabel}` : item.tooltip;
        // 未读标记（§18.1 H11）：数字用与「已停止」相同的小标签，"dot" 用任务列表的未读点。
        const badge = item.hostStopped ? undefined : item.badge;
        const badgeLabel =
          badge === undefined
            ? null
            : badge === "dot"
              ? intl.formatMessage({ id: "extensions.nav.badge.dot" })
              : intl.formatMessage({ id: "extensions.nav.badge.count" }, { count: badge });
        const accessibleName = item.hostStopped
          ? `${item.label} · ${hint}`
          : badgeLabel
            ? `${item.label} · ${badgeLabel}`
            : item.label;
        const button = (
          <Button
            key={item.itemId}
            type="button"
            variant="ghost"
            size="lg"
            className="w-full justify-start gap-2"
            data-testid={TID_NAV_PRIMARY_ITEM}
            data-extension-item={item.itemId}
            data-extension-target={item.target.kind}
            data-extension-host-stopped={item.hostStopped ? "true" : "false"}
            data-extension-badge={badge === undefined ? "" : String(badge)}
            aria-label={accessibleName}
            onClick={() => model.open(item)}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
            {badge === "dot" ? (
              <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-icon-blue" />
            ) : badge !== undefined ? (
              <span
                aria-hidden
                className="inline-flex h-4 shrink-0 items-center rounded-sm bg-tag px-1 text-ui-xs font-medium tabular-nums"
              >
                {badge > NAV_BADGE_DISPLAY_MAX ? `${NAV_BADGE_DISPLAY_MAX}+` : badge}
              </span>
            ) : null}
            {item.hostStopped ? (
              <>
                <span className="inline-flex h-4 shrink-0 items-center rounded-sm bg-tag px-1 text-ui-xs font-medium">
                  {stoppedTag}
                </span>
                <span className="shrink-0 text-ui-sm text-foreground-subtle">{reloadLabel}</span>
              </>
            ) : null}
          </Button>
        );
        return hint ? (
          <ControlHintTooltip key={item.itemId} title={hint} side="right">
            {button}
          </ControlHintTooltip>
        ) : (
          button
        );
      })}
    </>
  );
});
