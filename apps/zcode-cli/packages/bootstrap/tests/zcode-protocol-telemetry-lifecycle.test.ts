import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeProviderRuntimePathEnv } from "@zcode/provider-node";

const telemetryMocks = vi.hoisted(() => ({
  preparationOptions: [] as unknown[],
  discoveryOwners: [] as unknown[],
  disposePluginDiscovery: vi.fn(),
  preparePlugins: vi.fn(async () => []),
  disposePluginPreparation: vi.fn(async () => {}),
  createdApp: vi.fn(),
  preparationOwners: [] as unknown[],
  closeMcp: vi.fn(async () => {}),
  emitMcpOnStart: false,
  emitToolOnAppCreate: false,
  disposeProcessProviderRegistryRuntime: vi.fn(),
  disposeProviderRegistryRuntime: vi.fn(),
  prepareModelTelemetryEnv: vi.fn(async (env: Record<string, string | undefined>) => env),
  shutdownPreparedModelTelemetry: vi.fn(async () => {}),
}));

vi.mock("@zcode/adapters/plugins", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zcode/adapters/plugins")>();
  return {
    ...original,
    createNodePluginAdapter(options: Parameters<typeof original.createNodePluginAdapter>[0]) {
      const adapter = original.createNodePluginAdapter(options);
      const dispose = adapter.dispose.bind(adapter);
      adapter.dispose = () => {
        telemetryMocks.disposePluginDiscovery();
        dispose();
      };
      telemetryMocks.discoveryOwners.push(adapter);
      return adapter;
    },
  };
});

vi.mock("../src/app/bundled-plugins.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/app/bundled-plugins.js")>();
  return {
    ...original,
    createOfficialPluginPreparation(
      options: Parameters<typeof original.createOfficialPluginPreparation>[0],
    ) {
      const owner = {
        startupDegraded: false,
        resolvePlugins: async (resolve: () => Promise<unknown>) => await resolve(),
        prepare: telemetryMocks.preparePlugins,
        dispose: telemetryMocks.disposePluginPreparation,
        invalidate: () => {},
        signal: new AbortController().signal,
      };
      telemetryMocks.preparationOptions.push(options);
      telemetryMocks.preparationOwners.push(owner);
      return owner;
    },
  };
});

vi.mock("../src/app/process-provider-registry-runtime.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/app/process-provider-registry-runtime.js")>();
  return {
    ...original,
    async startProcessProviderRegistryRuntime(
      ...args: Parameters<typeof original.startProcessProviderRegistryRuntime>
    ) {
      const started = await original.startProcessProviderRegistryRuntime(...args);
      return {
        ...started,
        dispose() {
          telemetryMocks.disposeProcessProviderRegistryRuntime();
          started.dispose();
        },
        runtime: new Proxy(started.runtime, {
          get(target, property, receiver) {
            if (property !== "dispose") return Reflect.get(target, property, receiver);
            return () => {
              telemetryMocks.disposeProviderRegistryRuntime();
              target.dispose();
            };
          },
        }),
      };
    },
  };
});

vi.mock("@zcode/adapters/mcp", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zcode/adapters/mcp")>();
  return {
    ...original,
    createMcpAdapter: () => ({ close: telemetryMocks.closeMcp }),
    createMcpAdapterConnectionPool: () => ({
      acquireLease: () => ({ close: async () => {} }),
      close: telemetryMocks.closeMcp,
    }),
    createMcpTelemetryTracker(options: Parameters<typeof original.createMcpTelemetryTracker>[0]) {
      const tracker = original.createMcpTelemetryTracker(options);
      return {
        ...tracker,
        start() {
          tracker.start();
          if (!telemetryMocks.emitMcpOnStart) return;
          options.onResourceSamples?.([
            {
              mcpId: "builtin:node_repl",
              instanceToken: "cli-instance-01",
              sampledAt: 300000,
              intervalMs: 300000,
              processCount: 2,
              rssKbTotal: 120000,
              rssKbMaxProcess: 80000,
              cpuTimeMsDelta: 30000,
              uptimeMinutes: 5,
              platform: "linux",
              arch: "x64",
              logicalCpuCount: 8,
              totalMemoryGb: 32,
            },
          ]);
          options.onEvent({
            kind: "memory",
            mcpId: "builtin:node_repl",
            mcpInstanceId: "instance-1",
            mcpIsolation: "session",
            mcpSource: "builtin",
            memoryKb: 120000,
            memoryScope: "process_tree",
            orphanSuspected: false,
            ownerSessionCount: 1,
            unownedSeconds: 0,
            platform: "linux",
            arch: "x64",
            occurredAt: 300000,
          });
        },
      };
    },
  };
});

