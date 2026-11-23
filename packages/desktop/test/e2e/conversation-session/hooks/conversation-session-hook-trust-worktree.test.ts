// Workspace Hook Trust：受管 worktree 任务的审核入口（HK20，ZP-20261110-06）正式 E2E。
// 规格：docs/git/worktree.md §7.3、WT-41；docs/specs/workspace-hook-trust.md D23。
//
// 源仓库信任未提交的 v2 入口脚本后，worktree 检出已提交的 v1，这条 Hook 在 worktree 任务中待审核。
// 修复前「去审核」打开的设置页按源仓库目录发现，行显示已信任，没有「信任」按钮；
// 修复后按任务 cwd 发现，列表上方说明「及其 worktree」，信任后任务的待审核提示消失。
// fixture 由 wdio.conf.ts 在 agent 冷启动前落盘（hook-trust-worktree-fixture）。
// worktree 任务只在本机出现，手机远控不读取 worktree 元数据，本用例只覆盖桌面。
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_V4_WORKSPACE_HOOK_PENDING_REVIEW,
  TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER,
  TID_WORKTREE_TOGGLE,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { readHookTrustStore, waitForHookTrustStoreRecords } from "#e2e/helpers/hook-trust-fixture";
import { HOOK_TRUST_WORKTREE_ENTRY_LABEL } from "#e2e/helpers/hook-trust-worktree-fixture";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { sel } from "#e2e/helpers/selectors";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const TEST_TIMEOUT_MS = 180_000;
// E2E 的 ZCODE_DATA_BASE_DIR 即 DEFAULT_WORKSPACE 的父目录；受管根目录与 Host 同一规则推导。
const MANAGED_ROOT = join(dirname(DEFAULT_WORKSPACE), ".zcode", "worktrees");
const HOOKS_SECTION_SELECTOR = '[data-testid="hooks-settings-section"]';
// 「新建」按钮由 SettingsResourceHeaderActions 渲染，按 data 属性定位，不依赖 locale。
const NEW_HOOK_BUTTON_SELECTOR = '[data-settings-create-action="settings.hooks.add"]';
const CONFIG_RELATIVE_PATH = join(".zcode", "config.json");
const WORKTREE_NOTICE_SELECTOR = '[data-testid="workspace-hook-worktree-notice"]';
const HOOK_ROW_SELECTOR = `//div[@data-testid="configured-hook-row"][contains(., "${HOOK_TRUST_WORKTREE_ENTRY_LABEL}")]`;
// 信任按钮通过 ShieldCheck 图标定位（lucide class），不依赖 locale 文案。
const TRUST_BUTTON_IN_ROW = './/button[.//*[contains(@class, "lucide-shield-check")]]';
const WORKTREE_NOTICE_TEXT: Record<string, string> = {
  "zh-CN": "及其 worktree",
  "en-US": "and its worktrees",
};

async function listManagedWorktrees(): Promise<string[]> {
  const buckets = await readdir(MANAGED_ROOT, { withFileTypes: true }).catch(() => []);
  return buckets
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(MANAGED_ROOT, entry.name, basename(DEFAULT_WORKSPACE)));
}

/** 等 `git worktree add` 完成：worktree 目录下的 `.git` 文件在检出结束后才出现。 */
async function waitForManagedWorktree(): Promise<string> {
  let created: string | undefined;
  await browser.waitUntil(
    async () => {
      for (const path of await listManagedWorktrees()) {
        if ((await stat(join(path, ".git")).catch(() => null))?.isFile()) {
          created = path;
          return true;
        }
      }
      return false;
    },
    { timeout: 60_000, interval: 250, timeoutMsg: "受管根目录下没有出现新的 worktree" },
  );
  return created!;
}

async function sendAndWaitIdle(prompt: string): Promise<void> {
  await sendV4Prompt(prompt);
  await waitForV4Pane(
    (snapshot) =>
      snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
    `${prompt} 没有回到空闲`,
    90_000,
  );
}

/** 从 composer Hook 图标浮层点「去审核」进入 设置 → 钩子。 */
async function reviewFromPendingIndicator(): Promise<void> {
  await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER)).waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: "任务没有显示待审核 Hook 图标",
  });
  await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER)).click();
  await clickTestIdByDom(TID_V4_WORKSPACE_HOOK_PENDING_REVIEW, { timeout: 15_000 });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
  // 「去审核」的导航意图已打开钩子分区；再点侧栏属于普通入口，会丢弃 worktree 上下文（SG-01）。
  await $(HOOKS_SECTION_SELECTOR).waitForDisplayed({ timeout: 15_000 });
}

