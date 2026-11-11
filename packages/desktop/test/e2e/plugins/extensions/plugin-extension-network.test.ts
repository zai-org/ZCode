// PLM-EXT-H3：扩展进程的网络跟随设置页（docs/plugins/extension-host.md §12.1、§18.1 H3、§18.4 GitLab 第 2 步）。
// 隔离 HOME：纯 JS fixture 扩展 e2e-ext-network（test/e2e/fixtures/fs/plugins/plugin-extension-network/）经
// plugins.dirs 加载，激活时用全局 fetch 请求 https://gitlab.e2e.example.invalid/api/v4/version。
// 用例起一个 E2E 抓包代理（MITM，自己的 CA，对这个地址回固定响应），在真实设置页填代理、No Proxy 与自定义证书，
// 每改一次经命令中心「重新加载扩展」生效：
//   a 设置页没有代理：沿用 Main 环境里的白名单变量（capture 模式下是 WDIO 的上游抓包代理）；本用例的代理收不到请求。
//   b 只有代理：请求经代理，但代理的证书不受信任，以 TLS 错误失败；代理记录里没有这个请求。
//   c 代理 + 自定义证书：请求成功，拿到固定响应；代理记录里有它。
// 不需要模型。运行时证据：Main 日志（[extension-host] 的 network 行与 fixture 的 E2E_NETWORK_*）、抓包记录、设置文件。
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  readSettings,
  seedSettings,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { createExtensionLog, writePluginDirsConfig } from "#e2e/helpers/extension-host-views";
import {
  DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY,
  startE2ENetworkCaptureProxy,
  type E2ENetworkCaptureArtifact,
  type E2ENetworkCaptureProxy,
} from "#e2e/helpers/network-capture-proxy";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  capturePluginManualReview,
  requirePluginManualReview,
  setPluginPresentation,
} from "#e2e/helpers/plugin-management-lifecycle";

const CASE_ID = "PLM-EXT-H3";
// WDIO 以 packages/desktop 为 cwd；按 cwd 解析，晋级移动 spec 后路径不变。
const FIXTURE_ROOT = resolve(
  process.cwd(),
  "test/e2e/fixtures/fs/plugins/plugin-extension-network",
);
const PLUGIN = "e2e-ext-network";
const PLUGIN_ID = `${PLUGIN}@inline`;
const TARGET_HOST = "gitlab.e2e.example.invalid";
const TARGET_PATH = "/api/v4/version";
const MOCK_BODY = JSON.stringify({ version: "E2E_GITLAB_VERSION" });
// 与其他抓包用例相同的直连名单：本机与 E2E 依赖的站点不经代理。
const NO_PROXY = DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY;
/** 设置页输入框的占位文字里稳定的一段（中英文相同）。 */
const PROXY_PLACEHOLDER = "127.0.0.1:7890";
const CA_PLACEHOLDER = "root-ca.pem";
const NO_PROXY_PLACEHOLDER = "*.corp.com";

const evidence: Record<string, unknown> = {};
const log = createExtensionLog();
let proxy: E2ENetworkCaptureProxy | null = null;

async function seedFixture(): Promise<void> {
  const target = join(getE2EAppDataPaths().homeDir, "fixtures", "extension-network");
  await mkdir(target, { recursive: true });
  await cp(join(FIXTURE_ROOT, PLUGIN), join(target, PLUGIN), { recursive: true, force: true });
  await writePluginDirsConfig([join(target, PLUGIN)], [PLUGIN_ID]);
}

async function openGeneralSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "the settings button should be visible",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), {
    timeout: 15000,
    timeoutMsg: "settings should expose the general section",
  });
}

async function closeSettings(): Promise<void> {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "the settings back button should be visible",
  });
}

/** 设置页网络卡片的一行：按占位文字找输入框，填值，再点同一行的「保存」（输入后才可用）。 */
async function saveNetworkSetting(placeholder: string, value: string): Promise<void> {
  const typed = await browser.execute(
    (hint, next) => {
      const input = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
        (element) => (element.placeholder ?? "").includes(hint),
      );
      if (!input) return false;
      input.scrollIntoView({ block: "center" });
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, next);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: next }));
      return true;
    },
    placeholder,
    value,
  );
  if (!typed) throw new Error(`the settings page should show the input "${placeholder}"`);
  await browser.waitUntil(
    async () =>
      browser.execute((hint) => {
        const input = Array.from(document.querySelectorAll<HTMLInputElement>("input")).find(
          (element) => (element.placeholder ?? "").includes(hint),
        );
        const button = input?.closest(".border-t")?.querySelector<HTMLButtonElement>("button");
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }, placeholder),
    { timeout: 10000, timeoutMsg: `the save button for "${placeholder}" should be enabled` },
  );
}

