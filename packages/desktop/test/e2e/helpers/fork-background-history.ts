import { homedir } from "node:os";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl } from "#e2e/helpers/web-remote-unread";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart";
import {
  clickFirstV4Fork,
  getV4PaneSnapshot,
  selectV4TaskById,
  startNewV4Draft,
  waitForV4Fork,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

interface ForkFault {
  request?: number[];
  calls: number;
  reply(response: number[]): void;
  restore(): void;
}
declare global {
  interface Window {
    __forkHistoryFault?: ForkFault;
  }
}

/** BG04 / FX14：真实轮内通知必须跨连续 fork、进程重启与手机保持原轮。 */
export async function assertForkAfterBackgroundNotification(finalText: string) {
  const parentId = (await getV4PaneSnapshot()).sessionId!;
  expect(parentId).not.toBe("draft");
  const before = readHistory(parentId);
  await writeFile(
    join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "fork-background-source.json"),
    JSON.stringify(before, null, 2),
  );
  // live anchor 的 productTurnId 由首次 fork resolver 惰性补齐；不能要求首 fork 前已存在。
  assertInTurnNotification(before, false);

  const childId = await forkCurrent(parentId, finalText);
  assertInTurnNotification(readHistory(childId));
  const stableParent = readHistory(parentId);
  assertInTurnNotification(stableParent);
  expect(stableParent.map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
  const grandchildId = await forkCurrent(childId, finalText);
  assertInTurnNotification(readHistory(grandchildId));
  expect(readHistory(parentId)).toEqual(stableParent);

  await startNewV4Draft();
  await restartIntoWorkspacePreservingProfile();
  await selectV4TaskById(childId);
  await waitForV4TimelineContaining(finalText);
  await forkCurrent(childId, finalText);
  // 只在测试 RPC 边界注入失败；真实 CLI/数据库不接受这些请求，也不会生成 child。
  await assertVisibleForkFailure("ack");
  await assertVisibleForkFailure("transport");
  await assertMobileFork(childId, finalText);
  expect(readHistory(parentId)).toEqual(stableParent);
}

async function forkCurrent(parentId: string, finalText: string) {
  await waitForV4Fork();
  expect(await clickFirstV4Fork()).toBe(true);
  const child = await waitForV4Pane(
    (pane) => Boolean(pane.sessionId && pane.sessionId !== "draft" && pane.sessionId !== parentId),
    "FX14 点击 fork 后没有切到 child",
    30_000,
  );
  await waitForV4TimelineContaining(finalText);
  return child.sessionId!;
}

type StoredMessage = {
  id: string;
  data: {
    role: string;
    metadata?: { inputPresentation?: string };
    anchor?: { productTurnId?: string; orderedMessageIds?: string[]; boundaryMessageId?: string };
  };
};
function readHistory(sessionId: string): StoredMessage[] {
  // Node 内置 SQLite 只有同步 API；隔离测试库仅作短只读查询，立即关闭句柄。
  const db = new DatabaseSync(join(homedir(), ".zcode", "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    const rows = db
      .prepare("SELECT id, data FROM message WHERE session_id=? ORDER BY time_created, id")
      .all(sessionId) as Array<{ id: string; data: string }>;
    return rows.map((row) => ({ id: row.id, data: JSON.parse(row.data) }));
  } finally {
    db.close();
  }
}
function assertInTurnNotification(messages: StoredMessage[], requireProductTurnId = true) {
  const notification = messages.find(
    (entry) => entry.data.metadata?.inputPresentation === "task_notification_steer",
  );
  expect(notification).toBeDefined();
  const boundary = messages.find(
    (entry) =>
      entry.data.role === "assistant" &&
      entry.data.anchor?.orderedMessageIds?.includes(notification!.id),
  );
  expect(boundary).toBeDefined();
  expect(boundary!.data.anchor!.productTurnId).not.toBe(notification!.id);
  if (requireProductTurnId) {
    expect(messages.some((entry) => entry.id === boundary!.data.anchor!.productTurnId)).toBe(true);
  }
}

async function assertVisibleForkFailure(kind: "ack" | "transport") {
  const parentId = (await getV4PaneSnapshot()).sessionId;
  // 等上一条提示自然关闭，防止第二种故障误用第一条提示通过断言。
  await browser.waitUntil(async () => !(await hasForkFailureToast()), { timeout: 10_000 });
  await browser.execute(() => {
    const original = MessagePort.prototype.postMessage;
    const fault: ForkFault = {
      calls: 0,
      reply() {
        throw new Error("FX14 fork 请求尚未捕获");
      },
      restore() {
        MessagePort.prototype.postMessage = original;
        delete window.__forkHistoryFault;
      },
    };
    MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
      if (message instanceof Uint8Array) {
        const text = new TextDecoder().decode(message);
        if (text.includes("sendConversationCommandV4") && text.includes("forkAssistant")) {
          fault.calls += 1;
          fault.reply = (response) => {
            this.dispatchEvent(new MessageEvent("message", { data: Uint8Array.from(response) }));
          };
          fault.request = Array.from(message);
          return;
        }
      }
      Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
    };
    window.__forkHistoryFault = fault;
  });
  try {
    await waitForV4Fork();
    expect(await clickFirstV4Fork()).toBe(true);
    await browser.waitUntil(
      () => browser.execute(() => Boolean(window.__forkHistoryFault?.request)),
      { timeout: 10_000 },
    );
    const raw = await browser.execute(() => window.__forkHistoryFault!.request!);
    const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(raw)));
    const header = deserialize(reader) as [number, number, string, string];
    const args = deserialize(reader) as [{ envelope: { commandId: string; baseRevision: number } }];
    expect(header[3]).toBe("sendConversationCommandV4");
    const writer = new BufferWriter();
    serialize(writer, [kind === "ack" ? 201 : 202, header[1]]);
    serialize(
      writer,
      kind === "ack"
        ? {
            commandId: args[0].envelope.commandId,
            status: "failed",
            reasonCode: "guard.forkTargetAmbiguous",
            revisionAtDecision: args[0].envelope.baseRevision,
          }
        : { name: "Error", message: "E2E_FORK_TRANSPORT_FAILURE" },
    );
    await browser.execute(
      (response) => window.__forkHistoryFault!.reply(response),
      Array.from(writer.buffer.buffer),
    );
    await browser.waitUntil(hasForkFailureToast, {
      timeout: 10_000,
      timeoutMsg: `FX14 ${kind} 失败没有可见提示`,
    });
    expect((await getV4PaneSnapshot()).sessionId).toBe(parentId);
    expect(await browser.execute(() => window.__forkHistoryFault!.calls)).toBe(1);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `fork-failure-${kind}.png`),
    );
  } finally {
    await browser.execute(() => window.__forkHistoryFault?.restore());
  }
}
function hasForkFailureToast() {
  return browser.execute(() =>
    /分叉会话失败|Could not fork session/u.test(document.body.innerText),
  );
}

