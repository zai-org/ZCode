import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  scrollV4TimelineToTop,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  countUpstreamRequests,
  getLatestUpstreamToolResultByToolCallId,
} from "#e2e/helpers/conversation-session-network";
import { isOutsideClosedHistory, openClosedHistoryFolds } from "#e2e/helpers/v4-history-folds";

// 修订在跑的工作流（docs/dynamic-workflow/launch.md「The `AmendWorkflow` tool」「Amending this
// session's runs」、docs/dynamic-workflow/presentation.md「The tool row」「The run card」、
// docs/dynamic-workflow/concurrency.md「Retuning a live run」）的三条桌面链路：
// 只改并发 = 就地生效、不起新 run；改脚本 = 新 run 替代旧 run、旧卡留着已完成的工作；
// 两次调用各自告诉模型什么。
//
// case-local 回放只决定模型调用与子代理回复；真实 Skill、编译、审批、运行、留白通知、就地调并发、
// 修订与替代都走产品链路。run 停在留白上保持 running（引擎活着、不需要计时器），
// 留白通知里的 run id 也正好让回放的 `{{latestWorkflowRunId}}` 回填 AmendWorkflow 的 run_id。
const RUN_DIGEST = '[data-workflow-run-digest="true"]';
const digestOf = (runId: string) => $(`${RUN_DIGEST}[data-workflow-run-id="${runId}"]`);

async function readDigestRunIds(): Promise<string[]> {
  return browser.execute((selector) => {
    const ids = Array.from(document.querySelectorAll<HTMLElement>(selector)).map(
      (element) => element.dataset.workflowRunId ?? "",
    );
    return Array.from(new Set(ids.filter(Boolean)));
  }, RUN_DIGEST);
}

// 时间线是虚拟化的：几轮之后，启动那一轮（旧 run 的卡挂在它下面）会被卸载出 DOM。
// 需要读旧卡时先确认它在场，不在场就滚到顶把那一轮挂回来。
async function revealDigest(runId: string) {
  if (!(await digestOf(runId).isExisting())) await scrollV4TimelineToTop();
  await digestOf(runId).waitForExist({ timeout: 30000 });
  await digestOf(runId).scrollIntoView({ block: "center" });
  return digestOf(runId);
}

// 已结束一轮的工具行收在「已处理」折叠里（默认收起），还在跑的一轮则直接画在时间线上。读工具行时
// 两种状态都要接得住：行不在 DOM 里就展开所有收起的折叠，直到它出现，再等它可见。
async function revealToolRow(selector: string) {
  const row = $(selector);
  await withTimelineEvidence(() =>
    browser.waitUntil(
      async () => {
        if (await isOutsideClosedHistory(selector)) return true;
        await openClosedHistoryFolds();
        return false;
      },
      { timeout: 30000, timeoutMsg: `工具行没有出现：${selector}` },
    ),
  );
  await row.waitForDisplayed({ timeout: 30000 });
  return row;
}

// 失败时把时间线末尾几行的 testid 与文字带进错误信息：容器里没有截图，靠它判断行画成了什么。
async function describeTimelineTail(): Promise<string> {
  return browser.execute(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-row-id]")).slice(-8);
    return rows
      .map((row) => {
        const ids = Array.from(row.querySelectorAll<HTMLElement>("[data-testid]"))
          .map((element) => element.dataset.testid)
          .slice(0, 12)
          .join(",");
        return `#${row.dataset.rowId} [${ids}] ${row.innerText.replace(/\s+/gu, " ").slice(0, 200)}`;
      })
      .join("\n")
      .concat(
        "\n--- run cards ---\n",
        Array.from(document.querySelectorAll<HTMLElement>('[data-workflow-run-digest="true"]'))
          .map(
            (card) =>
              `${card.dataset.workflowRunId} ${card.dataset.workflowRunStatus} ${card.getAttribute("aria-label")}`,
          )
          .join("\n"),
      );
  });
}

async function withTimelineEvidence<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw new Error(`${String(error)}\n--- timeline tail ---\n${await describeTimelineTail()}`, {
      cause: error,
    });
  }
}

