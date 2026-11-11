import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  readSettings,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  E2E_REPLY_TOKEN,
  assertVisibleV4UserMessagesNotContaining,
  clickV4Stop,
  getV4ConversationState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4ConversationState,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import { countUpstreamRequestsContaining } from "#e2e/helpers/conversation-session-network";
import {
  getQueueItems,
  waitForQueueContaining,
  waitForQueueOrderContaining,
} from "#e2e/helpers/conversation-session-queue";
import { listToolCallBlocks } from "#e2e/helpers/conversation-session-tool";
import { waitForToastContaining } from "#e2e/helpers/conversation-session-toast";
import { sel } from "#e2e/helpers/selectors";

const TEST_TIMEOUT_MS = 120000;
const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const COMPACT_QUEUED_TOAST_TEXTS = [
  "Compaction queued and will run in order.",
  "已加入队列，将按顺序压缩上下文。",
];

describe("会话区 Turn Steering E2E", () => {
  before(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await prepareV4ConversationE2E();
    // 原因：旧聚合 helper 隐式创建只读文件；V4 用例显式保留工具执行前置。
    await ensureReadonlyToolFixtureFile();
    await ensureQueueInteractionBehavior();
  });

  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("首轮工具调用中发送普通文本时进入未来队列并保留 tool block", async function () {
    this.timeout(TEST_TIMEOUT_MS);

    await startNewV4Draft();
    const runId = Date.now();
    const basePrompt = buildReadonlyToolPrompt(`E2E_TURN_STEER_TOOL_TEXT_${runId}`);
    const guidedMarker = `E2E_TURN_STEER_TEXT_AFTER_TOOL_${runId}`;
    const guidedPrompt = `E2E_SLOW_STREAM ${guidedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

    await sendV4Prompt(basePrompt);
    await waitForV4ComposerText("", "turn steer: 首轮工具 prompt 后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "turn steer: 首轮工具 prompt 没有进入 streaming",
      30000,
    );
    await waitForToolBlock();

    await sendV4Prompt(guidedPrompt);
    await waitForV4ComposerText("", "turn steer: 普通后续输入后输入框没有清空");

    const queue = await waitForQueueItemContaining(guidedMarker);
    expect(queue.kind).toBe("text");
    expect(await listToolCallBlocks()).not.toHaveLength(0);
  });

  it("首轮 running 中发送 /goal 时进入未来队列", async function () {
    this.timeout(TEST_TIMEOUT_MS);

    await startNewV4Draft();
    const runId = Date.now();
    const basePrompt = `E2E_SLOW_STREAM E2E_TURN_STEER_GOAL_BASE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const goalPrompt = `/goal E2E_SLOW_STREAM E2E_TURN_STEER_GOAL_${runId}: 观察当前会话，不修改文件。`;

    await sendV4Prompt(basePrompt);
    await waitForV4ComposerText("", "turn steer: goal base prompt 后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "turn steer: goal base prompt 没有进入 streaming",
      30000,
    );

    await sendV4Prompt(goalPrompt);
    await waitForV4ComposerText("", "turn steer: running /goal 后输入框没有清空");

    const queue = await waitForQueueItemContaining(`E2E_TURN_STEER_GOAL_${runId}`);
    expect(queue.kind).toBe("goal");
  });

  it("首轮 running 中交叉发送 text、/goal、/compact 时按统一 FIFO 入队", async function () {
    this.timeout(TEST_TIMEOUT_MS);

    await startNewV4Draft();
    const runId = Date.now();
    const basePrompt = `E2E_SLOW_STREAM E2E_TURN_STEER_MIXED_BASE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const textPrompt = `E2E_SLOW_STREAM E2E_TURN_STEER_MIXED_TEXT_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const goalPrompt = `/goal E2E_SLOW_STREAM E2E_TURN_STEER_MIXED_GOAL_${runId}: 观察当前会话，不修改文件。`;

    await sendV4Prompt(basePrompt);
    await waitForV4ComposerText("", "turn steer: mixed base prompt 后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "turn steer: mixed base prompt 没有进入 streaming",
      30000,
    );

    await sendV4Prompt(textPrompt);
    await waitForV4ComposerText("", "turn steer: mixed text 后输入框没有清空");
    let queue = await waitForQueueOrderContaining([`E2E_TURN_STEER_MIXED_TEXT_${runId}`]);
    expect(queue.map((item) => item.kind)).toEqual(["text"]);

    await sendV4Prompt(goalPrompt);
    await waitForV4ComposerText("", "turn steer: mixed /goal 后输入框没有清空");
    queue = await waitForQueueOrderContaining([
      `E2E_TURN_STEER_MIXED_TEXT_${runId}`,
      `E2E_TURN_STEER_MIXED_GOAL_${runId}`,
    ]);
    expect(queue.map((item) => item.kind)).toEqual(["text", "goal"]);

    const compactRequestsBefore = await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL);
    await sendV4Prompt("/compact");
    await waitForV4ComposerText("", "turn steer: mixed /compact 后输入框没有清空");
    await waitForToastContaining(
      COMPACT_QUEUED_TOAST_TEXTS,
      "turn steer: running /compact 没有弹出 queued toast",
    );
    queue = await waitForQueueOrderContaining([
      `E2E_TURN_STEER_MIXED_TEXT_${runId}`,
      `E2E_TURN_STEER_MIXED_GOAL_${runId}`,
      "/compact",
    ]);
    expect(queue.map((item) => item.kind)).toEqual(["text", "goal", "compact"]);
    await assertVisibleV4UserMessagesNotContaining("/compact");
    expect(await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL)).toBe(
      compactRequestsBefore,
    );
  });
});

