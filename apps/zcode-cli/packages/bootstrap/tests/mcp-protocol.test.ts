import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpPort } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  zcodeMcpListResultSchema,
  zcodeMcpListParamsSchema,
  zcodeProtocolMethods,
  zcodeProtocolSessionMethodContracts,
} from "@zcode/shared";
import { listMcpServers } from "../src/zcode-protocol/mcp.js";
import { createMcpAdapter } from "@zcode/adapters/mcp";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

describe("mcp protocol contracts", () => {
  it("registers mcp/list", () => {
    expect(zcodeProtocolMethods.mcpList).toBe("mcp/list");
    expect(zcodeProtocolSessionMethodContracts[zcodeProtocolMethods.mcpList]).toBeDefined();
  });

  it("parses an MCP status snapshot", () => {
    const parsed = zcodeMcpListResultSchema.parse({
      statuses: {
        filesystem: {
          status: "disconnected",
          transport: "stdio",
          toolCount: 0,
          updatedAt: "2026-06-23T00:00:00.000Z",
        },
      },
    });

    expect(parsed.statuses.filesystem?.status).toBe("disconnected");
  });

  it("defaults mcp/list mode to connect and accepts status-only mode", () => {
    expect(
      zcodeMcpListParamsSchema.parse({
        workspace: {
          workspaceKey: "/tmp/project",
          workspacePath: "/tmp/project",
        },
      }).mode,
    ).toBe("connect");

    expect(
      zcodeMcpListParamsSchema.parse({
        workspace: {
          workspaceKey: "/tmp/project",
          workspacePath: "/tmp/project",
        },
        mode: "status",
      }).mode,
    ).toBe("status");
  });

  it("rejects invalid MCP status values", () => {
    expect(() =>
      zcodeMcpListResultSchema.parse({
        statuses: {
          broken: {
            status: "unknown",
            transport: "stdio",
            toolCount: 0,
            updatedAt: "2026-06-23T00:00:00.000Z",
          },
        },
      }),
    ).toThrow();
  });

  it("parses HTTP MCP OAuth client credentials in protocol params", () => {
    const parsed = zcodeMcpListParamsSchema.parse({
      workspace: {
        workspaceKey: "/tmp/project",
        workspacePath: "/tmp/project",
      },
      mcpServers: [
        {
          name: "protected",
          type: "http",
          url: "https://mcp.example.test/mcp",
          headers: [],
          oauth: {
            type: "client_credentials",
            clientId: "zcode-client",
            clientSecret: "secret",
            scope: "mcp:tools",
          },
        },
      ],
    });

    expect(parsed.mcpServers?.[0]).toMatchObject({
      name: "protected",
      oauth: {
        type: "client_credentials",
        clientId: "zcode-client",
      },
    });
  });

  it("parses HTTP MCP OAuth authorization code in protocol params", () => {
    const parsed = zcodeMcpListParamsSchema.parse({
      workspace: {
        workspaceKey: "/tmp/project",
        workspacePath: "/tmp/project",
      },
      mcpServers: [
        {
          name: "figma",
          type: "http",
          url: "https://mcp.figma.com/mcp",
          headers: [],
          oauth: {
            type: "authorization_code",
            clientName: "ZCode",
            redirectPath: "/oauth/callback/mcp/figma",
            scope: "mcp:connect",
          },
        },
      ],
    });

    expect(parsed.mcpServers?.[0]).toMatchObject({
      name: "figma",
      oauth: {
        type: "authorization_code",
        clientName: "ZCode",
        redirectPath: "/oauth/callback/mcp/figma",
        scope: "mcp:connect",
      },
    });
  });
});

