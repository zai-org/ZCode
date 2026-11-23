// 独立浏览器验收；所有账号、OAuth和业务接口均为本地合成响应，不访问真实授权。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { setup, assertEventually } from "./remote-login-v2.helpers.mjs";

const origin = process.env.REMOTE_LOGIN_E2E_ORIGIN || "http://127.0.0.1:5178";
// 生产分享页是独立入口 packages/web-share；该入口没有远控页与 /src/auth 模块，只跑分享相关用例。
const webShareEntry = process.env.REGIONAL_ENTRY === "web-share";
const SHARE_PATH = "/cn/share/E2E_REGIONAL";
const artifacts = resolve(".tmp/regional-login-e2e");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
async function fixture({ clockOffsetMs = 0, holdInit, noPopup = false, ...options } = {}) {
  const h = await setup(browser, options);
  // 模拟 App 内置浏览器：window.open 不可用。同页跳转不应依赖它。
  if (noPopup) await h.context.addInitScript(() => (window.open = () => null));
  const openedPages = [];
  h.context.on("page", (page) => openedPages.push(page));
  // 只前移页面 Date.now，模拟手机或电脑时钟快于服务端；服务端 server_time 与 expires_at 不变。
  if (clockOffsetMs)
    await h.context.addInitScript((offset) => {
      const now = Date.now;
      Date.now = () => now() + offset;
    }, clockOffsetMs);
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
    if (holdInit) await holdInit;
    // 服务端时间取 Node 侧真实时钟；clock-skew 只前移页面 Date.now。
    const serverTime = Math.floor(Date.now() / 1000);
    await route.fulfill({
      json: {
        code: 0,
        data: {
          flow_id: flow.id,
          authorize_url: `https://auth.example.com/authorize?state=${flow.id}&redirect_uri=https%3A%2F%2Fauth.example.com%2Fserver-callback`,
          expires_at: serverTime + 60,
          server_time: serverTime,
          poll_interval_sec: 1,
        },
      },
    });
  });
  await h.context.route("https://auth.example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Local synthetic authorization</p>" }),
  );
  // 合成后端：与官网中转页一样由同源 callback 转交授权码，收到后 flow 才 ready。
  const callbacks = [];
  await h.context.route("**/api/v1/oauth/cli/callback/*", async (route) => {
    const url = new URL(route.request().url());
    const flow = flows.find((item) => item.id === url.searchParams.get("state"));
    callbacks.push({
      provider: url.pathname.split("/").pop(),
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
    });
    if (flow && url.searchParams.get("code") === `code-${flow.id}`) flow.ready = true;
    await route.fulfill({ contentType: "text/html", body: "<title>授权成功</title>" });
  });
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
  return { ...h, flows, callbacks, openedPages };
}

/** 当前页跳到合成授权站，返回授权 URL 中的 Web 回调地址。不应打开新页面。 */
async function clickAuthorize(h) {
  await h.page.getByTestId("regional-login-submit").click();
  await h.page.waitForURL("https://auth.example.com/**");
  assert.equal(h.openedPages.length, 0, "区域登录不应打开新页面");
  const authorize = new URL(h.page.url());
  assert.equal(authorize.searchParams.get("state"), h.flows.at(-1).id);
  return new URL(authorize.searchParams.get("redirect_uri"));
}

/** 模拟授权站带 code/state（或 error/state）跳回：回调地址换成本地 origin，在指定页面打开。 */
async function returnFromAuthorize(page, redirect, flow, { code = `code-${flow.id}`, error } = {}) {
  const callback = new URL(`${origin}${redirect.pathname}${redirect.search}`);
  if (error) callback.searchParams.set("error", error);
  else callback.searchParams.set("code", code);
  callback.searchParams.set("state", flow.id);
  await page.goto(callback.toString());
}

