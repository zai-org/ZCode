import { open, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_CHAT_SUMMARY_PANEL,
  TID_GIT_PANE,
  TID_TASK_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import type { ChainablePromiseElement } from "webdriverio";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { PROVIDER_READINESS_HISTORY_SESSION_ID } from "#e2e/helpers/provider-readiness-history-fixture";
import { selectV4TaskById } from "#e2e/helpers/v4-conversation";

const CASE_TIMEOUT_MS = 120_000;
const FILE_NAME = "status-panel-review.txt";
const CHANGES_LABELS = ["Changes", "更改"];
const EXPAND_LABELS = ["Expand status", "展开状态"];
const UNSTAGED_LABELS = ["Unstaged", "未暂存"];

describe("SP13：status panel Git Changes 打开变更审阅", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("点击 Changes 后打开 Git pane、选择 unstaged 并显示目标文件", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await waitForTestIdByDom(testId(TID_TASK_ITEM, PROVIDER_READINESS_HISTORY_SESSION_ID), {
      timeout: 30_000,
      timeoutMsg: "SP13 预置的只读历史 session 没有出现在任务列表",
    });
    await selectV4TaskById(PROVIDER_READINESS_HISTORY_SESSION_ID);
    await waitForExpandedStatusPanel();

    expect(await isGitPaneMounted()).toBe(false);
    await clickStatusPanelChanges();
    const review = await waitForGitReview();

    expect(UNSTAGED_LABELS).toContain(review.sourceLabel);
    expect(review.text).toContain(FILE_NAME);
    expect(review.rowCount).toBeGreaterThan(0);
  });

  it("Git 自动刷新跳过超限行数统计且 Host 内存有界", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await selectV4TaskById(PROVIDER_READINESS_HISTORY_SESSION_ID);
    await waitForExpandedStatusPanel();
    // 通过真实文件 watcher 刷新；无需打开 Git pane，也不创建会话或调用模型。
    const caseRoot = join(DEFAULT_WORKSPACE, ".zcode-e2e/conversation-session-git-review-entry");
    const largeText = "large-untracked.txt";
    await browser.electron.execute((electron) => {
      const state = globalThis as typeof globalThis & {
        gitMemoryProbe?: { baseline: number; peak: number; timer: ReturnType<typeof setInterval> };
      };
      const readHostKb = () =>
        electron.app
          .getAppMetrics()
          .filter((metric) => metric.name?.startsWith("zcode-host"))
          .reduce((total, metric) => total + metric.memory.workingSetSize, 0);
      const baseline = readHostKb();
      if (!baseline) throw new Error("没有找到待采样的真实 Host 进程");
      const probe = {
        baseline,
        peak: baseline,
        timer: setInterval(() => {
          probe.peak = Math.max(probe.peak, readHostKb());
        }, 25),
      };
      state.gitMemoryProbe = probe;
    });
    try {
      await writeFile(join(caseRoot, largeText), "line\n".repeat(300_000));
      for (let index = 0; index < 8; index++) {
        const file = await open(join(caseRoot, `large-${index}.bin`), "w");
        try {
          await file.truncate(32 * 1024 * 1024);
        } finally {
          await file.close();
        }
      }
      await writeFile(join(caseRoot, FILE_NAME), "one\ntwo\nthree\nfour\n");
      // Linux 只监听 Git 元数据；触发同一自动刷新入口，避免依赖递归文件监听。
      const changedAt = new Date();
      await utimes(join(DEFAULT_WORKSPACE, ".git", "HEAD"), changedAt, changedAt);
      await browser.waitUntil(
        async () => {
          const changes = await findButtonByLabels(
            $(`[data-testid="${TID_CHAT_SUMMARY_PANEL}"]`),
            CHANGES_LABELS,
          );
          return Boolean(changes && /\+4\s+-0/u.test(await changes.getText()));
        },
        // 产品的 watcher 防抖为 60 秒；等到新快照后才判断内存。
        {
          timeout: 90_000,
          interval: 500,
          timeoutMsg: "自动刷新应更新小文件为 +4，大文本不应计入行数",
        },
      );
    } finally {
      const memory = await browser.electron.execute(() => {
        const state = globalThis as typeof globalThis & {
          gitMemoryProbe?: {
            baseline: number;
            peak: number;
            timer: ReturnType<typeof setInterval>;
          };
        };
        const probe = state.gitMemoryProbe;
        if (!probe) throw new Error("Host 内存探针不存在");
        clearInterval(probe.timer);
        delete state.gitMemoryProbe;
        return {
          baselineKb: probe.baseline,
          peakKb: probe.peak,
          deltaKb: probe.peak - probe.baseline,
        };
      });
      console.log("[git-untracked-memory]", JSON.stringify(memory));
      // 256 MiB 文件应在读取前跳过；为真实 Electron 噪声留出 96 MiB 余量。
      expect(memory.deltaKb).toBeLessThan(96 * 1024);
    }
  });
});

