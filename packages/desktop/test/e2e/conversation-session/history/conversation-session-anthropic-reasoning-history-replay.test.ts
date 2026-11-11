import { readFile } from "node:fs/promises";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "#e2e/helpers/network-capture-proxy";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { E2E_NETWORK_CAPTURE_REDACTION_VALUE } from "#e2e/helpers/e2e-network-capture-redaction";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_SECONDARY_MODEL,
  ensureUpstreamModelForE2E,
  selectUpstreamModelById,
} from "#e2e/helpers/upstream-provider";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const FALLBACK_SEED = "E2E_AR_SIGNATURE_START_SEED";
const FALLBACK_THINKING = "E2E_AR_SIGNATURE_START_THINKING";
const FALLBACK_SIGNATURE = "e2e-ar-signature-from-start";
const FALLBACK_REPLY = "E2E_AR_SIGNATURE_START_REPLY";
const STANDARD_SEED = "E2E_AR_STANDARD_SIGNATURE_DELTA_SEED";
const STANDARD_THINKING = "E2E_AR_STANDARD_SIGNATURE_DELTA_THINKING";
const STANDARD_SIGNATURE = "e2e-ar-standard-signature-delta";
const STANDARD_REPLY = "E2E_AR_STANDARD_SIGNATURE_DELTA_REPLY";
const NATIVE_SEED = "E2E_AR_NATIVE_SIGNATURE_SEED";
const NATIVE_THINKING = "E2E_AR_NATIVE_SIGNATURE_THINKING";
const NATIVE_START_SIGNATURE = "e2e-ar-native-start-must-not-survive";
const NATIVE_SIGNATURE = "e2e-ar-native-signature";
const UNSIGNED_THINKING = "E2E_AR_UNSIGNED_THINKING";
const REDACTED_DATA = "E2E_AR_REDACTED_DATA";
const NATIVE_REPLY = "E2E_AR_NATIVE_SIGNATURE_REPLY";
const LIVE_REPLAY = "E2E_AR_LIVE_REPLAY";
const LIVE_REPLY = "E2E_AR_LIVE_REPLAY_OK";
const COLD_REPLAY = "E2E_AR_COLD_REPLAY";
const COLD_REPLY = "E2E_AR_COLD_REPLAY_OK";
const CROSS_MODEL = "E2E_AR_CROSS_MODEL";
const CROSS_MODEL_REPLY = "E2E_AR_CROSS_MODEL_OK";

const ORPHAN_SEED = "E2E_AR_ORPHAN_SEED";
const ORPHAN_THINKING = "E2E_AR_ORPHAN_UNSIGNED_THINKING";
const ORPHAN_FOLLOW = "E2E_AR_ORPHAN_FOLLOW";
const ORPHAN_REPLY = "E2E_AR_ORPHAN_OK";
const EMPTY_SEED = "E2E_AR_EMPTY_ENVELOPE_SEED";
const EMPTY_THINKING = "E2E_AR_EMPTY_ENVELOPE_SIGNED";
const EMPTY_SIGNATURE = "e2e-ar-empty-envelope-signature";
const EMPTY_FOLLOW = "E2E_AR_EMPTY_ENVELOPE_FOLLOW";
const EMPTY_REPLY = "E2E_AR_EMPTY_ENVELOPE_OK";
const WHITESPACE_SEED = "E2E_AR_WHITESPACE_SEED";
const WHITESPACE_THINKING = "E2E_AR_WHITESPACE_SIGNED";
const WHITESPACE_SIGNATURE = "e2e-ar-whitespace-signature";
const WHITESPACE_FOLLOW = "E2E_AR_WHITESPACE_FOLLOW";
const WHITESPACE_REPLY = "E2E_AR_WHITESPACE_OK";

