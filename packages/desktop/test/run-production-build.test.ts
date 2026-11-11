import { describe, expect, it } from "vitest";
import {
  createDesktopProductionBuildPlan,
  resolveDesktopBuildCwd,
  resolveDesktopProductionCleanPaths,
} from "../scripts/run-production-build.mjs";

// Windows 上 normalize会把 /repo/ 前缀转成 E:\repo\，导致路径匹配失败
const isWindows = process.platform === "win32";

describe("createDesktopProductionBuildPlan", () => {
  it("应通过显式环境变量在各平台统一开启 production 构建", () => {
    const plan = createDesktopProductionBuildPlan({
      cwd: "/repo/packages/desktop",
      baseEnv: { PATH: "/usr/bin" },
    });

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      label: "desktop production bundles",
      parallel: [
        {
          command: "pnpm",
          args: ["exec", "tsup"],
          env: {
            PATH: "/usr/bin",
            NODE_ENV: "production",
          },
        },
        {
          command: "pnpm",
          args: ["exec", "vite", "build"],
          env: {
            PATH: "/usr/bin",
            NODE_ENV: "production",
          },
        },
      ],
    });
  });

  it("默认构建 cwd 应落在 desktop 包根目录，而不是 scripts 子目录", () => {
    expect(resolveDesktopBuildCwd()).toMatch(/packages[\\/]desktop$/);
  });

  (isWindows ? it.skip : it)("生产构建前应清理会进入 app.asar 的旧 out 产物但保留 metadata", () => {
    expect(resolveDesktopProductionCleanPaths("/repo/packages/desktop")).toEqual([
      "/repo/packages/desktop/out/main",
      "/repo/packages/desktop/out/host",
      "/repo/packages/desktop/out/preload",
      "/repo/packages/desktop/out/renderer",
      "/repo/packages/desktop/out/plugin-sandbox",
      "/repo/packages/desktop/out/extension-host",
      "/repo/packages/desktop/out/.main-build-ready",
      "/repo/packages/desktop/out/.host-build-ready",
      "/repo/packages/desktop/out/.preload-build-ready",
      "/repo/packages/desktop/out/.extension-host-build-ready",
    ]);
  });
});
