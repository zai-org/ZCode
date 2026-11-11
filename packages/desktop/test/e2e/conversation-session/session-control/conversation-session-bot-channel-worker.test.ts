import { createBotWorkerIntegration } from "#e2e/helpers/bot-worker-integration";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  createRecordingFeishuFetch,
  type RecordedRequest,
} from "#e2e/bots/helpers/bots-service-harness";
import { generateTraceId, type BotInboundMessage } from "@zcode/shared";

// 默认工具注册与发送接线暂停；保留原用例及 fixture，待插件入口接入后恢复。
describe.skip("BOT-E2E-MN-02/FN-01 actual channel reply tool chain", () => {
  it("sends a trusted mention then resolves a new typed name from desktop input", async function () {
    this.timeout(180000);
    const replay = await startConversationModelProviderReplayServer(
      "conversation-session-bot-channel-worker",
    );
    const requests: RecordedRequest[] = [];
    const originalFetch = globalThis.fetch;
    const record = createRecordingFeishuFetch(requests);
    globalThis.fetch = async (input, init) => {
      if (!String(input).startsWith("https://open.feishu.cn/"))
        throw new Error("Unexpected non-fixture request");
      if (String(input).includes("/members?"))
        return Response.json({
          code: 0,
          data: {
            items: [{ member_id: "ou_directory", name: "目录目标" }],
            has_more: false,
          },
        });
      if (String(input).includes("/im/v1/chats/"))
        return Response.json({ code: 0, data: { name: "Isolated group" } });
      return record(input, init);
    };
    let cleanup: Awaited<ReturnType<typeof createBotWorkerIntegration>> | undefined;
    const input: BotInboundMessage = {
      botId: "bot-worker",
      text: "E2E_BOT_CHANNEL_FIRST 请提醒 @目标",
      actor: {
        botId: "bot-worker",
        provider: "feishu",
        chatType: "group",
        chatId: "oc_worker",
        providerUserId: "ou_e2e_user",
        providerMessageId: "om_first",
      },
      contentParts: [
        { type: "text", text: "E2E_BOT_CHANNEL_FIRST 请提醒 " },
        {
          type: "channelMention",
          refId: "om_first:m1",
          name: "目标",
          targetId: "ou_target",
          channel: "feishu",
          idType: "open_id",
          entityType: "user",
        },
      ],
    };
    try {
      const host = (cleanup = await createBotWorkerIntegration(
        replay.baseUrl,
        "E2E_CHANNEL_DONE_first",
      ));
      await host.bot.service.handleInboundMessage({
        ...input,
        text: "/enable",
        contentParts: undefined,
      });
      await host.bot.service.handleInboundMessage(input);
      const key = JSON.stringify(["bot-worker", "oc_worker"]);
      let taskId = "";
      await browser.waitUntil(
        async () => {
          taskId = host.bot.readState().bots[key]?.activeTaskId ?? "";
          return !!taskId && host.reverseReplies.length === 1;
        },
        { timeout: 60000, timeoutMsg: "真实 ReplyToChannel 未到达 Host（权限/协议/执行失败）" },
      );
      await browser.waitUntil(
        async () =>
          (await host.agent.readSession({ workspacePath: host.workspacePath, sessionId: taskId }))
            .session.status === "idle",
        { timeout: 30000 },
      );
      expect(
        Object.values(host.bot.readState().bots[key]!.group!.deliveries!)
          .filter((d) => d.contentParts)
          .map((d) => d.status),
      ).toEqual(["sent"]);
      expect(host.droppedTextEvents.length).toBeGreaterThan(0);
      await browser.waitUntil(
        async () =>
          Object.values(host.bot.readState().bots[key]!.group!.deliveries!).some(
            (d) => d.text === "E2E_CHANNEL_DONE_first" && d.status === "sent",
          ),
        { timeout: 15000 },
      );
      expect(
        Object.values(host.bot.readState().bots[key]!.group!.deliveries!).filter(
          (d) => d.text === "E2E_CHANNEL_DONE_first",
        ),
      ).toHaveLength(1);
      await host.task.sendPrompt({
        taskId,
        content: "E2E_BOT_CHANNEL_FOLLOWUP 请 @ 目录目标",
        traceId: generateTraceId("e2e-followup"),
        modelSelection: host.modelSelection,
      });
      await browser.waitUntil(
        async () =>
          host.reverseReplies.length === 2 &&
          (await host.agent.readSession({ workspacePath: host.workspacePath, sessionId: taskId }))
            .session.status === "idle",
        { timeout: 60000 },
      );
      const deliveries = Object.values(host.bot.readState().bots[key]!.group!.deliveries!).filter(
        (d) => d.contentParts,
      );
      expect(deliveries).toHaveLength(2);
      expect(deliveries.map((d) => d.status)).toEqual(["sent", "sent"]);
      expect(
        deliveries.map((d) => d.contentParts?.find((p) => p.type === "channelMention")?.targetId),
      ).toEqual(["ou_target", "ou_directory"]);
      const nativePosts = requests.filter(
        (r) =>
          r.method === "POST" &&
          (r.body?.includes("<at id=ou_target>") || r.body?.includes("<at id=ou_directory>")),
      );
      expect(nativePosts).toHaveLength(2);
      expect(nativePosts.every((r) => r.url.endsWith("/om_first/reply"))).toBe(true);
      expect(host.permissionRequests).toHaveLength(0);
      // 当前产品仍回传模型总结，本 case 不偷偷改变已暂停的重复回执语义。
      expect(host.reverseReplies[1]).not.toHaveProperty("authorizationId");
    } finally {
      await cleanup?.dispose();
      globalThis.fetch = originalFetch;
      await replay.stop();
    }
  });
});
