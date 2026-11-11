// L2：v4 原生会话管理命令组（renameSession / deleteSession）——验证语义保真：
// rename 直驱 core runtime.setCustomSessionTitle（titleSource=custom 粘性归 core），
// delete = CLI 软删除后关闭运行实例，经 host.deleteSession 过渡钩子。
// 08-phasing M4 完成定义的 L2 层（命令 → core 调用 → 状态推进，不经旧协议代码）。
import { describe, expect, it, vi } from "vitest";
import { SessionEventType } from "@zcode/contracts";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import { V4SessionNotFoundError } from "../src/zcode-protocol-v4/commands/record-access.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

const TRACE = { traceId: "trace-1", sessionId: "s1" };

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    getModel: () => "provider-a/model-a",
    getMode: () => "build",
    close: vi.fn().mockResolvedValue(undefined),
    runtime: {
      setCustomSessionTitle: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<V4SessionRecordView> & { app?: ReturnType<typeof makeApp> } = {},
): V4SessionRecordView {
  return {
    app: (overrides.app ?? makeApp()) as unknown as V4SessionRecordView["app"],
    traceContext: TRACE,
    workspace: { workspacePath: "/w" },
    persistence: "immediate",
    ...overrides,
  } as V4SessionRecordView;
}

function makeHost(
  record: V4SessionRecordView,
  hostOverrides: Partial<V4CommandCoreHost> = {},
): V4CommandCoreHost {
  return {
    getRecord: (id) => (id === "s1" ? record : undefined),
    waitForProjectionEventCommit: async () => {},
    ...hostOverrides,
  };
}

function envelope(type: string, payload: unknown, sessionId = "s1"): CommandEnvelope {
  return {
    type,
    payload,
    sessionId,
    commandId: "cmd-1",
    baseRevision: 0,
  } as unknown as CommandEnvelope;
}

describe("v4 原生 renameSession", () => {
  it("正路径：直驱 runtime.setCustomSessionTitle，透传 title + 会话根 traceContext", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("renameSession", { title: "新标题" }),
    );
    expect(app.runtime.setCustomSessionTitle).toHaveBeenCalledTimes(1);
    expect(app.runtime.setCustomSessionTitle).toHaveBeenCalledWith({
      title: "新标题",
      // 语义保真：traceContext = record 透传的会话根 trace，不得中途另起。
      traceContext: TRACE,
    });
  });

  it("session 不存在：拒绝（V4SessionNotFoundError）", async () => {
    const record = makeRecord();
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("renameSession", { title: "x" }, "missing"),
      ),
    ).rejects.toThrow(V4SessionNotFoundError);
    expect(
      (record.app as unknown as ReturnType<typeof makeApp>).runtime.setCustomSessionTitle,
    ).not.toHaveBeenCalled();
  });
});

