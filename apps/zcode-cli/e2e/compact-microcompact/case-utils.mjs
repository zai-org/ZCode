import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_PROVIDER,
  FAKE_PROVIDER,
  FULL_COMPACT_BUFFER_TOKENS,
  FULL_COMPACT_CONTEXT_WINDOW,
  MAX_TURNS,
} from "./constants.mjs";

const MICROCOMPACT_PLACEHOLDER = "[Old tool result content cleared]";
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const OUTPUT_TOKEN_FIELDS = {
  "anthropic-messages": "max_tokens",
  "openai-chat-completions": "max_tokens",
  "openai-responses": "max_output_tokens",
};

export async function loadZCodeModules(repoRoot) {
  try {
    const [bootstrap, contracts, providerConfig, providerRegistry] = await Promise.all([
      import(pathToFileURL(join(repoRoot, "packages", "bootstrap", "dist", "index.js")).href),
      import(pathToFileURL(join(repoRoot, "packages", "contracts", "dist", "index.js")).href),
      import(
        pathToFileURL(
          join(repoRoot, "..", "..", "packages", "provider", "dist", "config", "index.js"),
        ).href
      ),
      import(
        pathToFileURL(join(repoRoot, "..", "..", "packages", "provider", "dist", "registry.js"))
          .href
      ),
    ]);
    return {
      CompactPhase: contracts.CompactPhase,
      CompactReason: contracts.CompactReason,
      CompactTrigger: contracts.CompactTrigger,
      SessionEventType: contracts.SessionEventType,
      createZCodeApp: bootstrap.createZCodeApp,
      provider: { ...providerConfig, ...providerRegistry },
    };
  } catch (error) {
    throw new Error("Unable to load built ZCode packages. Run `pnpm build` before this E2E.", {
      cause: error,
    });
  }
}

export function buildRuntimeConfig(input) {
  return {
    compact: {
      bufferTokens: input.compact?.bufferTokens ?? FULL_COMPACT_BUFFER_TOKENS,
      contextWindow: input.compact?.contextWindow ?? FULL_COMPACT_CONTEXT_WINDOW,
      enabled: input.compact?.enabled,
      maxConsecutiveFailures: input.compact?.maxConsecutiveFailures,
      microcompact: input.compact?.microcompact,
      summaryReserveTokens: input.compact?.summaryReserveTokens ?? 0,
      thresholdPercentOverride: input.compact?.thresholdPercentOverride,
    },
    maxTurns: input.maxTurns ?? MAX_TURNS,
    ...(input.modelContextBudgetStrategy
      ? { modelContextBudgetStrategy: input.modelContextBudgetStrategy }
      : {}),
    mcp: { enabled: false, servers: {} },
    memory: {
      enabled: false,
      use: false,
    },
    mode: "yolo",
    streamingToolExecution: "off",
    workingDirectory: input.workspace,
  };
}

