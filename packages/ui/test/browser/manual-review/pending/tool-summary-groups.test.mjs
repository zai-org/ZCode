import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/tool-summary-spacing.fixture.tsx";
let server, browser, origin;
const artifacts = join(root, "packages/desktop/.e2e-artifacts/tool-summary-spacing-browser");
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, "node_modules/.vite-tool-summary-spacing"),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "permission-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await browser?.close();
  await server?.close();
});
// 检查实际 CSS 动画，避免只有类名却未产生扫光的假通过。
async function assertShimmer(locator, expected) {
  const style = await locator.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      name: computed.animationName,
      state: computed.animationPlayState,
      background: computed.backgroundImage,
    };
  });
  if (expected) {
    assert.match(style.name, /gradient-flow/);
    assert.equal(style.state, "running");
    assert.notEqual(style.background, "none");
  } else {
    assert.doesNotMatch(style.name, /gradient-flow/);
  }
}
for (const theme of ["light", "dark"]) {
  for (const locale of ["en-US", "zh-CN"]) {
    test(`XSG02 lifecycle ${theme}/${locale}`, async () => {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${origin}fixture?share=1&theme=${theme}&locale=${locale}`);
        const group = page.locator("[data-consecutive-summary-group]").first();
        const trigger = group.locator("[data-summary-group-trigger]");
        await trigger.waitFor();
        assert.equal(await trigger.getAttribute("aria-expanded"), "false");
        assert.equal(await group.getAttribute("data-group-running"), "true");
        await page.getByRole("button", { name: "Tool done", exact: true }).click();
        const stats = group.locator("[data-summary-group-statistics]");
        await trigger.getByText("example.ts", { exact: true }).waitFor();
        await assertShimmer(trigger.locator(".tool-summary-kind-label"), true);
        assert.equal(await stats.count(), 0);
        assert.equal(await group.getAttribute("data-group-running"), "true");
        await trigger.click();
        await stats.waitFor();
        assert.match(await stats.getAttribute("class"), /animated-gradient-text/);
        const completedChildren = group.locator(
          '[data-conversation-work-items="group"] .tool-summary-kind-label',
        );
        for (const label of await completedChildren.all()) await assertShimmer(label, false);
        await page.getByRole("button", { name: "Next summary", exact: true }).click();
        assert.equal(await trigger.getAttribute("aria-expanded"), "true");
        await trigger.click();
        assert.equal(await stats.count(), 0);
        await page.getByRole("button", { name: "Tool done", exact: true }).click();
        assert.equal(await stats.count(), 0);
        assert.equal(await group.getAttribute("data-group-running"), "true");
        const thoughtLabel = trigger.locator("[data-reasoning-label] .font-normal").first();
        await thoughtLabel.waitFor();
        await assertShimmer(thoughtLabel, true);
        await page.getByRole("button", { name: "Text boundary", exact: true }).click();
        await page.waitForFunction(
          () =>
            document
              .querySelector("[data-consecutive-summary-group]")
              ?.getAttribute("data-group-running") === "false",
        );
        assert.doesNotMatch(await stats.getAttribute("class"), /animated-gradient-text/);
        await assertShimmer(stats, false);
        await trigger.click();
        await page.getByRole("button", { name: "Finish", exact: true }).click();
        assert.equal(await trigger.getAttribute("aria-expanded"), "true");
        // 正文闭合和任务结束是两条独立路径，不能让前者掩盖末尾组结算。
        await page.goto(`${origin}fixture?share=1&theme=${theme}&locale=${locale}`);
        await trigger.waitFor();
        assert.equal(await group.getAttribute("data-group-running"), "true");
        await page.getByRole("button", { name: "Finish", exact: true }).click();
        await page.waitForFunction(
          () =>
            document
              .querySelector("[data-consecutive-summary-group]")
              ?.getAttribute("data-group-running") === "false",
        );
        assert.doesNotMatch(await stats.getAttribute("class"), /animated-gradient-text/);
        await assertShimmer(stats, false);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
    test(`XSG02 change files ${theme}/${locale}`, async () => {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      try {
        await page.goto(`${origin}fixture?share=1&changes=1&theme=${theme}&locale=${locale}`);
        await page.getByRole("button", { name: "Finish", exact: true }).click();
        const files = page.locator("[data-change-summary-files]");
        await files.waitFor();
        assert.equal(await files.locator("[data-tool-file-name]").count(), 1);
        assert.match(await files.innerText(), /App.tsx/);
        const trigger = page.locator("[data-summary-group-trigger]").first();
        assert.equal(await trigger.getAttribute("aria-expanded"), "false");
        await files.locator("[data-tool-file-name]").first().hover();
        const tooltip = page.getByRole("tooltip");
        await tooltip.waitFor();
        assert.match(await tooltip.innerText(), /\/workspace\/src\/App.tsx/);
        for (let i = 0; i < 4; i++)
          await page.getByRole("button", { name: "Next summary", exact: true }).click();
        await page.getByRole("button", { name: "Finish", exact: true }).click();
        assert.equal(await files.locator("[data-tool-file-name]").count(), 5);
        await page.setViewportSize({ width: 390, height: 900 });
        await page.locator("[data-change-summary-overflow]").waitFor();
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.waitForFunction(() => !document.querySelector("[data-change-summary-overflow]"));
        await trigger.click();
        await files.waitFor({ state: "hidden" });
        assert.equal(await trigger.getAttribute("aria-expanded"), "true");
      } finally {
        await page.close();
      }
    });
  }
}

for (const width of [390, 1200])
  for (const theme of ["light", "dark"]) {
    test(`group boundary spacing ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${origin}fixture?share=1&theme=${theme}&locale=en-US`);
        await page.locator("[data-summary-group-trigger]").first().waitFor();
        for (let i = 0; i < 11; i++)
          await page.getByRole("button", { name: "Next summary", exact: true }).click();
        await page.getByRole("button", { name: "Finish", exact: true }).click();
        const first = page.locator("[data-consecutive-summary-group]").first();
        const last = page.locator("[data-consecutive-summary-group]").last();
        const measure = async () => {
          const after = await first.evaluate((el) => {
            const next = el.nextElementSibling;
            return (
              next.querySelector(".summary-hover-text").getBoundingClientRect().top -
              el.getBoundingClientRect().bottom
            );
          });
          const before = await last.evaluate((el) => {
            const previous = el.previousElementSibling;
            return (
              el.querySelector("[data-summary-group-trigger]").getBoundingClientRect().top -
              previous.getBoundingClientRect().bottom
            );
          });
          assert.ok(Math.abs(after - 16) < 1, `group → agent: ${after}`);
          assert.ok(Math.abs(before - 16) < 1, `workflow → group: ${before}`);
        };
        const assertSingleLine = async () => {
          const metrics = await first.locator("[data-summary-group-statistics]").evaluate((el) => ({
            height: el.getBoundingClientRect().height,
            lineHeight: parseFloat(getComputedStyle(el).lineHeight),
            whiteSpace: getComputedStyle(el).whiteSpace,
            overflow: getComputedStyle(el).textOverflow,
            title: el.getAttribute("title"),
          }));
          assert.equal(metrics.whiteSpace, "nowrap");
          assert.equal(metrics.overflow, "ellipsis");
          assert.ok(metrics.height <= metrics.lineHeight + 1);
          assert.ok(metrics.title?.includes("Explored"));
        };
        await measure();
        await assertSingleLine();
        await first.locator("[data-summary-group-trigger]").click();
        // 等待共享折叠动画结束，仅用于测量，不参与产品逻辑。
        await page.waitForTimeout(500);
        await measure();
        await assertSingleLine();
        assert.equal(
          await first
            .locator("[data-conversation-work-items]")
            .evaluate((el) => getComputedStyle(el).rowGap),
          "8px",
        );
        const headerBox = await first.locator("[data-summary-group-trigger]").boundingBox();
        const contentBox = await first.locator("[data-summary-group-scroll]").boundingBox();
        assert.ok(Math.abs(contentBox.y - headerBox.y - headerBox.height - 8) < 1);
        const childList = first.locator('[data-conversation-work-items="group"]');
        const guide = await childList.evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            border: getComputedStyle(el, "::before").borderLeftWidth,
            margin: style.marginLeft,
            padding: style.paddingLeft,
          };
        });
        assert.deepEqual(guide, { border: "1px", margin: "8px", padding: "16px" });
        const headerX = await first
          .locator("[data-summary-group-statistics]")
          .evaluate((el) => el.getBoundingClientRect().left);
        const textPositions = await childList
          .locator(".tool-summary-kind-label, [data-reasoning-label]")
          .evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect().left));
        assert.ok(textPositions.length >= 2);
        for (const x of textPositions)
          assert.ok(Math.abs(x - headerX) < 0.1, `child text ${x}, header ${headerX}`);
        const childIcons = childList.locator("[data-summary-leading-icon]");
        assert.ok((await childIcons.count()) > 0);
        assert.ok(
          await childIcons.evaluateAll((elements) =>
            elements.every((el) => getComputedStyle(el).display === "none"),
          ),
        );
        assert.equal(await first.locator("[data-summary-group-icon]").isVisible(), true);
        await childList.locator('[data-testid="chat-reasoning-trigger"]').click();
        const thoughtBody = childList.locator("[data-reasoning-scroll-mask]");
        await thoughtBody.waitFor();
        // 截图与几何验收等待真实展开动画，避免只截到内容高度为零的首帧。
        await first.evaluate(async (el) => {
          await Promise.all(
            el
              .getAnimations({ subtree: true })
              .map((animation) => animation.finished.catch(() => {})),
          );
        });
        const thoughtLayout = await thoughtBody.evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            border: style.borderLeftWidth,
            margin: style.marginLeft,
            padding: style.paddingLeft,
            x: el.getBoundingClientRect().left,
          };
        });
        assert.deepEqual(
          {
            border: thoughtLayout.border,
            margin: thoughtLayout.margin,
            padding: thoughtLayout.padding,
          },
          { border: "0px", margin: "0px", padding: "0px" },
        );
        assert.ok(Math.abs(thoughtLayout.x - headerX) < 0.1);
        assert.equal(
          await thoughtBody.evaluate((el) => getComputedStyle(el.parentElement).paddingTop),
          "4px",
        );
        await page.screenshot({ path: join(artifacts, `boundary-${width}-${theme}.png`) });
      } finally {
        await page.close();
      }
    });
  }

for (const width of [390, 1200])
  for (const theme of ["light", "dark"]) {
    test(`outer summary spacing ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1600 } });
      page.on("pageerror", (error) => console.error(error.message));
      page.setDefaultTimeout(5000);
      try {
        await page.goto(`${origin}fixture?theme=${theme}&locale=en-US`);
        await page.locator('[data-example="agent"] .summary-hover-text').waitFor();
        const pairs = [
          ["reasoning-hover", "reasoning-running-hover"],
          ["agent", "agent-pending"],
          ["agent-stopped", "todo-spacing"],
          ["todo-spacing", "cua-hover"],
          ["read", "write"],
        ];
        for (const [before, after] of pairs) {
          const previous = await page.locator(`[data-example="${before}"]`).boundingBox();
          const next = await page
            .locator(`[data-example="${after}"] .summary-hover-text`)
            .first()
            .boundingBox();
          assert.ok(
            Math.abs(next.y - previous.y - previous.height - 16) < 1,
            `${before} → ${after}: ${next.y - previous.y - previous.height}`,
          );
        }
        await page.screenshot({ path: join(artifacts, `outer-${width}-${theme}.png`) });
      } finally {
        await page.close();
      }
    });
  }

