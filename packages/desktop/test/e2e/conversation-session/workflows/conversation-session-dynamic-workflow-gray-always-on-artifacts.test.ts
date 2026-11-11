import type { ChainablePromiseElement } from "webdriverio";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
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
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestEvidence,
} from "#e2e/helpers/conversation-session-network";

// 工作流产物（docs/dynamic-workflow/authoring.md「Artifacts: what the user keeps」、
// docs/dynamic-workflow/presentation.md「The run pane」第 5 节、
// docs/dynamic-workflow/transcript-and-notifications.md「The completion card」「Artifact tiles」）：
// 同一会话里三个模型发起的 run。
// - A：markdown 两版（中间用 world.run 闸文件停住）+ 一个 CSV 文件，markdown 标 primary；
// - B：table / metrics / chart / board 四个看板，各喂几条 report，没有 primary；
// - C：一个空看板、一张半张表，然后声明一个列为空的看板，引擎拒绝它，run 出错。
//
// 文件名带 `gray-always-on`：配置 mock 网关按文件名下发 alwaysOn，工作流工具才在工具集里。
// case-local 回放只决定主模型的选择；真实 Skill、编译、确认窗、run 引擎、产物存储、看板 journal
// 与通知走产品链路。run 何时越过闸由用例写闸文件决定，不靠计时。
const RUN_DIGEST = `[data-testid^="${TID_CHAT_WORKFLOW_RUN_DIGEST}"]`;
const NOTIFICATION_ROW = `div[data-testid^="chat-workflow-notification-row-"]`;
const RUN_A = "E2E 产物交付";
const RUN_B = "E2E 产物看板";
const RUN_C = "E2E 产物出错";
// 与回放里脚本发布的两版正文逐字一致。
const NOTES_V1 = "# E2E 笔记 v1\n\nE2E_DWK_NOTES_V1 初稿。\n";
const NOTES_V2 = "# E2E 笔记 v2\n\nE2E_DWK_NOTES_V2 定稿。\n";
const SCORES_CSV = "name,score\nalpha,90\nbeta,85\n";
const SCORES_PATH = resolveE2ERuntimePath("dwk-scores.csv");
const GATE_A = resolveE2ERuntimePath("dwk-gate-a");

const runIds: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };

