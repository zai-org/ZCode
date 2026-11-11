import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { ServiceChannels } from "@zcode/shared";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import type { WindowHostControllerTaskListResult } from "@zcode/services";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import {
  holdProjectUnread,
  releaseProjectUnread,
  restoreProjectUnreadProbe,
} from "#e2e/helpers/project-unread-probe";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import {
  ensureProjectExpanded,
  projectSectionSelector,
  selectRemoteProjectDirectory,
  startDraftFromProject,
} from "#e2e/helpers/project-sidebar";
import {
  prepareSSHLifecycle,
  SSH_LIFECYCLE_MODEL_ID,
  SSH_LIFECYCLE_THOUGHT_LEVEL,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  connectSSHWorkspace,
  readRemoteTabSnapshot,
  runSSHCommand,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  approveV4Permission,
  sendV4PromptAndWaitAccepted,
  selectV4TaskById,
  startNewV4Draft,
  switchV4Mode,
  waitForV4ConversationState,
  waitForV4PermissionDialog,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";
const CASE_MARKER = "E2E_SSH_NEW_PROJECT_SIDEBAR";
const EXISTING_PROMPT = "E2E_SSH_NEW_PROJECT_SIDEBAR_EXISTING";
const EXISTING_REPLY = "SSH_NEW_PROJECT_EXISTING_DONE";
const PROMPT = "E2E_SSH_NEW_PROJECT_SIDEBAR_WRITE";
const REPLY = "SSH_NEW_PROJECT_SIDEBAR_DONE";
const FOREGROUND_PROMPT = "E2E_SSH_NEW_PROJECT_SIDEBAR_FOREGROUND";
const FOREGROUND_REPLY = "SSH_NEW_PROJECT_FOREGROUND_DONE";
const SIBLING_PROMPT = "E2E_SSH_NEW_PROJECT_SIDEBAR_SIBLING";
const SIBLING_REPLY = "SSH_NEW_PROJECT_SIBLING_DONE";
const NAVIGATION_PROMPT = "E2E_SSH_NEW_PROJECT_SIDEBAR_NAVIGATION";
const NAVIGATION_REPLY = "SSH_NEW_PROJECT_NAVIGATION_DONE";
const OUTPUT_PATH = ".zcode-e2e/ssh-new-project-sidebar/output.txt";
interface SidebarState {
  exists: boolean;
  running: boolean;
  waiting: boolean;
  unread: boolean;
}
async function waitForSidebarState(taskId: string, expected: Omit<SidebarState, "exists">) {
  let latest: SidebarState | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await browser.execute(
          (taskTestId) => {
            const row = document.querySelector(`[data-testid="${taskTestId}"]`);
            return {
              exists: Boolean(row),
              running: Boolean(row?.querySelector(".animate-spin")),
              waiting: Boolean(
                row?.querySelector('[data-task-interaction-badge="permission"]') ||
                Array.from(row?.querySelectorAll('[data-slot="badge"]') ?? []).some((badge) =>
                  /^(等待确认|Awaiting approval)$/.test(badge.textContent?.trim() ?? ""),
                ),
              ),
              unread: Boolean(row?.querySelector('[data-unread-indicator="true"]')),
            };
          },
          testId(TID_TASK_ITEM, taskId),
        );
        return (
          latest.exists &&
          latest.running === expected.running &&
          latest.waiting === expected.waiting &&
          latest.unread === expected.unread
        );
      },
      { timeout: 30_000, interval: 100 },
    );
  } catch (cause) {
    const navigation = await browser.execute(() => {
      const target = window as Window & {
        __zcodeTabStoreE2E?: {
          getState(): {
            activeTabId?: string;
            activeWorkspaceIdentity?: string;
            activeWorkspacePath?: string;
            tabs?: Array<{
              id: string;
              workspaceIdentity?: string;
              workspacePath?: string;
              remoteSessionId?: string;
            }>;
          };
        };
        __zcodeSessionStoreE2E?: {
          getState(): {
            workspaces?: Record<string, { activeTaskId?: string }>;
            taskNavHistory?: unknown;
          };
        };
      };
      const tabs = target.__zcodeTabStoreE2E?.getState();
      const state = target.__zcodeSessionStoreE2E?.getState();
      const tab = tabs?.tabs?.find((item) => item.id === tabs.activeTabId);
      return {
        activeTab: tab
          ? {
              id: tab.id,
              workspaceIdentity: tab.workspaceIdentity,
              workspacePath: tab.workspacePath,
              remoteSessionId: tab.remoteSessionId,
            }
          : null,
        activeWorkspaceIdentity: tabs?.activeWorkspaceIdentity,
        activeWorkspacePath: tabs?.activeWorkspacePath,
        activeTasks: Object.entries(state?.workspaces ?? {}).map(([workspaceKey, item]) => ({
          workspaceKey,
          taskId: item.activeTaskId,
        })),
        taskNavHistory: state?.taskNavHistory,
      };
    });
    if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR, "sidebar-failure-state.json"),
        JSON.stringify({ taskId, expected, latest, navigation }, null, 2),
      );
      await saveStateScreenshot("sidebar-state-failure");
    }
    throw new Error(
      `${CASE_MARKER}: 侧栏状态未收敛 expected=${JSON.stringify(expected)} actual=${JSON.stringify(latest)}`,
      { cause },
    );
  }
}
describe(`${CASE_MARKER}: 新建远程项目首次任务的侧栏实时状态`, () => {
  let provider: SSHLifecycleProvider | null = null;
  after(async () => {
    await restoreProjectUnreadProbe();
    await restoreHandoffProbes();
    await provider?.tunnel.close().catch(() => undefined);
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("SSH-P0-TASK-04 云图标、首发权限和后台未读无需重启，打开后清除未读", async function () {
    this.timeout(20 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, { apiType: "anthropic-messages" });
    provider = prepared.provider;
    await installHandoffRpcProbe();
    const [existingPath, workspacePath] = prepared.config.workspacePaths;
    await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      workspacePath: existingPath,
    });
    // 新建项目会自动选中当前草稿；先完成 A 的真实会话，使 B 保持未打开，保留首次绑定边界。
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: provider.id,
      providerName: provider.name,
    });
    await selectUpstreamThoughtLevelValue(SSH_LIFECYCLE_THOUGHT_LEVEL);
    await sendV4PromptAndWaitAccepted(
      `${EXISTING_PROMPT}: 只回复 ${EXISTING_REPLY}`,
      EXISTING_PROMPT,
      "A 项目前置会话未接受",
    );
    await waitForV4TimelineContaining(EXISTING_REPLY, 60_000);
    await waitForV4ConversationState(
      (snapshot) =>
        Boolean(snapshot.taskId && snapshot.taskId !== "draft" && snapshot.state === "idle"),
      "A 项目前置会话未完成",
      60_000,
    );
    const existingSection = $(projectSectionSelector(existingPath));
    const hostId = await existingSection.getAttribute("data-project-host");
    expect(hostId).toMatch(/^remote:server:/);
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    await $('[data-testid="virtual-project-device"]').click();
    await $(`[role="option"][data-device-id=${JSON.stringify(hostId)}]`).click();
    await selectRemoteProjectDirectory(workspacePath);
    await $('[data-testid="virtual-project-name"]').setValue(workspacePath.split("/").at(-1)!);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await ensureProjectExpanded(workspacePath);
    // 原因：新空项目树曾只从已有任务生成 identity 映射。先创建第二个未打开的项目，
    // 等项目行发布及状态订阅，再首次绑定并发消息；预先打开 B 会掩盖绑定前的订阅错误。
    const section = $(projectSectionSelector(workspacePath));
    expect(await section.$$(`[data-testid^="${TID_TASK_ITEM}-"]`).length).toBe(0);
    expect((await readRemoteTabSnapshot(undefined, workspacePath)).remoteSessionId).toBeNull();
    await section.$('[data-remote-state-icon="cloud"]').waitForExist({ timeout: 15_000 });
    await startDraftFromProject(workspacePath);
    const tab = await waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: workspacePath });
    expect(tab.remoteSessionId).toBeTruthy();
    if (!tab.workspaceIdentity) throw new Error("Missing remote workspace identity");
    expect(tab.remoteKind).toBe("ssh");
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: provider.id,
      providerName: provider.name,
    });
    await selectUpstreamThoughtLevelValue(SSH_LIFECYCLE_THOUGHT_LEVEL);
    await switchV4Mode("build");
    await sendV4PromptAndWaitAccepted(
      `${PROMPT}: 创建测试文件后回复 ${REPLY}`,
      PROMPT,
      "首发未接受",
    );
    const state = await waitForV4ConversationState(
      (snapshot) => Boolean(snapshot.taskId && snapshot.taskId !== "draft"),
      "首次远程任务未建立",
      60_000,
    );
    if (!state.taskId) throw new Error("Missing remote task id");
    const taskId = state.taskId;
    await waitForV4PermissionDialog();
    await waitForSidebarState(taskId, { running: true, waiting: true, unread: false });
    await saveStateScreenshot("first-permission");
    expect(await approveV4Permission()).toBe(true);
    await waitForUpstreamRequest(
      { includes: [PROMPT, "toolu_ssh_new_project_write"] },
      "批准后未收到真实 tool_result",
      60_000,
    );
    await waitForV4TimelineContaining(REPLY, 60_000);
    await waitForSidebarState(taskId, { running: true, waiting: false, unread: false });
    const file = await runSSHCommand(prepared.config, `cat '${workspacePath}/${OUTPUT_PATH}'`);
    expect(file.code).toBe(0);
    expect(file.stdout).toBe("SSH_NEW_PROJECT_FILE\n");
    // 由 fixture release 确定后台完成的顺序，不靠 sleep 猜测模型完成时间。
    await startNewV4Draft();
    await releaseControlledReplay("ssh-new-project-complete");
    await waitForSidebarState(taskId, { running: false, waiting: false, unread: true });
    await saveStateScreenshot("background-unread");
    await selectV4TaskById(taskId, 30_000);
    await waitForV4TimelineContaining(REPLY);
    await waitForSidebarState(taskId, { running: false, waiting: false, unread: false });
    const after = await readRemoteTabSnapshot(tab.workspaceIdentity, workspacePath);
    expect(after.workspaceIdentity).toBe(tab.workspaceIdentity);
    expect(after.remoteSessionId).toBe(tab.remoteSessionId);

    // 旧 Host 先等待列表读取再发完成信号，前台已查看的完成会在切走后被误判成后台未读。
    // 这里验证真实 SSH 用户闭环；读取暂挂期间的精确导航顺序由 Host/renderer 集成单测控制。
    await sendV4PromptAndWaitAccepted(
      `${FOREGROUND_PROMPT}: 只回复 ${FOREGROUND_REPLY}`,
      FOREGROUND_PROMPT,
      "前台续发未接受",
    );
    await waitForV4TimelineContaining(FOREGROUND_REPLY, 60_000);
    await releaseControlledReplay("ssh-new-project-foreground");
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === taskId && snapshot.state === "idle",
      "前台续发未完成",
      60_000,
    );
    await startNewV4Draft();
    // 核对真实 Controller 投影与 UI；缓存查询不保证等待全部 IO，精确在途时序由集成单测覆盖。
    const settled = await callHandoffHost<WindowHostControllerTaskListResult>(
      ServiceChannels.WindowController,
      "listTaskList",
      [
        {
          kind: "active",
          workspaceScopes: [{ workspacePath, workspaceIdentity: tab.workspaceIdentity }],
          sortBy: "updated",
        },
      ],
    );
    const completed = settled.items.find((item) => item.taskId === taskId);
    expect(completed).toBeDefined();
    expect(completed?.unreadAt).toBeUndefined();
    await waitForSidebarState(taskId, { running: false, waiting: false, unread: false });
    await saveStateScreenshot("foreground-completed-read");
    // T2 先就绪，再从 T1 切到 A。回到 B/T2 的 tab 中间态不能吞掉 T1 的后台完成。
    await startDraftFromProject(workspacePath);
    expect(
      (await readRemoteTabSnapshot(tab.workspaceIdentity, workspacePath)).activeWorkspaceIdentity,
    ).toBe(tab.workspaceIdentity);
    await sendV4PromptAndWaitAccepted(
      `${SIBLING_PROMPT}: 只回复 ${SIBLING_REPLY}`,
      SIBLING_PROMPT,
      "T2 未接受",
    );
    await waitForV4TimelineContaining(SIBLING_REPLY, 60_000);
    const sibling = await waitForV4ConversationState(
      (snapshot) =>
        Boolean(
          snapshot.taskId &&
          snapshot.taskId !== "draft" &&
          snapshot.taskId !== taskId &&
          snapshot.state === "idle",
        ),
      "T2 未完成",
      60_000,
    );
    if (!sibling.taskId) throw new Error("Missing sibling task id");
    await selectV4TaskById(taskId);
    await sendV4PromptAndWaitAccepted(
      `${NAVIGATION_PROMPT}: 只回复 ${NAVIGATION_REPLY}`,
      NAVIGATION_PROMPT,
      "T1 续发未接受",
    );
    await waitForV4TimelineContaining(NAVIGATION_REPLY, 60_000);
    await startDraftFromProject(existingPath);
    expect(
      (await readRemoteTabSnapshot(tab.workspaceIdentity, workspacePath)).activeWorkspaceIdentity,
    ).not.toBe(tab.workspaceIdentity);
    const cachedTask = await browser.execute((identity) => {
      const target = window as Window & {
        __zcodeSessionStoreE2E?: {
          getState(): { workspaces: Record<string, { activeTaskId: string | null }> };
        };
      };
      return target.__zcodeSessionStoreE2E?.getState().workspaces[identity]?.activeTaskId;
    }, tab.workspaceIdentity);
    expect(cachedTask).toBe(taskId);
    await holdProjectUnread(taskId, tab.workspaceIdentity);
    await releaseControlledReplay("ssh-new-project-navigation");
    await browser.waitUntil(
      () => browser.execute(() => Boolean(window.__projectUnreadProbe?.held)),
      {
        timeout: 30_000,
        timeoutMsg: "T1 后台完成未触发未读命令",
      },
    );
    await selectV4TaskById(sibling.taskId);
    await waitForV4TimelineContaining(SIBLING_REPLY);
    await releaseProjectUnread();
    await waitForSidebarState(taskId, { running: false, waiting: false, unread: true });
    const unread = await callHandoffHost<WindowHostControllerTaskListResult>(
      ServiceChannels.WindowController,
      "listTaskList",
      [
        {
          kind: "active",
          workspaceScopes: [{ workspacePath, workspaceIdentity: tab.workspaceIdentity }],
          sortBy: "updated",
        },
      ],
    );
    expect(unread.items.find((item) => item.taskId === taskId)?.unreadAt).toEqual(
      expect.any(Number),
    );
    await saveStateScreenshot("cross-workspace-sibling-keeps-unread");
    await restoreProjectUnreadProbe();
    await selectV4TaskById(taskId);
    await waitForSidebarState(taskId, { running: false, waiting: false, unread: false });
    await captureRemoteProjectThemes();
  });
});
async function saveStateScreenshot(name: string) {
  if (process.env.ZCODE_E2E_ARTIFACT_DIR)
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR, `${name}.png`));
}
/** 390px 是桌面 renderer 窄屏视觉证据，不冒充手机 replayable 路径。 */
async function captureRemoteProjectThemes() {
  const emulate = (width?: number) =>
    browser.electron.execute(async (electron, width) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (item) => !item.isDestroyed() && item.isVisible(),
      );
      if (!window) throw new Error("Missing renderer window");
      if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand(
        width ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
        width ? { width, height: 844, deviceScaleFactor: 1, mobile: false } : {},
      );
    }, width);
  const setTheme = (theme: string) =>
    browser.execute((theme) => {
      const actions = (window as Window & { __testActions?: { setTheme(theme: string): void } })
        .__testActions;
      if (!actions) throw new Error("Missing theme actions");
      actions.setTheme(theme);
    }, theme);
  try {
    for (const width of [1200, 390]) {
      await emulate(width);
      await browser.waitUntil(() => browser.execute((width) => innerWidth === width, width));
      await browser.executeAsync((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      const sidebarVisible = await browser.execute(() => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        const rect = sidebar?.getBoundingClientRect();
        return Boolean(
          rect &&
          rect.right > 0 &&
          rect.left < innerWidth &&
          rect.width > 0 &&
          sidebar?.closest("aside")?.getAttribute("aria-hidden") !== "true",
        );
      });
      if (!sidebarVisible) {
        await $('button[aria-label="Toggle sidebar"],button[aria-label="切换侧边栏"]').click();
      }
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const rect = document
              .querySelector('[data-testid="project-section"]')
              ?.getBoundingClientRect();
            return Boolean(
              rect &&
              rect.left >= 0 &&
              rect.right <= innerWidth &&
              document.querySelector("aside")?.getAttribute("aria-hidden") === "false",
            );
          }),
        { timeout: 10_000, timeoutMsg: "窄屏侧栏未显示，不能保存无目标视觉证据" },
      );
      for (const theme of ["zai-light", "zai-dark"]) {
        await setTheme(theme);
        await browser.waitUntil(() =>
          browser.execute(
            (theme) => document.documentElement.classList.contains(`theme-${theme}`),
            theme,
          ),
        );
        await saveStateScreenshot(`remote-cloud-${width}-${theme}`);
      }
    }
  } finally {
    await emulate();
    await setTheme("zai-light");
  }
}
