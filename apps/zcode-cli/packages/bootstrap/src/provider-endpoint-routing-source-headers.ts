import { readFile } from "node:fs/promises";
import { arch as readOsArch, homedir, release as readOsRelease } from "node:os";
import { join } from "node:path";
import {
  buildZCodeSourceHeadersFromContext,
  resolveRuntimeZCodeEndpointOrigin,
  resolveRuntimeZCodeEnv,
  ZCODE_APP_VERSION_ENV,
} from "@zcode/shared";
import {
  resolveClientLanguageForHeaders,
  type ModelProviderSourceTitle,
} from "./model-config.js";

const ZCODE_DATA_BASE_DIR_ENV_KEY = "ZCODE_DATA_BASE_DIR";
const cachedDeviceMidByStateFile = new Map<string, string>();

interface CreateProviderEndpointRoutingSourceHeadersOptions {
  appVersion?: string;
  env?: NodeJS.ProcessEnv;
  sourceTitle?: ModelProviderSourceTitle;
}

export async function createProviderEndpointRoutingSourceHeaders(
  options: CreateProviderEndpointRoutingSourceHeadersOptions = {},
): Promise<Record<string, string>> {
  const env = options.env ?? process.env;
  const deviceMid = await readExistingDeviceMid(resolveTelemetryStateFile(env));
  return buildZCodeSourceHeadersFromContext({
    appVersion: env[ZCODE_APP_VERSION_ENV] ?? options.appVersion,
    arch: readOsArch(),
    // 与模型请求同一取值规则：先认 Desktop 下发的界面语言，再回落 Intl。
    clientLanguage: resolveClientLanguageForHeaders(env) ?? "unknown",
    clientTimezone: resolveClientTimezone(),
    deviceMid,
    endpointOrigin: resolveRuntimeZCodeEndpointOrigin(env),
    osVersion: readOsRelease(),
    platform: process.platform,
    releaseChannel: resolveRuntimeZCodeEnv(env),
    sourceTitle: options.sourceTitle ?? "cli",
  });
}

function resolveClientTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function resolveTelemetryStateFile(env: NodeJS.ProcessEnv): string {
  const dataBaseDir = env[ZCODE_DATA_BASE_DIR_ENV_KEY]?.trim() || homedir();
  return join(dataBaseDir, ".zcode", "v2", "telemetry-state.json");
}

async function readExistingDeviceMid(
  stateFile: string,
): Promise<string | undefined> {
  const cached = cachedDeviceMidByStateFile.get(stateFile);
  if (cached) {
    return cached;
  }

  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as {
      deviceMid?: unknown;
    };
    if (typeof parsed.deviceMid !== "string") {
      return undefined;
    }

    const deviceMid = parsed.deviceMid.trim();
    if (!deviceMid || !/^[\x20-\x7e]+$/.test(deviceMid)) {
      return undefined;
    }

    cachedDeviceMidByStateFile.set(stateFile, deviceMid);
    return deviceMid;
  } catch {
    // deviceMid 由 Desktop telemetry 管理；Agent 只异步复用已存在值，不创建或修改设备身份。
    return undefined;
  }
}
