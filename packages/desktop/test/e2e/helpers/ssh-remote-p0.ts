import { installHandoffRpcProbe, callHandoffHost } from "#e2e/helpers/remote-project-handoff-probe";
import { selectRemoteProjectDirectory } from "./project-sidebar.js";
/* eslint-disable max-lines -- SSH P0 helper 集中维护真实连接、远端身份、进程与 replay tunnel 生命周期，拆散会隐藏同一条安全边界。 */
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { Client as SSHClient, type ClientChannel, type TcpConnectionDetails } from "ssh2";
import {
  ServiceChannels,
  type SourceServerManagementSnapshot,
  parseRemoteWorkspaceIdentity,
} from "@zcode/shared";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_REMOTE_KIND_SSH,
  TID_VIRTUAL_PROJECT_ADD,
  TID_SSH_DIALOG,
  TID_SSH_ERROR,
  TID_SSH_HOST_INPUT,
  TID_SSH_PASSWORD_INPUT,
  TID_SSH_PORT_INPUT,
  TID_SSH_SUCCESS,
  TID_SSH_USERNAME_INPUT,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  clickTestIdByWebDriver,
  hoverTestIdByWebDriver,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
  waitForWorkspaceApp,
  switchToNewestWindow,
} from "./desktop-app.js";
import { resolveSeededReplayBaseUrl } from "./custom-openai-provider-store.js";

/** 等待首屏后再跳过引导，避免启动时的空 DOM 使旧用例误判“无需处理”。 */
export async function prepareSSHConnectionPage(caseMarker: string): Promise<void> {
  await switchToNewestWindow();
  await browser.waitUntil(
    async () =>
      await browser.execute(() =>
        Boolean(
          document.querySelector(
            '[data-testid="onboarding-page"], [data-testid^="v4-session-pane-"], [data-testid="login-use-api-key-button"]',
          ),
        ),
      ),
    { timeout: 30_000, timeoutMsg: `${caseMarker}: SSH 测试首屏未就绪` },
  );
  if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
}

export const SSH_CONNECT_TIMEOUT_MS = 10 * 60_000;
export const SSH_WORKSPACE_READY_TIMEOUT_MS = 2 * 60_000;
const SSH_CONTROL_HANDSHAKE_TIMEOUT_MS = 30_000;
const SSH_CONTROL_COMMAND_TIMEOUT_MS = 60_000;

export interface SSHConnectionConfig {
  host: string;
  password: string;
  port: number;
  username: string;
}

export interface SSHRuntimeConfig extends SSHConnectionConfig {
  workspacePaths: readonly [string, string];
}

export interface SingleSSHWorkspaceRuntimeConfig extends SSHConnectionConfig {
  workspacePath: string;
}

export interface DualSSHRuntimeConfig {
  targets: readonly [SSHConnectionConfig, SSHConnectionConfig];
  workspacePath: string;
}

export interface RemoteTabSnapshot {
  activeWorkspaceIdentity: string | null;
  activeWorkspacePath: string | null;
  remoteHost: string | null;
  remoteKind: string | null;
  remoteSessionId: string | null;
  secretPersistedInTab: boolean;
  workspaceIdentity: string | null;
  workspacePath: string | null;
}

export interface ReplayTunnel {
  baseURL: string;
  close(): Promise<void>;
}

export interface SSHReplayTunnelOptions {
  username?: string;
  // 让远端监听与本机 replay server 相同的端口号。这样远端 Agent 用本机下发的
  // provider baseURL（http://127.0.0.1:<replayPort>）就能直接命中 replay server，
  // case 不必再自建 provider——给那些沿用默认 replay provider 的 case（share）用。
  mirrorLocalPort?: boolean;
  // 转发本机其他 loopback 服务（例如账号套餐 mock）；缺省转发本轮 replay provider。
  // 容器内的 127.0.0.1 是容器自身，远端读取下发的 mock 地址时必须经此隧道才能命中宿主。
  targetBaseURL?: string;
}

export interface FirstConnectionStallingSSHProxy {
  firstConnectionAccepted: Promise<void>;
  port: number;
  waitForFirstConnectionClosed(): Promise<void>;
  close(): Promise<void>;
}

