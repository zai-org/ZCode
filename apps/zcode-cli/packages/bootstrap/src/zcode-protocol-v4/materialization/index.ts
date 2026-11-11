// 无状态的 conversation 投影视图与候选重放；状态仍由 publisher/ProductProjection 持有。
import { Buffer } from "node:buffer";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type {
  CommandEnvelope,
  ConversationDelta,
  ConversationSnapshot,
  ConversationTopicFrame,
  DeliveryProfile,
  DeliveryProfileName,
  QueueItem,
  ToolCallRow,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  filterConversationRowsForProfile,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjection } from "../product-projection.js";
import { workflowRunDeltaGrowthUpperBound } from "../conversation-workflow-run-deltas.js";
import type {
  CandidateHydrationInput,
  CandidateHydrationResult,
  ConversationInputAdmission,
  ConversationWireIdentity,
} from "./contract.js";
export class ProjectionPayloadTooLargeError extends Error {
  readonly reasonCode = "proto.payloadTooLarge";

  constructor(readonly logicalBytes: number) {
    super(
      `conversation projection exceeds ${PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes} bytes`,
    );
    this.name = "ProjectionPayloadTooLargeError";
  }
}

// 运行中正文必须给 TurnError/TurnComplete 的 bounded terminal patch 留出空间；否则正文
// 恰好占满 16MiB 后，停止 turn 的终态本身也无法进入可传输 snapshot。
export const PROJECTION_TERMINAL_RESERVE_BYTES = 64 * 1024;

const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

/**
 * cold replay 会高频测量临时 delta；TextEncoder 会为每次测量再分配完整 Uint8Array。
 * CLI 已固定运行在 Node，这里对同一 JSON 文本直接计算精确 UTF-8 字节数，不做近似估算。
 */
export function coldHydrationJsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPlanMarkdown(row: ToolCallRow): boolean {
  if (isRecord(row.input)) {
    const plan = row.input.plan;
    if (typeof plan === "string" && plan.trim().length > 0) return true;
  }
  if (!row.inputText.trim()) return false;
  try {
    const parsed: unknown = JSON.parse(row.inputText);
    return isRecord(parsed) && typeof parsed.plan === "string" && parsed.plan.trim().length > 0;
  } catch {
    return false;
  }
}

// row.actions 的 schema 只有 4 个 true 布尔值和一个短枚举；含 JSON key/父级包装不足
// 128 bytes。批量 checkpoint 之间按 wire tail 的每行完整预留，保证延迟 materialize
// 不会让 payload 上界低估。
const HYDRATION_ACTION_BYTES_PER_WIRE_ROW = 128;
const HYDRATION_EVENT_WIRE_OVERHEAD_BYTES = 64;
// logical snapshot frame 中 sequence number 同时出现在 frame.toSeq 与 snapshot.seq。
const HYDRATION_SEQUENCE_NUMBER_OCCURRENCES = 2;

function hydrationSequenceNumberBytes(sequenceNumber: number): number {
  return String(sequenceNumber).length * HYDRATION_SEQUENCE_NUMBER_OCCURRENCES;
}

export function conversationWireSnapshot(
  snapshot: ConversationSnapshot,
  profile: DeliveryProfile = DELIVERY_PROFILES.continuous,
): ConversationSnapshot {
  const visibleRows = filterConversationRowsForProfile(snapshot.rows.window, profile);
  const visibleSnapshot: ConversationSnapshot = {
    ...snapshot,
    rows: {
      ...snapshot.rows,
      window: visibleRows,
      totalCount: visibleRows.length,
      firstRowId: visibleRows[0]?.rowId ?? null,
    },
  };
  const limit = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
  if (visibleRows.length <= limit) return visibleSnapshot;
  return {
    ...visibleSnapshot,
    rows: { ...visibleSnapshot.rows, window: visibleRows.slice(-limit) },
  };
}

