import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { buildRemoteHostWorkspaceIdentity, ServiceChannels } from "@zcode/shared";
import type { RemoteProjectDirectory } from "@zcode/services";
import { callHandoffHost, installHandoffRpcProbe } from "#e2e/helpers/remote-project-handoff-probe";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_REMOTE_KIND_SSH,
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readSSHRuntimeConfig,
  prepareSSHConnectionPage,
  selectSSHRemoteDirectory,
  waitForSSHDirectoryStep,
  waitForSSHError,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_REMOTE_DEVICE_CARDS";
async function button(text: string, selector = "[data-settings-content-frame]") {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (label, root) => {
          const found = [
            ...(document.querySelector(root)?.querySelectorAll<HTMLButtonElement>("button") ?? []),
          ].find(
            (item) =>
              (item.textContent?.trim() === label || item.getAttribute("aria-label") === label) &&
              !item.disabled,
          );
          found?.click();
          return Boolean(found);
        },
        text,
        selector,
      ),
    { timeout: 10_000, timeoutMsg: `Missing ${text}` },
  );
}
async function settings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
}
/** RDUX-13：设备默认收起成一行；连接、项目、日志等详情在展开区。 */
async function expandDevice() {
  const toggle = $("[data-source-server-card] [data-source-server-toggle]");
  await toggle.waitForDisplayed();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await $("[data-source-server-card] [data-device-details]").waitForDisplayed();
}
async function deviceMenuTexts(): Promise<string[]> {
  await $('[data-source-server-card] button[aria-label="更多"]').click();
  await $("[data-device-info]").waitForDisplayed({ timeout: 5000 });
  return browser.execute(() =>
    [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent?.trim() ?? "",
    ),
  );
}
async function selectDeviceMenuItem(prefix: string) {
  await $('[data-source-server-card] button[aria-label="更多"]').click();
  await browser.waitUntil(
    () =>
      browser.execute((label) => {
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (candidate) =>
            candidate.textContent?.trim().startsWith(label) &&
            !candidate.hasAttribute("data-disabled"),
        );
        item?.click();
        return Boolean(item);
      }, prefix),
    { timeout: 10_000, timeoutMsg: `Missing menu item ${prefix}` },
  );
}

