import { describe, expect, it, vi } from "vitest";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import {
  searchPluginsToolEntry,
  suggestPluginInstallToolEntry,
} from "../src/tool/handlers/plugin-discovery.js";
import { PermissionService } from "../src/permission/service.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
describe("plugin discovery tools", () => {
  it("is opt-in, with no tools advertised for unsupported clients", () => {
    const absent = createToolRegistry();
    registerBuiltInTools(absent);
    expect(absent.has("SearchPlugins")).toBe(false);
    expect(absent.has("SuggestPluginInstall")).toBe(false);
    const enabled = createToolRegistry();
    registerBuiltInTools(enabled, { includePluginDiscovery: true });
    expect(enabled.has("SearchPlugins")).toBe(true);
    expect(enabled.has("SuggestPluginInstall")).toBe(true);
  });
  it("loads both tools on demand through ToolSearch", () => {
    expect(searchPluginsToolEntry.metadata.shouldDefer).toBe(true);
    expect(suggestPluginInstallToolEntry.metadata.shouldDefer).toBe(true);
  });
  it("delegates the tool context including cancellation and trace to the injected port", async () => {
    const search = vi.fn(async () => ({ plugins: [], stale: false }));
    const signal = new AbortController().signal;
    const context = {
      sessionId: "session",
      toolCallId: "call",
      traceId: "trace",
      abortSignal: signal,
      pluginDiscoveryPort: { search },
      runtimeScope: "main",
    } as unknown as ToolExecutionContext;
    await searchPluginsToolEntry.handler({ query: "email" }, context);
    expect(search).toHaveBeenCalledWith(
      { query: "email" },
      expect.objectContaining({ signal, traceId: "trace", sessionId: "session" }),
    );
    await expect(
      searchPluginsToolEntry.handler({ query: "email" }, { ...context, runtimeScope: "subagent" }),
    ).rejects.toThrow();
  });
  it("uses its own confirmation while retaining plan and explicit deny/ask rules", () => {
    const service = new PermissionService();
    const capability = {
      ...suggestPluginInstallToolEntry.metadata,
      permission: suggestPluginInstallToolEntry.permission,
    };
    const context = {
      toolName: "SuggestPluginInstall",
      input: {},
      riskLevel: "medium" as const,
      mode: "build" as const,
    };
    expect(service.checkPermission(context, capability).decision).toBe("allow");
    expect(service.checkPermission({ ...context, mode: "plan" }, capability).decision).toBe("deny");
    expect(
      service.checkPermission(context, capability, { deny: [{ toolName: context.toolName }] })
        .decision,
    ).toBe("deny");
    expect(
      service.checkPermission(context, capability, { ask: [{ toolName: context.toolName }] })
        .decision,
    ).toBe("ask");
    expect(suggestPluginInstallToolEntry.timeout).toEqual({ kind: "none" });
  });
});
