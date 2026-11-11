import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  PlatformChannels,
  ServiceChannels,
  type SourceServerManagementSnapshot,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import {
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_REMOTE_KIND_DOCKER,
  TID_VIRTUAL_PROJECT_CREATE_TASK,
  testId,
} from "@zcode/shared/test-ids";
import type { RemoteProjectDirectory, ProjectTree, VirtualProject } from "@zcode/services";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { expandRemoteDeviceRowsNeedingAttention } from "#e2e/helpers/remote-project-actions";
import {
  prepareV4ConversationE2E,
  setV4ComposerText,
  getV4ComposerText,
  pasteV4ComposerFileAttachment,
  getV4ComposerAttachments,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  readSSHRuntimeConfig,
  fillSSHPasswordSettings,
  clickLastEnabledSSHDialogButton,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  runSSHCommand,
} from "#e2e/helpers/ssh-remote-p0";

import {
  createSSHLifecycleProvider,
  SSH_LIFECYCLE_MODEL_ID,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";

const marker = "E2E_BACKGROUND_CONNECTION";
type Handler = (...args: unknown[]) => Promise<unknown>;
declare global {
  interface Window {
    __backgroundSourceReads?: {
      requests: { bytes: Uint8Array; port: MessagePort }[];
      restore(): void;
    };
  }
  var __backgroundConnectionProbe:
    | { held: boolean; code?: string; calls: number; release(): void; restore(): void }
    | undefined;
}
// 用例不稳定原因：点项目行的“新建任务”时鼠标停在行上，300ms 后弹出的项目悬停卡片会盖住
// composer 的项目选择器，高负载下后续点击被拦截（element click intercepted）。点完后移开鼠标并等卡片关闭。
async function leaveProjectRow() {
  await browser.action("pointer").move({ x: 0, y: 0, origin: "viewport" }).perform();
  await $('[data-testid="project-identity-details"]').waitForExist({
    reverse: true,
    timeout: 5000,
  });
}

/** 扣住真实 Source 查询请求，验证显式继续在资格 IO 之前同步禁发。 */
async function holdSourceReads() {
  await browser.execute((channel) => {
    const original = MessagePort.prototype.postMessage;
    const requests: { bytes: Uint8Array; port: MessagePort }[] = [];
    window.__backgroundSourceReads = {
      requests,
      restore() {
        MessagePort.prototype.postMessage = original;
        for (const request of requests) original.call(request.port, request.bytes);
        delete window.__backgroundSourceReads;
      },
    };
    MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
      const text = message instanceof Uint8Array ? new TextDecoder().decode(message) : "";
      if (text.includes(channel) && text.includes("getSnapshot")) {
        requests.push({ bytes: message as Uint8Array, port: this });
        return;
      }
      Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
    };
  }, ServiceChannels.SourceServerManagement);
}
async function releaseSourceReads() {
  await browser.execute(() => window.__backgroundSourceReads?.restore());
}
const snapshot = () =>
  callHandoffHost<SourceServerManagementSnapshot>(
    ServiceChannels.SourceServerManagement,
    "getSnapshot",
  );
const directory = () =>
  callHandoffHost<RemoteProjectDirectory>(ServiceChannels.RemoteProjects, "readDirectory");

