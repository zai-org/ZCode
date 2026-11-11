import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ServiceChannels,
  PlatformChannels,
  InternalChannels,
  buildRemoteHostWorkspaceIdentity,
} from "@zcode/shared";
import {
  TID_VIRTUAL_PROJECT_CREATE_TASK,
  TID_TASK_ITEM,
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_BACK_BUTTON,
  TID_REMOTE_KIND_SSH,
  TID_CONFIRM_DIALOG_CONFIRM,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { selectRemoteDeviceMenuItem } from "#e2e/helpers/remote-project-actions";
import {
  selectNativeProjectDirectories,
  selectRemoteProjectDirectory,
} from "#e2e/helpers/project-sidebar";
import { selectV4TaskById, prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  installHandoffRpcProbe,
  callHandoffHost,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  fillSSHPasswordSettings,
  readSSHRuntimeConfig,
  clickLastEnabledSSHDialogButton,
  waitForSSHDirectoryStep,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import type { RemoteProjectDirectory, VirtualProject } from "@zcode/services";
const marker = "E2E_PROJECT_DEVICE_SELECTION";
const projectName = `${marker}_${Date.now()}`;
interface DirectoryDelay {
  request?: number[];
  restore(): void;
}
declare global {
  interface Window {
    __projectDirectoryDelay?: DirectoryDelay;
    __taskFixtureRemotePort?: MessagePort;
    __taskFixturePortListener?: (event: MessageEvent) => void;
  }
}
// 保留真实 SSH 连接，只阻挡完成响应，让活动页签断言覆盖连接进行中。
declare global {
  var __projectConnectionRestore: (() => void) | undefined;
}
async function activeTabId() {
  return browser.execute(
    () =>
      (
        window as Window & {
          __zcodeTabStoreE2E?: { getState(): { activeTabId: string | null } };
        }
      ).__zcodeTabStoreE2E!.getState().activeTabId,
  );
}
async function holdProjectConnection() {
  const originalTab = await activeTabId();
  expect(originalTab).toBeTruthy();
  await browser.electron.execute((electron, channel) => {
    const handlers = (
      electron.ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
      }
    )._invokeHandlers;
    const original = handlers.get(channel)!;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    handlers.set(channel, async (...args) => {
      const result = await original(...args);
      await barrier;
      return result;
    });
    globalThis.__projectConnectionRestore = () => {
      release();
      handlers.set(channel, original);
    };
  }, PlatformChannels.ConnectRemote);
  return originalTab;
}
async function assertProjectConnectionStaysInPlace(originalTab: string | null) {
  await $('[data-testid="ssh-dialog"]').waitForDisplayed();
  expect(await activeTabId()).toBe(originalTab);
  expect(await $("[data-settings-content-frame]").isDisplayed()).toBe(false);
  await browser.electron.execute(() => globalThis.__projectConnectionRestore?.());
}

async function holdDirectoryRequest() {
  await browser.execute(
    (channel, remoteChannel) => {
      const original = MessagePort.prototype.postMessage;
      const probe: DirectoryDelay = {
        restore() {
          MessagePort.prototype.postMessage = original;
          delete window.__projectDirectoryDelay;
        },
      };
      MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
        const text = message instanceof Uint8Array ? new TextDecoder().decode(message) : "";
        if (
          !probe.request &&
          text.includes(channel) &&
          !text.includes(remoteChannel) &&
          text.includes("readDirectory")
        ) {
          probe.request = Array.from(message as Uint8Array);
          return;
        }
        Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
      };
      window.__projectDirectoryDelay = probe;
    },
    ServiceChannels.Project,
    ServiceChannels.RemoteProjects,
  );
}
async function releaseDirectoryRequest() {
  const bytes = await browser.execute(() => {
    const probe = window.__projectDirectoryDelay!;
    const request = probe.request!;
    probe.restore();
    return request;
  });
  const header = deserialize(new BufferReader(VSBuffer.wrap(Uint8Array.from(bytes)))) as [
    number,
    number,
  ];
  const prefixes = [201, 202, 203].map((type) => {
    const writer = new BufferWriter();
    serialize(writer, [type, header[1]]);
    return Array.from(writer.buffer.buffer);
  });
  await browser.execute(
    (request, replies) => window.__remoteProjectHandoffRpc!.call(request, replies),
    bytes,
    prefixes,
  );
}

