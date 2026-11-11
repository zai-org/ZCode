// SPR07–09：生产 React + 真实组件；数据/平台在服务边界隔离，不改产品引用。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build, preview, loadConfigFromFile } from "vite";
import { chromium } from "playwright-core";
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const artifacts =
  process.env.ZCODE_RETENTION_ARTIFACT_DIR ??
  root + "packages/desktop/.e2e-artifacts/renderer-retention-20261105/browser";
let server, browser;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    artifacts + "/index.html",
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/retention-fixture.tsx"></script></body></html>',
  );
  const { config } = await loadConfigFromFile(
    { command: "build", mode: "production" },
    root + "packages/desktop/vite.config.ts",
  );
  const baseline = new Map();
  if (process.env.ZCODE_RETENTION_BASELINE_REF) {
    for (const path of [
      "packages/ui/src/v4/ConversationComposer.tsx",
      "packages/ui/src/LexicalChatInput.tsx",
      "packages/ui/src/hooks/useWebRemoteControlStatus.ts",
    ]) {
      const { stdout } = await promisify(execFile)(
        "git",
        ["show", process.env.ZCODE_RETENTION_BASELINE_REF + ":" + path],
        { cwd: root, maxBuffer: 2000000 },
      );
      baseline.set(root + path, stdout);
    }
  }
  if (process.env.ZCODE_RETENTION_REUSE_BUILD !== "1")
    await build({
      ...config,
      configFile: false,
      root: artifacts,
      base: "./",
      logLevel: "warn",
      plugins: [
        {
          name: "retention-boundaries",
          enforce: "pre",
          load: (id) => {
            // 付费导航不在引用生命周期场景内；保留真实 Composer、工具栏、Lexical 和状态 hook。
            if (id.endsWith("/settings/CodingPlanUpgradeDialogProvider.tsx"))
              return "export const useCodingPlanUpgradeDialog=()=>({openCodingPlanUpgrade:()=>false}); export const useOptionalCodingPlanUpgradeDialog=()=>null;";
            return baseline.get(id);
          },
        },
        ...config.plugins,
      ],
      resolve: {
        ...config.resolve,
        alias: {
          ...config.resolve.alias,
          "/retention-fixture.tsx":
            root + "packages/ui/test/browser/manual-review/pending/renderer-retention.fixture.tsx",
        },
      },
      build: {
        ...config.build,
        outDir: artifacts + "/out",
        rollupOptions: { input: artifacts + "/index.html" },
      },
    });
  server = await preview({
    configFile: false,
    root: artifacts,
    build: { outDir: artifacts + "/out" },
    preview: { host: "127.0.0.1", port: 0 },
  });
  browser = await chromium.launch({ channel: "chrome" });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function pendingUpdates(page) {
  return page.evaluate(() => {
    const element = document.querySelector('[data-testid="status-owner"]');
    let fiber = element[Object.keys(element).find((key) => key.startsWith("__reactFiber"))];
    for (; fiber; fiber = fiber.return) {
      for (const candidate of [fiber, fiber.alternate]) {
        let hook = candidate?.memoizedState;
        while (hook) {
          if (hook.queue && hook.memoizedState?.status) {
            let count = 0,
              start = hook.queue.pending,
              update = start;
            if (update)
              do {
                count++;
                update = update.next;
              } while (update && update !== start && count < 10000);
            return count;
          }
          hook = hook.next;
        }
      }
    }
    throw new Error("Status hook queue not found");
  });
}
for (const mobile of [false, true]) {
  const name = mobile ? "mobile" : "desktop";
  test("SPR07 historical projection release / " + name, async () => {
    const page = await browser.newPage({
      viewport: { width: mobile ? 390 : 1280, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(error.stack);
    });
    try {
      await page.goto(
        server.resolvedUrls.local[0] +
          "?mobile=" +
          Number(mobile) +
          (mobile ? "&theme=dark&locale=zh-CN" : "&theme=light&locale=en-US"),
      );
      await page.getByTestId("v4-composer-input").waitFor({ timeout: 20000 });
      for (let i = 0; i < 6; i++) {
        await page.evaluate(
          (i) =>
            i === 2 ? window.retentionFixture.switchScope() : window.retentionFixture.advance(),
          i,
        );
        await page.waitForTimeout(80);
      }
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("HeapProfiler.collectGarbage");
      await cdp.send("HeapProfiler.collectGarbage");
      const live = await page.evaluate(() => window.retentionFixture.liveSnapshots());
      await writeFile(
        artifacts + "/" + name + "-snapshot.json",
        JSON.stringify({ live, errors }, null, 2),
      );
      assert.deepEqual(errors, []);
      assert(!live.includes(0), "First historical snapshot retained: " + live);
      assert(
        live.every((index) => index >= 5),
        "Superseded histories retained: " + live,
      );
      assert(live.includes(6), "Current projection must remain available");
      for (const count of [1, 2, 0]) {
        await page.evaluate((count) => window.retentionFixture.indicators(count), count);
        for (const kind of ["hook", "mcp"]) {
          const indicator = page.getByTestId("v4-workspace-" + kind + "-pending-trigger");
          await indicator.waitFor({ state: count ? "visible" : "hidden" });
        }
        const background = page.locator("[data-background-total-count]");
        if (count)
          await page.waitForFunction(
            (count) =>
              document
                .querySelector("[data-background-total-count]")
                ?.getAttribute("data-background-total-count") === String(count),
            count,
          );
        else assert.equal(await background.count(), 0);
      }
      const input = page.getByTestId("v4-composer-input");
      await input.fill("send regression");
      await page.getByTestId("v4-composer-send").click();
      await page.waitForFunction(() => window.retentionFixture.sent.length === 1);
      assert.equal(await input.textContent(), "send regression", "Blocked send preserves draft");
      if (!mobile) {
        await page.getByTestId("v4-composer-send").click({ modifiers: ["ControlOrMeta"] });
        await page.waitForFunction(() => window.retentionFixture.sent.length === 2);
        assert.equal(
          await page.evaluate(() => window.retentionFixture.sent[1].delivery),
          "startNow",
        );
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
  test("SPR08 remote status queue and lifecycle / " + name, async () => {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 900 } });
    const evidence = {};
    try {
      await page.goto(server.resolvedUrls.local[0] + "?kind=status");
      await page.getByTestId("status").waitFor();
      await page.waitForTimeout(150);
      evidence.before = await pendingUpdates(page);
      await page.evaluate(() =>
        window.retentionFixture.platforms[0].emit({ status: "idle" }, 1000),
      );
      await page.waitForTimeout(100);
      evidence.after = await pendingUpdates(page);
      await page.evaluate(() => {
        const p = window.retentionFixture.platforms[0];
        p.emit({ status: "idle", mobileConnected: true });
        p.emit({ status: "idle", mobileConnected: false });
        p.emit({ status: "idle", mobileConnected: true });
      });
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="status"]')
          .textContent.includes('"mobileConnected":true'),
      );
      await page.evaluate(() => window.retentionFixture.platforms[0].defer());
      await page.waitForTimeout(100);
      await page.getByRole("button", { name: "Enable", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="status"]').textContent === '{"status":"idle"}',
      );
      await page.evaluate(() => window.retentionFixture.platforms[0].resolve());
      assert.equal(await page.getByTestId("status").textContent(), '{"status":"idle"}');
      await page.evaluate(() => window.retentionFixture.replacePlatform());
      await page.getByRole("button", { name: "Enable", exact: true }).click();
      await page.evaluate(() =>
        window.retentionFixture.platforms[1].emit({ status: "idle", mobileConnected: true }),
      );
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="status"]')
          .textContent.includes('"mobileConnected":true'),
      );
      await page.evaluate(() => {
        window.retentionFixture.platforms[0].resolve();
        window.retentionFixture.unmount();
      });
      evidence.platforms = await page.evaluate(() =>
        window.retentionFixture.platforms.map((p) => p.stats()),
      );
      assert(evidence.platforms.every((p) => p.listeners === 0));
      assert(evidence.platforms[0].polls >= 2, "Real polling exercised");
      assert(evidence.after <= 1, "Identical status updates retained: " + evidence.after);
    } finally {
      await writeFile(artifacts + "/" + name + "-status.json", JSON.stringify(evidence, null, 2));
      await page.close();
    }
  });
  test("SPR09 scope undo isolation / " + name, async () => {
    const page = await browser.newPage({
      viewport: { width: mobile ? 390 : 1280, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    try {
      await page.goto(
        server.resolvedUrls.local[0] +
          "?mobile=" +
          Number(mobile) +
          (mobile ? "&theme=dark&locale=zh-CN" : "&theme=light&locale=en-US"),
      );
      const input = page.getByTestId("v4-composer-input");
      await input.waitFor();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="v4-composer-input"]')
          .textContent.includes("restored"),
      );
      await input.press("End");
      await input.pressSequentially(" edited");
      await input.press("ControlOrMeta+z");
      assert(!(await input.textContent()).includes("edited"));
      await input.press("ControlOrMeta+Shift+z");
      assert((await input.textContent()).includes("edited"));
      await input.evaluate((element) => {
        element.dataset.identity = "original";
      });
      await page.evaluate(() => {
        window.retentionEditorStates = [];
      });
      for (let i = 0; i < 8; i++) {
        await input.evaluate((element) => {
          window.retentionEditorStates.push(new WeakRef(element.__lexicalEditor.getEditorState()));
        });
        await page.evaluate(() => window.retentionFixture.switchScope());
        const expected = "restored-sess_probe_retention_" + (i % 2 === 0 ? "1" : "0");
        await page.waitForFunction(
          (expected) =>
            document.querySelector('[data-testid="v4-composer-input"]').textContent === expected,
          expected,
        );
        await input.press("ControlOrMeta+z");
        assert.equal(await input.textContent(), expected, "Undo must not restore another scope");
      }
      assert.equal(await input.getAttribute("data-identity"), "original");
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("HeapProfiler.collectGarbage");
      await cdp.send("HeapProfiler.collectGarbage");
      const retainedStates = await page.evaluate(
        () => window.retentionEditorStates.filter((ref) => ref.deref()).length,
      );
      await writeFile(artifacts + "/" + name + "-undo.json", JSON.stringify({ retainedStates }));
      assert.equal(retainedStates, 0, "Previous scope editor states released");
      await input.press("End");
      await input.pressSequentially(" promotion");
      await page.evaluate(() => window.retentionFixture.promote());
      await page.waitForTimeout(100);
      assert((await input.textContent()).endsWith(" promotion"));
      await input.press("ControlOrMeta+z");
      // 晋升回填可保留一层相同正文；原 scope 的编辑前状态仍须能撤销到达。
      if ((await input.textContent()).endsWith(" promotion")) await input.press("ControlOrMeta+z");
      assert.equal(
        await input.textContent(),
        "restored-sess_probe_retention_0",
        "Promotion keeps same-scope undo",
      );
      await page.screenshot({ path: artifacts + "/" + name + "-undo.png" });
    } finally {
      await page.close();
    }
  });
}
