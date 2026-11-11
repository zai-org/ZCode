/* eslint-disable max-lines -- 稳定性上报集中单模块，拆分反而增加跨文件状态同步 */
import { randomUUID } from "node:crypto";
import armsRum from "@arms/rum-electron";
import { BrowserWindow, type WebContents } from "electron";
import {
  mapZCodeEnvToArmsRumEnv,
  type HostAgentProcessErrorResponse,
  type HostAgentProcessExceptionResponse,
  type HostAgentProcessExitedResponse,
  type HostAgentProcessReadyResponse,
  type HostAgentProcessSpawnedResponse,
} from "@zcode/shared";
import {
  createAgentCrashFingerprint,
  parseAgentProcessExitDiagnostic,
  parseAgentProcessSpawnDiagnostic,
  sanitizeAgentCrashDetail,
} from "@zcode/shared/agent-crash-diagnostic";
import type { CrashCapturePaths } from "./desktopCrashCapture.js";
import { registerCrashEventMonitor as registerBaseCrashEventMonitor } from "./desktopCrashCapture.js";
import { getResourceManagerWindowId } from "./resourceManagerWindow.js";

/** ANR：主线程无响应阈值（与 Electron unresponsive 对齐） */
export const STABILITY_ANR_THRESHOLD_MS = 5_000;
/** 挂死：未恢复且未 crash 的更长无响应阈值 */
export const STABILITY_FREEZE_THRESHOLD_MS = 30_000;
export const STABILITY_TELEMETRY_SCHEMA_VERSION = 2;
const WINDOWS_CONTROLLED_TERMINATION_EXIT_CODE = 0x40010004;
const AGENT_EXCEPTION_DEDUP_CAPACITY = 1024;
const reportedAgentExceptions = new Set<string>();

export type StabilityLifecycleScene = "cold_start" | "runtime" | "app_quit" | "update_install";

export type StabilityWindowScene = "main" | "process_monitor" | "other";

export type StabilityCrashKind = "native" | "js" | "oom";

export type StabilityCrashScope =
  | "app_native_process"
  | "main_window_renderer"
  | "auxiliary_window_renderer"
  | "embedded_webview"
  | "host"
  | "child";

export type StabilityCrashCause =
  | "oom"
  | "process_crashed"
  | "abnormal_exit"
  | "launch_failed"
  | "integrity_failure"
  | "native_crash"
  | "unknown";

export interface StabilityCrashClassification {
  crashKind: StabilityCrashKind;
  crashScope: StabilityCrashScope;
  crashCause: StabilityCrashCause;
}

export type StabilityProcessRole =
  | "main"
  | "renderer"
  | "gpu"
  | "utility"
  | "agent"
  | "host"
  | "child"
  | "unknown";

export type AgentCrashPhase = "startup" | "runtime" | "unknown";
export type AgentTerminationClass = "exit_zero" | "exit_nonzero" | "signal" | "unknown";

interface StabilityLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

interface StabilityGlobalContext {
  deviceMid: string;
  platform: NodeJS.Platform;
  appVersion: string;
  armsEnv: ReturnType<typeof mapZCodeEnvToArmsRumEnv>;
}

interface UnresponsiveWatchState {
  windowId: number;
  webContentsId: number;
  windowScene: StabilityWindowScene;
  startedAt: number;
  anrReported: boolean;
  freezeReported: boolean;
  crashReported: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
}

export interface RenderProcessGoneInput {
  reason: string;
  exitCode: number;
  webContentsType: string;
  windowScene?: StabilityWindowScene;
}

export interface ChildProcessGoneInput {
  type: string;
  reason: string;
  exitCode: number;
  serviceName?: string;
  name: string;
}

let globalContext: StabilityGlobalContext | null = null;
let lifecycleScene: StabilityLifecycleScene = "runtime";
// 修复原因：WebContents.getType() 对所有 BrowserWindow 都返回 window，无法区分主业务窗和
// Resource Manager / 更新 / About。只登记 createWindowInstance 创建的业务窗口，避免辅助窗污染 Crash 率。
const mainWindowIds = new Set<number>();
let perfAppStartReported = false;
const unresponsiveByWebContentsId = new Map<number, UnresponsiveWatchState>();

