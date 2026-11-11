import { createHash } from "node:crypto";
import type { SessionId, SessionStorePort } from "@zcode/contracts";
import type { SessionDataFilesPort } from "@zcode/adapters/storage";
import {
  v4SessionDeletionParamsSchema,
  v4SessionDeletionExecuteParamsSchema,
  type V4SessionDeletionParams,
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
      "inspectSessionDeletion" | "beginSessionDeletion" | "completeSessionDeletion"
    >
  >;
  files: SessionDataFilesPort;
  busy(id: string): boolean;
  loaded?(id: string): boolean;
  release(id: string): Promise<void>;
  forget(id: string): void;
}

async function inspect(host: SessionDeletionHost, params: V4SessionDeletionParams) {
  const snapshot = await host.store.inspectSessionDeletion(params.sessionId as SessionId);
  if (
    snapshot.workspacePath &&
    (snapshot.workspacePath !== params.workspace.workspacePath ||
      (snapshot.workspaceIdentity ?? "") !== (params.workspace.workspaceIdentity ?? ""))
  )
    throw new Error("session-data.identity-mismatch");
  if (!host.files.listSessionFiles) throw new Error("session-data.unavailable");
  const files: Array<
    Awaited<ReturnType<NonNullable<SessionDataFilesPort["listSessionFiles"]>>>[number] & {
      sessionId: string;
    }
  > = [];
  for (const sessionId of snapshot.sessionIds)
    for (const file of await host.files.listSessionFiles(sessionId))
      files.push({ ...file, sessionId });
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
  const preview: V4SessionDeletionPreview = {
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
  return { snapshot, preview };
}
export async function previewSessionDeletionWith(
  host: SessionDeletionHost,
  params: V4SessionDeletionParams,
): Promise<V4SessionDeletionPreview> {
  return (await inspect(host, params)).preview;
}
export async function executeSessionDeletionWith(
  host: SessionDeletionHost,
  params: V4SessionDeletionExecuteParams,
): Promise<V4SessionDeletionResult> {
  const { snapshot, preview } = await inspect(host, params);
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
    !store?.inspectSessionDeletion ||
    !store.beginSessionDeletion ||
    !store.completeSessionDeletion ||
    !files
  )
    throw new Error("session-data.unavailable");
  const pool = createSessionResidentPoolHost(context);
  return {
    store: {
      inspectSessionDeletion: store.inspectSessionDeletion.bind(store),
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
