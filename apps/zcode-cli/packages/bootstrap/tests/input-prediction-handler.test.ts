// v4/conversation/inputPrediction 的 CLI 处理器（docs/web-remote-control/mobile-input-prediction.md）。
import { describe, expect, it, vi } from "vitest";
import type { MessageWithParts } from "@zcode/contracts";
import type { InputPredictionModelCall } from "@zcode/core";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import {
  ConversationInputPredictionHandler,
  collectInputPredictionTurns,
  type InputPredictionSessionMaterial,
} from "../src/zcode-protocol/input-prediction-handler.js";

const SHOW_RESPONSE = '{"candidates":[{"text":"提交代码","confidence":0.9}]}';

function material(callModel: InputPredictionModelCall | null): InputPredictionSessionMaterial {
  return {
    turns: [
      { userText: "修 lint", assistantText: "好了" },
      { userText: "跑单测", assistantText: "通过" },
    ],
    callModel,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ConversationInputPredictionHandler", () => {
  it("返回 show 并回显 requestId；同 (session, revision, draft) 命中缓存不再调模型", async () => {
    const callModel = vi.fn<InputPredictionModelCall>(async () => ({ text: SHOW_RESPONSE }));
    const handler = new ConversationInputPredictionHandler({
      loadSession: async () => material(callModel),
    });
    await expect(handler.handle({ sessionId: "s", revision: 1, requestId: "a" })).resolves.toEqual(
      {
        decision: "show",
        candidates: [{ text: "提交代码", confidence: 0.9 }],
        topConfidence: 0.9,
        requestId: "a",
      },
    );
    await expect(
      handler.handle({ sessionId: "s", revision: 1, requestId: "b" }),
    ).resolves.toMatchObject({ decision: "show", requestId: "b" });
    // 纯空白草稿与无草稿同键。
    await handler.handle({ sessionId: "s", revision: 1, draft: "  " });
    expect(callModel).toHaveBeenCalledTimes(1);
    await handler.handle({ sessionId: "s", revision: 2 });
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("同会话新请求中止旧请求，旧请求回 cancelled", async () => {
    const first = deferred<{ text: string }>();
    let firstSignal: AbortSignal | undefined;
    const callModel = vi.fn<InputPredictionModelCall>(async (_messages, options) => {
      if (!firstSignal) {
        firstSignal = options.abortSignal;
        return first.promise;
      }
      return { text: SHOW_RESPONSE };
    });
    const handler = new ConversationInputPredictionHandler({
      loadSession: async () => material(callModel),
    });
    const stale = handler.handle({ sessionId: "s", revision: 1, draft: "提", requestId: "old" });
    await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(1));
    const fresh = handler.handle({ sessionId: "s", revision: 1, draft: "提交", requestId: "new" });
    await expect(stale).resolves.toEqual({
      decision: "cancelled",
      candidates: [],
      topConfidence: 0,
      requestId: "old",
    });
    expect(firstSignal?.aborted).toBe(true);
    await expect(fresh).resolves.toMatchObject({ decision: "show", requestId: "new" });
  });

  it("不同会话互不中止", async () => {
    const pending = deferred<{ text: string }>();
    const handler = new ConversationInputPredictionHandler({
      loadSession: async (sessionId) =>
        material(sessionId === "a" ? () => pending.promise : async () => ({ text: SHOW_RESPONSE })),
    });
    const a = handler.handle({ sessionId: "a", revision: 1 });
    await expect(handler.handle({ sessionId: "b", revision: 1 })).resolves.toMatchObject({
      decision: "show",
    });
    pending.resolve({ text: SHOW_RESPONSE });
    await expect(a).resolves.toMatchObject({ decision: "show" });
  });

  it("会话不在内存或轮数不够 → suppress_no_context，不调模型", async () => {
    const callModel = vi.fn<InputPredictionModelCall>();
    const missing = new ConversationInputPredictionHandler({ loadSession: async () => null });
    await expect(missing.handle({ sessionId: "s", revision: 0 })).resolves.toMatchObject({
      decision: "suppress_no_context",
    });
    const short = new ConversationInputPredictionHandler({
      loadSession: async () => ({ turns: [{ userText: "hi", assistantText: null }], callModel }),
    });
    await expect(short.handle({ sessionId: "s", revision: 0 })).resolves.toMatchObject({
      decision: "suppress_no_context",
    });
    // 草稿模式 1 轮就够。
    callModel.mockResolvedValue({ text: SHOW_RESPONSE });
    await expect(short.handle({ sessionId: "s", revision: 0, draft: "帮我" })).resolves.toMatchObject(
      { decision: "show" },
    );
  });

  it("无模型、模型失败、超时、读会话失败 → unavailable；日志不含草稿内容；unavailable 不缓存", async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as NonNullable<
      ConstructorParameters<typeof ConversationInputPredictionHandler>[0]["logger"]
    >;
    const noModel = new ConversationInputPredictionHandler({ loadSession: async () => material(null) });
    await expect(noModel.handle({ sessionId: "s", revision: 0 })).resolves.toMatchObject({
      decision: "unavailable",
    });

    const failing = vi.fn<InputPredictionModelCall>(async () => {
      throw new Error("provider down");
    });
    const failed = new ConversationInputPredictionHandler({
      loadSession: async () => material(failing),
      logger,
    });
    await expect(
      failed.handle({ sessionId: "s", revision: 0, draft: "机密草稿" }),
    ).resolves.toMatchObject({ decision: "unavailable" });
    await failed.handle({ sessionId: "s", revision: 0, draft: "机密草稿" });
    expect(failing).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("机密草稿");

    const slow = new ConversationInputPredictionHandler({
      loadSession: async () => material(() => new Promise(() => undefined)),
      timeoutMs: 10,
    });
    await expect(slow.handle({ sessionId: "s", revision: 0 })).resolves.toMatchObject({
      decision: "unavailable",
    });

    const broken = new ConversationInputPredictionHandler({
      loadSession: async () => {
        throw new Error("store gone");
      },
      logger,
    });
    await expect(broken.handle({ sessionId: "s", revision: 0 })).resolves.toMatchObject({
      decision: "unavailable",
    });
  });

  it("模型输出无法解析 → suppress_below_threshold", async () => {
    const handler = new ConversationInputPredictionHandler({
      loadSession: async () => material(async () => ({ text: "抱歉，我不能" })),
    });
    await expect(handler.handle({ sessionId: "s", revision: 0 })).resolves.toMatchObject({
      decision: "suppress_below_threshold",
      candidates: [],
    });
  });

  it("非法参数直接抛错（strict schema）", async () => {
    const handler = new ConversationInputPredictionHandler({ loadSession: async () => null });
    await expect(handler.handle({ sessionId: "s" })).rejects.toThrow();
    await expect(handler.handle({ sessionId: "s", revision: 0, extra: 1 })).rejects.toThrow();
  });

  it("dispose 中止全部进行中的预测", async () => {
    const handler = new ConversationInputPredictionHandler({
      loadSession: async () => material(() => new Promise(() => undefined)),
    });
    const pending = handler.handle({ sessionId: "s", revision: 0, requestId: "r" });
    await Promise.resolve();
    await Promise.resolve();
    handler.dispose(new Error("disconnected"));
    await expect(pending).resolves.toMatchObject({ decision: "cancelled", requestId: "r" });
  });
});

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  extra: Record<string, unknown> = {},
): MessageWithParts {
  return {
    info: { id, sessionID: "s", role, ...extra },
    parts: [{ id: `${id}-p`, type: "text", text }],
  } as unknown as MessageWithParts;
}

