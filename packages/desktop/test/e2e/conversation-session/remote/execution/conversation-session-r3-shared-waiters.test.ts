import { DatabaseSync } from "node:sqlite";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";
import { createStallableTcpProxy as createStallableProxy } from "#e2e/helpers/ssh-stallable-proxy";
import {
  disconnectRemoteSource,
  requestRemoteProjectConnection,
} from "#e2e/helpers/remote-project-actions";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  readSettings,
} from "#e2e/helpers/desktop-app";
import { removeRemoteProjectEntry } from "#e2e/helpers/ssh-remote-lifecycle";
import {
  connectSSHWorkspace,
  openSSHRemoteDialog,
  fillSSHPasswordSettings,
  clickLastEnabledSSHDialogButton,
  openSSHSourceDirectory,
  readHostProcesses,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  type SSHConnectionConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_SHARED_WAITERS";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-shared-waiters",
);

async function readHostConnectRequests(): Promise<Set<string>> {
  const directory = process.env.ZCODE_E2E_RUNTIME_LOG_DIR;
  if (!directory) throw new Error(`${CASE_MARKER}: 缺少本 worker 的日志目录`);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".log"));
  const ids = new Set<string>();
  for (const content of await Promise.all(
    files.map((name) => readFile(join(directory, name), "utf8")),
  )) {
    for (const line of content.split("\n").slice(0, -1)) {
      const match = /connecting window-scoped remote source, requestId=([^,\s]+), target=.+$/u.exec(
        line,
      );
      if (match) ids.add(match[1]!);
    }
  }
  return ids;
}

