import { describe, expect, it } from "vitest";
import type { SessionStorePort } from "@zcode/contracts";
import { composeCliSessionControl } from "./contract.example.js";

describe("independent CLI runtime contract", () => {
  it("exposes the core operations but refuses caller identity before trusted attachment", async () => {
    const workspace = { kind: "cli" as const, workspacePath: "/workspace" };
    const runtime = composeCliSessionControl({
      workspace,
      sessionStore: {} as SessionStorePort,
      createRootApp: async () => {
        throw new Error("Unexpected allocation");
      },
    });
    expect(Object.keys(runtime.control).sort()).toEqual([
      "createSession",
      "forkSession",
      "interruptSession",
      "listSessions",
      "readSession",
      "renameSession",
      "sendToSession",
      "waitSessions",
    ]);
    await expect(
      runtime.control.listSessions(
        {
          callerId: "unbound",
          rootSession: { ...workspace, sessionId: "unknown" },
          allowedScopes: [workspace],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    await runtime.close();
    await runtime.close();
  });
});
