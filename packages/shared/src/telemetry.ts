import { z } from "zod";
import { redactTelemetryText } from "./telemetryRedaction.js";

const pluginDimensionEnums: Record<string, readonly string[]> = {
  schema_version: ["1"],
  result: ["success", "failure", "cancelled", "noop", "partial"],
  source_type: ["builtin", "official_cdn", "personal", "unknown"],
  publisher_type: ["official", "community", "unknown"],
  entry: [
    "store_list",
    "store_detail",
    "side_pane_market",
    "recommended_prompt",
    "recommended_ui",
    "component_settings",
    "agent_recommendation",
    "unknown",
  ],
  trigger: ["user", "dependency", "automatic", "restore", "sync"],
  scope: ["user", "workspace", "unknown"],
  client_kind: ["desktop", "mobile", "unknown"],
  workspace_kind: ["local", "remote"],
  remote_kind: ["", "ssh", "wsl", "docker", "server"],
  error_category: ["diagnostic", "transport", "timeout", "cancelled", "unknown"],
  plugin_component: ["skill", "mcp", "agent", "command", "hook", "lsp", "ui"],
  remove_cache: ["true", "false", "unknown"],
  decision: ["install", "skip", "cancel"],
  action: [
    "install",
    "uninstall",
    "update",
    "restore",
    "enable",
    "disable",
    "configure",
    "reset_config",
    "source_add",
    "source_remove",
    "source_refresh",
    "sync",
    "store_view",
    "detail_view",
    "search",
    "agent_search",
    "recommend_view",
    "recommend_decision",
    "ui_open_request",
    "ui_ready",
    "ui_close",
    "ui_tool_call",
  ],
};
const pluginIdentifierKeys = new Set([
  "plugin_id",
  "marketplace",
  "version_before",
  "version_after",
  "batch_id",
]);
const pluginNumericKeys = new Set(["duration_ms", "target_count", "result_count"]);
export const PLUGIN_TELEMETRY_EVENTS = [
  "plugin_lifecycle",
  "plugin_discovery",
  "plugin_usage",
  "plugin_runtime_error",
] as const;

/** 只清洗上报副本；拒绝任意配置/URL/路径和自由错误文本。 */
export function sanitizePluginTelemetryDetail(
  detail: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail).filter(([key, value]) => {
      if (pluginDimensionEnums[key]) return pluginDimensionEnums[key].includes(value);
      if (pluginNumericKeys.has(key)) return /^\d{1,15}$/.test(value);
      return (
        pluginIdentifierKeys.has(key) &&
        value.length <= 256 &&
        /^[A-Za-z0-9@._+:-]+$/.test(value) &&
        redactTelemetryText(value) === value
      );
    }),
  );
}

/** 手机只转发发现行为；管理结果由同一个 Desktop Host 产生。 */
export const mobilePluginDiscoveryTelemetrySchema = z
  .object({
    elementName: z.literal("plugin_discovery"),
    eventRegion: z.literal("app"),
    eventType: z.literal("view"),
    context: z
      .object({
        clientTimezone: z.string().max(128),
        clientLanguage: z.string().max(128),
        screenResolution: z.string().max(64),
      })
      .strict(),
    eventExtraDetail: z
      .object({
        schema_version: z.literal("1"),
        action: z.enum(["store_view", "detail_view", "search"]),
        entry: z.enum(["store_list", "store_detail", "side_pane_market"]),
        client_kind: z.literal("mobile"),
        plugin_id: z
          .string()
          .regex(/^[A-Za-z0-9@._+:-]+$/)
          .max(256)
          .optional(),
        result_count: z
          .string()
          .regex(/^\d{1,15}$/)
          .optional(),
      })
      .strict(),
  })
  .strict();
export type MobilePluginDiscoveryTelemetry = z.infer<typeof mobilePluginDiscoveryTelemetrySchema>;

export const telemetryUiModeSchema = z.enum(["work", "code", "unknown"]);
export type TelemetryUiMode = z.infer<typeof telemetryUiModeSchema>;

export function normalizeTelemetryUiMode(value: unknown): TelemetryUiMode {
  return value === "work" || value === "code" ? value : "unknown";
}

