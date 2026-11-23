import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { isSubagentColor } from "@/lib/subagentColors.js";
import { BACKGROUND_AGENT_LAUNCH_RECEIPT_PREFIX } from "@/lib/zcodeSessionProjection.js";

type AgentIntl = ReturnType<typeof useZCodeIntl>["intl"];
type AgentToolCall = ToolCallBlockRenderContext["toolCallNode"]["toolCall"];
const DEFAULT_AGENT_TYPE_LABEL = "general-purpose";

export function formatAgentMessage(intl: AgentIntl, id: string, fallback: string) {
  const message = intl.formatMessage({ id });
  // agent 工具块的语言包一旦漏配，SSR/静态渲染会把内部 i18n key 原样打到 UI 上，
  // 不但测试断言会失败，真实界面也会直接暴露实现细节。这里统一回退到稳定术语。
  return message === id ? fallback : message;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function readTextFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => readTextFromUnknown(item))
      .filter((item): item is string => typeof item === "string" && item.length > 0)
      .join("\n");
    return text || undefined;
  }

  if (!isPlainRecord(value)) {
    return undefined;
  }

  const text = readStringField(value, ["text"]);
  if (text) {
    return text;
  }

  return readTextFromUnknown(value.content);
}

function readStringFromNestedRecord(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isPlainRecord(current)) {
      return undefined;
    }
    current = current[key];
  }

  return typeof current === "string" && current.trim().length > 0 ? current.trim() : undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readRecordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (isPlainRecord(value)) {
    return value;
  }

  const text = readTextFromUnknown(value);
  return text ? parseJsonObject(text) : null;
}

function readCodexSubagentNickname(toolCall: AgentToolCall): string | undefined {
  const rawNickname =
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "nickname"]) ??
    readStringFromNestedRecord(toolCall.raw, ["nickname"]);
  if (rawNickname) {
    return rawNickname;
  }

  if (isPlainRecord(toolCall.input)) {
    const inputNickname = readStringField(toolCall.input, ["nickname"]);
    if (inputNickname) {
      return inputNickname;
    }
  }

  const outputText = readTextFromUnknown(toolCall.output);
  if (!outputText) {
    return undefined;
  }

  const parsedOutput = parseJsonObject(outputText);
  if (!parsedOutput) {
    return undefined;
  }

  return readStringField(parsedOutput, ["nickname"]);
}

function isImplementationToolTitle(title: string): boolean {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized === "agent" || normalized === "task" || normalized === "spawn_agent";
}

function readAgentNameFromRecord(value: Record<string, unknown> | null): string | undefined {
  return value
    ? readStringField(value, [
        "agentType",
        "agent_type",
        "subagentType",
        "subagent_type",
        "name",
        "nickname",
      ])
    : undefined;
}

function readAgentPrimaryDescription(value: Record<string, unknown> | null): string | undefined {
  return value ? readStringField(value, ["description", "summary", "message"]) : undefined;
}

export function getAgentKindLabel(
  toolCall: AgentToolCall,
  fallbackLabel: string,
  authoritativeAgentType?: string,
) {
  const outputRecord = readRecordFromUnknown(toolCall.output);
  const inputRecord = isPlainRecord(toolCall.input) ? toolCall.input : null;
  const rawRecord = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const rawName =
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "agentType"]) ??
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "agent_type"]) ??
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "subagent_type"]);

  // 流式 input 的半截 JSON 暂时读不到 subagent_type，若一读不到就按“模型省略字段”
  // 回退 general-purpose，首帧会误报、之后再跳成真实类型。只有 inputPreviewComplete 明确为 true
  // 才能确认字段确实省略；已投影的 subagentRow 类型则作为 runtime 权威结果优先展示。
  const explicitName =
    (authoritativeAgentType?.trim() || undefined) ??
    readAgentNameFromRecord(outputRecord) ??
    readCodexSubagentNickname(toolCall) ??
    readAgentNameFromRecord(inputRecord) ??
    rawName;
  if (explicitName) {
    return explicitName;
  }

  return rawRecord?.inputPreviewComplete === true ? fallbackLabel || DEFAULT_AGENT_TYPE_LABEL : "";
}

export function getAgentColor(toolCall: AgentToolCall) {
  const outputRecord = readRecordFromUnknown(toolCall.output);
  const inputRecord = isPlainRecord(toolCall.input) ? toolCall.input : null;
  const rawColor =
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "color"]) ??
    readStringFromNestedRecord(toolCall.raw, ["color"]) ??
    readAgentColorFromRecord(inputRecord) ??
    readAgentColorFromRecord(outputRecord);

  return rawColor && isSubagentColor(rawColor) ? rawColor : undefined;
}

