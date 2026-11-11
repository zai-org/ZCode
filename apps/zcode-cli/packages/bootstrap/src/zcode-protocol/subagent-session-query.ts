import { Buffer } from "node:buffer";
import {
  createSessionId,
  SessionEventType,
  selectActiveConversationBranch,
  type BackgroundTaskInfo,
  type MessageWithParts,
  type SessionEvent,
  type SessionInfo,
  type SessionProjection,
  type ToolPart,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
} from "@zcode/contracts";
import { readSubagentRunMetadata, type SubagentRunMetadata } from "@zcode/core";
import type { ZCodeSessionEndedSubagent, ZCodeSessionRunningSubagent } from "@zcode/shared";

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);
const CANCELLATION_PATTERN = /abort|cancel|interrupt|stop/i;
const BACKGROUND_LAUNCH_ACK_PREFIX = "Async agent launched successfully.";

interface SubagentCandidate {
  agentId?: string;
  childSessionId: string;
  runInBackground: boolean;
  /** 父 tool part 是后台 launch ACK（纯文本）：它的 completed 只表示「已启动」，不是 child 的终态。 */
  launchAcknowledged: boolean;
  /** launch ACK 里的 output_file（metadata.json 在同一目录）。 */
  outputFile?: string;
  output: Record<string, unknown> | null;
  part: ToolPart;
  subagentType: string;
  summary?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled";
  title: string;
}

interface SubagentEventRelation {
  agentId?: string;
  childSessionId?: string;
  description?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled";
  subagentType?: string;
  summary?: string;
}

export interface SessionSubagentProjection {
  revision: number;
  running: ZCodeSessionRunningSubagent[];
  ended: ZCodeSessionEndedSubagent[];
}

