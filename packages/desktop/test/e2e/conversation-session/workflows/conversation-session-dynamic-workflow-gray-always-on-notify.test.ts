import type { ChainablePromiseElement } from "webdriverio";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
import { clearAppData, pinE2ELocale } from "#e2e/helpers/desktop-app";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  approveV4Permission,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import {
  countUpstreamRequests,
  findFirstUpstreamRequestIndex,
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
  type UpstreamRequestQuery,
} from "#e2e/helpers/conversation-session-network";

// run 自己结束时主代理怎么知道（docs/dynamic-workflow/transcript-and-notifications.md「Notifications」
// 「The notification row」「What the model reads」「The completion card」）：主代理闲着时 run 结束，
// 通知唤起一轮，模型读到 `<task-notification>`，时间线画出工作流通知行；完成的那轮回复尾部长出完成卡。
//
// case-local 回放只决定主模型的选择；真实 Skill、工作流编译、审批、run 引擎、通知的铸造与投递走产品链路。
// 脚本零 agent，用 `world.run("node", …)` 等一个闸文件：用例在主代理那一轮收尾之后才写闸文件，
// run 何时结束由用例决定，不靠计时。
const RUN_DIGEST = `[data-testid^="${TID_CHAT_WORKFLOW_RUN_DIGEST}"]`;
const NOTIFICATION_ROW = `div[data-testid^="chat-workflow-notification-row-"]`;
const COMPLETION_CARD = `[data-testid^="workflow-completion-card-"]`;
const OK_RUN = "E2E 通知完成工作流";
const FAIL_RUN = "E2E 通知出错工作流";
const BUSY_RUN = "E2E 通知忙碌工作流";
const SYSTEM_BANNER = "[SYSTEM NOTIFICATION - NOT USER INPUT]";

const notificationQuery = (marker: string): UpstreamRequestQuery => ({
  lastUserMessageIncludes: ["<task-notification>", marker],
});

