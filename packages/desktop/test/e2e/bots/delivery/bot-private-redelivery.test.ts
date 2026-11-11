import assert from "node:assert/strict";
import type { IZCodeTaskService } from "@zcode/services";
import type { BotProvider, ZCodeStreamEvent } from "@zcode/shared";
import {
  createBotModelSelectionView,
  createBotsServiceHarness,
  createFeishuConfig,
  createRecordingFeishuFetch,
  readBotSyntheticFixture,
  type RecordedRequest,
} from "#e2e/bots/helpers/bots-service-harness";

type Prompt = Parameters<IZCodeTaskService["sendPrompt"]>[0];
type Harness = ReturnType<typeof createBotsServiceHarness>;
type InboundAttachments = Parameters<Harness["service"]["handleInboundMessage"]>[0]["attachments"];

const TASK_ID = "task-e2e-bot";
// Telegram/微信的 Typing 每 4 秒续发一次；观察窗口超过一个周期才能证明已经停止。
const TYPING_OBSERVE_MS = 5_000;
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按渠道识别 Typing 请求：Telegram sendChatAction、微信 sendtyping、飞书 Typing reaction。 */
function typingRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => /sendChatAction|\/sendtyping|\/reactions/u.test(request.url));
}

function feishuReactionDeletes(requests: RecordedRequest[]): number {
  return requests.filter((r) => r.url.includes("/reactions") && r.method === "DELETE").length;
}

function setupProvider(provider: BotProvider) {
  const requests: RecordedRequest[] = [];
  const feishuFetch = createRecordingFeishuFetch(requests);
  globalThis.fetch = async (input, init) => {
    if (provider === "feishu") {
      // 共享替身先匹配 /im/v1/messages，reaction POST 拿不到 reaction_id，删除会被跳过；
      // 真实飞书返回 reaction_id，这里按真实响应补上，才能观察 Typing reaction 的删除。
      if (String(input).includes("/reactions") && init?.method === "POST") {
        requests.push({ url: String(input), method: "POST" });
        return Response.json({ code: 0, data: { reaction_id: "e2e-typing-reaction" } });
      }
      return feishuFetch(input, init);
    }
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    // 微信 sendtyping 需要先拿到 typing_ticket。
    return new Response(JSON.stringify({ ok: true, ret: 0, typing_ticket: "e2e-ticket" }));
  };
  const config = createFeishuConfig();
  const bot = {
    ...config.bots[0]!,
    provider,
    replyMode: provider === "feishu" ? ("streaming_card" as const) : ("assistant_changes" as const),
  };
  config.bots = [bot];
  // 续聊路径要求会话有可用的有效选择；与 BOT-E2E-BASIS-01 相同的绑定方式。
  const view = createBotModelSelectionView();
  const selection = view.preferredSelection!;
  const broadcastEvents: string[] = [];
  const h = createBotsServiceHarness({
    config,
    modelSelectionService: {
      getView: async () => ({ ...view, effectiveSelection: selection }),
    },
    broadcastService: {
      send: async (message) => {
        const event = (message as { payload?: { event?: unknown } }).payload?.event;
        if (typeof event === "string") broadcastEvents.push(event);
      },
    },
  });
  h.zcodeTaskService.getTaskModelSelection = async () => selection;
  // 任务服务替身按 CLI 命令账本回复：同一个 commandId 第二次提交返回 duplicate，不开新一轮。
  const admitted = new Set<string>();
  h.zcodeTaskService.sendPrompt = async (params: Prompt) => {
    h.sendPromptCalls.push(params);
    const duplicate = admitted.has(params.traceId);
    admitted.add(params.traceId);
    return {
      commandId: params.traceId,
      status: duplicate ? "duplicate" : "accepted",
      revisionAtDecision: 1,
    };
  };
  let taskStatus = "running";
  h.zcodeTaskService.getTaskSnapshot = async () => ({ meta: { status: taskStatus } });
  const replies: unknown[] = [];
  const send = async (
    providerMessageId: string,
    text: string,
    attachments?: InboundAttachments,
  ) => {
    replies.push(
      await h.service.handleInboundMessage({
        botId: bot.id,
        actor: {
          botId: bot.id,
          provider,
          providerUserId: bot.providerUserId!,
          chatType: "private",
          providerContextToken: "e2e-context",
          providerMessageId,
        },
        text,
        ...(attachments ? { attachments } : {}),
      }),
    );
  };
  const waitForPrompts = (count: number) =>
    browser.waitUntil(async () => h.sendPromptCalls.length >= count, {
      timeout: 10_000,
      timeoutMsg: `${provider} 私聊输入没有提交第 ${count} 次，回复：${JSON.stringify(replies)}`,
    });
  const traceIdAt = (index: number) => (h.sendPromptCalls[index] as Prompt).traceId;
  // Bot 自己发起的一轮未结束时，私聊新消息会被“任务运行中”拒绝；线上重投发生在该轮结束之后。
  const completeTurn = async (traceId: string) => {
    const emit = h.subscriptions[0]!.listener;
    const base = { taskId: TASK_ID, traceId, inputId: traceId };
    await emit({
      ...base,
      type: "task_run_started",
      startedAt: Date.now(),
      inputOrigin: "desktop",
    } as ZCodeStreamEvent);
    await emit({ ...base, type: "task_complete", stopReason: "end_turn" } as ZCodeStreamEvent);
  };
  return {
    h,
    requests,
    broadcastEvents,
    send,
    waitForPrompts,
    traceIdAt,
    completeTurn,
    setTaskStatus: (status: string) => {
      taskStatus = status;
    },
  };
}

