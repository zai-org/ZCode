// stable fork 到同一 workspace 下的受管 worktree（forkAssistant.targetCwd，docs/git/worktree.md §8.2）。
// 只验证 core 的 child 构建合同：cwd 取目标值、workspaceID 沿用父会话、权限迁移、
// fork 分隔标记后追加 worktree_creation、不带目标时行为不变。
import { describe, expect, it } from "vitest";
import type {
  MessageId,
  MessagePart,
  MessageWithParts,
  SessionId,
  SessionInfo,
  SessionStorePort,
} from "@zcode/contracts";
import { forkStableConversationAtMessage } from "../src/runtime/methods/session-fork.js";

const SESSION_ID = "sess_target_ws_parent" as SessionId;
const WORKTREE_CREATION = {
  path: "/workspace/worktrees/3f2a/source",
  sha: "9e6d2f72d4",
  ref: null,
  output: "Preparing worktree (detached HEAD 9e6d2f7)\n",
};
const SOURCE_DIRECTORY = "/workspace/source";
const TARGET_DIRECTORY = "/workspace/worktrees/3f2a/source";

function textPart(messageId: MessageId, text: string): MessagePart {
  return {
    id: `part_${messageId}` as MessagePart["id"],
    sessionID: SESSION_ID,
    messageID: messageId,
    type: "text",
    text,
  };
}

const user: MessageWithParts = {
  info: {
    id: "msg_target_ws_user" as MessageId,
    sessionID: SESSION_ID,
    role: "user",
    time: { created: 1 },
    agent: "zcode-agent",
    modelSelection: { modelId: "glm-4-air" as never, providerId: "glm" as never },
    tools: {},
  },
  parts: [textPart("msg_target_ws_user" as MessageId, "question")],
};

const assistant: MessageWithParts = {
  info: {
    id: "msg_target_ws_assistant" as MessageId,
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: 2, completed: 3 },
    parentID: "msg_target_ws_user" as MessageId,
    agent: "zcode-agent",
    cost: 0,
    mode: "build",
    modelId: "glm-4-air" as never,
    path: { cwd: SOURCE_DIRECTORY, root: SOURCE_DIRECTORY },
    providerId: "glm" as never,
    tokens: { cache: { read: 0, write: 0 }, input: 0, output: 0, reasoning: 0, total: 0 },
  },
  parts: [textPart("msg_target_ws_assistant" as MessageId, "answer")],
};

const target = {
  productTurnId: "product-target-ws",
  transcriptTurnId: "turn-target-ws",
  orderedMessageIds: [String(user.info.id), String(assistant.info.id)],
  boundaryMessageId: String(assistant.info.id),
};

function parentSession(): SessionInfo {
  return {
    directory: SOURCE_DIRECTORY,
    id: SESSION_ID,
    path: SOURCE_DIRECTORY,
    projectID: "workspace-source",
    slug: "parent-target-ws",
    taskType: "interactive",
    permission: {
      version: 1,
      scope: "session",
      mode: "build",
      allow: [{ toolName: "Edit", ruleContent: `${SOURCE_DIRECTORY}/src/a.ts` }],
      deny: [{ toolName: "Bash", ruleContent: "rm:*" }],
    },
    time: { created: 1, updated: 1 },
    title: "parent",
    version: "test",
  } as SessionInfo;
}

function forkRuntime(parent: SessionInfo) {
  const bundles: Array<Parameters<NonNullable<SessionStorePort["commitForkBundle"]>>[0]> = [];
  const runtime = {
    appendEvent: async () => undefined,
    config: { agentName: "zcode-agent", mode: "build" },
    createEvent: (_type: unknown, payload: Record<string, unknown>) => ({ payload }),
    getSessionModelSelection: () => ({ modelId: "glm-4-air", providerId: "glm" }),
    rootTraceContext: { traceId: "trace_target_workspace" },
    sessionId: SESSION_ID,
    sessionStore: {
      async commitForkBundle(bundle) {
        bundles.push(bundle);
        return bundle.child as SessionInfo;
      },
      async getSession() {
        return parent;
      },
      async messages() {
        return [user, assistant];
      },
    } satisfies Partial<SessionStorePort>,
    workingDirectory: parent.directory,
    workspaceRoot: parent.directory,
  };
  return { bundles, runtime };
}

