// TT11–TT13 token 预算提醒设置开关（docs/conversation-session-case-catalog.md「token 预算提醒」）。
// 规格见 apps/zcode-cli/docs/design/v2/loop/meta-user-context.md「Total-tokens reminder」。
// 开关只在创建或冷恢复 runtime 时读取：运行中的任务保持原值，新任务和冷恢复读最新值；冷恢复的 system
// 按快照原字节发送，倒数提醒按当前值收集。关闭后冷恢复打开时写下的会话由 core 测试和 TT09 覆盖。
// 断言读取上游请求体。
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_TOTAL_TOKENS_REMINDER_SWITCH,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  readSettings,
} from "#e2e/helpers/desktop-app";
import { getUpstreamRequestEvidence } from "#e2e/helpers/conversation-session-network";
import { ensureReadonlyToolFixtureFile } from "#e2e/helpers/conversation-session-readonly-tool";
import { armDraftRegenerationResendOnce } from "#e2e/helpers/draft-regeneration-resend";
import {
  prepareIncomingMessageCapability,
  switchIncomingMessageCapability,
} from "#e2e/helpers/incoming-message-capability";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

type Block = Record<string, unknown> & { type?: string };
type Message = { role: string; content: unknown };
type Request = { messages: Message[]; system?: unknown };

const TAG = "<total_tokens>";
const LINE = "<total_tokens>15000000 tokens left</total_tokens>";
// 关闭时默认 system 的动态段以 `# Memory, notes and feedback` 段结尾；打开时其后再跟预算行。
const SYSTEM_END = "work from the context, not intermediate files.";

describe("TT token 预算提醒设置开关", () => {
  before(async () => {
    await ensureReadonlyToolFixtureFile();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("TT11–TT13：打开后新任务生效，运行中切换不影响已有任务，冷恢复按快照与当前值", async function () {
    this.timeout(600_000);
    await prepareV4ConversationE2E({ skipProvider: true });

    // TT11：默认关闭；打开后完整重启，让之后的草稿在打开后创建（之前建好的草稿保持旧值，与 ToolSearch 相同）。
    // 新任务带预算行和倒数提醒。
    await openSettings();
    expect(await readSwitch()).toBe(false);
    expect((await readSettings()).totalTokensReminderEnabled).not.toBe(true);
    await setSwitch(true);
    await closeSettings();
    await prepareIncomingMessageCapability(false);
    await runTurn("E2E_TT_K1 Read the readonly fixture.", "TT_K1_DONE");
    const taskA = await idleSessionId("A 第一轮没有完成");
    const [k1, k2] = await requestsByFixture(["tt-k1", "tt-k2"]);
    expect(systemText(k1!).endsWith(`${SYSTEM_END}\n\n${LINE}`)).toBe(true);
    expect(messagesText(k1!)).toContain(LINE);
    // 工具批次后的倒数：15000000 - (1000 + 5)。
    expect(messagesText(k2!)).toContain("<total_tokens>14998995 tokens left</total_tokens>");

    // TT12：关闭开关。A 的 runtime 还在内存里，继续使用打开的值；新任务 B 读到关闭。
    await openSettings();
    await setSwitch(false);
    await closeSettings(taskA);
    await runTurn("E2E_TT_K3 Read it once more.", "TT_K3_DONE");
    await newTask();
    await runTurn("E2E_TT_K5 hello.", "TT_K5_DONE");
    const taskB = await idleSessionId("B 第一轮没有完成");
    const [k3, k4, k5] = await requestsByFixture(["tt-k3", "tt-k4", "tt-k5"]);
    expect(systemText(k3!)).toBe(systemText(k1!));
    // 新一轮以上一轮最后一次响应（1102）为起点；工具批次后 used = 2005 - 1102。
    expect(countTag(k3!)).toBe(3);
    expect(messagesText(k4!)).toContain("<total_tokens>14999097 tokens left</total_tokens>");
    expect(countTag(k4!)).toBe(4);
    expect(systemText(k5!).endsWith(SYSTEM_END)).toBe(true);
    expect(systemText(k5!)).not.toContain(TAG);
    expect(messagesText(k5!)).not.toContain(TAG);

    // TT13：打开开关后完整重启，B 冷恢复。system 按快照没有预算行，新一轮收集倒数提醒。
    await openSettings();
    await setSwitch(true);
    await closeSettings(taskB);
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await selectV4TaskById(taskB, 30_000);
    await waitForV4TimelineContaining("TT_K5_DONE");
    await runTurn("E2E_TT_K6 hello after restart.", "TT_K6_DONE");
    const [k6] = await requestsByFixture(["tt-k6"]);
    expect(systemText(k6!)).toBe(systemText(k5!));
    expect(messagesText(k6!)).toContain(LINE);
    expect(countTag(k6!)).toBe(1);
  });
});

async function newTask() {
  // 当前 pane 是有内容的 A，准备 helper 会从项目新建草稿；草稿在关闭开关之后创建。
  await prepareV4ConversationE2E({ skipProvider: true });
  await switchIncomingMessageCapability(false);
  // 切模型会让草稿换代；下一次发送遇到换代首发失败时按产品提示重发。
  armDraftRegenerationResendOnce();
}

async function runTurn(prompt: string, done: string) {
  await sendV4Prompt(prompt);
  await waitForV4TimelineContaining(done, 120_000);
  await idleSessionId(`${prompt.split(" ")[0]} 没有完成`);
}

async function idleSessionId(timeoutMsg: string): Promise<string> {
  const snapshot = await waitForV4Pane(
    (current) => Boolean(current.sessionId && current.sessionId !== "draft") && !current.canStop,
    timeoutMsg,
    120_000,
  );
  return snapshot.sessionId!;
}

async function openSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        (pageTestId) => Boolean(document.querySelector(`[data-testid="${pageTestId}"]`)),
        TID_SETTINGS_PAGE,
      ),
    { timeout: 15_000, timeoutMsg: "设置页没有打开" },
  );
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有行为与工具分区入口",
  });
  await browser.waitUntil(async () => (await readSwitch()) !== null, {
    timeout: 15_000,
    timeoutMsg: "行为与工具设置没有 token 预算提醒开关",
  });
}

