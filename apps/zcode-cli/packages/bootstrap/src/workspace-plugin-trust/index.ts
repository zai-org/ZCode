import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  createConfig,
  resolveWorkspaceHookTrustIdentityForWorkspace,
  type ConfigResult,
} from "@zcode/adapters/config";
import { inspectWorkspacePluginRoot, workspacePluginRootKey } from "@zcode/adapters/plugins";
import { resolveWorkspaceHookTrustStorePath } from "@zcode/adapters/storage";
import type { Logger, WorkspacePluginDiscovery } from "@zcode/contracts";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import type {
  WorkspacePluginTrustReasonCode,
  WorkspacePluginTrustTarget,
} from "./contract.js";

export type { WorkspacePluginTrustContract, WorkspacePluginTrustReasonCode } from "./contract.js";

// ============================================================
// 项目目录插件信任（docs/plugins/workspace-plugin-dir-trust.md）。
// 项目 `.zcode/config.json` 的 `plugins.dirs` 只产生候选；只有用户在设置页逐个信任、
// 记录写进用户域存储后，插件发现才会启用它。记录键是 Trust identity（与 Hook 信任同一
// resolver：远程用 workspaceIdentity，受管 worktree 归一到源仓库）+ 插件根相对路径 +
// 声明摘要。仓库文件不能写入或伪造这里的记录。
// ============================================================

const STORE_NAME = "workspace-plugin-trust-v1.json";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

const recordSchema = z
  .object({
    workspaceIdentity: z.string().min(1),
    pluginRoot: z.string().min(1),
    declarationDigest: z.string().regex(DIGEST_PATTERN),
    grantedAt: z.string().datetime(),
  })
  .strict();
const storeSchema = z
  .object({ schemaVersion: z.literal(1), records: z.array(recordSchema) })
  .strict();
type TrustRecord = z.infer<typeof recordSchema>;

type WorkspaceTarget = WorkspacePluginTrustTarget;

/** 与 Hook 信任存储同目录；项目配置不能改写用户存储根。 */
async function resolveStorePath(userConfigPath: string | undefined): Promise<string> {
  return join(
    dirname(await resolveWorkspaceHookTrustStorePath({ userConfigPath })),
    STORE_NAME,
  );
}

function resolveTrustIdentity(target: WorkspaceTarget): Promise<string> {
  return resolveWorkspaceHookTrustIdentityForWorkspace({
    workspacePath: resolve(target.workingDirectory),
    ...(target.workspaceIdentity?.trim()
      ? { workspaceIdentity: target.workspaceIdentity.trim() }
      : {}),
    ...(target.env ? { env: target.env } : {}),
  });
}

async function readRecords(path: string): Promise<TrustRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return storeSchema.parse(JSON.parse(text)).records;
}

/**
 * 为插件发现准备项目目录候选与当前工作区的信任记录。没有候选时返回 undefined。
 * 存储读不出或损坏时按「没有信任」处理：候选仍展示为待信任，但都不会启用。
 */
export async function resolveWorkspacePluginDiscovery(
  input: WorkspaceTarget & { configResult: ConfigResult; logger?: Logger },
): Promise<WorkspacePluginDiscovery | undefined> {
  const roots = input.configResult.sources.plugins.dirs.workspace;
  if (roots.length === 0) return undefined;
  let trusted: WorkspacePluginDiscovery["trusted"] = [];
  try {
    const identity = await resolveTrustIdentity(input);
    const records = await readRecords(
      await resolveStorePath(input.configResult.sources.user.path),
    );
    trusted = records
      .filter((record) => record.workspaceIdentity === identity)
      .map(({ pluginRoot, declarationDigest }) => ({ pluginRoot, declarationDigest }));
  } catch (error) {
    input.logger?.warn("Workspace plugin trust store unreadable; project plugins stay pending", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { workspaceRoot: resolve(input.workingDirectory), roots, trusted };
}

/**
 * 写入或撤销一条信任。信任时在文件锁内重读项目配置与插件声明，摘要必须与用户在设置页
 * 看到的一致；声明在审核后又被改动就拒绝，避免「批准 A、执行 B」。撤销不要求摘要一致。
 */
export async function setWorkspacePluginTrust(
  input: WorkspaceTarget & {
    pluginRoot: string;
    declarationDigest: string;
    trusted: boolean;
    userConfigPath?: string;
  },
): Promise<{ accepted: boolean; reasonCode?: WorkspacePluginTrustReasonCode }> {
  const workingDirectory = resolve(input.workingDirectory);
  let identity: string;
  let path: string;
  try {
    identity = await resolveTrustIdentity(input);
    path = await resolveStorePath(input.userConfigPath);
  } catch {
    return { accepted: false, reasonCode: "workspace_plugin_trust_unavailable" };
  }
  return withFileLock(path, async () => {
    if (input.trusted) {
      const config = createConfig({
        workingDirectory,
        ...(input.env ? { env: input.env } : {}),
        ...(input.userConfigPath ? { userConfigPath: input.userConfigPath } : {}),
      });
      const rootPath = config.sources.plugins.dirs.workspace.find(
        (root) => workspacePluginRootKey(workingDirectory, root) === input.pluginRoot,
      );
      const current = rootPath
        ? await inspectWorkspacePluginRoot({ workspaceRoot: workingDirectory, rootPath })
        : undefined;
      if (current?.declarationDigest !== input.declarationDigest)
        return { accepted: false, reasonCode: "workspace_plugin_declaration_changed" as const };
    }
    let records: TrustRecord[];
    try {
      records = await readRecords(path);
    } catch {
      // 损坏的存储不能被覆盖成只剩这一条；保留原文件让用户或支持人员排查。
      return { accepted: false, reasonCode: "workspace_plugin_trust_unavailable" as const };
    }
    // 同一插件根只保留最新一条：声明更新后重新信任会替换旧摘要，撤销删掉该根的全部记录。
    const next = records.filter(
      (record) => record.workspaceIdentity !== identity || record.pluginRoot !== input.pluginRoot,
    );
    if (input.trusted)
      next.push({
        workspaceIdentity: identity,
        pluginRoot: input.pluginRoot,
        declarationDigest: input.declarationDigest,
        grantedAt: new Date().toISOString(),
      });
    await atomicWritePrivateTextFile(path, JSON.stringify({ schemaVersion: 1, records: next }));
    return { accepted: true };
  });
}