async function runReloadFromCommandCenter(): Promise<void> {
  await $('[data-testid="sidebar-search-open"]').click();
  const input = $('[role="dialog"] [cmdk-input]');
  await input.waitForDisplayed({ timeout: 10000 });
  await input.setValue(">重新加载扩展");
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const item = Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"] [cmdk-item]'),
        ).find((element) => /重新加载扩展|Reload extensions/.test(element.textContent ?? ""));
        if (!item) return false;
        item.click();
        return true;
      }),
    { timeout: 10000, timeoutMsg: "command center should list 重新加载扩展" },
  );
}

async function waitForLogAfter(
  from: number,
  predicate: (line: string) => boolean,
  message: string,
  timeout = 60000,
): Promise<string> {
  let found = "";
  await browser.waitUntil(
    async () => {
      found = (await log.lines()).slice(from).find(predicate) ?? "";
      return Boolean(found);
    },
    { timeout, interval: 500, timeoutMsg: message },
  );
  return found;
}

/** 抓包代理记录里请求了目标地址的条目。 */
async function targetRecords(): Promise<E2ENetworkCaptureArtifact["records"]> {
  if (!proxy) return [];
  const artifact = JSON.parse(
    await readFile(proxy.artifactPath, "utf8").catch(() => '{"records":[]}'),
  ) as E2ENetworkCaptureArtifact;
  return artifact.records.filter(
    (record) => record.host === TARGET_HOST && record.path === TARGET_PATH,
  );
}

/** 等扩展进程的一个新代际报出网络来源与 fetch 结果。 */
async function waitForGeneration(from: number, label: string) {
  const network = await waitForLogAfter(
    from,
    (line) =>
      line.includes("[extension-host]") && / network proxy=\w+ noProxy=\w+ ca=\w+/.test(line),
    `${label}: the supervisor should log the network sources`,
  );
  const env = await waitForLogAfter(
    from,
    (line) => line.includes("E2E_NETWORK_ENV"),
    `${label}: the extension should log its network environment`,
  );
  const fetched = await waitForLogAfter(
    from,
    (line) => line.includes("E2E_NETWORK_FETCH"),
    `${label}: the extension should finish its fetch`,
  );
  const proxyLog = await waitForLogAfter(
    from,
    (line) => line.includes("environment proxy:"),
    `${label}: the extension host should log the environment proxy`,
  );
  return { network, env, fetched, proxyLog };
}

