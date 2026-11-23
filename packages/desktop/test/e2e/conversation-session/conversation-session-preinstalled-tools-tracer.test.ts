import {
  executePreinstalledEntry,
  PREINSTALLED_FIXTURE_PROGRAM,
  preinstalledFixtureRecordPath,
  preinstalledFixtureTarget,
  preinstalledEntryPath,
} from "#e2e/helpers/preinstalled-tools-fixture";
import { TID_VIRTUAL_PROJECT_ADD } from "@zcode/shared/test-ids";
import {
  startDraftFromProject,
  selectNativeProjectDirectories,
} from "#e2e/helpers/project-sidebar";
import { getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { readFile, readdir, rm, stat, readlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

const fixtureUrl = () => process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL!;
const status = async () =>
  (await fetch(`${fixtureUrl()}/status`)).json() as Promise<{
    requests: number;
    pending: number;
    runtimeChecks: number;
  }>;
async function openDialog() {
  await $('[data-testid="workspace-help-menu-trigger"]').click();
  // 修复原因：合并 staging 后，Windows 上重启 Electron 之后用 $$().map() 并发读取十余个菜单项属性，
  // 部分新连接被 chromedriver 拒绝（ECONNREFUSED，2/2 复现）；chromedriver 为何短暂拒绝新连接尚未查明。
  // 改为一次 execute 在页面内读出全部菜单项，检查内容不变，也不再依赖并发连接。
  const menuIds = await browser.execute(() =>
    Array.from(document.querySelectorAll('[role="menuitem"]'), (item) =>
      item.getAttribute("data-testid"),
    ),
  );
  expect(menuIds.indexOf("workspace-help-menu-preinstalled-tools")).toBe(
    menuIds.indexOf("workspace-help-menu-resource-manager") + 1,
  );
  await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
  await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed();
}
async function waitStatus(value: string, toolId = "qpdf") {
  await browser.waitUntil(
    async () =>
      (await $(`[data-tool-id="${toolId}"] [data-testid="preinstalled-tools-status"]`).getAttribute(
        "data-status",
      )) === value,
    { timeout: 30000, timeoutMsg: `预装状态未达到 ${value}` },
  );
}
async function preinstallPid() {
  return browser.electron.execute(
    (electron) =>
      electron.app.getAppMetrics().find((metric) => metric.name === "zcode-preinstalled-tools")
        ?.pid ?? null,
  );
}

describe("预装工具后台准备（待审核）", () => {
  it("LOP-01/02/14/31: 静默准备、重启复用与子进程恢复", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();
    await openDialog();
    await waitStatus("preparing");
    expect(await status()).toMatchObject({ requests: 1, pending: 1 });
    expect(
      await $(
        '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]',
      ).getAttribute("data-phase"),
    ).toBe("queued");
    await $('[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-cancel"]').click();
    await waitStatus("not-installed", "libreoffice");
    await $('[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-download"]').click();
    await browser.waitUntil(
      async () =>
        (await $(
          '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]',
        ).getAttribute("data-phase")) === "queued",
    );
    expect(await status()).toMatchObject({ requests: 1, pending: 1 });
    expect(await $$("[data-sonner-toast]").length).toBe(0);
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-tracer-preparing.png`);
    await browser.keys("Escape");
    await sendV4Prompt("E2E_LOP_TRACER_CHAT: Reply with E2E_LOP_TRACER_CHAT_DONE.");
    await waitForV4AssistantMessageContaining("E2E_LOP_TRACER_CHAT_DONE", 90000);
    await openDialog();
    await waitStatus("preparing");
    await fetch(`${fixtureUrl()}/qpdf/release`);
    await browser.waitUntil(
      async () =>
        (await $('[data-tool-id="qpdf"] [data-testid="preinstalled-tools-status"]').getAttribute(
          "data-phase",
        )) === "checking",
      { timeout: 30000 },
    );
    expect(
      await $('[data-tool-id="qpdf"] [role="progressbar"]').getAttribute("aria-valuenow"),
    ).toBeNull();
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-tracer-checking.png`);
    await browser.waitUntil(async () => (await status()).runtimeChecks === 1, {
      timeout: 10000,
      timeoutMsg: "运行检查请求未到达受控服务",
    });
    await fetch(`${fixtureUrl()}/qpdf/finish-check`);
    await waitStatus("ready");
    await browser.waitUntil(async () => (await status()).requests === 2);
    expect(
      await $(
        '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]',
      ).getAttribute("data-phase"),
    ).toBe("downloading");
    await fetch(`${fixtureUrl()}/libreoffice/release`);
    await fetch(`${fixtureUrl()}/libreoffice/finish-check`);
    await waitStatus("ready", "libreoffice");
    const roots = join(resolveE2EStorageRoot(), "preinstalled-tools");
    const release = (await readdir(roots))[0]!;
    const root = join(roots, release);
    const recordPath = await preinstalledFixtureRecordPath(root, "qpdf");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const program = join(record.installationDir, PREINSTALLED_FIXTURE_PROGRAM);
    if (process.platform === "win32") {
      // Windows 夹具不含符号链接，也没有 POSIX 可执行位；只核对入口目标与程序都已解压。
      expect(
        (await stat(join(record.installationDir, preinstalledFixtureTarget("qpdf")))).isFile(),
      ).toBe(true);
      expect((await stat(program)).isFile()).toBe(true);
    } else {
      expect(await readlink(join(record.installationDir, "bin/qpdf"))).toBe("office");
      expect((await stat(program)).mode & 0o111).not.toBe(0);
    }
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-tracer-ready.png`);
    await browser.keys("Escape");
    const workspaceB = join(getE2EAppDataPaths().homeDir, "preinstalled-tools-workspace-b");
    await mkdir(workspaceB, { recursive: true });
    await $('[data-testid="project-section"]').moveTo();
    await $(`[data-testid="${TID_VIRTUAL_PROJECT_ADD}"]`).click();
    await $('[data-testid="virtual-project-name"]').setValue("preinstalled-tools-workspace-b");
    await selectNativeProjectDirectories([workspaceB]);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await $('[data-testid="virtual-project-save"]').waitForExist({ reverse: true });
    await startDraftFromProject(workspaceB);
    await openDialog();
    await waitStatus("ready");
    expect(await status()).toMatchObject({ requests: 2, runtimeChecks: 3 });
    const firstPid = await preinstallPid();
    expect(firstPid).not.toBeNull();
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await prepareV4ConversationE2E();
    await openDialog();
    await waitStatus("ready");
    expect(await status()).toMatchObject({ requests: 2, runtimeChecks: 3 });
    expect(await preinstallPid()).not.toBe(firstPid);
    await $('[data-tool-id="qpdf"] [data-testid="preinstalled-tools-delete"]').click();
    await $('[data-testid="preinstalled-tools-delete-confirm-accept"]').click();
    await waitStatus("not-installed");
    await waitStatus("ready", "libreoffice");
    await expect(
      stat(await preinstalledFixtureRecordPath(root, "libreoffice")),
    ).resolves.toBeDefined();
    await expect(
      stat(preinstalledEntryPath(join(root, "bin"), "zcode-soffice")),
    ).resolves.toBeDefined();
    await fetch(`${fixtureUrl()}/qpdf/hold`);
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await rm(recordPath, { force: true });
        await rm(record.installationDir, { recursive: true, force: true });
      },
    });
    await prepareV4ConversationE2E();
    await openDialog();
    await waitStatus("preparing");
    const killed = await preinstallPid();
    expect(killed).not.toBeNull();
    process.kill(killed!, "SIGKILL");
    await browser.waitUntil(
      async () => {
        const pid = await preinstallPid();
        return pid !== null && pid !== killed;
      },
      { timeout: 30000 },
    );
    await waitStatus("not-installed");
    expect((await status()).requests).toBe(3);
    await expect(stat(recordPath)).rejects.toHaveProperty("code", "ENOENT");
    expect(await readdir(join(root, "tools", "qpdf", "staging"))).toEqual([]);
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-tracer-recovered.png`);

    // 活动项取消后队列必须继续；关闭自动预装不能取消已经排队的另一项。
    await $('[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-delete"]').click();
    await $('[data-testid="preinstalled-tools-delete-confirm-accept"]').click();
    await waitStatus("not-installed", "libreoffice");
    await fetch(`${fixtureUrl()}/libreoffice/hold`);
    await fetch(`${fixtureUrl()}/libreoffice/hold-check`);
    const beforeCancel = (await status()).requests;
    await $('[data-tool-id="qpdf"] [data-testid="preinstalled-tools-download"]').click();
    await browser.waitUntil(async () => (await status()).requests === beforeCancel + 1);
    await $('[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-download"]').click();
    await browser.waitUntil(
      async () =>
        (await $(
          '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]',
        ).getAttribute("data-phase")) === "queued",
    );
    await $('[data-tool-id="qpdf"] [data-testid="preinstalled-tools-cancel"]').click();
    await waitStatus("not-installed");
    await browser.waitUntil(async () => (await status()).requests === beforeCancel + 2);
    await $('[data-tool-id="qpdf"] [data-testid="preinstalled-tools-download"]').click();
    await browser.waitUntil(
      async () =>
        (await $('[data-tool-id="qpdf"] [data-testid="preinstalled-tools-status"]').getAttribute(
          "data-phase",
        )) === "queued",
    );
    await $('[data-testid="preinstalled-tools-auto-install"]').click();
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="preinstalled-tools-auto-install"]').getAttribute(
          "aria-checked",
        )) === "false",
    );
    await fetch(`${fixtureUrl()}/libreoffice/release`);
    await fetch(`${fixtureUrl()}/libreoffice/finish-check`);
    await waitStatus("ready", "libreoffice");
    await browser.waitUntil(async () => (await status()).requests === beforeCancel + 3);
    await fetch(`${fixtureUrl()}/qpdf/release`);
    await waitStatus("ready");
    const invocation = await executePreinstalledEntry(join(root, "bin"), "qpdf", ["--version"]);
    expect(invocation.stderr).toContain("qpdf fixture");
    await browser.saveScreenshot(
      `${process.env.ZCODE_E2E_ARTIFACT_DIR}/pt-active-cancel-queue-continued.png`,
    );
  });
});