export async function createFirstConnectionStallingSSHProxy(
  config: Pick<SSHRuntimeConfig, "host" | "port">,
  caseMarker: string,
): Promise<FirstConnectionStallingSSHProxy> {
  let markFirstConnectionAccepted!: () => void;
  const firstConnectionAccepted = new Promise<void>((resolve) => {
    markFirstConnectionAccepted = resolve;
  });
  let markFirstConnectionClosed!: () => void;
  const firstConnectionClosed = new Promise<void>((resolve) => {
    markFirstConnectionClosed = resolve;
  });
  const sockets = new Set<Socket>();
  let connectionCount = 0;
  const trackSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const server = createServer((client) => {
    trackSocket(client);
    connectionCount += 1;
    if (connectionCount === 1) {
      // 第一个 TCP connection 故意不转发 SSH 握手，稳定保留 pending cancel 窗口。
      // Bug 原因：只挂 close 监听不读取 socket，连接会一直停在 paused 状态，客户端
      // banner 与随后的 FIN 都留在内核缓冲里，end/close 永不触发，取消后的关闭事实
      // 就观测不到。这里 resume() 丢弃客户端数据（不转发上游），只为让 FIN 可被观测。
      client.resume();
      markFirstConnectionAccepted();
      client.once("error", () => client.destroy());
      client.once("close", markFirstConnectionClosed);
      return;
    }

    const upstream = createConnection({ host: config.host, port: config.port });
    trackSocket(upstream);
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
  const port = await listenOnLoopback(server, caseMarker);

  return {
    firstConnectionAccepted,
    port,
    waitForFirstConnectionClosed: () => firstConnectionClosed,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    },
  };
}

export function readSSHRuntimeConfig(caseMarker: string): SSHRuntimeConfig {
  const host = requireSecretEnv("ZCODE_E2E_SSH_HOST", caseMarker);
  const username = requireSecretEnv("ZCODE_E2E_SSH_USERNAME", caseMarker);
  const password = requireSecretEnv("ZCODE_E2E_SSH_PASSWORD", caseMarker);
  const portText = process.env.ZCODE_E2E_SSH_PORT?.trim() || "22";
  const port = Number.parseInt(portText, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${caseMarker}: ZCODE_E2E_SSH_PORT 必须是 1..65535 的整数`);
  }

  const workspacePaths = (
    process.env.ZCODE_E2E_SSH_WORKSPACE_PATHS?.split(",") ?? ["/root", "/home"]
  )
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    workspacePaths.length !== 2 ||
    workspacePaths.some((value) => !value.startsWith("/")) ||
    workspacePaths[0] === workspacePaths[1]
  ) {
    throw new Error(`${caseMarker}: ZCODE_E2E_SSH_WORKSPACE_PATHS 必须是两个不同的绝对路径`);
  }

  return {
    host,
    password,
    port,
    username,
    workspacePaths: [workspacePaths[0]!, workspacePaths[1]!],
  };
}

export function readSingleSSHWorkspaceRuntimeConfig(
  caseMarker: string,
): SingleSSHWorkspaceRuntimeConfig {
  const host = requireSecretEnv("ZCODE_E2E_SSH_HOST", caseMarker);
  const username = requireSecretEnv("ZCODE_E2E_SSH_USERNAME", caseMarker);
  const password = requireSecretEnv("ZCODE_E2E_SSH_PASSWORD", caseMarker);
  const port = parseSSHPort(
    process.env.ZCODE_E2E_SSH_PORT?.trim() || "22",
    `${caseMarker}: ZCODE_E2E_SSH_PORT`,
  );
  const workspacePath =
    process.env.ZCODE_E2E_SSH_WORKSPACE_PATH?.trim() ||
    process.env.ZCODE_E2E_SSH_SHARED_WORKSPACE_PATH?.trim() ||
    "/root/workspace";
  if (!workspacePath.startsWith("/")) {
    throw new Error(`${caseMarker}: ZCODE_E2E_SSH_WORKSPACE_PATH 必须是绝对路径`);
  }

  return { host, password, port, username, workspacePath };
}

export function readDualSSHRuntimeConfig(caseMarker: string): DualSSHRuntimeConfig {
  const commonHost = process.env.ZCODE_E2E_SSH_HOST?.trim();
  const commonUsername = process.env.ZCODE_E2E_SSH_USERNAME?.trim();
  const commonPassword = process.env.ZCODE_E2E_SSH_PASSWORD?.trim();
  const workspacePath = process.env.ZCODE_E2E_SSH_SHARED_WORKSPACE_PATH?.trim() || "/workspace";
  if (!workspacePath.startsWith("/")) {
    throw new Error(`${caseMarker}: ZCODE_E2E_SSH_SHARED_WORKSPACE_PATH 必须是绝对路径`);
  }

  const readTarget = (suffix: "A" | "B"): SSHConnectionConfig => {
    const host = process.env[`ZCODE_E2E_SSH_${suffix}_HOST`]?.trim() || commonHost;
    const username = process.env[`ZCODE_E2E_SSH_${suffix}_USERNAME`]?.trim() || commonUsername;
    const password = process.env[`ZCODE_E2E_SSH_${suffix}_PASSWORD`]?.trim() || commonPassword;
    const portText = process.env[`ZCODE_E2E_SSH_${suffix}_PORT`]?.trim();
    if (!host || !username || !password || !portText) {
      throw new Error(`${caseMarker}: dual SSH target ${suffix} 缺少 host/username/password/port`);
    }
    const port = parseSSHPort(portText, `${caseMarker}: target ${suffix}`);
    return { host, password, port, username };
  };

  const targets = [readTarget("A"), readTarget("B")] as const;
  if (
    targets[0].host === targets[1].host &&
    targets[0].port === targets[1].port &&
    targets[0].username === targets[1].username
  ) {
    throw new Error(`${caseMarker}: dual SSH target 必须产生两个不同 remote identity`);
  }
  return { targets, workspacePath };
}

export async function connectSSHWorkspace(options: {
  caseMarker: string;
  config: SSHConnectionConfig;
  workspacePath: string;
}): Promise<RemoteTabSnapshot> {
  await openSSHRemoteDialog(options.caseMarker);
  await fillSSHPasswordSettings(options.config);
  await clickLastEnabledSSHDialogButton(options.caseMarker);
  const flow = await waitForSSHDirectoryStep(options.caseMarker);
  if (flow !== "directory") {
    throw new Error(`${options.caseMarker}: 新设备连接必须先选择项目目录，不能自动进入无项目聊天`);
  }
  await selectSSHRemoteDirectory(options.workspacePath, options.caseMarker);
  await waitForWorkspaceApp(options.workspacePath, SSH_WORKSPACE_READY_TIMEOUT_MS);

  return waitForRemoteTab({
    caseMarker: options.caseMarker,
    expectedPath: options.workspacePath,
  });
}

/** 首连完成后明确选择项目；替代已经停用的 connect-and-chat 前置流程。 */
export async function completeSSHProjectConnection(
  config: SSHRuntimeConfig,
  caseMarker: string,
): Promise<RemoteTabSnapshot> {
  const phase = await waitForSSHDirectoryStep(caseMarker);
  if (phase === "directory") await selectSSHRemoteDirectory(config.workspacePaths[0], caseMarker);
  return waitForRemoteTab({ caseMarker, expectedPath: config.workspacePaths[0] });
}

/** 离线项目没有 composer；统一列表从侧栏全局入口打开。 */
export async function openRemoteProjectSelection(): Promise<void> {
  if (await $('[data-testid="settings-page"]').isDisplayed())
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  if (!(await $('[data-testid="virtual-project-name"]').isDisplayed())) {
    await waitForTestIdByDom("sidebar", { timeout: 30_000 });
    await hoverTestIdByWebDriver("project-section");
    await clickTestIdByWebDriver(TID_VIRTUAL_PROJECT_ADD);
  }
  await clickTestIdByWebDriver("virtual-project-device");
  await $('[role="option"][data-slot="select-item"]').waitForDisplayed();
  await $(
    '//*[@role="option"][normalize-space(.)="添加远程设备…" or normalize-space(.)="Add remote device…"]',
  ).click();
  await waitForTestIdByDom(TID_SSH_HOST_INPUT);
}

/** 设置新建直接进入分类表单，成功留在设备管理；项目入口有独立完成语义。 */
export async function openRemoteConnectionSelection(): Promise<void> {
  // 独立向导关闭后保留设置页；重试时不能再次点击被设置遮挡的全局入口。
  if (!(await $('[data-testid="settings-page"]').isDisplayed())) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  }
  await waitForTestIdByDom(TID_SETTINGS_PAGE);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const page = document.querySelector('[data-testid="settings-page"]');
        const button = Array.from(page?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
          (item) =>
            item.getClientRects().length > 0 &&
            !item.disabled &&
            ["新建连接", "New connection"].includes(item.textContent?.trim() ?? ""),
        );
        button?.click();
        return Boolean(button);
      }),
    { timeout: 15_000, timeoutMsg: "远程设备设置没有可用的新建连接入口" },
  );
  await waitForTestIdByDom(TID_SSH_HOST_INPUT);
}

export async function openSSHRemoteDialog(
  caseMarker: string,
  options: { entry?: "project" | "settings" } = {},
): Promise<void> {
  if (options.entry === "settings") await openRemoteConnectionSelection();
  else await openRemoteProjectSelection();
  // 选择屏会异步插入 Docker 发现结果；原生坐标点击曾落到刚插入的容器行，实际进入 Docker 安装。
  // 连接业务 case 按明确 testId 派发点击；鼠标/双击和键盘入口另由对应交互 case 验证。
  await clickTestIdByDom(TID_REMOTE_KIND_SSH, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: 统一选择屏没有新建 SSH 入口`,
  });
  await waitForTestIdByDom(TID_SSH_HOST_INPUT, {
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: SSH 连接表单没有出现`,
  });
}

/** 打开已知 SSH Source 的目录选择流程，供同一设备追加 workspace 的用例复用。 */
export async function openSSHSourceDirectory(
  config: SSHConnectionConfig,
  caseMarker: string,
  _options: { entry?: "project" | "settings" } = {},
): Promise<void> {
  // 目录归项目表单；设置添加成功已独立完成，不能继续冒充设置目录步骤。
  if (await $('[data-testid="settings-page"]').isDisplayed())
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  if (!(await $('[data-testid="virtual-project-name"]').isDisplayed())) {
    await hoverTestIdByWebDriver("project-section");
    await clickTestIdByWebDriver(TID_VIRTUAL_PROJECT_ADD);
  }
  if (!(await browser.execute(() => Boolean(window.__remoteProjectHandoffRpc?.ready))))
    await installHandoffRpcProbe();
  const snapshot = await callHandoffHost<SourceServerManagementSnapshot>(
    ServiceChannels.SourceServerManagement,
    "getSnapshot",
  );
  const profile = snapshot.profiles.find(
    (item) =>
      item.transport === "ssh" &&
      item.lifecycleState !== "retired" &&
      item.target.host === config.host &&
      (item.target.port ?? 22) === config.port &&
      item.target.username === config.username,
  );
  if (!profile?.sourceServerId) throw new Error(`${caseMarker}: recognized SSH Source missing`);
  await clickTestIdByWebDriver("virtual-project-device");
  const option = $(`[role="option"][data-device-id="remote:server:${profile.sourceServerId}"]`);
  await option.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: saved device missing`,
  });
  await option.click();
  await clickTestIdByWebDriver("virtual-project-browse");
}

