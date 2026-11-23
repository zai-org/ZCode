import { preinstalledFixtureRecordPath } from "#e2e/helpers/preinstalled-tools-fixture";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { readSettings } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

interface FixtureStatus {
  requests: Array<{ id: number; resource: string; mode: string; range: string | null }>;
  proxyUrl: string;
  caCertPath: string;
}
const fixtureUrl = () => process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL!;
const status = async () => (await (await fetch(`${fixtureUrl()}/status`)).json()) as FixtureStatus;
const statusSelector = '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]';
async function openDialog() {
  await $('[data-testid="workspace-help-menu-trigger"]').click();
  await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
  await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed();
}
async function terminalStatus() {
  await browser.waitUntil(
    async () =>
      ["ready", "failed"].includes((await $(statusSelector).getAttribute("data-status")) ?? ""),
    { timeout: 30000 },
  );
  return $(statusSelector).getAttribute("data-status");
}
async function screenshot(name: string) {
  await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-proxy-${name}.png`);
}
async function preinstallPid() {
  return browser.electron.execute(
    (electron) =>
      electron.app.getAppMetrics().find((metric) => metric.name === "zcode-preinstalled-tools")
        ?.pid ?? null,
  );
}
async function saveNetworkSettings(values: { proxy?: string; noProxy?: string; ca?: string }) {
  await browser.keys("Escape");
  await $('[data-testid="task-settings-button"]').click();
  await $('[data-testid="settings-page"]').waitForDisplayed();
  await $('[data-testid="settings-section-nav-general"]').click();
  for (const [key, value, selector] of [
    ["httpProxy", values.proxy, 'input[placeholder*="7890"]'],
    ["httpProxyNoProxy", values.noProxy, 'input[placeholder*="localhost,127"]'],
    ["httpProxyCaCertPath", values.ca, 'input[placeholder*="root-ca.pem"]'],
  ] as const) {
    if (value === undefined) continue;
    const input = $(selector);
    await input.scrollIntoView();
    await input.setValue(value);
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await readSettings())[key] === value, { timeout: 10000 });
  }
  await $('[data-testid="settings-back-button"]').click();
  await openDialog();
}

// 两个下载基址都在只能经代理访问的域名下；与 faults 分开启动，因为基址在 App 启动时固定。
describe("预装工具代理与私有 CA（待审核）", () => {
  it("LOP-13: 下载读取当前代理设置，私有 CA 配置前失败、配置后同一进程重试成功", async function () {
    this.timeout(300000);
    await prepareV4ConversationE2E();
    await openDialog();
    // 未配置代理时域名不可达，自动准备失败，且没有请求绕过代理到达本地服务。
    expect(await terminalStatus()).toBe("failed");
    expect(await $('[data-testid="preinstalled-tools-dialog"]').getText()).toContain(
      "无法连接下载服务器",
    );
    expect((await status()).requests).toEqual([]);
    await screenshot("without-proxy");
    const proxy = await status();
    const pid = await preinstallPid();
    expect(pid).not.toBeNull();
    await saveNetworkSettings({ proxy: proxy.proxyUrl, noProxy: "localhost,127.0.0.1,::1" });
    await $('[data-testid="preinstalled-tools-retry"]').click();
    expect(await terminalStatus()).toBe("failed");
    expect(await $('[data-testid="preinstalled-tools-dialog"]').getText()).toContain(
      "无法连接下载服务器",
    );
    expect((await status()).requests).toEqual([]);
    await screenshot("without-ca");
    await saveNetworkSettings({ ca: proxy.caCertPath });
    await $('[data-testid="preinstalled-tools-retry"]').click();
    expect(await terminalStatus()).toBe("ready");
    expect(await preinstallPid()).toBe(pid);
    expect((await status()).requests.map((item) => item.mode)).toEqual(["http-error", "complete"]);
    const roots = join(resolveE2EStorageRoot(), "preinstalled-tools");
    const root = join(roots, (await readdir(roots))[0]!);
    expect((await stat(await preinstalledFixtureRecordPath(root))).isFile()).toBe(true);
    await screenshot("with-ca-ready");
  });
});
