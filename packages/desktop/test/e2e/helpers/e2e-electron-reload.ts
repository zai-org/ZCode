import {
  bindPrelaunchedElectronSession,
  restartPrelaunchedElectronAfterExit,
} from "#e2e/helpers/e2e-prelaunched-electron";
import { execFileSync } from "node:child_process";

import { buildWindowsTaskkillArgs, listE2EProcessTreePids } from "./e2e-process-cleanup.js";
import { reloadE2EElectronServiceBridge } from "./e2e-electron-service-lifecycle.js";

export interface E2EElectronProcessExitOptions {
  afterElectronProcessExit?: () => Promise<void> | void;
  cleanupTimedOutProcessTreePids?: (pids: number[]) => Promise<void> | void;
  collectProcessTreePids?: (rootPids?: number[]) => number[];
  delay?: (ms: number) => Promise<void>;
  forceKillGraceMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
  pollIntervalMs?: number;
  reloadElectronServiceBridge?: (browser: WebdriverIO.Browser) => Promise<void>;
  timeoutMs?: number;
}

const DEFAULT_ELECTRON_EXIT_TIMEOUT_MS = 15_000;
const DEFAULT_ELECTRON_EXIT_POLL_INTERVAL_MS = 100;
const DEFAULT_ELECTRON_FORCE_KILL_GRACE_MS = 3_000;

interface PendingElectronExitBarrier {
  consumed: boolean;
  error: unknown;
  wait: () => Promise<void>;
}

const browsersWithDeleteBarrier = new WeakSet<WebdriverIO.Browser>();
const pendingExitBarrierByBrowser = new WeakMap<WebdriverIO.Browser, PendingElectronExitBarrier>();

export async function reloadElectronSessionSafely(
  browser: WebdriverIO.Browser,
  options: E2EElectronProcessExitOptions = {},
) {
  const oldElectronPid = await browser.electron.execute(async (electron) => {
    // Bug 原因：WebDriver 会先关闭窗口再结束旧 Electron；若 DOM Storage 尚未刷盘，
    // 同一 userData 重启也会得到空 localStorage。先显式刷新，才能让“保留 Profile”
    // 的冷恢复用例观察到与真实正常退出一致的持久化结果。
    await electron.session.defaultSession.flushStorageData();
    const appPid = process.pid;
    let quitRequested = false;
    const requestQuit = () => {
      if (quitRequested) return;
      quitRequested = true;
      electron.app.quit();
    };
    const appWindows = electron.BrowserWindow.getAllWindows();
    for (const appWindow of appWindows) {
      appWindow.once("closed", requestQuit);
    }
    if (appWindows.length === 0) {
      setTimeout(requestQuit, 0);
    }
    return appPid;
  });
  const collectProcessTreePids = options.collectProcessTreePids ?? collectCurrentE2EProcessTreePids;
  const oldElectronProcessTreePids = normalizeProcessPids(collectProcessTreePids([oldElectronPid]));
  if (!oldElectronProcessTreePids.includes(oldElectronPid)) {
    throw new Error(
      `Electron reload 旧进程树未包含 main pid: pid=${oldElectronPid}, tree=${oldElectronProcessTreePids.join(",") || "empty"}`,
    );
  }

  // Bug 根因：只等待 main PID 会遗漏 renderer/GPU/utility 与派生 host/agent；必须在
  // deleteSession 前按 runId/HOME 捕获完整进程树，并在新 session 创建前确认同一身份归零。
  // deleteSession 默认会连 ChromeDriver 一起关闭；显式 shutdownDriver=false 才能保留
  // driver，并让屏障失败直接阻止后续 reloadSession，而不是被 WDIO 吞错后仍创建新 session。
  ensureDeleteSessionExitBarrier(browser);
  const pendingBarrier: PendingElectronExitBarrier = {
    consumed: false,
    error: null,
    wait: () =>
      waitForElectronProcessExit(oldElectronProcessTreePids, {
        ...options,
        collectProcessTreePids,
      }),
  };
  pendingExitBarrierByBrowser.set(browser, pendingBarrier);

  try {
    try {
      await browser.deleteSession({ shutdownDriver: false });
    } catch (error) {
      if (pendingBarrier.error) {
        throw createExitBarrierError(pendingBarrier.error);
      }
      throw error;
    }
    if (!pendingBarrier.consumed) {
      throw new Error("Electron reload 未经过旧进程退出屏障");
    }
    if (pendingBarrier.error) {
      throw createExitBarrierError(pendingBarrier.error);
    }

    // Bug 根因：运行中的 Host 会异步刷新并写回 provider/config 数据；测试若在旧进程
    // 存活时 direct seed，同一个隔离 HOME 仍会被旧快照覆盖。只有退出屏障完成后、
    // 新进程启动前才是无并发 writer 的确定性窗口。
    await options.afterElectronProcessExit?.();
    // 独立启动模式的App由runner复用同一调试地址重启；普通候选这里是no-op。
    await restartPrelaunchedElectronAfterExit(browser);

    // reloadSession 会再次删除已经关闭的旧协议 session，并吞掉 invalid-session 错误；
    // ChromeDriver 仍存活，因此随后只创建新协议 session，不会越过上面的进程树屏障。
    const newSessionId = await browser.reloadSession();
    // Bug 根因：新 WebDriver session 建立后 Electron service.before 不会自动重跑；
    // helper 必须等新 main process 的 CDP bridge 重建并通过 probe，才能向调用方返回。
    await (options.reloadElectronServiceBridge ?? reloadE2EElectronServiceBridge)(browser);
    await bindPrelaunchedElectronSession(browser);
    return newSessionId;
  } finally {
    pendingExitBarrierByBrowser.delete(browser);
  }
}

