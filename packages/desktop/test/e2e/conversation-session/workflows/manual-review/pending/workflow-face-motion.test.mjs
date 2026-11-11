// 真实组件浏览器验证；仅 renderer 展示，无 provider / host 协议。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
// esbuild 是 Vite 已安装的构建依赖，不添加运行时依赖。
const { build } = require(createRequire(require.resolve("vite")).resolve("esbuild"));

test("WFA01 四态随机眼睛：真实双眨、开心眼上下抖、机身不动及 reduced-motion", async () => {
  const output = await mkdtemp(join(tmpdir(), "workflow-face-"));
  const compiled = await build({
    entryPoints: ["packages/ui/test/fixtures/workflow-face-motion.fixture.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: { "@": join(process.cwd(), "packages/ui/src") },
  });
  const source = await readFile("packages/ui/src/styles.css", "utf8");
  const start = source.indexOf(".wf-face {");
  const reducedStart = source.indexOf("  .wf-face-body,", source.indexOf("/* 瓦片脸：动作归零"));
  const css =
    source.slice(start, source.indexOf("@keyframes wf-arrive", start)) +
    "@media(prefers-reduced-motion:reduce){" +
    source.slice(reducedStart, source.indexOf("\n}", reducedStart)) +
    "}";
  await writeFile(
    join(output, "preview.html"),
    `<!doctype html><meta charset="utf-8"><title>Workflow face preview</title><style>${css}
  body{font:14px system-ui;background:#fafafa;color:#222;padding:24px}body.dark{background:#181818;color:#eee}svg{width:100%;height:100%;overflow:visible}button{padding:8px 16px;margin-right:8px;border-radius:8px;border:1px solid #888;background:transparent;color:inherit}button[aria-pressed=true]{background:#7774}</style><div id="root"></div><script>${compiled.outputFiles[0].text}</script>`,
  );
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.clock.install();
    await page.goto(pathToFileURL(join(output, "preview.html")).href);
    const face = page.locator("svg").first();
    await face.waitFor();
    // 请求更小尺寸也不能突破 20px 下限；大尺寸预览仍可放大。
    // 参考轮廓的真实 SVG 边界：开心更高、困倦更浅、疑惑右眼为圆形。
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.querySelector("svg")?.dataset.motion === "idle");
    for (const [expression, y, height] of [
      ["happy", 6, 5],
      ["sleepy", 7, 4],
      ["focused", 6, 6],
      ["sad", 6, 6],
    ]) {
      const bounds = await face.evaluate((node, name) => {
        node.dataset.expression = name;
        return Array.from(node.querySelectorAll(`[data-eye-expression="${name}"] path`), (p) => {
          const box = p.getBBox();
          return { width: box.width, y: box.y, height: box.height };
        });
      }, expression);
      assert.deepEqual(bounds, [
        { width: 4, y, height },
        { width: 4, y, height },
      ]);
    }
    const smallFace = page.locator("svg").nth(9);
    await smallFace.evaluate((n) => {
      n.style.width = "14px";
      n.style.height = "14px";
    });
    assert.deepEqual(
      await smallFace.evaluate((n) => ({
        width: n.getBoundingClientRect().width,
        height: n.getBoundingClientRect().height,
      })),
      { width: 20, height: 20 },
    );
    assert.equal(await face.evaluate((n) => n.getBoundingClientRect().width), 48);
    await smallFace.evaluate((n) => {
      n.style.removeProperty("width");
      n.style.removeProperty("height");
    });

    for (const width of [1200, 390])
      for (const dark of [false, true]) {
        await page.setViewportSize({ width, height: 420 });
        await page.evaluate((d) => {
          document.body.classList.toggle("dark", d);
          document.documentElement.classList.toggle("dark", d);
          Math.random = () => 0.2;
        }, dark);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.waitForFunction(() => document.querySelector("svg")?.dataset.motion === "idle");
        for (const [status, expression] of [
          ["pending", "dots"],
          ["running", "pill"],
          ["failed", "sad"],
          ["done", "happy"],
        ]) {
          await page.locator(`[data-status="${status}"]`).click();
          assert.equal(await face.getAttribute("data-expression"), expression);
          assert.equal(await face.getAttribute("viewBox"), "0 0 20 20");
          assert.equal(await face.locator(".wf-face-body").getAttribute("rx"), "7");
          assert.deepEqual(
            await face
              .locator('[data-eye-expression="pill"] rect')
              .evaluateAll((nodes) =>
                nodes.map((n) => ["x", "y", "width", "height", "rx"].map((k) => n.getAttribute(k))),
              ),
            [
              ["7", "6", "4", "6", "2"],
              ["13", "6", "4", "6", "2"],
            ],
          );
          assert.equal(await face.getAttribute("data-motion"), "idle");
          assert.equal(
            await face
              .locator(`[data-eye-expression="${expression}"]`)
              .evaluate((n) => getComputedStyle(n).display),
            "inline",
          );
        }
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.waitForTimeout(80);
        await page.clock.runFor(1600);
        assert.equal(await face.getAttribute("data-motion"), "hop");
        const bounce = await face.locator(".wf-face-bounce").evaluate((node) => {
          const animation = node.getAnimations()[0];
          animation.pause();
          animation.currentTime = 84;
          return getComputedStyle(node).transform;
        });
        assert.match(bounce, /, -1\)/);
        assert.notEqual(bounce, "matrix(1, 0, 0, 1, 0, 0)");
        assert.equal(
          await face.locator(".wf-face-body").evaluate((n) => getComputedStyle(n).transform),
          "none",
        );
        await page.locator('[data-status="running"]').click();
        assert.equal(await face.getAttribute("data-expression"), "pill");
        await page.clock.runFor(1600);
        assert.equal(await face.getAttribute("data-motion"), "blink");
        const scale = await face.locator(".wf-face-lids").evaluate((node) => {
          const animation = node.getAnimations()[0];
          animation.pause();
          animation.currentTime = Number(animation.effect.getTiming().duration) * 0.35;
          return getComputedStyle(node).transform;
        });
        assert.match(scale, /0\.33333/);
        const closed = await face.locator(".wf-face-closed").evaluate((node) => {
          const animation = node.getAnimations()[0];
          animation.pause();
          animation.currentTime = Number(animation.effect.getTiming().duration) * 0.35;
          return {
            opacity: getComputedStyle(node).opacity,
            eyes: Array.from(node.querySelectorAll("rect"), (n) =>
              ["x", "y", "width", "height", "rx"].map((k) => n.getAttribute(k)),
            ),
          };
        });
        assert.equal(closed.opacity, "1");
        assert.deepEqual(closed.eyes, [
          ["7", "8", "4", "2", "1"],
          ["13", "8", "4", "2", "1"],
        ]);
        await page.clock.runFor(430);
        assert.equal(await face.getAttribute("data-motion"), "glance");
        assert.equal(await face.evaluate((n) => n.style.getPropertyValue("--wf-face-x")), "-4px");
        // 固定随机值 0.2 时，进行中每轮停顿 1.2 秒；过长停顿会让小头像看起来静止。
        await page.clock.runFor(1400);
        assert.equal(await face.getAttribute("data-motion"), "idle");
        await page.clock.runFor(100);
        assert.equal(await face.getAttribute("data-motion"), "blink");
        await page.clock.runFor(450);
        assert.equal(await face.evaluate((n) => n.style.getPropertyValue("--wf-face-x")), "0px");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.waitForFunction(() => document.querySelector("svg")?.dataset.motion === "idle");
        assert.equal(await face.getAttribute("data-motion"), "idle");
        assert.equal(
          await face.locator(".wf-face-lids").evaluate((n) => getComputedStyle(n).animationName),
          "none",
        );
      }
    assert.deepEqual(errors, []);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator('[data-status="done"]').click();
    await page.clock.runFor(2300);
    assert.equal(await face.getAttribute("data-expression"), "pill");
    assert.equal(await face.getAttribute("data-motion"), "blink");
    assert.equal(await face.evaluate((n) => n.style.getPropertyValue("--wf-face-blinks")), "1");
    await page.clock.runFor(1000);
    assert.equal(await face.getAttribute("data-expression"), "happy");
    assert.equal(await face.evaluate((n) => n.style.getPropertyValue("--wf-face-x")), "0px");
    await page.locator('[data-status="failed"]').click();
    await page.clock.runFor(1600);
    assert.equal(await face.getAttribute("data-motion"), "float");
    await page.clock.runFor(750);
    assert.equal(await face.getAttribute("data-expression"), "focused");
    assert.equal(await face.getAttribute("data-motion"), "shake");
    const shaking = await face.locator(".wf-face-bounce").evaluate((node) => {
      const animation = node.getAnimations()[0];
      animation.pause();
      animation.currentTime = 22.5;
      return getComputedStyle(node).transform;
    });
    assert.match(shaking, /-0\.9/);
    assert.equal(
      await face.locator(".wf-face-body").evaluate((n) => getComputedStyle(n).transform),
      "none",
    );
    await page.clock.runFor(1000);
    assert.equal(await face.getAttribute("data-expression"), "sad");
    await page.locator('[data-status="pending"]').click();
    await page.clock.runFor(1600);
    assert.equal(await face.getAttribute("data-motion"), "dots-wave");
    assert.deepEqual(
      await face
        .locator('[data-eye-expression="dots"] circle')
        .evaluateAll((nodes) => nodes.map((n) => n.getBBox().width)),
      [3, 3, 3],
    );
    const dots = await face.locator('[data-eye-expression="dots"] circle').evaluateAll((nodes) =>
      nodes.map((node) => {
        const animation = node.getAnimations()[0];
        animation.pause();
        const delay = Number(animation.effect.getTiming().delay);
        animation.currentTime = delay + 250;
        return { delay, transform: getComputedStyle(node).transform };
      }),
    );
    assert.deepEqual(
      dots.map((d) => d.delay),
      [0, 200, 400],
    );
    assert.ok(dots.every((d) => d.transform.includes("-1.5")));
    assert.equal(
      await face.locator(".wf-face-body").evaluate((n) => getComputedStyle(n).transform),
      "none",
    );
    await page.clock.runFor(900);
    assert.equal(await face.getAttribute("data-motion"), "idle");
    assert.equal(await face.getAttribute("data-expression"), "dots");
    await page.screenshot({ path: join(output, "preview.png") });
    console.log(`Preview: ${join(output, "preview.html")}`);
  } finally {
    await browser.close();
  }
});
