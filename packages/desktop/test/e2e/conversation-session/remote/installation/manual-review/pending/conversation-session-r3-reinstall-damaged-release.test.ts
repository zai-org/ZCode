import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_CONFIRM_DIALOG_CONFIRM, TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { getToastMessages } from "#e2e/helpers/conversation-session-toast";
import {
  connectRemoteSourceFromSettings,
  disconnectRemoteSource,
  expandRemoteDeviceRow,
  openRemoteDevicesSettings,
  requestRemoteProjectConnection,
  waitForDeviceStatus,
} from "#e2e/helpers/remote-project-actions";
import {
  connectSSHWorkspace,
  readHostProcesses,
  readSSHRuntimeConfig,
  runSSHCommand,
  waitForRemoteTab,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_REINSTALL_DAMAGED_RELEASE";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-reinstall-damaged-release",
);
// 重装要上传完整 archive 再启动远端服务；本机 Docker 远端通常一分钟内完成，留足余量。
const REINSTALL_TIMEOUT_MS = 5 * 60_000;

interface RemoteReleaseSnapshot {
  releaseId: string;
  /** 当前 release 的 runtime/package.json 字节数与 sha256。 */
  packageJson: string;
  /** releases/ 下的全部条目（含隐藏的 .damaged-* / .incoming-*）。 */
  entries: string[];
}

async function readRemoteRelease(config: SSHConnectionConfig): Promise<RemoteReleaseSnapshot> {
  const result = await runSSHCommand(
    config,
    [
      'R="$HOME/.zcode/server"',
      'id=$(sed -n \'s/^[[:space:]]*"releaseId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\' "$R/current.json" | head -n 1)',
      'echo "release=$id"',
      'echo "package=$(wc -c < "$R/releases/$id/runtime/package.json" | tr -d " ") $(sha256sum "$R/releases/$id/runtime/package.json" | cut -d " " -f 1)"',
      'echo "entries=$(ls -A "$R/releases" | tr "\\n" " ")"',
    ].join("; "),
  );
  const line = (key: string) =>
    result.stdout
      .split("\n")
      .find((value) => value.startsWith(`${key}=`))
      ?.slice(key.length + 1)
      .trim() ?? "";
  return {
    releaseId: line("release"),
    packageJson: line("package"),
    entries: line("entries").split(/\s+/u).filter(Boolean).sort(),
  };
}

/**
 * 复现 A2：本机断开后停止远端服务，再把当前 release 的 runtime/package.json 截为空文件。
 * 之后 `serve --daemon` 会在 Node 判断入口格式时报 ERR_INVALID_PACKAGE_CONFIG。
 */
async function damageCurrentRelease(config: SSHConnectionConfig): Promise<string> {
  const result = await runSSHCommand(
    config,
    [
      'R="$HOME/.zcode/server"',
      '"$R/bin/zcode" stop --wait --server-root "$R" --json >/dev/null 2>&1 || true',
      'id=$(sed -n \'s/^[[:space:]]*"releaseId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\' "$R/current.json" | head -n 1)',
      ': > "$R/releases/$id/runtime/package.json"',
      // 直接执行一次与 Desktop 相同的启动命令，确认损坏能复现事故签名。
      '"$R/bin/zcode" serve --daemon --json --server-root "$R" 2>&1 | grep -c ERR_INVALID_PACKAGE_CONFIG',
    ].join("; "),
    { timeoutMs: 60_000 },
  );
  return result.stdout.trim();
}

/** 会话横幅进入“连接失败”后点「重新连接」；失败设备由该入口打开带原故障的向导。 */
async function clickFailedBannerReconnect(): Promise<void> {
  const banner = $('[data-testid="remote-conversation-banner"][data-connection-state="failed"]');
  await banner.waitForDisplayed({
    timeout: 120_000,
    timeoutMsg: `${CASE_MARKER}: 会话横幅未进入连接失败`,
  });
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            '[data-testid="remote-conversation-banner"] button',
          ),
        ).find(
          (item) => ["重新连接", "Reconnect"].includes(item.innerText.trim()) && !item.disabled,
        );
        button?.click();
        return Boolean(button);
      }),
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 横幅没有可用的重新连接` },
  );
}

async function setTheme(theme: "light" | "dark"): Promise<void> {
  await browser.execute((color) => {
    (
      window as Window & { __testActions?: { setTheme(theme: string): void } }
    ).__testActions?.setTheme(color);
  }, theme);
  await browser.executeAsync((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())),
  );
}

/** 深浅主题截图，供人工复核新入口在错误面板与菜单中的可辨识度；结束后恢复浅色。 */
async function captureThemeScreenshots(name: string): Promise<void> {
  const root = process.env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  if (!root) return;
  const dir = resolve(root, "r3-reinstall-damaged-release");
  await mkdir(dir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await setTheme(theme);
    await browser.saveScreenshot(resolve(dir, `${name}-${theme}.png`));
  }
  await setTheme("light");
}

function wizardReinstallButton() {
  return $('[data-testid="ssh-dialog"] [data-source-server-reinstall]');
}

/** 失败终态的向导页脚右侧是“关闭”；关闭后设备行保留连接失败，展开后可见错误条。 */
async function closeConnectionWizard(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
        ).find((item) => ["关闭", "Close"].includes(item.innerText.trim()) && !item.disabled);
        button?.click();
        return Boolean(button);
      }),
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 向导没有可用的关闭按钮` },
  );
  await $('[data-testid="ssh-dialog"]').waitForDisplayed({ reverse: true, timeout: 15_000 });
}

function reinstallDialog() {
  return $('[role="dialog"][data-confirm-intent="source-server-reinstall"]');
}

