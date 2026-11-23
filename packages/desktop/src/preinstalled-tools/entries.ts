import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  PreinstalledToolEntry,
  PreinstalledToolInstallation,
} from "@zcode/shared/preinstalled-tools";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const isWindows = process.platform === "win32";
/** 被撤下但仍在运行、暂时删不掉的 shim 副本；规格见 docs/preinstalled-tools/windows-entry-shim.md。 */
const RETIRED_DIR = ".retired";

/** 运行检查与公开入口共用占位符解析，不另维护一套工具启动参数。 */
export function expandPreinstalledValue(
  value: string,
  installationDir: string,
  checkTempDir?: string,
): string {
  const values: Record<string, string | undefined> = {
    INSTALL_DIR: installationDir,
    INSTALL_DIR_URL: pathToFileURL(installationDir).href,
    CHECK_TEMP_DIR: checkTempDir,
    CHECK_TEMP_URL: checkTempDir ? pathToFileURL(checkTempDir).href : undefined,
  };
  return value.replace(
    /\$\{(INSTALL_DIR|INSTALL_DIR_URL|CHECK_TEMP_DIR|CHECK_TEMP_URL)\}/g,
    (_match, name: string) => {
      const replacement = values[name];
      if (replacement === undefined) throw new Error(`入口缺少占位符上下文: ${name}`);
      return replacement;
    },
  );
}

/** 入口在 bin 目录中的可执行文件名：Windows 是 shim 副本，其他平台是 sh 脚本。 */
export function preinstalledEntryExecutable(name: string): string {
  return isWindows ? `${name}.exe` : name;
}

/** 一个入口在 bin 目录中占用的全部文件名。 */
export function preinstalledEntryFiles(name: string): string[] {
  return isWindows ? [`${name}.exe`, `${name}.shim`] : [name];
}

async function writeAtomically(directory: string, name: string, content: string | Buffer) {
  const temporary = join(directory, `.${name}-${randomUUID()}`);
  try {
    await writeFile(temporary, content, { mode: 0o755 });
    await rename(temporary, join(directory, name));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 尽力删除已撤下的 shim 副本；仍在运行的留给下次入口维护，失败不影响入口状态。 */
async function cleanRetiredEntries(binDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(join(binDir, RETIRED_DIR));
  } catch {
    return;
  }
  await Promise.all(
    names.map((name) => rm(join(binDir, RETIRED_DIR, name), { force: true }).catch(() => {})),
  );
}

/**
 * Windows 上运行中的 .exe 不能删除，也不能被 rename 覆盖，但可以改名移走（13 号票实测）。
 * 改名后新调用立即找不到入口；正在运行的调用照常跑完并返回目标的退出码。
 */
async function retireExecutable(binDir: string, name: string): Promise<void> {
  const retired = join(binDir, RETIRED_DIR, `${name.replace(/\.exe$/i, "")}-${randomUUID()}.exe`);
  await mkdir(join(binDir, RETIRED_DIR), { recursive: true });
  try {
    await rename(join(binDir, name), retired);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(retired, { force: true }).catch(() => {});
}

/** 撤下一个 bin 文件；Windows 上的 .exe 先改名移走，其他文件直接删除。 */
export async function removePreinstalledEntryFile(binDir: string, name: string): Promise<void> {
  if (isWindows && name === RETIRED_DIR) return cleanRetiredEntries(binDir);
  if (isWindows && /\.exe$/i.test(name)) return retireExecutable(binDir, name);
  await rm(join(binDir, name), { recursive: true, force: true });
}

const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

async function writeWindowsEntries(
  binDir: string,
  record: PreinstalledToolInstallation,
  checkTempDir: string | undefined,
  windowsEntryShim: string | undefined,
): Promise<void> {
  if (!windowsEntryShim) throw new Error("缺少 Windows 入口 shim，无法写入预装工具入口");
  const shimHash = await sha256(windowsEntryShim);
  const expand = (value: string) =>
    expandPreinstalledValue(value, record.installationDir, checkTempDir);
  for (const entry of record.entries) {
    const config = {
      schemaVersion: 1,
      target: join(record.installationDir, entry.target),
      args: entry.args.map(expand),
      env: entry.env.map((variable) =>
        variable.action === "unset"
          ? { name: variable.name, action: variable.action }
          : { name: variable.name, action: variable.action, value: expand(variable.value) },
      ),
    };
    // 先写配置再放入 .exe：.exe 出现时入口才可见，可见时配置一定已就绪。
    await writeAtomically(binDir, `${entry.name}.shim`, JSON.stringify(config));
    const executable = `${entry.name}.exe`;
    const current = await sha256(join(binDir, executable)).catch(() => undefined);
    if (current === shimHash) continue;
    if (current !== undefined) await retireExecutable(binDir, executable);
    const temporary = join(binDir, `.${executable}-${randomUUID()}`);
    try {
      await copyFile(windowsEntryShim, temporary);
      await rename(temporary, join(binDir, executable));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await cleanRetiredEntries(binDir);
}

/** 入口只是安装记录的派生文件；写入前记录已经发布，初始化按记录恢复。 */
export async function writePreinstalledEntries(
  binDir: string,
  record: PreinstalledToolInstallation,
  options: { checkTempDir?: string; windowsEntryShim?: string } = {},
): Promise<void> {
  await mkdir(binDir, { recursive: true });
  if (isWindows)
    return writeWindowsEntries(binDir, record, options.checkTempDir, options.windowsEntryShim);
  for (const entry of record.entries) {
    const expand = (value: string) =>
      expandPreinstalledValue(value, record.installationDir, options.checkTempDir);
    const arguments_ = [join(record.installationDir, entry.target), ...entry.args.map(expand)];
    const shellEnvironment = entry.env.map((variable) => {
      if (variable.action === "unset") return `unset ${variable.name}`;
      const assign = `export ${variable.name}=${shellQuote(expand(variable.value))}`;
      return variable.action === "set"
        ? assign
        : `if [ "\${${variable.name}+x}" != x ]; then ${assign}; fi`;
    });
    await writeAtomically(
      binDir,
      entry.name,
      `#!/bin/sh\n${shellEnvironment.join("\n")}\nexec ${arguments_.map(shellQuote).join(" ")} "$@"\n`,
    );
  }
}

/** 只撤本工具的入口；其他工具继续可用。Windows 上先移走 .exe，再删配置。 */
export async function removePreinstalledEntries(
  binDir: string,
  entries: readonly PreinstalledToolEntry[],
): Promise<void> {
  for (const entry of entries)
    for (const name of preinstalledEntryFiles(entry.name))
      await removePreinstalledEntryFile(binDir, name);
  if (isWindows) await cleanRetiredEntries(binDir);
}
