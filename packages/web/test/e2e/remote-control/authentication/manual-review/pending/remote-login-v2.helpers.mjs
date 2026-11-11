import assert from "node:assert/strict";
import { resolve } from "node:path";

export const mixedDevices = [
  { device_sid: "offline", device_mid: "12345678-offline", online: false, created_at: 1, meta: {} },
  {
    device_sid: "second",
    device_mid: "d67e89f0-other",
    online: true,
    created_at: 1,
    meta: { name: "Workstation", platform: "win32", version: "3.15.0" },
  },
  {
    device_sid: "e2e-device",
    device_mid: "e2e-mid",
    online: true,
    created_at: 1,
    meta: { name: "Alice’s MacBook", platform: "darwin", version: "3.15.0" },
  },
];

export async function setup(
  browser,
  {
    width = 390,
    height = 844,
    theme = "zai-light",
    locale = "zh-CN",
    signedIn = false,
    tokenStatus = 200,
    relayError = "AUTH_FAILED",
    // 按 SID 指定 relay 回复（"matched" / "waiting" / 错误码），用于旧 SID 接续；提供时覆盖 relayError。
    relayReplies,
    devices = mixedDevices,
    lastSid,
    provider = "zai",
    initialProvider = provider,
    expectedDeviceSid = "e2e-device",
    expectedDeviceMid = "e2e-mid",
  } = {},
) {
  const context = await browser.newContext({ viewport: { width, height }, locale });
  const page = await context.newPage();
  const errors = [];
  const traffic = {
    tokens: 0,
    sockets: 0,
    bootstraps: 0,
    lists: 0,
    authSids: [],
    authorize: undefined,
  };
  page.on("pageerror", (error) => errors.push(error.message));
  await context.addInitScript(
    ({ theme, signedIn, lastSid, provider }) => {
      if (lastSid) localStorage.setItem("zcode-web-remote-last-device-sid", lastSid);
      localStorage.setItem("zcode-theme", theme);
      if (signedIn && !sessionStorage.getItem("e2e-seeded")) {
        sessionStorage.setItem("e2e-seeded", "1");
        localStorage.setItem("zcodejwttoken", "e2e-jwt");
        localStorage.setItem("oauth:active_provider", provider);
        localStorage.setItem(`oauth:${provider}:access_token`, "e2e-access");
        localStorage.setItem(
          `oauth:${provider}:user_info`,
          JSON.stringify({ user_id: "e2e-user", name: "E2E" }),
        );
      }
    },
    { theme, signedIn, lastSid, provider: initialProvider },
  );
  // 受控响应挂在 context 上，同一浏览器新开的标签页也能命中；用例在 page 上的路由仍优先。
  await context.route("**/api/v1/remote/device", async (route) => {
    traffic.lists++;
    assert.equal(route.request().method(), "GET");
    assert.equal(route.request().headers().authorization, "Bearer e2e-jwt");
    await route.fulfill({ json: { code: 0, msg: "", data: devices } });
  });
  await context.route("**/api/v1/remote/token", async (route) => {
    traffic.tokens++;
    assert.equal(route.request().headers().authorization, "Bearer e2e-jwt");
    assert.deepEqual(route.request().postDataJSON(), { role: "terminal" });
    await route.fulfill({
      status: tokenStatus,
      json: { code: 0, msg: "", data: { token: "AAAAAAAAAAAAAAAAAAAAAA", expires_in: 60 } },
    });
  });
  await context.route("**/api/v1/oauth/token", async (route) => {
    traffic.exchange = route.request().postDataJSON();
    assert.equal(traffic.exchange.provider, provider);
    await route.fulfill({
      json: {
        code: 0,
        data: {
          token: "e2e-jwt",
          [provider]: { access_token: "e2e-access" },
          expires_in: 3600,
          user: { user_id: "e2e-user", name: "E2E" },
        },
      },
    });
  });
  await context.route(/\/(?:api\/oauth\/authorize|login)\?/, async (route) => {
    traffic.authorize = new URL(route.request().url());
    await route.fulfill({ contentType: "text/html", body: "<p>E2E OAuth provider</p>" });
  });
  await context.routeWebSocket(/\/api\/v1\/remote\/ws2(?:\?|$)/, (socket) => {
    traffic.sockets++;
    let authedSid;
    const url = new URL(socket.url());
    assert.equal(url.searchParams.get("mid"), expectedDeviceMid);
    assert.equal(url.searchParams.get("token"), "AAAAAAAAAAAAAAAAAAAAAA");
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "auth_init" && relayReplies) {
        traffic.authSids.push(message.device_sid);
        assert.ok(message.device_sid in relayReplies, `unexpected SID ${message.device_sid}`);
        const reply = relayReplies[message.device_sid];
        socket.send(
          JSON.stringify(
            reply === "matched" || reply === "waiting"
              ? {
                  type: "auth_ack",
                  device_sid: message.device_sid,
                  terminal_sid: "e2e-terminal",
                  pair_status: reply,
                }
              : { type: "error", code: reply },
          ),
        );
        authedSid = message.device_sid;
        return;
      }
      // 按 SID 回复时也回应心跳，避免 15 秒 watchdog 重建连接、重置首次 waiting 计时。
      if (message.type === "pair_status_query" && relayReplies && authedSid) {
        socket.send(
          JSON.stringify({
            type: "pair_status_ack",
            pair_status: relayReplies[authedSid] === "matched" ? "matched" : "waiting",
          }),
        );
        return;
      }
      if (message.type === "auth_init") {
        assert.equal(message.device_sid, expectedDeviceSid);
        assert.equal(message.role, undefined);
        assert.ok(message.client_ts < 253402300800);
        socket.send(
          JSON.stringify(
            relayError
              ? { type: "error", code: relayError }
              : {
                  type: "auth_ack",
                  device_sid: expectedDeviceSid,
                  terminal_sid: "e2e-terminal",
                  pair_status: "matched",
                },
          ),
        );
      }
      if (message.payload?.zcode_type === "bootstrap-request") traffic.bootstraps++;
    });
  });
  return { page, context, errors, traffic };
}