const SCOPE_TRIGGER_SELECTOR = '[data-plugin-scope-trigger="true"]';
const USER_SCOPE_OPTION_SELECTOR = '[role="menuitemradio"]:has(.lucide-circle-user-round)';

/**
 * CR 二轮：审核模式下手动切到「用户」，不能被同一次「去审核」的审核绑定拉回项目。
 * Radix DropdownMenu 只响应 pointerdown，element.click() 打不开菜单。
 */
async function switchScopeToUserAndAssertStays(): Promise<void> {
  const projectKey = await $(SCOPE_TRIGGER_SELECTOR).getAttribute("data-plugin-scope-key");
  await browser.execute((selector) => {
    const init = { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" } as const;
    const trigger = document.querySelector<HTMLElement>(selector)!;
    trigger.dispatchEvent(new PointerEvent("pointerdown", init));
    trigger.dispatchEvent(new PointerEvent("pointerup", init));
  }, SCOPE_TRIGGER_SELECTOR);
  await $(USER_SCOPE_OPTION_SELECTOR).waitForDisplayed({ timeout: 15_000 });
  await $(USER_SCOPE_OPTION_SELECTOR).click();
  await browser.waitUntil(
    async () =>
      (await $(SCOPE_TRIGGER_SELECTOR).getAttribute("data-plugin-scope-key")) !== projectKey,
    { timeout: 15_000, timeoutMsg: "范围菜单没有切到「用户」" },
  );
  const userKey = await $(SCOPE_TRIGGER_SELECTOR).getAttribute("data-plugin-scope-key");
  // 拉回发生在 effect 重跑的下一帧；持续观察一段时间，确认范围没有被改回。
  const pulledBack = await browser
    .waitUntil(
      async () =>
        (await $(SCOPE_TRIGGER_SELECTOR).getAttribute("data-plugin-scope-key")) !== userKey,
      { timeout: 3_000, interval: 100 },
    )
    .then(
      () => true,
      () => false,
    );
  expect(pulledBack).toBe(false);
  expect(await $(WORKTREE_NOTICE_SELECTOR).isExisting()).toBe(false);
}

async function trustHookRow(): Promise<void> {
  const row = $(HOOK_ROW_SELECTOR);
  await row.waitForDisplayed({ timeout: 15_000, timeoutMsg: "设置页没有列出 worktree Hook" });
  const trustButton = await row.$(TRUST_BUTTON_IN_ROW);
  await trustButton.waitForDisplayed({
    timeout: 15_000,
    timeoutMsg: "待审核的 Hook 行没有「信任」按钮",
  });
  await trustButton.click();
  await trustButton.waitForExist({ reverse: true, timeout: 15_000 });
}

async function closeSettings(): Promise<void> {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
}

/** 说明在 1200/390 视口 × Zai 深浅主题 × 中英文下可见且不溢出；结束后恢复。 */
async function verifyWorktreeNoticeLayouts(): Promise<void> {
  const original = await browser.execute(() => {
    const actions = (
      window as typeof window & { __testActions: { getTheme(): string; getLocale(): string } }
    ).__testActions;
    return { theme: actions.getTheme(), locale: actions.getLocale() };
  });
  const apply = (value: { theme: string; locale: string }) =>
    browser.execute(({ theme, locale }) => {
      const actions = (
        window as typeof window & {
          __testActions: { setTheme(value: string): void; setLocale(value: string): void };
        }
      ).__testActions;
      actions.setTheme(theme);
      actions.setLocale(locale);
    }, value);
  try {
    for (const width of [1200, 390]) {
      await browser.electron.execute(async (electron, width) => {
        const target = electron.BrowserWindow.getAllWindows().find(
          (w) => w.isVisible() && !w.isDestroyed(),
        )!;
        if (!target.webContents.debugger.isAttached()) target.webContents.debugger.attach("1.3");
        await target.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: false,
        });
      }, width);
      for (const theme of ["zai-light", "zai-dark"]) {
        for (const locale of ["zh-CN", "en-US"]) {
          await apply({ theme, locale });
          const notice = $(WORKTREE_NOTICE_SELECTOR);
          await notice.scrollIntoView({ block: "center" });
          await expect(notice).toHaveText(expect.stringContaining(WORKTREE_NOTICE_TEXT[locale]!));
          const fits = await browser.execute((selector: string) => {
            const rect = document.querySelector(selector)!.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth;
          }, WORKTREE_NOTICE_SELECTOR);
          expect(fits).toBe(true);
          await browser.saveScreenshot(
            `.e2e-artifacts/hook-trust-worktree-notice-${width}-${theme}-${locale}.png`,
          );
        }
      }
    }
  } finally {
    await browser.electron.execute(async (electron) => {
      const target = electron.BrowserWindow.getAllWindows().find(
        (w) => w.isVisible() && !w.isDestroyed(),
      )!;
      await target.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    });
    await apply(original);
  }
}

