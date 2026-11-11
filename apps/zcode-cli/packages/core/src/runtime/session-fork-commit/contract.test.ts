import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { prepareForkIdentityExample } from "./contract.example.js";

describe("session fork commit contract", () => {
  it("preallocates child-local notice identity without mutating the parent", () => {
    const parentSessionId = createSessionId();
    const childSessionId = createSessionId();
    const identities = prepareForkIdentityExample({
      parentSessionId,
      childSessionId,
      entries: [],
      goalSnapshots: [],
      messages: [],
    });
    expect(identities.parentSessionId).toBe(parentSessionId);
    expect(identities.childSessionId).toBe(childSessionId);
    expect(identities.notice.hiddenMessageId).not.toBe(identities.notice.messageId);
    expect(identities.notice.productTurnId).toBe(String(identities.notice.hiddenMessageId));
    expect(identities.messageIds.size).toBe(0);
  });
});
