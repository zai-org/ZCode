import { mkdir, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  prepareSSHConnectionPage,
  readRemoteTabSnapshot,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { waitForV4ConversationState } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_SSH_BANNER_RECONNECT";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-remote-banner-reconnect",
);
const BANNER = '[data-testid="remote-conversation-banner"]';
const WIZARD = '[data-testid="ssh-dialog"]';

type ProxyMode = "forward" | "reset" | "close";

interface ResettingSSHProxy {
  port: number;
  /**
   * forward：透传到真实 sshd；reset：现有连接发 RST，新连接收到客户端数据后发 RST；
   * close：对现有与新连接正常关闭（FIN），握手前断开且不带系统错误码。
   */
  setMode(mode: ProxyMode): void;
  close(): Promise<void>;
}

/**
 * 本机 loopback TCP 代理：Desktop 连代理端口，代理再连容器 sshd。
 * 验证报告里的故障注入是“切断代理并拒绝后续连接”，Host 看到的是 `read ECONNRESET`；
 * 这里用 resetAndDestroy 复现同一错误形状，不杀远端 sshd，远端任务与回放隧道都保持存活。
 */
async function createResettingSSHProxy(
  config: Pick<SSHConnectionConfig, "host" | "port">,
): Promise<ResettingSSHProxy> {
  let mode: ProxyMode = "forward";
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const server: Server = createServer((client) => {
    track(client);
    if (mode === "reset") {
      // 接受后立即重置会与 SSH 首写竞争，产生 EPIPE；收到客户端标识后再复现读侧 ECONNRESET。
      client.once("data", () => client.resetAndDestroy());
      return;
    }
    if (mode === "close") {
      client.end();
      return;
    }
    const upstream = createConnection({ host: config.host, port: config.port });
    track(upstream);
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once("error", closeBoth);
    upstream.once("error", closeBoth);
    upstream.once("connect", () => client.pipe(upstream).pipe(client));
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error(`${CASE_MARKER}: 代理没有拿到端口`));
        return;
      }
      resolvePort(address.port);
    });
  });
  return {
    port,
    setMode(next) {
      mode = next;
      if (next === "reset") for (const socket of sockets) socket.resetAndDestroy();
      if (next === "close") for (const socket of sockets) socket.end();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

async function waitForBannerFailed(): Promise<{ state: string | null; text: string }> {
  let banner = await readBannerText();
  await browser
    .waitUntil(
      async () => {
        banner = await readBannerText();
        return banner.state === "failed";
      },
      { interval: 1000, timeout: 180_000, timeoutMsg: "banner-failed" },
    )
    .catch((error: unknown) => {
      throw new Error(
        `${CASE_MARKER}: 恢复预算耗尽后横幅没有进入失败态: ${JSON.stringify(banner)}`,
        { cause: error },
      );
    });
  return banner;
}

async function readBannerText(): Promise<{ state: string | null; text: string }> {
  return browser.execute((selector) => {
    const banner = document.querySelector<HTMLElement>(selector);
    return {
      state: banner?.getAttribute("data-connection-state") ?? null,
      text: (banner?.innerText ?? "").replace(/\s+/gu, " ").trim(),
    };
  }, BANNER);
}

async function clickButtonByText(container: string, pattern: RegExp, label: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector, source, flags) => {
          const regex = new RegExp(source, flags);
          const button = Array.from(
            document.querySelectorAll<HTMLButtonElement>(`${selector} button`),
          ).find((item) => regex.test(item.innerText.trim()) && !item.disabled);
          button?.click();
          return Boolean(button);
        },
        container,
        pattern.source,
        pattern.flags,
      ),
    { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 没有可点击的 ${label}` },
  );
}

describe(`${CASE_MARKER}: 在线断连耗尽恢复预算后的错误归类与横幅重连`, () => {
  let provider: SSHLifecycleProvider | null = null;
  let proxy: ResettingSSHProxy | null = null;
  let reconnectedTaskId: string | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "banner-reconnect.json"), JSON.stringify(facts, null, 2));
    await proxy?.close().catch(() => undefined);
    proxy = null;
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RDUX-09-banner-wizard 链路被重置后横幅显示无法连接到主机；恢复后横幅重连→向导重试回到原会话", async function () {
    this.timeout(20 * 60_000);
    await prepareSSHConnectionPage(CASE_MARKER);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    proxy = await createResettingSSHProxy(prepared.config);
    const config: SSHConnectionConfig = { ...prepared.config, port: proxy.port };

    const task = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    facts.task = { taskId: task.taskId, identity: task.identity, session: task.remoteSessionId };

    // 故障：对端重置所有 SSH 连接，在线恢复 2/4/8s 三次重试同样被 RST，预算耗尽进入失败终态。
    proxy.setMode("reset");
    const banner = await waitForBannerFailed();
    facts.bannerAfterBudgetExhausted = banner;
    await browser
      .saveScreenshot(resolve(artifactDir, "budget-exhausted.png"))
      .catch(() => undefined);
    // 问题 1：ECONNRESET 是传输失败，横幅原因行必须是“无法连接到主机”的处理说明，
    // 不能冒充安装预检失败（“设备环境不满足安装要求”）。
    expect(banner.text).toContain("检查设备地址和端口");
    expect(banner.text).not.toContain("不满足安装要求");
    expect(banner.text).not.toContain("环境检查失败");
    expect((await readRemoteTabSnapshot(task.identity)).remoteSessionId).toBeNull();

    // 恢复链路后由用户从会话横幅重连，再在唯一向导里点“重试”。
    proxy.setMode("forward");
    await clickButtonByText(BANNER, /^(重新连接|Reconnect)$/iu, "横幅重连按钮");
    await $(WIZARD).waitForDisplayed({
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 失败态重连没有打开向导`,
    });
    await clickButtonByText(WIZARD, /^(重试|Retry)$/iu, "向导重试按钮");

    let restored = await readRemoteTabSnapshot(task.identity);
    await browser.waitUntil(
      async () => {
        restored = await readRemoteTabSnapshot(task.identity);
        return (
          Boolean(restored.remoteSessionId) && restored.remoteSessionId !== task.remoteSessionId
        );
      },
      {
        interval: 1000,
        timeout: 180_000,
        timeoutMsg: `${CASE_MARKER}: 向导重试后远端 workspace 没有换代上线`,
      },
    );
    facts.restoredSession = restored.remoteSessionId;
    await browser.waitUntil(async () => !(await $(WIZARD).isExisting()), {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 向导连接成功后没有关闭`,
    });
    // 问题 2：挂回后必须保持原会话选择，不能把原任务覆盖成空白新任务。
    const conversation = await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === task.taskId,
      `${CASE_MARKER}: 向导重连完成后没有回到原会话（进入了空白新任务）`,
      60_000,
    );
    facts.conversationAfterReconnect = conversation;
    await browser.saveScreenshot(resolve(artifactDir, "reconnected.png")).catch(() => undefined);
    expect(await readBannerText()).toMatchObject({ state: null });
    reconnectedTaskId = task.taskId;
  });

  it("RDUX-09-banner-handshake-lost 握手前被正常关闭（无系统错误码）时横幅提示自动恢复已停止，不冒充安装预检失败", async function () {
    this.timeout(10 * 60_000);
    if (!proxy || !reconnectedTaskId) {
      throw new Error(`${CASE_MARKER}: 依赖上一条用例把原会话重连上线`);
    }
    // 故障：代理对现有与新连接都发 FIN，ssh2 报 Connection lost before handshake，不带 ECONNRESET。
    proxy.setMode("close");
    const banner = await waitForBannerFailed();
    facts.bannerAfterHandshakeLost = banner;
    await browser
      .saveScreenshot(resolve(artifactDir, "handshake-lost-exhausted.png"))
      .catch(() => undefined);
    // 未识别的传输失败归入未知，预算耗尽后显示“自动恢复已停止”的处理说明；
    // 不能借探测阶段兜底成安装预检失败。
    expect(banner.text).toContain("请查看详细信息并按提示处理后重试");
    expect(banner.text).not.toContain("不满足安装要求");
    expect(banner.text).not.toContain("环境检查失败");
    proxy.setMode("forward");
  });
});
