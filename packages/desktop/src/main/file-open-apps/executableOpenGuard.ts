import { realpath } from "node:fs/promises";
import { basename, win32 } from "node:path";
import type { Locale } from "@zcode/shared";
import { BrowserWindow, dialog } from "electron";

/**
 * 交给系统打开前的可执行类文件确认（spec：docs/file-preview-open-apps.md「可执行类文件的打开确认」）。
 *
 * Bug 根因：导入分享曾把发布者可控的文件名落成 .terminal，用户点「在 终端 中打开」就执行了其中命令。
 * 导入侧已修复落盘扩展名；这里是所有本机文件经系统关联打开时的第二道防线，只确认、不禁止。
 * 后缀表按平台拆分：只列该平台交给系统打开会执行的类型，避免对普通源码反复打扰。
 */
const EXECUTABLE_EXTENSIONS: Partial<Record<NodeJS.Platform, ReadonlySet<string>>> = {
  darwin: new Set([
    "app",
    "command",
    "tool",
    "terminal",
    "scpt",
    "scptd",
    "applescript",
    "workflow",
    "action",
    "pkg",
    "mpkg",
    "fileloc",
    "inetloc",
    "webloc",
    "mobileconfig",
    "jar",
    "osax",
    "prefpane",
  ]),
  win32: new Set([
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "hta",
    "lnk",
    "url",
    "scr",
    "pif",
    "msi",
    "msp",
    "reg",
    "cpl",
    "inf",
    "appref-ms",
    "settingcontent-ms",
    "jar",
  ]),
  linux: new Set(["desktop", "sh", "run", "appimage", "jar"]),
};

/** macOS 上会把任意文件当脚本执行的应用（file-open-apps 的 darwin-bundle 身份）。 */
const MACOS_SCRIPT_RUNNER_IDENTITIES = new Set([
  "darwin-bundle:com.apple.terminal",
  "darwin-bundle:com.googlecode.iterm2",
  "darwin-bundle:com.apple.scripteditor2",
  "darwin-bundle:com.apple.automator",
]);

function fileExtension(path: string): string {
  // Windows 路径可能带反斜杠；NFKC 让全角后缀与系统识别的 ASCII 后缀一致。
  const name = win32.basename(basename(path)).normalize("NFKC").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/** 路径本身或其真实目标（符号链接）命中当前平台的可执行类后缀时返回 true。 */
export async function isExecutableFilePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const extensions = EXECUTABLE_EXTENSIONS[platform];
  if (!extensions) return false;
  const target = await realpath(path).catch(() => path);
  return extensions.has(fileExtension(path)) || extensions.has(fileExtension(target));
}

export function isScriptRunnerApplication(
  identity: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === "darwin" &&
    MACOS_SCRIPT_RUNNER_IDENTITIES.has(identity?.trim().toLowerCase() ?? "")
  );
}

const MESSAGES: Record<
  Locale,
  { message: string; detail: (name: string) => string; open: string; cancel: string }
> = {
  "zh-CN": {
    message: "此文件打开后可能执行命令",
    detail: (name) => `「${name}」会被系统当作程序或脚本运行。只在你信任它的来源时继续。`,
    open: "仍然打开",
    cancel: "取消",
  },
  "en-US": {
    message: "Opening this file may run commands",
    detail: (name) =>
      `The system will run "${name}" as a program or script. Continue only if you trust where it came from.`,
    open: "Open anyway",
    cancel: "Cancel",
  },
  "ja-JP": {
    message: "このファイルを開くとコマンドが実行される可能性があります",
    detail: (name) =>
      `「${name}」はプログラムまたはスクリプトとして実行されます。入手元を信頼できる場合のみ続行してください。`,
    open: "開く",
    cancel: "キャンセル",
  },
  "ru-RU": {
    message: "Открытие этого файла может выполнить команды",
    detail: (name) =>
      `Система запустит «${name}» как программу или скрипт. Продолжайте, только если доверяете источнику.`,
    open: "Всё равно открыть",
    cancel: "Отмена",
  },
  "ko-KR": {
    message: "이 파일을 열면 명령이 실행될 수 있습니다",
    detail: (name) =>
      `"${name}"은(는) 프로그램 또는 스크립트로 실행됩니다. 출처를 신뢰하는 경우에만 계속하세요.`,
    open: "그래도 열기",
    cancel: "취소",
  },
};

/** 用户确认后返回 true；默认按钮与 Esc 都是取消。 */
export type ConfirmExecutableFileOpen = (path: string) => Promise<boolean>;

export function createExecutableFileOpenConfirmer(
  getLocale: () => Locale,
): ConfirmExecutableFileOpen {
  return async (path) => {
    const messages = MESSAGES[getLocale()];
    const options = {
      type: "warning" as const,
      title: "ZCode",
      message: messages.message,
      detail: messages.detail(win32.basename(basename(path))),
      buttons: [messages.cancel, messages.open],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const parent = BrowserWindow.getFocusedWindow();
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return response === 1;
  };
}
