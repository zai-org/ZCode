import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  getV4ConversationState,
  getV4Messages,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequestContaining } from "#e2e/helpers/conversation-session-network";

describe("会话区多 Session 并发 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("A running 时切到 B/C 应允许真实并发，inactive stream 不覆盖 active session", async function () {
    this.timeout(220000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const promptA = `E2E_SLOW_STREAM E2E_MULTI_SESSION_A_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(promptA);
    await waitForV4UserMessageContaining(`E2E_MULTI_SESSION_A_${runId}`);
    const sessionA = await waitForActiveStreamingSession("A 首轮没有进入 running");
    await waitForUpstreamRequestContaining(`E2E_MULTI_SESSION_A_${runId}`);

    await startNewV4Draft();
    await waitForV4ConversationState(
      (snapshot) => snapshot.sessionId !== sessionA,
      "点击新建任务后 active session 没有离开 A",
      30000,
    );

    const promptB = `E2E_SLOW_STREAM E2E_MULTI_SESSION_B_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(promptB);
    await waitForV4UserMessageContaining(`E2E_MULTI_SESSION_B_${runId}`);
    const sessionB = await waitForActiveStreamingSession("B 没有在 A running 时进入 running");
    expect(sessionB).not.toBe(sessionA);
    await waitForUpstreamRequestContaining(`E2E_MULTI_SESSION_B_${runId}`);

    // 修复原因：慢流式 fixture 在部分环境可能已经完成，不能把固定等待后的
    // 状态硬断言为 streaming；这里真正要确认的是 inactive A 不会切走 active B。
    await browser.pause(9000);
    let activeSnapshot = await getV4ConversationState();
    expect(activeSnapshot.sessionId).toBe(sessionB);
    expectSessionVisible(activeSnapshot, sessionB);
    let visibleText = (await getV4Messages()).map((message) => message.text).join("\n");
    expect(visibleText).toContain(`E2E_MULTI_SESSION_B_${runId}`);
    expect(visibleText).not.toContain(`E2E_MULTI_SESSION_A_${runId}`);

    await selectV4TaskById(sessionA);
    await waitForSessionVisible(sessionA, "切回 A 后没有看到 A 会话仍可见");
    visibleText = (await getV4Messages()).map((message) => message.text).join("\n");
    expect(visibleText).toContain(`E2E_MULTI_SESSION_A_${runId}`);
    expect(visibleText).not.toContain(`E2E_MULTI_SESSION_B_${runId}`);

    await selectV4TaskById(sessionB);
    await waitForSessionVisible(sessionB, "切回 B 后没有看到 B 会话仍可见");

    await startNewV4Draft();
    await waitForV4ConversationState(
      (snapshot) => snapshot.sessionId !== sessionB,
      "点击新建任务后 active session 没有离开 B",
      30000,
    );
    const promptC = `E2E_SLOW_STREAM E2E_MULTI_SESSION_C_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(promptC);
    await waitForV4UserMessageContaining(`E2E_MULTI_SESSION_C_${runId}`);
    const sessionC = await waitForActiveStreamingSession("C 没有在 A/B running 时进入 running");
    expect(new Set([sessionA, sessionB, sessionC]).size).toBe(3);
    await waitForUpstreamRequestContaining(`E2E_MULTI_SESSION_C_${runId}`);

    await assertSessionVisible(sessionA, "三会话检查时 A 会话不可见");
    await assertSessionVisible(sessionB, "三会话检查时 B 会话不可见");
    await assertSessionVisible(sessionC, "三会话检查时 C 会话不可见");

    activeSnapshot = await getV4ConversationState();
    expect(activeSnapshot.sessionId).toBe(sessionC);
    expectSessionVisible(activeSnapshot, sessionC);
    visibleText = (await getV4Messages()).map((message) => message.text).join("\n");
    expect(visibleText).toContain(`E2E_MULTI_SESSION_C_${runId}`);
    expect(visibleText).not.toContain(`E2E_MULTI_SESSION_A_${runId}`);
    expect(visibleText).not.toContain(`E2E_MULTI_SESSION_B_${runId}`);

    await stopSessionIfStreaming(sessionC);
    await stopSessionIfStreaming(sessionB);
    await stopSessionIfStreaming(sessionA);
  });
});

async function waitForActiveStreamingSession(timeoutMsg: string) {
  const snapshot = await waitForV4ConversationState(
    (current) => current.state === "streaming" && Boolean(current.sessionId),
    timeoutMsg,
    30000,
  );
  if (!snapshot.sessionId) {
    throw new Error(`${timeoutMsg}: sessionId missing`);
  }
  return snapshot.sessionId;
}

async function assertSessionVisible(sessionId: string, timeoutMsg: string) {
  await selectV4TaskById(sessionId);
  await waitForSessionVisible(sessionId, timeoutMsg);
}

async function waitForSessionVisible(sessionId: string, timeoutMsg: string) {
  return waitForV4ConversationState(
    (snapshot) => isSessionVisibleSnapshot(snapshot, sessionId),
    timeoutMsg,
    30000,
  );
}

function expectSessionVisible(
  snapshot: Awaited<ReturnType<typeof getV4ConversationState>>,
  sessionId: string,
) {
  expect(isSessionVisibleSnapshot(snapshot, sessionId)).toBe(true);
}

function isSessionVisibleSnapshot(
  snapshot: Awaited<ReturnType<typeof getV4ConversationState>>,
  sessionId: string,
) {
  return (
    snapshot.sessionId === sessionId &&
    (snapshot.state === "streaming" || snapshot.state === "idle")
  );
}

async function stopSessionIfStreaming(sessionId: string) {
  await selectV4TaskById(sessionId);
  const snapshot = await waitForV4ConversationState(
    (current) => current.sessionId === sessionId,
    `没有切到待停止 session: ${sessionId}`,
    30000,
  );
  if (snapshot.state !== "streaming") {
    return;
  }
  await clickV4Stop();
  await waitForV4ConversationState(
    (current) => current.sessionId === sessionId && current.state !== "streaming",
    `session stop 后没有退出 streaming: ${sessionId}`,
    30000,
  );
}
