// DMM：服务端规则驱动的草稿模型迁移，规格见 docs/chat/draft-model-migration.md。
// 规则经本地 client/configs 夹具下发；Provider 走 case-local replay，断言上游请求的 model 字段。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_CHAT_MODEL_GUIDE,
  TID_CHAT_MODEL_GUIDE_DISMISS,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_V4_COMPOSER,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  pinE2ELocale,
  seedSettings,
} from "#e2e/helpers/desktop-app";
import { startHelpConfigFixture } from "#e2e/helpers/help-client-config-fixture";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import { seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "#e2e/helpers/upstream-capture";
import {
  clickV4Send,
  getV4ComposerText,
  getV4ModelConfig,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  setV4ComposerText,
  switchV4Model,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";

const CASE_NAME = "conversation-session-draft-model-migration";
// 与用户从官方模板创建时的默认 ID 相同；Provider 归属由 templateId 决定，不按 ID 猜。
const OFFICIAL_PROVIDER_ID = "bigmodel-standard-api";
const CUSTOM_PROVIDER_ID = "e2e-dmm-custom";
// 型号用中性名：测试会随开源导出，不能出现任何真实的待发布或迁移计划。
const SOURCE_MODEL = "e2e-dmm-model-a";
const TARGET_MODEL = "e2e-dmm-model-b";
const REASONING = "disabled";
const TASK_SCOPE_KEY = JSON.stringify(["desktop", "local", null]);
const NOTICE_KEY = "zcode-draft-model-migration-notice:v1";
// 服务端下发 60 秒刷新间隔；等待略长于它，让 ClientConfigService 的快照过期。
const REFRESH_INTERVAL_SECONDS = 60;
const REFRESH_WAIT_MS = (REFRESH_INTERVAL_SECONDS + 2) * 1000;
const EVIDENCE_DIR = join(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(process.cwd(), ".e2e-artifacts"),
  CASE_NAME,
);

type ReplayServer = Awaited<ReturnType<typeof startConversationModelProviderReplayServer>>;
type ConfigFixture = Awaited<ReturnType<typeof startHelpConfigFixture>>;

let replay: ReplayServer | null = null;
let control: ConfigFixture | null = null;

// 气泡文案只来自服务端 notice；花括号用于确认文案按原文显示，不做占位符替换。
const NOTICE_ZH_CN = "E2E 草稿模型已切换为 e2e-dmm-model-b {toModel}";
const NOTICE_ZH = "E2E 同语种文案：草稿模型已切换";
const NOTICE_EN = "E2E draft model switched to e2e-dmm-model-b";
const NOTICE_EN_LONG =
  `E2E long notice: ${"the draft model now follows the latest server rule. ".repeat(4)}`.trim();

type Notice = Record<string, string>;

function clientConfigs(revision?: number, notice?: Notice) {
  return {
    clientConfigRefreshIntervalSeconds: REFRESH_INTERVAL_SECONDS,
    ...(revision
      ? {
          draftModelMigration: {
            revision,
            targetModelId: TARGET_MODEL,
            sourceModelIds: [SOURCE_MODEL],
            ...(notice ? { notice } : {}),
          },
        }
      : {}),
  };
}

const recentKey = (scopeKey: string) => `zcode-composer-recent:v2:${scopeKey}`;
const markerKey = (scopeKey: string) => `zcode-draft-model-migration:v1:${scopeKey}`;
const rootDraftKey = (scopeKey: string) => `zcode-v4-composer-project-drafts:v1:${scopeKey}`;
const guide = () => $(`[data-testid="${TID_CHAT_MODEL_GUIDE}"]`);
const INFLIGHT_PROMPT = "E2E_DMM_INFLIGHT_SEND 请回复固定内容。";

type StoredRootDraft = { text?: string; modelSelection?: { modelId?: string } };

function readStorage(key: string): Promise<unknown> {
  return browser.execute((storageKey) => {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as unknown) : null;
  }, key);
}

async function writeRecent(scopeKey: string, providerId: string, modelId: string, mode: string) {
  await browser.execute(
    (key, value) => window.localStorage.setItem(key, JSON.stringify(value)),
    recentKey(scopeKey),
    {
      modelSelection: { providerId, modelId, options: { reasoningLevel: REASONING } },
      mode,
      order: 1,
    },
  );
}

async function readProjectScopeKey(): Promise<string> {
  const projectId = await browser.execute((workspacePath) => {
    const state = (
      window as Window & {
        __zcodeSessionStoreE2E?: {
          getState(): { workspaces: Record<string, { draftProjectId?: string | null }> };
        };
      }
    ).__zcodeSessionStoreE2E?.getState().workspaces[workspacePath];
    return state?.draftProjectId ?? null;
  }, DEFAULT_WORKSPACE);
  if (!projectId) throw new Error("默认项目草稿没有项目归属，无法计算 Recent 作用域");
  return JSON.stringify(["desktop", "local", projectId]);
}

async function startTaskDraft() {
  const button = $('[data-testid="virtual-project-new-task"]');
  await $('[data-testid="conversation-section"]').moveTo();
  await button.waitForDisplayed();
  await button.click();
  await browser.waitUntil(
    async () =>
      (await getV4PaneSnapshot()).sessionId === "draft" &&
      (await browser.execute((pendingKey) => {
        const w = window as unknown as {
          __zcodeTabStoreE2E: { getState(): { activeWorkspacePath: string } };
        };
        const pending = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
        return Boolean(
          pending?.workspacePath &&
          pending.workspacePath === w.__zcodeTabStoreE2E.getState().activeWorkspacePath,
        );
      }, `zcode-pending-task-draft:v1:${TASK_SCOPE_KEY}`)),
    { timeout: 30_000, timeoutMsg: "任务分区草稿没有就绪" },
  );
}

async function waitForComposerModel(providerId: string, modelId: string, message: string) {
  let latest = await getV4ModelConfig();
  await browser
    .waitUntil(
      async () => {
        latest = await getV4ModelConfig();
        return latest.provider === providerId && latest.model === modelId;
      },
      { timeout: 30_000 },
    )
    .catch((error: unknown) => {
      throw new Error(`${message}: ${JSON.stringify(latest)}`, { cause: error });
    });
}

async function waitForStorage(
  key: string,
  predicate: (value: unknown) => boolean,
  message: string,
) {
  let latest: unknown = null;
  await browser
    .waitUntil(
      async () => {
        latest = await readStorage(key);
        return predicate(latest);
      },
      { timeout: 15_000 },
    )
    .catch((error: unknown) => {
      throw new Error(`${message}: ${JSON.stringify(latest)}`, { cause: error });
    });
}

function waitForMarker(scopeKey: string, source: "recent" | "rootDraft", revision: number) {
  return waitForStorage(
    markerKey(scopeKey),
    (value) => (value as Record<string, unknown> | null)?.[source] === revision,
    `${scopeKey} 的 ${source} 迁移标记没有成为 ${revision}`,
  );
}

async function readRootDraftMarker(scopeKey: string) {
  return ((await readStorage(markerKey(scopeKey))) as { rootDraft?: unknown } | null)?.rootDraft;
}

async function expectNoGuide(noticeRevision: number) {
  // 气泡显示时才写提示标记；标记不变且气泡不存在，说明本次没有再提示。
  expect(await readStorage(NOTICE_KEY)).toEqual({ revision: noticeRevision });
  expect(await guide().isExisting()).toBe(false);
}

async function expectGuide(noticeRevision: number, expectedText: string) {
  await guide().waitForDisplayed({ timeout: 15_000 });
  expect((await guide().getText()).trim()).toBe(expectedText);
  await waitForStorage(
    NOTICE_KEY,
    (value) => (value as { revision?: unknown } | null)?.revision === noticeRevision,
    "气泡显示后没有写入提示标记",
  );
  await capture(`guide-r${noticeRevision}`);
}

async function expectGuideAndDismiss(noticeRevision: number, text: string) {
  await expectGuide(noticeRevision, text);
  await $(`[data-testid="${TID_CHAT_MODEL_GUIDE_DISMISS}"]`).click();
  await guide().waitForDisplayed({ reverse: true, timeout: 10_000 });
}

async function expectGuideLayout(options: { wrapped: boolean }) {
  const layout = await browser.execute(
    (guideTestId, triggerTestId, composerTestId) => {
      // Radix Tooltip 另渲染一份 role=tooltip 的隐藏副本，只量真正显示的那份。
      const guide = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="${guideTestId}"]`),
      ).find((element) => !element.closest('[role="tooltip"]'));
      const bubble = guide?.closest<HTMLElement>('[data-slot="tooltip-content"]');
      const trigger = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="${triggerTestId}"]`),
      ).find((element) => element.getClientRects().length > 0);
      const composer = trigger?.closest<HTMLElement>(`[data-testid="${composerTestId}"]`);
      const text = guide?.firstElementChild as HTMLElement | null | undefined;
      if (!bubble || !trigger || !composer || !text) return null;
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, height: rect.height };
      };
      return {
        bubble: box(bubble),
        trigger: box(trigger),
        composer: box(composer),
        textHeight: text.getBoundingClientRect().height,
        // line-height 为 normal 时按字号 1.2 倍估算单行高度。
        lineHeight:
          Number.parseFloat(getComputedStyle(text).lineHeight) ||
          Number.parseFloat(getComputedStyle(text).fontSize) * 1.2,
        viewport: window.innerWidth,
      };
    },
    TID_CHAT_MODEL_GUIDE,
    TID_CHAT_MODEL_SELECT_TRIGGER,
    TID_V4_COMPOSER,
  );
  if (!layout) throw new Error("没有找到气泡、模型按钮或输入框");
  const detail = JSON.stringify(layout);
  // 桌面输入框足够宽：右边缘与模型按钮对齐，向输入区内侧展开，不越过输入框。
  expect(Math.abs(layout.bubble.right - layout.trigger.right)).toBeLessThanOrEqual(1);
  expect(layout.bubble.right).toBeLessThanOrEqual(layout.composer.right + 0.5);
  expect(layout.bubble.left).toBeGreaterThanOrEqual(layout.composer.left - 0.5);
  expect(layout.bubble.left).toBeGreaterThanOrEqual(8 - 0.5);
  expect(layout.bubble.right).toBeLessThanOrEqual(layout.viewport - 8 + 0.5);
  if (options.wrapped && layout.textHeight < layout.lineHeight * 2 - 1)
    throw new Error(`长文案没有换行: ${detail}`);
}

