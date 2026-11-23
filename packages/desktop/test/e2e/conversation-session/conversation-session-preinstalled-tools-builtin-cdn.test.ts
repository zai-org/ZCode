import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { IPlatformService } from "@zcode/shared";
import {
  preinstalledToolInstallationSchema,
  preinstalledToolsCatalogSchema,
  type PreinstalledToolState,
} from "@zcode/shared/preinstalled-tools";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { preinstalledEntryPath } from "#e2e/helpers/preinstalled-tools-fixture";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

const exec = promisify(execFile);
const state = () =>
  browser.execute(() => {
    const api = (window as Window & { zcode?: IPlatformService }).zcode;
    if (!api?.getPreinstalledToolsState) throw new Error("预装工具 API 未就绪");
    return api.getPreinstalledToolsState();
  });

describe("内置预装资源真实 CDN（待审核）", () => {
  it("按平台从默认 CDN 安装，并通过公开入口运行资源检查", async function () {
    // 真实 CDN 的五个大包在低带宽链路上可能需要数十分钟；失败状态仍立即结束等待。
    this.timeout(3600000);
    await prepareV4ConversationE2E();
    expect(
      await browser.electron.execute(() => ({
        catalog: process.env.ZCODE_E2E_PREINSTALLED_TOOLS_CATALOG ?? null,
        baseUrl: process.env.ZCODE_PREINSTALLED_TOOLS_CDN_BASE_URL ?? null,
      })),
    ).toEqual({ catalog: null, baseUrl: null });
    // 转正移除两级候选目录后，仍读取桌面构建的同一份资源清单。
    const catalog = preinstalledToolsCatalogSchema.parse(
      JSON.parse(
        await readFile(
          new URL("../../../src/preinstalled-tools/catalog.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    const resources = catalog.flatMap((tool) =>
      tool.resources.filter((resource) =>
        resource.platforms.some(
          (target) => target.platform === process.platform && target.arch === process.arch,
        ),
      ),
    );
    expect(resources.length).toBeGreaterThan(0);
    await browser.waitUntil(async () => (await state()).tools.length === 5, {
      timeoutMsg: "内置预装清单未完成初始化",
    });
    const initial = await state();
    expect(initial.autoInstallEnabled).toBe(true);
    expect(initial.tools.map((tool) => tool.toolId)).toEqual([
      "python",
      "qpdf",
      "pandoc",
      "poppler",
      "libreoffice",
    ]);
    for (const tool of initial.tools) {
      const resource = resources.find((item) => item.toolId === tool.toolId);
      expect(tool.target?.resourceId ?? null).toBe(resource?.resourceId ?? null);
    }
    await sendV4Prompt(
      "E2E_PREINSTALLED_BUILTIN_CHAT: Reply with E2E_PREINSTALLED_BUILTIN_CHAT_DONE.",
    );
    await waitForV4AssistantMessageContaining("E2E_PREINSTALLED_BUILTIN_CHAT_DONE", 90000);
    await $('[data-testid="workspace-help-menu-trigger"]').click();
    await $('[data-testid="workspace-help-menu-preinstalled-tools"]').click();
    await $('[data-testid="preinstalled-tools-dialog"]').waitForDisplayed();
    const recoveries: PreinstalledToolState[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let failed: PreinstalledToolState | undefined;
      await browser.waitUntil(
        async () => {
          const snapshot = await state();
          failed = snapshot.tools.find((tool) => tool.status === "failed");
          return (
            Boolean(failed) ||
            resources.every((resource) =>
              snapshot.tools.some(
                (tool) => tool.toolId === resource.toolId && tool.status === "ready",
              ),
            )
          );
        },
        { timeout: 3300000, interval: 2000, timeoutMsg: "真实 CDN 资源未全部就绪" },
      );
      if (!failed) break;
      // 真实网络可能断连；仅允许一次明确的用户重试，不掩盖摘要、解压或运行检查错误。
      if (attempt !== 0 || !["network", "interrupted"].includes(failed.error ?? ""))
        throw new Error(`真实 CDN 安装失败: ${JSON.stringify(failed)}`);
      recoveries.push(failed);
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "builtin-cdn-network-recovery.json"),
        JSON.stringify(recoveries, null, 2),
      );
      await $(`[data-tool-id="${failed.toolId}"] [data-testid="preinstalled-tools-retry"]`).click();
    }
    const roots = join(resolveE2EStorageRoot(), "preinstalled-tools");
    const releases = await readdir(roots);
    expect(releases).toHaveLength(1);
    const root = join(roots, releases[0]!);
    const checks: Array<{ toolId: string; entry: string; output: string }> = [];
    for (const resource of resources) {
      const record = preinstalledToolInstallationSchema.parse(
        JSON.parse(
          await readFile(join(root, "tools", resource.toolId, "installation.json"), "utf8"),
        ),
      );
      expect(record.resourceId).toBe(resource.resourceId);
      expect(record.entries).toEqual(resource.entries);
      const temporary = await mkdtemp(join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "builtin-entry-"));
      const substitutions: Record<string, string> = {
        INSTALL_DIR: record.installationDir,
        CHECK_TEMP_DIR: temporary,
        CHECK_TEMP_URL: pathToFileURL(temporary).href,
      };
      for (const check of resource.runtimeChecks) {
        const args = check.args.map((value) =>
          value.replace(
            /\$\{([^}]+)\}/g,
            (placeholder, name: string) => substitutions[name] ?? placeholder,
          ),
        );
        const result = await exec(preinstalledEntryPath(join(root, "bin"), check.entry), args, {
          timeout: check.timeoutMs,
          windowsHide: true,
        });
        const output = result.stdout + result.stderr;
        expect(output).toContain(check.expectedOutput);
        checks.push({ toolId: resource.toolId, entry: check.entry, output });
      }
    }
    await browser.saveScreenshot(`${process.env.ZCODE_E2E_ARTIFACT_DIR}/builtin-cdn-ready.png`);
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "builtin-cdn-facts.json"),
      JSON.stringify({ initial, final: await state(), checks, recoveries }, null, 2),
    );
  });
});
