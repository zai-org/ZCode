import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  INDIVIDUAL_PROVIDER_ID,
  SYNC_TIMEOUT_MS,
  TEAM_PLAN_KEY,
  clickComposerProviderRow,
  closeComposerMenus,
  closeSettingsPage,
  collectRemoteDiagnostics,
  isComposerProviderLoading,
  readAccountSettingsSyncs,
  readComposerProviderId,
  readLocalAccountSettings,
  readRemoteSelectionKind,
  seedSignedInIndividualPlan,
  selectConnectionModeInSettings,
  startDelayedHttpProxy,
  switchComposerProvider,
  waitForAccountSettingsSyncs,
  type DelayedHttpProxy,
} from "#e2e/helpers/remote-composer-plan-connection";
import {
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

// ZCT-2121942668678008832：SSH 工作区在 Composer 切换套餐连接时报“切换连接失败”并回滚。
// 根因：保存后只异步通知 Main 下发，连接 owner 马上 refresh 目标 Host；远端还没收到本次下发
// （lane 正在执行上一轮，本次排成尾随轮）时读到旧连接，connectionKey 比对失败。
//
// 稳定复现：远端经反向隧道访问账号 mock，隧道后面插一个延迟代理，只拖慢远端请求。
// 远端 apply 先写 setting.json 再做联网的账号刷新，于是出现稳定的窗口：
//
//   设置页改团队 ─▶ lane 第 1 轮：远端写入团队 ─▶ 慢速账号刷新（延迟代理）……
//   Composer 点个人 ─▶ 保存个人 ─▶ lane 只能排第 2 轮（尾随）
//     修复前：立即 refresh 远端 ─▶ 读到团队 ≠ 个人 ─▶ 报错并回滚
//     修复后：等 lane 两轮结束 ─▶ 远端已是个人 ─▶ 核对通过
const CASE_MARKER = "E2E_REMOTE_PLAN_SWITCH_WAIT_PROVISIONING";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-composer-plan-switch-wait",
);
// 远端每个账号请求的额外延迟。一轮账号刷新含多次请求，足够覆盖从设置页回到 Composer 点击的操作时间。
const REMOTE_ACCOUNT_DELAY_MS = 3_000;

