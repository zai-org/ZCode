import { access, chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRuntimeManifest, type ServerTarget } from "../runtime/manifest.js";
import { SERVER_CREDENTIAL_FORMAT } from "../contracts.js";
import {
  collectBareModuleSpecifiers,
  copyPackageDir,
  ensureNodePtyPrebuild,
  isNodePtyRuntimePath,
  isTargetSpecificPackage,
  pruneKoffiRuntime,
  resolveProductionPackageClosure,
} from "./stageDependencies.js";
import { createComponentArchive, hashPaths, runPackagingCommand } from "./stageArchives.js";

export { collectBareModuleSpecifiers, isNodePtyRuntimePath, resolveProductionPackageClosure };

export interface StageOptions {
  target: ServerTarget;
  appVersion: string;
  /** tsup 产物目录（server-cli.js / server-core.js） */
  distDir: string;
  /** 既有 CLI/Agent bundle（zcode.cjs，自包含 CJS） */
  agentBundlePath: string;
  /** CLI 内置技能包；不依赖官方插件缓存。 */
  bundledSkillsDir: string;
  /** 已准备好的目标平台 Node 二进制 */
  nodeBinaryPath: string;
  /** 构建入口从统一合规 owner（scripts/third-party-notices.mjs）读取后传入；组件组装不能自行拼凑许可。 */
  notices: { thirdParty: string; node: string; nodeSource: string };
  /** 依赖闭包解析与复制的来源 node_modules */
  workspaceNodeModulesDir: string;
  /** 未被 pnpm 链接到 node_modules 的 workspace 包（例如 @zcode/tui）。 */
  workspacePackageDirs?: ReadonlyMap<string, string>;
  /** 发行目录的输出父目录 */
  outputDir: string;
  /** 已准备好的 native search tools 根目录（tools/<id>/<binary>）。 */
  nativeToolsDir?: string;
  /** 官方插件源码或已 seed 的 packages 目录。 */
  officialPluginsDir?: string;
  /** 是否同时产出 tar.gz（默认 true） */
  archive?: boolean;
  /** 是否生成独立组件归档（默认 true）；关闭时仍保留组件内容哈希和大小。 */
  componentArchives?: boolean;
}

export interface StagedRelease {
  releaseDir: string;
  archivePath: string | null;
  componentArchivePaths: string[];
  packagedDependencies: string[];
}

const POSIX_LAUNCHER = `#!/bin/sh
# 由 zcode-server staging 生成：定位发行根后用随包 Node 启动 Server CLI。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$DIR/runtime/node" "$DIR/runtime/server-cli.js" "$@"
`;

const WINDOWS_LAUNCHER = [
  "@echo off",
  'set "DIR=%~dp0.."',
  '"%DIR%\\runtime\\node.exe" "%DIR%\\runtime\\server-cli.js" %*',
  "",
].join("\r\n");

