export function webRemoteControlV2PairState(status: "waiting" | "matched") {
  return status === "matched" ? "paired" : "waiting_terminal";
}

/**
 * 连接建立后第一次重连的打散窗口，电脑与手机共用。
 * 窗口加连接耗时必须小于桌面 3 秒手机断连宽限（MOBILE_DISCONNECT_STATUS_GRACE_MS），
 * 否则短断线会被当成确认断连，关闭手机终端并让 bridge 失效。
 */
export const WEB_REMOTE_CONTROL_V2_RECONNECT_SPREAD_MS = 1_500;

/** 每个 transport 实例独占，auth_ack 只清退避，不清 KICKED 窗口。 */
export class WebRemoteControlV2RetryPolicy {
  private failures = 0;
  private spreadNext = false;
  private lastKickAt?: number;
  constructor(
    private readonly random: () => number = Math.random,
    private readonly backoff = {
      initialMs: 1000,
      maxMs: 30_000,
      jitter: 0.2,
      spreadMs: WEB_REMOTE_CONTROL_V2_RECONNECT_SPREAD_MS,
    },
  ) {}
  /** 用户触发的连接（start、回前台）：清退避，按原曲线尽快重连，不打散。 */
  reset(): void {
    this.failures = 0;
    this.spreadNext = false;
  }
  /** 连接已建立：清退避，下一次重连可能与同一 relay 上的其他设备同时发生。 */
  acknowledged(): void {
    this.failures = 0;
    this.spreadNext = true;
  }
  nextDelay(): number {
    // Bugfix: 每次重连都申请一次性 token。relay 重启时所有设备同时断线，原退避第1次只有
    // ±20%（手机 0.4~0.6秒），token 请求挤在同一时刻。连接建立后的第1次重连在整个打散窗口内
    // 随机；只打散这一次，失败后回到原曲线，避免 relay 短暂不可用后恢复时间被拉长。
    // Bugfix: 窗口曾取电脑 10 秒、手机 5 秒，大于桌面 3 秒手机断连宽限，短断线也会结束手机终端
    // owner（关闭 PTY、bridge 失效）。现两端共用 WEB_REMOTE_CONTROL_V2_RECONNECT_SPREAD_MS。
    if (this.spreadNext) {
      this.spreadNext = false;
      return Math.floor(this.random() * this.backoff.spreadMs);
    }
    const base = Math.min(
      this.backoff.maxMs,
      this.backoff.initialMs * 2 ** Math.min(this.failures++, 16),
    );
    return Math.min(
      this.backoff.maxMs,
      Math.round(base * (1 - this.backoff.jitter + this.random() * this.backoff.jitter * 2)),
    );
  }
  kickedDelay(now = Date.now()): number | null {
    if (this.lastKickAt !== undefined && now - this.lastKickAt < 60_000) return null;
    this.lastKickAt = now;
    return 2000 + Math.floor(this.random() * 3001);
  }
}
