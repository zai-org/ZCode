import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
/**
 * 正式 E2E —— Workspace Hook Trust 软门禁与逐条持久信任（HK05–HK07）。
 * 已通过人工 review 并由 e2e:promote 从 manual-review/pending 晋级，
 * 随默认 spec 发现进入常规回归门禁；fixture 走 case-local provider replay。
 *
 * 证据分层：
 * - UI/交互：composer Hook 图标浮层、Settings 钩子行内“信任”按钮、锁定 Switch
 * - Runtime：`.hook-trust-e2e/executions.jsonl` 执行证据（未信任零执行、不补跑、
 *   信任后自然事件执行）
 * - 持久化：`<E2E_HOME>/.zcode/security/workspace-hook-trust-v1.json` 精确落盘
 *
 * fixture 由 wdio.conf.ts 在 beforeSession 阶段（resetE2EHome 内）落盘，
 * 首个 agent 进程冷启动即加载 workspace hooks；spec 内不重复安装。
 */
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER,
  TID_V4_WORKSPACE_HOOK_PENDING_UNREAD,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_WORKSPACE_HOOK_PENDING_POPOVER,
  TID_V4_WORKSPACE_HOOK_PENDING_DISMISS,
  TID_V4_WORKSPACE_HOOK_PENDING_REVIEW,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { sel } from "#e2e/helpers/selectors";
import {
  E2E_HOOK_TRUST_LABELS,
  readHookTrustExecutions,
  readHookTrustStore,
  waitForHookTrustExecution,
  waitForHookTrustStoreRecords,
} from "#e2e/helpers/hook-trust-fixture";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const HOOKS_SECTION_SELECTOR = '[data-testid="hooks-settings-section"]';
const HOOK_ROW_SELECTOR = '//div[@data-testid="configured-hook-row"]';
// 信任按钮通过 ShieldCheck 图标定位（lucide class），不依赖 locale 文案。
const TRUST_BUTTON_IN_ROW = './/button[.//*[contains(@class, "lucide-shield-check")]]';

