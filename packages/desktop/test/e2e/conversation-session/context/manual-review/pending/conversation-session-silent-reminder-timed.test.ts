// STR01–STR02 静默提醒按时间计时（docs/conversation-session-case-catalog.md「静默提醒（STR）」）。规格见
// apps/zcode-cli/docs/design/v2/loop/meta-user-context.md「Silent-turn reminder」。
// 断言读上游请求体：慢响应满 60 秒后的请求带一次提醒，冷恢复后按原位置原字节回放；快速连续的静默响应不带提醒。
import { clearAppData, waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";
import { getUpstreamRequestEvidence } from "#e2e/helpers/conversation-session-network";
import { reloadElectronSessionSafely } from "#e2e/helpers/e2e-electron-reload";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

type Request = { messages: unknown[]; system?: unknown };

const REMINDER =
  "The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell — a finding, a change of plan.";
const SLOW_MARKER = "E2E_SILENT_REMINDER_SLOW";
const SLOW_DONE = "E2E_SILENT_REMINDER_SLOW_DONE";
const COLD_MARKER = "E2E_SILENT_REMINDER_COLD_REPLAY";
const COLD_DONE = "E2E_SILENT_REMINDER_COLD_OK";
const FAST_MARKER = "E2E_SILENT_REMINDER_FAST";
const FAST_DONE = "E2E_SILENT_REMINDER_FAST_DONE";

describe("STR 静默提醒按时间计时", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("STR01：两次 31 秒的静默响应后，满 60 秒的请求带一次提醒；冷恢复后原位置原字节回放", async function () {
    this.timeout(360000);
    await prepareV4ConversationE2E();

    const runId = Date.now();
    await sendV4Prompt(`${SLOW_MARKER}_${runId}: inspect quietly with the slow fixture.`);
    const completed = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null &&
        snapshot.sessionId !== "draft" &&
        !snapshot.canStop &&
        snapshot.timelineText.includes(SLOW_DONE),
      "慢响应的一轮没有完成",
      180000,
    );
    const sessionId = completed.sessionId;
    if (!sessionId || sessionId === "draft") {
      throw new Error(`静默提醒 case 缺少真实 sessionId: ${sessionId ?? "null"}`);
    }

    // 第一次工具批次后约 31 秒、第二次之前不到 60 秒：没有提醒；第二次之后至少 62 秒：一次提醒。
    expect(reminderCount(await requestByFixture("silent-reminder-slow-1"))).toBe(0);
    expect(reminderCount(await requestByFixture("silent-reminder-slow-2"))).toBe(0);
    const live = await requestByFixture("silent-reminder-slow-3");
    expect(reminderCount(live)).toBe(1);

    // 完整重启 Electron、Host 与 CLI：提醒与它的位置来自持久化历史。
    await reloadElectronSessionSafely(browser);
    await waitForDefaultWorkspaceReady(60000);
    await selectV4TaskById(sessionId, 60000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
      `CLI cold restart 后没有恢复 session ${sessionId}`,
      60000,
    );
    await sendV4Prompt(`${COLD_MARKER}_${runId}: reply with exactly ${COLD_DONE}.`);
    await waitForV4AssistantMessageContaining(COLD_DONE, 60000);
    const cold = await requestByFixture("silent-reminder-cold-followup");
    // 新一轮的首个请求不收集静默提醒；重启前的提醒原样在前缀里。
    expect(reminderCount(cold)).toBe(1);
    expect(withoutCacheControl(cold.messages.slice(0, live.messages.length))).toEqual(
      withoutCacheControl(live.messages),
    );
  });

  it("STR02：六次快速连续的静默响应不带提醒", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();

    const runId = Date.now();
    await sendV4Prompt(`${FAST_MARKER}_${runId}: inspect quietly with the fast fixture.`);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(FAST_DONE),
      "快速静默响应的一轮没有完成",
      120000,
    );
    for (let step = 1; step <= 7; step++) {
      expect(reminderCount(await requestByFixture(`silent-reminder-fast-${step}`))).toBe(0);
    }
  });
});

async function requestByFixture(fixtureId: string): Promise<Request> {
  const evidence = (await getUpstreamRequestEvidence({})).filter(
    (record) => record.fixtureId === fixtureId,
  );
  expect(evidence).toHaveLength(1);
  return evidence[0]!.requestJson as Request;
}

function reminderCount(request: Request): number {
  // MCS 开时提醒是 system 消息，关时是 user 侧 <system-reminder>；两种都在 messages 里。
  return JSON.stringify(request.messages).split(JSON.stringify(REMINDER).slice(1, -1)).length - 1;
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, withoutCacheControl(item)]),
  );
}
