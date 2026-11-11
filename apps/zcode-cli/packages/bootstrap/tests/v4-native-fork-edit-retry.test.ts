// L2：fork/edit/retry 命令组（M4 最后一组）。
// 语义要点（08-phasing M4 完成定义的 L2 层）：
// - rowId→messageId 翻译是原生决策：翻译不到 reject（绝不静默兜底 latestCheckpoint）；
// - editUserQuery = core branch cut + 原生 prompt turn 重发新文本；
// - retryTurn = 原文在 rewind **之前**解析（截断后 transcript 已无该消息）+ 截断 + 重发；
//   原文解析不到直接拒绝，不截断；
// - latest real user query running 时先 stop active turn，再 rewind + rerun；
// - 历史 user query 直接拒绝，且不打断当前 active turn；
// - retry 只允许全时间线最后一条 assistant 回复，历史回复直接拒绝；
// - forkAssistant 经过 stable resolver 后走 conversation-only fork，result 带 forkedSessionId。
import { describe, expect, it, vi } from "vitest";
import { RewindStrategy, SessionEventType } from "@zcode/contracts";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import {
  V4EditTargetNotLatestError,
  V4RetryTargetNotLatestError,
  V4RowTranslationError,
} from "../src/zcode-protocol-v4/commands/handlers/fork-edit-retry.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

function makeApp(overrides: Record<string, unknown> = {}) {
  const runtimeOverrides =
    typeof overrides.runtime === "object" && overrides.runtime !== null ? overrides.runtime : {};
  return {
    sessionId: "s1",
    sendInput: vi.fn().mockImplementation(async (_input, options) => {
      options?.onTurnStartedObserved?.({
        id: "event-started",
        type: SessionEventType.TurnStarted,
        payload: { messageId: "msg-event-started" },
      });
      return {
        completion: Promise.resolve({}),
        kind: "started_turn",
        turnId: "turn-1",
      };
    }),
    submitPrompt: vi.fn().mockResolvedValue({}),
    steerTurn: vi.fn().mockResolvedValue({}),
    readTarget: vi.fn().mockResolvedValue(null),
    updateTargetStatus: vi.fn().mockResolvedValue(null),
    ...overrides,
    runtime: {
      rewindConversationToMessage: vi.fn().mockResolvedValue({
        strategy: RewindStrategy.ActiveChain,
      }),
      ...runtimeOverrides,
    },
  };
}

function makeRecord(
  overrides: Partial<V4SessionRecordView> & { app?: ReturnType<typeof makeApp> } = {},
): V4SessionRecordView {
  return {
    app: (overrides.app ?? makeApp()) as unknown as V4SessionRecordView["app"],
    traceContext: { traceId: "trace-1", sessionId: "s1" } as never,
    workspace: { workspacePath: "/w" },
    persistence: "immediate",
    ...overrides,
  } as V4SessionRecordView;
}

function makeHost(
  record: V4SessionRecordView,
  overrides: Partial<V4CommandCoreHost> = {},
): V4CommandCoreHost {
  const host: V4CommandCoreHost = {
    getRecord: (id) => (id === "s1" ? record : undefined),
    isLatestEditableUserRow: () => true,
    isLatestRetryAssistantRow: () => true,
    waitForProjectionEventCommit: async () => {},
    ...overrides,
  };
  host.resolveRowActionTarget ??= (_sessionId, target, action) => {
    if (action === "editUserQuery") {
      if (host.isLatestEditableUserRow?.("s1", target.rowId) !== true) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      const transcriptMessageId = host.getTurnRewindAnchor?.("s1", target.rowId);
      if (!transcriptMessageId) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return {
        ok: true,
        action,
        row: {} as never,
        editTarget: {
          entityId: target.entityId,
          productTurnId: `turn-${target.rowId}`,
          transcriptMessageId,
          coveredByStableCompact: false,
          intent: { kind: "sendText", text: "原始问题" },
        },
      };
    }
    if (action === "retryTurn") {
      const messageId = host.getMessageIdForRow?.("s1", target.rowId);
      if (host.isLatestRetryAssistantRow?.("s1", target.rowId) !== true || !messageId) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return {
        ok: true,
        action,
        row: {} as never,
        messageId,
        editTarget: {
          entityId: `user-${target.entityId}`,
          productTurnId: `turn-${target.rowId}`,
          transcriptMessageId: `user-${messageId}`,
          coveredByStableCompact: false,
          intent: { kind: "sendText", text: "原始问题" },
        },
      };
    }
    if (action === "applyFileRewind") {
      return {
        ok: true,
        action,
        row: {
          turnId: host.getTurnIdForRow?.("s1", target.rowId) ?? `turn-${target.rowId}`,
        } as never,
        messageIds: host.getMessageIdsForTurnRow?.("s1", target.rowId) ?? [],
      };
    }
    return {
      ok: true,
      action,
      row: {} as never,
      messageId: `msg-${target.rowId}`,
    };
  };
  return host;
}

function envelope(type: string, payload: unknown): CommandEnvelope {
  return {
    type,
    payload,
    sessionId: "s1",
    commandId: "cmd-1",
    baseRevision: 0,
    baseLogEpoch: "epoch-1",
    clientId: "client-new",
  } as unknown as CommandEnvelope;
}