export async function ensureSSHProjectDirectoryStep(
  config: SSHConnectionConfig,
  caseMarker: string,
): Promise<void> {
  // 根因：旧循环只识别 SSH 弹窗，将新版项目选择页误判为关闭，再点击被遮挡的侧栏。
  // 统一复用已识别项目选择页的等待入口，不维护第二份连接状态机。
  if ((await waitForSSHDirectoryStep(caseMarker)) === "directory") return;
  await openSSHSourceDirectory(config, caseMarker);
  await waitForSSHDirectoryStep(caseMarker);
}

export async function fillSSHPasswordSettings(config: SSHConnectionConfig): Promise<void> {
  await setInputValueByTestIdDom(TID_SSH_HOST_INPUT, config.host);
  await setInputValueByTestIdDom(TID_SSH_PORT_INPUT, String(config.port));
  await setInputValueByTestIdDom(TID_SSH_USERNAME_INPUT, config.username);
  await setInputValueByTestIdDom(TID_SSH_PASSWORD_INPUT, config.password);
}

export async function clickLastEnabledSSHDialogButton(caseMarker: string): Promise<void> {
  let lastState = "dialog-missing";
  await browser.waitUntil(
    async () => {
      const result = await browser.execute((dialogTestId) => {
        const dialog = document.querySelector<HTMLElement>(`[data-testid="${dialogTestId}"]`);
        if (!dialog || dialog.getClientRects().length === 0) {
          return { clicked: false, reason: "dialog-missing" };
        }
        // 连接屏的主动作嵌在凭据阶段内，页脚末项现在是取消连接。
        const credentialSubmit = dialog
          .querySelector<HTMLInputElement>('li input[type="password"]')
          ?.closest("form")
          ?.querySelector<HTMLButtonElement>('button[type="submit"]');
        const button =
          credentialSubmit ??
          Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
            .filter((candidate) => candidate.getClientRects().length > 0)
            .at(-1);
        if (!button) return { clicked: false, reason: "button-missing" };
        if (button.disabled) {
          return { clicked: false, reason: "button-disabled" };
        }
        button.click();
        return { clicked: true, reason: "clicked" };
      }, TID_SSH_DIALOG);
      lastState = result.reason;
      return result.clicked;
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `${caseMarker}: SSH 向导主动作不可点击 (${lastState})`,
    },
  );
}

