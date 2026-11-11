import { describe, expect, it } from "vitest";
import {
  createDesktopNativePackagePrunePatterns,
  findDesktopNativePackageViolations,
  parseAsarListWithPackState,
} from "../scripts/desktop-native-package-policy.mjs";

describe("desktop native package policy", () => {
  it("应裁剪 Canvas、node-pty 安装机产物和所有非目标平台 prebuild", () => {
    const patterns = createDesktopNativePackagePrunePatterns("darwin-arm64");

    expect(patterns).toContain("!node_modules/@napi-rs/canvas/**");
    expect(patterns).toContain("!node_modules/@napi-rs/canvas-*/**");
    expect(patterns).toContain("!node_modules/@lydell/node-pty-*/**");
    expect(patterns).toContain("!node_modules/node-pty/build/**");
    expect(patterns).toContain("!node_modules/node-pty/bin/**");
    expect(patterns).toContain("!node_modules/node-pty/prebuilds/darwin-x64/**");
    expect(patterns).toContain("!node_modules/node-pty/prebuilds/win32-arm64/**");
    expect(patterns).not.toContain("!node_modules/node-pty/prebuilds/darwin-arm64/**");
  });

  it("应接受仅包含目标平台且正确 unpack 的 native 资源", () => {
    const entries = parseAsarListWithPackState(
      [
        "unpack : /node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
        "unpack : /node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
        "pack   : /node_modules/node-pty/package.json",
      ].join("\n"),
    );

    expect(findDesktopNativePackageViolations(entries, "darwin-arm64")).toEqual([]);
  });

  it("应同时拒绝跨平台包、安装机产物和仍留在 asar payload 的 native", () => {
    const entries = parseAsarListWithPackState(
      [
        "pack   : \\node_modules\\@napi-rs\\canvas-win32-x64-msvc\\skia.node",
        "unpack : /node_modules/@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node",
        "unpack : /node_modules/node-pty/build/Release/pty.node",
        "unpack : /node_modules/node-pty/prebuilds/win32-x64/pty.node",
        "pack   : /node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      ].join("\n"),
    );

    expect(findDesktopNativePackageViolations(entries, "darwin-arm64")).toEqual([
      expect.stringContaining("Canvas native"),
      expect.stringContaining("平台源包"),
      expect.stringContaining("安装机生成"),
      expect.stringContaining("非目标平台"),
      expect.stringContaining("packed payload"),
    ]);
  });

  it.each([
    ["win32-x64", ["sharp-win32-x64"]],
    ["win32-arm64", ["sharp-win32-arm64"]],
    ["darwin-arm64", ["sharp-darwin-arm64", "sharp-libvips-darwin-arm64"]],
    ["linux-x64", ["sharp-linux-x64", "sharp-libvips-linux-x64"]],
  ])("应只保留目标平台的 @img/sharp 变体（%s）", (targetPlatformKey, keepVariants) => {
    const patterns = createDesktopNativePackagePrunePatterns(targetPlatformKey);

    for (const keep of keepVariants) {
      expect(patterns).not.toContain(`!node_modules/@img/${keep}/**`);
    }
    // 其余已知全平台变体必须全部裁剪（含跨 OS 与同 OS 异架构）。
    expect(patterns).toContain("!node_modules/@img/sharp-darwin-x64/**");
    expect(patterns).toContain("!node_modules/@img/sharp-linuxmusl-arm64/**");
    expect(patterns).toContain("!node_modules/@img/sharp-libvips-darwin-x64/**");
    // 回归：libvips-linux/linuxmusl 家族曾漏出清单，本地打包靠违规检查兜底拦截过一次。
    expect(patterns).toContain("!node_modules/@img/sharp-libvips-linuxmusl-x64/**");
    expect(patterns).toContain("!node_modules/@img/sharp-libvips-linux-arm64/**");
    if (targetPlatformKey !== "win32-arm64") {
      expect(patterns).toContain("!node_modules/@img/sharp-win32-arm64/**");
    }
    if (targetPlatformKey !== "win32-x64") {
      expect(patterns).toContain("!node_modules/@img/sharp-win32-x64/**");
    }
  });

  it("应把混入包内的非目标平台 sharp 变体判为违规", () => {
    const entries = parseAsarListWithPackState(
      [
        "unpack : /node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node",
        "unpack : /node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips.42.dylib",
        "unpack : /node_modules/@img/sharp-linux-x64/lib/libvips.so.42",
      ].join("\n"),
    );

    expect(findDesktopNativePackageViolations(entries, "win32-x64")).toEqual([
      expect.stringContaining("sharp-libvips-darwin-arm64"),
      expect.stringContaining("sharp-linux-x64"),
    ]);
  });

  it("目标平台的 sharp 变体不判违规且必须 unpack", () => {
    const entries = parseAsarListWithPackState(
      [
        "unpack : /node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node",
        "unpack : /node_modules/@img/sharp-win32-x64/lib/libvips-42.dll",
        "pack   : /node_modules/@img/sharp-win32-x64/package.json",
      ].join("\n"),
    );

    expect(findDesktopNativePackageViolations(entries, "win32-x64")).toEqual([]);
  });
});

it("keyring keeps the target native package and prunes other variants", () => {
  const patterns = createDesktopNativePackagePrunePatterns("linux-arm64");
  expect(patterns).toContain("!node_modules/@napi-rs/keyring-win32-x64-msvc/**");
  expect(patterns).not.toContain("!node_modules/@napi-rs/keyring-linux-arm64-gnu/**");
  expect(
    findDesktopNativePackageViolations(
      [
        {
          packState: "unpack",
          path: "/node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node",
        },
      ],
      "linux-arm64",
    ),
  ).toEqual([expect.stringContaining("keyring")]);
});
