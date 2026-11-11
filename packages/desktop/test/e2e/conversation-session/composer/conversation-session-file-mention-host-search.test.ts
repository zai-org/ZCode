import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import {
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  switchToNewestWindow,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";

const marker = "E2E_MFH01_HOST_SEARCH";
const root = join(getE2EAppDataPaths().workspace, ".zcode-e2e", "file-mention-host-search");

describe("MFH01：@ 文件候选由 Host 查询", () => {
  before(async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `${marker}.ts`), "export const marker = true;\n");
    // 冷启动可能先连接到过渡窗口；切到产品窗口后，再退出隔离用户目录的首次引导。
    await browser.waitUntil(
      async () => {
        await switchToNewestWindow();
        return (
          (await $('[data-testid="onboarding-page"]').isDisplayed()) ||
          (await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).isDisplayed())
        );
      },
      { timeout: 30000, timeoutMsg: "首次引导或 Composer 没有出现" },
    );
    if (await $('[data-testid="onboarding-page"]').isDisplayed()) {
      await browser.keys("Escape");
    }
    await waitForDefaultWorkspaceReady(30000);
    // 原因：文件创建在隔离项目中，启动页全局草稿不保证选中该项目。
    await startDraftFromProject(getE2EAppDataPaths().workspace);
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
    await browser.electron.restoreAllMocks();
  });
  it("关键词找到实际文件并插入 mention，输入继续响应", async () => {
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, `@${marker}`, {
      stabilizeLexicalCaretAtEnd: true,
    });
    // Host 以绝对路径标识候选；相对路径仅用于展示，不能作为选项身份。
    const optionId = `file:${join(root, `${marker}.ts`)}`;
    const option = await $(`[data-option-id=${JSON.stringify(optionId)}]`);
    await option.waitForDisplayed({ timeout: 30000 });
    await option.click();
    const input = await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`);
    await expect(input).toHaveText(expect.stringContaining(`${marker}.ts`));
    await input.click();
    await browser.keys("继续输入");
    await expect(input).toHaveText(expect.stringContaining("继续输入"));
  });
});
