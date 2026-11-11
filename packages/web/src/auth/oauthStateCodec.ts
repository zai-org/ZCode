import { DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "@zcode/shared";

const PRODUCTION_WEB_REMOTE_ORIGIN = DEFAULT_ZCODE_ENDPOINT_ORIGIN;
const WEB_REMOTE_CALLBACK_PATHS = new Set(["/remote/v4", "/remote/v4/"]);
// 测试入口也经过登录门禁，必须保留原路径与扫码参数；OAuth 回调仍只使用已登记的 v4。
const WEB_REMOTE_APP_PATHS = new Set([
  ...WEB_REMOTE_CALLBACK_PATHS,
  "/remote/__test__",
  "/remote/__test__/",
]);
const WEB_CALLBACK_PATHS = new Set([
  ...WEB_REMOTE_CALLBACK_PATHS,
  "/cn/share/callback",
  "/share/callback",
]);
const SHARE_PATH_PATTERN = /^\/(?:cn\/share|share)\/[A-Za-z0-9._~-]{1,512}$/u;
const APP_RETURN_QUERY_ALLOWLIST = new Set(["app_version", "sid", "mid", "name"]);
const PRIVATE_DEV_RETURN_TO_PATTERN =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?(\/|$)/;

interface OAuthStatePayload {
  nonce: string;
  app_return_to?: string;
  return_to?: string;
}

interface ResolveSafeAppReturnToOptions {
  currentOrigin?: string;
}

function getCurrentOrigin(): string {
  const location = globalThis.window?.location ?? globalThis.location;
  return location?.origin ?? PRODUCTION_WEB_REMOTE_ORIGIN;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
}

export function buildOAuthState(payload: OAuthStatePayload): string {
  return encodeBase64Url(JSON.stringify(payload));
}

export function parseOAuthState(state: string): OAuthStatePayload | null {
  try {
    const parsed = JSON.parse(decodeBase64Url(state)) as Partial<OAuthStatePayload>;
    if (!isNonEmptyString(parsed.nonce)) {
      return null;
    }

    return {
      nonce: parsed.nonce,
      ...(isNonEmptyString(parsed.app_return_to) ? { app_return_to: parsed.app_return_to } : {}),
      ...(isNonEmptyString(parsed.return_to) ? { return_to: parsed.return_to } : {}),
    };
  } catch {
    return null;
  }
}

export function parseOptionalUrl(value?: string): URL | null {
  if (!isNonEmptyString(value)) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isTrustedDevReturnTo(url: URL): boolean {
  return PRIVATE_DEV_RETURN_TO_PATTERN.test(url.toString()) && WEB_CALLBACK_PATHS.has(url.pathname);
}

function resolveAllowedAppReturnOrigin(currentOrigin: string): string {
  return currentOrigin === PRODUCTION_WEB_REMOTE_ORIGIN
    ? PRODUCTION_WEB_REMOTE_ORIGIN
    : currentOrigin;
}

function pickAppReturnQuery(params: URLSearchParams): URLSearchParams {
  const safeSearch = new URLSearchParams();
  for (const key of APP_RETURN_QUERY_ALLOWLIST) {
    const existing = params.get(key);
    if (existing !== null) safeSearch.set(key, existing);
  }
  return safeSearch;
}

export function resolveSafeAppReturnTo(
  value?: string,
  options: ResolveSafeAppReturnToOptions = {},
): string | null {
  const url = parseOptionalUrl(value);
  if (!url || (!WEB_REMOTE_APP_PATHS.has(url.pathname) && !SHARE_PATH_PATTERN.test(url.pathname))) {
    return null;
  }

  const currentOrigin = options.currentOrigin ?? getCurrentOrigin();
  const allowedOrigin = resolveAllowedAppReturnOrigin(currentOrigin);
  if (url.origin !== allowedOrigin) {
    return null;
  }

  if (SHARE_PATH_PATTERN.test(url.pathname)) return url.pathname;

  const query = pickAppReturnQuery(url.searchParams).toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

/** 网关在 JS 执行前选版本；扫码参数必须进入授权回调，不能只留在 state 中。 */
export function buildWebRemoteOAuthRedirectUri(
  redirectUri: string,
  appReturnTo: string,
  options: ResolveSafeAppReturnToOptions = {},
): string {
  const callbackUrl = parseOptionalUrl(redirectUri);
  const sourceUrl = parseOptionalUrl(appReturnTo);
  if (
    !callbackUrl ||
    !WEB_REMOTE_CALLBACK_PATHS.has(callbackUrl.pathname) ||
    !sourceUrl ||
    !WEB_REMOTE_APP_PATHS.has(sourceUrl.pathname) ||
    !resolveSafeAppReturnTo(appReturnTo, options)
  ) {
    return redirectUri;
  }
  callbackUrl.search = pickAppReturnQuery(sourceUrl.searchParams).toString();
  callbackUrl.hash = "";
  return callbackUrl.toString();
}

export function buildReturnToCallbackUrl(
  returnTo: string,
  params: { code?: string; error?: string; state: string },
): string | null {
  const returnToUrl = parseOptionalUrl(returnTo);
  if (!returnToUrl || !isTrustedDevReturnTo(returnToUrl) || !isNonEmptyString(params.state)) {
    return null;
  }

  returnToUrl.search = WEB_REMOTE_CALLBACK_PATHS.has(returnToUrl.pathname)
    ? pickAppReturnQuery(returnToUrl.searchParams).toString()
    : "";
  returnToUrl.hash = "";
  if (isNonEmptyString(params.code)) {
    returnToUrl.searchParams.set("code", params.code);
  }
  if (isNonEmptyString(params.error)) {
    returnToUrl.searchParams.set("error", params.error);
  }
  returnToUrl.searchParams.set("state", params.state);

  return returnToUrl.toString();
}

export function createBrowserNonce(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable");
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
