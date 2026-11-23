import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createProjectId,
  createSessionId,
  hasOrderedAssistantBlocks,
  ToolSearchDeliverySchema,
  type McpConfigurationSnapshot,
  type McpServerToolSnapshot,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createRuntime, mcpStatus, stdioServer, tool } from "../mcp-runtime-fixture.js";
import type { AgentRuntimeInternal } from "../../src/runtime/internal.js";

// 修复原因：带块序号的 assistant 消息冷恢复时走有序构造分支，该分支曾不挂已交付定义，
// 冷恢复请求丢失移除后仍须保留的定义，历史里的 tool_reference 也被当成失效改写。
// 流式响应的块都带序号；旧消息没有序号。两种持久化形态都要恢复已交付定义。
it.each(["unordered", "ordered"] as const)(
  "commits delivered definitions with assistant history and preserves them across removal and cold resume: %s blocks",
  async (blocks) => {
    const root = await mkdtemp(join(tmpdir(), "mcp-delivery-"));
    const store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
    const id = createSessionId(`runtime-mcp-wait-delivery-cold-${blocks}`);
    await store.createSession({
      id,
      projectID: createProjectId("test"),
      slug: "test",
      title: "test",
      directory: root,
      version: "test",
    });
    let config: McpConfigurationSnapshot = { enabled: true, servers: { local: stdioServer() } };
    let notify = () => {};
    const source = {
      getSnapshot: () => config,
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
      close() {},
    };
    const snapshot: Record<string, McpServerToolSnapshot> = {
      local: {
        status: mcpStatus("connected"),
        tools: [{ ...tool("local", "ping"), description: "Ping service" }],
        toolsVersion: "1",
      },
    };
    const ordered = blocks === "ordered";
    const make = (search = false) =>
      createRuntime({
        label: `delivery-cold-${blocks}`,
        snapshot,
        sessionStore: store,
        mcpConfigurationSource: source,
        toolSearchMode: "native",
        respond: (_request, index) => {
          if (search && index === 0)
            return {
              text: "",
              finishReason: "tool-calls",
              usage: {},
              toolCalls: [
                {
                  id: "search",
                  name: "ToolSearch",
                  input: { query: "select:mcp__local__ping", max_results: 5 },
                  ...(ordered ? { blockIndex: 0 } : {}),
                },
              ],
            };
          // 交付定义的那一步：有序形态给文字块带序号。
          if (search && index === 1 && ordered)
            return {
              text: "loaded",
              textBlocks: [{ type: "text", text: "loaded", blockIndex: 0 }],
              finishReason: "stop",
              usage: {},
            };
          return undefined;
        },
      });
    const first = make(true);
    let cold: ReturnType<typeof make> | undefined;
    try {
      await first.runtime.executeTurn("load ping");
      const records = await store.messages({ sessionID: id });
      const delivered = records.find((record) => record.info.metadata?.toolSearchDelivery);
      expect(delivered?.info.metadata?.toolSearchDelivery).toMatchObject({
        definitions: [{ tool: { name: "mcp__local__ping", description: "Ping service" } }],
      });
      expect(
        ToolSearchDeliverySchema.safeParse(delivered?.info.metadata?.toolSearchDelivery).success,
      ).toBe(true);
      expect(hasOrderedAssistantBlocks(delivered?.parts ?? [])).toBe(ordered);
      config = { enabled: true, servers: {} };
      delete snapshot.local;
      notify();
      await first.runtime.executeTurn("removed");
      expect(
        first.requests.at(-1)?.tools?.find((tool) => tool.name === "mcp__local__ping"),
      ).toBeDefined();
      expect(JSON.stringify(first.requests.at(-1)?.messages)).toContain(
        "MCP server removed from the configuration",
      );
      expect(
        (first.runtime as unknown as AgentRuntimeInternal).registry.get("mcp__local__ping"),
      ).toBeUndefined();
      first.runtime.beginShutdown();
      cold = make();
      await cold.runtime.resumeFromStore();
      await cold.runtime.executeTurn("resume");
      expect(cold.requests.at(-1)?.tools?.find((tool) => tool.name === "mcp__local__ping")).toEqual(
        first.requests.at(-1)?.tools?.find((tool) => tool.name === "mcp__local__ping"),
      );
      expect(JSON.stringify(cold.requests.at(-1)?.messages)).toContain('"tool_reference"');
      expect(JSON.stringify(cold.requests.at(-1)?.messages)).not.toContain("toolSearchDelivery");
    } finally {
      first.runtime.beginShutdown();
      cold?.runtime.beginShutdown();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["empty", "failed", "partial"] as const)(
  "records definitions only with a retained assistant response: %s",
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), "mcp-delivery-outcome-"));
    const store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
    const id = createSessionId(`runtime-mcp-wait-delivery-${outcome}`);
    await store.createSession({
      id,
      projectID: createProjectId("test"),
      slug: "test",
      title: "test",
      directory: root,
      version: "test",
    });
    const snapshot = {
      local: { status: mcpStatus("connected"), tools: [tool("local", "ping")], toolsVersion: "1" },
    };
    const { runtime } = createRuntime({
      label: `delivery-${outcome}`,
      snapshot,
      sessionStore: store,
      toolSearchMode: "native",
      respond: (_request, index) => {
        if (index === 0)
          return {
            text: "",
            finishReason: "tool-calls",
            usage: {},
            toolCalls: [
              {
                id: "search",
                name: "ToolSearch",
                input: { query: "select:mcp__local__ping", max_results: 5 },
              },
            ],
          };
        if (outcome === "empty") return { text: "", finishReason: "stop", usage: {} };
        if (outcome === "partial" && index === 1)
          return { text: "retained partial", finishReason: "length", usage: {} };
        throw new Error("test provider failed before output");
      },
    });
    try {
      if (outcome === "empty") await runtime.executeTurn("search");
      else await expect(runtime.executeTurn("search")).rejects.toThrow("Turn execution failed");
      const records = await store.messages({ sessionID: id });
      const deliveries = records.filter((record) => record.info.metadata?.toolSearchDelivery);
      expect(deliveries).toHaveLength(outcome === "partial" ? 1 : 0);
      if (outcome === "partial")
        expect(
          deliveries[0]?.parts.some(
            (part) => part.type === "text" && part.text === "retained partial",
          ),
        ).toBe(true);
    } finally {
      runtime.beginShutdown();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
