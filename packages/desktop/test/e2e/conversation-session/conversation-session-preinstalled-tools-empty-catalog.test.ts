import { pinE2ELocale } from "#e2e/helpers/desktop-app";
import type { IPlatformService } from "@zcode/shared";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

describe("预装工具尚无发布资源（待审核）", () => {
  it("空 catalog 保持无目标与无下载操作，普通聊天可完成", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();
    // 宿主可能使用英文，环境变量不能保证 macOS 界面语言；固定语言后再核对中文文案。
    await pinE2ELocale("zh-CN");
    // Electron 测试桥会将顶层 null 结果折叠为 undefined；用对象保留缺省值的证据。
    const { testCatalog } = await browser.electron.execute(() => ({
      testCatalog: process.env.ZCODE_E2E_PREINSTALLED_TOOLS_CATALOG ?? null,
    }));
    expect(testCatalog).toBeTruthy();
    const catalog = JSON.parse(await readFile(testCatalog!, "utf8"));
    expect(catalog).toHaveLength(5);
    expect(catalog.every((tool: { resources: unknown[] }) => tool.resources.length === 0)).toBe(
      true,
    );
    await $('[data-testid="workspace-help-menu-trigger"]').click();
    await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
    await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed();
    expect(await $('[data-testid="preinstalled-tools-dialog"]').getText()).toContain(
      "当前版本暂未提供此工具。",
    );
    const state = await browser.execute(() =>
      (window as Window & { zcode?: IPlatformService }).zcode?.getPreinstalledToolsState?.(),
    );
    expect(state).toMatchObject({
      autoInstallEnabled: true,
      tools: ["python", "qpdf", "pandoc", "poppler", "libreoffice"].map((toolId) => ({
        toolId,
        status: "not-installed",
        target: null,
      })),
    });
    expect(await $$('[data-testid="preinstalled-tools-card"]').length).toBe(5);
    for (const action of ["download", "retry", "cancel", "delete"]) {
      expect(await $(`[data-testid="preinstalled-tools-${action}"]`).isExisting()).toBe(false);
    }
    expect(await $$("[data-sonner-toast]").length).toBe(0);
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-empty-catalog.png`);
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "lop-empty-facts.json"),
      JSON.stringify({ testCatalog, state }, null, 2),
    );
    await browser.keys("Escape");
    await sendV4Prompt("E2E_LOP_EMPTY_CHAT: Reply with E2E_LOP_EMPTY_CHAT_DONE.");
    await waitForV4AssistantMessageContaining("E2E_LOP_EMPTY_CHAT_DONE", 90000);
  });
});
