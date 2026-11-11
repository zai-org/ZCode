import { readFile, writeFile } from "node:fs/promises";
import { readE2ECredentialValue } from "#e2e/helpers/desktop-app";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import {
  TID_LOGIN_REGION_SWITCH,
  TID_LOGIN_TRIGGER,
  TID_LOGIN_MENU_ITEM,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
  TID_OAUTH_ERROR,
  TID_OAUTH_LOGIN_BUTTON,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";

const OAUTH_CREDENTIAL_KEYS = [
  "oauth:active_provider",
  `oauth:${ZAI_PROVIDER_ID}:access_token`,
  `oauth:${ZAI_PROVIDER_ID}:refresh_token`,
  `oauth:${ZAI_PROVIDER_ID}:user_info`,
  `oauth:${BIGMODEL_PROVIDER_ID}:access_token`,
  `oauth:${BIGMODEL_PROVIDER_ID}:refresh_token`,
  `oauth:${BIGMODEL_PROVIDER_ID}:user_info`,
  "zcodejwttoken",
] as const;

describe("OAuth 凭据损坏恢复", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("冷启动遇到无法解密的 OAuth 凭据时仍展示登录渠道并清理损坏登录态", async () => {
    await ensureOAuthLoginPanelOpen();
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON, {
      timeout: 20000,
      timeoutMsg: "损坏 OAuth 凭据恢复后没有展示登录入口",
    });
    await waitForTestIdByDom(TID_LOGIN_REGION_SWITCH, {
      timeout: 20000,
      timeoutMsg: "损坏 OAuth 凭据恢复后没有展示中国/全球切换入口",
    });
    await expectNoOAuthErrorAlert();
    await waitForCorruptOAuthCredentialsCleanup();
    expect(await readE2ECredentialValue("bot:e2e:credential")).toBe("e2e-independent-bot-token");
  });

  for (const [label, contents] of [
    ["非法 JSON", '{"oauth:active_provider":'],
    ["值类型不符", '{"oauth:active_provider":42}'],
  ] as const) {
    it(`凭据库${label}时保留渠道且不改写原文件`, async () => {
      const { credentialsFile } = getE2EAppDataPaths();
      const original = await readFile(credentialsFile, "utf-8");
      try {
        await clickTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON);
        await clickTestIdByDom(TID_LOGIN_API_KEY_SKIP_BUTTON);
        await browser.waitUntil(async () =>
          browser.execute(() =>
            Boolean(
              document.querySelector(
                '[data-testid="onboarding-page"], [data-testid="login-trigger"]',
              ),
            ),
          ),
        );
        if (await browser.$('[data-testid="onboarding-page"]').isExisting()) {
          await browser.keys("Escape");
        }
        await waitForTestIdByDom(TID_LOGIN_TRIGGER);
        await writeFile(credentialsFile, contents, "utf-8");
        await ensureOAuthLoginPanelOpen();
        // 登录入口已收敛；凭据库损坏时仍需展示单按钮及区域切换，不依赖旧 provider 后缀。
        await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON, {
          timeout: 10000,
          timeoutMsg: "凭据库读取失败后丢失登录渠道",
        });
        await waitForTestIdByDom(TID_LOGIN_REGION_SWITCH);
        await expectNoOAuthErrorAlert();
        expect(await readFile(credentialsFile, "utf-8")).toBe(contents);
      } finally {
        await writeFile(credentialsFile, original, "utf-8");
      }
    });
  }
});

async function expectNoOAuthErrorAlert() {
  const errorText = (await browser.execute((testId) => {
    return (
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.textContent?.trim() ?? null
    );
  }, TID_OAUTH_ERROR)) as string | null;

  expect(errorText).toBeNull();
}

async function waitForCorruptOAuthCredentialsCleanup() {
  try {
    await browser.waitUntil(
      async () => {
        const credentials = await readCredentials();
        return OAUTH_CREDENTIAL_KEYS.every((key) => !(key in credentials));
      },
      {
        timeout: 10000,
        timeoutMsg: "损坏 OAuth 凭据没有被清理",
      },
    );
  } catch (error) {
    const credentials = await readCredentials().catch(() => null);
    const keys = credentials ? Object.keys(credentials).sort().join(", ") : "<missing>";
    throw new Error(`损坏 OAuth 凭据没有被清理，当前凭据 key: ${keys}`, {
      cause: error,
    });
  }
}

async function ensureOAuthLoginPanelOpen() {
  const loginButtonId = TID_OAUTH_LOGIN_BUTTON;

  try {
    await browser.waitUntil(
      async () => {
        const state = await readLoginEntryState(loginButtonId);
        return state.hasLoginButton || state.hasLoginTrigger;
      },
      {
        timeout: 60000,
        timeoutMsg: "启动后没有出现 OAuth 登录面板或手动登录入口",
      },
    );
  } catch (error) {
    throw new Error(
      await buildLoginEntryTimeoutMessage("启动后没有出现 OAuth 登录面板或手动登录入口"),
      {
        cause: error,
      },
    );
  }

  const state = await readLoginEntryState(loginButtonId);
  if (state.hasLoginButton) {
    return;
  }

  // Bugfix: OAuth 凭据恢复 spec 只要求用户重新登录入口可用；当启动期已有可用
  // workspace shell 时，登录面板需要从 sidebar 手动打开，不能把“未自动弹 WelcomeScreen”
  // 误判为恢复失败。
  await waitForTestIdByDom(TID_LOGIN_TRIGGER, {
    timeout: 20000,
    timeoutMsg: "损坏 OAuth 凭据恢复后没有可点击的手动登录入口",
  });
  await browser.$(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
  await browser.waitUntil(async () =>
    browser.execute(
      (menu, button) =>
        Boolean(document.querySelector(`[data-testid="${menu}"], [data-testid="${button}"]`)),
      TID_LOGIN_MENU_ITEM,
      loginButtonId,
    ),
  );
  const menuItem = await browser.$(`[data-testid="${TID_LOGIN_MENU_ITEM}"]`);
  if (await menuItem.isExisting()) await clickTestIdByDom(TID_LOGIN_MENU_ITEM);
}

async function readLoginEntryState(loginButtonId: string): Promise<{
  hasLoginTrigger: boolean;
  hasLoginButton: boolean;
}> {
  return (await browser.execute(
    (loginTriggerId, currentLoginButtonId) => {
      return {
        hasLoginTrigger: Boolean(document.querySelector(`[data-testid="${loginTriggerId}"]`)),
        hasLoginButton: Boolean(document.querySelector(`[data-testid="${currentLoginButtonId}"]`)),
      };
    },
    TID_LOGIN_TRIGGER,
    loginButtonId,
  )) as {
    hasLoginTrigger: boolean;
    hasLoginButton: boolean;
  };
}

async function buildLoginEntryTimeoutMessage(prefix: string) {
  const snapshot = await readOAuthRecoveryDomSnapshot().catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  return `${prefix}: ${JSON.stringify(snapshot)}`;
}

async function readOAuthRecoveryDomSnapshot() {
  return browser.execute(() => {
    const testIds = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
      .map((element) => element.dataset.testid ?? "")
      .filter(Boolean)
      .slice(0, 40);
    return {
      testIds,
      title: document.title,
      text: document.body.textContent?.replace(/\s+/g, " ").trim().slice(0, 600) ?? "",
      url: window.location.href,
    };
  });
}

async function readCredentials(): Promise<Record<string, string>> {
  const { credentialsFile } = getE2EAppDataPaths();
  return JSON.parse(await readFile(credentialsFile, "utf-8")) as Record<string, string>;
}
