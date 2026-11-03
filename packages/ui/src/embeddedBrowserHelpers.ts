import { BROWSER_LOCAL_PREVIEW_SCHEME, browserPreviewSourceUrl } from "@zcode/shared";

export const DEFAULT_BROWSER_URL = "about:blank";

const RECOVERABLE_BROWSER_GUEST_EXIT_REASONS = new Set([
  "abnormal-exit",
  "killed",
  "crashed",
  "oom",
  "memory-eviction",
]);

/**
 * 只对已经运行过、但被 Chromium 异常终止的 guest 做原位恢复。
 *
 * 过去只保持 `<webview>` DOM，没有覆盖其 renderer 被系统终止的情况；
 * 但 launch/integrity failure 不是“原页面被回收”，盲目重建只会形成无限循环。
 */
export function isRecoverableBrowserGuestExitReason(reason: string): boolean {
  return RECOVERABLE_BROWSER_GUEST_EXIT_REASONS.has(reason);
}

// Electron <webview> 标签的同步方法（getURL/canGoBack/loadURL/executeJavaScript 等）在
// guest 尚未 attach（dom-ready 之前）或 guest frame 已销毁/重附过程中会同步抛出这两类错误。
// 这些是 webview 生命周期里的预期竞态，不是真正的业务异常。若任由它们经由
// window.onerror 全局兜底上报，单一来源即会占用海量异常量，必须在调用边界收敛。
const WEBVIEW_DETACHED_ERROR_FRAGMENTS = [
  "must be attached to the DOM",
  "Render frame was disposed",
] as const;

export function isWebviewDetachedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) {
    return false;
  }
  return WEBVIEW_DETACHED_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment));
}

/**
 * 安全地执行一次 webview 同步调用：
 * - 正常返回调用结果；
 * - 命中“guest 未挂载 / frame 已销毁”这类生命周期竞态错误时，吞掉并返回 fallback，
 *   可选地通过 onDetached 记录（用于 debug 级日志，而非静默）；
 * - 其余错误继续向上抛，避免掩盖真正的 bug。
 */
export function safeWebviewCall<T>(
  call: () => T,
  fallback: T,
  onDetached?: (error: unknown) => void,
): T {
  try {
    return call();
  } catch (error) {
    if (isWebviewDetachedError(error)) {
      onDetached?.(error);
      return fallback;
    }
    throw error;
  }
}

const ALLOWED_BROWSER_PROTOCOLS = new Set([
  "about:",
  "data:",
  "file:",
  `${BROWSER_LOCAL_PREVIEW_SCHEME}:`,
  "http:",
  "https:",
]);

const URL_PROTOCOL_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface BrowserGuestFailure {
  exitCode: number;
  reason: string;
}

export interface BrowserState {
  canGoBack: boolean;
  canGoForward: boolean;
  currentUrl: string;
  errorMessage: string | null;
  /**
   * 主 frame 加载失败的 Chromium net error 码。
   *
   * Electron 的 `<webview>` 没有 Chrome 的安全插页，被拒的导航只会落到一张空的
   * chrome-error 页，用户看到纯黑。错误码必须随 errorMessage 一起进状态，才能画出可读错误态
   * 并对证书类失败给出放行指引。
   */
  loadErrorCode: number | null;
  /** guest 从未成功出画面的进程级失败；与能画出可读错误态的 load error 分开。 */
  guestFailure: BrowserGuestFailure | null;
  isLoading: boolean;
  isReady: boolean;
  title: string;
}

export interface BrowserNavigationRequest {
  id: string;
  url: string;
}

export const INITIAL_BROWSER_STATE: BrowserState = {
  canGoBack: false,
  canGoForward: false,
  currentUrl: DEFAULT_BROWSER_URL,
  errorMessage: null,
  loadErrorCode: null,
  guestFailure: null,
  isLoading: false,
  isReady: false,
  title: "",
};

/** Chromium 证书错误码区间（ERR_CERT_COMMON_NAME_INVALID … ERR_CERT_KNOWN_INTERCEPTION_BLOCKED）。 */
const CERTIFICATE_LOAD_ERROR_CODE_MIN = -217;
const CERTIFICATE_LOAD_ERROR_CODE_MAX = -200;

/**
 * 判断加载失败是否源于证书问题。
 *
 * 只有证书类失败才提示「可开启忽略证书校验」；DNS、连接被拒等失败给这条指引会误导用户。
 */
export function isCertificateBrowserLoadErrorCode(code: number | null | undefined): boolean {
  if (typeof code !== "number") return false;
  return code >= CERTIFICATE_LOAD_ERROR_CODE_MIN && code <= CERTIFICATE_LOAD_ERROR_CODE_MAX;
}

