import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";
import type { FileApplicationNativeAdapter, NativeFileApplication } from "./contract.js";
import { MAC_APPLICATION_QUERY } from "./mac.js";
import { WINDOWS_APPLICATION_SCRIPT } from "./windows.js";
import { resolveWindowsAssociationIcon } from "./windows-icon.js";
import {
  applyWindowsDefaultAssociation,
  type WindowsDefaultAssociation,
} from "./windows-default.js";
import { queryLinuxApplications, type NativeRun } from "./linux.js";

const exec = promisify(execFile);
const runNative: NativeRun = async (command, args, env, detached) => {
  if (detached) {
    // xdg-open 可能等待阅读器退出；只等待启动，避免超时把正常打开误报失败。
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return "";
  }
  const { stdout } = await exec(command, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return stdout;
};

export function parseNativeApplications(text: string): NativeFileApplication[] {
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  return parseNativeApplicationList(value);
}

function parseNativeApplicationList(value: unknown): NativeFileApplication[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is NativeFileApplication =>
    Boolean(
      item &&
      typeof item.key === "string" &&
      typeof item.name === "string" &&
      item.key.length > 0 &&
      item.name.length > 0 &&
      typeof item.isDefault === "boolean" &&
      (item.identity === undefined || typeof item.identity === "string") &&
      (item.version === undefined || typeof item.version === "string") &&
      (item.iconPath === undefined || item.iconPath === null || typeof item.iconPath === "string"),
    ),
  );
}

export function parseWindowsApplications(text: string): NativeFileApplication[] {
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const result = value as {
    applications?: unknown;
    defaultAssociation?: WindowsDefaultAssociation | null;
  };
  return applyWindowsDefaultAssociation(
    parseNativeApplicationList(result.applications),
    result.defaultAssociation,
  ).map((application) => ({
    ...application,
    // Windows 资源读取失败必须保持无图；WPS 使用独立套件入口，不能误用 Writer 资源。
    ...resolveWindowsAssociationIcon(application),
  }));
}

export function createNativeApplicationAdapter(
  platform: NodeJS.Platform = process.platform,
  run: NativeRun = runNative,
): FileApplicationNativeAdapter {
  const powershell = win32.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const windowsCall = (path: string, action: "query" | "open", handler = "", includeIcons = true) =>
    run(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-EncodedCommand",
        Buffer.from(WINDOWS_APPLICATION_SCRIPT, "utf16le").toString("base64"),
      ],
      {
        // 聊天 Markdown 链接在 Windows 上还原成 `C:/...` 正斜杠路径；Node stat 能过，
        // 但 SHCreateItemFromParsingName 会返回 E_INVALIDARG，导致菜单可列出却打不开。
        ZCODE_FILE_APP_PATH: win32.normalize(path),
        ZCODE_FILE_APP_ACTION: action,
        ZCODE_FILE_APP_HANDLER: handler,
        ZCODE_FILE_APP_INCLUDE_ICONS: includeIcons ? "1" : "0",
      },
    );
  return {
    async query(path, options) {
      if (platform === "darwin")
        return parseNativeApplications(
          await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_APPLICATION_QUERY, path]),
        );
      if (platform === "win32")
        return parseWindowsApplications(
          await windowsCall(path, "query", "", options?.includeIcons !== false),
        );
      if (platform === "linux") return queryLinuxApplications(path, run);
      return [];
    },
    async open(application, path) {
      if (platform === "darwin") {
        await run("/usr/bin/open", ["-a", application.key, "--", path]);
      } else if (platform === "win32") {
        await windowsCall(path, "open", application.key);
      } else if (platform === "linux") {
        // 桌面启动器负责 desktop Exec 字段展开，不在 Node 中手写 shell 解析。
        if (application.launchKind === "system-default")
          await run("xdg-open", [path], undefined, true);
        else await run("gio", ["launch", application.key, path]);
      } else throw new Error("platform_not_supported");
    },
  };
}