export async function waitForSSHError(
  caseMarker: string,
  timeout = SSH_CONNECT_TIMEOUT_MS,
): Promise<string> {
  let errorText = "";
  await browser.waitUntil(
    async () => {
      errorText = await browser.execute((errorTestId) => {
        const error = document.querySelector<HTMLElement>(`[data-testid="${errorTestId}"]`);
        return error?.getClientRects().length ? error.innerText.trim() : "";
      }, TID_SSH_ERROR);
      return Boolean(errorText);
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `${caseMarker}: SSH 失败后没有显示错误`,
    },
  );
  return errorText;
}

export async function waitForSSHDirectoryStep(
  caseMarker: string,
  timeoutMs = SSH_CONNECT_TIMEOUT_MS,
  options: { allowBoundaryAcknowledgement?: boolean } = {},
): Promise<"directory" | "closed"> {
  // 未指定项目的连接成功应进入 directory；closed 仅供已指定目录的快速打开路径使用。
  // 不把 closed 解释为远程 conversation 完成，调用方必须验证目标项目的 identity。
  let state: {
    errorText: string;
    status: "connecting" | "error" | "success" | "closed";
    buttonsSummary?: string;
  } = {
    errorText: "",
    status: "connecting",
  };
  let lastLoggedSummary = "";
  await browser.waitUntil(
    async () => {
      state = await browser.execute(
        (successTestId, errorTestId, confirmTestId, allowBoundaryAcknowledgement) => {
          const summarizeButtons = () => {
            const sshDialog = document.querySelector('[data-testid="ssh-dialog"]');
            const buttons = Array.from(
              sshDialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
            )
              .filter((button) => button.getClientRects().length > 0)
              .map(
                (button) =>
                  `${button.textContent?.trim() ?? ""}${button.disabled ? ":disabled" : ""}`,
              )
              .join(" | ")
              .slice(0, 500);
            // dialog 存在性 + boundary/安装确认弹窗的 DOM 存在性：
            // 区分“dialog 停在 connecting（按钮 disabled）”“dialog 已关闭（openConversation 完成，
            // helper 无 closed 收口）”与“确认弹窗悬挂”三种形态。
            const boundaryDialog = document.querySelector(
              '[data-testid="source-server-boundary-dialog"]',
            );
            const confirmHost = document.querySelector('[data-testid="confirm-dialog-confirm"]');
            return `[dialog:${sshDialog ? "present" : "absent"} confirm:${boundaryDialog ? "boundary-open" : confirmHost ? "other-open" : "closed"}] ${buttons}`;
          };
          const confirmation = document.querySelector<HTMLButtonElement>(
            `[data-testid="${confirmTestId}"]`,
          );
          if (confirmation?.getClientRects().length && !confirmation.disabled) {
            const intent =
              confirmation.closest<HTMLElement>("[data-confirm-intent]")?.dataset.confirmIntent;
            if (intent === "source-server-boundary" && !allowBoundaryAcknowledgement) {
              return {
                errorText: "首次介绍已确认后重复出现",
                status: "error" as const,
                buttonsSummary: summarizeButtons(),
              };
            }
            if (intent !== "source-server-install" && intent !== "source-server-boundary") {
              return {
                errorText: `unexpected confirmation intent: ${intent ?? "missing"}`,
                status: "error" as const,
                buttonsSummary: summarizeButtons(),
              };
            }
            // 只确认本 case 明确允许的安装/边界弹窗；其它确认必须暴露为失败，不能盲点吞掉。
            confirmation.click();
            return {
              errorText: "",
              status: "connecting" as const,
              buttonsSummary: summarizeButtons(),
            };
          }
          const error = document.querySelector<HTMLElement>(`[data-testid="${errorTestId}"]`);
          if (error?.getClientRects().length) {
            return {
              errorText: error.innerText.trim(),
              status: "error" as const,
              buttonsSummary: summarizeButtons(),
            };
          }
          // 已指定目录的快速打开完成后可以关闭向导，调用方负责核实对应项目。
          // 以节点不存在判定（动画期间 clientRects 可能为 0 但节点仍在，不算 closed）。
          const projectPicker = document.querySelector<HTMLButtonElement>(
            '[data-testid="remote-project-new"]',
          );
          // 历史冲突会使项目按钮永久禁用；只看 disabled 会空等完整部署超时并丢失错误原因。
          const projectError = projectPicker
            ?.closest('[role="dialog"]')
            ?.querySelector<HTMLElement>('[role="alert"]');
          if (projectError?.getClientRects().length && projectError.innerText.trim())
            return {
              errorText: projectError.innerText.trim(),
              status: "error" as const,
              buttonsSummary: summarizeButtons(),
            };
          if (projectPicker)
            return {
              errorText: "",
              status: projectPicker.disabled ? ("connecting" as const) : ("success" as const),
              buttonsSummary: summarizeButtons(),
            };
          if (
            [
              ...document.querySelectorAll(
                '[data-testid="virtual-project-name"], [data-testid="virtual-project-directory-browser"]',
              ),
            ].some(
              (element) =>
                element.closest('[role="dialog"]')?.getAttribute("data-state") === "open",
            )
          )
            return {
              errorText: "",
              status: "success" as const,
              buttonsSummary: summarizeButtons(),
            };
          if (!document.querySelector('[data-testid="ssh-dialog"]')) {
            return { errorText: "", status: "closed" as const, buttonsSummary: summarizeButtons() };
          }
          // Bug 原因：安装确认已移入连接步骤，旧 helper 只识别 ConfirmDialog，首装会一直等待。
          // 只操作当前 SSH 弹窗中已授权的安装与目录动作，不确认升级/强制更新等其它意图。
          const dialog = document.querySelector('[data-testid="ssh-dialog"]');
          const next = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
            (button) =>
              button.getClientRects().length > 0 &&
              !button.disabled &&
              [
                "安装并继续",
                "Install and continue",
                "前往选择目录",
                "Go to choose directory",
              ].includes(button.textContent?.trim() ?? ""),
          );
          if (next) {
            next.click();
            return {
              errorText: "",
              status: "connecting" as const,
              buttonsSummary: summarizeButtons(),
            };
          }
          const success = document.querySelector<HTMLElement>(`[data-testid="${successTestId}"]`);
          if (success?.getClientRects().length) {
            return {
              errorText: "",
              status: "success" as const,
              buttonsSummary: summarizeButtons(),
            };
          }
          return {
            errorText: "",
            status: "connecting" as const,
            buttonsSummary: summarizeButtons(),
          };
        },
        TID_SSH_SUCCESS,
        TID_SSH_ERROR,
        TID_CONFIRM_DIALOG_CONFIRM,
        options.allowBoundaryAcknowledgement !== false,
      );
      // 按钮态变化时落一行日志，方便从 run.log 直接还原 dialog 的状态机推进过程。
      if (state.buttonsSummary && state.buttonsSummary !== lastLoggedSummary) {
        lastLoggedSummary = state.buttonsSummary;
        // eslint-disable-next-line no-console
        console.log(`[${caseMarker}] ssh-dialog buttons: ${state.buttonsSummary}`);
      }
      // 0911 修复：向导 error 面板（如身份换代/认证失败）出现后继续等满超时只会在
      // 10min 后抛裸 timeoutMsg，丢掉 errorText（uninstall 第十一轮实录：身份换代
      // 错误等满全程）。error 也作为收口条件，655 行 throw 会带上 errorText。
      return state.status === "success" || state.status === "closed" || state.status === "error";
    },
    {
      timeout: timeoutMs,
      interval: 500,
      timeoutMsg: `${caseMarker}: SSH 部署/连接没有完成`,
    },
  );
  if (state.status === "error") {
    throw new Error(`${caseMarker}: SSH 连接失败: ${state.errorText}`);
  }
  return state.status === "closed" ? "closed" : "directory";
}

