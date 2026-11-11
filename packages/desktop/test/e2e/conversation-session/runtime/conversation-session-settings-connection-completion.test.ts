import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity, ServiceChannels } from "@zcode/shared";
import {
  TID_DOCKER_CONTAINER_INPUT,
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_REMOTE_KIND_DOCKER,
  TID_REMOTE_KIND_SSH,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SSH_DIALOG,
  TID_SSH_HOST_INPUT,
  TID_SSH_PASSWORD_INPUT,
  TID_SSH_CONFIG_ALIAS_CHIP,
  TID_SSH_CONFIG_IMPORT,
  TID_REMOTE_NEW_CONNECTION_PREVIEW,
  TID_SSH_PORT_INPUT,
  TID_SSH_USERNAME_INPUT,
  TID_DOCKER_CONTAINER_SELECT,
  TID_SSH_SUCCESS,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import type { RemoteProjectDirectory } from "@zcode/services";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import {
  requestRemoteProjectConnection,
  selectRemoteDeviceMenuItem,
} from "#e2e/helpers/remote-project-actions";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  readSSHRuntimeConfig,
  createFirstConnectionStallingSSHProxy,
  connectSSHWorkspace,
  waitForRemoteTab,
  waitForSSHError,
  waitForSSHDirectoryStep,
} from "#e2e/helpers/ssh-remote-p0";

const marker = "E2E_SETTINGS_CONNECTION_COMPLETION";

async function dialogTop() {
  return browser.execute(
    () =>
      document
        .querySelector('[data-testid="ssh-dialog"]')
        ?.closest('[role="dialog"]')
        ?.getBoundingClientRect().top ?? null,
  );
}

/** 用真实 ClipboardEvent 模拟粘贴，覆盖主机框的 onPaste 拆分（RDUX-27）。 */
async function pasteIntoHost(text: string) {
  return browser.execute(
    (hostTestId, value) => {
      const host = document.querySelector<HTMLInputElement>(`[data-testid="${hostTestId}"]`)!;
      host.focus();
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", value);
      const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
      host.dispatchEvent(event);
      return event.defaultPrevented;
    },
    TID_SSH_HOST_INPUT,
    text,
  );
}

async function measureAddingForm() {
  return browser.execute(() => {
    const submit = document
      .querySelector('[data-testid="ssh-dialog"] button[type="submit"]')
      ?.getBoundingClientRect();
    const dialogElement = document
      .querySelector('[data-testid="ssh-dialog"]')
      ?.closest('[role="dialog"]');
    const dialog = dialogElement?.getBoundingClientRect();
    const scroll = document.querySelector('[data-testid="remote-connection-settings-scroll"]');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      dialog: dialog?.toJSON(),
      transition: dialogElement
        ? {
            property: getComputedStyle(dialogElement).transitionProperty,
            duration: getComputedStyle(dialogElement).transitionDuration,
            animations: dialogElement.getAnimations({ subtree: true }).map((animation) => ({
              playState: animation.playState,
              duration: animation.effect?.getComputedTiming().duration,
              iterations: animation.effect?.getComputedTiming().iterations,
            })),
          }
        : null,
      submit: submit?.toJSON(),
      scroll: scroll
        ? {
            bounds: scroll.getBoundingClientRect().toJSON(),
            contentHeight: scroll.scrollHeight,
            clientHeight: scroll.clientHeight,
          }
        : null,
      visible: Boolean(
        submit && submit.width > 0 && submit.right <= innerWidth && submit.bottom <= innerHeight,
      ),
    };
  });
}

