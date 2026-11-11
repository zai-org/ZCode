import { HookEventName, traceContextToLogContext } from "../deps.js";
import type { HookRunResult, Model, TraceContext, TurnState } from "../deps.js";
import type { HookEventName as HookEventNameType } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  isRuntimeAttachmentEntry,
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { buildProjectionAnchor } from "./projection-anchor.js";
import { persistRuntimeReminderMessage } from "./runtime-reminder-persistence.js";

const MAX_STOP_HOOK_CONTINUATIONS = 3;

const EMPTY_HOOK_RESULT: HookRunResult = {
  additionalContexts: [],
};
const HOOK_CONTEXT_MAX_CHARS = 24_000;
const HOOK_PREVIEW_MAX_CHARS = 4_000;

type SessionStartSource = "startup" | "resume" | "fork" | "clear" | "compact";

/**
 * SessionStart 结果的待写槽：startup 运行时会话行还没创建；resume 只是打开会话，
 * 写库会让每次打开都多一行。下一轮会话写库后再提交。runtime 释放时一起丢弃。
 */
const pendingSessionStartContexts = new WeakMap<AgentRuntimeInternal, RuntimeAttachmentEntry>();

export async function runSessionStartHooks(
  this: AgentRuntimeInternal,
  source: SessionStartSource,
  traceContext: TraceContext,
  signal?: AbortSignal,
  model?: Pick<Model, "providerId" | "modelId">,
): Promise<HookRunResult> {
  // compact 每次 compaction 后都运行；其他来源每个 runtime 只运行一次。
  const oncePerRuntime = source !== "compact";
  if (oncePerRuntime && this.sessionStartHookRan) return EMPTY_HOOK_RESULT;
  await this.workspaceHookAdmission?.activate(source, signal);
  if (oncePerRuntime) this.sessionStartHookRan = true;
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;

  const selectedModel = model ?? this.getSessionModelSelection();
  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.SessionStart,
      mode: this.getMode(),
      model: selectedModel ? `${selectedModel.providerId}/${selectedModel.modelId}` : undefined,
      sessionId: this.sessionId,
      source,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { matchValue: source, signal },
  );
}