export async function assertEventually(check, timeoutMs = 15_000) {
  for (let attempt = 0; attempt < timeoutMs / 100; attempt++) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(check(), "condition did not become true");
}

export async function checkSwitchConfirmation(h, { screen, width, theme, locale, artifacts }) {
  const { page } = h;
  const originalUrl = page.url();
  const filename = `confirm-${screen}-${width}-${theme}-${locale}.png`;
  // 设备页账号行的动作为“切换”，失败页仍是“切换账号”；两者打开同一确认弹窗。
  const trigger = page.getByRole("button", { name: /^(切换账号|Switch account|切换|Switch)$/ });
  const dialog = page.getByRole("dialog");
  const cancel = dialog.getByRole("button", { name: /^(取消|Cancel)$/ });
  const confirm = dialog.getByRole("button", { name: /^(退出并切换|Sign out & switch)$/ });
  for (const dismissal of ["cancel", "escape", "overlay"]) {
    await trigger.click();
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("zcodejwttoken")), "e2e-jwt");
    assert.equal(await cancel.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await confirm.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await cancel.evaluate((element) => element === document.activeElement), true);
    if (dismissal === "cancel") {
      await page.screenshot({
        path: resolve(artifacts, filename),
        fullPage: true,
        animations: "disabled",
      });
      const box = await dialog.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      await cancel.click();
    } else if (dismissal === "escape") await page.keyboard.press("Escape");
    else await page.locator('[data-slot="dialog-overlay"]').click({ position: { x: 5, y: 5 } });
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.evaluate(() => localStorage.getItem("zcodejwttoken")), "e2e-jwt");
    assert.equal(page.url(), originalUrl);
  }
  await trigger.click();
  await confirm.click();
  await page.getByRole("button", { name: /连接 Z.ai 继续使用|Connect to Z.ai/ }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("zcodejwttoken")), null);
  assert.equal(page.url(), originalUrl);
  assert.deepEqual(h.errors, []);
  return {
    case: "MC01 切换账号确认",
    screen: `confirm-${screen}`,
    width,
    theme,
    locale,
    screenshot: filename,
    result: "passed",
  };
}
