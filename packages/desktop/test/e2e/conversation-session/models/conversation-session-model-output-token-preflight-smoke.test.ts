import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { selectUpstreamProviderModelById } from "#e2e/helpers/upstream-provider";
import { waitForSelectedModel } from "#e2e/helpers/model-provider-restart";
import { totalTokensAfterLastAssistant } from "#e2e/helpers/total-tokens-evidence";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "#e2e/helpers/network-capture-proxy";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const PROVIDER_ID = "output-token-preflight-e2e";
const PROVIDER_NAME = "Output Token Preflight E2E";
const COMPACT_SUMMARY_MAX_OUTPUT_TOKENS = 20_000;
const PREFLIGHT_BUFFER = 1_000;
type MessageLengthRange = readonly [minimum: number, maximum: number];
const BASE_MESSAGE_LENGTH_RANGES = [
  [768, 1_536],
  [4_096, 6_144],
  [6_144, 8_192],
  [8_192, 12_288],
  [10_240, 14_336],
] as const satisfies readonly MessageLengthRange[];

interface SmokeScenario {
  baselineMaxOutputTokens: number;
  caseId: string;
  contextWindow: number;
  effectiveInputWindow: number;
  expectedMessageLengths: readonly number[];
  label: string;
  lengthSeed: number;
  markerPrefix: string;
  modelId: string;
  providerContextUsageAfterTurn: readonly number[];
  tailMessageLengthRanges: readonly MessageLengthRange[];
  threshold: number;
}

const SMOKE_SCENARIOS = [
  {
    baselineMaxOutputTokens: 48_000,
    caseId: "OTB11",
    contextWindow: 64_000,
    effectiveInputWindow: 43_000,
    expectedMessageLengths: [954, 4_807, 8_171, 10_321, 13_328, 8_961],
    label: "64K/48K",
    lengthSeed: 0x0b71_1e2e,
    markerPrefix: "E2E_OTB11_TURN",
    modelId: "otb-preflight-smoke-64k-48k",
    providerContextUsageAfterTurn: [8_008, 14_008, 18_508, 23_508, 28_508],
    tailMessageLengthRanges: [[7_168, 10_240]],
    threshold: 30_000,
  },
  {
    baselineMaxOutputTokens: 128_000,
    caseId: "OTB12",
    contextWindow: 200_000,
    effectiveInputWindow: 179_000,
    expectedMessageLengths: [1_288, 5_148, 7_535, 8_749, 12_062, 2_155, 2_377, 878],
    label: "200K/128K",
    lengthSeed: 0x0b12_2000,
    markerPrefix: "E2E_OTB12_TURN",
    modelId: "otb-preflight-smoke-200k-128k",
    providerContextUsageAfterTurn: [45_008, 70_008, 100_008, 135_008, 164_008, 165_100, 165_800],
    tailMessageLengthRanges: [
      [1_800, 2_800],
      [1_200, 2_400],
      [700, 1_300],
    ],
    threshold: 166_000,
  },
] satisfies readonly SmokeScenario[];
const paths = getE2EAppDataPaths();

describe("模型上下文预算混合长度 smoke E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  for (const scenario of SMOKE_SCENARIOS) {
    it(`${scenario.caseId}: ${scenario.label} 下真实多轮消息应连续缩 cap 并在 ${scenario.threshold / 1_000}K 自动压缩`, async function () {
      this.timeout(360_000);
      await runSmokeScenario(scenario);
    });
  }
});

