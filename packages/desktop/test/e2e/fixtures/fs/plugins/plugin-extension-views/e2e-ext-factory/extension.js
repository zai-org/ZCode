// E2E 扩展 fixture：视图写法二（插件自己的 MCP server）。fixture 不带 node_modules，
// 所以手写一个只按结构实现 connect(transport) 的最小 MCP server（McpServerLike），
// 只应答本例用到的方法。真实插件可直接返回 SDK 的 McpServer。
// 激活事件只有自动推导的 onView:factory：首次打开视图时才激活。

const PAGE = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>E2E factory view</title>
    <style>body{margin:0;padding:16px;font:13px/1.5 system-ui,sans-serif;color:var(--color-text-primary,#1f2328)}</style>
  </head>
  <body>
    <h1 style="font-size:15px;margin:0 0 8px">E2E factory view</h1>
    <div id="out">waiting</div>
    <script>
      window.zcode.callTool("ping", {}).then((result) => {
        const data = result.structuredContent ?? {};
        document.body.dataset.pong = data.instance ?? "";
        document.body.dataset.scope = data.scope ?? "";
        document.getElementById("out").textContent = "E2E factory pong scope=" + data.scope;
      });
    </script>
  </body>
</html>`;

function createServer(view, pageUri, log) {
  let transport = null;
  const send = (message) => transport.send({ jsonrpc: "2.0", ...message });
  const handle = async (message) => {
    // 通知（notifications/initialized 等）没有 id，不需要应答。
    if (message.id === undefined || !message.method) return;
    const { id, method, params } = message;
    switch (method) {
      case "initialize":
        return send({
          id,
          result: {
            protocolVersion: params.protocolVersion,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "e2e-ext-factory", version: "1.0.0" },
          },
        });
      case "ping":
        return send({ id, result: {} });
      case "resources/list":
        return send({
          id,
          result: {
            resources: [{ uri: pageUri, name: "factory", mimeType: "text/html;profile=mcp-app" }],
          },
        });
      case "resources/read":
        if (params?.uri !== pageUri) {
          return send({ id, error: { code: -32602, message: `unknown resource ${params?.uri}` } });
        }
        return send({
          id,
          result: {
            contents: [{ uri: pageUri, mimeType: "text/html;profile=mcp-app", text: PAGE }],
          },
        });
      case "tools/list":
        return send({
          id,
          result: { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] },
        });
      case "tools/call":
        log(`E2E_FACTORY_TOOL ${params?.name} instance=${view.id}`);
        return send({
          id,
          result: {
            content: [{ type: "text", text: "pong" }],
            structuredContent: { instance: view.id, scope: view.scope.kind },
          },
        });
      default:
        return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  };
  return {
    async connect(next) {
      transport = next;
      transport.onmessage = (message) => void handle(message);
      await transport.start();
    },
    async close() {
      await transport?.close();
    },
  };
}

export function activate(ctx) {
  ctx.log.info("E2E_FACTORY_ACTIVATED");
  ctx.views.register("factory", (view) =>
    createServer(view, `ui://${ctx.extension.id}/factory`, (line) => ctx.log.info(line)),
  );
}
