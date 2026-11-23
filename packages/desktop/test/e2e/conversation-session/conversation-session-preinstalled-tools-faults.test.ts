import { pinE2ELocale } from "#e2e/helpers/desktop-app";
import {
  PREINSTALLED_FIXTURE_PROGRAM,
  preinstalledFixtureRecordPath,
  readPreinstalledEntryDefinition,
} from "#e2e/helpers/preinstalled-tools-fixture";
import { readFile, readdir, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

interface FixtureStatus {
  requests: Array<{ id: number; resource: string; mode: string; range: string | null }>;
  pending: number[];
  runtimeChecks: number;
}
const fixtureUrl = () => process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL!;
const status = async () => (await (await fetch(`${fixtureUrl()}/status`)).json()) as FixtureStatus;
async function openDialog() {
  await $('[data-testid="workspace-help-menu-trigger"]').click();
  await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
  await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed();
}
async function waitStatus(value: string) {
  await browser.waitUntil(
    async () =>
      (await $(
        '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]',
      ).getAttribute("data-status")) === value,
    { timeout: 30000, timeoutMsg: `预装状态未达到 ${value}` },
  );
}
async function terminalStatus() {
  await browser.waitUntil(
    async () =>
      ["ready", "failed"].includes(
        (await $(
          '[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]',
        ).getAttribute("data-status")) ?? "",
      ),
    { timeout: 30000 },
  );
  return $('[data-tool-id="libreoffice"] [data-testid="preinstalled-tools-status"]').getAttribute(
    "data-status",
  );
}
async function restart(scenario: string, afterExit?: () => Promise<void>) {
  await reloadElectronSessionPreservingBrowserProfile(browser, {
    afterElectronProcessExit: async () => {
      const response = await fetch(`${fixtureUrl()}/scenario/${scenario}`);
      expect(response.ok).toBe(true);
      await afterExit?.();
    },
  });
  await prepareV4ConversationE2E();
  // 宿主可能使用英文，环境变量不能保证 macOS 界面语言；固定语言后再核对中文文案。
  await pinE2ELocale("zh-CN");
  await openDialog();
}
async function screenshot(name: string) {
  await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/lop-fault-${name}.png`);
}
// 代理与私有 CA 需要只能经代理访问的基址，见 conversation-session-preinstalled-tools-proxy。
describe("预装工具下载故障与网络策略（待审核）", () => {
  it("LOP-08/11/12/13: 故障不发布，重启不续传，主备候选按基址顺序回退", async function () {
    this.timeout(900000);
    await prepareV4ConversationE2E();
    await pinE2ELocale("zh-CN");
    await openDialog();
    expect(await terminalStatus()).toBe("failed");
    expect(await $('[data-testid="preinstalled-tools-dialog"]').getText()).toContain(
      "磁盘空间不足",
    );
    const spaceManifest = JSON.parse(
      await readFile(process.env.ZCODE_E2E_PREINSTALLED_TOOLS_CATALOG!, "utf8"),
    )[0].resources[0] as { archive: { sizeBytes: number }; installedSizeBytes: number };
    const requiredSpace = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(
      (spaceManifest.archive.sizeBytes + spaceManifest.installedSizeBytes) / 1024 ** 3,
    );
    expect(await $('[data-testid="preinstalled-tools-dialog"]').getText()).toContain(
      `需要约 ${requiredSpace} GB 可用空间`,
    );
    expect((await status()).requests).toEqual([]);
    expect((await status()).runtimeChecks).toBe(0);
    await screenshot("disk-space");
    const roots = join(resolveE2EStorageRoot(), "preinstalled-tools");
    const root = join(roots, (await readdir(roots))[0]!);
    await restart("unsupported");
    await waitStatus("not-installed");
    expect(await $('[data-testid="preinstalled-tools-dialog"]').getText()).toContain(
      "当前版本暂未提供此工具",
    );
    expect((await status()).requests).toEqual([]);
    await screenshot("unsupported");
    await restart("ready");
    await waitStatus("ready");
    const originalRecordPath = await preinstalledFixtureRecordPath(root);
    const original = JSON.parse(await readFile(originalRecordPath, "utf8"));
    const originalExecutable = await readFile(
      join(original.installationDir, PREINSTALLED_FIXTURE_PROGRAM),
    );
    for (const [scenario, message] of [
      ["network", "无法连接下载服务器"],
      ["interrupted", "下载中断"],
      ["checksum", "下载的文件已损坏"],
      ["truncated", "下载的文件已损坏"],
      ["oversize", "下载的文件已损坏"],
      ["extract", "解压失败"],
      ["missing", "下载的文件已损坏"],
      ["unsafe-link", "解压失败"],
      ["runtime", "工具无法在这台电脑上运行"],
      ["checksum-then-network", "下载的文件已损坏"],
    ] as const) {
      const before = await status();
      await restart(scenario);
      if (scenario === "interrupted") {
        await waitStatus("preparing");
        await browser.waitUntil(async () => (await status()).pending.length > 0, {
          timeout: 10000,
        });
        const pending = (await status()).pending.at(-1)!;
        await fetch(`${fixtureUrl()}/break/${pending}`);
      }
      expect(await terminalStatus()).toBe("failed");
      expect(await $('[data-testid="preinstalled-tools-dialog"]').getText()).toContain(message);
      await $('[data-testid="preinstalled-tools-retry"]').waitForDisplayed();
      // 固定发布点仍保留旧完整记录；失败不能发布本次资源或撤销旧入口。
      expect(JSON.parse(await readFile(originalRecordPath, "utf8"))).toEqual(original);
      expect(await readPreinstalledEntryDefinition(join(root, "bin"), "zcode-soffice")).toContain(
        original.installationDir,
      );
      expect(await readdir(join(root, "tools", "libreoffice", "staging"))).toEqual([]);
      expect(await readFile(join(original.installationDir, PREINSTALLED_FIXTURE_PROGRAM))).toEqual(
        originalExecutable,
      );
      expect((await status()).runtimeChecks - before.runtimeChecks).toBe(
        scenario === "runtime" ? 1 : 0,
      );
      expect(await $$("[data-sonner-toast]").length).toBe(0);
      await screenshot(scenario);
    }
    const fallbackBefore = (await status()).requests.length;
    await restart("fallback");
    await waitStatus("ready");
    expect((await status()).requests.slice(fallbackBefore).map((item) => item.mode)).toEqual([
      "http-error",
      "complete",
    ]);
    await screenshot("fallback-ready");
    await restart("slow");
    await waitStatus("preparing");
    await browser.waitUntil(async () => (await status()).pending.length > 0, { timeout: 10000 });
    const firstSlow = (await status()).requests.length;
    const orphan = join(root, "tools", "libreoffice", "staging", "interrupted-before-start");
    await restart("slow", async () => {
      await mkdir(orphan, { recursive: true });
      await writeFile(join(orphan, "partial.tar.gz"), "unfinished");
      await writeFile(join(root, "tools", "libreoffice", "staging", "loose.partial"), "unfinished");
    });
    await waitStatus("preparing");
    await browser.waitUntil(async () => (await status()).requests.length === firstSlow + 1, {
      timeout: 10000,
    });
    await expect(stat(orphan)).rejects.toHaveProperty("code", "ENOENT");
    expect((await status()).requests.at(-1)?.range).toBeNull();
    await $('[data-testid="preinstalled-tools-auto-install"]').click();
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="preinstalled-tools-auto-install"]').getAttribute(
          "aria-checked",
        )) === "false",
      { timeout: 10000 },
    );
    const beforeOffRestart = (await status()).requests.length;
    await restart("slow");
    await waitStatus("not-installed");
    expect((await status()).requests.length).toBe(beforeOffRestart);
    expect(await readdir(join(root, "tools", "libreoffice", "staging"))).toEqual([]);
    // fallback 已装上旧资源，目标换成 slow 后卡片显示“可更新”，按钮是“更新”而不是“下载”。
    await $('[data-testid="preinstalled-tools-update"]').click();
    await waitStatus("preparing");
    await browser.waitUntil(async () => (await status()).pending.length > 0, { timeout: 10000 });
    const slowId = (await status()).pending.at(-1)!;
    const progress = $('[data-testid="preinstalled-tools-dialog"] [role="progressbar"]');
    await browser.waitUntil(async () => Number(await progress.getAttribute("aria-valuenow")) > 0, {
      timeout: 10000,
    });
    const firstProgress = Number(await progress.getAttribute("aria-valuenow"));
    await fetch(`${fixtureUrl()}/step/${slowId}`);
    await browser.waitUntil(
      async () => Number(await progress.getAttribute("aria-valuenow")) > firstProgress,
      { timeout: 10000 },
    );
    await screenshot("slow-progress");
    await $('[data-testid="preinstalled-tools-cancel"]').click();
    await waitStatus("not-installed");
  });
});
