import { z } from "zod";
import { zcodePluginUserConfigOptionSchema } from "@zcode/shared";
import type { PluginManifest } from "@zcode/contracts";
import { isRecord } from "../helpers.js";

const DEFAULT_VERSION = "0.0.0";
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
// 外部清单的扩展字段不能穿透到 strict 协议；复用已知字段校验，尤其不能丢掉 sensitive。
const pluginUserConfigSchema = z.record(z.string(), zcodePluginUserConfigOptionSchema.strip());

/** manifest 中合法的插件名；不合法时返回 undefined。诊断用它在解析失败时仍标出插件。 */
export function pluginManifestName(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  return PLUGIN_NAME_PATTERN.test(name) ? name : undefined;
}

/** 启动发现与 MCP 配置加载共用的 manifest 身份与字段校验；不合法时抛错。 */
export function parsePluginManifest(parsed: unknown): PluginManifest {
  if (!isRecord(parsed)) throw new Error("Manifest must be a JSON object");
  const name = pluginManifestName(parsed);
  if (name === undefined) {
    const raw = typeof parsed.name === "string" ? parsed.name.trim() : "";
    throw new Error(`Invalid plugin name: ${raw}`);
  }
  return {
    ...parsed,
    name,
    version: typeof parsed.version === "string" ? parsed.version : DEFAULT_VERSION,
    ...(parsed.userConfig !== undefined
      ? { userConfig: pluginUserConfigSchema.parse(parsed.userConfig) }
      : {}),
  } as PluginManifest;
}
