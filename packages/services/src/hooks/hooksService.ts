import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  Hook,
  HookEvent,
  SettingsDirectoryLocation,
  SettingsDirectorySource,
} from "@zcode/shared";
import {
  resolveWorkspaceHookTrustIdentity,
  type WorkspaceHookTrustIdentityFs,
} from "@zcode/shared/managed-worktree";
import {
  buildWorkspaceHookBundleSnapshot,
  createWorkspaceHookSourceInput,
  readWorkspaceHookProjectSources,
  resolveWorkspaceHookRuntimeRoot,
  workspaceHooksConfigSchema,
  type WorkspaceHookBundleSnapshotData,
  type WorkspaceHookSourceInput,
  type WorkspaceHooksConfig,
} from "@zcode/shared/workspace-hook-discovery";
import { parseWorkspaceHookTrustStoreContent } from "@zcode/shared/workspace-hook-trust-store-file";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import { getDataBaseDir } from "#src/paths.js";
import type { IHooksService } from "./hooks.js";
import { updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";
import {
  fromLegacyHooksConfig,
  fromProjectSnapshot,
  fromUserZCodeSource,
  resolveNextRootEnabled,
  toZCodeHooksEvents,
  type LegacyHooksConfig,
} from "./workspaceHookSettingsModel.js";

/** Trust identity resolver 的只读文件端口（Host 侧 node:fs/promises 适配）。 */
const trustIdentityFs: WorkspaceHookTrustIdentityFs = {
  readFile: (path) => readFile(path, "utf8"),
  realpath: (path) => realpath(path),
  stat: async (path) => {
    const info = await stat(path).catch(() => null);
    return info ? { isFile: info.isFile(), isDirectory: info.isDirectory() } : null;
  },
};

const SETTINGS_FILE = "settings.json";
const ZCODE_CONFIG_FILE = "config.json";
const HOOK_EVENTS: readonly HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

interface ZCodeConfigFile {
  hooks?: WorkspaceHooksConfig;
  [key: string]: unknown;
}

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getRootDir(source: SettingsDirectorySource, workspacePath?: string): string {
  const baseDir = workspacePath ?? resolveUserHomeDir();
  if (source === "zcode") {
    return workspacePath ? join(baseDir, ".zcode") : join(baseDir, ".zcode", "cli");
  }
  return join(baseDir, source === "agents" ? ".agents" : ".claude");
}

function getConfigPath(source: SettingsDirectorySource, workspacePath?: string): string {
  return join(
    getRootDir(source, workspacePath),
    source === "zcode" ? ZCODE_CONFIG_FILE : SETTINGS_FILE,
  );
}

function buildLocation(
  source: SettingsDirectorySource,
  workspacePath?: string,
): SettingsDirectoryLocation {
  return {
    source,
    scope: workspacePath ? "project" : "user",
    directoryPath: getRootDir(source, workspacePath),
    ...(workspacePath ? { projectPath: workspacePath } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

async function readUserZCodeSource(): Promise<WorkspaceHookSourceInput | undefined> {
  const path = getConfigPath("zcode");
  const config = await readJsonFile<Record<string, unknown>>(path);
  const parsed = workspaceHooksConfigSchema.safeParse(config?.hooks);
  if (!parsed.success) return undefined;
  return {
    ...createWorkspaceHookSourceInput({
      path,
      workingDirectory: resolveUserHomeDir(),
      hooks: parsed.data,
      discoveryOrder: 0,
      explicitProjectConfig: true,
    }),
    editable: true,
  };
}

async function loadLegacyHooksFromLocation(
  source: "agents" | "claude",
  workspacePath?: string,
): Promise<Hook[]> {
  return fromLegacyHooksConfig({
    legacyConfig: await readJsonFile<LegacyHooksConfig>(getConfigPath(source, workspacePath)),
    location: buildLocation(source, workspacePath),
    isHookEvent,
  });
}

/**
 * 读取持久化 workspace hook trust digest 集合。
 *
 * 整个函数不能包在 `try { ... } catch { return new Set(); }` 里：
 * 文件损坏/不可读与「无 trust 记录」无法区分且零诊断。根因：trust store 读取失败被
 * 吞掉后，调用方只能把所有 hook 标记为 `pending_trust`（"需要审核"），而 Runtime 侧
 * 对 trust store 损坏显式检测并以 `blocked_untrusted` 硬拦截——用户看到一条审核入口
 * 但无论怎样审批，Runtime 都不会放行。此为展示/运行时分歧（两侧均 fail-closed）。
 *
 * 手写的局部字段校验（isRecord + digest 正则）与 runtime/adapters
 * 使用的完整 strict schema 结论不一致——"JSON 合法但结构非法"（缺 schemaVersion、
 * 非法 decision、非法时间戳、未知字段等）的文件会被本层当作部分可信，runtime 却判
 * corrupt 全部阻断，UI 展示"已信任"而 Hook 永不执行。信任存储是权限边界，所有消费
 * 者必须对同一文件得出同一结论：改用 shared 的
 * parseWorkspaceHookTrustStoreContent（contracts schema 的单一权威下沉实现），
 * 任何 parse 失败一律 corrupt + fail-closed，不返回任何部分 digest。
 *
 * 注意：存储目录解析（storage.dir 的 ~/、相对路径处理）与 Runtime 侧
 * resolveWorkspaceHookTrustStorePath（adapters）逻辑等价但各自内联——架构上 services
 * 不应反向依赖 adapters，统一需下沉到 shared 层，此处仅记录该重复。
 */
async function readPersistentWorkspaceHookTrustDigests(
  workspaceIdentity: string,
  logger: ServiceLogger,
): Promise<{ digests: Set<string>; corrupt: boolean }> {
  const userConfig = (await readJsonFile<Record<string, unknown>>(getConfigPath("zcode"))) ?? {};
  const storage = isRecord(userConfig.storage) ? userConfig.storage : {};
  const configured = typeof storage.dir === "string" ? storage.dir.trim() : "";
  const home = resolveUserHomeDir();
  const storageRoot = configured
    ? configured.startsWith("~/")
      ? join(home, configured.slice(2))
      : isAbsolute(configured)
        ? resolve(configured)
        : resolve(home, configured)
    : join(home, ".zcode");
  const trustFilePath = join(storageRoot, "security", "workspace-hook-trust-v1.json");

  // 异步读取 + ENOENT 区分：不用 existsSync 预检——同步调用会阻塞服务
  // 线程，且「检查→读取」之间存在 TOCTOU 窗口；readFile 的 ENOENT 本身就是
  // 权威的"文件不存在"信号。
  let content: string;
  try {
    content = await readFile(trustFilePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      // 文件不存在 ⇒ 合理无记录，返回空集且不标记 corrupt。
      return { digests: new Set<string>(), corrupt: false };
    }
    // services 层曾直接 console.warn，无法进入统一服务日志文件，也无法在
    // 测试中注入 sink。改用可注入 ServiceLogger；此为低频可恢复降级，使用 warn。
    logger.warn(
      undefined,
      "Workspace Hook Trust store 不可读，已 fail-closed 忽略全部持久信任记录",
      {
        path: trustFilePath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return { digests: new Set<string>(), corrupt: true };
  }

  // JSON 语法错误与 schema 校验失败统一判 corrupt（与 runtime/adapters 同判）。
  const parsedStore = parseWorkspaceHookTrustStoreContent(content);
  if (parsedStore.status === "invalid") {
    logger.warn(
      undefined,
      "Workspace Hook Trust store 结构不符合 schema，已 fail-closed 忽略全部持久信任记录",
      { path: trustFilePath },
    );
    return { digests: new Set<string>(), corrupt: true };
  }

  const digests = new Set<string>(
    parsedStore.file.records
      .filter((record) => record.workspaceIdentity === workspaceIdentity)
      .map((record) => record.hookDeclarationDigest),
  );
  return { digests, corrupt: false };
}

async function loadHooksImpl(
  params: {
    workspaceIdentity?: string;
    workspacePath: string;
    scope?: "all" | "user";
  },
  logger: ServiceLogger,
): Promise<{
  hooks: Hook[];
  hooksEnabled: boolean;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshotData;
}> {
  const workspacePath = resolve(params.workspacePath);
  if (params.scope === "user") {
    const userSource = await readUserZCodeSource();
    const runtimeRoot = resolveWorkspaceHookRuntimeRoot([userSource?.hooks]);
    const hooks = [
      ...fromUserZCodeSource({
        source: userSource,
        runtimeRoot,
        workspacePath,
        location: buildLocation("zcode"),
      }),
      ...(await loadLegacyHooksFromLocation("agents")),
      ...(await loadLegacyHooksFromLocation("claude")),
    ];
    return { hooks, hooksEnabled: hooks.some((hook) => hook.enabled) };
  }
  // 对外字段（snapshot、Settings 行）保持 workspaceKey：review binding 与路由按它匹配（D23）。
  const workspaceIdentity = params.workspaceIdentity?.trim() || workspacePath;
  // Trust identity 只用于读取持久 Trust record，必须与 CLI 侧同一 resolver 计算：
  // 受管 worktree 归一到源仓库，其余 workspace 等于 workspaceKey。
  const trustIdentity = await resolveWorkspaceHookTrustIdentity(
    { workspacePath, workspaceIdentity: params.workspaceIdentity, dataBaseDir: getDataBaseDir() },
    trustIdentityFs,
  );
  const [{ sources: projectSources }, userSource] = await Promise.all([
    readWorkspaceHookProjectSources({ workingDirectory: workspacePath }),
    readUserZCodeSource(),
  ]);
  const runtimeRoot = resolveWorkspaceHookRuntimeRoot([
    userSource?.hooks,
    ...projectSources.map((source) => source.hooks),
  ]);
  const workspaceHookSnapshot = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity,
    workspacePath,
    sources: projectSources,
    runtimeRoot,
  });
  const persistentTrust = await readPersistentWorkspaceHookTrustDigests(trustIdentity, logger);
  const persistentTrustedDigests = persistentTrust.digests;
  const hooks = [
    ...fromProjectSnapshot({
      sources: projectSources,
      snapshot: workspaceHookSnapshot,
      workspaceIdentity,
      workspacePath,
      persistentTrustedDigests,
    }),
    ...(await loadLegacyHooksFromLocation("agents", workspacePath)),
    ...(await loadLegacyHooksFromLocation("claude", workspacePath)),
    ...fromUserZCodeSource({
      source: userSource,
      runtimeRoot,
      workspacePath,
      location: buildLocation("zcode"),
    }),
    ...(await loadLegacyHooksFromLocation("agents")),
    ...(await loadLegacyHooksFromLocation("claude")),
  ];
  return {
    hooks,
    hooksEnabled: hooks.some((hook) => hook.enabled),
    ...(workspaceHookSnapshot ? { workspaceHookSnapshot } : {}),
    ...(persistentTrust.corrupt ? { trustStoreCorrupt: true } : {}),
  };
}

/**
 * 根因：旧实现写入前用 readJsonFile 读取，读失败或 JSON 损坏时返回 null 并按空对象写回，
 * config.json 里的 MCP、插件等其他配置会被冲掉。
 * 修法：改用 updateJsonObjectFile——文件损坏时报错不写，写前重读，只改 hooks 字段，原子替换。
 */
async function writeZCodeHooksConfig(
  workspacePath: string | undefined,
  hooks: Hook[],
): Promise<void> {
  await updateJsonObjectFile(getConfigPath("zcode", workspacePath), (current) => {
    const existingConfig = current as ZCodeConfigFile;
    const enabled = resolveNextRootEnabled(existingConfig.hooks?.enabled, hooks);
    return {
      ...existingConfig,
      hooks: {
        ...existingConfig.hooks,
        ...(enabled !== undefined ? { enabled } : {}),
        events: toZCodeHooksEvents(hooks),
      },
    };
  });
}

async function saveHooksImpl(params: {
  workspaceIdentity?: string;
  workspacePath: string;
  scope?: "all" | "user";
  hooks: Hook[];
}): Promise<void> {
  const currentProjectConfigPath = resolve(params.workspacePath, ".zcode", "config.json");
  const userHooks = params.hooks.filter(
    (hook) =>
      hook.editable !== false &&
      (!hook.location || (hook.location.source === "zcode" && hook.location.scope === "user")),
  );
  const projectHooks = params.hooks.filter(
    (hook) =>
      hook.editable !== false &&
      hook.location?.source === "zcode" &&
      hook.location.scope === "project" &&
      (!hook.configuredState ||
        resolve(hook.configuredState.sourcePath) === currentProjectConfigPath),
  );
  await writeZCodeHooksConfig(undefined, userHooks);
  if (params.scope !== "user") {
    await writeZCodeHooksConfig(params.workspacePath, projectHooks);
  }
}

export function createHooksService(
  options: {
    logger?: ServiceLogger;
    grantWorkspaceHookTrust?: NonNullable<IHooksService["grantWorkspaceHookTrust"]>;
  } = {},
): IHooksService {
  const logger = options.logger ?? createServiceLogger("hooks-service");
  return {
    loadHooks: (params) => loadHooksImpl(params, logger),
    saveHooks: saveHooksImpl,
    ...(options.grantWorkspaceHookTrust
      ? { grantWorkspaceHookTrust: options.grantWorkspaceHookTrust }
      : {}),
  };
}
