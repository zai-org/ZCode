import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import {
  approveV4Permission,
  getV4ComposerBackgroundWorkCounts,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  getLatestUpstreamToolResultByToolCallId,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";

// 用户从 GUI 停止一次在跑的 run（docs/dynamic-workflow/presentation.md「The run card」「The run pane」
// 「The sidebar run line」、docs/dynamic-workflow/transcript-and-notifications.md「The notification row」
// 「What the model reads」）：卡、侧板、侧栏运行行一起落到「已停止 · 你停止的」，主代理收到
// stop-reason=user 的通知，对话还能接着走。
//
// case-local 回放只决定主模型的选择；真实 Skill、工作流编译、审批、run 引擎、停止与通知走产品链路。
// 脚本零 agent，靠 `world.run("sleep", …)` 停在 running（沙箱里没有 setTimeout），sleep 远长于本用例。
const RUN_DIGEST = `[data-testid^="${TID_CHAT_WORKFLOW_RUN_DIGEST}"]`;
const RUN_NAME = "E2E 停止工作流";

let runId = "";

describe("动态工作流 · 停止在跑的 run", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWX-01 从 run 卡停止：卡、侧板、侧栏运行行都落到「已停止 · 你停止的」，没有一处还显示运行中", async function () {
    this.timeout(240000);
    await sendV4Prompt("E2E_DWX_START 使用工作流跑一个长时间等待的任务。");
    await approveV4Permission();
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwx_create"))?.isError === false,
      { timeout: 60_000, timeoutMsg: "CreateWorkflow 未执行成功" },
    );
    // 启动轮先收尾，停止通知才会唤起自己的一轮，而不是被并进启动轮。
    await waitForV4AssistantMessageContaining("E2E_DWX_STARTED", 60000);
    await waitForV4Pane((pane) => !pane.canStop, "启动轮没有结束", 30000);

    // 每次都按 DOM 现读：工具行从流式态换成定稿态时卡会重挂，缓存的元素引用会过期。
    let digests: DigestSnapshot[] = [];
    try {
      await browser.waitUntil(
        async () => {
          digests = await readDigests();
          return digests.some((item) => item.status === "running");
        },
        { timeout: 60000 },
      );
    } catch {
      throw new Error(`run 卡没有进入 running; digests=${JSON.stringify(digests)}`);
    }
    runId = digests.find((item) => item.status === "running")?.runId ?? "";
    expect(runId).not.toBe("");
    const digest = await $(`${RUN_DIGEST}[data-workflow-run-id="${runId}"]`);
    await expect(digest.$('[data-testid="workflow-card-kind"]')).toHaveText(
      expect.stringContaining("工作流运行中"),
    );

    // 停之前三处都在说「运行中」：侧栏运行行、composer 徽标、侧板。
    const runLine = `[data-workflow-run-line][data-run-id="${runId}"]`;
    await browser.waitUntil(
      async () => (await $(runLine).getAttribute("data-run-status")) === "running",
      { timeout: 60000, timeoutMsg: "侧栏没有长出 running 的运行行" },
    );
    // 运行行写当前阶段名（「The sidebar run line」）。阶段标记可能比 run-started 晚一帧到，所以等它；
    // 不在这里断言，先把停止链路走完，再在用例末尾判定，避免一个文案问题挡住停止的证据。
    let runLineText = "";
    let cardStationText = "";
    await browser
      .waitUntil(
        async () => {
          runLineText = await $(runLine).getText();
          return runLineText.includes("等待");
        },
        { timeout: 20000 },
      )
      .catch(() => undefined);
    cardStationText = await browser.execute(
      (selector) =>
        Array.from(document.querySelectorAll(selector))
          .map((station) => station.textContent ?? "")
          .join(" | "),
      `${RUN_DIGEST}[data-workflow-run-id="${runId}"] [data-testid="workflow-timeline-station"]`,
    );
    await browser.waitUntil(
      async () => (await getV4ComposerBackgroundWorkCounts())?.workflowCount === 1,
      { timeout: 30000, timeoutMsg: "composer 徽标没有计入在跑的工作流" },
    );
    await digest.$('[data-testid="workflow-card-open-details"]').click();
    const paneCancel = await $('[data-testid="workflow-run-cancel"]');
    await paneCancel.waitForDisplayed({ timeout: 30000 });
    await browser.waitUntil(async () => paneCancel.isEnabled(), {
      timeout: 30000,
      timeoutMsg: "侧板的「停止运行」在 running 时不可用",
    });
    await expect($('[data-testid="workflow-run-status"]')).toHaveText("运行中");

    // 按下后按钮禁用、名字换成「正在停止…」，直到状态变化让它重挂（无确认窗）。这是个瞬态：
    // 投影可能很快把状态换掉，所以在点击前挂观察器记录，不靠抢时序读 DOM。
    await browser.execute(() => {
      const probe = window as Window & { __dwxStoppingSeen?: boolean };
      probe.__dwxStoppingSeen = false;
      const seen = () =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="workflow-digest-cancel"]'),
        ).some((button) => button.disabled && button.getAttribute("aria-label") === "正在停止…");
      const observer = new MutationObserver(() => {
        if (seen()) {
          probe.__dwxStoppingSeen = true;
          observer.disconnect();
        }
      });
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled", "aria-label"],
      });
    });
    const cardCancel = await digest.$('[data-testid="workflow-digest-cancel"]');
    await expect(cardCancel).toHaveAttribute("aria-label", "停止运行");
    await cardCancel.click();

    // 卡：种类词换成「工作流已停止」，Stop 退场，停下的 run 可恢复，所以 Resume 进场。
    try {
      await browser.waitUntil(
        async () => {
          digests = await readDigests();
          return digests.some((item) => item.runId === runId && item.status === "stopped");
        },
        { timeout: 60000 },
      );
    } catch {
      throw new Error(`run 卡没有落到 stopped; digests=${JSON.stringify(digests)}`);
    }
    expect(
      await browser.execute(
        () => (window as Window & { __dwxStoppingSeen?: boolean }).__dwxStoppingSeen,
      ),
    ).toBe(true);
    await expect(digest.$('[data-testid="workflow-card-kind"]')).toHaveText(
      expect.stringContaining("工作流已停止"),
    );
    await expect(digest.$('[data-testid="workflow-digest-cancel"]')).not.toBeExisting();
    await expect(digest.$('[data-testid="workflow-digest-resume"]')).toBeDisplayed();

    // 侧板：状态行「已停止 · 你停止的」，Stop 仍在但不可用，Resume 出现，结果面板写「实例已停止 · 你停止的」。
    await expect($('[data-testid="workflow-run-status"]')).toHaveText("已停止");
    await expect($('[data-testid="workflow-run-status-reason"]')).toHaveText(
      expect.stringContaining("你停止的"),
    );
    await expect($('[data-testid="workflow-run-cancel"]')).toBeDisabled();
    await expect($('[data-testid="workflow-run-resume"]')).toBeDisplayed();
    const errorPanel = await $('[data-testid="workflow-run-error"]');
    await errorPanel.waitForDisplayed({ timeout: 30000 });
    expect(await errorPanel.getText()).toContain("实例已停止");
    await expect($('[data-testid="workflow-run-stop-reason"]')).toHaveText(
      expect.stringContaining("你停止的"),
    );

    // 侧栏：会话正打开着，run 在读者眼前结束即被确认，运行行折叠；任何地方都不再有 running 的运行行。
    await browser.waitUntil(async () => !(await $(runLine).isExisting()), {
      timeout: 30000,
      timeoutMsg: "当前会话里停下的 run 的运行行没有折叠",
    });
    await expect($('[data-workflow-run-line][data-run-status="running"]')).not.toBeExisting();
    // composer 徽标不再计入这条工作流。
    await browser.waitUntil(
      async () => ((await getV4ComposerBackgroundWorkCounts())?.workflowCount ?? 0) === 0,
      { timeout: 30000, timeoutMsg: "composer 徽标仍在计入已停止的工作流" },
    );
    expect({ runLineText, cardStationText }).toEqual({
      runLineText: expect.stringContaining("等待"),
      cardStationText: expect.stringContaining("等待"),
    });
  });

  it("DWX-02 主代理读到 stop-reason=user 的通知；通知行写「工作流已停止 · 你停止的」，对话可以继续", async function () {
    this.timeout(180000);
    // 模型读到的终态通知：status=stopped、stop-reason=user、摘要句与「用户有意停止」的交付指引。
    await waitForUpstreamRequest(
      {
        lastUserMessageIncludes: [
          "<task-notification>",
          "<status>stopped</status>",
          "<stop-reason>user</stop-reason>",
          `<description>${RUN_NAME}</description>`,
          // 摘要句里的引号按 XML 转义成 &quot;，只匹配句尾。
          "was stopped by the user.</summary>",
          "The user stopped this workflow on purpose.",
        ],
      },
      "主代理没有收到 stop-reason=user 的停止通知",
      60000,
    );
    await waitForV4AssistantMessageContaining("E2E_DWX_NOTIFIED", 60000);

    // 通知行：工作流图标的工具行，种类词带原因词，主文本是 run 名。
    const row = await $(
      `//*[starts-with(@data-testid, "chat-workflow-notification-row-")][contains(., "工作流已停止 · 你停止的")]`,
    );
    await row.waitForDisplayed({ timeout: 30000 });
    expect(await row.getText()).toContain(RUN_NAME);

    // 对话继续：下一条提示正常得到回复，停下的 run 仍是 stopped（主代理没有自行恢复它）。
    await waitForV4Pane((pane) => !pane.canStop, "停止通知的回复轮没有结束", 30000);
    await sendV4Prompt("E2E_DWX_AFTER 好的，接下来做别的。");
    await waitForV4AssistantMessageContaining("E2E_DWX_AFTER_OK", 60000);
    await expect($(`${RUN_DIGEST}[data-workflow-run-id="${runId}"]`)).toHaveAttribute(
      "data-workflow-run-status",
      "stopped",
    );
  });
});

interface DigestSnapshot {
  runId: string | null;
  status: string | null;
  kind: string | null;
}

/** 读当前 DOM 里所有 run 卡的 run id、状态与种类词；失败时连同快照一起报出。 */
function readDigests(): Promise<DigestSnapshot[]> {
  return browser.execute((selector) => {
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).map((card) => ({
      runId: card.getAttribute("data-workflow-run-id"),
      status: card.getAttribute("data-workflow-run-status"),
      kind: card.querySelector('[data-testid="workflow-card-kind"]')?.textContent ?? null,
    }));
  }, RUN_DIGEST);
}
