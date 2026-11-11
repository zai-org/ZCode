import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_MEMORY_SWITCH,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  setCurrentElectronRendererContentSize,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import {
  bringRemoteDeviceOnline,
  chmodRemoteContainerPath,
  readRemoteContainerFile,
  readRemoteDockerContainer,
  takeRemoteDeviceOffline,
  writeRemoteContainerFile,
} from "#e2e/helpers/remote-docker-target";
import { clickOpenScopeMenuOption } from "#e2e/helpers/settings-scope-menu";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_REMOTE_MEMORY_SETTINGS";
const DEVICE_TRIGGER = "settings-memory-device-trigger";
const REMOTE_SETTINGS_DIR = "/home/dev/.zcode/v2";
const REMOTE_SETTINGS = `${REMOTE_SETTINGS_DIR}/setting.json`;

async function openSection(section: string): Promise<void> {
  if (!(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isExisting())) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
  }
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, section));
}

async function openDeviceMenu(): Promise<void> {
  await waitForTestIdByDom(DEVICE_TRIGGER, { timeout: 30_000 });
  // 与现有 Scope 用例相同：已打开时不再次切换，Radix 只发送一次 pointerdown 打开。
  await browser.waitUntil(
    () =>
      browser.execute((id) => {
        const trigger = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
        if (trigger?.dataset.state === "open") {
          return [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].some(
            (item) => item.getClientRects().length > 0,
          );
        }
        trigger?.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
        );
        return false;
      }, DEVICE_TRIGGER),
    { timeout: 15_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 设备菜单未打开` },
  );
}

async function selectDevice(key: string): Promise<void> {
  await openDeviceMenu();
  await clickOpenScopeMenuOption(key);
  await browser.waitUntil(
    async () =>
      (await $(`[data-testid="${DEVICE_TRIGGER}"]`).getAttribute("data-plugin-scope-key")) === key,
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 没有选中 ${key}` },
  );
}

async function readMemorySwitch(): Promise<boolean | null> {
  return browser.execute((id) => {
    const control = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    return !control || control.disabled ? null : control.getAttribute("aria-checked") === "true";
  }, TID_SETTINGS_MEMORY_SWITCH);
}

async function waitForSwitch(expected: boolean): Promise<void> {
  await browser.waitUntil(async () => (await readMemorySwitch()) === expected, {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 开关未显示 ${expected}`,
  });
}

async function readLocalMemory(): Promise<boolean> {
  const raw = await readFile(join(resolveE2EStorageRoot(), "v2", "setting.json"), "utf8");
  return (JSON.parse(raw) as { memoryEnabled?: boolean }).memoryEnabled === true;
}

async function readRemoteMemory(container: string): Promise<boolean> {
  const raw = await readRemoteContainerFile(container, REMOTE_SETTINGS);
  return (JSON.parse(raw) as { memoryEnabled?: boolean }).memoryEnabled === true;
}

async function setMemory(enabled: boolean, read: () => Promise<boolean>): Promise<void> {
  await waitForSwitch(!enabled);
  await clickTestIdByDom(TID_SETTINGS_MEMORY_SWITCH);
  await browser.waitUntil(async () => (await read()) === enabled, {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 目标设备未保存 ${enabled}`,
  });
  await waitForSwitch(enabled);
}

async function captureLayouts(): Promise<void> {
  const root = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!root) throw new Error(`${CASE_MARKER}: 缺少工件目录`);
  const dir = resolve(root, "memory-devices");
  await mkdir(dir, { recursive: true });
  for (const locale of ["zh-CN", "en-US"]) {
    for (const theme of ["light", "dark"]) {
      await browser.execute(
        (language, color) => {
          const actions = (
            window as Window & {
              __testActions?: { setLocale(value: string): void; setTheme(value: string): void };
            }
          ).__testActions;
          actions?.setLocale(language);
          actions?.setTheme(color);
        },
        locale,
        theme,
      );
      for (const width of [1280, 700]) {
        await setCurrentElectronRendererContentSize(width, 800);
        await openDeviceMenu();
        expect(await $(`[data-testid="${DEVICE_TRIGGER}"]`).getAttribute("aria-expanded")).toBe(
          "true",
        );
        await browser.saveScreenshot(join(dir, `${locale}-${theme}-${width}.png`));
        await browser.keys("Escape");
        expect(await $(`[data-testid="${TID_SETTINGS_MEMORY_SWITCH}"]`).isDisplayed()).toBe(true);
      }
    }
  }
  await browser.execute(() => {
    const actions = (
      window as Window & {
        __testActions?: { setLocale(value: string): void; setTheme(value: string): void };
      }
    ).__testActions;
    actions?.setLocale("zh-CN");
    actions?.setTheme("light");
  });
  await setCurrentElectronRendererContentSize(1280, 800);
}

