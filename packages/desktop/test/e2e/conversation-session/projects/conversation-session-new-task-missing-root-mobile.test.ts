import { once } from "node:events";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { selectNativeProjectDirectories } from "#e2e/helpers/project-sidebar";

type TestWindow = Window & {
  __testActions?: { setLocale(locale: "zh-CN" | "en-US"): void; setTheme(theme: string): void };
  __restoreRoot03Clipboard?: () => void;
  __zcodeTabStoreE2E?: { getState(): { activeWorkspacePath: string | null; tabs: unknown[] } };
  __zcodeSessionStoreE2E?: {
    getState(): {
      getWorkspaceState(path: string): {
        activeTaskId: string | null;
        draftProjectId?: string | null;
        draftFocusVersion: number;
      };
    };
  };
};

describe("手机新建任务的目录失效反馈", () => {
  after(async () => clearAppData());

  it("VP-ROOT-03：目录移走后提示原因并保留项目草稿，恢复后可重试", async function () {
    this.timeout(120_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    const cwd = join(process.env.ZCODE_E2E_HOME_DIR!, "E2E_MISSING_ROOT_MOBILE");
    const moved = `${cwd}-moved`;
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR!;
    await mkdir(cwd, { recursive: true });
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').setValue("E2E_MISSING_ROOT_MOBILE");
    await selectNativeProjectDirectories([cwd]);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    const selector = '[data-project-name="E2E_MISSING_ROOT_MOBILE"]';
    await $(selector).waitForDisplayed();
    const projectId = await $(selector).getAttribute("data-project-id");
    const desktopTabs = await browser.execute(
      () => (window as TestWindow).__zcodeTabStoreE2E!.getState().tabs.length,
    );

    // 配对材料只经内存与 loopback 传递，不写 WebDriver 日志。
    let receivePair!: (url: string) => void;
    const pairing = new Promise<string>((resolve) => {
      receivePair = resolve;
    });
    const receiver = createServer(async (request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (request.method !== "OPTIONS") {
        let value = "";
        for await (const chunk of request) value += String(chunk);
        receivePair(value);
      }
      response.end();
    });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("Missing pairing receiver");
    let mobile: Browser | undefined;
    let page: Page | undefined;
    let rootMoved = false;
    try {
      await browser.execute((port) => {
        const original = navigator.clipboard.writeText.bind(navigator.clipboard);
        (window as TestWindow).__restoreRoot03Clipboard = () => {
          navigator.clipboard.writeText = original;
        };
        navigator.clipboard.writeText = async (text) => {
          await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: text });
        };
      }, address.port);
      await $(
        'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]',
      ).click();
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                '[data-testid="web-remote-control-dialog-scroll"] button',
              ),
            ).find(
              (node) => /^(复制链接|Copy link)$/.test(node.innerText.trim()) && !node.disabled,
            );
            button?.click();
            return Boolean(button);
          }),
        { timeout: 60_000 },
      );
      const pairUrl = await pairing;
      if (new URL(pairUrl).hostname !== "127.0.0.1") throw new Error("Local Web fixture required");
      mobile = await chromium.launch({
        ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE
          ? { executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE }
          : { channel: "chrome" }),
        headless: true,
        args: process.env.ZCODE_E2E_BROWSER_NO_PROXY === "1" ? ["--no-proxy-server"] : [],
      });
      const context = await mobile.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      await seedMobileFixtureLogin(context);
      page = await context.newPage();
      await openMobilePairingPage(page, pairUrl, {
        artifactDir,
        caseMarker: "VP-ROOT-03",
        phase: "missing-root",
        readySelector: selector,
      });
      await page.locator(selector).getByTestId("virtual-project-create-task").tap();
      await page.locator('[data-mobile-page="chat"]').waitFor();
      const readDraft = () =>
        page!.evaluate(() => {
          const target = window as TestWindow;
          const path = target.__zcodeTabStoreE2E!.getState().activeWorkspacePath!;
          const state = target.__zcodeSessionStoreE2E!.getState().getWorkspaceState(path);
          return {
            path,
            projectId: state.draftProjectId,
            taskId: state.activeTaskId,
            focus: state.draftFocusVersion,
          };
        });
      await browser.waitUntil(async () => (await readDraft()).projectId === projectId);
      // UI 隐藏不足以保护破坏性操作；通过页面正在使用的真实 RPC 代理直接调用。
      const credentialFile = getE2EAppDataPaths().credentialsFile;
      const originalCredentials = await readFile(credentialFile);
      await page.getByTestId("v4-composer").waitFor();
      const denied = await page.evaluate(async () => {
        type Service = {
          inspectStore(): Promise<unknown>;
          recoverStore(fingerprint: string): Promise<unknown>;
        };
        type Fiber = {
          return?: Fiber;
          memoizedProps?: {
            services?: { credentialService?: Service };
            value?: { credentialService?: Service };
          };
        };
        const element = document.querySelector('[data-testid="v4-composer"]');
        if (!element) throw new Error("Missing active mobile workspace");
        const key = Object.keys(element).find((value) => value.startsWith("__reactFiber$"));
        let fiber = key ? (Reflect.get(element, key) as Fiber | undefined) : undefined;
        for (; fiber; fiber = fiber.return) {
          const service = (fiber.memoizedProps?.services ?? fiber.memoizedProps?.value)
            ?.credentialService;
          if (!service) continue;
          const result: Record<string, string> = {};
          for (const method of ["inspectStore", "recoverStore"] as const) {
            try {
              await service[method]("0".repeat(64));
              result[method] = "unexpected-success";
            } catch (error) {
              result[method] =
                typeof error === "object" && error !== null && "kind" in error
                  ? String(error.kind)
                  : String(error);
            }
          }
          return result;
        }
        throw new Error("Mobile credential RPC proxy missing");
      });
      expect(denied).toEqual({
        inspectStore: "feature_disabled",
        recoverStore: "feature_disabled",
      });
      expect(await readFile(credentialFile)).toEqual(originalCredentials);
      expect(await page.getByTestId("credential-store-recovery-open").count()).toBe(0);
      await writeFile(join(artifactDir, "credential-rpc-denied.json"), JSON.stringify(denied));
      const before = await readDraft();
      expect(before.path).toBe(cwd);
      expect(before.taskId).toBeNull();
      await page.getByRole("button", { name: /返回任务首页|Back to task home/ }).tap();
      await rename(cwd, moved);
      rootMoved = true;
      for (const locale of ["zh-CN", "en-US"] as const) {
        await page.evaluate(
          (locale) => (window as TestWindow).__testActions!.setLocale(locale),
          locale,
        );
        const reason =
          locale === "zh-CN"
            ? "该项目主文件夹已被删除或移动"
            : "This project's main folder has been deleted or moved";
        for (const theme of ["zai-dark", "zai-light"]) {
          await page.evaluate(
            (theme) => (window as TestWindow).__testActions!.setTheme(theme),
            theme,
          );
          await page.waitForFunction(
            () => !document.getElementById("zcode-toast-host")?.textContent?.trim(),
          );
          await page.getByTestId("task-new-button").tap();
          const toast = page.locator("#zcode-toast-host").getByText(reason, { exact: true });
          await toast.waitFor();
          await page.waitForFunction(() => {
            const toast = document.querySelector("#zcode-toast-host .opacity-100");
            return toast && getComputedStyle(toast).opacity === "1";
          });
          expect(await readDraft()).toEqual(before);
          await expect(stat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
          await page.screenshot({
            path: join(artifactDir, `VP-ROOT-03-mobile-${locale}-${theme}.png`),
            animations: "disabled",
          });
        }
      }
      await rename(moved, cwd);
      rootMoved = false;
      await page.getByTestId("task-new-button").tap();
      await page.locator('[data-mobile-page="chat"]').waitFor();
      await browser.waitUntil(async () => (await readDraft()).projectId === projectId);
      const restored = await readDraft();
      expect(restored.path).toBe(cwd);
      expect(restored.taskId).toBeNull();
      expect(
        await browser.execute(
          () => (window as TestWindow).__zcodeTabStoreE2E!.getState().tabs.length,
        ),
      ).toBe(desktopTabs);
      await page.screenshot({
        path: join(artifactDir, "VP-ROOT-03-mobile-restored.png"),
        animations: "disabled",
      });
    } catch (error) {
      await page
        ?.screenshot({ path: join(artifactDir, "VP-ROOT-03-mobile-failure.png") })
        .catch(() => {});
      throw error;
    } finally {
      if (rootMoved) await rename(moved, cwd);
      receiver.closeAllConnections();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
      await browser.execute(() => {
        const target = window as TestWindow;
        target.__restoreRoot03Clipboard?.();
        delete target.__restoreRoot03Clipboard;
      });
      await page?.context().close();
      await mobile?.close();
    }
  });
});
