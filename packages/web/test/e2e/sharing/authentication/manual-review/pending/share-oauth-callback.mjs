// SHARE-OAUTH01：完整 Web 入口的分享登录回调，第三方 OAuth/API 使用受控响应。
// 启动：pnpm --filter @zcode/web exec vite --host 127.0.0.1 --port 5178 --strictPort
// 运行：node packages/web/test/e2e/sharing/authentication/manual-review/pending/share-oauth-callback.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import {
  setup,
  assertEventually,
} from "../../../../remote-control/authentication/manual-review/pending/remote-login-v2.helpers.mjs";

const origin = process.env.SHARE_OAUTH_E2E_ORIGIN || "http://127.0.0.1:5178";
const artifacts = resolve(".tmp/share-oauth-callback-e2e");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];

try {
  for (const prefix of ["/share", "/cn/share"])
    for (const width of [390, 1024])
      for (const theme of ["zai-light", "zai-dark"])
        for (const provider of ["bigmodel", "zai"]) {
          const locale = prefix === "/cn/share" ? "zh-CN" : "en-US";
          const h = await setup(browser, { width, theme, locale, provider });
          const sharePath = `${prefix}/E2E_SHARE_OAUTH01`;
          const name = `${prefix.replaceAll("/", "-")}-${width}-${theme}-${provider}`;
          const previewCredentials = [];
          try {
            await h.page.route("**/api/v1/shares/*/preview", async (route) => {
              const headers = {
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Headers": "authorization",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
              };
              if (route.request().method() === "OPTIONS") {
                await route.fulfill({ status: 204, headers });
                return;
              }
              previewCredentials.push(route.request().headers().authorization ?? null);
              // 同一 404 在登录前显示登录页，登录后显示通用不可访问状态。
              await route.fulfill({ status: 404, headers, json: { code: 3211, msg: "not_found" } });
            });
            await h.page.goto(`${origin}${sharePath}`);
            await h.page.locator(`[data-share-login-provider="${provider}"]`).click();
            await assertEventually(() => !!h.traffic.authorize);
            const state = h.traffic.authorize.searchParams.get("state");
            const redirectUri = h.traffic.authorize.searchParams.get(
              provider === "bigmodel" ? "redirect" : "redirect_uri",
            );
            assert.ok(state);
            assert.ok(redirectUri);
            assert.equal(
              JSON.parse(Buffer.from(state, "base64url").toString()).app_return_to,
              `${origin}${sharePath}`,
            );
            // 覆盖分享回调的两个语言路径；token 请求仍使用授权时保存的 redirect_uri。
            const callback = new URL(`${prefix}/callback`, origin);
            callback.searchParams.set("state", state);
            callback.searchParams.set(provider === "bigmodel" ? "authCode" : "code", "e2e-code");
            await h.page.goto(callback.toString());
            await h.page.waitForURL(`${origin}${sharePath}`, { timeout: 15_000 });
            await h.page
              .getByRole("heading", {
                name: locale === "zh-CN" ? "找不到分享内容" : "Share not found",
                exact: true,
              })
              .waitFor();
            assert.deepEqual(h.traffic.exchange, {
              provider,
              code: "e2e-code",
              state,
              redirect_uri: redirectUri,
            });
            assert.deepEqual(previewCredentials, [null, "Bearer e2e-jwt"]);
            assert.deepEqual(
              await h.page.evaluate(
                (selectedProvider) => ({
                  provider: localStorage.getItem("oauth:active_provider"),
                  token: localStorage.getItem(`oauth:${selectedProvider}:access_token`),
                  pendingLogins: localStorage.getItem("oauth_pending_logins"),
                }),
                provider,
              ),
              {
                provider,
                token: "e2e-access",
                pendingLogins: null,
              },
            );
            assert.deepEqual(h.errors, []);
            await h.page.screenshot({ path: resolve(artifacts, `${name}.png`), fullPage: true });
            results.push({ name, result: "passed" });
            console.log(`PASS SHARE-OAUTH01 ${name}`);
          } catch (error) {
            await h.page.screenshot({
              path: resolve(artifacts, `${name}-failed.png`),
              fullPage: true,
            });
            results.push({ name, result: "failed", error: String(error), pageErrors: h.errors });
            throw error;
          } finally {
            await h.context.close();
          }
        }
} finally {
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
}
