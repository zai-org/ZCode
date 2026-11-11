// 刷新恢复×权限挂起（环境故障 catalog：权限弹窗挂起时刷新；case catalog 战役优先面）。
// 证据层 L3：Bash exact 权限弹窗挂起 → renderer 刷新（CLI/host 继续跑，broker deferred 仍在等）→
// 冷订阅恢复 snapshot.pendingInteractions → 弹窗重现 → 批准 → resolveInteraction 仍能
// 路由回 CLI broker → 工具执行 → 终态文本。证明 pendingInteractions 的跨刷新恢复链路。
import { mkdir, rm } from "node:fs/promises";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";
import {
  approveV4PermissionAlways,
  getV4PaneSnapshot,
  hasV4PermissionDialog,
  hasV4PermissionFeedbackInput,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4PermissionDialog,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const V4_REFRESH_PERM_DIR = resolveE2ERuntimePath("conversation-session-v4-refresh-permission");

describe("v4 刷新恢复：权限弹窗挂起时 renderer 刷新", () => {
  before(async () => {
    await rm(V4_REFRESH_PERM_DIR, { recursive: true, force: true });
    await mkdir(V4_REFRESH_PERM_DIR, { recursive: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(V4_REFRESH_PERM_DIR, { recursive: true, force: true });
  });

  it("权限弹窗挂起 → 刷新 → 弹窗恢复 → 批准 → 工具执行收口", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_REFRESH_PERM 使用 Bash 写入 fixture 文件");

    // 权限弹窗出现（pendingInteractions 挂起）
    await waitForV4PermissionDialog();
    expect(await hasV4PermissionFeedbackInput()).toBe(true);
    const bound = await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null,
      "权限挂起前没有绑定 session",
      15000,
    );
    const sessionId = bound.sessionId;

    // renderer 刷新：CLI/host 进程继续跑，broker deferred 仍在等待应答
    await browser.refresh();
    await waitForV4Pane(
      (s) => s.sessionId === sessionId,
      "刷新后 pane 没有恢复到原 session",
      60000,
    );

    // 冷订阅恢复 snapshot.pendingInteractions → 弹窗必须重现
    await waitForV4PermissionDialog(30000);
    expect(await hasV4PermissionFeedbackInput()).toBe(true);

    // exact rule 按产品语义不展示原始命令；通过 allowAlways option 的稳定语义定位，
    // 再由重复完全相同命令不弹窗证明刷新后仍恢复并持久化了原始 permission update。
    const dismissed = await approveV4PermissionAlways();
    expect(dismissed).toBe(true);

    await waitForV4TimelineContaining("V4_REFRESH_PERM_DONE", 60000);

    let repeatedExactPrompted = false;
    await sendV4Prompt("E2E_V4_REFRESH_PERM_REPEAT 重复完全相同的 Bash 命令");
    await browser.waitUntil(
      async () => {
        repeatedExactPrompted ||= await hasV4PermissionDialog();
        return (await getV4PaneSnapshot()).timelineText.includes("V4_REFRESH_PERM_REPEAT_DONE");
      },
      { timeout: 60000, timeoutMsg: "刷新后持久化的 exact rule 没有自动执行" },
    );
    expect(repeatedExactPrompted).toBe(false);
  });
});
