import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { dismissOccupationOnboarding } from "#e2e/helpers/occupation-onboarding";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// DSYNC-16：迁移入口移到数据同步页（docs/remote/data-sync.md「迁移入口」）。
// 只用本机桌面，不需要远端设备。
const CASE_MARKER = "E2E_DSYNC_16_MIGRATION_ENTRY";

async function readMigrationDialog() {
  return await browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="onboarding-migration-dialog"]',
    );
    const footerButtons = dialog
      ? [...dialog.querySelectorAll<HTMLButtonElement>("button")]
          .map((button) => button.textContent?.trim() ?? "")
          .filter((text) => text.length > 0)
      : [];
    return {
      open: Boolean(dialog),
      step: dialog?.dataset.wizardStep ?? null,
      text: dialog?.textContent ?? "",
      buttons: footerButtons,
      hasCancel: Boolean(dialog?.querySelector('[data-testid="onboarding-wizard-cancel"]')),
    };
  });
}

const SKILL_NAME = "e2e-dsync16-skill";

async function readWorkspaceTabState() {
  return await browser.execute(() => {
    const store = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState(): {
            tabs: Array<{ id: string; kind: string }>;
            activeWorkspacePath: string | null;
          };
        };
      }
    ).__zcodeTabStoreE2E;
    const state = store?.getState();
    return {
      workspaceTabCount: state?.tabs.filter((tab) => tab.kind === "workspace").length ?? -1,
      activeWorkspacePath: state?.activeWorkspacePath ?? null,
    };
  });
}

/** 关闭当前窗口全部 workspace tab（与用户逐个关闭相同，走 tab store 的 closeTab）。 */
async function closeAllWorkspaceTabs() {
  await browser.execute(() => {
    const store = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState(): {
            tabs: Array<{ id: string; kind: string }>;
            closeTab(id: string): void;
          };
        };
      }
    ).__zcodeTabStoreE2E;
    if (!store) throw new Error("tab store 未暴露");
    for (const tab of store.getState().tabs.filter((item) => item.kind === "workspace")) {
      store.getState().closeTab(tab.id);
    }
  });
}

async function clickDialogButton(label: string) {
  await browser.waitUntil(
    async () =>
      await browser.execute((text) => {
        const dialog = document.querySelector('[data-testid="onboarding-migration-dialog"]');
        const button = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
          (item) => item.textContent?.trim() === text && !item.disabled,
        );
        button?.click();
        return Boolean(button);
      }, label),
    { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 迁移向导没有可点击的「${label}」` },
  );
}

async function waitForWizardStep(step: string) {
  await browser.waitUntil(async () => (await readMigrationDialog()).step === step, {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 迁移向导没有进入 ${step} 步骤`,
  });
}

