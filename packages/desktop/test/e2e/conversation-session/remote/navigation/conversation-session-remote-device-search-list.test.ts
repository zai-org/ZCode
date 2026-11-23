import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  appSettingsSchema,
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type SourceServerRecord,
} from "@zcode/shared";
import { clearAppData, getE2EAppDataPaths, readSettings } from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  openRemoteDevicesSettings,
  waitForDeviceStatus,
} from "#e2e/helpers/remote-project-actions";
import { connectSSHWorkspace, readSSHRuntimeConfig } from "#e2e/helpers/ssh-remote-p0";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_REMOTE_DEVICE_SEARCH_LIST";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "remote-device-search-list");
const LIST = "[data-source-server-device-list]";

async function deviceIds(): Promise<string[]> {
  return browser.execute(
    (selector) =>
      [...document.querySelectorAll<HTMLElement>(`${selector} [data-source-server-card]`)].map(
        (row) => row.dataset.sourceServerCard!,
      ),
    LIST,
  );
}

async function search(query: string, expected: string[]): Promise<void> {
  const input = $('input[placeholder="搜索设备名、地址或项目"]');
  // 清空走产品实际按钮，不能用 WebDriver 的空 setValue 代替 React 受控输入的清空动作。
  if (query === "") await $('button[aria-label="清空搜索"]').click();
  else await input.setValue(query);
  expect(await input.getValue()).toBe(query);
  await browser.waitUntil(
    async () => JSON.stringify(await deviceIds()) === JSON.stringify(expected),
    {
      timeout: 15_000,
      timeoutMsg: `${MARKER}: 搜索 ${query} 的设备集合不正确`,
    },
  );
}

