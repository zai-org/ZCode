import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
import type { ChainablePromiseElement } from "webdriverio";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4PermissionDialog,
} from "#e2e/helpers/v4-conversation";
import {
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestEvidence,
} from "#e2e/helpers/conversation-session-network";

// 模型发起的工作流主链路（docs/dynamic-workflow/launch.md「The `CreateWorkflow` tool」「The confirmation
// window」、docs/dynamic-workflow/presentation.md「The chat area」「The run pane」「The sidebar run line」、
// docs/dynamic-workflow/transcript-and-notifications.md「The completion card」）：
// 两个阶段，第一阶段两个子代理并行，第二阶段一个子代理汇总，脚本返回一个值。
//
// 文件名带 `gray-always-on`：配置 mock 网关按文件名下发 alwaysOn，工作流工具才在工具集里。
// case-local 回放只决定模型调用（主代理与子代理）；真实 Skill、编译、确认窗、run 引擎、子代理会话与
// 完成通知仍走产品链路。第二阶段子代理的回答用受控流挂起，运行态断言做完再释放，不靠延时抢时序。
const RUN_NAME = "E2E 调研汇总";
const RUN_DIGEST = `[data-testid^="${TID_CHAT_WORKFLOW_RUN_DIGEST}"]`;
const COMPLETION_CARD = '[data-workflow-completion-card="true"]';
const RUN_LINE = '[data-workflow-run-line="true"]';
const AGENTS = ["调研员甲", "调研员乙", "汇总员"];
const HELD_AGENT_FIXTURE = "dwr-agent-c";

let runId = "";

async function readPillStatuses(scope: ChainablePromiseElement | WebdriverIO.Element) {
  const statuses: Record<string, string> = {};
  for (const pill of await scope.$$('[data-testid="workflow-agent-pill"]')) {
    // 失败原因：a6fb6916a8 给完成的子代理 pill 加了 sr-only 的「已完成」文字，整颗 pill 的
    // 文本变成「名字+状态」。名字只读 `.wf-pill-name`，状态仍读 data-agent-status。
    const name = (await pill.$(".wf-pill-name").getText()).trim();
    statuses[name] = (await pill.getAttribute("data-agent-status")) ?? "";
  }
  return statuses;
}

async function readStationStatuses(digest: ChainablePromiseElement | WebdriverIO.Element) {
  const stations: Array<{ text: string; status: string }> = [];
  for (const station of await digest.$$('[data-testid="workflow-timeline-station"]')) {
    stations.push({
      text: await station.getText(),
      status: (await station.getAttribute("data-station-status")) ?? "",
    });
  }
  return stations;
}