export async function runUserPromptSubmitHooks(
  this: AgentRuntimeInternal,
  prompt: string,
  attachments: TurnState["attachments"] | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;

  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      attachmentsSummary: summarizeTurnAttachments(attachments),
      cwd: this.workingDirectory,
      hookEventName: HookEventName.UserPromptSubmit,
      mode: this.getMode(),
      prompt,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export async function runStopHooks(
  this: AgentRuntimeInternal,
  response: string,
  toolCallCount: number,
  traceContext: TraceContext,
  signal?: AbortSignal,
  stopHookActive = false,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  const responsePreview = truncateForHook(response, HOOK_PREVIEW_MAX_CHARS);

  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.Stop,
      mode: this.getMode(),
      responsePreview,
      responseText: response,
      sessionId: this.sessionId,
      stopHookActive,
      timestamp: new Date().toISOString(),
      toolCallCount,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

/** 生命周期 Hook 的多条上下文合成一条 `hook_context`；没有上下文时返回 undefined。 */
export function buildLifecycleHookContextEntry(
  eventName: HookEventNameType,
  additionalContexts: readonly string[],
): RuntimeAttachmentEntry | undefined {
  if (additionalContexts.length === 0) return undefined;
  return systemReminderAttachmentEntry(
    "hook_context",
    formatLifecycleHookAdditionalContextBody(eventName, additionalContexts),
  );
}

/** SessionStart（startup / resume / fork）的结果放进待写槽；只保留最新一次非空结果。 */
export function stageSessionStartContext(
  runtime: AgentRuntimeInternal,
  additionalContexts: readonly string[],
): void {
  const entry = buildLifecycleHookContextEntry(HookEventName.SessionStart, additionalContexts);
  if (entry) pendingSessionStartContexts.set(runtime, entry);
}

/**
 * 会话写库之后、本轮输入之前调用：待写槽先写库，再进历史。
 * 正文与历史里最近一份 SessionStart 上下文逐字相同时丢弃，不写库也不进历史。
 * 去重原因：常驻池空闲释放后每次重开都会运行 resume，输出不变的 hook 若每次都写，上下文会持续累积。
 * 比较放在提交时而不是暂存时：重开之后的 rewind 可能切掉最近那一份，提交时的历史才是本轮发给模型的历史。
 */
export async function commitPendingSessionStartContext(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const entry = pendingSessionStartContexts.get(runtime);
  if (!entry) return;
  const duplicate =
    entry.content ===
    latestSessionStartContext(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
  if (!duplicate) {
    await persistRuntimeReminderMessage.call(runtime, entry, traceContext, {
      anchor: buildProjectionAnchor(traceContext, "synthetic"),
    });
    runtime.messageHistory.addEntries([entry]);
  }
  pendingSessionStartContexts.delete(runtime);
  logSessionStartContext(
    runtime,
    traceContext,
    "pending",
    duplicate ? "skipped_duplicate" : "written",
  );
}

/**
 * compaction 用：摘要生成之后、提交之前以 compact 重跑 SessionStart（不受每个 runtime 只运行一次的限制）。
 * 返回的 entry 作为 compaction 附件的最后一项，与边界、摘要同一次提交并计入压缩后 token。
 * 不能在提交之后单独写入：那一步出错会把已提交的 compaction 当作失败，压缩后 token 也算不上它。
 * 压缩后的历史里只有保留部分可能含 SessionStart 上下文，正文与其中最近一份相同时不写。
 * hasContext 表示 hook 有结果（包括因去重不写），调用方据此在提交成功后丢弃待写槽。
 */
export async function runCompactSessionStartHooks(
  runtime: AgentRuntimeInternal,
  preservedEntries: readonly RuntimeMessageEntry[],
  traceContext: TraceContext,
  signal?: AbortSignal,
  model?: Pick<Model, "providerId" | "modelId">,
): Promise<{ entry?: RuntimeAttachmentEntry; hasContext: boolean }> {
  const result = await runtime.runSessionStartHooks("compact", traceContext, signal, model);
  const entry = buildLifecycleHookContextEntry(
    HookEventName.SessionStart,
    result.additionalContexts,
  );
  if (!entry) return { hasContext: false };
  const duplicate = entry.content === latestSessionStartContext(preservedEntries);
  // 这里还没提交，included 只表示放进了 compaction 附件。
  logSessionStartContext(
    runtime,
    traceContext,
    "compact",
    duplicate ? "skipped_duplicate" : "included",
  );
  return duplicate ? { hasContext: true } : { entry, hasContext: true };
}

/** compaction 提交成功、compact 有结果时调用：还没提交的 startup / resume 结果被这次结果替换。 */
export function discardPendingSessionStartContext(runtime: AgentRuntimeInternal): void {
  pendingSessionStartContexts.delete(runtime);
}

function latestSessionStartContext(entries: readonly RuntimeMessageEntry[]): string | undefined {
  const prefix = lifecycleHookContextPrefix(HookEventName.SessionStart);
  return entries.findLast(
    (entry): entry is RuntimeAttachmentEntry =>
      isRuntimeAttachmentEntry(entry) &&
      entry.metadata.source === "hook_context" &&
      entry.content.startsWith(prefix),
  )?.content;
}

function logSessionStartContext(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  phase: "pending" | "compact",
  result: "written" | "included" | "skipped_duplicate",
): void {
  // 每次打开会话、每次 compaction 至多一条；排查冷恢复后缓存失效时要看到写入还是去重跳过，所以用 info。
  runtime.logger?.info("SessionStart hook context resolved", {
    ...traceContextToLogContext(traceContext),
    event: "hook.session_start_context.resolved",
    module: "core.runtime",
    phase,
    result,
    status: "completed",
  });
}

export function shouldContinueAfterStopHooks(
  result: HookRunResult,
  continuationCount: number,
): boolean {
  return (
    result.stopShouldContinue === true &&
    result.additionalContexts.length > 0 &&
    continuationCount < MAX_STOP_HOOK_CONTINUATIONS
  );
}

function lifecycleHookContextPrefix(eventName: HookEventNameType): string {
  return `${eventName} hook additional context: `;
}

function formatLifecycleHookAdditionalContextBody(
  eventName: HookEventNameType,
  additionalContexts: readonly string[],
): string {
  const body = additionalContexts.map((context, index) => `#${index + 1}\n${context}`).join("\n\n");
  return truncateForHook(
    [lifecycleHookContextPrefix(eventName), body].join("\n"),
    HOOK_CONTEXT_MAX_CHARS,
  );
}

function summarizeTurnAttachments(
  attachments: TurnState["attachments"] | undefined,
): string | undefined {
  if (!attachments || attachments.length === 0) return undefined;

  return attachments
    .map((attachment, index) => {
      if (attachment.path) return `${index + 1}:${attachment.type}:${attachment.path}`;
      if (attachment.content)
        return `${index + 1}:${attachment.type}:inline:${attachment.content.length} chars`;
      return `${index + 1}:${attachment.type}`;
    })
    .join("\n");
}

function truncateForHook(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}
