import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import type { ProjectTree } from "@zcode/services";
import { ServiceChannels } from "@zcode/shared";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import { ensureUpstreamProviderForE2E } from "#e2e/helpers/upstream-provider";
import {
  clickV4Stop,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const CASE_TIMEOUT_MS = 120_000;
const PROMPT_MARKER = "E2E_SIDEBAR_STOP_STATUS_RACE";
interface SidebarIndicatorProbe {
  seenTerminal: boolean;
  loadingReappeared: boolean;
}
interface ProjectReadHold {
  requests: number[][];
  release(index: number, response: number[]): void;
  restore(): void;
}
declare global {
  interface Window {
    __sidebarProjectReadHold?: ProjectReadHold;
  }
}

describe("TSL18：Stop 终态拒绝在途旧项目目录回包", () => {
  afterEach(async () => {
    await browser.execute(() => window.__sidebarProjectReadHold?.restore()).catch(() => undefined);
    await restoreHandoffProbes().catch(() => undefined);
    await disposeSidebarIndicatorProbe().catch(() => undefined);
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("running refresh 在途时 Stop，旧回包返回后侧栏 spinner 消失且不回弹", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await prepareV4ConversationE2E();
    await ensureUpstreamProviderForE2E();
    await sendV4Prompt(`E2E_SLOW_STREAM ${PROMPT_MARKER}: Reply with exactly "upstream-e2e-ok".`);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.canStop && snapshot.sessionId !== null && snapshot.sessionId !== "draft",
      "TSL18 前置请求没有进入正式 session 的 controlled streaming",
      45_000,
    );
    const taskId = (await getV4PaneSnapshot()).sessionId!;
    await waitForTaskLoadingIndicator(taskId, true, "running task 没有显示侧栏 spinner");

    // 旧 membership 聚合器已退役，旧 gate 不再被产品调用。只暂挂当前目录 RPC，
    // 快照来自真实 Host；Controller 活动与 Stop 命令仍沿正式链路交付。
    await installHandoffRpcProbe();
    await holdProjectReads();
    const request = await waitForHeldProjectRead(0);
    const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(request)));
    const header = deserialize(reader);
    expect(header).toEqual([100, expect.any(Number), ServiceChannels.Project, "readTree"]);
    const args = deserialize(reader);
    const runningTree = await callHandoffHost<ProjectTree>(
      ServiceChannels.Project,
      "readTree",
      args,
    );
    // 项目目录只持有成员事实；running 由 Controller 活动投影提供，不应要求目录带 status。
    expect(runningTree.tasks.find((task) => task.taskId === taskId)).toBeDefined();
    await waitForTaskLoadingIndicator(taskId, true, "目录暂挂期间受控请求意外结束");

    await installSidebarIndicatorProbe(taskId);
    await clickV4Stop();
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "TSL18 Stop 后 conversation 没有退出 streaming",
      30_000,
    );
    await waitForTaskLoadingIndicator(taskId, false, "目录回包暂挂时 Stop 终态没有到达侧栏");

    const writer = new BufferWriter();
    serialize(writer, [201, header[1]]);
    serialize(writer, runningTree);
    await browser.execute((response) => {
      window.__sidebarProjectReadHold!.release(0, response);
      window.dispatchEvent(new Event("focus"));
    }, Array.from(writer.buffer.buffer));
    // 下一轮目录请求是旧读取已结束的屏障，不以延时猜测旧快照是否已被消费。
    await waitForHeldProjectRead(1);
    await waitForTwoAnimationFrames();
    await waitForTaskLoadingIndicator(taskId, false, "旧 running 目录回包使 Stop spinner 回弹");
    expect(await getSidebarIndicatorProbe()).toEqual({
      seenTerminal: true,
      loadingReappeared: false,
    });
    await browser.execute(() => window.__sidebarProjectReadHold!.restore());
  });
});

