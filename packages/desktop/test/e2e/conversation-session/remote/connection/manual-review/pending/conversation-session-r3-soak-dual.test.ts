import { openMobilePairingPage } from "#e2e/helpers/mobile-pairing";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  TID_TASK_ITEM,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  listRemoteAgentProcesses,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  readHostProcesses,
  readRemoteTabSnapshot,
  runSSHCommand,
} from "#e2e/helpers/ssh-remote-p0";
import {
  getV4Messages,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_SOAK_DUAL";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-soak-dual");
// Linux e2e 服务器上没有 macOS 版 Chrome：用 R3_MOBILE_CHROME 指向该机 playwright 下载的
// chromium（缺省仍回退开发机 macOS 路径），否则本 case 在服务器上直接起不了手机浏览器。
const CHROME =
  process.env.R3_MOBILE_CHROME?.trim() ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const run = promisify(execFile);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PwPage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PwContext = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PwBrowser = any;

async function countRemoteSshSessions(container: string): Promise<number> {
  const { stdout } = await run("docker", [
    "exec",
    container,
    "sh",
    "-c",
    "ps -o user=,args= -C sshd | grep -c '^dev ' || true",
  ]);
  return Number.parseInt(stdout.trim() || "0", 10);
}

/** 打开 Desktop 的“移动端远程控制”对话框并拦截剪贴板取得配对链接（含配对材料，只留内存、不落记录）。 */
async function obtainPairUrl(): Promise<string> {
  await browser.execute(() => {
    const clipboard = navigator.clipboard;
    const original = clipboard.writeText.bind(clipboard);
    (
      window as Window & { __r3RestoreClipboard?: () => void; __r3PairUrl?: string }
    ).__r3RestoreClipboard = () => {
      clipboard.writeText = original;
    };
    clipboard.writeText = async (text: string) => {
      (window as Window & { __r3PairUrl?: string }).__r3PairUrl = text;
    };
  });
  const trigger = $('button[aria-label="移动端远程控制"]');
  await trigger.waitForClickable({ timeout: 30_000 });
  await trigger.click();
  await $('[data-testid="web-remote-control-dialog-scroll"]').waitForDisplayed({ timeout: 30_000 });
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            '[data-testid="web-remote-control-dialog-scroll"] button',
          ),
        ).find((b) => b.innerText.trim() === "复制链接" && !b.disabled);
        button?.click();
        return Boolean(button);
      }),
    {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: `${CASE_MARKER}: 复制链接按钮不可用（relay 未就绪？）`,
    },
  );
  let url = "";
  await browser.waitUntil(
    async () => {
      url = (await browser.execute(
        () => (window as Window & { __r3PairUrl?: string }).__r3PairUrl ?? "",
      )) as string;
      return url.startsWith("http");
    },
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 没有取得配对链接` },
  );
  await browser.execute(() => {
    const w = window as Window & { __r3RestoreClipboard?: () => void; __r3PairUrl?: string };
    w.__r3RestoreClipboard?.();
    delete w.__r3RestoreClipboard;
    delete w.__r3PairUrl;
  });
  return url;
}

async function readDesktopMobileStatus(): Promise<string> {
  return browser.execute(
    () =>
      document
        .querySelector<HTMLElement>('[data-testid="web-remote-control-connection-card"]')
        ?.innerText.replace(/\s+/gu, " ")
        .slice(0, 200) ?? "",
  );
}

async function closeRemoteControlDialog(): Promise<void> {
  await browser.keys(["Escape"]);
  await browser
    .waitUntil(
      () =>
        browser.execute(
          () => !document.querySelector('[data-testid="web-remote-control-dialog-scroll"]'),
        ),
      { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: 远程控制对话框没有关闭` },
    )
    .catch(() => undefined);
}

async function mobileText(page: PwPage): Promise<string> {
  return (await page.evaluate(() => document.body?.innerText ?? "")) as string;
}

const SOAK_MINUTES = Number(process.env.R3_SOAK2_MINUTES?.trim() || "25");

interface Sample {
  round: number;
  t: number;
  hosts: number;
  agents: number;
  ssh: number;
  remoteLogBytes: number;
  desktopTurnMs: number;
  mobileTurnMs: number;
  mobileOfflineRecovered: boolean | null;
  mobileEchoOk: boolean | null;
  rssMb: number | null;
}

