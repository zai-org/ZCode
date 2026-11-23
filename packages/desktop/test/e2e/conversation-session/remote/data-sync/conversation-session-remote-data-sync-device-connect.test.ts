import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SSH_HOST_INPUT,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  waitForTestIdByDom,
  setCurrentElectronRendererContentSize,
} from "#e2e/helpers/desktop-app";
import {
  bringRemoteDeviceOnline,
  readRemoteDockerContainer,
  takeRemoteDeviceOffline,
} from "#e2e/helpers/remote-docker-target";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// DSYNC-05：数据同步页的设备状态与连接（docs/remote/data-sync.md「设备列表与设备同步状态」）。
// 远端为本机 Docker runner（或服务器队列）提供的真实 Linux 容器；离线 / 恢复用 docker stop / start，端口不变。
const CASE_MARKER = "E2E_DSYNC_05_DEVICE_CONNECT";

interface DeviceRowState {
  count: number;
  sourceServerId: string | null;
  state: string | null;
  status: string;
  connection: string;
  actionVariant: string | null;
  actionIcon: string;
  action: string;
  actionDisabled: boolean;
  text: string;
}

async function readDeviceRow(): Promise<DeviceRowState> {
  return await browser.execute(() => {
    const rows = document.querySelectorAll<HTMLElement>(
      '[data-testid="remote-sync-device-list"] [data-source-server-id]',
    );
    const row = rows[0];
    const action = row?.querySelector<HTMLButtonElement>(
      '[data-testid="remote-sync-device-action"]',
    );
    return {
      count: rows.length,
      sourceServerId: row?.dataset.sourceServerId ?? null,
      state: row?.dataset.deviceState ?? null,
      status:
        row?.querySelector('[data-testid="remote-sync-device-status"]')?.textContent?.trim() ?? "",
      connection:
        row?.querySelector('[data-testid="remote-sync-device-connection"]')?.textContent?.trim() ??
        "",
      actionVariant: action?.getAttribute("data-variant") ?? null,
      actionIcon: action?.querySelector("svg")?.getAttribute("class") ?? "",
      action: action?.textContent?.trim() ?? "",
      actionDisabled: action?.disabled ?? true,
      text: row?.textContent ?? "",
    };
  });
}

async function waitForDeviceState(state: string, timeoutMsg: string, timeout = 60_000) {
  let last: DeviceRowState | undefined;
  await browser.waitUntil(
    async () => {
      last = await readDeviceRow();
      return last.state === state;
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}（最后状态 ${JSON.stringify(last)}）`,
    },
  );
  return last!;
}

/** 数据同步页仍在前台，且没有被连接完成跳到「远程设备」页。 */
async function expectOnDataSyncPage(): Promise<void> {
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
  await waitForTestIdByDom("remote-sync-section", {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 连接完成后没有回到数据同步页`,
  });
  expect(await $$("[data-source-server-card]").length).toBe(0);
}

