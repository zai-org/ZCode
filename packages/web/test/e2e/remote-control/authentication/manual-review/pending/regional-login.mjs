// 独立浏览器验收；所有账号、OAuth和业务接口均为本地合成响应，不访问真实授权。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { setup, assertEventually } from "./remote-login-v2.helpers.mjs";

const origin = process.env.REMOTE_LOGIN_E2E_ORIGIN || "http://127.0.0.1:5178";
const artifacts = resolve(".tmp/regional-login-e2e");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
async function fixture(options = {}) {
  const h = await setup(browser, options);
  const flows = [];
  await h.context.route("**/api/v1/oauth/cli/init", async (route) => {
    const provider = route.request().postDataJSON().provider;
    const flow = {
      provider,
      token: route.request().headers().authorization,
      ready: false,
      id: String(flows.length),
    };
    assert.match(flow.token, /^Bearer [a-f0-9]{64}$/);
    flows.push(flow);
    await route.fulfill({
      json: {
        code: 0,
        data: {
          flow_id: flow.id,
          authorize_url: `https://auth.example.com/authorize?state=${flow.id}&redirect_uri=https%3A%2F%2Fauth.example.com%2Fserver-callback`,
          expires_at: Date.now() / 1000 + 60,
          poll_interval_sec: 1,
        },
      },
    });
  });
  await h.context.route("https://auth.example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Local synthetic authorization</p>" }),
  );
  await h.context.route("**/api/v1/oauth/cli/poll/*", async (route) => {
    const flow = flows.find((item) => route.request().url().endsWith(`/${item.id}`));
    assert.ok(flow);
    assert.equal(route.request().headers().authorization, flow.token);
    await route.fulfill({
      json: {
        code: 0,
        data: flow.ready
          ? {
              status: "ready",
              token: "e2e-jwt",
              user: {
                user_id: "e2e-user",
                name: "E2E",
                id: "wrong-upstream",
                username: "Wrong",
                displayName: "Wrong",
              },
              zai: { access_token: "current-global-business" },
              bigmodel: { access_token: "must-not-persist-linked", customer_id: "linked-customer" },
            }
          : { status: "pending" },
      },
    });
  });
  await h.context.route("**/api/v1/shares/*/preview", (route) =>
    route.fulfill({ status: 404, json: { code: 3211, msg: "not_found" } }),
  );
  return { ...h, flows };
}
try {
  for (const surface of process.env.REGIONAL_BOUNDARIES_ONLY ? [] : ["remote", "share"])
    for (const provider of ["zai_cn", "zai"])
      for (const width of [390, 1024])
        for (const theme of ["zai-light", "zai-dark"]) {
          const locale = provider === "zai_cn" ? "zh-CN" : "en-US";
          const h = await fixture({ width, theme, locale });
          const path =
            surface === "remote"
              ? "/remote/v4?app_version=3.16.3"
              : `${provider === "zai_cn" ? "/cn" : ""}/share/E2E_REGIONAL`;
          const name = `${surface}-${provider}-${width}-${theme}`;
          try {
            await h.page.goto(`${origin}${path}`);
            const action = h.page.getByTestId("regional-login-submit");
            await action.waitFor({ timeout: 5000 });
            assert.equal(await action.count(), 1);
            await h.page.getByTestId(`regional-login-${provider}`).click();
            const popupPromise = h.context.waitForEvent("page");
            await action.click();
            const popup = await popupPromise;
            await popup.waitForURL("https://auth.example.com/**");
            assert.equal(
              new URL(popup.url()).searchParams.get("redirect_uri"),
              "https://auth.example.com/server-callback",
            );
            assert.equal(h.page.url(), `${origin}${path}`);
            assert.equal(h.flows.length, 1);
            assert.equal(h.flows[0].provider, provider);
            h.flows[0].ready = true;
            await h.page
              .getByRole("heading", {
                name:
                  surface === "remote"
                    ? locale === "zh-CN"
                      ? "选择电脑"
                      : "Choose a computer"
                    : locale === "zh-CN"
                      ? "找不到分享内容"
                      : "Share not found",
                exact: true,
              })
              .waitFor();
            const session = await h.page.evaluate(() =>
              JSON.parse(localStorage.getItem("oauth:browser_session")),
            );
            assert.equal(session.provider, provider);
            assert.equal(session.userInfo.id, "e2e-user");
            assert.equal(session.zcodeJwtToken, "e2e-jwt");
            assert.equal(
              session.businessAccessToken,
              provider === "zai" ? "current-global-business" : undefined,
            );
            assert.equal(
              await h.page.evaluate(() =>
                JSON.stringify(localStorage).includes("must-not-persist"),
              ),
              false,
            );
            assert.deepEqual(h.errors, []);
            await h.page.screenshot({ path: resolve(artifacts, `${name}.png`), fullPage: true });
            results.push({ name, result: "passed" });
          } finally {
            await h.context.close();
          }
        }

  // 在真实页面与同源标签中覆盖提交边界；只使用合成身份。
  for (const scenario of process.env.REGIONAL_SCENARIO
    ? [process.env.REGIONAL_SCENARIO]
    : [
        "cancel",
        "foreign-subject",
        "superseded",
        "legacy-callback",
        "no-locks-logout",
        "same-jwt-revision",
      ]) {
    const h = await fixture();
    try {
      await h.page.goto(`${origin}/remote/v4`);
      await h.page.getByTestId("regional-login-submit").waitFor();
      if (scenario === "same-jwt-revision") {
        let releaseOld;
        let requestCount = 0;
        let oldSettled = false;
        const held = new Promise((resolve) => {
          releaseOld = resolve;
        });
        await h.context.route("**/api/v1/remote/device", async (route) => {
          requestCount++;
          const current = requestCount;
          if (current === 1) await held;
          await route
            .fulfill({
              json: {
                code: 0,
                msg: "",
                data: [
                  {
                    device_sid: current === 1 ? "old-device" : "new-device",
                    device_mid: "new-mid",
                    online: true,
                    created_at: 1,
                    meta: { name: current === 1 ? "OLD RESULT" : "NEW RESULT" },
                  },
                ],
              },
            })
            .catch(() => {});
          if (current === 1) oldSettled = true;
        });
        const other = await h.context.newPage();
        await other.goto(`${origin}/share/E2E_REGIONAL`);
        await other.evaluate(() =>
          localStorage.setItem(
            "oauth:browser_session",
            JSON.stringify({
              version: 1,
              provider: "zai_cn",
              userInfo: { id: "same-user", username: "Old", displayName: "Old" },
              zcodeJwtToken: "e2e-jwt",
              revision: "before",
            }),
          ),
        );
        await assertEventually(() => requestCount === 1);
        await other.evaluate(() =>
          localStorage.setItem(
            "oauth:browser_session",
            JSON.stringify({
              version: 1,
              provider: "zai_cn",
              userInfo: { id: "same-user", username: "New", displayName: "New" },
              zcodeJwtToken: "e2e-jwt",
              revision: "after",
            }),
          ),
        );
        await h.page.getByText("NEW RESULT", { exact: true }).waitFor();
        releaseOld();
        await assertEventually(() => oldSettled);
        await h.page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        assert.ok(requestCount >= 2);
        assert.equal(await h.page.getByText("OLD RESULT", { exact: true }).count(), 0);
      } else if (scenario === "legacy-callback") {
        const result = await h.page.evaluate(async () => {
          const { WebAuthService } = await import("/src/auth/webAuthService.ts");
          const { BrowserOAuthCredentialRepo } =
            await import("/src/auth/browserOAuthCredentialRepo.ts");
          const repo = new BrowserOAuthCredentialRepo();
          let authorization;
          const auth = new WebAuthService({
            repo,
            runtime: {
              createNonce: () => "legacy-attempt",
              getCurrentHref: () => location.href,
              getCurrentOrigin: () => location.origin,
              assign: (url) => {
                authorization = url;
              },
              replace: () => {},
            },
          });
          await auth.startLogin({ provider: "bigmodel" });
          const state = new URL(authorization).searchParams.get("state");
          const expected = await repo.beginLoginAttempt("new-attempt");
          await repo.commitPrimarySession(
            {
              provider: "zai_cn",
              userInfo: { id: "new-user", username: "New", displayName: "New" },
              zcodeJwtToken: "e2e-jwt",
              revision: "new-attempt",
            },
            expected,
            "new-attempt",
          );
          let rejected = false;
          try {
            await auth.handleCallback(
              `${location.origin}/remote/v4?authCode=old&state=${encodeURIComponent(state)}`,
            );
          } catch {
            rejected = true;
          }
          return { rejected, id: repo.loadCachedSession()?.id };
        });
        assert.deepEqual(result, { rejected: true, id: "new-user" });
      } else if (scenario === "no-locks-logout") {
        const result = await h.page.evaluate(async () => {
          const { BrowserOAuthCredentialRepo } =
            await import("/src/auth/browserOAuthCredentialRepo.ts");
          localStorage.setItem("oauth:active_provider", "zai");
          localStorage.setItem("zcodejwttoken", "old-jwt");
          localStorage.setItem("oauth:zai:access_token", "old-access");
          localStorage.setItem(
            "oauth:zai:user_info",
            JSON.stringify({ user_id: "old-user", name: "Old" }),
          );
          Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
          Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
          const repo = new BrowserOAuthCredentialRepo();
          const before = repo.loadCachedSession()?.id;
          await repo.clearSession();
          await repo.finishLoginAttempt("missing");
          return { before, after: repo.loadCachedSession() };
        });
        assert.deepEqual(result, { before: "old-user", after: null });
      } else {
        if (scenario === "foreign-subject")
          await h.context.route("**/api/v1/oauth/cli/poll/*", (route) =>
            route.fulfill({
              json: {
                code: 0,
                data: h.flows[0]?.ready
                  ? {
                      status: "ready",
                      token: "e2e-jwt",
                      user: { id: "upstream", username: "Bad", displayName: "Bad" },
                    }
                  : { status: "pending" },
              },
            }),
          );
        const popupPromise = h.context.waitForEvent("page");
        await h.page.getByTestId("regional-login-submit").click();
        const popup = await popupPromise;
        await popup.waitForURL("https://auth.example.com/**");
        if (scenario === "cancel") {
          await h.page.getByTestId("regional-login-cancel").click();
          h.flows[0].ready = true;
          await h.page.waitForFunction(
            () => localStorage.getItem("oauth:browser_login_attempt") === null,
          );
          assert.equal(
            await h.page.evaluate(() => localStorage.getItem("oauth:browser_session")),
            null,
          );
        } else if (scenario === "superseded") {
          const other = await h.context.newPage();
          await other.goto(`${origin}/remote/v4`);
          await other.evaluate(() => {
            localStorage.setItem(
              "oauth:browser_session",
              JSON.stringify({
                version: 1,
                provider: "zai_cn",
                userInfo: { id: "new-user", username: "New", displayName: "New" },
                zcodeJwtToken: "e2e-jwt",
                revision: "newer",
              }),
            );
          });
          h.flows[0].ready = true;
          await h.page.getByTestId("regional-login-submit").waitFor({ state: "visible" });
          await h.page.waitForFunction(
            () => localStorage.getItem("oauth:browser_login_attempt") === null,
          );
          assert.equal(
            await h.page.evaluate(
              () => JSON.parse(localStorage.getItem("oauth:browser_session")).revision,
            ),
            "newer",
          );
        } else {
          h.flows[0].ready = true;
          await h.page.getByRole("alert").waitFor();
          assert.equal(
            await h.page.evaluate(() => localStorage.getItem("oauth:browser_session")),
            null,
          );
        }
      }
      results.push({ name: scenario, result: "passed" });
    } catch (error) {
      await h.page.screenshot({ path: resolve(artifacts, `${scenario}-failed.png`) });
      await writeFile(
        resolve(artifacts, `${scenario}-failed.txt`),
        await h.page.locator("body").innerText(),
      );
      throw error;
    } finally {
      await h.context.close();
    }
  }
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
