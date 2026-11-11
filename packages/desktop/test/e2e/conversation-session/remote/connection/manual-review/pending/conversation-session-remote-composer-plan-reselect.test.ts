import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_MODEL_CONFIG,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  quitElectronAppGracefully,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import {
  chmodRemoteContainerPath,
  execInRemoteContainer,
  readRemoteContainerFile,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import { sel } from "#e2e/helpers/selectors";
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
const APP_DATA_PATHS = getE2EAppDataPaths();
const SETTINGS_FILE = join(APP_DATA_PATHS.appDataDir, "setting.json");
const REMOTE_DATA_DIR = "/home/dev/.zcode/v2";
const REMOTE_SETTINGS_FILE = `${REMOTE_DATA_DIR}/setting.json`;
const INDIVIDUAL_PROVIDER_ID = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
const BIGMODEL_ACCOUNT_NAV_KEY = `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`;
const TEAM_PLAN_KEY = "team:bigmodel:product-team-a:org-team-a:proj-team-a";
const PERSONAL_PLAN_CONNECTION_KEY = `coding-plan:${INDIVIDUAL_PROVIDER_ID}`;
const SYNC_TIMEOUT_MS = 120_000;

interface ProvisioningLogEntry {
  environmentKey: string;
  trigger: string;
  status: string;
  durationMs?: number;
  errorCode?: string;
}

/** 读取本次 Main 日志里的 Provisioning 结果；只统计 account-settings 触发的轮次。 */
async function readAccountSettingsSyncs(): Promise<ProvisioningLogEntry[]> {
  const directory = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
  if (!directory) throw new Error(`${CASE_MARKER}: 缺少本次 Main 日志目录`);
  const markers = [
    "[provider-provisioning] Environment sync completed ",
    "[provider-provisioning] Environment sync did not apply ",
  ];
  const contents = await Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith(".log"))
      .map((name) => readFile(join(directory, name), "utf8")),
  );
  return contents
    .flatMap((content) =>
      content.split("\n").flatMap((line) => {
        for (const marker of markers) {
          const at = line.indexOf(marker);
          if (at >= 0) return [JSON.parse(line.slice(at + marker.length)) as ProvisioningLogEntry];
        }
        return [];
      }),
    )
    .filter((entry) => entry.trigger === "account-settings");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeJsonPatch(path: string, patch: Record<string, unknown>) {
  await mkdir(join(APP_DATA_PATHS.storageRoot, "v2"), { recursive: true });
  await writeFile(path, JSON.stringify({ ...(await readJson(path)), ...patch }, null, 2), "utf8");
}

async function readLocalAccountSettings() {
  const settings = await readJson(SETTINGS_FILE);
  return {
    providerFamilyDomain: settings.providerFamilyDomain,
    providerFamilyDomainUpdatedAt: settings.providerFamilyDomainUpdatedAt,
    selection: (settings.providerFamilyConnectionSelections as Record<string, unknown> | undefined)
      ?.bigmodel as { kind?: string } | undefined,
  };
}

async function readRemoteSelectionKind(container: string): Promise<string | undefined> {
  try {
    const settings = JSON.parse(
      await readRemoteContainerFile(container, REMOTE_SETTINGS_FILE),
    ) as Record<string, unknown>;
    const selections = settings.providerFamilyConnectionSelections as
      | Record<string, { kind?: string }>
      | undefined;
    return selections?.bigmodel?.kind;
  } catch {
    return undefined;
  }
}

