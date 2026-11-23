/* eslint-disable max-lines -- zcode-cli 配置 schema 需要集中维护文件解析和 provider 继承，拆散会让配置语义更难对齐。 */
import { z } from "zod";
import type { RuntimeConfigPatch } from "@zcode/contracts";

const stringRecordSchema = z.record(z.string(), z.string());
const unknownRecordSchema = z.record(z.string(), z.unknown());
const positiveNumberSchema = z.number().finite().positive();
const positiveIntegerSchema = z.number().int().positive();
const modelStreamSchema = z.object({
  idleTimeoutMs: positiveNumberSchema.optional(),
});

const permissionSchema = z.object({
  mode: z.enum(["plan", "build", "edit", "yolo", "guarded", "auto"]).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  autoApproveHighRisk: z.boolean().optional(),
  allowMediumRiskInAuto: z.boolean().optional(),
});

const storageSchema = z.object({
  dir: z.string().min(1).optional(),
  sessionDbPath: z.string().min(1).optional(),
});

const networkSchema = z.object({
  httpProxy: z.string().min(1).optional(),
  noProxy: z.string().min(1).optional(),
  caCertFile: z.string().min(1).optional(),
  timeout: positiveNumberSchema.optional(),
});

const featuresSchema = z.object({
  compact: z.boolean().optional(),
  rewind: z.boolean().optional(),
  subagent: z.boolean().optional(),
  memory: z.boolean().optional(),
  skill: z.boolean().optional(),
  mcp: z.boolean().optional(),
});

const memorySchema = z.object({
  use: z.boolean().optional(),
});

const mcpServerBaseSchema = {
  alwaysLoad: z.boolean().optional(),
  // Host DTO 和连接池已有 isolation；文件解析不能丢弃整条已支持的声明。
  isolation: z.enum(["session", "workspace"]).optional(),
  // 设置页和 MCP adapter 已支持协议选择；配置入口漏掉该字段会因 strict 校验丢弃整个 server。
  protocolVersion: z.enum(["auto", "legacy", "2026-07-28"]).optional(),
  enabled: z.boolean().optional(),
  timeoutMs: positiveNumberSchema.optional(),
};

const mcpOAuthSchema = z.union([
  z
    .object({
      type: z.literal("client_credentials"),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      clientName: z.string().min(1).optional(),
      scope: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("authorization_code"),
      clientId: z.string().min(1).optional(),
      clientSecret: z.string().min(1).optional(),
      clientName: z.string().min(1).optional(),
      redirectPath: z.string().min(1).optional(),
      scope: z.string().optional(),
    })
    .strict(),
]);

const mcpStdioServerSchema = z
  .object({
    ...mcpServerBaseSchema,
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: stringRecordSchema.optional(),
  })
  .strict();

const mcpHttpServerSchema = z
  .object({
    ...mcpServerBaseSchema,
    type: z.literal("http"),
    url: z.string().min(1),
    headers: stringRecordSchema.optional(),
    oauth: mcpOAuthSchema.optional(),
  })
  .strict();

const mcpSseServerSchema = z
  .object({
    ...mcpServerBaseSchema,
    type: z.literal("sse"),
    url: z.string().min(1),
    headers: stringRecordSchema.optional(),
    oauth: mcpOAuthSchema.optional(),
  })
  .strict();

const mcpServerSchema = z.preprocess(
  normalizeMcpServerConfigInput,
  z.discriminatedUnion("type", [mcpStdioServerSchema, mcpHttpServerSchema, mcpSseServerSchema]),
);

const mcpSchema = z.object({
  servers: z.record(z.string(), mcpServerSchema).optional(),
});

const pluginOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const pluginMarketplaceSourceSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("url"),
      url: z.string().min(1),
      headers: stringRecordSchema.optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("github"),
      repo: z.string().min(1),
      ref: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      sparsePaths: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("git"),
      url: z.string().min(1),
      ref: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      sparsePaths: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("npm"),
      package: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("file"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("directory"),
      path: z.string().min(1),
    })
    .strict(),
]);

