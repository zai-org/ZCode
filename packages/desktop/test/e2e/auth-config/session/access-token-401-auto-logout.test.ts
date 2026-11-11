import { readE2ECredentialValue } from "#e2e/helpers/desktop-app";
import { readFile } from "node:fs/promises";
import { PlatformChannels } from "@zcode/shared";
import {
  TID_OAUTH_LOGIN_BUTTON,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_WORKSPACE_HEADER,
} from "@zcode/shared/test-ids";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { dismissOccupationOnboarding } from "#e2e/helpers/occupation-onboarding";

const responseStatus = process.env.ZCODE_E2E_AUTH_EXPIRY_HTTP_STATUS === "200" ? 200 : 401;
const emptyRejection = process.env.ZCODE_E2E_AUTH_EXPIRY_RESPONSE_KIND === "empty";
const provider = process.env.ZCODE_E2E_AUTH_EXPIRY_PROVIDER === "zai" ? "zai" : "bigmodel";
const preserveSession = process.env.ZCODE_E2E_AUTH_VALIDATION_HEADER === "1";

describe("用户资料 access token 登录过期", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it(`AUTH-06: ${preserveSession ? "ZAI 有效身份遇到业务异常仍保留登录" : `${provider} HTTP ${responseStatus} ${emptyRejection ? "空正文" : "业务401"} 后清理并进入登录入口`}`, async () => {
    const baseUrl = process.env.ZCODE_E2E_ACCESS_TOKEN_401_URL;
    if (!baseUrl) throw new Error("缺少隔离 userinfo HTTP fixture");

    if (preserveSession) {
      await browser.waitUntil(
        async () => {
          const status = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
            ordinaryBusinessRequestCount: number;
            rawIdentityRequestCount: number;
            rejectedIdentityHeaderCount: number;
          };
          return (
            status.rejectedIdentityHeaderCount > 0 ||
            (status.ordinaryBusinessRequestCount > 0 && status.rawIdentityRequestCount > 0)
          );
        },
        { timeout: 30_000, timeoutMsg: "Host 没有完成异常业务请求与裸 token 身份核验" },
      );
      await dismissOccupationOnboarding();
      // 等待启动进入工作区，避免只观察首次核验、漏掉后续 PAT 资料读取造成的误退出。
      await browser
        .$(`[data-testid="${TID_WORKSPACE_HEADER}"]`)
        .waitForDisplayed({ timeout: 10_000 });
      const status = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
        rejectedIdentityHeaderCount: number;
      };
      expect(status.rejectedIdentityHeaderCount).toBe(0);
      const credentials = await readCredentials();
      expect(await readE2ECredentialValue("oauth:active_provider")).toBe("zai");
      for (const key of ["oauth:zai:access_token", "oauth:zai:user_info", "zcodejwttoken"])
        expect(credentials[key]).toBeDefined();
      expect(await readE2ECredentialValue("bot:e2e:credential")).toBe("e2e-independent-bot-token");
      expect(await expiredAlertCount()).toBe(0);
      return;
    }

    await browser.waitUntil(
      async () => {
        const response = await fetch(`${baseUrl}/__e2e/status`);
        const status = (await response.json()) as { businessRequestCount: number };
        return status.businessRequestCount > 0;
      },
      { timeout: 30_000, timeoutMsg: "Host 没有使用业务 access token 请求 userinfo" },
    );
    expect(await readE2ECredentialValue("oauth:active_provider")).toBe(provider);
    expect(await expiredAlertCount()).toBe(0);

    await fetch(
      `${baseUrl}/__e2e/reject?status=${responseStatus}&empty=${emptyRejection ? "1" : "0"}`,
      { method: "POST" },
    );
    const fixtureStatus = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
      rejectionStatus: number;
      rejected: boolean;
    };
    expect(fixtureStatus.rejectionStatus).toBe(responseStatus);
    expect(fixtureStatus.rejected).toBe(true);
    await browser.waitUntil(async () => (await expiredAlertCount()) === 1, {
      timeout: 30_000,
      timeoutMsg: `业务 access token HTTP ${responseStatus} + 业务 401 后没有出现原登录过期弹窗`,
    });
    await browser.waitUntil(
      async () => {
        const credentials = await readCredentials();
        return [
          "oauth:active_provider",
          `oauth:${provider}:access_token`,
          `oauth:${provider}:refresh_token`,
          `oauth:${provider}:user_info`,
          "zcodejwttoken",
        ].every((key) => !(key in credentials));
      },
      { timeout: 10_000, timeoutMsg: "弹窗确认前没有完成原 OAuth 清理" },
    );
    expect(await readE2ECredentialValue("bot:e2e:credential")).toBe("e2e-independent-bot-token");

    // 修复后应直接重新登录；记录 IPC 确认不会绕回旧的重启流程。
    await browser.electron.execute((electron, channel) => {
      const state = globalThis as typeof globalThis & { __oauth401Commands?: string[] };
      state.__oauth401Commands = [];
      electron.ipcMain.removeHandler(channel);
      electron.ipcMain.handle(channel, (_event, command: string) => {
        state.__oauth401Commands?.push(command);
      });
    }, PlatformChannels.ExecuteDesktopCommand);
    await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-slot="alert-dialog-content"] button',
      );
      if (!button) throw new Error("缺少登录过期确认按钮");
      button.click();
    });
    await browser.waitUntil(
      async () =>
        browser.execute(
          (ids) =>
            ids.some((id) => {
              const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
              return element !== null && element.getBoundingClientRect().height > 0;
            }),
          [TID_OAUTH_LOGIN_BUTTON, TID_LOGIN_USE_API_KEY_BUTTON],
        ),
      { timeout: 10_000, timeoutMsg: "确认后没有进入 Welcome 登录入口" },
    );
    const commands = await browser.electron.execute(
      () =>
        (globalThis as typeof globalThis & { __oauth401Commands?: string[] }).__oauth401Commands ??
        [],
    );
    expect(commands).toEqual([]);
  });
});

async function readCredentials(): Promise<Record<string, string>> {
  return JSON.parse(await readFile(getE2EAppDataPaths().credentialsFile, "utf8"));
}

async function expiredAlertCount(): Promise<number> {
  return browser.execute(
    () =>
      Array.from(document.querySelectorAll('[data-slot="alert-dialog-title"]')).filter((element) =>
        /登录已过期|Your session has expired/u.test(element.textContent ?? ""),
      ).length,
  );
}
