import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import {
  adHocCodesignArgs,
  hostTarget,
  isHostTarget,
  nodeReleaseArtifact,
  nodeReleaseUrl,
  outputBinaryName,
  parseBuildSeaArgs,
  postjectArgsForTarget,
  resolvePostjectBin,
  shouldAdHocSignMacTarget,
  supportedTargets,
} from "../scripts/build-sea.mjs";
import {
  readWindowsAuthenticodeDirectory,
  removeWindowsAuthenticodeSignature,
  removeWindowsAuthenticodeSignatureFromBuffer,
} from "../scripts/windows-authenticode.mjs";
import {
  collectSeaOfficialPluginAssets,
  officialSeaPlugins,
  seaOfficialPluginManifestAssetKey,
} from "../scripts/sea-official-plugin-assets.mjs";
import {
  bundledSkillPackRequiredPaths,
  collectSeaBundledSkillAssets,
  seaBundledSkillAssetPrefix,
  seaBundledSkillManifestAssetKey,
} from "../scripts/sea-bundled-skill-assets.mjs";
import {
  collectSeaTuiAssets,
  opentuiNativePackageForTarget,
  seaTuiAssetPrefix,
} from "../scripts/sea-tui-assets.mjs";
import {
  collectSeaRuntimeToolAssets,
  seaRuntimeToolManifestAssetKey,
} from "../scripts/sea-runtime-tool-assets.mjs";
import {
  prepareSeaRuntimeToolAssets,
  resolveSeaRuntimeToolPreparationPlan,
} from "../scripts/sea-runtime-tool-prepare.mjs";
import { packSourceAsDeterministicTarGzip } from "../../../../../scripts/deterministic-tar-archive.mjs";
import { writeNativeSearchBundleMeta } from "../../../../../scripts/native-search-tools-bundle-meta.mjs";
import { resolveNativeSearchPrebuiltPlan } from "../../../../../scripts/native-search-tools-config.mjs";
import {
  collectSeaPlaywrightAssets,
  seaPlaywrightManifestAssetKey,
} from "../scripts/sea-playwright-assets.mjs";
import {
  collectSeaProviderConfigAssets,
  SEA_ZCODE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY,
} from "../scripts/sea-provider-config-assets.mjs";

const PE_FIXTURE_OFFSET = 0x80;
const PE_SIGNATURE_SIZE = 4;
const COFF_HEADER_SIZE = 20;
const COFF_OPTIONAL_HEADER_SIZE_OFFSET = 16;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const PE32_OPTIONAL_HEADER_SIZE = 0xe0;
const PE32_PLUS_OPTIONAL_HEADER_SIZE = 0xf0;
const PE32_NUMBER_OF_DIRECTORIES_OFFSET = 92;
const PE32_DATA_DIRECTORIES_OFFSET = 96;
const PE32_PLUS_NUMBER_OF_DIRECTORIES_OFFSET = 108;
const PE32_PLUS_DATA_DIRECTORIES_OFFSET = 112;
const SECURITY_DIRECTORY_INDEX = 4;
const DATA_DIRECTORY_ENTRY_SIZE = 8;
const CERTIFICATE_OFFSET = 0x200;
const CERTIFICATE_SIZE = 0x20;
const DATA_DIRECTORY_COUNT = 16;
const PE_SIGNATURE = 0x00004550;
const DOS_MAGIC = 0x5a4d;

