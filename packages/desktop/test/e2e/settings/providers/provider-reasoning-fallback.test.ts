import { createServer } from "node:http";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspace, seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

describe("Todo95 未知型号仅添加档位", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("保存稀疏档位配置并通过真实 Model 发出兜底请求", async function () {
    this.timeout(120000);
    const providerId = "e2e-t95-fallback";
    const modelId = "E2E_T95_UNKNOWN";
    const bodies: Record<string, unknown>[] = [];
    // synthetic / fast-text：白名单固定 Prompt，使用独立模型 ID 识别测试请求。
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      bodies.push(JSON.parse(raw));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "e2e-t95", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      response.end(chunk({ content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing mock address");
    const repository = new NodePersonalProviderConfigRepository({
      filePath: getE2EAppDataPaths().configFile,
      pollingIntervalMs: false,
    });
    try {
      await prepareV4ConversationE2E({ skipProvider: true });
      await restartIntoWorkspace({
        afterElectronProcessExit: () =>
          seedReplayProvider({
            id: providerId,
            name: "Todo95 fallback",
            apiKey: "e2e-only",
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            models: [],
          }),
      });
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
      await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${providerId}`));
      await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON);
      await $('[data-model-identity-row="true"] input').setValue(modelId);
      const footer = () => $('[data-model-settings-footer="true"]');
      // 智能配置已独立到标题下方；推理档位在高级配置中，不再依赖旧基础区布局。
      const smartSwitch = $('[data-model-recommended-config="true"] [role="switch"]');
      await smartSwitch.waitForEnabled({
        timeout: 15000,
      });
      // 推荐容量只展示继承值；保存思考档位不能把新的通用容量固化为个人覆盖。
      await browser.waitUntil(
        async () =>
          (await $('[data-model-settings-group="tokens"] input').getAttribute("placeholder")) ===
          "1000000",
        { timeout: 15000 },
      );
      expect(await $("[data-model-max-output] input").getAttribute("placeholder")).toBe("128000");
      await $('[data-model-advanced-trigger="true"]').click();
      await $('[data-model-reasoning-chip="true"] button').waitForExist({ timeout: 15000 });
      expect(await smartSwitch.getAttribute("aria-checked")).toBe("true");
      // 未知型号现有默认档位为 disabled/enabled；先通过 UI 删除 enabled，保留单档场景。
      const removeEnabled = $('[data-model-reasoning-chip="true"] button[aria-label$=": enabled"]');
      await removeEnabled.parentElement().moveTo();
      await removeEnabled.click();
      // 只改 values；连接测试使用最低公开档，单档 high 能证明真实执行了新增档位。
      const chip = $('[data-model-reasoning-chip="true"] button');
      await chip.scrollIntoView({ block: "center" });
      await chip.waitForClickable({ timeout: 15000 });
      await chip.click();
      await browser
        .waitUntil(async () => await $('[data-model-reasoning-level-input="true"]').isExisting(), {
          timeout: 5000,
        })
        .catch(async (error) => {
          const state = await browser.execute(() => ({
            active: document.activeElement?.outerHTML,
            editor: document.querySelector('[data-model-reasoning-level-editor="true"]')?.outerHTML,
          }));
          throw new Error(`Todo95 editor did not enter edit mode: ${JSON.stringify(state)}`, {
            cause: error,
          });
        });
      // WebDriver setValue 的 clear 阶段会使该行内编辑器失焦；保持键盘焦点完成真实替换。
      await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
      await browser.keys("high");
      await browser.keys("Enter");
      await footer().$('.//button[normalize-space(.)="Save" or normalize-space(.)="保存"]').click();
      await footer().waitForExist({ reverse: true, timeout: 15000 });
      const rule = (await repository.read()).models.getExactRule(providerId, modelId);
      expect(rule?.config.properties?.contextWindow).toBeUndefined();
      expect(rule?.config.optionSpecs?.maxOutputTokens?.max).toBeUndefined();
      expect(rule?.config.optionSpecs?.reasoningLevel?.values).toEqual(["high"]);
      expect(rule?.config.optionSpecs?.reasoningLevel?.map).toBeUndefined();
      const probe = $(`[data-model-provider-model-id="${modelId}"] button:has(svg.lucide-unplug)`);
      await probe.waitForClickable({ timeout: 15000 });
      await probe.click();
      await browser.waitUntil(
        async () => {
          const text = await browser.execute(() => document.body.innerText);
          return bodies.length > 0 && (text.includes("connected") || text.includes("连接成功"));
        },
        { timeout: 30000 },
      );
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        model: modelId,
        thinking: { type: "enabled" },
        enable_thinking: true,
        reasoning_effort: "high",
        reasoning: { effort: "high" },
        max_completion_tokens: 512,
        messages: [
          { role: "system", content: "You are ZCode connectivity probe." },
          { role: "user", content: "hi" },
        ],
      });
      expect(bodies[0]!.thinking).not.toHaveProperty("budget_tokens");
      expect(
        (await repository.read()).models.getExactRule(providerId, modelId)?.config.toJSON(),
      ).toEqual(rule?.config.toJSON());
    } finally {
      repository.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
