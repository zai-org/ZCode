import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { selectUpstreamProviderModelById } from "#e2e/helpers/upstream-provider";
import { waitForSelectedModel } from "#e2e/helpers/model-provider-restart";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const PROVIDER_ID = "output-token-preflight-e2e";
const PROVIDER_NAME = "Output Token Preflight E2E";
const MODEL_ID = "otb-preflight-64k";
const OTB08_HISTORY_MARKER = "E2E_OTB08_HISTORY";
const OTB08_SEED_MARKER = "E2E_OTB08_SEED";
const OTB08_POST_MARKER = "E2E_OTB08_POST";
const OTB09_SEED_MARKER = "E2E_OTB09_SEED";
const OTB09_CAP_MARKER = "E2E_OTB09_CAP";
const OTB10_HISTORY_MARKER = "E2E_OTB10_HISTORY";
const OTB10_SEED_MARKER = "E2E_OTB10_SEED";
const OTB10_REACTIVE_MARKER = "E2E_OTB10_REACTIVE";
const OTB09_EXACT_USER_MESSAGE_LENGTH = 255_984;
const paths = getE2EAppDataPaths();

describe("模型上下文预算 preflight-v1 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("OTB08-OTB10: 21K reserve、请求前 cap 与 reactive compact 保持同一策略", async function () {
    this.timeout(360_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectModel();

    const runId = Date.now();
    await sendAndReadSuccessfulMainRequest({
      expectedMaxTokens: 64_000,
      expectedResponse: "otb08-history-ready",
      marker: `${OTB08_HISTORY_MARKER}_${runId}`,
    });
    const otb08Seed = await sendAndReadSuccessfulMainRequest({
      expectedMaxTokens: 64_000,
      expectedResponse: "otb08-seed-ready",
      marker: `${OTB08_SEED_MARKER}_${runId}`,
    });
    const otb08PostMarker = `${OTB08_POST_MARKER}_${runId}`;
    await sendV4Prompt(`${otb08PostMarker}: Reply with exactly "otb08-post-compact-ok".`);
    await waitForCompletedAssistant("otb08-post-compact-ok", "OTB08");
    const otb08Compact = await waitForSuccessfulModelIo({
      querySource: "compact",
      sessionId: otb08Seed.sessionId,
    });
    const otb08Post = await waitForSuccessfulModelIo({
      marker: otb08PostMarker,
      querySource: "main_turn",
      sessionId: otb08Seed.sessionId,
    });
    expect(otb08Compact.body.max_completion_tokens).toBe(20_000);
    expect(otb08Post.body.max_completion_tokens).toBe(64_000);
    expect(await waitForAutoCompactDecision(otb08Seed.sessionId)).toMatchObject({
      contextWindow: 128_000,
      effectiveContextWindow: 107_000,
      modelContextBudgetStrategy: "preflight-v1",
      threshold: 94_000,
    });

    await startNewV4Draft();
    await selectModel();
    await sendAndReadSuccessfulMainRequest({
      expectedMaxTokens: 64_000,
      expectedResponse: "otb09-seed-ready",
      marker: `${OTB09_SEED_MARKER}_${runId}`,
    });
    const otb09Marker = `${OTB09_CAP_MARKER}_${runId}`;
    await sendV4Prompt(buildExactLengthPrompt(otb09Marker));
    await waitForCompletedAssistant("otb09-preflight-ok", "OTB09");
    const otb09 = await waitForSuccessfulModelIo({
      marker: otb09Marker,
      querySource: "main_turn",
    });
    // provider usage anchor 已覆盖上一轮 assistant；suffix 估算本轮 user 的 85,328 tokens，
    // 以及同轮 token 预算提醒（独立隐藏 user 行，86 字符）的 29 tokens，因此可用输出为 41,642。
    // 修复原因：引入该提醒后旧值 41,671 少算了这一行，回放夹具按旧值匹配不到请求。
    expect(otb09.body.max_completion_tokens).toBe(41_642);

    await startNewV4Draft();
    await selectModel();
    await sendAndReadSuccessfulMainRequest({
      expectedMaxTokens: 64_000,
      expectedResponse: "otb10-history-ready",
      marker: `${OTB10_HISTORY_MARKER}_${runId}`,
    });
    const otb10Seed = await sendAndReadSuccessfulMainRequest({
      expectedMaxTokens: 64_000,
      expectedResponse: "otb10-seed-ready",
      marker: `${OTB10_SEED_MARKER}_${runId}`,
    });
    const otb10Marker = `${OTB10_REACTIVE_MARKER}_${runId}`;
    await sendV4Prompt(`${otb10Marker}: Reply with exactly "otb10-reactive-compact-ok".`);
    await waitForCompletedAssistant("otb10-reactive-compact-ok", "OTB10");

    // Bug 根因：provider 在 beforeSession 已绑定 WDIO 的统一 replay server；spec 内另起
    // server 会形成无人请求的第二份 artifact，无法代表真实 provider-visible 请求。
    const artifactPath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
    if (!artifactPath) throw new Error("OTB10 缺少 WDIO replay capture path");
    const otb10MainRequests = await waitForProviderRequests({
      artifactPath,
      expectedCount: 2,
      marker: otb10Marker,
    });
    expect(otb10MainRequests).toHaveLength(2);
    expect(otb10MainRequests[0]?.statusCode).toBe(400);
    expect(otb10MainRequests[0]?.body.max_completion_tokens).toEqual(expect.any(Number));
    expect(Number(otb10MainRequests[0]?.body.max_completion_tokens)).toBeLessThan(64_000);
    expect(otb10MainRequests[1]).toMatchObject({
      body: { max_completion_tokens: 64_000 },
      statusCode: 200,
    });
    const otb10Compact = await waitForSuccessfulModelIo({
      querySource: "compact",
      sessionId: otb10Seed.sessionId,
    });
    expect(otb10Compact.body.max_completion_tokens).toBe(20_000);
  });
});

