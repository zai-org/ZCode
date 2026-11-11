import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import {
  createInMemorySessionEventStore,
  createNodeToolArtifactStore,
  createSqliteSessionStore,
} from "@zcode/adapters/storage";
import { createNodeWorkflowStore } from "@zcode/adapters/workflow";
import { DEFAULT_EXPERT_WORKFLOW_STRATEGY } from "@zcode/core";
import {
  createNodeProviderRuntimePathEnv,
  encodeProviderConfigFile,
  serializeZCodeBuiltinRelease,
} from "@zcode/provider-node";
import { ModelConfigRules, ProviderConfigMap, ProviderTemplateMap } from "@zcode/provider";
import { zcodeStorageStartupStateSchema } from "@zcode/shared";
import {
  LogLevel,
  SESSION_ENTRY_MODEL_SELECTION,
  type LogContext,
  type Logger,
  type LoggerFactory,
  SessionEventType,
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  type EnvInfo,
  type ExecutionPort,
  type ExecutionShellSelection,
  type TargetChangedPayload,
  type WorkflowRunSnapshot,
} from "@zcode/contracts";
import { resolveLatestSession, runZCodeProtocolAgent } from "../src/index.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";
import {
  createRegistryBackedTestApp as createZCodeApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";
import { readLogEntries } from "./session-persistence-fixture.js";

import { createRecordingLoggerFactory } from "./session-persistence-fixture.js";

describe("session persistence", () => {
  // ZCT-2109847556412547072：deferred 会话首条消息前切模，真实 SQLite 外键拒绝 entry 写入；
  // 首次持久化必须以最新选择补写，且该已知时序不能以 warn 进入生产日志。
  it.each([undefined, "cli-default"] as const)(
    "defers a pre-first-prompt model switch to the first persistence (modelSelectionMode=%s)",
    async (modelSelectionMode) => {
      const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-deferred-selection-"));
      const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
      const sessionId = createSessionId("bootstrap-deferred-selection");
      const selectionLogs: Array<[string, unknown]> = [];
      const loggerFor = (context: LogContext = {}): Logger => {
        const record = (level: string) => (_message: string, logContext?: LogContext) => {
          const event = logContext?.event ?? context.event;
          if (typeof event === "string" && event.startsWith("session.model_selection."))
            selectionLogs.push([level, event]);
        };
        return {
          child: (childContext) => loggerFor({ ...context, ...childContext }),
          debug: record("debug"),
          error: (message, _error, logContext) => record("error")(message, logContext),
          info: record("info"),
          warn: record("warn"),
        };
      };
      const loggerFactory: LoggerFactory = {
        createLogger: () => loggerFor(),
        setLevel: () => {},
        withContext: (context) => loggerFor(context),
      };
      try {
        const app = await createZCodeApp({
          env: { ZCODE_STORAGE_DIR: tempRoot },
          loggerFactory,
          ...(modelSelectionMode ? { modelSelectionMode } : {}),
          modelExecutor: {
            async generateText() {
              return {
                finishReason: "stop",
                text: "done",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          } as never,
          providerRegistry: createTestProviderRegistry([{ providerId: "zai", modelId: "glm-4.7" }]),
          runtimeConfig: { workingDirectory: tempRoot },
          sessionId,
          sessionStore: store,
          skipUserConfig: true,
        });
        const readSelections = async () =>
          (
            (await store.sessionEntries?.({
              sessionID: sessionId,
              type: SESSION_ENTRY_MODEL_SELECTION,
            })) ?? []
          ).map((entry) => entry.data);

        // 与工单时序一致：会话刚创建、首条消息前 App 依次下发选型与思考档位。
        await app.setModel({
          providerId: "zai",
          modelId: "glm-4.7",
          options: { reasoningLevel: "high" },
        });
        await app.setThoughtLevel("low");
        expect(selectionLogs).toEqual([
          ["debug", "session.model_selection.persist_deferred"],
          ["debug", "session.model_selection.persist_deferred"],
        ]);
        expect(await store.getSession(sessionId)).toBeFalsy();

        await app.submitPrompt("hello");
        expect(await readSelections()).toEqual([
          { providerId: "zai", modelId: "glm-4.7", options: { reasoningLevel: "low" } },
        ]);

        // 会话持久化后改档位直接覆盖同一 entry，不再出现 deferred/failed 日志。
        selectionLogs.length = 0;
        await app.setThoughtLevel("deep");
        expect(selectionLogs).toEqual([]);
        expect(await readSelections()).toEqual([
          { providerId: "zai", modelId: "glm-4.7", options: { reasoningLevel: "deep" } },
        ]);
      } finally {
        store.close();
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it("persists Highspeed metadata in the user message data", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("highspeed-message-metadata");

    try {
      const app = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "accelerated answer",
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            };
          },
        } as never,
        runtimeConfig: { workingDirectory: process.cwd() },
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
      });
      const highspeed = {
        schemaVersion: 1 as const,
        ownerKey: `v1:${"a".repeat(64)}`,
        cardId: "hsc-1",
        taskId: sessionId,
        provider: "zai",
        model: "glm-5",
        issuedAt: 1_000,
        expiresAt: 10_000,
      };

      await app.submitPrompt("hello", {
        intent: {
          sourceCommandId: "command-highspeed-1",
          queueItemId: "queue-highspeed-1",
          clientId: "desktop-test",
          kind: "sendText",
          text: "hello",
          admissionSeq: 1,
          admittedAt: 1,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
          highspeed,
        } as never,
      });

      const messages = await store.messages({ sessionID: sessionId });
      // 首条 prompt 之前是内置 design 插件 SessionStart hook 的隐藏提醒，要找的是用户输入行。
      const userMessage = messages.find(
        (message) =>
          message.info.role === "user" && message.info.semantics?.kind !== "system_reminder",
      );
      expect(userMessage?.info.metadata?.highspeed).toEqual(highspeed);
    } finally {
      store.close();
    }
  });

  it("primes image and cold-rebuilds image and video paths from durable artifacts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-prompt-image-cache-"));
    const artifactRootDir = join(tempRoot, "artifacts");
    const imageCacheRootDir = join(tempRoot, "image-cache");
    const videoCacheRootDir = join(tempRoot, "video-cache");
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const artifactStore = createNodeToolArtifactStore({
      imageCacheRootDir,
      rootDir: artifactRootDir,
      videoCacheRootDir,
    });
    const primeSpy = vi.spyOn(artifactStore, "primeMediaAttachmentPath");

    try {
      const app = await createZCodeApp({
        artifactStore,
        env: {},
        runtimeConfig: { workingDirectory: process.cwd() },
        sessionStore,
        skipUserConfig: true,
      });
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

      const imageAttachment = await app.writePromptAttachment({
        bytes,
        fileName: "pasted.png",
        mime: "image/png",
      });
      const videoBytes = Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
      const videoAttachment = await app.writePromptAttachment({
        bytes: videoBytes,
        fileName: "clip.mp4",
        mime: "video/mp4",
      });

      expect(imageAttachment.ref).toMatch(/^zcode-artifact:\/\//u);
      expect(videoAttachment.ref).toMatch(/^zcode-artifact:\/\//u);
      await vi.waitFor(() => expect(primeSpy).toHaveBeenCalledTimes(2));
      expect(primeSpy).toHaveBeenNthCalledWith(1, {
        bytes,
        mediaType: "image/png",
        uri: imageAttachment.ref,
      });
      expect(primeSpy).toHaveBeenNthCalledWith(2, {
        bytes: videoBytes,
        mediaType: "video/mp4",
        uri: videoAttachment.ref,
      });
      const primed = await artifactStore.ensureMediaAttachmentPath!({
        mediaType: "image/png",
        uri: imageAttachment.ref,
      });
      if (primed.status !== "ready") throw new Error("expected primed PNG image path");
      const videoPath = await artifactStore.ensureMediaAttachmentPath!({
        mediaType: "video/mp4",
        uri: videoAttachment.ref,
      });
      if (videoPath.status !== "ready") throw new Error("expected MP4 video path");
      await unlink(primed.path);
      await unlink(videoPath.path);
      await app.close?.();

      const coldStore = createNodeToolArtifactStore({
        imageCacheRootDir,
        rootDir: artifactRootDir,
        videoCacheRootDir,
      });
      const rebuilt = await coldStore.ensureMediaAttachmentPath!({
        mediaType: "image/png",
        uri: imageAttachment.ref,
      });
      if (rebuilt.status !== "ready") throw new Error("expected rebuilt PNG image path");
      expect(rebuilt.path).toBe(primed.path);
      await expect(readFile(rebuilt.path)).resolves.toEqual(Buffer.from(bytes));
      const rebuiltVideo = await coldStore.ensureMediaAttachmentPath!({
        mediaType: "video/mp4",
        uri: videoAttachment.ref,
      });
      if (rebuiltVideo.status !== "ready") throw new Error("expected rebuilt MP4 video path");
      expect(rebuiltVideo.path).toBe(videoPath.path);
      await expect(readFile(rebuiltVideo.path)).resolves.toEqual(Buffer.from(videoBytes));
    } finally {
      sessionStore.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("previews the exact persisted media artifact before a mutable original path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-sent-media-preview-"));
    const originalPath = join(tempRoot, "same.mov");
    const artifactStore = createNodeToolArtifactStore({
      imageCacheRootDir: join(tempRoot, "image-cache"),
      rootDir: join(tempRoot, "artifacts"),
      videoCacheRootDir: join(tempRoot, "video-cache"),
    });
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("sent-media-preview");
    const messageId = createMessageId();
    const persistedBytes = Uint8Array.from([1, 2, 3, 4]);
    const changedOriginalBytes = Uint8Array.from([9, 8, 7, 6]);
    let app: Awaited<ReturnType<typeof createZCodeApp>> | undefined;

    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("sent-media-preview-project"),
        slug: "sent-media-preview",
        directory: tempRoot,
        title: "Sent media preview",
        version: "test",
      });
      await writeFile(originalPath, changedOriginalBytes);
      app = await createZCodeApp({
        artifactStore,
        bootstrapModelConfig: {
          main: {
            apiKeyRequired: false,
            baseURL: "https://api.example.test/anthropic",
            kind: "anthropic",
            model: "agent-model",
            provider: "custom-provider",
          },
        },
        env: {},
        runtimeConfig: { workingDirectory: tempRoot },
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
      });
      const artifact = await app.writePromptAttachment({
        bytes: persistedBytes,
        fileName: "same.mov",
        mime: "video/quicktime",
      });
      await store.saveMessage({
        id: messageId,
        sessionID: sessionId,
        role: "user",
        time: { created: Date.now() },
        agent: "zcode-agent",
        model: { providerID: "custom-provider", modelID: "agent-model" },
      });
      await store.savePart({
        id: createPartId(),
        sessionID: sessionId,
        messageID: messageId,
        type: "file",
        filename: "same.mov",
        mime: "video/quicktime",
        url: artifact.ref,
        source: {
          type: "file",
          path: originalPath,
          text: { value: originalPath, start: 0, end: originalPath.length },
        },
        metadata: {
          artifactUri: artifact.ref,
          originalUrl: originalPath,
          recoverability: "provider_ready",
          storageKind: "artifact",
        },
      });
      const messagesSpy = vi.spyOn(store, "messages");

      const previewSource = await app.resolvePromptAttachmentPreviewSource({
        ref: originalPath,
        mime: "video/quicktime",
        messageId,
        attachmentIndex: 0,
      });
      expect(previewSource).toMatchObject({
        kind: "local_path",
        mediaType: "video/quicktime",
      });
      if (previewSource.kind !== "local_path") throw new Error("expected local artifact path");
      expect(previewSource.path).toContain(join(tempRoot, "video-cache"));
      await expect(readFile(previewSource.path)).resolves.toEqual(Buffer.from(persistedBytes));

      await expect(
        app.readPromptAttachment({
          ref: originalPath,
          mime: "video/quicktime",
          maxBytes: 1024,
          messageId,
          attachmentIndex: 0,
        }),
      ).resolves.toEqual({
        bytes: Buffer.from(persistedBytes),
        mediaType: "video/quicktime",
      });
      expect(messagesSpy).not.toHaveBeenCalled();
      await expect(
        app.readPromptAttachment({
          ref: originalPath,
          mime: "video/quicktime",
          maxBytes: 1024,
        }),
      ).resolves.toEqual({
        bytes: Buffer.from(changedOriginalBytes),
        mediaType: "video/quicktime",
      });

      const ensurePath = vi
        .spyOn(artifactStore, "ensureMediaAttachmentPath")
        .mockRejectedValueOnce(new Error("derived path unavailable"));
      await expect(
        app.resolvePromptAttachmentPreviewSource({
          ref: originalPath,
          mime: "video/quicktime",
          messageId,
          attachmentIndex: 0,
        }),
      ).resolves.toEqual({ kind: "chunked" });
      expect(ensurePath).toHaveBeenCalledWith({
        mediaType: "video/quicktime",
        uri: artifact.ref,
      });
    } finally {
      await app?.close?.();
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("filters skills disabled through skills path config during app startup", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-skill-disable-"));
    const configPath = join(tempRoot, "config.json");
    const enabledSkillPath = join(
      tempRoot,
      ".zcode",
      "skills",
      "enabled-runtime-skill",
      "SKILL.md",
    );
    const disabledSkillPath = join(
      tempRoot,
      ".zcode",
      "skills",
      "disabled-runtime-skill",
      "SKILL.md",
    );
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const requests: Array<Array<{ content: unknown; role: string }>> = [];
    let app: Awaited<ReturnType<typeof createZCodeApp>> | undefined;

    try {
      await mkdir(dirname(enabledSkillPath), { recursive: true });
      await mkdir(dirname(disabledSkillPath), { recursive: true });
      await writeFile(
        enabledSkillPath,
        [
          "---",
          "name: enabled-runtime-skill",
          "description: Runtime enabled test skill",
          "---",
          "Use this skill only in the runtime enabled test.",
        ].join("\n"),
      );
      await writeFile(
        disabledSkillPath,
        [
          "---",
          "name: disabled-runtime-skill",
          "description: Runtime disabled test skill",
          "---",
          "Use this skill only in the runtime disabled test.",
        ].join("\n"),
      );
      await writeFile(
        configPath,
        JSON.stringify({
          skills: {
            [disabledSkillPath]: { enable: false },
          },
        }),
      );

      app = await createZCodeApp({
        env: {
          HOME: tempRoot,
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          async generateText(request: { messages: Array<{ content: unknown; role: string }> }) {
            requests.push(request.messages);
            return {
              finishReason: "stop",
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        projectConfigPath: configPath,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-skill-disable"),
        sessionStore: store,
        skipUserConfig: true,
      });

      await app.submitPrompt("hello");

      const context = (requests.at(-1) ?? [])
        .map((message) =>
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        )
        .join("\n");
      expect(context).toContain("enabled-runtime-skill");
      expect(context).not.toContain("disabled-runtime-skill");
    } finally {
      await app?.close?.();
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("keeps UI locale out of the provider-visible prompt", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const requests: string[][] = [];

    try {
      const app = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText(request) {
            requests.push(request.messages.map((message) => String(message.content)));
            return {
              finishReason: "stop",
              text: "ok",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: process.cwd(),
        },
        sessionStore: store,
        skipUserConfig: true,
        uiDetectedLocale: "zh_CN.UTF-8",
        uiLocale: "auto",
      });

      await app.submitPrompt("hello");

      const firstRequest = requests[0]?.join("\n") ?? "";
      expect(app.getLocale()).toBe("zh-CN");
      expect(firstRequest).toContain("hello");
      // 修复原因：现行 prompt 合同已移除 legacy # Language，UI locale 只影响界面展示。
      expect(firstRequest).not.toContain("# Language");
      expect(firstRequest).not.toContain(
        "Respond in the primary language of the user's current prompt",
      );
      expect(firstRequest).not.toContain("Respond in Chinese");
      expect(firstRequest).not.toContain("Respond in zh-CN");
    } finally {
      store.close();
    }
  });

  it("persists UI locale changes through the app facade", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-locale-"));
    const configPath = join(tempRoot, "config.json");
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const requests: string[][] = [];

    try {
      const app = await createZCodeApp({
        env: {},
        modelExecutor: {
          async generateText(request) {
            requests.push(request.messages.map((message) => String(message.content)));
            return {
              finishReason: "stop",
              text: "ok",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionStore: store,
        uiLocale: "en-US",
        userConfigPath: configPath,
      });

      const result = await app.setLocale("zh-CN");
      const written = JSON.parse(await readFile(configPath, "utf-8"));

      expect(result.locale).toBe("zh-CN");
      expect(result.previousLocale).toBe("en-US");
      expect(result.requestedLocale).toBe("zh-CN");
      expect(app.getLocale()).toBe("zh-CN");
      expect(written.ui.locale).toBe("zh-CN");

      await app.submitPrompt("hello");

      const firstRequest = requests[0]?.join("\n") ?? "";
      expect(firstRequest).toContain("hello");
      // locale 持久化不应重新把 UI 语言投影到 provider-visible prompt。
      expect(firstRequest).not.toContain("# Language");
      expect(firstRequest).not.toContain(
        "Respond in the primary language of the user's current prompt",
      );
      expect(firstRequest).not.toContain("Respond in Chinese");
      expect(firstRequest).not.toContain("Respond in zh-CN");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists session.version from the injected app version", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-session-version-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionId = createSessionId("bootstrap-session-version");

    try {
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
        version: "9.8.7",
      });

      await app.submitPrompt("hello");

      const session = await store.getSession(sessionId);
      expect(session?.version).toBe("9.8.7");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists title metadata and prevents generated titles from overwriting custom titles", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("bootstrap-title-metadata");

    try {
      await store.createSession({
        id: sessionId,
        projectID: createProjectId("title-project"),
        slug: "title-session",
        directory: "/tmp/title-session",
        title: "Manual title",
        titleSource: "custom",
        version: "test",
      });

      const skipped = await store.updateSession({
        expectedTitleSources: ["default", "first_input", "generated"],
        id: sessionId,
        title: "Generated title",
        titleSource: "generated",
      });

      expect(skipped.title).toBe("Manual title");
      expect(skipped.titleSource).toBe("custom");

      const custom = await store.updateSession({
        expectedTitleSources: ["custom"],
        id: sessionId,
        title: "Renamed title",
        titleSource: "custom",
      });

      expect(custom.title).toBe("Renamed title");
      expect(custom.titleSource).toBe("custom");
      expect(custom.time.titleUpdated).toEqual(expect.any(Number));
    } finally {
      store.close();
    }
  });

  it("emits an idempotent target_changed clear event when no goal exists", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-idempotent-goal-clear-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const eventStore = createInMemorySessionEventStore();
    const store = await createSqliteSessionStore({ dbPath });

    try {
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        eventStore,
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-idempotent-goal-clear"),
        sessionStore: store,
        skipUserConfig: true,
      });

      const cleared = await app.clearTarget();
      const events = await eventStore.getEvents(app.sessionId);
      const targetChangedEvents = events.filter(
        (event) => event.type === SessionEventType.TargetChanged,
      );
      const payload = targetChangedEvents[0]?.payload as TargetChangedPayload | undefined;

      expect(cleared).toBe(false);
      expect(targetChangedEvents).toHaveLength(1);
      expect(payload).toEqual({
        action: "cleared",
        previousTarget: null,
        source: "command",
        target: null,
      });
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists a newly set goal objective as the visible user prompt", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-goal-visible-prompt-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const eventStore = createInMemorySessionEventStore();
    const store = await createSqliteSessionStore({ dbPath });
    const objective = "加一个地址系统，可以加，可以选";
    const displayText = `/target ${objective}`;
    const sourceCommandId = "command-goal-visible-prompt";
    const queueItemId = "queue-goal-visible-prompt";

    try {
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        eventStore,
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-goal-visible-prompt"),
        sessionStore: store,
        skipUserConfig: true,
      });

      await app.runtime.ensureSessionPersistedForExternalActivity(objective);
      await store.saveSessionInput({
        id: queueItemId,
        sessionID: app.sessionId,
        kind: "sendGoalCommand",
        delivery: "startNow",
        payload: { text: displayText },
      });
      const target = await app.setTarget({
        displayText,
        objective,
        intent: {
          sourceCommandId,
          queueItemId,
          clientId: "desktop-test",
          kind: "sendGoalCommand",
          text: objective,
          admissionSeq: 1,
          admittedAt: 1,
          requestedDelivery: "startNow",
          admittedDelivery: "startNow",
        },
      });
      const session = await store.getSession(app.sessionId);
      const messages = await store.messages({ sessionID: app.sessionId });
      const events = await eventStore.getEvents(app.sessionId);
      const targetChangedEvents = events.filter(
        (event) => event.type === SessionEventType.TargetChanged,
      );
      const goalMessage = messages[0];
      const goalMessageText = goalMessage?.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");

      expect(target.objective).toBe(objective);
      expect(session?.title).toBe(objective);
      expect(goalMessage?.info).toMatchObject({ role: "user" });
      expect(goalMessage?.info).not.toHaveProperty("source");
      expect(goalMessage?.info).not.toHaveProperty("synthetic");
      expect(goalMessage?.info).not.toHaveProperty("visibility");
      expect(goalMessageText).toBe(displayText);
      expect(goalMessage?.info.metadata?.conversationInputIntent).toMatchObject({
        kind: "sendGoalCommand",
        text: objective,
      });
      expect(goalMessage?.info.metadata?.executionKind).toBe("controlOnly");
      const liveProjection = new ProductProjection(app.sessionId, "goal-live");
      for (const event of events) liveProjection.applyEvent(event);
      const coldProjection = new ProductProjection(app.sessionId, "goal-cold");
      for (const event of synthesizeEventsFromMessages(messages, { sessionId: app.sessionId })) {
        coldProjection.applyEvent(event);
      }
      const visibleGoalRows = (projection: ProductProjection) =>
        projection
          .getSnapshot()
          .rows.window.filter((row) => row.kind === "userInput")
          .map((row) => (row.kind === "userInput" ? row.text : ""));
      // 回归：/goal 首轮必须随 live 事件立即出现；cold hydration 复用同一条原始文本，
      // 不能只在重启后显示，也不能退化成解析后的 objective。
      expect(visibleGoalRows(liveProjection)).toEqual([displayText]);
      expect(visibleGoalRows(coldProjection)).toEqual([displayText]);
      const visibleGoalHeader = (projection: ProductProjection) =>
        projection
          .getSnapshot()
          .rows.window.find(
            (row) => row.kind === "turnHeader" && row.turnId === String(goalMessage?.info.id),
          );
      expect(visibleGoalHeader(liveProjection)).toMatchObject({
        executionKind: "controlOnly",
        state: "completedSuccess",
      });
      expect(visibleGoalHeader(coldProjection)).toMatchObject({
        executionKind: "controlOnly",
        state: "completedSuccess",
      });
      expect(visibleGoalHeader(liveProjection)).not.toHaveProperty("activeMs");
      expect(
        liveProjection.resolveEditTargetByEntityId(String(goalMessage?.info.id)).intent,
      ).toMatchObject({ kind: "sendGoalCommand", text: objective });
      const commandTargetChangedEvent = targetChangedEvents.find(
        (event) => (event.payload as TargetChangedPayload).source === "command",
      );
      expect(commandTargetChangedEvent?.payload).toMatchObject({
        action: "set",
        source: "command",
        target: expect.objectContaining({ objective }),
      });
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reads the Bash shell setting when a goal-only first input starts the session", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-goal-shell-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const hostSelection: ExecutionShellSelection = {
      dialect: "posix",
      display: { name: "bash" },
      id: "user:/bin/bash",
      label: "bash",
      path: "/bin/bash",
      source: "user-config",
    };
    const resolveInitialBashShellSelection = vi.fn(async () => hostSelection);

    try {
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        resolveInitialBashShellSelection,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-goal-shell-snapshot"),
        sessionStore: store,
        skipUserConfig: true,
      });

      await app.setTarget({ objective: "goal-only first input" });

      // /goal 不走普通 prompt 提交，也必须经过统一用户执行边界读取 shell 设置。
      expect(resolveInitialBashShellSelection).toHaveBeenCalledTimes(1);
      expect(app.runtime.getSessionShellSelection()).toEqual(hostSelection);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists replacement goal objective as real user prompt without state reminders", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-goal-replace-hidden-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const eventStore = createInMemorySessionEventStore();
    const store = await createSqliteSessionStore({ dbPath });
    const initialObjective = "加一个地址系统，可以加，可以选";
    const replacementObjective = "改成只支持默认地址";
    const initialDisplayText = `/goal ${initialObjective}`;
    const replacementDisplayText = `/GoAl replace ${replacementObjective}`;

    try {
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        eventStore,
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-goal-replace-hidden"),
        sessionStore: store,
        skipUserConfig: true,
      });

      await app.setTarget({
        displayText: initialDisplayText,
        objective: initialObjective,
        status: "active",
      });
      const replacedTarget = await app.setTarget({
        displayText: replacementDisplayText,
        objective: replacementObjective,
        status: "active",
      });
      const messages = await store.messages({ sessionID: app.sessionId });
      const realUserMessages = messages.filter(
        (message) => message.info.role === "user" && message.info.synthetic !== true,
      );
      const goalStateReminderMessages = messages.filter(
        (message) =>
          message.info.role === "user" &&
          message.info.synthetic === true &&
          message.info.source === "goal_state_change",
      );
      const targetChangedEvents = (await eventStore.getEvents(app.sessionId)).filter(
        (event) => event.type === SessionEventType.TargetChanged,
      );
      const commandTargetChangedEvents = targetChangedEvents.filter(
        (event) => (event.payload as TargetChangedPayload).source === "command",
      );
      const userMessageTexts = realUserMessages.map((message) =>
        message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
      );
      const reminderTexts = goalStateReminderMessages.map((message) =>
        message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
      );

      expect(replacedTarget.objective).toBe(replacementObjective);
      expect(userMessageTexts).toEqual([initialDisplayText, replacementDisplayText]);
      expect(reminderTexts).toEqual([]);
      expect(commandTargetChangedEvents).toHaveLength(2);
      expect(commandTargetChangedEvents[1]?.payload).toMatchObject({
        action: "set",
        previousTarget: expect.objectContaining({ objective: initialObjective }),
        source: "command",
        target: expect.objectContaining({ objective: replacementObjective }),
      });
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists model-only goal state change reminders for goal lifecycle changes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-goal-state-reminders-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });

    try {
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-goal-state-reminders"),
        sessionStore: store,
        skipUserConfig: true,
      });

      await app.setTarget({ objective: "ship the first goal" });
      await app.updateTargetStatus("paused");
      await app.updateTargetStatus("paused");
      await app.setTarget({ objective: "ship the replacement goal", status: "active" });
      await app.clearTarget();

      const messages = await store.messages({ sessionID: app.sessionId });
      const reminderParts = messages.flatMap((message) =>
        message.parts
          .filter(
            (part) =>
              part.type === "text" &&
              part.synthetic === true &&
              part.metadata?.source === "goal_state_change",
          )
          .map((part) => ({ message, part })),
      );

      expect(reminderParts.map(({ part }) => part.text)).toEqual([
        "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.",
        "The session goal is active again and will be pursued.",
        "The session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.",
      ]);
      for (const { message, part } of reminderParts) {
        expect(message.info).toMatchObject({
          role: "user",
          source: "goal_state_change",
          synthetic: true,
          visibility: "model-only",
        });
        expect(part.metadata).toMatchObject({
          runtimeMessage: { source: "goal_state_change" },
          source: "goal_state_change",
          visibility: "model-only",
        });
      }
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the current model for new expert workflow child sessions after a model switch", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-workflow-model-switch-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const requestModels: string[] = [];

    try {
      let switched = false;
      let app: Awaited<ReturnType<typeof createZCodeApp>>;
      app = await createZCodeApp({
        configuredDefaultModelSelection: {
          providerId: "zai",
          modelId: "glm-main",
          options: { reasoningLevel: "high" },
        },
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          setModelIoFullRetentionEnabled() {},
          async generateText(
            _request: unknown,
            execution: { model: { modelId: string; providerId: string } },
          ) {
            requestModels.push(`${execution.providerId}/${execution.modelId}`);
            if (!switched) {
              switched = true;
              await app.setModel("deepseek/deepseek-v4-pro");
              await app.setThoughtLevel("high");
            }
            return {
              finishReason: "stop",
              text: JSON.stringify({
                reasoning: "ok",
                verdict: "pass",
              }),
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        providerRegistry: createTestProviderRegistry([
          { providerId: "zai", modelId: "glm-main" },
          { providerId: "deepseek", modelId: "deepseek-v4-pro" },
        ]),
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-workflow-model-switch"),
        sessionStore: store,
        skipUserConfig: true,
      });

      const result = await app.runExpertWorkflow({
        task: "verify workflow model switching",
      });

      expect(result.status).toBe("completed");
      expect(requestModels[0]).toBe("zai/glm-main");
      expect(requestModels.slice(1)).toContain("deepseek/deepseek-v4-pro");
      expect(result.snapshot?.sessionLinks.map((link) => link.model)).toContain(
        "deepseek/deepseek-v4-pro",
      );
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("initializes the Bash shell before direct expert workflow child sessions", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-workflow-shell-"));
    const configPath = join(tempRoot, "config.json");
    const shellDir = join(tempRoot, "bin");
    const zshPath = join(shellDir, "zsh");
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const requestTexts: string[] = [];

    try {
      await mkdir(shellDir, { recursive: true });
      await writeFile(zshPath, "#!/bin/sh\n");
      await chmod(zshPath, 0o755);
      await writeFile(
        configPath,
        JSON.stringify({
          provider: {
            zai: {
              kind: "openai-compatible",
              options: {
                apiKey: "zai-secret",
                baseURL: "https://api.z.ai/api/coding/v1",
              },
              models: {
                "glm-main": {},
              },
            },
          },
          model: "zai/glm-main",
        }),
      );

      const app = await createZCodeApp({
        env: {
          PATH: shellDir,
          SHELL: join(shellDir, "fish"),
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          setModelIoFullRetentionEnabled() {},
          async generateText(request: { messages: Array<{ content: unknown }> }) {
            requestTexts.push(JSON.stringify(request.messages));
            return {
              finishReason: "stop",
              text: JSON.stringify({
                reasoning: "ok",
                verdict: "pass",
              }),
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        projectConfigPath: configPath,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-workflow-shell-snapshot"),
        sessionStore: store,
        skipUserConfig: true,
      });

      await app.runExpertWorkflow({
        task: "verify workflow shell snapshot",
      });

      const providerText = requestTexts.join("\n");
      expect(providerText).toContain("- Shell: zsh");
      expect(providerText).not.toContain("- Shell: fish");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reads built-in expert workflow snapshots without requiring an external expert definition file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-workflow-builtin-"));
    const workflowStore = createNodeWorkflowStore({
      rootDir: join(tempRoot, "cli", "workflows"),
    });
    const runId = "wf_expert_builtin_snapshot";
    const timestamp = new Date(0).toISOString();
    const snapshot: WorkflowRunSnapshot = {
      activities: [],
      artifacts: [],
      createdAt: timestamp,
      cwd: tempRoot,
      definitionId: "expert",
      definitionVersion: "2",
      graph: {
        edges: [],
        nodes: [
          {
            dependsOn: [],
            id: "phase:exec",
            kind: "phase",
            phase: "exec",
            status: "completed",
            title: "Exec",
          },
        ],
      },
      kind: "expert",
      phaseOrder: ["exec"],
      phases: [
        {
          phase: "exec",
          status: "completed",
        },
      ],
      runId,
      schemaVersion: 1,
      status: "completed",
      strategy: DEFAULT_EXPERT_WORKFLOW_STRATEGY,
      task: "status existing expert workflow",
      updatedAt: timestamp,
    };

    try {
      await workflowStore.writeSnapshot(snapshot);
      const app = await createZCodeApp({
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          setModelIoFullRetentionEnabled() {},
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-workflow-builtin"),
        skipUserConfig: true,
      });

      await expect(app.workflowStatus?.({ runId, workflowKind: "expert" })).resolves.toMatchObject({
        runId,
        snapshot: {
          definitionId: "expert",
          kind: "expert",
        },
        status: "completed",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("opens the default session store from the configured db path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-session-db-"));
    const dbPath = join(tempRoot, "db", "db.sqlite");

    try {
      const latest = await resolveLatestSession({
        directory: tempRoot,
        env: {
          ZCODE_SESSION_DB_PATH: dbPath,
        },
      });

      expect(latest).toBeNull();
      expect((await stat(dbPath)).isFile()).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks app startup on database migration before resolving model config", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-migration-gate-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      create table schema_migration (
        id text primary key,
        checksum text not null,
        app_version text,
        time_applied integer not null
      );
      insert into schema_migration (id, checksum, app_version, time_applied)
      values ('0001_base_session_store', 'not-the-current-checksum', '0.2.0', 1);
    `);
    db.close();

    try {
      await expect(
        createZCodeApp({
          env: {
            ZCODE_SESSION_DB_PATH: dbPath,
          },
          runtimeConfig: {
            workingDirectory: tempRoot,
          },
          skipUserConfig: true,
        }),
      ).rejects.toThrow(/SQLite migration checksum mismatch for 0001_base_session_store/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks ZCode Protocol startup on database migration before protocol connection", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-protocol-migration-gate-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      create table schema_migration (
        id text primary key,
        checksum text not null,
        app_version text,
        time_applied integer not null
      );
      insert into schema_migration (id, checksum, app_version, time_applied)
      values ('0001_base_session_store', 'not-the-current-checksum', '0.2.0', 1);
    `);
    db.close();
    const output = createMemoryWritable();
    const providerEnv = await createProtocolProviderEnv(tempRoot);

    try {
      await expect(
        runZCodeProtocolAgent({
          env: {
            ...providerEnv,
            ZCODE_SESSION_DB_PATH: dbPath,
          },
          input: createNeverEndingReadable(),
          output,
        }),
      ).rejects.toThrow(/SQLite migration checksum mismatch for 0001_base_session_store/);
      // 启动控制面允许迁移进度；业务协议尚未连接，不能混入其它消息或普通 stdout。
      const states = readStorageStartupStates(output.output());
      expect(states.at(-1)).toMatchObject({ phase: "failed", errorCode: "checksum_mismatch" });
      expect(states.some((state) => state.phase === "ready")).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("schedules log retention cleanup after ZCode Protocol startup completes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-protocol-log-retention-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const output = createMemoryWritable();
    const input = createClosableReadable();
    const providerEnv = await createProtocolProviderEnv(tempRoot);

    try {
      await runZCodeProtocolAgent({
        env: {
          ...providerEnv,
          ZCODE_LOG_DIR: join(tempRoot, "log"),
          ZCODE_SESSION_DB_PATH: dbPath,
          ZCODE_STORAGE_DIR: tempRoot,
        },
        input,
        output,
      });

      const logEntries = await readLogEntries(join(tempRoot, "log"));
      const startupCompletedIndex = logEntries.findIndex(
        (entry) => entry.event === "zcode_protocol.startup.completed",
      );
      const retentionScheduledIndex = logEntries.findIndex(
        (entry) => entry.event === "log.retention.cleanup.scheduled",
      );

      expect(startupCompletedIndex).toBeGreaterThanOrEqual(0);
      expect(retentionScheduledIndex).toBeGreaterThan(startupCompletedIndex);
      expect(readStorageStartupStates(output.output()).at(-1)).toMatchObject({ phase: "ready" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("routes AI SDK warnings away from ZCode Protocol stdout", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-protocol-ai-sdk-warning-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const logDir = join(tempRoot, "log");
    const output = createMemoryWritable();
    const originalWarningLogger = (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS;
    const providerEnv = await createProtocolProviderEnv(tempRoot);

    try {
      await runZCodeProtocolAgent({
        env: {
          ...providerEnv,
          ZCODE_LOG_DIR: logDir,
          ZCODE_SESSION_DB_PATH: dbPath,
          ZCODE_STORAGE_DIR: tempRoot,
        },
        input: createClosableReadable(),
        output,
      });

      const warningLogger = (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS;
      if (typeof warningLogger === "function") {
        warningLogger({
          model: "claude-opus-test",
          provider: "anthropic.messages",
          warnings: [{ type: "unsupported", feature: "temperature" }],
        });
      }

      expect(readStorageStartupStates(output.output()).at(-1)).toMatchObject({ phase: "ready" });
      const logEntries = await readLogEntries(logDir);
      expect(logEntries.some((entry) => entry.event === "model.sdk.warning")).toBe(true);
    } finally {
      (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS = originalWarningLogger;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("loads project AGENTS.md into the default prompt context", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-instructions-"));
    const workspace = join(tempRoot, "workspace");
    const nestedCwd = join(workspace, "packages", "app");
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    let capturedSystem = "";
    let capturedMetaUser = "";

    try {
      await mkdir(nestedCwd, { recursive: true });
      await mkdir(join(workspace, ".git"));
      await writeFile(join(workspace, "AGENTS.md"), "Always follow marker: project-rule-314.\n");

      const app = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        modelExecutor: {
          async generateText(request: { messages: Array<{ role: string; content: string }> }) {
            capturedSystem = request.messages
              .filter((message) => message.role === "system")
              .map((message) => message.content)
              .join("\n");
            capturedMetaUser =
              request.messages.find(
                (message) =>
                  message.role === "user" &&
                  message.content.includes(
                    `Contents of ${join(workspace, "AGENTS.md")} (project instructions, checked into the codebase):`,
                  ),
              )?.content ?? "";
            return {
              text: "done",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: nestedCwd,
        },
        sessionId: createSessionId("bootstrap-default-instructions"),
        sessionStore: store,
      });

      const result = await app.submitPrompt("hello");

      expect(result.response).toBe("done");
      expect(capturedSystem).not.toContain("project-rule-314");
      // 指令作为 context_prefix 公告注入 user 侧，直接以指令前言开头，不带聚合标题，带来源标签。
      expect(capturedMetaUser).toMatch(
        /^<system-reminder>\nCodebase and user instructions are shown below\./,
      );
      expect(capturedMetaUser).not.toContain("# agentsMd");
      expect(capturedMetaUser).not.toContain("# claudeMd");
      expect(capturedMetaUser).not.toContain("# user_instructions");
      expect(capturedMetaUser).toContain("project-rule-314");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("wires oversized tool results into the default artifact store", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-bootstrap-artifacts-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const eventStore = createInMemorySessionEventStore();
    const store = await createSqliteSessionStore({ dbPath });
    const largeStdout = `BEGIN_FULL_OUTPUT\n${"x".repeat(50_000)}`;
    let modelCallCount = 0;
    let followupToolMessage = "";
    const executionPort = {
      async run() {
        const now = new Date();
        return {
          status: "completed",
          exitCode: 0,
          stdout: {
            text: largeStdout,
            bytes: Buffer.byteLength(largeStdout, "utf8"),
            truncated: false,
          },
          stderr: {
            text: "",
            bytes: 0,
            truncated: false,
          },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: now,
          completedAt: now,
        };
      },
    } satisfies ExecutionPort;

    try {
      const app = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {
          ZCODE_STORAGE_DIR: tempRoot,
        },
        eventStore,
        executionPort,
        modelExecutor: {
          async generateText(request: { messages: Array<{ role: string; content: string }> }) {
            modelCallCount++;
            if (modelCallCount === 1) {
              return {
                text: "",
                finishReason: "tool-calls",
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
                toolCalls: [
                  {
                    id: "large-bash-output",
                    name: "Bash",
                    input: {
                      command: "generate large output",
                      description: "Generate large fixture output",
                    },
                  },
                ],
              };
            }

            followupToolMessage =
              request.messages.find((message) => message.role === "tool")?.content ?? "";
            return {
              text: "done",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          // 该测试冻结两次 Main 请求来验证 artifact 投影；Extraction 是独立模型链，
          // 必须关闭以免第三次请求覆盖 followupToolMessage。
          memory: { enabled: false },
          mode: "yolo",
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("bootstrap-artifact-store"),
        sessionStore: store,
      });

      const result = await app.submitPrompt("produce large output");
      const events = await eventStore.getEvents(app.sessionId);
      const toolResultEvent = events.find(
        (event) => event.type === SessionEventType.ToolCallResult,
      );
      const toolResultPayload = toolResultEvent?.payload as any;
      const artifactPath = toolResultPayload.result.artifactPath as string;
      if (typeof artifactPath !== "string") {
        throw new Error("Expected oversized tool result to include an artifactPath");
      }
      const artifactDir = dirname(artifactPath);
      const files = await readdir(artifactDir);
      const artifactContent = await readFile(artifactPath, "utf8");

      expect(result.response).toBe("done");
      expect(artifactPath).toContain(join(tempRoot, "cli", "artifacts", app.sessionId));
      expect(files).toHaveLength(1);
      expect(artifactContent).toContain("BEGIN_FULL_OUTPUT");
      // 回归原因：大结果落盘后，provider-visible 内容会使用统一的
      // <persisted-output> envelope，并保留前 2KB preview，而不是旧 artifactPath 键值。
      expect(followupToolMessage).toContain("<persisted-output>");
      expect(followupToolMessage).toContain(
        `Output too large (48.8KB). Full output saved to: ${artifactPath}`,
      );
      expect(followupToolMessage).toContain("Preview (first 2KB):");
      expect(followupToolMessage).toContain("BEGIN_FULL_OUTPUT");
      expect(followupToolMessage).toContain("...\n</persisted-output>");
      expect(followupToolMessage.length).toBeLessThan(artifactContent.length);
      expect(toolResultPayload.result.truncated).toBe(true);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("registers submitPrompt live event handlers only for the active turn", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-submit-live-events-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const logDir = join(tempRoot, "log");
    const responses = [
      {
        text: "first live answer",
        finishReason: "stop",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
        },
      },
      {
        text: "second live answer",
        finishReason: "stop",
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
        },
      },
    ];
    const store = await createSqliteSessionStore({ dbPath });
    const liveEventTypes: string[] = [];

    try {
      const app = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {},
        eventStore: createInMemorySessionEventStore(),
        loggerFactory: createNodeLoggerFactory({ logDir, minLevel: LogLevel.Debug }),
        modelExecutor: {
          async generateText() {
            const next = responses.shift();
            if (!next) throw new Error("unexpected model request");
            return next;
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("submit-live-events"),
        sessionStore: store,
      });

      const first = await app.submitPrompt("first prompt", {
        onEvent: (event) => {
          liveEventTypes.push(event.type);
        },
      });
      const firstEventCount = liveEventTypes.length;
      const second = await app.submitPrompt("second prompt");

      expect(first.response).toBe("first live answer");
      expect(second.response).toBe("second live answer");
      // Bugfix: ensureSessionPersisted 现在会 appendEvent 一条 session.titleUpdated（source="first_input"），
      // 紧贴在 TurnStarted 之前。这里把它作为合法首项接受。
      expect(liveEventTypes).toEqual([
        SessionEventType.SessionTitleUpdated,
        SessionEventType.TurnStarted,
        SessionEventType.ModelRequest,
        SessionEventType.ModelComplete,
        SessionEventType.TurnComplete,
      ]);
      expect(liveEventTypes).toHaveLength(firstEventCount);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps builtin prompt command text visible while sending the expanded runtime prompt", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-builtin-init-visible-prompt-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    let capturedMessages: Array<{ content: string; role: string }> = [];

    try {
      const app = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText(request: { messages: Array<{ content: string; role: string }> }) {
            capturedMessages = request.messages;
            return {
              text: "created AGENTS",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("builtin-init-visible-prompt"),
        sessionStore: store,
      });

      const result = await app.submitPrompt("/init include package scripts");
      const turnStarted = result.events.find(
        (event) => event.type === SessionEventType.TurnStarted,
      );

      expect(
        capturedMessages.some(
          (message) =>
            message.role === "user" && message.content.includes("built-in /init command"),
        ),
      ).toBe(true);
      expect(turnStarted?.payload).toMatchObject({
        input: "/init include package scripts",
      });
      await expect(app.loadSessionTranscript()).resolves.toEqual([
        {
          content: "/init include package scripts",
          role: "user",
        },
        {
          content: "created AGENTS",
          role: "agent",
        },
      ]);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps sendInput(auto) queued until the command layer promotes it", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-send-input-steer-"));
    const modelStarted = deferred();
    const finishFirstModel = deferred();
    const liveEventTypes: string[] = [];
    let modelCallCount = 0;
    let secondRequestMessages: Array<{ content: string; role: string }> = [];

    try {
      const app = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText(request: { messages: Array<{ content: string; role: string }> }) {
            modelCallCount++;
            if (modelCallCount === 1) {
              modelStarted.resolve();
              await finishFirstModel.promise;
              return {
                finishReason: "stop",
                text: "first answer",
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              };
            }

            secondRequestMessages = request.messages;
            return {
              finishReason: "stop",
              text: "second answer",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("send-input-steer"),
      });

      const pendingTurn = app.submitPrompt("first prompt", {
        onEvent: (event) => {
          liveEventTypes.push(event.type);
        },
      });
      await modelStarted.promise;

      const queued = await app.sendInput("queued through app", { delivery: "auto" });
      finishFirstModel.resolve();
      const result = await pendingTurn;

      expect(queued).toMatchObject({
        kind: "queued",
        queueLength: 1,
      });
      expect(result.response).toBe("first answer");
      expect(secondRequestMessages).toEqual([]);
      expect(liveEventTypes).toContain(SessionEventType.TurnSteerQueued);
      expect(liveEventTypes).not.toContain(SessionEventType.TurnSteerDrained);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records accepted prompt and steered input history through the app contract", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-input-history-app-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const modelStarted = deferred();
    const finishFirstModel = deferred();
    let modelCallCount = 0;

    try {
      const app = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText() {
            modelCallCount++;
            if (modelCallCount === 1) {
              modelStarted.resolve();
              await finishFirstModel.promise;
            }
            return {
              finishReason: "stop",
              text: modelCallCount === 1 ? "first answer" : "second answer",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("input-history-app"),
        sessionStore: store,
      });

      const firstPrompt = {
        attachments: [
          {
            content: "data:image/png;base64,aW1hZ2U=",
            path: "[image #1]",
            type: "image" as const,
          },
        ],
        text: "[image #1] first prompt",
      };
      const pendingTurn = app.submitPrompt(firstPrompt);
      await modelStarted.promise;
      expect(await app.recallPreviousInputHistory()).toMatchObject({
        attachments: firstPrompt.attachments,
        kind: "prompt",
        text: "[image #1] first prompt",
      });
      const storedPromptHistory = await store.recallPreviousInputHistory({
        projectID: testProjectIdFromDirectory(tempRoot),
      });
      expect(storedPromptHistory?.attachments?.[0]?.content).toMatch(/^zcode-artifact:\/\//);
      expect(storedPromptHistory?.attachments?.[0]?.content).not.toContain("base64");

      await app.sendInput("queued through app", { delivery: "auto" });
      expect(await app.recallPreviousInputHistory()).toMatchObject({
        kind: "steered_input",
        text: "queued through app",
      });
      finishFirstModel.resolve();
      await pendingTurn;
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("restores project-scoped mode from local settings unless CLI overrides it", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-project-mode-local-setting-"));
    const otherRoot = await mkdtemp(join(tmpdir(), "zcode-project-mode-other-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });

    try {
      const firstApp = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("project-mode-first"),
        sessionStore: store,
      });

      await firstApp.setMode("yolo");

      const restoredApp = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("project-mode-restored"),
        sessionStore: store,
      });
      expect(restoredApp.getMode()).toBe("yolo");

      const otherProjectApp = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: otherRoot,
        },
        sessionId: createSessionId("project-mode-other"),
        sessionStore: store,
      });
      expect(otherProjectApp.getMode()).toBe("build");

      const cliOverrideApp = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {},
        eventStore: createInMemorySessionEventStore(),
        modelExecutor: {
          async generateText() {
            return {
              finishReason: "stop",
              text: "unused",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          mode: "plan",
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("project-mode-cli-override"),
        sessionStore: store,
      });
      expect(cliOverrideApp.getMode()).toBe("build");
      expect(cliOverrideApp.runtime.getPlanEnabled()).toBe(true);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("keeps a headless invocation mode when resuming a session with persisted checkpoints", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-headless-resume-mode-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const sessionId = createSessionId("headless-resume-mode");
    const firstFile = join(tempRoot, "step1.txt");
    const secondFile = join(tempRoot, "step2.txt");
    const createWriteModelExecutor = (filePath: string, content: string) => {
      let modelCallCount = 0;
      return {
        async generateText() {
          modelCallCount++;
          if (modelCallCount === 1) {
            return {
              text: "",
              finishReason: "tool-calls",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              toolCalls: [
                {
                  id: `write-${modelCallCount}-${content}`,
                  name: "Write",
                  input: { file_path: filePath, content },
                },
              ],
            };
          }
          return {
            text: "done",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      };
    };

    try {
      const firstApp = await createZCodeApp({
        env: { ZCODE_STORAGE_DIR: tempRoot },
        modelExecutor: createWriteModelExecutor(firstFile, "hello") as never,
        runtimeConfig: {
          mode: "yolo",
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
      });
      await firstApp.submitPrompt("create step1.txt");
      await firstApp.close?.();
      expect(await readFile(firstFile, "utf8")).toBe("hello");

      const resumedApp = await createZCodeApp({
        env: { ZCODE_STORAGE_DIR: tempRoot },
        modelExecutor: createWriteModelExecutor(secondFile, "world") as never,
        resume: true,
        runtimeConfig: {
          // headless 未显式传 --mode 时也会把默认 yolo 作为本次 invocation mode 传入。
          mode: "yolo",
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
      });
      await resumedApp.submitPrompt("create step2.txt");

      expect(resumedApp.getMode()).toBe("yolo");
      expect(await readFile(secondFile, "utf8")).toBe("world");
      await resumedApp.close?.();
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("initializes the Bash shell before direct app prompt submission", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-direct-shell-snapshot-"));
    const shellDir = join(tempRoot, "bin");
    const zshPath = join(shellDir, "zsh");
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    let capturedMessages: Array<{ role: string; content: string }> = [];

    try {
      await mkdir(shellDir, { recursive: true });
      await writeFile(zshPath, "#!/bin/sh\n");
      await chmod(zshPath, 0o755);

      const app = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {
          PATH: shellDir,
          SHELL: join(shellDir, "fish"),
        },
        modelExecutor: {
          async generateText(request: { messages: Array<{ role: string; content: string }> }) {
            capturedMessages = request.messages;
            return {
              text: "answer",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId: createSessionId("direct-shell-snapshot"),
        sessionStore: store,
      });

      await app.submitPrompt("first prompt");

      const providerText = capturedMessages.map((message) => message.content).join("\n");
      expect(providerText).toContain("- Shell: zsh");
      expect(providerText).not.toContain("- Shell: fish");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the latest Bash shell on a direct app resume and announces the change", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-direct-resume-shell-snapshot-"));
    const oldShellDir = join(tempRoot, "old-bin");
    const newShellDir = join(tempRoot, "new-bin");
    const oldZshPath = join(oldShellDir, "zsh");
    const newBashPath = join(newShellDir, "bash");
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = createSessionId("direct-resume-shell-snapshot");
    let capturedMessages: Array<{ role: string; content: unknown }> = [];

    try {
      await mkdir(oldShellDir, { recursive: true });
      await mkdir(newShellDir, { recursive: true });
      await writeFile(oldZshPath, "#!/bin/sh\n");
      await writeFile(newBashPath, "#!/bin/sh\n");
      await chmod(oldZshPath, 0o755);
      await chmod(newBashPath, 0o755);

      const firstApp = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {
          PATH: oldShellDir,
          SHELL: join(oldShellDir, "fish"),
        },
        modelExecutor: {
          async generateText() {
            return {
              text: "first answer",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
      });

      await firstApp.submitPrompt("first prompt");

      // Host 返回的最新设置；环境变量仍指向旧 shell，自动解析会得到 zsh。
      const hostSelection: ExecutionShellSelection = {
        dialect: "posix",
        display: { name: "bash" },
        id: `user:${newBashPath}`,
        label: "bash",
        path: newBashPath,
        source: "user-config",
      };
      const secondApp = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {
          PATH: oldShellDir,
          SHELL: join(oldShellDir, "fish"),
        },
        modelExecutor: {
          async generateText(request: { messages: Array<{ role: string; content: unknown }> }) {
            capturedMessages = request.messages;
            return {
              text: "second answer",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        resolveInitialBashShellSelection: async () => hostSelection,
        resume: true,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
      });

      await secondApp.resume();
      await secondApp.submitPrompt("second prompt");

      // 旧 shell 仍可用，冷恢复也使用 Host 的最新设置执行，并以环境更新告诉模型。
      expect(secondApp.runtime.getSessionShellSelection()).toEqual(hostSelection);
      const providerText = JSON.stringify(capturedMessages);
      expect(providerText).toContain(" - Shell: bash (was zsh)");
      expect(providerText).not.toContain("The Bash tool shell is");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("projects persisted user and assistant transcript rows for resume UIs", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-resume-transcript-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionId = createSessionId("resume-transcript");

    try {
      const firstApp = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {},
        modelExecutor: {
          async generateText() {
            return {
              text: "first answer",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3,
              },
            };
          },
        } as never,
        runtimeConfig: {
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
      });

      await firstApp.submitPrompt("first prompt");

      const resumedApp = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {},
        modelExecutor: {
          async generateText() {
            return {
              text: "unused",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
        resume: true,
        runtimeConfig: {
          workingDirectory: join(tempRoot, "other-cwd"),
        },
        sessionId,
        sessionStore: store,
      });

      await resumedApp.resume();
      await expect(resumedApp.loadSessionTranscript()).resolves.toEqual([
        {
          content: "first prompt",
          role: "user",
        },
        {
          content: "first answer",
          role: "agent",
        },
      ]);
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves the original git snapshot across resume so later repository changes do not rewrite the announced context", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-resume-git-snapshot-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionId = createSessionId("resume-git-snapshot");
    let capturedMessages: Array<{ role: string; content: string }> = [];

    // 模拟历史存储的额外字段；当前 EnvInfo 契约不再声明执行模型。
    const firstEnvInfo: EnvInfo & { currentModel: string } = {
      cwd: tempRoot,
      platform: "darwin",
      shell: "zsh",
      osVersion: "Darwin 25.4.0",
      nodeVersion: "v24.14.0",
      currentModel: "legacy/persisted-model",
      isGitRepository: true,
      gitBranch: "feature/original",
      gitMainBranch: "main",
      gitUser: "ZCode Tester <tester@example.com>",
      gitStatus: "dirty",
      gitStatusLines: [" M first.ts"],
      recentCommits: ["abc123 first commit"],
    };
    const secondEnvInfo: EnvInfo = {
      ...firstEnvInfo,
      cwd: join(tempRoot, "different-cwd"),
      gitStatusLines: [" M second.ts"],
      recentCommits: ["def456 second commit"],
    };

    try {
      const firstApp = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {},
        modelExecutor: {
          async generateText() {
            return {
              text: "first answer",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3,
              },
            };
          },
        } as never,
        runtimeConfig: {
          envInfo: firstEnvInfo,
          workingDirectory: tempRoot,
        },
        sessionId,
        sessionStore: store,
      });

      await firstApp.submitPrompt("first prompt");

      const secondApp = await createZCodeApp({
        // 持久化测试不读取操作者配置，避免真实插件和 MCP 混入会话生命周期。
        skipUserConfig: true,
        env: {},
        modelExecutor: {
          async generateText(request: { messages: Array<{ role: string; content: string }> }) {
            capturedMessages = request.messages;
            return {
              text: "second answer",
              finishReason: "stop",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
                totalTokens: 5,
              },
            };
          },
        } as never,
        resume: true,
        runtimeConfig: {
          envInfo: secondEnvInfo,
          modelSelection: {
            providerId: "openai",
            modelId: "gpt-5",
            options: { reasoningLevel: "high" },
          },
          workingDirectory: join(tempRoot, "different-cwd"),
        },
        sessionId,
        sessionStore: store,
      });

      await secondApp.submitPrompt("second prompt");

      const providerText = capturedMessages.map((message) => message.content).join("\n");
      const messageWith = (marker: string) =>
        capturedMessages.find((message) => message.content.includes(marker))?.content ?? "";
      // 冷恢复保留首次会话保存的模型，不用启动参数覆盖；模型公告随实际恢复的 Model 渲染。
      expect(messageWith("You are powered by the model named")).toContain(
        "You are powered by the model named zai/glm-4.6.",
      );
      expect(providerText).not.toContain("legacy/persisted-model");
      // 原始 git snapshot 是首轮持久化的 session_context 公告；恢复后沿用，不被新快照覆盖。
      const gitContext = messageWith("# gitStatus");
      expect(gitContext).toContain("Current branch: feature/original");
      expect(gitContext).toContain(" M first.ts");
      expect(gitContext).toContain("abc123 first commit");
      expect(providerText).not.toContain(" M second.ts");
      expect(providerText).not.toContain("def456 second commit");
    } finally {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

interface AiSdkWarningGlobal {
  AI_SDK_LOG_WARNINGS?: false | ((options: Record<string, unknown>) => void);
}

async function createProtocolProviderEnv(root: string): Promise<Record<string, string>> {
  const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
  const personalFilePath = join(root, "provider-personal.json");
  // 用正式编码器构造启动夹具，避免旧配置结构让用例在被测边界之前失败。
  const emptyBuiltinRelease = serializeZCodeBuiltinRelease({
    schemaVersion: 1,
    revision: 1,
    config: {
      providers: ProviderConfigMap.empty(),
      providerTemplates: ProviderTemplateMap.empty(),
      modelConfigRules: ModelConfigRules.empty(),
    },
  });
  const emptyPersonalConfig = JSON.stringify(
    encodeProviderConfigFile({
      providers: ProviderConfigMap.empty(),
      models: ModelConfigRules.empty(),
    }),
  );
  await Promise.all([
    writeFile(zcodeBuiltinFilePath, emptyBuiltinRelease),
    writeFile(personalFilePath, emptyPersonalConfig),
  ]);
  return createNodeProviderRuntimePathEnv({ zcodeBuiltinFilePath, personalFilePath });
}

function readStorageStartupStates(output: string) {
  return output
    .trim()
    .split("\n")
    .map((line) => {
      const message = JSON.parse(line);
      expect(message.method).toBe("startup/storageState");
      return zcodeStorageStartupStateSchema.parse(message.params);
    });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolveDeferred: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return {
    promise,
    resolve: resolveDeferred,
  };
}

function createNeverEndingReadable(): NodeJS.ReadableStream {
  return {
    off: () => createNeverEndingReadable(),
    once: () => createNeverEndingReadable(),
  } as unknown as NodeJS.ReadableStream;
}

function createClosableReadable(): NodeJS.ReadableStream {
  return Readable.from([]);
}

function testProjectIdFromDirectory(directory: string) {
  return createProjectId(
    directory
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "default",
  );
}

function createMemoryWritable(): NodeJS.WritableStream & { output(): string } {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      callback();
    },
  }) as NodeJS.WritableStream & { output(): string };
  stream.output = () => output;
  return stream;
}
