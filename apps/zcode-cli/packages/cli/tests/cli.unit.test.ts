import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, ZCODE_PLUGIN_HOST_COMMAND } from "@zcode/contracts";
import {
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
  ZCODE_RUNTIME_ENV_KEY,
  readZCodeToolEnvPassthroughEnv,
  resetCapturedZCodeCuaBrokerCredentialsForTest,
  sanitizeZCodeRuntimeEnvInPlace,
  type ModelSelection,
  type ZCodeModelOption,
} from "@zcode/shared";
import type { RunContext } from "@zcode/shared-types";
import type { TuiOptions } from "@zcode/tui";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import { run } from "../src/run.js";
import { createTuiSubmitPrompt } from "../src/tui-prompt-handler.js";
import {
  buildManualSkillPrompt,
  createCommandCenter,
  parseSlashCommand,
} from "../src/command-center.js";
import type { CommandCenterTarget } from "../src/command-center.js";
import { expandCliCustomCommandPrompt } from "../src/custom-command-expand.js";
import { findDotenv, loadCliDotenv, prepareCliRuntimeEnv } from "../src/env.js";
import { runPluginsCommand } from "../src/plugins-command.js";
import { runPluginHostCommand } from "../src/plugin-host-command.js";
import { CLI_PROCESS_NAME, setCliProcessTitle } from "../src/process-name.js";
import { loadCliPlaywrightChromium } from "../src/sea-playwright-runtime.js";
import { interceptKnownRuntimeWarnings } from "../src/runtime-warnings.js";
import { installStderrConsoleBoundary } from "../src/protocol-console.js";
import { interceptTuiStderr, isTuiInvocation } from "../src/tui-stderr.js";
import { resolveWorkspaceGitBranch } from "../src/tui-workspace-git.js";
import { createWorkspacePathSuggestionProvider } from "../src/tui-workspace-paths.js";
import type { RunDependencies } from "../src/run.js";
import { scheduleCliExitWatchdog, type CliShutdownProcess } from "../src/shutdown.js";

type CapturedWriteStream = NodeJS.WriteStream & {
  output: () => string;
};

const createWriteStream = (isTTY = false): CapturedWriteStream => {
  let output = "";

  return {
    isTTY,
    output: () => output,
    write: (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void,
    ): boolean => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      const writeCallback =
        typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      writeCallback?.();
      return true;
    },
  } as CapturedWriteStream;
};

const createContext = (
  argv: string[],
): RunContext & {
  stderr: CapturedWriteStream;
  stdout: CapturedWriteStream;
} => ({
  argv,
  stderr: createWriteStream(),
  stdin: {
    isTTY: false,
  } as NodeJS.ReadStream,
  stdout: createWriteStream(),
});

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string) => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const fakeProjection = {
  contextUsed: 0,
  contextWindow: 0,
  status: "idle",
  totalTokenCount: 0,
  turnCount: 1,
};

/** 协议 Model Option 测试夹具；TUI 登录态由 App 模型目录中是否存在可选模型推导。 */
const createTestModelOption = (
  providerId: string,
  modelId: string,
  {
    defaultLevel = "medium",
    label = modelId,
    levels = ["low", "medium", "high"],
  }: { defaultLevel?: string; label?: string; levels?: readonly string[] } = {},
): ZCodeModelOption => ({
  ref: { providerId, modelId },
  label,
  providerLabel: providerId,
  reasoning: {
    levels: levels.map((value) => ({ value, label: value })),
    defaultLevel,
  },
  properties: {
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
  },
});

/** 至少一个未禁用的模型，表示 Provider/账号已可用，普通 prompt 不会被登录提示拦截。 */
const selectableTestModels = (): ZCodeModelOption[] => [
  createTestModelOption("openai", "gpt-test"),
];

/**
 * 真实 runTui 先绘制启动屏，再调用 loadStartupOptions 并把结果合并进 TUI 选项；
 * 测试替身按同一顺序模拟启动，断言 TUI 最终拿到的初始模型、主题、命令等数据。
 */
const loadTuiStartup = async (options: TuiOptions): Promise<TuiOptions> => ({
  ...options,
  ...(await options.loadStartupOptions?.()),
});

const createPromptDeps = (): RunDependencies => ({
  createModelAdapter: () => ({}) as never,
  createZCodeApp: () =>
    ({
      getModel: () => "openai/gpt-test",
      getLocale: () => "en-US",
      getThoughtLevel: () => "medium",
      listModels: selectableTestModels,
      sessionId: "session-test",
      traceId: "trace-test",
      runtime: {} as never,
      submitPrompt: async (prompt: string) => ({
        events: [{} as never, {} as never],
        projection: fakeProjection as never,
        response: prompt,
        traceId: "trace-test" as never,
        turnId: "turn-test" as never,
      }),
    }) as never,
  loadDotenv: () => ({
    keys: [],
    loaded: false,
  }),
  startProcessProviderRegistryRuntime: async () =>
    ({
      dispose: () => {},
      runtime: { registryService: {} },
    }) as never,
  skipUserConfig: true,
});

test("prepares a sanitized CLI runtime env with ZCode-owned runtime keys", () => {
  const sourceEnv = {
    NODE_ENV: "development",
    HTTP_PROXY: "http://ambient-proxy:8080",
    NODE_EXTRA_CA_CERTS: "/tmp/ambient-ca.pem",
    ZCODE_HTTP_PROXY: "http://zcode-proxy:8080",
    no_proxy: ".example.test",
    npm_config_proxy: "http://npm-proxy:8080",
  };

  const env = prepareCliRuntimeEnv(sourceEnv, ["/usr/bin/node", "/workspace/bin/zcode.js"]);
  const toolEnv = readZCodeToolEnvPassthroughEnv(env);

  assert.equal(env.ZCODE_RUNTIME_ENV, "production");
  assert.equal(env.ZCODE_HTTP_PROXY, "http://zcode-proxy:8080");
  assert.deepEqual(toolEnv, {
    HTTP_PROXY: "http://ambient-proxy:8080",
    NODE_EXTRA_CA_CERTS: "/tmp/ambient-ca.pem",
    no_proxy: ".example.test",
    npm_config_proxy: "http://npm-proxy:8080",
  });
  assert.equal(env.NODE_ENV, undefined);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.NODE_EXTRA_CA_CERTS, undefined);
  assert.equal(env.no_proxy, undefined);
  assert.equal(env.npm_config_proxy, undefined);
  assert.equal(sourceEnv.NODE_ENV, "development");
});

test("prepares beta CLI runtime env with beta storage root", () => {
  const env = prepareCliRuntimeEnv(
    {
      ZCODE_BETA: "1",
    },
    ["/usr/bin/node", "/workspace/bin/zcode.js"],
  );

  assert.equal(env.ZCODE_STORAGE_DIR, join(homedir(), ".zcode-beta"));
});

test("preserves explicit storage root when beta mode is enabled", () => {
  const env = prepareCliRuntimeEnv(
    {
      ZCODE_BETA: "1",
      ZCODE_STORAGE_DIR: "/tmp/custom-zcode-home",
    },
    ["/usr/bin/node", "/workspace/bin/zcode.js"],
  );

  assert.equal(env.ZCODE_STORAGE_DIR, "/tmp/custom-zcode-home");
});

test("opens the TUI by default", async () => {
  const ctx = createContext([]);
  let opened = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    runTui: async (options) => {
      opened = true;
      assert.equal(options.stdin, ctx.stdin);
      // 启动屏先于运行时绘制：模型、主题、命令等启动数据改由 loadStartupOptions 在首帧后提供。
      const startup = await loadTuiStartup(options);
      assert.equal(startup.initialModel, "openai/gpt-test");
      assert.equal(startup.initialThoughtLevel, "medium");
      assert.equal(startup.theme, "auto");
      assert.equal(typeof options.listMcpServers, "function");
      assert.equal(typeof options.listWorkspacePathSuggestions, "function");
      assert.equal(typeof options.submitPrompt, "function");
      assert.equal(typeof options.writeClipboardText, "function");
      assert.ok(startup.slashCommands?.some((command) => command.name === "model"));
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(opened, true);
  assert.equal(ctx.stdout.output(), "");
  assert.equal(ctx.stderr.output(), "");
});

test("ignores ambient NODE_ENV when deciding TUI developer mode", async () => {
  const ctx = createContext([]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    env: {
      NODE_ENV: "development",
    },
    runTui: async (options) => {
      assert.equal(options.developerMode, false);
      return 0;
    },
  });

  assert.equal(exitCode, 0);
});

test("passes developer mode, version, and workspace git branch into the TUI", async () => {
  const ctx = createContext([]);
  const workspaceDirectory = "/workspace/dev";
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    cwd: () => workspaceDirectory,
    env: {
      ZCODE_RUNTIME_ENV: "development",
    },
    resolveWorkspaceGitBranch: async (options) => {
      assert.equal(options.workspaceDirectory, workspaceDirectory);
      return "feature/sidebar";
    },
    runTui: async (options) => {
      assert.equal(options.developerMode, true);
      assert.equal(options.version, "0.0.0");
      assert.equal(options.workspaceDirectory, workspaceDirectory);
      // Git 分支解析不阻塞首帧，随 loadStartupOptions 一起返回。
      const startup = await loadTuiStartup(options);
      assert.equal(startup.workspaceGitBranch, "feature/sidebar");
      return 0;
    },
  });

  assert.equal(exitCode, 0);
});

