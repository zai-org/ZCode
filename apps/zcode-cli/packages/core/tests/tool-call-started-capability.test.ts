/**
 * `ToolCallStarted` 载荷上的解析后副作用能力（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
 * 「Amend-resume」）。dynamic-workflow 的 driver 据它在子代理动手前关导入缓存，所以这里钉三件事：
 *   1. 元数据声明的 readOnly / sideEffectScope 原样上载荷；
 *   2. 按入参解析的运行时能力（`resolvePermissionCapability`，Bash 的只读命令判定就是它）覆盖元数据；
 *   3. 事件在 handler 之前发出——handler 一开跑，订阅者就已经知道了。
 */

import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  isWorkspaceMutatingToolCall,
  type SessionEvent,
  type ExecutionShellSelection,
  type ToolCallStartedPayload,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry } from "../src/tool/types.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";

function probeEntry(overrides: Partial<ToolEntry>): ToolEntry {
  return {
    capability: "Probe for the ToolCallStarted capability flags",
    metadata: {
      name: "CapabilityProbe",
      description: "Probe",
      readOnly: false,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: 1_000,
      maxOutputBytes: 10_000,
      sideEffectScope: "workspace",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: async () => ({ ok: true }),
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    permission: {
      permission: "capabilityProbe",
      reason: "probe",
      riskLevel: "low",
      sideEffectScope: "workspace",
      needsApproval: false,
      patternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: { maxInlineBytes: 10_000, maxModelBytes: 10_000, strategy: "truncate" },
    timeout: { defaultMs: 1_000, maxMs: 1_000, allowCallOverride: false },
    cancellation: { supported: false, cleanup: "none", userVisibleMessage: "n/a" },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
    },
    ...overrides,
  };
}

async function run(
  entry: ToolEntry,
  input: Record<string, unknown>,
  name: string,
  bashShellSelection?: ExecutionShellSelection,
) {
  const sessionId = createSessionId(name);
  const turnId = createTurnId(name);
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const events: SessionEvent[] = [];
  const order: string[] = [];
  const registry = createToolRegistry();
  registry.register({
    ...entry,
    handler: async (...args) => {
      order.push("handler");
      return entry.handler(...args);
    },
  });
  const executor = createToolExecutor({
    emitEvent: async (event) => {
      if (event.type === SessionEventType.ToolCallStarted) order.push("started");
      events.push(event);
    },
    mode: "yolo",
    bashShellSelection,
    permissionBroker: {
      async requestPermission() {
        return { decision: "allow" as const };
      },
    },
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    turnId,
    traceContext,
    workingDirectory: "/probe/cwd",
  });
  await executor.execute(
    { id: createToolCallId(name), input, name: entry.metadata.name },
    { traceContext },
  );
  const started = events.find((event) => event.type === SessionEventType.ToolCallStarted);
  return { payload: started?.payload as ToolCallStartedPayload | undefined, order, events };
}

describe("ToolCallStarted carries the resolved side-effect capability", () => {
  it("keeps explicitly permitted CMD commands marked as system side effects", async () => {
    const entry = { ...bashToolEntry, handler: async () => ({}) };
    const { payload } = await run(entry, { command: "type README.md" }, "cmd-capability", {
      dialect: "cmd",
      source: "user-config",
      display: { name: "CMD" },
    });
    expect(payload).toMatchObject({ readOnly: false, sideEffectScope: "system" });
  });

  it("declares the metadata flags on the payload, before the handler runs", async () => {
    const { payload, order } = await run(probeEntry({}), {}, "cap-meta");
    expect(payload).toMatchObject({
      toolName: "CapabilityProbe",
      readOnly: false,
      sideEffectScope: "workspace",
    });
    expect(isWorkspaceMutatingToolCall(payload!)).toBe(true);
    expect(order).toEqual(["started", "handler"]);
  });

  it("lets the per-call runtime capability override the metadata (the Bash read-only case)", async () => {
    const entry = probeEntry({
      resolvePermissionCapability: (input) =>
        (input as { command?: string }).command === "ls"
          ? { readOnly: true, sideEffectScope: "none" }
          : undefined,
    });
    const safe = await run(entry, { command: "ls" }, "cap-safe");
    expect(safe.payload).toMatchObject({ readOnly: true, sideEffectScope: "none" });
    expect(isWorkspaceMutatingToolCall(safe.payload!)).toBe(false);
    const unsafe = await run(entry, { command: "rm -rf build" }, "cap-unsafe");
    expect(unsafe.payload).toMatchObject({ readOnly: false, sideEffectScope: "workspace" });
    expect(isWorkspaceMutatingToolCall(unsafe.payload!)).toBe(true);
  });

  it("a read-only tool is not a write, whatever its scope", async () => {
    const entry = probeEntry({
      metadata: { ...probeEntry({}).metadata, readOnly: true, sideEffectScope: "none" },
    });
    const { payload } = await run(entry, {}, "cap-readonly");
    expect(payload).toMatchObject({ readOnly: true, sideEffectScope: "none" });
    expect(isWorkspaceMutatingToolCall(payload!)).toBe(false);
  });
});

describe("MCP execution attribution", () => {
  it.each([false, true])(
    "keeps actual plugin ownership on terminal events (failure=%s)",
    async (fails) => {
      const entry = probeEntry({});
      entry.metadata.mcpPresentation = {
        pluginId: "actual@market",
        serverName: "server",
        toolName: "tool",
      };
      entry.handler = async () => {
        if (fails) throw new Error("tool failed");
        // 注册表在执行期间变化，也不能丢失本次执行的归属。
        entry.metadata.mcpPresentation!.pluginId = "changed@market";
        return { ok: true };
      };
      const { events } = await run(entry, {}, "mcp-owner");
      const terminal = events.filter(
        (event) =>
          event.type === (fails ? SessionEventType.ToolCallError : SessionEventType.ToolCallResult),
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0].payload).toMatchObject({ pluginId: "actual@market" });
    },
  );
});