const pluginsSchema = z.object({
  enabled: z.boolean().optional(),
  dirs: z.array(z.string().min(1)).optional(),
  enabledPlugins: z.record(z.string(), z.boolean()).optional(),
  extraKnownMarketplaces: z
    .record(z.string().min(1), z.object({ source: pluginMarketplaceSourceSchema }).strict())
    .optional(),
  options: z.record(z.string(), z.record(z.string(), pluginOptionValueSchema)).optional(),
  suppressedBuiltins: z.array(z.string().min(1)).optional(),
});

export const LEGACY_CUA_PLUGIN_ID = "zcode-cua@zcode-plugins-official";
export const CANONICAL_CUA_PLUGIN_ID = "computer-use@zcode-plugins-official";

export function canonicalizePluginId(pluginId: string): string {
  return pluginId === LEGACY_CUA_PLUGIN_ID ? CANONICAL_CUA_PLUGIN_ID : pluginId;
}

export function pluginIdAliases(pluginId: string): readonly string[] {
  return canonicalizePluginId(pluginId) === CANONICAL_CUA_PLUGIN_ID
    ? [CANONICAL_CUA_PLUGIN_ID, LEGACY_CUA_PLUGIN_ID]
    : [pluginId];
}

const skillToggleSchema = z.object({
  enable: z.boolean().optional(),
});

// skill / command 可用性覆盖：key 为对应 .md 的绝对路径，enable:false 表示禁用
const skillCommandOverrideSchema = z
  .object({
    enable: z.boolean().optional(),
  })
  .passthrough();
const skillCommandOverridesSchema = z.record(z.string(), skillCommandOverrideSchema);
const skillsSchema = z
  .object({
    enabled: z.boolean().optional(),
    includeInstructions: z.boolean().optional(),
    metadataBudget: positiveNumberSchema.optional(),
    roots: z.array(z.string()).optional(),
  })
  .catchall(skillToggleSchema);

const loggingSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  format: z.enum(["text", "json"]).optional(),
});

const uiSchema = z.object({
  locale: z.enum(["auto", "en-US", "zh-CN"]).optional(),
  theme: z.enum(["auto", "dark", "light"]).optional(),
});

const toolConcurrencySchema = z.object({
  maxConcurrency: positiveNumberSchema.optional(),
});

const modelAnomalyGuardSchema = z.object({
  toolCallWarningThreshold: positiveIntegerSchema.optional(),
  repeatedToolCallWarningThreshold: positiveIntegerSchema.optional(),
  maxBudgetWarningsPerTurn: z.number().int().nonnegative().optional(),
});