test("resolves workspace git branch from a non-shell git command", async () => {
  const branch = await resolveWorkspaceGitBranch({
    workspaceDirectory: "/workspace/project",
    runCommand: async (file, args) => {
      assert.equal(file, "git");
      assert.deepEqual(args, [
        "-C",
        "/workspace/project",
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      return { exitCode: 0, stdout: "main\n" };
    },
  });

  assert.equal(branch, "main");
});

test("ignores missing workspace git branch", async () => {
  assert.equal(
    await resolveWorkspaceGitBranch({
      workspaceDirectory: "/workspace/project",
      runCommand: async () => ({ exitCode: 1, stdout: "" }),
    }),
    undefined,
  );
  assert.equal(
    await resolveWorkspaceGitBranch({
      workspaceDirectory: "/workspace/project",
      runCommand: async () => ({ exitCode: 0, stdout: "HEAD\n" }),
    }),
    undefined,
  );
});

test("passes configured TUI theme into the TUI", async () => {
  const ctx = createContext([]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () =>
      ({
        getLocale: () => "en-US",
        getModel: () => "openai/gpt-test",
        getTheme: () => "light",
        getThoughtLevel: () => "medium",
        runtime: {} as never,
        sessionId: "session-test",
        submitPrompt: async () => {
          throw new Error("submitPrompt should not be called");
        },
        traceId: "trace-test",
      }) as never,
    runTui: async (options) => {
      const startup = await loadTuiStartup(options);
      assert.equal(startup.theme, "light");
      return 0;
    },
  });

  assert.equal(exitCode, 0);
});

test("suggests workspace paths for TUI file mentions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-tui-paths-"));

  try {
    await mkdir(join(dir, "public"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "public", "app.ts"), "export {}", "utf8");
    await writeFile(join(dir, "puzzle.md"), "# puzzle", "utf8");
    await writeFile(join(dir, ".hidden.md"), "# hidden", "utf8");

    const suggest = createWorkspacePathSuggestionProvider({ workspaceDirectory: dir });

    assert.deepEqual(await suggest({ token: "pu" }), {
      items: [
        { kind: "directory", path: "public/" },
        { kind: "file", path: "puzzle.md" },
      ],
      truncated: false,
    });
    assert.deepEqual(await suggest({ token: "public/" }), {
      items: [{ kind: "file", path: "public/app.ts" }],
      truncated: false,
    });
    assert.deepEqual(await suggest({ token: "../" }), {
      items: [],
      truncated: false,
    });
    assert.equal(
      (await suggest({ token: "" })).items.some((item) => item.path === ".hidden.md"),
      false,
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("enables session title generation for TUI sessions", async () => {
  const ctx = createContext(["tui"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.deepEqual(options?.runtimeConfig?.titleGeneration, {});
      assert.equal(options?.runtimeConfig?.memory?.extractionEnabled, undefined);
      return {
        getLocale: () => "en-US",
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    runTui: async () => 0,
  });

  assert.equal(exitCode, 0);
});

test("passes --disallowedTools into TUI runtime config", async () => {
  const ctx = createContext(["tui", "--disallowedTools", "Bash", "Edit,web_search"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.deepEqual(options?.runtimeConfig?.toolDisallowlist, ["Bash", "Edit", "WebSearch"]);
      return {
        getLocale: () => "en-US",
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    runTui: async () => 0,
  });

  assert.equal(exitCode, 0);
});

test("passes force MCS into TUI runtime config", async () => {
  const ctx = createContext(["tui", "--force-mcs"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.deepEqual((options?.runtimeConfig as any)?.midConversationSystem, {
        mode: "force",
      });
      return {
        getLocale: () => "en-US",
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    runTui: async () => 0,
  });

  assert.equal(exitCode, 0);
});

test("does not enable session title generation for headless prompts", async () => {
  const ctx = createContext(["--prompt", "hello"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.equal(options?.runtimeConfig?.titleGeneration, undefined);
      assert.equal(options?.standaloneSessionControl, true);
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        close: async () => {},
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello\n");
});

test("disables automatic Memory Extraction for headless prompts", async () => {
  const ctx = createContext(["-p", "hello Memory"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.deepEqual(options?.runtimeConfig?.memory, {
        extractionEnabled: false,
      });
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        close: async () => {},
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello Memory\n");
});

test("injects process provider endpoint routing into headless prompts", async () => {
  const ctx = createContext(["--prompt", "route me"]);
  const providerEndpointRoutingPort = {
    async resolve(url: string) {
      return { routed: false, url };
    },
  };
  let routingFactoryCalls = 0;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createProviderEndpointRoutingPort: (options) => {
      routingFactoryCalls += 1;
      assert.equal(options.workingDirectory, "/tmp/zcode-routing-headless");
      return providerEndpointRoutingPort;
    },
    createZCodeApp: (options) => {
      assert.equal(options?.providerEndpointRoutingPort, providerEndpointRoutingPort);
      return {
        close: async () => {},
        runtime: {} as never,
        sessionId: "session-routing-headless",
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-routing-headless" as never,
          turnId: "turn-routing-headless" as never,
        }),
        traceId: "trace-routing-headless",
      } as never;
    },
    cwd: () => "/tmp/zcode-routing-headless",
  });

  assert.equal(exitCode, 0);
  assert.equal(routingFactoryCalls, 1);
  assert.equal(ctx.stdout.output(), "route me\n");
});

test("borrows one process provider registry for a headless prompt and disposes it", async () => {
  const ctx = createContext(["--prompt", "registry me"]);
  const providerRegistry = {} as never;
  const providerRuntimeHeadersPort = {} as never;
  let runtimeStarts = 0;
  let runtimeDisposals = 0;
  let selectionRepositoryDisposals = 0;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    skipUserConfig: false,
    userConfigPath: "/tmp/zcode-legacy-cli.json",
    startProcessProviderRegistryRuntime: async (_env, options) => {
      runtimeStarts += 1;
      // 刷新回调是当前 CLI 装配的一部分，仍验证唯一 Runtime 和旧配置迁移路径。
      assert.equal(typeof options?.standalone?.onBuiltinRefreshError, "function");
      assert.equal(typeof options?.standalone?.onBuiltinRefreshResult, "function");
      assert.deepEqual(
        {
          standalone: {
            legacyCliUserConfigFilePath: options?.standalone?.legacyCliUserConfigFilePath,
          },
        },
        {
          standalone: {
            legacyCliUserConfigFilePath: "/tmp/zcode-legacy-cli.json",
          },
        },
      );
      return {
        accountSource: {} as never,
        dispose: () => {
          selectionRepositoryDisposals += 1;
          runtimeDisposals += 1;
        },
        configuredDefaultModelSelection: { providerId: "provider-a", modelId: "model-a" },
        modelSelectionConfigRepository: {
          dispose: () => {
            selectionRepositoryDisposals += 1;
          },
          read: async () => ({ providerId: "provider-a", modelId: "model-a" }),
        },
        providerRuntimeHeadersPort,
        snapshot: {} as never,
        runtime: {
          dispose: () => {
            runtimeDisposals += 1;
          },
          registryService: providerRegistry,
        },
      } as never;
    },
    createZCodeApp: (options) => {
      assert.equal(options?.providerRegistry, providerRegistry);
      assert.equal(options?.providerRuntimeHeadersPort, providerRuntimeHeadersPort);
      assert.deepEqual(options?.configuredDefaultModelSelection, {
        providerId: "provider-a",
        modelId: "model-a",
      });
      return {
        close: async () => {},
        runtime: {} as never,
        sessionId: "session-registry-headless",
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-registry-headless" as never,
          turnId: "turn-registry-headless" as never,
        }),
        traceId: "trace-registry-headless",
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(runtimeStarts, 1);
  assert.equal(runtimeDisposals, 1);
  assert.equal(selectionRepositoryDisposals, 1);
});

test("shows a non-blocking login notice when no coding plan key is configured", async () => {
  const ctx = createContext([]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    // 登录态改由 Registry 的可选模型推导：未配置 Coding Plan 时模型目录只有被禁用的选项。
    createZCodeApp: () =>
      ({
        getLocale: () => "en-US",
        getModel: () => undefined,
        listModels: () => [
          {
            ...createTestModelOption("zai", "glm-5.1"),
            disabledReason: "Sign in to Z.AI Coding Plan first.",
          },
        ],
        runtime: {} as never,
        sessionId: "session-test",
        submitPrompt: async () => {
          throw new Error("submitPrompt should not be called");
        },
        traceId: "trace-test",
      }) as never,
    runTui: async (options) => {
      const startup = await loadTuiStartup(options);
      assert.equal(startup.loginRequired, true);
      assert.equal(startup.initialResult, undefined);
      return 0;
    },
  });

  assert.equal(exitCode, 0);
});

test("honors configured locale before app creation when login is required", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "zcode-cli-prelogin-locale-"));
  const configPath = join(tempRoot, "config.json");
  await writeFile(configPath, JSON.stringify({ ui: { locale: "zh-CN" } }));

  try {
    const ctx = createContext([]);
    let appCreated = false;
    const exitCode = await run(ctx, {
      cwd: () => tempRoot,
      env: {},
      // 登录态改由 App 的可选模型推导；App 在启动屏首帧之后才创建，这里模拟没有可选模型。
      createZCodeApp: () => {
        appCreated = true;
        return {
          listModels: () => [],
          runtime: {} as never,
          sessionId: "session-prelogin",
          submitPrompt: async () => {
            throw new Error("submitPrompt should not be called");
          },
          traceId: "trace-prelogin",
        } as never;
      },
      listCustomCommands: async () =>
        ({
          commands: [],
          diagnostics: [],
          totalDiscovered: 0,
        }) as never,
      loadDotenv: () => ({
        keys: [],
        loaded: false,
      }),
      startProcessProviderRegistryRuntime: async () =>
        ({
          dispose: () => {},
          runtime: { registryService: {} },
        }) as never,
      runTui: async (options) => {
        // 启动屏在 App 创建前就按用户配置的语言渲染。
        assert.equal(options.locale, "zh-CN");
        assert.equal(appCreated, false);

        const startup = await loadTuiStartup(options);
        assert.equal(startup.loginRequired, true);
        assert.equal(startup.locale, "zh-CN");

        const pickerResult = await options.submitPrompt("/login", {
          abortSignal: new AbortController().signal,
        });

        assert.equal(pickerResult.response, "选择 Coding Plan 提供商的配置方式。");
        assert.equal(pickerResult.selection?.title, "配置 Coding Plan");
        assert.equal(pickerResult.selection?.prompt, "选择登录或 API key 配置方式。");
        return 0;
      },
      userConfigPath: configPath,
    });

    assert.equal(exitCode, 0);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("passes detected auto locale into the app and TUI", async () => {
  const ctx = createContext(["--locale", "auto"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.equal(options?.uiLocale, "auto");
      assert.equal(options?.uiDetectedLocale, "zh-CN");
      return {
        getLocale: () => "zh-CN",
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        runtime: {} as never,
        sessionId: "session-test",
        submitPrompt: async () => {
          throw new Error("submitPrompt should not be called");
        },
        traceId: "trace-test",
      } as never;
    },
    env: {
      LANG: "zh_CN.UTF-8",
    },
    runTui: async (options) => {
      assert.equal(options.locale, "zh-CN");
      return 0;
    },
  });

  assert.equal(exitCode, 0);
});

test("TUI locale command updates later app creation locale", async () => {
  const ctx = createContext(["--locale", "en-US"]);
  const createdLocales: Array<unknown> = [];
  let activeLocale: "en-US" | "zh-CN" = "en-US";
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      createdLocales.push(options?.uiLocale);
      return {
        getLocale: () => activeLocale,
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        runtime: {} as never,
        sessionId: `session-${createdLocales.length}`,
        setLocale: async (locale: "auto" | "en-US" | "zh-CN") => {
          activeLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
          return {
            configPath: "/tmp/zcode/config.json",
            locale: activeLocale,
            previousLocale: "en-US",
            requestedLocale: locale,
            traceId: "trace-test" as never,
          };
        },
        submitPrompt: async () => {
          throw new Error("submitPrompt should not be called");
        },
        traceId: `trace-${createdLocales.length}`,
      } as never;
    },
    runTui: async (options) => {
      // 真实 TUI 首帧后即创建初始 App；/locale 由该 App 持久化，不会落到默认用户配置文件。
      await loadTuiStartup(options);
      const switched = await options.submitPrompt("/locale zh-CN", {
        abortSignal: new AbortController().signal,
      });
      const created = await options.submitPrompt("/new", {
        abortSignal: new AbortController().signal,
      });

      assert.equal(switched.locale, "zh-CN");
      assert.equal(created.locale, "zh-CN");
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(createdLocales, ["en-US", "zh-CN"]);
});

test("prints localized CLI help with explicit locale", async () => {
  const ctx = createContext(["--help", "--locale", "zh-CN"]);
  const exitCode = await run(ctx, createPromptDeps());

  assert.equal(exitCode, 0);
  assert.match(ctx.stdout.output(), /用法:/);
  assert.match(ctx.stdout.output(), /--locale <locale>/);
});

test("prints localized CLI help with auto locale detection", async () => {
  const ctx = createContext(["--help", "--locale", "auto"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    env: {
      LC_ALL: "zh_CN.UTF-8",
    },
  });

  assert.equal(exitCode, 0);
  assert.match(ctx.stdout.output(), /用法:/);
});

test("passes custom command suggestions into the TUI", async () => {
  const ctx = createContext([]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    listCustomCommands: async () =>
      ({
        commands: [
          {
            allowedTools: [],
            argumentHint: "[scope]",
            description: "Review custom changes",
            disableNonInteractive: false,
            frontmatterKeys: [],
            name: "review",
            path: "/workspace/.zcode/commands/review.md",
            rootPath: "/workspace/.zcode/commands",
            scope: "project",
            source: "zcode",
          },
        ],
        diagnostics: [],
        totalDiscovered: 1,
      }) as never,
    runTui: async (options) => {
      // 自定义命令扫描与首帧并行，随 loadStartupOptions 返回。
      const startup = await loadTuiStartup(options);
      assert.ok(startup.slashCommands?.some((command) => command.name === "review"));
      assert.ok(startup.slashCommands?.some((command) => command.usage === "/review [scope]"));
      return 0;
    },
  });

  assert.equal(exitCode, 0);
});

test("command center expands custom commands before submitting to runtime", async () => {
  let submittedPrompt = "";
  const commandCenter = createCommandCenter({
    getApp: async () =>
      ({
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        sessionId: "session-custom",
        traceId: "trace-custom",
        submitPrompt: async (prompt: string) => {
          submittedPrompt = prompt;
          return {
            projection: fakeProjection as never,
            response: prompt,
            traceId: "trace-custom" as never,
            turnId: "turn-custom" as never,
          };
        },
      }) as never,
    getMode: () => "build",
    loadCustomCommand: async () =>
      ({
        content: "Review $1 and $ARGUMENTS.",
        metadata: {
          description: "Review custom changes",
          name: "review",
          path: "/workspace/.zcode/commands/review.md",
          scope: "project",
          source: "zcode",
        },
      }) as never,
    resumeApp: async () => {
      throw new Error("resume should not be called");
    },
  });

  const result = await commandCenter("/review auth high", {});

  assert.match(result.response, /Run custom command \/review/);
  assert.match(submittedPrompt, /Review auth and auth high/);
});

test("zcode commands list prints custom commands", async () => {
  const ctx = createContext(["commands"]);
  const logger = {} as NonNullable<RunDependencies["logger"]>;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    cwd: () => "/workspace/project",
    logger,
    listCustomCommands: async (options) => {
      assert.equal(options.logger, logger);
      assert.equal(options.workingDirectory, "/workspace/project");
      return {
        commands: [
          {
            allowedTools: [],
            argumentHint: "[scope]",
            description: "Review custom changes",
            disableNonInteractive: false,
            frontmatterKeys: [],
            name: "review",
            path: "/workspace/project/.zcode/commands/review.md",
            rootPath: "/workspace/project/.zcode/commands",
            scope: "project",
            source: "zcode",
          },
        ],
        diagnostics: [],
        totalDiscovered: 1,
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.match(ctx.stdout.output(), /Custom commands \(1\)/);
  assert.match(ctx.stdout.output(), /\/review \[scope\]/);
});

test("zcode login runs OAuth flow and prints the authorization URL", async () => {
  const ctx = createContext(["login", "--no-browser"]);
  let sawNoBrowser = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    loginZCodeCli: async (options) => {
      sawNoBrowser = options?.noBrowser === true;
      await options?.onAuthorizeUrl?.({
        authorize_url: "https://chat.z.ai/oauth/authorize?state=state",
        expires_at: 1735000000,
        flow_id: "flow-1",
        poll_interval_sec: 2,
        poll_token: "poll-token",
      });
      return {
        configPath: "/home/test/.zcode/v2/model-selection.json",
        credentialsPath: "/home/test/.zcode/v2/credentials.json",
        model: "zai/glm-5.1",
        providerId: "zai",
        user: {
          user_id: "u_1",
          email: "alice@example.com",
          name: "Alice",
        },
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(sawNoBrowser, true);
  assert.match(ctx.stdout.output(), /Open this URL to sign in/);
  assert.match(ctx.stdout.output(), /https:\/\/chat\.z\.ai\/oauth\/authorize/);
  assert.match(ctx.stdout.output(), /Login successful as Alice/);
  assert.match(
    ctx.stdout.output(),
    /Model selection: \/home\/test\/\.zcode\/v2\/model-selection\.json/,
  );
});

test("zcode logout clears shared OAuth credentials", async () => {
  const ctx = createContext(["logout"]);
  let logoutCalled = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    logoutZCodeCli: async () => {
      logoutCalled = true;
      return {
        credentialsPath: "/home/test/.zcode/v2/credentials.json",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(logoutCalled, true);
  assert.match(ctx.stdout.output(), /Logged out from Coding Plan accounts/);
});

test("parses login and logout slash commands", () => {
  assert.deepEqual(parseSlashCommand("/login"), {
    args: "",
    name: "login",
    rawName: "login",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/login zai-coding-plan"), {
    args: "zai-coding-plan",
    name: "login",
    rawName: "login",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/logout"), {
    args: "",
    name: "logout",
    rawName: "logout",
    type: "known",
  });
});

test("command center handles login and logout locally", async () => {
  let loginCalled = false;
  let loginAbortSignal: AbortSignal | undefined;
  let apiKeyCalled = false;
  let logoutCalled = false;
  const emittedEvents: Array<{
    payload?: unknown;
    sessionId?: unknown;
    traceId?: unknown;
    type?: string;
  }> = [];
  const commandCenter = createCommandCenter({
    // 授权链接消息归属当前活动会话（TUI 首帧后已创建 App），但登录流程本身不向模型提交 prompt。
    getApp: async () =>
      ({
        sessionId: "session-login",
        traceId: "trace-login",
        submitPrompt: async () => {
          throw new Error("login must not submit a model prompt");
        },
      }) as never,
    login: async (options) => {
      loginCalled = true;
      loginAbortSignal = options?.abortSignal;
      await options?.onAuthorizeUrl?.({
        authorize_url: "https://chat.z.ai/oauth/authorize?state=state",
        expires_at: 1735000000,
        flow_id: "flow-1",
        poll_interval_sec: 2,
      });
      return {
        configPath: "/home/test/.zcode/v2/model-selection.json",
        credentialsPath: "/home/test/.zcode/v2/credentials.json",
        model: "zai/glm-5.1",
        providerId: "zai",
        user: {
          user_id: "u_1",
          email: "alice@example.com",
          name: "Alice",
        },
      };
    },
    configureApiKey: async (options) => {
      apiKeyCalled = options.providerId === "bigmodel" && options.apiKey === "manual-key";
      return {
        configPath: "/home/test/.zcode/v2/model-selection.json",
        model: "bigmodel/glm-5.1",
        providerId: "bigmodel",
      };
    },
    logout: async () => {
      logoutCalled = true;
      return {
        credentialsPath: "/home/test/.zcode/v2/credentials.json",
      };
    },
    resumeApp: async () => {
      throw new Error("resume should not be called");
    },
  });

  const pickerResult = await commandCenter("/login", {});
  const loginAbort = new AbortController();
  const loginResult = await commandCenter("/login zai-coding-plan", {
    abortSignal: loginAbort.signal,
    onEvent: async (event) => {
      emittedEvents.push(event);
    },
  } as never);
  const apiKeyResult = await commandCenter("/login bigmodel-coding-plan-api-key manual-key", {});
  const logoutResult = await commandCenter("/logout", {});

  assert.equal(pickerResult.selection?.items.length, 4);
  assert.equal(pickerResult.selection?.filterable, false);
  assert.equal(
    pickerResult.selection?.items[0]?.pending?.primary,
    "Waiting for Z.AI authorization",
  );
  assert.equal(pickerResult.selection?.items[2]?.input?.primary, "Enter Z.AI Coding Plan API Key");
  assert.equal(pickerResult.selection?.items[2]?.input?.mask, true);
  assert.equal(loginAbortSignal, loginAbort.signal);
  assert.equal(loginCalled, true);
  assert.equal(apiKeyCalled, true);
  assert.equal(logoutCalled, true);
  assert.equal(emittedEvents[0]?.type, "assistant_message");
  assert.equal(emittedEvents[0]?.sessionId, "session-login");
  assert.equal(emittedEvents[0]?.traceId, "trace-login");
  assert.match(
    String((emittedEvents[0]?.payload as { content?: string } | undefined)?.content),
    /https:\/\/chat\.z\.ai\/oauth\/authorize/,
  );
  assert.match(loginResult.response, /Configured Z\.AI Coding Plan as Alice/);
  assert.match(
    loginResult.response,
    /Model selection: \/home\/test\/\.zcode\/v2\/model-selection\.json/,
  );
  assert.match(apiKeyResult.response, /Configured BigModel Coding Plan/);
  assert.match(logoutResult.response, /Logged out from Coding Plan accounts/);
});

test("command center localizes the Coding Plan setup picker", async () => {
  const commandCenter = createCommandCenter({
    getApp: async () => {
      throw new Error("app should not be created");
    },
    getLocale: () => "zh-CN",
    resumeApp: async () => {
      throw new Error("resume should not be called");
    },
  });

  const result = await commandCenter("/login", {});

  assert.equal(result.response, "选择 Coding Plan 提供商的配置方式。");
  assert.equal(result.selection?.title, "配置 Coding Plan");
  assert.equal(result.selection?.prompt, "选择登录或 API key 配置方式。");
  assert.equal(result.selection?.filterable, false);
  assert.match(result.selection?.items[0]?.secondary ?? "", /打开浏览器登录/);
  assert.equal(result.selection?.items[2]?.input?.primary, "输入 Z.AI Coding Plan API Key");
  assert.equal(result.selection?.items[2]?.input?.placeholder, "粘贴 API key");
});

test("command center keeps local commands usable before login", async () => {
  let appCreated = false;
  const commandCenter = createCommandCenter({
    getApp: async () => {
      appCreated = true;
      throw new Error("app should not be created before login");
    },
    getLocale: () => "en-US",
    // 登录判定改为“是否存在可选模型”，由注入的检查器回答，命令中心自身不创建 App。
    hasSelectableModels: async () => false,
    resumeApp: async () => {
      throw new Error("resume should not be called");
    },
    setLocale: async (locale) => ({
      locale: locale === "zh-CN" ? "zh-CN" : "en-US",
      requestedLocale: locale,
    }),
  });

  const promptResult = await commandCenter("hello model", {});
  const localeResult = await commandCenter("/locale zh-CN", {});

  assert.equal(promptResult.loginRequired, true);
  assert.match(promptResult.response, /No available models/);
  assert.equal(localeResult.locale, "zh-CN");
  assert.match(localeResult.response, /Locale switched to zh-CN/);
  assert.equal(appCreated, false);

  const zhCommandCenter = createCommandCenter({
    getApp: async () => {
      throw new Error("app should not be created before login");
    },
    getLocale: () => "zh-CN",
    hasSelectableModels: async () => false,
  });
  const zhPromptResult = await zhCommandCenter("hello model", {});

  assert.equal(zhPromptResult.loginRequired, true);
  assert.match(zhPromptResult.response, /没有可用模型/);
});

const reviewCustomCommand = {
  content: "Review $ARGUMENTS.",
  metadata: {
    description: "Review custom changes",
    name: "review",
    path: "/workspace/.zcode/commands/review.md",
    scope: "project",
    source: "zcode",
  },
} as never;

test("headless prompt submits a resolvable custom command as raw text", async () => {
  // Bug 回归钉：这条过去早退进 command-center（响应 "Run custom command /review …"），
  // 于是只挂在普通 prompt 路径上的 headless dwf 结算等待被整体跳过。现在它必须落到普通
  // prompt 路径，并把**原文**交给 app——展开是 facade 的 customCommandPromptResolver 干的。
  const ctx = createContext(["--prompt", "/review auth"]);
  const base = createPromptDeps();
  const loadedNames: string[] = [];
  let submitted: unknown;
  const exitCode = await run(ctx, {
    ...base,
    createZCodeApp: (options) => {
      const app = base.createZCodeApp?.(options) as {
        submitPrompt: (prompt: unknown, submitOptions?: unknown) => Promise<unknown>;
      };
      return {
        ...app,
        submitPrompt: async (prompt: unknown, submitOptions?: unknown) => {
          submitted = prompt;
          return await app.submitPrompt(prompt, submitOptions);
        },
      } as never;
    },
    loadCustomCommand: async (options) => {
      loadedNames.push(options.name);
      return reviewCustomCommand;
    },
    isReservedSlashCommandName: () => false,
  });

  assert.equal(exitCode, 0);
  // 原文，未展开：CLI 不再本地展开自定义命令。
  assert.equal(submitted, "/review auth");
  assert.deepEqual(loadedNames, ["review"]);
  // command-center 的包装文案彻底不在这条路径上了。
  assert.equal(ctx.stdout.output().includes("Run custom command"), false);
});

test("headless prompt keeps a facade-reserved custom command name on the command-center path", async () => {
  // `compress` 是唯一一个 CLI 解析成 unknown、而 facade 的 resolver 又因保留名拒绝展开的
  // 名字。若探测把它判成"可解析"，它就会以字面文本 `/compress …` 被当普通 prompt 提交给
  // 模型——静默走错路。这条刻意**不注入**保留名判据，用真实 bootstrap 的那份清单，这样
  // 两侧是否真的同源就是可证的（清单长出新成员时这条会跟着变）。
  const ctx = createContext(["--prompt", "/compress tighten it"]);
  const base = createPromptDeps();
  let submitted: unknown;
  const exitCode = await run(ctx, {
    ...base,
    createZCodeApp: (options) => {
      const app = base.createZCodeApp?.(options) as {
        submitPrompt: (prompt: unknown, submitOptions?: unknown) => Promise<unknown>;
      };
      return {
        ...app,
        submitPrompt: async (prompt: unknown, submitOptions?: unknown) => {
          submitted = prompt;
          return await app.submitPrompt(prompt, submitOptions);
        },
      } as never;
    },
    loadCustomCommand: async () =>
      ({
        content: "Compress $ARGUMENTS.",
        metadata: {
          description: "Compress things",
          name: "compress",
          path: "/workspace/.zcode/commands/compress.md",
          scope: "project",
          source: "zcode",
        },
      }) as never,
  });

  assert.equal(exitCode, 0);
  // command-center 在本地展开了它（今天的行为，逐字保留）。
  assert.match(ctx.stdout.output(), /Run custom command \/compress\./);
  assert.match(ctx.stdout.output(), /Compress tighten it/);
  // 关键：绝不能把原文丢给模型当普通 prompt。
  assert.notEqual(submitted, "/compress tighten it");
});

test("TUI custom command expansion hands shell blocks to the model like the app path", () => {
  const { prompt } = expandCliCustomCommandPrompt({
    args: "go !`touch arg-marker`",
    command: {
      content: [
        "Run !`git status`, then report.",
        "```!",
        '"${CLAUDE_PLUGIN_ROOT}/s.sh" "$CLAUDE_PROJECT_DIR" $ARGUMENTS',
        "```",
      ].join("\n"),
      metadata: {
        name: "probe",
        plugin: { dataPath: "/data/p", id: "p@market", name: "p", rootPath: "/plugins/p" },
        scope: "user",
        source: "plugin",
      },
    },
  });

  assert.match(prompt, /the \/probe command file \(user\/plugin\), not from ZCode\./);
  // 代码块结束后原文另起一行；插件变量换成真实路径，工作区变量留给 Bash 环境；参数原样进入。
  assert.ok(prompt.includes("```bash\ngit status\n```\n, then report."));
  assert.ok(
    prompt.includes('```bash\n"/plugins/p/s.sh" "$CLAUDE_PROJECT_DIR" go !`touch arg-marker`\n```'),
  );
});

test("headless prompt keeps the Unknown command response for an unresolvable slash name", async () => {
  const ctx = createContext(["--prompt", "/nope please"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    listCustomCommands: async () =>
      ({
        commands: [reviewCustomCommand.metadata],
        diagnostics: [],
        totalDiscovered: 1,
      }) as never,
    loadCustomCommand: async () => {
      throw new Error("Custom command not found: nope");
    },
    isReservedSlashCommandName: () => false,
  });

  assert.equal(exitCode, 0);
  assert.match(ctx.stdout.output(), /Unknown command: \/nope\./);
  assert.match(ctx.stdout.output(), /Available commands: .*\/review/);
});

test("headless prompt propagates a custom command load failure that is not a miss", async () => {
  // 只有 /not found/i 算"不可解析"。读盘失败必须冒泡成进程错误，不能被一句
  // "Unknown command" 盖掉真正的原因。
  const ctx = createContext(["--prompt", "/review auth"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    loadCustomCommand: async () => {
      throw new Error("EACCES: permission denied, open '/workspace/.zcode/commands/review.md'");
    },
    isReservedSlashCommandName: () => false,
  });

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /EACCES: permission denied/);
  assert.equal(ctx.stdout.output().includes("Unknown command"), false);
});

test("wires TUI input recall skip into the active app", async () => {
  const ctx = createContext(["tui"]);
  const recalledSkips: Array<number | undefined> = [];
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () =>
      ({
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        recallPreviousInputHistory: async (skip?: number) => {
          recalledSkips.push(skip);
          return { text: skip === 1 ? "older project prompt" : "previous project prompt" };
        },
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      }) as never,
    runTui: async (options) => {
      const previous = await options.recallPreviousInput?.();
      const older = await options.recallPreviousInput?.(1);
      assert.equal(previous?.text, "previous project prompt");
      assert.equal(older?.text, "older project prompt");
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(recalledSkips, [undefined, 1]);
});

test("wires TUI slash command history recording into the active app", async () => {
  const ctx = createContext(["tui"]);
  const recorded: Array<{ input: unknown; kind: unknown }> = [];
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () =>
      ({
        getModel: () => "openai/gpt-main",
        listModels: () => [],
        recordInputHistory: async (input: unknown, kind?: unknown) => {
          recorded.push({ input, kind });
          return null;
        },
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        recallPreviousInputHistory: async () => null,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      }) as never,
    runTui: async (options) => {
      // 活动 App 在启动屏首帧后创建；此后的 slash 命令写入该 App 的输入历史。
      await loadTuiStartup(options);
      await options.submitPrompt("/help", {
        abortSignal: new AbortController().signal,
      });
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(recorded, [{ input: "/help", kind: "slash_command" }]);
});

test("TUI bare skill command lists skills when startup metadata is unavailable", async () => {
  const ctx = createContext([]);
  let appCreationAttempts = 0;
  let listed = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () => {
      appCreationAttempts += 1;
      throw new Error("app is unavailable");
    },
    cwd: () => "/workspace/project",
    listSkills: async (options) => {
      listed = true;
      assert.equal(options.workingDirectory, "/workspace/project");
      return {
        diagnostics: [],
        skills: [
          {
            description: "Use for demo tasks.",
            directory: "/workspace/project/.zcode/skills/demo",
            frontmatterKeys: ["name", "description"],
            name: "demo-skill",
            path: "/workspace/project/.zcode/skills/demo/SKILL.md",
            rootPath: "/workspace/project/.zcode/skills",
            safeToAutoLoad: true,
            scope: "project",
            source: "zcode",
          },
        ],
        totalDiscovered: 1,
      } as never;
    },
    runTui: async (options) => {
      // 启动元数据在首帧后加载；App 创建失败时降级为空元数据，TUI 仍可进入。
      const startup = await loadTuiStartup(options);
      assert.equal(startup.initialModel, undefined);
      const result = await options.submitPrompt("/skill", {
        abortSignal: new AbortController().signal,
      });
      assert.match(result.response, /Available skills \(1\)/);
      assert.match(result.response, /demo-skill \(project\/zcode\)/);
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(appCreationAttempts, 1);
  assert.equal(listed, true);
  assert.equal(ctx.stderr.output(), "");
});

test("command center handles goal commands locally", async () => {
  let submittedPrompt: string | undefined;
  let target: CommandCenterTarget | null = null;
  const commandCenter = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "session-target",
        traceId: "trace-target",
        readTarget: async () => target,
        setTarget: async ({ objective, status = "active" }) => {
          target = {
            objective,
            sessionID: "session-target",
            status,
            targetID: "target-1",
            time: { created: 1, updated: 1 },
          };
          return target;
        },
        updateTargetStatus: async (status) => {
          if (!target) return null;
          target = { ...target, status, time: { ...target.time, updated: 2 } };
          return target;
        },
        clearTarget: async () => {
          const hadTarget = target !== null;
          target = null;
          return hadTarget;
        },
        submitPrompt: async (prompt: string) => {
          submittedPrompt = prompt;
          return {
            projection: fakeProjection as never,
            response: prompt,
            traceId: "trace-target" as never,
            turnId: "turn-target" as never,
          };
        },
        resume: async () => ({
          appliedMessageCount: 0,
          directory: "/tmp",
          interruptedToolCount: 0,
          messageCount: 0,
          partCount: 0,
        }),
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not be called");
    },
  });

  const set = await commandCenter("/goal Ship target MVP", {});
  const paused = await commandCenter("/goal pause", {});
  const summary = await commandCenter("/goal", {});
  const cleared = await commandCenter("/goal clear", {});

  assert.match(set.response, /Goal active/);
  assert.match(set.response, /Ship target MVP/);
  assert.match(paused.response, /Goal paused/);
  assert.match(summary.response, /Goal paused/);
  assert.match(cleared.response, /Goal cleared/);
  assert.equal(submittedPrompt, undefined);
});

test("command center starts target continuation after setting a target", async () => {
  let continued = false;
  const commandCenter = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "session-target-continue",
        traceId: "trace-target-continue",
        readTarget: async () => null,
        setTarget: async ({ objective, status = "active" }) => ({
          objective,
          sessionID: "session-target-continue",
          status,
          targetID: "target-continue",
          time: { created: 1, updated: 1 },
        }),
        updateTargetStatus: async () => null,
        clearTarget: async () => false,
        continueActiveTarget: async () => {
          continued = true;
          return {
            projection: fakeProjection as never,
            response: "continued target",
            traceId: "trace-target-continue" as never,
            turnId: "turn-target-continue" as never,
          };
        },
        resume: async () => ({
          appliedMessageCount: 0,
          directory: "/tmp",
          interruptedToolCount: 0,
          messageCount: 0,
          partCount: 0,
        }),
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not be called");
    },
  });

  const result = await commandCenter("/goal Ship target MVP", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(continued, true);
  assert.equal(result.response, "continued target");
  assert.equal(result.traceId, "trace-target-continue");
});

test("command center explains skipped goal continuation in plan mode", async () => {
  let continued = false;
  const commandCenter = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "session-target-plan",
        traceId: "trace-target-plan",
        readTarget: async () => null,
        setTarget: async ({ objective, status = "active" }) => ({
          objective,
          sessionID: "session-target-plan",
          status,
          targetID: "target-plan",
          time: { created: 1, updated: 1 },
        }),
        updateTargetStatus: async () => null,
        clearTarget: async () => false,
        continueActiveTarget: async () => {
          continued = true;
          return null;
        },
        resume: async () => ({
          appliedMessageCount: 0,
          directory: "/tmp",
          interruptedToolCount: 0,
          messageCount: 0,
          partCount: 0,
        }),
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
      }) as never,
    getMode: () => "plan",
    resumeApp: async () => {
      throw new Error("resume should not be called");
    },
  });

  const result = await commandCenter("/goal Optimize performance", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(continued, true);
  assert.match(result.response, /Goal active/);
  assert.match(result.response, /Optimize performance/);
  assert.match(result.response, /Plan mode 下已记录 goal，但不会自动继续。/);
});

test("command center asks before replacing an existing goal", async () => {
  let setCalled = false;
  const existing: CommandCenterTarget = {
    objective: "Existing target",
    sessionID: "session-target-replace",
    status: "active",
    targetID: "target-existing",
    time: { created: 1, updated: 1 },
  };
  const commandCenter = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "session-target-replace",
        traceId: "trace-target-replace",
        readTarget: async () => existing,
        setTarget: async () => {
          setCalled = true;
          return existing;
        },
        updateTargetStatus: async () => existing,
        clearTarget: async () => true,
        resume: async () => ({
          appliedMessageCount: 0,
          directory: "/tmp",
          interruptedToolCount: 0,
          messageCount: 0,
          partCount: 0,
        }),
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not be called");
    },
  });

  const result = await commandCenter("/goal New target", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(setCalled, false);
  assert.equal(result.selection?.title, "Replace Goal");
  assert.equal(result.selection?.items[0]?.command, "/goal replace New target");
});