async function captureAddingForms(kind: string) {
  const artifacts = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!);
  await mkdir(artifacts, { recursive: true });
  for (const locale of ["zh-CN", "en-US"]) {
    for (const theme of ["light", "dark"]) {
      await browser.execute(
        (language, color) => {
          const actions = (
            window as Window & {
              __testActions?: {
                setLocale(locale: string): void;
                setTheme(theme: string): void;
              };
            }
          ).__testActions;
          actions?.setLocale(language);
          actions?.setTheme(color);
        },
        locale,
        theme,
      );
      for (const width of [1440, 480]) {
        await browser.electron.execute((electron, size) => {
          electron.BrowserWindow.getAllWindows()
            .find((window) => window.isVisible())
            ?.setSize(size, 900);
        }, width);
        const beforeLayout = await measureAddingForm();
        // 等待 resize 的布局帧，不用超时猜测 DOM 已更新。
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        // 尺寸过渡可能长于两帧，等待浏览器动画完成事件，不能把中间宽度当成稳定布局。
        await browser.executeAsync((done) => {
          const dialog = document
            .querySelector('[data-testid="ssh-dialog"]')
            ?.closest('[role="dialog"]');
          const animations = (dialog?.getAnimations({ subtree: true }) ?? []).filter(
            (animation) =>
              animation.playState === "running" &&
              animation.effect?.getComputedTiming().iterations !== Infinity,
          );
          void Promise.all(
            animations.map((animation) => animation.finished.catch(() => undefined)),
          ).then(() => requestAnimationFrame(() => done()));
        });
        const afterLayout = await measureAddingForm();
        await browser.saveScreenshot(
          resolve(artifacts, `adding-${kind}-${locale}-${theme}-${width}.png`),
        );
        await writeFile(
          resolve(artifacts, `adding-${kind}-${locale}-${theme}-${width}.json`),
          JSON.stringify({ beforeLayout, afterLayout }),
        );
        expect(afterLayout.visible).toBe(true);
      }
    }
  }
  await browser.electron.execute((electron) => {
    electron.BrowserWindow.getAllWindows()
      .find((window) => window.isVisible())
      ?.setSize(1440, 900);
  });
  await browser.execute(() =>
    (
      window as Window & { __testActions?: { setLocale(locale: string): void } }
    ).__testActions?.setLocale("zh-CN"),
  );
}
const settingsContent = "[data-settings-content-frame]";

/** RDUX-13：断开在设备行「更多」菜单里；未指定时取唯一的设备行。 */
async function disconnectDevice(sourceId?: string) {
  const id =
    sourceId ?? (await $("[data-source-server-card]").getAttribute("data-source-server-card"));
  if (!id) throw new Error(`${marker}: 缺少设备行`);
  await selectRemoteDeviceMenuItem(id, ["断开", "Disconnect"], marker);
}

async function clickButton(label: string, scope = settingsContent) {
  const button = $(scope).$(`.//button[normalize-space(.)=${JSON.stringify(label)}]`);
  await button.waitForClickable({ timeout: 20_000 });
  await button.click();
}

async function counts() {
  const localProjects = await callHandoffHost<unknown[]>(ServiceChannels.Project, "readProjects");
  const directory = await callHandoffHost<RemoteProjectDirectory>(
    ServiceChannels.RemoteProjects,
    "readDirectory",
  );
  const workspaceScopes = await browser.execute(() => {
    const store = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState(): {
            tabs: Array<{ type: string; workspacePath?: string; workspaceIdentity?: string }>;
          };
        };
      }
    ).__zcodeTabStoreE2E;
    if (!store) throw new Error("E2E tab store unavailable");
    return store
      .getState()
      .tabs.filter((tab) => tab.type === "workspace" && tab.workspacePath)
      .map((tab) => ({
        workspacePath: tab.workspacePath!,
        workspaceIdentity: tab.workspaceIdentity,
      }));
  });
  const tasks = await callHandoffHost<{ total: number }>(
    ServiceChannels.WindowController,
    "listTaskList",
    [{ kind: "timeline", workspaceScopes, sortBy: "updated" }],
  );
  return { projects: localProjects.length + directory.entries.length, tasks: tasks.total };
}

async function openSettings() {
  await ensureSettingsSidebar();
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
}

async function ensureSettingsSidebar() {
  if (!(await $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).isDisplayed())) {
    // 窄屏截图会收起工作区侧栏，恢复窗口宽度并不自动展开；通过真实按钮恢复入口。
    await $('button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]').click();
  }
  await $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).waitForDisplayed();
}