// 在 App 装配边界模拟已结束的 Bash，验证入口不会把回调丢在配置透传途中。
vi.mock("../src/app/create-app.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/app/create-app.js")>();
  return {
    ...original,
    async createZCodeApp(options: Parameters<typeof original.createZCodeApp>[0]) {
      telemetryMocks.createdApp(options);
      if (telemetryMocks.emitToolOnAppCreate)
        options.onToolExecResource?.({
          platform: "linux",
          toolName: "bash",
          durationMs: 40000,
          exitKind: "completed",
          sampleCount: 2,
          treeRssKbPeak: 300,
          treeCpuTimeMs: 6000,
          cliRssKb: 1024,
          systemFreeMemoryKb: 2048,
        });
      if (telemetryMocks.emitToolOnAppCreate)
        throw new Error("test app completed telemetry handoff");
      return original.createZCodeApp(options);
    },
  };
});

vi.mock("@zcode/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/telemetry")>()),
  prepareModelTelemetryEnv: telemetryMocks.prepareModelTelemetryEnv,
  shutdownPreparedModelTelemetry: telemetryMocks.shutdownPreparedModelTelemetry,
}));

import { runZCodeProtocolAgent } from "../src/zcode-protocol-entrypoint.js";

describe("ZCode Protocol telemetry lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
    telemetryMocks.emitMcpOnStart = false;
    telemetryMocks.emitToolOnAppCreate = false;
    telemetryMocks.preparationOwners = [];
    telemetryMocks.discoveryOwners = [];
    telemetryMocks.preparationOptions = [];
  });

  it("does not enable the plugin startup budget or emit a degraded notification", async () => {
    const chunks: string[] = [];
    await runProtocolAgent(undefined, chunks);
    // 冷启动 seed 在 Windows 实测约 3 秒，协议进程停用 3 秒预算；入口不得再传预算参数。
    expect(telemetryMocks.preparationOptions).toEqual([undefined]);
    const messages = chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(messages.some((message) => message.method === "startup/pluginsDegraded")).toBe(false);
  });

  it("prewarms plugins without a session and disposes the process preparation owner", async () => {
    await runProtocolAgent(undefined);
    expect(telemetryMocks.preparePlugins).toHaveBeenCalledOnce();
    expect(telemetryMocks.createdApp).not.toHaveBeenCalled();
    expect(telemetryMocks.disposePluginPreparation).toHaveBeenCalledOnce();
    expect(telemetryMocks.disposePluginDiscovery).toHaveBeenCalledOnce();
  });

  it.each([
    ["缺少注入时回退本地 Host", undefined, "desktop_local_host"],
    ["保留远程 Host 注入", "remote_workspace_host", "remote_workspace_host"],
  ] as const)("%s", async (_label, injectedSurface, expectedSurface) => {
    await runProtocolAgent(injectedSurface);

    expect(telemetryMocks.prepareModelTelemetryEnv).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        runtimeSurface: expectedSurface,
      }),
    );
    expect(telemetryMocks.shutdownPreparedModelTelemetry).toHaveBeenCalledOnce();
  });

  it("OTLP Owner 关闭失败保持旁路", async () => {
    telemetryMocks.shutdownPreparedModelTelemetry.mockRejectedValueOnce(
      new Error("exporter shutdown failed"),
    );

    await expect(runProtocolAgent(undefined)).resolves.toBeUndefined();
  });

  it("MCP 关闭失败仍继续关闭 OTLP Owner", async () => {
    telemetryMocks.closeMcp.mockRejectedValueOnce(new Error("mcp close failed"));

    await expect(runProtocolAgent(undefined)).resolves.toBeUndefined();

    expect(telemetryMocks.closeMcp).toHaveBeenCalledOnce();
    expect(telemetryMocks.shutdownPreparedModelTelemetry).toHaveBeenCalledOnce();
  });

  it("MCP 关闭悬空时有界等待并继续关闭 OTLP Owner", async () => {
    telemetryMocks.closeMcp.mockImplementationOnce(
      async () => await new Promise<void>(() => undefined),
    );

    await expect(runProtocolAgent(undefined)).resolves.toBeUndefined();

    expect(telemetryMocks.closeMcp).toHaveBeenCalledOnce();
    expect(telemetryMocks.shutdownPreparedModelTelemetry).toHaveBeenCalledOnce();
  }, 5_000);

  it("MCP 资源数组从入口发到新通知，旧 memory 内部事实不再发上协议", async () => {
    telemetryMocks.emitMcpOnStart = true;
    const chunks: string[] = [];
    await runProtocolAgent(undefined, chunks);
    const messages = chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(messages.filter((message) => message.method === "process/mcpResourceSamples")).toEqual([
      {
        method: "process/mcpResourceSamples",
        params: [expect.objectContaining({ mcpId: "builtin:node_repl", rssKbTotal: 120000 })],
      },
    ]);
    expect(
      messages.some(
        (message) => message.method === "process/mcpTelemetry" && message.params?.kind === "memory",
      ),
    ).toBe(false);
  });

  it("App 的 Bash 完成回调经入口进入独立协议通知", async () => {
    telemetryMocks.emitToolOnAppCreate = true;
    const chunks: string[] = [];
    await runProtocolAgent(undefined, chunks, true);
    expect(telemetryMocks.createdApp).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginPreparation: telemetryMocks.preparationOwners[0],
        pluginDiscovery: telemetryMocks.discoveryOwners[0],
      }),
    );
    const messages = chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(messages.find((message) => message.id === "test-create")?.error?.message).toBe(
      "test app completed telemetry handoff",
    );
    expect(messages.filter((message) => message.method === "process/toolExecResource")).toEqual([
      {
        method: "process/toolExecResource",
        params: expect.objectContaining({ toolName: "bash", durationMs: 40000 }),
      },
    ]);
  });

  it("Protocol 关闭时释放完整 Process Provider Registry Runtime owner", async () => {
    await runProtocolAgent(undefined);

    expect(telemetryMocks.disposeProcessProviderRegistryRuntime).toHaveBeenCalledOnce();
    expect(telemetryMocks.disposeProviderRegistryRuntime).not.toHaveBeenCalled();
  });
});

