import { channelContentText, type BotActor, type ChannelContentPart } from "@zcode/shared";
import {
  createBotsServiceHarness,
  createFeishuConfig,
  createRecordingFeishuFetch,
  readBotSyntheticFixture,
  type RecordedRequest,
} from "#e2e/bots/helpers/bots-service-harness";

describe("BOT-E2E-MN-01 native channel mentions", () => {
  for (const provider of ["feishu", "lark"] as const) {
    for (const topic of [false, true]) {
      it(`${provider}: preserves targets and delivers once (topic=${topic})`, async () => {
        const fixture = await readBotSyntheticFixture("feishu-channel-mention.json");
        expect(fixture.classification).toBe("synthetic");
        const requests: RecordedRequest[] = [];
        const originalFetch = globalThis.fetch;
        const record = createRecordingFeishuFetch(requests);
        let sendBarrier: { started: () => void; released: Promise<void> } | undefined;
        let parentReads = 0;
        globalThis.fetch = async (input, init) => {
          const url = String(input);
          if (sendBarrier && url.includes("/om_input/reply")) {
            sendBarrier.started();
            await sendBarrier.released;
          }
          if (url.includes("/im/v1/messages/om_options"))
            return Response.json({
              code: 0,
              data: {
                items: [
                  {
                    message_id: "om_options",
                    chat_id: "oc_group",
                    ...(topic ? { thread_id: "omt_native" } : {}),
                    msg_type: "interactive",
                    sender: { id: "ou_other_bot", sender_type: "app" },
                    body: {
                      content: JSON.stringify({
                        elements: [
                          { tag: "markdown", content: "Select workspace" },
                          {
                            tag: "button",
                            text: { content: "Select" },
                            value: { command: "/workspace" },
                          },
                        ],
                      }),
                    },
                  },
                ],
              },
            });
          if (url.includes("/im/v1/messages/om_bot_parent")) {
            parentReads++;
            return Response.json({
              code: 0,
              data: {
                items: [
                  {
                    message_id: "om_bot_parent",
                    chat_id: "oc_group",
                    msg_type: "text",
                    body: { content: JSON.stringify({ text: "Parent bot context" }) },
                  },
                ],
              },
            });
          }
          if (url.endsWith("/bot/v3/info"))
            return Response.json({ code: 0, bot: { open_id: "ou_bot" } });
          if (url.includes("/members?"))
            return Response.json({
              code: 0,
              data: {
                items: [
                  { member_id: "ou_directory", name: "Directory User" },
                  { member_id: "ou_alex_a", name: "Alex" },
                  { member_id: "ou_alex_b", name: "Alex" },
                ],
                has_more: false,
              },
            });
          if (url.includes("/im/v1/chats/"))
            return Response.json({
              code: 0,
              data: { name: "Synthetic group", chat_mode: "group" },
            });
          if (url.includes("/im/v1/messages?"))
            return Response.json({
              code: 0,
              data: {
                items: [
                  {
                    message_id: "om_input",
                    chat_id: "oc_group",
                    thread_id: "omt_native",
                    msg_type: "text",
                    body: {
                      content: JSON.stringify({ text: "E2E_CHANNEL_MENTION 帮我 @Ryan Bot" }),
                    },
                    sender: { id: "ou_e2e_user", sender_type: "user" },
                    create_time: "2",
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
                    chat_id: "oc_group",
                    thread_id: "omt_native",
                    msg_type: "text",
                    body: { content: JSON.stringify({ text: "Root" }) },
                    sender: { id: "ou_e2e_user", sender_type: "user" },
                    create_time: "1",
                  },
                ],
              },
            });
          return record(input, init);
        };
        const botId = `${provider}-native-${topic}`;
        const h = createBotsServiceHarness({ config: createFeishuConfig(provider, botId) });
        h.zcodeTaskService.readBotTopicExecution = async () => undefined;
        h.zcodeTaskService.invalidateBotTopicInputs = async () => undefined;
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
          chatId: "oc_group",
          providerUserId: "ou_e2e_user",
        };
        try {
          await h.service.handleInboundMessage({ botId, actor, text: "/enable" });
          const commandReply = await h.service.handleProviderCallback(provider, {
            botId,
            zcodeBotOpenId: "ou_bot",
            event: {
              sender: { sender_type: "user", sender_id: { open_id: actor.providerUserId } },
              message: {
                chat_type: "group",
                chat_id: actor.chatId,
                message_id: "om_workspace",
                message_type: "text",
                content: JSON.stringify({ text: "@_self /workspace" }),
                mentions: [{ key: "@_self", id: { open_id: "ou_bot" }, name: "Current Bot" }],
              },
            },
          });
          expect(commandReply[0]?.selection?.action).toBe("workspace.set");
          const parts: ChannelContentPart[] = [
            { type: "text", text: `${fixture.promptMarker} 帮我 ` },
            {
              type: "channelMention",
              refId: "om_input:m1",
              channel: provider,
              targetId: "ou_target",
              idType: "open_id",
              entityType: "unknown",
              name: "Ryan Bot",
            },
          ];
          await h.service.handleInboundMessage({
            botId,
            actor: {
              ...actor,
              providerMessageId: "om_input",
              ...(topic ? { threadId: "omt_native", rootMessageId: "om_root" } : {}),
            },
            text: `${fixture.promptMarker} 帮我 @Ryan Bot`,
            contentParts: parts,
          });
          const state = Object.values(h.readState().bots).find(
            (context) =>
              context.group?.threadId === (topic ? "omt_native" : undefined) &&
              context.group?.inputs &&
              Object.keys(context.group.inputs).length,
          )!;
          const [inputId, input] = Object.entries(state.group!.inputs!)[0]!;
          expect(
            await h.service.handleProviderCallback(provider, {
              botId,
              zcodeBotOpenId: "ou_bot",
              event: {
                sender: { sender_type: "bot", sender_id: { open_id: "ou_other_bot" } },
                message: {
                  message_id: "om_plain_card",
                  chat_id: actor.chatId,
                  chat_type: "group",
                  message_type: "interactive",
                  ...(topic ? { thread_id: "omt_native", root_id: "om_root" } : {}),
                  mentions: [{ key: "@_self", id: { open_id: "ou_bot" }, name: "Current Bot" }],
                  content: JSON.stringify({
                    schema: "2.0",
                    body: {
                      elements: [
                        {
                          tag: "markdown",
                          content: "<at id=ou_sender_scope></at> What date is today?",
                        },
                      ],
                    },
                  }),
                },
              },
            }),
          ).toEqual([]);
          const afterPlain = Object.values(h.readState().bots).find(
            (context) => context.activeTaskId === state.activeTaskId,
          )!;
          const plainSource = Object.values(afterPlain.group!.inputs!).at(-1)?.source;
          expect(
            plainSource?.messages?.[0]?.text ?? channelContentText(plainSource?.contentParts ?? []),
          ).toBe("@Current Bot What date is today?");
          const beforeInputs = Object.keys(afterPlain.group!.inputs!);
          const beforeGuard = structuredClone(afterPlain.group!.autoReplyGuard);
          expect(
            await h.service.handleProviderCallback(provider, {
              botId,
              zcodeBotOpenId: "ou_bot",
              event: {
                sender: { sender_type: "bot", sender_id: { open_id: "ou_other_bot" } },
                message: {
                  chat_id: actor.chatId,
                  chat_type: "group",
                  message_id: "om_options",
                  message_type: "interactive",
                  ...(topic ? { thread_id: "omt_native", root_id: "om_root" } : {}),
                  mentions: [{ key: "@_self", id: { open_id: "ou_bot" }, name: "Current Bot" }],
                  content: JSON.stringify({
                    body: {
                      elements: [
                        { tag: "markdown", content: "@_self Select workspace" },
                        {
                          tag: "button",
                          value: { command: "/workspace" },
                          text: { content: "Workspace" },
                        },
                      ],
                    },
                  }),
                },
              },
            }),
          ).toEqual([]);
          expect(
            await h.service.handleProviderCallback(provider, {
              botId,
              zcodeBotOpenId: "ou_bot",
              event: {
                sender: { sender_type: "bot", sender_id: { open_id: "ou_other_bot" } },
                message: {
                  chat_id: actor.chatId,
                  chat_type: "group",
                  message_id: "om_confirmation",
                  parent_id: "om_options",
                  message_type: "text",
                  ...(topic ? { thread_id: "omt_native", root_id: "om_root" } : {}),
                  mentions: [{ key: "@_self", id: { open_id: "ou_bot" }, name: "Current Bot" }],
                  content: JSON.stringify({ text: "@_self Permission response submitted." }),
                },
              },
            }),
          ).toEqual([]);
          expect(
            Object.values(h.readState().bots).find(
              (context) => context.activeTaskId === state.activeTaskId,
            )?.group?.autoReplyGuard,
          ).toEqual(beforeGuard);
          expect(
            Object.keys(
              Object.values(h.readState().bots).find(
                (context) => context.activeTaskId === state.activeTaskId,
              )?.group?.inputs ?? {},
            ),
          ).toEqual(beforeInputs);

          expect(input.source.contentParts).toEqual(parts);
          requests.length = 0;
          const request = {
            taskId: state.activeTaskId!,
            inputId,
            authorizationId: input.source.authorizationId!,
            toolCallId: "native-call",
            workspacePath: state.workspacePath!,
            workspaceIdentity: state.workspaceIdentity,
            parts: [
              { type: "mention" as const, refId: "om_input:m1" },
              { type: "text" as const, text: " 请确认" },
            ],
          };
          const started = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          sendBarrier = { started: started.resolve, released: release.promise };
          const initial = h.service.replyToChannel!(request);
          await started.promise;
          let replaySettled = false;
          const replay = h.service.replyToChannel!(request).then((result) => {
            replaySettled = true;
            return result;
          });
          try {
            // 内存依赖已完成的微任务先排空；平台响应由显式 Promise 屏障控制，不靠延时制造竞态。
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(replaySettled).toBe(false);
          } finally {
            release.resolve();
          }
          const first = await initial;
          expect(await replay).toEqual(first);
          sendBarrier = undefined;
          expect(first.status).toBe("sent");
          expect(await h.service.replyToChannel!(request)).toEqual(first);
          await expect(
            h.service.replyToChannel!({
              ...request,
              toolCallId: "unknown-call",
              parts: [{ type: "mention", refId: "invented" }],
            }),
          ).rejects.toThrow();
          // 同一任务客户端续聊不携带单条消息来源，也不能改变绑定目标。
          const { authorizationId: _authorization, ...followup } = request;
          expect(
            await h.service.replyToChannel!({
              ...followup,
              inputId: "desktop-followup",
              toolCallId: "followup-call",
            }),
          ).toMatchObject({ status: "sent" });
          await expect(
            h.service.replyToChannel!({
              ...followup,
              taskId: "unbound-task",
              toolCallId: "wrong-task",
            }),
          ).rejects.toThrow();
          const named = {
            ...followup,
            toolCallId: "named",
            parts: [
              { type: "mentionName" as const, name: "Directory" },
              { type: "mentionName" as const, name: "Ryan Bot" },
            ],
          };
          expect((await h.service.replyToChannel!(named)).status).toBe("sent");
          expect((await h.service.replyToChannel!(named)).status).toBe("sent");
          // 新任务只收到纯文字名字，仍能复用同群历史原生身份；旧 ref 不能恢复发送授权。
          const previousRequestCount = requests.length;
          const restartedState = h.readState();
          const restartedContext = Object.values(restartedState.bots).find(
            (context) =>
              context.group?.threadId === (topic ? "omt_native" : undefined) &&
              context.group?.inputs?.[inputId],
          )!;
          restartedContext.activeTaskId = "task-after-switch";
          restartedContext.group!.inputs!["new-input"] = {
            ...structuredClone(restartedContext.group!.inputs![inputId]!),
            taskId: "task-after-switch",
            progress: undefined,
            source: {
              ...structuredClone(input.source),
              messageId: "om_new",
              messages: undefined,
              contentParts: [{ type: "text", text: "Find ryan" }],
            },
          };
          const restarted = createBotsServiceHarness({
            config: createFeishuConfig(provider, botId),
            state: restartedState,
          });
          try {
            const newRequest = {
              ...followup,
              taskId: "task-after-switch",
              inputId: "new-input",
              toolCallId: "historical-name",
            };
            expect(
              await restarted.service.replyToChannel!({
                ...newRequest,
                parts: [{ type: "mentionName", name: "ryan" }],
              }),
            ).toMatchObject({ status: "sent" });
            await expect(
              restarted.service.replyToChannel!({ ...newRequest, toolCallId: "historical-ref" }),
            ).rejects.toThrow();
          } finally {
            await restarted.service.disposeAllAndWait();
            requests.splice(previousRequestCount);
          }
          const clarification = await h.service.replyToChannel!({
            ...named,
            toolCallId: "ambiguous",
            parts: [{ type: "mentionName", name: "Alex" }],
          });
          if (clarification.status !== "needs_clarification")
            throw new Error("Expected candidates without sending");
          expect(clarification.unresolved[0]?.candidates).toHaveLength(2);
          expect(
            await h.service.replyToChannel!({
              ...named,
              toolCallId: "missing",
              parts: [
                { type: "mentionName", name: "Missing Bot" },
                { type: "mentionName", name: "Missing User" },
                { type: "mentionName", name: "Directory" },
              ],
            }),
          ).toMatchObject({
            status: "needs_clarification",
            unresolved: [
              { name: "Missing Bot", reason: "not_found" },
              { name: "Missing User", reason: "not_found" },
            ],
          });
          expect(
            (
              await h.service.replyToChannel!({
                ...named,
                toolCallId: "selected",
                parts: [
                  {
                    type: "mentionName",
                    name: "Alex",
                    candidateRef: clarification.unresolved[0]!.candidates[1]!.ref,
                  },
                ],
              })
            ).status,
          ).toBe("sent");
          const posts = requests.filter(
            (r) => r.method === "POST" && r.url.includes("/im/v1/messages"),
          );
          expect(posts).toHaveLength(4);
          expect(posts[2]!.body).toContain("<at id=ou_directory>");
          expect(posts[2]!.body).toContain("<at id=ou_target>");
          expect(posts[3]!.body).toContain("<at id=ou_alex_b>");
          expect(posts[0]!.url).toContain("/om_input/reply");
          const body = JSON.parse(posts[0]!.body!);
          expect(Boolean(body.reply_in_thread)).toBe(topic);
          expect(JSON.parse(body.content).body.elements).toEqual([
            { tag: "markdown", content: "<at id=ou_target></at> 请确认" },
          ]);
          if (!topic) {
            // 使用真实接收事件的 bot 类型；机器人命令正文也只能作为普通输入。
            const payload = {
              botId,
              zcodeProvider: provider,
              zcodeBotOpenId: "ou_bot",
              event: {
                sender: { sender_type: "bot", sender_id: { open_id: "ou_other_bot" } },
                message: {
                  chat_type: "group",
                  chat_id: "oc_group",
                  message_id: "om_bot_main",
                  parent_id: "om_bot_parent",
                  message_type: "text",
                  content: JSON.stringify({ text: "@_bot /stop" }),
                  mentions: [{ key: "@_bot", id: { open_id: "ou_bot" }, name: "Bot" }],
                },
              },
            };
            await h.service.handleProviderCallback(provider, payload);
            expect(parentReads).toBeGreaterThan(0);
            await h.service.handleProviderCallback(provider, payload);
            const groupState = (await h.service.getBotStates()).find(
              (state) => state.group?.chatId === "oc_group" && !state.group.threadId,
            );
            const inputs = Object.values(groupState!.group!.inputs!);
            expect(inputs.filter((input) => input.source.messageId === "om_bot_main")).toHaveLength(
              1,
            );
            expect(
              inputs.find((input) => input.source.messageId === "om_bot_main")?.source,
            ).toMatchObject({
              senderId: "ou_other_bot",
            });
            for (let i = 1; i <= 5; i++) {
              payload.event.message.message_id = `om_bot_limit_${i}`;
              await h.service.handleProviderCallback(provider, payload);
            }
            const readInputs = async () =>
              Object.values(
                (await h.service.getBotStates()).find(
                  (current) => current.group?.chatId === "oc_group" && !current.group.threadId,
                )!.group!.inputs!,
              );
            expect(
              (await readInputs()).filter((entry) => entry.source.senderId === "ou_other_bot"),
            ).toHaveLength(5);
            expect(
              (await readInputs()).some((entry) => entry.source.messageId === "om_bot_limit_5"),
            ).toBe(false);
            await h.service.handleInboundMessage({
              botId,
              actor: { ...actor, providerMessageId: "om_human_resume" },
              text: "continue",
            });
            payload.event.message.message_id = "om_bot_resumed";
            await h.service.handleProviderCallback(provider, payload);
            expect(
              (await readInputs()).some((entry) => entry.source.messageId === "om_bot_resumed"),
            ).toBe(true);
          }
          // 停止仍更新执行状态，但群主聊天和话题都不能再发送停止通知或状态卡。
          const stopActor = {
            ...actor,
            providerMessageId: "om_stop",
            ...(topic ? { threadId: "omt_native", rootMessageId: "om_root" } : {}),
          };
          requests.length = 0;
          expect(
            await h.service.handleInboundMessage({ botId, actor: stopActor, text: "/stop" }),
          ).toEqual([]);
          for (const { listener } of h.subscriptions) {
            await listener({
              type: "task_complete",
              taskId: state.activeTaskId!,
              inputId,
              stopReason: "cancelled",
            } as Parameters<typeof listener>[0]);
          }
          expect(
            requests.filter(
              (request) =>
                request.method === "POST" && /\/messages(?:\?|$|\/[^/]+\/reply)/u.test(request.url),
            ),
          ).toEqual([]);
        } finally {
          await h.service.disposeAllAndWait();
          globalThis.fetch = originalFetch;
        }
      });
    }
  }
});
