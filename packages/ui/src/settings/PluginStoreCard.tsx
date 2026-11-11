import {
  Crown,
  Download,
  LoaderCircle,
  MoreHorizontal,
  Power,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import {
  canUpdatePluginItem,
  isItemBusy,
  isStoreItemInstallBlocked,
  isUiPluginItem,
  resolveItemDescription,
  resolveItemDisplayName,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

/** 商店条目的通用动作集：列表卡片、详情页共用同一套回调与进行中态判定。 */
export interface PluginStoreActions {
  onOpenDetail: (pluginId: string) => void;
  onOpenUi?: (item: StorePluginItem) => void;
  /** 安装或恢复（restorable 内置插件走 restoreBuiltin，其余走 install）。 */
  onInstall: (item: StorePluginItem) => void;
  onUninstall: (pluginId: string) => void;
  onSetEnabled?: (pluginId: string, enabled: boolean) => void;
  /** 删除当前 Workspace scope 的显式配置，使其回退到 User。 */
  onResetConfig?: (pluginId: string) => void;
  onUpdate: (pluginId: string) => void;
  activeOperations: ReadonlyArray<{ id: string }>;
  togglingPluginId: string | null;
}

/**
 * 付费套餐提示：目录条目声明 `listing.requiresPaidPlan` 时，在标题右侧展示渐变徽标。
 * 表达的是「需要付费套餐才好用」这个使用条件，不是「插件是收费商品」——不做安装门禁。
 * 商店卡片与详情页标题共用同一渐变徽标。
 * 徽标使用短文案，完整条件由 Tooltip 和 aria-label 表达；缺字段时整个标记不渲染。
 * hover 提示走 ControlHintTooltip（Root Provider 的 delayDuration=0，即时弹出），
 * 不用原生 title——后者有约 1s 系统延迟。
 */
export function PluginStorePaidPlanBadge({
  item,
}: {
  item: Pick<StorePluginItem, "id" | "listing">;
}) {
  const { intl } = useZCodeIntl();
  if (!item.listing?.requiresPaidPlan) return null;
  const label = intl.formatMessage({ id: "settings.plugins.store.requiresPaidPlan" });
  const badgeLabel = intl.formatMessage({ id: "settings.plugins.store.paidPlanBadge" });
  return (
    <ControlHintTooltip title={label}>
      <span
        data-testid="plugin-store-paid-plan-badge"
        data-plugin-id={item.id}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-plugin-paid-plan-badge)] px-1.5 py-0.5 text-ui-sm leading-none whitespace-nowrap text-[var(--color-plugin-paid-plan-badge-foreground)]"
        aria-label={label}
      >
        <Crown className="size-3" aria-hidden="true" />
        {badgeLabel}
      </span>
    </ControlHintTooltip>
  );
}

