import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserContext, ConsoleMessage, Page, Request } from "playwright-core";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";

/** Desktop 的合成账号不会自动进入新浏览器上下文；仅为已启用的 loopback fixture 补齐登录前置。 */
export async function seedMobileFixtureLogin(context: BrowserContext): Promise<void> {
  const endpoint = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL;
  if (!endpoint || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname))
    return;
  await context.addInitScript((credentials) => {
    if (!location.protocol.startsWith("http")) return;
    for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
  }, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
}

function publicUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

/** 配对参数只留在内存；错误、控制台和页面文本不能把它们带入诊断记录。 */
export function redactMobileDiagnosticText(text: string, pairingUrl: string): string {
  const url = new URL(pairingUrl);
  const values = [
    ...url.searchParams.values(),
    ...new URLSearchParams(url.hash.slice(1)).values(),
    url.hash.slice(1),
  ];
  let result = text.split(pairingUrl).join(publicUrl(pairingUrl));
  for (const value of values) {
    if (value.length < 4) continue;
    result = result.split(value).join("<REDACTED>");
  }
  return result.replace(/https?:\/\/[^\s"'<>]+/gu, publicUrl);
}

/** 保留真实手机页面配对链路，同时在关闭 Playwright 上下文前保存失败现场。 */
export async function openMobilePairingPage(
  page: Page,
  pairingUrl: string,
  options: { artifactDir: string; caseMarker: string; phase: string; readySelector: string },
): Promise<void> {
  const redact = (value: string) => redactMobileDiagnosticText(value, pairingUrl);
  const failures: string[] = [];
  const record = (value: string) => {
    if (failures.length < 50) failures.push(redact(value));
  };
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === "error") record(message.text());
  };
  const onPageError = (error: Error) => record(error.message);
  const onRequestFailed = (request: Request) =>
    record(`${publicUrl(request.url())}: ${request.failure()?.errorText ?? "request failed"}`);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  try {
    // 修复原因：Windows 上 Vite 冷启动首次按需转换整个 remote 入口依赖，domcontentloaded 实测可达 ~57s（热缓存仅 ~11s），
    // 旧的 45s 超时在冷缓存下稳定失败；放宽到 120s，仍以真实页面加载为准，不加固定等待。
    await page.goto(pairingUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    // 新首页已展示共享项目/任务，不再渲染旧“已连接”文案；必须等调用方指定的真实内容。
    // Desktop 的手机连接状态仍由各 case 独立核对，空侧栏不能作为配对成功证据。
    const connected = page.locator(options.readySelector);
    const onboarding = page.getByTestId("onboarding-page");
    // 隔离测试账号可能尚未完成引导；通过真实“三步跳过”完成初始化。
    // 只点关闭不会保存记录，bridge 恢复重建 Root 时引导会再次遮住会话。
    await connected.or(onboarding).first().waitFor({ timeout: 60_000 });
    if (await onboarding.isVisible()) {
      for (const step of [1, 2, 3]) {
        await onboarding
          .locator('li[aria-current="step"]')
          .filter({ hasText: `${step}.` })
          .waitFor();
        await onboarding.getByRole("button", { name: /^(跳过|Skip)$/u }).click();
      }
      // Source Host 不一定提供引导记录 channel；偏好保存完成后仍可见时正常退出，
      // 让远控用例只依赖已保存的初始化偏好，不依赖引导记录 channel 的可用性。
      await page.waitForFunction(() => {
        const onboarding = document.querySelector('[data-testid="onboarding-page"]');
        return (
          !onboarding ||
          Array.from(onboarding.querySelectorAll("button")).some(
            (button) =>
              /^(开始使用|Get started)$/u.test(button.textContent?.trim() ?? "") &&
              !button.disabled,
          )
        );
      });
      if (await onboarding.isVisible()) {
        const saveError = onboarding.getByRole("alert");
        if (await saveError.isVisible()) {
          throw new Error(`首次引导偏好保存失败：${await saveError.textContent()}`);
        }
        await onboarding.getByRole("button", { name: /退出引导|Exit onboarding/u }).click();
      }
      await onboarding.waitFor({ state: "hidden", timeout: 30_000 });
    }
    await connected.waitFor({ timeout: 60_000 });
  } catch (error) {
    const prefix = resolve(
      options.artifactDir,
      `mobile-${options.phase.replace(/[^a-z0-9-]/giu, "-")}`,
    );
    try {
      await mkdir(options.artifactDir, { recursive: true });
      const snapshot = await page.evaluate(() => ({
        title: document.title,
        text: (document.body?.innerText ?? "").slice(0, 6000),
        testIds: Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).map(
          (node) => node.dataset.testid,
        ),
        scripts: Array.from(document.scripts)
          .map((node) => node.src)
          .filter(Boolean),
      }));
      await writeFile(
        `${prefix}.json`,
        JSON.stringify(
          {
            url: publicUrl(page.url()),
            ...snapshot,
            text: redact(snapshot.text),
            scripts: snapshot.scripts.map(publicUrl),
            failures,
          },
          null,
          2,
        ),
      );
      await page.screenshot({ path: `${prefix}.png`, fullPage: true });
    } catch (captureError) {
      record(`诊断采集失败: ${String(captureError)}`);
    }
    throw new Error(
      `${options.caseMarker}: 手机配对失败；${redact(String(error))}；${failures.join(" | ")}`,
    );
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
  }
}
