import { describe, expect, it } from "vitest";
import type { ToolExecutionResult } from "../src/runtime/deps.js";
import { completedToolPartMetadata } from "../src/runtime/methods/tool-part-metadata.js";

// 工具正常返回、但结果是错误结果时，completed part 写 providerIsError，冷恢复据此还原 is_error
// （session-persistence.md「Completed tool metadata」）。判定与 live tool_result 的 is_error 相同。
function result(toolName: string, output: unknown): ToolExecutionResult {
  return {
    toolCallId: `call_${toolName}`,
    toolName,
    success: true,
    output,
    startedAt: new Date(0),
    completedAt: new Date(1),
  } as ToolExecutionResult;
}

describe("completed tool part metadata", () => {
  it.each([
    ["a failed Bash command", "Bash", { status: "failed", exitCode: 3, interrupted: false }],
    ["a Bash hard timeout", "Bash", { status: "timed_out", exitCode: 143, interrupted: false }],
    [
      "an interrupted Bash command",
      "Bash",
      { status: "completed", exitCode: 0, interrupted: true },
    ],
    ["an MCP result with isError", "mcp__demo__lookup", { isError: true, content: [] }],
  ])("marks %s as a provider error", (_name, toolName, output) => {
    expect(completedToolPartMetadata(result(toolName, output)).providerIsError).toBe(true);
  });

  it.each([
    ["a successful Bash command", "Bash", { status: "completed", exitCode: 0, interrupted: false }],
    [
      "grep without matches",
      "Bash",
      {
        status: "failed",
        exitCode: 1,
        interrupted: false,
        returnCodeInterpretation: "No matches found",
      },
    ],
    ["an MCP result without isError", "mcp__demo__lookup", { content: [] }],
    ["a plain text result", "Read", "1\tline"],
  ])("does not mark %s", (_name, toolName, output) => {
    expect(completedToolPartMetadata(result(toolName, output))).not.toHaveProperty(
      "providerIsError",
    );
  });
});
