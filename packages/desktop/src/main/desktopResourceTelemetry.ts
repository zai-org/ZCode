import armsRum from "@arms/rum-electron";
import {
  bytesToKb,
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  mapZCodeEnvToArmsRumEnv,
  memoryUsageToSampleFields,
  type MemorySample,
  type MemorySampleWriteGate,
  type ProcessResourceRole,
  type ProcessResourceRuntimeSurface,
  PROCESS_RESOURCE_EVENT_NAMES,
  zcodeToolExecResourceSchema,
} from "@zcode/shared";
import { BrowserWindow } from "electron";
import os from "node:os";
import { getSharedFinalArmsCustomEventE2EController } from "./desktopArmsCustomEvent.js";
import { desktopRuntimeEnv } from "./desktopRuntimeEnv.js";
import { mainMemoryDiagnosticsRegistry } from "./mainMemoryDiagnostics.js";
import { addAppResourceTotals, type AppResourceTotals } from "./processResourceAppTotals.js";
import { PROCESS_RESOURCE_SAMPLE_SOURCES } from "./processResourceSampleSourceRegistry.js";
import {
  flushPendingProcessResourceSampleSources,
  resetProcessResourceSampleSources,
  runProcessResourceDeviceSampleSources,
  runProcessResourceSampleSources,
} from "./processResourceSampleSources.js";
import { ProcessResourceSystemWindowAggregator } from "./processResourceSystemWindowAggregator.js";
import {
  buildSystemWindowEventProperties,
  PERF_SYSTEM_WINDOW_EVENT_NAME,
} from "./processResourceSystemWindowEvent.js";
import {
  ProcessResourceWindowAggregator,
  type ProcessResourceHardware,
  type ProcessRoleSample,
} from "./processResourceWindowAggregator.js";
import {
  buildProcessWindowEventProperties,
  normalizeOsCategory,
  PERF_PROCESS_WINDOW_EVENT_NAME,
} from "./processResourceWindowEvent.js";
import { listRegisteredHostAgentProcessIds } from "./resourceManagerWindow.js";

/**
 * main 侧进程资源遥测。
 *
 * 唯一的 ARMS 资源出口：10 秒 tick 让每个样本来源写入有界窗口，
 * 5 分钟（开发构建与 E2E 1 分钟）flush 出每角色一条 `perf_process_window`
 * 与每设备一条 `perf_system_window`，正常退出排空残窗。
 * 性能红线：main 进程零外部进程，全链路禁止 PowerShell / WMI / CIM。
 */

/** 采样间隔 */
export const RESOURCE_SAMPLE_INTERVAL_MS = 10_000;

/** 开发构建与 E2E 用 1 分钟窗口便于验证；生产 5 分钟。 */
function resolveDefaultReportIntervalMs(): number {
  if (desktopRuntimeEnv === "development") {
    return 60_000;
  }
  // E2E 跑的是打包构建，没有这个短窗口就无法在一次用例里观察到趋势事件。
  if (process.env.ZCODE_ENV === "test" && process.env.ZCODE_E2E_RUN_ID?.trim()) {
    return 60_000;
  }
  return 300_000;
}

/** 上报间隔 */
export const RESOURCE_REPORT_INTERVAL_MS = resolveDefaultReportIntervalMs();

/**
 * 本地内存诊断日志：借用 10s 资源采样节拍，
 * 每 6 个 tick（≈60s）读一次 main 自身内存，同一次读数既写主日志又作为 main 角色的 heap 样本。
 */
export const MEMORY_LOG_SAMPLE_EVERY_N_TICKS = 6;

export type ResourceUsageScene = "foreground" | "background";

interface ResourceLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

interface ResourceGlobalContext {
  deviceMid: string;
  platform: NodeJS.Platform;
  appVersion: string;
  armsEnv: ReturnType<typeof mapZCodeEnvToArmsRumEnv>;
}

