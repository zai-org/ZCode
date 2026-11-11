import assert from "node:assert/strict";
import { test } from "node:test";

export function registerSidePaneWidthCases(getBrowser, getOrigin) {
  for (const theme of ["light", "dark"]) {
    for (const mode of ["normal", "fullView", "screenshot", "stacked", "mobile"]) {
      test(`STF04 temporary width boundary ${mode}/${theme}`, async () => {
        const page = await getBrowser().newPage({
          viewport: { width: ["mobile", "stacked"].includes(mode) ? 390 : 1200, height: 800 },
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`${getOrigin()}fixture?hidden&noBridge&theme=${theme}&${mode}=1`);
          await page
            .locator('[data-testid="panel-fixture"] > div')
            .first()
            .waitFor({ state: "attached" });
          const result = await page.evaluate(() => {
            const wrapper = document.querySelector('[data-testid="panel-fixture"]');
            // 注入动画展示层的临时宽度，验证真实组件是否在特殊宿主上隔离该样式。
            wrapper.style.setProperty("--side-pane-content-width", "300px");
            const frame =
              document.querySelector('[data-workspace-side-frame="true"]') ??
              wrapper.firstElementChild.firstElementChild;
            const panel = document.querySelector("#browser > div");
            return {
              width: frame?.getBoundingClientRect().width,
              opacity: panel && getComputedStyle(panel).opacity,
            };
          });
          assert.ok(Number.isFinite(result.width));
          if (mode === "normal") assert.equal(result.width, 300);
          else assert.notEqual(result.width, 300);
          if (mode === "screenshot") assert.equal(result.opacity, "1");
          if (mode === "mobile") assert.equal(await page.locator("#browser").count(), 0);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }
  }
}
