import { preinstalledFixtureRecordPath } from "#e2e/helpers/preinstalled-tools-fixture";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { chromium, type Browser as PreviewBrowser } from "playwright-core";
import type { PreinstalledToolsState } from "@zcode/shared/preinstalled-tools";
import { resolveE2EHomeDir, resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const exec = promisify(execFile);
const fixtureUrl = () => process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL!;

describe("预装工具发布身份隔离（待审核，仅 macOS）", () => {
  (process.platform === "darwin" ? it : it.skip)(
    "LOP-27: development 与 packaged preview 同时准备到不同根",
    async function () {
      this.timeout(180000);
      await prepareV4ConversationE2E();
      const primary = await browser.electron.execute((electron) => ({
        executable: process.execPath,
        packaged: electron.app.isPackaged,
        pid: process.pid,
        electronVersion: process.versions.electron!,
      }));
      expect(primary.packaged).toBe(false);
      const artifact = join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "lop27-preview");
      const productName = "ZCode LOP27 Preview";
      const previewApp = join(artifact, "packaged", "mac-arm64", `${productName}.app`);
      const userData = join(artifact, "user-data");
      const infoPath = join(artifact, "startup.json");
      const desktop = resolve(import.meta.dirname, "../../../../..");
      await mkdir(userData, { recursive: true });
      const appRoot = join(artifact, "source");
      await mkdir(appRoot, { recursive: true });
      await writeFile(
        join(appRoot, "package.json"),
        JSON.stringify({
          name: "zcode-preinstall-preview-fixture",
          version: "3.16.3",
          type: "module",
          main: "entry.mjs",
        }),
      );
      const rendererUrl = new URL(await browser.getUrl());
      expect(rendererUrl.protocol).toBe("file:");
      const mainEntry = pathToFileURL(
        join(dirname(dirname(fileURLToPath(rendererUrl))), "main/index.js"),
      ).href;
      // 使用 electron-builder 的真实目录包；不覆盖 isPackaged 或发布身份解析。
      // 仅抑制宿主 URL scheme 注册，退出控制调用真实 app.quit，不修改预装状态。
      await writeFile(
        join(appRoot, "entry.mjs"),
        `import { app } from 'electron';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
app.setPath('home', ${JSON.stringify(resolveE2EHomeDir())});
app.setPath('userData', ${JSON.stringify(userData)});
app.setAsDefaultProtocolClient = () => false;
const control = createServer((req,res) => { if(req.url === '/quit'){res.end('quitting');app.quit();}else res.writeHead(404).end(); });
control.listen(0,'127.0.0.1',async () => { const port=control.address().port; await writeFile(${JSON.stringify(infoPath)},JSON.stringify({pid:process.pid,packaged:app.isPackaged,controlPort:port})); });
app.on('will-quit',()=>control.close());
await import(${JSON.stringify(mainEntry)});
`,
      );
      const configPath = join(artifact, "builder.json");
      await writeFile(
        configPath,
        JSON.stringify({
          appId: "com.example.zcode.lop27.preview",
          productName,
          electronVersion: primary.electronVersion,
          // 夹具只检查中英文双发布身份；全量语言包曾触发数百次无关资源签名。
          electronLanguages: ["en-US", "zh-CN"],
          electronDist: dirname(dirname(dirname(dirname(primary.executable)))),
          directories: { output: join(artifact, "packaged") },
          asar: false,
          npmRebuild: false,
          files: ["entry.mjs", "package.json"],
          // builder 会把显式 "-" 当成证书名片段，误选带连字符的本机证书。
          // 禁用发现且不指定名称，让 arm64 走既有 ad-hoc 分支。
          mac: { hardenedRuntime: false, notarize: false, timestamp: "none" },
        }),
      );
      const build = await exec(
        process.execPath,
        [
          createRequire(import.meta.url).resolve("electron-builder/cli.js"),
          "--projectDir",
          appRoot,
          "--config",
          configPath,
          "--mac",
          "--arm64",
          "--dir",
          "--publish",
          "never",
        ],
        {
          cwd: appRoot,
          env: {
            ...process.env,
            CSC_IDENTITY_AUTO_DISCOVERY: "false",
            CSC_NAME: undefined,
            CSC_LINK: undefined,
            CSC_KEY_PASSWORD: undefined,
            APPLE_ID: undefined,
            APPLE_APP_SPECIFIC_PASSWORD: undefined,
          },
          timeout: 90000,
          maxBuffer: 8 * 1024 * 1024,
        },
      ).catch(async (error) => {
        await writeFile(
          join(artifact, "builder.log"),
          String(error) + "\n" + (error.stdout ?? "") + (error.stderr ?? ""),
        );
        throw error;
      });
      await writeFile(join(artifact, "builder.log"), build.stdout + build.stderr);
      const executableName = (
        await exec("/usr/libexec/PlistBuddy", [
          "-c",
          "Print :CFBundleExecutable",
          join(previewApp, "Contents/Info.plist"),
        ])
      ).stdout.trim();
      let child: ChildProcess | undefined;
      let preview: PreviewBrowser | undefined;
      let startup: { pid: number; packaged: boolean; controlPort: number } | undefined;
      let exited: Promise<unknown> | undefined;
      try {
        child = spawn(
          join(previewApp, "Contents/MacOS", executableName),
          ["--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${userData}`],
          {
            cwd: desktop,
            env: {
              ...process.env,
              NODE_OPTIONS: undefined,
              HOME: resolveE2EHomeDir(),
              USERPROFILE: resolveE2EHomeDir(),
              ZCODE_DESKTOP_HOME_DIR: resolveE2EHomeDir(),
              ZCODE_DATA_BASE_DIR: resolveE2EHomeDir(),
              ZCODE_DESKTOP_APPLICATION_NAME: productName,
              ZCODE_DESKTOP_USER_DATA_DIR: userData,
              ZCODE_DESKTOP_SESSION_DATA_DIR: join(userData, "session"),
              ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA: "0",
              ZCODE_E2E_RUNTIME_LOG_DIR: join(artifact, "runtime-logs"),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        exited = once(child, "exit");
        child.stdout!.pipe(createWriteStream(join(artifact, "stdout.log")));
        child.stderr!.pipe(createWriteStream(join(artifact, "stderr.log")));
        await browser.waitUntil(
          async () => {
            try {
              startup = JSON.parse(await readFile(infoPath, "utf8"));
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 20000, timeoutMsg: "Preview 真实打包入口未启动" },
        );
        expect(startup!.packaged).toBe(true);
        expect(startup!.pid).not.toBe(primary.pid);
        let port = 0;
        await browser.waitUntil(
          async () => {
            try {
              port = Number(
                (await readFile(join(userData, "session", "DevToolsActivePort"), "utf8")).split(
                  "\n",
                )[0],
              );
              return port > 0;
            } catch {
              return false;
            }
          },
          { timeout: 20000 },
        );
        preview = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        await browser.waitUntil(
          async () =>
            preview!
              .contexts()[0]
              ?.pages()
              .some((page) => page.url().includes("renderer/index.html")) ?? false,
          { timeout: 30000 },
        );
        const page = preview
          .contexts()[0]!
          .pages()
          .find((item) => item.url().includes("renderer/index.html"))!;
        await page.waitForFunction(() =>
          Boolean(
            (window as typeof window & { zcode?: { getPreinstalledToolsState?: unknown } }).zcode
              ?.getPreinstalledToolsState,
          ),
        );
        await browser.waitUntil(
          async () =>
            ((await (await fetch(`${fixtureUrl()}/status`)).json()) as { requests: number })
              .requests === 2,
          { timeout: 30000 },
        );
        const before = await page.evaluate(async () =>
          (
            window as typeof window & {
              zcode: { getPreinstalledToolsState(): Promise<PreinstalledToolsState> };
            }
          ).zcode.getPreinstalledToolsState(),
        );
        expect(before.tools.find((tool) => tool.toolId === "libreoffice")?.status).toBe(
          "preparing",
        );
        const own = await browser.execute(async () =>
          (
            window as typeof window & {
              zcode: { getPreinstalledToolsState(): Promise<PreinstalledToolsState> };
            }
          ).zcode.getPreinstalledToolsState(),
        );
        expect(own.tools.find((tool) => tool.toolId === "libreoffice")?.status).toBe("preparing");
        await fetch(`${fixtureUrl()}/release`);
        await fetch(`${fixtureUrl()}/finish-check`);
        await page.waitForFunction(
          async () =>
            (
              await (
                window as typeof window & {
                  zcode: { getPreinstalledToolsState(): Promise<PreinstalledToolsState> };
                }
              ).zcode.getPreinstalledToolsState()
            ).tools.find((tool) => tool.toolId === "libreoffice")?.status === "ready",
        );
        await browser.waitUntil(
          async () =>
            (
              await browser.execute(async () =>
                (
                  window as typeof window & {
                    zcode: { getPreinstalledToolsState(): Promise<PreinstalledToolsState> };
                  }
                ).zcode.getPreinstalledToolsState(),
              )
            ).tools.find((tool) => tool.toolId === "libreoffice")?.status === "ready",
          { timeout: 30000 },
        );
        const roots = join(resolveE2EStorageRoot(), "preinstalled-tools");
        const development = JSON.parse(
          await readFile(await preinstalledFixtureRecordPath(join(roots, "development")), "utf8"),
        );
        const packaged = JSON.parse(
          await readFile(await preinstalledFixtureRecordPath(join(roots, "preview")), "utf8"),
        );
        expect(development.installationDir).not.toBe(packaged.installationDir);
        // 发布身份按独立目录隔离；并行发布的时间戳不承担安装身份。
        expect(development.resourceId).toBe(packaged.resourceId);
        const previewReady = await page.evaluate(async () =>
          (
            window as typeof window & {
              zcode: { getPreinstalledToolsState(): Promise<PreinstalledToolsState> };
            }
          ).zcode.getPreinstalledToolsState(),
        );
        expect(
          previewReady.tools.find((tool) => tool.toolId === "libreoffice")?.installed,
        ).toMatchObject({
          resourceId: packaged.resourceId,
          version: packaged.version,
          installedSizeBytes: packaged.installedSizeBytes,
        });
        await page.getByTestId("workspace-help-menu-trigger").click({ timeout: 30000 });
        await page.getByTestId("workspace-help-menu-preinstalled-tools").click();
        // 进程已就绪不等于弹窗首次快照已返回；等待可见状态，不能把 loading 当作最终结果。
        await page.waitForFunction(
          () =>
            document
              .querySelector(
                '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]',
              )
              ?.getAttribute("data-status") === "ready",
        );
        expect(
          await page
            .locator('[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]')
            .getAttribute("data-status"),
        ).toBe("ready");
        await page.screenshot({ path: join(artifact, "preview-ready.png") });
        await browser.electron.execute((electron) =>
          electron.BrowserWindow.getAllWindows()[0]?.focus(),
        );
        await $('[data-testid="workspace-help-menu-trigger"]').click();
        await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
        await browser.waitUntil(
          async () =>
            (await $(
              '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]',
            ).getAttribute("data-status")) === "ready",
          { timeout: 30000 },
        );
        await browser.saveScreenshot(join(artifact, "development-ready.png"));
        await writeFile(
          join(artifact, "facts.json"),
          JSON.stringify(
            {
              primary,
              preview: startup,
              development,
              packaged,
              http: await (await fetch(`${fixtureUrl()}/status`)).json(),
            },
            null,
            2,
          ),
        );
      } finally {
        if (startup && child?.exitCode === null && child.signalCode === null) {
          await fetch(`http://127.0.0.1:${startup.controlPort}/quit`).catch(() => {});
          await Promise.race([exited, new Promise<void>((accept) => setTimeout(accept, 12000))]);
        }
        if (child?.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
        await preview?.close().catch(() => {});
        await rm(previewApp, { recursive: true, force: true });
      }
    },
  );
});