let globalContext: ResourceGlobalContext | null = null;
let desktopHardware: ProcessResourceHardware | null = null;
let sampleTimer: ReturnType<typeof setInterval> | null = null;
let reportTimer: ReturnType<typeof setInterval> | null = null;
let flushMainScheduleDelay: (() => void) | null = null;
let agentMetricProbeDisabledAuditLogged = false;
let memoryLogTick = 0;
let memorySampleWriteGate: MemorySampleWriteGate = createMemorySampleWriteGate();
/** 自证开销时钟；只有单测会替换成可预期的假时钟。 */
let readTelemetrySelfClockMs: () => number = () => performance.now();

const processResourceWindows = new ProcessResourceWindowAggregator();
const processResourceSystemWindow = new ProcessResourceSystemWindowAggregator();
/** 完成事实只需覆盖多连接转发的近期重复，固定预算避免长会话无界增长。 */
const MAX_RECENT_TOOL_EXEC_COMPLETIONS = 1_024;
const recentToolExecCompletions = new Set<string>();

function resolveDesktopHardware(platform: NodeJS.Platform): ProcessResourceHardware {
  return {
    platform,
    arch: process.arch,
    logicalCpuCount: os.cpus().length,
    totalMemoryGb: Math.round(os.totalmem() / 1024 ** 3),
  };
}

