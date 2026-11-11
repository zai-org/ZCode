import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { refreshSeededOpenAIProvidersThroughSettings } from "#e2e/helpers/custom-openai-provider";
import { selectUpstreamProviderModelById } from "#e2e/helpers/upstream-provider";
import { seedReplayProvider, waitForSelectedModel } from "#e2e/helpers/model-provider-restart";
import { waitForProviderConfigPolling } from "#e2e/helpers/provider-config-polling";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4CompactMarker,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const PROVIDER_ID = "output-token-budget-e2e";
const PROVIDER_NAME = "Output Token Budget E2E";
const MODEL_DEFAULT = "otb-default";
const MODEL_16K = "otb-16k";
const MODEL_64K = "otb-64k";
const MODEL_REFRESH = "otb-runtime-refresh";
const OTB01_MARKER = "E2E_OTB01_MAIN";
const OTB02_MAIN_MARKER = "E2E_OTB02_MAIN";
const OTB02_HISTORY_MARKER = "E2E_OTB02_HISTORY";
const OTB03_MARKER = "E2E_OTB03_MAIN";
const OTB06_HISTORY_MARKER = "E2E_OTB06_HISTORY";
const OTB06_SEED_MARKER = "E2E_OTB06_SEED";
const OTB06_POST_MARKER = "E2E_OTB06_POST";
const OTB07_BEFORE_MARKER = "E2E_OTB07_BEFORE_REFRESH";
const OTB07_AFTER_MARKER = "E2E_OTB07_AFTER_REFRESH";
const paths = getE2EAppDataPaths();

describe("模型级输出预算 model-io E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("OTB01-OTB03/OTB06-OTB07: 请求体、Compact 与运行期 registry 使用同一模型级预算", async function () {
    this.timeout(300_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectModel(MODEL_DEFAULT);

    const runId = Date.now();
    const otb01 = await sendAndReadMainRequest({
      expectedMaxTokens: 32_000,
      expectedResponse: "otb01-output-budget-ok",
      marker: `${OTB01_MARKER}_${runId}`,
      modelId: MODEL_DEFAULT,
    });
    expect(otb01.body.max_completion_tokens).toBe(32_000);

    await startNewV4Draft();
    await selectModel(MODEL_16K);
    const otb02MainMarker = `${OTB02_MAIN_MARKER}_${runId}`;
    const otb02Main = await sendAndReadMainRequest({
      expectedMaxTokens: 16_000,
      expectedResponse: "otb02-output-budget-ok",
      marker: otb02MainMarker,
      modelId: MODEL_16K,
    });
    expect(otb02Main.body.max_completion_tokens).toBe(16_000);

    await sendAndReadMainRequest({
      expectedMaxTokens: 16_000,
      expectedResponse: "otb02-history-ready",
      marker: `${OTB02_HISTORY_MARKER}_${runId}`,
      modelId: MODEL_16K,
    });
    await sendV4Prompt("/compact");
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90_000);
    const otb02Compact = await waitForSuccessfulModelIo({
      marker: otb02MainMarker,
      querySource: "compact",
    });
    expect(otb02Compact.body.max_completion_tokens).toBe(16_000);

    await startNewV4Draft();
    await selectModel(MODEL_64K);
    const otb03 = await sendAndReadMainRequest({
      expectedMaxTokens: 64_000,
      expectedResponse: "otb03-output-budget-ok",
      marker: `${OTB03_MARKER}_${runId}`,
      modelId: MODEL_64K,
    });
    expect(otb03.body.max_completion_tokens).toBe(64_000);

    await startNewV4Draft();
    await selectModel(MODEL_64K);
    await sendAndReadMainRequest({
      expectedMaxTokens: 64_000,
      expectedResponse: "otb06-history-ready",
      marker: `${OTB06_HISTORY_MARKER}_${runId}`,
      modelId: MODEL_64K,
    });
    const otb06Seed = await sendAndReadMainRequest({
      expectedMaxTokens: 64_000,
      expectedResponse: "otb06-seed-ready",
      marker: `${OTB06_SEED_MARKER}_${runId}`,
      modelId: MODEL_64K,
    });
    expect(otb06Seed.body.max_completion_tokens).toBe(64_000);

    const otb06PostMarker = `${OTB06_POST_MARKER}_${runId}`;
    const postPrompt = `${otb06PostMarker}: Reply with exactly "otb06-post-compact-ok".`;
    await sendV4Prompt(postPrompt);
    await waitForV4AssistantMessageContaining("otb06-post-compact-ok");
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "OTB06 auto compact 后主请求没有完成",
      90_000,
    );

    const otb06Compact = await waitForSuccessfulModelIo({
      querySource: "compact",
      sessionId: otb06Seed.sessionId,
    });
    expect(otb06Compact.body.max_completion_tokens).toBe(20_000);
    const otb06Post = await waitForSuccessfulModelIo({
      marker: otb06PostMarker,
      querySource: "main_turn",
    });
    expect(otb06Post.body.max_completion_tokens).toBe(64_000);

    const autoCompactDecision = await waitForAutoCompactDecision(otb06Post.sessionId);
    expect(autoCompactDecision).toMatchObject({
      contextWindow: 128_000,
      effectiveContextWindow: 107_000,
      modelContextBudgetStrategy: "preflight-v1",
      threshold: 94_000,
    });
    expect(
      Number(autoCompactDecision.contextWindow) -
        Number(autoCompactDecision.effectiveContextWindow),
    ).toBe(21_000);

    await startNewV4Draft();
    await selectModel(MODEL_REFRESH);
    const otb07Before = await sendAndReadMainRequest({
      expectedMaxTokens: 32_000,
      expectedResponse: "otb07-before-refresh-ok",
      marker: `${OTB07_BEFORE_MARKER}_${runId}`,
      modelId: MODEL_REFRESH,
    });
    await seedOutputBudgetProvider(64_000);
    await refreshSeededOpenAIProvidersThroughSettings([PROVIDER_NAME]);
    await waitForProviderConfigPolling();
    await waitForSelectedModel(PROVIDER_ID, MODEL_REFRESH);

    const otb07After = await sendAndReadMainRequest({
      expectedMaxTokens: 64_000,
      expectedResponse: "otb07-after-refresh-ok",
      marker: `${OTB07_AFTER_MARKER}_${runId}`,
      modelId: MODEL_REFRESH,
    });
    expect(otb07After.sessionId).toBe(otb07Before.sessionId);

    await sendV4Prompt("/compact");
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90_000);
    const otb07Compact = await waitForSuccessfulModelIo({
      marker: OTB07_BEFORE_MARKER,
      querySource: "compact",
      sessionId: otb07Before.sessionId,
    });
    expect(otb07Compact.modelId).toBe(MODEL_REFRESH);
    expect(otb07Compact.body.max_completion_tokens).toBe(20_000);
  });
});

