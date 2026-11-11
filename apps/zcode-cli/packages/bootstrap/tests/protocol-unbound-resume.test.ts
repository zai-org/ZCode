import { describe, expect, it, vi } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createLegacySelectionStoreFixture } from "./helpers/legacy-selection-store.js";
import { ProviderRegistry } from "@zcode/provider";
import {
  createSessionId,
  createProjectId,
  createMessageId,
  createPartId,
  SESSION_ENTRY_MODEL_SELECTION,
} from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeSessionForkResultSchema,
  zcodeSessionStateSnapshotSchema,
} from "@zcode/shared";
import {
  V4_METHODS,
  conversationTopic,
  routedTopicWireFrameSchema,
  conversationTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

const identity = { providerId: "provider-a", modelId: "model-a" };
const complete = { ...identity, options: { reasoningLevel: "high" } };

describe("真实 Protocol/App/SQLite 的未绑定创建", () => {
  it("V4 未绑定与显式选择的创建均不构造 legacy 快照", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const apps: Awaited<ReturnType<typeof createRegistryBackedTestApp>>[] = [];
    // 未绑定创建必须明确使用空候选；公共测试 helper 会额外 seed 默认模型。
    let registry = new ProviderRegistry([]);
    const server = new ZCodeProtocolAgentServer({
      cwd: process.cwd(),
      sessionStore: store,
      createZCodeApp: async (options) => {
        const app = await createRegistryBackedTestApp({
          ...options,
          env: {},
          skipUserConfig: true,
          providerRegistry: registry,
          configuredDefaultModelSelection: undefined,
        });
        apps.push(app);
        return app;
      },
    });
    server.setNotificationSink((message) => {
      if (
        "id" in message &&
        message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
      ) {
        void server.handleMessage({
          id: message.id,
          result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
        });
      }
    });
    try {
      const created = await server.handleMessage({
        id: "create",
        method: V4_METHODS.command,
        params: {
          clientId: "unbound-create",
          commandId: "create",
          issuedAt: 1,
          sessionId: null,
          type: "createSession",
          payload: { workspaceId: process.cwd() },
        },
      });
      expect(created).toMatchObject({
        result: {
          status: "accepted",
          result: { type: "createSession", sessionId: expect.any(String) },
        },
      });
      expect(apps[0]?.runtime.getSessionModelSelection()).toBeUndefined();
      registry = createTestProviderRegistry([identity]);
      const selected = await server.handleMessage({
        id: "select",
        method: V4_METHODS.command,
        params: {
          clientId: "unbound-create",
          commandId: "select",
          issuedAt: 2,
          sessionId: null,
          type: "createSession",
          payload: { workspaceId: process.cwd(), config: { modelSelection: complete } },
        },
      });
      expect(selected).toMatchObject({ result: { status: "accepted" } });
      expect(apps[1]?.runtime.getSessionModelSelection()).toEqual(complete);
      registry = new ProviderRegistry([]);
      const importedId = createSessionId("unbound-import-create");
      const imported = await server.handleMessage({
        id: "import",
        method: zcodeProtocolMethods.sessionCreate,
        params: {
          sessionId: importedId,
          workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() },
          importedHistory: {
            source: "claudeCode",
            title: "Unbound imported history",
            messages: [
              { role: "user", content: "old question" },
              { role: "assistant", content: "old answer" },
            ],
          },
        },
      });
      expect(imported, JSON.stringify(imported)).toHaveProperty("result");
      const messages = await store.messages({ sessionID: importedId });
      expect(
        messages.map((message) => message.parts.find((part) => part.type === "text")?.text),
      ).toEqual(["old question", "old answer"]);
      expect(messages[0]?.info).not.toHaveProperty("modelSelection");
      expect(messages[1]?.info).not.toHaveProperty("modelId");
      expect(messages[1]?.info).not.toHaveProperty("providerId");
      expect(apps[2]?.runtime.getSessionModelSelection()).toBeUndefined();
    } finally {
      for (const app of apps) await app.close();
      store.close();
    }
  });
});

