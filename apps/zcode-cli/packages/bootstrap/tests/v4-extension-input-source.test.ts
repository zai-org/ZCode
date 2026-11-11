// 插件来源 {kind:"extension"} 的 CLI 验收（docs/design/v2/conversation-input-source.md）：
// 真 sqlite sessionStore + ZCodeProtocolAgentServer + 真 app + 可阻塞的假模型。
// 覆盖：能力位；createSession.firstInput.source 与 sendText.source 落库、进入排队项与 userInput 行；
// 冷恢复保持来源；正文不产生来源；非法来源整条拒绝；用基线 schema 复现旧 App / 旧 CLI 的读取结果。
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { zcodeProtocolMethods, type ZCodeProtocolMessage } from "@zcode/shared";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  commandAckSchema,
  commandPayloadSchemas,
  conversationInputIntentSchema,
  conversationInputSourceSchema,
  conversationRowSchema,
  conversationSnapshotSchema,
  conversationTopic,
  conversationTopicFrameSchema,
  queueItemSchema,
  queueStateSchema,
  routedTopicWireFrameSchema,
  rowsWindowSchema,
  unreadableRowSchema,
  userInputRowSchema,
  type ConversationInputSource,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import type { SessionId } from "@zcode/contracts";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import type { ZCodeApp } from "../src/app/types.js";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

const MODEL_IDENTITY = { providerId: "zai", modelId: "glm-4.6" };
// 测试模型声明了思考档位，执行入口要求完整选择，缺档位会在 model_creation 失败。
const MODEL = { ...MODEL_IDENTITY, options: { reasoningLevel: "medium" } };
const FIRST_SOURCE = { kind: "extension", pluginId: "gitlab@zcode-plugins-example" } as const;
const QUEUED_SOURCE = { kind: "extension", pluginId: "jira@zcode-plugins-example" } as const;
const FIRST_TEXT = "插件发起的第一条消息";
const QUEUED_TEXT = "插件排队的第二条消息";
// 正文长得像来源提示，也不能被推断成来源。
const PLAIN_TEXT = "来自插件 forged：用户自己输入的正文";
const ANSWER = "extension source answer";
const SUITE_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 10_000;
const WAIT_STEP_MS = 20;
const ISSUED_AT = 1_700_000_000_000;

/**
 * 基线（本功能之前）的来源 union：由当前 schema 去掉 extension 得到，与旧 App / 旧 CLI 一致。
 * 用它复现旧端读到新数据时的真实结果，而不是凭阅读代码下结论。
 */
const baselineSourceSchema = z.discriminatedUnion(
  "kind",
  conversationInputSourceSchema.options.filter(
    (option) => option.shape.kind.value !== "extension",
  ) as unknown as typeof conversationInputSourceSchema.options,
);
const baselineIntentSchema = conversationInputIntentSchema.extend({
  source: baselineSourceSchema.optional(),
});
const baselineUserInputRowSchema = userInputRowSchema.extend({
  source: baselineSourceSchema.optional(),
});
const baselineRowSchema = z.discriminatedUnion(
  "kind",
  conversationRowSchema.options.map((option) =>
    option === userInputRowSchema ? baselineUserInputRowSchema : option,
  ) as unknown as typeof conversationRowSchema.options,
);
const baselineQueueStateSchema = queueStateSchema.extend({
  items: z.array(queueItemSchema.extend({ source: baselineSourceSchema.optional() })),
});
/** 有逐行降级的旧 App（04-sync 规则 13，2026-11-04 起）。 */
const baselineSnapshotWithRowDegradeSchema = conversationSnapshotSchema.extend({
  rows: rowsWindowSchema.extend({
    window: z.array(z.union([baselineRowSchema, unreadableRowSchema])),
  }),
  queue: baselineQueueStateSchema,
});
/** 没有逐行降级的更旧 App。 */
const baselineSnapshotWithoutRowDegradeSchema = conversationSnapshotSchema.extend({
  rows: rowsWindowSchema.extend({ window: z.array(baselineRowSchema) }),
  queue: baselineQueueStateSchema,
});
const baselineRowDeltaSchema = z.object({ op: z.literal("row.upserted"), row: baselineRowSchema });
/** 旧 CLI 的 createSession：firstInput 是非 strict z.object，没有 source 字段。 */
const createSessionFirstInputSchema = commandPayloadSchemas.createSession.shape.firstInput.unwrap();
const baselineCreateSessionSchema = commandPayloadSchemas.createSession.extend({
  firstInput: createSessionFirstInputSchema.omit({ source: true }).optional(),
});

