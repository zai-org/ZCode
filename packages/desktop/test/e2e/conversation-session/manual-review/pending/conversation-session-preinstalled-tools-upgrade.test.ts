import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  preinstalledToolsCatalogSchema,
  type PreinstalledToolsState,
} from "@zcode/shared/preinstalled-tools";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { resolveE2ERuntimePath, resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import {
  executePreinstalledEntry,
  preinstalledFixtureRecordPath,
  preinstalledFixtureTarget,
  preinstalledEntryPath,
} from "#e2e/helpers/preinstalled-tools-fixture";
import { setPluginPresentation } from "#e2e/helpers/plugin-management-lifecycle";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

const fixtureUrl = () => process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL!;
const card = (toolId = "libreoffice") => `[data-tool-id="${toolId}"]`;
const state = async () =>
  browser.execute(async () =>
    (
      window as typeof window & {
        zcode: { getPreinstalledToolsState(): Promise<PreinstalledToolsState> };
      }
    ).zcode.getPreinstalledToolsState(),
  );
const http = async () =>
  (await fetch(`${fixtureUrl()}/status`)).json() as Promise<{
    requests: number;
    tools: Record<string, { requests: number }>;
  }>;
async function waitStatus(expected: string, toolId = "libreoffice") {
  await browser.waitUntil(
    async () => {
      if ((await state()).tools.find((tool) => tool.toolId === toolId)?.status !== expected)
        return false;
      const label = $(`${card(toolId)} [data-testid="preinstalled-tools-status"]`);
      return !(await label.isExisting()) || (await label.getAttribute("data-status")) === expected;
    },
    { timeout: 30000, timeoutMsg: `${toolId} 未达到 ${expected}` },
  );
}
async function openDialog() {
  await $('[data-testid="workspace-help-menu-trigger"]').click();
  await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
  await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed();
  await $(card()).waitForDisplayed();
}
async function captureUpgradePresentation() {
  for (const locale of ["zh-CN", "en-US"] as const) {
    for (const theme of ["zai-dark", "zai-light"] as const) {
      await setPluginPresentation({ locale, theme, width: 760, height: 640 });
      await browser.waitUntil(
        async () =>
          (await $(`${card()} [data-testid="preinstalled-tools-status"]`).getText()) ===
          (locale === "zh-CN" ? "可更新" : "Update available"),
      );
      await $(`${card()} [data-testid="preinstalled-tools-update"]`).scrollIntoView();
      const fits = await browser.execute(() => {
        const dialog = document.querySelector('[data-testid="preinstalled-tools-dialog"]')!;
        const box = dialog.getBoundingClientRect();
        return (
          dialog.scrollWidth <= dialog.clientWidth + 1 &&
          box.left >= 0 &&
          box.right <= innerWidth + 1
        );
      });
      expect(fits).toBe(true);
      await browser.saveScreenshot(
        `${process.env.ZCODE_E2E_ARTIFACT_DIR}/upgrade-${locale}-${theme}.png`,
      );
    }
  }
  await setPluginPresentation({ locale: "zh-CN", theme: "zai-dark", width: 1000, height: 760 });
  await browser.waitUntil(
    async () =>
      (await $(`${card()} [data-testid="preinstalled-tools-status"]`).getText()) === "可更新",
  );
}
async function restart(setup?: () => Promise<void>) {
  await reloadElectronSessionPreservingBrowserProfile(browser, { afterElectronProcessExit: setup });
  await prepareV4ConversationE2E();
  await openDialog();
}
async function nativeHolder(directory: string) {
  // Windows 只按扩展名启动程序；副本需保留 .exe 才能作为真实原生进程运行。
  const executable = join(
    directory,
    process.platform === "win32" ? "中文 held-native.exe" : "中文 held-native",
  );
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  const child = spawn(
    executable,
    ["-e", 'process.stdout.write("PT_UPGRADE_NATIVE_READY");setInterval(()=>{},1000)'],
    { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exit = once(child, "exit");
  const first = await Promise.race([
    once(child.stdout!, "data"),
    exit.then(() => {
      throw new Error("占用夹具提前退出");
    }),
  ]);
  expect(String(first[0])).toContain("PT_UPGRADE_NATIVE_READY");
  return {
    child,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exit;
      }
    },
  };
}

describe("预装工具升级与启动清理（待审核）", () => {
  it("PT-17: 旧入口持续可用，发布切换且启动按占用回收", async function () {
    this.timeout(360000);
    const probe = resolveE2ERuntimePath("conversation-session-preinstalled-tools-upgrade");
    await mkdir(probe, { recursive: true });
    await cp(
      new URL(
        "../../../fixtures/fs/conversation-session/conversation-session-preinstalled-tools-upgrade/probe.mjs",
        import.meta.url,
      ),
      join(probe, "probe.mjs"),
    );
    await prepareV4ConversationE2E();
    for (const id of ["qpdf", "libreoffice"]) {
      await fetch(`${fixtureUrl()}/${id}/release`);
      await fetch(`${fixtureUrl()}/${id}/finish-check`);
      await waitStatus("ready", id);
    }
    await openDialog();
    await $('[data-testid="preinstalled-tools-auto-install"]').click();
    await browser.waitUntil(async () => (await state()).autoInstallEnabled === false);
    const roots = join(resolveE2EStorageRoot(), "preinstalled-tools");
    const root = join(roots, (await readdir(roots))[0]!);
    const recordPath = await preinstalledFixtureRecordPath(root);
    const previous = JSON.parse(await readFile(recordPath, "utf8"));
    const qpdfPath = await preinstalledFixtureRecordPath(root, "qpdf");
    const qpdf = JSON.parse(await readFile(qpdfPath, "utf8"));
    expect(
      (await state()).tools.find((tool) => tool.toolId === "libreoffice")?.installed,
    ).toMatchObject({ resourceId: previous.resourceId });
    const catalogPath = process.env.ZCODE_E2E_PREINSTALLED_TOOLS_CATALOG!;
    const catalog = preinstalledToolsCatalogSchema.parse(
      JSON.parse(await readFile(catalogPath, "utf8")),
    );
    const resource = catalog.find((tool) => tool.toolId === "libreoffice")!.resources[0]!;
    const expectedOutput = resource.runtimeChecks[0]!.expectedOutput;
    const nativeArch = resource.binaryArch;
    resource.resourceId += "-r2";
    resource.version = "26.8.2";
    // 小夹具只验证跨架构声明的错误分类与诊断，不声称执行了真实仿真程序。
    resource.binaryArch = process.arch === "arm64" ? "x64" : "arm64";
    resource.runtimeChecks[0]!.expectedOutput = "E2E_PT_UPGRADE_RUNTIME_MISMATCH";
    await restart(() => writeFile(catalogPath, JSON.stringify(catalog)));
    await waitStatus("not-installed");
    expect(await $(`${card()} [data-testid="preinstalled-tools-status"]`).getText()).toBe("可更新");
    expect(await $(card()).getText()).toContain("正在使用版本 26.8.1");
    await captureUpgradePresentation();
    await $(`${card()} [data-testid="preinstalled-tools-update"]`).click();
    await waitStatus("failed");
    expect((await state()).tools.find((tool) => tool.toolId === "libreoffice")?.error).toBe(
      "runtime",
    );
    const logDir = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR!);
    let failureDiagnostic: Record<string, unknown> | null = null;
    await browser.waitUntil(
      async () => {
        const logs = await Promise.all(
          (await readdir(logDir))
            .filter((name) => name.endsWith(".log"))
            .map((name) => readFile(join(logDir, name), "utf8")),
        );
        const line = logs
          .join("\n")
          .split("\n")
          .find(
            (value) =>
              value.includes("准备失败") && value.includes(JSON.stringify(resource.resourceId)),
          );
        if (!line) return false;
        failureDiagnostic = JSON.parse(line.slice(line.indexOf("{", line.indexOf("准备失败"))));
        expect(failureDiagnostic).toMatchObject({
          binaryArch: resource.binaryArch,
          hostArch: process.arch,
          errorKind: "runtime",
        });
        return true;
      },
      { timeout: 10000, timeoutMsg: "落盘失败日志缺少资源与本机架构诊断" },
    );
    expect(await $(card()).getText()).toContain("正在使用版本 26.8.1");
    expect(await $(`${card()} [data-testid="preinstalled-tools-delete"]`).isDisplayed()).toBe(true);
    const publicEntry = preinstalledEntryPath(join(root, "bin"), "zcode-soffice");
    expect(
      (
        await executePreinstalledEntry(join(root, "bin"), "zcode-soffice", ["--fixture-location"])
      ).stdout.trim(),
    ).toBe(join(previous.installationDir, preinstalledFixtureTarget("libreoffice")));
    expect(JSON.parse(await readFile(recordPath, "utf8")).resourceId).toBe(previous.resourceId);
    await browser.saveScreenshot(
      `${process.env.ZCODE_E2E_ARTIFACT_DIR}/upgrade-failed-old-ready.png`,
    );

    resource.binaryArch = nativeArch;
    resource.runtimeChecks[0]!.expectedOutput = expectedOutput;
    await fetch(`${fixtureUrl()}/libreoffice/hold`);
    await fetch(`${fixtureUrl()}/libreoffice/hold-check`);
    await restart(() => writeFile(catalogPath, JSON.stringify(catalog)));
    await waitStatus("not-installed");
    await browser.keys("Escape");
    await switchV4Mode("yolo");
    const observations: Array<{ executable: string; available: string }> = [];
    let sessionId: string | null = null;
    const observe = async (stage: "before" | "during" | "after", directory: string) => {
      const marker = `E2E_PT_UPGRADE_${stage.toUpperCase()}`;
      await sendV4Prompt(
        `${marker}: Run the exact read-only preinstalled executable location probe.`,
      );
      await waitForV4AssistantMessageContaining(`${marker}_DONE`, 90000);
      await waitForV4ConversationState((value) => value.state === "idle", "升级入口探测未结束");
      const result = await getLatestUpstreamToolResultByToolCallId(`toolu_pt_upgrade_${stage}`);
      expect(result?.isError).toBe(false);
      const observed = JSON.parse(result!.content);
      expect(observed.available).toBe("1");
      expect(observed.executable).toBe(join(directory, preinstalledFixtureTarget("libreoffice")));
      const current = (await getV4PaneSnapshot()).sessionId;
      if (sessionId) expect(current).toBe(sessionId);
      sessionId = current;
      observations.push(observed);
    };
    await observe("before", previous.installationDir);
    await openDialog();
    await $(`${card()} [data-testid="preinstalled-tools-update"]`).click();
    await waitStatus("preparing");
    expect(await $(card()).getText()).toContain("正在使用版本 26.8.1");
    await browser.saveScreenshot(
      `${process.env.ZCODE_E2E_ARTIFACT_DIR}/upgrade-preparing-old-ready.png`,
    );
    await browser.keys("Escape");
    await observe("during", previous.installationDir);
    await fetch(`${fixtureUrl()}/libreoffice/release`);
    await fetch(`${fixtureUrl()}/libreoffice/finish-check`);
    await waitStatus("ready");
    const installed = JSON.parse(await readFile(recordPath, "utf8"));
    expect(installed.resourceId).toBe(resource.resourceId);
    await observe("after", installed.installationDir);
    expect(JSON.parse(await readFile(qpdfPath, "utf8"))).toEqual(qpdf);
    expect((await http()).tools.qpdf!.requests).toBe(1);
    await expect(stat(previous.installationDir)).resolves.toBeDefined();

    const orphan = join(root, "tools", "libreoffice", "versions", "unpublished-orphan");
    await mkdir(orphan);
    const staging = join(root, "tools", "libreoffice", "staging");
    await writeFile(join(staging, "interrupted.tmp"), "unpublished");
    const workerPid = await browser.electron.execute(
      (electron) =>
        electron.app.getAppMetrics().find((item) => item.name === "zcode-preinstalled-tools")!.pid,
    );
    process.kill(workerPid, "SIGKILL");
    await browser.waitUntil(
      async () =>
        (await browser.electron.execute(
          (electron) =>
            electron.app.getAppMetrics().find((item) => item.name === "zcode-preinstalled-tools")
              ?.pid,
        )) !== workerPid,
      { timeout: 30000 },
    );
    await waitStatus("ready");
    expect(await readdir(staging)).toEqual([]);
    await expect(stat(orphan)).resolves.toBeDefined();
    await expect(stat(previous.installationDir)).resolves.toBeDefined();
    const requests = (await http()).requests;
    let holder: Awaited<ReturnType<typeof nativeHolder>> | undefined;
    try {
      // 重启 helper 会按 HOME 回收旧进程；退出屏障之后再建占用，才能测到新 App 的真实保护。
      await restart(async () => {
        holder = await nativeHolder(join(previous.installationDir, "bin"));
      });
      await waitStatus("ready");
      expect(holder!.child.exitCode).toBeNull();
      expect(holder!.child.signalCode).toBeNull();
      await expect(stat(orphan)).rejects.toHaveProperty("code", "ENOENT");
      await expect(stat(previous.installationDir)).resolves.toBeDefined();
      expect((await http()).requests).toBe(requests);
    } finally {
      await holder?.stop();
    }
    await restart();
    await waitStatus("ready");
    await expect(stat(previous.installationDir)).rejects.toHaveProperty("code", "ENOENT");
    expect((await http()).requests).toBe(requests);

    resource.resourceId += "-r3";
    resource.version = "26.8.3";
    await fetch(`${fixtureUrl()}/libreoffice/hold`);
    await restart(() => writeFile(catalogPath, JSON.stringify(catalog)));
    await $(`${card()} [data-testid="preinstalled-tools-update"]`).click();
    await waitStatus("preparing");
    await browser.waitUntil(async () => (await http()).requests === requests + 1);
    await restart();
    await waitStatus("not-installed");
    expect(await readdir(staging)).toEqual([]);
    expect((await http()).requests).toBe(requests + 1);
    expect(
      (await state()).tools.find((tool) => tool.toolId === "libreoffice")?.installed?.resourceId,
    ).toBe(installed.resourceId);

    const remaining = catalog.filter((tool) => tool.toolId === "libreoffice");
    remaining[0]!.resources = [];
    await restart(() => writeFile(catalogPath, JSON.stringify(remaining)));
    await waitStatus("ready");
    await expect(stat(preinstalledEntryPath(join(root, "bin"), "qpdf"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    await expect(stat(join(root, "tools", "qpdf"))).rejects.toHaveProperty("code", "ENOENT");
    expect(await $(card()).getText()).toContain("当前版本暂未提供此工具");
    expect(await $(card()).getText()).toContain("正在使用版本 26.8.2");
    await browser.saveScreenshot(
      `${process.env.ZCODE_E2E_ARTIFACT_DIR}/upgrade-installed-without-target.png`,
    );
    await $(`${card()} [data-testid="preinstalled-tools-delete"]`).click();
    await $('[data-testid="preinstalled-tools-delete-confirm-accept"]').click();
    await waitStatus("not-installed");
    expect(
      (await state()).tools.find((tool) => tool.toolId === "libreoffice")?.installed,
    ).toBeNull();
    await expect(stat(publicEntry)).rejects.toHaveProperty("code", "ENOENT");
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "upgrade-facts.json"),
      JSON.stringify(
        { previous, installed, qpdf, observations, failureDiagnostic, requests: await http() },
        null,
        2,
      ),
    );
  });
});