describe.each(["desktop-continuous", "web-remote-replayable"] as const)(
  "真实 Protocol/App/SQLite 的未绑定冷恢复 %s",
  (clientMode) => {
    it("冷恢复时 Provider 缺席，恢复后 Bot 首条输入沿用持久选择", async () => {
      const fixture = await createLegacySelectionStoreFixture();
      const { store } = fixture;
      const sessionID = createSessionId("bot-cold-model-recovery");
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("bot-cold-model-recovery"),
        directory: process.cwd(),
        slug: "bot-cold-model-recovery",
        title: "Bot cold model recovery",
        version: "test",
      });
      await store.saveSessionEntry({
        id: `${sessionID}:runtime-model-selection`,
        sessionID,
        type: SESSION_ENTRY_MODEL_SELECTION,
        touchSession: false,
        time: { created: 2, updated: 2 },
        data: complete,
      });
      const registry = new ProviderRegistry([]);
      const generateText = vi.fn(async () => ({
        text: "E2E_BOT_COLD_MODEL_RECOVERED",
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }));
      const apps: Awaited<ReturnType<typeof createRegistryBackedTestApp>>[] = [];
      const server = new ZCodeProtocolAgentServer({
        cwd: process.cwd(),
        sessionStore: store,
        createZCodeApp: async (options) => {
          const app = await createRegistryBackedTestApp({
            ...options,
            env: {},
            skipUserConfig: true,
            providerRegistry: registry,
            modelExecutor: { generateText },
            runtimeConfig: { ...options.runtimeConfig, titleGeneration: { enabled: false } },
          });
          apps.push(app);
          return app;
        },
      });
      server.setNotificationSink((message) => {
        if (
          "id" in message &&
          message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences
        )
          void server.handleMessage({
            id: message.id,
            result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
          });
      });
      try {
        const subscribed = await server.handleMessage({
          id: "bot-cold-subscribe",
          method: V4_METHODS.conversationSubscribe,
          params: { topic: conversationTopic(sessionID), connectionId: "bot-cold", clientMode },
        });
        expect(subscribed, JSON.stringify(subscribed)).toHaveProperty("result");
        expect(apps[0]?.runtime.getSessionModelSelection()).toBeUndefined();
        const unavailable = await server.handleMessage({
          id: "bot-provider-unavailable",
          method: V4_METHODS.command,
          params: {
            clientId: "bot:feishu:cold-recovery",
            commandId: "bot-provider-unavailable",
            issuedAt: 2,
            sessionId: sessionID,
            type: "sendText",
            payload: { text: "E2E_BOT_UNAVAILABLE_MODEL", requestedDelivery: "queue" },
          },
        });
        expect(unavailable, JSON.stringify(unavailable)).toMatchObject({
          result: { status: "failed", reasonCode: "modelUnavailable" },
        });
        expect(generateText).not.toHaveBeenCalled();
        expect(await store.messages({ sessionID })).toHaveLength(0);
        registry.replace(createTestProviderRegistry([identity]).listProviders(), "provider-ready");
        const response = await server.handleMessage({
          id: "bot-cold-input",
          method: V4_METHODS.command,
          params: {
            clientId: "bot:feishu:cold-recovery",
            commandId: "bot-cold-input",
            issuedAt: 3,
            sessionId: sessionID,
            type: "sendText",
            payload: { text: "E2E_BOT_COLD_MODEL_INPUT", requestedDelivery: "queue" },
          },
        });
        expect(response, JSON.stringify(response)).toMatchObject({
          result: { status: "accepted" },
        });
        await vi.waitFor(
          async () => {
            const messages = await store.messages({ sessionID });
            expect(
              messages
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "text")
                .map((part) => part.text),
            ).toContain("E2E_BOT_COLD_MODEL_RECOVERED");
          },
          { timeout: 10_000 },
        );
        expect(generateText).toHaveBeenCalledOnce();
        expect(apps[0]?.runtime.getSessionModelSelection()).toEqual(complete);
        expect(
          (await store.sessionEntries({ sessionID, type: SESSION_ENTRY_MODEL_SELECTION })).at(-1)
            ?.data,
        ).toEqual(complete);
      } finally {
        for (const app of apps) await app.close();
        await fixture.dispose();
      }
    }, 20_000);

    it.each([
      { stored: identity, provider: identity.providerId, model: identity.modelId },
      {
        stored: { ...identity, options: { reasoningLevel: "removed" } },
        provider: identity.providerId,
        model: identity.modelId,
      },
      {
        stored: { ...complete, providerId: "removed" },
        provider: "removed",
        model: identity.modelId,
      },
      { stored: {}, provider: "", model: "" },
      {
        stored: {
          providerId: "builtin:bigmodel-coding-plan",
          modelId: identity.modelId,
        },
        provider: "account:bigmodel-individual-coding-plan",
        model: identity.modelId,
      },
    ])("当前选择 $stored 不被消息或恢复提示替换", async ({ stored, provider, model }) => {
      const fixture = await createLegacySelectionStoreFixture();
      let { store } = fixture;
      const sessionID = createSessionId("protocol-unbound");
      const messageID = createMessageId("protocol-history");
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("protocol-unbound"),
        directory: process.cwd(),
        slug: "unbound",
        title: "History remains",
        version: "test",
      });
      await store.saveMessage({
        id: messageID,
        sessionID,
        role: "user",
        agent: "zcode-agent",
        time: { created: 1 },
        modelSelection: complete,
      });
      await store.savePart({
        id: createPartId("history"),
        messageID,
        sessionID,
        type: "text",
        text: "Existing history",
      });
      if ("providerId" in stored && stored.providerId?.startsWith("builtin:")) {
        await fixture.seedLegacy(sessionID, {
          providerId: stored.providerId,
          modelId: stored.modelId,
        });
        store = fixture.store;
      } else
        await store.saveSessionEntry({
          id: `${sessionID}:runtime-model-selection`,
          sessionID,
          type: SESSION_ENTRY_MODEL_SELECTION,
          time: { created: 2, updated: 2 },
          data: stored,
        });
      const apps: Awaited<ReturnType<typeof createRegistryBackedTestApp>>[] = [];
      const legacyProviderResolveRequests: unknown[] = [];
      const server = new ZCodeProtocolAgentServer({
        cwd: process.cwd(),
        sessionStore: store,
        createZCodeApp: async (options) => {
          const app = await createRegistryBackedTestApp({
            ...options,
            env: {},
            skipUserConfig: true,
            providerRegistry: createTestProviderRegistry([
              identity,
              { providerId: "account:bigmodel-individual-coding-plan", modelId: identity.modelId },
            ]),
            configuredDefaultModelSelection: complete,
          });
          apps.push(app);
          return app;
        },
      });
      server.setNotificationSink((message) => {
        if (!("id" in message)) return;
        if (message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
          void server.handleMessage({
            id: message.id,
            result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
          });
        }
        if (message.method === "session/resolveLegacyModelProvider") {
          legacyProviderResolveRequests.push(message);
          void server.handleMessage({
            id: message.id,
            result: { providerId: "account:bigmodel-individual-coding-plan" },
          });
        }
      });
      try {
        const response = await server.handleMessage({
          id: "subscribe",
          method: V4_METHODS.conversationSubscribe,
          params: {
            topic: conversationTopic(sessionID),
            connectionId: "test",
            clientMode,
            resumeThoughtLevel: "high",
          },
        });
        expect(response).toHaveProperty("result");
        const messages = server.takePostResponseMessages("subscribe");
        const wire = routedTopicWireFrameSchema.parse(messages[0]?.params);
        if (wire.kind !== "complete") throw new Error("Expected a complete frame");
        const frame = conversationTopicFrameSchema.parse(wire.frame);
        if (frame.payload.kind !== "snapshot") throw new Error("Expected snapshot");
        // Snapshot 搬运保存意图供公共 View 解析；不可用档位/模型不能在到达 UI 前丢失。
        expect(frame.payload.snapshot.config).toMatchObject({
          provider,
          model,
          thought: "options" in stored ? (stored.options?.reasoningLevel ?? "") : "",
        });
        expect(legacyProviderResolveRequests).toHaveLength(0);
        expect(JSON.stringify(frame.payload.snapshot)).toContain("Existing history");
        expect(apps[0]?.runtime.getSessionModelSelection()).toBeUndefined();
        // 订阅成功不代表其他读取入口安全：未绑定会话还必须能生成严格协议快照。
        const read = await server.handleMessage({
          id: "read-unbound",
          method: zcodeProtocolMethods.sessionRead,
          params: { sessionId: sessionID },
        });
        expect(read).toHaveProperty("result");
        if (!read || !("result" in read)) throw new Error("Expected session/read result");
        const snapshot = zcodeSessionStateSnapshotSchema.parse(read.result);
        expect(snapshot.session.model).toBeUndefined();
        expect(snapshot.settings.model.current).toBeUndefined();
        expect(snapshot.settings.model.lastUsed).toBeUndefined();
        expect(JSON.stringify(snapshot.messages)).toContain("Existing history");
        const expectedStored =
          "providerId" in stored && stored.providerId?.startsWith("builtin:")
            ? { ...stored, providerId: provider }
            : stored;
        expect(
          (await store.sessionEntries({ sessionID, type: SESSION_ENTRY_MODEL_SELECTION })).at(-1)
            ?.data,
        ).toEqual(expectedStored);
        const forked = await server.handleMessage({
          id: "fork-unbound",
          method: zcodeProtocolMethods.sessionFork,
          params: { sessionId: sessionID, target: { kind: "message", messageId: messageID } },
        });
        expect(forked, JSON.stringify(forked)).toHaveProperty("result");
        if (!forked || !("result" in forked)) throw new Error("Expected fork result");
        const forkSnapshot = zcodeSessionForkResultSchema.parse(forked.result).snapshot;
        expect(forkSnapshot.settings.model.current).toBeUndefined();
        expect(forkSnapshot.session.parentSessionId).toBe(sessionID);
      } finally {
        for (const app of apps) await app.close();
        await fixture.dispose();
      }
    });
  },
);
