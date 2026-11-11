// 独立真实 renderer 验证 hover/focus；不依赖当前会话，不覆盖宿主侧栏路由。
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";

test("运行卡无箭头仍可收起，保留统计和侧栏入口", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => {
      process.stderr.write(String(error));
    });
    const targets = await (await fetch("http://localhost:9229/json/list")).json();
    const origin = new URL(targets.find((t) => t.type === "page").url).origin;
    await page.route("**/__workflow_hover", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
      await import('/@fs${process.cwd()}/packages/ui/test/fixtures/workflow-digest-fixed.fixture.tsx');
    </script>`,
      }),
    );
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${origin}/__workflow_hover`);
      const card = page.getByTestId("workflow-run-digest-fixed");
      await card.waitFor();
      const rail = card.getByTestId("workflow-timeline-rail").first();
      const railStyle = await rail.evaluate((node) => ({
        width: getComputedStyle(node).borderTopWidth,
        gradient: getComputedStyle(node, "::after").backgroundImage,
        animation: getComputedStyle(node, "::after").animationName,
      }));
      assert.equal(railStyle.width, "2px");
      assert.equal(
        await rail.evaluate((node) => getComputedStyle(node).borderTopColor),
        "rgba(0, 0, 0, 0)",
      );
      const stubWidths = await card
        .locator("[data-ledge-ink]")
        .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).borderTopWidth));
      assert.ok(stubWidths.every((width) => width === "1px"));
      assert.match(await rail.getAttribute("class"), /rounded-full/);
      assert.equal(
        await rail.evaluate((node) => getComputedStyle(node, "::after").borderRadius),
        await rail.evaluate((node) => getComputedStyle(node).borderRadius),
      );
      assert.match(railStyle.gradient, /^repeating-linear-gradient/);
      assert.equal(railStyle.animation, "wf-rail-slide");
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(
        await rail.evaluate((node) => getComputedStyle(node, "::after").animationName),
        "none",
      );
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const spine = page.getByTestId("workflow-run-spine-rail");
      assert.equal(await spine.evaluate((node) => getComputedStyle(node).width), "2px");
      assert.equal(
        await spine.evaluate((node) => getComputedStyle(node).backgroundColor),
        "rgba(0, 0, 0, 0)",
      );
      const resume = page.getByTestId("workflow-digest-resume");
      assert.equal(await resume.evaluate((node) => getComputedStyle(node).height), "28px");
      await resume.click();
      assert.equal(await page.locator("body").getAttribute("data-resumed"), "true");
      assert.doesNotMatch(
        await card.getByTestId("workflow-card-name").getAttribute("class"),
        /font-mono/,
      );
      // 瓦片脸（round 19）：内联 SVG，没有图片要等；身份是机身色相 --wf-face-body。
      const cluster = page.getByTestId("workflow-run-phase-cluster");
      assert.equal(await cluster.locator(".rounded-full").count(), 0);
      const avatarHues = await card
        .locator("svg[data-subagent-avatar]")
        .evaluateAll((nodes) => nodes.map((n) => n.style.getPropertyValue("--wf-face-body")));
      assert.equal(new Set(avatarHues).size, avatarHues.length);
      assert.ok(avatarHues.every((hue) => hue !== ""));
      assert.deepEqual(
        await cluster
          .locator("svg[data-subagent-avatar]")
          .evaluateAll((nodes) => nodes.map((n) => n.style.getPropertyValue("--wf-face-body"))),
        avatarHues,
      );
      const boxes = await cluster.locator("img, svg").evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return { left: r.left, right: r.right };
        }),
      );
      assert.ok(boxes.length > 1 && boxes[1].left >= boxes[0].right);

      assert.equal(
        await card
          .locator('[data-testid="workflow-agent-pill"] > svg[data-subagent-avatar]')
          .count(),
        2,
      );
      assert.equal(await card.locator(".wf-pill-avatar").count(), 0);
      assert.match(
        await card.getByTestId("workflow-timeline-fraction").first().getAttribute("class"),
        /text-ui-sm/,
      );
      const completed = card.locator(
        '[data-testid="workflow-pill-status"]:has(svg.lucide-circle-check)',
      );
      assert.equal(await completed.count(), 1);
      assert.equal(
        await completed.evaluate((node) => getComputedStyle(node).color),
        await card
          .locator('[data-testid="workflow-pill-status"]:has(svg.animate-spin)')
          .first()
          .evaluate((node) => getComputedStyle(node).color),
      );
      const loading = card.locator('[data-testid="workflow-pill-status"]:has(svg.animate-spin)');
      assert.equal(await loading.count(), 1);
      assert.match(await loading.getAttribute("class"), /text-foreground-subtle/);
      assert.doesNotMatch(await loading.getAttribute("class"), /text-warning/);

      assert.equal(await card.getByTestId("workflow-card-toggle").count(), 0);
      assert.equal(await card.getByTestId("workflow-digest-status").count(), 0);
      assert.equal(
        await card.getByTestId("workflow-card-detail").innerText(),
        "1 agent working · 1/2 steps",
      );
      assert.match(
        await card.getByTestId("workflow-card-detail").getAttribute("class"),
        /text-ui-base/,
      );
      assert.doesNotMatch(
        await card.getByTestId("workflow-card-detail").getAttribute("class"),
        /font-mono/,
      );
      assert.equal(await card.getByTestId("workflow-agent-pill").count(), 2);
      await card.click({ position: { x: 5, y: 5 } });
      assert.equal(await card.getByTestId("workflow-agent-pill").count(), 0);
      await card.focus();
      await card.press("Enter");
      assert.equal(await card.getByTestId("workflow-agent-pill").count(), 2);
      const pill = card.getByTestId("workflow-agent-pill").first();
      await pill.hover();
      await page.waitForFunction(() => {
        const pill = document.querySelector('[data-testid="workflow-agent-pill"]');
        return pill && getComputedStyle(pill).boxShadow === "none";
      });
      assert.match(await pill.getAttribute("class"), /rounded-full/);
      await pill.click();
      assert.equal(await page.locator("body").getAttribute("data-agent-opened"), "true");
      await card.getByTestId("workflow-card-open-details").click();
      assert.equal(await page.locator("body").getAttribute("data-open"), "true");
    }
  } finally {
    await browser.close();
  }
});
