import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

// 真实会话 renderer：验证单卡片、分区复制、状态更新和窄屏布局。
test("session tools summary and details", { timeout: 240000 }, async () => {
  const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
  const entry = "/packages/ui/test/browser/manual-review/pending/session-details.fixture.tsx";
  const artifacts = join(root, "packages/desktop/.e2e-artifacts/session-details");
  await mkdir(artifacts, { recursive: true });
  const server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "session-details",
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
    resolve: { alias: { "@": join(root, "packages/ui/src") } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch(
      process.env.CHROME_EXECUTABLE_PATH
        ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
        : { channel: "chrome" },
    );
    // 使用生产序列化器生成超限结果，避免手写 envelope 掩盖协议变化。
    const { serializeOutput } = await server.ssrLoadModule(
      "/apps/zcode-cli/packages/core/src/tool/executor/result-serialization.ts",
    );
    const budgetCases = [];
    const largeText = "Large message\n".repeat(4000);
    const session = { kind: "app", sessionId: "example-session" };
    for (const name of ["ListSessions", "ReadSession", "SendToSession", "WaitSessions"]) {
      for (const persisted of [true, false]) {
        const result = await serializeOutput(
          {
            sessionId: "example",
            artifactStore: {
              writeToolResultArtifact: async () => {
                if (!persisted) throw new Error("Disk unavailable");
                return { path: "/tmp/session-output.json", uri: "file:///tmp/session-output.json" };
              },
            },
          },
          name === "ListSessions"
            ? { sessions: [{ session, title: largeText, status: "idle" }] }
            : name === "WaitSessions"
              ? {
                  status: "timed_out",
                  operations: [{ operation: { session }, status: "running", reason: largeText }],
                }
              : name === "SendToSession"
                ? { session, admission: "rejected", reason: largeText }
                : { view: "messages", session, messages: [{ role: "assistant", text: largeText }] },
          {
            metadata: { name },
            resultBudget: {
              maxInlineBytes: 32768,
              maxModelBytes: 32768,
              strategy: "artifact",
              preview: { direction: "head" },
              artifact: { enabled: true, retention: "session" },
            },
          },
          {},
          "example-call",
          new AbortController().signal,
        );
        assert.ok(result.originalBytes > 32768);
        assert.match(result.content, persisted ? /<persisted-output>/ : /Tool output truncated/);
        budgetCases.push({ id: `${name}-${persisted}`, name, output: result.content });
      }
    }
    const page = await browser.newPage();
    await page.addInitScript((cases) => {
      window.__sessionBudgetCases = cases;
    }, budgetCases);
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(String(error));
      process.stderr.write(`${error}\n`);
    });
    await page.addInitScript(() => {
      window.__copied = [];
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text) => {
            if (window.__copyFail) throw new Error("Clipboard denied");
            window.__copied.push(text);
          },
        },
      });
    });
    for (const width of [390, 1200])
      for (const theme of ["light", "dark"])
        for (const locale of ["zh-CN", "en-US"]) {
          await page.setViewportSize({ width, height: 950 });
          await page.goto(`${server.resolvedUrls.local[0]}fixture?theme=${theme}&locale=${locale}`);
          for (const id of [
            "list",
            "read",
            "summary",
            "send",
            "rejected",
            "wait",
            "running",
            "failed",
            "stopped",
            "denied",
            "unknown",
            "legacy",
            "budget-live",
            "budget-legacy",
            ...budgetCases.map((row) => row.id),
          ]) {
            const row = page.locator(`[data-case="${id}"]`);
            await row.locator("svg.lucide-book-open-text").waitFor();
            await row.locator("[aria-expanded]").click();
            await row.locator("[data-session-details]").waitFor();
          }
          assert.equal(
            await page.locator('[data-case="other"] svg.lucide-book-open-text').count(),
            0,
          );
          const en = locale === "en-US";
          assert.match(await page.locator('[data-case="list"]').innerText(), /Project analysis/);
          assert.match(
            await page.locator('[data-case="list"]').innerText(),
            en ? /Search coverage is incomplete/ : /搜索范围不完整/,
          );
          assert.match(
            await page.locator('[data-case="list"]').innerText(),
            en ? /More results available/ : /还有更多结果/,
          );
          assert.match(
            await page.locator('[data-case="send"]').innerText(),
            en ? /Queued/ : /已排队/,
          );
          assert.match(
            await page.locator('[data-case="rejected"]').innerText(),
            /Permission denied/,
          );
          assert.match(
            await page.locator('[data-case="wait"]').innerText(),
            en ? /Wait timed out/ : /等待超时/,
          );
          assert.match(await page.locator('[data-case="wait"]').innerText(), /Choose a target/);
          for (const id of ["failed", "stopped", "denied"])
            assert.ok(
              !(await page.locator(`[data-case="${id}"]`).innerText()).includes(
                en ? "Queued" : "已排队",
              ),
            );
          assert.match(
            await page.locator('[data-case="unknown"]').innerText(),
            en ? /Outcome unknown/ : /结果未知/,
          );
          assert.match(await page.locator('[data-case="legacy"]').innerText(), /\{broken JSON/);
          for (const row of budgetCases) {
            const item = page.locator(`[data-case="${row.id}"]`);
            const visible = await item.innerText();
            assert.ok(visible.includes(row.output), `${row.id}: original result preserved`);
            assert.ok(!visible.includes(en ? "No result available" : "暂无可展示结果"));
            assert.ok(!visible.includes(en ? "Pending" : "等待中"));
            await item
              .getByRole("button", { name: en ? "Copy Result" : "复制 结果", exact: true })
              .click();
            assert.equal(await page.evaluate(() => window.__copied.at(-1)), row.output);
          }
          const send = page.locator('[data-case="send"]');
          await send
            .getByRole("button", { name: en ? "Copy Message" : "复制 消息", exact: true })
            .click();
          assert.equal(await page.evaluate(() => window.__copied.at(-1)), "Please inspect reuse");
          const scroll = page.locator('[data-case="read"] [data-fallback-scroll]').nth(1);
          assert.ok(
            await scroll.evaluate(
              (el) => el.scrollHeight > el.clientHeight && el.clientHeight <= 240,
            ),
          );
          await page.getByTestId("complete").click();
          await page
            .locator('[data-case="running"] [data-session-details]')
            .getByText("Project analysis", { exact: true })
            .waitFor();
          const live = page.locator('[data-case="budget-live"] [data-session-details]');
          await live.getByText(budgetCases[0].output, { exact: true }).waitFor();
          assert.ok(
            (await page.locator('[data-case="budget-legacy"]').innerText()).includes(
              budgetCases[0].output,
            ),
          );
          await send.locator("[aria-expanded]").click();
          await send.locator("[data-session-details]").waitFor({ state: "hidden" });
          await send.locator("[aria-expanded]").click();
          await send.locator("[data-session-details]").waitFor();
          const text = await page.locator("main").innerText();
          for (const hidden of [
            "/private/internal-path",
            "internal-source",
            "private-command",
            "private-cursor",
          ])
            assert.ok(!text.includes(hidden));
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.locator('[data-case="list"]').scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
          await page.goto(
            `${server.resolvedUrls.local[0]}fixture?theme=${theme}&locale=${locale}&restored=1`,
          );
          const restored = page.locator('[data-case="budget-live"]');
          await restored.locator("[aria-expanded]").click();
          await restored.locator("[data-session-details]").waitFor();
          assert.ok((await restored.innerText()).includes(budgetCases[0].output));
          await restored.screenshot({
            path: join(artifacts, `large-result-${width}-${theme}-${locale}.png`),
          });
        }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
