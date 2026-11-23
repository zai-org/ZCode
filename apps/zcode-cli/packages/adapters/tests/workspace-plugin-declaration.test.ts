import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { inspectWorkspacePluginRoot } from "../src/plugins/workspace-plugin-declaration/index.js";

// docs/plugins/workspace-plugin-dir-trust.md：声明摘要的覆盖范围与稳定性。
let workspace: string;
let plugin: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "zcode-workspace-plugin-declaration-"));
  plugin = join(workspace, "plugins", "demo");
  await mkdir(join(plugin, ".zcode-plugin"), { recursive: true });
  await mkdir(join(plugin, "mcp"), { recursive: true });
});
afterEach(() => rm(workspace, { recursive: true, force: true }));

async function digest(): Promise<string | undefined> {
  return (await inspectWorkspacePluginRoot({ workspaceRoot: workspace, rootPath: plugin }))
    ?.declarationDigest;
}

it("covers MCP declaration files referenced through nested arrays", async () => {
  // !3742 CR-01：MCP 加载递归展开嵌套数组；摘要曾只看一层，嵌套引用的文件改了也不回到待信任。
  await writeFile(
    join(plugin, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: "demo", mcpServers: [["./mcp/servers.json"]] }),
  );
  await writeFile(
    join(plugin, "mcp", "servers.json"),
    JSON.stringify({ mcpServers: { a: { command: "node" } } }),
  );
  const before = await digest();
  await writeFile(
    join(plugin, "mcp", "servers.json"),
    JSON.stringify({ mcpServers: { a: { command: "python" } } }),
  );
  expect(await digest()).not.toBe(before);
});

it("keeps the digest independent of the process locale", async () => {
  // !3742 SG-03：文件按码点排序，不能依赖 localeCompare 的语言规则。
  await writeFile(
    join(plugin, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: "demo", mcpServers: ["./mcp/B.json", "./mcp/a.json"] }),
  );
  await writeFile(join(plugin, "mcp", "B.json"), "{}");
  await writeFile(join(plugin, "mcp", "a.json"), "{}");
  const original = String.prototype.localeCompare;
  const expected = await digest();
  try {
    // 模拟另一种 locale 的排序结果：反转比较方向。
    String.prototype.localeCompare = function (this: string, other: string) {
      return -original.call(this, other);
    };
    expect(await digest()).toBe(expected);
  } finally {
    String.prototype.localeCompare = original;
  }
});
