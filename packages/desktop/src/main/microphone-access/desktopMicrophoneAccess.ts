import type { MicrophoneAccessResult, MicrophoneSettingsTarget } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import { ipcMain, shell, systemPreferences } from "electron";

// 只允许打开这里列出的固定地址，renderer 只能选 target，不能传任意 URL。
// Linux 桌面环境没有统一的设置页地址，不提供跳转（docs/chat/composer-voice-input.md）。
const MICROPHONE_SETTINGS_URLS: Partial<
  Record<NodeJS.Platform, Record<MicrophoneSettingsTarget, string>>
> = {
  darwin: {
    privacy: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    sound: "x-apple.systempreferences:com.apple.preference.sound?input",
  },
  win32: {
    privacy: "ms-settings:privacy-microphone",
    sound: "ms-settings:sound",
  },
};

export async function ensureMicrophoneAccess(
  platform: NodeJS.Platform = process.platform,
): Promise<MicrophoneAccessResult> {
  if (platform !== "darwin" && platform !== "win32") return "unsupported";
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return "granted";
  if (platform === "darwin" && status === "not-determined") {
    return (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
  }
  // Windows 的 "unknown" / "not-determined" 不能证明被拒绝，交给 getUserMedia 的真实结果。
  return status === "denied" || status === "restricted" ? "denied" : "unsupported";
}

export function registerDesktopMicrophoneIpcHandlers(logger: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}) {
  ipcMain.handle(PlatformChannels.MicrophoneAccess, async (): Promise<MicrophoneAccessResult> => {
    const result = await ensureMicrophoneAccess();
    logger.info(`[voice-input] microphone access platform=${process.platform} result=${result}`);
    return result;
  });
  ipcMain.handle(
    PlatformChannels.OpenMicrophoneSettings,
    async (_event, target: unknown): Promise<boolean> => {
      if (target !== "privacy" && target !== "sound") return false;
      const url = MICROPHONE_SETTINGS_URLS[process.platform]?.[target];
      if (!url) return false;
      try {
        await shell.openExternal(url);
        return true;
      } catch (error) {
        logger.warn(
          `[voice-input] open microphone settings failed target=${target} error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      }
    },
  );
}
