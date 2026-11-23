import { extname, win32 } from "node:path";

const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

export function getWindowsEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const lowerKey = key.toLowerCase();
  const match = Object.keys(env).find((envKey) => envKey.toLowerCase() === lowerKey);
  return match ? env[match] : undefined;
}

/** Windows 默认 shell：环境里的 ComSpec，缺失时用裸名 cmd.exe。adapters 里所有经 cmd.exe 执行的路径共用这一条规则。 */
export function resolveWindowsComSpec(env: NodeJS.ProcessEnv): string {
  return getWindowsEnvValue(env, "ComSpec") ?? "cmd.exe";
}

export function windowsExecutableCandidates(
  file: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): string[] {
  const pathExts = getWindowsPathExts(env);
  const fileCandidates = windowsExtensionCandidates(file, pathExts);

  if (hasWindowsPathSeparator(file) || win32.isAbsolute(file)) {
    const basePath =
      !win32.isAbsolute(file) && cwd ? win32.resolve(cwd, file) : win32.normalize(file);
    return windowsExtensionCandidates(basePath, pathExts);
  }

  const dirs = splitWindowsPath(getWindowsEnvValue(env, "PATH") ?? "");
  return dirs.flatMap((dir) => fileCandidates.map((candidate) => win32.join(dir, candidate)));
}

/**
 * Windows PATH 的目录列表：按 `;` 拆分，去掉首尾的双引号，跳过空条目。
 * 修复原因：条目可以写成 `"C:\Program Files\Git\cmd"`，Node 按裸名启动时会去掉引号；
 * 原来带着引号拼路径，这样的目录里的程序都找不到。
 */
export function splitWindowsPath(value: string): string[] {
  return value
    .split(win32.delimiter)
    .map((entry) => entry.replace(/^"/, "").replace(/"$/, ""))
    .filter((entry) => entry.length > 0);
}

function windowsExtensionCandidates(file: string, pathExts: string[]): string[] {
  if (extname(file)) return [file];
  return [file, ...pathExts.map((extension) => `${file}${extension.toLowerCase()}`)];
}

function getWindowsPathExts(env: NodeJS.ProcessEnv): string[] {
  const raw = getWindowsEnvValue(env, "PATHEXT");
  const values = raw
    ?.split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
  return values && values.length > 0 ? values : DEFAULT_WINDOWS_PATHEXT;
}

function hasWindowsPathSeparator(value: string): boolean {
  return value.includes("\\") || value.includes("/");
}
