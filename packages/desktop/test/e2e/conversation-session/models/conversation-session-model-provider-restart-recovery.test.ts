import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_V4_COMPOSER_INPUT, TID_V4_COMPOSER_SEND } from "@zcode/shared/test-ids";
import {
  clearAppData,
  setInputValueByTestIdDom,
  getE2EAppDataPaths,
  readSettings,
} from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
  waitForUpstreamNetworkRequestStarted,
} from "#e2e/helpers/upstream-capture";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  selectRegistryProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  E2E_BIGMODEL_PLAN_PROVIDER_ID,
  E2E_BIGMODEL_START_PROVIDER_ID,
  E2E_PLAN_NON_DEFAULT_MODEL,
  restartIntoWorkspace,
  seedBigModelOAuthCredential,
  seedBigModelConnectionSelection,
  seedPersistedModelSelection,
  seedReplayProvider,
  waitForSelectedModel,
} from "#e2e/helpers/model-provider-restart";
import {
  E2E_REPLY_TOKEN,
  getV4ModelConfig,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Model,
  waitForV4ComposerSelectionReady,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("模型 Provider 重启恢复 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  beforeEach(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      id: UPSTREAM_PROVIDER_ID,
      models: [{ id: UPSTREAM_MODEL, reasoningLevel: { values: ["high", "max"], map: "{}" } }],
      name: "Upstream E2E",
    });
  });

  it("I25/MP-R01: 重启保留仍可用的 上游 last-selected", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: UPSTREAM_MODEL,
      providerId: UPSTREAM_PROVIDER_ID,
      reasoningLevel: "max",
    });
    await restartIntoWorkspace();
    await waitForSelectedModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await waitForRestartedDraftModelReady(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await assertRequestUsesModel("E2E_MODEL_PROVIDER_RESTART_R01", UPSTREAM_MODEL);
  });

  it("I26/MP-R02: 重启保留当前 Plan 内非首个模型", async function () {
    this.timeout(180000);
    // Bug 根因：运行中的 Host 会在退出时落盘内存里的连接选择；若 fixture 预先
    // 直写 setting.json，退出阶段会把 Individual 选择覆盖回上一条 Team 状态。
    // 与真实冷启动一致，账号选择和凭据都必须在进程退出屏障后写入。
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedBigModelConnectionSelection({
          kind: "team-coding-plan",
          productId: "product-team-a",
          organizationId: "org-team-a",
          projectId: "proj-team-a",
        });
        await seedBigModelOAuthCredential();
      },
    });
    // 未提交改选只随非空文字草稿保存，空白 Composer 重启会读取原 Recent。
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "E2E_MODEL_PROVIDER_RESTART_R02 draft");
    await waitForV4ComposerSelectionReady();
    // 合并菜单只展示当前 Provider 的模型；通过 Provider 子菜单切换后再选择目标模型。
    await selectRegistryProviderModelById(E2E_PLAN_NON_DEFAULT_MODEL, {
      providerId: E2E_BIGMODEL_PLAN_PROVIDER_ID,
      providerGroupKey: JSON.stringify([
        "bigmodel",
        "team-coding-plan",
        "product-team-a",
        "org-team-a",
        "proj-team-a",
      ]),
      includePlainModelFallback: false,
    });
    await selectUpstreamThoughtLevelValue("max");
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
    await restartIntoWorkspacePreservingProfile(getE2EAppDataPaths().workspace);
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
    // Todo88：仅在退出后注入同一 Team 的旧连接字段；不能用新字段 seed 冒充升级迁移。
    const settingsPath = join(getE2EAppDataPaths().appDataDir, "setting.json");
    for (const key of [
      "team-plan:builtin:bigmodel-coding-plan:product-team-a:org-team-a:proj-team-a",
      "team-plan:builtin:bigmodel-coding-plan:product-team-a:proj-team-a",
    ]) {
      const legacyKeys = { bigmodel: key };
      await restartIntoWorkspacePreservingProfile(getE2EAppDataPaths().workspace, {
        afterElectronProcessExit: async () => {
          const settings = JSON.parse(await readFile(settingsPath, "utf8"));
          delete settings.providerFamilyConnectionSelections;
          await writeFile(
            settingsPath,
            JSON.stringify({
              ...settings,
              modelProviderFamilyModes: { bigmodel: "oauth" },
              modelProviderFamilySelectedKeys: legacyKeys,
            }),
          );
        },
      });
      await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
      expect((await readSettings()).providerFamilyConnectionSelections?.bigmodel).toEqual({
        kind: "team-coding-plan",
        productId: "product-team-a",
        organizationId: "org-team-a",
        projectId: "proj-team-a",
      });
      expect(
        JSON.parse(await readFile(settingsPath, "utf8")).modelProviderFamilySelectedKeys,
      ).toEqual(legacyKeys);
    }
    await assertPlanRequest("E2E_MODEL_PROVIDER_RESTART_R02");
  });

  it("I27/MP-R03: 同 Family 的失效旧选择留空，手动选择后可发送", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: E2E_PLAN_NON_DEFAULT_MODEL,
      providerId: E2E_BIGMODEL_START_PROVIDER_ID,
      reasoningLevel: "max",
    });
    await restartWithTeamPlanSelection();
    await assertUnavailableSelectionRequiresUserChoice();
    await assertRequestUsesModel("E2E_MODEL_PROVIDER_RESTART_R03", UPSTREAM_MODEL);
  });

  it("I28/MP-R04: 已不可用 last-selected 留空，手动选择后可发送", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: "upstream-removed-e2e",
      providerId: UPSTREAM_PROVIDER_ID,
      reasoningLevel: "max",
    });
    await restartWithTeamPlanSelection();
    await assertUnavailableSelectionRequiresUserChoice();
    await assertRequestUsesModel("E2E_MODEL_PROVIDER_RESTART_R04", UPSTREAM_MODEL);
  });
});

