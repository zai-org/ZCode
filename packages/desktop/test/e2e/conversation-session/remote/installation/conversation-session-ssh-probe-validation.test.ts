import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parseRemoteWorkspaceIdentity,
  ServiceChannels,
  type SourceServerManagementSnapshot,
} from "@zcode/shared";
import { TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, readSettings } from "#e2e/helpers/desktop-app";
import {
  execInRemoteContainer,
  readRemoteContainerFile,
  readRemoteDockerContainer,
  writeRemoteContainerFile,
} from "#e2e/helpers/remote-docker-target";
import {
  connectRemoteSourceFromSettings,
  disconnectRemoteSource,
  waitForDeviceStatus,
} from "#e2e/helpers/remote-project-actions";
import { callHandoffHost, installHandoffRpcProbe } from "#e2e/helpers/remote-project-handoff-probe";
import {
  clickLastEnabledSSHDialogButton,
  connectSSHWorkspace,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const MARKER = "E2E_SSH_PROBE_VALIDATION";
const FIXTURE_ROOT = "/tmp/zcode-probe-validation";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/ssh-probe-validation",
);
const INVALID_CASES = [
  { mode: "empty", detail: "PLATFORM" },
  { mode: "missing-platform", detail: "PLATFORM" },
  { mode: "missing-arch", detail: "ARCH" },
  { mode: "missing-root", detail: "ROOT" },
  { mode: "missing-installed", detail: "INSTALLED" },
  { mode: "invalid-installed", detail: "INSTALLED" },
  { mode: "missing-end", detail: "END" },
  { mode: "uname-failure", detail: "E2E_PROBE_UNAME_FAILED" },
] as const;

// 只影响本次容器 dev 用户的探测命令：正常执行仍进入原登录 shell，SFTP、安装与 daemon 不替换。
// 故障来自真实 SSH shell 的输出或命令失败，不 mock Host probe、连接管理器或安装状态。
function fixtureShell(originalShell: string): string {
  return `#!/bin/sh
case "$*" in
  *__ZCODE_PROBE_PLATFORM__*)
    mode=$(cat ${FIXTURE_ROOT}/mode)
    case "$mode" in
      empty) printf 'E2E_PROBE_EMPTY_OUTPUT\\n' >&2; exit 0 ;;
      missing-platform) ${originalShell} "$@" | sed '/^__ZCODE_PROBE_PLATFORM__$/ {n;s/.*//;}'; exit 0 ;;
      missing-arch) ${originalShell} "$@" | sed '/^__ZCODE_PROBE_ARCH__$/ {n;s/.*//;}'; exit 0 ;;
      missing-root) ${originalShell} "$@" | sed '/^__ZCODE_PROBE_ROOT__$/ {n;s/.*//;}'; exit 0 ;;
      missing-installed) ${originalShell} "$@" | sed '/^__ZCODE_PROBE_INSTALLED__$/ {N;d;}'; exit 0 ;;
      invalid-installed) ${originalShell} "$@" | sed '/^__ZCODE_PROBE_INSTALLED__$/ {n;s/.*/unknown/;}'; exit 0 ;;
      missing-end) ${originalShell} "$@" | sed '/^__ZCODE_PROBE_END__$/d'; exit 0 ;;
      uname-failure) PATH=${FIXTURE_ROOT}/bin:$PATH; export PATH ;;
    esac
    ;;
esac
exec ${originalShell} "$@"
`;
}

async function closeConnectionDialog() {
  await browser.keys("Escape");
  await $('[data-testid="ssh-dialog"]').waitForExist({ reverse: true, timeout: 15_000 });
}

