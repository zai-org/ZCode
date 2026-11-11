import {
  TID_AUTOMATIONS_PAGE_TAB,
  TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM,
  TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_TRIGGER,
  type DynamicWorkflowMode,
} from "@zcode/shared";
import {
  TID_AUTOMATIONS_OPEN,
  TID_CHAT_ATTACHMENT_BUTTON,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  clickTestIdByWebDriver,
  setInputValueByTestIdDom,
} from "./desktop-app.js";
import { sel } from "./selectors.js";
import { getV4SlashOptionIds, hasV4SlashPanel } from "./v4-conversation.js";
import {
  DYNAMIC_WORKFLOW_CONFIG_MOCK_STATUS_PATH,
  type DynamicWorkflowConfigMockStatus,
} from "./dynamic-workflow-config-mock-server.js";

// 动态工作流灰度 DWG-08 的共享定位与观测原语。两个档位 spec（disabled / alwaysOn）
// 做的是同一组动作、相反的断言，定位逻辑只写一遍，避免两份副本各自漂移。
// 契约见 docs/dynamic-workflow/launch.md「Gray release: the `dynamicWorkflow` feature key」。

/** 输入框 `+` 面板（ChatPromptActionMenu）的容器选择器，与 PLUS 用例同源。 */
export const PLUS_MENU_PANEL_SELECTOR = '[data-trigger="+"]';

/** `/` 面板里目标命令的候选项 id；灰度关闭也必须在场，是 catalog 已送达的正向对照。 */
export const SLASH_GOAL_OPTION_ID = "slash:goal";
/** `/` 面板里工作流命令的候选项 id；灰度关闭时整条被剔除。 */
export const SLASH_WORKFLOW_OPTION_ID = "slash:workflow";
/** `+` 面板里目标 / 工作流两个「添加」项的 option id。 */
export const PLUS_GOAL_OPTION_ID = "add-goal";
export const PLUS_WORKFLOW_OPTION_ID = "add-workflow";

/** 自动化页内容容器；灰度两档都在场，用来把「页面没渲染」和「标签不在场」区分开。 */
export const AUTOMATIONS_CONTENT_SELECTOR = "[data-automations-content]";

export function automationsPageTabTestId(tab: "automation" | "workflow"): string {
  return testId(TID_AUTOMATIONS_PAGE_TAB, tab);
}

/** 读 case-local 配置网关的观测端点，证明 Host 真的从这台 mock 取过灰度快照。 */
export async function readDynamicWorkflowGrayMockStatus(): Promise<DynamicWorkflowConfigMockStatus> {
  const origin = process.env.ZCODE_TEST_BASE_URL;
  if (!origin) throw new Error("缺少动态工作流灰度的 case-local 配置网关");
  const response = await fetch(new URL(DYNAMIC_WORKFLOW_CONFIG_MOCK_STATUS_PATH, origin));
  return (await response.json()) as DynamicWorkflowConfigMockStatus;
}

export async function setComposerDraft(text: string): Promise<void> {
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, text, {
    stabilizeLexicalCaretAtEnd: true,
  });
}

/**
 * 打开 `/` 面板并等 CLI catalog 送达：等的是 `goal`，它不参与灰度，两档都必然出现。
 * 用它当屏障，后面对 `workflow` 的在场 / 缺席断言才不会退化成「catalog 还没到」。
 */
export async function openSlashPanelWithCatalogReady(timeout = 30000): Promise<string[]> {
  await setComposerDraft("/");
  await browser.waitUntil(
    async () =>
      (await hasV4SlashPanel()) && (await getV4SlashOptionIds()).includes(SLASH_GOAL_OPTION_ID),
    {
      timeout,
      timeoutMsg: `slash 面板没有出现 catalog 屏障候选项: ${SLASH_GOAL_OPTION_ID}`,
    },
  );
  return await getV4SlashOptionIds();
}

export async function closeSlashPanel(): Promise<void> {
  await browser.keys("Escape");
  await setComposerDraft("");
}

