// DMM-09：账号套餐草稿的迁移按当前有效连接判定，规格见 docs/chat/draft-model-migration.md。
// 原选择保存为个人 Coding Plan，当前连接为团队套餐；View 把有效 Provider 对应到团队套餐，
// 迁移后仍保留原 providerId，请求按当前连接发出。规则经 team mock 的 client/configs 下发。
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  TID_CHAT_MODEL_GUIDE,
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  pinE2ELocale,
} from "#e2e/helpers/desktop-app";
import {
  readBigModelConnectionSelection,
  restartIntoWorkspace,
  seedBigModelConnectionSelection,
  seedBigModelOAuthCredential,
  waitForPlanModelIoRequest,
  waitForSelectedModel,
} from "#e2e/helpers/model-provider-restart";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { sel } from "#e2e/helpers/selectors";
import {
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
} from "#e2e/helpers/v4-conversation";

const individual = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
const team = BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
const SOURCE_MODEL = "GLM-5.3-Flash";
const TARGET_MODEL = "GLM-5.3";
const TEAM_CONNECTION_KEY = "team:bigmodel:product-team-a:org-team-a:proj-team-a";
// 型号只能取 team mock 目录里已有的公开型号；气泡文案保持中性，不描述任何发布计划。
const NOTICE_ZH_CN = "E2E 账号套餐文案：草稿模型已按服务端规则切换";

async function setMockClientConfigs(configs: Record<string, unknown>) {
  const baseUrl = process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL?.trim();
  if (!baseUrl) throw new Error("coding plan team mock 未启动，无法下发 client/configs");
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/client-configs`, {
    body: JSON.stringify({ configs }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`下发 client/configs 失败：status=${response.status}`);
}

async function selectConnection(key: string) {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), { timeout: 15000 });
  await clickTestIdByDom(
    testId(TID_MODEL_PROVIDER_NAV_ITEM, `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`),
    { timeout: 30000 },
  );
  await clickTestIdByDom(TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER, { timeout: 15000 });
  const option = await $(sel(testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, key)));
  await option.waitForDisplayed({ timeout: 30000 });
  await option.click();
  const expectedKind = key.startsWith("team:") ? "team-coding-plan" : "individual-coding-plan";
  await browser.waitUntil(
    async () => (await readBigModelConnectionSelection())?.kind === expectedKind,
    { timeout: 15000, timeoutMsg: `连接方式尚未保存：${key}` },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15000 });
}

async function readProjectRecent() {
  return browser.execute((workspacePath) => {
    const state = (
      window as Window & {
        __zcodeSessionStoreE2E?: {
          getState(): { workspaces: Record<string, { draftProjectId?: string | null }> };
        };
      }
    ).__zcodeSessionStoreE2E?.getState().workspaces[workspacePath];
    const key = `zcode-composer-recent:v2:${JSON.stringify(["desktop", "local", state?.draftProjectId ?? null])}`;
    const raw = window.localStorage.getItem(key);
    return { key, value: raw ? (JSON.parse(raw) as Record<string, unknown>) : null };
  }, DEFAULT_WORKSPACE);
}

describe("草稿模型迁移：账号套餐与连接重映射", () => {
  after(async () => {
    await setMockClientConfigs({}).catch(() => {});
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DMM-09：个人套餐原选择在团队连接下按有效 Provider 迁移，保留原 providerId", async () => {
    // Host 会按刷新间隔缓存 client/configs；规则须在应用首次读取前就位，
    // 否则首轮“无规则”快照在默认一小时内不会重新请求（这正是产品的缓存契约）。
    await setMockClientConfigs({
      draftModelMigration: {
        revision: 1,
        targetModelId: TARGET_MODEL,
        sourceModelIds: [SOURCE_MODEL],
        notice: { "zh-CN": NOTICE_ZH_CN },
      },
    });
    await prepareV4ConversationE2E({ skipProvider: true });
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedBigModelConnectionSelection({ kind: "individual-coding-plan" });
        await seedBigModelOAuthCredential();
      },
    });
    // 规则只有中文文案；须在构造 Recent 前固定应用语言，英文系统下才不会只迁移而不提示。
    await pinE2ELocale("zh-CN");
    await selectConnection(`coding-plan:${individual}`);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    const { key: recentKey } = await readProjectRecent();
    // Recent 由真实发送才会写入；这里直接构造“个人套餐 + 源模型”的历史默认值作为前置。
    await browser.execute(
      (key, providerId, modelId) =>
        window.localStorage.setItem(
          key,
          JSON.stringify({
            modelSelection: { providerId, modelId, options: { reasoningLevel: "high" } },
            mode: "build",
            order: 1,
          }),
        ),
      recentKey,
      individual,
      SOURCE_MODEL,
    );
    // 切到团队连接：原选择仍是个人套餐，View 把它对应到当前团队套餐。
    await selectConnection(TEAM_CONNECTION_KEY);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForSelectedModel(team, TARGET_MODEL);
    const guide = $(`[data-testid="${TID_CHAT_MODEL_GUIDE}"]`);
    await guide.waitForDisplayed({ timeout: 15000 });
    expect((await guide.getText()).trim()).toBe(NOTICE_ZH_CN);
    // 原 providerId 保留：连接再切换时仍按当前连接对应，不把团队套餐写死进意图。
    const recent = await readProjectRecent();
    expect(recent.value).toEqual({
      modelSelection: {
        providerId: individual,
        modelId: TARGET_MODEL,
        options: { reasoningLevel: "high" },
      },
      mode: "build",
      order: 1,
    });

    await sendV4PromptAndWaitAccepted(
      "E2E_DMM09_SEND: Reply briefly.",
      "E2E_DMM09_SEND",
      "账号套餐迁移后的首发未接纳",
      20000,
    );
    const request = await waitForPlanModelIoRequest("E2E_DMM09_SEND");
    expect(request?.model).toBe(TARGET_MODEL);
  });
});