export function measureInputAdmissionBytes(
  snapshot: ConversationSnapshot,
  envelope: CommandEnvelope,
  admission: ConversationInputAdmission,
  measureWireSnapshot: (snapshot: ConversationSnapshot) => number,
): number | null {
  const raw = envelope.payload as {
    text?: string;
    displayText?: string;
    attachments?: QueueItem["attachments"];
    firstInput?: { text: string; attachments?: QueueItem["attachments"] };
  };
  const input = envelope.type === "createSession" ? raw.firstInput : raw;
  if (
    !input ||
    (envelope.type !== "createSession" &&
      envelope.type !== "sendText" &&
      envelope.type !== "sendGoalCommand" &&
      envelope.type !== "compact")
  ) {
    return null;
  }
  const queueItem: QueueItem = {
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind:
      envelope.type === "compact"
        ? "compact"
        : envelope.type === "sendGoalCommand"
          ? "sendGoalCommand"
          : "sendText",
    text:
      envelope.type === "compact"
        ? "/compact"
        : envelope.type === "sendGoalCommand"
          ? raw.displayText?.trim() || `/goal ${(input.text ?? "").trim()}`
          : (input.text ?? ""),
    attachments: input.attachments ?? [],
    delivery: { requested: "queue", admitted: "queue" },
    order: {
      admissionSeq: admission.admissionSeq,
      queuePosition: snapshot.queue.items.length,
    },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt: admission.admittedAt,
  };
  const candidate: ConversationSnapshot = {
    ...snapshot,
    queue: { ...snapshot.queue, items: [...snapshot.queue.items, queueItem] },
  };
  return measureWireSnapshot(conversationWireSnapshot(candidate));
}

export function measureConversationSnapshotBytes(
  snapshot: ConversationSnapshot,
  identity: ConversationWireIdentity,
): number {
  // subscriptionId/时间/seq 使用本 publisher 可产生的最长常规表示，确保测量不是只算 payload。
  const frame: ConversationTopicFrame = {
    topic: identity.topic,
    subscriptionId: `sub-${identity.logEpoch}-${Number.MAX_SAFE_INTEGER}`,
    fromSeq: 0,
    toSeq: snapshot.seq,
    sentAt: Number.MAX_SAFE_INTEGER,
    payload: { kind: "snapshot", snapshot },
  };
  return utf8JsonByteLength(frame);
}

export function conversationRowsRange(
  snapshot: ConversationSnapshot,
  params: { beforeRowId?: number; limit: number },
  deliveryProfile: DeliveryProfileName = "replayable",
): V4ConversationRowsRangeResult {
  const limit = Math.max(1, Math.min(params.limit, PROTOCOL_V4_LIMITS.rowsRangeMaxLimit));
  const visibleRows = filterConversationRowsForProfile(
    snapshot.rows.window,
    DELIVERY_PROFILES[deliveryProfile],
  );
  const eligible =
    params.beforeRowId === undefined
      ? visibleRows
      : visibleRows.filter((row) => row.rowId < (params.beforeRowId as number));
  const rows = eligible.slice(-limit);
  return {
    rows,
    atSeq: snapshot.seq,
    atRevision: snapshot.revision,
    atLogEpoch: snapshot.logEpoch,
    hasMore: eligible.length > rows.length,
  };
}

/**
 * 返回当前有效分支里的完整终态计划目录。
 * wire snapshot 只保留 tail window；renderer 扫描可见 rows 会漏掉早期计划，
 * edit/retry 后还可能保留已经被权威 projection 裁掉的旧目录项。
 */
export function conversationPlans(snapshot: ConversationSnapshot): V4ConversationPlansResult {
  const plans = snapshot.rows.window
    .filter(
      (row): row is ToolCallRow =>
        row.kind === "toolCall" &&
        row.toolName === "ExitPlanMode" &&
        TERMINAL_PLAN_STATUSES.has(row.status) &&
        hasPlanMarkdown(row),
    )
    .toSorted((left, right) => right.rowId - left.rowId);
  return {
    plans,
    atSeq: snapshot.seq,
    atLogEpoch: snapshot.logEpoch,
  };
}

export function applyConversationEvent(
  projection: ProductProjection,
  event: SessionEvent,
  bytesUpperBound: number,
  measureWireSnapshot: (snapshot: ConversationSnapshot) => number,
): { deltas: ConversationDelta[]; bytesUpperBound: number } {
  const projectionLimit =
    event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
      ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
      : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
  const streamingAppend = projection.establishedStreamingAppend(event);
  const streamingUpperBound =
    streamingAppend === null ? null : utf8JsonByteLength(streamingAppend) + 64;
  let deltas: ConversationDelta[] | null;
  if (streamingUpperBound !== null && bytesUpperBound + streamingUpperBound <= projectionLimit) {
    deltas = projection.applyEvent(event);
    bytesUpperBound += streamingUpperBound;
  } else {
    let candidateBytes = 0;
    let nextUpperBound = 0;
    deltas = projection.applyEventAtomically(event, (snapshot, produced) => {
      // dwf 快路径：这条事件只产键级增量时，它们的字节数就是快照增长的上界（一条 upsert
      // 最多把自己那点内容加进去，removed 只会让快照变小），不必把整份快照再序列化一遍
      // ——那一次 JSON.stringify 是每条引擎事件都要付的 MB 级开销，也是这次改造的另一半。
      // 判据用的是**实际产出**而不是预演，所以 diff 退化出的整键 patch 自然落回精确路径。
      const growth = workflowRunDeltaGrowthUpperBound(produced);
      if (growth !== null && bytesUpperBound + growth <= projectionLimit) {
        nextUpperBound = bytesUpperBound + growth;
        return true;
      }
      candidateBytes = measureWireSnapshot(conversationWireSnapshot(snapshot));
      nextUpperBound = candidateBytes;
      return candidateBytes <= projectionLimit;
    });
    if (deltas === null) throw new ProjectionPayloadTooLargeError(candidateBytes);
    bytesUpperBound = nextUpperBound;
  }
  return { deltas, bytesUpperBound };
}