async function selectModel(): Promise<void> {
  await selectUpstreamProviderModelById(MODEL_ID, {
    includePlainModelFallback: false,
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
  });
  await waitForSelectedModel(PROVIDER_ID, MODEL_ID);
}

async function sendAndReadSuccessfulMainRequest(input: {
  expectedMaxTokens: number;
  expectedResponse: string;
  marker: string;
}): Promise<ModelIoMatch> {
  await sendV4Prompt(`${input.marker}: Reply with exactly "${input.expectedResponse}".`);
  const sessionId = await waitForCompletedAssistant(input.expectedResponse, input.marker);
  const record = await waitForSuccessfulModelIo({
    marker: input.marker,
    querySource: "main_turn",
    sessionId,
  });
  expect(record.body.max_completion_tokens).toBe(input.expectedMaxTokens);
  return record;
}

async function waitForCompletedAssistant(expectedResponse: string, label: string): Promise<string> {
  await waitForV4AssistantMessageContaining(expectedResponse);
  const pane = await waitForV4Pane(
    (snapshot) =>
      Boolean(snapshot.sessionId && snapshot.sessionId !== "draft") && !snapshot.canStop,
    `${label} 没有完成`,
    120_000,
  );
  if (!pane.sessionId || pane.sessionId === "draft") {
    throw new Error(`${label} 完成后仍未绑定真实 session`);
  }
  return pane.sessionId;
}

function buildExactLengthPrompt(marker: string): string {
  const prefix = `${marker}: `;
  const suffix = ' Reply with exactly "otb09-preflight-ok".';
  const fillerLength = OTB09_EXACT_USER_MESSAGE_LENGTH - prefix.length - suffix.length;
  if (fillerLength <= 0) {
    throw new Error("OTB09 exact-length prompt marker is unexpectedly long");
  }
  const prompt = `${prefix}${"x".repeat(fillerLength)}${suffix}`;
  expect(prompt).toHaveLength(OTB09_EXACT_USER_MESSAGE_LENGTH);
  return prompt;
}

interface ModelIoRecord {
  error?: unknown;
  querySource?: string;
  request?: { body?: unknown };
  response?: unknown;
  sessionId?: string;
}