function normalizeOsCategory(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
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

function resolveStabilityMetricValue(
  name: string,
  properties: Record<string, string | number | boolean | undefined>,
): number {
  switch (name) {
    case "perf_anr":
    case "perf_freeze": {
      const duration = Number(properties.duration_ms);
      return Number.isFinite(duration) ? duration : 0;
    }
    case "perf_app_exit":
    case "perf_process_exit": {
      const exitCode = Number(properties.exit_code);
      return Number.isFinite(exitCode) ? exitCode : 0;
    }
    case "perf_crash":
      return 1;
    case "perf_app_start":
    default:
      return 1;
  }
}

function classifyAgentCrashPhase(runtimeReady: boolean | undefined): AgentCrashPhase {
  if (runtimeReady === true) {
    return "runtime";
  }
  if (runtimeReady === false) {
    return "startup";
  }
  return "unknown";
}

function classifyAgentTermination(event: HostAgentProcessExitedResponse): AgentTerminationClass {
  if (event.signal) {
    return "signal";
  }
  if (event.exitCode === 0) {
    return "exit_zero";
  }
  if (typeof event.exitCode === "number") {
    return "exit_nonzero";
  }
  return "unknown";
}

function reportStabilityCustom(
  name: string,
  properties: Record<string, string | number | boolean | undefined>,
  windowScene?: StabilityWindowScene,
  lifecycleSceneOverride?: StabilityLifecycleScene,
): void {
  if (!globalContext) {
    return;
  }

  const metricValue = resolveStabilityMetricValue(name, properties);

  const payload = stringifyProperties({
    event_name: name,
    platform: normalizeOsCategory(globalContext.platform),
    app_version: globalContext.appVersion,
    arms_env: globalContext.armsEnv,
    device_mid: globalContext.deviceMid,
    telemetry_schema_version: STABILITY_TELEMETRY_SCHEMA_VERSION,
    scene_lifecycle: lifecycleSceneOverride ?? lifecycleScene,
    scene_window: windowScene ?? "main",
    metric_value: metricValue,
    ...properties,
  });

  try {
    // ARMS 原始日志/控制台按 custom 类型展示；业务分组用 group
    // value 填具体数值：ANR/挂死为 duration_ms，退出为 exit_code，计数类统一为 1
    armsRum.sendCustom({
      name,
      type: "custom",
      group: "stability",
      value: metricValue,
      properties: payload,
    });
  } catch (error) {
    // 稳定性上报失败不应影响主流程
    console.warn("[stability] sendCustom failed:", name, error);
  }
}

export function reportAgentProcessExceptionToArms(
  event: HostAgentProcessExceptionResponse,
  logger: StabilityLogger,
): void {
  if (!globalContext) return;
  const key = `${event.runtimeInstanceId}:${event.diagnostic.errorId}`;
  if (reportedAgentExceptions.has(key)) return;
  const diagnostic = event.diagnostic;
  const name = sanitizeAgentCrashDetail(diagnostic.name, event.workspacePath);
  const message = sanitizeAgentCrashDetail(diagnostic.message, event.workspacePath);
  const stack =
    diagnostic.stack === undefined
      ? undefined
      : sanitizeAgentCrashDetail(diagnostic.stack, event.workspacePath);
  try {
    // 根因：Electron collector 只监听自身进程，CLI 异常必须携带原始栈显式发送，
    // 不能先转成 console.error 包装字符串，也不能等待进程退出后再上报。
    armsRum.sendEvent({
      event_type: "exception",
      type: "error",
      source: diagnostic.kind,
      name,
      message,
      ...(stack === undefined ? {} : { stack }),
      timestamp: diagnostic.occurredAt,
      properties: stringifyProperties({
        process_role: "agent",
        process_error_kind: diagnostic.kind,
        process_error_origin: diagnostic.origin,
        error_id: diagnostic.errorId,
        runtime_instance_id: event.runtimeInstanceId,
        runtime_generation: event.runtimeGeneration,
        provider: event.provider,
        lane: event.lane,
        error_fingerprint: createAgentCrashFingerprint([
          name,
          message,
          stack?.split(/\r?\n/).find((line) => line.trim().startsWith("at ")) ?? "",
        ]),
        app_version: globalContext.appVersion,
        arms_env: globalContext.armsEnv,
        device_mid: globalContext.deviceMid,
        platform: normalizeOsCategory(globalContext.platform),
      }),
    });
    reportedAgentExceptions.add(key);
    if (reportedAgentExceptions.size > AGENT_EXCEPTION_DEDUP_CAPACITY) {
      reportedAgentExceptions.delete(reportedAgentExceptions.values().next().value!);
    }
  } catch (error) {
    // SDK 失败不能影响 Host 消息处理；未成功提交的事件不进入去重集合。
    logger.warn("[stability] Agent exception report failed", error);
  }
}

export function reportAgentProcessStartToArms(
  event: HostAgentProcessSpawnedResponse,
  logger: StabilityLogger,
): void {
  reportStabilityCustom("perf_agent_start", {
    process_role: "agent",
    // mcp-status 与 plugin lane 进程共用 cwd/command，只有 lane 能区分事件来源。
    ...(event.lane ? { lane: event.lane } : {}),
    provider: event.provider,
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
  });
  logger.info("[stability] perf_agent_start reported", {
    pid: event.pid,
    runtimeGeneration: event.runtimeGeneration,
    runtimeInstanceId: event.runtimeInstanceId,
  });
}

export function reportAgentProcessReadyToArms(
  event: HostAgentProcessReadyResponse,
  logger: StabilityLogger,
): void {
  reportStabilityCustom("perf_agent_ready", {
    process_role: "agent",
    // mcp-status 与 plugin lane 进程共用 cwd/command，只有 lane 能区分事件来源。
    ...(event.lane ? { lane: event.lane } : {}),
    provider: event.provider,
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
    startup_duration_ms: event.startupDurationMs,
  });
  logger.info("[stability] perf_agent_ready reported", {
    pid: event.pid,
    runtimeGeneration: event.runtimeGeneration,
    runtimeInstanceId: event.runtimeInstanceId,
    startupDurationMs: event.startupDurationMs,
  });
}

export function reportAgentProcessExitToArms(
  event: HostAgentProcessExitedResponse,
  logger: StabilityLogger,
): void {
  if (event.terminationKind !== "unexpected") {
    return;
  }
  const isProtocolFailure = event.terminationReason === "protocol-close";
  if (
    !isProtocolFailure &&
    (event.exitCode === WINDOWS_CONTROLLED_TERMINATION_EXIT_CODE || event.signal === "SIGTERM")
  ) {
    // Bug 根因：协议故障会先触发 protocol-close，再由 Host 回收仍存活的进程，
    // 因此最终也可能表现为 SIGTERM / Windows control-c exit code。只有缺少结构化
    // 协议根因时，裸退出签名才不足以证明 Agent 自身崩溃，应继续抑制误报。
    logger.debug?.("[stability] controlled Agent termination suppressed", {
      pid: event.pid,
      runtimeInstanceId: event.runtimeInstanceId,
      exitCode: event.exitCode,
      signal: event.signal,
    });
    return;
  }
  if (lifecycleScene === "app_quit" || lifecycleScene === "update_install") {
    // Bug 根因：Host 清理与 IPC 回传是异步的，perf_app_exit 之后仍可能晚到一个缺失
    // termination intent 的 Agent exit。应用退出是 main 持有的更高层事实，不能计入 runtime crash。
    logger.debug?.("[stability] late Agent exit suppressed during app shutdown", {
      pid: event.pid,
      runtimeInstanceId: event.runtimeInstanceId,
      lifecycleScene,
    });
    return;
  }
  const diagnostic = parseAgentProcessExitDiagnostic(event);
  reportStabilityCustom("perf_agent_crash", {
    process_role: "agent",
    // mcp-status 与 plugin lane 进程共用 cwd/command，只有 lane 能区分事件来源。
    ...(event.lane ? { lane: event.lane } : {}),
    incident_kind: "unexpected_exit",
    provider: event.provider,
    exit_code: event.exitCode ?? "",
    signal: event.signal ?? "",
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
    uptime_ms: event.uptimeMs,
    stderr_line_count: event.stderrLineCount,
    crash_phase: classifyAgentCrashPhase(event.runtimeReady),
    termination_class: classifyAgentTermination(event),
    termination_reason: event.terminationReason,
    diagnostic_class: diagnostic.diagnosticClass,
    error_name: diagnostic.errorName,
    error_code: diagnostic.errorCode,
    error_message: diagnostic.errorMessage,
    error_stack: diagnostic.errorStack,
    error_fingerprint: diagnostic.errorFingerprint,
  });
  // 上报成功属于观测日志，error 会被 console collector 再生成一条伪 JS 异常。
  logger.info("[stability] perf_agent_crash reported", {
    pid: event.pid,
    exitCode: event.exitCode,
    signal: event.signal,
    runtimeGeneration: event.runtimeGeneration,
    errorName: diagnostic.errorName,
    errorCode: diagnostic.errorCode,
    errorFingerprint: diagnostic.errorFingerprint,
  });
}

export function reportAgentProcessSpawnErrorToArms(
  event: HostAgentProcessErrorResponse,
  logger: StabilityLogger,
): void {
  const diagnostic = parseAgentProcessSpawnDiagnostic(event);
  reportStabilityCustom("perf_agent_spawn_error", {
    process_role: "agent",
    // mcp-status 与 plugin lane 进程共用 cwd/command，只有 lane 能区分事件来源。
    ...(event.lane ? { lane: event.lane } : {}),
    incident_kind: "spawn_error",
    provider: event.provider,
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
    diagnostic_class: diagnostic.diagnosticClass,
    error_name: diagnostic.errorName,
    error_code: diagnostic.errorCode,
    error_message: diagnostic.errorMessage,
    error_stack: diagnostic.errorStack,
    error_fingerprint: diagnostic.errorFingerprint,
  });
  logger.info("[stability] perf_agent_spawn_error reported", {
    pid: event.pid,
    runtimeGeneration: event.runtimeGeneration,
    errorName: diagnostic.errorName,
    errorCode: diagnostic.errorCode,
    errorFingerprint: diagnostic.errorFingerprint,
  });
}

export function mapRenderProcessGoneToCrashKind(
  input: RenderProcessGoneInput,
): StabilityCrashKind | null {
  return classifyRenderProcessCrash(input)?.crashKind ?? null;
}

function mapExitReasonToCrashKind(reason: string): StabilityCrashKind {
  // Electron 的 renderer/child gone 回调共用这组退出原因，OOM 不能因进程来源不同而被归为 native。
  return reason === "oom" || reason === "memory-eviction" ? "oom" : "native";
}

function mapExitReasonToCrashCause(reason: string): StabilityCrashCause {
  switch (reason) {
    case "oom":
    // Electron 41 将 Chromium 的内存压力驱逐单独命名；它与 oom 一样表示进程因内存
    // 压力退出，不能落入 native/unknown，否则 OOM 指标会被低估。
    case "memory-eviction":
      return "oom";
    case "crashed":
      return "process_crashed";
    case "abnormal":
    case "abnormal-exit":
      return "abnormal_exit";
    case "launch-failed":
      return "launch_failed";
    case "integrity-failure":
      return "integrity_failure";
    default:
      return "unknown";
  }
}

export function classifyRenderProcessCrash(
  input: RenderProcessGoneInput,
): StabilityCrashClassification | null {
  if (input.reason === "killed" || input.reason === "clean-exit") {
    return null;
  }
  return {
    crashKind: mapExitReasonToCrashKind(input.reason),
    crashScope:
      input.webContentsType === "webview"
        ? "embedded_webview"
        : input.windowScene === undefined || input.windowScene === "main"
          ? "main_window_renderer"
          : "auxiliary_window_renderer",
    crashCause: mapExitReasonToCrashCause(input.reason),
  };
}

export function mapChildProcessGoneToProcessRole(
  type: string,
  processName?: string,
): StabilityProcessRole {
  return mapChildProcessGoneToProcessRoleWithName(type, processName);
}

function mapChildProcessGoneToProcessRoleWithName(
  type: string,
  processName?: string,
): StabilityProcessRole {
  if (processName?.startsWith("zcode-host")) {
    return "host";
  }
  if (processName?.startsWith("zcode-agent")) {
    return "agent";
  }
  switch (type) {
    case "GPU":
      return "gpu";
    case "Utility":
      return "utility";
    default:
      return "child";
  }
}

export function shouldReportChildProcessGoneAsCrash(input: ChildProcessGoneInput): boolean {
  if (input.reason === "killed" || input.reason === "clean-exit") {
    return false;
  }

  const role = mapChildProcessGoneToProcessRoleWithName(input.type, input.name);
  if (role === "gpu") {
    return false;
  }

  // Bugfix: RUM 里 Video Capture / Network Service / Audio Service 等 Chromium Utility
  // 子进程会被系统自动重建，不会让 ZCode 主窗口或会话不可用；它们只能作为可恢复退出记录，
  // 不能进入 perf_crash，否则会把 crash-free 指标按“非真实崩溃”拉低。
  if (role === "utility") {
    return false;
  }

  return true;
}

export function shouldReportAnr(elapsedMs: number, anrReported: boolean): boolean {
  return !anrReported && elapsedMs >= STABILITY_ANR_THRESHOLD_MS;
}

export function shouldReportFreeze(
  elapsedMs: number,
  freezeReported: boolean,
  crashReported: boolean,
): boolean {
  return !freezeReported && !crashReported && elapsedMs >= STABILITY_FREEZE_THRESHOLD_MS;
}

function resolveRegisteredWindowScene(win: BrowserWindow | null | undefined): StabilityWindowScene {
  if (!win || win.isDestroyed()) {
    return "other";
  }
  const resourceManagerId = getResourceManagerWindowId();
  if (resourceManagerId != null && win.id === resourceManagerId) {
    return "process_monitor";
  }
  return mainWindowIds.has(win.id) ? "main" : "other";
}

function resolveWindowScene(win: BrowserWindow | null | undefined): StabilityWindowScene {
  if (win && !win.isDestroyed()) {
    return resolveRegisteredWindowScene(win);
  }
  const focused = BrowserWindow.getFocusedWindow();
  return focused && !focused.isDestroyed() ? resolveRegisteredWindowScene(focused) : "main";
}

function markWebContentsCrash(webContentsId: number): void {
  const state = unresponsiveByWebContentsId.get(webContentsId);
  if (state) {
    state.crashReported = true;
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }
}

function clearUnresponsiveWatch(webContentsId: number): void {
  const state = unresponsiveByWebContentsId.get(webContentsId);
  if (!state) {
    return;
  }
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
  }
  unresponsiveByWebContentsId.delete(webContentsId);
}

