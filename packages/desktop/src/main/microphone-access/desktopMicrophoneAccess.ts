import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  MicrophoneAccessResetResult,
  MicrophoneAccessResult,
  MicrophoneSettingsTarget,
} from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import { app, ipcMain, shell, systemPreferences } from "electron";

const execFileAsync = promisify(execFile);
const SAFE_BUNDLE_ID = /^[A-Za-z0-9.-]+$/;

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

/** 当前 App 的 bundle id，读自运行中的 .app 的 Info.plist（TCC 按它记录授权） */
async function readOwnBundleId(): Promise<string> {
  // process.execPath = <App>.app/Contents/MacOS/<可执行文件>
  const plist = join(dirname(dirname(process.execPath)), "Info.plist");
  const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    plist,
  ]);
  const bundleId = stdout.trim();
  if (!SAFE_BUNDLE_ID.test(bundleId)) throw new Error(`invalid bundle id: ${bundleId}`);
  return bundleId;
}

/**
 * macOS「重新授权」（docs/chat/composer-voice-input.md「权限引导浮层」）。
 * 原因：macOS 麦克风列表没有「+」，用户拒绝过或系统静默拒绝后，askForMediaAccess 不再弹框，
 * 设置页里也可能找不到 ZCode。只重置 ZCode 自己的记录，让系统重新弹框，用户仍需点「允许」。
 * 是否需要重启由重置后的状态决定，不做计时判断。
 */
export async function resetMicrophoneAccess(logger: {
  warn: (...args: unknown[]) => void;
}): Promise<MicrophoneAccessResetResult> {
  if (process.platform !== "darwin") return "failed";
  const before = systemPreferences.getMediaAccessStatus("microphone");
  // 已允许（例如用户刚在系统设置里打开）时不重置，避免删掉有效授权。
  if (before === "granted") return "granted";
  // MDM 限制不能由用户解除，重置没有意义。
  if (before === "restricted") return "failed";
  // 开发版是所有未改名 Electron 共用的 com.github.Electron，TCC 按路径记录，按 bundle id 重置无效
  // 且会影响其他项目，所以只在打包版执行 tccutil。
  if (app.isPackaged) {
    try {
      await execFileAsync("/usr/bin/tccutil", ["reset", "Microphone", await readOwnBundleId()]);
    } catch (error) {
      logger.warn(
        `[voice-input] reset microphone access failed error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return "failed";
    }
  }
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return "granted";
  if (status === "not-determined") {
    return (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
  }
  // 重置后当前进程仍读到旧结果：重启后才会重新弹框。
  return "restart-required";
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
  // 重置在 main 进程串行：多个输入框同时点「重新授权」时共用同一次结果，
  // 不会并发执行 tccutil 和系统授权请求。
  let pendingReset: Promise<MicrophoneAccessResetResult> | null = null;
  ipcMain.handle(PlatformChannels.ResetMicrophoneAccess, () => {
    pendingReset ??= resetMicrophoneAccess(logger)
      .catch((error: unknown): MicrophoneAccessResetResult => {
        logger.warn(
          `[voice-input] reset microphone access error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return "failed";
      })
      .then((result) => {
        logger.info(
          `[voice-input] reset microphone access result=${result} packaged=${app.isPackaged}`,
        );
        return result;
      })
      .finally(() => {
        pendingReset = null;
      });
    return pendingReset;
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
