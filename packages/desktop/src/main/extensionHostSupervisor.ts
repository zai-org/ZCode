// Main 侧的扩展进程监管器（docs/plugins/extension-host.md §3.2、§12.1）。
// 进程管理、日志转发、退出收口照抄 desktopCronScheduler.ts；新增崩溃恢复：
// gen 代际、崩溃预算、存活探测、环境变量白名单、计划重启与重新加载、牵线一个 Window Host。
// 日志控制台（§16.8）：监管器是日志环形缓冲的唯一 owner，写日志文件的同一行同时进缓冲。
import { MessageChannelMain, utilityProcess as electronUtilityProcess } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  EXTENSION_LOG_BUFFER_LIMIT,
  extensionHostToMainMessageSchema,
  extensionWindowToMainMessageSchema,
  truncateExtensionLogMessage,
  type ExtensionHostStatus,
  type ExtensionLogEntry,
  type ExtensionLogLevel,
  type MainToExtensionHostMessage,
  type MainToExtensionWindowMessage,
} from "@zcode/shared/extension-host";
import type {
  ExtensionHostNetworkSettings,
  ExtensionHostSupervisor,
  ExtensionHostSupervisorDeps,
} from "#src/extension-host/contract.js";
import { extensionHostModulePath } from "#src/main/desktopRuntimeEnv.js";

/**
 * 5 分钟内最多自动重启 3 次，退避 1s、2s、4s；第 4 次崩溃时停止。
 * 修复：最初按「崩溃 3 次即停」实现，第 3 次就停，4s 退避永远用不上，与退避表矛盾。
 * 上限从退避表长度推出，两者只有一个来源。
 */
const CRASH_WINDOW_MS = 5 * 60_000;
const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000] as const;
const MAX_AUTO_RESTARTS = RESTART_BACKOFF_MS.length;
/** 每 5 秒探测一次；连续 3 次没有回应判为卡死。所有构建行为相同。 */
const PROBE_INTERVAL_MS = 5_000;
const PROBE_MAX_MISSES = 3;
const DISPOSE_FORCE_KILL_MS = 1_500;

/**
 * 环境变量白名单：扩展进程运行第三方代码，不继承 Window Host 的环境
 * （里面有遥测凭据与 OAuth 配置，desktopRuntimeEnv.ts）。白名单只在这里定义。
 */
export const EXTENSION_HOST_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SystemRoot",
  "windir",
  "APPDATA",
  "LOCALAPPDATA",
  "NODE_ENV",
] as const;

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;
const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy"] as const;
const CA_ENV_KEYS = ["NODE_EXTRA_CA_CERTS"] as const;

/** 代理地址的翻译与 CLI 相同（agentProxyEnv.ts、CLI 的 subprocess-env.ts）：裸 host:port 补 http://。 */
function normalizeProxy(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** No Proxy 规范成逗号分隔、去掉空项，与 CLI 相同。 */
function normalizeNoProxy(value: string | undefined): string | undefined {
  const tokens = value
    ?.split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens && tokens.length > 0 ? tokens.join(",") : undefined;
}

/**
 * 写设置页的值，大小写两种形式都写：Node 的环境代理小写优先（http_proxy 先于 HTTP_PROXY）。
 * Windows 的变量名不分大小写，只写一份。
 */
function setEnv(
  env: Record<string, string>,
  keys: readonly string[],
  value: string,
  platform: NodeJS.Platform,
): void {
  const seen = new Set<string>();
  for (const key of keys) {
    const identity = platform === "win32" ? key.toUpperCase() : key;
    if (seen.has(identity)) continue;
    seen.add(identity);
    env[key] = value;
  }
}

/**
 * 白名单 ⊕ 设置页的网络出口（§12.1、§18.1 H3）。代理、No Proxy 与自定义 CA 只来自设置页，
 * 与 CLI 相同：设置页留空就直连，不读 shell 环境里的同名变量。
 * 修复原因（用户决策，2026-11-05）：最初设置页留空时沿用 Main 环境的代理变量，CLI 这时却是直连，
 * 两个进程的出口规则不一致，设置页「不读取系统环境变量」的说明对扩展不成立。所以这些变量不进白名单。
 */
export function buildExtensionHostEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  network: ExtensionHostNetworkSettings = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  for (const key of EXTENSION_HOST_ENV_ALLOWLIST) {
    // Windows 的环境变量名不区分大小写：HTTP_PROXY 与 http_proxy 是同一个变量，只传一次。
    const identity = platform === "win32" ? key.toUpperCase() : key;
    if (seen.has(identity)) continue;
    const value = source[key];
    if (value === undefined) continue;
    seen.add(identity);
    env[key] = value;
  }
  const proxy = normalizeProxy(network.httpProxy);
  if (proxy) setEnv(env, PROXY_ENV_KEYS, proxy, platform);
  const noProxy = normalizeNoProxy(network.noProxy);
  if (noProxy) setEnv(env, NO_PROXY_ENV_KEYS, noProxy, platform);
  const caCertPath = network.caCertPath?.trim();
  if (caCertPath) setEnv(env, CA_ENV_KEYS, caCertPath, platform);
  env.ZCODE_PROCESS_LABEL = "extension-host";
  return env;
}

