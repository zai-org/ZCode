import { randomUUID } from "node:crypto";
import {
  SessionControlError,
  type AppOperationRef,
  type AppSessionRef,
  type OperationFeed,
  type OperationSnapshot,
  type OperationUpdate,
} from "@zcode/session-control/contracts";
import {
  TopicWireFrameAssembler,
  conversationTopic,
  conversationTopicFrameSchema,
  type CommandAck,
  type CommandQueryTurn,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { zcodeProtocolErrorCodes, zcodeTurnStartedEventPayloadSchema } from "@zcode/shared";
import {
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
  type IZCodeAgentService,
} from "#src/zcode-agent/zcodeAgent.js";
import { withTrustedZCodeAgentV4Connection } from "#src/zcode-agent/zcodeAgentConnectionScope.js";

/** 只读已活跃 session；缺 runtime 是明确未知，不订阅/恢复历史。 */
export async function readAppLiveSummary(
  agent: IZCodeAgentService,
  session: AppSessionRef,
): Promise<
  { status: "unknown" | "idle" | "running" | "needs_attention"; executionId?: string } | undefined
> {
  const target = {
    workspacePath: session.workspacePath,
    workspaceIdentity: session.workspaceIdentity,
    sessionId: session.sessionId,
    runtimePolicy: "existing-only" as const,
  };
  try {
    const snapshot = await agent.readSession({
      ...target,
      messageLimit: 1,
      contentProfile: "index",
    });
    const turnId = snapshot.runtime.activeTurnId;
    const status =
      snapshot.projection.pendingPermissions.length > 0 ||
      snapshot.runtime.pendingRequestIds?.length > 0 ||
      snapshot.projection.status === "waiting"
        ? ("needs_attention" as const)
        : turnId || snapshot.projection.status === "running"
          ? ("running" as const)
          : snapshot.projection.status === "idle" || snapshot.projection.status === "completed"
            ? ("idle" as const)
            : ("unknown" as const);
    if (!turnId) return { status };
    // 旧事件接口只支持 tail limit，不能把 afterSeq 当成向前分页。逐级扩大有界窗口，
    // 长轮超过保留窗口时保持无 executionId，禁止把 turnId/lease runId 充当停止凭据。
    for (const limit of [200, 1_000, 5_000]) {
      const events = await agent.readSessionEvents({ ...target, limit });
      const started = events.findLast(
        (event) =>
          event.sessionId === session.sessionId &&
          event.turnId === turnId &&
          event.type === "turn.started",
      );
      const payload = started
        ? zcodeTurnStartedEventPayloadSchema.safeParse(started.payload)
        : undefined;
      if (payload?.success && payload.data.foregroundExecutionId)
        return { status, executionId: payload.data.foregroundExecutionId };
      if (events.length < limit) break;
    }
    return { status };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (
      code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE ||
      code === zcodeProtocolErrorCodes.sessionUnavailable
    )
      return undefined;
    throw error;
  }
}

export function operationSnapshotFromFacts(
  operation: AppOperationRef,
  snapshot: ConversationSnapshot,
  ack?: CommandAck | "unknown",
  ownerTurn?: CommandQueryTurn,
): OperationSnapshot<AppSessionRef> {
  const base = { operation, epoch: snapshot.logEpoch, revision: snapshot.seq };
  const row = snapshot.rows.window.find(
    (item) => item.kind === "turnHeader" && item.sourceCommandId === operation.commandId,
  );
  // Bug 根因：快照只有 60 行尾窗，长回合的 header 滚出窗口后，已结束的回合被判成 unknown，
  // 等审批的回合因为拿不到 turnId 被判成 running。尾窗里没有该行时，用 owner 在 commands/query
  // 回包里给出的回合状态；尾窗行可能更新，优先使用。
  const header = row?.kind === "turnHeader" ? { turnId: row.turnId, state: row.state } : ownerTurn;
  if (header && header.state !== "running") {
    return {
      ...base,
      status:
        header.state === "completedSuccess"
          ? "completed"
          : header.state === "completedInterrupted"
            ? "interrupted"
            : "failed",
    };
  }
  const work = snapshot.control.activeWorks.find(
    (item) => item.sourceCommandId === operation.commandId,
  );
  if (header || work) {
    const interaction = snapshot.pendingInteractions.find(
      (item) =>
        item.anchorRowId === null ||
        snapshot.rows.window.some(
          (candidate) =>
            candidate.rowId === item.anchorRowId && candidate.turnId === header?.turnId,
        ),
    );
    return {
      ...base,
      status: interaction ? "needs_attention" : "running",
      ...(work?.foregroundExecutionId ? { executionId: work.foregroundExecutionId } : {}),
      ...(interaction
        ? {
            attention: {
              kind:
                interaction.kind === "userInput" ? ("question" as const) : ("approval" as const),
            },
          }
        : {}),
    };
  }
  if (snapshot.queue.items.some((item) => item.sourceCommandId === operation.commandId))
    return { ...base, status: "queued" };
  // ACK 与 TurnStarted 之间由 owner 的当前 pending 事实承接；单独历史 ACK 不能证明仍待执行。
  if (snapshot.pendingCommands.some((item) => item.commandId === operation.commandId))
    return { ...base, status: "accepted" };
  if (ack && ack !== "unknown") {
    if (ack.status === "failed" || ack.status === "rejected" || ack.status === "stale")
      return { ...base, status: "failed", reason: ack.reasonCode };
    if (
      ack.result?.type === "inputAccepted" ||
      (ack.result?.type === "createSession" && ack.result.input)
    ) {
      const delivery =
        ack.result.type === "inputAccepted" ? ack.result.delivery : ack.result.input!.delivery;
      // ACK 只证明曾接纳。尾窗缺少关联事实可能已分页或重启，不能伪造仍在执行。
      return { ...base, status: "unknown", reason: `No current execution facts for ${delivery}` };
    }
  }
  return { ...base, status: "unknown" };
}

export interface AppConversationObservation {
  initial: ConversationSnapshot;
  /** 查询回包后以已摄入的最新水位建立 baseline，并只保留其后的 updates。 */
  takeCurrent(): { snapshot: ConversationSnapshot; invalidated?: string };
  updates: AsyncIterable<ConversationSnapshot | { invalidated: string }>;
  close(): Promise<void>;
}

/** 每个观察者使用独立 connectionId；先订阅 listener 再读 ACK，避免首帧夹在两者之间丢失。 */
export async function observeAppConversation(
  agent: IZCodeAgentService,
  operation: AppOperationRef,
  signal: AbortSignal,
  connectionId: string,
): Promise<AppConversationObservation> {
  const target = {
    workspacePath: operation.session.workspacePath,
    workspaceIdentity: operation.session.workspaceIdentity,
    sessionId: operation.session.sessionId,
  };
  const connection = {
    connectionId: `${connectionId}:observe:${randomUUID()}`,
    clientMode: "desktop-continuous" as const,
  };
  const topic = conversationTopic(target.sessionId);
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  let subscriptionId: string | undefined;
  let epoch: string | undefined;
  let snapshot: ConversationSnapshot | undefined;
  let closed = false;
  let invalidated: string | undefined;
  let pendingError: unknown;
  const buffered: ConversationTopicWireCandidate[] = [];
  let bufferedBytes = 0;
  const pending: Array<ConversationSnapshot | { invalidated: string }> = [];
  let pendingBytes = 0;
  const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
  const MAX_PENDING_STATES = 64;
  let wake: (() => void) | undefined;
  let resolveInitial!: (value: ConversationSnapshot) => void;
  let rejectInitial!: (reason: unknown) => void;
  const initial = new Promise<ConversationSnapshot>((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
  });
  void initial.catch(() => undefined);
  const push = (value: ConversationSnapshot | { invalidated: string }) => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (pending.length >= MAX_PENDING_STATES || pendingBytes + bytes > MAX_BUFFER_BYTES) {
      invalidate("Observation consumer buffer exceeded");
      return;
    }
    pending.push(value);
    pendingBytes += bytes;
    wake?.();
    wake = undefined;
  };
  const invalidate = (reason: string) => {
    if (invalidated || closed) return;
    invalidated = reason;
    pendingError = new SessionControlError("observation_invalid", reason);
    rejectInitial(pendingError);
    buffered.length = 0;
    bufferedBytes = 0;
    pending.length = 0;
    pendingBytes = 0;
    assembler.clear();
    push({ invalidated: reason });
  };
  const apply = (frame: ConversationTopicFrame) => {
    if (frame.payload.kind === "snapshot") {
      const next = frame.payload.snapshot;
      if (
        next.sessionId !== target.sessionId ||
        next.logEpoch !== epoch ||
        next.seq !== frame.toSeq
      )
        return invalidate("Observation identity changed");
      if (snapshot && next.seq <= snapshot.seq) return;
      snapshot = next;
      resolveInitial(next);
      push(next);
      return;
    }
    if (!snapshot || frame.fromSeq !== snapshot.seq || frame.toSeq <= frame.fromSeq)
      return invalidate("Observation sequence gap");
    let next = {
      ...snapshot,
      seq: frame.toSeq,
      rows: { ...snapshot.rows, window: [...snapshot.rows.window] },
    };
    for (const delta of frame.payload.deltas) {
      if (delta.op === "state.updated") next = { ...next, ...delta.patch };
      else if (delta.op === "row.appended" || delta.op === "row.upserted") {
        const index = next.rows.window.findIndex((row) => row.rowId === delta.row.rowId);
        if (index === -1) next.rows.window.push(delta.row);
        else next.rows.window[index] = delta.row;
      } else if (delta.op === "row.removed")
        next.rows.window = next.rows.window.filter((row) => row.rowId < delta.fromRowId);
      // 文本 delta 不参与 operation 状态判定，不保存另一份对话正文投影。
    }
    snapshot = next;
    push(next);
  };
  const accept = (wire: ConversationTopicWireCandidate) => {
    if (closed || invalidated || wire.topic !== topic) return;
    if (!subscriptionId) {
      const bytes = Buffer.byteLength(JSON.stringify(wire));
      if (buffered.length >= 1024 || bufferedBytes + bytes > MAX_BUFFER_BYTES)
        return invalidate("Observation buffer exceeded");
      bufferedBytes += bytes;
      buffered.push(wire);
      return;
    }
    if (wire.subscriptionId !== subscriptionId) return;
    for (const event of assembler.accept(wire)) {
      if (event.kind === "fault") invalidate(event.fault.reasonCode);
      else apply(event.frame);
    }
  };
  const frames = agent.onDynamicConversationFrame(target)(accept);
  const restarted = agent.onAgentRuntimeRestarted((event) => {
    if (event.workspaceKey === (target.workspaceIdentity?.trim() || target.workspacePath))
      invalidate("Owner restarted");
  });
  const lifecycle = agent.onAgentRuntimeLifecycle?.((event) => {
    if (
      event.workspaceKey === (target.workspaceIdentity?.trim() || target.workspacePath) &&
      event.state === "unavailable"
    )
      invalidate("Owner disconnected");
  });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    frames.dispose();
    restarted.dispose();
    lifecycle?.dispose();
    assembler.clear();
    buffered.length = 0;
    bufferedBytes = 0;
    pending.length = 0;
    pendingBytes = 0;
    signal.removeEventListener("abort", abort);
    wake?.();
    wake = undefined;
    closePromise = subscriptionId
      ? agent
          .unsubscribeConversationV4(
            withTrustedZCodeAgentV4Connection(
              { ...target, subscriptionId, runtimePolicy: "existing-only" as const },
              connection,
            ),
          )
          .catch((error: unknown) => {
            // owner 断连后 existing-only 取消会报 unavailable；本地监听与缓冲已释放，
            // 不能让该清理错误覆盖 wait 的 unknown 和已完成结果。其他清理失败仍须传播。
            const code = (error as { code?: unknown } | null)?.code;
            if (
              code !== ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE &&
              code !== zcodeProtocolErrorCodes.sessionUnavailable
            )
              throw error;
          })
      : Promise.resolve();
    return closePromise;
  };
  const abort = () => {
    pendingError = new SessionControlError("cancelled", "Observation cancelled");
    rejectInitial(pendingError);
    // ACK 尚未返回时不能遗忘 subscription；返回后 finally 会补释放。
    frames.dispose();
    restarted.dispose();
    lifecycle?.dispose();
    wake?.();
    wake = undefined;
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new SessionControlError("cancelled", "Observation cancelled");
    const result = await agent.subscribeConversationV4(
      withTrustedZCodeAgentV4Connection(
        { ...target, visibility: "background" as const },
        connection,
      ),
    );
    subscriptionId = result.ack.subscriptionId;
    epoch = result.ack.logEpoch;
    if (signal.aborted) throw new SessionControlError("cancelled", "Observation cancelled");
    if (pendingError) throw pendingError;
    const earlyFrames = buffered.splice(0);
    bufferedBytes = 0;
    for (const wire of earlyFrames) accept(wire);
    const first = await initial;
    // initial 本身不在 updates 重复发；保留首帧之后已经收到的全部水位。
    const index = pending.indexOf(first);
    if (index >= 0) pending.splice(0, index + 1);
    pendingBytes = pending.reduce(
      (bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)),
      0,
    );
    return {
      initial: first,
      takeCurrent() {
        // query 往返期间可能已经摄入 TurnStarted/终态。同步取当前水位并清掉旧缓冲，
        // 防止 core 先看到旧 unknown 提前结束；没有等待新事件或按时间猜测。
        const current = snapshot ?? first;
        pending.length = 0;
        pendingBytes = 0;
        return { snapshot: current, ...(invalidated ? { invalidated } : {}) };
      },
      updates: {
        async *[Symbol.asyncIterator]() {
          while (!closed && !signal.aborted) {
            const value = pending.shift();
            if (value) {
              pendingBytes -= Buffer.byteLength(JSON.stringify(value));
              yield value;
              if ("invalidated" in value) return;
            } else
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
        },
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function observeAppOperation(
  agent: IZCodeAgentService,
  operation: AppOperationRef,
  signal: AbortSignal,
  connectionId: string,
): Promise<OperationFeed<AppSessionRef>> {
  const feed = await observeAppConversation(agent, operation, signal, connectionId);
  try {
    const query = await agent.queryConversationCommandsV4(
      withTrustedZCodeAgentV4Connection(
        {
          workspacePath: operation.session.workspacePath,
          workspaceIdentity: operation.session.workspaceIdentity,
          commands: [
            { sessionId: operation.session.sessionId, commandId: operation.commandId },
            { sessionId: null, commandId: operation.commandId },
          ],
        },
        { connectionId, clientMode: "desktop-continuous" },
      ),
    );
    const sessionItem = query.results.find(
      (item) =>
        item.key.sessionId === operation.session.sessionId &&
        item.key.commandId === operation.commandId,
    );
    const sessionResult = sessionItem?.result;
    const ownerTurn = sessionItem?.turn;
    const globalResult = query.results.find(
      (item) => item.key.sessionId === null && item.key.commandId === operation.commandId,
    )?.result;
    // create ACK 属于 global bucket，只能凭 ACK 内的精确 child 身份关联，不能串到同名命令。
    const ack =
      sessionResult && sessionResult !== "unknown"
        ? sessionResult
        : globalResult &&
            globalResult !== "unknown" &&
            globalResult.result?.type === "createSession" &&
            globalResult.result.sessionId === operation.session.sessionId
          ? globalResult
          : undefined;
    const baseline = feed.takeCurrent();
    const initial = operationSnapshotFromFacts(operation, baseline.snapshot, ack, ownerTurn);
    return {
      initial: baseline.invalidated
        ? { ...initial, status: "unknown", reason: baseline.invalidated }
        : initial,
      updates: {
        async *[Symbol.asyncIterator](): AsyncGenerator<OperationUpdate<AppSessionRef>> {
          for await (const next of feed.updates) {
            yield "invalidated" in next
              ? { type: "invalidated", operation, reason: next.invalidated }
              : {
                  type: "snapshot",
                  snapshot: operationSnapshotFromFacts(operation, next, ack, ownerTurn),
                };
          }
        },
      },
      close: feed.close,
    };
  } catch (error) {
    await feed.close();
    throw error;
  }
}
