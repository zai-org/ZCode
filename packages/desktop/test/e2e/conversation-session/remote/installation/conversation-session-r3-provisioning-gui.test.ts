import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";
import {
  openSSHSourceDirectory,
  waitForSSHDirectoryStep,
  selectSSHRemoteDirectory,
} from "#e2e/helpers/ssh-remote-p0";
import {
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "#e2e/helpers/remote-project-actions";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  parseProvisioningSyncEvents,
  type ProvisioningSyncEvent,
} from "#e2e/helpers/provisioning-sync-evidence";
import { createHeldResponseProxy } from "#e2e/helpers/ssh-held-response-proxy";
import {
  parseRemoteWorkspaceIdentity,
  providerProvisioningResultSchema,
  type AppSettings,
} from "@zcode/shared";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  getE2EAppDataPaths,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  readSettings,
} from "#e2e/helpers/desktop-app";
import {
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import { createCustomOpenAIChatCompletionsProvider } from "#e2e/helpers/custom-openai-provider";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "#e2e/helpers/upstream-provider";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  readRemoteCoreIdentity,
  readTaskRowInProject,
  sendSSHFollowTurn,
  SSH_LIFECYCLE_MODEL_ID,
  SSH_LIFECYCLE_THOUGHT_LEVEL,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "#e2e/helpers/ssh-remote-lifecycle";
import {
  getV4ModelConfig,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ComposerSelectionReady,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";
import {
  readHostProcesses,
  readRemoteTabSnapshot,
  runSSHCommand,
  waitForRemoteTab,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { sel } from "#e2e/helpers/selectors";

const CASE_MARKER = "E2E_R3_PROVISIONING_GUI";
// fixture r3-provisioning-gui-reconnect-main 的回复正文不带 E2E_ 前缀，与 lifecycle helper 的 replyMarker 约定一致。
const CASE_REPLY = "R3_PROVISIONING_GUI_REPLY";
// 未知自定义模型只继承 Built-in 兜底的 disabled 档位；产品要求切模后显式选择，未选时发送键禁用。
const B05_THOUGHT_LEVEL = "disabled";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-provisioning-gui",
);
const REMOTE_SYNC_TIMEOUT_MS = 90_000;

async function readRemotePersonalConfig(config: SSHConnectionConfig): Promise<string> {
  const result = await runSSHCommand(config, 'cat "$HOME/.zcode/v2/provider_config.json"');
  return result.code === 0 ? result.stdout : "";
}

async function waitForRemotePersonalConfig(
  config: SSHConnectionConfig,
  predicate: (text: string) => boolean,
  description: string,
  timeout = REMOTE_SYNC_TIMEOUT_MS,
): Promise<string> {
  let latest = "";
  await browser.waitUntil(
    async () => {
      latest = await readRemotePersonalConfig(config);
      return predicate(latest);
    },
    {
      timeout,
      interval: 1000,
      timeoutMsg: `${CASE_MARKER}: 远端 Personal 配置未满足: ${description}`,
    },
  );
  return latest;
}

async function openModelProviderSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15_000, timeoutMsg: "没有设置入口" });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有模型供应商分区",
  });
}

