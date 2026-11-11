import {
  startDraftFromProject,
  selectNativeProjectDirectories,
} from "#e2e/helpers/project-sidebar";
import { selectUpstreamModel } from "#e2e/helpers/upstream-provider";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TID_SIDE_PANE_TOGGLE,
  TID_SIDE_PANE_FULL_VIEW_TOGGLE,
  TID_SIDE_PANE_FULL_VIEW_HOST,
} from "@zcode/shared/test-ids";
import { clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  getV4PaneSnapshot,
  waitForV4Pane,
  approveV4Permission,
  denyV4PermissionWithFeedback,
  waitForV4PermissionDialog,
  getV4ConfigProjection,
  setV4ComposerText,
  getV4ComposerText,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";
import {
  PLUGIN_LIFECYCLE_ID,
  addLifecycleMarketplaceThroughUi,
  capturePluginManualReview,
  clickPluginControl,
  createPluginLifecycleFixture,
  getPluginList,
  getPluginOverview,
  installPluginThroughUi,
  openManageView,
  openPluginSettings,
  requirePluginManualReview,
  removeLifecyclePluginPayload,
  setPluginEnabledThroughUi,
  uninstallPluginThroughUi,
  waitForPluginControl,
} from "#e2e/helpers/plugin-management-lifecycle";
import { startElectronWindowRecording } from "#e2e/helpers/electron-window-recorder";

const ARTIFACT_DIR = join(process.cwd(), ".e2e-artifacts", "plugin-management", "plm-ui-001");
// 每个评审步骤截图后停留，录像里能看清稳定态；同时记录时间点供生成字幕。
const STEP_HOLD_MS = 1500;
type DraftUiWindow = Window & {
  __zcodeSessionStoreE2E?: {
    getState(): {
      getWorkspaceState(workspacePath: string): {
        pluginUiOpenRequest: unknown;
      };
    };
  };
};
declare global {
  interface Window {
    __draftPluginUiCreateGate?: { count: number; restore(): void };
  }
}

describe("PLM-UI-001 UI 插件市场与项目配置", () => {
  after(async () => {
    await browser.execute(() => window.__draftPluginUiCreateGate?.restore());
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("在真实 MCP 沙箱打开界面，关闭不卸载，项目暂停不影响全局和其他项目", async function () {
    this.timeout(240000);
    requirePluginManualReview();
    const fixture = await createPluginLifecycleFixture("1.0.0", true);
    await mkdir(ARTIFACT_DIR, { recursive: true });
    const recording = await startElectronWindowRecording({
      frameIntervalMs: 200,
      outputPath: join(ARTIFACT_DIR, "plm-ui-001.webm"),
    });
    const recordingStartedAt = Date.now();
    const chapters: Array<{ label: string; atMs: number }> = [];
    const step = async (label: string) => {
      await capturePluginManualReview("PLM-UI-001", label);
      chapters.push({ label, atMs: Date.now() - recordingStartedAt });
      await browser.pause(STEP_HOLD_MS);
    };
    try {
      await openPluginSettings();
      await waitForPluginControl("plugin-store-list");
      await browser.$('[data-testid="plugin-store-card"]').waitForDisplayed({ timeout: 60000 });
      // 截图按 PRD 章节编号，便于逐项对照（PRD：插件市场 & Side Pane 交互调整）。
      await step("01-market-header-public");
      await addLifecycleMarketplaceThroughUi(fixture);
      await clickPluginControl("plugin-store-segment-community");
      await step("02-market-community");
      await clickPluginControl("plugin-store-segment-personal");
      await waitForPluginControl("plugin-store-ui-section");
      await step("03-market-personal-ui-section");
      // 缺失源包必须保留可重试错误，不能伪装成已安装或打开 UI。
      await removeLifecyclePluginPayload(fixture);
      try {
        await clickPluginControl("plugin-store-install", { pluginId: PLUGIN_LIFECYCLE_ID });
        await waitForPluginControl("plugin-store-error");
        expect(
          (await getPluginList()).plugins.some((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID),
        ).toBe(false);
        await step("04-install-failure-before-retry");
      } finally {
        await createPluginLifecycleFixture("1.0.0", true);
      }
      await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);
      await step("05-installed-ui-card");
      await startDraftFromProject(getE2EAppDataPaths().workspace);
      await prepareV4ConversationE2E();
      await startDraftFromProject(getE2EAppDataPaths().workspace);
      await selectUpstreamModel();
      expect((await getV4PaneSnapshot()).sessionId).toBe("draft");
      let sessionId: string | undefined;
      // 主导航市场进入根草稿，右侧市场使用所属 pane。
      const openSidePaneMarket = async (stepLabel?: string) => {
        if (sessionId) await selectV4TaskById(sessionId);
        const addTab = browser.$("[data-side-pane-add-tab-trigger]");
        if (await addTab.isDisplayed().catch(() => false)) {
          await addTab.click();
          await browser.$('[data-state="active"] [data-testid="side-pane-plugin-market"]').click();
        } else {
          // 多工作区会保留隐藏 pane；只点击当前可见按钮，避免切换旧 pane 后误判布局溢出。
          await clickPluginControl(TID_SIDE_PANE_TOGGLE);
          await waitForPluginControl("side-pane-ui-recommendations");
          // 启动页内容必须完整落在窗口内：「查看所有插件」右边缘不能被面板裁切。
          await browser.waitUntil(
            async () =>
              browser.execute(() => {
                const button = Array.from(
                  document.querySelectorAll<HTMLElement>('[data-testid="side-pane-plugin-market"]'),
                ).find((element) => element.checkVisibility());
                const rect = button?.getBoundingClientRect();
                return Boolean(rect && rect.width > 0 && rect.right <= window.innerWidth);
              }),
            { timeout: 10000, timeoutMsg: "Side Pane 启动页内容超出窗口" },
          );
          if (stepLabel) await step(stepLabel);
          await clickPluginControl("side-pane-plugin-market");
        }
        await waitForPluginControl("plugin-store-root");
        await clickPluginControl("plugin-store-segment-personal");
        await waitForPluginControl("plugin-store-open-ui", { pluginId: PLUGIN_LIFECYCLE_ID });
      };
      const selectMainWorkspaceScope = async () => {
        await browser.$('[data-testid="plugin-settings-scope-trigger"]').click();
        // 项目已移入设备子菜单；先展开本机项目，仍按原工作区身份选择。
        const projects = browser.$(
          '[data-scope-projects-trigger="true"][data-scope-device="local"]',
        );
        await projects.waitForDisplayed();
        await projects.click();
        await browser.$('[data-testid^="plugin-settings-scope-option"]').waitForDisplayed();
        await browser.execute((workspacePath) => {
          const option = Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid^="plugin-settings-scope-option"]'),
          ).find((item) => item.dataset.pluginScopeKey === workspacePath);
          if (!option) throw new Error("项目管理缺少原工作区");
          option.click();
        }, getE2EAppDataPaths().workspace);
        await browser.waitUntil(
          async () =>
            (await browser.$('[data-testid="plugin-settings-scope-trigger"]').getText()).includes(
              "ZCodeProject",
            ),
          { timeout: 10000 },
        );
      };
      const openCardDetail = async () => {
        await clickPluginControl("plugin-store-card", { pluginId: PLUGIN_LIFECYCLE_ID });
        await waitForPluginControl("plugin-store-detail");
      };
      const waitForSandboxReady = () =>
        browser.waitUntil(
          async () =>
            (await browser.electron.execute(async (electron) => {
              const guests = electron.webContents
                .getAllWebContents()
                .filter((guest) => guest.getURL().startsWith("zcode-sandbox://"));
              for (const guest of guests) {
                for (const frame of guest.mainFrame.frames) {
                  const ready = await frame
                    .executeJavaScript('document.getElementById("market-ui-ready")?.textContent')
                    .catch(() => null);
                  if (ready === "PLUGIN_MARKET_UI_READY") return true;
                }
              }
              return false;
            })) === true,
          { timeout: 60000, timeoutMsg: "真实插件沙箱没有完成握手" },
        );

      // 不发送首轮消息，直接从主导航打开插件，保留原输入。
      await setV4ComposerText("unsent draft text");
      await openPluginSettings();
      await clickPluginControl("plugin-store-segment-personal");
      await waitForPluginControl("plugin-store-open-ui", { pluginId: PLUGIN_LIFECYCLE_ID });
      await clickPluginControl("plugin-store-open-ui", { pluginId: PLUGIN_LIFECYCLE_ID });
      await waitForSandboxReady();
      await waitForV4Pane((snapshot) => snapshot.sessionId === "draft", "市场没有返回根草稿");
      const guestId = await browser.electron.execute(async (electron) => {
        for (const guest of electron.webContents.getAllWebContents()) {
          if (!guest.getURL().startsWith("zcode-sandbox://")) continue;
          for (const frame of guest.mainFrame.frames) {
            const ready = await frame
              .executeJavaScript('document.getElementById("market-ui-ready")?.textContent')
              .catch(() => null);
            if (ready !== "PLUGIN_MARKET_UI_READY") continue;
            await frame.executeJavaScript(
              'void window.zcode.callTool("version_marker", {}).then(result => { window.__draftToolResult = result; }, error => { window.__draftToolResult = {error:String(error)}; })',
            );
            await frame.executeJavaScript('window.__draftUiMarker = "unsaved"');
            return guest.id;
          }
        }
        throw new Error("缺少插件 guest");
      });
      expect(await approveV4Permission()).toBe(true);
      const evaluateGuest = (script: string) =>
        browser.electron.execute(
          async (electron, id, code) => {
            const guest = electron.webContents.fromId(id);
            const frame = guest?.mainFrame.frames.find((item) =>
              item.url.startsWith("zcode-sandbox://plugin-"),
            );
            if (!frame) throw new Error("原插件 frame 已释放");
            return frame.executeJavaScript(code);
          },
          guestId,
          script,
        );
      await browser.waitUntil(
        async () =>
          String(await evaluateGuest("JSON.stringify(window.__draftToolResult)")).includes("1.0.0"),
        { timeout: 15000, timeoutMsg: "批准后未收到工具结果" },
      );
      await evaluateGuest(
        'void window.zcode.callTool("version_marker", {}).then(result => { window.__draftDeniedResult = result; }, error => { window.__draftDeniedResult = {error:String(error)}; })',
      );
      await denyV4PermissionWithFeedback("deny draft test");
      await browser.waitUntil(
        async () =>
          Boolean(
            await evaluateGuest(
              "window.__draftDeniedResult?.error || window.__draftDeniedResult?.isError",
            ),
          ),
        { timeout: 15000, timeoutMsg: "拒绝没有回传给原插件" },
      );
      // 真实草稿没有 session 父行；完全访问不能为绕过外键提前创建正式任务。
      const draftTabId = await browser
        .$('[data-side-pane-tab-id^="plugin-ui:"]')
        .getAttribute("data-side-pane-tab-id");
      if (!draftTabId) throw new Error("缺少草稿插件标签身份");
      const draftSessionId = decodeURIComponent(draftTabId.split(":")[2]!);
      const readDraftRows = () => {
        const db = new DatabaseSync(
          join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"),
          { readOnly: true },
        );
        try {
          return {
            sessions: db
              .prepare("select count(*) as n from session where id = ?")
              .get(draftSessionId)!.n,
            entries: db
              .prepare("select count(*) as n from session_entry where session_id = ?")
              .get(draftSessionId)!.n,
          };
        } finally {
          db.close();
        }
      };
      await evaluateGuest(
        'void window.zcode.callTool("version_marker", {}).then(result => { window.__draftFullAccessResult = result; }, error => { window.__draftFullAccessResult = {error:String(error)}; })',
      );
      await waitForV4PermissionDialog();
      // 新审批默认切换为 guarded；先显式选择完全访问，再验证风险确认和草稿不落盘。
      await browser.$('[data-testid="permission-target-picker"]').click();
      await browser.$('[data-testid="permission-target-yolo"]').click();
      const fullAccess = browser.$('[data-testid="permission-allow-switch"]');
      await fullAccess.click();
      const confirmation = browser.$('[data-testid="yolo-confirmation-dialog"]');
      await confirmation.waitForDisplayed({ timeout: 15000 });
      const confirmGrant = browser.$('[data-testid="yolo-confirmation-confirm"]');
      expect(await confirmGrant.isEnabled()).toBe(false);
      expect((await getV4ConfigProjection()).mode).not.toBe("yolo");
      await browser.$('[data-testid="yolo-confirmation-risk"]').click();
      await confirmGrant.waitForClickable();
      await confirmGrant.click();
      await confirmation.waitForDisplayed({ reverse: true });
      await browser.waitUntil(
        async () =>
          String(await evaluateGuest("JSON.stringify(window.__draftFullAccessResult)")).includes(
            "1.0.0",
          ),
        { timeout: 15000, timeoutMsg: "草稿完全访问审批失败" },
      );
      await browser.waitUntil(async () => (await getV4ConfigProjection()).mode === "yolo", {
        timeout: 10000,
        timeoutMsg: "草稿输入框未同步完全访问",
      });
      expect(readDraftRows()).toEqual({ sessions: 0, entries: 0 });
      await evaluateGuest(
        'void window.zcode.callTool("version_marker", {}).then(result => { window.__draftAfterGrantResult = result; })',
      );
      await browser.waitUntil(
        async () =>
          String(await evaluateGuest("JSON.stringify(window.__draftAfterGrantResult)")).includes(
            "1.0.0",
          ),
        { timeout: 15000, timeoutMsg: "授权后再次调用仍被审批阻塞" },
      );
      await step("06a-draft-full-access-without-task");
      await evaluateGuest(
        'window.zcode.updateModelContext({content:[{type:"text",text:"draft-plugin-context"}]})',
      );
      expect((await getV4PaneSnapshot()).sessionId).toBe("draft");
      expect((await getV4PaneSnapshot()).rowCount).toBe(0);
      expect(await getV4ComposerText()).toBe("unsent draft text");
      await step("06-main-nav-opens-draft-ui");
      // 草稿右侧市场复用同一页面；关闭可见标签不释放 guest。
      await browser.$('[data-side-pane-tab-id^="plugin-ui:"] button').click();
      await openSidePaneMarket();
      await clickPluginControl("plugin-store-open-ui", { pluginId: PLUGIN_LIFECYCLE_ID });
      await browser.$('[data-side-pane-tab-id^="plugin-ui:"]').waitForDisplayed();
      expect(await evaluateGuest("window.__draftUiMarker")).toBe("unsaved");
      await browser.execute(() =>
        document
          .querySelector<HTMLButtonElement>('[data-side-pane-tab-id="plugin-market"] button')
          ?.click(),
      );
      // 完整视图只改变布局，不能重建草稿插件或丢失未发送输入。
      for (const mode of ["floating", "normal"]) {
        await browser.$(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_TOGGLE}"]`).click();
        await browser.waitUntil(
          async () =>
            (await browser
              .$(`[data-testid="${TID_SIDE_PANE_FULL_VIEW_HOST}"]`)
              .getAttribute("data-side-pane-full-view-host")) === mode,
          { timeout: 5_000, timeoutMsg: `完整视图未切换到 ${mode}` },
        );
        expect(await evaluateGuest("window.__draftUiMarker")).toBe("unsaved");
      }
      expect(await getV4ComposerText()).toBe("unsent draft text");
      expect((await getV4PaneSnapshot()).rowCount).toBe(0);
      await step("06b-full-view-preserves-draft-ui");
      // 真正切换工作区，使原 pane 卸载后再返回。
      const draftOther = join(getE2EAppDataPaths().homeDir, "fixtures", "draft-other");
      await mkdir(draftOther, { recursive: true });
      await browser.$('[data-testid="project-section"]').moveTo();
      await browser.$('[data-testid="virtual-project-add"]').click();
      await browser.$('[data-testid="virtual-project-name"]').waitForDisplayed();
      await browser.$('[data-testid="virtual-project-name"]').setValue("draft-other");
      await selectNativeProjectDirectories([draftOther]);
      await browser.$('[data-testid="virtual-project-save"]').click();
      await browser.$('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
      await browser.$('[data-testid="project-folder-trust-confirm"]').click();
      await startDraftFromProject(draftOther);
      await startDraftFromProject(getE2EAppDataPaths().workspace);
      await waitForV4Pane((snapshot) => snapshot.sessionId === "draft", "没有回到原工作区草稿");
      expect(await evaluateGuest("window.__draftUiMarker")).toBe("unsaved");
      expect(await getV4ComposerText()).toBe("unsent draft text");
      await browser.$('[data-testid="plugin-ui-model-context-chip"]').waitForDisplayed();
      // 离开再回到草稿不应创建新 guest；首发提升继续使用原页面。
      await openPluginSettings();
      await clickPluginControl("plugin-store-segment-personal");
      await clickPluginControl("plugin-store-open-ui", { pluginId: PLUGIN_LIFECYCLE_ID });
      await waitForSandboxReady();
      await waitForV4Pane((snapshot) => snapshot.sessionId === "draft", "市场没有返回根草稿");
      expect(await getV4ComposerText()).toBe("unsent draft text");
      await sendV4Prompt("E2E_PLUGIN_MARKET_SESSION_READY");
      await waitForV4AssistantMessageContaining("plugin-market-session-ready");
      sessionId = (await getV4PaneSnapshot()).sessionId ?? "draft";
      if (!sessionId || sessionId === "draft") throw new Error("草稿没有提升为正式会话");
      expect(sessionId).toBe(draftSessionId);
      expect((await getV4ConfigProjection()).mode).toBe("yolo");
      expect(readDraftRows().sessions).toBe(1);
      await evaluateGuest(
        'void window.zcode.callTool("version_marker", {}).then(result => { window.__promotedToolResult = result; })',
      );
      await browser.waitUntil(
        async () =>
          String(await evaluateGuest("JSON.stringify(window.__promotedToolResult)")).includes(
            "1.0.0",
          ),
        { timeout: 15000, timeoutMsg: "首发后权限回退或原插件失效" },
      );
      expect(
        await browser.electron.execute(async (electron, id) => {
          const guest = electron.webContents.fromId(id);
          if (!guest) return false;
          for (const frame of guest.mainFrame.frames) {
            if (
              await frame
                .executeJavaScript('window.__draftUiMarker === "unsaved"')
                .catch(() => false)
            )
              return true;
          }
          return false;
        }, guestId),
      ).toBe(true);
      await step("07-draft-promoted-with-same-guest");

      // 暂停真实预热 RPC，再用真实导航离开；旧请求不能落到下一份同项目草稿。
      for (const [boundary, navigateAway] of [
        ["task", () => selectV4TaskById(sessionId!)],
        ["workspace", () => startDraftFromProject(draftOther)],
      ] as const) {
        await selectV4TaskById(sessionId);
        await browser.execute(() => {
          const original = MessagePort.prototype.postMessage;
          const held: Array<() => void> = [];
          const gate = {
            count: 0,
            restore() {
              MessagePort.prototype.postMessage = original;
              held.splice(0).forEach((send) => send());
              delete window.__draftPluginUiCreateGate;
            },
          };
          MessagePort.prototype.postMessage = function (
            this: MessagePort,
            ...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]
          ) {
            const forward = () => Reflect.apply(original, this, args);
            const data = args[0];
            const bytes =
              data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : ArrayBuffer.isView(data)
                  ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                  : null;
            const wire = bytes ? new TextDecoder().decode(bytes) : "";
            if (
              wire.includes("sendConversationCommandV4") &&
              wire.includes('"type":"createSession"')
            ) {
              gate.count++;
              held.push(forward);
            } else forward();
          };
          window.__draftPluginUiCreateGate = gate;
        });
        try {
          await openPluginSettings();
          await clickPluginControl("plugin-store-segment-personal");
          await clickPluginControl("plugin-store-open-ui", { pluginId: PLUGIN_LIFECYCLE_ID });
          await browser.waitUntil(
            () => browser.execute(() => Boolean(window.__draftPluginUiCreateGate?.count)),
            { timeout: 15000, timeoutMsg: "未拦住草稿预热" },
          );
          expect(
            await browser.execute(
              (workspacePath) =>
                Boolean(
                  (window as DraftUiWindow)
                    .__zcodeSessionStoreE2E!.getState()
                    .getWorkspaceState(workspacePath).pluginUiOpenRequest,
                ),
              getE2EAppDataPaths().workspace,
            ),
          ).toBe(true);
          await navigateAway();
          expect(
            await browser.execute(
              (workspacePath) =>
                (window as DraftUiWindow)
                  .__zcodeSessionStoreE2E!.getState()
                  .getWorkspaceState(workspacePath).pluginUiOpenRequest,
              getE2EAppDataPaths().workspace,
            ),
          ).toBeNull();
        } finally {
          await browser.execute(() => window.__draftPluginUiCreateGate?.restore());
        }
        await startDraftFromProject(getE2EAppDataPaths().workspace);
        await waitForV4Pane((snapshot) => snapshot.sessionId === "draft", "未返回新草稿");
        // 启动页推荐区由有效插件 session 控制；旧 draftRuntime 不代表 V4 预热就绪。
        if (
          !(await browser
            .$("[data-side-pane-add-tab-trigger]")
            .isDisplayed()
            .catch(() => false))
        )
          await clickPluginControl(TID_SIDE_PANE_TOGGLE);
        await waitForPluginControl("side-pane-ui-recommendations");
        expect(
          await browser
            .$('[data-side-pane-tab-id^="plugin-ui:"]')
            .isDisplayed()
            .catch(() => false),
        ).toBe(false);
        expect(await evaluateGuest("window.__draftUiMarker")).toBe("unsaved");
        await step(`07b-stale-open-cancelled-on-${boundary}`);
      }

      // 会话右侧市场：卡片多一个「打开」，在当前会话的右侧标签打开 UI。
      await openSidePaneMarket("08-side-pane-launcher");
      await step("09-side-pane-market-open-button");
      await clickPluginControl("plugin-store-open-ui", { pluginId: PLUGIN_LIFECYCLE_ID });
      await browser.$('[data-side-pane-tab-id^="plugin-ui:"]').waitForDisplayed({ timeout: 30000 });
      await waitForSandboxReady();
      await step("10-ui-opened-in-session");
      await browser.execute(() => {
        const tab = document.querySelector<HTMLElement>('[data-side-pane-tab-id^="plugin-ui:"]');
        const close = tab?.querySelector<HTMLButtonElement>("button");
        if (!close) throw new Error("UI 面板缺少关闭按钮");
        close.click();
      });
      expect(
        (await getPluginOverview()).installedPlugins.some(
          (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
        ),
      ).toBe(true);
      await browser.$('[data-side-pane-tab-id="plugin-market"]').click();
      await openManageView();
      expect(await browser.$$('[role="tab"][id$="-trigger-mcps"]')).toHaveLength(0);
      // 管理列表异步加载：等「打开」出现在插件行内，避免截到「加载中」。
      await browser
        .$(
          `[data-testid="plugin-settings-plugin-row"][data-plugin-id="${PLUGIN_LIFECYCLE_ID}"] [data-testid="plugin-store-open-ui"]`,
        )
        .waitForDisplayed({ timeout: 15000 });
      await step("11-side-pane-manage-open-button");
      await clickPluginControl("plugin-store-manage-back");
      await browser.$('[data-side-pane-tab-id="plugin-market"] button').click();

      // 项目内暂停：两个市场均提供启用并打开；右侧市场按钮显示「启用」，先启用再打开。
      await openPluginSettings();
      await openManageView();
      await selectMainWorkspaceScope();
      await waitForPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID });
      await setPluginEnabledThroughUi(PLUGIN_LIFECYCLE_ID, false, "manage");
      const { workspace, homeDir } = getE2EAppDataPaths();
      const other = join(homeDir, "fixtures", "other-project");
      await mkdir(other, { recursive: true });
      expect(
        (await getPluginList(workspace, undefined, "user")).plugins.find(
          (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
        )?.enabled,
      ).toBe(true);
      expect(
        (await getPluginList(other)).plugins.find((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID)
          ?.enabled,
      ).toBe(true);
      await browser.$('[data-testid="plugin-store-manage-back"]').scrollIntoView();
      await step("12-project-override");
      await clickPluginControl("plugin-store-manage-back");
      await clickPluginControl("plugin-store-segment-personal");
      await openCardDetail();
      expect(
        (await getPluginList()).plugins.find((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID)
          ?.enabled,
      ).toBe(false);
      await waitForPluginControl("plugin-store-open-ui", { pluginId: PLUGIN_LIFECYCLE_ID });
      await step("13-paused-main-nav-detail");
      await openSidePaneMarket();
      await step("14-side-pane-paused-enable-button");
      await clickPluginControl("plugin-store-open-ui", { pluginId: PLUGIN_LIFECYCLE_ID });
      await browser.waitUntil(
        async () =>
          (await getPluginList()).plugins.find((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID)
            ?.enabled === true,
        { timeout: 30000, timeoutMsg: "暂停的 UI 插件没有先启用" },
      );
      await browser.$('[data-side-pane-tab-id^="plugin-ui:"]').waitForDisplayed({ timeout: 30000 });
      await step("15-paused-enables-and-opens");
      // 关掉右侧市场标签：会话视图在主导航后台保持挂载，两份市场同时存在会让按 testid 取到隐藏的那份。
      // 非激活标签的关闭按钮被遮挡，走 DOM 点击。
      await browser.execute(() => {
        const close = document.querySelector<HTMLButtonElement>(
          '[data-side-pane-tab-id="plugin-market"] button',
        );
        if (!close) throw new Error("右侧市场标签缺少关闭按钮");
        close.click();
      });
      await browser
        .$('[data-side-pane-tab-id="plugin-market"]')
        .waitForExist({ reverse: true, timeout: 10000 });

      // 管理页的行同样整行进入详情，再从详情恢复继承与卸载。
      await openPluginSettings();
      await openManageView();
      await selectMainWorkspaceScope();
      expect(await browser.$$('[data-testid="plugin-settings-ui-details"]')).toHaveLength(0);
      await waitForPluginControl("plugin-store-open-ui", { pluginId: PLUGIN_LIFECYCLE_ID });
      // 切换作用域后列表会重新加载，等插件行出现再点。
      await waitForPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID });
      await browser.execute((pluginId) => {
        const row = document.querySelector(
          `[data-testid="plugin-settings-plugin-row"][data-plugin-id="${pluginId}"] [data-testid="plugin-store-card"]`,
        );
        if (!(row instanceof HTMLElement)) throw new Error("管理页缺少插件行");
        row.click();
      }, PLUGIN_LIFECYCLE_ID);
      await waitForPluginControl("plugin-store-detail");
      await clickPluginControl("plugin-store-reset-config");
      await browser.waitUntil(
        async () => {
          const plugin = (await getPluginList()).plugins.find(
            (item) => item.id === PLUGIN_LIFECYCLE_ID,
          );
          return plugin?.enabled === true && plugin.enabledSource === "user";
        },
        { timeout: 30000, timeoutMsg: "项目配置没有恢复继承全局" },
      );
      await clickPluginControl("plugin-store-item-menu", { pluginId: PLUGIN_LIFECYCLE_ID });
      await step("16-more-menu");
      await browser.keys(["Escape"]);
      // 菜单关闭完成后再走卸载 helper，否则 helper 的点击会把仍在关闭的菜单切回关闭态。
      await browser
        .$('[data-testid="plugin-store-menu-uninstall"]')
        .waitForDisplayed({ reverse: true, timeout: 10000 });
      await uninstallPluginThroughUi(PLUGIN_LIFECYCLE_ID, false);
      await uninstallPluginThroughUi(PLUGIN_LIFECYCLE_ID, true);
    } finally {
      const result = await recording.stop({ tailDurationMs: 500 });
      await writeFile(
        join(ARTIFACT_DIR, "plm-ui-001.chapters.json"),
        JSON.stringify(
          { videoPath: result.videoPath, frameCount: result.frameCount, chapters },
          null,
          2,
        ),
      );
    }
  });
});
