import type { BotProvider, ZCodeStreamEvent } from "@zcode/shared";
import {
  createBotsServiceHarness,
  createFeishuConfig,
  createRecordingFeishuFetch,
  readBotSyntheticFixture,
  type RecordedRequest,
} from "#e2e/bots/helpers/bots-service-harness";

describe("BOT-E2E-PS-01 private task output subscription", () => {
  const originalFetch = globalThis.fetch;
  let harness: ReturnType<typeof createBotsServiceHarness> | undefined;
  afterEach(async () => {
    await harness?.service.disposeAllAndWait();
    globalThis.fetch = originalFetch;
  });
  for (const provider of ["feishu", "telegram", "weixin"] satisfies BotProvider[]) {
    it(`keeps ${provider} subscribed across IM, desktop and mobile turns`, async () => {
      const fixture = await readBotSyntheticFixture("private-task-sync.json");
      expect(fixture.caseId).toBe("BOT-E2E-PS-01");
      const requests: RecordedRequest[] = [];
      const feishuFetch = createRecordingFeishuFetch(requests);
      globalThis.fetch = async (input, init) => {
        if (provider === "feishu") return feishuFetch(input, init);
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: String(init?.body ?? ""),
        });
        return new Response(JSON.stringify({ ok: true, ret: 0 }));
      };
      const config = createFeishuConfig();
      const bot = {
        ...config.bots[0]!,
        provider,
        replyMode:
          provider === "feishu" ? ("streaming_card" as const) : ("assistant_changes" as const),
      };
      config.bots = [bot];
      harness = createBotsServiceHarness({ config });
      await harness.service.handleInboundMessage({
        botId: bot.id,
        actor: {
          botId: bot.id,
          provider,
          providerUserId: bot.providerUserId!,
          chatType: "private",
          providerContextToken: "e2e-context",
        },
        text: `${fixture.promptMarker} run`,
      });
      // 微信首次入站只激活，随后才形成 task。
      if (harness.subscriptions.length === 0)
        await harness.service.handleInboundMessage({
          botId: bot.id,
          actor: {
            botId: bot.id,
            provider,
            providerUserId: bot.providerUserId!,
            chatType: "private",
            providerContextToken: "e2e-context",
          },
          text: `${fixture.promptMarker} run again`,
        });
      expect(harness.subscriptions).toHaveLength(1);
      // Bot 输入的命令信封 clientId 带 `bot:` 前缀（所有渠道，含没有回推目标的 Telegram）：CLI 据此
      // 不对 IM 用户声明桌面设计模式（Host 的 inputOrigin 对 Bot 也是 desktop）。
      await browser.waitUntil(async () => harness!.sendPromptCalls.length > 0, {
        timeout: 10_000,
        timeoutMsg: `${provider} 私聊输入没有发到 task service`,
      });
      for (const call of harness.sendPromptCalls) {
        expect((call as { clientId?: string }).clientId).toMatch(
          new RegExp(`^bot:${bot.id}:[^:]+:${bot.providerUserId}$`, "u"),
        );
      }
      expect(harness.subscriptions[0]!.params.deliveryKind).toBe("bot-channel-continuous");
      const emit = harness.subscriptions[0]!.listener;
      const run = async (id: string, inputOrigin: "desktop" | "mobile") => {
        const base = { taskId: "task-e2e-bot", traceId: id, inputId: id };
        await emit({
          ...base,
          type: "task_run_started",
          startedAt: Date.now(),
          inputOrigin,
        } as ZCodeStreamEvent);
        await emit({ ...base, type: "agent_message_chunk", content: id } as ZCodeStreamEvent);
        await emit({ ...base, type: "task_complete", stopReason: "end_turn" } as ZCodeStreamEvent);
      };
      await run("IM_REPLY", "desktop");
      await run("DESKTOP_REPLY", "desktop");
      await run("MOBILE_REPLY", "mobile");
      const creations = requests.filter(
        (request) =>
          request.method === "POST" &&
          /sendMessage|sendmessage|im\/v1\/messages\?/.test(request.url),
      );
      expect(creations).toHaveLength(3);
      expect(creations[1]!.body).toContain("DESKTOP_REPLY");
      expect(creations[1]!.body).not.toContain("IM_REPLY");
      expect(creations[2]!.body).toContain("MOBILE_REPLY");
      await harness.service.saveConfig({ ...config, bots: [{ ...bot, enabled: false }] });
      const count = requests.length;
      await run("LATE_REPLY", "desktop");
      expect(requests).toHaveLength(count);
    });
  }
});
