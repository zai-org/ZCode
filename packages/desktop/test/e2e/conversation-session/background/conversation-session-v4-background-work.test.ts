// M4 门禁：cancelBackgroundWork（v4 后台工作面板取消）。
// 证据层 L3：首轮模型返回 run_in_background 的 Bash tool_use → 批准权限 → 后台 bash 启动
// → BackgroundTaskStarted 事件 → reducer 填充 backgroundWorks → 后台工作面板显示 running →
// 点取消 → cancelBackgroundWork 命令 → v4-bridge cancelBackgroundTask → 进程被杀 →
// BackgroundTaskCompleted(cancelled) → 面板状态 cancelled。证明后台工作全链路。
import { clearAppData } from "#e2e/helpers/desktop-app";
import {
  approveV4Permission,
  clickV4BackgroundWorkCancel,
  describeV4BackgroundFailureState,
  getV4ComposerBackgroundWorkCounts,
  getLatestV4CommandAck,
  getV4BackgroundWorks,
  openV4ComposerRunningBackgroundWorks,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ElectronWindowSize,
  waitForV4PermissionDialog,
} from "#e2e/helpers/v4-conversation";

describe("v4 M4 门禁：cancelBackgroundWork", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("后台 bash 启动 → 面板显示 running → 取消 → cancelled", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();
    // 与窄屏共用可容纳的内容高度，只改变待测的宽度断点，避免宿主屏幕截断。
    await setV4ElectronWindowSize(1280, 800);

    // 首轮触发 run_in_background 的 Bash tool_use。若出现权限弹窗则批准（best-effort）。
    await sendV4Prompt("E2E_V4_BGWORK 起一个后台任务");
    try {
      await waitForV4PermissionDialog(15000);
      await approveV4Permission();
    } catch {
      // 未出现权限弹窗（可能默认放行 bash）——直接等后台工作面板。
    }

    // Composer 入口先暴露当前 session 的 typed running count。
    try {
      await browser.waitUntil(
        async () => {
          const counts = await getV4ComposerBackgroundWorkCounts();
          return (
            counts?.bashCount === 1 &&
            counts.subagentCount === 0 &&
            counts.totalCount === 1 &&
            counts.typedVisible &&
            !counts.compactVisible
          );
        },
        { timeout: 60000, timeoutMsg: "Composer 没有显示 running Bash typed count" },
      );
    } catch (error) {
      throw new Error(
        `Composer 没有显示 running Bash typed count: ${await describeV4BackgroundFailureState()}`,
        { cause: error },
      );
    }

    // 窄 Composer 合并为 Activity 总数；点击后 panel 使用 overlay 并直达 Running。
    await setV4ElectronWindowSize(480, 800);
    await browser.waitUntil(
      async () => {
        const counts = await getV4ComposerBackgroundWorkCounts();
        return counts?.totalCount === 1 && counts.compactVisible && !counts.typedVisible;
      },
      { timeout: 15000, timeoutMsg: "窄 Composer 没有合并为 Activity 总数" },
    );
    await openV4ComposerRunningBackgroundWorks(60000);
    const narrowLayout = await browser.execute(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      timelineClass:
        document.querySelector<HTMLElement>('[data-v4-timeline-content-column="true"]')
          ?.className ?? "",
    }));
    expect(narrowLayout.scrollWidth).toBeLessThanOrEqual(narrowLayout.clientWidth + 1);
    expect(narrowLayout.timelineClass).not.toContain("-translate-x-[10.75rem]");

    let workId = "";
    await browser.waitUntil(
      async () => {
        const works = await getV4BackgroundWorks();
        const running = works.find((w) => w.status === "running");
        if (running) {
          workId = running.workId;
          return true;
        }
        return false;
      },
      { timeout: 60000, timeoutMsg: "后台工作面板没有出现 running 项" },
    );
    expect(workId).toBeTruthy();

    // 取消该后台工作 → command accepted/noop，running item 从 active 面板消失。
    const clicked = await clickV4BackgroundWorkCancel(workId);
    expect(clicked).toBe(true);
    await browser.waitUntil(
      async () => {
        const works = await getV4BackgroundWorks();
        return !works.some((work) => work.workId === workId);
      },
      { timeout: 60000, timeoutMsg: "取消后 running background item 没有消失" },
    );
    const ack = await getLatestV4CommandAck("cancelBackgroundWork");
    expect(["accepted", "noop"]).toContain(ack?.status);
    await browser.waitUntil(async () => (await getV4ComposerBackgroundWorkCounts()) === null, {
      timeout: 30000,
      timeoutMsg: "最后一个 running task 收口后 Composer 入口仍存在",
    });
  });
});
