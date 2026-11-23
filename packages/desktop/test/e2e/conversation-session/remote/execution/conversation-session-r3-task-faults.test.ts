import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TID_V4_RETRY } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestRecordCount,
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  getV4ConversationState,
  getV4Messages,
  sendV4Prompt,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4Pane,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_TASK_FAULTS";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-task-faults");

async function readVisibleErrorText(): Promise<string> {
  return browser.execute(() => {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="alert"], [data-testid*="error"], [data-error-indicator="true"]',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    return candidates
      .map((element) => element.innerText.trim())
      .filter(Boolean)
      .join(" | ")
      .slice(0, 600);
  });
}

async function clickRetryIfPresent(): Promise<boolean> {
  return browser.execute((retryTestId) => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>(`[data-testid="${retryTestId}"]`),
    ).find((item) => item.getClientRects().length && !item.disabled);
    if (!button) return false;
    button.click();
    return true;
  }, TID_V4_RETRY);
}

describe(`${CASE_MARKER}: 远端模型 429 与流中断的错误呈现、输入保留与重试恢复`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "task-faults.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-TASK-08 远端请求 429 / truncated stream：明确错误、不假 completed 不永久 running、保留输入与历史、重试后恢复", async function () {
    this.timeout(30 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, {
      apiType: "anthropic-messages",
      tunnelUsername: "tunnel",
    });
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const historyBefore = (await getV4Messages()).length;

    // 429 必须真实注入并核对网络结果；不能用 401 代替限流覆盖。
    const rateLimitStart = await getUpstreamRequestRecordCount();
    const rateLimitMarker = `${CASE_MARKER}_HTTP_429`;
    await sendV4PromptAndWaitAccepted(
      `${rateLimitMarker} 请回复`,
      rateLimitMarker,
      `${CASE_MARKER}: 限流回合未被接受`,
    );
    const rateLimitQuery = {
      lastUserMessageIncludes: [rateLimitMarker],
      excludes: ["Generate a concise title"],
    };
    await waitForUpstreamRequest(rateLimitQuery, `${CASE_MARKER}: 限流请求未到达`, 60_000, {
      afterIndex: rateLimitStart - 1,
    });
    let recoveredAutomatically = false;
    await browser.waitUntil(
      async () => {
        recoveredAutomatically = (await getV4Messages("assistant")).some((message) =>
          message.text.includes("R3_FAULTS_429_RECOVERED"),
        );
        return (
          recoveredAutomatically ||
          ((await getV4ConversationState()).state === "idle" &&
            /429|限流|rate.?limit/iu.test(await readVisibleErrorText()))
        );
      },
      { timeout: 90_000, timeoutMsg: `${CASE_MARKER}: 429 既没有恢复也没有可见错误` },
    );
    if (!recoveredAutomatically) {
      const retried429 = await clickRetryIfPresent();
      if (!retried429)
        await sendV4PromptAndWaitAccepted(
          `${rateLimitMarker} 请回复`,
          rateLimitMarker,
          `${CASE_MARKER}: 限流后重发未被接受`,
        );
      facts.rateLimitRecovery = retried429 ? "ui-retry" : "explicit-resend";
    } else {
      facts.rateLimitRecovery = "agent-auto-retry";
    }
    await waitForV4AssistantMessageContaining("R3_FAULTS_429_RECOVERED", 90_000);
    await waitForV4ConversationState(
      (state) => state.taskId === taskA.taskId && state.state === "idle",
      `${CASE_MARKER}: 限流恢复没有收口`,
      60_000,
    );
    const rateLimitEvidence = await getUpstreamRequestEvidence(rateLimitQuery, {
      afterIndex: rateLimitStart - 1,
    });
    expect(rateLimitEvidence.map((record) => record.statusCode)).toEqual([429, 200]);
    expect(rateLimitEvidence.map((record) => record.fixtureId)).toEqual([
      "r3-faults-http-429-once",
      "r3-faults-http-429-recover",
    ]);
    facts.http429 = rateLimitEvidence.map(({ fixtureId, statusCode, status }) => ({
      fixtureId,
      statusCode,
      status,
    }));

    // 1. 401 鉴权错误（不可自动重试）：错误明确、状态回到非 running、用户输入与历史保留。
    //    （429 在首轮实测中被 Agent 的模型重试策略自动重试并恢复，属合法行为，记录于 facts。）
    const rateStart = await getUpstreamRequestRecordCount();
    const ratePrompt = `${CASE_MARKER}_RATE 请回复`;
    await sendV4PromptAndWaitAccepted(
      ratePrompt,
      `${CASE_MARKER}_RATE`,
      `${CASE_MARKER}: 鉴权失败回合未被接受`,
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_RATE`] },
      `${CASE_MARKER}: 429 请求没有到达回放`,
      60_000,
      { afterIndex: rateStart - 1 },
    );
    await waitForV4Pane((s) => !s.canStop, `${CASE_MARKER}: 429 后仍显示 running`, 90_000);
    await browser.waitUntil(async () => /鉴权|认证|401|auth/iu.test(await readVisibleErrorText()), {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 401 没有显示真实鉴权错误`,
    });
    const rateState = await getV4ConversationState();
    const rateError = await readVisibleErrorText();
    facts.rateLimit = {
      state: rateState.state,
      runtimeStatus: rateState.runtimeStatus,
      visibleError: rateError,
    };
    expect(rateState.state).not.toBe("streaming");
    await waitForV4UserMessageContaining(`${CASE_MARKER}_RATE`);
    expect((await getV4Messages()).length).toBeGreaterThanOrEqual(historyBefore + 1);
    const timeline = await browser.execute(() => document.body?.innerText ?? "");
    expect(timeline).not.toContain("R3_FAULTS_RATE_RECOVERED");
    expect(
      rateError.length +
        (timeline.match(/鉴权|认证|401|失败|错误|error|unauthorized/iu)?.length ?? 0),
    ).toBeGreaterThan(0);

    // 重试：优先用 UI 的重试入口，否则重新发送同一输入；第二次命中恢复 fixture。
    const retryStart = await getUpstreamRequestRecordCount();
    const retried = await clickRetryIfPresent();
    facts.rateRetryVia = retried ? "v4-retry" : "resend";
    if (!retried) await sendV4Prompt(ratePrompt);
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_RATE`] },
      `${CASE_MARKER}: 重试请求没有到达回放`,
      60_000,
      { afterIndex: retryStart - 1 },
    );
    await waitForV4AssistantMessageContaining("R3_FAULTS_RATE_RECOVERED", 90_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: 重试后没有回到 idle`,
      60_000,
    );

    // 2. truncated stream：部分文本后连接被销毁，不能假 completed 或永久 running。
    const truncStart = await getUpstreamRequestRecordCount();
    const truncPrompt = `${CASE_MARKER}_TRUNC 请回复`;
    await sendV4PromptAndWaitAccepted(
      truncPrompt,
      `${CASE_MARKER}_TRUNC`,
      `${CASE_MARKER}: 截断流回合未被接受`,
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_TRUNC`] },
      `${CASE_MARKER}: truncated 请求没有到达回放`,
      60_000,
      { afterIndex: truncStart - 1 },
    );
    await waitForV4AssistantMessageContaining("R3_FAULTS_TRUNC_PARTIAL", 60_000);
    await waitForV4Pane(
      (s) => !s.canStop,
      `${CASE_MARKER}: truncated stream 后仍显示 running`,
      120_000,
    );
    const truncQuery = {
      lastUserMessageIncludes: [`${CASE_MARKER}_TRUNC`],
      excludes: ["Generate a concise title"],
    };
    await browser.waitUntil(
      async () =>
        (await getUpstreamRequestEvidence(truncQuery, { afterIndex: truncStart - 1 })).some(
          (record) => record.fixtureId === "r3-faults-truncated-once" && record.status === "error",
        ),
      {
        timeout: 10_000,
        timeoutMsg: `${CASE_MARKER}: 回放没有真实销毁响应流，不能据此判断业务中断行为`,
      },
    );
    facts.truncatedInjection = (
      await getUpstreamRequestEvidence(truncQuery, { afterIndex: truncStart - 1 })
    ).map(({ fixtureId, status, statusCode }) => ({ fixtureId, status, statusCode }));
    facts.truncatedStateBeforeRecoveryCheck = await getV4ConversationState();
    await browser.waitUntil(
      async () => {
        const recovered = (await getV4Messages("assistant")).some((message) =>
          message.text.includes("R3_FAULTS_TRUNC_RECOVERED"),
        );
        return (
          recovered ||
          /中断|截断|interrupt|truncat|失败|错误|error|重试|retry/iu.test(
            await readVisibleErrorText(),
          )
        );
      },
      {
        timeout: 30_000,
        timeoutMsg: `${CASE_MARKER}: 截断流未恢复且没有真实错误，不能假 completed`,
      },
    );
    const truncState = await getV4ConversationState();
    const truncError = await readVisibleErrorText();
    const truncTimeline = await browser.execute(() => document.body?.innerText ?? "");
    facts.truncated = {
      state: truncState.state,
      runtimeStatus: truncState.runtimeStatus,
      visibleError: truncError,
      partialTextShown: truncTimeline.includes("R3_FAULTS_TRUNC_PARTIAL"),
      recoveredTextShownBeforeRetry: truncTimeline.includes("R3_FAULTS_TRUNC_RECOVERED"),
    };
    await waitForV4UserMessageContaining(`${CASE_MARKER}_TRUNC`);
    // truncated stream 可能被 Agent 网络重试自动恢复（合法），也可能停在明确错误等待用户重试；两种都记录。
    if (!truncTimeline.includes("R3_FAULTS_TRUNC_RECOVERED")) {
      expect(
        truncError.length +
          (truncTimeline.match(/中断|interrupt|失败|错误|error|重试|retry/iu)?.length ?? 0),
      ).toBeGreaterThan(0);
      const retry2Start = await getUpstreamRequestRecordCount();
      const retried2 = await clickRetryIfPresent();
      facts.truncRetryVia = retried2 ? "v4-retry" : "resend";
      if (!retried2) await sendV4Prompt(truncPrompt);
      await waitForUpstreamRequest(
        { lastUserMessageIncludes: [`${CASE_MARKER}_TRUNC`] },
        `${CASE_MARKER}: truncated 重试没有到达回放`,
        60_000,
        { afterIndex: retry2Start - 1 },
      );
    } else {
      facts.truncRetryVia = "agent-auto-retry";
    }
    await waitForV4AssistantMessageContaining("R3_FAULTS_TRUNC_RECOVERED", 90_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: truncated 重试后没有回到 idle`,
      60_000,
    );
    // 历史保留：首发、429 输入、truncated 输入都仍在同一 task。
    const userMessages = (await getV4Messages("user")).map((message) => message.text ?? "");
    facts.userMessages = userMessages.map((text) => text.slice(0, 40));
    expect(userMessages.some((text) => text.includes(taskA.firstPrompt))).toBe(true);
    expect(userMessages.some((text) => text.includes(`${CASE_MARKER}_RATE`))).toBe(true);
    expect(userMessages.some((text) => text.includes(`${CASE_MARKER}_TRUNC`))).toBe(true);
  });
});