async function runSmokeScenario(scenario: SmokeScenario): Promise<void> {
  await prepareV4ConversationE2E({ skipProvider: true });
  await selectModel(scenario.modelId);

  const messageLengths = buildDeterministicMessageLengths(
    scenario.lengthSeed,
    scenario.tailMessageLengthRanges,
  );
  expect(messageLengths).toEqual(scenario.expectedMessageLengths);
  const preCompactTurnCount = scenario.providerContextUsageAfterTurn.length;
  expect(messageLengths).toHaveLength(preCompactTurnCount + 1);
  const runId = Date.now();
  const observedCappedValues: number[] = [];
  let sessionId: string | null = null;

  for (let index = 0; index < preCompactTurnCount; index += 1) {
    const turn = index + 1;
    const marker = `${scenario.markerPrefix}_${turn}_${runId}`;
    const response = `${scenario.caseId.toLowerCase()}-turn-${turn}-ok`;
    const skipCountBefore = sessionId
      ? (await readAutoCompactContexts(sessionId, "compact.auto.skipped")).length
      : 0;

    await sendV4Prompt(
      buildExactLengthPrompt(marker, response, messageLengths[index]!, scenario.lengthSeed, turn),
    );
    const completedSessionId = await waitForCompletedAssistant(
      response,
      `${scenario.caseId} turn ${turn}`,
    );
    sessionId ??= completedSessionId;
    expect(completedSessionId).toBe(sessionId);

    const request = await waitForCapturedRequest({ latestUserMarker: marker });
    const maxTokens = readMaxTokens(request.record);
    expect(maxTokens).toBeGreaterThan(0);
    expect(maxTokens).toBeLessThanOrEqual(scenario.baselineMaxOutputTokens);

    if (turn === 1) continue;
    const decision = await waitForNewAutoCompactContext({
      afterCount: skipCountBefore,
      event: "compact.auto.skipped",
      sessionId,
    });
    assertCommonDecision(decision, "below_threshold", scenario);
    // provider fixture 给出已覆盖上一轮 assistant 的精确 context usage；生产 estimator
    // 只叠加本轮 user 与同轮 token 预算提醒。日志中的 tokenCount 会被归档脱敏，
    // 因此 wire cap 应从这组同源输入独立计算，不能依赖脱敏日志反推。
    const estimatedCurrentUsage =
      estimateUsageBeforeTurn(scenario, turn, messageLengths[index]!) +
      estimateTotalTokensReminderRow(request.record.requestJson);
    const expectedMaxTokens = Math.min(
      scenario.baselineMaxOutputTokens,
      scenario.contextWindow - estimatedCurrentUsage - PREFLIGHT_BUFFER,
    );
    expect(maxTokens).toBe(expectedMaxTokens);

    if (turn === 2) {
      expect(maxTokens).toBe(scenario.baselineMaxOutputTokens);
    } else {
      expect(estimatedCurrentUsage).toBeGreaterThan(
        scenario.contextWindow - scenario.baselineMaxOutputTokens - PREFLIGHT_BUFFER,
      );
      expect(maxTokens).toBeLessThan(scenario.baselineMaxOutputTokens);
      observedCappedValues.push(maxTokens);
    }
  }

  expect(observedCappedValues).toHaveLength(preCompactTurnCount - 2);
  for (let index = 1; index < observedCappedValues.length; index += 1) {
    expect(observedCappedValues[index]).toBeLessThan(observedCappedValues[index - 1]!);
  }
  if (scenario.caseId === "OTB12") {
    const capAtCompactThreshold = scenario.contextWindow - scenario.threshold - PREFLIGHT_BUFFER;
    expect(observedCappedValues.at(-1)).toBeGreaterThan(capAtCompactThreshold);
    expect(observedCappedValues.at(-1)).toBeLessThan(capAtCompactThreshold + 500);
  }

  if (!sessionId) {
    throw new Error(`${scenario.caseId} 前 ${preCompactTurnCount} 轮完成后仍缺少 sessionId`);
  }
  const finalTurn = preCompactTurnCount + 1;
  const finalMarker = `${scenario.markerPrefix}_${finalTurn}_${runId}`;
  const compactHistoryMarker = `${scenario.markerPrefix}_${preCompactTurnCount}_${runId}`;
  const finalResponse = `${scenario.caseId.toLowerCase()}-turn-${finalTurn}-ok`;
  const compactCountBefore = (await readAutoCompactContexts(sessionId, "compact.auto.started"))
    .length;

  await sendV4Prompt(
    buildExactLengthPrompt(
      finalMarker,
      finalResponse,
      messageLengths[finalTurn - 1]!,
      scenario.lengthSeed,
      finalTurn,
    ),
  );
  expect(await waitForCompletedAssistant(finalResponse, `${scenario.caseId} final turn`)).toBe(
    sessionId,
  );

  const compactDecision = await waitForNewAutoCompactContext({
    afterCount: compactCountBefore,
    event: "compact.auto.started",
    sessionId,
  });
  assertCommonDecision(compactDecision, undefined, scenario);
  // 只作下界：未计入同轮 token 预算提醒（29 tokens），少算只会更低，仍应已达阈值。
  expect(
    estimateUsageBeforeTurn(scenario, finalTurn, messageLengths[finalTurn - 1]!),
  ).toBeGreaterThanOrEqual(scenario.threshold);

  const compactRequest = await waitForCapturedRequest({
    bodyIncludes: [compactHistoryMarker, "create a detailed summary"],
  });
  const resumedMainRequest = await waitForCapturedRequest({
    latestUserMarker: finalMarker,
  });
  expect(compactRequest.index).toBeLessThan(resumedMainRequest.index);
  expect(readMaxTokens(compactRequest.record)).toBe(COMPACT_SUMMARY_MAX_OUTPUT_TOKENS);
  // 压缩保留系统/项目指令，完整上下文可能仍超过 baseline 的输入预算；
  // 适配器还会合并系统消息，改变逐条向上取整的结果；必须用适配前完整消息独立估算。
  const resumedMessages = await readPostCompactModelMessages(sessionId, finalMarker);
  let postCompactUsage = 0;
  for (const message of resumedMessages) {
    postCompactUsage += estimateTextTokens(
      readTokenEstimateText(parseJsonObject(message)?.content),
    );
  }
  expect(readMaxTokens(resumedMainRequest.record)).toBe(
    Math.min(
      scenario.baselineMaxOutputTokens,
      scenario.contextWindow - postCompactUsage - PREFLIGHT_BUFFER,
    ),
  );
  expect(readMaxTokens(resumedMainRequest.record)).toBeGreaterThan(observedCappedValues.at(-1)!);

  const compactContexts = await readAutoCompactContexts(sessionId, "compact.auto.started");
  expect(compactContexts).toHaveLength(compactCountBefore + 1);
}

