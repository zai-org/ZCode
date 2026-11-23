// ============================================================
// WaitForMcpServers Tool - 等待仍在连接的 MCP server
// ============================================================
//
// ToolSearch 关闭时没有连接中公告，模型靠本工具等待仍在连接的 server。
// 输入 schema 与描述是固定字节（tools 段进入缓存前缀），规则见 docs/mcp-async-tool-catalog-cache.md。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const WAIT_FOR_MCP_SERVERS_TOOL_NAME = "WaitForMcpServers";

export const WaitForMcpServersInputSchema = z.object({
  servers: z
    .array(z.string())
    .optional()
    .describe("Server names to wait for (default: all pending)"),
});

export type WaitForMcpServersInput = z.infer<typeof WaitForMcpServersInputSchema>;

export const WaitForMcpServersInputJsonSchema = toToolJsonSchema(WaitForMcpServersInputSchema);

export const WaitForMcpServersOutputSchema = z
  .object({
    ready: z.boolean(),
    connected: z.array(z.string()),
    failed: z.array(z.string()),
    stillPending: z.array(z.string()),
    needsAuth: z.array(z.string()),
    disabled: z.array(z.string()),
    unknown: z.array(z.string()),
    /** provider 的 is_error 由结果的 isError 决定；未就绪时结果文本照常给模型。 */
    isError: z.boolean(),
  })
  .strict();

export type WaitForMcpServersOutput = z.infer<typeof WaitForMcpServersOutputSchema>;

export const WaitForMcpServersOutputJsonSchema = toToolJsonSchema(WaitForMcpServersOutputSchema);
