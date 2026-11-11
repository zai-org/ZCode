import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { build } from "esbuild";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { _electron } from "playwright-core";

const desktop = resolve(import.meta.dirname, "../../../../../..");
const root = resolve(desktop, "../..");
const require = createRequire(import.meta.url);

// 编译并运行生产窗口函数，不复制关闭策略；替换完整应用启动，避免连接用户账号或实际安装器。
async function windowSource() {
  const path = resolve(desktop, "src/main/index.ts");
  const source = await readFile(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const names = new Set([
    "getApplicationWindowsExcludingCuaIndicator",
    "getMainApplicationWindows",
    "isUpdateStatusWindowCloseLocked",
    "syncUpdateStatusWindowClosePolicy",
    "syncUpdateStatusWindowChrome",
    "resolveUpdateStatusWindowHeight",
    "shouldUseUpdateStatusWindowContentSize",
    "syncUpdateStatusWindowLayout",
    "openUpdateStatusWindow",
  ]);
  const selected = file.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text),
  );
  assert(selected.some((node) => node.name?.text === "openUpdateStatusWindow"));
  const constants = file.statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          (declaration.name.text.startsWith("UPDATE_STATUS_WINDOW_") ||
            declaration.name.text === "closingUpdateStatusWindows"),
      ),
  );
  const quit = file.statements.filter(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      statement.expression.expression.getText(file) === "app.on" &&
      statement.expression.arguments[0]?.getText(file) === '"before-quit"',
  );
  assert.equal(quit.length, 1);
  return [...constants, ...selected, ...quit].map((node) => node.getText(file)).join("\n");
}

async function runtime() {
  app.setPath("userData", FIXTURE_DIR + "/user-data");
  Object.defineProperty(app, "isPackaged", { value: true });
  autoUpdater.checkForUpdates = async () => null;
  let installCalls = 0;
  autoUpdater.quitAndInstall = () => {
    installCalls++;
  };
  const bytes = Buffer.alloc(256 * 1024, 37);
  const downloads = [];
  let starts = 0;
  let activeToken;
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "Content-Length": bytes.length });
    downloads.push({ response, sent: 0 });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const digest = createHash("sha512").update(bytes).digest("base64");
  autoUpdater.downloadUpdate = async (token) => {
    activeToken = token;
    starts++;
    const path = FIXTURE_DIR + "/download-" + starts + ".zip";
    await autoUpdater.httpExecutor.download(
      new URL("http://127.0.0.1:" + server.address().port + "/file"),
      path,
      {
        cancellationToken: token,
        sha512: digest,
      },
    );
    autoUpdater.emit("update-downloaded", { version: offeredVersion });
    return [path];
  };
  await app.whenReady();
  await initAutoUpdater({
    settingService: {
      get: async () => ({ autoDownloadAndInstallUpdates: false, receivePreviewUpdates: false }),
      update: async () => {},
    },
  });
  ipcMain.handle("zcode:open-update-status-window", () => openUpdateStatusWindow());
  let holdNextSnapshot = false;
  let releaseSnapshot;
  ipcMain.handle("zcode:get-update-state", () => {
    const state = getAutoUpdaterState();
    if (!holdNextSnapshot) return state;
    holdNextSnapshot = false;
    return new Promise((resolve) => {
      releaseSnapshot = () => {
        releaseSnapshot = undefined;
        resolve(state);
      };
    });
  });
  ipcMain.handle("zcode:get-auto-update-preferences", () => ({
    autoDownloadAndInstallUpdates: false,
  }));
  ipcMain.handle("zcode:get-desktop-session-activity", () => ({ runningAgentSessionCount: 0 }));
  const main = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await loadWindow(main, "index", {});
  globalThis.control = {
    holdSnapshot() {
      holdNextSnapshot = true;
    },
    snapshotHeld() {
      return Boolean(releaseSnapshot);
    },
    releaseSnapshot() {
      releaseSnapshot?.();
    },
    offer(version) {
      offeredVersion = version;
      autoUpdater.emit("update-available", { version });
    },
    snapshot() {
      return {
        state: getAutoUpdaterState(),
        starts,
        installCalls,
        tokenCancelled: activeToken?.cancelled ?? false,
        snapshotHeld: Boolean(releaseSnapshot),
        listenerCount,
        windowId: updateStatusWindow?.id ?? null,
        downloads: downloads.length,
        mainId: main.id,
        windowCount: BrowserWindow.getAllWindows().length,
      };
    },
    async bytes() {
      try {
        return (await stat(FIXTURE_DIR + "/download-" + starts + ".zip")).size;
      } catch {
        return 0;
      }
    },
    advance(count) {
      const download = downloads.at(-1);
      download.response.write(bytes.subarray(download.sent, count));
      download.sent = count;
    },
    progress(count) {
      autoUpdater.emit("download-progress", {
        bytesPerSecond: 0,
        percent: (count / bytes.length) * 100,
        transferred: count,
        total: bytes.length,
      });
    },
    finish() {
      const d = downloads.at(-1);
      d.response.end(bytes.subarray(d.sent));
    },
    fail() {
      downloads.at(-1).response.destroy();
    },
    open() {
      openUpdateStatusWindow();
    },
    close() {
      if (updateStatusWindow && !updateStatusWindow.isDestroyed()) updateStatusWindow.close();
    },
    closeAndReopen() {
      if (updateStatusWindow && !updateStatusWindow.isDestroyed()) updateStatusWindow.close();
      openUpdateStatusWindow();
      return {
        mainId: main.id,
        id: updateStatusWindow?.id,
        parentId: updateStatusWindow?.getParentWindow()?.id,
      };
    },
    holdLoad() {
      deferLoadResult = true;
    },
    loadHeld() {
      return Boolean(rejectLoadResult);
    },
    rejectLoad() {
      rejectLoadResult?.(new Error("late load aborted after close"));
      rejectLoadResult = undefined;
    },
    setView(nextLocale, nextTheme) {
      currentApplicationLocale = nextLocale;
      theme = nextTheme;
    },
    quit() {
      app.quit();
    },
  };
  const result = () => ({
    starts,
    installCalls,
    preparationCalls,
    windowCount: BrowserWindow.getAllWindows().length,
  });
  globalThis.finalEvidence = result;
}

