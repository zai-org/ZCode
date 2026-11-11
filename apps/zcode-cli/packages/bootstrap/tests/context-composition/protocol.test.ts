// v4/conversation/contextComposition 协议层集成（spec §4 第 3、5 类与协议验收）：
// 真 sqlite sessionStore + ZCodeProtocolAgentServer + 真 app。
// 规格：apps/zcode-cli/docs/design/v2/model/context-composition.md。
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { zcodeProtocolMethods, type ZCodeProtocolMessage } from "@zcode/shared";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  commandAckSchema,
  v4ConversationContextCompositionChangedSchema,
  v4ConversationContextCompositionResultSchema,
  type ContextCompositionChangedEvent,
} from "@zcode/shared/zcode-protocol-v4";
import type { SessionId } from "@zcode/contracts";
import { ZCodeProtocolAgentServer } from "../../src/zcode-protocol/server.js";
import type { ZCodeProtocolAgentServerContext } from "../../src/zcode-protocol/server-types.js";
import type { ZCodeApp } from "../../src/app/types.js";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "../helpers/registry-backed-test-app.js";

const MODEL = { providerId: "zai", modelId: "glm-4.6", options: { reasoningLevel: "low" } };

async function bootServer(root: string) {
  const store = await createSqliteSessionStore({ dbPath: join(root, "sessions.db") });
  const apps: ZCodeApp[] = [];
  const env = { ZCODE_DATA_BASE_DIR: join(root, "data"), HOME: root };
  const providerRegistry = createTestProviderRegistry([MODEL]);
  const notifications: ContextCompositionChangedEvent[] = [];
  const server = new ZCodeProtocolAgentServer({
    cwd: root,
    env,
    sessionStore: store,
    createZCodeApp: async (options = {}) => {
      const app = await createRegistryBackedTestApp({
        ...options,
        // 内置 MCP 子进程与本用例无关，关闭避免进程握手噪声。
        runtimeConfig: { ...options.runtimeConfig, mcp: { enabled: false } },
        env,
        skipUserConfig: true,
        providerRegistry,
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop" as const,
              text: "answer",
              usage: { inputTokens: 4_321, outputTokens: 3, totalTokens: 4_324 },
            };
          },
          async *streamText() {
            yield { type: "text_delta" as const, text: "answer" };
            yield {
              type: "finish" as const,
              finishReason: "stop" as const,
              usage: { inputTokens: 4_321, outputTokens: 3, totalTokens: 4_324 },
            };
          },
        },
      });
      apps.push(app);
      return app;
    },
  });
  server.setNotificationSink((message) => {
    if (
      "method" in message &&
      message.method === V4_NOTIFICATIONS.conversationContextCompositionChanged
    ) {
      notifications.push(v4ConversationContextCompositionChangedSchema.parse(message.params));
      return;
    }
    if (!("id" in message)) return;
    if (message.method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
      void server.handleMessage({
        id: message.id,
        result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false },
      });
    }
  });
  const context = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
  return {
    server,
    store,
    apps,
    context,
    notifications,
    close: async () => {
      await server.shutdown();
      server.disposeProjections();
      for (const app of apps) await app.close();
      store.close();
    },
  };
}

async function requestResult(server: ZCodeProtocolAgentServer, message: ZCodeProtocolMessage) {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

function command(id: string, type: string, payload: Record<string, unknown>) {
  return {
    id,
    method: V4_METHODS.command,
    params: {
      commandId: id,
      clientId: "client-context-composition",
      sessionId: null,
      type,
      payload,
      issuedAt: 1_700_000_000_000,
    },
  };
}

async function createSession(
  booted: Awaited<ReturnType<typeof bootServer>>,
  id: string,
  payload: Record<string, unknown>,
) {
  const ack = commandAckSchema.parse(
    await requestResult(booted.server, command(id, "createSession", payload)),
  );
  if (ack.result?.type !== "createSession") throw new Error("Expected createSession result");
  return ack.result.sessionId;
}

async function queryComposition(
  booted: Awaited<ReturnType<typeof bootServer>>,
  params: Record<string, unknown>,
) {
  return v4ConversationContextCompositionResultSchema.parse(
    await requestResult(booted.server, {
      id: `composition-${Math.random()}`,
      method: V4_METHODS.conversationContextComposition,
      params,
    }),
  ).composition;
}

const tokensOf = (
  composition: { categories: Array<{ id: string; tokens: number }> } | null,
  id: string,
) => composition?.categories.find((category) => category.id === id)?.tokens ?? 0;

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("v4 contextComposition protocol", { timeout: 30_000 }, () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "zcode-context-composition-")));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("previews a draft without promoting it and returns null for a session that is not in memory", async () => {
    const booted = await bootServer(root);
    try {
      const sessionId = await createSession(booted, "create-draft", { workspaceId: root });
      expect(booted.context.sessions.get(sessionId)?.persistence).toBe("deferred");

      const composition = await queryComposition(booted, { sessionId, modelSelection: MODEL });
      expect(composition).toMatchObject({
        sessionId,
        phase: "draft-preview",
        tokenMethod: "estimated",
        model: { providerId: MODEL.providerId, modelId: MODEL.modelId },
      });
      expect(tokensOf(composition, "system_prompt")).toBeGreaterThan(0);
      expect(tokensOf(composition, "system_tool_schemas")).toBeGreaterThan(0);
      expect(composition?.revision).toEqual(expect.any(Number));

      // 预演之后仍是草稿：record 未提升、runtime 未持久化、存储里没有会话行和消息。
      const record = booted.context.sessions.get(sessionId)!;
      expect(record.persistence).toBe("deferred");
      expect(record.app.runtime.isSessionPersisted()).toBe(false);
      expect(await booted.store.getSession(sessionId as SessionId)).toBeNull();
      expect(await booted.store.messages({ sessionID: sessionId as SessionId })).toEqual([]);

      expect(await queryComposition(booted, { sessionId: "sess_not_in_memory" })).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("returns the request composition after a turn and notifies on change", async () => {
    const booted = await bootServer(root);
    try {
      const sessionId = await createSession(booted, "create-with-input", {
        workspaceId: root,
        firstInput: { text: "hello", modelSelection: MODEL },
      });
      await waitFor(async () => {
        const messages = await booted.store.messages({ sessionID: sessionId as SessionId });
        return messages.some((message) => message.info.role === "assistant");
      });
      await waitFor(
        () => booted.context.sessions.get(sessionId)?.app.runtime.getActiveTurnInfo() === undefined,
      );

      const composition = await queryComposition(booted, { sessionId });
      expect(composition?.phase).toBe("request");
      expect(composition?.providerInputTokens).toBe(4_321);
      expect(composition?.providerContextTokens).toBe(4_324);
      expect(tokensOf(composition, "messages")).toBeGreaterThan(0);
      const forSession = () => booted.notifications.filter((item) => item.sessionId === sessionId);
      expect(forSession().length).toBeGreaterThan(0);
      expect(composition?.revision).toBe(forSession().at(-1)?.revision);

      // 换模型：tracker 发出更大的修订号，请求组成作废，查询改为预演。
      const before = forSession().at(-1)!.revision;
      await booted.context.sessions.get(sessionId)!.app.setModel(MODEL);
      await waitFor(() => (forSession().at(-1)?.revision ?? 0) > before);
      expect(forSession().at(-1)!.revision).toBe(before + 1);
      expect((await queryComposition(booted, { sessionId }))?.phase).toBe("draft-preview");
    } finally {
      await booted.close();
    }
  });
});
