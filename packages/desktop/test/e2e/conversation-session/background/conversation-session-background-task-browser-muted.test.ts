import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TID_BROWSER_ADDRESS_INPUT, TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData } from "#e2e/helpers/desktop-app";
import { openFirstBrowserTab } from "#e2e/helpers/browser-side-pane";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const CASE_TIMEOUT_MS = 180_000;
const PROMPT_MARKER = "E2E_BACKGROUND_TASK_BROWSER_MUTED";
const REPLY_MARKER = "BACKGROUND_TASK_BROWSER_MUTED_OK";

let fixtureServer: Server | null = null;
let fixtureUrl = "";

describe("只有当前对话的 Browser tab 出声", () => {
  before(async () => {
    fixtureServer = createFixtureServer();
    fixtureUrl = `${await listen(fixtureServer)}/background-task-tab`;
  });

  after(async () => {
    await closeServer(fixtureServer);
    fixtureServer = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("切到草稿或其他对话时静音，切回原对话后恢复", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    const taskA = await completeTask("first");

    await openFirstBrowserTab();
    const addressInput = await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
    await addressInput.waitForDisplayed({ timeout: 15_000 });
    await addressInput.setValue(fixtureUrl);
    await addressInput.click();
    await browser.keys("Enter");
    await waitForGuestMuted(false, "当前对话的 Browser guest 被静音");

    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForGuestMuted(true, "切到草稿后原对话的 Browser guest 仍然出声");

    const taskB = await completeTask("second");
    expect(taskB).not.toBe(taskA);
    await waitForGuestMuted(true, "切到另一个对话后原对话的 Browser guest 仍然出声");

    await $(`[data-testid="${testId(TID_TASK_ITEM, taskA)}"]`).click();
    await waitForV4Pane((snapshot) => snapshot.sessionId === taskA, "没有切回原对话");
    await waitForGuestMuted(false, "切回原对话后 Browser guest 仍然静音");
  });
});

async function completeTask(label: string): Promise<string> {
  await sendV4Prompt(
    `${PROMPT_MARKER} ${label}: Reply with exactly "${REPLY_MARKER}" and no other text.`,
  );
  await waitForV4AssistantMessageContaining(REPLY_MARKER, 60_000);
  const completed = await waitForV4Pane(
    (snapshot) =>
      !snapshot.canStop && Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
    `${label} 任务没有完成`,
    60_000,
  );
  if (!completed.sessionId || completed.sessionId === "draft") {
    throw new Error(`${label} 任务缺少 taskId`);
  }
  return completed.sessionId;
}

async function readFixtureGuestMuted(): Promise<boolean[]> {
  return (await browser.electron.execute(
    (electron, url) =>
      electron.webContents
        .getAllWebContents()
        .filter(
          (contents) =>
            !contents.isDestroyed() &&
            contents.getType() === "webview" &&
            contents.getURL() === url,
        )
        .map((contents) => contents.isAudioMuted()),
    fixtureUrl,
  )) as unknown as boolean[];
}

async function waitForGuestMuted(expected: boolean, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const muted = await readFixtureGuestMuted();
      return muted.length === 1 && muted[0] === expected;
    },
    { timeout: 30_000, timeoutMsg },
  );
}

function createFixtureServer(): Server {
  return createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      "<!doctype html><html><head><title>Background task tab</title></head><body>ready</body></html>",
    );
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("fixture server 没有绑定端口");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