export function isAllowedBrowserUrl(url: string): boolean {
  try {
    return ALLOWED_BROWSER_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** 系统默认浏览器入口接受 Web URL 和 file URL，不能复用内置浏览器更宽的本地/内联协议白名单。 */
export function isDefaultBrowserOpenableUrl(url: string): boolean {
  try {
    const protocol = new URL(browserPreviewSourceUrl(url)).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  } catch {
    return false;
  }
}

function hasAllowedExplicitProtocol(input: string): boolean {
  const protocol = input.match(URL_PROTOCOL_RE)?.[0].toLowerCase();
  return protocol ? ALLOWED_BROWSER_PROTOCOLS.has(protocol) : false;
}

function hasDisallowedExplicitProtocol(input: string): boolean {
  const match = input.match(URL_PROTOCOL_RE);
  if (!match) {
    return false;
  }

  const protocol = match[0].toLowerCase();
  if (ALLOWED_BROWSER_PROTOCOLS.has(protocol)) {
    return false;
  }

  return !/^\d{1,5}(?:$|[/?#])/.test(input.slice(match[0].length));
}

function parseSchemeLessUrl(input: string): URL | null {
  try {
    const normalizedInput = normalizeBareIpv6LoopbackInput(input);
    return new URL(
      normalizedInput.startsWith("//") ? `http:${normalizedInput}` : `http://${normalizedInput}`,
    );
  } catch {
    return null;
  }
}

function normalizeBareIpv6LoopbackInput(input: string): string {
  if (input === "::1") {
    return "[::1]";
  }

  if (/^::1(?=[:/?#])/.test(input)) {
    return `[::1]${input.slice(3)}`;
  }

  return input;
}

function getSchemeLessExplicitPort(input: string): string | null {
  const normalizedInput = normalizeBareIpv6LoopbackInput(input);
  const withoutLeadingSlashes = normalizedInput.startsWith("//")
    ? normalizedInput.slice(2)
    : normalizedInput;
  const authority = withoutLeadingSlashes.split(/[/?#]/, 1)[0] ?? "";
  const hostWithPort = authority.split("@").at(-1) ?? authority;

  if (hostWithPort.startsWith("[")) {
    return hostWithPort.match(/^\[[^\]]+\]:(\d+)$/)?.[1] ?? null;
  }

  const portMatch = hostWithPort.match(/:(\d+)$/);
  if (!portMatch) {
    return null;
  }

  const host = hostWithPort.slice(0, portMatch.index);
  return host.includes(":") ? null : (portMatch[1] ?? null);
}

function parseIpv4Address(host: string): [number, number, number, number] | null {
  if (!IPV4_RE.test(host)) {
    return null;
  }

  const octets = host.split(".").map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets as [number, number, number, number];
}

function isLocalhostName(host: string): boolean {
  return host === "localhost" || host === "localhost.localdomain" || host.endsWith(".localhost");
}

export function isLocalDevelopmentHost(host: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/^\[(.*)]$/, "$1");
  if (
    isLocalhostName(normalizedHost) ||
    normalizedHost === "::1" ||
    normalizedHost === "0:0:0:0:0:0:0:1" ||
    normalizedHost.endsWith(".local") ||
    normalizedHost.endsWith(".test")
  ) {
    return true;
  }

  const ipv4 = parseIpv4Address(normalizedHost);
  if (!ipv4) {
    return false;
  }

  const [first, second, third, fourth] = ipv4;
  return (
    first === 127 ||
    (first === 0 && second === 0 && third === 0 && fourth === 0) ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

export function isLocalDevelopmentBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    return isLocalDevelopmentHost(parsed.hostname);
  } catch {
    return false;
  }
}

export type MessageLinkOpenTarget = "app-browser" | "external-browser";

/**
 * 交互语义：右键菜单的两项是显式互补的目标选择，只有左键单击才走本机/私网启发式。
 * 之前菜单「打开」复用了左键默认行为，公网链接（如飞书文档）两项都会跳系统浏览器。
 */
export function resolveMessageLinkOpenTarget(input: {
  href: string;
  forceExternal?: boolean;
  forceInApp?: boolean;
}): MessageLinkOpenTarget {
  // 两个 flag 同传时以 forceExternal 为准，避免调用方组合出歧义状态。
  if (input.forceExternal) {
    return "external-browser";
  }

  if (input.forceInApp) {
    return "app-browser";
  }

  return isLocalDevelopmentBrowserUrl(input.href) ? "app-browser" : "external-browser";
}

function shouldPreferHttpForSchemeLessUrl(parsed: URL, explicitPort: string | null): boolean {
  if (isLocalDevelopmentHost(parsed.hostname)) {
    return true;
  }

  if (explicitPort && explicitPort !== "443") {
    return true;
  }

  return false;
}

function inferBrowserUrl(input: string): string {
  const normalizedInput = normalizeBareIpv6LoopbackInput(input);
  const parsed = parseSchemeLessUrl(normalizedInput);
  const protocol =
    parsed && shouldPreferHttpForSchemeLessUrl(parsed, getSchemeLessExplicitPort(normalizedInput))
      ? "http"
      : "https";
  return normalizedInput.startsWith("//")
    ? `${protocol}:${normalizedInput}`
    : `${protocol}://${normalizedInput}`;
}

export function normalizeBrowserUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  // 地址栏原来把所有无协议输入都补成 https://，导致 localhost、
  // 127.0.0.1 和常见开发端口无法直接打开。这里按浏览器地址栏习惯先识别
  // 本机/私网/带端口地址，默认走 HTTP；公网域名仍保持 HTTPS 优先。
  if (hasDisallowedExplicitProtocol(trimmed)) {
    return null;
  }

  const url = hasAllowedExplicitProtocol(trimmed) ? trimmed : inferBrowserUrl(trimmed);
  return isAllowedBrowserUrl(url) ? url : null;
}

export function displayBrowserUrl(url: string): string {
  return url === DEFAULT_BROWSER_URL ? "" : browserPreviewSourceUrl(url);
}