describe("Workspace Hook Trust (HK05–HK07)", () => {
  before(async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("HK05: 未信任 Hook 被软门禁跳过，图标浮层引导进设置，行内只提供信任与锁定开关", async function () {
    this.timeout(180000);

    expect(await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER)).isExisting()).toBe(false);
    await sendV4Prompt("E2E_HOOK_TRUST: reply with ok");
    await waitForIdle("Soft-gated turn did not return to idle");

    // 软门禁不阻塞对话，且未信任 Hook 零执行。
    const trigger = $(sel(TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER));
    await trigger.waitForDisplayed({ timeout: 30000 });
    expect(await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_UNREAD)).isDisplayed()).toBe(true);
    expect(await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_POPOVER)).isExisting()).toBe(false);
    expect(await $('[data-testid="v4-workspace-hook-pending-banner"]').isExisting()).toBe(false);
    const adjacent = await browser.execute(
      (modeId, hookId) => {
        const mode = document.querySelector(`[data-testid="${modeId}"]`)!;
        const hook = document.querySelector(`[data-testid="${hookId}"]`)!;
        const a = mode.getBoundingClientRect();
        const b = hook.getBoundingClientRect();
        return b.left >= a.right && b.left - a.right <= 12 && Math.abs(a.top - b.top) <= 2;
      },
      TID_CHAT_MODE_SELECT_TRIGGER,
      TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER,
    );
    expect(adjacent).toBe(true);
    await trigger.click();
    await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_POPOVER)).waitForDisplayed();
    expect(await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_UNREAD)).isExisting()).toBe(false);
    await browser.keys("Escape");
    await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_POPOVER)).waitForDisplayed({ reverse: true });
    expect(await trigger.isFocused()).toBe(true);
    await browser.keys("Enter");
    await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_POPOVER)).waitForDisplayed();
    expect(await readHookTrustExecutions()).toHaveLength(0);

    // 从 composer Hook 图标浮层 进入 设置 → 钩子。
    await clickTestIdByDom(TID_V4_WORKSPACE_HOOK_PENDING_REVIEW, {
      timeout: 15000,
    });
    await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "hooks"), {
      timeout: 15000,
    });
    await $(HOOKS_SECTION_SELECTOR).waitForDisplayed({ timeout: 15000 });

    // 三条 workspace Hook 声明全部未信任：只有“信任”按钮 + 锁定关闭的开关，
    // 没有其他审核动作（Allow once / Trust all / Keep blocked 均不存在）。
    await waitForHookTrustRowCount(3);
    for (const label of Object.values(E2E_HOOK_TRUST_LABELS)) {
      await assertUntrustedHookRow(label);
    }

    // 忽略图标 是 renderer 本地行为，不产生 Trust mutation。
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15000,
    });
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    expect(await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_UNREAD)).isExisting()).toBe(false);
    await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER)).click();
    await clickTestIdByDom(TID_V4_WORKSPACE_HOOK_PENDING_DISMISS, {
      timeout: 15000,
    });
    await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_POPOVER)).waitForDisplayed({
      timeout: 15000,
      reverse: true,
    });
    expect(await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER)).isExisting()).toBe(false);
    expect(await readHookTrustStore()).toBeNull();
  });

  it("HK06: 行内信任单条声明，只对该条精确持久落盘，其余行保持可审核", async function () {
    this.timeout(180000);

    await openHooksSettings();

    const trustButton = await findTrustButton(E2E_HOOK_TRUST_LABELS.sessionStartA);
    await trustButton.waitForDisplayed({ timeout: 15000 });
    await trustButton.click();

    const records = await waitForHookTrustStoreRecords(
      (items) => items.length === 1,
      "Trusting session-start-a did not persist exactly one store record",
    );
    expect(records[0]!.decision).toBe("trusted");
    expect(records[0]!.eventAtGrant).toBe("SessionStart");

    // 被信任的行按钮消失；其余两条仍显示“信任”。
    await assertNoTrustButton(E2E_HOOK_TRUST_LABELS.sessionStartA);
    for (const label of [E2E_HOOK_TRUST_LABELS.sessionStartB, E2E_HOOK_TRUST_LABELS.promptSubmit]) {
      await (await findTrustButton(label)).waitForDisplayed({ timeout: 15000 });
    }

    await closeHooksSettings();
  });

  it("HK07: 信任不补跑已跳过的 SessionStart，只作用于未来自然事件", async function () {
    this.timeout(240000);

    // 第一段（同 task）：信任 UserPromptSubmit 后再发一条 prompt，
    // 出现 prompt-submit 记录 = 信任只作用于未来自然事件；
    // 全程无 SessionStart 记录 = 已信任的 session-start-a 不补跑。
    await openHooksSettings();
    await clickTrustButton(E2E_HOOK_TRUST_LABELS.promptSubmit);
    await waitForHookTrustStoreRecords(
      (items) => items.length === 2,
      "Trusting prompt-submit did not persist a second store record",
    );
    await closeHooksSettings();

    await sendV4Prompt("E2E_HOOK_TRUST second prompt: reply with ok");
    await waitForHookTrustExecution(
      E2E_HOOK_TRUST_LABELS.promptSubmit,
      "Trusted UserPromptSubmit hook did not run on next natural prompt",
    );
    await waitForIdle("Second turn did not return to idle");

    const inTaskExecutions = await readHookTrustExecutions();
    expect(inTaskExecutions.filter((item) => item.event === "SessionStart")).toHaveLength(0);
    expect(inTaskExecutions.some((item) => item.label === E2E_HOOK_TRUST_LABELS.promptSubmit)).toBe(
      true,
    );

    // 第二段（新 task）：catalog HK07 字面语义——新 task 的自然 SessionStart
    // 按 Trust 执行。该路径与 UserPromptSubmit 不同：覆盖新 session 冷启动时
    // 的配置发现、trust store 读取与 admission 评估全链路，不以"语义等价"省略。
    // 全局新建会分配虚拟目录；Hook、Skill 与会话候选必须继续使用夹具所属项目。
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await sendV4Prompt("E2E_HOOK_TRUST new task: reply with ok");
    await waitForHookTrustExecution(
      E2E_HOOK_TRUST_LABELS.sessionStartA,
      "Trusted SessionStart hook did not run on the next natural session start",
    );
    await waitForIdle("New-task turn did not return to idle");

    await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_UNREAD)).waitForDisplayed();
    const executions = await readHookTrustExecutions();
    // 已信任的 a 在新 task 自然 SessionStart 执行且仅执行一次；
    // 未信任的 b 仍被软门禁跳过。
    expect(
      executions.filter((item) => item.label === E2E_HOOK_TRUST_LABELS.sessionStartA),
    ).toHaveLength(1);
    expect(executions.some((item) => item.label === E2E_HOOK_TRUST_LABELS.sessionStartB)).toBe(
      false,
    );
    // 响应式验收放在项目导航之后，避免窄视口影响后续侧栏操作。
    await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_TRIGGER)).click();
    await verifyHookReminderLayouts();
    await browser.keys("Escape");
    await $(sel(TID_V4_WORKSPACE_HOOK_PENDING_POPOVER)).waitForDisplayed({ reverse: true });
  });
});

