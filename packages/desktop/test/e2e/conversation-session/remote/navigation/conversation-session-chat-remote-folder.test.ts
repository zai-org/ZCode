import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  ServiceChannels,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type SourceServerManagementSnapshot,
} from "@zcode/shared";
import {
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_SETTINGS_PAGE,
} from "@zcode/shared/test-ids";
import type {
  ProjectTree,
  VirtualProject,
  RemoteProjectDirectory,
  TaskGroup,
  TaskGroupStructure,
} from "@zcode/services";
import {
  prepareV4ConversationE2E,
  setV4ComposerText,
  sendV4PromptAndWaitAccepted,
  getV4ComposerText,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  readSSHRuntimeConfig,
  fillSSHPasswordSettings,
  clickLastEnabledSSHDialogButton,
  waitForSSHDirectoryStep,
  waitForRemoteTab,
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

declare global {
  interface Window {
    __membershipReadFault?: { requests: { bytes: number[]; port: MessagePort }[]; restore(): void };
  }
}
async function holdMembershipReads(
  channel: string = ServiceChannels.RemoteProjects,
  command = "readDirectory",
  hostId?: string,
) {
  await browser.execute(
    (channel, command, hostId) => {
      const original = MessagePort.prototype.postMessage;
      const requests: { bytes: number[]; port: MessagePort }[] = [];
      window.__membershipReadFault = {
        requests,
        restore() {
          MessagePort.prototype.postMessage = original;
        },
      };
      MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
        const text = message instanceof Uint8Array ? new TextDecoder().decode(message) : "";
        if (
          text.includes(channel) &&
          text.includes(command) &&
          (!hostId || text.includes(hostId))
        ) {
          requests.push({ bytes: Array.from(message as Uint8Array), port: this });
          return;
        }
        Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
      };
    },
    channel,
    command,
    hostId,
  );
}
/** 用既有 RPC 接缝回放旧端只读目录投影；不声称运行了旧 Server 二进制。 */
async function resolveLegacyTree(tree: ProjectTree) {
  const requests = await browser.execute(
    () => window.__membershipReadFault?.requests.map((item) => item.bytes) ?? [],
  );
  const responses = requests.map((bytes) => {
    const header = deserialize(new BufferReader(VSBuffer.wrap(Uint8Array.from(bytes)))) as [
      number,
      number,
    ];
    const writer = new BufferWriter();
    serialize(writer, [201, header[1]]);
    serialize(writer, tree);
    return Array.from(writer.buffer.buffer);
  });
  await browser.execute((responses) => {
    const requests = window.__membershipReadFault?.requests.splice(0, responses.length) ?? [];
    requests.forEach((request, index) =>
      request.port.dispatchEvent(
        new MessageEvent("message", { data: Uint8Array.from(responses[index]!) }),
      ),
    );
  }, responses);
}
async function rejectMembershipReads() {
  const requests = await browser.execute(
    () => window.__membershipReadFault?.requests.map((item) => item.bytes) ?? [],
  );
  const replies = requests.map((bytes) => {
    const header = deserialize(new BufferReader(VSBuffer.wrap(Uint8Array.from(bytes)))) as [
      number,
      number,
    ];
    const writer = new BufferWriter();
    serialize(writer, [202, header[1]]);
    serialize(writer, { name: "Error", message: "E2E_MEMBERSHIP_READ_UNAVAILABLE", stack: [] });
    return Array.from(writer.buffer.buffer);
  });
  await browser.execute((responses) => {
    const requests = window.__membershipReadFault?.requests.splice(0, responses.length) ?? [];
    requests.forEach((request, index) =>
      request.port.dispatchEvent(
        new MessageEvent("message", { data: Uint8Array.from(responses[index]!) }),
      ),
    );
  }, replies);
}
async function restoreMembershipReads() {
  await browser.execute(() => {
    const fault = window.__membershipReadFault;
    fault?.restore();
    for (const request of fault?.requests ?? [])
      request.port.postMessage(Uint8Array.from(request.bytes));
    delete window.__membershipReadFault;
  });
}

