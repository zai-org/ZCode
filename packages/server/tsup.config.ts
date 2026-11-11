import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
// tsup 配置自身会被打包，构建工具需保留原始文件位置，不能被内联后重定位。
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);
const { stageThirdPartyNotices } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/third-party-notices.mjs")).href
);

// tsup config 可能从不同 cwd 加载，基于配置文件自身目录解析仓库根 package.json。
const rootPackageJsonPath = resolve(import.meta.dirname, "../../package.json");
const { version, zcodeCompatibility } = JSON.parse(readFileSync(rootPackageJsonPath, "utf-8")) as {
  version: string;
  zcodeCompatibility?: { minCompatibleVersion?: string };
};
const minCompatibleVersion = zcodeCompatibility?.minCompatibleVersion ?? version;

const { environment: zcodeEnv, content: zcodeBuiltinProviderConfigJson } =
  await loadBuiltinProviderConfig();

export const SERVER_HTTP_DEFINES = {
  __ZCODE_VERSION__: JSON.stringify(version),
  __ZCODE_MIN_COMPATIBLE_VERSION__: JSON.stringify(minCompatibleVersion),
  __ZCODE_ENV__: JSON.stringify(zcodeEnv),
  __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltinProviderConfigJson),
};

function createSharedDefines() {
  return SERVER_HTTP_DEFINES;
}

export const SERVER_HTTP_EXTERNAL_DEPENDENCIES = [
  "ssh2",
  "node-pty",
  "@napi-rs/keyring",
  "undici",
  "axios",
  "form-data",
  "combined-stream",
  "proxy-from-env",
  "follow-redirects",
  "yazl",
  // Bugfix: node-forge 内部用动态 require("crypto")，内联进 server ESM bundle 后 Node 会报
  // Dynamic require of "crypto" is not supported；这里和 desktop main/host 构建保持同一外置策略。
  "node-forge",
  "yaml",
  // services 的反馈日志压缩链路引入 CJS 包 yazl，被内联进 ESM bundle 后
  // 运行时命中 require("fs") 动态 require，entry-http 启动即崩；保留外部依赖交给 Node 原生加载。
  "yazl",
  // Bugfix: node-forge（appCaCert 自签 CA 链路）内部动态 require("crypto")，
  // 与 desktop tsup.config 的处理一致，必须外置交给 Node 原生加载。
  "node-forge",
  // 修复：云内容 ZIP 解包链路（services/cloud-content）引入 CJS 包 yauzl，内联进 ESM bundle 后
  // entry-http.js 加载即报 Dynamic require of "fs" is not supported；与 desktop 相同，外置交给 Node 原生加载。
  "yauzl",
];

export default defineConfig({
  // HTTP server 产物外置并内联第三方代码，dist 旁必须附带完整声明（Web/统一分发包直接复制 dist）。
  onSuccess: async () => {
    await stageThirdPartyNotices(resolve(import.meta.dirname, "dist"));
  },
  entry: { "entry-http": "src/entry-http.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  // node:sqlite 只有带前缀的内置入口；tsup 去掉 node: 会错误加载第三方 sqlite 包。
  removeNodeProtocol: false,
  target: "node22",
  // workspace 包的 exports 指向 .ts 源码，node 运行时无法直接加载，需要 bundle 进来
  noExternal: [
    "@zcode/shared",
    "@zcode/rpc",
    "@zcode/services",
    "@zcode/services/node",
    "@zcode/client",
  ],
  // ssh2 / node-pty 含 .node native addon，不能被 esbuild 处理。
  // undici / axios 这类 CJS 依赖被内联进 ESM bundle 后，运行时会走到
  // require("assert") / require("util") / require("url") 等动态 require，Node 的 ESM wrapper 下会直接报 Dynamic require not supported。
  // HTTP server 场景保留为外部依赖，交给 Node 原生加载；remote 单文件 bundle 仍由 build-remote.ts 负责内联。
  external: SERVER_HTTP_EXTERNAL_DEPENDENCIES,
  define: createSharedDefines(),
  // esbuild 不认识 tsconfig.json 里的 es2025，用专门的 tsconfig.build.json 消除 warning
  tsconfig: "tsconfig.build.json",
});