describe("动态工作流 · 产物", () => {
  before(async () => {
    await prepareV4ConversationE2E();
    // 断言中文文案：固定界面语言，不跟随宿主系统语言（容器里默认英文）。
    await pinE2ELocale("zh-CN");
    // `artifact.file` 读工作区里的文件：用例先把它放进 Agent 的工作区（`.zcode-e2e/` 在工作区内）。
    await mkdir(dirname(SCORES_PATH), { recursive: true });
    await writeFile(SCORES_PATH, SCORES_CSV);
    await rm(GATE_A, { force: true });
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWK-01 闸前产物条只有第一版笔记；完成后完成卡以主产物行领头、CSV 作索引行，从行与索引打开产物 tab 看到标题、种类与正文", async function () {
    this.timeout(300000);
    const runId = await launchRun("a", "E2E_DWK_A_START 用工作流整理笔记和分数表，交付给我。");
    const pills = `${digestOf(runId)} [data-testid="workflow-digest-artifact"]`;

    // 闸前：第一版已发布，run 停在 world.run 上。产物条一枚药丸、第 1 版，尾槽不写版本号。
    await browser.waitUntil(async () => (await $$(pills).length) === 1, {
      timeout: 60000,
      timeoutMsg: "闸前 run 卡的产物条没有出现第一版笔记",
    });
    expect(await $(digestOf(runId)).getAttribute("data-workflow-run-status")).toBe("running");
    const firstPill = await $(pills);
    expect(await firstPill.getAttribute("data-artifact-id")).toBe("dwk-notes");
    expect(await firstPill.getAttribute("data-artifact-version")).toBe("1");
    expect(await textOf(firstPill)).toContain("E2E 笔记");
    await expect(firstPill.$('[data-testid="workflow-run-artifact-version"]')).not.toBeExisting();

    await openGate(GATE_A);
    await browser.waitUntil(
      async () =>
        (await $(digestOf(runId)).getAttribute("data-workflow-run-status")) === "completed",
      { timeout: 120000, timeoutMsg: "放行后 run 没有到达完成态" },
    );
    // 列表顺序：primary 在前，然后按发布顺序。
    await browser.waitUntil(
      async () => (await readAttr(pills, "data-artifact-id")).join(",") === "dwk-notes,dwk-scores",
      { timeout: 30000, timeoutMsg: "完成后产物条不是「笔记、分数表」两枚" },
    );

    await waitForV4AssistantMessageContaining("E2E_DWK_A_DIGESTED", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "完成通知那一轮没有结束", 60000);

    // 完成通知行末尾带这次 run 的产物药丸。
    const notification = await waitForNotificationRow("工作流已完成", RUN_A);
    await browser.waitUntil(
      async () =>
        (await notification.$$('[data-testid="workflow-notification-artifact-chip"]').length) === 2,
      { timeout: 30000, timeoutMsg: "完成通知行没有带两枚产物药丸" },
    );

    // 完成卡：主产物行（预览框 + 标题 + 说明 + 「种类 · 大小」），其余一件作索引行。
    const card = await completionCard(RUN_A);
    await card.waitForExist({ timeout: 60000 });
    const row = await card.$('button[data-testid="workflow-completion-row"]');
    await row.waitForExist({ timeout: 30000 });
    expect(await row.getAttribute("data-artifact-id")).toBe("dwk-notes");
    expect(await textOf(row.$('[data-testid="workflow-artifact-row-title"]'))).toBe("E2E 笔记");
    expect(await textOf(row.$('[data-testid="workflow-artifact-row-description"]'))).toBe(
      "E2E 两版笔记的说明",
    );
    const rowDetail = await textOf(row.$('[data-testid="workflow-artifact-row-detail"]'));
    expect(rowDetail).toContain("文档");
    expect(rowDetail).toContain(`${Buffer.byteLength(NOTES_V2)} B`);
    // 预览框画的是最新一版的开头（markdown 缩略），不是字形。
    await browser.waitUntil(
      async () =>
        (
          await textOf(
            card.$(
              '[data-testid="workflow-artifact-row-frame"] [data-testid="workflow-artifact-preview-body"][data-preview-mode="markdown"]',
            ),
          )
        ).includes("E2E_DWK_NOTES_V2"),
      { timeout: 30000, timeoutMsg: "完成卡主产物行的预览没有画出第二版正文" },
    );
    const lines = await card.$$('[data-testid="workflow-completion-line"]');
    expect(lines).toHaveLength(1);
    expect(await lines[0]!.getAttribute("data-artifact-id")).toBe("dwk-scores");
    expect(await textOf(lines[0]!)).toContain("E2E 分数表");
    // 细节是「CSV · 28 B」：徽字与大小在各自的 span 里，分开读。
    expect(await textOf(lines[0]!.$('[data-testid="workflow-run-artifact-badge"]'))).toBe("CSV");
    expect(await textOf(lines[0]!.$('[data-testid="workflow-run-artifact-bytes"]'))).toBe(
      `${Buffer.byteLength(SCORES_CSV)} B`,
    );
    await expect(card.$('[data-testid="workflow-completion-more"]')).not.toBeExisting();

    // 从主产物行打开产物 tab：标题、种类「文档」、作者说明、markdown 正文。
    await domClick(row);
    const notesPane = await artifactPane("dwk-notes");
    await notesPane.waitForDisplayed({ timeout: 30000 });
    expect(await textOf(notesPane.$('[data-testid="workflow-artifact-title"]'))).toBe("E2E 笔记");
    expect(await textOf(notesPane.$("header"))).toContain("文档");
    expect(await textOf(notesPane.$("header"))).toContain("E2E 两版笔记的说明");
    await waitForText(
      notesPane.$('[data-artifact-body="markdown"]'),
      "E2E_DWK_NOTES_V2",
      "产物 tab 没有画出笔记正文",
    );

    // run 侧板：产物区计数 2；主产物行在前，其余单列索引；从索引行打开 CSV。
    const pane = await openRunPaneFromCard(RUN_A, runId);
    expect(await pane.getAttribute("data-workflow-run-status")).toBe("completed");
    expect(await textOf(pane.$('[data-testid="workflow-run-artifacts-count"]'))).toBe("2");
    const paneRow = await pane.$(
      'button[data-testid="workflow-run-artifact-card"][data-variant="row"]',
    );
    expect(await paneRow.getAttribute("data-artifact-id")).toBe("dwk-notes");
    const paneLines = await pane.$$(
      'button[data-testid="workflow-run-artifact-card"][data-variant="line"]',
    );
    expect(paneLines).toHaveLength(1);
    expect(await paneLines[0]!.getAttribute("data-artifact-id")).toBe("dwk-scores");
    await domClick(paneLines[0]!);
    const scoresPane = await artifactPane("dwk-scores");
    await scoresPane.waitForDisplayed({ timeout: 30000 });
    expect(await textOf(scoresPane.$('[data-testid="workflow-artifact-title"]'))).toBe(
      "E2E 分数表",
    );
    expect(await textOf(scoresPane.$("header"))).toContain("文件");
    // CSV 走代码查看器，正文画在 shadow DOM 里：连同 shadow root 一起读。
    const scoresBody = scoresPane.$('[data-artifact-body="text"]');
    await scoresBody.waitForExist({ timeout: 30000 });
    await browser.waitUntil(async () => (await deepTextOf(scoresBody)).includes("alpha,90"), {
      timeout: 30000,
      timeoutMsg: "产物 tab 没有画出 CSV 正文",
    });
  });

  it("DWK-02 同一 id 再发布成第二版：尾槽写 v2；产物 tab 的版本步进器在两版之间翻，正文随版本换，复制的是正在看的那一版", async function () {
    this.timeout(180000);
    const runId = runIds.a;
    // run 卡产物条与完成卡主产物行的尾槽都写出 v2。
    const notesPill = await $(
      `${digestOf(runId)} [data-testid="workflow-digest-artifact"][data-artifact-id="dwk-notes"]`,
    );
    expect(await notesPill.getAttribute("data-artifact-version")).toBe("2");
    expect(await textOf(notesPill.$('[data-testid="workflow-run-artifact-version"]'))).toBe("v2");
    const card = await completionCard(RUN_A);
    const row = await card.$('button[data-testid="workflow-completion-row"]');
    expect(await textOf(row.$('[data-testid="workflow-artifact-tile-version"]'))).toBe("v2");

    // 接住复制：读写剪贴板受窗口焦点影响，这里只断言产品交给剪贴板的文字。
    await browser.execute(() => {
      const target = window as Window & { __dwkCopied?: string[] };
      target.__dwkCopied = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            target.__dwkCopied!.push(value);
          },
        },
      });
    });
    const readCopied = () =>
      browser.execute(() => (window as Window & { __dwkCopied?: string[] }).__dwkCopied ?? []);

    await domClick(row);
    const notesPane = await artifactPane("dwk-notes");
    await notesPane.waitForDisplayed({ timeout: 30000 });
    const version = notesPane.$('[data-testid="workflow-artifact-version"]');
    const previous = notesPane.$('[data-testid="workflow-artifact-version-previous"]');
    const next = notesPane.$('[data-testid="workflow-artifact-version-next"]');
    const body = notesPane.$('[data-artifact-body="markdown"]');
    const copy = notesPane.$('[data-testid="workflow-artifact-copy"]');

    // 打开时落在最新版。
    await waitForText(version, "第 2 版 / 共 2 版", "版本步进器没有停在第 2 版");
    expect(await next.isEnabled()).toBe(false);
    expect(await previous.isEnabled()).toBe(true);
    await waitForText(body, "E2E_DWK_NOTES_V2", "第 2 版正文没有画出");

    // 上一版：第 1 版的正文，复制得到第 1 版。
    await domClick(previous);
    await waitForText(version, "第 1 版 / 共 2 版", "上一版没有翻到第 1 版");
    await waitForText(body, "E2E_DWK_NOTES_V1", "第 1 版正文没有画出");
    expect(await textOf(body)).not.toContain("E2E_DWK_NOTES_V2");
    expect(await previous.isEnabled()).toBe(false);
    await copy.waitForExist({ timeout: 10000 });
    await domClick(copy);
    await browser.waitUntil(async () => (await readCopied()).length === 1, {
      timeout: 10000,
      timeoutMsg: "复制没有把正文交给剪贴板",
    });
    expect((await readCopied())[0]).toBe(NOTES_V1);
    // 按钮短暂写「已复制」（1.5 秒后复原）。
    await waitForText(copy, "已复制", "复制后按钮没有写「已复制」", 1000);

    // 下一版：回到第 2 版，复制得到第 2 版。
    await domClick(next);
    await waitForText(version, "第 2 版 / 共 2 版", "下一版没有翻回第 2 版");
    await waitForText(body, "E2E_DWK_NOTES_V2", "翻回后第 2 版正文没有画出");
    await domClick(copy);
    await browser.waitUntil(async () => (await readCopied()).length === 2, {
      timeout: 10000,
      timeoutMsg: "第二次复制没有把正文交给剪贴板",
    });
    expect((await readCopied())[1]).toBe(NOTES_V2);
  });

  it("DWK-03 四种看板：没有 primary 时完成卡只有索引，run 侧板是瓦片画廊，每块缩略按条目画出行数、瓦片、点与列；全尺寸 tab 画出完整看板", async function () {
    this.timeout(300000);
    const runId = await launchRun("b", "E2E_DWK_B_START 用工作流跑一轮测试，把进度画成看板。");
    await browser.waitUntil(
      async () =>
        (await $(digestOf(runId)).getAttribute("data-workflow-run-status")) === "completed",
      { timeout: 120000, timeoutMsg: "看板 run 没有到达完成态" },
    );
    // 产物条至多三枚，其余写成「+1」。
    const pills = `${digestOf(runId)} [data-testid="workflow-digest-artifact"]`;
    await browser.waitUntil(
      async () =>
        (await readAttr(pills, "data-artifact-id")).join(",") === "dwk-table,dwk-metrics,dwk-chart",
      { timeout: 30000, timeoutMsg: "看板 run 的产物条不是按声明顺序的前三枚" },
    );
    expect(
      await textOf($(`${digestOf(runId)} [data-testid="workflow-digest-artifacts-more"]`)),
    ).toBe("+1");

    await waitForV4AssistantMessageContaining("E2E_DWK_B_DIGESTED", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "看板 run 的通知那一轮没有结束", 60000);

    // 完成卡：没有 primary，就没有主产物行，四件都是索引行；看板的细节是条数。
    const card = await completionCard(RUN_B);
    await card.waitForExist({ timeout: 60000 });
    await browser.waitUntil(
      async () => (await card.$$('[data-testid="workflow-completion-line"]').length) === 4,
      { timeout: 30000, timeoutMsg: "看板 run 的完成卡没有四条索引行" },
    );
    await expect(card.$('[data-testid="workflow-completion-row"]')).not.toBeExisting();
    expect(
      await readAttr(card.$$('[data-testid="workflow-completion-line"]'), "data-artifact-id"),
    ).toEqual(["dwk-table", "dwk-metrics", "dwk-chart", "dwk-board"]);
    expect(
      await textOf(
        card.$('[data-testid="workflow-completion-line"][data-artifact-id="dwk-table"]'),
      ),
    ).toContain("5 条");

    // run 侧板：画廊里四张瓦片，缩略是看板本身。
    let pane = await openRunPaneFromCard(RUN_B, runId);
    expect(await textOf(pane.$('[data-testid="workflow-run-artifacts-count"]'))).toBe("4");
    await expect(pane.$('[data-testid="workflow-run-artifact-gallery"]')).toBeExisting();
    expect(
      await readAttr(
        pane.$$('button[data-testid="workflow-run-artifact-card"][data-variant="tile"]'),
        "data-artifact-id",
      ),
    ).toEqual(["dwk-table", "dwk-metrics", "dwk-chart", "dwk-board"]);

    // 表：按 key 覆盖后四行，缩略写「4 条」、露前三行。
    const tableFrame = tileFrame(pane, "dwk-table");
    await waitForText(
      tableFrame.$('[data-testid="artifact-table-count"]'),
      "4 条",
      "表格缩略没有写出 4 条",
    );
    expect(await tableFrame.$$('[data-testid="artifact-table-row"]').length).toBe(3);
    // 指标：每块取最新一条带该字段的值。
    const metricsFrame = tileFrame(pane, "dwk-metrics");
    await browser.waitUntil(
      async () => (await metricsFrame.$$('[data-testid="artifact-metric-tile"]').length) === 3,
      { timeout: 30000, timeoutMsg: "指标缩略没有画出三块瓦片" },
    );
    expect(await readMetricValues(metricsFrame)).toEqual({
      passed: "8",
      failed: "1",
      rate: "88.9",
    });
    // 图：缩略是一条 sparkline 加第一条序列的最新值。
    await waitForText(
      tileFrame(pane, "dwk-chart").$('[data-testid="artifact-chart-latest"]'),
      "95",
      "图表缩略没有写出最新值 95",
    );
    // 看板：缩略是各列计数，状态不在列里的卡进末尾「其他」。
    const boardFrame = tileFrame(pane, "dwk-board");
    await browser.waitUntil(
      async () => (await boardFrame.$$('[data-testid="artifact-board-column-count"]').length) === 4,
      { timeout: 30000, timeoutMsg: "看板缩略没有画出四列计数" },
    );
    const columnCounts: string[] = [];
    for (const chip of await boardFrame.$$('[data-testid="artifact-board-column-count"]')) {
      columnCounts.push((await textOf(chip)).replace(/\s+/gu, ""));
    }
    expect(columnCounts).toEqual(["待办0", "进行中1", "完成1", "其他1"]);

    // 全尺寸 tab：表四行，alpha 那一行是后一次报的 110。
    await domClick(tileButton(pane, "dwk-table"));
    let artifact = await artifactPane("dwk-table");
    await artifact.waitForDisplayed({ timeout: 30000 });
    await browser.waitUntil(
      async () => (await artifact.$$('[data-testid="artifact-table-row"]').length) === 4,
      { timeout: 30000, timeoutMsg: "全尺寸表格不是四行" },
    );
    const rows: string[] = [];
    for (const tableRow of await artifact.$$('[data-testid="artifact-table-row"]')) {
      rows.push(await textOf(tableRow));
    }
    expect(rows.find((text) => text.includes("alpha"))).toContain("110");
    expect(await textOf(artifact.$("header"))).toContain("表格");

    // 指标全尺寸：同样三块、同样的值。
    pane = await openRunPaneFromCard(RUN_B, runId);
    await domClick(tileButton(pane, "dwk-metrics"));
    artifact = await artifactPane("dwk-metrics");
    await artifact.waitForDisplayed({ timeout: 30000 });
    await browser.waitUntil(
      async () => (await artifact.$$('[data-testid="artifact-metric-tile"]').length) === 3,
      { timeout: 30000, timeoutMsg: "全尺寸指标没有画出三块瓦片" },
    );
    expect(await readMetricValues(artifact)).toEqual({ passed: "8", failed: "1", rate: "88.9" });

    // 图全尺寸：图例两条序列，各带最新值与单位。
    pane = await openRunPaneFromCard(RUN_B, runId);
    await domClick(tileButton(pane, "dwk-chart"));
    artifact = await artifactPane("dwk-chart");
    await artifact.waitForDisplayed({ timeout: 30000 });
    await browser.waitUntil(
      async () => (await artifact.$$('[data-testid="artifact-chart-legend-item"]').length) === 2,
      { timeout: 30000, timeoutMsg: "全尺寸图表的图例不是两条序列" },
    );
    const legend: string[] = [];
    for (const item of await artifact.$$('[data-testid="artifact-chart-legend-item"]')) {
      legend.push(await textOf(item));
    }
    expect(legend).toEqual([
      expect.stringMatching(/耗时[\s\S]*95 ms/u),
      expect.stringMatching(/内存[\s\S]*32 MB/u),
    ]);

    // 看板全尺寸：四列、三张卡；任务一移到「完成」，任务三在「其他」。
    pane = await openRunPaneFromCard(RUN_B, runId);
    await domClick(tileButton(pane, "dwk-board"));
    artifact = await artifactPane("dwk-board");
    await artifact.waitForDisplayed({ timeout: 30000 });
    await browser.waitUntil(
      async () => (await artifact.$$('[data-testid="artifact-board-column"]').length) === 4,
      { timeout: 30000, timeoutMsg: "全尺寸看板不是四列" },
    );
    expect(await artifact.$$('[data-testid="artifact-board-card"]').length).toBe(3);
    expect(
      await textOf(artifact.$('[data-testid="artifact-board-column"][data-column-id="完成"]')),
    ).toContain("任务一");
    expect(
      await textOf(artifact.$('[data-testid="artifact-board-column"][data-column-id="待办"]')),
    ).not.toContain("任务一");
    const other = await textOf(
      artifact.$('[data-testid="artifact-board-column"][data-column-id="__other__"]'),
    );
    expect(other).toContain("其他");
    expect(other).toContain("任务三");
  });

  it("DWK-04 看板定义不合法时整个 run 出错、错误点名该看板；已发布的产物照样列出，没有条目的看板写「暂无数据」而不是崩掉", async function () {
    this.timeout(300000);
    const runId = await launchRun("c", "E2E_DWK_C_START 用工作流汇报进度，画成看板。");
    await browser.waitUntil(
      async () => (await $(digestOf(runId)).getAttribute("data-workflow-run-status")) === "errored",
      { timeout: 120000, timeoutMsg: "看板定义不合法的 run 没有出错" },
    );

    // 模型读到的出错通知点名那个看板与不合法的原因（ArtifactSpecInvalid 的消息）。
    await waitForV4AssistantMessageContaining("E2E_DWK_C_DIGESTED", 120000);
    await waitForV4Pane((pane) => !pane.canStop, "出错通知那一轮没有结束", 60000);
    const [notified] = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: ["<task-notification>", "E2E_DWK_BAD_BOARD"],
    });
    expect(notified?.fixtureId).toBe("dwk-c-notified");
    const notifiedBody = JSON.stringify(notified?.requestJson);
    expect(notifiedBody).toContain("<status>errored</status>");
    expect(notifiedBody).toContain("invalid spec");
    expect(notifiedBody).toContain("columns must be a non-empty array");

    // 通知行「工作流出错」带着已发布的两件产物；出错的 run 没有完成卡。
    const notification = await waitForNotificationRow("工作流出错", RUN_C);
    await browser.waitUntil(
      async () =>
        (await notification.$$('[data-testid="workflow-notification-artifact-chip"]').length) === 2,
      { timeout: 30000, timeoutMsg: "出错通知行没有带两件已发布的产物" },
    );
    await expect(completionCard(RUN_C)).not.toBeExisting();

    // run 侧板：「运行出错」写出错误；产物区照样渲染，两张瓦片。
    await domClick($(`${digestOf(runId)} [data-testid="workflow-card-open-details"]`));
    const pane = await runPane(runId);
    await pane.waitForDisplayed({ timeout: 30000 });
    expect(await pane.getAttribute("data-workflow-run-status")).toBe("errored");
    await waitForText(
      pane.$('[data-testid="workflow-run-error"]'),
      "E2E_DWK_BAD_BOARD",
      "run 侧板的错误面板没有点名坏看板",
    );
    expect(await textOf(pane.$('[data-testid="workflow-run-artifacts-count"]'))).toBe("2");
    expect(
      await readAttr(
        pane.$$('button[data-testid="workflow-run-artifact-card"][data-variant="tile"]'),
        "data-artifact-id",
      ),
    ).toEqual(["dwk-empty", "dwk-partial"]);
    // 空看板的缩略写「暂无数据」；半张表的缩略是已报的两行。
    await waitForText(
      tileFrame(pane, "dwk-empty").$('[data-testid="artifact-preset-empty"]'),
      "暂无数据",
      "空看板的缩略没有写「暂无数据」",
    );
    await browser.waitUntil(
      async () =>
        (await tileFrame(pane, "dwk-partial").$$('[data-testid="artifact-table-row"]').length) ===
        2,
      { timeout: 30000, timeoutMsg: "半张表的缩略不是两行" },
    );

    // 空看板全尺寸：标题照常，正文是「暂无数据」，既不是「无法渲染」也没有瓦片。
    await domClick(tileButton(pane, "dwk-empty"));
    const artifact = await artifactPane("dwk-empty");
    await artifact.waitForDisplayed({ timeout: 30000 });
    const presetBody = artifact.$('[data-artifact-body="preset"]');
    await waitForText(
      presetBody.$('[data-testid="artifact-preset-empty"]'),
      "暂无数据",
      "空看板的全尺寸 tab 没有写「暂无数据」",
    );
    expect(await textOf(presetBody)).toContain("E2E 空指标");
    await expect(
      presetBody.$('[data-testid="workflow-run-artifact-preset-invalid"]'),
    ).not.toBeExisting();
    await expect(presetBody.$('[data-testid="artifact-metric-tile"]')).not.toBeExisting();
  });
});