export interface TelemetryRendererContext {
  /** UI 当前界面模式；旧 renderer 缺失时由上报边界归为 unknown。 */
  uiMode?: TelemetryUiMode;
  clientTimezone: string;
  clientLanguage: string;
  screenResolution: string;
}

export interface TelemetryEventPayload {
  elementName: string;
  eventRegion: string;
  eventType: string;
  eventText?: string;
  eventExtraDetail: Record<string, string>;
  userId?: string;
  talkId?: string;
  messageId?: string;
}

export interface RendererTelemetryEventPayload extends TelemetryEventPayload {
  context: TelemetryRendererContext;
}

export interface ArmsCustomEventPayload {
  name: string;
  group: string;
  value?: number;
  properties?: Record<string, string | number | boolean | undefined>;
}

/** desktop main 实际传给 armsRum.sendCustom 的最终参数。 */
export interface FinalArmsCustomEventPayload {
  name: string;
  type: "custom";
  group: string;
  value: number;
  properties: Record<string, string>;
}

/** 仅 E2E test bridge 可读取的 main-process 内存记录。 */
export interface FinalArmsCustomEventE2EEntry {
  sequence: number;
  recordedAt: number;
  payload: FinalArmsCustomEventPayload;
}

export interface ConfigureFinalArmsCustomEventE2ERequest {
  /** 命中后仍进入 ring，但不调用真实 armsRum.sendCustom。 */
  suppressedEventNames: string[];
}

/**
 * URL 配置进入业务埋点前只允许提取 hostname。
 * 无效值和非 HTTP(S) 协议返回空串，避免误把完整 URL、userinfo 或任意文本带入 payload。
 */
export function resolveSafeTelemetryHostname(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 错误原文可能带任意格式密钥；整体丢弃，不用正则猜测秘密边界。 */
export function sanitizeTelemetryErrorMessage(value: string | null | undefined): string {
  return value ? "[redacted]" : "";
}

const MAX_TELEMETRY_SKILL_NAME_LENGTH = 64;
const TELEMETRY_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/**
 * 只用于已解析的 Skill 名称，不能据此信任模型请求参数。
 * 不 trim 或截断，以免把敏感文本残片变成看似合法的标识；出网时再次检查同一规则。
 */
export function sanitizeTelemetrySkillName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TELEMETRY_SKILL_NAME_LENGTH ||
    !TELEMETRY_SKILL_NAME_PATTERN.test(value) ||
    redactTelemetryText(value) !== value
  ) {
    return "unknown";
  }
  return value;
}

/**
 * agent_step.error_code 的取值白名单（docs/monitoring/business-monitoring.md「工具失败原因码」）。
 * CoreErrorType 的 27 个值（与 CLI contracts/src/errors/index.ts 同步，大写 code 转小写即得），
 * Agent 工具包装子 agent 失败时可能露出的 4 个 AgentErrorCode（contracts/src/tools/agent.ts），
 * 以及 CLI telemetry fact 里写死的 code（子会话被用户停止时 turn.terminal 的 USER_INTERRUPT）。
 */
const TOOL_ERROR_NAMED_CODES: ReadonlySet<string> = new Set([
  "session_not_found",
  "session_already_exists",
  "session_corrupted",
  "turn_not_found",
  "turn_in_progress",
  "invalid_turn_phase",
  "turn_cancelled",
  "model_error",
  "model_timeout",
  "model_rate_limited",
  "model_context_exceeded",
  "tool_not_found",
  "tool_execution_failed",
  "tool_timeout",
  "tool_cancelled",
  "tool_max_calls",
  "invalid_input",
  "permission_denied",
  "permission_escalation",
  "permission_timeout",
  "invalid_state_transition",
  "event_out_of_order",
  "projection_corrupted",
  "storage_error",
  "configuration_error",
  "cancelled",
  "unknown_error",
  "agent_subagent_unavailable",
  "agent_background_unavailable",
  "agent_unknown_type",
  "agent_child_runtime_failed",
  "user_interrupt",
]);
const TOOL_HANDLER_NUMERIC_CODE_PATTERN = /^\d{1,4}$/u;
const TOOL_ERROR_HANDLER_CODE_PATTERN = /^h\d{1,4}$/u;

