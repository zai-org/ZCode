import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeDerivedTrajectories } from "./derive.js";
import {
  createFixtureWorkspace,
  createRuntimeModelConfig,
  loadFixture,
  resolveModelSelection,
  resolveUpstreamBaseURL,
  type PromptTrajectoryAttachment,
  type PromptTrajectoryFixture,
  type PromptTrajectoryStep,
  type RuntimeModelConfig,
} from "./fixture.js";
import { MessageLedger } from "./message-ledger.js";
import { startOpenAiProviderProxy } from "./openai-provider-proxy.js";

const RECORDER_REASONING_LEVEL = "disabled";

interface ZCodeBootstrapModule {
  createZCodeApp(input: unknown): Promise<{
    close?: () => Promise<void>;
    submitPrompt(prompt: RecorderPromptInput): Promise<unknown>;
  }>;
}

type RecorderPromptInput =
  | string
  | {
      attachments?: PromptTrajectoryAttachment[];
      text: string;
    };

interface ConfigConstructor {
  new (input?: unknown): unknown;
}

interface ProviderRegistryConstructor {
  new (providers?: readonly unknown[]): unknown;
}

interface ZCodeProviderModule {
  ApiKeyAccessConfig: ConfigConstructor;
  ModelConfig: ConfigConstructor;
  ModelOptionSpecsConfig: ConfigConstructor;
  ModelPropertiesConfig: ConfigConstructor;
  ProviderApiConfig: ConfigConstructor;
  ProviderConfig: ConfigConstructor;
  ProviderRegistry: ProviderRegistryConstructor;
}

interface RuntimeSessionEvent {
  type?: unknown;
}

interface RuntimeEventObserver {
  sink: {
    onSessionEvent(event: RuntimeSessionEvent): void;
  };
  waitForEvent(input: { count?: number; eventType: string; timeoutMs?: number }): Promise<void>;
}

export async function recordPromptTrajectory(input: {
  fixturePath: string;
  outDir: string;
}): Promise<void> {
  await recordPromptTrajectoryFromFixture({
    fixture: await loadFixture(input.fixturePath),
    outDir: input.outDir,
  });
}

export async function recordPromptTrajectoryFromFixture(input: {
  fixture: PromptTrajectoryFixture;
  outDir: string;
}): Promise<void> {
  await mkdir(input.outDir, { recursive: true });
  const jsonlPath = join(input.outDir, "trajectory.jsonl");
  const fixture = input.fixture;
  const ledger = await MessageLedger.open(jsonlPath);
  let closeProxy: (() => Promise<void>) | undefined;
  let closeApp: (() => Promise<void>) | undefined;

  // 每个 case 用独立的家目录与存储目录：会话库、插件、用户 skill 与 AGENTS.md 都不读写真实用户目录。
  // 修复原因：skill 根目录按 os.homedir() 解析，只改传给 app 的 env 挡不住；
  // 原来录制会把用户自己的 skill、插件写进请求，还会在用户的会话库里留下会话。
  const isolatedHome = await mkdtemp(join(tmpdir(), "zcode-prompt-trajectory-home-"));
  const restoreHome = setIsolatedHome(isolatedHome);

  try {
    const { bootstrap, provider } = await loadZCodeModules();
    const proxy = await startOpenAiProviderProxy({
      ledger,
      mockResponses: fixture.mockResponses,
      upstreamBaseURL: resolveUpstreamBaseURL({ fixture }),
    });
    closeProxy = proxy.close;
    const modelConfig = createRuntimeModelConfig({
      env: process.env,
      fixture,
      proxyBaseURL: proxy.baseURL,
    });
    const workspace = await createFixtureWorkspace(fixture);
    const modelSelection = {
      ...resolveModelSelection(fixture),
      options: { reasoningLevel: RECORDER_REASONING_LEVEL },
    };
    const eventObserver = createRuntimeEventObserver();
    const providerRegistry = createRecorderProviderRegistry(provider, modelConfig, fixture);
    const app = await bootstrap.createZCodeApp({
      eventSink: eventObserver.sink,
      env: process.env,
      providerRegistry,
      runtimeConfig: buildRecorderRuntimeConfig({
        fixture,
        modelSelection,
        workingDirectory: workspace,
      }),
      skipUserConfig: true,
    });
    closeApp = async () => {
      await app.close?.();
    };

    await executeFixtureSteps({ app, eventObserver, steps: fixture.steps });
  } finally {
    await closeApp?.();
    await closeProxy?.();
    await ledger.close();
    restoreHome();
  }

  await writeDerivedTrajectories({
    inputPath: jsonlPath,
    outDir: input.outDir,
  });
}

const HOME_ENV_KEYS = ["HOME", "USERPROFILE"] as const;

