// 计划模式列表操作：真实 Tab / Enter / 点击只修改 Composer，发送复用标准 Plan。
import { clearAppData, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import {
  clickV4Send,
  getV4ComposerAttachments,
  getV4ConfigProjection,
  getV4Messages,
  pasteV4ComposerImageAttachment,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4ComposerText,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import { selectUpstreamModel } from "#e2e/helpers/upstream-provider";
import {
  countUpstreamTitleRequestsContaining,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";

const SEED_PROMPT = "E2E_V4_PLAN_SHORTCUT_SEED 建立已有会话";
const TASK_ONE = "E2E_V4_PLAN_SHORTCUT_TASK_ONE 列出实现步骤";
const TASK_TWO = "E2E_V4_PLAN_SHORTCUT_TASK_TWO 普通文本";
const PLAN_OPTION = '[data-option-id="app-slash:plan"]';
let shellReady = false;

async function prepareCase() {
  // 首次测试之后默认项目已切换，复用 provider，避免重复等待启动项目。
  await prepareV4ConversationE2E({ skipShellReady: shellReady, skipProvider: shellReady });
  if (shellReady) await selectUpstreamModel();
  shellReady = true;
  if ((await getV4ConfigProjection()).planEnabled) {
    await $('[data-testid="v4-composer-plan-marker"] button').click();
  }
  await switchV4Mode("build");
}

async function enterSearch(text = "/plan") {
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, text, {
    timeout: 15000,
    timeoutMsg: "未写入 Plan 搜索词",
  });
  await $(PLAN_OPTION).waitForDisplayed({ timeout: 15000 });
  const optionText = await $(PLAN_OPTION).getText();
  expect(optionText).toMatch(/计划模式|Plan mode/);
  // 面板选项是「斜杠命令名 + 本地化描述」：label 固定为 /plan，描述说明它会开启计划模式。
  // 曾经断言过 not.toContain("/plan")（要求面板不再展示命令名），但 7c20a02c71 连同
  // AppSlashCommand.label 与 chat.slash.app.plan.label 文案一起回退了该行为，
  // 面板恢复展示斜杠命令名，断言随之过期。
  expect(optionText).toContain("/plan");
}

async function assertSelected(expectedText: string) {
  await waitForV4ComposerText(expectedText, "选中计划模式后正文不匹配");
  await browser.waitUntil(async () => (await getV4ConfigProjection()).planEnabled, {
    timeout: 15000,
    timeoutMsg: "标准 Plan 标记没有开启",
  });
  expect(await $(PLAN_OPTION).isExisting()).toBe(false);
  expect(
    await browser.execute(
      (id) => document.activeElement?.getAttribute("data-testid") === id,
      TID_V4_COMPOSER_INPUT,
    ),
  ).toBe(true);
}

async function establishSession() {
  await prepareCase();
  const titleCount = await countUpstreamTitleRequestsContaining(SEED_PROMPT);
  await sendV4Prompt(SEED_PROMPT);
  await waitForV4TimelineContaining("V4_PLAN_SHORTCUT_SEED_OK", 45000);
  await waitForV4Pane(
    (snapshot) =>
      !snapshot.canStop && snapshot.sessionId !== "draft" && snapshot.sessionId !== null,
    "种子会话未完成",
    45000,
  );
  await browser.waitUntil(
    async () => (await countUpstreamTitleRequestsContaining(SEED_PROMPT)) > titleCount,
    { timeout: 30000, timeoutMsg: "种子会话标题请求未完成" },
  );
}

async function setViewport(width: number | null) {
  await browser.electron.execute(async (electron, viewportWidth) => {
    const target = electron.BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    )!;
    if (!target.webContents.debugger.isAttached()) target.webContents.debugger.attach("1.3");
    await target.webContents.debugger.sendCommand(
      viewportWidth ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
      viewportWidth
        ? { width: viewportWidth, height: 860, deviceScaleFactor: 1, mobile: false }
        : {},
    );
  }, width);
}

describe("v4 Plan picker action", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("draft Tab 开启、Enter 重复选择幂等；Escape 不切模式，不产生消息", async function () {
    this.timeout(120000);
    await prepareCase();
    const before = await getUpstreamRequestRecordCount();
    const modeBefore = (await getV4ConfigProjection()).mode;
    await enterSearch();
    expect((await getV4ConfigProjection()).planEnabled).toBe(false);
    await browser.keys("Escape");
    expect((await getV4ConfigProjection()).planEnabled).toBe(false);
    await waitForV4ComposerText("/plan", "Escape 应保留输入");
    // 改变 token 后重新打开，不能把已取消的候选自动执行。
    await enterSearch("/pla");
    await browser.keys("Tab");
    await assertSelected("");
    await enterSearch("/PLAN");
    await browser.keys("Enter");
    await assertSelected("");
    expect((await getV4ConfigProjection()).mode).toBe(modeBefore);
    expect(await getV4Messages("user")).toHaveLength(0);
    expect(await getUpstreamRequestRecordCount()).toBe(before);
  });

  it("已有会话点击开启 Plan，保留正文和附件，另行发送走标准 Plan", async function () {
    this.timeout(180000);
    await establishSession();
    await pasteV4ComposerImageAttachment("e2e-plan-picker.png");
    await browser.waitUntil(
      async () => (await getV4ComposerAttachments())[0]?.uploadStatus === "ready",
      { timeout: 30000, timeoutMsg: "附件未 ready" },
    );
    const attachments = await getV4ComposerAttachments();
    const rows = await getV4Messages("user");
    const requests = await getUpstreamRequestRecordCount();
    await enterSearch(`${TASK_ONE} /plan`);
    await $(PLAN_OPTION).click();
    await assertSelected(`${TASK_ONE} `);
    expect(await getV4ComposerAttachments()).toEqual(attachments);
    expect(await getV4Messages("user")).toHaveLength(rows.length);
    expect(await getUpstreamRequestRecordCount()).toBe(requests);
    await clickV4Send();
    await waitForUpstreamRequest(
      {
        lastUserMessageIncludes: [TASK_ONE, "e2e-plan-picker.png"],
        lastUserMessageExcludes: ["/plan"],
        includes: ["Plan mode is active."],
      },
      "标准 Plan 请求没有保留正文与附件",
      60000,
    );
    await waitForV4TimelineContaining("V4_PLAN_SHORTCUT_TASK_ONE_OK", 60000);
  });

  it("窄屏 Enter 选择后可用标准关闭按钮退出；原始 /plan 文本不触发模式切换", async function () {
    this.timeout(180000);
    await establishSession();
    try {
      await setViewport(390);
      await browser.waitUntil(() => browser.execute(() => window.innerWidth === 390), {
        timeout: 5000,
        timeoutMsg: "手机尺寸 viewport 未生效",
      });
      await enterSearch();
      await browser.keys("Enter");
      await assertSelected("");
      await $('[data-testid="v4-composer-plan-marker"] button').click();
      expect((await getV4ConfigProjection()).planEnabled).toBe(false);
      const raw = `/plan ${TASK_TWO}`;
      await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, raw, {
        timeout: 15000,
        timeoutMsg: "未写入普通文本",
      });
      await browser.keys("Escape");
      await clickV4Send();
      await waitForUpstreamRequest(
        { lastUserMessageIncludes: [raw] },
        "发送时仍错误剥离 /plan",
        60000,
      );
      await waitForV4TimelineContaining("V4_PLAN_SHORTCUT_TASK_TWO_OK", 60000);
      expect((await getV4ConfigProjection()).planEnabled).toBe(false);
    } finally {
      await setViewport(null);
    }
  });
});
