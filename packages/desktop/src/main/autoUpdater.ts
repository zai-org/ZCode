/* eslint-disable max-lines -- autoUpdater 需要集中维护 Electron 事件、菜单状态与 IPC 交互，过度拆分会让更新状态流更难追踪 */
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import type { ISettingService } from "@zcode/services";
import pkg, { CancellationToken } from "electron-updater";
import semver from "semver";
const { autoUpdater } = pkg;
import {
  DEFAULT_LOCALE,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  TEST_ZCODE_ENDPOINT_ORIGIN,
  PlatformChannels,
  ZCODE_VERSION,
  desktopMenuMessageIds,
  formatDesktopMenuMessage,
  getDesktopMenuMessage,
  resolveRuntimeZCodeEndpointOrigin,
  type ElectronReleaseChannel,
  type Locale,
  type PostUpdateReleaseNotesPayload,
  type UpdateCheckResultPayload,
  type UpdateStatePayload,
} from "@zcode/shared";
import { logger } from "./logger.js";
import { verifyWindowsAuthenticodeSignature } from "../../scripts/powershell-command.mjs";
import { ManifestUpdateProvider, getElectronReleasePlatform } from "./manifestUpdateProvider.js";

export const CHECK_FOR_UPDATE_MENU_ID = "check-for-update";
const AUTO_UPDATE_POLL_INTERVAL_MS = 15 * 60 * 1000;
const AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS = 2 * 60 * 1000;
const UPDATE_FEED_URL_ENV = "ZCODE_UPDATE_FEED_URL";
const UPDATE_FEED_URL_SWITCH = "--zcode-update-feed-url";
const DEV_AUTO_UPDATE_ENV = "ZCODE_AUTO_UPDATE_DEV";
const DEV_AUTO_UPDATE_SWITCH = "--zcode-auto-update-dev";
const DEV_AUTO_UPDATE_VERSION_ENV = "ZCODE_AUTO_UPDATE_DEV_VERSION";
const DEV_AUTO_UPDATE_VERSION_SWITCH = "--zcode-auto-update-dev-version";
let readyUpdateVersion: string | null = null;
let readyUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let readyUpdateRestoredFromPendingReleaseNotes = false;
let menuLocale: Locale = DEFAULT_LOCALE;
let manualCheckWebContentsId: number | null = null;
let pendingPostUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let deliveredPostUpdateReleaseNotesWebContentsId: number | null = null;
let autoUpdatePollTimer: NodeJS.Timeout | null = null;
let autoUpdatePollIntervalMs: number | null = null;
let checkForUpdatesInFlight = false;
let autoUpdateCheckGeneration = 0;
let activeAutoUpdateCheckId: number | null = null;
let activeAutoUpdateCheckChannel: ElectronReleaseChannel | null = null;
let settlingAutoUpdateCheckId: number | null = null;
let availableUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let availableUpdateChannel: ElectronReleaseChannel = "stable";
let downloadingUpdateVersion: string | null = null;
let downloadingUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
let downloadingUpdateChannel: ElectronReleaseChannel | null = null;
let downloadCancellationToken: CancellationToken | null = null;
let readyUpdateChannel: ElectronReleaseChannel | null = null;
let pendingManifestReleaseChannelRefresh: ElectronReleaseChannel | null = null;
let onBeforeQuitAndInstall: (() => void | Promise<void>) | undefined;
const acknowledgedPostUpdateReleaseNotesVersions = new Set<string>();
const cancelledDownloadTokens = new WeakSet<CancellationToken>();
let pendingCancelledDownloadErrorCount = 0;
let autoUpdaterSettingService: SettingServiceLike | undefined;
// initAutoUpdater({ enabled: false }) 只清轮询并 return，electron-updater 实例保持未配置
// （占位 feed、autoDownload 默认值）。任何漏改成按身份判断的入口若仍调用手动检查，
// 都会对占位 feed 发真实请求。这里记住“本 flavor 已禁用”，让手动检查在模块内部 fail-closed。
let autoUpdaterDisabledForProductFlavor = false;

type SettingServiceLike = Pick<ISettingService, "get" | "update">;

type ReleaseNoteInfoLike = {
  note?: string | null;
  version?: string | null;
};

type UpdateDownloadedInfoLike = {
  version: string;
  path?: string | null;
  files?: Array<{ url?: string | null } | null> | null;
  packages?: Record<string, { path?: string | null } | null> | null;
  zcodeReleaseChannel?: ElectronReleaseChannel | null;
  releaseName?: string | null;
  releaseNotes?: string | ReleaseNoteInfoLike[] | null;
  releaseDate?: string | Date | null;
  releaseNotesByLocale?: Partial<
    Record<
      Locale,
      | string
      | {
          title?: string | null;
          markdown?: string | null;
          releaseNotes?: string | ReleaseNoteInfoLike[] | null;
        }
      | null
    >
  > | null;
};

type RuntimeUpdateFeedSource = { url: string };

type AutoUpdaterMenuState = UpdateStatePayload;
let menuState: AutoUpdaterMenuState = { kind: "idle", enabled: true };

export type ForceAutoUpdateState =
  | { kind: "checking" }
  | { kind: "downloading"; version?: string; progress?: string }
  | { kind: "ready"; version?: string }
  | { kind: "installing" }
  | { kind: "error"; message: string }
  | { kind: "dev-skipped"; message?: string };

let activeForceAutoUpdateListener: ((state: ForceAutoUpdateState) => void) | null = null;
const autoUpdaterStateListeners = new Set<(state: UpdateStatePayload) => void>();
let forceAutoUpdateLastLoggedProgressBucket: number | null = null;

interface InitAutoUpdaterOptions {
  enabled?: boolean;
  onBeforeQuitAndInstall?: () => void | Promise<void>;
  settingService?: SettingServiceLike;
  locale?: Locale;
  updateFeedSource?: RuntimeUpdateFeedSource;
  deviceMid?: string;
  resolveEndpointOrigin?: () => string | Promise<string>;
  resolveZcodeJwtToken?: () => Promise<string | null | undefined>;
}

let quitAndInstallState: "idle" | "preparing" | "installing" | "recovering" = "idle";
let pendingDownloadedUpdate: { token: CancellationToken; info: UpdateDownloadedInfoLike } | null =
  null;

function isUpdateTargetLocked(): boolean {
  return quitAndInstallState !== "idle";
}

function recoverFromFailedUpdateInstall(): void {
  if (quitAndInstallState === "recovering") return;
  // 退出准备已不可逆地关闭 Host/Agent 和远控服务；安装失败不能只清标记留在失效窗口。
  // 恢复保持终态直到退出，重复原生错误不得重复安排重启。
  quitAndInstallState = "recovering";
  logger.warn("[auto-update] install failed after shutdown started: relaunch app");
  app.relaunch();
  app.exit(0);
}
let devAutoUpdateVersionOverride: string | null = null;
let recheckAfterDownload: ((reason: string) => void) | null = null;
let pendingFailedDownloadRecheck = false;

type MutableAutoUpdaterForDev = typeof autoUpdater & {
  currentVersion?: semver.SemVer;
  forceDevUpdateConfig?: boolean;
};

function isTruthyRuntimeFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readCommandLineSwitchValue(name: string): string | null {
  const prefix = `${name}=`;
  for (const arg of process.argv) {
    if (arg === name) {
      return "";
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
}

function isDevAutoUpdateEnabled(): boolean {
  return (
    isTruthyRuntimeFlag(process.env[DEV_AUTO_UPDATE_ENV]) ||
    readCommandLineSwitchValue(DEV_AUTO_UPDATE_SWITCH) !== null
  );
}

function canUseAutoUpdaterInCurrentRuntime(): boolean {
  return app.isPackaged || isDevAutoUpdateEnabled();
}

function shouldRelaunchForDevAutoUpdateInstall(): boolean {
  return !app.isPackaged && isDevAutoUpdateEnabled();
}

function getCurrentAppVersionForUpdate(): string {
  return devAutoUpdateVersionOverride ?? app.getVersion();
}

function resolveDevAutoUpdateVersion(): string | null {
  const configuredVersion =
    process.env[DEV_AUTO_UPDATE_VERSION_ENV]?.trim() ||
    readCommandLineSwitchValue(DEV_AUTO_UPDATE_VERSION_SWITCH)?.trim() ||
    ZCODE_VERSION;
  const parsed = semver.parse(configuredVersion);
  if (!parsed) {
    logger.warn(`[auto-update] ignore invalid dev update version=${configuredVersion}`);
    return null;
  }
  return parsed.format();
}

function applyDevAutoUpdateRuntimeOverrides(): void {
  devAutoUpdateVersionOverride = null;
  if (app.isPackaged || !isDevAutoUpdateEnabled()) {
    return;
  }

  const devVersion = resolveDevAutoUpdateVersion();
  const parsedVersion = devVersion ? semver.parse(devVersion) : null;
  const mutableAutoUpdater = autoUpdater as MutableAutoUpdaterForDev;
  mutableAutoUpdater.forceDevUpdateConfig = true;
  if (parsedVersion) {
    devAutoUpdateVersionOverride = parsedVersion.format();
    // Electron 开发态 app.getVersion() 读取的是 desktop 运行壳版本，
    // 不一定跟产品版本一致。验证自动更新时需要显式把 electron-updater 的
    // currentVersion 改成产品版本，否则 3.3.1 -> 3.3.2 这类流程无法复现。
    mutableAutoUpdater.currentVersion = parsedVersion;
  }

  logger.info(
    `[auto-update] dev update enabled version=${devAutoUpdateVersionOverride ?? app.getVersion()}`,
  );
}

function normalizeVersionForCompare(version: string): string | null {
  return semver.valid(semver.coerce(version.trim()));
}

function isVersionGreaterThan(candidateVersion: string, baselineVersion: string): boolean {
  const candidate = normalizeVersionForCompare(candidateVersion);
  const baseline = normalizeVersionForCompare(baselineVersion);
  if (candidate && baseline) {
    return semver.gt(candidate, baseline);
  }

  return candidateVersion.trim() !== baselineVersion.trim();
}

function shouldDownloadAvailableUpdate(version: string): boolean {
  if (readyUpdateRestoredFromPendingReleaseNotes) {
    return true;
  }

  return !readyUpdateVersion || isVersionGreaterThan(version, readyUpdateVersion);
}

function canPollForUpdatesFromState(state: AutoUpdaterMenuState): boolean {
  return (
    state.kind === "idle" || state.kind === "update-available" || state.kind === "update-downloaded"
  );
}

function hasVisibleUpdateTarget(state: AutoUpdaterMenuState): boolean {
  return state.kind === "update-available" || state.kind === "update-downloaded";
}

function resolveAutoUpdatePollInterval(state: AutoUpdaterMenuState): number {
  return hasVisibleUpdateTarget(state)
    ? AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS
    : AUTO_UPDATE_POLL_INTERVAL_MS;
}

function getAutoUpdaterReleaseChannelForCurrentState(): ElectronReleaseChannel {
  switch (menuState.kind) {
    case "update-available":
      return menuState.channel ?? availableUpdateChannel;
    case "download-progress":
      return menuState.channel ?? downloadingUpdateChannel ?? availableUpdateChannel;
    case "update-downloaded":
      return menuState.channel ?? readyUpdateChannel ?? availableUpdateChannel;
    default:
      return availableUpdateChannel;
  }
}

function readUpdateInfoReleaseChannel(
  info: UpdateDownloadedInfoLike,
): ElectronReleaseChannel | null {
  return info.zcodeReleaseChannel === "preview" || info.zcodeReleaseChannel === "stable"
    ? info.zcodeReleaseChannel
    : null;
}

function beginAutoUpdateCheck(): number {
  checkForUpdatesInFlight = true;
  autoUpdateCheckGeneration += 1;
  activeAutoUpdateCheckId = autoUpdateCheckGeneration;
  activeAutoUpdateCheckChannel = availableUpdateChannel;
  settlingAutoUpdateCheckId = null;
  return activeAutoUpdateCheckId;
}

function completeAutoUpdateCheck(reason: string, checkId: number | null): void {
  if (checkId !== null && activeAutoUpdateCheckId !== checkId) {
    return;
  }

  checkForUpdatesInFlight = false;
  activeAutoUpdateCheckId = null;
  activeAutoUpdateCheckChannel = null;
  settlingAutoUpdateCheckId = null;

  const pendingChannel = pendingManifestReleaseChannelRefresh;
  const shouldRecheckFailedDownload = pendingFailedDownloadRecheck;
  pendingFailedDownloadRecheck = false;
  if (shouldRecheckFailedDownload && !pendingChannel && !activeForceAutoUpdateListener) {
    // 下载失败发生在本次检查收口前。等标记清掉后再查一次，避免复查被进行中的检查直接丢掉。
    queueMicrotask(() => recheckAfterDownload?.("download-failed"));
  }
  if (!pendingChannel) {
    return;
  }

  pendingManifestReleaseChannelRefresh = null;
  refreshAutoUpdaterReleaseChannel(
    pendingChannel === "preview",
    `${reason} pending release channel refresh`,
  );
}

function finishAutoUpdateCheck(reason: string, checkId: number | null): void {
  if (
    checkId !== null &&
    activeAutoUpdateCheckId === checkId &&
    settlingAutoUpdateCheckId === checkId
  ) {
    return;
  }

  completeAutoUpdateCheck(reason, checkId);
}

function settleAutoUpdateCheckResult(
  reason: string,
  work: () => Promise<void> | void,
): Promise<void> {
  const checkId = activeAutoUpdateCheckId;
  if (!checkForUpdatesInFlight || checkId === null) {
    return Promise.resolve(work());
  }

  settlingAutoUpdateCheckId = checkId;
  try {
    return Promise.resolve(work()).finally(() => {
      // electron-updater 的 checkForUpdates() Promise 只代表请求返回，
      // 不会等待 update-available 里读取设置、跳过版本、自动下载等异步状态处理。
      // 这里让一次 check 的互斥范围覆盖“请求 + 结果处理”，避免通道刷新或手动检查抢在旧结果写状态前启动。
      completeAutoUpdateCheck(reason, checkId);
    });
  } catch (error) {
    completeAutoUpdateCheck(reason, checkId);
    return Promise.reject(error);
  }
}

function shouldIgnoreStaleAvailableUpdate(infoChannel: ElectronReleaseChannel | null): boolean {
  const expectedChannel = activeAutoUpdateCheckChannel ?? availableUpdateChannel;
  return Boolean(infoChannel && infoChannel !== expectedChannel);
}

function isReadyUpdateCurrentTarget(): boolean {
  return Boolean(
    readyUpdateVersion &&
    menuState.kind === "update-downloaded" &&
    menuState.version === readyUpdateVersion,
  );
}

function buildUpdateDownloadedState(version: string): AutoUpdaterMenuState {
  return {
    kind: "update-downloaded",
    enabled: true,
    version,
    ...(readyUpdateChannel ? { channel: readyUpdateChannel } : {}),
    ...(readyUpdateReleaseNotes ? { releaseNotes: readyUpdateReleaseNotes } : {}),
  };
}

function buildUpdateAvailableState(
  version: string,
  releaseNotes: PostUpdateReleaseNotesPayload | null,
  channel: ElectronReleaseChannel,
): AutoUpdaterMenuState {
  return {
    kind: "update-available",
    enabled: true,
    version,
    channel,
    ...(releaseNotes ? { releaseNotes } : {}),
  };
}

function notifyForceAutoUpdate(state: ForceAutoUpdateState) {
  activeForceAutoUpdateListener?.(state);
}

function getForceAutoUpdateNoUpdateMessage(): string {
  return menuLocale === "zh-CN"
    ? "未找到可安装更新，请使用手动升级。"
    : "No installable update was found. Use manual update instead.";
}

function normalizeProgressPercent(progress: unknown): string | undefined {
  if (typeof progress !== "object" || progress === null || !("percent" in progress)) {
    return undefined;
  }

  const percent = Number((progress as { percent?: unknown }).percent);
  if (!Number.isFinite(percent)) {
    return undefined;
  }

  return Math.max(0, Math.min(100, percent)).toFixed(0);
}

function logForceAutoUpdateProgress(progress: string | undefined) {
  if (!progress) {
    return;
  }

  const bucket = Math.floor(Number(progress) / 10) * 10;
  if (bucket === forceAutoUpdateLastLoggedProgressBucket) {
    return;
  }
  forceAutoUpdateLastLoggedProgressBucket = bucket;
  logger.info(`[force-update] 自动升级下载进度 ${progress}%`);
}

function buildDownloadProgressState(
  progress: string,
  byteProgress?: { transferredBytes: number; totalBytes: number },
): AutoUpdaterMenuState {
  return {
    kind: "download-progress",
    enabled: false,
    progress,
    ...(byteProgress ? byteProgress : {}),
    ...(downloadingUpdateVersion ? { version: downloadingUpdateVersion } : {}),
    ...(downloadingUpdateChannel ? { channel: downloadingUpdateChannel } : {}),
    ...(downloadingUpdateReleaseNotes ? { releaseNotes: downloadingUpdateReleaseNotes } : {}),
  };
}

async function quitAndInstallUpdate(rejectUnavailable = false) {
  if (quitAndInstallState !== "idle") {
    logger.info("[auto-update] quitAndInstall already in flight");
    return;
  }
  if (
    menuState.kind === "update-downloaded" &&
    readyUpdateVersion &&
    readyUpdateRestoredFromPendingReleaseNotes
  ) {
    const restoredVersion = readyUpdateVersion;
    const restoredReleaseNotes = readyUpdateReleaseNotes;
    const restoredChannel = readyUpdateChannel ?? availableUpdateChannel;
    logger.warn(
      `[auto-update] restage restored pending update before install version=${restoredVersion}`,
    );
    clearReadyUpdateState();
    availableUpdateReleaseNotes = restoredReleaseNotes;
    setAutoUpdaterMenuState(
      buildUpdateAvailableState(restoredVersion, restoredReleaseNotes, restoredChannel),
    );
    if (await shouldAutoDownloadAndInstallUpdates(autoUpdaterSettingService)) {
      downloadAvailableUpdate("restored-pending-install");
    }
    return;
  }

  if (
    menuState.kind !== "update-downloaded" ||
    !readyUpdateVersion ||
    !isReadyUpdateCurrentTarget()
  ) {
    // 修复原因：renderer 可能因为旧 UpdateReady 缓存残留而展示“重启以更新”，
    // 但 main 在 staging error 后已经清掉 ready。目标已经换成更高版本时，
    // 这里也不能安装仍低于目标的旧包。
    logger.warn(`[auto-update] ignore quitAndInstall request: state=${menuState.kind}`);
    if (rejectUnavailable) {
      throw new Error(`Update is not ready to install: state=${menuState.kind}`);
    }
    return;
  }

  // 安装只读取已下载包，不依赖 manifest 请求。立即锁定 ready，迟到检查不能替换它，
  // 也不能让一次挂起的后台网络请求扣押用户已经选择的安装。
  quitAndInstallState = "preparing";
  logger.info("[auto-update] user requested quit and install");
  if (process.platform === "win32" && app.isPackaged) {
    try {
      // 6.8.10 命中已下载缓存时跳过下载 hook；在退出服务前复查实际待安装文件。
      // 读取既有 updater 的安装路径，避免另存一份路径导致 ready 与安装目标不同步。
      const installerPath = (autoUpdater as unknown as { readonly installerPath: string | null })
        .installerPath;
      if (!installerPath) throw new Error("Windows update installer is missing");
      const failure = await verifyWindowsAuthenticodeSignature(installerPath);
      if (failure) throw new Error(failure);
    } catch (error) {
      quitAndInstallState = "idle";
      handleAutoUpdateFailure(error, "Windows update signature verification failed");
      if (rejectUnavailable) throw error;
      return;
    }
  }
  // macOS 上 quitAndInstall() 在关窗前不会先走 app.before-quit。
  // 如果仍然只靠 before-quit 去放行窗口 close，现有的“红绿灯关闭=隐藏窗口”逻辑会把退出拦住，
  // 表现成点击更新后界面消失但进程没退、安装流程也不再继续。
  // 这里先通知主进程进入“允许真正关窗”的状态，再把控制权交给 updater。
  try {
    // Windows 更新会替换 resources/glm 等随包资源；
    // 若 quitAndInstall 先于 host/agent 子进程完成退出，安装器可能在文件仍被占用时开始覆盖，
    // 最终留下“应用能启动但 bundled agent 丢失”的半更新状态。
    // 这里显式等待主进程完成退出准备，再进入安装器，尽量把资源替换和子进程回收时序拉直。
    await onBeforeQuitAndInstall?.();
  } catch (error) {
    // 安装前退出准备是释放 host/agent 与 resources/glm 文件锁的硬前置条件。
    // 如果这里失败后仍启动安装器，Windows 可能在资源仍被占用时覆盖安装目录，形成半更新。
    handleAutoUpdateFailure(error, "prepare quit and install failed");
    recoverFromFailedUpdateInstall();
    if (rejectUnavailable) {
      throw error;
    }
    return;
  }

  if (!readyUpdateVersion || !isReadyUpdateCurrentTarget()) {
    // 后台结果已锁定，只有原生 staging 错误能使 ready 失效。服务已经清理，
    // 此时不能仅解除标记停留在旧窗口，必须重启恢复 Host/Agent 和远控连接。
    recoverFromFailedUpdateInstall();
    return;
  }

  quitAndInstallState = "installing";
  try {
    if (shouldRelaunchForDevAutoUpdateInstall()) {
      // 开发态只用于验证服务端 manifest、下载进度和安装入口 UI 闭环，
      // 未打包应用没有可被安装器接管的真实发布包上下文。这里改为重启当前 dev app，
      // 避免点击“重启以更新”执行退出准备后停在无响应状态。
      logger.info("[auto-update] dev update install fallback: relaunch app");
      app.relaunch();
      app.exit(0);
      return;
    }

    // 3.3.0 的 Windows 自定义 PowerShell delayed launcher 在 detached/hidden
    // 模式下可能只创建 powershell.exe，却没有稳定执行到安装器启动，用户看到应用关闭但版本不变。
    // 这里恢复 electron-updater 原生安装入口，避免把“launcher 进程创建成功”误当成更新已接管。
    autoUpdater.quitAndInstall();
    // macOS 安装入口会先返回，原生 staging 完成后才异步触发 before-quit。
    // 成功交接后保留 installing 到进程退出，阻止迟到的检查、下载结果和重复安装命令重新准入。
  } catch (error) {
    handleAutoUpdateFailure(error, "quit and install failed");
    if (rejectUnavailable) {
      throw error;
    }
  }
}

function updateMenuItemLabel(label: string, enabled: boolean) {
  const menu = Menu.getApplicationMenu();
  const item = menu?.getMenuItemById(CHECK_FOR_UPDATE_MENU_ID);
  if (item) {
    item.label = label;
    item.enabled = enabled;
  }
}

function getMenuItemLabel(state: AutoUpdaterMenuState): string {
  switch (state.kind) {
    case "checking":
      return getDesktopMenuMessage(menuLocale, desktopMenuMessageIds.helpCheckingForUpdates);
    case "update-available":
      return formatDesktopMenuMessage(
        menuLocale,
        desktopMenuMessageIds.helpUpdateAvailableVersion,
        { version: state.version },
      );
    case "download-progress":
      return formatDesktopMenuMessage(
        menuLocale,
        desktopMenuMessageIds.helpDownloadingUpdateProgress,
        { progress: state.progress },
      );
    case "update-downloaded":
      return formatDesktopMenuMessage(menuLocale, desktopMenuMessageIds.helpRestartToUpdate, {
        version: state.version,
      });
    case "idle":
    default:
      return getDesktopMenuMessage(menuLocale, desktopMenuMessageIds.helpCheckForUpdates);
  }
}

function syncMenuItemState() {
  updateMenuItemLabel(getMenuItemLabel(menuState), menuState.enabled);
}

function isSameAutoUpdaterMenuState(left: AutoUpdaterMenuState, right: AutoUpdaterMenuState) {
  if (left.kind !== right.kind || left.enabled !== right.enabled) {
    return false;
  }

  switch (left.kind) {
    case "update-available":
      return (
        right.kind === left.kind &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "update-downloaded":
      return (
        right.kind === left.kind &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "download-progress":
      return (
        right.kind === left.kind &&
        right.progress === left.progress &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    case "idle":
    case "checking":
    default:
      return true;
  }
}

function broadcastAutoUpdaterState() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(PlatformChannels.UpdateStateChanged, menuState);
    }
  }
}

export function onAutoUpdaterStateChanged(listener: (state: UpdateStatePayload) => void) {
  autoUpdaterStateListeners.add(listener);
  return () => {
    autoUpdaterStateListeners.delete(listener);
  };
}

function setAutoUpdaterMenuState(nextState: AutoUpdaterMenuState) {
  if (isSameAutoUpdaterMenuState(menuState, nextState)) {
    return;
  }

  menuState = nextState;
  syncMenuItemState();
  broadcastAutoUpdaterState();
  ensureAutoUpdatePollInterval();
  for (const listener of autoUpdaterStateListeners) {
    listener(menuState);
  }
}

function findLiveWindowByWebContentsId(webContentsId: number | null) {
  if (webContentsId == null) {
    return null;
  }

  return (
    BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && win.webContents.id === webContentsId,
    ) ?? null
  );
}

function deriveReleaseNotesTitle(markdown: string, version: string) {
  const firstHeading = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("# ") && line.length > 2);

  return firstHeading ? firstHeading.slice(2).trim() : `Release v${version}`;
}