test("TUI startup migration failures return before entering fullscreen UI", async () => {
  const ctx = createContext(["tui"]);
  let mainUiMounted = false;
  const migrationError = new Error(
    "SQLite migration checksum mismatch for 0001_base_session_store",
  );
  migrationError.name = "SqliteSessionMigrationError";

  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () => {
      throw migrationError;
    },
    // 新启动流程先绘制启动屏，再在 loadStartupOptions 中创建运行时；真实 runTui 在启动数据
    // 加载失败时销毁 renderer 并把错误抛回 CLI，因此主界面不会挂载，错误在终端恢复后输出。
    runTui: async (options) => {
      await options.loadStartupOptions?.();
      mainUiMounted = true;
      return 0;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(mainUiMounted, false);
  assert.match(ctx.stderr.output(), /SQLite migration checksum mismatch/);
  assert.equal(ctx.stdout.output(), "");
});

test("detects TUI invocations before loading the runtime", () => {
  assert.equal(isTuiInvocation([]), true);
  assert.equal(isTuiInvocation(["tui"]), true);
  assert.equal(isTuiInvocation(["--mode", "build"]), true);
  assert.equal(isTuiInvocation(["--resume", "session-test", "tui"]), true);

  assert.equal(isTuiInvocation(["acp"]), false);
  assert.equal(isTuiInvocation(["--help"]), false);
  assert.equal(isTuiInvocation(["tui", "--help"]), false);
  assert.equal(isTuiInvocation(["--prompt", "hello"]), false);
  assert.equal(isTuiInvocation(["missing"]), false);
  assert.equal(isTuiInvocation(["--wat"]), false);
});

test("buffers TUI stderr and drops it on clean restore", () => {
  const stderr = createWriteStream();
  const interceptor = interceptTuiStderr(stderr);

  stderr.write("runtime warning\n");

  assert.equal(stderr.output(), "");
  assert.equal(interceptor.bufferedOutput, "runtime warning\n");

  interceptor.restore();

  assert.equal(stderr.output(), "");
});

test("flushes buffered TUI stderr when startup fails", async () => {
  const stderr = createWriteStream();
  const interceptor = interceptTuiStderr(stderr);
  let callbackCalled = false;

  await new Promise<void>((resolve) => {
    stderr.write(Buffer.from("startup failed\n"), () => {
      callbackCalled = true;
      resolve();
    });
  });

  assert.equal(callbackCalled, true);
  assert.equal(stderr.output(), "");

  interceptor.restore({ flush: true });

  assert.equal(stderr.output(), "startup failed\n");
});

test("lets controlled TUI errors bypass raw stderr interception", () => {
  const stderr = createWriteStream();
  const interceptor = interceptTuiStderr(stderr);

  interceptor.passthrough.write("TUI requires an interactive terminal.\n");
  stderr.write("runtime warning\n");

  assert.equal(stderr.output(), "TUI requires an interactive terminal.\n");
  assert.equal(interceptor.bufferedOutput, "runtime warning\n");

  interceptor.restore();
});

test("filters the known SQLite experimental warning from stderr", () => {
  const stderr = createWriteStream();
  const interceptor = interceptKnownRuntimeWarnings(stderr);

  stderr.write(
    "(node:59658) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n",
  );
  stderr.write(
    "(Use `zcode-darwin-arm64 --trace-warnings ...` to show where the warning was created)\n",
  );
  stderr.write("real error\n");

  assert.equal(stderr.output(), "real error\n");
  assert.equal(interceptor.suppressedCount, 2);

  interceptor.restore();
});

test("filters the known module.register deprecation warning from stderr", () => {
  const stderr = createWriteStream();
  const interceptor = interceptKnownRuntimeWarnings(stderr);

  stderr.write(
    "(node:69362) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.\n",
  );
  stderr.write("(Use `node --trace-deprecation ...` to show where the warning was created)\n");
  stderr.write("help text stderr\n");

  assert.equal(stderr.output(), "help text stderr\n");
  assert.equal(interceptor.suppressedCount, 2);

  interceptor.restore();
});

test("filters the known insecure Node TLS environment warning from stderr", () => {
  const stderr = createWriteStream();
  const interceptor = interceptKnownRuntimeWarnings(stderr);

  stderr.write(
    "(node:65726) Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification.\n",
  );
  stderr.write("provider error remains visible\n");

  assert.equal(stderr.output(), "provider error remains visible\n");
  assert.equal(interceptor.suppressedCount, 1);

  interceptor.restore();
});

test("filters the known AI SDK Anthropic thinking budget warnings from stderr", () => {
  const stderr = createWriteStream();
  const interceptor = interceptKnownRuntimeWarnings(stderr);

  stderr.write(
    "AI SDK Warning System: To turn off warning logging, set the AI_SDK_LOG_WARNINGS global to false.\n",
  );
  stderr.write(
    'AI SDK Warning (anthropic.messages / glm-5.1): The feature "extended thinking" is used in a compatibility mode. thinking budget is required when thinking is enabled. using default budget of 1024 tokens.\n',
  );
  stderr.write("AI SDK Warning (openai.responses / gpt-test): unrelated warning\n");
  stderr.write("runtime error remains visible\n");

  assert.equal(
    stderr.output(),
    "AI SDK Warning (openai.responses / gpt-test): unrelated warning\nruntime error remains visible\n",
  );
  assert.equal(interceptor.suppressedCount, 2);

  interceptor.restore();
});

test("keeps unrelated stderr while filtering runtime warnings", () => {
  const stderr = createWriteStream();
  const interceptor = interceptKnownRuntimeWarnings(stderr);

  stderr.write("(node:59658) ExperimentalWarning: Something else happened\n");
  stderr.write(
    "(node:59658) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n",
  );
  stderr.write("still important\n");

  assert.equal(
    stderr.output(),
    "(node:59658) ExperimentalWarning: Something else happened\nstill important\n",
  );
  assert.equal(interceptor.suppressedCount, 1);

  interceptor.restore();
});

test("wires TUI approval requests into the runtime permission broker", async () => {
  const ctx = createContext(["tui"]);
  let approvalSeen = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      return {
        listModels: selectableTestModels,
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async () => {
          const permission = await options?.permissionBroker?.requestPermission(
            createPermissionRequest(),
            {
              signal: new AbortController().signal,
            },
          );
          return {
            events: [],
            projection: fakeProjection as never,
            response: `permission ${permission?.decision}`,
            traceId: "trace-test" as never,
            turnId: "turn-test" as never,
          };
        },
      } as never;
    },
    runTui: async (options) => {
      // TUI 挂载时登记一次审批入口；提交不再携带单次回调。
      const unregister = options.registerPermissionRequester!(async (request) => {
        approvalSeen = true;
        assert.equal(request.toolName, "Bash");
        return {
          decision: "allow",
          reason: "approved by tui test",
        };
      });
      const result = await options.submitPrompt("needs approval", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(result.response, "permission allow");
      unregister();
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(approvalSeen, true);
});

test("wires TUI sendInput approval requests into the runtime permission broker", async () => {
  const ctx = createContext(["tui"]);
  let approvalSeen = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        sendInput: async () => {
          const permission = await options?.permissionBroker?.requestPermission(
            createPermissionRequest(),
            {
              signal: new AbortController().signal,
            },
          );
          return {
            kind: "started_turn",
            result: {
              events: [],
              projection: fakeProjection as never,
              response: `permission ${permission?.decision}`,
              traceId: "trace-test" as never,
              turnId: "turn-test" as never,
            },
          };
        },
        submitPrompt: async () => {
          throw new Error("sendInput should handle this prompt");
        },
      } as never;
    },
    runTui: async (options) => {
      const unregister = options.registerPermissionRequester!(async (request) => {
        approvalSeen = true;
        assert.equal(request.toolName, "Bash");
        return {
          decision: "allow",
          reason: "approved by tui sendInput test",
        };
      });
      const result = await options.sendInput!("needs approval while busy", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(result.kind, "started_turn");
      assert.equal(result.result.response, "permission allow");
      unregister();
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(approvalSeen, true);
});

// 回归：审批入口原先只在单次提交内有效，回合之外的询问（后台会话、通知驱动的回合）被直接拒绝。
test("routes approvals raised outside any submit to the mounted TUI and fails closed after unmount", async () => {
  const ctx = createContext(["tui"]);
  let broker: NonNullable<ZCodeAppOptions["permissionBroker"]> | undefined;
  const seen: string[] = [];
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      broker = options?.permissionBroker;
      return {
        listModels: selectableTestModels,
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async () => ({
          events: [],
          projection: fakeProjection as never,
          response: "created",
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    runTui: async (options) => {
      const background = { ...(createPermissionRequest() as object), sessionId: "sess_background" };
      const first = options.registerPermissionRequester!(async (request) => {
        seen.push(`first:${request.sessionId}`);
        return { decision: "deny", reason: "first" };
      });
      // 首次提交建出 App；提交结束后再询问，模拟后台会话在发起者回合之外请求审批。
      await options.submitPrompt("create background work", {
        abortSignal: new AbortController().signal,
      });
      const outside = await broker!.requestPermission(background as never);
      assert.equal(outside.decision, "deny");
      assert.equal(outside.reason, "first");
      // 重新挂载：新入口先登记，旧入口的迟到注销不能把它清掉。
      const second = options.registerPermissionRequester!(async (request) => {
        seen.push(`second:${request.sessionId}`);
        return { decision: "allow", reason: "second" };
      });
      first();
      assert.equal((await broker!.requestPermission(background as never)).decision, "allow");
      second();
      const closed = await broker!.requestPermission(background as never);
      assert.equal(closed.decision, "deny");
      assert.match(closed.reason ?? "", /No interactive approval handler/);
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(seen, ["first:sess_background", "second:sess_background"]);
});

test("wires TUI mode display and switching into runtime config", async () => {
  const ctx = createContext(["--mode", "plan", "tui"]);
  let appMode: "plan" | "build" | "edit" | "yolo" | "auto" = "build";
  const runtimeModeUpdates: string[] = [];
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      // 启动屏首帧后按 CLI --mode 创建 App；此后的模式切换都作用于活动 App。
      assert.equal(options?.runtimeConfig?.mode, "plan");
      appMode = options?.runtimeConfig?.mode ?? "build";
      return {
        getMode: () => appMode,
        listModels: selectableTestModels,
        sessionId: "session-test",
        setMode: async (mode: typeof appMode) => {
          runtimeModeUpdates.push(mode);
          const previousMode = appMode;
          appMode = mode;
          return {
            mode: appMode,
            previousMode,
            traceId: "trace-test",
          };
        },
        traceId: "trace-test",
        runtime: {
          updateConfig: (patch: { mode?: typeof appMode }) => {
            if (patch.mode) {
              runtimeModeUpdates.push(patch.mode);
              appMode = patch.mode;
            }
          },
        } as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    runTui: async (options) => {
      const startup = await loadTuiStartup(options);
      assert.equal(startup.initialMode, "plan");
      const firstSwitch = await options.submitPrompt("/mode yolo", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(firstSwitch.mode, "yolo");

      const promptResult = await options.submitPrompt("hello mode", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(promptResult.mode, "yolo");

      const liveSwitch = await options.submitPrompt("/mode build", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(liveSwitch.mode, "build");

      const shortcutSwitch = await options.setMode!("plan");
      assert.equal(shortcutSwitch.mode, "plan");
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(runtimeModeUpdates, ["yolo", "build", "plan"]);
});

test("wires TUI edit mode switching into runtime config", async () => {
  const ctx = createContext(["--mode", "build", "tui"]);
  let appMode: "plan" | "build" | "edit" | "yolo" | "auto" = "build";
  const runtimeModeUpdates: string[] = [];
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      // 启动屏首帧后按 CLI --mode 创建 App；edit 切换经活动 App 的 runtime config 生效。
      assert.equal(options?.runtimeConfig?.mode, "build");
      appMode = options?.runtimeConfig?.mode ?? "build";
      return {
        getMode: () => appMode,
        listModels: selectableTestModels,
        sessionId: "session-edit-test",
        traceId: "trace-edit-test",
        runtime: {
          updateConfig: (patch: { mode?: typeof appMode }) => {
            if (patch.mode) {
              runtimeModeUpdates.push(patch.mode);
              appMode = patch.mode;
            }
          },
        } as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-edit-test" as never,
          turnId: "turn-edit-test" as never,
        }),
      } as never;
    },
    runTui: async (options) => {
      const startup = await loadTuiStartup(options);
      assert.equal(startup.initialMode, "build");
      const liveSwitch = await options.submitPrompt("/mode edit", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(liveSwitch.mode, "edit");

      const promptResult = await options.submitPrompt("hello edit mode", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(promptResult.mode, "edit");
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(runtimeModeUpdates, ["edit"]);
});

test("wires TUI model command into app server state", async () => {
  const ctx = createContext(["tui"]);
  // 模型目录改为协议 Model Option（ref + 推理档位），/model 切换提交完整的结构化选择。
  const modelOptions = [
    createTestModelOption("openai", "gpt-main", {
      defaultLevel: "high",
      label: "Main",
      levels: ["low", "high"],
    }),
    createTestModelOption("openai", "gpt-lite", {
      defaultLevel: "low",
      label: "Lite",
      levels: ["low", "high"],
    }),
  ];
  let current: ModelSelection = {
    providerId: "openai",
    modelId: "gpt-main",
    options: { reasoningLevel: "high" },
  };
  const currentModelId = () => `${current.providerId}/${current.modelId}`;
  const requestedSelections: unknown[] = [];
  const savedDefaults: ModelSelection[] = [];
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    startProcessProviderRegistryRuntime: async () =>
      ({
        dispose: () => {},
        modelSelectionConfigRepository: {
          dispose: () => {},
          read: async () => undefined,
          saveConfiguredDefault: async (selection: ModelSelection) => {
            savedDefaults.push(selection);
          },
        },
        runtime: { registryService: {} },
      }) as never,
    createZCodeApp: () => {
      return {
        getCurrentModelOption: () =>
          modelOptions.find(
            ({ ref }) => ref.providerId === current.providerId && ref.modelId === current.modelId,
          ),
        getModel: currentModelId,
        getThoughtLevel: () => current.options?.reasoningLevel,
        listModels: () => modelOptions,
        sessionId: "session-test",
        setModel: async (selection: ModelSelection) => {
          requestedSelections.push(selection);
          const previousModel = currentModelId();
          current = selection;
          return {
            model: currentModelId(),
            previousModel,
            thoughtLevel: selection.options?.reasoningLevel,
            traceId: "trace-test",
          };
        },
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async () => ({
          events: [],
          projection: fakeProjection as never,
          response: `using ${currentModelId()}`,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    runTui: async (options) => {
      const startup = await loadTuiStartup(options);
      assert.equal(startup.initialModel, "openai/gpt-main");
      assert.equal(startup.initialThoughtLevel, "high");
      assert.deepEqual(startup.modelOptions, modelOptions);

      const listed = await options.submitPrompt("/model", {
        abortSignal: new AbortController().signal,
      });
      assert.match(listed.response, /Current model: openai\/gpt-main/);
      assert.equal(listed.model, "openai/gpt-main");
      assert.equal(listed.thoughtLevel, "high");

      const switched = await options.submitPrompt("/model openai/gpt-lite", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(switched.response, "Model switched to openai/gpt-lite (low).");
      assert.equal(switched.model, "openai/gpt-lite");
      assert.equal(switched.thoughtLevel, "low");

      const promptResult = await options.submitPrompt("hello model", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(promptResult.response, "using openai/gpt-lite");
      assert.equal(promptResult.model, "openai/gpt-lite");
      assert.equal(promptResult.thoughtLevel, "low");
      return 0;
    },
  });

  const expectedSelection = {
    providerId: "openai",
    modelId: "gpt-lite",
    options: { reasoningLevel: "low" },
  };
  assert.equal(exitCode, 0);
  assert.deepEqual(requestedSelections, [expectedSelection]);
  // 用户主动切换成功后，完整选择同步保存为新会话默认值。
  assert.deepEqual(savedDefaults, [expectedSelection]);
});

test("wires TUI effort command into app server state", async () => {
  const ctx = createContext(["tui"]);
  let thoughtLevel = "medium";
  const requestedLevels: string[] = [];
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () => {
      return {
        getModel: () => "openai/gpt-main",
        getThoughtLevel: () => thoughtLevel,
        listModels: () => [createTestModelOption("openai", "gpt-main", { label: "Main" })],
        listThoughtLevels: () => ["low", "medium", "high"],
        sessionId: "session-test",
        setThoughtLevel: async (level: string) => {
          requestedLevels.push(level);
          const previousThoughtLevel = thoughtLevel;
          thoughtLevel = level;
          return {
            previousThoughtLevel,
            thoughtLevel,
            traceId: "trace-test",
          };
        },
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async () => ({
          events: [],
          projection: fakeProjection as never,
          response: `effort ${thoughtLevel}`,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    runTui: async (options) => {
      const startup = await loadTuiStartup(options);
      assert.equal(startup.initialThoughtLevel, "medium");
      assert.deepEqual(startup.effortOptions, [
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
      ]);

      const listed = await options.submitPrompt("/effort", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(listed.selection, undefined);
      assert.match(listed.response, /Current reasoning effort: medium/);
      assert.match(listed.response, /- high/);
      assert.equal(listed.thoughtLevel, "medium");

      const switched = await options.submitPrompt("/variant high", {
        abortSignal: new AbortController().signal,
      });
      assert.match(switched.response, /Reasoning effort switched to high/);
      assert.deepEqual(switched.effortOptions, startup.effortOptions);
      assert.equal(switched.thoughtLevel, "high");

      const promptResult = await options.submitPrompt("hello effort", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(promptResult.response, "effort high");
      assert.equal(promptResult.thoughtLevel, "high");
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requestedLevels, ["high"]);
});

test("wires TUI fork command into a new active app", async () => {
  const ctx = createContext(["tui"]);
  const createdSessionIds: Array<string | undefined> = [];
  let forkTarget: string | undefined;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      const appSessionId = options?.sessionId ?? "sess_parent";
      createdSessionIds.push(options?.sessionId);
      return {
        forkFromCheckpoint: async (forkOptions?: { targetCheckpointId?: string }) => {
          forkTarget = forkOptions?.targetCheckpointId;
          return {
            checkpoint: {} as never,
            copiedMessageCount: 1,
            forkedSessionId: "sess_child",
            restoredFiles: [],
            response: "Forked session sess_child",
          };
        },
        listModels: selectableTestModels,
        sessionId: appSessionId,
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: `${appSessionId}:${prompt}`,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    runTui: async (options) => {
      const forked = await options.submitPrompt("/fork checkpoint_1", {
        abortSignal: new AbortController().signal,
      });
      assert.match(forked.response, /Switched to forked session sess_child/);

      const promptResult = await options.submitPrompt("hello fork", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(promptResult.response, "sess_child:hello fork");
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(forkTarget, "checkpoint_1");
  assert.deepEqual(createdSessionIds, [undefined, "sess_child"]);
});

test("wires TUI new command into a fresh active app", async () => {
  const ctx = createContext(["tui"]);
  const createdSessionIds: Array<string | undefined> = [];
  const closedSessionIds: string[] = [];
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.equal(options?.standaloneSessionControl, true);
      const appSessionId = options?.sessionId ?? `sess_new_${createdSessionIds.length}`;
      createdSessionIds.push(options?.sessionId);
      return {
        listModels: selectableTestModels,
        sessionId: appSessionId,
        traceId: `trace_${appSessionId}`,
        runtime: {} as never,
        close: async () => {
          closedSessionIds.push(appSessionId);
        },
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: `${appSessionId}:${prompt}`,
          traceId: `trace_${appSessionId}` as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    runTui: async (options) => {
      const initial = await options.submitPrompt("hello first", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(initial.response, "sess_new_0:hello first");

      const created = await options.submitPrompt("/new", {
        abortSignal: new AbortController().signal,
      });
      assert.match(created.response, /Started new session sess_new_1/);
      assert.equal(created.sessionId, "sess_new_1");
      assert.equal(created.resetSessionProjection, true);

      const promptResult = await options.submitPrompt("hello new", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(promptResult.response, "sess_new_1:hello new");
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(createdSessionIds, [undefined, undefined]);
  assert.deepEqual(closedSessionIds, ["sess_new_0", "sess_new_1"]);
});

test("keeps shared telemetry alive across TUI session replacement and shuts it down once", async () => {
  const ctx = createContext(["tui"]);
  let telemetryPrepareCount = 0;
  let telemetryShutdownCount = 0;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    prepareZCodeTelemetryEnv: async (env) => {
      telemetryPrepareCount += 1;
      return env;
    },
    shutdownZCodeTelemetry: async () => {
      telemetryShutdownCount += 1;
    },
    runTui: async (options) => {
      await options.submitPrompt("hello first", {
        abortSignal: new AbortController().signal,
      });
      await options.submitPrompt("/new", {
        abortSignal: new AbortController().signal,
      });
      assert.equal(telemetryShutdownCount, 0);
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(telemetryPrepareCount, 2);
  assert.equal(telemetryShutdownCount, 1);
});

test("reuses provider endpoint routing when TUI replaces its active session", async () => {
  const ctx = createContext(["tui"]);
  const providerEndpointRoutingPort = {
    async resolve(url: string) {
      return { routed: false, url };
    },
  };
  let routingFactoryCalls = 0;
  let createdApps = 0;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createProviderEndpointRoutingPort: () => {
      routingFactoryCalls += 1;
      return providerEndpointRoutingPort;
    },
    createZCodeApp: (options) => {
      assert.equal(options?.providerEndpointRoutingPort, providerEndpointRoutingPort);
      createdApps += 1;
      return {
        close: async () => {},
        runtime: {} as never,
        sessionId: `session-routing-tui-${createdApps}`,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: `trace-routing-tui-${createdApps}` as never,
          turnId: "turn-routing-tui" as never,
        }),
        traceId: `trace-routing-tui-${createdApps}`,
      } as never;
    },
    runTui: async (options) => {
      await options.submitPrompt("first", {
        abortSignal: new AbortController().signal,
      });
      await options.submitPrompt("/new", {
        abortSignal: new AbortController().signal,
      });
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(createdApps, 2);
  assert.equal(routingFactoryCalls, 1);
});

test("closes the active TUI app on process shutdown signals", async () => {
  const ctx = createContext(["tui"]);
  const shutdownProcess = createTestShutdownProcess("darwin");
  const exitDeferred = createDeferred<number>();
  let closeCount = 0;
  let telemetryShutdownCount = 0;

  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    prepareZCodeTelemetryEnv: async (env) => env,
    shutdownZCodeTelemetry: async () => {
      telemetryShutdownCount += 1;
    },
    createZCodeApp: () =>
      ({
        close: async () => {
          closeCount += 1;
        },
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        runtime: {} as never,
        sessionId: "session-test",
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
        traceId: "trace-test",
      }) as never,
    exitProcess: (code) => {
      exitDeferred.resolve(code);
    },
    runTui: async (options) => {
      await options.submitPrompt("hello", {
        abortSignal: new AbortController().signal,
      });
      shutdownProcess.emitSignal("SIGHUP");
      assert.equal(await exitDeferred.promise, 129);
      return 0;
    },
    shutdownProcess,
  });

  assert.equal(exitCode, 0);
  assert.equal(closeCount, 1);
  assert.equal(telemetryShutdownCount, 1);
});

test("parses built-in slash commands outside the TUI", () => {
  assert.deepEqual(parseSlashCommand("hello"), null);
  assert.deepEqual(parseSlashCommand("/compact keep files"), {
    args: "keep files",
    name: "compact",
    rawName: "compact",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/expert migrate auth"), {
    args: "migrate auth",
    name: "expert",
    rawName: "expert",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/fork latest"), {
    args: "latest",
    name: "fork",
    rawName: "fork",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/help model"), {
    args: "model",
    name: "help",
    rawName: "help",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/init include scripts"), {
    args: "include scripts",
    name: "init",
    rawName: "init",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/workflow review the auth module"), {
    args: "review the auth module",
    name: "workflow",
    rawName: "workflow",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/continue"), {
    args: "",
    name: "resume",
    rawName: "continue",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/clear"), {
    args: "",
    name: "new",
    rawName: "clear",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/mode yolo"), {
    args: "yolo",
    name: "mode",
    rawName: "mode",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/locale zh-CN"), {
    args: "zh-CN",
    name: "locale",
    rawName: "locale",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/language auto"), {
    args: "auto",
    name: "locale",
    rawName: "language",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/mcp list"), {
    args: "list",
    name: "mcp",
    rawName: "mcp",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/plugins enable ios-simulator"), {
    args: "enable ios-simulator",
    name: "plugins",
    rawName: "plugins",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/plugin"), {
    args: "",
    name: "plugins",
    rawName: "plugin",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/model lite"), {
    args: "lite",
    name: "model",
    rawName: "model",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/effort high"), {
    args: "high",
    name: "effort",
    rawName: "effort",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/variant max"), {
    args: "max",
    name: "effort",
    rawName: "variant",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/new"), {
    args: "",
    name: "new",
    rawName: "new",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/rewind latest"), {
    args: "latest",
    name: "rewind",
    rawName: "rewind",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/skill"), {
    args: "",
    name: "skill",
    rawName: "skill",
    skillName: "",
    task: "",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/skill demo-skill update docs"), {
    args: "demo-skill update docs",
    name: "skill",
    rawName: "skill",
    skillName: "demo-skill",
    task: "update docs",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/goal Ship target MVP"), {
    args: "Ship target MVP",
    name: "goal",
    rawName: "goal",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/target Ship target MVP"), {
    args: "Ship target MVP",
    name: "goal",
    rawName: "target",
    type: "known",
  });
  assert.deepEqual(parseSlashCommand("/wat"), {
    args: "",
    rawName: "wat",
    type: "unknown",
  });
});

test("command center returns slash help without creating an app", async () => {
  const submitPrompt = createCommandCenter({
    getApp: async () => {
      throw new Error("app should not be created");
    },
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const allCommands = await submitPrompt("/help", {
    abortSignal: new AbortController().signal,
  });
  const clearCommand = await submitPrompt("/help /clear", {
    abortSignal: new AbortController().signal,
  });
  const effortCommand = await submitPrompt("/help /variant", {
    abortSignal: new AbortController().signal,
  });
  const modelCommand = await submitPrompt("/help /model", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(allCommands.mode, "build");
  assert.match(allCommands.response, /Slash commands:/);
  assert.match(allCommands.response, /\/help \[command\]/);
  assert.match(allCommands.response, /\/compact \[instructions\]/);
  assert.match(allCommands.response, /\/init \[notes\]/);
  assert.match(allCommands.response, /\/workflow \[what the workflow should accomplish\]/);
  assert.match(allCommands.response, /\/expert \[status\|resume\|stop\|<task>\]/);
  assert.match(clearCommand.response, /^\/new$/m);
  assert.match(clearCommand.response, /Aliases: \/clear/);
  assert.match(clearCommand.response, /Start a fresh session in the TUI\./);
  assert.match(effortCommand.response, /^\/effort \[list\|<level>\]/);
  assert.match(effortCommand.response, /Aliases: \/variant/);
  assert.match(effortCommand.response, /reasoning effort/);
  // /model main|lite 别名已随结构化模型选择移除，只接受 provider/model。
  assert.match(modelCommand.response, /^\/model \[list\|provider\/model\]/);
  assert.match(modelCommand.response, /Show or switch the current session model\./);
});

test("command center records accepted slash commands through the history port", async () => {
  const recorded: Array<{ input: unknown; kind: unknown }> = [];
  const submitPrompt = createCommandCenter({
    getApp: async () => {
      throw new Error("app should not be created");
    },
    recordInputHistory: async (input, kind) => {
      recorded.push({ input, kind });
    },
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  await submitPrompt("/help /model", {
    abortSignal: new AbortController().signal,
  });
  await submitPrompt("/login zai-coding-plan-api-key secret-token", {
    abortSignal: new AbortController().signal,
  });

  assert.deepEqual(recorded, [{ input: "/help /model", kind: "slash_command" }]);
});

test("command center passes attachments through for normal prompts", async () => {
  let submitted: unknown;
  const promptInput = {
    text: "describe [image #1]",
    attachments: [
      {
        content: "data:image/png;base64,aW1hZ2U=",
        path: "[image #1]",
        type: "image" as const,
      },
    ],
  };
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async (prompt: unknown) => {
          submitted = prompt;
          return {
            response: "done",
          };
        },
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt(promptInput, {
    abortSignal: new AbortController().signal,
  });

  assert.equal(result.response, "done");
  assert.deepEqual(submitted, promptInput);
});

test("command center rejects attachments on slash commands", async () => {
  const submitPrompt = createCommandCenter({
    getApp: async () => {
      throw new Error("app should not be created");
    },
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt(
    {
      text: "/help [image #1]",
      attachments: [
        {
          content: "data:image/png;base64,aW1hZ2U=",
          path: "[image #1]",
          type: "image",
        },
      ],
    },
    {
      abortSignal: new AbortController().signal,
    },
  );

  assert.equal(result.mode, "build");
  assert.equal(result.response, "Image attachments are only supported for normal prompts.");
});

test("command center starts expert workflow in yolo mode", async () => {
  let requestedMode = "";
  let workflowTask = "";
  let promptSubmitted = false;
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        runExpertWorkflow: async (input: { task: string }) => {
          workflowTask = input.task;
          return {
            response: "Expert workflow wf_1 completed.",
            runId: "wf_1",
            status: "completed",
            traceId: "trace-workflow",
          };
        },
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          promptSubmitted = true;
          return {
            response: "prompt",
          };
        },
      }) as never,
    getMode: () => (requestedMode || "build") as never,
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
    setMode: async (mode) => {
      requestedMode = mode;
      return mode;
    },
  });

  const result = await submitPrompt("/expert migrate auth", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(promptSubmitted, false);
  assert.equal(requestedMode, "yolo");
  assert.equal(workflowTask, "migrate auth");
  assert.equal(result.traceId, "trace-workflow");
  assert.match(result.response, /wf_1 completed/);
});

test("command center shows expert workflow status without starting a prompt", async () => {
  let statusRunId: string | undefined;
  let workflowStarted = false;
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        expertWorkflowStatus: async (options?: { runId?: string }) => {
          statusRunId = options?.runId;
          return {
            response: "Expert workflow wf_1\nStatus: running",
            runId: "wf_1",
            status: "running",
          };
        },
        runExpertWorkflow: async () => {
          workflowStarted = true;
          return {
            response: "started",
          };
        },
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/expert status wf_1", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(workflowStarted, false);
  assert.equal(statusRunId, "wf_1");
  assert.match(result.response, /Status: running/);
});

test("command center reports MCP status without sending a model prompt", async () => {
  let promptSubmitted = false;
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        listMcpServers: async () => ({
          local: {
            status: "connected",
            toolCount: 2,
            transport: "stdio",
            updatedAt: "now",
          },
          remote: {
            error: "Connection timed out\n\nline two of stderr\nline three",
            status: "failed",
            toolCount: 0,
            transport: "http",
            updatedAt: "now",
          },
        }),
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          promptSubmitted = true;
          return {
            response: "prompt",
          };
        },
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/mcp list", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(promptSubmitted, false);
  assert.match(result.response, /MCP servers:/);
  assert.match(result.response, /local: connected via stdio; 2 tools/);
  assert.match(result.response, /remote: failed via http; 0 tools \(Connection timed out\)/);
  assert.doesNotMatch(result.response, /line two/);
});

test("command center opens a plugin toggle picker", async () => {
  let promptSubmitted = false;
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        listPlugins: async () => ({
          commandRoots: [],
          diagnostics: [],
          mcpServers: {},
          plugins: [
            {
              commandRootCount: 1,
              dataPath: "/tmp/zcode/plugins/data/ios-simulator@zcode-plugins-official",
              enabled: false,
              id: "ios-simulator@zcode-plugins-official",
              manifestPath: "/plugins/ios/.zcode-plugin/plugin.json",
              marketplace: "zcode-plugins-official",
              mcpServerNames: ["ios-simulator"],
              name: "ios-simulator",
              rootPath: "/plugins/ios",
              skillCount: 1,
              skillRootCount: 1,
              source: "official",
              version: "0.1.0",
            },
          ],
          skillRoots: [],
        }),
        sessionId: "sess_active",
        traceId: "trace-active",
        submitPrompt: async () => {
          promptSubmitted = true;
          return {
            response: "prompt",
          };
        },
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/plugins", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(promptSubmitted, false);
  assert.equal(result.selection?.title, "Plugins");
  assert.equal(result.selection?.placement, "composer");
  assert.equal(result.selection?.items[0]?.primary, "○ Ios Simulator");
  assert.equal(
    result.selection?.items[0]?.command,
    "/plugins enable ios-simulator@zcode-plugins-official",
  );
});

test("command center resolves plugin labels from listings by stable plugin id", async () => {
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        listPlugins: async () => ({
          commandRoots: [],
          diagnostics: [],
          mcpServers: {},
          pluginListingsById: {
            "computer-use@zcode-plugins-official": {
              displayName: "Computer Use",
              displayNameI18n: { "zh-CN": "电脑控制" },
            },
            "zcode-cua@custom-marketplace": {
              displayName: "Custom Computer Use",
              displayNameI18n: { "zh-CN": "自定义电脑控制" },
            },
          },
          plugins: [
            {
              commandRootCount: 0,
              dataPath: "/tmp/zcode/plugins/data/computer-use@zcode-plugins-official",
              enabled: true,
              id: "computer-use@zcode-plugins-official",
              manifestPath: "/plugins/cua/.zcode-plugin/plugin.json",
              marketplace: "zcode-plugins-official",
              mcpServerNames: [],
              name: "computer-use",
              rootPath: "/plugins/cua",
              skillCount: 0,
              skillRootCount: 0,
              source: "official",
            },
            {
              commandRootCount: 0,
              dataPath: "/tmp/zcode/plugins/data/zcode-cua@custom-marketplace",
              enabled: false,
              id: "zcode-cua@custom-marketplace",
              manifestPath: "/plugins/custom-cua/.zcode-plugin/plugin.json",
              marketplace: "custom-marketplace",
              mcpServerNames: [],
              name: "zcode-cua",
              rootPath: "/plugins/custom-cua",
              skillCount: 0,
              skillRootCount: 0,
              source: "cache",
            },
            {
              commandRootCount: 0,
              dataPath: "/tmp/zcode/plugins/data/zcode-cua@unlisted-marketplace",
              enabled: false,
              id: "zcode-cua@unlisted-marketplace",
              manifestPath: "/plugins/unlisted-cua/.zcode-plugin/plugin.json",
              marketplace: "unlisted-marketplace",
              mcpServerNames: [],
              name: "zcode-cua",
              rootPath: "/plugins/unlisted-cua",
              skillCount: 0,
              skillRootCount: 0,
              source: "cache",
            },
          ],
          skillRoots: [],
        }),
        sessionId: "sess_active",
        traceId: "trace-active",
        submitPrompt: async () => ({ response: "prompt" }),
      }) as never,
    getLocale: () => "zh-CN",
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/plugins", {
    abortSignal: new AbortController().signal,
  });

  const items = result.selection?.items ?? [];
  assert.equal(
    items.find((item) => item.id === "computer-use@zcode-plugins-official")?.primary,
    "✓ 电脑控制",
  );
  assert.equal(
    items.find((item) => item.id === "zcode-cua@custom-marketplace")?.primary,
    "○ 自定义电脑控制",
  );
  assert.equal(
    items.find((item) => item.id === "zcode-cua@unlisted-marketplace")?.primary,
    "○ ZCode Cua",
  );
});

test("command center toggles plugins and refreshes the picker", async () => {
  let enabled = false;
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        listPlugins: async () => ({
          commandRoots: [],
          diagnostics: [],
          mcpServers: {},
          plugins: [
            {
              commandRootCount: 1,
              dataPath: "/tmp/zcode/plugins/data/ios-simulator@zcode-plugins-official",
              enabled,
              id: "ios-simulator@zcode-plugins-official",
              manifestPath: "/plugins/ios/.zcode-plugin/plugin.json",
              marketplace: "zcode-plugins-official",
              mcpServerNames: ["ios-simulator"],
              name: "ios-simulator",
              rootPath: "/plugins/ios",
              skillCount: 1,
              skillRootCount: 1,
              source: "official",
              version: "0.1.0",
            },
          ],
          skillRoots: [],
        }),
        sessionId: "sess_active",
        setPluginEnabled: async (plugin, nextEnabled) => {
          assert.equal(plugin, "ios-simulator@zcode-plugins-official");
          enabled = nextEnabled;
          return {
            enabled,
            path: "/home/test/.zcode/cli/config.json",
            plugin: {
              commandRootCount: 1,
              dataPath: "/tmp/zcode/plugins/data/ios-simulator@zcode-plugins-official",
              enabled,
              id: "ios-simulator@zcode-plugins-official",
              manifestPath: "/plugins/ios/.zcode-plugin/plugin.json",
              marketplace: "zcode-plugins-official",
              mcpServerNames: ["ios-simulator"],
              name: "ios-simulator",
              rootPath: "/plugins/ios",
              skillCount: 1,
              skillRootCount: 1,
              source: "official",
              version: "0.1.0",
            },
          };
        },
        traceId: "trace-active",
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/plugins enable ios-simulator@zcode-plugins-official", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(enabled, true);
  assert.match(result.response, /Enabled plugin ios-simulator@zcode-plugins-official/);
  assert.equal(result.selection?.items[0]?.primary, "✓ Ios Simulator");
  assert.equal(
    result.selection?.items[0]?.command,
    "/plugins disable ios-simulator@zcode-plugins-official",
  );
});

test("command center requires --force before uninstalling a plugin", async () => {
  let uninstalled = false;
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        listPlugins: async () => ({
          commandRoots: [],
          diagnostics: [],
          mcpServers: {},
          plugins: [],
          skillRoots: [],
        }),
        sessionId: "sess_active",
        traceId: "trace-active",
        uninstallPlugin: async () => {
          uninstalled = true;
          return { removed: { id: "hello@market", name: "hello" } };
        },
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/plugins uninstall hello@market", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(uninstalled, false);
  assert.match(result.response, /Re-run with: \/plugins uninstall hello@market --force/);
});

test("command center uninstalls a plugin when --force is provided", async () => {
  let uninstalledPlugin = "";
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        listPlugins: async () => ({
          commandRoots: [],
          diagnostics: [],
          mcpServers: {},
          plugins: [],
          skillRoots: [],
        }),
        sessionId: "sess_active",
        traceId: "trace-active",
        uninstallPlugin: async (plugin: string) => {
          uninstalledPlugin = plugin;
          return { removed: { id: plugin, name: "hello" } };
        },
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/plugins uninstall hello@market --force", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(uninstalledPlugin, "hello@market");
  assert.match(result.response, /Uninstalled plugin hello@market/);
});

test("command center dispatches compact through the active app", async () => {
  let submitted = "";
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async (prompt: string) => {
          submitted = prompt;
          return {
            response: "Compacted",
            traceId: "trace-compact",
          };
        },
      }) as never,
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/compact keep recent edits", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(submitted, "/compact keep recent edits");
  assert.equal(result.response, "Compacted");
  assert.equal(result.traceId, "trace-compact");
});

test("command center dispatches init through the active app", async () => {
  let submitted = "";
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async (prompt: string) => {
          submitted = prompt;
          return {
            response: "Initialized",
            traceId: "trace-init",
          };
        },
      }) as never,
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/init include repo scripts", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(submitted, "/init include repo scripts");
  assert.equal(result.response, "Initialized");
  assert.equal(result.traceId, "trace-init");
});

test("command center dispatches workflow through the active app as a prompt", async () => {
  // 与 /init 同款：TUI 只识别名字，原文交给 app.submitPrompt，由 bootstrap 的 builtin resolver
  // 展开；没有显式分支会落到 resume 兜底，/workflow 就再也到不了模型。
  let submitted = "";
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async (prompt: string) => {
          submitted = prompt;
          return {
            response: "Workflow drafted",
            traceId: "trace-workflow",
          };
        },
      }) as never,
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/workflow review the auth module", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(submitted, "/workflow review the auth module");
  assert.equal(result.response, "Workflow drafted");
  assert.equal(result.traceId, "trace-workflow");
});

test("command center dispatches rewind through the active app", async () => {
  let submitted = "";
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async (prompt: string) => {
          submitted = prompt;
          return {
            response: "Rewound",
            traceId: "trace-rewind",
          };
        },
      }) as never,
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/rewind latest", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(submitted, "/rewind latest");
  assert.equal(result.response, "Rewound");
  assert.equal(result.traceId, "trace-rewind");
});

test("command center opens a checkpoint picker for bare rewind", async () => {
  let promptSubmitted = false;
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        listCheckpoints: async () => [
          {
            checkpointId: "checkpoint_2",
            createdAt: new Date("2026-05-05T10:00:00Z"),
            fileCount: 2,
            messageId: "msg_2",
            preview: "update tests",
            scope: "workspace",
          },
        ],
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          promptSubmitted = true;
          return {
            response: "prompt",
          };
        },
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/rewind", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(promptSubmitted, false);
  assert.equal(result.selection?.title, "Rewind To Checkpoint");
  assert.equal(result.selection?.placement, "composer");
  assert.equal(result.selection?.items[0]?.command, "/rewind checkpoint_2");
  assert.match(result.selection?.items[0]?.primary ?? "", /update tests/);
});

test("command center forks and switches the active app", async () => {
  let forkTarget: string | undefined;
  const submitPrompt = createCommandCenter({
    forkApp: async (targetCheckpointId) => {
      forkTarget = targetCheckpointId;
      return {
        forkedSessionId: "sess_child",
        response: "Forked session sess_child",
      };
    },
    getApp: async () =>
      ({
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
      }) as never,
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/fork checkpoint_1", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(forkTarget, "checkpoint_1");
  assert.equal(result.response, "Forked session sess_child");
});

test("command center opens a checkpoint picker for bare fork", async () => {
  let forkCalled = false;
  const submitPrompt = createCommandCenter({
    forkApp: async () => {
      forkCalled = true;
      throw new Error("fork should not run");
    },
    getApp: async () =>
      ({
        listCheckpoints: async () => [
          {
            checkpointId: "checkpoint_1",
            createdAt: 1777975200000,
            fileCount: 1,
            messageId: "msg_1",
            preview: "write file",
            scope: "workspace",
          },
        ],
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
      }) as never,
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/fork", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(forkCalled, false);
  assert.equal(result.selection?.title, "Fork From Checkpoint");
  assert.equal(result.selection?.placement, undefined);
  assert.equal(result.selection?.items[0]?.command, "/fork checkpoint_1");
});

test("command center starts a new session without sending a model prompt", async () => {
  let promptSubmitted = false;
  let newAppCreated = false;
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          promptSubmitted = true;
          return {
            response: "prompt",
          };
        },
      }) as never,
    getMode: () => "build",
    newApp: async () => {
      newAppCreated = true;
      return {
        sessionId: "sess_new",
        traceId: "trace-new",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
      } as never;
    },
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/new", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(promptSubmitted, false);
  assert.equal(newAppCreated, true);
  assert.equal(result.sessionId, "sess_new");
  assert.equal(result.traceId, "trace-new");
  assert.equal(result.resetSessionProjection, true);
  assert.match(result.response, /Started new session sess_new/);
});

test("command center treats clear as a new-session alias", async () => {
  let promptSubmitted = false;
  let newAppCreated = false;
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          promptSubmitted = true;
          return {
            response: "prompt",
          };
        },
      }) as never,
    getMode: () => "build",
    newApp: async () => {
      newAppCreated = true;
      return {
        sessionId: "sess_clear",
        traceId: "trace-clear",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
      } as never;
    },
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/clear", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(promptSubmitted, false);
  assert.equal(newAppCreated, true);
  assert.equal(result.sessionId, "sess_clear");
  assert.equal(result.traceId, "trace-clear");
  assert.equal(result.resetSessionProjection, true);
  assert.match(result.response, /Started new session sess_clear/);
});

test("command center dispatches skill through the active app", async () => {
  let submitted = "";
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async (prompt: string) => {
          submitted = prompt;
          return {
            response: "Skill task done",
            traceId: "trace-skill",
          };
        },
      }) as never,
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/skill demo-skill update docs", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(submitted, buildManualSkillPrompt("demo-skill", "update docs"));
  assert.equal(result.response, "Skill task done");
  assert.equal(result.traceId, "trace-skill");
});

test("command center reports and switches mode without sending a model prompt", async () => {
  let mode: "plan" | "build" | "edit" | "yolo" | "auto" = "build";
  let promptSubmitted = false;
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          promptSubmitted = true;
          return {
            response: "prompt",
          };
        },
      }) as never,
    getMode: () => mode,
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
    setMode: async (nextMode) => {
      mode = nextMode;
      return mode;
    },
  });

  const current = await submitPrompt("/mode", {
    abortSignal: new AbortController().signal,
  });
  const switched = await submitPrompt("/mode plan", {
    abortSignal: new AbortController().signal,
  });
  const editSwitched = await submitPrompt("/mode edit", {
    abortSignal: new AbortController().signal,
  });
  const rejected = await submitPrompt("/mode auto", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(promptSubmitted, false);
  assert.equal(current.mode, "build");
  assert.match(current.response, /Current mode: build/);
  assert.equal(current.selection, undefined);
  assert.equal(switched.mode, "plan");
  assert.match(switched.response, /Mode switched to plan/);
  assert.equal(editSwitched.mode, "edit");
  assert.match(editSwitched.response, /Mode switched to edit/);
  assert.equal(rejected.mode, "edit");
  assert.match(rejected.response, /Unsupported mode: auto/);
});

test("command center reports and switches model without sending a model prompt", async () => {
  let model = "openai/gpt-main";
  let promptSubmitted = false;
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        getModel: () => model,
        listModels: () => [
          createTestModelOption("openai", "gpt-main", { label: "Main" }),
          createTestModelOption("openai", "gpt-lite", { label: "Lite" }),
        ],
        sessionId: "sess_active",
        setModel: async (selection: ModelSelection) => {
          const previousModel = model;
          model = `${selection.providerId}/${selection.modelId}`;
          return {
            model,
            previousModel,
          };
        },
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          promptSubmitted = true;
          return {
            response: "prompt",
          };
        },
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const current = await submitPrompt("/model", {
    abortSignal: new AbortController().signal,
  });
  // /model lite 这类别名已移除，切换使用目录中的 provider/model。
  const switched = await submitPrompt("/model openai/gpt-lite", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(promptSubmitted, false);
  assert.match(current.response, /Current model: openai\/gpt-main/);
  assert.match(current.response, /- openai\/gpt-lite \(Lite; openai\)/);
  assert.match(switched.response, /Model switched to openai\/gpt-lite \(medium\)/);
});

test("command center reports and switches effort without sending a model prompt", async () => {
  let thoughtLevel = "medium";
  let promptSubmitted = false;
  const requestedLevels: string[] = [];
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        getThoughtLevel: () => thoughtLevel,
        listThoughtLevels: () => ["low", "medium", "high"],
        sessionId: "sess_active",
        setThoughtLevel: async (level: string) => {
          requestedLevels.push(level);
          const previousThoughtLevel = thoughtLevel;
          thoughtLevel = level;
          return {
            previousThoughtLevel,
            thoughtLevel,
          };
        },
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          promptSubmitted = true;
          return {
            response: "prompt",
          };
        },
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const current = await submitPrompt("/effort", {
    abortSignal: new AbortController().signal,
  });
  const listed = await submitPrompt("/effort list", {
    abortSignal: new AbortController().signal,
  });
  const switched = await submitPrompt("/variant HIGH", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(promptSubmitted, false);
  assert.equal(current.selection, undefined);
  assert.match(current.response, /Current reasoning effort: medium/);
  assert.match(current.response, /- medium \(current\)/);
  assert.deepEqual(current.effortOptions, [
    { id: "low", label: "low" },
    { id: "medium", label: "medium" },
    { id: "high", label: "high" },
  ]);
  assert.match(listed.response, /Current reasoning effort: medium/);
  assert.match(listed.response, /- high/);
  assert.match(switched.response, /Reasoning effort switched to high/);
  assert.equal(switched.thoughtLevel, "high");
  assert.deepEqual(requestedLevels, ["high"]);
});

test("command center reports and switches locale without sending a model prompt", async () => {
  let locale = "en-US" as const | "zh-CN";
  let promptSubmitted = false;
  const submitPrompt = createCommandCenter({
    getApp: async () =>
      ({
        getLocale: () => locale,
        sessionId: "sess_active",
        setLocale: async (requestedLocale: "auto" | "en-US" | "zh-CN") => {
          const previousLocale = locale;
          locale = requestedLocale === "zh-CN" ? "zh-CN" : "en-US";
          return {
            configPath: "/tmp/zcode/config.json",
            locale,
            previousLocale,
            requestedLocale,
          };
        },
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          promptSubmitted = true;
          return {
            response: "prompt",
          };
        },
      }) as never,
    getMode: () => "build",
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const current = await submitPrompt("/locale", {
    abortSignal: new AbortController().signal,
  });
  const switched = await submitPrompt("/locale zh-CN", {
    abortSignal: new AbortController().signal,
  });
  const rejected = await submitPrompt("/locale fr-FR", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(promptSubmitted, false);
  assert.equal(current.locale, "en-US");
  assert.match(current.response, /Current locale: en-US/);
  assert.equal(switched.locale, "zh-CN");
  assert.match(switched.response, /Locale switched to zh-CN/);
  assert.match(switched.response, /Config: \/tmp\/zcode\/config\.json/);
  assert.equal(rejected.locale, "zh-CN");
  assert.match(rejected.response, /Unsupported locale: fr-FR/);
});

test("command center lists skills without sending a model prompt", async () => {
  let listed = false;
  const submitPrompt = createCommandCenter({
    getApp: async () => {
      throw new Error("app should not be created");
    },
    getMode: () => "build",
    listSkills: async () => {
      listed = true;
      return {
        skills: [
          {
            description: "Use for demo tasks.",
            name: "demo-skill",
            path: "/workspace/project/.zcode/skills/demo/SKILL.md",
            scope: "project",
            source: "zcode",
            whenToUse: "When demo files change.",
          },
        ],
        totalDiscovered: 1,
      };
    },
    resumeApp: async () => {
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/skill", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(listed, true);
  assert.equal(result.mode, "build");
  assert.match(result.response, /Available skills \(1\)/);
  assert.match(result.response, /demo-skill \(project\/zcode\)/);
  assert.match(result.response, /Use for demo tasks\. When demo files change\./);
  assert.match(result.response, /\/workspace\/project\/\.zcode\/skills\/demo\/SKILL\.md/);
  assert.match(result.response, /Use \/skill <name> \[task\] to load one\./);
});

test("command center resumes the latest session", async () => {
  let requestedSessionId: string | undefined = "unset";
  const events: string[] = [];
  const submitPrompt = createCommandCenter({
    getApp: async () => {
      throw new Error("default app should not run");
    },
    resumeApp: async (sessionId) => {
      requestedSessionId = sessionId;
      return {
        sessionId: "sess_latest",
        traceId: "trace-app",
        loadSessionTranscript: async () => [
          {
            content: "previous user prompt",
            role: "user",
          },
          {
            content: "previous agent answer",
            role: "agent",
          },
        ],
        resume: async (options) => {
          await options?.onEvent?.(
            createRuntimeEvent("session_resumed", {
              directory: "/tmp/project",
              interruptedToolCount: 0,
              messageCount: 3,
              partCount: 5,
            }),
          );
          return {
            appliedMessageCount: 3,
            directory: "/tmp/project",
            interruptedToolCount: 0,
            messageCount: 3,
            partCount: 5,
            traceId: "trace-resume",
          };
        },
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
      };
    },
  });

  const result = await submitPrompt("/resume", {
    abortSignal: new AbortController().signal,
    onEvent: (event) => {
      events.push(event.type);
    },
  });

  assert.equal(requestedSessionId, undefined);
  assert.match(result.response, /Resumed session sess_latest/);
  assert.match(result.response, /Messages: 3\/3/);
  assert.equal(result.resetSessionProjection, true);
  assert.deepEqual(result.restoredMessages, [
    {
      content: "previous user prompt",
      role: "user",
    },
    {
      content: "previous agent answer",
      role: "agent",
    },
  ]);
  assert.equal(result.traceId, "trace-resume");
  assert.deepEqual(events, ["session_resumed"]);
});

test("command center opens a session picker for bare resume when sessions are available", async () => {
  let resumeCalled = false;
  const submitPrompt = createCommandCenter({
    getApp: async () => {
      throw new Error("default app should not run");
    },
    getMode: () => "build",
    listSessions: async () => [
      {
        directory: "/workspace/project",
        id: "sess_two",
        title: "Second session",
        updatedAt: new Date("2026-05-05T12:00:00Z"),
      },
      {
        directory: "/workspace/project",
        id: "sess_one",
        parentId: "sess_parent",
        title: "Forked session",
        updatedAt: 1777971600000,
      },
    ],
    resumeApp: async () => {
      resumeCalled = true;
      throw new Error("resume should not run");
    },
  });

  const result = await submitPrompt("/resume", {
    abortSignal: new AbortController().signal,
  });

  assert.equal(resumeCalled, false);
  assert.equal(result.mode, "build");
  assert.equal(result.selection?.title, "Resume Session");
  assert.equal(result.selection?.placement, "composer");
  assert.equal(result.selection?.items[0]?.command, "/resume sess_two");
  assert.match(result.selection?.items[1]?.meta ?? "", /fork of sess_parent/);
});

test("prints help with help flag", async () => {
  const ctx = createContext(["--help"]);
  const exitCode = await run(ctx);

  assert.equal(exitCode, 0);
  assert.match(ctx.stdout.output(), /With no command, zcode opens the full-screen TUI\./);
  assert.match(ctx.stdout.output(), /Commands:/);
  assert.match(ctx.stdout.output(), /--force-mcs/);
  assert.match(ctx.stdout.output(), /--surface <surface>/);
  assert.match(ctx.stdout.output(), /--resume <sessionId>/);
  assert.match(ctx.stdout.output(), /sessionId \(sess_\.\.\.\)/);
  assert.equal(ctx.stderr.output(), "");
});

test("prints version with version flag", async () => {
  const ctx = createContext(["--version"]);
  const exitCode = await run(ctx);

  assert.equal(exitCode, 0);
  assert.match(ctx.stdout.output().trim(), /^\d+\.\d+\.\d+|0\.0\.0$/);
  assert.equal(ctx.stderr.output(), "");
});

test("prints version with version command", async () => {
  const ctx = createContext(["version"]);
  const exitCode = await run(ctx);

  assert.equal(exitCode, 0);
  assert.match(ctx.stdout.output().trim(), /^\d+\.\d+\.\d+|0\.0\.0$/);
  assert.equal(ctx.stderr.output(), "");
});

test("rejects removed hello command", async () => {
  const ctx = createContext(["hello"]);
  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /Unknown command: hello/);
  assert.equal(ctx.stdout.output(), "");
});

test("zcode plugins list prints installed plugins", async () => {
  const ctx = createContext(["plugins", "list", "--verbose"]);
  const logger = {} as NonNullable<RunDependencies["logger"]>;
  const exitCode = await run(ctx, {
    cwd: () => "/workspace/project",
    logger,
    listPlugins: (options) => {
      assert.equal(options.logger, logger);
      assert.equal(options.workingDirectory, "/workspace/project");
      return {
        commandRoots: [],
        diagnostics: [
          {
            code: "plugin_unsupported_component",
            message: "Plugin component is ignored in P0: hooks",
            pluginId: "ios-dev@inline",
            severity: "warning",
          },
        ],
        mcpServers: {},
        plugins: [
          {
            commandRootCount: 1,
            dataPath: "/tmp/zcode/plugins/data/ios-dev@inline",
            enabled: true,
            id: "ios-dev@inline",
            manifestPath: "/plugins/ios/.zcode-plugin/plugin.json",
            marketplace: "inline",
            mcpServerNames: ["ios-simulator"],
            name: "ios-dev",
            rootPath: "/plugins/ios",
            skillCount: 1,
            skillRootCount: 1,
            source: "inline",
          },
        ],
        skillRoots: [],
      } as never;
    },
  });

  const output = ctx.stdout.output();
  assert.equal(exitCode, 0);
  assert.match(output, /Plugins \(1\)/);
  assert.match(output, /ios-dev@inline \[enabled\]/);
  assert.match(output, /mcp: ios-simulator/);
  assert.match(output, /Diagnostics \(1\)/);
});

test("official plugin host runs a seeded official plugin server main", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-plugin-host-"));
  const pluginRoot = join(
    root,
    "cache",
    ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    "ios-simulator",
    "0.1.0",
  );
  const serverPath = join(pluginRoot, "dist", "mcp", "server.js");
  const outputPath = join(root, "host-output.json");
  const originalOutputEnv = process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT;

  try {
    await mkdir(join(pluginRoot, "dist", "mcp"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".zcode-plugin-seed.json"),
      JSON.stringify({
        marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
        plugin: "ios-simulator",
        pluginVersion: "0.1.0",
        version: 1,
      }),
    );
    await writeFile(join(pluginRoot, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      serverPath,
      `import { writeFile } from "node:fs/promises";
export async function main() {
  await writeFile(process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT, JSON.stringify({ argv: process.argv }));
}
`,
    );

    process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT = outputPath;
    const ctx = createContext([ZCODE_PLUGIN_HOST_COMMAND, serverPath]);
    const exitCode = await run(ctx);

    assert.equal(exitCode, 0);
    assert.equal(ctx.stdout.output(), "");
    assert.equal(ctx.stderr.output(), "");
    const payload = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(payload.argv[0], process.execPath);
    assert.equal(payload.argv[1], serverPath);
  } finally {
    if (originalOutputEnv === undefined) {
      delete process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT;
    } else {
      process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT = originalOutputEnv;
    }
    await rm(root, { force: true, recursive: true });
  }
});

test("retired argv-based CUA host fails closed without the shared node_repl marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-cua-plugin-host-mismatch-"));
  const serverPath = join(root, "server.js");
  const outputPath = join(root, "host-output.json");
  const keys = [
    "ZCODE_CUA_PERMISSION_BROKER_SOCKET",
    "ZCODE_CUA_PERMISSION_BROKER_TOKEN",
    "ZCODE_PLUGIN_HOST_TEST_OUTPUT",
    ZCODE_PLUGIN_ID_ENV_KEY,
    ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
    ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ] as const;
  const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      serverPath,
      `import { writeFile } from "node:fs/promises";
export async function main() {
  await writeFile(process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT, JSON.stringify({
    token: process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN,
  }));
}
`,
    );
    process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT = outputPath;
    process.env[ZCODE_PLUGIN_ID_ENV_KEY] = ZCODE_CUA_OFFICIAL_PLUGIN_ID;
    process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET = "/tmp/cua-broker.sock";
    process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN = "scoped-secret-token";
    process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY] = "official-authority";
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    sanitizeZCodeRuntimeEnvInPlace(process.env);
    assert.equal(process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], undefined);

    const ctx = createContext([ZCODE_PLUGIN_HOST_COMMAND, serverPath]);
    const exitCode = await runPluginHostCommand(ctx, [
      serverPath,
      "--permission-broker-socket",
      "/tmp/attacker.sock",
    ]);

    assert.equal(exitCode, 1);
    assert.match(
      ctx.stderr.output(),
      /Captured ZCode CUA broker credentials may only launch the trusted shared node_repl host/,
    );
    await assert.rejects(readFile(outputPath, "utf8"), { code: "ENOENT" });
  } finally {
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { force: true, recursive: true });
  }
});

test("shared node_repl host restores the captured CUA broker credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-cua-node-repl-host-"));
  const serverPath = join(root, "server.js");
  const outputPath = join(root, "host-output.json");
  const keys = [
    "ZCODE_CUA_PERMISSION_BROKER_SOCKET",
    "ZCODE_CUA_PERMISSION_BROKER_TOKEN",
    "ZCODE_PLUGIN_HOST_TEST_OUTPUT",
    ZCODE_PLUGIN_ID_ENV_KEY,
    ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
    ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ] as const;
  const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      serverPath,
      `import { writeFile } from "node:fs/promises";
export async function main() {
  await writeFile(process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT, JSON.stringify({
    socket: process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET,
    token: process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN,
  }));
}
`,
    );
    process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT = outputPath;
    process.env[ZCODE_PLUGIN_ID_ENV_KEY] = ZCODE_CUA_OFFICIAL_PLUGIN_ID;
    process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] = "1";
    process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET = "/tmp/cua-broker.sock";
    process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN = "scoped-secret-token";
    process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY] = "official-authority";
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    sanitizeZCodeRuntimeEnvInPlace(process.env);

    const ctx = createContext([ZCODE_PLUGIN_HOST_COMMAND, serverPath]);
    assert.equal(await runPluginHostCommand(ctx, [serverPath]), 0);
    // identity 模式：恢复给宿主的只有 socket（配 authority），没有口令。环境里那个遗留
    // token 是历史键，sanitize 会连它一起剔除，因此宿主根本看不到它 —— 否则旧版 Helper
    // （认 bearer token 的那些）就能被同 agent 内的其它子进程直接驱动。
    // 逐字段断言：JSON.stringify 会把值为 undefined 的键整个省掉，深比较对不上。
    const hostEnv = JSON.parse(await readFile(outputPath, "utf8")) as {
      socket?: string;
      token?: string;
    };
    assert.equal(hostEnv.socket, "/tmp/cua-broker.sock");
    assert.equal(hostEnv.token, undefined);
    // 宿主只在运行期间短暂恢复，跑完父进程 env 必须回到已剔除状态。
    assert.equal(process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET, undefined);
    assert.equal(process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN, undefined);
  } finally {
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { force: true, recursive: true });
  }
});