const RETRY_SEED = "E2E_AR_RETRY_SEED";
const RETRY_SIGNED_THINKING = "E2E_AR_RETRY_SIGNED";
const RETRY_SIGNATURE = "e2e-ar-retry-signature";
const RETRY_UNSIGNED_THINKING = "E2E_AR_RETRY_UNSIGNED";
const RETRY_REDACTED_DATA = "E2E_AR_RETRY_REDACTED";
const RETRY_SEED_REPLY = "E2E_AR_RETRY_SEED_REPLY";
const HTTP_RETRY = "E2E_AR_HTTP_SIGNATURE_RETRY";
const HTTP_RETRY_REPLY = "E2E_AR_HTTP_SIGNATURE_RETRY_OK";
const RETRY_STAYS_STRIPPED = "E2E_AR_RETRY_STAYS_STRIPPED";
const RETRY_STAYS_STRIPPED_REPLY = "E2E_AR_RETRY_STAYS_STRIPPED_OK";
const RETRY_AFTER_RESTART = "E2E_AR_RETRY_AFTER_RESTART";
const RETRY_AFTER_RESTART_REPLY = "E2E_AR_RETRY_AFTER_RESTART_OK";
const SSE_RETRY = "E2E_AR_SSE_SIGNATURE_RETRY";
const SSE_RETRY_REPLY = "E2E_AR_SSE_SIGNATURE_RETRY_OK";
const UNRELATED_400 = "E2E_AR_UNRELATED_400";
const DOUBLE_400 = "E2E_AR_DOUBLE_SIGNATURE_400";
const VISIBLE_ERROR = "E2E_AR_VISIBLE_THEN_SIGNATURE_ERROR";
const VISIBLE_PARTIAL = "E2E_AR_VISIBLE_PARTIAL";
const UNSIGNED_SEED = "E2E_AR_UNSIGNED_ONLY_SEED";
const UNSIGNED_ONLY_THINKING = "E2E_AR_UNSIGNED_ONLY_THINKING";
const UNSIGNED_SEED_REPLY = "E2E_AR_UNSIGNED_ONLY_REPLY";
const NO_CHANGE_400 = "E2E_AR_NO_CHANGE_SIGNATURE_400";