async function holdProjectReads() {
  await browser.execute((channel) => {
    const original = MessagePort.prototype.postMessage;
    const held = new Map<number, { port: MessagePort; data: Uint8Array }>();
    const probe: ProjectReadHold = {
      requests: [],
      release(index, response) {
        const request = held.get(index);
        if (!request) throw new Error("Missing held project read");
        held.delete(index);
        request.port.dispatchEvent(
          new MessageEvent("message", { data: Uint8Array.from(response) }),
        );
      },
      restore() {
        MessagePort.prototype.postMessage = original;
        for (const request of held.values()) original.call(request.port, request.data);
        held.clear();
        delete window.__sidebarProjectReadHold;
      },
    };
    MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
      if (message instanceof Uint8Array) {
        const text = new TextDecoder().decode(message);
        if (text.includes(channel) && text.includes("readTree")) {
          held.set(probe.requests.length, { port: this, data: message.slice() });
          probe.requests.push(Array.from(message));
          return;
        }
      }
      Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
    };
    window.__sidebarProjectReadHold = probe;
    window.dispatchEvent(new Event("focus"));
  }, ServiceChannels.Project);
}
async function waitForHeldProjectRead(index: number): Promise<number[]> {
  await browser.waitUntil(
    () => browser.execute((i) => Boolean(window.__sidebarProjectReadHold?.requests[i]), index),
    { timeout: 30_000, timeoutMsg: `TSL18 未截获第 ${index + 1} 次真实项目目录读取` },
  );
  return browser.execute((i) => window.__sidebarProjectReadHold!.requests[i]!, index);
}

// 旋转动画已移到图标外的 HTML 槽位，按状态样式观察，不能限定 SVG。
async function waitForTaskLoadingIndicator(taskId: string, expected: boolean, timeoutMsg: string) {
  await browser.waitUntil(
    () =>
      browser
        .execute(
          (taskItemTestId) =>
            Boolean(
              document
                .querySelector<HTMLElement>(`[data-testid="${taskItemTestId}"]`)
                ?.querySelector(".animate-spin"),
            ),
          testId(TID_TASK_ITEM, taskId),
        )
        .then((loading) => loading === expected),
    { timeout: 30_000, timeoutMsg },
  );
}

async function installSidebarIndicatorProbe(taskId: string) {
  const installed = await browser.execute(
    (taskItemTestId) => {
      type ProbeWindow = Window & {
        __zcodeSidebarIndicatorProbe?: SidebarIndicatorProbe & {
          observer: MutationObserver;
        };
      };
      const probeWindow = window as ProbeWindow;
      probeWindow.__zcodeSidebarIndicatorProbe?.observer.disconnect();
      const probe = {
        seenTerminal: false,
        loadingReappeared: false,
        observer: null as unknown as MutationObserver,
      };
      const sample = () => {
        const row = document.querySelector<HTMLElement>(`[data-testid="${taskItemTestId}"]`);
        if (!row) return;
        const loading = Boolean(row.querySelector(".animate-spin"));
        if (!loading) {
          probe.seenTerminal = true;
        } else if (probe.seenTerminal) {
          probe.loadingReappeared = true;
        }
      };
      probe.observer = new MutationObserver(sample);
      probe.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      probeWindow.__zcodeSidebarIndicatorProbe = probe;
      sample();
      return Boolean(document.querySelector(`[data-testid="${taskItemTestId}"]`));
    },
    testId(TID_TASK_ITEM, taskId),
  );
  expect(installed).toBe(true);
}

async function getSidebarIndicatorProbe(): Promise<SidebarIndicatorProbe | null> {
  return browser.execute(() => {
    const probe = (
      window as Window & {
        __zcodeSidebarIndicatorProbe?: SidebarIndicatorProbe;
      }
    ).__zcodeSidebarIndicatorProbe;
    return probe
      ? {
          seenTerminal: probe.seenTerminal,
          loadingReappeared: probe.loadingReappeared,
        }
      : null;
  });
}

async function disposeSidebarIndicatorProbe() {
  await browser.execute(() => {
    type ProbeWindow = Window & {
      __zcodeSidebarIndicatorProbe?: SidebarIndicatorProbe & {
        observer?: MutationObserver;
      };
    };
    const probeWindow = window as ProbeWindow;
    probeWindow.__zcodeSidebarIndicatorProbe?.observer?.disconnect();
    delete probeWindow.__zcodeSidebarIndicatorProbe;
  });
}

async function waitForTwoAnimationFrames() {
  await browser.executeAsync((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  });
}
