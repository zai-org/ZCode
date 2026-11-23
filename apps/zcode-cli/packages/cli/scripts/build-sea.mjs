import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSpawnRuntimeOptions } from "../../../../../scripts/spawn-command.mjs";
import { resolveDownloadedNodeBinary } from "./sea-node-download.mjs";
import {
  adHocCodesignArgs,
  hostTarget,
  isHostTarget,
  nodeReleaseArtifact,
  nodeReleaseUrl,
  outputBinaryName,
  parseBuildSeaArgs,
  postjectArgsForTarget,
  shouldAdHocSignMacTarget,
  supportedTargets,
  targetParts,
} from "./sea-targets.mjs";
import { removeWindowsAuthenticodeSignature } from "./windows-authenticode.mjs";
import { collectSeaTuiAssets } from "./sea-tui-assets.mjs";
import { collectSeaOfficialPluginAssets } from "./sea-official-plugin-assets.mjs";
import { collectSeaBundledSkillAssets } from "./sea-bundled-skill-assets.mjs";
import { collectSeaRuntimeToolAssets } from "./sea-runtime-tool-assets.mjs";
import { prepareSeaRuntimeToolAssets } from "./sea-runtime-tool-prepare.mjs";
import { collectSeaPlaywrightAssets } from "./sea-playwright-assets.mjs";
import { collectSeaProviderConfigAssets } from "./sea-provider-config-assets.mjs";

export {
  adHocCodesignArgs,
  hostTarget,
  isHostTarget,
  nodeReleaseArtifact,
  nodeReleaseUrl,
  outputBinaryName,
  parseBuildSeaArgs,
  postjectArgsForTarget,
  shouldAdHocSignMacTarget,
  supportedTargets,
};

const usage = `Usage:
  node scripts/build-sea.mjs
  node scripts/build-sea.mjs --target linux-x64 --target win-x64
  node scripts/build-sea.mjs --targets linux-x64,win-x64
  node scripts/build-sea.mjs --all
  node scripts/build-sea.mjs --all --darwin --linux
  node scripts/build-sea.mjs --node-binary linux-x64=/abs/path/node

Platform flags (--darwin, --linux, --win) keep only the targets of those platforms.
\`pnpm build:sea --linux\` appends them after the script's --all.

Supported targets:
  ${supportedTargets.join(", ")}
`;

const root = resolve(import.meta.dirname, "../../..");
const repositoryRoot = resolve(root, "../..");
const cliRoot = resolve(import.meta.dirname, "..");
const dist = resolve(cliRoot, "dist");
const cliBundle = resolve(dist, "zcode.cjs");
const seaBlobForTarget = (target) => resolve(dist, `zcode-${target}.sea.blob`);
const seaConfigForTarget = (target) => resolve(dist, `sea-config-${target}.json`);
const seaAssetStagingForTarget = (target) => resolve(dist, "sea-assets", target);
const nodeCache = resolve(dist, "sea-node-cache");
const sentinelFusePrefix = "NODE_SEA_FUSE_";

export const resolvePostjectBin = ({
  platform = process.platform,
  startDirectory = cliRoot,
} = {}) => {
  const executable = platform === "win32" ? "postject.cmd" : "postject";
  let directory = startDirectory;

  // pnpm hoisted 布局会把 postject 放到仓库根 node_modules，而不是 CLI 子包下。
  // 从 CLI 包目录逐级向上找，避免 SEA 构建依赖某一种安装布局。
  while (true) {
    const candidate = resolve(directory, "node_modules", ".bin", executable);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

const commandText = (command, args) => [command, ...args].join(" ");

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: cliRoot,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
    ...resolveSpawnRuntimeOptions(command),
  });

  if (result.error) {
    throw new Error(`${commandText(command, args)} failed: ${result.error.message}`, {
      cause: result.error,
    });
  }

  if (result.status !== 0) {
    throw new Error(`${commandText(command, args)} failed`);
  }
};

const findSeaFuse = async (binary) => {
  const contents = await readFile(binary, "latin1");
  const match = contents.match(/NODE_SEA_FUSE_[a-z0-9]+:0/i);

  if (!match) {
    throw new Error(
      `Could not find a NODE_SEA_FUSE marker in ${binary}. ` +
        "Use an official Node.js binary with SEA support, or fall back to `pnpm build`.",
    );
  }

  return match[0].replace(/:0$/, "");
};

const resolveNodeBinary = async ({ nodeBinaries, nodeVersion, target }) => {
  const explicitBinary = nodeBinaries[target];

  if (explicitBinary) {
    if (!existsSync(explicitBinary)) {
      throw new Error(`Configured Node.js binary for ${target} does not exist: ${explicitBinary}`);
    }

    console.log(`[sea] using ${target} Node.js binary ${explicitBinary}`);
    return explicitBinary;
  }

  return resolveDownloadedNodeBinary({
    nodeCache,
    nodeVersion,
    target,
  });
};

