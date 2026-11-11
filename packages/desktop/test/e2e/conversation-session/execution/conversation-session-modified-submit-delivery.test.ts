import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_COMPOSER_INPUT,
  TID_V4_STOP,
  testId,
} from "@zcode/shared/test-ids";
import { Key } from "webdriverio";
import {
  INCOMING_MESSAGE_MODES,
  prepareIncomingMessageCapability,
} from "#e2e/helpers/incoming-message-capability";
import { assertAppendOnly, assertPlainUserInput } from "#e2e/helpers/incoming-message-evidence";
import {
  TOTAL_TOKENS_BUDGET,
  totalTokensAfterLastAssistant,
  totalTokensReminders,
  withoutTotalTokensReminders,
} from "#e2e/helpers/total-tokens-evidence";
import {
  E2E_READONLY_TOOL_FILE_CONTENT,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  readSettings,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  countUpstreamRequestsContaining,
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
  expectNoUpstreamRequestForTextWithin,
  waitForUpstreamRequestContaining,
} from "#e2e/helpers/conversation-session-network";
import { getQueueItems, waitForQueueContaining } from "#e2e/helpers/conversation-session-queue";
import {
  clickV4Stop,
  getV4ConversationState,
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  startNewV4Draft,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { sel } from "#e2e/helpers/selectors";

const TEST_TIMEOUT_MS = 180000;
const primaryModifierKey = process.platform === "darwin" ? Key.Command : Key.Control;

describe("会话区修饰键单条 delivery E2E", () => {
  before(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await prepareV4ConversationE2E();
    expect((await readSettings()).zcodeInteractionBehavior).toBe("queue");
  });

  beforeEach(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await startNewV4Draft();
  });

  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  for (const { label, mcs } of INCOMING_MESSAGE_MODES) {
    it(`M06k ${label}：running 且尚无输出时 Cmd/Ctrl+Enter 直接抢占，不经过 QueueItem`, async function () {
      this.timeout(TEST_TIMEOUT_MS);
      await prepareIncomingMessageCapability(mcs, "queue");
      const runId = Date.now();
      const baseMarker = `E2E_MODIFIED_KEY_BASE_${runId}`;
      await startPreOutputTurn(baseMarker);
      const marker = `E2E_MODIFIED_KEY_SELECTED_${runId}`;
      await setV4ComposerText(marker);

      await submitWithModifiedEnter();

      await waitForV4ComposerText("", "pre-output 快捷键提交后 composer 没有立即清空", 3000);
      expect((await getQueueItems()).some((item) => item.content.includes(marker))).toBe(false);
      await waitForUpstreamRequestContaining(marker, 45000);
      await waitForV4UserMessageContaining(marker);
      expect((await getQueueItems()).some((item) => item.content.includes(marker))).toBe(false);
      expect(await countUpstreamRequestsContaining(marker)).toBe(1);
      // 被抢占的 base prompt 还没有输出：新消息仍排在它之后，按人类输入的时间顺序。
      const [evidence] = await getUpstreamRequestEvidence({
        includes: [marker],
        excludes: ["Generate a concise title"],
      });
      const wire = JSON.stringify((evidence!.requestJson as { messages: unknown[] }).messages);
      expect(wire.indexOf(baseMarker)).toBeGreaterThanOrEqual(0);
      expect(wire.indexOf(marker)).toBeGreaterThan(wire.indexOf(baseMarker));
    });
  }

  for (const { label, mcs } of INCOMING_MESSAGE_MODES) {
    it(`M06k ${label}：工具结果后 Cmd/Ctrl+Enter 抢占，新消息是普通用户文本，已发出的内容只多出新一轮的预算提醒`, async function () {
      this.timeout(TEST_TIMEOUT_MS);
      await prepareIncomingMessageCapability(mcs, "queue");
      await ensureReadonlyToolFixtureFile();
      const runId = Date.now();
      const baseMarker = `E2E_MODIFIED_TOOL_BASE_${runId}`;
      const marker = `E2E_MODIFIED_TOOL_SELECTED_${runId}`;
      await sendV4Prompt(`${baseMarker}: Read the readonly fixture and keep working.`);
      await waitForUpstreamRequest(
        { includes: [baseMarker, E2E_READONLY_TOOL_FILE_CONTENT] },
        "抢占前没有完整 Read 结果",
        30000,
      );
      await waitForV4ConversationState(
        (snapshot) => snapshot.state === "streaming",
        "Read 后没有保持 running",
        15000,
      );
      await setV4ComposerText(marker);
      await submitWithModifiedEnter();
      await waitForV4ComposerText("", "立即发送未清空 composer", 3000);
      await waitForUpstreamRequestContaining(marker, 45000);
      await waitForV4UserMessageContaining(marker);
      const evidence = await getUpstreamRequestEvidence({
        includes: [marker],
        excludes: ["Generate a concise title"],
      });
      expect(evidence).toHaveLength(1);
      const wire = await assertPlainUserInput(evidence[0]!.requestJson, {
        body: marker,
        evidenceLabel: `send-now-tool-${label}`,
      });
      expect(JSON.stringify(wire.messages.slice(0, wire.index + 1))).toContain(
        '"type":"tool_result"',
      );
      const [heldRequest] = await getUpstreamRequestEvidence({
        includes: [baseMarker, E2E_READONLY_TOOL_FILE_CONTENT],
        excludes: [marker, "Generate a concise title"],
      });
      expect(heldRequest).toBeDefined();
      // 新一轮的预算提醒按投影规则落在被抢占请求的末尾：MCS 关并进同一个 tool_result，
      // MCS 开与原提醒合进同一条 system 消息（meta-user-context.md「Total-tokens reminder」）。
      // 只有这一处会变；去掉预算提醒后，被抢占请求已发出的内容原样保留，新请求只在末尾追加。
      expect(totalTokensAfterLastAssistant(evidence[0]!.requestJson)).toEqual([
        TOTAL_TOKENS_BUDGET - 144,
        TOTAL_TOKENS_BUDGET,
      ]);
      // 已发出的提醒数值也不变：新请求的提醒序列是被抢占请求的序列加上新一轮这一条。
      expect(totalTokensReminders(evidence[0]!.requestJson).map((item) => item.value)).toEqual([
        ...totalTokensReminders(heldRequest!.requestJson).map((item) => item.value),
        TOTAL_TOKENS_BUDGET,
      ]);
      assertAppendOnly(
        withoutTotalTokensReminders(heldRequest!.requestJson),
        withoutTotalTokensReminders(evidence[0]!.requestJson),
      );
      expect((await getQueueItems()).some((item) => item.content.includes(marker))).toBe(false);
      const userRows = (await getV4Messages("user")).filter((message) =>
        message.text.includes(marker),
      );
      expect(userRows).toHaveLength(1);
      expect(
        await $(`[data-row-id="${userRows[0]!.id}"] [data-v4-user-input-bubble]`).getText(),
      ).toBe(marker);
    });
  }

  it("M06n：guide running 下 Cmd/Ctrl+Enter 只反向进入 future queue", async () => {
    // Bug 原因：beforeEach 的全局新建按当前导航决定 cwd，单独运行时落在独立目录；
    // 设置页返回后等待夹具项目就会超时（“主界面没有切到工作区”）。先回到夹具项目草稿。
    await prepareV4ConversationE2E();
    await setInteractionBehavior("guide");
    await startNewV4Draft();
    const runId = Date.now();
    await startPreOutputTurn(`E2E_MODIFIED_GUIDE_BASE_${runId}`);
    const marker = `E2E_MODIFIED_GUIDE_QUEUE_${runId}`;
    await setV4ComposerText(marker);

    await submitWithModifiedEnter();

    await waitForV4ComposerText("", "guide 反向入队后 composer 没有立即清空", 3000);
    await waitForQueueContaining(marker);
    expect((await getQueueItems()).filter((item) => item.content.includes(marker))).toHaveLength(1);
    await expectNoUpstreamRequestForTextWithin(marker, 1500);
    expect((await readSettings()).zcodeInteractionBehavior).toBe("guide");
  });
});

