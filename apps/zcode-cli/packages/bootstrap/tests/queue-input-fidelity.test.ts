import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  type SessionEvent,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import { queueItemSchema } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";
import { inputIntentMetadataFromQueueItem } from "../src/zcode-protocol-v4/commands/input-intent.js";

const intent: TurnInputIntentMetadata = {
  sourceCommandId: "source-command",
  queueItemId: "queued-input",
  clientId: "desktop-client",
  kind: "sendText",
  text: "继续执行",
  modelSelection: { providerId: "provider", modelId: "model", options: { reasoningLevel: "high" } },
  mode: "yolo",
  planEnabled: false,
  admissionSeq: 1,
  admittedAt: 1234,
  requestedDelivery: "queue",
  admittedDelivery: "queue",
  queuePosition: 0,
  attachmentRefs: [{ ref: "artifact://note", fileName: "note.txt", mime: "text/plain", bytes: 3 }],
  sharedContextRefs: [{ kind: "shared_context_import", context_id: "shared-context" }],
  genUiContext: [{ path: "/project/example.html", state: { stage: "entry" } }],
  source: { kind: "session", sessionId: "source-session", title: "来源会话" },
  provenance: {
    sourceCommandId: "original-command",
    queueItemId: "original-queue",
    clientId: "mobile-client",
  },
};

function queuedEvent(sequence: number, metadata?: TurnInputIntentMetadata): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session",
    turnId: "turn",
    type: SessionEventType.TurnSteerQueued,
    timestamp: new Date(1234 + sequence),
    traceId: "trace",
    sequenceNumber: sequence,
    payload: {
      pendingInputId: "queued-input",
      input: sequence === 1 ? intent.text : "修改正文",
      queueLength: 1,
      delivery: "queue",
      ...(metadata ? { intent: metadata } : {}),
    },
  } as SessionEvent;
}

describe("Todo151 Queue 提交事实往返", () => {
  it("旧尾块在 CLI 队列入口解码，模型快照和干净正文一起提升", () => {
    const projection = new ProductProjection("session", "epoch");
    const event = queuedEvent(1);
    const text = `继续执行\n\n<untrusted_gen_ui_state>\n${JSON.stringify(intent.genUiContext)}\n</untrusted_gen_ui_state>`;
    projection.applyEvent({ ...event, payload: { ...event.payload, input: text } } as SessionEvent);
    const item = queueItemSchema.parse(projection.getSnapshot().queue.items[0]);
    expect(item.text).toBe("继续执行");
    expect(inputIntentMetadataFromQueueItem(item, item.text).genUiContext).toEqual(
      intent.genUiContext,
    );
  });
  it.each(["queue", "guide"] as const)(
    "%s 投递经真实事件投影再提升不丢字段",
    (requestedDelivery) => {
      const projection = new ProductProjection("session", "epoch");
      const submitted = {
        ...intent,
        requestedDelivery,
        ...(requestedDelivery === "guide"
          ? { fallbackReasonCode: "guide.attachmentsUnsupported" }
          : {}),
      };
      projection.applyEvent(queuedEvent(1, submitted));
      const item = queueItemSchema.parse(projection.getSnapshot().queue.items[0]);
      expect(inputIntentMetadataFromQueueItem(item, item.text)).toEqual(submitted);
    },
  );

  it("只带正文的旧编辑事件保留同项原选择、上下文和来源", () => {
    const projection = new ProductProjection("session", "epoch");
    projection.applyEvent(queuedEvent(1, intent));
    projection.applyEvent(queuedEvent(2));
    const item = projection.getSnapshot().queue.items[0]!;
    expect(inputIntentMetadataFromQueueItem(item, item.text)).toEqual({
      ...intent,
      text: "修改正文",
    });
  });
});
