import { ApiKeyAccessConfig, ProviderConfig } from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspace, seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

describe("Todo116 单一 Key 链接原生打开", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("K116-N01：两类手动 Access 从唯一入口打开配置 URL，不修改配置", async function () {
    this.timeout(120_000);
    const received = new Set<string>();
    const nonce = randomUUID();
    const variants = [
      {
        id: "e2e-key-native-standard",
        type: "api-key",
        apiKey: "e2e-only",
        templateId: "zai-standard-api",
      },
      {
        id: "e2e-key-native-plan",
        type: "zhipu-coding-plan-api-key",
        apiKey: "",
        templateId: "zai-api",
      },
    ] as const;
    const targets = new Set(variants.map(({ id }) => `/E2E_KEY_NATIVE/${nonce}/${id}`));
    // 只记录本例 canary 路径，不收集默认浏览器的 Cookie、历史或其他页面。
    const server = createServer((request, response) => {
      if (request.method === "GET" && targets.has(request.url ?? "")) {
        received.add(request.url!);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<title>ZCode E2E</title><p>API Key link verification passed. You may close this test tab.</p>",
        );
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing canary port");
    const repository = new NodePersonalProviderConfigRepository({
      filePath: getE2EAppDataPaths().configFile,
      pollingIntervalMs: false,
    });
    try {
      await prepareV4ConversationE2E({ skipProvider: true });
      await restartIntoWorkspace({
        afterElectronProcessExit: async () => {
          for (const variant of variants) {
            await seedReplayProvider({
              id: variant.id,
              name: variant.id,
              apiKey: variant.apiKey,
              models: ["E2E_KEY_NATIVE_MODEL"],
            });
            await repository.update((current) => {
              const rule = current.providers.getRule(variant.id)!;
              return {
                ...current,
                providers: current.providers.setRule({
                  ...rule,
                  // 入口仅供预设模板实例；纯自定义 Provider 不应被测试擅自要求显示链接。
                  templateId: variant.templateId,
                  config: rule.config.overlay(
                    new ProviderConfig({
                      access: new ApiKeyAccessConfig({
                        type: variant.type,
                        apiKey: variant.apiKey,
                        apiKeyManagementUrl: `http://127.0.0.1:${address.port}/E2E_KEY_NATIVE/${nonce}/${variant.id}`,
                      }),
                    }),
                  ),
                }),
              };
            });
          }
        },
      });
      const before = await readFile(getE2EAppDataPaths().configFile, "utf8");
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
      for (const { id } of variants) {
        await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${id}`));
        const selector =
          '//button[normalize-space(.)="获取 API Key" or normalize-space(.)="Get API Key"]';
        await $(selector).waitForClickable({ timeout: 15_000 });
        const links = await $$(selector);
        expect(links).toHaveLength(1);
        const path = `/E2E_KEY_NATIVE/${nonce}/${id}`;
        expect(received.has(path)).toBe(false);
        // 不 mock shell：必须走真实按钮、preload、main IPC，最终由系统浏览器访问 canary。
        await links[0]!.click();
        await browser.waitUntil(() => received.has(path), {
          timeout: 15_000,
          timeoutMsg: `${id} 未通过系统默认浏览器打开精确配置 URL`,
        });
        // canary 不能只是 Electron 内部导航；主设置页仍在，所有内嵌页面均未打开目标。
        expect(
          await browser.electron.execute(
            (electron, target) =>
              electron.webContents
                .getAllWebContents()
                .some((contents) => contents.getURL() === target),
            `http://127.0.0.1:${address.port}${path}`,
          ),
        ).toBe(false);
        await $(selector).waitForDisplayed({ timeout: 15_000 });
      }
      expect(await readFile(getE2EAppDataPaths().configFile, "utf8")).toBe(before);
    } finally {
      repository.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
