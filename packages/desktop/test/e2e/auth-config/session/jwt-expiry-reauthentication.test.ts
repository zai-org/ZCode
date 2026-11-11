import { readFile } from "node:fs/promises";
import { ZAI_PROVIDER_ID } from "@zcode/shared";
import { TID_LOGIN_REGION_SWITCH, TID_OAUTH_LOGIN_BUTTON } from "@zcode/shared/test-ids";
import { clearAppData, getE2EAppDataPaths, waitForTestIdByDom } from "#e2e/helpers/desktop-app";

const EXPIRED_SESSION_CREDENTIAL_KEYS = [
  "oauth:active_provider",
  `oauth:${ZAI_PROVIDER_ID}:access_token`,
  `oauth:${ZAI_PROVIDER_ID}:refresh_token`,
  `oauth:${ZAI_PROVIDER_ID}:user_info`,
  "zcodejwttoken",
] as const;

describe("ZCode JWT 过期后重新认证", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("冷启动先清理过期登录态，提示用户后进入完整登录流程", async () => {
    const alert = await waitForExpiredLoginAlert();
    expect(alert.title).toMatch(/登录已过期|Your session has expired/u);
    expect(alert.description).toMatch(/请重新登录|sign in again/u);

    // Bug 回归边界：认证事实必须在提示框确认前清理，否则用户停留在弹窗时仍会
    // 携带过期 JWT 发请求，复现“看似登录但无法恢复”的分裂状态。
    await waitForExpiredSessionCredentialsCleanup();

    await clickExpiredLoginAlertAction();
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON, {
      timeout: 20000,
      timeoutMsg: "确认登录过期提示后没有展示登录入口",
    });
    await waitForTestIdByDom(TID_LOGIN_REGION_SWITCH, {
      timeout: 20000,
      timeoutMsg: "确认登录过期提示后没有展示中国/全球切换入口",
    });
    await expectExpiredAlertClosed();
  });
});

async function waitForExpiredLoginAlert(): Promise<{ title: string; description: string }> {
  await browser.waitUntil(
    async () => {
      const snapshot = await readAlertSnapshot();
      return /登录已过期|Your session has expired/u.test(snapshot.title);
    },
    {
      timeout: 60000,
      timeoutMsg: "已过期 JWT 冷启动后没有展示登录过期提示",
    },
  );
  return readAlertSnapshot();
}

async function readAlertSnapshot(): Promise<{ title: string; description: string }> {
  return (await browser.execute(() => {
    const content = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
    return {
      title:
        content
          ?.querySelector<HTMLElement>('[data-slot="alert-dialog-title"]')
          ?.textContent?.trim() ?? "",
      description:
        content
          ?.querySelector<HTMLElement>('[data-slot="alert-dialog-description"]')
          ?.textContent?.trim() ?? "",
    };
  })) as { title: string; description: string };
}

async function clickExpiredLoginAlertAction() {
  await browser.execute(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-slot="alert-dialog-content"] button',
    );
    if (!button) {
      throw new Error("登录过期提示缺少重新登录按钮");
    }
    button.click();
  });
}

async function waitForExpiredSessionCredentialsCleanup() {
  try {
    await browser.waitUntil(
      async () => {
        const credentials = await readCredentials();
        return EXPIRED_SESSION_CREDENTIAL_KEYS.every((key) => !(key in credentials));
      },
      {
        timeout: 10000,
        timeoutMsg: "登录过期提示确认前认证凭据没有完成清理",
      },
    );
  } catch (error) {
    const credentials = await readCredentials().catch(() => null);
    const keys = credentials ? Object.keys(credentials).sort().join(", ") : "<missing>";
    throw new Error(`过期认证凭据没有被清理，当前凭据 key: ${keys}`, {
      cause: error,
    });
  }
}

async function expectExpiredAlertClosed() {
  await browser.waitUntil(
    async () => {
      return (await browser.execute(() => {
        return !document.querySelector('[data-slot="alert-dialog-content"]');
      })) as boolean;
    },
    {
      timeout: 5000,
      timeoutMsg: "进入登录页后登录过期提示没有关闭",
    },
  );
}

async function readCredentials(): Promise<Record<string, string>> {
  const { credentialsFile } = getE2EAppDataPaths();
  return JSON.parse(await readFile(credentialsFile, "utf-8")) as Record<string, string>;
}