async function readPostCompactModelMessages(sessionId: string, marker: string): Promise<unknown[]> {
  const logPath = join(paths.storageRoot, "cli", "debug", `model-io-${sessionId}.jsonl`);
  const content = await readFile(logPath, "utf-8");
  const record = content
    .split("\n")
    .map(parseJsonObject)
    .find((entry) => {
      const request = parseJsonObject(entry?.request);
      return (
        entry?.querySource === "main_turn" && readLatestUserMessageText(request).includes(marker)
      );
    });
  const request = parseJsonObject(record?.request);
  // Compact 重写历史后诊断记录应为完整消息，不能拿增量片段算出偏小的上下文。
  expect(request?.messagesKind).toBe("full");
  expect(request?.messageOffset).toBe(0);
  expect(Array.isArray(request?.messages)).toBe(true);
  const messages = request!.messages as unknown[];
  expect(messages).toHaveLength(request!.messageCount as number);
  return messages;
}

async function selectModel(modelId: string): Promise<void> {
  await selectUpstreamProviderModelById(modelId, {
    includePlainModelFallback: false,
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
  });
  await waitForSelectedModel(PROVIDER_ID, modelId);
}

function buildDeterministicMessageLengths(
  seed: number,
  tailMessageLengthRanges: readonly MessageLengthRange[],
): number[] {
  const random = createXorShift32(seed);
  return [...BASE_MESSAGE_LENGTH_RANGES, ...tailMessageLengthRanges].map(
    ([minimum, maximum]) => minimum + Math.floor(random() * (maximum - minimum + 1)),
  );
}