async function restartWithTeamPlanSelection() {
  await restartIntoWorkspace({
    afterElectronProcessExit: async () => {
      await seedBigModelConnectionSelection({
        kind: "team-coding-plan",
        productId: "product-team-a",
        organizationId: "org-team-a",
        projectId: "proj-team-a",
      });
      await seedBigModelOAuthCredential();
    },
  });
}

async function assertRequestUsesModel(marker: string, model: string) {
  const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  await sendV4Prompt(prompt);
  // Bug 根因：重启后 toolbar 会早于 draft runtime binding 完成水合；旧 case
  // 发送后直接等待 complete capture，无法区分“点击没有进入 runtime”和“请求响应慢”。
  // request-start 是物理 admission 屏障，complete capture 再负责模型与响应断言。
  await waitForUpstreamNetworkRequestStarted(marker);
  const capture = await waitForUpstreamNetworkCapture(marker);
  assertUpstreamRequestCapture(capture, { expectedText: prompt, model });
  await waitForV4TimelineContaining(E2E_REPLY_TOKEN);
  await waitForV4Pane((snapshot) => !snapshot.canStop, `${marker} 没有完成`, 90000);
}

async function waitForRestartedDraftModelReady(provider: string, model: string) {
  await waitForV4ComposerSelectionReady();
  let latest = await getV4ModelConfig();
  let stableSince = 0;
  await browser.waitUntil(
    async () => {
      latest = await getV4ModelConfig();
      const matched =
        latest.source === "composer" && latest.provider === provider && latest.model === model;
      if (!matched) {
        stableSince = 0;
        return false;
      }
      stableSince ||= Date.now();
      return Date.now() - stableSince >= 300;
    },
    {
      timeout: 30000,
      timeoutMsg: `重启后的 draft provider/runtime 没有稳定就绪: ${JSON.stringify({
        expected: { model, provider },
        latest,
      })}`,
    },
  );
}

async function assertPlanRequest(marker: string) {
  const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  await sendV4Prompt(prompt);
  await waitForV4TimelineContaining(E2E_REPLY_TOKEN);
  await waitForV4Pane((snapshot) => !snapshot.canStop, `${marker} 没有完成`, 90000);
}

async function assertUnavailableSelectionRequiresUserChoice() {
  // Todo 71 已取消失效选择自动回退；必须验证禁发和用户显式修复，不能等待默认模型。
  await browser.waitUntil(async () => !(await getV4ModelConfig()).model, {
    timeout: 30_000,
    timeoutMsg: "失效模型不应自动回退到默认模型",
  });
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "E2E_INVALID_SELECTION_NOT_SENT");
  expect(await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled()).toBe(false);
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "");
  await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL, "max");
  await waitForRestartedDraftModelReady(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
}
