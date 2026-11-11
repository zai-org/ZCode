import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { projectSectionSelector } from "#e2e/helpers/project-sidebar";
import {
  execInRemoteContainer,
  readRemoteDockerContainer,
} from "#e2e/helpers/remote-docker-target";
import {
  breakSessionDatabase,
  restoreSessionDatabase,
} from "#e2e/helpers/remote-session-database-fault";
import {
  connectSSHWorkspace,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";

const MARKER = "E2E_REMOTE_PROJECT_READ_FAILED";
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-project-read-failed",
);
const FAILED_LABELS = ["连接失败", "Connection failed"];

/** 关闭项目 tab：重连设备时不再登记该项目，只留侧栏读取这一条登记路径。 */
async function closeWorkspaceTab(workspaceIdentity: string): Promise<void> {
  await browser.execute((identity) => {
    const store = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState(): {
            tabs: Array<{ id: string; workspaceIdentity?: string }>;
            closeTab(id: string, origin?: "user-close"): void;
          };
        };
      }
    ).__zcodeTabStoreE2E;
    const tab = store?.getState().tabs.find((item) => item.workspaceIdentity === identity);
    if (!store || !tab) throw new Error(`Missing remote workspace tab: ${identity}`);
    store.getState().closeTab(tab.id, "user-close");
  }, workspaceIdentity);
  await browser.waitUntil(
    async () => (await readRemoteTabSnapshot(workspaceIdentity)).workspaceIdentity === null,
    { timeout: 30_000, timeoutMsg: `${MARKER}: 远程项目 tab 没有关闭` },
  );
}

/** 侧栏读取由事件触发；窗口聚焦是产品已有的重读入口，不新增轮询。 */
async function refreshSidebarByFocus(): Promise<void> {
  await browser.execute(() => window.dispatchEvent(new Event("focus")));
}

