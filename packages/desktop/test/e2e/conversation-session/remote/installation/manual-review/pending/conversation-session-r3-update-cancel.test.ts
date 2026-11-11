import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  parseRemoteWorkspaceIdentity,
  type SourceServerManagementSnapshot,
  type SourceServerOperationLog,
} from "@zcode/shared";
import { TID_CONFIRM_DIALOG_CONFIRM } from "@zcode/shared/test-ids";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  clearAppData,
  clickTestIdByDom,
  readSettings,
  seedSettings,
} from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  startRemoteAssetHttpProxy,
  type RemoteAssetHttpProxy,
} from "#e2e/helpers/remote-asset-http-proxy";
import {
  disconnectRemoteSource,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import {
  callSourceManagement,
  installSourceManagementRpc,
  readSourceManagementCall,
  restoreSourceManagementRpc,
  startSourceManagementCall,
  waitForSourceManagementRpcReady,
} from "#e2e/helpers/source-server-update-inflight";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readSSHRuntimeConfig,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

// 与 harness/remote/remote-wdio-env.mjs 的 TEST_CDN_SPEC_MARKERS 一致：本机缓存目录按该标记隔离。
const CASE_MARKER = "E2E_R3_UPDATE_CANCEL";
const FAKE_CDN_HOST = "remote-assets.e2e.invalid";
// pending 目录比 conversation-session 深两层，回到 packages/desktop。
const DESKTOP_ROOT = resolve(import.meta.dirname, "../../../../../../..");
const MOCK_CDN_ROOT = join(DESKTOP_ROOT, "mock-cdn");
const PROXY_NO_PROXY = [
  "localhost",
  "127.0.0.1",
  "::1",
  ".aminer.cn",
  ".bigmodel.cn",
  ".z.ai",
  ".codegeex.cn",
  ".z.ai",
  ".zcode-ai.com",
  "js.stripe.com",
].join(",");
// 约 90MB 的 archive 按 1 MiB/s 需要一分多钟，足够观察本机阶段并点击取消。
const SLOW_ARCHIVE_BYTES_PER_SECOND = 1024 * 1024;
// 03/04 还要等远端断线被检测、再发第二次更新；按 256 KiB/s 约六分钟，确保这些步骤都落在本机阶段内。
const HELD_ARCHIVE_BYTES_PER_SECOND = 256 * 1024;
const REMOTE_STAGE_PHASES = new Set([
  "preflight",
  "upload",
  "extract",
  "verify-archive",
  "verify",
  "restart",
  "install",
]);
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-update-cancel",
);

/** 当前 release 的 runtime/package.json 字节数与 sha256；损坏后字节数为 0。 */
async function readRemotePackageJson(config: SSHConnectionConfig): Promise<string> {
  const result = await runSSHCommand(
    config,
    [
      'R="$HOME/.zcode/server"',
      'id=$(sed -n \'s/^[[:space:]]*"releaseId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\' "$R/current.json" | head -n 1)',
      'echo "$(wc -c < "$R/releases/$id/runtime/package.json" | tr -d " ") $(sha256sum "$R/releases/$id/runtime/package.json" | cut -d " " -f 1)"',
    ].join("; "),
  );
  return result.stdout.trim();
}

/** 与 R3A-BLD-12 相同：停服后把当前 release 的 package.json 截为空，`serve --daemon` 必然失败。 */
async function damageCurrentRelease(config: SSHConnectionConfig): Promise<void> {
  await runSSHCommand(
    config,
    [
      'R="$HOME/.zcode/server"',
      '"$R/bin/zcode" stop --wait --server-root "$R" --json >/dev/null 2>&1 || true',
      'id=$(sed -n \'s/^[[:space:]]*"releaseId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\' "$R/current.json" | head -n 1)',
      ': > "$R/releases/$id/runtime/package.json"',
    ].join("; "),
    { timeoutMs: 60_000 },
  );
}

/** 只停远端服务、不改 release：在线连接随之关闭，下一次连接由 `serve --daemon` 重新拉起。 */
async function stopRemoteService(config: SSHConnectionConfig): Promise<void> {
  await runSSHCommand(
    config,
    [
      'R="$HOME/.zcode/server"',
      '"$R/bin/zcode" stop --wait --server-root "$R" --json >/dev/null 2>&1 || true',
    ].join("; "),
    { timeoutMs: 60_000 },
  );
}

