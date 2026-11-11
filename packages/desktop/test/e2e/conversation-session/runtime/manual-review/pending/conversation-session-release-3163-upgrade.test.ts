import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_SETTINGS_BACK_BUTTON, TID_SETTINGS_SECTION_NAV, testId } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { stageE2EAppOutput } from "#e2e/helpers/e2e-app-output-stage";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  startElectronWindowRecording,
  type ElectronWindowRecordingSession,
} from "#e2e/helpers/electron-window-recorder";
import {
  openRemoteDevicesSettings,
  waitForDeviceStatus,
} from "#e2e/helpers/remote-project-actions";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  sendSSHFollowTurn,
  waitForRendererAfterColdRestart,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  runSSHCommand,
  waitForRemoteTab,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { selectV4TaskById } from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_RELEASE_3163_UPGRADE";
const BASELINE_COMMIT = "a82dd43e";
const desktopRoot = resolve(import.meta.dirname, "../../../../../..");
const currentRoot = resolve(desktopRoot, "../..");
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "release-3163-upgrade");

async function archiveHash(
  root: string,
  targetArch: "arm64" | "x64",
  version: string,
): Promise<string> {
  const digest = createHash("sha256");
  const archive = join(
    root,
    `packages/desktop/mock-cdn/releases/${version}/zcode-server-linux-${targetArch}.tar.gz`,
  );
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  return digest.digest("hex");
}

async function replaceRunApplication(root: string): Promise<void> {
  const runId = process.env.ZCODE_E2E_RUN_ID;
  if (!runId) throw new Error("缺少隔离 runId");
  // 只在旧 Electron 已完整退出的屏障内替换本次运行副本，保留同一 HOME 和浏览器数据。
  for (const [source, destination] of [
    [join(root, "packages/desktop/out"), join(desktopRoot, ".e2e-cache", runId, "app")],
    [join(root, "packages/desktop/mock-cdn"), join(desktopRoot, ".e2e-cache", runId, "mock-cdn")],
  ]) {
    await rm(destination!, { recursive: true, force: true });
    await stageE2EAppOutput(source!, destination!);
  }
}

async function readRelease(config: SSHConnectionConfig): Promise<Record<string, unknown>> {
  const result = await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"');
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout);
}

async function setStartupReconnectForNextBoot(enabled: boolean): Promise<void> {
  const file = join(getE2EAppDataPaths().appDataDir, "setting.json");
  const settings = JSON.parse(await readFile(file, "utf8"));
  await writeFile(
    file,
    JSON.stringify({ ...settings, remoteStartupAutoReconnectEnabled: enabled }),
  );
}

async function continueOriginalTask(task: SSHLifecycleTask): Promise<SSHLifecycleTask> {
  await selectV4TaskById(task.taskId, 60_000);
  const tab = await waitForRemoteTab({
    caseMarker: MARKER,
    expectedIdentity: task.identity,
    expectedPath: task.workspacePath,
    timeoutMs: 120_000,
  });
  expect(tab.remoteSessionId).toBeTruthy();
  const currentTask = { ...task, remoteSessionId: tab.remoteSessionId! };
  // helper 同时核对本次新回复和模型请求中的原历史，不能由旧回复满足成功断言。
  await sendSSHFollowTurn(currentTask, MARKER);
  return currentTask;
}

