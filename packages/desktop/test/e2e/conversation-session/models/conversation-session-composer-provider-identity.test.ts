import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
  TID_CHAT_MODEL_SELECT_TRIGGER,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  setCurrentElectronRendererContentSize,
  restoreElectronRendererContentSize,
} from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  loginWithApiKey,
  switchV4Model,
  getV4ModelConfig,
} from "#e2e/helpers/v4-conversation";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { seedReplayProvider } from "#e2e/helpers/model-provider-restart";

import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";

const CASE_NAME = "conversation-session-composer-provider-identity";
const evidence = join(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(process.cwd(), ".e2e-artifacts"),
  CASE_NAME,
);
async function settledSnapshot() {
  return browser.execute((testId) => {
    const trigger = document.querySelector(`[data-testid="${testId}"]`)!;
    return {
      prefix: trigger.querySelector(".composer-provider-prefix")?.textContent ?? null,
      title: trigger.querySelector("[title]")?.getAttribute("title") ?? null,
    };
  }, TID_CHAT_MODEL_SELECT_TRIGGER);
}

describe("Composer provider 身份回归", () => {
  before(async () => {
    await browser.waitUntil(
      async () =>
        browser.execute(
          (login, settings) =>
            Boolean(
              document.querySelector(
                `[data-testid="${login}"], [data-testid="${settings}"], [data-testid="onboarding-page"]`,
              ),
            ),
          TID_LOGIN_USE_API_KEY_BUTTON,
          TID_TASK_SETTINGS_BUTTON,
        ),
      { timeout: 30000 },
    );
    if (await $(`[data-testid="${TID_LOGIN_USE_API_KEY_BUTTON}"]`).isExisting())
      await loginWithApiKey();
    await skipOccupationOnboardingIfPresent();
  });
  after(async () => {
    await clearAppData();
  });

  it("CMP02: bigmodel-api 没有 providerName 时菜单显示 provider ID，按钮显示模型名", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        await seedReplayProvider({ id: "bigmodel-api", name: "bigmodel-api", models: ["GLM-5.3"] });
        const repo = new NodePersonalProviderConfigRepository({
          filePath: getE2EAppDataPaths().configFile,
          pollingIntervalMs: false,
        });
        try {
          await repo.update((current) => {
            const rule = current.providers.getRule("bigmodel-api")!;
            return {
              ...current,
              providers: current.providers.setRule({ ...rule, providerName: null }),
            };
          });
        } finally {
          repo.dispose();
        }
      },
    });
    await switchV4Model("bigmodel-api", "GLM-5.3", "");
    assert.equal((await getV4ModelConfig()).provider, "bigmodel-api");
    const original = await setCurrentElectronRendererContentSize(1600, 760);
    try {
      const trigger = $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
      await trigger.click();
      const menu = await $('[role="menu"]').getText();
      assert.ok(menu.includes("bigmodel-api"), "菜单必须展示无名称 provider 的 ID");
      await browser.keys("Escape");
      // rolling 动画短暂保留旧标签；等待实际展示收敛，避免读取退场节点。
      await browser.waitUntil(
        async () => {
          const current = await settledSnapshot();
          return current.prefix === null && current.title === "GLM-5.3";
        },
        { timeout: 5000, timeoutMsg: "模型按钮未收敛到选中的 provider 身份" },
      );
      const state = await settledSnapshot();
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, "nameless-provider.json"), JSON.stringify(state, null, 2));
      await browser.saveScreenshot(join(evidence, "nameless-provider.png"));
      // 合并入口按当前规格只显示模型名；Provider 身份由菜单和实际配置共同验证。
      assert.equal(state.prefix, null);
      assert.equal(state.title, "GLM-5.3");
    } finally {
      await restoreElectronRendererContentSize(original);
    }
  });
});