/** 同时观察错误和安装等待点，旧实现不能靠停在安装确认把失败场景假装成仍在连接。 */
async function readProbeOutcome() {
  let outcome = { kind: "pending", text: "", details: "" };
  await browser.waitUntil(
    async () => {
      outcome = await browser.execute(() => {
        const panel = document.querySelector<HTMLElement>('[data-testid="ssh-error"]');
        if (panel?.getClientRects().length) {
          return {
            kind: "error",
            text: panel.innerText,
            details: panel.querySelector("details pre")?.textContent ?? "",
          };
        }
        const install = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
        ).some(
          (item) =>
            item.getClientRects().length && /安装并继续|Install and continue/u.test(item.innerText),
        );
        return { kind: install ? "install" : "pending", text: "", details: "" };
      });
      return outcome.kind !== "pending";
    },
    { timeout: 60_000, timeoutMsg: `${MARKER}: 探测没有返回错误或安装等待点` },
  );
  return outcome;
}

describe(`${MARKER}: 探测失败不伪装为系统不支持或未安装`, () => {
  const facts: Record<string, unknown> = {};
  let container: string;
  let originalShell: string;

  before(async () => {
    container = readRemoteDockerContainer(MARKER);
    const config = readSSHRuntimeConfig(MARKER);
    // fixture 限定 runner 新建的 dev 用户，不能改共享机器或其它账号的登录 shell。
    expect(config.username).toBe("dev");
    originalShell = (await execInRemoteContainer(container, ["getent", "passwd", "dev"])).stdout
      .trim()
      .split(":")
      .at(-1)!;
    expect(originalShell).toMatch(/^\/bin\/(?:ba)?sh$/u);
    facts.architecture = (await execInRemoteContainer(container, ["uname", "-m"])).stdout.trim();
    await writeRemoteContainerFile(container, `${FIXTURE_ROOT}/mode`, "normal\n");
    await writeRemoteContainerFile(container, `${FIXTURE_ROOT}/shell`, fixtureShell(originalShell));
    await writeRemoteContainerFile(
      container,
      `${FIXTURE_ROOT}/bin/uname`,
      "#!/bin/sh\nprintf 'E2E_PROBE_UNAME_FAILED\\n' >&2\nexit 9\n",
    );
    await execInRemoteContainer(container, [
      "chmod",
      "+x",
      `${FIXTURE_ROOT}/shell`,
      `${FIXTURE_ROOT}/bin/uname`,
    ]);
    await execInRemoteContainer(container, ["usermod", "-s", `${FIXTURE_ROOT}/shell`, "dev"], {
      user: "0",
    });
    await mkdir(artifactDir, { recursive: true });
    await prepareV4ConversationE2E({ skipProvider: true });
  });

  after(async () => {
    if (container && originalShell) {
      await execInRemoteContainer(container, ["usermod", "-s", originalShell, "dev"], {
        user: "0",
      });
      await execInRemoteContainer(container, ["rm", "-rf", FIXTURE_ROOT]);
    }
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "probe-validation.json"), JSON.stringify(facts, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  afterEach(async () => {
    await writeRemoteContainerFile(container, `${FIXTURE_ROOT}/mode`, "normal\n");
    if (await $('[data-testid="ssh-dialog"]').isExisting()) await closeConnectionDialog();
    if (await $('[data-testid="settings-page"]').isDisplayed())
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  });

  it("RDUX-11-11 空输出、必需字段缺失或非法、uname 失败均在安装前报告探测失败", async function () {
    this.timeout(10 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    for (const item of INVALID_CASES) {
      await writeRemoteContainerFile(container, `${FIXTURE_ROOT}/mode`, `${item.mode}\n`);
      await openSSHRemoteDialog(MARKER, { entry: "settings" });
      await fillSSHPasswordSettings(config);
      await clickLastEnabledSSHDialogButton(MARKER);
      const outcome = await readProbeOutcome();
      facts[item.mode] = outcome;
      expect(outcome.kind).toBe("error");
      expect(outcome.text).toContain("远端环境检查失败");
      expect(outcome.text).not.toContain("不支持该设备的系统");
      expect(outcome.details).toContain(item.detail);
      expect(outcome.details).not.toContain(config.password);
      if (item.mode === "empty") expect(outcome.details).toContain("E2E_PROBE_EMPTY_OUTPUT");
      await browser.saveScreenshot(resolve(artifactDir, `${item.mode}.png`));
      await closeConnectionDialog();
    }
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  });

  it("RDUX-11-12 已有设备探测结果不完整时保留安装状态，恢复后同一 Source 重连且不重装", async function () {
    this.timeout(15 * 60_000);
    await writeRemoteContainerFile(container, `${FIXTURE_ROOT}/mode`, "normal\n");
    const config = readSSHRuntimeConfig(MARKER);
    const tab = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[0],
    });
    const sourceId = parseRemoteWorkspaceIdentity(tab.workspaceIdentity!)?.sourceServerId;
    if (!sourceId) throw new Error(`${MARKER}: 正常首连没有 Source 身份`);
    await installHandoffRpcProbe();
    const readSnapshot = () =>
      callHandoffHost<SourceServerManagementSnapshot>(
        ServiceChannels.SourceServerManagement,
        "getSnapshot",
      );
    const before = await readSnapshot();
    const source = before.servers.find((item) => item.sourceServerId === sourceId)!;
    expect(source.installState).toBe("installed");
    const currentBefore = await readRemoteContainerFile(
      container,
      "/home/dev/.zcode/server/current.json",
    );
    await disconnectRemoteSource(sourceId, MARKER);
    await writeRemoteContainerFile(container, `${FIXTURE_ROOT}/mode`, "missing-installed\n");
    await connectRemoteSourceFromSettings(sourceId, MARKER);
    await waitForDeviceStatus(sourceId, "failed", MARKER);
    // 失败由连接弹窗展示，直接核对当前错误面板，避免点击遮罩后的设备行。
    const failure = await readProbeOutcome();
    facts.existingSourceFailure = failure;
    expect(failure.kind).toBe("error");
    expect(failure.text).toContain("远端环境检查失败");
    expect(failure.details).toContain("INSTALLED");
    const failed = await readSnapshot();
    facts.retainedState = { before, failed };
    expect(failed.servers.find((item) => item.sourceServerId === sourceId)?.installState).toBe(
      "installed",
    );
    expect(
      (await readSettings()).sourceServers?.find((item) => item.sourceServerId === sourceId)
        ?.installState,
    ).toBe("installed");
    expect(failed.profiles.map((item) => [item.profileId, item.sourceServerId])).toEqual(
      before.profiles.map((item) => [item.profileId, item.sourceServerId]),
    );
    expect(failed.workspaceHistory).toEqual(before.workspaceHistory);
    // 瞬态连接状态按 profileId 索引；握手前失败允许不带 sourceServerId，持久身份绑定已在上方断言。
    const profileId = before.profiles.find((item) => item.sourceServerId === sourceId)?.profileId;
    expect(profileId).toBeTruthy();
    expect(failed.states.find((item) => item.profileId === profileId)).toMatchObject({
      state: "failed",
      errorCode: "remote-preflight-failed",
    });
    await browser.saveScreenshot(resolve(artifactDir, "existing-source-probe-failed.png"));

    await writeRemoteContainerFile(container, `${FIXTURE_ROOT}/mode`, "normal\n");
    // failed 状态的主动作是“重试”，直接使用当前错误面板，不误用仅匹配“连接”的离线设备 helper。
    await $('[data-testid="ssh-error"]')
      .$('.//button[normalize-space(.)="重试" or normalize-space(.)="Retry"]')
      .click();
    await waitForDeviceStatus(sourceId, "online", MARKER, 120_000);
    const recovered = await readSnapshot();
    facts.recovered = recovered;
    expect(recovered.servers.find((item) => item.sourceServerId === sourceId)?.installState).toBe(
      "installed",
    );
    expect(await readRemoteContainerFile(container, "/home/dev/.zcode/server/current.json")).toBe(
      currentBefore,
    );
    const profile = recovered.profiles.find((item) => item.sourceServerId === sourceId)!;
    const logs = await callHandoffHost<Array<{ message: string }>>(
      ServiceChannels.SourceServerManagement,
      "getRecentOperationLogs",
      [profile.profileId],
    );
    expect(logs.some((item) => /Uploading|Extracting|Installing/u.test(item.message))).toBe(false);
    await browser.saveScreenshot(resolve(artifactDir, "existing-source-recovered.png"));
  });
});
