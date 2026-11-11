import { DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
// NSE01-NSE04/NSE09：增强 Find/Grep 只在根 Session runtime 物化时读取全局设置。
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_NATIVE_SEARCH_SWITCH,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_TOOL_SUMMARY_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, readSettings } from "#e2e/helpers/desktop-app";
import {
  expandAssistantHistoriesWithContent,
  expandVisibleSummaryGroups,
  getToolCallDiagnostics,
} from "#e2e/helpers/conversation-session-tool-diagnostics";
import { restartIntoWorkspace } from "#e2e/helpers/model-provider-restart";
import {
  approveV4Permission,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const INITIAL_TOOL_CALL_ID = "toolu_e2e_nse_enabled_initial";
const ACTIVE_TOOL_CALL_ID = "toolu_e2e_nse_enabled_active";
const DISABLED_TOOL_CALL_ID = "toolu_e2e_nse_disabled_new";
const ENABLED_COLD_RESUME_TOOL_CALL_ID = "toolu_e2e_nse_enabled_cold_resume";
const DISABLED_COLD_RESUME_TOOL_CALL_ID = "toolu_e2e_nse_disabled_cold_resume";

describe("增强 Find 与 Grep Session 生命周期", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("默认启用，active Session 保持原值，新建和冷恢复 Session 读取最新设置", async () => {
    await prepareV4ConversationE2E();

    await openNativeSearchSettings();
    expect(await readNativeSearchSwitch()).toBe(true);
    await closeSettings();

    await sendV4Prompt("E2E_NSE_ENABLED_INITIAL 执行增强搜索版本检查");
    expect(await approveV4Permission()).toBe(true);
    await waitForV4TimelineContaining("E2E_NSE_ENABLED_INITIAL_DONE", 60_000);
    const initialSessionId = await requireActiveSessionId();
    const initialOutput = await waitForBashOutput(INITIAL_TOOL_CALL_ID);
    assertEnabledOutput(initialOutput);
    const expectedRgVersion = readRgVersion(initialOutput);

    await setNativeSearchEnhancementsEnabled(false, initialSessionId);
    await openNativeSearchSettings();
    expect(await readNativeSearchSwitch()).toBe(false);
    await closeSettings(initialSessionId);

    await sendV4Prompt("E2E_NSE_ENABLED_ACTIVE 切换设置后检查当前会话");
    expect(await approveV4Permission()).toBe(true);
    await waitForV4TimelineContaining("E2E_NSE_ENABLED_ACTIVE_DONE", 60_000);
    expect(await requireActiveSessionId()).toBe(initialSessionId);
    const activeOutput = await waitForBashOutput(ACTIVE_TOOL_CALL_ID);
    assertEnabledOutput(activeOutput);
    expect(readRgVersion(activeOutput)).toBe(expectedRgVersion);

    // 冷恢复夹具固定在项目目录；全局新建会创建独立 cwd，不能复用该目录的记录器。
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await sendV4Prompt("E2E_NSE_DISABLED_NEW 检查关闭增强搜索后的新会话");
    expect(await approveV4Permission()).toBe(true);
    await waitForV4TimelineContaining("E2E_NSE_DISABLED_NEW_DONE", 60_000);
    const disabledSessionId = await requireActiveSessionId();
    expect(disabledSessionId).not.toBe(initialSessionId);
    const disabledOutput = await waitForBashOutput(DISABLED_TOOL_CALL_ID);
    assertDisabledOutput(disabledOutput);
    expect(readRgVersion(disabledOutput)).toBe(expectedRgVersion);

    await setNativeSearchEnhancementsEnabled(true, disabledSessionId);
    await restartIntoWorkspace();
    await openNativeSearchSettings();
    expect(await readNativeSearchSwitch()).toBe(true);
    await closeSettings();

    await selectV4TaskById(disabledSessionId);
    await sendV4Prompt("E2E_NSE_ENABLED_COLD_RESUME 冷恢复后检查最新设置");
    expect(await approveV4Permission()).toBe(true);
    await waitForV4TimelineContaining("E2E_NSE_ENABLED_COLD_RESUME_DONE", 60_000);
    const enabledColdResumeOutput = await waitForBashOutput(ENABLED_COLD_RESUME_TOOL_CALL_ID);
    assertEnabledOutput(enabledColdResumeOutput);
    expect(readRgVersion(enabledColdResumeOutput)).toBe(expectedRgVersion);

    await setNativeSearchEnhancementsEnabled(false, disabledSessionId);
    await restartIntoWorkspace();
    await openNativeSearchSettings();
    expect(await readNativeSearchSwitch()).toBe(false);
    await closeSettings();

    await selectV4TaskById(disabledSessionId);
    await sendV4Prompt("E2E_NSE_DISABLED_COLD_RESUME 冷恢复后检查最新关闭设置");
    expect(await approveV4Permission()).toBe(true);
    await waitForV4TimelineContaining("E2E_NSE_DISABLED_COLD_RESUME_DONE", 60_000);
    const disabledColdResumeOutput = await waitForBashOutput(DISABLED_COLD_RESUME_TOOL_CALL_ID);
    assertDisabledOutput(disabledColdResumeOutput);
    expect(readRgVersion(disabledColdResumeOutput)).toBe(expectedRgVersion);
  });
});

