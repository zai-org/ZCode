import { resolve } from "node:path";

export const supportedTargets = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win-arm64",
  "win-x64",
]);

const supportedTargetSet = new Set(supportedTargets);

export const hostTarget = ({ arch = process.arch, platform = process.platform } = {}) =>
  `${platform === "win32" ? "win" : platform}-${arch}`;

export const normalizeTarget = (target) => {
  const normalized = target.trim().toLowerCase();
  const aliases = {
    "win32-arm64": "win-arm64",
    "win32-x64": "win-x64",
    "windows-arm64": "win-arm64",
    "windows-x64": "win-x64",
  };

  return aliases[normalized] ?? normalized;
};

export const assertSupportedTarget = (target) => {
  if (!supportedTargetSet.has(target)) {
    throw new Error(
      `Unsupported SEA target "${target}". Supported targets: ${supportedTargets.join(", ")}`,
    );
  }
};

export const targetParts = (target) => {
  assertSupportedTarget(target);
  const [releasePlatform, arch] = target.split("-");
  return {
    arch,
    // Keep Windows release artifacts compatible with downstream release downloaders,
    // which request zcode-windows-<arch>.exe while internal target keys stay win/win32.
    outputPlatform: releasePlatform === "win" ? "windows" : releasePlatform,
    releasePlatform,
  };
};

export const outputBinaryName = (target) => {
  const { arch, outputPlatform, releasePlatform } = targetParts(target);
  const extension = releasePlatform === "win" ? ".exe" : "";
  return `zcode-${outputPlatform}-${arch}${extension}`;
};

export const nodeReleaseArtifact = (target, nodeVersion) => {
  const { arch, releasePlatform } = targetParts(target);

  if (releasePlatform === "win") {
    return `${releasePlatform}-${arch}/node.exe`;
  }

  const extension = releasePlatform === "linux" ? "tar.xz" : "tar.gz";
  return `node-v${nodeVersion}-${releasePlatform}-${arch}.${extension}`;
};

export const nodeReleaseUrl = (target, nodeVersion) =>
  new URL(nodeReleaseArtifact(target, nodeVersion), `https://nodejs.org/dist/v${nodeVersion}/`)
    .href;

export const isHostTarget = (target, { arch = process.arch, platform = process.platform } = {}) =>
  normalizeTarget(target) === hostTarget({ arch, platform });

export const postjectArgsForTarget = ({ binaryPath, seaBlob, sentinelFuse, target }) => {
  const { outputPlatform } = targetParts(target);
  const args = [binaryPath, "NODE_SEA_BLOB", seaBlob, "--sentinel-fuse", sentinelFuse];

  if (outputPlatform === "darwin") {
    args.push("--macho-segment-name", "NODE_SEA");
  }

  return args;
};

export const shouldAdHocSignMacTarget = (target, { platform = process.platform } = {}) => {
  const { outputPlatform } = targetParts(target);
  return outputPlatform === "darwin" && platform === "darwin";
};

export const adHocCodesignArgs = (binaryPath) => ["--force", "--sign", "-", binaryPath];

export const parseBuildSeaArgs = (
  argv,
  { hostArch = process.arch, hostPlatform = process.platform } = {},
) => {
  const selectedTargets = [];
  const nodeBinaries = {};
  // 平台参数只筛选，见 apps/zcode-cli/docs/design/v2/sea-cross-target-packaging.md「用户接口」。
  const selectedPlatforms = new Set();
  let includeAll = false;
  let sawTargetSelector = false;
  let help = false;

  const readValue = (arg, index) => {
    if (arg.includes("=")) {
      return {
        nextIndex: index,
        value: arg.slice(arg.indexOf("=") + 1),
      };
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    return {
      nextIndex: index + 1,
      value,
    };
  };

  const addTargetList = (value) => {
    let added = false;
    for (const rawTarget of value.split(",")) {
      const target = normalizeTarget(rawTarget);
      if (!target) continue;

      assertSupportedTarget(target);
      selectedTargets.push(target);
      added = true;
    }

    if (!added) {
      throw new Error("Missing SEA target value");
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--all") {
      sawTargetSelector = true;
      includeAll = true;
      continue;
    }

    if (arg === "--darwin" || arg === "--linux" || arg === "--win") {
      selectedPlatforms.add(arg.slice(2));
      continue;
    }

    if (arg === "--target" || arg.startsWith("--target=")) {
      sawTargetSelector = true;
      const { nextIndex, value } = readValue(arg, index);
      addTargetList(value);
      index = nextIndex;
      continue;
    }

    if (arg === "--targets" || arg.startsWith("--targets=")) {
      sawTargetSelector = true;
      const { nextIndex, value } = readValue(arg, index);
      addTargetList(value);
      index = nextIndex;
      continue;
    }

    if (arg === "--node-binary" || arg.startsWith("--node-binary=")) {
      const { nextIndex, value } = readValue(arg, index);
      const separatorIndex = value.indexOf("=");

      if (separatorIndex <= 0) {
        throw new Error(
          "Expected --node-binary to use <target>=<path>, for example linux-x64=/opt/node/bin/node",
        );
      }

      const target = normalizeTarget(value.slice(0, separatorIndex));
      const binaryPath = value.slice(separatorIndex + 1);
      assertSupportedTarget(target);

      if (!binaryPath) {
        throw new Error(`Missing path for --node-binary ${target}`);
      }

      nodeBinaries[target] = resolve(binaryPath);
      index = nextIndex;
      continue;
    }

    throw new Error(`Unknown option "${arg}". Run with --help for usage.`);
  }

  let targets = [];
  if (includeAll) targets.push(...supportedTargets);

  targets.push(...selectedTargets);

  if (targets.length === 0 && !sawTargetSelector) {
    const nodeBinaryTargets = Object.keys(nodeBinaries);
    if (nodeBinaryTargets.length > 0) targets = nodeBinaryTargets;
    else if (selectedPlatforms.size > 0) targets = [...supportedTargets];
    else targets = [hostTarget({ arch: hostArch, platform: hostPlatform })];
  }

  targets = [...new Set(targets)];
  for (const target of targets) assertSupportedTarget(target);
  if (selectedPlatforms.size > 0) {
    targets = targets.filter((target) => selectedPlatforms.has(targetParts(target).releasePlatform));
    if (targets.length === 0) {
      throw new Error(
        `No SEA target left after ${[...selectedPlatforms].map((platform) => `--${platform}`).join(" ")}.`,
      );
    }
  }

  return {
    help,
    nodeBinaries,
    targets,
  };
};