function normalizeReleaseNotesMarkdown(
  releaseNotes: UpdateDownloadedInfoLike["releaseNotes"],
): string | null {
  if (typeof releaseNotes === "string") {
    const markdown = releaseNotes.trim();
    return markdown === "" ? null : markdown;
  }

  if (!Array.isArray(releaseNotes)) {
    return null;
  }

  const markdown = releaseNotes
    .map((item) => (typeof item?.note === "string" ? item.note.trim() : ""))
    .filter((item) => item.length > 0)
    .join("\n\n")
    .trim();

  return markdown === "" ? null : markdown;
}

function normalizeLocalizedReleaseNotes(
  version: string,
  releaseNotesByLocale: UpdateDownloadedInfoLike["releaseNotesByLocale"],
): PostUpdateReleaseNotesPayload["releaseNotesByLocale"] | undefined {
  const localized: PostUpdateReleaseNotesPayload["releaseNotesByLocale"] = {};
  if (!releaseNotesByLocale || typeof releaseNotesByLocale !== "object") {
    return undefined;
  }

  for (const locale of ["zh-CN", "en-US"] as const) {
    const entry = releaseNotesByLocale[locale];
    if (!entry) {
      continue;
    }

    const markdown =
      typeof entry === "string"
        ? normalizeReleaseNotesMarkdown(entry)
        : normalizeReleaseNotesMarkdown(entry.markdown ?? entry.releaseNotes);
    if (!markdown) {
      continue;
    }

    localized[locale] = {
      title:
        typeof entry === "object" && entry.title?.trim()
          ? entry.title.trim()
          : deriveReleaseNotesTitle(markdown, version),
      markdown,
    };
  }

  return Object.keys(localized).length > 0 ? localized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function redactUpdateFeedUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (url.search) {
      url.search = "?<redacted>";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

function readSwitchValue(argv: readonly string[], switchName: string): string | undefined {
  const equalsPrefix = `${switchName}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // 协议注册使用 -- 分隔外部 URL；其后的内容不能重新解释为应用开关。
    if (arg === "--") break;
    if (!arg) {
      continue;
    }
    if (arg.startsWith(equalsPrefix)) {
      return arg.slice(equalsPrefix.length).trim() || undefined;
    }
    if (arg === switchName) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        return next.trim() || undefined;
      }
      return undefined;
    }
  }
  return undefined;
}

export function resolveUpdateFeedSourceFromStartupConfig(
  options: {
    argv?: readonly string[];
    env?: Record<string, string | undefined>;
  } = {},
): RuntimeUpdateFeedSource | undefined {
  // Windows 深链中的引号可拆出额外 argv。正式包必须忽略调试更新源，
  // 不能让不可信启动参数（或继承的环境变量）接管安装包下载来源。
  if (app.isPackaged) return undefined;
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const feedUrl = readSwitchValue(argv, UPDATE_FEED_URL_SWITCH) ?? env[UPDATE_FEED_URL_ENV]?.trim();
  return feedUrl
    ? {
        url: feedUrl,
      }
    : undefined;
}

async function resolveUpdateReleaseChannel(
  settingService: SettingServiceLike | undefined,
): Promise<ElectronReleaseChannel> {
  if (!settingService) {
    return "stable";
  }

  try {
    const settings = await settingService.get();
    return settings.receivePreviewUpdates === true ? "preview" : "stable";
  } catch (error) {
    logger.warn("[auto-update] read preview update setting failed:", error);
    return "stable";
  }
}

async function syncAutoUpdateCheckChannelFromSettings(
  checkId: number,
  settingService: SettingServiceLike | undefined,
  reason: string,
): Promise<void> {
  const nextChannel = await resolveUpdateReleaseChannel(settingService);
  if (isUpdateTargetLocked() || activeAutoUpdateCheckId !== checkId) {
    return;
  }

  if (availableUpdateChannel !== nextChannel) {
    logger.info(
      `[auto-update] ${reason}: check channel ${availableUpdateChannel} -> ${nextChannel}`,
    );
  }
  // 服务端 manifest provider 会在 checkForUpdates 内部读取 preview 设置。
  // 如果 begin 阶段仍用默认 stable 作为 expected channel，冷启动 preview 结果会被误判为 stale。
  availableUpdateChannel = nextChannel;
  activeAutoUpdateCheckChannel = nextChannel;
}

function applyManifestUpdateProvider(options: InitAutoUpdaterOptions): void {
  // 在更新器装配边界再次约束，避免内部调用绕过启动配置解析。
  const manifestUrl = app.isPackaged ? undefined : options.updateFeedSource?.url.trim();
  autoUpdater.setFeedURL({
    provider: "custom",
    updateProvider: ManifestUpdateProvider,
    endpointOrigin: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
    ...(manifestUrl ? { manifestUrl } : {}),
    releasePlatform: getElectronReleasePlatform(),
    deviceMid: options.deviceMid,
    resolveZcodeJwtToken: options.resolveZcodeJwtToken,
    resolveEndpointOrigin: async () => {
      const origin = await (
        options.resolveEndpointOrigin ?? (() => resolveRuntimeZCodeEndpointOrigin(process.env))
      )();
      // 通用后端覆盖不是更新发布授权；正式包只允许既有官方 HTTPS 入口。
      if (
        app.isPackaged &&
        origin !== DEFAULT_ZCODE_ENDPOINT_ORIGIN &&
        origin !== TEST_ZCODE_ENDPOINT_ORIGIN
      ) {
        return DEFAULT_ZCODE_ENDPOINT_ORIGIN;
      }
      return origin;
    },
    resolveReleaseChannel: async () => {
      const channel = await resolveUpdateReleaseChannel(options.settingService);
      if (!isUpdateTargetLocked()) availableUpdateChannel = channel;
      return channel;
    },
  });
  logger.info(
    manifestUrl
      ? `[auto-update] service manifest provider applied platform=${getElectronReleasePlatform()} manifestUrl=${redactUpdateFeedUrlForLog(manifestUrl)}`
      : `[auto-update] service manifest provider applied platform=${getElectronReleasePlatform()}`,
  );
}

function pickFallbackReleaseNotesMarkdown(
  localized: PostUpdateReleaseNotesPayload["releaseNotesByLocale"] | undefined,
): string | null {
  return (
    localized?.[menuLocale]?.markdown ??
    localized?.["zh-CN"]?.markdown ??
    localized?.["en-US"]?.markdown ??
    null
  );
}

function normalizeReleaseDate(
  releaseDate: UpdateDownloadedInfoLike["releaseDate"],
): string | undefined {
  if (releaseDate instanceof Date && !Number.isNaN(releaseDate.getTime())) {
    return releaseDate.toISOString();
  }
  if (typeof releaseDate !== "string") {
    return undefined;
  }
  const trimmed = releaseDate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPostUpdateReleaseNotesPayload(
  info: UpdateDownloadedInfoLike,
): PostUpdateReleaseNotesPayload | null {
  const releaseNotesByLocale = normalizeLocalizedReleaseNotes(
    info.version,
    info.releaseNotesByLocale,
  );
  const markdown =
    normalizeReleaseNotesMarkdown(info.releaseNotes) ??
    pickFallbackReleaseNotesMarkdown(releaseNotesByLocale);
  if (!markdown) {
    return null;
  }

  const title = info.releaseName?.trim() || deriveReleaseNotesTitle(markdown, info.version);
  const releaseDate = normalizeReleaseDate(info.releaseDate);
  return {
    version: info.version,
    title,
    markdown,
    ...(releaseDate ? { releaseDate } : {}),
    ...(releaseNotesByLocale ? { releaseNotesByLocale } : {}),
  };
}

async function persistPendingPostUpdateReleaseNotes(
  settingService: SettingServiceLike,
  payload: PostUpdateReleaseNotesPayload,
  reason: string,
) {
  if (acknowledgedPostUpdateReleaseNotesVersions.has(payload.version)) {
    logger.info(
      `[auto-update] skip persisting acknowledged post-update release notes (${reason}) version=${payload.version}`,
    );
    return;
  }

  await settingService.update({ pendingPostUpdateReleaseNotes: payload });
  pendingPostUpdateReleaseNotes = payload;
  deliveredPostUpdateReleaseNotesWebContentsId = null;
  logger.info(
    `[auto-update] persisted post-update release notes (${reason}) version=${payload.version}`,
  );
}

/**
 * 待展示说明里的 version 来自「已下载的安装包」；当前进程版本在安装完成前仍可能是旧版，
 * 此时待展示版本高于当前运行版本属于正常中间态，不能丢弃。
 * 若用户跳过自动更新链路（官网安装包等）直接升到更高版本，磁盘里可能仍残留更早一次下载写入的 pending，
 * 此时待展示版本低于已安装版本，应在启动时丢弃，否则会弹出旧版更新说明。
 */
function shouldDiscardStalePendingReleaseNotes(
  pendingVersion: string,
  appVersion: string,
): boolean {
  const pending = pendingVersion.trim();
  const current = appVersion.trim();
  if (pending === current) {
    return false;
  }

  const pendingCoerced = semver.valid(semver.coerce(pending));
  const appCoerced = semver.valid(semver.coerce(current));
  if (!pendingCoerced || !appCoerced) {
    return false;
  }

  return semver.lt(pendingCoerced, appCoerced);
}

function isPendingReleaseNotesForFutureVersion(payload: PostUpdateReleaseNotesPayload): boolean {
  return isVersionGreaterThan(payload.version, getCurrentAppVersionForUpdate());
}

function isDevSquirrelReadyError(error: unknown): boolean {
  if (
    app.isPackaged ||
    !isDevAutoUpdateEnabled() ||
    process.platform !== "darwin" ||
    !isRecord(error)
  ) {
    return false;
  }

  return error.domain === "SQRLUpdaterErrorDomain" && error.code === 2;
}

async function clearPendingPostUpdateReleaseNotes(
  settingService: SettingServiceLike,
  reason: string,
) {
  if (!pendingPostUpdateReleaseNotes) {
    return;
  }

  const version = pendingPostUpdateReleaseNotes.version;
  await settingService.update({ pendingPostUpdateReleaseNotes: undefined });
  pendingPostUpdateReleaseNotes = null;
  deliveredPostUpdateReleaseNotesWebContentsId = null;
  logger.info(`[auto-update] cleared post-update release notes (${reason}) version=${version}`);
}

function sendManualCheckResult(payload: UpdateCheckResultPayload) {
  const webContentsId = manualCheckWebContentsId;
  if (webContentsId == null) return;
  manualCheckWebContentsId = null;

  const win = findLiveWindowByWebContentsId(webContentsId);
  if (!win) {
    logger.info(
      `[auto-update] manual check result dropped, target webContents ${webContentsId} gone`,
    );
    return;
  }
  logger.info(`[auto-update] manual check result → wc=${webContentsId}: ${payload.kind}`);
  win.webContents.send(PlatformChannels.UpdateCheckResult, payload);
}

function clearAvailableUpdateState() {
  availableUpdateReleaseNotes = null;
}

function clearDownloadingUpdateState() {
  downloadingUpdateVersion = null;
  downloadingUpdateReleaseNotes = null;
  downloadingUpdateChannel = null;
}

function clearReadyUpdateState() {
  readyUpdateVersion = null;
  readyUpdateReleaseNotes = null;
  readyUpdateChannel = null;
  readyUpdateRestoredFromPendingReleaseNotes = false;
}

function clearPersistedPostUpdateReleaseNotesForVersion(version: string, reason: string) {
  if (pendingPostUpdateReleaseNotes?.version === version) {
    pendingPostUpdateReleaseNotes = null;
    deliveredPostUpdateReleaseNotesWebContentsId = null;
  }

  const settingService = autoUpdaterSettingService;
  if (!settingService) {
    return;
  }

  void (async () => {
    try {
      const settings = await settingService.get();
      if (settings.pendingPostUpdateReleaseNotes?.version !== version) {
        return;
      }

      await settingService.update({ pendingPostUpdateReleaseNotes: undefined });
      logger.info(`[auto-update] cleared post-update release notes (${reason}) version=${version}`);
    } catch (error) {
      logger.warn(`[auto-update] clear post-update release notes (${reason}) failed:`, error);
    }
  })();
}

function isCancelledDownload(cancellationToken: CancellationToken, error: unknown): boolean {
  return (
    cancelledDownloadTokens.has(cancellationToken) ||
    (cancellationToken.cancelled && isDownloadCancellationError(error))
  );
}

function isDownloadCancellationError(error: unknown): boolean {
  return error instanceof Error && error.message === "cancelled";
}

function markCancelledDownload(cancellationToken: CancellationToken) {
  cancelledDownloadTokens.add(cancellationToken);
  pendingCancelledDownloadErrorCount += 1;
}

function shouldIgnoreCancelledDownloadError(error: unknown): boolean {
  if (pendingCancelledDownloadErrorCount <= 0 || !isDownloadCancellationError(error)) {
    return false;
  }

  pendingCancelledDownloadErrorCount -= 1;
  return true;
}

function handleAutoUpdateFailure(error: unknown, source: string) {
  if (quitAndInstallState === "recovering") return;
  if (isUpdateTargetLocked() && source.endsWith("check failed")) {
    logger.info("[auto-update] ignore late check failure after install admission");
    return;
  }
  const failedInstall = quitAndInstallState === "installing";
  const message = error instanceof Error ? error.message : String(error);
  const failedDownload =
    menuState.kind === "download-progress"
      ? {
          version: downloadingUpdateVersion ?? menuState.version,
          releaseNotes: downloadingUpdateReleaseNotes ?? menuState.releaseNotes ?? null,
          channel: downloadingUpdateChannel ?? menuState.channel ?? availableUpdateChannel,
        }
      : downloadCancellationToken && downloadingUpdateVersion
        ? {
            version: downloadingUpdateVersion,
            releaseNotes: downloadingUpdateReleaseNotes ?? null,
            channel: downloadingUpdateChannel ?? availableUpdateChannel,
          }
        : null;
  if (
    menuState.kind === "update-downloaded" &&
    readyUpdateVersion &&
    isDevSquirrelReadyError(error)
  ) {
    // 开发态验证真实测试环境 manifest 时，macOS Squirrel 仍可能在
    // update-downloaded 后补一个 code=2 staging 错误。生产包必须清掉失败的 ready，
    // 但开发态需要保留 ready 状态来验证“重启以更新”交互闭环。
    logger.warn(
      `[auto-update] ignore dev Squirrel ready error after ${source} version=${readyUpdateVersion}: ${message}`,
    );
    setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
    return;
  }

  logger.error(`[auto-update] ${source}:`, error);
  if (
    source.endsWith("check failed") &&
    hasVisibleUpdateTarget(menuState) &&
    !activeForceAutoUpdateListener
  ) {
    notifyForceAutoUpdate({ kind: "error", message });
    sendManualCheckResult({ kind: "error", message });
    return;
  }
  if (menuState.kind === "update-downloaded" && readyUpdateVersion) {
    const failedReadyVersion = readyUpdateVersion;
    // macOS Squirrel 可能在 update-downloaded 后才发现包无法 stage。
    // 如果继续保留 ready 缓存，renderer 会一直展示“重启以更新”，再次点击只会调用一个已失败的安装上下文。
    clearReadyUpdateState();
    clearPersistedPostUpdateReleaseNotesForVersion(
      failedReadyVersion,
      `${source}-after-ready-error`,
    );
    logger.info(`[auto-update] cleared ready update after ${source} version=${failedReadyVersion}`);
  }
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  if (failedDownload?.version && !readyUpdateVersion && !activeForceAutoUpdateListener) {
    // 修复原因：用户点击“下载更新”后如果下载启动或 staging 很快失败，
    // 旧逻辑会清空 available/downloading 并广播 idle，renderer 入口和弹窗同时消失。
    // 失败并不等同于用户跳过该版本，应退回“发现更新”状态，让用户能看到并重试下载。
    availableUpdateReleaseNotes = failedDownload.releaseNotes;
    availableUpdateChannel = failedDownload.channel;
    setAutoUpdaterMenuState(
      buildUpdateAvailableState(
        failedDownload.version,
        failedDownload.releaseNotes,
        failedDownload.channel,
      ),
    );
  } else {
    setAutoUpdaterMenuState(
      readyUpdateVersion
        ? buildUpdateDownloadedState(readyUpdateVersion)
        : { kind: "idle", enabled: true },
    );
  }
  notifyForceAutoUpdate({ kind: "error", message });
  sendManualCheckResult({ kind: "error", message });
  // 下载失败也是一次下载结束，无论来自 Promise reject 还是 error 事件。
  // 没有强制更新在进行时立即复查，避免弱网失败期间错过更高版本。
  // 失败可能发生在启动检查的结果处理里，记下原因，等这次检查收口后再查。
  if (failedDownload && !activeForceAutoUpdateListener) {
    recheckAfterDownload?.("download-failed");
  }
  if (failedInstall) recoverFromFailedUpdateInstall();
}

async function isSkippedUpdateVersion(
  version: string,
  channel: ElectronReleaseChannel,
  settingService: SettingServiceLike | undefined,
): Promise<boolean> {
  if (!settingService || activeForceAutoUpdateListener) {
    return false;
  }

  // 用户手动检查更新代表重新关注被跳过的版本。
  // 即使持久化清理还没落盘，这一轮也不能继续把同版本更新当作 up-to-date 隐藏掉。
  if (manualCheckWebContentsId != null) {
    return false;
  }

  try {
    const settings = await settingService.get();
    return settings.skippedElectronUpdateVersions?.[channel]?.trim() === version.trim();
  } catch (error) {
    logger.warn("[auto-update] read skipped update version failed:", error);
    return false;
  }
}

async function shouldAutoDownloadAndInstallUpdates(
  settingService: SettingServiceLike | undefined,
): Promise<boolean> {
  if (!settingService) {
    return false;
  }

  try {
    return (await settingService.get()).autoDownloadAndInstallUpdates === true;
  } catch (error) {
    logger.warn("[auto-update] read auto download preference failed:", error);
    return false;
  }
}

export async function skipAvailableUpdateVersion(
  version: string,
  settingService: SettingServiceLike | undefined,
): Promise<void> {
  if (activeForceAutoUpdateListener) {
    logger.info(`[auto-update] ignore skip version=${version}: force update active`);
    return;
  }

  if (
    (menuState.kind !== "update-available" && menuState.kind !== "download-progress") ||
    menuState.version !== version
  ) {
    logger.info(`[auto-update] ignore skip version=${version}: state=${menuState.kind}`);
    return;
  }

  const channel =
    menuState.channel ??
    (menuState.kind === "download-progress" ? downloadingUpdateChannel : availableUpdateChannel) ??
    availableUpdateChannel;
  if (downloadCancellationToken) {
    markCancelledDownload(downloadCancellationToken);
    downloadCancellationToken.cancel();
    logger.info(
      `[auto-update] skipped downloading version; cancel active download channel=${channel} version=${version}`,
    );
  }

  // 下载态弹窗仍需要允许用户跳过当前版本。
  // 如果 main 只接受 update-available，UI 中点击“跳过此版本”会变成 no-op；
  // 这里在持久化跳过前取消当前下载，并清理下载态，避免后台继续拉取已跳过版本。
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  setAutoUpdaterMenuState(
    readyUpdateVersion
      ? buildUpdateDownloadedState(readyUpdateVersion)
      : { kind: "idle", enabled: true },
  );

  if (!settingService) {
    logger.warn(
      `[auto-update] skipped version not persisted because setting service is missing version=${version}`,
    );
    return;
  }

  try {
    const settings = await settingService.get();
    await settingService.update({
      skippedElectronUpdateVersions: {
        ...settings.skippedElectronUpdateVersions,
        [channel]: version,
      },
    });
    logger.info(`[auto-update] skipped version persisted channel=${channel} version=${version}`);
  } catch (error) {
    logger.error("[auto-update] persist skipped update version failed:", error);
  }
}

async function clearSkippedUpdateVersionForManualCheck(
  channel: ElectronReleaseChannel,
  settingService: SettingServiceLike | undefined,
): Promise<void> {
  if (!settingService) {
    return;
  }

  try {
    const settings = await settingService.get();
    const skippedVersions = settings.skippedElectronUpdateVersions;
    const skippedVersion = skippedVersions?.[channel]?.trim();
    if (!skippedVersion) {
      return;
    }

    const nextSkippedVersions = { ...skippedVersions };
    delete nextSkippedVersions[channel];
    await settingService.update({
      skippedElectronUpdateVersions: nextSkippedVersions,
    });
    logger.info(
      `[auto-update] manual check cleared skipped update channel=${channel} version=${skippedVersion}`,
    );
  } catch (error) {
    logger.warn("[auto-update] clear skipped update version failed:", error);
  }
}

function publishDownloadedUpdate(info: UpdateDownloadedInfoLike): void {
  readyUpdateVersion = info.version;
  readyUpdateRestoredFromPendingReleaseNotes = false;
  readyUpdateChannel = downloadingUpdateChannel ?? availableUpdateChannel;
  readyUpdateReleaseNotes = toPostUpdateReleaseNotesPayload(info) ?? downloadingUpdateReleaseNotes;
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  logger.info(`[auto-update] downloaded: ${info.version}, waiting for explicit install`);
  setAutoUpdaterMenuState(buildUpdateDownloadedState(info.version));
  notifyForceAutoUpdate({ kind: "ready", version: info.version });
  if (!activeForceAutoUpdateListener) {
    recheckAfterDownload?.("download-finished");
  }

  if (activeForceAutoUpdateListener) {
    notifyForceAutoUpdate({ kind: "installing" });
    void quitAndInstallUpdate();
  }

  if (autoUpdaterSettingService) {
    const releaseNotesPayload = readyUpdateReleaseNotes;
    const persistTask = releaseNotesPayload
      ? persistPendingPostUpdateReleaseNotes(
          autoUpdaterSettingService,
          releaseNotesPayload,
          "update-downloaded",
        )
      : clearPendingPostUpdateReleaseNotes(
          autoUpdaterSettingService,
          "update-downloaded-without-release-notes",
        );

    void persistTask.catch((error) => {
      logger.error("[auto-update] persist post-update release notes failed:", error);
    });
  }

  for (const win of BrowserWindow.getAllWindows()) {
    syncReadyUpdateToWindow(win);
  }
}

export function downloadAvailableUpdate(reason = "renderer") {
  if (isUpdateTargetLocked()) return;
  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info(`[auto-update] skip ${reason} download: not packaged`);
    return;
  }

  if (menuState.kind === "update-downloaded") {
    logger.info(`[auto-update] skip ${reason} download: update already ready`);
    return;
  }

  if (menuState.kind === "download-progress") {
    logger.info(`[auto-update] skip ${reason} download: download already in progress`);
    return;
  }

  if (downloadCancellationToken) {
    logger.info(`[auto-update] skip ${reason} download: download already requested`);
    return;
  }

  if (menuState.kind !== "update-available") {
    logger.info(`[auto-update] skip ${reason} download: state=${menuState.kind}`);
    return;
  }

  downloadingUpdateVersion = menuState.version;
  downloadingUpdateReleaseNotes = menuState.releaseNotes ?? availableUpdateReleaseNotes;
  downloadingUpdateChannel = menuState.channel ?? availableUpdateChannel;
  // electron-updater 如果命中本地已下载缓存，会在 downloadUpdate() 内直接触发
  // update-downloaded。这里不能先广播 0% 下载态，否则用户会先看到“下载中”，
  // 再跳到“已下载”；真实下载态改由第一条 download-progress 事件驱动。
  notifyForceAutoUpdate({
    kind: "downloading",
    version: downloadingUpdateVersion,
    progress: "0",
  });

  const cancellationToken = new CancellationToken();
  downloadCancellationToken = cancellationToken;
  pendingDownloadedUpdate = null;
  autoUpdater
    .downloadUpdate(cancellationToken)
    .then(() => {
      if (downloadCancellationToken !== cancellationToken) return;
      const downloaded = pendingDownloadedUpdate;
      pendingDownloadedUpdate = null;
      downloadCancellationToken = null;
      if (
        downloaded?.token === cancellationToken &&
        !cancellationToken.cancelled &&
        !isUpdateTargetLocked()
      ) {
        publishDownloadedUpdate(downloaded.info);
      }
    })
    .catch((error) => {
      if (isCancelledDownload(cancellationToken, error)) {
        logger.info(`[auto-update] ${reason} download cancelled`);
        return;
      }
      // 下载由用户点击或强更 gate 显式触发，Promise reject 也必须立即反馈。
      // 不能只依赖 electron-updater 后续是否额外触发 error 事件，否则 UI 会卡在下载态。
      handleAutoUpdateFailure(error, "download update failed");
    })
    .finally(() => {
      if (downloadCancellationToken === cancellationToken) {
        downloadCancellationToken = null;
        pendingDownloadedUpdate = null;
      }
      cancellationToken.dispose();
    });
}

export function cancelDownloadingUpdate(reason = "renderer") {
  if (activeForceAutoUpdateListener) {
    logger.info(`[auto-update] skip ${reason} cancel download: force update active`);
    return;
  }

  if (menuState.kind !== "download-progress" || !downloadCancellationToken) {
    logger.info(`[auto-update] skip ${reason} cancel download: state=${menuState.kind}`);
    return;
  }

  const version = downloadingUpdateVersion;
  const releaseNotes = downloadingUpdateReleaseNotes;
  const channel = downloadingUpdateChannel ?? availableUpdateChannel;
  const cancellationToken = downloadCancellationToken;
  markCancelledDownload(cancellationToken);
  cancellationToken.cancel();
  logger.info(
    `[auto-update] ${reason}: cancel download channel=${channel} version=${version ?? "unknown"}`,
  );

  // 取消下载不是跳过版本，只回退到发现更新状态，保留同一份 manifest 信息让用户可以稍后重试。
  clearDownloadingUpdateState();
  if (version) {
    availableUpdateReleaseNotes = releaseNotes;
    availableUpdateChannel = channel;
    setAutoUpdaterMenuState(buildUpdateAvailableState(version, releaseNotes, channel));
    recheckAfterDownload?.("download-finished");
    return;
  }

  setAutoUpdaterMenuState(
    readyUpdateVersion
      ? buildUpdateDownloadedState(readyUpdateVersion)
      : { kind: "idle", enabled: true },
  );
}

export function setAutoUpdaterMenuLocale(locale: Locale) {
  menuLocale = locale;

  // 检查更新菜单项会被 updater 的异步状态流反复改写。
  // 如果只在创建菜单时翻译一次，后续 checking/downloading 阶段又会退回英文。
  // 这里把 locale 和当前 updater 状态一起保存，确保每次重建菜单或切语言后都能按最新状态重新渲染。
  syncMenuItemState();
}

export async function hydratePendingPostUpdateReleaseNotes(settingService: SettingServiceLike) {
  const settings = await settingService.get();
  pendingPostUpdateReleaseNotes = settings.pendingPostUpdateReleaseNotes ?? null;
  deliveredPostUpdateReleaseNotesWebContentsId = null;

  if (pendingPostUpdateReleaseNotes) {
    logger.info(
      `[auto-update] hydrated pending post-update release notes version=${pendingPostUpdateReleaseNotes.version}`,
    );
  }

  if (
    pendingPostUpdateReleaseNotes &&
    shouldDiscardStalePendingReleaseNotes(
      pendingPostUpdateReleaseNotes.version,
      getCurrentAppVersionForUpdate(),
    )
  ) {
    logger.info(
      `[auto-update] discard stale post-update release notes pending=${pendingPostUpdateReleaseNotes.version} app=${getCurrentAppVersionForUpdate()}`,
    );
    await clearPendingPostUpdateReleaseNotes(
      settingService,
      "hydrate-pending-older-than-installed-app",
    );
  }

  if (
    pendingPostUpdateReleaseNotes &&
    isPendingReleaseNotesForFutureVersion(pendingPostUpdateReleaseNotes)
  ) {
    // 用户下载完成但尚未安装时重启应用，electron-updater 的内存 ready 状态会丢失，
    // 但本地 pending 包和版本说明仍在。这里用“pending 版本高于当前版本”恢复待安装状态，
    // 避免已有缓存时仍提示“下载更新”，点击后又被 dev staging 错误打回 idle。
    readyUpdateVersion = pendingPostUpdateReleaseNotes.version;
    readyUpdateReleaseNotes = pendingPostUpdateReleaseNotes;
    readyUpdateRestoredFromPendingReleaseNotes = true;
    setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
    logger.info(
      `[auto-update] restored ready update from pending release notes version=${readyUpdateVersion}`,
    );
  }
}

export function syncReadyUpdateToWindow(win: BrowserWindow) {
  if (!readyUpdateVersion || win.isDestroyed()) {
    return;
  }

  // update-downloaded 可能发生在 renderer React effect 还没挂好之前，
  // 甚至发生在窗口 reload / 新开窗口之前。这里把“已有可安装更新”视为一份持久状态，
  // 在窗口后续就绪时补发一次，避免按钮只靠那次瞬时事件而丢失。
  logger.info(
    `[auto-update] sync ready update to window ${win.webContents.id}: ${readyUpdateVersion}`,
  );
  win.webContents.send(PlatformChannels.UpdateReady, readyUpdateVersion);
}

export function getAutoUpdaterState(): UpdateStatePayload {
  return menuState;
}

export function refreshAutoUpdaterReleaseChannel(
  receivePreviewUpdates: boolean,
  reason = "settings receivePreviewUpdates changed",
) {
  if (quitAndInstallState !== "idle") return;
  const nextChannel: ElectronReleaseChannel = receivePreviewUpdates ? "preview" : "stable";

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info(`[auto-update] skip ${reason}: not packaged`);
    return;
  }

  if (menuState.kind === "download-progress" || menuState.kind === "update-downloaded") {
    logger.info(`[auto-update] skip ${reason}: state=${menuState.kind} channel=${nextChannel}`);
    return;
  }

  if (checkForUpdatesInFlight) {
    // 用户可能在启动检查尚未完成时切换 preview 开关。
    // 不能立刻改 availableUpdateChannel，否则旧请求返回时会把旧通道的版本标成新通道；
    // 这里只记录待刷新通道，等当前 check 收口后再重新请求 manifest。
    pendingManifestReleaseChannelRefresh = nextChannel;
    logger.info(
      `[auto-update] defer ${reason}: check already in flight, next channel=${nextChannel}`,
    );
    return;
  }

  const currentChannel = getAutoUpdaterReleaseChannelForCurrentState();
  if (currentChannel === nextChannel) {
    logger.info(`[auto-update] skip ${reason}: channel unchanged (${nextChannel})`);
    return;
  }

  logger.info(
    `[auto-update] ${reason}: refresh manifest channel ${currentChannel} -> ${nextChannel}`,
  );
  availableUpdateChannel = nextChannel;
  clearAvailableUpdateState();
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  const checkId = beginAutoUpdateCheck();
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      if (isUpdateTargetLocked()) return;
      logger.error(`[auto-update] ${reason} check failed:`, err);
      setAutoUpdaterMenuState(
        readyUpdateVersion
          ? buildUpdateDownloadedState(readyUpdateVersion)
          : { kind: "idle", enabled: true },
      );
    })
    .finally(() => {
      finishAutoUpdateCheck(reason, checkId);
    });
}

export function syncAutoUpdaterStateToWindow(win: BrowserWindow) {
  if (win.isDestroyed()) {
    return;
  }

  win.webContents.send(PlatformChannels.UpdateStateChanged, menuState);
}

export function syncPostUpdateReleaseNotesToWindow(win: BrowserWindow) {
  if (!pendingPostUpdateReleaseNotes || win.isDestroyed()) {
    return;
  }

  if (isPendingReleaseNotesForFutureVersion(pendingPostUpdateReleaseNotes)) {
    // pending release notes 是下载完成时写入的；若版本仍高于当前 app，
    // 说明更新尚未安装，不能提前作为“安装后说明”发给 renderer 静默 ack。
    return;
  }

  const assignedWindow = findLiveWindowByWebContentsId(
    deliveredPostUpdateReleaseNotesWebContentsId,
  );
  if (assignedWindow && assignedWindow.webContents.id !== win.webContents.id) {
    return;
  }

  deliveredPostUpdateReleaseNotesWebContentsId = win.webContents.id;
  logger.info(
    `[auto-update] sync post-update release notes to window ${win.webContents.id}: ${pendingPostUpdateReleaseNotes.version}`,
  );
  win.webContents.send(PlatformChannels.PostUpdateReleaseNotes, pendingPostUpdateReleaseNotes);
}

export async function acknowledgePostUpdateReleaseNotes(
  version: string,
  settingService: SettingServiceLike,
) {
  if (!pendingPostUpdateReleaseNotes) {
    logger.info(
      `[auto-update] ignore release notes ack without pending payload version=${version}`,
    );
    return;
  }

  if (pendingPostUpdateReleaseNotes.version !== version) {
    logger.warn(
      `[auto-update] ignore release notes ack version mismatch expected=${pendingPostUpdateReleaseNotes.version} actual=${version}`,
    );
    return;
  }

  acknowledgedPostUpdateReleaseNotesVersions.add(version);
  await clearPendingPostUpdateReleaseNotes(settingService, "renderer-acknowledged");
}

export async function initAutoUpdater(options: InitAutoUpdaterOptions = {}): Promise<void> {
  if (options.enabled === false) {
    autoUpdaterDisabledForProductFlavor = true;
    if (autoUpdatePollTimer) {
      clearInterval(autoUpdatePollTimer);
      autoUpdatePollTimer = null;
    }
    logger.info("[auto-update] disabled for this desktop product flavor");
    return;
  }
  autoUpdaterDisabledForProductFlavor = false;
  if (!canUseAutoUpdaterInCurrentRuntime()) return;

  onBeforeQuitAndInstall = options.onBeforeQuitAndInstall;
  if (options.locale) {
    menuLocale = options.locale;
  }
  autoUpdaterSettingService = options.settingService;

  if (autoUpdatePollTimer) {
    clearInterval(autoUpdatePollTimer);
    autoUpdatePollTimer = null;
  }
  checkForUpdatesInFlight = false;
  activeAutoUpdateCheckId = null;
  activeAutoUpdateCheckChannel = null;
  settlingAutoUpdateCheckId = null;
  pendingManifestReleaseChannelRefresh = null;
  devAutoUpdateVersionOverride = null;
  availableUpdateChannel = "stable";
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  applyDevAutoUpdateRuntimeOverrides();

  logger.info(`[auto-update] initializing, current version: ${getCurrentAppVersionForUpdate()}`);

  // 已下载旧版本后，feed 继续推进到更高版本时，主进程必须先比较远端版本和 ready 版本，
  // 再决定是否下载。若继续让 electron-updater 自动下载，它只会按当前 app 版本判断，
  // 导致 `3.1.2` 已 ready `3.1.3` 时每次轮询都可能重复下载 `3.1.3`。
  autoUpdater.autoDownload = false;
  // 普通退出不代表用户确认安装。此前 macOS/Linux 在 before-quit 主动安装，
  // 与失败后的 relaunch 组合后，会让有 pending 包的进程每次退出都重新安装、重启。
  // 所有平台只允许显式安装入口接管，避免退出循环及关机期间的半更新。
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = logger;
  if (autoUpdater instanceof pkg.NsisUpdater) {
    // 保留包内 publisherName 来激活 NSIS hook，但不把旧 DN 当作未来换证的准入条件。
    autoUpdater.verifyUpdateCodeSignature = (_publisherNames, filePath) =>
      verifyWindowsAuthenticodeSignature(filePath);
  }
  applyManifestUpdateProvider(options);

  const triggerCheckForUpdates = (reason: string) => {
    if (quitAndInstallState !== "idle") return;
    if (checkForUpdatesInFlight) {
      logger.info(`[auto-update] skip ${reason}: check already in flight`);
      return;
    }

    // 已展示的目标不能被一次复查盖成 checking。下载中也不另起检查，等这次下载结束后再查。
    if (reason === "poll" && !canPollForUpdatesFromState(menuState)) {
      logger.info(`[auto-update] skip ${reason}: state=${menuState.kind}`);
      return;
    }

    const checkId = beginAutoUpdateCheck();
    const checkForUpdatesPromise = options.settingService
      ? (async () => {
          await syncAutoUpdateCheckChannelFromSettings(checkId, options.settingService, reason);
          if (isUpdateTargetLocked()) return;
          await autoUpdater.checkForUpdates();
        })()
      : autoUpdater.checkForUpdates();

    checkForUpdatesPromise
      .catch((err) => {
        // 强更弹窗可能复用启动期后台检查；如果 checkForUpdates 直接 reject 且没有后续 error 事件，
        // 只写日志会让弹窗停在 checking。这里复用失败收敛逻辑，把状态恢复并反馈给强更监听。
        handleAutoUpdateFailure(err, `${reason} check failed`);
      })
      .finally(() => {
        finishAutoUpdateCheck(reason, checkId);
        ensureAutoUpdatePollInterval();
      });
  };
  recheckAfterDownload = (recheckReason: string) => {
    // 下载失败需要等当前检查收口。完成和取消的结果已经被这次检查覆盖，不再排队。
    if (checkForUpdatesInFlight) {
      if (recheckReason === "download-failed") {
        pendingFailedDownloadRecheck = true;
      }
      return;
    }
    triggerCheckForUpdates(recheckReason);
  };

  autoUpdater.on("checking-for-update", () => {
    if (isUpdateTargetLocked()) return;
    logger.info("[auto-update] checking for update...");
    if (hasVisibleUpdateTarget(menuState) || menuState.kind === "download-progress") {
      return;
    }
    setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  });

  autoUpdater.on("update-available", (info: UpdateDownloadedInfoLike) => {
    if (isUpdateTargetLocked()) return;
    logger.info(`[auto-update] new version available: ${info.version}`);
    const infoChannel = readUpdateInfoReleaseChannel(info);
    if (shouldIgnoreStaleAvailableUpdate(infoChannel)) {
      // 用户切换“接收 preview 版本”时，旧通道的 manifest 请求可能晚于新请求返回。
      // 旧结果如果继续写 menuState，或提前结束当前 generation，会让独立更新弹窗继续显示旧版本/旧 release notes。
      logger.info(
        `[auto-update] ignore stale update channel=${infoChannel} expected=${activeAutoUpdateCheckChannel ?? availableUpdateChannel} version=${info.version}`,
      );
      return;
    }

    void settleAutoUpdateCheckResult("update available", async () => {
      if (!shouldDownloadAvailableUpdate(info.version)) {
        const readyVersion = readyUpdateVersion ?? info.version;
        logger.info(
          `[auto-update] keep downloaded update version=${readyVersion}; remote=${info.version}`,
        );
        setAutoUpdaterMenuState(buildUpdateDownloadedState(readyVersion));
        sendManualCheckResult({ kind: "ready", version: readyVersion });
        return;
      }

      const channel = infoChannel ?? availableUpdateChannel;
      const skipped = await isSkippedUpdateVersion(info.version, channel, options.settingService);
      if (isUpdateTargetLocked()) return;
      if (skipped) {
        logger.info(
          `[auto-update] ignore skipped update channel=${channel} version=${info.version}`,
        );
        clearAvailableUpdateState();
        setAutoUpdaterMenuState({ kind: "idle", enabled: true });
        sendManualCheckResult({
          kind: "up-to-date",
          currentVersion: getCurrentAppVersionForUpdate(),
        });
        return;
      }

      availableUpdateReleaseNotes = toPostUpdateReleaseNotesPayload(info);
      if (readyUpdateRestoredFromPendingReleaseNotes) {
        // pendingPostUpdateReleaseNotes 只能证明“曾经下载完成并持久化了版本说明”，
        // 不能恢复当前进程里的 electron-updater downloadedUpdateHelper、Squirrel.Mac proxy server
        // 或 native staged update。遇到 manifest 再次确认同版本可用时必须清掉伪 ready，
        // 重新 downloadUpdate，让缓存命中/重新下载后的 update-downloaded 建立真实安装上下文。
        clearReadyUpdateState();
      }
      setAutoUpdaterMenuState(
        buildUpdateAvailableState(info.version, availableUpdateReleaseNotes, channel),
      );

      if (activeForceAutoUpdateListener) {
        downloadAvailableUpdate("force-update");
        return;
      }

      const autoDownload = await shouldAutoDownloadAndInstallUpdates(options.settingService);
      if (isUpdateTargetLocked()) return;
      if (autoDownload) {
        // 功能原因：自动下载偏好属于 main 进程更新状态机，不能依赖 renderer 弹窗是否打开。
        // 检测到更新后复用手动下载入口，保持取消、缓存命中、失败恢复等行为完全一致。
        downloadAvailableUpdate("auto-download");
        return;
      }

      sendManualCheckResult({
        kind: "available",
        version: info.version,
        channel,
        ...(availableUpdateReleaseNotes ? { releaseNotes: availableUpdateReleaseNotes } : {}),
      });
    }).catch((error) => {
      handleAutoUpdateFailure(error, "update available failed");
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    if (isUpdateTargetLocked()) return;
    void settleAutoUpdateCheckResult("update not available", () => {
      logger.info(
        `[auto-update] already up to date (local=${getCurrentAppVersionForUpdate()}, remote=${info.version})`,
      );
      if (readyUpdateVersion && isReadyUpdateCurrentTarget()) {
        setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
        sendManualCheckResult({ kind: "ready", version: readyUpdateVersion });
        return;
      }
      if (hasVisibleUpdateTarget(menuState)) {
        sendManualCheckResult({
          kind: "available",
          version:
            menuState.kind === "update-available" ? menuState.version : (readyUpdateVersion ?? ""),
          ...("channel" in menuState && menuState.channel ? { channel: menuState.channel } : {}),
        });
        return;
      }

      clearAvailableUpdateState();
      clearDownloadingUpdateState();
      setAutoUpdaterMenuState({ kind: "idle", enabled: true });
      // 强制升级弹窗复用启动期检查时，也必须在无可用更新时给出闭环反馈，避免一直停在 checking。
      notifyForceAutoUpdate({
        kind: "error",
        message: getForceAutoUpdateNoUpdateMessage(),
      });
      sendManualCheckResult({
        kind: "up-to-date",
        currentVersion: getCurrentAppVersionForUpdate(),
      });
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    if (isUpdateTargetLocked()) return;
    // 用户快速取消下载后，electron-updater 可能还会补发旧下载流的 progress。
    // 如果继续接收这个陈旧事件，UI 会从“可更新”被重新推回“下载中”，看起来像取消后卡住。
    if (!downloadCancellationToken || downloadCancellationToken.cancelled) {
      return;
    }

    if (menuState.kind !== "download-progress" && menuState.kind !== "update-available") {
      return;
    }

    const normalizedProgress = normalizeProgressPercent(progress) ?? progress.percent.toFixed(0);
    logger.info(
      `[auto-update] download progress: ${progress.percent.toFixed(1)}% (${(progress.bytesPerSecond / 1024).toFixed(0)} KB/s, ${(progress.transferred / 1024 / 1024).toFixed(1)}/${(progress.total / 1024 / 1024).toFixed(1)} MB)`,
    );
    if (menuState.kind === "update-available") {
      clearAvailableUpdateState();
    }
    setAutoUpdaterMenuState(
      buildDownloadProgressState(normalizedProgress, {
        transferredBytes: progress.transferred,
        totalBytes: progress.total,
      }),
    );
    logForceAutoUpdateProgress(normalizedProgress);
    notifyForceAutoUpdate({
      kind: "downloading",
      ...(downloadingUpdateVersion ? { version: downloadingUpdateVersion } : {}),
      progress: normalizedProgress,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateDownloadedInfoLike) => {
    if (isUpdateTargetLocked()) return;
    if (downloadCancellationToken) {
      // updater 会在 downloadUpdate Promise 收口前同步发 ready；缓存写入仍可能失败并清包。
      // 以下载成功为唯一发布点，避免安装依赖无完成保证的在途下载，也避免失败包被提前安装。
      if (!downloadCancellationToken.cancelled) {
        pendingDownloadedUpdate = { token: downloadCancellationToken, info };
      }
      return;
    }
    publishDownloadedUpdate(info);
  });

  autoUpdater.on("error", (err, detail: unknown) => {
    // 锁定依赖中 checkForUpdates 会携带这个来源，Mac 原生错误仅传 Error。
    // 已接受的检查可以迟到失败，不能把它误判成正在安装的原生包失败。
    if (typeof detail === "string" && detail.startsWith("Cannot check for updates:")) {
      handleAutoUpdateFailure(err, "background check failed");
      return;
    }
    if (shouldIgnoreCancelledDownloadError(err)) {
      // electron-updater 在取消下载后可能异步补发 error("cancelled")。
      // 用户取消已经把状态恢复到可重试的 update-available，迟到取消事件不能再清空入口。
      logger.info("[auto-update] ignore delayed error from cancelled download");
      return;
    }

    void settleAutoUpdateCheckResult("error", () => {
      handleAutoUpdateFailure(err, "error");
    });
  });

  ipcMain.handle(PlatformChannels.QuitAndInstallUpdate, () =>
    // renderer 只有在 IPC reject 时才知道安装器没有接管。ready 失效或
    // 退出准备失败不能返回成功 ACK，否则“重启以更新”会永久保持 pending。
    quitAndInstallUpdate(true),
  );
  ipcMain.on(PlatformChannels.QuitAndInstallUpdate, () => {
    void quitAndInstallUpdate();
  });
  ipcMain.handle(PlatformChannels.DownloadUpdate, () => {
    downloadAvailableUpdate("renderer");
  });
  ipcMain.handle(PlatformChannels.CancelUpdateDownload, () => {
    cancelDownloadingUpdate("renderer");
  });
  ipcMain.handle(PlatformChannels.SkipUpdateVersion, async (_event, version: unknown) => {
    const validatedVersion = typeof version === "string" ? version.trim() : "";
    if (!validatedVersion) {
      logger.warn("[auto-update] ignore empty skipped update version");
      return;
    }
    await skipAvailableUpdateVersion(validatedVersion, options.settingService);
  });

  triggerCheckForUpdates("startup");
  ensureAutoUpdatePollInterval();
}

function ensureAutoUpdatePollInterval() {
  if (menuState.kind === "download-progress") {
    if (autoUpdatePollTimer) {
      clearInterval(autoUpdatePollTimer);
      autoUpdatePollTimer = null;
      autoUpdatePollIntervalMs = null;
    }
    return;
  }
  const nextInterval = resolveAutoUpdatePollInterval(menuState);
  if (autoUpdatePollTimer && autoUpdatePollIntervalMs === nextInterval) {
    return;
  }
  if (autoUpdatePollTimer) {
    clearInterval(autoUpdatePollTimer);
  }
  autoUpdatePollIntervalMs = nextInterval;
  autoUpdatePollTimer = setInterval(() => {
    recheckAfterDownload?.("poll");
  }, nextInterval);
  autoUpdatePollTimer.unref?.();
}

export function requestForceAutoUpdate(
  onStateChange: (state: ForceAutoUpdateState) => void,
  reason = "force-update",
  _minimumVersion?: string,
) {
  const dispose = () => {
    if (activeForceAutoUpdateListener === onStateChange) {
      activeForceAutoUpdateListener = null;
    }
  };

  activeForceAutoUpdateListener = onStateChange;
  forceAutoUpdateLastLoggedProgressBucket = null;
  logger.info(`[force-update] 自动升级开始 reason=${reason}`);
  if (quitAndInstallState !== "idle") {
    onStateChange({ kind: "installing" });
    return dispose;
  }
  onStateChange({ kind: "checking" });

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    const message = "not packaged";
    logger.info(`[force-update] 自动升级跳过：${message}`);
    onStateChange({ kind: "dev-skipped", message });
    return dispose;
  }

  if (menuState.kind === "update-downloaded") {
    onStateChange({ kind: "installing" });
    void quitAndInstallUpdate();
    return dispose;
  }

  if (menuState.kind === "update-available") {
    downloadAvailableUpdate("force-update");
    return dispose;
  }

  if (menuState.kind === "download-progress") {
    onStateChange({
      kind: "downloading",
      ...("version" in menuState && menuState.version ? { version: menuState.version } : {}),
      progress: menuState.progress,
    });
    return dispose;
  }

  if (checkForUpdatesInFlight) {
    logger.info(`[force-update] 自动升级复用进行中的更新检查`);
    return dispose;
  }

  const checkId = beginAutoUpdateCheck();
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      if (isUpdateTargetLocked()) return;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[auto-update] ${reason} check failed:`, err);
      setAutoUpdaterMenuState(
        readyUpdateVersion
          ? buildUpdateDownloadedState(readyUpdateVersion)
          : { kind: "idle", enabled: true },
      );
      onStateChange({ kind: "error", message });
    })
    .finally(() => {
      finishAutoUpdateCheck(reason, checkId);
    });

  return () => {
    if (activeForceAutoUpdateListener === onStateChange) {
      activeForceAutoUpdateListener = null;
    }
  };
}