describe("v4 原生 deleteSession", () => {
  it("正路径：语义 = deleteSession，经 host.deleteSession 钩子执行关闭", async () => {
    const record = makeRecord();
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    await new V4CommandExecutor(makeHost(record, { deleteSession })).execute(
      envelope("deleteSession", {}),
    );
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith("s1");
  });

  it("session 不存在：拒绝，且不触碰 deleteSession 钩子", async () => {
    const record = makeRecord();
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    await expect(
      new V4CommandExecutor(makeHost(record, { deleteSession })).execute(
        envelope("deleteSession", {}, "missing"),
      ),
    ).rejects.toThrow(V4SessionNotFoundError);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("deleteSession 钩子缺失：显式失败（关闭不能静默降级）", async () => {
    const record = makeRecord();
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(envelope("deleteSession", {})),
    ).rejects.toThrow(/deleteSession/);
  });
});

describe("v4 原生 createSession", () => {
  function makeCreateHost(record: V4SessionRecordView) {
    const createSessionRecord = vi.fn().mockImplementation(async () => {
      // 钩子契约：record 已建立并注册（deferred draft），返回 sessionId。
      return { sessionId: "s1" };
    });
    const host = makeHost(record, { createSessionRecord });
    return { host, createSessionRecord };
  }

  it("创建前透传 Host 预留的会话 ID 与附加目录", async () => {
    const record = makeRecord({ persistence: "deferred" });
    const { host, createSessionRecord } = makeCreateHost(record);
    await new V4CommandExecutor(host).execute(
      envelope(
        "createSession",
        { workspaceId: "/w", sessionId: "reserved", additionalDirectories: ["/b"] },
        "draft",
      ),
    );
    expect(createSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "reserved", additionalDirectories: ["/b"] }),
    );
  });

  it("受管 worktree：透传 cwd，记录 worktreeCreation 等首轮落盘（docs/git/worktree.md §6.6.4）", async () => {
    const recordPendingWorktreeCreation = vi.fn();
    const app = makeApp({
      runtime: { setCustomSessionTitle: vi.fn(), recordPendingWorktreeCreation },
    });
    const record = makeRecord({ app, persistence: "deferred" });
    const { host, createSessionRecord } = makeCreateHost(record);
    const worktreeCreation = {
      path: "/wt/3f2a/project",
      sha: "9e6d2f72d4",
      ref: "origin/main",
      output: "HEAD is now at 9e6d2f7\n",
    };
    await new V4CommandExecutor(host).execute(
      envelope(
        "createSession",
        { workspaceId: "/w", cwd: "/wt/3f2a/project", worktreeCreation },
        "draft",
      ),
    );
    expect(createSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "/w", cwd: "/wt/3f2a/project" }),
    );
    expect(recordPendingWorktreeCreation).toHaveBeenCalledWith(worktreeCreation);
  });

  it("worktreeCreation 缺 cwd：创建 record 前拒绝", async () => {
    const record = makeRecord({ persistence: "deferred" });
    const { host, createSessionRecord } = makeCreateHost(record);
    await expect(
      new V4CommandExecutor(host).execute(
        envelope(
          "createSession",
          {
            workspaceId: "/w",
            worktreeCreation: { path: "/wt", sha: "abc", ref: null, output: "" },
          },
          "draft",
        ),
      ),
    ).rejects.toThrow(/worktreeCreation requires cwd/);
    expect(createSessionRecord).not.toHaveBeenCalled();
  });

  it("无 firstInput：只建 draft record（deferred），不起 turn", async () => {
    const app = makeApp({ sendInput: vi.fn() });
    const record = makeRecord({ app, persistence: "deferred" });
    const { host, createSessionRecord } = makeCreateHost(record);

    const result = await new V4CommandExecutor(host).execute(
      envelope("createSession", { workspaceId: "/w" }, "draft"),
    );
    expect(createSessionRecord).toHaveBeenCalledWith({ workspaceId: "/w" });
    expect(result).toEqual({ type: "createSession", sessionId: "s1" });
    // draft 语义：无首条输入不提升 persistence、不触发 core 输入。
    expect(record.persistence).toBe("deferred");
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("requests isolated permission persistence before returning a group session", async () => {
    const record = makeRecord({ app: makeApp(), persistence: "deferred" });
    const { host, createSessionRecord } = makeCreateHost(record);
    await new V4CommandExecutor(host).execute(
      envelope("createSession", { workspaceId: "/w", permissionScope: "session" }, "group-draft"),
    );
    expect(createSessionRecord).toHaveBeenCalledWith({
      workspaceId: "/w",
      permissionScope: "session",
    });
  });

  it("创建 draft record 时透传 MCP runtime 配置", async () => {
    const record = makeRecord({ app: makeApp(), persistence: "deferred" });
    const { host, createSessionRecord } = makeCreateHost(record);
    const mcpServers = [{ name: "docs", command: "node", args: ["server.js"], env: [] }];

    await new V4CommandExecutor(host).execute(
      envelope("createSession", { workspaceId: "/w", mcpServers }, "draft-mcp"),
    );

    expect(createSessionRecord).toHaveBeenCalledWith({ workspaceId: "/w", mcpServers });
  });

  it("Guarded 配置失败会清理新草稿且不执行首条输入", async () => {
    const sendInput = vi.fn();
    const deleteSession = vi.fn(async () => {});
    const app = makeApp({
      sendInput,
      runtime: {
        getSessionModelSelection: () => {
          throw new Error("config unavailable");
        },
      },
    });
    const record = makeRecord({ app, persistence: "deferred" });
    const { host } = makeCreateHost(record);
    host.deleteSession = deleteSession;
    await expect(
      new V4CommandExecutor(host).execute(
        envelope(
          "createSession",
          {
            workspaceId: "/w",
            config: { mode: "guarded" },
            firstInput: { text: "do work", mode: "guarded" },
          },
          "draft",
        ),
      ),
    ).rejects.toThrow("config unavailable");
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("创建 draft record 时透传 Off-Peak 工具面 flag（D49：v4 是桌面新会话的实际创建路径）", async () => {
    const record = makeRecord({ app: makeApp(), persistence: "deferred" });
    const { host, createSessionRecord } = makeCreateHost(record);

    await new V4CommandExecutor(host).execute(
      envelope("createSession", { workspaceId: "/w", offPeakToolEnabled: true }, "draft-offpeak"),
    );

    expect(createSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "/w", offPeakToolEnabled: true }),
    );
  });

  it("带 firstInput：经原生 prompt turn 提交（draft 提升 + inputId=commandId 锚点）", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockImplementation(async (_input, options) => {
        options?.onTurnStartedObserved?.({
          id: "event-started",
          type: SessionEventType.TurnStarted,
          payload: { messageId: "msg-event-started" },
        });
        return {};
      }),
    });
    const record = makeRecord({ app, persistence: "deferred" });
    const admitInputCommand = vi.fn().mockResolvedValue({ sourceCommandId: "cmd-1" });
    const cancelInputCommand = vi.fn().mockResolvedValue(undefined);
    const { host } = makeCreateHost(record);
    host.admitInputCommand = admitInputCommand;
    host.cancelInputCommand = cancelInputCommand;

    const command = envelope(
      "createSession",
      {
        workspaceId: "/w",
        firstInput: {
          text: "首条",
          modelSelection: {
            providerId: "provider-a",
            modelId: "model-a",
            options: { reasoningLevel: "high" },
          },
          mode: "build",
          planEnabled: true,
        },
      },
      "draft",
    );
    const result = await new V4CommandExecutor(host).execute(command);
    expect(result).toEqual({
      type: "createSession",
      sessionId: "s1",
      input: {
        delivery: "startNow",
        inputId: "cmd-1",
      },
    });
    expect(admitInputCommand).toHaveBeenCalledWith(
      command,
      "s1",
      expect.objectContaining({ queueItemId: "queue_cmd-1" }),
    );
    // 与 sendText 同一条写路径：draft 提升语义免费获得。
    expect(record.persistence).toBe("immediate");
    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "首条" },
      expect.objectContaining({
        inputId: "cmd-1",
        queryId: "cmd-1",
        intent: expect.objectContaining({
          modelSelection: {
            providerId: "provider-a",
            modelId: "model-a",
            options: { reasoningLevel: "high" },
          },
          mode: "build",
          planEnabled: true,
        }),
      }),
    );
    expect(admitInputCommand.mock.invocationCallOrder[0]).toBeLessThan(
      app.sendInput.mock.invocationCallOrder[0]!,
    );
    expect(cancelInputCommand).not.toHaveBeenCalled();
  });

  it("firstInput 正文和附件都为空时在创建 record 前拒绝", async () => {
    const app = makeApp({ sendInput: vi.fn() });
    const record = makeRecord({ app, persistence: "deferred" });
    const { host, createSessionRecord } = makeCreateHost(record);

    await expect(
      new V4CommandExecutor(host).execute(
        envelope(
          "createSession",
          { workspaceId: "/w", firstInput: { text: "  ", attachments: [] } },
          "draft",
        ),
      ),
    ).rejects.toMatchObject({ reasonCode: "proto.invalidPayload" });
    expect(createSessionRecord).not.toHaveBeenCalled();
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("firstInput 启动失败：保留原错误并把 durable admission 收口为 cancelled", async () => {
    // 首发模型不在 Worker Registry：与 sendText 共用模型准入，在 Core 建模前以 modelUnavailable 拒绝。
    const app = makeApp({ sendInput: vi.fn(), listModels: () => [] });
    const record = makeRecord({ app, persistence: "deferred" });
    const admitInputCommand = vi.fn().mockResolvedValue({ sourceCommandId: "cmd-1" });
    const cancelInputCommand = vi.fn().mockRejectedValue(new Error("ledger unavailable"));
    const warn = vi.fn();
    const { host } = makeCreateHost(record);
    host.admitInputCommand = admitInputCommand;
    host.cancelInputCommand = cancelInputCommand;
    host.logger = { warn };

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("createSession", { workspaceId: "/w", firstInput: { text: "首条" } }, "draft"),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(cancelInputCommand).toHaveBeenCalledWith(
      "s1",
      "queue_cmd-1",
      "fault.command.inputRejected",
    );
    expect(warn).toHaveBeenCalledWith(
      "v4 createSession first input cancellation failed",
      expect.objectContaining({
        inputError: expect.stringContaining("Provider Registry 中不存在 Model"),
        queueItemId: "queue_cmd-1",
      }),
    );
    expect(record.persistence).toBe("deferred");
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("record 创建失败：错误原样上抛（钩子内已自清理半初始化 record）", async () => {
    const record = makeRecord();
    const host = makeHost(record, {
      createSessionRecord: vi.fn().mockRejectedValue(new Error("model seed failed")),
    });
    await expect(
      new V4CommandExecutor(host).execute(
        envelope("createSession", { workspaceId: "/w" }, "draft"),
      ),
    ).rejects.toThrow("model seed failed");
  });

  it("钩子缺失：binder 接线不完整直接失败（不静默降级）", async () => {
    await expect(
      new V4CommandExecutor(makeHost(makeRecord())).execute(
        envelope("createSession", { workspaceId: "/w" }, "draft"),
      ),
    ).rejects.toThrow(/createSessionRecord/);
  });
});