async function sendAndExpectModel(marker: string, modelId: string) {
  const prompt = `${marker} 请回复固定内容。`;
  await sendV4PromptAndWaitAccepted(prompt, marker, `${marker} 没有被接纳`);
  const record = await waitForUpstreamNetworkCapture(marker);
  assertUpstreamRequestCapture(record, { expectedText: marker, model: modelId });
}

async function capture(step: string) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  // 草稿正文、待发送任务目录与迁移标记一起留存，失败时能对照判定与持久化结果。
  const storage = await browser.execute(() =>
    Object.fromEntries(
      Object.entries(window.localStorage).filter(
        ([key]) =>
          key.startsWith("zcode-composer-recent:") ||
          key.startsWith("zcode-draft-model") ||
          key.startsWith("zcode-v4-composer-") ||
          key.startsWith("zcode-pending-task-draft:"),
      ),
    ),
  );
  await writeFile(
    join(EVIDENCE_DIR, `${step}.json`),
    JSON.stringify(
      {
        composer: await getV4ModelConfig(),
        composerText: await getV4ComposerText(),
        pane: await getV4PaneSnapshot(),
        storage,
      },
      null,
      2,
    ),
  );
  await browser.saveScreenshot(join(EVIDENCE_DIR, `${step}.png`));
}