/** 只扣住真实平台连接结果；SSH/Docker 与 Host 状态仍按真实链路运行。 */
async function holdConnection() {
  await browser.electron.execute((electron, channel) => {
    globalThis.__backgroundConnectionProbe?.restore();
    const handlers = (electron.ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers;
    const original = handlers.get(channel);
    if (!original) throw new Error("Remote connection handler is unavailable");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = {
      held: false,
      calls: 0,
      code: undefined as string | undefined,
      release,
      restore() {
        release();
        handlers.set(channel, original);
        delete globalThis.__backgroundConnectionProbe;
      },
    };
    handlers.set(channel, async (...args) => {
      probe.calls++;
      let value: unknown;
      let failure: unknown;
      try {
        value = await original(...args);
      } catch (cause) {
        failure = cause;
      }
      const response = value as { success?: boolean; reasonCode?: string } | undefined;
      probe.code =
        (failure as { code?: string } | undefined)?.code ??
        (response?.success === false ? (response.reasonCode ?? "connect-failed") : undefined);
      probe.held = true;
      await barrier;
      if (failure) throw failure;
      return value;
    });
    globalThis.__backgroundConnectionProbe = probe;
  }, PlatformChannels.ConnectRemote);
}
async function waitHeld() {
  await browser.waitUntil(
    () => browser.electron.execute(() => Boolean(globalThis.__backgroundConnectionProbe?.held)),
    { timeout: 120_000 },
  );
  return browser.electron.execute(() => globalThis.__backgroundConnectionProbe?.code);
}
async function releaseConnection() {
  await browser.electron.execute(() => globalThis.__backgroundConnectionProbe?.release());
}
async function restoreConnection() {
  await browser.electron.execute(() => globalThis.__backgroundConnectionProbe?.restore());
}
async function background() {
  await $('[data-testid="ssh-dialog"]')
    .$('.//button[contains(.,"后台") or contains(.,"Background") or contains(.,"收起")]')
    .click();
  await $('[data-testid="ssh-dialog"]').waitForExist({ reverse: true });
}
async function settings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
}
async function back() {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
}
async function openConnectionEntry() {
  await $("[data-settings-content-frame]")
    .$('.//button[normalize-space(.)="新建连接" or normalize-space(.)="New connection"]')
    .click();
}
async function newConnection() {
  await openConnectionEntry();
  await $('[data-testid="ssh-host-input"]').waitForDisplayed();
}
async function readyProgress() {
  const card = $('[data-testid="remote-connection-minimized"]');
  await browser.waitUntil(
    async () => {
      // RDUX-13：已识别设备的后台连接进度块在展开区；只展开提示“需要处理”的设备行。
      await expandRemoteDeviceRowsNeedingAttention();
      const text = (await card.isExisting()) ? await card.getText() : "";
      return text.includes("连接已完成") || text.includes("Connection complete");
    },
    { timeout: 90_000 },
  );
  expect(await $$('[data-testid="remote-connection-minimized"]').length).toBe(1);
  return card;
}
async function continueReady() {
  await (await readyProgress()).click();
}
async function assertUninterrupted(text: string, attachments = false) {
  // 显式继续会展示校验进度；成功返回后等待原 Dialog 的退出动画，不把尚未卸载误判为抢焦点。
  await $('[data-testid="ssh-dialog"]').waitForExist({ reverse: true });
  expect(await $('[data-testid="source-server-boundary-dialog"]').isExisting()).toBe(false);
  expect(await $('[data-testid="virtual-project-name"]').isDisplayed()).toBe(false);
  expect(await getV4ComposerText()).toBe(text);
  if (attachments)
    expect(await getV4ComposerAttachments()).toEqual([
      expect.objectContaining({
        uploadStatus: "ready",
        text: expect.stringContaining(`${marker}.txt`),
      }),
    ]);
}
async function openProjectForm(sourceId?: string) {
  await $('[data-testid="project-section"]').moveTo();
  await $('[data-testid="virtual-project-add"]').click();
  await $('[data-testid="virtual-project-name"]').setValue(marker);
  if (sourceId) {
    await $('[data-testid="virtual-project-device"]').click();
    await $(`[role="option"][data-device-id="remote:server:${sourceId}"]`).click();
  }
}
async function closeProjectForm() {
  await $('[data-testid="virtual-project-name"]').waitForDisplayed();
  await browser.keys("Escape");
  await $('[data-testid="virtual-project-name"]').waitForExist({ reverse: true });
}
async function settle() {
  await browser.executeAsync((done) => {
    void Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ).then(() => requestAnimationFrame(() => done()));
  });
}

