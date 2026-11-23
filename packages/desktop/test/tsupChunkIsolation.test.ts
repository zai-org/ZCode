import { describe, expect, it } from "vitest";
import tsupConfig, {
  resolvePreinstalledToolsTestBuild,
  resolveBuildPackagedAgentTelemetryEnv,
  resolveBuildRemoteCdnReleaseRoots,
  resolveDesktopTsupBundleSecurityOptions,
} from "../tsup.config";

type EsbuildLikeOptions = {
  chunkNames?: string;
  legalComments?: string;
};

function getChunkNames(configName: string): string | undefined {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const target = configs.find((config) => config.name === configName);
  expect(target).toBeDefined();

  const esbuildOptions: EsbuildLikeOptions = {};
  target?.esbuildOptions?.(esbuildOptions);
  return esbuildOptions.chunkNames;
}

function getExternal(configName: string): string[] {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const target = configs.find((config) => config.name === configName);
  expect(target).toBeDefined();
  expect(Array.isArray(target?.external)).toBe(true);
  return target?.external as string[];
}

function getNoExternal(configName: string): string[] {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const target = configs.find((config) => config.name === configName);
  expect(target).toBeDefined();
  expect(Array.isArray(target?.noExternal)).toBe(true);
  return target?.noExternal as string[];
}

function getDefines(configName: string): Record<string, string> {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const target = configs.find((config) => config.name === configName);
  expect(target).toBeDefined();
  return target?.define ?? {};
}