describe("Anthropic Messages reasoning 历史回放与签名修复 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I70: 原生 delta 与 block_start 签名应贯穿多轮 live/cold replay，并在跨模型时精确清理", async function () {
    this.timeout(300_000);
    await prepareV4ConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await selectPrimaryModel();

    const runId = Date.now();
    await sendAndWaitForReply(`${FALLBACK_SEED}_${runId}`, FALLBACK_REPLY);

    const standardPrompt = `${STANDARD_SEED}_${runId}`;
    await sendAndWaitForReply(standardPrompt, STANDARD_REPLY);
    const standardRequest = (await waitForCompletedRequests(standardPrompt, 1))[0]!;
    expectRequestContains(standardRequest, [FALLBACK_THINKING, FALLBACK_SIGNATURE]);

    const nativePrompt = `${NATIVE_SEED}_${runId}`;
    await sendAndWaitForReply(nativePrompt, NATIVE_REPLY);
    const nativeRequest = (await waitForCompletedRequests(nativePrompt, 1))[0]!;
    expectRequestContains(nativeRequest, [
      FALLBACK_THINKING,
      FALLBACK_SIGNATURE,
      STANDARD_THINKING,
      STANDARD_SIGNATURE,
    ]);

    const livePrompt = `${LIVE_REPLAY}_${runId}`;
    await sendAndWaitForReply(livePrompt, LIVE_REPLY);
    const liveRequest = (await waitForCompletedRequests(livePrompt, 1))[0]!;
    expectRequestContains(liveRequest, [
      FALLBACK_THINKING,
      FALLBACK_SIGNATURE,
      STANDARD_THINKING,
      STANDARD_SIGNATURE,
      NATIVE_THINKING,
      NATIVE_SIGNATURE,
      UNSIGNED_THINKING,
      REDACTED_DATA,
    ]);
    expectRequestExcludes(liveRequest, [NATIVE_START_SIGNATURE]);

    const sessionId = await requireCurrentSessionId("signature replay 多轮没有绑定真实 session");
    await reloadAppAndRestoreV4Session(sessionId);

    const coldPrompt = `${COLD_REPLAY}_${runId}`;
    await sendAndWaitForReply(coldPrompt, COLD_REPLY);
    const coldRequest = (await waitForCompletedRequests(coldPrompt, 1))[0]!;
    expectRequestContains(coldRequest, [
      FALLBACK_THINKING,
      FALLBACK_SIGNATURE,
      STANDARD_THINKING,
      STANDARD_SIGNATURE,
      NATIVE_THINKING,
      NATIVE_SIGNATURE,
      UNSIGNED_THINKING,
      REDACTED_DATA,
    ]);
    expectRequestExcludes(coldRequest, [NATIVE_START_SIGNATURE]);

    await selectSecondaryModel();
    const crossModelPrompt = `${CROSS_MODEL}_${runId}`;
    await sendAndWaitForReply(crossModelPrompt, CROSS_MODEL_REPLY);
    const crossModelRequest = (await waitForCompletedRequests(crossModelPrompt, 1))[0]!;
    expect(readModel(crossModelRequest)).toBe(UPSTREAM_SECONDARY_MODEL);
    expectRequestContains(crossModelRequest, [
      FALLBACK_REPLY,
      STANDARD_REPLY,
      NATIVE_REPLY,
      LIVE_REPLY,
      UNSIGNED_THINKING,
    ]);
    expectRequestExcludes(crossModelRequest, [
      FALLBACK_THINKING,
      FALLBACK_SIGNATURE,
      STANDARD_THINKING,
      STANDARD_SIGNATURE,
      NATIVE_THINKING,
      NATIVE_SIGNATURE,
      NATIVE_START_SIGNATURE,
      REDACTED_DATA,
    ]);
  });

  it("I71: 没有可见内容的回复（孤立 reasoning、跨模型 signed-only、signed + whitespace）都被删除", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);

    await startNewV4Draft();
    await selectPrimaryModel();
    const runId = Date.now();
    const orphanSeedPrompt = `${ORPHAN_SEED}_${runId}`;
    await sendAndWaitForIdle(orphanSeedPrompt);
    const orphanFollowPrompt = `${ORPHAN_FOLLOW}_${runId}`;
    await sendAndWaitForReply(orphanFollowPrompt, ORPHAN_REPLY);
    const orphanRequest = (await waitForCompletedRequests(orphanFollowPrompt, 1))[0]!;
    expect(readModel(orphanRequest)).toBe(UPSTREAM_MODEL);
    expectRequestContains(orphanRequest, [orphanSeedPrompt, orphanFollowPrompt]);
    expectRequestExcludes(orphanRequest, [ORPHAN_THINKING]);
    expect(assistantMessages(orphanRequest)).toHaveLength(0);

    await startNewV4Draft();
    await selectPrimaryModel();
    const emptySeedPrompt = `${EMPTY_SEED}_${runId}`;
    await sendAndWaitForIdle(emptySeedPrompt);
    await selectSecondaryModel();
    const emptyFollowPrompt = `${EMPTY_FOLLOW}_${runId}`;
    await sendAndWaitForReply(emptyFollowPrompt, EMPTY_REPLY);
    const emptyRequest = (await waitForCompletedRequests(emptyFollowPrompt, 1))[0]!;
    expect(readModel(emptyRequest)).toBe(UPSTREAM_SECONDARY_MODEL);
    expectRequestExcludes(emptyRequest, [EMPTY_THINKING, EMPTY_SIGNATURE]);
    // core 投影第一步按存储内容删除只有思考的回复，不看目标模型；前后两条 user 都在请求里。
    expect(assistantMessages(emptyRequest)).toHaveLength(0);
    expectRequestContains(emptyRequest, [emptySeedPrompt, emptyFollowPrompt]);

    await startNewV4Draft();
    // 新草稿继承上一轮已选 secondary；用反向切换覆盖同一条跨模型清理链路，
    // 避免在未绑定 session 的 draft 上制造与本 case 无关的 model transition 竞争。
    await selectSecondaryModel();
    const whitespaceSeedPrompt = `${WHITESPACE_SEED}_${runId}`;
    await sendAndWaitForIdle(whitespaceSeedPrompt);
    await selectPrimaryModel();
    const whitespaceFollowPrompt = `${WHITESPACE_FOLLOW}_${runId}`;
    await sendAndWaitForReply(whitespaceFollowPrompt, WHITESPACE_REPLY);
    const whitespaceRequest = (await waitForCompletedRequests(whitespaceFollowPrompt, 1))[0]!;
    expect(readModel(whitespaceRequest)).toBe(UPSTREAM_MODEL);
    expectRequestExcludes(whitespaceRequest, [WHITESPACE_THINKING, WHITESPACE_SIGNATURE]);
    // 思考加空白同样没有可见内容，core 投影第一步删除；前后两条 user 都在请求里。
    expect(assistantMessages(whitespaceRequest)).toHaveLength(0);
    expectRequestContains(whitespaceRequest, [whitespaceSeedPrompt, whitespaceFollowPrompt]);
  });

  it("I72: signature repair 仅在安全条件成立时重试一次，修复结果在之后的请求和重启后保持", async function () {
    this.timeout(480_000);
    await prepareV4ConversationE2E();
    await selectPrimaryModel();

    // 修复会话要重启恢复：用准备好的夹具项目草稿（全局新建会落到独立目录，重启后不回到夹具项目）。
    const runId = Date.now();
    await sendAndWaitForReply(`${RETRY_SEED}_${runId}`, RETRY_SEED_REPLY);
    const repairedSessionId = await requireCurrentSessionId(
      "signature repair seed 没有绑定真实 session",
    );

    const httpRetryPrompt = `${HTTP_RETRY}_${runId}`;
    await sendAndWaitForReply(httpRetryPrompt, HTTP_RETRY_REPLY);
    const httpAttempts = await waitForCompletedRequests(httpRetryPrompt, 2);
    expectAttemptTrajectory(
      httpAttempts,
      [
        "anthropic-reasoning-http-signature-400",
        "anthropic-reasoning-http-signature-retry-success",
      ],
      [400, 200],
    );
    expectRequestContains(httpAttempts[0]!, [
      RETRY_SIGNED_THINKING,
      RETRY_SIGNATURE,
      RETRY_UNSIGNED_THINKING,
      RETRY_REDACTED_DATA,
    ]);
    expectRequestContains(httpAttempts[1]!, [RETRY_UNSIGNED_THINKING, RETRY_SEED_REPLY]);
    expectRequestExcludes(httpAttempts[1]!, [
      RETRY_SIGNED_THINKING,
      RETRY_SIGNATURE,
      RETRY_REDACTED_DATA,
    ]);

    // 修复成功后标记记在产出的 assistant 上：下一逻辑请求直接按修复后的前缀发送，只有一次物理请求。
    const staysStrippedPrompt = `${RETRY_STAYS_STRIPPED}_${runId}`;
    await sendAndWaitForReply(staysStrippedPrompt, RETRY_STAYS_STRIPPED_REPLY);
    const staysStrippedAttempts = await waitForStableRequestCount(staysStrippedPrompt, 1);
    expectAttemptTrajectory(
      staysStrippedAttempts,
      ["anthropic-reasoning-retry-stays-stripped"],
      [200],
    );
    expectStrippedRetryHistory(staysStrippedAttempts[0]!);

    // 完整重启后标记从持久化的 assistant 恢复，第一个请求同样不再发送被去掉的块。
    await reloadAppAndRestoreV4Session(repairedSessionId);
    const afterRestartPrompt = `${RETRY_AFTER_RESTART}_${runId}`;
    await sendAndWaitForReply(afterRestartPrompt, RETRY_AFTER_RESTART_REPLY);
    const afterRestartAttempts = await waitForStableRequestCount(afterRestartPrompt, 1);
    expectAttemptTrajectory(
      afterRestartAttempts,
      ["anthropic-reasoning-retry-stripped-after-restart"],
      [200],
    );
    expectStrippedRetryHistory(afterRestartAttempts[0]!);

    // 其余分支需要没修复过的签名历史，在新会话里重新播种；SSE 修复会记标记，放在最后。
    await startNewV4Draft();
    await selectPrimaryModel();
    await sendAndWaitForReply(`${RETRY_SEED}_branches_${runId}`, RETRY_SEED_REPLY);

    const unrelatedPrompt = `${UNRELATED_400}_${runId}`;
    await sendAndWaitForIdle(unrelatedPrompt);
    const unrelatedAttempts = await waitForStableRequestCount(unrelatedPrompt, 1);
    expectAttemptTrajectory(unrelatedAttempts, ["anthropic-reasoning-unrelated-400"], [400]);

    const doublePrompt = `${DOUBLE_400}_${runId}`;
    await sendAndWaitForIdle(doublePrompt);
    const doubleAttempts = await waitForStableRequestCount(doublePrompt, 2);
    expectAttemptTrajectory(
      doubleAttempts,
      [
        "anthropic-reasoning-double-signature-400-first",
        "anthropic-reasoning-double-signature-400-second",
      ],
      [400, 400],
    );

    const visiblePrompt = `${VISIBLE_ERROR}_${runId}`;
    await sendAndWaitForIdle(visiblePrompt);
    await waitForV4TimelineContaining(VISIBLE_PARTIAL, 30_000);
    const visibleAttempts = await waitForStableRequestCount(visiblePrompt, 1);
    expectAttemptTrajectory(
      visibleAttempts,
      ["anthropic-reasoning-visible-signature-error"],
      [200],
    );

    const sseRetryPrompt = `${SSE_RETRY}_${runId}`;
    await sendAndWaitForReply(sseRetryPrompt, SSE_RETRY_REPLY);
    const sseAttempts = await waitForCompletedRequests(sseRetryPrompt, 2);
    expectAttemptTrajectory(
      sseAttempts,
      ["anthropic-reasoning-sse-signature-400", "anthropic-reasoning-sse-signature-retry-success"],
      [200, 200],
    );
    expectRequestContains(sseAttempts[1]!, [RETRY_UNSIGNED_THINKING]);
    expectRequestExcludes(sseAttempts[1]!, [RETRY_SIGNATURE, RETRY_REDACTED_DATA]);

    // 修复原因：全局新建把会话放进独立目录，重启后主界面不回到夹具项目，恢复等待超时；
    // 要重启恢复的会话必须从夹具项目新建。
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await selectPrimaryModel();
    const unsignedSeedPrompt = `${UNSIGNED_SEED}_${runId}`;
    await sendAndWaitForReply(unsignedSeedPrompt, UNSIGNED_SEED_REPLY);
    const unsignedSessionId = await requireCurrentSessionId(
      "unsigned reasoning seed 没有绑定真实 session",
    );
    await reloadAppAndRestoreV4Session(unsignedSessionId);
    const noChangePrompt = `${NO_CHANGE_400}_${runId}`;
    await sendAndWaitForIdle(noChangePrompt);
    const noChangeAttempts = await waitForStableRequestCount(noChangePrompt, 1);
    expectRequestContains(noChangeAttempts[0]!, [UNSIGNED_SEED_REPLY, UNSIGNED_ONLY_THINKING]);
    expectAttemptTrajectory(
      noChangeAttempts,
      ["anthropic-reasoning-no-change-signature-400"],
      [400],
    );
  });
});

