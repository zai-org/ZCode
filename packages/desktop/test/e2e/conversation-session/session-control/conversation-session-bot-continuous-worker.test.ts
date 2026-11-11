import { generateTraceId, type BotActor } from "@zcode/shared";
import { createBotWorkerIntegration } from "#e2e/helpers/bot-worker-integration";
import { installBotPlatformFixture } from "#e2e/helpers/bot-platform-fixture";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";

const groupActor: BotActor = {
  botId: "bot-worker",
  provider: "feishu",
  chatType: "group",
  chatId: "oc_worker",
  providerUserId: "ou_e2e_user",
};

describe("BOT-E2E-GR-02/PS-01 actual worker lifecycle", () => {
  it("promotes a group queue item after the first execution finishes normally", async function () {
    this.timeout(120000);
    const replay = await startConversationModelProviderReplayServer(
      "conversation-session-bot-continuous-worker",
    );
    const platform = installBotPlatformFixture();
    let cleanup: Awaited<ReturnType<typeof createBotWorkerIntegration>> | undefined;
    try {
      const host = (cleanup = await createBotWorkerIntegration(replay.baseUrl));
      await host.bot.service.handleInboundMessage({
        botId: "bot-worker",
        actor: groupActor,
        text: "/enable",
      });
      await host.bot.service.handleInboundMessage({
        botId: "bot-worker",
        actor: { ...groupActor, providerMessageId: "om_running" },
        text: "E2E_BOT_GROUP_RUNNING",
      });
      await browser.waitUntil(
        async () => host.observedTextEvents.some((text) => text.includes("E2E_GROUP_RUNNING")),
        { timeout: 30000 },
      );
      const queued = await host.bot.service.handleInboundMessage({
        botId: "bot-worker",
        actor: { ...groupActor, providerMessageId: "om_queued", providerUserId: "ou_member" },
        text: "E2E_BOT_GROUP_QUEUED",
      });
      expect(queued.map((reply) => reply.text).join("\n")).toMatch(/等待执行|Waiting to run/);
      const key = JSON.stringify(["bot-worker", "oc_worker"]);
      await browser.waitUntil(
        async () =>
          Object.values(host.bot.readState().bots[key]?.group?.deliveries ?? {}).some(
            (delivery) =>
              delivery.status === "sent" && delivery.text.includes("E2E_GROUP_QUEUED_DONE"),
          ),
        { timeout: 45000 },
      );
      const deliveries = Object.values(host.bot.readState().bots[key]!.group!.deliveries!);
      expect(
        deliveries.filter(
          (delivery) => delivery.text.includes("E2E_GROUP_FINISHED") && delivery.status === "sent",
        ),
      ).toHaveLength(1);
      expect(
        deliveries.filter(
          (delivery) =>
            delivery.text.includes("E2E_GROUP_QUEUED_DONE") &&
            delivery.replyToMessageId === "om_queued",
        ),
      ).toHaveLength(1);
    } finally {
      await cleanup?.dispose();
      platform.restore();
      await replay.stop();
    }
  });

  it("delivers an IM turn and a later desktop turn through the persistent private subscription", async function () {
    this.timeout(120000);
    const replay = await startConversationModelProviderReplayServer(
      "conversation-session-bot-continuous-worker",
    );
    const platform = installBotPlatformFixture();
    let cleanup: Awaited<ReturnType<typeof createBotWorkerIntegration>> | undefined;
    try {
      const host = (cleanup = await createBotWorkerIntegration(replay.baseUrl));
      const actor: BotActor = {
        ...groupActor,
        chatType: "private",
        providerMessageId: "om_private",
      };
      await host.bot.service.handleInboundMessage({
        botId: "bot-worker",
        actor,
        text: "E2E_BOT_PRIVATE_FIRST",
      });
      const posts = (marker: string) =>
        platform.requests.filter(
          (r) =>
            r.method === "POST" && r.url.includes("/im/v1/messages?") && r.body?.includes(marker),
        );
      await browser.waitUntil(async () => posts("E2E_PRIVATE_FIRST_DONE").length === 1, {
        timeout: 45000,
      });
      const taskId = host.bot.readState().bots["bot-worker"]!.activeTaskId!;
      await host.task.sendPrompt({
        taskId,
        content: "E2E_BOT_PRIVATE_NEXT",
        traceId: generateTraceId("private-followup"),
        modelSelection: host.modelSelection,
      });
      await browser.waitUntil(async () => posts("E2E_PRIVATE_NEXT_DONE").length === 1, {
        timeout: 45000,
      });
      expect(posts("E2E_PRIVATE_FIRST_DONE")).toHaveLength(1);
      expect(posts("E2E_PRIVATE_NEXT_DONE")[0]!.body).not.toContain("E2E_PRIVATE_FIRST_DONE");
      // 实际调用桌面 task service；没有把 inputOrigin=mobile 当作手机远控证明。
    } finally {
      await cleanup?.dispose();
      platform.restore();
      await replay.stop();
    }
  });
});