export async function selectSSHRemoteDirectory(
  workspacePath: string,
  caseMarker: string,
  options: { waitForDialogClose?: boolean } = {},
): Promise<void> {
  const before = new Set(
    await browser.execute(() =>
      [...document.querySelectorAll("[data-project-id]")].map((row) =>
        row.getAttribute("data-project-id"),
      ),
    ),
  );
  if (await $(`[data-testid="${TID_SSH_SUCCESS}"]`).isExisting()) {
    // 设置连接向导先选目录，再进入带预选 root 的项目编辑器；项目入口则先打开编辑器。
    const selectedPath = $('[data-testid="remote-directory-selected-path"]');
    await selectedPath.waitForDisplayed();
    // 默认目录已满足目标时直接继续，不重复输入和触发远端目录 IO。
    if (!(await selectedPath.getText()).trimEnd().endsWith(` ${workspacePath}`)) {
      const input = $(`[data-testid="${TID_SSH_SUCCESS}"] input[type="text"]`);
      await input.waitForDisplayed();
      await browser.waitUntil(async () => Boolean(await input.getValue()));
      await browser.execute((path) => {
        const field = document.querySelector<HTMLInputElement>(
          '[data-testid="ssh-success"] input[type="text"]',
        )!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          field,
          path,
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }, workspacePath);
      await input.click();
      await browser.keys("Enter");
      await browser.waitUntil(async () =>
        (await $('[data-testid="remote-directory-selected-path"]').getText())
          .trimEnd()
          .endsWith(` ${workspacePath}`),
      );
    }
    const open = $(`[data-testid="${TID_SSH_SUCCESS}"]`).$(
      './/button[normalize-space(.)="在此目录打开工作区" or normalize-space(.)="Open workspace here"]',
    );
    await open.waitForEnabled();
    await open.click();
    await $('[data-testid="virtual-project-name"]').waitForDisplayed({ timeout: 30_000 });
  } else if (await $('[data-testid="virtual-project-name"]').isDisplayed()) {
    const root = $('[data-testid="virtual-project-root-name"]');
    const selected = (await root.isExisting()) ? await root.getAttribute("title") : null;
    if (selected !== workspacePath) await selectRemoteProjectDirectory(workspacePath);
  } else if (await $('[data-testid="virtual-project-directory-browser"]').isDisplayed()) {
    await selectRemoteProjectDirectory(workspacePath);
  } else {
    await $('[data-testid="remote-project-new"]').waitForEnabled({
      timeout: 30_000,
      timeoutMsg: `${caseMarker}: 远程项目列表未就绪`,
    });
    await $('[data-testid="remote-project-new"]').click();
    await selectRemoteProjectDirectory(workspacePath);
  }
  await $('[data-testid="virtual-project-name"]').setValue(
    workspacePath.split("/").filter(Boolean).at(-1) ?? workspacePath,
  );
  await $('[data-testid="virtual-project-save"]').click();
  await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
  await $('[data-testid="project-folder-trust-confirm"]').click();
  let projectId: string | null = null;
  await browser.waitUntil(
    async () => {
      const ids = await browser.execute(() =>
        [...document.querySelectorAll("[data-project-id]")].map((row) =>
          row.getAttribute("data-project-id"),
        ),
      );
      projectId = ids.find((id) => !before.has(id)) ?? null;
      return Boolean(projectId);
    },
    { timeout: 30_000, timeoutMsg: `${caseMarker}: 保存远程项目后没有登记入口` },
  );
  if (await $(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`).isDisplayed()) {
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  }
  const project = $(`[data-project-id=${JSON.stringify(projectId)}]`);
  const projectIdentity = await project.getAttribute("data-project-workspace-identity");
  if (!projectIdentity) throw new Error(`${caseMarker}: 新远程项目缺少 workspace identity`);
  await project.moveTo();
  await project.$('[data-testid="virtual-project-create-task"]').click();
  // 目录存在但历史冲突的负例需要直接观察失败页，不能先等待一个按合同不会发生的工作区就绪。
  if (options.waitForDialogClose === false) return;
  // 同路径的旧 Source 已 active 时，仅等 path 会提前返回旧 tab；新项目的 identity 才能区分目标。
  await waitForRemoteTab({
    caseMarker,
    expectedIdentity: projectIdentity,
    expectedPath: workspacePath,
  });
  await waitForWorkspaceApp(workspacePath, SSH_WORKSPACE_READY_TIMEOUT_MS);
}

export async function waitForRemoteTab(options: {
  caseMarker: string;
  expectedIdentity?: string;
  expectedPath: string;
  expectedRemoteSessionId?: string | null;
  requireActive?: boolean;
  timeoutMs?: number;
}): Promise<RemoteTabSnapshot> {
  let snapshot: RemoteTabSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        snapshot = await readRemoteTabSnapshot(options.expectedIdentity, options.expectedPath);
        const parsedIdentity = snapshot.workspaceIdentity
          ? parseRemoteWorkspaceIdentity(snapshot.workspaceIdentity)
          : null;
        const expectedIdentityMatches = options.expectedIdentity
          ? snapshot.workspaceIdentity === options.expectedIdentity
          : parsedIdentity?.kind === "server" &&
            parsedIdentity.workspacePath === options.expectedPath;
        return (
          snapshot.workspacePath === options.expectedPath &&
          expectedIdentityMatches &&
          Boolean(snapshot.remoteSessionId) &&
          (!options.expectedRemoteSessionId ||
            snapshot.remoteSessionId === options.expectedRemoteSessionId) &&
          (options.requireActive === false ||
            (snapshot.activeWorkspacePath === options.expectedPath &&
              snapshot.activeWorkspaceIdentity === snapshot.workspaceIdentity))
        );
      },
      {
        timeout: options.timeoutMs ?? SSH_WORKSPACE_READY_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: `${options.caseMarker}: remote tab identity/session 没有收敛`,
      },
    );
  } catch (error) {
    throw new Error(
      `${options.caseMarker}: remote tab identity/session 没有收敛，latest=${JSON.stringify(snapshot)}`,
      { cause: error },
    );
  }
  if (!snapshot) {
    throw new Error(`${options.caseMarker}: remote tab snapshot 缺失`);
  }
  return snapshot;
}

export function readRemoteTabSnapshot(
  expectedIdentity?: string,
  expectedPath?: string,
): Promise<RemoteTabSnapshot> {
  return browser.execute(
    (identity, workspacePath) => {
      type RemoteTab = {
        remoteSessionId?: string;
        remoteTarget?: Record<string, unknown>;
        workspaceIdentity?: string;
        workspacePath?: string;
      };
      const store = (
        window as Window & {
          __zcodeTabStoreE2E?: {
            getState?: () => {
              activeWorkspaceIdentity?: string | null;
              activeWorkspacePath?: string | null;
              tabs?: RemoteTab[];
            };
          };
        }
      ).__zcodeTabStoreE2E;
      const state = store?.getState?.();
      const candidates =
        state?.tabs?.filter((candidate) =>
          identity
            ? candidate.workspaceIdentity === identity
            : workspacePath
              ? candidate.workspacePath === workspacePath
              : candidate.workspaceIdentity === state?.activeWorkspaceIdentity &&
                candidate.workspacePath === state?.activeWorkspacePath,
        ) ?? [];
      // 同一远端路径可能被不同 Source Server 各开一个 tab（双 target 用例）；只按 path 匹配时
      // 必须优先取当前激活的那个，否则会一直命中先连接的 tab，后连接方的 identity 收敛永不成立。
      const tab =
        candidates.find(
          (candidate) => candidate.workspaceIdentity === state?.activeWorkspaceIdentity,
        ) ?? candidates[0];
      const target = tab?.remoteTarget;
      return {
        activeWorkspaceIdentity: state?.activeWorkspaceIdentity ?? null,
        activeWorkspacePath: state?.activeWorkspacePath ?? null,
        remoteHost: typeof target?.host === "string" ? target.host : null,
        remoteKind: typeof target?.kind === "string" ? target.kind : null,
        remoteSessionId: tab?.remoteSessionId ?? null,
        secretPersistedInTab: Boolean(
          target && ("password" in target || "privateKeyPassphrase" in target),
        ),
        workspaceIdentity: tab?.workspaceIdentity ?? null,
        workspacePath: tab?.workspacePath ?? null,
      };
    },
    expectedIdentity ?? null,
    expectedPath ?? null,
  );
}

/** 等待 SSH Source 的 conversation workspace（~/.zcode/workspace/default）进入可用状态。 */
export async function waitForSSHConversation(
  config: SSHConnectionConfig,
  caseMarker: string,
): Promise<RemoteTabSnapshot> {
  let snapshot: RemoteTabSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      snapshot = await browser.execute(
        (host: string, port: number) => {
          type RemoteTab = {
            remoteSessionId?: string;
            remoteTarget?: Record<string, unknown>;
            workspaceIdentity?: string;
            workspacePath?: string;
          };
          const store = (
            window as Window & {
              __zcodeTabStoreE2E?: {
                getState?: () => {
                  activeWorkspaceIdentity?: string | null;
                  activeWorkspacePath?: string | null;
                  tabs?: RemoteTab[];
                };
              };
            }
          ).__zcodeTabStoreE2E;
          const state = store?.getState?.();
          // dual target 场景下,先连接的设备在表单提交时也会自动打开自己的设备级
          // conversation(路径同为 ~/.zcode/workspace/default)。只按路径匹配会把 A 的
          // conversation 错认成 B 的(entry-attribution 实锤:sourceB 被解析成 A 的
          // sourceServerId)。必须同时校验 tab 的连接 target(host+port)。
          const tab = state?.tabs?.find((candidate) => {
            if (
              !candidate.workspacePath?.replace(/\\/gu, "/").endsWith("/.zcode/workspace/default")
            ) {
              return false;
            }
            const target = candidate.remoteTarget;
            return target?.kind === "ssh" && target.host === host && target.port === port;
          });
          const target = tab?.remoteTarget;
          return {
            activeWorkspaceIdentity: state?.activeWorkspaceIdentity ?? null,
            activeWorkspacePath: state?.activeWorkspacePath ?? null,
            remoteHost: typeof target?.host === "string" ? target.host : null,
            remoteKind: typeof target?.kind === "string" ? target.kind : null,
            remoteSessionId: tab?.remoteSessionId ?? null,
            secretPersistedInTab: Boolean(
              target && ("password" in target || "privateKeyPassphrase" in target),
            ),
            workspaceIdentity: tab?.workspaceIdentity ?? null,
            workspacePath: tab?.workspacePath ?? null,
          };
        },
        config.host,
        config.port,
      );
      return Boolean(
        snapshot?.workspacePath && snapshot.remoteSessionId && snapshot.workspaceIdentity,
      );
    },
    {
      timeout: SSH_WORKSPACE_READY_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${caseMarker}: SSH conversation workspace 没有进入可用状态`,
    },
  );
  if (!snapshot) throw new Error(`${caseMarker}: SSH conversation workspace snapshot 缺失`);
  return snapshot;
}

