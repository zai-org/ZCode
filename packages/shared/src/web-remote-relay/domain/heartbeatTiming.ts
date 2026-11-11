export const WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS = 5_000;
export const WEB_REMOTE_CONTROL_V2_HEARTBEAT_JITTER_MS = 1_000;
export const WEB_REMOTE_CONTROL_V2_HEARTBEAT_ACK_TIMEOUT_MS = 15_000;

function safeRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(0.999999999, Math.max(0, value));
}

export function getWebRemoteControlHeartbeatJitterMs(
  baseIntervalMs = WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS,
  configuredJitterMs?: number,
): number {
  const normalizedBase =
    Number.isFinite(baseIntervalMs) && baseIntervalMs > 0
      ? Math.floor(baseIntervalMs)
      : WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS;
  const defaultJitterMs = Math.min(
    WEB_REMOTE_CONTROL_V2_HEARTBEAT_JITTER_MS,
    Math.floor(normalizedBase * 0.2),
  );
  const requestedJitterMs = configuredJitterMs ?? defaultJitterMs;
  if (!Number.isFinite(requestedJitterMs) || requestedJitterMs <= 0) {
    return 0;
  }
  // 心跳 jitter 必须小于基准间隔，避免把合法的 transport heartbeat 变成 0ms 风暴。
  return Math.min(Math.floor(requestedJitterMs), Math.max(0, normalizedBase - 1));
}

export function getWebRemoteControlHeartbeatDelayMs(
  baseIntervalMs = WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS,
  configuredJitterMs?: number,
  random: () => number = Math.random,
): number {
  const normalizedBase =
    Number.isFinite(baseIntervalMs) && baseIntervalMs > 0
      ? Math.floor(baseIntervalMs)
      : WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS;
  const jitterMs = getWebRemoteControlHeartbeatJitterMs(normalizedBase, configuredJitterMs);
  const minDelayMs = Math.max(1, normalizedBase - jitterMs);
  const maxDelayMs = normalizedBase + jitterMs;
  return minDelayMs + Math.floor(safeRandom(random) * (maxDelayMs - minDelayMs + 1));
}