function stringifyProperties(
  properties: Record<string, string | number | boolean | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

function reportResourceCustom(
  name: string,
  /** ARMS custom 的 value 字段：控制台默认展示的主指标数值 */
  metricValue: number,
  properties: Record<string, string | number | boolean | undefined>,
): void {
  if (!globalContext) {
    return;
  }

  const payload = {
    name,
    type: "custom" as const,
    group: "resource",
    value: metricValue,
    properties: stringifyProperties(properties),
  };

  // E2E 在 sendCustom 之前捕获，读到的就是真实上报内容。
  const e2eController = getSharedFinalArmsCustomEventE2EController();
  e2eController?.record(payload);
  if (e2eController?.shouldSuppress(name)) {
    return;
  }

  try {
    armsRum.sendCustom(payload);
  } catch (error) {
    console.warn("[resource] sendCustom failed:", name, error);
  }
}

export function resolveResourceUsageScene(): ResourceUsageScene {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  if (windows.length === 0) {
    return "background";
  }

  const anyFocused = windows.some((win) => win.isFocused());
  const anyVisible = windows.some((win) => win.isVisible() && !win.isMinimized());
  return anyFocused && anyVisible ? "foreground" : "background";
}

/** 完成事实即时上报，复用唯一资源出口；不进入五分钟窗口或会话恢复链路。 */
export function ingestToolExecResource(
  raw: unknown,
  runtimeSurface: ProcessResourceRuntimeSurface,
): void {
  if (!globalContext) return;
  const parsed = zcodeToolExecResourceSchema.safeParse(raw);
  if (!parsed.success) return;
  const sample = parsed.data;
  // 同一 Server 可经多个 workspace 和 window Host 转发完成事实；只在 main 唯一出口去重。
  // 无标识的旧 CLI 保留原行为，不能按量化指标去重，否则会吞掉不同的真实命令。
  if (sample.completionToken) {
    if (recentToolExecCompletions.has(sample.completionToken)) return;
    recentToolExecCompletions.add(sample.completionToken);
    if (recentToolExecCompletions.size > MAX_RECENT_TOOL_EXEC_COMPLETIONS) {
      const oldest = recentToolExecCompletions.values().next().value;
      if (oldest !== undefined) recentToolExecCompletions.delete(oldest);
    }
  }
  reportResourceCustom(PROCESS_RESOURCE_EVENT_NAMES.toolExecResource, sample.durationMs, {
    platform: normalizeOsCategory(sample.platform),
    app_version: globalContext.appVersion,
    arms_env: globalContext.armsEnv,
    device_mid: globalContext.deviceMid,
    runtime_surface: runtimeSurface,
    tool_name: sample.toolName,
    exit_kind: sample.exitKind,
    sample_count: sample.sampleCount,
    cli_rss_kb: sample.cliRssKb,
    system_free_memory_kb: sample.systemFreeMemoryKb,
    ...(sample.platform === "win32"
      ? {}
      : {
          tree_rss_kb_peak: sample.treeRssKbPeak ?? 0,
          tree_cpu_time_ms: sample.treeCpuTimeMs ?? 0,
        }),
  });
}

function auditDisabledAgentMetricProbe(logger: ResourceLogger | undefined): void {
  if (
    agentMetricProbeDisabledAuditLogged ||
    process.platform !== "win32" ||
    process.env.ZCODE_ENV !== "test" ||
    !process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim()
  ) {
    return;
  }

  const agentCount = listRegisteredHostAgentProcessIds().length;
  if (agentCount === 0) {
    return;
  }

  agentMetricProbeDisabledAuditLogged = true;
  // E2E 审计合同：该记录仅证明真实采样周期在 Agent PID 已注册时
  // 明确跳过外部指标采集。若未来恢复采集，必须先记录 action=spawn，
  // Windows E2E 会因此失败，防止再次把同步 PowerShell 带回 main process。
  logger?.info(
    `[resource] agent_metric_probe action=skipped reason=main_process_external_probe_disabled agent_count=${agentCount}`,
  );
}

function readMainMemoryUsage(): NodeJS.MemoryUsage | null {
  try {
    return process.memoryUsage();
  } catch {
    return null;
  }
}

function logMemorySample(
  logger: ResourceLogger | undefined,
  memoryUsage: NodeJS.MemoryUsage,
  samples: readonly ProcessRoleSample[],
): void {
  if (!logger) {
    return;
  }
  try {
    const counters = mainMemoryDiagnosticsRegistry.collect();
    for (const sample of samples) {
      counters[`ws.${sample.role}`] = sample.rssKbTotal;
    }
    const sample: MemorySample = {
      role: "main",
      ...memoryUsageToSampleFields(memoryUsage),
      counters,
    };
    const reason = memorySampleWriteGate.evaluate(sample, Date.now());
    if (reason) {
      logger.info(formatMemorySampleLine(sample, reason));
    }
  } catch {
    // 诊断日志失败只丢当前样本，不影响资源采样与 ARMS 上报。
  }
}

function takeSample(logger?: ResourceLogger): void {
  processResourceWindows.recordScene(resolveResourceUsageScene());

  const now = Date.now();
  const samples: ProcessRoleSample[] = [];
  /**
   * 只有进程自己读得到 heap：main 在下面就地读，host / scheduler / renderer 由各自的
   * 自采样本来源投递。heap 不足以独立开窗，统一并入同一 tick 内该角色的完整样本。
   */
  const heapUsedKbByRole = new Map<ProcessResourceRole, number>();
  let appProcessTotals: AppResourceTotals | null = null;
  const onError = (sourceId: string, error: unknown): void =>
    logger?.warn(`[resource] sample source ${sourceId} failed:`, error);
  runProcessResourceSampleSources(PROCESS_RESOURCE_SAMPLE_SOURCES, {
    now,
    addRoleSample: (sample) => samples.push(sample),
    addRoleHeapSample: (role, heapUsedKb) => heapUsedKbByRole.set(role, heapUsedKb),
    addAppProcessTotals: (totals) => {
      appProcessTotals = appProcessTotals ? addAppResourceTotals(appProcessTotals, totals) : totals;
    },
    onError,
  });

  // 每 6 个 tick（≈60s）读一次 main 自身内存：同一次读数既写本地 `[memory]` 日志，
  // 又作为 main 角色事件的 heap 样本，两处数值天然一致且不新增定时器。
  memoryLogTick += 1;
  const mainMemoryUsage =
    memoryLogTick % MEMORY_LOG_SAMPLE_EVERY_N_TICKS === 0 ? readMainMemoryUsage() : null;
  if (mainMemoryUsage) {
    heapUsedKbByRole.set("main", bytesToKb(mainMemoryUsage.heapUsed));
  }

  for (const sample of samples) {
    const heapUsedKb = heapUsedKbByRole.get(sample.role);
    processResourceWindows.add(heapUsedKb === undefined ? sample : { ...sample, heapUsedKb });
  }

  if (mainMemoryUsage) {
    logMemorySample(logger, mainMemoryUsage, samples);
  }

  // 第二阶段：设备级来源要用同一 tick 的精确合计，所以必须等第一阶段全部来源跑完。
  runProcessResourceDeviceSampleSources(PROCESS_RESOURCE_SAMPLE_SOURCES, {
    now,
    appProcessTotals,
    addDeviceSample: (sample) => processResourceSystemWindow.add(sample),
    onError,
  });

  auditDisabledAgentMetricProbe(logger);
}

/**
 * main 侧遥测代码自身的墙钟耗时：以 `telemetry_self_ms` 上报。
 * flush 的耗时落在下一个窗口——它发生在窗口投影之后，无法计入已经发出的那条事件。
 */
function measureTelemetrySelfMs(run: () => void): void {
  const startedAt = readTelemetrySelfClockMs();
  try {
    run();
  } finally {
    processResourceSystemWindow.addTelemetrySelfMs(readTelemetrySelfClockMs() - startedAt);
  }
}

function reportProcessResourceWindows(): void {
  if (!globalContext || !desktopHardware) {
    processResourceWindows.clear();
    return;
  }
  const context = {
    deviceMid: globalContext.deviceMid,
    appVersion: globalContext.appVersion,
    armsEnv: globalContext.armsEnv,
    desktopHardware,
  };
  for (const report of processResourceWindows.drain()) {
    reportResourceCustom(
      PERF_PROCESS_WINDOW_EVENT_NAME,
      report.cpuPercentMean,
      buildProcessWindowEventProperties(report, context),
    );
  }
}

/** 应用运行时长：main 进程与 App 同生共死，直接取它的运行时长。 */
function resolveAppUptimeMinutes(): number {
  const uptimeSeconds = process.uptime();
  return Number.isFinite(uptimeSeconds) ? Math.max(0, Math.round(uptimeSeconds / 60)) : 0;
}

function reportSystemResourceWindow(backgroundRatio: number): void {
  if (!globalContext || !desktopHardware) {
    processResourceSystemWindow.clear();
    return;
  }
  const report = processResourceSystemWindow.drain({
    backgroundRatio,
    appUptimeMinutes: resolveAppUptimeMinutes(),
  });
  if (!report) {
    return;
  }
  reportResourceCustom(
    PERF_SYSTEM_WINDOW_EVENT_NAME,
    report.appCpuPercentMean,
    buildSystemWindowEventProperties(report, {
      deviceMid: globalContext.deviceMid,
      appVersion: globalContext.appVersion,
      armsEnv: globalContext.armsEnv,
      desktopHardware,
    }),
  );
}

/**
 * 把各来源「已经收到、还没交给窗口」的读数补进窗口（只在退出排空时调用）。
 * 不做任何新采样：退出路径不允许再读 getAppMetrics 或起探针。
 */
function flushPendingSourceReadings(logger?: ResourceLogger): void {
  flushPendingProcessResourceSampleSources(PROCESS_RESOURCE_SAMPLE_SOURCES, {
    now: Date.now(),
    addRoleSample: (sample) => processResourceWindows.add(sample),
    // heap 不足以独立开窗，退出时也不例外；只贡献 heap 的来源没有 flushPending。
    addRoleHeapSample: () => {},
    addAppProcessTotals: () => {},
    onError: (sourceId, error) =>
      logger?.warn(`[resource] sample source ${sourceId} flush failed:`, error),
  });
}

/** 排空全部资源窗口；窗口时钟只有这一处，退出排空复用同一个顺序。 */
function drainAllResourceWindows(logger?: ResourceLogger): void {
  flushPendingSourceReadings(logger);
  // background_ratio 的唯一数据源是角色聚合器的 scene 计数，先取值再 drain（drain 会清零）。
  const backgroundRatio = processResourceWindows.backgroundRatio;
  reportProcessResourceWindows();
  reportSystemResourceWindow(backgroundRatio);
}

function flushResourceReports(logger: ResourceLogger): void {
  drainAllResourceWindows(logger);
  logger.info("[resource] perf_process_window + perf_system_window flushed");
}

export function configureDesktopResourceTelemetry(context: ResourceGlobalContext): void {
  recentToolExecCompletions.clear();
  processResourceWindows.clear();
  processResourceSystemWindow.clear();
  globalContext = context;
  desktopHardware = resolveDesktopHardware(context.platform);

  armsRum.setConfig("properties", {
    device_mid: context.deviceMid,
    platform: normalizeOsCategory(context.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
  });
}

export function registerDesktopResourceTelemetry(
  logger: ResourceLogger,
  /**
   * `reportIntervalMs` 只供单测注入窗口时钟；生产走 RESOURCE_REPORT_INTERVAL_MS。
   * `readSelfClockMs` 只供单测注入可预期的自证开销时钟；生产走 performance.now。
   */
  options?: { reportIntervalMs?: number; readSelfClockMs?: () => number },
): void {
  stopDesktopResourceTelemetry();
  agentMetricProbeDisabledAuditLogged = false;
  memoryLogTick = 0;
  memorySampleWriteGate = createMemorySampleWriteGate();
  resetProcessResourceSampleSources(PROCESS_RESOURCE_SAMPLE_SOURCES);
  processResourceSystemWindow.clear();
  readTelemetrySelfClockMs = options?.readSelfClockMs ?? (() => performance.now());

  const reportIntervalMs = options?.reportIntervalMs ?? RESOURCE_REPORT_INTERVAL_MS;
  let lastSampleAtMs = performance.now();
  let delayedSampleCount = 0;
  let maxDelayMs = 0;
  // 主进程阻塞时 webContents 无响应事件也可能晚到；只借现有节拍记录调度延迟，不判定卡死原因。
  flushMainScheduleDelay = () => {
    if (delayedSampleCount === 0) return;
    const summary = {
      pid: process.pid,
      delayedSampleCount,
      maxDelayMs: Math.round(maxDelayMs),
    };
    delayedSampleCount = 0;
    maxDelayMs = 0;
    try {
      logger.warn(`[resource] main_schedule_delay ${JSON.stringify(summary)}`);
    } catch {
      // 诊断落盘失败不能中断既有资源上报或退出排空。
    }
  };

  sampleTimer = setInterval(() => {
    const sampleAtMs = performance.now();
    const delayMs = sampleAtMs - lastSampleAtMs - RESOURCE_SAMPLE_INTERVAL_MS;
    lastSampleAtMs = sampleAtMs;
    if (delayMs > 5_000) {
      delayedSampleCount += 1;
      maxDelayMs = Math.max(maxDelayMs, delayMs);
    }
    measureTelemetrySelfMs(() => {
      try {
        takeSample(logger);
      } catch (error) {
        logger.warn("[resource] sample failed:", error);
      }
    });
  }, RESOURCE_SAMPLE_INTERVAL_MS);

  reportTimer = setInterval(() => {
    measureTelemetrySelfMs(() => {
      try {
        flushMainScheduleDelay?.();
        flushResourceReports(logger);
      } catch (error) {
        logger.warn("[resource] report failed:", error);
      }
    });
  }, reportIntervalMs);

  // 遥测定时器不得延长进程寿命。
  sampleTimer.unref?.();
  reportTimer.unref?.();

  logger.info(
    `[resource] sampling started interval=${RESOURCE_SAMPLE_INTERVAL_MS}ms report=${reportIntervalMs}ms`,
  );
}

export function stopDesktopResourceTelemetry(options?: {
  /** 正常退出：排空残窗，sample_count 如实反映；不触发新采样。 */
  flushPendingWindows?: boolean;
}): void {
  recentToolExecCompletions.clear();
  if (sampleTimer) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }
  if (reportTimer) {
    clearInterval(reportTimer);
    reportTimer = null;
  }
  if (options?.flushPendingWindows) {
    flushMainScheduleDelay?.();
  }
  flushMainScheduleDelay = null;
  if (options?.flushPendingWindows) {
    // Bug 根因：改成 5 分钟聚合后，正常退出仍沿用直接 clear 的旧 stop，
    // 导致已收到但未满窗口的样本静默丢失。这里只排空内存窗口，不触发新采样或磁盘扫描。
    drainAllResourceWindows();
  } else {
    processResourceWindows.clear();
    processResourceSystemWindow.clear();
  }
}
