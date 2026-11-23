// 运行时回归：导航守卫拦截外部顶层导航后，App 控制导航的 renderer 登记仍然有效。
// Electron 44 对被 will-navigate 拦截的主框架导航仍先发出 did-start-navigation；登记若按导航开始失效，
// 拦截之后 OpenSession 等请求会一直返回 renderer-unavailable。登记应只在导航真正提交（reload 等）时失效。
// 从源码抽取生产中的 guardWindowNavigation / isAppOriginMainWindowUrl、windowSurface 与
// createAppControlNavigationWindow（不复制逻辑），在真实 Electron 窗口中组合验证。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const desktop = resolve(import.meta.dirname, "../..");
const require = createRequire(join(desktop, "package.json"));
const electronBinary = require("electron");

async function extractFunctions(relativePath, names) {
  const path = resolve(desktop, relativePath);
  const source = await readFile(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const selected = file.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text),
  );
  assert.equal(selected.length, names.length, `生产函数必须仍存在于 ${relativePath}`);
  const text = selected.map((node) => node.getText(file).replace(/^export /, "")).join("\n");
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

async function productionSource() {
  const guard = await extractFunctions("src/main/desktopWindowChrome.ts", [
    "isAppOriginMainWindowUrl",
    "guardWindowNavigation",
  ]);
  const windowBridge = await extractFunctions("src/app-control-navigation/windowBridge.ts", [
    "createAppControlNavigationWindow",
  ]);
  const electronBridge = await extractFunctions("src/app-control-navigation/electronBridge.ts", [
    "windowSurface",
  ]);
  return [
    guard.replaceAll("import.meta.dirname", "__APP_MAIN_DIR__"),
    windowBridge,
    electronBridge,
  ].join("\n");
}

function harnessSource({ production, mainDir, userData }) {
  return `
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const __APP_MAIN_DIR__ = ${JSON.stringify(mainDir)};
const APP_NAVIGATION_IPC = "zcode:app-control-navigation";
const surfaces = new WeakMap();
${production}

const logger = { warn: () => {} };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const target = { workspacePath: "/workspace", taskId: "task" };

app.whenReady().then(async () => {
  app.setPath("userData", ${JSON.stringify(userData)});
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  guardWindowNavigation(win.webContents, logger);
  const surface = windowSurface(win);
  await win.loadURL(pathToFileURL(join(__APP_MAIN_DIR__, "../renderer/index.html")).href);
  surface.register("generation-1");

  const replies = [];
  const source = { reply: (message) => replies.push(message) };
  const repliesFor = (requestId) => replies.filter((message) => message.requestId === requestId);

  await win.webContents.executeJavaScript('location.href = "https://example.com/zp-nav"');
  await wait(800);
  surface.open(source, { type: "app-navigation-open", requestId: "after-blocked", target });
  await wait(200);
  const afterBlocked = { url: win.webContents.getURL(), replies: repliesFor("after-blocked") };

  win.webContents.reload();
  await wait(1500);
  surface.open(source, { type: "app-navigation-open", requestId: "after-reload", target });
  await wait(200);
  const afterReload = { replies: repliesFor("after-reload") };

  win.destroy();
  console.log("RESULT " + JSON.stringify({ afterBlocked, afterReload }));
  app.exit(0);
}).catch((error) => {
  console.log("ERROR " + (error && error.stack ? error.stack : String(error)));
  app.exit(1);
});
`;
}

test(
  "导航守卫拦截外部导航后 App 控制导航登记仍有效，reload 后失效",
  { timeout: 120000 },
  async () => {
    const base = await mkdtemp(join(tmpdir(), "zcode-app-nav-blocked-"));
    const mainDir = join(base, "app", "main");
    const rendererDir = join(base, "app", "renderer");
    await mkdir(mainDir, { recursive: true });
    await mkdir(rendererDir, { recursive: true });
    await writeFile(join(rendererDir, "index.html"), "<title>app</title>");
    const harnessPath = join(mainDir, "harness.cjs");
    await writeFile(
      harnessPath,
      harnessSource({
        production: await productionSource(),
        mainDir,
        userData: join(base, "user-data"),
      }),
    );

    const env = { ...process.env };
    delete env.ELECTRON_RENDERER_URL;
    delete env.ELECTRON_RUN_AS_NODE;
    const output = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(electronBinary, [harnessPath], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", () => {});
      child.on("error", rejectRun);
      child.on("exit", () => resolveRun(stdout));
    });
    const line = output
      .split("\n")
      .find((entry) => entry.startsWith("RESULT ") || entry.startsWith("ERROR "));
    assert.ok(line?.startsWith("RESULT "), `Electron harness 未返回结果：${output.slice(-800)}`);
    const { afterBlocked, afterReload } = JSON.parse(line.slice("RESULT ".length));

    assert.match(afterBlocked.url, /^file:/, "外部导航应被守卫拦截");
    assert.deepEqual(afterBlocked.replies, [], "被拦截的导航不应使 renderer 登记失效");
    assert.equal(afterReload.replies.length, 1, "reload 后请求应立即返回");
    assert.deepEqual(afterReload.replies[0].result, {
      status: "unavailable",
      reason: "renderer-unavailable",
    });
  },
);