function expectStrippedRetryHistory(record: E2ENetworkCaptureRecord) {
  expectRequestContains(record, [RETRY_UNSIGNED_THINKING, RETRY_SEED_REPLY]);
  expectRequestExcludes(record, [RETRY_SIGNED_THINKING, RETRY_SIGNATURE, RETRY_REDACTED_DATA]);
}

async function sendAndWaitForReply(prompt: string, reply: string) {
  await sendV4Prompt(prompt);
  await waitForV4ComposerText("", `${prompt} 发送后输入框没有清空`);
  await waitForV4TimelineContaining(prompt, 30_000);
  await waitForV4AssistantMessageContaining(reply, 60_000);
  await waitForIdle(`${prompt} 完成后没有回到 idle`);
}

async function sendAndWaitForIdle(prompt: string) {
  await sendV4Prompt(prompt);
  await waitForV4ComposerText("", `${prompt} 发送后输入框没有清空`);
  await waitForV4TimelineContaining(prompt, 30_000);
  // Bug 根因：极快 fixture 可能让 canStop=true 的 running 窗口短到 E2E 观察不到；
  // 先以真实 provider attempt 完成为屏障，再判断 idle，避免把发送前 idle 误当成完成。
  await waitForCompletedRequests(prompt, 1);
  await waitForIdle(`${prompt} 没有收口`);
}