describe("PLM-EXT-H3 扩展进程的网络跟随设置页", () => {
  after(async () => {
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd(), "plm-ext-h3-evidence.json"),
      JSON.stringify(evidence, null, 2),
    ).catch(() => undefined);
    await proxy?.stop();
    proxy = null;
    await clearAppData();
  });

  it("代理与自定义证书从设置页进入扩展进程，重新加载扩展后生效", async function () {
    this.timeout(600000);
    requirePluginManualReview();
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR ?? process.cwd();
    proxy = await startE2ENetworkCaptureProxy({
      artifactPath: join(artifactDir, "plm-ext-h3-network-capture.json"),
      caDir: join(artifactDir, "plm-ext-h3-ca"),
      responseMocks: [
        {
          host: TARGET_HOST,
          method: "GET",
          path: TARGET_PATH,
          body: MOCK_BODY,
          headers: { "content-type": "application/json" },
        },
      ],
    });
    evidence.proxyUrl = proxy.proxyUrl;
    evidence.caCertPath = proxy.caCertPath;
    await seedFixture();
    // 修复原因（第一次运行的证据：gen=1 就是 proxy=settings ca=settings）：manual-review 默认是 capture 模式，
    // WDIO 在 worker 开始时把自己的上游抓包代理与 CA 写进 setting.json 给 agent 用。本用例从「设置页没有代理」开始，
    // 所以在旧进程退出后、新进程启动前清掉这三项；本用例不发模型请求。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        evidence.harnessNetworkSettings = await readSettings().then((settings) => ({
          httpProxy: Boolean(settings.httpProxy),
          httpProxyNoProxy: Boolean(settings.httpProxyNoProxy),
          httpProxyCaCertPath: Boolean(settings.httpProxyCaCertPath),
        }));
        await seedSettings({
          httpProxy: undefined,
          httpProxyNoProxy: undefined,
          httpProxyCaCertPath: undefined,
        });
        await log.mark();
      },
    });
    await prepareV4ConversationE2E();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });

    // Main 的环境可能已有代理与 CA：capture 模式下 WDIO 把上游抓包代理的变量写进自己的环境，Electron 继承它。
    // 扩展进程的代理、No Proxy 与 CA 只来自设置页（与 CLI 相同，用户决策）：Main 环境里的这些变量一律不传。
    // 这里记下 Main 环境有没有它们，证明 (a) 的直连不是因为环境本来就是空的。
    const envProxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some(
      (key) => process.env[key],
    );
    const envNoProxy = ["NO_PROXY", "no_proxy"].some((key) => process.env[key]);
    const envCa = Boolean(process.env.NODE_EXTRA_CA_CERTS);
    evidence.mainEnvNetwork = { envProxy, envNoProxy, envCa };

    // (a) 设置页没有代理：直连（.invalid 解析不到），扩展进程里没有任何代理与 CA 变量。本用例的代理收不到请求。
    const direct = await waitForGeneration(0, "without a settings proxy");
    evidence.direct = direct;
    expect(direct.network).toContain("network proxy=none noProxy=none ca=none");
    expect(direct.env).not.toMatch(
      /(HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS)=set/,
    );
    expect(direct.proxyLog).toContain("environment proxy: not configured");
    expect(direct.fetched).not.toContain("E2E_GITLAB_VERSION");
    expect(await targetRecords()).toEqual([]);

    // (b) 设置页填代理与 No Proxy，重新加载扩展：请求经本用例的代理，但它的证书不受信任，以 TLS 错误失败。
    await openGeneralSettings();
    await saveNetworkSetting(PROXY_PLACEHOLDER, proxy.proxyUrl);
    await saveNetworkSetting(NO_PROXY_PLACEHOLDER, NO_PROXY);
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return settings.httpProxy === proxy?.proxyUrl && settings.httpProxyNoProxy === NO_PROXY;
      },
      { timeout: 15000, timeoutMsg: "the proxy and No Proxy should be saved in setting.json" },
    );
    await closeSettings();
    const linesBeforeProxy = (await log.lines()).length;
    await runReloadFromCommandCenter();
    const proxied = await waitForGeneration(linesBeforeProxy, "with a proxy and no CA");
    evidence.proxiedWithoutCa = proxied;
    expect(proxied.network).toContain("network proxy=settings noProxy=settings ca=none");
    expect(proxied.env).toContain(
      "HTTPS_PROXY=set https_proxy=set HTTP_PROXY=set http_proxy=set NO_PROXY=set no_proxy=set",
    );
    expect(proxied.proxyLog).toContain("environment proxy: enabled noProxy=set");
    expect(proxied.fetched).toMatch(/E2E_NETWORK_FETCH error code=\S*(CERT|SIGNATURE|SELF_SIGNED)/);
    expect(await targetRecords()).toEqual([]);

    // (c) 再填自定义证书（代理的 CA），重新加载扩展：请求成功，代理记录里有它。
    await openGeneralSettings();
    await saveNetworkSetting(CA_PLACEHOLDER, proxy.caCertPath);
    await browser.waitUntil(
      async () => (await readSettings()).httpProxyCaCertPath === proxy?.caCertPath,
      { timeout: 15000, timeoutMsg: "the custom certificate should be saved in setting.json" },
    );
    await capturePluginManualReview(CASE_ID, "network-settings-zh-CN-zai-light");
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 1400, height: 900 });
    await browser.execute((hint) => {
      Array.from(document.querySelectorAll<HTMLInputElement>("input"))
        .find((element) => (element.placeholder ?? "").includes(hint))
        ?.scrollIntoView({ block: "center" });
    }, CA_PLACEHOLDER);
    await capturePluginManualReview(CASE_ID, "network-settings-en-US-zai-dark");
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    await closeSettings();
    const linesBeforeCa = (await log.lines()).length;
    await runReloadFromCommandCenter();
    const trusted = await waitForGeneration(linesBeforeCa, "with a proxy and the CA");
    evidence.proxiedWithCa = trusted;
    expect(trusted.network).toContain("network proxy=settings noProxy=settings ca=settings");
    expect(trusted.env).toContain("NODE_EXTRA_CA_CERTS=set");
    expect(trusted.fetched).toContain("E2E_NETWORK_FETCH ok status=200");
    expect(trusted.fetched).toContain("E2E_GITLAB_VERSION");
    let records: Awaited<ReturnType<typeof targetRecords>> = [];
    await browser.waitUntil(
      async () => {
        records = await targetRecords();
        return records.some((record) => record.status === "complete");
      },
      { timeout: 15000, timeoutMsg: "the proxy should record the extension's request" },
    );
    evidence.proxyRecords = records.map(({ host, path, method, protocol, status, statusCode }) => ({
      host,
      path,
      method,
      protocol,
      status,
      statusCode,
    }));
    expect(records[0]).toMatchObject({ protocol: "https", method: "GET", statusCode: 200 });

    // 日志不带代理地址与证书路径（代理地址可能带账号密码）。
    const networkLines = (await log.lines()).filter(
      (line) => line.includes(" network proxy=") || line.includes("environment proxy:"),
    );
    evidence.networkLines = networkLines;
    expect(JSON.stringify(networkLines)).not.toContain(proxy.proxyUrl);
    expect(JSON.stringify(networkLines)).not.toContain(proxy.caCertPath);
  });
});
