import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  TID_MCP_SERVER_ROW,
  TID_PLUGIN_MCP_SERVER_ROW,
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
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
import {
  MCP_DIAGNOSTIC_PYTHON,
  MCP_DIAGNOSTIC_NODE,
  MCP_DIAGNOSTIC_COMMAND,
} from "#e2e/helpers/mcp-failure-guidance-fixture";

const paths = getE2EAppDataPaths();
const artifactDir =
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(paths.homeDir, "mcp-diagnostic-artifacts");
const pythonRow = testId(TID_MCP_SERVER_ROW, MCP_DIAGNOSTIC_PYTHON);
const nodeRow = testId(TID_PLUGIN_MCP_SERVER_ROW, MCP_DIAGNOSTIC_NODE);
const commandRow = testId(TID_MCP_SERVER_ROW, MCP_DIAGNOSTIC_COMMAND);
const activePopover = '[data-testid="mcp-failure-popover"][data-state="open"]';

type PresentationWindow = Window & {
  __testActions?: {
    setLocale(locale: "zh-CN" | "en-US"): void;
    setTheme(theme: "zai-light" | "zai-dark"): void;
  };
};

async function openSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "mcp"));
  await waitForTestIdByDom(pythonRow);
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) =>
          document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-mcp-status") ===
          "error",
        pythonRow,
      ),
    { timeout: 30_000 },
  );
}

function expectSafeDetails(text: string, cause: string) {
  expect(text).toContain(cause);
  expect(text).not.toContain("\u001b");
  expect(text).not.toContain("secret");
  for (const secret of ["fixture-sensitive", "fixture-bearer", "fixture-pass", "fixture-key"])
    expect(text).not.toContain(secret);
}

