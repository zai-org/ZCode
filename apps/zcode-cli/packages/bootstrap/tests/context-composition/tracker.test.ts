// 修订号 tracker（spec §4 第 4 类）：apps/zcode-cli/docs/design/v2/model/context-composition.md §3.4。
import { describe, expect, it } from "vitest";
import { V4_NOTIFICATIONS } from "@zcode/shared/zcode-protocol-v4";
import {
  ContextCompositionRevisionTracker,
  getContextCompositionTracker,
  subscribeSessionContextComposition,
} from "../../src/zcode-protocol/context-composition/index.js";

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("context composition revision tracker", () => {
  it("coalesces changes in one turn of the event loop into one revision and one notification", async () => {
    const emitted: Array<{ sessionId: string; revision: number }> = [];
    const tracker = new ContextCompositionRevisionTracker((event) => emitted.push(event));

    tracker.markChanged("a");
    tracker.markChanged("a");
    tracker.markChanged("b");
    // 修订号在第一次变更时就加一：同一轮里的查询读到的已是新值。
    expect(tracker.revision("a")).toBe(1);
    expect(emitted).toEqual([]);
    await flushMicrotasks();
    expect(emitted).toEqual([
      { sessionId: "a", revision: 1 },
      { sessionId: "b", revision: 1 },
    ]);

    tracker.markChanged("a");
    await flushMicrotasks();
    expect(emitted.at(-1)).toEqual({ sessionId: "a", revision: 2 });
    expect(tracker.revision("a")).toBe(2);
    expect(tracker.revision("never-changed")).toBe(0);
  });

  it("wires runtime changes to v4 notifications and stops after unsubscribe", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const context = {
      contextCompositionTracker: undefined,
      notify: (notification: { method: string; params?: unknown }) =>
        notifications.push({ method: notification.method, params: notification.params }),
    };
    const listeners = new Set<(change: { reason: string }) => void>();
    const runtime = {
      subscribeContextCompositionChanged: (listener: (change: { reason: string }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const unsubscribe = subscribeSessionContextComposition(
      context as never,
      "s1",
      runtime as never,
    );
    for (const listener of listeners) {
      listener({ reason: "request" });
      listener({ reason: "request_usage" });
    }
    await flushMicrotasks();
    expect(notifications).toEqual([
      {
        method: V4_NOTIFICATIONS.conversationContextCompositionChanged,
        params: { sessionId: "s1", revision: 1 },
      },
    ]);
    expect(getContextCompositionTracker(context as never).revision("s1")).toBe(1);

    unsubscribe();
    expect(listeners.size).toBe(0);
    // 测试桩 runtime 没有订阅方法时不接线，也不抛错。
    expect(() =>
      subscribeSessionContextComposition(context as never, "s2", {} as never)(),
    ).not.toThrow();
  });
});