async function seedSignedInIndividualPlan() {
  const mockBaseUrl = process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL?.trim();
  if (!mockBaseUrl) throw new Error(`${CASE_MARKER}: 缺少账号套餐 mock 地址`);
  // 旧 Electron 仍存活时改设置会被退出阶段的写回覆盖；先退出，再写夹具，再重建应用。
  await quitElectronAppGracefully();
  const scenario = await fetch(`${mockBaseUrl}/__e2e/coding-plan/scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: "both", faultMode: "none", providerResponsive: false }),
  });
  if (!scenario.ok) throw new Error(`${CASE_MARKER}: 切换套餐 mock 场景失败 ${scenario.status}`);
  await writeJsonPatch(APP_DATA_PATHS.credentialsFile, {
    "oauth:active_provider": "bigmodel",
    "oauth:bigmodel:access_token": "e2e-bigmodel-oauth-token",
    "oauth:bigmodel:user_info": JSON.stringify({
      displayName: "BigModel E2E",
      id: "bigmodel-e2e-user",
      username: "bigmodel-e2e-user",
    }),
    zcodejwttoken: "",
  });
  await writeJsonPatch(SETTINGS_FILE, {
    providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
    providerFamilyDomain: "bigmodel",
    providerFamilyDomainMigrated: true,
    lastWorkspaceSession: [
      { kind: "local", workspacePath: DEFAULT_WORKSPACE, workspacePurpose: "project" },
    ],
    lastActiveTabIndex: 0,
  });
  await browser.reloadSession();
  await skipOccupationOnboardingIfPresent();
  await waitForDefaultWorkspaceReady(60_000);
}

async function openComposerProviderList() {
  const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 60_000 });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const provider = $('[data-testid="composer-provider-trigger"]');
  await provider.waitForClickable({ timeout: 60_000 });
  await provider.click();
}

/** 点击供应商行，等到展示切到目标 Provider 且连接 loading 结束；返回点击到完成的耗时。 */
async function switchComposerProvider(providerId: string, label: string): Promise<number> {
  await openComposerProviderList();
  const row = $(
    `[data-composer-provider-list] [data-model-provider-key="registry-provider:${providerId}"]`,
  );
  await row.waitForClickable({
    timeout: 60_000,
    timeoutMsg: `${CASE_MARKER}: 供应商列表没有 ${label}`,
  });
  const startedAt = Date.now();
  await row.click();
  await browser.waitUntil(
    async () => (await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider")) === providerId,
    { timeout: SYNC_TIMEOUT_MS, timeoutMsg: `${CASE_MARKER}: 没有切到 ${label}` },
  );
  await browser.waitUntil(
    async () => !(await $('[data-testid="composer-provider-loading"]').isExisting()),
    { timeout: SYNC_TIMEOUT_MS, timeoutMsg: `${CASE_MARKER}: 切到 ${label} 后 loading 未结束` },
  );
  const durationMs = Date.now() - startedAt;
  expect(await $('[role="alert"]').isExisting()).toBe(false);
  await browser.keys("Escape");
  await browser.keys("Escape");
  return durationMs;
}

/** 从设置页切换 BigModel 连接方式；设置页只写根设置，远端由 account-settings Provisioning 推送。 */
async function selectConnectionModeInSettings(optionKey: string) {
  if (
    !(await $(sel(TID_SETTINGS_PAGE))
      .isDisplayed()
      .catch(() => false))
  ) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
  }
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), { timeout: 30_000 });
  await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, BIGMODEL_ACCOUNT_NAV_KEY), {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 设置页没有 BigModel 供应商`,
  });
  const trigger = $(sel(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER));
  await trigger.waitForClickable({ timeout: 30_000 });
  await trigger.click();
  const option = $(sel(testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, optionKey)));
  await option.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: 没有连接方式 ${optionKey}`,
  });
  await option.click();
}

async function closeSettingsPage() {
  if (
    await $(sel(TID_SETTINGS_PAGE))
      .isDisplayed()
      .catch(() => false)
  ) {
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
    await browser.waitUntil(
      async () =>
        !(await $(sel(TID_SETTINGS_PAGE))
          .isDisplayed()
          .catch(() => false)),
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 设置页没有关闭` },
    );
  }
}

/** 失败排查用：容器内是否能连到账号 mock，以及远端日志中与账号套餐相关的行。不收集凭据和正文。 */
async function collectRemoteDiagnostics(container: string) {
  const mockPort = new URL(process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL ?? "http://127.0.0.1:0").port;
  const run = async (script: string) => {
    try {
      const result = await execInRemoteContainer(container, ["bash", "-c", script]);
      return (result.stdout + result.stderr).slice(-6000);
    } catch (error) {
      return `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  return {
    mockProbe: await run(
      `exec 3<>/dev/tcp/127.0.0.1/${mockPort} && printf 'GET /__e2e/coding-plan/requests HTTP/1.0\\r\\n\\r\\n' >&3 && head -c 300 <&3`,
    ),
    logFiles: await run(
      "find /home/dev/.zcode -maxdepth 5 -type f \\( -name '*.log' -o -name '*.jsonl' \\) | head -40",
    ),
    accountLines: await run(
      "find /home/dev/.zcode -maxdepth 5 -type f \\( -name '*.log' -o -name '*.jsonl' \\) -print0 | xargs -0 grep -h -E 'coding-plan-availability|billing/balance|account-provider|provider-provisioning|entitle' 2>/dev/null | tail -40 | cut -c1-400",
    ),
  };
}

async function waitForAccountSettingsSyncs(count: number, timeoutMsg: string) {
  await browser.waitUntil(async () => (await readAccountSettingsSyncs()).length >= count, {
    timeout: SYNC_TIMEOUT_MS,
    timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}`,
  });
  return await readAccountSettingsSyncs();
}

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
