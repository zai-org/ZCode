import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Bug,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  ExternalLink,
  FileDown,
  ImageDown,
  Globe,
  LoaderCircle,
  MonitorSmartphone,
  MousePointerClick,
  RefreshCw,
  SlidersHorizontal,
  TriangleAlertIcon,
  X,
} from "lucide-react";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_BACK_BUTTON,
  TID_BROWSER_DEVTOOLS_BUTTON,
  TID_BROWSER_ELEMENT_PICKER_BUTTON,
  TID_BROWSER_EXPORT_PDF_ITEM,
  TID_BROWSER_EXPORT_PNG_ITEM,
  TID_BROWSER_SITE_SETTINGS_ITEM,
  TID_BROWSER_FORWARD_BUTTON,
  TID_BROWSER_LOAD_ERROR,
  TID_BROWSER_LOAD_ERROR_CERT_HINT,
  TID_BROWSER_MORE_BUTTON,
  TID_BROWSER_OPEN_EXTERNAL_ITEM,
  TID_BROWSER_REFRESH_BUTTON,
  TID_BROWSER_RESPONSIVE_BUTTON,
  TID_BROWSER_RECENT_VISITS,
} from "@zcode/shared/test-ids";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { BrowserVisitRecord } from "@/store/browserRecentVisitsStore.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Input } from "@/components/ui/input.js";
import {
  isDefaultBrowserOpenableUrl,
  type BrowserGuestFailure,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

export function BrowserToolbar({
  addressValue,
  browserState,
  permissionControl,
  formatMessage,
  onAddressChange,
  onGoBack,
  onGoForward,
  onOpenExternal,
  onOpenDevTools,
  onPickElement,
  onReload,
  onToggleResponsiveMode,
  onSubmit,
  isElementPickerActive,
  isResponsiveMode,
  canExport = false,
  isExporting = false,
  onExportPdf,
  onExportPng,
  onOpenSiteSettings,
}: {
  addressValue: string;
  browserState: BrowserState;
  /** 地址栏左侧的站点设置入口；聚焦编辑 URL 时隐藏但不卸载。 */
  permissionControl?: ReactNode;
  formatMessage: (descriptor: { id: string }) => string;
  onAddressChange: (value: string) => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onOpenExternal: () => void;
  onOpenDevTools: () => void;
  onPickElement: () => void;
  onReload: () => void;
  onToggleResponsiveMode: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isElementPickerActive: boolean;
  isResponsiveMode: boolean;
  /** 导出 PNG / PDF 的可用条件；未提供导出回调时菜单不出现这两项。 */
  canExport?: boolean;
  isExporting?: boolean;
  onExportPdf?: () => void;
  onExportPng?: () => void;
  /**
   * 站点设置（与 permissionControl 同一个回调）。窄面板里地址栏隐藏了 permissionControl，
   * 这时由「更多」菜单提供同一入口；宽面板地址栏里有，菜单不重复。不传时没有这一项。
   */
  onOpenSiteSettings?: () => void;
}) {
  const addressBarRef = useRef<HTMLDivElement>(null);
  const isAddressCompact = useIsAddressBarCompact(addressBarRef);
  return (
    <form
      onSubmit={(event) =>
        runUserAction({
          input: { featureId: "workbench.browser", action: "navigate", trigger: "keyboard" },
          operation: () => onSubmit(event),
          completed: { resultSource: "optimistic_projection" },
          failureStage: "browser_navigate",
        })
      }
      className="flex items-center h-12 px-3 gap-2"
    >
      <BrowserIconButton
        icon={<ChevronLeft className="h-4 w-4" />}
        title={formatMessage({ id: "browser.back" })}
        disabled={!browserState.canGoBack}
        dataTestId={TID_BROWSER_BACK_BUTTON}
        onClick={onGoBack}
      />
      <BrowserIconButton
        icon={<ChevronRight className="h-4 w-4" />}
        title={formatMessage({ id: "browser.forward" })}
        disabled={!browserState.canGoForward}
        dataTestId={TID_BROWSER_FORWARD_BUTTON}
        onClick={onGoForward}
      />
      <BrowserIconButton
        icon={<RefreshCw className={`h-4 w-4 ${browserState.isLoading ? "animate-spin" : ""}`} />}
        title={formatMessage({ id: "browser.reload" })}
        disabled={!browserState.isReady}
        dataTestId={TID_BROWSER_REFRESH_BUTTON}
        onClick={onReload}
      />
      {/*
        Bugfix（既有问题，BU-E2E-023 窄面板断言）：失焦时输入框固定 px-14（左右共 112px）居中显示 URL，
        border-box 的输入框宽度不能小于内边距；右侧面板很窄（如 Windows 1280 屏 150% 缩放，面板约 260px）时
        外层被压到约 20px，输入框仍是 ~114px，溢出盖住自由尺寸 / 选元素 / 更多三个按钮，点不到。
        按地址栏自身宽度（容器查询）决定内边距：够宽才用 px-14 居中，窄时用小内边距并隐藏站点设置入口，
        输入框不再溢出外层；隐藏的站点设置入口改由「更多」菜单提供（useIsAddressBarCompact）。
      */}
      <div
        ref={addressBarRef}
        className="group/browser-address @container/browser-address relative min-w-0 flex-1"
        data-testid="browser-address-bar"
      >
        <Input
          type="text"
          value={addressValue}
          data-testid={TID_BROWSER_ADDRESS_INPUT}
          size="sm"
          className="h-8 min-w-0 rounded-full px-2 text-left @min-[9rem]/browser-address:px-3 @min-[9rem]/browser-address:not-focus:px-14 @min-[9rem]/browser-address:not-focus:text-center"
          onChange={(event) => onAddressChange(event.target.value)}
          placeholder={formatMessage({ id: "browser.addressPlaceholder" })}
          spellCheck={false}
        />
        {/* 编辑 URL 时隐藏入口但不卸载，避免将隐藏图标误当成关闭权限申请。 */}
        <div className="absolute top-1/2 left-0.5 -translate-y-1/2 group-has-[input:focus]/browser-address:hidden @max-[9rem]/browser-address:hidden">
          {permissionControl}
        </div>
      </div>
      <BrowserIconButton
        icon={<MonitorSmartphone className="h-4 w-4" />}
        title={formatMessage({
          id: isResponsiveMode ? "browser.responsive.exit" : "browser.responsive.enter",
        })}
        disabled={false}
        dataTestId={TID_BROWSER_RESPONSIVE_BUTTON}
        onClick={onToggleResponsiveMode}
        active={isResponsiveMode}
        pressed={isResponsiveMode}
      />
      <BrowserIconButton
        icon={<MousePointerClick className="h-4 w-4" />}
        title={formatMessage({
          id: isElementPickerActive
            ? "browser.elementPicker.cancel"
            : "browser.elementPicker.start",
        })}
        disabled={!browserState.isReady}
        dataTestId={TID_BROWSER_ELEMENT_PICKER_BUTTON}
        onClick={onPickElement}
        active={isElementPickerActive}
        pressed={isElementPickerActive}
      />
      <BrowserToolbarMoreMenu
        canOpenExternal={
          browserState.isReady && isDefaultBrowserOpenableUrl(browserState.currentUrl)
        }
        canOpenDevTools={browserState.isReady}
        formatMessage={formatMessage}
        onOpenExternal={onOpenExternal}
        onOpenDevTools={onOpenDevTools}
        canExport={canExport && !isExporting}
        onExportPdf={onExportPdf}
        onExportPng={onExportPng}
        onOpenSiteSettings={isAddressCompact ? onOpenSiteSettings : undefined}
      />
    </form>
  );
}

/**
 * 地址栏窄到隐藏站点设置入口时为 true。阈值与地址栏上的容器查询 `@min-[9rem]/browser-address` 同一个值：
 * 菜单内容渲染在 portal 里，容器查询够不着，所以这里量地址栏宽度决定菜单项。
 */
const ADDRESS_BAR_COMPACT_REM = 9;

function useIsAddressBarCompact(ref: RefObject<HTMLDivElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const rootFontSize = () =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const update = () =>
      setCompact(element.getBoundingClientRect().width < ADDRESS_BAR_COMPACT_REM * rootFontSize());
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return compact;
}

function BrowserToolbarMoreMenu({
  canExport,
  canOpenDevTools,
  canOpenExternal,
  formatMessage,
  onExportPdf,
  onExportPng,
  onOpenDevTools,
  onOpenExternal,
  onOpenSiteSettings,
}: {
  onOpenSiteSettings?: () => void;
  canExport: boolean;
  canOpenDevTools: boolean;
  canOpenExternal: boolean;
  formatMessage: (descriptor: { id: string }) => string;
  onExportPdf?: () => void;
  onExportPng?: () => void;
  onOpenDevTools: () => void;
  onOpenExternal: () => void;
}) {
  const moreLabel = formatMessage({ id: "browser.more" });
  return (
    <DropdownMenu>
      <ControlHintTooltip title={moreLabel}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={moreLabel}
            data-testid={TID_BROWSER_MORE_BUTTON}
          >
            <Ellipsis className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      {/*
        Bugfix：选完菜单项马上再点「更多」打不开（Windows 1 倍 BU-E2E-023 导出 PDF 找不到菜单项）。
        关闭时内容要播 100ms 退出动画才卸载，这期间旧菜单的 DismissableLayer 仍在监听「点外部」；
        点触发器先打开新菜单，又被旧层当成点外部当场关掉。关闭时不播退出动画、立即卸载，就没有这段窗口。
        kit 里的 data-closed:animate-out 与这里的类 cn 不会去重、且排在后面，所以要加 ! 才压得住。
      */}
      <DropdownMenuContent align="end" className="w-52 data-closed:animate-none!">
        <DropdownMenuItem
          data-testid={TID_BROWSER_OPEN_EXTERNAL_ITEM}
          disabled={!canOpenExternal}
          onSelect={onOpenExternal}
        >
          <ExternalLink className="size-4" />
          <span>{formatMessage({ id: "browser.openExternal" })}</span>
        </DropdownMenuItem>
        {onExportPng ? (
          <DropdownMenuItem
            data-testid={TID_BROWSER_EXPORT_PNG_ITEM}
            disabled={!canExport}
            onSelect={onExportPng}
          >
            <ImageDown className="size-4" />
            <span>{formatMessage({ id: "browser.export.png" })}</span>
          </DropdownMenuItem>
        ) : null}
        {onExportPdf ? (
          <DropdownMenuItem
            data-testid={TID_BROWSER_EXPORT_PDF_ITEM}
            disabled={!canExport}
            onSelect={onExportPdf}
          >
            <FileDown className="size-4" />
            <span>{formatMessage({ id: "browser.export.pdf" })}</span>
          </DropdownMenuItem>
        ) : null}
        {onOpenSiteSettings ? (
          <DropdownMenuItem
            data-testid={TID_BROWSER_SITE_SETTINGS_ITEM}
            onSelect={onOpenSiteSettings}
          >
            <SlidersHorizontal className="size-4" />
            <span>{formatMessage({ id: "browser.permission.settings" })}</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          data-testid={TID_BROWSER_DEVTOOLS_BUTTON}
          disabled={!canOpenDevTools}
          onSelect={onOpenDevTools}
        >
          <Bug className="size-4" />
          <span>{formatMessage({ id: "browser.devtools" })}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BrowserEmptyState({
  browserState,
  formatMessage,
  isGuestStarting = !browserState.isReady,
  visits = [],
  onOpenRecentVisit,
  onRemoveRecentVisit,
}: {
  browserState: BrowserState;
  formatMessage: (descriptor: { id: string }) => string;
  isGuestStarting?: boolean;
  visits?: BrowserVisitRecord[];
  onOpenRecentVisit?: (url: string) => void;
  onRemoveRecentVisit?: (url: string) => void;
}) {
  if (visits.length > 0 && onOpenRecentVisit && !isGuestStarting) {
    return (
      <BrowserRecentVisits
        formatMessage={formatMessage}
        onOpen={onOpenRecentVisit}
        onRemove={onRemoveRecentVisit}
        visits={visits}
      />
    );
  }

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col pb-10 items-center text-center">
        {isGuestStarting ? (
          <LoaderCircle className="mb-6 size-16 animate-spin text-foreground opacity-30" />
        ) : (
          <Globe className="mb-6 size-16 text-foreground opacity-30" />
        )}
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({ id: "browser.title" })}
        </h3>
        <p className="mt-2 text-ui-base text-foreground-subtle">
          {formatMessage({ id: "browser.empty" })}
        </p>
      </div>
    </div>
  );
}

function BrowserRecentVisits({
  formatMessage,
  onOpen,
  onRemove,
  visits,
}: {
  formatMessage: (descriptor: { id: string }) => string;
  onOpen: (url: string) => void;
  onRemove?: (url: string) => void;
  visits: BrowserVisitRecord[];
}) {
  const { locale } = useZCodeIntl();
  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale],
  );
  return (
    <section
      aria-label={formatMessage({ id: "browser.recentVisits.title" })}
      data-testid={TID_BROWSER_RECENT_VISITS}
      className="absolute inset-0 z-10 overflow-y-auto bg-background px-4 py-5 sm:px-6"
    >
      <div
        data-testid="browser-recent-visits-content"
        className="absolute top-[40%] left-1/2 max-h-[calc(80%_-_40px)] w-[calc(100%_-_32px)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto sm:w-[calc(100%_-_48px)]"
      >
        <h2 className="mb-3 text-center text-ui-base font-medium text-foreground">
          {formatMessage({ id: "browser.recentVisits.title" })}
        </h2>
        <ul className="divide-y divide-border">
          {visits.map((visit) => (
            <li key={visit.url} className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                data-browser-recent-url={visit.url}
                title={visit.url}
                onClick={() => onOpen(visit.url)}
                className="flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand"
              >
                {visit.faviconUrl ? (
                  <img
                    alt=""
                    src={visit.faviconUrl}
                    className="size-5 shrink-0 rounded-sm object-contain"
                    onError={(event) => {
                      event.currentTarget.hidden = true;
                    }}
                  />
                ) : (
                  <Globe aria-hidden="true" className="size-5 shrink-0 text-foreground-subtle" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center justify-between gap-3">
                    <span className="truncate text-ui-base font-medium text-foreground">
                      {visit.title || visit.url}
                    </span>
                    <time
                      dateTime={new Date(visit.lastVisitedAt).toISOString()}
                      className="shrink-0 text-ui-xs text-foreground-subtle"
                    >
                      {timeFormatter.format(visit.lastVisitedAt)}
                    </time>
                  </span>
                  <span className="block truncate text-ui-sm text-foreground-subtle">
                    {visit.url}
                  </span>
                </span>
              </button>
              {onRemove ? (
                <ControlHintTooltip title={formatMessage({ id: "browser.recentVisits.remove" })}>
                  <Button
                    type="button"
                    size="icon-md"
                    variant="ghost"
                    aria-label={formatMessage({ id: "browser.recentVisits.remove" })}
                    data-browser-recent-remove-url={visit.url}
                    className="mr-1 text-foreground-subtle"
                    onClick={() => onRemove(visit.url)}
                  >
                    <X aria-hidden="true" className="size-4" />
                  </Button>
                </ControlHintTooltip>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * 页面加载失败时的可读错误态。
 *
 * Electron 的 `<webview>` 不带 Chrome 的安全插页，被拒的导航只落到一张空的
 * chrome-error 页；过去 errorMessage 只写进 state 没有渲染消费者，空置态又同时被关掉，
 * 用户最终只看到纯黑。证书类失败额外给出放行指引，避免用户无从下手。
 */
export function BrowserLoadErrorState({
  errorMessage,
  formatMessage,
  isCertificateError,
  onRetry,
}: {
  errorMessage: string;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  isCertificateError: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      data-testid={TID_BROWSER_LOAD_ERROR}
      className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6"
    >
      <div className="flex max-w-sm flex-col items-center pb-10 text-center">
        <TriangleAlertIcon className="mb-6 size-16 text-warning opacity-60" />
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({
            id: isCertificateError ? "browser.loadError.certTitle" : "browser.loadError.title",
          })}
        </h3>
        <p className="mt-2 font-mono text-ui-sm break-all text-foreground-subtlest">
          {errorMessage}
        </p>
        {isCertificateError ? (
          <p
            data-testid={TID_BROWSER_LOAD_ERROR_CERT_HINT}
            className="mt-3 text-ui-base text-foreground-subtle"
          >
            {formatMessage({ id: "browser.loadError.certHint" })}
          </p>
        ) : null}
        <Button type="button" variant="outline" className="mt-6" onClick={onRetry}>
          <RefreshCw className="size-4" />
          {formatMessage({ id: "browser.loadError.retry" })}
        </Button>
      </div>
    </div>
  );
}

/** guest 启动失败时由宿主接管画面；自动重建会形成失败循环，因此只提供显式重试。 */
export function BrowserGuestFailureState({
  formatMessage,
  guestFailure,
  onRetry,
}: {
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  guestFailure: BrowserGuestFailure;
  onRetry: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center pb-10 text-center">
        <TriangleAlertIcon className="mb-6 size-16 text-warning opacity-60" />
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({ id: "browser.guestFailed.title" })}
        </h3>
        <p className="mt-2 text-ui-base text-foreground-subtle">
          {formatMessage({ id: "browser.guestFailed.description" })}
        </p>
        <p className="mt-2 font-mono text-ui-sm text-foreground-subtlest">
          {formatMessage(
            { id: "browser.guestFailed.detail" },
            { exitCode: guestFailure.exitCode, reason: guestFailure.reason },
          )}
        </p>
        <Button type="button" variant="outline" className="mt-6" onClick={onRetry}>
          <RefreshCw className="size-4" />
          {formatMessage({ id: "browser.guestFailed.retry" })}
        </Button>
      </div>
    </div>
  );
}

function BrowserIconButton({
  dataTestId,
  disabled,
  icon,
  onClick,
  title,
  active = false,
  pressed,
}: {
  dataTestId: string;
  disabled: boolean;
  icon: ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  pressed?: boolean;
}) {
  return (
    <ControlHintTooltip title={title}>
      <Button
        type="button"
        size="icon-md"
        variant="ghost"
        // 灰色选中态不易与普通悬停区分；两个模式开关统一用主题蓝色，并在悬停时保留。
        className={
          active ? "bg-accent text-icon-blue hover:bg-accent hover:text-icon-blue" : undefined
        }
        aria-label={title}
        aria-pressed={pressed}
        data-testid={dataTestId}
        disabled={disabled}
        onClick={onClick}
      >
        {icon}
      </Button>
    </ControlHintTooltip>
  );
}
