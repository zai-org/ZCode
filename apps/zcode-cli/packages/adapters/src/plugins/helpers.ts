import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { type Dirent, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { scanSkillFilesUnderRoot } from "../skills/scan.js";

const PLUGIN_FS_RETRY_DELAYS_MS = [0, 25, 100] as const;

export async function writePluginTextIfChanged(path: string, contents: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === contents) return;
  } catch {
    // 与原写入语义一致：读失败继续写，让实际写入错误向上传递。
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, "utf8");
    // 异步读写允许查询交错；原子替换避免读者看到半份目录或命令。
    for (const [index, delayMs] of PLUGIN_FS_RETRY_DELAYS_MS.entries()) {
      if (delayMs > 0) await delay(delayMs);
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        // Windows 索引器可能短暂占用目标；有界重试仍保留旧文件与原子替换。
        const code = (error as NodeJS.ErrnoException).code;
        if (
          !["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"].includes(code ?? "") ||
          index === PLUGIN_FS_RETRY_DELAYS_MS.length - 1
        )
          throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function resolveInside(rootPath: string, rawPath: string): string | null {
  if (isAbsolute(rawPath)) return null;
  const resolved = resolve(rootPath, rawPath);
  const rel = relative(rootPath, resolved);
  if (rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`))) return resolved;
  return null;
}

export function sanitizePluginId(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9_.@-]/g, "-");
}

export function parsePathList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

export function isPluginOptionValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function cleanupPluginSourceBestEffort(
  cleanup: (() => Promise<void>) | undefined,
  retryDelaysMs: readonly number[] = PLUGIN_FS_RETRY_DELAYS_MS,
): Promise<unknown> {
  if (!cleanup) return undefined;
  let cleanupError: unknown;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    try {
      await cleanup();
      return undefined;
    } catch (error) {
      cleanupError = error;
    }
  }
  return cleanupError;
}

export function appendPluginSourceCleanupError(
  primaryError: unknown,
  cleanupError: unknown,
): unknown {
  if (cleanupError === undefined || !(primaryError instanceof Error)) return primaryError;
  const cleanupMessage =
    cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  // 临时目录删除失败只能作为附加诊断，不能覆盖下载、校验或解压的原始错误。
  primaryError.message = `${primaryError.message}; plugin source cleanup also failed: ${cleanupMessage}`;
  return primaryError;
}

export function throwIfAborted(options: { signal?: AbortSignal } | undefined): void {
  if (options?.signal?.aborted) throw new Error("Plugin operation cancelled");
}

export async function directoryExistsAsync(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
export async function fileExistsAsync(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
/**
 * 「路径缺失」只认 ENOENT/ENOTDIR（stat 的精确错误码）。EACCES 等权限错误
 * 不是缺失——调用方不得据此发「不存在」诊断，避免把权限问题误报成 manifest 配错。
 */
export async function isMissingPathAsync(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

const PLUGIN_MATERIAL_ENTRY_LIMIT = 512;
const PLUGIN_METADATA_BATCH_SIZE = 32;
export const PLUGIN_MATERIAL_READ_CONCURRENCY = 4;
const PLUGIN_DIRECTORY_ENTRY_OVERHEAD_BYTES = 128;
const PLUGIN_MATERIAL_BYTE_LIMIT = 4 * 1024 * 1024;
const PLUGIN_SOURCE_CHANGED_CODE = "ZCODE_PLUGIN_SOURCES_CHANGED";
const PLUGIN_STANDARD_ENTRY_NAMES = new Set([
  ".zcode-plugin",
  ".claude-plugin",
  ".codex-plugin",
  ".mcp.json",
  "skills",
  "commands",
  "agents",
  "hooks",
  "hooks.json",
  "skill.md",
]);

type PluginPathState =
  | { fingerprint: string; kind: "file" | "directory" | "other" }
  | { fingerprint: string; kind: "missing"; code: "ENOENT" | "ENOTDIR" };
interface PluginMaterialEntry {
  fingerprint: string;
  value: unknown;
  bytes: number;
}
export interface PluginMaterialReader {
  parsed<T>(
    path: string,
    kind: "json" | "frontmatter" | "text",
    parse: (contents: string) => T,
  ): Promise<T>;
  json(path: string): Promise<unknown>;
  text(path: string): Promise<string>;
  directory(path: string): Promise<Dirent[]>;
  /** 插件技能入口：自身有技能时停止，否则扫描一层集合。 */
  skillFiles(path: string, followSymbolicLinks?: boolean): Promise<string[]>;
  fileExists(path: string): Promise<boolean>;
  directoryExists(path: string): Promise<boolean>;
  missing(path: string): Promise<boolean>;
  observe(path: string): Promise<PluginPathState["kind"]>;
  validate(): Promise<boolean>;
}

/** 只保留原始解析材料；每次发现有自己的依赖清单与配置投影，返回值不共享可写引用。 */
export class PluginMaterialCache {
  private readonly entries = new Map<string, PluginMaterialEntry>();
  private readonly reads = new Set<Promise<void>>();
  private readonly flights = new Map<
    string,
    { revision: number; fingerprint: string; promise: Promise<PluginMaterialEntry> }
  >();
  private readonly controller = new AbortController();
  private revision = 0;
  private bytes = 0;
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  invalidate(): void {
    this.revision += 1;
    this.entries.clear();
    this.flights.clear();
    this.bytes = 0;
  }
  dispose(): void {
    this.controller.abort();
    this.invalidate();
  }

  reader(scope: string): PluginMaterialReader {
    const revision = this.revision;
    const observed = new Map<string, PluginPathState>();
    const inspections = new Map<string, Promise<PluginPathState>>();
    const directories = new Map<string, Set<string>>();
    const skillScans = new Map<string, Promise<string[]>>();
    const assertCurrent = () => {
      this.controller.signal.throwIfAborted();
      if (revision !== this.revision) throw pluginSourcesChanged();
    };
    const inspect = async (path: string) => {
      assertCurrent();
      // 先共享在途检查，避免并发调用在第一次 stat 完成前各查一遍。
      const previous = inspections.get(path);
      if (previous) return previous;
      const inspection = (async (): Promise<PluginPathState> => {
        for (let parent = dirname(path); ; parent = dirname(parent)) {
          const names = directories.get(parent);
          if (names) {
            const name = relative(parent, path).split(sep)[0]!.toLowerCase();
            // 只推断标准入口；父目录已加入复核清单，新增入口会使本次结果失效。
            if (PLUGIN_STANDARD_ENTRY_NAMES.has(name) && !names.has(name))
              return { kind: "missing", fingerprint: "ENOENT", code: "ENOENT" };
            break;
          }
          if (parent === dirname(parent)) break;
        }
        const state = await readPluginPathState(path);
        assertCurrent();
        observed.set(path, state);
        return state;
      })();
      inspections.set(path, inspection);
      return inspection;
    };
    const parsed = async <T>(
      path: string,
      kind: "json" | "frontmatter" | "text",
      parse: (contents: string) => T,
    ): Promise<T> => {
      const state = await inspect(path);
      const entry = await this.load(scope, path, kind, state, revision, async () => {
        const contents = await readFile(path, { encoding: "utf8", signal: this.signal });
        return { value: parse(contents), bytes: Buffer.byteLength(contents, "utf8") };
      });
      assertCurrent();
      return structuredClone(entry.value) as T;
    };
    const exists = async (path: string, kind: "file" | "directory") => {
      try {
        return (await inspect(path))?.kind === kind;
      } catch (error) {
        rethrowPluginMaterialInterrupt(error);
        return false;
      }
    };
    const reader: PluginMaterialReader = {
      parsed,
      json: (path) => parsed(path, "json", JSON.parse),
      text: (path) => parsed(path, "text", (value) => value),
      directory: async (path) => {
        const state = await inspect(path);
        const entry = await this.load(scope, path, "directory", state, revision, async () => {
          const entries = await readdir(path, { withFileTypes: true });
          return {
            value: entries.map((item) => Object.freeze(item)),
            bytes: entries.reduce(
              (sum, item) =>
                sum + Buffer.byteLength(item.name, "utf8") + PLUGIN_DIRECTORY_ENTRY_OVERHEAD_BYTES,
              0,
            ),
          };
        });
        assertCurrent();
        const entries = entry.value as Dirent[];
        // ASCII 标准入口按大小写等价匹配；Unicode/文件系统别名不确定时保留实际探测。
        if (entries.every((item) => /^[\x20-\x7e]+$/.test(item.name)))
          directories.set(path, new Set(entries.map((item) => item.name.toLowerCase())));
        return [...entries];
      },
      skillFiles: async (path, followSymbolicLinks = false) => {
        assertCurrent();
        const key = JSON.stringify([resolve(path), followSymbolicLinks]);
        let scan = skillScans.get(key);
        if (!scan) {
          // 计数、诊断和详情必须共用本次扫描，但不能把文件列表沿用到下一次查询。
          scan = scanSkillFilesUnderRoot(path, {
            followSymbolicLinks,
            stopAtSkill: true,
            readDirectory: reader.directory,
            observe: reader.observe,
          });
          skillScans.set(key, scan);
        }
        const files = await scan;
        assertCurrent();
        return [...files];
      },
      fileExists: (path) => exists(path, "file"),
      directoryExists: (path) => exists(path, "directory"),
      missing: async (path) => {
        try {
          return (await inspect(path)).kind === "missing";
        } catch (error) {
          rethrowPluginMaterialInterrupt(error);
          return false;
        }
      },
      observe: async (path) => {
        return (await inspect(path)).kind;
      },
      validate: async () => {
        assertCurrent();
        const paths = [...observed];
        for (let offset = 0; offset < paths.length; offset += PLUGIN_METADATA_BATCH_SIZE) {
          const current = await Promise.all(
            paths
              .slice(offset, offset + PLUGIN_METADATA_BATCH_SIZE)
              .map(
                async ([path, state]) =>
                  (await readPluginPathState(path)).fingerprint === state.fingerprint,
              ),
          );
          assertCurrent();
          if (current.includes(false)) return false;
        }
        assertCurrent();
        return true;
      },
    };
    return reader;
  }

  private async load(
    scope: string,
    path: string,
    kind: string,
    state: PluginPathState,
    revision: number,
    read: () => Promise<{ value: unknown; bytes: number }>,
  ): Promise<PluginMaterialEntry> {
    this.signal.throwIfAborted();
    if (revision !== this.revision) throw pluginSourcesChanged();
    const key = JSON.stringify([scope, kind, resolve(path)]);
    const previous = this.entries.get(key);
    if (previous && previous.fingerprint === state.fingerprint) return previous;
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(key);
    }
    // 缺失路径已经加入本次复核清单，不再为可选文件发起必然失败的读取。
    if (state.kind === "missing")
      throw Object.assign(new Error(`Plugin material not found: ${path}`), {
        code: state.code,
        path,
      });
    let flight = this.flights.get(key);
    if (!flight || flight.revision !== revision || flight.fingerprint !== state.fingerprint) {
      const promise = Promise.resolve().then(async () => {
        // owner 内共享名额，避免多个查询各自四路读取时累加压满文件系统。
        while (this.reads.size >= PLUGIN_MATERIAL_READ_CONCURRENCY) await Promise.race(this.reads);
        this.signal.throwIfAborted();
        if (revision !== this.revision) throw pluginSourcesChanged();
        const reading = read();
        const finished = reading.then(
          () => {},
          () => {},
        );
        this.reads.add(finished);
        let material: { value: unknown; bytes: number };
        try {
          material = await reading;
        } finally {
          this.reads.delete(finished);
        }
        const after = await readPluginPathState(path);
        this.signal.throwIfAborted();
        if (revision !== this.revision || state.fingerprint !== after.fingerprint)
          throw pluginSourcesChanged();
        const entry = { ...material, fingerprint: after.fingerprint };
        // 超预算材料仍可用，只是不保留；无需为本轮增加淘汰策略或后台 watcher。
        if (
          this.entries.size < PLUGIN_MATERIAL_ENTRY_LIMIT &&
          this.bytes + entry.bytes <= PLUGIN_MATERIAL_BYTE_LIMIT
        ) {
          this.entries.set(key, entry);
          this.bytes += entry.bytes;
        }
        return entry;
      });
      flight = { revision, fingerprint: state.fingerprint, promise };
      this.flights.set(key, flight);
      const current = flight;
      void promise.then(
        () => {
          if (this.flights.get(key) === current) this.flights.delete(key);
        },
        () => {
          if (this.flights.get(key) === current) this.flights.delete(key);
        },
      );
    }
    return flight.promise;
  }
}

async function readPluginPathState(path: string): Promise<PluginPathState> {
  try {
    const [info, canonical] = await Promise.all([stat(path, { bigint: true }), realpath(path)]);
    return {
      kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
      fingerprint: JSON.stringify([
        canonical,
        String(info.dev),
        String(info.ino),
        String(info.size),
        String(info.mtimeNs),
        String(info.ctimeNs),
        String(info.mode),
      ]),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return { kind: "missing", fingerprint: code, code };
    throw error;
  }
}

export function pluginSourcesChanged(): Error & { code: string } {
  return Object.assign(new Error("Plugin sources changed during discovery"), {
    code: PLUGIN_SOURCE_CHANGED_CODE,
  });
}
export function isPluginMaterialChange(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === PLUGIN_SOURCE_CHANGED_CODE;
}
export function rethrowPluginMaterialInterrupt(error: unknown): void {
  if (
    isPluginMaterialChange(error) ||
    (error as { name?: string } | undefined)?.name === "AbortError"
  )
    throw error;
}

/** 消费者取消只结束本次等待，不取消其他调用者共用的材料读取。 */
export async function waitForPluginQuery<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason);
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      }),
    ]);
  } finally {
    if (cancel) signal.removeEventListener("abort", cancel);
  }
}
