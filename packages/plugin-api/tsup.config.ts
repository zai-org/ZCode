import { defineConfig } from "tsup";

// 给仓库外的插件作者用的声明包（docs/plugins/extension-host.md §17.9）：
// tsup 的 dts 内部用 rollup-plugin-dts，把协议模块与 session-control 的声明内联进 dist，只留 zod 一个外部依赖。
// 被内联的源码按各自包的写法解析：shared 的 `#src/*`、session-control 的 `#session-control/*` 都在这里映射，
// 否则 rollup 把它们当成外部模块原样留在产物里，包外解析不到。
export default defineConfig({
  entry: {
    index: "src/contract.ts",
    manifest: "src/manifest.ts",
    sessions: "src/sessions.ts",
    "protocol-v4": "src/protocol-v4.ts",
  },
  format: ["esm"],
  outDir: "dist",
  clean: true,
  dts: {
    only: true,
    resolve: [/^@zcode\//, /^#/],
    compilerOptions: {
      // tsup 内部会设 baseUrl，TypeScript 6 对它报弃用。
      ignoreDeprecations: "6.0",
      composite: false,
      declarationMap: false,
      // 被内联的源码在 packages/ 下各处，rootDir 放到仓库根。
      rootDir: "../..",
      // 被内联的 v4 协议源码里有用到 DOM 与 Node 全局类型的运行时代码；产物只保留导出用到的声明。
      lib: ["es2024", "dom"],
      types: ["node"],
      paths: {
        "@zcode/shared/extension-host": ["../shared/src/extension-host/index.ts"],
        "@zcode/shared/zcode-protocol-v4": ["../shared/src/zcode-protocol-v4/index.ts"],
        "@zcode/session-control/contracts": ["../session-control/src/contract.ts"],
        "#src/*": ["../shared/src/*"],
        "#session-control/*": ["../session-control/src/*"],
      },
    },
  },
});