function buildExactLengthPrompt(
  marker: string,
  response: string,
  targetLength: number,
  seed: number,
  turn: number,
): string {
  const prefix = `${marker}: mixed-length-turn-${turn} `;
  const suffix = ` Reply with exactly "${response}".`;
  const fillerLength = targetLength - prefix.length - suffix.length;
  if (fillerLength <= 0) {
    throw new Error(`Smoke turn ${turn} target length is too small`);
  }
  const prompt = `${prefix}${buildDeterministicAsciiFiller(fillerLength, seed, turn)}${suffix}`;
  expect(prompt).toHaveLength(targetLength);
  return prompt;
}

function buildDeterministicAsciiFiller(length: number, seed: number, turn: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 ,.;:-_";
  const random = createXorShift32((seed ^ (turn * 0x9e37_79b9)) >>> 0);
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(random() * alphabet.length)];
  }
  return value;
}

function createXorShift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function estimateUsageBeforeTurn(
  scenario: SmokeScenario,
  turn: number,
  currentMessageLength: number,
): number {
  const providerContextUsage = scenario.providerContextUsageAfterTurn[turn - 2];
  if (providerContextUsage === undefined) {
    throw new Error(`${scenario.caseId} turn ${turn} 缺少 provider usage anchor`);
  }
  return providerContextUsage + estimateTextTokens("x".repeat(currentMessageLength));
}

function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / ESTIMATED_TOKEN_CHAR_DIVISOR);
}

/**
 * 本轮 token 预算提醒在 CLI 侧是一条独立隐藏 user 行，preflight 和用户消息一起计入
 * usage 锚点之后的增量（apps/zcode-cli/docs/design/v2/loop/meta-user-context.md）。
 * 修复原因：引入该提醒后 spec 只叠加用户消息，期望 cap 比实际高 29 token
 * （86 字符 / 3）。N 取本轮请求里的实际值，按投影后的 system-reminder 文本估算。
 */
function estimateTotalTokensReminderRow(requestJson: unknown): number {
  const values = totalTokensAfterLastAssistant(requestJson);
  expect(values).toHaveLength(1);
  return estimateTextTokens(
    `<system-reminder>\n<total_tokens>${values[0]} tokens left</total_tokens>\n</system-reminder>`,
  );
}

/**
 * 按 CLI estimateMessageTokens 的规则取一条消息参与估算的正文。
 * 修复原因：assistant 回复改为按块保存后，compact 保留的 assistant content 是
 * `[{ type: "text", text, blockIndex }]` 数组，不再是字符串；CLI 估算只取 text 与
 * reasoning 块的正文并用空行连接，块序号不计入。其他块类型不在本场景内，直接报错。
 */
function readTokenEstimateText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error(`消息 content 形态未知: ${JSON.stringify(content)}`);
  return content
    .map((block) => {
      const value = parseJsonObject(block);
      if ((value?.type === "text" || value?.type === "reasoning") && typeof value.text === "string")
        return value.text;
      throw new Error(`消息 content 含未覆盖的块: ${JSON.stringify(block)}`);
    })
    .filter(Boolean)
    .join("\n\n");
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

interface CapturedRequest {
  index: number;
  record: E2ENetworkCaptureRecord;
}

async function waitForCapturedRequest(input: {
  bodyIncludes?: string[];
  latestUserMarker?: string;
}): Promise<CapturedRequest> {
  let matched: CapturedRequest | null = null;
  await browser.waitUntil(
    async () => {
      const artifact = await readCaptureArtifact();
      const index =
        artifact?.records.findIndex((record) => {
          if (
            record.method !== "POST" ||
            !record.path.includes("/chat/completions") ||
            record.status !== "complete"
          ) {
            return false;
          }
          const bodyText = JSON.stringify(record.requestJson ?? null);
          // Bug 原因：标题请求会把首轮原文放进自己的 latest user message，但标题路径
          // 按协议省略 max_completion_tokens；主请求探针必须排除它，不能把相邻辅助请求当 wire 证据。
          if (input.latestUserMarker && bodyText.includes("Generate a concise title")) {
            return false;
          }
          if (!(input.bodyIncludes ?? []).every((value) => bodyText.includes(value))) {
            return false;
          }
          return input.latestUserMarker
            ? readLatestUserMessageText(record.requestJson).includes(input.latestUserMarker)
            : true;
        }) ?? -1;
      if (index < 0 || !artifact) return false;
      matched = { index, record: artifact.records[index]! };
      return true;
    },
    {
      timeout: 45_000,
      timeoutMsg: `没有捕获 output-token smoke provider 请求: ${input.latestUserMarker ?? input.bodyIncludes?.join(",")}`,
    },
  );
  if (!matched) throw new Error("Output-token smoke provider 请求等待完成后仍为空");
  return matched;
}

