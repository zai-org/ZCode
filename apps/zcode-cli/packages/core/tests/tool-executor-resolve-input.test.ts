/**
 * `ToolEntry.resolveInput` 的**通用**契约（docs/dynamic-workflow/launch.md 的
 * 「解析的落点」）。这里刻意不测任何具体工具：可复用工作流是第一个用户，但这个钩子是
 * executor 的机制，下一个用它的工具该能只读这份测试就明白它保证了什么。
 *
 * 保证有四条，全部由位置（validateInput 之后、PreToolUse hook 之前）决定：
 *   1. 返回值替换 executionInput，此后 hook / 权限事件 / prepareApproval / handler 同源；
 *   2. 返回失败时在 hook 之前收口，不弹窗、不执行；
 *   3. 未声明它的工具行为一个字节不变；
 *   4. validateInput 先跑——校验不过就不该再去解析。
 */

import { describe, expect, it } from "vitest";
import {
  HookEventName,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type PermissionRequestedPayload,
  type SessionEvent,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { HookRunner } from "../src/hooks/index.js";
import type { ToolEntry } from "../src/tool/types.js";

function probeEntry(overrides: Partial<ToolEntry>): ToolEntry {
  return {
    capability: "Echo the execution input back",
    metadata: {
      name: "ResolveProbe",
      description: "Probe for the resolveInput contract",
      readOnly: false,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: 1_000,
      maxOutputBytes: 10_000,
      sideEffectScope: "workspace",
      riskLevel: "low",
      needsApproval: true,
    },
    handler: async (input) => ({ seen: input }),
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    permission: {
      permission: "resolveProbe",
      reason: "ResolveProbe asks so the gate payload can be observed",
      riskLevel: "low",
      sideEffectScope: "workspace",
      needsApproval: true,
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

interface ProbeOutcome {
  events: SessionEvent[];
  hookInputs: unknown[];
  gateInputs: unknown[];
  result: Awaited<ReturnType<ReturnType<typeof createToolExecutor>["execute"]>>;
}

async function runProbe(
  entry: ToolEntry,
  input: Record<string, unknown>,
  name: string,
): Promise<ProbeOutcome> {
  const sessionId = createSessionId(name);
  const turnId = createTurnId(name);
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const events: SessionEvent[] = [];
  const hookInputs: unknown[] = [];

  const hookRunner: HookRunner = {
    async run(hookInput) {
      if (hookInput.hookEventName === HookEventName.PreToolUse) {
        hookInputs.push((hookInput as unknown as { toolInput?: unknown }).toolInput);
      }
      return { additionalContexts: [] };
    },
  };

  const registry = createToolRegistry();
  registry.register(entry);
  const executor = createToolExecutor({
    emitEvent: async (event) => {
      events.push(event);
    },
    hookRunner,
    mode: "build",
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

  const result = await executor.execute(
    { id: createToolCallId(name), input, name: entry.metadata.name },
    { traceContext },
  );

  return {
    events,
    hookInputs,
    gateInputs: events
      .filter((event) => event.type === SessionEventType.PermissionRequested)
      .map((event) => (event.payload as PermissionRequestedPayload).input),
    result,
  };
}

describe("ToolEntry.resolveInput", () => {
  it("replaces the execution input for hooks, the gate payload and the handler alike", async () => {
    const entry = probeEntry({
      resolveInput: (input) => ({
        result: true,
        input: { ...(input as Record<string, unknown>), resolved: true },
      }),
    });

    const outcome = await runProbe(entry, { original: 1 }, "resolve-replaces");

    const normalized = { original: 1, resolved: true };
    // 一个归一化点，三个下游读者：这正是它值得存在的理由。
    expect(outcome.hookInputs).toEqual([normalized]);
    expect(outcome.gateInputs).toEqual([normalized]);
    expect(outcome.result.success).toBe(true);
    expect(outcome.result.output).toEqual({ seen: normalized });
  });

  it("passes the session working directory so a tool can resolve project-local things", async () => {
    const seen: (string | undefined)[] = [];
    const entry = probeEntry({
      resolveInput: (input, context) => {
        seen.push(context.workingDirectory);
        return { result: true, input };
      },
    });

    await runProbe(entry, {}, "resolve-cwd");

    expect(seen).toEqual(["/probe/cwd"]);
  });

  it("ends the call before hooks and before the gate when resolution fails", async () => {
    const entry = probeEntry({
      resolveInput: () => ({ result: false, errorCode: 400, message: "cannot resolve that" }),
    });

    const outcome = await runProbe(entry, { bad: true }, "resolve-fails");

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message).toContain("cannot resolve that");
    // 业务失败，不是基础设施故障：模型该立刻拿回去修，不该先打断用户一次确认。
    expect(outcome.hookInputs).toEqual([]);
    expect(outcome.gateInputs).toEqual([]);
  });

  it("awaits an async resolver", async () => {
    const entry = probeEntry({
      resolveInput: async (input) => {
        await Promise.resolve();
        return { result: true, input: { ...(input as Record<string, unknown>), async: true } };
      },
    });

    const outcome = await runProbe(entry, {}, "resolve-async");

    expect(outcome.result.output).toEqual({ seen: { async: true } });
  });

  it("leaves a tool that does not declare it completely unchanged", async () => {
    const outcome = await runProbe(probeEntry({}), { untouched: 1 }, "resolve-absent");

    expect(outcome.hookInputs).toEqual([{ untouched: 1 }]);
    expect(outcome.gateInputs).toEqual([{ untouched: 1 }]);
    expect(outcome.result.output).toEqual({ seen: { untouched: 1 } });
  });

  it("runs after validateInput, so an invalid call never reaches the resolver", async () => {
    let resolverCalls = 0;
    const entry = probeEntry({
      validateInput: () => ({ result: false, errorCode: 400, message: "invalid before resolve" }),
      resolveInput: (input) => {
        resolverCalls += 1;
        return { result: true, input };
      },
    });

    const outcome = await runProbe(entry, {}, "resolve-after-validate");

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message).toContain("invalid before resolve");
    expect(resolverCalls).toBe(0);
  });
});

// resolveForExecution：缓存 advertisement entry 在执行前换成 live entry（docs/mcp-async-tool-catalog-cache.md）。
describe("ToolEntry.resolveForExecution", () => {
  it("executes the live entry returned by resolution", async () => {
    const live = probeEntry({ handler: async () => ({ live: true }) });
    const entry = probeEntry({
      resolveForExecution: async () => ({ status: "ready", entry: live }),
    });

    const outcome = await runProbe(entry, {}, "live-ready");

    expect(outcome.result.success).toBe(true);
    expect(outcome.result.output).toEqual({ live: true });
  });

  it("fails retryably before hooks when the live entry is unavailable", async () => {
    const entry = probeEntry({
      resolveForExecution: async () => ({ status: "unavailable", message: "server gone" }),
    });

    const outcome = await runProbe(entry, {}, "live-unavailable");

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message).toContain("server gone");
    expect(outcome.hookInputs).toEqual([]);
    expect(outcome.events.some((event) => event.type === SessionEventType.ToolCallError)).toBe(
      true,
    );
  });

  it("fails before hooks when resolution throws", async () => {
    const entry = probeEntry({
      resolveForExecution: async () => {
        throw new Error("startup crashed");
      },
    });

    const outcome = await runProbe(entry, {}, "live-throws");

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message).toContain("Tool is not available");
    expect(outcome.hookInputs).toEqual([]);
  });
});
