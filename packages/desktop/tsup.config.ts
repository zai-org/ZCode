import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { resolveDesktopProductFlavor } from "./scripts/desktop-product-identity.mjs";
const { copyGenUiRuntimeAssets } = await import(
  pathToFileURL(resolve(import.meta.dirname, "scripts/gen-ui-runtime-assets.mjs")).href
);
// tsup 会先打包配置文件；动态加载构建工具，避免其 import.meta.dirname 被重定位到 desktop。
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);
const { resolveBuildTimeConfig, createBuildTimeConfigDefines } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/build-time-config.mjs")).href
);
// 构建期可选能力（ARMS、事件上报、自动更新），见 docs/desktop/build-time-optional-capabilities.md
const buildTimeConfigDefines = createBuildTimeConfigDefines(
  await resolveBuildTimeConfig(process.env),
);

const buildMetadata = getBuildMetadata();

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

// 手动加载 .env 文件，tsup 不像 Vite 会自动读取 .env.*；这些文件只提供链接常量。
function loadEnvFiles(): Record<string, string> {
  const vars: Record<string, string> = {};
  const files = ["../../.env"];
  if (process.env.NODE_ENV === "production") {
    files.push("../../.env.production");
  } else {
    files.push("../../.env.development", "../../.env.development.local");
  }
  for (const file of files) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2];
      }
    }
  }
  // 真实环境变量优先级最高
  if (process.env.ZCODE_ENV) vars.ZCODE_ENV = process.env.ZCODE_ENV;
  if (process.env.ZCODE_BASE_URL) vars.ZCODE_BASE_URL = process.env.ZCODE_BASE_URL;
  if (process.env.VITE_ZCODE_BASE_URL) vars.VITE_ZCODE_BASE_URL = process.env.VITE_ZCODE_BASE_URL;
  // OAuth origin/client_id 由 host runtime 读取；这里保留覆盖入口，方便开发构建时观察统一 env 来源。
  if (process.env.ZAI_OAUTH_CLIENT_ID) vars.ZAI_OAUTH_CLIENT_ID = process.env.ZAI_OAUTH_CLIENT_ID;
  if (process.env.ZAI_OAUTH_ORIGIN) vars.ZAI_OAUTH_ORIGIN = process.env.ZAI_OAUTH_ORIGIN;
  if (process.env.ZAI_BUSINESS_BASE_URL) {
    vars.ZAI_BUSINESS_BASE_URL = process.env.ZAI_BUSINESS_BASE_URL;
  }
  if (process.env.ZAI_BUSINESS_LOGIN_URL) {
    vars.ZAI_BUSINESS_LOGIN_URL = process.env.ZAI_BUSINESS_LOGIN_URL;
  }
  if (process.env.CDN_DOMAIN) vars.CDN_DOMAIN = process.env.CDN_DOMAIN;
  if (process.env.OSS_PATH_PREFIX) vars.OSS_PATH_PREFIX = process.env.OSS_PATH_PREFIX;
  if (process.env.VITE_ZAI_OAUTH_CLIENT_ID) {
    vars.VITE_ZAI_OAUTH_CLIENT_ID = process.env.VITE_ZAI_OAUTH_CLIENT_ID;
  }
  if (process.env.VITE_ZAI_OAUTH_ORIGIN) {
    vars.VITE_ZAI_OAUTH_ORIGIN = process.env.VITE_ZAI_OAUTH_ORIGIN;
  }
  return vars;
}

const env = loadEnvFiles();
const { environment: zcodeEnv } = await loadBuiltinProviderConfig();
// 安装包身份与后端环境分轴：ZCODE_PREVIEW_IDENTITY=1 让生产后端的构建仍以 ZCode Preview 身份打包运行。
const zcodeProductFlavor = resolveDesktopProductFlavor({ ...process.env, ZCODE_ENV: zcodeEnv });
console.log(`[tsup] ZCODE_ENV=${zcodeEnv} ZCODE_PRODUCT_FLAVOR=${zcodeProductFlavor}`);

function parseCsvEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveBuildRemoteCdnReleaseRoots(runtimeEnv: Record<string, string | undefined>) {
  const domains = parseCsvEnv(runtimeEnv.CDN_DOMAIN);
  const pathPrefixes = parseCsvEnv(runtimeEnv.OSS_PATH_PREFIX || "zcode/electron/releases");
  if (domains.length === 0) {
    return [];
  }
  if (pathPrefixes.length !== 1 && pathPrefixes.length !== domains.length) {
    throw new Error(
      `OSS_PATH_PREFIX must contain one value or match CDN_DOMAIN count (${domains.length}), got ${pathPrefixes.length}`,
    );
  }

  return domains.map((domain, index) => {
    const pathPrefix = pathPrefixes.length === 1 ? pathPrefixes[0] : pathPrefixes[index];
    return `https://${domain}/${pathPrefix}`.replace(/\/+$/, "");
  });
}

export function resolveBuildPackagedAgentTelemetryEnv(
  runtimeEnv: Record<string, string | undefined>,
): Record<string, string> {
  const endpoint = runtimeEnv.ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT?.trim();
  const headers = runtimeEnv.ZCODE_PACKAGED_AGENT_OTEL_HEADERS?.trim();
  const serviceName =
    runtimeEnv.ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME?.trim() || "zcode-cli-agent";

  if (!endpoint && !headers) {
    if (
      runtimeEnv.CI &&
      (runtimeEnv.CI_COMMIT_TAG || runtimeEnv.CI_COMMIT_BRANCH === "release/current")
    ) {
      throw new Error("Packaged Agent OTLP configuration is required for release builds");
    }
    return {};
  }
  if (!endpoint || !headers) {
    throw new Error(
      "ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT and ZCODE_PACKAGED_AGENT_OTEL_HEADERS must be configured together",
    );
  }
  if (endpoint.length > 2_048) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT exceeds 2048 characters");
  }
  if (headers.length > 8_192 || /[\r\n]/u.test(headers)) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_HEADERS is invalid");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(serviceName)) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME is invalid");
  }

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT must be a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsedEndpoint.protocol) ||
    parsedEndpoint.username ||
    parsedEndpoint.password
  ) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT must be a valid HTTP(S) URL");
  }
  if (
    resolveZCodeEnv(runtimeEnv.ZCODE_ENV) === "production" &&
    parsedEndpoint.protocol !== "https:"
  ) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT must use HTTPS in production");
  }

  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: parsedEndpoint.toString(),
    OTEL_EXPORTER_OTLP_HEADERS: headers,
    OTEL_SERVICE_NAME: serviceName,
    // 只有打进正式 Desktop 安装包的 Agent 才能由构建链可信判定为 packaged；
    // source/development_bundle 不在运行时猜测，未显式注入时保持 unknown。
    ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION: "packaged",
  };
}

export function resolveDesktopTsupBundleSecurityOptions(
  runtimeEnv: Record<string, string | undefined> = process.env,
) {
  const isProduction = runtimeEnv.NODE_ENV === "production";
  const isE2ECoverageBuild = runtimeEnv.ZCODE_E2E_COVERAGE === "1";
  return {
    // 发布包的 main/host/preload 之前没有随 NODE_ENV=production 压缩，
    // 产物保留大量源码注释与格式化换行，增加逆向和内部实现暴露风险。
    keepNames: isProduction && !isE2ECoverageBuild,
    minify: isProduction && !isE2ECoverageBuild,
    // 生产包不随包发布 sourcemap，继续生成 sourceMappingURL 会暴露无效映射路径。
    // E2E coverage build 只会进入隔离 app cache，需要保留 map 才能把 V8 bundle range
    // 还原到 TypeScript 源码；正常发布构建仍保持无 sourcemap。
    sourcemap: isE2ECoverageBuild || !isProduction,
  };
}

type DesktopTsupEsbuildOptions = {
  chunkNames?: string;
  legalComments?: "none" | "inline" | "eof" | "linked" | "external";
};

export function applyDesktopTsupEsbuildSecurityOptions(options: DesktopTsupEsbuildOptions) {
  // 生产压缩时 esbuild 默认可能保留 license/legal 注释，
  // 发布包不应在 main/host/preload 里留下源码注释或 sourcemap 入口注释。
  options.legalComments = "none";
}

const desktopTsupBundleSecurityOptions = resolveDesktopTsupBundleSecurityOptions();

