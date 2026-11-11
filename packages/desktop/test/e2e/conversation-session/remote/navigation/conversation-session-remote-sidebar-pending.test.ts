import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { ServiceChannels, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData, readSettings } from "#e2e/helpers/desktop-app";
import { waitForRemoteDeviceLocated } from "#e2e/helpers/remote-project-actions";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import { prepareSourceServerUpdateArchive } from "#e2e/helpers/source-server-update-fixture";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_REMOTE_SIDEBAR_PENDING";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-sidebar-pending",
);
const run = promisify(execFile);

/** 只读远端当前 release；走 docker exec，不占用被测 SSH 连接。 */
async function setAppearance(locale: "zh-CN" | "en-US", theme: "light" | "dark") {
  await browser.execute(
    (lang, appearance) => {
      const actions = (
        window as Window & {
          __testActions?: {
            setLocale(value: "zh-CN" | "en-US"): void;
            setTheme(value: string): void;
          };
        }
      ).__testActions;
      if (!actions) throw new Error("Missing appearance actions");
      actions.setLocale(lang);
      actions.setTheme(appearance);
    },
    locale,
    theme,
  );
  await browser.executeAsync((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())),
  );
}

async function readRemoteCurrentSha(): Promise<string> {
  const container = process.env.ZCODE_E2E_SSH_CONTAINER?.trim();
  if (!container) throw new Error(`${CASE_MARKER}: 缺少 ZCODE_E2E_SSH_CONTAINER`);
  const { stdout } = await run(
    "docker",
    [
      "exec",
      "-u",
      process.env.ZCODE_E2E_SSH_USERNAME?.trim() || "dev",
      container,
      "bash",
      "-lc",
      'grep -o \'"archiveSha256": *"[0-9a-f]*"\' "$HOME/.zcode/server/current.json" | grep -o "[0-9a-f]\\{64\\}"',
    ],
    { timeout: 30_000 },
  );
  return stdout.trim();
}

describe(`${CASE_MARKER}: 待处理设备在项目行与详情显示具体原因`, () => {
  afterEach(async () => {
    await browser.saveScreenshot(resolve(artifactDir, "last-state.png"));
  });
  after(async () => {
    await restoreHandoffProbes();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RDUX-SIDEBAR-PENDING needs-upgrade 显示“需要更新”，详情入口定位设置页设备卡且不自动更新", async function () {
    this.timeout(15 * 60_000);
    await mkdir(artifactDir, { recursive: true });
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const tab = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config,
      workspacePath: config.workspacePaths[0]!,
    });
    const identity = tab.workspaceIdentity!;
    const sourceId = parseRemoteWorkspaceIdentity(identity)?.sourceServerId;
    if (!sourceId) throw new Error(`${CASE_MARKER}: 远程项目缺少 Source 身份`);
    const profileId = (await readSettings()).connectionProfiles?.find(
      (profile) => profile.sourceServerId === sourceId,
    )?.profileId;
    if (!profileId) throw new Error(`${CASE_MARKER}: 找不到设备线路`);

    // 重打包本轮 release，使远端已安装 SHA 与桌面端期望不一致，复现启动重连停在 needs-upgrade。
    const shaBefore = await readRemoteCurrentSha();
    const repack = await prepareSourceServerUpdateArchive(shaBefore, CASE_MARKER);
    expect(repack.newSha).not.toBe(shaBefore);

    await installHandoffRpcProbe();
    await callHandoffHost(ServiceChannels.SourceServerManagement, "disconnectSource", [sourceId]);
    // 直接走 Host 连接，不经过向导；向导会自动发起更新，无法观察停留在待处理的设备。
    await callHandoffHost(ServiceChannels.SourceServerManagement, "connectProfile", [
      profileId,
    ]).catch(() => undefined);

    await selectTaskOrganizeMode(["项目", "Project"]);
    const row = $(`[data-project-workspace-identity=${JSON.stringify(identity)}]`);
    const status = row.$('[data-testid="project-status-label"]');
    await browser.waitUntil(
      async () =>
        (await status.isExisting()) && /^(需要更新|Update required)$/u.test(await status.getText()),
      { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: 项目行没有显示“需要更新”` },
    );
    expect(await status.getAttribute("class")).toContain("text-warning-surface-foreground");
    expect(await row.$('[data-remote-state-icon="cloud-alert"]').isExisting()).toBe(true);
    // Host 投影曾丢掉 upgradeTarget，桌面端过旧时详情入口误显示“更新远端”；这里锁住投影带出该字段。
    const directory = await callHandoffHost<{ hosts: { id: string; upgradeTarget?: string }[] }>(
      ServiceChannels.RemoteProjects,
      "readDirectory",
    );
    expect(
      directory.hosts.find((host) => host.id === `remote:server:${sourceId}`)?.upgradeTarget,
    ).toBe("server");

    const details = $('[data-testid="remote-identity-details"]');
    for (const locale of ["zh-CN", "en-US"] as const) {
      for (const theme of ["light", "dark"] as const) {
        await setAppearance(locale, theme);
        // 状态是行内关键信息，窄侧栏里也必须完整显示，由项目名和设备名让出空间。
        expect(
          await browser.execute(
            (el) => el.scrollWidth <= el.clientWidth,
            await status.getElement(),
          ),
        ).toBe(true);
        const outside = await browser.execute(() => ({ x: innerWidth - 24, y: 24 }));
        await browser.action("pointer").move(outside).perform();
        await details.waitForDisplayed({ reverse: true });
        await row.$('[data-testid="virtual-project-toggle"]').moveTo();
        await details.waitForDisplayed();
        await browser.saveScreenshot(resolve(artifactDir, `pending-${locale}-${theme}.png`));
      }
    }
    await setAppearance("zh-CN", "dark");
    const outside = await browser.execute(() => ({ x: innerWidth - 24, y: 24 }));
    await browser.action("pointer").move(outside).perform();
    await details.waitForDisplayed({ reverse: true });
    await row.$('[data-testid="virtual-project-toggle"]').moveTo();
    await details.waitForDisplayed();
    const detailsText = await details.getText();
    expect(detailsText).toMatch(/需要更新|Update required/u);
    expect(detailsText).not.toMatch(/需要处理|Needs attention/u);
    const buttons = await details.$$("button");
    expect(buttons).toHaveLength(1);
    const entry = details.$('[data-testid="remote-identity-device-settings"]');
    expect(await entry.getText()).toMatch(/更新远端|Update remote device/u);
    await browser.saveScreenshot(resolve(artifactDir, "pending-details.png"));

    await entry.click();
    await details.waitForDisplayed({ reverse: true });
    const card = $(`[data-source-server-card="${sourceId}"]`);
    await card.waitForDisplayed({ timeout: 15_000 });
    // RDUX-13：定位后只展开目标设备行，焦点在设备名按钮上并持续高亮。
    await waitForRemoteDeviceLocated(sourceId, CASE_MARKER);
    expect(await card.getText()).toMatch(/更新远端|Update remote device/u);
    await browser.saveScreenshot(resolve(artifactDir, "device-settings.png"));
    // 入口只负责定位，不能替用户执行更新。
    expect(await readRemoteCurrentSha()).toBe(shaBefore);
  });
});