test("includes the production ZCode Built-in Provider Config as a SEA asset", async () => {
  const root = fileURLToPath(new URL("../../../../..", import.meta.url));
  const assets = await collectSeaProviderConfigAssets({ root, env: { ZCODE_ENV: "production" } });
  const zcodeBuiltinFilePath = assets[SEA_ZCODE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY];

  assert.ok(zcodeBuiltinFilePath);
  assert.deepEqual(
    JSON.parse(await readFile(zcodeBuiltinFilePath, "utf8")),
    JSON.parse(
      await readFile(
        new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    ),
  );
});

const createMachOExecutableFixture = (label) => {
  const labelBytes = Buffer.from(label);
  const contents = Buffer.alloc(32 + labelBytes.length);
  contents.writeUInt32LE(0xfeedfacf, 0);
  contents.writeUInt32LE(0x0100000c, 4);
  contents.writeUInt32LE(2, 12);
  labelBytes.copy(contents, 32);
  return contents;
};

const createPeFixture = ({ pe32Plus = true, signed = true, trailingBytes = 0 } = {}) => {
  const optionalHeaderSize = pe32Plus ? PE32_PLUS_OPTIONAL_HEADER_SIZE : PE32_OPTIONAL_HEADER_SIZE;
  const magic = pe32Plus ? PE32_PLUS_MAGIC : PE32_MAGIC;
  const dataDirectoriesOffset = pe32Plus
    ? PE32_PLUS_DATA_DIRECTORIES_OFFSET
    : PE32_DATA_DIRECTORIES_OFFSET;
  const numberOfDirectoriesOffset = pe32Plus
    ? PE32_PLUS_NUMBER_OF_DIRECTORIES_OFFSET
    : PE32_NUMBER_OF_DIRECTORIES_OFFSET;
  const optionalHeaderOffset = PE_FIXTURE_OFFSET + PE_SIGNATURE_SIZE + COFF_HEADER_SIZE;
  const securityDirectoryEntryOffset =
    optionalHeaderOffset +
    dataDirectoriesOffset +
    SECURITY_DIRECTORY_INDEX * DATA_DIRECTORY_ENTRY_SIZE;
  const length = signed
    ? CERTIFICATE_OFFSET + CERTIFICATE_SIZE + trailingBytes
    : CERTIFICATE_OFFSET;
  const contents = Buffer.alloc(length);

  contents.writeUInt16LE(DOS_MAGIC, 0);
  contents.writeUInt32LE(PE_FIXTURE_OFFSET, 0x3c);
  contents.writeUInt32LE(PE_SIGNATURE, PE_FIXTURE_OFFSET);
  contents.writeUInt16LE(
    optionalHeaderSize,
    PE_FIXTURE_OFFSET + PE_SIGNATURE_SIZE + COFF_OPTIONAL_HEADER_SIZE_OFFSET,
  );
  contents.writeUInt16LE(magic, optionalHeaderOffset);
  contents.writeUInt32LE(DATA_DIRECTORY_COUNT, optionalHeaderOffset + numberOfDirectoriesOffset);

  if (signed) {
    contents.writeUInt32LE(CERTIFICATE_OFFSET, securityDirectoryEntryOffset);
    contents.writeUInt32LE(CERTIFICATE_SIZE, securityDirectoryEntryOffset + 4);
    contents.fill(0xa5, CERTIFICATE_OFFSET, CERTIFICATE_OFFSET + CERTIFICATE_SIZE);
  }

  return {
    contents,
    securityDirectoryEntryOffset,
  };
};

test("defaults SEA target to the current host platform and arch", () => {
  assert.deepEqual(
    parseBuildSeaArgs([], {
      hostArch: "arm64",
      hostPlatform: "darwin",
    }),
    {
      help: false,
      nodeBinaries: {},
      targets: ["darwin-arm64"],
    },
  );
});

test("keeps package SEA build scripts aligned with the existing all-target contract", async () => {
  const cliPackage = JSON.parse(
    await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
  );
  const cliWorkspacePackage = JSON.parse(
    await readFile(join(import.meta.dirname, "..", "..", "..", "package.json"), "utf8"),
  );
  const rootPackage = JSON.parse(
    await readFile(join(import.meta.dirname, "..", "..", "..", "..", "..", "package.json"), "utf8"),
  );

  assert.equal(
    cliPackage.scripts["build:sea"],
    "pnpm --dir ../../../.. build:sea:prepare && node scripts/build-sea.mjs --all",
  );
  assert.equal(cliPackage.scripts["build:sea:all"], undefined);
  assert.equal(cliWorkspacePackage.scripts["build:sea"], "pnpm --filter @zcode/cli build:sea");
  assert.equal(cliWorkspacePackage.scripts["build:sea:all"], undefined);
  assert.equal(rootPackage.scripts["build:sea"], "pnpm --dir apps/zcode-cli build:sea");
  assert.equal(
    rootPackage.scripts["build:sea:all"],
    "pnpm install && pnpm --dir apps/zcode-cli build:sea",
  );
});

test("parses repeated and comma-separated SEA targets", () => {
  const parsed = parseBuildSeaArgs([
    "--",
    "--target",
    "linux-x64",
    "--targets=win-x64,darwin-x64",
    "--target",
    "linux-x64",
  ]);

  assert.deepEqual(parsed.targets, ["linux-x64", "win-x64", "darwin-x64"]);
});

test("parses all supported SEA targets", () => {
  assert.deepEqual(parseBuildSeaArgs(["--all"]).targets, supportedTargets);
});

test("uses node-binary targets when no explicit target selector is provided", () => {
  // Windows 会按宿主路径规则解析 binary 路径，不能硬编码 POSIX 绝对路径作为预期。
  const linuxBinary = join(tmpdir(), "node binaries", "linux", "node");
  const windowsBinary = join(tmpdir(), "node binaries", "win", "node.exe");
  const parsed = parseBuildSeaArgs([
    "--node-binary",
    `linux-x64=${linuxBinary}`,
    `--node-binary=win32-x64=${windowsBinary}`,
  ]);

  assert.deepEqual(parsed.targets, ["linux-x64", "win-x64"]);
  assert.equal(parsed.nodeBinaries["linux-x64"], linuxBinary);
  assert.equal(parsed.nodeBinaries["win-x64"], windowsBinary);
});

test("rejects unsupported SEA targets", () => {
  assert.throws(
    () => parseBuildSeaArgs(["--target", "linux-s390x"]),
    /Unsupported SEA target "linux-s390x"/,
  );
});

test("rejects empty SEA target selectors", () => {
  assert.throws(() => parseBuildSeaArgs(["--target="]), /Missing SEA target value/);
});

test("maps SEA targets to output binary names", () => {
  assert.equal(outputBinaryName("darwin-arm64"), "zcode-darwin-arm64");
  assert.equal(outputBinaryName("linux-x64"), "zcode-linux-x64");
  assert.equal(outputBinaryName("win-arm64"), "zcode-windows-arm64.exe");
  assert.equal(outputBinaryName("win-x64"), "zcode-windows-x64.exe");
});

test("prepares every SEA target in the desktop bundled-tools layout", () => {
  assert.deepEqual(
    supportedTargets.map((target) => {
      const plan = resolveSeaRuntimeToolPreparationPlan({ root: "/repo", target });
      return [target, plan.platformKey, plan.enabled];
    }),
    [
      ["darwin-arm64", "darwin-arm64", true],
      ["darwin-x64", "darwin-x64", true],
      ["linux-arm64", "linux-arm64", true],
      ["linux-x64", "linux-x64", true],
      ["win-arm64", "win32-arm64", true],
      ["win-x64", "win32-x64", true],
    ],
  );
});

test("downloads the complete SEA runtime tool set before asset collection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-runtime-prepare-"));
  const archives = new Map();
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    const archivePath = archives.get(request.url ?? "");
    if (!archivePath) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/gzip" });
    createReadStream(archivePath).pipe(response);
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const nativeBaseUrl = `${baseUrl}/native`;
    const env = {
      NATIVE_SEARCH_RIPGREP_DOWNLOAD_BASE_URL: `${baseUrl}/microsoft-ripgrep`,
      NATIVE_SEARCH_TOOLS_DOWNLOAD_BASE_URL: nativeBaseUrl,
    };
    const outputDir = join(directory, "root/packages/desktop/bundled-tools/darwin-arm64");
    const nativePlan = resolveNativeSearchPrebuiltPlan({
      platform: "darwin",
      arch: "arm64",
      outputDir,
      env,
    });
    const fixtures = nativePlan.artifacts.map((artifact) => ({
      artifact,
      binaryName: artifact.binaryName,
      downloadUrl: artifact.downloadUrl,
      contents: createMachOExecutableFixture(`${artifact.toolId}-fixture`),
      toolId: artifact.toolId,
    }));

    for (const [index, fixture] of fixtures.entries()) {
      if (fixture.artifact.source === "official") {
        await mkdir(dirname(fixture.artifact.binaryPath), { recursive: true });
        await writeFile(fixture.artifact.binaryPath, fixture.contents);
        await chmod(fixture.artifact.binaryPath, 0o755);
        writeNativeSearchBundleMeta(fixture.artifact, nativePlan.platformKey);
        continue;
      }
      const sourcePath = join(directory, `source-${index}`, fixture.binaryName);
      const archivePath = join(directory, `archive-${index}.tar.gz`);
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, fixture.contents);
      await chmod(sourcePath, 0o755);
      packSourceAsDeterministicTarGzip(sourcePath, archivePath);
      fixture.artifact.archiveSha256 = createHash("sha256")
        .update(await readFile(archivePath))
        .digest("hex");
      archives.set(new URL(fixture.downloadUrl).pathname, archivePath);
    }

    await prepareSeaRuntimeToolAssets({
      root: join(directory, "root"),
      target: "darwin-arm64",
      env,
      prebuiltPlan: nativePlan,
    });
    const fixtureByToolId = new Map(fixtures.map((fixture) => [fixture.toolId, fixture.contents]));
    assert.deepEqual(await readFile(nativePlan.bfsPath), fixtureByToolId.get("bfs"));
    assert.deepEqual(await readFile(nativePlan.ugrepPath), fixtureByToolId.get("ugrep"));
    assert.deepEqual(await readFile(nativePlan.rgPath), fixtureByToolId.get("ripgrep"));
    assert.equal(requestCount, 2);
  } finally {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
    });
    await rm(directory, { force: true, recursive: true });
  }
});

test("maps SEA targets to OpenTUI native package names", () => {
  assert.equal(opentuiNativePackageForTarget("darwin-arm64"), "@mbears/opentui-core-darwin-arm64");
  assert.equal(opentuiNativePackageForTarget("linux-x64"), "@mbears/opentui-core-linux-x64");
  assert.equal(opentuiNativePackageForTarget("win-arm64"), "@mbears/opentui-core-win32-arm64");
  assert.equal(opentuiNativePackageForTarget("win-x64"), "@mbears/opentui-core-win32-x64");
});

