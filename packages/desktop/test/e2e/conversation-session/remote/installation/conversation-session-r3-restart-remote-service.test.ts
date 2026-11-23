import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_CONFIRM_DIALOG_CONFIRM, TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { getToastMessages } from "#e2e/helpers/conversation-session-toast";
import {
  openRemoteDevicesSettings,
  waitForDeviceStatus,
} from "#e2e/helpers/remote-project-actions";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  readRemoteCoreIdentity,
  readTaskRowInProject,
  sendSSHFollowTurn,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "#e2e/helpers/ssh-remote-lifecycle";
import { readHostProcesses, runSSHCommand, waitForRemoteTab } from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_R3_RESTART_REMOTE_SERVICE";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-restart-remote-service",
);

/**
 * 在渲染进程里记录设备卡状态标签的每一次变化：重启期间的“连接中”只持续数秒，轮询可能错过。
 * 记录的是 DOM 上可见的状态与文案，不读取任何内部状态。
 */
async function startDeviceStatusRecorder(sourceId: string): Promise<void> {
  await browser.execute((id: string) => {
    const target = window as Window & {
      __rdlcStatuses?: string[];
      __rdlcObserver?: MutationObserver;
    };
    target.__rdlcObserver?.disconnect();
    const statuses: string[] = [];
    target.__rdlcStatuses = statuses;
    const record = () => {
      const tag = document.querySelector<HTMLElement>(
        `[data-source-server-card="${id}"] [data-remote-connection-status]`,
      );
      if (!tag) return;
      const entry = `${tag.getAttribute("data-remote-connection-status")}:${tag.innerText.trim()}`;
      if (statuses.at(-1) !== entry) statuses.push(entry);
    };
    record();
    target.__rdlcObserver = new MutationObserver(record);
    target.__rdlcObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-remote-connection-status"],
    });
  }, sourceId);
}

async function stopDeviceStatusRecorder(): Promise<string[]> {
  return await browser.execute(() => {
    const target = window as Window & {
      __rdlcStatuses?: string[];
      __rdlcObserver?: MutationObserver;
    };
    target.__rdlcObserver?.disconnect();
    return target.__rdlcStatuses ?? [];
  });
}

function restartDialog() {
  return $('[role="dialog"][data-confirm-intent="source-server-restart"]');
}

describe(`${CASE_MARKER}: 设备卡重启远端服务`, () => {
  let provider: SSHLifecycleProvider | null = null;

  after(async () => {
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-BLD-11 从设备卡「更多」重启远端服务：Supervisor 与 Core 都换代，设备回到已连接，已打开会话可继续发送", async function () {
    this.timeout(30 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    const { config } = prepared;
    const [workspaceA] = config.workspacePaths;
    const facts: Record<string, unknown> = {};

    const taskA: SSHLifecycleTask = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const sourceId = parseRemoteWorkspaceIdentity(taskA.identity)?.sourceServerId;
    if (!sourceId) throw new Error(`${CASE_MARKER}: 首连缺少设备身份`);
    const core0 = await readRemoteCoreIdentity(config, CASE_MARKER);
    expect(core0.state).toBe("ready");
    facts.before = core0;

    await openRemoteDevicesSettings();
    await waitForDeviceStatus(sourceId, "online", CASE_MARKER);

    // 1. 「重启远端服务」在停止之前、不是 destructive；确认弹窗是危险确认。
    await $(`[data-source-server-card="${sourceId}"] button[aria-label="更多"]`).click();
    const item = $('[role="menu"] [data-source-server-lifecycle-action="restart"]');
    await item.waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 缺少重启远端服务`,
    });
    expect(await item.getAttribute("data-disabled")).toBeNull();
    expect(await item.getAttribute("data-variant")).not.toBe("destructive");
    const actions = await browser.execute(() =>
      Array.from(
        document.querySelectorAll('[role="menu"] [data-source-server-lifecycle-action]'),
        (element) => element.getAttribute("data-source-server-lifecycle-action"),
      ),
    );
    // RDRI-01 已在重启与停止之间加入重装；保留完整顺序断言，不能把新入口当成回归。
    expect(actions).toEqual(["restart", "reinstall", "stop"]);
    await item.click();
    await restartDialog().waitForDisplayed({ timeout: 15_000 });

    // 2. 确认重启：设备只经历“连接中”，完成后回到已连接，并给出成功提示。
    await startDeviceStatusRecorder(sourceId);
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, { timeout: 15_000 });
    let toasts: string[] = [];
    await browser.waitUntil(
      async () => {
        toasts = await getToastMessages();
        return toasts.some(
          (message) =>
            message.includes("已重启") || message.includes("Restarted the remote service"),
        );
      },
      {
        timeout: 120_000,
        timeoutMsg: `${CASE_MARKER}: 没有重启成功提示；latest=${JSON.stringify(toasts)}`,
      },
    );
    await waitForDeviceStatus(sourceId, "online", CASE_MARKER, 30_000);
    const statuses = await stopDeviceStatusRecorder();
    facts.deviceStatuses = statuses;
    expect(statuses.some((entry) => entry.startsWith("connecting:"))).toBe(true);
    expect(statuses.some((entry) => /^(failed|offline):/u.test(entry))).toBe(false);
    // 重启只显示连接中：不显示“更新中”，也不显示自动重试计数。
    expect(statuses.some((entry) => /更新中|Updating|\d+\/\d+/u.test(entry))).toBe(false);

    // 3. 远端 Supervisor 与 Core 都是新进程，仍以 detached 方式运行；Window Host 数不变。
    const core1 = await readRemoteCoreIdentity(config, CASE_MARKER);
    expect(core1.state).toBe("ready");
    expect(core1.pid).not.toBe(core0.pid);
    expect(core1.supervisorPid).not.toBe(core0.supervisorPid);
    const status1 = JSON.parse(
      (await runSSHCommand(config, 'cat "$HOME/.zcode/server/run/status.json"')).stdout,
    ) as { serviceRegistered: boolean; crashBudget: { crashCount: number } };
    expect(status1.serviceRegistered).toBe(false);
    expect(status1.crashBudget.crashCount).toBe(0);
    facts.after = core1;
    expect(await readHostProcesses()).toEqual(prepared.initialHosts);

    // 4. 已打开的会话挂回新的远端会话，并能继续发送。
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
    const reattached = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
      requireActive: false,
    });
    expect(reattached.remoteSessionId).not.toBe(taskA.remoteSessionId);
    facts.reattached = reattached;
    const resumed: SSHLifecycleTask = { ...taskA, remoteSessionId: reattached.remoteSessionId! };
    await readTaskRowInProject(resumed, CASE_MARKER);
    await sendSSHFollowTurn(resumed, CASE_MARKER);

    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "restart-remote-service.json"),
      JSON.stringify(facts, null, 2),
    );
  });
});