async function openForm() {
  await $('[data-testid="project-section"]').moveTo();
  await $('[data-testid="virtual-project-add"]').click();
  await $('[data-testid="virtual-project-name"]').waitForDisplayed();
}
async function chooseDevice(id: string) {
  await $('[data-testid="virtual-project-device"]').click();
  await $(`[role="option"][data-device-id="${id}"]`).click();
}
async function readDirectory() {
  return callHandoffHost<RemoteProjectDirectory>(ServiceChannels.RemoteProjects, "readDirectory");
}
describe(marker, () => {
  afterEach(async () => {
    await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "last-state.png"));
  });
  after(async () => {
    await browser.electron.execute(() => globalThis.__projectConnectionRestore?.());
    await browser.execute(() => {
      window.__projectDirectoryDelay?.restore();
      if (window.__taskFixturePortListener)
        window.removeEventListener("message", window.__taskFixturePortListener);
    });
    await restoreHandoffProbes();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RDUX15-01/06/07/08/09/17 本地零/多目录、已识别无项目设备、在线选择和离线显式连接", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(marker);
    await prepareV4ConversationE2E({ skipProvider: true });
    await installHandoffRpcProbe();
    await browser.execute(() => {
      (
        window as Window & { __testActions?: { setLocale(locale: string): void } }
      ).__testActions?.setLocale("zh-CN");
    });
    await openForm();
    expect(await $('[data-testid="virtual-project-type-next"]').isExisting()).toBe(false);
    expect(await $('[data-testid="virtual-project-device"]').getText()).toContain("此电脑");
    await $('[data-testid="virtual-project-name"]').setValue(`${projectName}_EMPTY`);
    // 字段顺序为名称 → 设备 → 文件夹；名称默认聚焦，设备在其后一个焦点位。
    await browser.keys("Tab");
    expect(await browser.execute(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      "virtual-project-device",
    );
    await browser.keys("ArrowDown");
    await $('[role="option"]').waitForDisplayed();
    await browser.keys("Escape");
    await $('[data-testid="virtual-project-save"]').click();
    await $(`[data-project-name="${projectName}_EMPTY"]`).waitForDisplayed();
    await openForm();
    await $('[data-testid="virtual-project-name"]').setValue(`${projectName}_INVALID`);
    await selectNativeProjectDirectories([
      join(DEFAULT_WORKSPACE, "missing-device-test-directory"),
    ]);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await $('[role="dialog"] [role="alert"]').waitForDisplayed();
    expect(await $('[data-testid="virtual-project-name"]').getValue()).toBe(
      `${projectName}_INVALID`,
    );
    expect(await $(`[data-project-name="${projectName}_INVALID"]`).isExisting()).toBe(false);
    await browser.keys("Escape");

    const paths = [
      join(DEFAULT_WORKSPACE, ".e2e-device", "one"),
      join(DEFAULT_WORKSPACE, ".e2e-device", "two"),
    ];
    await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
    await openForm();
    await $('[data-testid="virtual-project-name"]').setValue(`${projectName}_MULTI`);
    await selectNativeProjectDirectories(paths);
    expect(await $$('[data-testid="virtual-project-root-row"]').length).toBe(2);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await $(`[data-project-name="${projectName}_MULTI"]`).waitForDisplayed();

    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
    await $("[data-settings-content-frame]").$('.//button[normalize-space(.)="新建连接"]').click();
    await clickTestIdByDom(TID_REMOTE_KIND_SSH);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(marker);
    expect(await waitForSSHDirectoryStep(marker)).toBe("closed");
    const before = await readDirectory();
    expect(before.entries).toHaveLength(0);
    const host = before.hosts[0]!;
    // 明确移除本机项目成员，不删已识别设备；验证 Source 全集而非项目 open set。
    await callHandoffHost(ServiceChannels.RemoteProjects, "removeHost", [host.id]);
    expect((await readDirectory()).hosts).toHaveLength(0);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await openForm();
    await $('[data-testid="virtual-project-name"]').setValue(projectName);
    await selectNativeProjectDirectories([paths[0]!]);
    await chooseDevice(host.id);
    await browser.keys("Escape");
    expect(await $('[data-testid="virtual-project-device"]').getText()).toContain("此电脑");
    expect(await $('[data-testid="virtual-project-root-name"]').getAttribute("title")).toBe(
      paths[0],
    );
    await chooseDevice(host.id);
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
    expect(await $$('[data-testid="virtual-project-root-row"]').length).toBe(0);
    expect(await $('[data-testid="virtual-project-name"]').getValue()).toBe(projectName);
    expect((await readDirectory()).entries).toHaveLength(0);

    await holdDirectoryRequest();
    await $('[data-testid="virtual-project-browse"]').click();
    await browser.waitUntil(() =>
      browser.execute(() => Boolean(window.__projectDirectoryDelay?.request)),
    );
    await $('[data-testid="virtual-project-directory-browser"]')
      .$('.//button[normalize-space(.)="取消"]')
      .click();
    await chooseDevice("local");
    await releaseDirectoryRequest();
    expect(await $('[data-testid="virtual-project-directory-browser"]').isExisting()).toBe(false);
    expect(await $('[data-testid="virtual-project-device"]').getText()).toContain("此电脑");
    expect(await $$('[data-testid="virtual-project-root-row"]').length).toBe(0);
    await chooseDevice(host.id);
    await selectRemoteProjectDirectory(config.workspacePaths[0]);
    expect((await readDirectory()).hosts).toHaveLength(0);
    expect((await readDirectory()).entries).toHaveLength(0);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await $(`[data-project-name="${projectName}"]`).waitForDisplayed();
    const created = await readDirectory();
    expect(created.entries).toHaveLength(1);
    expect(created.entries[0]!.roots[0]!.rootPath).toBe(config.workspacePaths[0]);

    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
    // RDUX-13：断开在设备行「更多」菜单里。
    const sourceId = await $("[data-source-server-card]").getAttribute("data-source-server-card");
    if (!sourceId) throw new Error(`${marker}: 缺少设备行`);
    await selectRemoteDeviceMenuItem(sourceId, ["断开", "Disconnect"], marker);
    await $('[data-source-server-card] [data-remote-connection-status="offline"]').waitForExist();
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await openForm();
    await $('[data-testid="virtual-project-name"]').setValue(`${projectName}_OFFLINE`);
    await chooseDevice(host.id);
    expect(await $('[data-testid="virtual-project-browse"]').getText()).toContain(
      "连接并选择文件夹",
    );
    expect((await readDirectory()).hosts[0]!.connectionStatus).toBe("offline");
    const directoryOriginTab = await holdProjectConnection();
    await $('[data-testid="virtual-project-browse"]').click();
    await assertProjectConnectionStaysInPlace(directoryOriginTab);
    expect(await waitForSSHDirectoryStep(marker)).toBe("directory");
    await $('[data-testid="virtual-project-directory-browser"]').waitForDisplayed();
    await selectRemoteProjectDirectory(config.workspacePaths[1]);
    expect(await $('[data-testid="virtual-project-name"]').getValue()).toBe(
      `${projectName}_OFFLINE`,
    );

    const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR!;
    for (const locale of ["zh-CN", "en-US"])
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
          await browser.executeAsync((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
          await browser.executeAsync((done) => {
            const dialog = document
              .querySelector('[data-testid="virtual-project-name"]')
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
          const layout = await browser.execute(() => {
            const bounds = document
              .querySelector('[data-testid="virtual-project-save"]')!
              .getBoundingClientRect();
            return {
              right: bounds.right,
              bottom: bounds.bottom,
              width: innerWidth,
              height: innerHeight,
            };
          });
          expect(layout.right).toBeLessThanOrEqual(layout.width);
          expect(layout.bottom).toBeLessThanOrEqual(layout.height);
          await browser.saveScreenshot(join(artifacts, `project-${locale}-${theme}-${width}.png`));
        }
      }
    await writeFile(
      join(artifacts, "project-device-facts.json"),
      JSON.stringify(
        { before, created, platform: process.platform, unverified: ["WSL", "mobile"] },
        null,
        2,
      ),
    );
    await browser.electron.execute((electron) => {
      electron.BrowserWindow.getAllWindows()
        .find((window) => window.isVisible())
        ?.setSize(1440, 900);
    });
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    // 窄屏视觉矩阵会收起侧栏；恢复宽窗口不会替用户展开，先通过原按钮恢复可见性再断言行。
    if (!(await $('[data-testid="sidebar"]').isDisplayed())) {
      await $('button[aria-label="切换侧边栏"], button[aria-label="Toggle sidebar"]').click();
    }
    await $(`[data-project-name="${projectName}_OFFLINE"]`).waitForDisplayed();
    expect((await readDirectory()).entries).toHaveLength(2);

    await callHandoffHost(ServiceChannels.SourceServerManagement, "disconnectSource", [
      host.id.slice("remote:server:".length),
    ]);
    await openForm();
    await chooseDevice(host.id);
    await browser.waitUntil(async () =>
      /离线|Offline/.test(await $('[data-testid="virtual-project-device"]').getText()),
    );
    expect(
      await $(
        '[data-testid="virtual-project-device"] [data-testid="virtual-project-device-status"]',
      ).getAttribute("data-status"),
    ).toBe("offline");
    // 已有项目入口随设备整体移动，位于名称之后、源文件夹之前。
    expect(await $('[data-testid="virtual-project-existing"]').getText()).toMatch(
      /添加到侧栏|Add to sidebar/,
    );
    expect(
      await browser.execute(() => {
        const entry = document.querySelector('[data-testid="virtual-project-existing"]')!;
        const name = document.querySelector('[data-testid="virtual-project-name"]')!;
        const device = document.querySelector('[data-testid="virtual-project-device"]')!;
        const browse = document.querySelector('[data-testid="virtual-project-browse"]')!;
        return [name, device, entry].every((element, index) =>
          Boolean(
            element.compareDocumentPosition([device, entry, browse][index]!) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        );
      }),
    ).toBe(true);
    const existingOriginTab = await holdProjectConnection();
    await $('[data-testid="virtual-project-existing"]').click();
    await assertProjectConnectionStaysInPlace(existingOriginTab);
    await $('[data-testid="remote-project-back"]').waitForDisplayed();
    // 返回按钮在标题左侧，不在列表底部。
    expect(
      await browser.execute(() => {
        const back = document.querySelector('[data-testid="remote-project-back"]')!;
        const title = back.closest('[role="dialog"]')!.querySelector('[data-slot="dialog-title"]')!;
        return Boolean(back.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
    ).toBe(true);
    expect(await $('[data-testid="virtual-project-directory-browser"]').isExisting()).toBe(false);
    expect(await $$('[data-testid="remote-project-pick"]').length).toBeGreaterThan(0);
    await $('[data-testid="remote-project-back"]').click();
    await browser.keys("Escape");
  });
  it("RDUX15-01/02 从真实本地和远端任务默认设备，断线与快照刷新不覆盖选择", async function () {
    this.timeout(5 * 60_000);
    await browser.execute(() => {
      (
        window as Window & { __testActions?: { setLocale(locale: string): void } }
      ).__testActions?.setLocale("zh-CN");
    });
    const localProjects = await callHandoffHost<VirtualProject[]>(
      ServiceChannels.Project,
      "readProjects",
    );
    const local = localProjects.find((project) =>
      project.roots.some((root) => root.rootPath === DEFAULT_WORKSPACE),
    )!;
    const localTaskId = await createHistoryTask({
      workspacePath: DEFAULT_WORKSPACE,
      projectId: local.id,
    });
    await openTask(localTaskId, local.id);
    await openForm();
    await expectSelectedDevice("local");
    await browser.keys("Escape");

    const remote = (await readDirectory()).entries.find((entry) => entry.name === projectName)!;
    const path = remote.roots[0]!.rootPath;
    const identity = buildRemoteHostWorkspaceIdentity(remote.hostId, path);
    const section = $(
      `[data-project-id="${remote.projectId}"][data-project-host="${remote.hostId}"]`,
    );
    await browser.execute(
      (channel, sourceId) => {
        const listener = (event: MessageEvent) => {
          if (
            event.data?.type === channel &&
            event.data.sourceServerId === sourceId &&
            event.ports[0]
          )
            window.__taskFixtureRemotePort = event.ports[0];
        };
        window.__taskFixturePortListener = listener;
        window.addEventListener("message", listener);
      },
      InternalChannels.ScopedServicePort,
      remote.hostId.slice("remote:server:".length),
    );
    await section.moveTo();
    await section.$(`[data-testid="${TID_VIRTUAL_PROJECT_CREATE_TASK}"]`).click();
    await waitForRemoteTab({ caseMarker: marker, expectedIdentity: identity, expectedPath: path });
    const remoteTaskId = await createHistoryTask(
      {
        workspacePath: path,
        workspaceIdentity: identity,
        projectId: remote.projectId!,
      },
      true,
    );
    await openTask(remoteTaskId, remote.projectId!);
    const remoteTask = $(`[data-testid="${testId(TID_TASK_ITEM, remoteTaskId)}"]`);
    const taskDetails = $('[data-testid="remote-identity-details"]');
    // 选任务的 helper 使用 DOM 点击，鼠标仍可能停在项目行内；先移出再产生真实 hover 进入。
    const outside = await browser.execute(() => ({ x: innerWidth - 24, y: 24 }));
    await browser.action("pointer").move(outside).perform();
    await taskDetails.waitForDisplayed({ reverse: true });
    await section.$('[data-testid="virtual-project-toggle"]').moveTo();
    await taskDetails.waitForDisplayed();
    expect(await taskDetails.$("strong").getText()).toBe(projectName);
    expect(await taskDetails.getText()).toContain(projectName);
    expect(await taskDetails.getText()).toContain(path);
    expect(await taskDetails.$$("button")).toHaveLength(0);
    await taskDetails.moveTo();
    expect(await taskDetails.isDisplayed()).toBe(true);
    await $('[data-testid="virtual-project-add"]').moveTo();
    await taskDetails.waitForDisplayed({ reverse: true });
    // 先验证项目详情确实可打开，再持续观察会话 hover，避免把浮层延迟误判为“不展示”。
    await remoteTask.moveTo();
    const taskHover = await browser.executeAsync((done) => {
      const observed = { identityDetailsOpened: false, sessionRowDetailsOpened: false };
      const check = () => {
        if (document.querySelector('[data-testid="remote-identity-details"][data-state="open"]'))
          observed.identityDetailsOpened = true;
        // 远程会话行显示任务卡（cwd/活动/分支），但不复用项目身份详情。
        if (document.querySelector('[data-testid="task-row-details"][data-state="open"]'))
          observed.sessionRowDetailsOpened = true;
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      check();
      setTimeout(() => {
        observer.disconnect();
        done(observed);
      }, 700);
    });
    expect(taskHover).toEqual({
      identityDetailsOpened: false,
      sessionRowDetailsOpened: true,
    });
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "task-hover-no-identity.png"),
    );
    await openForm();
    await expectSelectedDevice(remote.hostId);
    await chooseDevice("local");
    const sourceId = remote.hostId.slice("remote:server:".length);
    await callHandoffHost(ServiceChannels.SourceServerManagement, "renameSource", [
      sourceId,
      "Snapshot refreshed device",
    ]);
    await expectSelectedDevice("local");
    await browser.keys("Escape");
    await openForm();
    await expectSelectedDevice(remote.hostId);
    await callHandoffHost(ServiceChannels.SourceServerManagement, "disconnectSource", [sourceId]);
    await browser.waitUntil(async () =>
      (await $('[data-testid="virtual-project-device"]').getText()).includes("离线"),
    );
    await expectSelectedDevice(remote.hostId);
    await browser.keys("Escape");
    await openForm();
    await expectSelectedDevice(remote.hostId);
    expect(await $('[data-testid="virtual-project-browse"]').getText()).toContain(
      "连接并选择文件夹",
    );
    await browser.keys("Escape");
  });
});

async function openTask(taskId: string, projectId: string) {
  const task = $(`[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`);
  const toggle = $(`[data-project-id="${projectId}"] [data-testid="virtual-project-toggle"]`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await task.waitForDisplayed({ timeout: 30_000 });
  await selectV4TaskById(taskId, 30_000);
}
async function expectSelectedDevice(id: string) {
  await $('[data-testid="virtual-project-device"]').click();
  const selected = $(`[role="option"][data-device-id="${id}"]`);
  await selected.waitForDisplayed();
  expect(await selected.getAttribute("aria-selected")).toBe("true");
  await browser.keys("Escape");
}

async function createHistoryTask(
  target: {
    workspacePath: string;
    workspaceIdentity?: string;
    projectId: string;
  },
  remote = false,
) {
  // 空 createSession 是草稿，正式任务前置走公开历史导入，不发送模型请求。
  const call = remote ? callRemoteFixture : callHandoffHost;
  const snapshot = await call<{ session: { sessionId: string } }>(
    ServiceChannels.ZCodeAgent,
    "createSession",
    [
      {
        ...target,
        persistence: "immediate",
        importedHistory: {
          source: "claudeCode",
          title: "E2E_CURRENT_TASK_FIXTURE",
          messages: [
            { role: "user", content: "E2E_CURRENT_TASK_FIXTURE" },
            { role: "assistant", content: "Fixture ready" },
          ],
        },
      },
    ],
  );
  const taskId = snapshot.session.sessionId;
  await call(ServiceChannels.ZCodeTask, "resumeTask", [
    {
      taskId,
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    },
  ]);
  return taskId;
}

let fixtureRequestId = -19300;
async function callRemoteFixture<T>(
  channel: string,
  command: string,
  args: unknown[] = [],
): Promise<T> {
  const id = fixtureRequestId--;
  const writer = new BufferWriter();
  serialize(writer, [100, id, channel, command]);
  serialize(writer, args);
  const prefixes = [201, 202, 203].map((type) => {
    const prefix = new BufferWriter();
    serialize(prefix, [type, id]);
    return Array.from(prefix.buffer.buffer);
  });
  const reply = await browser.execute(
    (request, signatures) => {
      const port = window.__taskFixtureRemotePort;
      if (!port) throw new Error("Scoped task fixture port unavailable");
      return new Promise<number[]>((resolve) => {
        const receive = (event: MessageEvent) => {
          if (
            !(event.data instanceof Uint8Array) ||
            !signatures.some((prefix) => prefix.every((byte, index) => event.data[index] === byte))
          )
            return;
          port.removeEventListener("message", receive);
          resolve(Array.from(event.data));
        };
        port.addEventListener("message", receive);
        port.postMessage(Uint8Array.from(request));
      });
    },
    Array.from(writer.buffer.buffer),
    prefixes,
  );
  const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(reply)));
  const header = deserialize(reader) as [number, number];
  const body = deserialize(reader);
  if (header[0] !== 201) throw new Error(typeof body === "string" ? body : body.message);
  return body as T;
}
