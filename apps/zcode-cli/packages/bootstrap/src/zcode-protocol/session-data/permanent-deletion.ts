import { createHash } from "node:crypto";
import type { SessionDeletionSnapshot, SessionId, SessionStorePort } from "@zcode/contracts";
import type { SessionDataFilesPort } from "@zcode/adapters/storage";
import {
  v4SessionDeletionParamsSchema,
  v4SessionDeletionExecuteParamsSchema,
  v4SessionDeletionPreviewBatchParamsSchema,
  type V4SessionDeletionParams,
  type V4SessionDeletionPreviewBatchParams,
  type V4SessionDeletionPreviewBatchResult,
  type V4SessionDeletionExecuteParams,
  type V4SessionDeletionPreview,
  type V4SessionDeletionResult,
} from "@zcode/shared/zcode-protocol-v4";
import { createSessionResidentPoolHost, deactivateSessionRecord } from "../session-residency.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "../server-types.js";

export interface SessionDeletionHost {
  store: Required<
    Pick<
      SessionStorePort,
      "inspectSessionDeletions" | "beginSessionDeletion" | "completeSessionDeletion"
    >
  >;
  files: SessionDataFilesPort;
  busy(id: string): boolean;
  loaded?(id: string): boolean;
  release(id: string): Promise<void>;
  forget(id: string): void;
}

type SessionDataFile = Awaited<
  ReturnType<NonNullable<SessionDataFilesPort["listSessionFiles"]>>
>[number];
type InspectOutcome =
  | { snapshot: SessionDeletionSnapshot; preview: V4SessionDeletionPreview; scan: boolean }
  | { error: unknown };

function buildPreview(
  host: SessionDeletionHost,
  params: V4SessionDeletionParams,
  snapshot: SessionDeletionSnapshot,
  files: Array<SessionDataFile & { sessionId: string }>,
): V4SessionDeletionPreview {
  const retainedArtifacts = snapshot.references.flatMap((ref) => {
    const matched = files.filter(
      (file) =>
        file.sessionId === ref.sessionId &&
        file.kind === "artifact" &&
        file.name.includes(ref.artifactId),
    );
    return matched.length
      ? matched.map((file) => ({ ...ref, fileName: file.name }))
      : [{ ...ref, fileName: ref.artifactId }];
  });
  const blockedReason =
    snapshot.foreignRuntime || snapshot.localRuntimeIds.some((id) => host.loaded?.(id) === false)
      ? ("in-use" as const)
      : snapshot.pendingWork || snapshot.sessionIds.some((id) => host.busy(id))
        ? ("running" as const)
        : !snapshot.sessionIds.length
          ? ("not-found" as const)
          : undefined;
  return {
    sessionId: params.sessionId,
    revision: createHash("sha256")
      .update(
        JSON.stringify([
          snapshot.revision,
          files.map((f) => [f.relativePath, f.bytes]),
          blockedReason,
        ]),
      )
      .digest("hex"),
    sessionIds: snapshot.sessionIds,
    forks: snapshot.forks,
    retainedArtifacts,
    deletedFiles: files.filter(
      (file) =>
        !retainedArtifacts.some(
          (ref) =>
            ref.sessionId === file.sessionId &&
            ref.fileName === file.name &&
            file.kind === "artifact",
        ),
    ).length,
    blockedReason,
    incomplete: snapshot.deleting,
    completed: snapshot.completed,
  };
}

/**
 * 一批根的预检，结果按入参顺序；单项失败只记在该项。
 *
 * 修复原因：逐项预检让每个根各跑一遍 13 条引用全表扫描（见 inspectSessionDeletions）。
 * 修法：整批交给存储层一次扫描。引用只可能指向存在的产物，所以先按“无产物”检查拿到
 * owned tree，再按 artifact 文件判定；有产物的根整批再查一轮引用。执行阶段走同一函数，
 * 把同一判定传进写锁内复检，revision 才与预检一致。
 */
