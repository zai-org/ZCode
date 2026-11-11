import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TID_V4_TIMELINE, TID_GIT_PANE } from "@zcode/shared/test-ids";
import { Key } from "webdriverio";
import { DEFAULT_WORKSPACE, clearAppData } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const runGit = promisify(execFile);
const FIND_MARKER = "E2E_CHAT_FIND_REFOCUS_NEEDLE";
const FILE_CHANGE_FIND_MARKER = "E2E_FILE_CHANGE_FIND_REFOCUS_NEEDLE";
const FILE_CHANGE_FIXTURE_NAME = "chat-find-refocus.txt";
const FILE_CHANGE_FIXTURE_PATH = join(DEFAULT_WORKSPACE, FILE_CHANGE_FIXTURE_NAME);
const GIT_BINARY = process.env.ZCODE_GIT_BINARY?.trim() || "git";
const CONVERSATION_FIND_PLACEHOLDERS = ["Search messages...", "搜索消息..."];
const FILE_CHANGE_FIND_PLACEHOLDERS = ["Search file changes...", "搜索文件变更..."];
const FIND_PLACEHOLDERS = [...CONVERSATION_FIND_PLACEHOLDERS, ...FILE_CHANGE_FIND_PLACEHOLDERS];
const PREVIOUS_LABELS = ["Previous result", "上一个结果"];
const NEXT_LABELS = ["Next result", "下一个结果"];
const FILE_CHANGE_SCOPE_LABELS = ["Search file changes", "搜索文件变更"];
const REFRESH_LABELS = ["Refresh", "刷新"];
let createdFixtureRepository = false;

describe("会话区单命中重复查找重新聚焦 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await cleanupFileChangeFindFixture();
  });

  it("会话和文件变更滚走后，重复导航仍把同一个命中重新居中", async function () {
    this.timeout(120000);

    await prepareFileChangeFindFixture();
    await prepareV4ConversationE2E();
    await prepareLongCompletedConversation();
    await openConversationFind();
    await setFindQuery(CONVERSATION_FIND_PLACEHOLDERS, FIND_MARKER);
    await waitForFindCentered("首次搜索没有把唯一命中居中");

    for (const action of ["next", "previous", "enter", "shift-enter"] as const) {
      await scrollFindMatchAway();
      await triggerFindNavigation(action);
      await waitForFindCentered(`${action} 没有把唯一命中重新居中`);
    }

    await switchFindScopeToFileChanges();
    await setFindQuery(FILE_CHANGE_FIND_PLACEHOLDERS, FILE_CHANGE_FIND_MARKER);
    await waitForFileChangeFindCentered("文件变更首次搜索没有把唯一命中居中");

    for (const action of ["next", "previous", "enter", "shift-enter"] as const) {
      await scrollFileChangeFindMatchAway();
      await triggerFindNavigation(action);
      await waitForFileChangeFindCentered(`文件变更 ${action} 没有把唯一命中重新居中`);
    }
  });
});

async function prepareFileChangeFindFixture() {
  await mkdir(DEFAULT_WORKSPACE, { recursive: true });
  let repositoryRoot = "";
  try {
    repositoryRoot = (
      await runGit(GIT_BINARY, ["rev-parse", "--show-toplevel"], {
        cwd: DEFAULT_WORKSPACE,
        encoding: "utf8",
      })
    ).stdout.trim();
  } catch {
    repositoryRoot = "";
  }

  if (resolve(repositoryRoot) !== resolve(DEFAULT_WORKSPACE)) {
    await runGit(GIT_BINARY, ["init"], {
      cwd: DEFAULT_WORKSPACE,
    });
    createdFixtureRepository = true;
  }

  await runGit(GIT_BINARY, ["config", "user.name", "ZCode E2E"], {
    cwd: DEFAULT_WORKSPACE,
  });
  await runGit(GIT_BINARY, ["config", "user.email", "zcode-e2e@example.com"], {
    cwd: DEFAULT_WORKSPACE,
  });

  await writeFile(FILE_CHANGE_FIXTURE_PATH, "", "utf8");
  await runGit(GIT_BINARY, ["add", "--", FILE_CHANGE_FIXTURE_NAME], {
    cwd: DEFAULT_WORKSPACE,
  });
  await runGit(
    GIT_BINARY,
    ["-c", "commit.gpgsign=false", "commit", "-m", "test: seed chat find fixture"],
    {
      cwd: DEFAULT_WORKSPACE,
    },
  );

  const changedLines = Array.from({ length: 1_300 }, (_, index) =>
    index === 79
      ? FILE_CHANGE_FIND_MARKER
      : `文件变更查找回归行 ${index + 1}：用于撑开 Review 滚动区域。`,
  );
  await writeFile(FILE_CHANGE_FIXTURE_PATH, `${changedLines.join("\n")}\n`, "utf8");
}

