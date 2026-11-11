// 项目数据彻底删除的 CLI 执行面（v4/storage/sessionData/*）。
// 规格：docs/superpowers/specs/2026-10-24-project-management.md「彻底删除数据」。
import type { SessionId } from "@zcode/contracts";
import {
  v4SessionDataParamsSchema,
  type V4SessionDataMeasureResult,
  type V4SessionDataParams,
  type V4SessionDataPurgeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { deactivateSessionRecord, readSessionBusyState } from "../session-residency.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "../server-types.js";
import type { SessionDataHost } from "./contract.js";

export type { SessionDataHost } from "./contract.js";

const UNKNOWN_FAILURE_CODE = "unknown";

function failureCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code ? code : UNKNOWN_FAILURE_CODE;
}

async function trees(host: SessionDataHost, params: V4SessionDataParams) {
  const owned = await host.store.listOwnedSessionTrees(params.sessionIds as SessionId[]);
  // 库里已不存在的根仍按自身 ID 处理：清理可能残留的会话文件，结果按 0 行删除成功。
  return params.sessionIds.map((root) => {
    const ids = owned.get(root as SessionId) ?? [];
    return { root, ids: ids.length ? ids : [root] };
  });
}

export async function measureSessionDataWith(
  host: SessionDataHost,
  params: V4SessionDataParams,
): Promise<V4SessionDataMeasureResult> {
  const sessions = [];
  for (const { root, ids } of await trees(host, params)) {
    const sizes = await Promise.all(ids.map((id) => host.files.measureSession(id)));
    sessions.push({ sessionId: root, bytes: sizes.reduce((sum, bytes) => sum + bytes, 0) });
  }
  const memory = await Promise.all(
    params.directories.map(async (directory) => ({
      workspacePath: directory.workspacePath,
      bytes: await host.files.measureMemory(directory),
    })),
  );
  return { sessions, memory };
}

/**
 * 附件仍被本次不删除的会话引用的树整棵保留：fork、回退、工作流转录按值复制 part，
 * `zcode-artifact://<源会话>/…` 仍指向源会话的附件目录。保留一棵会让它也成为引用方，迭代到不动点。
 */
async function referencedRoots(
  host: SessionDataHost,
  candidates: ReadonlyArray<{ root: string; ids: string[] }>,
  removable: Set<string>,
): Promise<Set<string>> {
  const referrers = await host.store.listArtifactReferrers(
    candidates.flatMap(({ ids }) => ids) as SessionId[],
  );
  const referenced = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const { root, ids } of candidates) {
      if (referenced.has(root)) continue;
      const outside = ids.some((id) =>
        (referrers.get(id as SessionId) ?? []).some((referrer) => !removable.has(referrer)),
      );
      if (!outside) continue;
      referenced.add(root);
      for (const id of ids) removable.delete(id);
      changed = true;
    }
  }
  return referenced;
}

export async function purgeSessionDataWith(
  host: SessionDataHost,
  params: V4SessionDataParams,
): Promise<V4SessionDataPurgeResult> {
  const result: V4SessionDataPurgeResult = { deleted: [], kept: [], failed: [], memory: [] };
  const all = await trees(host, params);
  // 运行中的会话（含其子会话在跑）整棵保留：删掉正在写入的会话会让 turn 写库失败。
  const running = new Set(
    all
      .filter(({ ids }) => ids.some((id) => host.residency(id) === "busy"))
      .map(({ root }) => root),
  );
  const candidates = all.filter(({ root }) => !running.has(root));
  const referenced = await referencedRoots(
    host,
    candidates,
    new Set(candidates.flatMap(({ ids }) => ids)),
  );
  for (const { root, ids } of all) {
    if (running.has(root)) {
      result.kept.push({ sessionId: root, reason: "running" });
      continue;
    }
    if (referenced.has(root)) {
      result.kept.push({ sessionId: root, reason: "referenced" });
      continue;
    }
    try {
      for (const id of ids) if (host.residency(id) === "idle") await host.release(id);
      // 先删文件再删行：文件删除失败时行还在，重试仍能按会话找到这些文件。
      let bytes = 0;
      for (const id of ids) bytes += await host.files.removeSession(id);
      await host.store.purgeSessions([root as SessionId]);
      // 文件与行都删除后才从列表投影移除；失败时 sessions-index 与 Host 镜像保持原样。
      for (const id of ids) host.forgetIndexed(id);
      result.deleted.push({ sessionId: root, bytes });
    } catch (error) {
      result.failed.push({ sessionId: root, code: failureCode(error) });
    }
  }
  for (const directory of params.directories) {
    try {
      result.memory.push({
        workspacePath: directory.workspacePath,
        bytes: await host.files.removeMemory(directory),
      });
    } catch (error) {
      result.failed.push({ workspacePath: directory.workspacePath, code: failureCode(error) });
    }
  }
  return result;
}

function hostFromContext(context: ZCodeProtocolAgentServerContext): SessionDataHost {
  const store = context.deps.sessionStore;
  const files = context.deps.sessionDataFiles;
  if (
    !store?.listOwnedSessionTrees ||
    !store.listArtifactReferrers ||
    !store.purgeSessions ||
    !files
  )
    throw new Error("Session data deletion is unavailable");
  return {
    store: {
      listOwnedSessionTrees: store.listOwnedSessionTrees.bind(store),
      listArtifactReferrers: store.listArtifactReferrers.bind(store),
      purgeSessions: store.purgeSessions.bind(store),
    },
    files,
    residency: (sessionId) => readSessionBusyState(context, sessionId),
    // 修复原因：曾按 deleteSession 同序 dispose(deleted:true)，在文件删除前就发布 session.removed；
    // 文件删除失败（EACCES/EBUSY）时 Host 已把任务当作删除，CLI 行却还在。这里只做驻留去激活。
    release: (sessionId) => deactivateSessionRecord(context, sessionId),
    forgetIndexed: (sessionId) => context.v4Gateway?.forgetIndexedSession(sessionId),
  };
}

export async function measureSessionData(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4SessionDataMeasureResult> {
  return measureSessionDataWith(
    hostFromContext(context),
    parseParams(v4SessionDataParamsSchema, rawParams),
  );
}

export async function purgeSessionData(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<V4SessionDataPurgeResult> {
  const params = parseParams(v4SessionDataParamsSchema, rawParams);
  const result = await purgeSessionDataWith(hostFromContext(context), params);
  context.logger?.info("Session data purged", {
    event: "zcode_protocol.session_data.purged",
    deleted: result.deleted.length,
    kept: result.kept.length,
    failed: result.failed.length,
  });
  return result;
}

export { previewSessionDeletion, executeSessionDeletion } from "./permanent-deletion.js";