async function settle() {
  // 原生 prompt turn 是 void 起跑的微任务链，flush 两轮保证 finally 执行完。
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * 加速轮的协议原形：Selection 指向隐藏的加速卡内建 Provider（端点/能力都由 Provider Config
 * 提供），只有卡 JWT 与卡 ID 作为本次执行的动态鉴权随 modelExecution 下发。
 */
const ORDINARY_MODEL_SELECTION = {
  providerId: "builtin:bigmodel-coding-plan",
  modelId: "GLM-5.3",
};

const HIGHSPEED_MODEL_SELECTION = {
  providerId: "account:bigmodel-highspeed-card",
  modelId: "GLM-5.3",
};

const HIGHSPEED_MODEL_EXECUTION = {
  selectionScope: "execution" as const,
  requestAuth: {
    apiKey: "card-edit-jwt",
    headers: { Authorization: "Bearer card-edit-jwt", "X-Highspeed-Card-ID": "card-edit" },
  },
  selectionFallback: {
    providerId: "account:bigmodel-highspeed-card",
    target: ORDINARY_MODEL_SELECTION,
    rules: [
      { reason: "highspeed_card_expired" as const, providerErrorCode: "3402" },
      { reason: "highspeed_request_failed" as const },
    ],
  },
};

const originalEditAttachments = [
  {
    ref: "/work/first.txt",
    fileName: "first.txt",
    mime: "text/plain",
    bytes: 12,
  },
  {
    ref: "/work/second.txt",
    fileName: "second.txt",
    mime: "text/plain",
    bytes: 24,
  },
];

function attachmentEditTarget() {
  return {
    ok: true as const,
    action: "editUserQuery" as const,
    row: { rowId: 7, turnId: "turn-7" } as never,
    editTarget: {
      entityId: "entity-7",
      productTurnId: "turn-7",
      transcriptMessageId: "msg-user",
      coveredByStableCompact: false,
      intent: {
        kind: "sendText" as const,
        text: "原始问题",
        attachments: originalEditAttachments,
      },
    },
  };
}

describe("v4 原生 editUserQuery", () => {
  it("正路径：rewind 截断（同 turn assistant 锚点）后原生 turn 重发新文本", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const info = vi.fn();
    const host = makeHost(record, {
      getTurnRewindAnchor: (sessionId, rowId) =>
        sessionId === "s1" && rowId === 7 ? "msg-a" : null,
      logger: { info },
    });

    await new V4CommandExecutor(host).execute(
      envelope("editUserQuery", {
        target: { rowId: 7, entityId: "entity-7" },
        newText: "改过的问题",
      }),
    );
    await settle();

    expect(app.runtime.rewindConversationToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ targetMessageId: "msg-a" }),
    );
    // 重发走原生 prompt turn（sendInput），inputId=commandId 权威锚点。
    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "改过的问题" },
      expect.objectContaining({ inputId: "cmd-1" }),
    );
    // 顺序：先截断后重发。
    expect(app.runtime.rewindConversationToMessage.mock.invocationCallOrder[0]).toBeLessThan(
      app.sendInput.mock.invocationCallOrder[0],
    );
    expect(info).toHaveBeenCalledWith(
      "v4 editUserQuery completed",
      expect.objectContaining({
        attachmentCount: 0,
        clientId: "client-new",
        commandId: "cmd-1",
        event: "conversation.command.edit_user_query.completed",
        intentKind: "sendText",
        sessionId: "s1",
        status: "completed",
        targetEntityId: "entity-7",
        targetRowId: 7,
        traceId: "trace-1",
        workspaceMode: "preserve",
      }),
    );
    const editLogFields = info.mock.calls.find(
      ([message]) => message === "v4 editUserQuery completed",
    )?.[1];
    expect(editLogFields).not.toHaveProperty("newText");
    expect(editLogFields).not.toHaveProperty("text");
  });

  it("编辑重发会应用本次新准备的 Highspeed Selection 与执行材料", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const highspeedMeta = {
      schemaVersion: 1 as const,
      cardId: "card-edit",
      taskId: "s1",
      provider: "bigmodel",
      model: "GLM-5.3",
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
    };
    const host = makeHost(record, { getTurnRewindAnchor: () => "msg-user" });

    await new V4CommandExecutor(host).execute(
      envelope("editUserQuery", {
        target: { rowId: 7, entityId: "entity-7" },
        newText: "改过的问题",
        highspeedMeta,
        modelSelection: HIGHSPEED_MODEL_SELECTION,
        modelExecution: HIGHSPEED_MODEL_EXECUTION,
      }),
    );
    await settle();

    // Selection 可投影（要进 intent 让 transcript 复原时知道这轮走了加速 Provider）。
    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "改过的问题" },
      expect.objectContaining({
        intent: expect.objectContaining({
          highspeed: highspeedMeta,
          modelSelection: HIGHSPEED_MODEL_SELECTION,
        }),
      }),
    );
    const options = app.sendInput.mock.calls[0]?.[1];
    expect(options.modelExecution.selectionScope).toBe("execution");
    expect(options.modelExecution.selectionFallback).toEqual(
      HIGHSPEED_MODEL_EXECUTION.selectionFallback,
    );
    // 卡 JWT 只能作为本轮执行依赖惰性解析，绝不能进入可持久化的 intent。
    await expect(
      options.modelExecution.requestDependencies.requestAuth.source.resolve(),
    ).resolves.toEqual(HIGHSPEED_MODEL_EXECUTION.requestAuth);
    expect(options.intent).not.toHaveProperty("modelExecution");
  });

  it("Highspeed 执行模型可用但退回目标缺失时仍允许编辑重发", async () => {
    const fallbackTarget = {
      providerId: "account:bigmodel-start-plan",
      modelId: "GLM-5.3",
    };
    const app = makeApp({
      listModels: () => [{ ref: HIGHSPEED_MODEL_SELECTION }],
    });
    const record = makeRecord({ app });
    const host = makeHost(record, { getTurnRewindAnchor: () => "msg-user" });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("editUserQuery", {
          target: { rowId: 7, entityId: "entity-7" },
          newText: "执行模型仍可用",
          highspeedMeta: {
            schemaVersion: 1 as const,
            cardId: "card-edit",
            taskId: "s1",
            provider: "bigmodel",
            model: "GLM-5.3",
            issuedAt: 1,
            expiresAt: Date.now() + 60_000,
          },
          modelSelection: HIGHSPEED_MODEL_SELECTION,
          modelExecution: {
            ...HIGHSPEED_MODEL_EXECUTION,
            selectionFallback: {
              ...HIGHSPEED_MODEL_EXECUTION.selectionFallback,
              target: fallbackTarget,
            },
          },
        }),
      ),
    ).resolves.toBeDefined();

    expect(app.runtime.rewindConversationToMessage).toHaveBeenCalledTimes(1);
    expect(app.sendInput).toHaveBeenCalledTimes(1);
  });

  it("编辑预检通过后 Registry 变化仍提交 replacement input", async () => {
    const listModels = vi
      .fn()
      .mockReturnValueOnce([{ ref: HIGHSPEED_MODEL_SELECTION }])
      .mockReturnValue([]);
    const app = makeApp({ listModels });
    const record = makeRecord({ app });
    const host = makeHost(record, { getTurnRewindAnchor: () => "msg-user" });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("editUserQuery", {
          target: { rowId: 7, entityId: "entity-7" },
          newText: "目录变化后仍需保留的编辑内容",
          highspeedMeta: {
            schemaVersion: 1 as const,
            cardId: "card-edit-race",
            taskId: "s1",
            provider: "bigmodel",
            model: "GLM-5.3",
            issuedAt: 1,
            expiresAt: Date.now() + 60_000,
          },
          modelSelection: HIGHSPEED_MODEL_SELECTION,
          modelExecution: {
            ...HIGHSPEED_MODEL_EXECUTION,
            selectionFallback: {
              ...HIGHSPEED_MODEL_EXECUTION.selectionFallback,
              target: { providerId: "user-provider", modelId: "user-model" },
            },
          },
        }),
      ),
    ).resolves.toBeDefined();

    // 破坏性操作前只读取一次目录；branch cut 后由 Core 接纳并对创建失败落权威输入。
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(app.runtime.rewindConversationToMessage).toHaveBeenCalledTimes(1);
    expect(app.sendInput).toHaveBeenCalledTimes(1);
  });

  it("Highspeed 执行模型与退回目标都缺失时在历史和文件回退前拒绝编辑", async () => {
    const previewWorkspaceFileRewind = vi.fn().mockResolvedValue({
      canApply: true,
      safeFiles: [{ action: "restore", operationCount: 1, path: "/w/a.ts", toolNames: ["Edit"] }],
      unsafeFiles: [],
      ignoredFiles: [],
    });
    const applyWorkspaceFileRewind = vi.fn().mockImplementation(async (options) => {
      await options.commitAfterApply();
      return {
        applied: true,
        response: "ok",
        preview: await previewWorkspaceFileRewind(),
      };
    });
    const app = makeApp({
      listModels: () => [],
      runtime: { previewWorkspaceFileRewind, applyWorkspaceFileRewind },
    });
    const record = makeRecord({ app });
    const host = makeHost(record, { getTurnRewindAnchor: () => "msg-user" });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("editUserQuery", {
          target: { rowId: 7, entityId: "entity-7" },
          newText: "不能丢失的编辑内容",
          workspaceMode: "rewind",
          highspeedMeta: {
            schemaVersion: 1 as const,
            cardId: "card-edit",
            taskId: "s1",
            provider: "bigmodel",
            model: "GLM-5.3",
            issuedAt: 1,
            expiresAt: Date.now() + 60_000,
          },
          modelSelection: HIGHSPEED_MODEL_SELECTION,
          modelExecution: {
            ...HIGHSPEED_MODEL_EXECUTION,
            selectionFallback: {
              ...HIGHSPEED_MODEL_EXECUTION.selectionFallback,
              target: {
                providerId: "account:bigmodel-start-plan",
                modelId: "GLM-5.3",
              },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });

    // 模型准入是破坏性编辑的前置条件；失败时没有 branch cut，也没有文件副作用。
    expect(previewWorkspaceFileRewind).not.toHaveBeenCalled();
    expect(applyWorkspaceFileRewind).not.toHaveBeenCalled();
    expect(app.runtime.rewindConversationToMessage).not.toHaveBeenCalled();
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("卡已过期的编辑重发退回会话常驻 Selection，不保留无鉴权的加速 Selection", async () => {
    // CR-01 回归：被编辑的那轮是 Highspeed 轮，canonical intent 里留着 account:*-highspeed-card；
    // 本次没有有效新卡（已过期），旧实现只是不传 modelExecution 却沿用该 Selection，Core 会以
    // ModelRequestAuthMissing 失败，且该 Selection 被固定进新 intent，污染后续普通发送。
    const setModel = vi.fn();
    const app = makeApp({ getModel: () => "builtin:bigmodel-coding-plan/GLM-5.3", setModel });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      resolveRowActionTarget: () => ({
        ok: true,
        action: "editUserQuery",
        row: {} as never,
        editTarget: {
          entityId: "entity-7",
          productTurnId: "turn-7",
          transcriptMessageId: "msg-user",
          coveredByStableCompact: false,
          intent: {
            kind: "sendText",
            text: "原始问题",
            modelSelection: HIGHSPEED_MODEL_SELECTION,
          },
        },
      }),
    });

    await new V4CommandExecutor(host).execute(
      envelope("editUserQuery", {
        target: { rowId: 7, entityId: "entity-7" },
        newText: "改过的问题",
        highspeedMeta: {
          schemaVersion: 1 as const,
          cardId: "card-edit",
          taskId: "s1",
          provider: "bigmodel",
          model: "GLM-5.3",
          issuedAt: 1,
          expiresAt: Date.now() - 1,
        },
        modelSelection: HIGHSPEED_MODEL_SELECTION,
        modelExecution: HIGHSPEED_MODEL_EXECUTION,
      }),
    );
    await settle();

    const options = app.sendInput.mock.calls[0]?.[1];
    expect(options.intent.modelSelection).toEqual({
      providerId: "builtin:bigmodel-coding-plan",
      modelId: "GLM-5.3",
    });
    expect(options.intent).not.toHaveProperty("highspeed");
    expect(options).not.toHaveProperty("modelExecution");
    // 只改本轮 intent，不改 session 常驻模型。
    expect(setModel).not.toHaveBeenCalled();
  });

  it("Highspeed admission 遇到收口竞态时保留编辑文本并进入队列", async () => {
    const pollutedFallbackExecution = {
      ...HIGHSPEED_MODEL_EXECUTION,
      selectionFallback: {
        ...HIGHSPEED_MODEL_EXECUTION.selectionFallback,
        target: HIGHSPEED_MODEL_SELECTION,
      },
    };
    const app = makeApp({
      getModel: () => "builtin:bigmodel-coding-plan/GLM-5.3",
      sendInput: vi.fn().mockImplementation(async (_input, options) => {
        if (options?.requireQueue) {
          return { kind: "queued", queueItemId: "queue-edited" };
        }
        return { kind: "rejected", reason: "turn_not_steerable" };
      }),
    });
    const record = makeRecord({ app });
    const highspeedMeta = {
      schemaVersion: 1 as const,
      cardId: "card-edit",
      taskId: "s1",
      provider: "bigmodel",
      model: "GLM-5.3",
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
    };
    const host = makeHost(record, {
      getTurnRewindAnchor: () => "msg-user",
      retainQueuedTurnExecution: vi.fn(),
      deleteQueuedTurnExecution: vi.fn(),
    });

    await new V4CommandExecutor(host).execute(
      envelope("editUserQuery", {
        target: { rowId: 7, entityId: "entity-7" },
        newText: "竞态下的新问题",
        highspeedMeta,
        modelSelection: HIGHSPEED_MODEL_SELECTION,
        modelExecution: pollutedFallbackExecution,
      }),
    );

    expect(app.runtime.rewindConversationToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ targetMessageId: "msg-user" }),
    );
    expect(app.sendInput).toHaveBeenNthCalledWith(
      1,
      { text: "竞态下的新问题" },
      expect.objectContaining({
        modelExecution: expect.objectContaining({ selectionScope: "execution" }),
      }),
    );
    // 入队路径不能把凭据交给 turn（此时还没有 turn），只投影 Selection + 卡元数据。
    expect(app.sendInput).toHaveBeenNthCalledWith(
      2,
      { text: "竞态下的新问题" },
      expect.objectContaining({
        requireQueue: true,
        intent: expect.objectContaining({
          highspeed: highspeedMeta,
          modelSelection: ORDINARY_MODEL_SELECTION,
        }),
      }),
    );
    expect(app.sendInput.mock.calls[1]?.[1]).not.toHaveProperty("modelExecution");
    // 凭据改由宿主按 commandId 暂存在内存，提升队列项时再冻结成执行上下文。
    expect(host.retainQueuedTurnExecution).toHaveBeenCalledWith("s1", "cmd-1", {
      modelSelection: HIGHSPEED_MODEL_SELECTION,
      modelExecution: pollutedFallbackExecution,
    });
  });

  it("attachments 缺省时稳定保留 canonical 原 refs", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record, { resolveRowActionTarget: attachmentEditTarget });

    await new V4CommandExecutor(host).execute(
      envelope("editUserQuery", {
        target: { rowId: 7, entityId: "entity-7" },
        newText: "只改正文",
      }),
    );
    await settle();

    expect(app.sendInput).toHaveBeenCalledWith(
      {
        text: "只改正文",
        attachments: [
          expect.objectContaining({ path: "/work/first.txt" }),
          expect.objectContaining({ path: "/work/second.txt" }),
        ],
      },
      expect.objectContaining({
        intent: expect.objectContaining({ attachmentRefs: originalEditAttachments }),
      }),
    );
  });

  it("仅附件 edit 使用新数组替换原 refs，并保持剩余顺序", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record, { resolveRowActionTarget: attachmentEditTarget });

    await new V4CommandExecutor(host).execute(
      envelope("editUserQuery", {
        target: { rowId: 7, entityId: "entity-7" },
        newText: "",
        attachments: [originalEditAttachments[1]],
      }),
    );
    await settle();

    expect(app.sendInput).toHaveBeenCalledWith(
      {
        text: "",
        attachments: [expect.objectContaining({ path: "/work/second.txt" })],
      },
      expect.objectContaining({
        intent: expect.objectContaining({ attachmentRefs: [originalEditAttachments[1]] }),
      }),
    );
  });

  it("显式 [] 清空原 refs，而不是恢复 canonical attachments", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record, { resolveRowActionTarget: attachmentEditTarget });

    await new V4CommandExecutor(host).execute(
      envelope("editUserQuery", {
        target: { rowId: 7, entityId: "entity-7" },
        newText: "保留正文",
        attachments: [],
      }),
    );
    await settle();

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "保留正文" },
      expect.objectContaining({
        intent: expect.objectContaining({ attachmentRefs: [] }),
      }),
    );
  });

  it("正文与显式附件数组都为空时在 branch cut 前拒绝", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record, { resolveRowActionTarget: attachmentEditTarget });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("editUserQuery", {
          target: { rowId: 7, entityId: "entity-7" },
          newText: "   ",
          attachments: [],
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "proto.invalidPayload" });
    expect(app.runtime.rewindConversationToMessage).not.toHaveBeenCalled();
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("workspaceMode=rewind：安全文件先恢复，再提交 branch cut 并原 session 重发", async () => {
    const previewWorkspaceFileRewind = vi.fn().mockResolvedValue({
      canApply: true,
      safeFiles: [{ action: "restore", operationCount: 1, path: "/w/a.ts", toolNames: ["Edit"] }],
      unsafeFiles: [],
      ignoredFiles: [],
    });
    const applyWorkspaceFileRewind = vi.fn().mockImplementation(async (options) => {
      await options.commitAfterApply();
      return {
        applied: true,
        response: "ok",
        preview: await previewWorkspaceFileRewind(),
      };
    });
    const app = makeApp({ runtime: { previewWorkspaceFileRewind, applyWorkspaceFileRewind } });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      getMessageIdsForTurnRow: () => ["msg-user", "msg-assistant"],
      resolveRowActionTarget: () => ({
        ok: true,
        action: "editUserQuery",
        row: { rowId: 7, turnId: "turn-7" } as never,
        editTarget: {
          entityId: "entity-7",
          productTurnId: "turn-7",
          transcriptMessageId: "msg-user",
          coveredByStableCompact: true,
          intent: { kind: "sendText", text: "old" },
        },
      }),
    });

    const result = await new V4CommandExecutor(host).execute(
      envelope("editUserQuery", {
        target: { rowId: 7, entityId: "entity-7" },
        newText: "edited",
        workspaceMode: "rewind",
      }),
    );

    expect(previewWorkspaceFileRewind).toHaveBeenCalledWith(
      expect.objectContaining({ targetMessageIds: ["msg-user", "msg-assistant"] }),
    );
    expect(applyWorkspaceFileRewind).toHaveBeenCalledWith(
      expect.objectContaining({ commitAfterApply: expect.any(Function) }),
    );
    expect(app.runtime.rewindConversationToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ targetMessageId: "msg-user" }),
    );
    expect(result).toEqual({ type: "editUserQuery", disposition: "rewind", sessionId: "s1" });
  });

  it("workspaceMode=rewind：unsafe/ignored 结构化 blocked，不裁对话也不发模型请求", async () => {
    const preview = {
      canApply: false,
      safeFiles: [],
      unsafeFiles: [
        {
          operationCount: 1,
          path: "/w/a.ts",
          reason: "external_modified",
          toolNames: ["Edit"],
        },
      ],
      ignoredFiles: [],
    } as const;
    const previewWorkspaceFileRewind = vi.fn().mockResolvedValue(preview);
    const applyWorkspaceFileRewind = vi.fn();
    const app = makeApp({ runtime: { previewWorkspaceFileRewind, applyWorkspaceFileRewind } });
    const record = makeRecord({ app });
    const cancelInputCommand = vi.fn().mockResolvedValue(undefined);
    const host = makeHost(record, {
      cancelInputCommand,
      resolveRowActionTarget: () => ({
        ok: true,
        action: "editUserQuery",
        row: { rowId: 7, turnId: "turn-7" } as never,
        editTarget: {
          entityId: "entity-7",
          productTurnId: "turn-7",
          transcriptMessageId: "msg-user",
          coveredByStableCompact: false,
          intent: { kind: "sendText", text: "old" },
        },
      }),
    });

    const result = await new V4CommandExecutor(host).execute(
      envelope("editUserQuery", {
        target: { rowId: 7, entityId: "entity-7" },
        newText: "edited",
        workspaceMode: "rewind",
      }),
    );

    expect(result).toEqual({
      type: "editUserQuery",
      disposition: "blocked",
      sessionId: "s1",
      reasonCode: "guard.workspaceRewindUnsafeFiles",
      preview,
    });
    expect(cancelInputCommand).toHaveBeenCalledWith(
      "s1",
      "queue_cmd-1",
      "guard.workspaceRewindUnsafeFiles",
    );
    expect(app.runtime.rewindConversationToMessage).not.toHaveBeenCalled();
    expect(app.sendInput).not.toHaveBeenCalled();
    expect(applyWorkspaceFileRewind).not.toHaveBeenCalled();
  });

  it("翻译不到锚点：reject，不静默兜底", async () => {
    const record = makeRecord();
    const info = vi.fn();
    const host = makeHost(record, {
      getTurnRewindAnchor: () => null,
      logger: { info },
      resolveUserMessageIdForRow: async () => null,
    });
    await expect(
      new V4CommandExecutor(host).execute(
        envelope("editUserQuery", {
          target: { rowId: 99, entityId: "entity-99" },
          newText: "x",
        }),
      ),
    ).rejects.toThrow(V4EditTargetNotLatestError);
    expect(info).not.toHaveBeenCalledWith("v4 editUserQuery completed", expect.anything());
  });

  it("running latest query：abort → idle → rewind → rerun", async () => {
    const calls: string[] = [];
    const app = makeApp({
      runtime: {
        rewindConversationToMessage: vi.fn().mockImplementation(async () => {
          calls.push("rewind");
          return { strategy: RewindStrategy.ActiveChain };
        }),
        getActiveTurnInfo: vi
          .fn()
          .mockReturnValueOnce({ turnId: "turn-old" })
          .mockReturnValue(undefined),
      },
      sendInput: vi.fn().mockImplementation(async (_input, options) => {
        calls.push("rerun");
        options?.onTurnStartedObserved?.({
          id: "event-started",
          type: SessionEventType.TurnStarted,
          payload: { messageId: "msg-event-started" },
        });
        return {};
      }),
    });
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      calls.push("abort");
      setTimeout(() => {
        calls.push("idle");
        record.activeAbortController = undefined;
      }, 0);
    });
    const record = makeRecord({ app, activeAbortController: controller });
    const host = makeHost(record, {
      getTurnRewindAnchor: () => "msg-a",
      isLatestEditableUserRow: () => true,
    });

    await new V4CommandExecutor(host).execute(
      envelope("editUserQuery", {
        target: { rowId: 7, entityId: "entity-7" },
        newText: "改过的问题",
      }),
    );
    await settle();

    expect(calls).toEqual(["abort", "idle", "rewind", "rerun"]);
    expect(app.runtime.rewindConversationToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ targetMessageId: "msg-a" }),
    );
  });

  it("runtime-only active turn：没有 Bootstrap controller 也必须先 stop 再 rewind", async () => {
    const calls: string[] = [];
    const app = makeApp({
      runtime: {
        getActiveTurnInfo: vi
          .fn()
          .mockReturnValueOnce({ turnId: "turn-old" })
          .mockReturnValue(undefined),
        stopActiveForegroundExecution: vi.fn().mockImplementation(() => {
          calls.push("stop");
          return { kind: "stopped", foregroundExecutionId: "foreground-old" };
        }),
        rewindConversationToMessage: vi.fn().mockImplementation(async () => {
          calls.push("rewind");
          return { strategy: RewindStrategy.ActiveChain };
        }),
      },
      sendInput: vi.fn().mockImplementation(async () => {
        calls.push("rerun");
        return {};
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, { getTurnRewindAnchor: () => "msg-a" });

    await new V4CommandExecutor(host).execute(
      envelope("editUserQuery", {
        target: { rowId: 7, entityId: "entity-7" },
        newText: "runtime-only 编辑",
      }),
    );

    expect(calls).toEqual(["stop", "rewind", "rerun"]);
    expect(app.runtime.stopActiveForegroundExecution).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "v4 editUserQuery preempts active turn" }),
    );
  });

  it("running 历史 user query：直接拒绝，且不 stop 当前 turn", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      calls.push("abort");
    });
    const record = makeRecord({ activeAbortController: controller });
    const host = makeHost(record, {
      getTurnRewindAnchor: () => "msg-a",
      isLatestEditableUserRow: () => false,
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("editUserQuery", {
          target: { rowId: 7, entityId: "entity-7" },
          newText: "x",
        }),
      ),
    ).rejects.toThrow(V4EditTargetNotLatestError);
    expect(calls).toEqual([]);
    expect(record.activeAbortController).toBe(controller);
  });
});

