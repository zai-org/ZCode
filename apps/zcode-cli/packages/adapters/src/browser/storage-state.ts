import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export type BrowserStateFileErrorCode =
  | "missing"
  | "not_file"
  | "unreadable"
  | "invalid_json"
  | "invalid_schema";

export interface BrowserStateCookie {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitionKey?: string;
  _crHasCrossSiteAncestor?: boolean;
}

export interface BrowserStateOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
  indexedDB?: unknown[];
}

export interface BrowserStorageState {
  cookies?: BrowserStateCookie[];
  origins?: BrowserStateOrigin[];
}

export interface BrowserStateLoadResult {
  state: BrowserStorageState;
  summary: { cookieCount: number; expiredCookieCount: number; originCount: number };
  unknownFields: string[];
  looseMode?: number;
}

export interface LoadBrowserStorageStateOptions {
  platform?: NodeJS.Platform | string;
  nowMs?: () => number;
}

const DEFAULT_BROWSER_STATE_PATH_SEGMENTS = [".zcode", "cli", "browser-state.json"] as const;
const UTF8_BOM = "﻿";
const SESSION_COOKIE_EXPIRES = -1;
const MAX_COOKIE_EXPIRES_SECONDS = 253402300799;
const BLANK_PAGE_URL = "about:blank";
const DATA_URL_PREFIX = "data:";
const MILLISECONDS_PER_SECOND = 1000;
const GROUP_OTHER_PERMISSION_MASK = 0o077;
const PERMISSION_BITS_MASK = 0o777;
const WINDOWS_PLATFORM = "win32";
const ROOT_ISSUE_PATH = "(root)";
const MISSING_FILE_ERRNO_CODES = new Set(["ENOENT", "ENOTDIR"]);
const ALLOWED_ORIGIN_PROTOCOLS = new Set(["http:", "https:"]);

const KNOWN_TOP_LEVEL_FIELDS = ["cookies", "origins"] as const;
const KNOWN_COOKIE_FIELDS = [
  "name",
  "value",
  "url",
  "domain",
  "path",
  "expires",
  "httpOnly",
  "secure",
  "sameSite",
  "partitionKey",
  "_crHasCrossSiteAncestor",
] as const;
const KNOWN_ORIGIN_FIELDS = ["origin", "localStorage", "indexedDB"] as const;
const KNOWN_STORAGE_ITEM_FIELDS = ["name", "value"] as const;

const BROWSER_STATE_ERROR_MESSAGES: Record<BrowserStateFileErrorCode, string> = {
  missing: "Browser state file was not found",
  not_file: "Browser state path is not a regular file",
  unreadable: "Browser state file could not be read",
  invalid_json: "Browser state file is not valid JSON",
  invalid_schema: "Browser state file does not match the Playwright storage state format",
};

export class BrowserStateFileError extends Error {
  override readonly name = "BrowserStateFileError";

  constructor(
    readonly code: BrowserStateFileErrorCode,
    readonly path: string,
    readonly issues: readonly string[] = [],
    options?: { cause?: unknown },
  ) {
    super(BROWSER_STATE_ERROR_MESSAGES[code], options);
  }
}

const cookieSchema = z
  .looseObject({
    name: z.string(),
    value: z.string(),
    url: z.string().min(1).refine(isCookieUrl).optional(),
    domain: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    expires: z
      .number()
      .refine(
        (expires) =>
          expires === SESSION_COOKIE_EXPIRES ||
          (expires > 0 && expires <= MAX_COOKIE_EXPIRES_SECONDS),
      )
      .optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
    partitionKey: z.string().optional(),
    _crHasCrossSiteAncestor: z.boolean().optional(),
  })
  .refine((cookie) =>
    cookie.url === undefined
      ? cookie.domain !== undefined && cookie.path !== undefined
      : cookie.domain === undefined && cookie.path === undefined,
  );

const storageItemSchema = z.looseObject({ name: z.string(), value: z.string() });

const originSchema = z.looseObject({
  origin: z.string().refine(isHttpOrigin),
  localStorage: z.array(storageItemSchema),
  indexedDB: z.array(z.unknown()).optional(),
});

const storageStateSchema = z.looseObject({
  cookies: z.array(cookieSchema).optional(),
  origins: z.array(originSchema).optional(),
});

