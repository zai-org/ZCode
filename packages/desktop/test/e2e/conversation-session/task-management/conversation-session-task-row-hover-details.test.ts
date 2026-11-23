// TSL43：会话行悬停卡片显示工作区、路径、最近活动与分支；覆盖按项目行与按分组行。
import { execFileSync } from "node:child_process";
import { TID_TASK_ITEM, TID_WORKSPACE_TITLE } from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const SEED_MARKER = "E2E_TSL43_HOVER_SEED";

/** 悬停卡片的分支行只在 Git 仓库出现；给默认工作区补一个真实仓库和提交。 */
function ensureGitWorkspace(): string {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: DEFAULT_WORKSPACE,
      stdio: "ignore",
    });
  } catch {
    execFileSync("git", ["init", "-b", "main"], { cwd: DEFAULT_WORKSPACE, stdio: "ignore" });
  }
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: DEFAULT_WORKSPACE,
      stdio: "ignore",
    });
  } catch {
    execFileSync(
      "git",
      [
        "-c",
        "user.name=ZCode E2E",
        "-c",
        "user.email=e2e@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "e2e hover card init",
      ],
      { cwd: DEFAULT_WORKSPACE, stdio: "ignore" },
    );
  }
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: DEFAULT_WORKSPACE,
    encoding: "utf8",
  }).trim();
}

async function switchSidebarView(view: "projects" | "grouped") {
  await $('[data-testid="sidebar-view-menu"]').click();
  const item = $(`[data-testid="sidebar-view-${view}"]`);
  await item.waitForDisplayed({ timeout: 15_000 });
  await item.click();
  await item.waitForExist({ reverse: true, timeout: 15_000 });
}

async function hoverTaskRow(sessionId: string, view: "projects" | "grouped") {
  const rowSelector = `[data-testid="${TID_TASK_ITEM}-${sessionId}"]`;
  const row =
    view === "grouped" ? $(`[data-testid="task-grouped-view"] ${rowSelector}`) : $(rowSelector);
  await row.waitForDisplayed({ timeout: 15_000 });
  await row.moveTo();
  const card = $('[data-testid="task-row-details"]');
  await card.waitForDisplayed({ timeout: 10_000 });
  return card;
}

async function assertCardIdentity(card: Awaited<ReturnType<typeof hoverTaskRow>>, branch: string) {
  // 标签与路径都来自默认工作区；路径通过主机 home 缩写，仍保留目录名。
  expect(await card.getText()).toContain("ZCodeProject");
  const path = card.$("[data-workspace-context-path]");
  await path.waitForDisplayed({ timeout: 10_000 });
  expect(await path.getText()).toContain("ZCodeProject");
  const activity = card.$("[data-workspace-last-activity]");
  await activity.waitForDisplayed({ timeout: 10_000 });
  expect(await activity.getText()).toMatch(/Last active|最近活动/);
  const branchLine = card.$("[data-task-row-branch]");
  await branchLine.waitForDisplayed({ timeout: 10_000 });
  expect(await branchLine.getText()).toContain(branch);
}

describe("TSL43：会话行悬停工作区卡片", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("按项目行与按分组行悬停都显示同一张卡片，移出后关闭", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E();
    const branch = ensureGitWorkspace();
    await sendV4Prompt(`${SEED_MARKER} 建立悬停卡片会话`);
    await waitForV4TimelineContaining("TSL43_HOVER_SEED_OK", 45_000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId !== "draft" && snapshot.sessionId !== null,
      "会话没有建立",
      45_000,
    );
    const sessionId = (await getV4PaneSnapshot()).sessionId as string;

    // 按项目视图：悬停任务行出现完整卡片，移出后关闭。
    const projectCard = await hoverTaskRow(sessionId, "projects");
    await assertCardIdentity(projectCard, branch);
    await $(`[data-testid="${TID_WORKSPACE_TITLE}"]`).moveTo();
    await projectCard.waitForExist({ reverse: true, timeout: 10_000 });

    // 按分组视图：同一张卡片替换原来的单行提示，字段保持一致。
    await switchSidebarView("grouped");
    await $('[data-testid="task-grouped-view"]').waitForDisplayed({ timeout: 15_000 });
    const groupedCard = await hoverTaskRow(sessionId, "grouped");
    await assertCardIdentity(groupedCard, branch);
  });
});
