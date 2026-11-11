import { readFileSync } from "node:fs";
import { build, type Plugin } from "esbuild";
import {
  REMOTE_SERVER_NATIVE_EXTERNALS,
  validateRemoteServerBundle,
} from "./buildRemoteValidation.js";
import { loadBuiltinProviderConfig } from "../../scripts/builtin-provider-config.mjs";
import { stageThirdPartyNotices } from "../../scripts/third-party-notices.mjs";

const { version, zcodeCompatibility } = JSON.parse(readFileSync("../../package.json", "utf-8")) as {
  version: string;
  zcodeCompatibility?: { minCompatibleVersion?: string };
};
const minCompatibleVersion = zcodeCompatibility?.minCompatibleVersion ?? version;
const { content: zcodeBuiltinProviderConfigJson } = await loadBuiltinProviderConfig();

/**
 * Let esbuild bundle node-pty's JS code normally, but keep .node native
 * addon files as external requires. node-pty's loadNativeModule() searches
 * for `./build/Release/pty.node` relative to itself, which matches our
 * deploy layout on the remote.
 *
 * CJS 格式而非 ESM：node-pty 内部大量使用 __dirname，ESM 里没有这个变量，
 * 用 CJS 输出可以直接原生支持，不需要任何 polyfill。
 */
const nativeAddonPlugin: Plugin = {
  name: "native-addon",
  setup(build) {
    // Mark all .node files as external — they can't be bundled
    build.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

const buildResult = await build({
  entryPoints: ["src/entry-stdio.ts"],
  bundle: true,
  outfile: "dist/remote/zcode-server.cjs",
  platform: "node",
  format: "cjs",
  target: "node22",
  plugins: [nativeAddonPlugin],
  external: REMOTE_SERVER_NATIVE_EXTERNALS,
  // CJS 环境没有 import.meta.url，通过 banner 注入等价变量，
  // 再用 define 全局替换，这样源码无需关心最终打包格式。
  banner: {
    js: 'var __import_meta_url = require("url").pathToFileURL(__filename).href; var __import_meta_dirname = __dirname;',
  },
  define: {
    "import.meta.url": "__import_meta_url",
    "import.meta.dirname": "__import_meta_dirname",
    __ZCODE_VERSION__: JSON.stringify(version),
    __ZCODE_MIN_COMPATIBLE_VERSION__: JSON.stringify(minCompatibleVersion),
    __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltinProviderConfigJson),
  },
  metafile: true,
});

const remoteBundleSource = readFileSync("dist/remote/zcode-server.cjs", "utf-8");
const bundledInputs = Object.keys(buildResult.metafile.inputs);
validateRemoteServerBundle({ bundledInputs, source: remoteBundleSource });
// 修复：remote 单文件 bundle 内联第三方代码，dist/remote 也必须附完整声明。
await stageThirdPartyNotices("dist/remote");

console.log("Built dist/remote/zcode-server.cjs");
