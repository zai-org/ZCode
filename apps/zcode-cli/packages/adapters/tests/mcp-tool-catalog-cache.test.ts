import { describe, expect, it } from "vitest";
import type {
  McpToolDescriptor,
  McpServerToolSnapshot,
  McpToolCatalogScope,
} from "@zcode/contracts";
import { createInMemoryMcpToolCatalog } from "../src/mcp/tool-catalog-cache.js";

describe("in-memory MCP tool catalog", () => {
  it("requires complete stdio coverage and preserves a valid empty catalog", () => {
    const catalog = createInMemoryMcpToolCatalog();
    const scope = createScope();

    expect(catalog.prepare(scope).lookup).toEqual({ byServer: {}, status: "incomplete" });

    catalog.prepare(scope).publish(connectedSnapshot([]));

    // 合法空列表是命中（[]），与未命中（缺 key）不同。
    expect(catalog.prepare(scope).lookup).toEqual({ byServer: { local: [] }, status: "complete" });
    // HTTP server 不进缓存，但不会让 stdio 的命中失效。
    expect(
      catalog.prepare({
        ...scope,
        servers: {
          ...scope.servers,
          remote: { type: "http", url: "https://example.test/mcp" },
        },
      }).lookup,
    ).toEqual({ byServer: { local: [] }, status: "incomplete" });
  });

  it("expires by publish time even when reads refresh LRU recency", () => {
    let now = 1_000;
    const catalog = createInMemoryMcpToolCatalog({ now: () => now, ttlMs: 100 });
    const scope = createScope();
    catalog.prepare(scope).publish(connectedSnapshot([descriptor("ping")]));

    now = 1_050;
    expect(catalog.prepare(scope).lookup.status).toBe("complete");
    now = 1_101;
    expect(catalog.prepare(scope).lookup).toEqual({ byServer: {}, status: "incomplete" });
  });

  it("separates workspace identity and configuration without retaining annotations", () => {
    const catalog = createInMemoryMcpToolCatalog();
    const scope = createScope();
    catalog.prepare(scope).publish(
      connectedSnapshot([
        {
          ...descriptor("erase"),
          annotations: { destructiveHint: true },
          timeoutMs: 42,
        },
      ]),
    );

    expect(catalog.prepare({ ...scope, workspaceIdentity: "workspace:other" }).lookup).toEqual({
      byServer: {},
      status: "incomplete",
    });
    expect(
      catalog.prepare({
        ...scope,
        servers: {
          local: { type: "stdio", command: "node", args: ["other-server.js"] },
        },
      }).lookup,
    ).toEqual({ byServer: {}, status: "incomplete" });
    expect(catalog.prepare(scope).lookup).toEqual({
      byServer: {
        local: [
          {
            serverName: "local",
            toolName: "erase",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
      status: "complete",
    });
  });

  it("does not let an incomplete startup overwrite a previous successful server catalog", () => {
    const catalog = createInMemoryMcpToolCatalog();
    const scope = createScope();
    catalog.prepare(scope).publish(connectedSnapshot([descriptor("ping")]));

    catalog.prepare(scope).publish({});

    expect(catalog.prepare(scope).lookup).toEqual({
      byServer: { local: [descriptor("ping")] },
      status: "complete",
    });
  });

  it("rejects a late publication from an explicitly invalidated producer", () => {
    const catalog = createInMemoryMcpToolCatalog();
    const scope = createScope();
    const older = catalog.prepare(scope);
    older.invalidate?.();
    const newer = catalog.prepare(scope);

    newer.publish(connectedSnapshot([descriptor("new")]));
    older.publish(connectedSnapshot([descriptor("old")]));

    expect(catalog.prepare(scope).lookup).toEqual({
      byServer: { local: [descriptor("new")] },
      status: "complete",
    });
  });

  it("returns per-server hits and keeps search/visibility fields", () => {
    const catalog = createInMemoryMcpToolCatalog();
    const scope = createScope();
    const servers = {
      ...scope.servers,
      other: { type: "stdio" as const, command: "node", args: ["other.js"] },
    };
    catalog
      .prepare(scope)
      .publish(
        connectedSnapshot([
          { ...descriptor("ping"), alwaysLoad: true, searchHint: "net", visibility: ["model"] },
        ]),
      );

    expect(catalog.prepare({ ...scope, servers }).lookup).toEqual({
      byServer: {
        local: [
          { ...descriptor("ping"), alwaysLoad: true, searchHint: "net", visibility: ["model"] },
        ],
      },
      status: "incomplete",
    });
  });

  it("keeps an explicit alwaysLoad false and resolves ui-only visibility", () => {
    const catalog = createInMemoryMcpToolCatalog();
    const scope = createScope();
    catalog
      .prepare(scope)
      .publish(
        connectedSnapshot([
          { ...descriptor("off"), alwaysLoad: false },
          { ...descriptor("app"), ui: { visibility: ["app"] } } as never,
        ]),
      );

    expect(catalog.prepare(scope).lookup.byServer.local).toEqual([
      { ...descriptor("off"), alwaysLoad: false },
      // 只有 ui.visibility 时按 resolveMcpToolVisibility 落到 visibility，不能丢成默认 model+app。
      { ...descriptor("app"), visibility: ["app"] },
    ]);
  });
});

function createScope(): McpToolCatalogScope {
  return {
    servers: {
      local: { type: "stdio", command: "node", args: ["server.js"] },
    },
    workingDirectory: "/workspace",
    workspaceIdentity: "workspace:local",
  };
}

function descriptor(toolName: string) {
  return {
    serverName: "local",
    toolName,
    inputSchema: { type: "object", properties: {} },
  };
}

function connectedSnapshot(tools: McpToolDescriptor[]): Record<string, McpServerToolSnapshot> {
  return {
    local: {
      status: {
        status: "connected",
        transport: "stdio",
        toolCount: tools.length,
        updatedAt: "now",
      },
      tools,
      toolsVersion: JSON.stringify(tools),
    },
  };
}

it("isolates alwaysLoad policy and invalidates a terminal failed catalog", () => {
  const catalog = createInMemoryMcpToolCatalog();
  const scope = createScope();
  const original = catalog.prepare(scope);
  original.publish(connectedSnapshot([descriptor("ping")]));
  expect(
    catalog.prepare({ ...scope, servers: { local: { ...scope.servers.local!, alwaysLoad: true } } })
      .lookup.status,
  ).toBe("incomplete");
  const publication = catalog.prepare(scope);
  publication.publish({
    local: { status: { status: "failed", transport: "stdio", toolCount: 0, updatedAt: "now" } },
  });
  original.invalidate?.();
  original.publish(connectedSnapshot([descriptor("late")]));
  expect(catalog.prepare(scope).lookup.byServer).toEqual({});
});

it("lookup does not revoke an active producer", () => {
  const catalog = createInMemoryMcpToolCatalog();
  const scope = createScope();
  const producer = catalog.prepare(scope);
  producer.publish(connectedSnapshot([descriptor("old")]));
  catalog.prepare(scope);
  producer.publish(connectedSnapshot([descriptor("new")]));
  expect(catalog.prepare(scope).lookup.byServer.local?.map((tool) => tool.toolName)).toEqual([
    "new",
  ]);
});

it("dedupes unchanged discovery versions without extending the cache TTL", () => {
  let now = 0;
  const catalog = createInMemoryMcpToolCatalog({ now: () => now, ttlMs: 100 });
  const scope = createScope();
  const producer = catalog.prepare(scope);
  const snapshot = connectedSnapshot([descriptor("ping")]);
  producer.publish(snapshot);
  now = 90;
  producer.publish(snapshot);
  expect(catalog.prepare(scope).lookup.byServer.local).toHaveLength(1);
  now = 101;
  expect(catalog.prepare(scope).lookup.status).toBe("incomplete");
  producer.publish(connectedSnapshot([]));
  expect(catalog.prepare(scope).lookup.byServer.local).toEqual([]);
});
