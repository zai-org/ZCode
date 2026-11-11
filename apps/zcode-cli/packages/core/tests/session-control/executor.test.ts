import { describe, expect, it, vi } from "vitest";
import { modelContentForToolResult } from "../../src/runtime/helpers/tool-result.js";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
} from "@zcode/contracts";
import type { CliSessionControl } from "@zcode/session-control/contracts";
import {
  createToolExecutor,
  createToolRegistry,
  registerBuiltInTools,
} from "../../src/tool/index.js";
import { PermissionService, defaultPermissionConfig } from "../../src/permission/service.js";

const sessionId = createSessionId("session-control-root");
const turnId = createTurnId("session-control-turn");
const toolCallId = createToolCallId("session-control-call");
const traceContext = createRootTraceContext({ sessionId, turnId });
const rootSession = { kind: "cli" as const, workspacePath: "/workspace", sessionId };
const target = { ...rootSession, sessionId: "sess_target" };

function fixture(mode: "plan" | "build" | "yolo") {
  const registry = createToolRegistry();
  registerBuiltInTools(registry, { sessionControlKind: "cli" });
  const readSession = vi.fn(async () => ({
    view: "summary",
    summary: { session: target, title: "Target", status: "idle", availableActions: [] },
  }));
  const sendToSession = vi.fn(async () => ({
    requestId: toolCallId,
    session: target,
    operation: { session: target, sessionId: target.sessionId, commandId: "command" },
    admission: "accepted",
    delivery: "start_now",
  }));
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService(defaultPermissionConfig),
    emitEvent: async () => undefined,
    sessionId,
    turnId,
    traceContext,
    mode,
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    sessionControl: {
      kind: "cli",
      control: { readSession, sendToSession } as unknown as CliSessionControl,
      context: () => ({ callerId: "caller", rootSession, allowedScopes: [rootSession] }),
    },
  });
  return { executor, readSession, sendToSession };
}

describe("session control through the production executor", () => {
  it("accepts the sessionId form through JSON schema validation and passes it to the facade", async () => {
    const { executor, readSession } = fixture("plan");
    const result = await executor.execute(
      {
        id: toolCallId,
        name: "ReadSession",
        input: { sessionId: "sess_target", view: "summary" },
      },
      { traceContext },
    );
    expect(result.success).toBe(true);
    expect(readSession).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "sess_target",
      view: "summary",
    });
  });
  it("rejects a full reference alongside sessionId before reaching the facade", async () => {
    const { executor, readSession } = fixture("plan");
    const result = await executor.execute(
      {
        id: toolCallId,
        name: "ReadSession",
        input: { session: target, sessionId: "sess_target", view: "summary" },
      },
      { traceContext },
    );
    expect(result.success).toBe(false);
    expect(readSession).not.toHaveBeenCalled();
  });
  it("allows reading in plan mode and preserves trace/turn/tool identity", async () => {
    const { executor, readSession } = fixture("plan");
    const result = await executor.execute(
      {
        id: toolCallId,
        name: "ReadSession",
        input: { sessionId: "sess_target", view: "summary" },
      },
      { traceContext },
    );
    expect(result.success).toBe(true);
    expect(readSession).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: traceContext.traceId,
        turnId,
        toolCallId,
        rootSession,
        callerId: "caller",
      }),
      expect.anything(),
    );
  });
  it.each(["plan", "build"] as const)(
    "does not dispatch mutations without permission in %s",
    async (mode) => {
      const { executor, sendToSession } = fixture(mode);
      const result = await executor.execute(
        {
          id: toolCallId,
          name: "SendToSession",
          input: { sessionId: "sess_target", prompt: "continue", requestId: "request" },
        },
        { traceContext },
      );
      expect(result.success).toBe(false);
      expect(sendToSession).not.toHaveBeenCalled();
    },
  );
  it("authorized dispatch carries no actor mode or bypass to the target", async () => {
    const { executor, sendToSession } = fixture("yolo");
    // 规格 0.14：requestId 不再是工具参数，由工具层用本次 toolCallId 注入。
    const result = await executor.execute(
      {
        id: toolCallId,
        name: "SendToSession",
        input: { sessionId: "sess_target", prompt: "continue" },
      },
      { traceContext },
    );
    expect(result.success).toBe(true);
    const [trusted, input] = sendToSession.mock.calls[0]!;
    expect(trusted).not.toHaveProperty("mode");
    expect(trusted).not.toHaveProperty("bypassPermissions");
    expect(input).toEqual({
      sessionId: "sess_target",
      prompt: "continue",
      requestId: toolCallId,
    });
  });

  /**
   * 规格 0.15：请求已交给 owner、回执却没送回来（这里用永不返回的端口模拟），调用被取消。
   * 改动前模型只看到 "cancelled"，拿不到身份，只能另起新请求——重复发送同一条消息。
   * 现在错误文本里的 requestId 必须正是注入给端口的那一个，模型照它回放 retryOf 才对得上原请求。
   */
  it("hands the injected identity back when a send is cancelled before its receipt", async () => {
    const { executor, sendToSession } = fixture("yolo");
    sendToSession.mockImplementationOnce(
      (trusted: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          trusted.signal.addEventListener("abort", () => reject(trusted.signal.reason));
        }) as never,
    );
    const controller = new AbortController();
    const pending = executor.execute(
      { id: toolCallId, name: "SendToSession", input: { sessionId: "sess_target", prompt: "go" } },
      { traceContext, signal: controller.signal },
    );
    await vi.waitFor(() => expect(sendToSession).toHaveBeenCalledTimes(1));
    controller.abort();
    const result = await pending;
    expect(result.success).toBe(false);
    const injected = (sendToSession.mock.calls[0]![1] as { requestId: string }).requestId;
    expect(injected).toBe(toolCallId);
    expect(String(modelContentForToolResult(result))).toContain(`requestId=${injected}`);
  });
});
