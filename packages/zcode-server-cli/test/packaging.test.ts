import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectBareModuleSpecifiers,
  isNodePtyRuntimePath,
  resolveProductionPackageClosure,
  stageRelease,
} from "../src/packaging/stage.js";
import {
  assertNodePtyNativeMatchesJs,
  isTargetSpecificPackage,
} from "../src/packaging/stageDependencies.js";
import { resolveHostTarCommand } from "../src/packaging/tarCommand.js";

const execFileAsync = promisify(execFile);
async function runTar(args: string[]): Promise<void> {
  await execFileAsync(resolveHostTarCommand(), args);
}

const temporaryDirs: string[] = [];
const macIt = process.platform === "darwin" ? it : it.skip;

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-server-stage-test-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

interface FakePackageSpec {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: Record<string, string>;
}

async function writeFakePackage(
  nodeModulesDir: string,
  name: string,
  spec: FakePackageSpec = {},
): Promise<string> {
  const packageDir = join(nodeModulesDir, ...name.split("/"));
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name,
      version: spec.version ?? "0.0.1",
      main: "./index.js",
      dependencies: spec.dependencies,
      optionalDependencies: spec.optionalDependencies,
      devDependencies: spec.devDependencies,
    }),
    "utf8",
  );
  await writeFile(join(packageDir, "index.js"), "module.exports = {};\n", "utf8");
  for (const [relativePath, contents] of Object.entries(spec.files ?? {})) {
    const filePath = join(packageDir, ...relativePath.split("/"));
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }
  return packageDir;
}

describe("collectBareModuleSpecifiers", () => {
  it("extracts bare imports, dynamic imports and requires as package names", () => {
    const source = [
      'import { Hono } from "hono";',
      'import { serve } from "@hono/node-server";',
      'const pty = await import("node-pty");',
      'const utils = require("node-pty/lib/utils");',
    ].join("\n");
    const names = collectBareModuleSpecifiers(source);
    expect(names).toContain("hono");
    expect(names).toContain("@hono/node-server");
    expect(names).toContain("node-pty");
  });

  it("ignores node builtins and relative specifiers", () => {
    const source = [
      'import { readFile } from "node:fs/promises";',
      'import local from "./local.js";',
      'import parent from "../parent.js";',
    ].join("\n");
    expect(collectBareModuleSpecifiers(source).size).toBe(0);
  });
});

describe("resolveProductionPackageClosure", () => {
  it("collects transitive production dependencies but not dev dependencies", async () => {
    const root = await makeTempDir();
    const nodeModulesDir = join(root, "node_modules");
    await writeFakePackage(nodeModulesDir, "pkg-a", {
      dependencies: { "pkg-b": "*" },
      devDependencies: { "pkg-dev": "*" },
    });
    await writeFakePackage(nodeModulesDir, "pkg-b", {
      dependencies: { "@scope/pkg-c": "*" },
    });
    await writeFakePackage(nodeModulesDir, "@scope/pkg-c");
    await writeFakePackage(nodeModulesDir, "pkg-dev");

    const closure = await resolveProductionPackageClosure(["pkg-a"], nodeModulesDir);
    expect([...closure.keys()].sort()).toEqual(["@scope/pkg-c", "pkg-a", "pkg-b"]);
  });

  it("skips missing optional dependencies and unknown entry packages", async () => {
    const root = await makeTempDir();
    const nodeModulesDir = join(root, "node_modules");
    await writeFakePackage(nodeModulesDir, "pkg-a", {
      optionalDependencies: { "pkg-missing-optional": "*" },
    });

    const closure = await resolveProductionPackageClosure(
      ["pkg-a", "pkg-not-installed"],
      nodeModulesDir,
    );
    expect([...closure.keys()]).toEqual(["pkg-a"]);
  });
});

describe("isNodePtyRuntimePath", () => {
  it("keeps runtime files and the target platform prebuild only", () => {
    expect(isNodePtyRuntimePath("package.json", "linux-x64")).toBe(true);
    expect(isNodePtyRuntimePath("lib/index.js", "linux-x64")).toBe(true);
    expect(isNodePtyRuntimePath("typings/node-pty.d.ts", "linux-x64")).toBe(true);
    expect(isNodePtyRuntimePath("prebuilds/linux-x64/pty.node", "linux-x64")).toBe(true);
    expect(isNodePtyRuntimePath("LICENSE", "linux-x64")).toBe(true);
  });

  it("drops host build outputs, sources and other platform prebuilds", () => {
    expect(isNodePtyRuntimePath("build/Release/pty.node", "linux-x64")).toBe(false);
    expect(isNodePtyRuntimePath("build/Debug/pty.node", "linux-x64")).toBe(false);
    expect(isNodePtyRuntimePath("prebuilds/darwin-arm64/pty.node", "linux-x64")).toBe(false);
    expect(isNodePtyRuntimePath("src/unix/pty.cc", "linux-x64")).toBe(false);
    expect(isNodePtyRuntimePath("deps/winpty/x.h", "linux-x64")).toBe(false);
    expect(isNodePtyRuntimePath("scripts/post-install.js", "linux-x64")).toBe(false);
  });
});

