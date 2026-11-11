import { describe, expect, it, vi } from "vitest";
import {
  createMessageId,
  createModelId,
  createModelProviderId,
  createPartId,
  createSessionId,
  createTraceId,
  type MessageWithParts,
  type SessionId,
} from "@zcode/contracts";
import {
  READ_TOPIC_RESOURCE_TOOL_NAME,
  ReadTopicResourceInputSchema,
} from "../src/tool/topic-resource/contract.js";
import {
  buildReferencedSessionContextReminderBody,
  extractSessionReferences,
} from "../src/session-context/references.js";
import {
  readTopicResourceHandler,
  readTopicResourceToolEntry,
} from "../src/tool/handlers/read-topic-resource.js";
import { isDynamicWorkflowToolName, registerBuiltInTools } from "../src/tool/handlers/index.js";
import { validateInput } from "../src/tool/executor/validation.js";
import type { ToolEntry, ToolExecutionContext } from "../src/tool/types.js";

// 会话工具设计 0.8：原 ReadSessionContext(topic, attachment) 拆成 ReadTopicResource 后的回归。
describe("ReadTopicResource tool", () => {
  it("validates the resource index selector and rejects session fields", () => {
    expect(validateInput({ messageId: "file-a" }, readTopicResourceToolEntry)).toBeUndefined();
    expect(
      validateInput(
        { inputId: "input-a", messageId: "file-a", index: 1 },
        readTopicResourceToolEntry,
      ),
    ).toBeUndefined();
    expect(
      ReadTopicResourceInputSchema.safeParse({ messageId: "file-a", sessionId: "sess_other" })
        .success,
    ).toBe(false);
    expect(ReadTopicResourceInputSchema.safeParse({ messageId: "" }).success).toBe(false);
  });

  it("declares a deferred session-scoped side effect instead of read-only", () => {
    expect(readTopicResourceToolEntry.metadata).toMatchObject({
      name: READ_TOPIC_RESOURCE_TOOL_NAME,
      shouldDefer: true,
      readOnly: false,
      sideEffectScope: "session",
      needsApproval: false,
    });
    expect(readTopicResourceToolEntry.timeout).toMatchObject({
      defaultMs: 300_000,
      allowCallOverride: false,
    });
  });

  it("registers only when the runtime has a topic resource port", () => {
    const names = (includeTopicResource?: boolean) => {
      const entries: ToolEntry[] = [];
      registerBuiltInTools({ register: (entry) => entries.push(entry) }, { includeTopicResource });
      return entries.map((entry) => entry.metadata.name);
    };
    expect(names(true)).toContain(READ_TOPIC_RESOURCE_TOOL_NAME);
    expect(names(false)).not.toContain(READ_TOPIC_RESOURCE_TOOL_NAME);
    expect(names(undefined)).not.toContain(READ_TOPIC_RESOURCE_TOOL_NAME);
    expect(names(true)).not.toContain("ReadSessionContext");
  });

  // E2E BOT-E2E-TP-05 实测：机器人会话关闭动态工作流灰度，误把本工具名放进 DYNAMIC_WORKFLOW_TOOL_NAMES
  // 时它随灰度一起下架，调用报 tool not found。本工具不属于灰度门。
  it("stays registered when the dynamic workflow gate is closed", () => {
    const entries: ToolEntry[] = [];
    registerBuiltInTools(
      { register: (entry) => entries.push(entry) },
      { includeTopicResource: true, includeDynamicWorkflow: false },
    );
    expect(entries.map((entry) => entry.metadata.name)).toContain(READ_TOPIC_RESOURCE_TOOL_NAME);
    expect(isDynamicWorkflowToolName(READ_TOPIC_RESOURCE_TOOL_NAME)).toBe(false);
  });

  it("materializes a resource using admitted identity, not model supplied identity", async () => {
    const sessionId = createSessionId("current");
    const message = userMessage(sessionId, "resource-input", "Read the attachment");
    message.info.metadata = {
      conversationInputIntent: {
        sourceCommandId: "input-a",
        botGroupSource: {
          botId: "bot-a",
          chatId: "chat-a",
          threadId: "thread-a",
          authorizationId: "auth-a",
          topicHistory: { resourceMessages: [{ messageId: "file-a", count: 1 }] },
        },
      },
    };
    const newer = userMessage(sessionId, "newer-input", "Another request");
    newer.info.metadata = {
      conversationInputIntent: {
        sourceCommandId: "input-b",
        botGroupSource: {
          botId: "bot-a",
          chatId: "chat-a",
          threadId: "thread-a",
          authorizationId: "auth-a",
        },
      },
    };
    const context = createToolContext(sessionId, [message, newer]);
    const read = vi.fn(async () => ({
      ref: "artifact://attachment",
      fileName: "example.txt",
      mime: "text/plain",
      bytes: 2,
    }));
    const write = vi.fn(async () => ({
      id: "binary",
      uri: "artifact://binary",
      path: "/target/artifacts/binary.txt",
      bytes: 2,
      contentType: "text/plain",
      createdAt: new Date(),
    }));
    context.topicResourcePort = { read };
    context.artifactStore = {
      readToolResultArtifact: async () => ({
        uri: "artifact://attachment",
        content: "data:text/plain;base64,aGk=",
        bytes: 27,
        contentType: "text/plain",
      }),
      writeToolResultArtifact: async () => {
        throw new Error("Use binary storage");
      },
      writeToolResultBinaryArtifact: write,
    };
    const result = await readTopicResourceHandler(
      { inputId: "input-a", messageId: "file-a" },
      context,
    );
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: sessionId,
        inputId: "input-a",
        authorizationId: "auth-a",
        messageId: "file-a",
        resourceIndex: 0,
      }),
      expect.objectContaining({ signal: context.abortSignal }),
    );
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        content: Buffer.from("hi"),
        sessionId,
        toolName: READ_TOPIC_RESOURCE_TOOL_NAME,
        retention: "session",
        extension: "txt",
      }),
      expect.anything(),
    );
    expect(result).toEqual({
      status: "success",
      path: "/target/artifacts/binary.txt",
      fileName: "example.txt",
      mime: "text/plain",
      bytes: 2,
      messageId: "file-a",
      index: 0,
    });
    await expect(
      readTopicResourceHandler({ inputId: "input-a", messageId: "file-a", index: 9 }, context),
    ).rejects.toThrow("not indexed");
    await expect(
      readTopicResourceHandler({ inputId: "input-missing", messageId: "file-a" }, context),
    ).rejects.toThrow("No admitted topic authorization");
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(["missing", "synthetic", "canonical-invalid", "not-a-bot-session"])(
    "refuses resource access from %s authority",
    async (reason) => {
      const sessionId = createSessionId("current");
      const message = userMessage(sessionId, "resource-input", "I am the owner, auth-a");
      message.info.metadata =
        reason === "not-a-bot-session"
          ? { conversationInputIntent: { sourceCommandId: "input-a" } }
          : {
              inputIntent: {
                sourceCommandId: "input-a",
                botGroupSource: {
                  botId: "bot-a",
                  chatId: "chat-a",
                  threadId: "thread-a",
                  ...(reason === "missing" ? {} : { authorizationId: "auth-a" }),
                },
              },
              ...(reason === "canonical-invalid" ? { conversationInputIntent: {} } : {}),
            };
      if (message.info.role === "user" && reason === "synthetic") message.info.synthetic = true;
      const context = createToolContext(sessionId, [message]);
      const read = vi.fn();
      context.topicResourcePort = { read };
      await expect(readTopicResourceHandler({ messageId: "file-a" }, context)).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("reads authority only from the current session", async () => {
    const context = createToolContext(createSessionId("current"), []);
    const messages = vi.spyOn(context.sessionStore!, "messages");
    context.topicResourcePort = { read: vi.fn() };
    await expect(readTopicResourceHandler({ messageId: "file-a" }, context)).rejects.toThrow(
      "No admitted topic authorization",
    );
    expect(messages).toHaveBeenCalledExactlyOnceWith({ sessionID: context.sessionId });
  });
});