function pollUnresponsiveState(state: UnresponsiveWatchState, logger: StabilityLogger): void {
  if (state.crashReported) {
    clearUnresponsiveWatch(state.webContentsId);
    return;
  }

  const elapsedMs = Date.now() - state.startedAt;
  const windowScene = state.windowScene;

  if (shouldReportAnr(elapsedMs, state.anrReported)) {
    state.anrReported = true;
    reportStabilityCustom(
      "perf_anr",
      {
        duration_ms: elapsedMs,
        window_id: state.windowId,
        web_contents_id: state.webContentsId,
      },
      windowScene,
    );
    logger.warn("[stability] perf_anr reported", {
      windowId: state.windowId,
      webContentsId: state.webContentsId,
      durationMs: elapsedMs,
    });
  }

  if (shouldReportFreeze(elapsedMs, state.freezeReported, state.crashReported)) {
    state.freezeReported = true;
    reportStabilityCustom(
      "perf_freeze",
      {
        duration_ms: elapsedMs,
        window_id: state.windowId,
        web_contents_id: state.webContentsId,
      },
      windowScene,
    );
    logger.warn("[stability] perf_freeze reported", {
      windowId: state.windowId,
      webContentsId: state.webContentsId,
      durationMs: elapsedMs,
    });
  }

  if (!state.freezeReported && !state.crashReported) {
    state.pollTimer = setTimeout(() => pollUnresponsiveState(state, logger), 1_000);
    state.pollTimer.unref?.();
  }
}

