import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ServiceChannels, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type { ProjectTree } from "@zcode/services";
import {
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_V4_MODEL_CONFIG,
  testId,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
} from "@zcode/shared/test-ids";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import {
  seedCustomOpenAIChatCompletionsProvider,
  refreshSeededOpenAIProvidersThroughSettings,
} from "#e2e/helpers/custom-openai-provider";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { openMobilePairingPage } from "#e2e/helpers/mobile-pairing";
import { disconnectRemoteSource } from "#e2e/helpers/remote-project-actions";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  prepareSSHLifecycle,
  connectSSHWorkspaceAndSendFirstTurn,
  waitForRendererAfterColdRestart,
  SSH_LIFECYCLE_MODEL_ID,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "#e2e/helpers/ssh-remote-lifecycle";
import { prepareSSHConnectionPage, waitForRemoteTab } from "#e2e/helpers/ssh-remote-p0";
import {
  getUpstreamProviderModelValues,
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";
import { WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS } from "#e2e/helpers/web-remote-control-session-events-fixture";
import { obtainUnreadPairingUrl, showMobileTaskHome } from "#e2e/helpers/web-remote-unread";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";

const CASE = "E2E_REMOTE_DRAFT_PREWARM";
const REPLY = "REMOTE_DRAFT_PREWARM_REPLY";
type Address = { path: string; identity?: string };
type Ack = { type: string; status: string; reasonCode?: string };
type ProbeWindow = Window & {
  __zcodeV4CommandAcksE2E?: Ack[];
  __zcodeTabStoreE2E?: {
    getState(): { activeWorkspacePath: string; activeWorkspaceIdentity?: string };
  };
  __zcodeSessionStoreE2E?: {
    getState(): {
      getWorkspaceState(
        path: string,
        identity?: string,
      ): { activeTaskId: string | null; draftProjectId?: string | null };
      startDraft(
        path: string,
        provider: undefined,
        identity: string,
        options: { projectId: null },
      ): void;
    };
  };
};

// 同时读取实际 Composer、workspace owner 与真实命令回执，不用模拟 createSession 结果。
function readDraft(address?: Address) {
  const w = window as ProbeWindow;
  const tab = w.__zcodeTabStoreE2E!.getState();
  const path = address?.path ?? tab.activeWorkspacePath;
  const identity = address?.identity ?? tab.activeWorkspaceIdentity;
  const state = w.__zcodeSessionStoreE2E!.getState().getWorkspaceState(path, identity);
  return {
    path,
    identity,
    activeTaskId: state.activeTaskId,
    projectId: state.draftProjectId ?? null,
    createAcks: (w.__zcodeV4CommandAcksE2E ?? []).filter((a) => a.type === "createSession"),
  };
}
function clearAcks() {
  (window as ProbeWindow).__zcodeV4CommandAcksE2E = [];
}

function assertNoCreateErrors(facts: ReturnType<typeof readDraft>) {
  expect(facts.createAcks.filter((a) => a.status !== "accepted")).toEqual([]);
}

describe(`${CASE}: 远端草稿先确定项目归属再预热`, () => {
  let provider: SSHLifecycleProvider | undefined;
  let task: SSHLifecycleTask;
  let mobile: Browser | undefined;
  let page: Page | undefined;
  const evidence: Record<string, unknown> = {};
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR!;

  after(async () => {
    await writeFile(
      resolve(artifactDir, "draft-prewarm-evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    await page
      ?.screenshot({ path: resolve(artifactDir, "mobile-last.png") })
      .catch(() => undefined);
    await mobile?.close();
    await restoreHandoffProbes();
    await provider?.tunnel.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("PD13–PD16：冷恢复缺归属不创建，项目恢复可首发，本地与手机路径可用", async function () {
    this.timeout(20 * 60_000);
    await prepareSSHConnectionPage(CASE);
    const prepared = await prepareSSHLifecycle(CASE);
    provider = prepared.provider;
    task = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE,
      config: prepared.config,
      provider,
      label: "A",
      workspacePath: prepared.config.workspacePaths[0],
    });
    const address = { path: task.workspacePath, identity: task.identity };
    const sourceId = parseRemoteWorkspaceIdentity(task.identity)!.sourceServerId!;
    await openWorkspaceDraftFromSidebar(task.workspacePath);
    const projectId = (await browser.execute(readDraft, address)).projectId;
    expect(projectId).toBeTruthy();

    for (const removeScope of [false, true]) {
      await disconnectRemoteSource(sourceId, CASE, { workspaceIdentities: [task.identity] });
      if (removeScope) {
        const removed = await browser.execute((identity) => {
          const keys = Object.keys(localStorage).filter(
            (k) => k.startsWith("zcode-composer-workspace-scope:v1:") && k.includes(identity),
          );
          keys.forEach((k) => localStorage.removeItem(k));
          return keys.length;
        }, task.identity);
        expect(removed).toBeGreaterThan(0);
      }
      // 保留 profile，完整重启 Electron/Main/Host；只删导航作用域，不改项目和会话事实。
      await reloadElectronSessionPreservingBrowserProfile(browser);
      await waitForRendererAfterColdRestart(CASE);
      await waitForRemoteTab({
        caseMarker: CASE,
        expectedIdentity: task.identity,
        expectedPath: task.workspacePath,
        requireActive: false,
      });
      if (!removeScope) {
        await browser.waitUntil(
          async () =>
            (await browser.execute(readDraft, address)).createAcks.some(
              (a) => a.status === "accepted",
            ),
          { timeout: 60_000, timeoutMsg: "PD13: 有归属的冷恢复未完成预热" },
        );
        const facts = await browser.execute(readDraft, address);
        evidence.savedScope = facts;
        expect(facts.projectId).toBe(projectId);
        assertNoCreateErrors(facts);
      } else {
        const input = $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`);
        await input.waitForDisplayed();
        await input.click();
        await browser.keys(`${CASE}_UNASSIGNED`);
        await browser.keys("Enter");
        // 负向观察窗口覆盖旧实现 0/500/1000/2000ms 四次自动创建；正向恢复另等真实 ACK。
        await browser.pause(4_500);
        const facts = await browser.execute(readDraft, address);
        evidence.missingScope = facts;
        await browser.saveScreenshot(resolve(artifactDir, "desktop-missing-scope.png"));
        expect(facts.projectId).toBeNull();
        expect(facts.createAcks).toEqual([]);
        expect(await input.getText()).toContain(`${CASE}_UNASSIGNED`);
        expect(await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled()).toBe(false);
      }
    }

    await browser.execute(clearAcks);
    await openWorkspaceDraftFromSidebar(task.workspacePath);
    await sendV4PromptAndWaitAccepted(
      `${CASE}_DESKTOP_RECOVERED`,
      `${CASE}_DESKTOP_RECOVERED`,
      "PD14: 选项目后首发未接纳",
    );
    await waitForV4AssistantMessageContaining(REPLY);
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE}_DESKTOP_RECOVERED`] },
      "远端首发没有到达 Provider",
    );
    const recovered = await waitForV4ConversationState(
      (s) => Boolean(s.taskId && s.state === "idle"),
      "PD14: 首发未完成",
    );
    evidence.desktopRecovered = await browser.execute(readDraft, address);
    assertNoCreateErrors(evidence.desktopRecovered as ReturnType<typeof readDraft>);
    await installHandoffRpcProbe();
    const assertOwnership = async (taskId: string, expected: string | null, hostId?: string) => {
      const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
        { hostId },
      ]);
      const row = tree.tasks.find((t) => t.taskId === taskId);
      expect(row?.projectId).toBe(expected);
      evidence[`owner-${taskId}`] = { projectId: row?.projectId, hostId: row?.hostId };
    };
    const hostId = `remote:server:${sourceId}`;
    await assertOwnership(recovered.taskId!, projectId, hostId);
    // 同一正式会话的续发也经过发送屏障，不能被缺少 draftProjectId 误挡。
    await sendV4PromptAndWaitAccepted(
      `${CASE}_DESKTOP_FOLLOW`,
      `${CASE}_DESKTOP_FOLLOW`,
      "PD16: 正式会话续发未接纳",
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE}_DESKTOP_FOLLOW`] },
      "正式会话续发没有到达 Provider",
    );
    await waitForV4ConversationState(
      (s) => s.taskId === recovered.taskId && s.state === "idle",
      "PD16: 正式会话续发未完成",
    );

    // 通用“新建”沿用当前项目；任务区专用入口才创建本地未归类草稿。
    await $('[data-testid="conversation-section"]').moveTo();
    await $('[data-testid="virtual-project-new-task"]').click();
    await browser.waitUntil(
      async () => {
        const facts = await browser.execute(readDraft, undefined);
        return !facts.identity && facts.projectId === null && facts.activeTaskId === null;
      },
      { timeout: 30_000, timeoutMsg: "PD16: 没有进入本地未归类草稿" },
    );

    const pairingUrl = await obtainUnreadPairingUrl();
    mobile = await chromium.launch({
      ...(process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE
        ? { executablePath: process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
      headless: true,
    });
    const context = await mobile.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    await context.addInitScript((credentials) => {
      for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
    }, WEB_REMOTE_CONTROL_FIXTURE_CREDENTIALS);
    page = await context.newPage();
    const rowSelector = `[data-project-id=${JSON.stringify(projectId)}]`;
    await openMobilePairingPage(page, pairingUrl, {
      artifactDir,
      caseMarker: CASE,
      phase: "draft-prewarm",
      readySelector: rowSelector,
    });
    const openMobileProject = async () => {
      await showMobileTaskHome(page!);
      const row = page!.locator(rowSelector).first();
      await row.hover();
      await row.getByTestId("virtual-project-create-task").click();
      await page!.waitForFunction(
        ({ path, identity, projectId }) => {
          const state = (window as ProbeWindow).__zcodeSessionStoreE2E
            ?.getState()
            .getWorkspaceState(path, identity);
          return state?.draftProjectId === projectId && !state.activeTaskId;
        },
        { ...address, projectId },
      );
    };
    const selectMobileModel = async () => {
      // 桌面与手机的 Recent 独立；手机必须经真实菜单选择 SSH 可达的回放 Provider。
      const values = getUpstreamProviderModelValues(SSH_LIFECYCLE_MODEL_ID, {
        providerId: provider!.id,
        includePlainModelFallback: false,
      });
      const trigger = page!.getByTestId(TID_CHAT_MODEL_SELECT_TRIGGER).first();
      if (!values.includes((await trigger.getAttribute("data-model-current-value")) ?? "")) {
        await trigger.click();
        await page!.getByTestId("composer-provider-trigger").click();
        await page!
          .getByTestId(testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${provider!.id}`))
          .click();
        const candidates = values
          .map(
            (value) => `[data-testid=${JSON.stringify(testId(TID_CHAT_MODEL_SELECT_ITEM, value))}]`,
          )
          .join(",");
        await page!.waitForFunction(
          ({ values, candidates }) =>
            values.includes(
              document
                .querySelector('[data-testid="chat-model-select-trigger"]')
                ?.getAttribute("data-model-current-value") ?? "",
            ) || Boolean(document.querySelector(candidates)),
          { values, candidates },
        );
        if (!values.includes((await trigger.getAttribute("data-model-current-value")) ?? ""))
          await page!.locator(candidates).first().click();
      }
      await page!.waitForFunction(
        (values) =>
          values.includes(
            document
              .querySelector('[data-testid="chat-model-select-trigger"]')
              ?.getAttribute("data-model-current-value") ?? "",
          ),
        values,
      );
      if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
      const toggle = page!.getByTestId("composer-thought-switch");
      const slider = page!.getByTestId("composer-thought-slider");
      if (await toggle.isVisible()) {
        expect(await toggle.getAttribute("data-off-value")).toBe("disabled");
        if ((await toggle.getAttribute("aria-checked")) !== "false") await toggle.click();
      } else if (await slider.isVisible()) {
        const levels = JSON.parse((await slider.getAttribute("data-levels")) ?? "[]") as string[];
        const index = levels.indexOf("disabled");
        expect(index).toBeGreaterThanOrEqual(0);
        await slider.press("Home");
        for (let i = 0; i < index; i++) await slider.press("ArrowRight");
      }
      await page!.keyboard.press("Escape");
      expect(await page!.getByTestId(TID_V4_MODEL_CONFIG).getAttribute("data-thought")).toBe(
        "disabled",
      );
    };
    const sendMobile = async (marker: string) => {
      await selectMobileModel();
      await page!.getByTestId(TID_V4_COMPOSER_INPUT).first().fill(marker);
      await page!.getByTestId(TID_V4_COMPOSER_SEND).first().click({ timeout: 60_000 });
      await page!.getByText(REPLY, { exact: false }).first().waitFor({ timeout: 90_000 });
      await waitForUpstreamRequest(
        { lastUserMessageIncludes: [marker] },
        "手机首发没有到达 Provider",
      );
      const facts = await page!.evaluate(readDraft, address);
      expect(facts.activeTaskId).toBeTruthy();
      assertNoCreateErrors(facts);
      await assertOwnership(facts.activeTaskId!, projectId, hostId);
      return facts;
    };
    await openMobileProject();
    evidence.mobileInitial = await sendMobile(`${CASE}_MOBILE_INITIAL`);
    await page.evaluate(clearAcks);
    // 手机正常导航显式交付项目；这里仅将缺失归属作为受控前置，后续恢复仍走真实 UI。
    await page.evaluate(({ path, identity }) => {
      (window as ProbeWindow)
        .__zcodeSessionStoreE2E!.getState()
        .startDraft(path, undefined, identity, { projectId: null });
    }, address);
    const input = page.getByTestId(TID_V4_COMPOSER_INPUT).first();
    await input.fill(`${CASE}_MOBILE_UNASSIGNED`);
    await input.press("Enter");
    await page.waitForTimeout(4_500);
    evidence.mobileMissing = await page.evaluate(readDraft, address);
    expect((evidence.mobileMissing as ReturnType<typeof readDraft>).projectId).toBeNull();
    expect((evidence.mobileMissing as ReturnType<typeof readDraft>).activeTaskId).toBeNull();
    expect((evidence.mobileMissing as ReturnType<typeof readDraft>).createAcks).toEqual([]);
    expect(await input.innerText()).toContain(`${CASE}_MOBILE_UNASSIGNED`);
    expect(await page.getByTestId(TID_V4_COMPOSER_SEND).first().isDisabled()).toBe(true);
    await page.screenshot({ path: resolve(artifactDir, "mobile-missing-scope.png") });
    await openMobileProject();
    evidence.mobileRecovered = await sendMobile(`${CASE}_MOBILE_RECOVERED`);

    // 远端 Provider 的 loopback 端口属于 SSH 目标；本地首发使用本轮本机 replay 入口。
    const localProvider = await seedCustomOpenAIChatCompletionsProvider({
      modelId: SSH_LIFECYCLE_MODEL_ID,
      providerId: "e2e-prewarm-local",
      providerName: "Draft prewarm local",
    });
    await refreshSeededOpenAIProvidersThroughSettings([localProvider.name], {
      workspacePath: (await browser.execute(readDraft, undefined)).path,
    });
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: localProvider.id,
      providerName: localProvider.name,
    });
    await selectUpstreamThoughtLevelValue("disabled");
    await sendV4PromptAndWaitAccepted(
      `${CASE}_LOCAL_UNCLASSIFIED`,
      `${CASE}_LOCAL_UNCLASSIFIED`,
      "PD16: 本地未归类首发未接纳",
    );
    await waitForV4AssistantMessageContaining(REPLY);
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE}_LOCAL_UNCLASSIFIED`] },
      "本地首发没有到达 Provider",
    );
    const local = await waitForV4ConversationState(
      (s) => Boolean(s.taskId && s.state === "idle"),
      "PD16: 本地未归类未完成",
    );
    evidence.local = await browser.execute(readDraft, undefined);
    expect((evidence.local as ReturnType<typeof readDraft>).identity).toBeFalsy();
    await assertOwnership(local.taskId!, null);
  });
});
