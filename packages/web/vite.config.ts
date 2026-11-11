import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { thirdPartyNoticesVitePlugin } from "../../scripts/third-party-notices.mjs";
import { resolveRemoteFrontendVersion } from "./vite/remoteFrontendVersion.mjs";
// Bugfix: Vite 配置在 Node 加载期执行，不能导入 @zcode/shared 根入口。
// 根入口包含 NodeNext 风格的源码 re-export，Node 会按真实文件查找 .js 并在 bootstrap 阶段失败。
import {
  resolveBigModelApiOrigin,
  resolveRuntimeZCodeEndpointOrigin,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
} from "@zcode/shared/zcodeEndpoint";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version, zcodeCompatibility } = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"),
) as { version: string; zcodeCompatibility?: { minCompatibleVersion?: string } };
const minCompatibleVersion = zcodeCompatibility?.minCompatibleVersion ?? version;

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export default defineConfig(({ mode }) => {
  // `.env*` 只提供链接常量；当前产品环境由启动脚本或 CI 注入 ZCODE_ENV。
  // 启动脚本通过 process.env 显式选择 test/production；它必须优先于 .env 文件，
  // 否则 share:test 可能被 mode 的旧配置误解析到错误 endpoint。
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  const endpointEnv = {
    ...env,
    ZCODE_ENV: zcodeEnv,
  };
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);
  const zaiOAuthOrigin = resolveZaiOAuthOrigin(endpointEnv);
  // 远控与桌面/分享页一致，BigModel 授权域名必须跟随产品环境。
  const bigmodelOAuthOrigin = resolveBigModelApiOrigin(endpointEnv);
  // ZAI OAuth client_id 是公开标识，允许注入浏览器包；secret/token 不得走 VITE_。
  const zaiOAuthClientId = resolveZaiOAuthClientId(endpointEnv);

  return {
    plugins: [pdfJsCMapsPlugin(), react(), tailwindcss(), thirdPartyNoticesVitePlugin()],
    resolve: {
      alias: [
        // 修复 UI 组件库中的 @ 别名解析失败。
        // 问题原因：packages/ui 的源码直接被 web 应用交给 Vite 打包，但 web 自己没声明 @ -> packages/ui/src，
        // 所以像 "@/components/lib/utils" 这类导入会在运行时构建阶段报找不到模块。
        // 这里把别名补到消费方 Vite 配置里，保持现有组件源码不动，影响面最小。
        { find: "@", replacement: resolve(__dirname, "../ui/src") },
        // Recharts 依赖 d3-shape@3.x，后者需要 d3-path 的 Path 导出。
        // hoisted node_modules 可能把 d3-shape 旁边的旧 d3-path@1.x 暴露给 Vite 预构建，
        // 导致桌面/Web dev 都在依赖优化阶段失败；显式指向根部 3.x 入口以固定解析边界。
        {
          find: "d3-path",
          replacement: resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
        },
        // Bugfix：pdf.js 默认构建在主线程和 Worker 里直接调用 URL.parse（Chrome 126）与
        // Promise.withResolvers（Chrome 119）。Chrome/Edge 111–125 打开字符串 URL 的 PDF 时，
        // getUrlProp() 抛 TypeError，会话区域崩溃；Worker 是独立全局，main.tsx 的 polyfill 进不去。
        // 只在 Web 换成同版本 legacy 构建，它的主线程与 Worker 文件各自带 core-js polyfill。
        // 必须用正则精确匹配：字符串键按前缀匹配，会把 worker 子路径也改写错。
        { find: /^pdfjs-dist$/, replacement: "pdfjs-dist/legacy/build/pdf.mjs" },
        {
          find: /^pdfjs-dist\/build\/pdf\.worker\.min\.mjs(?=$|\?)/,
          replacement: "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
        },
      ],
    },
    server: {
      port: 5173,
      proxy: {
        // Web 登录本地调试时，OAuth token 交换必须先命中线上同源接口。
        // 该专用代理放在 `/api` 通配代理之前，避免被转发到本地 server 导致 404。
        "/api/v1/oauth": {
          target: zcodeEndpointOrigin,
          changeOrigin: true,
          secure: true,
        },
        "/api/v1/remote": {
          target: zcodeEndpointOrigin,
          changeOrigin: true,
          secure: true,
          ws: true,
        },
        // 将 /ws 和 /api 请求代理到 server（默认 3030 端口）
        "/ws": { target: "ws://localhost:3030", ws: true },
        "/api": { target: "http://localhost:3030" },
      },
    },
    optimizeDeps: {
      // 修复：在依赖预构建阶段显式加入 react 相关入口，避免 rolldown 解析 `react/jsx-runtime`
      // / `react/jsx-dev-runtime` 时返回无后缀路径导致的加载失败（UNLOADABLE_DEPENDENCY）。
      include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
      // pdfjs-dist 是纯 ESM，不需要预构建。上面的 alias 让 dev 依赖扫描把带 ?url 的 worker
      // 当成依赖预构建并崩溃，pdf-viewer 动态导入随之 504；排除后直接按源文件提供。
      exclude: ["pdfjs-dist"],
    },
    worker: {
      rollupOptions: {
        // @pierre/diffs 的 worker 入口依赖 import 后注册 message 监听。
        // 它的 package sideEffects 漏声明会让生产 worker 子构建被摇成 0B；
        // 只关闭 worker 构建的摇树，避免影响主包。
        treeshake: false,
      },
    },
    define: {
      __ZCODE_VERSION__: JSON.stringify(
        resolveRemoteFrontendVersion(version, process.env.WEB_REMOTE_FRONTEND_VERSION),
      ),
      __ZCODE_MIN_COMPATIBLE_VERSION__: JSON.stringify(minCompatibleVersion),
      __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "unknown"),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      // 兼容旧 Web runtime 读取名；新代码统一读 VITE_ZCODE_BASE_URL。
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      // 明确注入 OAuth 公开配置，避免 Web 端在不同 mode 下隐式依赖源码 fallback。
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(zaiOAuthClientId),
      "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(zaiOAuthOrigin),
      "import.meta.env.VITE_BIGMODEL_OAUTH_ORIGIN": JSON.stringify(bigmodelOAuthOrigin),
    },
    build: {
      // 生产不在浏览器产物暴露 sourceMappingURL，避免客户端侧还原业务源码。
      sourcemap: mode === "production" ? "hidden" : true,
    },
  };
});