export interface ProjectSessionSubagentsInput {
  revision: number;
  parentSession: SessionInfo;
  messages: readonly MessageWithParts[];
  childSessionsById: ReadonlyMap<string, SessionInfo>;
  childMessagesById: ReadonlyMap<string, readonly MessageWithParts[]>;
  childProjectionsById: ReadonlyMap<string, SessionProjection>;
  parentProjection?: SessionProjection;
  parentEvents?: readonly SessionEvent[];
  /**
   * 当前 runtime 进程的启动时间（`performance.timeOrigin`）。给出时，启动早于本进程、且本进程
   * 没有任何活事实的 Agent 判为上一代 runtime 的遗留，不再算 running。缺省时不做该判断。
   */
  runtimeStartedAt?: number;
  /**
   * 上一代 runtime 遗留候选的 metadata.json（按 childSessionId），由异步层用
   * `loadPreviousRuntimeRunMetadata` 预读。它是唯一跨进程保留的终态：新进程读不到旧进程内存里的
   * SubagentStopped，正常关闭时被统一停止的 Agent 只能从这里认出 stopped。
   */
  previousRuntimeRunMetadata?: ReadonlyMap<string, SubagentRunMetadata>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringField(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(source[key]);
    if (value) return value;
  }
  return undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function agentIdFromLaunchAcknowledgement(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return nonEmptyString(value.match(/(?:^|\n)agentId:\s*([^\s(]+)/)?.[1]);
}

function contentBlocksToText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((block) => nonEmptyString(asRecord(block).text))
    .filter((item): item is string => Boolean(item))
    .join("\n\n");
  return text || undefined;
}

function subagentEventRelations(
  events: readonly SessionEvent[] | undefined,
): ReadonlyMap<string, SubagentEventRelation> {
  const relations = new Map<string, SubagentEventRelation>();
  for (const event of events ?? []) {
    if (
      event.type !== SessionEventType.SubagentSpawned &&
      event.type !== SessionEventType.SubagentStopped
    ) {
      continue;
    }
    const payload = asRecord(event.payload);
    const parentToolCallId = stringField(payload, "parentToolCallId");
    if (!parentToolCallId) continue;
    const current = relations.get(parentToolCallId) ?? {};
    if (event.type === SessionEventType.SubagentSpawned) {
      relations.set(parentToolCallId, {
        ...current,
        agentId: stringField(payload, "agentId") ?? current.agentId,
        childSessionId: stringField(payload, "childSessionId") ?? current.childSessionId,
        description: stringField(payload, "description", "prompt") ?? current.description,
        startedAt: event.timestamp.getTime(),
        subagentType: stringField(payload, "agentType") ?? current.subagentType,
      });
      continue;
    }
    const status = stringField(payload, "status");
    relations.set(parentToolCallId, {
      ...current,
      agentId: stringField(payload, "agentId") ?? current.agentId,
      childSessionId: stringField(payload, "childSessionId") ?? current.childSessionId,
      stoppedAt: event.timestamp.getTime(),
      stoppedStatus:
        status === "cancelled" || status === "stopped"
          ? "cancelled"
          : status === "failed" || status === "error"
            ? "failed"
            : "success",
      summary:
        stringField(payload, "summaryText", "result", "error", "description") ?? current.summary,
    });
  }
  return relations;
}

function activeBranchMessages(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
): MessageWithParts[] {
  return selectActiveConversationBranch(messages, {
    branchCutAfterMessageId: session.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session.revert?.createdMessageID,
    rewindKeptMessageIds: session.revert?.keptMessageIDs,
    rewindTargetMessageId: session.revert?.targetMessageID,
  });
}

function candidateFromToolPart(
  part: ToolPart,
  relation?: SubagentEventRelation,
): SubagentCandidate | null {
  if (!SUBAGENT_TOOL_NAMES.has(part.tool)) return null;
  const completedOutput =
    part.state.status === "completed" ? nonEmptyString(part.state.output) : undefined;
  const output = parseJsonObject(completedOutput);
  const input = asRecord(part.state.input);
  const stateMetadata = "metadata" in part.state ? asRecord(part.state.metadata) : {};
  const metadata = { ...asRecord(part.metadata), ...stateMetadata };
  const agentId =
    stringField(output ?? {}, "agentId") ??
    // 后台 Agent 的持久化 launch ACK 是纯文本，cold query 未携带
    // 临时 spawn event 时无法恢复 childSessionId，导致真实 running Agent 被整条跳过。
    // 标准 ACK 自带 agentId，按该稳定字段恢复，与 runtime 的 session id 规则对齐。
    agentIdFromLaunchAcknowledgement(completedOutput) ??
    stringField(metadata, "agentId") ??
    relation?.agentId;
  const childSessionId =
    stringField(output ?? {}, "childSessionId") ??
    stringField(metadata, "childSessionId") ??
    relation?.childSessionId ??
    (agentId ? createSessionId(`subagent_${agentId}`) : undefined);
  if (!childSessionId) return null;
  const title =
    stringField(output ?? {}, "description") ??
    stringField(input, "description") ??
    stringField(metadata, "description") ??
    relation?.description ??
    stringField(input, "prompt") ??
    "Subagent";
  const launchAcknowledged = completedOutput?.startsWith(BACKGROUND_LAUNCH_ACK_PREFIX) === true;
  // 取到行尾：Windows 的用户目录可能带空格。
  const outputFile = launchAcknowledged
    ? nonEmptyString(completedOutput?.match(/(?:^|\n)output_file:[ \t]*([^\r\n]+)/)?.[1]?.trim())
    : undefined;
  return {
    childSessionId,
    runInBackground: input.run_in_background === true,
    launchAcknowledged,
    ...(outputFile ? { outputFile } : {}),
    part,
    output,
    agentId: agentId ?? part.callID,
    subagentType:
      stringField(output ?? {}, "agentType") ??
      stringField(metadata, "agentType") ??
      relation?.subagentType ??
      stringField(input, "subagent_type", "agent", "agentType") ??
      "subagent",
    title,
    summary:
      contentBlocksToText(output?.content) ??
      stringField(output ?? {}, "result", "summary") ??
      (part.state.status === "error" ? nonEmptyString(part.state.error) : undefined) ??
      relation?.summary,
    ...(relation?.startedAt !== undefined ? { startedAt: relation.startedAt } : {}),
    ...(relation?.stoppedAt !== undefined ? { stoppedAt: relation.stoppedAt } : {}),
    ...(relation?.stoppedStatus ? { stoppedStatus: relation.stoppedStatus } : {}),
  };
}

function collectCandidates(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): SubagentCandidate[] {
  const candidates = new Map<string, SubagentCandidate>();
  const relations = subagentEventRelations(parentEvents);
  for (const message of activeBranchMessages(session, messages)) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const candidate = candidateFromToolPart(part, relations.get(part.callID));
      if (candidate) candidates.set(candidate.childSessionId, candidate);
    }
  }
  return [...candidates.values()];
}