export function requestAutoUpdateCheckWithoutWindow(reason = "force-update") {
  if (quitAndInstallState !== "idle") return;
  logger.info(`[auto-update] ${reason}: user requested update check without renderer window`);

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info(`[auto-update] skip ${reason}: not packaged`);
    return;
  }

  if (menuState.kind === "update-downloaded") {
    void quitAndInstallUpdate();
    return;
  }
  if (menuState.kind === "update-available") {
    downloadAvailableUpdate(reason);
    return;
  }
  if (menuState.kind === "download-progress") {
    logger.info(`[auto-update] skip ${reason}: update already ${menuState.kind}`);
    return;
  }
  if (checkForUpdatesInFlight) {
    logger.info(`[auto-update] skip ${reason}: check already in flight`);
    return;
  }

  const checkId = beginAutoUpdateCheck();
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      if (isUpdateTargetLocked()) return;
      logger.error(`[auto-update] ${reason} check failed:`, err);
      setAutoUpdaterMenuState(
        readyUpdateVersion
          ? buildUpdateDownloadedState(readyUpdateVersion)
          : { kind: "idle", enabled: true },
      );
    })
    .finally(() => {
      finishAutoUpdateCheck(reason, checkId);
    });
}

export function checkForUpdateMenuClick(originWindow?: BrowserWindow | null) {
  if (quitAndInstallState !== "idle") return;
  logger.info("[auto-update] user clicked Check for Updates");

  const targetWindow =
    originWindow && !originWindow.isDestroyed()
      ? originWindow
      : (BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
        null);

  if (!targetWindow) {
    logger.warn("[auto-update] manual check: no target window to report to");
    return;
  }

  if (!canUseAutoUpdaterInCurrentRuntime()) {
    logger.info("[auto-update] skip manual check: not packaged");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "dev-skipped",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  if (autoUpdaterDisabledForProductFlavor) {
    // 入口本应已按产品身份隐藏；这里是最后一道闸，不让未初始化的 updater 实例向占位 feed 发请求。
    logger.info("[auto-update] skip manual check: updater disabled for this product flavor");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "dev-skipped",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  if (menuState.kind === "update-downloaded" && isReadyUpdateCurrentTarget()) {
    // 菜单文案已经是“重启以更新”。只有 ready 包仍等于当前目标时才安装；
    // 目标已经更高时落到下面的重新检查，避免装上旧包。
    void quitAndInstallUpdate();
    return;
  }
  if (menuState.kind === "download-progress") {
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "already-downloading",
      version: downloadingUpdateVersion ?? readyUpdateVersion ?? "",
      progress: menuState.progress,
    } satisfies UpdateCheckResultPayload);
    return;
  }
  if (checkForUpdatesInFlight) {
    logger.info("[auto-update] skip manual check: check already in flight");
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      kind: "error",
      message: "Update check already in progress.",
    } satisfies UpdateCheckResultPayload);
    return;
  }

  manualCheckWebContentsId = targetWindow.webContents.id;
  const manualCheckChannel = getAutoUpdaterReleaseChannelForCurrentState();
  // 已发现的版本继续显示，检查结果回来后再替换，避免菜单先闪成“正在检查”。
  if (!hasVisibleUpdateTarget(menuState)) {
    setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  }
  const checkId = beginAutoUpdateCheck();
  (async () => {
    await clearSkippedUpdateVersionForManualCheck(manualCheckChannel, autoUpdaterSettingService);
    if (isUpdateTargetLocked()) return;
    await autoUpdater.checkForUpdates();
  })()
    .catch((err) => {
      if (isUpdateTargetLocked()) return;
      logger.error("[auto-update] manual check failed:", err);
      sendManualCheckResult({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      finishAutoUpdateCheck("manual check", checkId);
    });
}
