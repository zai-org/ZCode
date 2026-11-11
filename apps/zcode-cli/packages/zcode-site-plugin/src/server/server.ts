import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  COMMANDS_URI,
  DELETE_SITE_TOOL,
  PANEL_MIME,
  PANEL_URI,
  RENAME_SITE_TOOL,
  RESOURCE_MIME,
  SET_SITE_BADGE_TOOL,
  type SitesResult,
} from "../contract.ts";
import type { SitesApi } from "./api.ts";
import { readCommands } from "./commands.ts";
import { resourcePath } from "./routes.ts";

const SITE_ID = "^[1-9][0-9]{0,19}$";
const SITE_ID_RE = new RegExp(SITE_ID);
const MAX_NAME_LENGTH = 100;
// 前缀由服务端规范化（小写、非 [a-z0-9] 变 -、截断 30），这里只挡明显过长的输入。

// 页面里点「复制」不弹授权：宿主据此给 iframe 加 allow="clipboard-write"。
const PANEL_META = { ui: { permissions: { clipboardWrite: {} } } };
// 工具只给页面调：宿主不把 app-only 工具放进模型的工具列表，Agent 仍走 Skill + CLI。
const APP_ONLY = { ui: { visibility: ["app"] } };

const TOOLS = [
  {
    name: RENAME_SITE_TOOL,
    title: "Rename site",
    description:
      "Change the display name of a ZCode Sites site. The domain does not change.",
    inputSchema: {
      type: "object" as const,
      properties: {
        siteId: { type: "string", pattern: SITE_ID },
        name: { type: "string", minLength: 1, maxLength: MAX_NAME_LENGTH },
      },
      required: ["siteId", "name"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    _meta: APP_ONLY,
  },
  {
    name: SET_SITE_BADGE_TOOL,
    title: "Show or hide the ZCode badge",
    description: "Hide or show the ZCode badge on a ZCode Sites site.",
    inputSchema: {
      type: "object" as const,
      properties: {
        siteId: { type: "string", pattern: SITE_ID },
        hidden: { type: "boolean" },
      },
      required: ["siteId", "hidden"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    _meta: APP_ONLY,
  },
  {
    name: DELETE_SITE_TOOL,
    title: "Delete site",
    description:
      "Permanently delete a ZCode Sites site: its address returns 404 at once and it cannot be restored.",
    inputSchema: {
      type: "object" as const,
      properties: { siteId: { type: "string", pattern: SITE_ID } },
      required: ["siteId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    _meta: APP_ONLY,
  },
];

export interface SitesServerOptions {
  version: string;
  api: SitesApi;
  /** 构建出的面板页面 `dist/ui/panel.html`。 */
  panelPath: string;
  /** 插件的 `commands/` 目录。 */
  commandsDir: string;
}

/**
 * 不写 server instructions：模型不该知道这个 server，读资源也没有面向模型的工具。
 * 读走资源，宿主处理页面的资源读取时不经过工具审批，轮询不会弹窗；写走工具（改名、角标、改前缀、删除），经宿主现有审批链。
 */
export function createSitesServer(options: SitesServerOptions): Server {
  const server = new Server(
    { name: "zcode-site", version: options.version },
    { capabilities: { resources: {}, tools: {} } },
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: PANEL_URI,
        name: "Sites",
        mimeType: PANEL_MIME,
        _meta: PANEL_META,
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === PANEL_URI) {
      const text = await readFile(options.panelPath, "utf8");
      return {
        contents: [{ uri, mimeType: PANEL_MIME, text, _meta: PANEL_META }],
      };
    }
    if (uri === COMMANDS_URI) {
      const commands = await readCommands(options.commandsDir);
      return json(uri, { data: commands });
    }
    const path = resourcePath(uri);
    if (!path)
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    return json(uri, await options.api(request.params._meta, "GET", path));
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, _meta } = request.params;
    const args = request.params.arguments ?? {};
    const siteId = args.siteId;
    if (typeof siteId !== "string" || !SITE_ID_RE.test(siteId))
      throw new McpError(ErrorCode.InvalidParams, "siteId must be a site id");
    let patch: Record<string, unknown> | undefined;
    if (name === DELETE_SITE_TOOL) {
      patch = undefined;
    } else if (name === RENAME_SITE_TOOL) {
      // 长度和内容由服务端校验（3001 / 3611），这里只挡类型。
      if (typeof args.name !== "string")
        throw new McpError(ErrorCode.InvalidParams, "name");
      patch = { name: args.name };
    } else if (name === SET_SITE_BADGE_TOOL) {
      if (typeof args.hidden !== "boolean")
        throw new McpError(ErrorCode.InvalidParams, "hidden");
      patch = { badgeHidden: args.hidden };
    } else {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    const result = patch
      ? await options.api(_meta, "PATCH", `/api/v1/sites/${siteId}`, patch)
      : await options.api(_meta, "DELETE", `/api/v1/sites/${siteId}`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
      ...("error" in result ? { isError: true } : {}),
    };
  });

  return server;
}

function json(uri: string, result: SitesResult) {
  return {
    contents: [{ uri, mimeType: RESOURCE_MIME, text: JSON.stringify(result) }],
  };
}