for (const width of [390, 1200])
  for (const theme of ["light", "dark"]) {
    test(`group scrolling ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${origin}fixture?scroll=1&theme=${theme}`);
        const trigger = page.locator("[data-summary-group-trigger]");
        await trigger.click();
        const group = page.locator("[data-summary-group-scroll]");
        // 等待折叠区域展开后再测量和截图；运行态扫光是无限动画，不参与等待。
        await group.evaluate(async (el) => {
          const animations = el
            .closest("[data-consecutive-summary-group]")
            .getAnimations({ subtree: true });
          await Promise.all(
            animations
              .filter((animation) => animation.effect.getTiming().iterations !== Infinity)
              .map((animation) => animation.finished.catch(() => {})),
          );
        });
        const thinking = page.locator("[data-reasoning-scroll-mask]");
        // 独立思考保留自身导线与缩进，分组样式不能泄漏到外部。
        assert.deepEqual(
          await thinking.evaluate((el) => {
            const style = getComputedStyle(el);
            return [style.borderLeftWidth, style.marginLeft, style.paddingLeft];
          }),
          ["1px", "8px", "14px"],
        );
        assert.equal(
          await thinking.evaluate((el) => getComputedStyle(el.parentElement).paddingTop),
          "12px",
        );
        const atBottom = async (locator) => {
          await page.waitForFunction(
            (selector) => {
              const el = document.querySelector(selector);
              return el && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2;
            },
            (await locator.getAttribute("data-summary-group-scroll")) !== null
              ? "[data-summary-group-scroll]"
              : "[data-reasoning-scroll-mask]",
          );
        };
        await atBottom(group);
        await atBottom(thinking);
        const geometry = await group.evaluate((el) => ({
          height: el.clientHeight,
          line: parseFloat(getComputedStyle(el).lineHeight),
          overflow: el.scrollHeight > el.clientHeight,
        }));
        assert.ok(geometry.overflow);
        assert.ok(Math.abs(geometry.height - (geometry.line * 16 + 120)) <= 1);
        assert.equal(await group.getAttribute("data-scroll-mask"), "top");
        await page.screenshot({ path: join(artifacts, `scroll-bottom-${width}-${theme}.png`) });
        await page.getByRole("button", { name: "Append", exact: true }).click();
        await atBottom(group);
        await atBottom(thinking);
        await page.getByRole("button", { name: "Grow", exact: true }).click();
        await atBottom(group);
        for (const locator of [group, thinking]) {
          await locator.evaluate((el) => {
            el.scrollTop = 30;
            el.dispatchEvent(new Event("scroll"));
          });
        }
        await page.getByRole("button", { name: "Append", exact: true }).click();
        await page.waitForTimeout(100);
        assert.equal(await group.evaluate((el) => el.scrollTop), 30);
        assert.equal(await thinking.evaluate((el) => el.scrollTop), 30);
        assert.equal(await group.getAttribute("data-scroll-mask"), "both");
        await page.screenshot({ path: join(artifacts, `scroll-middle-${width}-${theme}.png`) });
        await group.evaluate((el) => {
          el.scrollTop = 0;
          el.dispatchEvent(new Event("scroll"));
        });
        await page.waitForFunction(
          () =>
            document
              .querySelector("[data-summary-group-scroll]")
              ?.getAttribute("data-scroll-mask") === "bottom",
        );
        for (const locator of [group, thinking])
          await locator.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
            el.dispatchEvent(new Event("scroll"));
          });
        await page.getByRole("button", { name: "Append", exact: true }).click();
        await atBottom(group);
        await atBottom(thinking);
        await trigger.click();
        await page.waitForTimeout(300);
        await trigger.click();
        await atBottom(group);
        await page.getByRole("button", { name: "Grow", exact: true }).click();
        await page.getByRole("button", { name: "Short", exact: true }).click();
        await page.waitForFunction(
          () =>
            document
              .querySelector("[data-summary-group-scroll]")
              ?.getAttribute("data-scroll-mask") === "none",
        );
        await page.screenshot({ path: join(artifacts, `scroll-${width}-${theme}.png`) });
      } finally {
        await page.close();
      }
    });
  }