describe("v4 原生 retryTurn", () => {
  it("Task3：从 canonical cause 以新 commandId 重建完整 intent 与 provenance", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const attachment = {
      ref: "/work/spec.md",
      fileName: "spec.md",
      mime: "text/markdown",
      bytes: 12,
    };
    const host = makeHost(record, {
      resolveRowActionTarget: () => ({
        ok: true,
        action: "retryTurn",
        row: {} as never,
        messageId: "msg-assistant",
        editTarget: {
          entityId: "msg-user",
          productTurnId: "turn-product",
          transcriptMessageId: "msg-user",
          coveredByStableCompact: false,
          intent: {
            kind: "sendText",
            text: "original canonical text",
            sourceCommandId: "cmd-original",
            clientId: "client-original",
            queueItemId: "queue-original",
            requestedDelivery: "guide",
            admittedDelivery: "queue",
            fallbackReasonCode: "guide.attachmentsUnsupported",
            modelSelection: {
              providerId: "original-provider",
              modelId: "original-model",
              options: { reasoningLevel: "high" },
            },
            mode: "edit",
            attachments: [attachment],
          },
        },
      }),
    });

    await new V4CommandExecutor(host).execute(
      envelope("retryTurn", {
        target: { rowId: 5, entityId: "msg-assistant" },
      }),
    );
    await settle();

    expect(app.runtime.rewindConversationToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ targetMessageId: "msg-user" }),
    );
    expect(app.sendInput).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "original canonical text",
        attachments: [expect.objectContaining({ path: "/work/spec.md" })],
      }),
      expect.objectContaining({
        inputId: "cmd-1",
        intent: expect.objectContaining({
          sourceCommandId: "cmd-1",
          kind: "sendText",
          text: "original canonical text",
          requestedDelivery: "guide",
          admittedDelivery: "queue",
          fallbackReasonCode: "guide.attachmentsUnsupported",
          modelSelection: {
            providerId: "original-provider",
            modelId: "original-model",
            options: { reasoningLevel: "high" },
          },
          mode: "edit",
          provenance: {
            sourceCommandId: "cmd-original",
            queueItemId: "queue-original",
            clientId: "client-original",
          },
        }),
      }),
    );
  });

  it("retry Highspeed 轮时没有新执行材料，退回会话常驻 Selection 且不改 session 模型", async () => {
    // CR-01 回归：retry 从 canonical intent 复制历史 Selection；Highspeed 轮的 Selection 是
    // account:*-highspeed-card，本次 retry 没有任何执行材料，必须显式改写回会话常驻 Selection。
    const setModel = vi.fn();
    const app = makeApp({ getModel: () => "builtin:bigmodel-coding-plan/GLM-5.3", setModel });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      resolveRowActionTarget: () => ({
        ok: true,
        action: "retryTurn",
        row: {} as never,
        messageId: "msg-assistant",
        editTarget: {
          entityId: "msg-user",
          productTurnId: "turn-product",
          transcriptMessageId: "msg-user",
          coveredByStableCompact: false,
          intent: {
            kind: "sendText",
            text: "accelerated prompt",
            sourceCommandId: "cmd-original",
            modelSelection: HIGHSPEED_MODEL_SELECTION,
          },
        },
      }),
    });

    await new V4CommandExecutor(host).execute(
      envelope("retryTurn", { target: { rowId: 5, entityId: "msg-assistant" } }),
    );
    await settle();

    const options = app.sendInput.mock.calls[0]?.[1];
    expect(options.intent.modelSelection).toEqual({
      providerId: "builtin:bigmodel-coding-plan",
      modelId: "GLM-5.3",
    });
    expect(options.intent).not.toHaveProperty("highspeed");
    expect(options).not.toHaveProperty("modelExecution");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("retry-of-retry 保留最初 provenance，不被中间 retry 的 queue/client 覆盖", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record, {
      resolveRowActionTarget: () => ({
        ok: true,
        action: "retryTurn",
        row: {} as never,
        messageId: "msg-retry-assistant",
        editTarget: {
          entityId: "msg-retry-user",
          productTurnId: "turn-retry",
          transcriptMessageId: "msg-retry-user",
          coveredByStableCompact: false,
          intent: {
            kind: "sendText",
            text: "retry canonical text",
            sourceCommandId: "cmd-middle-retry",
            queueItemId: "queue-middle-retry",
            clientId: "client-middle-retry",
            provenance: {
              sourceCommandId: "cmd-original",
              queueItemId: "queue-original",
              clientId: "client-original",
            },
          },
        },
      }),
    });

    await new V4CommandExecutor(host).execute(
      envelope("retryTurn", {
        target: { rowId: 8, entityId: "msg-retry-assistant" },
      }),
    );
    await settle();

    expect(app.sendInput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        intent: expect.objectContaining({
          sourceCommandId: "cmd-1",
          provenance: {
            sourceCommandId: "cmd-original",
            queueItemId: "queue-original",
            clientId: "client-original",
          },
        }),
      }),
    );
  });

  it("goal retry preserves sendGoalCommand kind", async () => {
    const app = makeApp({
      getMode: vi.fn().mockReturnValue("plan"),
      setTarget: vi.fn().mockResolvedValue({
        targetID: "g1",
        objective: "goal",
        status: "active",
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      resolveRowActionTarget: () => ({
        ok: true,
        action: "retryTurn",
        row: {} as never,
        messageId: "msg-goal-assistant",
        editTarget: {
          entityId: "msg-goal-user",
          productTurnId: "turn-goal",
          transcriptMessageId: "msg-goal-user",
          coveredByStableCompact: false,
          intent: {
            kind: "sendGoalCommand",
            text: "goal",
            sourceCommandId: "cmd-goal-original",
          },
        },
      }),
    });

    await new V4CommandExecutor(host).execute(
      envelope("retryTurn", {
        target: { rowId: 6, entityId: "msg-goal-assistant" },
      }),
    );

    expect(app.setTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        objective: "goal",
        intent: expect.objectContaining({
          kind: "sendGoalCommand",
          sourceCommandId: "cmd-1",
        }),
      }),
    );
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("重试模型不可用时在 branch cut 前拒绝", async () => {
    const app = makeApp({ listModels: () => [] });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      getMessageIdForRow: () => "msg-assistant",
      resolveRowActionTarget: () => ({
        ok: true,
        action: "retryTurn",
        row: {} as never,
        messageId: "msg-assistant",
        editTarget: {
          entityId: "user-entity-7",
          productTurnId: "turn-7",
          transcriptMessageId: "msg-user",
          coveredByStableCompact: false,
          intent: {
            kind: "sendText",
            text: "原始问题",
            modelSelection: { providerId: "missing-provider", modelId: "missing-model" },
          },
        },
      }),
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("retryTurn", { target: { rowId: 7, entityId: "entity-7" } }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });

    expect(app.runtime.rewindConversationToMessage).not.toHaveBeenCalled();
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("重试预检通过后 Registry 变化仍提交 replacement input", async () => {
    const selection = { providerId: "user-provider", modelId: "user-model" };
    const listModels = vi
      .fn()
      .mockReturnValueOnce([{ ref: selection }])
      .mockReturnValue([]);
    const app = makeApp({ listModels });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      resolveRowActionTarget: () => ({
        ok: true,
        action: "retryTurn",
        row: {} as never,
        messageId: "msg-assistant",
        editTarget: {
          entityId: "user-entity-7",
          productTurnId: "turn-7",
          transcriptMessageId: "msg-user",
          coveredByStableCompact: false,
          intent: { kind: "sendText", text: "必须保留的重试内容", modelSelection: selection },
        },
      }),
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("retryTurn", { target: { rowId: 7, entityId: "entity-7" } }),
      ),
    ).resolves.toBeUndefined();

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(app.runtime.rewindConversationToMessage).toHaveBeenCalledTimes(1);
    expect(app.sendInput).toHaveBeenCalledTimes(1);
  });

  it("canonical resolver 给出的原文在 rewind 后重发", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const resolveOrder: string[] = [];
    const host = makeHost(record, {
      getMessageIdForRow: (_s, rowId) => (rowId === 5 ? "msg-b" : null),
      resolveTurnUserPrompt: async (_s, messageId) => {
        resolveOrder.push("resolve");
        return messageId === "msg-b" ? "原始问题" : null;
      },
    });
    app.runtime.rewindConversationToMessage.mockImplementation(async () => {
      resolveOrder.push("rewind");
      return { strategy: RewindStrategy.ActiveChain };
    });

    await new V4CommandExecutor(host).execute(
      envelope("retryTurn", { target: { rowId: 5, entityId: "entity-5" } }),
    );
    await settle();

    // canonical intent 已由 projection resolver 在截断前给出，不再回读 raw transcript 文本。
    expect(resolveOrder).toEqual(["rewind"]);
    expect(app.runtime.rewindConversationToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ targetMessageId: "user-msg-b" }),
    );
    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "原始问题" },
      expect.objectContaining({ inputId: "cmd-1" }),
    );
  });

  it("canonical cause 不可解析：直接拒绝且不截断", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record, {
      resolveRowActionTarget: () => ({
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      }),
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("retryTurn", { target: { rowId: 5, entityId: "entity-5" } }),
      ),
    ).rejects.toThrow(V4RetryTargetNotLatestError);
    expect(app.runtime.rewindConversationToMessage).not.toHaveBeenCalled();
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("handler 不按 activeAbortController 二次拒绝，而是进入 resolver 授权后的执行路径", async () => {
    const record = makeRecord({ activeAbortController: new AbortController() });
    const host = makeHost(record, { getMessageIdForRow: () => "msg-b" });
    await expect(
      new V4CommandExecutor(host).execute(
        envelope("retryTurn", { target: { rowId: 5, entityId: "entity-5" } }),
      ),
    ).resolves.toBeUndefined();
    expect(record.app.runtime.rewindConversationToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ targetMessageId: "user-msg-b" }),
    );
    expect(record.app.sendInput).toHaveBeenCalled();
  });

  it("非最后一轮 assistant retry 直接拒绝，不解析原文也不 rewind", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const resolveTurnUserPrompt = vi.fn().mockResolvedValue("历史问题");
    const host = makeHost(record, {
      getMessageIdForRow: () => "msg-old",
      isLatestRetryAssistantRow: () => false,
      resolveTurnUserPrompt,
    } as Partial<V4CommandCoreHost>);

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("retryTurn", { target: { rowId: 5, entityId: "entity-5" } }),
      ),
    ).rejects.toThrow(V4RetryTargetNotLatestError);
    expect(resolveTurnUserPrompt).not.toHaveBeenCalled();
    expect(app.runtime.rewindConversationToMessage).not.toHaveBeenCalled();
    expect(app.sendInput).not.toHaveBeenCalled();
  });
});