describe(`${CASE_MARKER}: 迁移入口移到数据同步页`, () => {
  after(async () => {
    const { homeDir } = getE2EAppDataPaths();
    await rm(join(homeDir, ".claude"), { recursive: true, force: true });
    await clearAppData();
  });

  it("DSYNC-16-01 侧栏没有 Onboarding 入口；数据同步页只有「迁移」，直接进入「会话」步骤，「取消」关闭弹窗；「通用」页「打开引导」仍打开职业引导", async function () {
    this.timeout(5 * 60_000);
    await prepareV4ConversationE2E({ skipProvider: true });

    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });

    // 设置侧栏不再有单独的 Onboarding（引导）入口。
    const sidebarLabels = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="settings-page"] nav button')].map(
        (button) => button.textContent?.trim() ?? "",
      ),
    );
    expect(sidebarLabels.length).toBeGreaterThan(0);
    expect(sidebarLabels).not.toContain("引导");
    expect(sidebarLabels).not.toContain("Onboard");

    // 数据同步页顶部操作行只有「迁移」。
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "dataSync"), {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 设置页没有数据同步分区`,
    });
    await waitForTestIdByDom("remote-sync-list-actions", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 数据同步页没有顶部操作行`,
    });
    const actions = await browser.execute(() =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[data-testid="remote-sync-list-actions"] button',
        ),
      ].map((button) => button.textContent?.trim() ?? ""),
    );
    expect(actions).toEqual(["迁移数据"]);
    expect(await $('[data-testid="remote-sync-description"]').getText()).toBe(
      "同步本机配置到远端。",
    );
    expect(await $$('[data-testid="settings-page"] h2').length).toBe(1);
    // 规则通过键盘打开，验证图标入口可访问，且没有触发同步或迁移。
    const rules = await $('[data-testid="remote-sync-rules-trigger"]');
    await rules.click();
    await waitForTestIdByDom("remote-sync-rules");
    expect(await $('[data-testid="remote-sync-rules"]').getText()).toContain(
      "仅新增或更新，保留远端独有内容。",
    );
    await browser.keys("Escape");
    await $('[data-testid="remote-sync-rules"]').waitForExist({ reverse: true });
    await browser.keys("Enter");
    await waitForTestIdByDom("remote-sync-rules");
    expect((await readMigrationDialog()).open).toBe(false);
    expect(await $('[data-testid="remote-sync-dialog"]').isExisting()).toBe(false);
    await browser.keys("Escape");

    // 「迁移」直接进入向导第一步「会话」，没有欢迎页；第一步左下角是「取消」。
    await clickTestIdByDom("remote-sync-migrate");
    await waitForTestIdByDom("onboarding-migration-dialog", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 点「迁移」后没有打开迁移向导`,
    });
    const dialog = await readMigrationDialog();
    expect(dialog.step).toBe("session");
    expect(dialog.text).toContain("迁移向导");
    expect(dialog.text).not.toContain("欢迎使用 ZCode");
    expect(dialog.hasCancel).toBe(true);
    expect(dialog.buttons).toContain("取消");
    expect(dialog.buttons).not.toContain("上一步");

    await clickTestIdByDom("onboarding-wizard-cancel");
    await browser.waitUntil(async () => !(await readMigrationDialog()).open, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 第一步「取消」没有关闭迁移向导`,
    });
    await waitForTestIdByDom("remote-sync-section", {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 关闭迁移向导后不在数据同步页`,
    });

    // 「通用」页「打开引导」不变，仍打开职业引导。
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), { timeout: 30_000 });
    const openOnboarding = await $('//button[normalize-space(.)="打开引导"]');
    await openOnboarding.waitForExist({ timeout: 30_000 });
    await openOnboarding.click();
    await $('[data-testid="onboarding-page"]').waitForExist({
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 「打开引导」没有打开职业引导`,
    });
    expect((await readMigrationDialog()).open).toBe(false);
    await dismissOccupationOnboarding();
    await $('[data-testid="onboarding-page"]').waitForExist({ reverse: true, timeout: 15_000 });
  });

  it("DSYNC-16-02 没有打开的项目时从「迁移」导入用户级技能：完成页显示已导入，文件写入本机 ~/.zcode/skills", async function () {
    this.timeout(5 * 60_000);
    const { homeDir } = getE2EAppDataPaths();
    const sourceDir = join(homeDir, ".claude", "skills", SKILL_NAME);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "SKILL.md"),
      `---\nname: ${SKILL_NAME}\ndescription: DSYNC-16-02 migration\n---\nBody\n`,
    );
    await prepareV4ConversationE2E({ skipProvider: true });

    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
    // 决定 24：数据同步页不要求项目。关闭全部 workspace tab，制造「没有打开的项目」。
    await closeAllWorkspaceTabs();
    await browser.waitUntil(
      async () => {
        const state = await readWorkspaceTabState();
        return state.workspaceTabCount === 0 && state.activeWorkspacePath === null;
      },
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 关闭 workspace tab 后仍有活动项目` },
    );
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "dataSync"), { timeout: 30_000 });
    await clickTestIdByDom("remote-sync-migrate", { timeout: 30_000 });
    await waitForWizardStep("session");

    await clickDialogButton("继续");
    await waitForWizardStep("skills-import");
    // 技能导入步骤列出 ~/.claude/skills 下的来源，全选后导入到全局（默认目标）。
    await browser.waitUntil(
      async () => (await readMigrationDialog()).text.includes(join(".claude", "skills")),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 技能导入步骤没有列出 ~/.claude/skills` },
    );
    await browser.execute(() => {
      const dialog = document.querySelector('[data-testid="onboarding-migration-dialog"]');
      dialog?.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="全选"]')?.click();
    });
    await waitForWizardStep("skills-import");
    await clickDialogButton("继续");
    await waitForWizardStep("mcp-import");
    await clickDialogButton("继续");
    await waitForWizardStep("commands-import");
    await clickDialogButton("继续");
    await waitForWizardStep("agents-file");
    await clickDialogButton("开始迁移");
    await waitForWizardStep("migration");
    await browser.waitUntil(
      async () => (await readMigrationDialog()).buttons.includes("开始使用"),
      {
        timeout: 60_000,
        timeoutMsg: `${CASE_MARKER}: 迁移没有完成`,
      },
    );

    // 修复前：没有 workspacePath 时导入被静默跳过，完成页显示完成但设置导入 0 项。
    const settingsSummary = await browser.execute(() => {
      const dialog = document.querySelector('[data-testid="onboarding-migration-dialog"]');
      const card = [...(dialog?.querySelectorAll<HTMLElement>("div.rounded-xl") ?? [])].find(
        (item) => item.textContent?.startsWith("设置导入"),
      );
      const values = [...(card?.querySelectorAll("span") ?? [])].map(
        (span) => span.textContent?.trim() ?? "",
      );
      return {
        imported: values[values.indexOf("已导入") + 1] ?? null,
        failed: values[values.indexOf("失败") + 1] ?? null,
        workspaceRequired: Boolean(
          dialog?.querySelector('[data-testid="onboarding-finish-workspace-required"]'),
        ),
      };
    });
    expect(settingsSummary).toEqual({ imported: "1", failed: "0", workspaceRequired: false });
    expect(
      await readFile(join(homeDir, ".zcode", "skills", SKILL_NAME, "SKILL.md"), "utf-8"),
    ).toContain("DSYNC-16-02 migration");
    // 整个流程中没有项目被重新打开。
    expect(await readWorkspaceTabState()).toEqual({
      workspaceTabCount: 0,
      activeWorkspacePath: null,
    });

    await clickDialogButton("开始使用");
    await browser.waitUntil(async () => !(await readMigrationDialog()).open, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 完成后迁移向导没有关闭`,
    });
  });
});
