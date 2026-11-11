// Command inbox 单测（M2，10-protocol-spec §6.2/§6.3 的 ACK 裁决表）。
import { describe, expect, it, vi } from "vitest";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationInputIntent,
} from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { CommandInboxHost } from "../src/zcode-protocol-v4/command-inbox.js";
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";

function makeHost(overrides: Partial<CommandInboxHost> = {}): CommandInboxHost {
  return {
    getRevision: () => 7,
    getLogEpoch: () => "epoch-current",
    ...overrides,
  };
}

function envelope(partial: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    commandId: "cmd-1",
    clientId: "client-a",
    sessionId: "s-1",
    type: "sendText",
    payload: { text: "hello" },
    issuedAt: 1,
    ...partial,
  } as CommandEnvelope;
}

describe("CommandInbox ACK 裁决", () => {
  it("重启等待在途命令结算，之后查询重新读取持久事实", async () => {
    const lookup = vi.fn(async () => null);
    const inbox = new CommandInbox(makeHost({ lookupDiscardedCommand: lookup }));
    const outcome = await inbox.handle(envelope());
    if (outcome.kind !== "execute") throw new Error("expected execution");
    let reset = false;
    const resetting = inbox.resetReleasedSession("s-1").then(() => {
      reset = true;
    });
    await Promise.resolve();
    expect(reset).toBe(false);
    outcome.settle({ status: "accepted" });
    await resetting;
    expect(inbox.hasPinnedSessionState("s-1")).toBe(false);
    const result = await inbox.query([{ sessionId: "s-1", commandId: "cmd-1" }]);
    expect(result[0]?.result).toBe("unknown");
    expect(lookup).toHaveBeenCalled();
  });
  it("cold preparation runs after deduplication inside session admission", async () => {
    let revision: number | null = null;
    const prepareDecision = vi.fn(async () => {
      revision = 0;
    });
    const inbox = new CommandInbox(makeHost({ getRevision: () => revision, prepareDecision }));
    const command = envelope({ type: "deleteSession", payload: {} });
    const first = await inbox.handle(command);
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") return;
    revision = null;
    first.settle({ status: "accepted" });
    const retry = await inbox.handle(command);
    expect(retry.ack.status).toBe("duplicate");
    expect(prepareDecision).toHaveBeenCalledTimes(1);
  });
  it("合法命令 → accepted，revisionAtDecision = 当前 revision", async () => {
    const inbox = new CommandInbox(makeHost());
    const outcome = await inbox.handle(envelope());
    expect(outcome.kind).toBe("execute");
    if (outcome.kind !== "execute") return;
    expect(outcome.ack).toEqual({
      commandId: "cmd-1",
      status: "accepted",
      revisionAtDecision: 7,
    });
  });

  it("payload 非法 → rejected proto.invalidPayload", async () => {
    const inbox = new CommandInbox(makeHost());
    const outcome = await inbox.handle(envelope({ payload: { nope: true } }));
    expect(outcome.kind).toBe("ack");
    if (outcome.kind !== "ack") return;
    expect(outcome.ack.status).toBe("rejected");
    expect(outcome.ack.reasonCode).toBe("proto.invalidPayload");
  });

  it("未知会话 → rejected proto.sessionNotFound", async () => {
    const inbox = new CommandInbox(makeHost({ getRevision: () => null }));
    const outcome = await inbox.handle(envelope());
    expect(outcome.kind).toBe("ack");
    if (outcome.kind !== "ack") return;
    expect(outcome.ack.reasonCode).toBe("proto.sessionNotFound");
  });

  it("CAS 命令缺 revision/epoch → invalid；旧 epoch 优先于旧 revision稳定 stale", async () => {
    const inbox = new CommandInbox(makeHost());
    const missing = await inbox.handle(
      envelope({ type: "setAutoDrain", payload: { autoDrain: true } }),
    );
    expect(missing.kind).toBe("ack");
    if (missing.kind !== "ack") return;
    expect(missing.ack.reasonCode).toBe("proto.invalidPayload");

    const stale = await inbox.handle(
      envelope({
        commandId: "cmd-2",
        type: "retryTurn",
        payload: { target: { rowId: 4, entityId: "entity-4" } },
        baseRevision: 3,
        baseLogEpoch: "epoch-old",
      }),
    );
    expect(stale.kind).toBe("ack");
    if (stale.kind !== "ack") return;
    expect(stale.ack.status).toBe("stale");
    expect(stale.ack.reasonCode).toBe("proto.staleLogEpoch");
    expect(stale.ack.revisionAtDecision).toBe(7);

    const staleRevision = await inbox.handle(
      envelope({
        commandId: "cmd-3",
        type: "retryTurn",
        payload: { target: { rowId: 4, entityId: "entity-4" } },
        baseRevision: 3,
        baseLogEpoch: "epoch-current",
      }),
    );
    expect(staleRevision.kind).toBe("ack");
    if (staleRevision.kind === "ack") {
      expect(staleRevision.ack).toMatchObject({
        status: "stale",
        reasonCode: "proto.staleRevision",
      });
    }
  });

  it("row target entity mismatch stale；当前 entity 但 action 不可用 rejected", async () => {
    const inbox = new CommandInbox(
      makeHost({
        validateRowTarget: (env) => {
          const target = (env.payload as { target: { entityId: string } }).target;
          return target.entityId === "entity-current"
            ? { verdict: "reject", reasonCode: "guard.actionUnavailable" }
            : { verdict: "stale", reasonCode: "proto.staleTarget" };
        },
      }),
    );
    const targetEnvelope = (commandId: string, entityId: string): CommandEnvelope =>
      envelope({
        commandId,
        type: "retryTurn",
        payload: { target: { rowId: 8, entityId } },
        baseRevision: 7,
        baseLogEpoch: "epoch-current",
      });

    const stale = await inbox.handle(targetEnvelope("cmd-stale-target", "entity-reused"));
    expect(stale.kind).toBe("ack");
    if (stale.kind === "ack") {
      expect(stale.ack).toMatchObject({
        status: "stale",
        reasonCode: "proto.staleTarget",
      });
    }
    const rejected = await inbox.handle(targetEnvelope("cmd-no-action", "entity-current"));
    expect(rejected.kind).toBe("ack");
    if (rejected.kind === "ack") {
      expect(rejected.ack).toMatchObject({
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      });
    }
  });

  it("guard reject / noop 按宿主裁决透传（晚到 stop = noop，§6.3）", async () => {
    const inbox = new CommandInbox(
      makeHost({
        guard: (env) =>
          env.type === "stop"
            ? { verdict: "noop", reasonCode: "proto.alreadyStopping" }
            : { verdict: "reject", reasonCode: "guard.latestQueryEditOnly" },
      }),
    );
    const noop = await inbox.handle(envelope({ type: "stop", payload: {} }));
    expect(noop.kind).toBe("ack");
    if (noop.kind !== "ack") return;
    expect(noop.ack.status).toBe("noop");
    expect(noop.ack.reasonCode).toBe("proto.alreadyStopping");

    const rejected = await inbox.handle(envelope({ commandId: "cmd-2" }));
    expect(rejected.kind).toBe("ack");
    if (rejected.kind !== "ack") return;
    expect(rejected.ack.status).toBe("rejected");
    expect(rejected.ack.reasonCode).toBe("guard.latestQueryEditOnly");
  });
});