async function waitForToolBlock() {
  await browser.waitUntil(async () => (await listToolCallBlocks()).length > 0, {
    timeout: 30000,
    timeoutMsg: "turn steer: 未观察到 tool block",
  });
}

async function ensureQueueInteractionBehavior() {
  if ((await readSettings()).zcodeInteractionBehavior === "queue") {
    return;
  }

  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "turn steer: 没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"), {
    timeout: 15000,
    timeoutMsg: "turn steer: 设置页没有出现通用分区入口",
  });

  // 修复原因：这个 spec 的文件名会命中 WDIO 的 guide seed，但 M01-M05
  // 锁定的是 queue 模式产品语义；转正后必须通过设置页切回 queue，
  // 避免把 guide/turn-steer 的 M06 行为混进普通 queue 断言。
  await clickInteractionBehaviorSelect();
  await clickInteractionBehaviorQueueOption();

  await browser.waitUntil(async () => (await readSettings()).zcodeInteractionBehavior === "queue", {
    timeout: 15000,
    timeoutMsg: "turn steer: 交互行为没有保存为 queue",
  });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "turn steer: 设置页返回按钮没有出现",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
}

async function clickInteractionBehaviorSelect() {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const triggers = Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]'));
        const trigger = triggers.find((element) =>
          ["引导", "Guide", "队列", "Queue"].some((label) =>
            (element.innerText || element.textContent || "").includes(label),
          ),
        );
        if (!trigger) {
          return false;
        }
        trigger.scrollIntoView({ block: "center", inline: "nearest" });
        trigger.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            buttons: 1,
            cancelable: true,
            pointerId: 1,
            pointerType: "mouse",
          }),
        );
        trigger.click();
        return true;
      }),
    {
      timeout: 15000,
      timeoutMsg: "turn steer: 没有找到交互行为 Select",
    },
  );
}

async function clickInteractionBehaviorQueueOption() {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const options = Array.from(
          document.querySelectorAll<HTMLElement>('[role="option"], [data-radix-collection-item]'),
        );
        const option = options.find((element) =>
          ["队列", "Queue"].includes((element.innerText || element.textContent || "").trim()),
        );
        if (!option) {
          return false;
        }
        option.scrollIntoView({ block: "center", inline: "nearest" });
        option.click();
        return true;
      }),
    {
      timeout: 15000,
      timeoutMsg: "turn steer: 没有找到交互行为 queue 选项",
    },
  );
}

async function waitForQueueItemContaining(text: string) {
  await waitForQueueContaining(text);
  const queue = await getQueueItems();
  const item = queue.find((candidate) => candidate.content.includes(text));
  if (!item) {
    throw new Error(`turn steer: 队列等待后仍找不到 ${text}; latest=${JSON.stringify(queue)}`);
  }
  return item;
}

async function stopIfBusy() {
  const snapshot = await getV4ConversationState().catch(() => null);
  if (snapshot?.state !== "streaming") {
    return;
  }
  await clickV4Stop().catch(() => undefined);
  await waitForV4ConversationState(
    (candidate) => candidate.state !== "streaming",
    "turn steer 清理阶段没有退出 streaming",
    30000,
  ).catch(() => undefined);
  await getQueueItems().catch(() => []);
}