export function collectSubagentChildSessionIds(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): string[] {
  return collectCandidates(session, messages, parentEvents).map(
    (candidate) => candidate.childSessionId,
  );
}

function lastChildOutcome(messages: readonly MessageWithParts[] | undefined): {
  endedAt?: number;
  status?: "success" | "failed" | "cancelled";
  summary?: string;
} {
  if (!messages || messages.length === 0) return {};
  const assistantMessages = messages.filter((message) => message.info.role === "assistant");
  const last = assistantMessages.at(-1);
  if (!last || last.info.role !== "assistant") return {};
  // stream recovery 作废的半截 assistant 带 error 落盘，但子会话紧接着会从锚点
  // 重发；它是最后一条只说明恢复仍在进行或进程已退出，都不是「子会话失败」的终态。
  if (last.info.error && last.info.error.name === STREAM_RECOVERY_DISCARDED_ERROR_NAME) {
    return {};
  }
  const text = last.parts
    .flatMap((part) => (part.type === "text" && part.ignored !== true ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
  const errorName = last.info.error?.name;
  const errorSummary = last.info.error
    ? (stringField(last.info.error.data ?? {}, "message", "error", "detail") ?? errorName)
    : undefined;
  const hasToolRound = last.parts.some((part) => part.type === "tool");
  return {
    ...(last.info.time.completed ? { endedAt: last.info.time.completed } : {}),
    ...(text || errorSummary ? { summary: text || errorSummary } : {}),
    ...(errorName
      ? { status: CANCELLATION_PATTERN.test(errorName) ? "cancelled" : "failed" }
      : // Bug 根因：assistant 发出 tool call 后，该 model step 也会写 completed/finish；
        // 但 child session 仍在执行 Bash 等工具，不能把“本轮结束”当成“子会话终态”。
        // 只有不含 tool part 的最终 assistant message 才能提供成功 outcome。
        !hasToolRound && (last.info.time.completed || last.info.finish)
        ? { status: "success" }
        : {}),
  };
}

function findBackgroundTask(
  projection: SessionProjection | undefined,
  candidate: SubagentCandidate,
): BackgroundTaskInfo | undefined {
  return projection?.backgroundTasks.find(
    (task) =>
      task.taskKind === "subagent" &&
      (task.childSessionId === candidate.childSessionId ||
        task.toolCallId === candidate.part.callID ||
        task.taskId === candidate.agentId),
  );
}

/**
 * 上一代 runtime 进程启动、且之后再没有活动的 Agent。child 只在启动它的进程里运行，进程退出
 * （崩溃、被杀）后不可能仍在跑；新进程的 registry 是空的，持久化的 launch ACK / running part
 * 又不会被改写，旧逻辑因此把它们永久显示成 running（停止按钮也找不到目标）。
 * 在本进程里被 SendMessage 恢复过的 Agent 带本进程的 spawn 事件，startedAt 晚于进程启动；
 * child session 在本进程启动后仍有更新时（另一个进程正在跑它）同样不判为遗留。
 */
function candidateLaunchedAt(candidate: SubagentCandidate): number | undefined {
  return (
    candidate.startedAt ??
    ("time" in candidate.part.state ? candidate.part.state.time.start : undefined)
  );
}

function isFromPreviousRuntime(input: {
  candidate: SubagentCandidate;
  childSession: SessionInfo;
  runtimeStartedAt?: number;
}): boolean {
  if (input.runtimeStartedAt === undefined) return false;
  const launchedAt = candidateLaunchedAt(input.candidate);
  return (
    launchedAt !== undefined &&
    launchedAt < input.runtimeStartedAt &&
    input.childSession.time.updated < input.runtimeStartedAt
  );
}

function runningStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
  fromPreviousRuntime: boolean;
  parentProjection?: SessionProjection;
}): ZCodeSessionRunningSubagent["status"] | undefined {
  if (input.background?.status === "running") {
    return input.background.blocked ? "blocked" : "running";
  }
  if (input.childProjection?.status === "waiting") return "waiting";
  if (input.childProjection?.status === "running") return "running";
  // async Agent 的父 tool part 在 launch ACK 后立即标成 completed，
  // partial parent projection 又可能暂时不带仍运行的 background task。此时仅按
  // tool part 会把 child 误判为 ended，并在 cold seed 时清空 V4 running 行。
  // child 还没有终态输出、spawn relation 也没有 stop 时，background input 本身
  // 是可恢复的 running 事实；真实终态仍由 background/child projection/outcome 优先。
  if (
    input.candidate.runInBackground &&
    input.background === undefined &&
    input.childProjection === undefined &&
    input.candidate.stoppedStatus === undefined &&
    input.childOutcome.status === undefined &&
    !input.fromPreviousRuntime
  ) {
    return "running";
  }
  if (
    input.parentProjection?.activeToolCalls.some(
      (tool) =>
        tool.toolCallId === input.candidate.part.callID &&
        (tool.status === "pending" || tool.status === "running"),
    )
  ) {
    return "running";
  }
  return input.parentProjection &&
    !input.fromPreviousRuntime &&
    (input.candidate.part.state.status === "pending" ||
      input.candidate.part.state.status === "running")
    ? "running"
    : undefined;
}

