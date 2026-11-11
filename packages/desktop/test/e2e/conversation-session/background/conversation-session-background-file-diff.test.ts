// BG41：background Agent 在父 launch turn 已 idle 后完成，独立 model-only turn
// 修改文件时仍必须能用隐藏 messageId 查询 checkpoint 并打开真实 Diff。
// 本 case 只覆盖 local desktop-continuous + 单 Agent + 单文件 Read/Edit；
// active-loop、batch、rewind、cold start、remote/replayable 由 catalog 剪枝。
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_PREVIEW_PANE } from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  findFirstUpstreamRequestIndex,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";
import {
  assertVisibleV4UserMessagesNotContaining,
  clickV4Stop,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_ROOT = join(DEFAULT_WORKSPACE, "background-file-diff-e2e");
const RELATIVE_PATH = "background-file-diff-e2e/result.md";
const FILE_PATH = join(DEFAULT_WORKSPACE, RELATIVE_PATH);
const REQUEST_MARKER = "E2E_BACKGROUND_FILE_DIFF";
const CHILD_MARKER = "E2E_BACKGROUND_FILE_DIFF_CHILD_DONE";
const LAUNCH_MARKER = "background-file-diff-agent-launched-ok";
const FINAL_MARKER = "background-file-diff-ok";
const INITIAL_CONTENT = "before-background-diff\n";
const EXPECTED_CONTENT = "after-background-diff\n";

interface FileSummarySnapshot {
  diffUnavailable: boolean;
  expanded: boolean;
  headerText: string;
  pathVisible: boolean;
  reviewEnabled: boolean;
  turnText: string;
}

describe("BG41 background model-only turn 文件 Diff", () => {
  afterEach(async () => {
    await stopIfBusy();
    await rm(CASE_ROOT, { force: true, recursive: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("父 turn idle 后的 notification Read/Edit 摘要可展开并打开真实 before/after Diff", async function () {
    this.timeout(240000);

    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
    await rm(CASE_ROOT, { force: true, recursive: true });
    await mkdir(CASE_ROOT, { recursive: true });
    await writeFile(FILE_PATH, INITIAL_CONTENT, "utf8");

    const firstExistingRecordIndex = (await getUpstreamRequestRecordCount()) - 1;
    await sendV4Prompt(
      `${REQUEST_MARKER}: launch one background Agent, then update ${RELATIVE_PATH} only after its completion notification.`,
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_file_diff_agent", 60000);
    await waitForUpstreamRequest(
      {
        lastUserMessageIncludes: ["E2E_BACKGROUND_FILE_DIFF_CHILD"],
      },
      "BG41 background child provider request 没有开始",
      60000,
      { afterIndex: firstExistingRecordIndex },
    );
    await waitForV4TimelineContaining(LAUNCH_MARKER, 60000);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "BG41 父 launch turn 没有在 child completion 前回到 idle",
      45000,
    );

    // Bug 复现前提：必须先观察到父轮稳定 idle，再允许 child 的延迟响应完成；
    // 否则 notification 可能合流 active loop，无法覆盖 model-only 隐藏 messageId。
    await browser.pause(500);
    expect((await getV4PaneSnapshot()).canStop).toBe(false);
    expect(
      await findFirstUpstreamRequestIndex(
        {
          includes: [REQUEST_MARKER, "<task-notification>", CHILD_MARKER],
          lastUserMessageIncludes: ["<task-notification>", CHILD_MARKER],
        },
        { afterIndex: firstExistingRecordIndex },
      ),
    ).toBeNull();

    await waitForUpstreamRequest(
      {
        includes: [REQUEST_MARKER, "<task-notification>", CHILD_MARKER],
        lastUserMessageIncludes: ["<task-notification>", CHILD_MARKER],
      },
      "BG41 child completion 没有触发独立 model-only notification request",
      60000,
      { afterIndex: firstExistingRecordIndex },
    );
    await waitForUpstreamRequest(
      {
        includes: ["toolu_e2e_background_file_diff_read", "before-background-diff"],
      },
      "BG41 Read 结果没有进入 notification product turn",
      60000,
      { afterIndex: firstExistingRecordIndex },
    );
    await waitForToolCallBlockByToolCallId("toolu_e2e_background_file_diff_edit", 60000);
    await waitForV4TimelineContaining(FINAL_MARKER, 90000);
    await waitForFileContent(EXPECTED_CONTENT);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "BG41 notification Read/Edit 完成后没有回到 idle",
      60000,
    );

    await assertVisibleV4UserMessagesNotContaining("<task-notification>");
    await assertVisibleV4UserMessagesNotContaining(CHILD_MARKER);

    const collapsed = await waitForFileSummary(false);
    expect(collapsed.headerText).toMatch(/1 (file changed|个文件已更改)/);
    expect(collapsed.headerText).toContain("+1");
    expect(collapsed.headerText).toContain("-1");
    expect(collapsed.turnText).toContain(FINAL_MARKER);

    await expandFileSummary();
    const expanded = await waitForFileSummary(true);
    expect(expanded.pathVisible).toBe(true);
    expect(expanded.reviewEnabled).toBe(true);
    expect(expanded.diffUnavailable).toBe(false);
    expect(expanded.turnText).toContain(FINAL_MARKER);

    await clickFileSummaryReview();
    await waitForPreviewDiff();
  });
});

async function stopIfBusy() {
  const snapshot = await getV4PaneSnapshot().catch(() => null);
  if (!snapshot?.canStop) return;
  await clickV4Stop().catch(() => undefined);
  await waitForV4Pane(
    (candidate) => !candidate.canStop,
    "BG41 清理阶段主会话没有退出 running",
    30000,
  ).catch(() => undefined);
}

async function waitForFileContent(expected: string) {
  await browser.waitUntil(
    async () => (await readFile(FILE_PATH, "utf8").catch(() => "")) === expected,
    {
      timeout: 60000,
      timeoutMsg: `${FILE_PATH} 没有收敛到期望内容`,
    },
  );
}

async function waitForFileSummary(expectExpanded: boolean): Promise<FileSummarySnapshot> {
  let latest: FileSummarySnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readFileSummary();
      return Boolean(
        latest &&
        latest.expanded === expectExpanded &&
        (!expectExpanded ||
          (latest.pathVisible && latest.reviewEnabled && !latest.diffUnavailable)),
      );
    },
    {
      timeout: 30000,
      timeoutMsg: expectExpanded
        ? `BG41 文件摘要展开后没有返回 ${RELATIVE_PATH} 的可审查 Diff`
        : "BG41 notification 产品轮次没有显示文件变更摘要",
    },
  );
  if (!latest) throw new Error("BG41 文件变更摘要快照为空");
  return latest;
}

function readFileSummary(): Promise<FileSummarySnapshot | null> {
  return browser.execute((relativePath) => {
    const expandLabels = new Set(["Expand changed files", "展开已更改文件"]);
    const collapseLabels = new Set(["Collapse changed files", "收起已更改文件"]);
    const reviewLabels = new Set(["Review", "审查"]);
    const header = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => {
        const label = button.getAttribute("aria-label") ?? "";
        return expandLabels.has(label) || collapseLabels.has(label);
      },
    );
    if (!header) return null;
    const card = header.parentElement?.parentElement;
    const turn = header.closest<HTMLElement>("[data-turn-key]");
    const label = header.getAttribute("aria-label") ?? "";
    const review = Array.from(card?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => reviewLabels.has(button.getAttribute("aria-label") ?? ""),
    );
    const cardText = (card?.innerText ?? "").replace(/\u00a0/g, " ");
    return {
      diffUnavailable:
        cardText.includes("暂时无法预览这份 Diff") ||
        cardText.includes("Diff preview is temporarily unavailable"),
      expanded: collapseLabels.has(label),
      headerText: (header.innerText ?? "").replace(/\u00a0/g, " ").trim(),
      pathVisible: Boolean(
        card &&
        Array.from(card.querySelectorAll<HTMLElement>("[title]")).some((element) =>
          (element.getAttribute("title") ?? "").endsWith(relativePath),
        ),
      ),
      reviewEnabled: Boolean(review && !review.disabled),
      turnText: (turn?.innerText ?? "").replace(/\u00a0/g, " ").trim(),
    };
  }, RELATIVE_PATH);
}

async function expandFileSummary() {
  const clicked = await browser.execute(() => {
    const labels = new Set(["Expand changed files", "展开已更改文件"]);
    const header = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => labels.has(button.getAttribute("aria-label") ?? ""),
    );
    header?.click();
    return Boolean(header);
  });
  expect(clicked).toBe(true);
}