test("shared node_repl host launches with identity-mode credentials (socket + authority, no token)", async () => {
  // M1 身份模式（darwin）：Helper 不签发 token；M7 懒启动：authority 由 spawn 铸造。
  // 2026-09-10 回归：守卫曾要求 token，导致 node_repl 宿主启动即退出、工具面为空。
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-cua-node-repl-identity-"));
  const serverPath = join(root, "server.js");
  const outputPath = join(root, "host-output.json");
  const keys = [
    "ZCODE_CUA_PERMISSION_BROKER_SOCKET",
    "ZCODE_CUA_PERMISSION_BROKER_TOKEN",
    "ZCODE_PLUGIN_HOST_TEST_OUTPUT",
    ZCODE_PLUGIN_ID_ENV_KEY,
    ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
    ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ] as const;
  const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      serverPath,
      `import { writeFile } from "node:fs/promises";
export async function main() {
  await writeFile(process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT, JSON.stringify({
    socket: process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET,
    token: process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN ?? null,
  }));
}
`,
    );
    process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT = outputPath;
    process.env[ZCODE_PLUGIN_ID_ENV_KEY] = ZCODE_CUA_OFFICIAL_PLUGIN_ID;
    process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] = "1";
    process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET = "/tmp/cua-broker.sock";
    delete process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN;
    process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY] = "official-authority";
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    sanitizeZCodeRuntimeEnvInPlace(process.env);

    const ctx = createContext([ZCODE_PLUGIN_HOST_COMMAND, serverPath]);
    assert.equal(await runPluginHostCommand(ctx, [serverPath]), 0);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
      socket: "/tmp/cua-broker.sock",
      token: null,
    });
  } finally {
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { force: true, recursive: true });
  }
});

