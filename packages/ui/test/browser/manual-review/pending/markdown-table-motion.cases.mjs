import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

export function registerMarkdownTableMotionCases(context) {
  for (const width of [390, 1200])
    for (const theme of ["light", "dark"])
      test(`STF06 table motion ${width}/${theme}`, async () => {
        const { browser, origin, artifacts } = context();
        const page = await browser.newPage({ viewport: { width, height: 850 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        try {
          await page.goto(`${origin}fixture?table-motion=true&theme=${theme}`);
          await page
            .getByRole("button", { name: "Expand table scroll area", exact: true })
            .first()
            .waitFor();
          const sample = (action) =>
            page.evaluate(async (action) => {
              const frame = document.querySelector("[data-markdown-table-frame]");
              const content = frame.firstElementChild;
              const root = document.querySelector('[data-testid="table-layout-root"]');
              const widths = [];
              const transitions = new Set();
              const label =
                action === "expand" ? "Expand table scroll area" : "Collapse table scroll area";
              if (action === "resize")
                root.style.width = root.style.width === "80%" ? "100%" : "80%";
              else frame.parentElement.querySelector(`button[aria-label="${label}"]`).click();
              const start = performance.now();
              await new Promise((resolve) => {
                const tick = (now) => {
                  widths.push(content.getBoundingClientRect().width);
                  for (const animation of frame.getAnimations({ subtree: true })) {
                    if (
                      animation instanceof CSSTransition &&
                      /^(width|max-width)$/.test(animation.transitionProperty)
                    )
                      transitions.add(animation);
                  }
                  if (now - start >= 500) resolve();
                  else requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
              });
              return {
                widths: new Set(widths.map((w) => Math.round(w))).size,
                transitions: transitions.size,
                contentWidth: content.getBoundingClientRect().width,
                frameWidth: frame.getBoundingClientRect().width,
                inlineTransition: content.style.transitionProperty,
                modes: [...document.querySelectorAll("[data-markdown-table-toolbar]")].map(
                  (toolbar) => !!toolbar.querySelector('[aria-label="Collapse table scroll area"]'),
                ),
              };
            }, action);
          // 普通模式由 CSS 跟随；增强模式也不能叠加第二轮宽度动画。
          for (const mode of ["normal", "expanded"]) {
            if (mode === "expanded") {
              const expanded = await sample("expand");
              assert(expanded.transitions > 0 && expanded.widths > 2, JSON.stringify(expanded));
              assert.deepEqual(expanded.modes, [true, false]);
              assert.equal(expanded.inlineTransition, "");
            }
            const resized = await sample("resize");
            assert.equal(resized.transitions, 0, JSON.stringify(resized));
            assert(resized.widths > 2, JSON.stringify(resized));
          }
          const collapsed = await sample("collapse");
          assert(collapsed.transitions > 0 && collapsed.widths > 2, JSON.stringify(collapsed));
          assert(Math.abs(collapsed.contentWidth - collapsed.frameWidth) <= 1);
          assert.deepEqual(collapsed.modes, [false, false]);
          const interrupted = await page.evaluate(async () => {
            const frame = document.querySelector("[data-markdown-table-frame]");
            const content = frame.firstElementChild;
            frame.parentElement.querySelector('[aria-label="Expand table scroll area"]').click();
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
            const before = frame
              .getAnimations({ subtree: true })
              .filter(
                (animation) =>
                  animation instanceof CSSTransition &&
                  /^(width|max-width)$/.test(animation.transitionProperty),
              ).length;
            frame
              .querySelector("table")
              .parentElement.dispatchEvent(
                new WheelEvent("wheel", { deltaX: 50, bubbles: true, cancelable: true }),
              );
            await new Promise(requestAnimationFrame);
            return {
              before,
              transition: content.style.transitionProperty,
              offset: new DOMMatrix(getComputedStyle(content).transform).m41,
            };
          });
          assert(interrupted.before > 0, JSON.stringify(interrupted));
          assert.equal(interrupted.transition, "");
          assert(interrupted.offset < 0, JSON.stringify(interrupted));
          await sample("collapse");
          await page.emulateMedia({ reducedMotion: "reduce" });
          const reduced = await sample("expand");
          assert.equal(reduced.transitions, 0);
          assert.deepEqual(reduced.modes, [true, false]);
          await page.screenshot({ path: join(artifacts, `table-motion-${width}-${theme}.png`) });
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
}
