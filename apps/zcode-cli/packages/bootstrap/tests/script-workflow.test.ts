import * as childFactory from "../src/app/script-workflow-child-runtime.js";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createRootTraceContext, createSessionId, type Model } from "@zcode/contracts";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
} from "@zcode/provider";
import { createRegistryBackedTestApp as createZCodeApp } from "./helpers/registry-backed-test-app.js";
import { readWorkflowScriptDocument } from "../src/app/script-workflow-meta.js";
import { runScriptWorkflowChild } from "../src/app/script-workflow-process.js";
import { createScriptWorkflowToolPort } from "../src/app/script-workflow-tool-port.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";

describe("script workflow runtime", () => {
  it("extracts workflow meta and runs a body in a child process", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-script-workflow-"));
    const scriptPath = join(tempRoot, "review.workflow.js");
    await writeFile(
      scriptPath,
      `
        export const meta = {
          name: "review",
          description: "Review a target",
          phases: [{ title: "Setup" }],
        };

        phase("Setup");
        log("starting");
        return { ok: args.ok };
      `,
      "utf8",
    );

    try {
      const traceContext = createRootTraceContext({
        sessionId: createSessionId("script-workflow-test"),
      });
      const document = await readWorkflowScriptDocument({
        fileSystemPort: createNodeFileSystemAdapter(),
        scriptPath,
        traceContext,
      });
      const events: string[] = [];
      const result = await runScriptWorkflowChild({
        args: { ok: true },
        document,
        handleEvent: (event) => {
          events.push(event.type);
        },
        handleRequest: async () => {
          throw new Error("agent should not run");
        },
        workingDirectory: tempRoot,
      });

      expect(document.meta.name).toBe("review");
      expect(result.value).toEqual({ ok: true });
      expect(events).toEqual(["phase", "log"]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("persists inline Workflow tool scripts under session storage before launch", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-workflow-tool-"));
    const fileSystemPort = createNodeFileSystemAdapter();
    const traceContext = createRootTraceContext({
      sessionId: createSessionId("workflow-tool-inline"),
    });
    const launched: Array<{ runId?: string; scriptPath: string }> = [];
    const workflowPort = createScriptWorkflowToolPort({
      fileSystemPort,
      getRuntime: () =>
        ({
          run: async (input: { runId?: string; scriptPath: string }) => {
            launched.push(input);
            return {
              response: "done",
              runId: input.runId ?? "wf_missing",
              status: "completed",
              traceId: traceContext.traceId,
            };
          },
          resume: async () => {
            throw new Error("resume should not run");
          },
        }) as never,
      sessionId: createSessionId("workflow-tool-inline"),
      sessionStore: {} as never,
      storageRoot: tempRoot,
      traceContext,
      workingDirectory: tempRoot,
    });

    try {
      const result = await workflowPort.start({
        parentToolCallId: "tool_inline",
        script: minimalWorkflowScript("inline-review"),
        sessionId: createSessionId("workflow-tool-inline"),
        trace: traceContext,
        workingDirectory: tempRoot,
        workspaceRoot: tempRoot,
      });

      expect(result.runId).toMatch(/^wf_/);
      expect(result.scriptPath).toContain(join("cli", "sessions"));
      expect(await readFile(result.scriptPath!, "utf8")).toContain("inline-review");
      expect(launched[0]).toMatchObject({
        runId: result.runId,
        scriptPath: result.scriptPath,
      });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("resolves named Workflow tool scripts from project .zcode/workflows", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-workflow-name-"));
    const workflowDir = join(tempRoot, ".zcode", "workflows");
    const sourcePath = join(workflowDir, "review.workflow.js");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(sourcePath, minimalWorkflowScript("review"), "utf8");

    const fileSystemPort = createNodeFileSystemAdapter();
    const traceContext = createRootTraceContext({
      sessionId: createSessionId("workflow-tool-name"),
    });
    const workflowPort = createScriptWorkflowToolPort({
      fileSystemPort,
      getRuntime: () =>
        ({
          run: async (input: { runId?: string; scriptPath: string }) => ({
            response: input.scriptPath,
            runId: input.runId ?? "wf_missing",
            status: "completed",
            traceId: traceContext.traceId,
          }),
          resume: async () => {
            throw new Error("resume should not run");
          },
        }) as never,
      sessionId: createSessionId("workflow-tool-name"),
      sessionStore: {} as never,
      storageRoot: tempRoot,
      traceContext,
      workingDirectory: tempRoot,
    });

    try {
      const result = await workflowPort.start({
        name: "review",
        parentToolCallId: "tool_named",
        sessionId: createSessionId("workflow-tool-name"),
        trace: traceContext,
        workingDirectory: tempRoot,
        workspaceRoot: tempRoot,
      });

      expect(result.name).toBe("review");
      expect(result.scriptPath).not.toBe(sourcePath);
      expect(await readFile(result.scriptPath!, "utf8")).toContain("review");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("detaches background Workflow run from the launch abort signal after start", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-workflow-detach-"));
    const fileSystemPort = createNodeFileSystemAdapter();
    const traceContext = createRootTraceContext({
      sessionId: createSessionId("workflow-tool-detach"),
    });
    const runStarted = deferred<void>();
    const runMayFinish = deferred<void>();
    let observedRunSignal: AbortSignal | undefined;
    const workflowPort = createScriptWorkflowToolPort({
      fileSystemPort,
      getRuntime: () =>
        ({
          run: async (
            input: { runId?: string; scriptPath: string },
            options?: { abortSignal?: AbortSignal },
          ) => {
            observedRunSignal = options?.abortSignal;
            runStarted.resolve();
            await runMayFinish.promise;
            if (options?.abortSignal?.aborted) {
              throw options.abortSignal.reason ?? new Error("workflow aborted");
            }
            return {
              response: "done",
              runId: input.runId ?? "wf_missing",
              status: "completed",
              traceId: traceContext.traceId,
            };
          },
          resume: async () => {
            throw new Error("resume should not run");
          },
        }) as never,
      sessionId: createSessionId("workflow-tool-detach"),
      sessionStore: {} as never,
      storageRoot: tempRoot,
      traceContext,
      workingDirectory: tempRoot,
    });
    const launchController = new AbortController();

    try {
      const result = await workflowPort.start(
        {
          parentToolCallId: "tool_detach",
          script: minimalWorkflowScript("detach-review"),
          sessionId: createSessionId("workflow-tool-detach"),
          trace: traceContext,
          workingDirectory: tempRoot,
          workspaceRoot: tempRoot,
        },
        { signal: launchController.signal },
      );
      await runStarted.promise;

      launchController.abort(new Error("parent turn cancelled"));

      expect(observedRunSignal).toBeTruthy();
      expect(observedRunSignal).not.toBe(launchController.signal);
      expect(observedRunSignal?.aborted).toBe(false);

      runMayFinish.resolve();
      const snapshot = await workflowPort.waitForTask(result.runId);
      expect(snapshot).toMatchObject({
        status: "completed",
        taskId: result.runId,
      });
    } finally {
      runMayFinish.resolve();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("persists child sessions before linking workflow activities", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-workflow-child-session-"));
    const workflowDir = join(tempRoot, ".zcode", "workflows");
    const shellDir = join(tempRoot, "bin");
    const scriptPath = join(workflowDir, "child-session.workflow.js");
    const zshPath = join(shellDir, "zsh");
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    await mkdir(workflowDir, { recursive: true });
    await mkdir(shellDir, { recursive: true });
    await writeFile(zshPath, "#!/bin/sh\n");
    await chmod(zshPath, 0o755);
    await writeFile(
      scriptPath,
      `
        export const meta = {
          name: "child-session",
          description: "Verify child session persistence order",
          phases: [{ title: "Run" }],
        };

        phase("Run");
        const result = await agent("Say done.", {
          label: "clarify-goal",
          schema: {
            type: "object",
            properties: {
              done: { type: "boolean" },
            },
            required: ["done"],
          },
        });
        if (!result.done) throw new Error("Structured agent result was not returned to the script");
        return result;
      `,
      "utf8",
    );
    const requestTexts: string[] = [];

    try {
      const app = await createZCodeApp({
        env: {
          PATH: shellDir,
          SHELL: join(shellDir, "fish"),
        },
        modelExecutor: {
          setModelIoFullRetentionEnabled() {},
          async generateText(request: { messages: Array<{ content: unknown }> }) {
            requestTexts.push(JSON.stringify(request.messages));
            return {
              finishReason: "stop",
              text: '```json\n{"done":true}\n```',
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
        skipUserConfig: true,
      });

      const result = await app.runWorkflowScript?.({ scriptPath });
      expect(result?.status, result?.response).toBe("completed");
      const runId = result?.runId;
      expect(runId).toBeTruthy();
      const activities = await store.listScriptWorkflowActivities({ runId: runId! });
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        label: "clarify-goal",
        status: "completed",
      });
      expect(activities[0]!.childSessionId).toBeTruthy();
      const childSession = await store.getSession(activities[0]!.childSessionId!);
      expect(childSession?.taskType).toBe("workflow_child");
      const providerText = requestTexts.join("\n");
      expect(providerText).toContain("- Shell: zsh");
      expect(providerText).not.toContain("- Shell: fish");
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("App.close cancels a legacy workflow and waits for its real child turn", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-workflow-owned-close-"));
    const scriptPath = join(tempRoot, "owned.workflow.js");
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const started = deferred<void>();
    const cancelled = deferred<void>();
    const cleanup = deferred<void>();
    await writeFile(
      scriptPath,
      `export const meta = { name: "owned", description: "Close owned child" }; return await agent("Wait for cancellation");`,
    );
    const app = await createZCodeApp({
      modelExecutor: {
        setModelIoFullRetentionEnabled() {},
        async generateText(request: { abortSignal?: AbortSignal }) {
          started.resolve();
          await new Promise<void>((resolve) => {
            if (request.abortSignal?.aborted) resolve();
            else request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
          cancelled.resolve();
          await cleanup.promise;
          throw request.abortSignal?.reason;
        },
      } as never,
      runtimeConfig: { workingDirectory: tempRoot },
      sessionStore: store,
      skipUserConfig: true,
    });
    try {
      const running = app.runWorkflowScript!({ scriptPath });
      await started.promise;
      let closed = false;
      const closing = app.close!().then(() => {
        closed = true;
      });
      await cancelled.promise;
      expect(closed).toBe(false);
      cleanup.resolve();
      await closing;
      const result = await running;
      expect(result.status).toBe("cancelled");
      const activities = await store.listScriptWorkflowActivities({ runId: result.runId });
      expect(activities).toHaveLength(1);
      expect(activities[0]?.status).toBe("cancelled");
      expect(await store.getSession(activities[0]!.childSessionId!)).toBeTruthy();
      await expect(app.runWorkflowScript!({ scriptPath })).rejects.toThrow(/closed/);
    } finally {
      cleanup.resolve();
      await app.close?.();
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("Script Workflow 子 Runtime 继续使用进程 Registry 的 ModelFactory", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-workflow-provider-registry-"));
    const scriptPath = join(tempRoot, "registry.workflow.js");
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const createdModels: string[] = [];
    await writeFile(
      scriptPath,
      `
        export const meta = {
          name: "registry",
          description: "Verify Registry ModelFactory inheritance",
          phases: [{ title: "Run" }],
        };

        phase("Run");
        return await agent("Say done.", {
          schema: {
            type: "object",
            properties: { done: { type: "boolean" } },
            required: ["done"],
          },
        });
      `,
      "utf8",
    );

    try {
      const app = await createZCodeApp({
        env: {},
        modelAdapter: {
          addStatusSink() {},
          createModel() {
            createdModels.push("provider-a/model-a");
            return workflowRegistryModel();
          },
          setModelIoFullRetentionEnabled() {},
        } as never,
        providerRegistry: workflowProviderRegistry(),
        runtimeConfig: { mcp: { enabled: false }, workingDirectory: tempRoot },
        sessionStore: store,
        skipUserConfig: true,
      });

      const result = await app.runWorkflowScript?.({ scriptPath });

      expect(result?.status).toBe("completed");
      expect(createdModels.length).toBeGreaterThan(0);
      await app.close?.();
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

function workflowProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      providerId: "provider-a",
      config: createApiKeyProviderConfig({
        apiFormat: "anthropic-messages",
        apiKey: "registry-key",
        baseURL: "https://registry.example.com",
        models: ["model-a"],
      }),
      models: [
        {
          modelId: "model-a",
          config: new ModelConfig({
            properties: new ModelPropertiesConfig({
              requiresMfjsToolSchema: false,
              contextWindow: 200_000,
              inputFormat: {
                supportsText: true,
                supportsImage: false,
                supportsVideo: false,
                supportsAudio: false,
                supportsPdf: false,
              },
              outputFormat: { supportsText: true },
              supportsToolCall: true,
              supportsJsonSchemaOutput: true,
              supportsNativeWebSearch: false,
              supportsMidConversationSystem: false,
            }),
            optionSpecs: new ModelOptionSpecsConfig({
              reasoningLevel: {
                values: ["disabled"],
                map: "{}",
              },
              maxOutputTokens: {
                max: 32_000,
                map: '{"max_completion_tokens":maxOutputTokens}',
              },
            }),
          }),
        },
      ],
    },
  ]);
}

function workflowRegistryModel(): Model {
  const model: Model = {
    providerId: "provider-a" as Model["providerId"],
    modelId: "model-a" as Model["modelId"],
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: {
        values: ["disabled"],
        map: "{}",
      },
      maxOutputTokens: {
        max: 32_000,
        map: '{"max_completion_tokens":maxOutputTokens}',
      },
    },
    options: { maxOutputTokens: 8_000 },
    bind() {
      return this;
    },
    async generateText() {
      return {
        finishReason: "stop",
        text: '```json\n{"done":true}\n```',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    streamText() {
      throw new Error("not used");
    },
  };
  return model;
}

function minimalWorkflowScript(name: string): string {
  return `
    export const meta = {
      name: "${name}",
      description: "Test workflow",
      phases: [{ title: "Run" }],
    };
    phase("Run");
    return { ok: true };
  `;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

it("workflow child shutdown waits for in-flight agent request cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-close-"));
  const scriptPath = join(root, "close.workflow.js");
  await writeFile(
    scriptPath,
    'export const meta = { name: "close", description: "shutdown test" }; return await agent("work");',
  );
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const document = await readWorkflowScriptDocument({
    fileSystemPort: createNodeFileSystemAdapter(),
    scriptPath,
    traceContext: createRootTraceContext({ sessionId: createSessionId("workflow-close") }),
  });
  let settled = false;
  const running = runScriptWorkflowChild({
    document,
    signal: controller.signal,
    workingDirectory: root,
    handleEvent() {},
    handleRequest: async () => {
      started();
      await cleanup;
      return {};
    },
  });
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await ready;
    controller.abort(new Error("session closed"));
    // 等待进程退出这一真实边界；child activity 的清理由独立 barrier 控制。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    finish();
    await expect(running).rejects.toThrow("session closed");
  } finally {
    finish();
    await running.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

it("legacy workflow keeps a successful activity when child cleanup fails, then retries at close", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-release-"));
  const scriptPath = join(root, "success.workflow.js");
  await writeFile(
    scriptPath,
    'export const meta = { name: "success", description: "test" }; return await agent("Say done");',
  );
  const store = await createSqliteSessionStore({ dbPath: ":memory:" });
  const original = childFactory.createScriptWorkflowAgentRuntime;
  let attempts = 0;
  const spy = vi
    .spyOn(childFactory, "createScriptWorkflowAgentRuntime")
    .mockImplementation(async (input) => {
      // 子 runtime 创建要先建立 MCP 访问，工厂返回 Promise。
      const child = await original(input);
      const close = child.closeBrowserSession.bind(child);
      child.closeBrowserSession = async () => {
        if (++attempts === 1) throw new Error("transient release failure");
        await close();
      };
      return child;
    });
  const app = await createZCodeApp({
    skipUserConfig: true,
    sessionStore: store,
    runtimeConfig: { workingDirectory: root },
    modelExecutor: {
      setModelIoFullRetentionEnabled() {},
      async generateText() {
        return {
          text: "done",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    } as never,
  });
  try {
    const result = await app.runWorkflowScript!({ scriptPath });
    expect(result.status).toBe("completed");
    await expect(app.close!()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  } finally {
    spy.mockRestore();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