function terminalBackgroundStatus(
  task: BackgroundTaskInfo | undefined,
): ZCodeSessionEndedSubagent["status"] | undefined {
  switch (task?.status) {
    case "completed":
      return "success";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "timed_out":
    case "spawn_error":
      return "failed";
    case "lost":
      return "lost";
    default:
      return undefined;
  }
}

/** metadata.json 的终态映射到子代理目录的状态；running 不是终态（旧进程退出时停在这里）。 */
function runMetadataEndedStatus(
  metadata: SubagentRunMetadata | undefined,
): ZCodeSessionEndedSubagent["status"] | undefined {
  switch (metadata?.status) {
    case "completed":
      return "success";
    case "failed":
      return "failed";
    case "stopped":
      return "cancelled";
    default:
      return undefined;
  }
}

function endedStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
  fromPreviousRuntime: boolean;
  runMetadata?: SubagentRunMetadata;
}): ZCodeSessionEndedSubagent["status"] {
  const backgroundStatus = terminalBackgroundStatus(input.background);
  if (backgroundStatus) return backgroundStatus;
  if (input.childProjection?.status === "error") return "failed";
  if (input.childProjection?.status === "completed") return "success";
  if (input.candidate.part.state.status === "error") {
    return CANCELLATION_PATTERN.test(input.candidate.part.state.error) ? "cancelled" : "failed";
  }
  if (input.candidate.stoppedStatus) return input.candidate.stoppedStatus;
  // 上一代进程写下的终态（正常关闭时的统一停止、失败、完成）只在 metadata.json 里跨进程保留，
  // 与恢复时的对账同一事实源（!3562 评审第二轮 CR-01）。
  const metadataStatus = input.fromPreviousRuntime
    ? runMetadataEndedStatus(input.runMetadata)
    : undefined;
  if (metadataStatus) return metadataStatus;
  // 上一代进程退出时没有写下终态：后台 Agent 的 launch ACK 也是 completed，不能据此判 success。
  // 排在已知终态（child projection、工具错误、SubagentStopped、metadata.json）之后，只补「没有任何
  // 终态」的情况，不覆盖它们（!3562 评审 SG-01）。
  if (input.fromPreviousRuntime && input.childOutcome.status === undefined) return "lost";
  const outputStatus = stringField(input.candidate.output ?? {}, "status");
  if (outputStatus === "cancelled" || outputStatus === "stopped") return "cancelled";
  if (outputStatus === "failed" || outputStatus === "error") return "failed";
  // 纯文本 launch ACK 与结构化的 async_launched 同义：completed 只表示已启动，终态看 child。
  // 修复原因：之前按 tool part 的 completed 判 success，冷查询里 child 已失败的后台 Agent 显示为成功。
  if (outputStatus === "async_launched" || input.candidate.launchAcknowledged) {
    return input.childOutcome.status ?? "lost";
  }
  if (input.candidate.part.state.status === "completed") return "success";
  return input.childOutcome.status ?? "lost";
}

