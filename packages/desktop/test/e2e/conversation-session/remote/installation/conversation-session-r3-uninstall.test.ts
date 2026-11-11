import { runConfirmedProcess } from "#e2e/helpers/confirmed-process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_BACK_BUTTON,
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_SSH_ERROR,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  readSettings,
} from "#e2e/helpers/desktop-app";
import { getV4Messages, getV4ConversationState } from "#e2e/helpers/v4-conversation";
import {
  prepareSSHLifecycle,
  connectSSHWorkspaceAndSendFirstTurn,
  type SSHLifecycleProvider,
  sendSSHFollowTurn,
  waitForRemoteWorkspaceDisconnected,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  openWorkspaceDraftFromSidebar,
  selectTaskOrganizeMode,
} from "#e2e/helpers/workspace-agent-warmup";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  openSSHSourceDirectory,
  readHostProcesses,
  readRemoteTabSnapshot,
  runSSHCommand,
  waitForSSHDirectoryStep,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";

import { requestRemoteProjectConnection } from "#e2e/helpers/remote-project-actions";

const CASE_MARKER = "E2E_R3_UNINSTALL";
const variant = process.env.R3_UNINSTALL_CASE ?? "preserve-data";
if (variant !== "preserve-data" && variant !== "replace-environment") {
  throw new Error(`Unsupported R3_UNINSTALL_CASE: ${variant}`);
}
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-uninstall");

async function readInstallFacts(config: SSHConnectionConfig) {
  const result = await runSSHCommand(
    config,
    'echo "installationId=$(grep -o \'"installationId": *"[^"]*"\' "$HOME/.zcode/server/install.json" 2>/dev/null | grep -oE "[0-9a-f-]{36}")"; ' +
      'echo "current=$(test -f "$HOME/.zcode/server/current.json" && echo present || echo none)"; ' +
      'echo "releases=$(ls "$HOME/.zcode/server/releases" 2>/dev/null | tr "\\n" ",")"; ' +
      'echo "configSentinel=$(cat "$HOME/.zcode/server/config/e2e-sentinel.txt" 2>/dev/null || echo none)"; ' +
      'echo "legacyAsset=$(test -e "$HOME/.zcode/server/e2e-legacy-asset.bin" && echo present || echo none)"; ' +
      'echo "userData=$(cat "$HOME/.zcode/e2e-user-data.txt" 2>/dev/null || echo none)"; ' +
      'echo "serverEntries=$(ls -A "$HOME/.zcode/server" 2>/dev/null | tr "\\n" ",")"; ' +
      'echo "uninstalledMarker=$(cat "$HOME/.zcode/server/uninstalled.json" 2>/dev/null | tr -d "\\n ")"',
  );
  return Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  ) as Record<string, string>;
}