describe("v4 Task3 canonical edit disposition", () => {
  it("goal edit rewind 后仍走 goal command，并返回 destination ACK", async () => {
    const app = makeApp({
      getMode: vi.fn().mockReturnValue("plan"),
      setTarget: vi.fn().mockResolvedValue({
        targetID: "g1",
        objective: "new goal",
        status: "active",
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      resolveRowActionTarget: () => ({
        ok: true,
        action: "editUserQuery",
        row: {} as never,
        editTarget: {
          entityId: "msg-goal",
          productTurnId: "turn-goal",
          transcriptMessageId: "msg-goal",
          coveredByStableCompact: false,
          intent: {
            kind: "sendGoalCommand",
            text: "old goal",
            sourceCommandId: "cmd-old-goal",
          },
        },
      }),
    });

    const result = await new V4CommandExecutor(host).execute(
      envelope("editUserQuery", {
        target: { rowId: 7, entityId: "msg-goal" },
        newText: "new goal",
      }),
    );

    expect(app.runtime.rewindConversationToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ targetMessageId: "msg-goal" }),
    );
    expect(app.setTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        objective: "new goal",
        intent: expect.objectContaining({
          kind: "sendGoalCommand",
          sourceCommandId: "cmd-1",
        }),
      }),
    );
    expect(app.sendInput).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: "editUserQuery",
      disposition: "rewind",
      sessionId: "s1",
    });
  });

  it("compact-covered latest edit rewinds in the original session and never starts a child", async () => {
    const parentApp = makeApp();
    const childApp = makeApp({ sessionId: "s-child" });
    const parent = makeRecord({ app: parentApp });
    const child = makeRecord({ app: childApp });
    const records = new Map([
      ["s1", parent],
      ["s-child", child],
    ]);
    const forkConversationBeforeInput = vi.fn().mockResolvedValue({
      forkedSessionId: "s-child",
    });
    const host = makeHost(parent, {
      getRecord: (sessionId) => records.get(sessionId),
      forkConversationBeforeInput,
      resolveRowActionTarget: () => ({
        ok: true,
        action: "editUserQuery",
        row: {} as never,
        editTarget: {
          entityId: "msg-user",
          productTurnId: "turn-product",
          transcriptMessageId: "msg-user",
          coveredByStableCompact: true,
          intent: {
            kind: "sendText",
            text: "old text",
            sourceCommandId: "cmd-old",
          },
        },
      }),
    });

    const result = await new V4CommandExecutor(host).execute(
      envelope("editUserQuery", {
        target: { rowId: 7, entityId: "msg-user" },
        newText: "edited in parent",
      }),
    );
    await settle();

    expect(forkConversationBeforeInput).not.toHaveBeenCalled();
    expect(parentApp.runtime.rewindConversationToMessage).toHaveBeenCalledWith(
      expect.objectContaining({ targetMessageId: "msg-user" }),
    );
    expect(parentApp.sendInput).toHaveBeenCalledWith(
      { text: "edited in parent" },
      expect.objectContaining({ inputId: "cmd-1" }),
    );
    expect(childApp.sendInput).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: "editUserQuery",
      disposition: "rewind",
      sessionId: "s1",
    });
  });

  it("compact edit ignores legacy child failure hooks", async () => {
    const parent = makeRecord({ app: makeApp() });
    const childApp = makeApp({ sessionId: "s-child" });
    const child = makeRecord({
      app: childApp,
      restoreWarning: { message: "model unavailable", type: "model" },
    });
    const recordForkStartFailure = vi.fn().mockResolvedValue(undefined);
    const host = makeHost(parent, {
      getRecord: (sessionId) => (sessionId === "s1" ? parent : child),
      forkConversationBeforeInput: vi.fn().mockResolvedValue({ forkedSessionId: "s-child" }),
      recordForkStartFailure,
      resolveRowActionTarget: () => ({
        ok: true,
        action: "editUserQuery",
        row: {} as never,
        editTarget: {
          entityId: "msg-user",
          productTurnId: "turn-product",
          transcriptMessageId: "msg-user",
          coveredByStableCompact: true,
          intent: { kind: "sendText", text: "old", sourceCommandId: "cmd-old" },
        },
      }),
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("editUserQuery", {
          target: { rowId: 7, entityId: "msg-user" },
          newText: "edited",
        }),
      ),
    ).resolves.toEqual({
      type: "editUserQuery",
      disposition: "rewind",
      sessionId: "s1",
    });
    expect(parent.app.sendInput).toHaveBeenCalled();
    expect(childApp.sendInput).not.toHaveBeenCalled();
    expect(recordForkStartFailure).not.toHaveBeenCalled();
  });
});

