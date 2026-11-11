import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_PREVIEW_PANE,
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON,
  TID_WORKSPACE_FILE_TREE_ROW,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { openProjectFileTree } from "#e2e/helpers/project-sidebar";

const TREE_DIR = join(DEFAULT_WORKSPACE, "e2e-file-tree-refresh");
const OLD_FILE = join(TREE_DIR, "old-name.txt");
const RENAMED_FILE = join(TREE_DIR, "renamed-name.txt");
const WATCHED_FILE = join(TREE_DIR, "watcher-created.txt");

describe("工作区文件树刷新 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(TREE_DIR, { recursive: true, force: true });
  });

  it("重命名后点击刷新会更新已加载子目录，新增文件会实时出现在文件树", async function () {
    this.timeout(150000);

    await rm(TREE_DIR, { recursive: true, force: true });
    await waitForDefaultWorkspaceReady();
    await assertTaskListScrollMask();
    await mkdir(TREE_DIR, { recursive: true });
    await writeFile(OLD_FILE, "old file", "utf-8");

    // 文件树已迁到右侧标签；左侧导航保持可用，不再等待退役侧栏的位移动画。
    await openWorkspaceFileTree();
    await expect($('[data-project-sidebar-panel="navigation"]')).toBeDisplayed();
    const activeFileTab = $('[data-side-pane-tab-id][data-state="active"]');
    await activeFileTab.moveTo();
    await activeFileTab.$("button[aria-label]").click();
    await $(`[data-testid="${TID_WORKSPACE_FILE_TREE_PANEL}"]`).waitForExist({ reverse: true });
    await expect($('[data-project-sidebar-panel="navigation"]')).toBeDisplayed();
    await openWorkspaceFileTree();
    await clickWorkspaceFileTreeRow(TREE_DIR);
    await waitForWorkspaceFileTreeRow(OLD_FILE);

    await clickWorkspaceFileTreeRow(TREE_DIR);
    await waitForWorkspaceFileTreeRowMissing(OLD_FILE);
    await rename(OLD_FILE, RENAMED_FILE);
    await clickTestIdByDom(TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON, {
      timeoutMsg: "文件树刷新按钮不可点击",
    });

    await clickWorkspaceFileTreeRow(TREE_DIR);
    await waitForWorkspaceFileTreeRow(RENAMED_FILE);
    await waitForWorkspaceFileTreeRowMissing(OLD_FILE);

    await clickWorkspaceFileTreeRow(RENAMED_FILE);
    await waitForTestIdByDom(TID_PREVIEW_PANE, {
      timeoutMsg: "重命名后的文件没有正常打开预览",
    });

    await writeFile(WATCHED_FILE, "created by watcher", "utf-8");
    await waitForWorkspaceFileTreeRow(WATCHED_FILE, {
      timeout: 15000,
      timeoutMsg: "已加载目录新增文件后，文件树没有通过 watcher 实时刷新",
    });
  });
});

async function openWorkspaceFileTree() {
  // 修复原因：workspace action 只在整行 hover/focus 后挂载。
  await openProjectFileTree(DEFAULT_WORKSPACE, {
    timeoutMsg: "没有找到工作区文件树入口",
  });
  await waitForTestIdByDom(TID_WORKSPACE_FILE_TREE_PANEL, {
    timeoutMsg: "文件树面板没有打开",
  });
}

async function clickWorkspaceFileTreeRow(path: string) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (rowTestId) => {
          const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (element) => element.dataset.testid === rowTestId,
          );
          if (!row) {
            return false;
          }
          row.click();
          return true;
        },
        testId(TID_WORKSPACE_FILE_TREE_ROW, path),
      ),
    {
      timeout: 10000,
      timeoutMsg: `文件树没有可点击行: ${path}`,
    },
  );
}

async function waitForWorkspaceFileTreeRow(
  path: string,
  options: { timeout?: number; timeoutMsg?: string } = {},
) {
  const { timeout = 10000, timeoutMsg = `文件树没有显示目标路径: ${path}` } = options;
  await browser.waitUntil(
    async () =>
      browser.execute(
        (rowTestId) =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
            (element) => element.dataset.testid === rowTestId,
          ),
        testId(TID_WORKSPACE_FILE_TREE_ROW, path),
      ),
    { timeout, timeoutMsg },
  );
}

async function waitForWorkspaceFileTreeRowMissing(path: string) {
  const rowTestId = testId(TID_WORKSPACE_FILE_TREE_ROW, path);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (currentRowTestId) =>
          !Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
            (element) => element.dataset.testid === currentRowTestId,
          ),
        rowTestId,
      ),
    {
      timeout: 10000,
      timeoutMsg: `文件树仍显示已重命名的旧路径: ${path}`,
    },
  );
}

async function assertTaskListScrollMask() {
  const selector = '[data-project-sidebar-panel="navigation"] [data-scroll-mask]';
  const previousStyle = await browser.execute((query) => {
    const viewport = document.querySelector<HTMLElement>(query);
    if (!viewport) throw new Error("task 列表未使用滚动渐隐容器");
    const style = viewport.getAttribute("style");
    viewport.style.flex = "none";
    viewport.style.height = "40px";
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
    return style;
  }, selector);
  const assertMask = async (mask: string) => {
    await browser.waitUntil(
      () =>
        browser.execute(
          (query, expected) => {
            const viewport = document.querySelector<HTMLElement>(query);
            return (
              viewport?.dataset.scrollMask === expected &&
              (expected === "none"
                ? getComputedStyle(viewport).maskImage === "none"
                : getComputedStyle(viewport!).maskImage.includes("linear-gradient"))
            );
          },
          selector,
          mask,
        ),
      { timeout: 5000, timeoutMsg: `task 列表 mask 未变为 ${mask}` },
    );
  };
  try {
    await assertMask("bottom");
    await browser.execute((query) => {
      const viewport = document.querySelector<HTMLElement>(query)!;
      viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
      viewport.dispatchEvent(new Event("scroll"));
    }, selector);
    await assertMask("both");
    await browser.execute((query) => {
      const viewport = document.querySelector<HTMLElement>(query)!;
      viewport.scrollTop = viewport.scrollHeight;
      viewport.dispatchEvent(new Event("scroll"));
    }, selector);
    await assertMask("top");
    await browser.execute((query) => {
      const viewport = document.querySelector<HTMLElement>(query)!;
      viewport.style.height = `${viewport.scrollHeight + 20}px`;
    }, selector);
    await assertMask("none");
  } finally {
    await browser.execute(
      (query, style) => {
        const viewport = document.querySelector<HTMLElement>(query)!;
        if (style === null) viewport.removeAttribute("style");
        else viewport.setAttribute("style", style);
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event("scroll"));
      },
      selector,
      previousStyle,
    );
  }
}
