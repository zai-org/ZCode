import { describe, expect, it } from "vitest";
import { createConfig } from "@zcode/adapters/config";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID, ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared";
import { ProviderRegistry } from "@zcode/provider";
import {
  resolveAppRuntimeConfig as resolveProductionAppRuntimeConfig,
  runtimeConfigLogContext,
} from "../src/app/runtime-config.js";

const workingDirectory = "/workspace/app";
const testModelSelection = {
  providerId: "test-provider",
  modelId: "test-model",
} as const;

function resolveAppRuntimeConfig(input: Parameters<typeof resolveProductionAppRuntimeConfig>[0]) {
  return resolveProductionAppRuntimeConfig({
    ...input,
    options: {
      ...input.options,
      runtimeConfig: {
        modelSelection: testModelSelection,
        ...input.options.runtimeConfig,
      },
    },
  });
}

function createConfigResult() {
  return createConfig({
    cliOverrides: {
      model: {
        main: {
          provider: "provider:test",
          model: "glm-0531",
          kind: "anthropic",
          baseURL: "http://old.example.test/v1",
        },
        lite: {
          provider: "provider:test",
          model: "glm-0531-lite",
          kind: "anthropic",
          baseURL: "http://old.example.test/v1",
        },
      },
    },
    env: {},
    skipUserConfig: true,
    workingDirectory,
  });
}

function createMainOnlyConfigResult() {
  return createConfig({
    cliOverrides: {
      model: {
        main: {
          provider: "provider:test",
          model: "glm-0531",
          kind: "anthropic",
          baseURL: "http://old.example.test/v1",
        },
      },
    },
    env: {},
    skipUserConfig: true,
    workingDirectory,
  });
}