type ElementLike = ChainablePromiseElement | WebdriverIO.Element;

function digestOf(runId: string) {
  return `${RUN_DIGEST}[data-workflow-run-id="${runId}"]`;
}

/** 按工作流名找完成卡（会话里有多张，卡上没有 run id）。 */
function completionCard(name: string) {
  return $(
    `//*[@data-workflow-completion-card="true"][.//*[@data-testid="workflow-card-name" and normalize-space()="${name}"]]`,
  );
}

function runPane(runId: string) {
  return $(`div[data-workflow-run-id="${runId}"]:has([data-testid="workflow-run-artifacts"])`);
}

function artifactPane(artifactId: string) {
  return $(`[data-testid="workflow-artifact-pane"][data-workflow-artifact-id="${artifactId}"]`);
}

/** 瓦片的预览框与按钮是兄弟节点（框里可能有自己的控件，按钮不能嵌按钮）。 */
function tileFrame(pane: ElementLike, artifactId: string) {
  return pane.$(
    `div[data-variant="tile"]:has(> button[data-artifact-id="${artifactId}"]) [data-testid="workflow-artifact-tile-frame"]`,
  );
}

function tileButton(pane: ElementLike, artifactId: string) {
  return pane.$(
    `button[data-testid="workflow-run-artifact-card"][data-variant="tile"][data-artifact-id="${artifactId}"]`,
  );
}