export async function writeProviderConfig(configPath, input) {
  const providerId = input.providerId ?? DEFAULT_PROVIDER;
  const config = {
    permission: {
      allowedTools: ["Bash", "Read", "Write", "Edit", "ApplyPatch"],
      mode: "yolo",
    },
    storage: {
      dir: input.storageDir,
    },
    features: {
      mcp: false,
      memory: false,
      skill: false,
    },
    logging: {
      level: "warn",
    },
  };

  const providerFixture = {
    apiFormat:
      input.kind === "anthropic"
        ? "anthropic-messages"
        : input.kind === "openai"
          ? "openai-responses"
          : "openai-chat-completions",
    apiKey: input.apiKey ?? "compact-e2e-key",
    baseURL: input.baseURL,
    contextWindow: input.contextWindow ?? FULL_COMPACT_CONTEXT_WINDOW,
    maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    modelId: input.model,
    providerId,
  };
  await Promise.all([
    writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`),
    writeFile(`${configPath}.provider.json`, `${JSON.stringify(providerFixture, null, 2)}\n`),
  ]);
}

export async function createApp(input) {
  const providerConfig = JSON.parse(await readFile(`${input.configPath}.provider.json`, "utf8"));
  return input.modules.createZCodeApp({
    env: {
      ...process.env,
      ZCODE_STORAGE_DIR: input.storageDir,
      // 会话库默认在用户目录；需要检查或改写库内容的 case 用它指到本 case 的临时目录。
      ...(input.sessionDbPath ? { ZCODE_SESSION_DB_PATH: input.sessionDbPath } : {}),
    },
    runtimeConfig: input.runtimeConfig,
    // 重构后旧字符串解析入口已删除；新 session 使用完整选择，冷恢复仍由持久选择接管。
    configuredDefaultModelSelection: {
      providerId: providerConfig.providerId,
      modelId: providerConfig.modelId,
      options: { reasoningLevel: "disabled" },
    },
    userConfigPath: input.configPath,
    providerRegistry: createProviderRegistry(input.modules.provider, providerConfig),
    // Bug 根因：迁移 Registry 时漏传恢复参数，原本的 cold case 会误建新 session。
    ...(input.resume ? { resume: true } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
}

function createProviderRegistry(providerModule, input) {
  if (!input.baseURL) {
    throw new Error(`Compact E2E Provider ${input.providerId} is missing baseURL`);
  }
  const config = new providerModule.ProviderConfig({
    group: "standard-personal",
    access: new providerModule.ApiKeyAccessConfig({ apiKey: input.apiKey }),
    api: new providerModule.ProviderApiConfig({
      type: input.apiFormat,
      baseUrl: input.baseURL,
    }),
    personalModelIds: [input.modelId],
    visibility: "visible",
  });
  const model = new providerModule.ModelConfig({
    enabled: true,
    properties: new providerModule.ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: input.contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: false,
        supportsPdf: true,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new providerModule.ModelOptionSpecsConfig({
      reasoningLevel: { values: ["disabled"], map: "{}" },
      // Bug 根因：helper 丢掉 case 的预算并漏配 Option Map，旧 wire 断言因此失去真实输入。
      maxOutputTokens: {
        max: input.maxOutputTokens,
        map: `{"${OUTPUT_TOKEN_FIELDS[input.apiFormat]}":maxOutputTokens}`,
      },
    }),
  });
  return new providerModule.ProviderRegistry([
    {
      providerId: input.providerId,
      config,
      models: [{ modelId: input.modelId, config: model }],
    },
  ]);
}

export async function makeCaseDirs(input) {
  const paths = {
    artifactsDir: join(input.artifactsRoot, "cases", input.caseName),
    capturePath: join(input.artifactsRoot, "cases", input.caseName, "capture.json"),
    configPath: join(input.caseRoot, "config.json"),
    eventsPath: join(input.artifactsRoot, "cases", input.caseName, "events.json"),
    resultPath: join(input.artifactsRoot, "cases", input.caseName, "result.json"),
    storageDir: join(input.caseRoot, "storage"),
    workspace: join(input.caseRoot, "workspace"),
  };
  await mkdir(paths.storageDir, { recursive: true });
  await mkdir(paths.artifactsDir, { recursive: true });
  return paths;
}

export function assertCondition(condition, message, details) {
  if (condition) return;
  const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : "";
  throw new Error(`${message}${suffix}`);
}

export function countEvents(events, type) {
  return events.filter((event) => event.type === type).length;
}

export function countEventTypes(events) {
  const counts = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

export function modelRequests(events, SessionEventType) {
  return events.filter((event) => event.type === SessionEventType.ModelRequest);
}

export function compactBoundaries(events, SessionEventType) {
  return events.filter((event) => event.type === SessionEventType.CompactBoundary);
}

export function stringifyModelRequest(event) {
  const payload = event?.payload;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  return messages.map((message) => modelContentToText(message.content)).join("\n");
}

export function modelContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => modelContentToText(blockText(block))).join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

export function buildCaseResult(input) {
  return {
    capturePath: input.capturePath,
    capturedProviderRequestCount: input.capturedProviderRequestCount,
    case: input.caseName,
    eventCounts: countEventTypes(input.events),
    eventsPath: input.eventsPath,
    finalResponsePreview: input.response?.slice(0, 1000),
    model: input.model,
    resultPath: input.resultPath,
    status: "passed",
    traceId: input.traceId,
  };
}

export function assertProviderCapture(records) {
  assertCondition(records.length >= 1, "expected provider traffic to be captured");
  assertCondition(
    records.some((record) => record.upstreamURL.includes("/chat/completions")),
    "expected capture to include a chat completions request",
    { capturedURLs: records.map((record) => record.upstreamURL) },
  );
}

export function hasMicrocompactPlaceholder(text) {
  return text.includes(MICROCOMPACT_PLACEHOLDER);
}

export function fakeProviderConfig(input) {
  return {
    apiKeyRequired: false,
    baseURL: input.baseURL,
    model: input.model,
    providerId: FAKE_PROVIDER,
    providerName: "Compact E2E Fake Provider",
    storageDir: input.storageDir,
  };
}

function blockText(block) {
  if (!block || typeof block !== "object") return block;
  if (typeof block.text === "string") return block.text;
  if (typeof block.placeholder === "string") return block.placeholder;
  return block;
}