async function cleanupFileChangeFindFixture() {
  await rm(FILE_CHANGE_FIXTURE_PATH, { force: true });
  if (createdFixtureRepository) {
    await rm(join(DEFAULT_WORKSPACE, ".git"), { force: true, recursive: true });
  }
}

async function prepareLongCompletedConversation() {
  // 旧 setter 已随 V4 状态归属收口移除；通过真实发送建立可查找的长消息。
  await sendV4Prompt("E2E_CHAT_FIND_REFOCUS_SETUP 请返回查找回归长正文。");
  await waitForV4TimelineContaining(FIND_MARKER);
  await waitForV4Pane((state) => Boolean(state.sessionId) && !state.canStop, "长正文未完成");
}

async function openConversationFind() {
  await browser.execute(() => {
    const isApple = /Mac|iPhone|iPad|iPod/.test(`${navigator.platform} ${navigator.userAgent}`);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyF",
        key: "f",
        metaKey: isApple,
        ctrlKey: !isApple,
      }),
    );
  });

  await browser.waitUntil(
    () =>
      browser.execute(
        (placeholders) =>
          Array.from(document.querySelectorAll<HTMLInputElement>("input")).some((input) =>
            placeholders.includes(input.placeholder),
          ),
        FIND_PLACEHOLDERS,
      ),
    {
      timeout: 10000,
      timeoutMsg: "Cmd/Ctrl+F 没有打开会话查找框",
    },
  );
}

async function setFindQuery(placeholders: readonly string[], query: string) {
  const updated = await browser.execute(
    (placeholders, nextQuery) => {
      const input = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
        (candidate) => placeholders.includes(candidate.placeholder),
      );
      if (!input) {
        return false;
      }

      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      input.focus();
      valueSetter?.call(input, nextQuery);
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: nextQuery,
          inputType: "insertText",
        }),
      );
      return true;
    },
    placeholders,
    query,
  );
  expect(updated).toBe(true);
}