async function expectDeviceCompletion(before: Awaited<ReturnType<typeof counts>>, devices = 1) {
  expect(await waitForSSHDirectoryStep(marker)).toBe("closed");
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed();
  await $("[data-source-server-card] [data-remote-connection-status=online]").waitForExist({
    timeout: 30_000,
  });
  expect(await $$('[data-testid="virtual-project-name"]').length).toBe(0);
  expect(await $$(`[data-testid="${TID_SSH_SUCCESS}"]`).length).toBe(0);
  expect(await $$("[data-source-server-card]").length).toBe(devices);
  // RDUX-13：完成后定位到设备行：焦点在设备名按钮上，该行展开并高亮。
  expect(
    await browser.execute(() => {
      const toggle = document.activeElement;
      return (
        toggle?.matches("[data-source-server-card] [data-source-server-toggle]") === true &&
        toggle.getAttribute("aria-expanded") === "true" &&
        toggle.closest("[data-source-server-card]")?.hasAttribute("data-highlighted") === true
      );
    }),
  ).toBe(true);
  // 设置页卸载项目树；返回侧栏，并通过真实 Host 服务核对持久化项目与任务数量。
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  await ensureSettingsSidebar();
  const after = await counts();
  expect(after).toEqual(before);
  await openSettings();
  return after;
}

let settingsE2EPrepared = false;
/** 同一 spec 只准备一次 App；单独筛选运行某个场景时也能自行完成准备。 */
async function prepareSettingsE2E() {
  if (settingsE2EPrepared) return;
  await prepareV4ConversationE2E({ skipProvider: true });
  await browser.execute(() => {
    (
      window as Window & { __testActions?: { setLocale(locale: string): void } }
    ).__testActions?.setLocale("zh-CN");
  });
  await installHandoffRpcProbe();
  settingsE2EPrepared = true;
}

/** 编辑连接弹窗以「保存更改」按钮定位，避免和向导弹窗混淆。 */
const editConnectionDialog = '//div[@role="dialog"][.//button[normalize-space(.)="保存更改"]]';

async function replaceInputValue(selector: string, value: string) {
  const input = $(selector);
  await input.click();
  await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
  await browser.keys("Backspace");
  if (value) await input.addValue(value);
}

