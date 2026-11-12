import { randomUUID } from "node:crypto";
import { createSystemCredentialCipher } from "@zcode/shared/credential-security";
import { watch } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PlatformChannels } from "@zcode/shared";
import {
  TID_OAUTH_LOGIN_BUTTON,
  TID_OAUTH_ERROR,
  TID_OAUTH_CANCEL,
  TID_OAUTH_COPY_LOGIN_LINK,
  TID_LOGIN_TRIGGER,
  TID_LOGIN_MENU_ITEM,
  TID_LOGIN_REGION_SWITCH,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
import {
  openFaultInjectedHostWindow,
  readHostBoundary,
  waitForHostBoundary,
} from "#e2e/helpers/subagent-host-window";

describe("OAuth 双路径完成竞态", () => {
  let credentialWatcher: ReturnType<typeof watch> | undefined;
  after(async () => {
    credentialWatcher?.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("取消后迟到的兑换失败不创建登录或污染界面", async () => {
    const openExternal = await browser.electron.mock("shell", "openExternal");
    await openExternal.mockClear();
    await openExternal.mockResolvedValue(undefined);
    await browser.waitUntil(
      async () =>
        browser.execute(
          (button, trigger) =>
            Boolean(
              document.querySelector(
                `[data-testid="${button}"], [data-testid="${trigger}"], [data-testid="onboarding-page"]`,
              ),
            ),
          TID_OAUTH_LOGIN_BUTTON,
          TID_LOGIN_TRIGGER,
        ),
      { timeout: 60_000 },
    );
    await browser.keys("Escape");
    const baseUrl = process.env.ZCODE_E2E_OAUTH_RACE_URL!;
    await fetch(`${baseUrl}/__e2e/disable-poll`, { method: "POST" });
    const before = await readCredentials();
    const logDir = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
    if (!logDir) throw new Error("缺少 E2E 日志目录");
    const readCompletions = async () => {
      const logs = await Promise.all(
        (await readdir(logDir))
          .filter((file) => file.endsWith(".log"))
          .map((file) => readFile(join(logDir, file), "utf8")),
      );
      return logs.join("\n").split("oauth.handleCallback OK").length;
    };
    const completionsBefore = await readCompletions();
    if (!(await browser.$(`[data-testid="${TID_OAUTH_LOGIN_BUTTON}"]`).isExisting())) {
      const triggers = await browser.$$(`[data-testid="${TID_LOGIN_TRIGGER}"]`);
      for (const trigger of triggers) {
        if (await trigger.isDisplayed()) {
          await trigger.click();
          break;
        }
      }
      await clickTestIdByDom(TID_LOGIN_MENU_ITEM);
    }
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    await clickTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    await waitForTestIdByDom(TID_OAUTH_COPY_LOGIN_LINK);
    await browser.electron.execute((electron, channel) => {
      electron.BrowserWindow.getAllWindows()[0]!.webContents.send(
        channel,
        "zcode://oauth/callback?state=e2e-race&authCode=cancelled-failure",
      );
    }, PlatformChannels.OAuthCallback);
    await browser.waitUntil(
      async () =>
        ((await (await fetch(`${baseUrl}/__e2e/status`)).json()) as { tokenRequests: number })
          .tokenRequests === 1,
      { timeout: 10_000 },
    );
    await clickTestIdByDom(TID_OAUTH_CANCEL);
    await fetch(`${baseUrl}/__e2e/fail-token`, { method: "POST" });
    await browser.waitUntil(async () => (await readCompletions()) > completionsBefore, {
      timeout: 10_000,
    });
    await browser.executeAsync((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    expect(await browser.$(`[data-testid="${TID_OAUTH_ERROR}"]`).isExisting()).toBe(false);
    const authState = (values: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(values).filter(
          ([key]) => key.startsWith("oauth:") || key === "zcodejwttoken",
        ),
      );
    expect(authState(await readCredentials())).toEqual(authState(before));
  });

  it("区域切换选择实际登录渠道，中国区仅改写官网中转地址", async () => {
    const baseUrl = process.env.ZCODE_E2E_OAUTH_RACE_URL!;
    const openExternal = await browser.electron.mock("shell", "openExternal");
    await openExternal.mockClear();
    await openExternal.mockResolvedValue(undefined);
    await browser.waitUntil(
      async () =>
        browser.execute(
          (button, trigger) =>
            Boolean(
              document.querySelector(
                `[data-testid="${button}"], [data-testid="${trigger}"], [data-testid="onboarding-page"]`,
              ),
            ),
          TID_OAUTH_LOGIN_BUTTON,
          TID_LOGIN_TRIGGER,
        ),
      { timeout: 60_000 },
    );
    await browser.keys("Escape");
    if (!(await browser.$(`[data-testid="${TID_OAUTH_LOGIN_BUTTON}"]`).isExisting())) {
      // 单独运行本例时从工作区打开登录面板；头像菜单依赖真实 pointerdown。
      for (const trigger of await browser.$$(`[data-testid="${TID_LOGIN_TRIGGER}"]`)) {
        if (await trigger.isDisplayed()) {
          await trigger.click();
          break;
        }
      }
      await clickTestIdByDom(TID_LOGIN_MENU_ITEM);
    }
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    const region = await browser.$(`[data-testid="${TID_LOGIN_REGION_SWITCH}"]`);
    if ((await region.getText()).includes("中国")) await region.click();
    await clickTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    await browser.waitUntil(
      async () => {
        await openExternal.update();
        return openExternal.mock.calls.length === 1;
      },
      { timeout: 10_000 },
    );
    expect((await (await fetch(`${baseUrl}/__e2e/status`)).json()).activeProvider).toBe("zai_cn");
    const openedUrl = String(openExternal.mock.calls[0]?.[0]);
    const authorizeUrl = new URL(openedUrl);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://example.com/cn/authorize");
    expect(authorizeUrl.searchParams.get("state")).toBe("e2e-race");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("e2e-cn-client");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    const bridgeUrl = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
    expect(bridgeUrl.origin).toBe(new URL(baseUrl).origin);
    expect(bridgeUrl.pathname).toBe("/app/oauth/login");
    expect(bridgeUrl.searchParams.get("provider")).toBe("zai_cn");
    expect(bridgeUrl.searchParams.get("redirect")).toBe("zcode://oauth/callback");
    // Mocha 直接导入的版本常量是 0.0.0-dev；桌面构建的注入值来自根 package.json。
    const packageInfo = JSON.parse(
      await readFile(new URL("../../../../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(bridgeUrl.searchParams.get("app_version")).toBe(packageInfo.version);
    await clickTestIdByDom(TID_OAUTH_COPY_LOGIN_LINK);
    await browser.waitUntil(
      async () =>
        (await browser.electron.execute((electron) => electron.clipboard.readText())) === openedUrl,
      { timeout: 10_000, timeoutMsg: "复制的国内授权链接与浏览器打开地址不一致" },
    );
    await clickTestIdByDom(TID_OAUTH_CANCEL);
    await waitForTestIdByDom(TID_LOGIN_REGION_SWITCH);
    await clickTestIdByDom(TID_LOGIN_REGION_SWITCH);
    await clickTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    await browser.waitUntil(
      async () => {
        await openExternal.update();
        return openExternal.mock.calls.length === 2;
      },
      { timeout: 10_000 },
    );
    expect((await (await fetch(`${baseUrl}/__e2e/status`)).json()).activeProvider).toBe("zai");
    await clickTestIdByDom(TID_OAUTH_CANCEL);
    expect((await readCredentials())["oauth:active_provider"]).toBeUndefined();
  });

  it("本地期限先清除 flow 后进入可重试失败态，重新登录后继续等待", async () => {
    const baseUrl = process.env.ZCODE_E2E_OAUTH_RACE_URL!;
    const openExternal = await browser.electron.mock("shell", "openExternal");
    await openExternal.mockClear();
    await openExternal.mockResolvedValue(undefined);
    const readPollRequests = async () =>
      ((await (await fetch(`${baseUrl}/__e2e/status`)).json()) as { pollRequests: number })
        .pollRequests;
    const authState = (values: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(values).filter(
          ([key]) => key.startsWith("oauth:") || key === "zcodejwttoken",
        ),
      );
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    const before = await readCredentials();
    await fetch(`${baseUrl}/__e2e/short-expiry?enabled=true`, { method: "POST" });
    try {
      await clickTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
      await waitForTestIdByDom(TID_OAUTH_COPY_LOGIN_LINK);
      // fixture 挂起首个查询到期限之后，Host 定时器必然先清除 flow；登录页不能继续等待。
      await waitForTestIdByDom(TID_OAUTH_ERROR, { timeout: 15_000 });
      expect(await readPollRequests()).toBe(1);
      expect(authState(await readCredentials())).toEqual(authState(before));

      await fetch(`${baseUrl}/__e2e/short-expiry?enabled=false`, { method: "POST" });
      // 失败块第一个按钮是「重新登录」。新 flow 连续查询后仍在等待；代次隔离由下方 RPC 用例覆盖。
      await browser.$(`[data-testid="${TID_OAUTH_ERROR}"] button`).click();
      await waitForTestIdByDom(TID_OAUTH_COPY_LOGIN_LINK);
      await browser.waitUntil(async () => (await readPollRequests()) >= 2, { timeout: 10_000 });
      expect(await browser.$(`[data-testid="${TID_OAUTH_ERROR}"]`).isExisting()).toBe(false);
      await clickTestIdByDom(TID_OAUTH_CANCEL);
      await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    } finally {
      await fetch(`${baseUrl}/__e2e/short-expiry?enabled=false`, { method: "POST" });
    }
  });

  it("AUTH-07: 浏览器唤起兑换失败后使用已到达的 polling 结果，保留归因", async function () {
    this.timeout(120_000);
    const baseUrl = process.env.ZCODE_E2E_OAUTH_RACE_URL;
    if (!baseUrl) throw new Error("缺少 OAuth race HTTP fixture");
    const openExternal = await browser.electron.mock("shell", "openExternal");
    await openExternal.mockClear();
    await openExternal.mockResolvedValue(undefined);
    await browser.waitUntil(
      async () =>
        browser.execute(
          (button, trigger) =>
            Boolean(
              document.querySelector(
                `[data-testid="${button}"], [data-testid="${trigger}"], [data-testid="onboarding-page"]`,
              ),
            ),
          TID_OAUTH_LOGIN_BUTTON,
          TID_LOGIN_TRIGGER,
        ),
      { timeout: 60_000 },
    );
    // 新用户引导覆盖登录面板，使用正常 Escape 交互关闭，不修改产品状态。
    await browser.keys("Escape");
    const hasButton = await browser.execute(
      (id) => Boolean(document.querySelector(`[data-testid="${id}"]`)),
      TID_OAUTH_LOGIN_BUTTON,
    );
    if (!hasButton) {
      // Radix 菜单依赖 pointerdown；原生 WebDriver click 会派发完整指针事件。
      const triggers = await browser.$$(`[data-testid="${TID_LOGIN_TRIGGER}"]`);
      for (const trigger of triggers) {
        if (await trigger.isDisplayed()) {
          await trigger.click();
          break;
        }
      }
      await clickTestIdByDom(TID_LOGIN_MENU_ITEM);
    }
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    const privateMethodsAreHidden = await browser.execute(async (buttonId) => {
      const element = document.querySelector(`[data-testid="${buttonId}"]`)!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const value = fiber.memoizedProps?.value;
        const services = value?.credentialService ? value : fiber.memoizedProps?.services;
        if (services?.credentialService) {
          try {
            await services.credentialService.loadMany(["bot:e2e:private-probe"]);
            return false;
          } catch (error) {
            if (!String(error).includes("Method not found: loadMany")) return false;
            try {
              await services.credentialService.load("oauth:linked_bigmodel");
              return false;
            } catch (privateError) {
              return String(privateError).includes("Host private credential");
            }
          }
        }
        fiber = fiber.return;
      }
      throw new Error("Missing credential RPC accessor");
    }, TID_OAUTH_LOGIN_BUTTON);
    expect(privateMethodsAreHidden).toBe(true);
    const originalProvider = (await readCredentials())["oauth:active_provider"];
    const credentialSnapshots: Record<string, string>[] = [];
    const snapshotReads: Promise<void>[] = [];
    const credentialsFile = getE2EAppDataPaths().credentialsFile;
    credentialWatcher = watch(dirname(credentialsFile), (_event, filename) => {
      if (filename !== basename(credentialsFile)) return;
      snapshotReads.push(
        readCredentials().then((snapshot) => {
          credentialSnapshots.push(snapshot);
        }),
      );
    });
    await clickTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    await browser.waitUntil(
      async () => {
        await openExternal.update();
        return openExternal.mock.calls.length > 0;
      },
      {
        timeout: 20_000,
      },
    );
    const authorizationUrl = openExternal.mock.calls[0]?.[0];
    expect(authorizationUrl).toContain(
      "https://example.com/authorize?state=e2e-race&channel_id=desktop-launch",
    );
    await clickTestIdByDom(TID_OAUTH_COPY_LOGIN_LINK);
    await browser.waitUntil(
      async () =>
        (await browser.electron.execute((electron) => electron.clipboard.readText())) ===
        authorizationUrl,
      { timeout: 10_000, timeoutMsg: "等待态复制登录链接失败" },
    );
    // 先验证兑换等待期间取消：Host 返回 null，Root 不应把正常取消当作失败或登录成功。
    await browser.electron.execute((electron, channel) => {
      electron.BrowserWindow.getAllWindows()[0]!.webContents.send(
        channel,
        "zcode://oauth/callback?state=e2e-race&authCode=cancelled",
      );
    }, PlatformChannels.OAuthCallback);
    await browser.waitUntil(
      async () => {
        const status = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
          tokenRequests: number;
        };
        return status.tokenRequests === 1;
      },
      { timeout: 20_000 },
    );
    await clickTestIdByDom(TID_OAUTH_CANCEL);
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    await fetch(`${baseUrl}/__e2e/complete-token`, { method: "POST" });
    // 等待真实 RPC 回调完成后再发起下一次登录，避免新登录掩盖取消的 UI 结果。
    const logDir = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
    if (!logDir) throw new Error("缺少 E2E 日志目录");
    await browser.waitUntil(
      async () => {
        const files = (await readdir(logDir)).filter((file) => file.endsWith(".log"));
        const logs = await Promise.all(files.map((file) => readFile(join(logDir, file), "utf8")));
        return logs.some((log) => log.includes("oauth.handleCallback OK"));
      },
      { timeout: 10_000 },
    );
    const runtimeLogs = await Promise.all(
      (await readdir(logDir))
        .filter((file) => file.endsWith(".log"))
        .map((file) => readFile(join(logDir, file), "utf8")),
    );
    const combinedLogs = runtimeLogs.join("\n");
    expect(combinedLogs).toContain("token final response");
    expect(combinedLogs).not.toContain("e2e-associated-bigmodel-secret");
    expect(combinedLogs).not.toContain("e2e-response-extension-secret");
    await browser.executeAsync((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => done()));
    });
    const cancelledCredentials = await readCredentials();
    expect(cancelledCredentials["oauth:active_provider"]).toBe(originalProvider);
    expect(cancelledCredentials["oauth:zai:access_token"]).toBeUndefined();
    expect(await browser.$(`[data-testid="${TID_OAUTH_ERROR}"]`).isExisting()).toBe(false);
    await fetch(`${baseUrl}/__e2e/enable-poll`, { method: "POST" });
    await clickTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    await browser.waitUntil(
      async () => {
        await openExternal.update();
        return openExternal.mock.calls.length > 1;
      },
      { timeout: 20_000 },
    );
    // 真实 preload → Root → Host；只有浏览器外部打开被拦截，登录服务不 mock。
    await browser.electron.execute((electron, channel) => {
      electron.BrowserWindow.getAllWindows()[0]!.webContents.send(
        channel,
        "zcode://oauth/callback?state=e2e-race&authCode=e2e-code&channel_id=desktop&utm_source=website&utm_campaign=race",
      );
    }, PlatformChannels.OAuthCallback);
    await browser.waitUntil(
      async () => {
        const status = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
          readyResponses: number;
        };
        return status.readyResponses > 0;
      },
      { timeout: 20_000, timeoutMsg: "兑换挂起期间没有收到 polling ready" },
    );
    await fetch(`${baseUrl}/__e2e/fail-token`, { method: "POST" });
    await browser.waitUntil(
      async () => (await readCredentials())["oauth:active_provider"] === "zai",
      { timeout: 20_000, timeoutMsg: "回调失败导致 polling 登录未完成" },
    );
    await browser.waitUntil(
      async () =>
        browser.execute(
          (id) => !document.querySelector(`[data-testid="${id}"]`),
          TID_OAUTH_LOGIN_BUTTON,
        ),
      { timeout: 20_000, timeoutMsg: "登录成功后未离开登录面板" },
    );
    expect(
      await browser.execute(
        (id) => Boolean(document.querySelector(`[data-testid="${id}"]`)),
        TID_OAUTH_ERROR,
        TID_OAUTH_CANCEL,
      ),
    ).toBe(false);
    const credentials = await readCredentials();
    expect(credentials["oauth:zai:access_token"]).toBe("e2e-race-business");
    expect(JSON.parse(credentials["oauth:login_attribution"]!)).toEqual({
      channel_id: "desktop",
      utm_source: "website",
      utm_campaign: "race",
    });
    // polling 已成功后，迟到回调只更新归因，不能再次兑换授权码。
    await browser.electron.execute((electron, channel) => {
      electron.BrowserWindow.getAllWindows()[0]!.webContents.send(
        channel,
        "zcode://oauth/callback?state=e2e-race&authCode=late&channel_id=desktop&utm_source=website&utm_campaign=late",
      );
    }, PlatformChannels.OAuthCallback);
    await browser.waitUntil(
      async () =>
        JSON.parse((await readCredentials())["oauth:login_attribution"] ?? "{}").utm_campaign ===
        "late",
      { timeout: 10_000 },
    );
    const status = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
      tokenRequests: number;
    };
    expect(status.tokenRequests).toBe(1);
    credentialWatcher.close();
    await Promise.all(snapshotReads);
    // 监听真实文件替换，不能仅凭最后一次读取完整就认定提交期间没有半份登录态。
    expect(credentialSnapshots.length).toBeGreaterThan(0);
    credentialSnapshots.push(await readCredentials());
    for (const snapshot of credentialSnapshots) {
      if (!snapshot["oauth:zai:access_token"]) continue;
      expect(snapshot["oauth:active_provider"]).toBe("zai");
      expect(snapshot["zcodejwttoken"]).toBe("e2e-race-jwt");
      expect(snapshot["oauth:zai:user_info"]).toBeTruthy();
      expect(snapshot["oauth:bigmodel:access_token"]).toBeUndefined();
    }
  });

  it("先到兑换慢成功不被后到轮询快失败取消", async () => {
    const baseUrl = process.env.ZCODE_E2E_OAUTH_RACE_URL!;
    const logDir = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
    if (!logDir) throw new Error("缺少 E2E 日志目录");
    const failureCount = async () => {
      const logs = await Promise.all(
        (await readdir(logDir))
          .filter((file) => file.endsWith(".log"))
          .map((file) => readFile(join(logDir, file), "utf8")),
      );
      return logs.join("\n").split("OAuth completion candidate failed").length;
    };
    const failuresBefore = await failureCount();
    await fetch(`${baseUrl}/__e2e/fail-poll`, { method: "POST" });
    // 前两条覆盖 UI；本条通过真实 Renderer→Host RPC 固定双路径时序，不替换登录实现。
    await browser.execute(async (id) => {
      const element = document.querySelector(`[data-testid="${id}"]`)!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const value = fiber.memoizedProps?.value;
        const services = value?.oauthService ? value : fiber.memoizedProps?.services;
        if (services?.oauthService) {
          const service = services.oauthService;
          await service.startOAuthWithPolling("zai");
          const state = window as any;
          state.__oauthRaceService = service;
          state.__oauthRaceExchange = service.handleCallback(
            "zcode://oauth/callback?state=e2e-race&authCode=slow-success",
          );
          return;
        }
        fiber = fiber.return;
      }
      throw new Error("Missing OAuth RPC accessor");
    }, TID_LOGIN_TRIGGER);
    await browser.waitUntil(
      async () => {
        const status = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
          tokenRequests: number;
        };
        return status.tokenRequests === 1;
      },
      { timeout: 10_000 },
    );
    await browser.execute(() => {
      const state = window as any;
      state.__oauthRacePoll = state.__oauthRaceService.pollPendingOAuth();
    });
    // 日志屏障证明轮询失败已由 Host 处理，再释放成功兑换，避免请求到达后抢跑。
    await browser.waitUntil(async () => (await failureCount()) > failuresBefore, {
      timeout: 15_000,
    });
    await fetch(`${baseUrl}/__e2e/complete-token`, { method: "POST" });
    const results = await browser.execute(async () => {
      const state = window as any;
      try {
        return (await Promise.all([state.__oauthRaceExchange, state.__oauthRacePoll])).map(
          (result: { kind: string } | null) => result?.kind,
        );
      } finally {
        delete state.__oauthRaceService;
        delete state.__oauthRaceExchange;
        delete state.__oauthRacePoll;
      }
    });
    expect(results).toEqual(["session", "duplicate"]);
    expect((await readCredentials())["zcodejwttoken"]).toBe("cancelled-jwt");
  });

  it("旧 flow 本地期限过期后，新 flow 由回调完成，后续查询不按旧期限报过期", async () => {
    const baseUrl = process.env.ZCODE_E2E_OAUTH_RACE_URL!;
    await fetch(`${baseUrl}/__e2e/short-expiry?enabled=true`, { method: "POST" });
    try {
      // 真实 Renderer→Host RPC 固定顺序：首个查询挂起到期限之后，Host 定时器先清除旧 flow。
      const expired = await browser.execute(async (id) => {
        const element = document.querySelector(`[data-testid="${id}"]`)!;
        let fiber = (element as any)[
          Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
        ];
        while (fiber) {
          const value = fiber.memoizedProps?.value;
          const services = value?.oauthService ? value : fiber.memoizedProps?.services;
          if (services?.oauthService) {
            const service = services.oauthService;
            (window as any).__oauthExpiryService = service;
            await service.startOAuthWithPolling("zai");
            const held = await service.pollPendingOAuth();
            try {
              return { held, next: await service.pollPendingOAuth() };
            } catch (error) {
              return { held, nextError: String(error) };
            }
          }
          fiber = fiber.return;
        }
        throw new Error("Missing OAuth RPC accessor");
      }, TID_LOGIN_TRIGGER);
      expect(expired).toEqual({
        held: null,
        nextError: expect.stringContaining("OAuth flow 已过期"),
      });

      await fetch(`${baseUrl}/__e2e/short-expiry?enabled=false`, { method: "POST" });
      await browser.execute(async () => {
        const state = window as any;
        await state.__oauthExpiryService.startOAuthWithPolling("zai");
        state.__oauthExpiryExchange = state.__oauthExpiryService.handleCallback(
          "zcode://oauth/callback?state=e2e-race&authCode=after-expiry",
        );
      });
      await browser.waitUntil(
        async () =>
          ((await (await fetch(`${baseUrl}/__e2e/status`)).json()) as { tokenRequests: number })
            .tokenRequests === 1,
        { timeout: 10_000 },
      );
      await fetch(`${baseUrl}/__e2e/complete-token`, { method: "POST" });
      // 回调兑换提交会清除 pending 但不推进代次；旧期限只属于旧代次，空 pending 不能被报成过期。
      const completed = await browser.execute(async () => {
        const state = window as any;
        const exchange = (await state.__oauthExpiryExchange)?.kind;
        try {
          return { exchange, poll: await state.__oauthExpiryService.pollPendingOAuth() };
        } catch (error) {
          return { exchange, pollError: String(error) };
        }
      });
      expect(completed).toEqual({ exchange: "session", poll: null });
    } finally {
      await fetch(`${baseUrl}/__e2e/short-expiry?enabled=false`, { method: "POST" });
      await browser.execute(() => {
        delete (window as any).__oauthExpiryService;
        delete (window as any).__oauthExpiryExchange;
      });
    }
  });
  for (const [mode, title] of [
    ["backward", "系统时间回拨后继续轮询"],
    ["forward", "系统时间前跳后仍拒绝过期流程"],
    ["expired-init", "已过期的初始化响应仍拒绝启动"],
  ] as const) {
    it(title, async () => {
      const baseUrl = process.env.ZCODE_E2E_OAUTH_RACE_URL!;
      const originalHandle = await browser.getWindowHandle();
      const credentialsFile = getE2EAppDataPaths().credentialsFile;
      const originalCredentials = await readFile(credentialsFile, "utf8");
      const originalWindowIds = await browser.electron.execute((electron) =>
        electron.BrowserWindow.getAllWindows().map((window) => window.id),
      );
      const openExternal = await browser.electron.mock("shell", "openExternal");
      await openExternal.mockResolvedValue(undefined);
      const clockCaseId = `oauth-clock-${mode}-${randomUUID()}`;
      const cleanupErrors: unknown[] = [];
      let status: unknown;
      try {
        await fetch(`${baseUrl}/__e2e/clock/${mode}`, { method: "POST" });
        // 新窗口先以未登录 UI 启动，再恢复原凭据供真实登录 CAS 校验，不模拟 OAuth 服务。
        await writeFile(credentialsFile, "{}", "utf8");
        await openFaultInjectedHostWindow(
          fileURLToPath(new URL("../../helpers/oauth-polling-clock-faults.cjs", import.meta.url)),
          { ZCODE_E2E_OAUTH_CLOCK_CASE: clockCaseId },
        );
        await browser.waitUntil(
          async () => {
            if (await browser.$('[data-testid="onboarding-page"]').isExisting()) {
              await browser.keys("Escape");
            }
            return browser.execute(
              (button, trigger) =>
                Boolean(
                  document.querySelector(`[data-testid="${button}"], [data-testid="${trigger}"]`),
                ),
              TID_OAUTH_LOGIN_BUTTON,
              TID_LOGIN_TRIGGER,
            );
          },
          { timeout: 30000 },
        );
        await writeFile(credentialsFile, originalCredentials, "utf8");
        if (!(await browser.$(`[data-testid="${TID_OAUTH_LOGIN_BUTTON}"]`).isExisting())) {
          await browser.$(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
          await clickTestIdByDom(TID_LOGIN_MENU_ITEM);
        }
        await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
        const before = await readCredentials();
        await clickTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
        if (mode !== "expired-init") {
          await browser.waitUntil(
            async () => {
              await openExternal.update();
              return openExternal.mock.calls.length > 0;
            },
            { timeout: 10000, timeoutMsg: "本例 openExternal mock 未拦截登录地址" },
          );
          // 网络出口若绕过 fetch 劫持，必须在此失败，不能把未注入的正常登录当成回拨验证。
          await waitForHostBoundary("clock-shift", clockCaseId);
          const shifts = (await readHostBoundary()).filter(
            (event) => event.kind === "clock-shift" && event.id === clockCaseId,
          );
          expect(shifts).toHaveLength(1);
          expect(shifts[0]?.offset).toBe(mode === "backward" ? -172800000 : 172800000);
        }
        if (mode === "backward") {
          await browser.waitUntil(
            async () => {
              // 单入口已使用全球区渠道；验证主会话完成，不能继续等待旧 BigModel 专属槽位。
              const credentials = await readCredentials();
              return (
                credentials["zcodejwttoken"] === "e2e-clock-jwt" &&
                credentials["oauth:active_provider"] === "zai"
              );
            },
            { timeout: 15000, timeoutMsg: "回拨系统时间后未继续 polling 并完成登录" },
          );
          const status = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
            pollRequests: number;
          };
          expect(status.pollRequests).toBe(2);
        } else {
          await waitForTestIdByDom(TID_OAUTH_ERROR, { timeout: 15000 });
          expect(await readCredentials()).toEqual(before);
          const status = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
            pollRequests: number;
          };
          expect(status.pollRequests).toBe(mode === "expired-init" ? 0 : 1);
          if (mode === "expired-init") {
            expect(
              (await readHostBoundary()).filter(
                (event) => event.kind === "clock-shift" && event.id === clockCaseId,
              ),
            ).toHaveLength(0);
          }
        }
      } finally {
        // 开窗可能在返回 ID 前失败，按初始窗口集合收口；取证和单项清理失败不能阻断后续恢复。
        const attempt = async (action: () => Promise<unknown>) => {
          try {
            await action();
          } catch (error) {
            cleanupErrors.push(error);
          }
        };
        await attempt(async () => {
          status = await (await fetch(`${baseUrl}/__e2e/status`)).json();
        });
        await attempt(() =>
          browser.electron.execute(async (electron, ids) => {
            await Promise.all(
              electron.BrowserWindow.getAllWindows()
                .filter((window) => !ids.includes(window.id))
                .map(
                  (window) =>
                    new Promise<void>((resolve) => {
                      // macOS 的 close 会隐藏窗口；夹具销毁仅本例新窗口，并等 closed 触发 Host 回收。
                      window.once("closed", resolve);
                      window.destroy();
                    }),
                ),
            );
          }, originalWindowIds),
        );
        await attempt(() => writeFile(credentialsFile, originalCredentials, "utf8"));
        await attempt(() => browser.switchToWindow(originalHandle));
        await attempt(() => fetch(`${baseUrl}/__e2e/clock/reset`, { method: "POST" }));
        await attempt(() => openExternal.mockRestore());
        await attempt(() =>
          writeFile(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `oauth-clock-${mode}.json`),
            JSON.stringify({ status, cleanupErrors: cleanupErrors.map(String) }),
          ),
        );
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "时钟场景清理或取证失败");
    });
  }
  it("中国区保存一个主体及关联 BigModel，不使用全球区业务换证", async () => {
    const baseUrl = process.env.ZCODE_E2E_OAUTH_RACE_URL!;
    const before = await (await fetch(`${baseUrl}/__e2e/status`)).json();
    await fetch(`${baseUrl}/__e2e/cn-ready?ready=false`, { method: "POST" });
    const callback = await browser.execute(async (id) => {
      const element = document.querySelector(`[data-testid="${id}"]`)!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const value = fiber.memoizedProps?.value;
        const services = value?.oauthService ? value : fiber.memoizedProps?.services;
        if (services?.oauthService) {
          (window as any).__cnOAuth = services.oauthService;
          await services.oauthService.startOAuthWithPolling("zai_cn");
          // 中转先唤起 App，带授权码的回调也不能触发客户端二次兑换。
          return services.oauthService.handleCallback(
            "zcode://oauth/callback?code=cn-bridge-code&state=e2e-race&channel_id=e2e-cn-bridge",
          );
        }
        fiber = fiber.return;
      }
      throw new Error("Missing OAuth RPC accessor");
    }, TID_LOGIN_TRIGGER);
    expect(callback).toBeNull();
    expect(
      await browser.execute(async () =>
        (window as any).__cnOAuth.handleCallback(
          "zcode://oauth/callback?code=cn-bridge-code&state=e2e-race",
        ),
      ),
    ).toBeNull();
    expect((await (await fetch(`${baseUrl}/__e2e/status`)).json()).tokenRequests).toBe(0);
    await fetch(`${baseUrl}/__e2e/cn-ready`, { method: "POST" });
    const result = await browser.execute(async () => (window as any).__cnOAuth.pollPendingOAuth());
    expect(result).toMatchObject({
      kind: "session",
      provider: "zai_cn",
      userInfo: { id: "e2e-cn-zcode-user" },
    });
    const credentials = await readCredentials();
    expect(credentials["oauth:active_provider"]).toBe("zai_cn");
    expect(JSON.parse(credentials["oauth:login_attribution"]!).channel_id).toBe("e2e-cn-bridge");
    const lateCallback = await browser.execute(async () =>
      (window as any).__cnOAuth.handleCallback(
        "zcode://oauth/callback?code=cn-late-code&state=e2e-race&channel_id=e2e-cn-late",
      ),
    );
    expect(lateCallback).toMatchObject({ kind: "duplicate", provider: "zai_cn" });
    credentials["oauth:login_attribution"] = (await readCredentials())["oauth:login_attribution"]!;
    expect(JSON.parse(credentials["oauth:login_attribution"]!).channel_id).toBe("e2e-cn-late");
    expect(credentials["oauth:zai_cn:access_token"]).toBe("e30.eyJleHAiOjF9.signature");
    expect(credentials["oauth:zai:access_token"]).toBeUndefined();
    expect(credentials["oauth:bigmodel:access_token"]).toBeUndefined();
    expect(JSON.parse(credentials["oauth:linked_bigmodel"]!)).toEqual({
      userId: "e2e-cn-zcode-user",
      customerId: "e2e-linked-customer",
      accessToken: "e2e-linked-jwt-secret",
    });
    expect((await (await fetch(`${baseUrl}/__e2e/status`)).json()).businessExchanges).toBe(
      before.businessExchanges,
    );
    expect((await (await fetch(`${baseUrl}/__e2e/status`)).json()).tokenRequests).toBe(0);
    expect(
      await browser.execute(
        async () => (await (window as any).__cnOAuth.restoreCachedSessionState()).status,
      ),
    ).toBe("authenticated");
    for (const mode of ["unauthorized", "mismatch"]) {
      await fetch(`${baseUrl}/__e2e/profile-mode?mode=${mode}`, { method: "POST" });
      const failed = await browser.execute(async () => {
        try {
          await (window as any).__cnOAuth.restoreSession();
          return false;
        } catch {
          return true;
        }
      });
      expect(failed).toBe(true);
      expect(await readCredentials()).toEqual(credentials);
    }
    // 只损坏附属凭据。恢复应清理该键，不得丢弃仍有效的 ZCode 身份。
    const stored = JSON.parse(await readFile(getE2EAppDataPaths().credentialsFile, "utf8"));
    stored["oauth:linked_bigmodel"] = "enc:v1:broken-associated-token";
    await writeFile(getE2EAppDataPaths().credentialsFile, JSON.stringify(stored));
    expect(
      await browser.execute(
        async () => (await (window as any).__cnOAuth.restoreCachedSessionState()).status,
      ),
    ).toBe("authenticated");
    const recovered = await readCredentials();
    expect(recovered["oauth:linked_bigmodel"]).toBeUndefined();
    expect(recovered["zcodejwttoken"]).toBe(credentials["zcodejwttoken"]);
    const cancelledCallback = await browser.execute(async () => {
      const service = (window as any).__cnOAuth;
      await service.startOAuthWithPolling("zai_cn");
      await service.cancelPending("zai_cn");
      try {
        await service.handleCallback(
          "zcode://oauth/callback?code=cn-cancelled&state=e2e-race&channel_id=cancelled",
        );
        return false;
      } catch {
        return true;
      }
    });
    expect(cancelledCallback).toBe(true);
    expect(await readCredentials()).toEqual(recovered);
    expect((await (await fetch(`${baseUrl}/__e2e/status`)).json()).tokenRequests).toBe(0);
    await browser.execute(() => {
      delete (window as any).__cnOAuth;
    });
  });
  it("补关联只更新同一主体，缺失/失败保留旧状态，退出丢弃在途结果", async () => {
    const baseUrl = process.env.ZCODE_E2E_OAUTH_RACE_URL!;
    await fetch(`${baseUrl}/__e2e/profile-mode?mode=linked`, { method: "POST" });
    const projected = await browser.execute(async (id) => {
      const element = document.querySelector(`[data-testid="${id}"]`)!;
      let fiber = (element as any)[
        Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
      ];
      while (fiber) {
        const value = fiber.memoizedProps?.value;
        const services = value?.oauthService ? value : fiber.memoizedProps?.services;
        if (services?.oauthService) {
          (window as any).__profileOAuth = services.oauthService;
          return services.oauthService.refreshAccountProfile();
        }
        fiber = fiber.return;
      }
      throw new Error("Missing OAuth RPC accessor");
    }, TID_LOGIN_TRIGGER);
    expect(projected).toMatchObject({
      loginProvider: "zai_cn",
      userId: "e2e-cn-zcode-user",
      families: ["bigmodel"],
    });
    expect(JSON.stringify(projected)).not.toContain("secret");
    const before = await readCredentials();
    await fetch(`${baseUrl}/__e2e/profile-mode?mode=valid`, { method: "POST" });
    await browser.execute(async () => (window as any).__profileOAuth.refreshAccountProfile());
    expect(await readCredentials()).toEqual(before);
    await fetch(`${baseUrl}/__e2e/profile-mode?mode=unauthorized`, { method: "POST" });
    expect(
      await browser.execute(async () => {
        try {
          await (window as any).__profileOAuth.refreshAccountProfile();
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    expect(await readCredentials()).toEqual(before);
    await fetch(`${baseUrl}/__e2e/profile-mode?mode=linked-next`, { method: "POST" });
    await fetch(`${baseUrl}/__e2e/profile-hold?held=true`, { method: "POST" });
    const requestsBefore = (await (await fetch(`${baseUrl}/__e2e/status`)).json()).profileRequests;
    await browser.execute(() => {
      const state = window as any;
      state.__profilePending = Promise.all([
        state.__profileOAuth.refreshAccountProfile(),
        state.__profileOAuth.refreshAccountProfile(),
      ]);
    });
    await browser.waitUntil(
      async () =>
        (await (await fetch(`${baseUrl}/__e2e/status`)).json()).profileRequests > requestsBefore,
      { timeout: 10_000 },
    );
    expect((await (await fetch(`${baseUrl}/__e2e/status`)).json()).profileRequests).toBe(
      requestsBefore + 1,
    );
    await browser.execute(async () => (window as any).__profileOAuth.logoutAll());
    await fetch(`${baseUrl}/__e2e/profile-hold?held=false`, { method: "POST" });
    const results = await browser.execute(async () => {
      const state = window as any;
      try {
        return await state.__profilePending;
      } finally {
        delete state.__profilePending;
        delete state.__profileOAuth;
      }
    });
    expect(
      results.every((value: { loginProvider: string | null }) => value.loginProvider === null),
    ).toBe(true);
    const after = await readCredentials();
    expect(after["oauth:active_provider"]).toBeUndefined();
    expect(after["oauth:linked_bigmodel"]).toBeUndefined();
  });
});

describe("Global 主体恢复边界", () => {
  it("Global显式恢复只补展示，不把上游sub写成ZCode主ID", async function () {
    this.timeout(90_000);
    const baseUrl = process.env.ZCODE_E2E_OAUTH_RACE_URL!;
    await fetch(`${baseUrl}/__e2e/global-subject-probe?enabled=true`, { method: "POST" });
    const file = getE2EAppDataPaths().credentialsFile;
    await writeFile(
      file,
      JSON.stringify({
        "oauth:active_provider": "zai",
        "oauth:session_revision": "global-subject-original",
        "oauth:zai:access_token": "global-business-token",
        zcodejwttoken: "global-primary-token",
        "oauth:zai:user_info": JSON.stringify({
          user_id: "canonical-global-user",
          name: "Original Global Display",
        }),
      }),
    );
    await browser.reloadSession();
    try {
      await browser.waitUntil(
        async () =>
          browser.execute(
            (id) =>
              !!document.querySelector(
                `[data-testid="${id}"], [data-testid="onboarding-page"], [data-testid="oauth-login-button"]`,
              ),
            TID_LOGIN_TRIGGER,
          ),
        { timeout: 30_000 },
      );
      const result = await browser.execute(async (id) => {
        const element = document.querySelector(
          `[data-testid="${id}"], [data-testid="onboarding-page"], [data-testid="oauth-login-button"]`,
        )!;
        let fiber = (element as any)[
          Object.keys(element).find((key) => key.startsWith("__reactFiber"))!
        ];
        while (fiber) {
          const value = fiber.memoizedProps?.value;
          const services = value?.oauthService ? value : fiber.memoizedProps?.services;
          if (services?.oauthService)
            return {
              cached: await services.oauthService.restoreCachedSession(),
              restored: await services.oauthService.restoreSession(),
            };
          fiber = fiber.return;
        }
        throw new Error("Missing OAuth accessor");
      }, TID_LOGIN_TRIGGER);
      expect(result.cached?.id).toBe("canonical-global-user");
      expect(result.restored).toMatchObject({
        id: "canonical-global-user",
        displayName: "Updated Global Display",
      });
    } finally {
      await fetch(`${baseUrl}/__e2e/global-subject-probe?enabled=false`, { method: "POST" });
      await clearAppData();
    }
  });
});

async function readCredentials(): Promise<Record<string, string>> {
  const stored = JSON.parse(await readFile(getE2EAppDataPaths().credentialsFile, "utf8")) as Record<
    string,
    string
  >;
  const cipher = createSystemCredentialCipher({
    filePath: getE2EAppDataPaths().credentialsFile,
    env: { ZCODE_CREDENTIAL_SECRET: "oauth-completion-race-fixture" },
  });
  return Object.fromEntries(
    await Promise.all(
      Object.entries(stored).map(async ([name, value]) => [name, await cipher.decrypt(value)]),
    ),
  );
}
