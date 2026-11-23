import { waitForControlledReplay, releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { openStatusCapsule } from "#e2e/helpers/status-capsule";
import { open, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_GIT_PANE, TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import type { ChainablePromiseElement } from "webdriverio";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { PROVIDER_READINESS_HISTORY_SESSION_ID } from "#e2e/helpers/provider-readiness-history-fixture";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
  selectV4TaskById,
} from "#e2e/helpers/v4-conversation";

const CASE_TIMEOUT_MS = 120_000;
const FILE_NAME = "status-panel-review.txt";
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

    // 连接就绪会兑现暂存的输入框聚焦；用户已打开的 Git 浮层不能因此被关闭。
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="v4-composer-input"]').getAttribute("contenteditable")) === "true",
    );
    await browser.executeAsync((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    expect(await $('[data-status-capsule-content="git"]').isDisplayed()).toBe(true);

    // 分支入口复用真实服务；嵌套弹层关闭后仍能继续访问 Git 操作区。
    const branchTrigger = await $('[data-testid="status-git-current-branch"] button');
    await branchTrigger.waitForDisplayed();
    expect(await branchTrigger.getAttribute("title")).toBeTruthy();
    await branchTrigger.click();
    await $("[cmdk-input]").waitForDisplayed();
    await browser.keys("Escape");
    await $("[cmdk-input]").waitForExist({ reverse: true });
    // 嵌套菜单关闭后焦点应返回分支按钮，不能迟到地跳回输入框并关闭下一次菜单。
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.activeElement ===
            document.querySelector('[data-testid="status-git-current-branch"] button'),
        ),
      { timeout: 5000 },
    );
    await openStatusCapsule("git");

    await $('[data-testid="status-git-current-branch"] button').click();
    await $("[cmdk-input]").waitForDisplayed();
    const createAction = await findButtonByLabels(
      $('[data-slot="popover-content"]:has([cmdk-input])'),
      ["Create and switch to new branch...", "创建并检出新分支..."],
    );
    if (!createAction) throw new Error("分支菜单缺少新建分支入口");
    await createAction.click();
    await $('[role="dialog"]').waitForDisplayed();
    await $('[data-status-capsule-content="git"]').waitForExist({ reverse: true });
    await $("#git-branch-switcher-create-input").setValue("e2e-git-action-host");
    // 中文实际文案为“创建并切换”；使用所属表单的 submit 语义，避免语言差异误报缺失。
    const createSubmit = $(
      '[role="dialog"] form:has(#git-branch-switcher-create-input) button[type="submit"]',
    );
    await createSubmit.waitForEnabled();
    await createSubmit.click();
    await $('[role="dialog"]').waitForExist({ reverse: true });
    await openStatusCapsule("git");
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="status-git-current-branch"] button').getAttribute("title")) ===
        "e2e-git-action-host",
      { timeout: 10000 },
    );
    await $('[data-testid="status-git-current-branch"] button').click();
    await $("[cmdk-input]").waitForDisplayed();
    const graphAction = await findButtonByLabels(
      $('[data-slot="popover-content"]:has([cmdk-input])'),
      ["Git graph", "Git Graph", "Git 图谱"],
    );
    if (!graphAction) throw new Error("分支菜单缺少 Git 图谱入口");
    await graphAction.click();
    await $('[role="dialog"]').waitForDisplayed();
    await $('[data-status-capsule-content="git"]').waitForExist({ reverse: true });
    await $("[cmdk-input]").waitForExist({ reverse: true });
    await browser.keys("Escape");
    await $('[role="dialog"]').waitForExist({ reverse: true });
    expect(await $('[data-status-capsule-content="git"]').isExisting()).toBe(false);
    await openStatusCapsule("git");

    expect(await isGitPaneMounted()).toBe(false);
    await clickStatusPanelChanges();
    const review = await waitForGitReview();

    expect(UNSTAGED_LABELS).toContain(review.sourceLabel);
    expect(review.text).toContain(FILE_NAME);
    expect(review.rowCount).toBeGreaterThan(0);
  });

  it("整轮成功完成后不等 watcher 防抖就刷新 Git 文件", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await prepareV4ConversationE2E();
    await browser.execute(() =>
      document
        .querySelector('[data-testid="v4-composer-input"]')
        ?.setAttribute("data-git-scope-retained", "yes"),
    );
    await sendV4Prompt("E2E_GIT_TURN_REFRESH 等待受控完成");
    await waitForControlledReplay("git-turn-refresh");
    expect(
      await $('[data-testid="v4-composer-input"]').getAttribute("data-git-scope-retained"),
    ).toBe("yes");
    const name = "turn-completion-refresh.txt";
    try {
      await writeFile(join(DEFAULT_WORKSPACE, name), "completed turn refresh\n", "utf8");
      await releaseControlledReplay("git-turn-refresh");
      await waitForV4TimelineContaining("E2E_GIT_TURN_DONE", 15000);
      await openStatusCapsule("git");
      await browser.waitUntil(
        async () => (await $('[data-status-capsule-content="git"]').getText()).includes(name),
        {
          timeout: 15000,
          timeoutMsg: "整轮完成后 Git 列表未及时刷新",
        },
      );
    } finally {
      await rm(join(DEFAULT_WORKSPACE, name), { force: true });
    }
  });

  it("Git 自动刷新跳过超限行数统计且 Host 内存有界", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await browser.execute(() =>
      document
        .querySelector("[data-v4-timeline-scroll]")
        ?.setAttribute("data-git-task-retained", "yes"),
    );
    await selectV4TaskById(PROVIDER_READINESS_HISTORY_SESSION_ID);
    expect(await $("[data-v4-timeline-scroll]").getAttribute("data-git-task-retained")).toBe("yes");
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
          const text = await $('[data-status-capsule="git"]').getText();
          return /\+4\s+[−-]0/u.test(text);
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
  await openStatusCapsule("git");
}

async function clickStatusPanelChanges() {
  // 文件数属于按钮内容，不能用完整文案定位，否则计数变化会让入口失配。
  const changesButton = $(
    '[data-status-capsule-content="git"] [data-testid="status-git-view-all"]',
  );
  await changesButton.waitForDisplayed();
  const actionLayout = await browser.execute(() => {
    const review = document.querySelector('[data-testid="status-git-view-all"]')!;
    const branch = document.querySelector('[data-testid="status-git-current-branch"]')!;
    const count = review.querySelector("span:last-child")!;
    const capsule = document.querySelector('[data-status-capsule="git"]')!;
    const trailing = branch.querySelector("[data-branch-switcher-trailing-icon]")!;
    return {
      count: count.textContent?.trim(),
      capsuleText: capsule.textContent,
      reviewFirst: Boolean(
        review.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      rightDifference: Math.abs(
        count.getBoundingClientRect().right - trailing.getBoundingClientRect().right,
      ),
      countColor: getComputedStyle(count).color,
      arrowColor: getComputedStyle(trailing).color,
    };
  });
  expect(Number(actionLayout.count)).toBeGreaterThan(0);
  expect(actionLayout.capsuleText).toContain(actionLayout.count);
  expect(actionLayout.reviewFirst).toBe(true);
  expect(actionLayout.rightDifference).toBeLessThan(2);
  expect(actionLayout.arrowColor).toBe(actionLayout.countColor);
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