describe("resolveAppRuntimeConfig", () => {
  it.each([undefined, [], ["/workspace/backend", "C:\\work\\shared folder"]])(
    "passes the current additional directories into runtime context: %j",
    (additionalDirectories) => {
      const resolved = resolveAppRuntimeConfig({
        cliStorageRoot: "/tmp/zcode-cli",
        configResult: createConfigResult(),
        options: { additionalDirectories },
        subagentOutputRootDir: "/tmp/zcode-cli/agents",
        workingDirectory,
      });

      expect(resolved.runtimeConfig.additionalDirectories).toEqual(additionalDirectories);
      expect(resolved.runtimeConfig.workingDirectory).toBe(workingDirectory);
    },
  );

  it.each([
    {
      env: {},
      expected: { defaultTimeoutMs: 120_000, maxTimeoutMs: 600_000 },
      name: "defaults",
    },
    {
      env: { BASH_DEFAULT_TIMEOUT_MS: "250", BASH_MAX_TIMEOUT_MS: "900" },
      expected: { defaultTimeoutMs: 250, maxTimeoutMs: 900 },
      name: "valid overrides",
    },
    {
      env: { BASH_DEFAULT_TIMEOUT_MS: "invalid", BASH_MAX_TIMEOUT_MS: "0" },
      expected: { defaultTimeoutMs: 120_000, maxTimeoutMs: 600_000 },
      name: "invalid overrides",
    },
    {
      env: { BASH_DEFAULT_TIMEOUT_MS: "500000", BASH_MAX_TIMEOUT_MS: "300000" },
      expected: { defaultTimeoutMs: 500_000, maxTimeoutMs: 500_000 },
      name: "max below default below built-in max",
    },
    {
      env: { BASH_DEFAULT_TIMEOUT_MS: "900000", BASH_MAX_TIMEOUT_MS: "300000" },
      expected: { defaultTimeoutMs: 900_000, maxTimeoutMs: 900_000 },
      name: "max below default",
    },
    {
      env: { BASH_DEFAULT_TIMEOUT_MS: "700000", BASH_MAX_TIMEOUT_MS: "nope" },
      expected: { defaultTimeoutMs: 700_000, maxTimeoutMs: 700_000 },
      name: "invalid max above built-in default",
    },
    {
      env: { BASH_DEFAULT_TIMEOUT_MS: "250ms", BASH_MAX_TIMEOUT_MS: "900ms" },
      expected: { defaultTimeoutMs: 250, maxTimeoutMs: 900 },
      name: "leading decimal digits with unit suffixes",
    },
  ])("injects the Bash timeout policy from $name env", ({ env, expected }) => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: { env },
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
      workingDirectory,
    });

    expect(resolved.runtimeConfig.bashTimeoutPolicy).toEqual(expected);
  });

  it("preserves an explicitly injected Bash timeout policy", () => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: {
        env: { BASH_DEFAULT_TIMEOUT_MS: "250" },
        runtimeConfig: {
          bashTimeoutPolicy: { defaultTimeoutMs: 10, maxTimeoutMs: 20 },
        },
      },
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
      workingDirectory,
    });

    expect(resolved.runtimeConfig.bashTimeoutPolicy).toEqual({
      defaultTimeoutMs: 10,
      maxTimeoutMs: 20,
    });
  });

  it("projects canonical memory inputs and supported switches", () => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfig({
        cliOverrides: {
          features: { memory: false },
          memory: {
            use: false,
          },
          model: {
            main: {
              provider: "provider:test",
              model: "glm-0531",
              kind: "anthropic",
              baseURL: "http://old.example.test/v1",
            },
          },
        },
        env: {},
        skipUserConfig: true,
        workingDirectory,
      }),
      options: {},
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
      workingDirectory,
      workspaceIdentity: "  ssh:example:/workspace/app  ",
    });

    expect(resolved.runtimeConfig.memory).toEqual({
      cliStorageRoot: "/tmp/zcode-cli",
      enabled: false,
      use: false,
      workspaceIdentity: "ssh:example:/workspace/app",
    });
  });

  it("defaults the runtime memory switches to enabled", () => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: {},
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
      workingDirectory,
    });

    expect(resolved.runtimeConfig.memory).toEqual({
      cliStorageRoot: "/tmp/zcode-cli",
      enabled: true,
      use: true,
      workspaceIdentity: undefined,
    });
    expect(runtimeConfigLogContext(resolved.runtimeConfig, workingDirectory)).toMatchObject({
      memoryExtractionEnabled: true,
    });
  });

  it.each([
    { value: "abc", expected: undefined },
    { value: "0", expected: undefined },
    { value: "60000ms", expected: undefined },
    { value: "1", expected: 10_000 },
    { value: "60000", expected: 60_000 },
    // 超过 setTimeout 上限的大值照样生效（相当于很久才提醒）：停滞钟分段等待，不会忙循环。
    { value: "3000000000", expected: 3_000_000_000 },
  ])(
    "reads ZCODE_SUBAGENT_STALL_NOTIFY_MS=$value as a stall threshold of $expected ms",
    ({ value, expected }) => {
      // 非法值不覆盖（core 用默认 15 分钟）；低于 10 秒按 10 秒，避免每秒唤起父会话（!3563 评审 SG-03）。
      const resolved = resolveAppRuntimeConfig({
        cliStorageRoot: "/tmp/zcode-cli",
        configResult: createConfigResult(),
        options: { env: { ZCODE_SUBAGENT_STALL_NOTIFY_MS: value } },
        subagentOutputRootDir: "/tmp/zcode-cli/agents",
        subagentProfiles: [],
        workingDirectory,
      });
      expect(resolved.runtimeConfig.subagents?.backgroundStallNotifyMs).toBe(expected);
      const logContext = runtimeConfigLogContext(resolved.runtimeConfig, workingDirectory);
      if (expected === undefined) expect(logContext).not.toHaveProperty("subagentStallNotifyMs");
      else expect(logContext).toMatchObject({ subagentStallNotifyMs: expected });
    },
  );

  it("lets an explicit runtimeConfig stall threshold win over ZCODE_SUBAGENT_STALL_NOTIFY_MS", () => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: {
        env: { ZCODE_SUBAGENT_STALL_NOTIFY_MS: "60000" },
        runtimeConfig: { subagents: { backgroundStallNotifyMs: 30 } },
      },
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
      workingDirectory,
    });
    expect(resolved.runtimeConfig.subagents?.backgroundStallNotifyMs).toBe(30);
  });

  it("preserves an explicit disabled memory Extraction gate and logs it", () => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: {
        runtimeConfig: {
          memory: { extractionEnabled: false },
        },
      },
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
      workingDirectory,
    });

    expect(resolved.runtimeConfig.memory?.extractionEnabled).toBe(false);
    expect(runtimeConfigLogContext(resolved.runtimeConfig, workingDirectory)).toMatchObject({
      memoryEnabled: true,
      memoryExtractionEnabled: false,
      memoryUse: true,
    });
  });

  it("passes the initial Session Selection without recreating ModelSelection state", () => {
    const sessionModelSelection = {
      providerId: "deepseek-custom",
      modelId: "deepseek-v4-pro",
      options: { reasoningLevel: "high" },
    };
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createMainOnlyConfigResult(),
      options: {
        runtimeConfig: {
          modelSelection: sessionModelSelection,
          workingDirectory,
        },
      },
      workingDirectory,
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
    });

    expect(resolved.runtimeConfig.modelSelection).toEqual(sessionModelSelection);
  });

  it("进程 Registry 模式不从通用 RuntimeConfig 补全未知模型", () => {
    const configResult = createMainOnlyConfigResult();
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult,
      options: {
        providerRegistry: new ProviderRegistry([]),
        runtimeConfig: {
          modelSelection: {
            providerId: "legacy-provider",
            modelId: "legacy-model",
          },
          workingDirectory,
        },
      },
      workingDirectory,
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
    });

    expect(resolved.runtimeConfig.contextWindow).toBeUndefined();
    expect(resolved.runtimeConfig.maxOutputTokens).toBeUndefined();
  });

  it("keeps default title generation bound to the current runtime model", () => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: {
        runtimeConfig: {
          titleGeneration: {},
          workingDirectory,
        },
      },
      workingDirectory,
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
    });

    expect(resolved.runtimeConfig.titleGeneration).toEqual({ timeoutMs: 60_000 });
  });

  it("preserves an explicit title generation timeout override", () => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: {
        runtimeConfig: {
          titleGeneration: {
            timeoutMs: 30_000,
          },
          workingDirectory,
        },
      },
      workingDirectory,
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
    });

    expect(resolved.runtimeConfig.titleGeneration?.timeoutMs).toBe(30_000);
  });

  it("projects explicit session tool filters into the runtime tool surface", () => {
    // Explicit filters come from ZCode Protocol session/create or the headless CLI
    // flags; they are the only inputs that shape the provider-visible tool surface.
    const configResult = createConfig({
      cliOverrides: {
        model: {
          main: {
            provider: "provider:test",
            model: "glm-0531",
            kind: "anthropic",
            baseURL: "http://old.example.test/v1",
          },
        },
      },
      env: {},
      skipUserConfig: true,
      workingDirectory,
    });

    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult,
      options: {
        runtimeConfig: {
          toolAllowlist: ["mcp__zcode-cua__open_application"],
          toolDisallowlist: ["TodoWrite"],
          workingDirectory,
        },
      },
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
      workingDirectory,
    });

    expect(resolved.runtimeConfig.toolAllowlist).toEqual(["mcp__zcode-cua__open_application"]);
    expect(resolved.runtimeConfig.toolDisallowlist).toEqual(["TodoWrite"]);
  });

  it("does not project config permission.allowedTools into the runtime tool surface", () => {
    // permission.allowedTools/disallowedTools keep their original semantics
    // (auto-approve / execution-time deny). Projecting them into tool
    // registration would silently hide every other tool for existing configs.
    const configResult = createConfig({
      cliOverrides: {
        model: {
          main: {
            provider: "provider:test",
            model: "glm-0531",
            kind: "anthropic",
            baseURL: "http://old.example.test/v1",
          },
        },
        permission: {
          allowedTools: ["WebSearch"],
          disallowedTools: ["TodoWrite"],
        },
      },
      env: {},
      skipUserConfig: true,
      workingDirectory,
    });

    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult,
      options: {
        runtimeConfig: {
          workingDirectory,
        },
      },
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
      workingDirectory,
    });

    expect(resolved.runtimeConfig.toolAllowlist).toBeUndefined();
    expect(resolved.runtimeConfig.toolDisallowlist).toBeUndefined();
  });

  it("preserves an explicit title generation model override", () => {
    const titleModelSelection = {
      providerId: "builtin:title-provider",
      modelId: "title-model",
      options: { reasoningLevel: "high" },
    };
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: {
        runtimeConfig: {
          titleGeneration: {
            modelSelection: titleModelSelection,
          },
          workingDirectory,
        },
      },
      workingDirectory,
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
    });

    expect(resolved.runtimeConfig.titleGeneration?.modelSelection).toEqual(titleModelSelection);
  });

  it("configures the explicit internal embedded search compatibility backend", () => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: {
        env: {
          ZCODE_EMBEDDED_SEARCH_COMMAND: "/tmp/zcode-test",
        },
      },
      workingDirectory,
    });

    expect(resolved.runtimeConfig.embeddedSearchBackend).toEqual({
      kind: "internal-cli",
      command: "/tmp/zcode-test",
      args: ["__internal-search"],
    });
  });

  it("preserves an explicit embedded search backend override", () => {
    const backend = {
      kind: "argv0-dispatch" as const,
      command: "/tmp/zcode-argv0",
    };
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: {
        runtimeConfig: {
          embeddedSearchBackend: backend,
          workingDirectory,
        },
      },
      workingDirectory,
    });

    expect(resolved.runtimeConfig.embeddedSearchBackend).toBe(backend);
  });

  it("enables runtime hooks when enabled plugins provide hooks", () => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: {},
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
      pluginHooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              {
                type: "command",
                command: "echo hook",
                plugin: {
                  dataPath: "/tmp/plugin-data",
                  id: "superpowers@zcode-plugins-official",
                  name: "superpowers",
                  rootPath: "/tmp/superpowers",
                },
              },
            ],
          },
        ],
      },
      workingDirectory,
    });

    expect(resolved.runtimeConfig.hooks?.enabled).toBe(true);
    expect(resolved.runtimeConfig.hooks?.events.SessionStart?.[0]?.hooks[0]).toMatchObject({
      command: "echo hook",
      type: "command",
    });
  });

  it("merges plugin MCP servers when protocol provides user MCP overrides", () => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: {
        runtimeConfig: {
          mcp: {
            enabled: true,
            servers: {
              context7: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@upstash/context7-mcp"],
              },
            },
          },
          workingDirectory,
        },
      },
      pluginMcpServers: {
        "plugin:chrome-devtools-mcp:chrome-devtools": {
          type: "stdio",
          command: "npx",
          args: ["-y", "chrome-devtools-mcp@latest"],
        },
      },
      subagentOutputRootDir: "/tmp/zcode-cli/agents-output",
      subagentProfiles: [],
      workingDirectory,
    });

    expect(resolved.configuredMcpServers).toEqual({
      "plugin:chrome-devtools-mcp:chrome-devtools": {
        type: "stdio",
        command: "npx",
        args: ["-y", "chrome-devtools-mcp@latest"],
      },
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    });
    expect(resolved.runtimeConfig.mcp?.servers).toEqual(resolved.configuredMcpServers);
  });

  it("keeps official CUA provenance only while the bundled plugin config is unmodified", () => {
    const name = "plugin:computer-use:computer-use";
    const officialPluginConfig = {
      type: "stdio" as const,
      command: "/Applications/ZCode Computer Use.app/Contents/MacOS/server",
      env: { [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID },
    };
    const baseInput = {
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      pluginMcpServers: { [name]: officialPluginConfig },
      subagentOutputRootDir: "/tmp/zcode-cli/agents-output",
      subagentProfiles: [],
      workingDirectory,
    };

    const official = resolveAppRuntimeConfig({
      ...baseInput,
      options: { runtimeConfig: { mcp: { enabled: true } }, workingDirectory },
    });
    expect(official.runtimeConfig.mcp?.trustedOfficialCuaServerNames).toEqual([name]);

    const projectSpoof = resolveAppRuntimeConfig({
      ...baseInput,
      options: {
        runtimeConfig: {
          mcp: {
            enabled: true,
            servers: {
              [name]: {
                type: "stdio",
                command: "/tmp/attacker-command",
                env: { [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID },
              },
            },
          },
          workingDirectory,
        },
      },
    });
    expect(projectSpoof.runtimeConfig.mcp?.trustedOfficialCuaServerNames).toEqual([]);
    expect(projectSpoof.configuredMcpServers[name]).toMatchObject({
      command: "/tmp/attacker-command",
    });
  });

  it("keeps the host node_repl identity reserved from user MCP overrides", () => {
    const builtInNodeRepl = {
      type: "stdio" as const,
      command: process.execPath,
      args: ["/runtime/node-repl.js"],
    };
    const resolved = resolveAppRuntimeConfig({
      builtInMcpServers: { node_repl: builtInNodeRepl },
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: {
        runtimeConfig: {
          mcp: {
            enabled: true,
            servers: {
              node_repl: { type: "stdio", command: "malicious-node-repl" },
            },
          },
          workingDirectory,
        },
      },
      subagentOutputRootDir: "/tmp/zcode-cli/agents-output",
      workingDirectory,
    });

    expect(resolved.configuredMcpServers.node_repl).toEqual(builtInNodeRepl);
  });

  it("injects CUA bridge credentials without granting node_repl official-frame authority", () => {
    const resolved = resolveAppRuntimeConfig({
      builtInMcpServers: {
        node_repl: { type: "stdio", command: process.execPath, args: ["/runtime/node-repl.js"] },
      },
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: { runtimeConfig: { mcp: { enabled: true } }, workingDirectory },
      pluginRuntimeFeatures: { computerUse: true },
      subagentOutputRootDir: "/tmp/zcode-cli/agents-output",
      workingDirectory,
    });

    // node_repl 仍可被 bridge 注入，但不能把通用 JS server 标成 official CUA server。
    expect(resolved.runtimeConfig.mcp?.trustedOfficialCuaServerNames).toEqual([]);
  });

  it("merges loaded subagent profiles into runtime config", () => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      options: {
        runtimeConfig: {
          subagents: {
            profiles: [
              {
                name: "inline-agent",
                description: "内联 agent",
                source: "project",
                systemPrompt: "内联 prompt",
              },
            ],
          },
        },
      },
      subagentOutputRootDir: "/tmp/zcode-cli/agents-output",
      subagentProfiles: [
        {
          name: "loaded-agent",
          description: "加载 agent",
          source: "user",
          systemPrompt: "加载 prompt",
        },
      ],
      workingDirectory,
    });

    expect(resolved.runtimeConfig.subagents?.outputRootDir).toBe("/tmp/zcode-cli/agents-output");
    expect(resolved.runtimeConfig.subagents?.profiles?.map((profile) => profile.name)).toEqual([
      "inline-agent",
      "loaded-agent",
    ]);
  });

  it("merges built-in subagent model overrides with explicit runtime config taking precedence", () => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createConfigResult(),
      builtInSubagentModelSelectionOverrides: {
        Explore: {
          providerId: "custom-openai",
          modelId: "glm-5.2",
          options: { reasoningLevel: "max" },
        },
        "general-purpose": {
          providerId: "custom-openai",
          modelId: "gpt-5.4",
          options: { reasoningLevel: "high" },
        },
      },
      options: {
        runtimeConfig: {
          subagents: {
            builtInModelSelectionOverrides: {
              Explore: { providerId: "custom-openai", modelId: "explicit-explore" },
            },
          },
        },
      },
      subagentOutputRootDir: "/tmp/zcode-cli/agents-output",
      subagentProfiles: [],
      workingDirectory,
    });

    expect(resolved.runtimeConfig.subagents?.builtInModelSelectionOverrides).toEqual({
      Explore: { providerId: "custom-openai", modelId: "explicit-explore" },
      "general-purpose": {
        providerId: "custom-openai",
        modelId: "gpt-5.4",
        options: { reasoningLevel: "high" },
      },
    });
  });
});

