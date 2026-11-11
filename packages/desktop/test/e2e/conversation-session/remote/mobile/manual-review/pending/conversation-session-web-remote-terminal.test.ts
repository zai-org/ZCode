import { writeFile } from "node:fs/promises";
import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { basename, join } from "node:path";
import {
  parseWebRemoteControlAppPayload,
  ServiceChannels,
  type WebRemoteControlWorkspaceBridgeReadyPayload,
} from "@zcode/shared";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  connectSSHWorkspace,
  createSSHReplayTunnel,
  readSSHRuntimeConfig,
  type ReplayTunnel,
} from "#e2e/helpers/ssh-remote-p0";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  TID_TERMINAL,
  TID_TERMINAL_TOGGLE,
  TID_SIDE_PANE_TOGGLE,
  TID_TASK_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  waitForWorkspaceApp,
  switchToWorkspaceRendererWindow,
} from "#e2e/helpers/desktop-app";
import { openMobilePairingPage } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl } from "#e2e/helpers/web-remote-unread";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";
import { buildTerminalProbeCommand } from "#e2e/helpers/web-remote-terminal-probe";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  getV4ConversationState,
  selectV4TaskById,
} from "#e2e/helpers/v4-conversation";

const CASE = "E2E_MRO04";
const mobileRows = ".terminal-xterm-shell:visible .xterm-rows";
const remote = process.env.ZCODE_E2E_MRO04_REMOTE === "1";

async function desktopText(sidePane = false) {
  return browser.execute(
    (root) => {
      const rows = [...document.querySelectorAll<HTMLElement>(`${root} .xterm-rows`)];
      return rows
        .filter((row) => row.checkVisibility())
        .map((row) => row.textContent)
        .join("\n");
    },
    sidePane ? "[data-side-pane-content-slot]" : `[data-testid="${TID_TERMINAL}"]`,
  );
}

async function runDesktopCommand(label: string, sidePane = false) {
  await browser.execute(
    (root) => {
      const areas = [
        ...document.querySelectorAll<HTMLTextAreaElement>(`${root} .xterm-helper-textarea`),
      ];
      areas.find((area) => area.closest(".xterm")?.checkVisibility())?.focus();
    },
    sidePane ? "[data-side-pane-content-slot]" : `[data-testid="${TID_TERMINAL}"]`,
  );
  await browser.keys(buildTerminalProbeCommand(label, "local").split(""));
  await browser.waitUntil(async () => (await desktopText(sidePane)).includes(`MRO04_${label}`));
  await browser.keys("Enter");
  await browser.waitUntil(
    async () => (await desktopText(sidePane)).includes(`E2E_MRO04_${label}`),
    {
      timeout: 15_000,
      timeoutMsg: `${CASE}: desktop PTY did not execute ${label}`,
    },
  );
}