export async function readHostProcesses(): Promise<Array<{ name: string; pid: number }>> {
  // utilityProcess 的 serviceName 在 Main 的 metrics.name 中公开；只读同一权威 PID。
  // 打开资源管理器会抢业务窗口焦点并让失败录像录到探针本身，尤其影响短回合/soak。
  let hosts: Array<{ name: string; pid: number }> = [];
  await browser.waitUntil(
    async () => {
      hosts = await browser.electron.execute((electron) =>
        electron.app
          .getAppMetrics()
          .filter((metric) => metric.name?.startsWith("zcode-host-"))
          .map((metric) => ({ name: metric.name!, pid: metric.pid }))
          .sort((a, b) => a.pid - b.pid),
      );
      return hosts.length > 0;
    },
    { timeout: 15_000, interval: 200, timeoutMsg: "Main 进程指标未出现 Window Host" },
  );
  return hosts;
}

export async function runSSHCommand(
  config: SSHConnectionConfig,
  command: string,
  options: { timeoutMs?: number } = {},
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const client = await connectSSHClient(config);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? SSH_CONTROL_COMMAND_TIMEOUT_MS;
      let timedOut = false;
      // 截止必须覆盖 exec ACK；只在拿到 channel 后计时仍会被失联连接永久占住。
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`SSH 控制命令超过 ${timeoutMs}ms；目标命令未完成`));
        client.destroy();
      }, timeoutMs);
      client.exec(command, (error, channel) => {
        if (timedOut) {
          channel?.destroy();
          return;
        }
        if (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
        collectSSHChannel(channel).then(
          (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    });
  } finally {
    clearTimeout(timer);
    client.end();
  }
}

export async function createSSHReplayTunnel(
  config: SSHConnectionConfig,
  caseMarker: string,
  options: SSHReplayTunnelOptions = {},
): Promise<ReplayTunnel> {
  const replayBaseURL = options.targetBaseURL ?? (await resolveSeededReplayBaseUrl());
  if (!replayBaseURL) {
    throw new Error(`${caseMarker}: 没有找到本轮 replay provider URL`);
  }
  const replayURL = new URL(replayBaseURL);
  const replayPort = Number.parseInt(replayURL.port, 10);
  if (!Number.isSafeInteger(replayPort) || replayPort < 1) {
    throw new Error(`${caseMarker}: replay provider URL 缺少有效端口`);
  }

  const client = new SSHClient();
  client.on("tcp connection", (_details: TcpConnectionDetails, accept) => {
    const channel = accept();
    const socket = createConnection({
      host: replayURL.hostname,
      port: replayPort,
    });
    const closeBoth = () => {
      channel.destroy();
      socket.destroy();
    };
    channel.once("error", closeBoth);
    socket.once("error", closeBoth);
    socket.once("connect", () => channel.pipe(socket).pipe(channel));
    socket.once("close", () => channel.destroy());
    channel.once("close", () => socket.destroy());
  });

  const remotePort = await new Promise<number>((resolve, reject) => {
    client.once("error", reject);
    client.once("ready", () => {
      client.forwardIn(
        "127.0.0.1",
        options.mirrorLocalPort ? replayPort : 0,
        (error, assignedPort) => {
          if (error) reject(error);
          else resolve(options.mirrorLocalPort ? replayPort : assignedPort);
        },
      );
    });
    client.connect(
      toSSHConnectOptions(
        options.username && options.username !== config.username
          ? { ...config, username: options.username }
          : config,
      ),
    );
  });

  return {
    baseURL: `http://127.0.0.1:${remotePort}`,
    close: () =>
      new Promise<void>((resolve) => {
        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          client.end();
          client.destroy();
          resolve();
        };
        const timer = setTimeout(finish, 2_000);
        client.unforwardIn("127.0.0.1", remotePort, finish);
      }),
  };
}

