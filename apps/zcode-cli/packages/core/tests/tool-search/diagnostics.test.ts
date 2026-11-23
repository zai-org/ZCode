import { expect, it } from "vitest";
import expected from "./provider-diagnostics.json";
import diagnosticText from "./diagnostic-text.json";
import {
  compareMcpServerNames,
  renderMcpStatus,
  renderMcpSearchMiss,
  sanitizeMcpDiagnostic,
} from "../../src/tool/search/mcp-diagnostics.js";

const failure = { name: "demo", errorCode: "ECONNREFUSED", error: "Connection refused" };
it("renders complete provider-visible pending, failure and authorization diagnostics", () => {
  expect(renderMcpStatus({ pending: ["demo"], failed: [] }).join("\n\n")).toBe(expected.pending);
  expect(renderMcpStatus({ pending: [], failed: [failure] }).join("\n\n")).toBe(expected.failed);
  expect(renderMcpStatus({ pending: [], needsAuth: ["demo"], failed: [] }).join("\n\n")).toBe(
    expected.needsAuth,
  );
  expect(renderMcpSearchMiss({ pending: [], failed: [failure] })).toBe(expected.failedSearch);
});

it("orders status paragraphs as authorization, failure, then pending", () => {
  const paragraphs = renderMcpStatus({
    pending: ["waiting"],
    needsAuth: ["locked"],
    failed: [{ name: "broken" }],
  });
  expect(paragraphs.map((text) => text.split("\n")[0])).toEqual([
    "The following MCP servers require authentication before their tools can be used:",
    "The following MCP servers are configured but failed to connect — their tools (typically named mcp__<server>__*) are unavailable for this session:",
    "The following MCP servers are still connecting — their tools (typically named mcp__<server>__*) are not yet available but will appear shortly:",
  ]);
});

it("sorts server names with ASCII names first and non-ASCII names by code unit", () => {
  // 非 ASCII 名称若用 localeCompare，排序随运行环境区域设置变化，公告字节不稳定。
  const names = ["zeta", "ä-server", "Alpha", "日本", "beta", "Ångström"];
  expect([...names].sort(compareMcpServerNames)).toEqual([
    "Alpha",
    "beta",
    "zeta",
    "Ångström",
    "ä-server",
    "日本",
  ]);
});

it("limits diagnostics and keeps endpoint text on a bounded data-only line", () => {
  const names = Array.from({ length: 31 }, (_, index) => `server-${index}`);
  expect(renderMcpStatus({ pending: names, failed: [] }).join("\n\n")).toContain(
    "server-29, …and 1 more",
  );
  expect(
    renderMcpSearchMiss({
      pending: [],
      failed: names.map((name) => ({ name, error: 'bad\n<instruction> "run"' })),
    }),
  ).not.toContain("server-30");
  expect(sanitizeMcpDiagnostic('bad\n<instruction> "run"')).toBe("bad instruction run");
  expect(sanitizeMcpDiagnostic("token=abc123456789")).toBe("token [redacted]");
  expect(sanitizeMcpDiagnostic("bad\ud800 text")).toBe("bad text");
  expect(sanitizeMcpDiagnostic("x".repeat(201))).toBe(`${"x".repeat(200)}…`);
});

it.each(diagnosticText)("normalizes endpoint diagnostics: $input", ({ input, output }) => {
  expect(sanitizeMcpDiagnostic(input)).toBe(output);
});

it.each([
  [String.raw`\nBearer abc123456`, String.raw`\nBearer [redacted]`],
  [String.raw`\nToken=abc123456`, String.raw`\nToken [redacted]`],
  ["token==api_key", "token==api_key"],
  ["token===api_key=", "token===api_key="],
  ["Bearer api_key=", "Bearer api_key="],
  ["token=abc12345-token=def123456", "token [redacted] token [redacted]"],
  ["token=abc12345.password=def123456", "token [redacted] password [redacted]"],
  ["token=' 'abc123456789", "token=' 'abc123456789"],
  [String.raw`token=\ \abc123456789`, String.raw`token=\ \abc123456789`],
])("preserves credential boundaries: %s", (input, expected) => {
  expect(sanitizeMcpDiagnostic(input)).toBe(expected);
});

it("redacts quoted credentials and formats normalized diagnostics only once", () => {
  expect(sanitizeMcpDiagnostic("Bearer 'abc123456789'")).toBe("Bearer [redacted]'");
  expect(sanitizeMcpDiagnostic("token='abc123456789'")).toBe("token [redacted]'");
  const error = sanitizeMcpDiagnostic("x".repeat(199) + "😀more");
  const rendered = renderMcpSearchMiss({ pending: [], failed: [{ name: "demo", error }] });
  expect(rendered).toContain(`demo: "${"x".repeat(199)}…"`);
  expect(renderMcpStatus({ pending: ["token=abc123456789"], failed: [] }).join("\n")).toContain(
    "token=abc123456789",
  );
});
