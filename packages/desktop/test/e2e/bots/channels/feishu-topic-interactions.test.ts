import type { BotActor, ZCodeStreamEvent } from "@zcode/shared";
import {
  createBotsServiceHarness,
  createFeishuConfig,
  createRecordingFeishuFetch,
  readBotSyntheticFixture,
  type RecordedRequest,
} from "#e2e/bots/helpers/bots-service-harness";

describe("BOT-E2E-TP-03 topic interaction routing", () => {
  for (const provider of ["feishu", "lark"] as const) {
    for (const mentionedBot of [false, true]) {
      it(`${provider} mentioned=${mentionedBot}: keeps permission and question cards in their authorized topic`, async () => {
        const fixture = await readBotSyntheticFixture("feishu-topic-interactions.json");
        expect(fixture.classification).toBe("synthetic");
        const requests: RecordedRequest[] = [];
        const originalFetch = globalThis.fetch;
        const record = createRecordingFeishuFetch(requests);
        globalThis.fetch = async (input, init) => {
          const url = String(input);
          if (url.includes("/im/v1/chats/"))
            return Response.json({ code: 0, data: { name: "E2E Topic", chat_mode: "group" } });
          if (url.includes("/im/v1/messages?"))
            return Response.json({
              code: 0,
              data: {
                items: [
                  {
                    message_id: "om_request",
                    chat_id: "oc_topic",
                    thread_id: "omt_cards",
                    msg_type: "text",
                    body: { content: JSON.stringify({ text: fixture.promptMarker }) },
                    sender: { id: "ou_e2e_user", sender_type: "user" },
                    create_time: "2",
                  },
                  {
                    message_id: "om_root",
                    chat_id: "oc_topic",
                    thread_id: "omt_cards",
                    msg_type: "text",
                    body: { content: JSON.stringify({ text: "Topic root" }) },
                    sender: { id: "app-e2e", sender_type: "app" },
                    create_time: "1",
                  },
                ],
                has_more: false,
              },
            });
          if (url.endsWith("/im/v1/messages/om_root"))
            return Response.json({
              code: 0,
              data: {
                items: [
                  {
                    message_id: "om_root",
                    chat_id: "oc_topic",
                    thread_id: "omt_cards",
                    msg_type: "text",
                    body: { content: JSON.stringify({ text: "Topic root" }) },
                    sender: { id: "app-e2e", sender_type: "app" },
                    create_time: "1",
                  },
                ],
              },
            });
          return record(input, init);
        };
        const botId = `${provider}-topic-card-e2e`;
        const h = createBotsServiceHarness({ config: createFeishuConfig(provider, botId) });
        h.zcodeTaskService.submitBotGroupInput = async (params: { commandId: string }) => ({
          commandId: params.commandId,
          status: "accepted",
          revisionAtDecision: 1,
          result: { type: "inputAccepted", inputId: params.commandId, delivery: "startNow" },
        });
        const actor: BotActor = {
          botId,
          provider,
          chatType: "group",
          chatId: "oc_topic",
          providerUserId: "ou_e2e_user",
        };
        try {
          await h.service.handleInboundMessage({ botId, actor, text: "/enable" });
          await h.service.handleInboundMessage({
            botId,
            actor: {
              ...actor,
              threadId: "omt_cards",
              rootMessageId: "om_root",
              providerMessageId: "om_request",
              mentionedBot,
            },
            text: fixture.promptMarker!,
            mentionedBot,
            topicRootIsCurrentBot: true,
          });
          expect(h.subscriptions).toHaveLength(1);
          requests.length = 0;
          const listener = h.subscriptions[0]!.listener;
          const admitted = (await h.service.getBotStates()).find(
            (state) => state.group?.threadId === "omt_cards",
          )!;
          const inputId = Object.keys(admitted.group!.inputs!)[0]!;
          expect(admitted.group!.inputs![inputId]!.source.mentionedBot).toBe(mentionedBot);
          await listener({
            type: "task_run_started",
            taskId: "task-e2e-bot",
            traceId: "run-cards",
            inputId,
            startedAt: Date.now(),
            inputOrigin: "desktop",
          } as ZCodeStreamEvent);
          await listener({
            type: "permission_request",
            taskId: "task-e2e-bot",
            traceId: "run-cards",
            requestId: "permission-cards",
            kind: "read",
            description: "Read file",
            raw: {},
            options: [
              {
                optionId: "allow",
                kind: "allow_once",
                name: "Allow",
                response: { decision: "allow" },
              },
            ],
          } as ZCodeStreamEvent);
          await listener({
            type: "elicitation_request",
            taskId: "task-e2e-bot",
            traceId: "run-cards",
            requestId: "question-cards",
            message: "Which option?",
            options: [{ value: "first", label: "First" }],
          } as ZCodeStreamEvent);
          const posts = requests.filter(
            (r) =>
              r.method === "POST" && (r.url.endsWith("/reply") || r.url.includes("/messages?")),
          );
          expect(posts).toHaveLength(1);
          // 引用本次触发消息；root 仅作为话题锚点，不再冒充被回复者。
          expect(posts[0]!.url).toContain("/om_request/reply");
          expect(JSON.parse(posts[0]!.body!).reply_in_thread).toBe(true);
          const updates = requests.filter((r) => r.method === "PATCH");
          expect(updates).toHaveLength(1);
          const group = (await h.service.getBotStates()).find(
            (s) => s.group?.threadId === "omt_cards",
          )!.group!;
          for (const request of [posts[0]!, updates[0]!]) {
            const card = JSON.stringify(JSON.parse(JSON.parse(request.body!).content));
            // 权限审批始终提醒管理员；普通问答只提醒明确 @ 机器人的发送者。
            expect(card.includes("<at")).toBe(request === posts[0] || mentionedBot);
            expect(card).toContain("omt_cards");
            expect(card).toContain("task-e2e-bot");
            expect(card).toContain(group.authorizationId!);
          }
        } finally {
          await h.service.disposeAllAndWait();
          globalThis.fetch = originalFetch;
        }
      });
    }
  }
});