// 「不弹确认窗」是一段时间里的否定：在发送前装上观察器，权限弹窗只要出现过一帧就记下，
// 不靠固定等待去抽样。
async function watchPermissionDialog() {
  await browser.execute(() => {
    const probe = window as Window & { __dwaPermissionSeen?: boolean };
    probe.__dwaPermissionSeen = false;
    const seen = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).some((element) => {
        const label = (element.getAttribute("aria-label") ?? "").trim();
        return label === "Permission required" || label === "需要权限";
      });
    const observer = new MutationObserver(() => {
      if (seen()) {
        probe.__dwaPermissionSeen = true;
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
}

async function permissionDialogSeen(): Promise<boolean> {
  return browser.execute(
    () => (window as Window & { __dwaPermissionSeen?: boolean }).__dwaPermissionSeen === true,
  );
}

describe("动态工作流 · 修订在跑的 run", () => {
  let firstRunId = "";
  let amendedRunId = "";

  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWA-01 只改并发：不弹窗、不起新 run，卡不变，工具行是设置行，侧板芯片读出新界", async function () {
    this.timeout(300000);
    await sendV4Prompt("E2E_DWA_START 用工作流先整理条目，再等我决定下一步。");
    await approveV4Permission();
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwa_create"))?.isError === false,
      { timeout: 60_000, timeoutMsg: "CreateWorkflow 未执行成功" },
    );
    const firstDigest = await $(RUN_DIGEST);
    await firstDigest.waitForDisplayed({ timeout: 120000 });
    firstRunId = (await firstDigest.getAttribute("data-workflow-run-id")) ?? "";
    expect(firstRunId).not.toBe("");

    // 子代理先做完一步（已完成的工作），run 随后停在留白上，留白通知唤醒的那一轮结束。
    await browser.waitUntil(
      async () =>
        (await digestOf(firstRunId)
          .$('[data-testid="workflow-agent-pill"][data-agent-status="done"]')
          .isExisting()) &&
        (await digestOf(firstRunId)
          .$('[data-testid="workflow-timeline-station"][data-station-hole="waiting"]')
          .isExisting()),
      { timeout: 120000, timeoutMsg: "run 没有做完第一步并停在留白上" },
    );
    await waitForV4AssistantMessageContaining("E2E_DWA_WAITING", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "留白通知回复未结束", 60000);
    expect(await digestOf(firstRunId).getAttribute("data-workflow-run-status")).toBe("running");

    await watchPermissionDialog();
    await sendV4Prompt("E2E_DWA_RETUNE 把这个工作流的最大并发改成 2。");
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwa_retune"))?.isError === false,
      { timeout: 60_000, timeoutMsg: "只改并发的 AmendWorkflow 未执行成功" },
    );
    await waitForV4AssistantMessageContaining("E2E_DWA_RETUNED", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "调并发那一轮未结束", 60000);
    // 就地调并发不弹窗（launch.md「No window, for any owner」）。
    expect(await permissionDialogSeen()).toBe(false);

    // 工具行是 GUI 留下的那条设置行：「已调整设置 · 最多 2 个同时运行」，点名的是同一个 run。
    const retuneRow = await revealToolRow(
      `[data-testid="workflow-retune-row"][data-workflow-retune-run-id="${firstRunId}"]`,
    );
    // 折叠刚展开时还在动画里，innerText 可能暂时为空：读 textContent，并等它到齐。
    await browser.waitUntil(
      async () => {
        const text = String(await retuneRow.getProperty("textContent"));
        return text.includes("已调整设置") && text.includes("最多 2 个同时运行");
      },
      { timeout: 15000, timeoutMsg: "设置行没有写「已调整设置 · 最多 2 个同时运行」" },
    );
    // 不起新 run：没有「工作流已调整」摘要行，也没有第二张卡；原卡仍在跑、没有被替代。
    await expect(
      $('[data-testid="workflow-tool-summary"][data-tool-call-id="toolu_dwa_retune"]'),
    ).not.toBeExisting();
    expect((await readDigestRunIds()).every((runId) => runId === firstRunId)).toBe(true);
    const digest = await revealDigest(firstRunId);
    expect(await digest.getAttribute("data-workflow-run-status")).toBe("running");
    expect(await digest.getAttribute("aria-label")).not.toBe("工作流已被替代");

    // 用户看到的是芯片重新读出它的界（presentation.md「The settings popover」末段）。
    await digest.$('[data-testid="workflow-card-open-details"]').click();
    const chip = await $('[data-testid="workflow-run-concurrency"]');
    await browser.waitUntil(
      async () => (await chip.isExisting()) && /^最大并发数 2\b/u.test(await chip.getText()),
      { timeout: 30000, timeoutMsg: "run 侧板没有出现「最大并发数 2」芯片" },
    );
  });

  it("DWA-02 改脚本：本会话的 run 不弹窗；旧卡变「工作流已被替代」并留着已完成的一步，新卡跑到完成", async function () {
    this.timeout(300000);
    await watchPermissionDialog();
    await sendV4Prompt("E2E_DWA_AMEND 不用等了，改成整理完直接收尾。");
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwa_amend"))?.isError === false,
      { timeout: 60_000, timeoutMsg: "改脚本的 AmendWorkflow 未执行成功" },
    );
    // 本会话启动、未被用户停止、没有带进新 provider 的 run：修订直接开始（rule.session.workflowOwner）。
    expect(await permissionDialogSeen()).toBe(false);

    // 修订行联接到新 run：「工作流已调整」摘要，新 run 的卡挂在这一轮下。
    const summary = await revealToolRow(
      '[data-testid="workflow-tool-summary"][data-tool-call-id="toolu_dwa_amend"]',
    );
    await browser.waitUntil(
      async () => String(await summary.getProperty("textContent")).includes("工作流已调整"),
      { timeout: 15000, timeoutMsg: "修订行没有写「工作流已调整」" },
    );
    amendedRunId = (await summary.getAttribute("data-workflow-run-id")) ?? "";
    expect(amendedRunId).not.toBe("");
    expect(amendedRunId).not.toBe(firstRunId);
    await browser.waitUntil(
      async () =>
        (await digestOf(amendedRunId).isExisting()) &&
        (await digestOf(amendedRunId).getAttribute("data-workflow-run-status")) === "completed",
      { timeout: 120000, timeoutMsg: "修订后的新 run 没有跑到 completed" },
    );

    // 旧卡留在原处：被替代（stopped，kind 词「工作流已被替代」），没有 Resume / Stop / Configure，
    // 它做完的那一步仍画在卡上。
    const oldDigest = await withTimelineEvidence(() => revealDigest(firstRunId));
    await withTimelineEvidence(() =>
      browser.waitUntil(
        async () =>
          (await oldDigest.isExisting()) &&
          (await oldDigest.getAttribute("aria-label")) === "工作流已被替代",
        { timeout: 60000, timeoutMsg: "旧 run 卡没有变成「工作流已被替代」" },
      ),
    );
    expect(await oldDigest.getAttribute("data-workflow-run-status")).toBe("stopped");
    await expect(oldDigest.$('[data-testid="workflow-digest-resume"]')).not.toBeExisting();
    await expect(oldDigest.$('[data-testid="workflow-digest-cancel"]')).not.toBeExisting();
    await expect(oldDigest.$('[data-testid="workflow-digest-configure"]')).not.toBeExisting();
    await expect(
      oldDigest.$('[data-testid="workflow-agent-pill"][data-agent-status="done"]'),
    ).toBeExisting();

    // 旧 run 做完的那一步作为缓存导入：同名子代理的同一句话不再发第二次模型请求。
    expect(await countUpstreamRequests({ lastUserMessageIncludes: ["E2E_DWA_PREP"] })).toBe(1);
  });

  it("DWA-03 模型被告知：就地调并发只点名一个 run；修订点名被替代的旧 run 与新 run，旧 run 不再单独通知", async function () {
    this.timeout(180000);
    // 新 run 完成的通知唤醒的那一轮结束，旧 run 若有终态通知也早该送到了。
    await waitForV4AssistantMessageContaining("E2E_DWA_DONE", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "完成通知回复未结束", 60000);

    // 就地调并发的回话是这条路线唯一越过 v4 的事实，措辞逐字钉住（launch.md「What comes back」）。
    const retune = await getLatestUpstreamToolResultByToolCallId("toolu_dwa_retune");
    expect(retune?.content).toContain(
      `Applied to the running run ${firstRunId}; at most 2 subagents run at once. Run ${firstRunId} keeps running under it: nothing was stopped and no new run was started.`,
    );

    // 修订的回话点名两端：旧 run 被停止并替代、已完成的工作作为缓存导入，修订后的脚本作为新 run 启动。
    const amend = await getLatestUpstreamToolResultByToolCallId("toolu_dwa_amend");
    expect(amend?.isError).toBe(false);
    expect(amend?.content).toContain(`Run ${firstRunId} was still running`);
    expect(amend?.content).toContain("stopped and superseded");
    expect(amend?.content).toContain(
      `The revised script started in the background as run ${amendedRunId}`,
    );
    expect(amend?.content).toContain("It will not send a notification of its own.");

    // 新 run 的完成通知送达；旧 run 的终态通知不送（修订回话就是模型对那次停止的交代）。
    expect(
      await countUpstreamRequests({
        lastUserMessageIncludes: [
          "<task-notification>",
          amendedRunId,
          "<status>completed</status>",
        ],
      }),
    ).toBeGreaterThan(0);
    expect(
      await countUpstreamRequests({
        lastUserMessageIncludes: ["<task-notification>", `<task-id>${firstRunId}</task-id>`],
      }),
    ).toBe(0);
  });
});
