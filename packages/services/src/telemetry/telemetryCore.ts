/* oxlint-disable eslint(max-lines) -- telemetry state lock、deviceMid 编排和上报路径共享同一状态文件，拆分会增加锁语义漂移风险。 */
import {
  createUuid,
  ZCODE_VERSION,
  ZCODE_ENV,
  ZCODE_TELEMETRY_REPORT_ENDPOINT,
  buildZCodeSourceHeadersFromContext,
  rewriteZCodeEndpointUrl,
  sanitizeTelemetryEventDetail,
  type TelemetryEventPayload,
  type TelemetryRendererContext,
  type OAuthLoginAttribution,
} from "@zcode/shared";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { version } from "node:os";
import { dirname, join } from "node:path";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";

const REPORT_ENDPOINT = ZCODE_TELEMETRY_REPORT_ENDPOINT;

function sessionCreateEventId(userId: string, sessionId: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["zcode:session_create:v1", userId, sessionId]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const LOCK_RETRY_DELAY_MS = 10;
const LOCK_RETRY_COUNT = 200;
const LOCK_STALE_MS = 5 * 60 * 1000;
const DAILY_ACTIVE_IN_FLIGHT_TTL_MS = 5 * 60 * 1000;
const REPORT_REQUEST_TIMEOUT_MS = 5_000;
const REPORT_RETRY_DELAY_MS = 300;
const REPORT_RATE_LIMIT_RETRY_DELAY_MS = 1_000;
const REPORT_MAX_ATTEMPTS = 2;

interface TelemetryCoreDependencies {
  fetchImpl?: typeof fetch;
  loadUserId?: () => Promise<string>;
  loadAuthorization?: (userId: string) => Promise<string | null>;
  loadMarketingParams?: () => Promise<OAuthLoginAttribution | null>;
  randomUUID?: () => string;
  now?: () => number;
  appVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  releaseChannel?: string;
  osVersion?: string;
  homeDir?: string;
  resolveZCodeEndpointOrigin?: () => Promise<string> | string;
  /**
   * 宿主的实时界面语言（Desktop Main 的 currentApplicationLocale）。
   * 有值时覆盖 renderer context 里的 clientLanguage：那是 Intl 系统语言，UI 切到 English 后
   * /api/v1/event/report 仍发 zh-CN，与其它请求的 X-Client-Language 不一致。
   */
  resolveClientLanguage?: () => string | undefined;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
}

type TelemetryFailureCategory =
  | "network"
  | "timeout"
  | "http_408"
  | "http_429"
  | "http_5xx"
  | "http_4xx"
  | "http_other";

class TelemetryReportError extends Error {
  constructor(
    readonly category: TelemetryFailureCategory,
    readonly retryable: boolean,
    status?: number,
  ) {
    super(
      status === undefined
        ? `Telemetry report failed: ${category}`
        : `Telemetry report failed with status ${status}`,
    );
  }
}

interface TelemetryState {
  lastDailyActiveDate?: string;
  deviceMid?: string;
  dailyActiveInFlight?: {
    date: string;
    startedAt: number;
  };
}

interface TelemetryLockOwner {
  pid: number;
  createdAt: number;
}

const deviceMidCacheByStateFile = new Map<string, Promise<string>>();

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

function toLocalDateKey(timestamp: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function resolveTelemetryStateFile(homeDir?: string): string {
  if (homeDir) {
    return join(homeDir, ".zcode", "v2", "telemetry-state.json");
  }
  return join(getAppConfigDir(), "telemetry-state.json");
}

function resolveTelemetryLockFile(homeDir?: string): string {
  if (homeDir) {
    return join(homeDir, ".zcode", "v2", "telemetry-state.lock");
  }
  return join(getAppConfigDir(), "telemetry-state.lock");
}

function isFreshDailyActiveInFlight(
  value: TelemetryState["dailyActiveInFlight"],
  date: string,
  timestamp: number,
): boolean {
  if (!value || value.date !== date) {
    return false;
  }

  return timestamp - value.startedAt < DAILY_ACTIVE_IN_FLIGHT_TTL_MS;
}

async function readTelemetryState(homeDir?: string): Promise<TelemetryState> {
  try {
    const raw = await readFile(resolveTelemetryStateFile(homeDir), "utf-8");
    const parsed = JSON.parse(raw) as TelemetryState;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

async function writeTelemetryState(state: TelemetryState, homeDir?: string): Promise<void> {
  const telemetryStateFile = resolveTelemetryStateFile(homeDir);
  await mkdir(dirname(telemetryStateFile), { recursive: true });
  await writeFile(telemetryStateFile, JSON.stringify(state, null, 2), "utf-8");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeStaleTelemetryLockIfNeeded(
  lockFile: string,
  timestamp: number,
): Promise<boolean> {
  try {
    const metadata = await stat(lockFile);
    if (timestamp - metadata.mtimeMs < LOCK_STALE_MS) {
      const owner = await readTelemetryLockOwner(lockFile);
      if (!owner || isProcessAlive(owner.pid)) {
        return false;
      }
    }

    await unlink(lockFile).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function readTelemetryLockOwner(lockFile: string): Promise<TelemetryLockOwner | null> {
  try {
    const raw = await readFile(lockFile, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TelemetryLockOwner>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.createdAt === "number" &&
      Number.isFinite(parsed.createdAt)
    ) {
      return {
        pid: parsed.pid,
        createdAt: parsed.createdAt,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code !== "ESRCH"
    );
  }
}

async function withTelemetryStateLock<T>(
  homeDir: string | undefined,
  run: (state: TelemetryState) => Promise<T>,
): Promise<T> {
  const lockFile = resolveTelemetryLockFile(homeDir);
  await mkdir(dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      try {
        // Bugfix: 旧锁文件只有一个空文件，崩溃后 5 分钟内无法判断是否为孤儿锁。
        // 新锁写入 owner pid，让后续进程能安全回收“刚残留但持有进程已退出”的锁。
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            createdAt: Date.now(),
          }),
          "utf-8",
        );
        const state = await readTelemetryState(homeDir);
        return await run(state);
      } finally {
        await handle.close();
        await unlink(lockFile).catch(() => {});
      }
    } catch (error) {
      const isLockConflict =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST";
      if (!isLockConflict) {
        throw error;
      }

      // Bugfix: 崩溃/强退后 telemetry-state.lock 可能遗留在磁盘上，后续所有启动都会直接卡死到超时。
      // 这里按 mtime 识别明显过期的孤儿锁并自动回收，避免用户目录里一个陈旧空文件把上报永久锁死。
      const removedStaleLock = await removeStaleTelemetryLockIfNeeded(lockFile, Date.now());
      if (removedStaleLock) {
        continue;
      }

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error("Telemetry state lock timeout");
}

export interface EnsureTelemetryDeviceMidOptions {
  homeDir?: string;
  randomUUID?: () => string;
}

function rememberDeviceMid(telemetryStateFile: string, deviceMid: string): string {
  deviceMidCacheByStateFile.set(telemetryStateFile, Promise.resolve(deviceMid));
  return deviceMid;
}

/** 调用方必须已持有 telemetry-state.lock；只在 state 缺失 deviceMid 时生成并写回。 */
async function ensureDeviceMidInLockedState(
  state: TelemetryState,
  options: EnsureTelemetryDeviceMidOptions,
): Promise<string> {
  const telemetryStateFile = resolveTelemetryStateFile(options.homeDir);
  if (state.deviceMid) {
    return rememberDeviceMid(telemetryStateFile, state.deviceMid);
  }

  // device_mid 独立生成，不再复用首条事件的 eventId：让它表达「设备标识」而非
  // 「某次上报」，并与 ARMS 侧（desktopDeviceMid）读取的同一字段保持同值。
  const deviceMid = (options.randomUUID ?? createUuid)();
  state.deviceMid = deviceMid;
  await writeTelemetryState(state, options.homeDir);
  return rememberDeviceMid(telemetryStateFile, deviceMid);
}

/**
 * 确保 telemetry-state.json 里存在 deviceMid 并返回它。
 *
 * Bug 根因：远端 zcode-server 所在主机没有 Desktop main 进程，过去没有任何进程会在那里写
 * telemetry-state.json；buildZCodeSourceHeaders() 又只读不生成，于是远端发往 ZCode endpoint 的
 * 请求永远缺 X-Device-Mid，billing/balance 被服务端拒绝为 parameter error，Start Plan 在远程
 * 工作区被判成未开通。这里把 telemetry 上报内部的 ensure 逻辑抽成独立入口，供远端 server 启动时
 * 调用：同一个文件、同一个字段、同一把 telemetry-state.lock，与同机 CLI 得到同一个设备身份。
 */
export function ensureTelemetryDeviceMid(
  options: EnsureTelemetryDeviceMidOptions = {},
): Promise<string> {
  const telemetryStateFile = resolveTelemetryStateFile(options.homeDir);
  const cached = deviceMidCacheByStateFile.get(telemetryStateFile);
  if (cached) {
    return cached;
  }

  // Bugfix: message_completion / agent_step 等高频埋点之前每条都抢 telemetry-state.lock，
  // 即使 deviceMid 已经落盘也会在 burst 场景里把 2 秒锁等待打满。这里按 state 文件缓存
  // deviceMid 的读取 promise，只在首次缺失或首次读取时进入文件锁。
  const pending = withTelemetryStateLock(options.homeDir, async (state) =>
    ensureDeviceMidInLockedState(state, options),
  ).catch((error) => {
    if (deviceMidCacheByStateFile.get(telemetryStateFile) === pending) {
      deviceMidCacheByStateFile.delete(telemetryStateFile);
    }
    throw error;
  });
  deviceMidCacheByStateFile.set(telemetryStateFile, pending);
  return pending;
}

export function createTelemetryCore(dependencies: TelemetryCoreDependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const loadUserId = dependencies.loadUserId ?? (async () => "");
  const loadMarketingParams = dependencies.loadMarketingParams ?? (async () => null);
  const telemetryLogger = createServiceLogger("telemetry-core");
  const warn = dependencies.warn ?? ((message: string) => telemetryLogger.warn(undefined, message));
  let didWarnMarketingParamsLoadFailure = false;
  const randomUUID = dependencies.randomUUID ?? (() => createUuid());
  const now = dependencies.now ?? Date.now;
  const appVersion = dependencies.appVersion ?? ZCODE_VERSION;
  const platform = dependencies.platform ?? process.platform;
  const osVersion = dependencies.osVersion ?? version();
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? REPORT_REQUEST_TIMEOUT_MS;
  const retrySleep = dependencies.sleep ?? sleep;
  const pendingReports = new Set<Promise<void>>();
  const deviceMidOptions: EnsureTelemetryDeviceMidOptions = {
    homeDir: dependencies.homeDir,
    randomUUID,
  };

  function classifyHttpFailure(status: number): TelemetryReportError {
    if (status === 408) {
      return new TelemetryReportError("http_408", true, status);
    }
    if (status === 429) {
      return new TelemetryReportError("http_429", true, status);
    }
    if (status >= 500 && status <= 599) {
      return new TelemetryReportError("http_5xx", true, status);
    }
    if (status >= 400 && status <= 499) {
      return new TelemetryReportError("http_4xx", false, status);
    }
    return new TelemetryReportError("http_other", false, status);
  }

  async function sendReportAttempt(
    endpoint: string,
    body: string,
    headers: Record<string, string>,
    userId: string,
  ): Promise<void> {
    let authorization: string | null = null;
    try {
      authorization = (await dependencies.loadAuthorization?.(userId)) ?? null;
    } catch {
      // 凭据不可读时匿名上报，不打印原始异常，也不阻断业务事件。
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), requestTimeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
          ...(authorization ? { Authorization: authorization } : {}),
        },
        // 不把带身份的上报转发至服务端重定向目标。
        redirect: "error",
        body,
        signal: abortController.signal,
      });
    } catch {
      throw new TelemetryReportError(abortController.signal.aborted ? "timeout" : "network", true);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw classifyHttpFailure(response.status);
    }
  }

  async function sendReport(
    payload: TelemetryEventPayload,
    rendererContext: TelemetryRendererContext,
    eventId: string,
    userId: string,
    deviceMid: string,
  ): Promise<void> {
    // 构建期未配置事件上报端点时不上报（见 docs/desktop/build-time-optional-capabilities.md）
    if (!REPORT_ENDPOINT) return;
    // body 的 client_language 与 X-Client-Language 同源，都取发送时刻的界面语言。
    const hostClientLanguage = dependencies.resolveClientLanguage?.()?.trim();
    const context = hostClientLanguage
      ? { ...rendererContext, clientLanguage: hostClientLanguage }
      : rendererContext;
    let marketingParams: OAuthLoginAttribution | null = null;
    try {
      marketingParams = await loadMarketingParams();
    } catch {
      // 修复原因：营销归因只是 telemetry 的附加上下文，凭据损坏或暂时不可读
      // 不应阻断原事件；同一 core 只告警一次，避免高频埋点持续刷屏。
      if (!didWarnMarketingParamsLoadFailure) {
        didWarnMarketingParamsLoadFailure = true;
        // 凭据后端异常可能带本机路径或堆栈；生产日志只保留固定、脱敏的降级事件。
        warn("Telemetry marketing attribution load failed; continuing without attribution");
      }
    }
    const requestBody = JSON.stringify({
      event_id: eventId,
      client_timezone: context.clientTimezone,
      client_language: context.clientLanguage,
      element_name: payload.elementName,
      event_region: payload.eventRegion,
      event_type: payload.eventType,
      event_text: payload.eventText ?? "",
      // 修复原因：Host/Main 或旧 Renderer 可绕过 UI 清洗，最终出网统一禁止错误原文与登录 URL 秘密。
      event_extra_detail: sanitizeTelemetryEventDetail(
        payload.elementName,
        payload.eventExtraDetail,
      ),
      user_id: userId,
      screen_resolution: context.screenResolution,
      app_version: appVersion,
      device_os_category: normalizeOsCategory(platform),
      device_os_version: osVersion,
      device_mid: deviceMid,
      mac_id: "",
      marketing_params: JSON.stringify(marketingParams ?? {}),
      ...(payload.talkId ? { talk_id: payload.talkId } : {}),
      ...(payload.messageId ? { message_id: payload.messageId } : {}),
    });

    const endpoint = String(
      rewriteZCodeEndpointUrl(
        REPORT_ENDPOINT,
        (await dependencies.resolveZCodeEndpointOrigin?.()) ?? REPORT_ENDPOINT,
      ),
    );

    const headers = buildZCodeSourceHeadersFromContext({
      appVersion,
      platform,
      arch: dependencies.arch ?? process.arch,
      osVersion,
      releaseChannel: dependencies.releaseChannel ?? ZCODE_ENV,
      clientLanguage: context.clientLanguage,
      clientTimezone: context.clientTimezone,
      deviceMid,
      endpointOrigin: new URL(endpoint).origin,
    });
    const startedAt = Date.now();
    let lastError: TelemetryReportError | null = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= REPORT_MAX_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      try {
        await sendReportAttempt(endpoint, requestBody, headers, userId);
        return;
      } catch (error) {
        lastError =
          error instanceof TelemetryReportError ? error : new TelemetryReportError("network", true);
        if (!lastError.retryable || attempt === REPORT_MAX_ATTEMPTS) {
          break;
        }

        // 修复原因：公共 /event/report 过去遇到瞬时网络故障会直接丢事件。这里只记录脱敏的
        // attempt 元数据并有界重试，禁止把 payload、响应体或原始错误写入生产日志。
        telemetryLogger.debug(
          undefined,
          `retry event=${payload.elementName} eventId=${eventId} attempt=${attempt} category=${lastError.category}`,
        );
        await retrySleep(
          lastError.category === "http_429"
            ? REPORT_RATE_LIMIT_RETRY_DELAY_MS
            : REPORT_RETRY_DELAY_MS,
        );
      }
    }

    const finalError = lastError ?? new TelemetryReportError("network", true);
    warn(
      `Telemetry report failed; event=${payload.elementName} eventId=${eventId} attempts=${attempts} category=${finalError.category} elapsedMs=${Date.now() - startedAt}`,
    );
    throw finalError;
  }

  function trackReport(report: Promise<void>): Promise<void> {
    const tracked = report.finally(() => pendingReports.delete(tracked));
    pendingReports.add(tracked);
    return tracked;
  }

  async function flushPendingReports({ timeoutMs }: { timeoutMs: number }): Promise<void> {
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    });

    try {
      // 修复原因：退出 drain 如果只拍一次 Set 快照，会漏掉屏障等待期间刚进入 Main 的 IPC
      // 上报。每批 settled 后重新读取集合，直到为空或命中同一个总 deadline。
      while (!timedOut && pendingReports.size > 0) {
        await Promise.race([Promise.allSettled(pendingReports), deadline]);
      }
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }

    if (pendingReports.size > 0) {
      warn(`Telemetry flush timed out; pending=${pendingReports.size}`);
    }
  }

  return {
    reportEvent(input: {
      context: TelemetryRendererContext;
      elementName: string;
      eventRegion: string;
      eventType: string;
      eventText?: string;
      eventExtraDetail: Record<string, string>;
      userId?: string;
      talkId?: string;
      messageId?: string;
    }): Promise<void> {
      return trackReport(
        (async () => {
          const userId = input.userId ?? (await loadUserId());
          // 重复回调/跨宿主重报同一 Session 必须保留事件身份；不能每次生成随机 ID。
          // UUIDv8 表达应用自定义的 SHA-256 映射，来源与设备变化不产生新的创建事件。
          const eventId =
            input.elementName === "session_create" && input.talkId
              ? sessionCreateEventId(userId, input.talkId)
              : randomUUID();
          const deviceMid = await ensureTelemetryDeviceMid(deviceMidOptions);

          await sendReport(
            {
              elementName: input.elementName,
              eventRegion: input.eventRegion,
              eventType: input.eventType,
              eventText: input.eventText,
              eventExtraDetail: input.eventExtraDetail,
              userId,
              talkId: input.talkId,
              messageId: input.messageId,
            },
            input.context,
            eventId,
            userId,
            deviceMid,
          );
        })(),
      );
    },

    reportAppLaunch(context: TelemetryRendererContext): Promise<void> {
      return trackReport(
        (async () => {
          const eventId = randomUUID();
          const userId = await loadUserId();
          const deviceMid = await ensureTelemetryDeviceMid(deviceMidOptions);

          await sendReport(
            {
              elementName: "app_launch",
              eventRegion: "app",
              eventType: "view",
              eventExtraDetail: { ui_mode: context.uiMode ?? "unknown" },
              userId,
            },
            context,
            eventId,
            userId,
            deviceMid,
          );
        })(),
      );
    },

    reportAppDailyActive(context: TelemetryRendererContext): Promise<void> {
      return trackReport(
        (async () => {
          const timestamp = now();
          const today = toLocalDateKey(timestamp, context.clientTimezone);
          const userId = await loadUserId();
          const pendingReport = await withTelemetryStateLock(
            dependencies.homeDir,
            async (state) => {
              if (state.lastDailyActiveDate === today) {
                return null;
              }

              if (isFreshDailyActiveInFlight(state.dailyActiveInFlight, today, timestamp)) {
                return null;
              }

              const eventId = randomUUID();
              const deviceMid = await ensureDeviceMidInLockedState(state, deviceMidOptions);
              // Bugfix: 之前 reportAppDailyActive 会在持锁状态下直接执行网络请求。
              // 启动期 app_launch / app_daily_active / reportEvent 一旦并发，后来的调用会一直卡在锁外，
              // 最终稳定打出 "Telemetry state lock timeout"。这里改成短锁写入 in-flight 标记，
              // 锁外发送网络请求，成功后再短锁提交完成态，既保留跨实例去重，也不再把整个 telemetry 通道锁死。
              state.dailyActiveInFlight = {
                date: today,
                startedAt: timestamp,
              };
              await writeTelemetryState(state, dependencies.homeDir);
              return { eventId, deviceMid };
            },
          );

          if (!pendingReport) {
            return;
          }

          try {
            await sendReport(
              {
                elementName: "app_daily_active",
                eventRegion: "app",
                eventType: "view",
                eventExtraDetail: { ui_mode: context.uiMode ?? "unknown" },
                userId,
              },
              context,
              pendingReport.eventId,
              userId,
              pendingReport.deviceMid,
            );
          } catch (error) {
            await withTelemetryStateLock(dependencies.homeDir, async (state) => {
              if (state.dailyActiveInFlight?.date === today) {
                delete state.dailyActiveInFlight;
                await writeTelemetryState(state, dependencies.homeDir);
              }
            });
            throw error;
          }

          await withTelemetryStateLock(dependencies.homeDir, async (state) => {
            state.lastDailyActiveDate = today;
            if (state.dailyActiveInFlight?.date === today) {
              delete state.dailyActiveInFlight;
            }
            await writeTelemetryState(state, dependencies.homeDir);
          });
        })(),
      );
    },

    // 接纳上游已收到但尚未开始 HTTP 上报的完整投递 Promise，共用既有 pending 与退出预算。
    trackPendingReport: trackReport,
    flushPendingReports,
  };
}
