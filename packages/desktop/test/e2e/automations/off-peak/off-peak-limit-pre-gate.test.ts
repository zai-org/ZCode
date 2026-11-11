import {
  restartIntoWorkspace,
  seedBigModelConnectionSelection,
  seedBigModelOAuthCredential,
} from "#e2e/helpers/model-provider-restart";
import { TID_OFFPEAK_CREATE_BUTTON, TID_AUTOMATIONS_OPEN } from "@zcode/shared/test-ids";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAppData,
  clickTestIdByDom,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";
import { loginWithApiKey } from "#e2e/helpers/conversation-session";

/**
 * 闲时任务「服务端额度快照前置置灰」端到端（D39）。
 *
 * 由进程内 mock 网关驱动（wdio.conf startOffPeakE2EMock：本 spec 命中时额外设
 * ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS=3600000）。client/configs 不再下发 limit，
 * UI 通过 GET /ticket/availability 得到 can_take_number=false + next_take_at。
 *
 * 断言：入口加载后创建按钮提前置灰，Tooltip 同时说明额度耗尽和服务端恢复时间。
 * 全程带 pause 并在关键态截图（ZCODE_OFFPEAK_SHOT_DIR）供录屏 review。
 */
// Bugfix：硬编码系统临时目录在 Windows 不可用，默认截图目录必须跟随运行平台。
const SHOT_DIR = process.env.ZCODE_OFFPEAK_SHOT_DIR ?? join(tmpdir(), "zc-offpeak-verify-shots");
let shotSeq = 0;
async function shot(label: string): Promise<void> {
  shotSeq += 1;
  const name = `${String(shotSeq).padStart(2, "0")}-${label}.png`;
  try {
    await browser.saveScreenshot(join(SHOT_DIR, name));
  } catch {
    // 截图失败不阻塞断言（录屏为辅）。
  }
}

describe("闲时任务服务端额度快照置灰 E2E（D39）", () => {
  before(() => {
    try {
      mkdirSync(SHOT_DIR, { recursive: true });
    } catch {
      // ignore
    }
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("availability 不可创建时按钮置灰并显示 next_take_at", async function () {
    this.timeout(150000);

    // 会话就绪：登录（若停在欢迎页）+ 默认工作区就绪即可进 Automations（在 Settings 内），
    // 不走 startNewTask 的对话草稿流程（与 off-peak 无关）。off-peak mock 网关免真实模型请求。
    try {
      await waitForDefaultWorkspaceReady(30000);
    } catch {
      await loginWithApiKey();
      await waitForDefaultWorkspaceReady(30000);
    }

    // 网关只替代曝光和取票；Registry 模型需要真实的隔离账号与连接前置。
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedBigModelConnectionSelection({ kind: "individual-coding-plan" });
        await seedBigModelOAuthCredential();
      },
    });
    // 1) 打开 Automations 主视图。
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "侧栏没有出现 Automations 入口",
    });
    await browser.pause(2500); // 录屏：停在主视图，展示初始按钮态
    await shot("automations-open");

    // 2) availability=false：按钮应在实际 POST /ticket 前置灰。
    await browser.waitUntil(async () => (await offPeakCreateButtonState()).present, {
      timeout: 10000,
      timeoutMsg: "闲时任务创建按钮没有出现（灰度未命中？）",
    });
    // 回归用户截图中的大字号场景，确保相对时长文案仍完整落在 Tooltip 背景内。
    await browser.execute(() => {
      document.documentElement.style.setProperty("--ui-font-size", "20px");
    });
    const state = await offPeakCreateButtonState();
    if (!state.disabled) {
      throw new Error("服务端额度不可用时，创建按钮应提前置灰");
    }
    if (!state.tooltip || !/额度|limit/i.test(state.tooltip)) {
      throw new Error(`额度置灰必须显示 Tooltip：${state.tooltip ?? "<empty>"}`);
    }
    if (!/(小时|分钟|hr|min)/i.test(state.tooltip)) {
      throw new Error(`额度 Tooltip 必须包含小时/分钟剩余时长：${state.tooltip}`);
    }
    if (/\d{4}|年|月|日/.test(state.tooltip)) {
      throw new Error(`额度 Tooltip 不应展示年月日或绝对日期：${state.tooltip}`);
    }
    if (!state.contentContained) {
      throw new Error("额度 Tooltip 文案必须完整包含在背景内");
    }
    await shot("create-button-quota-disabled");
    await browser.pause(3000); // 录屏：停在额度置灰态，展示最终效果
  });
});

/** 创建按钮当前态：是否存在 / 是否 disabled / Radix Tooltip 文案。 */
async function offPeakCreateButtonState(): Promise<{
  present: boolean;
  disabled: boolean;
  tooltip: string | null;
  contentContained: boolean;
}> {
  const state = await browser.execute((btnTid) => {
    const button = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === btnTid,
    );
    if (!(button instanceof HTMLButtonElement)) {
      return { present: false, disabled: false };
    }
    return {
      present: true,
      disabled: button.disabled,
    };
  }, TID_OFFPEAK_CREATE_BUTTON);

  if (!state.present) {
    return { ...state, tooltip: null, contentContained: false };
  }
  const button = await $(`[data-testid="${TID_OFFPEAK_CREATE_BUTTON}"]`);
  const trigger = await button.$("..");
  // Radix Tooltip 依赖真实 pointer enter/leave 生命周期；合成的单个 pointermove 不会更新其
  // 内部 hover 状态，所以用 WebDriver 悬停并等待 portal 进入 open 状态。
  await trigger.moveTo();
  await browser.waitUntil(
    () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-slot='tooltip-content']")).some(
          (item) => item.dataset.state !== "closed",
        ),
      ),
    { timeout: 5_000, timeoutMsg: "额度 Tooltip 没有在真实悬停后打开" },
  );
  const tooltip = await browser.execute(() => {
    const content = Array.from(
      document.querySelectorAll<HTMLElement>("[data-slot='tooltip-content']"),
    ).find((item) => item.dataset.state !== "closed");
    // ControlHintTooltip 的正文令牌已从 text-ui-base 收敛到 text-ui-sm；tooltip 已经
    // 真实打开，旧 E2E 因查询旧 class 而把有效文案误判为空。
    const title = content?.querySelector<HTMLElement>(":scope > span.text-ui-sm");
    if (!content || !title) {
      return { text: null, contentContained: false };
    }
    const contentRect = content.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    return {
      text: title.textContent?.trim() ?? null,
      contentContained:
        titleRect.left >= contentRect.left - 0.5 &&
        titleRect.right <= contentRect.right + 0.5 &&
        titleRect.top >= contentRect.top - 0.5 &&
        titleRect.bottom <= contentRect.bottom + 0.5,
    };
  });
  return {
    ...state,
    tooltip: tooltip.text,
    contentContained: tooltip.contentContained,
  };
}