async function deleteProviderThroughSettings(providerName: string): Promise<void> {
  await openModelProviderSettings();
  // 选中该 provider 的导航项，再经卡片头部“更多”菜单里的“删除”打开确认框并确认。
  await browser.waitUntil(
    () =>
      browser.execute((name) => {
        const nav = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (element) =>
            (element.dataset.testid ?? "").startsWith("model-provider-nav-item") &&
            element.innerText.includes(name),
        );
        if (!nav) return false;
        nav.click();
        return true;
      }, providerName),
    { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 设置页没有 provider ${providerName}` },
  );
  // Bug 根因：Todo115（8d16f98136）把卡片头部独立的垃圾桶按钮收进“更多”下拉菜单，
  // 删除项是菜单展开后才渲染的 role=menuitem。旧写法按可见的垃圾桶 <button> 兜底定位，
  // 改版后只会匹到模型行的“删除”按钮，那条路径直接删 Personal Model、不弹确认，于是
  // 本用例等不到确认框，还顺带删掉了刚建 provider 的模型。这里与 settings-ui-polish
  // 使用同一入口；Radix 菜单 trigger 依赖 pointerdown，必须走真实 WebDriver 点击。
  await clickTestIdByWebDriver("model-provider-actions-button", {
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: provider ${providerName} 没有“更多”操作菜单`,
  });
  const deleteItem = $('[role="menuitem"]:has(svg.lucide-trash-2)');
  await deleteItem.waitForDisplayed({
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: “更多”菜单里没有删除项`,
  });
  await deleteItem.click();
  await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
    timeout: 20_000,
    timeoutMsg: `${CASE_MARKER}: 删除 provider 没有出现确认`,
  });
  await browser.waitUntil(
    // 删除后的提示仍可能带 Provider 名称；只检查供应商导航，远端删除另有文件对账。
    () =>
      browser.execute(
        (name) =>
          !Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid^="model-provider-nav-item"]'),
          ).some((element) => element.innerText.includes(name)),
        providerName,
      ),
    { timeout: 20_000, timeoutMsg: `${CASE_MARKER}: provider ${providerName} 删除后仍在设置页` },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000, timeoutMsg: "设置页无返回" });
}

async function readSyncEvents(directory: string): Promise<ProvisioningSyncEvent[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".log")).sort();
  const contents = await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")));
  return contents.flatMap(parseProvisioningSyncEvents);
}

async function assertManagementAvailableBeforeHold(sourceId: string): Promise<void> {
  const source = (await readSettings()).sourceServers?.find(
    (item) => item.sourceServerId === sourceId,
  );
  if (!source) throw new Error(`${CASE_MARKER}: 故障前没有已保存 Source`);
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15_000 });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"), { timeout: 15_000 });
  // RDUX-13：断开在设备行「更多」菜单里；按 sourceServerId 打开菜单确认入口可用。
  const trigger = $(
    `[data-source-server-card="${sourceId}"] [data-device-row-actions] button[aria-haspopup="menu"]`,
  );
  await browser.waitUntil(
    async () => {
      await trigger.click();
      const available = await browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')).some(
          (item) =>
            !item.hasAttribute("data-disabled") &&
            /^(断开|Disconnect)/u.test(item.textContent?.trim() ?? ""),
        ),
      );
      await browser.keys("Escape");
      return available;
    },
    {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `${CASE_MARKER}: 健康链路下设备管理也没有断开入口`,
    },
  );
  await mkdir(artifactDir, { recursive: true });
  await browser.saveScreenshot(resolve(artifactDir, "management-before-hold.png"));
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
}

async function readAppliedSyncCount(config: SSHConnectionConfig): Promise<number> {
  const result = await runSSHCommand(
    config,
    'cat "$HOME/.zcode/v2/runtime/provider/provisioning.json"',
  );
  expect(result.code).toBe(0);
  const journal = JSON.parse(result.stdout) as {
    records?: Array<{ syncId: string; result: unknown }>;
  };
  if (!Array.isArray(journal.records))
    throw new Error(`${CASE_MARKER}: 缺少真实 Provisioning journal`);
  return journal.records.filter((record) => {
    const value = providerProvisioningResultSchema.parse(record.result);
    expect(value.syncId).toBe(record.syncId);
    return value.status === "applied";
  }).length;
}

async function assertConnectedSyncFailureRecovery(options: {
  config: SSHConnectionConfig;
  desktopTarget: SSHConnectionConfig;
  task: SSHLifecycleTask;
  sibling: { identity: string; workspacePath: string; remoteSessionId: string };
  provider: SSHLifecycleProvider;
  facts: Record<string, unknown>;
}): Promise<void> {
  const { config, desktopTarget, task, sibling, provider, facts } = options;
  const directory = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
  if (!directory) throw new Error(`${CASE_MARKER}: 缺少本次 Main 日志目录`);
  const beforeEvents = await readSyncEvents(directory);
  const keys = [...new Set(beforeEvents.map((event) => event.environmentKey))];
  expect(keys).toHaveLength(1);
  expect(beforeEvents.some((event) => event.kind === "completed")).toBe(true);
  const environmentKey = keys[0]!;
  const readNewEvents = async () =>
    (await readSyncEvents(directory))
      .slice(beforeEvents.length)
      .filter((event) => event.environmentKey === environmentKey);
  const beforeConfig = await readRemotePersonalConfig(config);
  expect(beforeConfig).toContain(provider.name);
  const core = await readRemoteCoreIdentity(config, CASE_MARKER);
  const owner = await runSSHCommand(
    config,
    `test "$(id -u)" -ne 0 && test "$(id -u)" = "$(stat -c %u /proc/${core.pid})"`,
  );
  expect(owner.code).toBe(0);
  const mode = await runSSHCommand(config, 'stat -c %a "$HOME/.zcode/v2"');
  expect(mode.code).toBe(0);
  const originalMode = mode.stdout.trim();
  expect(originalMode).toMatch(/^[0-7]{3,4}$/u);
  facts.connectedSyncFaultSetup = { originalMode, corePid: core.pid, environmentKey };
  const failedName = `R3 Failed Sync ${Date.now()}`;
  let warningCount = 0;
  try {
    // 只在本 case 的 Source 配置目录制造真实写入失败；子目录和配置读取仍可用。
    // 修改文件本身的 mode 不足以阻止同目录原子 rename，因此控制父目录写权限。
    const denied = await runSSHCommand(
      config,
      'set -eu; d="$HOME/.zcode/v2"; test ! -e "$d/.r3-write-denial-probe"; chmod 0555 "$d"; if touch "$d/.r3-write-denial-probe" 2>/dev/null; then rm "$d/.r3-write-denial-probe"; exit 74; fi; printf WRITE_DENIED',
    );
    expect(denied.code).toBe(0);
    expect(denied.stdout.trim()).toBe("WRITE_DENIED");
    facts.connectedSyncWriteDenied = true;
    await browser.execute((name) => {
      const view = window as Window & {
        __r3ProvisioningFeedback?: { observer: MutationObserver; states: string[] };
      };
      const states: string[] = [];
      const capture = () => {
        for (const element of document.querySelectorAll<HTMLElement>(
          "[data-provider-detail-feedback-state]",
        )) {
          if (!element.textContent?.includes(name)) continue;
          const state = element.dataset.providerDetailFeedbackState;
          if (state && !states.includes(state)) states.push(state);
        }
      };
      const observer = new MutationObserver(capture);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-provider-detail-feedback-state"],
        characterData: true,
      });
      view.__r3ProvisioningFeedback = { observer, states };
      capture();
    }, failedName);
    const failedProvider = await createCustomOpenAIChatCompletionsProvider({
      baseURL: provider.tunnel.baseURL,
      modelId: "r3-failed-sync-model",
      providerName: failedName,
    });
    expect(await readFile(getE2EAppDataPaths().configFile, "utf8")).toContain(failedName);
    facts.connectedSyncLocalSaveCompleted = true;
    await browser.waitUntil(
      async () =>
        (await readNewEvents()).some(
          (event) =>
            event.kind === "warning" &&
            event.trigger === "personal-config" &&
            event.status === "failed",
        ),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 真实写入失败后没有结构化同步 warning` },
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            (
              window as Window & { __r3ProvisioningFeedback?: { states: string[] } }
            ).__r3ProvisioningFeedback?.states.includes("success") ?? false,
        ),
      {
        timeout: 15_000,
        timeoutMsg: `${CASE_MARKER}: 远端同步失败时，本机没有给出真实保存成功反馈`,
      },
    );
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "同步失败后本机保存未返回设置页",
    });
    expect(await readRemotePersonalConfig(config)).toBe(beforeConfig);
    expect((await readRemoteTabSnapshot(task.identity)).remoteSessionId).toBe(task.remoteSessionId);
    expect((await readRemoteTabSnapshot(sibling.identity)).remoteSessionId).toBe(
      sibling.remoteSessionId,
    );
    const saved: Partial<AppSettings> = JSON.parse(
      await readFile(join(getE2EAppDataPaths().appDataDir, "setting.json"), "utf8"),
    );
    const savedConnections = saved.lastWorkspaceSession ?? [];
    facts.connectionPersistenceDuringFailure = savedConnections.flatMap((entry) =>
      entry.kind === "remote"
        ? [
            {
              workspacePath: entry.workspacePath,
              diskIdentity: entry.workspaceIdentity,
              lastConnectionStatus: entry.lastConnectionStatus,
            },
          ]
        : [],
    );
    // 磁盘为兼容旧桌面会改写成 legacy identity；先由 canonical 历史证明归属，再按线路和路径找落盘条目。
    for (const expected of [
      { identity: task.identity, workspacePath: task.workspacePath },
      sibling,
    ]) {
      const sourceId = parseRemoteWorkspaceIdentity(expected.identity)?.sourceServerId;
      const history = saved.sourceServerWorkspaceHistory?.find(
        (item) =>
          item.workspaceIdentity === expected.identity &&
          item.workspacePath === expected.workspacePath,
      );
      expect(sourceId).toBeTruthy();
      expect(history?.sourceServerId).toBe(sourceId);
      const entry = savedConnections.find(
        (item) =>
          item.kind === "remote" &&
          item.workspacePath === expected.workspacePath &&
          item.target.kind === "ssh" &&
          item.target.host === desktopTarget.host &&
          item.target.port === desktopTarget.port &&
          item.target.username === desktopTarget.username,
      );
      if (entry?.kind !== "remote") throw new Error(`${CASE_MARKER}: 同步失败后远程条目丢失`);
      expect(entry.lastConnectionStatus).toBe("connected");
    }
    // GUI 新建 provider 和模型会产生多次合法保存；等这一组事件收口后再检查无定时重试。
    let previousCount = -1;
    let lastChangeAt = Date.now();
    await browser.waitUntil(
      async () => {
        const events = await readNewEvents();
        if (events.length !== previousCount) {
          previousCount = events.length;
          lastChangeAt = Date.now();
        }
        return events.length > 0 && Date.now() - lastChangeAt >= 3_000;
      },
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: `${CASE_MARKER}: 保存完成后同步失败事件没有收口`,
      },
    );
    const settled = await readNewEvents();
    facts.connectedSyncWarningsObserved = settled;
    expect(settled.every((event) => event.kind === "warning" && event.status === "failed")).toBe(
      true,
    );
    warningCount = settled.length;
    await browser.pause(10_000);
    expect(await readNewEvents()).toEqual(settled);
    const feedbackStates = await browser.execute(
      () =>
        (window as Window & { __r3ProvisioningFeedback?: { states: string[] } })
          .__r3ProvisioningFeedback?.states ?? [],
    );
    expect(feedbackStates).toContain("success");
    expect(feedbackStates).not.toContain("failure");
    facts.connectedSyncFailure = {
      localProviderSaved: failedProvider.id,
      warningCount,
      warnings: settled,
      remoteConfigUnchanged: true,
      originalSessionsRetained: true,
      localFeedbackStates: feedbackStates,
      noRetryObservationMs: 10_000,
    };
  } finally {
    await browser
      .execute(() => {
        const view = window as Window & {
          __r3ProvisioningFeedback?: { observer: MutationObserver };
        };
        view.__r3ProvisioningFeedback?.observer.disconnect();
        delete view.__r3ProvisioningFeedback;
      })
      .catch(() => undefined);
    const restored = await runSSHCommand(config, `chmod ${originalMode} "$HOME/.zcode/v2"`);
    expect(restored.code).toBe(0);
  }

  // 恢复磁盘写能力后先验证旧配置上的任务可继续，尚不触发新的 Provider 保存。
  // 不把配置目录写故障期间的其它持久化限制误判为连接生命周期回归。
  expect(await readRemotePersonalConfig(config)).toBe(beforeConfig);
  await sendSSHFollowTurn(task, CASE_MARKER);
  expect(await readRemotePersonalConfig(config)).toBe(beforeConfig);
  facts.existingTaskWorksBeforeResave = true;
  const beforeRecoverySave = (await readSyncEvents(directory)).length;
  const repairedName = `R3 Recovered Sync ${Date.now()}`;
  await createCustomOpenAIChatCompletionsProvider({
    baseURL: provider.tunnel.baseURL,
    modelId: "r3-recovered-sync-model",
    providerName: repairedName,
  });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "修复后保存未返回设置页",
  });
  await waitForRemotePersonalConfig(
    config,
    (text) => text.includes(failedName) && text.includes(repairedName),
    "修复写权限后，新保存下发包含此前失败编辑的最新完整快照",
  );
  await browser.waitUntil(
    async () =>
      (await readSyncEvents(directory))
        .slice(beforeRecoverySave)
        .some(
          (event) =>
            event.environmentKey === environmentKey &&
            event.kind === "completed" &&
            event.trigger === "personal-config" &&
            event.status === "applied",
        ),
    { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 修复后再次保存没有真实同步完成记录` },
  );
  expect((await readRemoteTabSnapshot(task.identity)).remoteSessionId).toBe(task.remoteSessionId);
  expect((await readRemoteTabSnapshot(sibling.identity)).remoteSessionId).toBe(
    sibling.remoteSessionId,
  );
  expect((await readNewEvents()).filter((event) => event.kind === "warning")).toHaveLength(
    warningCount,
  );
  await sendSSHFollowTurn(task, CASE_MARKER);
  const afterCore = await readRemoteCoreIdentity(config, CASE_MARKER);
  expect(afterCore.pid).toBe(core.pid);
  expect(afterCore.startTicks).toBe(core.startTicks);
  facts.connectedSyncRecovery = {
    bothEditsApplied: true,
    sameSessions: true,
    sameCore: true,
    nextTurnCompleted: true,
  };
}

describe(`${CASE_MARKER}: 本地 Provider 保存/删除/断线期间修改经 Provisioning 到达 SSH 目标`, () => {
  let provider: SSHLifecycleProvider | null = null;
  let proxy: Awaited<ReturnType<typeof createHeldResponseProxy>> | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "provisioning-gui.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await proxy?.close().catch(() => undefined);
    proxy = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-PRV-04/05/12/13 保存删除真实同步、旧 RPC 未返回时断开、失败只告警并可再次保存恢复", async function () {
    this.timeout(30 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    // 模型回放隧道与控制探针仍走直连；只扣住 Desktop 产品链路上的旧同步 RPC 回包。
    proxy = await createHeldResponseProxy(prepared.config);
    const desktopConfig = { ...prepared.config, host: "127.0.0.1", port: proxy.port };
    const [workspaceA] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: desktopConfig,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const workspaceB = prepared.config.workspacePaths[1];
    await openSSHSourceDirectory(desktopConfig, CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(workspaceB, CASE_MARKER);
    const initialB = await waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: workspaceB });
    const initial = await waitForRemotePersonalConfig(
      prepared.config,
      (text) => text.includes(provider!.name),
      "首连后含 lifecycle provider",
    );
    facts.initialContainsSeeded = initial.includes(provider.name);

    // PRV-04：在线时经设置页真实保存一个新 provider，保存成功即触发同步。
    const onlineName = `R3 Online Save ${Date.now()}`;
    const online = await createCustomOpenAIChatCompletionsProvider({
      baseURL: provider.tunnel.baseURL,
      modelId: "r3-online-model",
      providerName: onlineName,
    });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "设置页无返回",
    });
    const syncedOnline = await waitForRemotePersonalConfig(
      prepared.config,
      (text) => text.includes(onlineName),
      "在线保存的 provider 到达远端",
    );
    facts.onlineSave = {
      providerId: online.id,
      remoteContainsLabel: syncedOnline.includes(onlineName),
    };
    expect(syncedOnline).toContain(provider.name);

    // B-05 回归：Provider 同步发生在已有 Agent 存活期间；下一条新 Provider 请求必须
    // 先让该存量 Worker 刷新自己的 Registry，不能在后台 turn 阶段静默丢输入。
    // 测试缺陷：先在 A 的 Composer 切模再新建草稿，会把 A 的续发选择改成随后删除的
    // Provider，重连成功后续发也会被正确禁用。先新建 B-05 草稿，保留 A 的原始选择。
    await startDraftFromProject(workspaceB, { workspaceIdentity: initialB.workspaceIdentity! });
    await selectUpstreamProviderModelById("r3-online-model", {
      includePlainModelFallback: false,
      providerId: online.id,
      providerName: onlineName,
    });
    // 修复原因：切换模型会清除 thought（useDraftConfigControl），reasoningLevel 缺失时
    // submissionReady=false、发送键保持禁用，sendV4Prompt 会在等待发送键处超时。
    await selectUpstreamThoughtLevelValue(B05_THOUGHT_LEVEL);
    const b05Marker = `${CASE_MARKER}_STALE_WORKER`;
    const b05Query = {
      lastUserMessageIncludes: [b05Marker],
      excludes: ["CRITICAL: Respond with TEXT ONLY"],
    };
    const b05RequestStart = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${b05Marker}: 只回复 ${CASE_REPLY}`,
      b05Marker,
      `${CASE_MARKER}: 存量 Agent 刷新 Registry 后首发没有被接受`,
    );
    await waitForUpstreamRequest(
      b05Query,
      `${CASE_MARKER}: 新 Provider 请求没有到达回放服务`,
      120_000,
      { afterIndex: b05RequestStart - 1 },
    );
    await waitForV4AssistantMessageContaining(CASE_REPLY, 120_000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      `${CASE_MARKER}: B-05 回归 turn 没有回到 idle`,
      120_000,
    );
    await browser.waitUntil(
      async () => {
        const requests = await getUpstreamRequestEvidence(b05Query, {
          afterIndex: b05RequestStart - 1,
        });
        return (
          requests.length === 1 &&
          requests[0]!.status === "complete" &&
          requests[0]!.statusCode === 200
        );
      },
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 新 Provider 首发不是一次完整成功的模型请求` },
    );
    const b05Requests = await getUpstreamRequestEvidence(b05Query, {
      afterIndex: b05RequestStart - 1,
    });
    expect(b05Requests).toHaveLength(1);
    expect(b05Requests[0]!.requestJson).toMatchObject({ model: "r3-online-model" });
    facts.b05ExistingAgentRefresh = {
      accepted: true,
      marker: b05Marker,
      actualRequestModel: "r3-online-model",
    };

    // PRV-12 与后面的 transport hold 独立；先验证写失败后的告警与真实再保存恢复。
    // 已发现设备管理冷加载会等待远端统计，保留后续 PRV-13 的失败而不绕过其 UI。
    await readTaskRowInProject(taskA, CASE_MARKER);
    await selectV4TaskById(taskA.taskId, 30_000);
    await waitForV4ComposerSelectionReady();
    expect(await getV4ModelConfig()).toMatchObject({
      provider: provider.id,
      model: SSH_LIFECYCLE_MODEL_ID,
    });
    await assertConnectedSyncFailureRecovery({
      config: prepared.config,
      desktopTarget: desktopConfig,
      task: taskA,
      sibling: {
        identity: initialB.workspaceIdentity!,
        workspacePath: workspaceB,
        remoteSessionId: initialB.remoteSessionId!,
      },
      provider,
      facts,
    });
    const sourceId = parseRemoteWorkspaceIdentity(taskA.identity)?.sourceServerId;
    if (!sourceId) throw new Error(`${CASE_MARKER}: 缺少稳定 Source 身份`);
    await assertManagementAvailableBeforeHold(sourceId);
    facts.managementAvailableBeforeHold = true;

    // 先对账先前已提交的同步全部收口，避免把旧成功日志误当成本次被扣留的 RPC 返回。
    const logDirectory = await browser.electron.execute(
      () => process.env.ZCODE_E2E_RUNTIME_LOG_DIR,
    );
    if (!logDirectory) throw new Error(`${CASE_MARKER}: 缺少本次 Main 日志目录`);
    await browser.waitUntil(
      async () => {
        const applied = await readAppliedSyncCount(prepared.config);
        return (
          applied > 0 &&
          (await readSyncEvents(logDirectory)).filter((event) => event.status === "applied")
            .length === applied
        );
      },
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 既有 Provisioning RPC 未全部收口` },
    );
    const beforeHeldSync = (await readSyncEvents(logDirectory)).length;
    expect(proxy.holdCurrent()).toBeGreaterThan(0);
    const holdStartedAt = Date.now();
    // PRV-05/13：删除在 Source 上真实提交，但先扣留 RPC 回包，再显式断开。
    await deleteProviderThroughSettings(onlineName);
    const afterDelete = await waitForRemotePersonalConfig(
      prepared.config,
      (text) => !text.includes(onlineName) && text.includes(provider!.name),
      "删除后远端不再含该 provider 且保留其它 provider",
    );
    facts.deletePropagated = !afterDelete.includes(onlineName);
    await browser.waitUntil(() => proxy!.stats().heldBytes + proxy!.stats().retiredBytes > 0, {
      timeout: 10_000,
      timeoutMsg: `${CASE_MARKER}: 配置已提交但代理没有扣住真实回包`,
    });
    const afterHeldSync = (await readSyncEvents(logDirectory)).length;
    facts.oldSyncHoldObservation = {
      beforeMainResults: beforeHeldSync,
      afterMainResults: afterHeldSync,
      proxy: proxy.stats(),
    };
    expect(afterHeldSync).toBe(beforeHeldSync);
    expect((await readRemoteTabSnapshot(taskA.identity)).remoteSessionId).toBe(
      taskA.remoteSessionId,
    );
    facts.oldSyncHeldAfterRemoteCommit = proxy.stats();

    // PRV-13：远端文件已变不代表同步 RPC 已返回；此时断开仍必须清理旧请求，
    // 不能增加等待来绕过旧 lane 悬挂。重连后项目与设备对话都要恢复并同步最新内容。
    await selectTaskOrganizeMode(["项目", "Project"]);

    try {
      await disconnectRemoteSource(sourceId, CASE_MARKER, {
        workspaceIdentities: [taskA.identity],
      });
    } catch (error) {
      // 在清理前保存实际页面，不能以 after hook 清空后的画面推断设备列表丢失。
      facts.manualDisconnectBlocked = {
        holdElapsedMs: Date.now() - holdStartedAt,
        savedSourceStillPresent:
          (await readSettings()).sourceServers?.some((item) => item.sourceServerId === sourceId) ??
          false,
        page: await browser.execute(() => {
          const page = document.querySelector<HTMLElement>('[data-testid="settings-page"]');
          return {
            text: page?.innerText.slice(0, 5000) ?? null,
            buttons: Array.from(page?.querySelectorAll<HTMLButtonElement>("button") ?? []).map(
              (button) => ({ text: button.innerText.trim(), disabled: button.disabled }),
            ),
          };
        }),
      };
      await mkdir(artifactDir, { recursive: true });
      await browser.saveScreenshot(resolve(artifactDir, "management-pending-rpc-failure.png"));
      throw error;
    }

    const releasedOldSync = await proxy.release();
    expect(releasedOldSync.forwardedBytes + releasedOldSync.discardedBytes).toBeGreaterThan(0);
    facts.oldSyncReleasedAfterDisconnect = releasedOldSync;
    const remoteWhileOffline = await readRemotePersonalConfig(prepared.config);
    const offlineName1 = `R3 Offline Edit One ${Date.now()}`;
    await createCustomOpenAIChatCompletionsProvider({
      baseURL: provider.tunnel.baseURL,
      modelId: "r3-offline-one",
      providerName: offlineName1,
    });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "设置页无返回",
    });
    const offlineName2 = `R3 Offline Edit Two ${Date.now()}`;
    await createCustomOpenAIChatCompletionsProvider({
      baseURL: provider.tunnel.baseURL,
      modelId: "r3-offline-two",
      providerName: offlineName2,
    });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "设置页无返回",
    });
    await browser.pause(5000);
    const remoteStillOffline = await readRemotePersonalConfig(prepared.config);
    expect(remoteStillOffline).toBe(remoteWhileOffline);
    expect(remoteStillOffline).not.toContain(offlineName1);
    facts.offlineEditsNotSyncedWhileOffline = true;

    await reconnectRemoteProject(taskA.identity, CASE_MARKER);
    let reconnected: Awaited<ReturnType<typeof waitForRemoteTab>>;
    try {
      reconnected = await waitForRemoteTab({
        caseMarker: CASE_MARKER,
        expectedIdentity: taskA.identity,
        expectedPath: workspaceA,
        requireActive: false,
      });
    } catch (error) {
      // 重连后 remoteSessionId 未恢复时 dump 全量 tab 状态:区分"conversation tab
      // 挂回成功、项目 tab 漏挂"与"整条恢复链未执行"(§19 定性关键证据)。
      facts.reconnectDiagnostic = await browser.execute(() => {
        type RemoteTab = {
          id?: string;
          remoteSessionId?: string;
          workspaceIdentity?: string;
          workspacePath?: string;
          workspacePurpose?: string;
        };
        const store = (
          window as Window & {
            __zcodeTabStoreE2E?: {
              getState?: () => {
                activeWorkspaceIdentity?: string | null;
                activeWorkspacePath?: string | null;
                tabs?: RemoteTab[];
              };
            };
          }
        ).__zcodeTabStoreE2E?.getState?.();
        return {
          tabs: (store?.tabs ?? []).map((tab) => ({
            identity: tab.workspaceIdentity ?? null,
            path: tab.workspacePath ?? null,
            purpose: tab.workspacePurpose ?? null,
            sessionId: tab.remoteSessionId ?? null,
          })),
          active: {
            identity: store?.activeWorkspaceIdentity ?? null,
            path: store?.activeWorkspacePath ?? null,
          },
        };
      });
      throw error;
    }
    expect(reconnected.remoteSessionId).not.toBe(taskA.remoteSessionId);
    const restoredB = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: initialB.workspaceIdentity!,
      expectedPath: workspaceB,
      requireActive: false,
    });
    expect(parseRemoteWorkspaceIdentity(restoredB.workspaceIdentity!)?.sourceServerId).toBe(
      sourceId,
    );
    expect(restoredB.remoteSessionId).not.toBe(initialB.remoteSessionId);
    expect(restoredB.remoteSessionId).not.toBe(reconnected.remoteSessionId);
    facts.reconnectedWorkspaceScopes = { projectA: true, projectB: true, distinctSessions: true };
    const afterReconnect = await waitForRemotePersonalConfig(
      prepared.config,
      (text) => text.includes(offlineName1) && text.includes(offlineName2),
      "重连后远端含断线期间两次修改的最新内容",
    );
    facts.afterReconnectHasBothOfflineEdits = true;
    expect(afterReconnect).not.toContain(onlineName);
    expect(await readHostProcesses()).toEqual(prepared.initialHosts);

    const resumed: SSHLifecycleTask = { ...taskA, remoteSessionId: reconnected.remoteSessionId! };
    await readTaskRowInProject(resumed, CASE_MARKER);
    await selectV4TaskById(resumed.taskId, 30_000);
    await waitForV4ComposerSelectionReady();
    const resumedModelConfig = await getV4ModelConfig();
    facts.resumedModelConfig = resumedModelConfig;
    expect(resumedModelConfig).toMatchObject({
      provider: provider.id,
      model: SSH_LIFECYCLE_MODEL_ID,
      thought: SSH_LIFECYCLE_THOUGHT_LEVEL,
    });
    await sendSSHFollowTurn(resumed, CASE_MARKER);
    expect(await readHostProcesses()).toEqual(prepared.initialHosts);
  });
});
