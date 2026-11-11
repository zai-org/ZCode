import { useSetInterfaceModeWithTelemetry } from "@/lib/appTelemetry.js";
import { SidebarNativeTooltip, ControlHintTooltip } from "@/ControlHintTooltip.js";
/* oxlint-disable eslint(max-lines) -- footer 聚合账户、主题、模式和快捷键菜单。 */
import type { Locale, UserInfo } from "@zcode/shared";
import { memo, useCallback, useEffect, useState, type ReactNode } from "react";
import { DesktopCommandIds, LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES } from "@zcode/shared";
import {
  TID_LOGIN_MENU_ITEM,
  TID_LOGIN_TRIGGER,
  TID_LOGOUT_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
} from "@zcode/shared/test-ids";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { Badge } from "@/components/ui/badge.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  Copy,
  PencilRuler,
  Globe,
  Gift,
  LoaderCircle,
  LogInIcon,
  LogOut,
  Maximize,
  Palette,
  Settings,
  User,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useOpenRewards } from "@/rewards/RewardsProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { normalizeInterfaceMode } from "@/lib/interfaceMode.js";
import type { Theme } from "@/useTheme.js";
import { WorkspaceWebRemoteControlTrigger } from "@/WorkspaceWebRemoteControlTrigger.js";
import {
  WorkspaceSidebarFooterPlanBadge,
  WorkspaceSidebarFooterUsageSummaryContent,
  useWorkspaceSidebarFooterUsageSummaryState,
} from "@/WorkspaceSidebarFooterUsageSummary.js";

const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;

function getSidebarProfileName(user?: UserInfo | null): string {
  const displayName = user?.displayName?.trim();
  if (displayName) {
    return displayName;
  }

  const username = user?.username?.trim();
  if (username) {
    return username;
  }

  return "ZCode";
}

function getSidebarProfileBadge(
  user: UserInfo | null | undefined,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  if (user) {
    return getSidebarProfileName(user);
  }

  return formatMessage({ id: "sidebar.profile.notLoggedIn" });
}

function getAvatarFallbackText(user: UserInfo | null | undefined): string {
  const source = user?.displayName?.trim() || user?.username?.trim() || "Z";
  return source[0]?.toUpperCase() ?? "Z";
}

