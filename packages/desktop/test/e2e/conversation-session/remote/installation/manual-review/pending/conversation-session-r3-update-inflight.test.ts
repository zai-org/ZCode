import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity, type SourceServerManagementSnapshot } from "@zcode/shared";
import { clearAppData, readSettings, waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";
import {
  disconnectRemoteSource,
  openRemoteDevicesSettings,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import { prepareSourceServerUpdateArchive } from "#e2e/helpers/source-server-update-fixture";
import {
  callSourceManagement,
  connectDuringNextSourceUpdate,
  holdConfirmIdentityChange,
  installSourceManagementRpc,
  readHeldConfirmIdentityChangeCount,
  readSourceManagementCall,
  readUpdateInflightEvidence,
  releaseConfirmIdentityChange,
  restoreSourceManagementRpc,
  restoreUpdateInflightProbe,
  startSourceManagementCall,
  waitForSourceManagementRpcReady,
} from "#e2e/helpers/source-server-update-inflight";
import {
  connectSSHWorkspace,
  readSSHRuntimeConfig,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_R3_UPDATE_INFLIGHT";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-update-inflight",
);

async function readRemoteCurrentSha(container: string): Promise<string> {
  const { stdout } = await execInRemoteContainer(container, [
    "sh",
    "-c",
    'cat "$HOME/.zcode/server/current.json"',
  ]);
  return /"archiveSha256":\s*"([0-9a-f]{64})"/u.exec(stdout)?.[1] ?? "";
}

async function readRemoteCurrentShaOrNull(container: string): Promise<string | null> {
  // 远端安装切换 current.json 的瞬间可能读到中间态；轮询里按“尚未完成”处理。
  return readRemoteCurrentSha(container).catch(() => null);
}

async function readWizardButtons() {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
    ).map((button) => ({ text: button.innerText.trim(), disabled: button.disabled })),
  );
}

/** 展开设置页中目标设备行，返回其后台连接卡片文本；没有卡片时返回 null。 */
async function readDeviceBackgroundCard(sourceServerId: string): Promise<string | null> {
  return browser.execute((id) => {
    const row = document.querySelector(`[data-source-server-card="${id}"]`);
    row?.querySelector<HTMLElement>('[data-source-server-toggle][aria-expanded="false"]')?.click();
    return (
      row?.querySelector<HTMLElement>('[data-testid="remote-connection-minimized"]')?.innerText ??
      null
    );
  }, sourceServerId);
}

/** 页面上任何位置的后台连接卡片文本；关闭撤销意图后应为空。 */
async function readAllBackgroundCards(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="remote-connection-minimized"]'),
    ).map((card) => card.innerText),
  );
}

/** 向导全文（含 sr-only 副题），用于判断等待点是否被说成连接失败。 */
async function readDialogText(): Promise<string> {
  return browser.execute(
    () => document.querySelector('[data-testid="ssh-dialog"]')?.textContent ?? "",
  );
}

/** 连接屏把标题区收成 sr-only，副题仍是对话框的 aria 描述；按 aria-describedby 读取。 */
async function readDialogDescription(): Promise<string | null> {
  return browser.execute(() => {
    const dialog = document.querySelector('[data-testid="ssh-dialog"]')?.closest('[role="dialog"]');
    const id = dialog?.getAttribute("aria-describedby");
    return id ? (document.getElementById(id)?.textContent ?? null) : null;
  });
}

async function clickEnabledDialogButton(pattern: RegExp): Promise<boolean> {
  return browser.execute(
    (source, flags) => {
      const matcher = new RegExp(source, flags);
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
      ).find((item) => matcher.test(item.innerText.trim()) && !item.disabled);
      button?.click();
      return Boolean(button);
    },
    pattern.source,
    pattern.flags,
  );
}

async function readStates(): Promise<SourceServerManagementSnapshot["states"]> {
  return (await callSourceManagement<SourceServerManagementSnapshot>("getSnapshot")).states;
}

