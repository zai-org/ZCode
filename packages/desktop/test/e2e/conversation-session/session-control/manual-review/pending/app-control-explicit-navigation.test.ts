import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { TID_TASK_ITEM, TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import { openMobilePairingPage } from "#e2e/helpers/mobile-pairing";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  readAppControlToolResult,
  type AppControlToolEvidence,
} from "#e2e/helpers/app-control-evidence";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { obtainUnreadPairingUrl, waitMobileTaskView } from "#e2e/helpers/web-remote-unread";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";
import {
  prepareV4ConversationE2E,
  getV4PaneSnapshot,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4AssistantMessageContaining,
  waitForV4PermissionDialog,
  approveV4Permission,
} from "#e2e/helpers/v4-conversation";

const CASE = "E2E_SCT03";
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR!;
const tools: AppControlToolEvidence = {};
interface NavigationHistorySnapshot {
  entries: Array<{
    kind: string;
    taskId?: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
  cursor: number;
}
const navigationHistory: Array<{
  phase: string;
  sessionId: string | null;
  history: NavigationHistorySnapshot;
}> = [];
const evidence: Record<string, unknown> = { tools, navigationHistory };

async function captureNavigationHistory(phase: string) {
  const history = await browser.execute(() => {
    const bridge = (
      window as Window & {
        __zcodeSessionStoreE2E?: { getState(): { taskNavHistory: NavigationHistorySnapshot } };
      }
    ).__zcodeSessionStoreE2E;
    if (!bridge) throw new Error("SCT03 session store E2E bridge is unavailable");
    return bridge.getState().taskNavHistory;
  });
  navigationHistory.push({ phase, sessionId: (await getV4PaneSnapshot()).sessionId, history });
  return history;
}

async function navigateHistory(direction: "back" | "forward", sessionId: string, phase: string) {
  const before = await captureNavigationHistory(`${phase}-before-${direction}`);
  const button = $(
    direction === "back"
      ? '[data-testid="desktop-top-nav-back"]'
      : 'button[aria-label="Go forward"]',
  );
  let after: NavigationHistorySnapshot;
  try {
    await button.waitForEnabled({ timeout: 10_000 });
    await button.click();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId,
      `${CASE} ${phase} ${direction} did not open ${sessionId}`,
      10_000,
    );
  } finally {
    // 旧列表缓存 miss 曾把仍存在的历史项删掉；失败现场也保留栈，不能靠侧栏重选绕过。
    after = await captureNavigationHistory(`${phase}-after-${direction}`);
  }
  expect(after.entries).toEqual(before.entries);
  expect(after.cursor).toBe(before.cursor + (direction === "back" ? -1 : 1));
  expect(after.entries[after.cursor]?.taskId).toBe(sessionId);
}

interface TaskMetaProbe {
  request?: number[];
  response?: number[];
  start(request: number[], prefixes: number[][], originalPrefixes: number[][]): void;
  release(response?: number[]): Promise<void>;
  restore(): void;
}
declare global {
  interface Window {
    __sct03TaskMetaProbe?: TaskMetaProbe;
  }
}

/** 沿真实 Window Host RPC 暂挂一次 meta 返回；不伪造成功结果，也不改 store。 */
async function holdTaskMeta(taskId: string) {
  await browser.execute(
    (channel, targetId) => {
      const original = MessagePort.prototype.postMessage;
      let port:
        | (Pick<MessagePort, "addEventListener" | "removeEventListener" | "dispatchEvent"> & {
            send: MessagePort["postMessage"];
          })
        | undefined;
      let receive: ((event: MessageEvent) => void) | undefined;
      let started = false;
      const probe: TaskMetaProbe = {
        start(request, prefixes, originalPrefixes) {
          if (!port || !probe.request) throw new Error("SCT03 missing held meta request");
          receive = (event) => {
            if (!(event.data instanceof Uint8Array)) return;
            const index = prefixes.findIndex((prefix) =>
              prefix.every((byte, offset) => event.data[offset] === byte),
            );
            if (index < 0) return;
            // MessagePort 的 capture listener 不先于已注册 listener；用独立请求 ID 隔离回执，
            // 只还原响应头，真实 Host body 原样保留，release 前不完成产品请求。
            probe.response = [
              ...originalPrefixes[index]!,
              ...event.data.slice(prefixes[index]!.length),
            ];
            port!.removeEventListener("message", receive!);
          };
          port.addEventListener("message", receive);
          started = true;
          port.send(Uint8Array.from(request));
        },
        async release(response) {
          if (!port || !probe.response) throw new Error("SCT03 missing real meta response");
          const data = Uint8Array.from(response ?? probe.response);
          delete probe.response;
          port.dispatchEvent(new MessageEvent("message", { data }));
          // 等响应的 promise 微任务和随后 UI 绘制，不用固定延时猜测迟到结果已消费。
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        },
        restore() {
          MessagePort.prototype.postMessage = original;
          if (receive) port?.removeEventListener("message", receive);
          if (probe.response)
            port?.dispatchEvent(
              new MessageEvent("message", {
                data: Uint8Array.from(probe.response),
              }),
            );
          else if (!started && probe.request) port?.send(Uint8Array.from(probe.request));
          delete window.__sct03TaskMetaProbe;
        },
      };
      MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
        if (!probe.request && message instanceof Uint8Array) {
          const text = new TextDecoder().decode(message);
          if (text.includes(channel) && text.includes("getTaskMeta") && text.includes(targetId)) {
            port = {
              send: original.bind(this),
              addEventListener: this.addEventListener.bind(this),
              removeEventListener: this.removeEventListener.bind(this),
              dispatchEvent: this.dispatchEvent.bind(this),
            };
            probe.request = Array.from(message);
            return;
          }
        }
        Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
      };
      window.__sct03TaskMetaProbe = probe;
    },
    ServiceChannels.ZCodeTask,
    taskId,
  );
}

