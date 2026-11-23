import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  clickTestIdByDom,
  getE2EAppDataPaths,
  quitElectronAppGracefully,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { execInRemoteContainer, readRemoteContainerFile } from "#e2e/helpers/remote-docker-target";
import { sel } from "#e2e/helpers/selectors";

/**
 * 远端 Composer 套餐连接用例（RPR-01 / RPR-02）共用的步骤。
 * 本机与远端共用同一个账号套餐 mock；远端断言读容器内 setting.json，
 * 同步次数读本机 Main 日志中 trigger=account-settings 的 Provisioning 结果。
 */
const APP_DATA_PATHS = getE2EAppDataPaths();
const SETTINGS_FILE = join(APP_DATA_PATHS.appDataDir, "setting.json");
export const REMOTE_DATA_DIR = "/home/dev/.zcode/v2";
const REMOTE_SETTINGS_FILE = `${REMOTE_DATA_DIR}/setting.json`;
export const INDIVIDUAL_PROVIDER_ID = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
const BIGMODEL_ACCOUNT_NAV_KEY = `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`;
export const TEAM_PLAN_KEY = "team:bigmodel:product-team-a:org-team-a:proj-team-a";
export const PERSONAL_PLAN_CONNECTION_KEY = `coding-plan:${INDIVIDUAL_PROVIDER_ID}`;
export const SYNC_TIMEOUT_MS = 120_000;
const COMPOSER_PROVIDER_LOADING = '[data-testid="composer-provider-loading"]';

export interface ProvisioningLogEntry {
  environmentKey: string;
  trigger: string;
  status: string;
  durationMs?: number;
  errorCode?: string;
}