async function clickFileSummaryReview() {
  const clicked = await browser.execute(() => {
    const collapseLabels = new Set(["Collapse changed files", "收起已更改文件"]);
    const reviewLabels = new Set(["Review", "审查"]);
    const header = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => collapseLabels.has(button.getAttribute("aria-label") ?? ""),
    );
    const card = header?.parentElement?.parentElement;
    const review = Array.from(card?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => reviewLabels.has(button.getAttribute("aria-label") ?? ""),
    );
    if (!review || review.disabled) return false;
    review.click();
    return true;
  });
  expect(clicked).toBe(true);
}

async function waitForPreviewDiff() {
  let latest = "";
  await browser.waitUntil(
    async () => {
      latest = await browser.execute((previewPaneTestId) => {
        const preview = document.querySelector<HTMLElement>(`[data-testid="${previewPaneTestId}"]`);
        if (!preview) return "";
        // 原因：文件标题已通过 portal 放到 FileManager 共享头部，不能只在 PreviewPane body 内找文件名。
        const fileManager = preview.closest<HTMLElement>("[data-file-manager-pane]");
        const fragments: string[] = [fileManager?.innerText ?? preview.innerText ?? ""];
        const visit = (root: ParentNode) => {
          for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
            if (!element.shadowRoot) continue;
            fragments.push(element.shadowRoot.textContent ?? "");
            visit(element.shadowRoot);
          }
        };
        visit(preview);
        return fragments.join("\n").replace(/\u00a0/g, " ");
      }, TID_PREVIEW_PANE);
      return (
        latest.includes("result.md") &&
        latest.includes("before-background-diff") &&
        latest.includes("after-background-diff")
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `BG41 Review 没有打开真实 before/after Diff: ${latest}`,
    },
  );
}
