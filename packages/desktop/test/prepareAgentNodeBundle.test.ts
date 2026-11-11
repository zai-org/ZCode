import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(import.meta.dirname, "../scripts/prepare-agent-node-bundle.mjs");

it.each([
  { label: "有 tsconfig", hasTsconfig: true, runtimeBuildScript: "scripts/build-mcp.mjs" },
  {
    label: "无 tsconfig",
    hasTsconfig: false,
    runtimeBuildScript: "../office-runtime/scripts/build.mjs",
  },
])(
  "bootstrap 官方插件构建先清理旧 dist，缺少 dist 时也能继续构建（$label）",
  async ({ hasTsconfig, runtimeBuildScript }) => {
    const source = (await readFile(scriptPath, "utf8")).replace(/\r\n/g, "\n");
    // 修复原因：只断言源码包含 rmSync 调用会漏掉缺少导入的 ReferenceError。
    // 保留脚本的真实 Node 导入与函数，在隔离目录执行清理，只拦截昂贵的构建子命令。
    const imports = source.match(/^import .+ from "node:[^"]+";$/gm)?.join("\n");
    const buildFunction = source.match(
      /function buildOfficialPluginRuntimeForBootstrap\(plugin\) \{[\s\S]*?\n\}(?=\n\nfunction)/u,
    )?.[0];
    expect(imports).toBeDefined();
    expect(buildFunction).toBeDefined();

    const repoRoot = await mkdtemp(join(tmpdir(), "agent-plugin-bootstrap-"));
    const pluginRoot = join(repoRoot, "plugin");
    const distPath = join(pluginRoot, "dist");
    try {
      await mkdir(distPath, { recursive: true });
      await writeFile(join(distPath, "stale.js"), "old runtime");
      // 缺陷原因：旧夹具未创建 tsconfig，却要求执行 tsc；分别覆盖编译型插件和共享 runtime 插件。
      if (hasTsconfig) await writeFile(join(pluginRoot, "tsconfig.json"), "{}");
      const probe = `
${imports}
const repoRoot = ${JSON.stringify(repoRoot)};
const calls = [];
function runCommand(command, args, options) {
  if (existsSync(resolve(options.cwd, "dist"))) {
    throw new Error("旧 dist 必须在构建前清理");
  }
  calls.push({ command, args, cwd: options.cwd });
}
${buildFunction}
const plugin = { relativePath: "plugin", runtimeBuildScript: ${JSON.stringify(runtimeBuildScript)} };
buildOfficialPluginRuntimeForBootstrap(plugin);
buildOfficialPluginRuntimeForBootstrap(plugin);
process.stdout.write(JSON.stringify(calls));
`;
      const { stdout } = await execFileAsync(process.execPath, [
        "--input-type=module",
        "--eval",
        probe,
      ]);
      const expectedBuild = [
        ...(hasTsconfig
          ? [
              {
                command: process.execPath,
                args: ["../../node_modules/typescript/bin/tsc"],
                cwd: pluginRoot,
              },
            ]
          : []),
        {
          command: process.execPath,
          args: [runtimeBuildScript],
          cwd: pluginRoot,
        },
      ];
      expect(JSON.parse(stdout)).toEqual([...expectedBuild, ...expectedBuild]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  },
);
