import { expect, it } from "vitest";
import { ToolSearchDeliverySchema } from "@zcode/contracts";
import {
  ToolSearchAnnouncementSchema,
  ToolSearchMcpDeltaSchema,
} from "../../src/tool/search/contract.js";
it("does not widen the names contract when adding independent MCP state", () => {
  expect(
    ToolSearchAnnouncementSchema.safeParse({
      addedNames: [],
      removedNames: [],
      readdedNames: [],
      mcp: {},
    }).success,
  ).toBe(false);
  expect(
    ToolSearchMcpDeltaSchema.safeParse({ mcp: { pending: ["example"], failed: [] } }).success,
  ).toBe(true);
});

it("reads MCP metadata written with retired fields", () => {
  // 开发期会话可能带已删除的字段；状态 metadata 不是 strict，读取时丢弃未知字段。
  const parsed = ToolSearchMcpDeltaSchema.safeParse({
    mcp: {
      pending: [],
      failed: [{ name: "broken", blocked: true, willRetry: true }],
      revoked: ["gone"],
    },
    retractedNames: ["mcp__gone__ping"],
    toolOrigins: { mcp__gone__ping: "gone" },
  });
  expect(parsed.success).toBe(true);
  expect(parsed.data).toEqual({ mcp: { pending: [], failed: [{ name: "broken" }] } });
});

it("reads delivery records and retractions written by a newer version", () => {
  // 降级读取：新版本可能给交付记录加字段、新增撤销原因。修复前 strict 与封闭枚举让整条记录被丢弃，
  // 冻结的常驻定义失效（请求字节变化），撤销事实丢失后还会重复公告。
  const delivery = ToolSearchDeliverySchema.safeParse({
    definitions: [
      {
        tool: { name: "mcp__res__ping", inputSchema: { type: "object" }, examples: [] },
        mcp: { serverName: "res", toolName: "ping", origin: "future" },
        frozenAt: 1,
      },
    ],
    strippedReferences: [{ toolCallId: "call", toolName: "ToolSearch", reason: "future" }],
    version: 2,
  });
  expect(delivery.data).toEqual({
    definitions: [
      {
        tool: { name: "mcp__res__ping", inputSchema: { type: "object" } },
        mcp: { serverName: "res", toolName: "ping" },
      },
    ],
    strippedReferences: [{ toolCallId: "call", toolName: "ToolSearch" }],
  });
  expect(
    ToolSearchMcpDeltaSchema.safeParse({
      retractedTools: [{ name: "mcp__gone__ping", cause: "future_cause" }],
    }).data,
  ).toEqual({ retractedTools: [{ name: "mcp__gone__ping", cause: "future_cause" }] });
});