/** 项目菜单「连接」偶发一次点击无 RPC（R3-UPDATE-INFLIGHT-01 已记录）；20 秒无向导时补点一次。 */
async function openProjectConnectionWizard(identity: string): Promise<number> {
  let clicks = 1;
  let lastClickAt = Date.now();
  await requestRemoteProjectConnection(identity, CASE_MARKER);
  await browser.waitUntil(
    async () => {
      if (await $('[data-testid="ssh-dialog"]').isExisting()) return true;
      if (Date.now() - lastClickAt > 20_000) {
        clicks += 1;
        await requestRemoteProjectConnection(identity, CASE_MARKER);
        lastClickAt = Date.now();
      }
      return false;
    },
    { timeout: 120_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 原项目连接没有打开向导` },
  );
  return clicks;
}

interface InflightContext {
  container: string;
  identity: string;
  sourceServerId: string;
  profileId: string;
  workspacePath: string;
  remoteSessionId: string;
}

describe(`${CASE_MARKER}: 更新进行中的连接不覆盖更新，向导保留原意图`, () => {
  const facts: Record<string, unknown> = { timeline: [] as string[] };
  let context: InflightContext | undefined;
  const requireContext = () => {
    if (!context) throw new Error(`${CASE_MARKER}: 前一个用例没有完成，缺少设备与项目上下文`);
    return context;
  };
  const mark = async (label: string) => {
    (facts.timeline as string[]).push(`${new Date().toISOString()} ${label}`);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "update-inflight.json"), JSON.stringify(facts, null, 2));
  };

  after(async () => {
    facts.finalEvidence = await readUpdateInflightEvidence().catch(() => null);
    await restoreSourceManagementRpc().catch(() => undefined);
    await restoreUpdateInflightProbe().catch(() => undefined);
    await mkdir(artifactDir, { recursive: true });
    await browser.saveScreenshot(resolve(artifactDir, "update-inflight-final.png")).catch(() => {});
    await writeFile(resolve(artifactDir, "update-inflight.json"), JSON.stringify(facts, null, 2));
    await clearAppData();
  });

  it("R3-UPDATE-INFLIGHT-01/02 更新中另一入口连接被拒；返回配置禁用，关闭等同收起，更新后继续原项目", async function () {
    this.timeout(20 * 60_000);
    await waitForDefaultWorkspaceReady(30_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const container = readRemoteDockerContainer(CASE_MARKER);
    const [workspacePath] = config.workspacePaths;
    const tab = await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });
    const identity = tab.workspaceIdentity;
    const sourceServerId = identity
      ? parseRemoteWorkspaceIdentity(identity)?.sourceServerId
      : undefined;
    const profileId = (await readSettings()).connectionProfiles?.find(
      (profile) => profile.sourceServerId === sourceServerId,
    )?.profileId;
    if (!identity || !sourceServerId || !profileId)
      throw new Error(`${CASE_MARKER}: 首连后缺少 Source 身份或线路`);
    const shaBefore = await readRemoteCurrentSha(container);
    // 同版本异 SHA：开发态内容寻址判定需要更新，走与生产版本不兼容相同的向导自动更新链。
    const repack = await prepareSourceServerUpdateArchive(shaBefore, CASE_MARKER);
    expect(repack.newSha).not.toBe(shaBefore);
    facts.before = { tab, profileId, sha: shaBefore, repack };

    await disconnectRemoteSource(sourceServerId, CASE_MARKER, { workspaceIdentities: [identity] });
    await connectDuringNextSourceUpdate({
      sourceServerId,
      profileId,
      target: {
        kind: "ssh",
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        assetInstallMode: "local-download-upload",
      },
    });
    await requestRemoteProjectConnection(identity, CASE_MARKER);
    // 第二次实跑观察到：项目菜单「连接」点击后没有任何 RPC（原因未查明，与本用例无关）。
    // 20 秒内没有打开向导时按用户行为再点一次，并记录次数，不把它算作本用例的通过条件。
    let projectConnectClicks = 1;
    let lastProjectConnectAt = Date.now();
    await browser.waitUntil(
      async () => {
        if ((await readUpdateInflightEvidence()).updatingSeen) return true;
        if (
          Date.now() - lastProjectConnectAt > 20_000 &&
          !(await $('[data-testid="ssh-dialog"]').isExisting())
        ) {
          projectConnectClicks += 1;
          await requestRemoteProjectConnection(identity, CASE_MARKER);
          lastProjectConnectAt = Date.now();
        }
        return false;
      },
      {
        timeout: 180_000,
        interval: 200,
        timeoutMsg: `${CASE_MARKER}: 原项目连接没有触发向导自动更新`,
      },
    );
    facts.projectConnectClicks = projectConnectClicks;
    await mark("update-started");

    // R3-UPDATE-INFLIGHT-02：更新在途时返回配置不可用，关闭只收起。
    const buttonsDuringUpdate = await readWizardButtons();
    facts.buttonsDuringUpdate = buttonsDuringUpdate;
    const back = buttonsDuringUpdate.find((button) =>
      /^(返回配置|Back to configuration)$/u.test(button.text),
    );
    expect(back).toBeDefined();
    expect(back?.disabled).toBe(true);
    const closed = await browser.execute(() => {
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
      ).find((item) => /^(关闭|Close)$/u.test(item.innerText.trim()) && !item.disabled);
      button?.click();
      return Boolean(button);
    });
    expect(closed).toBe(true);
    await $('[data-testid="ssh-dialog"]').waitForExist({
      reverse: true,
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 更新中关闭后对话框仍在`,
    });
    // 后台卡片只在设置页的设备行里展示；卡片存在说明流程被收起而不是被关闭撤销。
    await openRemoteDevicesSettings();
    await browser.waitUntil(() => readDeviceBackgroundCard(sourceServerId).then(Boolean), {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 更新中关闭没有收起为后台连接`,
    });
    facts.backgroundCardDuringUpdate = await readDeviceBackgroundCard(sourceServerId);
    // 更新进行中的卡片按进行中展示，不能沿用触发更新的“需升级”错误显示连接失败。
    expect(facts.backgroundCardDuringUpdate).toMatch(/正在连接|Connecting/u);
    expect(facts.backgroundCardDuringUpdate).not.toMatch(/失败|failed/iu);
    await mark("closed-as-minimized");

    // R3-UPDATE-INFLIGHT-01：并发连接被拒，更新日志未被替换，此时更新尚未完成。
    await browser.waitUntil(
      async () => Boolean((await readUpdateInflightEvidence()).operationLogs),
      {
        timeout: 60_000,
        timeoutMsg: `${CASE_MARKER}: 并发连接没有返回或日志读取没有完成`,
      },
    );
    const duringUpdate = await readUpdateInflightEvidence();
    facts.duringUpdate = {
      connectResult: duringUpdate.connectResult,
      operationLogs: duringUpdate.operationLogs,
    };
    expect(duringUpdate.connectResult).toMatchObject({
      success: false,
      reasonCode: "source-server-update-in-progress",
    });
    expect(duringUpdate.operationLogs?.length).toBeGreaterThan(0);
    expect(duringUpdate.operationLogs?.every((entry) => entry.operation === "update")).toBe(true);
    expect(duringUpdate.operationLogs?.some((entry) => entry.phase === "ready")).toBe(false);
    await mark("concurrent-connect-rejected");

    await browser.waitUntil(
      async () => (await readRemoteCurrentShaOrNull(container)) === repack.newSha,
      {
        timeout: 600_000,
        interval: 2000,
        timeoutMsg: `${CASE_MARKER}: 更新没有切换到新 release`,
      },
    );
    await mark("sha-switched");

    // 收起保留原意图：更新后的连接在后台完成，用户继续时打开原项目。
    await browser.waitUntil(
      async () => {
        const text = await readDeviceBackgroundCard(sourceServerId);
        if (!text || !/(连接已完成|Connection complete)/u.test(text)) return false;
        return browser.execute((id) => {
          const card = document.querySelector<HTMLButtonElement>(
            `[data-source-server-card="${id}"] [data-testid="remote-connection-minimized"]`,
          );
          card?.click();
          return Boolean(card);
        }, sourceServerId);
      },
      { timeout: 240_000, interval: 1000, timeoutMsg: `${CASE_MARKER}: 更新后没有后台完成提示` },
    );
    const reconnected = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: identity,
      expectedPath: workspacePath,
      requireActive: false,
      timeoutMs: 180_000,
    });
    expect(reconnected.remoteSessionId).toBeTruthy();
    expect(reconnected.remoteSessionId).not.toBe(tab.remoteSessionId);
    facts.reconnected = reconnected;

    const finalEvidence = await readUpdateInflightEvidence();
    const states = finalEvidence.states.filter((state) => state.profileId === profileId);
    facts.states = states;
    const firstUpdating = states.findIndex((state) => state.state === "updating");
    expect(firstUpdating).toBeGreaterThanOrEqual(0);
    expect(states.slice(firstUpdating).some((state) => state.state === "needs-upgrade")).toBe(
      false,
    );
    await mark("original-intent-continued");
    context = {
      container,
      identity,
      sourceServerId,
      profileId,
      workspacePath,
      remoteSessionId: reconnected.remoteSessionId!,
    };
  });

  it("R3-UPDATE-INFLIGHT-03 其他入口发起的更新进行中，原项目连接显示等待点，收起后卡片不显示失败", async function () {
    this.timeout(20 * 60_000);
    const current = requireContext();
    const { container, identity, sourceServerId, profileId, workspacePath } = current;
    const shaBefore = await readRemoteCurrentSha(container);
    const repack = await prepareSourceServerUpdateArchive(shaBefore, `${CASE_MARKER}_03`);
    expect(repack.newSha).not.toBe(shaBefore);
    await installSourceManagementRpc();
    await disconnectRemoteSource(sourceServerId, CASE_MARKER, { workspaceIdentities: [identity] });
    await waitForSourceManagementRpcReady(CASE_MARKER);

    // 模拟设置页「更新」、更新提示或另一窗口发起的更新：它不归向导所有，向导只能等它完成。
    const updateKey = await startSourceManagementCall("updateSource", [{ profileId }]);
    await browser.waitUntil(
      async () =>
        (await readStates()).some(
          (state) => state.profileId === profileId && state.state === "updating",
        ),
      { timeout: 60_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 向导以外的更新没有开始` },
    );
    await mark("03-update-started");

    facts.projectConnectClicks03 = await openProjectConnectionWizard(identity);
    await browser.waitUntil(
      async () =>
        /远程设备正在更新远端服务|The remote device is updating its remote service/u.test(
          await readDialogText(),
        ),
      { timeout: 60_000, timeoutMsg: `${CASE_MARKER}: 向导没有显示“远端服务正在更新”等待点` },
    );
    facts.waitingDialog03 = await readDialogText();
    const waitingDescription = await readDialogDescription();
    facts.waitingDescription03 = waitingDescription;
    const waitingButtons = await readWizardButtons();
    facts.waitingButtons03 = waitingButtons;
    expect(
      waitingButtons.some((button) => /^(重试|Retry)$/u.test(button.text) && !button.disabled),
    ).toBe(true);

    expect(await clickEnabledDialogButton(/^(在后台继续|Continue in background)$/u)).toBe(true);
    await $('[data-testid="ssh-dialog"]').waitForExist({
      reverse: true,
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 等待点收起后对话框仍在`,
    });
    await openRemoteDevicesSettings();
    await browser.waitUntil(() => readDeviceBackgroundCard(sourceServerId).then(Boolean), {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 等待点收起后没有后台卡片`,
    });
    const waitingCard = await readDeviceBackgroundCard(sourceServerId);
    facts.backgroundCard03 = waitingCard;
    await mark("03-minimized-waiting");
    // 等待点不是连接失败：副题与连接屏一致显示“正在更新远端服务”，收起后的卡片也不显示失败。
    // 两处现象先记录到工件再断言，修复前的证据不会因第一处失败而缺失。
    expect(waitingDescription).toMatch(/^(正在更新远端服务|Updating the remote server)$/u);
    expect(waitingCard).not.toMatch(/失败|failed/iu);
    expect(waitingCard).toMatch(/等待确认或补充信息|Waiting for confirmation or information/u);

    await browser.waitUntil(async () => Boolean(await readSourceManagementCall(updateKey)), {
      timeout: 600_000,
      interval: 2000,
      timeoutMsg: `${CASE_MARKER}: 向导以外的更新没有完成`,
    });
    const updateResult = await readSourceManagementCall(updateKey);
    facts.update03 = updateResult?.ok ? "ok" : updateResult;
    expect(updateResult?.ok).toBe(true);
    expect(await readRemoteCurrentSha(container)).toBe(repack.newSha);
    await mark("03-update-finished");

    // 更新完成后用户恢复卡片并重试，原项目意图仍由这个向导完成。
    const resumed = await browser.execute((id) => {
      const card = document.querySelector<HTMLButtonElement>(
        `[data-source-server-card="${id}"] [data-testid="remote-connection-minimized"]`,
      );
      card?.click();
      return Boolean(card);
    }, sourceServerId);
    expect(resumed).toBe(true);
    await browser.waitUntil(() => clickEnabledDialogButton(/^(重试|Retry)$/u), {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 恢复后的向导没有可用的重试`,
    });
    const reconnected = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: identity,
      expectedPath: workspacePath,
      requireActive: false,
      timeoutMs: 180_000,
    });
    expect(reconnected.remoteSessionId).toBeTruthy();
    expect(reconnected.remoteSessionId).not.toBe(current.remoteSessionId);
    current.remoteSessionId = reconnected.remoteSessionId!;
    await mark("03-original-intent-continued");
  });

  it("R3-UPDATE-INFLIGHT-04 确认设备身份进行中关闭向导仍撤销意图，不收起", async function () {
    this.timeout(10 * 60_000);
    const { container, identity, sourceServerId } = requireContext();
    await disconnectRemoteSource(sourceServerId, CASE_MARKER, { workspaceIdentities: [identity] });
    // 远端换一个安装身份：停止 daemon 并改写 installationId，下一次握手得到新的 sourceServerId。
    const rewrite = await execInRemoteContainer(container, [
      "sh",
      "-c",
      'set -e; R="$HOME/.zcode/server"; ' +
        '"$R/bin/zcode" stop --wait --server-root "$R" --json >/dev/null 2>&1 || true; ' +
        "NEW=$(cat /proc/sys/kernel/random/uuid); " +
        'sed -i -E "s/(\\"installationId\\"[[:space:]]*:[[:space:]]*\\")[0-9a-f-]{36}/\\1$NEW/" "$R/install.json"; ' +
        'grep -q "$NEW" "$R/install.json"; echo "$NEW"',
    ]);
    facts.rewrittenInstallationId04 = rewrite.stdout.trim();
    await installSourceManagementRpc();
    await holdConfirmIdentityChange();

    facts.projectConnectClicks04 = await openProjectConnectionWizard(identity);
    await browser.waitUntil(
      () => clickEnabledDialogButton(/^(作为新设备使用|Use as a new device)$/u),
      { timeout: 120_000, interval: 500, timeoutMsg: `${CASE_MARKER}: 向导没有出现身份确认` },
    );
    await browser.waitUntil(async () => (await readHeldConfirmIdentityChangeCount()) > 0, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 身份确认请求没有发出`,
    });
    // 主按钮换成进行中的“取消连接”说明 React 已按确认中重新渲染；此后点关闭才测到真实的确认中状态。
    await browser.waitUntil(
      async () =>
        !(await readWizardButtons()).some((button) =>
          /^(作为新设备使用|Use as a new device)$/u.test(button.text),
        ),
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 向导没有进入确认中状态` },
    );
    facts.buttonsDuringIdentityConfirm04 = await readWizardButtons();
    expect(await clickEnabledDialogButton(/^(关闭|Close)$/u)).toBe(true);
    await $('[data-testid="ssh-dialog"]').waitForExist({
      reverse: true,
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 确认身份中关闭后对话框仍在`,
    });
    await openRemoteDevicesSettings();
    // 第一次调用只负责展开设备行；展开后的进度块在下一次渲染才出现。
    await readDeviceBackgroundCard(sourceServerId);
    await browser.pause(1000);
    facts.cardsAfterClose04 = await readAllBackgroundCards();
    expect(facts.cardsAfterClose04).toEqual([]);
    await mark("04-closed-during-identity-confirm");

    // 放行迟到的确认：Host 照常把线路改绑到新设备并上线，向导不能借此恢复已撤销的意图。
    await releaseConfirmIdentityChange();
    await browser.waitUntil(
      async () =>
        (await readStates()).some(
          (state) =>
            state.state === "online" &&
            state.sourceServerId !== undefined &&
            state.sourceServerId !== sourceServerId,
        ),
      { timeout: 120_000, interval: 1000, timeoutMsg: `${CASE_MARKER}: 迟到的身份确认没有完成` },
    );
    await mark("04-identity-confirm-settled");
    await browser.pause(8000);
    facts.cardsAfterConfirm04 = await readAllBackgroundCards();
    expect(facts.cardsAfterConfirm04).toEqual([]);
    expect(await $('[data-testid="ssh-dialog"]').isExisting()).toBe(false);
    await mark("04-intent-stayed-cancelled");
  });
});
