import { preinstalledFixtureRecordPath } from "#e2e/helpers/preinstalled-tools-fixture";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PreinstalledToolsState } from "@zcode/shared/preinstalled-tools";
import { resolveE2EHomeDir, resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { reloadE2EElectronServiceBridge } from "#e2e/helpers/e2e-electron-service-lifecycle";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

async function processState(pid: number) {
  if (process.platform === "win32") {
    // Windows 没有 ps 和僵尸进程；信号 0 只探测进程是否存在，退出后报 ESRCH。
    try {
      process.kill(pid, 0);
      return "running";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "";
      throw error;
    }
  }
  try {
    return (await promisify(execFile)("ps", ["-p", String(pid), "-o", "stat="])).stdout.trim();
  } catch (error) {
    if ((error as { code?: number }).code === 1) return "";
    throw error;
  }
}

describe("预装工具清除数据边界（待审核）", () => {
  it("LOP-28: 真实清除隔离 v2、退出写入方并冷启动复用资源", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();
    const fixture = process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL!;
    await fetch(`${fixture}/release`);
    await fetch(`${fixture}/finish-check`);
    await browser.waitUntil(
      async () =>
        (
          await browser.execute(async () =>
            (
              window as typeof window & {
                zcode: { getPreinstalledToolsState(): Promise<PreinstalledToolsState> };
              }
            ).zcode.getPreinstalledToolsState(),
          )
        ).tools.find((tool) => tool.toolId === "libreoffice")?.status === "ready",
      { timeout: 30000 },
    );
    const storageRoot = resolveE2EStorageRoot();
    const roots = join(storageRoot, "preinstalled-tools");
    const recordPath = await preinstalledFixtureRecordPath(join(roots, (await readdir(roots))[0]!));
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const environment = await browser.electron.execute(() => ({
      home: process.env.ZCODE_DESKTOP_HOME_DIR,
      base: process.env.ZCODE_DATA_BASE_DIR,
    }));
    expect(resolve(environment.home!)).toBe(resolve(resolveE2EHomeDir()));
    if (environment.base) expect(resolve(environment.base)).toBe(resolve(resolveE2EHomeDir()));
    expect(storageRoot).toBe(join(resolveE2EHomeDir(), ".zcode"));
    const sentinel = join(storageRoot, "v2", "lop-clear-canary.txt");
    await writeFile(sentinel, "must-be-cleared");
    const identities = await browser.electron.execute((electron) => {
      const confirm = electron.dialog.showMessageBox;
      electron.dialog.showMessageBox = (async () => {
        electron.dialog.showMessageBox = confirm;
        return { response: 1, checkboxChecked: false };
      }) as typeof confirm;
      const relaunch = electron.app.relaunch;
      electron.app.relaunch = () => {
        electron.app.relaunch = relaunch;
      };
      // 测试的 Main inspector 会持有退出连接；先释放调试器，再调用真实退出，不模拟产品结果。
      const exit = electron.app.exit.bind(electron.app);
      electron.app.exit = (code) => {
        process.getBuiltinModule("inspector").close();
        exit(code);
      };
      return {
        mainPid: process.pid,
        browserPid: electron.app.getAppMetrics().find((item) => item.type === "Browser")?.pid,
        workerPid: electron.app
          .getAppMetrics()
          .find((item) => item.name === "zcode-preinstalled-tools")?.pid,
      };
    });
    expect(identities.mainPid).toBe(identities.browserPid);
    expect(identities.workerPid).toBeDefined();
    console.log("LOP_CLEAR_IDENTITIES", JSON.stringify(identities));
    await browser.execute(() => {
      void (
        window as typeof window & {
          zcode: { executeDesktopCommand(command: string): Promise<void> };
        }
      ).zcode.executeDesktopCommand("clearAllData");
    });
    let exitState = "";
    await browser.waitUntil(
      async () => {
        exitState = await processState(identities.mainPid);
        return exitState === "" || exitState.startsWith("Z");
      },
      { timeout: 20000 },
    );
    await expect(stat(sentinel)).rejects.toHaveProperty("code", "ENOENT");
    expect(JSON.parse(await readFile(recordPath, "utf8")).installedAt).toBe(record.installedAt);
    const workerState = await processState(identities.workerPid!);
    expect(workerState === "" || workerState.startsWith("Z")).toBe(true);
    await browser.reloadSession();
    await reloadE2EElectronServiceBridge(browser);
    const restored = await browser.execute(async () =>
      (
        window as typeof window & {
          zcode: { getPreinstalledToolsState(): Promise<PreinstalledToolsState> };
        }
      ).zcode.getPreinstalledToolsState(),
    );
    expect(restored.tools.find((tool) => tool.toolId === "libreoffice")?.status).toBe("ready");
    expect(restored.tools.find((tool) => tool.toolId === "libreoffice")?.installed).toMatchObject({
      resourceId: record.resourceId,
      version: record.version,
      installedSizeBytes: record.installedSizeBytes,
    });
    expect(JSON.parse(await readFile(recordPath, "utf8")).installedAt).toBe(record.installedAt);
    const status = (await (await fetch(`${fixture}/status`)).json()) as {
      requests: number;
      runtimeChecks: number;
    };
    expect(status.requests).toBe(1);
    expect(status.runtimeChecks).toBe(1);
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "lop-clear-facts.json"),
      JSON.stringify(
        {
          ...identities,
          exitState,
          workerState,
          recordPath,
          installedAt: record.installedAt,
          restored,
          status,
        },
        null,
        2,
      ),
    );
  });
});
