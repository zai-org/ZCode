import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDefaultFileWorkspaceHookTrustStore } from "@zcode/adapters/storage";
import {
  getDefaultConfigPath,
  resolveWorkspaceHookTrustIdentityForWorkspace,
} from "@zcode/adapters/config";
import {
  DefaultRuntimeConfig,
  createWorkspaceHookBundleSnapshot,
  type WorkspaceHookBundleSnapshot,
  type WorkspaceHookTrustRecord,
} from "@zcode/contracts";
import {
  buildWorkspaceHookBundleSnapshot,
  readWorkspaceHookProjectSources,
  resolveWorkspaceHookRuntimeRoot,
  workspaceHooksConfigSchema,
  type WorkspaceHooksConfig,
} from "@zcode/shared/workspace-hook-discovery";

export interface WorkspaceHookTrustCliTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  userConfigPath?: string;
  /** 解析受管 worktree 的数据根目录（ZCODE_DATA_BASE_DIR）；缺省 process.env。 */
  env?: Record<string, string | undefined>;
}

export interface WorkspaceHookTrustCliItem {
  reviewItemId: string;
  event: string;
  matcher: string | null;
  displayCommand: string;
  sourcePath: string;
  configuredEnabled: boolean;
  hookDeclarationDigest: string;
  trustState: "trusted_persistent" | "pending_trust";
}

export interface WorkspaceHookTrustCliStatus {
  workspacePath: string;
  workspaceIdentity: string;
  bundleDigest: string | null;
  reasonCode:
    | "workspace_hooks_not_applicable"
    | "workspace_hooks_no_enabled_hooks"
    | "workspace_hooks_pending_trust"
    | "workspace_hooks_trusted_persistent"
    | "workspace_hooks_feature_disabled"
    | "workspace_hooks_require_trust_capable_host"
    // status 必须与 grant/revoke 的失败语义一致——损坏 store 若伪装成
    // pending_trust，用户按提示 grant 只会撞上 trust_store_corrupt，恢复指引矛盾。
    | "workspace_hooks_trust_store_corrupt";
  items: WorkspaceHookTrustCliItem[];
}

export async function inspectWorkspaceHookTrust(
  input: WorkspaceHookTrustCliTarget,
): Promise<WorkspaceHookTrustCliStatus> {
  const target = await normalizeTarget(input);
  const snapshot = await discoverSnapshot(target);
  const store = await createDefaultFileWorkspaceHookTrustStore({
    userConfigPath: target.userConfigPath,
  });
  const loaded = await store.load();
  // 损坏 store 优先于任何信任计算——所有记录不可信（adapters load 已
  // fail-closed 返回空 records），显式报 corrupt 让用户先修复/移除损坏文件，
  // 不再给出"grant 即可"的错误指引。恢复：adapters load 已把损坏文件改名为
  // *.corrupt-<ts>，确认无需保留后删除该文件或从备份恢复即可重建。
  if (loaded.status === "corrupt") {
    const corruptItems = (snapshot?.hooks ?? []).map((entry) => ({
      reviewItemId: entry.reviewItemId,
      event: entry.event,
      matcher: entry.matcher,
      displayCommand: formatCommand(entry),
      sourcePath: entry.sourceRelativePath,
      configuredEnabled: entry.configuredEnabled,
      hookDeclarationDigest: entry.hookDeclarationDigest,
      trustState: "pending_trust" as const,
    }));
    return {
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      bundleDigest: snapshot?.bundleDigest ?? null,
      reasonCode: "workspace_hooks_trust_store_corrupt",
      items: corruptItems,
    };
  }
  const trusted = new Set(
    loaded.records
      .filter((record) => record.workspaceIdentity === target.workspaceIdentity)
      .map((record) => record.hookDeclarationDigest),
  );
  if (!snapshot) {
    return {
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      bundleDigest: null,
      reasonCode: "workspace_hooks_not_applicable",
      items: [],
    };
  }
  const items = snapshot.hooks.map((entry) => ({
    reviewItemId: entry.reviewItemId,
    event: entry.event,
    matcher: entry.matcher,
    displayCommand: formatCommand(entry),
    sourcePath: entry.sourceRelativePath,
    configuredEnabled: entry.configuredEnabled,
    hookDeclarationDigest: entry.hookDeclarationDigest,
    trustState: trusted.has(entry.hookDeclarationDigest)
      ? ("trusted_persistent" as const)
      : ("pending_trust" as const),
  }));
  const enabled = items.filter((item) => item.configuredEnabled);
  const reasonCode =
    enabled.length === 0
      ? "workspace_hooks_no_enabled_hooks"
      : enabled.every((item) => item.trustState === "trusted_persistent")
        ? "workspace_hooks_trusted_persistent"
        : "workspace_hooks_pending_trust";
  return {
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    bundleDigest: snapshot.bundleDigest,
    reasonCode,
    items,
  };
}