test("plugin host refuses non-official code while product broker credentials are captured", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-non-cua-plugin-host-"));
  const serverPath = join(root, "server.js");
  const outputPath = join(root, "host-output.json");
  const keys = [
    "ZCODE_CUA_PERMISSION_BROKER_SOCKET",
    "ZCODE_CUA_PERMISSION_BROKER_TOKEN",
    "ZCODE_PLUGIN_HOST_TEST_OUTPUT",
    ZCODE_PLUGIN_ID_ENV_KEY,
    ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
    ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ] as const;
  const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      serverPath,
      `import { writeFile } from "node:fs/promises";
export async function main() {
  await writeFile(process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT, String(Boolean(process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN)));
}
`,
    );
    process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT = outputPath;
    process.env[ZCODE_PLUGIN_ID_ENV_KEY] = "zcode-cua@third-party";
    process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET = "/tmp/cua-broker.sock";
    process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN = "must-not-leak";
    process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY] = "captured-authority";
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    sanitizeZCodeRuntimeEnvInPlace(process.env);
    assert.equal(process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], undefined);

    const ctx = createContext([
      ZCODE_PLUGIN_HOST_COMMAND,
      serverPath,
      "--permission-broker-socket",
      "/tmp/cua-broker.sock",
    ]);
    assert.equal(await run(ctx), 1);
    assert.match(
      ctx.stderr.output(),
      /Captured ZCode CUA broker credentials may only launch the trusted shared node_repl host/,
    );
    await assert.rejects(readFile(outputPath, "utf8"), { code: "ENOENT" });
  } finally {
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    for (const key of keys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { force: true, recursive: true });
  }
});

