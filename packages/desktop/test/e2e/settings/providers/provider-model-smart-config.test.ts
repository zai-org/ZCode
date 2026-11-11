import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { manualModelConfigSchema } from "@zcode/provider";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { seedPersonalProviderConfig } from "#e2e/helpers/model-provider-restart-config";

const footer = () => $('[data-model-settings-footer="true"]');
const mode = () => $('[data-model-recommended-config="true"] [role="switch"]');
const idInput = () => $('[data-model-identity-row="true"] input');
const context = () => $('[data-model-settings-group="tokens"] input');
const expandAdvanced = async () => {
  await $("[data-model-advanced-trigger]").click();
  // 高级区展开时仍在裁切并移动能力开关，原生 click 成功不保证点中目标。
  // 等真实展开状态与动画完成，再执行单次点击，保留后续 UI 和落盘值断言。
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const region = document.querySelector("[data-model-advanced]");
        return (
          region?.querySelector("[data-model-advanced-trigger]")?.getAttribute("aria-expanded") ===
            "true" &&
          region
            .getAnimations({ subtree: true })
            .every((animation) => animation.playState !== "running")
        );
      }),
    { timeout: 10000, timeoutMsg: "模型高级配置未完成展开" },
  );
};
const finish = async (save: boolean) => {
  await footer()
    .$(
      save
        ? './/button[normalize-space(.)="Save" or normalize-space(.)="保存"]'
        : './/button[normalize-space(.)="Cancel" or normalize-space(.)="取消"]',
    )
    .click();
};