function createSharedDefines() {
  return {
    __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
    __ZCODE_MIN_COMPATIBLE_VERSION__: JSON.stringify(buildMetadata.minCompatibleVersion),
    __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
    __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
    __ZCODE_ENV__: JSON.stringify(zcodeEnv),
    __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(zcodeProductFlavor),
    ...buildTimeConfigDefines,
    // Computer Use Helper build identity — helperInstaller 读它决定下载哪个 Helper bundle。
    // 缺失时 installer 抛 "Packaged ZCode is missing its embedded Computer Use Helper build identity"。
    // CI 构建时通过 ZCODE_CUA_HELPER_BUILD_ID env 注入；dev 为空串走兜底（dev helper 不走下载）。
    __ZCODE_CUA_HELPER_BUILD_ID__: JSON.stringify(
      process.env.ZCODE_CUA_HELPER_BUILD_ID?.trim() ?? "",
    ),
    // Bugfix: remote runtime CDN 根之前硬编码在 main bundle 里，OSS/CDN 切换必须改代码。
    // 这里改成构建期从 CI 的 CDN_DOMAIN/OSS_PATH_PREFIX 注入；没有配置时保留旧默认。
    __ZCODE_REMOTE_CDN_RELEASE_ROOTS__: JSON.stringify(resolveBuildRemoteCdnReleaseRoots(env)),
  };
}

function createMainDefines() {
  return {
    ...createSharedDefines(),
    // 正式安装包无法继承 GitLab Runner 或开发终端环境。这里只把 CI 提供的低权限写入配置
    // 编译进 Desktop Main，再由既有 Main -> Host -> Agent 安全边界定向传递。
    __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__: JSON.stringify(
      resolveBuildPackagedAgentTelemetryEnv(process.env),
    ),
  };
}

const desktopNodeRuntimeExternals = [
  "electron",
  "node-pty",
  "@napi-rs/keyring",
  "ssh2",
  "undici",
  "@larksuiteoapi/node-sdk",
  "yaml",
  // node-forge 内部用动态 require("crypto")，内联进 ESM main/host bundle 后 Electron 会报
  // Dynamic require of "crypto" is not supported。和 undici 同样保留为运行时外部依赖。
  "node-forge",
  // ZIP 解包器内部依赖 CommonJS require("fs")，不能内联到 ESM main/host 产物。
  "yauzl",
];

function createDevReadyMarkerHook(
  target: "main" | "host" | "preload" | "scheduler" | "extension-host",
): string {
  // CLI 级 --onSuccess 在多 config watch 模式下会被每个子构建分别触发。
  // 之前 preload 先成功时就提前写入 ready 标记，Electron 仍会在 main/host 未完成时启动。
  // 这里改成每个 config 自己在成功后写独立 marker，让 dev 启动脚本能精确等待全部构建完成。
  return `node scripts/write-dev-ready-marker.mjs ${target}`;
}