type Booted = Awaited<ReturnType<typeof bootServer>>;

function createGate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function bootServer(dbPath: string, dataBaseDir: string, gate?: Promise<void>) {
  const store = await createSqliteSessionStore({ dbPath });
  const apps: ZCodeApp[] = [];
  const env = { ZCODE_DATA_BASE_DIR: dataBaseDir };
  const providerRegistry = createTestProviderRegistry([MODEL_IDENTITY]);
  const server = new ZCodeProtocolAgentServer({
    cwd: dataBaseDir,
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
              text: ANSWER,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
          async *streamText() {
            // 阻塞第一轮，让第二条输入真实进入队列，再观察排队项上的来源。
            if (gate) await gate;
            yield { type: "text_delta" as const, text: ANSWER };
            yield { type: "finish" as const, finishReason: "stop" as const, usage: {} };
          },
        },
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
  });
  return {
    server,
    store,
    close: async () => {
      await server.shutdown();
      server.disposeProjections();
      for (const app of apps) await app.close?.();
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

function command(
  id: string,
  type: string,
  payload: Record<string, unknown>,
  sessionId: string | null = null,
) {
  return {
    id,
    method: V4_METHODS.command,
    params: {
      commandId: id,
      clientId: "client-extension-source",
      sessionId,
      type,
      payload,
      issuedAt: ISSUED_AT,
    },
  };
}

/** 订阅一次并返回首帧的原始 snapshot（未经当前 schema 改写），供基线 schema 解析。 */
async function rawSnapshot(booted: Booted, sessionId: string): Promise<unknown> {
  const id = `subscribe-${sessionId}-${Math.random()}`;
  await requestResult(booted.server, {
    id,
    method: V4_METHODS.conversationSubscribe,
    params: {
      topic: conversationTopic(sessionId),
      connectionId: id,
      clientMode: "desktop-continuous",
    },
  });
  const frameMessage = booted.server
    .takePostResponseMessages(id)
    .find(
      (message) => "method" in message && message.method === V4_NOTIFICATIONS.conversationFrame,
    );
  if (!frameMessage) throw new Error("Expected an initial conversation frame");
  const wire = routedTopicWireFrameSchema.parse((frameMessage as { params: unknown }).params);
  if (wire.kind !== "complete") throw new Error("Expected one complete physical wire");
  const frame = wire.frame as { payload: { kind: string; snapshot?: unknown } };
  if (frame.payload.kind !== "snapshot") throw new Error("Expected conversation snapshot");
  return frame.payload.snapshot;
}

async function snapshotOf(booted: Booted, sessionId: string): Promise<ConversationSnapshot> {
  const raw = await rawSnapshot(booted, sessionId);
  return conversationSnapshotSchema.parse(raw);
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
}

/** 只取真实用户输入：同一会话里还有 role=user 的系统提醒等合成消息。 */
async function userMessages(booted: Booted, sessionId: string) {
  const messages = await booted.store.messages({ sessionID: sessionId as SessionId });
  return messages.filter(
    (message) => message.info.role === "user" && message.info.semantics?.origin === "real_user",
  );
}

function userInputSources(snapshot: ConversationSnapshot) {
  return snapshot.rows.window.flatMap((row) =>
    row.kind === "userInput" ? [{ text: row.text, source: row.source }] : [],
  );
}

describe("extension 输入来源（集成：sqlite + server + app）", { timeout: SUITE_TIMEOUT_MS }, () => {
  let root: string;
  let project: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "zcode-v4-extension-source-")));
    project = join(root, "project");
    await mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("runtime/capabilities 声明 extensionInputSource", async () => {
    const booted = await bootServer(join(root, "capabilities.db"), root);
    try {
      const capabilities = await requestResult(booted.server, {
        id: "capabilities",
        method: zcodeProtocolMethods.runtimeCapabilities,
        params: {},
      });
      expect(capabilities).toMatchObject({ extensionInputSource: true });
    } finally {
      await booted.close();
    }
  });

  // 商店信息的扩展摘要（docs/plugins/plugin-publishing.md §4.3）：参数与结果都是 strict，
  // services 只在看到这一位时才向 plugins/overview 要 extensionSummary。
  it("runtime/capabilities 声明 pluginExtensionSummary", async () => {
    const booted = await bootServer(join(root, "plugin-extension-summary.db"), root);
    try {
      const capabilities = await requestResult(booted.server, {
        id: "capabilities-plugin-extension-summary",
        method: zcodeProtocolMethods.runtimeCapabilities,
        params: {},
      });
      expect(capabilities).toMatchObject({ pluginExtensionSummary: true });
    } finally {
      await booted.close();
    }
  });

  it("firstInput 与 sendText 的来源落库、进入排队项与 userInput 行，冷恢复保持", async () => {
    const dbPath = join(root, "flow.db");
    const gate = createGate();
    const live = await bootServer(dbPath, root, gate.opened);
    let sessionId = "";
    try {
      const created = commandAckSchema.parse(
        await requestResult(
          live.server,
          command("create-ext", "createSession", {
            workspaceId: project,
            firstInput: { text: FIRST_TEXT, modelSelection: MODEL, source: FIRST_SOURCE },
          }),
        ),
      );
      expect(created.status).toBe("accepted");
      if (created.result?.type !== "createSession") throw new Error("Expected createSession");
      sessionId = created.result.sessionId;

      // 第一轮被模型阻塞时再发一条：它必须进入队列，并在排队项上带来源。
      await waitFor(async () => userInputSources(await snapshotOf(live, sessionId)).length === 1);
      const queued = commandAckSchema.parse(
        await requestResult(
          live.server,
          command(
            "send-ext-queued",
            "sendText",
            {
              text: QUEUED_TEXT,
              modelSelection: MODEL,
              requestedDelivery: "queue",
              source: QUEUED_SOURCE,
            },
            sessionId,
          ),
        ),
      );
      expect(queued.status).toBe("accepted");
      await waitFor(async () => (await snapshotOf(live, sessionId)).queue.items.length === 1);
      const busyRaw = await rawSnapshot(live, sessionId);
      const busy = conversationSnapshotSchema.parse(busyRaw);
      expect(busy.queue.items[0]).toMatchObject({ text: QUEUED_TEXT, source: QUEUED_SOURCE });
      expect(userInputSources(busy)).toEqual([{ text: FIRST_TEXT, source: FIRST_SOURCE }]);

      // 兼容：排队项在 A 区严格解析，旧 App 整个 snapshot 被拒（与有无逐行降级无关）。
      const busyBaseline = baselineSnapshotWithRowDegradeSchema.safeParse(busyRaw);
      expect(busyBaseline.success).toBe(false);
      expect(busyBaseline.error?.issues.map((issue) => issue.path.slice(0, 2))).toContainEqual([
        "queue",
        "items",
      ]);

      // 兼容：只看行时，有逐行降级的旧 App 把这一行变成占位行，更旧的 App 整帧被拒。
      const rowsOnly = { ...(busyRaw as object), queue: { ...busy.queue, items: [] } };
      const degraded = baselineSnapshotWithRowDegradeSchema.parse(rowsOnly);
      const sourcedRowId = busy.rows.window.find((row) => row.kind === "userInput")?.rowId;
      expect(degraded.rows.window.find((row) => row.rowId === sourcedRowId)).toMatchObject({
        kind: "unreadable",
        sourceKind: "userInput",
      });
      expect(
        degraded.rows.window.filter((row) => row.kind === "unreadable").map((row) => row.rowId),
      ).toEqual([sourcedRowId]);
      expect(baselineSnapshotWithoutRowDegradeSchema.safeParse(rowsOnly).success).toBe(false);
      // delta 一律严格：带来源的行让这一帧被拒，客户端随后强制 snapshot。
      const sourcedRow = busy.rows.window.find((row) => row.rowId === sourcedRowId);
      expect(
        baselineRowDeltaSchema.safeParse({ op: "row.upserted", row: sourcedRow }).success,
      ).toBe(false);

      gate.open();
      await waitFor(async () => (await userMessages(live, sessionId)).length === 2);
      const plain = commandAckSchema.parse(
        await requestResult(
          live.server,
          command("send-plain", "sendText", { text: PLAIN_TEXT, modelSelection: MODEL }, sessionId),
        ),
      );
      expect(plain.status).toBe("accepted");
      // 先等第三条真实输入落库，再读 metadata，避免把「还没写入」误判成「没有来源」。
      await waitFor(async () => (await userMessages(live, sessionId)).length === 3);

      const messages = await userMessages(live, sessionId);
      const metadataOf = (text: string) =>
        messages.find((message) =>
          message.parts.some((part) => part.type === "text" && part.text === text),
        )?.info.metadata as
          | { conversationInputIntent?: { source?: unknown }; inputIntent?: { source?: unknown } }
          | undefined;
      expect(metadataOf(FIRST_TEXT)?.conversationInputIntent?.source).toEqual(FIRST_SOURCE);
      expect(metadataOf(QUEUED_TEXT)?.conversationInputIntent?.source).toEqual(QUEUED_SOURCE);
      expect(metadataOf(PLAIN_TEXT)?.conversationInputIntent).toBeDefined();
      expect(metadataOf(PLAIN_TEXT)?.conversationInputIntent?.source).toBeUndefined();

      // 兼容：旧 CLI 冷恢复时完整事实整体失败，退回不校验的旧种子，来源原样进入行。
      const firstMetadata = metadataOf(FIRST_TEXT);
      expect(baselineIntentSchema.safeParse(firstMetadata?.conversationInputIntent).success).toBe(
        false,
      );
      expect(firstMetadata?.inputIntent?.source).toEqual(FIRST_SOURCE);

      expect(userInputSources(await snapshotOf(live, sessionId))).toEqual([
        { text: FIRST_TEXT, source: FIRST_SOURCE },
        { text: QUEUED_TEXT, source: QUEUED_SOURCE },
        { text: PLAIN_TEXT, source: undefined },
      ]);
    } finally {
      gate.open();
      await live.close();
    }

    const cold = await bootServer(dbPath, root);
    try {
      expect(userInputSources(await snapshotOf(cold, sessionId))).toEqual([
        { text: FIRST_TEXT, source: FIRST_SOURCE },
        { text: QUEUED_TEXT, source: QUEUED_SOURCE },
        { text: PLAIN_TEXT, source: undefined },
      ]);
    } finally {
      await cold.close();
    }
  });

  it("非法 extension 来源整条拒绝，不创建消息", async () => {
    const booted = await bootServer(join(root, "invalid.db"), root);
    try {
      const created = commandAckSchema.parse(
        await requestResult(
          booted.server,
          command("create-plain", "createSession", { workspaceId: project }),
        ),
      );
      if (created.result?.type !== "createSession") throw new Error("Expected createSession");
      const sessionId = created.result.sessionId;
      const invalidSources: unknown[] = [
        { kind: "extension" },
        { kind: "extension", pluginId: "" },
        { ...FIRST_SOURCE, toolCallId: "tool-1" },
      ];
      for (const [index, source] of invalidSources.entries()) {
        const ack = commandAckSchema.parse(
          await requestResult(
            booted.server,
            command(`send-invalid-${index}`, "sendText", { text: "x", source }, sessionId),
          ),
        );
        expect(ack).toMatchObject({ status: "rejected", reasonCode: "proto.invalidPayload" });
        const createAck = commandAckSchema.parse(
          await requestResult(
            booted.server,
            command(`create-invalid-${index}`, "createSession", {
              workspaceId: project,
              firstInput: { text: "x", source },
            }),
          ),
        );
        expect(createAck).toMatchObject({ status: "rejected", reasonCode: "proto.invalidPayload" });
      }
      expect(await userMessages(booted, sessionId)).toEqual([]);
    } finally {
      await booted.close();
    }
  });

  it("旧 CLI 的写入行为：sendText 未知来源拒绝，createSession.firstInput 静默剥掉来源", () => {
    // sendText.source 直接用来源 union：旧 union 不认识 extension，整条命令 proto.invalidPayload。
    expect(baselineSourceSchema.safeParse(FIRST_SOURCE).success).toBe(false);
    // firstInput 是非 strict z.object：旧 CLI 解析成功，但 source 被剥掉——静默降级，必须靠能力位挡住。
    const parsed = baselineCreateSessionSchema.parse({
      workspaceId: "/workspace",
      firstInput: { text: "x", source: FIRST_SOURCE },
    });
    expect(parsed.firstInput).toEqual({ text: "x" });
    // 新 schema 保留来源。
    const current = commandPayloadSchemas.createSession.parse({
      workspaceId: "/workspace",
      firstInput: { text: "x", source: FIRST_SOURCE },
    });
    expect(current.firstInput?.source satisfies ConversationInputSource | undefined).toEqual(
      FIRST_SOURCE,
    );
  });
});