for (const fixture of [
  {
    expectedTools: [
      ["bfs", "4.1.1", "bfs"],
      ["ripgrep", "14.1.1", "rg"],
      ["ugrep", "7.8.4", "ugrep"],
    ],
    platformKey: "darwin-arm64",
    target: "darwin-arm64",
  },
  {
    expectedTools: [
      ["bfs", "4.1.1", "bfs"],
      ["ripgrep", "14.1.1", "rg"],
      ["ugrep", "7.8.4", "ugrep"],
    ],
    platformKey: "darwin-x64",
    target: "darwin-x64",
  },
  {
    expectedTools: [
      ["bfs", "4.1.1", "bfs"],
      ["ripgrep", "14.1.1", "rg"],
      ["ugrep", "7.8.4", "ugrep"],
    ],
    platformKey: "linux-arm64",
    target: "linux-arm64",
  },
  {
    expectedTools: [
      ["bfs", "4.1.1", "bfs"],
      ["ripgrep", "14.1.1", "rg"],
      ["ugrep", "7.8.4", "ugrep"],
    ],
    platformKey: "linux-x64",
    target: "linux-x64",
  },
  {
    expectedTools: [
      ["ripgrep", "14.1.1", "rg.exe"],
      ["ugrep", "7.8.4", "ugrep.exe"],
    ],
    platformKey: "win32-arm64",
    target: "win-arm64",
  },
  {
    expectedTools: [
      ["ripgrep", "14.1.1", "rg.exe"],
      ["ugrep", "7.8.4", "ugrep.exe"],
    ],
    platformKey: "win32-x64",
    target: "win-x64",
  },
]) {
  test(`includes target runtime tools for ${fixture.target}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-sea-runtime-tools-"));
    const root = join(directory, "root");
    const stagingDirectory = join(directory, "staging");

    try {
      for (const [toolId, , binaryName] of fixture.expectedTools) {
        await writeTestFile(
          root,
          `packages/desktop/bundled-tools/${fixture.platformKey}/${toolId}/${binaryName}`,
          `${fixture.target}:${toolId}`,
        );
      }
      // SEA 内嵌原生工具的许可声明与来源清单；材料取自仓库登记，fixture 根目录需带上同一份。
      const repositoryRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
      await cp(
        join(repositoryRoot, "third-party/native-search"),
        join(root, "third-party/native-search"),
        { recursive: true },
      );

      const { assets, manifest } = await collectSeaRuntimeToolAssets({
        root,
        stagingDirectory,
        target: fixture.target,
      });

      assert.deepEqual(
        manifest.tools.map(({ id, version, binaryName }) => [id, version, binaryName]),
        fixture.expectedTools,
      );
      assert.equal(typeof assets[seaRuntimeToolManifestAssetKey], "string");
      for (const tool of manifest.tools) {
        const expectedBytes = Buffer.from(`${fixture.target}:${tool.id}`);
        assert.equal(tool.size, expectedBytes.byteLength);
        assert.equal(tool.sha256, createHash("sha256").update(expectedBytes).digest("hex"));
        const assetKey = `zcode-runtime-tools/${tool.id}/${tool.sha256}/${tool.binaryName}`;
        assert.equal(assets[assetKey].endsWith(tool.binaryName), true);
      }
      const notices = await readFile(assets["zcode-runtime-tools/THIRD-PARTY-NOTICES.txt"], "utf8");
      assert.ok(notices.startsWith("NATIVE SEARCH THIRD-PARTY NOTICES"));
      assert.deepEqual(
        await readFile(assets["zcode-runtime-tools/SOURCES.json"]),
        await readFile(join(root, "third-party/native-search/sources.json")),
      );
    } finally {
      await rm(directory, {
        force: true,
        recursive: true,
      });
    }
  });
}

test("fails SEA packaging when a target runtime tool is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-runtime-tools-missing-"));

  try {
    await assert.rejects(
      collectSeaRuntimeToolAssets({
        root: directory,
        stagingDirectory: join(directory, "staging"),
        target: "darwin-arm64",
      }),
      /Missing SEA runtime tool bfs for darwin-arm64/,
    );
  } finally {
    await rm(directory, {
      force: true,
      recursive: true,
    });
  }
});

test("includes TUI workspace runtime package assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-tui-assets-"));
  const root = join(import.meta.dirname, "../../..");

  try {
    const { manifest, assets } = await collectSeaTuiAssets({
      root,
      stagingDirectory: directory,
      target: "linux-x64",
    });
    const paths = new Set(manifest.files.map((file) => file.path));

    // SEA 从缓存目录导入 TUI 时无法回退到 workspace 链接，运行时 workspace
    // 依赖必须和第三方依赖一样完整进入 node_modules 形状的资产闭包。
    assert.equal(paths.has("node_modules/@zcode/tui/package.json"), true);
    assert.equal(paths.has("node_modules/@zcode/tui/dist/index.js"), true);
    assert.equal(paths.has("node_modules/@zcode/i18n/package.json"), true);
    assert.equal(paths.has("node_modules/@zcode/i18n/dist/index.js"), true);
    assert.equal(paths.has("node_modules/@zcode/contracts/package.json"), true);
    assert.equal(paths.has("node_modules/@zcode/contracts/dist/index.js"), true);
    assert.equal(paths.has("node_modules/@zcode/shared/package.json"), true);
    assert.equal(paths.has("node_modules/@zcode/shared/dist/index.js"), true);
    assert.equal(
      paths.has("node_modules/@zcode/shared/dist/workspace-hook-trust-store-file.js"),
      true,
    );
    assert.equal(paths.has("node_modules/@zcode/i18n/src/index.ts"), false);
    assert.equal(paths.has("node_modules/@zcode/contracts/src/index.ts"), false);
    assert.equal(paths.has("node_modules/@zcode/shared/src/index.ts"), false);
    // session-control 只有子路径导出，没有 dist/index.js，仍须随 shared 打入 SEA。
    assert.equal(paths.has("node_modules/@zcode/session-control/dist/contract.js"), true);
    const zodPackages = manifest.files.filter((file) => file.path.endsWith("/zod/package.json"));
    const zodVersions = await Promise.all(
      zodPackages.map(async (file) => {
        const metadata = JSON.parse(
          await readFile(assets[`${seaTuiAssetPrefix}${file.path}`], "utf8"),
        );
        return metadata.version.split(".")[0];
      }),
    );
    assert.deepEqual([...new Set(zodVersions)].sort(), ["3", "4"]);
    // 根 workspace 的源码 exports 不能原样进入只包含 dist 的 SEA runtime。
    for (const packageName of ["@zcode/shared", "@zcode/model-option-map"]) {
      const assetKey = `${seaTuiAssetPrefix}node_modules/${packageName}/package.json`;
      const stagedPackage = JSON.parse(await readFile(assets[assetKey], "utf8"));
      assert.equal(stagedPackage.exports["."], "./dist/index.js");
      const sourcePackage = JSON.parse(
        await readFile(
          join(root, "../..", "packages", packageName.split("/")[1], "package.json"),
          "utf8",
        ),
      );
      assert.equal(sourcePackage.exports["."], "./src/index.ts");
    }
  } finally {
    await rm(directory, {
      force: true,
      recursive: true,
    });
  }
});

test("loads TUI from an extracted SEA runtime dependency closure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-tui-runtime-"));
  const root = join(import.meta.dirname, "../../..");
  const stagingDirectory = join(directory, "staging");
  const runtimeDirectory = join(directory, "runtime");

  try {
    const { assets, manifest } = await collectSeaTuiAssets({
      root,
      stagingDirectory,
      target: hostTarget(),
    });

    for (const file of manifest.files) {
      const sourcePath = assets[`${seaTuiAssetPrefix}${file.path}`];
      assert.equal(typeof sourcePath, "string");
      const outputPath = join(runtimeDirectory, file.path);
      await mkdir(dirname(outputPath), {
        recursive: true,
      });
      await copyFile(sourcePath, outputPath);
    }

    // Windows 锁定进程已加载的 opentui.dll；子进程退出释放 DLL 后，父进程才能清理目录。
    const entryUrl = pathToFileURL(
      join(runtimeDirectory, "node_modules/@zcode/tui/dist/index.js"),
    ).href;
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import assert from "node:assert/strict"; const tui = await import(process.argv[1]); assert.equal(typeof tui.runTui, "function");',
        entryUrl,
      ],
      { cwd: runtimeDirectory, timeout: 30000 },
    );
  } finally {
    await rm(directory, {
      force: true,
      recursive: true,
    });
  }
});

test("includes the pinned Playwright runtime required by headless Browser Use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-playwright-assets-"));
  const root = join(import.meta.dirname, "../../..");

  try {
    const { assets, manifest } = await collectSeaPlaywrightAssets({
      root,
      stagingDirectory: directory,
      target: "linux-x64",
    });
    const paths = new Set(manifest.files.map((file) => file.path));

    assert.equal(manifest.packageVersion, "1.59.1");
    assert.equal(typeof assets[seaPlaywrightManifestAssetKey], "string");
    assert.equal(paths.has("node_modules/playwright-core/package.json"), true);
    assert.equal(paths.has("node_modules/playwright-core/index.js"), true);
    assert.equal(paths.has("node_modules/playwright-core/lib/server/browserType.js"), true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps the Browser Use SEA release at 0.5.1 with complete runtime assets", async () => {
  const root = join(import.meta.dirname, "../../..");
  const browserUsePlugin = officialSeaPlugins.find((plugin) => plugin.name === "browser-use");
  assert.equal(browserUsePlugin?.version, "0.5.1");
  assert.deepEqual(browserUsePlugin?.requiredRuntimePaths, [
    "scripts/browser-client.mjs",
    "docs/api.json",
    "docs/documents.json",
    "docs/overview.md",
    "docs/recording.md",
    "docs/workflow.md",
    "skills/control-browser/SKILL.md",
    "skills/web-gui-tester/SKILL.md",
  ]);
  const packageJson = JSON.parse(
    await readFile(join(root, browserUsePlugin.rootPath, "package.json"), "utf8"),
  );
  const pluginManifest = JSON.parse(
    await readFile(join(root, browserUsePlugin.rootPath, ".zcode-plugin", "plugin.json"), "utf8"),
  );
  assert.deepEqual(
    {
      manifest: pluginManifest.version,
      package: packageJson.version,
      sea: browserUsePlugin.version,
    },
    {
      manifest: "0.5.1",
      package: "0.5.1",
      sea: "0.5.1",
    },
  );
  // Bug 原因：新增录屏能力时重写了整段插件描述，并把原生 WebM 误写成 MP4。
  assert.equal(
    pluginManifest.description,
    "Built-in browser automation runtime and guidance for Desktop IAB and explicitly enabled CLI-managed headless CDP: open, navigate, inspect, click, type, screenshot, record workspace WebM videos, and verify web pages and local dev targets.",
  );
});

test("includes bundled official plugin assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-plugin-assets-"));
  const root = join(import.meta.dirname, "../../..");

  try {
    const { assets, manifest } = await collectSeaOfficialPluginAssets({
      root,
      stagingDirectory: directory,
    });
    const iosPlugin = manifest.plugins.find((item) => item.name === "ios-simulator");
    const androidPlugin = manifest.plugins.find((item) => item.name === "android-emulator");
    const browserUsePlugin = manifest.plugins.find((item) => item.name === "browser-use");
    const documentPlugin = manifest.plugins.find((item) => item.name === "documents");
    const restorePlugin = manifest.plugins.find((item) => item.name === "restore-legacy-sessions");
    const skillCreatorPlugin = manifest.plugins.find((item) => item.name === "skill-creator");
    const zcodeGuidePlugin = manifest.plugins.find((item) => item.name === "zcode-guide");
    const iosPaths = new Set(iosPlugin?.files.map((file) => file.path));
    const androidPaths = new Set(androidPlugin?.files.map((file) => file.path));
    const browserUsePaths = new Set(browserUsePlugin?.files.map((file) => file.path));
    const documentPaths = new Set(
      manifest.plugins
        .filter((plugin) =>
          ["documents", "pdf", "presentations", "spreadsheets"].includes(plugin.name),
        )
        .flatMap((plugin) => plugin.files.map((file) => file.path)),
    );
    const restorePaths = new Set(restorePlugin?.files.map((file) => file.path));
    const skillCreatorPaths = new Set(skillCreatorPlugin?.files.map((file) => file.path));
    const zcodeGuidePaths = new Set(zcodeGuidePlugin?.files.map((file) => file.path));

    assert.equal(typeof assets[seaOfficialPluginManifestAssetKey], "string");
    assert.equal(iosPlugin?.marketplace, "zcode-plugins-official");
    assert.equal(androidPlugin?.marketplace, "zcode-plugins-official");
    assert.equal(browserUsePlugin?.marketplace, "zcode-plugins-official");
    assert.equal(documentPlugin?.marketplace, "zcode-plugins-official");
    assert.equal(restorePlugin?.marketplace, "zcode-plugins-official");
    assert.equal(skillCreatorPlugin?.marketplace, "zcode-plugins-official");
    assert.equal(zcodeGuidePlugin?.marketplace, "zcode-plugins-official");
    // superpowers 已从内置 SEA 清单移除，断言它不再出现在 manifest 里。
    assert.equal(
      manifest.plugins.some((item) => item.name === "superpowers"),
      false,
    );
    assert.equal(iosPaths.has(".zcode-plugin/plugin.json"), true);
    assert.equal(iosPaths.has("commands/ios-dev.md"), true);
    assert.equal(iosPaths.has("skills/ios-dev/SKILL.md"), true);
    assert.equal(iosPaths.has("src/mcp/server.ts"), false);
    assert.equal(androidPaths.has(".zcode-plugin/plugin.json"), true);
    assert.equal(androidPaths.has("commands/android-dev.md"), true);
    assert.equal(androidPaths.has("skills/android-dev/SKILL.md"), true);
    assert.equal(androidPaths.has("skills/android-dev/scripts/setup-windows.ps1"), false);
    assert.equal(androidPaths.has("src/mcp/server.ts"), false);
    assert.equal(browserUsePaths.has(".zcode-plugin/plugin.json"), true);
    assert.equal(browserUsePaths.has("skills/control-browser/SKILL.md"), true);
    assert.equal(browserUsePaths.has("skills/web-gui-tester/SKILL.md"), true);
    assert.equal(browserUsePaths.has("docs/api.json"), true);
    assert.equal(browserUsePaths.has("docs/documents.json"), true);
    assert.equal(browserUsePaths.has("docs/overview.md"), true);
    assert.equal(browserUsePaths.has("docs/workflow.md"), true);
    // 宿主产物已搬到独立的 node-repl-host seed 单元；browser-use 不再携带它。
    assert.equal(browserUsePaths.has("dist/mcp/server.js"), false);
    const hostPlugin = manifest.plugins.find((item) => item.name === "node-repl-host");
    assert.ok(hostPlugin, "the shared node_repl host must be embedded");
    assert.equal(
      new Set(hostPlugin.files.map((file) => file.path)).has("dist/mcp/server.js"),
      true,
    );
    assert.equal(browserUsePaths.has("scripts/browser-client.mjs"), true);
    // CUA 的 client 只有一份，属于 computer-use 插件；browser-use 不再镜像它。
    assert.equal(browserUsePaths.has("scripts/computer-use-client.mjs"), false);
    // CUA 的文档同理：唯一那份属于 computer-use 插件。
    assert.equal(browserUsePaths.has("docs/computer-use.md"), false);
    assert.equal(documentPaths.has(".zcode-plugin/plugin.json"), true);
    assert.equal(documentPaths.has("skills/docx/SKILL.md"), true);
    assert.equal(documentPaths.has("skills/docx-viewer/SKILL.md"), true);
    assert.equal(documentPaths.has("skills/pdf/SKILL.md"), true);
    assert.equal(documentPaths.has("skills/pdf/scripts/pdf.py"), true);
    assert.equal(documentPaths.has("skills/pptx/SKILL.md"), true);
    assert.equal(documentPaths.has("agents/visual-judge.md"), true);
    assert.equal(documentPaths.has("skills/pptx/scripts/general_judge.py"), false);
    assert.equal(documentPaths.has("skills/xlsx/SKILL.md"), true);
    assert.equal(documentPaths.has("skills/xlsx/xlsx.py"), true);
    assert.equal(
      [...documentPaths].some((path) =>
        /(?:^|\/)(?:\.venv|__pycache__|\.DS_Store)(?:\/|$)/u.test(path),
      ),
      false,
    );
    assert.equal(restorePaths.has(".zcode-plugin/plugin.json"), true);
    assert.equal(restorePaths.has("commands/restore-legacy-sessions.md"), true);
    assert.equal(restorePaths.has("skills/restore-legacy-sessions/SKILL.md"), true);
    assert.equal(
      restorePaths.has("skills/restore-legacy-sessions/scripts/scan-legacy-sessions.mjs"),
      true,
    );
    assert.equal(
      restorePaths.has("skills/restore-legacy-sessions/scripts/restore-conversation.mjs"),
      true,
    );
    assert.equal(restorePaths.has("dist/mcp/server.js"), false);
    assert.equal(skillCreatorPaths.has(".zcode-plugin/plugin.json"), true);
    assert.equal(skillCreatorPaths.has("skills/skill-creator/SKILL.md"), true);
    assert.equal(zcodeGuidePaths.has(".zcode-plugin/plugin.json"), true);
    assert.equal(zcodeGuidePaths.has("skills/zcode-configuration-guide/SKILL.md"), true);
    assert.equal(zcodeGuidePaths.has("skills/diagnosing-mcp/SKILL.md"), true);
    assert.equal(zcodeGuidePaths.has("skills/diagnosing-skills/SKILL.md"), true);
    assert.equal(zcodeGuidePaths.has("skills/diagnosing-commands/SKILL.md"), true);
    assert.equal(zcodeGuidePaths.has("skills/diagnosing-hooks/SKILL.md"), true);
    assert.equal(zcodeGuidePaths.has("skills/diagnosing-plugins/SKILL.md"), true);
    // 0.3.0：/workflow 与 dynamic-workflows 不再随 zcode-guide 发布（见 bundled skill pack 用例）。
    assert.equal(zcodeGuidePaths.has("commands/workflow.md"), false);
    assert.equal(zcodeGuidePaths.has("skills/dynamic-workflows/SKILL.md"), false);
    // design：技能、规则、脚本、hook 与全量设计资源都要进 SEA；包内 test/ 与 .claude-plugin/ 清单不进。
    const designPlugin = manifest.plugins.find((item) => item.name === "design");
    const designPaths = new Set(designPlugin?.files.map((file) => file.path));
    assert.equal(designPlugin?.marketplace, "zcode-plugins-official");
    for (const path of [
      ".zcode-plugin/plugin.json",
      "skills/design/SKILL.md",
      "skills/design/references/output.md",
      "skills/design/scripts/design-lint.mjs",
      "skills/design/scripts/design-tokens.mjs",
      "skills/design/design-resources/NOTICE.md",
      "skills/design/design-resources/LICENSE.md",
      "hooks/hooks.json",
      "hooks/run-hook.cmd",
      "hooks/design-rules",
    ])
      assert.equal(designPaths.has(path), true, `design SEA asset missing ${path}`);
    assert.equal(
      [...designPaths].some(
        (path) => path.startsWith("test/") || path.startsWith(".claude-plugin/"),
      ),
      false,
    );
  } finally {
    await rm(directory, {
      force: true,
      recursive: true,
    });
  }
});

test("includes the bundled skill pack as content-hashed SEA assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-bundled-skill-assets-"));
  const root = join(import.meta.dirname, "../../..");

  try {
    const { assets, manifest } = await collectSeaBundledSkillAssets({
      root,
      stagingDirectory: directory,
    });
    const paths = new Set(manifest.files.map((file) => file.path));

    assert.equal(manifest.version, 1);
    assert.match(manifest.hash, /^[0-9a-f]{64}$/u);
    assert.equal(typeof assets[seaBundledSkillManifestAssetKey], "string");
    for (const requiredPath of bundledSkillPackRequiredPaths) {
      assert.equal(paths.has(requiredPath), true, requiredPath);
      assert.equal(typeof assets[`${seaBundledSkillAssetPrefix}${requiredPath}`], "string");
    }
    // 资产只来自 skills/：README 之类的包元数据不进二进制。
    assert.equal(
      [...paths].every((path) => path.startsWith("skills/")),
      true,
    );
    for (const file of manifest.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/u);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects a bundled skill pack that lost a required file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-bundled-skill-incomplete-"));
  const root = join(directory, "root");

  try {
    await writeTestFile(root, "packages/bundled-skills/skills/dynamic-workflows/SKILL.md", "# s");
    await writeTestFile(root, "packages/bundled-skills/skills/dynamic-workflows/patterns.md", "#");
    await assert.rejects(
      collectSeaBundledSkillAssets({ root, stagingDirectory: join(directory, "staging") }),
      /Missing bundled skill pack required asset/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("allows skill-only official plugins when SEA runtime assets are required", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-plugin-runtime-assets-"));
  const root = join(directory, "root");
  const stagingDirectory = join(directory, "staging");

  try {
    await writeVisualizePluginFixture(root);
    await writeTestFile(root, "packages/android-emulator-plugin/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(root, "packages/android-emulator-plugin/dist/mcp/server.js", "");
    await writeTestFile(root, "packages/node-repl-host/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(root, "packages/node-repl-host/dist/mcp/server.js", "");
    await writeTestFile(root, "packages/browser-use-plugin/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(root, "packages/browser-use-plugin/skills/control-browser/SKILL.md", "");
    await writeTestFile(root, "packages/browser-use-plugin/skills/web-gui-tester/SKILL.md", "");
    await writeTestFile(root, "packages/browser-use-plugin/docs/api.json", "{}");
    await writeTestFile(root, "packages/browser-use-plugin/docs/documents.json", "[]");
    await writeTestFile(root, "packages/browser-use-plugin/docs/overview.md", "");
    await writeTestFile(root, "packages/browser-use-plugin/docs/recording.md", "");
    await writeTestFile(root, "packages/browser-use-plugin/docs/workflow.md", "");
    await writeTestFile(root, "packages/browser-use-plugin/scripts/browser-client.mjs", "");
    await writeDocumentPluginFixtures(root);
    await writeTestFile(root, "packages/ios-simulator-plugin/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(root, "packages/ios-simulator-plugin/dist/mcp/server.js", "");
    await writeTestFile(
      root,
      "packages/restore-legacy-sessions-plugin/.zcode-plugin/plugin.json",
      "{}",
    );
    await writeTestFile(
      root,
      "packages/restore-legacy-sessions-plugin/skills/restore-legacy-sessions/SKILL.md",
      "",
    );
    await writeTestFile(root, "packages/skill-creator-plugin/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(root, "packages/skill-creator-plugin/skills/skill-creator/SKILL.md", "");
    // 新增官方内容插件后也要提供 fixture，否则采集会先报 manifest 缺失，无法验证免运行时资源。
    await writeTestFile(root, "packages/plugin-creator-plugin/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(root, "packages/plugin-creator-plugin/skills/plugin-creator/SKILL.md", "");
    // skill-creator 用作「带可执行 hook 的 skill-only 官方插件」载体（原先由 superpowers 覆盖）。
    // collector 按 officialSeaPlugins 登记 + 伪造目录采集，真实 skill-creator 是否带 hook 无关紧要。
    await writeTestFile(root, "packages/skill-creator-plugin/hooks/hooks.json", "{}");
    await writeTestFile(root, "packages/skill-creator-plugin/hooks/run-hook.cmd", "");
    await writeTestFile(root, "packages/zcode-guide-plugin/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(
      root,
      "packages/zcode-guide-plugin/skills/zcode-configuration-guide/SKILL.md",
      "",
    );
    await writeTestFile(root, "packages/zcode-site-plugin/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(root, "packages/zcode-site-plugin/scripts/zcode-site.mjs", "");
    await writeTestFile(root, "packages/zcode-site-plugin/skills/site-deploy/SKILL.md", "");
    await writeTestFile(root, "packages/zcode-site-plugin/scripts/stage.mjs", "");
    await writeTestFile(root, "packages/zcode-site-plugin/scripts/errors.mjs", "");
    // 0.4.0 起带 Sites 面板：插件自己构建的 server 与面板页面是必需运行时产物。
    await writeTestFile(root, "packages/zcode-site-plugin/dist/server.mjs", "");
    await writeTestFile(root, "packages/zcode-site-plugin/dist/ui/panel.html", "");
    // design 是带 hook 的纯内容型插件：requiresRuntime:false，只需 seed 必需文件。
    const designPlugin = officialSeaPlugins.find((plugin) => plugin.name === "design");
    await writeTestFile(root, "packages/design-plugin/.zcode-plugin/plugin.json", "{}");
    for (const seedPath of designPlugin?.requiredSeedPaths ?? [])
      await writeTestFile(root, join("packages/design-plugin", seedPath), "");

    const { manifest } = await collectSeaOfficialPluginAssets({
      requireRuntime: true,
      root,
      stagingDirectory,
    });
    const documentPlugin = manifest.plugins.find((item) => item.name === "documents");
    const browserUsePlugin = manifest.plugins.find((item) => item.name === "browser-use");
    const restorePlugin = manifest.plugins.find((item) => item.name === "restore-legacy-sessions");
    const skillCreatorPlugin = manifest.plugins.find((item) => item.name === "skill-creator");
    const pluginCreatorPlugin = manifest.plugins.find((item) => item.name === "plugin-creator");
    const designSeaPlugin = manifest.plugins.find((item) => item.name === "design");
    assert.equal(
      designSeaPlugin?.files.find((file) => file.path === "hooks/design-rules")?.mode,
      0o755,
    );
    assert.equal(
      designSeaPlugin?.files.some((file) => file.path === "dist/mcp/server.js"),
      false,
    );
    const documentPaths = new Set(
      manifest.plugins
        .filter((plugin) =>
          ["documents", "pdf", "presentations", "spreadsheets"].includes(plugin.name),
        )
        .flatMap((plugin) => plugin.files.map((file) => file.path)),
    );
    const browserUsePaths = new Set(browserUsePlugin?.files.map((file) => file.path));
    const restorePaths = new Set(restorePlugin?.files.map((file) => file.path));
    const skillCreatorPaths = new Set(skillCreatorPlugin?.files.map((file) => file.path));
    const skillCreatorRunHook = skillCreatorPlugin?.files.find(
      (file) => file.path === "hooks/run-hook.cmd",
    );

    assert.ok(pluginCreatorPlugin);
    assert.equal(
      pluginCreatorPlugin.files.some((file) => file.path === "skills/plugin-creator/SKILL.md"),
      true,
    );
    assert.equal(
      pluginCreatorPlugin.files.some((file) => file.path === "dist/mcp/server.js"),
      false,
    );

    assert.equal(documentPaths.has("skills/docx/SKILL.md"), true);
    assert.equal(documentPaths.has("skills/pdf/SKILL.md"), true);
    assert.equal(documentPaths.has("skills/pptx/SKILL.md"), true);
    assert.equal(documentPaths.has("dist/mcp/server.js"), false);
    assert.equal(browserUsePaths.has("skills/control-browser/SKILL.md"), true);
    assert.equal(browserUsePaths.has("skills/web-gui-tester/SKILL.md"), true);
    assert.equal(browserUsePaths.has("docs/api.json"), true);
    assert.equal(browserUsePaths.has("docs/overview.md"), true);
    assert.equal(browserUsePaths.has("docs/workflow.md"), true);
    // 宿主产物已搬到独立的 node-repl-host seed 单元；browser-use 不再携带它。
    assert.equal(browserUsePaths.has("dist/mcp/server.js"), false);
    const hostPlugin = manifest.plugins.find((item) => item.name === "node-repl-host");
    assert.ok(hostPlugin, "the shared node_repl host must be embedded");
    assert.equal(
      new Set(hostPlugin.files.map((file) => file.path)).has("dist/mcp/server.js"),
      true,
    );
    assert.equal(browserUsePaths.has("scripts/browser-client.mjs"), true);
    // CUA 的 client 只有一份，属于 computer-use 插件；browser-use 不再镜像它。
    assert.equal(browserUsePaths.has("scripts/computer-use-client.mjs"), false);
    // CUA 的文档同理：唯一那份属于 computer-use 插件。
    assert.equal(browserUsePaths.has("docs/computer-use.md"), false);
    assert.equal(restorePaths.has("skills/restore-legacy-sessions/SKILL.md"), true);
    assert.equal(restorePaths.has("dist/mcp/server.js"), false);
    assert.equal(skillCreatorPaths.has("skills/skill-creator/SKILL.md"), true);
    assert.equal(skillCreatorPaths.has("hooks/hooks.json"), true);
    assert.equal(skillCreatorPaths.has("hooks/run-hook.cmd"), true);
    assert.equal(skillCreatorRunHook?.mode, 0o755);
    assert.equal(skillCreatorPaths.has("dist/mcp/server.js"), false);
  } finally {
    await rm(directory, {
      force: true,
      recursive: true,
    });
  }
});

test("requires SEA runtime assets for runtime-backed official plugins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-plugin-missing-runtime-"));
  const root = join(directory, "root");
  const stagingDirectory = join(directory, "staging");

  try {
    await writeVisualizePluginFixture(root);
    await writeTestFile(root, "packages/android-emulator-plugin/.zcode-plugin/plugin.json", "{}");
    // 宿主要先齐备，这条测试隔离的是 android-emulator 缺 runtime 这一种情况。
    await writeTestFile(root, "packages/node-repl-host/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(root, "packages/node-repl-host/dist/mcp/server.js", "");
    await writeTestFile(root, "packages/browser-use-plugin/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(root, "packages/documents-plugin/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(root, "packages/ios-simulator-plugin/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(root, "packages/ios-simulator-plugin/dist/mcp/server.js", "");
    await writeTestFile(
      root,
      "packages/restore-legacy-sessions-plugin/.zcode-plugin/plugin.json",
      "{}",
    );
    await writeTestFile(root, "packages/skill-creator-plugin/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(root, "packages/zcode-guide-plugin/.zcode-plugin/plugin.json", "{}");

    await assert.rejects(
      collectSeaOfficialPluginAssets({
        requireRuntime: true,
        root,
        stagingDirectory,
      }),
      /Missing android-emulator MCP runtime/,
    );
  } finally {
    await rm(directory, {
      force: true,
      recursive: true,
    });
  }
});

test("requires the Browser Use client alongside the SEA MCP runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-browser-client-missing-"));
  const root = join(directory, "root");
  const stagingDirectory = join(directory, "staging");

  try {
    await writeVisualizePluginFixture(root);
    for (const pluginName of [
      "android-emulator-plugin",
      "browser-use-plugin",
      "documents-plugin",
      "ios-simulator-plugin",
      "restore-legacy-sessions-plugin",
      "skill-creator-plugin",
      "zcode-guide-plugin",
    ]) {
      await writeTestFile(root, `packages/${pluginName}/.zcode-plugin/plugin.json`, "{}");
    }
    await writeTestFile(root, "packages/android-emulator-plugin/dist/mcp/server.js", "");
    await writeTestFile(root, "packages/node-repl-host/.zcode-plugin/plugin.json", "{}");
    await writeTestFile(root, "packages/node-repl-host/dist/mcp/server.js", "");
    await writeDocumentPluginFixtures(root);
    await writeTestFile(root, "packages/ios-simulator-plugin/dist/mcp/server.js", "");

    await assert.rejects(
      collectSeaOfficialPluginAssets({
        requireRuntime: true,
        root,
        stagingDirectory,
      }),
      /Missing browser-use runtime asset.*browser-client\.mjs/u,
    );
  } finally {
    await rm(directory, {
      force: true,
      recursive: true,
    });
  }
});

test("maps SEA targets to Node.js release artifacts and URLs", () => {
  assert.equal(nodeReleaseArtifact("darwin-arm64", "24.14.0"), "node-v24.14.0-darwin-arm64.tar.gz");
  assert.equal(nodeReleaseArtifact("linux-x64", "24.14.0"), "node-v24.14.0-linux-x64.tar.xz");
  assert.equal(nodeReleaseArtifact("win-arm64", "24.14.0"), "win-arm64/node.exe");
  assert.equal(nodeReleaseArtifact("win-x64", "24.14.0"), "win-x64/node.exe");
  assert.equal(
    nodeReleaseUrl("win-arm64", "24.14.0"),
    "https://nodejs.org/dist/v24.14.0/win-arm64/node.exe",
  );
  assert.equal(
    nodeReleaseUrl("win-x64", "24.14.0"),
    "https://nodejs.org/dist/v24.14.0/win-x64/node.exe",
  );
});

async function writeTestFile(root, relativePath, contents) {
  const filePath = join(root, relativePath);
  await mkdir(dirname(filePath), {
    recursive: true,
  });
  await writeFile(filePath, contents);
}

test("adds the Mach-O segment argument only for macOS targets", () => {
  assert.deepEqual(
    postjectArgsForTarget({
      binaryPath: "/tmp/zcode-darwin-arm64",
      seaBlob: "/tmp/zcode.sea.blob",
      sentinelFuse: "NODE_SEA_FUSE_test",
      target: "darwin-arm64",
    }),
    [
      "/tmp/zcode-darwin-arm64",
      "NODE_SEA_BLOB",
      "/tmp/zcode.sea.blob",
      "--sentinel-fuse",
      "NODE_SEA_FUSE_test",
      "--macho-segment-name",
      "NODE_SEA",
    ],
  );

  assert.deepEqual(
    postjectArgsForTarget({
      binaryPath: "/tmp/zcode-linux-x64",
      seaBlob: "/tmp/zcode.sea.blob",
      sentinelFuse: "NODE_SEA_FUSE_test",
      target: "linux-x64",
    }),
    [
      "/tmp/zcode-linux-x64",
      "NODE_SEA_BLOB",
      "/tmp/zcode.sea.blob",
      "--sentinel-fuse",
      "NODE_SEA_FUSE_test",
    ],
  );
});

test("ad-hoc signs only macOS targets built on macOS hosts", () => {
  assert.deepEqual(adHocCodesignArgs("/tmp/zcode-darwin-arm64"), [
    "--force",
    "--sign",
    "-",
    "/tmp/zcode-darwin-arm64",
  ]);

  assert.equal(shouldAdHocSignMacTarget("darwin-arm64", { platform: "darwin" }), true);
  assert.equal(shouldAdHocSignMacTarget("darwin-x64", { platform: "darwin" }), true);
  assert.equal(shouldAdHocSignMacTarget("linux-x64", { platform: "darwin" }), false);
  assert.equal(shouldAdHocSignMacTarget("win-x64", { platform: "darwin" }), false);
  assert.equal(shouldAdHocSignMacTarget("darwin-arm64", { platform: "linux" }), false);
});

test("resolves postject from a hoisted ancestor node_modules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-postject-"));
  const cliDirectory = join(directory, "apps", "zcode-cli", "packages", "cli");
  const binDirectory = join(directory, "node_modules", ".bin");
  const postjectPath = join(binDirectory, "postject");

  try {
    await mkdir(cliDirectory, { recursive: true });
    await mkdir(binDirectory, { recursive: true });
    await writeFile(postjectPath, "");

    assert.equal(
      resolvePostjectBin({
        platform: "linux",
        startDirectory: cliDirectory,
      }),
      postjectPath,
    );
  } finally {
    await rm(directory, {
      force: true,
      recursive: true,
    });
  }
});

test("removes and truncates a trailing Windows Authenticode certificate table", () => {
  const { contents, securityDirectoryEntryOffset } = createPeFixture();
  const result = removeWindowsAuthenticodeSignatureFromBuffer(contents);

  assert.equal(result.removed, true);
  assert.equal(result.truncated, true);
  assert.equal(result.certificateOffset, CERTIFICATE_OFFSET);
  assert.equal(result.certificateSize, CERTIFICATE_SIZE);
  assert.equal(result.buffer.length, CERTIFICATE_OFFSET);
  assert.equal(result.buffer.readUInt32LE(securityDirectoryEntryOffset), 0);
  assert.equal(result.buffer.readUInt32LE(securityDirectoryEntryOffset + 4), 0);
  assert.deepEqual(readWindowsAuthenticodeDirectory(result.buffer), {
    certificateOffset: 0,
    certificateSize: 0,
    securityDirectoryEntryOffset,
    signed: false,
  });
});

test("removes a PE32 Authenticode directory without truncating non-certificate trailing data", () => {
  const trailingBytes = 16;
  const { contents, securityDirectoryEntryOffset } = createPeFixture({
    pe32Plus: false,
    trailingBytes,
  });
  const result = removeWindowsAuthenticodeSignatureFromBuffer(contents);

  assert.equal(result.removed, true);
  assert.equal(result.truncated, false);
  assert.equal(result.buffer.length, CERTIFICATE_OFFSET + CERTIFICATE_SIZE + trailingBytes);
  assert.equal(result.buffer.readUInt32LE(securityDirectoryEntryOffset), 0);
  assert.equal(result.buffer.readUInt32LE(securityDirectoryEntryOffset + 4), 0);
});

test("leaves unsigned Windows PE binaries unchanged", () => {
  const { contents } = createPeFixture({
    signed: false,
  });
  const result = removeWindowsAuthenticodeSignatureFromBuffer(contents);

  assert.equal(result.removed, false);
  assert.equal(result.truncated, false);
  assert.equal(result.buffer, contents);
});

test("rejects Windows Authenticode directories outside the file range", () => {
  const { contents, securityDirectoryEntryOffset } = createPeFixture();
  contents.writeUInt32LE(contents.length + CERTIFICATE_SIZE, securityDirectoryEntryOffset);

  assert.throws(
    () => removeWindowsAuthenticodeSignatureFromBuffer(contents),
    /Invalid PE certificate table/,
  );
});

test("removes Windows Authenticode signatures from files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-authenticode-"));
  const binaryPath = join(directory, "zcode-windows-x64.exe");
  const { contents, securityDirectoryEntryOffset } = createPeFixture();

  try {
    await writeFile(binaryPath, contents);
    const result = await removeWindowsAuthenticodeSignature(binaryPath);
    const updated = await readFile(binaryPath);

    assert.deepEqual(result, {
      certificateOffset: CERTIFICATE_OFFSET,
      certificateSize: CERTIFICATE_SIZE,
      removed: true,
      truncated: true,
    });
    assert.equal(updated.length, CERTIFICATE_OFFSET);
    assert.equal(updated.readUInt32LE(securityDirectoryEntryOffset), 0);
    assert.equal(updated.readUInt32LE(securityDirectoryEntryOffset + 4), 0);
  } finally {
    await rm(directory, {
      force: true,
      recursive: true,
    });
  }
});

test("matches host targets using Node.js platform names", () => {
  assert.equal(
    hostTarget({
      arch: "x64",
      platform: "win32",
    }),
    "win-x64",
  );
  assert.equal(
    isHostTarget("win32-x64", {
      arch: "x64",
      platform: "win32",
    }),
    true,
  );
  assert.equal(
    isHostTarget("linux-x64", {
      arch: "arm64",
      platform: "darwin",
    }),
    false,
  );
});

test("builds SEA dependencies from the root workspace graph", async () => {
  const repositoryRoot = new URL("../../../../../", import.meta.url);
  const rootPackage = JSON.parse(await readFile(new URL("package.json", repositoryRoot), "utf8"));
  const filters = [...rootPackage.scripts["build:sea:prepare"].matchAll(/--filter=("[^"]+"|\S+)/gu)]
    .map((match) => match[1].replaceAll('"', ""))
    .flatMap((filter) => ["--filter", filter]);

  // 回归原因：CLI 子 workspace 的 Turbo 图看不到根 session-control，build:sea 不会生成其 dist。
  const result = spawnSync("pnpm", [...filters, "list", "--depth", "-1", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const names = JSON.parse(result.stdout).map((pkg) => pkg.name);
  assert.ok(names.includes("@zcode/session-control"));
  assert.ok(!names.includes("@zcode/cli"));
});

test("can be dynamically imported when argv[1] is missing", () => {
  const scriptUrl = new URL("../scripts/build-sea.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(scriptUrl)}).then((m) => console.log(m.outputBinaryName("win-x64")))`,
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "zcode-windows-x64.exe");
});

