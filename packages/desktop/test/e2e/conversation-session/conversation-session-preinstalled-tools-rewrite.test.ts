import { pinE2ELocale } from "#e2e/helpers/desktop-app";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { promisify } from "node:util";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";

const exec = promisify(execFile);
const fixtureUrl = () => process.env.ZCODE_E2E_PREINSTALL_FIXTURE_URL!;
async function openDialog() {
  // macOS 首帧跟随宿主语言；路径改写的错误文案按中文合同验证。
  await pinE2ELocale("zh-CN");
  await $('[data-testid="workspace-help-menu-trigger"]').click();
  await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
  await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed();
}
async function waitStatus(status: string) {
  await browser.waitUntil(
    async () =>
      (await $('[data-tool-id="qpdf"] [data-testid="preinstalled-tools-status"]').getAttribute(
        "data-status",
      )) === status,
    { timeout: 60000 },
  );
}
async function restart(scenario: string) {
  await reloadElectronSessionPreservingBrowserProfile(browser, {
    afterElectronProcessExit: async () => {
      expect((await fetch(`${fixtureUrl()}/scenario/${scenario}`)).ok).toBe(true);
    },
  });
  await prepareV4ConversationE2E();
  await openDialog();
}
async function waitForRewrite(tool: string, scenario: string): Promise<string> {
  const finalDirectory = join(tool, "versions", `rewrite-${scenario}-${process.arch}`);
  let payload: string | undefined;
  await browser.waitUntil(
    async () => {
      for (const operation of await readdir(join(tool, "staging"))) {
        const directory = join(tool, "staging", operation, "payload");
        try {
          if ((await readFile(join(directory, "data/value.txt"), "utf8")) === finalDirectory) {
            payload = directory;
            return true;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return false;
    },
    { timeout: 30000, interval: 10, timeoutMsg: "未观察到改写开始" },
  );
  return payload!;
}

describe("预装工具安装路径改写（待审核）", () => {
  it("PT-REWRITE: 文本与Mach-O可重定位，超长、失败和中途取消不发布", async function () {
    this.timeout(600000);
    expect(process.platform).toBe("darwin");
    expect(resolveE2EStorageRoot()).toContain("中文 空格");
    await prepareV4ConversationE2E();
    await openDialog();
    await waitStatus("ready");
    const roots = join(resolveE2EStorageRoot(), "preinstalled-tools");
    const root = join(roots, (await readdir(roots))[0]!);
    const tool = join(root, "tools", "qpdf");
    const recordPath = join(tool, "installation.json");
    expect((await exec(join(root, "bin", "qpdf"))).stdout.trim()).toBe("plain-ok");
    await restart("success");
    await waitStatus("ready");
    let record = JSON.parse(await readFile(recordPath, "utf8")) as {
      installationDir: string;
      resourceId: string;
    };
    expect(record.resourceId).toBe(`rewrite-success-${process.arch}`);
    expect((await exec(join(root, "bin", "qpdf"))).stdout.trim()).toBe(
      `rewrite-ok:${record.installationDir}`,
    );
    expect(await readFile(join(record.installationDir, "data/value.txt"), "utf8")).toBe(
      record.installationDir,
    );
    const binary = await readFile(join(record.installationDir, "data/binary.bin"));
    const fixture = (await (await fetch(`${fixtureUrl()}/status`)).json()) as {
      binarySize: number;
      directoryPrefixSize: number;
      originalBinarySha256: string;
    };
    expect(binary.length).toBe(fixture.binarySize);
    expect(binary.toString("utf8").split("\0")[0]).toBe(
      `${record.installationDir}/one:${record.installationDir}/二`,
    );
    expect(binary.toString("utf8")).toContain(`tail/${record.installationDir}/tail`);
    await exec("/usr/bin/codesign", [
      "--verify",
      "--strict",
      join(record.installationDir, "bin/probe"),
    ]);
    await exec("/usr/bin/codesign", [
      "--verify",
      "--strict",
      join(record.installationDir, "bin/unchanged"),
    ]);
    expect(
      createHash("sha256")
        .update(await readFile(join(record.installationDir, "bin/unchanged")))
        .digest("hex"),
    ).toBe(fixture.originalBinarySha256);
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/rewrite-ready.png`);
    await restart("dir-prefix");
    await waitStatus("ready");
    record = JSON.parse(await readFile(recordPath, "utf8"));
    expect((await exec(join(root, "bin", "qpdf"))).stdout.trim()).toBe(
      `rewrite-ok:${record.installationDir}`,
    );
    const directoryBytes = await readFile(join(record.installationDir, "data/directory.bin"));
    expect(directoryBytes.length).toBe(fixture.directoryPrefixSize);
    expect(
      directoryBytes
        .toString("utf8")
        .split("\0")
        .map((value) => normalize(value).replace(/\/+$/, "")),
    ).toEqual([
      join(record.installationDir, "one"),
      join(record.installationDir, "two"),
      record.installationDir,
    ]);
    await exec("/usr/bin/codesign", [
      "--verify",
      "--strict",
      join(record.installationDir, "bin/directory-probe"),
    ]);
    for (const [scenario, message] of [
      ["dir-prefix-too-long", "暂不支持当前系统"],
      ["dir-prefix-invalid", "解压失败"],
      ["dir-prefix-binary", "工具无法在这台电脑上运行"],
      ["too-long", "暂不支持当前系统"],
      ["missing", "解压失败"],
      ["signing-failure", "解压失败"],
    ]) {
      await restart(scenario!);
      if (scenario === "signing-failure") {
        await waitStatus("preparing");
        await fetch(`${fixtureUrl()}/release/signing-failure`);
        const payload = await waitForRewrite(tool, scenario);
        // codesign 可以给任意数据文件签名；真实 Mach-O 的 FinderInfo 才会触发可重复的重签失败。
        await exec("/usr/bin/xattr", [
          "-wx",
          "com.apple.FinderInfo",
          "01".repeat(32),
          join(payload, "bin/signing-probe"),
        ]);
      }
      await waitStatus("failed");
      expect(await $('[data-testid="preinstalled-tools-dialog"]').getText()).toContain(message!);
      expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual(record);
      expect((await exec(join(root, "bin", "qpdf"))).stdout.trim()).toBe(
        `rewrite-ok:${record.installationDir}`,
      );
      expect(await readdir(join(tool, "staging"))).toEqual([]);
      expect(await readdir(join(tool, "versions"))).not.toContain(
        `rewrite-${scenario}-${process.arch}`,
      );
      await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/rewrite-${scenario}.png`);
    }
    await restart("cancel");
    const cancel = $('[data-testid="preinstalled-tools-cancel"]');
    await cancel.waitForDisplayed();
    await fetch(`${fixtureUrl()}/release/cancel`);
    await waitForRewrite(tool, "cancel");
    await cancel.click();
    await waitStatus("not-installed");
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual(record);
    expect(await readdir(join(tool, "staging"))).toEqual([]);
    expect(await readdir(join(tool, "versions"))).not.toContain(`rewrite-cancel-${process.arch}`);
    expect((await exec(join(root, "bin", "qpdf"))).stdout.trim()).toBe(
      `rewrite-ok:${record.installationDir}`,
    );
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "rewrite-evidence.json"),
      JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          installationDir: record.installationDir,
          binaryBytes: binary.length,
          directoryPrefixBytes: directoryBytes.length,
          fixedLengthDirectoryProbe: true,
          directoryPrefixFailures: ["too-long", "invalid-later-occurrence", "original-binary"],
          unchangedSignedBinary: true,
          midRewriteCancel: true,
        },
        null,
        2,
      ),
    );
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/rewrite-cancelled.png`);
  });
});