describe(`${CASE_MARKER}: 设置设备列表与未完成连接`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RDUX-13 真实设备行展开、搜索、菜单与定位高亮，失败连接隔离，项目可打开，主题与窄屏", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(config.workspacePaths[0], CASE_MARKER);
    await waitForWorkspaceApp(config.workspacePaths[0], 120_000);
    await installHandoffRpcProbe();
    const originalDirectory = await callHandoffHost<RemoteProjectDirectory>(
      ServiceChannels.RemoteProjects,
      "readDirectory",
    );
    const original = originalDirectory.entries.find((entry) =>
      entry.roots.some((root) => root.rootPath === config.workspacePaths[0]),
    );
    if (!original?.projectId) throw new Error(`${CASE_MARKER}: 缺少原项目身份`);
    const identity = buildRemoteHostWorkspaceIdentity(original.hostId, config.workspacePaths[0]);
    const openRecentProject = async (cachedProjectId: string | null) => {
      // 模拟旧版本缺少草稿范围或同目录残留其他项目；最近项目必须由 Host 入口决定归属。
      await browser.execute(
        (identity, hostId, projectId) => {
          const key = `zcode-composer-workspace-scope:v1:${JSON.stringify(["desktop", identity])}`;
          if (projectId === null) localStorage.removeItem(key);
          else
            localStorage.setItem(
              key,
              JSON.stringify({ clientNamespace: "desktop", hostId, projectId }),
            );
        },
        identity,
        original.hostId,
        cachedProjectId,
      );
      await $("[data-device-project]").click();
      await browser.waitUntil(
        async () => {
          // 旧断言反而等待创建器，掩盖了已保存项目被当作新目录的回归。
          expect(await $('[data-testid="virtual-project-name"]').isDisplayed()).toBe(false);
          return (
            !(await $('[role="dialog"]').isDisplayed()) &&
            !(await $('[data-testid="settings-page"]').isDisplayed())
          );
        },
        { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 最近项目未完成原项目导航` },
      );
      await waitForRemoteTab({
        caseMarker: CASE_MARKER,
        expectedIdentity: identity,
        expectedPath: config.workspacePaths[0],
      });
      await waitForWorkspaceApp(config.workspacePaths[0], 30_000);
      expect(await $('[data-testid="virtual-project-name"]').isDisplayed()).toBe(false);
      const projectId = await browser.execute(
        (path, identity) => {
          const bridge = window as Window & {
            __zcodeSessionStoreE2E?: {
              getState(): {
                getWorkspaceState(
                  path: string,
                  identity: string,
                ): { draftProjectId?: string | null };
              };
            };
          };
          return bridge.__zcodeSessionStoreE2E?.getState().getWorkspaceState(path, identity)
            .draftProjectId;
        },
        config.workspacePaths[0],
        identity,
      );
      expect(projectId).toBe(original.projectId);
      const rememberedProjectId = await browser.execute((identity) => {
        const key = `zcode-composer-workspace-scope:v1:${JSON.stringify(["desktop", identity])}`;
        return JSON.parse(localStorage.getItem(key) ?? "null")?.projectId;
      }, identity);
      expect(rememberedProjectId).toBe(original.projectId);
      const current = await callHandoffHost<RemoteProjectDirectory>(
        ServiceChannels.RemoteProjects,
        "readDirectory",
      );
      expect(current.entries.map((entry) => [entry.id, entry.projectId]).sort()).toEqual(
        originalDirectory.entries.map((entry) => [entry.id, entry.projectId]).sort(),
      );
    };
    await browser.execute(() => {
      (
        window as Window & { __testActions?: { setLocale(locale: string): void } }
      ).__testActions?.setLocale("zh-CN");
    });
    await settings();
    await $("[data-source-server-card]").waitForDisplayed();
    expect(await $$("[data-source-server-card]").length).toBe(1);
    // RDUX-13：设置导航「远程设备」不再显示汇总状态点。
    expect(await $("[data-remote-navigation-status]").isExisting()).toBe(false);
    // 默认收起成一行，只显示名称、地址与短状态；已连接时行上没有断开按钮。
    const row = $("[data-source-server-card] [data-source-server-row]");
    expect(
      await $("[data-source-server-card] [data-source-server-toggle]").getAttribute(
        "aria-expanded",
      ),
    ).toBe("false");
    expect(await $("[data-device-details]").isExisting()).toBe(false);
    expect(await row.getText()).toContain(`${config.username}@`);
    expect(await row.getText()).not.toContain("断开");
    expect(await row.$('[data-remote-connection-status="online"]').getText()).toBe("已连接");
    await expandDevice();
    // 单条连接不再标记“当前 / 默认”；连接行展示目标与远端版本。
    const connectionText = await $("[data-device-connection]").getText();
    expect(connectionText).toContain(`${config.username}@`);
    expect(connectionText).not.toContain("当前");
    expect(connectionText).toMatch(/v\d+\.\d+/u);
    // 最近项目每行带完整远端路径；任务继续提示只在更多菜单的断开项里。
    await $("[data-device-project]").waitForDisplayed();
    expect(await $("[data-device-projects]").getText()).toContain("最近项目");
    expect(await $("[data-device-project]").getText()).toContain(config.workspacePaths[0]);
    expect(await $("[data-settings-content-frame]").getText()).not.toContain("远端任务会继续运行");
    await openRecentProject(null);
    await settings();
    // 搜索匹配项目名；无匹配时列表内显示空态，清空后恢复。
    const search = $('[data-settings-content-frame] input[type="search"]');
    await search.setValue(config.workspacePaths[0].split("/").filter(Boolean).at(-1)!);
    expect(await $$("[data-source-server-card]").length).toBe(1);
    await search.setValue("no-such-device-e2e");
    await browser.waitUntil(async () => (await $$("[data-source-server-card]").length) === 0, {
      timeout: 5000,
      timeoutMsg: `${CASE_MARKER}: 搜索无匹配时仍显示设备`,
    });
    expect(await $("[data-source-server-device-list]").getText()).toContain("没有匹配");
    await $('[data-settings-content-frame] button[aria-label="清空搜索"]').click();
    await $("[data-source-server-card]").waitForDisplayed();
    // 更多菜单首组为编辑、断开（菜单项内常驻任务继续提示），之后是设备信息。
    const menuTexts = await deviceMenuTexts();
    expect(menuTexts[0]).toBe("编辑");
    expect(menuTexts[1]).toContain("断开");
    expect(menuTexts[1]).toContain("远端任务会继续运行");
    expect(await $("[data-device-info]").getText()).toContain("设备 ID");
    await browser.keys("Escape");
    await $("[data-device-info]").waitForDisplayed({ reverse: true });
    // 最近日志收在展开区页脚；短密码不能把固定文案按子串遮蔽（曾出现 "[redacted]ice"）。
    await expandDevice();
    await $("[data-source-server-card] [data-source-server-log-toggle]").click();
    await $("[data-source-server-log-timestamp]").waitForDisplayed();
    const logText = await $("[data-source-server-log]").getText();
    expect(logText).toContain("Checking the remote device");
    expect(logText).not.toContain("[redacted]ice");
    await selectDeviceMenuItem("断开");
    await $(
      '[data-source-server-card] [data-remote-connection-status="offline"]',
    ).waitForDisplayed();
    await expandDevice();
    await openRecentProject("stale-project");
    // 项目菜单「远程设备设置」：打开设置后只展开所属设备行、聚焦设备名按钮并持续高亮。
    await selectTaskOrganizeMode(["项目", "Project"]);
    const projectRow = $(`[data-project-workspace-identity="${identity}"]`);
    await projectRow.moveTo();
    await projectRow.$('[data-testid="virtual-project-menu"]').click();
    await $('[data-testid="virtual-project-device-settings"]').click();
    const card = $("[data-source-server-card]");
    await browser.waitUntil(async () => (await card.getAttribute("data-highlighted")) !== null, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 设置页没有高亮项目所属设备`,
    });
    expect(await card.$("[data-source-server-toggle]").getAttribute("aria-expanded")).toBe("true");
    expect(
      await browser.execute(() =>
        document.activeElement?.matches("[data-source-server-card] [data-source-server-toggle]"),
      ),
    ).toBe(true);
    const artifactRoot = resolve(
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-device-cards",
    );
    await mkdir(artifactRoot, { recursive: true });
    await browser.saveScreenshot(resolve(artifactRoot, "device-row-deep-link-highlight.png"));
    const listener = createServer();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing unused port");
    await new Promise<void>((done, reject) =>
      listener.close((error) => (error ? reject(error) : done())),
    );
    await button("新建连接");
    await clickTestIdByDom(TID_REMOTE_KIND_SSH);
    await fillSSHPasswordSettings({ ...config, host: "localhost", port: address.port });
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    expect(await waitForSSHError(CASE_MARKER)).toMatch(/无法连接到主机|Unable to connect to host/u);
    const unusedPort = address.port;
    const reservedHosts = async () =>
      (
        await callHandoffHost<RemoteProjectDirectory>(
          ServiceChannels.RemoteProjects,
          "readDirectory",
        )
      ).hosts.filter((host) => host.target?.kind === "ssh" && host.target.port === unusedPort);
    // 首次连接在 probe 前按地址写入本机成员预留；握手前失败时它只属于这条未完成连接。
    expect(await reservedHosts()).toHaveLength(1);
    // 默认折叠针对历史记录；收起会保留后台 owner 并主动展开，须先关闭失败的当前流程。
    await button("关闭", '[data-testid="ssh-dialog"]');
    await $('[data-testid="ssh-dialog"]').waitForDisplayed({ reverse: true });
    const unfinished = $("[data-unfinished-connections]");
    await unfinished.waitForExist();
    expect(await unfinished.getAttribute("open")).toBeNull();
    expect(await $$("[data-source-server-card]").length).toBe(1);
    await $("[data-unfinished-connections] summary").click();
    expect(await unfinished.getText()).toContain(String(address.port));
    const artifact = artifactRoot;
    for (const theme of ["light", "dark"]) {
      await browser.execute(
        (value) =>
          (
            window as Window & { __testActions?: { setTheme(theme: string): void } }
          ).__testActions?.setTheme(value),
        theme,
      );
      for (const width of [1440, 900, 480]) {
        await browser.electron.execute(
          (electron, size) =>
            electron.BrowserWindow.getAllWindows()
              .find((window) => !window.isDestroyed())
              ?.setSize(size, 1000),
          width,
        );
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        await browser.saveScreenshot(resolve(artifact, `device-cards-${theme}-${width}.png`));
      }
    }
    // Bug 原因：IPv6 主机不能构成地址成员 ID，释放预留时对剩余线路逐条计算并抛错，
    // 只要列表里有这样一条线路，清理任何未完成连接都会失败。
    await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows()
        .find((window) => !window.isDestroyed())
        ?.setSize(1440, 1000),
    );
    await button("新建连接");
    await clickTestIdByDom(TID_REMOTE_KIND_SSH);
    await fillSSHPasswordSettings({ ...config, host: "::1", port: unusedPort });
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHError(CASE_MARKER);
    await button("关闭", '[data-testid="ssh-dialog"]');
    await $('[data-testid="ssh-dialog"]').waitForDisplayed({ reverse: true });
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          Boolean(
            document.querySelector("[data-unfinished-connections]")?.textContent?.includes("::1"),
          ),
        ),
      { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: IPv6 失败线路没有进入未完成列表` },
    );
    // 地址不能构成成员身份时 admission 在写入前失败，不产生预留。
    expect(await reservedHosts()).toHaveLength(1);
    // 同一原因曾让 connectHost 选线时抛错：一条 IPv6 线路会让所有设备的侧栏重连失败。
    expect(
      (
        await callHandoffHost<{ id: string }>(ServiceChannels.RemoteProjects, "connectHost", [
          original.hostId,
        ])
      ).id,
    ).toBe(original.hostId);
    await button("清理全部", "[data-unfinished-connections]");
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
    await unfinished.waitForExist({ reverse: true });
    expect(await $$("[data-source-server-card]").length).toBe(1);
    // Bug 原因：清理只改 settings，预留行成为孤儿，侧栏每次刷新都对它 readTree 并持续报 host-offline。
    expect(await reservedHosts()).toHaveLength(0);
  });
});
