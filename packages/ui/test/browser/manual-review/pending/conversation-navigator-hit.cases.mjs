import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export function registerNavigatorHitCases(getContext) {
  for (const theme of ["light", "dark"])
    for (const width of [900, 1000, 1152]) {
      test(`navigator content hit region ${width}/${theme}`, async () => {
        const { browser, origin, artifacts } = getContext();
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        try {
          await page.goto(`${origin}fixture?navigatorHit=1&theme=${theme}`);
          await page.locator("nav button[data-item-index]").first().waitFor({ state: "visible" });
          await writeFile(
            join(artifacts, `navigator-dom-${width}-${theme}.html`),
            await page.content(),
          );
          const evidence = await page.evaluate(async () => {
            const scroller = document.querySelector('[data-testid="v4-timeline"]');
            scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
            const button = document.querySelector("nav button[data-item-index]");
            const link = [...document.querySelectorAll('[title^="https://example.com/"]')].find(
              (el) => {
                const r = el.getBoundingClientRect();
                return r.top > 100 && r.top < 600;
              },
            );
            if (!button || !link) throw new Error("Missing real navigator or Markdown link");
            const y = button.getBoundingClientRect().top + 5;
            scroller.scrollTop += link.getBoundingClientRect().top + 8 - y;
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
            const r = link.getBoundingClientRect();
            const x = r.left + 2;
            const hit = document.elementFromPoint(x, y);
            window.__linkClicks = 0;
            link.addEventListener("click", (event) => {
              event.preventDefault();
              window.__linkClicks++;
            });
            return {
              x,
              y,
              linkLeft: r.left,
              button: button.getBoundingClientRect().toJSON(),
              rootLeft: scroller.parentElement.getBoundingClientRect().left,
              hit: hit?.outerHTML,
              linkHit: hit === link || link.contains(hit),
            };
          });
          await writeFile(
            join(artifacts, `navigator-hit-${width}-${theme}.json`),
            JSON.stringify(evidence, null, 2),
          );
          await page.screenshot({ path: join(artifacts, `navigator-hit-${width}-${theme}.png`) });
          assert.equal(evidence.linkHit, true, JSON.stringify(evidence));
          assert.ok(Math.abs(evidence.button.left - evidence.rootLeft - 12) < 0.5);
          assert.ok(evidence.button.right <= evidence.linkLeft);
          await page.mouse.click(evidence.x, evidence.y);
          assert.equal(await page.evaluate(() => window.__linkClicks), 1);
          await page.mouse.move(evidence.x + 160, evidence.y);
          await page.mouse.down();
          await page.mouse.move(evidence.x + 90, evidence.y, { steps: 8 });
          await page.mouse.up();
          assert.ok(await page.evaluate(() => getSelection()?.toString().length > 0));
          await page.locator('nav button[data-item-index="1"]').click();
          await page.waitForFunction(
            () =>
              document.querySelector('nav button[data-item-index="1"]').dataset.active === "true",
          );
          const first = page.locator('nav button[data-item-index="0"]');
          await first.focus();
          await first.press("Enter");
          await page.waitForFunction(
            () => document.querySelector('[data-testid="v4-timeline"]').scrollTop < 100,
          );
          await first.hover();
          await page.waitForFunction(
            () =>
              document.querySelector('nav button[data-item-index="0"]').dataset.visualTone ===
              "peak",
          );
          assert.ok((await first.boundingBox()).width <= 24);
          // 居中缩放会让长短横线的左边缘错开；测量实际绘制边界，同时守住正文留白。
          await page.waitForFunction(
            () => {
              const buttons = [...document.querySelectorAll("nav button[data-item-index]")];
              return (
                buttons.length >= 2 &&
                buttons.every((button) => {
                  const bar = button.querySelector("span span").getBoundingClientRect();
                  const hit = button.getBoundingClientRect();
                  return Math.abs(bar.left - hit.left) < 0.5 && bar.right <= hit.right + 0.5;
                })
              );
            },
            undefined,
            { timeout: 2000 },
          );
          await page.screenshot({
            path: join(artifacts, `navigator-alignment-${width}-${theme}.png`),
          });
        } finally {
          await page.close();
        }
      });
    }

  for (const theme of ["light", "dark"]) {
    test(`navigator remains hidden on phone/${theme}`, async () => {
      const { browser, origin } = getContext();
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        await page.goto(`${origin}fixture?navigatorHit=1&mobile=true&theme=${theme}`);
        await page
          .locator('[title^="https://example.com/"]')
          .first()
          .waitFor({ state: "attached" });
        assert.equal(await page.locator("nav button[data-item-index]").first().isVisible(), false);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
      } finally {
        await page.close();
      }
    });
  }
}