export default defineConfig([
  {
    name: "main",
    entry: {
      "main/index": "src/main/index.ts",
      "main/browserWebmRecorder": "src/main/browserView/electronBrowserWebmRecorder.ts",
      "main/zcodeDataSizeWorker": "src/main/zcodeDataSizeWorker.ts",
      // 资源管理器「存储」tab 的扫描 Worker：main 持有 StorageService，遍历放独立线程，供 new Worker(new URL()) 解析。
      "main/storageScanWorker": "src/main/storageScanWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    // node:sqlite 只有带前缀的内置入口；tsup 去掉 node: 会错误加载第三方 sqlite 包。
    removeNodeProtocol: false,
    target: "node22",
    // undici 如果被 main ESM bundle 直接内联，运行时会落到它内部的 CommonJS require("assert")，
    // Electron 加载 main 产物时会报 Dynamic require of "assert" is not supported。
    // desktop 保持 undici 为外部依赖，remote 单文件 bundle 再单独内联。
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      // Provider Refactor 的 workspace 包导出 TypeScript 源码；Electron 生产运行时没有
      // TS loader，必须随 Desktop bundle 内联，不能留下指向 src/index.ts 的裸包引用。
      "@zcode/provider",
      "@zcode/provider-node",
      // services 已内联进 main，但其 producer import 曾被保留为裸包引用；
      // electron-builder 又会排除 node_modules/@zcode，导致安装包启动即 ERR_MODULE_NOT_FOUND。
      // producer 的 JS broker 必须跟随 services 一起内联，原生 addon 仍只存在于独立 Helper。
      "@zcode/zcode-cua",
    ],
    define: createMainDefines(),
    // 修复原因：main/host 同时 watch 且共享 out 根目录时，默认 chunk 命名会互相覆盖，
    // 可能让 main 的 import 指向被 host 刚重写的 chunk，触发“缺少命名导出”的偶发启动报错。
    // 这里按目标分目录输出 chunk，确保并发构建下产物隔离。
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "main/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("main"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "preload",
    entry: {
      "preload/embeddedBrowserJavaScriptDialog": "src/preload/embeddedBrowserJavaScriptDialog.ts",
      "preload/codingPlanWebview": "src/preload/codingPlanWebview.ts",
      "preload/rewardsWebview": "src/preload/rewardsWebview.ts",
      "preload/browserVideoRecorder": "src/preload/browserVideoRecorder.ts",
      "preload/index": "src/preload/index.ts",
      "preload/resourceManager": "src/preload/resourceManager.ts",
      "preload/cuaPermissionPanel": "src/preload/cuaPermissionPanel.ts",
      "preload/pluginSandbox": "src/preload/pluginSandbox/index.ts",
    },
    outDir: "out",
    format: "cjs",
    platform: "node",
    // node:sqlite 只有带前缀的内置入口；tsup 去掉 node: 会错误加载第三方 sqlite 包。
    removeNodeProtocol: false,
    target: "node22",
    external: ["electron"],
    noExternal: ["@zcode/shared"],
    outExtension: () => ({ js: ".cjs" }),
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
    },
    onSuccess: createDevReadyMarkerHook("preload"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    // 插件 iframe 内的 window.zcode / window.openai 别名脚本（官方 ext-apps `App` 上的薄封装）：IIFE、浏览器平台，
    // 由 zcode-sandbox:// protocol handler 同源服务。
    name: "plugin-sandbox-alias",
    loader: { ".css": "text" },
    entry: {
      "plugin-sandbox-alias": "src/renderer/src/plugin-sandbox/alias.ts",
      "gen-ui": "src/renderer/src/plugin-sandbox/genUi.ts",
    },
    // 不能放 out/renderer：vite renderer 构建 emptyOutDir 会把先落盘的别名脚本清掉。
    outDir: "out/plugin-sandbox",
    onSuccess: () => copyGenUiRuntimeAssets(resolve("out/plugin-sandbox")),
    format: "iife",
    platform: "browser",
    target: "es2022",
    // 沙箱页面没有 node_modules：SDK（ext-apps / client / core / zod）必须全部打进 IIFE。
    noExternal: [/.*/],
    outExtension: () => ({ js: ".js" }),
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
    },
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "host",
    entry: {
      "host/index": "src/host/index.ts",
      "host/tasksStorageWorker": "src/host/database-startup/tasksStorageWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    // node:sqlite 只有带前缀的内置入口；tsup 去掉 node: 会错误加载第三方 sqlite 包。
    removeNodeProtocol: false,
    target: "node22",
    // host 与 main 共用同一套 services 图，继续内联 undici 会在 Electron ESM runtime 里触发同样的 dynamic require 崩溃。
    // 这里同样保留为外部依赖，避免 desktop 开发态和打包态 host 进程启动失败。
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
      "@zcode/zcode-cua",
    ],
    define: createSharedDefines(),
    // 与 main 保持一致的 chunk 隔离策略，避免 host/main 产物相互覆盖。
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "host/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("host"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "scheduler",
    entry: { "scheduler/index": "src/scheduler/index.ts" },
    outDir: "out",
    format: "esm",
    platform: "node",
    // node:sqlite 只有带前缀的内置入口；tsup 去掉 node: 会错误加载第三方 sqlite 包。
    removeNodeProtocol: false,
    target: "node22",
    // 与 host 同构：常驻 cron scheduler 进程复用 @zcode/services（tasks-index + cron），
    // 同样保留 undici 等为外部依赖，避免 Electron ESM runtime 的 dynamic require 崩溃。
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
      "@zcode/zcode-cua",
    ],
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "scheduler/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("scheduler"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    // 全 App 唯一的扩展进程（docs/plugins/extension-host.md §12.1）。扩展代码在运行时按插件路径
    // 动态 import，不进入本 bundle；这里只打包宿主本身（rpc、shared）与扩展视图用的 MCP SDK
    // （§8：进程内 MCP Client 与写法一的低层 Server）。SDK 内联进产物，安装包不依赖 node_modules 布局。
    name: "extension-host",
    entry: { "extension-host/index": "src/extension-host/index.ts" },
    outDir: "out",
    format: "esm",
    platform: "node",
    removeNodeProtocol: false,
    target: "node22",
    external: desktopNodeRuntimeExternals,
    noExternal: ["@zcode/shared", "@zcode/rpc", /^@modelcontextprotocol\//],
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "extension-host/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("extension-host"),
    ...desktopTsupBundleSecurityOptions,
  },
]);