function attachWebContentsStabilityWatch(
  win: BrowserWindow,
  webContents: WebContents,
  logger: StabilityLogger,
): void {
  const webContentsId = webContents.id;

  webContents.on("unresponsive", () => {
    clearUnresponsiveWatch(webContentsId);
    const state: UnresponsiveWatchState = {
      windowId: win.id,
      webContentsId,
      windowScene: resolveRegisteredWindowScene(win),
      startedAt: Date.now(),
      anrReported: false,
      freezeReported: false,
      crashReported: false,
      pollTimer: null,
    };
    unresponsiveByWebContentsId.set(webContentsId, state);
    logger.warn("[stability] webContents unresponsive", {
      windowId: win.id,
      webContentsId,
      url: webContents.getURL(),
    });
    pollUnresponsiveState(state, logger);
  });

  webContents.on("responsive", () => {
    logger.info("[stability] webContents responsive", {
      windowId: win.id,
      webContentsId,
    });
    clearUnresponsiveWatch(webContentsId);
  });

  webContents.on("destroyed", () => {
    clearUnresponsiveWatch(webContentsId);
  });
}

export function configureDesktopStabilityTelemetry(context: StabilityGlobalContext): void {
  globalContext = context;
  armsRum.setConfig("properties", {
    device_mid: context.deviceMid,
    platform: normalizeOsCategory(context.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
  });
}

/** 与 @arms/rum-electron pv-collector 的 initial_load 窗口对齐，避免早于首屏 PV 单独 flush */
const PERF_APP_START_AFTER_VIEW_MS = 3_200;

export function reportPerfAppStart(logger: StabilityLogger): void {
  if (perfAppStartReported) {
    return;
  }
  perfAppStartReported = true;
  lifecycleScene = "cold_start";
  reportStabilityCustom("perf_app_start", {}, "main", "cold_start");
  lifecycleScene = "runtime";
  logger.info("[stability] perf_app_start reported");
}

/**
 * 在主窗口首屏加载完成后再上报 perf_app_start。
 * 原因：过早 sendCustom 时 view 仍为 __default__，且可能与 renderer PV 分属不同上报批次；
 * ARMS 原始日志里常见只有 PV、看不到同 session 的 custom。
 */
export function scheduleReportPerfAppStartAfterMainViewReady(
  webContents: WebContents,
  logger: StabilityLogger,
): void {
  if (perfAppStartReported || webContents.isDestroyed()) {
    return;
  }

  const reportAfterView = (): void => {
    if (perfAppStartReported || webContents.isDestroyed()) {
      return;
    }
    setTimeout(() => {
      if (!webContents.isDestroyed()) {
        reportPerfAppStart(logger);
      }
    }, PERF_APP_START_AFTER_VIEW_MS);
  };

  if (webContents.isLoading()) {
    webContents.once("did-finish-load", reportAfterView);
    return;
  }

  reportAfterView();
}

export function registerStabilityMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || mainWindowIds.has(win.id)) {
    return;
  }
  mainWindowIds.add(win.id);
  win.once("closed", () => {
    mainWindowIds.delete(win.id);
  });
}

