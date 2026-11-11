import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, onTestFailed } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createSessionId, type ModelRequest, type ModelResult } from "@zcode/contracts";
import type { CliTrustedContext } from "@zcode/session-control/contracts";
import { createRegistryBackedTestApp } from "../helpers/registry-backed-test-app.js";
import { createCliSessionControlRuntime } from "../../src/cli-session-control/module.js";
import type {
  CliRootAppRequest,
  CliSessionControlRuntimeOptions,
} from "../../src/cli-session-control/contract.js";

export const answer: ModelResult = {
  text: "done",
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

export const cleanup: Array<() => Promise<void>> = [];

export async function fixture(
  generateText: (request: ModelRequest) => Promise<ModelResult>,
  limits?: CliSessionControlRuntimeOptions["limits"],
  provenance: "new-independent-root" | "unverified-history" = "unverified-history",
) {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-cli-control-"));
  const store = await createSqliteSessionStore({ dbPath: join(cwd, "sessions.sqlite") });
  cleanup.push(async () => {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const events: Array<{ type: string; sessionId: string; turnId?: string; payload: unknown }> = [];
  onTestFailed(() => {
    process.stderr.write(JSON.stringify(events, null, 2) + "\n");
  });
  const createRootApp = vi.fn(async (input: CliRootAppRequest) => {
    const app = await createRegistryBackedTestApp({
      env: { ZCODE_STORAGE_DIR: cwd },
      skipUserConfig: true,
      sessionId: input.sessionId,
      sessionStore: store,
      traceContext: input.traceContext,
      resume: input.resume,
      modelExecutor: { generateText },
      eventSink: {
        onSessionEvent(event) {
          if (
            [
              "turn_started",
              "turn_complete",
              "turn_error",
              "turn_steer_queued",
              "turn_steer_drained",
              "turn_steer_discarded",
              "session_input_promoted",
            ].includes(event.type)
          )
            events.push({
              type: event.type,
              sessionId: event.sessionId,
              turnId: event.turnId,
              payload: event.payload,
            });
        },
      },
      configuredDefaultModelSelection: { providerId: "zai", modelId: "glm-4.6" },
      runtimeConfig: {
        workingDirectory: input.cwd,
        taskType: input.resume ? "fork" : "interactive",
      },
    });
    if (input.model) await app.setModel(input.model);
    return app;
  });
  const workspace = { kind: "cli" as const, workspacePath: cwd };
  const manager = createCliSessionControlRuntime({
    workspace,
    sessionStore: store,
    createRootApp,
    limits,
  });
  cleanup.push(() => manager.close());
  const caller = await createRootApp({
    sessionId: createSessionId(),
    cwd,
    resume: false,
  });
  // 当前调用者可为 yolo；新根必须使用自己的配置，不能继承此模式。
  await caller.setMode("yolo");
  manager.attachRoot(caller, provenance);
  cleanup.push(async () => {
    await manager.close();
    await caller.close?.();
  });
  const ctx: CliTrustedContext = {
    callerId: "test-caller",
    rootSession: { ...workspace, sessionId: caller.sessionId },
    allowedScopes: [workspace],
    traceId: caller.traceId,
  };
  return { manager, ctx, cwd, store, createRootApp, caller, events };
}