export async function grantWorkspaceHookTrust(
  input: WorkspaceHookTrustCliTarget & {
    hookDeclarationDigests?: readonly string[];
    allCurrent?: boolean;
    bundleDigest?: string;
    appVersion?: string;
  },
): Promise<WorkspaceHookTrustCliStatus> {
  const target = await normalizeTarget(input);
  const snapshot = await requireSnapshot(target);
  const selected = selectGrantEntries(snapshot, input);
  const grantedAt = new Date().toISOString();
  const records: WorkspaceHookTrustRecord[] = selected.map((entry) => ({
    workspaceIdentity: snapshot.workspaceIdentity,
    hookDeclarationDigest: entry.hookDeclarationDigest,
    digestAlgorithm: "sha256",
    decision: "trusted",
    grantedAt,
    bundleDigestAtGrant: snapshot.bundleDigest,
    eventAtGrant: entry.event,
    displayCommandAtGrant: formatCommand(entry),
    sourcePathAtGrant: entry.sourceRelativePath,
    sourceDiscoveryOrderAtGrant: snapshot.sourceFiles[entry.sourceFileIndex]?.discoveryOrder,
    matcherAtGrant: entry.matcher,
    matcherIndexAtGrant: entry.matcherIndex,
    hookIndexAtGrant: entry.hookIndex,
    ...(input.appVersion ? { appVersionAtGrant: input.appVersion } : {}),
  }));
  const store = await createDefaultFileWorkspaceHookTrustStore({
    userConfigPath: target.userConfigPath,
  });
  // workspace 级 Settings 预信任没有 session controller 帮忙拦截损坏存储；
  // 若直接 grant，store 的恢复逻辑会把 corrupt 当空记录并立即覆盖。首次显式授权必须
  // fail closed，让用户先看到损坏状态，不能把恢复副作用伪装成一次成功授权。
  const loaded = await store.load();
  if (loaded.status === "corrupt") {
    throw new Error("workspace_hooks_trust_store_corrupt");
  }
  await store.grant(records);
  return inspectWorkspaceHookTrust(target);
}

export async function revokeWorkspaceHookTrustCli(
  input: WorkspaceHookTrustCliTarget & {
    hookDeclarationDigests?: readonly string[];
    all?: boolean;
  },
): Promise<WorkspaceHookTrustCliStatus> {
  const target = await normalizeTarget(input);
  const digests = unique(input.hookDeclarationDigests ?? []);
  if ((input.all === true) === digests.length > 0) {
    throw new Error("Specify exactly one of --all or --hook-digest.");
  }
  const store = await createDefaultFileWorkspaceHookTrustStore({
    userConfigPath: target.userConfigPath,
  });
  await store.revoke({
    workspaceIdentity: target.workspaceIdentity,
    ...(input.all ? {} : { hookDeclarationDigests: digests }),
  });
  return inspectWorkspaceHookTrust(target);
}