export function notifyStabilityLifecycle(scene: StabilityLifecycleScene): void {
  lifecycleScene = scene;
}

export function getStabilityLifecycleScene(): StabilityLifecycleScene {
  return lifecycleScene;
}

export function notifyStabilityAppExit(
  scene: StabilityLifecycleScene,
  logger: StabilityLogger,
  options?: { exitCode?: number; exitKind?: string },
): void {
  // Bug 根因：旧实现上报 perf_app_exit 后立即恢复 runtime；Agent/Host 的异步退出事件
  // 因而丢失 app_quit/update_install 边界并被误计为 crash。退出流程一旦开始就不可逆，
  // lifecycle 必须保持到主进程终止。
  lifecycleScene = scene;
  reportStabilityCustom("perf_app_exit", {
    exit_code: options?.exitCode ?? 0,
    exit_kind: options?.exitKind ?? "normal",
  });
  logger.info("[stability] perf_app_exit reported", { scene, exitCode: options?.exitCode ?? 0 });
}

function reportPerfCrash(
  classification: StabilityCrashClassification,
  logger: StabilityLogger,
  properties: Record<string, string | number | boolean | undefined>,
  win?: BrowserWindow | null,
): void {
  const crashProperties = {
    crash_id: randomUUID(),
    crash_kind: classification.crashKind,
    crash_scope: classification.crashScope,
    crash_cause: classification.crashCause,
    crash_source: "electron_callback",
    ...properties,
  };
  // Bugfix: 旧实现按 crash_kind 做五分钟去重，会吞掉同类但不同进程的真实事故。
  // Electron 的 gone 回调本身就是单次事故边界，这里每个回调只上报一次。
  reportStabilityCustom("perf_crash", crashProperties, resolveWindowScene(win));
  logger.error("[stability] perf_crash reported", crashProperties);
}

