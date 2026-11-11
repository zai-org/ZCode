import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  clickLastEnabledSSHDialogButton,
  completeSSHProjectConnection,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
  runSSHCommand,
} from "#e2e/helpers/ssh-remote-p0";
import {
  clickOpenScopeMenuOption,
  readOpenScopeMenuOptions,
} from "#e2e/helpers/settings-scope-menu";
import { prepareV4ConversationE2E, startNewV4Draft } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_HOOKS_LOCAL_SCOPE";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-hooks-local-scope",
);
const LOCAL_MARKER = "E2E_R3_HOOKS_LOCAL_SCOPE_LOCAL";
const REMOTE_MARKER = "E2E_R3_HOOKS_LOCAL_SCOPE_REMOTE";
const SCOPE_TRIGGER = '[data-plugin-scope-trigger="true"]';
const HOOK_FORM = '[data-testid="hooks-form"]';

async function openHooksSection(): Promise<void> {
  const onSettings = await browser.execute(
    (pageId) => Boolean(document.querySelector(`[data-testid="${pageId}"]`)),
    TID_SETTINGS_PAGE,
  );
  if (!onSettings) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 没有设置入口`,
    });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 设置页没有渲染`,
    });
  }
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "hooks"), {
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: 设置页没有 hooks 分区`,
  });
  await $('[data-testid="hooks-settings-section"]').waitForDisplayed({ timeout: 15_000 });
  await $(SCOPE_TRIGGER).waitForClickable({ timeout: 15_000 });
}

async function readScopeOptions(): Promise<string[]> {
  await $(SCOPE_TRIGGER).click();
  await browser.waitUntil(
    () => browser.execute(() => document.querySelectorAll('[role="menuitemradio"]').length > 0),
    { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: scope 菜单没有选项` },
  );
  // 项目在各设备的「项目」子菜单里（19 号票），逐个打开后合并。
  const options = (await readOpenScopeMenuOptions()).map((option) => option.text);
  await browser.keys(["Escape"]);
  await browser.waitUntil(
    () => browser.execute(() => document.querySelectorAll('[role="menuitemradio"]').length === 0),
    { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: scope 菜单没有关闭` },
  );
  return options;
}

/** 同名目录必须按 scope key（identity 或本机路径）选择，不按位置或名称推断。 */
async function selectScopeKey(key: string): Promise<void> {
  await $(SCOPE_TRIGGER).click();
  await browser.waitUntil(
    () => browser.execute(() => document.querySelectorAll('[role="menuitemradio"]').length > 0),
    { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: scope 菜单打不开` },
  );
  await clickOpenScopeMenuOption(key, { timeoutMsg: `${CASE_MARKER}: scope 菜单没有 ${key}` });
  await browser.waitUntil(
    async () => (await $(SCOPE_TRIGGER).getAttribute("data-plugin-scope-key")) === key,
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: scope 没有切到 ${key}` },
  );
}

async function createHook(marker: string): Promise<string[]> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-settings-create-action="settings.hooks.add"]',
        );
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }),
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 没有“新建钩子”入口` },
  );
  const form = $(HOOK_FORM);
  await form.waitForDisplayed({ timeout: 15_000 });
  // matcher 不会命中任何真实工具；命令只是 printf，且本测试不信任、不执行该 hook。
  await form.$("#matcher").setValue(`${marker}_MATCHER_NEVER`);
  await form.$("#command").setValue("/usr/bin/printf");
  await form.$("#args").setValue(marker);
  await browser.waitUntil(
    () =>
      browser.execute((selector) => {
        const formNode = document.querySelector<HTMLElement>(selector);
        const button = Array.from(
          formNode?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        ).find((item) => /^(保存|Save)$/iu.test(item.innerText.trim()) && !item.disabled);
        button?.click();
        return Boolean(button);
      }, HOOK_FORM),
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 钩子表单没有可用的保存按钮` },
  );
  await browser.waitUntil(async () => !(await form.isExisting()), {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 保存后钩子表单没有关闭`,
  });
  await browser.pause(1_500);
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="alert"], [data-sonner-toast]'))
      .map((node) => (node.innerText ?? "").replace(/\s+/gu, " ").trim())
      .filter(Boolean),
  );
}