async function readVisibleTaskIds(identity: string): Promise<string[]> {
  await selectTaskOrganizeMode(["项目", "Project"]);
  const newProject = $(
    `[data-project-workspace-identity="${identity}"] [data-testid="virtual-project-toggle"]`,
  );
  if ((await newProject.getAttribute("aria-expanded")) !== "true") await newProject.click();
  let newTaskIds: string[] = [];
  await browser.waitUntil(
    async () => {
      const visible = await browser.execute((identity) => {
        const row = document.querySelector<HTMLElement>(
          `[data-project-workspace-identity="${identity}"]`,
        );
        // 新项目 section 自身包含任务列表；旧 li 祖先已不存在，不能因此把旧历史读成空列表。
        const taskIds = Array.from(
          row?.querySelectorAll<HTMLElement>('[data-testid^="task-item-"]') ?? [],
        ).map((item) => item.dataset.testid!.slice("task-item-".length));
        return { taskIds, empty: /暂无任务|No tasks/iu.test(row?.textContent ?? "") };
      }, identity);
      newTaskIds = visible.taskIds;
      return visible.empty || newTaskIds.length > 0;
    },
    { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 项目任务列表未完成加载` },
  );
  return newTaskIds;
}

describe(`${CASE_MARKER}: ${variant}，卸载重装与独立环境替换`, () => {
  const facts: Record<string, unknown> = { variant };
  let provider: SSHLifecycleProvider | null = null;

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "uninstall.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it(`R3A-UPG-09 ${variant}: 卸载保留身份与历史；独立环境才确认新设备`, async function () {
    this.timeout(20 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, { tunnelUsername: "tunnel" });
    provider = prepared.provider;
    const config = prepared.config;
    const workspaceA = config.workspacePaths[0];
    const initialHosts = await readHostProcesses();

    // 0911 修复：runner 每轮重建容器，全新目标没有 current.json——if 分支（正式
    // 卸载链路）永远进不去，错误落入为“容器复用上一轮卸载现场”设计的 else 分支，
    // uninstalledMarker 断言空串稳定 FAIL（r3-rerun §51 两次实录）。先经正式向导
    // 完成首装，满足“前置：已安装目标”，再放哨兵做卸载对账。
    const firstTab = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config,
      provider,
      label: "A",
      workspacePath: workspaceA,
    });
    facts.originalTask = {
      taskId: firstTab.taskId,
      identity: firstTab.identity,
      prompt: firstTab.firstPrompt,
    };
    facts.firstSession = firstTab.remoteSessionId;
    const originalSettings = await readSettings();

    // 前置：已安装目标；放置 config 哨兵、旧散资产、用户数据哨兵。
    const seed = await runSSHCommand(
      config,
      'mkdir -p "$HOME/.zcode/server/config" && echo R3_CONFIG_SENTINEL > "$HOME/.zcode/server/config/e2e-sentinel.txt" && ' +
        'head -c 1024 /dev/zero > "$HOME/.zcode/server/e2e-legacy-asset.bin" && echo R3_USER_DATA > "$HOME/.zcode/e2e-user-data.txt" && echo ok',
    );
    expect(seed.stdout.trim()).toBe("ok");
    const before = await readInstallFacts(config);
    facts.before = before;
    const previousInstallationId = before.installationId;
    if (!previousInstallationId) throw new Error("首装没有安装身份");
    expect(previousInstallationId).toMatch(/^[0-9a-f-]{36}$/u);
    if (before.current === "present") {
      // 正式 CLI 卸载：收到每次确认提示后分别输入 DELETE，避免旧管道固定等待 33 秒。
      // 保留两次人工确认协议与 docker exec -i；不使用 --force 或直接删除目录代替卸载。
      const container = process.env.ZCODE_E2E_SSH_CONTAINER?.trim();
      if (!container) throw new Error(`${CASE_MARKER}: 缺少 ZCODE_E2E_SSH_CONTAINER`);
      const uninstallStarted = performance.now();
      const uninstall = await runConfirmedProcess(
        "docker",
        [
          "exec",
          "-i",
          "-u",
          "dev",
          container,
          "bash",
          "-lc",
          '"$HOME/.zcode/server/bin/zcode" uninstall --server-root "$HOME/.zcode/server" --json',
        ],
        {
          prompts: ["Type DELETE to uninstall ZCode Server: ", "Type DELETE again to confirm: "],
          answer: "DELETE",
          timeoutMs: 120_000,
        },
      );
      facts.uninstallDurationMs = Math.round(performance.now() - uninstallStarted);
      facts.uninstallOutput = uninstall.stdout.trim().split("\n").slice(-3);
      expect(uninstall.stdout).toContain('"uninstalled":true');
      expect(uninstall.stdout).toMatch(/"preservedPaths":\[[^\]]*"config"/u);
    } else {
      facts.uninstallOutput = "already uninstalled before this run (marker present)";
      expect(before.uninstalledMarker).toContain('"uninstalled":true');
    }
    const after = await readInstallFacts(config);
    facts.afterUninstall = after;
    // allowlist 只删运行资产：current/releases/run 消失；config 与其中哨兵原样保留；非 allowlist 的旧散资产与用户数据不动。
    expect(after.installationId).toBe(previousInstallationId);
    expect(after.current).toBe("none");
    expect(after.releases).toBe("");
    expect(after.configSentinel).toBe("R3_CONFIG_SENTINEL");
    expect(after.legacyAsset).toBe("present");
    expect(after.userData).toBe("R3_USER_DATA");
    expect(after.uninstalledMarker).toContain('"uninstalled":true');
    expect(after.uninstalledMarker).toContain("config");

    if (variant === "preserve-data") {
      await waitForRemoteWorkspaceDisconnected(firstTab.identity, CASE_MARKER);
      await requestRemoteProjectConnection(firstTab.identity, CASE_MARKER);
      // 原项目把未安装错误交接给向导，同时展示安装确认；先执行用户确认再等待连接结果。
      await (async () => {
        const button = $('[data-testid="ssh-dialog"]').$(
          './/button[normalize-space(.)="安装并继续" or normalize-space(.)="Install and continue"]',
        );
        await button.waitForClickable({
          timeout: 30_000,
          timeoutMsg: `${CASE_MARKER}: 原项目没有显示重新安装确认`,
        });
        await button.click();
      })().catch(async (cause: unknown) => {
        // 保留真实安装与 attachment 状态，区分缺少交接和意外静默重装，不能只记录向导超时。
        facts.reinstallFailure = {
          installation: await readInstallFacts(config),
          tab: await readRemoteTabSnapshot(firstTab.identity),
          ui: await browser.execute(
            (identity) => ({
              dialog: document.querySelector('[data-testid="ssh-dialog"]')?.textContent ?? null,
              projectState:
                document
                  .querySelector(`[data-project-workspace-identity="${identity}"]`)
                  ?.getAttribute("data-connection-state") ?? null,
            }),
            firstTab.identity,
          ),
        };
        throw cause;
      });
      facts.installConfirmationClicked = true;
      await $(`[data-testid="${TID_SSH_ERROR}"]`).waitForDisplayed({
        reverse: true,
        timeout: 30_000,
      });
      await waitForSSHDirectoryStep(CASE_MARKER);
      const restored = await waitForRemoteTab({
        caseMarker: CASE_MARKER,
        expectedIdentity: firstTab.identity,
        expectedPath: workspaceA,
      });
      expect(restored.remoteSessionId).toBeTruthy();
      expect(restored.remoteSessionId).not.toBe(firstTab.remoteSessionId);
      const installed = await readInstallFacts(config);
      expect(installed.installationId).toBe(previousInstallationId);
      expect(installed.current).toBe("present");
      expect(installed.configSentinel).toBe("R3_CONFIG_SENTINEL");
      expect(installed.userData).toBe("R3_USER_DATA");
      const settings = await readSettings();
      const profileIds = (value: typeof settings) =>
        value.connectionProfiles?.map((profile) => profile.profileId).sort();
      expect(profileIds(settings)).toEqual(profileIds(originalSettings));
      expect(settings.sourceServers?.map((source) => source.sourceServerId).sort()).toEqual(
        originalSettings.sourceServers?.map((source) => source.sourceServerId).sort(),
      );
      for (const original of originalSettings.connectionProfiles ?? []) {
        const current = settings.connectionProfiles?.find(
          (profile) => profile.profileId === original.profileId,
        );
        expect(current?.sourceServerId).toBe(original.sourceServerId);
        expect(current?.target).toEqual(original.target);
        expect(current?.lifecycleState).not.toBe("retired");
      }
      const projectKeys = (value: typeof settings) =>
        value.sourceServerWorkspaceHistory
          ?.map(({ sourceServerId, profileId, workspaceIdentity, workspacePath }) =>
            JSON.stringify({ sourceServerId, profileId, workspaceIdentity, workspacePath }),
          )
          .sort();
      expect(projectKeys(settings)).toEqual(projectKeys(originalSettings));
      const taskIds = await readVisibleTaskIds(firstTab.identity);
      expect(taskIds).toContain(firstTab.taskId);
      await sendSSHFollowTurn(
        { ...firstTab, remoteSessionId: restored.remoteSessionId! },
        CASE_MARKER,
      );
      expect((await getV4ConversationState()).taskId).toBe(firstTab.taskId);
      facts.preservedIdentity = {
        sourceServerId: installed.installationId,
        workspaceIdentity: restored.workspaceIdentity,
        profileIds: profileIds(settings),
        originalProjectKeys: projectKeys(originalSettings),
        restoredProjectKeys: projectKeys(settings),
        previousSession: firstTab.remoteSessionId,
        restoredSession: restored.remoteSessionId,
        taskIds,
        continuedTaskId: firstTab.taskId,
      };
      await browser.saveScreenshot(resolve(artifactDir, "preserved-history.png"));
      expect(await readHostProcesses()).toEqual(initialHosts);
      return;
    }

    // 身份变化只由真正独立的数据环境触发。完整封存旧数据，不能只删 UUID 却共享历史库。
    const replaced = await runSSHCommand(
      config,
      'test ! -e "$HOME/r3-uninstall-preserved-data" && mv "$HOME/.zcode" "$HOME/r3-uninstall-preserved-data"',
    );
    expect(replaced.code).toBe(0);
    facts.originalDataArchived = true;
    // 同一线路安装到空环境，检测到不同身份后必须等待确认；取消不改绑原连接。
    await openWorkspaceDraftFromSidebar(resolve(getE2EAppDataPaths().homeDir, "ZCodeProject"));
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    let identityError = "";
    try {
      await waitForSSHDirectoryStep(CASE_MARKER);
    } catch (error) {
      identityError = String(error);
    }
    facts.reconnectFirstAttempt = identityError.slice(0, 200);
    if (!/身份换代|身份已变化|identity has changed/iu.test(identityError)) {
      throw new Error(
        `${CASE_MARKER}: 首连预期报身份换代错误，实际: ${identityError || "(成功，与独立环境状态矛盾)"}`,
      );
    }
    // 关闭报错向导，进入设置>远程设备确认换代。
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const close = Array.from(
            document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
          ).find(
            (button) =>
              button.getClientRects().length &&
              !button.disabled &&
              ["关闭", "Close"].includes(button.innerText.trim()),
          );
          close?.click();
          return Boolean(close);
        }),
      { timeout: 30_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 报错向导没有关闭按钮` },
    );
    await $('[data-testid="ssh-dialog"]').waitForExist({ reverse: true });
    // 身份确认属于设置连接流程；关闭错误页后仍在设置，不能点击被它遮挡的全局入口。
    if (!(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed())) {
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
        timeout: 15_000,
        timeoutMsg: `${CASE_MARKER}: 没有设置入口`,
      });
    }
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 15_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"), {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 设置页没有远程设备分区`,
    });
    // 身份变化必须经用户确认；重装按钮不能替代确认，更不能删除设备绕过身份边界。
    const pendingSettings = await readSettings();
    const oldProfile = pendingSettings.connectionProfiles?.find(
      (profile) =>
        profile.sourceServerId === previousInstallationId && profile.lifecycleState !== "retired",
    );
    expect(oldProfile).toBeDefined();
    const clickIdentityConfirmation = async () => {
      await browser.waitUntil(
        () =>
          browser.execute((sourceId) => {
            // 安装身份才是设备卡的稳定定位；线路地址文本会随当前/默认连接展示改变。
            const card = document.querySelector(`[data-source-server-card="${sourceId}"]`);
            const button = Array.from(card?.querySelectorAll("button") ?? []).find(
              (node) =>
                node.getClientRects().length &&
                !node.disabled &&
                node.innerText.trim() === "作为新设备使用",
            );
            button?.click();
            return Boolean(button);
          }, previousInstallationId),
        { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 身份换代待确认，但设备卡没有可用确认入口` },
      );
      await $(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`).waitForDisplayed({
        timeout: 15_000,
      });
    };
    try {
      await clickIdentityConfirmation();
      await browser.saveScreenshot(resolve(artifactDir, "identity-confirmation.png"));
      // 取消必须保留原绑定；不能在打开确认框时就提交身份替换。
      await browser.keys(["Escape"]);
      await $(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`).waitForDisplayed({
        reverse: true,
        timeout: 15_000,
      });
      expect((await readSettings()).connectionProfiles).toEqual(pendingSettings.connectionProfiles);
      facts.cancelPreservedOriginalProfiles = true;
      await clickIdentityConfirmation();
      await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
      await browser.waitUntil(
        async () => {
          const settings = await readSettings();
          return (
            settings.connectionProfiles?.some(
              (profile) =>
                profile.profileId === oldProfile!.profileId && profile.lifecycleState === "retired",
            ) ?? false
          );
        },
        { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: 确认后旧线路没有按身份替换合同归档` },
      );
      const installed = await readInstallFacts(config);
      const settings = await readSettings();
      const replacement = settings.connectionProfiles?.find(
        (profile) =>
          profile.sourceServerId === installed.installationId &&
          profile.lifecycleState !== "retired",
      );
      expect(replacement).toBeDefined();
      expect(replacement!.profileId).not.toBe(oldProfile!.profileId);
      expect(installed.installationId).not.toBe(previousInstallationId);
      expect(
        settings.sourceServers?.some((server) => server.sourceServerId === previousInstallationId),
      ).toBe(true);
      expect(
        settings.sourceServerWorkspaceHistory?.filter(
          (entry) => entry.sourceServerId === previousInstallationId,
        ),
      ).toEqual(
        pendingSettings.sourceServerWorkspaceHistory?.filter(
          (entry) => entry.sourceServerId === previousInstallationId,
        ),
      );
      facts.identityConfirmed = {
        oldSource: previousInstallationId,
        newSource: installed.installationId,
        oldProfileRetired: true,
        replacementProfileCreated: true,
        oldHistoryPreserved: true,
      };
    } catch (error) {
      facts.identityConfirmationFailure = {
        message: String(error),
        settingsPanelText: await browser.execute(
          () =>
            document.querySelector<HTMLElement>('[data-testid="settings-page"]')?.innerText ??
            "absent",
        ),
        installation: await readInstallFacts(config),
      };
      throw error;
    }
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    // 旧 helper 进入空的新建连接表单，无法找到已保存设备；复用项目设备选择并排除已归档线路。
    const newInstallation = await readInstallFacts(config);
    await openSSHSourceDirectory(config, CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(workspaceA, CASE_MARKER);
    const reconnectedTab = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: workspaceA,
      expectedIdentity: buildServerRemoteWorkspaceIdentity({
        serverId: newInstallation.installationId!,
        workspacePath: workspaceA,
      }),
    });
    facts.reconnectedSession = {
      before: firstTab.remoteSessionId,
      after: reconnectedTab.remoteSessionId,
    };
    expect(reconnectedTab.remoteSessionId).toBeTruthy();
    expect(reconnectedTab.remoteSessionId).not.toBe(firstTab.remoteSessionId);
    const reinstalled = await readInstallFacts(config);
    facts.afterReinstall = reinstalled;
    expect(reinstalled.current).toBe("present");
    expect(reinstalled.installationId).toMatch(/[0-9a-f-]{36}/u);
    expect(reinstalled.installationId).not.toBe(previousInstallationId);
    facts.installationIdChanged = reinstalled.installationId !== previousInstallationId;
    expect(reinstalled.configSentinel).toBe("none");
    expect(reinstalled.userData).toBe("none");
    // 真实旧任务保留在封存的数据环境；新环境不能因目录相同而得到旧历史。
    const runtime = JSON.parse(
      (await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout,
    );
    const history = await runSSHCommand(
      config,
      `'${runtime.releaseDir}/runtime/node' --input-type=module -e 'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync(process.env.HOME+"/r3-uninstall-preserved-data/v2/tasks-index.sqlite");const rows=db.prepare("SELECT workspace_key FROM tasks WHERE task_id=?").all(process.argv[1]);db.close();process.stdout.write(JSON.stringify(rows));' '${firstTab.taskId}'`,
    );
    expect(history.code).toBe(0);
    const oldRows = JSON.parse(history.stdout) as Array<{ workspace_key: string }>;
    expect(oldRows.length).toBeGreaterThan(0);
    // Server 保留 legacy canonical key 以支持回退；安装 UUID 是 App 设备身份，不能拿它断言内部存储格式。
    facts.preservedTaskStorageRows = oldRows;
    const newTaskIds = await readVisibleTaskIds(reconnectedTab.workspaceIdentity!);
    facts.newInstallationTaskIds = newTaskIds;
    expect(newTaskIds).not.toContain(firstTab.taskId);
    expect((await getV4ConversationState()).taskId).not.toBe(firstTab.taskId);
    expect(
      (await getV4Messages("user")).some((message) => message.text?.includes(firstTab.firstPrompt)),
    ).toBe(false);
    facts.oldHistoryPreservedOutsideNewEnvironment = true;
    await browser.saveScreenshot(resolve(artifactDir, "new-environment-empty.png"));
    expect(await readHostProcesses()).toEqual(initialHosts);
  });
});
