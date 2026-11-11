import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZCodePluginInfo } from "@zcode/shared";
import { clearAppData, getE2EAppDataPaths, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import {
  addMarketplaceSourceThroughAgent,
  getPluginList,
  getPluginOverview,
  installMarketplacePluginThroughAgent,
  requirePluginManualReview,
  updateMarketplaceThroughAgent,
} from "#e2e/helpers/plugin-management-lifecycle";

const CLAUDE_MARKETPLACE_ID = "claude-plugins-official";
const CLAUDE_HTTP_PLUGIN_NAME = "aikido";
const CLAUDE_HTTP_PLUGIN_ID = `${CLAUDE_HTTP_PLUGIN_NAME}@${CLAUDE_MARKETPLACE_ID}`;
const NON_GITHUB_GIT_PROBE = "https://gitlab.example.invalid/e2e/no-git-plugin.git";
const REAL_HTTP_INSTALL_TIMEOUT_MS = 600_000;

describe("PLM-LC-011 Desktop real Claude plugin HTTP install without Git", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Git 不可用时通过 GitHub Archive 刷新 Claude Marketplace 并安装真实插件", async function () {
    this.timeout(REAL_HTTP_INSTALL_TIMEOUT_MS);
    requirePluginManualReview();
    // WebDriver 的 executeAsync 默认 30 秒；真实公网下载由 Agent 完成，Renderer bridge 只是在
    // 等 RPC 结果，测试门限必须覆盖生产 HTTP 客户端的 180 秒单请求上限。
    await browser.setTimeout({ script: REAL_HTTP_INSTALL_TIMEOUT_MS });

    // 全局空草稿不挂载 workspace App，旧测试 action 因此不存在；先进入项目草稿。
    await waitForWorkspaceApp(getE2EAppDataPaths().workspace, 45000);
    await startDraftFromProject(getE2EAppDataPaths().workspace);
    const gitBinary = await browser.electron.execute(() => process.env.ZCODE_GIT_BINARY ?? "");
    expect(gitBinary).toContain("missing-bin");
    expect(existsSync(gitBinary)).toBe(false);

    // 先走一次必须依赖 Git 的非 GitHub 来源：只有 Agent 真正拿到 missing binary，才会返回
    // plugin_git_unavailable。这样后续成功不能被开发机上已安装的 Git 误判成 Archive 成功。
    let probeFailure = "";
    try {
      await addMarketplaceSourceThroughAgent(NON_GITHUB_GIT_PROBE);
    } catch (error) {
      // mutation 的 error diagnostic 会被 RPC 边界提升为异常；这里验证用户真正看到的
      // 可执行提示，同时证明后续 Archive 成功不是偷偷使用了开发机上的 Git。
      probeFailure = error instanceof Error ? error.message : String(error);
    }
    expect(probeFailure).toContain("git is unavailable on this Agent Host");

    // 走 Renderer test bridge -> Host -> Agent Protocol 的真实服务链路。公网 archive 在抓包
    // 代理下可能耗时数分钟，因此不叠加 278 张商店卡片和第三方图标的渲染噪声。
    const refresh = await updateMarketplaceThroughAgent(CLAUDE_MARKETPLACE_ID);
    expect(refresh.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "error" })]),
    );

    const before = await getPluginOverview();
    expect(before.marketplaces.find((item) => item.id === CLAUDE_MARKETPLACE_ID)).toMatchObject({
      id: CLAUDE_MARKETPLACE_ID,
    });
    expect(
      before.availablePlugins.find((plugin) => plugin.id === CLAUDE_HTTP_PLUGIN_ID),
    ).toMatchObject({
      installed: false,
      marketplace: CLAUDE_MARKETPLACE_ID,
      name: CLAUDE_HTTP_PLUGIN_NAME,
    });

    const install = await installMarketplacePluginThroughAgent(
      CLAUDE_HTTP_PLUGIN_NAME,
      CLAUDE_MARKETPLACE_ID,
    );
    expect(install.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "error" })]),
    );
    expect(install.installedPlugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: CLAUDE_HTTP_PLUGIN_ID })]),
    );

    const pluginStorageRoot = join(getE2EAppDataPaths().storageRoot, "cli", "plugins");
    const installed = readInstalledRecord(pluginStorageRoot);
    expect(installed.source).toMatchObject({
      source: "url",
      url: "https://github.com/AikidoSec/aikido-claude-plugin.git",
    });
    expect(installed.source?.sha ?? "").toMatch(/^[a-f0-9]{40}$/u);
    expect(existsSync(join(installed.installPath, ".claude-plugin", "plugin.json"))).toBe(true);

    const marketplaceRoot = join(pluginStorageRoot, "marketplaces", CLAUDE_MARKETPLACE_ID);
    // `git clone` 会携带 `.git`；GitHub Archive 不会。两个缓存都无 `.git` 是进程外证据。
    expect(existsSync(join(marketplaceRoot, ".git"))).toBe(false);
    expect(existsSync(join(installed.installPath, ".git"))).toBe(false);

    const plugin = (await getPluginList()).plugins.find(
      (item) => item.id === CLAUDE_HTTP_PLUGIN_ID,
    );
    expect(plugin).toMatchObject({
      enabled: true,
      rootPath: installed.installPath,
      version: installed.version,
    });
    expect(componentNames(plugin, "mcp")).not.toHaveLength(0);
  });
});

function readInstalledRecord(pluginStorageRoot: string): {
  installPath: string;
  source?: { sha?: string; source?: string; url?: string };
  version: string;
} {
  const state = JSON.parse(
    readFileSync(join(pluginStorageRoot, "installed_plugins.json"), "utf-8"),
  ) as {
    plugins?: Array<{
      id?: string;
      installPath?: string;
      source?: { sha?: string; source?: string; url?: string };
      version?: string;
    }>;
  };
  const record = state.plugins?.find((plugin) => plugin.id === CLAUDE_HTTP_PLUGIN_ID);
  if (!record?.installPath || !record.version) {
    throw new Error(`Installed record missing for ${CLAUDE_HTTP_PLUGIN_ID}`);
  }
  return {
    installPath: record.installPath,
    ...(record.source ? { source: record.source } : {}),
    version: record.version,
  };
}

function componentNames(plugin: ZCodePluginInfo | undefined, kind: "mcp"): string[] {
  return (
    plugin?.components?.find((group) => group.kind === kind)?.items.map((item) => item.name) ?? []
  );
}
