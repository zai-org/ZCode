import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, seedSettings } from "#e2e/helpers/desktop-app";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import { resolveE2ERuntimePath, resolveE2EToolPath } from "#e2e/helpers/e2e-runtime-paths";
import {
  E2E_REPLY_TOKEN,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";
import { expandAssistantHistoriesWithContent } from "#e2e/helpers/conversation-session-tool-diagnostics";
import { expandVisibleSummaryGroups } from "#e2e/helpers/conversation-session-tool-diagnostics";

const CASE_NAME = "conversation-session-tool-groups-history-restore";
const CASE_MARKER = "E2E_TOOL_GROUPS_HISTORY_RESTORE";
const RUNTIME_ROOT = resolveE2ERuntimePath(CASE_NAME);
const READ_PATH = resolveE2EToolPath(CASE_NAME, "read.txt");
const WRITE_PATH = resolveE2EToolPath(CASE_NAME, "write.ts");

describe("TGE05 individual tools history restore", () => {
  before(async function () {
    this.timeout(150000);
    await seedSettings({});
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
  });

  afterEach(async () => {
    await rm(RUNTIME_ROOT, { recursive: true, force: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("连续同类工具逐条显示，完整冷重启后保持内容与顺序", async function () {
    this.timeout(240000);
    await prepareFixture();
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(
      [
        `${CASE_MARKER}: Follow these tool steps in order.`,
        `1. Read ${READ_PATH} twice as two separate tool calls.`,
        `2. Run two separate Bash calls: node -e "console.log('TGE05_EXEC_A')" and node -e "console.log('TGE05_EXEC_B')"`,
        `3. Write ${WRITE_PATH} with exactly "export const restored = true;\\n", then Edit true to false.`,
        `4. Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
      ].join(" "),
    );
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 150000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "TGE05 工具轮没有结束", 150000);
    const history = await $("[data-testid^=chat-assistant-history-trigger-]");
    await expect(history).toBeDisplayed();
    await expect(history).toHaveAttribute("data-history-open", "false");
    await expandAssistantHistoriesWithContent();
    const liveGroups = await waitForIndividualTools();
    // 工具摘要字段用布局间距分隔，不能重新插入装饰性中点。
    for (const group of liveGroups) expect(group.summaryText).not.toContain("·");

    const labelWeights = await browser.execute(() =>
      Array.from(document.querySelectorAll(".tool-summary-kind-label")).map(
        (label) => getComputedStyle(label).fontWeight,
      ),
    );
    expect(labelWeights.length).toBeGreaterThan(0);
    expect(labelWeights.every((weight) => weight === "400")).toBe(true);

    // 外层收纳与内部工具分组独立：整段可收起，重新展开后工具列表仍可使用。
    await history.click();
    await expect(history).toHaveAttribute("data-history-open", "false");
    await expect($("[data-summary-group-trigger]")).not.toBeDisplayed();
    await history.click();
    await expect(history).toHaveAttribute("data-history-open", "true");
    await waitForIndividualTools();

    const sessionId = (await getV4PaneSnapshot()).sessionId;
    if (!sessionId || sessionId === "draft") throw new Error("TGE05 缺少 sessionId");
    await reloadAndRestoreSession(sessionId);
    await expandAssistantHistoriesWithContent();
    const restoredGroups = await waitForIndividualTools();
    for (const group of restoredGroups) expect(group.summaryText).not.toContain("·");

    expect(toStableToolEvidence(restoredGroups)).toEqual(toStableToolEvidence(liveGroups));
    expect((await getV4PaneSnapshot()).sessionId).toBe(sessionId);
  });
});

async function prepareFixture() {
  await rm(RUNTIME_ROOT, { recursive: true, force: true });
  await mkdir(RUNTIME_ROOT, { recursive: true });
  await writeFile(join(RUNTIME_ROOT, "read.txt"), "TGE05_READ\n", "utf8");
}

async function waitForIndividualTools() {
  const group = await $("[data-consecutive-summary-group]");
  // 外层收起动画会短暂保留隐藏 DOM；必须等重新展开可见后再读取内部摘要。
  await group.waitForDisplayed({ timeout: 60000 });
  await expect(group).toHaveAttribute("data-group-running", "false");
  await expect(group.$("[data-summary-group-statistics]")).toExist();
  // Explore / Run 混合统计不进入仅 Change 文件列表分支。
  await expect(group.$("[data-change-summary-files]")).not.toExist();
  expect(await group.$("[data-summary-group-statistics]").getAttribute("class")).not.toContain(
    "animated-gradient-text",
  );
  const trigger = await group.$("[data-summary-group-trigger]");
  await expect(group.$("[data-summary-group-icon] svg")).toExist();
  expect(await group.$("[data-summary-group-icon]").getText()).toBe("");
  await expect(
    group.$("[data-summary-group-icon] [role=button], [data-summary-group-icon] button"),
  ).not.toExist();
  await expect(trigger).toHaveText(
    /Explored 2 items, Ran 2 commands, Changed 1 file|已查阅 2 项，已执行 2 次，已修改 1 文件/u,
  );
  await expandVisibleSummaryGroups();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  // 重试扫描只能展开收起组，不能把已展开组再次切回收起。
  await expandVisibleSummaryGroups();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  type ToolEvidence = { toolCallId: string; toolName: string; status: string; summaryText: string };
  let latest: ToolEvidence[] = [];
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-tool-call-id][data-tool-name]"))
          .filter((block) => !block.parentElement?.closest("[data-tool-call-id]"))
          .map((block) => ({
            toolCallId: block.dataset.toolCallId ?? "",
            toolName: block.dataset.toolName ?? "",
            status: block.dataset.status ?? "",
            summaryText: block.innerText.trim(),
          })),
      );
      return latest.length === 6 && latest.every((tool) => tool.status === "completed");
    },
    { timeout: 60000, timeoutMsg: "连续工具没有逐条显示六个完成行" },
  );
  expect(latest.map((tool) => tool.toolName)).toEqual([
    "Read",
    "Read",
    "Bash",
    "Bash",
    "Write",
    "Edit",
  ]);
  // 分组子项完成后使用过去式，不能退回工具类型名；实时与冷恢复共用断言。
  for (const tool of latest) {
    if (tool.toolName === "Bash") expect(tool.summaryText).toMatch(/Ran|已执行/u);
    if (tool.toolName === "Write") expect(tool.summaryText).toMatch(/Wrote|已写入/u);
    if (tool.toolName === "Edit") expect(tool.summaryText).toMatch(/Edited|已编辑/u);
  }
  expect(new Set(latest.map((tool) => tool.toolCallId)).size).toBe(6);
  expect(latest.some((tool) => /^(explore|execute|changes|cua):/.test(tool.toolCallId))).toBe(
    false,
  );
  return latest;
}

function toStableToolEvidence(tools: Awaited<ReturnType<typeof waitForIndividualTools>>) {
  return tools.map(({ toolCallId, toolName, status, summaryText }) => ({
    toolCallId,
    toolName,
    status,
    summaryText,
  }));
}

async function reloadAndRestoreSession(sessionId: string) {
  // 冷恢复必须保留 Chromium profile；不把临时新 profile 当作用户重启。
  await restartIntoWorkspacePreservingProfile();
  await selectV4TaskById(sessionId);
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `TGE05 没有恢复 session ${sessionId}`,
    60000,
  );
  await waitForRestoredSessionStable(sessionId, "TGE05 cold restore 没有稳定显示原会话");
}

async function waitForRestoredSessionStable(sessionId: string, failureMessage: string) {
  let stableSince = 0;
  await browser.waitUntil(
    async () => {
      const snapshot = await getV4PaneSnapshot();
      const matches =
        snapshot.sessionId === sessionId && snapshot.timelineText.includes(E2E_REPLY_TOKEN);
      if (!matches) {
        stableSince = 0;
        return false;
      }
      stableSince ||= Date.now();
      return Date.now() - stableSince >= 1000;
    },
    { timeout: 60000, timeoutMsg: failureMessage },
  );
}