/** 深浅主题 × 中英文的设备列表截图，供人工复核状态点在两种主题下可辨识。 */
async function captureDeviceListScreenshots(label: string): Promise<void> {
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  if (!artifactDir) return;
  const dir = resolve(artifactDir, "dsync-05");
  await mkdir(dir, { recursive: true });
  const apply = async (locale: string, theme: string) =>
    await browser.execute(
      (language, color) => {
        const actions = (
          window as Window & {
            __testActions?: { setLocale(locale: string): void; setTheme(theme: string): void };
          }
        ).__testActions;
        actions?.setLocale(language);
        actions?.setTheme(color);
      },
      locale,
      theme,
    );
  for (const locale of ["zh-CN", "en-US"]) {
    for (const theme of ["light", "dark"]) {
      await apply(locale, theme);
      await browser.executeAsync((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      for (const width of [1200, 480]) {
        await setCurrentElectronRendererContentSize(width, 800);
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        const fits = await browser.execute(() => {
          const list = document.querySelector('[data-testid="remote-sync-device-list"]');
          const row = list?.querySelector<HTMLElement>("[data-source-server-id]");
          return Boolean(row && row.scrollWidth <= row.clientWidth);
        });
        expect(fits).toBe(true);
        await browser.saveScreenshot(join(dir, `${label}-${locale}-${theme}-${width}.png`));
      }
    }
  }
  await apply("zh-CN", "light");
  await setCurrentElectronRendererContentSize(1200, 800);
}

describe(`${CASE_MARKER}: 数据同步页设备状态与连接`, () => {
  let container: string | undefined;
  let target: { host: string; port: number } | undefined;

  after(async () => {
    // 用例中途失败时恢复容器，避免影响同一 runner 的后续 spec。
    if (container && target) {
      await bringRemoteDeviceOnline(container, target).catch(() => undefined);
    }
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DSYNC-05-01/02 空状态连接设备后留在数据同步页；设备离线显示「未连接」，恢复后点「连接」完成连接回到数据同步页并可打开弹窗", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    container = readRemoteDockerContainer(CASE_MARKER);
    target = { host: config.host, port: config.port };

    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });

    // 设置 → 数据与统计 → 数据同步：没有任何设备时显示空状态和「连接远端设备」。
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "dataSync"), {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 设置页没有数据同步分区`,
    });
    await waitForTestIdByDom("remote-sync-empty", {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 没有设备时数据同步页没有空状态`,
    });

    // DSYNC-05-01：空状态按钮以设备管理模式打开连接向导，成功后留在数据同步页，新设备出现在列表中。
    await clickTestIdByDom("remote-sync-empty-connect");
    await waitForTestIdByDom(TID_SSH_HOST_INPUT, {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 空状态没有打开新增设备表单`,
    });
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    expect(await waitForSSHDirectoryStep(CASE_MARKER)).toBe("closed");
    await expectOnDataSyncPage();
    const added = await waitForDeviceState("synced", "新设备没有以在线状态出现在列表中");
    expect(added.count).toBe(1);
    expect(added.text).toContain("SSH");
    expect(added.status).toBe("尚未同步");
    expect(added.action).toBe("同步配置");
    expect(added.connection).toBe("已连接");
    expect(added.actionVariant).toBe("default");
    expect(added.actionIcon).toContain("lucide-upload");
    expect(await $('[data-testid="remote-sync-dialog"]').isExisting()).toBe(false);

    // DSYNC-05-02：设备离线后行变为灰点「未连接」+「连接」；状态只取自管理快照。
    await takeRemoteDeviceOffline(container);
    const offline = await waitForDeviceState(
      "disconnected",
      "设备离线后设备行没有变为「未连接」",
      5 * 60_000,
    );
    expect(offline.status).toBe("未连接");
    expect(offline.action).toBe("连接");
    expect(offline.actionDisabled).toBe(false);
    expect(offline.connection).toBe("未连接");
    expect(offline.actionVariant).toBe("outline");
    expect(offline.actionIcon).toContain("lucide-plug");
    await captureDeviceListScreenshots("disconnected");

    await bringRemoteDeviceOnline(container, target);
    // 恢复后设备仍保持「未连接」，直到用户点「连接」。
    expect((await readDeviceRow()).state).toBe("disconnected");

    await clickTestIdByDom("remote-sync-device-action");
    expect(await waitForSSHDirectoryStep(CASE_MARKER)).toBe("closed");
    await expectOnDataSyncPage();
    const reconnected = await waitForDeviceState("synced", "连接完成后设备行没有变为「同步」");
    expect(reconnected.sourceServerId).toBe(added.sourceServerId);
    expect(reconnected.action).toBe("同步配置");
    expect(reconnected.connection).toBe("已连接");
    expect(await $('[data-testid="remote-sync-dialog"]').isExisting()).toBe(false);
    await captureDeviceListScreenshots("synced");

    // 连接后可以直接打开该设备的同步弹窗。
    await clickTestIdByDom("remote-sync-device-action");
    await waitForTestIdByDom("remote-sync-dialog", { timeout: 30_000 });
    await waitForTestIdByDom("remote-sync-overview-skills", {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: 同步弹窗没有加载概览`,
    });
    expect(await $('[data-testid="remote-sync-offline"]').isExisting()).toBe(false);
  });
});