/** 用完成卡的 ⤢ 打开（或切回）run 侧板。 */
async function openRunPaneFromCard(name: string, runId: string) {
  await domClick(completionCard(name).$('[data-testid="workflow-card-open-details"]'));
  const pane = await runPane(runId);
  await pane.waitForDisplayed({ timeout: 30000 });
  return pane;
}

/** DOM 点击：卡片与侧板在滚动容器与进场动画里，坐标点击会被遮挡。 */
async function domClick(target: ElementLike) {
  const element = (await target) as WebdriverIO.Element;
  await element.waitForExist({ timeout: 30000 });
  await browser.execute((node) => (node as unknown as HTMLElement).click(), element);
}

/** 读 DOM 文字本身：折叠 / 进场动画期间 getText 可能读到空串。 */
async function textOf(target: ElementLike): Promise<string> {
  const element = (await target) as WebdriverIO.Element;
  return String((await element.getProperty("textContent")) ?? "").trim();
}

/** 连同各层 shadow root 的文字一起读（代码查看器把正文画在 shadow DOM 里）。 */
async function deepTextOf(target: ElementLike): Promise<string> {
  const element = (await target) as WebdriverIO.Element;
  return browser.execute((node) => {
    const fragments: string[] = [(node as unknown as HTMLElement).textContent ?? ""];
    const visit = (root: ParentNode) => {
      for (const child of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
        if (!child.shadowRoot) continue;
        fragments.push(child.shadowRoot.textContent ?? "");
        visit(child.shadowRoot);
      }
    };
    visit(node as unknown as HTMLElement);
    return fragments.join("\n");
  }, element);
}