test("plugin host can run an explicitly configured third-party module", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-plugin-host-third-party-"));
  const serverPath = join(root, "third-party", "server.js");
  const outputPath = join(root, "third-party-output.json");
  const originalOutputEnv = process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT;

  try {
    await mkdir(join(root, "third-party"), { recursive: true });
    await writeFile(join(root, "third-party", "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      serverPath,
      `import { writeFile } from "node:fs/promises";
export async function main() {
  await writeFile(process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT, JSON.stringify({ argv: process.argv }));
}
`,
    );

    process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT = outputPath;
    const ctx = createContext([ZCODE_PLUGIN_HOST_COMMAND, serverPath, "--", "hello"]);
    const exitCode = await run(ctx);

    assert.equal(exitCode, 0);
    assert.equal(ctx.stdout.output(), "");
    assert.equal(ctx.stderr.output(), "");
    const payload = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(payload.argv, [process.execPath, serverPath, "--", "hello"]);
  } finally {
    if (originalOutputEnv === undefined) {
      delete process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT;
    } else {
      process.env.ZCODE_PLUGIN_HOST_TEST_OUTPUT = originalOutputEnv;
    }
    await rm(root, { force: true, recursive: true });
  }
});

test("plugin host stays alive past the one-shot CLI watchdog deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-plugin-host-lifetime-"));
  const serverPath = join(root, "server.mjs");
  const cliEntryPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const tsxLoaderPath = fileURLToPath(import.meta.resolve("tsx"));
  let child: ReturnType<typeof spawn> | undefined;

  try {
    await writeFile(
      serverPath,
      `export async function main() {
  process.stdin.resume();
  process.stdout.write("plugin-host-ready\\n");
}
`,
    );

    child = spawn(
      process.execPath,
      ["--import", tsxLoaderPath, cliEntryPath, ZCODE_PLUGIN_HOST_COMMAND, serverPath],
      {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    child.stdout?.setEncoding("utf8");
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        let stdout = "";
        const cleanup = () => {
          child?.stdout?.off("data", onData);
          child?.off("exit", onExit);
        };
        const onData = (chunk: string) => {
          stdout += chunk;
          if (!stdout.includes("plugin-host-ready")) return;
          cleanup();
          resolve();
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          reject(new Error(`plugin host exited before ready: code=${code}, signal=${signal}`));
        };
        child?.stdout?.on("data", onData);
        child?.once("exit", onExit);
      }),
      5_000,
      "plugin host did not become ready",
    );

    await delay(1_250);
    assert.equal(child.exitCode, null);

    child.stdin?.end();
    const [exitCode, signal] = (await withTimeout(
      once(child, "exit"),
      5_000,
      "plugin host did not exit after stdin closed",
    )) as [number | null, NodeJS.Signals | null];
    assert.equal(exitCode, 0);
    assert.equal(signal, null);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await rm(root, { force: true, recursive: true });
  }
});

