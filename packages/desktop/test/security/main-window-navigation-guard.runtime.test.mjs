// 运行时验收：挂载 window.zcode 的窗口顶层导航守卫（ZP-20261105-19 / ZP-20261110-03）。
// 从 desktopWindowChrome.ts 抽取生产中的 guardWindowNavigation 与 isAppOriginMainWindowUrl（不复制判定逻辑），
// 在真实 Electron 中对两个独立窗口分别验证：外部导航被拦截、应用渲染入口内的导航保持可用。
// 本脚本不构造完整的 createBrowserWindow 或更新状态窗口；两者接线由 typecheck、grep 与代码评审确认。
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

async function guardSource() {
  const path = resolve(desktop, "src/main/desktopWindowChrome.ts");
  const source = await readFile(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const names = new Set(["isAppOriginMainWindowUrl", "guardWindowNavigation"]);
  const selected = file.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text),
  );
  assert.equal(selected.length, 2, "生产函数必须仍存在于 desktopWindowChrome.ts");
  const text = selected
    .map((node) => node.getText(file).replace(/^export /, ""))
    .join("\n")
    .replaceAll("import.meta.dirname", "__APP_MAIN_DIR__");
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

function harnessSource({ guard, mainDir, userData }) {
  return `
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:http");
const __APP_MAIN_DIR__ = ${JSON.stringify(mainDir)};
${guard}

const warnings = [];
const logger = { warn: (...args) => warnings.push(args.join(" ")) };
const rendererDir = join(__APP_MAIN_DIR__, "../renderer");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  app.setPath("userData", ${JSON.stringify(userData)});
  let externalHits = 0;
  const server = createServer((_request, response) => {
    externalHits++;
    response.end("<title>external</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const external = "http://127.0.0.1:" + server.address().port + "/";
  const appIndex = pathToFileURL(join(rendererDir, "index.html")).href;
  // 同名前缀的兄弟目录（renderer-evil/）不属于应用入口，用于守住前缀判断带尾部 "/"。
  const siblingUrl = pathToFileURL(join(__APP_MAIN_DIR__, "../renderer-evil/x.html")).href;
  const names = ["main", "update-status"];
  // 两个窗口同时存在后再加载：先销毁一个窗口再创建另一个，第二次 file:// 加载会 ERR_FAILED（与守卫无关）。
  const wins = Object.fromEntries(
    names.map((name) => [
      name,
      new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
      }),
    ]),
  );
  for (const win of Object.values(wins)) guardWindowNavigation(win.webContents, logger);
  for (const win of Object.values(wins)) await win.loadURL(appIndex);
  const result = {};
  for (const name of names) {
    const win = wins[name];
    const loadedUrl = win.webContents.getURL();
    await win.webContents.executeJavaScript('location.href = "second.html"');
    await wait(800);
    const internalUrl = win.webContents.getURL();
    const hitsBefore = externalHits;
    await win.webContents.executeJavaScript("location.href = " + JSON.stringify(external));
    await wait(800);
    const urlAfterExternal = win.webContents.getURL();
    await win.webContents.executeJavaScript("location.href = " + JSON.stringify(siblingUrl));
    await wait(800);
    result[name] = {
      loadedUrl,
      internalUrl,
      urlAfterExternal,
      urlAfterSibling: win.webContents.getURL(),
      externalRequests: externalHits - hitsBefore,
    };
  }
  for (const win of Object.values(wins)) win.destroy();
  result.warnings = warnings;
  server.close();
  console.log("RESULT " + JSON.stringify(result));
  app.exit(0);
}).catch((error) => {
  console.log("ERROR " + (error && error.stack ? error.stack : String(error)));
  app.exit(1);
});
`;
}

test("挂载 window.zcode 的主窗口与更新状态窗口都拦截外部顶层导航，应用入口可用", { timeout: 120000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "zcode-nav-guard-"));
  const appDir = join(base, "app");
  const mainDir = join(appDir, "main");
  const rendererDir = join(appDir, "renderer");
  await mkdir(mainDir, { recursive: true });
  await mkdir(rendererDir, { recursive: true });
  await mkdir(join(appDir, "renderer-evil"), { recursive: true });
  await writeFile(join(rendererDir, "index.html"), "<title>app</title>");
  await writeFile(join(rendererDir, "second.html"), "<title>second</title>");
  await writeFile(join(appDir, "renderer-evil", "x.html"), "<title>sibling</title>");
  const harnessPath = join(mainDir, "harness.cjs");
  await writeFile(
    harnessPath,
    harnessSource({ guard: await guardSource(), mainDir, userData: join(base, "user-data") }),
  );

  const env = { ...process.env };
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  const output = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(electronBinary, [harnessPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", () => {});
    child.on("error", rejectRun);
    child.on("exit", () => resolveRun(stdout));
  });
  const line = output.split("\n").find((entry) => entry.startsWith("RESULT ") || entry.startsWith("ERROR "));
  assert.ok(line?.startsWith("RESULT "), `Electron harness 未返回结果：${output.slice(-800)}`);
  const result = JSON.parse(line.slice("RESULT ".length));

  for (const name of ["main", "update-status"]) {
    const window = result[name];
    assert.ok(window.loadedUrl.endsWith("/renderer/index.html"), `${name} 应用入口未加载`);
    assert.ok(window.internalUrl.endsWith("/renderer/second.html"), `${name} 应用内导航应保持可用`);
    assert.ok(window.urlAfterExternal.endsWith("/renderer/second.html"), `${name} 外部导航不应改变地址`);
    assert.ok(window.urlAfterSibling.endsWith("/renderer/second.html"), `${name} 同名前缀兄弟目录不应放行`);
    assert.equal(window.externalRequests, 0, `${name} 不应向外部地址发出请求`);
  }
  assert.equal(
    result.warnings.filter((message) => message.includes("blocked window top-level navigation")).length,
    4,
    "两个窗口各应记录两次拦截日志（外部地址、兄弟目录）",
  );
});