const prepareSeaBlob = async (target) => {
  const seaBlob = seaBlobForTarget(target);
  const seaConfig = seaConfigForTarget(target);
  await prepareSeaRuntimeToolAssets({
    root: repositoryRoot,
    target,
  });
  const { assets: tuiAssets, manifest: tuiManifest } = await collectSeaTuiAssets({
    root,
    stagingDirectory: seaAssetStagingForTarget(target),
    target,
  });
  const { assets: pluginAssets, manifest: pluginManifest } = await collectSeaOfficialPluginAssets({
    requireRuntime: true,
    root,
    stagingDirectory: seaAssetStagingForTarget(`${target}-official-plugins`),
    target,
  });
  const { assets: bundledSkillAssets, manifest: bundledSkillManifest } =
    await collectSeaBundledSkillAssets({
      root,
      stagingDirectory: seaAssetStagingForTarget(`${target}-bundled-skills`),
    });
  const { assets: runtimeToolAssets, manifest: runtimeToolManifest } =
    await collectSeaRuntimeToolAssets({
      root: repositoryRoot,
      stagingDirectory: seaAssetStagingForTarget(`${target}-runtime-tools`),
      target,
    });
  const { assets: playwrightAssets, manifest: playwrightManifest } =
    await collectSeaPlaywrightAssets({
      root,
      stagingDirectory: seaAssetStagingForTarget(`${target}-playwright`),
      target,
    });
  const providerConfigAssets = await collectSeaProviderConfigAssets({ root: repositoryRoot });

  await writeFile(
    seaConfig,
    JSON.stringify(
      {
        assets: {
          ...tuiAssets,
          ...pluginAssets,
          ...bundledSkillAssets,
          ...runtimeToolAssets,
          ...playwrightAssets,
          ...providerConfigAssets,
        },
        disableExperimentalSEAWarning: true,
        main: "dist/zcode.cjs",
        output: `dist/zcode-${target}.sea.blob`,
        useCodeCache: false,
        useSnapshot: false,
      },
      null,
      2,
    ),
  );

  console.log(
    `[sea] generating SEA blob for ${target} with ${tuiManifest.files.length} TUI assets, ${pluginManifest.plugins.length} official plugins, ${bundledSkillManifest.files.length} bundled skill files, ${runtimeToolManifest.tools.length} runtime tools, and ${playwrightManifest.files.length} Playwright assets`,
  );
  run(process.execPath, ["--experimental-sea-config", seaConfig]);
  return seaBlob;
};

const removeMacSignatureForInjection = (target, binaryPath) => {
  if (!shouldAdHocSignMacTarget(target)) return;

  console.log("[sea] removing macOS signature before injection");
  run("codesign", ["--remove-signature", binaryPath]);
};

const removeWindowsSignatureForInjection = async (target, binaryPath) => {
  const { releasePlatform } = targetParts(target);
  if (releasePlatform !== "win") return;

  // postject invalidates Node's original Authenticode signature; a stale PE
  // Security Directory can make downstream signing reject the SEA as bad Win32.
  const result = await removeWindowsAuthenticodeSignature(binaryPath);
  if (!result.removed) return;

  const action = result.truncated ? "removed and truncated" : "removed";
  console.log(
    `[sea] ${action} Windows Authenticode signature at offset ${result.certificateOffset}`,
  );
};

const adHocSignMacBinary = (target, binaryPath) => {
  if (!shouldAdHocSignMacTarget(target)) return;

  console.log("[sea] ad-hoc signing macOS binary after injection");
  run("codesign", adHocCodesignArgs(binaryPath));
};

const smokeTestHostTarget = async (target, binaryPath) => {
  if (isHostTarget(target)) {
    const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-smoke-"));
    try {
      const env = {
        ...process.env,
        ZCODE_STORAGE_DIR: storageRoot,
      };
      delete env.ZCODE_BFS_BINARY;
      delete env.ZCODE_RG_BINARY;
      delete env.ZCODE_UGREP_BINARY;
      run(binaryPath, ["--version"], {
        env,
      });
    } finally {
      await rm(storageRoot, {
        force: true,
        recursive: true,
      });
    }
    return;
  }

  console.log(`[sea] skipping smoke test for foreign target ${target}`);
};

const buildTarget = async ({ nodeBinaries, nodeVersion, postjectBin, target }) => {
  const binaryPath = resolve(dist, outputBinaryName(target));
  const seaBlob = await prepareSeaBlob(target);
  const targetNodeBinary = await resolveNodeBinary({
    nodeBinaries,
    nodeVersion,
    target,
  });

  console.log(`[sea] building ${target} -> ${binaryPath}`);
  await copyFile(targetNodeBinary, binaryPath);
  await chmod(binaryPath, 0o755);

  const sentinelFuse = await findSeaFuse(binaryPath);
  if (!sentinelFuse.startsWith(sentinelFusePrefix)) {
    throw new Error(`Unexpected SEA fuse marker in ${binaryPath}: ${sentinelFuse}`);
  }

  removeMacSignatureForInjection(target, binaryPath);
  await removeWindowsSignatureForInjection(target, binaryPath);
  run(postjectBin, postjectArgsForTarget({ binaryPath, seaBlob, sentinelFuse, target }));
  adHocSignMacBinary(target, binaryPath);
  await smokeTestHostTarget(target, binaryPath);
  console.log(`[sea] binary written to ${binaryPath}`);
};

export const main = async (argv = process.argv.slice(2)) => {
  const options = parseBuildSeaArgs(argv);

  if (options.help) {
    console.log(usage);
    return;
  }

  if (!existsSync(cliBundle)) {
    throw new Error("Missing dist/zcode.cjs. Run `pnpm build` first.");
  }
  const postjectBin = resolvePostjectBin();
  if (!postjectBin) {
    throw new Error("Missing postject. Run `pnpm install` before `pnpm sea`.");
  }

  const nodeVersion = process.versions.node;
  for (const target of options.targets) {
    await buildTarget({
      nodeBinaries: options.nodeBinaries,
      nodeVersion,
      postjectBin,
      target,
    });
  }
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