describe("BOT-E2E-RD-01 private redelivery keeps one command id", () => {
  const originalFetch = globalThis.fetch;
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.service.disposeAllAndWait();
    harness = undefined;
    globalThis.fetch = originalFetch;
  });

  for (const provider of ["feishu", "telegram", "weixin"] satisfies BotProvider[]) {
    it(`${provider}: an idle duplicate reuses the command id and settles typing and running state`, async () => {
      const fixture = await readBotSyntheticFixture("private-redelivery.json");
      assert.equal(fixture.caseId, "BOT-E2E-RD-01");
      const s = setupProvider(provider);
      harness = s.h;

      await s.send("e2e-message-a", `${fixture.promptMarker} A`);
      await s.waitForPrompts(1);
      await s.completeTurn(s.traceIdAt(0));
      s.setTaskStatus("completed");
      const deletesBefore = feishuReactionDeletes(s.requests);
      const eventsBefore = s.broadcastEvents.length;
      // 直接进入业务处理，等同于内存去重过期后、或游标未提交时的重投。
      await s.send("e2e-message-a", `${fixture.promptMarker} A`);
      await s.waitForPrompts(2);
      assert.equal(s.traceIdAt(1), s.traceIdAt(0), "同一条消息重投必须复用同一个 commandId");

      // duplicate 不开新一轮、没有终态事件；Bot 必须按 CLI 快照（空闲）自行收口。
      await browser.waitUntil(
        async () => s.broadcastEvents.slice(eventsBefore).includes("completed"),
        { timeout: 5_000, timeoutMsg: `${provider} duplicate 后没有向桌面广播 completed` },
      );
      if (provider === "feishu") {
        assert.ok(
          feishuReactionDeletes(s.requests) > deletesBefore,
          "飞书 duplicate 后必须删除 Typing reaction",
        );
      } else {
        const settled = typingRequests(s.requests).length;
        await sleep(TYPING_OBSERVE_MS);
        assert.equal(
          typingRequests(s.requests).length,
          settled,
          `${provider} duplicate 收口后仍在续发 Typing`,
        );
      }

      // 运行标记已清：下一条新消息不会被“任务运行中”拒绝，并使用新的 commandId。
      await s.send("e2e-message-b", `${fixture.promptMarker} B`);
      await s.waitForPrompts(3);
      assert.notEqual(s.traceIdAt(2), s.traceIdAt(0), "新消息必须使用新的 commandId");
    });

    it(`${provider}: a duplicate while the task still runs keeps typing until that run ends`, async () => {
      const fixture = await readBotSyntheticFixture("private-redelivery.json");
      const s = setupProvider(provider);
      harness = s.h;

      await s.send("e2e-message-a", `${fixture.promptMarker} A`);
      await s.waitForPrompts(1);
      await s.completeTurn(s.traceIdAt(0));
      // Bot 自己的一轮已结束，但会话里还有别的轮次在执行（例如桌面排队的输入）。
      s.setTaskStatus("running");
      const deletesBefore = feishuReactionDeletes(s.requests);
      const eventsBefore = s.broadcastEvents.length;
      await s.send("e2e-message-a", `${fixture.promptMarker} A`);
      await s.waitForPrompts(2);
      const typingAtDuplicate = typingRequests(s.requests).length;
      await sleep(TYPING_OBSERVE_MS);

      assert.ok(
        !s.broadcastEvents.slice(eventsBefore).includes("completed"),
        "任务仍在运行时不能广播 completed",
      );
      if (provider === "feishu") {
        assert.equal(feishuReactionDeletes(s.requests), deletesBefore, "不能误删运行中的 reaction");
      } else {
        assert.ok(
          typingRequests(s.requests).length > typingAtDuplicate,
          `${provider} 任务仍在运行时 Typing 被误停`,
        );
      }

      // 正在执行的那一轮结束后，按原有终态路径清理。
      await s.completeTurn("e2e-other-running-turn");
      if (provider === "feishu") {
        assert.ok(feishuReactionDeletes(s.requests) > deletesBefore, "终态后必须删除 reaction");
      } else {
        const settled = typingRequests(s.requests).length;
        await sleep(TYPING_OBSERVE_MS);
        assert.equal(
          typingRequests(s.requests).length,
          settled,
          `${provider} 终态后仍在续发 Typing`,
        );
      }
    });
  }

  it("attachment inputs keep a random command id on the legacy send path", async () => {
    const fixture = await readBotSyntheticFixture("private-redelivery.json");
    const s = setupProvider("feishu");
    harness = s.h;
    const attachments: InboundAttachments = [
      {
        id: "e2e-redelivery-attachment",
        kind: "image",
        filename: "redelivery.png",
        mimeType: "image/png",
        dataBase64: PNG_BASE64,
      },
    ];
    await s.send("e2e-message-attachment", `${fixture.promptMarker} file`, attachments);
    await s.waitForPrompts(1);
    await s.completeTurn(s.traceIdAt(0));
    s.setTaskStatus("completed");
    await s.send("e2e-message-attachment", `${fixture.promptMarker} file`, attachments);
    await s.waitForPrompts(2);
    // 旧 session/send 不按 inputId 去重；固定 ID 没有保护，还会让两轮共用一个 inputId。
    assert.ok((s.h.sendPromptCalls[0] as Prompt).attachments?.length, "首次提交必须带附件");
    assert.notEqual(s.traceIdAt(1), s.traceIdAt(0), "附件输入必须保留随机 commandId");
  });
});