async function switchFindScopeToFileChanges() {
  const switched = await browser.execute((labels) => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => labels.includes(candidate.getAttribute("aria-label") ?? ""),
    );
    button?.click();
    return Boolean(button);
  }, FILE_CHANGE_SCOPE_LABELS);
  expect(switched).toBe(true);

  await browser.waitUntil(
    () =>
      browser.execute(
        (gitPaneTestId) => Boolean(document.querySelector(`[data-testid="${gitPaneTestId}"]`)),
        TID_GIT_PANE,
      ),
    {
      timeout: 10000,
      timeoutMsg: "切换文件变更范围后没有打开 Git 面板",
    },
  );

  await browser.waitUntil(
    () =>
      browser.execute(
        (gitPaneTestId, refreshLabels) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${gitPaneTestId}"]`);
          const refreshButton = Array.from(
            pane?.querySelectorAll<HTMLButtonElement>("button") ?? [],
          ).find((button) => refreshLabels.includes(button.textContent?.trim() ?? ""));
          if (!refreshButton || refreshButton.disabled) {
            return false;
          }
          refreshButton.click();
          return true;
        },
        TID_GIT_PANE,
        REFRESH_LABELS,
      ),
    {
      timeout: 15000,
      timeoutMsg: "Git 面板刷新按钮没有进入可用状态",
    },
  );

  try {
    await browser.waitUntil(
      () =>
        browser.execute(
          (gitPaneTestId, fixtureName) =>
            document
              .querySelector<HTMLElement>(`[data-testid="${gitPaneTestId}"]`)
              ?.innerText.includes(fixtureName) === true,
          TID_GIT_PANE,
          FILE_CHANGE_FIXTURE_NAME,
        ),
      {
        timeout: 15000,
        timeoutMsg: "Git 面板没有加载 case-local 文件变更",
      },
    );
  } catch (error) {
    const diagnostics = await getGitPaneDiagnostics();
    throw new Error(
      `Git 面板没有加载 case-local 文件变更; diagnostics=${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
}

function getGitPaneDiagnostics() {
  return browser.execute((gitPaneTestId) => {
    const pane = document.querySelector<HTMLElement>(`[data-testid="${gitPaneTestId}"]`);
    return {
      buttons: Array.from(pane?.querySelectorAll<HTMLButtonElement>("button") ?? []).map(
        (button) => ({
          disabled: button.disabled,
          expanded: button.getAttribute("aria-expanded"),
          text: button.textContent?.trim() ?? "",
        }),
      ),
      rowCount: pane?.querySelectorAll("[data-git-pane-change-virtual-row]").length ?? 0,
      text: pane?.innerText ?? "",
    };
  }, TID_GIT_PANE);
}

async function scrollFindMatchAway() {
  const scrolled = await browser.execute((messagesTestId) => {
    const root = document.querySelector<HTMLElement>(`[data-testid="${messagesTestId}"]`);
    const viewport = root;
    if (!viewport) {
      return false;
    }
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    return true;
  }, TID_V4_TIMELINE);
  expect(scrolled).toBe(true);

  await browser.waitUntil(
    async () => {
      const snapshot = await getFindSnapshot();
      return snapshot.markerDistanceFromCenter > snapshot.viewportHeight / 2;
    },
    {
      timeout: 10000,
      timeoutMsg: "没有把唯一命中滚出视口",
    },
  );
}

async function triggerFindNavigation(action: "next" | "previous" | "enter" | "shift-enter") {
  if (action === "next" || action === "previous") {
    const labels = action === "previous" ? PREVIOUS_LABELS : NEXT_LABELS;
    for (const label of labels) {
      const button = await $(`button[aria-label="${label}"]`);
      if (!(await button.isExisting())) {
        continue;
      }
      await button.click();
      return;
    }
    throw new Error(`${action} 导航按钮不存在`);
  }

  for (const placeholder of FIND_PLACEHOLDERS) {
    const input = await $(`input[placeholder="${placeholder}"]`);
    if (!(await input.isExisting())) {
      continue;
    }
    await input.click();
    if (action === "shift-enter") {
      // 评审收口：显式使用 W3C key action，确保 Enter 触发时 Shift 仍保持按下。
      // 不改用 DOM dispatchEvent，因为非 trusted 事件无法代表真实用户键盘链路。
      await browser
        .action("key")
        .down(Key.Shift)
        .down(Key.Enter)
        .up(Key.Enter)
        .up(Key.Shift)
        .perform();
    } else {
      await browser.keys("Enter");
    }
    return;
  }
  throw new Error(`${action} 导航输入框不存在`);
}

async function waitForFindCentered(timeoutMsg: string) {
  let latest: FindSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getFindSnapshot();
        return (
          latest.counter.includes("1/1") &&
          latest.scrollTop > 0 &&
          latest.markerDistanceFromCenter <= Math.max(120, latest.viewportHeight * 0.3)
        );
      },
      {
        timeout: 15000,
        timeoutMsg,
      },
    );
  } catch (error) {
    latest = await getFindSnapshot().catch(() => latest);
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

async function scrollFileChangeFindMatchAway() {
  const scrolled = await browser.execute(
    (gitPaneTestId, fixtureName) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${gitPaneTestId}"]`);
      const row = Array.from(
        pane?.querySelectorAll<HTMLElement>("[data-git-pane-change-virtual-row]") ?? [],
      ).find((candidate) => candidate.innerText.includes(fixtureName));
      const viewport = row?.parentElement?.parentElement;
      if (!(viewport instanceof HTMLElement)) {
        return false;
      }
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      return true;
    },
    TID_GIT_PANE,
    FILE_CHANGE_FIXTURE_NAME,
  );
  expect(scrolled).toBe(true);

  await browser.waitUntil(
    async () => {
      const snapshot = await getFileChangeFindSnapshot();
      return snapshot.markerDistanceFromCenter > snapshot.viewportHeight / 2;
    },
    {
      timeout: 10000,
      timeoutMsg: "没有把文件变更唯一命中滚出视口",
    },
  );
}

