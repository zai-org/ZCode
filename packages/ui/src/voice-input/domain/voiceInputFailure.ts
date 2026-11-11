import type { VoiceInputErrorCode } from "@zcode/services";

/**
 * 语音输入失败分类与提示（docs/chat/composer-voice-input.md「失败」）。纯函数，不做 IO。
 */
export type VoiceInputOs = "mac" | "windows" | "linux";

export type VoiceInputFailure =
  | "permission_denied"
  | "no_device"
  | "device_busy"
  | "device_ended"
  | "silent"
  | "too_quiet"
  | "no_speech"
  | VoiceInputErrorCode;

export interface VoiceInputFailureNotice {
  /** i18n id；undefined 表示不提示（401 由全局登录失效弹窗处理） */
  messageId?: string;
  /** 带「打开系统设置」按钮时打开的页面 */
  settingsTarget?: "privacy" | "sound";
}

export function resolveVoiceInputOs(userAgent: string): VoiceInputOs {
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "mac";
  return "linux";
}

/** getUserMedia 的 DOMException.name → 失败分类 */
export function classifyGetUserMediaError(name: string): VoiceInputFailure {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "permission_denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "no_device";
    default:
      // NotReadableError / AbortError / 其他：设备存在但无法打开
      return "device_busy";
  }
}

// -50 dBFS ≈ 0.00316（满量程 1.0）
const TOO_QUIET_PEAK = 10 ** (-50 / 20);
const MIN_SPEECH_MS = 300;

/** 结束录音时按采集统计判断是否没有录到声音；返回 null 表示声音正常 */
export function classifyCapturedAudio(stats: {
  peak: number;
  durationMs: number;
}): VoiceInputFailure | null {
  if (stats.peak === 0) return "silent";
  if (stats.peak < TOO_QUIET_PEAK) return "too_quiet";
  if (stats.durationMs < MIN_SPEECH_MS) return "audio_too_short";
  return null;
}

export function resolveVoiceInputFailureNotice(
  failure: VoiceInputFailure,
  os: VoiceInputOs,
): VoiceInputFailureNotice {
  // Linux 桌面环境没有统一的设置页地址，只提示文字。
  const withSettings = (
    messageId: string,
    settingsTarget: "privacy" | "sound",
  ): VoiceInputFailureNotice =>
    os === "linux" ? { messageId: `${messageId}.linux` } : { messageId, settingsTarget };
  switch (failure) {
    case "permission_denied":
      // mac / Windows 的开启步骤不同，文案按系统区分。
      return os === "linux"
        ? { messageId: "voiceInput.error.permissionDenied.linux" }
        : { messageId: `voiceInput.error.permissionDenied.${os}`, settingsTarget: "privacy" };
    case "silent":
      return withSettings("voiceInput.error.silent", "privacy");
    case "no_device":
      return withSettings("voiceInput.error.noDevice", "sound");
    case "device_busy":
      return withSettings("voiceInput.error.deviceBusy", "sound");
    case "unauthorized":
      return {};
    default:
      return { messageId: `voiceInput.error.${failure}` };
  }
}
