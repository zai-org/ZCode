import { expect, it, vi } from "vitest";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { mcpUiInstances } from "../src/zcode-protocol/mcp-ui/instances.js";
import { openMcpUiInstance } from "../src/zcode-protocol/mcp-ui/protocol.js";

const params = {
  workspace: { workspacePath: "/Users/dev/w", workspaceKey: "/Users/dev/w" },
  sessionId: "s",
  pluginId: "p",
  serverName: "m",
  scopeId: "v",
  resourceUri: "ui://app",
  ownerWebContentsId: 1,
};

function createContext(reconnected: { identity: string; generation: number } | null) {
  let source: { identity: string; generation: number } | null = null;
  const reconnectMcpAppConnection = vi.fn(async () => {
    source = reconnected;
  });
  const record = {
    app: {
      getMcpAppConnectionSnapshot: () => source,
      // 已有连接任务先等待；本例的连接已经停在 failed，等待立即返回空快照。
      waitForMcpAppConnection: async () => source,
      reconnectMcpAppConnection,
      onMcpAppConnectionInvalidated: () => () => {},
      unsubscribeMcpResourcesForUi: async () => {},
    },
    traceContext: { traceId: "trace" },
  };
  // 打开前先经过 session 生命周期的就绪检查；没有持久化存储时按常驻 session 判定已就绪。
  const context = {
    deps: {},
    sessions: new Map([[params.sessionId, record]]),
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, reconnectMcpAppConnection };
}

// 修复前连接不可用时直接报错；stdio 崩溃后连接停在 failed，用户点重试也无法恢复。
it("reconnects once before opening an App whose connection is unavailable", async () => {
  const { context, reconnectMcpAppConnection } = createContext({ identity: "c", generation: 2 });
  const lease = await openMcpUiInstance(context, params);
  expect(reconnectMcpAppConnection).toHaveBeenCalledExactlyOnceWith("m");
  mcpUiInstances.close(lease);
});

it("reports the unavailable connection when reconnecting does not restore it", async () => {
  const { context, reconnectMcpAppConnection } = createContext(null);
  await expect(openMcpUiInstance(context, params)).rejects.toMatchObject({
    code: -32001,
    message: "MCP App connection is unavailable",
  });
  expect(reconnectMcpAppConnection).toHaveBeenCalledOnce();
});
