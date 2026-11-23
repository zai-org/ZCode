import { execFile } from "node:child_process";
import { lstat, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
// 外部探针有执行预算；超时只表示无法判定，绝不能据此允许删除。
const PROCESS_PROBE_TIMEOUT_MS = 10_000;

export class PreinstalledToolsInUse extends Error {
  constructor(message = "受管资源仍在使用，或无法确认是否空闲", options?: ErrorOptions) {
    super(message, options);
  }
}

interface WindowsProcesses {
  paths: string[];
  /** 读不到路径的进程名，已转小写。 */
  pathlessNames: string[];
}

function isWithin(root: string, target: string): boolean {
  const normalized = process.platform === "win32" ? target.toLowerCase() : target;
  const base = process.platform === "win32" ? root.toLowerCase() : root;
  const rest = relative(base, normalized);
  return !isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`);
}

/**
 * 根因：旧探针把读不到路径的本用户进程都判为“无法确认”。ctfmon 等进程常驻且未提权时读不到路径，
 * Windows 上工具永远删不掉；逐个查所有者还要约 16 秒，超过探针预算。这里不再查所有者，
 * 读不到路径的进程改为比对进程名（见 assertDirectoriesIdle）。
 */
async function windowsProcesses(): Promise<WindowsProcesses> {
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $rows=@(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; path=$_.ExecutablePath; name=$_.Name } }); ConvertTo-Json -InputObject $rows -Compress`;
  const { stdout } = await exec(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: PROCESS_PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
  );
  const value: unknown = JSON.parse(stdout.trim());
  if (!Array.isArray(value) || value.length === 0) throw new Error("无法读取 Windows 进程表");
  const pids = new Set<number>();
  const paths: string[] = [];
  const pathlessNames: string[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      !("pid" in item) ||
      typeof item.pid !== "number" ||
      !("name" in item) ||
      typeof item.name !== "string"
    )
      throw new Error("Windows 进程记录无效");
    pids.add(item.pid);
    if ("path" in item && typeof item.path === "string" && item.path) paths.push(item.path);
    else pathlessNames.push(item.name.toLowerCase());
  }
  if (!pids.has(process.pid)) throw new Error("进程表缺少当前预装进程");
  return { paths, pathlessNames };
}

/** 读不到路径时只剩进程名可用：与目录内文件同名就无法排除占用，宁可拒绝删除。 */
async function assertNoPathlessProcessNamedLike(root: string, names: string[]): Promise<void> {
  const running = new Set(names);
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }))
    if (!entry.isDirectory() && running.has(entry.name.toLowerCase()))
      throw new PreinstalledToolsInUse();
}

async function assertMacDirectoryIdle(directory: string): Promise<void> {
  // ps 的 comm 可能只有 basename；lsof 匹配真实程序/库映射，txt 过滤避免普通读取阻塞删除。
  // lsof 无匹配时 exit=1；有 p 字段即表示占用，不能因 exit=1 把在用程序误当空闲。
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await exec(
      "/usr/sbin/lsof",
      ["-n", "-P", "-a", "-u", String(process.getuid!()), "-d", "txt", "+D", directory, "-F0pf"],
      { timeout: PROCESS_PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (error) {
    const result = error as { code?: unknown; stdout?: string; stderr?: string };
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    if (result.code !== 1) throw error;
  }
  if (stdout.split("\0").some((field) => /^\n?p\d+$/.test(field)))
    throw new PreinstalledToolsInUse();
  if (stderr.trim() || stdout.trim()) throw new Error("无法确认受管目录的进程占用");
}

async function linuxProcessProgram(pid: string): Promise<string | undefined> {
  try {
    return await readlink(join("/proc", pid, "exe"));
  } catch (error) {
    // 根因：ssh-agent 等 non-dumpable 进程即使属于本用户，读 exe 也会 EACCES。
    // 旧实现把它当成“无法确认”，只要机器上有这类进程，删除和旧版本回收就永远被拒绝。
    // 入口以绝对路径 exec 目标，资源程序的 argv[0] 必在版本目录内；这类进程的 cmdline 仍可读。
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    const argv0 = (await readFile(join("/proc", pid, "cmdline"), "utf8")).split("\0")[0] ?? "";
    if (!isAbsolute(argv0)) return undefined;
    // argv[0] 是调用时的写法，可能经过数据根的符号链接；与 exe 一样按真实路径比较。
    return await realpath(argv0).catch(() => argv0);
  }
}

async function assertDirectoriesIdle(
  directories: string[],
  windows?: WindowsProcesses,
): Promise<void> {
  const roots = await Promise.all(directories.map((directory) => realpath(directory)));
  if (process.platform === "darwin") {
    for (const directory of roots) await assertMacDirectoryIdle(directory);
    return;
  }
  if (process.platform === "win32") {
    for (const path of windows!.paths)
      if (roots.some((root) => isWithin(root, path))) throw new PreinstalledToolsInUse();
    for (const root of roots) await assertNoPathlessProcessNamedLike(root, windows!.pathlessNames);
    return;
  }
  if (process.platform !== "linux") throw new Error("当前系统没有进程占用探针");
  const uid = process.getuid!();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await readFile(join("/proc", name, "status"), "utf8");
      if (Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== uid) continue;
      const executable = await linuxProcessProgram(name);
      if (executable && roots.some((root) => isWithin(root, executable)))
        throw new PreinstalledToolsInUse();
    } catch (error) {
      // 内核线程没有 exe，已退出进程会消失；其它失败不能被解释为没有占用。
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        (error as NodeJS.ErrnoException).code !== "ESRCH"
      )
        throw error;
    }
  }
}

/** 无法确认占用等同于在用；串行归属由工具 owner 保证，不创建磁盘锁。 */
export async function assertPreinstalledDirectoriesIdle(directories: string[]): Promise<void> {
  const present: string[] = [];
  for (const directory of directories) {
    try {
      await lstat(directory);
      present.push(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (present.length === 0) return;
  try {
    await assertDirectoriesIdle(
      present,
      process.platform === "win32" ? await windowsProcesses() : undefined,
    );
  } catch (error) {
    if (error instanceof PreinstalledToolsInUse) throw error;
    throw new PreinstalledToolsInUse("进程占用检查未完成", { cause: error });
  }
}
export async function guardedRemoveDirectories(directories: string[]): Promise<void> {
  await assertPreinstalledDirectoriesIdle(directories);
  for (const directory of directories) await removePreinstalledDirectory(directory);
}

/**
 * 根因：Windows 上进程刚退出时，句柄释放有不到 100 毫秒的延迟（实测），立即删除会报 EPERM。
 * 系统没有“句柄已释放”的通知可等，所以用 rm 自带的重试，它只对 EPERM、EBUSY 这类错误生效。
 */
export async function removePreinstalledDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
