import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionId, type PermissionBrokerRequest, type SessionId } from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createRegistryBackedTestApp } from "../helpers/registry-backed-test-app.js";

import { cleanups, CLI_TOOLS, APP_ONLY_TOOLS } from "./standalone-bootstrap-fixture.js";

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("standalone session tools bootstrap", () => {
  it("only registers CLI tools at explicit standalone startup and reaches the real root manager", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "zcode-control-bootstrap-"));
    const store = await createSqliteSessionStore({ dbPath: join(cwd, "sessions.sqlite") });
    cleanups.push(async () => {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    });
    const sessionId = createSessionId("standalone-root");
    let calls = 0;
    const root = await createRegistryBackedTestApp({
      standaloneSessionControl: true,
      sessionId,
      sessionStore: store,
      skipUserConfig: true,
      env: { ZCODE_STORAGE_DIR: cwd },
      configuredDefaultModelSelection: { providerId: "zai", modelId: "glm-4.6" },
      runtimeConfig: { workingDirectory: cwd, mode: "yolo" },
      modelExecutor: {
        generateText: async () => {
          if (calls++ === 0)
            return {
              text: "",
              finishReason: "tool-calls",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              toolCalls: [
                {
                  id: "rename-root",
                  name: "RenameSession",
                  input: {
                    sessionId,
                    title: "Renamed through owner",
                  },
                },
              ],
            };
          return {
            text: "done",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      },
    });
    cleanups.push(async () => {
      await root.close?.();
    });
    const registry = root.runtime.getToolRegistry();
    // 工具名统一后没有前缀：独立 CLI 只注册共有 8 个，App 独有的 4 个不出现。
    const registered = registry.list();
    expect(CLI_TOOLS.filter((name) => registered.includes(name))).toEqual(CLI_TOOLS);
    expect(APP_ONLY_TOOLS.some((name) => registered.includes(name))).toBe(false);
    await root.submitPrompt("Rename this session");
    expect(calls).toBeGreaterThanOrEqual(2);
    expect((await store.getSession(sessionId))?.title).toBe("Renamed through owner");
    expect(
      (await store.messages({ sessionID: sessionId }))
        .flatMap((message) => message.parts)
        .some((part) => part.type === "tool" && part.tool === "RenameSession"),
    ).toBe(true);
    await root.close?.();
  });

  it.each([true, false])(
    "does not grant target write access to persisted history (resume=%s)",
    async (resume) => {
      const cwd = await mkdtemp(join(tmpdir(), "zcode-control-resume-scope-"));
      const store = await createSqliteSessionStore({ dbPath: join(cwd, "sessions.sqlite") });
      cleanups.push(async () => {
        store.close();
        await rm(cwd, { recursive: true, force: true });
      });
      const sessionId = createSessionId("resumed-root");
      const original = await createRegistryBackedTestApp({
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
        env: { ZCODE_STORAGE_DIR: cwd },
        configuredDefaultModelSelection: { providerId: "zai", modelId: "glm-4.6" },
        runtimeConfig: { workingDirectory: cwd, mode: "yolo" },
        modelExecutor: {
          generateText: async () => ({
            text: "seeded",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }),
        },
      });
      cleanups.push(async () => {
        await original.close?.();
      });
      await original.submitPrompt("Preserve this independent history");
      await original.setCustomSessionTitle({ title: "Original history" });
      await original.close?.();

      let calls = 0;
      const resumed = await createRegistryBackedTestApp({
        standaloneSessionControl: true,
        resume,
        sessionId,
        sessionStore: store,
        skipUserConfig: true,
        env: { ZCODE_STORAGE_DIR: cwd },
        runtimeConfig: { workingDirectory: cwd, mode: "yolo" },
        modelExecutor: {
          generateText: async () => {
            if (calls++ === 0)
              return {
                text: "",
                finishReason: "tool-calls",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                toolCalls: [
                  {
                    id: "rename-unverified",
                    name: "RenameSession",
                    input: {
                      sessionId,
                      title: "Must not rename",
                    },
                  },
                ],
              };
            return {
              text: "not renamed",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        },
      });
      cleanups.push(async () => {
        await resumed.close?.();
      });
      await resumed.submitPrompt("Try session-control rename without owner provenance");
      expect(calls).toBeGreaterThanOrEqual(2);
      const finalTitle = (await store.getSession(sessionId))?.title;
      expect(finalTitle).not.toBe("Must not rename");
      if (resume) expect(finalTitle).toBe("Original history");
      const attempted = (await store.messages({ sessionID: sessionId }))
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.callID === "rename-unverified");
      expect(attempted).toMatchObject({
        type: "tool",
        tool: "RenameSession",
        state: { status: "error" },
      });
    },
  );

  it("creates a real independent root in build mode from a yolo actor and interrupts it on owner close", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "zcode-control-root-life-"));
    const store = await createSqliteSessionStore({ dbPath: join(cwd, "sessions.sqlite") });
    cleanups.push(async () => {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    });
    const sessionId = createSessionId("actor-yolo");
    let actorCalls = 0;
    let childSessionId: string | undefined;
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const root = await createRegistryBackedTestApp({
      standaloneSessionControl: true,
      sessionId,
      sessionStore: store,
      skipUserConfig: true,
      env: { ZCODE_STORAGE_DIR: cwd },
      configuredDefaultModelSelection: { providerId: "zai", modelId: "glm-4.6" },
      runtimeConfig: { workingDirectory: cwd, mode: "yolo" },
      modelExecutor: {
        generateText: async (request) => {
          if (
            request.messages.some(
              (message) => message.role === "user" && message.content === "run background work",
            )
          ) {
            childSessionId = (await store.listSessions()).find(
              (session) => session.id !== sessionId,
            )?.id;
            childStarted();
            return new Promise((_resolve, reject) => {
              if (request.abortSignal?.aborted) reject(request.abortSignal.reason);
              else
                request.abortSignal?.addEventListener(
                  "abort",
                  () => reject(request.abortSignal?.reason),
                  { once: true },
                );
            });
          }
          if (actorCalls++ === 0)
            return {
              text: "",
              finishReason: "tool-calls",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              toolCalls: [
                {
                  id: "create-root",
                  name: "CreateSession",
                  input: { prompt: "run background work" },
                },
              ],
            };
          return {
            text: "created",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      },
    });
    cleanups.push(async () => {
      await root.close?.();
    });
    await root.submitPrompt("Create another root session");
    await started;
    const child = await store.getSession(childSessionId as SessionId);
    expect(child?.taskType).toBe("interactive");
    expect(child?.parentID).toBeUndefined();
    await root.close?.();
    expect((await store.getSession(childSessionId as SessionId))?.lastOutcome).toBe("interrupted");
    const assistantMessages = (
      await store.messages({ sessionID: childSessionId as SessionId })
    ).filter((message) => message.info.role === "assistant");
    expect(assistantMessages.length).toBeGreaterThan(0);
    expect(
      assistantMessages.every(
        (message) => message.info.role === "assistant" && message.info.mode === "build",
      ),
    ).toBe(true);
  });

  // 回归（会话工具设计 0.5）：后台根原先不接启动方的 broker，需要审批的工具被 Core 的拒绝 broker
  // 直接拒绝。现在询问进入同一个 broker，带后台会话自己的 sessionId；发起者的 yolo 不传给后台根。
  it.each(["allow", "deny"] as const)(
    "routes a background root approval to the launcher broker (%s)",
    async (decision) => {
      const cwd = await mkdtemp(join(tmpdir(), "zcode-control-root-approval-"));
      const store = await createSqliteSessionStore({ dbPath: join(cwd, "sessions.sqlite") });
      cleanups.push(async () => {
        store.close();
        await rm(cwd, { recursive: true, force: true });
      });
      const actorId = createSessionId("actor-approval");
      const target = join(cwd, "background.txt");
      const asked: PermissionBrokerRequest[] = [];
      const backgroundDone = Promise.withResolvers<string>();
      let actorCalls = 0;
      let backgroundCalls = 0;
      const root = await createRegistryBackedTestApp({
        standaloneSessionControl: true,
        sessionId: actorId,
        sessionStore: store,
        skipUserConfig: true,
        env: { ZCODE_STORAGE_DIR: cwd },
        configuredDefaultModelSelection: { providerId: "zai", modelId: "glm-4.6" },
        runtimeConfig: { workingDirectory: cwd, mode: "yolo" },
        permissionBroker: {
          requestPermission: async (request) => {
            asked.push(request);
            return { decision, reason: `${decision} by launcher test`, resolvedAt: new Date() };
          },
        },
        modelExecutor: {
          generateText: async (request) => {
            // 只按用户输入区分会话：发起者的 CreateSession 参数里也带标记，不能按整份请求匹配。
            const background = request.messages.some(
              (message) =>
                message.role === "user" &&
                JSON.stringify(message.content).includes("E2E_BACKGROUND_WRITE"),
            );
            if (background) {
              if (backgroundCalls++ === 0)
                return {
                  text: "",
                  finishReason: "tool-calls",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  toolCalls: [
                    {
                      id: "background-write",
                      name: "Write",
                      input: { file_path: target, content: "written after approval" },
                    },
                  ],
                };
              const result = request.messages.find(
                (message) => message.role === "tool" && message.toolCallId === "background-write",
              );
              backgroundDone.resolve(JSON.stringify(result?.content ?? ""));
              return {
                text: "background done",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            if (actorCalls++ === 0)
              return {
                text: "",
                finishReason: "tool-calls",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                toolCalls: [
                  {
                    id: "create-background",
                    name: "CreateSession",
                    input: { prompt: "E2E_BACKGROUND_WRITE" },
                  },
                ],
              };
            return {
              text: "created",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        },
      });
      cleanups.push(async () => {
        await root.close?.();
      });
      // 发起者是 yolo，自己的 CreateSession 不询问；询问只来自后台根。
      await root.submitPrompt("Create a background writer");
      const toolResult = await backgroundDone.promise;
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({ toolName: "Write", mode: "build" });
      expect(asked[0]!.sessionId).not.toBe(actorId);
      const background = await store.getSession(asked[0]!.sessionId);
      expect(background?.parentID).toBeUndefined();
      if (decision === "allow") {
        expect(await readFile(target, "utf8")).toBe("written after approval");
      } else {
        await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(toolResult).toContain("deny by launcher test");
      }
    },
  );

  // SCT08：后台根等待审批时，发起者的 wait 只看到 needs_attention，不能代答；用户回答后后台根继续。
  it("reports needs_attention to the actor while the user has not answered", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "zcode-control-root-attention-"));
    const store = await createSqliteSessionStore({ dbPath: join(cwd, "sessions.sqlite") });
    cleanups.push(async () => {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    });
    const target = join(cwd, "attention.txt");
    const asked = Promise.withResolvers<PermissionBrokerRequest>();
    const answer = Promise.withResolvers<"allow">();
    const backgroundDone = Promise.withResolvers<void>();
    const waited: unknown[] = [];
    let backgroundCalls = 0;
    const toolText = (
      request: { messages: { role: string; toolCallId?: string; content: unknown }[] },
      id: string,
    ) => {
      const content = request.messages.find(
        (message) => message.role === "tool" && message.toolCallId === id,
      )?.content;
      const text =
        typeof content === "string"
          ? content
          : ((content as { type: string; text?: string }[] | undefined) ?? [])
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
      const reminder = text.indexOf("\n\n<system-reminder>");
      return reminder < 0 ? text : text.slice(0, reminder);
    };
    const root = await createRegistryBackedTestApp({
      standaloneSessionControl: true,
      sessionStore: store,
      skipUserConfig: true,
      env: { ZCODE_STORAGE_DIR: cwd },
      configuredDefaultModelSelection: { providerId: "zai", modelId: "glm-4.6" },
      runtimeConfig: { workingDirectory: cwd, mode: "yolo" },
      permissionBroker: {
        requestPermission: async (request) => {
          asked.resolve(request);
          return {
            decision: await answer.promise,
            reason: "user answered",
            resolvedAt: new Date(),
          };
        },
      },
      modelExecutor: {
        generateText: async (request) => {
          const background = request.messages.some(
            (message) =>
              message.role === "user" &&
              JSON.stringify(message.content).includes("E2E_ATTENTION_WRITE"),
          );
          if (background) {
            if (backgroundCalls++ === 0)
              return {
                text: "",
                finishReason: "tool-calls",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                toolCalls: [
                  {
                    id: "attention-write",
                    name: "Write",
                    input: { file_path: target, content: "written after the user answered" },
                  },
                ],
              };
            backgroundDone.resolve();
            return {
              text: "background done",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }
          if (!request.messages.some((message) => message.toolCallId === "create-attention"))
            return {
              text: "",
              finishReason: "tool-calls",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              toolCalls: [
                {
                  id: "create-attention",
                  name: "CreateSession",
                  input: { prompt: "E2E_ATTENTION_WRITE" },
                },
              ],
            };
          if (!request.messages.some((message) => message.toolCallId === "wait-attention")) {
            // operation 只取自真实 CreateSession 回执；工具面只收 sessionId + commandId（规格 0.11）。
            const created = JSON.parse(toolText(request, "create-attention")) as {
              operation: { session: { sessionId: string }; commandId: string };
            };
            return {
              text: "",
              finishReason: "tool-calls",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              toolCalls: [
                {
                  id: "wait-attention",
                  name: "WaitSessions",
                  input: {
                    operations: [
                      {
                        sessionId: created.operation.session.sessionId,
                        commandId: created.operation.commandId,
                      },
                    ],
                    mode: "any",
                    timeoutMs: 30_000,
                  },
                },
              ],
            };
          }
          waited.push(JSON.parse(toolText(request, "wait-attention")));
          return {
            text: "observed",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      },
    });
    cleanups.push(async () => {
      await root.close?.();
    });
    await root.submitPrompt("Create a background writer and wait for it");
    const request = await asked.promise;
    // 发起者的这一轮已经结束，用户仍未回答：wait 只报告 needs_attention，文件尚未写入。
    expect(waited).toHaveLength(1);
    expect(waited[0]).toMatchObject({
      status: "completed",
      operations: [{ status: "needs_attention", attention: { kind: "approval" } }],
    });
    expect(request).toMatchObject({ toolName: "Write", mode: "build" });
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    answer.resolve("allow");
    await backgroundDone.promise;
    expect(await readFile(target, "utf8")).toBe("written after the user answered");
  });

  // 规格 0.5：用户切换主会话或进程退出时 owner 关闭后台根，等待中的询问必须被取消，不能悬挂。
  it("cancels a pending background approval when the owner closes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "zcode-control-root-approval-close-"));
    const store = await createSqliteSessionStore({ dbPath: join(cwd, "sessions.sqlite") });
    cleanups.push(async () => {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    });
    const target = join(cwd, "cancelled.txt");
    const asked = Promise.withResolvers<PermissionBrokerRequest>();
    let actorCalls = 0;
    let cancelled = false;
    const root = await createRegistryBackedTestApp({
      standaloneSessionControl: true,
      sessionStore: store,
      skipUserConfig: true,
      env: { ZCODE_STORAGE_DIR: cwd },
      configuredDefaultModelSelection: { providerId: "zai", modelId: "glm-4.6" },
      runtimeConfig: { workingDirectory: cwd, mode: "yolo" },
      permissionBroker: {
        requestPermission: (request, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                cancelled = true;
                reject(new Error("Permission request cancelled"));
              },
              { once: true },
            );
            asked.resolve(request);
          }),
      },
      modelExecutor: {
        generateText: async (request) => {
          const background = request.messages.some(
            (message) =>
              message.role === "user" &&
              JSON.stringify(message.content).includes("E2E_CANCEL_WRITE"),
          );
          if (background)
            return {
              text: "",
              finishReason: "tool-calls",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              toolCalls: [
                { id: "cancel-write", name: "Write", input: { file_path: target, content: "no" } },
              ],
            };
          if (actorCalls++ === 0)
            return {
              text: "",
              finishReason: "tool-calls",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              toolCalls: [
                {
                  id: "create-cancel",
                  name: "CreateSession",
                  input: { prompt: "E2E_CANCEL_WRITE" },
                },
              ],
            };
          return {
            text: "created",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      },
    });
    cleanups.push(async () => {
      await root.close?.();
    });
    await root.submitPrompt("Create a background writer");
    const request = await asked.promise;
    await root.close?.();
    expect(cancelled).toBe(true);
    expect((await store.getSession(request.sessionId))?.lastOutcome).toBe("interrupted");
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
