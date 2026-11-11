import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { addZCodePluginMarketplace } from "../src/plugins.js";

const execFileAsync = promisify(execFile);

function addViaFacade(source: string, storageRoot: string, workingDirectory: string) {
  return addZCodePluginMarketplace({
    source,
    pluginStorageRoot: storageRoot,
    workingDirectory,
    skipUserConfig: true,
  });
}

async function githubReachable(repoHttps: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-remote", "--heads", repoHttps], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

// 真实外网导入已多次定向复跑失败；拆分后闭源保留，开源只排除网络用例。
describe("marketplace 自定义导入 E2E (真实 agent facade)", () => {
  it("GitHub 导入：raw git URL -> git 来源 -> 真实 clone -> 落盘", async () => {
    // 选体积小且仓库根带 .claude-plugin/marketplace.json 的公开仓库，避免大仓库 clone 超时。
    const repoUrl = "https://github.com/wshobson/agents.git";
    if (!(await githubReachable(repoUrl))) {
      console.warn("[e2e] GitHub 不可达，跳过 git URL clone 用例");
      return;
    }
    const base = await mkdtemp(join(tmpdir(), "zcode-e2e-github-"));
    const storageRoot = join(base, "storage");
    try {
      // https .git -> parseMarketplaceSourceInput 归类 source:"git" -> 真实 clone --depth 1。
      const summary = await addViaFacade(repoUrl, storageRoot, base);
      // manifest.name 即市场 id（该仓库 manifest 名为 claude-code-workflows）。
      expect(summary.id).toBe("claude-code-workflows");
      expect(summary.pluginCount).toBeGreaterThan(0);

      const known = JSON.parse(
        await readFile(join(storageRoot, "known_marketplaces.json"), "utf8"),
      ) as {
        marketplaces: Array<{ id: string; source: { source: string; url?: string } }>;
      };
      const rec = known.marketplaces.find((m) => m.id === summary.id);
      expect(rec?.source.source).toBe("git");
      expect(rec?.source.url).toBe(repoUrl);

      // clone 出的 manifest 复制进 storage。
      const manifestCopy = join(storageRoot, "marketplaces", summary.id, "marketplace.json");
      expect(existsSync(manifestCopy)).toBe(true);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  }, 120_000);

  it("GitHub 简写导入：raw owner/repo -> github 来源 -> 真实 clone -> 落盘", async () => {
    const repo = "wshobson/agents";
    if (!(await githubReachable(`https://github.com/${repo}.git`))) {
      console.warn("[e2e] GitHub 不可达，跳过 owner/repo 简写用例");
      return;
    }
    const base = await mkdtemp(join(tmpdir(), "zcode-e2e-gh-short-"));
    const storageRoot = join(base, "storage");
    try {
      // owner/repo 简写 -> parseMarketplaceSourceInput 归类 source:"github"。
      const summary = await addViaFacade(repo, storageRoot, base);
      expect(summary.id).toBe("claude-code-workflows");

      const known = JSON.parse(
        await readFile(join(storageRoot, "known_marketplaces.json"), "utf8"),
      ) as {
        marketplaces: Array<{ id: string; source: { source: string; repo?: string } }>;
      };
      const rec = known.marketplaces.find((m) => m.id === summary.id);
      expect(rec?.source.source).toBe("github");
      expect(rec?.source.repo).toBe(repo);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  }, 120_000);
});
