import {
  mobilePushEventSchema,
  mobilePushRunSchema,
  type MobilePushStatus,
  type MobilePushEvent,
} from "@zcode/shared/web-remote-relay";
import type { WebRemoteControlDeviceTransportOptions } from "#src/main/web-remote-relay/contract.js";

export interface MobilePushConnectionContext {
  identity: string;
  status: MobilePushStatus;
  supported: boolean;
  report(event: MobilePushEvent, signal: AbortSignal): Promise<"accepted" | "ignored" | "rejected">;
}
type MobilePushLocale = NonNullable<MobilePushEvent["locale"]>;
/** 每次上报前从本机设置读取；enabled 是用户的 offline push 开关。 */
export interface MobilePushPreferences {
  enabled: boolean;
  locale: MobilePushLocale;
}
/** Main 唯一通知 owner；只走 HTTP 上报，不持有远控 WebSocket。 */
export class MobilePushConnection {
  private report: MobilePushConnectionContext["report"] | undefined;
  private identity: string | undefined;
  private status: MobilePushStatus = "unknown";
  private generation = 0;
  private lifetime = new AbortController();
  // 上报请求与资格查询分开中止：切号只中止旧上报，不能连带中止新身份 report 闭包持有的查询信号。
  private requests = new AbortController();
  private flight: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastEligibility: string | undefined;
  private readonly seen = new Set<string>();
  private readonly runs = new Map<string, { id: string; identity: string }>();
  constructor(
    private readonly resolve: (signal: AbortSignal) => Promise<MobilePushConnectionContext | null>,
    private readonly logger: Pick<
      WebRemoteControlDeviceTransportOptions["logger"],
      "info" | "warn"
    >,
  ) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), 60_000);
    this.timer.unref?.();
    void this.refresh();
  }
  invalidate(): void {
    this.generation++;
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.requests.abort();
    this.requests = new AbortController();
    this.identity = undefined;
    this.lastEligibility = undefined;
    this.status = "unknown";
    this.report = undefined;
    this.seen.clear();
    this.runs.clear();
    this.flight = undefined;
  }
  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.invalidate();
  }
  /** restart 用于登录状态变化：作废在途旧登录的查询结果，但不清理当前身份的 owner。 */
  refresh(options: { restart?: boolean } = {}): Promise<void> {
    if (options.restart) {
      this.generation++;
      this.flight = undefined;
    }
    if (this.flight) return this.flight;
    const generation = this.generation,
      signal = this.lifetime.signal;
    const operation = (async () => {
      const context = await this.resolve(signal);
      if (signal.aborted || generation !== this.generation) return;
      if (!context) {
        this.status = "unavailable";
        this.report = undefined;
        return;
      }
      // 身份只在这里比较：同账号重复登录通知只刷新资格，保留在途请求和运行 owner；
      // 切号或切环境才中止旧请求并清空归属，旧账号的执行事实不能交给新账号上报。
      if (this.identity && this.identity !== context.identity) {
        this.requests.abort();
        this.requests = new AbortController();
        this.seen.clear();
        this.runs.clear();
      }
      this.identity = context.identity;
      this.status = context.status;
      this.report = context.supported ? context.report : undefined;
      const eligibility = `${context.supported}:${context.status}`;
      if (this.lastEligibility !== eligibility) {
        this.lastEligibility = eligibility;
        this.logger.info("[mobile-push] eligibility", {
          supported: context.supported,
          status: context.status,
        });
      }
    })()
      .catch(() => {
        if (generation === this.generation) {
          this.status = "unknown";
          this.logger.warn("[mobile-push] eligibility failed", { reason: "lookup_failed" });
        }
      })
      .finally(() => {
        if (this.flight === operation) this.flight = undefined;
      });
    this.flight = operation;
    return operation;
  }
  observeRun(payload: unknown): void {
    const result = mobilePushRunSchema.safeParse(payload);
    if (!result.success || !this.identity) return;
    const run = result.data;
    this.runs.set(`${run.workspace_id}:${run.session_id}`, {
      id: run.run_id,
      identity: this.identity,
    });
    if (this.runs.size > 4096) this.runs.delete(this.runs.keys().next().value!);
  }
  send(payload: unknown, resolvePreferences: () => Promise<MobilePushPreferences>): boolean {
    const parsed = mobilePushEventSchema.safeParse(payload);
    if (!parsed.success) {
      this.logger.warn("[mobile-push] dispatch", { result: "skipped", reason: "invalid_event" });
      return false;
    }
    // 推送来源始终是桌面宿主系统，不能使用远程工作区或 Host 上报的平台。
    const desktopPlatform =
      process.platform === "win32"
        ? "windows"
        : process.platform === "darwin"
          ? "macos"
          : process.platform === "linux"
            ? "linux"
            : undefined;
    const event: MobilePushEvent = { ...parsed.data, desktop_platform: desktopPlatform };
    const fields = {
      event_id: event.event_id,
      session_id: event.session_id,
      run_id: event.run_id,
      kind: event.kind,
      event_state: event.state,
    };
    let reason: string | undefined;
    const owner = this.runs.get(`${event.workspace_id}:${event.session_id}`);
    const key = `${event.workspace_id}:${event.session_id}:${event.event_id}`;
    if (this.status !== "available") reason = "eligibility_unavailable";
    else if (owner?.identity !== this.identity || owner?.id !== event.run_id)
      reason = "run_owner_mismatch";
    else if (this.seen.has(key)) reason = "duplicate";
    else if (!this.report) reason = "transport_unavailable";
    if (reason) {
      this.logger.info("[mobile-push] dispatch", {
        ...fields,
        result: "skipped",
        reason,
        eligibility: this.status,
      });
      return false;
    }
    // 在请求开始前去重，超时或响应丢失也不重放；避免重复投递。
    this.logger.info("[mobile-push] dispatch", { ...fields, result: "http_started" });
    this.seen.add(key);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
    const report = this.report!;
    const signal = this.requests.signal;
    // owner 与去重已在事件到达时同步确认；设置读取可能排在设置写队列之后，
    // 若先 await 再校验，下一轮 running 会覆盖 owner，导致上一轮通知被误判丢弃。
    // 用户开关也在这次读取里判断：设置文件是唯一数据源，读取等待写队列，切换后下一个事件即生效。
    // 关闭时 open/resolved 都不上报，事件已计入 seen，重新打开不补发。
    void resolvePreferences()
      .then(({ enabled, locale }) => {
        signal.throwIfAborted();
        if (!enabled) return "user_disabled" as const;
        return report({ ...event, locale }, signal);
      })
      .then(
        (status) => {
          if (signal.aborted) return;
          if (status === "user_disabled")
            this.logger.info("[mobile-push] dispatch", {
              ...fields,
              result: "skipped",
              reason: status,
            });
          else this.logger.info("[mobile-push] receipt", { ...fields, status });
        },
        () => {
          this.logger.warn("[mobile-push] receipt", {
            ...fields,
            status: signal.aborted ? "cancelled" : "request_failed",
          });
        },
      );
    return true;
  }
}
