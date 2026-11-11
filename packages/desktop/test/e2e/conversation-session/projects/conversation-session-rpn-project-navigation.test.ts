import { DatabaseSync } from "node:sqlite";
import { createRemoteProjectService } from "@zcode/services/node";
import { requestRemoteProjectConnection } from "#e2e/helpers/remote-project-actions";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appSettingsSchema } from "@zcode/shared";
import {
  TID_PROJECT_SECTION,
  TID_CONVERSATION_SECTION,
  TID_SSH_DIALOG,
  TID_SSH_PASSWORD_INPUT,
  TID_SSH_ERROR,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  getE2EAppDataPaths,
  readSettings,
  seedSettings,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import { openSSHRemoteDialog, readRemoteTabSnapshot } from "#e2e/helpers/ssh-remote-p0";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";

const CASE_MARKER = "E2E_RPN_PROJECT_NAVIGATION";
const SOURCE_A = "25db8db2-d27b-40de-a23e-697b3c127234";
const SOURCE_B = "f6a0d063-3c52-4ce2-abf1-cb456d87f542";
const PROJECT_PATH = "/srv/project";
const CHAT_PATH = "/home/e2e/.zcode/workspace/default";
const IDENTITY_A = `remote:server:${SOURCE_A}:${PROJECT_PATH}`;
const IDENTITY_B = `remote:server:${SOURCE_B}:${PROJECT_PATH}`;
const CHAT_IDENTITY = `remote:server:${SOURCE_A}:${CHAT_PATH}`;

async function dialogButton(
  labels: readonly string[],
  partial = false,
): Promise<WebdriverIO.Element> {
  const dialog = $(`[data-testid="${TID_SSH_DIALOG}"]`);
  let matched: WebdriverIO.Element | undefined;
  // 高级区展开时按钮先挂载、文字仍被动画裁切；等待实际可见文案，不能把这一帧当成缺少选项。
  await browser.waitUntil(
    async () => {
      for (const button of await dialog.$$("button")) {
        const text = (await button.getText()).trim();
        if (
          (await button.isDisplayed()) &&
          labels.some((label) => (partial ? text.includes(label) : text === label))
        ) {
          matched = button;
          return true;
        }
      }
      return false;
    },
    { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: 没有找到向导按钮 ${labels.join(" / ")}` },
  );
  return matched!;
}

async function completeInitialOnboarding() {
  const page = $('[data-testid="onboarding-page"]');
  await page.waitForDisplayed({ timeout: 30_000 });
  // 合入首次职业引导后，隔离 profile 没有完成记录；先走真实保存链，后面的冷重载才能验证项目恢复。
  await page.$("footer > div > button").click();
  const codingMode = page.$('.//button[.//span[text()="编程模式" or text()="Coding mode"]]');
  await codingMode.waitForDisplayed();
  await codingMode.click();
  await page.$("footer > div > button").click();
  await browser.waitUntil(
    async () =>
      ["开始使用", "Get started"].includes(await page.$("footer > div > button").getText()),
    { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: 引导未进入偏好页` },
  );
  // 偏好页选择“跳过”仍持久化完成记录，并关闭与导航无关的主动推荐和记忆。
  await page.$("footer > button").click();
  await page.waitForDisplayed({ reverse: true, timeout: 10_000 });
}

// 只验证导航合同，不发 prompt、不连接真实远端；本机关闭端口用于隔离手动失败入口。
describe(`${CASE_MARKER}: 项目平铺与远程无项目入口停用`, () => {
  afterEach(async () => {
    const artifactDir = resolve(
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/rpn-project-navigation",
    );
    await mkdir(artifactDir, { recursive: true });
    await browser.saveScreenshot(resolve(artifactDir, "rpn-final.png"));
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RPN-01/02/04/09/10/14 keeps offline projects visible and distinct without restoring remote conversations", async function () {
    this.timeout(180_000);
    await completeInitialOnboarding();
    await prepareV4ConversationE2E({ skipProvider: true });
    const before = await readSettings();
    const sources = [SOURCE_A, SOURCE_B];
    const names = ["alpha-device", "beta-device"];
    const profiles = sources.map((sourceServerId, index) => ({
      profileId: ["294224b4-a6ad-4424-97ad-37f58c833e0f", "2abca774-d38f-44ca-95bf-cc659ab1183b"][
        index
      ]!,
      sourceServerId,
      displayName: names[index]!,
      transport: "ssh" as const,
      lifecycleState: "active" as const,
      createdAt: 1,
      target: {
        kind: "ssh" as const,
        host: "127.0.0.1",
        port: index + 1,
        username: "e2e",
        assetInstallMode: "remote-download" as const,
      },
    }));
    const entries = profiles.map((profile, index) => ({
      kind: "remote" as const,
      workspacePath: PROJECT_PATH,
      workspaceIdentity: index === 0 ? IDENTITY_A : IDENTITY_B,
      workspacePurpose: "project" as const,
      target: profile.target,
      lastOpenedAt: 1,
      lastConnectionStatus: "failed" as const,
    }));
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      // 旧 Host 的 tab 持久化会覆盖 direct seed；退出屏障后再写，保证新进程读取完整项目列表。
      afterElectronProcessExit: async () => {
        await seedSettings(
          appSettingsSchema.parse({
            ...before,
            remoteStartupAutoReconnectEnabled: false,
            sourceServerDirectoryMigrationVersion: 1,
            sourceServers: sources.map((sourceServerId, index) => ({
              sourceServerId,
              displayName: names[index]!,
              installState: "installed" as const,
              preferredProfileId: profiles[index]!.profileId,
              declaredWorkspaces: [],
            })),
            connectionProfiles: profiles,
            sourceServerWorkspaceHistory: entries.map((entry, index) => ({
              workspacePath: entry.workspacePath,
              workspaceIdentity: entry.workspaceIdentity,
              sourceServerId: sources[index]!,
              profileId: profiles[index]!.profileId,
              lastOpenedAt: 1,
            })),
            remoteConversationWorkspaceBySourceServerId: {
              [SOURCE_A]: { workspacePath: CHAT_PATH, lastResolvedAt: 1 },
            },
            lastWorkspaceSession: [
              ...(before.lastWorkspaceSession ?? []).filter((entry) => entry.kind === "local"),
              ...entries,
              {
                ...entries[0]!,
                workspaceIdentity: CHAT_IDENTITY,
                workspacePath: CHAT_PATH,
                workspacePurpose: "conversation",
              },
            ],
          }),
        );
        // 项目入口权威已迁到 SQLite；仅写旧 tab/history 不会创建 membership。
        // node:sqlite 仅提供同步连接，此时旧 App 已退出，不与 Host 并发写库。
        const db = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"));
        try {
          const projects = createRemoteProjectService({ database: async () => db });
          for (const [index, profile] of profiles.entries()) {
            const host = await projects.saveHost({
              id: `remote:server:${profile.sourceServerId}`,
              target: profile.target,
            });
            await projects.addEntry({
              hostId: host.id,
              expectedMembershipId: host.membershipId,
              project: {
                projectId: `rpn-project-${index}`,
                name: "project",
                roots: [{ rootPath: PROJECT_PATH, isPrimary: true, position: 0 }],
              },
            });
          }
        } finally {
          db.close();
        }
      },
    });
    await waitForRendererAfterColdRestart(CASE_MARKER);
    await selectTaskOrganizeMode(["项目", "Project"]);
    await browser.waitUntil(
      async () => (await $$("[data-project-workspace-identity]").length) === 2,
      {
        timeout: 30_000,
        timeoutMsg: `${CASE_MARKER}: 离线项目应直接展示为两条独立项目行`,
      },
    );
    expect(await $$("[data-source-group-key]")).toHaveLength(0);
    expect(await $$(`[data-testid="${TID_PROJECT_SECTION}"]`)).toHaveLength(1);
    expect(await $$(`[data-testid="${TID_CONVERSATION_SECTION}"]`)).toHaveLength(1);
    expect((await readRemoteTabSnapshot(CHAT_IDENTITY)).workspacePath).toBeNull();
    // Group 已退役；切换当前时间线/项目视图不应隐式连接或丢失离线 membership。
    // Radix 菜单依赖 pointerdown；DOM click 不打开菜单，不能据此误报时间线入口消失。
    // 上一次视图选择的菜单仍在退出时，trigger 点击会被吞掉；先等菜单卸载。
    await $('[role="menu"]').waitForExist({ reverse: true, timeout: 10_000 });
    await $('[data-testid="sidebar-view-menu"]').click();
    await $('[data-testid="sidebar-view-timeline"]').waitForDisplayed();
    await $('[data-testid="sidebar-view-timeline"]').click();
    // 先等时间线菜单退出，再开启下次选择，避免关闭动画吞掉紧接的 trigger click。
    await $('[role="menu"]').waitForExist({ reverse: true, timeout: 10_000 });
    expect((await readRemoteTabSnapshot(IDENTITY_A)).remoteSessionId).toBeNull();
    expect((await readRemoteTabSnapshot(IDENTITY_B)).remoteSessionId).toBeNull();
    await selectTaskOrganizeMode(["项目", "Project"]);
    expect(await $$("[data-project-workspace-identity]")).toHaveLength(2);
    for (const identity of [IDENTITY_A, IDENTITY_B]) {
      const row = $(`[data-project-workspace-identity="${identity}"]`);
      expect(await row.getAttribute("data-connection-state")).toBe("offline");
      // 设备全名已移到悬停详情，行内标签不再带 title；按可见文字判断设备可辨。
      expect(await row.$('[data-testid="project-device"]').getText()).toBe(
        identity === IDENTITY_A ? "alpha-device" : "beta-device",
      );
      await row.moveTo();
      await row.$('[data-testid="virtual-project-menu"]').click();
      await $('[data-testid="virtual-project-connect"]').waitForDisplayed();
      // RPN-17：离线远程项目也能从菜单进入设备设置。
      await $('[data-testid="virtual-project-device-settings"]').waitForDisplayed();
      expect(await row.$('[data-testid="virtual-project-create-task"]').isExisting()).toBe(false);
      // 悬停 300ms 后身份详情会叠在菜单上；Escape 按层关闭，先关详情再关菜单。
      await browser.waitUntil(
        async () => {
          await browser.keys("Escape");
          return !(await $('[role="menu"]').isDisplayed());
        },
        { timeout: 5_000, interval: 300, timeoutMsg: `${CASE_MARKER}: Escape 未关闭项目菜单` },
      );
    }
    expect((await readRemoteTabSnapshot(IDENTITY_A)).remoteSessionId).toBeNull();
    expect((await readRemoteTabSnapshot(IDENTITY_B)).remoteSessionId).toBeNull();
    // 数据保留依据是 canonical 历史映射，不把 UI open-set 是否保留误当作任务文件删除。
    expect(
      (await readSettings()).remoteConversationWorkspaceBySourceServerId?.[SOURCE_A]?.workspacePath,
    ).toBe(CHAT_PATH);
    const artifactDir = resolve(
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/rpn-project-navigation",
    );
    await mkdir(artifactDir, { recursive: true });
    await browser.saveScreenshot(resolve(artifactDir, "rpn-project-sidebar.png"));
    // 项目标题只展开历史；必须从项目菜单发起连接，再验证既有失败交接与凭据隔离。
    await requestRemoteProjectConnection(IDENTITY_A, CASE_MARKER);
    await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForDisplayed({ timeout: 20_000 });
    expect((await readRemoteTabSnapshot(CHAT_IDENTITY)).workspacePath).toBeNull();

    // RPN-06/08：真实表单必须隔离设备凭据，并保留已有线路下载方式；不发起网络连接。
    await $(`[data-testid="${TID_SSH_ERROR}"]`).waitForDisplayed({ timeout: 10_000 });
    await (await dialogButton(["返回配置", "Back to configuration"])).click();
    const password = $(`[data-testid="${TID_SSH_PASSWORD_INPUT}"]`);
    await password.waitForDisplayed();
    await password.setValue("E2E_RPN_SECRET_FOR_DEVICE_A");
    await (await dialogButton(["关闭", "Close"])).click();
    await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForDisplayed({ reverse: true });
    await requestRemoteProjectConnection(IDENTITY_B, CASE_MARKER);
    await $(`[data-testid="${TID_SSH_ERROR}"]`).waitForDisplayed({ timeout: 10_000 });
    await (await dialogButton(["返回配置", "Back to configuration"])).click();
    await password.waitForDisplayed();
    expect(await password.getValue()).toBe("");
    await (await dialogButton(["高级选项", "Advanced options"])).click();
    expect(
      await (
        await dialogButton(["远端服务器下载", "Download on remote server"])
      ).getAttribute("aria-pressed"),
    ).toBe("true");

    // 当前三屏已取消旧的两次返回/下一步；关闭清空旧意图，再从项目入口直接新建 SSH。
    await (await dialogButton(["关闭", "Close"])).click();
    await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForExist({ reverse: true });
    await openSSHRemoteDialog(CASE_MARKER);
    await password.waitForDisplayed();
    expect(await password.getValue()).toBe("");
    await (await dialogButton(["高级选项", "Advanced options"])).click();
    expect(
      await (
        await dialogButton(["本地下载后上传", "Download locally, then upload"])
      ).getAttribute("aria-pressed"),
    ).toBe("true");
    await browser.saveScreenshot(resolve(artifactDir, "rpn-connection-intent-isolation.png"));
    await (await dialogButton(["关闭", "Close"])).click();
    await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForExist({ reverse: true });
    // SSH 向导从「创建项目」进入，关闭后回到该弹窗；先取消，避免遮罩拦截侧栏点击。
    await browser.keys("Escape");
    await $('[data-slot="dialog-overlay"]').waitForExist({ reverse: true });

    // RPN-17：项目菜单「远程设备设置」只负责导航：只展开项目所属设备行、聚焦并高亮，不发起连接。
    const rowB = $(`[data-project-workspace-identity="${IDENTITY_B}"]`);
    await rowB.moveTo();
    await rowB.$('[data-testid="virtual-project-menu"]').click();
    const deviceSettings = $('[data-testid="virtual-project-device-settings"]');
    await deviceSettings.waitForDisplayed();
    await deviceSettings.click();
    await $(`[data-source-server-card="${SOURCE_B}"]`).waitForDisplayed({ timeout: 15_000 });
    await browser.waitUntil(
      () =>
        browser.execute((id) => {
          const card = document.querySelector(`[data-source-server-card="${id}"]`);
          const toggle = card?.querySelector("[data-source-server-toggle]");
          return (
            document.activeElement === toggle &&
            toggle?.getAttribute("aria-expanded") === "true" &&
            card?.hasAttribute("data-highlighted") === true
          );
        }, SOURCE_B),
      { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: 设置页没有定位到项目所属设备行` },
    );
    // 只展开目标设备，其他设备保持收起。
    expect(
      await browser.execute(
        () =>
          [...document.querySelectorAll('[data-source-server-toggle][aria-expanded="true"]')]
            .length,
      ),
    ).toBe(1);
    expect((await readRemoteTabSnapshot(IDENTITY_B)).remoteSessionId).toBeNull();
    await browser.saveScreenshot(resolve(artifactDir, "rpn-project-device-settings.png"));
  });
});