export const WorkspaceSidebarFooter = memo(function WorkspaceSidebarFooterComponent({
  theme,
  localeMenuValue,
  onLocaleChange,
  onThemeChange,
  onSettingsButtonClick,
  onUsageClick,
  onUpgradeClick,
  onLogin,
  onLogout,
  settingsButtonMode = "settings",
  user,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeTaskId,
  isDesktop = false,
  banner,
  className,
}: {
  theme: Theme;
  localeMenuValue: Locale | "system";
  onLocaleChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  onSettingsButtonClick?: () => void;
  onUsageClick?: () => void;
  onUpgradeClick?: Parameters<
    typeof WorkspaceSidebarFooterUsageSummaryContent
  >[0]["onUpgradeClick"];
  onLogin?: () => void;
  onLogout?: () => void;
  settingsButtonMode?: "settings" | "back";
  user?: UserInfo | null;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeTaskId?: string | null;
  isDesktop?: boolean;
  banner?: ReactNode;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const openRewards = useOpenRewards();
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useSetInterfaceModeWithTelemetry(platform, "app.profile");
  const zoomInShortcutLabel = useShortcutCommandLabel("zoomIn");
  const zoomOutShortcutLabel = useShortcutCommandLabel("zoomOut");
  const resetZoomShortcutLabel = useShortcutCommandLabel("resetZoom");
  const isRestoringOAuthSession = useZCodeStore((state) => state.isRestoringOAuthSession);
  const profileBadge = getSidebarProfileBadge(user, intl.formatMessage);
  const avatarFallbackText = getAvatarFallbackText(user);
  const avatarKey = user?.avatarUrl ?? user?.id ?? "guest";
  const showAuthRestoreLoading = !user && isRestoringOAuthSession;
  const usageSummaryState = useWorkspaceSidebarFooterUsageSummaryState({
    enabled: true,
    workspaceIdentity,
    workspacePath,
  });
  const copyUserId = async () => {
    if (!user?.id) return;
    try {
      await navigator.clipboard.writeText(user.id);
      toast(intl.formatMessage({ id: "sidebar.profile.userIdCopied" }));
    } catch {
      toast(intl.formatMessage({ id: "sidebar.profile.userIdCopyFailed" }));
    }
  };
  const profileContent = (
    <>
      <Avatar key={avatarKey} size="default">
        {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={profileBadge} /> : null}
        <AvatarFallback className="bg-background text-foreground">
          {user ? (
            avatarFallbackText
          ) : showAuthRestoreLoading ? (
            <>
              {/* Bugfix: OAuth 启动恢复未落定前，footer 之前会直接显示未登录头像，
                  用户很容易把“还在校验”误判成“已经退出”。
                  这里用 loading 图标明确表达“状态确认中”，等恢复成功或失败后再展示最终状态。 */}
              <LoaderCircle className="size-4 animate-spin" />
              <span className="sr-only">{intl.formatMessage({ id: "common.loading" })}</span>
            </>
          ) : (
            <User className="size-4" />
          )}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 overflow-hidden text-left">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-base font-semibold text-foreground">
            {profileBadge}
          </span>
        </div>
      </div>
    </>
  );
  const settingsButtonLabel =
    settingsButtonMode === "back"
      ? intl.formatMessage({ id: "workspace.backToWorkspace" })
      : intl.formatMessage({ id: "settings.title" });
  const usageButtonClick = onUsageClick ?? onSettingsButtonClick;
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [desktopZoomLevel, setDesktopZoomLevel] = useState(0);
  const runDesktopZoomCommand = useCallback(
    (command: (typeof DesktopCommandIds)["ZoomIn" | "ZoomOut" | "ResetZoom"]) => {
      void platform.executeDesktopCommand(command);
    },
    [platform],
  );

  useEffect(() => {
    if (!isDesktop) {
      setDesktopZoomLevel(0);
      return;
    }

    let isCancelled = false;
    void platform.getDesktopZoomLevel?.().then((state) => {
      if (!isCancelled && Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    const dispose = platform.onDesktopZoomLevelChanged?.((state) => {
      if (Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    return () => {
      isCancelled = true;
      dispose?.();
    };
  }, [isDesktop, platform]);

  const canResetDesktopZoom = desktopZoomLevel !== 0;
  const canZoomIn = desktopZoomLevel < DESKTOP_ZOOM_MAX_LEVEL;
  const canZoomOut = desktopZoomLevel > DESKTOP_ZOOM_MIN_LEVEL;

  return (
    // footer 被 Settings 复用，页面专属边距由调用方传入，避免修改共享默认样式。
    <footer className={cn("flex shrink-0 flex-col gap-2.5 px-4 pt-2 pb-4", className)}>
      {banner}
      <div className="flex min-w-0 gap-2">
        <DropdownMenu open={profileMenuOpen} onOpenChange={setProfileMenuOpen}>
          <DropdownMenuTrigger asChild>
            {/* Bugfix: 头像和 Login 之前直接绑定到登录动作，导致用户无法从这里打开偏好设置。
              现在把这一块改成统一的设置菜单入口，登录/退出留在菜单项里，交互职责更清晰。 */}
            <Button
              type="button"
              variant="ghost"
              size={"lg"}
              className="min-w-0 flex-1 justify-start gap-2 overflow-hidden rounded-tl-2xl rounded-bl-2xl border-0 pl-0"
              data-testid={TID_LOGIN_TRIGGER}
              aria-label={profileBadge}
            >
              {/* Bugfix: Button 默认 shrink-0 且带 whitespace-nowrap，超长用户名会把 footer 撑出 sidebar。
                这里让触发按钮和文本列都允许收缩，并只在用户名自身做单行截断。 */}
              {profileContent}
            </Button>
          </DropdownMenuTrigger>
          {/* Bugfix: 菜单内容保持挂载，避免每次点击头像菜单都重建 footer 内部状态。 */}
          <DropdownMenuContent
            align="start"
            className="w-max min-w-50 max-w-[calc(100vw-2rem)]"
            forceMount
          >
            {user ? (
              <>
                <div
                  data-testid="profile-menu-header"
                  className="flex max-w-80 items-center gap-2 px-2 py-1.5"
                >
                  <Avatar key={avatarKey} size="default">
                    {user.avatarUrl ? (
                      <AvatarImage src={user.avatarUrl} alt={profileBadge} />
                    ) : null}
                    <AvatarFallback className="bg-background text-foreground">
                      {avatarFallbackText}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        data-testid="profile-menu-name"
                        className="truncate text-ui-base font-medium"
                      >
                        {profileBadge}
                      </span>
                      <span
                        data-testid="profile-menu-plan"
                        className="flex shrink-0 [&>span]:border-border/50 [&>span]:bg-transparent [&>span]:font-normal"
                      >
                        <WorkspaceSidebarFooterPlanBadge state={usageSummaryState} />
                      </span>
                    </div>
                    {user.id ? (
                      <div className="flex min-w-0 items-center gap-1 text-ui-sm text-foreground-subtle">
                        <span data-testid="profile-menu-id" className="min-w-0 truncate">
                          {intl.formatMessage({ id: "sidebar.profile.accountId" }, { id: user.id })}
                        </span>
                        <DropdownMenuItem
                          asChild
                          className="data-[highlighted]:bg-transparent data-[highlighted]:hover:bg-menu-hover data-[highlighted]:focus-visible:bg-menu-hover"
                          onSelect={(event) => {
                            event.preventDefault();
                            void copyUserId();
                          }}
                        >
                          <SidebarNativeTooltip>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              data-testid="copy-user-id"
                              className="min-h-0 p-0 text-foreground-subtle"
                              aria-label={intl.formatMessage({ id: "sidebar.profile.copyUserId" })}
                              title={intl.formatMessage({ id: "sidebar.profile.copyUserId" })}
                            >
                              <Copy className="size-3" />
                            </Button>
                          </SidebarNativeTooltip>
                        </DropdownMenuItem>
                      </div>
                    ) : null}
                  </div>
                </div>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Globe className="size-4" />
                {intl.formatMessage({ id: "settings.locale" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup value={localeMenuValue} onValueChange={onLocaleChange}>
                  <DropdownMenuRadioItem value="system">
                    {intl.formatMessage({
                      id: "sidebar.settings.systemDefault",
                    })}
                  </DropdownMenuRadioItem>
                  {/* 语言选项显示各语言本名（LOCALE_NATIVE_NAMES），不随界面语言翻译。 */}
                  {SUPPORTED_LOCALES.map((locale) => (
                    <DropdownMenuRadioItem key={locale} value={locale} lang={locale}>
                      {LOCALE_NATIVE_NAMES[locale]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Palette className="size-4" />
                {intl.formatMessage({ id: "settings.themeMode" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup value={theme} onValueChange={onThemeChange}>
                  <DropdownMenuRadioItem value="system">
                    {intl.formatMessage({
                      id: "sidebar.settings.systemDefault",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zai-dark">
                    {intl.formatMessage({
                      id: "sidebar.settings.theme.zai-dark",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zai-light">
                    {intl.formatMessage({
                      id: "sidebar.settings.theme.zai-light",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <PencilRuler className="size-4" />
                {intl.formatMessage({ id: "settings.interfaceMode" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup
                  value={interfaceMode}
                  onValueChange={(value) => setInterfaceMode(normalizeInterfaceMode(value))}
                >
                  <DropdownMenuRadioItem value="coding">
                    {intl.formatMessage({ id: "settings.interfaceMode.coding" })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="office">
                    {intl.formatMessage({ id: "settings.interfaceMode.office" })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {/* 快捷键设置（a58fdef 一系）：缩放子菜单 label 读生效表，设置页改绑后即时跟随 */}
            {/* Bugfix: ecc6952 收口重复缩放子菜单时误留了语言之后的那份，导致菜单顺序变成
                语言→缩放→主题；账户菜单分组顺序固定为 语言→主题→界面模式→缩放→用量→登录/登出，
                这里把唯一一份（读生效表）挪回用量摘要之前。
                staging 的 1d3179cb83 独立做过同一处移动（位置一致、缺本注释与 JSX 缩进），
                合并时保留本版本，不要再补第二份缩放子菜单。 */}
            {isDesktop ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ZoomIn className="size-4" />
                  {intl.formatMessage({ id: "sidebar.settings.interfaceZoom" })}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-50">
                  <DropdownMenuItem
                    disabled={!canZoomIn}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomIn)}
                  >
                    <ZoomIn className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.zoomIn" })}
                    <DropdownMenuShortcut>{zoomInShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canZoomOut}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomOut)}
                  >
                    <ZoomOut className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.zoomOut" })}
                    <DropdownMenuShortcut>{zoomOutShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canResetDesktopZoom}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ResetZoom)}
                  >
                    <Maximize className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.actualSize" })}
                    <DropdownMenuShortcut>{resetZoomShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {/* Bugfix: 升级入口状态不再以菜单开关为生命周期边界。 */}
            <WorkspaceSidebarFooterUsageSummaryContent
              state={usageSummaryState}
              onUsageClick={usageButtonClick}
              onUpgradeClick={onUpgradeClick}
            />
            {user ? (
              <DropdownMenuItem onSelect={() => openRewards?.()} data-testid="rewards-menu-item">
                <Gift className="size-4" />
                {intl.formatMessage({ id: "rewards.menuTitle" })}
                <Badge
                  data-testid="rewards-reward-badge"
                  className="-ml-0.5 h-auto border-0 px-1.5 py-0.5 text-ui-sm leading-none bg-[var(--color-plugin-paid-plan-badge)] text-[var(--color-plugin-paid-plan-badge-foreground)]"
                >
                  {intl.formatMessage({ id: "rewards.menuBadge" })}
                </Badge>
              </DropdownMenuItem>
            ) : null}
            {onLogin && !user ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onLogin} data-testid={TID_LOGIN_MENU_ITEM}>
                  <LogInIcon className="size-4" />
                  {intl.formatMessage({ id: "app.login" })}
                </DropdownMenuItem>
              </>
            ) : null}
            {onLogout ? <DropdownMenuSeparator /> : null}
            {onLogout ? (
              <DropdownMenuItem onSelect={onLogout} data-testid={TID_LOGOUT_BUTTON}>
                <LogOut className="size-4" />
                {intl.formatMessage({ id: "app.logout" })}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex shrink-0 items-center gap-1.5">
          {isDesktop && workspacePath ? (
            <WorkspaceWebRemoteControlTrigger
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              remoteSessionId={workspaceRemoteSessionId}
              initialTaskId={activeTaskId ?? undefined}
              compact
            />
          ) : null}
          <ControlHintTooltip title={settingsButtonLabel}>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              data-testid={TID_TASK_SETTINGS_BUTTON}
              aria-label={settingsButtonLabel}
              disabled={!onSettingsButtonClick}
              onClick={onSettingsButtonClick}
            >
              <Settings className="size-4" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
    </footer>
  );
});