async function waitForRealTaskMeta(taskId: string, phase: string) {
  await browser.waitUntil(
    () => browser.execute(() => Boolean(window.__sct03TaskMetaProbe?.request)),
    {
      timeout: 10_000,
      timeoutMsg: "SCT03 navigation did not query Host getTaskMeta",
    },
  );
  const request = await browser.execute(() => window.__sct03TaskMetaProbe!.request!);
  const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(request)));
  const header = deserialize(reader) as [number, number, string, string];
  const args = deserialize(reader);
  expect(header).toEqual([100, expect.any(Number), ServiceChannels.ZCodeTask, "getTaskMeta"]);
  expect(args).toEqual([expect.objectContaining({ workspacePath: DEFAULT_WORKSPACE, taskId })]);
  const probeId = -9400 - header[1];
  const wireRequest = new BufferWriter();
  serialize(wireRequest, [100, probeId, header[2], header[3]]);
  serialize(wireRequest, args);
  const responsePrefixes = (id: number) =>
    [201, 202, 203].map((type) => {
      const writer = new BufferWriter();
      serialize(writer, [type, id]);
      return Array.from(writer.buffer.buffer);
    });
  await browser.execute(
    (request, prefixes, originalPrefixes) =>
      window.__sct03TaskMetaProbe!.start(request, prefixes, originalPrefixes),
    Array.from(wireRequest.buffer.buffer),
    responsePrefixes(probeId),
    responsePrefixes(header[1]),
  );
  await browser.waitUntil(
    () => browser.execute(() => Boolean(window.__sct03TaskMetaProbe?.response)),
    {
      timeout: 10_000,
      timeoutMsg: "SCT03 Host did not return the real task meta",
    },
  );
  const response = await browser.execute(() => window.__sct03TaskMetaProbe!.response!);
  const responseReader = new BufferReader(VSBuffer.wrap(Uint8Array.from(response)));
  const responseHeader = deserialize(responseReader);
  const meta = deserialize(responseReader);
  evidence[phase] = { header, probeId, args, responseHeader, meta };
  expect(responseHeader).toEqual([201, header[1]]);
  expect(meta).toEqual(expect.objectContaining({ taskId }));
  return header[1];
}

