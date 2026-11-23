import { pinE2ELocale } from "#e2e/helpers/desktop-app";
import {
  PREINSTALLED_FIXTURE_PROGRAM,
  preinstalledFixtureRecordPath,
  preinstalledEntryPath,
} from "#e2e/helpers/preinstalled-tools-fixture";
import {
  copyFile,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { PreinstalledToolsState } from "@zcode/shared/preinstalled-tools";
import {
  TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN,
  TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW,
  TID_RESOURCE_MANAGER_STORAGE_STATUS,
  testId,
} from "@zcode/shared/test-ids";
import { resolveE2EHomeDir, resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { setPluginPresentation } from "#e2e/helpers/plugin-management-lifecycle";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  activateResourceManagerTab,
  isMainRendererUrl,
  isResourceManagerUrl,
  openResourceManager,
  switchToElectronRendererTarget,
  waitForResourceManagerReady,
} from "#e2e/helpers/resource-manager";

const fixtureUrl = () => process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL!;
const screenshot = (name: string) =>
  browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-delete-${name}.png`);
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
    { timeout: 30000, timeoutMsg: `预装状态未达到 ${status}` },
  );
}
async function attemptDelete() {
  await $('[data-testid="preinstalled-tools-delete"]').click();
  await $('[data-testid="preinstalled-tools-delete-confirm"]').waitForDisplayed();
  await $('[data-testid="preinstalled-tools-delete-confirm-accept"]').click();
  await $('[data-testid="preinstalled-tools-delete-confirm"]').waitForDisplayed({ reverse: true });
}
async function waitBlocked() {
  await $('[data-testid="preinstalled-tools-delete-blocked"]').waitForDisplayed();
  await browser.waitUntil(async () => $('[data-testid="preinstalled-tools-delete"]').isEnabled(), {
    timeout: 10000,
  });
  await waitStatus("ready");
}
async function nativeHolder(directory: string) {
  await mkdir(directory, { recursive: true });
  // Windows 只按扩展名启动程序；副本需保留 .exe 才能作为真实原生进程运行。
  const executable = join(
    directory,
    process.platform === "win32" ? "中文 held-native.exe" : "中文 held-native",
  );
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  // 真实原生程序位于受管目录；不用外部 shell/curl 的 PID 冒充目录内进程。
  const child = spawn(
    executable,
    ["-e", 'process.stdout.write("LOP_NATIVE_READY");setInterval(()=>{},1000)'],
    { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exit = once(child, "exit");
  const data = await Promise.race([
    once(child.stdout!, "data"),
    exit.then(() => {
      throw new Error("原生占用夹具提前退出");
    }),
  ]);
  expect(String(data[0])).toContain("LOP_NATIVE_READY");
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
async function reload(setup?: () => Promise<void>) {
  await reloadElectronSessionPreservingBrowserProfile(browser, { afterElectronProcessExit: setup });
  await prepareV4ConversationE2E();
  // 宿主可能使用英文，环境变量不能保证 macOS 界面语言；固定语言后再核对中文文案。
  await pinE2ELocale("zh-CN");
  await openDialog();
}

describe("预装工具删除与存储（待审核）", () => {
  it("LOP-25/26/28: 删除确认、占用保护、旧版本和存储归属", async function () {
    this.timeout(480000);
    let holder: { child: ChildProcess; stop(): Promise<void> } | undefined;
    let restorePermissions: string | undefined;
    try {
      await prepareV4ConversationE2E();
      await pinE2ELocale("zh-CN");
      await fetch(`${fixtureUrl()}/release`);
      await fetch(`${fixtureUrl()}/finish-check`);
      await openDialog();
      await waitStatus("ready");
      const storageRoot = resolveE2EStorageRoot();
      expect(storageRoot).toBe(join(resolveE2EHomeDir(), ".zcode"));
      const roots = join(storageRoot, "preinstalled-tools");
      const release = (await readdir(roots))[0]!;
      const root = join(roots, release);
      const recordPath = await preinstalledFixtureRecordPath(root);
      const versions = join(root, "tools", "libreoffice", "versions");
      const entry = preinstalledEntryPath(join(root, "bin"), "zcode-soffice");
      expect((await stat(entry)).isFile()).toBe(true);
      let record = JSON.parse(await readFile(recordPath, "utf8"));
      const firstInstalledAt = record.installedAt;
      await $('[data-testid="preinstalled-tools-delete"]').waitForDisplayed({ timeout: 10000 });
      await $('[data-testid="preinstalled-tools-delete"]').click();
      // 对话框挂载不等于可见；过渡期间 getText 曾返回空值，先观察真实显示状态。
      await $('[data-testid="preinstalled-tools-delete-confirm"]').waitForDisplayed();
      expect(await $('[data-testid="preinstalled-tools-delete-confirm"]').getText()).toContain(
        "下次启动",
      );
      await screenshot("confirm-auto-on");
      await $('[data-testid="preinstalled-tools-delete-confirm-cancel"]').click();
      await $('[data-testid="preinstalled-tools-auto-install"]').click();
      await browser.waitUntil(
        async () =>
          (await $('[data-testid="preinstalled-tools-auto-install"]').getAttribute(
            "aria-checked",
          )) === "false",
        { timeout: 10000 },
      );
      await setPluginPresentation({
        locale: "en-US",
        theme: "zai-light",
        width: 1000,
        height: 760,
      });
      await $('[data-testid="preinstalled-tools-delete"]').click();
      // 对话框挂载不等于可见；过渡期间 getText 曾返回空值，先观察真实显示状态。
      await $('[data-testid="preinstalled-tools-delete-confirm"]').waitForDisplayed();
      expect(await $('[data-testid="preinstalled-tools-delete-confirm"]').getText()).not.toContain(
        "next time",
      );
      await screenshot("confirm-auto-off-light");
      await $('[data-testid="preinstalled-tools-delete-confirm-cancel"]').click();
      await setPluginPresentation({ locale: "zh-CN", theme: "zai-dark", width: 1000, height: 760 });

      holder = await nativeHolder(join(record.installationDir, "bin"));
      await attemptDelete();
      await waitBlocked();
      expect(JSON.parse(await readFile(recordPath, "utf8")).installedAt).toBe(firstInstalledAt);
      expect((await stat(entry)).isFile()).toBe(true);
      await screenshot("native-busy");
      const deadPid = holder.child.pid!;
      await holder.stop();
      holder = undefined;
      const usage = join(root, "usage");
      await mkdir(usage, { recursive: true });
      // Windows 文件名不能含冒号；这些历史标记只需名字唯一，不解析时间。
      const markerStamp = firstInstalledAt.replaceAll(":", "-");
      const activeMarker = join(usage, `${markerStamp}.${process.pid}.${randomUUID()}`);
      await mkdir(activeMarker);
      // 通用合同已删除调用标记；这些历史文件不再代表真实占用，也不由删除链路维护。
      // 真实权限故障不能被视为无占用；恢复权限后用户仍能重试。
      // 该故障依赖 POSIX 目录权限让 lsof//proc 探针无法确认；Windows 按进程可执行路径探测，
      // chmod 也不限制目录访问，制造不出同一前提，只在 POSIX 执行。
      if (process.platform !== "win32") {
        restorePermissions = versions;
        await chmod(versions, 0o000);
        await attemptDelete();
        await waitBlocked();
        await chmod(versions, 0o755);
        restorePermissions = undefined;
      }
      const staleMarker = join(usage, `${markerStamp}.${deadPid}.${randomUUID()}`);
      await mkdir(staleMarker);
      const otherRelease = join(roots, release === "preview" ? "production" : "preview");
      await mkdir(otherRelease, { recursive: true });
      await writeFile(join(otherRelease, "keep.txt"), "other-release");
      // 普通文件读取不会像程序/库映射一样阻止删除。
      const reader = await open(join(record.installationDir, PREINSTALLED_FIXTURE_PROGRAM));
      try {
        await attemptDelete();
        await waitStatus("not-installed");
        await browser.waitUntil(
          async () => $('[data-testid="preinstalled-tools-download"]').isEnabled(),
          { timeout: 10000 },
        );
      } finally {
        await reader.close();
      }
      await expect(stat(entry)).rejects.toHaveProperty("code", "ENOENT");
      await expect(stat(recordPath)).rejects.toHaveProperty("code", "ENOENT");
      expect(await readdir(versions)).toEqual([]);
      expect((await readdir(usage)).sort()).toEqual(
        [basename(activeMarker), basename(staleMarker)].sort(),
      );
      expect(await readFile(join(otherRelease, "keep.txt"), "utf8")).toBe("other-release");
      expect(
        await $('[data-testid="preinstalled-tools-auto-install"]').getAttribute("aria-checked"),
      ).toBe("false");
      await screenshot("deleted");
      await $('[data-testid="preinstalled-tools-download"]').click();
      await waitStatus("ready");
      record = JSON.parse(await readFile(recordPath, "utf8"));
      expect(record.installedAt).not.toBe(firstInstalledAt);

      const oldAfterPublish = join(versions, "fixture-old-after-publish");
      await mkdir(oldAfterPublish);
      await writeFile(join(oldAfterPublish, "keep-until-app-start.txt"), "old");
      const workerBeforeCrash = await browser.electron.execute(
        (electron) =>
          electron.app.getAppMetrics().find((item) => item.name === "zcode-preinstalled-tools")
            ?.pid,
      );
      expect(workerBeforeCrash).toBeDefined();
      await browser.electron.execute((_electron, pid) => {
        process.kill(pid!, "SIGKILL");
      }, workerBeforeCrash);
      await browser.waitUntil(
        async () => {
          const pid = await browser.electron.execute(
            (electron) =>
              electron.app.getAppMetrics().find((item) => item.name === "zcode-preinstalled-tools")
                ?.pid,
          );
          return Boolean(pid && pid !== workerBeforeCrash);
        },
        { timeout: 15000 },
      );
      await browser.execute(async () =>
        (
          window as typeof window & {
            zcode: { getPreinstalledToolsState(): Promise<PreinstalledToolsState> };
          }
        ).zcode.getPreinstalledToolsState(),
      );
      expect((await stat(oldAfterPublish)).isDirectory()).toBe(true);
      const oldBusy = join(versions, "fixture-old-busy");
      const oldIdle = join(versions, "fixture-old-idle");
      await browser.keys("Escape");
      await reload(async () => {
        await mkdir(oldIdle);
        await writeFile(join(oldIdle, "keep-until-start.txt"), "old");
        holder = await nativeHolder(oldBusy);
      });
      await waitStatus("ready");
      expect((await stat(oldBusy)).isDirectory()).toBe(true);
      await expect(stat(oldIdle)).rejects.toHaveProperty("code", "ENOENT");
      await expect(stat(oldAfterPublish)).rejects.toHaveProperty("code", "ENOENT");
      await holder!.stop();
      holder = undefined;
      await browser.keys("Escape");
      await reload();
      await waitStatus("ready");
      await expect(stat(oldBusy)).rejects.toHaveProperty("code", "ENOENT");
      expect(JSON.parse(await readFile(recordPath, "utf8")).installedAt).toBe(record.installedAt);

      // 外部文件系统夹具重放“记录已撤销、进程退出前未删完”的持久边界。
      await browser.keys("Escape");
      await reload(async () => {
        await rm(recordPath);
        holder = await nativeHolder(join(record.installationDir, "bin"));
      });
      await waitStatus("not-installed");
      await expect(stat(recordPath)).rejects.toHaveProperty("code", "ENOENT");
      expect((await stat(record.installationDir)).isDirectory()).toBe(true);
      const beforeRetry = (await (await fetch(`${fixtureUrl()}/status`)).json()) as {
        requests: number;
      };
      await $('[data-testid="preinstalled-tools-download"]').click();
      await waitStatus("failed");
      expect(
        ((await (await fetch(`${fixtureUrl()}/status`)).json()) as { requests: number }).requests,
      ).toBe(beforeRetry.requests + 1);
      await holder!.stop();
      holder = undefined;
      await $('[data-testid="preinstalled-tools-retry"]').click();
      await waitStatus("ready");
      record = JSON.parse(await readFile(recordPath, "utf8"));
      await browser.keys("Escape");

      await openResourceManager();
      await switchToElectronRendererTarget(isResourceManagerUrl);
      await waitForResourceManagerReady();
      await activateResourceManagerTab("storage");
      await browser.waitUntil(
        async () =>
          (await $(`[data-testid="${TID_RESOURCE_MANAGER_STORAGE_STATUS}"]`).getAttribute(
            "data-state",
          )) === "complete",
        { timeout: 60000 },
      );
      expect(
        await $(
          `[data-testid="${testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW, "preinstalledTools")}"]`,
        ).isDisplayed(),
      ).toBe(true);
      expect(
        await $(
          `[data-testid="${testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN, "preinstalledTools")}"]`,
        ).isExisting(),
      ).toBe(false);
      const storage = await browser.execute(async () => {
        const bridge = (
          window as typeof window & {
            resourceManager: {
              storage: {
                getSnapshot(): Promise<{ roots: Array<{ id: string; path: string }> }>;
                clean(request: { rootId: string; categoryId: string }): Promise<unknown>;
              };
            };
          }
        ).resourceManager.storage;
        const snapshot = await bridge.getSnapshot();
        let error = "";
        try {
          await bridge.clean({ rootId: "home", categoryId: "preinstalledTools" });
        } catch (caught) {
          error = String(caught);
        }
        return { snapshot, blockedMessage: error };
      });
      expect(
        storage.snapshot.roots.some((item) => resolve(item.path) === resolve(storageRoot)),
      ).toBe(true);
      expect(storage.blockedMessage).toContain("not cleanable");
      await screenshot("storage");
      await browser.electron.execute((electron) => {
        for (const window of electron.BrowserWindow.getAllWindows())
          if (window.webContents.getURL().includes("resource-manager.html")) window.close();
      });
      await switchToElectronRendererTarget(isMainRendererUrl);

      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "lop-delete-facts.json"),
        JSON.stringify(
          {
            release,
            recordPath,
            installedAt: record.installedAt,
            oldVersionsCleaned: true,
            workerRestartKeptOld: true,
          },
          null,
          2,
        ),
      );
    } finally {
      if (restorePermissions) await chmod(restorePermissions, 0o755);
      await holder?.stop();
      // 本用例的原生确认替代会自行恢复，避免退出后访问旧 CDP 掩盖原始错误。
    }
  });
});
