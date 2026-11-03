import { documentViewerInstance } from "@/plugin-ui/contract.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { toast } from "@/components/ui/toast.js";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { useRecommendedUiPlugins } from "@/plugin-ui/adapters/useRecommendedUiPlugins.js";
import {
  resolveItemDisplayName,
  resolveItemDescription,
  resolvePluginStoreSegment,
} from "@/settings/pluginStoreListing.js";
import { useEffect, type ReactNode } from "react";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { PuzzleIcon, type LucideIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenPluginUiSideTabRequest } from "@/plugin-ui/contract.js";
import { resolvePluginUiSurfaceTitle } from "@/plugin-ui/adapters/usePluginUiSurfaces.js";

export interface PluginUiLauncherItemsProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 所属 pane 的有效 session，包含已就绪的草稿预热。 */
  sessionId: string | null;
  paneId?: string;
  onOpenPluginUi: (request: OpenPluginUiSideTabRequest) => void;
  /** 菜单复用标准菜单项；空白页与内置应用共用 SidePaneLauncherRow。 */
  variant?: "launcher" | "menu";
}

export function buildPluginUiLauncherItemId(pluginId: string, surfaceId: string): string {
  return `plugin-ui:${pluginId}/${surfaceId}`;
}

/**
 * "打开标签页"里的插件面板入口，与内建项共用列表/网格。
 * 旧分组容器会占据一个网格单元，导致插件全部挤在同一列；使用 Fragment 让按钮直接参与父级布局。
 */
