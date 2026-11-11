import type { ExtensionAuditEntry } from "@zcode/shared/extension-host";

// 写动作的审计行（docs/plugins/extension-host.md §17.8，实现 P3c-1）：只从入参与结果里取身份、目标与长度，
// 不写提示词、标题、正文、路径、错误原文，也不写结果里可能是自由文本的 reason。

interface SessionRefLike {
  sourceServerId?: unknown;
  sessionId?: unknown;
  project?: { projectId?: unknown } | undefined;
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** 结果是 rejected / unknown 时审计记 error（`result.<状态>`）；status、creation、admission 三选一。 */
function resultCode(result: unknown): string | undefined {
  const value = record(result);
  const state = text(value.status) ?? text(value.creation) ?? text(value.admission);
  return state === "rejected" || state === "unknown" ? `result.${state}` : undefined;
}

/**
 * 回答与切换（§17.12）的正常结果 stale / unchanged：outcome 仍为 ok，另记 errorCode 便于区分「没有发命令」。
 * 只对这两个能力：别的写动作的 unchanged 等状态维持原口径。
 */
const NOOP_RESULT_CAPABILITIES = new Set([
  "sessions.resolveInteraction",
  "sessions.setPermissionMode",
]);
function noopCode(capability: string, result: unknown): string | undefined {
  if (!NOOP_RESULT_CAPABILITIES.has(capability)) return undefined;
  const state = text(record(result).status);
  return state === "stale" || state === "unchanged" ? `result.${state}` : undefined;
}

export function buildSessionWriteAudit(options: {
  pluginId: string;
  gen: number;
  capability: string;
  sourceServerId: string;
  input: unknown;
  result?: unknown;
  errorCode?: string;
  /** 回答与切换的补充字段（§17.12）：交互种类、选择的种类、模式。不含内容。 */
  details?: { interactionKind?: "permission" | "userInput"; choice?: string; mode?: string };
  durationMs: number;
}): Omit<ExtensionAuditEntry, "v" | "ts"> {
  const input = record(options.input);
  const result = record(options.result);
  const session = (record(input.session) as SessionRefLike) ?? {};
  const resultSession = record(result.session) as SessionRefLike;
  const operation = record(result.operation);
  const sessionId =
    text(input.sessionId) ?? text(session.sessionId) ?? text(resultSession.sessionId);
  const projectId =
    text(record(input.project).projectId) ??
    text(record(session.project).projectId) ??
    text(record(resultSession.project).projectId);
  const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
  const errorCode = options.errorCode ?? resultCode(options.result);
  const noop = errorCode ? undefined : noopCode(options.capability, options.result);
  // createSession 的权限模式也记（§17.12）；回答与切换的模式来自 details。
  const mode = options.details?.mode ?? text(input.mode);
  return {
    gen: options.gen,
    pluginId: options.pluginId,
    capability: options.capability,
    grant: "sessions.write",
    ...(text(input.requestId) ? { requestId: text(input.requestId) } : {}),
    ...(text(operation.commandId) ? { commandId: text(operation.commandId) } : {}),
    target: {
      sourceServerId: text(session.sourceServerId) ?? options.sourceServerId,
      ...(sessionId ? { sessionId } : {}),
      ...(projectId ? { projectId } : {}),
    },
    outcome: errorCode ? "error" : "ok",
    ...(errorCode ? { errorCode } : noop ? { errorCode: noop } : {}),
    ...(prompt !== undefined ? { promptChars: prompt.length } : {}),
    ...(options.details?.interactionKind
      ? { interactionKind: options.details.interactionKind }
      : {}),
    ...(options.details?.choice ? { choice: options.details.choice } : {}),
    ...(mode ? { mode } : {}),
    durationMs: Math.max(0, Math.round(options.durationMs)),
  };
}