async function copyDirectoryIfPresent(
  sourceDir: string | undefined,
  targetDir: string,
): Promise<string[]> {
  if (!sourceDir) return [];
  try {
    await access(sourceDir);
  } catch {
    return [];
  }
  const candidates = (await readdir(sourceDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-plugin"))
    .map((entry) => entry.name)
    .filter((name) => name !== "superpowers-plugin")
    .sort();
  // Bug 原因：只按 "-plugin" 后缀识别官方插件，会把 checkout 残留的僵尸目录也算进去。CI 用
  // GIT_CLEAN_FLAGS "-e node_modules/" 跨 job 保留 node_modules，别的分支（例如把 zcode-cua-plugin
  // 改名为 computer-use-plugin 的分支）install 过的插件目录切回来后只剩 node_modules；tracked 文件
  // 全没了，但目录还在。官方插件的 package.json 都是 tracked 文件，以它是否存在判定"该目录属于
  // 当前 checkout"；通过判定的插件仍走下方 fail-closed 校验，不放松对残缺插件的拒绝。
  const names: string[] = [];
  for (const name of candidates) {
    try {
      await access(join(sourceDir, name, "package.json"));
      names.push(name);
    } catch {
      // 无 package.json ⇒ 不是当前 checkout 的 workspace 包，跳过。
    }
  }
  for (const name of names) {
    const stagedDir = join(targetDir, name);
    await copyPackageDir(join(sourceDir, name), stagedDir);
    await assertOfficialPluginRuntime(stagedDir, name);
  }
  return names.map((name) => name.replace(/-plugin$/u, ""));
}

const PLUGIN_ROOT_PLACEHOLDER_PREFIX = "${ZCODE_PLUGIN_ROOT}/";

/**
 * Bug 原因：legacy prepare-prebuilds.mjs 曾显式构建并断言 android-emulator / ios-simulator /
 * browser-use 的 `dist/mcp/server.js`；切到 stageRelease 后只剩整目录复制，而插件 dist 被
 * gitignore，干净 CI 工作区会把只有 plugin.json 与 skills、却没有 MCP 入口的插件静默打进
 * archive，远端启用插件后 MCP server 启动时才报找不到文件。这里以 plugin.json 声明为事实源做
 * fail-closed 校验：manifest 缺失，或 mcpServers 的 command/args 引用的 `${ZCODE_PLUGIN_ROOT}/...`
 * 文件不在 staged 目录里，staging 直接失败，而不是产出残缺 archive。
 */
async function assertOfficialPluginRuntime(stagedDir: string, name: string): Promise<void> {
  const manifestPath = join(stagedDir, ".zcode-plugin", "plugin.json");
  let manifest: {
    mcpServers?: Record<string, { command?: unknown; args?: unknown } | undefined>;
  };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
  } catch (error) {
    throw new Error(`Official plugin ${name} has no readable manifest: ${manifestPath}`, {
      cause: error,
    });
  }
  const missing: string[] = [];
  for (const server of Object.values(manifest.mcpServers ?? {})) {
    if (!server) continue;
    const references = [server.command, ...(Array.isArray(server.args) ? server.args : [])];
    for (const reference of references) {
      if (typeof reference !== "string" || !reference.startsWith(PLUGIN_ROOT_PLACEHOLDER_PREFIX))
        continue;
      const relativePath = reference.slice(PLUGIN_ROOT_PLACEHOLDER_PREFIX.length);
      try {
        await access(join(stagedDir, ...relativePath.split("/")));
      } catch {
        missing.push(relativePath);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Official plugin ${name} manifest references MCP runtime files missing from the staged package: ${missing.join(", ")} (build the plugin before staging)`,
    );
  }
}

const BUNDLED_SKILL_PACK_TOP_LEVEL_PATHS: readonly string[] = ["README.md", "skills"];

async function copyNativeTools(
  sourceDir: string | undefined,
  targetDir: string,
  target: ServerTarget,
): Promise<string[]> {
  if (!sourceDir) return [];
  try {
    await access(sourceDir);
  } catch {
    return [];
  }
  const ids = target.startsWith("win32-") ? ["ripgrep", "ugrep"] : ["bfs", "ripgrep", "ugrep"];
  const copied: string[] = [];
  for (const id of ids) {
    const source = join(
      sourceDir,
      id,
      id === "ripgrep"
        ? target.startsWith("win32-")
          ? "rg.exe"
          : "rg"
        : id + (target.startsWith("win32-") ? ".exe" : ""),
    );
    try {
      await access(source);
    } catch {
      continue;
    }
    const targetPath = join(targetDir, id, source.split(sep).pop() ?? id);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(source, targetPath, { dereference: true });
    // 修复：只复制可执行文件会让独立 native-search-tools 组件丢失已准备的声明。
    for (const notice of ["THIRD-PARTY-NOTICES.txt", "SOURCES.json"]) {
      const bytes = await readFile(join(dirname(source), notice));
      if (!bytes.length) throw new Error(`Empty native notice: ${notice}`);
      await writeFile(join(dirname(targetPath), notice), bytes);
    }
    if (!target.startsWith("win32-")) await chmod(targetPath, 0o755);
    copied.push(id);
  }
  return copied;
}

/** 组装 `zcode-server-<os>-<arch>/` 发行目录（spec §7.1）；只做本地组装，不上传、不发布。 */
export async function stageRelease(options: StageOptions): Promise<StagedRelease> {
  for (const [name, value] of Object.entries(options.notices)) {
    if (!value.trim()) throw new Error(`Missing distribution notice: ${name}`);
  }
  const releaseName = `zcode-server-${options.target}`;
  const outputRoot = resolve(options.outputDir);
  const releaseDir = join(outputRoot, releaseName);
  const runtimeDir = join(releaseDir, "runtime");
  await rm(releaseDir, { force: true, recursive: true });
  // staging 是发布目录的重建操作：删除同 target 的旧组件归档，避免上一次构建的
  // hash 仍被误上传到 CDN，导致 catalog 暴露无法与本次 manifest 对齐的组件。
  await rm(join(outputRoot, "components", options.target), {
    force: true,
    recursive: true,
  });
  await rm(join(outputRoot, ".components"), { force: true, recursive: true });
  await mkdir(join(releaseDir, "bin"), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  // 每个可独立下载的组件都要带适用声明，并在计算组件哈希前写入。
  await writeFile(join(runtimeDir, "THIRD-PARTY-NOTICES.md"), options.notices.thirdParty);
  await writeFile(join(runtimeDir, "LICENSE.node.txt"), options.notices.node);
  await writeFile(join(runtimeDir, "NODE-SOURCES.json"), options.notices.nodeSource);
  for (const component of ["agent", "official-plugins"]) {
    await mkdir(join(runtimeDir, "licenses", component), { recursive: true });
    await writeFile(
      join(runtimeDir, "licenses", component, "THIRD-PARTY-NOTICES.md"),
      options.notices.thirdParty,
    );
  }

  // 入口 bundle 与 sourcemap 同名复制，文件名必须与 cli.ts 的相对路径解析保持一致。
  const bundleSources: string[] = [];
  for (const entryName of ["server-cli.js", "server-core.js"]) {
    const sourcePath = join(options.distDir, entryName);
    const contents = await readFile(sourcePath, "utf8");
    bundleSources.push(contents);
    await writeFile(join(runtimeDir, entryName), contents, "utf8");
  }
  await writeFile(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: releaseName, private: true, type: "module", zcodeCredentialFormat: SERVER_CREDENTIAL_FORMAT }, null, 2)}\n`,
    "utf8",
  );
  await cp(options.agentBundlePath, join(runtimeDir, "zcode.cjs"), {
    dereference: true,
  });
  // 修复原因：dynamic-workflows 已迁出插件，按 -plugin 复制会漏带工作流的必需技能。
  // 随 Agent 组件独立交付并参与内容哈希，不能依赖服务器旧版本的插件缓存。
  for (const file of ["SKILL.md", "patterns.md", "examples.md"]) {
    const skillPath = join(options.bundledSkillsDir, "skills/dynamic-workflows", file);
    try {
      await access(skillPath);
    } catch (cause) {
      throw new Error(`Missing bundled skill required asset: ${skillPath}`, { cause });
    }
  }
  // 插件缓存可能缺包或过期；只复制 Agent 源中的发布资产，避免二次复制覆盖。
  await copyPackageDir(
    options.bundledSkillsDir,
    join(runtimeDir, "packages/bundled-skills"),
    (relativePath) => BUNDLED_SKILL_PACK_TOP_LEVEL_PATHS.includes(relativePath.split(sep)[0] ?? ""),
  );
  // Agent bundle 是第三个实际运行入口；只扫描 Server bundle 会漏掉外置的 TUI/Playwright。
  bundleSources.push(await readFile(options.agentBundlePath, "utf8"));

  const nodeTargetPath = join(
    runtimeDir,
    options.target.startsWith("win32-") ? "node.exe" : "node",
  );
  await cp(options.nodeBinaryPath, nodeTargetPath, { dereference: true });
  if (!options.target.startsWith("win32-")) await chmod(nodeTargetPath, 0o755);

  // runtime/node_modules 以产物扫描为事实源：bundle 引用什么就装什么（含传递依赖），
  // 不使用 tsup external 声明列表，避免声明与实际引用漂移。
  const referencedPackages = new Set<string>();
  for (const source of bundleSources) {
    for (const name of collectBareModuleSpecifiers(source)) referencedPackages.add(name);
  }
  const rawClosure = await resolveProductionPackageClosure(
    [...referencedPackages],
    options.workspaceNodeModulesDir,
    options.workspacePackageDirs,
  );
  const closure = new Map(
    [...rawClosure].filter(([packageName]) => isTargetSpecificPackage(packageName, options.target)),
  );
  const nodeModulesTargetDir = join(runtimeDir, "node_modules");
  for (const [packageName, packageDir] of closure) {
    const targetDir = join(nodeModulesTargetDir, ...packageName.split("/"));
    await mkdir(dirname(targetDir), { recursive: true });
    if (packageName === "node-pty") {
      await copyPackageDir(packageDir, targetDir, (relativePath) =>
        isNodePtyRuntimePath(relativePath, options.target),
      );
    } else {
      // Agent 的外置依赖存在 peer 版本并存（例如 ajv6 + ajv8）。只为已知 peer
      // 冲突包保留 nested node_modules，避免把 pnpm 的整棵开发依赖树复制进发行包。
      await copyPackageDir(
        packageDir,
        targetDir,
        undefined,
        packageName === "ajv-formats" || packageName === "ajv-keywords",
      );
      if (packageName === "koffi") await pruneKoffiRuntime(packageDir, targetDir, options.target);
    }
  }

  if (closure.has("node-pty")) {
    await ensureNodePtyPrebuild(options, nodeModulesTargetDir);
  }

  const tools = await copyNativeTools(
    options.nativeToolsDir,
    join(runtimeDir, "tools"),
    options.target,
  );
  if (options.target.startsWith("win32-")) {
    if (!options.nativeToolsDir)
      throw new Error("Windows release requires runtime Job host assets");
    const targetDir = join(runtimeDir, "tools/runtime-host");
    await mkdir(targetDir, { recursive: true });
    await cp(
      join(options.nativeToolsDir, "runtime-host/zcode-runtime-host.exe"),
      join(targetDir, "zcode-runtime-host.exe"),
    );
  }
  const plugins = await copyDirectoryIfPresent(
    options.officialPluginsDir,
    join(runtimeDir, "packages"),
  );

  const launcherPath = join(
    releaseDir,
    "bin",
    options.target.startsWith("win32-") ? "zcode.cmd" : "zcode",
  );
  await writeFile(launcherPath, POSIX_LAUNCHER, "utf8");
  if (options.target.startsWith("win32-")) {
    await writeFile(launcherPath, WINDOWS_LAUNCHER, "utf8");
  } else {
    await chmod(launcherPath, 0o755);
  }

  const componentSpecs = [
    {
      id: "node-runtime",
      paths: [
        options.target.startsWith("win32-") ? "runtime/node.exe" : "runtime/node",
        "runtime/LICENSE.node.txt",
        "runtime/NODE-SOURCES.json",
      ],
    },
    {
      id: "server-runtime",
      paths: [
        "runtime/server-cli.js",
        "runtime/server-core.js",
        "runtime/package.json",
        "runtime/node_modules",
        "runtime/THIRD-PARTY-NOTICES.md",
        ...(options.target.startsWith("win32-") ? ["runtime/tools/runtime-host"] : []),
      ],
    },
    {
      id: "agent-runtime",
      paths: ["runtime/zcode.cjs", "runtime/packages/bundled-skills", "runtime/licenses/agent"],
    },
    ...(plugins.length > 0
      ? [
          {
            id: "official-plugins",
            paths: [
              ...plugins.map((name) => `runtime/packages/${name}-plugin`),
              "runtime/licenses/official-plugins",
            ],
          },
        ]
      : []),
    ...(tools.length > 0
      ? [{ id: "native-search-tools", paths: tools.map((id) => `runtime/tools/${id}`) }]
      : []),
  ];
  const componentMeta: Array<{
    id: string;
    sha256: string;
    paths: string[];
    sizeBytes: number;
    archivePath?: string;
  }> = [];
  const componentArchivePaths: string[] = [];
  for (const component of componentSpecs) {
    const info = await hashPaths(releaseDir, component.paths);
    componentMeta.push({ ...component, ...info });
  }
  const manifest = createRuntimeManifest(options.target, options.appVersion, {
    tools,
    plugins,
    components: componentMeta,
  });
  // SSH 开发验证只安装整包；独立组件归档会重复哈希、复制和压缩同一批内容。
  // 仅跳过归档生成，保留上方组件身份计算和完整资源校验；默认发布链仍生成组件包。
  if (options.componentArchives !== false) {
    for (const component of componentMeta) {
      const archive = await createComponentArchive(
        releaseDir,
        outputRoot,
        options.target,
        component.id,
        component.paths,
      );
      component.archivePath = relative(outputRoot, archive.archivePath).split(sep).join("/");
      componentArchivePaths.push(archive.archivePath);
    }
  }
  await writeFile(
    join(releaseDir, "manifest.json"),
    `${JSON.stringify({ ...manifest, components: componentMeta }, null, 2)}\n`,
    "utf8",
  );

  let archivePath: string | null = null;
  if (options.archive !== false) {
    const extension = options.target.startsWith("win32-") ? "zip" : "tar.gz";
    archivePath = join(outputRoot, `${releaseName}.${extension}`);
    await rm(archivePath, { force: true });
    if (extension === "zip")
      await runPackagingCommand("zip", ["-qr", archivePath, releaseName], outputRoot);
    else await runPackagingCommand("tar", ["-czf", archivePath, releaseName], outputRoot);
  }

  return {
    releaseDir,
    archivePath,
    componentArchivePaths,
    packagedDependencies: [...closure.keys()].sort(),
  };
}
