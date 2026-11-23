import { describe, expect, it } from "vitest";

import { CompactTrigger, type CompactBoundaryPayload } from "../src/compact/index.js";
import type { CompactContextItem } from "../src/compact/index.js";
import type { MessageId, TraceId } from "../src/interfaces/shared.js";
import {
  RewindScope,
  RewindStrategy,
  RewindTargetStatus,
  checkpointCreatedPayloadSchema,
  evaluateRewindTarget,
  parseCheckpointCreatedPayload,
  parseRewindTriggeredPayload,
  parseWorkspaceCheckpointArtifact,
  rewindTriggeredPayloadSchema,
  selectActiveConversationBranch,
  workspaceCheckpointArtifactSchema,
} from "../src/rewind/index.js";

describe("rewind contracts", () => {
  const boundaryPayload: CompactBoundaryPayload = {
    boundaryId: "compact_1",
    trigger: CompactTrigger.Manual,
    summarySource: "model",
    preCompactTokenCount: 120000,
    truePostCompactTokenCount: 20000,
    summarizedMessageCount: 8,
    summaryMessageIds: ["msg_summary" as MessageId],
    traceId: "trace_1" as TraceId,
  };

  it("validates checkpoint and rewind payloads at runtime", () => {
    expect(
      parseCheckpointCreatedPayload({
        checkpointId: "checkpoint_1",
        messageId: "msg_1",
        targetMessageId: "msg_1",
        toolMessageId: "msg_assistant_1",
        scope: RewindScope.Workspace,
        snapshotRef: "artifact://snapshot_1",
      }),
    ).toMatchObject({
      checkpointId: "checkpoint_1",
      targetMessageId: "msg_1",
      toolMessageId: "msg_assistant_1",
      scope: "workspace",
    });

    expect(
      parseRewindTriggeredPayload({
        rewindId: "rewind_1",
        scope: RewindScope.Workspace,
        strategy: RewindStrategy.FileOnly,
        branchCutAfterMessageId: "msg_cut",
        branchGeneration: 2,
        targetMessageId: "msg_1",
        targetCheckpointId: "checkpoint_1",
      }),
    ).toMatchObject({
      rewindId: "rewind_1",
      branchGeneration: 2,
      strategy: "file_only",
    });

    expect(() =>
      checkpointCreatedPayloadSchema.parse({
        checkpointId: "checkpoint_1",
        messageId: "msg_1",
        scope: "everything",
        snapshotRef: "artifact://snapshot_1",
      }),
    ).toThrow();

    expect(() =>
      rewindTriggeredPayloadSchema.parse({
        rewindId: "rewind_1",
        scope: RewindScope.Workspace,
        strategy: "time_travel",
      }),
    ).toThrow();
  });

  it("校验已提交回退的消息清单，兼容旧事件缺席", () => {
    const base = { rewindId: "rewind", scope: "conversation", strategy: "active_chain" };
    expect(
      parseRewindTriggeredPayload({ ...base, removedMessageIds: ["new-user", "new-message"] }),
    ).toMatchObject({ removedMessageIds: ["new-user", "new-message"] });
    expect(parseRewindTriggeredPayload(base)).not.toHaveProperty("removedMessageIds");
    expect(() => parseRewindTriggeredPayload({ ...base, removedMessageIds: [""] })).toThrow();
  });

  it("validates workspace checkpoint artifact payloads", () => {
    expect(
      parseWorkspaceCheckpointArtifact({
        version: 1,
        kind: "workspace_file_before_change",
        createdAt: "2026-05-04T00:00:00.000Z",
        toolCallId: "tool_1",
        toolName: "Write",
        files: [
          {
            path: "/work/demo.ts",
            existedBefore: true,
            beforeContent: "old",
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-old", "+new"],
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      kind: "workspace_file_before_change",
      files: [{ beforeContent: "old", existedBefore: true }],
    });

    expect(() =>
      workspaceCheckpointArtifactSchema.parse({
        version: 1,
        kind: "workspace_file_before_change",
        createdAt: "2026-05-04T00:00:00.000Z",
        toolCallId: "tool_1",
        toolName: "Write",
        files: [],
      }),
    ).toThrow();
  });

  it("allows conversation rewind when the target is in the active chain", () => {
    const result = evaluateRewindTarget({
      items: [item("old"), boundary(), item("msg_summary"), item("msg_after")],
      scope: RewindScope.Conversation,
      targetMessageId: "msg_after",
    });

    expect(result).toMatchObject({
      compactBoundaryId: "compact_1",
      reason: "target_in_active_chain",
      strategy: RewindStrategy.ActiveChain,
      targetStatus: RewindTargetStatus.ActiveChain,
    });
    expect(result.allowedScopes).toEqual([RewindScope.Conversation]);
  });

  it("requires a checkpoint for workspace rewind even inside the active chain", () => {
    const result = evaluateRewindTarget({
      checkpointAvailable: false,
      items: [boundary(), item("msg_after")],
      scope: RewindScope.Workspace,
      targetMessageId: "msg_after",
    });

    expect(result).toMatchObject({
      reason: "checkpoint_required_for_workspace_rewind",
      strategy: RewindStrategy.Unavailable,
      targetStatus: RewindTargetStatus.ActiveChain,
    });
  });

  it("allows file-only rewind for compact-covered targets with checkpoints", () => {
    const result = evaluateRewindTarget({
      checkpointAvailable: true,
      items: [item("msg_before"), boundary(), item("msg_summary")],
      scope: RewindScope.Workspace,
      targetMessageId: "msg_before",
    });

    expect(result).toMatchObject({
      compactBoundaryId: "compact_1",
      reason: "target_covered_by_compact_file_only_available",
      strategy: RewindStrategy.FileOnly,
      targetStatus: RewindTargetStatus.CoveredByCompact,
    });
    expect(result.allowedScopes).toEqual([RewindScope.Workspace]);
  });

  it("rebuilds the active branch for compact-covered conversation rewind", () => {
    const result = evaluateRewindTarget({
      checkpointAvailable: true,
      items: [item("msg_before"), boundary(), item("msg_summary")],
      scope: RewindScope.Conversation,
      targetMessageId: "msg_before",
    });

    expect(result).toMatchObject({
      compactBoundaryId: "compact_1",
      reason: "target_covered_by_compact_active_branch_rebuild",
      strategy: RewindStrategy.ActiveChain,
      targetStatus: RewindTargetStatus.CoveredByCompact,
    });
    expect(result.allowedScopes).toEqual([
      RewindScope.Conversation,
      RewindScope.Workspace,
      RewindScope.Both,
    ]);
  });

  it("selects only the latest append-only branch across consecutive branch cuts", () => {
    const messages = [
      "old-user",
      "old-assistant",
      "edited-user",
      "edited-assistant",
      "final-user",
    ].map((id) => ({ info: { id: id as MessageId } }));

    expect(
      selectActiveConversationBranch(messages, {
        branchCutAfterMessageId: "edited-assistant" as MessageId,
        rewindKeptMessageIds: [],
        rewindTargetMessageId: "edited-user" as MessageId,
      }).map((message) => message.info.id),
    ).toEqual(["final-user"]);
  });

  it("marks missing targets unavailable", () => {
    const result = evaluateRewindTarget({
      items: [boundary(), item("msg_summary")],
      scope: RewindScope.Conversation,
      targetMessageId: "missing",
    });

    expect(result).toMatchObject({
      reason: "target_not_found",
      strategy: RewindStrategy.Unavailable,
      targetStatus: RewindTargetStatus.Missing,
    });
  });

  function boundary(): CompactContextItem {
    return item("boundary", { compactBoundary: boundaryPayload });
  }

  function item(id: string, extra?: Partial<CompactContextItem>): CompactContextItem {
    return {
      id,
      ...extra,
    };
  }
});