describe("动态工作流 · run 结束的通知", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
    await Promise.all(["ok", "fail", "busy"].map((name) => rm(gatePath(name), { force: true })));
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWN-01 完成：闲着的主代理被唤起，读到 completed 载荷；通知行「工作流已完成」展开是 JSON 结果；回复尾部有完成卡", async function () {
    this.timeout(300000);
    const runId = await launchIdleRun(
      "ok",
      "E2E_DWN_OK_START 用工作流检查三个文件，放行后返回结论。",
    );

    await openGate("ok");
    await waitForUpstreamRequest(
      notificationQuery("E2E_DWN_OK_RESULT"),
      "完成通知没有唤起主代理",
      120000,
    );
    const payload = await readNotificationText(notificationQuery("E2E_DWN_OK_RESULT"));
    expect(payload).toContain(SYSTEM_BANNER);
    expect(payload).toContain(`<task-id>${runId}</task-id>`);
    expect(payload).toContain("<tool-use-id>toolu_dwn_ok_create</tool-use-id>");
    expect(payload).toContain("<status>completed</status>");
    expect(payload).not.toContain("<stop-reason>");
    expect(payload).toContain(`<description>${OK_RUN}</description>`);
    expect(payload).toContain(`<summary>Workflow "${OK_RUN}" completed.</summary>`);
    // `<result>` 是脚本的返回值，不回落到启动输出。
    expect(payload).toMatch(/<result>[\s\S]*"verdict":\s*"E2E_DWN_OK_RESULT"[\s\S]*<\/result>/u);
    expect(payload).not.toContain("<error>");
    // 交付指引在块之后：按交付物呈现结论。
    expect(payload.indexOf("</task-notification>")).toBeLessThan(
      payload.lastIndexOf("deliverable"),
    );

    await waitForV4AssistantMessageContaining("E2E_DWN_OK_DIGESTED", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "完成通知那一轮没有结束", 60000);

    const row = await waitForNotificationRow("工作流已完成", OK_RUN);
    expect(await row.$('[data-testid="workflow-notification-result"]').isExisting()).toBe(false);
    await row.$('[role="button"]').click();
    const result = await row.$('[data-testid="workflow-notification-result"]');
    await result.waitForDisplayed({ timeout: 10000 });
    // JSON 结果在代码块里按缩进排版（不是原样一行）。
    await browser.waitUntil(
      async () => /"verdict":\s+"E2E_DWN_OK_RESULT"/u.test(await result.getText()),
      { timeout: 10000, timeoutMsg: "展开体没有画出 JSON 结果" },
    );
    expect(await result.getText()).toContain('"checked": 3');

    // 完成卡只在消化完成通知的那一轮尾部出现，一轮一张。
    await expect($$(COMPLETION_CARD)).toBeElementsArrayOfSize(1);
    expect(await countUpstreamRequests(notificationQuery("E2E_DWN_OK_RESULT"))).toBe(1);

    // 展开体以「查看实例详情」收尾：活会话里宿主能开侧板，投影也认得这次 run 的工具调用 id。
    await expectOpenRunLink(result, runId);
  });

  it("DWN-02 出错：载荷 status=errored 带 error 与 AmendWorkflow 指引；通知行「工作流出错」展开是错误面板；没有完成卡", async function () {
    this.timeout(300000);
    const runId = await launchIdleRun(
      "fail",
      "E2E_DWN_FAIL_START 用工作流读取清单，放行后按清单汇总。",
    );

    await openGate("fail");
    await waitForUpstreamRequest(
      notificationQuery("E2E_DWN_FAIL_BOOM"),
      "出错通知没有唤起主代理",
      120000,
    );
    const payload = await readNotificationText(notificationQuery("E2E_DWN_FAIL_BOOM"));
    expect(payload).toContain(SYSTEM_BANNER);
    expect(payload).toContain(`<task-id>${runId}</task-id>`);
    expect(payload).toContain("<status>errored</status>");
    expect(payload).toContain(
      `<summary>Workflow "${FAIL_RUN}" errored: the script failed.</summary>`,
    );
    expect(payload).toMatch(/<error>[\s\S]*E2E_DWN_FAIL_BOOM[\s\S]*<\/error>/u);
    // 出错的指引：修脚本后用 AmendWorkflow 提交；ResumeWorkflowRun 会拒绝出错的 run。
    const guidance = payload.slice(payload.indexOf("</task-notification>"));
    expect(guidance).toContain(`AmendWorkflow (run_id="${runId}"`);
    // run 记下了脚本文件：指引点名它，让模型就地编辑并传 `path`，不再贴脚本。
    expect(guidance).toMatch(/\.dwf\.ts\. Edit that file in place[\s\S]*path="/u);

    await waitForV4AssistantMessageContaining("E2E_DWN_FAIL_DIGESTED", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "出错通知那一轮没有结束", 60000);

    const row = await waitForNotificationRow("工作流出错", FAIL_RUN);
    await row.$('[role="button"]').click();
    await browser.waitUntil(async () => (await row.getText()).includes("E2E_DWN_FAIL_BOOM"), {
      timeout: 10000,
      timeoutMsg: "展开体没有画出错误",
    });
    // 错误在错误面板里，不是结果体。
    expect(await row.$('[data-testid="workflow-notification-result"]').isExisting()).toBe(false);
    await expect(row.$('p[class*="border-destructive"]')).toHaveText(
      expect.stringContaining("E2E_DWN_FAIL_BOOM"),
    );

    // 出错的 run 没有完成卡：只有 DWN-01 那一张。
    await expect($$(COMPLETION_CARD)).toBeElementsArrayOfSize(1);
    expect(await countUpstreamRequests(notificationQuery("E2E_DWN_FAIL_BOOM"))).toBe(1);
  });

  it("DWN-03 主代理忙着时 run 结束：通知不另起并行请求，这一轮结束后恰好送达一次", async function () {
    this.timeout(300000);
    const runId = await launchIdleRun("busy", "E2E_DWN_BUSY_START 用工作流跑一个等放行的任务。");

    // 主代理开一轮新的，回放停在流中途：主代理忙着。
    await sendV4Prompt("E2E_DWN_BUSY_HOLD 先回答我一个问题。");
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: ["E2E_DWN_BUSY_HOLD"] },
      "忙碌的那一轮没有发出请求",
      60000,
    );
    await waitForV4Pane((pane) => pane.canStop, "忙碌的那一轮没有进入运行态", 30000);

    // 忙着的时候 run 结束。
    await openGate("busy");
    await browser.waitUntil(
      async () => (await runDigest(runId).getAttribute("data-workflow-run-status")) === "completed",
      { timeout: 120000, timeoutMsg: "忙碌期间 run 没有结束" },
    );
    // run 已结束而这一轮还卡在流中途：通知没有另起一个并行的模型请求。
    expect((await getV4PaneSnapshot()).canStop).toBe(true);
    expect(await countUpstreamRequests(notificationQuery("E2E_DWN_BUSY_RESULT"))).toBe(0);

    const holdIndex = await findFirstUpstreamRequestIndex({
      lastUserMessageIncludes: ["E2E_DWN_BUSY_HOLD"],
    });
    await releaseControlledReplay("dwn-busy-hold");
    await waitForV4AssistantMessageContaining("E2E_DWN_BUSY_HELD", 60000);

    await waitForUpstreamRequest(
      notificationQuery("E2E_DWN_BUSY_RESULT"),
      "忙碌期间结束的 run 的通知没有送达",
      120000,
    );
    const notifiedIndex = await findFirstUpstreamRequestIndex(
      notificationQuery("E2E_DWN_BUSY_RESULT"),
    );
    expect(notifiedIndex).not.toBeNull();
    expect(notifiedIndex!).toBeGreaterThan(holdIndex!);
    const payload = await readNotificationText(notificationQuery("E2E_DWN_BUSY_RESULT"));
    expect(payload).toContain(`<task-id>${runId}</task-id>`);
    expect(payload).toContain("<status>completed</status>");
    expect(payload).toContain(`<summary>Workflow "${BUSY_RUN}" completed.</summary>`);

    await waitForV4AssistantMessageContaining("E2E_DWN_BUSY_DIGESTED", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "忙碌通知那一轮没有结束", 60000);
    await waitForNotificationRow("工作流已完成", BUSY_RUN);
    // 不丢也不重：恰好一次。
    expect(await countUpstreamRequests(notificationQuery("E2E_DWN_BUSY_RESULT"))).toBe(1);
  });
});