function createExitBarrierError(cause: unknown) {
  // Bug 原因：WDIO 报告只序列化顶层 message/stack，单独设置 cause 会丢失残留 PID。
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`Electron reload 旧进程退出屏障失败: ${detail}`, { cause });
}

/** 完整重启 Electron，同时显式复用同一 userData，避免空 profile 掩盖恢复行为。 */
export async function reloadElectronSessionPreservingBrowserProfile(
  browser: WebdriverIO.Browser,
  options: E2EElectronProcessExitOptions = {},
): Promise<string> {
  const userDataDir = (await browser.electron.execute((electron) =>
    electron.app.getPath("userData"),
  )) as string;
  const requestedCapabilities = browser.requestedCapabilities as WebdriverIO.Capabilities & {
    "goog:chromeOptions"?: { args?: string[] };
  };
  const chromeOptions = requestedCapabilities["goog:chromeOptions"] ?? {};
  requestedCapabilities["goog:chromeOptions"] = {
    ...chromeOptions,
    args: [
      ...(chromeOptions.args ?? []).filter((arg) => !arg.startsWith("--user-data-dir=")),
      `--user-data-dir=${userDataDir}`,
    ],
  };
  await reloadElectronSessionSafely(browser, options);
  return (await browser.electron.execute((electron) => electron.app.getPath("userData"))) as string;
}

function ensureDeleteSessionExitBarrier(browser: WebdriverIO.Browser) {
  if (browsersWithDeleteBarrier.has(browser)) return;

  const overwriteDeleteSession = async function (
    this: WebdriverIO.Browser,
    originalDeleteSession: (...deleteArgs: unknown[]) => Promise<unknown>,
    ...args: unknown[]
  ) {
    const pendingBarrier = pendingExitBarrierByBrowser.get(this);
    let deleteFailed = false;
    let deleteError: unknown = null;
    let deleteResult: unknown = null;
    try {
      deleteResult = await originalDeleteSession(...args);
    } catch (error) {
      deleteFailed = true;
      deleteError = error;
    }
    if (pendingBarrier) {
      pendingExitBarrierByBrowser.delete(this);
      pendingBarrier.consumed = true;
      try {
        await pendingBarrier.wait();
      } catch (error) {
        pendingBarrier.error = error;
        throw error;
      }
    }
    if (deleteFailed) throw deleteError;
    return deleteResult;
  };
  // WebdriverIO 的公开运行时允许覆盖 protocol command，但 9.x 类型只列出 browser command；
  // 这里收窄 cast 到已验证的 deleteSession 包装，不扩散到其它 command。
  browser.overwriteCommand("deleteSession" as never, overwriteDeleteSession as never);
  browsersWithDeleteBarrier.add(browser);
}

