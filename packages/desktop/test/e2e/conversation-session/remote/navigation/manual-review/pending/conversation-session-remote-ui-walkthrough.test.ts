import { startProjectPointerDrag } from "#e2e/helpers/project-sidebar";
import { createStallableTcpProxy } from "#e2e/helpers/ssh-stallable-proxy";
import { requestRemoteProjectConnection } from "#e2e/helpers/remote-project-actions";
/* eslint-disable max-lines -- 走查 spec 按真实用户顺序串起向导、侧栏、设置的全部状态，拆散会丢失截图编号的连续性。 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_VIRTUAL_PROJECT_ADD,
  TID_REMOTE_KIND_DOCKER,
  TID_REMOTE_KIND_SSH,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SSH_AUTH_PASSWORD,
  TID_SSH_AUTH_PRIVATE_KEY,
  TID_SSH_DIALOG,
  TID_SSH_ERROR,
  TID_SSH_SUCCESS,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  hoverTestIdByWebDriver,
  DEFAULT_WORKSPACE,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { startElectronWindowRecording } from "#e2e/helpers/electron-window-recorder";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  selectTaskOrganizeMode,
  openWorkspaceDraftFromSidebar,
} from "#e2e/helpers/workspace-agent-warmup";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
  openRemoteConnectionSelection,
  connectSSHWorkspace,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  waitForSSHError,
} from "#e2e/helpers/ssh-remote-p0";

/**
 * 远程连接 UI 走查：不是断言型用例，而是在真实 SSH 容器上按用户顺序走完向导、侧栏、
 * 设置页的全部可见状态，产出编号截图（浅/深色）、全程录屏和一份 index.json 目录。
 * 断言只保留“流程确实到达了该状态”，避免走查因为文案微调而中断。
 */
const MARKER = "E2E_REMOTE_UI_WALKTHROUGH";
const artifact = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-ui-walkthrough",
);
const dialog = `[data-testid="${TID_SSH_DIALOG}"]`;
const run = promisify(execFile);

interface CaptureEntry {
  error?: string;
  files: string[];
  step: string;
  title: string;
}
const index: CaptureEntry[] = [];
let sequence = 0;
const nextStep = () => String(++sequence).padStart(2, "0");

async function settle() {
  await browser.executeAsync((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 120))),
  );
}

async function setTheme(theme: "light" | "dark") {
  await browser.execute((value) => {
    const actions = (window as Window & { __testActions?: { setTheme(value: string): void } })
      .__testActions;
    if (!actions) throw new Error("Missing theme test actions");
    actions.setTheme(value);
  }, theme);
}

/** 同一状态各截一张浅色和深色；截完切回浅色，让录屏主线保持浅色。 */
async function capture(name: string, title: string) {
  const step = nextStep();
  const files: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    await setTheme(theme);
    await settle();
    const file = `${step}-${name}-${theme}.png`;
    await browser.saveScreenshot(resolve(artifact, file));
    files.push(file);
  }
  await setTheme("light");
  await settle();
  index.push({ step, title, files });
}

/** 连接进行中的实时帧：按固定间隔连拍直到条件满足，保留过程而不是只留结果。 */
async function captureFrames(
  name: string,
  title: string,
  until: () => Promise<boolean>,
  options: { intervalMs?: number; timeoutMs: number },
) {
  const step = nextStep();
  const files: string[] = [];
  const started = Date.now();
  let satisfied = false;
  while (Date.now() - started < options.timeoutMs) {
    const file = `${step}-${name}-f${String(files.length + 1).padStart(3, "0")}.png`;
    await browser.saveScreenshot(resolve(artifact, file));
    files.push(file);
    if (await until()) {
      satisfied = true;
      break;
    }
    await browser.pause(options.intervalMs ?? 600);
  }
  index.push({ step, title: `${title}（${files.length} 帧）`, files });
  if (!satisfied) throw new Error(`${MARKER}: ${title} 未到达目标状态`);
}

async function openDeviceMenu() {
  await $('[data-source-server-card] button[aria-label="更多"]').click();
  await $('[role="menu"]').waitForDisplayed();
}