function startedAt(
  candidate: SubagentCandidate,
  background?: BackgroundTaskInfo,
): number | undefined {
  if (background?.startedAt) return background.startedAt.getTime();
  if (candidate.startedAt !== undefined) return candidate.startedAt;
  return "time" in candidate.part.state ? candidate.part.state.time.start : undefined;
}

/**
 * 为可能是上一代 runtime 遗留的后台 Agent（launch ACK 早于本进程启动）预读 metadata.json，
 * 交给 `projectSessionSubagents` 的 `previousRuntimeRunMetadata`。路径先用 launch ACK 的
 * output_file，没有时按 runner 的目录布局 `<outputRootDir>/<父会话>/<agentId>`；`outputRootDir`
 * 只在需要时才解析。读不到的不放进结果，投影按原判据处理。
 */
export async function loadPreviousRuntimeRunMetadata(input: {
  parentSession: SessionInfo;
  messages: readonly MessageWithParts[];
  parentEvents?: readonly SessionEvent[];
  runtimeStartedAt: number;
  resolveOutputRootDir?: () => string | undefined;
}): Promise<Map<string, SubagentRunMetadata>> {
  const result = new Map<string, SubagentRunMetadata>();
  const launches = collectCandidates(
    input.parentSession,
    input.messages,
    input.parentEvents,
  ).filter((candidate) => {
    const launchedAt = candidateLaunchedAt(candidate);
    return (
      candidate.launchAcknowledged &&
      candidate.agentId !== undefined &&
      launchedAt !== undefined &&
      launchedAt < input.runtimeStartedAt
    );
  });
  let outputRootDir: string | undefined;
  let outputRootResolved = false;
  await Promise.all(
    launches.map(async (candidate) => {
      if (!candidate.outputFile && !outputRootResolved) {
        outputRootResolved = true;
        outputRootDir = input.resolveOutputRootDir?.();
      }
      if (!candidate.outputFile && !outputRootDir) return;
      const metadata = await readSubagentRunMetadata({
        agentId: candidate.agentId!,
        ...(candidate.outputFile ? { outputFile: candidate.outputFile } : {}),
        ...(outputRootDir ? { outputRootDir } : {}),
        parentSessionId: input.parentSession.id,
      });
      if (metadata) result.set(candidate.childSessionId, metadata);
    }),
  );
  return result;
}