export function PluginUiLauncherItems(props: PluginUiLauncherItemsProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const {
    entries,
    loading,
    prepare,
    resolveSurface,
    isBusy: isPluginBusy,
    error,
  } = useRecommendedUiPlugins(props);
  useEffect(() => {
    if (error) toast(error, { variant: "warning" });
  }, [error]);
  if (loading) {
    const label = intl.formatMessage({ id: "common.loading" });
    if (props.variant === "menu")
      return (
        <DropdownMenuItem disabled aria-label={label} data-testid="side-pane-ui-loading">
          <span
            aria-hidden="true"
            className="h-4 w-40 motion-safe:animate-pulse rounded bg-surface"
          />
        </DropdownMenuItem>
      );
    return (
      <div
        role="status"
        aria-label={label}
        data-testid="side-pane-ui-loading"
        className="col-span-full grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/launcher:grid-cols-2"
      >
        {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
          <div
            key={index}
            aria-hidden="true"
            className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 motion-safe:animate-pulse"
          >
            <span className="size-12 shrink-0 rounded-xl bg-surface" />
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block h-4 max-w-full rounded-sm bg-surface",
                  index % 2 === 0 ? "w-24" : "w-32",
                )}
              />
              <span className="mt-1.5 block h-3 w-36 max-w-full rounded-sm bg-surface" />
            </span>
            <span className="h-6 w-11 shrink-0 rounded-full bg-surface" />
          </div>
        ))}
      </div>
    );
  }
  if (props.sessionId === null || entries.length === 0)
    return props.variant === "menu" ? null : (
      <p className="text-ui-base text-foreground-subtle" data-testid="side-pane-ui-empty">
        {intl.formatMessage({ id: "sidePane.launcher.empty" })}
      </p>
    );
  const sessionId = props.sessionId;
  return (
    <>
      {entries.map(({ pluginId, surfaceId, item }) => {
        const surface = item.info?.uiSurfaces?.find((candidate) => candidate.id === surfaceId);
        const title = surface
          ? resolvePluginUiSurfaceTitle(surface.title, locale)
          : resolveItemDisplayName(item, locale);
        const itemId = buildPluginUiLauncherItemId(pluginId, surfaceId);
        // 原入口只替换加载文案，缺少持续可见的进度；图标与文案共用当前插件的忙碌态。
        const isBusy = isPluginBusy(item);
        const actionLabel = intl.formatMessage({
          id: isBusy
            ? "common.loading"
            : !item.installed
              ? "settings.plugins.store.install"
              : !item.info?.enabled
                ? "settings.plugins.store.menu.enable"
                : "settings.plugins.store.ui.open",
        });
        const open = async () => {
          if (!item.installed || !item.info?.enabled) {
            void prepare(item);
            return;
          }
          if (
            !platform?.pluginSandbox ||
            props.remoteSessionId ||
            isRemoteWorkspaceIdentity(props.workspaceIdentity ?? "")
          ) {
            toast(intl.formatMessage({ id: "settings.plugins.store.ui.unsupported" }));
            return;
          }
          const resolved = await resolveSurface(pluginId, surfaceId);
          if (resolved === undefined) return;
          if (!resolved) {
            toast(intl.formatMessage({ id: "settings.plugins.store.ui.unavailable" }));
            return;
          }
          props.onOpenPluginUi({
            parentSessionId: sessionId,
            surfaceId: resolved.id,
            serverName: resolved.server,
            pluginId: resolved.pluginId,
            resourceUri: resolved.resourceUri,
            ...documentViewerInstance(resolved.resourceUri),
            title: resolvePluginUiSurfaceTitle(resolved.title, locale),
            workspacePath: props.workspacePath,
            ...(props.workspaceIdentity ? { workspaceIdentity: props.workspaceIdentity } : {}),
            remoteSessionId: props.remoteSessionId ?? null,
          });
        };
        if (props.variant === "menu") {
          return (
            <DropdownMenuItem
              key={itemId}
              data-side-pane-add-item={itemId}
              onSelect={(event) => {
                if (!item.installed || !item.info?.enabled) event.preventDefault();
                void open();
              }}
              disabled={isBusy}
              aria-busy={isBusy || undefined}
            >
              <PuzzleIcon className="size-4 text-foreground-subtle" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <span className="flex items-center gap-1.5 text-foreground-subtle">
                {isBusy ? (
                  <Spinner
                    data-testid="side-pane-plugin-progress"
                    className="size-3.5 motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
                {actionLabel}
              </span>
            </DropdownMenuItem>
          );
        }
        return (
          <SidePaneLauncherRow
            key={itemId}
            itemId={itemId}
            icon={PuzzleIcon}
            avatar={
              <PluginStoreAvatar
                item={item}
                className="size-12"
                fallbackIcon={<PuzzleIcon className="size-6" />}
              />
            }
            label={title}
            description={
              surface ? resolveItemDisplayName(item, locale) : resolveItemDescription(item, locale)
            }
            descriptionTag={
              resolvePluginStoreSegment(item) === "community"
                ? intl.formatMessage({ id: "settings.plugins.store.segment.community" })
                : undefined
            }
            actionLabel={actionLabel}
            loading={isBusy}
            disabled={isBusy}
            onOpen={open}
          />
        );
      })}
    </>
  );
}

/**
 * 「打开标签页」条目：内置应用与 UI 插件共用的横向行（对齐原型 SidePaneAppLauncher）。
 * 整行是一个按钮，尾部「打开」只做视觉胶囊，避免按钮嵌套按钮。
 */
export function SidePaneLauncherRow({
  itemId,
  icon: Icon,
  avatar,
  label,
  description,
  descriptionTag,
  actionLabel,
  loading,
  disabled,
  onOpen,
}: {
  itemId: string;
  icon: LucideIcon;
  avatar?: ReactNode;
  label: string;
  description?: string;
  descriptionTag?: string;
  actionLabel?: string;
  loading?: boolean;
  disabled?: boolean;
  onOpen: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <button
      type="button"
      data-side-pane-open-tab-item={itemId}
      className="flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      onClick={onOpen}
      disabled={disabled}
      aria-busy={loading || undefined}
    >
      {/* 应用插件复用市场图标来源；固定 PuzzleIcon 会忽略已发布的品牌图片。 */}
      {avatar ?? (
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-surface">
          <Icon className="size-6 text-foreground-subtle" aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui-base font-semibold text-foreground">{label}</span>
        {description || descriptionTag ? (
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
            {descriptionTag ? (
              <span className="inline-flex h-4 shrink-0 items-center rounded-sm bg-tag px-1 text-ui-xs font-medium">
                {descriptionTag}
              </span>
            ) : null}
            {description ? (
              <span className="truncate" title={description}>
                {description}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          buttonVariants({ variant: "secondary", size: "sm" }),
          "shrink-0 rounded-full",
        )}
      >
        {loading ? (
          <Spinner
            data-testid="side-pane-plugin-progress"
            className="size-3.5 motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : null}
        {actionLabel ?? intl.formatMessage({ id: "settings.plugins.store.ui.open" })}
      </span>
    </button>
  );
}
