// 手动回归前置：dev Electron（9229）已打开包含 CreateWorkflow run 的会话。
// 不发送模型请求、不改业务数据；复用当前会话验证真实 side pane 路由。
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";

test("WFS01 workflow 普通摘要打开同一个 run side pane", async () => {
  const connection = await chromium.connectOverCDP(
    process.env.ZCODE_E2E_CDP_URL ?? "http://localhost:9229",
  );
  try {
    const page = connection
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().includes("localhost:"));
    assert.ok(page, "需要正在运行的 dev Electron 页面");
    const summary = page.getByTestId("workflow-tool-summary").first();
    await summary.waitFor({ state: "attached", timeout: 120000 });
    // 历史工具默认折叠：展开祖先的 Radix trigger 后再执行真实用户点击。
    await summary.evaluate((node) => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (parent.id && parent.getAttribute("data-state") === "closed") {
          document.querySelector(`[aria-controls="${CSS.escape(parent.id)}"]`)?.click();
        }
      }
    });
    await summary.waitFor({ state: "visible", timeout: 10000 });
    const runId = await summary.getAttribute("data-workflow-run-id");
    assert.ok(runId);
    assert.equal(await summary.getByTestId("workflow-timeline-station").count(), 0);
    assert.match(await summary.innerText(), /Workflow.*\d/s);
    const trigger = summary.getByRole("button");
    const steps = summary.getByTestId("workflow-summary-steps");
    await page.mouse.move(0, 0);
    const idleColor = await steps.evaluate((node) => getComputedStyle(node).color);
    await trigger.hover();
    assert.notEqual(await steps.evaluate((node) => getComputedStyle(node).color), idleColor);
    await trigger.click();
    const pane = page
      .locator("div.flex.h-full[data-workflow-run-id]:not([data-testid])")
      .filter({ has: page.locator('[data-testid="workflow-run-graph-unavailable"], button') });
    await page.waitForFunction(
      (id) =>
        Array.from(
          document.querySelectorAll("div.flex.h-full[data-workflow-run-id]:not([data-testid])"),
        ).some((node) => node.getAttribute("data-workflow-run-id") === id),
      runId,
    );
    assert.ok((await pane.count()) > 0);
    await trigger.focus();
    await trigger.press("Enter");
    assert.equal(
      await page
        .locator("div.flex.h-full[data-workflow-run-id]:not([data-testid])")
        .evaluateAll(
          (nodes, id) =>
            nodes.filter((node) => node.getAttribute("data-workflow-run-id") === id).length,
          runId,
        ),
      1,
    );
  } finally {
    await connection.close();
  }
});
