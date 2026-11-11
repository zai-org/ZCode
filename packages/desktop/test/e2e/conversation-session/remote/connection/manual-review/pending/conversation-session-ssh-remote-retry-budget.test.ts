import { createConnection, createServer, type Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { requestRemoteProjectConnection } from "#e2e/helpers/remote-project-actions";
import {
  connectSSHWorkspace,
  readHostProcesses,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_SSH_RETRY_BUDGET";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-retry-budget",
);

async function createNetworkGate(target: { host: string; port: number }) {
  const sockets = new Set<Socket>();
  let blocked = false;
  let attempts = 0;
  const server = createServer((client) => {
    if (blocked) {
      attempts += 1;
      client.destroy();
      return;
    }
    const upstream = createConnection(target);
    sockets.add(client);
    sockets.add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.once("error", close);
    upstream.once("error", close);
    client.once("close", close);
    upstream.once("close", close);
    upstream.once("connect", () => client.pipe(upstream).pipe(client));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("缺少代理端口");
  return {
    port: address.port,
    block() {
      blocked = true;
      for (const socket of sockets) socket.destroy();
    },
    allow() {
      blocked = false;
    },
    attempts: () => attempts,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe(`${MARKER}: 重试预算、静默恢复与手动接管`, () => {
  let gate: Awaited<ReturnType<typeof createNetworkGate>> | undefined;
  const facts: Record<string, unknown> = {};
  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "retry-budget.json"), JSON.stringify(facts, null, 2));
    await gate?.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("SSH-GUIDE-RETRY 显示 1/3、2/3、3/3，耗尽显示原因，网络恢复静默上线，手动恢复不重复连接", async function () {
    this.timeout(15 * 60_000);
    const direct = readSSHRuntimeConfig(MARKER);
    gate = await createNetworkGate(direct);
    await prepareV4ConversationE2E({ skipProvider: true });
    const hosts = await readHostProcesses();
    const config = { ...direct, port: gate.port };
    const tab = await connectSSHWorkspace({
      config,
      caseMarker: MARKER,
      workspacePath: direct.workspacePaths[0],
    });
    await browser.execute(() => {
      const state = window as Window & {
        __sshGuideRetry?: { attempts: number[]; observer: MutationObserver };
      };
      const attempts: number[] = [];
      const observer = new MutationObserver(() => {
        for (const match of document.body.innerText.matchAll(/([123])\s*\/\s*3/g)) {
          const attempt = Number(match[1]);
          if (!attempts.includes(attempt)) attempts.push(attempt);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      state.__sshGuideRetry = { attempts, observer };
    });
    gate.block();
    const row = $(`[data-project-workspace-identity="${tab.workspaceIdentity}"]`);
    const toggle = row.$('[data-testid="virtual-project-toggle"]');
    const leaveDetails = async () => {
      // 浮层可能盖住其他入口；移到视口右上角，确保鼠标真正离开触发区域和浮层。
      const outside = await browser.execute(() => ({ x: innerWidth - 24, y: 24 }));
      await browser.action("pointer").move(outside).perform();
      await $('[data-testid="remote-identity-details"]').waitForDisplayed({ reverse: true });
    };
    await browser.waitUntil(
      async () => (await row.getAttribute("data-connection-state")) === "connecting",
      { timeout: 30_000, timeoutMsg: `${MARKER}: 断网后没有进入连接中` },
    );
    // 修复前连接中只有一个读取空日志的 (i) Tooltip；现在项目行写“连接中”，详情顶部给出阶段与进度。
    expect(["连接中", "Connecting"]).toContain(
      await row.$('[data-testid="project-status-label"]').getText(),
    );
    expect(await row.$$('[aria-label="查看详情"], [aria-label="View details"]')).toHaveLength(0);
    await toggle.moveTo();
    const progress = $(
      '[data-testid="remote-identity-details"] [data-testid="remote-connection-progress"]',
    );
    await progress.waitForDisplayed({ timeout: 10_000 });
    facts.connectingProgress = await progress.getText();
    expect(await progress.$$("[data-progress-segment]")).toHaveLength(4);
    expect(await progress.$$('[data-progress-segment="active"]')).toHaveLength(1);
    await browser.saveScreenshot(resolve(artifactDir, "connecting-progress.png"));
    // 详情保持打开直到终态：自动恢复 n/3 须在同一浮层内实时递增，并原地切换为失败区。
    await browser.waitUntil(
      async () => (await row.getAttribute("data-connection-state")) === "offline",
      { timeout: 120_000, timeoutMsg: `${MARKER}: 三次重试后没有离线终态` },
    );
    const seen = await browser.execute(() => {
      const state = (
        window as Window & { __sshGuideRetry?: { attempts: number[]; observer: MutationObserver } }
      ).__sshGuideRetry;
      state?.observer.disconnect();
      return state?.attempts ?? [];
    });
    facts.displayedAttempts = seen;
    facts.rejectedNetworkAttempts = gate.attempts();
    expect(facts.rejectedNetworkAttempts).toBe(3);
    // 失败原因由详情顶部的失败区表达，原文只进剪贴板，不再有独立错误图标。
    expect(await row.$('[data-testid="project-connection-error"]').isExisting()).toBe(false);
    const failure = $(
      '[data-testid="remote-identity-details"] [data-testid="remote-connection-failure"]',
    );
    await failure.waitForDisplayed({ timeout: 10_000 });
    facts.failureText = await failure.getText();
    expect((await failure.getText()).trim().length).toBeGreaterThan(0);
    expect(await failure.getText()).not.toContain(config.password);
    expect(await failure.$('[data-testid="remote-connection-copy-error"]').isDisplayed()).toBe(
      true,
    );
    await browser.saveScreenshot(resolve(artifactDir, "budget-exhausted.png"));
    await leaveDetails();
    expect((await readRemoteTabSnapshot(tab.workspaceIdentity!)).remoteSessionId).toBeNull();
    gate.allow();
    const automaticallyRestored = await waitForRemoteTab({
      caseMarker: MARKER,
      expectedIdentity: tab.workspaceIdentity!,
      expectedPath: tab.workspacePath!,
      timeoutMs: 180_000,
    });
    expect(automaticallyRestored.remoteSessionId).not.toBe(tab.remoteSessionId);
    expect(await $('[data-testid="ssh-dialog"]').isExisting()).toBe(false);
    facts.silentRecovery = automaticallyRestored;

    gate.block();
    await browser.waitUntil(
      async () => (await row.getAttribute("data-connection-state")) === "connecting",
      { timeout: 30_000 },
    );
    // 先确认旧 attachment 已释放再恢复网络；反序会把自动恢复完成误判成等待断开超时。
    await browser.waitUntil(
      async () => (await readRemoteTabSnapshot(tab.workspaceIdentity!)).remoteSessionId === null,
      { timeout: 30_000 },
    );
    gate.allow();
    await requestRemoteProjectConnection(tab.workspaceIdentity!, MARKER, { retryFailure: true });
    const manuallyRestored = await waitForRemoteTab({
      caseMarker: MARKER,
      expectedIdentity: tab.workspaceIdentity!,
      expectedPath: tab.workspacePath!,
      timeoutMs: 120_000,
    });
    expect(manuallyRestored.remoteSessionId).not.toBe(automaticallyRestored.remoteSessionId);
    expect(await readHostProcesses()).toEqual(hosts);
    facts.manualTakeover = manuallyRestored;
    // 展示缺失不影响后续连接操作；保留最终断言，同时采集静默恢复和手动接管的独立证据。
    expect(seen).toEqual([1, 2, 3]);
  });
});
