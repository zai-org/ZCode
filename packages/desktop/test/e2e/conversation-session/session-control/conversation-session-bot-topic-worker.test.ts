import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createBotWorkerIntegration } from "#e2e/helpers/bot-worker-integration";
import { installBotPlatformFixture } from "#e2e/helpers/bot-platform-fixture";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import type { BotInboundMessage } from "@zcode/shared";

const actor = {
  botId: "bot-worker",
  provider: "feishu" as const,
  chatType: "group" as const,
  chatId: "oc_worker",
  providerUserId: "ou_e2e_user",
};
const key = JSON.stringify([actor.botId, actor.chatId, "omt_worker"]);

describe("BOT-E2E-TP-04/05 real topic worker", () => {
  it("automatically stops a running topic before admitting the next message", async function () {
    this.timeout(180000);
    const replay = await startConversationModelProviderReplayServer(
      "conversation-session-bot-topic-worker",
    );
    const platform = installBotPlatformFixture();
    let cleanup: Awaited<ReturnType<typeof createBotWorkerIntegration>> | undefined;
    try {
      const host = (cleanup = await createBotWorkerIntegration(replay.baseUrl));
      const order: string[] = [];
      const stop = host.task.stopBotTopicExecution!;
      const submit = host.task.submitBotGroupInput!;
      Object.assign(host.bot.zcodeTaskService, {
        stopBotTopicExecution: async (...args: Parameters<typeof stop>) => {
          order.push("stop");
          await stop(...args);
          order.push("stopped");
        },
        submitBotGroupInput: async (...args: Parameters<typeof submit>) => {
          order.push("submit");
          return submit(...args);
        },
      });
      const send = async (id: string, text: string) => {
        platform.add(id, text);
        return host.bot.service.handleInboundMessage({
          botId: actor.botId,
          actor: {
            ...actor,
            threadId: "omt_worker",
            rootMessageId: "om_root",
            providerMessageId: id,
          },
          text,
        });
      };
      await host.bot.service.handleInboundMessage({ botId: actor.botId, actor, text: "/enable" });
      const replies = await send("om_root", "E2E_BOT_TOPIC_SLOW");
      if (!host.bot.readState().bots[key])
        throw new Error(`Topic was not admitted: ${JSON.stringify(replies)}`);
      let taskId = "";
      await browser.waitUntil(
        async () => {
          taskId = host.bot.readState().bots[key]?.activeTaskId ?? "";
          return (
            !!taskId &&
            !!(
              await host.task.readBotTopicExecution!({ workspacePath: host.workspacePath, taskId })
            )?.executionId
          );
        },
        { timeout: 60000 },
      );
      await browser.waitUntil(
        async () => host.observedTextEvents.some((text) => text.includes("E2E_TOPIC_RUNNING")),
        { timeout: 30000 },
      );
      order.length = 0;
      // 原生 @ 指向别人时，运行中的真实 CLI 不能被停止，也不能接收对方任务。
      platform.add("om_other", "@Other Bot handle the outline");
      await host.bot.service.handleProviderCallback("feishu", {
        botId: actor.botId,
        zcodeBotOpenId: "ou_current_bot",
        event: {
          sender: { sender_type: "user", sender_id: { open_id: "ou_e2e_user" } },
          message: {
            chat_type: "group",
            chat_id: actor.chatId,
            thread_id: "omt_worker",
            root_id: "om_root",
            message_id: "om_other",
            message_type: "text",
            content: JSON.stringify({ text: "@_other handle the outline" }),
            mentions: [{ key: "@_other", id: { open_id: "ou_other_bot" }, name: "Other Bot" }],
          },
        },
      });
      expect(order).toEqual([]);
      expect(
        Object.values(host.bot.readState().bots[key]!.group!.inputs!).map(
          (i) => i.source.messageId,
        ),
      ).toEqual(["om_root"]);
      expect(host.bot.readState().bots[key]!.group!.backgroundHistory?.checkpoint).toBe("om_root");
      platform.add("om_next", "E2E_BOT_TOPIC_NEXT");
      const payload = {
        botId: actor.botId,
        zcodeBotOpenId: "ou_current_bot",
        event: {
          sender: { sender_type: "bot", sender_id: { open_id: "ou_other_bot" } },
          message: {
            chat_type: "group",
            chat_id: actor.chatId,
            thread_id: "omt_worker",
            root_id: "om_root",
            message_id: "om_next",
            message_type: "interactive",
            content: JSON.stringify({
              schema: "2.0",
              body: {
                elements: [
                  {
                    tag: "markdown",
                    content:
                      "<at id=ou_self_sender_scope></at> E2E_BOT_TOPIC_NEXT\n<at id=ou_other_sender_scope></at> handle outline",
                  },
                ],
              },
            }),
            mentions: [
              { key: "@_self", id: { open_id: "ou_current_bot" }, name: "Assistant" },
              { key: "@_other", id: { open_id: "ou_recipient" }, name: "Assistant" },
            ],
          },
        },
      };
      await host.bot.service.handleProviderCallback("feishu", payload);
      await host.bot.service.handleProviderCallback("feishu", payload);
      payload.event.sender.sender_id.open_id = "ou_current_bot";
      payload.event.message.message_id = "om_self_echo";
      expect(await host.bot.service.handleProviderCallback("feishu", payload)).toEqual([]);
      await browser.waitUntil(
        async () =>
          Object.values(host.bot.readState().bots[key]?.group?.deliveries ?? {}).some(
            (d) => d.status === "sent" && d.text.includes("E2E_TOPIC_NEXT_DONE"),
          ),
        { timeout: 60000 },
      );
      expect(order).toEqual(["stop", "stopped", "submit"]);
      expect(
        Object.values(host.bot.readState().bots[key]!.group!.inputs!).at(-1)?.source.senderId,
      ).toBe("ou_other_bot");
      const group = host.bot.readState().bots[key]!.group!;
      expect(Object.values(group.inputs!).map((i) => i.source.messageId)).toEqual([
        "om_root",
        "om_next",
      ]);
      expect(Object.values(group.inputs!).every((i) => i.admission === "accepted")).toBe(true);
      const nextSource = Object.values(group.inputs!).at(-1)!.source;
      expect(nextSource.messages?.[0]?.text).toBe(
        "@Assistant E2E_BOT_TOPIC_NEXT\n@Assistant handle outline",
      );
      expect(
        nextSource.messages?.[0]?.contentParts
          ?.filter((part) => part.type === "channelMention")
          .map((part) => part.targetId),
      ).toEqual(["ou_current_bot", "ou_recipient"]);
      expect(nextSource.botIdentity?.openId).toBe("ou_current_bot");
      const captured = JSON.parse(await readFile(replay.artifactPath, "utf8"));
      const strings: string[] = [];
      const collect = (value: unknown): void => {
        if (typeof value === "string") strings.push(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
      };
      collect(captured);
      const mentions = strings
        .filter((value) => value.includes("Trusted ordered message content"))
        .join("\n");
      expect(mentions).toContain('"name":"Assistant","channel":"feishu","isCurrentBot":true');
      expect(mentions).toContain('"name":"Assistant","channel":"feishu","isCurrentBot":false');
      expect(mentions).not.toContain("ou_recipient");
      expect(mentions).not.toContain("ReplyToChannel");
      expect(mentions).not.toContain('"refId"');
      const positioned = strings
        .filter((value) => value.includes("Trusted ordered message content"))
        .join("\n");
      expect(positioned).toContain(
        '"isCurrentBot":true},{"type":"text","text":" E2E_BOT_TOPIC_NEXT\\n"}',
      );
      expect(positioned).toContain(
        '"isCurrentBot":false},{"type":"text","text":" handle outline"}',
      );
      expect(positioned).not.toContain('"targetId"');

      expect(nextSource.topicContext?.messages.some((message) => message.id === "om_other")).toBe(
        true,
      );
      expect(group.backgroundHistory).toBeUndefined();
      expect(
        Object.values(group.deliveries!).some((d) => d.text.includes("E2E_TOPIC_OLD_FINAL")),
      ).toBe(false);
      expect(platform.requests.some((r) => r.body?.includes("Waiting to run"))).toBe(false);
      payload.event.sender.sender_id.open_id = "ou_other_bot";
      payload.event.message.mentions = [];
      payload.event.message.message_type = "text";
      for (let i = 2; i <= 5; i++) {
        const id = `om_bot_turn_${i}`;
        const text = i === 5 ? "E2E_BOT_TOPIC_SLOW" : "E2E_BOT_TOPIC_NEXT";
        platform.add(id, text);
        payload.event.message.content = JSON.stringify({ text });
        payload.event.message.message_id = id;
        await host.bot.service.handleProviderCallback("feishu", payload);
      }
      const fifthInputId = Object.entries(host.bot.readState().bots[key]!.group!.inputs!).find(
        ([, entry]) => entry.source.messageId === "om_bot_turn_5",
      )![0];
      await browser.waitUntil(
        async () =>
          (await host.task.readBotTopicExecution!({ workspacePath: host.workspacePath, taskId }))
            ?.sourceCommandId === fifthInputId,
        { timeout: 30000 },
      );
      order.length = 0;
      payload.event.message.content = JSON.stringify({ text: "E2E_BOT_TOPIC_NEXT" });
      payload.event.message.message_id = "om_bot_turn_6";
      platform.add("om_bot_turn_6", "E2E_BOT_TOPIC_NEXT");
      await host.bot.service.handleProviderCallback("feishu", payload);
      expect(order).toEqual([]);
      expect(
        Object.values(host.bot.readState().bots[key]!.group!.inputs!).some(
          (entry) => entry.source.messageId === "om_bot_turn_6",
        ),
      ).toBe(false);
      await send("om_human_resume", "E2E_BOT_TOPIC_NEXT");
      payload.event.message.message_id = "om_bot_resumed";
      platform.add("om_bot_resumed", "E2E_BOT_TOPIC_NEXT");
      await host.bot.service.handleProviderCallback("feishu", payload);
      expect(
        Object.values(host.bot.readState().bots[key]!.group!.inputs!).some(
          (entry) => entry.source.messageId === "om_bot_resumed" && entry.admission === "accepted",
        ),
      ).toBe(true);
      await send("om_batch_running", "E2E_BOT_TOPIC_SLOW");
      await browser.waitUntil(
        async () =>
          !!(await host.task.readBotTopicExecution!({ workspacePath: host.workspacePath, taskId }))
            ?.executionId,
        { timeout: 30000 },
      );
      const entered = Promise.withResolvers<void>();
      const releaseBatch = Promise.withResolvers<void>();
      Object.assign(host.bot.zcodeTaskService, {
        stopBotTopicExecution: async (...args: Parameters<typeof stop>) => {
          entered.resolve();
          await releaseBatch.promise;
          await stop(...args);
        },
      });
      const batchMessage = (id: string, text: string, commandText: string) => {
        platform.add(id, text);
        return host.bot.service.handleInboundMessage({
          botId: actor.botId,
          actor: {
            ...actor,
            threadId: "omt_worker",
            rootMessageId: "om_root",
            providerMessageId: id,
          },
          text,
          commandText,
          mentionedBot: true,
        });
      };
      const requirement = batchMessage(
        "om_batch_request",
        "@Bot E2E_BOT_TOPIC_NEXT",
        "E2E_BOT_TOPIC_NEXT",
      );
      await entered.promise;
      const wakeup = batchMessage("om_batch_wakeup", "@Bot", "");
      try {
        await browser.waitUntil(
          async () =>
            (await host.bot.service.getBotStates()).find(
              (state) => state.group?.threadId === "omt_worker",
            )?.group?.preparation?.length === 2,
          { timeout: 10000 },
        );
      } finally {
        releaseBatch.resolve();
      }
      await Promise.all([requirement, wakeup]);
      const acceptedBatch = Object.values(host.bot.readState().bots[key]!.group!.inputs!).find(
        (entry) => entry.source.messageId === "om_batch_wakeup",
      );
      expect(acceptedBatch?.admission).toBe("accepted");
      expect(acceptedBatch?.source.messages?.map((message) => message.text)).toEqual([
        "@Bot E2E_BOT_TOPIC_NEXT",
        "@Bot",
      ]);
    } finally {
      await cleanup?.dispose();
      platform.restore();
      await replay.stop();
    }
  });

  it("downloads admitted historical resources through the actual ReadTopicResource tool", async function () {
    this.timeout(180000);
    const replay = await startConversationModelProviderReplayServer(
      "conversation-session-bot-topic-worker",
    );
    const platform = installBotPlatformFixture();
    let cleanup: Awaited<ReturnType<typeof createBotWorkerIntegration>> | undefined;
    try {
      const host = (cleanup = await createBotWorkerIntegration(replay.baseUrl));
      platform.add("om_root", "Topic root");
      platform.add("om_archive", "file", "file");
      platform.add("om_request", "E2E_BOT_TOPIC_RESOURCE");
      await host.bot.service.handleInboundMessage({ botId: actor.botId, actor, text: "/enable" });
      const input: BotInboundMessage = {
        botId: actor.botId,
        text: "E2E_BOT_TOPIC_RESOURCE",
        actor: {
          ...actor,
          threadId: "omt_worker",
          rootMessageId: "om_root",
          providerMessageId: "om_request",
        },
      };
      await host.bot.service.handleInboundMessage(input);
      await browser.waitUntil(
        async () =>
          Object.values(host.bot.readState().bots[key]?.group?.deliveries ?? {}).some(
            (d) => d.text.includes("E2E_RESOURCE_DONE") && d.status === "sent",
          ),
        { timeout: 60000 },
      );
      expect(host.reverseResources).toHaveLength(1);
      const taskId = host.bot.readState().bots[key]!.activeTaskId!;
      // Node SQLite 只提供同步查询；只读隔离 CLI 持久工具结果并立即关闭。
      const database = new DatabaseSync(join(host.home, ".zcode/cli/db/db.sqlite"), {
        readOnly: true,
      });
      let resource: { fileName: string; path: string; bytes: number };
      try {
        const records = database
          .prepare("select data from part where session_id = ?")
          .all(taskId) as Array<{ data: string }>;
        const tool = records
          .map((row) => JSON.parse(row.data))
          .find((part) => part.type === "tool" && part.tool === "ReadTopicResource");
        expect(tool?.state.status).toBe("completed");
        // 会话工具设计 0.8：资源下载从 ReadSessionContext(topic, attachment) 拆成专用工具，结果只含路径与元数据。
        resource =
          typeof tool.state.output === "string" ? JSON.parse(tool.state.output) : tool.state.output;
        expect(resource).toMatchObject({ status: "success", messageId: "om_archive", index: 0 });
      } finally {
        database.close();
      }
      expect(resource.fileName).toBe("archive.txt");
      expect(resource.bytes).toBe(Buffer.byteLength("E2E_ARCHIVE_FILE_CONTENT"));
      expect(resource.path.startsWith(host.home)).toBe(true);
      expect(await readFile(resource.path, "utf8")).toBe("E2E_ARCHIVE_FILE_CONTENT");

      const downloads = platform.requests.filter((r) => r.url.includes("/resources/"));
      expect(downloads).toHaveLength(1);
      expect(downloads[0]!.url).toContain("/om_archive/resources/file_e2e");
      const request = host.reverseResources[0] as Parameters<
        NonNullable<typeof host.bot.service.readTopicResource>
      >[0];
      await expect(
        host.bot.service.readTopicResource!({ ...request, taskId: "other-task" }),
      ).rejects.toThrow();
      expect(platform.requests.filter((r) => r.url.includes("/resources/"))).toHaveLength(1);
    } finally {
      await cleanup?.dispose();
      platform.restore();
      await replay.stop();
    }
  });
});
