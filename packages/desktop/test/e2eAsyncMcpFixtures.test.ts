import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertProviderToolContracts } from "./e2e/helpers/provider-prefix.js";
import {
  findFixtureIndex,
  type UpstreamReplayFixture,
} from "./e2e/helpers/upstream-replay-server.js";

const builtin = { name: "Read", input_schema: { type: "object" } };
const mcp = { name: "mcp__node_repl__js", input_schema: { type: "object" } };
const wait = { name: "WaitForMcpServers", input_schema: { type: "object" } };

describe("异步 MCP 的 E2E 请求断言", () => {
  it("允许晚到和冷恢复的 MCP 成员变化，忽略移动的缓存标记", () => {
    expect(() => assertProviderToolContracts([builtin, wait], [builtin, mcp, wait])).not.toThrow();
    expect(() => assertProviderToolContracts([builtin, mcp, wait], [builtin])).not.toThrow();
    expect(() =>
      assertProviderToolContracts(
        [{ ...builtin, cache_control: { type: "ephemeral" } }],
        [builtin, mcp],
      ),
    ).not.toThrow();
  });

  it("仍拒绝内置工具增删和已存在工具的 schema 改写", () => {
    expect(() => assertProviderToolContracts([builtin], [])).toThrow();
    expect(() => assertProviderToolContracts([], [builtin])).toThrow();
    expect(() =>
      assertProviderToolContracts([builtin], [{ ...builtin, description: "changed" }]),
    ).toThrow();
    expect(() =>
      assertProviderToolContracts([builtin, mcp], [builtin, { ...mcp, input_schema: {} }]),
    ).toThrow();
  });
});

describe("Browser Use case-local 异步连接回放", () => {
  for (const [name, marker, actionId] of [
    [
      "conversation-session-browser-use-iab-multitab-lifecycle",
      "E2E_BROWSER_USE_MULTITAB_TURN_1",
      "upstream-browser-use-multitab-create",
    ],
    [
      "conversation-session-browser-use-agent-element-picker",
      "E2E_AGENT_ELEMENT_PICKER_TURN",
      "upstream-agent-element-picker-open",
    ],
    [
      "conversation-session-browser-use-keypress-host-isolation",
      "E2E_BROWSER_USE_KEYPRESS_ISOLATION",
      "upstream-browser-use-keypress-action",
    ],
    [
      "conversation-session-browser-zoom-coordinates",
      "E2E_BROWSER_ZOOM_COORDINATES E2E_ZOOM_ROUND_0",
      "zoom-action-0",
    ],
  ]) {
    it(`${name} 从 pending 经真实等待结果进入工具调用，也支持首请求已就绪`, async () => {
      const { fixtures } = JSON.parse(
        await readFile(
          new URL(`./e2e/fixtures/upstream/conversation-session/${name}.json`, import.meta.url),
          "utf8",
        ),
      ) as { fixtures: UpstreamReplayFixture[] };
      const counts = new Map<string, number>();
      const messages: unknown[] = [
        { role: "user", content: `${marker} E2E_BROWSER_FIXTURE_URL:http://localhost:4321/` },
      ];
      const match = (tools: unknown[]) => {
        const body = { tools, messages };
        return fixtures[
          findFixtureIndex(
            fixtures,
            { method: "POST", path: "/v1/messages" },
            JSON.stringify(body),
            body,
            counts,
          )
        ];
      };
      expect(match([builtin, mcp])?.id).toBe(actionId);
      const callIds = new Set<string>();
      for (let attempt = 0; attempt < 3; attempt++) {
        const fixture = match([builtin, wait]);
        expect(fixture?.response.toolUse?.name).toBe("WaitForMcpServers");
        const call = fixture!.response.toolUse!;
        if (!call.id) throw new Error("等待工具必须有独立调用 ID");
        expect(call.input).toEqual({ servers: ["node_repl"] });
        expect(callIds.has(call.id)).toBe(false);
        callIds.add(call.id);
        counts.set(fixture!.id, 1);
        messages.push({ role: "assistant", content: [{ type: "tool_use", ...call }] });
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: call.id,
              content: "ready: false\nStill connecting (try again or proceed without): node_repl",
              is_error: true,
            },
          ],
        });
      }
      expect(match([builtin, mcp, wait])?.id).toBe(actionId);
    });
  }
});