/** 进程内切换家目录与存储目录，返回恢复函数；录制按 case 顺序执行，不并发。 */
function setIsolatedHome(home: string): () => void {
  const keys = [...HOME_ENV_KEYS, "ZCODE_STORAGE_DIR"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of HOME_ENV_KEYS) process.env[key] = home;
  process.env.ZCODE_STORAGE_DIR = join(home, ".zcode");
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export async function executeFixtureSteps(input: {
  app: {
    submitPrompt(prompt: RecorderPromptInput): Promise<unknown>;
  };
  eventObserver: RuntimeEventObserver;
  steps: readonly PromptTrajectoryStep[];
}): Promise<void> {
  for (const step of input.steps) {
    if (step.type === "submitPrompt") {
      await input.app.submitPrompt(
        step.attachments?.length ? { attachments: step.attachments, text: step.text } : step.text,
      );
      continue;
    }
    if (step.type === "waitForEvent") {
      await input.eventObserver.waitForEvent({
        count: step.count,
        eventType: step.eventType,
        timeoutMs: step.timeoutMs,
      });
      continue;
    }
    assertNever(step);
  }
}

function createRuntimeEventObserver(): RuntimeEventObserver {
  const events: RuntimeSessionEvent[] = [];
  const waiters = new Set<{
    count: number;
    eventType: string;
    resolve(): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const matchingCount = (eventType: string): number =>
    events.filter((event) => event.type === eventType).length;

  const settleReadyWaiters = (): void => {
    for (const waiter of waiters) {
      if (matchingCount(waiter.eventType) < waiter.count) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve();
    }
  };

  return {
    sink: {
      onSessionEvent(event) {
        events.push(event);
        settleReadyWaiters();
      },
    },
    waitForEvent(input) {
      const count = input.count ?? 1;
      if (matchingCount(input.eventType) >= count) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        const timeoutMs = input.timeoutMs ?? 10_000;
        const waiter = {
          count,
          eventType: input.eventType,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(
              new Error(
                `Timed out waiting for ${count} ${input.eventType} event(s) after ${timeoutMs}ms.`,
              ),
            );
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported fixture step: ${JSON.stringify(value)}`);
}

async function loadZCodeModules(): Promise<{
  bootstrap: ZCodeBootstrapModule;
  provider: ZCodeProviderModule;
}> {
  const bootstrapPath = pathToFileURL(
    join(import.meta.dirname, "../../../packages/bootstrap/dist/index.js"),
  ).href;
  // @zcode/provider 只发布 src 入口，bootstrap dist 运行时也加载这份 src。
  // 修复原因：读旧的 provider dist 会得到另一份配置类，Registry 的 instanceof 校验对不上。
  const providerPath = pathToFileURL(
    join(import.meta.dirname, "../../../../../packages/provider/src/index.ts"),
  ).href;
  try {
    const [bootstrap, provider] = await Promise.all([
      import(bootstrapPath) as Promise<ZCodeBootstrapModule>,
      import(providerPath) as Promise<ZCodeProviderModule>,
    ]);
    return { bootstrap, provider };
  } catch (error) {
    throw new Error(
      "Missing built zcode-cli packages. Run `pnpm --filter @zcode/bootstrap^... build && pnpm --filter @zcode/bootstrap build` before `record`.",
      { cause: error },
    );
  }
}

function createRecorderProviderRegistry(
  provider: ZCodeProviderModule,
  modelConfig: RuntimeModelConfig,
  fixture: PromptTrajectoryFixture,
): unknown {
  const target = modelConfig.main;
  if (!target.baseURL) {
    throw new Error("Prompt trajectory Provider is missing baseURL");
  }
  const apiFormat =
    target.kind === "anthropic"
      ? "anthropic-messages"
      : target.kind === "openai"
        ? "openai-responses"
        : "openai-chat-completions";
  const providerConfig = new provider.ProviderConfig({
    access: new provider.ApiKeyAccessConfig({
      apiKey: target.apiKey ?? "prompt-trajectory-key",
    }),
    api: new provider.ProviderApiConfig({
      type: apiFormat,
      baseUrl: target.baseURL,
      headers: target.headers,
    }),
    builtinModelIds: [target.model],
    personalModelIds: [],
    enabled: true,
    visibility: "visible",
  });
  const registryModelConfig = new provider.ModelConfig({
    properties: new provider.ModelPropertiesConfig({
      contextWindow: 1_000_000,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: false,
        supportsPdf: true,
        ...fixture.modelInputFormat,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
      // 修复原因：能力只来自 Registry 模型声明；原来改写连接 baseURL/providerKind 的包装
      // 依赖已删除的 resolveConnection，从未生效，WebSearch 用例因此看不到 WebSearch。
      ...fixture.modelProperties,
    }),
    // Registry 要求每个 Selection 都带推理档位；不支持推理的模型只声明 disabled 一档。
    optionSpecs: new provider.ModelOptionSpecsConfig({
      reasoningLevel: { values: [RECORDER_REASONING_LEVEL], map: "{}" },
      // 选项映射为必填；空映射表示不把该选项写进请求体。
      maxOutputTokens: { max: 1_000_000, map: "{}" },
    }),
  });
  return new provider.ProviderRegistry([
    {
      providerId: target.provider,
      config: providerConfig,
      models: [{ modelId: target.model, config: registryModelConfig }],
    },
  ]);
}

export function buildRecorderRuntimeConfig(input: {
  fixture: PromptTrajectoryFixture;
  modelSelection: unknown;
  workingDirectory: string;
}): Record<string, unknown> {
  const fixtureRuntimeConfig = input.fixture.runtimeConfig;

  return {
    ...fixtureRuntimeConfig,
    compact: fixtureRuntimeConfig?.compact,
    mcp: { enabled: false },
    memory: { enabled: false },
    mode: fixtureRuntimeConfig?.mode ?? "yolo",
    modelSelection: input.modelSelection,
    modelStreaming: fixtureRuntimeConfig?.modelStreaming ?? "on",
    outputStyle: fixtureRuntimeConfig?.outputStyle,
    subagents: fixtureRuntimeConfig?.subagents ?? { enabled: false },
    titleGeneration: { enabled: false },
    workingDirectory: input.workingDirectory,
  };
}
