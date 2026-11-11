import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";
import { disconnectRemoteSource } from "#e2e/helpers/remote-project-actions";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  parseRemoteWorkspaceIdentity,
  sourceServerReleaseDescriptorSchema,
  type SourceServerReleaseArchive,
} from "@zcode/shared";
import {
  selectSourceServerReleaseArchive,
  withSourceServerReleaseFileFault,
} from "#e2e/helpers/source-server-release-faults";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import {
  clickLastEnabledSSHDialogButton,
  connectSSHWorkspace,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readDualSSHRuntimeConfig,
  readHostProcesses,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_R3_INSTALL_FAULTS";
// 从当前 spec 回到 desktop，保持隔离 mock-cdn 与版本文件定位正确。
const DESKTOP_ROOT = resolve(import.meta.dirname, "../../../../..");
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-install-faults",
);

interface FaultRecord {
  fault: string;
  target: string;
  archiveFileName: string;
  port: number;
  dialogState: string;
  errorText: string;
  remoteInstalledAfter: string;
  remoteTabSessionId: string | null;
  hostsUnchanged: boolean;
}

/** WDIO 每次 run 会把 mock-cdn release 硬链接到 runId 隔离目录；这里只改隔离目录里的文件，先解链再写。 */
async function stagedReleaseDir(): Promise<string> {
  const runId = process.env.ZCODE_E2E_RUN_ID?.trim();
  if (!runId) throw new Error(`${CASE_MARKER}: ZCODE_E2E_RUN_ID 缺失`);
  // WDIO worker 的 ZCODE_VERSION 是 dev 值，staged 目录使用仓库版本；文件读取保持异步。
  const { version } = JSON.parse(
    await readFile(resolve(DESKTOP_ROOT, "../../package.json"), "utf8"),
  );
  return join(DESKTOP_ROOT, ".e2e-cache", runId, "mock-cdn", "releases", version);
}

async function remoteInstalledState(config: SSHConnectionConfig): Promise<string> {
  const result = await runSSHCommand(
    config,
    'if [ -f "$HOME/.zcode/server/current.json" ]; then grep -o \'"archiveSha256": *"[0-9a-f]*"\' "$HOME/.zcode/server/current.json"; else echo none; fi',
  );
  return result.stdout.trim() || `exit=${result.code}`;
}

async function attemptConnectExpectingFailure(
  config: SSHConnectionConfig,
  fault: string,
  initialHosts: Array<{ name: string; pid: number }>,
  archive: SourceServerReleaseArchive,
): Promise<FaultRecord> {
  await openSSHRemoteDialog(CASE_MARKER);
  await fillSSHPasswordSettings(config);
  await clickLastEnabledSSHDialogButton(CASE_MARKER);
  // 未安装目标会先出现安装确认；确认后 release 解析必须以明确错误结束，不能回退到未知旧包。
  let errorText = "";
  let dialogState = "waiting";
  let record: FaultRecord;
  try {
    await browser.waitUntil(
      async () => {
        const state = await browser.execute(() => {
          const error = document.querySelector<HTMLElement>('[data-testid="ssh-error"]');
          if (error?.getClientRects().length) return `error:${error.innerText.trim()}`;
          const dialog = document.querySelector('[data-testid="ssh-dialog"]');
          const install = Array.from(
            dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
          ).find(
            (item) =>
              item.getClientRects().length &&
              !item.disabled &&
              ["安装并继续", "Install and continue"].includes(item.innerText.trim()),
          );
          if (install) {
            install.click();
            return "confirmed";
          }
          return dialog ? "waiting" : "dialog-gone";
        });
        dialogState = state.startsWith("error:") ? "error" : state;
        // 终态交给循环外断言，避免 waitUntil 吞掉异常后继续轮询 120 秒。
        if (state === "dialog-gone") return true;
        if (state.startsWith("error:")) {
          errorText = state.slice("error:".length);
          return true;
        }
        return false;
      },
      { timeout: 120_000, interval: 300, timeoutMsg: `${CASE_MARKER}: ${fault} 没有显示明确错误` },
    );
  } finally {
    const snapshot = await readRemoteTabSnapshot();
    record = {
      fault,
      target: archive.target,
      archiveFileName: archive.fileName,
      port: config.port,
      dialogState,
      errorText,
      remoteInstalledAfter: await remoteInstalledState(config),
      remoteTabSessionId: snapshot.remoteSessionId,
      hostsUnchanged: JSON.stringify(await readHostProcesses()) === JSON.stringify(initialHosts),
    };
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, `${fault}.json`), JSON.stringify(record, null, 2));
  }
  if (dialogState === "dialog-gone") {
    throw new Error(`${CASE_MARKER}: ${fault} 未停留在错误态: ${JSON.stringify(record)}`);
  }
  // 当前错误面板默认展示用户可读分类，原始内部异常收进详细信息；不能再要求主面板直接显示英文实现名。
  expect(record.errorText).toMatch(/资源|校验|安装包|release|archive|verification/iu);
  expect(record.errorText).not.toContain(config.password);
  expect(record.hostsUnchanged).toBe(true);
  await closeSSHDialogFromError();
  return record;
}

