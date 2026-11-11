import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findOfficialMcpReservedHeaders } from "@zcode/shared";
import type {
  McpOAuthConfig,
  McpServerConfig,
  McpServerConfigBase,
  PluginDiagnostic,
  PluginManifest,
  PluginOptionValues,
} from "@zcode/contracts";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import { ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared";
import type { LoadedPlugin } from "./types.js";
import {
  isNotFoundError,
  isPluginOptionValue,
  isRecord,
  resolveInside,
  rethrowPluginMaterialInterrupt,
} from "./helpers.js";
import { buildOfficialProvenance, parseZCodeOfficialAuth } from "./mcp-official-auth.js";

const SUPPORTED_MCP_TYPES = new Set(["stdio", "http", "sse"]);
const TEMPLATE_PATTERN = /\$\{([^}]+)\}/g;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function loadPluginMcpServerDefinitions(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
}): Promise<Record<string, unknown>> {
  const fromFile = await loadMcpServersFromFile(join(input.loaded.rootPath, ".mcp.json"), input);
  const fromManifest = await loadMcpServersFromSpec(input.loaded.manifest.mcpServers, input);
  return { ...fromFile, ...fromManifest };
}

export function resolvePluginMcpServers(input: {
  dataPath: string;
  definitions: Record<string, unknown>;
  diagnostics: PluginDiagnostic[];
  env: Record<string, string | undefined>;
  loaded: LoadedPlugin;
  options: PluginOptionValues;
  workingDirectory: string;
}): Record<string, McpServerConfig> {
  const merged = input.definitions;
  const context = createVariableContext(input);
  const result: Record<string, McpServerConfig> = {};

  for (const [name, server] of Object.entries(merged)) {
    try {
      result[toNamespacedServerName(input.loaded, name)] = resolveMcpServerConfig(server, context, {
        mcpKey: name,
        pluginId: input.loaded.id,
      });
    } catch (error) {
      input.diagnostics.push({
        code:
          error instanceof PluginVariableError
            ? "plugin_variable_missing"
            : "plugin_mcp_server_disabled",
        message: error instanceof Error ? error.message : `Invalid MCP server: ${name}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
    }
  }

  return result;
}

function toNamespacedServerName(loaded: LoadedPlugin, serverName: string): string {
  return `plugin:${loaded.manifest.name}:${serverName}`;
}

async function loadMcpServersFromSpec(
  spec: unknown,
  input: {
    diagnostics: PluginDiagnostic[];
    loaded: LoadedPlugin;
  },
): Promise<Record<string, unknown>> {
  if (spec === undefined) return {};
  if (typeof spec === "string") {
    const path = resolveInside(input.loaded.rootPath, spec);
    if (!path) {
      input.diagnostics.push({
        code: "plugin_component_path_invalid",
        message: `Plugin mcpServers path escapes plugin root: ${spec}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      return {};
    }
    return await loadMcpServersFromFile(path, input);
  }
  if (Array.isArray(spec)) {
    const servers: Record<string, unknown> = {};
    for (const item of spec) Object.assign(servers, await loadMcpServersFromSpec(item, input));
    return servers;
  }
  return normalizeMcpServersShape(spec, input);
}

async function loadMcpServersFromFile(
  path: string,
  input: {
    diagnostics: PluginDiagnostic[];
    loaded: LoadedPlugin;
  },
): Promise<Record<string, unknown>> {
  try {
    return normalizeMcpServersShape(
      input.loaded.materials
        ? await input.loaded.materials.json(path)
        : JSON.parse(await readFile(path, "utf8")),
      input,
    );
  } catch (error) {
    rethrowPluginMaterialInterrupt(error);
    if (isNotFoundError(error)) return {};
    input.diagnostics.push({
      code: "plugin_mcp_read_failed",
      message: error instanceof Error ? error.message : `Failed to read MCP config: ${path}`,
      path,
      pluginId: input.loaded.id,
      severity: "error",
    });
    return {};
  }
}

function normalizeMcpServersShape(
  value: unknown,
  input: {
    diagnostics: PluginDiagnostic[];
    loaded: LoadedPlugin;
  },
): Record<string, unknown> {
  if (!isRecord(value)) {
    input.diagnostics.push({
      code: "plugin_mcp_invalid",
      message: "Plugin MCP config must be an object",
      path: input.loaded.manifestPath,
      pluginId: input.loaded.id,
      severity: "error",
    });
    return {};
  }
  const servers = isRecord(value.mcpServers) ? value.mcpServers : value;
  return Object.fromEntries(Object.entries(servers).filter(([, config]) => isRecord(config)));
}

interface VariableContext {
  dataPath: string;
  env: Record<string, string | undefined>;
  loaded: LoadedPlugin;
  options: PluginOptionValues;
  userConfigDefaults: PluginOptionValues;
  workingDirectory: string;
}

function createVariableContext(input: {
  dataPath: string;
  env: Record<string, string | undefined>;
  loaded: LoadedPlugin;
  options: PluginOptionValues;
  workingDirectory: string;
}): VariableContext {
  return {
    dataPath: input.dataPath,
    env: input.env,
    loaded: input.loaded,
    options: input.options,
    userConfigDefaults: getUserConfigDefaults(input.loaded.manifest),
    workingDirectory: input.workingDirectory,
  };
}

function getUserConfigDefaults(manifest: PluginManifest): PluginOptionValues {
  const defaults: PluginOptionValues = {};
  for (const [key, option] of Object.entries(manifest.userConfig ?? {})) {
    if (isPluginOptionValue(option.default)) defaults[key] = option.default;
  }
  return defaults;
}

function resolveMcpServerConfig(
  server: unknown,
  context: VariableContext,
  identity: { mcpKey: string; pluginId: string },
): McpServerConfig {
  if (!isRecord(server)) throw new Error("MCP server config must be an object");
  const type = typeof server.type === "string" ? server.type : inferMcpType(server);
  if (!SUPPORTED_MCP_TYPES.has(type)) throw new Error(`Unsupported MCP transport: ${type}`);
  // 修复原因：各 transport 分别重建配置曾漏传 alwaysLoad，导致插件常驻工具被延迟。
  // 通用字段只在此解析；source 按 marketplace 归类，兼容 source 为 cache 的官方 CDN 插件。
  const official = context.loaded.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE;
  const baseConfig: McpServerConfigBase = {
    alwaysLoad: typeof server.alwaysLoad === "boolean" ? server.alwaysLoad : undefined,
    enabled: typeof server.enabled === "boolean" ? server.enabled : undefined,
    // 工作区共享的 server 要自己按 _meta.session_id 划分状态，只信任官方插件这样做
    // （文档插件查看面板 spec §8）；其他插件的声明忽略，保持 session isolation。
    isolation:
      official && (server.isolation === "workspace" || server.isolation === "session")
        ? server.isolation
        : undefined,
    timeoutMs: typeof server.timeoutMs === "number" ? server.timeoutMs : undefined,
    source: { kind: official ? "builtin" : "plugin" },
  };

  // zcode_official 允许 http 与 stdio，sse 出现即禁用该 MCP，不静默忽略——静默会让配置作者以为鉴权已生效。
  //
  // stdio 之所以能放开：请求由插件进程自己发出，身份头随每条出站协议消息的 _meta 下发
  // （见 adapters/src/mcp/index.ts）。sse 没有对应通道，继续拒绝。
  const officialAuth = parseZCodeOfficialAuth(server.auth, identity.mcpKey);
  if (officialAuth && type !== "http" && type !== "stdio") {
    throw new Error(
      `MCP server ${identity.mcpKey}: ${officialAuth.type} auth requires type "http" or "stdio", got "${type}"`,
    );
  }

  if (type === "stdio") {
    const command = requireString(server.command, "stdio MCP server requires command");
    // stdio 不走 OAuth 分支，声明 oauth 属无效配置；与 http 一样不做优先级裁决，直接禁用。
    if (officialAuth && server.oauth !== undefined) {
      throw new Error(
        `MCP server ${identity.mcpKey}: ${officialAuth.type} auth cannot be combined with oauth`,
      );
    }
    const env = resolveStringRecord(
      {
        CLAUDE_PROJECT_DIR: context.workingDirectory,
        ZCODE_PLUGIN_DATA: context.dataPath,
        ZCODE_PLUGIN_ROOT: context.loaded.rootPath,
        ZCODE_PROJECT_DIR: context.workingDirectory,
        CLAUDE_PLUGIN_DATA: context.dataPath,
        CLAUDE_PLUGIN_ROOT: context.loaded.rootPath,
        ...(isRecord(server.env) ? server.env : {}),
      },
      context,
      { allowSensitive: true },
    );
    // 插件 manifest 可自定义 env，但插件身份必须由 resolver 权威写入（loaded.id 来自本地 plugin
    // registry，不是可序列化配置），不能让第三方伪造 official zcode-cua 身份后获得只应定向注入给
    // 内置插件的 broker 凭据。manifest env spread 之后覆写，确保 user/manifest 无法覆盖。
    env[ZCODE_PLUGIN_ID_ENV_KEY] = context.loaded.id;
    return {
      ...baseConfig,
      type: "stdio",
      command: resolveTemplate(command, context, { allowSensitive: false }),
      args: Array.isArray(server.args)
        ? server.args
            .filter((arg): arg is string => typeof arg === "string")
            .map((arg) => resolveTemplate(arg, context, { allowSensitive: false }))
        : undefined,
      cwd:
        typeof server.cwd === "string"
          ? resolveTemplate(server.cwd, context, { allowSensitive: false })
          : undefined,
      env,
      ...(officialAuth
        ? {
            auth: officialAuth,
            // provenance 由宿主生成；即便 .mcp.json 里写了 official 字段也会被此处覆盖。
            official: buildOfficialProvenance(identity),
          }
        : {}),
    };
  }

  const url = requireString(server.url, `${type} MCP server requires url`);
  const headers = isRecord(server.headers)
    ? resolveStringRecord(server.headers, context, { allowSensitive: true })
    : undefined;
  const oauth = resolveMcpOAuthConfig(server.oauth, context);

  if (officialAuth) {
    // 第一阶段不做优先级裁决：两种鉴权同时声明属于配置错误，直接禁用。
    if (oauth) {
      throw new Error(
        `MCP server ${identity.mcpKey}: ${officialAuth.type} auth cannot be combined with oauth`,
      );
    }
    // 保留头只在官方鉴权路径下拦截。普通/第三方 MCP 静态携带 authorization 是既有合法用法，
    // 全局拦截会造成回归。
    const reserved = findOfficialMcpReservedHeaders(headers);
    if (reserved.length > 0) {
      throw new Error(
        `MCP server ${identity.mcpKey}: static headers must not contain reserved header(s): ${reserved.join(", ")}`,
      );
    }
    return {
      ...baseConfig,
      type: "http",
      url: resolveTemplate(url, context, { allowSensitive: false }),
      headers,
      auth: officialAuth,
      // provenance 由宿主生成；即便 .mcp.json 里写了 official 字段也会被此处覆盖。
      official: buildOfficialProvenance(identity),
    };
  }

  return {
    ...baseConfig,
    type,
    url: resolveTemplate(url, context, { allowSensitive: false }),
    headers,
    oauth,
  } as McpServerConfig;
}

/**
 * 严格解析 `auth` 的实现已移到 mcp-official-auth.ts（mcp.ts 已到 max-lines 上限）。
 */
function resolveMcpOAuthConfig(
  value: unknown,
  context: VariableContext,
): McpOAuthConfig | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "client_credentials") {
    return {
      type: "client_credentials",
      clientId: resolveTemplate(
        requireString(value.clientId, "MCP OAuth client_credentials requires clientId"),
        context,
        { allowSensitive: false },
      ),
      clientSecret: resolveTemplate(
        requireString(value.clientSecret, "MCP OAuth client_credentials requires clientSecret"),
        context,
        { allowSensitive: true },
      ),
      ...(typeof value.clientName === "string"
        ? {
            clientName: resolveTemplate(value.clientName, context, { allowSensitive: false }),
          }
        : {}),
      ...(typeof value.scope === "string"
        ? {
            scope: resolveTemplate(value.scope, context, { allowSensitive: false }),
          }
        : {}),
    };
  }
  if (value.type === "authorization_code") {
    return {
      type: "authorization_code",
      ...(typeof value.clientId === "string"
        ? {
            clientId: resolveTemplate(value.clientId, context, { allowSensitive: false }),
          }
        : {}),
      ...(typeof value.clientSecret === "string"
        ? {
            clientSecret: resolveTemplate(value.clientSecret, context, { allowSensitive: true }),
          }
        : {}),
      ...(typeof value.clientName === "string"
        ? {
            clientName: resolveTemplate(value.clientName, context, { allowSensitive: false }),
          }
        : {}),
      ...(typeof value.redirectPath === "string"
        ? {
            redirectPath: resolveTemplate(value.redirectPath, context, { allowSensitive: false }),
          }
        : {}),
      ...(typeof value.scope === "string"
        ? {
            scope: resolveTemplate(value.scope, context, { allowSensitive: false }),
          }
        : {}),
    };
  }
  throw new Error(`Unsupported MCP OAuth type: ${String(value.type)}`);
}