async function runMobileCommand(
  page: Page,
  label: string,
  workspace = DEFAULT_WORKSPACE,
  waitForPrompt = true,
  softKeyboard = false,
) {
  const rows = page.locator(mobileRows).last();
  if (waitForPrompt)
    await page.waitForFunction(
      () => {
        const text = [
          ...document.querySelectorAll<HTMLElement>(".terminal-xterm-shell .xterm-rows"),
        ]
          .filter((row) => row.checkVisibility())
          .map((row) => row.textContent ?? "")
          .join("\n");
        if (text.includes("[Terminal failed to start]")) throw new Error(text);
        return /[$#>%]\s*$/u.test(text);
      },
      undefined,
      { timeout: 30_000 },
    );
  const input = page.locator(".terminal-xterm-shell:visible .xterm-helper-textarea").last();
  await input.focus();
  const command = buildTerminalProbeCommand(label, remote ? "linux-ssh" : "local");
  if (softKeyboard) {
    await input.evaluate(async (element, text) => {
      const textarea = element as HTMLTextAreaElement;
      for (const char of text) {
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Unidentified",
            keyCode: 229,
            bubbles: true,
            composed: true,
          }),
        );
        // 复现软键盘跨事件轮次提交：旧 xterm 在文字进入 textarea 前已经读完旧值。
        await new Promise((resolve) => setTimeout(resolve, 10));
        textarea.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertText",
            data: char,
            bubbles: true,
            composed: true,
          }),
        );
        textarea.value += char;
        textarea.dispatchEvent(
          new InputEvent("input", {
            inputType: "insertText",
            data: char,
            bubbles: true,
            composed: true,
          }),
        );
        textarea.dispatchEvent(
          new KeyboardEvent("keyup", {
            key: char,
            bubbles: true,
            composed: true,
          }),
        );
      }
    }, command);
  } else {
    await input.pressSequentially(command);
  }
  await page.waitForFunction(
    (label) => document.body.textContent?.includes(`MRO04_${label}`),
    label,
  );
  if (softKeyboard) {
    await input.evaluate((element) => {
      // 软键盘可只发 229 + 换行 input；普通 Enter 会产生 keypress，掩盖该路径的丢失。
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Unidentified",
          keyCode: 229,
          bubbles: true,
          composed: true,
        }),
      );
      document.execCommand("insertLineBreak");
      element.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Unidentified",
          keyCode: 229,
          bubbles: true,
          composed: true,
        }),
      );
    });
  } else {
    await input.press("Enter");
  }
  let output = "";
  await browser.waitUntil(
    async () => {
      output = (await rows.textContent()) ?? "";
      // 标记和 cwd 可能分批绘制；必须等完整快照，不能把首行到达误当成输出完成。
      return output.includes(`E2E_MRO04_${label}`) && output.includes(workspace);
    },
    {
      timeout: 15_000,
      timeoutMsg: `${CASE}: mobile PTY did not execute ${label}`,
    },
  );
  return output;
}

async function openMobileTerminal(page: Page) {
  const overlay = page.locator('[data-mobile-side-pane-overlay="true"]');
  if ((await overlay.getAttribute("aria-hidden")) !== "false") {
    await page.getByTestId(TID_SIDE_PANE_TOGGLE).tap();
  }
  await page.locator('[data-mobile-side-pane-overlay="true"][aria-hidden="false"]').waitFor();
  await page
    .locator(
      '[data-side-pane-open-tab-item="terminal"]:visible, [data-side-pane-add-tab-trigger]:visible',
    )
    .first()
    .waitFor();
  const launcher = page.locator('[data-side-pane-open-tab-item="terminal"]:visible');
  if (!(await launcher.count()))
    await page.locator("[data-side-pane-add-tab-trigger]:visible").tap();
  await launcher.last().tap();
  await page.locator(mobileRows).last().waitFor();
}