async function seedOutputBudgetProvider(runtimeRefreshMaxOutputTokens?: number): Promise<void> {
  await seedReplayProvider({
    id: PROVIDER_ID,
    models: [
      { contextWindow: 128_000, id: MODEL_DEFAULT },
      { contextWindow: 128_000, id: MODEL_16K, limit: { output: 16_000 } },
      { contextWindow: 128_000, id: MODEL_64K, maxOutputTokens: 64_000 },
      {
        contextWindow: 128_000,
        id: MODEL_REFRESH,
        ...(runtimeRefreshMaxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: runtimeRefreshMaxOutputTokens }),
      },
    ],
    name: PROVIDER_NAME,
  });
}

async function selectModel(modelId: string): Promise<void> {
  await selectUpstreamProviderModelById(modelId, {
    includePlainModelFallback: false,
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
  });
  await waitForSelectedModel(PROVIDER_ID, modelId);
}

async function sendAndReadMainRequest(input: {
  expectedMaxTokens: number;
  expectedResponse: string;
  marker: string;
  modelId: string;
}): Promise<ModelIoMatch> {
  const prompt = `${input.marker}: Reply with exactly "${input.expectedResponse}".`;
  await sendV4Prompt(prompt);
  // Bug 根因：expectedResponse 同时出现在用户 prompt 中，旧 timeline includes 会在
  // assistant 尚未回复时提前命中；紧随其后的 !canStop 也可能在异步 run 启动前为真。
  // 统一运行负载较高时，case 因此会过早开始 model-io 轮询并在真实请求落盘前超时。
  await waitForV4AssistantMessageContaining(input.expectedResponse);
  const completedPane = await waitForV4Pane(
    (snapshot) =>
      Boolean(snapshot.sessionId && snapshot.sessionId !== "draft") && !snapshot.canStop,
    `${input.marker} 没有完成`,
    90_000,
  );
  if (!completedPane.sessionId || completedPane.sessionId === "draft") {
    throw new Error(`${input.marker} 完成后仍未绑定真实 session`);
  }
  const record = await waitForSuccessfulModelIo({
    marker: input.marker,
    querySource: "main_turn",
    sessionId: completedPane.sessionId,
  });
  expect(record.modelId).toBe(input.modelId);
  // Bug 根因：OpenAI Chat Completions 的正式 Model Option Map 已统一写入
  // max_completion_tokens；旧 E2E 仍匹配 Adapter 时代的 max_tokens，导致 replay
  // 拒绝真实请求，并把配置正确性误报成 Registry 未生效。
  expect(record.body.max_completion_tokens).toBe(input.expectedMaxTokens);
  return record;
}

