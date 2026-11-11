import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { ServiceChannels, InternalChannels, buildRemoteHostWorkspaceIdentity } from "@zcode/shared";
import {
  TID_VIRTUAL_PROJECT_CREATE_TASK,
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_BACK_BUTTON,
  TID_REMOTE_KIND_SSH,
  testId,
} from "@zcode/shared/test-ids";
import type { RemoteProjectDirectory, ProjectTree, VirtualProject } from "@zcode/services";
import { clickTestIdByDom, clearAppData } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E, selectV4TaskById } from "#e2e/helpers/v4-conversation";
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
const marker = "E2E_EXISTING_REMOTE_PROJECT";
declare global {
  interface Window {
    __existingProjectListRequest?: number[];
    __restoreExistingProjectList?: () => void;
  }
}
let selectedHostId: string;
async function openForm() {
  // 窄窗口会按原产品规则收起侧栏；恢复尺寸后仍须用可见入口显式展开。
  if (
    await browser.execute(() => {
      const panel = document.querySelector("[data-workspace-sidebar-panel]");
      return panel?.classList.contains("pointer-events-none") ?? false;
    })
  )
    await $('button[aria-label="Toggle sidebar"], button[aria-label="切换侧边栏"]').click();
  await browser.waitUntil(() =>
    browser.execute(() => {
      const panel = document.querySelector("[data-workspace-sidebar-panel]");
      return panel ? getComputedStyle(panel).opacity === "1" : false;
    }),
  );
  await $('[data-purpose-section-drag-trigger="projects"]').moveTo();
  await $('[data-testid="virtual-project-add"]').click();
  await $('[data-testid="virtual-project-name"]').waitForDisplayed();
  await $('[data-testid="virtual-project-device"]').click();
  await $(`[role="option"][data-device-id="${selectedHostId}"]`).click();
}
async function openList() {
  await $('[data-testid="virtual-project-existing"]').click();
  await $('[data-testid="remote-project-back"]').waitForDisplayed({ timeout: 90_000 });
}
async function directory() {
  return callHandoffHost<RemoteProjectDirectory>(ServiceChannels.RemoteProjects, "readDirectory");
}
async function holdList(hostId: string) {
  await browser.execute(
    (channel, id) => {
      const original = MessagePort.prototype.postMessage;
      window.__restoreExistingProjectList = () => {
        MessagePort.prototype.postMessage = original;
        delete window.__restoreExistingProjectList;
      };
      MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
        const text = message instanceof Uint8Array ? new TextDecoder().decode(message) : "";
        if (
          !window.__existingProjectListRequest &&
          text.includes(channel) &&
          text.includes("readTree") &&
          text.includes(id)
        ) {
          window.__existingProjectListRequest = Array.from(message as Uint8Array);
          return;
        }
        Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
      };
    },
    ServiceChannels.Project,
    hostId,
  );
}
async function releaseList() {
  const request = await browser.execute(() => {
    const value = window.__existingProjectListRequest!;
    window.__restoreExistingProjectList?.();
    delete window.__existingProjectListRequest;
    return value;
  });
  const header = deserialize(new BufferReader(VSBuffer.wrap(Uint8Array.from(request)))) as [
    number,
    number,
  ];
  const prefixes = [201, 202, 203].map((type) => {
    const writer = new BufferWriter();
    serialize(writer, [type, header[1]]);
    return Array.from(writer.buffer.buffer);
  });
  await browser.execute(
    (bytes, signatures) => window.__remoteProjectHandoffRpc!.call(bytes, signatures),
    request,
    prefixes,
  );
}
describe(marker, () => {
  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR!;
    await browser.saveScreenshot(join(artifacts, "failure.png"));
    const state = await browser.execute(() => ({
      dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((item) => ({
        text: item.textContent,
        state: item.getAttribute("data-state"),
      })),
      panel: document.querySelector("[data-workspace-sidebar-panel]")?.getAttribute("class"),
      bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
    }));
    await writeFile(join(artifacts, "failure-state.json"), JSON.stringify(state, null, 2));
  });
  after(async () => {
    await browser.execute(() => {
      window.__restoreExistingProjectList?.();
      if (window.__taskFixturePortListener)
        window.removeEventListener("message", window.__taskFixturePortListener);
    });
    await restoreHandoffProbes();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RDUX15-15/16/20 preserves original project and task identity, draft, and cancelled list", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(marker);
    await prepareV4ConversationE2E({ skipProvider: true });
    await installHandoffRpcProbe();
    await browser.execute(() =>
      (
        window as Window & { __testActions?: { setLocale(locale: string): void } }
      ).__testActions?.setLocale("zh-CN"),
    );
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
    await $("[data-settings-content-frame]").$('.//button[normalize-space(.)="新建连接"]').click();
    await clickTestIdByDom(TID_REMOTE_KIND_SSH);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(marker);
    expect(await waitForSSHDirectoryStep(marker)).toBe("closed");
    const host = (await directory()).hosts[0]!;
    selectedHostId = host.id;
    const sourceId = host.id.slice("remote:server:".length);
    const path = config.workspacePaths[0]!;
    const first = await callHandoffHost<VirtualProject>(ServiceChannels.Project, "saveProject", [
      { hostId: host.id, roots: [path], name: marker + " original" },
    ]);
    const second = await callHandoffHost<VirtualProject>(ServiceChannels.Project, "saveProject", [
      {
        hostId: host.id,
        roots: [path],
        name: marker + " second identity with a long project name",
      },
    ]);
    expect(first.id).not.toBe(second.id);
    const setupEntry = await callHandoffHost<{ id: string }>(
      ServiceChannels.RemoteProjects,
      "addEntry",
      [
        {
          hostId: host.id,
          expectedMembershipId: host.membershipId,
          project: { projectId: first.id, name: first.name, roots: first.roots },
        },
      ],
    );
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await browser.execute(
      (channel, id) => {
        const listener = (event: MessageEvent) => {
          if (event.data?.type === channel && event.data.sourceServerId === id && event.ports[0])
            window.__taskFixtureRemotePort = event.ports[0];
        };
        window.__taskFixturePortListener = listener;
        window.addEventListener("message", listener);
      },
      InternalChannels.ScopedServicePort,
      sourceId,
    );
    const row = $(`[data-project-id="${first.id}"][data-project-host="${host.id}"]`);
    await row.waitForDisplayed();
    await row.moveTo();
    await row.$(`[data-testid="${TID_VIRTUAL_PROJECT_CREATE_TASK}"]`).click();
    const identity = buildRemoteHostWorkspaceIdentity(host.id, path);
    await waitForRemoteTab({ caseMarker: marker, expectedIdentity: identity, expectedPath: path });
    const taskId = await createHistoryTask(
      { workspacePath: path, workspaceIdentity: identity, projectId: first.id },
      true,
    );
    await callHandoffHost(ServiceChannels.RemoteProjects, "removeEntry", [setupEntry.id]);
    expect((await directory()).entries).toHaveLength(0);
    const beforeProjectIds = (
      await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [{ hostId: host.id }])
    ).projects
      .map((project) => project.id)
      .sort();
    await openForm();
    await $('[data-testid="virtual-project-name"]').setValue("Retained new project draft");
    await openList();
    const pick = $(`[data-testid="remote-project-pick"][data-project-id="${first.id}"]`);
    await pick.waitForDisplayed();
    expect(await pick.getText()).toContain(path);
    expect(
      await $(`[data-testid="remote-project-pick"][data-project-id="${second.id}"]`).isDisplayed(),
    ).toBe(true);
    await $('[data-testid="remote-project-back"]').click();
    expect(await $('[data-testid="virtual-project-name"]').getValue()).toBe(
      "Retained new project draft",
    );
    await browser.waitUntil(() =>
      browser.execute(
        () => document.activeElement?.getAttribute("data-testid") === "virtual-project-existing",
      ),
    );
    await holdList(host.id);
    await openList();
    await browser.waitUntil(() =>
      browser.execute(() => Boolean(window.__existingProjectListRequest)),
    );
    await $('[data-testid="remote-project-back"]').click();
    await $('[data-testid="virtual-project-device"]').click();
    await $('[role="option"][data-device-id="local"]').click();
    await releaseList();
    expect(await $('[data-testid="remote-project-back"]').isExisting()).toBe(false);
    expect((await directory()).entries).toHaveLength(0);
    expect(await $('[data-testid="virtual-project-name"]').getValue()).toBe(
      "Retained new project draft",
    );
    await $('[data-testid="virtual-project-device"]').click();
    await $(`[role="option"][data-device-id="${host.id}"]`).click();
    await openList();
    await pick.waitForDisplayed();
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
          await browser.electron.execute(
            (electron, size) =>
              electron.BrowserWindow.getAllWindows()
                .find((window) => window.isVisible())
                ?.setSize(size, 900),
            width,
          );
          await browser.executeAsync((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
          expect(await $('[data-testid="remote-project-back"]').isDisplayed()).toBe(true);
          const rows = await browser.execute(() =>
            Array.from(document.querySelectorAll('[data-testid="remote-project-pick"]')).map(
              (button) => {
                const row = button.getBoundingClientRect();
                const content = button.querySelector("span")!.getBoundingClientRect();
                return {
                  rowTop: row.top,
                  rowBottom: row.bottom,
                  contentTop: content.top,
                  contentBottom: content.bottom,
                  scrollTop: button.parentElement!.scrollTop,
                };
              },
            ),
          );
          await writeFile(
            join(artifacts, `existing-project-rows-${locale}-${theme}-${width}.json`),
            JSON.stringify(rows, null, 2),
          );
          for (const row of rows) {
            expect(row.contentTop).toBeGreaterThanOrEqual(row.rowTop - 1);
            expect(row.contentBottom).toBeLessThanOrEqual(row.rowBottom + 1);
          }
          await browser.executeAsync((done) => {
            const dialog = document
              .querySelector('[data-testid="remote-project-back"]')
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
              .querySelector('[data-testid="remote-project-back"]')!
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
          await browser.saveScreenshot(
            join(artifacts, `existing-project-${locale}-${theme}-${width}.png`),
          );
        }
      }
    await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows()
        .find((window) => window.isVisible())
        ?.setSize(1440, 900),
    );
    await pick.click();
    await $('[data-testid="remote-project-back"]').waitForExist({ reverse: true });
    let entries = (await directory()).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.projectId).toBe(first.id);
    expect(entries[0]!.roots).toEqual(first.roots);
    await openForm();
    await openList();
    await pick.waitForDisplayed();
    await pick.click();
    await $('[data-testid="remote-project-back"]').waitForExist({ reverse: true });
    expect((await directory()).entries).toHaveLength(1);
    expect((await directory()).entries[0]!.id).toBe(entries[0]!.id);
    await openForm();
    await openList();
    await $(`[data-testid="remote-project-pick"][data-project-id="${second.id}"]`).click();
    await $('[data-testid="remote-project-back"]').waitForExist({ reverse: true });
    entries = (await directory()).entries;
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.projectId))).toEqual(
      new Set([first.id, second.id]),
    );
    const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId: host.id },
    ]);
    expect(tree.projects.map((project) => project.id).sort()).toEqual(beforeProjectIds);
    expect(tree.tasks.find((task) => task.taskId === taskId)?.projectId).toBe(first.id);
    const original = $(`[data-project-id="${first.id}"][data-project-host="${host.id}"]`);
    const toggle = original.$('[data-testid="virtual-project-toggle"]');
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await selectV4TaskById(taskId, 30_000);
    await browser.waitUntil(async () => (await $("body").getText()).includes("Fixture ready"), {
      timeout: 30_000,
    });
    await callHandoffHost(ServiceChannels.SourceServerManagement, "disconnectSource", [sourceId]);
    await openForm();
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="virtual-project-device"]').getText()).includes("离线") ||
        (await $('[data-testid="virtual-project-device"]').getText()).includes("Offline"),
    );
    await openList();
    await pick.waitForDisplayed();
    expect(await $('[data-testid="virtual-project-directory-browser"]').isExisting()).toBe(false);
    expect((await directory()).entries).toHaveLength(2);
    await $('[data-testid="remote-project-back"]').click();
    await browser.keys("Escape");
    await writeFile(
      join(artifacts, "existing-project-facts.json"),
      JSON.stringify(
        {
          first,
          second,
          taskId,
          entries,
          task: tree.tasks.find((task) => task.taskId === taskId),
          unverified: ["real legacy server", "WSL", "mobile"],
        },
        null,
        2,
      ),
    );
  });
});
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