function reportPerfProcessExit(
  logger: StabilityLogger,
  properties: Record<string, string | number | boolean | undefined>,
  win?: BrowserWindow | null,
): void {
  reportStabilityCustom("perf_process_exit", properties, resolveWindowScene(win));
  // Bug 原因：perf_process_exit 同时承载受控退出和可恢复的 helper 异常退出。
  // 旧实现统一使用 error，导致正常生命周期被 ARMS console collector 误计为异常。
  const logLevel = properties.exit_kind === "normal" ? "info" : "warn";
  logger[logLevel]("[stability] perf_process_exit reported", properties);
}

export function registerDesktopStabilityMonitors(
  logger: StabilityLogger,
  crashPaths: CrashCapturePaths,
): void {
  registerBaseCrashEventMonitor(logger, crashPaths, {
    onRenderProcessGone: (webContents, details) => {
      markWebContentsCrash(webContents.id);
      const win = BrowserWindow.fromWebContents(webContents);
      const input: RenderProcessGoneInput = {
        reason: details.reason,
        exitCode: details.exitCode,
        webContentsType: webContents.getType(),
        // 必须使用崩溃 WebContents 自身所属窗口；回退到当前焦点窗会把辅助窗误判成主业务窗。
        windowScene: resolveRegisteredWindowScene(win),
      };
      const classification = classifyRenderProcessCrash(input);
      if (classification) {
        reportPerfCrash(
          classification,
          logger,
          {
            exit_code: details.exitCode,
            exit_reason: details.reason,
            process_role: "renderer",
            web_contents_type: webContents.getType(),
            web_contents_id: webContents.id,
            window_id: win?.id,
          },
          win,
        );
      } else {
        reportPerfProcessExit(
          logger,
          {
            exit_code: details.exitCode,
            exit_reason: details.reason,
            process_role: "renderer",
            exit_kind: "normal",
            web_contents_id: webContents.id,
          },
          win,
        );
      }
    },
    onChildProcessGone: (details) => {
      // 修复原因：Electron 将 utilityProcess.fork() 的自定义标识放在 serviceName，
      // name 只表示 Chromium Utility 服务名（如 Network Service）。只读 name 会把
      // Host 归为 utility，导致 Host 异常退出走 recoverable_child_crash 而不是 perf_crash。
      const processName = details.serviceName?.trim() || details.name?.trim() || "";
      const role = mapChildProcessGoneToProcessRoleWithName(details.type, processName);
      if (details.reason === "killed" || details.reason === "clean-exit") {
        reportPerfProcessExit(logger, {
          exit_code: details.exitCode,
          exit_reason: details.reason,
          process_role: role,
          exit_kind: "normal",
          process_type: details.type,
          process_name: processName,
        });
      } else if (!shouldReportChildProcessGoneAsCrash({ ...details, name: processName })) {
        reportPerfProcessExit(logger, {
          exit_code: details.exitCode,
          exit_reason: details.reason,
          process_role: role,
          exit_kind: "recoverable_child_crash",
          process_type: details.type,
          process_name: processName,
        });
      } else {
        reportPerfCrash(
          {
            crashKind: mapExitReasonToCrashKind(details.reason),
            crashScope: role === "host" ? "host" : "child",
            crashCause: mapExitReasonToCrashCause(details.reason),
          },
          logger,
          {
            exit_code: details.exitCode,
            exit_reason: details.reason,
            process_role: role,
            process_type: details.type,
            process_name: processName,
          },
        );
      }
    },
    onBrowserWindowCreated: (win) => {
      attachWebContentsStabilityWatch(win, win.webContents, logger);
    },
  });
}