async function readSession(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("oauth:browser_session")));
}
try {
  for (const surface of process.env.REGIONAL_BOUNDARIES_ONLY
    ? []
    : webShareEntry
      ? ["share"]
      : ["remote", "share"])
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
            const redirect = await clickAuthorize(h);
            // 远控回调保留扫码参数，让网关按 app_version 加载同一版本；分享使用独立回调地址。
            assert.equal(
              `${redirect.pathname}${redirect.search}`,
              surface === "remote" ? "/remote/v4?app_version=3.16.3" : "/cn/share/callback",
            );
            assert.equal(h.flows.length, 1);
            assert.equal(h.flows[0].provider, provider);
            await returnFromAuthorize(h.page, redirect, h.flows[0]);
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
            assert.deepEqual(h.callbacks, [
              { provider, code: `code-${h.flows[0].id}`, state: h.flows[0].id },
            ]);
            // 回到发起页原地址；授权参数不留在地址栏。
            assert.equal(h.page.url(), `${origin}${path}`);
            const session = await readSession(h.page);
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
    : webShareEntry
      ? ["share-cancel", "share-retry"]
      : [
          "cancel",
          "foreign-subject",
          "superseded",
          "legacy-callback",
          "no-locks-logout",
          "same-jwt-revision",
          "clock-skew",
          "no-popup",
          "other-tab-callback",
          "unknown-state",
          "expired-retry",
          "share-cancel",
          "share-retry",
        ]) {
    let releaseInit;
    const holdInit =
      scenario === "cancel" || scenario === "share-cancel"
        ? new Promise((resolve) => {
            releaseInit = resolve;
          })
        : undefined;
    const h = await fixture({
      ...(scenario === "clock-skew" ? { clockOffsetMs: 394_000 } : {}),
      ...(scenario === "no-popup" ? { noPopup: true } : {}),
      ...(holdInit ? { holdInit } : {}),
    });
    try {
      const startPath = scenario.startsWith("share-") ? SHARE_PATH : "/remote/v4";
      await h.page.goto(`${origin}${startPath}`);
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
        const callbackErrorTitle = h.page.getByRole("heading", { name: "登录失败", exact: true });
        if (scenario === "cancel" || scenario === "share-cancel") {
          // 跳转前取消：init 未返回时点取消，页面不跳转，pending 与 attempt 都不残留。
          // share-cancel 覆盖分享入口：入口必须把取消信号交给登录服务，否则 init 返回后仍会跳走。
          await h.page.getByTestId("regional-login-submit").click();
          await assertEventually(() => h.flows.length === 1);
          await h.page.getByTestId("regional-login-cancel").click();
          releaseInit();
          await h.page.waitForFunction(
            () => localStorage.getItem("oauth:browser_login_attempt") === null,
          );
          assert.equal(new URL(h.page.url()).origin, origin);
          assert.equal(
            await h.page.evaluate(() => localStorage.getItem("oauth_pending_logins")),
            null,
          );
          assert.equal(await readSession(h.page), null);
          await h.page.getByTestId("regional-login-submit").waitFor({ state: "visible" });
        } else if (scenario === "share-retry") {
          // 分享页授权被拒：不调用后端；“重新登录”回到原分享页，而不是无分享码的 /share。
          const redirect = await clickAuthorize(h);
          await returnFromAuthorize(h.page, redirect, h.flows[0], { error: "access_denied" });
          const retry = h.page.getByRole("button", {
            name: /^(重新登录|Sign In Again|Try again)$/,
          });
          await retry.waitFor();
          assert.deepEqual(h.callbacks, []);
          await retry.click();
          await h.page.getByTestId("regional-login-submit").waitFor();
          assert.equal(h.page.url(), `${origin}${SHARE_PATH}`);
          assert.equal(
            await h.page.evaluate(() => localStorage.getItem("oauth_pending_logins")),
            null,
          );
        } else if (scenario === "unknown-state") {
          // 不属于任何 pending 的服务端 state：按 CSRF 失败，不调用后端 callback。
          await h.page.goto(`${origin}/remote/v4?code=code-x&state=0123456789abcdef`);
          await callbackErrorTitle.waitFor();
          assert.deepEqual(h.callbacks, []);
          assert.equal(await readSession(h.page), null);
        } else {
          const redirect = await clickAuthorize(h);
          if (scenario === "superseded") {
            // 跳转期间其他标签登录了新会话：旧 flow 回调不得覆盖。
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
            await returnFromAuthorize(h.page, redirect, h.flows[0]);
            await callbackErrorTitle.waitFor();
            assert.deepEqual(h.callbacks, []);
            assert.equal((await readSession(h.page)).revision, "newer");
            assert.equal(
              await h.page.evaluate(() => localStorage.getItem("oauth:browser_login_attempt")),
              null,
            );
          } else if (scenario === "expired-retry") {
            // pending 过期：不调用后端；“重新登录”回到发起页原地址。
            // 当前页停在授权站（另一 origin），在同源标签里改 pending 期限。
            const storagePage = await h.context.newPage();
            await storagePage.goto(`${origin}/remote/v4`);
            await storagePage.evaluate(() => {
              const logins = JSON.parse(localStorage.getItem("oauth_pending_logins"));
              for (const login of logins) login.regional.deadline = Date.now() - 1;
              localStorage.setItem("oauth_pending_logins", JSON.stringify(logins));
            });
            await storagePage.close();
            await returnFromAuthorize(h.page, redirect, h.flows[0]);
            await callbackErrorTitle.waitFor();
            assert.deepEqual(h.callbacks, []);
            await h.page.getByRole("button", { name: "重新登录", exact: true }).click();
            await h.page.getByTestId("regional-login-submit").waitFor();
            assert.equal(h.page.url(), `${origin}/remote/v4`);
          } else if (scenario === "foreign-subject") {
            await returnFromAuthorize(h.page, redirect, h.flows[0]);
            await callbackErrorTitle.waitFor();
            assert.equal(await readSession(h.page), null);
          } else {
            // no-popup / clock-skew：同一标签回调；other-tab-callback：回调落在同源新标签。
            const callbackPage =
              scenario === "other-tab-callback" ? await h.context.newPage() : h.page;
            await returnFromAuthorize(callbackPage, redirect, h.flows[0]);
            await callbackPage.getByRole("heading", { name: "选择电脑", exact: true }).waitFor();
            assert.equal(h.callbacks.length, 1);
            const session = await readSession(callbackPage);
            assert.equal(session.zcodeJwtToken, "e2e-jwt");
            assert.equal(session.userInfo.id, "e2e-user");
            // pending 取出即删，poll 凭据不残留。
            assert.equal(
              await callbackPage.evaluate(() => localStorage.getItem("oauth_pending_logins")),
              null,
            );
            assert.deepEqual(h.errors, []);
          }
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