// SCT03 accepted；保持 pending，capture 只作为人工 review 证据，不自动转正。
// 工具必须由真实 Agent 调用；测试不注入导航事件，也不直接写 UI store。
describe(`${CASE}: explicit App session navigation`, () => {
  let mobile: Browser | undefined;
  after(async () => {
    await browser.execute(() => window.__sct03TaskMetaProbe?.restore());
    await mobile?.close();
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(join(artifacts, "SCT03-navigation.json"), JSON.stringify(evidence, null, 2));
      await browser.saveScreenshot(join(artifacts, "SCT03-desktop.png"));
    }
    await clearAppData();
  });

  it("SCT03 / SCT02: sidebar and tool navigation share back/forward history; mobile stays on caller", async function () {
    this.timeout(300_000);
    await ensureReadonlyToolFixtureFile();
    await prepareV4ConversationE2E();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await sendV4Prompt(buildReadonlyToolPrompt(`${CASE}_TARGET`));
    await waitForV4AssistantMessageContaining("upstream-e2e-ok", 90_000);
    const targetId = (await getV4PaneSnapshot()).sessionId;
    expect(targetId).toBeTruthy();
    expect(targetId).not.toBe("draft");

    await startDraftFromProject(DEFAULT_WORKSPACE);
    await sendV4Prompt(buildReadonlyToolPrompt(`${CASE}_CALLER`));
    await waitForV4AssistantMessageContaining("upstream-e2e-ok", 90_000);
    const callerId = (await getV4PaneSnapshot()).sessionId;
    expect(callerId).toBeTruthy();
    expect(callerId).not.toBe(targetId);
    await $(`[data-testid="${testId(TID_TASK_ITEM, targetId!)}"]`).waitForExist({
      timeout: 30_000,
    });
    await $(`[data-testid="${testId(TID_TASK_ITEM, callerId!)}"]`).waitForExist({
      timeout: 30_000,
    });
    evidence.target = { workspacePath: DEFAULT_WORKSPACE, sessionId: targetId };
    evidence.callerId = callerId;

    const pairUrl = await obtainUnreadPairingUrl();
    mobile = await chromium.launch({
      ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
      headless: true,
    });
    const context = await mobile.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript((credentials) => {
      for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
    }, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
    const page = await context.newPage();
    await openMobilePairingPage(page, pairUrl, {
      artifactDir: artifacts,
      caseMarker: CASE,
      phase: "navigation",
      readySelector: '[data-testid="sidebar"]',
    });
    await page.getByTestId(testId(TID_TASK_ITEM, callerId!)).click();
    await waitMobileTaskView({ workspacePath: DEFAULT_WORKSPACE, taskId: callerId! });
    const mobilePane = page.locator(
      `[data-testid^="${TID_V4_SESSION_PANE}-"][data-session-id="${callerId}"]`,
    );
    await mobilePane.waitFor();

    // 普通侧栏先覆盖 B→A→back B→forward A，与后面的真实工具共用同一历史。
    await selectV4TaskById(targetId!);
    await selectV4TaskById(callerId!);
    await navigateHistory("back", targetId!, "sidebar");
    await waitMobileTaskView({ workspacePath: DEFAULT_WORKSPACE, taskId: callerId! });
    expect(await mobilePane.isVisible()).toBe(true);
    await navigateHistory("forward", callerId!, "sidebar");
    await waitMobileTaskView({ workspacePath: DEFAULT_WORKSPACE, taskId: callerId! });
    expect(await mobilePane.isVisible()).toBe(true);

    await sendV4Prompt(
      `${CASE}_BACKGROUND: E2E_SCT03_TARGET_SESSION_ID:${targetId}. First call ListSessions in the current project and select sessionId=${targetId} from its returned entries. Preserve the COMPLETE returned session ref including sourceServerId, workspaceIdentity and project. Use ReadSession on that exact ref with view=summary, then SendToSession with the same ref (step marker ${CASE}_SEND; do not pass requestId) and prompt='${CASE}_BACKGROUND_TARGET: reply exactly background-done'. Do not open or switch any UI. After both tool results return, reply exactly SCT03_BACKGROUND_ACCEPTED.`,
    );
    await waitForV4PermissionDialog();
    expect(await approveV4Permission()).toBe(true);
    await waitForV4AssistantMessageContaining("SCT03_BACKGROUND_ACCEPTED", 90_000);
    const beforeOpen = await getV4PaneSnapshot();
    expect(beforeOpen.sessionId).toBe(callerId);
    const sendCapture = await waitForUpstreamNetworkCapture("toolu_sct03_send");
    const listed = readAppControlToolResult<{
      sessions: Array<{ session: { sessionId: string } }>;
    }>(sendCapture.requestJson, "toolu_sct03_list", tools);
    expect(listed.sessions.some((entry) => entry.session.sessionId === targetId)).toBe(true);
    const read = readAppControlToolResult<{
      view: string;
      summary: { session: { sessionId: string } };
    }>(sendCapture.requestJson, "toolu_sct03_read", tools);
    expect(read.view).toBe("summary");
    expect(read.summary.session.sessionId).toBe(targetId);
    const sent = readAppControlToolResult<{ admission: string; session: { sessionId: string } }>(
      sendCapture.requestJson,
      "toolu_sct03_send",
      tools,
    );
    expect(sent.admission).toBe("accepted");
    expect(sent.session.sessionId).toBe(targetId);
    await waitMobileTaskView({ workspacePath: DEFAULT_WORKSPACE, taskId: callerId! });
    evidence.backgroundDesktop = beforeOpen.sessionId;
    const historyBeforeOpen = await captureNavigationHistory("tool-before-open");

    await sendV4Prompt(
      `${CASE}_OPEN: Use OpenSession once on sessionId=${targetId}, using the COMPLETE ref returned by ListSessions in the previous turn. Preserve sourceServerId, workspaceIdentity and project exactly. Use the trusted current desktop UI binding (omit uiTarget). Do not call another tool. When it returns, reply exactly SCT03_OPEN_CONFIRMED and include its returned status.`,
    );
    await waitForV4PermissionDialog();
    expect(await approveV4Permission()).toBe(true);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === targetId,
      "SCT03 explicit tool did not open the target desktop session",
      90_000,
    );
    await waitMobileTaskView({ workspacePath: DEFAULT_WORKSPACE, taskId: callerId! });
    expect(await mobilePane.isVisible()).toBe(true);
    evidence.openedDesktop = (await getV4PaneSnapshot()).sessionId;
    evidence.mobileStayedOn = callerId;
    await page.screenshot({ path: join(artifacts, "SCT03-mobile.png") });

    const historyAfterOpen = await captureNavigationHistory("tool-after-open");
    expect(historyAfterOpen.cursor).toBe(historyBeforeOpen.cursor + 1);
    expect(historyAfterOpen.entries.slice(0, historyBeforeOpen.cursor + 1)).toEqual(
      historyBeforeOpen.entries.slice(0, historyBeforeOpen.cursor + 1),
    );
    expect(historyAfterOpen.entries[historyAfterOpen.cursor]?.taskId).toBe(targetId);

    // 通过 back 返回调用会话读取真实回执，确保工具导航与普通选择共用历史。
    await navigateHistory("back", callerId!, "tool");
    await waitMobileTaskView({ workspacePath: DEFAULT_WORKSPACE, taskId: callerId! });
    expect(await mobilePane.isVisible()).toBe(true);
    await waitForV4AssistantMessageContaining("SCT03_OPEN_CONFIRMED", 90_000);
    const receipt = await getV4PaneSnapshot();
    const openCapture = await waitForUpstreamNetworkCapture("toolu_sct03_open");
    expect(
      readAppControlToolResult<{ status: string }>(
        openCapture.requestJson,
        "toolu_sct03_open",
        tools,
      ).status,
    ).toBe("opened");
    expect(receipt.timelineText).toContain("opened");
    evidence.receipt = receipt.timelineText;
    await navigateHistory("forward", targetId!, "tool");
    await waitMobileTaskView({ workspacePath: DEFAULT_WORKSPACE, taskId: callerId! });
    expect(await mobilePane.isVisible()).toBe(true);

    const beforeFailure = await captureNavigationHistory("query-error-before-back");
    await holdTaskMeta(callerId!);
    await $('[data-testid="desktop-top-nav-back"]').click();
    const requestId = await waitForRealTaskMeta(callerId!, "queryErrorRpc");
    expect(await captureNavigationHistory("query-error-pending")).toEqual(beforeFailure);
    const failure = new BufferWriter();
    serialize(failure, [202, requestId]);
    serialize(failure, { name: "Error", message: "E2E_SCT03_GET_TASK_META_FAILED" });
    await browser.execute(
      (response) => window.__sct03TaskMetaProbe!.release(response),
      Array.from(failure.buffer.buffer),
    );
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          document.body.textContent?.includes(
            "The target project is not connected, so this session cannot be opened.",
          ),
        ),
      { timeout: 10_000, timeoutMsg: "SCT03 query failure was not handled" },
    );
    expect(await captureNavigationHistory("query-error-after-back")).toEqual(beforeFailure);
    expect((await getV4PaneSnapshot()).sessionId).toBe(targetId);
    await browser.execute(() => window.__sct03TaskMetaProbe!.restore());

    await holdTaskMeta(callerId!);
    await $('[data-testid="desktop-top-nav-back"]').click();
    await waitForRealTaskMeta(callerId!, "lateQueryRpc");
    expect(await captureNavigationHistory("late-query-pending")).toEqual(beforeFailure);
    // A→B 是真实新选择；旧 back 的 A 结果即使成功，也不能把桌面抢回 A。
    await selectV4TaskById(callerId!);
    await selectV4TaskById(targetId!);
    const afterSelection = await captureNavigationHistory("late-query-after-sidebar");
    await browser.execute(() => window.__sct03TaskMetaProbe!.release());
    expect(await captureNavigationHistory("late-query-after-release")).toEqual(afterSelection);
    expect((await getV4PaneSnapshot()).sessionId).toBe(targetId);
    await browser.execute(() => window.__sct03TaskMetaProbe!.restore());
    await waitMobileTaskView({ workspacePath: DEFAULT_WORKSPACE, taskId: callerId! });
    expect(await mobilePane.isVisible()).toBe(true);

    evidence.assertions = {
      listFoundTarget: true,
      readSummary: true,
      sendAccepted: true,
      backgroundPreservesBothSurfaces: true,
      openNavigatesDesktopOnly: true,
      sidebarBackForwardPreservesHistory: true,
      toolBackForwardPreservesHistory: true,
      mobilePreservesCallerThroughHistory: true,
      queryErrorPreservesHistoryAndSelection: true,
      lateQueryPreservesNewSelection: true,
    };
  });
});
