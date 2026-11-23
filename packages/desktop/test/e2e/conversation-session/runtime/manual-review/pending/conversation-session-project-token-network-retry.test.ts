import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { CODING_PLAN_TEAM_MOCK_BASE_URL_ENV } from "#e2e/helpers/coding-plan-mock-env";
import {
  E2E_PLAN_NON_DEFAULT_MODEL,
  restartIntoWorkspace,
  seedBigModelConnectionSelection,
  seedBigModelOAuthCredential,
  seedPersistedModelSelection,
  waitForSelectedModel,
} from "#e2e/helpers/model-provider-restart";
import {
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

// PTN：冷缓存换证断网（反馈 ZCT-2122890271808978944 等）。修复前 Host 回 headersApplied:false，
// 本轮立即失败；修复后并入模型 network_error 预算，界面显示通用重连，恢复后继续原消息。
const INDIVIDUAL = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
const MARKER = "E2E_PTN_RECOVER";
// 套餐数据面默认 SSE 回复；不能用提示词里的文本判断模型已回复。
const PLAN_REPLY = "coding-plan-e2e-ok";
const RECONNECTING = /重新连接中|Reconnecting/;
// 短寿命 PAT 让发送时缓存里没有可降级的旧 Token，必须重新签发。
// 由 wdio case-mode 按 spec 下发（重启会再次重置 mock），这里只核对生效值。
const SHORT_LIFETIME_SECONDS = 3;

type TokenState = {
  lifetimeSeconds: number;
  networkDown: boolean;
  issueAttempts: number;
  droppedAttempts: number;
  latestExpiresAtMs: number;
};

async function tokenControl(patch: Partial<Pick<TokenState, "lifetimeSeconds" | "networkDown">>) {
  const base = process.env[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV];
  if (!base) throw new Error("缺少 Coding Plan 团队 mock");
  const response = await fetch(`${base}/__e2e/coding-plan/project-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as TokenState;
}

async function save(name: string, state: TokenState) {
  const dir = process.env.ZCODE_E2E_ARTIFACT_DIR!;
  await browser.saveScreenshot(join(dir, `${name}.png`));
  await writeFile(join(dir, `${name}.json`), JSON.stringify(state, null, 2));
}

describe("项目 Token 断网恢复", () => {
  after(async () => {
    await tokenControl({ lifetimeSeconds: 600, networkDown: false }).catch(() => undefined);
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("PTN-01：冷缓存换证断网显示重连，恢复后原消息完成且不重复", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedPersistedModelSelection({
      modelId: E2E_PLAN_NON_DEFAULT_MODEL,
      providerId: INDIVIDUAL,
      reasoningLevel: "high",
    });
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedBigModelConnectionSelection({ kind: "individual-coding-plan" });
        await seedBigModelOAuthCredential();
      },
    });
    await waitForSelectedModel(INDIVIDUAL, E2E_PLAN_NON_DEFAULT_MODEL);

    // 先断网再等已签发的 PAT 过期：期间后台换证只会失败，不会再产生新的有效 Token。
    let state = await tokenControl({ networkDown: true });
    expect(state.lifetimeSeconds).toBe(SHORT_LIFETIME_SECONDS);
    expect(state.latestExpiresAtMs).toBeGreaterThan(0);
    await browser.waitUntil(async () => Date.now() > (await tokenControl({})).latestExpiresAtMs, {
      timeout: 20_000,
      timeoutMsg: "已签发的短寿命 PAT 没有过期",
    });
    const droppedBefore = (await tokenControl({})).droppedAttempts;

    await sendV4Prompt(`${MARKER}: reply briefly.`);
    await browser.waitUntil(async () => RECONNECTING.test(await browser.$("body").getText()), {
      timeout: 30_000,
      timeoutMsg: "换证断网后没有显示通用重连状态",
    });
    state = await tokenControl({});
    // 每次模型尝试在签发层最多 2 次 HTTP；进入重连说明至少完成了一次完整的模型尝试。
    expect(state.droppedAttempts - droppedBefore).toBeGreaterThanOrEqual(2);
    expect(await browser.$("body").getText()).not.toContain(PLAN_REPLY);
    await save("project-token-network-retrying", state);

    state = await tokenControl({ networkDown: false });
    await waitForV4TimelineContaining(PLAN_REPLY, 90_000);
    await waitForV4Pane((pane) => !pane.canStop, "网络恢复后任务没有结束");
    expect((await getV4Messages("user")).filter((row) => row.text.includes(MARKER))).toHaveLength(
      1,
    );
    expect(await browser.$('[data-testid="chat-error-banner"]').isExisting()).toBe(false);
    await save("project-token-network-recovered", await tokenControl({}));
  });
});
