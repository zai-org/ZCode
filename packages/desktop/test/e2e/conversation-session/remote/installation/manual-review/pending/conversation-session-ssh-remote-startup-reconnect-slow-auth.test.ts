import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  readSettings,
  seedSettings,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openRemoteConnectionSelection,
  readSSHRuntimeConfig,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// 3.16.2 工单 ZCT-2112827425880723456 的真实 SSH 验证（本机 Docker runner）：
// 启动时自动重连单设备 10 秒预算；SSH 已收到 banner、认证还没完成时超时取消，ssh2 不发 error，
// 连接永不结束，设备一直“连接中”，之后的手动连接也等在这次尝试上，只能重启 App。
// 注入方式：在远端 sshd 的 PAM 认证栈最前面加一个 50 秒的 pam_exec 延迟（banner 照常发送，
// 密码认证变慢，仍短于 60 秒握手超时），再冷启动 App。修复前设备一直“连接中”，直到 sshd 结束
// PAM 后自行断开（容器内约 50 秒；工单现场连接一直不断开，持续 25 分钟以上）。
const MARKER = "E2E_SSH_STARTUP_RECONNECT_SLOW_AUTH";
const SLOW_AUTH_LINE = "auth optional pam_exec.so quiet /bin/sleep 50";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-remote-startup-reconnect-slow-auth",
);

async function readCardStatus(sourceServerId: string): Promise<string | null> {
  return browser.execute(
    (id) =>
      document
        .querySelector(`[data-source-server-card="${id}"] [data-remote-connection-status]`)
        ?.getAttribute("data-remote-connection-status") ?? null,
    sourceServerId,
  );
}

/** 记录设备卡状态变化，直到满足条件；超时时带出完整时间线（timeoutMsg 在等待前就已求值）。 */
async function recordCardStatusUntil(
  sourceServerId: string,
  done: (status: string | null) => boolean,
  timeout: number,
  description: string,
): Promise<Array<{ atMs: number; status: string | null }>> {
  const startedAt = Date.now();
  const timeline: Array<{ atMs: number; status: string | null }> = [];
  try {
    await browser.waitUntil(
      async () => {
        const status = await readCardStatus(sourceServerId);
        if (timeline.length === 0 || timeline.at(-1)!.status !== status)
          timeline.push({ atMs: Date.now() - startedAt, status });
        return done(status);
      },
      { timeout, interval: 500 },
    );
  } catch {
    throw new Error(`${MARKER}: ${description}；状态时间线 ${JSON.stringify(timeline)}`);
  }
  return timeline;
}

async function openRemoteDevicesSettings(): Promise<void> {
  if (!(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed())) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
  }
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"), { timeout: 30_000 });
}

describe(`${MARKER}: 启动重连遇到慢认证`, () => {
  const facts: Record<string, unknown> = {};
  let container: string | undefined;

  after(async () => {
    if (container) {
      await execInRemoteContainer(
        container,
        ["sh", "-c", `sed -i '\\|${SLOW_AUTH_LINE}|d' /etc/pam.d/sshd`],
        { user: "0" },
      ).catch(() => undefined);
    }
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "ssh-remote-startup-reconnect-slow-auth.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SRSA-01 启动超时后设备进入失败而非一直连接中；手动连接新建尝试并上线", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    container = readRemoteDockerContainer(MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });

    // 1) 正常连上设备，使它成为“最近 7 天在线”的启动重连候选。
    await openRemoteConnectionSelection();
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(MARKER);
    await waitForSSHDirectoryStep(MARKER, undefined, { allowBoundaryAcknowledgement: true });
    const source = (await readSettings()).sourceServers?.[0];
    if (!source) throw new Error(`${MARKER}: 首次连接没有登记 Source`);
    const sourceServerId = source.sourceServerId;

    // 2) 远端密码认证变慢（>10 秒启动预算，<60 秒握手超时），然后冷启动 App。
    await execInRemoteContainer(
      container,
      ["sh", "-c", `sed -i '1i ${SLOW_AUTH_LINE}' /etc/pam.d/sshd`],
      { user: "0" },
    );
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await seedSettings({ remoteStartupAutoReconnectEnabled: true });
      },
    });
    const restartedAt = Date.now();
    await waitForRendererAfterColdRestart(MARKER);
    await openRemoteDevicesSettings();

    // 3) 启动重连 10 秒超时后，设备必须很快离开“连接中”：从重启算起，10 秒预算 + 冷启动开销，
    //    留 25 秒上限。修复前停在 connecting，直到 sshd 自行断开。
    const timeline = await recordCardStatusUntil(
      sourceServerId,
      (status) => Boolean(status && status !== "connecting"),
      Math.max(1_000, restartedAt + 25_000 - Date.now()),
      "启动重连超时后设备仍是“连接中”",
    );
    facts.startupTimeline = timeline;
    expect(timeline.at(-1)!.status).toBe("failed");

    // 4) 去掉延迟后手动连接：必须新建尝试并上线，不能等在旧的启动尝试上。
    await execInRemoteContainer(
      container,
      ["sh", "-c", `sed -i '\\|${SLOW_AUTH_LINE}|d' /etc/pam.d/sshd`],
      { user: "0" },
    );
    const clicked = await browser.execute((id) => {
      const card = document.querySelector(`[data-source-server-card="${id}"]`);
      const button = Array.from(card?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (item) =>
          item.getClientRects().length > 0 &&
          !item.disabled &&
          ["重试", "连接", "重新连接"].includes(item.textContent?.trim() ?? ""),
      );
      button?.click();
      return button?.textContent?.trim() ?? null;
    }, sourceServerId);
    facts.manualAction = clicked;
    if (!clicked) throw new Error(`${MARKER}: 设备卡没有可用的连接入口`);
    const manualTimeline = await recordCardStatusUntil(
      sourceServerId,
      (status) => status === "online",
      90_000,
      "手动连接没有上线",
    );
    facts.manualTimeline = manualTimeline;
  });
});