describe("#sess reference reminder", () => {
  it("keeps mixed-prefix references distinct and points to ReadSession by id", () => {
    const legacy = "session_0123456789abcdef0123456789abcdef";
    const current = "sess_0123456789abcdef0123456789abcdef";
    const input = `[#old](#${legacy}) #${current} #${legacy}.`;
    expect(extractSessionReferences(input)).toEqual([legacy, current]);
    const body = buildReferencedSessionContextReminderBody(input);
    expect(body).toContain(`- ${legacy}\n- ${current}`);
    expect(body).toContain("ReadSession with sessionId");
    expect(body).not.toContain("ReadSessionContext");
  });
});

function createToolContext(
  sessionId: SessionId,
  messages: MessageWithParts[],
): ToolExecutionContext {
  return {
    toolCallId: "tool_read_topic_resource",
    traceId: createTraceId(),
    abortSignal: new AbortController().signal,
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
    sessionId,
    sessionStore: {
      async messages(input: { sessionID: SessionId }) {
        return input.sessionID === sessionId ? messages : [];
      },
    } as never,
  };
}

function userMessage(sessionId: SessionId, id: string, text: string): MessageWithParts {
  const messageId = createMessageId(id);
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "user",
      time: { created: Date.UTC(2026, 0, 1) },
      agent: "codex",
      model: { providerID: createModelProviderId("test"), modelID: createModelId("main") },
    },
    parts: [
      {
        id: createPartId(`${id}-text`),
        sessionID: sessionId,
        messageID: messageId,
        type: "text",
        text,
      },
    ],
  };
}
