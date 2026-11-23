// ============================================================
// 无法解析的工具 JSON 标记
// ============================================================
// 模型发出的工具入参不是合法 JSON 时，adapter 把它换成带这个标记的 `{}`，executor 据此返回
// 「无法解析的 JSON」错误，不执行工具（docs/model-tool-call-validation.md「Malformed tool input JSON」）。
//
// 为什么是 symbol 键而不是原始字符串或 ModelToolCall 上的字段：tool_use 的 input 会进入 provider 历史与
// 持久化 tool part，字符串在部分协议下不是合法的 tool_use input，冷恢复时也会变成
// `{ value: <字符串> }`，与实时请求不一致；symbol 键不进 JSON，历史、持久化、model-io、协议事件看到的都是
// `{}`，标记只在进程内跟着同一个 input 对象到达 executor，不用在每个调用映射里多传一个字段。

/** 错误正文里展示的原始字符串前缀长度（UTF-16 码元）。 */
export const UNPARSED_TOOL_INPUT_PREVIEW_LENGTH = 200;

const UNPARSED_TOOL_INPUT = Symbol.for("zcode.unparsedToolInput");

export interface UnparsedToolInput {
  /** 原始字符串的前 200 个码元；末尾是高位代理时去掉它。 */
  preview: string;
  /** 原始字符串的 UTF-16 长度。 */
  length: number;
}

export function markUnparsedToolInput(raw: string): Record<string, never> {
  const marked: Record<PropertyKey, unknown> = {};
  marked[UNPARSED_TOOL_INPUT] = {
    preview: previewOf(raw),
    length: raw.length,
  } satisfies UnparsedToolInput;
  return marked as Record<string, never>;
}

export function readUnparsedToolInput(input: unknown): UnparsedToolInput | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  return (input as Record<PropertyKey, UnparsedToolInput | undefined>)[UNPARSED_TOOL_INPUT];
}

function previewOf(raw: string): string {
  const head = raw.slice(0, UNPARSED_TOOL_INPUT_PREVIEW_LENGTH);
  const last = head.charCodeAt(head.length - 1);
  // 不切断代理对：末尾是高位代理时去掉它。
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}