async function restartWithConfigs(configs: Record<string, unknown>) {
  control!.setClientConfigs(configs);
  // ClientConfigService 的快照只在进程内；重启后第一次读取直接拿到夹具当前配置。
  await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
}

describe("草稿模型迁移（服务端规则）", () => {
  before(async () => {
    replay = await startConversationModelProviderReplayServer(CASE_NAME);
    control = await startHelpConfigFixture({});
    control.setClientConfigs(clientConfigs(1, { "zh-CN": NOTICE_ZH_CN }));
  });

  after(async () => {
    await clearAppData();
    await replay?.stop();
    await control?.close();
    replay = null;
    control = null;
  });

  it("DMM-01~08、DMM-11~13：官方 Provider 草稿与默认值按规则迁移一次，气泡只用服务端文案、每个版本只弹一次", async function () {
    this.timeout(900_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await startDraftFromProject(DEFAULT_WORKSPACE);
    const projectScopeKey = await readProjectScopeKey();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        await seedReplayProvider({
          id: OFFICIAL_PROVIDER_ID,
          templateId: OFFICIAL_PROVIDER_ID,
          name: "BigModel API",
          models: [TARGET_MODEL, SOURCE_MODEL],
        });
        await seedReplayProvider({
          id: CUSTOM_PROVIDER_ID,
          name: "Custom Provider",
          models: [TARGET_MODEL, SOURCE_MODEL],
        });
        await seedSettings({ zcodeEndpointOrigin: control!.origin });
      },
    });
    // 规则只有中文文案；英文系统下迁移成功也不会弹气泡，须先固定应用语言再触发迁移。
    await pinE2ELocale("zh-CN");
    // Recent 只存在 renderer localStorage；先写种子，再打开需要判定的作用域。
    await writeRecent(projectScopeKey, OFFICIAL_PROVIDER_ID, SOURCE_MODEL, "edit");
    await writeRecent(TASK_SCOPE_KEY, CUSTOM_PROVIDER_ID, SOURCE_MODEL, "build");

    // DMM-03：完全自定义 Provider 的同名模型不迁移，但记录已判定。
    await startTaskDraft();
    await waitForComposerModel(CUSTOM_PROVIDER_ID, SOURCE_MODEL, "DMM-03 自定义 Provider 被迁移");
    await waitForMarker(TASK_SCOPE_KEY, "recent", 1);
    expect(await readStorage(NOTICE_KEY)).toBeNull();
    expect(await guide().isExisting()).toBe(false);
    await capture("dmm-03-custom-settled");

    // DMM-01：官方模板 Provider 的 Recent 迁移到目标模型，弹气泡，首发使用目标模型。
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, TARGET_MODEL, "DMM-01 草稿没有迁移");
    await expectGuide(1, NOTICE_ZH_CN);
    await expectGuideLayout({ wrapped: false });
    expect(await readStorage(recentKey(projectScopeKey))).toEqual({
      modelSelection: {
        providerId: OFFICIAL_PROVIDER_ID,
        modelId: TARGET_MODEL,
        options: { reasoningLevel: REASONING },
      },
      mode: "edit",
      order: 1,
    });
    await waitForMarker(projectScopeKey, "recent", 1);
    // 不关闭气泡直接发送（不经指针）：气泡已经显示过，回到同项目新建草稿时不能再弹。
    await sendAndExpectModel("E2E_DMM_FIRST_SEND", TARGET_MODEL);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, TARGET_MODEL, "项目 Recent 应为首发模型");
    await expectNoGuide(1);

    // DMM-04 + DMM-02：任务分区的文字草稿也迁移，正文保留；气泡已弹过，不再提示。
    await startTaskDraft();
    await waitForComposerModel(CUSTOM_PROVIDER_ID, SOURCE_MODEL, "任务分区 Recent 不应变化");
    await switchV4Model(OFFICIAL_PROVIDER_ID, SOURCE_MODEL, "");
    await setV4ComposerText("DMM04 文字草稿正文");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, TARGET_MODEL, "项目 Recent 应为首发模型");
    await startTaskDraft();
    await waitForV4ComposerText("DMM04 文字草稿正文", "DMM-04 文字草稿没有恢复");
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, TARGET_MODEL, "DMM-04 文字草稿没有迁移");
    await waitForMarker(TASK_SCOPE_KEY, "rootDraft", 1);
    await expectNoGuide(1);
    await capture("dmm-04-root-draft-migrated");

    // DMM-05：迁移后用户改回源模型并发送，同一规则版本不再迁移。
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, TARGET_MODEL, "项目草稿应为目标模型");
    await capture("dmm-05-left-task-draft");
    await switchV4Model(OFFICIAL_PROVIDER_ID, SOURCE_MODEL, "");
    await sendAndExpectModel("E2E_DMM_SOURCE_SEND", SOURCE_MODEL);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, SOURCE_MODEL, "DMM-05 用户选择被再次迁移");
    await waitForMarker(projectScopeKey, "recent", 1);
    await expectNoGuide(1);

    // DMM-06：规则升到 r2，服务端间隔到期后下一次打开再迁移一次，并再弹一次气泡。
    // 中文界面只有 zh 文案：按同语种取。
    control!.setClientConfigs(clientConfigs(2, { zh: NOTICE_ZH }));
    await browser.pause(REFRESH_WAIT_MS);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, TARGET_MODEL, "DMM-06 新规则没有生效");
    await waitForMarker(projectScopeKey, "recent", 2);
    await expectGuideAndDismiss(2, NOTICE_ZH);

    // DMM-07：快照过期且接口挂起时，3 秒内用旧快照完成判定，界面不被卡住。
    await browser.pause(REFRESH_WAIT_MS);
    const releaseResponses = control!.holdResponses();
    try {
      const openedAt = Date.now();
      await startTaskDraft();
      await waitForMarker(TASK_SCOPE_KEY, "rootDraft", 2);
      // 旧快照最多等 3 秒；10 秒上限扣除导航与轮询后，仍能区分它与 15 秒的请求超时。
      const elapsedMs = Date.now() - openedAt;
      console.log(`[DMM-07] 接口挂起时判定耗时 ${elapsedMs}ms`);
      expect(elapsedMs).toBeLessThan(10_000);
      await capture("dmm-07-opened");
      await waitForComposerModel(OFFICIAL_PROVIDER_ID, TARGET_MODEL, "DMM-07 草稿模型异常");
      await waitForV4ComposerText("DMM04 文字草稿正文", "DMM-07 文字草稿丢失");
      await capture("dmm-07-stale-snapshot");
    } finally {
      releaseResponses();
    }

    // DMM-08：删除规则或 revision 变小都不再迁移，已迁移结果不回滚。
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, TARGET_MODEL, "项目草稿应为目标模型");
    await switchV4Model(OFFICIAL_PROVIDER_ID, SOURCE_MODEL, "");
    await sendAndExpectModel("E2E_DMM_RULE_REMOVED", SOURCE_MODEL);
    await restartWithConfigs(clientConfigs());
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, SOURCE_MODEL, "DMM-08 规则删除后仍迁移");
    await waitForMarker(projectScopeKey, "recent", 2);
    await expectNoGuide(2);
    await restartWithConfigs(clientConfigs(1));
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, SOURCE_MODEL, "DMM-08 低版本规则仍迁移");
    await waitForMarker(projectScopeKey, "recent", 2);
    await expectNoGuide(2);
    await capture("dmm-08-rule-removed-and-downgraded");

    // 视觉：同一流程在浅色主题与英文下再迁移一次（r3），留存气泡截图供人工检查。
    await restartWithConfigs(clientConfigs(3, { "zh-CN": NOTICE_ZH_CN, "en-US": NOTICE_EN }));
    await pinE2ELocale("en-US");
    await browser.execute((theme) => {
      const actions = (
        window as typeof window & { __testActions?: { setTheme?: (value: string) => void } }
      ).__testActions;
      if (!actions?.setTheme) throw new Error("缺少主题测试入口");
      actions.setTheme(theme);
    }, "zai-light");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, TARGET_MODEL, "r3 规则没有生效");
    await expectGuideAndDismiss(3, NOTICE_EN);

    // DMM-11：规则在首发途中才到达。草稿已交给发送，本次打开不再迁移、不写标记；
    // 新会话保持发送时的源模型，下次新建草稿再按规则迁移并弹一次气泡。
    await switchV4Model(OFFICIAL_PROVIDER_ID, SOURCE_MODEL, "");
    await setV4ComposerText(INFLIGHT_PROMPT);
    // 重启会结束 renderer；先等文字草稿（源模型）落盘，重启后本次打开从它恢复。
    await waitForStorage(
      rootDraftKey(projectScopeKey),
      (value) => {
        const draft = (value as { scopes?: Record<string, StoredRootDraft> } | null)?.scopes
          ?.__draft__;
        return draft?.text === INFLIGHT_PROMPT && draft.modelSelection?.modelId === SOURCE_MODEL;
      },
      "DMM-11 文字草稿没有落盘",
    );
    control!.setClientConfigs(clientConfigs(4, { "en-US": NOTICE_EN }));
    // 重启后缓存为空，挂起响应让本次打开一直拿不到规则，直到首发已经开始。
    const releaseRule = control!.holdResponses();
    try {
      await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
      await startDraftFromProject(DEFAULT_WORKSPACE);
      await waitForV4ComposerText(INFLIGHT_PROMPT, "DMM-11 文字草稿没有恢复", 30_000);
      await waitForComposerModel(OFFICIAL_PROVIDER_ID, SOURCE_MODEL, "DMM-11 规则未到达时被迁移");
      await clickV4Send();
      releaseRule();
      const record = await waitForUpstreamNetworkCapture("E2E_DMM_INFLIGHT_SEND");
      assertUpstreamRequestCapture(record, {
        expectedText: "E2E_DMM_INFLIGHT_SEND",
        model: SOURCE_MODEL,
      });
      // 首发在途的迁移只可能发生在 pane 切到正式会话之前；切换后再读即可判定。
      await browser.waitUntil(async () => (await getV4PaneSnapshot()).sessionId !== "draft", {
        timeout: 30_000,
        timeoutMsg: "DMM-11 首发没有切到正式会话",
      });
      await waitForComposerModel(OFFICIAL_PROVIDER_ID, SOURCE_MODEL, "DMM-11 新会话被换成目标模型");
      await capture("dmm-11-inflight-send");
    } finally {
      releaseRule();
    }
    expect(await readRootDraftMarker(projectScopeKey)).not.toBe(4);
    await waitForStorage(
      recentKey(projectScopeKey),
      (value) =>
        (value as { modelSelection?: { modelId?: string } } | null)?.modelSelection?.modelId ===
        SOURCE_MODEL,
      "DMM-11 首发回执没有把 Recent 写为源模型",
    );
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, TARGET_MODEL, "DMM-11 下次打开没有迁移");
    await waitForMarker(projectScopeKey, "recent", 4);
    await expectGuideAndDismiss(4, NOTICE_EN);
    expect(await readRootDraftMarker(projectScopeKey)).not.toBe(4);

    // DMM-12：文案只有当前语言、同语种和英文都取不到的条目：照常迁移，不弹气泡，不写气泡标记。
    // Recent 在重启前写回源模型，重启后无论恢复的草稿还是重新打开的草稿，都按 r5 迁移。
    await writeRecent(projectScopeKey, OFFICIAL_PROVIDER_ID, SOURCE_MODEL, "build");
    await restartWithConfigs(clientConfigs(5, { "ja-JP": "E2E 下書きモデルを切り替えました" }));
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, TARGET_MODEL, "DMM-12 没有文案时也应迁移");
    await waitForMarker(projectScopeKey, "recent", 5);
    // 判定与气泡挂起在同一轮完成；稍等再确认气泡确实没有出现。
    await browser.pause(1500);
    await expectNoGuide(4);
    await capture("dmm-12-no-notice");

    // DMM-13：中文界面，zh-CN 含换行、ko-KR 超过 256 字符都被丢弃，回退到英文长文案；
    // 长文案自动换行，气泡右边缘与按钮对齐，不超出输入框，距视口不少于 8px。
    await pinE2ELocale("zh-CN");
    await writeRecent(projectScopeKey, OFFICIAL_PROVIDER_ID, SOURCE_MODEL, "build");
    await restartWithConfigs(
      clientConfigs(6, {
        "zh-CN": "E2E 含\n换行的文案",
        "ko-KR": "가".repeat(257),
        "en-US": NOTICE_EN_LONG,
      }),
    );
    await pinE2ELocale("zh-CN");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForComposerModel(OFFICIAL_PROVIDER_ID, TARGET_MODEL, "DMM-13 没有迁移");
    await waitForMarker(projectScopeKey, "recent", 6);
    await expectGuide(6, NOTICE_EN_LONG);
    await expectGuideLayout({ wrapped: true });
    await $(`[data-testid="${TID_CHAT_MODEL_GUIDE_DISMISS}"]`).click();
    await guide().waitForDisplayed({ reverse: true, timeout: 10_000 });
  });
});