async function verifyHookReminderLayouts(): Promise<void> {
  const original = await browser.execute(() => {
    const actions = (
      window as typeof window & {
        __testActions: { getTheme(): string; getLocale(): string };
      }
    ).__testActions;
    return { theme: actions.getTheme(), locale: actions.getLocale() };
  });
  try {
    for (const width of [1200, 390]) {
      await browser.electron.execute(async (electron, width) => {
        const target = electron.BrowserWindow.getAllWindows().find(
          (w) => w.isVisible() && !w.isDestroyed(),
        )!;
        if (!target.webContents.debugger.isAttached()) target.webContents.debugger.attach("1.3");
        await target.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: false,
        });
      }, width);
      for (const theme of ["zai-light", "zai-dark"]) {
        for (const locale of ["zh-CN", "en-US"]) {
          await browser.execute(
            ({ theme, locale }) => {
              const actions = (
                window as typeof window & {
                  __testActions: { setTheme(value: string): void; setLocale(value: string): void };
                }
              ).__testActions;
              actions.setTheme(theme);
              actions.setLocale(locale);
            },
            { theme, locale },
          );
          const popover = $(sel(TID_V4_WORKSPACE_HOOK_PENDING_POPOVER));
          await expect(popover).toHaveText(
            expect.stringContaining(
              locale === "zh-CN" ? "工作区 Hook 待审核" : "workspace hook(s) pending review",
            ),
          );
          await browser.waitUntil(() =>
            browser.execute((id) => {
              const rect = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
              return (
                rect.left >= 0 &&
                rect.right <= innerWidth &&
                rect.top >= 0 &&
                rect.bottom <= innerHeight
              );
            }, TID_V4_WORKSPACE_HOOK_PENDING_POPOVER),
          );
          await browser.saveScreenshot(
            `.e2e-artifacts/hook-reminder-${width}-${theme}-${locale}.png`,
          );
        }
      }
    }
  } finally {
    await browser.electron.execute(async (electron) => {
      const target = electron.BrowserWindow.getAllWindows().find(
        (w) => w.isVisible() && !w.isDestroyed(),
      )!;
      await target.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    });
    await browser.execute(({ theme, locale }) => {
      const actions = (
        window as typeof window & {
          __testActions: { setTheme(value: string): void; setLocale(value: string): void };
        }
      ).__testActions;
      actions.setTheme(theme);
      actions.setLocale(locale);
    }, original);
  }
}

async function waitForIdle(timeoutMsg: string): Promise<void> {
  await waitForV4Pane(
    (snapshot) =>
      snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
    timeoutMsg,
    60000,
  );
}

async function openHooksSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "Hook trust E2E could not open Settings",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "hooks"), {
    timeout: 15000,
  });
  await $(HOOKS_SECTION_SELECTOR).waitForDisplayed({ timeout: 15000 });
}

async function closeHooksSettings(): Promise<void> {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "Hook trust E2E could not leave Settings",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
}

async function waitForHookTrustRowCount(count: number): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (expected: number) =>
          Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid="configured-hook-row"]'),
          ).filter((row) => row.innerText.includes("hook-trust-")).length === expected,
        count,
      ),
    {
      timeout: 15000,
      timeoutMsg: `Hooks settings did not render ${count} workspace hook rows`,
    },
  );
}

function hookRowSelector(label: string): string {
  return `${HOOK_ROW_SELECTOR}[contains(., "${label}")]`;
}

async function findTrustButton(label: string) {
  const row = await $(hookRowSelector(label));
  await row.waitForDisplayed({ timeout: 15000 });
  return await row.$(TRUST_BUTTON_IN_ROW);
}

async function clickTrustButton(label: string): Promise<void> {
  await (await findTrustButton(label)).click();
}

async function assertNoTrustButton(label: string): Promise<void> {
  const row = await $(hookRowSelector(label));
  await row.waitForDisplayed({ timeout: 15000 });
  await (
    await row.$(TRUST_BUTTON_IN_ROW)
  ).waitForExist({
    timeout: 15000,
    reverse: true,
  });
}

async function assertUntrustedHookRow(label: string): Promise<void> {
  const row = await $(hookRowSelector(label));
  await row.waitForDisplayed({ timeout: 15000 });

  const buttons = await row.$$("button");
  // 行内动作只有“信任”按钮和 Switch 两个 button；不存在任何额外审核动作或徽章入口。
  expect(buttons).toHaveLength(2);

  const trustButton = await row.$(TRUST_BUTTON_IN_ROW);
  await trustButton.waitForDisplayed({ timeout: 15000 });
  expect(await trustButton.isEnabled()).toBe(true);

  // 未信任行 Switch 强制关闭并锁定。
  const switchControl = await row.$('button[role="switch"]');
  await switchControl.waitForDisplayed({ timeout: 15000 });
  expect(await switchControl.getAttribute("aria-checked")).toBe("false");
  expect(await switchControl.getAttribute("disabled")).not.toBeNull();
}
