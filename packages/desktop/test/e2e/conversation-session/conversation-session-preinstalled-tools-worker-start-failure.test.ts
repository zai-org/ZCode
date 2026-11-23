import { pinE2ELocale } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const START_FAILURE_TEXT = "预装工具未能启动。请重启 ZCode 后再试";

async function openDialog() {
  await $('[data-testid="workspace-help-menu-trigger"]').click();
  await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
  await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed();
}
async function expectStartFailure() {
  const alert = $('[data-testid="preinstalled-tools-load-failed"]');
  await alert.waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "预装进程启动失败后，对话框仍停在读取状态",
  });
  expect(await alert.getText()).toContain(START_FAILURE_TEXT);
  const dialogText = await $('[data-testid="preinstalled-tools-dialog"]').getText();
  expect(dialogText).not.toContain("正在读取…");
  expect(await $$('[data-testid="preinstalled-tools-card"]').length).toBe(0);
  expect(await $('[data-testid="preinstalled-tools-auto-install"]').isEnabled()).toBe(false);
}

describe("预装进程初始化前退出（待审核）", () => {
  it("PT-30/31: 对话框结束读取并提示重启，Main 不重拉进程", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();
    // 宿主可能使用英文，环境变量不能保证 macOS 界面语言；固定语言后再核对中文文案。
    await pinE2ELocale("zh-CN");
    const { exitBeforeInit } = await browser.electron.execute(() => ({
      exitBeforeInit: process.env.ZCODE_E2E_PREINSTALLED_TOOLS_EXIT_BEFORE_INIT ?? null,
    }));
    expect(exitBeforeInit).toBe("1");

    await openDialog();
    await expectStartFailure();
    // 查询只会在 Main 处理完子进程退出后才以错误结束；此时不应存在被重拉的预装进程。
    const workerPids = await browser.electron.execute((electron) =>
      electron.app
        .getAppMetrics()
        .filter((metric) => metric.name === "zcode-preinstalled-tools")
        .map((metric) => metric.pid),
    );
    expect(workerPids).toEqual([]);
    await browser.saveScreenshot(
      `${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-worker-start-failure.png`,
    );

    // 关闭再打开：新的读取同样以错误结束，不能退回持续加载。
    await browser.keys("Escape");
    await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed({ reverse: true });
    await openDialog();
    await expectStartFailure();
  });
});