function readAgentColorFromRecord(value: Record<string, unknown> | null): string | undefined {
  return value ? readStringField(value, ["color", "agentColor", "agent_color"]) : undefined;
}

export function readBackgroundAgentInfo(toolCall: AgentToolCall) {
  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  const meta = raw && isPlainRecord(raw._meta) ? raw._meta : null;
  const zcode = meta && isPlainRecord(meta.zcode) ? meta.zcode : null;
  const zcodeBackgroundAgent =
    zcode && isPlainRecord(zcode.backgroundAgent) ? zcode.backgroundAgent : null;
  const taskNotification =
    zcode && isPlainRecord(zcode.taskNotification) ? zcode.taskNotification : null;
  const backgroundAgent = zcodeBackgroundAgent;
  const input = isPlainRecord(toolCall.input) ? toolCall.input : null;
  const outputRecord = readRecordFromUnknown(toolCall.output);
  const outputText = readTextFromUnknown(toolCall.output);
  const outputFile =
    (taskNotification && readStringField(taskNotification, ["outputFile", "output_file"])) ??
    (backgroundAgent && readStringField(backgroundAgent, ["outputFile", "output_file"])) ??
    (outputRecord && readStringField(outputRecord, ["outputFile", "output_file"])) ??
    outputText?.match(/output_file:\s*([^\s]+)/i)?.[1];
  // 修复原因：原来只认输入的 run_in_background 与回执里的 output_file 行。Agent 总在后台运行后输入里
  // 没有这个字段，父代理没有 Read / Bash 时回执也不带 output_file 行，后台 Agent 卡片因此不显示后台区块；
  // 现在也认结构化输出的 async_launched 与启动回执本身。输入字段只剩旧会话会带。
  const launchedInBackground =
    outputRecord?.status === "async_launched" ||
    outputText?.startsWith(BACKGROUND_AGENT_LAUNCH_RECEIPT_PREFIX) === true;

  if (
    !launchedInBackground &&
    input?.run_in_background !== true &&
    input?.runInBackground !== true &&
    !outputFile
  ) {
    return null;
  }

  return { outputFile };
}

export function getAgentActivityContent(toolCall: AgentToolCall) {
  const taskNotificationResult =
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "taskNotification", "result"]) ??
    readStringFromNestedRecord(toolCall.raw, ["_meta", "zcode", "taskNotification", "summary"]);
  if (taskNotificationResult) {
    // background Agent 的 output_file 是完整 sidechain transcript，
    // task-notification result 才是适合用户阅读的完成摘要。优先展示摘要，避免展开后被 JSONL 淹没。
    return taskNotificationResult;
  }

  return toolCall.content?.trim();
}

export function getAgentPrimaryText(toolCall: AgentToolCall, fallbackLabel: string) {
  const nickname = readCodexSubagentNickname(toolCall);
  if (nickname) {
    return nickname;
  }

  if (typeof toolCall.title === "string" && toolCall.title.trim().length > 0) {
    const title = toolCall.title.trim();
    if (!isImplementationToolTitle(title)) {
      return title;
    }
  }

  if (isPlainRecord(toolCall.input)) {
    const description = readStringField(toolCall.input, ["description"]);
    if (description) {
      return description;
    }

    const subagentType = readStringField(toolCall.input, ["subagent_type"]);
    if (subagentType) {
      return subagentType;
    }

    const agentType = readStringField(toolCall.input, ["agent_type"]);
    if (agentType) {
      return agentType;
    }
  }

  const outputRecord = readRecordFromUnknown(toolCall.output);
  const outputDescription = readAgentPrimaryDescription(outputRecord);
  if (outputDescription) {
    return outputDescription;
  }

  const outputAgentName = readAgentNameFromRecord(outputRecord);
  if (outputAgentName) {
    return outputAgentName;
  }

  return fallbackLabel;
}

export function getAgentPrompt(toolCall: AgentToolCall) {
  if (isPlainRecord(toolCall.input)) {
    const prompt = readStringField(toolCall.input, ["prompt", "message", "description"]);
    if (prompt) {
      return prompt;
    }
  }

  if (typeof toolCall.input === "string" && toolCall.input.trim().length > 0) {
    return toolCall.input.trim();
  }

  return undefined;
}