async function clickButton(label: string | RegExp, root = dialog) {
  const pattern = label instanceof RegExp ? label.source : null;
  await browser.waitUntil(
    () =>
      browser.execute(
        (scope, text, source) => {
          const matcher = source ? new RegExp(source, "u") : null;
          // 菜单项是 role=menuitem 的 div，不是 button；统一按可点击项匹配。
          const button = Array.from(
            document
              .querySelector(scope)
              ?.querySelectorAll<HTMLElement>('button, [role="menuitem"]') ?? [],
          ).find((item) => {
            const disabled =
              (item as HTMLButtonElement).disabled ||
              item.getAttribute("aria-disabled") === "true" ||
              item.hasAttribute("data-disabled");
            if (!item.getClientRects().length || disabled) return false;
            const content = item.textContent?.trim() ?? "";
            const aria = item.getAttribute("aria-label") ?? "";
            // 字符串只做精确匹配：「连接」不能误中「编辑连接」，「取消」不能误中「取消连接」。
            return matcher
              ? matcher.test(content) || matcher.test(aria)
              : content === text || aria === text;
          });
          if (!button) return false;
          button.click();
          return true;
        },
        root,
        typeof label === "string" ? label : null,
        pattern,
      ),
    { timeout: 30_000, timeoutMsg: `${MARKER}: 找不到按钮 ${String(label)}（${root}）` },
  );
}

async function hasButton(label: string, root = dialog) {
  return browser.execute(
    (scope, text) =>
      Array.from(
        document.querySelector(scope)?.querySelectorAll<HTMLElement>('button, [role="menuitem"]') ??
          [],
      ).some(
        (item) =>
          item.getClientRects().length > 0 &&
          (item.textContent?.trim() === text || item.getAttribute("aria-label") === text),
      ),
    root,
    label,
  );
}

async function openProjectAddMenu() {
  await selectTaskOrganizeMode(["项目", "Project"]);
  await hoverTestIdByWebDriver("project-section");
  await clickTestIdByDom(TID_VIRTUAL_PROJECT_ADD);
  await $('[role="dialog"]').waitForDisplayed();
}

async function openSelection() {
  await openRemoteConnectionSelection();
}

async function closeDialog() {
  if (await $(dialog).isExisting()) {
    await clickButton("关闭");
    await $(dialog).waitForExist({ reverse: true, timeout: 10_000 });
  }
}

async function openSettingsRemoteDevices() {
  if (!(await $('[data-testid="settings-page"]').isDisplayed())) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  }
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
  await $("[data-settings-content-frame]").waitForDisplayed();
}

async function backToWorkspace() {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  await $("[data-settings-content-frame]").waitForExist({ reverse: true, timeout: 10_000 });
}

async function rowState(identity: string) {
  return browser.execute(
    (key) =>
      document.querySelector<HTMLElement>(`[data-project-workspace-identity="${key}"]`)?.dataset
        .connectionState ?? null,
    identity,
  );
}

async function openProjectActions(identity: string) {
  const row = $(`[data-project-workspace-identity="${identity}"]`);
  await row.$('[data-testid="virtual-project-toggle"]').moveTo();
  await row.$('[data-testid="virtual-project-menu"]').click();
  await $('[role="menu"]').waitForDisplayed();
}

async function closePopover() {
  await browser.keys("Escape");
  await browser.pause(300);
}

/** 段落失败后把界面收回到工作区，让后续段落还能继续截图。 */
async function recover() {
  await browser.keys("Escape");
  await browser.pause(300);
  if (await $(dialog).isExisting()) {
    if (await hasButton("稍后选择")) await clickButton("稍后选择").catch(() => undefined);
    await closeDialog().catch(() => undefined);
  }
  if (await $("[data-settings-content-frame]").isExisting()) {
    await backToWorkspace().catch(() => undefined);
  }
}

/** 走查段落彼此独立：一个段落失败只记一条失败条目并截图，不中断整条走查。 */
async function segment(key: string, title: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).slice(0, 300);
    const step = nextStep();
    const file = `${step}-FAILED-${key}.png`;
    await browser.saveScreenshot(resolve(artifact, file)).catch(() => undefined);
    index.push({
      step,
      title: `【段落失败】${title}：${detail}`,
      error: detail,
      files: [file],
    });
    await recover().catch(() => undefined);
  }
}