async function waitForFileChangeFindCentered(timeoutMsg: string) {
  let latest: FileChangeFindSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getFileChangeFindSnapshot();
        return (
          latest.counter.includes("1/1") &&
          latest.expanded &&
          latest.scrollTop > 0 &&
          latest.markerDistanceFromCenter <= Math.max(120, latest.viewportHeight * 0.3)
        );
      },
      {
        timeout: 20000,
        timeoutMsg,
      },
    );
  } catch (error) {
    latest = await getFileChangeFindSnapshot().catch(() => latest);
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

interface FindSnapshot {
  counter: string;
  markerDistanceFromCenter: number;
  scrollTop: number;
  viewportHeight: number;
}

interface FileChangeFindSnapshot extends FindSnapshot {
  expanded: boolean;
}

function getFileChangeFindSnapshot(): Promise<FileChangeFindSnapshot> {
  return browser.execute(
    (gitPaneTestId, placeholders, fixtureName, marker) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${gitPaneTestId}"]`);
      const input = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
        (candidate) => placeholders.includes(candidate.placeholder),
      );
      const row = Array.from(
        pane?.querySelectorAll<HTMLElement>("[data-git-pane-change-virtual-row]") ?? [],
      ).find((candidate) => candidate.innerText.includes(fixtureName));
      const viewport = row?.parentElement?.parentElement;
      if (!input || !(viewport instanceof HTMLElement) || !row) {
        return {
          counter: input?.parentElement?.textContent ?? "",
          expanded: false,
          markerDistanceFromCenter: Number.POSITIVE_INFINITY,
          scrollTop: viewport instanceof HTMLElement ? viewport.scrollTop : 0,
          viewportHeight: viewport instanceof HTMLElement ? viewport.clientHeight : 0,
        };
      }

      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      let markerRect: DOMRect | null = null;
      while (textNode) {
        const markerIndex = textNode.textContent?.indexOf(marker) ?? -1;
        if (markerIndex >= 0) {
          const range = document.createRange();
          range.setStart(textNode, markerIndex);
          range.setEnd(textNode, markerIndex + marker.length);
          markerRect = range.getBoundingClientRect();
          break;
        }
        textNode = walker.nextNode();
      }

      const viewportRect = viewport.getBoundingClientRect();
      const viewportCenter = viewportRect.top + viewportRect.height / 2;
      const markerCenter = markerRect
        ? markerRect.top + markerRect.height / 2
        : Number.POSITIVE_INFINITY;
      return {
        counter: input.parentElement?.textContent ?? "",
        expanded: Boolean(row.querySelector('button[aria-expanded="true"]')),
        markerDistanceFromCenter: Math.abs(markerCenter - viewportCenter),
        scrollTop: viewport.scrollTop,
        viewportHeight: viewport.clientHeight,
      };
    },
    TID_GIT_PANE,
    FILE_CHANGE_FIND_PLACEHOLDERS,
    FILE_CHANGE_FIXTURE_NAME,
    FILE_CHANGE_FIND_MARKER,
  );
}

function getFindSnapshot(): Promise<FindSnapshot> {
  return browser.execute(
    (messagesTestId, placeholders, marker) => {
      const root = document.querySelector<HTMLElement>(`[data-testid="${messagesTestId}"]`);
      const input = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
        (candidate) => placeholders.includes(candidate.placeholder),
      );
      const viewport = root;
      if (!input || !viewport || !root) {
        return {
          counter: "",
          markerDistanceFromCenter: Number.POSITIVE_INFINITY,
          scrollTop: viewport?.scrollTop ?? 0,
          viewportHeight: viewport?.clientHeight ?? 0,
        };
      }

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      let markerRect: DOMRect | null = null;
      while (textNode) {
        const markerIndex = textNode.textContent?.indexOf(marker) ?? -1;
        if (markerIndex >= 0) {
          const range = document.createRange();
          range.setStart(textNode, markerIndex);
          range.setEnd(textNode, markerIndex + marker.length);
          markerRect = range.getBoundingClientRect();
          break;
        }
        textNode = walker.nextNode();
      }

      const viewportRect = viewport.getBoundingClientRect();
      const viewportCenter = viewportRect.top + viewportRect.height / 2;
      const markerCenter = markerRect
        ? markerRect.top + markerRect.height / 2
        : Number.POSITIVE_INFINITY;
      return {
        counter: input.parentElement?.textContent ?? "",
        markerDistanceFromCenter: Math.abs(markerCenter - viewportCenter),
        scrollTop: viewport.scrollTop,
        viewportHeight: viewport.clientHeight,
      };
    },
    TID_V4_TIMELINE,
    FIND_PLACEHOLDERS,
    FIND_MARKER,
  );
}