export function hydrateConversationCandidate({
  projection,
  events,
  initialBytesUpperBound,
  measureWireSnapshot,
}: CandidateHydrationInput): CandidateHydrationResult {
  projection.beginHydrationReplay();
  let measuredBytes = initialBytesUpperBound;
  let measuredSequenceNumberBytes = hydrationSequenceNumberBytes(projection.getSnapshot().seq);
  let encodedGrowthSinceMeasurement = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const deltas = projection.applyHydrationEvent(event);
    const finalEvent = index === events.length - 1;
    const projectionLimit = projectionLimitForEvent(event);
    const mustMeasureSnapshot = finalEvent || deltas.some((delta) => delta.op === "row.removed");

    if (finalEvent) projection.completeHydrationReplay();
    const snapshot = projection.getSnapshot();
    if (!mustMeasureSnapshot && deltas.length > 0) {
      let wireRowIds: Set<number> | undefined;
      const wireDeltas = deltas.filter((delta) => {
        if (delta.op === "state.updated" || delta.op === "row.appended") return true;
        if (delta.op === "row.removed") return false;
        // 4b-2：插件资源通知只走实时增量，不进冷启动测量。
        if (
          delta.op === "pluginUi.resourceUpdated" ||
          delta.op === "pluginUi.resourceListChanged" ||
          delta.op === "pluginUi.appToolCall" ||
          delta.op === "pluginUi.instanceClosed"
        )
          return false;
        // 键级增量作用在状态键上，不在 60 行 wire tail 里——没有「已滑出窗口所以不计」这一说，
        // 与 state.updated 同规一律计入。
        if (delta.op === "workflowRun.updated" || delta.op === "workflowRun.removed") return true;
        wireRowIds ??= new Set(
          snapshot.rows.window
            .slice(-PROTOCOL_V4_LIMITS.snapshotTailWindowRows)
            .map((row) => row.rowId),
        );
        const rowId = delta.op === "row.upserted" ? delta.row.rowId : delta.rowId;
        return wireRowIds.has(rowId);
      });
      if (wireDeltas.length > 0) {
        encodedGrowthSinceMeasurement +=
          coldHydrationJsonByteLength({ kind: "deltas", deltas: wireDeltas }) +
          HYDRATION_EVENT_WIRE_OVERHEAD_BYTES;
      }
    }

    const actionBytesUpperBound = finalEvent
      ? 0
      : Math.min(snapshot.rows.window.length, PROTOCOL_V4_LIMITS.snapshotTailWindowRows) *
        HYDRATION_ACTION_BYTES_PER_WIRE_ROW;
    const currentSequenceNumberBytes = hydrationSequenceNumberBytes(snapshot.seq);
    const sequenceNumberGrowth = Math.max(
      0,
      currentSequenceNumberBytes - measuredSequenceNumberBytes,
    );
    let upperBound =
      measuredBytes + encodedGrowthSinceMeasurement + sequenceNumberGrowth + actionBytesUpperBound;
    if (mustMeasureSnapshot || upperBound > projectionLimit) {
      // 保守 delta 累计值一旦超限就直接回退 strict 的话，重复 upsert
      // 即使未增大 snapshot 也会误回退；固定 32-event 重测还会反复序列化 checkpoint。
      measuredBytes = measureWireSnapshot(conversationWireSnapshot(projection.getSnapshot()));
      measuredSequenceNumberBytes = currentSequenceNumberBytes;
      encodedGrowthSinceMeasurement = 0;
      upperBound = measuredBytes + actionBytesUpperBound;
    }
    if (upperBound > projectionLimit) return null;
  }

  if (events.length === 0) {
    projection.completeHydrationReplay();
    measuredBytes = measureWireSnapshot(conversationWireSnapshot(projection.getSnapshot()));
  }
  return measuredBytes;
}

function projectionLimitForEvent(event: SessionEvent): number {
  return event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
    ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
    : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
}