async function openNativeSearchSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        (settingsPageTestId) =>
          Boolean(document.querySelector(`[data-testid="${settingsPageTestId}"]`)),
        TID_SETTINGS_PAGE,
      ),
    { timeout: 15_000, timeoutMsg: "设置页没有打开" },
  );
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有行为与工具分区入口",
  });
  await browser.waitUntil(async () => (await readNativeSearchSwitch()) !== null, {
    timeout: 15_000,
    timeoutMsg: "行为与工具设置没有增强 Find 与 Grep 开关",
  });
}

async function closeSettings(expectedSessionId?: string): Promise<void> {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForV4Pane(
    (snapshot) =>
      expectedSessionId ? snapshot.sessionId === expectedSessionId : snapshot.sessionId !== null,
    expectedSessionId
      ? `返回工作区后没有恢复 Session ${expectedSessionId}`
      : "返回工作区后 V4 pane 没有恢复",
    30_000,
  );
}

async function setNativeSearchEnhancementsEnabled(
  enabled: boolean,
  expectedSessionId: string,
): Promise<void> {
  await openNativeSearchSettings();
  if ((await readNativeSearchSwitch()) !== enabled) {
    await clickTestIdByDom(TID_SETTINGS_NATIVE_SEARCH_SWITCH, {
      timeout: 15_000,
      timeoutMsg: "增强 Find 与 Grep 开关不可点击",
    });
  }
  await browser.waitUntil(
    async () => {
      const checked = await readNativeSearchSwitch();
      const persisted = (await readSettings()).nativeSearchEnhancementsEnabled;
      return checked === enabled && persisted === enabled;
    },
    {
      timeout: 15_000,
      timeoutMsg: `增强 Find 与 Grep 设置没有持久化为 ${String(enabled)}`,
    },
  );
  await closeSettings(expectedSessionId);
}

function readNativeSearchSwitch(): Promise<boolean | null> {
  return browser.execute((switchTestId) => {
    const control = document.querySelector<HTMLElement>(`[data-testid="${switchTestId}"]`);
    if (!control) return null;
    return (
      control.getAttribute("aria-checked") === "true" ||
      control.getAttribute("data-state") === "checked"
    );
  }, TID_SETTINGS_NATIVE_SEARCH_SWITCH);
}

async function requireActiveSessionId(): Promise<string> {
  const sessionId = (await getV4PaneSnapshot()).sessionId;
  if (!sessionId || sessionId === "draft") {
    throw new Error(`V4 pane 没有活动 Session: ${String(sessionId)}`);
  }
  return sessionId;
}

async function waitForBashOutput(toolCallId: string): Promise<string> {
  let latestOutput: string | null = null;
  await browser.waitUntil(
    async () => {
      await expandAssistantHistoriesWithContent();
      await expandVisibleSummaryGroups();
      await browser.execute(
        (id, summaryTriggerPrefix) => {
          const block = document.querySelector<HTMLElement>(`[data-tool-call-id="${id}"]`);
          const trigger = block?.querySelector<HTMLElement>(
            `[data-testid^="${summaryTriggerPrefix}-"][aria-expanded]`,
          );
          if (trigger?.getAttribute("aria-expanded") === "false") {
            trigger.click();
          }
        },
        toolCallId,
        TID_TOOL_SUMMARY_TRIGGER,
      );
      const diagnostics = await getToolCallDiagnostics({
        type: "toolCallId",
        value: toolCallId,
      });
      latestOutput = diagnostics.matchedBlock?.text ?? null;
      return (
        diagnostics.matchedBlock?.status === "completed" &&
        latestOutput?.includes("ripgrep ") === true
      );
    },
    {
      timeout: 60_000,
      timeoutMsg: `没有读取到 Bash 真实输出: ${toolCallId}`,
    },
  );
  if (!latestOutput) {
    throw new Error(`Bash 输出为空: ${toolCallId}`);
  }
  return normalizeOutput(latestOutput);
}

function assertEnabledOutput(output: string): void {
  expect(output).toContain("grep-kind=function");
  expect(output).toContain("ugrep 7.8.4");
  expect(output).toContain("ripgrep ");
  if (process.platform === "win32") {
    expect(output).toContain("find-kind=file");
    expect(output).toContain("GNU findutils");
  } else {
    expect(output).toContain("find-kind=function");
    expect(output).toContain("bfs 4.1.1");
  }
}

function assertDisabledOutput(output: string): void {
  expect(output).toContain("find-kind=file");
  expect(output).toContain("grep-kind=file");
  expect(output).toContain("__E2E_NSE_FIND_RESULT__\n.");
  expect(output).toContain("__E2E_NSE_GREP_RESULT__\nneedle");
  expect(output).toContain("ripgrep ");
  expect(output).not.toContain("bfs 4.1.1");
  expect(output).not.toContain("ugrep 7.8.4");
}

function readRgVersion(output: string): string {
  const version = output.match(/ripgrep [^\n]+/)?.[0]?.trim();
  if (!version) throw new Error(`Bash 输出缺少 ripgrep 版本: ${output}`);
  return version;
}

function normalizeOutput(output: string): string {
  return output.replaceAll("\\", "/").replaceAll("\r\n", "\n");
}