describe("CommandInbox 幂等（§6.2/§6.3）", () => {
  it("app-control 同 key 不同内容返回 conflict，保留原 ACK 与副作用", async () => {
    const inbox = new CommandInbox(makeHost());
    const request = envelope({ commandId: "app-control-reused-request" });
    const first = await inbox.handle(request);
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") return;
    first.settle({
      status: "accepted",
      result: { type: "inputAccepted", delivery: "startNow", queueItemId: "input-original" },
    });

    const conflict = await inbox.handle({ ...request, payload: { text: "different prompt" } });
    expect(conflict).toMatchObject({
      kind: "ack",
      ack: { status: "rejected", reasonCode: "proto.commandConflict" },
    });
    const retry = await inbox.handle({ ...request, issuedAt: 2 });
    expect(retry.ack).toMatchObject({
      status: "duplicate",
      result: { type: "inputAccepted", queueItemId: "input-original" },
    });
    expect(
      (await inbox.query([{ sessionId: request.sessionId, commandId: request.commandId }]))[0]
        ?.result,
    ).toEqual({ ...retry.ack, status: "accepted" });
  });

  it("app-control 在途内容冲突不能共享原 final-result", async () => {
    const inbox = new CommandInbox(makeHost());
    const request = envelope({ commandId: "app-control-in-flight" });
    const first = await inbox.handle(request);
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") return;
    const conflict = inbox.handle({ ...request, payload: { text: "different prompt" } });
    first.settle({ status: "accepted" });
    expect(await conflict).toMatchObject({
      kind: "ack",
      ack: { status: "rejected", reasonCode: "proto.commandConflict" },
    });
  });

  it("app-control 内容摘要忽略重试时间、CAS 水位和 JSON 字段顺序", async () => {
    const inbox = new CommandInbox(makeHost());
    const request = envelope({
      commandId: "app-control-retry",
      payload: { text: "hello", requestedDelivery: "queue" },
    });
    const first = await inbox.handle(request);
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") return;
    first.settle({ status: "accepted" });
    const retry = await inbox.handle({
      ...request,
      issuedAt: 99,
      baseRevision: 42,
      payload: { requestedDelivery: "queue", text: "hello" },
    });
    expect(retry.ack.status).toBe("duplicate");
  });

  // 会话工具设计 0.6：项目 roots 在两次重试之间变化，Host 按当时 roots 补入的附加目录不同；
  // 这类派发时补入的执行上下文不属于调用者请求，不能让同一创建请求变成 conflict。
  it("app-control createSession 重试忽略 Host 补入的执行上下文，仍核验调用者请求", async () => {
    const inbox = new CommandInbox(makeHost());
    const payload = {
      sessionId: "sess-reserved",
      workspaceId: "/project/main",
      firstInput: { text: "hello", mode: "build" },
      additionalDirectories: [],
      dynamicWorkflowEnabled: true,
      dynamicWorkflowMode: "onDemand",
    };
    const request = envelope({
      commandId: "app-control-create-retry",
      sessionId: null,
      type: "createSession",
      payload,
    });
    const first = await inbox.handle(request);
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") return;
    first.settle({ status: "accepted" });
    const retry = await inbox.handle({
      ...request,
      payload: {
        ...payload,
        additionalDirectories: ["/project/second"],
        dynamicWorkflowEnabled: false,
        dynamicWorkflowMode: undefined,
        offPeakToolEnabled: true,
      },
    });
    expect(retry.ack.status).toBe("duplicate");
    for (const changed of [
      { ...payload, firstInput: { text: "different prompt", mode: "build" } },
      { ...payload, workspaceId: "/project/second" },
      { ...payload, sessionId: "sess-other" },
    ]) {
      expect((await inbox.handle({ ...request, payload: changed })).ack.reasonCode).toBe(
        "proto.commandConflict",
      );
    }
  });

  it.each(["in-flight", "settled"] as const)(
    "app-control %s 重试忽略来源会话改名，仍核验来源身份和正文",
    async (state) => {
      const inbox = new CommandInbox(makeHost());
      const source = { kind: "session", sessionId: "caller", title: "原始标题" };
      const payload = { text: "hello", requestedDelivery: "queue", source };
      const request = envelope({ commandId: "app-control-source-retry", payload });
      const first = await inbox.handle(request);
      expect(first.kind).toBe("execute");
      if (first.kind !== "execute") return;
      if (state === "settled") first.settle({ status: "accepted" });
      const retry = inbox.handle({
        ...request,
        payload: { ...payload, source: { ...source, title: "自动生成的新标题" } },
      });
      if (state === "in-flight") first.settle({ status: "accepted" });
      expect((await retry).ack.status).toBe("duplicate");
      expect(first.envelope.payload).toEqual(payload);
      for (const changed of [
        { ...payload, source: { ...source, sessionId: "another-caller" } },
        { ...payload, source: { kind: "genUi", path: "/project/view.html", title: source.title } },
        { ...payload, text: "different prompt" },
      ]) {
        expect((await inbox.handle({ ...request, payload: changed })).ack.reasonCode).toBe(
          "proto.commandConflict",
        );
      }
    },
  );

  it.each(["sendText", "createSession"] as const)(
    "extension 来源参与 %s 请求身份：同来源重试 duplicate，换插件或去掉来源冲突",
    async (type) => {
      // 插件用同一 requestId 重试只能得到一条消息（extension-host §17.10 P3c）；pluginId 是来源身份。
      // 扩展写入经 app-control facade 派发，commandId 带 app-control- 前缀，才进入请求身份比对。
      const inbox = new CommandInbox(makeHost());
      const source = { kind: "extension", pluginId: "gitlab@zcode-plugins-example" };
      const withSource = (value: unknown) =>
        type === "sendText"
          ? { text: "hello", requestedDelivery: "queue", ...(value ? { source: value } : {}) }
          : {
              workspaceId: "/workspace",
              firstInput: { text: "hello", ...(value ? { source: value } : {}) },
            };
      const request = envelope({
        commandId: `app-control-extension-source-${type}`,
        type,
        sessionId: type === "sendText" ? "s-1" : null,
        payload: withSource(source),
      });
      const first = await inbox.handle(request);
      expect(first.kind).toBe("execute");
      if (first.kind !== "execute") return;
      expect(first.envelope.payload).toEqual(withSource(source));
      first.settle({ status: "accepted" });
      expect((await inbox.handle(request)).ack.status).toBe("duplicate");
      for (const changed of [
        withSource({ ...source, pluginId: "jira@zcode-plugins-example" }),
        withSource(undefined),
      ]) {
        expect((await inbox.handle({ ...request, payload: changed })).ack.reasonCode).toBe(
          "proto.commandConflict",
        );
      }
    },
  );

  it("app-control 忽略单次 modelExecution 凭据轮换，仍核验显式模型和执行策略", async () => {
    const inbox = new CommandInbox(makeHost());
    const request = envelope({
      commandId: "app-control-auth-retry",
      payload: {
        text: "hello",
        modelSelection: { providerId: "provider", modelId: "model", options: {} },
        modelExecution: { selectionScope: "execution", requestAuth: { apiKey: "old" } },
      },
    });
    const first = await inbox.handle(request);
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") return;
    first.settle({ status: "accepted" });
    expect(
      (
        await inbox.handle({
          ...request,
          payload: {
            ...(request.payload as object),
            modelExecution: {
              selectionScope: "execution",
              requestAuth: { apiKey: "rotated", headers: { authorization: "rotated" } },
            },
          },
        })
      ).ack.status,
    ).toBe("duplicate");
    expect(
      (
        await inbox.handle({
          ...request,
          payload: {
            ...(request.payload as object),
            modelSelection: { providerId: "provider", modelId: "other-model", options: {} },
          },
        })
      ).ack.reasonCode,
    ).toBe("proto.commandConflict");
    expect(
      (
        await inbox.handle({
          ...request,
          payload: {
            ...(request.payload as object),
            modelExecution: {
              selectionScope: "execution",
              subagents: { foregroundModel: "submission", background: "deny" },
            },
          },
        })
      ).ack.reasonCode,
    ).toBe("proto.commandConflict");
  });

  it("app-control live pin 与解除 pin 后仍核验原请求，不拿派生 intent 代替原请求", async () => {
    const inbox = new CommandInbox(makeHost());
    const request = envelope({ commandId: "app-control-live" });
    const first = await inbox.handle(request);
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") return;
    inbox.pinLiveInput("s-1", intent(request.commandId));
    first.settle({ status: "accepted" });
    for (let index = 0; index <= PROTOCOL_V4_LIMITS.idempotencyTablePerSession; index += 1) {
      await settleAccepted(inbox, `app-control-churn-${index}`);
    }
    const changed = { ...request, type: "stop", payload: {} };
    expect((await inbox.handle(changed)).ack).toMatchObject({
      status: "rejected",
      reasonCode: "proto.commandConflict",
    });
    inbox.releaseLiveInput({ sessionId: "s-1", commandId: request.commandId });
    expect((await inbox.handle(changed)).ack.reasonCode).toBe("proto.commandConflict");
    expect((await inbox.handle({ ...request, issuedAt: 2 })).ack.status).toBe("duplicate");
  });

  it("app-control 冷回源仅有 ACK 时不声称已核验内容，也不误拒原 replay", async () => {
    const inbox = new CommandInbox(
      makeHost({
        lookupTranscriptCommand: (key) => accepted(key.commandId),
      }),
    );
    const retry = await inbox.handle(envelope({ commandId: "app-control-cold-retry" }));
    expect(retry.ack.status).toBe("duplicate");
  });
  it("同 commandId 网络重试：settle 后 → duplicate 回放 result，不重放副作用", async () => {
    const inbox = new CommandInbox(makeHost());
    const first = await inbox.handle(
      envelope({ type: "createSession", sessionId: null, payload: { workspaceId: "w" } }),
    );
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") return;
    first.settle({
      status: "accepted",
      result: { type: "createSession", sessionId: "s-new" },
    });

    const retry = await inbox.handle(
      envelope({ type: "createSession", sessionId: null, payload: { workspaceId: "w" } }),
    );
    expect(retry.kind).toBe("ack");
    if (retry.kind !== "ack") return;
    expect(retry.ack.status).toBe("duplicate");
    expect(retry.ack.result).toEqual({ type: "createSession", sessionId: "s-new" });
  });

  it("在途重复等待同一 final-result promise，不回无 result 的初始 ACK", async () => {
    const inbox = new CommandInbox(makeHost());
    const first = await inbox.handle(envelope());
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") return;
    let retryResolved = false;
    const retryPromise = inbox.handle(envelope()).then((outcome) => {
      retryResolved = true;
      return outcome;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(retryResolved).toBe(false);
    first.settle({
      status: "accepted",
      result: { type: "forkAssistant", sessionId: "fork-child" },
    });
    const retry = await retryPromise;
    expect(retry.kind).toBe("ack");
    if (retry.kind !== "ack") return;
    expect(retry.ack.status).toBe("duplicate");
    expect(retry.ack.result).toEqual({ type: "forkAssistant", sessionId: "fork-child" });
  });

  it("noop 结论进幂等表：同 commandId 重试 → duplicate 携带原 reasonCode", async () => {
    const inbox = new CommandInbox(
      makeHost({
        guard: () => ({ verdict: "noop", reasonCode: "proto.alreadyResolved" }),
      }),
    );
    await inbox.handle(envelope());
    const retry = await inbox.handle(envelope());
    expect(retry.kind).toBe("ack");
    if (retry.kind !== "ack") return;
    expect(retry.ack.status).toBe("duplicate");
    expect(retry.ack.reasonCode).toBe("proto.alreadyResolved");
  });

  it("幂等表 LRU：超过 512 条后最老条目被淘汰，重发不再 duplicate", async () => {
    const inbox = new CommandInbox(makeHost());
    const first = await inbox.handle(envelope({ commandId: "cmd-0" }));
    expect(first.kind).toBe("execute");
    if (first.kind === "execute") first.settle({ status: "accepted" });
    for (let i = 1; i <= PROTOCOL_V4_LIMITS.idempotencyTablePerSession; i += 1) {
      const outcome = await inbox.handle(envelope({ commandId: `cmd-${i}` }));
      if (outcome.kind === "execute") outcome.settle({ status: "accepted" });
    }
    const resent = await inbox.handle(envelope({ commandId: "cmd-0" }));
    // cmd-0 已被淘汰 → 视为新命令重新受理（transcript 兜底属后续片）。
    expect(resent.kind).toBe("execute");
  });

  it("幂等表按 session 隔离：不同 session 同 commandId 互不影响", async () => {
    const inbox = new CommandInbox(makeHost());
    const [a, b] = await Promise.all([
      inbox.handle(envelope({ sessionId: "s-1" })),
      inbox.handle(envelope({ sessionId: "s-2" })),
    ]);
    expect(a.kind).toBe("execute");
    expect(b.kind).toBe("execute");
  });
});

function accepted(commandId: string, revisionAtDecision = 7): CommandAck {
  return { commandId, status: "accepted", revisionAtDecision };
}

function intent(commandId: string): ConversationInputIntent {
  return {
    sourceCommandId: commandId,
    queueItemId: `queue-${commandId}`,
    clientId: "client-a",
    kind: "sendText",
    text: `text-${commandId}`,
    attachments: [],
    delivery: { requested: "queue", admitted: "queue" },
    order: { admissionSeq: 1, queuePosition: 0 },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt: 1,
  };
}

async function settleAccepted(inbox: CommandInbox, commandId: string): Promise<void> {
  const outcome = await inbox.handle(envelope({ commandId }));
  expect(outcome.kind).toBe("execute");
  if (outcome.kind === "execute") outcome.settle({ status: "accepted" });
}

describe("CommandInbox pinned facts 与持久化 fallback（§7.3）", () => {
  it("session 去激活只清 settled/admission 内存，in-flight pin 会拒绝清理", async () => {
    const inbox = new CommandInbox(makeHost());
    const settled = await inbox.handle(envelope({ commandId: "settled-before-deactivate" }));
    expect(settled.kind).toBe("execute");
    if (settled.kind === "execute") settled.settle({ status: "accepted" });

    const running = await inbox.handle(envelope({ commandId: "running-during-deactivate" }));
    expect(running.kind).toBe("execute");
    expect(inbox.hasPinnedSessionState("s-1")).toBe(true);
    expect(inbox.clearSession("s-1")).toBe(false);

    if (running.kind === "execute") running.settle({ status: "accepted" });
    expect(inbox.hasPinnedSessionState("s-1")).toBe(false);
    expect(inbox.clearSession("s-1")).toBe(true);

    const afterColdStart = await inbox.handle(envelope({ commandId: "settled-before-deactivate" }));
    expect(afterColdStart.kind).toBe("execute");
    if (afterColdStart.kind === "execute") {
      expect(afterColdStart.admissionSeq).toBe(1);
      afterColdStart.settle({ status: "accepted" });
    }
  });

  it(">512 settled churn 后新 in-flight 仍为 pinned，query 不会 unknown", async () => {
    const inbox = new CommandInbox(makeHost());
    for (let i = 0; i <= PROTOCOL_V4_LIMITS.idempotencyTablePerSession; i += 1) {
      await settleAccepted(inbox, `settled-${i}`);
    }
    const running = await inbox.handle(envelope({ commandId: "running-pinned" }));
    expect(running.kind).toBe("execute");

    const queryPromise = inbox.query([{ sessionId: "s-1", commandId: "running-pinned" }]);
    if (running.kind === "execute") {
      running.settle({
        status: "accepted",
        result: { type: "forkAssistant", sessionId: "fork-child" },
      });
    }
    const [query] = await queryPromise;
    expect(query?.result).toEqual({
      ...accepted("running-pinned"),
      result: { type: "forkAssistant", sessionId: "fork-child" },
    });
  });

  it("live queue/guide fact 在后续 >512 settled churn 中不被淘汰", async () => {
    const inbox = new CommandInbox(makeHost());
    const live = await inbox.handle(envelope({ commandId: "live-pinned" }));
    expect(live.kind).toBe("execute");
    if (live.kind !== "execute") return;
    inbox.pinLiveInput("s-1", intent("live-pinned"));
    live.settle({ status: "accepted" });

    for (let i = 0; i <= PROTOCOL_V4_LIMITS.idempotencyTablePerSession; i += 1) {
      await settleAccepted(inbox, `after-live-${i}`);
    }
    const [query] = await inbox.query([{ sessionId: "s-1", commandId: "live-pinned" }]);
    expect(query?.result).toEqual(accepted("live-pinned"));
  });

  it("settled LRU 淘汰后 execute 先回源 transcript，不再次执行", async () => {
    let transcriptVisible = false;
    const lookupTranscriptCommand = vi.fn((key: { commandId: string }) =>
      transcriptVisible && key.commandId === "evicted" ? accepted("evicted", 2) : null,
    );
    const inbox = new CommandInbox(makeHost({ lookupTranscriptCommand }));
    await settleAccepted(inbox, "evicted");
    for (let i = 0; i < PROTOCOL_V4_LIMITS.idempotencyTablePerSession; i += 1) {
      await settleAccepted(inbox, `churn-${i}`);
    }
    transcriptVisible = true;

    const retry = await inbox.handle(envelope({ commandId: "evicted" }));
    expect(retry.kind).toBe("ack");
    if (retry.kind === "ack") {
      expect(retry.ack).toMatchObject({ status: "duplicate", revisionAtDecision: 2 });
    }
    expect(lookupTranscriptCommand).toHaveBeenCalledWith({
      sessionId: "s-1",
      commandId: "evicted",
    });
  });

  it("用户删除的 queue input 在 >512 LRU churn 后命中 durable cancelled，不再执行", async () => {
    let cancelledVisible = false;
    const cancelled: CommandAck = {
      commandId: "removed-input",
      status: "failed",
      reasonCode: "fault.command.inputCancelled",
      revisionAtDecision: 0,
    };
    const lookupDiscardedCommand = vi.fn((key: { commandId: string }) =>
      cancelledVisible && key.commandId === "removed-input" ? cancelled : null,
    );
    const inbox = new CommandInbox(makeHost({ lookupDiscardedCommand }));
    await settleAccepted(inbox, "removed-input");
    for (let i = 0; i <= PROTOCOL_V4_LIMITS.idempotencyTablePerSession; i += 1) {
      await settleAccepted(inbox, `removed-churn-${i}`);
    }
    cancelledVisible = true;

    const retry = await inbox.handle(envelope({ commandId: "removed-input" }));
    expect(retry.kind).toBe("ack");
    if (retry.kind === "ack") expect(retry.ack).toEqual(cancelled);
    expect(lookupDiscardedCommand).toHaveBeenCalledWith({
      sessionId: "s-1",
      commandId: "removed-input",
    });
  });

  it("持久化优先级固定为 transcript → marker → child → discarded → unknown", async () => {
    const calls: string[] = [];
    const found = (source: string, result: CommandAck | null) => async () => {
      calls.push(source);
      return result;
    };
    const queryWith = async (hits: Partial<Record<string, CommandAck>>) => {
      calls.length = 0;
      const inbox = new CommandInbox(
        makeHost({
          lookupTranscriptCommand: found("transcript", hits.transcript ?? null),
          lookupTimelineCommand: found("marker", hits.marker ?? null),
          lookupChildCommand: found("child", hits.child ?? null),
          lookupDiscardedCommand: found("discarded", hits.discarded ?? null),
        }),
      );
      return (await inbox.query([{ sessionId: "s-1", commandId: "exact-id" }]))[0]?.result;
    };

    expect(
      await queryWith({ transcript: accepted("exact-id", 1), marker: accepted("exact-id", 2) }),
    ).toMatchObject({ revisionAtDecision: 1 });
    expect(calls).toEqual(["transcript"]);

    expect(
      await queryWith({ marker: accepted("exact-id", 2), child: accepted("exact-id", 3) }),
    ).toMatchObject({ revisionAtDecision: 2 });
    expect(calls).toEqual(["transcript", "marker"]);

    expect(
      await queryWith({ child: accepted("exact-id", 3), discarded: accepted("exact-id", 4) }),
    ).toMatchObject({ revisionAtDecision: 3 });
    expect(calls).toEqual(["transcript", "marker", "child"]);

    const discarded = {
      commandId: "exact-id",
      status: "failed" as const,
      reasonCode: "fault.command.inputDiscardedOnRestart",
      revisionAtDecision: 4,
    };
    expect(await queryWith({ discarded })).toEqual(discarded);
    expect(calls).toEqual(["transcript", "marker", "child", "discarded"]);

    expect(await queryWith({})).toBe("unknown");
    expect(calls).toEqual(["transcript", "marker", "child", "discarded"]);
  });

  it("unknown 不缓存，后续增量索引命中可直接收敛", async () => {
    let result: CommandAck | null = null;
    const inbox = new CommandInbox(makeHost({ lookupTranscriptCommand: () => result }));
    const key = { sessionId: "s-1", commandId: "later" };
    expect((await inbox.query([key]))[0]?.result).toBe("unknown");
    result = accepted("later");
    expect((await inbox.query([key]))[0]?.result).toEqual(accepted("later"));
  });

  it("持久化读取失败显式返回 fault.command.queryUnavailable", async () => {
    const inbox = new CommandInbox(
      makeHost({
        lookupTranscriptCommand: () => Promise.reject(new Error("sqlite busy")),
      }),
    );
    const [query] = await inbox.query([{ sessionId: "s-1", commandId: "cmd-error" }]);
    expect(query?.result).toEqual({
      commandId: "cmd-error",
      status: "failed",
      reasonCode: "fault.command.queryUnavailable",
      revisionAtDecision: 7,
    });
  });

  it("failed settled retry 保持 failed，不被 duplicate 覆盖", async () => {
    const inbox = new CommandInbox(makeHost());
    const first = await inbox.handle(envelope({ commandId: "failed-once" }));
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") return;
    first.settle({ status: "failed", reasonCode: "fault.command.executionFailed" });

    const retry = await inbox.handle(envelope({ commandId: "failed-once" }));
    expect(retry.kind).toBe("ack");
    if (retry.kind === "ack") {
      expect(retry.ack).toMatchObject({
        status: "failed",
        reasonCode: "fault.command.executionFailed",
      });
    }
  });

  it("fork/create child metadata 回放原 child sessionId，不创建第二个 child", async () => {
    const childFacts = new Map([
      [
        "s-1\0fork-command",
        {
          commandId: "fork-command",
          status: "accepted" as const,
          revisionAtDecision: 9,
          result: { type: "forkAssistant" as const, sessionId: "fork-child" },
        },
      ],
      [
        "@global\0create-command",
        {
          commandId: "create-command",
          status: "accepted" as const,
          revisionAtDecision: 0,
          result: { type: "createSession" as const, sessionId: "created-child" },
        },
      ],
    ]);
    const inbox = new CommandInbox(
      makeHost({
        lookupChildCommand: (key) =>
          childFacts.get(`${key.sessionId ?? "@global"}\0${key.commandId}`) ?? null,
      }),
    );

    const forkRetry = await inbox.handle(
      envelope({
        commandId: "fork-command",
        type: "forkAssistant",
        payload: { target: { rowId: 4, entityId: "assistant-4" } },
        baseRevision: 7,
        baseLogEpoch: "epoch-current",
      }),
    );
    const createRetry = await inbox.handle(
      envelope({
        commandId: "create-command",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: "/repo" },
      }),
    );
    expect(forkRetry.kind).toBe("ack");
    expect(createRetry.kind).toBe("ack");
    if (forkRetry.kind === "ack") {
      expect(forkRetry.ack.result).toEqual({ type: "forkAssistant", sessionId: "fork-child" });
    }
    if (createRetry.kind === "ack") {
      expect(createRetry.ack.result).toEqual({ type: "createSession", sessionId: "created-child" });
    }
  });
});

describe("CommandInbox single-flight 与 admission FIFO", () => {
  it("query + execute 同 key 竞态：execute pin 后 query 不会 unknown，重复只执行一次", async () => {
    let releaseLookup!: () => void;
    const lookupBlocked = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let firstLookup = true;
    const inbox = new CommandInbox(
      makeHost({
        lookupTranscriptCommand: async () => {
          if (firstLookup) {
            firstLookup = false;
            await lookupBlocked;
          }
          return null;
        },
      }),
    );
    const raw = envelope({ commandId: "race" });
    const executePromise = inbox.handle(raw);
    const retryPromise = inbox.handle(raw);
    const queryPromise = inbox.query([{ sessionId: "s-1", commandId: "race" }]);
    releaseLookup();

    const execute = await executePromise;
    expect(execute.kind).toBe("execute");
    if (execute.kind === "execute") {
      execute.settle({
        status: "accepted",
        result: { type: "forkAssistant", sessionId: "race-child" },
      });
    }
    const [retry, query] = await Promise.all([retryPromise, queryPromise]);
    expect(retry.kind).toBe("ack");
    if (retry.kind === "ack") {
      expect(retry.ack).toEqual({
        ...accepted("race"),
        status: "duplicate",
        result: { type: "forkAssistant", sessionId: "race-child" },
      });
    }
    expect(query[0]?.result).toEqual({
      ...accepted("race"),
      result: { type: "forkAssistant", sessionId: "race-child" },
    });
  });

  it("同 session commandId 严格 FIFO，admissionSeq 单调；不同 session 可并行", async () => {
    const inbox = new CommandInbox(makeHost());
    const first = await inbox.handle(envelope({ commandId: "fifo-1" }));
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") return;
    expect(first.admissionSeq).toBe(1);

    let sameSessionResolved = false;
    const sameSession = inbox.handle(envelope({ commandId: "fifo-2" })).then((outcome) => {
      sameSessionResolved = true;
      return outcome;
    });
    await Promise.resolve();
    expect(sameSessionResolved).toBe(false);

    const otherSession = await inbox.handle(
      envelope({ sessionId: "s-2", commandId: "parallel-1" }),
    );
    expect(otherSession.kind).toBe("execute");
    if (otherSession.kind === "execute") {
      expect(otherSession.admissionSeq).toBe(1);
      otherSession.settle({ status: "accepted" });
    }

    first.settle({ status: "accepted" });
    const second = await sameSession;
    expect(second.kind).toBe("execute");
    if (second.kind === "execute") {
      expect(second.admissionSeq).toBe(2);
      second.settle({ status: "accepted" });
    }
  });

  it("failed settle 也释放 session FIFO，后续 command 不死锁", async () => {
    const inbox = new CommandInbox(makeHost());
    const first = await inbox.handle(envelope({ commandId: "fifo-failed-1" }));
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") return;
    let secondResolved = false;
    const secondPromise = inbox
      .handle(envelope({ commandId: "fifo-after-failed-2" }))
      .then((outcome) => {
        secondResolved = true;
        return outcome;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(secondResolved).toBe(false);

    first.settle({
      status: "failed",
      reasonCode: "fault.command.executionFailed",
    });
    const second = await secondPromise;
    expect(second.kind).toBe("execute");
    if (second.kind === "execute") second.settle({ status: "accepted" });
  });
});