describe("collectInputPredictionTurns", () => {
  it("真实用户输入配对到下一条真实用户输入前最后一条非空助手文本；合成消息不算轮次", () => {
    const turns = collectInputPredictionTurns([
      message("u1", "user", "修 lint"),
      message("a1", "assistant", "先看看"),
      message("a2", "assistant", "已修复"),
      message("a3", "assistant", ""),
      message("u2", "user", "系统注入", { synthetic: true }),
      message("u3", "user", "跑单测"),
      message("u4", "user", "   "),
    ]);
    expect(turns).toEqual([
      { userText: "修 lint", assistantText: "已修复" },
      { userText: "跑单测", assistantText: null },
    ]);
  });

  it("隐藏提醒行写在 prompt 与回答之间时，仍取到这一轮最后的回答", () => {
    const hidden = (id: string, source: string) =>
      message(id, "user", `<system-reminder>${source}</system-reminder>`, {
        synthetic: true,
        semantics: { kind: "system_reminder", source, uiVisibility: "hidden" },
      });
    const turns = collectInputPredictionTurns([
      message("u1", "user", "修 lint"),
      hidden("r1", "hook_context"),
      hidden("r2", "date"),
      message("a1", "assistant", "先看看"),
      hidden("r3", "hook_context"),
      message("a2", "assistant", "已修复"),
      message("u2", "user", "跑单测"),
    ]);
    expect(turns).toEqual([
      { userText: "修 lint", assistantText: "已修复" },
      { userText: "跑单测", assistantText: null },
    ]);
  });
});

describe("server 分发 v4/conversation/inputPrediction", () => {
  it("会话不在本进程时回 suppress_no_context 并回显 requestId；非法参数回协议错误", async () => {
    const server = new ZCodeProtocolAgentServer({
      cwd: process.cwd(),
      createZCodeApp: async () => {
        throw new Error("不应为预测创建 app");
      },
    });
    await expect(
      server.handleMessage({
        id: 1,
        method: V4_METHODS.conversationInputPrediction,
        params: { sessionId: "missing", revision: 0, requestId: "r" },
      }),
    ).resolves.toMatchObject({
      id: 1,
      result: { decision: "suppress_no_context", candidates: [], requestId: "r" },
    });
    const invalid = await server.handleMessage({
      id: 2,
      method: V4_METHODS.conversationInputPrediction,
      params: { sessionId: "missing" },
    });
    expect(invalid && "error" in invalid).toBe(true);
  });
});
