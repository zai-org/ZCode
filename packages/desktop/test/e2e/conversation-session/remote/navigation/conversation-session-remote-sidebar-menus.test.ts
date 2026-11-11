import {
  disconnectRemoteSource,
  requestRemoteProjectConnection,
  selectRemoteDeviceMenuItem,
} from "#e2e/helpers/remote-project-actions";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import { ServiceChannels } from "@zcode/shared";
import {
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  testId,
  TID_SETTINGS_BACK_BUTTON,
  TID_SSH_DIALOG,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  readSettings,
  waitForWorkspaceApp,
  DEFAULT_WORKSPACE,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  openSSHSourceDirectory,
  readSSHRuntimeConfig,
  prepareSSHConnectionPage,
  selectSSHRemoteDirectory,
  waitForSSHDirectoryStep,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";

const CASE_MARKER = "E2E_REMOTE_SIDEBAR_MENUS";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-sidebar-menus",
);

async function buttonIn(selector: string, labels: RegExp) {
  let found: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      for (const button of await $(selector).$$("button")) {
        if ((await button.isDisplayed()) && labels.test((await button.getText()).trim())) {
          found = button;
          return true;
        }
      }
      return false;
    },
    { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: missing action ${labels}` },
  );
  return found!;
}

async function openDeviceSettings(sourceId: string) {
  if (!(await $('[data-testid="settings-page"]').isDisplayed())) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  }
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
  const card = $(`[data-source-server-card="${sourceId}"]`);
  await card.waitForDisplayed();
  return card;
}

async function waitForDetailsReady() {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const card = document.querySelector(
          '[data-testid="remote-identity-details"][data-state="open"]',
        );
        return Boolean(
          card &&
          getComputedStyle(card).opacity === "1" &&
          card.getAnimations().every((animation) => animation.playState !== "running"),
        );
      }),
    { timeout: 5000, timeoutMsg: "身份详情未完成展开" },
  );
}

async function captureMatrix(state: string, identity: string) {
  for (const locale of ["zh-CN", "en-US"] as const) {
    for (const theme of ["zai-light", "zai-dark"]) {
      await browser.execute(
        (lang, appearance) => {
          const actions = (
            window as Window & {
              __testActions?: {
                setLocale(value: "zh-CN" | "en-US"): void;
                setTheme(value: string): void;
              };
            }
          ).__testActions;
          if (!actions) throw new Error("Missing appearance actions");
          actions.setLocale(lang);
          actions.setTheme(appearance);
        },
        locale,
        theme,
      );
      for (const width of [1400, 900]) {
        await browser.electron.execute((electron, nextWidth) => {
          electron.BrowserWindow.getAllWindows()
            .find((window) => !window.isDestroyed())
            ?.setSize(nextWidth, 900);
        }, width);
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        // Escape 会关闭当前悬停浮层；下一轮必须真正离开再进入，不能把原地 moveTo 当成新的进入事件。
        const outside = await browser.execute(() => ({ x: innerWidth - 24, y: 24 }));
        await browser.action("pointer").move(outside).perform();
        const row = $(`[data-project-workspace-identity="${identity}"]`);
        await row.$('[data-testid="virtual-project-toggle"]').moveTo();
        const details = $('[data-testid="remote-identity-details"]');
        await details.waitForDisplayed();
        expect(await details.$$("dt").map((field) => field.getText())).toEqual(
          locale === "zh-CN"
            ? ["设备", "连接", "地址", "目录"]
            : ["Device", "Connection", "Address", "Directory"],
        );
        expect(await details.$$("button")).toHaveLength(0);
        await browser.saveScreenshot(
          resolve(artifactDir, `identity-${state}-${locale}-${theme}-${width}.png`),
        );
        await row.$('[data-testid="virtual-project-menu"]').click();
        const menu = $('[role="menu"][data-state="open"]');
        await menu.waitForDisplayed();
        const geometry = await browser.execute(() => {
          const card = document
            .querySelector('[role="menu"][data-state="open"]')!
            .getBoundingClientRect();
          return {
            left: card.left,
            top: card.top,
            right: card.right,
            bottom: card.bottom,
            width: innerWidth,
            height: innerHeight,
          };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.width);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
        // 新项目模型把设备详情放在设置页，侧栏菜单保留按连接状态提供的项目操作。
        expect(await $('[data-testid="virtual-project-connect"]').isExisting()).toBe(
          state === "offline",
        );
        await browser.saveScreenshot(
          resolve(artifactDir, `${state}-${locale}-${theme}-${width}.png`),
        );
        await browser.keys("Escape");
        // 显示结束时菜单仍可能保留退出动画和模态指针锁；卸载后才进入下一个菜单。
        await menu.waitForExist({ reverse: true });
        await browser.action("pointer").move(outside).perform();
        await details.waitForExist({ reverse: true });
        for (const scrollable of [true, false]) {
          // 侧栏归还焦点后可能重开提示；用键盘进入输入框菜单，详情仍由真实鼠标悬停验证。
          await browser.execute(() =>
            document
              .querySelector<HTMLButtonElement>('[data-testid="composer-workspace-trigger"]')!
              .focus(),
          );
          await browser.keys("Enter");
          const composerMenu = $('[data-testid="composer-project-menu"]');
          await composerMenu.waitForDisplayed();
          // 受控搜索框用真实键盘清空，确保下一轮恢复完整列表和滚动条。
          await composerMenu.$("input").click();
          await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
          await browser.keys("Backspace");
          if (!scrollable)
            await composerMenu.$("input").setValue((await row.getAttribute("data-project-name"))!);
          const option = composerMenu.$(
            `[data-project-id="${await row.getAttribute("data-project-id")}"]`,
          );
          await option.scrollIntoView();
          // 离线选项禁止点击，悬停由外层触发区承接；列表滚动条曾让详情左沿落入菜单下方。
          await option.$("..").moveTo();
          await details.waitForDisplayed();
          await waitForDetailsReady();
          const visibility = await browser.execute(() => {
            const card = document.querySelector('[data-testid="remote-identity-details"]')!;
            const menu = document.querySelector('[data-testid="composer-project-menu"]')!;
            const bounds = card.getBoundingClientRect();
            const menuBounds = menu.getBoundingClientRect();
            const scroller = menu.querySelector('[role="menuitemcheckbox"]')!.parentElement!
              .parentElement!;
            const points = [
              [bounds.left + 2, bounds.top + 16],
              [bounds.right - 2, bounds.top + 16],
              [bounds.left + 2, bounds.bottom - 16],
              [bounds.right - 2, bounds.bottom - 16],
              [bounds.left + 2, (bounds.top + bounds.bottom) / 2],
              [bounds.right - 2, (bounds.top + bounds.bottom) / 2],
            ];
            return {
              gap:
                card.getAttribute("data-side") === "left"
                  ? menuBounds.left - bounds.right
                  : bounds.left - menuBounds.right,
              scrollable: scroller.scrollHeight > scroller.clientHeight,
              overlap:
                Math.max(
                  0,
                  Math.min(bounds.right, menuBounds.right) - Math.max(bounds.left, menuBounds.left),
                ) *
                Math.max(
                  0,
                  Math.min(bounds.bottom, menuBounds.bottom) - Math.max(bounds.top, menuBounds.top),
                ),
              occluded: points.filter(
                ([x, y]) => !card.contains(document.elementFromPoint(x!, y!)),
              ),
              inViewport:
                bounds.left >= 0 &&
                bounds.top >= 0 &&
                bounds.right <= innerWidth &&
                bounds.bottom <= innerHeight,
            };
          });
          expect(visibility.scrollable).toBe(scrollable);
          expect(Math.abs(visibility.gap - 4)).toBeLessThan(0.6);
          expect(visibility.overlap).toBe(0);
          expect(visibility.occluded).toEqual([]);
          expect(visibility.inViewport).toBe(true);
          await details.moveTo();
          await waitForDetailsReady();
          await browser.saveScreenshot(
            resolve(
              artifactDir,
              `composer-identity-${state}-${locale}-${theme}-${width}-${scrollable ? "scroll" : "no-scroll"}.png`,
            ),
          );
          await browser.action("pointer").move(outside).perform();
          await details.waitForDisplayed({ reverse: true });
          await browser.keys("Escape");
          await composerMenu.waitForExist({ reverse: true });
        }
      }
    }
  }
  await browser.execute(() => {
    (
      window as Window & { __testActions?: { setLocale(value: "zh-CN"): void } }
    ).__testActions?.setLocale("zh-CN");
  });
}

describe(`${CASE_MARKER}: 侧栏详情和设备菜单`, () => {
  afterEach(async () => {
    await browser.saveScreenshot(resolve(artifactDir, "last-state.png"));
  });
  after(async () => {
    await restoreHandoffProbes();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RDUX-SIDEBAR 在线无项目设备可选目录，详情可定位设置并在原项目重连", async function () {
    this.timeout(15 * 60_000);
    await mkdir(artifactDir, { recursive: true });
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const path = config.workspacePaths[0];
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    // 初始字段与设备操作断言使用中文；不依赖 runner 的默认语言。
    await browser.execute(() => {
      (
        window as Window & { __testActions?: { setLocale(value: "zh-CN"): void } }
      ).__testActions!.setLocale("zh-CN");
    });
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    // 新增设备完成后回到原项目草稿；关闭未保存草稿，保留已连接且没有项目成员的设备。
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    await browser.keys("Escape");
    await $('[data-testid="virtual-project-name"]').waitForDisplayed({ reverse: true });
    const server = (await readSettings()).sourceServers?.[0];
    if (!server) throw new Error(`${CASE_MARKER}: connected device not saved`);
    expect(await $$("[data-project-workspace-identity]")).toHaveLength(0);
    const initialCard = await openDeviceSettings(server.sourceServerId);
    expect(await initialCard.getText()).toContain(server.displayName);
    await openSSHSourceDirectory(config, CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(path, CASE_MARKER);
    await waitForWorkspaceApp(path, 120_000);
    const tab = await waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: path });
    const rowSelector = `[data-project-workspace-identity="${tab.workspaceIdentity}"]`;
    await installHandoffRpcProbe();
    // 通过真实项目服务增加列表项，固定覆盖原生滚动条参与定位的场景。
    for (let index = 0; index < 10; index++) {
      await callHandoffHost(ServiceChannels.Project, "saveProject", [
        { name: `${CASE_MARKER}_SCROLL_${index}`, roots: [] },
      ]);
    }
    await browser.waitUntil(
      async () => (await $(rowSelector).getAttribute("data-connection-state")) === "online",
      { timeout: 30_000 },
    );
    const deviceLabel = $(rowSelector).$('[data-testid="project-device"]');
    expect(await deviceLabel.getText()).toBe(server.displayName);
    await $(rowSelector).$('[data-testid="virtual-project-toggle"]').moveTo();
    const details = $('[data-testid="remote-identity-details"]');
    await details.waitForDisplayed();
    expect(await details.getText()).toContain(server.displayName);
    expect(await details.$$("dt").map((field) => field.getText())).toEqual([
      "设备",
      "连接",
      "地址",
      "目录",
    ]);
    expect(await details.$("strong").getText()).toBe(
      await $(rowSelector).getAttribute("data-project-name"),
    );
    expect(await details.getText()).toContain(path);
    expect(await details.$$("button")).toHaveLength(0);
    await details.moveTo();
    expect(await details.isDisplayed()).toBe(true);
    // 选中文字曾触发 HoverCard 的选区锁定，移出后仍遮挡界面；真实双击保留复制能力。
    await details.$("dd:last-child div").doubleClick();
    const selectedPath = await browser.execute(() => window.getSelection()?.toString() ?? "");
    expect(selectedPath.trim().length).toBeGreaterThan(0);
    expect(path).toContain(selectedPath.trim());
    // 浮层可能盖住聊天项目按钮；移到视口右上角，确保鼠标真正离开触发区域和浮层。
    const outside = await browser.execute(() => ({ x: innerWidth - 24, y: 24 }));
    await browser.action("pointer").move(outside).perform();
    await details.waitForDisplayed({ reverse: true });
    await $('[data-testid="composer-workspace-trigger"]').click();
    const option = $(
      `[data-testid="composer-project-menu"] [data-project-host="${await $(rowSelector).getAttribute("data-project-host")}"]`,
    );
    await option.waitForDisplayed();
    expect(await option.getText()).toContain(server.displayName);
    await option.moveTo();
    await details.waitForDisplayed();
    expect(await details.getText()).toContain(path);
    await browser.keys("Escape");
    await details.waitForDisplayed({ reverse: true });
    await browser.keys("Escape");
    const card = await openDeviceSettings(server.sourceServerId);
    await card.$('button[aria-label="更多"]').click();
    await $("[data-device-info]").waitForDisplayed();
    await browser.saveScreenshot(resolve(artifactDir, "device-info.png"));
    await browser.keys("Escape");
    // RDUX-13：编辑在设备行「更多」菜单里。
    await selectRemoteDeviceMenuItem(server.sourceServerId, ["编辑", "Edit"], CASE_MARKER);
    const editor = $('[role="dialog"][data-slot="dialog-content"]');
    await editor.waitForDisplayed();
    expect(await editor.getText()).toMatch(/编辑连接|Edit connection/u);
    await (
      await buttonIn('[role="dialog"][data-slot="dialog-content"]', /^(取消|Cancel)$/u)
    ).click();
    await editor.waitForDisplayed({ reverse: true });
    await browser.saveScreenshot(resolve(artifactDir, "managed-device.png"));
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await captureMatrix("online", tab.workspaceIdentity!);
    await disconnectRemoteSource(server.sourceServerId, CASE_MARKER, {
      workspaceIdentities: [tab.workspaceIdentity!],
    });
    await browser.waitUntil(
      async () => (await $(rowSelector).getAttribute("data-connection-state")) === "offline",
      { timeout: 30_000 },
    );
    // 当前远端断线时输入框不可操作；从本地草稿验证菜单内离线项目，覆盖实际可用入口。
    const localProject = $('[data-project-name="ZCodeProject"]');
    await localProject.moveTo();
    await localProject.$('[data-testid="virtual-project-create-task"]').click();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    await captureMatrix("offline", tab.workspaceIdentity!);
    await requestRemoteProjectConnection(tab.workspaceIdentity!, CASE_MARKER);
    await browser.waitUntil(
      async () => (await $(rowSelector).getAttribute("data-connection-state")) === "online",
      { timeout: 90_000 },
    );
    expect(await $(`[data-testid="${TID_SSH_DIALOG}"]`).isDisplayed()).toBe(false);
    // 重连仍恢复原远端 tab；菜单回归已切到本地草稿，后台恢复不能夺走本地活动页。
    const reconnected = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: path,
      expectedIdentity: tab.workspaceIdentity!,
      requireActive: false,
    });
    expect(reconnected.workspaceIdentity).toBe(tab.workspaceIdentity);
    expect(reconnected.activeWorkspacePath).toBe(DEFAULT_WORKSPACE);
    await $(rowSelector).$('[data-testid="virtual-project-menu"]').click();
    await browser.keys("Escape");
    // hover/焦点提示“更多”是正常状态，不等于菜单残留；Escape 应关闭菜单并归还焦点。
    await $('[role="menu"]').waitForDisplayed({ reverse: true });
    await browser.waitUntil(
      () =>
        browser.execute(
          (selector) =>
            document.activeElement ===
            document.querySelector(`${selector} [data-testid="virtual-project-menu"]`),
          rowSelector,
        ),
      { timeout: 5000, timeoutMsg: "关闭项目菜单后焦点未返回触发器" },
    );
  });
});
