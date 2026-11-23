import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

export interface CapturedPrompt {
  model?: unknown;
  system?: unknown;
  tools?: unknown;
  messages: Array<{ role: string; content: unknown }>;
}

/** 所有父请求逐一检查工具配对，且相邻请求只能追加历史并保持缓存标记。 */
export function assertParentRequestHistory(requests: CapturedPrompt[]): void {
  for (const [index, request] of requests.entries()) {
    assertCompleteToolHistory(request);
    if (index) assertProviderPrefix(requests[index - 1]!, request);
    else assertRequestCacheBreakpoint(request);
  }
}

function withoutCache(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCache);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, nested]) => [key, withoutCache(nested)]),
  );
}

/** 历史与静态工具保持稳定；异步 MCP 目录允许在普通 step 更新。 */
export function assertProviderPrefix(previous: CapturedPrompt, next: CapturedPrompt): void {
  assert.deepEqual(next.model, previous.model, "父模型不能因 subagent 配置变化而改变");
  assert.deepEqual(next.system, previous.system, "父 system 及其缓存标记必须稳定");
  assertProviderToolContracts(previous.tools, next.tools);
  assertProviderMessageHistory(previous, next);
  assertRequestCacheBreakpoint(previous);
  assertRequestCacheBreakpoint(next);
}

export function assertProviderToolContracts(previous: unknown, next: unknown): void {
  const before = withoutCache(previous);
  const after = withoutCache(next);
  assert.ok(Array.isArray(before) && Array.isArray(after), "请求必须包含工具列表");
  // MCP 后台连接及冷恢复会改变成员；其余定义和仍可见的同名工具不能借此被改写。
  const isStatic = (tool: { name: string }) =>
    !tool.name.startsWith("mcp__") && tool.name !== "WaitForMcpServers";
  assert.deepEqual(after.filter(isStatic), before.filter(isStatic), "内置工具定义必须稳定");
  for (const tool of before) {
    const current: unknown = after.find((candidate) => candidate.name === tool.name);
    if (current) assert.deepEqual(current, tool, `已存在工具 ${tool.name} 的定义必须稳定`);
  }
}

/** child 配置变化允许 headers 改变，已有对话消息仍须完整保留。 */
export function assertProviderMessageHistory(previous: CapturedPrompt, next: CapturedPrompt): void {
  assert.ok(next.messages.length >= previous.messages.length, "历史消息不得减少");
  for (const [index, before] of previous.messages.entries()) {
    const after = next.messages[index]!;
    if (isDeepStrictEqual(withoutCache(before), withoutCache(after))) continue;
    // 相邻 user 会被 provider 合并，只允许在原有最后一条 user 的尾部追加 block。
    assert.equal(index, previous.messages.length - 1, `历史消息 ${index} 被改写`);
    assert.equal(before.role, "user", "只有最后一条 user 可以扩展");
    assert.equal(after.role, "user");
    assert.ok(Array.isArray(before.content) && Array.isArray(after.content));
    assert.ok(after.content.length > before.content.length, "只能追加 user block");
    assert.deepEqual(
      withoutCache(after.content.slice(0, before.content.length)),
      withoutCache(before.content),
    );
  }
}

export function assertRequestCacheBreakpoint(request: CapturedPrompt): void {
  const lastIndex = request.messages.findLastIndex((message) => message.role !== "system");
  assert.ok(lastIndex >= 0);
  const content = request.messages[lastIndex]!.content;
  assert.ok(Array.isArray(content) && content.length > 0);
  assert.deepEqual(
    content.at(-1)?.cache_control,
    { type: "ephemeral" },
    "最后非 system 消息末尾必须保留缓存 breakpoint",
  );
}

export function assertCompleteToolHistory(request: CapturedPrompt): void {
  const pending = new Set<string>();
  for (const message of request.messages) {
    if (message.role === "system") assert.equal(pending.size, 0, "MCS 不得插入未完成工具批次");
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") {
        assert.ok(!pending.has(block.id), "重复 tool_use");
        pending.add(block.id);
      }
      if (block.type === "tool_result")
        assert.ok(pending.delete(block.tool_use_id), "tool_result 缺少 tool_use");
    }
  }
  assert.equal(pending.size, 0, "provider 请求存在缺失的 tool_result");
}