async function assertMobileFork(parentId: string, finalText: string) {
  const pairingUrl = await obtainUnreadPairingUrl(
    new URL(process.env.ZCODE_WEB_REMOTE_CONTROL_URL!).origin,
  );
  const webBrowser = await chromium.launch({
    executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE,
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const context = await webBrowser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    await seedMobileFixtureLogin(context);
    const page = await context.newPage();
    await openMobilePairingPage(page, pairingUrl, {
      artifactDir: process.env.ZCODE_E2E_ARTIFACT_DIR!,
      caseMarker: "FX14",
      phase: "fork",
      readySelector: '[data-testid="virtual-project-toggle"]',
    });
    for (const toggle of await page.getByTestId("virtual-project-toggle").all()) {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.tap();
    }
    await page.getByTestId(testId(TID_TASK_ITEM, parentId)).first().tap();
    await page.locator(`[data-session-id="${parentId}"]`).waitFor();
    await page.locator('[data-testid^="v4-fork-"]').first().tap();
    await page.waitForFunction((parentId) => {
      const id = document.querySelector("[data-session-id]")?.getAttribute("data-session-id");
      return id && id !== "draft" && id !== parentId;
    }, parentId);
    const childId = (await page.locator("[data-session-id]").getAttribute("data-session-id"))!;
    await page.getByText(finalText, { exact: true }).first().waitFor();
    assertInTurnNotification(readHistory(childId));
    await page.screenshot({
      path: join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "fork-background-mobile.png"),
      fullPage: true,
    });
  } finally {
    await webBrowser.close();
  }
}
