import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { join } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  InternalChannels,
  PlatformChannels,
  ServiceChannels,
  buildRemoteHostWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_TASK_ITEM,
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON,
  TID_WORKSPACE_FILE_TREE_ROW,
  testId,
} from "@zcode/shared/test-ids";
import type { ProjectTree } from "@zcode/services";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { getToastMessages } from "#e2e/helpers/conversation-session-toast";
import {
  ensureProjectExpanded,
  projectSectionSelector,
  selectRemoteProjectDirectory,
  startDraftFromProject,
} from "#e2e/helpers/project-sidebar";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  connectRemoteSourceFromSettings,
  disconnectRemoteSource,
  waitForDeviceStatus,
} from "#e2e/helpers/remote-project-actions";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import {
  getV4ConversationState,
  prepareV4ConversationE2E,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";

// RPN-18（2026-10-20 用户日志回归）：Source 在线、窗口内没有项目 session 时点击远程任务，首连
// Provisioning 可达十几秒。期间再次点击曾导致：重复 connect 被 Main 拒绝（“尚无可用 renderer
// attachment”），旧点击在连接迟到成功后释放共享 session，最新点击也失败。
// RPN-19（ZCT-2117174788253970432）：设备恢复后项目自动重连期间点击同一项目的任务，导航曾另建连接，
// 与重连争写 tab，报 project.workspace-identity-mismatch 或留下无人回收的 session。现在导航等重连完成并复用。
// RPN-20：Source 可恢复断连期间点击任务，导航曾立即连接设备并报同一错误；现在等恢复完成后打开任务。
// RPN-21：导航已自建连接后项目重连才开始（窄窗口）。验证两条入口按 owner 仲裁后只剩一条 session，
// 导航结果（任务、文件树）落在在线 owner 上，被回收的一方不影响后续读写。
// RPN-22：Source 恢复后 Main 交付换代 attachment 失败，窗口曾一直“连接中”、点击任务无限等待；
// 现在 Main 发布旧 session 的终止断连，点击任务按普通点击自建连接并打开。
// RPN-23：同一失败也可由 ready 超时触发；renderer 晚于超时才处理 port 时已登记换代 session，
// 导航曾找到这条已失效的 session：点击任务报“未找到远程 workspace session”，查看文件读已关闭的连接。
// RPN-24：查看文件只在最后挡住文件面板，被后一次查看取代的旧请求仍会连接并绑定目录：等重连结束后把
// 当前 tab 切回旧目录；同设备首连时还会先接管连接，使最新查看报 project.navigation-cancelled。
const CASE_MARKER = "E2E_RPN18_CONCURRENT_REMOTE_TASK_NAVIGATION";
const artifactDir = join(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/rpn-18-concurrent-remote-task-navigation",
);
const ERROR_TOAST = /Error:|renderer attachment|navigation-cancelled/u;
type Handler = (...args: unknown[]) => Promise<unknown>;
interface ConnectRemoteResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}
/**
 * none 不扣；all 扣住全部调用的结果；from-reconnect 从第一个项目重连起扣住它与之后调用的结果，
 * 且重连在发起前就停住，由用例 `start` 放行。nav-first：第一次项目重连注入失败（让 tab 保持断连、
 * 设备在线）；`armNav` 之后的未指定目录连接停在发起前，之后的项目重连照常连接但扣住结果。
 */
type ConnectHoldMode = "none" | "all" | "from-reconnect" | "nav-first";
interface ConnectProbeCall {
  requestId: string | null;
  workspacePath: string | null;
  connectTrigger: string | null;
  sessionId: string | null;
  started: boolean;
  settled: boolean;
  injected: boolean;
}
declare global {
  interface Window {
    __rpn18ScopedPorts?: Map<string, MessagePort>;
    __rpn18ScopedPortListener?: (event: MessageEvent) => void;
    __rpn18ConnectHostRequests?: { count: number; restore(): void };
    /** renderer 收到的 scoped port → logical session；记录注册顺序，用于确认竞态前提。 */
    __rpn21PortSessions?: WeakMap<MessagePort, string>;
    __rpn21SessionOrder?: string[];
    __rpn21Readdir?: { counts: Record<string, number>; restore(): void };
    /** renderer 关闭的 scoped port 对应的 logical session（注销 session 时关闭其 port）。 */
    __rpn23ClosedPorts?: { sessions: string[]; restore(): void };
  }
  var __rpn20ReconnectedEvents: { held: number; release(): void } | undefined;
  var __rpn22PortDelivery: { failed: boolean; restore(): void } | undefined;
  var __rpn23ReadyAck:
    | { held: Array<{ sessionId: string; attachmentId: string }>; release(): void }
    | undefined;
  var __rpn18ConnectProbe:
    | {
        calls: number;
        held: number;
        entries: ConnectProbeCall[];
        armNav(): void;
        start(index: number): void;
        release(index?: number): void;
        restore(): void;
        duplicate(): Promise<unknown>;
      }
    | undefined;
}

/** 只切断 Desktop（用户 dev）的 SSH 会话，触发 Source 传输中断后的可恢复断连。 */
async function severDesktopSshSessions(container: string): Promise<void> {
  const script = [
    "target_uid=$(id -u dev)",
    'for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = 1 ] && continue',
    "c=$(tr '\\0' ' ' < \"$d/cmdline\" 2>/dev/null) || continue; case \"$c\" in *sshd*) ;; *) continue;; esac",
    'uid=$(awk \'/^Uid:/ {print $2}\' "$d/status"); [ "$uid" = "$target_uid" ] || continue',
    'parent=$(awk \'{print $4}\' "$d/stat"); kill -9 "$p" 2>/dev/null',
    '[ "$parent" != 1 ] && kill -9 "$parent" 2>/dev/null; done; true',
  ].join("; ");
  await execInRemoteContainer(container, ["sh", "-c", script], { user: "0" });
}

/**
 * 扣住 Main 发往窗口的 RemoteSessionReconnected：Source 已重新上线、换代 session 的端口已推给
 * renderer，tab 仍保留旧 id、侧栏仍是“连接中”。WSL 上换代前的 Provisioning 很长，这里把该窗口拉长。
 */
async function holdSessionReconnectedEvents() {
  await browser.electron.execute((electron, channel) => {
    globalThis.__rpn20ReconnectedEvents?.release();
    const held: Array<() => void> = [];
    const restores = electron.BrowserWindow.getAllWindows().map(({ webContents }) => {
      const original = webContents.send;
      webContents.send = (sent: string, ...args: unknown[]) => {
        if (sent !== channel) return original.call(webContents, sent, ...args);
        held.push(() => original.call(webContents, sent, ...args));
      };
      return () => {
        webContents.send = original;
      };
    });
    globalThis.__rpn20ReconnectedEvents = {
      get held() {
        return held.length;
      },
      release() {
        for (const restore of restores) restore();
        for (const send of held.splice(0)) send();
        delete globalThis.__rpn20ReconnectedEvents;
      },
    };
  }, PlatformChannels.RemoteSessionReconnected);
}

/**
 * 让 Main 下一次向窗口投递 scoped port 时失败，模拟 Source 恢复换代时 renderer attachment
 * 投递/就绪失败（例如 renderer 忙碌导致 ready 超时）。只影响下一次投递。
 */
async function failNextScopedPortDelivery() {
  await browser.electron.execute((electron, channel) => {
    globalThis.__rpn22PortDelivery?.restore();
    const restores = electron.BrowserWindow.getAllWindows().map(({ webContents }) => {
      const original = webContents.postMessage;
      webContents.postMessage = function (sent: string, ...args: unknown[]) {
        const delivery = globalThis.__rpn22PortDelivery;
        if (sent === channel && delivery && !delivery.failed) {
          delivery.failed = true;
          throw new Error("E2E injected scoped port delivery failure");
        }
        return Reflect.apply(original, webContents, [sent, ...args]);
      } as typeof original;
      return () => {
        webContents.postMessage = original;
      };
    });
    globalThis.__rpn22PortDelivery = {
      failed: false,
      restore() {
        for (const restore of restores) restore();
        delete globalThis.__rpn22PortDelivery;
      },
    };
  }, InternalChannels.ScopedServicePort);
}