async function waitForIdle(timeoutMsg: string) {
  return waitForV4ConversationState(
    (snapshot) =>
      snapshot.state === "idle" &&
      snapshot.activeInputId === null &&
      snapshot.queueCount === 0 &&
      snapshot.sessionId !== null,
    timeoutMsg,
    90_000,
  );
}

async function requireCurrentSessionId(timeoutMsg: string) {
  const snapshot = await waitForV4Pane(
    (candidate) =>
      !candidate.canStop && candidate.sessionId !== null && candidate.sessionId !== "draft",
    timeoutMsg,
    30_000,
  );
  if (!snapshot.sessionId || snapshot.sessionId === "draft") {
    throw new Error(`${timeoutMsg}: ${JSON.stringify(snapshot)}`);
  }
  return snapshot.sessionId;
}

async function selectPrimaryModel() {
  await selectUpstreamModelById(UPSTREAM_MODEL, {
    includePlainModelFallback: false,
    providerId: UPSTREAM_PROVIDER_ID,
  });
}

async function selectSecondaryModel() {
  await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL, {
    includePlainModelFallback: false,
    providerId: UPSTREAM_PROVIDER_ID,
  });
}

async function reloadAppAndRestoreV4Session(sessionId: string) {
  await browser.reloadSession();
  await browser.waitUntil(
    async () => {
      try {
        const puppeteer = await browser.getPuppeteer();
        const rendererTarget = puppeteer
          .targets()
          .filter((target) => isRendererUrl(target.url()))
          .at(-1);
        const targetId = rendererTarget
          ? ((rendererTarget as unknown as { _targetId?: string })._targetId ?? null)
          : null;
        if (!targetId) return false;
        await browser.switchToWindow(targetId);
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: "reasoning cold replay 后没有找到 renderer target",
    },
  );
  await waitForDefaultWorkspaceReady(60_000);
  await selectV4TaskById(sessionId);
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
    `reasoning cold replay 没有恢复 session ${sessionId}`,
    60_000,
  );
}

