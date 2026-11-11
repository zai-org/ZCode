import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import {
  clearAppData,
  getE2EAppDataPaths,
  readSettings,
  seedSettings,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { clickRemoteHostConnect, waitForProjectRow } from "#e2e/helpers/project-sidebar";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readSSHRuntimeConfig,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// 3.16.2 工单的真实 SSH 验证（本机 Docker runner）：
// - 缺陷 A（ZCT-2113085028132474880 / ZCT-2113021923315200000）：3.15 迁移的密码 SSH 项目，远端未装
//   Source Server。项目入口交给向导的目标不含凭据，确认安装后报“SSH 认证失败”。
// - ZCT-2112984371086536704：第一次需要安装时取消，第二次点同一项目只看到过期的“连接失败”，
//   不重连、没有安装确认；向导错误面板的“安装并连接”实际走不带确认的重试。
// - 上一条的第一版修复在线路未识别时忽略全部失败记录：普通失败后每次点击都静默重拨，向导打不开
//   （违反项目导航规格 §2.2“再次点击进入向导……不自动再次拨号”）。LIH-03 覆盖该回归。
// - CR-01：新重连失败没有错误码时仍被当成旧记录。LIH-04 在真实认证失败响应上移除码，覆盖该遗漏。
// 迁移形状：App 退出后删除项目库，写入 3.15 的远程 workspace 条目与已存密码，清空 Source Directory
// 迁移版本，冷启动时由当前版本完成迁移（与 legacy-remote-credential-decrypt 用例同一方式）。
const MARKER = "E2E_SSH_LEGACY_INSTALL_HANDOFF";
const PROJECT_DIR = "legacy-install-project";
// LIH-03 的普通失败：远端 PAM 先记录每次认证尝试，再拒绝认证（不是等待点）。
const AUTH_ATTEMPTS_FILE = "/tmp/zcode-e2e-auth-attempts";
const AUTH_ATTEMPT_SCRIPT = "/usr/local/bin/zcode-e2e-auth-attempt";
const PAM_COUNT_LINE = `auth optional pam_exec.so quiet ${AUTH_ATTEMPT_SCRIPT}`;
const PAM_DENY_LINE = "auth requisite pam_deny.so";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-remote-legacy-install-handoff",
);

interface WizardState {
  open: boolean;
  installPanel: boolean;
  errorText: string | null;
  buttons: string[];
}

type LegacyConnectHandler = (...args: unknown[]) => Promise<unknown>;
declare global {
  var __legacyTabConnectProbe:
    | { calls: number; removedCodes: string[]; restore(): void }
    | undefined;
}

/** 保留真实 SSH 失败，只在 Main 返回边界模拟旧 Host 没有 reasonCode 的响应。 */
async function installLegacyConnectProbe(stripCode: boolean): Promise<void> {
  await browser.electron.execute(
    (electron, channel, stripCode) => {
      const handlers = (
        electron.ipcMain as unknown as { _invokeHandlers: Map<string, LegacyConnectHandler> }
      )._invokeHandlers;
      const original = handlers.get(channel);
      if (!original) throw new Error("ConnectRemote handler unavailable");
      const probe = {
        calls: 0,
        removedCodes: [] as string[],
        restore() {
          handlers.set(channel, original);
          delete globalThis.__legacyTabConnectProbe;
        },
      };
      handlers.set(channel, async (...args) => {
        probe.calls++;
        const result = await original(...args);
        if (!stripCode || !result || typeof result !== "object" || !("reasonCode" in result))
          return result;
        if (typeof result.reasonCode === "string") probe.removedCodes.push(result.reasonCode);
        const uncoded: { reasonCode?: unknown } = { ...result };
        delete uncoded.reasonCode;
        return uncoded;
      });
      globalThis.__legacyTabConnectProbe = probe;
    },
    PlatformChannels.ConnectRemote,
    stripCode,
  );
}

const readLegacyConnectProbe = () =>
  browser.electron.execute(() => ({
    calls: globalThis.__legacyTabConnectProbe?.calls ?? 0,
    removedCodes: globalThis.__legacyTabConnectProbe?.removedCodes ?? [],
  }));

