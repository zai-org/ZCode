import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { ProjectTree, RemoteProjectDirectory } from "@zcode/services";
import { ServiceChannels, type SourceServerManagementSnapshot } from "@zcode/shared";
import {
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_SETTINGS_PAGE,
  TID_SSH_DIALOG,
  TID_SSH_ERROR,
  TID_TASK_ITEM,
  TID_VIRTUAL_PROJECT_CREATE_TASK,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  getV4ComposerAttachments,
  getV4ComposerText,
  pasteV4ComposerFileAttachment,
  prepareV4ConversationE2E,
  setV4ComposerText,
  selectV4TaskById,
} from "#e2e/helpers/v4-conversation";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  readSSHRuntimeConfig,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";

const marker = "E2E_CHAT_DEVICE_RETURN";
const projectName = `${marker}_PROJECT`;
const draft = `${marker} keep text, attachment and project`;
const directory = () =>
  callHandoffHost<RemoteProjectDirectory>(ServiceChannels.RemoteProjects, "readDirectory");

async function openFromChat(locale = "zh-CN", evidence?: string) {
  await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
  const entry = $(`[data-testid="${TID_COMPOSER_REMOTE_CONNECTION}"]`);
  await entry.waitForDisplayed();
  expect(await entry.getText()).toBe(
    locale === "zh-CN" ? "新建远程连接…" : "New remote connection…",
  );
  if (evidence) {
    await settlePresentation();
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `menu-${evidence}.png`));
  }
  await entry.click();
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed();
  await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForDisplayed();
  await $('[data-testid="composer-project-menu"]').waitForExist({ reverse: true });
}
function readChatIdentity() {
  return browser.execute(() => {
    const windowState = window as Window & {
      __zcodeTabStoreE2E?: {
        getState(): { activeWorkspacePath: string | null; activeWorkspaceIdentity: string | null };
      };
      __zcodeSessionStoreE2E?: {
        getState(): {
          workspaces: Record<
            string,
            { activeTaskId: string | null; draftProjectId?: string | null }
          >;
        };
      };
    };
    const tabs = windowState.__zcodeTabStoreE2E!.getState();
    const workspaceKey = tabs.activeWorkspaceIdentity?.trim() || tabs.activeWorkspacePath!;
    const workspace = windowState.__zcodeSessionStoreE2E!.getState().workspaces[workspaceKey]!;
    return {
      workspaceKey,
      workspacePath: tabs.activeWorkspacePath!,
      workspaceIdentity: tabs.activeWorkspaceIdentity,
      activeTaskId: workspace.activeTaskId,
      projectId: workspace.draftProjectId,
    };
  });
}
async function readTaskIdentity(taskId: string) {
  const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree");
  const task = tree.tasks.find((item) => item.taskId === taskId);
  if (!task) throw new Error(`${marker}: original task missing`);
  return {
    taskId: task.taskId,
    hostId: task.hostId,
    projectId: task.projectId,
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
  };
}

async function createOriginalTask(target: Awaited<ReturnType<typeof readChatIdentity>>) {
  if (!target.projectId) throw new Error(`${marker}: project selection is not committed`);
  const result = await callHandoffHost<{ session: { sessionId: string } }>(
    ServiceChannels.ZCodeAgent,
    "createSession",
    [
      {
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        projectId: target.projectId,
        persistence: "immediate",
        importedHistory: {
          source: "claudeCode",
          title: `${marker}_ORIGINAL_TASK`,
          messages: [
            { role: "user", content: `${marker}_ORIGINAL_TASK` },
            { role: "assistant", content: "Original task remains on its device" },
          ],
        },
      },
    ],
  );
  const taskId = result.session.sessionId;
  await callHandoffHost(ServiceChannels.ZCodeTask, "resumeTask", [
    { taskId, workspacePath: target.workspacePath },
  ]);
  const toggle = $(
    `[data-project-id="${target.projectId}"] [data-testid="virtual-project-toggle"]`,
  );
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await $(`[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`).waitForDisplayed();
  await selectV4TaskById(taskId);
  const project = $(`[data-project-id="${target.projectId}"]`);
  await project.moveTo();
  await project.$(`[data-testid="${TID_VIRTUAL_PROJECT_CREATE_TASK}"]`).click();
  return taskId;
}

async function applyAppearance(locale: string, theme: string, width: number) {
  await browser.execute(
    (language, color) => {
      const actions = (
        window as Window & {
          __testActions?: { setLocale(locale: string): void; setTheme(theme: string): void };
        }
      ).__testActions;
      actions?.setLocale(language);
      actions?.setTheme(color);
    },
    locale,
    theme,
  );
  await browser.electron.execute((electron, size) => {
    electron.BrowserWindow.getAllWindows()
      .find((window) => window.isVisible())
      ?.setSize(size, 900);
  }, width);
  await browser.waitUntil(() =>
    browser.execute(
      (dark) => document.documentElement.classList.contains("dark") === dark,
      theme === "dark",
    ),
  );
  await settlePresentation();
}
async function settlePresentation() {
  await browser.executeAsync((done) => {
    const animations = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === "running" &&
          animation.effect?.getComputedTiming().iterations !== Infinity,
      );
    void Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(
      () => requestAnimationFrame(() => done()),
    );
  });
}

async function assertChatUnchanged() {
  await browser.waitUntil(async () => (await getV4ComposerText()) === draft);
  expect(await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).getText()).toContain(
    projectName,
  );
  expect(await getV4ComposerAttachments()).toEqual([
    expect.objectContaining({
      text: expect.stringContaining(`${marker}.txt`),
      uploadStatus: "ready",
    }),
  ]);
}

