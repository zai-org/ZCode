// plugins/mentionItems（docs/design/v2/plugin-compat.md「Composer Mention Items」测试 1–8）。
// 会话 record 用最小桩：冻结的 plugin catalog、工具可见性、MCP App 授权链上的工具调用（callMcpToolForUi）。
import { describe, expect, it, vi } from "vitest";
import type {
  Logger,
  McpPort,
  McpToolCallResult,
  McpToolDescriptor,
  PluginReferenceCatalog,
} from "@zcode/contracts";
import { CoreErrorType, createCoreError } from "@zcode/contracts";
import type { McpAppsToolVisibility } from "@zcode/shared/mcp-apps";
import {
  ZCODE_PLUGIN_MENTION_ERROR_CODES,
  zcodePluginsMentionItemsResultSchema,
  zcodeProtocolErrorCodes,
  zcodeProtocolMethods,
} from "@zcode/shared";
import { DefaultRuntimeConfig } from "@zcode/contracts";
import { createSessionFacade } from "../src/app/session-facade.js";
import { getPluginMentionItems } from "../src/zcode-protocol/plugin-mention-items.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";

const SESSION_ID = "sess_mention";
const PLUGIN_ID = "gitlab@mkt";
const TOOL = "search_merge_requests";
const FIRST_SERVER = "plugin:gitlab:aaa";
const TOOL_SERVER = "plugin:gitlab:zzz";
const QUERY = "secret-query";
const LEAK_MARKER = "LEAK-MARKER";
const INVALID_PARAMS = -32602;
const SERVER_ERROR = -32000;
const MAX_ITEMS = 50;
const MAX_INSERT_TEXT = 4000;