function isRendererUrl(url: string) {
  try {
    return new URL(url).pathname.endsWith("/renderer/index.html");
  } catch {
    return false;
  }
}

async function waitForCompletedRequests(
  latestUserMarker: string,
  expectedCount: number,
): Promise<E2ENetworkCaptureRecord[]> {
  let matched: E2ENetworkCaptureRecord[] = [];
  await browser.waitUntil(
    async () => {
      matched = (await readCaptureArtifact()).filter(
        (record) =>
          isModelRequest(record) &&
          readLatestUserMessageText(record.requestJson).includes(latestUserMarker) &&
          record.status !== "pending" &&
          record.statusCode !== undefined,
      );
      return matched.length >= expectedCount;
    },
    {
      timeout: 90_000,
      timeoutMsg: `${latestUserMarker} 没有捕获到 ${expectedCount} 次完整 provider attempt`,
    },
  );
  return matched;
}

async function waitForStableRequestCount(latestUserMarker: string, expectedCount: number) {
  await waitForCompletedRequests(latestUserMarker, expectedCount);
  await browser.pause(750);
  const matched = (await readCaptureArtifact()).filter(
    (record) =>
      isModelRequest(record) &&
      readLatestUserMessageText(record.requestJson).includes(latestUserMarker),
  );
  expect(matched).toHaveLength(expectedCount);
  return matched;
}

