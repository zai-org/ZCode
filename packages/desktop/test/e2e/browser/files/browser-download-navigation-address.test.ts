import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformChannels } from "@zcode/shared";
import { TID_BROWSER_ADDRESS_INPUT, TID_BROWSER_LOAD_ERROR } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { openFirstBrowserTab } from "#e2e/helpers/browser-side-pane";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

declare global {
  var __browserDownloadAddressProbe:
    | {
        holdNotification: boolean;
        states: string[];
        restoreUrls: Array<string | null>;
        release(): void;
        restore(): void;
      }
    | undefined;
}

const CONTENT = "browser download address regression";
let server: Server;
let baseUrl: string;
let downloadDir: string;

describe("CR-01：下载不提交页面时恢复地址栏", () => {
  before(async () => {
    downloadDir = await mkdtemp(join(tmpdir(), "zcode-browser-download-"));
    server = createServer((request, response) => {
      if (request.url?.startsWith("/attachment")) {
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="download.txt"',
        });
        response.end(CONTENT);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Committed page</title><main>Original page</main>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("下载 fixture 没有监听端口");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await browser.electron.execute(() => globalThis.__browserDownloadAddressProbe?.restore());
    await clearAppData();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(downloadDir, { recursive: true, force: true });
  });

  it("真实下载与晚到通知回落已提交地址，且不覆盖后续草稿", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await openFirstBrowserTab();
    await installDownloadProbe(downloadDir);
    const addressInput = await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
    const cases = ["native", "late", "draft", "blank"];
    for (const [index, mode] of cases.entries()) {
      const committedUrl = mode === "blank" ? "about:blank" : `${baseUrl}/page`;
      if (index === 0 || mode === "blank") {
        await replaceAddress(committedUrl);
        await browser.keys("Enter");
      }
      await browser.waitUntil(async () => (await readGuest()).url === committedUrl, {
        timeout: 15_000,
        timeoutMsg: "初始页面没有提交",
      });
      await browser.waitUntil(async () => !(await readGuest()).loading, { timeout: 15_000 });
      await browser.waitUntil(
        () =>
          browser.electron.execute(
            (_electron, expected) =>
              globalThis.__browserDownloadAddressProbe?.restoreUrls.at(-1) === expected,
            committedUrl === "about:blank" ? null : committedUrl,
          ),
        { timeout: 15_000, timeoutMsg: "初始页面恢复 URL 未上报" },
      );
      await browser.electron.execute(
        (_electron, hold) => {
          const probe = globalThis.__browserDownloadAddressProbe;
          if (!probe) throw new Error("下载探针未安装");
          probe.holdNotification = hold;
          // 下载不改变已提交页面，React 可合并加载态而不重复上报；保留最新有效报告。
          probe.restoreUrls = probe.restoreUrls.slice(-1);
        },
        mode === "late" || mode === "draft",
      );

      const attachmentUrl = `${baseUrl}/attachment?case=${mode}`;
      await replaceAddress(attachmentUrl);
      await browser.keys("Enter");
      await browser.waitUntil(
        async () =>
          browser.electron.execute(
            (_electron, expected) =>
              globalThis.__browserDownloadAddressProbe?.states.length === expected,
            index + 1,
          ),
        { timeout: 15_000, timeoutMsg: "附件没有完成下载" },
      );
      expect(await readFile(join(downloadDir, `download-${index}.txt`), "utf8")).toBe(CONTENT);
      await browser.waitUntil(async () => !(await readGuest()).loading, { timeout: 15_000 });

      const draft = `${baseUrl}/unsubmitted-draft`;
      if (mode === "late" || mode === "draft") {
        // 暂扣真实 IPC 通知，等导航拒绝已经显示后再放行，不用 sleep 猜测事件顺序。
        await $(`[data-testid="${TID_BROWSER_LOAD_ERROR}"]`).waitForDisplayed();
        if (mode === "draft") await replaceAddress(draft);
        await browser.electron.execute(() => globalThis.__browserDownloadAddressProbe?.release());
      }
      await $(`[data-testid="${TID_BROWSER_LOAD_ERROR}"]`).waitForExist({ reverse: true });
      await expect(addressInput).toHaveValue(
        mode === "draft" ? draft : committedUrl === "about:blank" ? "" : committedUrl,
      );
      expect(await readGuest()).toEqual({ url: committedUrl, loading: false });
      const probe = await browser.electron.execute(() => ({
        states: globalThis.__browserDownloadAddressProbe?.states,
        restoreUrls: globalThis.__browserDownloadAddressProbe?.restoreUrls,
      }));
      expect(probe.states).toEqual(Array(index + 1).fill("completed"));
      expect(probe.restoreUrls?.length).toBeGreaterThan(0);
      expect(
        probe.restoreUrls?.every(
          (url) => url === (committedUrl === "about:blank" ? null : committedUrl),
        ),
      ).toBe(true);
    }
  });
});

