import { join, posix, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

export const E2E_RUNTIME_RELATIVE_ROOT = ".zcode-e2e";
export const E2E_RUNTIME_ROOT_REPLAY_TOKEN = "{{e2eRuntimeRoot}}";
const E2E_AGENT_WORKSPACE_NAME = "ZCodeProject";

interface ResolveE2EHomeDirOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export function resolveE2EHomeDir({
  cwd = process.cwd(),
  env = process.env,
}: ResolveE2EHomeDirOptions = {}): string {
  const configuredHome =
    env.ZCODE_E2E_HOME_DIR?.trim() ||
    env.ZCODE_DATA_BASE_DIR?.trim() ||
    env.ZCODE_DESKTOP_HOME_DIR?.trim();
  return resolve(cwd, configuredHome || ".e2e-home");
}

/**
 * 判断 HOME 是否为 runner 分配的隔离 E2E HOME，供直接改写磁盘夹具的 case 做安全守卫。
 * Bug 根因：旧守卫只看 basename 是否以 `.e2e-home-` 开头；直接运行 wdio 的默认 `.e2e-home`
 * 被误拒。改为任一路径段以 `.e2e-home` 开头即可：覆盖 `.e2e-home`、`.e2e-home-<runId>[-shard-N]`，
 * 以及根目录名带 `.e2e-home` 的显式 ZCODE_E2E_HOME_DIR 分片子目录。
 * 根目录名不带 `.e2e-home` 的显式 HOME 无法与真实目录区分，保守拒绝；需要改写夹具的 case 应使用带该前缀的根。
 */
export function isIsolatedE2EHomeDir(home: string | undefined): home is string {
  if (!home?.trim()) return false;
  return resolve(home)
    .split(/[\\/]/u)
    .some((segment) => segment.startsWith(".e2e-home"));
}

export function resolveE2EStorageRoot(e2eHomeDir = resolveE2EHomeDir()): string {
  // Bug 根因：回滚 storage profile 时删除了仍被 E2E 用例依赖的路径 helper。
  // E2E 继续隔离 HOME，但 CLI 根固定使用历史目录 .zcode，不再区分 dev/stable profile。
  return join(e2eHomeDir, ".zcode");
}

export function resolveE2ERuntimeRoot(e2eHomeDir = resolveE2EHomeDir()): string {
  // Bug 根因：conversation E2E 的 Agent 实际 cwd 是隔离 HOME 下的
  // ZCodeProject，而不是 conversation backing workspace。Node 若写到后者，
  // Bash 的相对路径就会永远等不到同一个文件，Windows 上还会叠加 shell 路径差异。
  return join(e2eHomeDir, E2E_AGENT_WORKSPACE_NAME, E2E_RUNTIME_RELATIVE_ROOT);
}

export function resolveE2ERuntimePath(...segments: string[]): string {
  return join(resolveE2ERuntimeRoot(), ...segments);
}

export function resolveE2EToolPath(...segments: string[]): string {
  // Bug 根因：Windows Node 与 Git Bash 会把裸 POSIX 临时根解析成不同目录。
  // 工具参数保留绝对路径，但统一成 Windows 文件 API 同样接受的正斜杠形式，
  // 让 JSON replay fixture 不需要猜测盘符转义或 Git Bash mount。
  return resolveE2ERuntimePath(...segments).replaceAll("\\", "/");
}

export function resolveE2EShellPath(...segments: string[]): string {
  return posix.join(E2E_RUNTIME_RELATIVE_ROOT, ...segments);
}

export function createE2EReplayFixtureVariables(
  e2eHomeDir = resolveE2EHomeDir(),
): Readonly<Record<string, string>> {
  return {
    e2eRuntimeRoot: resolveE2ERuntimeRoot(e2eHomeDir).replaceAll("\\", "/"),
  };
}

/** 前台 Bash 仍在运行时尚无 tool_result；按真实 session/tool 查找唯一输出，不能固定旧 HOME 根。 */
export async function findE2EBashOutputPath(
  sessionId: string,
  toolCallId: string,
  {
    tempRoot = tmpdir(),
    storageRoot = resolveE2EStorageRoot(),
  }: { tempRoot?: string; storageRoot?: string } = {},
): Promise<string | null> {
  const directories = (await readdir(tempRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("zcode-bash-"))
    .map((entry) => join(tempRoot, entry.name));
  const candidates = [...directories, join(storageRoot, "cli", "exec")].map((root) =>
    join(root, sessionId, `${toolCallId}-stdout.log`),
  );
  const existing = (
    await Promise.all(
      candidates.map(async (path) => {
        try {
          return (await stat(path)).isFile() ? path : null;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      }),
    )
  ).filter((path): path is string => path !== null);
  if (existing.length > 1)
    throw new Error(
      `Bash 没有唯一实际输出文件: ${sessionId}/${toolCallId}; ${JSON.stringify(existing)}`,
    );
  return existing[0] ?? null;
}
