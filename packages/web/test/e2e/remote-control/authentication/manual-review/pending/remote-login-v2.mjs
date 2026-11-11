// ML01–ML07、ML09、MD01–MD06、MD11–MD13：真实 Web 入口 + 浏览器 OAuth 回跳/登录门禁；外部 OAuth/relay 使用受控响应。
// 启动：VITE_WEB_REMOTE_CONTROL_ROUTE_PATH=/remote/__test__ pnpm --filter @zcode/web exec vite --host 127.0.0.1 --port 5178 --strictPort
// 运行：node packages/web/test/e2e/remote-control/authentication/manual-review/pending/remote-login-v2.mjs
// 截图保留 pending，不代表真实 OAuth/手机/OSS 验收，不自动转正。
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import {
  setup,
  mixedDevices,
  assertEventually,
  checkSwitchConfirmation,
} from "./remote-login-v2.helpers.mjs";

const origin = process.env.REMOTE_LOGIN_E2E_ORIGIN || "http://127.0.0.1:5178";
const artifacts = resolve(".tmp/remote-login-v2-e2e");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
const qrPath = "/remote/v4?app_version=3.13.0&sid=e2e-device&mid=e2e-mid&name=E2E";

try {
  for (const width of [390, 1024])
    for (const theme of ["zai-light", "zai-dark"])
      for (const locale of ["zh-CN", "en-US"])
        for (const screen of ["login", "devices", "empty", "device-not-owned"]) {
          const h = await setup(browser, {
            width,
            theme,
            locale,
            signedIn: screen !== "login",
            devices: screen === "empty" ? [] : mixedDevices,
          });
          const isList = screen === "devices" || screen === "empty";
          try {
            await h.page.goto(`${origin}${isList ? "/remote/v4" : qrPath}`);
            const title =
              screen === "login"
                ? locale === "zh-CN"
                  ? "登录后继续使用 Web 远程控制"
                  : "Sign In To Continue"
                : isList
                  ? locale === "zh-CN"
                    ? "选择电脑"
                    : "Choose a computer"
                  : locale === "zh-CN"
                    ? "该设备不属于当前账号"
                    : "This device does not belong to this account";
            await h.page.getByRole("heading", { name: title, exact: true }).waitFor();
            if (screen === "login") {
              assert.deepEqual(
                await h.page.getByRole("button").allTextContents(),
                locale === "zh-CN"
                  ? ["连接 Z.ai 继续使用全球", "连接 BigModel 继续使用中国"]
                  : ["Connect to Z.aiGlobal", "Connect to BigModelCN"],
              );
            }
            if (isList) {
              // 空态除页头刷新图标外还有一个带文字的刷新按钮。
              await h.page
                .getByRole("button", { name: /^(刷新|Refresh)$/ })
                .first()
                .waitFor();
              await h.page
                .getByText(
                  screen === "empty"
                    ? locale === "zh-CN"
                      ? "暂无设备"
                      : "No devices yet"
                    : "Alice’s MacBook",
                  { exact: true },
                )
                .waitFor();
              assert.equal(h.traffic.lists, 1);
              if (screen === "devices") {
                // 在线组在前、离线组在后；两组各自是一个列表。
                const rows = h.page.locator("main ul button");
                assert.match(await rows.nth(0).innerText(), /Alice’s MacBook/);
                assert.match(await rows.nth(1).innerText(), /Workstation/);
                assert.equal(await rows.nth(2).isDisabled(), true);
                const opacities = await rows.evaluateAll((elements) =>
                  elements.map((element) => getComputedStyle(element.firstElementChild).opacity),
                );
                assert.notEqual(opacities[0], opacities[2], "离线行应弱化");
                assert.match(await h.page.locator("main").innerText(), /E2E · Z\.ai/);
              }
            }
            await h.page.evaluate(() => document.fonts.ready);
            assert.equal(
              await h.page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
              false,
            );
            // 归属失败后按 MID 查一次当前账号设备；mixedDevices 里原 SID 仍在线，不接续，留在失败页。
            if (screen === "device-not-owned") assert.equal(h.traffic.lists, 1);
            assert.equal(h.traffic.tokens, screen === "device-not-owned" ? 1 : 0);
            assert.equal(h.traffic.sockets, screen === "device-not-owned" ? 1 : 0);
            assert.deepEqual(h.errors, []);
            const filename = `${screen}-${width}-${theme}-${locale}.png`;
            await h.page.screenshot({ path: resolve(artifacts, filename), fullPage: true });
            if (screen === "device-not-owned") {
              assert.equal(
                await h.page
                  .getByRole("button", { name: /选择其他设备|Choose another device/ })
                  .count(),
                1,
              );
            }
            if (screen === "device-not-owned" || screen === "devices")
              results.push(
                await checkSwitchConfirmation(h, { screen, width, theme, locale, artifacts }),
              );
            results.push({ screen, width, theme, locale, screenshot: filename, result: "passed" });
          } finally {
            await h.context.close();
          }
        }

  // 列表三个刷新触发、选择后回写、刷新页面走有 SID 路径。
  const selection = await setup(browser, { signedIn: true, relayError: null });
  try {
    await selection.page.goto(`${origin}/remote/v4?app_version=3.13.0`);
    await selection.page.getByRole("button", { name: /Alice’s MacBook/ }).waitFor();
    assert.equal(selection.traffic.lists, 1);
    await selection.page.getByRole("button", { name: "刷新", exact: true }).click();
    await assertEventually(() => selection.traffic.lists === 2);
    // 刷新按钮名称固定为“刷新”（请求中只转圈并禁用），需等它恢复可用再触发回前台刷新。
    const refresh = selection.page.getByRole("button", { name: "刷新", exact: true });
    for (let attempt = 0; attempt < 50 && (await refresh.isDisabled()); attempt++)
      await selection.page.waitForTimeout(100);
    assert.equal(await refresh.isDisabled(), false);
    await selection.page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(selection.traffic.lists, 2);
    await selection.page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await assertEventually(() => selection.traffic.lists === 3);
    await selection.page.getByRole("button", { name: /Alice’s MacBook/ }).click();
    await assertEventually(() => selection.traffic.bootstraps === 1);
    assert.deepEqual(Object.fromEntries(new URL(selection.page.url()).searchParams), {
      app_version: "3.13.0",
      sid: "e2e-device",
      mid: "e2e-mid",
      name: "Alice’s MacBook",
    });
    assert.equal(
      await selection.page.evaluate(() => localStorage.getItem("zcode-web-remote-last-device-sid")),
      "e2e-device",
    );
    await selection.page.reload();
    await assertEventually(() => selection.traffic.bootstraps === 2);
    assert.equal(selection.traffic.lists, 3);
    assert.deepEqual(selection.errors, []);
    results.push({ case: "MD01 列表三种刷新与选择；MD02 刷新恢复", result: "passed" });
  } finally {
    await selection.context.close();
  }

  for (const lastSid of ["e2e-device", "offline", "other-account-device"]) {
    const h = await setup(browser, { signedIn: true, relayError: null, lastSid });
    try {
      await h.page.goto(`${origin}/remote/v4?app_version=3.13.0`);
      if (lastSid === "e2e-device") await assertEventually(() => h.traffic.bootstraps === 1);
      else {
        await h.page.getByRole("button", { name: /Alice’s MacBook/ }).waitFor();
        assert.equal(h.traffic.tokens, 0);
      }
      assert.equal(h.traffic.lists, 1);
      assert.deepEqual(h.errors, []);
      results.push({ case: `MD03 最近设备 ${lastSid}`, result: "passed" });
    } finally {
      await h.context.close();
    }
  }

  const other = await setup(browser, { signedIn: true, lastSid: "e2e-device" });
  try {
    await other.page.goto(`${origin}${qrPath}`);
    await other.page.getByRole("button", { name: "选择其他设备", exact: true }).click();
    await other.page.getByRole("button", { name: /Alice’s MacBook/ }).waitFor();
    assert.equal(other.traffic.tokens, 1);
    // 第 1 次是归属失败后的旧 SID 接续查询（原 SID 在线，不接续），第 2 次是“选择其他设备”。
    assert.equal(other.traffic.lists, 2);
    assert.deepEqual(Object.fromEntries(new URL(other.page.url()).searchParams), {
      app_version: "3.13.0",
    });
    assert.equal(await other.page.evaluate(() => localStorage.getItem("zcodejwttoken")), "e2e-jwt");
    await other.page.getByRole("button", { name: "切换", exact: true }).click();
    await other.page.getByRole("button", { name: "退出并切换", exact: true }).click();
    await other.page.getByRole("button", { name: /连接 Z.ai 继续使用/ }).waitFor();
    assert.equal(await other.page.evaluate(() => localStorage.getItem("zcodejwttoken")), null);
    assert.deepEqual(other.errors, []);
    results.push({ case: "MD04 失败页换设备跳过最近直连；MD05 列表切换账号", result: "passed" });
  } finally {
    await other.context.close();
  }

  const shortScreen = await setup(browser, {
    signedIn: true,
    height: 300,
    relayError: null,
    devices: Array.from({ length: 12 }, (_, index) => ({
      ...mixedDevices[2],
      device_sid: index === 0 ? "e2e-device" : `device-${index}`,
      // 每台电脑独立 MID；同 MID 的多个 SID 会聚合成一行“N 个连接”。
      device_mid: index === 0 ? "e2e-mid" : `mid-${index}`,
      meta: { name: `Computer ${String(index).padStart(2, "0")}` },
    })),
  });
  try {
    await shortScreen.page.goto(`${origin}/remote/v4`);
    await shortScreen.page.getByRole("button", { name: /Computer 11/ }).waitFor();
    const geometry = await shortScreen.page.locator("main").evaluate((main) => {
      main.scrollTop = main.scrollHeight;
      return {
        scrollTop: main.scrollTop,
        lastBottom: main.querySelector("li:last-child").getBoundingClientRect().bottom,
        viewport: innerHeight,
      };
    });
    assert.ok(geometry.scrollTop > 0);
    assert.ok(geometry.lastBottom <= geometry.viewport);
    const firstRow = shortScreen.page.getByRole("button", { name: /Computer 00/ });
    const unfocused = await firstRow.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await shortScreen.page.getByRole("button", { name: "刷新", exact: true }).focus();
    // 刷新 → 账号行“切换” → 第一台设备
    await shortScreen.page.keyboard.press("Tab");
    await shortScreen.page.keyboard.press("Tab");
    assert.equal(await firstRow.evaluate((element) => element === document.activeElement), true);
    assert.notEqual(
      await firstRow.evaluate((element) => getComputedStyle(element).backgroundColor),
      unfocused,
    );
    await shortScreen.page.keyboard.press("Enter");
    await assertEventually(() => shortScreen.traffic.bootstraps === 1);
    assert.deepEqual(shortScreen.errors, []);
    results.push({ case: "MD06 矮屏长列表末行可达、键盘焦点与选择", result: "passed" });
  } finally {
    await shortScreen.context.close();
  }

  // 归属失败后从旧 Z.AI 会话切到 BigModel，两个入口仍由同一门禁提供。
  const switched = await setup(browser, {
    signedIn: true,
    initialProvider: "zai",
    provider: "bigmodel",
  });
  try {
    await switched.page.goto(`${origin}${qrPath}`);
    await switched.page.getByRole("button", { name: "切换账号", exact: true }).click();
    await switched.page.getByRole("button", { name: "退出并切换", exact: true }).click();
    await switched.page.getByRole("button", { name: /连接 BigModel 继续使用/ }).click();
    await assertEventually(() => !!switched.traffic.authorize);
    assert.equal(switched.traffic.authorize.pathname, "/login");
    const state = switched.traffic.authorize.searchParams.get("state");
    const payload = JSON.parse(Buffer.from(state, "base64url").toString());
    assert.equal(payload.app_return_to, `${origin}${qrPath}`);
    const callback = new URL(switched.traffic.authorize.searchParams.get("redirect"));
    assert.equal(callback.search, new URL(qrPath, origin).search);
    const redirectUri = callback.toString();
    callback.searchParams.set("authCode", "e2e-code");
    callback.searchParams.set("state", state);
    await switched.page.goto(`${origin}${callback.pathname}${callback.search}`);
    await switched.page.waitForURL(`${origin}${qrPath}`);
    assert.equal(switched.traffic.exchange.redirect_uri, redirectUri);
    assert.equal(
      await switched.page.evaluate(() => localStorage.getItem("oauth:active_provider")),
      "bigmodel",
    );
    assert.equal(
      await switched.page.evaluate(() => localStorage.getItem("oauth:zai:access_token")),
      null,
    );
    assert.deepEqual(switched.errors, []);
    results.push({ case: "ML03 归属失败后切到 BigModel 并回原扫码地址", result: "passed" });
  } finally {
    await switched.context.close();
  }

  // 正式/测试入口首次登录或401重登 → 原 URL 回跳 → terminal 配对并发送 bootstrap。
  for (const path of ["/remote/v4", "/remote/__test__"])
    for (const signedIn of [false, true])
      for (const width of [390, 1024])
        for (const provider of ["zai", "bigmodel"]) {
          const login = await setup(browser, { relayError: null, provider, width, signedIn });
          const loginQrPath = qrPath.replace("/remote/v4", path);
          try {
            if (signedIn) {
              // 只让旧登录态的第一次取token失败，新登录后恢复正常服务。
              await login.page.route(
                "**/api/v1/remote/token",
                async (route) => {
                  login.traffic.tokens++;
                  await route.fulfill({ status: 401, json: { code: 1001, msg: "unauthorized" } });
                },
                { times: 1 },
              );
            }
            await login.page.goto(`${origin}${loginQrPath}`);
            await login.page.getByRole("button", { name: /连接 Z.ai 继续使用/ }).waitFor();
            assert.equal(await login.page.getByRole("dialog").count(), 0);
            assert.equal(login.page.url(), `${origin}${loginQrPath}`);
            assert.equal(
              await login.page.evaluate(() => localStorage.getItem("zcodejwttoken")),
              null,
            );
            assert.equal(login.traffic.tokens, signedIn ? 1 : 0);
            assert.equal(login.traffic.sockets, 0);
            await login.page
              .getByRole("button", {
                name: provider === "zai" ? /连接 Z.ai 继续使用/ : /连接 BigModel 继续使用/,
              })
              .click();
            await assertEventually(() => !!login.traffic.authorize);
            const state = login.traffic.authorize.searchParams.get("state");
            const redirectUri = login.traffic.authorize.searchParams.get(
              provider === "zai" ? "redirect_uri" : "redirect",
            );
            const callback = new URL(redirectUri);
            assert.equal(callback.pathname, "/remote/v4");
            assert.equal(callback.search, new URL(loginQrPath, origin).search);
            if (provider === "bigmodel") {
              assert.equal(
                login.traffic.authorize.origin,
                process.env.REMOTE_LOGIN_E2E_BIGMODEL_ORIGIN || "https://bigmodel.cn",
              );
              assert.equal(login.traffic.authorize.pathname, "/login");
              assert.equal(login.traffic.authorize.searchParams.get("appId"), "zcode");
              assert.equal(login.traffic.authorize.searchParams.has("redirect_uri"), false);
            }
            const payload = JSON.parse(Buffer.from(state, "base64url").toString());
            assert.equal(payload.app_return_to, `${origin}${loginQrPath}`);
            await login.page.goto(`${origin}/remote/v4`);
            assert.equal(
              await login.page.evaluate(
                () => JSON.parse(localStorage.getItem("oauth_pending_logins"))[0].provider,
              ),
              provider,
            );
            callback.searchParams.set(provider === "bigmodel" ? "authCode" : "code", "e2e-code");
            callback.searchParams.set("state", state);
            // 仅用本地 origin 承载真实入口；回调 path/query 来自实际授权地址，不另造无参数回调。
            await login.page.goto(`${origin}${callback.pathname}${callback.search}`);
            await login.page.waitForURL(`${origin}${loginQrPath}`);
            await assertEventually(() => login.traffic.bootstraps === 1);
            assert.equal(login.traffic.tokens, signedIn ? 2 : 1);
            assert.equal(login.traffic.sockets, 1);
            assert.equal(
              await login.page.evaluate(() => localStorage.getItem("zcodejwttoken")),
              "e2e-jwt",
            );
            assert.equal(
              await login.page.evaluate(() => localStorage.getItem("oauth:active_provider")),
              provider,
            );
            assert.equal(
              await login.page.evaluate(
                (p) => localStorage.getItem(`oauth:${p}:access_token`),
                provider,
              ),
              "e2e-access",
            );
            assert.equal(
              await login.page.evaluate(() => localStorage.getItem("oauth_pending_logins")),
              null,
            );
            assert.equal(login.traffic.exchange.provider, provider);
            assert.equal(login.traffic.exchange.redirect_uri, redirectUri);
            assert.deepEqual(login.errors, []);
            results.push({
              case: `ML04 ${path} ${provider} ${width}px ${signedIn ? "401重登" : "首次登录"}保留回调参数并配对`,
              result: "passed",
            });
          } finally {
            await login.context.close();
          }
        }

  // ML07：回调落在同一浏览器的另一个标签页（新标签页 sessionStorage 为空，只共享 localStorage）。
  // 修复前回调页读不到发起页 sessionStorage 中的 nonce，停在 “OAuth CSRF 检测失败”。
  for (const provider of ["zai", "bigmodel"]) {
    const login = await setup(browser, { relayError: null, provider });
    const callbackPage = await login.context.newPage();
    callbackPage.on("pageerror", (error) => login.errors.push(error.message));
    try {
      await login.page.goto(`${origin}${qrPath}`);
      await login.page
        .getByRole("button", {
          name: provider === "zai" ? /连接 Z.ai 继续使用/ : /连接 BigModel 继续使用/,
        })
        .click();
      await assertEventually(() => !!login.traffic.authorize);
      const redirectUri = login.traffic.authorize.searchParams.get(
        provider === "zai" ? "redirect_uri" : "redirect",
      );
      const callback = new URL(redirectUri);
      callback.searchParams.set(provider === "bigmodel" ? "authCode" : "code", "e2e-code");
      callback.searchParams.set("state", login.traffic.authorize.searchParams.get("state"));
      await callbackPage.goto(`${origin}${callback.pathname}${callback.search}`);
      await callbackPage.waitForURL(`${origin}${qrPath}`);
      await assertEventually(() => login.traffic.bootstraps === 1);
      assert.equal(login.traffic.exchange.provider, provider);
      assert.equal(login.traffic.exchange.redirect_uri, redirectUri);
      assert.equal(
        await callbackPage.evaluate(() => localStorage.getItem("zcodejwttoken")),
        "e2e-jwt",
      );
      assert.equal(
        await callbackPage.evaluate(() => localStorage.getItem("oauth_pending_logins")),
        null,
      );
      assert.deepEqual(login.errors, []);
      results.push({ case: `ML07 ${provider} 回调落在新标签页仍完成登录并配对`, result: "passed" });
    } finally {
      await callbackPage.screenshot({ path: resolve(artifacts, `ml07-${provider}.png`) });
      await login.context.close();
    }
  }

  for (const provider of ["zai", "bigmodel"])
    for (const tokenStatus of [200, 401]) {
      const h = await setup(browser, { signedIn: true, tokenStatus, relayError: null, provider });
      try {
        await h.page.goto(`${origin}${qrPath}`);
        if (tokenStatus === 200) await assertEventually(() => h.traffic.bootstraps === 1);
        else {
          await h.page.getByRole("button", { name: /连接 Z.ai 继续使用/ }).waitFor();
          assert.equal(await h.page.evaluate(() => localStorage.getItem("zcodejwttoken")), null);
          assert.equal(h.page.url(), `${origin}${qrPath}`);
          assert.equal(h.traffic.sockets, 0);
          await h.page.getByRole("button", { name: /连接 BigModel 继续使用/ }).click();
          await assertEventually(() => !!h.traffic.authorize);
          assert.equal(h.traffic.authorize.pathname, "/login");
          const state = JSON.parse(
            Buffer.from(h.traffic.authorize.searchParams.get("state"), "base64url").toString(),
          );
          assert.equal(state.app_return_to, `${origin}${qrPath}`);
        }
        assert.deepEqual(h.errors, []);
        results.push({
          case: `${provider} ${tokenStatus === 200 ? "ML05 已登录直连" : "ML06 token401回登录保留原URL"}`,
          result: "passed",
        });
      } finally {
        await h.context.close();
      }
    }

  // ML09：旧 JWT 的 token 请求在途时，另一个标签页写入新 JWT（同源 localStorage 共享），旧请求才回 401。
  // 修复前入口直接登出，清掉新 JWT 并回登录页；修复后按可重试处理，用新 JWT 重新申请并配对。
  {
    const h = await setup(browser, { signedIn: true, relayError: null });
    let releaseStale;
    const staleHeld = new Promise((done) => (releaseStale = done));
    const authorizations = [];
    await h.page.route("**/api/v1/remote/token", async (route) => {
      h.traffic.tokens++;
      authorizations.push(route.request().headers().authorization);
      if (authorizations.length === 1) {
        await staleHeld;
        await route.fulfill({ status: 401, json: { code: 1001, msg: "unauthorized" } });
        return;
      }
      await route.fulfill({
        json: { code: 0, msg: "", data: { token: "AAAAAAAAAAAAAAAAAAAAAA", expires_in: 60 } },
      });
    });
    try {
      await h.page.goto(`${origin}${qrPath}`);
      await assertEventually(() => authorizations.length === 1);
      await h.page.evaluate(() => localStorage.setItem("zcodejwttoken", "e2e-jwt-2"));
      releaseStale();
      await assertEventually(() => h.traffic.bootstraps === 1);
      assert.deepEqual(authorizations, ["Bearer e2e-jwt", "Bearer e2e-jwt-2"]);
      assert.equal(await h.page.evaluate(() => localStorage.getItem("zcodejwttoken")), "e2e-jwt-2");
      assert.equal(await h.page.getByRole("button", { name: /连接 Z.ai 继续使用/ }).count(), 0);
      assert.equal(h.traffic.sockets, 1);
      assert.equal(h.page.url(), `${origin}${qrPath}`);
      assert.deepEqual(h.errors, []);
      results.push({ case: "ML09 迟到401不清除其他标签页的新登录并用新JWT配对", result: "passed" });
    } finally {
      await h.context.close();
    }
  }

  // MD11–MD13：旧 SID 自动接续。桌面重新注册后同 MID 换了新 SID，旧链接仍带旧 SID。
  const sameMidDevices = (...sids) => [
    { device_sid: "e2e-device", device_mid: "e2e-mid", online: false, created_at: 1, meta: {} },
    ...sids.map((sid) => ({
      device_sid: sid,
      device_mid: "e2e-mid",
      online: true,
      created_at: 2,
      meta: { name: "Alice’s MacBook", platform: "darwin", version: "3.15.0" },
    })),
    mixedDevices[1],
  ];
  for (const oldReply of ["AUTH_FAILED", "waiting"]) {
    const h = await setup(browser, {
      signedIn: true,
      devices: sameMidDevices("e2e-device-new"),
      relayReplies: { "e2e-device": oldReply, "e2e-device-new": "matched" },
    });
    try {
      await h.page.goto(`${origin}${qrPath}`);
      // waiting 走首次 30 秒等待超时（desktop-disconnected）后才查询。
      await assertEventually(() => h.traffic.bootstraps === 1, 45_000);
      assert.deepEqual(h.traffic.authSids.slice(-2), ["e2e-device", "e2e-device-new"]);
      assert.equal(h.traffic.lists, 1);
      assert.deepEqual(Object.fromEntries(new URL(h.page.url()).searchParams), {
        app_version: "3.13.0",
        sid: "e2e-device-new",
        mid: "e2e-mid",
        name: "Alice’s MacBook",
      });
      assert.equal(
        await h.page.evaluate(() => localStorage.getItem("zcode-web-remote-last-device-sid")),
        "e2e-device-new",
      );
      // 刷新按新 SID 直连，不再查询列表。
      await h.page.reload();
      await assertEventually(() => h.traffic.bootstraps === 2);
      assert.equal(h.traffic.authSids.at(-1), "e2e-device-new");
      assert.equal(h.traffic.lists, 1);
      assert.deepEqual(h.errors, []);
      results.push({
        case: `${oldReply === "AUTH_FAILED" ? "MD11 归属失败" : "MD12 等待超时"}后接续同 MID 唯一在线新 SID`,
        result: "passed",
      });
    } finally {
      await h.context.close();
    }
  }
  for (const [label, devices, relayReplies, expectedSockets] of [
    // 同 MID 多个在线 SID：不猜目标，留在失败页由用户选择。
    [
      "同 MID 多个在线",
      sameMidDevices("e2e-device-a", "e2e-device-b"),
      { "e2e-device": "AUTH_FAILED" },
      1,
    ],
    // 接续出的新 SID 配对前又失败：只接续一次，不在 SID 间循环。
    [
      "接续目标也失效",
      sameMidDevices("e2e-device-new"),
      { "e2e-device": "AUTH_FAILED", "e2e-device-new": "AUTH_FAILED" },
      2,
    ],
  ]) {
    const h = await setup(browser, { signedIn: true, devices, relayReplies });
    try {
      await h.page.goto(`${origin}${qrPath}`);
      await h.page.getByRole("heading", { name: "该设备不属于当前账号", exact: true }).waitFor();
      assert.equal(h.traffic.lists, 1);
      assert.equal(h.traffic.sockets, expectedSockets);
      assert.equal(h.traffic.bootstraps, 0);
      assert.deepEqual(h.errors, []);
      results.push({ case: `MD13 ${label}：不接续，显示原失败页`, result: "passed" });
    } finally {
      await h.context.close();
    }
  }
} finally {
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
  const shots = results.filter((result) => result.screenshot);
  await writeFile(
    resolve(artifacts, "index.html"),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Relay V2 手机入口截图矩阵</title><style>body{margin:24px;background:#eee;color:#222;font:14px system-ui}main{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}figure{margin:0;background:white;padding:12px}img{width:100%;height:422px;object-fit:contain}figcaption{margin-bottom:12px}a{color:inherit}</style><h1>Relay V2 手机入口截图矩阵</h1><p>受控 OAuth / relay，本地浏览器证据。设备列表16张，登录与归属失败16张，切换账号确认16张。</p><main>${shots.map((shot) => `<figure><figcaption>${shot.screen} · ${shot.width}px · ${shot.theme} · ${shot.locale}</figcaption><a href="${shot.screenshot}"><img src="${shot.screenshot}" alt="${shot.screen}"></a></figure>`).join("")}</main></html>`,
  );
  await browser.close();
}
console.log(`Passed ${results.length} checks; screenshots: ${artifacts}`);