async function submitWithModifiedEnter() {
  // Lexical 是 contenteditable；通用 DOM click helper 不会建立真实 WebDriver 键盘焦点，
  // 会让 Cmd/Ctrl+Enter 发到旧 activeElement，形成“产品未清空”的假失败。
  await $(sel(TID_V4_COMPOSER_INPUT)).click();
  // 使用 trusted W3C key action，确保 Enter 触发时平台主修饰键仍处于按下状态。
  await browser
    .action("key")
    .down(primaryModifierKey)
    .down(Key.Enter)
    .up(Key.Enter)
    .up(primaryModifierKey)
    .perform();
}

async function startPreOutputTurn(marker: string) {
  await sendV4Prompt(`E2E_HOLD_STREAM ${marker}`);
  await waitForUpstreamRequestContaining(marker, 30000);
  await waitForV4ConversationState(
    (snapshot) => snapshot.state === "streaming",
    `基础 turn 没有进入 pre-output running 窗口: ${marker}`,
    15000,
  );
  await $(sel(TID_V4_STOP)).waitForDisplayed({
    timeout: 15000,
    timeoutMsg: `基础 turn 已 streaming 但 composer 尚未进入可抢占状态: ${marker}`,
  });
}

async function setInteractionBehavior(behavior: "queue" | "guide") {
  if ((await readSettings()).zcodeInteractionBehavior === behavior) return;
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"));
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const trigger = Array.from(
          document.querySelectorAll<HTMLElement>('[role="combobox"]'),
        ).find((element) =>
          ["引导", "Guide", "队列", "Queue"].some((label) => element.innerText.includes(label)),
        );
        if (!trigger) return false;
        trigger.click();
        return true;
      }),
    { timeout: 15000, timeoutMsg: "没有找到交互行为 Select" },
  );
  await browser.waitUntil(
    async () =>
      browser.execute(
        (labels) => {
          const option = Array.from(
            document.querySelectorAll<HTMLElement>('[role="option"], [data-radix-collection-item]'),
          ).find((element) => labels.includes(element.innerText.trim()));
          if (!option) return false;
          option.click();
          return true;
        },
        behavior === "guide" ? ["引导", "Guide"] : ["队列", "Queue"],
      ),
    { timeout: 15000, timeoutMsg: `没有找到交互行为 ${behavior} 选项` },
  );
  await browser.waitUntil(
    async () => (await readSettings()).zcodeInteractionBehavior === behavior,
    {
      timeout: 15000,
      timeoutMsg: `交互行为没有保存为 ${behavior}`,
    },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
}

async function stopIfBusy() {
  const snapshot = await getV4ConversationState().catch(() => null);
  if (snapshot?.state !== "streaming") return;
  await clickV4Stop().catch(() => undefined);
  await waitForV4ConversationState(
    (state) => state.state !== "streaming",
    "清理修饰键 delivery case 时会话没有停止",
    30000,
  ).catch(() => undefined);
}
