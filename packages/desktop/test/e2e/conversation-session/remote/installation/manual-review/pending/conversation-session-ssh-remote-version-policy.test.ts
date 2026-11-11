import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, readSettings } from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  disconnectRemoteSource,
  expandRemoteDeviceRow,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import {
  connectSSHWorkspace,
  readSSHRuntimeConfig,
  runSSHCommand,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import {
  prepareVersionPolicyArchive,
  uploadSSHFixtureFile,
} from "#e2e/helpers/ssh-version-policy-fixture";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  holdWizardSourceSnapshot,
  readSnapshotFaultUpdateCalls,
  rejectWizardSourceSnapshot,
  restoreSnapshotFault,
} from "#e2e/helpers/source-server-snapshot-fault";

const MARKER = "E2E_SSH_VERSION_POLICY";
const scenario = process.env.R3_VERSION_POLICY_CASE ?? "manual-required";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-version-policy",
);

/** 只点击向导错误面板内的按钮，避免误点设置页或横幅中的同名动作。 */
async function clickWizardErrorAction(label: RegExp, timeoutMsg: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (source, flags) => {
          const pattern = new RegExp(source, flags);
          const button = Array.from(
            document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-error"] button'),
          ).find((item) => pattern.test(item.innerText.trim()) && !item.disabled);
          button?.click();
          return Boolean(button);
        },
        label.source,
        label.flags,
      ),
    { timeout: 120_000, timeoutMsg },
  );
}

