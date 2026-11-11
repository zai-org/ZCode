import { describe, expect, it } from "vitest";
import { resolveModelApiCallObservation } from "../src/telemetry/index.js";

describe("model API operation registry", () => {
  it.each([
    ["main_turn", "agent_step", "main"],
    ["subagent", "agent_step", "subagent"],
    ["workflow_child", "agent_step", "workflow_child"],
    ["compact", "context_compaction", "system"],
    ["session_title", "session_title_generation", "system"],
    ["goal_summary_title", "goal_title_generation", "system"],
    ["target_completion_verification", "goal_completion_verification", "system"],
    ["git_commit_message", "workspace_git_commit_message", "system"],
    ["web_search_tool", "web_search", "tool"],
    ["web_fetch_processing", "web_fetch_processing", "tool"],
    ["project_memory_extract", "project_memory_extract", "system"],
    ["project_memory_dream", "project_memory_dream", "system"],
    ["project_memory_recall", "project_memory_recall", "system"],
    ["future_source", "tool_internal_model_call", "system"],
  ] as const)("maps %s to a bounded operation/actor", (querySource, operation, actorKind) => {
    expect(resolveModelApiCallObservation(querySource, undefined)).toMatchObject({
      actorKind,
      logicalCallId: expect.any(String),
      operation,
    });
  });

  it("lets an explicit operation phase override the legacy query source", () => {
    expect(
      resolveModelApiCallObservation("web_fetch_processing", {
        actorKind: "tool",
        operation: "web_search",
      }),
    ).toMatchObject({
      actorKind: "tool",
      operation: "web_search",
    });
  });
});