async function replaceAddress(value: string) {
  const input = await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
  await input.click();
  await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
  await input.addValue(value);
  await expect(input).toHaveValue(value);
}

async function readGuest() {
  return browser.electron.execute((electron) => {
    const guest = electron.webContents
      .getAllWebContents()
      .find((contents) => !contents.isDestroyed() && contents.getType() === "webview");
    if (!guest) throw new Error("缺少 Browser guest");
    return { url: guest.getURL(), loading: guest.isLoading() };
  });
}

async function installDownloadProbe(directory: string) {
  await browser.electron.execute(
    (electron, directory, channels) => {
      const host = electron.BrowserWindow.getAllWindows()[0]?.webContents;
      if (!host) throw new Error("缺少宿主窗口");
      const handlers = Reflect.get(electron.ipcMain, "_invokeHandlers");
      if (!(handlers instanceof Map)) throw new Error("Electron IPC handler registry 不可用");
      const report = handlers.get(channels.BrowserViewReportResidency);
      if (typeof report !== "function") throw new Error("缺少 residency handler");
      const send = host.send;
      const session = electron.session.fromPartition("persist:zcode-embedded-browser");
      const held: Array<() => void> = [];
      let downloadIndex = 0;
      const probe: NonNullable<typeof globalThis.__browserDownloadAddressProbe> = {
        holdNotification: false,
        states: [],
        restoreUrls: [],
        release() {
          probe.holdNotification = false;
          held.splice(0).forEach((sendNotification) => sendNotification());
        },
        restore() {
          probe.release();
          host.send = send;
          handlers.set(channels.BrowserViewReportResidency, report);
          session.removeListener("will-download", onDownload);
          delete globalThis.__browserDownloadAddressProbe;
        },
      };
      const onDownload = (_event: Electron.Event, item: Electron.DownloadItem) => {
        item.setSavePath(`${directory}/download-${downloadIndex++}.txt`);
        item.once("done", (_event, state) => probe.states.push(state));
      };
      session.on("will-download", onDownload);
      host.send = (channel, ...args) => {
        if (channel === channels.BrowserViewDownloadStarted && probe.holdNotification) {
          held.push(() => send.call(host, channel, ...args));
          return;
        }
        send.call(host, channel, ...args);
      };
      // 只观察真实上报并转发原 handler，恢复地址仍由产品逻辑决定。
      handlers.set(channels.BrowserViewReportResidency, (event: unknown, payload: unknown) => {
        if (
          typeof payload === "object" &&
          payload !== null &&
          "restoreUrl" in payload &&
          (typeof payload.restoreUrl === "string" || payload.restoreUrl === null)
        ) {
          probe.restoreUrls.push(payload.restoreUrl);
        }
        return report(event, payload);
      });
      globalThis.__browserDownloadAddressProbe = probe;
    },
    directory,
    PlatformChannels,
  );
}