function listenOnLoopback(server: Server, caseMarker: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error(`${caseMarker}: 无法解析 SSH pending proxy 监听端口`));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function requireSecretEnv(name: string, caseMarker: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${caseMarker}: 缺少 ${name}`);
  return value;
}

function parseSSHPort(portText: string, context: string): number {
  const port = Number.parseInt(portText, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${context}: SSH port 必须是 1..65535 的整数`);
  }
  return port;
}

function connectSSHClient(config: SSHConnectionConfig): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    client.once("error", reject);
    client.once("ready", () => resolve(client));
    client.connect(toSSHConnectOptions(config));
  });
}

function toSSHConnectOptions(config: SSHConnectionConfig) {
  return {
    host: config.host,
    password: config.password,
    port: config.port,
    readyTimeout: SSH_CONTROL_HANDSHAKE_TIMEOUT_MS,
    username: config.username,
  };
}

function collectSSHChannel(
  channel: ClientChannel,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    channel.setEncoding("utf8");
    channel.stderr.setEncoding("utf8");
    channel.on("data", (chunk: string) => {
      stdout += chunk;
    });
    channel.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    channel.once("exit", (code: number | null) => {
      exitCode = code;
    });
    channel.once("error", reject);
    channel.once("close", () => resolve({ code: exitCode, stderr, stdout }));
  });
}
