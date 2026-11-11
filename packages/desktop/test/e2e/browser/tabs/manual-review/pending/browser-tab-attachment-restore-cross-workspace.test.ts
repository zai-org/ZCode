import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { TID_BROWSER_ADDRESS_INPUT } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import {
  SMALL_AGENT_WARMUP_SCENARIO,
  getPassiveAgentStartupWorkspacePaths,
} from "#e2e/helpers/passive-agent-startup-fixture";
import {
  openWorkspaceDraftFromSidebar,
  waitForActiveWorkspacePath,
  waitForRestoredProjects,
} from "#e2e/helpers/workspace-agent-warmup";
import {
  openFirstBrowserTab,
  readBrowserTabIds,
  waitForTabCount,
} from "#e2e/helpers/browser-side-pane";

/**
 * 守 spec docs/browser-use/2026-08-23-browser-guest-scope-recovery-spec.md §5（BGR-008 ~ BGR-010）：
 * human Browser tab 导航到附件 URL 后，来回切换 workspace 不能再请求该 URL。
 *
 * 旧实现三处叠加：附件 URL 在导航前就写成恢复 URL；切走 workspace 的那一次 commit 里 human tab
 * 用当前 workspace attach，main 判 workspace-mismatch；rebind 经 BrowserViewReady 在当前
 * workspace 新建隐藏 browser-use shell 并恢复页面。每次切换都会多一次下载。
 * 这里用本地服务端的请求计数作为唯一判据，不依赖日志或下载落盘。
 */
describe("Browser tab 附件 URL 跨 workspace 恢复 E2E", () => {
  let fixture: AttachmentFixture | undefined;

  before(async () => {
    fixture = await startAttachmentFixture();
    await cancelGuestDownloads();
  });

  after(async () => {
    await fixture?.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BTA01: 附件只下载一次，切换 workspace 不重复请求", async function () {
    this.timeout(300_000);
    if (!fixture) throw new Error("附件服务没有启动");

    const workspacePaths = getPassiveAgentStartupWorkspacePaths(
      dirname(DEFAULT_WORKSPACE),
      SMALL_AGENT_WARMUP_SCENARIO.workspaceCount,
    );
    const workspaceA = workspacePaths[SMALL_AGENT_WARMUP_SCENARIO.activeWorkspaceIndex];
    const workspaceB = workspacePaths.find((path) => path !== workspaceA);
    if (!workspaceA || !workspaceB) throw new Error("跨 workspace 用例需要两个 workspace fixture");

    await waitForWorkspaceApp(workspaceA, 30_000);
    await waitForActiveWorkspacePath(workspaceA);
    await waitForRestoredProjects(workspacePaths);

    await openFirstBrowserTab();
    const [tabId] = await readBrowserTabIds();
    if (!tabId) throw new Error("workspace A 没有成功打开 Browser tab");

    const addressInput = await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
    await addressInput.setValue(fixture.attachmentUrl);
    await browser.keys("Enter");
    await browser.waitUntil(async () => fixture?.attachmentHits === 1, {
      timeout: 15_000,
      timeoutMsg: "地址栏导航后附件服务没有收到请求",
    });

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const guest = document.querySelector("webview") as
            | (HTMLElement & { isLoading(): boolean })
            | null;
          return guest !== null && !guest.isLoading();
        }),
      { timeout: 10_000, timeoutMsg: "附件导航没有结束" },
    );
    await browser.waitUntil(
      async () => !(await $("*=This page could not be opened").isExisting()),
      {
        timeout: 10_000,
        timeoutMsg: "下载导航被误报为页面加载失败",
      },
    );

    for (let round = 0; round < 3; round += 1) {
      await openWorkspaceDraftFromSidebar(workspaceB);
      await waitForTabCount(0);
      // rebind 与恢复都是异步的；旧实现在切走后约 1 秒内重新请求附件。
      await browser.pause(2000);
      await openWorkspaceDraftFromSidebar(workspaceA);
      await waitForTabCount(1);
      await browser.pause(2000);
    }

    expect(await readBrowserTabIds()).toEqual([tabId]);
    expect(fixture.attachmentHits).toBe(1);
  });
});

interface AttachmentFixture {
  attachmentUrl: string;
  readonly attachmentHits: number;
  close(): Promise<void>;
}

async function startAttachmentFixture(): Promise<AttachmentFixture> {
  let attachmentHits = 0;
  const server: Server = createServer((request, response) => {
    if (request.url?.startsWith("/logs.zip")) {
      attachmentHits += 1;
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="logs.zip"',
      });
      response.end("zip");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("附件服务没有拿到端口");
  return {
    attachmentUrl: `http://127.0.0.1:${address.port}/logs.zip?response-content-disposition=attachment`,
    get attachmentHits() {
      return attachmentHits;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 取消 guest 下载，避免弹出原生保存框；请求已经到达服务端，计数不受影响。 */
async function cancelGuestDownloads(): Promise<void> {
  await browser.electron.execute((electron) => {
    const hooked = new WeakSet<object>();
    const hook = (session: Electron.Session) => {
      if (hooked.has(session)) return;
      hooked.add(session);
      session.on("will-download", (event) => event.preventDefault());
    };
    for (const contents of electron.webContents.getAllWebContents()) hook(contents.session);
    electron.app.on("web-contents-created", (_event, contents) => hook(contents.session));
  });
}
