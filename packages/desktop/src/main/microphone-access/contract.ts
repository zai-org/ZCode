/**
 * desktop-microphone-access 对外契约：Main 进程的麦克风系统权限与系统设置跳转。
 * Renderer 只经 preload 的两个 IPC 频道调用，见 docs/chat/composer-voice-input.md「麦克风权限」。
 */
import type { MicrophoneAccessResult } from "@zcode/shared";

export interface DesktopMicrophoneAccessContract {
  /** 注册 MicrophoneAccess / OpenMicrophoneSettings 两个 IPC 处理器；只调用一次 */
  registerDesktopMicrophoneIpcHandlers(logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  }): void;
  /** macOS 未询问过时弹出系统授权；Linux 及无法判定时返回 unsupported */
  ensureMicrophoneAccess(platform?: NodeJS.Platform): Promise<MicrophoneAccessResult>;
}