async function readLocalFile(path: string, waitMs: number): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await access(path);
      return await readFile(path, "utf8");
    } catch {
      if (Date.now() >= deadline) return null;
      await browser.pause(500);
    }
  }
}

describe(`${CASE_MARKER}: 远端项目激活时钩子按选中的 scope 落盘`, () => {
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "hooks-local-scope.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-DEV-06-hooks-local-scope 活动工作区在远端时选本机项目 scope 保存钩子只写本机；选远端项目 scope 只写远端", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const [workspaceA] = config.workspacePaths;
    const localConfigPath = join(DEFAULT_WORKSPACE, ".zcode", "config.json");
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await runSSHCommand(config, `rm -f "${workspaceA}/.zcode/config.json"`);

    // 活动工作区切到远端项目 A。
    await startNewV4Draft();
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    const remote = await completeSSHProjectConnection(config, CASE_MARKER);
    expect(remote.workspaceIdentity).toBeTruthy();

    await openHooksSection();
    const options = await readScopeOptions();
    facts.scopeOptions = options;
    expect(options).toEqual(
      expect.arrayContaining([
        expect.stringContaining(basename(DEFAULT_WORKSPACE)),
        expect.stringContaining(basename(workspaceA)),
      ]),
    );

    // 本机项目 scope：目标只由选中条目决定，不能借用活动远端工作区的身份把本机路径发往远端。
    await selectScopeKey(DEFAULT_WORKSPACE);
    const localAlerts = await createHook(LOCAL_MARKER);
    facts.localAlerts = localAlerts;
    expect(localAlerts.join(" ")).not.toMatch(/EACCES|permission denied|mkdir/iu);
    const localConfig = await readLocalFile(localConfigPath, 15_000);
    facts.localConfigHasLocalMarker = localConfig?.includes(LOCAL_MARKER) ?? false;
    expect(localConfig).toContain(LOCAL_MARKER);
    const remoteAfterLocal = await runSSHCommand(
      config,
      `grep -rl "${LOCAL_MARKER}" "$HOME/.zcode" "${workspaceA}" 2>/dev/null; echo END`,
    );
    facts.remoteAfterLocal = remoteAfterLocal.stdout.trim();
    expect(remoteAfterLocal.stdout.trim()).toBe("END");

    // 对照：远端项目 scope 仍只写远端。
    await selectScopeKey(remote.workspaceIdentity!);
    const remoteAlerts = await createHook(REMOTE_MARKER);
    facts.remoteAlerts = remoteAlerts;
    expect(remoteAlerts.join(" ")).not.toMatch(/EACCES|permission denied/iu);
    let remoteConfig = "";
    await browser.waitUntil(
      async () => {
        remoteConfig = (
          await runSSHCommand(config, `cat "${workspaceA}/.zcode/config.json" 2>/dev/null`)
        ).stdout;
        return remoteConfig.includes(REMOTE_MARKER);
      },
      {
        interval: 1000,
        timeout: 30_000,
        timeoutMsg: `${CASE_MARKER}: 远端项目 scope 钩子没有写入远端`,
      },
    );
    facts.remoteConfigHasRemoteMarker = true;
    const localAfterRemote = await readLocalFile(localConfigPath, 0);
    expect(localAfterRemote).toContain(LOCAL_MARKER);
    expect(localAfterRemote).not.toContain(REMOTE_MARKER);
    expect(remoteConfig).not.toContain(LOCAL_MARKER);
    await browser.saveScreenshot(resolve(artifactDir, "hooks-scopes.png")).catch(() => undefined);
  });
});
