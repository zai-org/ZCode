import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("根类型检查覆盖 Renderer 的远程服务接口装配", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const buildCommand = packageJson.scripts.typecheck
    .split("&&")
    .map((command: string) => command.trim())
    .find((command: string) => command.startsWith("tsc -b "));
  expect(buildCommand).toBeDefined();
  const pending: string[] = buildCommand.slice("tsc -b ".length).split(/\s+/u);
  const visited = new Set<string>();
  const checkedFiles = new Set<string>();
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  };
  while (pending.length > 0) {
    const entry = resolve(root, pending.pop()!);
    const configPath = entry.endsWith(".json") ? entry : resolve(entry, "tsconfig.json");
    if (visited.has(configPath)) continue;
    visited.add(configPath);
    // TypeScript 配置解析器只提供同步文件系统接口；与真实 tsc 共用配置继承和 include 规则。
    const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
    expect(config, configPath).toBeDefined();
    config!.fileNames.forEach((file) => checkedFiles.add(resolve(file)));
    config!.projectReferences?.forEach((reference) => pending.push(reference.path));
  }
  // 缺少 Renderer 工程时，服务接口已新增方法而远程占位未实现也会被根检查漏过。
  expect(checkedFiles).toContain(
    resolve(root, "packages/desktop/src/renderer/src/remoteWorkspaceSessionServices.ts"),
  );
});
