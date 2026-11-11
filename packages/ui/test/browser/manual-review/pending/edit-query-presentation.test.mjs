// D20：真实编辑入口、projection store、协议 reducer 和 Timeline；只控制传输帧的释放顺序。
// 编辑在 composer 编辑态进行：原行「正在下方编辑」占位与 composer 提交态共同代表编辑器。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/edit-query-presentation.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/edit-query-presentation");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "edit-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        "@": `${root}packages/ui/src`,
        "@zcode/zcode-cua/broker/ports": `${root}packages/zcode-cua/src/broker/ports.ts`,
      },
    },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/.e2e-artifacts/**"] },
    },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: "chrome" });
});
after(async () => {
  await browser?.close();
  await server?.close();
});
async function prepare(options = {}) {
  const page = await browser.newPage({
    viewport: { width: options.mobile ? 390 : 1250, height: 800 },
    isMobile: options.mobile,
    hasTouch: options.mobile,
  });
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(String(error)));
  await page.goto(
    `${origin}fixture?${new URLSearchParams({ count: "8", theme: "light", mobile: "false", ...options })}`,
  );
  await page.getByTestId("v4-timeline").waitFor();
  await page
    .locator('[data-testid^="v4-edit-"]:not([data-testid^="v4-edit-in-composer-hint"])')
    .last()
    .click();
  await page.getByTestId("fixture-edit-submit").waitFor();
  await frames(page);
  await page.evaluate(() => {
    window.samples = [];
    window.stopSamples = false;
    const sample = () => {
      if (window.stopSamples) return;
      const e = document.querySelector('[data-testid="v4-timeline"]');
      window.samples.push({
        at: performance.now(),
        height: e.scrollHeight,
        top: e.scrollTop,
        editor:
          !!document.querySelector('[data-testid^="v4-edit-in-composer-hint-"]') &&
          !!document.querySelector('[data-testid="fixture-edit-submit"]'),
        rows: [...document.querySelectorAll('[data-testid^="v4-row-"]')].map(
          (n) => n.dataset.testid,
        ),
      });
      requestAnimationFrame(sample);
    };
    sample();
  });
  await page.getByTestId("fixture-edit-submit").click();
  await page.waitForFunction(() => window.editProbe.submitted);
  return page;
}
async function frames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let remaining = 4;
        const next = () => (--remaining ? requestAnimationFrame(next) : resolve());
        requestAnimationFrame(next);
      }),
  );
}
async function state(page) {
  return page.evaluate(() => ({ ...window.editProbe.state(), frame: window.samples.at(-1) }));
}
async function finish(page, name) {
  await writeFile(
    join(artifacts, `${name}.json`),
    JSON.stringify(
      await page.evaluate(() => {
        window.stopSamples = true;
        return window.samples;
      }),
      null,
      2,
    ),
  );
  await page.screenshot({ path: join(artifacts, `${name}.png`) });
  const errors = page.errors;
  await page.close();
  assert.deepEqual(errors, []);
}
for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    for (const count of [1, 8])
      for (const ackFirst of [true, false]) {
        const name = `D20-${mobile ? "mobile" : "desktop"}-${theme}-${count}-${ackFirst ? "ack-first" : "row-first"}`;
        test(name, async () => {
          const page = await prepare({ mobile, theme, count });
          try {
            const before = (await state(page)).frame;
            if (ackFirst) await page.evaluate(() => window.editProbe.ack());
            await page.evaluate(() => window.editProbe.cut());
            await frames(page);
            const cut = await state(page);
            assert.equal(cut.rows.length, (count - 1) * 3, "权威 snapshot 必须已截断");
            assert.equal(cut.frame.editor, true, "新输入前编辑器不应消失");
            assert.equal(cut.frame.height, before.height, "删除帧不应收缩列表");
            assert.equal(cut.frame.top, before.top, "删除帧不应改变滚动位置");
            assert.deepEqual(cut.frame.rows, before.rows, "删除帧不应卸载显示的旧轮");
            await page.evaluate(() => window.editProbe.replace());
            if (!ackFirst) await page.evaluate(() => window.editProbe.ack());
            await frames(page);
            const after = await state(page);
            assert.equal(after.pending, false);
            assert.equal(after.frame.editor, false);
            assert.ok(after.frame.rows.includes(`v4-row-${count * 10 + 2}`));
            assert.ok(!after.frame.rows.includes(`v4-row-${(count - 1) * 10 + 2}`));
            const samples = await page.evaluate(() => window.samples);
            assert.ok(
              samples.every(
                (frame) => frame.height >= Math.min(before.height, after.frame.height) - 1,
              ),
              "不应先缩到最终高度以下再撑开",
            );
          } finally {
            await finish(page, name);
          }
        });
      }
for (const outcome of ["reject", "error", "epoch", "queued", "close"])
  test(`D20-release-${outcome}`, async () => {
    const page = await prepare();
    try {
      await page.evaluate(() => window.editProbe.cut());
      await frames(page);
      assert.equal((await state(page)).pending, true);
      await page.evaluate((outcome) => window.editProbe[outcome](), outcome);
      await frames(page);
      assert.equal((await state(page)).pending, false, "终态必须释放旧显示");
    } finally {
      await finish(page, `release-${outcome}`);
    }
  });
test("D20-rejection-keeps-editable-draft", async () => {
  const page = await prepare();
  try {
    await page.evaluate(() => window.editProbe.reject());
    await frames(page);
    assert.equal((await state(page)).pending, false);
    assert.equal(await page.getByTestId("fixture-edit-submit").isEnabled(), true);
  } finally {
    await finish(page, "reject-draft");
  }
});
test("D20-command-and-session-isolation", async () => {
  const page = await prepare();
  try {
    await page.evaluate(() => {
      window.editProbe.cut();
      window.editProbe.replace("unrelated");
    });
    await frames(page);
    assert.equal((await state(page)).pending, true, "其他 commandId 不得结算编辑");
    await page.evaluate(() => window.editProbe.switchSession());
    await frames(page);
    const before = (await state(page)).frame;
    assert.ok(before.rows.every((id) => Number(id.split("-").at(-1)) > 1000));
    await page.evaluate(() => window.editProbe.reject());
    await frames(page);
    assert.deepEqual((await state(page)).frame.rows, before.rows, "旧会话迟到结算不能改新会话");
  } finally {
    await finish(page, "isolation");
  }
});