describe(`${MARKER}: 版本兼容策略`, () => {
  let runtimeConfig: ReturnType<typeof readSSHRuntimeConfig> | undefined;
  const facts: Record<string, unknown> = {
    scenario,
    fixture: "synthetic-version-metadata-current-runtime",
  };
  after(async () => {
    await restoreSnapshotFault();
    if (runtimeConfig) {
      const current = await runSSHCommand(runtimeConfig, 'cat "$HOME/.zcode/server/current.json"');
      if (current.code === 0) facts.finalInstalledVersion = JSON.parse(current.stdout).version;
    }
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "version-policy.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it(`SSH-GUIDE-VERSION ${scenario}: 当前版本策略与操作入口一致`, async function () {
    this.timeout(15 * 60_000);
    if (
      ![
        "manual-required",
        "snapshot-failure-required",
        "automatic-required",
        "optional",
        "controller-required",
        "controller-downgrade",
        "downgraded-confirm",
      ].includes(scenario)
    )
      throw new Error("未知兼容场景");
    const config = readSSHRuntimeConfig(MARKER);
    runtimeConfig = config;
    await prepareV4ConversationE2E({ skipProvider: true });
    const a = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[0],
    });
    const b = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[1],
    });
    const sourceId = parseRemoteWorkspaceIdentity(a.workspaceIdentity!)?.sourceServerId;
    if (!sourceId) throw new Error("缺少设备身份");
    const before = JSON.parse(
      (await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout,
    );
    facts.originalInstalledVersion = before.version;
    await disconnectRemoteSource(sourceId, MARKER);
    // 远端比 Desktop 新：只提示升级 Desktop，或由用户显式切回 Desktop 版本。
    const controllerNewer =
      scenario === "controller-required" || scenario === "controller-downgrade";
    const requiredOld =
      (scenario.endsWith("required") && !controllerNewer) || scenario === "downgraded-confirm";
    // 固定的“新版本”随仓库升级变成同版本，根本不会出现 optional 提示；从实际首装版本构造关系。
    const installedVersion = String(before.version).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
    if (!installedVersion) throw new Error(`无法构造版本边界: ${String(before.version)}`);
    const nextVersion = `${installedVersion[1]}.${Number(installedVersion[2]) + 1}.0`;
    const version = requiredOld ? "3.14.0" : nextVersion;
    const minimum = controllerNewer ? nextVersion : requiredOld ? "3.14.0" : String(before.version);
    const archive = await prepareVersionPolicyArchive({
      installedSha: before.archiveSha256,
      version,
      minimum,
    });
    const fixtureRoot = `${config.workspacePaths[0]}/.zcode-e2e/version-policy`;
    const remoteArchive = `${fixtureRoot}/version.tar.gz`;
    expect((await runSSHCommand(config, `mkdir -p '${fixtureRoot}'`)).code).toBe(0);
    await uploadSSHFixtureFile(config, archive, remoteArchive);
    // 构造旧远端属于降级，CLI 要求显式授权；授权后会写降级标记。
    const installed = await runSSHCommand(
      config,
      `"$HOME/.zcode/server/bin/zcode" update --from-archive '${remoteArchive}' --force${requiredOld ? " --allow-downgrade" : ""} --json`,
      { timeoutMs: 120_000 },
    );
    facts.syntheticInstallResult = {
      code: installed.code,
      stdout: installed.stdout,
      stderr: installed.stderr,
    };
    expect(installed.code).toBe(0);
    // Server 生命周期日志可能先于结果写到 stdout；沿用真实 SSH CLI 验证脚本的末行 JSON 合同。
    expect(JSON.parse(installed.stdout.trim().split("\n").at(-1)!).applied).toBe(true);
    const synthetic = JSON.parse(
      (await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout,
    );
    expect(synthetic.version).toBe(version);
    facts.syntheticVersion = { version, minimum, archiveSha256: synthetic.archiveSha256 };
    const readDowngradeMarker = async () => {
      const marker = await runSSHCommand(config, 'cat "$HOME/.zcode/server/downgrade.json"');
      return marker.code === 0
        ? (JSON.parse(marker.stdout) as { releaseId?: string; fromVersion?: string })
        : null;
    };
    if (scenario === "downgraded-confirm") {
      // 被旧版 Desktop 显式切回的远端：标记属于当前 release，记录被替换的版本。
      expect(await readDowngradeMarker()).toEqual({
        releaseId: synthetic.releaseId,
        fromVersion: before.version,
      });
    } else if (requiredOld) {
      // 其他旧版本场景代表从未升级过的远端，不能带降级标记，否则向导不会自动更新。
      expect((await runSSHCommand(config, 'rm -f "$HOME/.zcode/server/downgrade.json"')).code).toBe(
        0,
      );
    }

    if (scenario === "automatic-required") {
      await reloadElectronSessionPreservingBrowserProfile(browser);
      await waitForRendererAfterColdRestart(MARKER);
      await browser.waitUntil(
        async () =>
          /需要处理|Needs attention/iu.test(await browser.execute(() => document.body.innerText)),
        { timeout: 120_000 },
      );
      expect(await $('[data-testid="ssh-dialog"]').isExisting()).toBe(false);
      expect(
        JSON.parse((await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout)
          .version,
      ).toBe(version);
      await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const button = Array.from(
              document.querySelectorAll<HTMLButtonElement>("[data-settings-content-frame] button"),
            ).find(
              (item) =>
                /^(立即更新|更新|更新远端|Update now|Update|Update server)$/iu.test(
                  item.innerText.trim(),
                ) && !item.disabled,
            );
            button?.click();
            return Boolean(button);
          }),
        { timeout: 15_000, timeoutMsg: `${MARKER}: 设置页没有必须更新入口` },
      );
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    } else {
      if (scenario === "snapshot-failure-required") await holdWizardSourceSnapshot();
      await requestRemoteProjectConnection(b.workspaceIdentity!, MARKER);
    }

    if (scenario === "snapshot-failure-required") {
      const failure = `${MARKER}: snapshot temporarily unavailable`;
      const rejectedReads = await rejectWizardSourceSnapshot(failure);
      expect(await readSnapshotFaultUpdateCalls()).toBe(0);
      const actions = await browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-error"] button'))
          .filter((button) => !button.disabled)
          .map((button) => button.innerText.trim()),
      );
      expect(actions.some((label) => /^(更新远端|Update server)$/iu.test(label))).toBe(false);
      await mkdir(artifactDir, { recursive: true });
      await browser.saveScreenshot(resolve(artifactDir, "snapshot-failure.png"));
      const retried = await browser.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-error"] button'),
        ).find((item) => /^(重试|Retry)$/iu.test(item.innerText.trim()) && !item.disabled);
        button?.click();
        return Boolean(button);
      });
      expect(retried).toBe(true);
      facts.snapshotFailure = { message: failure, rejectedReads, actions, retried };
    }

    if (scenario === "controller-downgrade") {
      const label = new RegExp(
        `^(将远端切换到|Switch remote to) ${String(before.version).replaceAll(".", "\\.")}$`,
        "iu",
      );
      await clickWizardErrorAction(label, `${MARKER}: 向导没有提供切换远端的次级动作`);
      // 切换远端必须二次确认；确认前远端保持原 release。
      await $(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`).waitForDisplayed({
        timeout: 30_000,
      });
      expect(
        JSON.parse((await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout)
          .archiveSha256,
      ).toBe(synthetic.archiveSha256);
      await mkdir(artifactDir, { recursive: true });
      await browser.saveScreenshot(resolve(artifactDir, "controller-downgrade-confirm.png"));
      await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
    }
    if (scenario === "downgraded-confirm") {
      await browser.waitUntil(
        async () =>
          new RegExp(`(从|from) ${String(before.version).replaceAll(".", "\\.")}`, "iu").test(
            await $('[data-testid="ssh-error"]')
              .getText()
              .catch(() => ""),
          ),
        { timeout: 120_000, timeoutMsg: `${MARKER}: 向导没有说明远端已被切回` },
      );
      // 等待确认期间不得自动升级被切回的远端。
      expect(
        JSON.parse((await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout)
          .version,
      ).toBe(version);
      await mkdir(artifactDir, { recursive: true });
      await browser.saveScreenshot(resolve(artifactDir, "downgraded-confirm-wait.png"));
      facts.downgradedWaitedForConfirmation = true;
      await clickWizardErrorAction(
        /^(更新远端|Update remote device)$/iu,
        `${MARKER}: 向导没有提供确认更新远端的入口`,
      );
    }

    if (scenario === "controller-required") {
      // 当前横幅引导用户查看详情；未展开时只扫描主页会遗漏真实升级原因。
      const banner = $('[data-testid="remote-conversation-banner"]');
      await browser.waitUntil(
        async () => /需要处理|Needs attention/iu.test(await banner.getText()),
        { timeout: 120_000, timeoutMsg: `${MARKER}: 桌面版本门禁没有显示处理入口` },
      );
      // 手动重连会保留版本阻塞向导；录像中的遮罩拦截了后台横幅点击，先按用户路径关闭。
      await browser.keys("Escape");
      await $('[data-testid="ssh-dialog"]').waitForExist({ reverse: true });
      await banner
        .$('.//button[normalize-space(.)="详细信息" or normalize-space(.)="Details"]')
        .click();
      const details = $('[role="dialog"]');
      await details.waitForDisplayed();
      const technical = details.$("details > summary");
      if (await technical.isDisplayed()) await technical.click();
      await browser.waitUntil(
        async () => {
          const text = await details.getText();
          facts.controllerGuidance = text;
          return /更新桌面端|升级.*(?:本机|桌面)|(?:本机|桌面).*升级|(?:update|upgrade).*desktop|desktop.*(?:update|upgrade)/iu.test(
            text,
          );
        },
        { timeout: 30_000, timeoutMsg: `${MARKER}: 详细信息没有说明需要升级桌面端` },
      );
      expect(
        JSON.parse((await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout)
          .archiveSha256,
      ).toBe(synthetic.archiveSha256);
      facts.remoteNotDowngraded = true;
    } else {
      const restoredB = await waitForRemoteTab({
        caseMarker: MARKER,
        expectedIdentity: b.workspaceIdentity!,
        expectedPath: b.workspacePath!,
        requireActive: false,
        timeoutMs: 180_000,
      });
      if (scenario === "automatic-required") {
        // F5：冷启动只恢复活动 B，A 仍保留项目入口，更新后通过真实入口按需打开。
        await openWorkspaceDraftFromSidebar(a.workspacePath!);
      }
      const restoredA = await waitForRemoteTab({
        caseMarker: MARKER,
        expectedIdentity: a.workspaceIdentity!,
        expectedPath: a.workspacePath!,
        requireActive: false,
      });
      // 原项目手动升级不补点更新；后台冷启动分支另按 F5 验证 B 自动恢复、A 按需打开。
      expect(restoredB.remoteSessionId).not.toBe(b.remoteSessionId);
      expect(restoredA.remoteSessionId).not.toBe(a.remoteSessionId);
      facts.restoredProjects = [restoredA, restoredB];
      if (scenario === "snapshot-failure-required") {
        facts.snapshotRetryUpdateCalls = await readSnapshotFaultUpdateCalls();
        expect(facts.snapshotRetryUpdateCalls).toBe(1);
      }
      const current = JSON.parse(
        (await runSSHCommand(config, 'cat "$HOME/.zcode/server/current.json"')).stdout,
      );
      // 当前构建已是 3.15.1；升级目标应回到本轮真实首装版本，不能硬编码历史补丁号。
      expect(current.version).toBe(scenario === "optional" ? version : before.version);
      const marker = await readDowngradeMarker();
      if (scenario === "controller-downgrade") {
        // 切回本机版本后标记指向当前 release，并记录被替换的新版本。
        expect(marker).toEqual({ releaseId: current.releaseId, fromVersion: nextVersion });
      } else if (scenario === "downgraded-confirm") {
        // 升级后标记属于旧 release，自然失效。
        expect(marker?.releaseId).not.toBe(current.releaseId);
      }
      facts.downgradeMarker = marker;
      if (scenario === "optional") {
        expect(await $('[data-testid="ssh-dialog"]').isExisting()).toBe(false);
        // 未发 toast 时宿主可以不存在；只读实际文本，仍拒绝自动更新提示。
        const toastText = await browser.execute(
          () => document.querySelector("#zcode-toast-host")?.textContent ?? "",
        );
        expect(toastText).not.toMatch(/更新|update/iu);
        await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
        await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
        // RDUX-13：折叠行用中性辅助信息提示可选更新，状态仍为已连接；设置导航没有状态点。
        const rowMeta = $(`[data-source-server-card="${sourceId}"] [data-device-row-meta]`);
        await browser.waitUntil(
          async () => /可更新到|Update to v/iu.test(await rowMeta.getText()),
          {
            timeout: 30_000,
            timeoutMsg: `${MARKER}: 折叠行没有可选更新提示`,
          },
        );
        facts.optionalRowHint = await rowMeta.getText();
        expect(await $("[data-remote-navigation-status]").isExisting()).toBe(false);
        // 可选更新横幅在设备行展开区。
        await expandRemoteDeviceRow(sourceId, MARKER);
        // 设置页挂载后异步读取兼容状态；卡片出现不代表更新投影已到达。
        await browser.waitUntil(
          async () => {
            const text = await $(`[data-source-server-card="${sourceId}"]`).getText();
            facts.optionalPanelText = text;
            return /更新|update/iu.test(text);
          },
          { timeout: 30_000, timeoutMsg: `${MARKER}: 兼容的新版本没有出现可延后的更新提示` },
        );
        const deferred = await browser.execute((id) => {
          const card = document.querySelector(`[data-source-server-card="${id}"]`);
          const button = Array.from(card?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
            (item) => /^(稍后|Later)$/iu.test(item.innerText.trim()) && !item.disabled,
          );
          button?.click();
          return Boolean(button);
        }, sourceId);
        expect(deferred).toBe(true);
        const hasLater = () =>
          browser.execute(
            (id) =>
              Array.from(
                document
                  .querySelector(`[data-source-server-card="${id}"]`)
                  ?.querySelectorAll<HTMLButtonElement>("button") ?? [],
              ).some((item) => /^(稍后|Later)$/iu.test(item.innerText.trim())),
            sourceId,
          );
        await browser.waitUntil(async () => !(await hasLater()), { timeout: 15_000 });
        await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
        await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
        await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
        // 面板重挂后设备行重新收起；展开后确认稍后状态仍保留，不能因收起而误判通过。
        // 稍后同时隐藏行内提示。
        expect(await rowMeta.getText()).not.toMatch(/可更新到|Update to v/iu);
        await expandRemoteDeviceRow(sourceId, MARKER);
        expect(await hasLater()).toBe(false);
        facts.optionalDeferredAcrossPanelRemount = true;
      }
      facts.projectsRestored = true;
    }
    expect(
      (await readSettings()).sourceServers?.some((server) => server.sourceServerId === sourceId),
    ).toBe(true);
    await browser.saveScreenshot(resolve(artifactDir, `${scenario}.png`));
  });
});