/** 找一个当前没有监听者的本地端口，用来制造“无法连接到主机”。 */
async function closedPort() {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing unused port");
  await new Promise<void>((done, reject) =>
    listener.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

/** 只接受 TCP、不回 SSH banner 的桩，用来稳定停留在“连接中”。 */
async function startStallServer() {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", yes);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing stall port");
  return {
    port: address.port,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((yes) => server.close(() => yes()));
    },
  };
}

/** 只允许操作本用例专属、带 r3-server 标签的目标容器，绝不碰共享的开发容器。 */
async function ownedContainer(): Promise<string | null> {
  const name = process.env.ZCODE_E2E_SSH_CONTAINER?.trim();
  if (!name || !/^zcode-r3-server-[a-z0-9-]+$/u.test(name)) return null;
  try {
    const { stdout } = await run("docker", [
      "inspect",
      "--format",
      '{{index .Config.Labels "zcode.e2e.run"}}',
      name,
    ]);
    return stdout.trim() === "r3-server" ? name : null;
  } catch {
    return null;
  }
}

async function waitForTcpPort(host: string, port: number, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise<boolean>((done) => {
      const socket = connect({ host, port });
      socket.setTimeout(1500);
      socket.once("connect", () => {
        socket.destroy();
        done(true);
      });
      socket.once("error", () => done(false));
      socket.once("timeout", () => {
        socket.destroy();
        done(false);
      });
    });
    if (ok) return;
    await new Promise((tick) => setTimeout(tick, 1000));
  }
  throw new Error(`${MARKER}: ${host}:${port} 在 ${timeoutMs}ms 内没有重新可达`);
}

