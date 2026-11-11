import { createTurnId, type SessionId } from "@zcode/contracts";
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

export async function waitForCondition(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

export function createSubagentRunRequest(input: {
  sessionId: SessionId;
  turnId: ReturnType<typeof createTurnId>;
}) {
  return {
    agentType: "general-purpose",
    description: "Auto background test",
    parentToolCallId: "call_auto_background",
    prompt: "Run slowly",
    sessionId: input.sessionId,
    trace: {
      traceId: "trace_subagent_auto_background_parent",
      spanId: "span_subagent_auto_background_parent",
      sessionId: input.sessionId,
      turnId: input.turnId,
    },
    turnId: input.turnId,
    workingDirectory: "/tmp/zcode-subagent-auto-background",
    workspaceRoot: "/tmp/zcode-subagent-auto-background",
  };
}
