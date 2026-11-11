import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readSSHRuntimeConfig,
  prepareSSHConnectionPage,
  selectSSHRemoteDirectory,
  waitForSSHDirectoryStep,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_REMOTE_SETTINGS_SAFEGUARDS";
const deviceName = "RDUX-05 device";
const connectionName = "RDUX-05 connection";

async function section(name: string) {
  if (!(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed()))
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, name));
}

async function clickButton(text: string, root = "[data-settings-content-frame]") {
  await browser.waitUntil(
    async () =>
      await browser.execute(
        (label, selector) => {
          const button = [
            ...(document
              .querySelector(selector)
              ?.querySelectorAll<HTMLElement>('button, [role="menuitem"]') ?? []),
          ].find(
            (item) =>
              item.textContent?.trim() === label && !item.matches(":disabled, [data-disabled]"),
          );
          if (!button) return false;
          button.click();
          return true;
        },
        text,
        root,
      ),
    { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: button ${text}` },
  );
}

async function more() {
  await $('[data-settings-content-frame] button[aria-label="更多"]').click();
  await $('[role="menu"]').waitForDisplayed();
}

describe(`${CASE_MARKER}: 设置防护、连接编辑与机器标注`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("设置分区不显示正在编辑提示", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    const artifactDir = resolve(
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/settings-notice",
    );
    await mkdir(artifactDir, { recursive: true });
    for (const theme of ["zai-light", "zai-dark"] as const) {
      await browser.execute((value) => {
        const actions = (
          window as Window & {
            __testActions?: { setTheme(theme: "zai-light" | "zai-dark"): void };
          }
        ).__testActions;
        if (!actions) throw new Error("Missing theme actions");
        actions.setTheme(value);
      }, theme);
      for (const width of [1400, 480]) {
        await browser.electron.execute((electron, size) => {
          const window = electron.BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
          window?.setMinimumSize(360, 600);
          window?.setSize(size, 900);
        }, width);
        for (const name of [
          "general",
          "plugin",
          "mcp",
          "skill",
          "commands",
          "hooks",
          "subagents",
        ]) {
          await section(name);
          const frame = $("[data-settings-content-frame]");
          await frame.waitForDisplayed();
          expect(await frame.getText()).not.toMatch(/正在编辑：|Editing:/u);
          expect(await $("[data-settings-machine]").isExisting()).toBe(false);
          await browser.saveScreenshot(resolve(artifactDir, `${name}-${theme}-${width}.png`));
        }
      }
    }
  });

  it("RDUX-05 真实 SSH 设置操作保持设备、连接与项目边界", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const path = config.workspacePaths[0];
    // 前项截图停在窄屏设置页，项目侧栏处于响应式隐藏态；独立操作场景恢复桌面视口。
    await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows()
        .find((window) => !window.isDestroyed())
        ?.setSize(1400, 900),
    );
    await browser.waitUntil(() => browser.execute(() => innerWidth === 1400));
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    if (await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed())
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    // 失败录像确认扩宽窗口后仍保留窄屏的侧栏折叠选择；仅恢复尺寸不会自动展开。
    if (!(await $('[data-testid="project-section"]').isDisplayed())) {
      const toggles = await $$(
        'button[aria-label="切换侧边栏"], button[aria-label="Toggle sidebar"]',
      );
      for (const toggle of toggles) {
        if (!(await toggle.isDisplayed())) continue;
        await toggle.click();
        break;
      }
      await $('[data-testid="project-section"]').waitForDisplayed();
    }
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(path, CASE_MARKER);
    await waitForWorkspaceApp(path, 120_000);
    const tab = await waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: path });
    await browser.execute(() => {
      const actions = (window as Window & { __testActions?: { setLocale(locale: "zh-CN"): void } })
        .__testActions;
      if (!actions) throw new Error("Missing locale actions");
      actions.setLocale("zh-CN");
    });
    await section("remoteDevices");
    await $('[data-remote-connection-status="online"]').waitForDisplayed();
    // RDUX-13：编辑在设备行「更多」菜单里。
    await more();
    await clickButton("编辑", '[role="menu"]');
    await $("#edit-connection-name").setValue(connectionName);
    await $("#edit-device-name").setValue(deviceName);
    expect(await $('[role="dialog"]').getText()).toContain("下次连接时生效");
    await clickButton("保存更改", '[role="dialog"]');
    await $('[role="dialog"]').waitForDisplayed({ reverse: true });
    await browser.waitUntil(
      async () => (await $("[data-settings-content-frame]").getText()).includes(deviceName),
      { timeout: 10_000 },
    );
    await more();
    await clickButton("编辑", '[role="menu"]');
    expect(await $("#edit-connection-name").getValue()).toBe(connectionName);
    expect(await $("#edit-device-name").getValue()).toBe(deviceName);
    expect(await $('[data-testid="ssh-auth-password"]').getAttribute("aria-pressed")).toBe("true");
    const artifactDir = resolve(
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-settings-safeguards",
    );
    await mkdir(artifactDir, { recursive: true });
    for (const locale of ["zh-CN", "en-US"] as const) {
      await browser.execute(
        (value) =>
          (
            window as Window & { __testActions?: { setLocale(value: "zh-CN" | "en-US"): void } }
          ).__testActions?.setLocale(value),
        locale,
      );
      for (const theme of ["light", "dark"]) {
        await browser.execute(
          (value) =>
            (
              window as Window & { __testActions?: { setTheme(value: string): void } }
            ).__testActions?.setTheme(value),
          theme,
        );
        for (const width of [1400, 480]) {
          await browser.electron.execute((electron, size) => {
            const window = electron.BrowserWindow.getAllWindows().find(
              (candidate) => !candidate.isDestroyed(),
            );
            window?.setMinimumSize(360, 600);
            window?.setSize(size, 900);
          }, width);
          await browser.executeAsync((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
          await browser.saveScreenshot(
            resolve(artifactDir, `edit-${locale}-${theme}-${width}.png`),
          );
        }
      }
    }
    await browser.execute(() =>
      (
        window as Window & { __testActions?: { setLocale(value: "zh-CN"): void } }
      ).__testActions?.setLocale("zh-CN"),
    );
    await clickButton("取消", '[role="dialog"]');
    await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows()
        .find((candidate) => !candidate.isDestroyed())
        ?.setSize(1400, 900),
    );
    for (const name of ["plugin", "mcp", "skill", "hooks", "subagents"]) {
      await section(name);
      expect(await $("[data-settings-machine]").isExisting()).toBe(false);
      expect(await $("[data-settings-content-frame]").getText()).not.toMatch(
        /正在编辑：|Editing:/u,
      );
      const trigger = $('[data-plugin-scope-trigger="true"]');
      // 数据同步已统一各资源的 Scope；子智能体不再有“用户永远是本机”的旧例外。
      expect(await trigger.getText()).toContain(deviceName);
      const sourceId = parseRemoteWorkspaceIdentity(tab.workspaceIdentity!)?.sourceServerId;
      expect(sourceId).toBeTruthy();
      expect(await trigger.getAttribute("data-plugin-scope-key")).toBe(`source-user:${sourceId}`);
    }
    await section("general");
    expect(await $("[data-settings-machine]").isExisting()).toBe(false);
    expect(await $("[data-settings-content-frame]").getText()).not.toMatch(/正在编辑：|Editing:/u);
    await section("remoteDevices");
    await more();
    await clickButton("在侧边栏中显示", '[role="menu"]');
    await browser.waitUntil(
      async () =>
        await browser.execute(
          (identity) =>
            document.activeElement?.closest<HTMLElement>("[data-project-workspace-identity]")
              ?.dataset.projectWorkspaceIdentity === identity,
          tab.workspaceIdentity,
        ),
      { timeout: 10_000 },
    );
    await section("remoteDevices");
    await more();
    await clickButton("移除设备", '[role="menu"]');
    await $('[role="dialog"]').waitForDisplayed();
    expect(await $('[role="dialog"]').getText()).toContain(path);
    expect(await browser.execute(() => document.activeElement?.textContent)).toContain("取消");
    await browser.keys("Enter");
    await $('[role="dialog"]').waitForDisplayed({ reverse: true });
    expect(await $("[data-settings-content-frame]").getText()).toContain(deviceName);
    // RDUX-13：断开在「更多」菜单里，任务继续提示常驻在菜单项内，不占设备行。
    expect(await $("[data-settings-content-frame]").getText()).not.toContain("远端任务会继续运行");
    await more();
    const disconnectItem = await browser.execute(() => {
      const item = [
        ...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]'),
      ].find((candidate) => candidate.textContent?.trim().startsWith("断开"));
      const text = item?.textContent ?? null;
      item?.click();
      return text;
    });
    expect(disconnectItem).toContain("远端任务会继续运行");
    await $('[data-remote-connection-status="offline"]').waitForDisplayed({ timeout: 20_000 });
    expect(await $('[role="dialog"]').isDisplayed()).toBe(false);
    await browser.waitUntil(
      async () => (await $("[data-settings-content-frame]").getText()).includes("最近在线 刚刚"),
      { timeout: 10_000 },
    );
  });
});