describe(`${MARKER}: 远程连接 UI 走查`, () => {
  let transportProxy: Awaited<ReturnType<typeof createStallableTcpProxy>> | undefined;
  after(async () => {
    await transportProxy?.close();
    transportProxy = undefined;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RDUX-WALKTHROUGH 按用户顺序截取向导、侧栏、设置的全部状态并录屏", async function () {
    this.timeout(30 * 60_000);
    await mkdir(artifact, { recursive: true });
    const direct = readSSHRuntimeConfig(MARKER);
    // Docker 动态发布端口在 stop/start 后会改变；稳定监听端口由代理独占，应用线路保持不变。
    const endpoint = { host: direct.host, port: direct.port };
    const backendPorts = [endpoint.port];
    transportProxy = await createStallableTcpProxy(endpoint);
    const config = { ...direct, host: "127.0.0.1", port: transportProxy.port };
    const workspacePath = config.workspacePaths[0]!;
    await prepareSSHConnectionPage(MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    // 不做 refresh：刷新后 waitForWorkspaceApp 在本机曾停留 2 分钟未就绪，而走查不依赖侧栏宽度持久化。
    await browser.execute(() => {
      (
        window as Window & { __testActions?: { setLocale(value: "zh-CN"): void } }
      ).__testActions?.setLocale("zh-CN");
    });
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
    await browser.electron.execute((electron) => {
      const window = electron.BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      window?.setMinimumSize(360, 600);
      window?.setSize(1400, 1000);
    });
    await setTheme("light");
    await settle();
    // 指针停在角落，避免悬停入口影响截图。
    await browser.performActions([
      {
        type: "pointer",
        id: "park",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", x: 2, y: 2, duration: 0 }],
      },
    ]);

    const recording = await startElectronWindowRecording({
      browser,
      frameIntervalMs: 500,
      outputPath: resolve(artifact, "remote-ui-walkthrough.webm"),
      encodeTimeoutMs: 5 * 60_000,
      stopTimeoutMs: 5 * 60_000,
    });
    const stall = await startStallServer();
    const container = await ownedContainer();
    let containerStopped = false;

    try {
      // ---------- 设置：按类型添加与连接反馈 ----------
      await openProjectAddMenu();
      await capture("project-add-menu", "侧栏「添加项目」：选择本机或远程设备");
      await browser.keys("Escape");
      await openSelection();
      await $(`${dialog} [data-testid="ssh-host-input"]`).waitForDisplayed();
      await capture("selection-empty", "设置新建：默认 SSH 分类表单");

      await clickTestIdByDom(TID_REMOTE_KIND_DOCKER);
      await $(`${dialog} [data-testid="docker-container-input"]`).waitForDisplayed();
      await capture("docker-manual-form", "手动输入 Docker 容器的表单");
      await clickTestIdByDom(TID_REMOTE_KIND_SSH);
      await $(`${dialog} [data-testid="ssh-host-input"]`).waitForDisplayed();
      await capture("ssh-form-empty", "新建 SSH 连接：空表单");
      await fillSSHPasswordSettings(config);
      await clickTestIdByDom(TID_SSH_AUTH_PRIVATE_KEY);
      await settle();
      await capture("ssh-form-private-key", "SSH 表单：切换到私钥认证");
      await clickTestIdByDom(TID_SSH_AUTH_PASSWORD);
      await fillSSHPasswordSettings(config);
      await clickButton("高级选项");
      await settle();
      await capture(
        "ssh-form-filled-advanced",
        "SSH 表单：已填写，展开高级选项（资源下载方式默认本地下载后上传）",
      );

      await clickLastEnabledSSHDialogButton(MARKER);
      const installVisible = () => hasButton("安装并继续");
      const boundary = $('[data-testid="source-server-boundary-dialog"]');
      await captureFrames(
        "connecting-first",
        "向导第 2 屏：首次连接，时间线逐步推进直到需要确认安装",
        async () =>
          (await installVisible()) ||
          (await boundary.isDisplayed()) ||
          !(await $(dialog).isExisting()),
        { timeoutMs: 120_000, intervalMs: 500 },
      );
      if (await installVisible()) {
        await capture("install-confirm", "首次连接：新设备需要安装 ZCode Server 的确认卡");
        await clickButton(/^连接日志/u);
        await settle();
        await capture("install-confirm-log-expanded", "安装确认 + 展开连接日志");
        await clickButton("安装并继续");
        await captureFrames(
          "installing",
          "安装并启动 ZCode Server 的实时进度",
          async () => (await boundary.isDisplayed()) || !(await $(dialog).isExisting()),
          { timeoutMs: 240_000, intervalMs: 700 },
        );
      }
      // 新版首次介绍必须真实确认；旧走查只等向导消失，会把已完成安装误报为超时。
      await boundary.waitForDisplayed();
      await capture("boundary-introduction", "首次远程连接：介绍页等待明确确认");
      await boundary.$(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`).click();
      await boundary.waitForDisplayed({ reverse: true });
      expect(await waitForSSHDirectoryStep(MARKER)).toBe("closed");
      await capture("device-first-added", "设置：添加完成并定位设备，不打开目录");
      await backToWorkspace();
      await connectSSHWorkspace({ config, workspacePath, caseMarker: MARKER });
      const tab = await waitForRemoteTab({ caseMarker: MARKER, expectedPath: workspacePath });
      const identity = tab.workspaceIdentity!;
      await browser.waitUntil(async () => (await rowState(identity)) === "online", {
        timeout: 30_000,
      });
      await settle();
      await capture("workspace-online", "远程项目已打开：侧栏项目行（已连接）+ 空会话");

      // ---------- 侧栏 ----------
      await openProjectActions(identity);
      await capture(
        "sidebar-details-online",
        "侧栏在线项目操作：追加项目 / 编辑 / 置顶 / 删除 / 移除入口",
      );
      await closePopover();
      const row = $(`[data-project-workspace-identity="${identity}"]`);
      await row.$('[data-testid="virtual-project-toggle"]').moveTo();
      await row.$('button[aria-label="更多"]').click();
      await $('[role="menu"]').waitForDisplayed();
      await capture("sidebar-more-menu", "侧栏项目行「更多」菜单");
      await closePopover();
      await openProjectAddMenu();
      await capture("project-add-menu-devices", "添加项目入口：选择所属设备");
      await browser.keys("Escape");
      await browser.keys("Escape");

      await openSettingsRemoteDevices();
      // RDUX-13：编辑与断开在设备行「更多」菜单里。
      await openDeviceMenu();
      await clickButton("编辑", '[role="menu"]');
      const editor = '[role="dialog"][data-slot="dialog-content"]';
      await $(editor).waitForDisplayed();
      await capture("edit-connection-dialog", "设置页编辑连接对话框");
      await clickButton("取消", editor);
      await $(editor).waitForExist({ reverse: true });

      // ---------- 设置：重复添加已在线目标复用设备 ----------
      await openSelection();
      await capture("add-with-saved-device", "已有设备时，新建仍直接进入默认 SSH 分类表单");
      expect(await $(`${dialog} input[type="search"]`).isExisting()).toBe(false);
      await fillSSHPasswordSettings(config);
      await clickLastEnabledSSHDialogButton(MARKER);
      expect(await waitForSSHDirectoryStep(MARKER)).toBe("closed");
      await settle();
      await capture("manual-reuse", "手动填写已在线目标：复用连接并留在设置");

      // ---------- 设置页 ----------
      await openSettingsRemoteDevices();
      await $("[data-source-server-card]").waitForDisplayed();
      await capture("settings-card-online", "设置 · 远程设备：设备行（已连接）与连接偏好");
      // 最近日志在设备行展开区。
      const toggle = $("[data-source-server-card] [data-source-server-toggle]");
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await $("[data-source-server-card] [data-source-server-log-toggle]").click();
      await $("[data-source-server-log-timestamp]").waitForDisplayed();
      await capture("settings-card-logs", "设备卡：展开最近日志");
      await $('[data-source-server-card] button[aria-label="更多"]').click();
      await $("[data-device-info]").waitForDisplayed();
      await capture(
        "settings-card-more-menu",
        "设备卡「更多」菜单：设备信息 / 在侧边栏中显示 / 复制设备 ID / 移除设备",
      );
      await clickButton("移除设备", '[role="menu"]');
      await $('[role="dialog"]').waitForDisplayed();
      await capture("settings-remove-confirm", "移除设备确认框（截图后按 Esc 取消）");
      // 确认框的取消按钮带 esc 快捷键后缀，直接按 Esc 关闭，绝不点确认。
      await browser.keys("Escape");
      await $('[role="dialog"]').waitForExist({ reverse: true });
      await openDeviceMenu();
      await clickButton("编辑", '[role="menu"]');
      await $(editor).waitForDisplayed();
      await capture("settings-edit-dialog", "设备卡「编辑」对话框");
      await clickButton("取消", editor);
      await $(editor).waitForExist({ reverse: true });
      await openDeviceMenu();
      // 断开菜单项内带任务继续提示，按前缀匹配。
      await clickButton(/^断开/u, '[role="menu"]');
      await $(
        '[data-source-server-card] [data-remote-connection-status="offline"]',
      ).waitForDisplayed({ timeout: 30_000 });
      await settle();
      await capture("settings-card-offline", "设备卡（未连接）：最近在线与「连接」入口");

      // ---------- 断线后的会话与侧栏 ----------
      await backToWorkspace();
      await browser.waitUntil(async () => (await rowState(identity)) === "offline", {
        timeout: 30_000,
      });
      await settle();
      await capture("conversation-disconnected", "断开后：侧栏项目行（未连接）与会话区断线占位");
      await openProjectActions(identity);
      await capture("sidebar-details-offline", "侧栏离线项目操作：连接 / 移除入口");
      await clickButton("连接", '[role="menu"]');
      await captureFrames(
        "reconnecting",
        "从侧栏重连：连接中状态直到恢复在线",
        async () => (await rowState(identity)) === "online",
        { timeoutMs: 120_000, intervalMs: 600 },
      );
      if (await $(dialog).isExisting()) {
        if (await $(`${dialog} [data-testid="${TID_SSH_SUCCESS}"]`).isExisting()) {
          await clickButton("稍后选择");
        }
        await closeDialog();
      }
      await settle();
      await capture("workspace-reconnected", "重连完成：项目恢复在线");

      // ---------- 失败态：无法连接 / 认证失败 ----------
      await segment("unreachable", "主机不可达失败态", async () => {
        await openSelection();
        await clickTestIdByDom(TID_REMOTE_KIND_SSH);
        await fillSSHPasswordSettings({ ...config, host: "127.0.0.1", port: await closedPort() });
        await clickLastEnabledSSHDialogButton(MARKER);
        await waitForSSHError(MARKER, 90_000);
        await settle();
        await capture("failed-unreachable", "连接失败：主机不可达（错误卡 + 建议操作）");
        await closeDialog();
      });
      await segment("auth", "SSH 认证失败态", async () => {
        // 同一 user@host:port 在线时向导会直接复用连接，密码根本不会被校验；
        // 换一个不存在的用户名才能真正触发 SSH 认证失败。
        await openSelection();
        await clickTestIdByDom(TID_REMOTE_KIND_SSH);
        await fillSSHPasswordSettings({
          ...config,
          username: `${config.username}-nobody`,
          password: `${config.password}-wrong`,
        });
        await clickLastEnabledSSHDialogButton(MARKER);
        await waitForSSHError(MARKER, 120_000);
        await settle();
        await capture("failed-auth", "连接失败：SSH 认证失败（应提供「修改密码或私钥」）");
        if (await hasButton("修改密码或私钥")) {
          await clickButton("修改密码或私钥");
          await $(`${dialog} [data-testid="ssh-host-input"]`).waitForDisplayed();
          await settle();
          await capture("failed-auth-edit", "点击「修改密码或私钥」回到表单");
        }
        await closeDialog();
      });

      // ---------- 取消与后台继续 ----------
      await segment("cancel", "连接中取消", async () => {
        await openSelection();
        await clickTestIdByDom(TID_REMOTE_KIND_SSH);
        await fillSSHPasswordSettings({ ...config, host: "127.0.0.1", port: stall.port });
        await clickLastEnabledSSHDialogButton(MARKER);
        await browser.waitUntil(() => stall.sockets.size > 0, { timeout: 30_000 });
        await settle();
        await capture("connecting-pending", "连接中（对端不响应）：可取消或在后台继续");
        await clickButton("取消连接");
        await browser
          .waitUntil(async () => (await $(dialog).getText()).includes("已取消"), {
            timeout: 30_000,
          })
          .catch(() => undefined);
        await settle();
        await capture("cancelled", "已取消：保留目标，可重试");
        await closeDialog();
        for (const socket of stall.sockets) socket.destroy();
      });

      await segment("minimized", "在后台继续与后台失败", async () => {
        await openSelection();
        await clickTestIdByDom(TID_REMOTE_KIND_SSH);
        await fillSSHPasswordSettings({ ...config, host: "127.0.0.1", port: stall.port });
        await clickLastEnabledSSHDialogButton(MARKER);
        await browser.waitUntil(() => stall.sockets.size > 0, { timeout: 30_000 });
        await clickButton(/在后台继续|收起/u);
        // 后台进度已由设置页承接；限定真实承接位置，避免全局同名卡片让旧侧栏覆盖说明误报通过。
        const background = $(
          '[data-settings-content-frame] [data-testid="remote-connection-minimized"]',
        );
        await background.waitForDisplayed();
        await settle();
        await capture("minimized-connecting", "在后台继续：设置页未完成连接显示进度");
        for (const socket of stall.sockets) socket.destroy();
        await browser.waitUntil(async () => /失败|failed/iu.test(await background.getText()), {
          timeout: 90_000,
        });
        await $(dialog).waitForDisplayed({ reverse: true, timeout: 5_000 });
        await settle();
        await capture("minimized-failed", "后台连接失败：设置进度项保留失败，不自动弹回");
        await background.click();
        await $(`${dialog} [data-testid="${TID_SSH_ERROR}"]`).waitForDisplayed();
        await settle();
        await capture("reopened-failed", "点击卡片恢复向导：失败详情");
        await closeDialog();
      });

      await segment("unfinished", "设置页未完成的连接", async () => {
        await openSettingsRemoteDevices();
        const unfinished = $("[data-unfinished-connections]");
        if (await unfinished.isExisting()) {
          await $("[data-unfinished-connections] summary").click();
          await settle();
          await capture("settings-unfinished", "设置 · 未完成的连接（失败的新目标不生成设备卡）");
          await clickButton("清理全部", "[data-unfinished-connections]");
          await $('[role="dialog"]').waitForDisplayed();
          await capture("settings-clear-all-confirm", "清理全部确认框（截图后按 Esc 取消）");
          await browser.keys("Escape");
          await $('[role="dialog"]').waitForExist({ reverse: true });
        }
        await backToWorkspace();
      });

      // ---------- 真实掉线：停止专属容器，观察自动恢复与失败 ----------
      if (container) {
        await segment("container", "停止远端容器后的掉线与恢复", async () => {
          transportProxy!.setRejectNewConnections(true);
          await run("docker", ["stop", container]);
          containerStopped = true;
          await captureFrames(
            "connection-lost",
            "远端被停止后：侧栏项目从已连接进入自动恢复 / 需要处理 / 连接失败",
            async () => ["failed", "pending", "offline"].includes((await rowState(identity)) ?? ""),
            { timeoutMs: 180_000, intervalMs: 1_000 },
          );
          await settle();
          await capture(
            "sidebar-after-loss",
            `掉线后的侧栏项目行（状态：${await rowState(identity)}）`,
          );
          await openProjectActions(identity);
          await capture("sidebar-details-after-loss", "掉线后的项目操作菜单");
          await closePopover();
          await run("docker", ["start", container]);
          containerStopped = false;
          const published = await run("docker", ["port", container, "22/tcp"]);
          const port = Number(/^127\.0\.0\.1:(\d+)$/mu.exec(published.stdout)?.[1]);
          if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw new Error("专属容器重启后缺少 loopback SSH 端口");
          endpoint.port = port;
          backendPorts.push(port);
          await waitForTcpPort(endpoint.host, endpoint.port, 60_000);
          transportProxy!.setRejectNewConnections(false);
          if ((await rowState(identity)) !== "online") {
            await requestRemoteProjectConnection(identity, MARKER);
          }
          // 如当前连接流程要求重试，继续走用户可见入口。
          if ((await $(dialog).isExisting()) && (await hasButton("重试"))) {
            await settle();
            await capture(
              "recovering-failed-detail",
              "远端恢复后点击失败项目：先看到上次失败详情与「重试」",
            );
            await clickButton("重试");
          }
          await captureFrames(
            "recovering",
            "远端恢复后点击项目：重新连接直到在线",
            async () => (await rowState(identity)) === "online",
            { timeoutMs: 180_000, intervalMs: 800 },
          );
          if (await $(dialog).isExisting()) {
            if (await $(`${dialog} [data-testid="${TID_SSH_SUCCESS}"]`).isExisting()) {
              await clickButton("稍后选择");
            }
            await closeDialog();
          }
          await settle();
          await capture("workspace-recovered", "远端恢复后项目重新在线");
        });
      }

      // ---------- 拖拽预览 ----------
      await segment("drag", "拖拽预览", async () => {
        const dragSelector = `[data-project-workspace-identity="${identity}"] [data-testid="virtual-project-toggle"]`;
        const position = await startProjectPointerDrag(dragSelector);
        await browser.waitUntil(
          () =>
            browser.execute(
              (selector, top) =>
                Math.abs(document.querySelector(selector)!.getBoundingClientRect().top - top) >= 6,
              dragSelector,
              position.top,
            ),
          { timeout: 5000, timeoutMsg: "项目拖拽没有产生可见位移" },
        );
        await $(
          `[data-project-workspace-identity="${identity}"] [data-testid="project-device"]`,
        ).waitForDisplayed();
        const step = nextStep();
        await browser.saveScreenshot(resolve(artifact, `${step}-drag-device-light.png`));
        index.push({
          step,
          title: "拖拽项目：移动的项目行保留设备标签",
          files: [`${step}-drag-device-light.png`],
        });
        await browser.keys("Escape");
        await browser.releaseActions();
      });
    } finally {
      if (container && containerStopped)
        await run("docker", ["start", container]).catch(() => undefined);
      await stall.close();
      const video = await recording.stop({ tailDurationMs: 1_000 }).catch((error: unknown) => ({
        videoPath: null,
        error: String(error),
      }));
      if (!video.videoPath)
        index.push({
          step: nextStep(),
          title: "全程录屏失败",
          files: [],
          error: "error" in video ? video.error : "未生成视频",
        });
      await writeFile(
        resolve(artifact, "index.json"),
        JSON.stringify(
          {
            marker: MARKER,
            capturedAt: new Date().toISOString(),
            target: `${config.username}@${config.host}:${config.port}`,
            backendPorts,
            video,
            captures: index,
          },
          null,
          2,
        ),
      );
    }
    // 段落失败可以继续取证，但不能把未完成的交互汇总为 PASS。
    expect(index.filter((entry) => entry.error !== undefined).map((entry) => entry.title)).toEqual(
      [],
    );
  });
});