for (const theme of ["light", "dark"])
  for (const locale of ["en-US", "zh-CN"]) {
    test(`XSG02 session tools ${theme}/${locale}`, async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${origin}fixture?share=1&sessions=1&theme=${theme}&locale=${locale}`);
        const group = page.locator("[data-consecutive-summary-group]").first();
        const trigger = group.locator("[data-summary-group-trigger]");
        await trigger.waitFor();
        assert.equal(await trigger.getAttribute("aria-expanded"), "false");
        await trigger.click();
        await group
          .getByText(locale === "en-US" ? "Read session" : "读取会话", { exact: true })
          .click();
        await group.getByText("Session detail preserved", { exact: true }).waitFor();
        for (let i = 0; i < 4; i++)
          await page.getByRole("button", { name: "Next summary", exact: true }).click();
        assert.equal(await page.locator("[data-consecutive-summary-group]").count(), 1);
        assert.equal(await trigger.getAttribute("aria-expanded"), "true");
        const stats = group.locator("[data-summary-group-statistics]");
        assert.match(
          await stats.innerText(),
          locale === "en-US" ? /^Run 5 commands$/ : /^执行 5 命令$/,
        );

        assert.equal(
          await group
            .locator('[data-conversation-work-items="group"] [data-summary-leading-icon]:visible')
            .count(),
          0,
        );
        await page.getByRole("button", { name: "Next summary", exact: true }).click();
        assert.equal(await group.getAttribute("data-group-running"), "false");
        assert.match(
          await stats.innerText(),
          locale === "en-US" ? /^Ran 5 commands$/ : /^已执行 5 命令$/,
        );
        for (let i = 0; i < 2; i++)
          await page.getByRole("button", { name: "Next summary", exact: true }).click();
        assert.equal(await page.locator("[data-consecutive-summary-group]").count(), 2);
        await page.getByRole("button", { name: "Finish", exact: true }).click();
        const sessionOnlyStats = page
          .locator("[data-consecutive-summary-group]")
          .nth(1)
          .locator("[data-summary-group-statistics]");
        assert.match(
          await sessionOnlyStats.innerText(),
          locale === "en-US" ? /^Ran 2 commands$/ : /^已执行 2 命令$/,
        );
        for (const width of [390, 1200]) {
          await page.setViewportSize({ width, height: 900 });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({
            path: join(artifacts, `session-group-${width}-${theme}-${locale}.png`),
          });
        }
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["en-US", "zh-CN"]) {
      test(`Bash description ${width}/${theme}/${locale}`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          reducedMotion: "reduce",
        });
        page.setDefaultTimeout(15000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          for (const description of ["present", "empty", "missing"]) {
            await page.goto(
              `${origin}fixture?share=1&bash=1&theme=${theme}&locale=${locale}&description=${description}`,
            );
            const expected =
              description === "present" ? "检查当前项目的构建结果" : "echo bash-summary-output";
            const solo = page.locator("[data-bash-standalone]");
            await solo.getByText(expected, { exact: true }).waitFor();
            if (description === "present") {
              await solo.getByText(expected, { exact: true }).click();
              await solo.getByTestId("execute-command").waitFor();
              await solo.getByText(expected, { exact: true }).waitFor({ state: "visible" });
              await solo.getByText(expected, { exact: true }).click();
              await solo.getByTestId("execute-command").waitFor({ state: "hidden" });
              await solo.getByText(expected, { exact: true }).waitFor({ state: "visible" });
            }
            const group = page.locator("[data-consecutive-summary-group]").first();
            const trigger = group.locator("[data-summary-group-trigger]");
            await trigger.getByText(expected, { exact: true }).waitFor();
            if (description === "present")
              assert.ok(!(await trigger.innerText()).includes("echo bash-summary-output"));
            await page.screenshot({
              animations: "disabled",
              path: join(artifacts, `bash-active-${width}-${theme}-${locale}-${description}.png`),
            });
            await trigger.click();
            const children = group.locator('[data-conversation-work-items="group"]');
            await children.getByText(expected, { exact: true }).click();
            await children.getByTestId("execute-command").waitFor();
            if (description === "present")
              await children.getByText(expected, { exact: true }).waitFor({ state: "visible" });
            assert.match(
              await children.getByTestId("execute-command").innerText(),
              /echo bash-summary-output/,
            );
            assert.equal(
              await children.getByTestId("bash-output-preview-full").innerText(),
              "bash-summary-output",
            );
            await page.screenshot({
              animations: "disabled",
              path: join(
                artifacts,
                `bash-description-${width}-${theme}-${locale}-${description}.png`,
              ),
            });
            await trigger.click();
            await page.getByRole("button", { name: "Tool done", exact: true }).click();
            await trigger.getByText(expected, { exact: true }).waitFor();
            await assertShimmer(trigger.locator(".tool-summary-kind-label"), true);
            await assertShimmer(solo.locator(".tool-summary-kind-label"), false);
            assert.equal(await group.locator("[data-summary-group-statistics]").count(), 0);
            assert.equal(await group.getAttribute("data-group-running"), "true");
            await page.screenshot({
              animations: "disabled",
              path: join(artifacts, `bash-idle-${width}-${theme}-${locale}-${description}.png`),
            });
            await page.getByRole("button", { name: "Finish", exact: true }).click();
            await group.locator("[data-summary-group-statistics]").waitFor();
            assert.ok(!(await trigger.innerText()).includes(expected));
          }
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }

for (const width of [390, 1200])
  for (const theme of ["light", "dark"]) {
    test(`group scroll chain ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${origin}fixture?scroll=1&chain=1&theme=${theme}`);
        await page.locator("[data-summary-group-trigger]").click();
        const group = page.locator("[data-summary-group-scroll]");
        const parent = page.locator("[data-scroll-parent]");
        await group.evaluate(async (el) => {
          await Promise.all(
            el
              .closest("[data-consecutive-summary-group]")
              .getAnimations({ subtree: true })
              .filter((a) => a.effect.getTiming().iterations !== Infinity)
              .map((a) => a.finished.catch(() => {})),
          );
        });
        const metrics = async () => ({
          inner: await group.evaluate((el) => el.scrollTop),
          outer: await parent.evaluate((el) => el.scrollTop),
        });
        // 原生滚轮验证滚动链；程序化赋值仅用于准备起点，不代替用户动作。
        const wheelOverGroup = async (delta) => {
          const box = await group.boundingBox();
          const outerBox = await parent.boundingBox();
          await page.mouse.move(
            box.x + box.width / 2,
            (Math.max(box.y, outerBox.y) +
              Math.min(box.y + box.height, outerBox.y + outerBox.height)) /
              2,
          );
          await page.mouse.wheel(0, delta);
          await page.waitForTimeout(300);
          return metrics();
        };
        const resetParent = async () => {
          await parent.evaluate((el) => {
            el.scrollTop = 0;
          });
        };
        assert.ok(await parent.evaluate((el) => el.scrollHeight > el.clientHeight));
        assert.ok(await group.evaluate((el) => el.scrollHeight > el.clientHeight));
        const bottom = await metrics();
        const down = await wheelOverGroup(180);
        console.log(
          JSON.stringify({ width, theme, scenario: "bottom", before: bottom, after: down }),
        );
        assert.ok(down.outer > bottom.outer, "bottom edge must scroll parent downward");
        assert.equal(down.inner, bottom.inner);

        await group.evaluate((el) => {
          el.scrollTop = 0;
        });
        await parent.evaluate((el) => {
          el.scrollTop = 100;
        });
        const up = await wheelOverGroup(-60);
        assert.ok(up.outer < 100, "top edge must scroll parent upward");
        assert.equal(up.inner, 0);
        console.log(JSON.stringify({ width, theme, scenario: "top", after: up }));

        await resetParent();
        await group.evaluate((el) => {
          el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
        });
        const middle = await metrics();
        const innerDown = await wheelOverGroup(20);
        assert.ok(innerDown.inner > middle.inner, "available inner space consumes downward scroll");
        assert.equal(innerDown.outer, 0);
        const innerUp = await wheelOverGroup(-20);
        assert.ok(innerUp.inner < innerDown.inner, "available inner space consumes upward scroll");
        assert.equal(innerUp.outer, 0);

        await page.getByRole("button", { name: "Short", exact: true }).click();
        await page.waitForFunction(() => {
          const el = document.querySelector("[data-summary-group-scroll]");
          return el.scrollHeight === el.clientHeight && el.dataset.scrollMask === "none";
        });
        assert.ok((await wheelOverGroup(180)).outer > 0, "short group must let parent scroll");
        await resetParent();
        for (let i = 0; i < 8; i++)
          await page.getByRole("button", { name: "Append", exact: true }).click();
        await page.waitForFunction(() => {
          const el = document.querySelector("[data-summary-group-scroll]");
          return el.scrollHeight > el.clientHeight && el.dataset.scrollMask === "top";
        });
        assert.ok(
          (await wheelOverGroup(180)).outer > 0,
          "grown group still passes bottom edge scroll",
        );
        await resetParent();
        const trigger = page.locator("[data-summary-group-trigger]");
        await trigger.click();
        await group.waitFor({ state: "hidden" });
        await trigger.click();
        await page.waitForFunction(() => {
          const el = document.querySelector("[data-summary-group-scroll]");
          return (
            el &&
            el.clientHeight > 0 &&
            el.scrollHeight > el.clientHeight &&
            Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2
          );
        });
        assert.ok(
          (await wheelOverGroup(180)).outer > 0,
          "reopened group still passes bottom edge scroll",
        );
        await page.screenshot({ path: join(artifacts, `scroll-chain-${width}-${theme}.png`) });
      } finally {
        await page.close();
      }
    });
  }