describe("RDUX-13-LIST-01：多设备列表搜索、展开与稳定排序", () => {
  after(async () => {
    await clearAppData();
  });

  it("17 条设备记录可搜索，同面板顺序冻结、连接重入后按最近使用排序", async function () {
    this.timeout(15 * 60_000);
    await mkdir(artifactDir, { recursive: true });
    await prepareV4ConversationE2E({ skipProvider: true });
    const config = readSSHRuntimeConfig(MARKER);
    const connected = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[0],
    });
    const realId = parseRemoteWorkspaceIdentity(connected.workspaceIdentity!)?.sourceServerId;
    expect(realId).toBeTruthy();
    const settings = await readSettings();
    const realServer = settings.sourceServers?.find((item) => item.sourceServerId === realId);
    const realProfile = settings.connectionProfiles?.find((item) => item.sourceServerId === realId);
    if (!realServer || !realProfile) throw new Error("缺少真实连接持久化记录");
    const baseTime = Date.now() - 30_000;
    const fixtures = Array.from({ length: 16 }, (_, index) => {
      const number = index + 1;
      const id = randomUUID();
      const profileId = randomUUID();
      const path = `/srv/project-needle-${number}`;
      const identity = buildServerRemoteWorkspaceIdentity({ serverId: id, workspacePath: path });
      return {
        id,
        server: {
          ...realServer,
          sourceServerId: id,
          displayName: `Rack ${number}`,
          hostname: `host-${number}`,
          preferredProfileId: profileId,
          lastOnlineAt: baseTime + number,
          declaredWorkspaces: [
            { workspacePath: path, workspaceIdentity: identity, label: `Project ${number}` },
          ],
        } satisfies SourceServerRecord,
        profile: {
          ...realProfile,
          profileId,
          sourceServerId: id,
          displayName: `fixture-${number}`,
          createdAt: baseTime + number,
          lastConnectedAt: baseTime + number,
          target: {
            ...realProfile.target,
            host: `address-${number}.example.test`,
            passwordCredentialKey: undefined,
          },
        },
        history: {
          workspacePath: path,
          workspaceIdentity: identity,
          profileId,
          sourceServerId: id,
          lastOpenedAt: baseTime + number,
        },
      };
    });
    // 先走生产 schema，缺必填字段时在当前进程失败，不能把无效夹具写入后再误判冷恢复。
    const fixtureSettings = appSettingsSchema.parse({
      ...settings,
      remoteStartupAutoReconnectEnabled: false,
      lastActiveWorkspace: undefined,
      lastActiveTabIndex: 0,
      lastWorkspaceSession: settings.lastWorkspaceSession?.filter(
        (entry) => entry.kind === "local",
      ),
      sourceServers: [
        { ...realServer, displayName: "Actual SSH device", lastOnlineAt: baseTime - 1000 },
        ...fixtures.map((item) => item.server),
      ],
      connectionProfiles: [
        { ...realProfile, lastConnectedAt: baseTime - 1000 },
        ...fixtures.map((item) => item.profile),
      ],
      sourceServerWorkspaceHistory: [
        ...(settings.sourceServerWorkspaceHistory ?? []).map((entry) => ({
          ...entry,
          lastOpenedAt: baseTime - 1000,
        })),
        ...fixtures.map((item) => item.history),
      ],
    });
    // 夹具只在 Main/Host 完整退出后写入，再由正常冷启动读取，避免覆盖活跃 owner 的状态。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        const paths = getE2EAppDataPaths();
        await writeFile(join(paths.appDataDir, "setting.json"), JSON.stringify(fixtureSettings));
      },
    });
    await waitForRendererAfterColdRestart(MARKER);
    await openRemoteDevicesSettings();
    await browser.waitUntil(async () => (await deviceIds()).length === 17, { timeout: 30_000 });
    const order = await deviceIds();
    const expectedOrder: string[] = [...fixtures].reverse().map((item) => item.id);
    expectedOrder.push(realId!);
    expect(order).toEqual(expectedOrder);
    expect(
      await browser.execute(
        (selector) =>
          [...document.querySelectorAll(`${selector} [data-source-server-toggle]`)].every(
            (item) => item.getAttribute("aria-expanded") === "false",
          ),
        LIST,
      ),
    ).toBe(true);
    await search("rack 7", [fixtures[6]!.id]);
    await search("  RACK 7  ", [fixtures[6]!.id]);
    await search("host-12", [fixtures[11]!.id]);
    await search("address-9.example.test", [fixtures[8]!.id]);
    await search("Project 14", [fixtures[13]!.id]);
    await search("missing-device", []);
    await search("", order);
    const first = $(`[data-source-server-card="${order[0]}"] [data-source-server-toggle]`);
    const second = $(`[data-source-server-card="${order[1]}"] [data-source-server-toggle]`);
    await first.click();
    await second.click();
    expect(await first.getAttribute("aria-expanded")).toBe("true");
    expect(await second.getAttribute("aria-expanded")).toBe("true");
    await first.click();
    await second.click();
    const listBeforeConnect = (await $(LIST)).elementId;
    await $(`[data-source-server-card="${realId}"]`).$("button=连接").click();
    await waitForDeviceStatus(realId!, "online", MARKER, 120_000);
    await browser.waitUntil(
      () =>
        browser.execute((selector) => {
          const list = document.querySelector(selector);
          return (
            Boolean(list) &&
            !document.querySelector('[data-testid="ssh-dialog"]') &&
            list?.closest("[aria-busy]")?.getAttribute("aria-busy") !== "true"
          );
        }, LIST),
      { timeout: 30_000, timeoutMsg: `${MARKER}: 连接后的列表操作未结束` },
    );
    await browser.executeAsync((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    const panelRecreatedAfterConnect = (await $(LIST)).elementId !== listBeforeConnect;
    const orderAfterConnect = await deviceIds();
    // 冻结只作用于同一面板；连接向导返回并定位设备会重建面板，按合同重新计算最近使用顺序。
    if (panelRecreatedAfterConnect) {
      expect(orderAfterConnect).toEqual([realId, ...order.filter((id) => id !== realId)]);
      expect(
        await $(`[data-source-server-card="${realId}"] [data-source-server-toggle]`).getAttribute(
          "aria-expanded",
        ),
      ).toBe("true");
    } else expect(orderAfterConnect).toEqual(order);
    await writeFile(
      resolve(artifactDir, "facts.json"),
      JSON.stringify(
        {
          realSource: realId,
          fixtureCount: 16,
          order,
          searchFields: ["name", "hostname", "address", "project"],
          panelRecreatedAfterConnect,
          orderAfterConnect,
          orderMatchedPanelContract: true,
        },
        null,
        2,
      ),
    );
    await $(LIST).scrollIntoView({ block: "start" });
    for (const locale of ["zh-CN", "en-US"]) {
      for (const theme of ["light", "dark"]) {
        await browser.execute(
          (lang, appearance) => {
            const actions = (
              window as Window & {
                __testActions?: { setLocale(value: string): void; setTheme(value: string): void };
              }
            ).__testActions;
            actions?.setLocale(lang);
            actions?.setTheme(appearance);
          },
          locale,
          theme,
        );
        for (const width of [1440, 700]) {
          await browser.electron.execute((electron, width) => {
            electron.BrowserWindow.getAllWindows()
              .find((window) => window.isVisible())
              ?.setSize(width, 900);
          }, width);
          await browser.executeAsync((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
          await browser.saveScreenshot(resolve(artifactDir, `${locale}-${theme}-${width}.png`));
        }
      }
    }
  });
});
