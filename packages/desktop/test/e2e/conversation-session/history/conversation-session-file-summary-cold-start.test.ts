// O16：完整重启 Electron / Host / CLI 后，已完成轮次的文件变更摘要仍需从持久数据冷物化。
// 该 case 只覆盖 local desktop-continuous + 单次 Write；多文件、reverted、remote/replayable
// 继续由 O10-O14 及对应 focused tests 覆盖，避免把不同恢复语义混进一个窗口级证据。
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  switchV4Mode,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const CASE_ROOT = join(DEFAULT_WORKSPACE, "file-summary-cold-start-e2e");
const RELATIVE_PATH = "file-summary-cold-start-e2e/summary.txt";
const FILE_PATH = join(DEFAULT_WORKSPACE, RELATIVE_PATH);
const REQUEST_MARKER = "E2E_FILE_SUMMARY_COLD_START";
const FINAL_MARKER = "E2E_FILE_SUMMARY_COLD_START_OK";

interface FileSummarySnapshot {
  expanded: boolean;
  headerText: string;
  pathVisible: boolean;
}

describe("O16 cold start 文件变更摘要", () => {
  afterEach(async () => {
    await rm(CASE_ROOT, { force: true, recursive: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("单次 Write 完成后完整冷启动仍显示相同摘要并可展开文件", async function () {
    this.timeout(240000);
    await rm(CASE_ROOT, { force: true, recursive: true });
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");

    const prompt = `${REQUEST_MARKER}: create ${RELATIVE_PATH} with the requested fixture content.`;
    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(FINAL_MARKER, 90000);
    await waitForFileContent("cold-summary-line-1\ncold-summary-line-2\n");
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "文件摘要 cold-start case 完成后没有回到 idle",
      60000,
    );

    const liveSummary = await waitForFileSummary();
    expect(liveSummary.headerText).toMatch(/1 (file changed|个文件已更改)/);
    expect(liveSummary.headerText).toContain("+2");
    expect(liveSummary.headerText).toContain("-0");

    const sessionId = (await getV4PaneSnapshot()).sessionId;
    if (!sessionId || sessionId === "draft") {
      throw new Error(`文件摘要 case 没有真实 sessionId: ${sessionId ?? "null"}`);
    }

    // 修复原因：renderer reload 仍可能复用 CLI 内存事件，无法复现本 bug；reloadSession
    // 会同时重启 Electron、Host 与 CLI，强制摘要只从 transcript + workspace checkpoint 恢复。
    await reloadAppAndRestoreV4Session(sessionId);
    await waitForV4TimelineContaining(FINAL_MARKER, 60000);

    const coldSummary = await waitForFileSummary();
    expect(coldSummary.headerText).toBe(liveSummary.headerText);
    expect(coldSummary.expanded).toBe(false);

    await expandFileSummary();
    const expandedSummary = await waitForFileSummary(true);
    expect(expandedSummary.pathVisible).toBe(true);
    expect(expandedSummary.headerText).toBe(liveSummary.headerText);
    expect((await getV4PaneSnapshot()).sessionId).toBe(sessionId);
  });
});

async function waitForFileContent(expected: string) {
  await browser.waitUntil(
    async () => (await readFile(FILE_PATH, "utf8").catch(() => "")) === expected,
    {
      timeout: 60000,
      timeoutMsg: `${FILE_PATH} 没有收敛到期望内容`,
    },
  );
}

async function waitForFileSummary(expectExpanded = false): Promise<FileSummarySnapshot> {
  let latest: FileSummarySnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readFileSummary();
      return Boolean(
        latest && latest.expanded === expectExpanded && (!expectExpanded || latest.pathVisible),
      );
    },
    {
      timeout: 30000,
      timeoutMsg: expectExpanded
        ? `文件摘要展开后没有显示 ${RELATIVE_PATH}`
        : "没有找到已完成轮次的文件变更摘要卡片",
    },
  );
  if (!latest) throw new Error("文件变更摘要快照为空");
  return latest;
}

function readFileSummary(): Promise<FileSummarySnapshot | null> {
  return browser.execute((relativePath) => {
    const expandLabels = new Set(["Expand changed files", "展开已更改文件"]);
    const collapseLabels = new Set(["Collapse changed files", "收起已更改文件"]);
    const header = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => {
        const label = button.getAttribute("aria-label") ?? "";
        return expandLabels.has(label) || collapseLabels.has(label);
      },
    );
    if (!header) return null;
    const card = header.parentElement?.parentElement;
    const label = header.getAttribute("aria-label") ?? "";
    return {
      expanded: collapseLabels.has(label),
      headerText: (header.innerText ?? "").replace(/\u00a0/g, " ").trim(),
      // FileDisplayInline 会把目录与文件名拆成两个文本节点，不能用连续 innerText
      // 匹配相对路径；详情行的 title 保留完整路径，正好能证明明细查询已返回目标文件。
      pathVisible: Boolean(
        card &&
        Array.from(card.querySelectorAll<HTMLElement>("[title]")).some((element) =>
          (element.getAttribute("title") ?? "").endsWith(relativePath),
        ),
      ),
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

async function reloadAppAndRestoreV4Session(sessionId: string) {
  await browser.reloadSession();
  await waitForRendererAfterReloadSession();
  // reloadSession 后 Electron service bridge 可能晚于 renderer DOM 恢复；这里的产品证据
  // 只依赖 renderer → Host → CLI 链路，直接等待任务项可点击可避免 bridge 重连假失败。
  await selectV4TaskById(sessionId);
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === sessionId,
    `CLI cold restart 后没有恢复 session ${sessionId}`,
    60000,
  );
}

async function waitForRendererAfterReloadSession() {
  await browser.waitUntil(
    async () => {
      try {
        const puppeteer = await browser.getPuppeteer();
        const rendererTarget = puppeteer
          .targets()
          .filter((target) => isRendererUrl(target.url()))
          .at(-1);
        const targetId = rendererTarget
          ? ((rendererTarget as unknown as { _targetId?: string })._targetId ?? null)
          : null;
        if (!targetId) return false;
        await browser.switchToWindow(targetId);
        return true;
      } catch {
        // reloadSession 后旧 CDP websocket 会短暂断开，等待新 renderer target 即可。
        return false;
      }
    },
    {
      timeout: 30000,
      interval: 250,
      timeoutMsg: "CLI cold restart 后没有找到 renderer target",
    },
  );
}

function isRendererUrl(url: string) {
  try {
    return new URL(url).pathname.endsWith("/renderer/index.html");
  } catch {
    return false;
  }
}