// Hooks schema：
// 理想态是 re-export shared/workspace-hook-config，但两个 pnpm workspace 解析出物理
// 不同的 zod 实例（adapters 4.4.3 / shared 4.3.6）：shared schema 嵌入本包组合 schema
// 会让 dts 引用 foreign zod 内部类型（TS2742），typeof/ZodType 注解都会落入类型循环。
// 因此本副本按原样保留（本包 zod 构造），并保持与 shared 的校验语义等价；
// 运行时校验语义仍以 shared 为准（discovery/trust 装配入口都走 shared schema——
// 本 schema 只负责配置文件装载诊断）。若未来统一 zod 实例，应删除本副本改 re-export。
export const hookProcessSchema = z
  .object({
    type: z.literal("process"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    args: z.array(z.string()).optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
    onError: z.enum(["allow", "deny"]).optional(),
  })

  .passthrough();

export const hookCommandSchema = z
  .object({
    type: z.literal("command"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    async: z.boolean().optional(),
    shell: z.union([z.literal(true), z.string().min(1)]).optional(),
    timeout: positiveNumberSchema.optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
    onError: z.enum(["allow", "deny"]).optional(),
  })
  .passthrough();

export const hookMatcherSchema = z
  .object({
    // 旧配置用空串表示无筛选；拒绝空串会让整份用户配置失效。
    matcher: z
      .string()
      .transform((matcher) => matcher || undefined)
      .optional(),
    hooks: z.array(z.discriminatedUnion("type", [hookProcessSchema, hookCommandSchema])).min(1),
  })
  .strict();

export const hooksSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: positiveNumberSchema.optional(),
    maxOutputBytes: positiveNumberSchema.optional(),
    events: z
      .object({
        SessionStart: z.array(hookMatcherSchema).optional(),
        UserPromptSubmit: z.array(hookMatcherSchema).optional(),
        PreToolUse: z.array(hookMatcherSchema).optional(),
        PermissionRequest: z.array(hookMatcherSchema).optional(),
        PostToolUse: z.array(hookMatcherSchema).optional(),
        PostToolUseFailure: z.array(hookMatcherSchema).optional(),
        Stop: z.array(hookMatcherSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ZCodeConfigFileSchema = z
  .object({
    $schema: z.string().optional(),
    modelStream: modelStreamSchema.optional(),
    permission: permissionSchema.optional(),
    storage: storageSchema.optional(),
    network: networkSchema.optional(),
    features: featuresSchema.optional(),
    memory: memorySchema.optional(),
    mcp: mcpSchema.optional(),
    plugins: pluginsSchema.optional(),
    skills: skillsSchema.optional(),
    skill: skillCommandOverridesSchema.optional(),
    command: skillCommandOverridesSchema.optional(),
    logging: loggingSchema.optional(),
    ui: uiSchema.optional(),
    toolConcurrency: toolConcurrencySchema.optional(),
    modelAnomalyGuard: modelAnomalyGuardSchema.optional(),
    hooks: hooksSchema.optional(),
  })
  .passthrough();

// 项目曾复用用户配置 schema，可改写代理、CA 和插件存储根目录。只开放扩展声明，
// 在校验前剔除运行参数，防止新增用户字段自动向项目开放，也避免无效的禁用字段拖垮 MCP/Hook。
const projectConfigFileSchema = ZCodeConfigFileSchema.pick({
  mcp: true,
  hooks: true,
  skill: true,
  command: true,
})
  .extend({
    // 插件选项可展开为解释器、命令和环境变量；已安装插件不能替仓库输入建立信任。
    // 项目级显式设置由用户私有存储提供，仓库 options 连校验也不参与，避免坏值拖垮其它声明。
    plugins: pluginsSchema
      .pick({ enabledPlugins: true })
      .extend({
        // 项目 plugins.dirs 只是待信任候选，不进入可执行配置（normalizeProjectConfig 再剥离）；
        // 非法值按缺省处理，不能拖垮同文件的其它声明。
        dirs: z
          .preprocess(
            (value) =>
              Array.isArray(value)
                ? value.filter((item) => typeof item === "string" && item.trim().length > 0)
                : undefined,
            z.array(z.string()).optional(),
          )
          .optional(),
      })
      .optional(),
    skills: z
      .preprocess(
        (value) =>
          isPlainRecord(value)
            ? Object.fromEntries(
                Object.entries(value).filter(([path]) => isAbsoluteConfigPath(path)),
              )
            : value,
        z.record(z.string(), skillToggleSchema),
      )
      .optional(),
  })
  .strip();

export type ZCodeConfigFile = z.infer<typeof ZCodeConfigFileSchema>;

type SkillCommandOverrideMap = Record<string, { enable?: boolean }>;

export type ConfigDiagnosticSeverity = "warning" | "error";
export type ConfigDiagnosticCode =
  | "config_file_invalid"
  | "config_mcp_server_invalid"
  | "config_project_hooks_pending_trust";

export interface ConfigDiagnostic {
  code: ConfigDiagnosticCode;
  filePath?: string;
  message: string;
  path?: string;
  severity: ConfigDiagnosticSeverity;
}

export interface ParseConfigFileResult {
  config: RuntimeConfigPatch;
  diagnostics: ConfigDiagnostic[];
}

function normalizeMcpServerConfigInput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const server = { ...(value as Record<string, unknown>) };
  if (!("env" in server) && "environment" in server) {
    // 旧配置和部分外部导入使用 environment；运行态只消费 env。
    // 在解析入口归一化，避免一个 legacy MCP server 拖垮整份 config。
    server.env = server.environment;
  }
  delete server.environment;

  if (typeof server.enable === "boolean" || typeof server.enabled === "boolean") {
    // 历史遗留兜底：桌面端早期把停用状态写成 enable，而契约字段一直是 enabled。
    // 桌面端与 mcp-sync 现在只写 enabled，并在加载配置时把存量 enable 就地迁移落盘；
    // CLI 是只读解析、不能写盘，这里只覆盖「用户先跑 CLI、还没开过桌面端」的窗口。
    // 冲突时以「停用」为准：桌面端写 enable:false 时不会清理外部导入残留的 enabled:true，
    // 按 enabled 取值会把用户关掉的 server 重新拉起（停用了还在被调用）。
    // 存量配置迁移完毕后，这段连同下面的 delete 可以整块删除。
    server.enabled = server.enable === false ? false : (server.enabled ?? true);
  }
  delete server.enable;

  // External MCP configs may carry provider-specific timeout fields. ZCode does not migrate
  // those values, but the strict runtime schema should still accept old imported entries.
  delete server.timeout;
  delete server.startup_timeout_sec;

  if (server.type === "remote") {
    // 外部 Agent 配置常把 HTTP MCP 标记为 remote；ZCode 运行态协议类型是 http。
    server.type = "http";
  } else if (typeof server.type !== "string") {
    // app 管理层把 command 形态视为默认 stdio；CLI 也需要同样推断，
    // 否则历史 app 配置缺少 type 时会阻断模型配置加载。
    if (typeof server.command === "string" && server.command.trim().length > 0) {
      server.type = "stdio";
    } else if (typeof server.url === "string" && server.url.trim().length > 0) {
      server.type = "http";
    }
  }

  if (
    (server.type === "http" || server.type === "sse") &&
    server.headers === undefined &&
    server.http_headers !== undefined
  ) {
    // 兼容历史 BigModel MCP 配置：旧字段名是 http_headers，agent runtime 只消费 headers。
    server.headers = server.http_headers;
  }
  delete server.http_headers;

  return server;
}

export function parseConfigFileToRuntimePatchWithDiagnostics(
  value: unknown,
  scope: "user" | "project" = "user",
): ParseConfigFileResult {
  const diagnostics: ConfigDiagnostic[] = [];
  const normalized = normalizeConfigFileInput(value, diagnostics);
  const parsed = (scope === "project" ? projectConfigFileSchema : ZCodeConfigFileSchema).parse(
    normalized,
  );
  return {
    config: parsedConfigFileToRuntimePatch(parsed),
    diagnostics,
  };
}

function parsedConfigFileToRuntimePatch(parsed: ZCodeConfigFile): RuntimeConfigPatch {
  const config: RuntimeConfigPatch = {};
  if (parsed.modelStream) config.modelStream = parsed.modelStream;

  if (parsed.permission) config.permission = parsed.permission;
  if (parsed.storage) config.storage = parsed.storage;
  if (parsed.network) config.network = parsed.network;
  if (parsed.features) config.features = parsed.features;
  if (parsed.memory) config.memory = parsed.memory;
  if (parsed.mcp) config.mcp = parsed.mcp;
  if (parsed.plugins) config.plugins = normalizePluginConfig(parsed.plugins);
  const skillsConfig = parseSkillsRuntimeConfig(parsed.skills);
  if (skillsConfig) config.skills = skillsConfig;
  const skillOverrides = mergeSkillCommandOverrides(
    parsed.skill,
    parseSkillOverridesFromPluralSkills(parsed.skills),
  );
  if (skillOverrides) config.skillOverrides = skillOverrides;
  if (parsed.command) config.commandOverrides = parsed.command;
  if (parsed.logging) config.logging = parsed.logging;
  if (parsed.ui) config.ui = parsed.ui;
  if (parsed.toolConcurrency) config.toolConcurrency = parsed.toolConcurrency;
  if (parsed.modelAnomalyGuard) config.modelAnomalyGuard = parsed.modelAnomalyGuard;
  if (parsed.hooks) config.hooks = parsed.hooks;

  return config;
}

function normalizePluginConfig(
  plugins: ZCodeConfigFile["plugins"],
): NonNullable<RuntimeConfigPatch["plugins"]> {
  if (!plugins) return {};
  const enabledPlugins = plugins.enabledPlugins ? { ...plugins.enabledPlugins } : undefined;
  if (enabledPlugins?.[LEGACY_CUA_PLUGIN_ID] !== undefined) {
    if (enabledPlugins[CANONICAL_CUA_PLUGIN_ID] === undefined) {
      enabledPlugins[CANONICAL_CUA_PLUGIN_ID] = enabledPlugins[LEGACY_CUA_PLUGIN_ID];
    }
    delete enabledPlugins[LEGACY_CUA_PLUGIN_ID];
  }
  const suppressedBuiltins = plugins.suppressedBuiltins
    ? plugins.suppressedBuiltins.reduce<string[]>((ids, id) => {
        const canonicalId = id === LEGACY_CUA_PLUGIN_ID ? CANONICAL_CUA_PLUGIN_ID : id;
        if (canonicalId === CANONICAL_CUA_PLUGIN_ID && ids.includes(CANONICAL_CUA_PLUGIN_ID)) {
          return ids;
        }
        ids.push(canonicalId);
        return ids;
      }, [])
    : undefined;
  const options = plugins.options ? { ...plugins.options } : undefined;
  if (options?.[LEGACY_CUA_PLUGIN_ID] !== undefined) {
    if (options[CANONICAL_CUA_PLUGIN_ID] === undefined) {
      options[CANONICAL_CUA_PLUGIN_ID] = options[LEGACY_CUA_PLUGIN_ID];
    }
    delete options[LEGACY_CUA_PLUGIN_ID];
  }
  return {
    ...plugins,
    ...(enabledPlugins ? { enabledPlugins } : {}),
    ...(suppressedBuiltins ? { suppressedBuiltins } : {}),
    ...(options ? { options } : {}),
  };
}

function normalizeConfigFileInput(value: unknown, diagnostics: ConfigDiagnostic[]): unknown {
  if (!isPlainRecord(value)) return value;

  const root = { ...value };
  const mcp = root.mcp;
  if (!isPlainRecord(mcp)) return root;

  const servers = mcp.servers;
  if (servers === undefined) return root;

  if (!isPlainRecord(servers)) {
    diagnostics.push({
      code: "config_mcp_server_invalid",
      message: "mcp.servers must be a JSON object; ignoring all MCP servers.",
      path: "mcp.servers",
      severity: "warning",
    });
    root.mcp = {
      ...mcp,
      servers: {},
    };
    return root;
  }

  const parsedServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const parsed = mcpServerSchema.safeParse(server);
    if (parsed.success) {
      parsedServers[name] = parsed.data;
      continue;
    }

    // MCP server 是可选工具配置，单个 server 错误不应导致 provider/plugin 等配置丢失。
    diagnostics.push({
      code: "config_mcp_server_invalid",
      message: formatMcpServerError(parsed.error),
      path: `mcp.servers.${name}`,
      severity: "warning",
    });
  }

  root.mcp = {
    ...mcp,
    servers: parsedServers,
  };
  return root;
}

function formatMcpServerError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<server>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseSkillsRuntimeConfig(
  skills: ZCodeConfigFile["skills"],
): RuntimeConfigPatch["skills"] | undefined {
  if (!skills) return undefined;
  const next: NonNullable<RuntimeConfigPatch["skills"]> = {};
  if (skills.enabled !== undefined) next.enabled = skills.enabled;
  if (skills.includeInstructions !== undefined) {
    next.includeInstructions = skills.includeInstructions;
  }
  if (skills.metadataBudget !== undefined) next.metadataBudget = skills.metadataBudget;
  if (skills.roots !== undefined) next.roots = skills.roots;
  return Object.keys(next).length > 0 ? next : undefined;
}

function parseSkillOverridesFromPluralSkills(
  skills: ZCodeConfigFile["skills"],
): SkillCommandOverrideMap | undefined {
  if (!skills) return undefined;
  const overrides: SkillCommandOverrideMap = {};
  for (const [path, value] of Object.entries(skills)) {
    if (!isAbsoluteConfigPath(path) || !isSkillCommandOverrideValue(value)) {
      continue;
    }
    // 设置页当前把单个 skill 开关写到 skills[SKILL.md 绝对路径]。
    // agent 运行态只消费 skillOverrides，所以这里在配置解析阶段统一映射，避免 UI 状态和 agent 实际加载分叉。
    overrides[path] = { enable: value.enable };
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function mergeSkillCommandOverrides(
  ...overridesList: Array<SkillCommandOverrideMap | undefined>
): SkillCommandOverrideMap | undefined {
  const merged: SkillCommandOverrideMap = {};
  for (const overrides of overridesList) {
    if (!overrides) continue;
    Object.assign(merged, overrides);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function isSkillCommandOverrideValue(value: unknown): value is { enable?: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("enable" in value ? typeof (value as { enable?: unknown }).enable === "boolean" : true)
  );
}

function isAbsoluteConfigPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}