async function closeSettings(expectedSessionId?: string) {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForV4Pane(
    (snapshot) =>
      expectedSessionId ? snapshot.sessionId === expectedSessionId : snapshot.sessionId !== null,
    expectedSessionId ? `返回工作区后没有恢复 Session ${expectedSessionId}` : "返回工作区失败",
    30_000,
  );
}

async function setSwitch(enabled: boolean) {
  if ((await readSwitch()) !== enabled) {
    await clickTestIdByDom(TID_SETTINGS_TOTAL_TOKENS_REMINDER_SWITCH, {
      timeout: 15_000,
      timeoutMsg: "token 预算提醒开关不可点击",
    });
  }
  await browser.waitUntil(
    async () =>
      (await readSwitch()) === enabled &&
      ((await readSettings()).totalTokensReminderEnabled === true) === enabled,
    { timeout: 15_000, timeoutMsg: `token 预算提醒设置没有保存为 ${String(enabled)}` },
  );
}

function readSwitch(): Promise<boolean | null> {
  return browser.execute((switchTestId) => {
    const control = document.querySelector<HTMLElement>(`[data-testid="${switchTestId}"]`);
    if (!control) return null;
    return (
      control.getAttribute("aria-checked") === "true" ||
      control.getAttribute("data-state") === "checked"
    );
  }, TID_SETTINGS_TOTAL_TOKENS_REMINDER_SWITCH);
}

/** 按 fixture id 取上游请求；每个 fixture 只匹配一次。 */
async function requestsByFixture(ids: string[]): Promise<Request[]> {
  const records = await getUpstreamRequestEvidence({});
  return ids.map((fixtureId) => {
    const record = records.find((item) => item.fixtureId === fixtureId);
    const request = record?.requestJson as Request | undefined;
    if (!request || !Array.isArray(request.messages)) throw new Error(`${fixtureId} 没有上游请求`);
    return request;
  });
}

function countTag(request: Request): number {
  return messagesText(request).split(TAG).length - 1;
}

function systemText(request: Request): string {
  if (Array.isArray(request.system)) {
    return (request.system as Block[]).map((block) => String(block.text ?? "")).join("\u0000");
  }
  return typeof request.system === "string" ? request.system : "";
}

/** messages 的全部文本，tool_result 内的块也算。 */
function messagesText(request: Request): string {
  return request.messages.map((message) => blocksText(message.content)).join("\n");
}

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .map((block) =>
      block.type === "tool_result" ? blocksText(block.content) : String(block.text ?? ""),
    )
    .join("");
}