const restoreScopedPortDelivery = () =>
  browser.electron.execute(() => globalThis.__rpn22PortDelivery?.restore());

/**
 * 扣住 Main 收到的第一条换代 session ready ACK，用例放行时再交给 Main：port 照常投递、renderer 已登记，
 * Main 先按 ready 超时放弃换代，ACK 后到。模拟 renderer 忙碌、晚于超时才处理 port。
 */
async function holdCandidateReadyAck(previousSessionId: string) {
  await browser.electron.execute(
    (electron, channel, previous) => {
      globalThis.__rpn23ReadyAck?.release();
      const ipc = electron.ipcMain;
      const listeners = ipc.listeners(channel) as Array<(...args: unknown[]) => void>;
      const held: Array<{ sessionId: string; attachmentId: string }> = [];
      const heldArgs: unknown[][] = [];
      const wrapper = (...args: unknown[]) => {
        const payload = args[1] as { sessionId?: string; attachmentId?: string } | undefined;
        if (heldArgs.length === 0 && payload?.sessionId && payload.sessionId !== previous) {
          held.push({ sessionId: payload.sessionId, attachmentId: payload.attachmentId ?? "" });
          heldArgs.push(args);
          return;
        }
        for (const listener of listeners) listener(...args);
      };
      ipc.removeAllListeners(channel);
      ipc.on(channel, wrapper);
      globalThis.__rpn23ReadyAck = {
        held,
        release() {
          ipc.removeListener(channel, wrapper);
          for (const listener of listeners) ipc.on(channel, listener);
          for (const args of heldArgs.splice(0))
            for (const listener of listeners) listener(...args);
          delete globalThis.__rpn23ReadyAck;
        },
      };
    },
    InternalChannels.ScopedServicePortReady,
    previousSessionId,
  );
}

const heldReadyAcks = () =>
  browser.electron.execute(() => [...(globalThis.__rpn23ReadyAck?.held ?? [])]);
const releaseReadyAck = () => browser.electron.execute(() => globalThis.__rpn23ReadyAck?.release());

/** 记录 renderer 关闭了哪些 logical session 的 scoped port：注销 session 会关闭其 port。 */
async function watchClosedScopedPorts() {
  await browser.execute(() => {
    window.__rpn23ClosedPorts?.restore();
    const original = MessagePort.prototype.close;
    const sessions: string[] = [];
    MessagePort.prototype.close = function () {
      const sessionId = window.__rpn21PortSessions?.get(this);
      if (sessionId) sessions.push(sessionId);
      Reflect.apply(original, this, []);
    };
    window.__rpn23ClosedPorts = {
      sessions,
      restore() {
        MessagePort.prototype.close = original;
        delete window.__rpn23ClosedPorts;
      },
    };
  });
}

const closedPortSessions = () =>
  browser.execute(() => [...(window.__rpn23ClosedPorts?.sessions ?? [])]);

const heldReconnectedEvents = () =>
  browser.electron.execute(() => globalThis.__rpn20ReconnectedEvents?.held ?? 0);
const releaseReconnectedEvents = () =>
  browser.electron.execute(() => globalThis.__rpn20ReconnectedEvents?.release());

/** 记录 renderer 收到的远程 scoped port，供用例在远端写入历史任务夹具（不发模型请求）。 */
async function captureScopedPorts() {
  await browser.execute((channel) => {
    const ports = new Map<string, MessagePort>();
    const portSessions = new WeakMap<MessagePort, string>();
    const sessionOrder: string[] = [];
    const listener = (event: MessageEvent) => {
      const data = event.data as
        | { type?: string; workspaceIdentity?: string; sessionId?: string }
        | undefined;
      if (data?.type !== channel || !event.ports[0]) return;
      if (data.workspaceIdentity) ports.set(data.workspaceIdentity, event.ports[0]);
      if (data.sessionId) {
        portSessions.set(event.ports[0], data.sessionId);
        if (!sessionOrder.includes(data.sessionId)) sessionOrder.push(data.sessionId);
      }
    };
    window.__rpn18ScopedPorts = ports;
    window.__rpn21PortSessions = portSessions;
    window.__rpn21SessionOrder = sessionOrder;
    window.__rpn18ScopedPortListener = listener;
    window.addEventListener("message", listener);
  }, InternalChannels.ScopedServicePort);
}

let fixtureRequestId = -18_000;
async function callRemoteFixture<T>(
  identity: string,
  channel: string,
  command: string,
  args: unknown[],
): Promise<T> {
  const id = fixtureRequestId--;
  const writer = new BufferWriter();
  serialize(writer, [100, id, channel, command]);
  serialize(writer, args);
  const prefixes = [201, 202, 203].map((type) => {
    const prefix = new BufferWriter();
    serialize(prefix, [type, id]);
    return Array.from(prefix.buffer.buffer);
  });
  const reply = await browser.execute(
    (workspaceIdentity, request, signatures) => {
      const port = window.__rpn18ScopedPorts?.get(workspaceIdentity);
      if (!port) throw new Error(`Scoped port unavailable: ${workspaceIdentity}`);
      return new Promise<number[]>((resolve) => {
        const receive = (event: MessageEvent) => {
          if (
            !(event.data instanceof Uint8Array) ||
            !signatures.some((prefix) => prefix.every((byte, index) => event.data[index] === byte))
          )
            return;
          port.removeEventListener("message", receive);
          resolve(Array.from(event.data));
        };
        port.addEventListener("message", receive);
        port.postMessage(Uint8Array.from(request));
      });
    },
    identity,
    Array.from(writer.buffer.buffer),
    prefixes,
  );
  const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(reply)));
  const header = deserialize(reader) as [number, number];
  const body = deserialize(reader);
  if (header[0] !== 201) throw new Error(typeof body === "string" ? body : body.message);
  return body as T;
}

/** 空 createSession 只是草稿；用公开历史导入在远端建立正式任务，不发送模型请求。 */
async function createRemoteHistoryTask(target: {
  workspacePath: string;
  workspaceIdentity: string;
  projectId: string;
}): Promise<string> {
  const created = await callRemoteFixture<{ session: { sessionId: string } }>(
    target.workspaceIdentity,
    ServiceChannels.ZCodeAgent,
    "createSession",
    [
      {
        ...target,
        persistence: "immediate",
        importedHistory: {
          source: "claudeCode",
          title: `${CASE_MARKER}${target.workspacePath}`,
          messages: [
            { role: "user", content: CASE_MARKER },
            { role: "assistant", content: "Fixture ready" },
          ],
        },
      },
    ],
  );
  const taskId = created.session.sessionId;
  await callRemoteFixture(target.workspaceIdentity, ServiceChannels.ZCodeTask, "resumeTask", [
    { taskId, workspacePath: target.workspacePath, workspaceIdentity: target.workspaceIdentity },
  ]);
  return taskId;
}

/**
 * 包装 Main 的 ConnectRemote：统计 renderer 发起次数；扣住时真实连接照常完成，只扣住返回结果，
 * 模拟首连 Provisioning 的长等待。每次调用有独立 barrier：`release(i)` 只放行第 i 次，
 * 不传参数放行全部且之后不再扣住。`duplicate` 用第一次请求的窗口上下文、新 requestId 重放一次
 * 真实 ConnectRemote，模拟另一个入口在首连期间并发连接（不计入 renderer 次数）。
 */