async function readWizardState(): Promise<WizardState> {
  return browser.execute(() => {
    const dialog = document.querySelector<HTMLElement>('[data-testid="ssh-dialog"]');
    const visibleButtons = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .filter((button) => button.getClientRects().length > 0)
      .map((button) => button.textContent?.trim() ?? "");
    const error = dialog?.querySelector<HTMLElement>('[data-testid="ssh-error"]');
    return {
      open: Boolean(dialog && dialog.getClientRects().length > 0),
      installPanel: Boolean(dialog?.querySelector('[data-testid="remote-install-version"]')),
      errorText: error && error.getClientRects().length > 0 ? error.innerText.trim() : null,
      buttons: visibleButtons,
    };
  });
}

async function waitForWizard(
  predicate: (state: WizardState) => boolean,
  description: string,
  timeout = 90_000,
): Promise<WizardState> {
  let last: WizardState = { open: false, installPanel: false, errorText: null, buttons: [] };
  await browser.waitUntil(
    async () => {
      last = await readWizardState();
      return predicate(last);
    },
    {
      timeout,
      interval: 300,
      timeoutMsg: `${MARKER}: ${description} 未出现；最后状态 ${JSON.stringify(last)}`,
    },
  );
  return last;
}

/** 只在指定面板内按文案点击，避免误点页脚或其他面板的同名按钮。 */
async function clickWizardButton(scope: "install" | "error", text: string): Promise<void> {
  const clicked = await browser.execute(
    (panel, label) => {
      const dialog = document.querySelector('[data-testid="ssh-dialog"]');
      const container =
        panel === "install"
          ? dialog?.querySelector('[data-testid="remote-install-version"]')?.closest("dl")
              ?.parentElement
          : dialog?.querySelector('[data-testid="ssh-error"]');
      const button = Array.from(
        container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      ).find(
        (candidate) =>
          candidate.getClientRects().length > 0 &&
          !candidate.disabled &&
          candidate.textContent?.trim() === label,
      );
      button?.click();
      return Boolean(button);
    },
    scope,
    text,
  );
  if (!clicked) throw new Error(`${MARKER}: ${scope} 面板没有可点击的「${text}」`);
}

/** 打开的项目 tab 记录在 lastActiveWorkspace（WSL 工单日志即此字段），其余在 lastWorkspaceSession。 */
async function readSessionEntry(workspacePath: string) {
  const settings = await readSettings();
  const isTarget = (entry: unknown): entry is RemoteWorkspaceSessionEntry =>
    Boolean(entry) &&
    (entry as RemoteWorkspaceSessionEntry).kind === "remote" &&
    (entry as RemoteWorkspaceSessionEntry).workspacePath === workspacePath;
  return isTarget(settings.lastActiveWorkspace)
    ? settings.lastActiveWorkspace
    : settings.lastWorkspaceSession?.find(isTarget);
}

