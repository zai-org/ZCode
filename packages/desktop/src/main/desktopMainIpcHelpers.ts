import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import { shell } from "electron";
import {
  isExecutableFilePath,
  type ConfirmExecutableFileOpen,
} from "@desktop/main/file-open-apps/index.js";

type DesktopIpcLogger = {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

export async function openFileUrlInDefaultApp(
  url: string,
  logger: DesktopIpcLogger,
  confirmExecutableOpen: ConfirmExecutableFileOpen,
): Promise<void> {
  try {
    const filePath = fileURLToPath(url);
    await openPathInDefaultApp(filePath, logger, confirmExecutableOpen);
  } catch (error) {
    logger.warn("[open-external] file URL 打开失败", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function openPathInDefaultApp(
  rawPath: string,
  logger: DesktopIpcLogger,
  confirmExecutableOpen: ConfirmExecutableFileOpen,
): Promise<{ success: boolean; error?: string; cancelled?: boolean }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    const error = "empty path";
    logger.warn("[open-external] 本地文件打开失败", { path: rawPath, error });
    return { success: false, error };
  }

  const normalized = normalize(trimmed);
  let target = normalized;
  try {
    target = await realpath(normalized);
  } catch {
    // 路径不存在或无法解析时仍尝试用规范化后的原路径，让系统返回更具体的错误。
  }

  // 系统默认打开会直接执行 .terminal/.command/.bat 等文件；先让用户确认。取消不是失败。
  if ((await isExecutableFilePath(target)) && !(await confirmExecutableOpen(target))) {
    logger.info?.("[open-external] 用户取消打开可执行类文件", { path: target });
    return { success: true, cancelled: true };
  }

  try {
    const error = await shell.openPath(target);
    if (error) {
      logger.warn("[open-external] 本地文件打开失败", { path: target, error });
      return { success: false, error };
    }
    logger.info?.("[open-external] 本地文件打开成功", { path: target });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[open-external] 本地文件打开失败", { path: target, error: message });
    return { success: false, error: message };
  }
}

export async function openPathInFileManager(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    return { success: false, error: "empty path" };
  }
  const normalized = normalize(trimmed);
  let target = normalized;
  try {
    target = await realpath(normalized);
  } catch {
    // 路径不存在或无法解析时仍尝试用规范化后的原路径打开，便于定位权限等问题。
  }

  if (process.platform === "darwin") {
    return openDarwinPathInFileManager(target, logger);
  }

  const error = await shell.openPath(target);
  if (error) {
    logger.warn("[open-in-file-manager] shell.openPath 失败", {
      path: target,
      error,
    });
    return { success: false, error };
  }
  return { success: true };
}

export async function captureWindowScreenshot(senderWindow: BrowserWindow | null) {
  if (!senderWindow || senderWindow.isDestroyed()) {
    return null;
  }

  // 报错横幅里的反馈需要带上用户看到的现场。
  // 这里在 main 进程截当前窗口，避免 renderer 走屏幕录制权限或只能截到局部 DOM。
  const image = await senderWindow.webContents.capturePage();
  const buffer = image.toPNG();
  return {
    dataBase64: buffer.toString("base64"),
    filename: `zcode-error-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    contentType: "image/png",
    size: buffer.byteLength,
  };
}

async function openDarwinPathInFileManager(target: string, logger: DesktopIpcLogger) {
  const runOpen = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile("open", args, (error) => (error ? reject(error) : resolve()));
    });

  try {
    await runOpen([target]);
    return { success: true };
  } catch (firstError) {
    try {
      await runOpen(["-a", "Finder", target]);
      return { success: true };
    } catch (finderError) {
      const shellMessage = await shell.openPath(target);
      if (!shellMessage) {
        return { success: true };
      }
      logger.warn("[open-in-file-manager] macOS 打开目录均失败", {
        path: target,
        shellMessage,
        firstError: firstError instanceof Error ? firstError.message : String(firstError),
        finderError: finderError instanceof Error ? finderError.message : String(finderError),
      });
      return { success: false, error: shellMessage };
    }
  }
}
