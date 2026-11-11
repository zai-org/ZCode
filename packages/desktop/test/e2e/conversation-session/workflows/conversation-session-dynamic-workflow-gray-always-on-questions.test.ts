import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
import { TID_CHAT_TOOL_CALL_BLOCK, testId } from "@zcode/shared/test-ids";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  countUpstreamRequests,
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
  type UpstreamRequestQuery,
} from "#e2e/helpers/conversation-session-network";
import { isOutsideClosedHistory, openClosedHistoryFolds } from "#e2e/helpers/v4-history-folds";

// 子代理升级问题（docs/dynamic-workflow/authoring.md 的 `escalate` 与「When a subagent escalates」、
// docs/dynamic-workflow/transcript-and-notifications.md「Notifications」「The notification row」
// 「The escalation row's live state」「What the model reads」、docs/dynamic-workflow/presentation.md 的
// 问题芯片与侧板「Pending questions」）：子代理调用 `escalate` 停驻，闲着的主代理被通知唤起一次；
// 主代理用 ResolveWorkflowQuestion 作答，子代理带着答案继续，run 跑到完成。
//
// case-local 回放只决定模型调用；真实 Skill、工作流编译、审批、run 引擎、升级问答的停驻与恢复、
// 通知的铸造与投递走产品链路。脚本先用 `world.run("node", …)` 等一个闸文件：用例在启动轮收尾之后
// 才写闸文件，升级通知因此唤起自己的一轮。等待态检查完成后才发作答指令，等待态不会被自动作答抢走。
//
// 空闲提醒（`workflowBlocked`）不在本文件：它要会话空闲满 15 分钟才发（WORKFLOW_BLOCKED_REMINDER_DELAYS_MS，
// 没有可注入的时钟），用例不能等这样的墙钟时长。
const RUN_DIGEST = `[data-testid^="${TID_CHAT_WORKFLOW_RUN_DIGEST}"]`;
const NOTIFICATION_ROW = `div[data-testid^="chat-workflow-notification-row-"]`;
const RUN_NAME = "E2E 提问工作流";
const ASKER = "核对员";
const QUESTION = "E2E_DWQ_QUESTION 仓库里有两份发布清单，应该按哪一份核对？";
const CONTEXT =
  "E2E_DWQ_CONTEXT release-a.md 和 release-b.md 的版本号互相矛盾，我无法判断哪份是最新的。";
const ANSWER = "E2E_DWQ_ANSWER 按 release-b.md 核对，它是最新的一份。";
const SYSTEM_BANNER = "[SYSTEM NOTIFICATION - NOT USER INPUT]";
const SUBAGENT_MARKER = "You are a subagent inside a dynamic workflow run";
const ESCALATION_QUERY: UpstreamRequestQuery = {
  lastUserMessageIncludes: ["<workflow-escalation>"],
};

let runId = "";
let qid = "";