export async function waitForElectronProcessExit(
  pidOrPids: number | number[],
  options: E2EElectronProcessExitOptions = {},
) {
  const trackedPids = normalizeProcessPids(Array.isArray(pidOrPids) ? pidOrPids : [pidOrPids]);
  const cleanupTimedOutProcessTreePids =
    options.cleanupTimedOutProcessTreePids ??
    ((pids: number[]) => cleanupTimedOutElectronProcessTreePids(pids, options));
  const collectProcessTreePids = options.collectProcessTreePids ?? (() => []);
  const delay = options.delay ?? defaultDelay;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_ELECTRON_EXIT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ELECTRON_EXIT_TIMEOUT_MS;
  const forceKillGraceMs = options.forceKillGraceMs ?? DEFAULT_ELECTRON_FORCE_KILL_GRACE_MS;
  const waitOptions = {
    collectProcessTreePids,
    delay,
    isProcessAlive,
    now,
    pollIntervalMs,
  };
  let remainingPids = await waitForProcessTreeExit(trackedPids, timeoutMs, waitOptions);
  if (remainingPids.length === 0) return;

  // 修复原因：自然退出超时后不能让 reloadSession 带着旧资源继续建新 session；复用
  // runner 的 Windows taskkill /T /F 与 POSIX TERM -> KILL 口径，随后再按身份严格复扫。
  await cleanupTimedOutProcessTreePids(remainingPids);
  remainingPids = await waitForProcessTreeExit(trackedPids, forceKillGraceMs, waitOptions);
  if (remainingPids.length === 0) return;

  throw new Error(
    `Electron reload 旧进程树退出超时: pids=${remainingPids.join(",")}, timeoutMs=${timeoutMs}`,
  );
}

interface ProcessTreeWaitOptions {
  collectProcessTreePids: () => number[];
  delay: (ms: number) => Promise<void>;
  isProcessAlive: (pid: number) => boolean;
  now: () => number;
  pollIntervalMs: number;
}

async function waitForProcessTreeExit(
  trackedPids: number[],
  timeoutMs: number,
  options: ProcessTreeWaitOptions,
) {
  const startedAt = options.now();
  while (true) {
    const remainingPids = getRemainingProcessTreePids(trackedPids, options);
    if (remainingPids.length === 0 || options.now() - startedAt >= timeoutMs) {
      return remainingPids;
    }
    await options.delay(options.pollIntervalMs);
  }
}

function getRemainingProcessTreePids(
  trackedPids: number[],
  options: Pick<ProcessTreeWaitOptions, "collectProcessTreePids" | "isProcessAlive">,
) {
  return normalizeProcessPids([...trackedPids, ...options.collectProcessTreePids()]).filter(
    options.isProcessAlive,
  );
}

async function cleanupTimedOutElectronProcessTreePids(
  pids: number[],
  options: E2EElectronProcessExitOptions,
) {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", buildWindowsTaskkillArgs(pids), {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // taskkill 可能因部分 PID 已自然退出而返回非零；最终身份复扫负责报告真实残留。
    }
    return;
  }

  signalPosixProcesses(pids, "SIGTERM");
  const forceKillGraceMs = options.forceKillGraceMs ?? DEFAULT_ELECTRON_FORCE_KILL_GRACE_MS;
  const remainingAfterTerm = await waitForProcessTreeExit(pids, forceKillGraceMs, {
    collectProcessTreePids: () => [],
    delay: options.delay ?? defaultDelay,
    isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
    now: options.now ?? Date.now,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_ELECTRON_EXIT_POLL_INTERVAL_MS,
  });
  signalPosixProcesses(remainingAfterTerm, "SIGKILL");
}

function signalPosixProcesses(pids: number[], signal: NodeJS.Signals) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // 进程可能在信号发送前自然退出；最终身份复扫决定屏障是否成功。
    }
  }
}

function collectCurrentE2EProcessTreePids(rootPids: number[] = []) {
  const homeDir = process.env.ZCODE_E2E_HOME_DIR?.trim();
  const runId = process.env.ZCODE_E2E_RUN_ID?.trim();
  if (!homeDir || !runId) {
    throw new Error("Electron reload 缺少 ZCODE_E2E_HOME_DIR 或 ZCODE_E2E_RUN_ID");
  }
  return listE2EProcessTreePids({
    currentPid: process.pid,
    homeDir,
    // reloadSession 复用仍存活的 ChromeDriver；把它纳入旧 Electron 的退出屏障会让
    // deleteSession({ shutdownDriver: false }) 与屏障语义相互冲突，最终只能 ECONNREFUSED。
    includeChromeDriverAncestors: false,
    rootPids,
    runId,
  });
}

function normalizeProcessPids(pids: number[]) {
  return [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
}

function defaultDelay(ms: number) {
  return new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, Math.max(ms, 0));
  });
}

function defaultIsProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code !== "ESRCH",
    );
  }
}