describe("desktop tsup chunk isolation", () => {
  it("预装清单覆盖只能由显式 E2E 构建开启，运行时变量和 test 后端不构成权限", () => {
    expect(
      resolvePreinstalledToolsTestBuild({
        ZCODE_ENV: "test",
        ZCODE_E2E_PREINSTALLED_TOOLS_CATALOG: "/tmp/fixture.json",
      }),
    ).toBe(false);
    expect(resolvePreinstalledToolsTestBuild({ NODE_ENV: "production" })).toBe(false);
    expect(
      resolvePreinstalledToolsTestBuild({
        NODE_ENV: "production",
        VITE_ZCODE_E2E_STORE_BRIDGE: "1",
      }),
    ).toBe(true);
  });

  it("ZIP 解包器应外置，避免 Electron ESM 启动时动态 require fs 崩溃", () => {
    for (const name of ["main", "host", "scheduler"]) expect(getExternal(name)).toContain("yauzl");
  });
  it("main 构建应将 chunk 输出到 main 子目录，避免覆盖 host 构建产物", () => {
    expect(getChunkNames("main")).toBe("main/chunk-[hash]");
  });

  it("host 构建应将 chunk 输出到 host 子目录，避免覆盖 main 构建产物", () => {
    expect(getChunkNames("host")).toBe("host/chunk-[hash]");
  });

  it("main/host 构建应外置飞书 SDK，避免 Electron ESM 动态 require 崩溃", () => {
    expect(getExternal("main")).toContain("@larksuiteoapi/node-sdk");
    expect(getExternal("host")).toContain("@larksuiteoapi/node-sdk");
  });

  it("main/host 构建应外置 yaml，避免 Electron ESM 动态 require 崩溃", () => {
    expect(getExternal("main")).toContain("yaml");
    expect(getExternal("host")).toContain("yaml");
  });

  it("main/host/scheduler 应内联 CUA producer，安装包不能依赖被排除的 @zcode node_modules", () => {
    for (const configName of ["main", "host", "scheduler"]) {
      expect(getNoExternal(configName)).toContain("@zcode/zcode-cua");
    }
  });

  it("main/host/scheduler 应内联 Provider workspace 包，Electron 不能直接加载 TypeScript 源码", () => {
    for (const configName of ["main", "host", "scheduler"]) {
      expect(getNoExternal(configName)).toContain("@zcode/provider");
      expect(getNoExternal(configName)).toContain("@zcode/provider-node");
    }
  });

  it("生产构建应压缩 main/host/preload 且不生成 sourcemap", () => {
    expect(resolveDesktopTsupBundleSecurityOptions({ NODE_ENV: "production" })).toEqual({
      keepNames: true,
      minify: true,
      sourcemap: false,
    });
  });

  it("开发构建应保留 sourcemap 方便本地调试", () => {
    expect(resolveDesktopTsupBundleSecurityOptions({ NODE_ENV: "development" })).toEqual({
      keepNames: false,
      minify: false,
      sourcemap: true,
    });
  });

  it("E2E coverage 构建应关闭压缩并保留 sourcemap", () => {
    expect(
      resolveDesktopTsupBundleSecurityOptions({
        NODE_ENV: "production",
        ZCODE_E2E_COVERAGE: "1",
      }),
    ).toEqual({
      keepNames: false,
      minify: false,
      sourcemap: true,
    });
  });

  it("remote runtime CDN 根应可由 CI 的 CDN_DOMAIN/OSS_PATH_PREFIX 多值注入", () => {
    expect(
      resolveBuildRemoteCdnReleaseRoots({
        CDN_DOMAIN: "cdn-zcode.z.ai,cdn.zcode-ai.com",
        OSS_PATH_PREFIX: "zcode/electron/releases",
      }),
    ).toEqual([
      "https://cdn-zcode.z.ai/zcode/electron/releases",
      "https://cdn.zcode-ai.com/zcode/electron/releases",
    ]);
  });

  it("remote runtime CDN 根的路径前缀数量不匹配时应失败", () => {
    expect(() =>
      resolveBuildRemoteCdnReleaseRoots({
        CDN_DOMAIN: "cdn-zcode.z.ai,cdn.zcode-ai.com",
        OSS_PATH_PREFIX: "new-prefix,old-prefix,extra-prefix",
      }),
    ).toThrow("OSS_PATH_PREFIX must contain one value or match CDN_DOMAIN count");
  });

  it("正式安装包 Agent OTLP 配置应映射为 Main 使用的标准环境字段", () => {
    expect(
      resolveBuildPackagedAgentTelemetryEnv({
        ZCODE_ENV: "production",
        ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT: "https://arms.example.com/otlp",
        ZCODE_PACKAGED_AGENT_OTEL_HEADERS: "x-arms-license-key=write-only",
        ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME: "zcode-cli-agent",
      }),
    ).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://arms.example.com/otlp",
      OTEL_EXPORTER_OTLP_HEADERS: "x-arms-license-key=write-only",
      OTEL_SERVICE_NAME: "zcode-cli-agent",
      ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION: "packaged",
    });
  });

  it("正式安装包 Agent OTLP 配置不完整或生产环境使用 HTTP 时应阻止构建", () => {
    expect(() =>
      resolveBuildPackagedAgentTelemetryEnv({
        ZCODE_ENV: "production",
        ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT: "https://arms.example.com/otlp",
      }),
    ).toThrow("must be configured together");
    expect(() =>
      resolveBuildPackagedAgentTelemetryEnv({
        ZCODE_ENV: "production",
        ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT: "http://arms.example.com/otlp",
        ZCODE_PACKAGED_AGENT_OTEL_HEADERS: "x-arms-license-key=write-only",
      }),
    ).toThrow("must use HTTPS in production");
  });

  it("release/current 与 Tag 构建缺少 Agent OTLP 配置时应失败，普通开发构建保持 Noop", () => {
    expect(resolveBuildPackagedAgentTelemetryEnv({})).toEqual({});
    expect(() =>
      resolveBuildPackagedAgentTelemetryEnv({
        CI: "true",
        CI_COMMIT_BRANCH: "release/current",
      }),
    ).toThrow("required for release builds");
    expect(() =>
      resolveBuildPackagedAgentTelemetryEnv({
        CI: "true",
        CI_COMMIT_TAG: "v3.6.0",
      }),
    ).toThrow("required for release builds");
  });

  it("安装包身份与后端环境作为两个编译期常量注入每个 bundle", () => {
    // 打包后的应用不能依赖机器环境变量：ZCODE_PREVIEW_IDENTITY 在构建时折叠成 __ZCODE_PRODUCT_FLAVOR__。
    for (const entry of ["main", "host", "preload"] as const) {
      const defines = getDefines(entry);
      expect(defines).toHaveProperty("__ZCODE_ENV__");
      expect(defines).toHaveProperty("__ZCODE_PRODUCT_FLAVOR__");
      expect(['"production"', '"preview"']).toContain(defines.__ZCODE_PRODUCT_FLAVOR__);
    }
  });

  it("Agent OTLP 部署默认值只应编译进 Main bundle", () => {
    expect(getDefines("main")).toHaveProperty("__ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__");
    expect(getDefines("host")).not.toHaveProperty("__ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__");
    expect(getDefines("preload")).not.toHaveProperty("__ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__");
  });

  it("所有 tsup 子构建都应关闭 esbuild legal comments 输出", () => {
    for (const configName of ["main", "host", "preload"]) {
      const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
      const target = configs.find((config) => config.name === configName);
      expect(target).toBeDefined();

      const esbuildOptions: EsbuildLikeOptions = {};
      target?.esbuildOptions?.(esbuildOptions);
      expect(esbuildOptions.legalComments).toBe("none");
    }
  });
});
