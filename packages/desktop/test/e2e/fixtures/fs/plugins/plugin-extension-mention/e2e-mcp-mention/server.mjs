#!/usr/bin/env node
// E2E MCP fixture（docs/plugins/extension-host.md §16.6）：不依赖 MCP SDK 的 stdio server。
// 工具 mention_search({ query })：只给宿主调（visibility app），composer.mention 的 tool target。
// 返回 structuredContent.items（CLI 按 plugins/mentionItems 的严格 schema 校验）。
// 启动与每次调用各追加一行到插件目录旁的 e2e-mcp-mention-calls.jsonl，E2E 读它确认收到的 query。
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const callsFile = join(root, "..", "e2e-mcp-mention-calls.jsonl");

const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

input.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "e2e-mcp-mention", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "tools/list") {
    await appendFile(callsFile, JSON.stringify({ event: "listed", at: Date.now() }) + "\n");
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "mention_search",
            description: "Search E2E documents for the composer @ panel",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
            annotations: { readOnlyHint: true },
            _meta: { ui: { visibility: ["app"] } },
          },
        ],
      },
    });
    return;
  }
  if (method === "tools/call" && params?.name === "mention_search") {
    const query = String(params.arguments?.query ?? "");
    await appendFile(
      callsFile,
      JSON.stringify({ event: "call", tool: "mention_search", query, at: Date.now() }) + "\n",
    );
    const tag = query || "all";
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `E2E_MCP_MENTION ${tag}` }],
        structuredContent: {
          items: [1, 2].map((n) => ({
            id: `${tag}-${n}`,
            label: `E2E doc ${tag} #${n}`,
            description: `MCP candidate ${n}`,
            icon: "database",
            insertText: `E2E_MCP_INSERT[${tag}#${n}]`,
          })),
        },
      },
    });
    return;
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
});

// 先登记 line 监听再写启动记录：readline 创建后就开始读，监听前到达的 initialize 会丢掉，
// 连接要等 30 秒超时才失败（第一次运行就是这样）。
void appendFile(callsFile, JSON.stringify({ event: "started", at: Date.now() }) + "\n");
