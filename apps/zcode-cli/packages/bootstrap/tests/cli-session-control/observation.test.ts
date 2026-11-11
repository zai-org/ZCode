import { describe, expect, it } from "vitest";
import { CliOperationObservations } from "../../src/cli-session-control/observation.js";

const operation = {
  session: { kind: "cli" as const, workspacePath: "/workspace", sessionId: "session" },
  commandId: "command",
};

describe("CLI operation feed", () => {
  it("cannot query another session by a known command id", () => {
    const observations = new CliOperationObservations("owner");
    const input = observations.register(operation);
    observations.update(input, "completed");
    expect(
      observations.open(
        { ...operation, session: { ...operation.session, sessionId: "other" } },
        new AbortController().signal,
      ).initial.status,
    ).toBe("unknown");
  });

  it("retains the event between open and iteration and closes pending next", async () => {
    const observations = new CliOperationObservations("owner");
    const input = observations.register(operation);
    const feed = observations.open(operation, new AbortController().signal);
    observations.update(input, "completed");
    const iterator = feed.updates[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: "snapshot",
      snapshot: { status: "completed", revision: 1 },
    });
    const pending = iterator.next();
    await feed.close();
    await feed.close();
    expect(await pending).toMatchObject({ done: true });
    expect(input.listeners.size).toBe(0);
  });

  it("invalidates a slow observer instead of accumulating an unbounded buffer", async () => {
    const observations = new CliOperationObservations("owner");
    const input = observations.register(operation);
    const feed = observations.open(operation, new AbortController().signal);
    for (let index = 0; index < 100; index++)
      observations.update(input, index % 2 ? "running" : "needs_attention");
    const iterator = feed.updates[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "invalidated" });
    expect(await iterator.next()).toMatchObject({ done: true });
    await feed.close();
  });
});
