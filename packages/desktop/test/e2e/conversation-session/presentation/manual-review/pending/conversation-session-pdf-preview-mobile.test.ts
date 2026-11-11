import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE, seedSettings } from "#e2e/helpers/desktop-app";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";

// Chrome/Edge 111–125 没有 URL.parse，pdf.js 默认构建在主线程 getUrlProp() 里直接调用它，
// 字符串 URL 数据源的 PDF 预览抛 TypeError，react-pdf 在 effect 中同步抛出，整个会话区域
// 被错误边界替换为“这块界面出了点问题”；Worker 全局也缺 Promise.withResolvers。
// 本用例在手机 Web 输入框粘贴 PDF（数据源是 blob URL）并打开预览，断言页面渲染、
// 使用真实 Worker 而不是退化为 fake worker。默认用新版 Chrome 做回归，
// 设置 ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE 可换成低版本浏览器验证 legacy 构建。
const CASE_MARKER = "PDF-MOB-01";
const PDF_FILE = "e2e-pdf-mob-01.pdf";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/pdf-preview-mobile",
);
// 最小合法 PDF（单页空白），pdf.js 可以解析并渲染出一页画布。
const MINIMAL_PDF = `%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`;
const REGION_ERROR_TEXT = /这块界面出了点问题|This section ran into a problem/u;
const PDF_ERROR_LOG = /fake worker|URL\.parse|withResolvers|is not a function/iu;

describe("PDF 预览手机 Web 远控", () => {
  before(async function () {
    this.timeout(120000);
    await seedSettings({ locale: "zh-CN", localePreference: "zh-CN" });
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it(`${CASE_MARKER}: 手机输入框粘贴 PDF 后打开预览，pdf.js 用真实 Worker 渲染页面`, async function () {
    this.timeout(240000);
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);

    const endpoint = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
    if (!endpoint) throw new Error("mobile fixture missing");
    const pairingUrl = await obtainUnreadPairingUrl(new URL(endpoint).origin);
    const executablePath = process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE;
    const chrome = await chromium.launch({
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      headless: true,
    });
    const pageErrors: string[] = [];
    const pdfLogs: string[] = [];
    const workerUrls: string[] = [];
    try {
      const context = await chrome.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      await seedMobileFixtureLogin(context);
      const page = await context.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => {
        if (PDF_ERROR_LOG.test(message.text()))
          pdfLogs.push(`${message.type()}: ${message.text()}`);
      });
      page.on("worker", (worker) => workerUrls.push(worker.url()));
      await openMobilePairingPage(page, pairingUrl, {
        artifactDir,
        caseMarker: CASE_MARKER,
        phase: "pairing",
        readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
      });
      const browserVersion = chrome.version();
      await showMobileTaskHome(page);
      await mkdir(artifactDir, { recursive: true });
      const dialog = page.getByRole("dialog");
      const pdfPage = dialog.locator(".react-pdf__Page canvas");
      try {
        const project = page.locator('[data-project-name="ZCodeProject"]');
        await project.waitFor({ timeout: 60000 });
        await project.getByTestId("virtual-project-create-task").tap();
        await page.locator('[data-mobile-page="chat"]').waitFor();
        const pasted = await page.evaluate(
          ({ inputTestId, fileName, content }) => {
            const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
            const editable =
              input?.querySelector<HTMLElement>('[contenteditable="true"]') ??
              (input?.getAttribute("contenteditable") === "true" ? input : null);
            if (!editable) return false;
            const bytes = Uint8Array.from(content, (char) => char.charCodeAt(0));
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(new File([bytes], fileName, { type: "application/pdf" }));
            editable.focus();
            editable.dispatchEvent(
              new ClipboardEvent("paste", {
                clipboardData: dataTransfer,
                bubbles: true,
                cancelable: true,
              }),
            );
            return true;
          },
          { inputTestId: TID_V4_COMPOSER_INPUT, fileName: PDF_FILE, content: MINIMAL_PDF },
        );
        if (!pasted) throw new Error("手机输入框没有出现，无法粘贴 PDF");
        await page.locator('[data-composer-attachment-kind="pdf"]').first().tap();
        await pdfPage.first().waitFor({ timeout: 30000 });
      } catch (error) {
        // 预览失败时弹窗只显示“这个 PDF 已无法预览。”，需要现场文本、日志与截图区分原因。
        await page.screenshot({ path: resolve(artifactDir, `${CASE_MARKER}-failure.png`) });
        await writeFile(
          resolve(artifactDir, `${CASE_MARKER}-failure.json`),
          JSON.stringify(
            {
              browserVersion,
              bodyText: await page.locator("body").innerText(),
              pageErrors,
              pdfLogs,
              workerUrls,
            },
            null,
            2,
          ),
        );
        throw error;
      }
      const canvasWidth = await pdfPage
        .first()
        .evaluate((canvas) => (canvas as HTMLCanvasElement).width);
      await page.screenshot({ path: resolve(artifactDir, `${CASE_MARKER}-mobile.png`) });
      await writeFile(
        resolve(artifactDir, `${CASE_MARKER}.json`),
        JSON.stringify({ browserVersion, canvasWidth, pageErrors, pdfLogs, workerUrls }, null, 2),
      );
      expect(canvasWidth).toBeGreaterThan(0);
      expect(REGION_ERROR_TEXT.test(await page.locator("body").innerText())).toBe(false);
      expect(workerUrls.some((url) => url.includes("pdf.worker"))).toBe(true);
      expect(pdfLogs).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await chrome.close();
    }
  });
});
