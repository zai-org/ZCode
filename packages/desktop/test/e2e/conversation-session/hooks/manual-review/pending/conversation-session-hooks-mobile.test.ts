import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import {
  TID_TASK_ITEM,
  TID_V4_HOOK_DETAILS_CONTENT,
  TID_V4_HOOK_DETAILS_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE, seedSettings } from "#e2e/helpers/desktop-app";
import { countUpstreamRequestsContaining } from "#e2e/helpers/conversation-session-network";
import {
  HOOKS_CASE_MARKERS,
  hasHookRecord,
  installHooksLifecycleFixture,
  restoreHooksLifecycleFixture,
  waitForHookScenarioTrace,
} from "#e2e/helpers/hooks-lifecycle-fixture";
import { openMobilePairingPage, seedMobileFixtureLogin } from "#e2e/helpers/mobile-pairing";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { selectUpstreamModel, selectUpstreamThoughtLevel } from "#e2e/helpers/upstream-provider";
import {
  getV4ConversationState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ConversationState,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";

// ZCT-2118215639243444224：Chrome 109 远控打开含 Hook 记录的会话，Hook 详情组件调用
// executions.toSorted 抛 TypeError，区域错误边界显示“这块界面出了点问题”。
// 本用例在手机 Web 打开同类会话并展开 Hook 详情；默认用新版 Chrome 做回归，
// 设置 ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE 可换成低版本浏览器验证 polyfill。
const CASE_MARKER = "HK-MOB-01";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/hooks-mobile");
const REGION_ERROR_TEXT = /这块界面出了点问题|This section ran into a problem/u;

describe("Hook 详情手机 Web 远控", () => {
  before(async function () {
    this.timeout(120000);
    await installHooksLifecycleFixture();
    await seedSettings({ locale: "zh-CN", localePreference: "zh-CN" });
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await restoreHooksLifecycleFixture();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it(`${CASE_MARKER}: 手机打开含 Hook 记录的会话，Hook 详情可展开且不触发区域错误`, async function () {
    this.timeout(240000);
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await selectUpstreamModel();
    await selectUpstreamThoughtLevel();
    // UserPromptSubmit Hook 在模型前拦截，只产生 Hook 记录，不需要上游回放。
    const marker = HOOKS_CASE_MARKERS.promptBlock;
    await sendV4Prompt(`${marker}: this prompt must be blocked before the model.`);
    await waitForV4TimelineContaining(marker);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && Boolean(snapshot.taskId),
      "Hook 拦截后会话没有回到 idle",
      60000,
    );
    await waitForHookScenarioTrace(
      marker,
      (records) =>
        hasHookRecord(records, {
          executor: "process",
          hook_event_name: "UserPromptSubmit",
          phase: "completed",
        }),
      "UserPromptSubmit Hook 没有执行完成",
    );
    expect(await countUpstreamRequestsContaining(marker)).toBe(0);
    const taskId = (await getV4ConversationState()).taskId;
    if (!taskId) throw new Error("Hook 会话缺少 taskId");
    const triggerTestId = await browser.waitUntil(
      () =>
        browser.execute(
          (text: string, prefix: string) =>
            Array.from(document.querySelectorAll<HTMLElement>("[data-turn-id]"))
              .find((turn) => turn.textContent?.includes(text))
              ?.querySelector<HTMLElement>(`[data-testid^="${prefix}-"]`)
              ?.getAttribute("data-testid") ?? false,
          marker,
          TID_V4_HOOK_DETAILS_TRIGGER,
        ),
      { timeout: 15000, timeoutMsg: "桌面端没有出现 Hook 详情入口" },
    );
    const turnId = triggerTestId.slice(TID_V4_HOOK_DETAILS_TRIGGER.length + 1);

    const endpoint = process.env.ZCODE_WEB_REMOTE_CONTROL_URL;
    if (!endpoint) throw new Error("mobile fixture missing");
    const pairingUrl = await obtainUnreadPairingUrl(new URL(endpoint).origin);
    const executablePath = process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE;
    const chrome = await chromium.launch({
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      headless: true,
    });
    const pageErrors: string[] = [];
    try {
      const context = await chrome.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: "zh-CN",
      });
      await seedMobileFixtureLogin(context);
      const page = await context.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await openMobilePairingPage(page, pairingUrl, {
        artifactDir,
        caseMarker: CASE_MARKER,
        phase: "pairing",
        readySelector: '[data-testid="sidebar"], [data-mobile-page="chat"]',
      });
      const browserVersion = chrome.version();
      await showMobileTaskHome(page);
      const toggles = page.getByTestId("virtual-project-toggle");
      for (let index = 0; index < (await toggles.count()); index++) {
        const toggle = toggles.nth(index);
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      }
      await mkdir(artifactDir, { recursive: true });
      const content = page.getByTestId(testId(TID_V4_HOOK_DETAILS_CONTENT, turnId));
      try {
        await page.getByTestId(testId(TID_TASK_ITEM, taskId)).first().click();
        const session = page.locator(`[data-session-id="${taskId}"]`);
        await session.getByText(marker, { exact: false }).first().waitFor({ timeout: 30000 });
        const trigger = session.getByTestId(testId(TID_V4_HOOK_DETAILS_TRIGGER, turnId));
        await trigger.waitFor({ timeout: 30000 });
        await trigger.click();
        await content.waitFor({ timeout: 15000 });
      } catch (error) {
        // 区域错误边界会替换整轮内容，等待超时时需要现场文本与截图区分原因。
        await page.screenshot({ path: resolve(artifactDir, `${CASE_MARKER}-failure.png`) });
        await writeFile(
          resolve(artifactDir, `${CASE_MARKER}-failure.json`),
          JSON.stringify(
            { browserVersion, bodyText: await page.locator("body").innerText(), pageErrors },
            null,
            2,
          ),
        );
        throw error;
      }
      const contentText = (await content.textContent()) ?? "";
      const bodyText = await page.locator("body").innerText();
      await page.screenshot({ path: resolve(artifactDir, `${CASE_MARKER}-mobile.png`) });
      await writeFile(
        resolve(artifactDir, `${CASE_MARKER}.json`),
        JSON.stringify({ browserVersion, taskId, turnId, contentText, pageErrors }, null, 2),
      );
      expect(contentText).toContain("UserPromptSubmit");
      expect(REGION_ERROR_TEXT.test(bodyText)).toBe(false);
      expect(pageErrors).toEqual([]);
    } finally {
      await chrome.close();
    }
  });
});