interface Stub {
  context: ZCodeProtocolAgentServerContext;
  callTool: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function createStub(input: {
  catalog?: PluginReferenceCatalog;
  visibility?: Record<string, readonly McpAppsToolVisibility[] | null>;
  call?: () => Promise<McpToolCallResult>;
}): Stub {
  const catalog: PluginReferenceCatalog = input.catalog ?? {
    plugins: [
      {
        pluginId: PLUGIN_ID,
        name: "gitlab",
        marketplace: "mkt",
        enabled: true,
        conflictingPluginIds: [],
        skillQualifiedNames: [],
        // 故意乱序：CLI 要按排序后的 server 名依次找工具。
        mcpServerNames: [TOOL_SERVER, FIRST_SERVER],
        subagentNames: [],
        rootPath: "/plugins/gitlab",
      },
    ],
  };
  const visibility = input.visibility ?? { [TOOL_SERVER]: ["model", "app"] };
  const callTool = vi.fn(
    input.call ??
      (async (): Promise<McpToolCallResult> => ({
        content: [],
        structuredContent: { items: [{ id: "1", label: "!1", insertText: "MR !1" }] },
      })),
  );
  const debug = vi.fn();
  const logger = { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  (logger as { child: () => Logger }).child = () => logger;
  const record = {
    app: {
      getPluginReferenceCatalog: () => catalog,
      getMcpToolVisibility: async (serverName: string, toolName: string) =>
        toolName === TOOL ? (visibility[serverName] ?? null) : null,
      callMcpToolForUi: callTool,
    },
  } as unknown as ZCodeProtocolSessionRecord;
  return {
    context: {
      deps: {},
      logger,
      sessions: new Map([[SESSION_ID, record]]),
    } as unknown as ZCodeProtocolAgentServerContext,
    callTool,
    debug,
  };
}

const params = (overrides: Record<string, unknown> = {}) => ({
  sessionId: SESSION_ID,
  pluginId: PLUGIN_ID,
  tool: TOOL,
  query: QUERY,
  ...overrides,
});

describe("plugins/mentionItems", () => {
  it("registers the method name", () => {
    expect(zcodeProtocolMethods.pluginsMentionItems).toBe("plugins/mentionItems");
  });

  it("1. rejects a session that is not in memory without calling any tool", async () => {
    const stub = createStub({});
    await expect(
      getPluginMentionItems(stub.context, params({ sessionId: "sess_missing" })),
    ).rejects.toMatchObject({ code: zcodeProtocolErrorCodes.sessionUnavailable });
    expect(stub.callTool).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", { plugins: [] }],
    [
      "disabled",
      {
        plugins: [
          {
            pluginId: PLUGIN_ID,
            name: "gitlab",
            marketplace: "mkt",
            enabled: false,
            conflictingPluginIds: [],
            skillQualifiedNames: [],
            mcpServerNames: [],
            subagentNames: [],
            rootPath: "/plugins/gitlab",
          },
        ],
      },
    ],
    [
      "conflicting",
      {
        plugins: [
          {
            pluginId: PLUGIN_ID,
            name: "gitlab",
            marketplace: "mkt",
            enabled: true,
            conflictingPluginIds: ["gitlab@other"],
            skillQualifiedNames: [],
            mcpServerNames: [TOOL_SERVER],
            subagentNames: [],
            rootPath: "/plugins/gitlab",
          },
        ],
      },
    ],
  ] as const)("2. rejects a %s plugin as unavailable", async (_label, catalog) => {
    const stub = createStub({ catalog: catalog as unknown as PluginReferenceCatalog });
    await expect(getPluginMentionItems(stub.context, params())).rejects.toMatchObject({
      code: INVALID_PARAMS,
      data: { code: ZCODE_PLUGIN_MENTION_ERROR_CODES.pluginUnavailable },
    });
    expect(stub.callTool).not.toHaveBeenCalled();
  });

  it("3. rejects a missing tool and a model-only tool without calling them", async () => {
    const missing = createStub({ visibility: {} });
    await expect(getPluginMentionItems(missing.context, params())).rejects.toMatchObject({
      code: INVALID_PARAMS,
      data: { code: ZCODE_PLUGIN_MENTION_ERROR_CODES.toolNotFound },
    });
    expect(missing.callTool).not.toHaveBeenCalled();

    const modelOnly = createStub({ visibility: { [TOOL_SERVER]: ["model"] } });
    await expect(getPluginMentionItems(modelOnly.context, params())).rejects.toMatchObject({
      code: INVALID_PARAMS,
      data: { code: ZCODE_PLUGIN_MENTION_ERROR_CODES.toolNotAppVisible },
    });
    expect(modelOnly.callTool).not.toHaveBeenCalled();
  });

  it("4. calls the tool with { query } on the plugin's own server and returns the items", async () => {
    const items = [
      {
        id: "1",
        label: "!1 Fix login",
        description: "opened",
        icon: "git-merge",
        insertText: "MR !1",
      },
      { id: "2", label: "!2", insertText: "MR !2" },
    ];
    const stub = createStub({
      visibility: { [FIRST_SERVER]: null, [TOOL_SERVER]: ["app"] },
      call: async () => ({ content: [], structuredContent: { items } }),
    });

    const result = await getPluginMentionItems(stub.context, params());

    expect(zcodePluginsMentionItemsResultSchema.parse(result)).toEqual({ items });
    expect(stub.callTool).toHaveBeenCalledTimes(1);
    expect(stub.callTool.mock.calls[0]?.slice(0, 3)).toEqual([TOOL_SERVER, TOOL, { query: QUERY }]);
    // debug 日志按键级频率出现，不能带 query 与结果内容。
    expect(stub.debug).toHaveBeenCalled();
    expect(JSON.stringify(stub.debug.mock.calls)).not.toContain(QUERY);
    expect(JSON.stringify(stub.debug.mock.calls)).not.toContain("Fix login");
  });

  it("5. maps an isError result and a thrown call to tool_failed", async () => {
    const isError = createStub({
      call: async () => ({ content: [{ type: "text", text: LEAK_MARKER }], isError: true }),
    });
    const rejectedIsError = getPluginMentionItems(isError.context, params());
    await expect(rejectedIsError).rejects.toMatchObject({
      code: SERVER_ERROR,
      data: { code: ZCODE_PLUGIN_MENTION_ERROR_CODES.toolFailed },
    });
    await expect(rejectedIsError).rejects.not.toThrow(LEAK_MARKER);

    const thrown = createStub({
      call: async () => {
        throw new Error("MCP server disconnected");
      },
    });
    await expect(getPluginMentionItems(thrown.context, params())).rejects.toMatchObject({
      code: SERVER_ERROR,
      data: { code: ZCODE_PLUGIN_MENTION_ERROR_CODES.toolFailed },
    });
  });

  it.each([
    [
      "too many items",
      {
        items: Array.from({ length: MAX_ITEMS + 1 }, (_, index) => ({
          id: String(index),
          label: LEAK_MARKER,
          insertText: "x",
        })),
      },
    ],
    [
      "an oversized insertText",
      {
        items: [{ id: "1", label: "x", insertText: LEAK_MARKER.padEnd(MAX_INSERT_TEXT + 1, "x") }],
      },
    ],
    ["an unknown field", { items: [{ id: "1", label: "x", insertText: "x", url: LEAK_MARKER }] }],
    ["missing structuredContent", undefined],
  ] as const)(
    "6. rejects %s as result_invalid without echoing content",
    async (_label, content) => {
      const stub = createStub({
        call: async () => ({
          content: [{ type: "text", text: LEAK_MARKER }],
          ...(content === undefined ? {} : { structuredContent: content }),
        }),
      });
      const error = await getPluginMentionItems(stub.context, params()).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toMatchObject({
        code: SERVER_ERROR,
        data: { code: ZCODE_PLUGIN_MENTION_ERROR_CODES.resultInvalid },
      });
      expect(String((error as Error).message)).not.toContain(LEAK_MARKER);
      expect(JSON.stringify((error as { data?: unknown }).data)).not.toContain(LEAK_MARKER);
    },
  );
});

describe("plugins/mentionItems authorization", () => {
  it("7. maps a denial from the authorization chain to tool_denied", async () => {
    const stub = createStub({
      call: async () => {
        throw createCoreError(CoreErrorType.PermissionDenied, `Permission denied: ${LEAK_MARKER}`);
      },
    });
    const error = await getPluginMentionItems(stub.context, params()).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({
      code: SERVER_ERROR,
      data: { code: ZCODE_PLUGIN_MENTION_ERROR_CODES.toolDenied },
    });
    // 拒绝原因可能来自用户反馈或 hook，不转进错误信息。
    expect(String((error as Error).message)).not.toContain(LEAK_MARKER);
  });

  it("8. waits while the approval is pending and answers after it is granted", async () => {
    const approval = Promise.withResolvers<McpToolCallResult>();
    const stub = createStub({ call: () => approval.promise });
    let settled = false;
    const pending = getPluginMentionItems(stub.context, params()).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    approval.resolve({
      content: [],
      structuredContent: { items: [{ id: "1", label: "!1", insertText: "MR !1" }] },
    });
    await expect(pending).resolves.toEqual({
      items: [{ id: "1", label: "!1", insertText: "MR !1" }],
    });
  });
});

describe("session facade callMcpToolForUi (the path plugins/mentionItems uses)", () => {
  const descriptor: McpToolDescriptor = {
    name: TOOL,
    serverName: TOOL_SERVER,
    toolName: TOOL,
    inputSchema: { type: "object" },
  };
  const snapshot = { identity: "connection", generation: 1 };

  function createFacade(authorizeAppTool: ReturnType<typeof vi.fn>) {
    const result: McpToolCallResult = { content: [], structuredContent: { items: [] } };
    const callTool = vi.fn(async () => result);
    const mcpPort = {
      appConnectionSnapshot: () => snapshot,
      listTools: async () => [descriptor],
      callTool,
    } as unknown as McpPort;
    const facade = createSessionFacade({
      configResult: { config: DefaultRuntimeConfig },
      mcpPort,
      runtime: {
        getToolExecutor: () => ({ authorizeAppTool }),
        getToolRegistry: () => ({ list: () => [], get: () => undefined }),
      },
      traceContext: { traceId: "mention-trace" },
    } as never);
    return { facade, callTool, result };
  }

  it("runs the authorization chain, then calls the tool with the approved input", async () => {
    const authorizeAppTool = vi.fn(async () => ({ query: QUERY }));
    const { facade, callTool, result } = createFacade(authorizeAppTool);

    await expect(facade.callMcpToolForUi(TOOL_SERVER, TOOL, { query: QUERY })).resolves.toBe(
      result,
    );
    expect(authorizeAppTool).toHaveBeenCalledOnce();
    expect(authorizeAppTool.mock.calls[0]?.[0]).toMatchObject({ input: { query: QUERY } });
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: TOOL_SERVER,
        toolName: TOOL,
        arguments: { query: QUERY },
        runtimeScope: "main",
      }),
      expect.objectContaining({ appConnection: snapshot }),
    );
  });

  it("does not call the tool when the authorization chain denies", async () => {
    const authorizeAppTool = vi.fn(async () => {
      throw createCoreError(CoreErrorType.PermissionDenied, "Permission denied");
    });
    const { facade, callTool } = createFacade(authorizeAppTool);

    await expect(
      facade.callMcpToolForUi(TOOL_SERVER, TOOL, { query: QUERY }),
    ).rejects.toMatchObject({ type: CoreErrorType.PermissionDenied });
    expect(callTool).not.toHaveBeenCalled();
  });
});
