import { TOOL_SEARCH_BETA, type Model, type ToolSearchCapability } from "@zcode/contracts";

const ANTHROPIC_MESSAGES_API_TYPE = "anthropic-messages";

export function resolveToolSearchCapability(
  apiType: string,
  access: { type: string; mode?: string },
): ToolSearchCapability {
  const protocolSupported = apiType === ANTHROPIC_MESSAGES_API_TYPE;
  const codingPlan =
    access.type === "zhipu-coding-plan-api-key" ||
    (access.type === "zhipu-account" &&
      (access.mode === "individual-coding-plan" || access.mode === "team-coding-plan"));
  return Object.freeze({ protocolSupported, defaultEnabled: protocolSupported && codingPlan });
}

export function toolSearchHeaders(headers: Record<string, string> | undefined, enabled?: boolean) {
  if (!enabled) return headers;
  const result = { ...headers };
  const key =
    Object.keys(result).find((name) => name.toLowerCase() === "anthropic-beta") ?? "anthropic-beta";
  result[key] = [
    ...new Set([
      ...(result[key]
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? []),
      TOOL_SEARCH_BETA,
    ]),
  ].join(",");
  return result;
}

/** 模型请求能力只由协议与接入方式决定；core 投影据此选择请求形态。 */
export function resolveModelRequestCapabilities(
  apiType: string,
  access: { type: string; mode?: string },
): NonNullable<Model["requestCapabilities"]> {
  return {
    toolSearch: resolveToolSearchCapability(apiType, access),
    // 只在 Anthropic Messages 协议把提醒并入 tool result；OpenAI 兼容协议保持独立的 user 消息。
    foldRemindersIntoToolResults: apiType === ANTHROPIC_MESSAGES_API_TYPE,
    // Anthropic Messages 的请求不带没有可见内容（只有思考和空白文字）的回复，由 core 投影第一步删除。
    dropReasoningOnlyOrBlankAssistants: apiType === ANTHROPIC_MESSAGES_API_TYPE,
  };
}
