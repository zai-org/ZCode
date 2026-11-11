import { dirname } from "node:path";
import { PlatformChannels } from "@zcode/shared";
import type { BrowserViewCloseTabNotification } from "@zcode/shared";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import {
  SMALL_AGENT_WARMUP_SCENARIO,
  getPassiveAgentStartupWorkspacePaths,
} from "#e2e/helpers/passive-agent-startup-fixture";
import {
  openWorkspaceDraftFromSidebar,
  waitForActiveWorkspacePath,
  waitForRestoredProjects,
} from "#e2e/helpers/workspace-agent-warmup";
import {
  openFirstBrowserTab,
  readBrowserTabIds,
  waitForTabCount,
} from "#e2e/helpers/browser-side-pane";

/**
 * 本 spec 守的是修复承诺对应的端到端场景：main 关闭逻辑 tab 时用户已经切到别的 workspace，
 * 通知必须带上原 workspace 的 scope，renderer 才能把它写进那个 workspace 的持久化 memory，
 * 用户切回来时看不到幽灵 tab。
 *
 * 覆盖边界（有意划清，避免声称过头）：
 * - 覆盖 renderer 侧的通知路由、真实 workspace 切换时机、side pane memory 持久化，以及 IPC 投递；
 * - 不覆盖 main 侧从 tab.owner 拼装 payload 的那一步 —— 通知在这里由测试直接注入。
 *   原字段拼装与 tab.owner 单测已退役；这两项独立断言仍是覆盖缺口，不能归入本 E2E。
 */
describe("Browser tab 跨 workspace 关闭通知 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BTC02: 用户切到别的 workspace 时收到关闭通知，切回后不残留幽灵 tab", async function () {
    this.timeout(300_000);

    const workspacePaths = getPassiveAgentStartupWorkspacePaths(
      dirname(DEFAULT_WORKSPACE),
      SMALL_AGENT_WARMUP_SCENARIO.workspaceCount,
    );
    // 启动时活跃的那个当作 workspace A，省掉一次切换；剩下的那个当 workspace B。
    const workspaceA = workspacePaths[SMALL_AGENT_WARMUP_SCENARIO.activeWorkspaceIndex];
    const workspaceB = workspacePaths.find((path) => path !== workspaceA);
    if (!workspaceA || !workspaceB) throw new Error("跨 workspace 用例需要两个 workspace fixture");

    await waitForWorkspaceApp(workspaceA, 30_000);
    await waitForActiveWorkspacePath(workspaceA);
    await waitForRestoredProjects(workspacePaths);

    await openFirstBrowserTab();
    const [tabIdA] = await readBrowserTabIds();
    if (!tabIdA) throw new Error("workspace A 没有成功打开 Browser tab");

    // 先做一次「切走再切回」的空跑：确认 A 的 tab 会随 memory 恢复回来。
    // 没有这一步，末尾的「切回 A 后 tab 数为 0」可能只是因为 A 的面板压根没恢复，断言会假绿。
    await openWorkspaceDraftFromSidebar(workspaceB);
    await waitForTabCount(0);
    await openWorkspaceDraftFromSidebar(workspaceA);
    await waitForTabCount(1);
    expect(await readBrowserTabIds()).toEqual([tabIdA]);

    // 回到 B 并在 B 里也开一个 tab，用来验证 A 的通知不会波及 B。
    await openWorkspaceDraftFromSidebar(workspaceB);
    await waitForTabCount(0);
    await openFirstBrowserTab();
    const [tabIdB] = await readBrowserTabIds();
    if (!tabIdB) throw new Error("workspace B 没有成功打开 Browser tab");
    expect(tabIdB).not.toEqual(tabIdA);

    // 路由必须按 workspaceKey 分流，而不是拿 tabId 全局删：scope 指向 A 的通知只该去翻 A 的
    // memory，即使它带的 tabId 正好是 B 当前显示的那个，B 的 tab 也不能消失。
    await sendCloseTabNotification({ tabId: tabIdB, workspaceKey: workspaceA });
    await expectTabIdsStable([tabIdB]);

    // 真实故障路径：Agent 此刻关掉 A 的 tab。旧实现的通知不带 scope，renderer 只能在当前活跃
    // workspace（此刻是 B）里找，找不到就静默丢弃，A 的 memory 里那个 tab 就此变成关不掉的幽灵。
    // 这里 workspaceKey 直接用 workspace 绝对路径 —— 本地 workspace 没有 workspaceIdentity，
    // main 只是把 renderer attach 时报上来的 key 原样回声，所以它就等于 renderer 的 memory key。
    // 这条断言顺带把「本地 workspace 的 workspaceKey 形状」这个契约一起锁住了。
    await sendCloseTabNotification({ tabId: tabIdA, workspaceKey: workspaceA });
    await expectTabIdsStable([tabIdB]);

    await openWorkspaceDraftFromSidebar(workspaceA);
    await waitForTabCount(0);
  });
});

async function sendCloseTabNotification(
  notification: BrowserViewCloseTabNotification,
): Promise<void> {
  const deliveredCount = (await browser.electron.execute(
    (electron, channel, payload) => {
      const windows = electron.BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
      for (const win of windows) win.webContents.send(channel as string, payload);
      return windows.length;
    },
    PlatformChannels.BrowserViewCloseTab,
    notification,
  )) as unknown as number;
  if (!deliveredCount) throw new Error("主进程没有可投递关闭通知的窗口");
}

/** 通知是单向 IPC，没有回执可等；给足处理时间后再确认 tab 列表没被动过。 */
async function expectTabIdsStable(expectedTabIds: string[]): Promise<void> {
  await browser.pause(1000);
  expect(await readBrowserTabIds()).toEqual(expectedTabIds);
}