function inferMcpType(server: Record<string, unknown>): string {
  return typeof server.command === "string" ? "stdio" : "http";
}

function requireString(value: unknown, message: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(message);
}

function resolveStringRecord(
  record: Record<string, unknown>,
  context: VariableContext,
  options: { allowSensitive: boolean },
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") result[key] = resolveTemplate(value, context, options);
  }
  return result;
}

function resolveTemplate(
  value: string,
  context: VariableContext,
  options: { allowSensitive: boolean },
): string {
  return value.replace(TEMPLATE_PATTERN, (match, name: string) => {
    switch (name) {
      case "CLAUDE_PLUGIN_ROOT":
      case "ZCODE_PLUGIN_ROOT":
        return context.loaded.rootPath;
      case "CLAUDE_PLUGIN_DATA":
      case "ZCODE_PLUGIN_DATA":
        return context.dataPath;
      case "CLAUDE_PROJECT_DIR":
      case "ZCODE_PROJECT_DIR":
        return context.workingDirectory;
      case "CLAUDE_CODE_SESSION_ID":
      case "CLAUDE_SESSION_ID":
      case "ZCODE_SESSION_ID":
        throw new PluginVariableError(
          `Plugin variable requires a runtime session context: ${name}`,
        );
      case "CLAUDE_SKILL_DIR":
      case "ZCODE_SKILL_DIR":
        throw new PluginVariableError(`Plugin variable requires a skill context: ${name}`);
      default:
        break;
    }

    if (name.startsWith("user_config.")) {
      const key = name.slice("user_config.".length);
      if (
        context.loaded.manifest.userConfig?.[key]?.sensitive === true &&
        !options.allowSensitive
      ) {
        throw new PluginVariableError(
          `Sensitive plugin user_config value cannot be used in this field: ${key}`,
        );
      }
      const configValue = context.options[key] ?? context.userConfigDefaults[key];
      if (configValue === undefined) {
        throw new PluginVariableError(`Missing plugin user_config value: ${key}`);
      }
      return String(configValue);
    }
    if (name.startsWith("ZCODE_")) {
      const envValue = context.env[name];
      if (envValue === undefined)
        throw new PluginVariableError(`Missing environment variable: ${name}`);
      return envValue;
    }
    if (options.allowSensitive && ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
      // token。只在敏感 sink 解析，避免 secret 被展开到 args、URL 或其它可见字段。
      const envValue = context.env[name];
      if (envValue === undefined)
        throw new PluginVariableError(`Missing environment variable: ${name}`);
      return envValue;
    }

    return match;
  });
}

class PluginVariableError extends Error {}