describe("stable fork 到受管 worktree cwd", () => {
  it("child 的 id/directory/path/projectID 取目标值，workspaceID 沿用父会话，allow 规则不跨目录", async () => {
    const parent = parentSession();
    const parentPermissionBefore = structuredClone(parent.permission);
    const { bundles, runtime } = forkRuntime(parent);

    const result = await forkStableConversationAtMessage.call(runtime as never, {
      forkedSessionId: "sess_target_ws_child" as SessionId,
      goalBoundary: { kind: "none" },
      sourceCommandId: "cmd-target-ws",
      target,
      targetCwd: {
        directory: TARGET_DIRECTORY,
        // bootstrap 按映射回源仓库的路径派生，与父项目共用权限记录（§6.6.3）。
        projectID: "workspace-source" as never,
        worktreeCreation: WORKTREE_CREATION,
      },
    });

    expect(result.forkedSessionId).toBe("sess_target_ws_child");
    // conversation-only：不回退、不恢复任何 checkpoint。
    expect(result.restoredFiles).toEqual([]);
    const child = bundles[0]!.child;
    expect(child).toMatchObject({
      id: "sess_target_ws_child",
      parentID: SESSION_ID,
      taskType: "fork",
      directory: TARGET_DIRECTORY,
      path: TARGET_DIRECTORY,
      projectID: "workspace-source",
    });
    expect(child.workspaceID).toBeUndefined();
    // allow 规则绑定父目录路径，不进入 child；deny 只会收紧，mode/scope/version 与路径无关。
    expect(child.permission).toEqual({
      version: 1,
      scope: "session",
      mode: "build",
      deny: [{ toolName: "Bash", ruleContent: "rm:*" }],
    });
    expect(parent.permission).toEqual(parentPermissionBefore);
    expect(bundles[0]!.commandFact.ack.result).toEqual({
      type: "forkAssistant",
      sessionId: "sess_target_ws_child",
    });
    const copiedTexts = bundles[0]!.messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    );
    expect(copiedTexts).toEqual(expect.arrayContaining(["question", "answer"]));
    expect(bundles[0]!.messages.every((message) => message.info.sessionID === child.id)).toBe(true);
    // fork 分隔标记之后追加 "已创建 worktree"，与 session_fork 同一条宿主消息。
    const timelineParts = bundles[0]!.messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "timeline" ? [part] : [])),
    );
    expect(timelineParts.map((part) => part.timelineType)).toEqual([
      "session_fork",
      "worktree_creation",
    ]);
    expect(timelineParts[1]).toMatchObject({
      display: "worklog",
      worktreeCreation: WORKTREE_CREATION,
    });
    expect(timelineParts[0]!.messageID).toBe(timelineParts[1]!.messageID);
  });

  it("不带 targetCwd 时 child 原样沿用父会话目录身份与权限，不追加 worktree 标记", async () => {
    const parent = parentSession();
    const { bundles, runtime } = forkRuntime(parent);
    await forkStableConversationAtMessage.call(runtime as never, {
      goalBoundary: { kind: "none" },
      sourceCommandId: "cmd-parent-ws",
      target,
    });
    expect(bundles[0]!.child).toMatchObject({
      directory: SOURCE_DIRECTORY,
      path: SOURCE_DIRECTORY,
      projectID: "workspace-source",
      permission: parent.permission,
    });
    const timelineTypes = bundles[0]!.messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "timeline" ? [part.timelineType] : [])),
    );
    expect(timelineTypes).toEqual(["session_fork"]);
  });
});