test("普通更新窗口关闭、后台下载、快照恢复和退出", { timeout: 240_000 }, async () => {
  await mkdir(resolve(desktop, ".e2e-artifacts"), { recursive: true });
  const artifacts = await mkdtemp(resolve(desktop, ".e2e-artifacts/update-background-"));
  const entry = resolve(artifacts, "main.cjs");
  const preload = resolve(artifacts, "preload.cjs");
  const logs = [];
  let app;
  let vite;
  try {
    await writeFile(
      preload,
      [
        'const {contextBridge,ipcRenderer}=require("electron");',
        "const on=(channel,fn)=>{const handler=(_event,value)=>fn(value);ipcRenderer.on(channel,handler);return()=>ipcRenderer.removeListener(channel,handler)};",
        'contextBridge.exposeInMainWorld("updateFixture",{',
        'getUpdateState:()=>ipcRenderer.invoke("zcode:get-update-state"),',
        'onUpdateStateChanged:fn=>on("zcode:update-state-changed",fn),',
        'onUpdateReady:fn=>on("zcode:update-ready",fn),',
        'onApplicationLocaleChanged:fn=>on("zcode:application-locale-changed",fn),',
        'getAutoUpdatePreferences:()=>ipcRenderer.invoke("zcode:get-auto-update-preferences"),',
        'getDesktopSessionActivity:()=>ipcRenderer.invoke("zcode:get-desktop-session-activity"),',
        'downloadUpdate:()=>ipcRenderer.invoke("zcode:download-update"),',
        'cancelUpdateDownload:()=>ipcRenderer.invoke("zcode:cancel-update-download"),',
        'quitAndInstallUpdate:()=>ipcRenderer.invoke("zcode:quit-and-install-update"),',
        'openUpdateStatusWindow:()=>ipcRenderer.invoke("zcode:open-update-status-window"),',
        "openExternal:()=>{},",
        "});",
      ].join("\n"),
    );
    await writeFile(
      resolve(artifacts, "index.html"),
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>',
    );
    await writeFile(
      resolve(artifacts, "entry.tsx"),
      [
        'import React,{useEffect,useState} from "react";import {createRoot} from "react-dom/client";',
        'import {UpdateStatusButton} from "@/UpdateStatusButton";import {TooltipProvider} from "@/components/ui/tooltip";',
        'import {UpdateStatusWindowRoot} from "@/UpdateStatusWindowRoot";',
        'import {ZCodeIntlProvider} from "@/i18n/IntlProvider";import "@/styles.css";',
        'const params=new URLSearchParams(location.search);const locale=params.get("locale")||"zh-CN";',
        'document.documentElement.classList.add("theme-"+(params.get("theme")||"zai-light"));',
        'document.body.style.background="var(--color-background)";const platform=window.updateFixture;',
        'function Main(){const[state,setState]=useState(null);useEffect(()=>{platform.getUpdateState().then(setState);return platform.onUpdateStateChanged(setState)},[]);return <ZCodeIntlProvider initialLocale={locale}><TooltipProvider><main style={{padding:32}}><UpdateStatusButton platform={platform} updateState={state} version={null}/><button id="workspace">Workspace</button></main></TooltipProvider></ZCodeIntlProvider>}',
        'createRoot(document.getElementById("root")!).render(params.get("windowKind")==="update-status"?<UpdateStatusWindowRoot platform={platform} initialLocale={locale} onRequestClose={()=>window.close()}/>:<Main/>);',
      ].join("\n"),
    );
    vite = await createServer({
      configFile: false,
      root: artifacts,
      plugins: [react(), tailwind()],
      resolve: { alias: { "@": resolve(root, "packages/ui/src") } },
      server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
      optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime"] },
      logLevel: "error",
    });
    await vite.listen();
    const source = [
      'import {app,BrowserWindow,ipcMain} from "electron";',
      'import {createServer as createHttpServer} from "node:http";',
      'import {createHash} from "node:crypto";',
      'import {stat,writeFile} from "node:fs/promises";',
      'import {autoUpdater} from "electron-updater";',
      'import {initAutoUpdater,getAutoUpdaterState,onAutoUpdaterStateChanged as subscribeState,syncAutoUpdaterStateToWindow,syncReadyUpdateToWindow,syncPostUpdateReleaseNotesToWindow} from "./src/main/autoUpdater.ts";',
      "const logger={info:console.log,warn:console.warn,error:console.error};",
      "let listenerCount=0;function onAutoUpdaterStateChanged(fn){listenerCount++;const dispose=subscribeState(fn);return()=>{listenerCount--;dispose()}}",
      "let updateStatusWindow=null;const forceQuitRef={current:false};const explicitQuitRef={current:false};",
      'const windowsCuaOperationIndicator={ownsWindow:()=>false};const iconPath=undefined;const deviceMid="update-fixture";',
      'const preloadPath=PRELOAD_PATH;let currentApplicationLocale="zh-CN";let theme="zai-light";let offeredVersion="99.0.1";',
      "const localMediaPreviewPathRegistry={clear(){}};let hasPreparedAppQuit=false;let preparationCalls=0;",
      "function shouldConfirmAppQuit(){return false}function confirmAppQuit(){return true}",
      'async function prepareAppQuit(){preparationCalls++;hasPreparedAppQuit=true;forceQuitRef.current=true;await writeFile(FIXTURE_DIR+"/quit.json",JSON.stringify(globalThis.finalEvidence?.()??{}));}',
      "function exitPreparedApp(){app.exit(0)}",
      "let deferLoadResult=false;let rejectLoadResult;",
      'function loadWindow(win,_page,bootstrap){const url=new URL(RENDERER_URL);url.searchParams.set("fixtureWindowId",String(win.id));url.searchParams.set("locale",currentApplicationLocale);url.searchParams.set("theme",theme);if(bootstrap?.windowKind)url.searchParams.set("windowKind",bootstrap.windowKind);const loaded=win.loadURL(url.toString());if(!deferLoadResult)return loaded;deferLoadResult=false;return loaded.then(()=>new Promise((_resolve,reject)=>{rejectLoadResult=reject}));}',
      await windowSource(),
      "(" + runtime.toString() + ")().catch(error=>{console.error(error);app.exit(1)})",
    ].join("\n");
    await build({
      stdin: { contents: source, resolveDir: desktop, loader: "ts" },
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron", "electron-updater", "semver"],
      define: {
        FIXTURE_DIR: JSON.stringify(artifacts),
        PRELOAD_PATH: JSON.stringify(preload),
        RENDERER_URL: JSON.stringify(vite.resolvedUrls.local[0]),
      },
      alias: { "@zcode/shared": resolve(root, "packages/shared/src/index.ts") },
      plugins: [
        {
          name: "isolated-logger",
          setup(api) {
            api.onResolve({ filter: /^\.\/logger\.js$/ }, (args) =>
              args.importer.endsWith("/main/autoUpdater.ts")
                ? { path: "logger", namespace: "fixture" }
                : undefined,
            );
            api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents:
                "export const logger={info:console.log,warn:console.warn,error:console.error}",
            }));
          },
        },
      ],
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: require("electron"),
      args: [entry],
      env,
      timeout: 20_000,
    });
    for (const stream of [app.process().stdout, app.process().stderr])
      stream?.on("data", (chunk) => logs.push(chunk.toString()));
    const page = await app.firstWindow();
    const invoke = (method, argument) =>
      app.evaluate((_electron, { method, argument }) => globalThis.control[method](argument), {
        method,
        argument,
      });
    const snapshot = () => invoke("snapshot");
    const until = async (predicate, message) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail(message);
    };
    const updatePage = async () => {
      let found;
      await until(async () => {
        const id = (await snapshot()).windowId;
        found = app.windows().find((candidate) => {
          const url = candidate.url();
          return (
            url.includes("windowKind=update-status") &&
            new URL(url).searchParams.get("fixtureWindowId") === String(id)
          );
        });
        return Boolean(found);
      }, "更新窗口的 renderer 尚未加载");
      return found;
    };
    await page.locator("#workspace").waitFor();
    const results = [];
    // 先覆盖没有旧 ready 包的真实失败分支，再执行四组成功下载。
    await invoke("offer", "99.0.0");
    await until(async () => (await snapshot()).state.kind === "update-available", "失败场景未就绪");
    await invoke("open");
    await (await updatePage()).getByRole("button", { name: "下载更新", exact: true }).click();
    await until(async () => (await snapshot()).downloads === 1, "失败下载未开始");
    await invoke("advance", 65536);
    await until(async () => (await invoke("bytes")) >= 65536, "失败场景首段未收到");
    await invoke("progress", 65536);
    await invoke("close");
    await until(async () => (await snapshot()).windowCount === 1, "失败场景窗口未关闭");
    await invoke("fail");
    await until(
      async () => (await snapshot()).state.kind === "update-available",
      "失败后未恢复可重试状态",
    );
    assert.equal((await snapshot()).windowCount, 1);
    await page.locator("main button").first().click();
    await (await updatePage()).getByRole("button", { name: "下载更新", exact: true }).waitFor();
    await invoke("close");
    await until(async () => (await snapshot()).windowCount === 1, "重试窗口未关闭");
    let version = 1;
    for (const locale of ["zh-CN", "en-US"])
      for (const theme of ["zai-light", "zai-dark"]) {
        const offered = "99.0." + version++;
        await app.evaluate(
          (_electron, { locale, theme }) => globalThis.control.setView(locale, theme),
          { locale, theme },
        );
        await invoke("offer", offered);
        await until(
          async () => (await snapshot()).state.kind === "update-available",
          "未出现可下载状态",
        );
        await page.locator("main button").first().click();
        await until(async () => (await snapshot()).windowId !== null, "更新窗口未打开");
        let id = (await snapshot()).windowId;
        let win = await updatePage();
        const starts = (await snapshot()).starts + 1;
        await win
          .getByRole("button", {
            name: locale === "zh-CN" ? "下载更新" : "Download update",
            exact: true,
          })
          .click();
        await until(async () => (await snapshot()).downloads === starts, "下载连接未到达");
        await invoke("advance", 65536);
        await until(async () => (await invoke("bytes")) >= 65536, "首段未写入");
        await invoke("progress", 65536);
        await until(
          async () => (await snapshot()).state.kind === "download-progress",
          "未进入下载状态",
        );
        await invoke("close");
        await until(async () => (await snapshot()).windowId === null, "下载中原生关闭被拦截");
        assert.equal((await snapshot()).listenerCount, 0);
        assert.equal((await snapshot()).tokenCancelled, false);
        await invoke("advance", 131072);
        await until(async () => (await invoke("bytes")) >= 131072, "窗口关闭后下载停止");
        await invoke("progress", 131072);
        assert.equal((await snapshot()).windowCount, 1);
        await invoke("holdSnapshot");
        await page.locator("main button").first().click();
        await until(async () => (await snapshot()).windowId !== null, "下载中入口无法重开");
        const reopened = await snapshot();
        assert.notEqual(reopened.windowId, id);
        assert.equal(reopened.starts, starts);
        assert.equal(reopened.state.transferredBytes, 131072);
        assert.equal(reopened.listenerCount, 1);
        win = await updatePage();
        await until(async () => await invoke("snapshotHeld"), "重开快照未进入受控等待");
        await invoke("advance", 196608);
        await until(async () => (await invoke("bytes")) >= 196608, "重开后字节未继续写入");
        await invoke("progress", 196608);
        await win.getByText("0.2MB / 0.3MB", { exact: true }).waitFor();
        await invoke("releaseSnapshot");
        await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        assert.equal(await win.getByText("0.2MB / 0.3MB", { exact: true }).count(), 1);
        await win
          .getByRole("button", {
            name: locale === "zh-CN" ? "后台下载" : "Download in background",
            exact: true,
          })
          .waitFor();
        await win.screenshot({ path: resolve(artifacts, locale + "-" + theme + ".png") });
        await win
          .getByRole("button", {
            name: locale === "zh-CN" ? "后台下载" : "Download in background",
            exact: true,
          })
          .click();
        await until(async () => (await snapshot()).windowId === null, "后台下载未关窗");
        for (let n = 0; n < 3; n++) {
          await invoke("open");
          await (await updatePage()).getByRole("dialog").waitFor();
          const closingId = (await snapshot()).windowId;
          const race = await invoke("closeAndReopen");
          assert.notEqual(race.id, closingId, JSON.stringify({ closingId, ...race }));
          assert.equal(race.parentId, race.mainId);
          await (await updatePage()).getByRole("dialog").waitFor();
          assert.equal((await snapshot()).listenerCount, 1, JSON.stringify(race));
          await invoke("close");
          await until(async () => (await snapshot()).listenerCount === 0, "关窗后监听未释放");
        }
        await invoke("finish");
        await until(
          async () => (await snapshot()).state.kind === "update-downloaded",
          "关闭后下载完成未发布",
        );
        assert.equal((await snapshot()).windowCount, 1);
        await page.locator("main button").first().click();
        await until(async () => (await snapshot()).windowId !== null, "完成后无法重开");
        await invoke("close");
        assert.equal((await snapshot()).installCalls, 0);
        results.push({
          locale,
          theme,
          starts,
          transferredWhileClosed: 131072,
          listenersAfterClose: 0,
        });
      }
    // 窗口已显示后关闭，再交付迟到的加载拒绝；不得复活窗口或影响 ready 状态。
    await invoke("holdLoad");
    await invoke("open");
    await (await updatePage()).getByRole("dialog").waitFor();
    await until(async () => await invoke("loadHeld"), "加载结果未进入受控等待");
    await invoke("close");
    await invoke("rejectLoad");
    await until(async () => (await snapshot()).windowCount === 1, "迟到加载结果重建了窗口");
    assert.equal((await snapshot()).state.kind, "update-downloaded");
    await invoke("open");
    await (
      await updatePage()
    )
      .getByRole("button", { name: "Restart to update", exact: true })
      .waitFor();
    assert.equal((await snapshot()).installCalls, 0);
    const exited = new Promise((resolve) => app.process().once("exit", (code) => resolve(code)));
    await invoke("quit").catch(() => {});
    assert.equal(await exited, 0);
    const quit = JSON.parse(await readFile(resolve(artifacts, "quit.json"), "utf8"));
    assert.equal(quit.installCalls, 0);
    assert.equal(quit.preparationCalls, 1);
    await writeFile(
      resolve(artifacts, "result.json"),
      JSON.stringify(
        { cases: results, failureRecovery: true, lateLoadIgnored: true, quit },
        null,
        2,
      ),
    );
    console.log("update background E2E: PASS " + artifacts);
  } finally {
    await writeFile(resolve(artifacts, "electron.log"), logs.join(""));
    await app?.close().catch(() => {});
    await vite?.close();
    console.log("update background artifacts: " + artifacts);
  }
});
