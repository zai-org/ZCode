import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  appSettingsSchema,
  ServiceChannels,
  type SourceServerManagementSnapshot,
} from "@zcode/shared";
import type { RemoteProjectDirectory } from "@zcode/services";
import { clearAppData, readSettings, seedSettings } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import {
  connectSSHWorkspace,
  readSingleSSHWorkspaceRuntimeConfig,
  readRemoteTabSnapshot,
  fillSSHPasswordSettings,
  clickLastEnabledSSHDialogButton,
} from "#e2e/helpers/ssh-remote-p0";
import { requestRemoteProjectConnection } from "#e2e/helpers/remote-project-actions";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  holdProjectBind,
  waitForHeldProjectBind,
  releaseProjectBind,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";

const MARKER = "E2E_REMOTE_PROJECT_HANDOFF";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-project-handoff",
);
const management = <T>(command: string, args: unknown[] = []) =>
  callHandoffHost<T>(ServiceChannels.SourceServerManagement, command, args);
const directory = () =>
  callHandoffHost<RemoteProjectDirectory>(ServiceChannels.RemoteProjects, "readDirectory");

// 真实 SSH/Host/Root；bind 返回屏障只控制时序，不伪造连接或导航结果。
describe(`${MARKER}: 默认线路与原项目完成有效性`, () => {
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await browser.saveScreenshot(resolve(artifactDir, "handoff-final.png"));
    await restoreHandoffProbes();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RPN-06 默认线路不被备用失败替换，绑定期间移除入口不提交历史或导航", async function () {
    this.timeout(20 * 60_000);
    const config = readSingleSSHWorkspaceRuntimeConfig(MARKER);
    if (!["localhost", "127.0.0.1"].includes(config.host))
      throw new Error("用例仅使用本机隔离 SSH 目标");
    await prepareV4ConversationE2E({ skipProvider: true });
    const initial = await readSettings();
    const connected = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePath,
    });
    const identity = connected.workspaceIdentity!;
    const settings = await readSettings();
    const source = settings.sourceServers!.find((item) =>
      identity.startsWith(`remote:server:${item.sourceServerId}:`),
    )!;
    const primary = settings.connectionProfiles!.find(
      (item) => item.profileId === source.preferredProfileId,
    )!;
    if (primary.target.kind !== "ssh" || !primary.target.passwordCredentialKey)
      throw new Error("缺少已保存 SSH 密码线路");
    const alternate = {
      ...primary,
      profileId: "e568a489-c0a8-4620-a22e-b0f39aa00923",
      displayName: "failed-alternate",
      target: { ...primary.target, port: 1 },
    };
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await seedSettings(
          appSettingsSchema.parse({
            ...settings,
            remoteStartupAutoReconnectEnabled: false,
            connectionProfiles: [...settings.connectionProfiles!, alternate],
            lastWorkspaceSession: initial.lastWorkspaceSession,
            lastActiveWorkspace: initial.lastActiveWorkspace,
          }),
        );
      },
    });
    await waitForRendererAfterColdRestart(MARKER);
    await installHandoffRpcProbe();
    expect((await readRemoteTabSnapshot(identity)).workspacePath).toBeNull();
    await expect(management("connectProfile", [alternate.profileId])).rejects.toThrow();
    const failed = await management<SourceServerManagementSnapshot>("getSnapshot");
    expect(failed.states.find((state) => state.profileId === alternate.profileId)?.state).toBe(
      "failed",
    );
    await requestRemoteProjectConnection(identity, MARKER);
    await browser.waitUntil(
      async () =>
        (await management<SourceServerManagementSnapshot>("getSnapshot")).states.some(
          (state) => state.profileId === primary.profileId && state.state === "online",
        ),
      {
        timeout: 120_000,
        timeoutMsg: "项目连接没有尝试默认线路",
      },
    );
    expect(await $('[data-testid="ssh-dialog"]').isDisplayed()).toBe(false);
    expect((await readRemoteTabSnapshot(identity)).workspacePath).toBeNull();

    await management("disconnectSource", [source.sourceServerId]);
    await callHandoffHost(ServiceChannels.Credential, "delete", [
      primary.target.passwordCredentialKey,
    ]);
    const retained = (await directory()).entries.find(
      (entry) => entry.hostId === `remote:server:${source.sourceServerId}`,
    )!;
    const historyBefore = (await readSettings()).lastWorkspaceSession;
    await holdProjectBind(config.workspacePath);
    await requestRemoteProjectConnection(identity, MARKER);
    await $('[data-testid="ssh-error"]').waitForDisplayed();
    const back = $('[data-testid="ssh-dialog"]').$(
      './/button[normalize-space(.)="返回配置" or normalize-space(.)="Back to configuration"]',
    );
    await back.click();
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(MARKER);
    await waitForHeldProjectBind();
    await callHandoffHost(ServiceChannels.RemoteProjects, "removeEntry", [retained.id]);
    await releaseProjectBind();
    await browser.waitUntil(
      async () => {
        const text = await $('[data-testid="ssh-dialog"]')
          .getText()
          .catch(() => "");
        return /已取消|Cancelled|Canceled/i.test(text);
      },
      { timeout: 30_000, timeoutMsg: "已移除项目的完成意图没有取消" },
    );
    expect((await readRemoteTabSnapshot(identity)).workspacePath).toBeNull();
    // 成员目录驱动兼容历史投影；移除入口应删除远端行，本地历史仍保持原值。
    const historyAfter = (await readSettings()).lastWorkspaceSession ?? [];
    expect(historyAfter.filter((entry) => entry.kind === "remote")).toEqual([]);
    expect(historyAfter.filter((entry) => entry.kind === "local")).toEqual(
      historyBefore?.filter((entry) => entry.kind === "local") ?? [],
    );
    expect((await directory()).entries.some((entry) => entry.id === retained.id)).toBe(false);
    expect(await $('[data-testid="ssh-success"]').isDisplayed()).toBe(false);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "handoff.json"),
      JSON.stringify(
        {
          identity,
          primaryProfileId: primary.profileId,
          alternateProfileId: alternate.profileId,
          removedEntryId: retained.id,
          state: "cancelled",
          removedHistoryAbsent: true,
        },
        null,
        2,
      ),
    );
  });
});
