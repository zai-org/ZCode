import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

async function openDialog() {
  await $('[data-testid="workspace-help-menu-trigger"]').click();
  await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
  await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed();
}
async function waitStatus(status: string) {
  await browser.waitUntil(
    async () =>
      (await $(
        '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]',
      ).getAttribute("data-status")) === status,
    { timeout: 30000 },
  );
}
const fixtureUrl = () => process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL!;

describe("预装初始化失败恢复（待审核）", () => {
  it("LOP-STARTUP: 目录故障不阻塞聊天，手动修复后原会话继续", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();
    const roots = join(resolveE2EStorageRoot(), "preinstalled-tools");
    const root = join(roots, (await readdir(roots))[0]!);
    const legacy = join(root, "installation.json");
    const oldRecord = join(
      root,
      "records",
      "old-resource",
      "25.0.0-darwin-arm64",
      "installation.json",
    );
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await rm(join(root, "tools", "libreoffice", "staging"), { recursive: true, force: true });
        await writeFile(join(root, "tools", "libreoffice", "staging"), "filesystem-conflict");
        await mkdir(join(root, "records", "old-resource", "25.0.0-darwin-arm64"), {
          recursive: true,
        });
        await writeFile(oldRecord, "readable-old-target");
        await writeFile(legacy, "readable-legacy-target");
      },
    });
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
    await openDialog();
    await waitStatus("failed");
    const pid = await browser.electron.execute(
      (electron) =>
        electron.app.getAppMetrics().find((metric) => metric.name === "zcode-preinstalled-tools")
          ?.pid,
    );
    expect(pid).toBeDefined();
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-startup-failed.png`);
    await browser.keys("Escape");
    await sendV4Prompt("E2E_LOP_STARTUP_BEFORE: Read the preinstalled tools environment.");
    await waitForV4AssistantMessageContaining("E2E_LOP_STARTUP_BEFORE_DONE", 90000);
    const firstResult = await getLatestUpstreamToolResultByToolCallId("toolu_lop_startup_before");
    const first = JSON.parse(firstResult!.content) as {
      entryPath: string;
      exists: boolean;
      available: string;
    };
    expect(first.exists).toBe(false);
    expect(first.entryPath).toContain(join("bin", "zcode-soffice"));
    expect(await readFile(oldRecord, "utf8")).toBe("readable-old-target");
    expect(await readFile(legacy, "utf8")).toBe("readable-legacy-target");
    const sessionId = (await getV4PaneSnapshot()).sessionId;
    await rm(join(root, "tools", "libreoffice", "staging"));
    await openDialog();
    await $('[data-testid="preinstalled-tools-retry"]').click();
    await fetch(`${fixtureUrl()}/release`);
    await fetch(`${fixtureUrl()}/finish-check`);
    await waitStatus("ready");
    expect(
      await browser.electron.execute(
        (electron) =>
          electron.app.getAppMetrics().find((metric) => metric.name === "zcode-preinstalled-tools")
            ?.pid,
      ),
    ).toBe(pid);
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-startup-ready.png`);
    await browser.keys("Escape");
    await sendV4Prompt("E2E_LOP_STARTUP_CONTINUE: Read the fixed tool entry after preparation.");
    await waitForV4AssistantMessageContaining("E2E_LOP_STARTUP_CONTINUE_DONE", 90000);
    expect((await getV4PaneSnapshot()).sessionId).toBe(sessionId);
    const result = await getLatestUpstreamToolResultByToolCallId("toolu_lop_startup_continue");
    const continued = JSON.parse(result!.content) as {
      entryPath: string;
      content: string;
      exists: boolean;
      available: string;
    };
    expect(continued.entryPath).toBe(first.entryPath);
    expect(continued.exists).toBe(true);
    expect(continued.available).toBe("1");
    expect(continued.content).toContain(
      `fixture-libreoffice-26.8.1-${process.platform}-${process.arch}`,
    );
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-startup-continued.png`);
  });
});
