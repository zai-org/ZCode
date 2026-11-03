import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { SessionId, WorkspaceId } from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createNodeExecutionAdapter } from "../../adapters/src/exec/node-execution-adapter.js";
import { createTestAgentRuntime } from "../../core/tests/test-agent-runtime.js";
import { createTestModelFactory } from "../../core/tests/test-runtime-model.js";
import { createTestSessionEventStore } from "../../core/tests/test-event-store.js";
import { listSessions } from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

it.each([false, true])(
  "Bash cd before Agent preserves durable workspace (remote=%s)",
  async (remote) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "subagent-workspace-")));
    const workspacePath = join(root, "project");
    const cwd = join(workspacePath, "src");
    await mkdir(cwd, { recursive: true });
    const workspaceIdentity = remote
      ? (`remote:server:test:${workspacePath}` as WorkspaceId)
      : undefined;
    const dbPath = join(root, "sessions.sqlite");
    let store = await createSqliteSessionStore({ dbPath });
    const parentId = "parent-after-cd" as SessionId;
    const execution = createNodeExecutionAdapter({ outputRootDir: join(root, "outputs") });
    const executed = vi.spyOn(execution, "run");
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    let calls = 0;
    const runtime = createTestAgentRuntime(
      parentId,
      {
        mode: "yolo",
        workingDirectory: workspacePath,
        workspacePath,
        workspaceIdentity,
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        modelStreaming: false,
      },
      {
        sessionStore: store,
        eventStore: createTestSessionEventStore(),
        executionPort: execution,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            if (observation.invocationContext?.metadata?.querySource === "subagent")
              return { finishReason: "stop", text: "durable child history", usage };
            calls++;
            if (calls === 1)
              return {
                finishReason: "tool-calls",
                text: "",
                usage,
                toolCalls: [
                  {
                    id: "cd",
                    name: "Bash",
                    input: { command: "cd src && pwd", dangerouslyDisableSandbox: true },
                  },
                ],
              };
            if (calls === 2)
              return {
                finishReason: "tool-calls",
                text: "",
                usage,
                toolCalls: [
                  {
                    id: "agent",
                    name: "Agent",
                    input: {
                      description: "Read",
                      prompt: "Read and finish",
                      subagent_type: "general-purpose",
                    },
                  },
                ],
              };
            return { finishReason: "stop", text: "done", usage };
          },
        }),
      },
    );
    try {
      await runtime.executeTurn("Run cd, then Agent");
      expect((await executed.mock.results[0]!.value).resolvedCwd).toBe(cwd);
      const child = (await store.listSessions({ limit: 20 })).find((s) => s.parentID === parentId);
      expect(child).toBeDefined();
      runtime.beginShutdown();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      expect(await store.getSession(child!.id)).toMatchObject({
        path: workspacePath,
        directory: workspacePath,
      });
      expect((await store.getSession(child!.id))?.workspaceID).toBe(workspaceIdentity);
      expect(
        (await store.messages({ sessionID: child!.id })).some((message) =>
          message.parts.some(
            (part) => part.type === "text" && part.text === "durable child history",
          ),
        ),
      ).toBe(true);
      const workspace = {
        workspacePath,
        workspaceIdentity,
        workspaceKey: workspaceIdentity ?? workspacePath,
      };
      const result = await listSessions(
        {
          deps: { sessionStore: store },
          sessionDirectorySourceEnabled: true,
          sessions: new Map(),
        } as ZCodeProtocolAgentServerContext,
        { workspace, sessionIds: [child!.id] },
      );
      expect(result.sessions).toEqual([
        expect.objectContaining({ sessionId: child!.id, directorySessionId: parentId }),
      ]);
    } finally {
      runtime.beginShutdown();
      store.close();
      await execution.close?.();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it("keeps legacy paths readable and unchanged across resume, old-writer updates and reopen", async () => {
  // session-store 与 v3.17.1 相同；用旧字段再次写入，验证兼容不是只执行一次的迁移。
  const root = await realpath(await mkdtemp(join(tmpdir(), "workspace-roundtrip-")));
  const legacyPath = root + "/";
  const dbPath = join(root, "sessions.sqlite");
  const id = "legacy-roundtrip" as SessionId;
  let store = await createSqliteSessionStore({ dbPath });
  const workspace = { workspacePath: root, workspaceKey: root };
  const read = (sessionId: string) =>
    listSessions(
      {
        deps: { sessionStore: store },
        sessionDirectorySourceEnabled: true,
        sessions: new Map(),
      } as ZCodeProtocolAgentServerContext,
      { sessionIds: [sessionId], workspace },
    );
  try {
    await store.createSession({
      id,
      projectID: "legacy-project" as never,
      slug: "legacy",
      title: "old",
      directory: legacyPath,
      path: legacyPath,
      version: "3.17.1",
      time: { created: 1, updated: 1 },
    });
    store.close();
    store = await createSqliteSessionStore({ dbPath });
    expect((await read(id)).sessions).toEqual([
      expect.objectContaining({ directorySessionId: id, workspace }),
    ]);
    const runtime = createTestAgentRuntime(
      id,
      {
        workingDirectory: root,
        workspacePath: root,
        mode: "yolo",
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        modelStreaming: false,
      },
      {
        sessionStore: store,
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText() {
            return {
              finishReason: "stop",
              text: "continued",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    await runtime.resumeFromStore();
    await runtime.executeTurn("continue old session");
    await runtime.close();
    expect(await store.getSession(id)).toMatchObject({ directory: legacyPath, path: legacyPath });
    const history = await store.messages({ sessionID: id });
    expect(history.length).toBeGreaterThan(0);
    store.close();
    store = await createSqliteSessionStore({ dbPath });
    // 降级写入原有列并再次制造旧 child；再升级仍按持久父链解析，不回填目录。
    await store.updateSession({ id, title: "edited after rollback" });
    const child = "legacy-child-after-rollback" as SessionId;
    await store.createSession({
      id: child,
      projectID: "legacy-project" as never,
      slug: "child",
      title: "child",
      directory: join(root, "src"),
      path: join(root, "src"),
      parentID: id,
      taskType: "subagent_child",
      version: "3.17.1",
      time: { created: 2, updated: 2 },
    });
    store.close();
    store = await createSqliteSessionStore({ dbPath });
    expect((await read(child)).sessions).toEqual([
      expect.objectContaining({ directorySessionId: id, workspace }),
    ]);
    expect(await store.getSession(id)).toMatchObject({
      title: "edited after rollback",
      directory: legacyPath,
      path: legacyPath,
    });
    expect(await store.getSession(child)).toMatchObject({
      directory: join(root, "src"),
      path: join(root, "src"),
    });
    expect(await store.messages({ sessionID: id })).toEqual(history);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