async function waitForText(
  target: ElementLike,
  expected: string,
  timeoutMsg: string,
  timeout = 30000,
) {
  let seen = "";
  await browser
    .waitUntil(
      async () => {
        const element = (await target) as WebdriverIO.Element;
        if (!(await element.isExisting())) {
          seen = "<不存在>";
          return false;
        }
        seen = await textOf(element);
        return seen.includes(expected);
      },
      { timeout, interval: 100, timeoutMsg },
    )
    .catch((error: unknown) => {
      // 把最后读到的文字带进失败信息：分清「没画出来」与「画了别的」。
      throw new Error(`${timeoutMsg}；最后读到：${seen.slice(0, 600)}`, { cause: error });
    });
}

async function readAttr(selector: string | ReturnType<typeof $$>, name: string): Promise<string[]> {
  const elements = typeof selector === "string" ? await $$(selector) : await selector;
  const values: string[] = [];
  for (const element of elements) values.push((await element.getAttribute(name)) ?? "");
  return values;
}

async function readMetricValues(scope: ElementLike) {
  const values: Record<string, string> = {};
  for (const tile of await (await scope).$$('[data-testid="artifact-metric-tile"]')) {
    values[(await tile.getAttribute("data-metric-field")) ?? ""] = await textOf(
      tile.$('[data-testid="artifact-metric-value"]'),
    );
  }
  return values;
}