async function installConnectProbe(options: { hold: ConnectHoldMode }) {
  await browser.electron.execute(
    (electron, channel, mode) => {
      globalThis.__rpn18ConnectProbe?.restore();
      const handlers = (electron.ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
        ._invokeHandlers;
      const original = handlers.get(channel);
      if (!original) throw new Error("Remote connection handler is unavailable");
      const starts: Array<() => void> = [];
      const releases: Array<() => void> = [];
      let releasedAll = false;
      let holding = mode === "all";
      let navArmed = false;
      let injectedReconnectFailure = false;
      let firstArgs: unknown[] | undefined;
      const probe = {
        calls: 0,
        held: 0,
        entries: [] as ConnectProbeCall[],
        armNav() {
          navArmed = true;
        },
        start(index: number) {
          starts[index]?.();
        },
        release(index?: number) {
          if (index !== undefined) return releases[index]?.();
          releasedAll = true;
          // 只有被扣住的调用才有 start，数组带空位；forEach 跳过空位。
          for (const gates of [starts, releases]) gates.forEach((release) => release());
        },
        restore() {
          probe.release();
          handlers.set(channel, original);
          delete globalThis.__rpn18ConnectProbe;
        },
        duplicate() {
          if (!firstArgs) throw new Error("No ConnectRemote request to replay");
          const [event, payload] = firstArgs;
          return original(event, {
            ...(payload as Record<string, unknown>),
            requestId: crypto.randomUUID(),
          });
        },
      };
      handlers.set(channel, async (...args) => {
        probe.calls++;
        firstArgs ??= args;
        const payload = (args[1] ?? {}) as {
          requestId?: string;
          workspacePath?: string;
          connectTrigger?: string;
        };
        const reconnect = payload.connectTrigger === "reconnect";
        holding ||= mode === "from-reconnect" && reconnect;
        const hold = holding && !releasedAll;
        const entry: ConnectProbeCall = {
          requestId: payload.requestId ?? null,
          workspacePath: payload.workspacePath ?? null,
          connectTrigger: payload.connectTrigger ?? null,
          sessionId: null,
          started: false,
          settled: false,
          injected: false,
        };
        const index = probe.entries.push(entry) - 1;
        // nav-first 的第一次项目重连直接失败：tab 保持断连、设备保持在线，侧栏没有“连接中”。
        if (mode === "nav-first" && reconnect && !injectedReconnectFailure) {
          injectedReconnectFailure = true;
          Object.assign(entry, { injected: true, started: true, settled: true });
          return { success: false, error: "E2E injected reconnect failure" };
        }
        const barrier = new Promise<void>((resolve) => {
          releases[index] = resolve;
        });
        const holdStart =
          mode === "nav-first"
            ? navArmed && !reconnect && !releasedAll
            : hold && reconnect && mode === "from-reconnect";
        const holdResult = mode === "nav-first" ? reconnect && !releasedAll : hold;
        // Main 在返回结果前就把 session 推给 renderer store；只扣结果时，后到的导航会直接复用它。
        // 重连停在发起前，等导航也发起连接再放行，两条连接才会像长 Provisioning 那样同时在途。
        if (holdStart)
          await new Promise<void>((resolve) => {
            starts[index] = resolve;
          });
        entry.started = true;
        const [result] = await Promise.allSettled([original(...args)]);
        if (result.status === "fulfilled")
          entry.sessionId = (result.value as ConnectRemoteResult | undefined)?.sessionId ?? null;
        entry.settled = true;
        probe.held++;
        if (holdResult) await barrier;
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      globalThis.__rpn18ConnectProbe = probe;
    },
    PlatformChannels.ConnectRemote,
    options.hold,
  );
}

const connectProbe = () =>
  browser.electron.execute(() => ({
    calls: globalThis.__rpn18ConnectProbe?.calls ?? 0,
    held: globalThis.__rpn18ConnectProbe?.held ?? 0,
    entries: globalThis.__rpn18ConnectProbe?.entries ?? [],
  }));

/** 等到第一个满足条件的调用；settled 时还要求真实连接已完成，返回其 sessionId。 */
async function waitForConnectCall(
  match: (entry: ConnectProbeCall, index: number) => boolean,
  timeoutMsg: string,
  options: { settled?: boolean } = {},
): Promise<{ index: number; sessionId: string | null }> {
  let found: { index: number; sessionId: string | null } | undefined;
  await browser.waitUntil(
    async () => {
      const { entries } = await connectProbe();
      const index = entries.findIndex(match);
      const entry = entries[index];
      if (!entry || (options.settled && !entry.settled)) return false;
      if (options.settled && !entry.sessionId)
        throw new Error(`${timeoutMsg}：连接失败 ${JSON.stringify(entry)}`);
      found = { index, sessionId: entry.sessionId };
      return true;
    },
    { timeout: 120_000, interval: 100, timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}` },
  );
  return found!;
}

const startConnect = (index: number) =>
  browser.electron.execute((_electron, i) => globalThis.__rpn18ConnectProbe?.start(i), index);
const releaseConnect = (index: number) =>
  browser.electron.execute((_electron, i) => globalThis.__rpn18ConnectProbe?.release(i), index);
const armNavHold = () => browser.electron.execute(() => globalThis.__rpn18ConnectProbe?.armNav());
const readSessionOrder = () => browser.execute(() => [...(window.__rpn21SessionOrder ?? [])]);

/** 走手机远控的“重连 workspace”请求：桌面 renderer 按同一 reconnect helper 发起项目重连。 */
async function requestWorkspaceReconnectFromMobile(workspaceKey: string) {
  await browser.electron.execute(
    (electron, channel, key) => {
      for (const win of electron.BrowserWindow.getAllWindows())
        if (!win.isDestroyed())
          win.webContents.send(channel, {
            requestId: `e2e-rpn21-${Date.now()}`,
            workspaceKey: key,
          });
    },
    PlatformChannels.WebRemoteControlReconnectWorkspace,
    workspaceKey,
  );
}

/** 按 scoped port 统计文件树 readdir 走的是哪条 logical session。 */
async function countReaddirBySession() {
  await browser.execute((channel) => {
    window.__rpn21Readdir?.restore();
    const original = MessagePort.prototype.postMessage;
    const counts: Record<string, number> = {};
    MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
      if (message instanceof Uint8Array) {
        const text = new TextDecoder().decode(message);
        if (text.includes(channel) && text.includes("readdir")) {
          const sessionId = window.__rpn21PortSessions?.get(this) ?? "unknown";
          counts[sessionId] = (counts[sessionId] ?? 0) + 1;
        }
      }
      Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
    };
    window.__rpn21Readdir = {
      counts,
      restore() {
        MessagePort.prototype.postMessage = original;
        delete window.__rpn21Readdir;
      },
    };
  }, ServiceChannels.File);
}

const readReaddirCounts = () => browser.execute(() => ({ ...window.__rpn21Readdir?.counts }));

async function waitForFileTreeRow(path: string, timeoutMsg: string, timeout = 30_000) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (rowTestId) =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
            (element) => element.dataset.testid === rowTestId,
          ),
        testId(TID_WORKSPACE_FILE_TREE_ROW, path),
      ),
    { timeout, interval: 200, timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}` },
  );
}

async function clickFileTreeRow(path: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (rowTestId) => {
          const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (element) => element.dataset.testid === rowTestId,
          );
          row?.click();
          return Boolean(row);
        },
        testId(TID_WORKSPACE_FILE_TREE_ROW, path),
      ),
    { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: 文件树没有可点击行 ${path}` },
  );
}

/** 悬停层会拦截 WebDriver 点击，查看文件按钮按 DOM 点击。 */
const clickProjectFilesButton = (path: string) =>
  browser.execute((selector) => {
    const button = document.querySelector<HTMLElement>(
      `${selector} [data-testid="virtual-project-files"]`,
    );
    button?.click();
    return Boolean(button);
  }, projectSectionSelector(path));

/** 统计侧栏导航发出的 connectHost 请求，作为“后续点击已走到连接阶段”的确定信号。 */
async function countConnectHostRequests() {
  await browser.execute((channel) => {
    const original = MessagePort.prototype.postMessage;
    const counter = {
      count: 0,
      restore() {
        MessagePort.prototype.postMessage = original;
        delete window.__rpn18ConnectHostRequests;
      },
    };
    MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
      if (message instanceof Uint8Array) {
        const text = new TextDecoder().decode(message);
        if (text.includes(channel) && text.includes("connectHost")) counter.count++;
      }
      Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
    };
    window.__rpn18ConnectHostRequests = counter;
  }, ServiceChannels.RemoteProjects);
}

const connectHostRequests = () =>
  browser.execute(() => window.__rpn18ConnectHostRequests?.count ?? 0);

/** 本次运行的 Main 日志（含 Host 转发行），按文件名排序拼接。 */
async function readMainLogLines(): Promise<string[]> {
  const directory = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
  if (!directory) throw new Error(`${CASE_MARKER}: 缺少本次 Main 日志目录`);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".log")).sort();
  const contents = await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")));
  // 去掉末尾空串：行数常被用作“之后的新日志”基线，多算一行会漏掉紧随其后的第一条。
  return contents.join("").split("\n").filter(Boolean);
}

async function waitForMainLog(
  fromLine: number,
  pattern: RegExp,
  timeoutMsg: string,
  timeout = 60_000,
): Promise<void> {
  await browser.waitUntil(
    async () => (await readMainLogLines()).slice(fromLine).some((line) => pattern.test(line)),
    { timeout, interval: 50, timeoutMsg },
  );
}

/** 关闭项目 tab 会释放窗口内的 logical session；等 Host 回到 0 个 session，下一次点击才会走完整首连。 */
async function closeWorkspaceTabs(identities: string[]) {
  const fromLine = (await readMainLogLines()).length;
  let releasesSession = false;
  for (const identity of identities) {
    releasesSession ||= Boolean((await readRemoteTabSnapshot(identity)).remoteSessionId);
    await browser.execute((workspaceIdentity) => {
      const store = (
        window as Window & {
          __zcodeTabStoreE2E?: {
            getState(): {
              tabs: Array<{ id: string; workspaceIdentity?: string }>;
              closeTab(id: string, origin?: "user-close"): void;
            };
          };
        }
      ).__zcodeTabStoreE2E;
      const tab = store
        ?.getState()
        .tabs.find((item) => item.workspaceIdentity === workspaceIdentity);
      if (!store || !tab) throw new Error(`Missing remote workspace tab: ${workspaceIdentity}`);
      store.getState().closeTab(tab.id, "user-close");
    }, identity);
    await browser.waitUntil(
      async () => (await readRemoteTabSnapshot(identity)).workspaceIdentity === null,
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 远程项目 tab 没有关闭 ${identity}` },
    );
  }
  // 上个用例失败时可能留下没有 session 的断连 tab，关闭它不释放 session，也不会有这条日志。
  if (!releasesSession) return;
  await waitForMainLog(
    fromLine,
    /reason=remote-session-disposed, .*logicalSessions=0/u,
    `${CASE_MARKER}: 关闭 tab 后 Host 仍有 logical session`,
  );
}