describe(`${marker}: 设置内连接独立完成`, () => {
  after(async () => {
    await restoreHandoffProbes();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RDUX15-10/18/21 SSH 添加、普通重连与在线复用、Docker 添加保持设置和项目数量", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(marker);
    const container = process.env.ZCODE_E2E_SSH_CONTAINER;
    if (!container) throw new Error(`${marker}: ZCODE_E2E_SSH_CONTAINER required`);
    const home = process.env.ZCODE_E2E_HOME_DIR;
    if (!home) throw new Error("isolated E2E home required");
    await mkdir(resolve(home, ".ssh"), { recursive: true });
    await writeFile(
      resolve(home, ".ssh", "config"),
      [
        "Host e2e-device-addition",
        `  HostName ${config.host}`,
        `  Port ${config.port}`,
        `  User ${config.username}`,
        "",
      ].join("\n"),
    );
    await prepareSettingsE2E();
    const before = await counts();
    await openSettings();
    await clickButton("新建连接");
    // 设置新建直接是默认 SSH 表单；不得先出现已保存设备统一列表。
    await $(
      `[data-testid="${TID_SSH_DIALOG}"] [data-testid="${TID_SSH_HOST_INPUT}"]`,
    ).waitForDisplayed();
    // RDUX-27：设置入口没有步骤条和说明句，焦点在主机，头部显示目标占位。
    expect(await browser.execute(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      TID_SSH_HOST_INPUT,
    );
    expect(await $(`[data-testid="${TID_SSH_DIALOG}"] nav`).isExisting()).toBe(false);
    expect(await $(`[data-testid="${TID_REMOTE_NEW_CONNECTION_PREVIEW}"]`).getText()).toBe(
      "user@host:22",
    );
    // 空表单提交：错误在字段下方、焦点回到主机，不发起连接。
    await $('[data-testid="ssh-dialog"] button[type="submit"]').click();
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${TID_SSH_HOST_INPUT}"]`).getAttribute("aria-invalid")) === "true",
      { timeout: 5_000, timeoutMsg: `${marker}: 主机未标记为错误` },
    );
    const hostErrorId = await $(`[data-testid="${TID_SSH_HOST_INPUT}"]`).getAttribute(
      "aria-describedby",
    );
    expect(await $(`[id="${hostErrorId}"]`).getText()).toBe("请输入主机");
    expect(await browser.execute(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      TID_SSH_HOST_INPUT,
    );
    expect(await $$("[data-source-server-card]").length).toBe(0);
    expect(await $(`[data-testid="${TID_REMOTE_KIND_SSH}"]`).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(await $(`[data-testid="${TID_REMOTE_KIND_DOCKER}"]`).isDisplayed()).toBe(true);
    // 分类切换使用真实 Tab / Enter；焦点可见，选择不会触发连接。
    for (const kindId of [TID_REMOTE_KIND_DOCKER, TID_REMOTE_KIND_SSH]) {
      for (let step = 0; step < 30; step += 1) {
        if (
          await browser.execute(
            (id) => document.activeElement?.getAttribute("data-testid") === id,
            kindId,
          )
        )
          break;
        await browser.keys("Tab");
      }
      expect(
        await browser.execute(
          (id) => document.activeElement?.getAttribute("data-testid") === id,
          kindId,
        ),
      ).toBe(true);
      // 全局样式已禁用 focus outline（2bb283f474），这里改为确认处于键盘可见焦点态，
      // 分段控件在该状态下用背景提示焦点。
      expect(await browser.execute(() => document.activeElement!.matches(":focus-visible"))).toBe(
        true,
      );
      await browser.keys("Enter");
      expect(await $(`[data-testid="${kindId}"]`).getAttribute("aria-pressed")).toBe("true");
      expect(await $$("[data-source-server-card]").length).toBe(0);
    }
    expect(await $('[data-testid="remote-kind-wsl"]').isExisting()).toBe(
      process.platform === "win32",
    );
    await $(`[data-testid="${TID_SSH_CONFIG_IMPORT}"]`).waitForEnabled({ timeout: 30_000 });
    await $(`[data-testid="${TID_SSH_CONFIG_IMPORT}"]`).click();
    const alias = $("//*[@cmdk-item and .//*[normalize-space(.)='e2e-device-addition']]");
    // 候选仍走真实本机 SSH config 发现；选中后不拨号。
    await alias.waitForDisplayed();
    await alias.click();
    expect(await $(`[data-testid="${TID_SSH_HOST_INPUT}"]`).getValue()).toBe(config.host);
    expect(await $(`[data-testid="${TID_SSH_CONFIG_ALIAS_CHIP}"]`).getText()).toContain(
      "已关联 Host e2e-device-addition",
    );
    expect(await $(`[data-testid="${TID_REMOTE_NEW_CONNECTION_PREVIEW}"]`).getText()).toBe(
      `${config.username}@${config.host}:${config.port}`,
    );
    // config Host 未提供私钥，导入后焦点移到第一个空必填项：密码。
    expect(await browser.execute(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      TID_SSH_PASSWORD_INPUT,
    );
    expect(await $$("[data-source-server-card]").length).toBe(0);
    // 切换认证方式会改变表单高度，弹窗上边缘保持不动。
    const topBeforeAuthSwitch = await dialogTop();
    await $('[data-testid="ssh-auth-private-key"]').click();
    expect(await dialogTop()).toBe(topBeforeAuthSwitch);
    await $('[data-testid="ssh-auth-password"]').click();
    expect(await dialogTop()).toBe(topBeforeAuthSwitch);
    await captureAddingForms("ssh");
    await $(`[data-testid="${TID_SSH_PASSWORD_INPUT}"]`).setValue(`${config.password}-wrong`);
    await clickLastEnabledSSHDialogButton(marker);
    await waitForSSHError(marker, 90_000);
    expect(await $$("[data-source-server-card]").length).toBe(0);
    // 认证失败不能声称凭据已保存；修正同一表单后沿原连接流程重试。
    expect(await $('[data-testid="ssh-error"]').getText()).not.toContain("凭据已保存");
    await clickButton("返回配置", '[data-testid="ssh-dialog"]');
    await $(`[data-testid="${TID_SSH_PASSWORD_INPUT}"]`).setValue(config.password);
    expect(await $('[data-testid="ssh-dialog"] button[type="submit"]').getText()).toBe(
      "添加并连接",
    );
    await clickLastEnabledSSHDialogButton(marker);
    const afterSSH = await expectDeviceCompletion(before);

    // 普通断开/重连必须复用已保存 Profile，不能自动打开目录或项目编辑器。
    await disconnectDevice();
    await $("[data-source-server-card] [data-remote-connection-status=offline]").waitForExist();
    await clickButton("连接");
    const afterReconnect = await expectDeviceCompletion(before);

    // alias 与手填可以形成不同 Profile；第二条线路用真实凭据识别同一 Source，不新增设备。
    await clickButton("新建连接");
    await clickTestIdByDom(TID_REMOTE_KIND_SSH);
    // 粘贴 user@host:port 一次拆出三个字段（RDUX-27）；不匹配的文本按原样粘贴。
    expect(await pasteIntoHost(`${config.username}@${config.host}:${config.port}`)).toBe(true);
    expect(await $(`[data-testid="${TID_SSH_HOST_INPUT}"]`).getValue()).toBe(config.host);
    expect(await $(`[data-testid="${TID_SSH_USERNAME_INPUT}"]`).getValue()).toBe(config.username);
    expect(await $(`[data-testid="${TID_SSH_PORT_INPUT}"]`).getValue()).toBe(String(config.port));
    expect(await $(`[data-testid="${TID_SSH_DIALOG}"]`).getText()).toContain(
      `已识别 ${config.username}@${config.host}:${config.port}`,
    );
    expect(await browser.execute(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      TID_SSH_PASSWORD_INPUT,
    );
    expect(await pasteIntoHost(config.host)).toBe(false);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(marker);
    await expectDeviceCompletion(before);
    // 已识别的同一手填线路再次复用，不使用新密码认证，也不能新增设备或项目。
    await clickButton("新建连接");
    await fillSSHPasswordSettings({ ...config, password: "unused-reuse-password" });
    await clickLastEnabledSSHDialogButton(marker);
    const afterReuse = await expectDeviceCompletion(before);

    // Docker 默认进入 root，和 SSH 的 dev 是独立数据环境；两台设备均留在设置管理。
    await clickButton("新建连接");
    await clickTestIdByDom(TID_REMOTE_KIND_DOCKER);
    await clickButton("选择运行中的容器", '[data-testid="ssh-dialog"]');
    // Docker 类型切换使用类型色；说明段已删除，限制提示放在选择器下方。
    expect(await $(`[data-testid="${TID_REMOTE_KIND_DOCKER}"]`).getAttribute("class")).toContain(
      "bg-remote-docker-surface",
    );
    expect(await $(`[data-testid="${TID_SSH_DIALOG}"]`).getText()).not.toContain(
      "连接本机 Docker 容器。",
    );
    await $(`[data-testid="${TID_DOCKER_CONTAINER_SELECT}"]`).click();
    const dockerOption = $(
      `//*[@cmdk-item and .//*[normalize-space(.)=${JSON.stringify(container)}]]`,
    );
    await dockerOption.waitForDisplayed();
    await dockerOption.click();
    expect(await $$("[data-source-server-card]").length).toBe(1);
    await captureAddingForms("docker");
    await clickLastEnabledSSHDialogButton(marker);
    const afterDocker = await expectDeviceCompletion(before, 2);
    await clickButton("新建连接");
    await clickTestIdByDom(TID_REMOTE_KIND_DOCKER);
    await $(`[data-testid="${TID_DOCKER_CONTAINER_INPUT}"]`).setValue(container);
    await clickLastEnabledSSHDialogButton(marker);
    await expectDeviceCompletion(before, 2);

    const stalled = await createFirstConnectionStallingSSHProxy(config, marker);
    try {
      await clickButton("新建连接");
      await clickTestIdByDom(TID_REMOTE_KIND_SSH);
      await fillSSHPasswordSettings({ ...config, host: "127.0.0.1", port: stalled.port });
      await clickLastEnabledSSHDialogButton(marker);
      await stalled.firstConnectionAccepted;
      await browser.keys("Escape");
      await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
      await stalled.waitForFirstConnectionClosed();
      await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForExist({ reverse: true });
      await $("[data-source-server-card] [data-remote-connection-status=online]").waitForExist();
      expect(await $$("[data-source-server-card]").length).toBe(2);
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
      expect(await counts()).toEqual(before);
      await openSettings();
    } finally {
      await stalled.close();
    }

    await $("[data-source-server-card]").moveTo();
    await browser.waitUntil(
      async () => !(await $("body").getText()).includes("已直接使用现有连接"),
      { timeout: 15_000, timeoutMsg: "复用提示未收起" },
    );
    const artifacts = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!);
    await mkdir(artifacts, { recursive: true });
    for (const locale of ["zh-CN", "en-US"]) {
      for (const theme of ["light", "dark"]) {
        await browser.execute(
          (language, color) => {
            const actions = (
              window as Window & {
                __testActions?: { setLocale(locale: string): void; setTheme(theme: string): void };
              }
            ).__testActions;
            actions?.setLocale(language);
            actions?.setTheme(color);
          },
          locale,
          theme,
        );
        for (const width of [1440, 480]) {
          await browser.electron.execute((electron, size) => {
            electron.BrowserWindow.getAllWindows()
              .find((window) => window.isVisible())
              ?.setSize(size, 900);
          }, width);
          await browser.saveScreenshot(
            resolve(artifacts, `settings-${locale}-${theme}-${width}.png`),
          );
        }
      }
    }
    await writeFile(
      resolve(artifacts, "settings-completion-facts.json"),
      JSON.stringify(
        {
          before,
          afterSSH,
          afterReconnect,
          afterDocker,
          afterReuse,
          transports: ["ssh", "docker"],
          dialogClosed: !(await $(`[data-testid="${TID_SSH_DIALOG}"]`).isExisting()),
        },
        null,
        2,
      ),
    );
  });

  it("RDUX15-22 侧栏明确连接原项目，在重连后保留原 identity 和项目数量", async function () {
    this.timeout(10 * 60_000);
    const config = readSSHRuntimeConfig(marker);
    await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows()
        .find((window) => window.isVisible())
        ?.setSize(1440, 900),
    );
    await browser.execute(() =>
      (
        window as Window & { __testActions?: { setLocale(locale: string): void } }
      ).__testActions?.setLocale("zh-CN"),
    );
    // 前一场景失败时也先通过真实关闭操作释放表单，避免级联前置失败掩盖本场景结果。
    if (await $(`[data-testid="${TID_SSH_DIALOG}"]`).isExisting()) {
      await clickButton("关闭", '[data-testid="ssh-dialog"]');
      if (await $(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`).isExisting()) {
        await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
      }
      await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForExist({ reverse: true });
    }
    if (await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isExisting()) {
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    }
    await ensureSettingsSidebar();
    const original = await connectSSHWorkspace({
      config,
      workspacePath: config.workspacePaths[0],
      caseMarker: marker,
    });
    const before = await counts();
    await openSettings();
    // 设备按最近使用排序，可能存在多台设备；按原项目所属 Source 断开。
    const originalSourceId = parseRemoteWorkspaceIdentity(
      original.workspaceIdentity!,
    )?.sourceServerId;
    if (!originalSourceId) throw new Error(`${marker}: 缺少原项目设备身份`);
    await disconnectDevice(originalSourceId);
    await $(
      `[data-source-server-card="${originalSourceId}"] [data-remote-connection-status=offline]`,
    ).waitForExist();
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await requestRemoteProjectConnection(original.workspaceIdentity!, marker);
    await waitForSSHDirectoryStep(marker);
    const restored = await waitForRemoteTab({
      caseMarker: marker,
      expectedIdentity: original.workspaceIdentity!,
      expectedPath: config.workspacePaths[0],
    });
    expect(restored.workspaceIdentity).toBe(original.workspaceIdentity);
    expect(await $$("[data-testid=virtual-project-name]").length).toBe(0);
    expect(await counts()).toEqual(before);
  });
  it("RDUX27-1 修改主机入口：校验失败时焦点落在真正出错的字段", async function () {
    this.timeout(10 * 60_000);
    const config = readSSHRuntimeConfig(marker);
    await prepareSettingsE2E();
    if (await $(`[data-testid="${TID_SSH_DIALOG}"]`).isExisting()) {
      await clickButton("关闭", '[data-testid="ssh-dialog"]');
      if (await $(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`).isExisting()) {
        await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
      }
      await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForExist({ reverse: true });
    }
    if (!(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isExisting())) await openSettings();
    // 手填真实 SSH 线路；已存在同一线路时复用，不影响本场景。
    await clickButton("新建连接");
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(marker);
    // 首次连接全新容器会经过安装确认，由共享 helper 处理到设置内完成（弹窗关闭）。
    expect(await waitForSSHDirectoryStep(marker)).toBe("closed");
    const card = $(
      `//*[@data-source-server-card][.//*[@data-remote-connection-status]][contains(normalize-space(.), ${JSON.stringify(config.host)})]`,
    );
    await card.waitForExist({ timeout: 30_000 });
    const cardSourceId = await card.getAttribute("data-source-server-card");
    if (!cardSourceId) throw new Error(`${marker}: 缺少设备行`);
    await disconnectDevice(cardSourceId);
    await card.$('[data-remote-connection-status="offline"]').waitForExist({ timeout: 30_000 });

    // 主机改成不可解析的 .invalid 域名，连接后由真实 ENOTFOUND 给出「修改主机」操作。
    const missingHost = "zcode-e2e-missing.invalid";
    await selectRemoteDeviceMenuItem(cardSourceId, ["编辑", "Edit"], marker);
    await $(editConnectionDialog).waitForDisplayed();
    await replaceInputValue(
      `${editConnectionDialog}//*[@data-testid="${TID_SSH_HOST_INPUT}"]`,
      missingHost,
    );
    await $(editConnectionDialog).$('.//button[normalize-space(.)="保存更改"]').click();
    await $(editConnectionDialog).waitForExist({ reverse: true });
    const missingCard = $(
      `//*[@data-source-server-card][contains(normalize-space(.), ${JSON.stringify(missingHost)})]`,
    );
    await missingCard.waitForExist({ timeout: 30_000 });
    await missingCard.$('.//button[normalize-space(.)="连接"]').click();
    const editHost = missingCard.$('.//button[normalize-space(.)="修改主机"]');
    // 设置内连接会打开向导展示失败；关闭向导后回到卡片，用卡片的「修改主机」进入编辑弹窗。
    await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForExist({ timeout: 30_000 });
    await $(`[data-testid="${TID_SSH_DIALOG}"]`)
      .$('.//*[contains(normalize-space(.), "找不到主机")]')
      .waitForExist({ timeout: 120_000 });
    await clickButton("关闭", '[data-testid="ssh-dialog"]');
    if (await $(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`).isExisting()) {
      await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
    }
    await $(`[data-testid="${TID_SSH_DIALOG}"]`).waitForExist({ reverse: true });
    await editHost.waitForClickable({ timeout: 30_000 });
    await editHost.click();
    await $(editConnectionDialog).waitForDisplayed();

    // 入口把主机标为待修改；用户名才是本次真正的校验错误，焦点必须给用户名。
    const username = `${editConnectionDialog}//*[@data-testid="${TID_SSH_USERNAME_INPUT}"]`;
    await replaceInputValue(username, "");
    await $(editConnectionDialog).$('.//button[normalize-space(.)="保存更改"]').click();
    await browser.waitUntil(
      async () => (await $(username).getAttribute("aria-invalid")) === "true",
      { timeout: 5_000, timeoutMsg: `${marker}: 用户名未标记为错误` },
    );
    const usernameErrorId = await $(username).getAttribute("aria-describedby");
    expect(await $(`[id="${usernameErrorId}"]`).getText()).toBe("请输入用户名");
    expect(await browser.execute(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      TID_SSH_USERNAME_INPUT,
    );
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "edit-host-validation-focus.png"),
    );

    // 恢复真实线路，保存成功后弹窗关闭。
    await replaceInputValue(username, config.username);
    await replaceInputValue(
      `${editConnectionDialog}//*[@data-testid="${TID_SSH_HOST_INPUT}"]`,
      config.host,
    );
    await $(editConnectionDialog).$('.//button[normalize-space(.)="保存更改"]').click();
    await $(editConnectionDialog).waitForExist({ reverse: true });
  });
});
