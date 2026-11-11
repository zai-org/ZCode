// ============================================================
// 主会话 prompt 快照（docs/design/v2/loop/prompt-snapshot.md）
// ============================================================
// 记录主会话发出的 system，之后的请求按记录发送，冷恢复和升级后 system 字节不变。
// 工具不记录：MCP 工具在会话中途会变，每次请求按当前注册表发送。
// 存在 session_entry（每个会话一行，覆盖写）；runtime.promptSnapshot 是内存副本，
// undefined 表示还没有快照，null 表示 compaction 已清掉。

import { SESSION_ENTRY_PROMPT_SNAPSHOT, type ModelInputMessage } from "@zcode/contracts";
import {
  countContextPrefixMessages,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { traceContextToLogContext, type Model, type TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { querySourceForTask } from "../methods/turn-model-step-usage.js";

type ModelIdentity = Pick<Model, "providerId" | "modelId">;

export interface PromptSnapshot {
  model: { providerId: string; modelId: string };
  system: ModelInputMessage[];
}

/** 只有带 session store 的主会话使用快照；子 agent 与工作流 actor 不用。 */
export function usesPromptSnapshot(runtime: AgentRuntimeInternal): boolean {
  return (
    Boolean(runtime.sessionStore) && querySourceForTask(runtime.config.taskType) === "main_turn"
  );
}

/** 请求模型与快照模型相同（只比较 provider 与 model id）时返回快照。 */
export function promptSnapshotFor(
  runtime: AgentRuntimeInternal,
  model: ModelIdentity | undefined,
): PromptSnapshot | undefined {
  const snapshot = runtime.promptSnapshot;
  if (!snapshot || !model || !usesPromptSnapshot(runtime)) return undefined;
  return snapshot.model.providerId === model.providerId && snapshot.model.modelId === model.modelId
    ? snapshot
    : undefined;
}

/** 恢复会话时读取快照；读取失败或数据无效都按没有快照处理，不阻断恢复。 */
export async function loadPromptSnapshot(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  runtime.promptSnapshot = undefined;
  if (!usesPromptSnapshot(runtime)) return;
  try {
    const entries = await runtime.sessionStore?.sessionEntries?.({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_PROMPT_SNAPSHOT,
    });
    runtime.promptSnapshot = parsePromptSnapshot(entries?.at(-1)?.data);
  } catch (error) {
    runtime.logger?.warn("Prompt snapshot read failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "prompt_snapshot.read_failed",
    });
  }
}

/**
 * 主循环请求准备之后调用：没有可用快照、且请求用的是会话模型（不是固定执行模型）时，
 * 按本次请求的前缀记录 system。
 */
export async function recordPromptSnapshot(
  runtime: AgentRuntimeInternal,
  input: {
    model: ModelIdentity;
    modelSelectionScope?: "execution";
    entries: readonly RuntimeMessageEntry[];
    traceContext: TraceContext;
  },
): Promise<void> {
  if (!usesPromptSnapshot(runtime) || promptSnapshotFor(runtime, input.model)) return;
  if (input.modelSelectionScope === "execution" || !isSessionModel(runtime, input.model)) return;
  const snapshot: PromptSnapshot = {
    model: { providerId: input.model.providerId, modelId: input.model.modelId },
    system: leadingSystemMessages(input.entries),
  };
  runtime.promptSnapshot = snapshot;
  await savePromptSnapshotEntry(runtime, snapshot, input.traceContext);
}

/** compaction 成功后清掉快照；返回之前是否有快照（有则调用方要重建前缀）。 */
export async function clearPromptSnapshot(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<boolean> {
  if (!usesPromptSnapshot(runtime)) return false;
  const hadSnapshot = Boolean(runtime.promptSnapshot);
  runtime.promptSnapshot = null;
  // 修复原因：原来内存里没有快照就不写清除标记。冷恢复读快照失败时内存为空，库里却还是
  // 压缩前那一行；压缩后没再记录就退出，下次冷恢复会把压缩前的 system 用到压缩后的窗口。
  // 库里的行是否清掉不能由内存副本决定，主会话每次压缩成功都写。
  await savePromptSnapshotEntry(runtime, { cleared: true }, traceContext);
  return hadSnapshot;
}

/** fork 时复制到 child 会话的 entry；没有快照时不复制。 */
export function buildForkedPromptSnapshotEntry(
  runtime: AgentRuntimeInternal,
  childSessionId: AgentRuntimeInternal["sessionId"],
) {
  const snapshot = runtime.promptSnapshot;
  if (!snapshot || !usesPromptSnapshot(runtime)) return undefined;
  return promptSnapshotEntry(childSessionId, structuredClone(snapshot));
}

/**
 * legacy fork 建 child 后复制父会话当前的快照；没有快照时不写。
 * 写入失败只记 warning、不中断 fork，与主会话的快照写入相同：child 少一份快照无害，第一个请求会
 * 自己记录；中断则会留下一个没有消息的 child。
 */
export async function copyPromptSnapshotToFork(
  runtime: AgentRuntimeInternal,
  childSessionId: AgentRuntimeInternal["sessionId"],
  traceContext: TraceContext,
): Promise<void> {
  const entry = buildForkedPromptSnapshotEntry(runtime, childSessionId);
  if (entry) await saveEntry(runtime, entry, traceContext);
}

function isSessionModel(runtime: AgentRuntimeInternal, model: ModelIdentity): boolean {
  const selection = runtime.getSessionModelSelection();
  return selection?.providerId === model.providerId && selection.modelId === model.modelId;
}

function leadingSystemMessages(entries: readonly RuntimeMessageEntry[]): ModelInputMessage[] {
  return entries.slice(0, countContextPrefixMessages(entries)).flatMap((entry) =>
    entry.kind !== "attachment" && entry.message.role === "system"
      ? [
          {
            role: "system" as const,
            content: structuredClone(entry.message.content),
            ...(entry.message.cacheControl
              ? { cacheControl: { ...entry.message.cacheControl } }
              : {}),
          },
        ]
      : [],
  );
}

async function savePromptSnapshotEntry(
  runtime: AgentRuntimeInternal,
  data: PromptSnapshot | { cleared: true },
  traceContext: TraceContext,
): Promise<void> {
  await saveEntry(runtime, promptSnapshotEntry(runtime.sessionId, data), traceContext);
}

/** 快照行写入失败只记 warning，不中断调用方。 */
async function saveEntry(
  runtime: AgentRuntimeInternal,
  entry: ReturnType<typeof promptSnapshotEntry>,
  traceContext: TraceContext,
): Promise<void> {
  try {
    await runtime.sessionStore?.saveSessionEntry?.(entry);
  } catch (error) {
    runtime.logger?.warn("Prompt snapshot write failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "prompt_snapshot.write_failed",
    });
  }
}

function promptSnapshotEntry(
  sessionId: AgentRuntimeInternal["sessionId"],
  data: PromptSnapshot | { cleared: true },
) {
  const timestamp = Date.now();
  return {
    id: `${sessionId}:runtime-prompt-snapshot`,
    sessionID: sessionId,
    type: SESSION_ENTRY_PROMPT_SNAPSHOT,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data,
  };
}

export function parsePromptSnapshot(data: unknown): PromptSnapshot | null | undefined {
  if (!isRecord(data)) return undefined;
  if (data.cleared === true) return null;
  const { model, system } = data;
  if (
    !isRecord(model) ||
    typeof model.providerId !== "string" ||
    typeof model.modelId !== "string" ||
    !Array.isArray(system)
  )
    return undefined;
  const systemValid = system.every(
    (message) =>
      isRecord(message) &&
      message.role === "system" &&
      (typeof message.content === "string" || Array.isArray(message.content)) &&
      (message.cacheControl === undefined || isRecord(message.cacheControl)),
  );
  if (!systemValid) return undefined;
  return {
    model: { providerId: model.providerId, modelId: model.modelId },
    system: system as ModelInputMessage[],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
