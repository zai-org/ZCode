import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import {
  waitForSuccessfulToolCallByToolCallId,
  waitForToolCallBlockByToolName,
} from "#e2e/helpers/conversation-session-tool";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

// BU-E2E-028（docs/browser-use/2026-07-12-browser-use-runtime-semantics-spec.md §2.2）：
// 网页没有键盘焦点、宿主 Composer 有焦点时，cua.keypress 只能送到网页。修复前 guest 主 frame 的
// CDP 按键按窗口焦点落到宿主：Escape 触发停止会话，字母和 Enter 进了 Composer。

const PROMPT_MARKER = "E2E_BROWSER_USE_KEYPRESS_ISOLATION";
const TOOL_NAME = "mcp__node_repl__js";
const TOOL_CALL_ID = "toolu_e2e_browser_keypress_isolation";
const RESULT_MARKER = "E2E_BROWSER_USE_KEYPRESS_OK";
const FINAL_MARKER = "E2E_BROWSER_USE_KEYPRESS_DONE";
const PAGE_PATH = "/keys";

let fixtureServer: Server | null = null;
let fixtureOrigin = "";

describe("BU-E2E-028：网页无焦点时 cua.keypress 不落到宿主", () => {
  before(async () => {
    fixtureServer = createKeypressFixtureServer();
    fixtureOrigin = await listen(fixtureServer);
  });

  after(async () => {
    await closeServer(fixtureServer);
    fixtureServer = null;
    await clearAppData();
  });

  it("Escape 不停止会话，a/b/Enter/Escape 只进网页，宿主 Composer 不变", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();

    const prompt = [
      `${PROMPT_MARKER}: press keys in the in-app browser while the page has no keyboard focus.`,
      `E2E_BROWSER_FIXTURE_URL:${fixtureOrigin}/`,
    ].join(" ");
    await sendV4Prompt(prompt);
    await waitForV4UserMessageContaining(PROMPT_MARKER);
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, "E2E_BROWSER_FIXTURE_URL:", TOOL_NAME],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "首轮请求没有暴露 Browser Use Node REPL 工具或 fixture marker",
      60000,
    );
    await waitForToolCallBlockByToolName(TOOL_NAME, 90000);
    await approveV4Permission();

    // 工具已打开页面、用页面脚本把焦点放进输入框，正在等闸门；此时让宿主 Composer 拿到焦点，
    // 再在宿主装按键探针，最后开闸让工具开始按键。
    const guestId = await waitForGuestInputFocused().catch(async (error: unknown) => {
      const tool = await waitForSuccessfulToolCallByToolCallId(TOOL_CALL_ID, [], 5000).catch(
        (toolError: unknown) => String(toolError),
      );
      throw new Error(`${String(error)}\n工具输出: ${JSON.stringify(tool)}`);
    });
    const composer = await focusEmptyV4Composer();
    expect(composer).toEqual({ focused: true, text: "" });
    await installHostKeydownProbe();
    await openGuestGate(guestId);

    await waitForSuccessfulToolCallByToolCallId(TOOL_CALL_ID, [RESULT_MARKER], 90000);
    await waitForV4AssistantMessageContaining(FINAL_MARKER);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.sessionId !== "draft",
      "按键 turn 完成后没有回到 idle",
      90000,
    );

    expect(await readHostKeydowns()).toEqual([]);
    expect((await readV4ComposerSnapshot()).text).toBe("");
  });
});

function createKeypressFixtureServer(): Server {
  return createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
<html>
  <head><title>E2E Keypress Isolation</title></head>
  <body>
    <form id="form"><label>Name <input id="name" /></label><button type="submit">Submit</button></form>
    <dialog id="dialog">E2E dialog</dialog>
    <script>
      window.__e2eKeys = [];
      window.__e2eSubmits = 0;
      window.__e2eGate = false;
      addEventListener("keydown", (event) => {
        if (event.isTrusted) window.__e2eKeys.push(event.key);
      }, true);
      document.getElementById("form").addEventListener("submit", (event) => {
        event.preventDefault();
        window.__e2eSubmits += 1;
      });
    </script>
  </body>
</html>`);
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
  if (!address) throw new Error("按键 fixture server 没有绑定端口");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | null) {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForGuestInputFocused(timeout = 60000): Promise<number> {
  let latest: { id: number; active: string } | null = null;
  const ready = await browser
    .waitUntil(
      async () => {
        latest = (await browser.electron.execute(async (electron, pageUrl) => {
          const guest = electron.webContents
            .getAllWebContents()
            .find((item) => item.getType() === "webview" && item.getURL() === pageUrl);
          if (!guest) return null;
          const active = (await guest.executeJavaScript(
            "document.activeElement?.id ?? ''",
          )) as string;
          return { id: guest.id, active };
        }, `${fixtureOrigin}${PAGE_PATH}`)) as { id: number; active: string } | null;
        return latest?.active === "name";
      },
      { timeout, interval: 100 },
    )
    .then(() => true)
    .catch(() => false);
  if (!ready || !latest) {
    throw new Error(`工具没有打开按键页面并把焦点放进输入框: ${JSON.stringify(latest)}`);
  }
  return (latest as { id: number }).id;
}

async function openGuestGate(webContentsId: number) {
  await browser.electron.execute(async (electron, id) => {
    const guest = electron.webContents.fromId(id);
    if (!guest) throw new Error("按键页面的 guest 不存在");
    await guest.executeJavaScript("window.__e2eGate = true");
  }, webContentsId);
}

async function installHostKeydownProbe() {
  await browser.execute(() => {
    const host = window as unknown as { __e2eHostKeydowns?: string[] };
    if (!host.__e2eHostKeydowns) {
      host.__e2eHostKeydowns = [];
      window.addEventListener("keydown", (event) => host.__e2eHostKeydowns?.push(event.key), true);
    }
    host.__e2eHostKeydowns.length = 0;
  });
}

function readHostKeydowns(): Promise<string[]> {
  return browser.execute(() => [
    ...((window as unknown as { __e2eHostKeydowns?: string[] }).__e2eHostKeydowns ?? []),
  ]);
}

function readV4ComposerSnapshot(): Promise<{ focused: boolean; text: string | null }> {
  return browser.execute((inputTestId) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    const bridge = (
      element as (HTMLElement & { __zcodeLexicalInputE2E?: { getText: () => string } }) | null
    )?.__zcodeLexicalInputE2E;
    return {
      focused: Boolean(
        element && document.activeElement && element.contains(document.activeElement),
      ),
      text: bridge?.getText() ?? null,
    };
  }, TID_V4_COMPOSER_INPUT);
}

async function focusEmptyV4Composer(timeout = 10000) {
  let latest = await readV4ComposerSnapshot();
  await browser.waitUntil(
    async () => {
      await browser.execute((inputTestId) => {
        const element = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
        (
          element as (HTMLElement & { __zcodeLexicalInputE2E?: { focus: () => void } }) | null
        )?.__zcodeLexicalInputE2E?.focus();
      }, TID_V4_COMPOSER_INPUT);
      latest = await readV4ComposerSnapshot();
      return latest.focused && latest.text === "";
    },
    {
      timeout,
      interval: 100,
      timeoutMsg: `宿主 Composer 没有在空草稿下拿到焦点: ${JSON.stringify(latest)}`,
    },
  );
  return latest;
}
