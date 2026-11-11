import { describe, expect, it } from "vitest";
import type { MessageId, MessageWithParts, SessionInfo } from "@zcode/contracts";
import { projectActiveSessionMessages } from "./index.js";

const message = (id: string, role: "user" | "assistant"): MessageWithParts =>
  ({ info: { id, role, parentID: "p" }, parts: [] }) as unknown as MessageWithParts;

describe("active transcript contract", () => {
  it("drops the rewound branch kept in the ledger", () => {
    const messages = [message("a", "user"), message("b", "assistant"), message("c", "user")];
    const session = {
      revert: { targetMessageID: "b" as MessageId, createdMessageID: "c" as MessageId },
    } as unknown as SessionInfo;
    expect(
      projectActiveSessionMessages(messages, session, []).map((item) => item.info.id),
    ).toEqual(["a", "c"]);
  });
});
