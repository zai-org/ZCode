import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sourceServerReleaseDescriptorSchema } from "@zcode/shared";
import { clearAppData, seedSettings } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readHostProcesses,
  readSSHRuntimeConfig,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  startRemoteAssetHttpProxy,
  type RemoteAssetHttpProxy,
} from "#e2e/helpers/remote-asset-http-proxy";

const CASE_MARKER = "E2E_SSH_LOCAL_DOWNLOAD_PROXY";
const FAKE_CDN_HOST = "remote-assets.e2e.invalid";
// 从当前 spec 回到 desktop，避免把 mock-cdn 定位到仓库根目录。
const DESKTOP_ROOT = resolve(import.meta.dirname, "../../../../..");
const MOCK_CDN_ROOT = join(DESKTOP_ROOT, "mock-cdn");
const PROXY_NO_PROXY = [
  "localhost",
  "127.0.0.1",
  "::1",
  ".aminer.cn",
  ".bigmodel.cn",
  ".z.ai",
  ".codegeex.cn",
  ".z.ai",
  ".zcode-ai.com",
  "js.stripe.com",
].join(",");

describe(`${CASE_MARKER}: SSH 本地下载遵循应用代理`, () => {
  let proxy: RemoteAssetHttpProxy | null = null;
  const cacheDir = resolveE2ERuntimePath(CASE_MARKER, "cache");
  const artifactDir = resolve(
    process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/local-download-proxy",
  );

  after(async () => {
    try {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        join(artifactDir, "proxy-request-paths.json"),
        JSON.stringify({ proxyRequestPaths: proxy?.requestPaths ?? [] }, null, 2),
      );
      await browser.electron.restoreAllMocks();
      await clearAppData();
    } finally {
      await proxy?.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("SSH-P0-CONN-04 Source Server descriptor/archive 通过显式代理安装", async function () {
    this.timeout(20 * 60_000);
    // Bug 原因：worker 修改 process.env 无法影响 chromedriver 已创建的 Electron；必须在 WDIO 启动前设置。
    expect(process.env.ZCODE_DEV_REMOTE_ASSET_USE_CDN).toBe("1");
    expect(process.env.ZCODE_REMOTE_ASSET_CDN_BASE_URL).toBe(`http://${FAKE_CDN_HOST}`);
    expect(process.env.ZCODE_REMOTE_ASSET_CACHE_DIR).toBe(cacheDir);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];
    const cleanTarget = await runSSHCommand(config, 'test ! -e "$HOME/.zcode/server/current.json"');
    expect(cleanTarget.code).toBe(0);
    const { version } = JSON.parse(
      await readFile(resolve(DESKTOP_ROOT, "../../package.json"), "utf8"),
    ) as { version: string };
    const descriptor = sourceServerReleaseDescriptorSchema.parse(
      JSON.parse(
        await readFile(
          join(MOCK_CDN_ROOT, "releases", version, "source-server-release.json"),
          "utf8",
        ),
      ),
    );
    proxy = await startRemoteAssetHttpProxy({
      expectedHost: FAKE_CDN_HOST,
      mockCdnRoot: MOCK_CDN_ROOT,
    });
    await rm(cacheDir, { recursive: true, force: true });
    await seedSettings({ httpProxy: proxy.proxyUrl, httpProxyNoProxy: PROXY_NO_PROXY });
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    expect(initialHosts).toHaveLength(1);

    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    // 首连成功停在目录页；复用当前选择目录流程，不等待已停用的无项目聊天。
    expect(await waitForSSHDirectoryStep(CASE_MARKER)).toBe("directory");
    await selectSSHRemoteDirectory(workspacePath, CASE_MARKER);
    const tab = await waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: workspacePath });
    expect(tab.remoteSessionId).toBeTruthy();
    expect(tab.secretPersistedInTab).toBe(false);
    const installed = await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"');
    expect(installed.code).toBe(0);
    const current = JSON.parse(installed.stdout) as { archiveSha256: string };
    const archive = descriptor.archives.find((item) => item.sha256 === current.archiveSha256);
    expect(archive).toBeDefined();
    expect(proxy.requestPaths).toContain(`/${version}/source-server-release.json`);
    expect(proxy.requestPaths.some((path) => path.endsWith(`/${archive!.fileName}`))).toBe(true);
    expect(await readHostProcesses()).toEqual(initialHosts);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      join(artifactDir, "installed-release.json"),
      JSON.stringify(
        {
          version,
          archiveSha256: current.archiveSha256,
          workspacePath,
          remoteSessionId: tab.remoteSessionId,
        },
        null,
        2,
      ),
    );
    await browser.saveScreenshot(join(artifactDir, "connected.png"));
  });
});