describe("MRO04: 手机远控终端与桌面隔离", () => {
  let webBrowser: Browser | undefined;
  let mobilePage: Page | undefined;
  let tunnel: ReplayTunnel | undefined;
  const evidence: Record<string, unknown> = {};
  const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;

  after(async () => {
    if (artifacts) {
      await mobilePage
        ?.screenshot({ path: join(artifacts, "MRO04-mobile.png") })
        .catch(() => undefined);
      await writeFile(join(artifacts, "MRO04-terminal.json"), JSON.stringify(evidence, null, 2));
    }
    await webBrowser?.close();
    await tunnel?.close();
    await restoreHandoffProbes();
    await clearAppData();
  });

  it("已配对手机打开、执行和重开终端，桌面原终端持续可用", async function () {
    this.timeout(15 * 60_000);
    if (!artifacts) throw new Error(`${CASE}: isolated artifacts required`);
    await prepareV4ConversationE2E();
    await sendV4Prompt("E2E_MRO04_SESSION: 只回复固定回放内容。");
    await waitForV4AssistantMessageContaining("E2E_MRO04_SESSION_READY", 60_000);
    let taskId = (await getV4ConversationState()).taskId;
    if (!taskId) throw new Error(`${CASE}: persisted task required`);
    const localTaskId = taskId;
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await $(`[data-testid="${TID_TERMINAL_TOGGLE}"]`).click();
    await browser.waitUntil(async () => /[$#>%]\s*$/u.test(await desktopText()), {
      timeout: 30_000,
    });
    await runDesktopCommand("DESKTOP_BEFORE");
    evidence.desktopBefore = await desktopText();
    await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`).click();
    await $('[data-side-pane-open-tab-item="terminal"]').waitForClickable();
    await $('[data-side-pane-open-tab-item="terminal"]').click();
    await browser.waitUntil(async () => /[$#>%]\s*$/u.test(await desktopText(true)), {
      timeout: 30_000,
    });
    await runDesktopCommand("DESKTOP_SIDE_BEFORE", true);
    evidence.desktopSideBefore = await desktopText(true);
    const desktopSideOwner = String(evidence.desktopSideBefore).match(/PTY_OWNER=(\d+)/u)?.[1];
    expect(desktopSideOwner).toBeTruthy();
    expect(desktopSideOwner).not.toBe(
      String(evidence.desktopBefore).match(/PTY_OWNER=(\d+)/u)?.[1],
    );
    // 桌面同一服务的侧栏保活仍须可用；收起不关闭终端，也不重复创建 PTY。
    await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`).click();

    let workspace = DEFAULT_WORKSPACE;
    let projectSelector = `[data-project-name="${basename(workspace)}"]`;
    if (remote) {
      const config = readSSHRuntimeConfig(CASE);
      workspace = config.workspacePaths[0];
      tunnel = await createSSHReplayTunnel(config, CASE, { mirrorLocalPort: true });
      const remoteWorkspace = await connectSSHWorkspace({
        caseMarker: CASE,
        config,
        workspacePath: workspace,
      });
      // 重测可复用已有 Source 数据，项目显示名可能带去重后缀；按实际连接身份定位。
      projectSelector = `[data-project-workspace-identity="${remoteWorkspace.workspaceIdentity}"]`;
      await sendV4Prompt("E2E_MRO04_SESSION: 只回复固定回放内容。");
      await waitForV4AssistantMessageContaining("E2E_MRO04_SESSION_READY", 60_000);
      taskId = (await getV4ConversationState()).taskId;
      if (!taskId) throw new Error(`${CASE}: remote persisted task required`);
    }
    const pairingUrl = await obtainUnreadPairingUrl(
      new URL(process.env.ZCODE_WEB_REMOTE_CONTROL_URL!).origin,
    );
    webBrowser = await chromium.launch({
      ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
      headless: true,
      args: process.env.ZCODE_E2E_BROWSER_NO_PROXY === "1" ? ["--no-proxy-server"] : [],
    });
    const context = await webBrowser.newContext({
      recordVideo: { dir: artifacts, size: { width: 390, height: 844 } },
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    });
    await context.addInitScript((credentials) => {
      for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
    }, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
    // initScript 以原始脚本注入，避免构建器把类/回调改写成依赖外部 __name 的闭包。
    await context.addInitScript({
      content: `(() => {
      const relaySockets = new Set();
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url, protocols) {
          super(url, protocols);
          if (String(url).includes("/api/v1/remote/ws2")) {
            relaySockets.add(this);
            this.addEventListener("close", () => relaySockets.delete(this), { once: true });
          }
        }
      };
      window.__mro04DisconnectRelay = () => {
        const sockets = [...relaySockets];
        for (const socket of sockets) socket.close(4000, "E2E_MRO04_DISCONNECT");
        return sockets.length;
      };
      // 重连打散延迟取窗口上限附近；transport 构造时捕获 Math.random，必须在页面脚本前替换。
      // 只在短断线步骤开启，并保留少量随机性，避免同值 ID。
      const nativeRandom = Math.random.bind(Math);
      let highRandom = false;
      Math.random = () => (highRandom ? 0.99 + nativeRandom() * 0.009 : nativeRandom());
      window.__mro04ForceHighRandom = (enabled) => {
        highRandom = Boolean(enabled);
      };
    })();`,
    });
    const page = await context.newPage();
    mobilePage = page;
    const bridges: WebRemoteControlWorkspaceBridgeReadyPayload[] = [];
    const pairedAt: number[] = [];
    let invalidateBridge: (() => void) | undefined;
    await page.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/u, (route) => {
      const server = route.connectToServer();
      route.onMessage((message) => server.send(message));
      server.onMessage((message) => {
        const frame = JSON.parse(String(message)) as {
          type?: string;
          pair_status?: string;
          payload?: unknown;
        };
        if (frame.type === "auth_ack" && frame.pair_status === "matched") pairedAt.push(Date.now());
        const payload = parseWebRemoteControlAppPayload(frame.payload);
        if (payload?.zcode_type === "workspace-bridge-ready") {
          bridges.push(payload);
          // 只注入当前 bridge 的失效通知；重建、Host attachment 与 PTY 全走真实路径。
          invalidateBridge = () =>
            route.send(
              JSON.stringify({
                ...frame,
                payload: {
                  zcode_type: "bridge-degraded",
                  bridgeSessionId: payload.bridgeSessionId,
                  bridgeGeneration: payload.bridgeGeneration,
                  recoveryId: payload.recoveryId,
                  reason: "rpc-transport-fault",
                },
              }),
            );
        }
        route.send(message);
      });
    });
    await openMobilePairingPage(page, pairingUrl, {
      artifactDir: artifacts,
      caseMarker: CASE,
      phase: "terminal",
      readySelector: projectSelector,
    });
    const projectToggle = page.locator(projectSelector).getByTestId("virtual-project-toggle");
    if ((await projectToggle.getAttribute("aria-expanded")) !== "true") await projectToggle.tap();
    await page.getByTestId(testId(TID_TASK_ITEM, taskId)).first().tap();
    await page.locator('[data-mobile-page="chat"]').waitFor();
    await openMobileTerminal(page);
    evidence.mobileFirst = await runMobileCommand(page, "MOBILE_FIRST", workspace);
    expect(evidence.mobileFirst).toContain(workspace);
    evidence.mobileIme = await runMobileCommand(page, "MOBILE_IME", workspace, true, true);
    expect(evidence.mobileIme).toContain(`E2E_MRO04_MOBILE_IME`);
    const firstOwner = String(evidence.mobileFirst).match(/PTY_OWNER=(\d+)/u)?.[1];
    expect(firstOwner).toBeTruthy();
    const firstTab = page.locator('[data-side-pane-tab-id^="terminal:"]:visible').last();
    const firstId = await firstTab.getAttribute("data-side-pane-tab-id");
    // 项目新建草稿会重建 bridge；返回原会话必须复用原 PTY，同时接上新 RPC。
    await page.getByRole("button", { name: /^(返回任务首页|Back to task home)$/u }).tap();
    await page.getByTestId("sidebar").waitFor();
    await page.locator(projectSelector).getByTestId("virtual-project-create-task").tap();
    await page.locator('[data-mobile-page="chat"]').waitFor();
    const beforeRecovery = bridges.at(-1);
    const beforeRecoveryPage = await page.locator('[data-mobile-page="chat"]').elementHandle();
    await page.screenshot({ path: join(artifacts, "MRO04-draft-before-recovery.png") });
    if (!invalidateBridge || !beforeRecovery) throw new Error(`${CASE}: no active draft bridge`);
    invalidateBridge();
    await browser.waitUntil(
      () => bridges.at(-1)?.bridgeSessionId !== beforeRecovery.bridgeSessionId,
      {
        timeout: 30_000,
        timeoutMsg: `${CASE}: draft bridge did not rebuild`,
      },
    );
    expect(bridges.at(-1)?.bridge.terminalOwnerId).toBe(beforeRecovery.bridge.terminalOwnerId);
    // ready 帧早于能力探测及 Root 提交；等旧页面真正卸载，避免在旧树上点击返回。
    await page.waitForFunction((previous) => !previous?.isConnected, beforeRecoveryPage);
    await page.locator('[data-mobile-page="chat"]').waitFor();
    await page.getByRole("button", { name: /^(返回任务首页|Back to task home)$/u }).tap();
    await page.getByTestId("sidebar").waitFor();
    await page.getByTestId(testId(TID_TASK_ITEM, taskId)).first().tap();
    await page.locator('[data-mobile-page="chat"]').waitFor();
    if (
      (await page.locator('[data-mobile-side-pane-overlay="true"]').getAttribute("aria-hidden")) !==
      "false"
    ) {
      await page.getByTestId(TID_SIDE_PANE_TOGGLE).tap();
    }
    await page.locator(mobileRows).last().waitFor();
    expect(await firstTab.getAttribute("data-side-pane-tab-id")).toBe(firstId);
    expect(await page.locator(mobileRows).last().textContent()).toContain("E2E_MRO04_MOBILE_FIRST");
    // bridge 换代期间 shell 重绘可能不保留完整提示符；由新输出、cwd 和 PID 验证真实可交互。
    evidence.mobileAfterBridge = await runMobileCommand(
      page,
      "MOBILE_AFTER_BRIDGE",
      workspace,
      false,
    );
    const owners = [...String(evidence.mobileAfterBridge).matchAll(/PTY_OWNER=(\d+)/gu)];
    expect(owners.length).toBeGreaterThanOrEqual(2);
    expect(owners.at(-1)?.[1]).toBe(firstOwner);
    await page.screenshot({ path: join(artifacts, "MRO04-draft-recovered-terminal.png") });
    await firstTab.locator("button").click();
    await firstTab.waitFor({ state: "detached" });
    await openMobileTerminal(page);
    const nextId = await page
      .locator('[data-side-pane-tab-id^="terminal:"]:visible')
      .last()
      .getAttribute("data-side-pane-tab-id");
    expect(nextId).not.toBe(firstId);
    evidence.mobileReopened = await runMobileCommand(page, "MOBILE_REOPENED", workspace);
    expect(evidence.mobileReopened).toContain(workspace);
    // CR-01：页面丢失 registry 后不能遗留 Host shell；断连判定沿用现有宽限。
    const reopenedPid = Number(String(evidence.mobileReopened).match(/PTY_OWNER=(\d+)/u)?.[1]);
    const shellAlive = async (pid: number) => {
      if (remote) {
        const result = await execInRemoteContainer(readRemoteDockerContainer(CASE), [
          "sh",
          "-c",
          'if kill -0 "$1" 2>/dev/null; then echo alive; else echo exited; fi',
          "sh",
          String(pid),
        ]);
        return result.stdout.trim() !== "exited";
      }
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    const waitForShellExit = async (pid: number) => {
      expect(pid).toBeGreaterThan(0);
      await browser.waitUntil(async () => !(await shellAlive(pid)), {
        timeout: 15_000,
        timeoutMsg: `${CASE}: orphan shell ${pid} survived owner end`,
      });
    };
    await page.reload();
    await waitForShellExit(reopenedPid);
    // 刷新会恢复当前会话，不能等待只在首页显示的任务列表。
    await page.locator('[data-mobile-page="chat"]').waitFor();
    await openMobileTerminal(page);
    evidence.mobileAfterRefresh = await runMobileCommand(page, "MOBILE_AFTER_REFRESH", workspace);
    const refreshedPid = Number(String(evidence.mobileAfterRefresh).match(/PTY_OWNER=(\d+)/u)?.[1]);
    expect(refreshedPid).not.toBe(reopenedPid);
    // CR-01 短断线：在线时 relay 连接断开，桌面从此刻计 3 秒宽限；手机在宽限内重新 matched，
    // 原 owner 与 PTY 必须保留。打散等待取窗口上限附近，窗口大于宽限时旧 shell 会被回收。
    await page.evaluate(() => Reflect.get(window, "__mro04ForceHighRandom")(true));
    const shortDisconnectAt = Date.now();
    const shortClosed = await page.evaluate(() =>
      Number(Reflect.get(window, "__mro04DisconnectRelay")()),
    );
    expect(shortClosed).toBeGreaterThan(0);
    await browser.waitUntil(async () => pairedAt.some((at) => at > shortDisconnectAt), {
      timeout: 20_000,
      timeoutMsg: `${CASE}: mobile did not re-pair after short disconnect`,
    });
    await page.evaluate(() => Reflect.get(window, "__mro04ForceHighRandom")(false));
    const repairedMs = pairedAt.find((at) => at > shortDisconnectAt)! - shortDisconnectAt;
    // 等过 3 秒宽限再检查，宽限回调迟到的回收也要暴露。
    await browser.pause(Math.max(0, shortDisconnectAt + 4_500 - Date.now()));
    if (!(await shellAlive(refreshedPid)))
      throw new Error(
        `${CASE}: short disconnect reclaimed shell ${refreshedPid} (${repairedMs}ms)`,
      );
    evidence.mobileAfterShortDisconnect = await runMobileCommand(
      page,
      "MOBILE_AFTER_SHORT_DISCONNECT",
      workspace,
    );
    const shortPids = [
      ...String(evidence.mobileAfterShortDisconnect).matchAll(/PTY_OWNER=(\d+)/gu),
    ];
    expect(Number(shortPids.at(-1)?.[1])).toBe(refreshedPid);
    evidence.shortDisconnect = { closedSockets: shortClosed, repairedMs, pid: refreshedPid };
    await context.setOffline(true);
    const closedSockets = await page.evaluate(() => {
      const disconnect = Reflect.get(window, "__mro04DisconnectRelay");
      if (typeof disconnect !== "function") throw new Error("Relay fault fixture is missing");
      return Number(disconnect());
    });
    expect(closedSockets).toBeGreaterThan(0);
    await waitForShellExit(refreshedPid);
    await context.setOffline(false);
    // owner 已结束，原标签重挂也必须建立新 PTY，而非继续使用失效 ID。
    await page.waitForFunction(
      () => {
        const rows = [
          ...document.querySelectorAll<HTMLElement>(".terminal-xterm-shell .xterm-rows"),
        ]
          .filter((row) => row.checkVisibility())
          .map((row) => row.textContent ?? "")
          .join("\n");
        return /[$#>%]\s*$/u.test(rows) && !rows.includes("E2E_MRO04_MOBILE_AFTER_REFRESH");
      },
      undefined,
      { timeout: 30_000 },
    );
    evidence.mobileAfterDisconnect = await runMobileCommand(
      page,
      "MOBILE_AFTER_DISCONNECT",
      workspace,
    );
    const reconnectedPid = Number(
      String(evidence.mobileAfterDisconnect).match(/PTY_OWNER=(\d+)/u)?.[1],
    );
    expect(reconnectedPid).not.toBe(refreshedPid);
    if (artifacts) await page.screenshot({ path: join(artifacts, "MRO04-mobile-owner.png") });
    await context.close();
    await waitForShellExit(reconnectedPid);
    evidence.mobilePidsReclaimed = [reopenedPid, refreshedPid, reconnectedPid];
    // 旧客户端仍走真实 relay/attachment，只省略尚未支持的页面 ID 字段。
    const legacyContext = await webBrowser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      recordVideo: { dir: artifacts, size: { width: 390, height: 844 } },
    });
    await legacyContext.addInitScript((credentials) => {
      for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
    }, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
    const legacyPage = await legacyContext.newPage();
    mobilePage = legacyPage;
    await legacyPage.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/u, (route) => {
      const server = route.connectToServer();
      route.onMessage((message) => {
        const frame = JSON.parse(String(message)) as { payload?: Record<string, unknown> };
        if (
          frame.payload?.zcode_type === "bootstrap-request" ||
          frame.payload?.zcode_type === "workspace-bridge-open"
        ) {
          delete frame.payload.terminalClientSessionId;
          server.send(JSON.stringify(frame));
        } else server.send(message);
      });
      server.onMessage((message) => route.send(message));
    });
    await openMobilePairingPage(legacyPage, pairingUrl, {
      artifactDir: artifacts,
      caseMarker: CASE,
      phase: "legacy",
      readySelector: `${projectSelector}:visible, [data-mobile-page="chat"]:visible >> nth=0`,
    });
    if (!(await legacyPage.locator('[data-mobile-page="chat"]').isVisible())) {
      const toggle = legacyPage.locator(projectSelector).getByTestId("virtual-project-toggle");
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.tap();
      await legacyPage.getByTestId(testId(TID_TASK_ITEM, taskId)).first().tap();
    }
    await legacyPage.locator('[data-mobile-page="chat"]').waitFor();
    await openMobileTerminal(legacyPage);
    evidence.legacyTerminal = await runMobileCommand(legacyPage, "LEGACY", workspace);
    const legacyPid = Number(String(evidence.legacyTerminal).match(/PTY_OWNER=(\d+)/u)?.[1]);
    await legacyPage.screenshot({ path: join(artifacts, "MRO04-legacy-before-close.png") });
    await legacyContext.close();
    await waitForShellExit(legacyPid);
    evidence.legacyPidReclaimed = legacyPid;
    evidence.bridges = bridges.map(({ bridgeSessionId, bridge }) => ({
      bridgeSessionId,
      owner: bridge.terminalOwnerId,
      workspace: bridge.workspaceKey,
    }));
    if (remote) {
      // 一个 Renderer 承载多个 workspace；仅切换窗口不会切回原本地终端。
      await selectV4TaskById(localTaskId);
      await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    }
    expect(await desktopText()).toContain("E2E_MRO04_DESKTOP_BEFORE");
    expect(await desktopText()).not.toContain("E2E_MRO04_MOBILE_FIRST");
    await runDesktopCommand("DESKTOP_AFTER");
    evidence.desktopAfter = await desktopText();
    await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`).click();
    await browser.waitUntil(async () =>
      (await desktopText(true)).includes("E2E_MRO04_DESKTOP_SIDE_BEFORE"),
    );
    await runDesktopCommand("DESKTOP_SIDE_AFTER", true);
    evidence.desktopSideAfter = await desktopText(true);
    const desktopOwners = [...String(evidence.desktopSideAfter).matchAll(/PTY_OWNER=(\d+)/gu)];
    expect(desktopOwners.length).toBeGreaterThanOrEqual(2);
    expect(desktopOwners.at(-1)?.[1]).toBe(desktopOwners[0]?.[1]);
    await browser.saveScreenshot(join(artifacts, "MRO04-desktop.png"));
  });

  it("已回收终端的迟到订阅被拒绝，真实 Host 和原桌面终端继续工作", async function () {
    this.timeout(90_000);
    if (!artifacts) throw new Error(`${CASE}: isolated artifacts required`);
    await prepareV4ConversationE2E({ skipProvider: true });
    await switchToWorkspaceRendererWindow(DEFAULT_WORKSPACE, 30_000);
    if (!(await $(`[data-testid="${TID_TERMINAL}"]`).isDisplayed())) {
      await $(`[data-testid="${TID_TERMINAL_TOGGLE}"]`).click();
    }
    await browser.waitUntil(async () => /[$#>%]\s*$/u.test(await desktopText()), {
      timeout: 30_000,
    });
    await runDesktopCommand("RPC_BEFORE");
    const before = await desktopText();
    await installHandoffRpcProbe();
    const terminal = await callHandoffHost<{ id: string }>(ServiceChannels.Terminal, "create", [
      {
        cols: 80,
        rows: 24,
        cwd: DEFAULT_WORKSPACE,
      },
    ]);
    await callHandoffHost(ServiceChannels.Terminal, "dispose", [{ id: terminal.id }]);
    // 经真实协议端口重放已释放终端的订阅；修复前该同步拒绝会退出整个 Host。
    const writer = new BufferWriter();
    serialize(writer, [102, -45000, ServiceChannels.Terminal, "onDynamicData"]);
    serialize(writer, terminal.id);
    const prefix = new BufferWriter();
    serialize(prefix, [205, -45000]);
    const bytes = await browser.execute(
      (request, responsePrefix) =>
        window.__remoteProjectHandoffRpc!.call(request, [responsePrefix]),
      Array.from(writer.buffer.buffer),
      Array.from(prefix.buffer.buffer),
    );
    const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(bytes)));
    expect(deserialize(reader)).toEqual([205, -45000]);
    const failure = deserialize(reader) as { message: string };
    expect(failure.message).toMatch(/not found|ended|does not own/iu);
    await runDesktopCommand("RPC_AFTER");
    const after = await desktopText();
    const pids = [...after.matchAll(/PTY_OWNER=(\d+)/gu)];
    expect(pids.at(-1)?.[1]).toBe(before.match(/PTY_OWNER=(\d+)/u)?.[1]);
    evidence.lateSubscription = { rejected: failure.message, before, after };
    await browser.saveScreenshot(join(artifacts, "MRO04-late-subscription-host-alive.png"));
  });
});
