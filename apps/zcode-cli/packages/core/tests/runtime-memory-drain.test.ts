import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
afterEach(() => vi.useRealTimers());

describe("runtime Memory Extraction drain", () => {
  it("waits past the normal deadline when an explicit null disables the drain timeout", async () => {
    vi.useFakeTimers();
    const completion = Promise.withResolvers<void>();
    let finished = false;
    const draining = AgentRuntime.prototype.drainMemoryExtractions
      .call({ memoryExtractionScheduler: { drain: () => completion.promise } } as never, null)
      .then(() => {
        finished = true;
      });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(finished).toBe(false);
    completion.resolve();
    await draining;
    expect(finished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns immediately when there is no scheduled work", async () => {
    await expect(
      AgentRuntime.prototype.drainMemoryExtractions.call({} as never, null),
    ).resolves.toBeUndefined();
  });

  it.each([
    [{ enabled: true, cliStorageRoot: "/storage", use: true }, true],
    [{ enabled: false, cliStorageRoot: "/storage", use: true }, false],
    [{ enabled: true, cliStorageRoot: "/storage", use: false }, false],
  ] as const)("reports effective Memory enablement for preflight", (memory, expected) => {
    expect(
      AgentRuntime.prototype.isProjectMemoryEnabled.call({
        config: { memory },
        workspaceRoot: "/workspace",
      } as never),
    ).toBe(expected);
  });
});
