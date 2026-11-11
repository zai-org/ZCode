// 单独运行：node --test <此文件>；前置为 dev Vite/Electron 已启动（默认 CDP 9229）。
// 独立页面挂真实 renderer，验证上方摘要交互；不声称覆盖 CLI 审批传输。
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

test("WFS02 编写无内容，待确认可展开；桌面深色与手机浅色", async () => {
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
        "../../../../../../../ui/test/fixtures/workflow-prelaunch.fixture.tsx",
        import.meta.url,
      ),
    );
    page = await context.newPage();
    await page.route("**/__workflow_prelaunch_smoke", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; await import('/@fs/${fixture}');</script>`,
      }),
    );
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: width === 1200 ? "dark" : "light" });
      await page.goto(`${origin}/__workflow_prelaunch_smoke`);
      const summary = page.locator(".group\\/tool-summary");
      await summary.waitFor();
      assert.match(await summary.innerText(), /Writing workflow/);
      assert.equal(await summary.getAttribute("role"), null);
      assert.equal(await page.locator("pre").count(), 0);
      await page.getByTestId("advance-state").click();
      assert.match(await summary.innerText(), /Awaiting workflow confirmation/);
      assert.equal(await summary.locator(".font-mono").count(), 0);
      assert.equal(
        await summary.locator(".tool-summary-kind-label.animated-gradient-text").count(),
        1,
      );
      assert.equal(await summary.getAttribute("aria-expanded"), "false");
      await summary.press("Enter");
      await page.locator("pre").first().waitFor();
      const code = page.getByTestId("workflow-script-codeblock");
      assert.equal(await code.getByRole("button", { name: "Copy code" }).count(), 1);
      // 高亮正文异步挂载，等待布局完成后再验证限高滚动。
      await page.waitForFunction(() => {
        const node = document.querySelector('[data-testid="workflow-script-codeblock"] .max-h-80');
        return node && node.clientHeight > 0 && node.scrollHeight > node.clientHeight;
      });
      assert.ok(
        await code
          .locator(".max-h-80")
          .evaluate((node) => node.clientHeight <= 320 && node.scrollHeight > node.clientHeight),
      );
      const copy = code.getByRole("button", { name: "Copy code" });
      const before = await copy.boundingBox();
      await code.locator(".max-h-80").evaluate((node) => {
        node.scrollTop = 100;
      });
      assert.equal((await copy.boundingBox()).y, before.y);
      assert.equal(await summary.getAttribute("aria-expanded"), "true");
      await summary.click();
      assert.equal(await summary.getAttribute("aria-expanded"), "false");
    }
  } finally {
    await page?.close();
    await context.close();
    await connection.close();
  }
});
