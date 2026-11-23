import { setRendererViewport } from "#e2e/helpers/renderer-viewport";
import { startProjectPointerDrag } from "#e2e/helpers/project-sidebar";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_BACK_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  readSettings,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { waitForRendererAfterColdRestart } from "#e2e/helpers/ssh-remote-lifecycle";
import {
  openSSHRemoteDialog,
  fillSSHPasswordSettings,
  prepareSSHConnectionPage,
  readSSHRuntimeConfig,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";

const marker = "E2E_REMOTE_ACCESSIBILITY";
const artifact = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-accessibility",
);
const dialog = '[data-testid="ssh-dialog"]';

/** 真正按 Tab 到目标，不用 focus()/click() 代替键盘流程。 */
async function tabTo(selector: string, label?: string) {
  for (let index = 0; index < 90; index += 1) {
    await browser.keys("Tab");
    const matched = await browser.execute(
      (query, name) => {
        const active = document.activeElement;
        return Boolean(
          active?.matches(query) &&
          (!name ||
            active.getAttribute("aria-label") === name ||
            active.textContent?.trim() === name),
        );
      },
      selector,
      label,
    );
    if (matched) return;
  }
  const diagnostic = await browser.execute(
    (query) => ({
      active:
        document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName,
      activeRole: document.activeElement?.getAttribute("role"),
      candidates: [...document.querySelectorAll<HTMLElement>(query)].map((element) => ({
        tabIndex: element.tabIndex,
        hidden: !element.getClientRects().length,
        role: element.getAttribute("role"),
      })),
      openPopovers: document.querySelectorAll('[data-slot="popover-content"][data-state="open"]')
        .length,
    }),
    selector,
  );
  await browser.saveScreenshot(resolve(artifact, "keyboard-failure.png"));
  throw new Error(
    `Keyboard target unavailable: ${selector} ${label ?? ""}: ${JSON.stringify(diagnostic)}`,
  );
}
async function activate(selector: string, label?: string) {
  await tabTo(selector, label);
  await browser.keys("Enter");
}

async function assertLogTimestampContrast(captureName: string) {
  const measurements = await browser.execute(() => {
    const context = document.createElement("canvas").getContext("2d")!;
    const color = (css: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const luminance = (rgb: number[]) =>
      rgb.slice(0, 3).reduce((sum, value, index) => {
        const channel = value / 255;
        const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
      }, 0);
    return [...document.querySelectorAll<HTMLElement>("[data-source-server-log-timestamp]")]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const foreground = color(getComputedStyle(element).color);
        // 日志的 surface 可以半透明；必须叠加真实祖先背景，不能假设日志节点本身不透明。
        const layers: Array<{ node: string; css: string; rgba: number[] }> = [];
        for (let node: HTMLElement | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (Number(style.opacity) !== 1 || style.backgroundImage !== "none") {
            throw new Error("Contrast probe requires solid backgrounds and element opacity 1");
          }
          const rgba = color(style.backgroundColor);
          layers.push({ node: node.tagName, css: style.backgroundColor, rgba });
          if (rgba[3] === 255) break;
        }
        if (layers.at(-1)?.rgba[3] !== 255) throw new Error("No opaque ancestor background");
        const background = layers.toReversed().reduce(
          (base, layer) => {
            const alpha = layer.rgba[3]! / 255;
            return base.map((channel, index) => layer.rgba[index]! * alpha + channel * (1 - alpha));
          },
          [0, 0, 0],
        );
        const alpha = foreground[3]! / 255;
        const text = foreground.map(
          (value, index) => value * alpha + background[index]! * (1 - alpha),
        );
        const a = luminance(text);
        const b = luminance(background);
        return {
          foreground,
          background,
          layers,
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        };
      });
  });
  await writeFile(
    resolve(artifact, `contrast-${captureName}.json`),
    JSON.stringify(measurements, null, 2),
  );
  expect(measurements.length).toBeGreaterThan(0);
  for (const { ratio } of measurements) expect(ratio).toBeGreaterThanOrEqual(4.5);
}