describe("Workspace Hook Trust：受管 worktree 审核入口（HK20）", () => {
  before(async function () {
    this.timeout(120_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    await prepareV4ConversationE2E();
  });

  // 不单独删 worktree：Windows 上应用仍占用会话 cwd，删除报 EBUSY；受管根目录在
  // .e2e-home 下，下一轮 resetE2EHome 会整体重建。
  after(async () => {
    await clearAppData();
  });

  it("HK20-a: 源仓库任务信任未提交的 v2 入口脚本，设置页不显示 worktree 说明", async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await sendAndWaitIdle("E2E_HOOK_TRUST_WORKTREE source: reply with ok");
    await reviewFromPendingIndicator();
    expect(await $(WORKTREE_NOTICE_SELECTOR).isExisting()).toBe(false);
    await trustHookRow();
    await waitForHookTrustStoreRecords(
      (records) => records.length === 1,
      "源仓库信任没有落盘一条记录",
    );
    await closeSettings();
  });

  it("HK20-b: worktree 任务点「去审核」，设置页按 worktree 发现待审核的 v1，信任后提示消失", async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    const toggle = $(`[data-testid="${TID_WORKTREE_TOGGLE}"]`);
    await toggle.waitForDisplayed({ timeout: 30_000, timeoutMsg: "worktree 复选框没有出现" });
    await browser.waitUntil(async () => (await toggle.getAttribute("disabled")) === null, {
      timeout: 30_000,
      timeoutMsg: "worktree 复选框一直禁用",
    });
    await toggle.click();
    await browser.waitUntil(async () => (await toggle.getAttribute("data-state")) === "checked", {
      timeout: 10_000,
      timeoutMsg: "worktree 复选框没有勾选",
    });
    await sendAndWaitIdle("E2E_HOOK_TRUST_WORKTREE worktree: reply with ok");
    const worktree = await waitForManagedWorktree();
    // CR-01：审核模式只允许信任，两个 checkout 的配置文件都不能被改写。
    const readConfigs = () =>
      Promise.all(
        [DEFAULT_WORKSPACE, worktree].map((root) =>
          readFile(join(root, CONFIG_RELATIVE_PATH), "utf8"),
        ),
      );
    const configsBefore = await readConfigs();

    // 修复前：设置页读源仓库的 v2（已信任），这一行没有「信任」按钮。
    await reviewFromPendingIndicator();
    const notice = $(WORKTREE_NOTICE_SELECTOR);
    await notice.waitForDisplayed({ timeout: 15_000, timeoutMsg: "设置页没有显示 worktree 说明" });
    expect(await notice.getText()).toContain(DEFAULT_WORKSPACE);
    // 信任行出现说明本次「去审核」的审核绑定已建立，再验证手动切换不被拉回。
    await $(HOOK_ROW_SELECTOR).$(TRUST_BUTTON_IN_ROW).waitForDisplayed({ timeout: 15_000 });
    await switchScopeToUserAndAssertStays();
    await closeSettings();
    await reviewFromPendingIndicator();
    await $(WORKTREE_NOTICE_SELECTOR).waitForDisplayed({ timeout: 15_000 });
    await verifyWorktreeNoticeLayouts();
    expect(await $(NEW_HOOK_BUTTON_SELECTOR).isExisting()).toBe(false);
    await trustHookRow();

    // 新记录与源仓库记录共用同一 Trust identity（D23），digest 是 worktree 中的 v1。
    const records = await waitForHookTrustStoreRecords(
      (items) => items.length === 2,
      "worktree 信任没有落盘第二条记录",
    );
    expect(new Set(records.map((record) => record.workspaceIdentity)).size).toBe(1);
    expect(new Set(records.map((record) => record.hookDeclarationDigest)).size).toBe(2);

    expect(await readConfigs()).toEqual(configsBefore);

    // SG-01：侧栏切到其他分区再回「钩子」属于普通入口，不再带 worktree 审核上下文。
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), { timeout: 15_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "hooks"), { timeout: 15_000 });
    await $(HOOKS_SECTION_SELECTOR).waitForDisplayed({ timeout: 15_000 });
    await $(NEW_HOOK_BUTTON_SELECTOR).waitForExist({
      timeout: 15_000,
      timeoutMsg: "普通入口进入钩子后仍处于 worktree 审核模式",
    });

    await closeSettings();
    await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER)).waitForExist({
      reverse: true,
      timeout: 30_000,
      timeoutMsg: "信任后 worktree 任务的待审核提示没有消失",
    });
    expect(await readHookTrustStore()).toHaveLength(2);
  });
});