async function readCaptureArtifact(): Promise<E2ENetworkCaptureRecord[]> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) {
    throw new Error("reasoning E2E 没有配置 E2E_PROVIDER_CAPTURE_PATH");
  }
  try {
    const artifact = JSON.parse(await readFile(capturePath, "utf-8")) as E2ENetworkCaptureArtifact;
    return artifact.records;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function isModelRequest(record: E2ENetworkCaptureRecord) {
  return (
    record.method === "POST" &&
    (record.path.includes("/messages") || record.path.includes("/chat/completions")) &&
    !JSON.stringify(record.requestJson).includes("Generate a concise title")
  );
}

function readLatestUserMessageText(value: unknown): string {
  const messages = readMessages(value);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return readContentText(message.content);
  }
  return "";
}

function readContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (record.type === "tool_result") return readContentText(record.content);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function readMessages(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const messages = (value as { messages?: unknown }).messages;
  return Array.isArray(messages)
    ? messages.filter((message): message is Record<string, unknown> =>
        Boolean(message && typeof message === "object" && !Array.isArray(message)),
      )
    : [];
}

function assistantMessages(record: E2ENetworkCaptureRecord) {
  return readMessages(record.requestJson).filter((message) => message.role === "assistant");
}

function readModel(record: E2ENetworkCaptureRecord) {
  if (!record.requestJson || typeof record.requestJson !== "object") return undefined;
  return (record.requestJson as { model?: unknown }).model;
}

function expectRequestContains(record: E2ENetworkCaptureRecord, expected: string[]) {
  const body = JSON.stringify(record.requestJson);
  for (const marker of expected) {
    // capture artifact 会在落盘前统一脱敏 signature；I70/I72 仍验证 reasoning 与签名字段
    // 同时存在，只能按脱敏占位符断言，不能再读取真实签名字符串。
    expect(body).toContain(
      isAnthropicReasoningSignature(marker) ? E2E_NETWORK_CAPTURE_REDACTION_VALUE : marker,
    );
  }
}

function isAnthropicReasoningSignature(value: string): boolean {
  return value.startsWith("e2e-ar-") && value.includes("signature");
}

function expectRequestExcludes(record: E2ENetworkCaptureRecord, excluded: string[]) {
  const body = JSON.stringify(record.requestJson);
  for (const marker of excluded) expect(body).not.toContain(marker);
}

function expectAttemptTrajectory(
  records: E2ENetworkCaptureRecord[],
  expectedFixtureIds: string[],
  expectedStatusCodes: number[],
) {
  expect(records.map((record) => record.replay?.fixtureId)).toEqual(expectedFixtureIds);
  expect(records.map((record) => record.statusCode)).toEqual(expectedStatusCodes);
  const requestIds = records.map((record) => record.requestHeaders["x-request-id"]);
  expect(
    requestIds.every((requestId) => typeof requestId === "string" && requestId.length > 0),
  ).toBe(true);
  expect(new Set(requestIds).size).toBe(records.length);
}
