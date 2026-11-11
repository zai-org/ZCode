import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods, zcodeSessionMessagesResultSchema } from "@zcode/shared";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createMessageId, createPartId, createProjectId, createSessionId } from "@zcode/contracts";
import { ZCodeProtocolAgentServer } from "../../src/zcode-protocol/server.js";
import type { ZCodeAppOptions } from "../../src/app/types.js";
import { createFakeApp } from "../helpers/fake-zcode-app.js";

const workspace = { workspacePath: "/workspace", workspaceKey: "/workspace" };
function advertiseAppControl(server: ZCodeProtocolAgentServer, enabled = true) {
  server.setNotificationSink((message) => {
    if (
      "id" in message &&
      message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
    ) {
      void server.handleMessage({
        id: message.id,
        result: {
          memoryEnabled: false,
          nativeSearchEnhancementsEnabled: true,
          appControlEnabled: enabled,
        },
      });
    }
  });
}
function fakeApp(options?: Omit<ZCodeAppOptions, "providerRegistry">) {
  const app = createFakeApp(options);
  app.runtime.beginShutdown = () => undefined;
  return app;
}

describe("production protocol session control materialization", () => {
  it("maps persisted SQLite messages and parts to the wire schema without losing media or tool metadata", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("read-messages-wire");
    const userId = createMessageId("wire-user");
    const assistantId = createMessageId("wire-assistant");
    const filePartId = createPartId("wire-image");
    const toolPartId = createPartId("wire-tool");
    const mediaMetadata = {
      artifactUri: "zcode-artifact://session/image",
      originalFilename: "sample.png",
    };
    const readArtifact = vi.fn(async () => ({
      uri: mediaMetadata.artifactUri,
      contentType: "image/png",
      content: "aGVsbG8=",
      sizeBytes: 8,
      truncated: false,
    }));
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => ({ ...fakeApp(options), readToolResultArtifact: readArtifact }),
      cwd: workspace.workspacePath,
      sessionStore: store,
      version: "test",
    });
    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("wire-project"),
        slug: "wire-history",
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: "wire history",
        version: "test",
        taskType: "interactive",
      });
      await store.saveMessage({
        id: userId,
        sessionID: sessionId,
        role: "user",
        time: { created: 1 },
        agent: "build",
        metadata: { source: "fixture" },
      });
      await store.savePart({
        id: createPartId("wire-text"),
        sessionID: sessionId,
        messageID: userId,
        type: "text",
        text: "Inspect this image",
        metadata: { language: "en" },
      });
      await store.savePart({
        id: filePartId,
        sessionID: sessionId,
        messageID: userId,
        type: "file",
        mime: "image/png",
        filename: "sample.png",
        url: mediaMetadata.artifactUri,
        metadata: mediaMetadata,
      });
      await store.saveMessage({
        id: assistantId,
        sessionID: sessionId,
        role: "assistant",
        parentID: userId,
        time: { created: 2, completed: 4 },
        mode: "build",
        agent: "build",
        path: { cwd: workspace.workspacePath, root: workspace.workspacePath },
        cost: 0,
        tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      });
      await store.savePart({
        id: createPartId("wire-reasoning"),
        sessionID: sessionId,
        messageID: assistantId,
        type: "reasoning",
        text: "Inspecting",
        time: { start: 2, end: 3 },
        metadata: { signature: "fixture-signature" },
      });
      await store.savePart({
        id: toolPartId,
        sessionID: sessionId,
        messageID: assistantId,
        type: "tool",
        callID: "wire-call",
        tool: "Read",
        metadata: { presentation: "file-preview", providerToolName: "private-read-name" },
        state: {
          status: "completed",
          input: { file_path: "sample.png" },
          output: "image inspected",
          title: "Read image",
          metadata: {
            contentType: "image/png",
            display: { variant: "fixture-display" },
            readFileState: { private: "snapshot" },
          },
          time: { start: 3, end: 4 },
        },
      });
      const restored = await server.handleMessage({
        id: "restore-wire",
        method: zcodeProtocolMethods.sessionResume,
        params: { sessionId, workspace },
      });
      expect(restored, JSON.stringify(restored)).toHaveProperty("result");
      readArtifact.mockClear();
      const response = await server.handleMessage({
        id: "read-wire",
        method: zcodeProtocolMethods.sessionMessages,
        params: { sessionId },
      });
      expect(response, JSON.stringify(response)).toHaveProperty("result");
      const parsed = zcodeSessionMessagesResultSchema.parse(
        response && "result" in response ? response.result : undefined,
      );
      expect(parsed.messages.map((message) => message.info.messageId)).toEqual([
        userId,
        assistantId,
      ]);
      expect(readArtifact).toHaveBeenCalledExactlyOnceWith(mediaMetadata.artifactUri);
      expect(parsed.messages[0]?.info).toMatchObject({
        sessionId,
        metadata: { source: "fixture" },
      });
      expect(parsed.messages[0]?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "file",
            partId: filePartId,
            messageId: userId,
            sessionId,
            filename: "sample.png",
            mime: "image/png",
            url: "data:image/png;base64,aGVsbG8=",
            metadata: mediaMetadata,
          }),
          expect.objectContaining({
            type: "text",
            text: "Inspect this image",
            metadata: { language: "en" },
          }),
        ]),
      );
      expect(parsed.messages[1]?.info).toMatchObject({
        parentMessageId: userId,
        time: { created: 2, completed: 4 },
      });
      expect(parsed.messages[1]?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "reasoning",
            text: "Inspecting",
            metadata: { signature: "fixture-signature" },
          }),
          expect.objectContaining({
            type: "tool",
            partId: toolPartId,
            messageId: assistantId,
            sessionId,
            callId: "wire-call",
            metadata: { presentation: "file-preview" },
            state: {
              status: "completed",
              input: { file_path: "sample.png" },
              output: "image inspected",
              title: "Read image",
              metadata: { contentType: "image/png", display: { variant: "fixture-display" } },
              startedAt: 3,
              completedAt: 4,
            },
          }),
        ]),
      );
      const page = await server.handleMessage({
        id: "read-page",
        method: zcodeProtocolMethods.sessionMessages,
        params: { sessionId, afterMessageId: userId, limit: 1 },
      });
      const parsedPage = zcodeSessionMessagesResultSchema.parse(
        page && "result" in page ? page.result : undefined,
      );
      expect(parsedPage.messages).toEqual([parsed.messages[1]]);
    } finally {
      await server.shutdown();
      store.close();
    }
  });
  it("pages forward from the oldest message while preserving the default tail window", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("read-messages-pages");
    const ids = ["first", "second", "third", "fourth"].map(createMessageId);
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: fakeApp,
      cwd: workspace.workspacePath,
      sessionStore: store,
      version: "test",
    });
    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("paging-project"),
        slug: "paging-history",
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: "paging history",
        version: "test",
        taskType: "interactive",
      });
      // 运行时提醒以隐藏 user 消息落库，夹在可见消息之间；forward 分页必须跳过它。
      // 消息按写入顺序排列，所以在第一条之后立即写入。
      const reminderId = createMessageId("hidden-reminder");
      for (const [index, id] of ids.entries()) {
        await store.saveMessage({
          id,
          sessionID: sessionId,
          role: "user",
          time: { created: (index + 1) * 10 },
          agent: "build",
        });
        if (index === 0)
          await store.saveMessage({
            id: reminderId,
            sessionID: sessionId,
            role: "user",
            time: { created: 15 },
            agent: "build",
            visibility: "model-only",
            synthetic: true,
          } as never);
      }
      const restored = await server.handleMessage({
        id: "restore-pages",
        method: zcodeProtocolMethods.sessionResume,
        params: { sessionId, workspace },
      });
      expect(restored, JSON.stringify(restored)).toHaveProperty("result");
      const read = async (params: Record<string, unknown>) => {
        const response = await server.handleMessage({
          id: "read-pages",
          method: zcodeProtocolMethods.sessionMessages,
          params: { sessionId, ...params },
        });
        expect(response, JSON.stringify(response)).toHaveProperty("result");
        return zcodeSessionMessagesResultSchema
          .parse(response && "result" in response ? response.result : undefined)
          .messages.map((message) => message.info.messageId);
      };
      // 默认与 backward 保持原尾部窗口与原始消息集合，不受 forward 过滤影响。
      expect(await read({})).toContain(reminderId);
      expect(await read({ limit: 3 })).toEqual(ids.slice(-3));
      expect(await read({ limit: 3, direction: "backward" })).toEqual(ids.slice(-3));
      expect(await read({ limit: 3, direction: "forward" })).toEqual(ids.slice(0, 3));
      expect(await read({ afterMessageId: ids[0], limit: 1, direction: "forward" })).toEqual([
        ids[1],
      ]);
      expect(await read({ afterMessageId: ids[1], limit: 3, direction: "forward" })).toEqual(
        ids.slice(2),
      );
      expect(await read({ afterMessageId: ids[3], limit: 3, direction: "forward" })).toEqual([]);
      expect(await read({ direction: "forward" })).not.toContain(reminderId);
      // cursor 落在不可见或已不存在的消息上时报错，不从头重读出重复页。
      for (const missing of [reminderId, "msg_missing"]) {
        const response = await server.handleMessage({
          id: "read-missing-cursor",
          method: zcodeProtocolMethods.sessionMessages,
          params: { sessionId, afterMessageId: missing, limit: 1, direction: "forward" },
        });
        expect(response).toHaveProperty("error");
      }
    } finally {
      await server.shutdown();
      store.close();
    }
  });

  // 规格 0.9：ReadSession 读一个从未恢复的冷会话。原先一律 requireSession，
  // forward 因此抛 sessionUnavailable 并被 Host 压成 "App control failed"。
  it("reads a cold session forward without restoring its runtime", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("read-messages-cold");
    const deletedId = createSessionId("read-messages-cold-deleted");
    const visible = ["cold-first", "cold-second"].map(createMessageId);
    const reminderId = createMessageId("cold-reminder");
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: fakeApp,
      cwd: workspace.workspacePath,
      sessionStore: store,
      version: "test",
    });
    try {
      for (const id of [sessionId, deletedId]) {
        await store.createSession({
          id,
          projectID: createProjectId("cold-project"),
          slug: "cold-history",
          directory: workspace.workspacePath,
          path: workspace.workspacePath,
          title: "cold history",
          version: "test",
          taskType: "interactive",
        });
      }
      await store.saveMessage({
        id: visible[0]!,
        sessionID: sessionId,
        role: "user",
        time: { created: 10 },
        agent: "build",
      });
      await store.saveMessage({
        id: reminderId,
        sessionID: sessionId,
        role: "user",
        time: { created: 15 },
        agent: "build",
        visibility: "model-only",
        synthetic: true,
      } as never);
      await store.saveMessage({
        id: visible[1]!,
        sessionID: sessionId,
        role: "user",
        time: { created: 20 },
        agent: "build",
      });
      await store.softDeleteSession(deletedId);
      const read = (params: Record<string, unknown>) =>
        server.handleMessage({
          id: "read-cold",
          method: zcodeProtocolMethods.sessionMessages,
          params,
        });
      const cold = await read({ sessionId, limit: 20, direction: "forward" });
      expect(cold, JSON.stringify(cold)).toHaveProperty("result");
      const messages = zcodeSessionMessagesResultSchema
        .parse(cold && "result" in cold ? cold.result : undefined)
        .messages.map((message) => message.info.messageId);
      // 只返回可见消息，并且没有为读取创建任何 runtime record。
      expect(messages).toEqual(visible);
      expect(messages).not.toContain(reminderId);
      // backward 仍要求活跃 record：不扩大桌面分页历史的读取面。
      expect(await read({ sessionId, limit: 20, direction: "backward" })).toHaveProperty("error");
      // 软删除与不存在的会话都明确不可用，不返回空页。
      expect(await read({ sessionId: deletedId, limit: 20, direction: "forward" })).toHaveProperty(
        "error",
      );
      expect(
        await read({ sessionId: "sess_missing-cold", limit: 20, direction: "forward" }),
      ).toHaveProperty("error");
    } finally {
      await server.shutdown();
      store.close();
    }
  });
  it.each([
    "interactive",
    "fork",
    "workflow_parent",
    "subagent_child",
    "workflow_child",
    "nested_workflow_child",
    "selection_side_chat",
  ] as const)("binds only an authorized root kind: %s", async (taskType) => {
    let createdOptions: ZCodeAppOptions | undefined;
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId(`control-${taskType}`);
    await store.createSession({
      id: sessionId,
      projectID: createProjectId("project"),
      slug: "session",
      directory: workspace.workspacePath,
      path: workspace.workspacePath,
      title: "session",
      version: "test",
      taskType,
      ...(taskType === "fork" ? { parentID: createSessionId("fork-source") } : {}),
    });
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        createdOptions = options;
        return fakeApp(options);
      },
      cwd: workspace.workspacePath,
      version: "test",
      sessionStore: store,
    });
    advertiseAppControl(server);
    const response = await server.handleMessage({
      id: `resume-${taskType}`,
      method: zcodeProtocolMethods.sessionResume,
      params: { workspace, sessionId },
    });
    expect(response, JSON.stringify(response)).toHaveProperty("result");
    const isRoot = ["interactive", "fork", "workflow_parent"].includes(taskType);
    expect(createdOptions?.sessionControl?.kind).toBe(isRoot ? "app" : undefined);
    if (isRoot) {
      expect(createdOptions?.sessionControl?.context().rootSession).toMatchObject({
        kind: "app",
        workspacePath: "/workspace",
        sessionId: createdOptions?.sessionId,
      });
    }
    await server.shutdown();
    store.close();
  });

  it.each(["no-host", "disabled", "old-host"] as const)(
    "hides App tools when capabilities are unavailable: %s",
    async (kind) => {
      let createdOptions: ZCodeAppOptions | undefined;
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) => {
          createdOptions = options;
          return fakeApp(options);
        },
        cwd: workspace.workspacePath,
        version: "test",
      });
      if (kind === "disabled") advertiseAppControl(server, false);
      if (kind === "old-host")
        server.setNotificationSink((message) => {
          if ("id" in message)
            void server.handleMessage({
              id: message.id,
              error: { code: -32601, message: "Method not found" },
            });
        });
      const response = await server.handleMessage({
        id: "root",
        method: zcodeProtocolMethods.sessionCreate,
        params: { workspace },
      });
      expect(response, JSON.stringify(response)).toHaveProperty("result");
      expect(createdOptions?.sessionControl).toBeUndefined();
      await server.shutdown();
    },
  );

  it("does not inherit App control into a parent-linked interactive session", async () => {
    let createdOptions: ZCodeAppOptions | undefined;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => {
        createdOptions = options;
        return fakeApp(options);
      },
      cwd: workspace.workspacePath,
      version: "test",
    });
    advertiseAppControl(server);
    const response = await server.handleMessage({
      id: "child",
      method: zcodeProtocolMethods.sessionCreate,
      params: { workspace, parentSessionId: "parent" },
    });
    expect(response).toHaveProperty("result");
    expect(createdOptions?.sessionControl).toBeUndefined();
    await server.shutdown();
  });
});