describe(`${MARKER}: 设备在线但项目读取失败`, () => {
  let container: string | undefined;
  const facts: Record<string, unknown> = {};
  after(async () => {
    if (container) await restoreSessionDatabase(container);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "read-failed.json"), JSON.stringify(facts, null, 2));
    await clearAppData();
  });

  it("RDUX-SIDEBAR-READ-FAILED / VPR07 读取失败显示连接失败与原因，已删项目不以缓存复现，恢复后回到在线", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(MARKER);
    container = readRemoteDockerContainer(MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const kept = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[0],
    });
    const removed = await connectSSHWorkspace({
      caseMarker: MARKER,
      config,
      workspacePath: config.workspacePaths[1],
    });
    await selectTaskOrganizeMode(["项目", "Project"]);
    const localRow = $(`${projectSectionSelector(DEFAULT_WORKSPACE)}[data-project-host="local"]`);
    await localRow.waitForDisplayed({ timeout: 30_000 });
    const localProjectId = await localRow.getAttribute("data-project-id");
    facts.localProjectId = localProjectId;
    const keptRow = $(`[data-project-workspace-identity="${kept.workspaceIdentity}"]`);
    await keptRow.waitForDisplayed({ timeout: 30_000 });
    const removedRow = $(`[data-project-workspace-identity="${removed.workspaceIdentity}"]`);
    await removedRow.waitForDisplayed({ timeout: 30_000 });

    // VPR07：在线删除只软删远端项目并保留本机入口，刷新把删除态写入入口缓存。
    await removedRow.$('[data-testid="virtual-project-row"]').click({ button: "right" });
    await $('[data-testid="virtual-project-delete"]').click();
    await removedRow.waitForExist({ reverse: true, timeout: 30_000 });

    // 远端身份登记按物理连接缓存（a13711c127），同一连接上的重读不会再打开会话库。
    // 先关闭项目 tab（恢复连接时不再登记打开中的项目），再在远端断开 dev 的 SSH 会话，
    // 由自动恢复换一条物理连接；之后侧栏读取重新登记时才真实打开损坏的库，设备本身仍在线。
    // 手动“连接”会对设备目录做一次登记并直接失败，不能用来制造“设备在线、项目读取失败”。
    await closeWorkspaceTab(kept.workspaceIdentity!);
    await keptRow.waitForDisplayed({ timeout: 30_000 });
    await breakSessionDatabase(container);
    await execInRemoteContainer(container, ["pkill", "-f", "sshd: dev"], { user: "0" });
    const status = keptRow.$('[data-testid="project-status-label"]');
    // 修复前读取失败被丢弃，设备在线而项目未解析，行内一直显示“连接中”。
    await browser.waitUntil(
      async () => {
        await refreshSidebarByFocus();
        return (await status.isExisting()) && FAILED_LABELS.includes(await status.getText());
      },
      {
        timeout: 120_000,
        interval: 2_000,
        timeoutMsg: `${MARKER}: 项目读取失败后没有显示连接失败`,
      },
    );
    facts.statusLabel = await status.getText();
    // 设备连接本身正常；失败只来自项目读取，不写回设备状态。
    expect(await keptRow.getAttribute("data-connection-state")).toBe("online");
    expect(await localRow.isDisplayed()).toBe(true);
    expect(await localRow.getAttribute("data-project-id")).toBe(localProjectId);
    facts.localProjectVisibleDuringFailure = true;
    // 修复前回退缓存把已删项目写死为未删除，读取失败时它会作为失败行复现。
    expect(await removedRow.isExisting()).toBe(false);

    await keptRow.$('[data-testid="virtual-project-toggle"]').moveTo();
    const failure = $(
      '[data-testid="remote-identity-details"] [data-testid="remote-connection-failure"]',
    );
    await failure.waitForDisplayed({ timeout: 10_000 });
    facts.failureDetails = await failure.getText();
    expect(await failure.$('[data-testid="remote-connection-copy-error"]').isDisplayed()).toBe(
      true,
    );
    // 规格要求原文经复制取得，不能因详情只显示错误分类而误判失败。
    // 先替换剪贴板旧值，避免上次测试已复制同一错误造成假通过；读取真实系统剪贴板。
    const previousClipboard = await browser.electron.execute((electron) =>
      electron.clipboard.readText(),
    );
    try {
      await browser.electron.execute(
        (electron, text) => electron.clipboard.writeText(text),
        MARKER,
      );
      await failure.$('[data-testid="remote-connection-copy-error"]').click();
      await browser.waitUntil(
        async () =>
          (await browser.electron.execute((electron) => electron.clipboard.readText())).includes(
            "file is not a database",
          ),
        { timeout: 10_000, timeoutMsg: `${MARKER}: 系统剪贴板没有本次数据库读取错误` },
      );
      facts.copiedError = await browser.electron.execute((electron) =>
        electron.clipboard.readText(),
      );
      expect(facts.copiedError).toContain("file is not a database");
    } finally {
      await browser.electron.execute(
        (electron, text) => electron.clipboard.writeText(text),
        previousClipboard,
      );
    }
    await mkdir(artifactDir, { recursive: true });
    await browser.saveScreenshot(resolve(artifactDir, "read-failed-details.png"));
    const outside = await browser.execute(() => ({ x: innerWidth - 24, y: 24 }));
    await browser.action("pointer").move(outside).perform();
    await $('[data-testid="remote-identity-details"]').waitForDisplayed({ reverse: true });

    await restoreSessionDatabase(container);
    await refreshSidebarByFocus();
    await status.waitForExist({
      reverse: true,
      timeout: 60_000,
      timeoutMsg: `${MARKER}: 恢复后项目行没有回到在线`,
    });
    expect(await localRow.isDisplayed()).toBe(true);
    expect(await localRow.getAttribute("data-project-id")).toBe(localProjectId);
    facts.localProjectVisibleAfterRecovery = true;
    expect(await removedRow.isExisting()).toBe(false);
    await browser.saveScreenshot(resolve(artifactDir, "read-failed-recovered.png"));
  });
});
