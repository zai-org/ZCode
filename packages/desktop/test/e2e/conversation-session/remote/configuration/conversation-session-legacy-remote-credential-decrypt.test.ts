import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  readSettings,
  seedSettings,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { waitForProjectRow } from "#e2e/helpers/project-sidebar";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_LEGACY_REMOTE_CREDENTIAL_DECRYPT";
const LEGACY_HOST = "127.0.0.1";
const LEGACY_PORT = 9;
const LEGACY_USER = "e2e-legacy";
const LEGACY_WORKSPACE_PATH = "/e2e/legacy-decrypt";
const LEGACY_IDENTITY = `remote:ssh:${LEGACY_HOST}:${LEGACY_PORT}:${LEGACY_USER}:${LEGACY_WORKSPACE_PATH}`;
const LEGACY_PASSWORD_KEY = `remote-workspace:${LEGACY_IDENTITY}:password`;
// IV/AuthTag 长度合法、内容为零：本机任何密钥都无法通过 GCM 校验，
// decrypt 稳定抛出“密钥不匹配或密文已损坏”，等价于换机或换用户后的旧密文。
const UNDECRYPTABLE_VALUE = [
  "enc:v1:",
  Buffer.alloc(12).toString("base64url"),
  ".",
  Buffer.alloc(16).toString("base64url"),
  ".",
  Buffer.from(CASE_MARKER).toString("base64url"),
].join("");

describe(`${CASE_MARKER}: 旧远程凭据无法解密时升级启动`, () => {
  const { credentialsFile, homeDir } = getE2EAppDataPaths();
  const tasksIndexFile = join(homeDir, ".zcode/v2/tasks-index.sqlite");

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("LRCD-01 旧远程密码不可解密：冷启动后本地项目可见，Source Directory 完成迁移且不改写旧凭据", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E({ skipProvider: true });

    // 原因：legacy 迁移曾因读到不可解密的旧密码而整体失败，
    // Source Directory 不可用，侧栏整棵树（含本地项目）为空。退出后才写文件，避免运行中的 Host 覆盖夹具。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        // 3.16 启动时 lastWorkspaceSession 由项目库单向投影重写；旧远程条目只在首次项目库迁移时
        // 进入 remote_project_entries。删除项目库，模拟 3.15 设置首次进入 3.16 的升级启动。
        for (const suffix of ["", "-wal", "-shm"]) {
          await rm(`${tasksIndexFile}${suffix}`, { force: true });
        }
        const current = await readSettings();
        await seedSettings({
          // undefined 会被 JSON 丢弃，模拟 3.15 尚未执行 Source Directory 迁移的设置文件。
          sourceServerDirectoryMigrationVersion: undefined,
          connectionProfiles: [],
          sourceServerWorkspaceHistory: [],
          remoteStartupAutoReconnectEnabled: false,
          lastWorkspaceSession: [
            ...(current.lastWorkspaceSession ?? []),
            {
              kind: "remote",
              workspacePath: LEGACY_WORKSPACE_PATH,
              workspaceIdentity: LEGACY_IDENTITY,
              target: {
                kind: "ssh",
                host: LEGACY_HOST,
                port: LEGACY_PORT,
                username: LEGACY_USER,
                passwordCredentialKey: LEGACY_PASSWORD_KEY,
              },
              lastOpenedAt: Date.now(),
              lastConnectionStatus: "connected",
            },
          ],
        });
        const credentials = JSON.parse(await readFile(credentialsFile, "utf-8")) as Record<
          string,
          string
        >;
        credentials[LEGACY_PASSWORD_KEY] = UNDECRYPTABLE_VALUE;
        await writeFile(credentialsFile, JSON.stringify(credentials), "utf-8");
      },
    });
    await waitForRendererAfterColdRestart(CASE_MARKER);

    // (a) 本地项目仍在侧栏可见。
    await waitForProjectRow(DEFAULT_WORKSPACE, {
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: 冷启动后本地项目没有出现在侧栏`,
    });

    // (b) Source Directory 迁移完成；不可解密的旧密码不产生 Profile 密码引用。
    await browser.waitUntil(
      async () => (await readSettings()).sourceServerDirectoryMigrationVersion === 1,
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: `${CASE_MARKER}: Source Directory 迁移版本没有写入`,
      },
    );
    const settings = await readSettings();
    const legacyProfiles = (settings.connectionProfiles ?? []).filter(
      (profile) =>
        profile.target.kind === "ssh" &&
        profile.target.host === LEGACY_HOST &&
        profile.target.port === LEGACY_PORT &&
        profile.target.username === LEGACY_USER,
    );
    expect(legacyProfiles).toHaveLength(1);
    expect(legacyProfiles[0]!.target).not.toHaveProperty("passwordCredentialKey");

    // (c) 旧凭据原值保留，不删除、不改写。
    const credentials = JSON.parse(await readFile(credentialsFile, "utf-8")) as Record<
      string,
      string
    >;
    expect(credentials[LEGACY_PASSWORD_KEY]).toBe(UNDECRYPTABLE_VALUE);
  });
});