describe(marker, () => {
  let provider: SSHLifecycleProvider | undefined;
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "background-failure.png"),
      );
      const details = $('//summary[contains(.,"组件堆栈")]');
      if (await details.isExisting()) await details.click();
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "background-failure.txt"),
        await $("body").getText(),
      );
    }
    await restoreConnection();
    await releaseSourceReads();
  });
  after(async () => {
    await provider?.tunnel.close();
    await restoreHandoffProbes();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RDUX15-19/20 four origins preserve navigation and resume the exact project intent", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(marker);
    await prepareV4ConversationE2E({ skipProvider: true });
    provider = await createSSHLifecycleProvider(config, marker);
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      providerId: provider.id,
      providerName: provider.name,
    });
    await selectUpstreamThoughtLevelValue("disabled");
    await installHandoffRpcProbe();
    await browser.execute(() =>
      (
        window as Window & { __testActions?: { setLocale(value: string): void } }
      ).__testActions?.setLocale("zh-CN"),
    );
    await openProjectForm();
    await $('[data-testid="virtual-project-name"]').setValue(`${marker}_LOCAL`);
    await $('[data-testid="virtual-project-save"]').click();
    const localRow = $(`[data-project-name="${marker}_LOCAL"]`);
    await localRow.waitForDisplayed();
    await localRow.moveTo();
    await localRow.$(`[data-testid="${TID_VIRTUAL_PROJECT_CREATE_TASK}"]`).click();
    await leaveProjectRow();
    await browser.waitUntil(async () =>
      Boolean(
        (await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree")).projects.find(
          (project) => project.name === `${marker}_LOCAL`,
        )?.roots.length,
      ),
    );
    const localProject = (
      await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree")
    ).projects.find((project) => project.name === `${marker}_LOCAL`)!;
    const localPath = localProject.roots[0]!.rootPath;
    const created = await callHandoffHost<{ session: { sessionId: string } }>(
      ServiceChannels.ZCodeAgent,
      "createSession",
      [
        {
          workspacePath: localPath,
          projectId: localProject.id,
          persistence: "immediate",
          importedHistory: {
            source: "claudeCode",
            title: marker,
            messages: [
              { role: "user", content: marker },
              { role: "assistant", content: "Original task remains local" },
            ],
          },
        },
      ],
    );
    const taskId = created.session.sessionId;
    await callHandoffHost(ServiceChannels.ZCodeTask, "resumeTask", [
      { taskId, workspacePath: localPath },
    ]);
    const toggle = localRow.$('[data-testid="virtual-project-toggle"]');
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await selectV4TaskById(taskId);
    await localRow.moveTo();
    await localRow.$(`[data-testid="${TID_VIRTUAL_PROJECT_CREATE_TASK}"]`).click();
    await leaveProjectRow();
    const text = `${marker} retained local draft`;
    await setV4ComposerText(text);
    await pasteV4ComposerFileAttachment(`${marker}.txt`, {
      base64: "YXR0YWNobWVudCBzdGF5cyBsb2NhbA==",
      mimeType: "text/plain",
    });
    await browser.waitUntil(
      async () => (await getV4ComposerAttachments())[0]?.uploadStatus === "ready",
    );
    await settings();
    await newConnection();
    await fillSSHPasswordSettings(config);
    await holdConnection();
    await clickLastEnabledSSHDialogButton(marker);
    await background();
    await back();
    const code = await waitHeld();
    await releaseConnection();
    await assertUninterrupted(text, true);
    await settings();
    if (code === "source-server-install-required") {
      const card = $('[data-testid="remote-connection-minimized"]');
      await card.waitForDisplayed();
      await browser.waitUntil(
        async () =>
          (await card.getText()).includes("处理") || (await card.getText()).includes("等待"),
      );
      await card.click();
      await holdConnection();
      await $('[data-testid="ssh-dialog"]').$('.//button[normalize-space(.)="安装并继续"]').click();
      await background();
      await back();
      expect(await waitHeld()).toBeUndefined();
      await releaseConnection();
      await assertUninterrupted(text, true);
      await settings();
    } else expect(code).toBeUndefined();
    // 普通设置入口也须消费已完成的后台流程，不能只显示空的连接进度页。
    await readyProgress();
    await openConnectionEntry();
    expect(await waitForSSHDirectoryStep(marker)).toBe("closed");
    await $('[data-testid="remote-connection-minimized"]').waitForExist({ reverse: true });
    const sourceId = (await snapshot()).servers[0]!.sourceServerId;
    expect((await directory()).entries).toHaveLength(0);
    const originalTask = (
      await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree")
    ).tasks.find((task) => task.taskId === taskId);
    expect(originalTask?.hostId).toBe("local");
    expect(originalTask?.projectId).toBe(localProject.id);
    expect(originalTask?.workspacePath).toBe(localPath);
    await $(`[data-source-server-card="${sourceId}"]`).waitForDisplayed();

    // 结果仍在途时从同一普通入口重开，释放后必须按前台完成，不能再等待一次隐藏的继续。
    await newConnection();
    await fillSSHPasswordSettings(config);
    await holdConnection();
    await clickLastEnabledSSHDialogButton(marker);
    await background();
    expect(await waitHeld()).toBeUndefined();
    await openConnectionEntry();
    await $('[data-testid="ssh-dialog"]').waitForDisplayed();
    await releaseConnection();
    await $('[data-testid="ssh-dialog"]').waitForExist({ reverse: true });
    await $('[data-testid="remote-connection-minimized"]').waitForExist({ reverse: true });
    expect(
      await browser.electron.execute(() => globalThis.__backgroundConnectionProbe?.calls),
    ).toBe(1);
    expect((await directory()).entries).toHaveLength(0);
    expect((await snapshot()).servers.map((server) => server.sourceServerId)).toContain(sourceId);
    for (const close of await $$('#zcode-toast-host button[aria-label="关闭"]'))
      await close.click();
    await back();

    // 项目新增：原表单在设置背后保持同一 owner；完成与继续均不自动保存。
    await openProjectForm();
    await $('[data-testid="virtual-project-device"]').click();
    await $('//*[@role="option" and contains(.,"添加远程设备")]').click();
    await fillSSHPasswordSettings(config);
    await holdConnection();
    await clickLastEnabledSSHDialogButton(marker);
    await background();
    await back();
    expect(await waitHeld()).toBeUndefined();
    await releaseConnection();
    await assertUninterrupted(text, true);
    const noticeContinue = $('//div[@id="zcode-toast-host"]//button[normalize-space(.)="继续"]');
    await noticeContinue.waitForDisplayed({ timeout: 90_000 });
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "background-completion-notice.png"),
    );
    await noticeContinue.click();
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    expect(await $('[data-testid="virtual-project-name"]').getValue()).toBe(marker);
    expect((await directory()).entries).toHaveLength(0);
    await closeProjectForm();

    // 后台取消配置也不能让隐藏项目弹窗在设置上重新出现。
    await openProjectForm();
    await $('[data-testid="virtual-project-device"]').click();
    await $('//*[@role="option" and contains(.,"添加远程设备")]').click();
    await background();
    await $("[data-background-connection]").$('.//button[normalize-space(.)="取消此连接"]').click();
    expect(await $('[data-testid="virtual-project-name"]').isDisplayed()).toBe(false);
    expect(await $("[data-settings-content-frame]").isDisplayed()).toBe(true);
    await back();
    expect(await $('[data-testid="virtual-project-name"]').getValue()).toBe(marker);
    await closeProjectForm();

    // 同一离线设备：选择目录和已有项目必须保留不同的后续动作。
    for (const action of ["virtual-project-browse", "virtual-project-existing"]) {
      await callHandoffHost(ServiceChannels.SourceServerManagement, "disconnectSource", [sourceId]);
      await openProjectForm(sourceId);
      await browser.waitUntil(async () =>
        (await $('[data-testid="virtual-project-device"]').getText()).includes("离线"),
      );
      await holdConnection();
      await $(`[data-testid="${action}"]`).click();
      await $('[data-testid="ssh-dialog"]').waitForDisplayed();
      // 已有设备连接必须留在原项目页；后台只收起同一 flow。
      expect(await $("[data-settings-content-frame]").isDisplayed()).toBe(false);
      await background();
      expect(await $("[data-settings-content-frame]").isDisplayed()).toBe(false);
      expect(await waitHeld()).toBeUndefined();
      await releaseConnection();
      await assertUninterrupted(text, true);
      await settings();
      await continueReady();
      if (action === "virtual-project-existing") {
        await $('[data-testid="remote-project-back"]').waitForDisplayed();
        expect(await $('[data-testid="virtual-project-directory-browser"]').isExisting()).toBe(
          false,
        );
        await $('[data-testid="remote-project-back"]').click();
      } else {
        const browserPanel = $('[data-testid="virtual-project-directory-browser"]');
        await browserPanel.waitForDisplayed();
        await browserPanel.$('.//button[normalize-space(.)="取消"]').click();
      }
      await $('[data-testid="virtual-project-name"]').waitForDisplayed();
      expect(await $('[data-testid="virtual-project-name"]').getValue()).toBe(marker);
      expect((await directory()).entries).toHaveLength(0);
      await closeProjectForm();
    }

    // 聊天来源：后台不锁原草稿，完成只通知；显式继续必须确认目录，再手动首发。
    const hostId = remoteHostIdFromWorkspaceIdentity(
      buildServerRemoteWorkspaceIdentity({ serverId: sourceId, workspacePath: "/" }),
    )!;
    const remotePath = `${config.workspacePaths[0]!}/background-folder-${Date.now()}`;
    expect(
      (await runSSHCommand(config, "mkdir -p -- '" + remotePath.replaceAll("'", "'\\''") + "'"))
        .code,
    ).toBe(0);
    const existing = await callHandoffHost<VirtualProject>(ServiceChannels.Project, "saveProject", [
      { hostId, roots: [remotePath], name: marker + " remote existing" },
    ]);
    const beforeRemote = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId },
    ]);
    const beforeLocal = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId: "local" },
    ]);
    await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
    await $(`[data-testid="${TID_COMPOSER_REMOTE_CONNECTION}"]`).click();
    await fillSSHPasswordSettings(config);
    await holdConnection();
    await clickLastEnabledSSHDialogButton(marker);
    await background();
    await back();
    await assertUninterrupted(text, true);
    expect(await $('[data-testid="v4-composer-send"]').isEnabled()).toBe(true);
    expect(await waitHeld()).toBeUndefined();
    await releaseConnection();
    await assertUninterrupted(text, true);
    expect(await $('[data-testid="chat-remote-folder"]').isExisting()).toBe(false);
    await settings();
    await continueReady();
    const picker = $('[data-testid="chat-remote-folder"]');
    await picker.waitForDisplayed();
    expect(await getV4ComposerText()).toBe(text);
    expect(await $('[data-testid="v4-composer-send"]').isEnabled()).toBe(false);
    await browser.execute(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="v4-composer-send"]')
        ?.form?.requestSubmit(),
    );
    expect(
      (
        await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
          { hostId: "local" },
        ])
      ).tasks,
    ).toEqual(beforeLocal.tasks);
    // 首次继续取消只恢复原目标，Source 和其他已用连接仍存在。
    await browser.keys("Escape");
    await picker.waitForExist({ reverse: true });
    await assertUninterrupted(text, true);
    expect(await $('[data-testid="chat-restored-target"]').getText()).toContain(localProject.name);
    expect(
      (await snapshot()).states.some(
        (state) => state.sourceServerId === sourceId && state.state === "online",
      ),
    ).toBe(true);
    expect((await directory()).entries).toHaveLength(0);

    // 已放弃的原草稿不能由旧后台继续恢复，也不能锁住新任务。
    await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
    await $(`[data-testid="${TID_COMPOSER_REMOTE_CONNECTION}"]`).click();
    await fillSSHPasswordSettings(config);
    await holdConnection();
    await clickLastEnabledSSHDialogButton(marker);
    await background();
    await back();
    await selectV4TaskById(taskId);
    expect(await waitHeld()).toBeUndefined();
    await releaseConnection();
    await settings();
    await continueReady();
    await $('[data-testid="remote-connection-minimized"]').waitForExist({ reverse: true });
    expect(await picker.isExisting()).toBe(false);
    expect(await $("[data-settings-content-frame]").isDisplayed()).toBe(true);
    await back();
    await localRow.moveTo();
    await localRow.$(`[data-testid="${TID_VIRTUAL_PROJECT_CREATE_TASK}"]`).click();
    await leaveProjectRow();
    await setV4ComposerText(text);
    await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
    await $(`[data-testid="${TID_COMPOSER_REMOTE_CONNECTION}"]`).click();
    await fillSSHPasswordSettings(config);
    await holdConnection();
    await clickLastEnabledSSHDialogButton(marker);
    await background();
    await back();
    expect(await waitHeld()).toBeUndefined();
    await releaseConnection();
    await assertUninterrupted(text);
    const continueNotice = $(
      '(//div[@id="zcode-toast-host"]//button[normalize-space(.)="继续"])[last()]',
    );
    await continueNotice.waitForDisplayed({ timeout: 90_000 });
    await holdSourceReads();
    await continueNotice.click();
    await browser.waitUntil(() =>
      browser.execute(() => Boolean(window.__backgroundSourceReads?.requests.length)),
    );
    expect(await $('[data-testid="v4-composer-send"]').isEnabled()).toBe(false);
    await $('[data-testid="ssh-dialog"]').waitForDisplayed();
    // 前台焦点属于连接弹窗，直接按 Enter 会合法触发“收起”；定向向原输入框发送事件以验证提交门禁。
    await browser.execute(() => {
      document.querySelector('[data-testid="v4-composer-input"]')?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      document
        .querySelector<HTMLButtonElement>('[data-testid="v4-composer-send"]')
        ?.form?.requestSubmit();
    });
    expect(await $('[data-testid="ssh-dialog"]').isDisplayed()).toBe(true);
    expect(
      (
        await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
          { hostId: "local" },
        ])
      ).tasks,
    ).toEqual(beforeLocal.tasks);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "background-resume-validation-pending.png"),
    );
    await releaseSourceReads();
    await picker.waitForDisplayed();
    await picker.$("input").setValue(remotePath);
    await picker.$('button[type="submit"]').click();
    const confirmFolder = picker.$('[data-testid="directory-browser-confirm"]');
    await confirmFolder.waitForEnabled();
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "background-explicit-folder.png"),
    );
    await confirmFolder.click();
    const identity = buildServerRemoteWorkspaceIdentity({
      serverId: sourceId,
      workspacePath: remotePath,
    });
    await waitForRemoteTab({
      caseMarker: marker,
      expectedPath: remotePath,
      expectedIdentity: identity,
    });
    await picker.waitForExist({ reverse: true });
    expect(await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).getText()).toContain(
      existing.name,
    );
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      providerId: provider.id,
      providerName: provider.name,
    });
    await selectUpstreamThoughtLevelValue("disabled");
    await sendV4PromptAndWaitAccepted(
      marker + " remote first message",
      marker,
      "后台继续后首发必须提交到远程项目",
    );
    await waitForV4AssistantMessageContaining("SSH_P0_TASK_LIFECYCLE_REPLY");
    const afterRemote = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId },
    ]);
    const sent = afterRemote.tasks.find((task) => task.projectId === existing.id)!;
    expect(sent).toMatchObject({
      hostId,
      projectId: existing.id,
      workspacePath: remotePath,
      workspaceIdentity: identity,
    });
    expect(afterRemote.projects.map((project) => project.id).sort()).toEqual(
      beforeRemote.projects.map((project) => project.id).sort(),
    );
    expect(
      (await directory()).entries.filter(
        (entry) => entry.projectId === existing.id && entry.hostId === hostId,
      ),
    ).toHaveLength(1);
    expect(
      (
        await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
          { hostId: "local" },
        ])
      ).tasks,
    ).toEqual(beforeLocal.tasks);
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "background-remote-first-submission.json"),
      JSON.stringify({ project: existing, task: sent }, null, 2),
    );
    await localRow.moveTo();
    await localRow.$(`[data-testid="${TID_VIRTUAL_PROJECT_CREATE_TASK}"]`).click();
    await leaveProjectRow();
    await assertUninterrupted(text, true);

    await settings();
    // 后台错误留在设置，不弹窗；查看不重发，取消不恢复项目/聊天旧界面。
    await newConnection();
    // 先填写目标再填口令：修改用户名按产品规则清除凭据；不同用户名防止复用在线认证。
    await fillSSHPasswordSettings({
      ...config,
      username: `${config.username}-missing`,
      password: `${config.password}-wrong`,
    });
    await holdConnection();
    await clickLastEnabledSSHDialogButton(marker);
    await background();
    await back();
    expect(await waitHeld()).toBeTruthy();
    await releaseConnection();
    await assertUninterrupted(text, true);
    await settings();
    const failed = $('[data-testid="remote-connection-minimized"]');
    await browser.waitUntil(async () => (await failed.getText()).includes("失败"));
    for (const locale of ["zh-CN", "en-US"])
      for (const theme of ["light", "dark"]) {
        await browser.execute(
          (language, color) => {
            const actions = (
              window as Window & {
                __testActions?: { setLocale(value: string): void; setTheme(value: string): void };
              }
            ).__testActions;
            actions?.setLocale(language);
            actions?.setTheme(color);
          },
          locale,
          theme,
        );
        await browser.electron.execute((electron) =>
          electron.BrowserWindow.getAllWindows()
            .find((window) => window.isVisible())
            ?.setSize(480, 900),
        );
        await settle();
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `background-${locale}-${theme}.png`),
        );
        expect(await failed.isDisplayed()).toBe(true);
      }
    await failed.click();
    expect(
      await browser.electron.execute(() => globalThis.__backgroundConnectionProbe?.calls),
    ).toBe(1);
    await browser.keys("Escape");
    expect(await $('[data-testid="remote-connection-minimized"]').isExisting()).toBe(false);
    await back();
    // Docker 使用独立远端环境；同一 Host 与前一来源串行验收。
    const container = process.env.ZCODE_E2E_SSH_CONTAINER;
    if (!container) throw new Error("Dedicated Docker container is required");
    await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows()
        .find((window) => window.isVisible())
        ?.setSize(1440, 900),
    );
    await browser.execute(() =>
      (
        window as Window & { __testActions?: { setLocale(value: string): void } }
      ).__testActions?.setLocale("zh-CN"),
    );
    await setV4ComposerText("Docker background draft");
    await settings();
    await newConnection();
    await clickTestIdByDom(TID_REMOTE_KIND_DOCKER);
    await $('[data-testid="ssh-dialog"]')
      .$('.//button[normalize-space(.)="选择运行中的容器"]')
      .click();
    await $('[data-testid="docker-container-select"]').click();
    // 用例不稳定原因：容器列表来自本机 docker ps，多个 runner 并发时超过默认 5 秒才返回，
    // 直接 click 会报找不到条目（录像最后一帧条目已出现）。显式等待列表加载。
    const containerItem = $(
      `//*[@cmdk-item and .//*[normalize-space(.)=${JSON.stringify(container)}]]`,
    );
    await containerItem.waitForDisplayed({ timeout: 30_000 });
    await containerItem.click();
    await holdConnection();
    await clickLastEnabledSSHDialogButton(marker);
    await background();
    await back();
    let dockerCode = await waitHeld();
    await releaseConnection();
    await assertUninterrupted("Docker background draft");
    await settings();
    if (dockerCode === "source-server-install-required") {
      await $('[data-testid="remote-connection-minimized"]').click();
      await holdConnection();
      await $('[data-testid="ssh-dialog"]').$('.//button[normalize-space(.)="安装并继续"]').click();
      await background();
      await back();
      dockerCode = await waitHeld();
      await releaseConnection();
      await assertUninterrupted("Docker background draft");
      await settings();
    }
    expect(dockerCode).toBeUndefined();
    await continueReady();
    await $('[data-testid="remote-connection-minimized"]').waitForExist({ reverse: true });
    expect(
      (await snapshot()).profiles.some(
        (profile) => profile.transport === "docker" && profile.sourceServerId,
      ),
    ).toBe(true);
    expect((await directory()).entries).toHaveLength(1);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "background-docker-complete.png"),
    );
  });
});
