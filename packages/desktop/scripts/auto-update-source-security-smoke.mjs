import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { _electron } from "playwright-core";

const desktopDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopDir, "../..");
const require = createRequire(resolve(desktopDir, "package.json"));
const useAppImageUpdater = process.argv.includes("--appimage");
const useNsisUpdater = process.argv.includes("--nsis");
await mkdir(resolve(desktopDir, ".e2e-artifacts"), { recursive: true });
const artifactDir = await mkdtemp(resolve(desktopDir, ".e2e-artifacts/update-source-security-"));
const entryPath = resolve(artifactDir, "main.cjs");
const cases = [
  { name: "packaged-argv", packaged: true, input: "argv", expected: "trusted" },
  { name: "packaged-env", packaged: true, input: "env", expected: "trusted" },
  { name: "packaged-direct", packaged: true, input: "direct", expected: "trusted" },
  { name: "packaged-backend-override", packaged: true, input: "backend", expected: "trusted" },
  { name: "packaged-deep-link", packaged: true, input: "deep-link", expected: "trusted" },
  { name: "dev-argv", packaged: false, input: "argv", expected: "override" },
  { name: "dev-env", packaged: false, input: "env", expected: "override" },
  { name: "dev-delimiter", packaged: false, input: "deep-link", expected: "trusted" },
];

