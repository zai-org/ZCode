import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";
import {
  disconnectRemoteSource,
  reconnectRemoteProject,
} from "#e2e/helpers/remote-project-actions";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { refreshSeededOpenAIProvidersThroughSettings } from "#e2e/helpers/custom-openai-provider";
import { seedCustomOpenAIChatCompletionsProvider } from "#e2e/helpers/custom-openai-provider-store";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import { readRemoteTabSnapshot, runSSHCommand } from "#e2e/helpers/ssh-remote-p0";
import { selectV4TaskById } from "#e2e/helpers/v4-conversation";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";

const CASE_MARKER = "E2E_R3_MODEL_CANDIDATES";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-model-candidates",
);
const LOCAL_ONLY_PROVIDER_ID = "e2e-r3-local-only";
const LOCAL_ONLY_LABEL = "R3 Local Only Provider";
const LOCAL_ONLY_MODEL_ID = "e2e-r3-local-only-model";

interface MenuSnapshot {
  items: string[];
  triggerDisabled: boolean;
  triggerText: string;
  bannerText: string;
}

/** 打开模型菜单读取候选（provider 分组 + 已展开模型项）后关闭；trigger 不可用时只记录状态。 */
async function readModelMenu(): Promise<MenuSnapshot> {
  const trigger = $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
  await trigger.waitForExist({ timeout: 30_000 });
  const base = await browser.execute((triggerId) => {
    const element = document.querySelector<HTMLButtonElement>(`[data-testid="${triggerId}"]`);
    const banner = Array.from(
      document.querySelectorAll<HTMLElement>('[role="alert"], [role="status"]'),
    )
      .filter((node) => node.getClientRects().length)
      .map((node) => (node.innerText ?? node.textContent ?? "").trim())
      .filter(Boolean)
      .join(" | ")
      .slice(0, 300);
    return {
      triggerDisabled: element?.disabled ?? true,
      triggerText: (element?.innerText ?? element?.textContent ?? "").trim(),
      bannerText: banner,
    };
  }, TID_CHAT_MODEL_SELECT_TRIGGER);
  if (base.triggerDisabled) return { items: [], ...base };
  await trigger.click();
  // 合并菜单默认只投影当前供应商；先打开供应商列表，才能观察完整候选归属。
  const providers = $('[data-testid="composer-provider-trigger"]');
  if ((await providers.isExisting()) && (await providers.getAttribute("aria-expanded")) !== "true")
    await providers.click();
  let items: string[] = [];
  await browser.waitUntil(
    async () => {
      items = await browser.execute(
        (groupPrefix, itemPrefix) =>
          Array.from(
            document.querySelectorAll<HTMLElement>(
              `[data-testid^="${groupPrefix}"], [data-testid^="${itemPrefix}"]`,
            ),
          )
            .filter((item) => item.getClientRects().length > 0)
            .map((item) => item.dataset.testid ?? ""),
        TID_CHAT_MODEL_SELECT_GROUP,
        TID_CHAT_MODEL_SELECT_ITEM,
      );
      return items.length > 0;
    },
    { timeout: 15_000, interval: 200, timeoutMsg: "menu-empty" },
  );
  await browser.keys(["Escape"]);
  await browser.waitUntil(
    () =>
      browser.execute(
        (groupPrefix, itemPrefix) =>
          !document.querySelector(
            `[data-testid^="${groupPrefix}"], [data-testid^="${itemPrefix}"]`,
          ),
        TID_CHAT_MODEL_SELECT_GROUP,
        TID_CHAT_MODEL_SELECT_ITEM,
      ),
    { timeout: 10_000, timeoutMsg: "menu-close" },
  );
  return { items, ...base };
}

const hasLocalOnly = (snapshot: MenuSnapshot) =>
  snapshot.items.some((item) => item.includes(LOCAL_ONLY_PROVIDER_ID));