describe("assertNodePtyNativeMatchesJs", () => {
  it("rejects a native prebuild whose source version differs from the node-pty JS", () => {
    // 现场组合：官方 node-pty 1.1.0 JS + @lydell 1.2.0-beta.10 native。
    expect(() =>
      assertNodePtyNativeMatchesJs({
        target: "linux-x64",
        jsVersion: "1.1.0",
        nativeSource: "@lydell/node-pty-linux-x64",
        nativeVersion: "1.2.0-beta.10",
      }),
    ).toThrow(/node-pty JS 1\.1\.0 .*@lydell\/node-pty-linux-x64 1\.2\.0-beta\.10/);
  });

  it("accepts JS and native from the same version", () => {
    expect(() =>
      assertNodePtyNativeMatchesJs({
        target: "linux-x64",
        jsVersion: "1.2.0-beta.10",
        nativeSource: "@lydell/node-pty-linux-x64",
        nativeVersion: "1.2.0-beta.10",
      }),
    ).not.toThrow();
  });
});

describe("stageRelease", () => {
  async function makeStageFixture(): Promise<{
    distDir: string;
    workspaceNodeModulesDir: string;
    agentBundlePath: string;
    bundledSkillsDir: string;
    nodeBinaryPath: string;
    outputDir: string;
    notices: { thirdParty: string; node: string; nodeSource: string };
  }> {
    const root = await makeTempDir();
    const distDir = join(root, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(
      join(distDir, "server-cli.js"),
      'import "fake-dep";\nimport "node-pty";\n',
      "utf8",
    );
    await writeFile(join(distDir, "server-core.js"), 'import "node:fs";\n', "utf8");

    const workspaceNodeModulesDir = join(root, "node_modules");
    await writeFakePackage(workspaceNodeModulesDir, "fake-dep", {
      dependencies: { "fake-transitive": "*" },
    });
    await writeFakePackage(workspaceNodeModulesDir, "fake-transitive");
    await writeFakePackage(workspaceNodeModulesDir, "node-pty", {
      version: "1.1.0",
      files: {
        LICENSE: "node-pty license\n",
        "lib/index.js": "// official node-pty js\n",
        "typings/node-pty.d.ts": "export {};\n",
        "build/Release/pty.node": "host-binary",
        "prebuilds/darwin-arm64/pty.node": "darwin-binary",
        "prebuilds/darwin-arm64/spawn-helper": "darwin-helper",
        "prebuilds/win32-x64/pty.node": "windows-binary",
      },
    });
    // 平台包是同版本 node-pty 的 linux 子集：JS 与 native 同在一个包里。
    await writeFakePackage(workspaceNodeModulesDir, "@lydell/node-pty-linux-x64", {
      version: "1.2.0-beta.10",
      files: {
        LICENSE: "platform license\n",
        "lib/index.js": "// platform node-pty js\n",
        "prebuilds/linux-x64/pty.node": "linux-binary",
      },
    });

    const bundledSkillsDir = join(root, "bundled-skills");
    await mkdir(join(bundledSkillsDir, "skills/dynamic-workflows"), { recursive: true });
    await writeFile(join(bundledSkillsDir, "README.md"), "bundled skills");
    await writeFile(join(bundledSkillsDir, "scratch.txt"), "local only");
    for (const name of ["SKILL.md", "patterns.md", "examples.md"]) {
      await writeFile(join(bundledSkillsDir, "skills/dynamic-workflows", name), `fixture ${name}`);
    }
    const agentBundlePath = join(root, "zcode.cjs");
    await writeFile(agentBundlePath, "// fake agent bundle\n", "utf8");
    const nodeBinaryPath = join(root, "node-binary");
    await writeFile(nodeBinaryPath, "#!/bin/sh\nexit 0\n", "utf8");

    const outputDir = join(root, "out");
    const notices = {
      thirdParty: "Copyright npm\nComplete terms\n",
      node: "Copyright Node\nComplete runtime terms\n",
      nodeSource: '{"version":"22.16.0"}\n',
    };
    return {
      distDir,
      workspaceNodeModulesDir,
      agentBundlePath,
      bundledSkillsDir,
      nodeBinaryPath,
      outputDir,
      notices,
    };
  }

  async function writeFakeNativeTools(
    toolsDir: string,
    tools: Record<string, string>,
  ): Promise<void> {
    for (const [tool, binaryName] of Object.entries(tools)) {
      await mkdir(join(toolsDir, tool), { recursive: true });
      await writeFile(join(toolsDir, tool, binaryName), tool, "utf8");
      await writeFile(
        join(toolsDir, tool, "THIRD-PARTY-NOTICES.txt"),
        `Copyright ${tool}\nFull terms\n`,
        "utf8",
      );
      await writeFile(join(toolsDir, tool, "SOURCES.json"), JSON.stringify({ tool }), "utf8");
    }
  }

  it("assembles the release layout for a linux target", async () => {
    const fixture = await makeStageFixture();
    const staged = await stageRelease({
      target: "linux-x64",
      appVersion: "9.9.9-test",
      archive: false,
      ...fixture,
    });

    const releaseDir = staged.releaseDir;
    expect(releaseDir.endsWith("zcode-server-linux-x64")).toBe(true);
    expect(
      JSON.parse(await readFile(join(releaseDir, "runtime", "package.json"), "utf8")),
    ).toMatchObject({
      zcodeCredentialFormat: 2,
    });

    const launcher = await readFile(join(releaseDir, "bin", "zcode"), "utf8");
    expect(launcher).toContain('"$DIR/runtime/node"');
    expect(launcher).toContain('"$DIR/runtime/server-cli.js"');
    const launcherStat = await stat(join(releaseDir, "bin", "zcode"));
    // Bugfix: NTFS 不保留 POSIX exec 位（Windows 上 stat.mode 恒无 0o111 位），
    // 可执行性断言只在 POSIX 宿主上生效；Windows 宿主仍验证文件存在与内容。
    if (process.platform !== "win32") expect(launcherStat.mode & 0o111).not.toBe(0);

    const runtimePackageJson = JSON.parse(
      await readFile(join(releaseDir, "runtime", "package.json"), "utf8"),
    ) as { type?: string };
    expect(runtimePackageJson.type).toBe("module");

    for (const relativePath of [
      "runtime/server-cli.js",
      "runtime/server-core.js",
      "runtime/zcode.cjs",
      "runtime/node",
      "runtime/node_modules/fake-dep/package.json",
      "runtime/node_modules/fake-transitive/package.json",
      "runtime/node_modules/node-pty/lib/index.js",
      "runtime/node_modules/node-pty/LICENSE",
      "runtime/THIRD-PARTY-NOTICES.md",
      "runtime/LICENSE.node.txt",
      "runtime/NODE-SOURCES.json",
      "runtime/licenses/agent/THIRD-PARTY-NOTICES.md",
      "runtime/node_modules/node-pty/prebuilds/linux-x64/pty.node",
    ]) {
      await expect(stat(join(releaseDir, ...relativePath.split("/")))).resolves.toBeTruthy();
    }

    const nodeStat = await stat(join(releaseDir, "runtime", "node"));
    // Bugfix: 同上，NTFS 无 POSIX exec 位，可执行性断言只在 POSIX 宿主生效。
    if (process.platform !== "win32") expect(nodeStat.mode & 0o111).not.toBe(0);

    // 交叉打包安全性：宿主编译产物与非目标平台 prebuilds 不进入发行包。
    await expect(stat(join(releaseDir, "runtime/node_modules/node-pty/build"))).rejects.toThrow();
    await expect(
      stat(join(releaseDir, "runtime/node_modules/node-pty/prebuilds/darwin-arm64")),
    ).rejects.toThrow();

    // linux 平台 pty.node 由 @lydell 平台包补齐。
    const linuxPty = await readFile(
      join(releaseDir, "runtime/node_modules/node-pty/prebuilds/linux-x64/pty.node"),
      "utf8",
    );
    expect(linuxPty).toBe("linux-binary");
    // Bug 回归：旧 staging 只拷平台包的 pty.node（1.2.0-beta.10，resize 要 5 个参数），
    // JS 仍是官方 1.1.0（只传 3 个参数），远端终端 resize 必然失败。JS 必须与 native 同包同版本。
    const stagedNodePty = JSON.parse(
      await readFile(join(releaseDir, "runtime/node_modules/node-pty/package.json"), "utf8"),
    ) as { version: string };
    expect(stagedNodePty.version).toBe("1.2.0-beta.10");
    await expect(
      readFile(join(releaseDir, "runtime/node_modules/node-pty/lib/index.js"), "utf8"),
    ).resolves.toBe("// platform node-pty js\n");
    await expect(stat(join(releaseDir, "runtime/node_modules/node-pty/typings"))).rejects.toThrow();

    const manifest = JSON.parse(await readFile(join(releaseDir, "manifest.json"), "utf8")) as {
      product: string;
      target: string;
      appVersion: string;
      nodeVersion: string;
      entrypoints: { cli: string; core: string; agent: string };
    };
    expect(manifest.product).toBe("zcode-server");
    expect(manifest.target).toBe("linux-x64");
    expect(manifest.appVersion).toBe("9.9.9-test");
    expect(manifest.nodeVersion).toBe("22.16.0");
    expect(manifest.entrypoints).toEqual({
      cli: "runtime/server-cli.js",
      core: "runtime/server-core.js",
      agent: "runtime/zcode.cjs",
    });

    expect(staged.packagedDependencies).toEqual(["fake-dep", "fake-transitive", "node-pty"]);
    expect(staged.archivePath).toBeNull();
  });

  it("fails closed when the linux platform package cannot supply matching node-pty JS", async () => {
    const fixture = await makeStageFixture();
    // 只有 pty.node、没有 lib 的平台包无法提供同版本 JS；不能退回“官方 JS + 平台 native”混装。
    await rm(join(fixture.workspaceNodeModulesDir, "@lydell", "node-pty-linux-x64", "lib"), {
      recursive: true,
      force: true,
    });
    await expect(
      stageRelease({ target: "linux-x64", appVersion: "9.9.9-test", archive: false, ...fixture }),
    ).rejects.toThrow(/@lydell\/node-pty-linux-x64 does not ship node-pty JS/);
  });

  it("takes the whole linux platform package even when the workspace node-pty already has a linux native", async () => {
    const fixture = await makeStageFixture();
    // Bug 场景：同一 checkout 先做桌面 Linux 打包，beforePack 把平台包的 pty.node 回填进共享的
    // 官方 node-pty。旧逻辑看到 pty.node 已存在就跳过整包替换，产出官方 1.1.0 JS + 1.2.0-beta.10 native。
    const backfilledDir = join(
      fixture.workspaceNodeModulesDir,
      "node-pty",
      "prebuilds",
      "linux-x64",
    );
    await mkdir(backfilledDir, { recursive: true });
    await writeFile(join(backfilledDir, "pty.node"), "desktop-backfilled-binary", "utf8");

    const staged = await stageRelease({
      target: "linux-x64",
      appVersion: "9.9.9-test",
      archive: false,
      ...fixture,
    });
    const stagedNodePtyDir = join(staged.releaseDir, "runtime/node_modules/node-pty");
    const stagedNodePty = JSON.parse(
      await readFile(join(stagedNodePtyDir, "package.json"), "utf8"),
    ) as { version: string };
    expect(stagedNodePty.version).toBe("1.2.0-beta.10");
    await expect(readFile(join(stagedNodePtyDir, "lib/index.js"), "utf8")).resolves.toBe(
      "// platform node-pty js\n",
    );
    await expect(
      readFile(join(stagedNodePtyDir, "prebuilds/linux-x64/pty.node"), "utf8"),
    ).resolves.toBe("linux-binary");
  });

  it("keeps official darwin JS and prebuilds including spawn-helper for darwin targets", async () => {
    const fixture = await makeStageFixture();
    const staged = await stageRelease({
      target: "darwin-arm64",
      appVersion: "9.9.9-test",
      archive: false,
      ...fixture,
    });
    const prebuildDir = join(
      staged.releaseDir,
      "runtime/node_modules/node-pty/prebuilds/darwin-arm64",
    );
    await expect(stat(join(prebuildDir, "pty.node"))).resolves.toBeTruthy();
    // darwin 官方包自带同版本 prebuild，JS 保持官方包，不受 linux 平台包影响。
    await expect(
      readFile(join(staged.releaseDir, "runtime/node_modules/node-pty/lib/index.js"), "utf8"),
    ).resolves.toBe("// official node-pty js\n");
    const helperStat = await stat(join(prebuildDir, "spawn-helper"));
    // Bugfix: 同上，NTFS 无 POSIX exec 位，可执行性断言只在 POSIX 宿主生效。
    if (process.platform !== "win32") expect(helperStat.mode & 0o111).not.toBe(0);
  });

  it("stages a Windows target with a cmd launcher and zip archive", async () => {
    const fixture = await makeStageFixture();
    const toolsDir = join(await makeTempDir(), "tools");
    await writeFakeNativeTools(toolsDir, { ripgrep: "rg.exe", ugrep: "ugrep.exe" });
    // Job 宿主属于必需的 server-runtime；漏包时必须在发布前失败。
    await expect(
      stageRelease({
        target: "win32-x64",
        appVersion: "9.9.9-test",
        nativeToolsDir: toolsDir,
        ...fixture,
      }),
    ).rejects.toThrow(/runtime-host/);
    await mkdir(join(toolsDir, "runtime-host"), { recursive: true });
    await writeFile(join(toolsDir, "runtime-host/zcode-runtime-host.exe"), "fixture runtime host");
    const staged = await stageRelease({
      target: "win32-x64",
      appVersion: "9.9.9-test",
      nativeToolsDir: toolsDir,
      ...fixture,
    });
    await expect(
      readFile(
        join(staged.releaseDir, "runtime/tools/runtime-host/zcode-runtime-host.exe"),
        "utf8",
      ),
    ).resolves.toBe("fixture runtime host");
    const manifest = JSON.parse(await readFile(join(staged.releaseDir, "manifest.json"), "utf8"));
    expect(
      manifest.components.find((component: { id: string }) => component.id === "server-runtime")
        .paths,
    ).toContain("runtime/tools/runtime-host");
    expect(
      manifest.components.find(
        (component: { id: string }) => component.id === "native-search-tools",
      ).paths,
    ).not.toContain("runtime/tools");
    expect(staged.archivePath).toMatch(/\.zip$/u);
    expect(await readFile(join(staged.releaseDir, "bin", "zcode.cmd"), "utf8")).toContain(
      "node.exe",
    );
    await expect(stat(join(staged.releaseDir, "runtime", "node.exe"))).resolves.toBeTruthy();
    await expect(
      stat(join(staged.releaseDir, "runtime", "tools", "ripgrep", "rg.exe")),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(staged.releaseDir, "runtime", "tools", "ugrep", "ugrep.exe")),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(staged.releaseDir, "runtime", "tools", "ugrep", "THIRD-PARTY-NOTICES.txt")),
    ).resolves.toBeTruthy();
    await expect(stat(join(staged.releaseDir, "runtime", "tools", "bfs"))).rejects.toThrow();
  });

  it("每个可独立下载的组件归档都携带适用的第三方声明", async () => {
    const fixture = await makeStageFixture();
    const toolsDir = join(await makeTempDir(), "tools");
    await writeFakeNativeTools(toolsDir, { bfs: "bfs", ripgrep: "rg", ugrep: "ugrep" });
    const staged = await stageRelease({
      target: "linux-x64",
      appVersion: "9.9.9-test",
      nativeToolsDir: toolsDir,
      ...fixture,
    });
    const manifest = JSON.parse(
      await readFile(join(staged.releaseDir, "manifest.json"), "utf8"),
    ) as {
      components: Array<{ id: string; archivePath: string }>;
    };
    const expected: Record<string, string[]> = {
      "node-runtime": ["runtime/LICENSE.node.txt", "runtime/NODE-SOURCES.json"],
      "server-runtime": ["runtime/THIRD-PARTY-NOTICES.md", "runtime/node_modules/node-pty/LICENSE"],
      "agent-runtime": ["runtime/licenses/agent/THIRD-PARTY-NOTICES.md"],
      "native-search-tools": [
        "runtime/tools/ripgrep/THIRD-PARTY-NOTICES.txt",
        "runtime/tools/ugrep/SOURCES.json",
      ],
    };
    expect(manifest.components.map((component) => component.id).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    const extractRoot = await makeTempDir();
    for (const component of manifest.components) {
      const extractDir = join(extractRoot, component.id);
      await mkdir(extractDir, { recursive: true });
      await runTar(["-xf", join(fixture.outputDir, component.archivePath), "-C", extractDir]);
      for (const member of expected[component.id] ?? []) {
        expect(await readFile(join(extractDir, member))).toEqual(
          await readFile(join(staged.releaseDir, member)),
        );
      }
    }
  });

  it.each([true, false])(
    "工具目录缺少声明或声明参数为空时拒绝组装发行包（componentArchives=%s）",
    async (componentArchives) => {
      const fixture = await makeStageFixture();
      const toolsDir = join(await makeTempDir(), "tools");
      await writeFakeNativeTools(toolsDir, { bfs: "bfs", ripgrep: "rg", ugrep: "ugrep" });
      await rm(join(toolsDir, "ripgrep", "THIRD-PARTY-NOTICES.txt"));
      await expect(
        stageRelease({
          target: "linux-x64",
          appVersion: "9.9.9-test",
          archive: false,
          nativeToolsDir: toolsDir,
          componentArchives,
          ...fixture,
        }),
      ).rejects.toThrow(/ENOENT/u);
      await expect(
        stageRelease({
          target: "linux-x64",
          appVersion: "9.9.9-test",
          archive: false,
          ...fixture,
          notices: { ...fixture.notices, node: " " },
          componentArchives,
        }),
      ).rejects.toThrow(/Missing distribution notice: node/u);
    },
  );
  macIt("omits macOS extended attributes from POSIX release archives", async () => {
    const fixture = await makeStageFixture();
    await execFileAsync("xattr", ["-w", "com.example.zcode", "value", fixture.nodeBinaryPath]);

    const staged = await stageRelease({
      target: "linux-x64",
      appVersion: "9.9.9-test",
      ...fixture,
    });
    const archive = gunzipSync(await readFile(staged.archivePath ?? ""));
    const tarText = archive.toString("latin1");

    expect(tarText).not.toContain("LIBARCHIVE.xattr");
    expect(tarText).not.toContain("SCHILY.xattr");
  });

  it("bundled workflow skills ship in the agent component and affect its hash", async () => {
    const fixture = await makeStageFixture();
    const officialPluginsDir = join(await makeTempDir(), "packages");
    await writeOfficialPluginFixture(officialPluginsDir, "zcode-guide-plugin");
    const options = {
      ...fixture,
      officialPluginsDir,
      target: "linux-x64" as const,
      appVersion: "test",
      archive: false,
    };
    const staged = await stageRelease(options);
    const manifest = JSON.parse(await readFile(join(staged.releaseDir, "manifest.json"), "utf8"));
    const component = manifest.components.find(
      (entry: { id: string }) => entry.id === "agent-runtime",
    );
    expect(component.paths).toContain("runtime/packages/bundled-skills");
    expect(manifest.plugins).not.toContain("bundled-skills");
    const archive = gunzipSync(
      await readFile(join(fixture.outputDir, component.archivePath)),
    ).toString("utf8");
    for (const name of ["SKILL.md", "patterns.md", "examples.md"]) {
      expect(
        await readFile(
          join(staged.releaseDir, "runtime/packages/bundled-skills/skills/dynamic-workflows", name),
          "utf8",
        ),
      ).toBe(`fixture ${name}`);
      expect(archive).toContain(`fixture ${name}`);
    }
    await writeFile(
      join(fixture.bundledSkillsDir, "skills/dynamic-workflows/examples.md"),
      "updated example",
    );
    const updated = await stageRelease(options);
    const next = JSON.parse(await readFile(join(updated.releaseDir, "manifest.json"), "utf8"));
    expect(
      next.components.find((entry: { id: string }) => entry.id === "agent-runtime").sha256,
    ).not.toBe(component.sha256);
    expect(
      next.components.find((entry: { id: string }) => entry.id === "official-plugins").sha256,
    ).toBe(
      manifest.components.find((entry: { id: string }) => entry.id === "official-plugins").sha256,
    );
  });

  it.each(["SKILL.md", "patterns.md", "examples.md", "entire-pack"])(
    "rejects missing bundled skill asset %s",
    async (missing) => {
      const fixture = await makeStageFixture();
      await rm(
        missing === "entire-pack"
          ? fixture.bundledSkillsDir
          : join(fixture.bundledSkillsDir, "skills/dynamic-workflows", missing),
        { recursive: true },
      );
      await expect(
        stageRelease({ ...fixture, target: "linux-x64", appVersion: "test", archive: false }),
      ).rejects.toThrow(/bundled skill/i);
    },
  );

  async function writeOfficialPluginFixture(
    officialPluginsDir: string,
    name: string,
    options: { mcpEntry?: string; withMcpEntryFile?: boolean; withManifest?: boolean } = {},
  ): Promise<void> {
    const pluginDir = join(officialPluginsDir, name);
    await mkdir(join(pluginDir, ".zcode-plugin"), { recursive: true });
    await writeFile(join(pluginDir, "README.md"), name, "utf8");
    // 真实官方插件的 package.json 都是 tracked 文件，是"该目录属于当前 checkout"的判据。
    await writeFile(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: `@zcode/${name}`, private: true }),
      "utf8",
    );
    const manifest: Record<string, unknown> = {
      name: name.replace(/-plugin$/u, ""),
      version: "0.1.0",
    };
    if (options.mcpEntry) {
      manifest.mcpServers = {
        [name]: { command: "node", args: [`\${ZCODE_PLUGIN_ROOT}/${options.mcpEntry}`] },
      };
      if (options.withMcpEntryFile !== false) {
        const entryPath = join(pluginDir, ...options.mcpEntry.split("/"));
        await mkdir(join(entryPath, ".."), { recursive: true });
        await writeFile(entryPath, "// mcp server\n", "utf8");
      }
    }
    if (options.withManifest !== false) {
      await writeFile(
        join(pluginDir, ".zcode-plugin", "plugin.json"),
        JSON.stringify(manifest),
        "utf8",
      );
    }
  }

  it.each(["absent", "incomplete", "stale"])(
    "stages bundled skills from the agent source when the plugin cache is %s",
    async (cacheState) => {
      const fixture = await makeStageFixture();
      const officialPluginsDir = join(await makeTempDir(), "packages");
      await writeOfficialPluginFixture(officialPluginsDir, "zcode-guide-plugin");
      if (cacheState !== "absent") {
        const cachedPackDir = join(officialPluginsDir, "bundled-skills");
        await mkdir(join(cachedPackDir, "skills/dynamic-workflows"), { recursive: true });
        await writeFile(join(cachedPackDir, "README.md"), "old cached pack");
        const files =
          cacheState === "stale" ? ["SKILL.md", "patterns.md", "examples.md"] : ["SKILL.md"];
        for (const name of files) {
          await writeFile(
            join(cachedPackDir, "skills/dynamic-workflows", name),
            "old cached skill",
          );
        }
      }

      // 冲突整合时两条复制路径曾并存：插件缓存缺文件会拒绝有效技能包，旧缓存会覆盖 Agent 源。
      // 技能包只从 bundledSkillsDir 读取，并只由 agent-runtime 交付。
      const staged = await stageRelease({
        ...fixture,
        target: "linux-x64",
        appVersion: "test",
        archive: false,
        officialPluginsDir,
      });
      const stagedPackDir = join(staged.releaseDir, "runtime/packages/bundled-skills");
      expect(await readFile(join(stagedPackDir, "README.md"), "utf8")).toBe("bundled skills");
      for (const name of ["SKILL.md", "patterns.md", "examples.md"]) {
        expect(await readFile(join(stagedPackDir, "skills/dynamic-workflows", name), "utf8")).toBe(
          `fixture ${name}`,
        );
      }
      // 保留发布白名单：本地临时文件不能进入发行包或组件归档。
      await expect(stat(join(stagedPackDir, "scratch.txt"))).rejects.toThrow();
      const manifest = JSON.parse(
        await readFile(join(staged.releaseDir, "manifest.json"), "utf8"),
      ) as {
        plugins: string[];
        components: Array<{ id: string; paths: string[]; archivePath: string }>;
      };
      expect(manifest.plugins).toEqual(["zcode-guide"]);
      const agentComponent = manifest.components.find((entry) => entry.id === "agent-runtime")!;
      expect(agentComponent.paths).toContain("runtime/packages/bundled-skills");
      const agentExtractDir = await makeTempDir();
      await runTar([
        "-xf",
        join(fixture.outputDir, agentComponent.archivePath),
        "-C",
        agentExtractDir,
      ]);
      expect(
        await readFile(
          join(
            agentExtractDir,
            "runtime/packages/bundled-skills/skills/dynamic-workflows/SKILL.md",
          ),
          "utf8",
        ),
      ).toBe("fixture SKILL.md");
      await expect(
        stat(join(agentExtractDir, "runtime/packages/bundled-skills/scratch.txt")),
      ).rejects.toThrow();
      const pluginComponent = manifest.components.find((entry) => entry.id === "official-plugins")!;
      const pluginExtractDir = await makeTempDir();
      await runTar([
        "-xf",
        join(fixture.outputDir, pluginComponent.archivePath),
        "-C",
        pluginExtractDir,
      ]);
      await expect(
        stat(join(pluginExtractDir, "runtime/packages/zcode-guide-plugin")),
      ).resolves.toBeTruthy();
      await expect(
        stat(join(pluginExtractDir, "runtime/packages/bundled-skills")),
      ).rejects.toThrow();
    },
  );

  it("stages the official plugin set and excludes the on-demand superpowers package", async () => {
    const fixture = await makeStageFixture();
    const officialPluginsDir = join(await makeTempDir(), "packages");
    const pluginNames = [
      "android-emulator-plugin",
      "browser-use-plugin",
      "document-skills-plugin",
      "ios-simulator-plugin",
      "restore-legacy-sessions-plugin",
      "skill-creator-plugin",
      "zcode-guide-plugin",
      "superpowers-plugin",
    ];
    const mcpRuntimePlugins = new Set([
      "android-emulator-plugin",
      "browser-use-plugin",
      "ios-simulator-plugin",
    ]);
    for (const name of pluginNames) {
      await writeOfficialPluginFixture(
        officialPluginsDir,
        name,
        mcpRuntimePlugins.has(name) ? { mcpEntry: "dist/mcp/server.js" } : {},
      );
    }

    const staged = await stageRelease({
      target: "linux-x64",
      appVersion: "9.9.9-test",
      archive: false,
      officialPluginsDir,
      ...fixture,
    });

    for (const name of pluginNames.filter((name) => name !== "superpowers-plugin")) {
      await expect(
        stat(join(staged.releaseDir, "runtime/packages", name, "README.md")),
      ).resolves.toBeTruthy();
    }
    for (const name of mcpRuntimePlugins) {
      await expect(
        stat(join(staged.releaseDir, "runtime/packages", name, "dist/mcp/server.js")),
      ).resolves.toBeTruthy();
    }
    await expect(
      stat(join(staged.releaseDir, "runtime/packages/superpowers-plugin")),
    ).rejects.toThrow();
    const manifest = JSON.parse(
      await readFile(join(staged.releaseDir, "manifest.json"), "utf8"),
    ) as {
      plugins?: string[];
      components?: Array<{ id: string }>;
    };
    expect(manifest.plugins).toEqual([
      "android-emulator",
      "browser-use",
      "document-skills",
      "ios-simulator",
      "restore-legacy-sessions",
      "skill-creator",
      "zcode-guide",
    ]);
    expect(manifest.components?.some((component) => component.id === "official-plugins")).toBe(
      true,
    );
  });

  it.each([true, false])(
    "fails closed on a missing MCP entry with componentArchives=%s",
    async (componentArchives) => {
      // Bug 原因：插件 dist 被 gitignore，干净 CI 工作区里 android-emulator / ios-simulator 没有
      // dist/mcp/server.js；legacy prepare-prebuilds.mjs 曾构建并断言该文件，切到 stageRelease 后只剩
      // 整目录复制，archive 会静默带上只有 plugin.json 与 skills、缺 MCP 入口的插件。staging 必须以
      // plugin.json 的 mcpServers 声明为事实源 fail-closed。
      const fixture = await makeStageFixture();
      const officialPluginsDir = join(await makeTempDir(), "packages");
      await writeOfficialPluginFixture(officialPluginsDir, "android-emulator-plugin", {
        mcpEntry: "dist/mcp/server.js",
        withMcpEntryFile: false,
      });
      await writeOfficialPluginFixture(officialPluginsDir, "zcode-guide-plugin");

      await expect(
        stageRelease({
          target: "linux-x64",
          appVersion: "9.9.9-test",
          archive: false,
          officialPluginsDir,
          componentArchives,
          ...fixture,
        }),
      ).rejects.toThrow(/android-emulator-plugin[\s\S]*dist\/mcp\/server\.js/u);
    },
  );

  it("fails closed when a staged official plugin has no plugin manifest", async () => {
    const fixture = await makeStageFixture();
    const officialPluginsDir = join(await makeTempDir(), "packages");
    await writeOfficialPluginFixture(officialPluginsDir, "ios-simulator-plugin", {
      withManifest: false,
    });

    await expect(
      stageRelease({
        target: "linux-x64",
        appVersion: "9.9.9-test",
        archive: false,
        officialPluginsDir,
        ...fixture,
      }),
    ).rejects.toThrow(/ios-simulator-plugin[\s\S]*plugin\.json/u);
  });

  it("ignores orphaned *-plugin directories left behind by a previous checkout", async () => {
    // Bug 原因：CI 用 GIT_CLEAN_FLAGS "-e node_modules/" 跨 job 保留 node_modules，其它分支
    // （例如曾把 zcode-cua-plugin 改名为 computer-use-plugin 的分支）install 过的插件目录切回本
    // 分支后只剩 node_modules，tracked 文件全被 checkout 删掉。旧规则仅按 "-plugin" 后缀识别官方
    // 插件，会把这种僵尸目录当插件 stage，随后 fail-closed 校验读不到 plugin.json 而整段失败。
    const fixture = await makeStageFixture();
    const officialPluginsDir = join(await makeTempDir(), "packages");
    await writeOfficialPluginFixture(officialPluginsDir, "zcode-guide-plugin");
    const orphanDir = join(officialPluginsDir, "computer-use-plugin");
    await mkdir(join(orphanDir, "node_modules", "@zcode", "computer-use"), { recursive: true });
    await writeFile(
      join(orphanDir, "node_modules", "@zcode", "computer-use", "package.json"),
      "{}",
      "utf8",
    );

    const staged = await stageRelease({
      target: "linux-x64",
      appVersion: "9.9.9-test",
      archive: false,
      officialPluginsDir,
      ...fixture,
    });

    await expect(
      stat(join(staged.releaseDir, "runtime/packages/computer-use-plugin")),
    ).rejects.toThrow();
    const manifest = JSON.parse(
      await readFile(join(staged.releaseDir, "manifest.json"), "utf8"),
    ) as { plugins?: string[] };
    expect(manifest.plugins).toEqual(["zcode-guide"]);
  });

  it("removes stale component archives before restaging a target", async () => {
    const fixture = await makeStageFixture();
    const staleDir = join(fixture.outputDir, "components", "linux-x64");
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, "stale-component.tar.gz"), "stale", "utf8");

    await stageRelease({
      target: "linux-x64",
      appVersion: "9.9.9-test",
      archive: false,
      ...fixture,
    });

    await expect(stat(join(staleDir, "stale-component.tar.gz"))).rejects.toThrow();
  });

  it.each(["linux-x64", "linux-arm64"] as const)(
    "stages an installable full %s archive without standalone components",
    async (target) => {
      const fixture = await makeStageFixture();
      await writeFakePackage(fixture.workspaceNodeModulesDir, "@lydell/node-pty-linux-arm64", {
        version: "1.2.0-beta.10",
        files: {
          "lib/index.js": "// platform node-pty js\n",
          "prebuilds/linux-arm64/pty.node": "linux-arm64-binary",
        },
      });
      const options = { ...fixture, target, appVersion: "9.9.9-test" };
      const original = await stageRelease(options);
      expect(original.componentArchivePaths.length).toBeGreaterThan(0);
      const expected = JSON.parse(
        await readFile(join(original.releaseDir, "manifest.json"), "utf8"),
      );
      for (const component of expected.components) {
        expect(component.archivePath).toBeTruthy();
        delete component.archivePath;
      }

      const staged = await stageRelease({ ...options, componentArchives: false });
      expect(staged.componentArchivePaths).toEqual([]);
      await expect(stat(join(fixture.outputDir, "components", target))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(join(fixture.outputDir, ".components"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const manifest = JSON.parse(await readFile(join(staged.releaseDir, "manifest.json"), "utf8"));
      expect(manifest).toEqual(expected);

      // 用真实整包 installer 验证没有组件 archivePath 仍可安装，且整包摘要校验仍会拒绝错误身份。
      const { ReleaseInstaller } = await import(
        fileURLToPath(new URL("../src/runtime/releaseInstaller.ts", import.meta.url))
      );
      const { resolveServerLayout } = await import(
        fileURLToPath(new URL("../src/runtime/paths.ts", import.meta.url))
      );
      const installer = new ReleaseInstaller(
        resolveServerLayout(join(await makeTempDir(), "server")),
      );
      const archivePath = staged.archivePath!;
      const archiveSha256 = createHash("sha256")
        .update(await readFile(archivePath))
        .digest("hex");
      await expect(
        installer.installArchive({ archivePath, target, archiveSha256: "0".repeat(64) }),
      ).rejects.toThrow(/checksum mismatch/);
      const installed = await installer.installArchive({ archivePath, target, archiveSha256 });
      expect(
        JSON.parse(await readFile(join(installed.releaseDir, "manifest.json"), "utf8")),
      ).toEqual(expected);
      expect(await readFile(join(installed.releaseDir, "runtime", "zcode.cjs"))).toEqual(
        await readFile(fixture.agentBundlePath),
      );
    },
  );
});

it("stages only the target OS keyring binary", () => {
  expect(isTargetSpecificPackage("@napi-rs/keyring-linux-x64-gnu", "linux-x64")).toBe(true);
  expect(isTargetSpecificPackage("@napi-rs/keyring-win32-x64-msvc", "linux-x64")).toBe(false);
  expect(isTargetSpecificPackage("@napi-rs/keyring-linux-arm64-gnu", "linux-x64")).toBe(false);
});
