import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildRemoteEnvironmentKey,
  parseRemoteWorkspaceIdentity,
  providerProvisioningResultSchema,
} from "@zcode/shared";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { disconnectRemoteSource } from "#e2e/helpers/remote-project-actions";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { UPSTREAM_PROVIDER_NAME } from "#e2e/helpers/upstream-provider";
import {
  clickLastEnabledSSHDialogButton,
  connectSSHWorkspace,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  openSSHSourceDirectory,
  readRemoteTabSnapshot,
  readHostProcesses,
  readSSHRuntimeConfig,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_R3_SOURCE_LINES";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-source-lines");
const SYMLINK_PATH = "/home/dev/r3-workspace-link";

async function readProvisioningCompletions(): Promise<
  Array<{ environmentKey: string; trigger: string; status: string }>
> {
  const directory = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
  if (!directory) throw new Error(`${CASE_MARKER}: 缺少本次 Main 日志目录`);
  const marker = "[provider-provisioning] Environment sync completed ";
  const contents = await Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith(".log"))
      .map((name) => readFile(join(directory, name), "utf8")),
  );
  return contents.flatMap((content) =>
    content.split("\n").flatMap((line) => {
      const at = line.indexOf(marker);
      return at < 0 ? [] : [JSON.parse(line.slice(at + marker.length))];
    }),
  );
}

describe(`${CASE_MARKER}: 同一 Source 经两条线路/alias 与 symlink 打开时的身份收敛`, () => {
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "source-lines.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-CON-05/ID-03/PRV-18 127.0.0.1 与 localhost 两条线路指向同一 Source；symlink 与 realpath 收敛到同一 canonical workspace；两条线路各自完成同步", async function () {
    this.timeout(25 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const workspaceA = config.workspacePaths[0];
    const linkCreated = await runSSHCommand(config, `ln -sfn "${workspaceA}" "${SYMLINK_PATH}"`);
    expect(linkCreated.code).toBe(0);
    // 先确认夹具确为符号链接且指向目标，不能把目录准备失败误报为 canonical 身份缺陷。
    const resolvedLink = await runSSHCommand(
      config,
      `test -L "${SYMLINK_PATH}" && cd -P "${SYMLINK_PATH}" && pwd -P`,
    );
    facts.symlinkFixture = { code: resolvedLink.code, realpath: resolvedLink.stdout.trim() };
    expect(resolvedLink.code).toBe(0);
    expect(resolvedLink.stdout.trim()).toBe(workspaceA);
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();

    // 线路 1：127.0.0.1，打开 realpath 项目。
    const line1 = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config,
      workspacePath: workspaceA,
    });
    const source1 = parseRemoteWorkspaceIdentity(line1.workspaceIdentity!)?.sourceServerId;
    expect(source1).toBeTruthy();

    // ID-03：不同项目可指向同一目录；其执行 identity 仍须收敛到 canonical realpath。
    await openSSHSourceDirectory(config, CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(SYMLINK_PATH, CASE_MARKER);
    facts.activeTabAfterSymlinkOpen = await readRemoteTabSnapshot();
    const viaLink = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: workspaceA,
      timeoutMs: 60_000,
    });
    const sidebarAfterLink = await browser.execute(() => document.body?.innerText ?? "");
    facts.symlink = {
      identity: viaLink.workspaceIdentity,
      activePath: viaLink.workspacePath,
      sidebarHasLinkProject: sidebarAfterLink.includes("r3-workspace-link"),
      projectCountText: sidebarAfterLink.match(/\d+ 个项目/u)?.[0] ?? null,
    };
    expect(viaLink.workspaceIdentity).toBe(line1.workspaceIdentity);
    expect(sidebarAfterLink).toContain("r3-workspace-link");
    await browser.keys(["Escape"]);

    // 线路 2：localhost alias（不同 host 字串 → 不同 Environment key）。
    const aliasConfig = { ...config, host: "localhost" };
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(aliasConfig);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    // 产品会把 alias 线路收敛到已有 Source：tab 的 remoteHost 可能仍是既有线路的 host，因此不按 host 等待，只按 Source 收敛。
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(workspaceA, CASE_MARKER);
    let line2 = await readRemoteTabSnapshot();
    await browser.waitUntil(
      async () => {
        const dialogGone = await browser.execute(
          () => !document.querySelector('[data-testid="ssh-dialog"]'),
        );
        const active = await readRemoteTabSnapshot();
        line2 = active.activeWorkspaceIdentity
          ? await readRemoteTabSnapshot(active.activeWorkspaceIdentity)
          : active;
        return dialogGone && Boolean(line2.remoteSessionId);
      },
      { timeout: 120_000, interval: 300, timeoutMsg: `${CASE_MARKER}: alias 线路没有就绪` },
    );
    const source2 = parseRemoteWorkspaceIdentity(line2.workspaceIdentity!)?.sourceServerId;
    facts.sources = {
      line1: source1,
      line2: source2,
      line2RemoteHost: line2.remoteHost,
      line2Session: line2.remoteSessionId,
      line1Session: line1.remoteSessionId,
    };
    // CON-05：Source 不重复、identity 不变。
    expect(source2).toBe(source1);
    expect(await readHostProcesses()).toEqual(initialHosts);

    // alias 打开同一个 canonical workspace 会复用原 logical session，这不能证明第二条同步 lane。
    // 同一 Source 在线时连项目 B 也复用既有物理线路。显式断开后经 alias 接管，
    // 才能验证不同 Environment key 上线各自触发同步，不把 canonical join 当成新 lane。
    await disconnectRemoteSource(source1!, CASE_MARKER);
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(aliasConfig);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(config.workspacePaths[1], CASE_MARKER);
    const aliasProject = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: config.workspacePaths[1],
    });
    expect(parseRemoteWorkspaceIdentity(aliasProject.workspaceIdentity!)?.sourceServerId).toBe(
      source1,
    );
    expect(aliasProject.remoteSessionId).not.toBe(line1.remoteSessionId);
    expect(aliasProject.remoteHost).toBe(aliasConfig.host);
    const keys = [config, aliasConfig].map(({ host, port, username }) =>
      buildRemoteEnvironmentKey({ kind: "ssh", host, port, username }),
    );
    expect(keys[0]).not.toBe(keys[1]);
    const completions = await readProvisioningCompletions();
    for (const key of keys)
      expect(
        completions.some(
          (entry) =>
            entry.environmentKey === key &&
            entry.trigger === "environment-online" &&
            ["applied", "already-applied"].includes(entry.status),
        ),
      ).toBe(true);
    facts.environmentSyncs = { expectedKeys: keys, completions, aliasProject };
    const journal = await runSSHCommand(
      config,
      'cat "$HOME/.zcode/v2/runtime/provider/provisioning.json"',
    );
    expect(journal.code).toBe(0);
    const results = (JSON.parse(journal.stdout).records as Array<{ result: unknown }>).map(
      (record) => providerProvisioningResultSchema.parse(record.result),
    );
    facts.provisioningApplied = results.map(({ syncId, status }) => ({ syncId, status }));
    expect(results.filter((result) => result.status === "applied").length).toBeGreaterThanOrEqual(
      2,
    );
    const remoteConfig = await runSSHCommand(config, 'cat "$HOME/.zcode/v2/provider_config.json"');
    expect(remoteConfig.stdout).toContain(UPSTREAM_PROVIDER_NAME);
    const sidebar = await browser.execute(() => document.body?.innerText ?? "");
    facts.deviceRowsShowingPort = (
      sidebar.match(new RegExp(`dev@[^\\n]*:${config.port}`, "gu")) ?? []
    ).length;
  });
});
