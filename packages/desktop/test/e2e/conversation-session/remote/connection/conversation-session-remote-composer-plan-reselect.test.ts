import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  INDIVIDUAL_PROVIDER_ID,
  PERSONAL_PLAN_CONNECTION_KEY,
  REMOTE_DATA_DIR,
  SYNC_TIMEOUT_MS,
  TEAM_PLAN_KEY,
  closeSettingsPage as closeSettingsPageFor,
  collectRemoteDiagnostics,
  readAccountSettingsSyncs as readAccountSettingsSyncsFor,
  readLocalAccountSettings,
  readRemoteSelectionKind,
  seedSignedInIndividualPlan as seedSignedInIndividualPlanFor,
  selectConnectionModeInSettings as selectConnectionModeInSettingsFor,
  switchComposerProvider as switchComposerProviderFor,
  waitForAccountSettingsSyncs as waitForAccountSettingsSyncsFor,
} from "#e2e/helpers/remote-composer-plan-connection";
import {
  chmodRemoteContainerPath,
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspace,
  createSSHReplayTunnel,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// ZCT-2118278184274395136：SSH 工作区里「个人套餐 → 普通 API → 同一个人套餐」每次切回 1.5～8 秒。
// 普通 API 不写套餐设置，切回时连接仍已生效；旧实现仍保存一次，向远端推一轮 account-settings
// Provisioning，并让目标 refresh 等它写完。
//
// 事件顺序：
//   本机预置 OAuth 与个人套餐 → SSH 反向隧道让容器访问同一账号 mock → 连接 SSH 项目（首次下发）
//   ① 切回已生效连接：API → 个人 → API → 个人，不写设置、不推 account-settings、切换成功
//   ② 远端未同步时回退：设置页改团队（远端同步）→ 远端只读 → 设置页改回个人（远端同步失败，
//      远端仍是团队）→ 恢复可写 → Composer API → 个人：走原流程保存并重新推送，远端变回个人
const CASE_MARKER = "E2E_REMOTE_PLAN_RESELECT";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-composer-plan-reselect",
);

// 共用步骤见 remote-composer-plan-connection（RPR-01 / RPR-02 共用）；这里绑定本用例的 marker。
const readAccountSettingsSyncs = () => readAccountSettingsSyncsFor(CASE_MARKER);
const waitForAccountSettingsSyncs = (count: number, timeoutMsg: string) =>
  waitForAccountSettingsSyncsFor(CASE_MARKER, count, timeoutMsg);
const seedSignedInIndividualPlan = () => seedSignedInIndividualPlanFor(CASE_MARKER);
const switchComposerProvider = (providerId: string, label: string) =>
  switchComposerProviderFor(CASE_MARKER, providerId, label);
const selectConnectionModeInSettings = (optionKey: string) =>
  selectConnectionModeInSettingsFor(CASE_MARKER, optionKey);
const closeSettingsPage = () => closeSettingsPageFor(CASE_MARKER);

