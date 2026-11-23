import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { PluginSandboxRegistryPort } from "./contract.js";
import {
  PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX,
  PLUGIN_SANDBOX_SCHEME,
  PLUGIN_SANDBOX_SHELL_HOST_PREFIX,
} from "./contract.js";
import { PLUGIN_SANDBOX_SHELL_CSP, buildPluginSandboxPermissionsPolicy } from "./csp.js";
import { createGenUiVendorResources, type GenUiVendorResources } from "./genUiVendor.js";

/** 打包产物在 out/renderer 下的文件名（vite input 名 `plugin-sandbox`）。 */
export const PLUGIN_SANDBOX_SHELL_HTML_FILE = "plugin-sandbox.html";
/** 注入插件 HTML 顶部的 `window.zcode` 别名脚本；同源加载，避免依赖 inline nonce。 */
export const PLUGIN_SANDBOX_ALIAS_SCRIPT_PATH = "/__zcode__/alias.js";
export const PLUGIN_SANDBOX_ALIAS_SCRIPT_FILE = "plugin-sandbox-alias.js";

export interface PluginSandboxSchemeRegistrar {
  registerSchemesAsPrivileged(
    schemes: Array<{ scheme: string; privileges: Record<string, boolean> }>,
  ): void;
}

/** 与 zcode-media 必须在同一次 registerSchemesAsPrivileged 调用里注册（第二次调用会覆盖第一次）。 */
export const PLUGIN_SANDBOX_PRIVILEGED_SCHEME = {
  scheme: PLUGIN_SANDBOX_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
} as const;

export interface PluginSandboxProtocolHost {
  handle(scheme: string, handler: (request: Request) => Promise<Response> | Response): void;
  unhandle(scheme: string): void;
  isProtocolHandled(scheme: string): boolean;
}

export interface PluginSandboxAssetSource {
  /** out/renderer 目录；shell HTML 与其 assets 从这里读。 */
  rendererDir: string;
  /** out/plugin-sandbox 目录；别名脚本从这里读（独立目录，避免被 vite emptyOutDir 清掉）。 */
  aliasDir: string;
  /**
   * 开发模式（vite dev）下 out/renderer 没有 shell 产物：shell 的 HTML、/src/*.ts、/@vite/* 全部
   * 从 renderer dev server 代理（ELECTRON_RENDERER_URL）。打包版缺省，走 rendererDir。
   */
  devServerUrl?: string;
}

export interface PluginSandboxRequestTarget {
  kind: "shell" | "plugin";
  sandboxId: string;
  pathname: string;
}