/** 已安装条目的「…」菜单：启用/禁用、更新（有更新时）、卸载。卡片与详情页共用。 */
export function PluginStoreItemMenu({
  item,
  actions,
  triggerClassName,
  triggerVariant = "ghost",
  triggerSize = "icon-md",
  showEnabledAction = true,
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  triggerClassName?: string;
  triggerVariant?: "ghost" | "outline";
  triggerSize?: "icon-md" | "icon-lg";
  showEnabledAction?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const enabled = item.info?.enabled ?? false;
  const busy = isItemBusy(item, actions);
  const canToggleEnabled = showEnabledAction && Boolean(item.info && actions.onSetEnabled);
  // 分隔线不应跟随 item.installed 无条件渲染；启停/更新/恢复配置都不出现时，
  // 菜单只剩「卸载」一项，上方却留下一条孤立横线。分隔线只在卸载前确有其他操作项时才有意义。
  const hasActionsBeforeUninstall = canToggleEnabled;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/**
         * 原实现重复声明 data-testid，导致 TSX 编译报错 TS17001，
         * 仅保留一个测试 id 即可。
         */}
        <Button
          type="button"
          data-testid="plugin-store-item-menu"
          data-plugin-id={item.id}
          variant={triggerVariant}
          size={triggerSize}
          className={triggerClassName}
          aria-label={intl.formatMessage({ id: "settings.plugins.store.menu.label" })}
          onClick={(event) => event.stopPropagation()}
        >
          {busy ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <MoreHorizontal className="size-4" aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {canToggleEnabled ? (
          <DropdownMenuItem
            data-testid="plugin-store-menu-enabled"
            data-plugin-id={item.id}
            disabled={busy}
            onSelect={() => actions.onSetEnabled?.(item.id, !enabled)}
          >
            <Power className="size-4" aria-hidden="true" />
            {enabled
              ? intl.formatMessage({ id: "settings.plugins.store.menu.disable" })
              : intl.formatMessage({ id: "settings.plugins.store.menu.enable" })}
          </DropdownMenuItem>
        ) : null}
        {item.installed ? (
          <>
            {hasActionsBeforeUninstall ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              data-testid="plugin-store-menu-uninstall"
              data-plugin-id={item.id}
              variant="destructive"
              disabled={busy}
              onSelect={() => actions.onUninstall(item.id)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.detail.uninstall" })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 安装/恢复胶囊按钮（未安装条目的卡片与详情页主按钮共用）。 */
export function PluginStoreInstallButton({
  item,
  actions,
  size = "sm",
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  size?: "sm" | "default" | "lg";
}) {
  const { intl } = useZCodeIntl();
  // 目录最新版要求更高的插件 API 版本（plugin-publishing.md §4.3）：同一位置换成不能点的提示按钮。
  if (isStoreItemInstallBlocked(item)) {
    return (
      <Button
        type="button"
        data-testid="plugin-store-install"
        data-plugin-id={item.id}
        data-install-blocked="requires-update"
        variant="secondary"
        size={size}
        className="rounded-full"
        disabled
      >
        {intl.formatMessage({ id: "settings.plugins.store.extension.requiresUpdate" })}
      </Button>
    );
  }
  const installing =
    actions.activeOperations.some(
      (operation) => operation.id === `plugin:install:${item.name}@${item.marketplace}`,
    ) || actions.activeOperations.some((operation) => operation.id === `plugin:restore:${item.id}`);
  return (
    <Button
      type="button"
      data-testid="plugin-store-install"
      data-plugin-id={item.id}
      variant="secondary"
      size={size}
      className="rounded-full"
      disabled={installing}
      onClick={(event) => {
        event.stopPropagation();
        runUserAction({
          input: { featureId: "extension.plugin", action: "install", trigger: "button" },
          operation: () => actions.onInstall(item),
          completed: { resultSource: "optimistic_projection" },
          failureStage: "plugin_install",
        });
      }}
    >
      {installing ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
      {installing
        ? intl.formatMessage({ id: "settings.plugins.marketplace.installing" })
        : intl.formatMessage({ id: "settings.plugins.store.install" })}
    </Button>
  );
}

/** 已安装条目的「可更新」角标：列表/卡片标题行直接标出哪个插件有更新，与详情页入口共用判定。 */
export function PluginStoreUpdateBadge({
  item,
}: {
  item: Pick<StorePluginItem, "id" | "installedMeta" | "orphaned"> | null | undefined;
}) {
  const { intl } = useZCodeIntl();
  if (!canUpdatePluginItem(item)) return null;
  const label = intl.formatMessage({ id: "settings.plugins.list.updateAvailable" });
  return (
    <span
      data-testid="plugin-store-update-badge"
      data-plugin-id={item?.id}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-surface px-1.5 py-0.5 text-ui-sm leading-none whitespace-nowrap text-success-surface-foreground"
      aria-label={label}
    >
      <Download className="size-3" aria-hidden="true" />
      {label}
    </span>
  );
}

/** 行内「更新」胶囊：已安装且可更新的条目原地触发更新，不必进详情页。 */
export function PluginStoreUpdateButton({
  item,
  actions,
  size = "sm",
}: {
  item: StorePluginItem | null | undefined;
  actions: PluginStoreActions;
  size?: "sm" | "default" | "lg";
}) {
  const { intl } = useZCodeIntl();
  if (!item || !canUpdatePluginItem(item)) return null;
  const updating = actions.activeOperations.some(
    (operation) => operation.id === `plugin:update:${item.id}`,
  );
  return (
    <Button
      type="button"
      data-testid="plugin-store-card-update"
      data-plugin-id={item.id}
      variant="secondary"
      size={size}
      className="rounded-full"
      // 与安装按钮一致按插件判定：A 安装中时 B 仍可提交更新，后端按提交顺序串行执行。
      disabled={isItemBusy(item, actions)}
      onClick={(event) => {
        event.stopPropagation();
        actions.onUpdate(item.id);
      }}
    >
      {updating ? (
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="size-3.5" aria-hidden="true" />
      )}
      {intl.formatMessage({ id: "settings.plugins.detail.update" })}
    </Button>
  );
}

/** 已安装分组头部「全部更新（N）」：仅在存在可更新插件时出现，口径与行内更新按钮一致。 */
export function PluginUpdateAllButton({
  items,
  actions,
  pending,
  onUpdateAll,
}: {
  items: readonly StorePluginItem[];
  actions: PluginStoreActions;
  pending: boolean;
  onUpdateAll: (pluginIds: string[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const pluginIds = items.filter(canUpdatePluginItem).map((item) => item.id);
  if (pluginIds.length === 0) return null;
  const updating =
    pending ||
    actions.activeOperations.some((operation) => operation.id.startsWith("plugin:update:"));
  return (
    <Button
      type="button"
      data-testid="plugin-settings-update-all"
      variant="outline"
      disabled={updating}
      onClick={() => onUpdateAll(pluginIds)}
    >
      {updating ? (
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="size-3.5" aria-hidden="true" />
      )}
      {intl.formatMessage(
        { id: "settings.plugins.updateAll" },
        { count: String(pluginIds.length) },
      )}
    </Button>
  );
}

/**
 * 商店卡片（双列网格单元）：40px 头像 + 标题/标签 + 单行截断描述；
 * 尾部动作：已安装 → 常驻开关与悬停卸载菜单，未安装 → 安装。点击主体进入详情页。
 */
export function PluginStoreCard({
  item,
  actions,
  locale,
  management = false,
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  locale: string;
  management?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const displayName = resolveItemDisplayName(item, locale);
  const description = resolveItemDescription(item, locale);
  // 卡片整行统一进入详情；打开 UI 只走会话右侧市场提供的「打开」按钮。
  const open = () => actions.onOpenDetail(item.id);
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="plugin-store-card"
      data-plugin-id={item.id}
      className="group/card flex min-w-0 cursor-pointer items-center gap-3 rounded-xl px-2 py-3 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      onClick={open}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      <PluginStoreAvatar item={item} className="size-10" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-base font-medium leading-5 text-foreground">
            {displayName}
          </span>
          <PluginStorePaidPlanBadge item={item} />
          <PluginStoreUpdateBadge item={item} />
        </div>
        {item.orphaned ? (
          <div
            data-testid="plugin-store-source-degraded"
            data-plugin-id={item.id}
            className="mt-0.5 flex items-center gap-1 truncate text-ui-sm text-warning"
          >
            <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {intl.formatMessage({ id: "settings.plugins.store.sourceMissing" })}
            </span>
          </div>
        ) : null}
        <div className="mt-0.5 min-h-5 truncate text-ui-caption leading-5 text-foreground-subtle">
          {description}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {item.installed ? (
          <>
            <PluginStoreOpenUiButton item={item} actions={actions} size="default" />
            <PluginStoreUpdateButton item={item} actions={actions} size="default" />
            {item.info?.packageStatus !== "missing" ? (
              <PluginStoreItemMenu
                item={item}
                actions={actions}
                showEnabledAction={false}
                triggerClassName="text-foreground-subtle opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
              />
            ) : null}
            {/* 启停中的加载提示只由「…」菜单按钮承担（isItemBusy 含 togglingPluginId）。
                这里曾另放一个独立 LoaderCircle，点开关时卡片处于 hover/focus-within，菜单按钮显形，
                同一状态并排出现两个 spinner。开关自身保留 disabled + aria-busy。 */}
            {item.info && actions.onSetEnabled ? (
              <Switch
                className="after:-inset-x-2"
                data-testid={
                  management ? "plugin-settings-enabled-switch" : "plugin-store-enabled-switch"
                }
                data-plugin-id={item.id}
                checked={item.info.enabled}
                disabled={isItemBusy(item, actions)}
                aria-busy={actions.togglingPluginId === item.id}
                aria-label={intl.formatMessage(
                  {
                    id: item.info.enabled
                      ? "settings.plugins.toggle.disable"
                      : "settings.plugins.toggle.enable",
                  },
                  { plugin: displayName },
                )}
                onClick={(event) => event.stopPropagation()}
                onCheckedChange={(enabled) => actions.onSetEnabled?.(item.id, enabled)}
              />
            ) : null}
          </>
        ) : (
          <PluginStoreInstallButton item={item} actions={actions} size="default" />
        )}
      </div>
    </div>
  );
}

export function PluginStoreOpenUiButton({
  item,
  actions,
  size = "sm",
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  size?: "sm" | "default" | "lg";
}) {
  const { intl } = useZCodeIntl();
  if (!item.installed || !isUiPluginItem(item) || !actions.onOpenUi) return null;
  return (
    <Button
      type="button"
      size={size}
      variant="secondary"
      data-testid="plugin-store-open-ui"
      data-plugin-id={item.id}
      disabled={isItemBusy(item, actions)}
      onClick={(event) => {
        event.stopPropagation();
        actions.onOpenUi?.(item);
      }}
    >
      {intl.formatMessage({
        id:
          (item.info?.enabled ?? item.installedMeta?.enabled)
            ? "settings.plugins.store.ui.open"
            : "settings.plugins.store.menu.enable",
      })}
    </Button>
  );
}