describe(`${CASE_MARKER}: 远端 Composer 切回已生效套餐连接`, () => {
  const facts: Record<string, unknown> = {};
  let closeTunnel: (() => Promise<void>) | undefined;
  let diagnosticsContainer: string | undefined;

  after(async () => {
    if (diagnosticsContainer)
      facts.remoteDiagnostics = await collectRemoteDiagnostics(diagnosticsContainer);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "plan-reselect.json"), JSON.stringify(facts, null, 2));
    await closeTunnel?.();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RPR-01 切回已生效连接不重推远端；远端未同步时回退原流程并重新推送", async function () {
    this.timeout(25 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const container = readRemoteDockerContainer(CASE_MARKER);
    diagnosticsContainer = container;
    const workspacePath = config.workspacePaths[0];
    const apiProviderId = process.env.E2E_PROVIDER_ID?.trim();
    if (!apiProviderId) throw new Error(`${CASE_MARKER}: 缺少 E2E API Provider`);

    await seedSignedInIndividualPlan();
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E();
    // 远端按下发的 ZCODE_BASE_URL（宿主 127.0.0.1:<port>）查询套餐权益；在容器内监听同一端口转发到宿主。
    const tunnel = await createSSHReplayTunnel(config, CASE_MARKER, {
      username: "tunnel",
      mirrorLocalPort: true,
      targetBaseURL: process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL,
    });
    closeTunnel = tunnel.close;
    // 远端查个人/团队套餐权益读 BIGMODEL_API_BASE_URL，它不在 Desktop 转发给远端的运行时变量里；
    // 经 PAM 读取的 /etc/environment 让这台机器的 SSH 会话指向同一 mock，相当于远端本机环境配置。
    await execInRemoteContainer(
      container,
      ["sh", "-c", `echo 'BIGMODEL_API_BASE_URL=${tunnel.baseURL}' >> /etc/environment`],
      { user: "0" },
    );
    await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });
    facts.remoteSelectionAfterConnect = await readRemoteSelectionKind(container);
    expect(facts.remoteSelectionAfterConnect).toBe("individual-coding-plan");

    // ① 工单场景：设置一直是个人套餐，经普通 API 切回时不应再写设置或推远端。
    const syncsBefore = (await readAccountSettingsSyncs()).length;
    const settingsBefore = await readLocalAccountSettings();
    const durations: Record<string, number> = {};
    durations.apiToIndividualFirst = await switchComposerProvider(
      INDIVIDUAL_PROVIDER_ID,
      "个人套餐",
    );
    durations.individualToApi = await switchComposerProvider(apiProviderId, "普通 API");
    durations.apiToIndividual = await switchComposerProvider(INDIVIDUAL_PROVIDER_ID, "个人套餐");
    // 写入后 Provisioning 会在 1～2 秒内记录结果；留出时间，确保没有迟到的 account-settings 轮次。
    await browser.pause(5_000);
    const settingsAfter = await readLocalAccountSettings();
    const syncsAfter = (await readAccountSettingsSyncs()).length;
    facts.effective = { durations, settingsBefore, settingsAfter, syncsBefore, syncsAfter };
    expect(settingsAfter).toEqual(settingsBefore);
    expect(syncsAfter).toBe(syncsBefore);

    // ② 制造「本机已是个人、远端仍是团队」：设置页改团队并等远端同步，再在远端只读时改回个人。
    await switchComposerProvider(apiProviderId, "普通 API");
    const baseline = (await readAccountSettingsSyncs()).length;
    await selectConnectionModeInSettings(TEAM_PLAN_KEY);
    const toTeam = await waitForAccountSettingsSyncs(baseline + 1, "改团队后没有远端同步结果");
    expect(toTeam.at(-1)?.status).toMatch(/^(applied|already-applied)$/u);
    await browser.waitUntil(
      async () => (await readRemoteSelectionKind(container)) === "team-coding-plan",
      { timeout: SYNC_TIMEOUT_MS, timeoutMsg: `${CASE_MARKER}: 远端没有收到团队连接` },
    );
    // 以 dev 身份执行才对远端 server 生效；用例结束前一定恢复。
    await chmodRemoteContainerPath(container, "a-w", REMOTE_DATA_DIR);
    let restored = false;
    try {
      await selectConnectionModeInSettings(PERSONAL_PLAN_CONNECTION_KEY);
      const failed = await waitForAccountSettingsSyncs(
        baseline + 2,
        "远端只读时改个人没有同步结果",
      );
      facts.readonlySync = failed.at(-1);
      expect(failed.at(-1)?.status).not.toMatch(/^(applied|already-applied)$/u);
    } finally {
      await chmodRemoteContainerPath(container, "u+w", REMOTE_DATA_DIR);
      restored = true;
    }
    expect(restored).toBe(true);
    expect((await readLocalAccountSettings()).selection?.kind).toBe("individual-coding-plan");
    facts.remoteSelectionBeforeFallback = await readRemoteSelectionKind(container);
    expect(facts.remoteSelectionBeforeFallback).toBe("team-coding-plan");

    await closeSettingsPage();
    const fallbackBefore = await readLocalAccountSettings();
    const fallbackSyncsBefore = (await readAccountSettingsSyncs()).length;
    durations.fallbackApiToIndividual = await switchComposerProvider(
      INDIVIDUAL_PROVIDER_ID,
      "个人套餐（远端未同步）",
    );
    const fallbackAfter = await readLocalAccountSettings();
    const fallbackSyncs = await readAccountSettingsSyncs();
    facts.fallback = {
      before: fallbackBefore,
      after: fallbackAfter,
      syncs: fallbackSyncs.slice(fallbackSyncsBefore),
      remoteSelection: await readRemoteSelectionKind(container),
    };
    // 远端与本机身份不一致：必须走原流程保存（版本递增）并重新推送，远端回到个人套餐。
    expect(fallbackAfter.selection?.kind).toBe("individual-coding-plan");
    expect(fallbackAfter.providerFamilyDomainUpdatedAt).not.toBe(
      fallbackBefore.providerFamilyDomainUpdatedAt,
    );
    expect(fallbackSyncs.length).toBeGreaterThan(fallbackSyncsBefore);
    expect(fallbackSyncs.at(-1)?.status).toMatch(/^(applied|already-applied)$/u);
    expect(await readRemoteSelectionKind(container)).toBe("individual-coding-plan");
  });
});
