// 单独运行：node --test <此文件>；前置为 dev Vite/Electron 已启动（默认 CDP 9229）。
// 独立页面挂真实 renderer，验证上方摘要交互；不声称覆盖 CLI 审批传输。
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

test("WFS03 snippet 三态内容与展开交互", async () => {
  const targets = await (
    await fetch(`${process.env.ZCODE_E2E_CDP_URL ?? "http://localhost:9229"}/json/list`)
  ).json();
  const app = targets.find((target) => target.type === "page" && target.url.includes("localhost:"));
  assert.ok(app);
  const origin = new URL(app.url).origin;
  const connection = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await connection.newContext();
  let page;
  try {
    const fixture = fileURLToPath(
      new URL(
        "../../../../../../../ui/test/fixtures/workflow-snippet.fixture.tsx",
        import.meta.url,
      ),
    );
    page = await context.newPage();
    await page.route("**/__workflow_snippet_smoke", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches); await import('/@fs/${fixture}');</script>`,
      }),
    );
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: width === 1200 ? "dark" : "light" });
      await page.goto(`${origin}/__workflow_snippet_smoke`);
      const summary = page.locator(".group\\/tool-summary");
      await summary.waitFor();
      // 2026-09-12 修订：进行中按整秒显示（0s/1s…），精确毫秒只在终态出现。
      assert.match(await summary.innerText(), /Running workflow snippet.*\d+s\b/s);
      assert.doesNotMatch(await summary.innerText(), /\d+ms/);
      await summary.click();
      await page.locator("pre").first().waitFor();
      assert.equal(
        await page
          .getByTestId("workflow-snippet-body")
          .locator("[data-language]")
          .first()
          .getAttribute("data-language"),
        "typescript",
      );
      assert.equal(await page.getByTestId("snippet-result").count(), 0);
      await page.getByTestId("complete").click();
      assert.equal(
        (await summary.innerText()).replace(/\s+/g, " ").trim(),
        "Workflow snippet · 427ms",
      );
      await page.getByTestId("snippet-result").waitFor();
      await page
        .getByTestId("snippet-result")
        .getByText(/package.json/)
        .first()
        .waitFor();
      assert.equal(
        await page
          .getByTestId("workflow-snippet-body")
          .locator("[data-language]")
          .first()
          .getAttribute("data-language"),
        "json",
      );
      assert.equal(await page.getByTestId("snippet-code").count(), 0);
      assert.equal(await page.getByTestId("snippet-logs").count(), 0);
      assert.equal(
        await page.getByTestId("workflow-snippet-body").locator("h4, summary").count(),
        0,
      );
      assert.doesNotMatch(
        await page.getByTestId("workflow-snippet-body").innerText(),
        /completed in|Return value:|427ms|PASS/,
      );
      assert.match(await page.getByTestId("workflow-snippet-body").getAttribute("class"), /mb-2/);
      assert.match(
        await page.getByTestId("workflow-snippet-body").locator(".max-h-80").getAttribute("class"),
        /max-h-80/,
      );
      const copy = page.getByTestId("snippet-result").getByRole("button", { name: "Copy code" });
      assert.equal(await copy.count(), 1);
      if (process.env.ZCODE_E2E_SCREENSHOT_PREFIX) {
        await page.screenshot({
          animations: "disabled",
          path: `${process.env.ZCODE_E2E_SCREENSHOT_PREFIX}-${width}.png`,
        });
      }

      await page.getByTestId("fail").click();
      assert.match(await summary.innerText(), /Failed|Execution failed/);
      assert.doesNotMatch(await summary.innerText(), /427ms|TIMEOUT/);
      await page
        .getByTestId("snippet-result")
        .getByText(/deadline exceeded/)
        .first()
        .waitFor();
      assert.equal(
        (await page.getByTestId("workflow-snippet-body").innerText()).match(/read 2 files/g)
          ?.length,
        1,
      );
    }
  } finally {
    await page?.close();
    await context.close();
    await connection.close();
  }
});