describe(`${CASE_MARKER}: 远端 Composer 切换套餐连接等待下发结果`, () => {
  const facts: Record<string, unknown> = {};
  let closeTunnel: (() => Promise<void>) | undefined;
  let proxy: DelayedHttpProxy | undefined;
  let diagnosticsContainer: string | undefined;

  after(async () => {
    if (diagnosticsContainer)
      facts.remoteDiagnostics = await collectRemoteDiagnostics(diagnosticsContainer);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "plan-switch-wait.json"), JSON.stringify(facts, null, 2));
    await closeTunnel?.();
    await proxy?.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RPR-02 lane 正忙时在 Composer 切换连接，等下发完成后核对，不误报失败", async function () {
    this.timeout(25 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const container = readRemoteDockerContainer(CASE_MARKER);
    diagnosticsContainer = container;
    const workspacePath = config.workspacePaths[0];
    const apiProviderId = process.env.E2E_PROVIDER_ID?.trim();
    if (!apiProviderId) throw new Error(`${CASE_MARKER}: 缺少 E2E API Provider`);
    const mockBaseUrl = process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL?.trim();
    if (!mockBaseUrl) throw new Error(`${CASE_MARKER}: 缺少账号套餐 mock 地址`);

    await seedSignedInIndividualPlan(CASE_MARKER);
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E();
    // 远端按下发的地址（宿主 mock 端口）访问账号接口：容器内仍监听 mock 端口，但转发到延迟代理。
    proxy = await startDelayedHttpProxy(mockBaseUrl);
    const tunnel = await createSSHReplayTunnel(config, CASE_MARKER, {
      username: "tunnel",
      mirrorLocalPort: true,
      targetBaseURL: mockBaseUrl,
      forwardBaseURL: proxy.baseURL,
    });
    closeTunnel = tunnel.close;
    await execInRemoteContainer(
      container,
      ["sh", "-c", `echo 'BIGMODEL_API_BASE_URL=${tunnel.baseURL}' >> /etc/environment`],
      { user: "0" },
    );
    await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });
    expect(await readRemoteSelectionKind(container)).toBe("individual-coding-plan");

    // Composer 先切到普通 API，后面点个人时展示会真正换 Provider。
    await switchComposerProvider(CASE_MARKER, apiProviderId, "普通 API");
    const baseline = (await readAccountSettingsSyncs(CASE_MARKER)).length;

    // 开启远端延迟后在设置页改团队：lane 第 1 轮把团队写进远端，随后卡在慢速账号刷新。
    const forwardedBeforeDelay = proxy.forwardedCount();
    proxy.setDelay(REMOTE_ACCOUNT_DELAY_MS);
    await selectConnectionModeInSettings(CASE_MARKER, TEAM_PLAN_KEY);
    await browser.waitUntil(
      async () => (await readRemoteSelectionKind(container)) === "team-coding-plan",
      { timeout: SYNC_TIMEOUT_MS, timeoutMsg: `${CASE_MARKER}: 远端没有写入团队连接` },
    );
    const teamWrittenAt = Date.now();
    // 第 1 轮还没结束：确认此刻没有新的 account-settings 结果，保证 Composer 点击发生在 lane 忙时。
    const syncsWhenTeamWritten = (await readAccountSettingsSyncs(CASE_MARKER)).length;
    await closeSettingsPage(CASE_MARKER);

    const clickedAt = await clickComposerProviderRow(
      CASE_MARKER,
      INDIVIDUAL_PROVIDER_ID,
      "个人套餐（lane 正忙）",
    );
    const syncsWhenClicked = (await readAccountSettingsSyncs(CASE_MARKER)).length;
    // 终态二选一：出现错误提示（修复前），或展示切到个人且 loading 结束（修复后）。
    await browser.waitUntil(
      async () =>
        (await $('[role="alert"]').isExisting()) ||
        ((await readComposerProviderId()) === INDIVIDUAL_PROVIDER_ID &&
          !(await isComposerProviderLoading())),
      { timeout: SYNC_TIMEOUT_MS, timeoutMsg: `${CASE_MARKER}: 切到个人后没有终态` },
    );
    const settledAt = Date.now();
    const alert = (await $('[role="alert"]').isExisting())
      ? await $('[role="alert"]').getText()
      : null;
    await closeComposerMenus();

    const syncs = await waitForAccountSettingsSyncs(
      CASE_MARKER,
      baseline + 2,
      "改团队与切个人没有产生两轮下发结果",
    );
    facts.switch = {
      alert,
      clickAfterTeamWrittenMs: clickedAt - teamWrittenAt,
      switchDurationMs: settledAt - clickedAt,
      syncsWhenTeamWritten: syncsWhenTeamWritten - baseline,
      syncsWhenClicked: syncsWhenClicked - baseline,
      syncs: syncs.slice(baseline),
      remoteRequestsDelayed: proxy.forwardedCount() - forwardedBeforeDelay,
    };
    proxy.setDelay(0);

    // 前提：点击时第 1 轮尚未完成（否则没有复现竞争窗口），且远端请求确实经过延迟代理。
    expect(syncsWhenClicked - baseline).toBe(0);
    expect(proxy.forwardedCount()).toBeGreaterThan(forwardedBeforeDelay);
    // 修复后：不误报失败，展示、本机设置、远端设置都是个人，最后一轮下发成功。
    expect(alert).toBeNull();
    expect(await readComposerProviderId()).toBe(INDIVIDUAL_PROVIDER_ID);
    expect((await readLocalAccountSettings()).selection?.kind).toBe("individual-coding-plan");
    expect(syncs.at(-1)?.status).toMatch(/^(applied|already-applied)$/u);
    await browser.waitUntil(
      async () => (await readRemoteSelectionKind(container)) === "individual-coding-plan",
      { timeout: SYNC_TIMEOUT_MS, timeoutMsg: `${CASE_MARKER}: 远端没有变回个人` },
    );
  });
});