describe(`${CASE_MARKER}: 同一 target 的多个等待者与连接中项目入口移除`, () => {
  let proxy: Awaited<ReturnType<typeof createStallableProxy>> | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "shared-waiters.json"), JSON.stringify(facts, null, 2));
    await proxy?.close().catch(() => undefined);
    proxy = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-CON-04 取消向导等待者不取消原项目连接；连接中移除 B 入口后不复活，A 正常上线", async function () {
    this.timeout(30 * 60_000);
    const direct = readSSHRuntimeConfig(CASE_MARKER);
    proxy = await createStallableProxy(direct);
    const proxied: SSHConnectionConfig = {
      host: direct.host,
      password: direct.password,
      port: proxy.port,
      username: direct.username,
    };
    const [workspaceA, workspaceB] = direct.workspacePaths;
    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();

    // 在线：项目 a、项目 b 共享一个 Source 连接（同一 target）。
    const tabA = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config: proxied,
      workspacePath: workspaceA,
    });
    const sourceId = parseRemoteWorkspaceIdentity(tabA.workspaceIdentity!)?.sourceServerId ?? "";
    await openSSHSourceDirectory(proxied, CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(workspaceB, CASE_MARKER);
    const tabB = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: workspaceB,
      timeoutMs: 120_000,
    });
    expect(parseRemoteWorkspaceIdentity(tabB.workspaceIdentity!)?.sourceServerId).toBe(sourceId);
    const projectAId = await $(
      `[data-project-workspace-identity="${tabA.workspaceIdentity}"]`,
    ).getAttribute("data-project-id");
    const projectBId = await $(
      `[data-project-workspace-identity="${tabB.workspaceIdentity}"]`,
    ).getAttribute("data-project-id");
    if (!projectAId || !projectBId) throw new Error(`${CASE_MARKER}: 缺少项目身份`);
    const entryPresent = (projectId: string) => {
      // node:sqlite 只有同步连接；只读提交后的 membership，不把导航缓存当作项目入口的权威。
      const db = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"), {
        readOnly: true,
      });
      try {
        return Boolean(
          db
            .prepare("SELECT 1 FROM remote_project_entries WHERE host_id=? AND remote_project_id=?")
            .get(`remote:server:${sourceId}`, projectId),
        );
      } finally {
        db.close();
      }
    };
    expect(entryPresent(projectBId)).toBe(true);
    facts.online = {
      a: tabA.remoteSessionId,
      b: tabB.remoteSessionId,
      sharedSession: tabA.remoteSessionId === tabB.remoteSessionId,
      accepted: proxy.acceptedCount(),
    };

    // 显式断开 → 新连接停摆 → 点击重连：a/b 两个 workspace 成为同一 target 的等待者。
    await selectTaskOrganizeMode(["项目", "Project"]);

    await disconnectRemoteSource(sourceId!, CASE_MARKER, {
      workspaceIdentities: [tabA.workspaceIdentity!, tabB.workspaceIdentity!],
    });

    proxy.setStall(true);
    const acceptedBeforeReconnect = proxy.acceptedCount();
    await requestRemoteProjectConnection(tabA.workspaceIdentity!, CASE_MARKER);
    await browser.waitUntil(() => Promise.resolve(proxy!.pendingCount() > 0), {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 重连没有产生停摆的 TCP 连接`,
    });
    await browser.waitUntil(
      async () =>
        (await $(`[data-project-workspace-identity="${tabA.workspaceIdentity}"]`).getAttribute(
          "data-connection-state",
        )) === "connecting",
      { timeout: 15_000 },
    );
    facts.waiting = {
      status: "connecting",
      pendingConnections: proxy.pendingCount(),
      acceptedSinceReconnect: proxy.acceptedCount() - acceptedBeforeReconnect,
    };

    // 新项目的连接动作属于 Source；独立设置向导提供可取消的第二个真实等待者。
    const requestsBeforeWizard = await readHostConnectRequests();
    // helper 默认从项目表单进入；本例需要独立设置等待者，否则取消后没有设置返回按钮。
    await openSSHRemoteDialog(CASE_MARKER, { entry: "settings" });
    await $('[data-testid="settings-page"]').waitForDisplayed();
    await fillSSHPasswordSettings(proxied);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    // 该 Host 日志紧接着同步登记 logical waiter；取消 IPC 只能在本次 handler 让出后处理。
    // 等待请求已到达 Host，避免只取消尚未提交的前端表单而误称覆盖了共享等待者。
    await browser.waitUntil(
      async () => {
        const requests = await readHostConnectRequests();
        return [...requests].some((id) => !requestsBeforeWizard.has(id));
      },
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 第二个等待者没有到达 Host` },
    );
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const button = [
            ...document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
          ].find(
            (item) =>
              ["取消连接", "Cancel connection"].includes(item.innerText.trim()) && !item.disabled,
          );
          button?.click();
          return Boolean(button);
        }),
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 第二个向导等待者没有取消入口` },
    );
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const dialog = document.querySelector('[data-testid="ssh-dialog"]');
          return !dialog || /已取消|Cancelled/u.test(dialog.textContent ?? "");
        }),
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 向导取消没有收口` },
    );
    if (await $('[data-testid="ssh-dialog"]').isExisting()) {
      await $('[data-testid="ssh-dialog"]')
        .$('.//button[normalize-space(.)="关闭" or normalize-space(.)="Close"]')
        .click();
      await $('[data-testid="ssh-dialog"]').waitForExist({ reverse: true });
    }
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    expect(proxy.pendingCount()).toBe(1);
    facts.cancelledWizardDidNotCancelProject = true;

    // 当前合同仅移除本机 membership。不能再用 tab-store user-close 回退偷偷关闭运行态。
    await removeRemoteProjectEntry(workspaceB, CASE_MARKER);
    const bEntryGone = !(await $(
      `[data-project-workspace-identity="${tabB.workspaceIdentity}"]`,
    ).isExisting());
    facts.closedBVia = "sidebar-entry-removal";
    const afterClose = await browser.execute((key) => {
      const row = document.querySelector<HTMLElement>(`[data-project-workspace-identity="${key}"]`);
      return row?.dataset.connectionState ?? null;
    }, tabA.workspaceIdentity!);
    const entriesAfterClose = (await readSettings()).lastWorkspaceSession ?? [];
    const bTabGone = !(await readRemoteTabSnapshot(tabB.workspaceIdentity!)).workspaceIdentity;
    facts.afterCloseB = {
      sourceStatus: afterClose,
      pendingConnections: proxy.pendingCount(),
      aEntryPresent: entryPresent(projectAId),
      bEntryPresent: entryPresent(projectBId),
      bRemovedFromSettings: !entriesAfterClose.some(
        (entry) => entry.kind === "remote" && entry.workspacePath === workspaceB,
      ),
      bEntryGone,
      bTabGone,
    };
    expect(facts.afterCloseB).toMatchObject({
      aEntryPresent: true,
      bEntryPresent: false,
      bEntryGone: true,
    });
    expect(proxy.pendingCount()).toBeGreaterThan(0);

    // 代理必须保留 SSH banner；释放原等待者就应恢复，不能再靠一次手动重试掩盖取消或握手失败。
    const released = proxy.release();
    proxy.setStall(false);
    facts.released = released;
    expect(released).toBeGreaterThan(0);
    const restored = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: tabA.workspaceIdentity!,
      expectedPath: workspaceA,
      requireActive: false,
      timeoutMs: 60_000,
    });
    const sessionA = restored.remoteSessionId;
    facts.cameOnlineAfterRelease = true;
    expect(sessionA).not.toBe(tabA.remoteSessionId);
    await browser.pause(5_000);
    const finalEntries = (await readSettings()).lastWorkspaceSession ?? [];
    const finalB = await readRemoteTabSnapshot(tabB.workspaceIdentity!);
    facts.final = {
      sessionA,
      regenerated: sessionA !== tabA.remoteSessionId,
      bTabPresent: Boolean(finalB?.workspaceIdentity),
      bEntryPresent: entryPresent(projectBId),
      bNavigationEntryPresent: finalEntries.some(
        (entry) => entry.kind === "remote" && entry.workspacePath === workspaceB,
      ),
      accepted: proxy.acceptedCount(),
    };
    expect(
      await $(`[data-project-workspace-identity="${tabB.workspaceIdentity}"]`).isExisting(),
    ).toBe(false);
    expect(proxy.acceptedCount() - acceptedBeforeReconnect).toBe(1);
    expect(entryPresent(projectAId)).toBe(true);
    expect(entryPresent(projectBId)).toBe(false);
    expect(await readHostProcesses()).toEqual(initialHosts);
    // agent spawnArgs 恒为 "app-server --stdio"(3.12+ release 优先 glm 原生二进制,
    // 旧 dev 态才是 node zcode.cjs);按 args 匹配与实现形态无关。
    const remoteAgents = await runSSHCommand(
      direct,
      `for d in /proc/[0-9]*; do c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; case "$c" in *"app-server --stdi"[o]*) echo "$(readlink $d/cwd)";; esac; done`,
    );
    facts.remoteAgentCwds = remoteAgents.stdout.trim().split("\n").filter(Boolean);
  });
});
