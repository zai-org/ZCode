import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TID_BROWSER_ADDRESS_INPUT, TID_BROWSER_WEBVIEW } from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import type { E2ENetworkCaptureArtifact } from "#e2e/helpers/network-capture-proxy";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolName } from "#e2e/helpers/conversation-session-tool";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";

const PARENT_MARKER = "E2E_BROWSER_SUBAGENT_BOUNDARY_PARENT";
const CHILD_MARKER = "E2E_BROWSER_SUBAGENT_BOUNDARY_CHILD";
const PARENT_INIT_TOOL_ID = "toolu_e2e_browser_subagent_parent_init";
const AGENT_TOOL_ID = "toolu_e2e_browser_subagent_agent";
const CHILD_CHECK_TOOL_ID = "toolu_e2e_browser_subagent_child_check";
const PARENT_RESUME_TOOL_ID = "toolu_e2e_browser_subagent_parent_resume";
const PARENT_INIT_OK = "E2E_BROWSER_SUBAGENT_PARENT_INIT_OK";
const CHILD_CHECKS_OK = "E2E_BROWSER_SUBAGENT_BOUNDARY_CHECKS_OK";
const CHILD_DONE = "E2E_BROWSER_SUBAGENT_BOUNDARY_CHILD_DONE";
const PARENT_RESUME_OK = "E2E_BROWSER_SUBAGENT_PARENT_RESUME_OK";
const PARENT_DONE = "E2E_BROWSER_SUBAGENT_BOUNDARY_DONE";

interface ParentBrowserSurface {
  address: string;
  id: number;
}

let fixtureServer: Server | null = null;
let fixtureRootUrl = "";

describe("Browser Use subagent 会话 E2E", () => {
  before(async () => {
    fixtureServer = createFixtureServer();
    fixtureRootUrl = await listen(fixtureServer);
  });

  after(async () => {
    await closeServer(fixtureServer);
    fixtureServer = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BAB01/BU-E2E-012: child 与对话共用 Tab，新开的 Tab 在面板展开且结束后保留", async function () {
    this.timeout(300000);
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    const runId = Date.now();
    const prompt = [
      `${PARENT_MARKER}_${runId}: cache one Browser and Tab, then delegate a browser check to a general-purpose child.`,
      `E2E_BROWSER_FIXTURE_URL:${fixtureRootUrl}`,
      `The child marker is ${CHILD_MARKER}; after it returns, reuse the original parent tab and reply ${PARENT_DONE}.`,
    ].join(" ");
    await sendV4Prompt(prompt);
    await waitForV4UserMessageContaining(`${PARENT_MARKER}_${runId}`);

    await waitForUpstreamRequest(
      {
        includes: [PARENT_MARKER, PARENT_INIT_TOOL_ID, PARENT_INIT_OK],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "主 Agent 初始化 Browser 后没有进入 Agent delegation continuation",
      90000,
    );
    const beforeChild = await waitForParentBrowserSurface();
    await waitForToolCallBlockByToolName("Agent", 90000);

    await waitForUpstreamRequest(
      {
        includes: [CHILD_MARKER, CHILD_CHECK_TOOL_ID, CHILD_CHECKS_OK, "ordinaryValue", "42"],
        excludes: [PARENT_MARKER, "Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "child 普通 Node REPL 与自有 Browser Tab 检查没有完成",
      90000,
    );
    const childRequestText = JSON.stringify(
      await waitForCapturedRequest([CHILD_MARKER, CHILD_CHECK_TOOL_ID, CHILD_CHECKS_OK]),
    );
    expect(childRequestText).not.toContain("Browser is not available in subagent");
    // child 开的 Tab 归当前对话：面板直接展示它，而不是挂成看不见的孤儿 shell。
    await waitForBrowserSurface((surface) => surface.address.includes("child=1"));
    await waitForUpstreamRequest(
      {
        includes: [PARENT_MARKER, AGENT_TOOL_ID, CHILD_DONE],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "child 完成后结果没有回到父 Agent continuation",
      90000,
    );
    await waitForUpstreamRequest(
      {
        includes: [PARENT_MARKER, PARENT_RESUME_TOOL_ID, PARENT_RESUME_OK],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "父 Agent 返回后没有复用缓存 Tab 完成写入",
      90000,
    );
    await waitForV4AssistantMessageContaining(PARENT_DONE);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "subagent Browser case 完成后没有回到 idle",
      90000,
    );

    expect(beforeChild.id).toBeGreaterThan(0);
  });
});

function createFixtureServer(): Server {
  return createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
<html>
  <head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>E2E Subagent Browser Boundary</title></head>
  <body>
    <label>State <input id="state" /></label>
    <p role="status">empty</p>
    <script>
      document.querySelector("#state").addEventListener("input", (event) => {
        document.querySelector("[role=status]").textContent = event.currentTarget.value;
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
  if (!address) throw new Error("Browser subagent fixture server 没有绑定端口");
  return `http://127.0.0.1:${address.port}/boundary`;
}

async function closeServer(server: Server | null) {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForParentBrowserSurface(): Promise<ParentBrowserSurface> {
  return await waitForBrowserSurface(
    (surface) => new URL(surface.address).href === new URL(fixtureRootUrl).href,
  );
}

async function waitForBrowserSurface(
  matches: (surface: ParentBrowserSurface) => boolean,
): Promise<ParentBrowserSurface> {
  let latest: ParentBrowserSurface | null = null;
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(
        (addressTestId, webviewTestId) => {
          const isVisible = (element: HTMLElement) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0
            );
          };
          const addresses = Array.from(
            document.querySelectorAll<HTMLInputElement>(`[data-testid="${addressTestId}"]`),
          ).filter(isVisible);
          const webviews = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid="${webviewTestId}"]`),
          )
            .filter(isVisible)
            .map(
              (element) =>
                (
                  element as HTMLElement & { getWebContentsId?: () => number }
                ).getWebContentsId?.() ?? 0,
            )
            .filter((id) => id > 0);
          return { address: addresses[0]?.value ?? "", id: webviews[0] ?? 0 };
        },
        TID_BROWSER_ADDRESS_INPUT,
        TID_BROWSER_WEBVIEW,
      );
      return latest.id > 0 && latest.address !== "" && matches(latest);
    },
    {
      timeout: 60000,
      timeoutMsg: `可见 Browser surface 没有收敛: ${JSON.stringify(latest)}`,
    },
  );
  if (!latest) throw new Error("可见 Browser surface 在等待后仍不存在");
  return latest as unknown as ParentBrowserSurface;
}

async function waitForCapturedRequest(expected: string[]) {
  let latest: unknown = null;
  await browser.waitUntil(
    async () => {
      const artifact = await readCaptureArtifact();
      latest =
        artifact?.records.find(
          (record) =>
            record.status === "complete" &&
            expected.every((text) => captureContainsText(record.requestJson, text)),
        )?.requestJson ?? null;
      return latest !== null;
    },
    {
      timeout: 60000,
      timeoutMsg: `没有捕获到请求: ${expected.join(", ")}`,
    },
  );
  return latest;
}

async function readCaptureArtifact(): Promise<E2ENetworkCaptureArtifact | null> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) return null;
  try {
    return JSON.parse(await readFile(capturePath, "utf-8")) as E2ENetworkCaptureArtifact;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function captureContainsText(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value.includes(expected);
  if (Array.isArray(value)) return value.some((item) => captureContainsText(item, expected));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) => captureContainsText(item, expected));
}