/** 每个场景独立起步：关闭残留的项目 tab，并以 Host 最近一次拓扑确认窗口内没有 logical session。 */
async function resetRemoteTabs(identities: string[]) {
  const open: string[] = [];
  for (const identity of identities)
    if ((await readRemoteTabSnapshot(identity)).workspaceIdentity === identity) open.push(identity);
  if (open.length > 0) await closeWorkspaceTabs(open);
  const topology = (await readMainLogLines())
    .filter((line) => /window Host topology, reason=/u.test(line))
    .at(-1);
  expect(topology).toMatch(/logicalSessions=0/u);
}

async function expectNoErrorToasts() {
  expect((await getToastMessages()).filter((text) => ERROR_TOAST.test(text))).toEqual([]);
}

/** 任务打开或出现错误提示即返回；错误提示先于“任务未打开”报告，失败原因直接可读。 */
async function waitForTaskOpenedWithoutError(taskId: string, timeoutMsg: string) {
  await browser.waitUntil(
    async () =>
      (await getV4ConversationState()).taskId === taskId ||
      (await getToastMessages()).some((text) => ERROR_TOAST.test(text)),
    { timeout: 60_000, interval: 200, timeoutMsg: `${CASE_MARKER}: ${timeoutMsg}` },
  );
  await expectNoErrorToasts();
}

async function saveArtifact(name: string) {
  await mkdir(artifactDir, { recursive: true });
  await browser.saveScreenshot(join(artifactDir, name));
}

