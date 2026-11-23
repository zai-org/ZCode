import { describe, expect, it, vi } from "vitest";
import {
  completeExternalQueueDrain,
  drainPendingInput,
  hasInlineGuidePendingInput,
} from "../src/runtime/methods/steering.js";

describe("guide 行内 drain 的外层 FIFO 门", () => {
  it("外层普通队列恢复期间阻止 guide 越过旧项，消费到空后恢复 tool-batch drain", () => {
    const activeTurn = {
      pendingInputs: [{ id: "new-running-input", commandKind: undefined, delivery: "guide" }],
    };
    const runtime = {
      activeTurn,
      pendingInputReservations: new Map<string, string>(),
      queueExternalDrainActive: true,
    };

    expect(hasInlineGuidePendingInput.call(runtime as never, activeTurn as never)).toBe(false);
    completeExternalQueueDrain.call(runtime as never);
    expect(hasInlineGuidePendingInput.call(runtime as never, activeTurn as never)).toBe(true);
  });

  it("普通 future queue 在前时仍允许后续 guide 走当前轮", () => {
    const activeTurn = {
      pendingInputs: [
        { id: "future-queue", commandKind: undefined, delivery: "queue" },
        { id: "current-guide", commandKind: undefined, delivery: "guide" },
      ],
    };
    const runtime = {
      activeTurn,
      pendingInputReservations: new Map<string, string>(),
      queueExternalDrainActive: false,
    };

    expect(hasInlineGuidePendingInput.call(runtime as never, activeTurn as never)).toBe(true);
  });

  it("行内 drain 只取最早 guide，并把普通 future queue 留在原位", async () => {
    const futureQueue = {
      id: "future-queue",
      input: "future work",
      queuedAt: new Date(0),
      delivery: "queue",
    };
    const currentGuide = {
      id: "current-guide",
      input: "guide current work",
      queuedAt: new Date(0),
      delivery: "guide",
      intent: {
        genUiContext: [{ path: "/project/example.html", state: { stage: "guide" } }],
      },
    };
    const activeTurn = {
      pendingInputs: [futureQueue, currentGuide],
      turnId: "turn-current",
    };
    const appendedEvents: Array<{ payload: { pendingInputIds?: string[] } }> = [];
    const runtime = {
      activeTurn,
      appendEvent: vi.fn(async (event) => appendedEvents.push(event)),
      createEvent: vi.fn((_type, payload) => ({ payload })),
      messageHistory: { addEntries: vi.fn() },
      now: () => new Date(0),
      pendingInputReservations: new Map<string, string>(),
      persistUserPrompt: vi.fn(async () => undefined),
      sessionId: "session-current",
      workingDirectory: "/workspace",
    };

    await drainPendingInput.call(runtime as never, {
      activeTurn: activeTurn as never,
      events: [],
      traceContext: { traceId: "trace-current" } as never,
    });

    expect(activeTurn.pendingInputs).toEqual([futureQueue]);
    expect(runtime.messageHistory.addEntries).toHaveBeenCalledOnce();
    expect(JSON.stringify(runtime.messageHistory.addEntries.mock.calls[0])).toContain(
      "guide current work",
    );
    expect(JSON.stringify(runtime.messageHistory.addEntries.mock.calls[0])).not.toContain(
      "future work",
    );
    // 页面状态挂在 guide 自己的 entry 上，不写单独的状态条目。
    expect(runtime.messageHistory.addEntries.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        message: { role: "user", content: "guide current work" },
        metadata: expect.objectContaining({
          genUiState: expect.stringContaining(
            '[{"path":"/project/example.html","state":{"stage":"guide"}}]',
          ),
        }),
      }),
    ]);
    expect(appendedEvents).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ pendingInputIds: ["current-guide"] }),
      }),
    ]);
  });
});