interface ModelIoMatch {
  body: Record<string, unknown>;
  sessionId: string;
}

interface ProviderRequestMatch {
  body: Record<string, unknown>;
  statusCode?: number;
}

async function waitForSuccessfulModelIo(input: {
  marker?: string;
  querySource: "compact" | "main_turn";
  sessionId?: string;
}): Promise<ModelIoMatch> {
  let matched: ModelIoMatch | null = null;
  await browser.waitUntil(
    async () => {
      const records = await readModelIoRecords();
      for (const { line, record } of records) {
        if (input.marker && !line.includes(input.marker)) continue;
        if (
          record.error !== undefined ||
          record.response === undefined ||
          record.querySource !== input.querySource ||
          (input.sessionId !== undefined && record.sessionId !== input.sessionId)
        ) {
          continue;
        }
        const body = parseJsonObject(record.request?.body);
        if (!body || body.bodySource === "ai_sdk_options" || !record.sessionId) continue;
        matched = { body, sessionId: record.sessionId };
        return true;
      }
      return false;
    },
    {
      timeout: 45_000,
      timeoutMsg: `没有找到成功的 model-io: ${input.marker ?? input.sessionId ?? input.querySource}`,
    },
  );
  if (!matched) throw new Error("成功 model-io 等待完成后仍为空");
  return matched;
}

async function waitForProviderRequests(input: {
  artifactPath: string;
  expectedCount: number;
  marker: string;
}): Promise<ProviderRequestMatch[]> {
  let matched: ProviderRequestMatch[] = [];
  await browser.waitUntil(
    async () => {
      const artifact = parseJsonObject(await readFile(input.artifactPath, "utf-8").catch(() => ""));
      const records = Array.isArray(artifact?.records) ? artifact.records : [];
      matched = records.flatMap((value) => {
        const record = parseJsonObject(value);
        const body = parseJsonObject(record?.requestJson);
        if (!body || !JSON.stringify(body).includes(input.marker)) return [];
        return [
          {
            body,
            statusCode: typeof record?.statusCode === "number" ? record.statusCode : undefined,
          },
        ];
      });
      return matched.length >= input.expectedCount;
    },
    {
      timeout: 45_000,
      timeoutMsg: `没有捕获 ${input.expectedCount} 条 OTB10 provider 请求`,
    },
  );
  return matched;
}

async function readModelIoRecords(): Promise<Array<{ line: string; record: ModelIoRecord }>> {
  // 统一从 E2E path helper 读取历史 .zcode 根，避免测试与 runner 的 HOME 发生漂移。
  const debugDir = join(paths.storageRoot, "cli", "debug");
  const files = await readdir(debugDir).catch(() => []);
  const records: Array<{ line: string; record: ModelIoRecord }> = [];
  for (const file of files.filter(
    (name) => name.startsWith("model-io-") && name.endsWith(".jsonl"),
  )) {
    const content = await readFile(join(debugDir, file), "utf-8").catch(() => "");
    for (const line of content.split("\n")) {
      const record = parseJsonObject(line) as ModelIoRecord | null;
      if (record) records.push({ line, record });
    }
  }
  return records;
}

async function waitForAutoCompactDecision(sessionId: string): Promise<Record<string, unknown>> {
  const logDir = process.env.ZCODE_LOG_DIR?.trim() || join(paths.storageRoot, "cli", "log");
  let matched: Record<string, unknown> | null = null;
  await browser.waitUntil(
    async () => {
      const files = await readdir(logDir).catch(() => []);
      for (const file of files) {
        const content = await readFile(join(logDir, file), "utf-8").catch(() => "");
        for (const line of content.split("\n")) {
          const entry = parseJsonObject(line);
          if (entry?.event !== "compact.auto.started" || entry.sessionId !== sessionId) continue;
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
      timeout: 45_000,
      timeoutMsg: `没有找到 preflight-v1 Auto Compact 日志: ${sessionId}`,
    },
  );
  if (!matched) throw new Error("Auto Compact decision 等待完成后仍为空");
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