async function waitForExpandedStatusPanel() {
  await waitForTestIdByDom(TID_CHAT_SUMMARY_PANEL, {
    timeout: 30_000,
    timeoutMsg: "SP13 未显示包含 Git Tools 的 status panel",
  });

  const panel = $(`[data-testid="${TID_CHAT_SUMMARY_PANEL}"]`);
  // auto 布局的 data-state 也是 expanded，但窄容器只显示“展开状态”摘要。
  // 必须确认真实审阅按钮可见，不能把摘要里的“更改”文字当作审阅入口。
  if (!(await findButtonByLabels(panel, CHANGES_LABELS))) {
    const expandButton = await findButtonByLabels(panel, EXPAND_LABELS);
    if (!expandButton) {
      throw new Error("SP13 status panel 处于收起态，但没有可点击的展开入口");
    }
    await expandButton.click();
  }

  await browser.waitUntil(
    async () =>
      (await panel.getAttribute("data-state")) === "expanded" &&
      Boolean(await findButtonByLabels(panel, CHANGES_LABELS)),
    {
      timeout: 30_000,
      timeoutMsg: "SP13 status panel 展开后没有可点击的 Changes / 更改入口",
    },
  );
}

async function clickStatusPanelChanges() {
  const panel = $(`[data-testid="${TID_CHAT_SUMMARY_PANEL}"]`);
  const changesButton = await findButtonByLabels(panel, CHANGES_LABELS);
  if (!changesButton) {
    throw new Error("SP13 没有找到 Changes / 更改按钮");
  }
  expect(await changesButton.isEnabled()).toBe(true);
  // 失败时保留真实输入和只读导航证据，区分按钮未命中、只读目录及面板状态未提交。
  await browser.execute(() => {
    const trace: string[] = [];
    (window as Window & { __gitReviewClickTrace?: string[] }).__gitReviewClickTrace = trace;
    document.addEventListener(
      "click",
      (event) => {
        if (trace.length < 8)
          trace.push((event.target as Element)?.closest("button")?.outerHTML ?? "non-button");
      },
      { capture: true },
    );
  });
  await changesButton.click();
}

async function findButtonByLabels(root: ChainablePromiseElement, labels: readonly string[]) {
  const buttons = await root.$$("button");
  for (const button of buttons) {
    if (!(await button.isDisplayed())) continue;
    const text = (await button.getText()).trim();
    const firstLine = text.split(/\r?\n/u, 1)[0] ?? "";
    const ariaLabel = (await button.getAttribute("aria-label"))?.trim() ?? "";
    if (labels.includes(ariaLabel || firstLine)) {
      return button;
    }
  }
  return null;
}

function isGitPaneMounted() {
  return browser.execute(
    (gitPaneTestId) => Boolean(document.querySelector(`[data-testid="${gitPaneTestId}"]`)),
    TID_GIT_PANE,
  );
}

interface GitReviewSnapshot {
  rowCount: number;
  sourceLabel: string;
  text: string;
}

async function waitForGitReview() {
  let latest: GitReviewSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await readGitReviewSnapshot();
        return (
          UNSTAGED_LABELS.includes(latest.sourceLabel) &&
          latest.text.includes(FILE_NAME) &&
          latest.rowCount > 0
        );
      },
      {
        timeout: 30_000,
        timeoutMsg: "SP13 Git review 没有显示 unstaged 目标文件",
      },
    );
  } catch (error) {
    latest = await readGitReviewSnapshot().catch(() => latest);
    const navigation = await browser.execute(() => {
      const bridge = window as Window & {
        __gitReviewClickTrace?: string[];
        __zcodeTabStoreE2E?: {
          getState(): { tabs: unknown[]; activeWorkspacePath: string | null };
        };
      };
      return {
        clickTrace: bridge.__gitReviewClickTrace,
        navigation: bridge.__zcodeTabStoreE2E?.getState().tabs,
        activePath: bridge.__zcodeTabStoreE2E?.getState().activeWorkspacePath,
        interfaceMode: localStorage.getItem("zcode-interface-mode"),
        sidePaneTabs: [...document.querySelectorAll("[data-side-pane-tab-id]")].map((el) => ({
          id: el.getAttribute("data-side-pane-tab-id"),
          state: el.getAttribute("data-state"),
          text: el.textContent,
        })),
      };
    });
    throw new Error(`SP13 Git review 断言失败: ${JSON.stringify({ ...latest, navigation })}`, {
      cause: error,
    });
  }
  return readGitReviewSnapshot();
}

function readGitReviewSnapshot(): Promise<GitReviewSnapshot> {
  return browser.execute((gitPaneTestId) => {
    const pane = document.querySelector<HTMLElement>(`[data-testid="${gitPaneTestId}"]`);
    const sourceTrigger = pane?.querySelector<HTMLElement>('[data-slot="select-trigger"]');
    return {
      rowCount: pane?.querySelectorAll("[data-git-pane-change-virtual-row]").length ?? 0,
      sourceLabel: sourceTrigger?.textContent?.trim() ?? "",
      text: pane?.innerText ?? "",
    };
  }, TID_GIT_PANE);
}