async function capture(state: string) {
  for (const locale of ["zh-CN", "en-US"] as const) {
    for (const theme of ["light", "dark"]) {
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
        // macOS 限制原生窗口高度；响应式覆盖使用真实 renderer viewport。
        await setRendererViewport(width, 1000);
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        const sidebarWidth = await browser.execute(() => {
          const shell = document.querySelector<HTMLElement>('[style*="--workspace-sidebar-width"]');
          return shell
            ? getComputedStyle(shell).getPropertyValue("--workspace-sidebar-width").trim()
            : null;
        });
        expect(sidebarWidth).toBe("264px");
        if (state === "settings") await assertLogTimestampContrast(`${locale}-${theme}-${width}`);
        await browser.saveScreenshot(resolve(artifact, `${state}-${locale}-${theme}-${width}.png`));
      }
    }
  }
  await browser.execute(() =>
    (
      window as Window & { __testActions?: { setLocale(value: "zh-CN"): void } }
    ).__testActions?.setLocale("zh-CN"),
  );
}

describe(`${marker}: 远程键盘与视觉矩阵`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RDUX-A11Y 仅键盘完成连接、选目录、侧栏与设置操作", async function () {
    this.timeout(15 * 60_000);
    await mkdir(artifact, { recursive: true });
    const config = readSSHRuntimeConfig(marker);
    await prepareSSHConnectionPage(marker);
    await prepareV4ConversationE2E({ skipProvider: true });
    await browser.execute(() => {
      localStorage.setItem("zcode:workspace-shell:sidebar-width-px", "264");
      (
        window as Window & {
          __testActions?: { setLocale(value: "zh-CN"): void };
        }
      ).__testActions?.setLocale("zh-CN");
    });
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await browser.refresh();
    // 本步骤只重载侧栏宽度；草稿导航不保证恢复到默认项目，不应成为无障碍场景的额外前置。
    await waitForRendererAfterColdRestart(marker);
    const projectCountBefore = await $$("[data-project-id]").length;
    await openSSHRemoteDialog(marker, { entry: "settings" });
    await fillSSHPasswordSettings(config);
    // 键盘验收时将指针停在非交互区域，避免窗口缩放把 hover 入口移到指针下。
    await browser.performActions([
      {
        type: "pointer",
        id: "park",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", x: 1, y: 1, duration: 0 }],
      },
    ]);
    await activate(`${dialog} button`, "显示密码");
    expect(await $(`${dialog} [data-testid="ssh-password-input"]`).getAttribute("type")).toBe(
      "text",
    );
    await activate(`${dialog} button`, "隐藏密码");
    await activate(`${dialog} button`, "高级选项");
    const group = $(`${dialog} [role="group"][aria-labelledby$="ssh.assetInstallMode"]`);
    // 展开状态先更新，动画随后才使安装方式可见；旧 case 在 Enter 返回后立即读可见性会误报。
    await group.$('button[aria-pressed="true"]').waitForDisplayed({ timeout: 5000 });
    expect(await group.$('button[aria-pressed="true"]').isDisplayed()).toBe(true);
    await tabTo(
      `${dialog} [role="group"][aria-labelledby$="ssh.assetInstallMode"] button[aria-pressed="false"]`,
    );
    // 全局强制描边已回退；键盘流程仍需实际获得焦点，不再要求组件叠加 outline。
    expect(await browser.execute(() => document.activeElement!.matches(":focus-visible"))).toBe(
      true,
    );
    await browser.keys("Enter");
    await activate(
      `${dialog} [role="group"][aria-labelledby$="ssh.assetInstallMode"] button[aria-pressed="false"]`,
    );
    await capture("form");
    await activate(`${dialog} button[type="submit"]`);
    // 设置添加只管理设备；旧 case 等待目录页会阻断后续全部键盘断言。
    // 首装和首次说明都由键盘确认，再从项目入口单独选择设备与目录。
    await browser.waitUntil(
      async () =>
        (await $(dialog).$("button*=安装并继续").isDisplayed()) ||
        (await $('[data-testid="source-server-boundary-dialog"]').isDisplayed()) ||
        !(await $(dialog).isExisting()),
      { timeout: 120_000 },
    );
    if (await $(dialog).$("button*=安装并继续").isDisplayed()) {
      await capture("install");
      await activate(`${dialog} button`, "安装并继续");
    }
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="source-server-boundary-dialog"]').isDisplayed()) ||
        !(await $(dialog).isExisting()),
      { timeout: 180_000, timeoutMsg: `${marker}: 设置添加未到达首次说明或完成状态` },
    );
    if (await $('[data-testid="source-server-boundary-dialog"]').isDisplayed()) {
      await activate(
        '[data-testid="source-server-boundary-dialog"] [data-testid="confirm-dialog-confirm"]',
      );
    }
    await $(dialog).waitForExist({ reverse: true });
    expect(await $('[data-testid="settings-page"]').isDisplayed()).toBe(true);
    expect(await $('[data-testid="ssh-success"]').isExisting()).toBe(false);
    expect(await $$("[data-project-id]").length).toBe(projectCountBefore);
    const settings = await readSettings();
    const profile = settings.connectionProfiles?.find(
      (item) =>
        item.target.kind === "ssh" &&
        item.target.host === config.host &&
        (item.target.port ?? 22) === config.port &&
        item.target.username === config.username &&
        item.lifecycleState !== "retired",
    );
    if (!profile?.sourceServerId) throw new Error(`${marker}: 设置添加未保存目标设备身份`);
    const hostId = `remote:server:${profile.sourceServerId}`;
    await $(`[data-source-server-card="${profile.sourceServerId}"]`)
      .$('[data-remote-connection-status="online"]')
      .waitForDisplayed();
    await activate(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`);
    await activate('[data-testid="virtual-project-add"]');
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    await activate('[data-testid="virtual-project-device"]');
    await $(`[role="option"][data-device-id="${hostId}"]`).waitForDisplayed();
    for (let index = 0; index < 50; index += 1) {
      if (
        await browser.execute(
          (id) => document.activeElement?.getAttribute("data-device-id") === id,
          hostId,
        )
      )
        break;
      await browser.keys("ArrowDown");
    }
    expect(
      await browser.execute(() => document.activeElement?.getAttribute("data-device-id")),
    ).toBe(hostId);
    await browser.keys("Enter");
    await activate('[data-testid="virtual-project-browse"]');
    const directory = '[data-testid="virtual-project-directory-browser"]';
    await $(directory).waitForDisplayed();
    await capture("directory");
    await tabTo(`${directory} input[aria-label="输入路径"]`);
    await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
    await browser.keys("Backspace");
    await browser.keys(config.workspacePaths[0]);
    await browser.keys("Enter");
    await $(`${directory} [data-testid="directory-browser-confirm"]`).waitForEnabled();
    expect(await $(`${directory} input[aria-label="输入路径"]`).getValue()).toBe(
      config.workspacePaths[0],
    );
    await activate(`${directory} [data-testid="directory-browser-confirm"]`);
    // 新目录会进入项目编辑器；继续用键盘保存并从项目创建任务，不能借全局本地草稿。
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    expect(await $('[data-testid="virtual-project-root-name"]').getAttribute("title")).toBe(
      config.workspacePaths[0],
    );
    await activate('[data-testid="virtual-project-save"]');
    await activate('[data-testid="project-folder-trust-confirm"]');
    const remoteRow = `[data-project-workspace-identity="${hostId}:${config.workspacePaths[0]}"]`;
    await $(remoteRow).waitForDisplayed();
    await activate(`${remoteRow} [data-testid="virtual-project-create-task"]`);
    await waitForWorkspaceApp(config.workspacePaths[0], 120_000);
    const tab = await waitForRemoteTab({
      caseMarker: marker,
      expectedPath: config.workspacePaths[0],
    });
    const row = `[data-project-workspace-identity="${tab.workspaceIdentity}"]`;
    // 项目详情改由项目编辑器承载，设备信息在设置页；保留键盘打开、关闭和路径验证。
    await activate(`${row} [data-testid="virtual-project-menu"]`);
    let editFocused = false;
    for (let index = 0; index < 10; index++) {
      await browser.keys("ArrowDown");
      editFocused = await browser.execute(
        () => document.activeElement?.getAttribute("data-testid") === "virtual-project-edit",
      );
      if (editFocused) break;
    }
    expect(editFocused).toBe(true);
    await browser.keys("Enter");
    const projectEditor = $('[role="dialog"][data-slot="dialog-content"]');
    await projectEditor.waitForDisplayed();
    expect(
      await projectEditor.$('[data-testid="virtual-project-root-name"]').getAttribute("title"),
    ).toBe(config.workspacePaths[0]);
    await capture("project-editor");
    await browser.keys("Escape");
    // Escape 关闭失败即终止此路径；不能用取消按钮替代被测键盘行为。
    await projectEditor.waitForDisplayed({ reverse: true });
    await activate(`${row} button[aria-label="更多"]`);
    await $('[role="menu"]').waitForDisplayed();
    await browser.keys("ArrowDown");
    expect(await browser.execute(() => document.activeElement?.getAttribute("role"))).toMatch(
      /^menuitem/,
    );
    await browser.keys("Escape");
    await $('[role="menu"]').waitForDisplayed({ reverse: true });
    // 新项目排序移动真实行，不再创建旧 WorkspaceDragOverlay；验证实际位移和设备标签。
    const dragSelector = `${row} [data-testid="virtual-project-toggle"]`;
    const deviceLabel = $(row).$('[data-testid="project-device"]');
    const deviceBeforeDrag = await deviceLabel.getText();
    const position = await startProjectPointerDrag(dragSelector);
    await browser.waitUntil(
      () =>
        browser.execute(
          (selector, top) =>
            Math.abs(document.querySelector(selector)!.getBoundingClientRect().top - top) >= 6,
          dragSelector,
          position.top,
        ),
      { timeout: 5000, timeoutMsg: "项目行未随拖拽移动" },
    );
    expect(await deviceLabel.isDisplayed()).toBe(true);
    expect(await deviceLabel.getText()).toBe(deviceBeforeDrag);
    expect(deviceBeforeDrag).not.toBe("");
    await browser.saveScreenshot(resolve(artifact, "drag-device.png"));
    await browser.keys("Escape");
    await browser.releaseActions();
    await browser.waitUntil(
      () =>
        browser.execute(
          (selector, top) =>
            Math.abs(document.querySelector(selector)!.getBoundingClientRect().top - top) < 1,
          dragSelector,
          position.top,
        ),
      { timeout: 5000, timeoutMsg: "取消拖拽后项目位置未恢复" },
    );
    await activate(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`);
    const remoteNavigation = `[data-testid="${testId(TID_SETTINGS_SECTION_NAV, "remoteDevices")}"]`;
    await tabTo(remoteNavigation);
    expect(await $(remoteNavigation).getAttribute("data-settings-section-nav")).toBe(
      "remoteDevices",
    );
    expect(await browser.execute(() => document.activeElement!.matches(":focus-visible"))).toBe(
      true,
    );
    await browser.keys("Enter");
    await $("[data-source-server-card]").waitForDisplayed();
    // RDUX-13：键盘展开设备行，详情（日志等）在展开区。
    await activate("[data-source-server-card] [data-source-server-toggle]");
    expect(
      await $("[data-source-server-card] [data-source-server-toggle]").getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
    await activate("[data-source-server-card] button", "更多");
    await $("[data-device-info]").waitForDisplayed();
    await browser.keys("Escape");
    await $("[data-source-server-card] [data-source-server-log-toggle]").waitForDisplayed();
    await activate("[data-source-server-card] [data-source-server-log-toggle]");
    await $("[data-source-server-log-timestamp]").waitForDisplayed();
    await capture("settings");
    // 断开在「更多」菜单：键盘打开后焦点在首项「编辑」，下移到「断开」再确认。
    await activate("[data-source-server-card] button", "更多");
    await browser.keys("ArrowDown");
    expect(
      await browser.execute(
        () =>
          document.activeElement?.matches('[role="menuitem"]') &&
          document.activeElement.textContent?.trim().startsWith("断开"),
      ),
    ).toBe(true);
    await browser.keys("Enter");
    await $(
      '[data-source-server-card] [role="status"][data-remote-connection-status="offline"]',
    ).waitForDisplayed();
    await activate("[data-source-server-card] button", "连接");
    await $('[data-source-server-card] [data-remote-connection-status="online"]').waitForDisplayed({
      timeout: 120_000,
    });
    await $(dialog).waitForExist({ reverse: true });
    expect(await $('[data-testid="settings-page"]').isDisplayed()).toBe(true);
    expect(await $('[data-testid="ssh-success"]').isExisting()).toBe(false);
    await activate("[data-settings-content-frame] button", "新建连接");
    // RDUX-27：新建连接表单打开时焦点直接落在主机字段。
    await $(`${dialog} [data-testid="ssh-host-input"]`).waitForDisplayed();
    expect(await browser.execute(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      "ssh-host-input",
    );
    await capture("selection");
    await activate('[data-testid="remote-kind-ssh"]');
    await tabTo(`${dialog} [data-testid="ssh-host-input"]`);
    await browser.keys("ArrowDown");
    await browser.keys("Enter");
    expect(await $(`${dialog} [data-testid="ssh-host-input"]`).getValue()).toBe(config.host);
    expect(await $(`${dialog} [data-testid="ssh-host-input"]`).getAttribute("aria-expanded")).toBe(
      "false",
    );
    await activate(`${dialog} button`, "关闭");
    await $(dialog).waitForDisplayed({ reverse: true });
    await activate(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`);
    await tabTo(`${row} [data-testid="virtual-project-toggle"]`);
    await browser.keys("Enter");
    expect(await $(row).getAttribute("data-connection-state")).toBe("online");
  });
});
