import { describe, expect, it } from "vitest";
import {
  createSessionId,
  createRootTraceContext,
  SessionEventType,
  type SessionEvent,
} from "@zcode/contracts";
import {
  conversationTopicFrameSchema,
  WIRE_FAULT_INVALID_PAYLOAD,
  isDeterministicContentFault,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

/**
 * 封闭规则 13（docs/v4-refactor/04-sync-and-recovery.md）：恢复阶梯的最后一级必须不可拒绝。
 *
 * 修复前：`rows.window` 是 `z.array(conversationRowSchema)`，一行读不懂则整帧被拒
 * （`proto.frameAssemblyInvalidPayload`）→ 确定性内容失败 → 直接强制 snapshot → 同一份内容再被拒
 * → `fault.subscription.contentRejected`，会话永久打不开（2026-09-21 sess_4142de31）。
 * 修复后：snapshot 的 B 区逐行降级，A 区与 deltas 仍严格。
 *
 * 这些用例是跨版本偏斜的**消费端**契约，所以写在 CLI 侧的保留测试套件里：schema 由
 * `@zcode/shared` 提供，CLI 与 App 两侧共用同一份。
 */
function baseSnapshot() {
  const sessionId = createSessionId("row-degradation");
  const trace = createRootTraceContext({ sessionId });
  const projection = new ProductProjection(sessionId, "epoch");
  projection.applyEvent({
    id: "degradation-permission-event",
    sessionId,
    traceId: trace.traceId,
    sequenceNumber: 1,
    timestamp: new Date(),
    type: SessionEventType.PermissionRequested,
    payload: {
      approvalMode: "user-once",
      fullAccessSupported: true,
      requestId: "degradation-request",
      toolCallId: "bash",
      toolName: "Bash",
      riskLevel: "high",
      reason: "Dangerous command",
      input: { command: "rm -rf fixture" },
    },
  } as SessionEvent);
  // 走一次 JSON 往返，得到和 wire 上完全一样的原始对象，再在上面制造偏斜。
  return JSON.parse(JSON.stringify(projection.getSnapshot())) as {
    rows: { window: Array<Record<string, unknown>>; totalCount: number; firstRowId: number | null };
  };
}

function frameWith(snapshot: unknown) {
  return {
    topic: "conversation/row-degradation",
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq: 1,
    sentAt: 0,
    payload: { kind: "snapshot", snapshot },
  };
}

/** 比本端新的发送端：一种本端没有的行类型。这是最可能的偏斜源。 */
const UNKNOWN_KIND_ROW = {
  rowId: 9001,
  turnId: "turn-future",
  createdAt: 1_700_000_000_000,
  createdAtSeq: 9001,
  kind: "holographicPreview",
  payload: { anything: true },
};

/** 已知行类型，但必填字段缺席（闭集枚举加值、字段改名都会落到这一档）。 */
const SKEWED_TOOL_CALL_ROW = {
  rowId: 9002,
  turnId: "turn-future",
  createdAt: 1_700_000_000_001,
  createdAtSeq: 9002,
  kind: "toolCall",
  toolCallId: "future-call",
  // toolName、status、inputText 全部缺席：没有卡可丢，修复前必然拒整帧。
};

describe("snapshot 的 B 区逐行降级（封闭规则 13）", () => {
  it("未知行类型只让那一行退化，整帧照常交付", () => {
    const snapshot = baseSnapshot();
    const knownRowCount = snapshot.rows.window.length;
    snapshot.rows.window.push(UNKNOWN_KIND_ROW);
    const parsed = conversationTopicFrameSchema.parse(frameWith(snapshot));
    if (parsed.payload.kind !== "snapshot") throw new Error("Expected a snapshot payload");
    const rows = parsed.payload.snapshot.rows.window;
    expect(rows).toHaveLength(knownRowCount + 1);
    // 身份与位置必须原样保留：降级改变的是能不能渲染，不是它是否存在、排在哪里。
    expect(rows.at(-1)).toEqual({
      kind: "unreadable",
      rowId: 9001,
      turnId: "turn-future",
      createdAt: 1_700_000_000_000,
      createdAtSeq: 9001,
      sourceKind: "holographicPreview",
    });
    // 占位行不携带任何无法确认的事实。
    expect(rows.at(-1)).not.toHaveProperty("payload");
  });

  it("已知行类型的必填字段偏斜同样只退化那一行", () => {
    const snapshot = baseSnapshot();
    snapshot.rows.window.push(SKEWED_TOOL_CALL_ROW);
    const parsed = conversationTopicFrameSchema.parse(frameWith(snapshot));
    if (parsed.payload.kind !== "snapshot") throw new Error("Expected a snapshot payload");
    const degraded = parsed.payload.snapshot.rows.window.at(-1);
    expect(degraded).toMatchObject({ kind: "unreadable", rowId: 9002 });
    // sourceKind 保留原自报类型，诊断时才分得清「未知类型」与「已知类型但字段偏斜」。
    expect(degraded).toHaveProperty("sourceKind", "toolCall");
  });

  it("合法行不受影响，计数与游标事实不变", () => {
    const clean = baseSnapshot();
    const skewed = baseSnapshot();
    skewed.rows.window.push(UNKNOWN_KIND_ROW);
    const parsedClean = conversationTopicFrameSchema.parse(frameWith(clean));
    const parsedSkewed = conversationTopicFrameSchema.parse(frameWith(skewed));
    if (parsedClean.payload.kind !== "snapshot" || parsedSkewed.payload.kind !== "snapshot")
      throw new Error("Expected snapshot payloads");
    // union 的顺序是语义的一部分：严格成员在前，合法行不能被当成占位行。
    expect(parsedSkewed.payload.snapshot.rows.window.slice(0, -1)).toEqual(
      parsedClean.payload.snapshot.rows.window,
    );
    expect(parsedSkewed.payload.snapshot.rows.totalCount).toBe(skewed.rows.totalCount);
    expect(parsedSkewed.payload.snapshot.rows.firstRowId).toBe(skewed.rows.firstRowId);
  });

  it("连 RowBase 的四个字段都读不懂时仍然拒帧", () => {
    const snapshot = baseSnapshot();
    // 没有 rowId 就无法确定身份与排序，降级会把「少一行」变成「错位的一屏」，必须 fail closed。
    snapshot.rows.window.push({ turnId: "turn-future", kind: "holographicPreview" });
    expect(() => conversationTopicFrameSchema.parse(frameWith(snapshot))).toThrow();
    expect(isDeterministicContentFault(WIRE_FAULT_INVALID_PAYLOAD)).toBe(true);
  });

  it("deltas 不走降级：丢一条行变更会让投影与权威发散", () => {
    expect(() =>
      conversationTopicFrameSchema.parse({
        topic: "conversation/row-degradation",
        subscriptionId: "sub-1",
        fromSeq: 0,
        toSeq: 1,
        sentAt: 0,
        payload: { kind: "deltas", deltas: [{ op: "row.appended", row: UNKNOWN_KIND_ROW }] },
      }),
    ).toThrow();
  });
});
