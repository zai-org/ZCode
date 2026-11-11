import { setRendererViewport, clearRendererViewport } from "#e2e/helpers/renderer-viewport";
import { skipOccupationOnboardingIfPresent } from "#e2e/helpers/occupation-onboarding";
import { restartWithSeededOpenAIProviders } from "#e2e/helpers/custom-openai-provider";
import {
  selectUpstreamProviderModelById,
  waitForUpstreamModelSelected,
} from "#e2e/helpers/upstream-provider";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { BotInboundMessage } from "@zcode/shared";
import { createFeishuConfig } from "#e2e/bots/helpers/bots-service-harness";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { getTaskStoreSnapshot } from "#e2e/helpers/conversation-session-store";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
  waitForV4Pane,
  getV4PaneSnapshot,
  waitForV4QueueCount,
  getV4QueueItems,
  clickV4QueueItemDelete,
  clickV4Stop,
  selectV4TaskById,
} from "#e2e/helpers/v4-conversation";

describe("BOT-E2E-GR-02/04 real Host CLI group queue", () => {
  let replay: Awaited<ReturnType<typeof startConversationModelProviderReplayServer>>;
  before(async () => {
    // 使用本用例的可控慢流 fixture，manual-review 默认 capture 不能冒充确定性回放。
    replay = await startConversationModelProviderReplayServer("feishu-group-runtime");
  });
  after(async () => {
    if ((await getV4PaneSnapshot()).canStop) await clickV4Stop();
    await clearRendererViewport();
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await replay?.stop();
  });
  it("projects trusted group input into Desktop's real queue and cancels without stopping", async () => {
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E({ skipProvider: true });
    const [provider] = await restartWithSeededOpenAIProviders([
      {
        modelId: "deepseek-v4-flash",
        providerId: "e2e-group-runtime",
        providerName: "Group Runtime E2E",
      },
    ]);
    if (!provider) throw new Error("Group runtime replay provider missing");
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectUpstreamProviderModelById("deepseek-v4-flash", {
      includePlainModelFallback: false,
      providerId: provider.id,
      providerName: provider.name,
    });
    await waitForUpstreamModelSelected("deepseek-v4-flash", {
      includePlainModelFallback: false,
      providerId: provider.id,
    });
    await sendV4Prompt("E2E_GROUP_RUNTIME_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && !!s.sessionId && s.sessionId !== "draft",
      "initial turn is not running",
      45000,
    );
    const pane = await getV4PaneSnapshot();
    const turnId = await browser.execute(() =>
      document.querySelector("[data-turn-id]")?.getAttribute("data-turn-id"),
    );
    expect(turnId).toBeTruthy();
    const task = await getTaskStoreSnapshot(pane.sessionId!);
    const workspacePath = task.workspaceKey!;
    expect(workspacePath).toBeTruthy();
    // V4 不再写旧 renderer activeInputId；从真实 CLI 输入账本按持久消息关联读取命令身份。
    const inputDatabase = new DatabaseSync(
      join(resolveE2EStorageRoot(), "cli", "db", "db.sqlite"),
      { readOnly: true },
    );
    let sourceCommandId: string;
    try {
      const record = inputDatabase
        .prepare(
          "select id, payload from session_input where session_id = ? and promoted_message_id = ?",
        )
        .get(pane.sessionId!, turnId!) as { id: string; payload: string } | undefined;
      expect(record).toBeTruthy();
      sourceCommandId = JSON.parse(record!.payload).intent?.sourceCommandId ?? record!.id;
    } finally {
      inputDatabase.close();
    }
    expect(sourceCommandId).toBeTruthy();
    const botId = "feishu-runtime-e2e";
    const chatId = "oc_runtime_e2e";
    const root = join(resolveE2EStorageRoot(), "v2");
    await mkdir(root, { recursive: true });
    const config = createFeishuConfig("feishu", botId);
    // 本用例仅通过真实 Host 服务输入，不向飞书发送网络请求。
    delete config.bots[0]!.credentialRef;
    await writeFile(join(root, "bot-config.v3.json"), JSON.stringify(config));
    await writeFile(
      join(root, "bot-state.v3.json"),
      JSON.stringify({
        version: 3,
        bots: {
          [JSON.stringify([botId, chatId])]: {
            botId,
            workspacePath,
            workspaceId: workspacePath,
            mode: "task",
            activeTaskId: pane.sessionId,
            updatedAt: Date.now(),
            group: {
              chatId,
              name: "E2E 协作群",
              ownerId: "ou_e2e_user",
              enabled: true,
              authorizationId: "e2e-authorization",
              taskIds: [pane.sessionId],
              currentOptions: {},
              deliveries: {
                "e2e-unknown": {
                  id: "e2e-unknown",
                  sourceCommandId,
                  taskId: pane.sessionId,
                  text: "E2E_SAVED_GROUP_RESULT",
                  status: "unknown",
                  updatedAt: Date.now(),
                },
              },
            },
          },
        },
      }),
    );
    const input: BotInboundMessage = {
      botId,
      text: "E2E_GROUP_RUNTIME_QUEUE 测试需求",
      attachments: [
        {
          id: "group-file",
          kind: "file",
          filename: "group-e2e.txt",
          mimeType: "text/plain",
          dataBase64: "Z3JvdXAtZmlsZQ==",
          sizeBytes: 10,
        },
      ],
      actor: {
        botId,
        provider: "feishu",
        chatType: "group",
        chatId,
        providerUserId: "ou_member",
        displayName: "E2E 群成员",
        providerMessageId: "om_runtime_e2e",
      },
    };
    const reply = await browser.execute(async (message) => {
      const actions = (
        window as unknown as {
          __testActions: {
            sendBotMessage(input: BotInboundMessage): Promise<Array<{ text: string }>>;
          };
        }
      ).__testActions;
      return actions.sendBotMessage(message);
    }, input);
    expect(reply.map((r) => r.text).join("\n")).toMatch(/等待执行|Waiting to run/);
    await waitForV4QueueCount(1, 30000);
    const items = await getV4QueueItems();
    expect(items[0]?.text).toContain("E2E_GROUP_RUNTIME_QUEUE");
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            document
              .querySelector('[data-testid="v4-queue"]')
              ?.textContent?.includes("group-e2e.txt") === true,
        ),
      { timeout: 15000 },
    );
    await browser.waitUntil(
      async () => browser.execute(() => document.body.innerText.includes("E2E 群成员")),
      { timeout: 15000 },
    );
    // 姓名保留在原队列标签中；点击查看稳定身份，不展开结果或新增提示面板。
    const memberLabel = await $('[data-testid="v4-queue"] [data-bot-group-source]');
    expect(await memberLabel.getText()).toContain("E2E 群成员");
    await memberLabel.click();
    const memberDetails = await $("[data-bot-group-member-details]");
    await memberDetails.waitForDisplayed({ timeout: 5000 });
    expect(await memberDetails.getText()).toContain("ou_member");
    await browser.keys("Escape");
    // 恢复入口属于已完成回复，队列与输入框之间不能再插入投递面板。
    expect(await browser.execute(() => !!document.querySelector("[data-bot-group-task]"))).toBe(
      false,
    );
    expect(await clickV4QueueItemDelete(items[0]!.queueItemId)).toBe(true);
    await waitForV4QueueCount(0, 30000);
    expect((await getV4PaneSnapshot()).canStop).toBe(true);
    await clickV4Stop();
    await waitForV4Pane((state) => !state.canStop, "first task did not stop", 30000);
    const deliveryAction = await $("[data-bot-group-delivery]");
    await deliveryAction.waitForExist({ timeout: 15000 });
    expect(
      await browser.execute(() => {
        const action = document.querySelector("[data-bot-group-delivery]");
        return action?.closest("[data-turn-id]")?.getAttribute("data-turn-id");
      }),
    ).toBe(turnId);
    expect(
      await browser.execute(() => document.body.innerText.includes("E2E_SAVED_GROUP_RESULT")),
    ).toBe(false);
    await setRendererViewport(430, 900);
    await deliveryAction.click();
    expect(
      await browser.execute(() => {
        const actions = document.querySelector("[data-bot-group-delivery-actions]");
        const bounds = actions?.getBoundingClientRect();
        return !!bounds && bounds.left >= 0 && bounds.right <= window.innerWidth;
      }),
    ).toBe(true);
    const received = await $("[data-bot-group-delivery-actions] button");
    await received.waitForDisplayed({ timeout: 15000 });
    await received.click();
    await browser.waitUntil(
      async () => browser.execute(() => !document.querySelector("[data-bot-group-delivery]")),
      { timeout: 15000 },
    );
    await clearRendererViewport();
    const sendGroup = async (text: string, senderId: string) =>
      browser.execute(
        async (message) => {
          return (
            window as unknown as {
              __testActions: { sendBotMessage(input: BotInboundMessage): Promise<unknown> };
            }
          ).__testActions.sendBotMessage(message);
        },
        {
          botId,
          text,
          actor: { ...input.actor, providerUserId: senderId, providerMessageId: `om_${text}` },
        },
      );
    const readPermissions = (sessionId?: string) => {
      // Node SQLite 只提供同步查询；只读隔离 E2E 数据库的一行并立即关闭。
      const database = new DatabaseSync(join(resolveE2EStorageRoot(), "cli", "db", "db.sqlite"), {
        readOnly: true,
      });
      try {
        if (sessionId) {
          const row = database
            .prepare("select permission from session where id = ?")
            .get(sessionId) as { permission: string };
          return JSON.parse(row.permission);
        }
        return database
          .prepare(
            "select scope_id, value from local_setting where namespace = 'permission' and key = 'mode' order by scope_id",
          )
          .all();
      } finally {
        database.close();
      }
    };
    const projectModes = readPermissions();
    // 复现停止后 Bot 遗留审批缓存：CLI 已空闲，旧卡片不能继续阻止 /new。
    const stoppedState = JSON.parse(await readFile(join(root, "bot-state.v3.json"), "utf8"));
    stoppedState.bots[JSON.stringify([botId, chatId])].pendingPermissionOptions = [
      {
        requestId: "stale-after-stop",
        optionId: "allow_once",
        command: "approve",
        label: "Allow",
        response: { decision: "allow", reason: "Approved once" },
      },
    ];
    await writeFile(join(root, "bot-state.v3.json"), JSON.stringify(stoppedState));
    await sendGroup("/new", "ou_e2e_user");
    const draftState = JSON.parse(await readFile(join(root, "bot-state.v3.json"), "utf8"));
    expect(draftState.bots[JSON.stringify([botId, chatId])].activeTaskId).toBeNull();
    expect(
      draftState.bots[JSON.stringify([botId, chatId])].pendingPermissionOptions ?? [],
    ).toHaveLength(0);
    const modeReply = await sendGroup("/mode yolo", "ou_e2e_user");
    console.log(
      "E2E_GROUP_MODE_RESULT",
      JSON.stringify({
        reply: modeReply,
        draft: JSON.parse(await readFile(join(root, "bot-state.v3.json"), "utf8")).bots[
          JSON.stringify([botId, chatId])
        ].draftOptions,
      }),
    );
    await sendGroup("E2E_GROUP_RUNTIME_SLOW new group task", "ou_member");
    const persisted = JSON.parse(await readFile(join(root, "bot-state.v3.json"), "utf8"));
    const createdId = persisted.bots[JSON.stringify([botId, chatId])].activeTaskId as string;
    expect(createdId).toBeTruthy();
    expect(createdId).not.toBe(pane.sessionId);
    expect(readPermissions(createdId)).toMatchObject({ scope: "session", mode: "yolo" });
    expect(readPermissions()).toEqual(projectModes);
    await selectV4TaskById(createdId);
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    const senderGap = await browser.execute(() => {
      const bubble = document.querySelector("[data-v4-user-input-bubble]");
      const label = bubble?.parentElement?.querySelector("[data-bot-group-source]");
      if (!bubble || !label) return null;
      return bubble.getBoundingClientRect().top - label.getBoundingClientRect().bottom;
    });
    expect(senderGap).not.toBeNull();
    expect(senderGap!).toBeGreaterThanOrEqual(8);
    expect(senderGap!).toBeLessThanOrEqual(12);
    await clickV4Stop();
    await waitForV4Pane((state) => !state.canStop, "group reply did not stop", 30000);
    const failedAction = await $("[data-bot-group-delivery]");
    await failedAction.waitForExist({ timeout: 15000 });
    const completedGroup = JSON.parse(await readFile(join(root, "bot-state.v3.json"), "utf8"));
    const stoppedInput = Object.values(
      completedGroup.bots[JSON.stringify([botId, chatId])].group.inputs,
    ).find((value) => (value as { taskId: string }).taskId === createdId) as {
      progress?: { status: string };
    };
    expect(stoppedInput.progress?.status).toBe("stopped");
    const deliveries = Object.values(
      completedGroup.bots[JSON.stringify([botId, chatId])].group.deliveries,
    ) as Array<{ taskId: string; text: string; replyToMessageId?: string }>;
    const stoppedReply = deliveries.find((delivery) => delivery.taskId === createdId)!;
    expect(stoppedReply.text).toBe("Task stopped.");
    expect(stoppedReply.replyToMessageId).toBe("om_E2E_GROUP_RUNTIME_SLOW new group task");
    await failedAction.click();
    await $("[data-bot-group-delivery-actions] button").waitForDisplayed({ timeout: 15000 });
  });
});
