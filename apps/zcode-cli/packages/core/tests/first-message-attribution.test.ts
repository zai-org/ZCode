import { describe, expect, it } from "vitest";
import type { SessionId, SessionStorePort } from "@zcode/contracts";
import { readFirstMessageAttribution } from "../src/runtime/methods/input-intent-persistence.js";

describe("持久接纳首条身份", () => {
  const store = {
    getSessionInputById: async (id: string) =>
      [
        { id: "later", sessionID: "s", admittedSequence: 4, status: "admitted" },
        { id: "first", sessionID: "s", admittedSequence: 0, status: "cancelled" },
      ].find((input) => input.id === id) ?? null,
  } as unknown as SessionStorePort;
  it("按持久接纳顺序而非执行顺序，取消首条不提升后续输入", async () => {
    expect(await readFirstMessageAttribution(store, "s" as SessionId, "first", 0)).toBe(true);
    expect(await readFirstMessageAttribution(store, "s" as SessionId, "later", 0)).toBe(false);
  });
  it("重开后读同一账本；旧历史缺少接纳记录不猜首条", async () => {
    expect(await readFirstMessageAttribution(store, "s" as SessionId, "later", 12)).toBe(false);
    expect(await readFirstMessageAttribution(store, "s" as SessionId, "first", 12)).toBeUndefined();
    expect(await readFirstMessageAttribution(store, "s" as SessionId, "legacy", 0)).toBeUndefined();
    expect(
      await readFirstMessageAttribution(undefined, "s" as SessionId, "first", 0),
    ).toBeUndefined();
  });
});
