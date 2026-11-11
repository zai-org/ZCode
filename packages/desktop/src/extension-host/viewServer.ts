import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { INVALID_PARAMS, ProtocolError, Server } from "@modelcontextprotocol/server";
import { MCP_APPS_RESOURCE_MIME_TYPE } from "@zcode/shared/mcp-apps";
import type { ViewCall, ViewDefinition } from "@zcode/shared/extension-host";
import { runAsPlugin } from "#src/extension-host/runtime.js";

// 扩展视图写法一（docs/plugins/extension-host.md §8）：宿主把 ViewDefinition 包成一个 MCP server。
// 用低层 Server：插件给的 inputSchema 是普通 JSON Schema，宿主原样放进 tools/list，不替插件校验入参。
// resources/subscribe 由宿主应答；订阅记账与 view.notify 的过滤在 viewHost（请求层），两种写法共用。

const SERVER_INFO = { name: "zcode-extension-view", version: "1" } as const;
const DEFAULT_RESOURCE_MIME_TYPE = "text/plain";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** run 的返回值：带 content 数组的对象原样作为 CallToolResult；其他值序列化为文本，对象另放进 structuredContent。 */
function toCallToolResult(value: unknown) {
  if (isPlainObject(value) && Array.isArray(value.content)) return value as { content: [] };
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  return {
    content: [{ type: "text" as const, text }],
    ...(isPlainObject(value) ? { structuredContent: value } : {}),
  };
}

/**
 * 每次打开视图时读 entry。路径必须在插件根目录内：先按字面判断，再按真实路径判断（防符号链接跳出）。
 */
export async function readViewEntry(rootPath: string, entry: string): Promise<string> {
  const target = resolve(rootPath, entry);
  const lexical = relative(rootPath, target);
  if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) {
    throw new Error(`view entry must be a file inside the plugin root: ${entry}`);
  }
  const [realRoot, realTarget] = await Promise.all([realpath(rootPath), realpath(target)]);
  const real = relative(realRoot, realTarget);
  if (!real || real.startsWith("..") || isAbsolute(real)) {
    throw new Error(`view entry resolves outside the plugin root: ${entry}`);
  }
  return readFile(realTarget, "utf8");
}

export function createHelperViewServer(params: {
  pluginId: string;
  rootPath: string;
  pageUri: string;
  definition: ViewDefinition;
  call: ViewCall;
}): Server {
  const { pluginId, rootPath, pageUri, definition, call } = params;
  const tools = definition.tools ?? {};
  const resources = definition.resources ?? {};
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, resources: { subscribe: true } },
  });
  server.setRequestHandler("tools/list", async () => ({
    tools: Object.entries(tools).map(([name, tool]) => ({
      name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema ?? { type: "object" as const, properties: {} },
    })),
  }));
  server.setRequestHandler("tools/call", async (request) => {
    const name = request.params.name;
    const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
    if (!tool) throw new ProtocolError(INVALID_PARAMS, `unknown view tool: ${name}`);
    try {
      const value = await runAsPlugin(pluginId, () =>
        tool.run(request.params.arguments ?? {}, call),
      );
      return toCallToolResult(value);
    } catch (error) {
      // 工具错误按 MCP 约定放进结果，页面能拿到原因；不让它变成协议错误。
      return { isError: true, content: [{ type: "text" as const, text: describe(error) }] };
    }
  });
  server.setRequestHandler("resources/list", async () => ({
    resources: [
      { uri: pageUri, name: pageUri, mimeType: MCP_APPS_RESOURCE_MIME_TYPE },
      ...Object.entries(resources).map(([uri, resource]) => ({
        uri,
        name: uri,
        mimeType: resource.mimeType ?? DEFAULT_RESOURCE_MIME_TYPE,
      })),
    ],
  }));
  server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [] }));
  server.setRequestHandler("resources/read", async (request) => {
    const uri = request.params.uri;
    if (uri === pageUri) {
      const text = await readViewEntry(rootPath, definition.entry);
      return { contents: [{ uri, mimeType: MCP_APPS_RESOURCE_MIME_TYPE, text }] };
    }
    const resource = Object.hasOwn(resources, uri) ? resources[uri] : undefined;
    if (!resource) throw new ProtocolError(INVALID_PARAMS, `unknown view resource: ${uri}`);
    const text = await runAsPlugin(pluginId, () => resource.read(call));
    if (typeof text !== "string") {
      throw new ProtocolError(INVALID_PARAMS, `view resource must return a string: ${uri}`);
    }
    return {
      contents: [{ uri, mimeType: resource.mimeType ?? DEFAULT_RESOURCE_MIME_TYPE, text }],
    };
  });
  // 订阅只需应答；是否把变化发给页面由 viewHost 按请求层记下的订阅判断。
  server.setRequestHandler("resources/subscribe", async () => ({}));
  server.setRequestHandler("resources/unsubscribe", async () => ({}));
  return server;
}
