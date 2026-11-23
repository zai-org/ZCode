import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OFFICIAL_DESIGN_REQUIRED_SEED_PATHS } from "../../../apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.js";
import { REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS } from "../src/remote/zcodeAgentOfficialPluginAssets.js";

// design 的规则文件与脚本是会话里按需读取/执行的，远端缺一份只会在用到时失败；远端部署前的必需路径
// 因此要覆盖本地 seed 的全部必需路径。server 运行时不依赖 bootstrap，这里机械对照两份清单。
describe("remote official plugin required paths", () => {
  it("design 覆盖本地 seed 的全部必需路径（references 与磁盘一致、7 个运行时脚本、hook）", () => {
    const remote = new Set<string>(REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS);
    const missing = OFFICIAL_DESIGN_REQUIRED_SEED_PATHS.map((path) => `design-plugin/${path}`).filter(
      (path) => !remote.has(path),
    );
    expect(missing).toEqual([]);
    const seeds: readonly string[] = OFFICIAL_DESIGN_REQUIRED_SEED_PATHS;
    // 规则文件按需读取，少登记一份只会在用到时才报错：seed 清单必须等于随包 references 目录。
    const referencesDir = fileURLToPath(
      new URL("../../../apps/zcode-cli/packages/design-plugin/skills/design/references/", import.meta.url),
    );
    expect(seeds.filter((path) => path.startsWith("skills/design/references/")).sort()).toEqual(
      readdirSync(referencesDir)
        .filter((name) => name.endsWith(".md"))
        .map((name) => `skills/design/references/${name}`)
        .sort(),
    );
    // build-catalog.mjs / frontmatter.mjs 只在开发时生成目录，不随包；其余脚本会话里会执行。
    expect(seeds.filter((path) => path.startsWith("skills/design/scripts/"))).toHaveLength(7);
  });
});