await build({
  stdin: {
    resolveDir: desktopDir,
    sourcefile: "update-source-security-fixture.mjs",
    contents: `
import { app, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import pkg from 'electron-updater';
import { initAutoUpdater, resolveUpdateFeedSourceFromStartupConfig } from './src/main/autoUpdater.ts';
import { setSecuritySmokeOrigin } from 'security-smoke-origin';
import { extractDeepLinkUrlFromArgs } from './src/main/desktopDeepLinkUrl.ts';
const scenario = JSON.parse(process.env.ZCODE_SECURITY_SCENARIO);
const root = process.env.ZCODE_SECURITY_ROOT;
app.setPath('userData', root);
Object.defineProperty(app, 'isPackaged', { value: scenario.packaged });
process.env.ZCODE_AUTO_UPDATE_DEV = '1';
process.env.ZCODE_AUTO_UPDATE_DEV_VERSION = '3.17.0';
const { autoUpdater } = pkg;
// 普通 Linux Electron 没有 APPIMAGE，打包态模拟不会经过产品的开发态激活逻辑。
// 只激活隔离夹具的更新器，保留 scenario.packaged 作为更新源安全边界的被测输入。
autoUpdater.forceDevUpdateConfig = true;
const requests = [];
async function listen(label) {
  const server = createServer((req, res) => {
    requests.push({ label, url: req.url, headers: req.headers });
    if (req.url === '/package.bin') {
      res.end('update-auth-download-fixture');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/yaml' });
    res.end('version: 0.0.1\\nfiles: []\\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: 'http://127.0.0.1:' + server.address().port + '/manifest' };
}
(async () => {
  await app.whenReady();
  const trusted = await listen('trusted');
  const override = await listen('override');
  setSecuritySmokeOrigin(trusted.url);
  const argv = ['app'];
  const env = {};
  if (scenario.input === 'argv') argv.push('--zcode-update-feed-url=' + override.url);
  if (scenario.input === 'env') env.ZCODE_UPDATE_FEED_URL = override.url;
  if (scenario.input === 'deep-link') argv.push('--', 'zcode://x', '--zcode-update-feed-url=' + override.url);
  const updateFeedSource = scenario.input === 'direct' ? { url: override.url } : resolveUpdateFeedSourceFromStartupConfig({ argv, env });
  const configPath = resolve(root, 'app-update.yml');
  await writeFile(configPath, 'provider: generic\\nurl: ' + trusted.url + '\\nupdaterCacheDirName: security-smoke\\n');
  autoUpdater.updateConfigPath = configPath;
  const completed = new Promise((done, fail) => {
    autoUpdater.once('update-not-available', done);
    autoUpdater.once('error', fail);
  });
  const handlers = new Map();
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); originalHandle(channel, handler); };
  const installOrder = [];
  let loginToken = null;
  let failCredentialRead = false;
  await initAutoUpdater({ onBeforeQuitAndInstall: async () => { installOrder.push('prepare'); }, updateFeedSource, deviceMid: '00000000-0000-4000-8000-000000000000', resolveZcodeJwtToken: async () => {
    if (failCredentialRead) throw new Error('sensitive-fixture-credential-error');
    return loginToken;
  }, resolveEndpointOrigin: () => scenario.input === "backend" ? override.url : trusted.url });
  await completed;
  // 等待启动检查的 Promise 收口，再在同一更新器上验证登录、换账号和退出。
  await autoUpdater.checkForUpdates();
  for (const token of [' fixture-account-a ', 'fixture-account-b', '   ', 'bad' + String.fromCharCode(10) + 'token', '非ascii', null, 'fixture-recovered']) {
    loginToken = token;
    failCredentialRead = token === null;
    await autoUpdater.checkForUpdates();
    if (token?.trim() === 'fixture-account-a') {
      const provider = await autoUpdater.clientPromise;
      await autoUpdater.httpExecutor.download(new URL('/package.bin', trusted.url), resolve(root, 'package.bin'), {
        cancellationToken: new pkg.CancellationToken(),
        headers: autoUpdater.computeRequestHeaders(provider),
        sha512: createHash('sha512').update('update-auth-download-fixture').digest('base64'),
      });
    }
  }
  const signatureChecks = [];
  const cachedInstallChecks = [];
  if (autoUpdater instanceof pkg.NsisUpdater) {
    const childProcess = require('node:child_process');
    const original = childProcess.execFile;
    let signature = {status: 0, subject: 'CN=New Publisher, O=New Company, C=GB'};
    childProcess.execFile = (...args) => {
      installOrder.push('verify');
      args.at(-1)(null, JSON.stringify(signature), '');
      return {};
    };
    try {
      // 包内仅有旧 DN，仍必须调用真实装配的自定义校验，不能因缺配置而免检。
      await writeFile(configPath, 'publisherName: ["CN=Old Publisher, O=Old Company, C=US"]\\n');
      signatureChecks.push(await autoUpdater.verifySignature('C:\\\\update.exe') === null);
      signature = {status: 2, subject: null};
      signatureChecks.push(await autoUpdater.verifySignature('C:\\\\update.exe') !== null);
      if (scenario.packaged) {
        // 已缓存包不会重走 NSIS 下载 hook，直接从真实 IPC 安装入口验证。
        const platform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', {value: 'win32'});
        Object.defineProperty(autoUpdater, 'installerPath', {get: () => 'C:/cached/update.exe'});
        autoUpdater.checkForUpdates = async () => null;
        autoUpdater.quitAndInstall = () => installOrder.push('install');
        const install = handlers.get('zcode:quit-and-install-update');
        try {
          installOrder.length = 0;
          autoUpdater.emit('update-downloaded', {version: '99.0.0'});
          await install().then(() => cachedInstallChecks.push(false), () => cachedInstallChecks.push(true));
          cachedInstallChecks.push(installOrder.join(',') === 'verify');
          signature = {status: 0, subject: 'CN=Renewed Publisher'};
          installOrder.length = 0;
          autoUpdater.emit('update-downloaded', {version: '99.0.0'});
          await Promise.all([install(), install()]);
          cachedInstallChecks.push(installOrder.join(',') === 'verify,prepare,install');
        } finally {Object.defineProperty(process, 'platform', platform);}
      }
    } finally { childProcess.execFile = original; }
  }
  const callbacks = ['zcode://oauth/callback?state=example&code=test', 'zcode://payment/callback?provider=example&channel=web&status=success', 'zcode://workspace/open?path=%2Ftmp%2Fexample', 'zcode://share/import?code=example'];
  const result = { cachedInstallChecks, signatureChecks, scenario: scenario.name, updaterType: autoUpdater.constructor.name, requests, autoDownload: autoUpdater.autoDownload, autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit, callbacks: callbacks.map(url => extractDeepLinkUrlFromArgs(['app', '--', url]) === url) };
  await writeFile(resolve(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log('UPDATE_SECURITY_RESULT=' + JSON.stringify(result));
  trusted.server.close(); override.server.close(); app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
`,
  },
  outfile: entryPath,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "electron-updater", "semver"],
  alias: { "@zcode/shared": resolve(repoRoot, "packages/shared/src/index.ts") },
  plugins: [
    {
      name: "security-smoke-official-origin",
      setup(api) {
        api.onResolve({ filter: /^security-smoke-origin$/ }, () => ({
          path: "origin",
          namespace: "security-origin",
        }));
        api.onLoad({ filter: /.*/, namespace: "security-origin" }, () => ({
          contents:
            "export let origin; export function setSecuritySmokeOrigin(value) { origin = value; }",
        }));
        api.onResolve({ filter: /^@zcode\/shared$/ }, () => ({
          path: "shared",
          namespace: "security-shared",
        }));
        api.onLoad({ filter: /.*/, namespace: "security-shared" }, () => ({
          contents:
            "export * from " +
            JSON.stringify(resolve(repoRoot, "packages/shared/src/index.ts")) +
            '; export { origin as DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "security-smoke-origin";',
          resolveDir: desktopDir,
        }));
      },
    },
    ...(useAppImageUpdater || useNsisUpdater
      ? [
          {
            name: "isolated-platform-updater",
            setup(api) {
              api.onResolve({ filter: /^electron-updater$/ }, (args) =>
                args.namespace === "appimage"
                  ? { path: args.path, external: true }
                  : { path: args.path, namespace: "appimage" },
              );
              api.onLoad({ filter: /.*/, namespace: "appimage" }, () => ({
                contents:
                  'const upstream = require("electron-updater"); module.exports = { ...upstream, autoUpdater: new upstream.' +
                  (useNsisUpdater ? "NsisUpdater" : "AppImageUpdater") +
                  "() };",
              }));
            },
          },
        ]
      : []),
    {
      name: "isolated-logger",
      setup(api) {
        api.onResolve({ filter: /^\.\/logger\.js$/ }, (args) =>
          args.importer.endsWith("/autoUpdater.ts")
            ? { path: "logger", namespace: "smoke" }
            : undefined,
        );
        api.onLoad({ filter: /.*/, namespace: "smoke" }, () => ({
          contents:
            "export const logger = { info: console.log, warn: console.warn, error: console.error };",
        }));
      },
    },
  ],
});