describe("动态工作流 · 子代理升级问题", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
    await rm(gatePath(), { force: true });
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWQ-01 子代理提问：闲着的主代理被唤起恰好一次并读到问题；通知行「子代理正在等待回答」，卡上「1 个待答问题」，侧板问题挂在提问者下面", async function () {
    this.timeout(300000);
    runId = await launchIdleRun();

    await openGate();
    await waitForUpstreamRequest(ESCALATION_QUERY, "升级通知没有唤起主代理", 120000);
    const payload = await readNotificationText(ESCALATION_QUERY);
    expect(payload).toContain(SYSTEM_BANNER);
    expect(payload).toContain(`<run-id>${runId}</run-id>`);
    expect(payload).toContain(`<run>${RUN_NAME}</run>`);
    expect(payload).toContain(`<subagent>${ASKER}</subagent>`);
    expect(payload).toContain(`<question>${QUESTION}</question>`);
    expect(payload).toContain(`<context>${CONTEXT}</context>`);
    qid = /<question-id>(dwfq-[^<]+)<\/question-id>/u.exec(payload)?.[1] ?? "";
    expect(qid).not.toBe("");
    // 下一步原样点名作答工具与问题 id；只停这一个子代理，不超时。
    const guidance = payload.slice(payload.indexOf("</workflow-escalation>"));
    expect(guidance).toContain(`call ResolveWorkflowQuestion with question_id="${qid}"`);
    expect(guidance).toContain("only the subagent that asked is parked");

    await waitForV4AssistantMessageContaining("E2E_DWQ_SEEN", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "升级通知那一轮没有结束", 60000);

    // 通知行：问号图标那一行，kind 词按投影的待答问题活翻转，主文是问题本身。
    const row = await waitForEscalationRow("子代理正在等待回答");
    await row.$('[role="button"]').click();
    await browser.waitUntil(async () => (await row.getText()).includes(CONTEXT), {
      timeout: 10000,
      timeoutMsg: "通知行展开体没有画出背景",
    });
    expect(await row.getText()).toContain("背景");
    // 展开体以「查看实例详情」收尾：活会话里宿主能开侧板，投影也认得这次 run 的工具调用 id。
    await expectOpenRunLink(row);
    // 答案还不存在，行里也永远不引用答案原文。
    expect(await row.getText()).not.toContain("E2E_DWQ_ANSWER");

    // 卡：run 停驻但仍在跑，表头长出警示色问题芯片。
    const digest = runDigest(runId);
    expect(await digest.getAttribute("data-workflow-run-status")).toBe("running");
    const chip = await digest.$('[data-testid="workflow-digest-questions"]');
    await chip.waitForDisplayed({ timeout: 30000 });
    expect(await chip.getText()).toContain("1 个待答问题");

    // 侧栏运行行：没有问题芯片（问题由主代理回答，不由用户），只写当前阶段。
    const line = await $('[data-workflow-run-line="true"]');
    await line.waitForDisplayed({ timeout: 30000 });
    expect(await line.getText()).toContain("核对");
    expect(await line.getText()).not.toContain("问题");

    // 侧板：点问题芯片打开整个 run；问题挂在提问者那一行下面，带背景、等待时长与问题 id。
    await chip.click();
    const question = await $(`[data-testid="workflow-run-question"][data-qid="${qid}"]`);
    await question.waitForDisplayed({ timeout: 30000 });
    expect(await question.getText()).toContain(QUESTION);
    expect(await question.getText()).toContain(qid);
    await expect(question.$('[data-testid="workflow-run-question-context"]')).toHaveText(CONTEXT);
    await expect(question.$('[data-testid="workflow-run-question-waited"]')).toBeExisting();
    // 提问者在行上，所以不进末尾的「待答问题」孤儿块。
    await expect($('[data-testid="workflow-run-orphan-questions"]')).not.toBeExisting();

    // 每个 `escalation-raised` 恰好一条通知，不重发。
    expect(await countUpstreamRequests(ESCALATION_QUERY)).toBe(1);
  });

  it("DWQ-02 主代理作答：工具卡「已回答问题」，子代理下一次请求带着答案，问题行与芯片消失，通知行翻成「子代理的问题已回答」，run 完成", async function () {
    this.timeout(300000);
    expect(qid).not.toBe("");
    await sendV4Prompt("E2E_DWQ_REPLY_NOW 告诉子代理按 release-b.md 核对。");
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwq_resolve"))?.isError === false,
      { timeout: 60_000, timeoutMsg: "ResolveWorkflowQuestion 未执行成功" },
    );
    const resolved = await getLatestUpstreamToolResultByToolCallId("toolu_dwq_resolve");
    expect(resolved?.content).toContain(`Answer delivered for question ${qid}`);

    // 答案原样成为那次 escalate 调用的结果：子代理的下一次请求里最后一条 user 消息就是它。
    const resumedQuery: UpstreamRequestQuery = {
      includes: [SUBAGENT_MARKER],
      lastUserMessageIncludes: [ANSWER],
    };
    await waitForUpstreamRequest(resumedQuery, "子代理没有带着答案继续", 60000);
    expect(await countUpstreamRequests(resumedQuery)).toBe(1);

    await waitForV4AssistantMessageContaining("E2E_DWQ_DONE", 180000);
    await waitForV4Pane((pane) => !pane.canStop, "完成通知那一轮没有结束", 60000);
    const digest = runDigest(runId);
    await browser.waitUntil(
      async () => (await digest.getAttribute("data-workflow-run-status")) === "completed",
      { timeout: 60000, timeoutMsg: "run 没有跑到完成" },
    );
    await expect(digest.$('[data-testid="workflow-digest-questions"]')).not.toBeExisting();
    await expect($('[data-testid="workflow-run-question"]')).not.toBeExisting();

    // 升级行按投影翻转：run 还在投影里，qid 已不在待答问题里。
    await waitForEscalationRow("子代理的问题已回答");
    // 作答一次，不会因为答过而多出一条升级通知。
    expect(await countUpstreamRequests(ESCALATION_QUERY)).toBe(1);

    // 答案只在相邻的 ResolveWorkflowQuestion 工具卡里（这一轮收尾后折进「已处理」，先展开）。
    const card = await revealToolRow(
      `[data-testid="${testId(TID_CHAT_TOOL_CALL_BLOCK, "toolu_dwq_resolve")}"]`,
    );
    await browser.waitUntil(
      async () => String(await card.getProperty("textContent")).includes("已回答问题"),
      { timeout: 15000, timeoutMsg: "作答工具卡没有写「已回答问题」" },
    );
    expect(String(await card.getProperty("textContent"))).toContain("E2E_DWQ_ANSWER");
  });
});

