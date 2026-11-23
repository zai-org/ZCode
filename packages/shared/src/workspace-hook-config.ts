import { createHash } from "node:crypto";
import { constants, existsSync, statSync } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, posix, resolve } from "node:path";
import { z } from "zod";

export const WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION = 1 as const;
export const DEFAULT_WORKSPACE_HOOK_TIMEOUT_MS = 60_000;
export const DEFAULT_WORKSPACE_HOOK_MAX_OUTPUT_BYTES = 32_768;
export const WORKSPACE_HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
] as const;

export type WorkspaceHookEventName = (typeof WORKSPACE_HOOK_EVENT_NAMES)[number];
export type WorkspaceHookConfigFileKind = "zcode.json" | ".zcode/config.json" | "explicit";

const positiveNumberSchema = z.number().finite().positive();

export const workspaceHookProcessConfigSchema = z
  .object({
    type: z.literal("process"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    args: z.array(z.string()).optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
    // hook 自身出错时放行还是拦截（contracts 的 HookOnError）；只对 PreToolUse 生效。
    onError: z.enum(["allow", "deny"]).optional(),
  })
  .passthrough();

export const workspaceHookCommandConfigSchema = z
  .object({
    type: z.literal("command"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    async: z.boolean().optional(),
    shell: z.union([z.literal(true), z.string().min(1)]).optional(),
    timeout: positiveNumberSchema.optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
    // hook 自身出错时放行还是拦截（contracts 的 HookOnError）；只对 PreToolUse 生效。
    onError: z.enum(["allow", "deny"]).optional(),
  })
  .passthrough();

export const workspaceHookMatcherConfigSchema = z
  .object({
    // 空串与省略字段语义相同，工作区信任摘要也应使用同一个匹配条件。
    matcher: z
      .string()
      .transform((matcher) => matcher || undefined)
      .optional(),
    hooks: z
      .array(
        z.discriminatedUnion("type", [
          workspaceHookProcessConfigSchema,
          workspaceHookCommandConfigSchema,
        ]),
      )
      .min(1),
  })
  .strict();

export const workspaceHooksConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: positiveNumberSchema.optional(),
    maxOutputBytes: positiveNumberSchema.optional(),
    events: z
      .object({
        SessionStart: z.array(workspaceHookMatcherConfigSchema).optional(),
        UserPromptSubmit: z.array(workspaceHookMatcherConfigSchema).optional(),
        PreToolUse: z.array(workspaceHookMatcherConfigSchema).optional(),
        PermissionRequest: z.array(workspaceHookMatcherConfigSchema).optional(),
        PostToolUse: z.array(workspaceHookMatcherConfigSchema).optional(),
        PostToolUseFailure: z.array(workspaceHookMatcherConfigSchema).optional(),
        Stop: z.array(workspaceHookMatcherConfigSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WorkspaceHookDefinition =
  | z.infer<typeof workspaceHookCommandConfigSchema>
  | z.infer<typeof workspaceHookProcessConfigSchema>;
export type WorkspaceHooksConfig = z.infer<typeof workspaceHooksConfigSchema>;

export interface WorkspaceHookSourceInput {
  canonicalPath: string;
  baseDir: string;
  discoveryOrder: number;
  configFileKind: WorkspaceHookConfigFileKind;
  explicitProjectConfig: boolean;
  editable: boolean;
  hooks: WorkspaceHooksConfig;
}

export interface WorkspaceHookRuntimeRoot {
  enabled: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface WorkspaceHookConfigPathRef {
  path: string;
  explicitProjectConfig: boolean;
}

export interface WorkspaceHookSourceReadError {
  path: string;
  error: unknown;
}

export function resolveWorkspaceHookTimeoutMs(
  hook: Pick<WorkspaceHookDefinition, "type" | "timeoutMs"> & { timeout?: number },
  defaultTimeoutMs: number,
): number {
  const timeoutMs =
    hook.timeoutMs ??
    (hook.type === "command" && hook.timeout !== undefined
      ? hook.timeout * 1000
      : defaultTimeoutMs);
  return Math.max(1, Math.round(timeoutMs));
}

export function resolveWorkspaceHookMaxOutputBytes(maxOutputBytes: number): number {
  return Math.max(1, Math.round(maxOutputBytes));
}

/** Mirrors config-merger's hooks root semantics without materializing any callback. */
export function resolveWorkspaceHookRuntimeRoot(
  roots: readonly (
    | Partial<Pick<WorkspaceHooksConfig, "enabled" | "timeoutMs" | "maxOutputBytes">>
    | undefined
  )[],
): WorkspaceHookRuntimeRoot {
  let enabled = false;
  let timeoutMs = DEFAULT_WORKSPACE_HOOK_TIMEOUT_MS;
  let maxOutputBytes = DEFAULT_WORKSPACE_HOOK_MAX_OUTPUT_BYTES;

  for (const root of roots) {
    if (!root) continue;
    if (root.enabled === true) enabled = true;
    if (root.timeoutMs !== undefined) timeoutMs = root.timeoutMs;
    if (root.maxOutputBytes !== undefined) maxOutputBytes = root.maxOutputBytes;
  }

  return {
    enabled,
    timeoutMs: Math.max(1, Math.round(timeoutMs)),
    maxOutputBytes: resolveWorkspaceHookMaxOutputBytes(maxOutputBytes),
  };
}

export function resolveWorkspaceHookConfiguredGates(input: {
  sourceEnabled?: boolean;
  declarationEnabled?: boolean;
  runtimeHooksEnabled: boolean;
}) {
  const sourceRootEnabled = input.sourceEnabled !== false;
  const declarationEnabled = input.declarationEnabled !== false;
  return {
    sourceRootEnabled,
    declarationEnabled,
    runtimeHooksEnabled: input.runtimeHooksEnabled,
    configuredEnabled: sourceRootEnabled && declarationEnabled && input.runtimeHooksEnabled,
  };
}

/**
 * 从已发现的配置目录列表生成 workspace hook 候选文件路径。
 * 纯函数，sync/async discovery 共享，确保候选文件名与顺序规则只在此处维护一次
 * （sync/async 共享同一份 flatMap，避免候选路径的生成规则出现分歧）。
 */
function buildWorkspaceHookCandidatePaths(directories: readonly string[]): string[] {
  return directories.flatMap((directory) => [
    join(directory, "zcode.json"),
    join(directory, ".zcode", "config.json"),
  ]);
}

/**
 * 对已发现的 config refs 按规范化路径去重，保留首次出现的条目。
 *
 * 当 explicit projectConfigPath 恰好指向 auto-discovery 已发现的文件时，
 * 同一文件会以不同 explicitProjectConfig 标记出现两次，进入 snapshot 后产生重复
 * sourceFile 与重复 declaration，导致 bundleDigest 分叉。
 *
 * 去重策略：保留首次出现者（auto-discovered 条目在前、explicit 在后），丢弃后续重复。
 * 不得改变剩余条目的相对顺序——discoveryOrder 和 explicitProjectConfig 均为 digest 输入，
 * 任何重排都会使既有 trust 记录失效（用户被重新提示全部 Hook）。对于无 explicit path
 * 的 workspace，auto-discovery 本身不会产生重复，此函数为 no-op，bundleDigest 不变。
 */
function deduplicateWorkspaceHookConfigRefs(
  refs: readonly WorkspaceHookConfigPathRef[],
): WorkspaceHookConfigPathRef[] {
  const seen = new Set<string>();
  const result: WorkspaceHookConfigPathRef[] = [];
  for (const ref of refs) {
    const resolved = resolve(ref.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(ref);
  }
  return result;
}

export function discoverWorkspaceHookConfigPaths(input: {
  workingDirectory: string;
  explicitProjectConfigPath?: string;
}): WorkspaceHookConfigPathRef[] {
  const start = resolve(input.workingDirectory);
  const refs = buildWorkspaceHookCandidatePaths(getProjectConfigDirectories(start))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, explicitProjectConfig: false }));

  if (input.explicitProjectConfigPath) {
    const explicitPath = resolve(input.explicitProjectConfigPath);
    if (existsSync(explicitPath)) refs.push({ path: explicitPath, explicitProjectConfig: true });
  }
  return deduplicateWorkspaceHookConfigRefs(refs);
}

export function createWorkspaceHookSourceInput(input: {
  path: string;
  workingDirectory: string;
  hooks: WorkspaceHooksConfig;
  discoveryOrder: number;
  explicitProjectConfig?: boolean;
}): WorkspaceHookSourceInput {
  const canonicalPath = resolve(input.path);
  const explicitProjectConfig = input.explicitProjectConfig === true;
  const configDirectory = dirname(canonicalPath);
  return {
    canonicalPath,
    baseDir: basename(configDirectory) === ".zcode" ? dirname(configDirectory) : configDirectory,
    discoveryOrder: input.discoveryOrder,
    configFileKind: explicitProjectConfig
      ? "explicit"
      : basename(canonicalPath) === "zcode.json"
        ? "zcode.json"
        : ".zcode/config.json",
    explicitProjectConfig,
    editable:
      !explicitProjectConfig &&
      canonicalPath === resolve(input.workingDirectory, ".zcode", "config.json"),
    hooks: input.hooks,
  };
}

export async function readWorkspaceHookProjectSources(input: {
  workingDirectory: string;
  explicitProjectConfigPath?: string;
}): Promise<{ sources: WorkspaceHookSourceInput[]; errors: WorkspaceHookSourceReadError[] }> {
  const refs = await discoverWorkspaceHookConfigPathsAsync(input);
  const sources: WorkspaceHookSourceInput[] = [];
  const errors: WorkspaceHookSourceReadError[] = [];

  for (const [discoveryOrder, ref] of refs.entries()) {
    try {
      const value = JSON.parse(await readFile(ref.path, "utf8")) as unknown;
      if (!isRecord(value) || value.hooks === undefined) continue;
      sources.push(
        createWorkspaceHookSourceInput({
          path: ref.path,
          workingDirectory: input.workingDirectory,
          hooks: workspaceHooksConfigSchema.parse(value.hooks),
          discoveryOrder,
          explicitProjectConfig: ref.explicitProjectConfig,
        }),
      );
    } catch (error) {
      errors.push({ path: ref.path, error });
    }
  }
  return { sources, errors };
}

export async function discoverWorkspaceHookConfigPathsAsync(input: {
  includeMissing?: boolean;
  workingDirectory: string;
  explicitProjectConfigPath?: string;
}): Promise<WorkspaceHookConfigPathRef[]> {
  const start = resolve(input.workingDirectory);
  const candidates = buildWorkspaceHookCandidatePaths(
    await getProjectConfigDirectoriesAsync(start),
  );
  const refs: WorkspaceHookConfigPathRef[] = [];
  for (const path of candidates) {
    if (input.includeMissing || (await pathExists(path)))
      refs.push({ path, explicitProjectConfig: false });
  }
  if (input.explicitProjectConfigPath) {
    const explicitPath = resolve(input.explicitProjectConfigPath);
    if (input.includeMissing || (await pathExists(explicitPath))) {
      refs.push({ path: explicitPath, explicitProjectConfig: true });
    }
  }
  return deduplicateWorkspaceHookConfigRefs(refs);
}

async function getProjectConfigDirectoriesAsync(start: string): Promise<string[]> {
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (await hasWorktreeMarkerAsync(current)) return directories.reverse();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [start];
}

async function hasWorktreeMarkerAsync(directory: string): Promise<boolean> {
  try {
    const stats = await stat(join(directory, ".git"));
    return stats.isDirectory() || stats.isFile();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function getProjectConfigDirectories(start: string): string[] {
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (hasWorktreeMarker(current)) return directories.reverse();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [start];
}

function hasWorktreeMarker(directory: string): boolean {
  const marker = join(directory, ".git");
  try {
    if (!existsSync(marker)) return false;
    const stats = statSync(marker);
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Hook 直接入口脚本的内容绑定（docs/specs/workspace-hook-trust.md §12.9，D24）。
 *
 * 修复 ZP-20261110-06：declaration digest 原本不含脚本内容，声明不变、只替换脚本时旧 Trust 继续放行。
 * 这里只识别声明本身能确定的直接入口，不解析通用 Shell 语法，也不读取其他参数指向的文件；
 * 识别结果只进入 digest 与派发前复核，不改写实际执行的命令。
 */

export type WorkspaceHookScriptState =
  | { kind: "file"; sha256: string }
  | { kind: "missing" }
  | { kind: "unverifiable" };

export interface WorkspaceHookScriptEntry {
  /** 相对执行 cwd 的 POSIX 路径。 */
  path: string;
  state: WorkspaceHookScriptState;
}

const SCRIPT_INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
]);
const PROJECT_DIR_VARIABLES = ["ZCODE_PROJECT_DIR", "CLAUDE_PROJECT_DIR"] as const;
// process 不经过 shell，`${VAR}` 由 Runtime 按文本展开为 cwd，作为单个 argv 传递。
const PROCESS_PROJECT_DIR_PREFIXES = PROJECT_DIR_VARIABLES.map((name) => `\${${name}}/`);
// 修复原因（第五轮 SG-01）：command 经 shell 执行，未加引号的 $VAR 会被 shell 按 cwd 中的空格拆开；
// ${VAR} 先被文本替换进命令，cwd 中的 " $ 反引号仍会被 shell 解释。只保留由 shell 在引号内展开的 "$VAR"/。
const COMMAND_PROJECT_DIR_PREFIXES = PROJECT_DIR_VARIABLES.map((name) => `"$${name}"/`);
// 只要出现该字符集以外的字符（引号、$、%、;、|、&、重定向、通配符、\、换行、非 ASCII 空白等），
// 整条命令不识别。Windows 上 command 不进入识别（见下方），这里只按 POSIX shell 收窄。
const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9_./@+=:,-]*$/u;
const SCRIPT_PATH_TOKEN = /^[A-Za-z0-9_./-]+$/u;
const MAX_SCRIPT_BYTES = 16 * 1024 * 1024;
const DISCOVERY_READ_BUDGET_MS = 5_000;
// 同时读取的入口脚本数上限：大量 Hook 时避免一次打开过多文件触发 EMFILE、波及进程内其他 I/O；
// 无法取消的挂起读取（如 fstat 卡住）也最多占用这么多句柄。
const MAX_CONCURRENT_SCRIPT_READS = 8;

export function workspaceHookReviewItemId(
  sourceFileIndex: number,
  event: string,
  matcherIndex: number,
  hookIndex: number,
): string {
  return `workspace-hook-${sourceFileIndex}-${event}-${matcherIndex}-${hookIndex}`;
}

/** 识别声明的直接入口脚本；返回相对执行 cwd 的路径，识别不到时返回 undefined。 */
export function identifyWorkspaceHookScriptPath(
  hook: WorkspaceHookDefinition,
  /** Hook 实际执行的平台；远程工作区的 Settings 也在远端计算，两侧一致。 */
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (hook.type === "process") {
    if (SCRIPT_INTERPRETERS.has(hook.command)) {
      const script = hook.args?.[0];
      if (script === undefined || script.startsWith("-")) return undefined;
      return normalizeScriptPath(script, PROCESS_PROJECT_DIR_PREFIXES, true);
    }
    // Windows 按 PATHEXT 为无扩展名的路径补 .cmd/.exe 等，执行的不是绑定的文件。
    if (platform === "win32" && !extname(hook.command)) return undefined;
    return normalizeScriptPath(hook.command, PROCESS_PROJECT_DIR_PREFIXES, false);
  }
  // 修复原因（第四轮 CR-01）：Windows 上 command 由 cmd.exe 解析，它把 / 当开关、先在 cwd 查找同名
  // .cmd/.bat、展开 %VAR%、把 , = 当分隔符。前几轮用字符规则逐条近似 cmd.exe，每轮都发现新的分歧。
  // 现在 Windows 上 command 一律不识别入口，回到声明级信任；需要内容绑定时改用 process 写法（spec §12.9）。
  if (platform === "win32" || typeof hook.shell === "string") return undefined;
  // 修复原因（CR SG-01、第二轮 CR-01）：只按 shell 默认分词的 ASCII 空格与 tab 切分。
  // 曾按 \s 切分，换行与 NBSP、全角空格、\v 等被当作分隔符吞掉、绕过字符检查；shell 却不按它们分词，
  // 绑定的文件与实际执行的文件会不同。现在它们留在 token 内，被 SAFE_COMMAND_TOKEN 拒绝。
  const tokens = hook.command.replace(/^[ \t]+|[ \t]+$/gu, "").split(/[ \t]+/u);
  if (
    tokens.some(
      (token) => !SAFE_COMMAND_TOKEN.test(stripPrefix(token, COMMAND_PROJECT_DIR_PREFIXES).rest),
    )
  ) {
    return undefined;
  }
  const [first, second] = tokens;
  if (first === undefined) return undefined;
  if (SCRIPT_INTERPRETERS.has(first)) {
    if (second === undefined || second.startsWith("-")) return undefined;
    return normalizeScriptPath(second, COMMAND_PROJECT_DIR_PREFIXES, true);
  }
  return normalizeScriptPath(first, COMMAND_PROJECT_DIR_PREFIXES, false);
}

/**
 * 读取入口脚本状态。路径直接拼接在 cwd 下，不做符号链接解析，与子进程打开文件的语义一致。
 * 只有普通文件且完整读完才是 `file`；取消、超时、超限和其他错误都按 `unverifiable` 处理。
 */
export async function readWorkspaceHookScriptState(
  cwd: string,
  path: string,
  signal?: AbortSignal,
): Promise<WorkspaceHookScriptState> {
  if (signal?.aborted) return { kind: "unverifiable" };
  const absolutePath = join(cwd, path);
  try {
    // 先 stat 再打开：直接 open FIFO 会阻塞读取线程。
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) return { kind: "unverifiable" };
    const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      // 调用方已按截止时间放弃等待时，迟到的句柄直接关闭。
      if (signal?.aborted) return { kind: "unverifiable" };
      const opened = await handle.stat();
      if (!opened.isFile()) return { kind: "unverifiable" };
      const hash = createHash("sha256");
      let total = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
        total += (chunk as Buffer).length;
        if (total > MAX_SCRIPT_BYTES) return { kind: "unverifiable" };
        hash.update(chunk as Buffer);
      }
      if (signal?.aborted) return { kind: "unverifiable" };
      return { kind: "file", sha256: hash.digest("hex") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (!signal?.aborted && (code === "ENOENT" || code === "ENOTDIR")) return { kind: "missing" };
    return { kind: "unverifiable" };
  }
}

/**
 * 在 workspace 根目录下读取全部可识别入口的状态，按 reviewItemId 索引。
 * Settings、CLI Runtime、toggle 重建与 CLI trust 必须都经过本函数，保证 digest parity（D20）。
 */
export async function readWorkspaceHookScriptStates(input: {
  workspacePath: string;
  sources: readonly WorkspaceHookSourceInput[];
}): Promise<Map<string, WorkspaceHookScriptState>> {
  const pathsById = new Map<string, string>();
  for (const [sourceFileIndex, source] of input.sources.entries()) {
    for (const event of WORKSPACE_HOOK_EVENT_NAMES) {
      for (const [matcherIndex, matcher] of (source.hooks.events?.[event] ?? []).entries()) {
        for (const [hookIndex, hook] of matcher.hooks.entries()) {
          const path = identifyWorkspaceHookScriptPath(hook);
          if (path === undefined) continue;
          pathsById.set(
            workspaceHookReviewItemId(sourceFileIndex, event, matcherIndex, hookIndex),
            path,
          );
        }
      }
    }
  }
  // 修复原因（CR-01）：stat/open 不响应取消信号，文件系统无响应时只发信号仍会无限等待，
  // 阻塞会话初始化与 Settings 加载。这里让每个读取与截止时间竞争，到期即记为 unverifiable；
  // 迟到结果被忽略，迟到打开的句柄由 readWorkspaceHookScriptState 的 finally 关闭。
  const deadline = new AbortController();
  const unverifiable: WorkspaceHookScriptState = { kind: "unverifiable" };
  const expired = new Promise<WorkspaceHookScriptState>((resolve) => {
    deadline.signal.addEventListener("abort", () => resolve(unverifiable), { once: true });
  });
  const timer = setTimeout(() => deadline.abort(), DISCOVERY_READ_BUDGET_MS);
  try {
    const pending = [...new Set(pathsById.values())];
    const stateByPath = new Map<string, WorkspaceHookScriptState>();
    const worker = async () => {
      for (let path = pending.shift(); path !== undefined; path = pending.shift()) {
        // 截止时间到后，尚未开始的读取立即得到 unverifiable（signal 已 abort）。
        stateByPath.set(
          path,
          await Promise.race([
            readWorkspaceHookScriptState(input.workspacePath, path, deadline.signal),
            expired,
          ]),
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_SCRIPT_READS, pending.length) }, worker),
    );
    const states = new Map<string, WorkspaceHookScriptState>();
    for (const [id, path] of pathsById) states.set(id, stateByPath.get(path) ?? unverifiable);
    return states;
  } finally {
    clearTimeout(timer);
    // 结束后仍在进行的读取一并取消。
    deadline.abort();
  }
}

function normalizeScriptPath(
  value: string,
  prefixes: readonly string[],
  allowBareName: boolean,
): string | undefined {
  const { rest, matched } = stripPrefix(value, prefixes);
  if (!matched && !rest.includes("/")) {
    // 直接执行位置的裸名字走 PATH 查找，不是工作区文件。
    if (!allowBareName) return undefined;
    // 解释器后的无路径名字可能是子命令（node inspect x.js 加载的是 x.js），须带扩展名（第五轮 CR）。
    if (!extname(rest)) return undefined;
  }
  // 脚本路径只接受最窄的字符集，不逐条排除 shell 元字符（$、\、:、=、,、@ 等都在集合外）：
  // `KEY=val cmd` 赋值前缀、Windows 盘符相对路径 C:x、NTFS 备用数据流等写法因此都不会被当作脚本。
  if (!SCRIPT_PATH_TOKEN.test(rest) || rest.startsWith("/")) return undefined;
  // 父目录段与符号链接的解析顺序可能改变实际目标，不做词法折叠，直接不识别。
  if (rest.split("/").includes("..")) return undefined;
  const normalized = posix.normalize(rest);
  return normalized === "." ? undefined : normalized;
}

function stripPrefix(
  value: string,
  prefixes: readonly string[],
): { rest: string; matched: boolean } {
  const prefix = prefixes.find((candidate) => value.startsWith(candidate));
  return prefix
    ? { rest: value.slice(prefix.length), matched: true }
    : { rest: value, matched: false };
}