/** 解析 zcode-sandbox:// URL；host 不匹配前缀、带凭据或端口一律 null。 */
export function parsePluginSandboxUrl(rawUrl: string): PluginSandboxRequestTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${PLUGIN_SANDBOX_SCHEME}:` || url.port || url.username || url.password) {
    return null;
  }
  const host = url.hostname;
  if (host.startsWith(PLUGIN_SANDBOX_SHELL_HOST_PREFIX)) {
    const sandboxId = url.pathname.split("/")[2];
    if (!url.pathname.startsWith("/instance/")) return null;
    return sandboxId
      ? { kind: "shell", sandboxId, pathname: "/" + url.pathname.split("/").slice(3).join("/") }
      : null;
  }
  if (host.startsWith(PLUGIN_SANDBOX_PLUGIN_HOST_PREFIX)) {
    const sandboxId = url.pathname.split("/")[2];
    const pathname = "/" + url.pathname.split("/").slice(3).join("/");
    if (!url.pathname.startsWith("/instance/")) return null;
    return sandboxId ? { kind: "plugin", sandboxId, pathname } : null;
  }
  return null;
}

/** 在插件 HTML 的 `<head>` 顶部（或文档最前）注入别名脚本引用。 */
export function injectPluginSandboxAliasScript(html: string, sandboxId?: string): string {
  const tag = `<script src="${sandboxId ? `/instance/${sandboxId}` : ""}${PLUGIN_SANDBOX_ALIAS_SCRIPT_PATH}"></script>`;
  const headMatch = /<head[^>]*>/i.exec(html);
  if (headMatch) {
    const index = headMatch.index + headMatch[0].length;
    return `${html.slice(0, index)}${tag}${html.slice(index)}`;
  }
  return `${tag}${html}`;
}

export type PluginSandboxInitialTheme = "light" | "dark";

/**
 * 在插件 HTML 的 `<html>` 标签上预置 `data-theme`（UI_PLUGIN.md 约定的主题标记）。
 *
 * bugfix：深色主题下打开应用插件面板会白闪一下。原因是主题只随握手后的 hostContext 下发，
 * 插件样式默认浅色，握手完成前的首帧按浅色绘制。文档由 main 下发，这里在首帧前就带上当前主题，
 * 按 `data-theme` 写样式的插件首帧即为正确主题；握手后插件仍按 hostContext 自行更新。
 * 只加属性、不写 `color-scheme`：没有按 `data-theme` 写样式的插件不受影响。
 *
 * 只认文档前导区（BOM、空白、注释、doctype）之后紧跟的根 `<html>` 标签：全文搜索首个 `<html` 会命中
 * 注释或内联脚本字符串里的文本，往脚本字符串里插入带引号的属性会让整段脚本语法错误。
 * 根标签已带 `data-theme`，或文档不以 `<html>` 标签开头（片段式 HTML）时原样返回。
 *
 * 文档来自第三方插件且在 main 同步处理，前导区必须线性扫描：曾用 `(?:\s|<!--[\s\S]*?-->|…)*` 一条
 * 正则匹配，惰性注释分支套在 `*` 里，n 条前导注释匹配失败时有 2^(n-1) 种切分，几十条注释就能卡死
 * main。现在注释用 indexOf 找第一个结束符，其余分支首字符互斥，没有回溯歧义。
 */
export function injectPluginSandboxInitialTheme(
  html: string,
  theme: PluginSandboxInitialTheme,
): string {
  const trivia = /\s+|<!doctype[^>]*>/iy;
  let position = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    if (html.startsWith("<!--", position)) {
      const end = html.indexOf("-->", position + 4);
      if (end < 0) return html;
      position = end + 3;
      continue;
    }
    trivia.lastIndex = position;
    if (!trivia.test(html)) break;
    position = trivia.lastIndex;
  }
  if (!/^<html[\s>]/i.test(html.slice(position, position + 6))) return html;
  // 逐字符找根标签的结束：引号内的 `>` 属于属性值，按 `[^>]*>` 截断会漏看后面的 data-theme。
  // 不用带分支的正则循环：根标签达到十几 MB 时 V8 回溯栈溢出抛 RangeError，文档请求直接失败。
  let end = position + "<html".length;
  let quote = "";
  for (; end < html.length; end += 1) {
    const char = html[end];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") break;
  }
  if (end >= html.length) return html;
  // 先去掉属性值再找属性名：值里的文本不算；`class="a"data-theme="x"` 这种属性间无空白的写法也算已有。
  const attributeNames = html.slice(position, end).replace(/"[^"]*"|'[^']*'/g, '""');
  if (/[\s"]data-theme(?=[\s=/]|$)/i.test(attributeNames)) return html;
  const index = position + "<html".length;
  return `${html.slice(0, index)} data-theme="${theme}"${html.slice(index)}`;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

export function createPluginSandboxProtocolHandler(options: {
  registry: PluginSandboxRegistryPort;
  assets: PluginSandboxAssetSource;
  readAsset?: (absolutePath: string) => Promise<Uint8Array>;
  vendorResources?: GenUiVendorResources;
  /** 下发插件文档时的应用主题；缺省不预置。Gen UI 文档由自带 runtime 处理主题，不走这里。 */
  resolveInitialTheme?: () => PluginSandboxInitialTheme;
  logger?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
}): (request: Request) => Promise<Response> {
  const readAsset = options.readAsset ?? ((path: string) => readFile(path));
  const notFound = () => new Response(null, { status: 404 });
  const vendorResources =
    options.vendorResources ?? createGenUiVendorResources(options.assets.aliasDir, readAsset);

  const serveAsset = async (
    baseDir: string,
    relativePath: string,
    headers: Record<string, string>,
  ) => {
    // 防路径穿越：规范化后必须仍在 baseDir 内。
    const absolute = normalize(join(baseDir, relativePath));
    const root = normalize(baseDir + sep);
    if (!absolute.startsWith(root)) return notFound();
    try {
      const body = await readAsset(absolute);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          "Content-Type": MIME_BY_EXTENSION[extname(absolute)] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          ...headers,
        },
      });
    } catch {
      return notFound();
    }
  };

  const handle = async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const target = parsePluginSandboxUrl(request.url);
    if (!target) return notFound();
    const record = options.registry.get(target.sandboxId);
    if (!record) return notFound();
    if (new URL(request.url).hostname !== `${target.kind}-${record.instance.appIdentity}`)
      return notFound();

    if (target.kind === "shell") {
      const shellHeaders = {
        "Content-Security-Policy": PLUGIN_SANDBOX_SHELL_CSP,
        "Permissions-Policy": buildPluginSandboxPermissionsPolicy(record.permissions, "shell"),
      };
      if (options.assets.devServerUrl) {
        // dev：同源代理整个 shell 路径空间，vite 的模块脚本才能在 zcode-sandbox://shell-<id> 下解析。
        const upstreamPath =
          target.pathname === "/" || target.pathname === "/index.html"
            ? `/${PLUGIN_SANDBOX_SHELL_HTML_FILE}`
            : target.pathname;
        const search = new URL(request.url).search;
        try {
          const upstream = await fetch(`${options.assets.devServerUrl}${upstreamPath}${search}`);
          if (!upstream.ok) return new Response(null, { status: upstream.status });
          return new Response(await upstream.arrayBuffer(), {
            status: 200,
            headers: {
              "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
              ...shellHeaders,
            },
          });
        } catch {
          return new Response(null, { status: 502 });
        }
      }
      if (target.pathname === "/" || target.pathname === "/index.html") {
        return serveAsset(options.assets.rendererDir, PLUGIN_SANDBOX_SHELL_HTML_FILE, shellHeaders);
      }
      if (target.pathname.startsWith("/assets/")) {
        return serveAsset(options.assets.rendererDir, target.pathname.slice(1), shellHeaders);
      }
      return notFound();
    }

    if (record.contentKind === "gen-ui" && target.pathname.startsWith("/__zcode__/vendor/")) {
      const file = target.pathname.slice("/__zcode__/vendor/".length);
      try {
        if (!(await vendorResources.hasFile(file))) return notFound();
        return serveAsset(join(options.assets.aliasDir, "vendor"), file, {
          "Content-Security-Policy": record.cspHeader,
        });
      } catch {
        return new Response(null, { status: 500 });
      }
    }
    if (record.contentKind === "gen-ui" && target.pathname === "/__zcode__/gen-ui.js") {
      return serveAsset(options.assets.aliasDir, "gen-ui.js", {
        "Content-Security-Policy": record.cspHeader,
      });
    }
    if (record.contentKind !== "gen-ui" && target.pathname === PLUGIN_SANDBOX_ALIAS_SCRIPT_PATH) {
      return serveAsset(options.assets.aliasDir, PLUGIN_SANDBOX_ALIAS_SCRIPT_FILE, {
        "Content-Security-Policy": record.cspHeader,
      });
    }
    if (target.pathname === "/" || target.pathname === "/index.html") {
      // 主题注入必须作用在原始文档上：没有 <head> 的文档别名脚本会加在最前，之后根标签就不在文档开头了。
      const themed =
        record.contentKind !== "gen-ui" && options.resolveInitialTheme
          ? injectPluginSandboxInitialTheme(record.html, options.resolveInitialTheme())
          : record.html;
      let html =
        record.contentKind === "gen-ui"
          ? record.html.replace(
              "__ZCODE_GEN_UI_RUNTIME__",
              `/instance/${record.sandboxId}/__zcode__/gen-ui.js`,
            )
          : injectPluginSandboxAliasScript(themed, record.sandboxId);
      if (record.contentKind === "gen-ui") {
        try {
          const [styles, kit] = await Promise.all([
            readAsset(join(options.assets.aliasDir, "visualize.css")),
            readAsset(join(options.assets.aliasDir, "visualize.html")),
          ]);
          const decode = (value: Uint8Array) => new TextDecoder().decode(value);
          // bridge/Tweak 在作者脚本前，inner kit 在片段后；原手写 Widgets 改变了上游初始化语义。
          html = html.replace(
            "<!--__ZCODE_GEN_UI_STYLES__-->",
            `<style>${decode(styles)}\n:root { --visualize-paint-gutter: 5px; --viz-fg: var(--foreground); }</style>`,
          );
          if (/\bviz-calendar\b/i.test(record.html)) {
            const calendar = decode(await readAsset(join(options.assets.aliasDir, "calendar.js")));
            html = html.replace(
              "</head>",
              `<script>${calendar.replaceAll("</script", "<\\/script")}</script></head>`,
            );
          }
          const marker = "<!--__ZCODE_GEN_UI_INNER_KIT__-->";
          const index = html.lastIndexOf(marker);
          if (index < 0) throw new Error("Gen UI document is missing its runtime slot");
          html =
            html.slice(0, index) +
            decode(kit).replace("<!--__INLINE_VISUALIZATION_FRAGMENT__-->", "") +
            // 标签切换的短暂溢出可能在撑高后残留空滚动条；只隐藏根滚动条，不裁切内容或禁用作者滚动区。
            '<style id="zcode-gen-ui-document-scrollbar">html,body{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}</style>' +
            html.slice(index + marker.length);
        } catch {
          // 资源缺失不能返回半成品文档，否则页面看似加载成功但交互静默失效。
          options.logger?.warn("[plugin-sandbox] Gen UI runtime resources unavailable");
          return new Response(null, { status: 500 });
        }
      }
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": record.cspHeader,
          "Permissions-Policy": buildPluginSandboxPermissionsPolicy(record.permissions, "plugin"),
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return notFound();
  };

  return async (request) => {
    const response = await handle(request);
    // 稳定 origin 会共享 Chromium 资源缓存；只禁止 HTML 缓存仍会让已载入脚本
    // 绕过后续 guest 归属检查。全部实例响应禁用缓存，浏览器业务存储保持独立语义。
    response.headers.set("Cache-Control", "no-store");
    // 插件文档与别名脚本的请求记 info（shell 静态资源不记），沙箱空白页可据此区分 404 与脚本未跑。
    const isShellAsset = request.url.includes(`://${PLUGIN_SANDBOX_SHELL_HOST_PREFIX}`);
    if (!isShellAsset || response.status >= 400) {
      const line = `[plugin-sandbox] ${request.method} ${request.url} -> ${response.status} type=${response.headers.get("Content-Type") ?? ""} csp=${response.headers.get("Content-Security-Policy") ?? ""}`;
      if (response.status >= 400) options.logger?.warn(line);
      else options.logger?.info?.(line);
    }
    return response;
  };
}

const installedProtocols = new WeakSet<PluginSandboxProtocolHost>();

export function installPluginSandboxProtocol(
  protocol: PluginSandboxProtocolHost,
  handler: (request: Request) => Promise<Response>,
): void {
  if (installedProtocols.has(protocol)) return;
  protocol.handle(PLUGIN_SANDBOX_SCHEME, handler);
  installedProtocols.add(protocol);
}

export function uninstallPluginSandboxProtocol(protocol: PluginSandboxProtocolHost): void {
  if (!installedProtocols.has(protocol)) return;
  if (protocol.isProtocolHandled(PLUGIN_SANDBOX_SCHEME)) protocol.unhandle(PLUGIN_SANDBOX_SCHEME);
  installedProtocols.delete(protocol);
}