describe(`${CASE_MARKER}: Desktop continuous + Mobile replayable 同时运行的缩短版 soak`, () => {
  let provider: SSHLifecycleProvider | null = null;
  let mobileBrowser: PwBrowser = null;
  const facts: Record<string, unknown> = {};
  const samples: Sample[] = [];

  after(async () => {
    facts.samples = samples;
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "soak-dual.json"), JSON.stringify(facts, null, 2));
    await mobileBrowser?.close().catch(() => undefined);
    mobileBrowser = null;
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it(`R3A-SOAK-02 ${SOAK_MINUTES} 分钟：桌面与手机交替输入、每 3 轮手机断网恢复；无挂死/丢输入；Host/Agent/远端日志体积趋势可解释`, async function () {
    if (!Number.isFinite(SOAK_MINUTES) || SOAK_MINUTES <= 0) {
      throw new Error(`${CASE_MARKER}: R3_SOAK2_MINUTES 必须是正数，不能跳过长稳循环`);
    }
    this.timeout((SOAK_MINUTES + 20) * 60_000);
    const container = process.env.ZCODE_E2E_SSH_CONTAINER?.trim();
    if (!container) throw new Error(`${CASE_MARKER}: 缺少 ZCODE_E2E_SSH_CONTAINER`);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, {
      apiType: "anthropic-messages",
      tunnelUsername: "tunnel",
    });
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const remoteLogBytes = async () =>
      Number.parseInt(
        (
          await runSSHCommand(
            prepared.config,
            'F=$(ls -t ~/.zcode/cli/log/*.jsonl | head -n1); stat -c %s "$F"',
          )
        ).stdout.trim() || "0",
        10,
      );
    const rss = async () => {
      const value = await browser.electron.execute((electron) =>
        electron.app.getAppMetrics().reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0),
      );
      return typeof value === "number" ? Math.round(value / 1024) : null;
    };
    const baseline = {
      hosts: (await readHostProcesses()).length,
      ssh: await countRemoteSshSessions(container),
      agents: (await listRemoteAgentProcesses(prepared.config)).length,
      remoteLogBytes: await remoteLogBytes(),
      rssMb: await rss(),
    };
    facts.baseline = baseline;

    const pairUrl = await obtainPairUrl();
    const { chromium } = (await import("playwright-core")) as {
      chromium: { launch(o: object): Promise<PwBrowser> };
    };
    mobileBrowser = await chromium.launch({ headless: true, executablePath: CHROME });
    const mobileContext: PwContext = await mobileBrowser.newContext({
      viewport: MOBILE_VIEWPORT,
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    const mobile: PwPage = await mobileContext.newPage();
    await openMobilePairingPage(mobile, pairUrl, {
      artifactDir,
      caseMarker: CASE_MARKER,
      phase: "initial",
      readySelector: `[data-testid="${testId(TID_TASK_ITEM, taskA.taskId)}"]`,
    });
    await browser.waitUntil(async () => (await readDesktopMobileStatus()).includes("手机已连接"), {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: Desktop 未显示手机已连接`,
    });
    await closeRemoteControlDialog();
    await mobile
      .locator(`[data-testid="${testId(TID_TASK_ITEM, taskA.taskId)}"]`)
      .first()
      .click();
    await mobile.getByText(taskA.firstReply, { exact: false }).first().waitFor({ timeout: 60_000 });

    const deadline = Date.now() + SOAK_MINUTES * 60_000;
    let round = 0;
    let lostInputs = 0;
    // 0911 修复（首跑 214 轮实录）：getV4Messages/mobileText 读的是 DOM 虚拟化窗口，
    // 收尾全量对账在 replay 秒回的高轮次（428+ 条消息）下窗口只含少量行，
    // desktopMissing=207/214 假失败。改为逐轮增量对账：标记刚发送必在窗口底部。
    let desktopMissingLive = 0;
    let mobileMissingOnDesktopLive = 0;
    let mobileEchoMissing = 0;
    while (Date.now() < deadline) {
      round += 1;
      const sample: Sample = {
        round,
        t: 0,
        hosts: 0,
        agents: 0,
        ssh: 0,
        remoteLogBytes: 0,
        desktopTurnMs: 0,
        mobileTurnMs: 0,
        mobileOfflineRecovered: null,
        mobileEchoOk: null,
        rssMb: null,
      };
      const t0 = Date.now();
      // 桌面回合。
      const d0 = Date.now();
      const dMarker = `${CASE_MARKER}_D${round}`;
      const start = await getUpstreamRequestRecordCount();
      await sendV4PromptAndWaitAccepted(
        `${dMarker} 请回复`,
        dMarker,
        `round ${round}: 桌面输入未被接受`,
      );
      await waitForUpstreamRequest(
        { lastUserMessageIncludes: [dMarker] },
        `round ${round}: 桌面输入没有到达回放`,
        90_000,
        { afterIndex: start - 1 },
      );
      await waitForV4ConversationState(
        (s) => s.taskId === taskA.taskId && s.state === "idle",
        `round ${round}: 桌面回合没有收口`,
        120_000,
      );
      sample.desktopTurnMs = Date.now() - d0;
      // 手机回合（每 3 轮先断网 10s 再恢复后发送）。
      if (round % 3 === 0) {
        await mobileContext.setOffline(true);
        await browser.pause(10_000);
        await mobileContext.setOffline(false);
        let recovered = false;
        for (let i = 0; i < 20 && !recovered; i += 1) {
          recovered = (await mobileText(mobile)).includes(dMarker);
          if (!recovered) await browser.pause(1_500);
        }
        sample.mobileOfflineRecovered = recovered;
      }
      const m0 = Date.now();
      const mMarker = `${CASE_MARKER}_M${round}`;
      const start2 = await getUpstreamRequestRecordCount();
      const composer = mobile.locator(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).first();
      await composer.waitFor({ timeout: 30_000 });
      await composer.click();
      await mobile.keyboard.type(`${mMarker} 请回复`);
      await mobile.locator(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).first().click();
      const arrived = await waitForUpstreamRequest(
        { lastUserMessageIncludes: [mMarker] },
        "mobile",
        90_000,
        { afterIndex: start2 - 1 },
      )
        .then(() => true)
        .catch(() => false);
      if (!arrived) lostInputs += 1;
      await waitForV4ConversationState(
        (s) => s.taskId === taskA.taskId && s.state === "idle",
        `round ${round}: 手机回合没有收口`,
        120_000,
      );
      // 增量对账：本轮 _D/_M 刚发生，均在桌面 timeline 虚拟化窗口底部；手机回显同理。
      const usersNow = (await getV4Messages("user")).map((m) => m.text ?? "");
      if (!usersNow.some((t) => t.includes(dMarker))) desktopMissingLive += 1;
      if (!usersNow.some((t) => t.includes(mMarker))) mobileMissingOnDesktopLive += 1;
      // 0911 修复（round 29 实录 24/225）：手机 DOM 同为虚拟化，断网恢复轮重挂载后
      // 立即读 innerText 可能尚未含最新消息。改等待式（最多 ~15s）容忍重挂载，
      // 逐轮结果记入 sample 供分布分析。
      let mobileEchoOk = false;
      for (let i = 0; i < 10 && !mobileEchoOk; i += 1) {
        mobileEchoOk = (await mobileText(mobile)).includes(mMarker);
        if (!mobileEchoOk) await browser.pause(1_500);
      }
      if (!mobileEchoOk) mobileEchoMissing += 1;
      sample.mobileEchoOk = mobileEchoOk;
      sample.mobileTurnMs = Date.now() - m0;
      sample.hosts = (await readHostProcesses()).length;
      sample.ssh = await countRemoteSshSessions(container);
      sample.agents = (await listRemoteAgentProcesses(prepared.config)).length;
      sample.remoteLogBytes = await remoteLogBytes();
      sample.rssMb = await rss();
      sample.t = Date.now() - t0;
      samples.push(sample);
    }
    facts.summary = {
      rounds: round,
      lostInputs,
      desktopMissing: desktopMissingLive,
      mobileMissingOnDesktop: mobileMissingOnDesktopLive,
      mobileEchoMissing: mobileEchoMissing,
      hostsMax: Math.max(...samples.map((s) => s.hosts)),
      agentsMax: Math.max(...samples.map((s) => s.agents)),
      remoteLogGrowthBytes: (samples.at(-1)?.remoteLogBytes ?? 0) - baseline.remoteLogBytes,
      rssMbFirst: samples[0]?.rssMb ?? null,
      rssMbLast: samples.at(-1)?.rssMb ?? null,
      offlineRecoveryFailures: samples.filter((s) => s.mobileOfflineRecovered === false).length,
    };
    expect(lostInputs).toBe(0);
    // 零轮/未触发断网的样本不能证明长稳；恢复失败必须影响 verdict，不能只写入 facts。
    expect(samples.length).toBeGreaterThanOrEqual(3);
    expect(samples.some((sample) => sample.mobileOfflineRecovered !== null)).toBe(true);
    expect(samples.filter((sample) => sample.mobileOfflineRecovered === false)).toHaveLength(0);
    expect((facts.summary as { desktopMissing: number }).desktopMissing).toBe(0);
    expect((facts.summary as { mobileMissingOnDesktop: number }).mobileMissingOnDesktop).toBe(0);
    expect((facts.summary as { mobileEchoMissing: number }).mobileEchoMissing).toBe(0);
    expect((facts.summary as { hostsMax: number }).hostsMax).toBe(baseline.hosts);
    expect((facts.summary as { agentsMax: number }).agentsMax).toBeLessThanOrEqual(
      baseline.agents + 1,
    );
    await mobileContext.close();
  });
});
