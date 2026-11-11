import type { BotGroupInputSource } from "@zcode/shared";
import {
  createBotsServiceHarness,
  createFeishuConfig,
  createRecordingFeishuFetch,
  readBotSyntheticFixture,
  type RecordedRequest,
} from "#e2e/bots/helpers/bots-service-harness";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";

describe("BOT-E2E-GR-01 group provider admission", () => {
  for (const provider of ["feishu", "lark"] as const) {
    it(`${provider}: isolates groups, checks roles and acknowledges canonical admission`, async () => {
      const fixture = await readBotSyntheticFixture("feishu-group-collaboration.json");
      expect(fixture.classification).toBe("synthetic");
      const requests: RecordedRequest[] = [];
      const originalFetch = globalThis.fetch;
      const recordingFetch = createRecordingFeishuFetch(requests);
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith("/bot/v3/info"))
          return Response.json({ code: 0, bot: { open_id: "ou_current_bot" } });
        if (url.includes("/im/v1/chats/"))
          return Response.json({ code: 0, data: { name: "E2E Group", chat_mode: "group" } });
        return recordingFetch(input, init);
      };
      const botId = `${provider}-group-e2e`;
      const h = createBotsServiceHarness({ config: createFeishuConfig(provider, botId) });
      const admissions: Array<{ taskId: string; commandId: string; source: BotGroupInputSource }> =
        [];
      let created = 0;
      h.zcodeTaskService.createTask = async () => ({
        taskId: `group-task-${++created}`,
        title: "E2E Group",
        workspacePath: resolveE2ERuntimePath("bots", "e2e-bot-workspace"),
        provider: "glm",
      });
      h.zcodeTaskService.submitBotGroupInput = async (params: (typeof admissions)[number]) => {
        admissions.push(params);
        return {
          commandId: params.commandId,
          status: "accepted",
          revisionAtDecision: admissions.length,
          result: { type: "inputAccepted", inputId: params.commandId, delivery: "queue" },
        };
      };
      let messageSequence = 0;
      const callback = (
        text: string,
        chatId: string,
        sender = "ou_e2e_user",
        botMention = "ou_current_bot",
      ) => ({
        botId,
        event: {
          sender: { sender_type: "user", sender_id: { open_id: sender } },
          message: {
            chat_type: "group",
            chat_id: chatId,
            message_id: `om_group_${++messageSequence}`,
            message_type: "text",
            content: JSON.stringify({ text: `@_user_1 ${text}` }),
            mentions: [{ key: "@_user_1", id: { open_id: botMention }, name: "E2E Bot" }],
          },
        },
      });
      const send = (payload: ReturnType<typeof callback>) =>
        h.service.handleProviderCallbackResponse(provider, payload);
      try {
        await send(callback("/enable", "oc_a", "ou_member"));
        expect((await h.service.getBotStates()).filter((s) => s.group)).toHaveLength(0);
        const enableA = callback("/enable", "oc_a");
        const enableB = callback("/enable", "oc_b");
        await Promise.all([send(enableA), send(enableB)]);
        expect((await h.service.getBotStates()).filter((s) => s.group)).toHaveLength(2);
        const first = callback(fixture.promptMarker!, "oc_a", "ou_member");
        expect((await send(first)).ok).toBe(true);
        await send(first);
        await send(callback(fixture.promptMarker!, "oc_b", "ou_other"));
        await send(callback("ignored", "oc_a", "ou_member", "ou_different_bot"));
        await send(callback("/new", "oc_a", "ou_member"));
        expect(admissions).toHaveLength(2);
        expect(admissions[0]?.source).toMatchObject({
          provider,
          botId,
          chatId: "oc_a",
          senderId: "ou_member",
        });
        expect(admissions[1]?.source).toMatchObject({ chatId: "oc_b", senderId: "ou_other" });
        expect(admissions[0]?.taskId).not.toBe(admissions[1]?.taskId);
        expect(h.sendPromptCalls).toHaveLength(0);
        expect(
          h.subscriptions.every((s) => s.params.deliveryKind === "bot-channel-continuous"),
        ).toBe(true);
        expect(
          requests.filter((r) => r.method === "POST" && r.url.includes("/reactions")),
        ).toHaveLength(2);
        // 群命令按当前产品契约引用原消息；旧断言只接受无引用的 chat_id 发送。
        for (const enabled of [enableA, enableB]) {
          expect(
            requests.some(
              (r) =>
                r.method === "POST" &&
                r.url.endsWith(`/messages/${enabled.event.message.message_id}/reply`),
            ),
          ).toBe(true);
        }
      } finally {
        await h.service.disposeAllAndWait();
        globalThis.fetch = originalFetch;
      }
    });
  }
});
