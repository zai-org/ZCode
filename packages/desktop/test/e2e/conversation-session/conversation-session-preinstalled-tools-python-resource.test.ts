import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { setPluginPresentation } from "#e2e/helpers/plugin-management-lifecycle";

const exec = promisify(execFile);

describe("Python 真实预装资源（待审核）", () => {
  it("PY-08: 删除确认说明附加区，并随版本一起删除", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E();
    await $('[data-testid="workspace-help-menu-trigger"]').click();
    await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
    await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed();
    const card = $('[data-testid="preinstalled-tools-card"][data-tool-id="python"]');
    await card.waitForDisplayed();
    await fetch(`${process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL}/release`);
    await browser.waitUntil(
      async () =>
        (await card.$('[data-testid="preinstalled-tools-status"]').getAttribute("data-status")) ===
        "ready",
      { timeout: 180000 },
    );
    const roots = join(resolveE2EStorageRoot(), "preinstalled-tools");
    const release = join(roots, (await readdir(roots))[0]!);
    const record = JSON.parse(
      await readFile(join(release, "tools/python/installation.json"), "utf8"),
    );
    const result = await exec(
      join(release, "bin/zcode-python"),
      ["-c", "import sys; print(sys.prefix)"],
      { timeout: 30000 },
    );
    expect(result.stdout.trim()).toBe(join(record.installationDir, "overlay"));
    const additionalPackage = join(
      record.installationDir,
      "overlay/lib/python3.12/site-packages/zcode_delete_probe",
    );
    await mkdir(additionalPackage, { recursive: true });
    await writeFile(join(additionalPackage, "__init__.py"), "VALUE = 'delete-probe'\n");
    const imported = await exec(
      join(release, "bin/zcode-python"),
      ["-c", "import zcode_delete_probe; print(zcode_delete_probe.VALUE)"],
      { timeout: 30000 },
    );
    expect(imported.stdout.trim()).toBe("delete-probe");
    for (const locale of ["zh-CN", "en-US"] as const) {
      for (const theme of ["zai-dark", "zai-light"] as const) {
        await setPluginPresentation({ locale, theme, width: 760, height: 640 });
        await card.$('[data-testid="preinstalled-tools-delete"]').click();
        const confirmation = $('[data-testid="preinstalled-tools-delete-confirm"]');
        await confirmation.waitForDisplayed();
        expect(await confirmation.getText()).toContain(
          locale === "zh-CN"
            ? "Agent 额外安装的 Python 包也会删除。"
            : "Python packages added by the Agent will also be deleted.",
        );
        await browser.saveScreenshot(
          `${process.env.ZCODE_E2E_ARTIFACT_DIR}/python-delete-${locale}-${theme}.png`,
        );
        await $('[data-testid="preinstalled-tools-delete-confirm-cancel"]').click();
      }
    }
    await card.$('[data-testid="preinstalled-tools-delete"]').click();
    await $('[data-testid="preinstalled-tools-delete-confirm-accept"]').click();
    await browser.waitUntil(
      async () =>
        (await card.$('[data-testid="preinstalled-tools-status"]').getAttribute("data-status")) ===
        "not-installed",
      { timeout: 30000 },
    );
    // owner 先删除记录并发布未安装，再回收大目录；控件恢复可用才表示删除命令已回执。
    await card.$('[data-testid="preinstalled-tools-download"]').waitForEnabled({ timeout: 30000 });
    await expect(stat(additionalPackage)).rejects.toHaveProperty("code", "ENOENT");
    await expect(stat(record.installationDir)).rejects.toHaveProperty("code", "ENOENT");
    await expect(stat(join(release, "bin/zcode-python"))).rejects.toHaveProperty("code", "ENOENT");
  });
});