const marker = "E2E_CHAT_REMOTE_FOLDER";
describe(marker, () => {
  let provider: SSHLifecycleProvider | undefined;
  after(async () => {
    await restoreMembershipReads();
    await provider?.tunnel.close();
    await restoreHandoffProbes();
    await clearAppData();
  });
  it("RDUX21-01 连接后必须选目录，原无项目草稿不能向本地发送", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(marker);
    await prepareV4ConversationE2E({ skipProvider: true });
    provider = await createSSHLifecycleProvider(config, marker);
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      providerId: provider.id,
      providerName: provider.name,
    });
    await selectUpstreamThoughtLevelValue("disabled");
    await installHandoffRpcProbe();
    const before = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree");
    // 目录选择期间 Composer 已只读；先输入真实草稿，不能靠测试 bridge 在禁用期间强写正文。
    await setV4ComposerText(marker + " must stay unsent");
    await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
    await $(`[data-testid="${TID_COMPOSER_REMOTE_CONNECTION}"]`).click();
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(marker);
    expect(await waitForSSHDirectoryStep(marker)).toBe("closed");
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ reverse: true });
    const picker = $('[data-testid="chat-remote-folder"]');
    if (!(await picker.isExisting())) {
      // 红灯证据必须是实际提交归属，不能把预热 runtime 误记为已发送。
      await sendV4PromptAndWaitAccepted(
        marker + " return a short acknowledgement",
        marker,
        "原无项目路径的消息应进入真实任务",
      );
      const after = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree");
      const added = after.tasks.filter(
        (task) => !before.tasks.some((old) => old.taskId === task.taskId),
      );
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "old-local-submission.json"),
        JSON.stringify(added, null, 2),
      );
      expect(added.some((task) => task.hostId === "local" && !task.projectId)).toBe(false);
    }
    await picker.waitForDisplayed();
    // 合并后普通项目创建仍独立，连接结果只能进入目录确认，不能恢复旧的设备创建按钮。
    expect(await $('[data-testid="composer-create-project-on-device"]').isExisting()).toBe(false);
    expect(await $('[data-testid="virtual-project-name"]').isExisting()).toBe(false);
    expect(await getV4ComposerText()).toBe(marker + " must stay unsent");
    expect(await $('[data-testid="v4-composer-send"]').isEnabled()).toBe(false);
    await browser.keys("Enter");
    await browser.execute(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="v4-composer-send"]')
        ?.form?.requestSubmit(),
    );
    expect((await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree")).tasks).toEqual(
      before.tasks,
    );
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "folder-required.png"));
    await browser.keys("Escape");
    await picker.waitForExist({ reverse: true });
    expect(await getV4ComposerText()).toBe(marker + " must stay unsent");
    await setV4ComposerText("");
    const snapshot = await callHandoffHost<SourceServerManagementSnapshot>(
      ServiceChannels.SourceServerManagement,
      "getSnapshot",
    );
    const source = snapshot.servers[0]!;
    const hostId = remoteHostIdFromWorkspaceIdentity(
      buildServerRemoteWorkspaceIdentity({ serverId: source.sourceServerId, workspacePath: "/" }),
    )!;
    const path = `${config.workspacePaths[0]!}/chat-folder-${Date.now()}-long-project-directory`;
    const createdDirectory = await runSSHCommand(
      config,
      "mkdir -p -- '" + path.replaceAll("'", "'\\''") + "'",
    );
    expect(createdDirectory.code).toBe(0);
    const existing = await callHandoffHost<VirtualProject>(ServiceChannels.Project, "saveProject", [
      { hostId, roots: [path], name: marker + " existing" },
    ]);
    const beforeProjects = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId },
    ]);
    // 已有成员的完成校验读取失败必须留在原连接错误边界，不能被当成取消而允许本地发送。
    await setV4ComposerText(marker + " membership failure stays unsent");
    await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
    await $(`[data-testid="${TID_COMPOSER_REMOTE_CONNECTION}"]`).click();
    await fillSSHPasswordSettings(config);
    await holdMembershipReads();
    await clickLastEnabledSSHDialogButton(marker);
    await browser.waitUntil(
      async () => {
        await rejectMembershipReads();
        return $('[data-testid="ssh-error"]').isDisplayed();
      },
      { timeout: 60_000 },
    );
    const connectionDialog = $('[data-testid="ssh-dialog"]');
    await connectionDialog.$("details summary").click();
    expect(await connectionDialog.getText()).toContain("E2E_MEMBERSHIP_READ_UNAVAILABLE");
    expect(await $('[data-testid="v4-composer-send"]').isEnabled()).toBe(false);
    await browser.keys("Enter");
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
    ).toEqual(before.tasks);
    if ((await connectionDialog.$("details").getAttribute("open")) === null)
      await connectionDialog.$("details summary").click();
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "membership-read-failure.png"),
    );
    await restoreMembershipReads();
    await holdMembershipReads();
    await connectionDialog
      .$('.//button[normalize-space(.)="重试" or normalize-space(.)="Retry"]')
      .click();
    await browser.waitUntil(
      () => browser.execute(() => Boolean(window.__membershipReadFault?.requests.length)),
      { timeout: 60_000 },
    );
    await connectionDialog
      .$('.//button[normalize-space(.)="取消连接" or normalize-space(.)="Cancel connection"]')
      .click();
    await connectionDialog.waitForExist({ reverse: true });
    await restoreMembershipReads();
    // 释放同一RPC端口的迟到资格结果后，公开Host读取形成消息顺序屏障。
    await callHandoffHost<RemoteProjectDirectory>(ServiceChannels.RemoteProjects, "readDirectory");
    expect(await picker.isExisting()).toBe(false);
    expect(await getV4ComposerText()).toBe(marker + " membership failure stays unsent");
    expect(await $('[data-testid="chat-restored-target"]').getText()).toContain("此电脑");
    await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
    await $(`[data-testid="${TID_COMPOSER_REMOTE_CONNECTION}"]`).click();
    await fillSSHPasswordSettings(config);
    await holdMembershipReads();
    await clickLastEnabledSSHDialogButton(marker);
    await browser.waitUntil(
      async () => {
        await rejectMembershipReads();
        return $('[data-testid="ssh-error"]').isDisplayed();
      },
      { timeout: 60_000 },
    );
    await restoreMembershipReads();
    await connectionDialog
      .$('.//button[normalize-space(.)="重试" or normalize-space(.)="Retry"]')
      .click();
    expect(await waitForSSHDirectoryStep(marker)).toBe("closed");
    await picker.waitForDisplayed();
    await browser.keys("Escape");
    await picker.waitForExist({ reverse: true });
    expect(await getV4ComposerText()).toBe(marker + " membership failure stays unsent");
    expect(await $('[data-testid="chat-restored-target"]').getText()).toContain("此电脑");
    await setV4ComposerText("");
    // 分组只组织任务；从组内草稿切到远程项目后，首发仍须进入原组。
    const group = await callHandoffHost<TaskGroup>(ServiceChannels.TaskGroups, "save", [
      { title: marker + " group" },
    ]);
    await $('[data-testid="sidebar-view-menu"]').click();
    await $('[data-testid="sidebar-view-grouped"]').click();
    const groupRow = $(`[data-task-group-id="${group.id}"]`);
    await groupRow.waitForDisplayed();
    await groupRow.$('[data-testid="task-group-new-task"]').click();
    await $('[data-testid="sidebar-view-menu"]').click();
    await $('[data-testid="sidebar-view-projects"]').click();
    const reconnect = async () => {
      // 项目行的只读身份浮层可能仍在关闭过程中；先按现有 Escape 语义收起，避免遮挡真实菜单点击。
      await browser.action("pointer").move({ x: 8, y: 8 }).perform();
      if (await $('[data-testid="remote-identity-details"]').isExisting()) {
        await browser.keys("Escape");
        await $('[data-testid="remote-identity-details"]').waitForExist({ reverse: true });
      }
      await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
      await $(`[data-testid="${TID_COMPOSER_REMOTE_CONNECTION}"]`).click();
      await fillSSHPasswordSettings(config);
      await clickLastEnabledSSHDialogButton(marker);
      expect(await waitForSSHDirectoryStep(marker)).toBe("closed");
      await picker.waitForDisplayed();
    };
    const selectFolder = async () => {
      const pathInput = picker.$("input");
      await pathInput.setValue(path);
      await picker.$('button[type="submit"]').click();
      const select = picker.$('[data-testid="directory-browser-confirm"]');
      await select.waitForEnabled();
      const idleSize = await picker.getSize();
      const idleButtonSize = await select.getSize();
      // 固定真实 RPC 的在途窗口，避免依赖网络快慢猜测加载展示是否出现。
      await holdMembershipReads();
      await select.click();
      await browser.waitUntil(
        () => browser.execute(() => Boolean(window.__membershipReadFault?.requests.length)),
        { timeout: 10_000 },
      );
      const pendingButton = picker.$('button[aria-busy="true"]');
      await pendingButton.waitForDisplayed();
      expect(await pendingButton.isEnabled()).toBe(false);
      expect(await pendingButton.getText()).toMatch(/正在打开|Opening/);
      expect(await pendingButton.$('[role="status"]').isDisplayed()).toBe(true);
      expect(await picker.$$('[role="status"]').length).toBe(1);
      expect(await pathInput.getValue()).toBe(path);
      expect(await picker.getSize()).toEqual(idleSize);
      expect(await pendingButton.getSize()).toEqual(idleButtonSize);
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "folder-button-loading.png"),
      );
      await restoreMembershipReads();
      const identity = buildServerRemoteWorkspaceIdentity({
        serverId: source.sourceServerId,
        workspacePath: path,
      });
      await waitForRemoteTab({
        caseMarker: marker,
        expectedPath: path,
        expectedIdentity: identity,
      });
      await picker.waitForExist({ reverse: true });
      expect(await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).getText()).toContain(
        existing.name,
      );
      return identity;
    };
    await reconnect();
    await picker.$("input").setValue(path + "/missing-directory");
    await picker.$('button[type="submit"]').click();
    await browser.waitUntil(async () => (await picker.getText()).includes("ENOENT"));
    expect(await picker.$('[data-testid="directory-browser-confirm"]').isEnabled()).toBe(false);
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "invalid-folder.png"));
    expect((await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree")).tasks).toEqual(
      before.tasks,
    );
    const identity = await selectFolder();
    await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
      providerId: provider.id,
      providerName: provider.name,
    });
    await selectUpstreamThoughtLevelValue("disabled");
    await sendV4PromptAndWaitAccepted(
      marker + " remote first message",
      marker,
      "首次消息必须在远端项目接受",
    );
    await waitForV4AssistantMessageContaining("SSH_P0_TASK_LIFECYCLE_REPLY");
    const remoteTree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId },
    ]);
    const task = remoteTree.tasks.find((item) => item.projectId === existing.id)!;
    expect(task).toMatchObject({
      hostId,
      projectId: existing.id,
      workspacePath: path,
      workspaceIdentity: identity,
    });
    await browser.waitUntil(async () =>
      (await callHandoffHost<TaskGroupStructure>(ServiceChannels.TaskGroups, "read")).members.some(
        (member) =>
          member.groupId === group.id &&
          member.taskId === task.taskId &&
          member.workspaceKey === identity,
      ),
    );
    expect(remoteTree.projects.map((item) => item.id).sort()).toEqual(
      beforeProjects.projects.map((item) => item.id).sort(),
    );
    expect(
      (
        await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
          { hostId: "local" },
        ])
      ).tasks,
    ).toEqual(before.tasks);
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "remote-first-submission.json"),
      JSON.stringify({ project: existing, task }, null, 2),
    );
    // 已有任务从项目菜单的新任务入口进入；重复连接仍强制选目录，不能恢复旧会话。
    await $(`[data-project-id="${existing.id}"]`).moveTo();
    await $(
      `[data-project-id="${existing.id}"] [data-testid="virtual-project-create-task"]`,
    ).click();
    await reconnect();
    await selectFolder();
    const repeated = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId },
    ]);
    expect(repeated.tasks.find((item) => item.taskId === task.taskId)).toMatchObject({
      taskId: task.taskId,
      hostId,
      projectId: existing.id,
      workspaceIdentity: identity,
      workspacePath: path,
    });
    expect(repeated.projects.map((item) => item.id).sort()).toEqual(
      beforeProjects.projects.map((item) => item.id).sort(),
    );
    const entries = (
      await callHandoffHost<RemoteProjectDirectory>(ServiceChannels.RemoteProjects, "readDirectory")
    ).entries;
    expect(
      entries.filter((entry) => entry.hostId === hostId && entry.projectId === existing.id),
    ).toHaveLength(1);
    await setV4ComposerText(marker + " remote draft retained");
    await reconnect();
    await browser.keys("Escape");
    await picker.waitForExist({ reverse: true });
    expect(await getV4ComposerText()).toBe(marker + " remote draft retained");
    expect(await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).getText()).toContain(
      existing.name,
    );
    // 旧端两种历史写法指向同一目录：只用于匹配的投影不能合并项目身份或要求升级新建。
    await reconnect();
    await picker.$("input").setValue(path);
    await picker.$('button[type="submit"]').click();
    const selectLegacyFolder = picker.$('[data-testid="directory-browser-confirm"]');
    await selectLegacyFolder.waitForEnabled();
    await holdMembershipReads(ServiceChannels.Project, "readTree", hostId);
    await selectLegacyFolder.click();
    await browser.waitUntil(() =>
      browser.execute(() => Boolean(window.__membershipReadFault?.requests.length)),
    );
    const legacyProjects = ["/.", "/child/.."].map((suffix, index) => ({
      ...existing,
      id: `legacy-single-root:fixture-${index}`,
      legacySingleRoot: true as const,
      directoryMatchPath: path,
      roots: [{ rootPath: path + suffix, position: 0, isPrimary: true }],
    }));
    await resolveLegacyTree({ legacySingleRoot: true, projects: legacyProjects, tasks: [] });
    await browser.waitUntil(
      async () => (await $$('[data-testid="chat-remote-project-pick"]').length) === 2,
    );
    expect(
      await $$('[data-testid="chat-remote-project-pick"]').map((row) =>
        row.getAttribute("data-project-id"),
      ),
    ).toEqual(legacyProjects.map((project) => project.id));
    expect(await $('[data-testid="virtual-project-save"]').isExisting()).toBe(false);
    expect(await $('[data-testid="v4-composer-send"]').isEnabled()).toBe(false);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "legacy-equivalent-folder-projects.png"),
    );
    await restoreMembershipReads();
    await browser.keys("Escape");
    await picker.waitForExist({ reverse: true });
    expect(await getV4ComposerText()).toBe(marker + " remote draft retained");
  });
});