function gatePath() {
  return resolveE2ERuntimePath("dwq-gate");
}

/** 写闸文件：脚本里的 `world.run("node", …)` 看到它就退出，子代理随之开工。 */
async function openGate() {
  const path = gatePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "open\n");
}

function runDigest(id: string) {
  return $(`${RUN_DIGEST}[data-workflow-run-id="${id}"]`);
}

/**
 * 发启动指令、批准、等启动轮收尾，返回新 run 的 id；返回时主代理闲着、run 停在闸上。
 * 启动轮先收尾，升级通知才会唤起自己的一轮，而不是被并进启动轮。
 */
async function launchIdleRun() {
  await sendV4Prompt("E2E_DWQ_START 用工作流核对发布清单，子代理拿不准时会来问。");
  await approveV4Permission();
  await browser.waitUntil(
    async () =>
      (await getLatestUpstreamToolResultByToolCallId("toolu_dwq_create"))?.isError === false,
    { timeout: 60_000, timeoutMsg: "CreateWorkflow 未执行成功" },
  );
  await waitForV4AssistantMessageContaining("E2E_DWQ_STARTED", 60000);
  await waitForV4Pane((pane) => !pane.canStop, "启动轮没有结束", 30000);

  let id = "";
  await browser.waitUntil(
    async () => {
      id = await browser.execute(
        (selector) =>
          Array.from(document.querySelectorAll(selector))
            .find((node) => node.getAttribute("data-workflow-run-status") === "running")
            ?.getAttribute("data-workflow-run-id") ?? "",
        RUN_DIGEST,
      );
      return id !== "";
    },
    { timeout: 60000, timeoutMsg: "run 卡没有进入 running" },
  );
  // 闸还没开：子代理没有开工，也没有任何升级通知。
  expect(await countUpstreamRequests(ESCALATION_QUERY)).toBe(0);
  return id;
}

/**
 * 唤起那一轮请求里最后一条 user 消息的文本：模型读到的通知全文。
 * 块里的字段值按 XML 转义（`"` → `&quot;`），断言比的是模型读到的字，先还原实体。
 */
async function readNotificationText(query: UpstreamRequestQuery): Promise<string> {
  const [evidence] = await getUpstreamRequestEvidence(query);
  const messages = (evidence?.requestJson as { messages?: unknown } | undefined)?.messages;
  if (!Array.isArray(messages)) return "";
  const last = [...messages]
    .reverse()
    .find((message) => (message as { role?: unknown } | null)?.role === "user") as
    | { content?: unknown }
    | undefined;
  const content = last?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => (block as { text?: unknown } | null)?.text)
            .filter((value): value is string => typeof value === "string")
            .join("\n")
        : "";
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** 按 kind 词找那一条升级通知行（主文是问题本身，不是 run 名）。 */
async function waitForEscalationRow(kindLabel: string) {
  let found: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      for (const row of await $$(NOTIFICATION_ROW)) {
        const text = String(await row.getProperty("textContent"));
        if (text.includes(kindLabel) && text.includes(QUESTION)) {
          found = row;
          return true;
        }
      }
      return false;
    },
    { timeout: 60000, timeoutMsg: `没有出现「${kindLabel}」升级通知行` },
  );
  return found!;
}

/** 等展开体里出现「查看实例详情」；等不到时把 run 卡与投影的现场带进失败信息，便于区分时序与联查缺失。 */
async function expectOpenRunLink(row: WebdriverIO.Element) {
  const appeared = await browser
    .waitUntil(async () => (await row.getText()).includes("查看实例详情"), { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) return;
  const digest = runDigest(runId);
  const digestExists = await digest.isExisting();
  const evidence = {
    rowText: await row.getText(),
    digestExists,
    digestStatus: digestExists ? await digest.getAttribute("data-workflow-run-status") : null,
    digestToolCallId: digestExists ? await digest.getAttribute("data-tool-call-id") : null,
  };
  throw new Error(`升级通知行展开体没有「查看实例详情」：${JSON.stringify(evidence)}`);
}

/** 收尾的一轮把工具行折进「已处理」：点开所有折叠，等目标行出现。 */
async function revealToolRow(selector: string) {
  const row = $(selector);
  await browser.waitUntil(
    async () => {
      if (await isOutsideClosedHistory(selector)) return true;
      await openClosedHistoryFolds();
      return false;
    },
    { timeout: 30000, timeoutMsg: `工具行没有出现：${selector}` },
  );
  await row.waitForDisplayed({ timeout: 30000 });
  return row;
}