function gatePath(name: string) {
  return resolveE2ERuntimePath(`dwn-gate-${name}`);
}

/** 写闸文件：脚本里的 `world.run("node", …)` 看到它就退出，run 随之结束。 */
async function openGate(name: string) {
  const path = gatePath(name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "open\n");
}

/** 等展开体里出现「查看实例详情」；等不到时把 run 卡与投影的现场带进失败信息，便于区分时序与联查缺失。 */
async function expectOpenRunLink(body: ChainablePromiseElement, runId: string) {
  const appeared = await browser
    .waitUntil(async () => (await body.getText()).includes("查看实例详情"), { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) return;
  const digest = runDigest(runId);
  const digestExists = await digest.isExisting();
  const evidence = {
    bodyText: await body.getText(),
    digestExists,
    digestStatus: digestExists ? await digest.getAttribute("data-workflow-run-status") : null,
    digestOpenLinks: digestExists
      ? await digest.$$("button").map((button) => button.getText())
      : [],
  };
  throw new Error(`通知行展开体没有「查看实例详情」：${JSON.stringify(evidence)}`);
}

function runDigest(runId: string) {
  return $(`${RUN_DIGEST}[data-workflow-run-id="${runId}"]`);
}

/**
 * 发启动指令、批准、等启动轮收尾，返回新 run 的 id；返回时主代理闲着、run 停在闸上。
 * 启动轮先收尾，通知才会唤起自己的一轮，而不是被并进启动轮。
 */
async function launchIdleRun(name: "ok" | "fail" | "busy", prompt: string) {
  const known = new Set(
    await browser.execute(
      (selector) =>
        Array.from(document.querySelectorAll(selector)).map(
          (node) => node.getAttribute("data-workflow-run-id") ?? "",
        ),
      RUN_DIGEST,
    ),
  );
  await sendV4Prompt(prompt);
  await approveV4Permission();
  await browser.waitUntil(
    async () =>
      (await getLatestUpstreamToolResultByToolCallId(`toolu_dwn_${name}_create`))?.isError ===
      false,
    { timeout: 60_000, timeoutMsg: "CreateWorkflow 未执行成功" },
  );
  await waitForV4AssistantMessageContaining(`E2E_DWN_${name.toUpperCase()}_STARTED`, 60000);
  await waitForV4Pane((pane) => !pane.canStop, "启动轮没有结束", 30000);

  let runId = "";
  await browser.waitUntil(
    async () => {
      const ids = await browser.execute(
        (selector) =>
          Array.from(document.querySelectorAll(selector))
            .filter((node) => node.getAttribute("data-workflow-run-status") === "running")
            .map((node) => node.getAttribute("data-workflow-run-id") ?? ""),
        RUN_DIGEST,
      );
      runId = ids.find((id) => id !== "" && !known.has(id)) ?? "";
      return runId !== "";
    },
    { timeout: 60000, timeoutMsg: "新 run 的卡没有进入 running" },
  );
  // 闸还没开：主代理闲着，run 停在 world.run 上，没有任何通知。
  expect(
    await countUpstreamRequests({ lastUserMessageIncludes: ["<task-notification>", runId] }),
  ).toBe(0);
  return runId;
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

/** 按 kind 词与 run 名找到那一行通知（同一会话里有多条）。 */
async function waitForNotificationRow(kindLabel: string, runName: string) {
  let found: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      for (const row of await $$(NOTIFICATION_ROW)) {
        const text = await row.getText();
        if (text.includes(kindLabel) && text.includes(runName)) {
          found = row;
          return true;
        }
      }
      return false;
    },
    { timeout: 60000, timeoutMsg: `没有出现「${kindLabel} · ${runName}」通知行` },
  );
  return found!;
}