describe(`${CASE_MARKER}: 连接在途时并发打开同设备下的远程任务`, () => {
  const projectA = { path: "", identity: "", taskId: "" };
  const projectB = { path: "", identity: "", taskId: "" };

  before(async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    [projectA.path, projectB.path] = config.workspacePaths as [string, string];
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await captureScopedPorts();
    const connected = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config,
      workspacePath: projectA.path,
    });
    if (!connected.workspaceIdentity) throw new Error(`${CASE_MARKER}: 项目 A 缺少 identity`);
    projectA.identity = connected.workspaceIdentity;
    const hostId = remoteHostIdFromWorkspaceIdentity(projectA.identity);
    if (!hostId) throw new Error(`${CASE_MARKER}: 无法从 identity 解析设备`);
    await installHandoffRpcProbe();
    await selectTaskOrganizeMode(["项目", "Project"]);

    // 同一设备上的第二个项目：Host 对未指定目录的连接按设备复用 session，跨项目连点共享同一连接。
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    await $('[data-testid="virtual-project-device"]').click();
    await $(`[role="option"][data-device-id=${JSON.stringify(hostId)}]`).click();
    await selectRemoteProjectDirectory(projectB.path);
    await $('[data-testid="virtual-project-name"]').setValue(projectB.path.split("/").at(-1)!);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await ensureProjectExpanded(projectB.path);
    // 远程项目草稿按 workspace identity 记录；只传路径时 helper 会等错草稿键。
    projectB.identity = buildRemoteHostWorkspaceIdentity(hostId, projectB.path);
    await startDraftFromProject(projectB.path, { workspaceIdentity: projectB.identity });
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: projectB.identity,
      expectedPath: projectB.path,
    });

    const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId },
    ]);
    for (const project of [projectA, projectB]) {
      const entry = tree.projects.find((item) =>
        item.roots.some((root) => root.rootPath === project.path),
      );
      if (!entry) throw new Error(`${CASE_MARKER}: 找不到远程项目 ${project.path}`);
      project.taskId = await createRemoteHistoryTask({
        workspacePath: project.path,
        workspaceIdentity: project.identity,
        projectId: entry.id,
      });
    }

    // 复现现场：Source 保持在线，只关闭项目 tab 释放窗口内的 logical session；
    // 不走主动断开，避免 Source 重新上线时的自动恢复混入额外连接。
    await closeWorkspaceTabs([projectA.identity, projectB.identity]);
    for (const project of [projectA, projectB]) {
      await ensureProjectExpanded(project.path);
      await $(`[data-testid="${testId(TID_TASK_ITEM, project.taskId)}"]`).waitForDisplayed({
        timeout: 30_000,
      });
    }
    await countConnectHostRequests();
  });

  afterEach(async function () {
    await releaseReconnectedEvents().catch(() => undefined);
    await restoreScopedPortDelivery().catch(() => undefined);
    await releaseReadyAck().catch(() => undefined);
    await browser.execute(() => window.__rpn23ClosedPorts?.restore()).catch(() => undefined);
    const probe = await connectProbe().catch((error) => String(error));
    const sessions = await browser
      .execute(() => ({
        order: [...(window.__rpn21SessionOrder ?? [])],
        readdir: { ...window.__rpn21Readdir?.counts },
      }))
      .catch((error) => String(error));
    await browser.execute(() => window.__rpn21Readdir?.restore()).catch(() => undefined);
    const caseName = (this.currentTest?.title.match(/^[\w-]+/u)?.[0] ?? "case").toLowerCase();
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      join(artifactDir, `${caseName}-sessions.json`),
      JSON.stringify({ probe, sessions }, null, 2),
    );
    await browser.electron
      .execute(() => globalThis.__rpn18ConnectProbe?.restore())
      .catch(() => undefined);
    if (this.currentTest?.state !== "failed") return;
    const name = (this.currentTest.title.match(/^[\w-]+/u)?.[0] ?? "case").toLowerCase();
    await saveArtifact(`${name}-failure.png`);
    await writeFile(join(artifactDir, `${name}-failure.txt`), await $("body").getText());
    await writeFile(
      join(artifactDir, `${name}-connect-probe.json`),
      JSON.stringify(probe, null, 2),
    );
  });

  after(async () => {
    await browser
      .execute(() => window.__rpn18ConnectHostRequests?.restore())
      .catch(() => undefined);
    await browser
      .execute(() => {
        if (window.__rpn18ScopedPortListener)
          window.removeEventListener("message", window.__rpn18ScopedPortListener);
      })
      .catch(() => undefined);
    await restoreHandoffProbes();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  /** 第一次点击完成真实连接后扣住结果，再点第二个任务；断言只连接一次且最新点击接管。 */
  async function clickTwiceDuringFirstConnect(first: typeof projectA, second: typeof projectA) {
    await installConnectProbe({ hold: "all" });
    const requestsBefore = await connectHostRequests();
    await clickTestIdByDom(testId(TID_TASK_ITEM, first.taskId));
    await browser.waitUntil(async () => (await connectProbe()).held === 1, {
      timeout: 120_000,
      timeoutMsg: `${CASE_MARKER}: 第一次点击没有完成真实连接`,
    });
    await clickTestIdByDom(testId(TID_TASK_ITEM, second.taskId));
    await browser.waitUntil(async () => (await connectHostRequests()) >= requestsBefore + 2, {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 第二次点击没有走到连接阶段`,
    });
    // 负向观察窗口：旧实现会在 connectHost 返回后立即再发一次 ConnectRemote。
    await browser.pause(2_000);
    expect((await connectProbe()).calls).toBe(1);

    await browser.electron.execute(() => globalThis.__rpn18ConnectProbe?.release());
    const opened = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: second.identity,
      expectedPath: second.path,
    });
    expect(opened.remoteSessionId).toBeTruthy();
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === second.taskId,
      `${CASE_MARKER}: 最后点击的任务没有打开`,
      60_000,
    );
    return opened;
  }

  it("RPN-18a 首连期间连点同一任务：只连接一次、无错误提示，任务打开且连接不被旧点击释放", async function () {
    this.timeout(10 * 60_000);
    await resetRemoteTabs([projectA.identity, projectB.identity]);
    const opened = await clickTwiceDuringFirstConnect(projectA, projectA);
    await saveArtifact("rpn-18a-task-opened.png");
    // 旧实现会在这里由被替代的点击释放共享 session；保持一段时间确认 session 不被回收。
    await browser.pause(3_000);
    expect((await readRemoteTabSnapshot(projectA.identity)).remoteSessionId).toBe(
      opened.remoteSessionId,
    );
    expect((await connectProbe()).calls).toBe(1);
    await expectNoErrorToasts();
  });

  it("RPN-18b 首连期间先点 A 项目再点同设备 B 项目：只连接一次，B 打开且连接不被 A 释放", async function () {
    this.timeout(10 * 60_000);
    await resetRemoteTabs([projectA.identity, projectB.identity]);
    const opened = await clickTwiceDuringFirstConnect(projectA, projectB);
    await saveArtifact("rpn-18b-task-opened.png");
    await browser.pause(3_000);
    expect((await readRemoteTabSnapshot(projectB.identity)).remoteSessionId).toBe(
      opened.remoteSessionId,
    );
    // 被替代的 A 不能借共享连接绑定自己的目录。
    expect((await readRemoteTabSnapshot(projectA.identity)).remoteSessionId).toBeNull();
    expect((await connectProbe()).calls).toBe(1);
    await expectNoErrorToasts();
  });

  it("DRS-RR-11 首连 Provisioning 期间另一入口 join 同一 session：等待同一结果，不报尚无 attachment", async function () {
    this.timeout(10 * 60_000);
    await resetRemoteTabs([projectA.identity, projectB.identity]);
    await installConnectProbe({ hold: "none" });
    const fromLine = (await readMainLogLines()).length;
    await clickTestIdByDom(testId(TID_TASK_ITEM, projectA.taskId));
    // Host 已回报连接 = Main route 已建立，首次同步与首个 attachment 尚未完成。
    await waitForMainLog(
      fromLine,
      /window Host topology, reason=remote-connected/u,
      `${CASE_MARKER}: 第一次点击没有建立远程连接`,
      120_000,
    );
    const duplicate = (await browser.electron.execute(
      async () => await globalThis.__rpn18ConnectProbe?.duplicate(),
    )) as ConnectRemoteResult;
    expect(duplicate).toMatchObject({ success: true });

    const opened = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: projectA.identity,
      expectedPath: projectA.path,
    });
    expect(duplicate.sessionId).toBe(opened.remoteSessionId);
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === projectA.taskId,
      `${CASE_MARKER}: 任务没有打开`,
      60_000,
    );
    await saveArtifact("drs-rr-11-task-opened.png");

    // 证据边界：重复 connect 的 join 必须早于首次同步完成，否则没有命中“尚无 attachment”窗口。
    const lines = (await readMainLogLines()).slice(fromLine);
    const connected = lines.flatMap((line, index) =>
      /window Host topology, reason=remote-connected/u.test(line) ? [index] : [],
    );
    const synced = lines.findIndex((line) =>
      /\[provider-provisioning\] Environment sync completed/u.test(line),
    );
    expect(connected.length).toBeGreaterThanOrEqual(2);
    if (synced < 0 || connected[1]! > synced) {
      throw new Error(`${CASE_MARKER}: 重复 connect 晚于首次同步完成，未命中首连窗口，结论无效`);
    }
    expect(lines.some((line) => /尚无可用 renderer attachment/u.test(line))).toBe(false);
    await browser.pause(3_000);
    expect((await readRemoteTabSnapshot(projectA.identity)).remoteSessionId).toBe(
      opened.remoteSessionId,
    );
    await expectNoErrorToasts();
  });

  /**
   * 复现现场：A 的 tab 已断连，设备重新上线后 Renderer 自动重连 A。探针把重连停在发起前，模拟 WSL
   * Provisioning 的长等待：tab 还没有 owner，侧栏显示“连接中”。返回这次重连在探针中的下标。
   */
  async function holdProjectReconnect(project: typeof projectA) {
    await resetRemoteTabs([projectA.identity, projectB.identity]);
    // tab 停在草稿：点击任务必须真正切换焦点，才能观察任务是否打开。
    await startDraftFromProject(project.path, { workspaceIdentity: project.identity });
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: project.identity,
      expectedPath: project.path,
    });
    const sourceId = parseRemoteWorkspaceIdentity(project.identity)?.sourceServerId;
    if (!sourceId) throw new Error(`${CASE_MARKER}: 无法从 identity 解析 Source`);
    await disconnectRemoteSource(sourceId, CASE_MARKER, {
      workspaceIdentities: [project.identity],
    });
    const disconnected = await readRemoteTabSnapshot(project.identity);
    expect(disconnected.workspaceIdentity).toBe(project.identity);
    expect(disconnected.remoteSessionId).toBeNull();

    await installConnectProbe({ hold: "from-reconnect" });
    const fromLine = (await readMainLogLines()).length;
    await connectRemoteSourceFromSettings(sourceId, CASE_MARKER);
    await waitForDeviceStatus(sourceId, "online", CASE_MARKER);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    const pending = await waitForConnectCall(
      (entry) => entry.connectTrigger === "reconnect" && entry.workspacePath === project.path,
      `设备上线后没有自动重连 ${project.path}`,
    );
    expect((await readRemoteTabSnapshot(project.identity)).remoteSessionId).toBeNull();
    // 设置页连接设备时会建未指定目录的临时 session 并随即释放；等它释放后再点击，
    // 避免把“导航 join 临时 session”误当作“导航另建连接”。断开前的旧 session 以 closed 状态
    // 留在 Host，不能用 session 数归零判断。
    await browser.waitUntil(
      async () => {
        const settings = (await connectProbe()).entries.slice(0, pending.index);
        const disposed = (await readMainLogLines())
          .slice(fromLine)
          .filter((line) => /window Host topology, reason=remote-session-disposed/u.test(line));
        return settings.every((entry) => entry.settled) && disposed.length >= settings.length;
      },
      {
        timeout: 60_000,
        interval: 200,
        timeoutMsg: `${CASE_MARKER}: 设置页连接的临时 session 没有释放`,
      },
    );
    return pending.index;
  }

  /** 点击任务后的负向观察窗口：导航在途连接未结束前，不能连接设备，也不能另建连接。 */
  async function clickTaskAndExpectWaiting(project: typeof projectA) {
    // 展开项目也可能读取连接；计数只覆盖点击之后。
    await ensureProjectExpanded(project.path);
    const requestsBefore = await connectHostRequests();
    const callsBefore = (await connectProbe()).calls;
    await clickTestIdByDom(testId(TID_TASK_ITEM, project.taskId));
    // 旧实现点击后立即 connectHost，并在找不到 session 时另建一条未指定目录的连接。
    await browser.pause(3_000);
    expect(await connectHostRequests()).toBe(requestsBefore);
    expect((await connectProbe()).calls).toBe(callsBefore);
    await expectNoErrorToasts();
  }

  async function expectSingleSession(project: typeof projectA, owner: string) {
    await browser.pause(3_000);
    expect((await readRemoteTabSnapshot(project.identity)).remoteSessionId).toBe(owner);
    const topology = (await readMainLogLines())
      .filter((line) => /window Host topology, reason=/u.test(line))
      .at(-1);
    expect(topology).toMatch(/logicalSessions=1/u);
    await expectNoErrorToasts();
  }

  it("RPN-19 项目重连在途时点击同一项目的任务：导航等重连完成并复用，不另建连接，任务打开", async function () {
    this.timeout(10 * 60_000);
    const pendingIndex = await holdProjectReconnect(projectA);
    await clickTaskAndExpectWaiting(projectA);

    await startConnect(pendingIndex);
    const reconnect = await waitForConnectCall(
      (_entry, index) => index === pendingIndex,
      "项目 A 的重连没有完成真实连接",
      { settled: true },
    );
    await releaseConnect(reconnect.index);
    await waitForTaskOpenedWithoutError(projectA.taskId, "重连完成后任务没有打开");
    await saveArtifact("rpn-19-task-opened.png");
    // 全程只有这次重连一条连接：导航醒来后复用它，没有发出 ConnectRemote。
    expect((await connectProbe()).entries.slice(pendingIndex + 1)).toEqual([]);
    await expectSingleSession(projectA, reconnect.sessionId!);
  });

  it("RPN-20 Source 可恢复断连期间点击任务：恢复期间不连接设备，恢复后复用换代 session 打开任务", async function () {
    this.timeout(10 * 60_000);
    const container = readRemoteDockerContainer(CASE_MARKER);
    await resetRemoteTabs([projectA.identity, projectB.identity]);
    await startDraftFromProject(projectB.path, { workspaceIdentity: projectB.identity });
    const before = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: projectB.identity,
      expectedPath: projectB.path,
    });
    await installConnectProbe({ hold: "none" });
    await holdSessionReconnectedEvents();
    const fromLine = (await readMainLogLines()).length;
    await severDesktopSshSessions(container);
    // Host 自动恢复并把换代 session 的端口推给 renderer，换代事件被扣住：设备在线、任务可见。
    await waitForMainLog(
      fromLine,
      /renderer attachment ready, .*reason=source-server-reconnected/u,
      `${CASE_MARKER}: 传输中断后 Host 没有自动恢复`,
      120_000,
    );
    await browser.waitUntil(async () => (await heldReconnectedEvents()) > 0, {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 没有扣住换代事件`,
    });
    // 可恢复断连保留 tab 上的旧 id 等换代事件；被清空说明走了终止断连，前提不成立。
    // 换代 session 已注册，项目行按 attached 显示在线、任务可点，但 tab 的 owner 还没接回。
    expect((await readRemoteTabSnapshot(projectB.identity)).remoteSessionId).toBe(
      before.remoteSessionId,
    );

    await clickTaskAndExpectWaiting(projectB);
    await releaseReconnectedEvents();
    let recovered: string | null | undefined;
    await browser.waitUntil(
      async () => {
        recovered = (await readRemoteTabSnapshot(projectB.identity)).remoteSessionId;
        return Boolean(recovered && recovered !== before.remoteSessionId);
      },
      { timeout: 60_000, interval: 200, timeoutMsg: `${CASE_MARKER}: 项目 B 没有换代恢复` },
    );
    await waitForTaskOpenedWithoutError(projectB.taskId, "恢复完成后任务没有打开");
    await saveArtifact("rpn-20-task-opened.png");
    // 导航复用换代后的 session，没有发出 ConnectRemote。
    expect((await connectProbe()).calls).toBe(0);
    await expectSingleSession(projectB, recovered!);
  });

  /** 项目 tab 已连接后在设置页主动断开设备：tab 保留但没有 owner，设备离线。返回 Source id。 */
  async function disconnectProjectTab(project: typeof projectA) {
    await resetRemoteTabs([projectA.identity, projectB.identity]);
    await startDraftFromProject(project.path, { workspaceIdentity: project.identity });
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: project.identity,
      expectedPath: project.path,
    });
    const sourceId = parseRemoteWorkspaceIdentity(project.identity)?.sourceServerId;
    if (!sourceId) throw new Error(`${CASE_MARKER}: 无法从 identity 解析 Source`);
    await disconnectRemoteSource(sourceId, CASE_MARKER, {
      workspaceIdentities: [project.identity],
    });
    expect((await readRemoteTabSnapshot(project.identity)).remoteSessionId).toBeNull();
    return sourceId;
  }

  it("RPN-21b 导航自建连接先写入、项目重连后到并让出：查看文件落在在线 owner，回收后文件树仍可读", async function () {
    this.timeout(10 * 60_000);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const dir = `${projectA.path}/E2E_RPN21_DIR`;
    await execInRemoteContainer(container, [
      "sh",
      "-c",
      `mkdir -p '${dir}' && echo ok > '${dir}/inner.txt' && echo ok > '${projectA.path}/E2E_RPN21_ROOT.txt'`,
    ]);
    const sourceId = await disconnectProjectTab(projectA);
    await installConnectProbe({ hold: "nav-first" });
    const fromLine = (await readMainLogLines()).length;
    await connectRemoteSourceFromSettings(sourceId, CASE_MARKER);
    await waitForDeviceStatus(sourceId, "online", CASE_MARKER);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    // 设备上线后的自动重连被注入失败：key 离开集合，tab 仍没有 owner，设备在线。
    // Root 的 renderer 日志不落盘，以探针记录为准；即使导航赶上这次失败也只是等它结束。
    await waitForConnectCall((entry) => entry.injected, "自动重连没有按注入失败结束");
    expect((await readRemoteTabSnapshot(projectA.identity)).remoteSessionId).toBeNull();
    // 设置页连接会建未指定目录的临时 session 并随即释放；释放后再查看文件，避免导航 join 它。
    await browser.waitUntil(
      async () => {
        const settings = (await connectProbe()).entries.filter(
          (entry) => !entry.connectTrigger && !entry.injected,
        );
        const disposed = (await readMainLogLines())
          .slice(fromLine)
          .filter((line) => /window Host topology, reason=remote-session-disposed/u.test(line));
        return settings.every((entry) => entry.settled) && disposed.length >= settings.length;
      },
      {
        timeout: 60_000,
        interval: 200,
        timeoutMsg: `${CASE_MARKER}: 设置页连接的临时 session 没有释放`,
      },
    );

    await countReaddirBySession();
    await armNavHold();
    await ensureProjectExpanded(projectA.path);
    // 单 root 项目的查看文件按钮直接打开文件树；悬停层会拦截 WebDriver 点击，按 DOM 点击。
    expect(await clickProjectFilesButton(projectA.path)).toBe(true);
    // 导航已过两道等待门（当时没有在途重连），停在自建连接发起前。
    const nav = await waitForConnectCall(
      (entry) => !entry.connectTrigger && !entry.injected && !entry.started,
      "查看文件没有发起自建连接",
    );
    // 窄窗口：导航自建连接已开始，另一入口才开始同一目录的项目重连。
    await requestWorkspaceReconnectFromMobile(projectA.identity);
    const reconnect = await waitForConnectCall(
      (entry, index) => index > nav.index && entry.connectTrigger === "reconnect",
      "项目重连没有完成真实连接",
      { settled: true },
    );
    await browser.waitUntil(async () => (await readSessionOrder()).includes(reconnect.sessionId!), {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 重连 session 没有注册到 renderer`,
    });
    await startConnect(nav.index);
    const navCall = await waitForConnectCall(
      (_entry, index) => index === nav.index,
      "导航自建连接没有完成",
      { settled: true },
    );
    await browser.waitUntil(
      async () =>
        (await readRemoteTabSnapshot(projectA.identity)).remoteSessionId === navCall.sessionId,
      { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: 导航没有先写入 tab owner` },
    );
    // 竞态前提：重连的 session 先注册到 renderer，导航的 session 后注册但先写入 tab。
    const order = await readSessionOrder();
    expect(order.indexOf(reconnect.sessionId!)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(reconnect.sessionId!)).toBeLessThan(order.indexOf(navCall.sessionId!));
    const panel = $(`[data-testid="${TID_WORKSPACE_FILE_TREE_PANEL}"]`);
    await panel.waitForDisplayed({ timeout: 60_000 });
    await waitForFileTreeRow(`${projectA.path}/E2E_RPN21_ROOT.txt`, "文件树没有显示远端文件");
    const beforeYield = await readReaddirCounts();
    await saveArtifact("rpn-21b-files-before-yield.png");

    const yieldLine = (await readMainLogLines()).length;
    await releaseConnect(reconnect.index);
    await waitForMainLog(
      yieldLine,
      /window Host topology, reason=remote-session-disposed, .*logicalSessions=1/u,
      `${CASE_MARKER}: 重连没有让出并回收自己的 session`,
      60_000,
    );
    expect((await readRemoteTabSnapshot(projectA.identity)).remoteSessionId).toBe(
      navCall.sessionId,
    );
    // 被回收的重连 session 不能影响文件树：展开子目录、刷新后的新文件都要读到。
    await clickFileTreeRow(dir);
    await waitForFileTreeRow(`${dir}/inner.txt`, "让出后展开子目录没有读到内容");
    await execInRemoteContainer(container, [
      "sh",
      "-c",
      `echo ok > '${projectA.path}/E2E_RPN21_AFTER.txt'`,
    ]);
    await clickTestIdByDom(TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON);
    await waitForFileTreeRow(`${projectA.path}/E2E_RPN21_AFTER.txt`, "让出后刷新没有读到新文件");
    const afterYield = await readReaddirCounts();
    await saveArtifact("rpn-21b-files-after-yield.png");
    await writeFile(
      join(artifactDir, "rpn-21b-readdir.json"),
      JSON.stringify(
        { reconnect: reconnect.sessionId, nav: navCall.sessionId, order, beforeYield, afterYield },
        null,
        2,
      ),
    );
    await expectSingleSession(projectA, navCall.sessionId!);
    // 让出后文件树只经在线 owner 读取，不再使用被回收的重连 session。
    expect(afterYield[reconnect.sessionId!] ?? 0).toBe(beforeYield[reconnect.sessionId!] ?? 0);
  });

  it("RPN-22 Source 恢复换代失败后点击任务：恢复失败按普通点击处理，任务打开", async function () {
    this.timeout(10 * 60_000);
    const container = readRemoteDockerContainer(CASE_MARKER);
    await resetRemoteTabs([projectA.identity, projectB.identity]);
    await startDraftFromProject(projectB.path, { workspaceIdentity: projectB.identity });
    const before = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: projectB.identity,
      expectedPath: projectB.path,
    });
    await installConnectProbe({ hold: "none" });
    const fromLine = (await readMainLogLines()).length;
    await failNextScopedPortDelivery();
    await severDesktopSshSessions(container);
    // Host 已自动恢复 Source，但 Main 把换代 session 交给窗口时失败，只能回收这条换代 session。
    await waitForMainLog(
      fromLine,
      /Source reconnect attachment failed/u,
      `${CASE_MARKER}: 恢复换代没有按注入失败结束`,
      120_000,
    );
    await restoreScopedPortDelivery();
    await saveArtifact("rpn-22-recovery-failed.png");

    // spec §7：恢复失败后按普通点击处理——点击任务应自建连接并打开，不能一直等在途恢复。
    await ensureProjectExpanded(projectB.path);
    await clickTestIdByDom(testId(TID_TASK_ITEM, projectB.taskId));
    await waitForTaskOpenedWithoutError(projectB.taskId, "恢复换代失败后点击的任务没有打开");
    await saveArtifact("rpn-22-task-opened.png");
    const owner = (await readRemoteTabSnapshot(projectB.identity)).remoteSessionId;
    expect(owner).toBeTruthy();
    expect(owner).not.toBe(before.remoteSessionId);
    await expectSingleSession(projectB, owner!);
  });

  /**
   * 切断 SSH，让换代 session 在 renderer 登记后因 ready 超时被 Main 回收，再把 ACK 交给 Main。
   * 不在这里断言释放结果：修复前的失败由后续导航断言按用户可见症状报告。
   */
  async function failReconnectWithLateReadyAck(project: typeof projectA) {
    const container = readRemoteDockerContainer(CASE_MARKER);
    await execInRemoteContainer(container, [
      "sh",
      "-c",
      `echo ok > '${project.path}/E2E_RPN23_ROOT.txt'`,
    ]);
    await resetRemoteTabs([projectA.identity, projectB.identity]);
    await startDraftFromProject(project.path, { workspaceIdentity: project.identity });
    const before = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: project.identity,
      expectedPath: project.path,
    });
    const fromLine = (await readMainLogLines()).length;
    await watchClosedScopedPorts();
    await holdCandidateReadyAck(before.remoteSessionId!);
    await severDesktopSshSessions(container);
    await waitForMainLog(
      fromLine,
      /renderer attachment ready timeout/u,
      `${CASE_MARKER}: 换代 session 没有按 ready 超时结束`,
      120_000,
    );
    await waitForMainLog(
      fromLine,
      /Source reconnect attachment failed/u,
      `${CASE_MARKER}: 恢复换代没有按超时失败结束`,
    );
    const [ack] = await heldReadyAcks();
    if (!ack) throw new Error(`${CASE_MARKER}: renderer 没有登记换代 session，未命中竞态前提`);
    expect(await readSessionOrder()).toContain(ack.sessionId);
    const lateAckLine = (await readMainLogLines()).length;
    await releaseReadyAck();
    await waitForMainLog(
      lateAckLine,
      /ignore stale renderer attachment ready/u,
      `${CASE_MARKER}: Main 没有处理迟到的 ready`,
    );
    // renderer 注销 session 时关闭其 port，这是窗口释放完成的信号；未释放时继续走到导航断言。
    await browser
      .waitUntil(async () => (await closedPortSessions()).includes(ack.sessionId), {
        timeout: 5_000,
        interval: 50,
      })
      .catch(() => undefined);
    return { previous: before.remoteSessionId!, candidate: ack.sessionId };
  }

  it("RPN-23a 换代 session 已登记但 ready 晚于超时：第一次点击任务即自建连接并打开", async function () {
    this.timeout(10 * 60_000);
    const { previous, candidate } = await failReconnectWithLateReadyAck(projectB);
    await saveArtifact("rpn-23-recovery-failed.png");

    await ensureProjectExpanded(projectB.path);
    await clickTestIdByDom(testId(TID_TASK_ITEM, projectB.taskId));
    await waitForTaskOpenedWithoutError(projectB.taskId, "迟到 ready 后第一次点击的任务没有打开");
    await saveArtifact("rpn-23-task-opened.png");
    const owner = (await readRemoteTabSnapshot(projectB.identity)).remoteSessionId;
    expect(owner).toBeTruthy();
    expect([previous, candidate]).not.toContain(owner);
    expect(await closedPortSessions()).toContain(candidate);
    await expectSingleSession(projectB, owner!);
  });

  it("RPN-23b 换代 session 已登记但 ready 晚于超时：查看文件自建连接，不读失效 session", async function () {
    this.timeout(10 * 60_000);
    const { previous, candidate } = await failReconnectWithLateReadyAck(projectB);

    await countReaddirBySession();
    await ensureProjectExpanded(projectB.path);
    expect(await clickProjectFilesButton(projectB.path)).toBe(true);
    await waitForFileTreeRow(
      `${projectB.path}/E2E_RPN23_ROOT.txt`,
      "迟到 ready 后查看文件没有读到远端文件",
      60_000,
    );
    await saveArtifact("rpn-23-files-opened.png");
    expect((await readReaddirCounts())[candidate] ?? 0).toBe(0);
    const owner = (await readRemoteTabSnapshot(projectB.identity)).remoteSessionId;
    expect(owner).toBeTruthy();
    expect([previous, candidate]).not.toContain(owner);
    expect(await closedPortSessions()).toContain(candidate);
    await expectSingleSession(projectB, owner!);
  });

  /** 旧查看失效后的负向观察：不连接设备、不切换 tab、不提示错误，文件树仍是后一个项目。 */
  async function expectStaleFilesIgnored(latest: typeof projectA, file: string, requests: number) {
    await browser.pause(3_000);
    expect(await connectHostRequests()).toBe(requests);
    expect((await readRemoteTabSnapshot(latest.identity)).activeWorkspaceIdentity).toBe(
      latest.identity,
    );
    await waitForFileTreeRow(`${latest.path}/${file}`, "旧查看失效后文件树不再是后一个项目");
    await expectNoErrorToasts();
  }

  it("RPN-24a 项目重连在途时查看其文件，再查看另一项目：重连结束后旧查看不连接、不切换 tab", async function () {
    this.timeout(10 * 60_000);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const file = "E2E_RPN24A_ROOT.txt";
    await execInRemoteContainer(container, ["sh", "-c", `echo ok > '${projectB.path}/${file}'`]);
    const pendingIndex = await holdProjectReconnect(projectA);

    await ensureProjectExpanded(projectA.path);
    const requestsBefore = await connectHostRequests();
    const callsBefore = (await connectProbe()).calls;
    expect(await clickProjectFilesButton(projectA.path)).toBe(true);
    // 前提：A 的查看停在等重连，没有连接设备。
    await browser.pause(3_000);
    expect(await connectHostRequests()).toBe(requestsBefore);
    expect((await connectProbe()).calls).toBe(callsBefore);

    // B 没有 tab：查看文件自建连接；from-reconnect 模式扣住结果，等它完成后单独放行。
    await ensureProjectExpanded(projectB.path);
    expect(await clickProjectFilesButton(projectB.path)).toBe(true);
    const nav = await waitForConnectCall(
      (entry, index) => index > pendingIndex && !entry.connectTrigger,
      "查看 B 的文件没有发起连接",
      { settled: true },
    );
    await releaseConnect(nav.index);
    await waitForFileTreeRow(`${projectB.path}/${file}`, "B 的文件树没有打开", 60_000);
    const requestsAfterB = await connectHostRequests();

    await startConnect(pendingIndex);
    const reconnect = await waitForConnectCall(
      (_entry, index) => index === pendingIndex,
      "项目 A 的重连没有完成真实连接",
      { settled: true },
    );
    await releaseConnect(reconnect.index);
    await browser.waitUntil(
      async () =>
        (await readRemoteTabSnapshot(projectA.identity)).remoteSessionId === reconnect.sessionId,
      { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: 项目 A 的重连没有写回 tab` },
    );
    // 旧实现：A 的查看醒来后 connectHost 并 bind，把当前 tab 切回 A 并新建草稿。
    await expectStaleFilesIgnored(projectB, file, requestsAfterB);
    await saveArtifact("rpn-24a-latest-files-kept.png");
  });

  it("RPN-24b 首连期间先查看 A 的文件再查看同设备 B 的文件：只连接一次，B 的文件树打开、无错误提示", async function () {
    this.timeout(10 * 60_000);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const file = "E2E_RPN24B_ROOT.txt";
    await execInRemoteContainer(container, ["sh", "-c", `echo ok > '${projectB.path}/${file}'`]);
    await resetRemoteTabs([projectA.identity, projectB.identity]);
    await installConnectProbe({ hold: "all" });

    const requestsBefore = await connectHostRequests();
    await ensureProjectExpanded(projectA.path);
    expect(await clickProjectFilesButton(projectA.path)).toBe(true);
    await browser.waitUntil(async () => (await connectProbe()).held === 1, {
      timeout: 120_000,
      timeoutMsg: `${CASE_MARKER}: 查看 A 的文件没有完成真实连接`,
    });
    await ensureProjectExpanded(projectB.path);
    expect(await clickProjectFilesButton(projectB.path)).toBe(true);
    await browser.waitUntil(async () => (await connectHostRequests()) >= requestsBefore + 2, {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 查看 B 的文件没有走到连接阶段`,
    });
    await browser.pause(2_000);
    // 前提：B 加入 A 的在途连接，没有另发 ConnectRemote。
    expect((await connectProbe()).calls).toBe(1);

    await browser.electron.execute(() => globalThis.__rpn18ConnectProbe?.release());
    // 旧实现：A 先接管连接并绑定 A，B 报 project.navigation-cancelled，文件树不打开。
    await waitForFileTreeRow(`${projectB.path}/${file}`, "最新查看的文件树没有打开", 60_000);
    await expectStaleFilesIgnored(projectB, file, await connectHostRequests());
    expect((await readRemoteTabSnapshot(projectA.identity)).workspaceIdentity).toBeNull();
    expect((await connectProbe()).calls).toBe(1);
    await saveArtifact("rpn-24b-latest-files-opened.png");
  });
});