/** 读取本次 Main 日志里的 Provisioning 结果；只统计 account-settings 触发的轮次。 */
export async function readAccountSettingsSyncs(
  caseMarker: string,
): Promise<ProvisioningLogEntry[]> {
  const directory = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
  if (!directory) throw new Error(`${caseMarker}: 缺少本次 Main 日志目录`);
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

export async function waitForAccountSettingsSyncs(
  caseMarker: string,
  count: number,
  timeoutMsg: string,
) {
  await browser.waitUntil(
    async () => (await readAccountSettingsSyncs(caseMarker)).length >= count,
    { timeout: SYNC_TIMEOUT_MS, timeoutMsg: `${caseMarker}: ${timeoutMsg}` },
  );
  return await readAccountSettingsSyncs(caseMarker);
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

export async function readLocalAccountSettings() {
  const settings = await readJson(SETTINGS_FILE);
  return {
    providerFamilyDomain: settings.providerFamilyDomain,
    providerFamilyDomainUpdatedAt: settings.providerFamilyDomainUpdatedAt,
    selection: (settings.providerFamilyConnectionSelections as Record<string, unknown> | undefined)
      ?.bigmodel as { kind?: string } | undefined,
  };
}

export async function readRemoteSelectionKind(container: string): Promise<string | undefined> {
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

export async function seedSignedInIndividualPlan(caseMarker: string) {
  const mockBaseUrl = process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL?.trim();
  if (!mockBaseUrl) throw new Error(`${caseMarker}: 缺少账号套餐 mock 地址`);
  // 旧 Electron 仍存活时改设置会被退出阶段的写回覆盖；先退出，再写夹具，再重建应用。
  await quitElectronAppGracefully();
  const scenario = await fetch(`${mockBaseUrl}/__e2e/coding-plan/scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: "both", faultMode: "none", providerResponsive: false }),
  });
  if (!scenario.ok) throw new Error(`${caseMarker}: 切换套餐 mock 场景失败 ${scenario.status}`);
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

/** 打开供应商列表并点击目标行；返回点击时刻。 */
export async function clickComposerProviderRow(
  caseMarker: string,
  providerId: string,
  label: string,
): Promise<number> {
  await openComposerProviderList();
  const row = $(
    `[data-composer-provider-list] [data-model-provider-key="registry-provider:${providerId}"]`,
  );
  await row.waitForClickable({
    timeout: 60_000,
    timeoutMsg: `${caseMarker}: 供应商列表没有 ${label}`,
  });
  const startedAt = Date.now();
  await row.click();
  return startedAt;
}

export async function isComposerProviderLoading(): Promise<boolean> {
  return await $(COMPOSER_PROVIDER_LOADING).isExisting();
}

export async function readComposerProviderId(): Promise<string | null> {
  return await $(sel(TID_V4_MODEL_CONFIG)).getAttribute("data-provider");
}

/** 点击供应商行，等到展示切到目标 Provider 且连接 loading 结束；返回点击到完成的耗时。 */
export async function switchComposerProvider(
  caseMarker: string,
  providerId: string,
  label: string,
): Promise<number> {
  const startedAt = await clickComposerProviderRow(caseMarker, providerId, label);
  await browser.waitUntil(async () => (await readComposerProviderId()) === providerId, {
    timeout: SYNC_TIMEOUT_MS,
    timeoutMsg: `${caseMarker}: 没有切到 ${label}`,
  });
  await browser.waitUntil(async () => !(await isComposerProviderLoading()), {
    timeout: SYNC_TIMEOUT_MS,
    timeoutMsg: `${caseMarker}: 切到 ${label} 后 loading 未结束`,
  });
  const durationMs = Date.now() - startedAt;
  expect(await $('[role="alert"]').isExisting()).toBe(false);
  await closeComposerMenus();
  return durationMs;
}

/**
 * 关闭 Composer 模型菜单。原因：选模后菜单按设计保持打开，固定按两次 Escape 偶尔只关掉子菜单，
 * 残留的浮层会盖住随后打开的设置页控件。以触发器的 aria-expanded 为准逐次关闭。
 */
export async function closeComposerMenus() {
  const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await browser.waitUntil(
    async () => {
      if ((await trigger.getAttribute("aria-expanded")) !== "true") return true;
      await browser.keys("Escape");
      return false;
    },
    { timeout: 15_000, interval: 300, timeoutMsg: "Composer 模型菜单没有关闭" },
  );
}

/** 从设置页切换 BigModel 连接方式；设置页只写根设置，远端由 account-settings Provisioning 推送。 */
export async function selectConnectionModeInSettings(caseMarker: string, optionKey: string) {
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
    timeoutMsg: `${caseMarker}: 设置页没有 BigModel 供应商`,
  });
  const trigger = $(sel(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER));
  await trigger.waitForClickable({ timeout: 30_000 });
  await trigger.click();
  const option = $(sel(testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, optionKey)));
  await option.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: 没有连接方式 ${optionKey}`,
  });
  await option.click();
}

export async function closeSettingsPage(caseMarker: string) {
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
      { timeout: 15_000, timeoutMsg: `${caseMarker}: 设置页没有关闭` },
    );
  }
}

/** 失败排查用：容器内是否能连到账号 mock，以及远端日志中与账号套餐相关的行。不收集凭据和正文。 */
export async function collectRemoteDiagnostics(container: string) {
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

export interface DelayedHttpProxy {
  readonly baseURL: string;
  /** 之后到达的每个请求先等待 delayMs 再转发；0 表示直通。 */
  setDelay(delayMs: number): void;
  /** 已转发的请求数（含直通），用于确认远端请求确实经过代理。 */
  readonly forwardedCount: () => number;
  close(): Promise<void>;
}

/**
 * 宿主侧 HTTP 延迟代理：只放在远端的反向隧道后面，用来只拖慢远端发往账号 mock 的请求，
 * 本机根 Host 仍直连 mock。按请求延迟（不是按 TCP 连接），keep-alive 复用的连接也会被延迟。
 */
export async function startDelayedHttpProxy(targetBaseURL: string): Promise<DelayedHttpProxy> {
  const target = new URL(targetBaseURL);
  let delayMs = 0;
  let forwarded = 0;
  const server: Server = createServer((incoming, outgoing) => {
    const wait = delayMs;
    const forward = () => {
      forwarded += 1;
      const upstream = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          method: incoming.method,
          path: incoming.url,
          headers: { ...incoming.headers, host: target.host },
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
    };
    if (wait > 0) setTimeout(forward, wait);
    else forward();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("延迟代理没有监听端口");
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    setDelay: (value) => {
      delayMs = value;
    },
    forwardedCount: () => forwarded,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