async function discoverSnapshot(
  target: Required<Pick<WorkspaceHookTrustCliTarget, "workspacePath">> &
    WorkspaceHookTrustCliTarget & {
      workspaceIdentity: string;
    },
): Promise<WorkspaceHookBundleSnapshot | undefined> {
  const discovery = await readWorkspaceHookProjectSources({
    workingDirectory: target.workspacePath,
  });
  if (discovery.errors.length > 0) {
    throw new Error(`Unable to read Workspace Hook config: ${discovery.errors[0]?.path}`);
  }
  const userHooks = await readUserHooks(target.userConfigPath ?? getDefaultConfigPath());
  const runtimeRoot = resolveWorkspaceHookRuntimeRoot([
    DefaultRuntimeConfig.hooks,
    userHooks,
    ...discovery.sources.map((source) => source.hooks),
  ]);
  const data = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: target.workspaceIdentity,
    workspacePath: target.workspacePath,
    sources: discovery.sources,
    runtimeRoot,
  });
  return data ? createWorkspaceHookBundleSnapshot(data) : undefined;
}

async function requireSnapshot(
  target: Awaited<ReturnType<typeof normalizeTarget>>,
): Promise<WorkspaceHookBundleSnapshot> {
  const snapshot = await discoverSnapshot(target);
  if (!snapshot) throw new Error("No Workspace Hook declarations were discovered.");
  return snapshot;
}

function selectGrantEntries(
  snapshot: WorkspaceHookBundleSnapshot,
  input: {
    hookDeclarationDigests?: readonly string[];
    allCurrent?: boolean;
    bundleDigest?: string;
  },
) {
  const digests = unique(input.hookDeclarationDigests ?? []);
  if ((input.allCurrent === true) === digests.length > 0) {
    throw new Error("Specify exactly one of --all-current or --hook-digest.");
  }
  if (input.bundleDigest && input.bundleDigest !== snapshot.bundleDigest) {
    throw new Error("workspace_hooks_bundle_changed");
  }
  if (input.allCurrent) {
    if (!input.bundleDigest) {
      throw new Error("workspace_hooks_bundle_changed");
    }
    return snapshot.hooks.filter((entry) => entry.configuredEnabled);
  }
  if (digests.length === 0) throw new Error("At least one --hook-digest is required.");
  const selected = snapshot.hooks.filter((entry) => digests.includes(entry.hookDeclarationDigest));
  if (new Set(selected.map((entry) => entry.hookDeclarationDigest)).size !== digests.length) {
    throw new Error("workspace_hooks_snapshot_mismatch");
  }
  return selected;
}

async function readUserHooks(path: string): Promise<WorkspaceHooksConfig | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(value) || value.hooks === undefined) return undefined;
    return workspaceHooksConfigSchema.parse(value.hooks);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function normalizeTarget(input: WorkspaceHookTrustCliTarget) {
  const workspacePath = resolve(input.workspacePath);
  return {
    workspacePath,
    // Trust record 的读写键是 Trust identity（D23）：受管 worktree 归一为源仓库路径，
    // 与 Runtime snapshot、Host Settings 走同一个共享 resolver；远程 identity 原样。
    workspaceIdentity: await resolveWorkspaceHookTrustIdentityForWorkspace({
      workspacePath,
      ...(input.workspaceIdentity?.trim()
        ? { workspaceIdentity: input.workspaceIdentity.trim() }
        : {}),
      ...(input.env ? { env: input.env } : {}),
    }),
    ...(input.userConfigPath ? { userConfigPath: input.userConfigPath } : {}),
    ...(input.env ? { env: input.env } : {}),
  };
}

function formatCommand(entry: WorkspaceHookBundleSnapshot["hooks"][number]): string {
  return entry.type === "process" && entry.args?.length
    ? [entry.command, ...entry.args].join(" ")
    : entry.command;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