/**
 * 把 CLI 工具终态的 errorCode（ErrorPayload.code ?? type）归一成低基数枚举，原文不出本机：
 * 白名单内的命名 code 转小写；1–4 位纯数字是工具 handler 自己的码（或 provider 数字码，
 * 各工具会重号），写成 `h<数字>`；其余为 `other`；没有 code 为 `unknown`。
 */
export function normalizeToolErrorCode(code: string | null | undefined): string {
  const trimmed = code?.trim();
  if (!trimmed) return "unknown";
  const lower = trimmed.toLowerCase();
  if (TOOL_ERROR_NAMED_CODES.has(lower)) return lower;
  if (TOOL_HANDLER_NUMERIC_CODE_PATTERN.test(trimmed)) return `h${trimmed}`;
  return "other";
}

/** 出网前兜底：只放行 normalizeToolErrorCode 的输出和空串，其余一律 `other`；幂等。 */
export function sanitizeToolErrorCode(value: string): string {
  if (
    value === "" ||
    value === "other" ||
    value === "unknown" ||
    TOOL_ERROR_NAMED_CODES.has(value) ||
    TOOL_ERROR_HANDLER_CODE_PATTERN.test(value)
  ) {
    return value;
  }
  return "other";
}

function sanitizeLoginHostname(value: string): string {
  const hostname = resolveSafeTelemetryHostname(value);
  if (hostname) return hostname;
  // UI 已取过 hostname 时 Core 仍需幂等；只接受精确 hostname，不放行无协议的路径或凭据。
  const normalized = value.trim().toLowerCase();
  return normalized && resolveSafeTelemetryHostname(`https://${normalized}`) === normalized
    ? normalized
    : "";
}

/** 只清洗上报副本；业务错误、授权地址和调用方持有的 detail 不得被修改。 */
export function sanitizeTelemetryEventDetail(
  elementName: string,
  detail: Readonly<Record<string, string>>,
): Record<string, string> {
  if ((PLUGIN_TELEMETRY_EVENTS as readonly string[]).includes(elementName))
    return sanitizePluginTelemetryDetail(detail);
  return Object.fromEntries(
    Object.entries(
      ["app_launch", "app_daily_active", "send_btn", "message_completion", "agent_step"].includes(
        elementName,
      )
        ? { ...detail, ui_mode: normalizeTelemetryUiMode(detail.ui_mode) }
        : detail,
    )
      .filter(
        ([key, value]) =>
          elementName !== "agent_step" ||
          (key !== "plugin_id" && key !== "plugin_component") ||
          key in sanitizePluginTelemetryDetail({ [key]: value }),
      )
      .map(([key, value]) => [
        key,
        key === "error_msg"
          ? sanitizeTelemetryErrorMessage(value)
          : key === "skill_name"
            ? sanitizeTelemetrySkillName(value)
            : elementName === "app_login_ck" && key === "login_url"
              ? sanitizeLoginHostname(value)
              : elementName === "agent_step" && key === "error_code"
                ? sanitizeToolErrorCode(value)
                : value,
      ]),
  );
}

interface TelemetryScreenLike {
  width: number;
  height: number;
}

interface TelemetryWindowLike {
  intlLocale?: string;
  timeZone?: string;
  screen: TelemetryScreenLike;
}

export function collectTelemetryRendererContext(
  options?: TelemetryWindowLike,
): TelemetryRendererContext {
  const resolvedIntlOptions =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions() : undefined;
  const timeZone = options?.timeZone ?? resolvedIntlOptions?.timeZone ?? "UTC";
  const clientLanguage = options?.intlLocale ?? resolvedIntlOptions?.locale ?? "en-US";
  const runtimeScreen = (globalThis as { screen?: TelemetryScreenLike }).screen;
  const screen = options?.screen ?? runtimeScreen ?? { width: 0, height: 0 };

  return {
    clientTimezone: timeZone,
    clientLanguage,
    screenResolution: `${screen.width}x${screen.height}`,
  };
}
