import { describe, expect, it, vi } from "vitest";
import type {
  ToolExecutionResult,
  TraceContext,
  UsageStorePort,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { recordToolUsageFromResult } from "../src/runtime/methods/turn-tool-usage.js";

describe("recordToolUsageFromResult", () => {
  it("把 Bash exit code 写入本地 Usage，并保证写失败不阻断主链路", async () => {
    const upsertToolUsage = vi
      .fn<UsageStorePort["upsertToolUsage"]>()
      .mockRejectedValue(new Error("database locked"));
    const warn = vi.fn();
    const runtime = {
      logger: { warn },
      registry: { get: () => undefined },
      sessionId: "session-tool-usage",
      sessionStore: {
        recordModelUsage: vi.fn(),
        upsertToolUsage,
        upsertTurnUsage: vi.fn(),
      },
    } as unknown as AgentRuntimeInternal;
    const result = {
      completedAt: new Date("2026-07-27T00:00:00.100Z"),
      durationMs: 100,
      output: { stdout: "" },
      performance: {
        detail: {
          kind: "command",
          command: {
            exitCode: 2,
            status: "failed",
          },
        },
      },
      startedAt: new Date("2026-07-27T00:00:00.000Z"),
      success: true,
      toolCallId: "tool-call-usage",
      toolName: "Bash",
    } as ToolExecutionResult;
    const traceContext = {
      spanId: "span-tool-usage",
      traceId: "trace-tool-usage",
      turnId: "turn-tool-usage",
    } as TraceContext;

    await expect(
      recordToolUsageFromResult(runtime, result, traceContext),
    ).resolves.toBeUndefined();
    expect(upsertToolUsage).toHaveBeenCalledWith(
      expect.objectContaining({ exitCode: 2 }),
    );
    expect(warn).toHaveBeenCalledWith(
      "Usage tool fact write failed",
      expect.objectContaining({ toolCallId: "tool-call-usage" }),
    );
  });

  it("非命令工具不伪造 exitCode", async () => {
    const upsertToolUsage = vi.fn<UsageStorePort["upsertToolUsage"]>().mockResolvedValue();
    const runtime = {
      registry: { get: () => undefined },
      sessionId: "session-read-usage",
      sessionStore: {
        recordModelUsage: vi.fn(),
        upsertToolUsage,
        upsertTurnUsage: vi.fn(),
      },
    } as unknown as AgentRuntimeInternal;
    const result = {
      completedAt: new Date("2026-07-27T00:00:00.010Z"),
      durationMs: 10,
      output: "content",
      performance: {
        detail: {
          kind: "filesystem",
          filesystem: {
            readMs: 8,
            totalBytes: 7,
          },
        },
      },
      startedAt: new Date("2026-07-27T00:00:00.000Z"),
      success: true,
      toolCallId: "tool-call-read",
      toolName: "Read",
    } as ToolExecutionResult;

    await recordToolUsageFromResult(
      runtime,
      result,
      {
        traceId: "trace-read",
        turnId: "turn-read",
      } as TraceContext,
    );

    expect(upsertToolUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        exitCode: undefined,
        toolName: "Read",
      }),
    );
  });
});