async function readCaptureArtifact(): Promise<E2ENetworkCaptureArtifact | null> {
  const artifactPath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!artifactPath) {
    throw new Error("Output-token smoke 缺少 E2E_PROVIDER_CAPTURE_PATH");
  }
  try {
    return JSON.parse(await readFile(artifactPath, "utf-8")) as E2ENetworkCaptureArtifact;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function readMaxTokens(record: E2ENetworkCaptureRecord): number {
  const body = parseJsonObject(record.requestJson);
  const value = body?.max_completion_tokens;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Output-token smoke 请求缺少数值 max_completion_tokens: ${record.id}`);
  }
  return value;
}

function readLatestUserMessageText(requestJson: unknown): string {
  const body = parseJsonObject(requestJson);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = parseJsonObject(messages[index]);
    if (message?.role !== "user") continue;
    return readContentText(message.content);
  }
  return "";
}

function readContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = parseJsonObject(part);
      if (typeof record?.text === "string") return record.text;
      return record?.type === "tool_result" ? readContentText(record.content) : "";
    })
    .filter(Boolean)
    .join("\n");
}

async function waitForNewAutoCompactContext(input: {
  afterCount: number;
  event: "compact.auto.skipped" | "compact.auto.started";
  sessionId: string;
}): Promise<Record<string, unknown>> {
  let contexts: Record<string, unknown>[] = [];
  await browser.waitUntil(
    async () => {
      contexts = await readAutoCompactContexts(input.sessionId, input.event);
      return contexts.length > input.afterCount;
    },
    {
      timeout: 45_000,
      timeoutMsg: `没有找到新增的 ${input.event}: ${input.sessionId}`,
    },
  );
  const context = contexts.at(-1);
  if (!context) throw new Error(`${input.event} 等待完成后仍为空`);
  return context;
}

async function readAutoCompactContexts(
  sessionId: string,
  event: "compact.auto.skipped" | "compact.auto.started",
): Promise<Record<string, unknown>[]> {
  const logDir = process.env.ZCODE_LOG_DIR?.trim() || join(paths.storageRoot, "cli", "log");
  const files = await readdir(logDir).catch(() => []);
  const contexts: Record<string, unknown>[] = [];
  for (const file of files) {
    const content = await readFile(join(logDir, file), "utf-8").catch(() => "");
    for (const line of content.split("\n")) {
      const entry = parseJsonObject(line);
      if (entry?.event !== event || entry.sessionId !== sessionId) continue;
      const context = parseJsonObject(entry.context);
      if (context) contexts.push(context);
    }
  }
  return contexts;
}

function assertCommonDecision(
  decision: Record<string, unknown>,
  reason: string | undefined,
  scenario: SmokeScenario,
): void {
  expect(decision).toMatchObject({
    contextWindow: scenario.contextWindow,
    effectiveContextWindow: scenario.effectiveInputWindow,
    modelContextBudgetStrategy: "preflight-v1",
    threshold: scenario.threshold,
    thresholdPercent: 100,
    ...(reason ? { reason } : {}),
  });
  // E2E 归档会按字段名脱敏 outputReserveTokens；使用同一决策里的窗口差值
  // 验证 preserve 21K，避免测试为了取证而绕开生产日志脱敏。
  expect(
    readRequiredNumber(decision, "contextWindow") -
      readRequiredNumber(decision, "effectiveContextWindow"),
  ).toBe(21_000);
}

function readRequiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Output-token smoke decision 缺少数值 ${key}`);
  }
  return value;
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