async function confirmReinstall(facts: Record<string, unknown>, key: string): Promise<void> {
  await reinstallDialog().waitForDisplayed({
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: 没有重新安装确认`,
  });
  facts[key] = await reinstallDialog().getText();
  await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, { timeout: 15_000 });
}

function expectRepaired(before: RemoteReleaseSnapshot, after: RemoteReleaseSnapshot): void {
  // 同一 archive 重装：releaseId 不变，package.json 恢复为原内容，不留隔离目录或半成品。
  expect(after.releaseId).toBe(before.releaseId);
  expect(after.packageJson).toBe(before.packageJson);
  expect(after.entries.filter((entry) => entry.startsWith("."))).toEqual([]);
}

describe(`${CASE_MARKER}: 远端 release 损坏后重新安装远端服务`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-BLD-12 设备卡错误条与连接向导失败页都能重新安装并恢复连接（RDRI-01）", async function () {
    this.timeout(25 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const hosts = await readHostProcesses();
    const [workspacePath] = config.workspacePaths;
    const facts: Record<string, unknown> = {};

    const project = await connectSSHWorkspace({ config, caseMarker: CASE_MARKER, workspacePath });
    const identity = project.workspaceIdentity!;
    const sourceId = parseRemoteWorkspaceIdentity(identity)?.sourceServerId;
    if (!sourceId) throw new Error(`${CASE_MARKER}: 首连缺少设备身份`);
    const installed = await readRemoteRelease(config);
    expect(installed.releaseId).not.toBe("");
    expect(installed.packageJson).not.toMatch(/^0 /u);
    facts.installed = installed;

    // 1. 设备卡：断开 → 远端损坏 → 设置页连接失败。设置页连接失败会打开连接向导，先确认向导失败页
    //    也提供入口，再关闭向导，展开设备行后从错误条重新安装。
    await disconnectRemoteSource(sourceId, CASE_MARKER, { workspaceIdentities: [identity] });
    facts.firstDamage = await damageCurrentRelease(config);
    expect(facts.firstDamage).not.toBe("0");
    await connectRemoteSourceFromSettings(sourceId, CASE_MARKER);
    await wizardReinstallButton().waitForDisplayed({
      timeout: 120_000,
      timeoutMsg: `${CASE_MARKER}: 设置页连接失败后向导缺少重新安装`,
    });
    facts.settingsWizardError = await $('[data-testid="ssh-error"]').getText();
    await captureThemeScreenshots("wizard-failure");
    await closeConnectionWizard();
    await waitForDeviceStatus(sourceId, "failed", CASE_MARKER, 30_000);
    const card = `[data-source-server-card="${sourceId}"]`;
    // 「更多」菜单常驻且可用。
    await $(`${card} button[aria-label="更多"]`).click();
    const menuItem = $('[role="menu"] [data-source-server-lifecycle-action="reinstall"]');
    await menuItem.waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 菜单缺少重新安装`,
    });
    expect(await menuItem.getAttribute("data-disabled")).toBeNull();
    await captureThemeScreenshots("device-card-menu");
    await browser.keys("Escape");
    // RDUX-13：失败设备不自动展开，错误条在展开区。
    await expandRemoteDeviceRow(sourceId, CASE_MARKER);
    const inline = $(`${card} [data-source-server-reinstall]`);
    await inline.waitForDisplayed({
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 错误条缺少重新安装`,
    });
    await captureThemeScreenshots("device-card-error");
    await inline.click();
    await confirmReinstall(facts, "deviceCardConfirm");
    await waitForDeviceStatus(sourceId, "online", CASE_MARKER, REINSTALL_TIMEOUT_MS);
    let toasts: string[] = [];
    await browser.waitUntil(
      async () => {
        toasts = await getToastMessages();
        return toasts.some(
          (message) => message.includes("已重新安装") || message.includes("was reinstalled"),
        );
      },
      {
        timeout: 60_000,
        timeoutMsg: `${CASE_MARKER}: 没有重新安装完成提示；latest=${JSON.stringify(toasts)}`,
      },
    );
    const afterCard = await readRemoteRelease(config);
    expectRepaired(installed, afterCard);
    facts.afterDeviceCard = afterCard;

    // 2. 连接向导失败页：再次损坏后从侧栏项目「连接」进入向导，失败页「重新安装远端服务」。
    // 设备卡步骤停在设置页；断开入口会自行打开设置，先回到工作区。
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
    await disconnectRemoteSource(sourceId, CASE_MARKER, { workspaceIdentities: [identity] });
    facts.secondDamage = await damageCurrentRelease(config);
    expect(facts.secondDamage).not.toBe("0");
    // 未连接的项目点「连接」在后台拨号，失败只显示在项目行与会话横幅；项目已是连接失败时，
    // 横幅「重新连接」打开带原故障的向导失败页。
    await requestRemoteProjectConnection(identity, CASE_MARKER);
    await clickFailedBannerReconnect();
    await wizardReinstallButton().waitForDisplayed({
      timeout: 120_000,
      timeoutMsg: `${CASE_MARKER}: 向导失败页缺少重新安装`,
    });
    facts.wizardError = await $('[data-testid="ssh-error"]').getText();
    await wizardReinstallButton().click();
    await confirmReinstall(facts, "wizardConfirm");
    // 重装成功后向导继续原项目连接。
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: identity,
      expectedPath: workspacePath,
      timeoutMs: REINSTALL_TIMEOUT_MS,
    });
    const afterWizard = await readRemoteRelease(config);
    expectRepaired(installed, afterWizard);
    facts.afterWizard = afterWizard;

    await openRemoteDevicesSettings();
    await waitForDeviceStatus(sourceId, "online", CASE_MARKER);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
    expect(await readHostProcesses()).toEqual(hosts);

    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "reinstall-damaged-release.json"),
      JSON.stringify(facts, null, 2),
    );
  });
});
