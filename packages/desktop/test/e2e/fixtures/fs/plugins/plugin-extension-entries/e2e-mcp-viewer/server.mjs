#!/usr/bin/env node
// E2E MCP App fixture（docs/plugins/extension-host.md §16.5）：不依赖 MCP SDK 的 stdio server。
// - 页面 ui://e2e-mcp-viewer/panel.html：显示最近一次 open_document 的结果（tool-result 的 structuredContent）。
// - 工具 open_document({ path })：MCP App 查看器的约定，只给页面用（visibility app）。
//   每次调用追加一行到插件目录旁的 e2e-mcp-viewer-calls.jsonl，E2E 读它确认收到的 path。
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const callsFile = join(root, "..", "e2e-mcp-viewer-calls.jsonl");
const PAGE_URI = "ui://e2e-mcp-viewer/panel.html";
const PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        padding: 16px;
        font: 13px/1.5 system-ui, sans-serif;
        color: var(--color-text-primary, #1f2328);
        background: var(--color-background-primary, transparent);
      }
      h1 { margin: 0 0 8px; font-size: 15px; }
      #opened { font-family: ui-monospace, monospace; color: var(--color-text-secondary, #59636e); }
    </style>
  </head>
  <body data-ready="0" data-opened-path="">
    <h1>E2E MCP panel</h1>
    <div id="opened">No document</div>
    <script>
      const host = window.zcode;
      const render = () => {
        const variables = host.hostContext?.styles?.variables ?? {};
        for (const [name, value] of Object.entries(variables)) {
          if (typeof value === "string") document.documentElement.style.setProperty(name, value);
        }
        const opened = host.toolOutput?.opened ?? "";
        document.body.dataset.openedPath = opened;
        document.getElementById("opened").textContent = opened ? "Opened " + opened : "No document";
      };
      host.subscribe(render);
      host.ready().then(() => {
        document.body.dataset.ready = "1";
        render();
      });
    </script>
  </body>
</html>`;

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
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "e2e-mcp-viewer", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "open_document",
            description: "Open a workspace file in the E2E viewer page",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
            annotations: { readOnlyHint: true },
            _meta: { ui: { visibility: ["app"] } },
          },
        ],
      },
    });
    return;
  }
  if (method === "tools/call" && params?.name === "open_document") {
    const path = String(params.arguments?.path ?? "");
    await appendFile(
      callsFile,
      JSON.stringify({ tool: "open_document", path, at: Date.now() }) + "\n",
    );
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `E2E_OPEN_DOCUMENT ${path}` }],
        structuredContent: { opened: path },
      },
    });
    return;
  }
  if (method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        resources: [
          { uri: PAGE_URI, name: "E2E MCP panel", mimeType: "text/html;profile=mcp-app" },
        ],
      },
    });
    return;
  }
  if (method === "resources/read") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        contents: [{ uri: params.uri, mimeType: "text/html;profile=mcp-app", text: PAGE }],
      },
    });
    return;
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
});