describe(marker, () => {
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      const focus = await browser.execute(() => ({
        active: {
          tag: document.activeElement?.tagName,
          testId: document.activeElement?.getAttribute("data-testid"),
        },
        events: (window as Window & { __chatDeviceFocus?: unknown[] }).__chatDeviceFocus,
      }));
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "chat-device-focus.json"),
        JSON.stringify(focus, null, 2),
      );
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "chat-device-failure.png"),
      );
    }
  });
  after(async () => {
    await restoreHandoffProbes();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RDUX21-04/13/19/22 本地项目连接后必选目录，取消保留任务和草稿", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(marker);
    await prepareV4ConversationE2E({ skipProvider: true });
    await installHandoffRpcProbe();
    await browser.execute(() => {
      (
        window as Window & { __testActions?: { setLocale(locale: string): void } }
      ).__testActions?.setLocale("zh-CN");
    });
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').setValue(projectName);
    await $('[data-testid="virtual-project-save"]').click();
    await $(`[data-project-name="${projectName}"]`).waitForDisplayed();
    await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
    await $(`[data-testid="composer-project-menu"] [data-project-name="${projectName}"]`).click();
    await browser.waitUntil(async () =>
      (await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).getText()).includes(
        projectName,
      ),
    );
    const originalScope = await readChatIdentity();
    const taskId = await createOriginalTask(originalScope);
    const taskIdentity = await readTaskIdentity(taskId);
    expect(taskIdentity).toMatchObject({
      hostId: "local",
      projectId: originalScope.projectId,
      workspacePath: originalScope.workspacePath,
    });
    await setV4ComposerText(draft);
    await pasteV4ComposerFileAttachment(`${marker}.txt`, {
      base64: Buffer.from("attachment retained across settings").toString("base64"),
      mimeType: "text/plain",
    });
    await browser.waitUntil(
      async () => (await getV4ComposerAttachments())[0]?.uploadStatus === "ready",
    );
    await browser.execute(() => {
      const target = window as Window & { __chatDeviceFocus?: unknown[] };
      target.__chatDeviceFocus = [];
      document.addEventListener("focusin", (event) => {
        const element = event.target as HTMLElement;
        target.__chatDeviceFocus!.push({
          tag: element.tagName,
          testId: element.getAttribute("data-testid"),
          role: element.getAttribute("role"),
          inert: document
            .querySelector("[data-root-workspace-surface]")
            ?.getAttribute("data-root-workspace-surface"),
        });
      });
    });
    const before = await directory();
    const chatIdentity = await readChatIdentity();
    for (const locale of ["zh-CN", "en-US"])
      for (const theme of ["light", "dark"])
        for (const width of [1440, 480]) {
          await applyAppearance(locale, theme, width);
          await openFromChat(locale, `${locale}-${theme}-${width}`);
          await browser.keys("Escape");
          await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ reverse: true });
          await assertChatUnchanged();
          expect(await readChatIdentity()).toEqual(chatIdentity);
          expect(await readTaskIdentity(taskId)).toEqual(taskIdentity);
          await browser.waitUntil(() =>
            browser.execute(
              (testId) => document.activeElement?.getAttribute("data-testid") === testId,
              TID_COMPOSER_WORKSPACE_TRIGGER,
            ),
          );
          expect(await $('[data-testid="composer-create-project-on-device"]').isExisting()).toBe(
            false,
          );
          await settlePresentation();
          await browser.saveScreenshot(
            join(
              process.env.ZCODE_E2E_ARTIFACT_DIR!,
              `cancel-return-${locale}-${theme}-${width}.png`,
            ),
          );
        }
    await applyAppearance("zh-CN", "dark", 1440);
    await openFromChat();
    await fillSSHPasswordSettings({ ...config, password: "invalid-e2e-password" });
    await clickLastEnabledSSHDialogButton(marker);
    await $(`[data-testid="${TID_SSH_ERROR}"]`).waitForDisplayed({ timeout: 45_000 });
    expect(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed()).toBe(true);
    await $(`[data-testid="${TID_SSH_DIALOG}"]`)
      .$('.//button[normalize-space(.)="返回配置"]')
      .click();
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(marker);
    expect(await waitForSSHDirectoryStep(marker)).toBe("closed");
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ reverse: true });
    await assertChatUnchanged();
    expect(await readChatIdentity()).toEqual(chatIdentity);
    expect(await readTaskIdentity(taskId)).toEqual(taskIdentity);
    const connected = await directory();
    expect(connected.entries).toEqual(before.entries);
    expect(await $('[data-testid="virtual-project-name"]').isExisting()).toBe(false);
    const snapshot = await callHandoffHost<SourceServerManagementSnapshot>(
      ServiceChannels.SourceServerManagement,
      "getSnapshot",
    );
    expect(snapshot.servers).toHaveLength(1);
    const source = snapshot.servers[0]!;
    const folder = $('[data-testid="chat-remote-folder"]');
    await folder.waitForDisplayed();
    expect(await folder.getText()).toContain(source.displayName);
    for (const locale of ["zh-CN", "en-US"]) {
      for (const theme of ["light", "dark"]) {
        for (const width of [1440, 480]) {
          await applyAppearance(locale, theme, width);
          const bounds = await folder.getLocation();
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          await browser.saveScreenshot(
            join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `folder-${locale}-${theme}-${width}.png`),
          );
        }
      }
    }
    await browser.keys("Escape");
    await folder.waitForExist({ reverse: true });
    expect((await directory()).entries).toEqual(before.entries);
    await assertChatUnchanged();
    expect(await readChatIdentity()).toEqual(chatIdentity);
    expect(await readTaskIdentity(taskId)).toEqual(taskIdentity);
  });
});