/** 轮询到 done 成立或超时，返回最后一次读到的值；不抛错，便于先把修复前的现象写进工件再断言。 */
async function pollFor<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await browser.pause(200);
  }
}

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

async function startWizardReinstall(): Promise<void> {
  const reinstall = $('[data-testid="ssh-dialog"] [data-source-server-reinstall]');
  await reinstall.waitForDisplayed({
    timeout: 120_000,
    timeoutMsg: `${CASE_MARKER}: 向导失败页缺少重新安装`,
  });
  await reinstall.click();
  await $('[role="dialog"][data-confirm-intent="source-server-reinstall"]').waitForDisplayed({
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: 没有重新安装确认`,
  });
  await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, { timeout: 15_000 });
}

async function readWizardButtons() {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
    ).map((button) => ({ text: button.innerText.trim(), disabled: button.disabled })),
  );
}

/**
 * 读连接日志里最新的本机下载百分比；日志列表收起时先展开。重新安装场景的上次失败在启动阶段，阶段轨
 * 停在该失败上，下载进度只出现在日志里（阶段轨投影是既有行为，不在本用例范围）。
 */
async function readDownloadProgress(): Promise<number | null> {
  return browser.execute(() => {
    const dialog = document.querySelector('[data-testid="ssh-dialog"]');
    if (!dialog) return null;
    const container = dialog.querySelector('[data-testid="remote-connection-log"]');
    if (!container) {
      Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => /^(连接日志|Connection log)/u.test(button.innerText.trim()))
        ?.click();
      return null;
    }
    const matches = Array.from(
      (container.textContent ?? "").matchAll(
        /\[source-server:download\] download progress: (\d+(?:\.\d+)?)%/gu,
      ),
    );
    const last = matches.at(-1);
    return last ? Number(last[1]) : null;
  });
}

async function readProfileState(profileId: string) {
  const snapshot = await callSourceManagement<SourceServerManagementSnapshot>("getSnapshot");
  return snapshot.states.find((state) => state.profileId === profileId);
}

async function readOperationLogs(profileId: string): Promise<SourceServerOperationLog[]> {
  return callSourceManagement<SourceServerOperationLog[]>("getRecentOperationLogs", [profileId]);
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

/** 深浅主题截图，供人工复核本机下载进度与可用的「取消连接」；结束后恢复浅色。 */
async function captureThemeScreenshots(name: string): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await setTheme(theme);
    await browser.saveScreenshot(resolve(artifactDir, `${name}-${theme}.png`));
  }
  await setTheme("light");
}

const isCancelButton = (text: string) => /^(取消连接|Cancel connection)$/u.test(text);

describe(`${CASE_MARKER}: 更新的本机阶段显示下载进度并可取消`, () => {
  let proxy: RemoteAssetHttpProxy | null = null;
  const cacheDir = resolveE2ERuntimePath(CASE_MARKER, "cache");
  const facts: Record<string, unknown> = { timeline: [] as string[] };
  const mark = async (label: string) => {
    (facts.timeline as string[]).push(`${new Date().toISOString()} ${label}`);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "update-cancel.json"), JSON.stringify(facts, null, 2));
  };
  // 01/02 重装完成后的在线设备，供 03/04 复用（同一 Electron 会话与 Host RPC 端口）。
  let context:
    | {
        config: SSHConnectionConfig;
        profileId: string;
        identity: string;
        workspacePath: string;
        versionCacheDir: string;
      }
    | undefined;
  const requireContext = () => {
    if (!context) throw new Error(`${CASE_MARKER}: 01/02 未完成，缺少已重装的在线设备`);
    return context;
  };

  /** 等更新进入本机下载：快照为 updating + updateCancelable，且测试 CDN 上有一条进行中的 archive 传输。 */
  const waitForLocalDownload = async (profileId: string, transfersBefore: number) => {
    let state: Awaited<ReturnType<typeof readProfileState>>;
    await browser.waitUntil(
      async () => {
        state = await readProfileState(profileId);
        const transfer = proxy!.transfers.at(-1);
        return (
          state?.state === "updating" &&
          state.updateCancelable === true &&
          proxy!.transfers.length > transfersBefore &&
          transfer !== undefined &&
          transfer.sentBytes > 0 &&
          !transfer.completed &&
          !transfer.aborted
        );
      },
      { timeout: 120_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 更新没有进入本机下载` },
    );
    return state!;
  };

  after(async () => {
    try {
      facts.transfers = proxy?.transfers ?? [];
      await mkdir(artifactDir, { recursive: true });
      await browser.saveScreenshot(resolve(artifactDir, "update-cancel-final.png")).catch(() => {});
      await writeFile(resolve(artifactDir, "update-cancel.json"), JSON.stringify(facts, null, 2));
      await restoreSourceManagementRpc().catch(() => undefined);
      await clearAppData();
    } finally {
      await proxy?.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("R3-UPDATE-CANCEL-01/02 本机下载显示进度、可取消且不写远端；远端阶段不可取消，重试后重装完成", async function () {
    this.timeout(25 * 60_000);
    // worker 修改 process.env 无法影响已创建的 Electron；三项必须由 runner 在 WDIO 启动前注入。
    expect(process.env.ZCODE_DEV_REMOTE_ASSET_USE_CDN).toBe("1");
    expect(process.env.ZCODE_REMOTE_ASSET_CDN_BASE_URL).toBe(`http://${FAKE_CDN_HOST}`);
    expect(process.env.ZCODE_REMOTE_ASSET_CACHE_DIR).toBe(cacheDir);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const [workspacePath] = config.workspacePaths;
    const { version } = JSON.parse(
      await readFile(resolve(DESKTOP_ROOT, "../../package.json"), "utf8"),
    ) as { version: string };
    const versionCacheDir = join(cacheDir, "source-server", version);

    proxy = await startRemoteAssetHttpProxy({
      expectedHost: FAKE_CDN_HOST,
      mockCdnRoot: MOCK_CDN_ROOT,
    });
    await rm(cacheDir, { recursive: true, force: true });
    // Bug 原因：旧 App 仍在启动时，Host 会把内存里的设置写回文件；在它存活时种代理会被覆盖，
    // 重载后代理为 direct，首装连不到测试 CDN（本机 4 次运行中 2 次）。种子在旧进程退出后写入。
    const { proxyUrl } = proxy;
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await seedSettings({ httpProxy: proxyUrl, httpProxyNoProxy: PROXY_NO_PROXY });
      },
    });
    await prepareV4ConversationE2E({ skipProvider: true });
    await installSourceManagementRpc();

    // 首连：干净目标经测试 CDN 安装（不限速）。
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    expect(await waitForSSHDirectoryStep(CASE_MARKER)).toBe("directory");
    const profileId = (await readSettings()).connectionProfiles?.find(
      (profile) =>
        profile.target.kind === "ssh" &&
        profile.target.host === config.host &&
        profile.target.port === config.port,
    )?.profileId;
    if (!profileId) throw new Error(`${CASE_MARKER}: 首连后缺少线路`);
    await waitForSourceManagementRpcReady(CASE_MARKER);
    // 首次安装复用同一 resolver：此时设备日志是安装那次连接，应有本机下载进度。
    // 必须在打开项目之前读取：打开项目会再连接一次（复用在线连接），并替换设备日志。
    const installLogs = await readOperationLogs(profileId);
    facts.installDownloadLogs = installLogs.filter((entry) => entry.phase === "download");
    expect(
      installLogs.some(
        (entry) => entry.phase === "download" && entry.message.startsWith("download progress:"),
      ),
    ).toBe(true);
    await selectSSHRemoteDirectory(workspacePath, CASE_MARKER);
    const tab = await waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: workspacePath });
    const identity = tab.workspaceIdentity!;
    const sourceServerId = parseRemoteWorkspaceIdentity(identity)?.sourceServerId;
    if (!sourceServerId) throw new Error(`${CASE_MARKER}: 首连后缺少设备身份`);
    const installedPackage = await readRemotePackageJson(config);
    expect(installedPackage).not.toMatch(/^0 /u);
    facts.installed = { tab, profileId, installedPackage };
    await mark("installed");

    // R3-UPDATE-CANCEL-01：损坏 release → 清空本机缓存并限速 → 向导失败页重新安装。
    await disconnectRemoteSource(sourceServerId, CASE_MARKER, { workspaceIdentities: [identity] });
    await damageCurrentRelease(config);
    expect(await readRemotePackageJson(config)).toMatch(/^0 /u);
    await rm(cacheDir, { recursive: true, force: true });
    proxy.setArchiveBytesPerSecond(SLOW_ARCHIVE_BYTES_PER_SECOND);
    await requestRemoteProjectConnection(identity, CASE_MARKER);
    await clickFailedBannerReconnect();
    await startWizardReinstall();
    await mark("reinstall-started");

    await browser.waitUntil(async () => ((await readDownloadProgress()) ?? 0) > 0, {
      timeout: 120_000,
      interval: 500,
      timeoutMsg: `${CASE_MARKER}: 本机下载期间向导日志没有下载进度`,
    });
    const localState = await readProfileState(profileId);
    const localButtons = await readWizardButtons();
    const localLogs = await readOperationLogs(profileId);
    facts.localStage = { state: localState, buttons: localButtons, logs: localLogs };
    await captureThemeScreenshots("local-download");
    expect(localState).toMatchObject({ state: "updating", updateCancelable: true });
    expect(
      localLogs.some(
        (entry) => entry.phase === "download" && entry.message.startsWith("download progress:"),
      ),
    ).toBe(true);
    const cancelButtons = localButtons.filter((button) => isCancelButton(button.text));
    expect(cancelButtons.length).toBeGreaterThan(0);
    expect(cancelButtons.every((button) => !button.disabled)).toBe(true);
    expect(
      localButtons.find((button) => /^(返回配置|Back to configuration)$/u.test(button.text))
        ?.disabled,
    ).toBe(true);
    await mark("local-stage-observed");

    const canceledAt = Date.now();
    const clicked = await browser.execute(() => {
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
      )
        .reverse()
        .find((item) => /^(取消连接|Cancel connection)$/u.test(item.innerText.trim()));
      if (!button || button.disabled) return false;
      button.click();
      return true;
    });
    expect(clicked).toBe(true);
    // 取消必须立即中止本机请求，而不是等下载结束或网络超时。
    await browser.waitUntil(() => Promise.resolve(proxy!.transfers.at(-1)?.aborted === true), {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: `${CASE_MARKER}: 取消后测试 CDN 的 archive 请求没有被中止`,
    });
    await browser.waitUntil(async () => (await readProfileState(profileId))?.state !== "updating", {
      timeout: 15_000,
      interval: 500,
      timeoutMsg: `${CASE_MARKER}: 取消后设备仍在更新中`,
    });
    facts.cancelLatencyMs = Date.now() - canceledAt;
    const canceledState = await readProfileState(profileId);
    const canceledLogs = await readOperationLogs(profileId);
    const transfer = proxy.transfers.at(-1)!;
    facts.canceled = { state: canceledState, logs: canceledLogs, transfer };
    expect(transfer.sentBytes).toBeLessThan(transfer.totalBytes);
    expect(canceledState?.updateCancelable).toBeUndefined();
    expect(canceledState?.errorCode).toBeUndefined();
    expect(canceledLogs.at(-1)).toMatchObject({ operation: "update", level: "info" });
    expect(canceledLogs.at(-1)?.message).toMatch(/cancel/iu);
    const leftovers = await readdir(versionCacheDir).catch(() => [] as string[]);
    facts.cacheAfterCancel = leftovers;
    expect(leftovers.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    // 本机阶段没有写入远端：release 仍是损坏状态。
    expect(await readRemotePackageJson(config)).toMatch(/^0 /u);
    await browser.waitUntil(
      async () =>
        (await readWizardButtons()).some(
          (button) => /^(重试|Retry)$/u.test(button.text) && !button.disabled,
        ),
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 取消后向导没有进入可重试的已取消状态` },
    );
    await mark("canceled");

    // R3-UPDATE-CANCEL-02：解除限速后重试，再次重新安装；远端阶段不可取消。
    proxy.setArchiveBytesPerSecond(null);
    await browser.execute(() => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'))
        .find((item) => /^(重试|Retry)$/u.test(item.innerText.trim()) && !item.disabled)
        ?.click();
    });
    await startWizardReinstall();
    let remoteStage: Record<string, unknown> | undefined;
    await browser.waitUntil(
      async () => {
        const [logs, state] = await Promise.all([
          readOperationLogs(profileId),
          readProfileState(profileId),
        ]);
        const phase = logs.at(-1)?.phase;
        if (state?.state !== "updating" || !phase || !REMOTE_STAGE_PHASES.has(phase)) return false;
        remoteStage = { phase, state, buttons: await readWizardButtons() };
        return true;
      },
      {
        timeout: 180_000,
        interval: 200,
        timeoutMsg: `${CASE_MARKER}: 没有观察到更新进入远端阶段`,
      },
    );
    facts.remoteStage = remoteStage;
    expect((remoteStage!.state as { updateCancelable?: boolean }).updateCancelable).toBeUndefined();
    const remoteButtons = remoteStage!.buttons as Array<{ text: string; disabled: boolean }>;
    expect(remoteButtons.filter((button) => isCancelButton(button.text)).length).toBeGreaterThan(0);
    expect(
      remoteButtons.filter((button) => isCancelButton(button.text)).every((b) => b.disabled),
    ).toBe(true);
    await mark("remote-stage-observed");

    const reconnected = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: identity,
      expectedPath: workspacePath,
      timeoutMs: 5 * 60_000,
    });
    expect(reconnected.remoteSessionId).toBeTruthy();
    expect(await readRemotePackageJson(config)).toBe(installedPackage);
    facts.reconnected = reconnected;
    await mark("reinstalled");
    context = { config, profileId, identity, workspacePath, versionCacheDir };
  });

  // CR-02：在线设备的更新在本机下载期间，旧在线连接关闭（更新的预期断线，只做连接失效）。修复前失效投影
  // 重新写入 updating 时丢掉 updateCancelable，Host 实际仍可取消；修复后该字段只由更新 flight 推导。
  it("R3-UPDATE-CANCEL-03 在线设备本机下载期间旧连接关闭，快照仍可取消；取消立即中止并恢复在线", async function () {
    this.timeout(10 * 60_000);
    const { config, profileId, identity, workspacePath, versionCacheDir } = requireContext();
    expect((await readProfileState(profileId))?.state).toBe("online");
    await rm(cacheDir, { recursive: true, force: true });
    proxy!.setArchiveBytesPerSecond(HELD_ARCHIVE_BYTES_PER_SECOND);
    const transfersBefore = proxy!.transfers.length;
    // 模拟设备卡「更新」：经 Host RPC 对在线设备发起更新，不经过向导。
    const updateKey = await startSourceManagementCall("updateSource", [{ profileId }]);
    const downloading = await waitForLocalDownload(profileId, transfersBefore);
    const transfer = proxy!.transfers.at(-1)!;
    await mark("03-local-download");

    // 停远端服务让在线连接关闭；Host 把它当作更新的预期断线，做连接失效并重新写入 updating。
    await stopRemoteService(config);
    const afterClose = await pollFor(
      () => readProfileState(profileId),
      (state) => (state?.updatedAt ?? 0) > (downloading?.updatedAt ?? 0),
      60_000,
    );
    facts.closeDuringDownload03 = { downloading, afterClose, transfer: { ...transfer } };
    await mark("03-closed-during-download");

    // 先取消并等收口，再断言：修复前快照虽丢了字段，Host 仍能取消；04 需要恢复在线的设备。
    const canceledAt = Date.now();
    const cancel = await callSourceManagement<{ canceled: boolean }>("cancelSourceUpdate", [
      profileId,
    ]);
    const aborted = await pollFor(() => transfer.aborted, Boolean, 15_000);
    const abortLatencyMs = Date.now() - canceledAt;
    const update = await pollFor(() => readSourceManagementCall(updateKey), Boolean, 30_000);
    const recovered = await pollFor(
      () => readProfileState(profileId),
      (state) => state?.state === "online",
      120_000,
    );
    const leftovers = await readdir(versionCacheDir).catch(() => [] as string[]);
    facts.canceled03 = {
      cancel,
      abortLatencyMs,
      transfer: { ...transfer },
      update,
      recovered,
      leftovers,
    };
    await mark("03-canceled");

    expect(afterClose?.updatedAt).toBeGreaterThan(downloading?.updatedAt ?? 0);
    expect(afterClose).toMatchObject({ state: "updating", updateCancelable: true });
    expect(cancel.canceled).toBe(true);
    expect(aborted).toBe(true);
    expect(transfer.sentBytes).toBeLessThan(transfer.totalBytes);
    expect(update).toMatchObject({ ok: false, code: "remote-connection-canceled" });
    expect(leftovers.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    // 取消不是断开：恢复意图仍在，Host 重新拉起远端服务恢复在线，原项目重新连接。
    expect(recovered).toMatchObject({ state: "online" });
    expect(recovered?.updateCancelable).toBeUndefined();
    expect(recovered?.errorCode).toBeUndefined();
    const reconnected = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: identity,
      expectedPath: workspacePath,
      timeoutMs: 3 * 60_000,
    });
    expect(reconnected.remoteSessionId).toBeTruthy();
    await mark("03-recovered");
  });

  // CR-01：同一线路连续两次更新。修复前 Host 允许并存，后一次把前一次写的 updating 记成更新前状态，
  // 取消后可能一直停在“更新中”；修复后第二次在写操作日志前被拒绝，前一次收口后才能再次更新。
  it("R3-UPDATE-CANCEL-04 同一线路已有更新时第二次更新被拒绝；取消后恢复在线，之后可再次更新", async function () {
    this.timeout(10 * 60_000);
    const { profileId, versionCacheDir } = requireContext();
    expect((await readProfileState(profileId))?.state).toBe("online");
    await rm(cacheDir, { recursive: true, force: true });
    proxy!.setArchiveBytesPerSecond(HELD_ARCHIVE_BYTES_PER_SECOND);
    const transfersBefore = proxy!.transfers.length;
    const firstKey = await startSourceManagementCall("updateSource", [{ profileId }]);
    await waitForLocalDownload(profileId, transfersBefore);
    // 模拟两个入口在 updating 快照到达前各发一次：绕过 UI 的按钮禁用，直接经 Host RPC 再发一次。
    const secondKey = await startSourceManagementCall("updateSource", [{ profileId }]);
    const second = await pollFor(() => readSourceManagementCall(secondKey), Boolean, 15_000);
    facts.second04 = second ?? "pending after 15s";
    await mark("04-second-update-sent");

    const cancel = await callSourceManagement<{ canceled: boolean }>("cancelSourceUpdate", [
      profileId,
    ]);
    const first = await pollFor(() => readSourceManagementCall(firstKey), Boolean, 30_000);
    const secondSettled =
      second ?? (await pollFor(() => readSourceManagementCall(secondKey), Boolean, 30_000));
    // 两次请求都已收口后，设备不能停在“更新中”。
    const settled = await pollFor(
      () => readProfileState(profileId),
      (state) => state?.state !== "updating",
      20_000,
    );
    // 代理侧在 socket 关闭时才标记 aborted，先等它落定再取快照。
    await pollFor(
      () => proxy!.transfers.slice(transfersBefore).every((item) => item.aborted),
      Boolean,
      15_000,
    );
    const transfers = proxy!.transfers.slice(transfersBefore).map((item) => ({ ...item }));
    const logs = await readOperationLogs(profileId);
    facts.settled04 = {
      cancel,
      first,
      second: secondSettled,
      settled,
      transfers,
      lastLog: logs.at(-1),
    };
    await mark("04-settled");

    expect(second).toMatchObject({ ok: false, code: "source-server-operation-in-progress" });
    expect(cancel.canceled).toBe(true);
    expect(first).toMatchObject({ ok: false, code: "remote-connection-canceled" });
    expect(settled).toMatchObject({ state: "online" });
    expect(settled?.updateCancelable).toBeUndefined();
    expect(settled?.errorCode).toBeUndefined();
    // 被拒绝的更新没有下载，也没有替换设备操作日志。
    expect(transfers.length).toBe(1);
    expect(transfers.every((item) => item.aborted)).toBe(true);
    expect(logs.at(-1)).toMatchObject({ operation: "update", level: "info" });

    // 前一次收口后同一线路可以再次更新：互斥只持续到前一次结束。
    const retryBefore = proxy!.transfers.length;
    const thirdKey = await startSourceManagementCall("updateSource", [{ profileId }]);
    await waitForLocalDownload(profileId, retryBefore);
    const thirdCancel = await callSourceManagement<{ canceled: boolean }>("cancelSourceUpdate", [
      profileId,
    ]);
    const third = await pollFor(() => readSourceManagementCall(thirdKey), Boolean, 30_000);
    const final = await pollFor(
      () => readProfileState(profileId),
      (state) => state?.state === "online",
      30_000,
    );
    const leftovers = await readdir(versionCacheDir).catch(() => [] as string[]);
    facts.third04 = { thirdCancel, third, final, leftovers };
    await mark("04-third-update-canceled");
    expect(thirdCancel.canceled).toBe(true);
    expect(third).toMatchObject({ ok: false, code: "remote-connection-canceled" });
    expect(final).toMatchObject({ state: "online" });
    expect(leftovers.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