/** 写闸文件：脚本里的 `world.run("node", …)` 看到它就退出，run 越过闸。 */
async function openGate(path: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "open\n");
}

/** 按 kind 词与 run 名找到那一行通知（同一会话里有多条）。 */
async function waitForNotificationRow(kindLabel: string, runName: string) {
  let found: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      for (const row of await $$(NOTIFICATION_ROW)) {
        const text = await textOf(row);
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

/** 发启动指令、批准、等启动轮收尾；从 CreateWorkflow 的工具结果读出 run id。 */
async function launchRun(key: "a" | "b" | "c", prompt: string) {
  await sendV4Prompt(prompt);
  await approveV4Permission();
  const toolCallId = `toolu_dwk_${key}_create`;
  await browser.waitUntil(
    async () => (await getLatestUpstreamToolResultByToolCallId(toolCallId))?.isError === false,
    { timeout: 60000, timeoutMsg: `CreateWorkflow（${key}）未执行成功` },
  );
  const toolResult = await getLatestUpstreamToolResultByToolCallId(toolCallId);
  const launched = /started in the background with ID: (\S+?)\./u.exec(toolResult?.content ?? "");
  expect(launched).not.toBeNull();
  const runId = launched![1]!;
  runIds[key] = runId;
  await waitForV4AssistantMessageContaining(`E2E_DWK_${key.toUpperCase()}_STARTED`, 60000);
  await $(digestOf(runId)).waitForExist({ timeout: 60000 });
  return runId;
}