// Bugfix 回归：设置页刷新的 mcp/list 必须带 revalidate，否则进程级 `protocol-settings` lease
// 会命中连接池里的旧 entry 并回放陈旧快照（由 adapter 统一校验与恢复）。
describe("mcp/list connection revalidation", () => {
  it.each([undefined, "404"])(
    "projects internal diagnostics out of strict status responses: %s",
    async (errorCode) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-mcp-status-projection-"));
      const adapter = createMcpAdapter();
      await adapter.connectServer("disabled", { type: "stdio", command: "node", enabled: false });
      const statuses = await adapter.status();
      // 使用真实 adapter 的状态形状，包括值为 undefined 但实际存在的内部键。
      statuses.disabled!.errorCode = errorCode;
      const context = {
        deps: {
          env: { ...process.env, ZCODE_STORAGE_DIR: join(root, "cli") },
          mcpPort: {
            status: async () => statuses,
            listTools: () => adapter.listTools(),
            connectConfiguredServers: async () => ({ statuses, tools: [] }),
            // 设置页读取会经过工作区信任 guard：被拦截的声明在连接准入处断开。
            disconnectServer: async () => undefined,
          },
        },
      } as unknown as ZCodeProtocolAgentServerContext;
      try {
        for (const mode of ["connect", "status"] as const) {
          const result = await listMcpServers(context, {
            workspace: { workspaceKey: root, workspacePath: root },
            mcpServers: [],
            mode,
          });
          expect(result.statuses.disabled).toMatchObject({
            status: "disabled",
            transport: "stdio",
            toolCount: 0,
          });
          expect(result.statuses.disabled).not.toHaveProperty("errorCode");
        }
        const connecting = Promise.withResolvers<{ statuses: typeof statuses; tools: [] }>();
        context.deps.mcpPort!.connectConfiguredServers = () => connecting.promise;
        statuses.disabled!.status = "connecting";
        statuses.disabled!.authorization = {
          type: "oauth_authorization_code",
          authorizationUrl: "https://auth.example.test/authorize",
          startedAt: new Date().toISOString(),
        };
        try {
          const pending = await listMcpServers(context, {
            workspace: { workspaceKey: root, workspacePath: root },
            mcpServers: [],
            mode: "connect",
          });
          expect(pending.statuses.disabled).toMatchObject({
            status: "connecting",
            authorization: statuses.disabled!.authorization,
          });
          expect(pending.statuses.disabled).not.toHaveProperty("errorCode");
        } finally {
          connecting.resolve({ statuses, tools: [] });
        }
      } finally {
        await adapter.close();
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it("asks the pool to revalidate on the default connect mode and skips it for status mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-mcp-list-revalidate-"));
    const previousStorageDir = process.env.ZCODE_STORAGE_DIR;
    process.env.ZCODE_STORAGE_DIR = join(root, "cli");
    const connectConfiguredServers = vi.fn(async () => ({ statuses: {}, tools: [] }));
    const status = vi.fn(async () => ({}));
    const mcpPort = {
      callTool: vi.fn(),
      close: vi.fn(async () => undefined),
      connectConfiguredServers,
      connectServer: vi.fn(),
      disconnectServer: vi.fn(),
      listTools: vi.fn(async () => []),
      status,
    } as unknown as McpPort;
    const context = {
      deps: { env: process.env, mcpPort },
    } as unknown as ZCodeProtocolAgentServerContext;
    const params = {
      mcpServers: [],
      workspace: { workspaceKey: root, workspacePath: root },
    };

    try {
      await listMcpServers(context, params);
      expect(connectConfiguredServers).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ revalidate: true }),
      );

      connectConfiguredServers.mockClear();
      await listMcpServers(context, { ...params, mode: "status" });
      expect(connectConfiguredServers).not.toHaveBeenCalled();
    } finally {
      if (previousStorageDir === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorageDir;
      await rm(root, { force: true, recursive: true });
    }
  });
});

import { convertToZCodeAgentMcpServer, zcodeProtocolMcpServerSchema } from "@zcode/shared";
import { protocolMcpServersToRuntimeMcpConfig } from "../src/zcode-protocol/protocol-mcp-config.js";

it("preserves workspace provenance and cwd from Host DTO to runtime; rejects arbitrary runtime source", () => {
  const dto = convertToZCodeAgentMcpServer(
    "probe",
    { type: "stdio", command: "node", cwd: "tools", args: ["server.mjs"], env: { TEST: "1" } },
    "workspace",
  );
  const parsed = zcodeProtocolMcpServerSchema.parse(dto);
  expect(protocolMcpServersToRuntimeMcpConfig([parsed])?.servers.probe).toMatchObject({
    source: { kind: "workspace" },
    cwd: "tools",
    env: { TEST: "1" },
  });
  expect(zcodeProtocolMcpServerSchema.safeParse({ ...dto, source: { kind: "user" } }).success).toBe(
    false,
  );
});
