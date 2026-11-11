import { expect } from "@wdio/globals";

interface ToolBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}
const APP_SESSION_TOOLS = [
  "ListProjects",
  "ListSessions",
  "ReadSession",
  "CreateSession",
  "ForkSession",
  "SendToSession",
  "WaitSessions",
  "InterruptSession",
  "RenameSession",
  "OpenSession",
  "SetSessionArchived",
  "SetSessionPinned",
];
export type AppControlToolEvidence = Record<
  string,
  { call: ToolBlock; result: ToolBlock; parsed: unknown }
>;

/** 只保存实际 provider 请求里的调用与回执，fixture 中提及工具名不算覆盖。 */
export function appControlToolBlock(
  request: unknown,
  type: "tool_result" | "tool_use",
  id: string,
) {
  const messages = (request as { messages: Array<{ content: unknown }> }).messages;
  const block = messages
    .flatMap((message) => (Array.isArray(message.content) ? (message.content as ToolBlock[]) : []))
    .find(
      (item) => item?.type === type && (type === "tool_result" ? item.tool_use_id : item.id) === id,
    );
  if (!block) throw new Error(`SCT missing real ${type}: ${id}`);
  return block;
}

/**
 * Anthropic Messages 投影会把紧随工具结果的提醒折叠进最后一个 tool_result
 * （docs: apps/zcode-cli/docs/design/v2/loop/meta-user-context.md，`foldRemindersIntoToolResults`）。
 * 工具本身的 JSON 在前，提醒以 "\n\n<system-reminder>" 追加；只剥离这一尾部，不改写工具正文。
 */
function stripFoldedReminders(text: string): string {
  const index = text.indexOf("\n\n<system-reminder>");
  return index < 0 ? text : text.slice(0, index);
}

export function readAppControlToolResult<T>(
  request: unknown,
  id: string,
  evidence: AppControlToolEvidence,
): T {
  const call = appControlToolBlock(request, "tool_use", id);
  const result = appControlToolBlock(request, "tool_result", id);
  const text =
    typeof result.content === "string"
      ? result.content
      : (result.content
          ?.filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n") ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFoldedReminders(text));
  } catch {
    parsed = text;
  }
  evidence[id] = { call, result, parsed };
  // 工具名统一后不再带 app_ 前缀；只接受 App 托管 Agent 注册的会话工具。
  expect(APP_SESSION_TOOLS).toContain(call.name);
  expect(result.is_error).not.toBe(true);
  expect(typeof parsed).toBe("object");
  return parsed as T;
}
