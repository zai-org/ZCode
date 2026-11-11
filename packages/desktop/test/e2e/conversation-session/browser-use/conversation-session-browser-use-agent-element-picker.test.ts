import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  TID_BROWSER_DESIGN_INSPECTOR,
  TID_BROWSER_ELEMENT_PICKER_BUTTON,
  TID_WEB_ELEMENT_CONTEXT_CHIP,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { clickGuestElement, waitForDataCount } from "#e2e/helpers/browser-design-mode";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForSuccessfulToolCallByToolCallId } from "#e2e/helpers/conversation-session-tool";

// 人类 tab 的「选择元素」统一成设计点选后，原来的元素 chip 选择器只剩 Agent 的 Browser Use tab 在用（!3548 SG-01）
const TURN_MARKER = "E2E_AGENT_ELEMENT_PICKER_TURN";
const OPEN_TOOL_CALL_ID = "toolu_e2e_agent_element_picker_open";

let fixtureServer: Server | null = null;
let fixtureRootUrl = "";
let fixtureOrigin = "";

describe("Agent Browser Use tab 的元素选择器 E2E", () => {
  before(async () => {
    fixtureServer = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
<html>
  <head><title>E2E Agent picker</title></head>
  <body><main><h1 id="agent-title">E2E_AGENT_PICKER_TITLE</h1><button id="agent-cta">Go</button></main></body>
</html>`);
    });
    await new Promise<void>((resolve, reject) => {
      fixtureServer?.once("error", reject);
      fixtureServer?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = fixtureServer.address() as AddressInfo;
    fixtureOrigin = `http://127.0.0.1:${address.port}`;
    fixtureRootUrl = `${fixtureOrigin}/root`;
  });

  after(async () => {
    await new Promise<void>((resolve) =>
      fixtureServer ? fixtureServer.close(() => resolve()) : resolve(),
    );
    fixtureServer = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Agent tab 点「选择元素」再点页面元素：输入框上方出元素标签，不出调整面板", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E();
    await sendV4Prompt(
      `${TURN_MARKER}: open one in-app Browser tab for me. E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}`,
    );
    await waitForV4UserMessageContaining(TURN_MARKER);
    await approveBrowserPermissionOnce();
    await waitForSuccessfulToolCallByToolCallId(
      OPEN_TOOL_CALL_ID,
      ["E2E_AGENT_ELEMENT_PICKER_OPEN_OK"],
      90_000,
    );
    await waitForV4AssistantMessageContaining("E2E_AGENT_ELEMENT_PICKER_DONE");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "Agent 打开页面后本轮没有结束",
      90_000,
    );

    // Agent tab 在侧边栏里显示后，点它自己的「选择元素」
    await browser.waitUntil(
      async () =>
        (await browser.execute((pickerId) => {
          const pane = [
            ...document.querySelectorAll<HTMLElement>("[data-browser-use-tab-id]"),
          ].find((element) => element.getAttribute("aria-hidden") !== "true");
          const picker = pane?.querySelector<HTMLButtonElement>(`[data-testid="${pickerId}"]`);
          if (!picker || picker.disabled) return false;
          if (picker.getAttribute("aria-pressed") !== "true") picker.click();
          return picker.getAttribute("aria-pressed") === "true";
        }, TID_BROWSER_ELEMENT_PICKER_BUTTON)) as boolean,
      { timeout: 30_000, timeoutMsg: "Agent tab 没有出现可用的「选择元素」" },
    );
    await browser.waitUntil(
      async () => {
        await clickGuestElement(fixtureOrigin, "#agent-cta");
        return (
          (await browser.execute(
            (id) =>
              document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-count") ?? null,
            TID_WEB_ELEMENT_CONTEXT_CHIP,
          )) === "1"
        );
      },
      { timeout: 20_000, interval: 1_000, timeoutMsg: "Agent tab 点选后输入框上方没有出元素标签" },
    );
    await waitForDataCount(TID_WEB_ELEMENT_CONTEXT_CHIP, "1", "Agent tab 应只加一个元素标签");
    if (await $(`[data-testid="${TID_BROWSER_DESIGN_INSPECTOR}"]`).isExisting()) {
      throw new Error("Agent tab 不应出调整面板");
    }
  });
});

async function approveBrowserPermissionOnce(): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => {
        const option = [...document.querySelectorAll<HTMLElement>('[role="listbox"]')]
          .filter((listbox) => {
            const label = listbox.getAttribute("aria-label")?.trim();
            return label === "Permission required" || label === "需要权限";
          })
          .flatMap((listbox) => [
            ...listbox.querySelectorAll<HTMLButtonElement>(
              'button[role="option"][data-permission-option-kind="allowOnce"]',
            ),
          ])[0];
        if (!option) return false;
        option.click();
        return true;
      })) as boolean,
    { timeout: 90_000, timeoutMsg: "Agent 打开浏览器时没有出现权限确认" },
  );
}