describe("动态工作流 · 模型发起的 run 主链路", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWR-01 确认窗写明名字与阶段数；批准后工具结果成功，run 卡画出两站三枚药丸，运行中侧栏有运行行，最终到达完成态", async function () {
    this.timeout(300000);
    await sendV4Prompt("E2E_DWR_START 用工作流调研两份材料并汇总结论。");

    // 确认窗：标题「运行此工作流？」、工作流名与阶段数（launch.md「What the window shows」）。
    await waitForV4PermissionDialog();
    // 确认窗没有自己的 testid：从「需要权限」选项列表向上取整个窗口的文字。
    const readPermissionWindowText = () =>
      browser.execute(() => {
        const listbox = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).find(
          (element) =>
            ["Permission required", "需要权限"].includes(element.getAttribute("aria-label") ?? ""),
        );
        return listbox?.closest<HTMLElement>(".bg-popover")?.innerText ?? "";
      });
    await browser.waitUntil(async () => (await readPermissionWindowText()).includes("2 个阶段"), {
      timeout: 30000,
      timeoutMsg: "确认窗没有写出阶段数",
    });
    const panelText = await readPermissionWindowText();
    expect(panelText).toContain("运行此工作流？");
    expect(panelText).toContain(RUN_NAME);
    await approveV4Permission();

    // 工具结果：编译通过、后台启动，并告诉模型 run id 与「完成时会通知」。
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwr_create"))?.isError === false,
      { timeout: 60000, timeoutMsg: "CreateWorkflow 未执行成功" },
    );
    const toolResult = await getLatestUpstreamToolResultByToolCallId("toolu_dwr_create");
    const launched = /started in the background with ID: (\S+?)\./.exec(toolResult?.content ?? "");
    expect(launched).not.toBeNull();
    runId = launched![1]!;
    expect(toolResult?.content).toContain("you will be notified");

    // run 卡：按工具调用 id 接到这次 run；两站（调研、汇总），三枚带名字的药丸。
    const digest = await $(`${RUN_DIGEST}[data-workflow-run-id="${runId}"]`);
    await digest.waitForDisplayed({ timeout: 120000 });
    expect(await (await digest.$('[data-testid="workflow-card-name"]').getText()).trim()).toBe(
      RUN_NAME,
    );
    await browser.waitUntil(
      async () => (await digest.$$('[data-testid="workflow-agent-pill"]').length) === 3,
      { timeout: 60000, timeoutMsg: "run 卡没有画出三枚子代理药丸" },
    );
    const stations = await readStationStatuses(digest);
    expect(stations.map((station) => station.text)).toEqual([
      expect.stringContaining("调研"),
      expect.stringContaining("汇总"),
    ]);
    expect(Object.keys(await readPillStatuses(digest)).sort()).toEqual([...AGENTS].sort());

    // 运行态：第二阶段子代理的回答被挂起，第一阶段两人已完成，汇总员在跑。
    await browser.waitUntil(
      async () => {
        const pills = await readPillStatuses(digest);
        return (
          pills["调研员甲"] === "done" &&
          pills["调研员乙"] === "done" &&
          pills["汇总员"] === "running"
        );
      },
      {
        timeout: 120000,
        timeoutMsg: "第一阶段没有完成，或汇总员没有进入运行态",
      },
    );
    expect(await digest.getAttribute("data-workflow-run-status")).toBe("running");
    expect(await (await digest.$('[data-testid="workflow-card-kind"]')).getText()).toContain(
      "工作流运行中",
    );
    expect((await readStationStatuses(digest)).map((station) => station.status)).toEqual([
      "done",
      "running",
    ]);
    // 侧栏运行行：live run 总是画出，写当前阶段名（presentation.md「The sidebar run line」）。
    const line = await $(RUN_LINE);
    await line.waitForDisplayed({ timeout: 60000 });
    await browser.waitUntil(async () => (await line.getText()).includes("汇总"), {
      timeout: 60000,
      timeoutMsg: "侧栏运行行没有写出当前阶段「汇总」",
    });

    await releaseControlledReplay(HELD_AGENT_FIXTURE);

    await browser.waitUntil(
      async () => (await digest.getAttribute("data-workflow-run-status")) === "completed",
      { timeout: 120000, timeoutMsg: "run 没有到达完成态" },
    );
    expect(await (await digest.$('[data-testid="workflow-card-kind"]')).getText()).toContain(
      "工作流已完成",
    );
    expect(Object.values(await readPillStatuses(digest))).toEqual(["done", "done", "done"]);
    // 发起行折成一行摘要「工作流 · 3 个子代理 ↗」。已结束一轮的工具行收在「已处理」折叠里（默认收起），
    // 发起行在第一轮：先展开第一轮的折叠再读。
    await browser.execute(() => {
      const first = document.querySelector<HTMLElement>(
        '[data-testid^="chat-assistant-history-trigger-"]',
      );
      if (first?.dataset.historyOpen === "false") first.click();
    });
    const summary = await $(
      `[data-testid="workflow-tool-summary"][data-workflow-run-id="${runId}"]`,
    );
    await summary.waitForDisplayed({ timeout: 30000 });
    // 折叠展开动画期间 getText 读到空串（dwr-4）：等 DOM 文字本身写出计数。
    await browser.waitUntil(
      async () =>
        (
          await browser.execute(
            (id: string) =>
              document.querySelector(
                `[data-testid="workflow-tool-summary"][data-workflow-run-id="${id}"] [data-testid="workflow-summary-agents"]`,
              )?.textContent ?? "",
            runId,
          )
        ).includes("3 个子代理"),
      { timeout: 30000, timeoutMsg: "发起行摘要没有写出「3 个子代理」" },
    );
  });

  it("DWR-02 完成通知把返回值交给主代理，通知行可展开出结果，收尾回复之后出现完成卡与四格数字", async function () {
    this.timeout(180000);
    // 完成通知：<task-notification> 带 completed 状态与脚本返回值（transcript-and-notifications.md「What the model reads」）。
    await waitForV4AssistantMessageContaining("E2E_DWR_DONE", 120000);
    const [notified] = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: ["<task-notification>"],
    });
    expect(notified?.fixtureId).toBe("dwr-notified");
    const notifiedBody = JSON.stringify(notified?.requestJson);
    expect(notifiedBody).toContain(`<description>${RUN_NAME}</description>`);
    expect(notifiedBody).toContain("<result>");
    for (const answer of ["E2E_DWR_ANSWER_A", "E2E_DWR_ANSWER_B", "E2E_DWR_ANSWER_C"]) {
      expect(notifiedBody).toContain(answer);
    }

    // 通知行：「工作流已完成 · 名字」，展开体是返回值。
    const row = await $('[data-testid^="chat-workflow-notification-row-"]');
    await row.waitForDisplayed({ timeout: 60000 });
    expect(await row.getText()).toContain("工作流已完成");
    expect(await row.getText()).toContain(RUN_NAME);
    await row.$('[role="button"]').click();
    const result = await row.$('[data-testid="workflow-notification-result"]');
    await result.waitForDisplayed({ timeout: 10000 });
    await expect(result).toHaveText(expect.stringContaining("E2E_DWR_ANSWER_C"));

    // 完成卡：头部「工作流已完成」+ 名字 + ⤢；没有产物就不画产物区；四格数字依次是时间、tokens、子代理、阶段。
    const card = await $(COMPLETION_CARD);
    await card.waitForDisplayed({ timeout: 60000 });
    expect(await card.$('[data-testid="workflow-card-kind"]').getText()).toContain("工作流已完成");
    expect(await (await card.$('[data-testid="workflow-card-name"]').getText()).trim()).toBe(
      RUN_NAME,
    );
    await expect(card.$('[data-testid="workflow-card-open-details"]')).toBeExisting();
    await expect(card.$('[data-testid^="workflow-artifact"]')).not.toBeExisting();
    // 数字可能在做计数动画；等它停在终值，再读。
    await browser.waitUntil(
      async () =>
        (await card
          .$('[data-testid="workflow-completion-figure-subagents"]')
          .getAttribute("data-value")) === "3" &&
        (await card
          .$('[data-testid="workflow-completion-figure-phases"]')
          .getAttribute("data-value")) === "2",
      { timeout: 10000, timeoutMsg: "完成卡的子代理 / 阶段数字不是 3 / 2" },
    );
    // 时间与 tokens 都拿得到：不是「—」。
    for (const key of ["time", "tokens"]) {
      const figure = await card.$(`[data-testid="workflow-completion-figure-${key}"]`);
      expect(await figure.getAttribute("data-value")).toBeTruthy();
      expect(await figure.getText()).not.toContain("—");
    }
    expect(await card.$('[data-testid="workflow-completion-figures"]').getText()).toEqual(
      expect.stringMatching(/时间[\s\S]*tokens[\s\S]*子代理[\s\S]*阶段/),
    );
  });

  it("DWR-03 从完成卡打开 run 侧板：两段阶段、结果面板，打开子代理看到它的回答；会话在前台时完成的 run 不在侧栏留运行行", async function () {
    this.timeout(180000);
    await (await $(COMPLETION_CARD).$('[data-testid="workflow-card-open-details"]')).click();

    const phases = await $('[data-testid="workflow-run-phases"]');
    await phases.waitForDisplayed({ timeout: 60000 });
    const sections = await phases.$$('[data-testid="workflow-run-phase"]');
    expect(sections).toHaveLength(2);
    expect(await sections[0]!.$('[data-testid="workflow-run-phase-toggle"]').getText()).toContain(
      "调研",
    );
    expect(await sections[1]!.$('[data-testid="workflow-run-phase-toggle"]').getText()).toContain(
      "汇总",
    );
    for (const section of sections) {
      expect(await section.getAttribute("data-phase-status")).toBe("done");
    }
    // 结果面板：completed 写「结果」。
    const pane = await $(
      `div[data-workflow-run-id="${runId}"]:has([data-testid="workflow-run-phases"])`,
    );
    expect(await pane.getAttribute("data-workflow-run-status")).toBe("completed");
    expect(await pane.getText()).toContain("结果");

    // 展开「调研」：两行药丸是两位调研员。
    const research = sections[0]!;
    if ((await research.getAttribute("data-phase-open")) !== "true") {
      await research.$('[data-testid="workflow-run-phase-toggle"]').click();
    }
    await research
      .$('[data-testid="workflow-run-phase-body"]')
      .waitForDisplayed({ timeout: 10000 });
    const researchPills = await readPillStatuses(research);
    expect(Object.keys(researchPills).some((name) => name.includes("调研员甲"))).toBe(true);
    expect(Object.keys(researchPills).some((name) => name.includes("调研员乙"))).toBe(true);

    // 打开调研员甲：子代理 transcript 里有它（回放）的回答。
    let openedFirst = false;
    for (const pill of await research.$$(
      '[data-testid="workflow-agent-pill"][data-agent-open="true"]',
    )) {
      if ((await pill.getText()).includes("调研员甲")) {
        await pill.click();
        openedFirst = true;
        break;
      }
    }
    expect(openedFirst).toBe(true);
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-session-id^="sess_dwf-"]')).some(
            (pane) => (pane.textContent ?? "").includes("E2E_DWR_ANSWER_A"),
          ),
        ),
      { timeout: 60000, timeoutMsg: "子代理 transcript 没有显示调研员甲的回答" },
    );

    // 侧栏运行行：run 在会话打开时结束即被确认，运行行随即收起（presentation.md「Acknowledgement」）。
    await browser.waitUntil(async () => !(await $(RUN_LINE).isExisting()), {
      timeout: 30000,
      timeoutMsg: "会话在前台时完成的 run 仍在侧栏留着运行行",
    });
  });
});
