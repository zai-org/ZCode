import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { promisify } from "node:util";
import type { WindowsGitBashDiscoveryOptions, WindowsGitBashInstallation } from "./types.js";

const execFileAsync = promisify(execFile);
const FIXED_GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const REGISTRY_TIMEOUT_MS = 3000;
const MAX_INSTALL_RECORD_BYTES = 64 * 1024;
const REGISTRY_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $base = $null
    $key = $null
    try {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
      $key = $base.OpenSubKey('Software\\GitForWindows')
      if ($null -ne $key) {
        $path = $key.GetValue('InstallPath')
        if ($path -is [string] -and $path.Length -gt 0) { [Console]::WriteLine($path) }
      }
    } catch {} finally {
      if ($null -ne $key) { $key.Dispose() }
      if ($null -ne $base) { $base.Dispose() }
    }
  }
}`;

export async function discoverWindowsGitBash(
  options: WindowsGitBashDiscoveryOptions,
): Promise<WindowsGitBashInstallation | undefined> {
  if (options.platform !== "win32") return undefined;

  const env = options.env;
  const checks = new Map<string, Promise<boolean>>();
  const probe = options.isExecutable ?? isExecutableFile;
  const exists = (path: string): Promise<boolean> => {
    const key = win32.normalize(path).toLowerCase();
    let pending = checks.get(key);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => probe(path))
        .catch(() => false);
      checks.set(key, pending);
    }
    return pending;
  };
  const result = (path: string, source: "system" | "path"): WindowsGitBashInstallation => ({
    path,
    source,
  });
  const fromRoot = async (
    root: string,
    source: "system" | "path",
  ): Promise<WindowsGitBashInstallation | undefined> => {
    const normalized = normalizeRoot(root);
    if (!normalized) return undefined;
    const bash = win32.join(normalized, "bin", "bash.exe");
    if (
      (await exists(bash)) &&
      (await exists(win32.join(normalized, "cmd", "git.exe"))) &&
      (await exists(win32.join(normalized, "git-bash.exe")))
    ) {
      return result(bash, source);
    }
    return undefined;
  };

  for (const path of FIXED_GIT_BASH_PATHS) {
    if (await exists(path)) return result(path, "system");
  }

  const pathDirs = splitPath(getEnv(env, "PATH") ?? "");
  const extensions = splitPath(getEnv(env, "PATHEXT") ?? DEFAULT_PATHEXT).map((extension) =>
    extension.toLowerCase(),
  );
  if (!extensions.includes(".exe")) extensions.unshift(".exe");
  // 第一个 git 可能只是代理或精简安装；没有配套 Bash 时必须继续后面的 Git。
  for (const dir of pathDirs) {
    for (const file of ["git", ...extensions.map((extension) => `git${extension}`)]) {
      if (!(await exists(win32.join(dir, file)))) continue;
      for (const root of [win32.join(dir, ".."), win32.join(dir, "..", "..")]) {
        const bash = win32.join(root, "bin", "bash.exe");
        if (await exists(bash)) return result(bash, "path");
      }
    }
  }
  for (const dir of pathDirs) {
    if (await exists(win32.join(dir, "git-bash.exe"))) {
      const installation = await fromRoot(dir, "path");
      if (installation) return installation;
    }
  }

  for (const root of [
    ...["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
      .map((key) => getEnv(env, key))
      .filter((path): path is string => Boolean(path))
      .map((path) => win32.join(path, "Git")),
    getEnv(env, "GIT_INSTALL_ROOT"),
  ]) {
    if (!root) continue;
    const installation = await fromRoot(root, "system");
    if (installation) return installation;
  }

  let registryRoots: string[] = [];
  try {
    registryRoots = await (
      options.readRegistryInstallRoots ?? (() => readRegistryInstallRoots(env))
    )();
  } catch {
    // 安装记录不是可用性的唯一依据；读取失败后继续包管理器线索。
  }
  for (const root of registryRoots) {
    const installation = await fromRoot(root, "system");
    if (installation) return installation;
  }

  const userRoot = getEnv(env, "USERPROFILE") || homedir();
  const scoopRoots: Array<{ root: string; source: "system" | "path" }> = [];
  for (const key of ["SCOOP", "SCOOP_GLOBAL"]) {
    const root = getEnv(env, key);
    if (root) scoopRoots.push({ root, source: "system" });
  }
  const configHome = getEnv(env, "XDG_CONFIG_HOME") || win32.join(userRoot, ".config");
  try {
    const configText = await (options.readTextFile ?? readSmallTextFile)(
      win32.join(configHome, "scoop", "config.json"),
    );
    if (Buffer.byteLength(configText, "utf8") <= MAX_INSTALL_RECORD_BYTES) {
      const config: unknown = JSON.parse(configText.replace(/^\uFEFF/, ""));
      if (config && typeof config === "object" && !Array.isArray(config)) {
        for (const key of ["ROOT_PATH", "GLOBAL_PATH"]) {
          const value = Object.entries(config).find(
            ([name]) => name.toLowerCase() === key.toLowerCase(),
          )?.[1];
          if (typeof value === "string") scoopRoots.push({ root: value, source: "system" });
        }
      }
    }
  } catch {
    // Scoop 配置可缺失或损坏；不阻断默认目录与 PATH 线索。
  }
  // Scoop 的 git.exe 可以是 shims 代理，真实 Bash 在根目录的 apps/git/current 下。
  for (const dir of pathDirs) {
    if (win32.basename(dir).toLowerCase() === "shims") {
      scoopRoots.push({ root: win32.dirname(dir), source: "path" });
    }
  }
  // 布局校验不是信任校验；全局 Scoop 必须有显式线索，不猜共享 ProgramData 下的安装。
  scoopRoots.push({ root: win32.join(userRoot, "scoop"), source: "system" });
  for (const { root, source } of scoopRoots) {
    const normalized = normalizeRoot(root);
    if (!normalized) continue;
    const installation = await fromRoot(win32.join(normalized, "apps", "git", "current"), source);
    if (installation) return installation;
  }

  // 系统盘 tools 可由其他用户创建；只检测安装变量明确提供的工具根，不恢复默认兜底。
  for (const root of [
    getEnv(env, "ChocolateyToolsLocation"),
    getEnv(env, "ChocolateyBinRoot"),
    getEnv(env, "chocolatey_bin_root"),
  ]) {
    if (!root) continue;
    const toolsRoot = win32.isAbsolute(root) ? root : win32.join(systemDrive(env), root);
    const installation = await fromRoot(win32.join(toolsRoot, "git"), "system");
    if (installation) return installation;
  }
  return undefined;
}

function getEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  return value?.trim().replace(/^"/, "").replace(/"$/, "") || undefined;
}

function splitPath(value: string): string[] {
  // 设置页曾保留 PATH 条目的引号，导致自定义 Git 安装目录被拼成不存在的路径。
  return value
    .split(win32.delimiter)
    .map((entry) => entry.trim().replace(/^"/, "").replace(/"$/, ""))
    .filter(Boolean);
}

function normalizeRoot(value: string): string | undefined {
  const root = value.trim().replace(/^"/, "").replace(/"$/, "");
  return win32.isAbsolute(root) ? win32.normalize(root) : undefined;
}

function systemDrive(env: NodeJS.ProcessEnv): string {
  const drive =
    getEnv(env, "SystemDrive") ?? win32.parse(getEnv(env, "SystemRoot") ?? "C:\\Windows").root;
  return drive.endsWith("\\") ? drive : `${drive}\\`;
}

async function isExecutableFile(path: string): Promise<boolean> {
  await access(path, constants.X_OK);
  return (await stat(path)).isFile();
}

async function readSmallTextFile(path: string): Promise<string> {
  if ((await stat(path)).size > MAX_INSTALL_RECORD_BYTES)
    throw new Error("Installation record too large");
  return readFile(path, "utf8");
}

async function readRegistryInstallRoots(env: NodeJS.ProcessEnv): Promise<string[]> {
  const systemRoot = getEnv(env, "SystemRoot") ?? "C:\\Windows";
  // 通过系统 PowerShell 只读固定键并输出 UTF-8，避免 reg.exe 的本地代码页损坏中文安装路径。
  const { stdout } = await execFileAsync(
    win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", REGISTRY_SCRIPT],
    {
      windowsHide: true,
      timeout: REGISTRY_TIMEOUT_MS,
      maxBuffer: MAX_INSTALL_RECORD_BYTES,
      encoding: "utf8",
    },
  );
  return stdout
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
}