describe("REL3163-UPGRADE-01：真实 tag 到 staging 的桌面升级", () => {
  let provider: SSHLifecycleProvider | undefined;
  let recording: ElectronWindowRecordingSession | undefined;
  const facts: Record<string, unknown> = {};

  after(async () => {
    if (recording) {
      facts.lastRecording = await recording.stop().catch((error) => ({ error: String(error) }));
    }
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "facts.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("真实旧版创建的两个远程会话，在换包升级及再次冷启动后均可续聊", async function () {
    this.timeout(30 * 60_000);
    const baselineRoot = process.env.ZCODE_E2E_BASELINE_ROOT;
    if (!baselineRoot) throw new Error("需要 ZCODE_E2E_BASELINE_ROOT 指向真实 v3.16.3 构建");
    const baselineMeta = JSON.parse(
      await readFile(join(baselineRoot, "packages/desktop/out/metadata/build-meta.json"), "utf8"),
    );
    expect(baselineMeta.buildCommitId).toBe(BASELINE_COMMIT);
    facts.baselineBuild = baselineMeta;
    const stagingMeta = JSON.parse(
      await readFile(join(currentRoot, "packages/desktop/out/metadata/build-meta.json"), "utf8"),
    );
    facts.stagingBuild = stagingMeta;
    const expectedVersion = process.env.ZCODE_E2E_EXPECTED_RELEASE_VERSION;
    if (expectedVersion) {
      expect(stagingMeta.appVersion).toBe(expectedVersion);
      expect(stagingMeta.minCompatibleVersion).toBe(expectedVersion);
    }
    const prepared = await prepareSSHLifecycle(MARKER);
    provider = prepared.provider;
    const architecture = (await runSSHCommand(prepared.config, "uname -m")).stdout.trim();
    if (architecture !== "aarch64" && architecture !== "x86_64") {
      throw new Error(`未支持的 Docker 目标架构：${architecture}`);
    }
    const targetArch = architecture === "aarch64" ? "arm64" : "x64";
    const [oldHash, newHash] = await Promise.all([
      archiveHash(baselineRoot, targetArch, baselineMeta.appVersion),
      archiveHash(currentRoot, targetArch, stagingMeta.appVersion),
    ]);
    expect(oldHash).not.toBe(newHash);
    facts.archiveHashes = { oldHash, newHash };
    await mkdir(artifactDir, { recursive: true });

    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: () => replaceRunApplication(baselineRoot),
    });
    await waitForRendererAfterColdRestart(MARKER);
    // 业务构建来自真实 tag；两阶段使用同一 E2E Electron，不能将此证据当作安装器升级验证。
    facts.electronRuntime = await browser.electron.execute(() => process.versions.electron);
    facts.desktopArtifactScope = "tag source build in the shared E2E Electron runtime";
    recording = await startElectronWindowRecording({
      outputPath: join(artifactDir, "tag-before.webm"),
    });
    const tasks: SSHLifecycleTask[] = [];
    for (const [index, label] of (["A", "B"] as const).entries()) {
      tasks.push(
        await connectSSHWorkspaceAndSendFirstTurn({
          caseMarker: MARKER,
          config: prepared.config,
          provider,
          label,
          workspacePath: prepared.config.workspacePaths[index]!,
        }),
      );
    }
    const oldRelease = await readRelease(prepared.config);
    expect(oldRelease.archiveSha256).toBe(oldHash);
    facts.oldRelease = oldRelease;
    facts.oldTasks = tasks;
    await browser.saveScreenshot(join(artifactDir, "tag-two-projects.png"));
    await openRemoteDevicesSettings();
    expect(await $("[data-source-server-row]").isExisting()).toBe(false);
    expect(
      await $(`[data-testid="${testId(TID_SETTINGS_SECTION_NAV, "dataSync")}"]`).isExisting(),
    ).toBe(false);
    await browser.saveScreenshot(join(artifactDir, "tag-device-settings.png"));
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    facts.beforeVideo = await recording.stop();
    recording = undefined;

    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await replaceRunApplication(currentRoot);
        if (process.env.ZCODE_E2E_CHECK_OLD_LIFECYCLE === "1")
          await setStartupReconnectForNextBoot(false);
      },
    });
    await waitForRendererAfterColdRestart(MARKER);
    if (process.env.ZCODE_E2E_CHECK_OLD_LIFECYCLE === "1") {
      // 旧版离线记录尚未经过新连接握手，也不能因此放行旧 CLI 不支持的生命周期命令。
      const oldSource = parseRemoteWorkspaceIdentity(tasks[0]!.identity)?.sourceServerId;
      if (!oldSource) throw new Error("旧版离线记录缺少 Source 身份");
      await openRemoteDevicesSettings();
      await waitForDeviceStatus(oldSource, "offline", MARKER, 60_000);
      facts.oldOfflineStateConfirmed = true;
      await $(`[data-source-server-card="${oldSource}"] button[aria-label="更多"]`).click();
      await $('[role="menu"]').waitForDisplayed();
      const actions = await browser.execute(() =>
        [
          ...document.querySelectorAll<HTMLElement>(
            '[role="menu"] [data-source-server-lifecycle-action]',
          ),
        ]
          .filter((item) =>
            ["restart", "stop"].includes(item.dataset.sourceServerLifecycleAction ?? ""),
          )
          .map((item) => ({
            action: item.dataset.sourceServerLifecycleAction,
            disabled:
              item.getAttribute("data-disabled") !== null ||
              item.getAttribute("aria-disabled") === "true",
          })),
      );
      facts.oldOfflineLifecycleActions = actions;
      facts.oldOfflineLifecycleSafe = actions.every((item) => item.disabled);
      await browser.saveScreenshot(join(artifactDir, "old-offline-lifecycle-gate.png"));
      await browser.keys("Escape");
      await reloadElectronSessionPreservingBrowserProfile(browser, {
        afterElectronProcessExit: () => setStartupReconnectForNextBoot(true),
      });
      await waitForRendererAfterColdRestart(MARKER);
    }
    recording = await startElectronWindowRecording({
      outputPath: join(artifactDir, "staging-upgrade.webm"),
    });
    const sourceId = parseRemoteWorkspaceIdentity(tasks[0]!.identity)?.sourceServerId;
    if (!sourceId) throw new Error("旧版项目缺少稳定 Source 身份");
    await openRemoteDevicesSettings();
    expect(
      await $(`[data-testid="${testId(TID_SETTINGS_SECTION_NAV, "dataSync")}"]`).isExisting(),
    ).toBe(true);
    const card = `[data-source-server-card="${sourceId}"]`;
    // 旧 archive 与开发构建同版本但不同 SHA，冷启动应停在“需要更新”；不能先要求在线。
    // 走产品提供的更新主操作，不用重装绕过版本准入。
    await waitForDeviceStatus(sourceId, "pending", MARKER, 120_000);
    await browser.saveScreenshot(join(artifactDir, "staging-update-required.png"));
    expect((await readRelease(prepared.config)).archiveSha256).toBe(oldHash);
    const update = $(card).$("button=更新远端");
    await update.waitForEnabled({ timeout: 30_000 });
    await update.click();
    await waitForDeviceStatus(sourceId, "online", MARKER, 300_000);
    // online 可能短暂仍来自旧快照，最终 archive 身份必须证明已完成真实换包。
    await browser.waitUntil(
      async () => (await readRelease(prepared.config)).archiveSha256 === newHash,
      {
        timeout: 300_000,
        timeoutMsg: "远端没有切换到 staging 的真实 archive",
      },
    );
    facts.newRelease = await readRelease(prepared.config);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    const upgraded = [];
    for (const task of tasks) upgraded.push(await continueOriginalTask(task));
    facts.upgradedTasks = upgraded;
    await browser.saveScreenshot(join(artifactDir, "staging-original-history.png"));
    facts.upgradeVideo = await recording.stop();
    recording = undefined;

    await reloadElectronSessionPreservingBrowserProfile(browser);
    await waitForRendererAfterColdRestart(MARKER);
    for (const task of upgraded) await continueOriginalTask(task);
    await browser.saveScreenshot(join(artifactDir, "staging-cold-restore.png"));
    expect((await readRelease(prepared.config)).archiveSha256).toBe(newHash);
    facts.coldRestore = "both original task IDs and histories continued";
    if (process.env.ZCODE_E2E_CHECK_OLD_LIFECYCLE === "1")
      expect(facts.oldOfflineLifecycleSafe).toBe(true);
  });
});
