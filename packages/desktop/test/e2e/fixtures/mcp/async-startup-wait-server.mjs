#!/usr/bin/env node
import { access, appendFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const requireFromMcpAdapter = createRequire(
  new URL("../../../../../../apps/zcode-cli/packages/adapters/package.json", import.meta.url),
);
const { McpServer } = requireFromMcpAdapter("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = requireFromMcpAdapter("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = requireFromMcpAdapter("zod");

const RESULT_PREFIX = "E2E_MCP_ASYNC_WAIT_PONG";
const RELEASE_POLL_MS = 50;
const eventLogPath = process.env.E2E_MCP_ASYNC_WAIT_LOG;
const releaseFile = process.env.E2E_MCP_RELEASE_FILE;

await recordEvent({ event: "started", pid: process.pid, cwd: process.cwd() });
// 测试写入释放文件前不响应 initialize，模拟启动慢的 server；由测试显式放行，不靠固定延迟。
if (releaseFile) {
  while (!(await exists(releaseFile))) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, RELEASE_POLL_MS));
  }
  await recordEvent({ event: "released", pid: process.pid });
}

const server = new McpServer({ name: "e2e-async-startup-wait", version: "0.1.0" });
server.registerTool(
  "ping",
  {
    title: "Async startup ping",
    description: "Returns a deterministic marker after the slow server becomes ready.",
    inputSchema: { marker: z.string() },
    annotations: { destructiveHint: false, idempotentHint: true, readOnlyHint: true },
  },
  async ({ marker }) => {
    await recordEvent({ event: "ping", marker, pid: process.pid });
    return { content: [{ type: "text", text: `${RESULT_PREFIX}:${marker}` }] };
  },
);
await server.connect(new StdioServerTransport());

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function recordEvent(event) {
  if (!eventLogPath) return;
  await mkdir(dirname(eventLogPath), { recursive: true });
  await appendFile(
    eventLogPath,
    `${JSON.stringify({ ...event, ts: new Date().toISOString() })}\n`,
    "utf-8",
  );
}
