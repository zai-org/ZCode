import { ModelConfig, ModelPropertiesConfig } from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspace, seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

describe("Todo89 Provider 配置修复入口", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("W89-05 / W89-08：不完整个人模型可修复；添加失败保留草稿", async function () {
    this.timeout(120_000);
    const providerId = "todo89-repair";
    const modelId = "glm-todo89-repair";
    await prepareV4ConversationE2E({ skipProvider: true });
    const repository = new NodePersonalProviderConfigRepository({
      filePath: getE2EAppDataPaths().configFile,
      pollingIntervalMs: false,
    });
    try {
      await restartIntoWorkspace({
        afterElectronProcessExit: async () => {
          await seedReplayProvider({
            id: providerId,
            name: "Todo89 Repair",
            apiKey: "e2e-only",
            models: [modelId],
          });
          await repository.update((current) => ({
            ...current,
            models: current.models.setExact(
              providerId,
              modelId,
              (current.models.getExact(providerId, modelId) ?? new ModelConfig({})).overlay(
                new ModelConfig({ properties: new ModelPropertiesConfig({ contextWindow: null }) }),
              ),
            ),
          }));
        },
      });
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
      await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${providerId}`));
      const row = () => $(`[data-model-provider-model-id="${modelId}"]`);
      const edit = () => row().$("button:has(svg.lucide-pencil)");
      await edit().waitForClickable({ timeout: 15000 });
      await edit().click();
      const context = $('[data-model-settings-group="tokens"] input');
      await context.setValue("123456");
      await $('[data-model-settings-footer="true"]')
        .$('.//button[normalize-space(.)="Save" or normalize-space(.)="保存"]')
        .click();
      await browser.waitUntil(
        async () =>
          (await repository.read()).models.getExact(providerId, modelId)?.properties
            ?.contextWindow === 123456,
        { timeout: 15000 },
      );
      await $('[data-model-settings-footer="true"]').waitForExist({
        reverse: true,
        timeout: 15000,
      });
      await edit().click();
      expect(await context.getValue()).toBe("123456");
      await $('[data-model-settings-footer="true"]')
        .$('.//button[normalize-space(.)="Cancel" or normalize-space(.)="取消"]')
        .click();
      await row().$('[role="switch"]').click();
      await browser.waitUntil(
        async () =>
          (await repository.read()).models.getExact(providerId, modelId)?.enabled === false,
        { timeout: 15000 },
      );
      expect(
        (await repository.read()).models.getExact(providerId, modelId)?.properties?.contextWindow,
      ).toBe(123456);
      // 重复成员由真实写入边界拒绝；弹窗不能把“请求已发出”当成保存成功。
      await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON);
      await $('[data-model-identity-row="true"] input').setValue(modelId);
      const footer = () => $('[data-model-settings-footer="true"]');
      const save = () =>
        footer().$('.//button[normalize-space(.)="Save" or normalize-space(.)="保存"]');
      await save().waitForClickable({ timeout: 15000 });
      await save().click();
      await browser.waitUntil(
        async () => (await browser.execute(() => document.body.innerText)).includes("Model 已存在"),
        { timeout: 15000 },
      );
      expect(await $('[data-model-identity-row="true"] input').getValue()).toBe(modelId);
      expect((await repository.read()).providers.get(providerId)?.personalModelIds).toEqual([
        modelId,
      ]);
      await footer()
        .$('.//button[normalize-space(.)="Cancel" or normalize-space(.)="取消"]')
        .click();
      await row().$("button:has(svg.lucide-trash-2)").click();
      await browser.waitUntil(
        async () =>
          !(await repository.read()).providers.get(providerId)?.personalModelIds?.includes(modelId),
        { timeout: 15000 },
      );
      expect((await repository.read()).models.getExact(providerId, modelId)).toBeUndefined();
      await browser.waitUntil(
        async () => /已删除|deleted/i.test(await browser.execute(() => document.body.innerText)),
        { timeout: 15000, timeoutMsg: "删除模型应显示删除成功而非保存成功" },
      );
    } finally {
      repository.dispose();
    }
  });
});
