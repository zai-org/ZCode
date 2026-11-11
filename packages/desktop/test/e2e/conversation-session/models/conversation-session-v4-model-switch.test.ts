// M4 门禁：switchModelConfig（v4 控制条模型配置表单）。
// 证据层 L3：建立 session → 填 provider/model/thought 应用 → switchModelConfig 命令 →
// v4-bridge → app.setModel + emitModelSelected → ModelSelected 事件 → reducer onModelSelected →
// config.provider/model/thought 更新（首次选型不产 marker）→ 控制条 data-* 同步。
// 证明模型切换全链路（ModelSelected 补发 + config 投影 + 通用配置表单 UI）。
import { clearAppData } from "#e2e/helpers/desktop-app";
import { UPSTREAM_MODEL, UPSTREAM_PROVIDER_ID } from "#e2e/helpers/upstream-provider";
import {
  getV4ModelConfig,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Model,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

describe("v4 M4 门禁：switchModelConfig", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("建立 session → 应用模型配置（thought=max）→ config 投影更新", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_MODEL_SWITCH_SEED 建立会话");
    await waitForV4TimelineContaining("V4_MODEL_SWITCH_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null,
      "会话没有建立",
      45000,
    );

    // 切换到已注册的当前模型 + thought=max（保证 setModel 目录解析成功）
    await switchV4Model(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL, "max");

    // config 投影更新为目标值
    await browser.waitUntil(
      async () => {
        const cfg = await getV4ModelConfig();
        return cfg.model === UPSTREAM_MODEL && cfg.thought === "max";
      },
      { timeout: 30000, timeoutMsg: "模型 config 没有更新为目标值" },
    );
    const cfg = await getV4ModelConfig();
    expect(cfg.provider).toBe(UPSTREAM_PROVIDER_ID);
    expect(cfg.model).toBe(UPSTREAM_MODEL);
    expect(cfg.thought).toBe("max");
  });
});