interface ModelIoRecord {
  error?: unknown;
  model?: { modelId?: string };
  querySource?: string;
  request?: { body?: unknown };
  response?: unknown;
  sessionId?: string;
}

interface ModelIoMatch {
  body: Record<string, unknown>;
  modelId: string | undefined;
  sessionId: string;
}

async function waitForSuccessfulModelIo(input: {
  marker?: string;
  querySource: "compact" | "main_turn";
  sessionId?: string;
}): Promise<ModelIoMatch> {
  const debugDir = join(paths.homeDir, ".zcode", "cli", "debug");
  let matched: ModelIoMatch | null = null;
  await browser.waitUntil(
    async () => {
      const files = await readdir(debugDir).catch(() => []);
      for (const file of files.filter(
        (name) => name.startsWith("model-io-") && name.endsWith(".jsonl"),
      )) {
        const content = await readFile(join(debugDir, file), "utf-8").catch(() => "");
        for (const line of content.split("\n")) {
          if (input.marker && !line.includes(input.marker)) continue;
          const record = parseJsonObject(line) as ModelIoRecord | null;
          if (
            !record ||
            record.error !== undefined ||
            record.response === undefined ||
            record.querySource !== input.querySource ||
            (input.sessionId !== undefined && record.sessionId !== input.sessionId)
          ) {
            continue;
          }
          const body = parseJsonObject(record.request?.body);
          if (!body || body.bodySource === "ai_sdk_options" || !record.sessionId) {
            continue;
          }
          matched = {
            body,
            modelId: record.model?.modelId,
            sessionId: record.sessionId,
          };
          return true;
        }
      }
      return false;
    },
    {
      timeout: 30_000,
      timeoutMsg:
        `没有找到成功的 model-io 请求: marker=${input.marker ?? "<none>"}, ` +
        `sessionId=${input.sessionId ?? "<none>"}, querySource=${input.querySource}`,
    },
  );
  if (!matched) {
    throw new Error(
      `model-io 等待完成后仍为空: ${input.marker ?? input.sessionId ?? input.querySource}`,
    );
  }
  return matched;
}

async function waitForAutoCompactDecision(sessionId: string): Promise<Record<string, unknown>> {
  const logDir = process.env.ZCODE_LOG_DIR?.trim() || join(paths.homeDir, ".zcode", "cli", "log");
  let matched: Record<string, unknown> | null = null;
  await browser.waitUntil(
    async () => {
      const files = await readdir(logDir).catch(() => []);
      for (const file of files) {
        const content = await readFile(join(logDir, file), "utf-8").catch(() => "");
        for (const line of content.split("\n")) {
          const entry = parseJsonObject(line);
          if (entry?.event !== "compact.auto.started" || entry.sessionId !== sessionId) {
            continue;
          }
          const context = parseJsonObject(entry.context);
          if (context) {
            matched = context;
            return true;
          }
        }
      }
      return false;
    },
    {
      timeout: 30_000,
      timeoutMsg: `没有找到 OTB06 Auto Compact decision 日志: ${sessionId}`,
    },
  );
  if (!matched) {
    throw new Error(`Auto Compact decision 等待完成后仍为空: ${sessionId}`);
  }
  return matched;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parseJsonObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