describe(`${MARKER}: 迁移的密码 SSH 项目首次安装`, () => {
  const facts: Record<string, unknown> = {};
  const { credentialsFile, homeDir } = getE2EAppDataPaths();
  const tasksIndexFile = join(homeDir, ".zcode/v2/tasks-index.sqlite");
  let config: SSHConnectionConfig;
  let container: string;
  let workspacePath: string;
  let legacyIdentity: string;
  let legacyPasswordKey: string;
  let ciphertext: string | undefined;

  /** 去掉 LIH-03 注入的认证拒绝；未注入时是空操作。 */
  async function restoreRemoteAuth(): Promise<void> {
    if (!container) return;
    await execInRemoteContainer(
      container,
      [
        "sh",
        "-c",
        `sed -i '\\|${PAM_COUNT_LINE}|d; \\|${PAM_DENY_LINE}|d' /etc/pam.d/sshd; rm -f ${AUTH_ATTEMPTS_FILE}`,
      ],
      { user: "0" },
    );
  }

  /** 远端 PAM 记录到的认证尝试次数；每次拨号至少一次。 */
  async function remoteAuthAttempts(): Promise<number> {
    const { stdout } = await execInRemoteContainer(
      container,
      ["sh", "-c", `cat ${AUTH_ATTEMPTS_FILE} 2>/dev/null | wc -l`],
      { user: "0" },
    );
    return Number(stdout.trim());
  }

  after(async () => {
    await browser.electron.execute(() => globalThis.__legacyTabConnectProbe?.restore());
    await restoreRemoteAuth().catch(() => undefined);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "ssh-remote-legacy-install-handoff.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  async function remoteInstallState(): Promise<string> {
    return (
      await execInRemoteContainer(container, [
        "sh",
        "-c",
        `test -e /home/${config.username}/.zcode/server/bin/zcode && echo installed || echo absent`,
      ])
    ).stdout.trim();
  }

  /** 让当前版本用本机密钥保存一次密码，取得能解密的密文；密码只在连接成功后保存，所以先完整连接一次。 */
  async function captureStoredPassword(): Promise<string> {
    await openSSHRemoteDialog(MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(MARKER);
    await waitForSSHDirectoryStep(MARKER, undefined, { allowBoundaryAcknowledgement: true });
    // 在远端登记该项目，模拟 3.15 远端已有的项目数据；之后只删除 Source Server 安装目录。
    await selectSSHRemoteDirectory(workspacePath, MARKER);
    await waitForRemoteTab({ caseMarker: MARKER, expectedPath: workspacePath });
    const profile = (await readSettings()).connectionProfiles?.find(
      (item) =>
        item.target.kind === "ssh" &&
        item.target.host === config.host &&
        item.target.port === config.port,
    );
    const key = profile?.target.kind === "ssh" ? profile.target.passwordCredentialKey : undefined;
    const credentials = JSON.parse(await readFile(credentialsFile, "utf-8")) as Record<
      string,
      string
    >;
    const value = key ? credentials[key] : undefined;
    if (!value) throw new Error(`${MARKER}: 没有取得已保存的密码密文`);
    return value;
  }

  /**
   * 模拟 3.15 设置首次进入 3.16：远端回到未安装，删除项目库，写入旧远程条目与旧密码，清空迁移版本。
   * withRestoredTab 同时写入 lastActiveWorkspace，冷启动后恢复旧项目 tab（WSL 工单的形状）。
   */
  async function seedLegacyUpgrade(label: string, withRestoredTab: boolean): Promise<string> {
    const legacyEntry = {
      kind: "remote" as const,
      workspacePath,
      workspaceIdentity: legacyIdentity,
      target: {
        kind: "ssh" as const,
        host: config.host,
        port: config.port,
        username: config.username,
        passwordCredentialKey: legacyPasswordKey,
      },
      lastOpenedAt: Date.now(),
      lastConnectionStatus: "connected" as const,
    };
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        // 停掉上一次留下的 Source Server，只删除其安装目录，保留远端项目数据。
        await execInRemoteContainer(
          container,
          [
            "sh",
            "-c",
            `pkill -9 -u ${config.username} -f '.zcode/server' || true; rm -rf /home/${config.username}/.zcode/server`,
          ],
          { user: "0" },
        );
        for (const suffix of ["", "-wal", "-shm"]) {
          await rm(`${tasksIndexFile}${suffix}`, { force: true });
        }
        const current = await readSettings();
        await seedSettings({
          sourceServerDirectoryMigrationVersion: undefined,
          sourceServers: [],
          connectionProfiles: [],
          sourceServerWorkspaceHistory: [],
          remoteStartupAutoReconnectEnabled: false,
          lastWorkspaceSession: [
            ...(current.lastWorkspaceSession ?? []).filter((entry) => entry.kind !== "remote"),
            legacyEntry,
          ],
          lastActiveWorkspace: withRestoredTab ? legacyEntry : null,
        });
        const credentials = JSON.parse(await readFile(credentialsFile, "utf-8")) as Record<
          string,
          string
        >;
        credentials[legacyPasswordKey] = ciphertext!;
        await writeFile(credentialsFile, JSON.stringify(credentials), "utf-8");
      },
    });
    await waitForRendererAfterColdRestart(MARKER);
    expect(await remoteInstallState()).toBe("absent");
    await waitForProjectRow(workspacePath, {
      timeout: 60_000,
      timeoutMsg: `${MARKER}: 迁移后侧栏没有旧远程项目`,
    });
    const migrated = (await readSettings()).connectionProfiles?.filter(
      (profile) => profile.target.kind === "ssh" && profile.target.port === config.port,
    );
    facts[`${label}.migratedProfiles`] = migrated?.map((profile) => ({
      profileId: profile.profileId,
      sourceServerId: profile.sourceServerId ?? null,
      hasPassword: profile.target.kind === "ssh" && Boolean(profile.target.passwordCredentialKey),
    }));
    // 前提：迁移出的线路带已存密码，但还没有 sourceServerId，入口按 sourceServerId 找不到它。
    expect(migrated).toHaveLength(1);
    expect(migrated![0]!.sourceServerId).toBeUndefined();
    return migrated![0]!.profileId;
  }

  /**
   * 第一次需要安装时取消并关闭向导，第二次连接后用错误面板的“安装并连接”完成安装。
   * expectFailedRecord：恢复的 tab 走原地重连，等待点按既有契约写成只有本地化文案的失败记录，
   * 这正是工单里第二次点击被判成“连接失败”的输入；侧栏入口不写这条记录。
   */
  async function cancelThenInstall(
    label: string,
    migratedProfileId: string,
    expectFailedRecord: boolean,
  ): Promise<void> {
    await clickRemoteHostConnect(workspacePath);
    facts[`${label}.firstAttempt`] = await waitForWizard(
      (state) => state.installPanel,
      "第一次连接的安装确认",
    );
    await clickWizardButton("install", "取消");
    // 取消安装后向导停在“已取消”，用户随后关闭向导。
    await waitForWizard((state) => !state.installPanel, "取消后的安装确认消失", 30_000);
    await browser.keys("Escape");
    await waitForWizard((state) => !state.open, "关闭向导", 30_000);
    const entryAfterCancel = await readSessionEntry(workspacePath);
    facts[`${label}.entryAfterCancel`] = entryAfterCancel;
    expect(entryAfterCancel?.lastConnectionStatus).toBe(
      expectFailedRecord ? "failed" : "connected",
    );

    // 第二次连接同一项目：仍应重新询问 Host 并显示安装确认，不能只显示过期的“连接失败”。
    await clickRemoteHostConnect(workspacePath);
    const second = await waitForWizard(
      (state) => state.installPanel || Boolean(state.errorText),
      "第二次连接的向导",
    );
    facts[`${label}.secondAttempt`] = second;
    expect(second.installPanel).toBe(true);

    // 点错误面板的“安装并连接”：执行安装确认，并带上迁移来的已存密码。
    expect(second.buttons).toContain("安装并连接");
    await clickWizardButton("error", "安装并连接");
    let finalState: WizardState | undefined;
    await browser.waitUntil(
      async () => {
        finalState = await readWizardState();
        if (
          /SSH 认证失败|需要先确认安装/u.test(finalState.errorText ?? "") &&
          !finalState.installPanel
        )
          return true;
        const profile = (await readSettings()).connectionProfiles?.find(
          (item) => item.profileId === migratedProfileId,
        );
        return Boolean(profile?.sourceServerId);
      },
      {
        timeout: 8 * 60_000,
        interval: 1_000,
        timeoutMsg: `${MARKER}: ${label} 安装后设备没有上线；最后状态 ${JSON.stringify(finalState)}`,
      },
    );
    facts[`${label}.finalState`] = finalState;
    // 修复前：确认安装只用 none 认证，报“SSH 认证失败”；或按钮走无确认重试，再次“需要先确认安装”。
    expect(finalState?.errorText ?? "").not.toMatch(/SSH 认证失败|需要先确认安装/u);
    expect(await remoteInstallState()).toBe("installed");
    // 用迁移来的线路（带已存密码）连上并识别出 Source，没有另建无凭据的线路。
    expect(
      (await readSettings()).connectionProfiles?.filter(
        (item) => item.target.kind === "ssh" && item.target.port === config.port,
      ),
    ).toHaveLength(1);
    // 原项目能否打开取决于远端是否有该旧 workspace 的历史会话；新容器没有，只记录结果，不作断言。
    await browser.pause(3_000);
    facts[`${label}.projectOpenOutcome`] = await readWizardState();
    await browser.keys("Escape");
  }

  it("LIH-01 侧栏项目（无 tab）：取消安装后再次连接仍显示安装确认；“安装并连接”带迁移的已存密码完成安装并上线", async function () {
    this.timeout(15 * 60_000);
    config = readSSHRuntimeConfig(MARKER);
    container = readRemoteDockerContainer(MARKER);
    workspacePath = `/home/${config.username}/${PROJECT_DIR}`;
    legacyIdentity = `remote:ssh:${config.host}:${config.port}:${config.username}:${workspacePath}`;
    legacyPasswordKey = `remote-workspace:${legacyIdentity}:password`;
    await execInRemoteContainer(container, ["mkdir", "-p", workspacePath], {
      user: config.username,
    });
    await prepareV4ConversationE2E({ skipProvider: true });
    ciphertext = await captureStoredPassword();

    const profileId = await seedLegacyUpgrade("LIH-01", false);
    await cancelThenInstall("LIH-01", profileId, false);
  });

  it("LIH-02 恢复的旧项目 tab：取消安装留下的失败记录不挡住第二次连接，仍显示安装确认并带已存密码完成安装", async function () {
    this.timeout(15 * 60_000);
    if (!ciphertext) this.skip();
    const profileId = await seedLegacyUpgrade("LIH-02", true);
    await cancelThenInstall("LIH-02", profileId, true);
  });

  for (const { label, stripCode, expectedCode } of [
    { label: "LIH-03", stripCode: false, expectedCode: "remote-authentication-failed" },
    { label: "LIH-04", stripCode: true, expectedCode: "remote-connection-unknown" },
  ]) {
    it(`${label} 恢复的旧项目 tab 普通重连失败（${stripCode ? "无码" : "带码"}）：第二次点击打开向导查看失败，不再拨号`, async function () {
      this.timeout(10 * 60_000);
      if (!ciphertext) this.skip();
      await seedLegacyUpgrade(label, true);
      await execInRemoteContainer(
        container,
        ["sh", "-c", `cat > ${AUTH_ATTEMPT_SCRIPT} && chmod 755 ${AUTH_ATTEMPT_SCRIPT}`],
        { user: "0", input: `#!/bin/sh\necho attempt >> ${AUTH_ATTEMPTS_FILE}\n` },
      );
      // 两次插到最前：先记录尝试，再拒绝；密码与 keyboard-interactive 认证都经过这个栈。
      await execInRemoteContainer(
        container,
        [
          "sh",
          "-c",
          `rm -f ${AUTH_ATTEMPTS_FILE}; sed -i '1i ${PAM_DENY_LINE}' /etc/pam.d/sshd; sed -i '1i ${PAM_COUNT_LINE}' /etc/pam.d/sshd`,
        ],
        { user: "0" },
      );
      try {
        await installLegacyConnectProbe(stripCode);
        // 第一次点击：重连遇到普通失败，不弹向导；失败记录带上错误码。
        await clickRemoteHostConnect(workspacePath);
        let entry: RemoteWorkspaceSessionEntry | undefined;
        await browser.waitUntil(
          async () => {
            entry = await readSessionEntry(workspacePath);
            return entry?.lastConnectionStatus === "failed";
          },
          {
            timeout: 90_000,
            interval: 500,
            timeoutMsg: `${MARKER}: 第一次重连没有写入失败记录；最后记录 ${JSON.stringify(entry)}`,
          },
        );
        const attemptsAfterFirst = await remoteAuthAttempts();
        const firstProbe = await readLegacyConnectProbe();
        facts[`${label}.firstAttempt`] = {
          entry,
          probe: firstProbe,
          attempts: attemptsAfterFirst,
          wizard: await readWizardState(),
        };
        expect(entry?.lastConnectionErrorCode).toBe(expectedCode);
        expect(firstProbe.calls).toBe(1);
        expect(firstProbe.removedCodes).toEqual(stripCode ? ["remote-authentication-failed"] : []);
        expect(attemptsAfterFirst).toBeGreaterThan(0);
        expect((await readWizardState()).open).toBe(false);

        // 第二次点击：进入向导连接步骤查看失败，不自动再次拨号（修复前每次点击都静默重拨）。
        await clickRemoteHostConnect(workspacePath);
        const second = await waitForWizard(
          (state) => state.open && Boolean(state.errorText),
          "第二次点击的失败向导",
          30_000,
        );
        const logPanel = await $('[data-testid="remote-connection-log"]');
        await expect(logPanel).toBeDisplayed();
        const logs = await logPanel.getText();
        expect(logs).toMatch(/\[(INFO|WARN|ERROR|SUCCESS)\]/u);
        // 留出一次拨号所需的时间，确认这次点击没有在后台再发起连接。
        await browser.pause(5_000);
        const attemptsAfterSecond = await remoteAuthAttempts();
        const secondProbe = await readLegacyConnectProbe();
        facts[`${label}.secondAttempt`] = {
          wizard: second,
          logs,
          attempts: attemptsAfterSecond,
          probe: secondProbe,
        };
        expect(second.installPanel).toBe(false);
        expect(second.errorText ?? "").toMatch(/SSH 认证失败/u);
        expect(attemptsAfterSecond).toBe(attemptsAfterFirst);
        expect(secondProbe.calls).toBe(firstProbe.calls);
        await browser.keys("Escape");
      } finally {
        await browser.electron.execute(() => globalThis.__legacyTabConnectProbe?.restore());
        await restoreRemoteAuth();
      }
    });
  }
});