async function writeDocumentPluginFixtures(root) {
  for (const [name, skill] of [
    ["documents", "docx"],
    ["pdf", "pdf"],
    ["presentations", "pptx"],
    ["spreadsheets", "xlsx"],
  ]) {
    await writeTestFile(root, `packages/${name}-plugin/.zcode-plugin/plugin.json`, "{}");
    await writeTestFile(root, `packages/${name}-plugin/agents/visual-judge.md`, "");
    await writeTestFile(root, `packages/${name}-plugin/skills/${skill}/SKILL.md`, "");
    // 0.2.0 起文档插件带查看面板：viewer skill 与 office-runtime 构建产物都是必需资产。
    await writeTestFile(root, `packages/${name}-plugin/skills/${skill}-viewer/SKILL.md`, "");
    for (const runtimePath of ["dist/server.mjs", "dist/ui/assets.json", "dist/ui/panel.html"]) {
      await writeTestFile(root, `packages/${name}-plugin/${runtimePath}`, "");
    }
  }
  await writeTestFile(root, "packages/image-search-plugin/.zcode-plugin/plugin.json", "{}");
  await writeTestFile(root, "packages/image-search-plugin/.mcp.json", "{}");
}

async function writeVisualizePluginFixture(root) {
  // 官方清单新增静态插件后，运行时缺失用例也必须先准备其内容，避免提前失败。
  const plugin = officialSeaPlugins.find((item) => item.name === "visualize");
  assert.ok(plugin);
  await writeTestFile(root, "packages/visualize-plugin/.zcode-plugin/plugin.json", "{}");
  for (const path of plugin.requiredSeedPaths) {
    await writeTestFile(root, `packages/visualize-plugin/${path}`, "");
  }
}