// 灰度门（docs/dynamic-workflow/launch.md「Gray release」）由协议服务端写进 create-app
// 的 options.runtimeConfig；本函数必须原样透传，不得补默认值也不得被后面的显式键覆盖。
describe("resolveAppRuntimeConfig：dynamicWorkflowEnabled 透传", () => {
  it.each([
    { input: { dynamicWorkflowEnabled: false }, expected: false },
    { input: { dynamicWorkflowEnabled: true }, expected: true },
    // 未参与灰度的调用方（TUI / headless）不写该字段，装配层也不能替它决定。
    { input: {}, expected: undefined },
  ])("%j", ({ input, expected }) => {
    const { runtimeConfig } = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli-storage",
      configResult: createConfigResult(),
      options: { runtimeConfig: input },
      subagentOutputRootDir: "/tmp/zcode-subagent-output",
      workingDirectory,
    });
    expect(runtimeConfig.dynamicWorkflowEnabled).toBe(expected);
  });

  // launch.md「On demand: activation」：按需标志同样原样透传，装配层不替调用方决定。
  it.each([
    { input: { dynamicWorkflowToolsOnDemand: true }, expected: true },
    { input: { dynamicWorkflowToolsOnDemand: false }, expected: false },
    { input: {}, expected: undefined },
  ])("dynamicWorkflowToolsOnDemand %j", ({ input, expected }) => {
    const { runtimeConfig } = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli-storage",
      configResult: createConfigResult(),
      options: { runtimeConfig: input },
      subagentOutputRootDir: "/tmp/zcode-subagent-output",
      workingDirectory,
    });
    expect(runtimeConfig.dynamicWorkflowToolsOnDemand).toBe(expected);
  });
});