async function inspectMany(
  host: SessionDeletionHost,
  items: readonly V4SessionDeletionParams[],
): Promise<InspectOutcome[]> {
  const listSessionFiles = host.files.listSessionFiles;
  if (!listSessionFiles) throw new Error("session-data.unavailable");
  const listed = new Map<string, Promise<SessionDataFile[]>>();
  const filesOf = (id: string) => {
    let files = listed.get(id);
    if (!files) {
      files = listSessionFiles(id);
      // 失败的列举仍由读取该项的调用记为单项错误，这里只避免未处理的拒绝。
      files.catch(() => undefined);
      listed.set(id, files);
    }
    return files;
  };
  const outcomes: InspectOutcome[] = [];
  const scan = items.map(() => false);
  let pending = items.map((_, index) => index);
  for (let round = 0; pending.length; round++) {
    const target = (index: number) => ({
      sessionId: items[index]!.sessionId as SessionId,
      scanArtifactReferences: scan[index],
    });
    let snapshots: Array<SessionDeletionSnapshot | { error: unknown }>;
    try {
      snapshots = await host.store.inspectSessionDeletions(pending.map(target));
    } catch (batchError) {
      // 单个根的存储异常（如删除凭据 JSON 损坏）不能拖累同批其他根：
      // 整批失败时逐根重查，只把仍失败的根记为单项错误。
      if (pending.length === 1) snapshots = [{ error: batchError }];
      else {
        snapshots = [];
        for (const index of pending)
          snapshots.push(
            await host.store.inspectSessionDeletions([target(index)]).then(
              ([snapshot]) => snapshot!,
              (error: unknown) => ({ error }),
            ),
          );
      }
    }
    const next: number[] = [];
    for (const [position, index] of pending.entries()) {
      const params = items[index]!;
      const entry = snapshots[position]!;
      if ("error" in entry) {
        outcomes[index] = { error: entry.error };
        continue;
      }
      const snapshot = entry;
      try {
        if (
          snapshot.workspacePath &&
          (snapshot.workspacePath !== params.workspace.workspacePath ||
            (snapshot.workspaceIdentity ?? "") !== (params.workspace.workspaceIdentity ?? ""))
        )
          throw new Error("session-data.identity-mismatch");
        const files: Array<SessionDataFile & { sessionId: string }> = [];
        for (const sessionId of snapshot.sessionIds)
          for (const file of await filesOf(sessionId)) files.push({ ...file, sessionId });
        // 只重查一轮：第二轮时 owned tree 又变了，revision 会不同，执行时按 changed 拒绝。
        if (round === 0 && files.some((file) => file.kind === "artifact")) {
          scan[index] = true;
          next.push(index);
          continue;
        }
        outcomes[index] = {
          snapshot,
          preview: buildPreview(host, params, snapshot, files),
          scan: scan[index]!,
        };
      } catch (error) {
        outcomes[index] = { error };
      }
    }
    pending = next;
  }
  return outcomes;
}
async function inspect(host: SessionDeletionHost, params: V4SessionDeletionParams) {
  const outcome = (await inspectMany(host, [params]))[0]!;
  if ("error" in outcome) throw outcome.error;
  return outcome;
}
function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
    return error.code || "session-data.unavailable";
  return (error instanceof Error && error.message) || "session-data.unavailable";
}
export async function previewSessionDeletionWith(
  host: SessionDeletionHost,
  params: V4SessionDeletionParams,
): Promise<V4SessionDeletionPreview> {
  return (await inspect(host, params)).preview;
}
export async function previewSessionDeletionsWith(
  host: SessionDeletionHost,
  params: V4SessionDeletionPreviewBatchParams,
): Promise<V4SessionDeletionPreviewBatchResult> {
  return {
    results: (await inspectMany(host, params.items)).map((outcome) =>
      "error" in outcome
        ? { error: { code: errorCode(outcome.error) } }
        : { preview: outcome.preview },
    ),
  };
}
export async function executeSessionDeletionWith(
  host: SessionDeletionHost,
  params: V4SessionDeletionExecuteParams,
): Promise<V4SessionDeletionResult> {
  const { snapshot, preview, scan } = await inspect(host, params);
  const result = {
    sessionId: params.sessionId,
    sessionIds: preview.sessionIds,
    retainedArtifacts: preview.retainedArtifacts.length,
  };
  if (snapshot.completed) return { ...result, status: "deleted" };
  if (preview.blockedReason) return { ...result, status: "blocked", reason: preview.blockedReason };
  if (!snapshot.deleting && preview.revision !== params.revision)
    return { ...result, status: "blocked", reason: "changed" };
  // 文件检查跨 await；准入前同步再次检查 runtime，持久屏障提交后所有新命令都会被拒绝。
  if (snapshot.sessionIds.some((id) => host.busy(id)))
    return { ...result, status: "blocked", reason: "running" };
  let admitted = snapshot.deleting;
  try {
    await host.store.beginSessionDeletion(
      params.sessionId as SessionId,
      snapshot.revision,
      params.operationId,
      preview.retainedArtifacts.map((ref) => ({
        sessionId: ref.sessionId as SessionId,
        artifactId: ref.artifactId,
      })),
      { scanArtifactReferences: scan },
    );
    admitted = true;
    for (const id of snapshot.sessionIds) await host.release(id);
    for (const id of snapshot.sessionIds)
      await host.files.removeSession(
        id,
        preview.retainedArtifacts
          .filter((ref) => ref.sessionId === id)
          .map((ref) => ref.artifactId),
      );
    await host.store.completeSessionDeletion(params.sessionId as SessionId);
    for (const id of snapshot.sessionIds) host.forget(id);
    return { ...result, status: "deleted" };
  } catch (error) {
    const reason =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "unavailable";
    return { ...result, status: admitted ? "incomplete" : "blocked", reason };
  }
}
function hostFromContext(context: ZCodeProtocolAgentServerContext): SessionDeletionHost {
  const store = context.deps.sessionStore;
  const files = context.deps.sessionDataFiles;
  if (
    !store?.inspectSessionDeletions ||
    !store.beginSessionDeletion ||
    !store.completeSessionDeletion ||
    !files
  )
    throw new Error("session-data.unavailable");
  const pool = createSessionResidentPoolHost(context);
  return {
    store: {
      inspectSessionDeletions: store.inspectSessionDeletions.bind(store),
      beginSessionDeletion: store.beginSessionDeletion.bind(store),
      completeSessionDeletion: store.completeSessionDeletion.bind(store),
    },
    files,
    loaded: (id) => context.sessions.has(id),
    busy(id) {
      if (context.sessionCreationIds?.has(id) || (context.sessionRequestCounts?.get(id) ?? 0) > 0)
        return true;
      const facts = pool.readResidencyFacts(id);
      return Boolean(
        facts &&
        (facts.hasResidencyBlockingWork || facts.hasPendingInteractions || facts.hasQueuedCommands),
      );
    },
    release: (id) => deactivateSessionRecord(context, id),
    forget: (id) => context.v4Gateway?.forgetIndexedSession(id),
  };
}
export async function previewSessionDeletion(
  context: ZCodeProtocolAgentServerContext,
  raw: unknown,
) {
  return previewSessionDeletionWith(
    hostFromContext(context),
    parseParams(v4SessionDeletionParamsSchema, raw),
  );
}
export async function previewSessionDeletions(
  context: ZCodeProtocolAgentServerContext,
  raw: unknown,
) {
  return previewSessionDeletionsWith(
    hostFromContext(context),
    parseParams(v4SessionDeletionPreviewBatchParamsSchema, raw),
  );
}
export async function executeSessionDeletion(
  context: ZCodeProtocolAgentServerContext,
  raw: unknown,
) {
  const result = await executeSessionDeletionWith(
    hostFromContext(context),
    parseParams(v4SessionDeletionExecuteParamsSchema, raw),
  );
  context.logger?.info("Session permanent deletion", {
    event: "session.permanent_delete",
    status: result.status === "deleted" ? "completed" : "failed",
    deletionStatus: result.status,
    retainedArtifacts: result.retainedArtifacts,
  });
  return result;
}