test("failed plugin host still exits when initialization leaves stdin active", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cli-plugin-host-failure-"));
  const serverPath = join(root, "server.mjs");
  const cliEntryPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const tsxLoaderPath = fileURLToPath(import.meta.resolve("tsx"));
  let child: ReturnType<typeof spawn> | undefined;
  let stderr = "";

  try {
    await writeFile(
      serverPath,
      `export async function main() {
  process.stdin.resume();
  throw new Error("expected initialization failure");
}
`,
    );

    child = spawn(
      process.execPath,
      ["--import", tsxLoaderPath, cliEntryPath, ZCODE_PLUGIN_HOST_COMMAND, serverPath],
      {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const [exitCode, signal] = (await withTimeout(
      once(child, "exit"),
      5_000,
      "failed plugin host did not exit",
    )) as [number | null, NodeJS.Signals | null];
    assert.equal(exitCode, 1);
    assert.equal(signal, null);
    assert.match(stderr, /Plugin host failed: expected initialization failure/u);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await rm(root, { force: true, recursive: true });
  }
});

test("zcode plugins enable persists the selected plugin", async () => {
  const ctx = createContext(["plugins", "enable", "ios-dev"]);
  const exitCode = await run(ctx, {
    cwd: () => "/workspace/project",
    setPluginEnabled: async (options) => {
      assert.equal(options.enabled, true);
      assert.equal(options.plugin, "ios-dev");
      assert.equal(options.workingDirectory, "/workspace/project");
      return {
        enabled: true,
        path: "/home/test/.zcode/cli/config.json",
        plugin: {
          commandRootCount: 1,
          dataPath: "/tmp/zcode/plugins/data/ios-dev@zcode-plugins-official",
          enabled: true,
          id: "ios-dev@zcode-plugins-official",
          manifestPath: "/plugins/ios/.zcode-plugin/plugin.json",
          marketplace: "zcode-plugins-official",
          mcpServerNames: ["ios-simulator"],
          name: "ios-dev",
          rootPath: "/plugins/ios",
          skillCount: 1,
          skillRootCount: 1,
          source: "official",
        },
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.match(
    ctx.stdout.output(),
    /Enabled plugin ios-dev@zcode-plugins-official in \/home\/test\/.zcode\/cli\/config\.json/,
  );
});

test("prints slash help for prompt help command without creating an app", async () => {
  const ctx = createContext(["--prompt", "/help"]);
  let appCreated = false;
  const exitCode = await run(ctx, {
    createZCodeApp: () => {
      appCreated = true;
      throw new Error("app should not be created");
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(appCreated, false);
  assert.match(ctx.stdout.output(), /Slash commands:/);
  assert.match(ctx.stdout.output(), /\/help \[command\]/);
  assert.match(ctx.stdout.output(), /Use \/help <command> for details\./);
  assert.equal(ctx.stderr.output(), "");
});

test("lists skills in human format", async () => {
  const ctx = createContext(["skills", "list", "--verbose"]);
  const logger = {} as NonNullable<RunDependencies["logger"]>;
  const exitCode = await run(ctx, {
    cwd: () => "/workspace/project",
    logger,
    listSkills: async (options) => {
      assert.equal(options.logger, logger);
      assert.equal(options.workingDirectory, "/workspace/project");
      return {
        diagnostics: [
          {
            code: "skill_scan_failed",
            message: "Failed to scan skill directory: demo",
            path: "/workspace/project/.zcode/skills/demo/SKILL.md",
            severity: "warning",
            skillName: "demo",
          },
        ],
        skills: [
          {
            description: "Use for demo tasks.",
            directory: "/workspace/project/.zcode/skills/demo",
            frontmatterKeys: ["name", "description", "version"],
            name: "demo",
            path: "/workspace/project/.zcode/skills/demo/SKILL.md",
            rootPath: "/workspace/project/.zcode/skills",
            safeToAutoLoad: true,
            scope: "project",
            source: "zcode",
          },
        ],
        totalDiscovered: 1,
      } as never;
    },
  });

  const output = ctx.stdout.output();
  assert.equal(exitCode, 0);
  assert.match(output, /Available skills \(1\)/);
  assert.match(output, /demo \(project\/zcode\)/);
  assert.match(output, /Use for demo tasks\./);
  assert.match(output, /Diagnostics \(1\)/);
  assert.equal(ctx.stderr.output(), "");
});

test("lists skills for bare prompt skill command", async () => {
  const ctx = createContext(["--prompt", "/skill"]);
  let listed = false;
  let appCreated = false;
  const exitCode = await run(ctx, {
    createZCodeApp: () => {
      appCreated = true;
      throw new Error("app should not be created");
    },
    cwd: () => "/workspace/project",
    listSkills: async (options) => {
      listed = true;
      assert.equal(options.workingDirectory, "/workspace/project");
      return {
        diagnostics: [],
        skills: [
          {
            description: "Review React code.",
            directory: "/workspace/project/.zcode/skills/react",
            frontmatterKeys: ["name", "description"],
            name: "react-review",
            path: "/workspace/project/.zcode/skills/react/SKILL.md",
            rootPath: "/workspace/project/.zcode/skills",
            safeToAutoLoad: true,
            scope: "project",
            source: "zcode",
          },
        ],
        totalDiscovered: 1,
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(listed, true);
  assert.equal(appCreated, false);
  assert.match(ctx.stdout.output(), /Available skills \(1\)/);
  assert.match(ctx.stdout.output(), /react-review \(project\/zcode\)/);
  assert.equal(ctx.stderr.output(), "");
});

test("lists skills in JSON format", async () => {
  const ctx = createContext(["skills", "--json"]);
  const exitCode = await run(ctx, {
    cwd: () => "/workspace/project",
    listSkills: async () =>
      ({
        diagnostics: [],
        skills: [
          {
            description: "Review React code.",
            directory: "/workspace/project/.zcode/skills/react",
            frontmatterKeys: ["name", "description", "when_to_use"],
            name: "react-review",
            path: "/workspace/project/.zcode/skills/react/SKILL.md",
            rootPath: "/workspace/project/.zcode/skills",
            safeToAutoLoad: true,
            scope: "project",
            source: "zcode",
            whenToUse: "When React files change.",
          },
        ],
        totalDiscovered: 1,
      }) as never,
  });
  const payload = JSON.parse(ctx.stdout.output()) as {
    cwd: string;
    skills: Array<{ name: string; source: string; whenToUse?: string }>;
    totalDiscovered: number;
  };

  assert.equal(exitCode, 0);
  assert.equal(payload.cwd, "/workspace/project");
  assert.equal(payload.skills[0]?.name, "react-review");
  assert.equal(payload.skills[0]?.source, "zcode");
  assert.equal(payload.skills[0]?.whenToUse, "When React files change.");
  assert.equal(payload.totalDiscovered, 1);
  assert.equal(ctx.stderr.output(), "");
});

test("rejects unknown skills subcommands", async () => {
  const ctx = createContext(["skills", "missing"]);
  const exitCode = await run(ctx, {
    listSkills: async () => {
      throw new Error("should not list");
    },
  });

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /Unknown skills command: missing/);
  assert.match(ctx.stderr.output(), /Usage: zcode skills \[list\|inspect <name>\]/);
  assert.equal(ctx.stdout.output(), "");
});

test("loads nearest dotenv without overriding shell env", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dotenv-"));
  const nested = join(tempRoot, "project", "nested");

  try {
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(tempRoot, ".env"),
      ["ZCODE_API_KEY=from-file", "ZCODE_BASE_URL=https://example.test"].join("\n"),
    );

    const env: NodeJS.ProcessEnv = {
      ZCODE_API_KEY: "from-shell",
    };
    const result = loadCliDotenv({ cwd: nested, env });

    assert.equal(findDotenv(nested), join(tempRoot, ".env"));
    assert.equal(result.loaded, true);
    assert.deepEqual(result.keys.sort(), ["ZCODE_API_KEY", "ZCODE_BASE_URL"].sort());
    assert.equal(env.ZCODE_API_KEY, "from-shell");
    assert.equal(env.ZCODE_BASE_URL, "https://example.test");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("loads dotenv before creating the prompt app", async () => {
  const env: NodeJS.ProcessEnv = {};
  const ctx = createContext(["--prompt", "hello env"]);
  let appEnv: NodeJS.ProcessEnv | undefined;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      appEnv = options?.env;
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    env,
    loadDotenv: (options) => {
      if (options?.env) {
        options.env.ZCODE_API_KEY = "loaded-at-runtime";
      }
      return {
        keys: ["ZCODE_API_KEY"],
        loaded: true,
        path: "/tmp/project/.env",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(appEnv?.ZCODE_API_KEY, "loaded-at-runtime");
  assert.equal(ctx.stdout.output(), "hello env\n");
  assert.equal(ctx.stderr.output(), "");
});

test("runs a single prompt without opening the TUI", async () => {
  const ctx = createContext(["--prompt", "hello runtime"]);
  const exitCode = await run(ctx, createPromptDeps());

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello runtime\n");
  assert.equal(ctx.stderr.output(), "");
});

test("passes the CLI version into app creation for prompt runs", async () => {
  const ctx = createContext(["--prompt", "hello version"]);
  let appVersion: string | undefined;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      appVersion = options?.version;
      return {
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(appVersion, "0.0.0");
});

test("passes prompt attachments into the app API", async () => {
  const ctx = createContext([
    "--prompt",
    "describe",
    "--attach",
    "screen.png",
    "--attach",
    "notes.txt",
    "--attach",
    "demo.MP4",
  ]);
  let submitted: unknown;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () =>
      ({
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: unknown) => {
          submitted = prompt;
          return {
            events: [],
            projection: fakeProjection as never,
            response: "done",
            traceId: "trace-test" as never,
            turnId: "turn-test" as never,
          };
        },
      }) as never,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(submitted, {
    text: "describe",
    attachments: [
      { type: "image", path: "screen.png" },
      { type: "file", path: "notes.txt" },
      { type: "video", path: "demo.MP4" },
    ],
  });
  assert.equal(ctx.stdout.output(), "done\n");
});

test("rewrites skill slash commands for single prompts", async () => {
  const ctx = createContext(["--prompt", "/skill demo-skill update docs"]);
  let submitted = "";
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () =>
      ({
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => {
          submitted = prompt;
          return {
            events: [],
            projection: fakeProjection as never,
            response: "done",
            traceId: "trace-test" as never,
            turnId: "turn-test" as never,
          };
        },
      }) as never,
  });

  assert.equal(exitCode, 0);
  assert.equal(submitted, buildManualSkillPrompt("demo-skill", "update docs"));
  assert.equal(ctx.stdout.output(), "done\n");
  assert.equal(ctx.stderr.output(), "");
});

test("rejects goal replacement flag without target", async () => {
  const ctx = createContext(["--target-replace"]);
  const exitCode = await run(ctx, createPromptDeps());

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /--target-replace requires --target/);
  assert.equal(ctx.stdout.output(), "");
});

test("runs goal command without prompt", async () => {
  const ctx = createContext(["--target", "Ship target MVP"]);
  let continued = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.deepEqual(options?.runtimeConfig?.memory, {
        extractionEnabled: false,
      });
      return {
        clearTarget: async () => false,
        continueActiveTarget: async () => {
          continued = true;
          return {
            projection: fakeProjection as never,
            response: "continued target",
            traceId: "trace-target-continue" as never,
            turnId: "turn-target-continue" as never,
          };
        },
        readTarget: async () => null,
        sessionId: "session-target-continue",
        setTarget: async ({ objective, status = "active" }) => ({
          objective,
          sessionID: "session-target-continue",
          status,
          targetID: "target-continue",
          time: { created: 1, updated: 1 },
        }),
        traceId: "trace-target-continue",
        runtime: {} as never,
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
        updateTargetStatus: async () => null,
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(continued, true);
  assert.equal(ctx.stdout.output(), "continued target\n");
  assert.equal(ctx.stderr.output(), "");
});

test("passes force MCS into target runtime config", async () => {
  const ctx = createContext(["--force-mcs", "--target", "Ship target MVP"]);
  let continued = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.deepEqual((options?.runtimeConfig as any)?.midConversationSystem, {
        mode: "force",
      });
      return {
        clearTarget: async () => false,
        continueActiveTarget: async () => {
          continued = true;
          return {
            projection: fakeProjection as never,
            response: "continued target",
            traceId: "trace-target-force-mcs" as never,
            turnId: "turn-target-force-mcs" as never,
          };
        },
        readTarget: async () => null,
        sessionId: "session-target-force-mcs",
        setTarget: async ({ objective, status = "active" }) => ({
          objective,
          sessionID: "session-target-force-mcs",
          status,
          targetID: "target-force-mcs",
          time: { created: 1, updated: 1 },
        }),
        traceId: "trace-target-force-mcs",
        runtime: {} as never,
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
        updateTargetStatus: async () => null,
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(continued, true);
  assert.equal(ctx.stdout.output(), "continued target\n");
  assert.equal(ctx.stderr.output(), "");
});

test("rejects empty target text", async () => {
  const ctx = createContext(["--target", "   "]);
  const exitCode = await run(ctx, createPromptDeps());

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /--target requires non-empty text/);
  assert.equal(ctx.stdout.output(), "");
});

test("rejects combining target with prompt", async () => {
  const ctx = createContext(["--prompt", "hello target", "--target", "Ship target MVP"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () =>
      ({
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
      }) as never,
  });

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /--target cannot be used with --prompt/);
  assert.equal(ctx.stdout.output(), "");
});

test("closes the app after a headless prompt", async () => {
  const ctx = createContext(["--prompt", "hello"]);
  let closeCount = 0;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () =>
      ({
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        close: async () => {
          closeCount += 1;
        },
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      }) as never,
  });

  assert.equal(exitCode, 0);
  assert.equal(closeCount, 1);
  assert.equal(ctx.stdout.output(), "hello\n");
});

test("shuts down prepared telemetry after a headless prompt", async () => {
  const ctx = createContext(["--prompt", "hello telemetry"]);
  let telemetryShutdownCount = 0;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    prepareZCodeTelemetryEnv: async (env) => env,
    shutdownZCodeTelemetry: async () => {
      telemetryShutdownCount += 1;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(telemetryShutdownCount, 1);
});

test("shuts down prepared telemetry when headless app creation fails", async () => {
  const ctx = createContext(["--prompt", "failing telemetry"]);
  let telemetryShutdownCount = 0;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () => {
      throw new Error("app creation failed");
    },
    prepareZCodeTelemetryEnv: async (env) => env,
    shutdownZCodeTelemetry: async () => {
      telemetryShutdownCount += 1;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(telemetryShutdownCount, 1);
});

test("aborts and closes the headless app on process shutdown signals", async () => {
  const ctx = createContext(["--prompt", "hello"]);
  const shutdownProcess = createTestShutdownProcess("linux");
  const exitDeferred = createDeferred<number>();
  const promptStarted = createDeferred<void>();
  let closeCount = 0;
  let abortSeen = false;

  const runPromise = run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () =>
      ({
        close: async () => {
          closeCount += 1;
        },
        runtime: {} as never,
        sessionId: "session-test",
        submitPrompt: async (_prompt: string, options?: { abortSignal?: AbortSignal }) => {
          promptStarted.resolve();
          return await new Promise<never>((_resolve, reject) => {
            options?.abortSignal?.addEventListener(
              "abort",
              () => {
                abortSeen = true;
                reject(new Error("aborted by signal"));
              },
              { once: true },
            );
          });
        },
        traceId: "trace-test",
      }) as never,
    exitProcess: (code) => {
      exitDeferred.resolve(code);
    },
    shutdownProcess,
  });

  await promptStarted.promise;
  shutdownProcess.emitSignal("SIGTERM");

  assert.equal(await exitDeferred.promise, 143);
  assert.equal(await runPromise, 1);
  assert.equal(abortSeen, true);
  assert.equal(closeCount, 1);
});

test("closes a late async app without submitting after shutdown during initialization", async () => {
  const ctx = createContext(["--prompt", "hello"]);
  const shutdownProcess = createTestShutdownProcess("linux");
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  const exited = createDeferred<number>();
  let closed = 0;
  let submitted = 0;
  const running = run(ctx, {
    ...createPromptDeps(),
    shutdownProcess,
    exitProcess: (code) => exited.resolve(code),
    createZCodeApp: async () => {
      started.resolve();
      await release.promise;
      return {
        close: async () => {
          closed += 1;
        },
        submitPrompt: async () => {
          submitted += 1;
          throw new Error("must not submit");
        },
        runtime: {},
        sessionId: "late-app",
        traceId: "late-trace",
      } as never;
    },
  });
  await started.promise;
  shutdownProcess.emitSignal("SIGTERM");
  assert.equal(await exited.promise, 143);
  release.resolve();
  assert.equal(await running, 1);
  assert.equal(submitted, 0);
  assert.equal(closed, 1);
});

test("TUI closes an app that finishes initialization after handler shutdown", async () => {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  let closed = 0;
  const handler = createTuiSubmitPrompt(
    {
      ...createPromptDeps(),
      createZCodeApp: async () => {
        started.resolve();
        await release.promise;
        return {
          close: async () => {
            closed += 1;
          },
          getModel: () => "model",
        } as never;
      },
    },
    {},
    "test",
  );
  const pending = handler.getSessionMetadata!();
  // 立即注册 rejection observer，避免关闭与迟到返回之间产生未处理拒绝。
  const rejected = assert.rejects(pending, /closed/);
  await started.promise;
  await handler.close?.();
  release.resolve();
  await rejected;
  assert.equal(closed, 1);
});

test("rejects headless goal replacement without explicit target-replace", async () => {
  const ctx = createContext(["--target", "New target"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () =>
      ({
        clearTarget: async () => true,
        continueActiveTarget: async () => null,
        readTarget: async () => ({
          objective: "Existing target",
          sessionID: "session-test",
          status: "active",
          targetID: "target-existing",
          time: { created: 1, updated: 1 },
        }),
        sessionId: "session-test",
        setTarget: async () => {
          throw new Error("target should not be replaced");
        },
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
        updateTargetStatus: async () => null,
      }) as never,
  });

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /A goal already exists/);
  assert.match(
    ctx.stderr.output(),
    /Headless goal commands cannot open an interactive replacement picker/,
  );
  assert.equal(ctx.stdout.output(), "");
});

test("replaces an existing goal for headless goal commands when target-replace is set", async () => {
  const ctx = createContext(["--target", "New target", "--target-replace"]);
  let replacedObjective = "";
  let continued = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () =>
      ({
        clearTarget: async () => true,
        continueActiveTarget: async () => {
          continued = true;
          return {
            projection: fakeProjection as never,
            response: "continued target",
            traceId: "trace-target-continue" as never,
            turnId: "turn-target-continue" as never,
          };
        },
        readTarget: async () => ({
          objective: "Existing target",
          sessionID: "session-test",
          status: "active",
          targetID: "target-existing",
          time: { created: 1, updated: 1 },
        }),
        sessionId: "session-test",
        setTarget: async (input: { objective: string; status?: string }) => {
          replacedObjective = `${input.objective}:${input.status ?? "missing"}`;
          return {
            objective: input.objective,
            sessionID: "session-test",
            status: input.status ?? "active",
            targetID: "target-replaced",
            time: { created: 1, updated: 1 },
          };
        },
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
        updateTargetStatus: async () => null,
      }) as never,
  });

  assert.equal(exitCode, 0);
  assert.equal(replacedObjective, "New target:active");
  assert.equal(continued, true);
  assert.equal(ctx.stdout.output(), "continued target\n");
  assert.equal(ctx.stderr.output(), "");
});

test("runs slash goal commands directly in headless prompt mode", async () => {
  const ctx = createContext(["--prompt", "/goal Ship target MVP"]);
  let continued = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () =>
      ({
        clearTarget: async () => false,
        continueActiveTarget: async () => {
          continued = true;
          return {
            projection: fakeProjection as never,
            response: "continued target",
            traceId: "trace-target-continue" as never,
            turnId: "turn-target-continue" as never,
          };
        },
        readTarget: async () => null,
        sessionId: "session-target-continue",
        setTarget: async ({ objective, status = "active" }) => ({
          objective,
          sessionID: "session-target-continue",
          status,
          targetID: "target-continue",
          time: { created: 1, updated: 1 },
        }),
        traceId: "trace-target-continue",
        runtime: {} as never,
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
        updateTargetStatus: async () => null,
      }) as never,
  });

  assert.equal(exitCode, 0);
  assert.equal(continued, true);
  assert.equal(ctx.stdout.output(), "continued target\n");
  assert.equal(ctx.stderr.output(), "");
});

test("rejects interactive goal replacement prompts in headless mode", async () => {
  const ctx = createContext(["--prompt", "/goal New target"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () =>
      ({
        clearTarget: async () => true,
        continueActiveTarget: async () => null,
        readTarget: async () => ({
          objective: "Existing target",
          sessionID: "session-target-existing",
          status: "active",
          targetID: "target-existing",
          time: { created: 1, updated: 1 },
        }),
        sessionId: "session-target-existing",
        setTarget: async () => {
          throw new Error("replace should not happen without explicit confirmation");
        },
        traceId: "trace-target-existing",
        runtime: {} as never,
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
        updateTargetStatus: async () => null,
      }) as never,
  });

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /A goal already exists/);
  assert.match(
    ctx.stderr.output(),
    /Headless goal commands cannot open an interactive replacement picker/,
  );
  assert.equal(ctx.stdout.output(), "");
});

test("defaults headless prompts to yolo mode", async () => {
  const ctx = createContext(["--prompt", "hello default mode"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.equal(options?.runtimeConfig?.mode, "yolo");
      assert.equal(options?.runtimeConfig?.presentationSurface, "terminal");
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello default mode\n");
});

test("passes the Desktop presentation surface into headless runtime config", async () => {
  const ctx = createContext(["--surface", "desktop", "--prompt", "hello desktop"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.equal(options?.runtimeConfig?.presentationSurface, "zcode_desktop");
      assert.equal(options?.sourceTitle, undefined);
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello desktop\n");
});

test("rejects unsupported presentation surfaces", async () => {
  const ctx = createContext(["--surface", "web", "--prompt", "hello"]);
  const exitCode = await run(ctx, createPromptDeps());

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /Unsupported --surface value: web/);
  assert.equal(ctx.stdout.output(), "");
});

test("rejects the presentation surface option outside supported commands", async () => {
  const ctx = createContext(["doctor", "--surface", "desktop"]);
  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  assert.match(
    ctx.stderr.output(),
    /--surface can only be used with --prompt, --target, app-server, or agent-server/,
  );
  assert.equal(ctx.stdout.output(), "");
});

test("passes prompt mode override into runtime config", async () => {
  const ctx = createContext(["--prompt", "hello mode", "--mode", "plan"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.equal(options?.runtimeConfig?.mode, "plan");
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello mode\n");
});

test("passes force MCS into headless runtime config", async () => {
  const ctx = createContext(["--force-mcs", "--prompt", "hello force mcs"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.deepEqual((options?.runtimeConfig as any)?.midConversationSystem, {
        mode: "force",
      });
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello force mcs\n");
});

test("passes --disallowedTools into headless runtime config", async () => {
  const ctx = createContext([
    "--prompt",
    "hello disallowed tools",
    "--disallowedTools",
    "Bash(git *) Edit,web_search",
  ]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.deepEqual(options?.runtimeConfig?.toolDisallowlist, [
        "Bash(git *)",
        "Edit",
        "WebSearch",
      ]);
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello disallowed tools\n");
});

test("supports the prompt short alias with --disallowedTools", async () => {
  const ctx = createContext(["-p", "hello short prompt", "--disallowedTools", "Bash"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.deepEqual(options?.runtimeConfig?.toolDisallowlist, ["Bash"]);
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello short prompt\n");
});

test("supports dashed disallowed tools alias before the prompt option", async () => {
  const ctx = createContext([
    "--disallowed-tools",
    "Bash",
    "Edit",
    "--prompt",
    "hello dashed disallowed tools",
  ]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.deepEqual(options?.runtimeConfig?.toolDisallowlist, ["Bash", "Edit"]);
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello dashed disallowed tools\n");
});

test("passes edit prompt mode override into runtime config", async () => {
  const ctx = createContext(["--prompt", "hello edit mode", "--mode", "edit"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.equal(options?.runtimeConfig?.mode, "edit");
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello edit mode\n");
});

test("passes the CLI cwd into prompt runtime config", async () => {
  const ctx = createContext(["--prompt", "hello cwd"]);
  const cwd = join(tmpdir(), "zcode-cli-cwd-test");
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    cwd: () => cwd,
    createZCodeApp: (options) => {
      assert.equal(options?.runtimeConfig?.workingDirectory, cwd);
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    loadDotenv: (options) => {
      assert.equal(options.cwd, cwd);
      return {
        keys: [],
        loaded: false,
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello cwd\n");
});

test("passes explicit resume session into prompt app creation", async () => {
  const ctx = createContext(["--resume", "sess_existing", "--prompt", "hello resume"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.equal(options?.resume, true);
      assert.equal(options?.sessionId, "sess_existing");
      return {
        sessionId: "sess_existing",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello resume\n");
});

test("resolves latest session for continue prompts", async () => {
  const ctx = createContext(["--continue", "--prompt", "hello continue"]);
  const cwd = join(tmpdir(), "zcode-cli-continue-test");
  let resolved = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    cwd: () => cwd,
    resolveLatestSession: async (options) => {
      resolved = true;
      assert.equal(options.directory, cwd);
      return { id: "sess_latest" } as never;
    },
    createZCodeApp: (options) => {
      assert.equal(options?.resume, true);
      assert.equal(options?.sessionId, "sess_latest");
      return {
        sessionId: "sess_latest",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(resolved, true);
  assert.equal(ctx.stdout.output(), "hello continue\n");
});

test("rejects resume and continue together", async () => {
  const ctx = createContext(["--resume", "sess_existing", "--continue", "--prompt", "hello"]);
  const exitCode = await run(ctx, createPromptDeps());

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /--resume and --continue cannot be used together/);
  assert.equal(ctx.stdout.output(), "");
});

test("rejects unsupported prompt mode", async () => {
  const ctx = createContext(["--prompt", "hello mode", "--mode", "auto"]);
  const exitCode = await run(ctx, createPromptDeps());

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /Unsupported --mode value/);
  assert.equal(ctx.stdout.output(), "");
});

test("prints JSON for prompt command", async () => {
  const ctx = createContext(["--prompt", "hello json", "--json"]);
  const exitCode = await run(ctx, createPromptDeps());
  const payload = JSON.parse(ctx.stdout.output()) as {
    response: string;
    traceId: string;
    eventCount: number;
    projection: { turnCount: number };
  };

  assert.equal(exitCode, 0);
  assert.equal(payload.response, "hello json");
  assert.equal(payload.traceId, "trace-test");
  assert.equal(payload.eventCount, 2);
  assert.equal(payload.projection.turnCount, 1);
});

test("prints provider token usage in prompt JSON", async () => {
  const ctx = createContext(["--prompt", "hello usage", "--json"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () =>
      ({
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async () => ({
          events: [],
          projection: fakeProjection as never,
          response: "done",
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
          usage: {
            source: "provider",
            modelRequestCount: 1,
            inputTokens: 11,
            outputTokens: 3,
            totalTokens: 14,
            cacheReadTokens: 5,
            cacheWriteTokens: 0,
            reasoningTokens: 1,
          },
        }),
      }) as never,
  });
  const payload = JSON.parse(ctx.stdout.output()) as {
    usage: { source: string; totalTokens: number; cacheReadTokens: number };
  };

  assert.equal(exitCode, 0);
  assert.equal(payload.usage.source, "provider");
  assert.equal(payload.usage.totalTokens, 14);
  assert.equal(payload.usage.cacheReadTokens, 5);
});

test("rejects empty prompt text", async () => {
  const ctx = createContext(["--prompt", "   "]);
  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /--prompt requires non-empty text/);
  assert.equal(ctx.stdout.output(), "");
});

test("prints JSON for doctor command", async () => {
  const ctx = createContext(["doctor", "--json"]);
  const originalTitle = process.title;

  try {
    setCliProcessTitle();
    const exitCode = await run(ctx);
    const payload = JSON.parse(ctx.stdout.output()) as {
      cli: { name: string; processName: string };
      packaging: { default: string; sea: string };
      runtime: { node: string; processTitle: string };
    };

    assert.equal(exitCode, 0);
    assert.equal(payload.cli.name, "zcode");
    assert.equal(payload.cli.processName, CLI_PROCESS_NAME);
    assert.equal(payload.runtime.node, process.version);
    assert.equal(payload.runtime.processTitle, CLI_PROCESS_NAME);
    assert.equal(payload.packaging.default, "node-bundle");
    assert.equal(payload.packaging.sea, "optional");
  } finally {
    process.title = originalTitle;
  }
});

test("prints human doctor details with verbose diagnostics", async () => {
  const ctx = createContext(["doctor", "--verbose", "--no-color"]);
  const originalTitle = process.title;

  try {
    setCliProcessTitle();
    const exitCode = await run(ctx);
    const output = ctx.stdout.output();

    assert.equal(exitCode, 0);
    assert.match(output, /zcode doctor/);
    assert.match(output, /process: zcode-cli/);
    assert.match(output, /execPath:/);
    assert.match(output, /cwd:/);
    assert.equal(output.includes("["), false);
  } finally {
    process.title = originalTitle;
  }
});

test("rejects force MCS outside prompt, target, or TUI commands", async () => {
  const ctx = createContext(["doctor", "--force-mcs"]);
  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /--force-mcs can only be used with --prompt, --target, or tui/);
  assert.equal(ctx.stdout.output(), "");
});

test("dispatches app-server stdio command to the ZCode Protocol runner without production dotenv", async () => {
  const ctx = createContext(["app-server", "--stdio"]);
  let called = false;
  let dotenvCalls = 0;
  const exitCode = await run(ctx, {
    cwd: () => "/workspace",
    loadDotenv: () => {
      dotenvCalls += 1;
      return {
        keys: [],
        loaded: false,
      };
    },
    runZCodeProtocolAgent: async (options) => {
      called = true;
      assert.equal(options?.cwd, "/workspace");
      assert.equal(options?.input, ctx.stdin);
      assert.equal(options?.output, ctx.stdout);
      assert.equal(options?.version, "0.0.0");
      assert.equal(options?.presentationSurface, "terminal");
      assert.equal(options?.env?.[ZCODE_RUNTIME_ENV_KEY], "production");
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(called, true);
  assert.equal(dotenvCalls, 0);
  assert.equal(ctx.stderr.output(), "");
});

test("redirects every protocol console level to stderr and restores the global console", () => {
  const originalConsole = globalThis.console;
  const stderr = new PassThrough();
  let stderrOutput = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    stderrOutput += chunk;
  });
  const restore = installStderrConsoleBoundary(stderr);

  try {
    console.debug("protocol debug must not reach stdout");
    console.log("protocol log must not reach stdout");
    console.info("protocol info must not reach stdout");
    console.warn("protocol warning must not reach stdout");
    console.error("protocol error must not reach stdout");

    assert.match(stderrOutput, /protocol debug must not reach stdout/u);
    assert.match(stderrOutput, /protocol log must not reach stdout/u);
    assert.match(stderrOutput, /protocol info must not reach stdout/u);
    assert.match(stderrOutput, /protocol warning must not reach stdout/u);
    assert.match(stderrOutput, /protocol error must not reach stdout/u);
  } finally {
    restore();
    stderr.destroy();
  }

  assert.equal(globalThis.console, originalConsole);
});

test("passes the Desktop presentation surface to the protocol app server", async () => {
  const ctx = createContext(["app-server", "--stdio", "--surface", "desktop"]);
  let called = false;
  const exitCode = await run(ctx, {
    runZCodeProtocolAgent: async (options) => {
      called = true;
      assert.equal(options?.presentationSurface, "zcode_desktop");
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(called, true);
  assert.equal(ctx.stderr.output(), "");
});

test("rejects force MCS before starting the protocol app server", async () => {
  const ctx = createContext(["app-server", "--stdio", "--force-mcs"]);
  let called = false;
  const exitCode = await run(ctx, {
    runZCodeProtocolAgent: async () => {
      called = true;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.match(ctx.stderr.output(), /--force-mcs can only be used with --prompt, --target, or tui/);
  assert.equal(ctx.stdout.output(), "");
});

test("loads dotenv for app-server only in development runtime", async () => {
  const ctx = createContext(["app-server", "--stdio"]);
  let called = false;
  let dotenvCalls = 0;
  const exitCode = await run(ctx, {
    cwd: () => "/workspace",
    env: {
      [ZCODE_RUNTIME_ENV_KEY]: "development",
    },
    loadDotenv: (options) => {
      dotenvCalls += 1;
      assert.equal(options?.cwd, "/workspace");
      if (options?.env) {
        options.env.ZCODE_API_KEY = "loaded-for-dev-protocol";
      }
      return {
        keys: ["ZCODE_API_KEY"],
        loaded: true,
        path: "/workspace/.env",
      };
    },
    runZCodeProtocolAgent: async (options) => {
      called = true;
      assert.equal(options?.cwd, "/workspace");
      assert.equal(options?.env?.[ZCODE_RUNTIME_ENV_KEY], "development");
      assert.equal(options?.env?.ZCODE_API_KEY, "loaded-for-dev-protocol");
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(called, true);
  assert.equal(dotenvCalls, 1);
  assert.equal(ctx.stderr.output(), "");
});

test("rejects the removed acp command", async () => {
  const ctx = createContext(["acp"]);
  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /Unknown command: acp/);
  assert.equal(ctx.stdout.output(), "");
});

test("returns an error for unknown commands", async () => {
  const ctx = createContext(["missing"]);
  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /Unknown command: missing/);
  assert.match(ctx.stderr.output(), /Usage:/);
  assert.equal(ctx.stdout.output(), "");
});

const PLUGINS_TEST_OPTIONS = {
  force: false,
  json: false,
  noColor: false,
  verbose: false,
} as const;

test("plugins uninstall refuses on a non-TTY without --force", async () => {
  const ctx = createContext(["plugins", "uninstall", "hello@market"]);
  let called = false;

  const exitCode = await runPluginsCommand(
    ctx,
    { ...PLUGINS_TEST_OPTIONS },
    {
      cwd: () => process.cwd(),
      uninstallPlugin: async () => {
        called = true;
        return null;
      },
    },
    ["uninstall", "hello@market"],
  );

  assert.equal(called, false);
  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /Refusing to uninstall hello@market without confirmation/);
});

test("plugins uninstall proceeds with --force and reports the removed plugin", async () => {
  const ctx = createContext(["plugins", "uninstall", "hello@market", "--force"]);
  let uninstalledId = "";

  const exitCode = await runPluginsCommand(
    ctx,
    { ...PLUGINS_TEST_OPTIONS, force: true },
    {
      cwd: () => process.cwd(),
      uninstallPlugin: async (options) => {
        uninstalledId = options.pluginId ?? "";
        return {
          id: options.pluginId ?? "",
          name: "hello",
          marketplace: "market",
          enabled: false,
          scope: "user",
        };
      },
    },
    ["uninstall", "hello@market"],
  );

  assert.equal(uninstalledId, "hello@market");
  assert.equal(exitCode, 0);
  assert.match(ctx.stdout.output(), /Uninstalled plugin hello@market/);
});

test("plugins uninstall reports a not-installed plugin as a non-zero no-op", async () => {
  const ctx = createContext(["plugins", "uninstall", "missing@market", "--force"]);

  const exitCode = await runPluginsCommand(
    ctx,
    { ...PLUGINS_TEST_OPTIONS, force: true },
    {
      cwd: () => process.cwd(),
      uninstallPlugin: async () => null,
    },
    ["uninstall", "missing@market"],
  );

  assert.equal(exitCode, 1);
  assert.match(ctx.stdout.output(), /Plugin not installed: missing@market/);
});

test("returns an error for unknown options", async () => {
  const ctx = createContext(["--wat"]);
  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  assert.match(ctx.stderr.output(), /Unknown option/);
  assert.match(ctx.stderr.output(), /Usage:/);
});

test("rejects unsupported Browser Use modes and invalid CLI surfaces", async () => {
  const unsupported = createContext(["--browser-use=extension", "--prompt", "test"]);
  assert.equal(await run(unsupported, createPromptDeps()), 1);
  assert.match(unsupported.stderr.output(), /Unsupported --browser-use value/u);

  const executableOnly = createContext([
    "--browser-executable",
    process.execPath,
    "--prompt",
    "test",
  ]);
  assert.equal(await run(executableOnly, createPromptDeps()), 1);
  assert.match(executableOnly.stderr.output(), /requires --browser-use=headless/u);

  const appServer = createContext(["--browser-use=headless", "app-server", "--stdio"]);
  assert.equal(await run(appServer, createPromptDeps()), 1);
  assert.match(appServer.stderr.output(), /can only be used with --prompt, --target, or tui/u);
});

test("loads the pinned Playwright runtime from a standard Node CLI install", async () => {
  const playwright = await loadCliPlaywrightChromium();

  assert.equal(typeof playwright.chromium.launch, "function");
  assert.match(playwright.chromium.executablePath(), /chromium|chrome/u);
});

test("injects and closes the managed CDP port for headless prompt", async () => {
  const ctx = createContext(["--browser-use=headless", "--prompt", "browser smoke"]);
  const browserControlPort = {} as never;
  let runtimeClosed = 0;
  let appClosed = 0;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createManagedCdpBrowserRuntime: (options) => {
      assert.equal(options?.executablePath, undefined);
      return {
        browserControlPort,
        close: async () => {
          runtimeClosed += 1;
        },
      };
    },
    createZCodeApp: (options) => {
      assert.equal(options?.browserControlPort, browserControlPort);
      return {
        close: async () => {
          appClosed += 1;
        },
        sessionId: "session-browser-headless",
        traceId: "trace-browser-headless",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-browser-headless" as never,
          turnId: "turn-browser-headless" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(appClosed, 1);
  assert.equal(runtimeClosed, 1);
  assert.equal(ctx.stdout.output(), "browser smoke\n");
});

test("continues managed browser cleanup when app close never settles", async () => {
  const ctx = createContext(["--browser-use=headless", "--prompt", "browser shutdown"]);
  let appCloseCount = 0;
  let browserCloseCount = 0;
  const startedAt = Date.now();

  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createManagedCdpBrowserRuntime: () => ({
      browserControlPort: {} as never,
      close: async () => {
        browserCloseCount += 1;
      },
    }),
    createZCodeApp: () =>
      ({
        close: async () => {
          appCloseCount += 1;
          await new Promise<void>(() => undefined);
        },
        runtime: {} as never,
        sessionId: "session-browser-close-timeout",
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-browser-close-timeout" as never,
          turnId: "turn-browser-close-timeout" as never,
        }),
        traceId: "trace-browser-close-timeout",
      }) as never,
    shutdownCleanupTimeoutMs: 20,
  });

  assert.equal(exitCode, 0);
  assert.equal(appCloseCount, 1);
  assert.equal(browserCloseCount, 1);
  assert.ok(Date.now() - startedAt < 200);
});

test("returns from a headless prompt when managed browser close never settles", async () => {
  const ctx = createContext(["--browser-use=headless", "--prompt", "browser shutdown"]);
  let appCloseCount = 0;
  let browserCloseCount = 0;
  const startedAt = Date.now();

  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createManagedCdpBrowserRuntime: () => ({
      browserControlPort: {} as never,
      close: async () => {
        browserCloseCount += 1;
        await new Promise<void>(() => undefined);
      },
    }),
    createZCodeApp: () =>
      ({
        close: async () => {
          appCloseCount += 1;
        },
        runtime: {} as never,
        sessionId: "session-browser-runtime-close-timeout",
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-browser-runtime-close-timeout" as never,
          turnId: "turn-browser-runtime-close-timeout" as never,
        }),
        traceId: "trace-browser-runtime-close-timeout",
      }) as never,
    shutdownCleanupTimeoutMs: 20,
  });

  assert.equal(exitCode, 0);
  assert.equal(appCloseCount, 1);
  assert.equal(browserCloseCount, 1);
  assert.ok(Date.now() - startedAt < 200);
});

test("forces the existing exit code when the CLI watchdog deadline is reached", async () => {
  const exitDeferred = createDeferred<number>();

  scheduleCliExitWatchdog({
    exitCode: 7,
    exitProcess: (code) => exitDeferred.resolve(code),
    timeoutMs: 20,
  });

  assert.equal(await exitDeferred.promise, 7);
});

test("injects one managed CDP runtime into TUI app lifecycle and closes it", async () => {
  const ctx = createContext(["--browser-use=headless", "tui"]);
  const browserControlPort = {} as never;
  let runtimeClosed = 0;
  let appClosed = 0;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createManagedCdpBrowserRuntime: () => ({
      browserControlPort,
      close: async () => {
        runtimeClosed += 1;
      },
    }),
    createZCodeApp: (options) => {
      assert.equal(options?.browserControlPort, browserControlPort);
      return {
        close: async () => {
          appClosed += 1;
        },
        getLocale: () => "en-US",
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        runtime: {} as never,
        sessionId: "session-browser-tui",
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-browser-tui" as never,
          turnId: "turn-browser-tui" as never,
        }),
        traceId: "trace-browser-tui",
      } as never;
    },
    // 真实 TUI 在首帧后通过 loadStartupOptions 创建 App；浏览器运行时随该 App 注入和关闭。
    runTui: async (options) => {
      await loadTuiStartup(options);
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(appClosed, 1);
  assert.equal(runtimeClosed, 1);
});

test("reuses one process provider registry across TUI app replacements", async () => {
  const ctx = createContext(["tui"]);
  const providerRegistry = {} as never;
  const providerRuntimeHeadersPort = {} as never;
  let runtimeStarts = 0;
  let runtimeDisposals = 0;
  let selectionRepositoryDisposals = 0;
  let appCreations = 0;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    skipUserConfig: false,
    userConfigPath: "/tmp/zcode-legacy-tui.json",
    startProcessProviderRegistryRuntime: async (_env, options) => {
      runtimeStarts += 1;
      // 刷新回调是当前 CLI 装配的一部分，仍验证唯一 Runtime 和旧配置迁移路径。
      assert.equal(typeof options?.standalone?.onBuiltinRefreshError, "function");
      assert.equal(typeof options?.standalone?.onBuiltinRefreshResult, "function");
      assert.deepEqual(
        {
          standalone: {
            legacyCliUserConfigFilePath: options?.standalone?.legacyCliUserConfigFilePath,
          },
        },
        {
          standalone: {
            legacyCliUserConfigFilePath: "/tmp/zcode-legacy-tui.json",
          },
        },
      );
      return {
        accountSource: {} as never,
        dispose: () => {
          selectionRepositoryDisposals += 1;
          runtimeDisposals += 1;
        },
        configuredDefaultModelSelection: { providerId: "provider-a", modelId: "model-a" },
        modelSelectionConfigRepository: {
          dispose: () => {
            selectionRepositoryDisposals += 1;
          },
          read: async () => ({ providerId: "provider-a", modelId: "model-a" }),
        },
        providerRuntimeHeadersPort,
        snapshot: {} as never,
        runtime: {
          dispose: () => {
            runtimeDisposals += 1;
          },
          registryService: providerRegistry,
        },
      } as never;
    },
    createZCodeApp: (options) => {
      appCreations += 1;
      assert.equal(options?.providerRegistry, providerRegistry);
      assert.equal(options?.providerRuntimeHeadersPort, providerRuntimeHeadersPort);
      assert.deepEqual(options?.configuredDefaultModelSelection, {
        providerId: "provider-a",
        modelId: "model-a",
      });
      return {
        close: async () => {},
        getLocale: () => "en-US",
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        runtime: {} as never,
        sessionId: `session-registry-tui-${appCreations}`,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-registry-tui" as never,
          turnId: "turn-registry-tui" as never,
        }),
        traceId: "trace-registry-tui",
      } as never;
    },
    runTui: async (options) => {
      await loadTuiStartup(options);
      await options.submitPrompt("/new", {
        abortSignal: new AbortController().signal,
      });
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(appCreations, 2);
  assert.equal(runtimeStarts, 1);
  assert.equal(runtimeDisposals, 1);
  assert.equal(selectionRepositoryDisposals, 1);
});

test("rejects an invalid explicit browser executable before creating the app", async () => {
  const ctx = createContext([
    "--browser-use=headless",
    "--browser-executable",
    "/definitely/missing/zcode-chromium",
    "--prompt",
    "browser smoke",
  ]);
  let appCreated = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: () => {
      appCreated = true;
      throw new Error("app must not be created");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(appCreated, false);
  assert.match(ctx.stderr.output(), /missing or not executable/u);
});

test("rejects tui when stdio is not interactive", async () => {
  const ctx = createContext(["tui"]);
  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  // Locale can come from user config; the invariant is that non-interactive TUI exits.
  assert.match(ctx.stderr.output(), /TUI requires an interactive terminal|TUI 需要交互式终端/);
});

const createRuntimeEvent = (type: string, payload: Record<string, unknown>): never =>
  ({
    id: `event-${type}`,
    payload,
    sequenceNumber: 0,
    sessionId: "session-test",
    timestamp: new Date(),
    traceId: "trace-test",
    type,
  }) as never;

const createPermissionRequest = (): never =>
  ({
    input: { command: "touch demo.txt" },
    mode: "build",
    reason: "Tool has side effects and requires approval",
    requestId: "perm_test",
    requestedAt: new Date(),
    riskLevel: "medium",
    ruleId: "mode.build.sideEffect",
    sessionId: "session-test",
    sideEffectScope: "workspace",
    toolCallId: "tool_bash",
    toolName: "Bash",
    traceId: "trace-test",
    turnId: "turn-test",
  }) as never;

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createTestShutdownProcess(platform: NodeJS.Platform): CliShutdownProcess & {
  emitSignal(signal: NodeJS.Signals): void;
} {
  const listeners = new Map<NodeJS.Signals, Set<() => void>>();
  const target = {
    platform,
    off(signal: NodeJS.Signals, listener: () => void) {
      listeners.get(signal)?.delete(listener);
      return target;
    },
    once(signal: NodeJS.Signals, listener: () => void) {
      const signalListeners = listeners.get(signal) ?? new Set<() => void>();
      signalListeners.add(listener);
      listeners.set(signal, signalListeners);
      return target;
    },
    emitSignal(signal: NodeJS.Signals) {
      const signalListeners = Array.from(listeners.get(signal) ?? []);
      listeners.set(signal, new Set());
      for (const listener of signalListeners) {
        listener();
      }
    },
  };
  return target;
}

test("headless prompt reports exact Workspace Hook pretrust diagnostics without failing the task", async () => {
  const ctx = createContext(["--prompt", "hello"]);
  const deps = createPromptDeps();
  const exitCode = await run(ctx, {
    ...deps,
    createZCodeApp: () =>
      ({
        getModel: () => "openai/gpt-test",
        getLocale: () => "en-US",
        getThoughtLevel: () => "medium",
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async () => ({
          events: [
            {
              type: "hook_run_blocked",
              payload: {
                errorCode: "workspace_hooks_pending_trust",
                descriptor: { sourceKind: "project" },
              },
            },
          ],
          projection: fakeProjection as never,
          response: "ok",
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      }) as never,
    inspectWorkspaceHookTrust: async () => ({
      workspacePath: "/workspace",
      workspaceIdentity: "/workspace",
      bundleDigest: "b".repeat(64),
      reasonCode: "workspace_hooks_pending_trust",
      items: [
        {
          reviewItemId: "item-1",
          event: "SessionStart",
          matcher: null,
          displayCommand: "./start.sh",
          sourcePath: ".zcode/config.json",
          configuredEnabled: true,
          hookDeclarationDigest: "a".repeat(64),
          trustState: "pending_trust",
        },
      ],
    }),
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "ok\n");
  assert.match(ctx.stderr.output(), /Workspace Hooks skipped: workspace_hooks_pending_trust/);
  assert.match(ctx.stderr.output(), new RegExp("a{64}"));
  assert.match(ctx.stderr.output(), /zcode hooks trust review/);
});

test("headless rollout-off diagnostics preserve the runtime feature-disabled reason", async () => {
  const ctx = createContext(["--prompt", "hello"]);
  const deps = createPromptDeps();
  const exitCode = await run(ctx, {
    ...deps,
    createZCodeApp: () =>
      ({
        getModel: () => "openai/gpt-test",
        getLocale: () => "en-US",
        getThoughtLevel: () => "medium",
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async () => ({
          events: [
            {
              type: "hook_run_blocked",
              payload: {
                errorCode: "workspace_hooks_feature_disabled",
                descriptor: { sourceKind: "project" },
              },
            },
          ],
          projection: fakeProjection as never,
          response: "ok",
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      }) as never,
    inspectWorkspaceHookTrust: async () => ({
      workspacePath: "/workspace",
      workspaceIdentity: "/workspace",
      bundleDigest: "b".repeat(64),
      reasonCode: "workspace_hooks_pending_trust",
      items: [],
    }),
  });

  assert.equal(exitCode, 0);
  assert.match(ctx.stderr.output(), /Workspace Hooks skipped: workspace_hooks_feature_disabled/);
});

for (const mode of [undefined, "off", "auto", "local"] as const) {
  test(`passes ToolSearch mode ${mode ?? "default off"} into prompt runtime`, async () => {
    let observed = false;
    const ctx = createContext([...(mode ? ["--toolsearch-mode", mode] : []), "--prompt", "hello"]);
    const deps = createPromptDeps();
    const original = deps.createZCodeApp;
    const code = await run(ctx, {
      ...deps,
      createZCodeApp: (options) => {
        observed = true;
        assert.deepEqual((options?.runtimeConfig as any)?.toolSearch, { mode: mode ?? "off" });
        return original!(options);
      },
    });
    assert.equal(code, 0);
    assert.equal(observed, true);
  });
}

test("rejects invalid ToolSearch mode and removed enable flag before creating an app", async () => {
  for (const args of [
    ["--toolsearch-mode", "force"],
    ["--toolsearch-mode", "typo"],
    ["--enable-toolsearch"],
  ]) {
    let created = false;
    const ctx = createContext([...args, "-p", "hello"]);
    const code = await run(ctx, {
      createZCodeApp: () => {
        created = true;
        throw new Error("unreachable");
      },
    });
    assert.equal(code, 1);
    assert.equal(created, false);
    assert.match(ctx.stderr.output(), /toolsearch/);
  }
});

test("passes explicit Native ToolSearch into TUI runtime config", async () => {
  const ctx = createContext(["tui", "--toolsearch-mode", "native"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.deepEqual((options?.runtimeConfig as any)?.toolSearch, {
        mode: "native",
      });
      return {
        getLocale: () => "en-US",
        getModel: () => "openai/gpt-test",
        getThoughtLevel: () => "medium",
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
    runTui: async () => 0,
  });

  assert.equal(exitCode, 0);
});

test("passes explicit Native ToolSearch into target runtime config", async () => {
  const ctx = createContext(["--toolsearch-mode", "native", "--target", "Ship target MVP"]);
  let continued = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.deepEqual((options?.runtimeConfig as any)?.toolSearch, {
        mode: "native",
      });
      return {
        clearTarget: async () => false,
        continueActiveTarget: async () => {
          continued = true;
          return {
            projection: fakeProjection as never,
            response: "continued target",
            traceId: "trace-target-toolsearch" as never,
            turnId: "turn-target-toolsearch" as never,
          };
        },
        readTarget: async () => null,
        sessionId: "session-target-toolsearch",
        setTarget: async ({ objective, status = "active" }) => ({
          objective,
          sessionID: "session-target-toolsearch",
          status,
          targetID: "target-toolsearch",
          time: { created: 1, updated: 1 },
        }),
        traceId: "trace-target-toolsearch",
        runtime: {} as never,
        submitPrompt: async () => {
          throw new Error("prompt should not run");
        },
        updateTargetStatus: async () => null,
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(continued, true);
  assert.equal(ctx.stdout.output(), "continued target\n");
  assert.equal(ctx.stderr.output(), "");
});

test("passes explicit Native ToolSearch into headless runtime config", async () => {
  const ctx = createContext(["--toolsearch-mode", "native", "--prompt", "hello enable toolsearch"]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.deepEqual((options?.runtimeConfig as any)?.toolSearch, {
        mode: "native",
      });
      return {
        sessionId: "session-test",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello enable toolsearch\n");
});

test("rejects explicit Native ToolSearch outside prompt, target, or TUI commands", async () => {
  const ctx = createContext(["doctor", "--toolsearch-mode", "native"]);
  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  assert.match(
    ctx.stderr.output(),
    /--toolsearch-mode can only be used with --prompt, --target, or tui/,
  );
  assert.equal(ctx.stdout.output(), "");
});

test("rejects explicit Native ToolSearch before starting the protocol app server", async () => {
  const ctx = createContext(["app-server", "--stdio", "--toolsearch-mode", "native"]);
  let called = false;
  const exitCode = await run(ctx, {
    runZCodeProtocolAgent: async () => {
      called = true;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.match(
    ctx.stderr.output(),
    /--toolsearch-mode can only be used with --prompt, --target, or tui/,
  );
  assert.equal(ctx.stdout.output(), "");
});

test("passes explicit Native ToolSearch and explicit resume session into prompt app creation", async () => {
  const ctx = createContext([
    "--toolsearch-mode",
    "native",
    "--resume",
    "sess_existing",
    "--prompt",
    "hello resume",
  ]);
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    createZCodeApp: (options) => {
      assert.equal(options?.resume, true);
      assert.deepEqual((options?.runtimeConfig as any)?.toolSearch, { mode: "native" });
      assert.equal(options?.sessionId, "sess_existing");
      return {
        sessionId: "sess_existing",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "hello resume\n");
});

test("passes explicit Native ToolSearch while resolving latest session for continue prompts", async () => {
  const ctx = createContext([
    "--toolsearch-mode",
    "native",
    "--continue",
    "--prompt",
    "hello continue",
  ]);
  const cwd = join(tmpdir(), "zcode-cli-continue-test");
  let resolved = false;
  const exitCode = await run(ctx, {
    ...createPromptDeps(),
    cwd: () => cwd,
    resolveLatestSession: async (options) => {
      resolved = true;
      assert.equal(options.directory, cwd);
      return { id: "sess_latest" } as never;
    },
    createZCodeApp: (options) => {
      assert.equal(options?.resume, true);
      assert.deepEqual((options?.runtimeConfig as any)?.toolSearch, { mode: "native" });
      assert.equal(options?.sessionId, "sess_latest");
      return {
        sessionId: "sess_latest",
        traceId: "trace-test",
        runtime: {} as never,
        submitPrompt: async (prompt: string) => ({
          events: [],
          projection: fakeProjection as never,
          response: prompt,
          traceId: "trace-test" as never,
          turnId: "turn-test" as never,
        }),
      } as never;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(resolved, true);
  assert.equal(ctx.stdout.output(), "hello continue\n");
});

test("storage-migrate executes only the migration port and emits strict completion JSON", async () => {
  const ctx = createContext(["storage-migrate"]);
  let calls = 0;
  const result = await run(ctx, {
    migrateStorage: async () => {
      calls++;
      return { applied: ["0020"], backupSkipped: true };
    },
    runZCodeProtocolAgent: async () => {
      throw new Error("must not start runtime");
    },
    createZCodeApp: () => {
      throw new Error("must not create session");
    },
  });
  assert.equal(result, 0);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(ctx.stdout.output()), {
    version: 1,
    kind: "storage-migrated",
    applied: ["0020"],
    backupSkipped: true,
  });
});
test("storage-migrate reports failure and rejects extra flags without starting runtime", async () => {
  for (const argv of [["storage-migrate"], ["storage-migrate", "--prompt", "do not run"]]) {
    const ctx = createContext(argv);
    const result = await run(ctx, {
      migrateStorage: async () => {
        throw new Error("checksum mismatch");
      },
    });
    assert.equal(result, 1);
    assert.equal(ctx.stdout.output(), "");
    assert.ok(ctx.stderr.output().length > 0);
  }
});

test("storage-migrate real entrypoint honors an isolated custom database and rejects checksum drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-cli-storage-migration-"));
  const database = join(directory, "custom storage", "sessions.sqlite");
  const cliEntry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
  const invoke = async () => {
    const child = spawn(process.execPath, ["--import", tsxLoader, cliEntry, "storage-migrate"], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        ZCODE_DATA_BASE_DIR: directory,
        ZCODE_SESSION_DB_PATH: database,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const [code] = await once(child, "close");
    return { code, stdout, stderr };
  };
  try {
    const first = await invoke();
    assert.equal(first.code, 0, first.stderr);
    const report = JSON.parse(first.stdout);
    assert.equal(report.kind, "storage-migrated");
    assert.ok(report.applied.includes("0023_session_soft_delete_outcome"));
    const second = await invoke();
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout).applied, []);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(database);
    try {
      assert.equal(db.prepare("SELECT count(*) AS total FROM session").get()?.total, 0);
      db.prepare("UPDATE schema_migration SET checksum='invalid' WHERE id=?").run(
        "0023_session_soft_delete_outcome",
      );
    } finally {
      db.close();
    }
    const failed = await invoke();
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, "");
    assert.match(failed.stderr, /checksum mismatch/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
