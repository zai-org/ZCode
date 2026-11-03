import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  TID_PLUGIN_MCP_SERVER_ROW,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { obtainUnreadPairingUrl } from "#e2e/helpers/web-remote-unread";
import { OFFICIAL_AUTH_ROUTING_SERVER } from "#e2e/helpers/mcp-official-auth-routing-fixture";
import { runOfficialMcpRoutingRuntime } from "#e2e/helpers/mcp-official-auth-routing-runtime";

const paths = getE2EAppDataPaths();
const rowId = testId(TID_PLUGIN_MCP_SERVER_ROW, OFFICIAL_AUTH_ROUTING_SERVER);
const artifactDir =
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(paths.homeDir, "official-mcp-artifacts");

async function openSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "mcp"));
  await waitForTestIdByDom(rowId);
}

async function waitConnected() {
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) =>
          document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-mcp-status") ===
          "connected",
        rowId,
      ),
    { timeout: 30_000, timeoutMsg: "已登录的官方 MCP 设置探测未连接成功" },
  );
}

describe("官方 MCP 设置探测授权路由（候选）", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("OMCP-SETTINGS-01: 设置探测使用独立 CLI 取得当前授权，不替换聊天进程", async function () {
    this.timeout(180_000);
    await mkdir(artifactDir, { recursive: true });
    await prepareV4ConversationE2E({ skipProvider: true });
    await openSettings();
    try {
      await waitConnected();
    } finally {
      await browser.saveScreenshot(join(artifactDir, "OMCP-SETTINGS-01.png"));
      await writeFile(
        join(artifactDir, "OMCP-SETTINGS-01-dom.txt"),
        await browser.execute(() => document.body.innerText),
      );
    }
    const fixtureUrl = process.env.ZCODE_E2E_OFFICIAL_AUTH_ROUTING_URL;
    expect(fixtureUrl).toBeTruthy();
    const evidence = (await (await fetch(`${fixtureUrl}/__e2e/status`)).json()) as {
      requests: Array<{ method: string; authenticated: boolean }>;
    };
    expect(
      evidence.requests.some((entry) => entry.method === "initialize" && entry.authenticated),
    ).toBe(true);
    expect(
      evidence.requests.some((entry) => entry.method === "tools/list" && entry.authenticated),
    ).toBe(true);
    const log = await readFile(
      join(
        artifactDir,
        "runtime-logs",
        "0-0",
        "desktop",
        `${new Date().toISOString().slice(0, 10)}.log`,
      ),
      "utf8",
    );
    expect(log.includes("官方 MCP 身份头已解析")).toBe(true);
    expect(log.includes("官方 MCP 身份头请求未通过工作区路由")).toBe(false);
    await writeFile(
      join(artifactDir, "OMCP-SETTINGS-01-wire.json"),
      JSON.stringify(evidence, null, 2),
    );
  });

  it("OMCP-SETTINGS-04: 手机设置通过同一 Host 探测，手机不接收授权头", async function () {
    this.timeout(180_000);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    const webUrl = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
    if (!webUrl) throw new Error("Missing loopback mobile frontend");
    const pairingUrl = await obtainUnreadPairingUrl(new URL(webUrl).origin);
    const mobile = await chromium.launch({ channel: "chrome", headless: true });
    const context = await mobile.newContext({ viewport: { width: 390, height: 844 } });
    await seedMobileFixtureLogin(context);
    const page = await context.newPage();
    const frames: string[] = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", (event) => frames.push(String(event.payload)));
    });
    try {
      await openMobilePairingPage(page, pairingUrl, {
        artifactDir,
        caseMarker: "OMCP-SETTINGS-04",
        phase: "pairing",
        readySelector: `[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`,
      });
      await page.getByTestId(TID_TASK_SETTINGS_BUTTON).click();
      await page.getByTestId(testId(TID_SETTINGS_SECTION_NAV, "mcp")).click();
      await page.waitForFunction(
        (id) =>
          document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-mcp-status") ===
          "connected",
        rowId,
      );
      expect(frames.join("\n")).not.toContain("Bearer mock-token");
      await page.screenshot({ path: join(artifactDir, "OMCP-SETTINGS-04-mobile.png") });
    } finally {
      await context.close();
      await mobile.close();
    }
  });

  it("OMCP-SETTINGS-02/03: 真实控制面进程切换、重建与恶意反向授权隔离", async function () {
    this.timeout(180_000);
    await runOfficialMcpRoutingRuntime(artifactDir);
  });
});