async function runProtocolAgent(
  runtimeSurface: "remote_workspace_host" | undefined,
  outputChunks?: string[],
  createSession = false,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-protocol-telemetry-lifecycle-"));
  try {
    const providerEnv = await createProtocolProviderEnv(root);
    const input = new PassThrough();
    if (createSession)
      input.write(
        JSON.stringify({
          id: "test-create",
          method: "session/create",
          params: { workspace: { workspacePath: root, workspaceKey: root } },
        }) + "\n",
      );
    else input.end();
    await runZCodeProtocolAgent({
      env: {
        ZCODE_LOG_DIR: join(root, "log"),
        ZCODE_SESSION_DB_PATH: join(root, "session.sqlite"),
        ZCODE_STORAGE_DIR: root,
        ...providerEnv,
        ...(runtimeSurface ? { ZCODE_TELEMETRY_RUNTIME_SURFACE: runtimeSurface } : {}),
      },
      input,
      output: new Writable({
        write(chunk, _encoding, callback) {
          outputChunks?.push(chunk.toString());
          if (createSession)
            for (const line of chunk.toString().split("\n").filter(Boolean)) {
              const message = JSON.parse(line);
              if (message.method === "session/requestRuntimePreferences")
                input.write(
                  JSON.stringify({
                    id: message.id,
                    result: { nativeSearchEnhancementsEnabled: false },
                  }) + "\n",
                );
            }
          if (
            createSession &&
            chunk
              .toString()
              .split("\n")
              .filter(Boolean)
              .some((line: string) => JSON.parse(line).id === "test-create")
          )
            input.end();
          callback();
        },
      }),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function createProtocolProviderEnv(root: string): Promise<Record<string, string>> {
  const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
  const personalFilePath = join(root, "provider-personal.json");
  const emptyBuiltinRelease = JSON.stringify({
    // 旧 fixture 使用已退出的 v2 展开结构，导致生命周期尚未启动就被 schema 拒绝。
    schemaVersion: 1,
    revision: 1,
    config: {
      providerConfigRules: { providerRules: [], templateRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  });
  const emptyPersonalConfig = JSON.stringify({
    schemaVersion: 1,
    providers: {},
    modelConfigRules: [],
  });
  await Promise.all([
    writeFile(zcodeBuiltinFilePath, emptyBuiltinRelease),
    writeFile(personalFilePath, emptyPersonalConfig),
  ]);
  return createNodeProviderRuntimePathEnv({ zcodeBuiltinFilePath, personalFilePath });
}