async function closeSSHDialogFromError(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('[data-testid="ssh-dialog"]');
        if (!dialog) return true;
        const back = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
          (item) =>
            item.getClientRects().length &&
            !item.disabled &&
            ["返回配置", "Back to settings", "关闭", "Close"].includes(item.innerText.trim()),
        );
        back?.click();
        const close = document.querySelector<HTMLButtonElement>(
          '[data-testid="ssh-dialog"] button[aria-label="Close"], [data-testid="ssh-dialog"] button[aria-label="关闭"]',
        );
        close?.click();
        return false;
      }),
    { timeout: 30_000, interval: 300, timeoutMsg: `${CASE_MARKER}: 失败后无法关闭 SSH 向导` },
  );
  await browser.keys(["Escape"]);
  await browser.waitUntil(
    () => browser.execute(() => !document.querySelector('[data-testid="ssh-dialog"]')),
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: SSH 向导没有关闭` },
  );
}

describe(`${CASE_MARKER}: 本地 release 产物缺失/校验失败与安装确认取消`, () => {
  const records: FaultRecord[] = [];

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "install-faults.json"), JSON.stringify(records, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-BLD-04/06 descriptor 缺失、archive 缺失、SHA/size 不符均明确失败且不落地；取消确认后重试成功", async function () {
    this.timeout(30 * 60_000);
    const fresh = readSSHRuntimeConfig(CASE_MARKER);
    const dual = readDualSSHRuntimeConfig(CASE_MARKER);
    const installedTarget = dual.targets[1];
    // 预装对照目标也要先完成桌面初始化；不能在登录/恢复尚未就绪时直接点击新任务。
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    expect(initialHosts).toHaveLength(1);
    expect(await remoteInstalledState(fresh)).toBe("none");
    // runner 的 dual 是两个全新容器：B 作为“已安装目标”对照（installed-target
    // tampered 步骤与下方 installedBefore 断言的前置），必须先完整走一次连接安装。
    const preinstalled = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config: installedTarget,
      workspacePath: dual.workspacePath,
    });
    expect(preinstalled.remoteSessionId).toBeTruthy();
    const installedBefore = await remoteInstalledState(installedTarget);
    expect(installedBefore).toContain("archiveSha256");

    // 根因：B 首装后仍在线时会直接复用现有会话，根本不读取被篡改的本地包。
    // 通过真实 UI 断开并等待同一 identity 离线，才能覆盖已安装目标的重新校验路径。
    const installedIdentity = preinstalled.workspaceIdentity!;
    const installedSourceId = parseRemoteWorkspaceIdentity(installedIdentity)?.sourceServerId;
    expect(installedSourceId).toBeTruthy();
    await selectTaskOrganizeMode(["项目", "Project"]);
    await disconnectRemoteSource(installedSourceId!, CASE_MARKER, {
      workspaceIdentities: [installedIdentity],
    });
    // 断开后主区域仍停在 B 的离线页，准备 helper 只等待就绪，不负责切回本地。
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);

    const releaseDir = await stagedReleaseDir();
    const descriptorPath = join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
    const originalDescriptor = await readFile(descriptorPath, "utf8");
    const descriptor = sourceServerReleaseDescriptorSchema.parse(JSON.parse(originalDescriptor));
    const readTargetArchive = async (config: SSHConnectionConfig) => {
      const environment = await runSSHCommand(config, "uname -s && uname -m");
      expect(environment.code).toBe(0);
      const [platform = "", arch = ""] = environment.stdout.trim().split(/\r?\n/);
      const entry = selectSourceServerReleaseArchive(descriptor, { platform, arch });
      const path = join(releaseDir, entry.fileName);
      const bytes = await readFile(path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
      expect((await stat(path)).size).toBe(entry.sizeBytes);
      return { entry, path, bytes };
    };
    const freshArchive = await readTargetArchive(fresh);
    const installedArchive = await readTargetArchive(installedTarget);
    expect(installedBefore).toContain(installedArchive.entry.sha256);

    expect(await readHostProcesses()).toEqual(initialHosts);

    const expectFreshFailure = async (fault: string) => {
      const record = await attemptConnectExpectingFailure(
        fresh,
        fault,
        initialHosts,
        freshArchive.entry,
      );
      records.push(record);
      expect(record.remoteInstalledAfter).toBe("none");
      expect(record.remoteTabSessionId).toBeNull();
    };

    // 1. descriptor 缺失；后续每次注入都在 finally 恢复，不依赖成功断言收尾。
    await withSourceServerReleaseFileFault(descriptorPath, null, () =>
      expectFreshFailure("descriptor-missing"),
    );

    // 2. 必须移走 A 实际使用的包，不能用 x64 常量模拟 ARM64 的安装失败。
    await withSourceServerReleaseFileFault(freshArchive.path, null, () =>
      expectFreshFailure("archive-missing"),
    );

    // 3. 保持 size 不变，只破坏 SHA，避免 size 校验提前拒绝而未覆盖 SHA 校验。
    const tamperedArchive = Buffer.from(freshArchive.bytes);
    tamperedArchive[0] = tamperedArchive[0]! ^ 1;
    await withSourceServerReleaseFileFault(freshArchive.path, tamperedArchive, () =>
      expectFreshFailure("archive-sha-mismatch"),
    );

    // 4. 仅修改 A 对应 descriptor 条目的 size，SHA 和 archive 保持正确。
    const sizeTampered = {
      ...descriptor,
      archives: descriptor.archives.map((entry) =>
        entry.target === freshArchive.entry.target
          ? { ...entry, sizeBytes: entry.sizeBytes + 1 }
          : entry,
      ),
    };
    await withSourceServerReleaseFileFault(descriptorPath, JSON.stringify(sizeTampered), () =>
      expectFreshFailure("descriptor-size-mismatch"),
    );

    // 5. B 的架构独立选取；损坏本地产物不得改写 B 的既有远端安装。
    await withSourceServerReleaseFileFault(
      installedArchive.path,
      Buffer.concat([installedArchive.bytes, Buffer.from("e2e-tamper")]),
      async () => {
        const record = await attemptConnectExpectingFailure(
          installedTarget,
          "installed-target-local-archive-tampered",
          initialHosts,
          installedArchive.entry,
        );
        records.push(record);
        expect(record.remoteInstalledAfter).toBe(installedBefore);
      },
    );

    // 6. BLD-06：产物恢复后，安装确认点取消 -> 远端无安装、无 pending 会话；重连确认 -> 成功安装
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(fresh);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const dialog = document.querySelector('[data-testid="ssh-dialog"]');
          const buttons = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []);
          const install = buttons.find(
            (item) =>
              item.getClientRects().length &&
              ["安装并继续", "Install and continue"].includes(item.innerText.trim()),
          );
          if (!install) return false;
          const cancel = buttons.find(
            (item) =>
              item.getClientRects().length &&
              !item.disabled &&
              ["取消", "Cancel"].includes(item.innerText.trim()),
          );
          if (!cancel) return false;
          cancel.click();
          return true;
        }),
      { timeout: 90_000, interval: 300, timeoutMsg: `${CASE_MARKER}: 没有出现可取消的安装确认` },
    );
    await browser.pause(3000);
    const afterCancel = {
      remoteInstalled: await remoteInstalledState(fresh),
      remoteTabSessionId: (await readRemoteTabSnapshot()).remoteSessionId,
      dialogState: await browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('[data-testid="ssh-dialog"]');
        return dialog ? dialog.innerText.slice(0, 400) : "dialog-gone";
      }),
      hosts: await readHostProcesses(),
    };
    expect(afterCancel.remoteInstalled).toBe("none");
    expect(afterCancel.remoteTabSessionId).toBeNull();
    expect(afterCancel.hosts).toEqual(initialHosts);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "install-cancel.json"),
      JSON.stringify(afterCancel, null, 2),
    );
    if (afterCancel.dialogState !== "dialog-gone") {
      await browser.keys(["Escape"]);
      await browser.waitUntil(
        () => browser.execute(() => !document.querySelector('[data-testid="ssh-dialog"]')),
        { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 取消安装后向导没有关闭` },
      );
    }

    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(fresh);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    // 取消安装后远端仍无 server，再次连接还会停在安装确认（inline 在 connecting
    // 步）；缺这一步安装确认悬挂，conversation 永不打开（settings-scopes 0910
    // 实锤：auth 成功 → probe INSTALLED=0 → 无后续 channel 活动直至超时）。
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(fresh.workspacePaths[0], CASE_MARKER);
    const tab = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: fresh.workspacePaths[0],
    });
    expect(tab.remoteSessionId).toBeTruthy();
    expect(await remoteInstalledState(fresh)).toContain(freshArchive.entry.sha256);
    expect(await readHostProcesses()).toEqual(initialHosts);
    const project = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config: fresh,
      workspacePath: fresh.workspacePaths[0],
    });
    expect(project.remoteSessionId).toBeTruthy();
  });
});
