import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const rootPackageJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
) as { version: string; zcodeCompatibility?: { minCompatibleVersion?: string } };
const minCompatibleVersion =
  rootPackageJson.zcodeCompatibility?.minCompatibleVersion ?? rootPackageJson.version;

// tsup 配置自身会被打包，构建工具需保留原始文件位置，不能被内联后重定位。
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);

const { content: zcodeBuiltinProviderConfigJson } = await loadBuiltinProviderConfig();

export const SERVER_CLI_DEFINES = {
  __ZCODE_VERSION__: JSON.stringify(rootPackageJson.version),
  __ZCODE_MIN_COMPATIBLE_VERSION__: JSON.stringify(minCompatibleVersion),
  __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltinProviderConfigJson),
};

export default defineConfig({
  entry: {
    "server-cli": "src/main.ts",
    "server-core": "src/server-core/entry.ts",
  },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  // node:sqlite 只有带前缀的内置入口；tsup 去掉 node: 会错误加载第三方 sqlite 包。
  removeNodeProtocol: false,
  target: "node22",
  sourcemap: true,
  splitting: false,
  banner: {
    js: 'import { fileURLToPath as __zcodeFileURLToPath } from "node:url"; import { dirname as __zcodeDirname } from "node:path"; const __filename = __zcodeFileURLToPath(import.meta.url); const __dirname = __zcodeDirname(__filename);',
  },
  noExternal: ["@zcode/shared", "@zcode/rpc", "@zcode/services"],
  define: SERVER_CLI_DEFINES,
  external: [
    "node-pty",
    "@napi-rs/keyring",
    "ssh2",
    "yaml",
    // Bug 原因：services 的日志归档仍间接使用 yazl；内嵌到 ESM 后 require("fs") 会在启动时崩溃。
    // 保留外置依赖，由 staging 收集生产依赖闭包，再交给 Node 按 CJS 加载。
    "yazl",
    "node-forge",
    "undici",
    "axios",
    "form-data",
    "combined-stream",
    "proxy-from-env",
    "follow-redirects",
    "@lydell/node-pty-darwin-arm64",
    "@lydell/node-pty-darwin-x64",
    "@lydell/node-pty-linux-arm64",
    "@lydell/node-pty-linux-x64",
  ],
});