export function projectSessionSubagents(
  input: ProjectSessionSubagentsInput,
): SessionSubagentProjection {
  const running: ZCodeSessionRunningSubagent[] = [];
  const ended: ZCodeSessionEndedSubagent[] = [];
  for (const candidate of collectCandidates(
    input.parentSession,
    input.messages,
    input.parentEvents,
  )) {
    const childSession = input.childSessionsById.get(candidate.childSessionId);
    if (!childSession || childSession.taskType !== "subagent_child") continue;
    const childProjection = input.childProjectionsById.get(candidate.childSessionId);
    const background = findBackgroundTask(input.parentProjection, candidate);
    const childOutcome = lastChildOutcome(input.childMessagesById.get(candidate.childSessionId));
    const fromPreviousRuntime = isFromPreviousRuntime({
      candidate,
      childSession,
      runtimeStartedAt: input.runtimeStartedAt,
    });
    const liveStatus = runningStatus({
      background,
      candidate,
      childOutcome,
      childProjection,
      fromPreviousRuntime,
      parentProjection: input.parentProjection,
    });
    const common = {
      childSessionId: candidate.childSessionId,
      ...(candidate.agentId ? { agentId: candidate.agentId } : {}),
      toolCallId: candidate.part.callID,
      subagentType: candidate.subagentType,
      title: candidate.title,
      ...(startedAt(candidate, background) !== undefined
        ? { startedAt: startedAt(candidate, background) }
        : {}),
    };
    if (liveStatus) {
      running.push({ ...common, status: liveStatus });
      continue;
    }
    const stateEndedAt =
      "time" in candidate.part.state && "end" in candidate.part.state.time
        ? candidate.part.state.time.end
        : undefined;
    const runMetadata = input.previousRuntimeRunMetadata?.get(candidate.childSessionId);
    const status = endedStatus({
      background,
      candidate,
      childOutcome,
      childProjection,
      fromPreviousRuntime,
      runMetadata,
    });
    const metadataEndedAt =
      fromPreviousRuntime && runMetadataEndedStatus(runMetadata) === status
        ? runMetadata?.completedAt
        : undefined;
    ended.push({
      ...common,
      status,
      ...(candidate.summary || childOutcome.summary
        ? { summary: candidate.summary ?? childOutcome.summary }
        : {}),
      endedAt:
        // 遗留 Agent 停在旧进程退出前最后一次落盘的时刻，launch ACK 的时间不是它的结束时间。
        (fromPreviousRuntime && status === "lost"
          ? (childOutcome.endedAt ?? childSession.time.updated)
          : undefined) ??
        metadataEndedAt ??
        background?.completedAt?.getTime() ??
        candidate.stoppedAt ??
        stateEndedAt ??
        childOutcome.endedAt ??
        childSession.time.updated,
    });
  }
  running.sort(
    (left, right) =>
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  ended.sort(
    (left, right) =>
      (right.endedAt ?? 0) - (left.endedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  return { revision: input.revision, running, ended };
}

function encodeCursor(item: ZCodeSessionEndedSubagent): string {
  return Buffer.from(
    JSON.stringify({ childSessionId: item.childSessionId, endedAt: item.endedAt ?? 0 }),
  ).toString("base64url");
}

function decodeCursor(cursor: string | undefined): {
  childSessionId: string;
  endedAt: number;
} | null {
  if (!cursor) return null;
  try {
    const value = asRecord(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
    );
    const childSessionId = nonEmptyString(value.childSessionId);
    const endedAt = value.endedAt;
    return childSessionId && typeof endedAt === "number" ? { childSessionId, endedAt } : null;
  } catch {
    return null;
  }
}

export function paginateEndedSubagents(
  ended: readonly ZCodeSessionEndedSubagent[],
  options: { cursor?: string; limit: number },
): { items: ZCodeSessionEndedSubagent[]; nextCursor?: string } {
  const cursor = decodeCursor(options.cursor);
  const start = cursor
    ? ended.findIndex(
        (item) =>
          (item.endedAt ?? 0) < cursor.endedAt ||
          ((item.endedAt ?? 0) === cursor.endedAt &&
            item.childSessionId.localeCompare(cursor.childSessionId) < 0),
      )
    : 0;
  if (start < 0) return { items: [] };
  const items = ended.slice(start, start + options.limit);
  const last = items.at(-1);
  return {
    items,
    ...(last && start + items.length < ended.length ? { nextCursor: encodeCursor(last) } : {}),
  };
}
