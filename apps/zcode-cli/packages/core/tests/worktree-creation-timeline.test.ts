// 受管 worktree 新建会话的 "已创建 worktree"（docs/git/worktree.md §6.6.4）：
// 只记录一次；首轮落盘为 worklog timeline part，并发出 WorktreeCreated 事件。
import { describe, expect, it } from "vitest";
import { SessionEventType } from "@zcode/contracts";
import {
  persistPendingWorktreeCreationTimeline,
  recordPendingWorktreeCreation,
} from "../src/runtime/methods/timeline-persistence.js";

const FACT = {
  path: "/workspace/worktrees/3f2a/source",
  sha: "9e6d2f72d4",
  ref: "origin/main",
  output: "HEAD is now at 9e6d2f7\n",
};

function fakeRuntime() {
  const persisted: Array<Record<string, unknown>> = [];
  const events: Array<{ type: string; payload: unknown }> = [];
  const runtime = {
    sessionId: "sess_worktree_timeline",
    pendingWorktreeCreation: undefined as typeof FACT | undefined,
    async persistAssistantTimelinePartForSession(options: Record<string, unknown>) {
      persisted.push(options);
      return { messageID: "msg", partID: "part" };
    },
    createEvent(type: string, payload: unknown) {
      return { type, payload };
    },
    async appendEvent(event: { type: string; payload: unknown }) {
      events.push(event);
    },
  };
  return { runtime, persisted, events };
}

describe("worktree_creation timeline", () => {
  it("首次记录生效，重复记录保持第一次的事实；首轮只落盘一次并发出事件", async () => {
    const { runtime, persisted, events } = fakeRuntime();
    recordPendingWorktreeCreation.call(runtime as never, FACT);
    recordPendingWorktreeCreation.call(runtime as never, { ...FACT, sha: "other" });

    const trace = { traceId: "trace" } as never;
    await persistPendingWorktreeCreationTimeline.call(runtime as never, trace);
    await persistPendingWorktreeCreationTimeline.call(runtime as never, trace);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.timeline).toMatchObject({
      timelineType: "worktree_creation",
      display: "worklog",
      status: "completed",
      worktreeCreation: FACT,
    });
    expect(events).toEqual([{ type: SessionEventType.WorktreeCreated, payload: FACT }]);
    expect(runtime.pendingWorktreeCreation).toBeUndefined();
  });

  it("没有记录时不落盘也不发事件", async () => {
    const { runtime, persisted, events } = fakeRuntime();
    await persistPendingWorktreeCreationTimeline.call(runtime as never, { traceId: "t" } as never);
    expect(persisted).toEqual([]);
    expect(events).toEqual([]);
  });
});
