import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/probe-e2e-mobile-browser.mjs <report.json>");

const reportPath = resolve(output);
const executablePath = chromium.executablePath();
const probeDir = await mkdtemp(join(dirname(reportPath), "playwright-probe-"));

// 创建真实录制页面，才能同时验证调试连接和同版本的 Playwright ffmpeg。
try {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const viewport = { width: 160, height: 120 };
    const context = await browser.newContext({
      viewport,
      recordVideo: { dir: probeDir, size: viewport },
    });
    const page = await context.newPage();
    await page.setContent("<title>ZCode E2E browser probe</title><main>Browser and video</main>");
    if ((await page.title()) !== "ZCode E2E browser probe") {
      throw new Error("Playwright browser did not return the probe page title");
    }
    const video = page.video();
    await context.close();
    const videoBytes = video ? (await stat(await video.path())).size : 0;
    if (!videoBytes) throw new Error("Playwright recorder did not produce a video");
    const report = { executablePath, browserVersion: browser.version(), videoBytes };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[e2e] Chromium ${report.browserVersion} recorded ${videoBytes} bytes`);
  } finally {
    await browser.close();
  }
} finally {
  await rm(probeDir, { recursive: true, force: true });
}