describe(`${CASE_MARKER}: 按设备设置记忆`, () => {
  let container = "";
  let sourceId = "";
  let configured = false;
  let offlineTarget: { host: string; port: number } | null = null;

  after(async () => {
    if (offlineTarget) await bringRemoteDeviceOnline(container, offlineTarget);
    if (container) {
      await chmodRemoteContainerPath(container, "u+w", REMOTE_SETTINGS_DIR);
      // 同批 SSH P0 复用这个容器；清理只恢复本例开关，保留最新的其他设置。
      const settings = JSON.parse(
        await readRemoteContainerFile(container, REMOTE_SETTINGS),
      ) as Record<string, unknown>;
      await writeRemoteContainerFile(
        container,
        REMOTE_SETTINGS,
        JSON.stringify({ ...settings, memoryEnabled: false }),
      );
    }
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("MEM-DEVICE-01 复用设备菜单，远端与本机开关分别保存并读回", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    container = readRemoteDockerContainer(CASE_MARKER);
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const remote = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config,
      workspacePath: config.workspacePaths[0],
    });
    sourceId = parseRemoteWorkspaceIdentity(remote.workspaceIdentity ?? "")?.sourceServerId ?? "";
    expect(sourceId).toBeTruthy();

    await openSection("memory");
    await openDeviceMenu();
    const menu = await browser.execute(() => ({
      headings: [
        ...document.querySelectorAll<HTMLElement>('[data-scope-device-heading="true"]'),
      ].map((item) => item.innerText.trim()),
      keys: [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map(
        (item) => item.dataset.pluginScopeKey,
      ),
      projects: document.querySelectorAll('[data-scope-projects-trigger="true"]').length,
    }));
    expect(menu.headings).toHaveLength(2);
    expect(menu.headings[0]).toBe("本机");
    expect(menu.keys).toEqual(["user", `source-user:${sourceId}`]);
    expect(menu.projects).toBe(0);
    await browser.keys("Escape");
    expect(await $(`[data-testid="${DEVICE_TRIGGER}"]`).getAttribute("data-plugin-scope-key")).toBe(
      `source-user:${sourceId}`,
    );
    await waitForSwitch(false);
    await setMemory(true, () => readRemoteMemory(container));
    expect(await readLocalMemory()).toBe(false);
    expect(await $('[data-testid="settings-memory-remote-details"]').isDisplayed()).toBe(true);

    await selectDevice("user");
    await waitForSwitch(false);
    await setMemory(true, readLocalMemory);
    await setMemory(false, readLocalMemory);
    expect(await readRemoteMemory(container)).toBe(true);
    await selectDevice(`source-user:${sourceId}`);
    await waitForSwitch(true);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await openSection("memory");
    await waitForSwitch(true);
    configured = true;
  });

  it("MEM-DEVICE-03 保存失败保留原值，重试成功；切换、主题与窄窗口正常", async function () {
    this.timeout(5 * 60_000);
    if (!configured) this.skip();
    await selectDevice(`source-user:${sourceId}`);
    await waitForSwitch(true);
    // 真实远端目录拒绝写入，覆盖 RPC 保存失败；不以 mock 替代 SSH 持久化。
    await chmodRemoteContainerPath(container, "a-w", REMOTE_SETTINGS_DIR);
    try {
      await clickTestIdByDom(TID_SETTINGS_MEMORY_SWITCH);
      await waitForTestIdByDom("settings-memory-error", { timeout: 30_000 });
      await waitForSwitch(true);
      expect(await readRemoteMemory(container)).toBe(true);
      expect(await readLocalMemory()).toBe(false);
    } finally {
      await chmodRemoteContainerPath(container, "u+w", REMOTE_SETTINGS_DIR);
    }
    await setMemory(false, () => readRemoteMemory(container));
    await setMemory(true, () => readRemoteMemory(container));
    for (let index = 0; index < 3; index++) {
      await selectDevice("user");
      expect([null, false]).toContain(await readMemorySwitch());
      await waitForSwitch(false);
      await selectDevice(`source-user:${sourceId}`);
      expect([null, true]).toContain(await readMemorySwitch());
      await waitForSwitch(true);
    }
    await captureLayouts();
  });

  it("MEM-DEVICE-02 远端离线不回退本机，恢复后读回远端开关", async function () {
    this.timeout(10 * 60_000);
    if (!configured) this.skip();
    const config = readSSHRuntimeConfig(CASE_MARKER);
    offlineTarget = { host: config.host, port: config.port };
    await takeRemoteDeviceOffline(container);
    await $('[data-scope-blocked="offline"]').waitForDisplayed({ timeout: 5 * 60_000 });
    expect(await readMemorySwitch()).toBeNull();
    expect(await $(`[data-testid="${DEVICE_TRIGGER}"]`).getAttribute("data-plugin-scope-key")).toBe(
      `source-user:${sourceId}`,
    );
    await selectDevice("user");
    await waitForSwitch(false);
    await bringRemoteDeviceOnline(container, offlineTarget);
    offlineTarget = null;
    await openSection("remoteDevices");
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const card = document.querySelector(`[data-source-server-card="${id}"]`);
          if (card?.querySelector('[data-remote-connection-status="online"]')) return true;
          const connect = [...(card?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
            (button) => !button.disabled && ["连接", "Connect"].includes(button.innerText.trim()),
          );
          connect?.click();
          return false;
        }, sourceId),
      { timeout: 120_000, interval: 1_000 },
    );
    await openSection("memory");
    await selectDevice(`source-user:${sourceId}`);
    await waitForSwitch(true);
    expect(await readLocalMemory()).toBe(false);
  });
});
