declare module "*.css";
declare module "@zcode/ui/styles.css";
// core-js 不带类型声明，polyfills.ts 只做副作用导入。
declare module "core-js/stable/*";

interface ImportMetaEnv {
  // 本文件手写声明了 Vite env 形状，内置 BASE_URL 也需要显式补上，
  // 否则手机远控按构建 base 区分 /remote 和 /remote/v3 时无法通过 typecheck。
  readonly BASE_URL: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly VITE_DEV_ORIGIN?: string;
  readonly VITE_CONVERSATION_SHARE_PREVIEW_MOCK?: string;
  readonly VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO?: string;
  // OSS 多版本发布时资源 base 带版本目录，页面路由由该变量显式给出。
  readonly VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?: string;
  readonly VITE_ZCODE_BASE_URL?: string;
  readonly VITE_ZCODE_ENDPOINT_ORIGIN?: string;
  readonly VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
