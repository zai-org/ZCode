import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { _electron } from "playwright-core";

// 真实 Electron 退出时序回归：替换安装器 IO，不接触用户应用、更新缓存或 ShipIt。
if (process.platform !== "darwin") {
  console.log("auto-update install reentry smoke: macOS only (skipped)");
  process.exit(0);
}

const desktopDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopDir, "../..");
const require = createRequire(resolve(desktopDir, "package.json"));
const preparingDownloadFailure = process.argv.includes("--preparing-download-failure");
const pendingCheck = process.argv.includes("--pending-check");
const nativeInstallError = process.argv.includes("--native-install-error");
const ordinaryQuit = process.argv.includes("--ordinary-quit");
const linuxDeb = process.argv.includes("--linux-deb");
await mkdir(resolve(desktopDir, ".e2e-artifacts"), { recursive: true });
const artifactDir = await mkdtemp(resolve(desktopDir, ".e2e-artifacts/update-install-reentry-"));
await mkdir(resolve(artifactDir, "user-data"));
const entryPath = resolve(artifactDir, "main.cjs");

await build({
  stdin: {
    resolveDir: desktopDir,
    sourcefile: "auto-update-install-reentry-fixture.mjs",
    contents: `
      import { app, BrowserWindow, ipcMain } from "electron";
      import { PlatformChannels } from "@zcode/shared";
      import { initAutoUpdater, downloadAvailableUpdate } from "./src/main/autoUpdater.ts";

      (async () => {
      const autoUpdater = globalThis.__smokeUpdater;
      const nativeUpdater = autoUpdater.nativeUpdater;
      const order = [];
      let installCalls = 0;
      let prepareCalls = 0;
      let nativeInstallCalls = 0;
      let relaunchCalls = 0;
      const preparingDownloadFailure = ${JSON.stringify(preparingDownloadFailure)};
      const pendingCheck = ${JSON.stringify(pendingCheck)};
      const nativeInstallError = ${JSON.stringify(nativeInstallError)};
      const ordinaryQuit = ${JSON.stringify(ordinaryQuit)};
      const linuxDeb = ${JSON.stringify(linuxDeb)};
      let finishPreparation;
      const preparation = new Promise((resolve) => { finishPreparation = resolve; });

      app.setPath("userData", ${JSON.stringify(resolve(artifactDir, "user-data"))});
      Object.defineProperty(app, "isPackaged", { value: true });
      autoUpdater.checkForUpdates = () => pendingCheck ? new Promise(() => {}) : Promise.resolve(null);
      app.relaunch = () => { relaunchCalls++; order.push("relaunch"); };
      const originalExit = app.exit.bind(app);
      app.exit = (code) => {
        if (nativeInstallError) {
          order.push("recovery-exit");
          console.log("UPDATE_INSTALL_RESULT=" + JSON.stringify({ installCalls, prepareCalls, nativeInstallCalls, relaunchCalls, prevented: false, order }));
        }
        originalExit(code);
      };
      autoUpdater.squirrelDownloadedUpdate = false;
      const originalInstall = autoUpdater.quitAndInstall.bind(autoUpdater);
      autoUpdater.quitAndInstall = () => {
        installCalls++;
        order.push("install-entry");
        originalInstall();
      };
      if (linuxDeb) {
        autoUpdater.downloadedUpdateHelper = {
          file: "/tmp/zcode smoke/update.deb", downloadedFileInfo: { isAdminRightsRequired: false },
        };
        autoUpdater.hasCommand = (command) => ["dpkg", "pkexec"].includes(command);
        autoUpdater.spawnSyncLog = (command, args) => {
          order.push("command:" + command);
          if (command !== "pkexec" || args[0] !== "--disable-internal-agent" || !args.join(" ").includes("/bin/bash")) {
            throw new Error("expected Linux privilege escalation");
          }
          if (nativeInstallError) throw new Error("authorization cancelled");
          nativeInstallCalls++;
          return "";
        };
      } else {
        nativeUpdater.checkForUpdates = () => {
          // 根因发生在原生 staging 回调晚于安装入口返回时，不用超时猜测状态。
          setImmediate(() => {
            if (nativeInstallError) {
              order.push("native-error");
              nativeUpdater.emit("error", new Error("native staging failed"));
            } else {
              order.push("native-staged");
              nativeUpdater.emit("update-downloaded");
            }
          });
        };
        nativeUpdater.quitAndInstall = () => {
          if (nativeInstallCalls > 0) return;
          nativeInstallCalls++;
          order.push("native-install");
          setImmediate(() => app.quit());
        };
      }

      await app.whenReady();
      await initAutoUpdater({
        onBeforeQuitAndInstall: async () => {
          prepareCalls++;
          order.push("prepare");
          if (preparingDownloadFailure) await preparation;
        },
      });
      ipcMain.handle("smoke-background-download-failure", () => {
        autoUpdater.downloadUpdate = async () => { throw new Error("background download must not start"); };
        autoUpdater.emit("update-available", { version: "99.0.1" });
        autoUpdater.emit("update-downloaded", { version: "99.0.1" });
        downloadAvailableUpdate("smoke-background");
        order.push("background-target-locked");
      });
      ipcMain.handle("smoke-finish-preparation", () => { finishPreparation(); });
      const win = new BrowserWindow({
        width: 420, height: 200,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      });
      await win.loadURL("data:text/html," + encodeURIComponent(
        '<button id="install">Restart to update</button><script>' +
        'document.getElementById("install").onclick = () => ' +
        'require("electron").ipcRenderer.invoke(' + JSON.stringify(ordinaryQuit ? "smoke-ordinary-quit" : PlatformChannels.QuitAndInstallUpdate) + ');' +
        '</script>'
      ));
      ipcMain.handle("smoke-ordinary-quit", () => { app.quit(); });
      autoUpdater.emit("update-downloaded", { version: "99.0.0" });
      app.on("before-quit", (event) => {
        order.push("before-quit");
        console.log("UPDATE_INSTALL_RESULT=" + JSON.stringify({
          installCalls, prepareCalls, nativeInstallCalls, relaunchCalls,
          prevented: event.defaultPrevented, order,
        }));
        // 旧实现会拦截退出并重入；立即结束隔离夹具，避免无限循环。
        if (event.defaultPrevented) app.exit(2);
      });
      })().catch((error) => { console.error(error); app.exit(1); });
    `,
  },
  outfile: entryPath,
  bundle: true,
  platform: "node",
  format: "cjs",
  // 在 macOS 的真实 Electron 中执行 DebUpdater；只替换平台判断和系统命令边界。
  // 这验证 Linux 安装器调用顺序，不代表 Linux 实机文件替换验收。
  ...(linuxDeb ? { define: { "process.platform": '"linux"' } } : {}),
  banner: {
    js: `globalThis.__smokeUpdater = ${linuxDeb ? 'new (require("electron-updater").DebUpdater)()' : 'require("electron-updater").autoUpdater'};`,
  },
  external: ["electron", "electron-updater", "semver"],
  alias: { "@zcode/shared": resolve(repoRoot, "packages/shared/src/index.ts") },
  plugins: [
    {
      name: "isolated-smoke-updater",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^electron-updater$/ }, (args) => {
          if (args.importer.endsWith("/src/main/autoUpdater.ts")) {
            return { path: "updater", namespace: "smoke-updater" };
          }
        });
        buildApi.onLoad({ filter: /.*/, namespace: "smoke-updater" }, () => ({
          contents:
            'export { CancellationToken } from "electron-updater"; export default { autoUpdater: globalThis.__smokeUpdater };',
          resolveDir: desktopDir,
        }));
      },
    },
    {
      name: "isolated-smoke-logger",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^\.\/logger\.js$/ }, (args) => {
          if (args.importer.endsWith("/src/main/autoUpdater.ts")) {
            return { path: "logger", namespace: "smoke" };
          }
        });
        buildApi.onLoad({ filter: /.*/, namespace: "smoke" }, () => ({
          contents:
            "export const logger = { info: console.log, warn: console.warn, error: console.error };",
        }));
      },
    },
  ],
});

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let electronApp;
let output = "";
try {
  electronApp = await _electron.launch({
    executablePath: require("electron"),
    args: [entryPath],
    env,
  });
  const child = electronApp.process();
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      output += chunk.toString();
    });
  }
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
    child.once("error", rejectExit);
  });
  const page = await electronApp.firstWindow();
  await page.locator("#install").click();
  if (preparingDownloadFailure) {
    await page.evaluate(() =>
      require("electron").ipcRenderer.invoke("smoke-background-download-failure"),
    );
    await page.locator("#install").click();
    await page.evaluate(() => require("electron").ipcRenderer.invoke("smoke-finish-preparation"));
  }
  const timeout = AbortSignal.timeout(15_000);
  const result = await Promise.race([
    exited,
    new Promise((_, reject) =>
      timeout.addEventListener(
        "abort",
        () => reject(new Error("Electron did not exit after install")),
        { once: true },
      ),
    ),
  ]);
  assert.equal(result.code, 0, output);
  const reportLine = output.split("\n").find((line) => line.startsWith("UPDATE_INSTALL_RESULT="));
  assert.ok(reportLine, output);
  const report = JSON.parse(reportLine.slice("UPDATE_INSTALL_RESULT=".length));
  assert.deepEqual(report, {
    installCalls: ordinaryQuit ? 0 : 1,
    prepareCalls: ordinaryQuit ? 0 : 1,
    nativeInstallCalls: ordinaryQuit || nativeInstallError ? 0 : 1,
    relaunchCalls: ordinaryQuit ? 0 : nativeInstallError || linuxDeb ? 1 : 0,
    prevented: false,
    order: ordinaryQuit
      ? ["before-quit"]
      : [
          "prepare",
          ...(preparingDownloadFailure ? ["background-target-locked"] : []),
          "install-entry",
          ...(linuxDeb
            ? nativeInstallError
              ? ["command:pkexec", "command:pkexec", "relaunch", "recovery-exit"]
              : ["command:pkexec", "relaunch", "before-quit"]
            : nativeInstallError
              ? ["native-error", "relaunch", "recovery-exit"]
              : ["native-staged", "native-install", "before-quit"]),
        ],
  });
  await writeFile(
    resolve(artifactDir, "result.json"),
    JSON.stringify({ ...result, ...report }, null, 2),
  );
  console.log("auto-update install reentry smoke: PASS", artifactDir);
} finally {
  await writeFile(resolve(artifactDir, "electron.log"), output);
  await electronApp?.close().catch(() => {});
}