export function resolveDefaultBrowserStatePath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | string = process.platform,
): string {
  // 与 os.homedir() 同一规则：Windows 只认 USERPROFILE，Git Bash 等环境设置的 HOME 不能改变默认位置。
  const envHome = platform === WINDOWS_PLATFORM ? env.USERPROFILE : env.HOME;
  return join(envHome?.trim() || homedir(), ...DEFAULT_BROWSER_STATE_PATH_SEGMENTS);
}

export async function loadBrowserStorageState(
  path: string,
  options: LoadBrowserStorageStateOptions = {},
): Promise<BrowserStateLoadResult> {
  const stats = await statStateFile(path);
  if (!stats.isFile()) throw new BrowserStateFileError("not_file", path);

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new BrowserStateFileError("unreadable", path, [], { cause: error });
  }

  let json: unknown;
  try {
    json = JSON.parse(text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text);
  } catch {
    // 不附带 cause：JSON.parse 的报错会引用文件片段，可能含 cookie 值。
    throw new BrowserStateFileError("invalid_json", path);
  }

  const parsed = storageStateSchema.safeParse(json);
  if (!parsed.success) {
    const issues = [...new Set(parsed.error.issues.map((issue) => formatIssuePath(issue.path)))];
    throw new BrowserStateFileError("invalid_schema", path, issues);
  }

  const unknownFields = new Set<string>();
  const state = stripUnknownFields(parsed.data, unknownFields);
  const nowMs = options.nowMs ?? Date.now;
  const cookies = state.cookies ?? [];
  const platform = options.platform ?? process.platform;
  const looseMode =
    platform !== WINDOWS_PLATFORM && (stats.mode & GROUP_OTHER_PERMISSION_MASK) !== 0
      ? stats.mode & PERMISSION_BITS_MASK
      : undefined;

  return {
    state,
    summary: {
      cookieCount: cookies.length,
      expiredCookieCount: cookies.filter((cookie) => isExpired(cookie, nowMs())).length,
      originCount: state.origins?.length ?? 0,
    },
    unknownFields: [...unknownFields],
    ...(looseMode === undefined ? {} : { looseMode }),
  };
}

async function statStateFile(path: string): Promise<Stats> {
  try {
    return await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new BrowserStateFileError(
      code && MISSING_FILE_ERRNO_CODES.has(code) ? "missing" : "unreadable",
      path,
      [],
      { cause: error },
    );
  }
}

function isHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return ALLOWED_ORIGIN_PROTOCOLS.has(url.protocol) && url.origin === origin;
  } catch {
    return false;
  }
}

function isCookieUrl(url: string): boolean {
  if (url === BLANK_PAGE_URL || url.startsWith(DATA_URL_PREFIX)) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function isExpired(cookie: BrowserStateCookie, nowMs: number): boolean {
  return (
    cookie.expires !== undefined &&
    cookie.expires !== SESSION_COOKIE_EXPIRES &&
    cookie.expires * MILLISECONDS_PER_SECOND < nowMs
  );
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return ROOT_ISSUE_PATH;
  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${String(segment)}`,
    )
    .join("");
}

function stripUnknownFields(
  data: z.infer<typeof storageStateSchema>,
  unknownFields: Set<string>,
): BrowserStorageState {
  pickKnownFields(data, KNOWN_TOP_LEVEL_FIELDS, "", unknownFields);
  const cookies = data.cookies?.map((cookie) =>
    pickKnownFields<BrowserStateCookie>(cookie, KNOWN_COOKIE_FIELDS, "cookies[].", unknownFields),
  );
  const origins = data.origins?.map((origin) => ({
    ...pickKnownFields<BrowserStateOrigin>(
      origin,
      KNOWN_ORIGIN_FIELDS,
      "origins[].",
      unknownFields,
    ),
    localStorage: origin.localStorage.map((item) =>
      pickKnownFields<BrowserStateOrigin["localStorage"][number]>(
        item,
        KNOWN_STORAGE_ITEM_FIELDS,
        "origins[].localStorage[].",
        unknownFields,
      ),
    ),
  }));
  return {
    ...(cookies ? { cookies } : {}),
    ...(origins ? { origins } : {}),
  };
}

function pickKnownFields<T>(
  value: Record<string, unknown>,
  knownFields: readonly string[],
  prefix: string,
  unknownFields: Set<string>,
): T {
  const picked: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (knownFields.includes(key)) picked[key] = fieldValue;
    else unknownFields.add(`${prefix}${key}`);
  }
  return picked as T;
}
