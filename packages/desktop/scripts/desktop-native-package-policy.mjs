import { keyringPlatformPackage } from "../../../scripts/stage-credential-keyring.mjs";
const SUPPORTED_DESKTOP_PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];

// sharp 通过 optionalDependencies 分发全平台二进制变体。electron-builder 26.17 的
// pnpm 收集器按 lockfile 全平台图收包，会把 darwin/linux/异架构 win32 变体（Mach-O/ELF，
// 约 110MB 未压缩）全部带进 app.asar：既撑大安装包，又会被 signApp 送进 Windows 签名
// 触发 0x8010006a 连锁失败（2026-10-26 CI 实况，签名钩子已按 PE 魔数跳过）。
// 每个目标平台只保留运行时实际解析的一组变体。
const SHARP_VARIANT_PACKAGES = [
  "sharp-win32-x64",
  "sharp-win32-arm64",
  "sharp-darwin-x64",
  "sharp-darwin-arm64",
  "sharp-libvips-darwin-x64",
  "sharp-libvips-darwin-arm64",
  "sharp-linux-x64",
  "sharp-linux-arm64",
  "sharp-libvips-linux-x64",
  "sharp-libvips-linux-arm64",
  "sharp-linuxmusl-x64",
  "sharp-linuxmusl-arm64",
  "sharp-libvips-linuxmusl-x64",
  "sharp-libvips-linuxmusl-arm64",
];

const SHARP_VARIANTS_BY_PLATFORM = {
  "win32-x64": ["sharp-win32-x64"],
  "win32-arm64": ["sharp-win32-arm64"],
  "darwin-x64": ["sharp-darwin-x64", "sharp-libvips-darwin-x64"],
  "darwin-arm64": ["sharp-darwin-arm64", "sharp-libvips-darwin-arm64"],
  "linux-x64": ["sharp-linux-x64", "sharp-libvips-linux-x64"],
  "linux-arm64": ["sharp-linux-arm64", "sharp-libvips-linux-arm64"],
};

function assertSupportedTargetPlatformKey(targetPlatformKey) {
  if (!SUPPORTED_DESKTOP_PLATFORM_KEYS.includes(targetPlatformKey)) {
    throw new Error(`不支持的桌面目标平台: ${targetPlatformKey}`);
  }
}

export function createDesktopNativePackagePrunePatterns(targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);

  const keyringVariants = [
    "darwin-arm64",
    "darwin-x64",
    "win32-arm64",
    "win32-x64",
    "linux-arm64",
    "linux-x64",
  ].map(keyringPlatformPackage);
  keyringVariants.push(
    "@napi-rs/keyring-linux-arm64-musl",
    "@napi-rs/keyring-linux-x64-musl",
    "@napi-rs/keyring-win32-ia32-msvc",
    "@napi-rs/keyring-freebsd-x64",
    "@napi-rs/keyring-linux-riscv64-gnu",
    "@napi-rs/keyring-linux-arm-gnueabihf",
  );
  return [
    ...keyringVariants
      .filter((name) => name !== keyringPlatformPackage(targetPlatformKey))
      .map((name) => `!node_modules/${name}/**`),
    // PDF 预览已经由 Vite 打进 renderer，pdfjs-dist 的 Canvas optional dependency
    // 只服务 Node 渲染；pnpm 跨平台安装的 8 套 Canvas native 不应带进桌面安装包。
    "!node_modules/@napi-rs/canvas/**",
    "!node_modules/@napi-rs/canvas-*/**",
    // Linux prebuild 会在 beforePack 复制进 node-pty；源平台包本身不属于桌面运行时。
    "!node_modules/@lydell/node-pty-*/**",
    // 桌面运行时统一使用目标 prebuild，禁止把安装机现场编译物或 ABI bin 缓存带进跨平台包。
    "!node_modules/node-pty/build/**",
    "!node_modules/node-pty/bin/**",
    ...SUPPORTED_DESKTOP_PLATFORM_KEYS.filter((key) => key !== targetPlatformKey).map(
      (key) => `!node_modules/node-pty/prebuilds/${key}/**`,
    ),
    // 裁剪非目标平台的 @img/sharp 变体；目标平台变体由下方违规检查兜底确认。
    ...SHARP_VARIANT_PACKAGES.filter(
      (name) => !SHARP_VARIANTS_BY_PLATFORM[targetPlatformKey].includes(name),
    ).map((name) => `!node_modules/@img/${name}/**`),
  ];
}

function normalizeAsarPath(path) {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function parseAsarListWithPackState(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(pack|unpack)\s*:\s*(.+)$/.exec(line);
      if (!match) {
        throw new Error(`无法解析 asar pack state: ${line}`);
      }
      return { packState: match[1], path: normalizeAsarPath(match[2]) };
    });
}

function isNativeRuntimeFile(path, targetPlatformKey) {
  if (/\.(?:node|dll|dylib|exe)$/i.test(path)) return true;
  return path === `/node_modules/node-pty/prebuilds/${targetPlatformKey}/spawn-helper`;
}

export function findDesktopNativePackageViolations(entries, targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);
  const violations = [];

  for (const entry of entries) {
    const { packState, path } = entry;

    if (
      path === "/node_modules/@napi-rs/canvas" ||
      path.startsWith("/node_modules/@napi-rs/canvas/") ||
      path.startsWith("/node_modules/@napi-rs/canvas-")
    ) {
      violations.push(`不应打包 renderer 无需的 Canvas native: ${path}`);
      continue;
    }

    const keyringMatch = /^\/node_modules\/(@napi-rs\/keyring-[a-z0-9-]+)(?:\/|$)/.exec(path);
    if (keyringMatch && keyringMatch[1] !== keyringPlatformPackage(targetPlatformKey)) {
      violations.push(`keyring 包含非目标平台变体: ${keyringMatch[1]}`);
      continue;
    }

    // 裁剪规则漏网或收集器行为回退时，非目标平台的 @img/sharp 变体必须在这里 fail-closed。
    const sharpVariantMatch = /^\/node_modules\/@img\/(sharp-[a-z0-9-]+)(?:\/|$)/.exec(path);
    if (
      sharpVariantMatch &&
      !SHARP_VARIANTS_BY_PLATFORM[targetPlatformKey].includes(sharpVariantMatch[1])
    ) {
      violations.push(`sharp 包含非目标平台变体: ${sharpVariantMatch[1]} ${path}`);
      continue;
    }

    if (path.startsWith("/node_modules/@lydell/node-pty-")) {
      violations.push(`不应打包仅用于准备 prebuild 的平台源包: ${path}`);
      continue;
    }

    if (
      path.startsWith("/node_modules/node-pty/build/") ||
      path.startsWith("/node_modules/node-pty/bin/")
    ) {
      violations.push(`不应打包安装机生成的 node-pty 产物: ${path}`);
      continue;
    }

    const nodePtyPrebuildMatch = /^\/node_modules\/node-pty\/prebuilds\/([^/]+)/.exec(path);
    if (nodePtyPrebuildMatch && nodePtyPrebuildMatch[1] !== targetPlatformKey) {
      violations.push(`node-pty 包含非目标平台 prebuild: ${path}`);
      continue;
    }

    if (isNativeRuntimeFile(path, targetPlatformKey) && packState !== "unpack") {
      violations.push(`native 文件仍作为 packed payload 留在 app.asar: ${path}`);
    }
  }

  return violations;
}