describe("v4 原生 forkAssistant", () => {
  const stableTarget = {
    productTurnId: "turn-product-1",
    transcriptTurnId: "turn-runtime-1",
    orderedMessageIds: ["msg-user", "msg-tool", "msg-c"],
    boundaryMessageId: "msg-c",
  };
  const goalBoundary = { kind: "none" as const };

  it("PV4-08：running 时解析稳定 logical turn 后走 conversation-only fork", async () => {
    const record = makeRecord();
    record.activeAbortController = new AbortController();
    const info = vi.fn();
    const resolveStableForkTarget = vi
      .fn()
      .mockResolvedValue({ ok: true, target: stableTarget, goalBoundary });
    const forkStableConversation = vi.fn().mockResolvedValue({ forkedSessionId: "s-fork" });
    const host = makeHost(record, {
      resolveStableForkTarget,
      forkStableConversation,
      logger: { info },
    });

    const result = await new V4CommandExecutor(host).execute(
      envelope("forkAssistant", { target: { rowId: 3, entityId: "entity-3" } }),
    );
    expect(resolveStableForkTarget).toHaveBeenCalledWith("s1", 3);
    expect(forkStableConversation).toHaveBeenCalledWith("s1", {
      target: stableTarget,
      goalBoundary,
      sourceCommandId: "cmd-1",
      revisionAtDecision: 0,
    });
    expect(result).toEqual({ type: "forkAssistant", sessionId: "s-fork" });
    expect(info).toHaveBeenCalledWith(
      "v4 forkAssistant completed",
      expect.objectContaining({
        childSessionId: "s-fork",
        clientId: "client-new",
        commandId: "cmd-1",
        event: "conversation.command.fork_assistant.completed",
        parentSessionId: "s1",
        revisionAtDecision: 0,
        sessionId: "s1",
        status: "completed",
        targetBoundaryMessageId: "msg-c",
        targetEntityId: "entity-3",
        targetRowId: 3,
        traceId: "trace-1",
      }),
    );
  });

  it("带 targetCwd：原样透传给宿主 fork，ACK 指向宿主返回的 child", async () => {
    const record = makeRecord();
    const forkStableConversation = vi.fn().mockResolvedValue({ forkedSessionId: "ses_wt_child" });
    const host = makeHost(record, {
      resolveStableForkTarget: vi
        .fn()
        .mockResolvedValue({ ok: true, target: stableTarget, goalBoundary }),
      forkStableConversation,
    });
    const targetCwd = {
      cwd: "/Users/dev/.zcode/worktrees/3f2a/project",
      childSessionId: "ses_wt_child",
      worktreeCreation: {
        path: "/Users/dev/.zcode/worktrees/3f2a/project",
        sha: "9e6d2f72d4",
        ref: null,
        output: "",
      },
    };

    const result = await new V4CommandExecutor(host).execute(
      envelope("forkAssistant", {
        target: { rowId: 3, entityId: "entity-3" },
        targetCwd,
      }),
    );
    expect(forkStableConversation).toHaveBeenCalledWith("s1", {
      target: stableTarget,
      goalBoundary,
      sourceCommandId: "cmd-1",
      revisionAtDecision: 0,
      targetCwd,
    });
    expect(result).toEqual({ type: "forkAssistant", sessionId: "ses_wt_child" });
  });

  it("不带 targetCwd：宿主参数中不出现 targetCwd 键", async () => {
    const record = makeRecord();
    const forkStableConversation = vi.fn().mockResolvedValue({ forkedSessionId: "s-fork" });
    const host = makeHost(record, {
      resolveStableForkTarget: vi
        .fn()
        .mockResolvedValue({ ok: true, target: stableTarget, goalBoundary }),
      forkStableConversation,
    });
    await new V4CommandExecutor(host).execute(
      envelope("forkAssistant", { target: { rowId: 3, entityId: "entity-3" } }),
    );
    expect(forkStableConversation.mock.calls[0]?.[1]).not.toHaveProperty("targetCwd");
  });

  it("目标是 streaming/interrupted/中间段时按稳定 resolver reasonCode 拒绝", async () => {
    const record = makeRecord();
    const info = vi.fn();
    const forkStableConversation = vi.fn();
    const host = makeHost(record, {
      logger: { info },
      resolveStableForkTarget: async () => ({
        ok: false,
        reasonCode: "guard.forkTargetNotStable",
      }),
      forkStableConversation,
    });
    await expect(
      new V4CommandExecutor(host).execute(
        envelope("forkAssistant", {
          target: { rowId: 3, entityId: "entity-3" },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "guard.forkTargetNotStable" });
    expect(forkStableConversation).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalledWith("v4 forkAssistant completed", expect.anything());
  });

  it("stable fork capability 缺失时不回落带 ensureNoActiveTurn 的 legacy bridge", async () => {
    const record = makeRecord();
    const host = makeHost(record, {
      resolveStableForkTarget: async () => ({ ok: true, target: stableTarget, goalBoundary }),
    });
    await expect(
      new V4CommandExecutor(host).execute(
        envelope("forkAssistant", {
          target: { rowId: 3, entityId: "entity-3" },
        }),
      ),
    ).rejects.toThrow("forkStableConversation");
  });
});

describe("v4 原生 applyFileRewind", () => {
  it("rowId 解析为同 turn messageIds 后只执行 workspace file rewind", async () => {
    const app = makeApp({
      runtime: {
        applyWorkspaceFileRewind: vi.fn().mockResolvedValue({
          applied: true,
          response: "Rewound 2 files from summary checkpoints.",
          preview: {
            canApply: true,
            safeFiles: [
              {
                action: "restore",
                operationCount: 1,
                path: "/work/src/a.ts",
                toolNames: ["Edit"],
              },
            ],
            unsafeFiles: [],
            ignoredFiles: [],
          },
        }),
      },
    });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      getMessageIdsForTurnRow: (sessionId, rowId) =>
        sessionId === "s1" && rowId === 3 ? ["msg-a1", "msg-a2"] : [],
    });

    const result = await new V4CommandExecutor(host).execute(
      envelope("applyFileRewind", {
        target: { rowId: 3, entityId: "entity-3" },
      }),
    );

    expect(app.runtime.applyWorkspaceFileRewind).toHaveBeenCalledWith({
      targetMessageIds: ["msg-a1", "msg-a2"],
      targetTurnId: "turn-3",
    });
    expect(app.submitPrompt).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: "applyFileRewind",
      applied: true,
      response: "Rewound 2 files from summary checkpoints.",
    });
  });

  it("handler 不按 activeAbortController 二次拒绝 resolver 已授权的文件撤销", async () => {
    const app = makeApp({
      runtime: {
        applyWorkspaceFileRewind: vi.fn().mockResolvedValue({
          applied: false,
          response: "no changes",
          preview: { canApply: false, safeFiles: [], unsafeFiles: [], ignoredFiles: [] },
        }),
      },
    });
    const record = makeRecord({
      app,
      activeAbortController: new AbortController(),
    });
    const host = makeHost(record, {
      getMessageIdsForTurnRow: () => ["msg-a1"],
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("applyFileRewind", {
          target: { rowId: 3, entityId: "entity-3" },
        }),
      ),
    ).resolves.toMatchObject({ type: "applyFileRewind" });
    expect(app.runtime.applyWorkspaceFileRewind).toHaveBeenCalledTimes(1);
  });
});

it("history edit retains the original Gen UI snapshot with the changed text", async () => {
  const app = makeApp();
  const target = attachmentEditTarget();
  const genUiContext = [{ path: "/project/page.html", state: "ORIGINAL_STATE" }];
  const host = makeHost(makeRecord({ app }), {
    resolveRowActionTarget: () => ({
      ...target,
      editTarget: {
        ...target.editTarget,
        intent: { kind: "sendText", text: "Original", genUiContext },
      },
    }),
  });
  await new V4CommandExecutor(host).execute(
    envelope("editUserQuery", {
      target: { rowId: 7, entityId: "entity-7" },
      newText: "Changed",
    }),
  );
  await settle();
  expect(app.sendInput).toHaveBeenCalledWith(
    { text: "Changed" },
    expect.objectContaining({
      intent: expect.objectContaining({ genUiContext }),
    }),
  );
});