describe("MCP 启动失败处理建议（候选）", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("MCP-DIAG-01: 真实进程失败在详情展示处理建议与脱敏原因", async function () {
    this.timeout(180_000);
    await mkdir(artifactDir, { recursive: true });
    await prepareV4ConversationE2E({ skipProvider: true });
    await openSettings();
    for (const [id, cause] of [
      [pythonRow, "No module named 'mcp'"],
      [nodeRow, "Cannot find package 'example-mcp'"],
      [commandRow, "ENOENT"],
    ] as const) {
      const row = await browser.$(`[data-testid="${id}"]`);
      await row.scrollIntoView({ block: "center" });
      await row.$('button[aria-label="详情"]').click();
      // 关闭动画期间旧 Popover 仍挂在 DOM；只读取当前 open 实例，不能取同名第一个节点。
      await browser.waitUntil(() => browser.$(activePopover).isExisting(), { timeout: 10_000 });
      await writeFile(
        join(artifactDir, `MCP-DIAG-01-open-${id.replaceAll(":", "-")}.json`),
        JSON.stringify(
          await browser.execute(() =>
            Array.from(
              document.querySelectorAll<HTMLElement>('[data-testid="mcp-failure-popover"]'),
            ).map((popover) => ({
              state: popover.dataset.state,
              opacity: getComputedStyle(popover).opacity,
              advice: popover.querySelector('[data-testid="mcp-failure-advice"]')?.textContent,
              error: popover.querySelector('[data-testid="mcp-failure-error"]')?.textContent,
            })),
          ),
          null,
          2,
        ),
      );
      await browser.$(`${activePopover} [data-testid="mcp-failure-advice"]`).waitForDisplayed();
      expect(
        await browser.$(`${activePopover} [data-testid="mcp-failure-advice"]`).getText(),
      ).toContain("Python");
      expectSafeDetails(
        await browser.$(`${activePopover} [data-testid="mcp-failure-error"]`).getText(),
        cause!,
      );
      await browser.saveScreenshot(join(artifactDir, `MCP-DIAG-01-${id.replaceAll(":", "-")}.png`));
      await browser.keys("Escape");
    }
    for (const [locale, theme] of [
      ["zh-CN", "zai-dark"],
      ["en-US", "zai-light"],
    ] as const) {
      await browser.execute(
        ({ locale, theme }) => {
          (window as PresentationWindow).__testActions!.setLocale(locale);
          (window as PresentationWindow).__testActions!.setTheme(theme);
        },
        { locale, theme },
      );
      const row = await browser.$(`[data-testid="${pythonRow}"]`);
      await row.scrollIntoView({ block: "center" });
      await row.$(`button[aria-label="${locale === "zh-CN" ? "详情" : "Details"}"]`).click();
      // 关闭动画期间旧 Popover 仍挂在 DOM；只读取当前 open 实例，不能取同名第一个节点。
      await browser.waitUntil(() => browser.$(activePopover).isExisting(), { timeout: 10_000 });
      await browser.$(`${activePopover} [data-testid="mcp-failure-advice"]`).waitForDisplayed();
      expect(
        await browser.$(`${activePopover} [data-testid="mcp-failure-advice"]`).getText(),
      ).toContain(locale === "zh-CN" ? "运行" : "device");
      await browser.saveScreenshot(join(artifactDir, `MCP-DIAG-01-${locale}-${theme}.png`));
      await browser.keys("Escape");
    }
  });

  it("MCP-DIAG-02: 手机窄屏可读，恢复后刷新清除旧错误", async function () {
    this.timeout(180_000);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    const url = await obtainUnreadPairingUrl(
      new URL(process.env.ZCODE_WEB_REMOTE_CONTROL_URL!).origin,
    );
    const mobile = await chromium.launch({ channel: "chrome", headless: true });
    const context = await mobile.newContext({ viewport: { width: 390, height: 844 } });
    await seedMobileFixtureLogin(context);
    const page = await context.newPage();
    try {
      await openMobilePairingPage(page, url, {
        artifactDir,
        caseMarker: "MCP-DIAG-02",
        phase: "mobile",
        readySelector: `[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`,
      });
      await page.getByTestId(TID_TASK_SETTINGS_BUTTON).click();
      await page.getByTestId(testId(TID_SETTINGS_SECTION_NAV, "mcp")).click();
      for (const [locale, theme] of [
        ["zh-CN", "zai-light"],
        ["en-US", "zai-dark"],
      ] as const) {
        await page.evaluate(
          ({ locale, theme }) => {
            (window as PresentationWindow).__testActions!.setLocale(locale);
            (window as PresentationWindow).__testActions!.setTheme(theme);
          },
          { locale, theme },
        );
        await page
          .getByTestId(pythonRow)
          .getByRole("button", { name: locale === "zh-CN" ? "详情" : "Details", exact: true })
          .click();
        const popover = page.locator(activePopover);
        const advice = popover.getByTestId("mcp-failure-advice");
        await advice.waitFor();
        expectSafeDetails(
          await popover.getByTestId("mcp-failure-error").innerText(),
          "No module named 'mcp'",
        );
        const bounds = await popover.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        await page.screenshot({ path: join(artifactDir, `MCP-DIAG-02-${locale}-${theme}.png`) });
        await page.keyboard.press("Escape");
      }
    } finally {
      await context.close();
      await mobile.close();
    }
    await openSettings();
    await writeFile(join(paths.storageRoot, "mcp-diagnostic-recovered"), "ready");
    await clickTestIdByDom("mcp-settings-refresh");
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            document.querySelector(`[data-testid="${id}"]`)?.getAttribute("data-mcp-status") ===
            "connected",
          pythonRow,
        ),
      { timeout: 30_000 },
    );
    expect(
      await browser
        .$(`[data-testid="${pythonRow}"]`)
        .$$('button[aria-label="Details"], button[aria-label="详情"]'),
    ).toHaveLength(0);
    await browser.saveScreenshot(join(artifactDir, "MCP-DIAG-02-recovered.png"));
  });
});