describe("Todo90/92 添加与编辑共享智能配置", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SC90-01：添加固定配置、取消与失败保留草稿、编辑重开恢复智能配置", async function () {
    this.timeout(150_000);
    const providerId = "todo90-smart-config";
    const modelId = "todo90-manual-model";
    await prepareV4ConversationE2E({ skipProvider: true });
    const repository = new NodePersonalProviderConfigRepository({
      filePath: getE2EAppDataPaths().configFile,
      pollingIntervalMs: false,
    });
    try {
      await restartIntoWorkspace({
        afterElectronProcessExit: () =>
          seedReplayProvider({
            id: providerId,
            name: "Todo90 Smart Config",
            apiKey: "e2e-only",
            models: ["existing-model"],
          }),
      });
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
      await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${providerId}`));
      const before = (await repository.read()).models.toJSON();
      await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON);
      expect(await mode().getAttribute("aria-checked")).toBe("true");
      expect(await mode().isEnabled()).toBe(true);
      await idInput().setValue("gpt-5.6-sol");
      await browser.waitUntil(async () => Boolean(await context().getAttribute("placeholder")), {
        timeout: 15000,
      });
      expect(await context().getValue()).toBe("");
      expect(await context().getAttribute("placeholder")).not.toBe("");
      await mode().click();
      expect(await mode().getAttribute("aria-checked")).toBe("false");
      expect(await context().getValue()).not.toBe("");
      const filled = await context().getValue();
      await idInput().setValue(modelId);
      expect(await context().getValue()).toBe(filled);
      await finish(false);
      await footer().waitForExist({ reverse: true });
      expect((await repository.read()).models.toJSON()).toEqual(before);

      await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON);
      await idInput().setValue("gpt-5.6-sol");
      await browser.waitUntil(async () => Boolean(await context().getAttribute("placeholder")), {
        timeout: 15000,
      });
      await mode().click();
      await idInput().setValue(modelId);
      // WebDriver clear 不保证触发 React input；实际键盘删除，确保测到空草稿而非仅 DOM 空值。
      await context().click();
      await browser.keys("Backspace");
      expect(await context().getValue()).toBe("");
      await finish(true);
      expect(await footer().isExisting()).toBe(true);
      expect(await idInput().getValue()).toBe(modelId);
      expect((await repository.read()).models.getExact(providerId, modelId)).toBeUndefined();
      await context().setValue("123456");
      const formats = [
        ["image", "supportsImage"],
        ["video", "supportsVideo"],
        ["pdf", "supportsPdf"],
      ] as const;
      const expectedFormats: Record<string, boolean> = {};
      await expandAdvanced();
      expect(
        await browser.execute(() =>
          document
            .querySelector("[data-model-advanced]")!
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === "running")
            .map((animation) => ({
              type: animation.constructor.name,
              property:
                "transitionProperty" in animation
                  ? (animation as CSSTransition).transitionProperty
                  : null,
            })),
        ),
      ).toEqual([]);
      for (const [modality, field] of formats) {
        const control = await $(`[data-model-input-modality="${modality}"]`);
        expectedFormats[field] = (await control.getAttribute("aria-pressed")) !== "true";
        await control.click();
        expect(await control.getAttribute("aria-pressed")).toBe(String(expectedFormats[field]));
      }
      await finish(true);
      await footer().waitForExist({ reverse: true, timeout: 15000 });
      const fixed = (await repository.read()).models.getExactRule(providerId, modelId);
      expect(fixed?.type).toBe("manual-provider-model");
      expect(fixed?.config.properties?.contextWindow).toBe(123456);
      expect(fixed?.config.properties?.inputFormat?.supportsText).toBeUndefined();
      expect(fixed?.config.properties?.outputFormat).toBeUndefined();
      expect(fixed?.config.properties?.requiresMfjsToolSchema).toBeUndefined();
      expect(fixed?.config.toJSON()).not.toHaveProperty("requiresMfjsToolSchema");
      for (const [, field] of formats) {
        expect(fixed?.config.properties?.inputFormat?.[field]).toBe(expectedFormats[field]);
      }
      expect(fixed?.config.properties?.toJSON()).not.toHaveProperty("input_format");
      expect(fixed?.config.properties?.toJSON()).not.toHaveProperty("output_format");
      expect(fixed?.config.optionSpecs?.maxOutputTokens?.map).toBeUndefined();
      // Todo104：保存必须使用最终选项结构，不能由表单补回已删除的 enum/limit type。
      expect(fixed?.config.optionSpecs?.reasoningLevel?.toJSON()).not.toHaveProperty("type");
      expect(fixed?.config.optionSpecs?.maxOutputTokens?.toJSON()).not.toHaveProperty("type");
      expect(manualModelConfigSchema.safeParse(fixed?.config.toJSON()).success).toBe(true);
      const row = () => $(`[data-model-provider-model-id="${modelId}"]`);
      await row().$('[role="switch"]').click();
      await browser.waitUntil(
        async () =>
          (await repository.read()).models.getExact(providerId, modelId)?.enabled === false,
        { timeout: 15000 },
      );
      await row().$("button:has(svg.lucide-pencil)").click();
      expect(await mode().getAttribute("aria-checked")).toBe("false");
      expect(await context().getValue()).toBe("123456");
      await expandAdvanced();
      for (const [modality, field] of formats) {
        expect(
          await $(`[data-model-input-modality="${modality}"]`).getAttribute("aria-pressed"),
        ).toBe(String(expectedFormats[field]));
      }
      expect(
        await $$('[data-model-settings-scroll="true"] [data-personal-override="true"]').length,
      ).toBe(0);
      await mode().click();
      await mode().waitForEnabled({ timeout: 15000 });
      await context().setValue("234567");
      await finish(true);
      await footer().waitForExist({ reverse: true, timeout: 15000 });
      const smart = (await repository.read()).models.getExactRule(providerId, modelId);
      expect(smart?.type).toBe("provider-model");
      expect(smart?.config.enabled).toBe(false);
      expect(smart?.config.properties?.contextWindow).toBe(234567);
      expect(smart?.config.optionSpecs?.maxOutputTokens).toBeUndefined();
      await row().$("button:has(svg.lucide-pencil)").click();
      expect(await context().getAttribute("data-personal-override")).toBe("true");
      expect(await context().getValue()).toBe("234567");
      const beforeRestore = await readFile(getE2EAppDataPaths().configFile, "utf8");
      const restore = () =>
        footer().$('.//button[normalize-space(.)="Reset form" or normalize-space(.)="重置表单"]');
      await restore().click();
      await browser.waitUntil(async () => (await context().getValue()) === "", { timeout: 15000 });
      expect(await mode().getAttribute("aria-checked")).toBe("true");
      expect(await readFile(getE2EAppDataPaths().configFile, "utf8")).toBe(beforeRestore);
      await finish(false);
      await row().$("button:has(svg.lucide-pencil)").click();
      expect(await context().getValue()).toBe("234567");
      await restore().click();
      await browser.waitUntil(async () => (await context().getValue()) === "", { timeout: 15000 });
      await context().setValue("345678");
      await finish(true);
      await footer().waitForExist({ reverse: true, timeout: 15000 });
      const restored = (await repository.read()).models.getExact(providerId, modelId);
      expect(restored?.properties?.contextWindow).toBe(345678);
      expect(restored?.enabled).toBe(false);
    } finally {
      repository.dispose();
    }
  });

  it("F98-03：继承 Map 多行展示，个人 Map 不重排，添加/编辑取消不落盘", async function () {
    this.timeout(150_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    const providerId = "todo98-format";
    const modelId = "GLM-5-Turbo";
    const file = getE2EAppDataPaths().configFile;
    await restartIntoWorkspace({
      afterElectronProcessExit: () =>
        seedPersonalProviderConfig(file, {
          id: providerId,
          label: "Todo98 Format",
          apiFormat: "anthropic-messages",
          apiKey: "e2e-only",
          baseURL: "http://127.0.0.1:1",
          // 本例验证继承 Map，不能让完整执行 fixture 的默认空 Map 抢占继承来源。
          models: [{ id: modelId, reasoningLevel: { values: ["disabled", "enabled"] } }],
        }),
    });
    const repository = new NodePersonalProviderConfigRepository({
      filePath: file,
      pollingIntervalMs: false,
    });
    const editor = () => $('[data-model-reasoning-level-map-editor="true"] textarea');
    const edit = async () => {
      await $(`[data-model-provider-model-id="${modelId}"]`)
        .$("button:has(svg.lucide-pencil)")
        .click();
      await expandAdvanced();
      await editor().waitForExist();
    };
    const expected =
      '{\n  "thinking": {\n    "type": reasoningLevel == "enabled" ? "enabled" : "disabled"\n  }\n}';
    const personal = '{  "thinking" : { "type": "disabled" } }';
    const clearViewport = () =>
      browser.electron.execute(async (electron) => {
        const window = electron.BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && w.isVisible(),
        );
        if (window?.webContents.debugger.isAttached())
          await window.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
      });
    try {
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
      await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${providerId}`));
      const before = await readFile(file, "utf8");
      await edit();
      expect(await editor().getValue()).toBe("");
      expect(await editor().getAttribute("placeholder")).toBe(expected);
      for (const width of [1200, 390]) {
        // 只模拟布局宽度，不冒充真实手机 shared-host 验证。
        await browser.electron.execute(async (electron, width) => {
          const window = electron.BrowserWindow.getAllWindows().find(
            (w) => !w.isDestroyed() && w.isVisible(),
          )!;
          if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
          await window.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
            width,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
          });
        }, width);
        await browser.waitUntil(() => browser.execute((w) => window.innerWidth === w, width));
        await editor().scrollIntoView({ block: "center" });
        const fit = await browser.execute(() => {
          const element = document.querySelector(
            '[data-model-reasoning-level-map-editor="true"] textarea',
          )!;
          const bounds = element.getBoundingClientRect();
          return bounds.left >= 0 && bounds.right <= window.innerWidth;
        });
        expect(fit).toBe(true);
        expect(await editor().getAttribute("placeholder")).toBe(expected);
        const dir = join(process.cwd(), ".e2e-artifacts", "todo98");
        await mkdir(dir, { recursive: true });
        await browser.saveScreenshot(join(dir, `map-${width}.png`));
      }
      // 布局截图结束后恢复原视口，后续验证实际键盘编辑与保存。
      await clearViewport();
      await editor().setValue(personal);
      expect(await editor().getValue()).toBe(personal);
      await finish(false);
      await footer().waitForExist({ reverse: true });
      expect(await readFile(file, "utf8")).toBe(before);
      await edit();
      await editor().setValue(personal);
      expect(await editor().getValue()).toBe(personal);
      await finish(true);
      await footer().waitForExist({ reverse: true });
      expect(
        (await repository.read()).models.getExact(providerId, modelId)?.optionSpecs?.reasoningLevel
          ?.map,
      ).toBe(personal);
      await edit();
      expect(await editor().getValue()).toBe(personal);
      await finish(false);
      await footer().waitForExist({ reverse: true });

      const beforeAdd = await readFile(file, "utf8");
      await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON);
      await idInput().setValue("GLM-5.1");
      await browser.waitUntil(
        async () => (await editor().getAttribute("placeholder")) === expected,
      );
      expect(await editor().getValue()).toBe("");
      await finish(false);
      await footer().waitForExist({ reverse: true });
      expect(await readFile(file, "utf8")).toBe(beforeAdd);
    } finally {
      repository.dispose();
      await clearViewport();
    }
  });
});