const results = [];
for (const scenario of cases) {
  const root = resolve(artifactDir, scenario.name);
  await mkdir(root);
  const env = {
    ...process.env,
    ZCODE_SECURITY_SCENARIO: JSON.stringify(scenario),
    ZCODE_SECURITY_ROOT: root,
    NODE_PATH: resolve(repoRoot, "node_modules"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (useAppImageUpdater) delete env.APPIMAGE;
  const electronApp = await _electron.launch({
    executablePath: require("electron"),
    args: [entryPath],
    env,
  });
  let output = "";
  const child = electronApp.process();
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  try {
    // app.exit 关闭调试连接；进程退出是这里的完成信号，不靠固定延时判断网络结果。
    if (child.exitCode === null) await onceExit(child);
    const { readFile } = await import("node:fs/promises");
    const result = JSON.parse(await readFile(resolve(root, "result.json"), "utf8"));
    results.push(result);
    await writeFile(resolve(artifactDir, "results.json"), JSON.stringify(results, null, 2));
    assert.deepEqual(
      result.requests.filter((item) => item.url !== "/package.bin").map((item) => item.label),
      Array(8).fill(scenario.expected),
      scenario.name,
    );
    assert.deepEqual(
      result.requests
        .filter((item) => item.url !== "/package.bin")
        .map((item) => item.headers.authorization ?? null),
      [
        null,
        "Bearer fixture-account-a",
        "Bearer fixture-account-b",
        null,
        null,
        null,
        null,
        "Bearer fixture-recovered",
      ],
      `${scenario.name}: current login token must be read for each manifest request`,
    );
    assert.match(output, /credential read failed; checking manifest without authorization/);
    assert.ok(
      !output.includes("sensitive-fixture-credential-error"),
      "credential errors must not leak into logs",
    );
    const downloadRequests = result.requests.filter((item) => item.url === "/package.bin");
    assert.equal(downloadRequests.length, 1);
    assert.equal(
      downloadRequests[0].headers.authorization,
      undefined,
      "download must not receive login token",
    );
    if (useAppImageUpdater) assert.equal(result.updaterType, "AppImageUpdater");
    if (useNsisUpdater) {
      assert.equal(result.updaterType, "NsisUpdater");
      assert.deepEqual(result.signatureChecks, [true, true]);
      if (scenario.packaged) assert.deepEqual(result.cachedInstallChecks, [true, true, true]);
    }
    assert.equal(result.autoDownload, false);
    assert.equal(result.autoInstallOnAppQuit, false);
    assert.ok(result.callbacks.every(Boolean));
    console.log(`PASS ${scenario.name}`);
  } finally {
    await writeFile(resolve(root, "runtime.log"), output);
    await electronApp.close().catch(() => {});
  }
}
console.log(`Evidence: ${artifactDir}`);

function onceExit(child) {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Electron security scenario timed out"));
    }, 30_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveExit();
      else reject(new Error(`Electron exited ${code}`));
    });
  });
}