/** 空草稿下打开 `+` 面板。菜单在打开瞬间快照 catalog，调用前必须先等 catalog 就绪。 */
export async function openPlusMenu(): Promise<void> {
  await clickTestIdByDom(TID_CHAT_ATTACHMENT_BUTTON, {
    timeoutMsg: "输入框没有出现 + 入口",
  });
  await $(PLUS_MENU_PANEL_SELECTOR).waitForDisplayed();
}

export async function closePlusMenu(): Promise<void> {
  await browser.keys("Escape");
  await $(PLUS_MENU_PANEL_SELECTOR).waitForDisplayed({ reverse: true });
}

/** `+` 面板里全部「添加」项的 option id，按 DOM 顺序。 */
export async function readPlusMenuAddOptionIds(): Promise<string[]> {
  return await browser.execute(
    (selector) =>
      Array.from(document.querySelectorAll(`${selector} [data-option-id^="add-"]`)).map(
        (element) => element.getAttribute("data-option-id") ?? "",
      ),
    PLUS_MENU_PANEL_SELECTOR,
  );
}

/** 从侧栏进入自动化页，并等页面内容容器渲染。 */
export async function openAutomationsPage(): Promise<void> {
  // 原因：设置页背后仍挂载侧栏 DOM；直接 DOM click 会命中用户不可见的入口，设置遮罩仍在。
  // 先从设置返回工作区，再按真实指针路径进入自动化页。
  const settings = $(sel(TID_SETTINGS_PAGE));
  if (await settings.isDisplayed()) {
    await clickTestIdByWebDriver(TID_SETTINGS_BACK_BUTTON);
    await settings.waitForDisplayed({ reverse: true });
  }
  await clickTestIdByWebDriver(TID_AUTOMATIONS_OPEN, {
    timeoutMsg: "侧栏没有出现自动化入口",
  });
  await $(AUTOMATIONS_CONTENT_SELECTOR).waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "自动化页内容没有渲染",
  });
}

export function hasTestIdInDom(target: string): Promise<boolean> {
  return browser.execute(
    (current) =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
        (element) => element.dataset.testid === current,
      ),
    target,
  );
}

/**
 * 在一段观察窗内持续断言某个 test id 不出现。
 * 灰度关闭是「不在场」断言：一次性快照无法把「关掉了」和「还没渲染出来」分开，
 * 必须在屏障之后再观察一段时间，确认它不会迟到。
 */
export async function expectTestIdAbsentThroughout(
  target: string,
  { windowMs = 3000, intervalMs = 200 }: { windowMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (await hasTestIdInDom(target)) {
      throw new Error(`灰度关闭时不应出现的 test id 迟到出现: ${target}`);
    }
    await browser.pause(intervalMs);
  }
}

/** 打开设置 › Agent 能力 › 行为与工具（动态工作流模式行所在的分区，launch.md「The user's choice」）。 */
export async function openAgentBehaviorSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"), {
    timeout: 15000,
    timeoutMsg: "设置页没有出现行为与工具分区入口",
  });
}

/** 打开模式下拉并读出每个选项是否带「默认」标签（按选项的 test id 后缀）。 */
export async function openDynamicWorkflowModeSelect(): Promise<void> {
  await clickTestIdByWebDriver(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_TRIGGER, {
    timeout: 15000,
    timeoutMsg: "动态工作流模式下拉触发器没有出现",
  });
  await $(sel(testId(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM, "alwaysOn"))).waitForDisplayed({
    timeout: 15000,
    timeoutMsg: "动态工作流模式下拉没有展开",
  });
}

export async function selectDynamicWorkflowMode(mode: DynamicWorkflowMode): Promise<void> {
  await openDynamicWorkflowModeSelect();
  await clickTestIdByDom(testId(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM, mode), {
    timeout: 15000,
    timeoutMsg: `动态工作流模式选项没有出现: ${mode}`,
  });
}

export function readDynamicWorkflowModeTriggerText(): Promise<string> {
  return $(sel(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_TRIGGER)).getText();
}