/** 日志只记每项是否由设置页配置，不记地址与路径：代理地址可能带账号密码。 */
function describeNetworkSources(network: ExtensionHostNetworkSettings): string {
  const source = (configured: string | undefined) => (configured?.trim() ? "settings" : "none");
  return `proxy=${source(network.httpProxy)} noProxy=${source(network.noProxy)} ca=${source(network.caCertPath)}`;
}

interface WindowHostEntry {
  ready: boolean;
}

type ExitIntent = "planned" | "dispose" | "unresponsive";

export function createExtensionHostSupervisor(
  deps: ExtensionHostSupervisorDeps,
): ExtensionHostSupervisor {
  const { logger } = deps;
  const windowHosts = new Map<ElectronUtilityProcess, WindowHostEntry>();
  let paired: ElectronUtilityProcess | null = null;
  let child: ElectronUtilityProcess | null = null;
  let childReady = false;
  let gen = 0;
  let status: ExtensionHostStatus = { state: "starting", gen: 0 };
  let crashTimes: number[] = [];
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let probeSeq = 0;
  let awaitingProbe = false;
  let probeMisses = 0;
  let exitIntent: ExitIntent | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let disposing = false;
  let disposePromise: Promise<void> | null = null;
  /** 日志环形缓冲：最近 EXTENSION_LOG_BUFFER_LIMIT 条，seq 连续递增。扩展进程崩溃、重启后照常保留。 */
  const logEntries: ExtensionLogEntry[] = [];
  let logSeq = 0;
  /** 本轮事件循环追加、还没推给 Window Host 的条目。 */
  let pendingLogs: ExtensionLogEntry[] = [];
  let logFlushScheduled = false;

  const prefix = (target = gen) => `[extension-host] gen=${target}`;

  const postToWindowHost = (
    host: ElectronUtilityProcess,
    message: MainToExtensionWindowMessage,
    transfer?: Electron.MessagePortMain[],
  ) => {
    try {
      host.postMessage(message, transfer);
    } catch (error) {
      logger.warn(`${prefix()} post to window host failed:`, error);
    }
  };

  /** 同一轮事件循环追加的条目合成一批，推给每个已就绪的 Window Host（与状态推送相同）。不用定时器。 */
  const flushLogs = () => {
    logFlushScheduled = false;
    const entries = pendingLogs;
    pendingLogs = [];
    for (const [host, entry] of windowHosts) {
      if (entry.ready) postToWindowHost(host, { type: "extension-host/logs", entries });
    }
  };

  /**
   * 写日志文件（格式不变：`[extension-host] gen=N [pluginId] message`），同一行进环形缓冲。
   * 缓冲里的 message 不含前缀，超过 4KB 截断；日志文件照写完整内容。
   * 注意：postToWindowHost 的发送失败只写日志文件，不经这里，否则发送一直失败时推送会循环。
   */
  const log = (
    level: ExtensionLogLevel,
    message: string,
    options: { gen?: number; pluginId?: string } = {},
  ) => {
    const target = options.gen ?? gen;
    logger[level](
      `${prefix(target)}${options.pluginId ? ` [${options.pluginId}]` : ""} ${message}`,
    );
    logSeq += 1;
    const entry: ExtensionLogEntry = {
      seq: logSeq,
      ts: Date.now(),
      level,
      gen: target,
      ...(options.pluginId ? { pluginId: options.pluginId } : {}),
      message: truncateExtensionLogMessage(message),
    };
    logEntries.push(entry);
    if (logEntries.length > EXTENSION_LOG_BUFFER_LIMIT) logEntries.shift();
    pendingLogs.push(entry);
    if (!logFlushScheduled) {
      logFlushScheduled = true;
      setImmediate(flushLogs);
    }
  };

  const postToChild = (
    message: MainToExtensionHostMessage,
    transfer?: Electron.MessagePortMain[],
  ) => {
    try {
      child?.postMessage(message, transfer);
    } catch (error) {
      logger.warn(`${prefix()} post to extension host failed:`, error);
    }
  };

  const setStatus = (next: ExtensionHostStatus) => {
    status = next;
    log("info", `status=${next.state}${next.reason ? ` reason=${next.reason}` : ""}`, {
      gen: next.gen,
    });
    for (const [host, entry] of windowHosts) {
      if (entry.ready) postToWindowHost(host, { type: "extension-host/status", status });
    }
  };

  /** 同一时刻只给一个 Window Host 牵线；当前没有时，给下一个就绪的 Window Host。 */
  const pair = () => {
    if (!child || !childReady || disposing) return;
    const target =
      paired && windowHosts.get(paired)?.ready
        ? paired
        : ([...windowHosts].find(([, entry]) => entry.ready)?.[0] ?? null);
    if (!target) return;
    const { port1, port2 } = new MessageChannelMain();
    postToWindowHost(target, { type: "extension-host/pair", gen }, [port1]);
    postToChild({ type: "extension-host/attach-window", gen }, [port2]);
    paired = target;
    log("info", `paired window host pid=${target.pid ?? "unknown"}`);
  };

  const stopProbe = () => {
    if (probeTimer) clearInterval(probeTimer);
    probeTimer = null;
    awaitingProbe = false;
    probeMisses = 0;
  };

  const startProbe = (target: ElectronUtilityProcess) => {
    stopProbe();
    probeTimer = setInterval(() => {
      if (child !== target) return;
      if (awaitingProbe) {
        probeMisses += 1;
        if (probeMisses >= PROBE_MAX_MISSES) {
          // 探测由扩展进程的事件循环回应；连续不回应说明某个扩展卡死了事件循环。
          log(
            "error",
            `unresponsive: ${probeMisses} probes missed in ${(probeMisses * PROBE_INTERVAL_MS) / 1000}s, killing pid=${target.pid ?? "unknown"}`,
          );
          stopProbe();
          exitIntent = "unresponsive";
          target.kill();
          return;
        }
      }
      probeSeq += 1;
      awaitingProbe = true;
      postToChild({ type: "extension-host/probe", seq: probeSeq });
    }, PROBE_INTERVAL_MS);
  };

  const relayStream = (
    stream: NodeJS.ReadableStream | null | undefined,
    level: "info" | "warn",
  ) => {
    stream?.on("data", (data: Buffer) => {
      for (const line of data.toString().split(/\r?\n/)) {
        if (line.trim()) log(level, `[${level === "info" ? "stdout" : "stderr"}] ${line}`);
      }
    });
  };

  /** 设置页的网络出口（§18.1 H3）：每次启动前读一次，所以改设置后「重新加载扩展」即生效。读失败时只用 Main 环境。 */
  const readNetworkSettings = async (): Promise<ExtensionHostNetworkSettings> => {
    if (!deps.readNetworkSettings) return {};
    try {
      return await deps.readNetworkSettings();
    } catch (error) {
      log(
        "warn",
        `network settings unavailable; using the main process environment (${error instanceof Error ? error.name : "unknown"})`,
      );
      return {};
    }
  };

  const spawn = () => {
    if (disposing) return;
    restartTimer = null;
    gen += 1;
    const myGen = gen;
    childReady = false;
    setStatus({ state: "starting", gen: myGen });
    void readNetworkSettings().then((network) => {
      // 读设置期间又重启（gen 变了）或开始退出：这一代作废，不再 fork。
      if (disposing || gen !== myGen) return;
      fork(myGen, network);
    });
  };

  const fork = (myGen: number, network: ExtensionHostNetworkSettings) => {
    const env = buildExtensionHostEnv(process.env, process.platform, network);
    log("info", `network ${describeNetworkSources(network)}`, { gen: myGen });
    const next = electronUtilityProcess.fork(extensionHostModulePath, [], {
      serviceName: "zcode-extension-host",
      execArgv: ["--no-warnings"],
      env,
      stdio: "pipe",
    });
    child = next;
    // pid 在 spawn 事件之后才可用。
    next.once("spawn", () => {
      log("info", `forked extension host pid=${next.pid ?? "unknown"}`, { gen: myGen });
    });
    relayStream(next.stdout, "info");
    relayStream(next.stderr, "warn");
    next.on("message", (raw: unknown) => {
      if (child !== next) return;
      const parsed = extensionHostToMainMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "extension-host/probe-ack") {
        awaitingProbe = false;
        probeMisses = 0;
        return;
      }
      if (message.type === "extension-host/log") {
        log(message.level, message.message, {
          gen: myGen,
          ...(message.pluginId ? { pluginId: message.pluginId } : {}),
        });
        return;
      }
      if (message.type === "extension-host/ready") {
        childReady = true;
        setStatus({ state: "running", gen: myGen });
        pair();
        return;
      }
      if (message.type === "extension-host/request-restart") {
        log("info", `planned restart requested: ${message.reason}`, { gen: myGen });
        restart("planned");
      }
    });
    next.once("exit", (code) => onExit(next, myGen, code));
    postToChild({ type: "extension-host/init", gen: myGen });
    startProbe(next);
  };

  const onExit = (exited: ElectronUtilityProcess, exitedGen: number, code: number) => {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    forceKillTimer = null;
    if (child !== exited) return;
    stopProbe();
    child = null;
    childReady = false;
    const intent = exitIntent;
    exitIntent = null;
    log("info", `extension host exited code=${code} intent=${intent ?? "crash"}`, {
      gen: exitedGen,
    });
    if (disposing || intent === "dispose") return;
    if (intent === "planned") {
      // 计划重启与重新加载不计入崩溃预算。
      spawn();
      return;
    }
    const now = Date.now();
    crashTimes = [...crashTimes.filter((time) => now - time < CRASH_WINDOW_MS), now];
    const reason = intent === "unresponsive" ? "unresponsive" : `crashed (code=${code})`;
    if (crashTimes.length > MAX_AUTO_RESTARTS) {
      log(
        "error",
        `crash budget exhausted (${crashTimes.length} in ${CRASH_WINDOW_MS / 60_000} min); not restarting`,
        { gen: exitedGen },
      );
      setStatus({ state: "stopped", gen: exitedGen, reason });
      return;
    }
    const delay = RESTART_BACKOFF_MS[crashTimes.length - 1]!;
    setStatus({ state: "restarting", gen: exitedGen, reason });
    log("warn", `restarting in ${delay}ms (restart ${crashTimes.length}/${MAX_AUTO_RESTARTS})`, {
      gen: exitedGen,
    });
    restartTimer = setTimeout(spawn, delay);
  };

  /** 让当前进程优雅退出（deactivate 共用 1 秒），1.5 秒后强杀。退出后按 intent 决定是否重启。 */
  const stopChild = (intent: ExitIntent) => {
    const target = child;
    if (!target) return;
    stopProbe();
    exitIntent = intent;
    postToChild({ type: "extension-host/dispose" });
    if (forceKillTimer) clearTimeout(forceKillTimer);
    forceKillTimer = setTimeout(() => {
      if (child === target) {
        log("warn", `dispose timed out; force killing pid=${target.pid ?? "unknown"}`);
        target.kill();
      }
    }, DISPOSE_FORCE_KILL_MS);
  };

  const restart = (intent: "planned") => {
    if (disposing) return;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    if (child) stopChild(intent);
    else spawn();
  };

  return {
    trackWindowHost(host) {
      if (windowHosts.has(host)) return;
      const entry: WindowHostEntry = { ready: false };
      windowHosts.set(host, entry);
      host.on("message", (raw: unknown) => {
        const parsed = extensionWindowToMainMessageSchema.safeParse(raw);
        if (!parsed.success) return;
        if (parsed.data.type === "extension-host/window-ready") {
          entry.ready = true;
          postToWindowHost(host, { type: "extension-host/status", status });
          // 扩展进程只在有 Window Host 能给它插件清单时才需要：首个 Window Host 就绪时拉起。
          if (gen === 0) spawn();
          else if (!paired || paired === host) pair();
          return;
        }
        if (parsed.data.type === "extension-host/reload") {
          log("info", "reload requested; crash budget reset");
          crashTimes = [];
          restart("planned");
          return;
        }
        if (parsed.data.type === "extension-host/logs-request") {
          // 当场回缓冲（§16.8）：seq 在缓冲里连续，sinceSeq 之后的部分直接切片。
          // 还没推出的 pendingLogs 也已在缓冲里，之后到达的那一批由 Renderer 按 seq 去重。
          const { requestId, sinceSeq } = parsed.data;
          const firstSeq = logEntries[0]?.seq ?? logSeq + 1;
          const entries =
            sinceSeq === undefined
              ? [...logEntries]
              : logEntries.slice(Math.max(0, sinceSeq - firstSeq + 1));
          postToWindowHost(host, {
            type: "extension-host/logs-snapshot",
            requestId,
            entries,
            lastSeq: logSeq,
          });
        }
      });
      host.once("exit", () => {
        windowHosts.delete(host);
        if (paired !== host) return;
        paired = null;
        pair();
      });
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposing = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      const target = child;
      if (!target) {
        disposePromise = Promise.resolve();
        return disposePromise;
      }
      disposePromise = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            target.kill();
          } catch {
            // 忽略。
          }
          resolve();
        }, DISPOSE_FORCE_KILL_MS);
        target.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        stopProbe();
        exitIntent = "dispose";
        postToChild({ type: "extension-host/dispose" });
      });
      return disposePromise;
    },
  };
}