describe(`${CASE_MARKER}: 远端 tab 候选读目标远端（离线不 fallback 本机、同步后一致）、快速切 tab 不串、设置页编辑本地`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "model-candidates.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-PRV-16 Source 离线时新增本地 provider：本地 tab 立即可见、远端 tab 不 fallback；重连同步后远端 tab 可见；快速切 tab 5 轮不串；设置页编辑始终本地", async function () {
    this.timeout(30 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, { tunnelUsername: "tunnel" });
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const sourceId = parseRemoteWorkspaceIdentity(taskA.identity)?.sourceServerId ?? "";

    const disconnectSource = async () => {
      await selectTaskOrganizeMode(["项目", "Project"]);
      await disconnectRemoteSource(sourceId!, CASE_MARKER, {
        workspaceIdentities: [taskA.identity],
      });
    };
    const reconnectSource = async () => {
      await selectTaskOrganizeMode(["项目", "Project"]);
      await reconnectRemoteProject(taskA.identity, CASE_MARKER);
      await browser.waitUntil(
        async () =>
          Boolean((await readRemoteTabSnapshot(taskA.identity).catch(() => null))?.remoteSessionId),
        { timeout: 120_000, interval: 1000, timeoutMsg: `${CASE_MARKER}: 重连没有恢复` },
      );
    };
    const openRemoteDraft = async () => {
      const remote = await readRemoteTabSnapshot(taskA.identity);
      const online = Boolean(remote.remoteSessionId);
      if (online) {
        await selectV4TaskById(taskA.taskId, 30_000);
        await startDraftFromProject(workspaceA, { workspaceIdentity: taskA.identity });
      } else {
        // 离线时任务/Composer 不可用是已知前置，不能每次耗尽 5s + 30s 再走 fallback。
        // 沿原 case 的 tab 激活入口切换，但随后读取真实模型菜单，不能用空数组伪装未串读。
        const activated = await browser.execute((identity) => {
          const store = (
            window as Window & {
              __zcodeTabStoreE2E?: {
                getState(): {
                  tabs: Array<{ id: string; workspaceIdentity?: string }>;
                  activateTab(id: string): void;
                };
              };
            }
          ).__zcodeTabStoreE2E;
          const state = store?.getState();
          const tab = state?.tabs.find((item) => item.workspaceIdentity === identity);
          if (!tab) return false;
          state!.activateTab(tab.id);
          return true;
        }, taskA.identity);
        if (!activated) throw new Error(`${CASE_MARKER}: 远端 tab 不存在，无法激活`);
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
      }
      const active = await readRemoteTabSnapshot();
      if (active.activeWorkspaceIdentity !== taskA.identity) {
        throw new Error(`${CASE_MARKER}: 远端目标归属错误: ${active.activeWorkspaceIdentity}`);
      }
      return online;
    };
    const readOfflineModelSurface = async (): Promise<MenuSnapshot> => {
      const active = await readRemoteTabSnapshot();
      expect(active.activeWorkspaceIdentity).toBe(taskA.identity);
      expect(active.remoteSessionId).toBeNull();
      if (await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`).isExisting()) {
        return readModelMenu();
      }
      // 离线项目没有 Composer 是当前真实 UI；必须验证目标离线行和实际 DOM，
      // 不能凭没有 draft 就捏造空候选，也不能等待只在在线 Composer 中出现的控件。
      const surface = await browser.execute(
        (identity, composerId, groupId, itemId) => {
          const row = Array.from(
            document.querySelectorAll<HTMLElement>("[data-project-workspace-identity]"),
          ).find((node) => node.dataset.projectWorkspaceIdentity === identity);
          const visible = (node: HTMLElement) => node.getClientRects().length > 0;
          return {
            offlineRowText: row && visible(row) ? row.innerText.replace(/\s+/gu, " ") : "",
            composerPresent: Array.from(
              document.querySelectorAll<HTMLElement>(`[data-testid="${composerId}"]`),
            ).some(visible),
            items: Array.from(
              document.querySelectorAll<HTMLElement>(
                `[data-testid^="${groupId}"], [data-testid^="${itemId}"]`,
              ),
            )
              .filter(visible)
              .map((node) => node.dataset.testid ?? ""),
          };
        },
        taskA.identity,
        TID_V4_COMPOSER_INPUT,
        TID_CHAT_MODEL_SELECT_GROUP,
        TID_CHAT_MODEL_SELECT_ITEM,
      );
      expect(surface.offlineRowText).toMatch(
        /离线|连接失败|未连接|Disconnected|Connection failed/iu,
      );
      expect(surface.composerPresent).toBe(false);
      facts.lastOfflineSurface = { ...surface, identity: taskA.identity, triggerPresent: false };
      return {
        items: surface.items,
        triggerDisabled: true,
        triggerText: "",
        bannerText: surface.offlineRowText,
      };
    };
    /** 远端 Registry 就绪前入口禁用；等待真实可用状态，只打开菜单一次。 */
    const readRemoteMenuSettled = async (): Promise<MenuSnapshot & { settleMs: number }> => {
      const startedAt = Date.now();
      await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`).waitForClickable({
        timeout: 60000,
      });
      const snapshot = await readModelMenu();
      return { ...snapshot, settleMs: Date.now() - startedAt };
    };
    const openLocalDraft = async () => {
      await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    };

    // 基线：在线时远端 tab 与本地 tab 候选都不含 local-only。
    await openRemoteDraft();
    const remoteBaseline = await readRemoteMenuSettled();
    await openLocalDraft();
    const localBaseline = await readModelMenu();
    facts.baseline = { remote: remoteBaseline, local: localBaseline.items };
    // 远端 tab 新草稿的模型 trigger 若长期为"管理模型"（禁用）说明远端候选不可用，记录并失败。
    expect(remoteBaseline.items.length).toBeGreaterThan(0);
    expect(hasLocalOnly(remoteBaseline)).toBe(false);
    expect(hasLocalOnly(localBaseline)).toBe(false);

    // Source 离线 → 新增本地 provider（本机 Registry 刷新）。远端此时无法同步。
    await disconnectSource();
    await seedCustomOpenAIChatCompletionsProvider({
      modelId: LOCAL_ONLY_MODEL_ID,
      providerId: LOCAL_ONLY_PROVIDER_ID,
      providerName: LOCAL_ONLY_LABEL,
    });
    await refreshSeededOpenAIProvidersThroughSettings([LOCAL_ONLY_LABEL]);
    await openLocalDraft();
    const localOffline = await readModelMenu();
    facts.offlineLocal = localOffline;
    expect(hasLocalOnly(localOffline)).toBe(true);

    // 远端 tab 离线：不得 fallback 到本机候选（local-only 不可见）；若没有 composer 则记录离线占位文本。
    const offlineDraftReady = await openRemoteDraft();
    const remoteOffline: MenuSnapshot = offlineDraftReady
      ? await readRemoteMenuSettled()
      : await readOfflineModelSurface();
    facts.offlineRemote = { ...remoteOffline, draftPaneAvailable: offlineDraftReady };
    expect(hasLocalOnly(remoteOffline)).toBe(false);
    const remoteConfigOffline = await runSSHCommand(
      prepared.config,
      `grep -c "${LOCAL_ONLY_PROVIDER_ID}" "$HOME/.zcode/v2/provider_config.json" || true`,
    );
    const remoteConfigHasLocalOnlyWhileOffline =
      Number.parseInt(remoteConfigOffline.stdout.trim() || "0", 10) > 0;
    facts.remoteConfigHasLocalOnlyWhileOffline = remoteConfigHasLocalOnlyWhileOffline;
    expect(remoteConfigHasLocalOnlyWhileOffline).toBe(false);

    // 快速切 tab 5 轮（离线期）：本地有 / 远端无必须稳定，不出现串读。
    const offlineRounds: Array<{
      local: boolean;
      remote: boolean;
      remoteTriggerDisabled: boolean;
      remoteDraft: boolean;
    }> = [];
    const offlineSwitchStartedAt = Date.now();
    for (let round = 0; round < 5; round += 1) {
      await openLocalDraft();
      const l = await readModelMenu();
      const remoteDraft = await openRemoteDraft();
      const r: MenuSnapshot = remoteDraft
        ? await readRemoteMenuSettled()
        : await readOfflineModelSurface();
      offlineRounds.push({
        local: hasLocalOnly(l),
        remote: hasLocalOnly(r),
        remoteTriggerDisabled: r.triggerDisabled,
        remoteDraft,
      });
    }
    facts.offlineQuickSwitch = offlineRounds;
    facts.offlineSwitchDurationMs = Date.now() - offlineSwitchStartedAt;
    expect(offlineRounds.every((round) => round.local && !round.remote)).toBe(true);

    // 重连 → provisioning 同步 → 远端配置与远端 tab 候选都出现 local-only（候选来自目标远端的最新事实）。
    await reconnectSource();
    await browser.waitUntil(
      async () => {
        const result = await runSSHCommand(
          prepared.config,
          `grep -c "${LOCAL_ONLY_PROVIDER_ID}" "$HOME/.zcode/v2/provider_config.json" || true`,
        );
        return Number.parseInt(result.stdout.trim() || "0", 10) > 0;
      },
      {
        timeout: 90_000,
        interval: 2000,
        timeoutMsg: `${CASE_MARKER}: 重连后远端配置没有同步到 local-only provider`,
      },
    );
    let remoteAfterSync: MenuSnapshot = {
      items: [],
      triggerDisabled: true,
      triggerText: "",
      bannerText: "",
    };
    await openRemoteDraft();
    const remoteSeesSynced = await browser
      .waitUntil(
        async () => {
          remoteAfterSync = await readModelMenu();
          return hasLocalOnly(remoteAfterSync);
        },
        { timeout: 90_000, interval: 5_000, timeoutMsg: "remote-sync-visible" },
      )
      .then(() => true)
      .catch(() => false);
    facts.afterReconnect = {
      remote: remoteAfterSync.items,
      remoteSeesSyncedProvider: remoteSeesSynced,
    };
    expect(remoteSeesSynced).toBe(true);
    // 在线快速切 tab 5 轮：两边都应含 local-only（同步后一致）。
    const onlineRounds: Array<{ local: boolean; remote: boolean }> = [];
    for (let round = 0; round < 5; round += 1) {
      await openLocalDraft();
      const l = await readModelMenu();
      await openRemoteDraft();
      const r = await readRemoteMenuSettled();
      onlineRounds.push({ local: hasLocalOnly(l), remote: hasLocalOnly(r) });
    }
    facts.onlineQuickSwitch = onlineRounds;
    expect(onlineRounds.every((round) => round.local)).toBe(true);
    expect(onlineRounds.every((round) => round.remote === remoteSeesSynced)).toBe(true);

    // 设置页始终编辑本地：远端 tab 激活时打开设置，provider 列表为本机列表（含 local-only 与 lifecycle provider）。
    await openRemoteDraft();
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 没有设置入口`,
    });
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 15_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 设置页没有模型供应商分区`,
    });
    await browser.pause(1_500);
    const settingsText = await browser.execute(() => document.body?.innerText ?? "");
    facts.settings = {
      showsLocalOnly: settingsText.includes(LOCAL_ONLY_LABEL),
      showsLifecycle: settingsText.includes(provider.name),
    };
    expect(settingsText).toContain(LOCAL_ONLY_LABEL);
    expect(settingsText).toContain(provider.name);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 设置页返回按钮没有出现`,
    });
    expect(remoteSeesSynced).toBe(true);
  });
});
