import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isBotInputClientId, type BotInboundMessage } from "@zcode/shared";
import { createFeishuConfig } from "#e2e/bots/helpers/bots-service-harness";
import { clearAppData } from "#e2e/helpers/desktop-app";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import { runSSHCommand } from "#e2e/helpers/ssh-remote-p0";
import { waitForV4ConversationState } from "#e2e/helpers/v4-conversation";

// Bot 私聊输入的命令信封 clientId 是 `bot:<botId>:<chatId>:<userId>`（formatBotInputClientId）。私聊过去用
// host-services-*，远端 workspace 下要确认 Source Server 侧不会按 terminal-client 的 clientId 一致性检查
// （zcodeAgentConnectionScope fault.command.clientMismatch）拒掉它：Telegram 私聊经真实 Host Bot 服务投到
// 远端任务，远端 CLI 必须真的跑这一轮（上游回放收到请求），且远端会话账本记下的 clientId 是 bot 形状。

const CASE_MARKER = "E2E_R3_BOT_PRIVATE";
const SEND_MARKER = `${CASE_MARKER}_TELEGRAM`;
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-bot-private-client-id",
);

describe(`${CASE_MARKER}: Telegram 私聊输入投到远端 workspace 不被 clientId 检查拒绝`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "bot-private.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Telegram 私聊经 Host Bot 服务投到远端任务，远端 CLI 执行该轮", async function () {
    this.timeout(25 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, {
      apiType: "anthropic-messages",
      tunnelUsername: "tunnel",
    });
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: 首轮没有收口`,
      90_000,
    );

    // 只经真实 Host Bot 服务输入；不配凭据，不向 Telegram 发网络请求。
    const botId = "telegram-r3-e2e";
    const config = createFeishuConfig("feishu", botId);
    const bot = config.bots[0]!;
    delete bot.credentialRef;
    delete (bot as { feishuAppId?: string }).feishuAppId;
    config.bots = [{ ...bot, provider: "telegram", replyMode: "assistant_changes" }];
    const root = join(resolveE2EStorageRoot(), "v2");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "bot-config.v3.json"), JSON.stringify(config));
    await writeFile(
      join(root, "bot-state.v3.json"),
      JSON.stringify({
        version: 3,
        bots: {
          [botId]: {
            botId,
            workspacePath: taskA.workspacePath,
            workspaceIdentity: taskA.identity,
            workspaceId: taskA.identity,
            mode: "task",
            activeTaskId: taskA.taskId,
            updatedAt: Date.now(),
          },
        },
      }),
    );

    const requestStart = await getUpstreamRequestRecordCount();
    const message: BotInboundMessage = {
      botId,
      text: `${SEND_MARKER}: 只回复 R3_BOT_PRIVATE_REPLY`,
      actor: {
        botId,
        provider: "telegram",
        chatType: "private",
        chatId: "tg-chat-e2e",
        providerUserId: bot.providerUserId!,
        providerMessageId: "tg-message-e2e",
      },
    };
    // __testActions 走当前激活 workspace 的服务；Bot 由本机 Host 承载（远端项目经 remoteWorkspaceService
    // 拿远端 taskService），所以先切回本地 tab，让输入进本机 Host 的 Bot 服务。
    const switched = await browser.execute(() => {
      const store = (
        window as Window & {
          __zcodeTabStoreE2E?: {
            getState?: () => {
              tabs?: Array<{ id: string; workspaceIdentity?: string }>;
              activateTab?: (tabId: string) => void;
            };
          };
        }
      ).__zcodeTabStoreE2E;
      const state = store?.getState?.();
      const local = state?.tabs?.find((tab) => !tab.workspaceIdentity);
      if (!local || !state?.activateTab) return false;
      state.activateTab(local.id);
      return true;
    });
    facts.switchedToLocalTab = switched;
    expect(switched).toBe(true);
    await browser.pause(1_500);
    const reply = await browser.execute(async (input) => {
      return (
        window as unknown as {
          __testActions: { sendBotMessage(input: BotInboundMessage): Promise<unknown> };
        }
      ).__testActions.sendBotMessage(input);
    }, message);
    facts.reply = reply;

    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [SEND_MARKER] },
      `${CASE_MARKER}: Telegram 私聊输入没有在远端执行（可能被 clientId 检查拒绝）`,
      120_000,
      { afterIndex: requestStart - 1 },
    );
    facts.remoteTurnReachedUpstream = true;

    // 远端 CLI 输入账本里这一轮的 clientId 是 bot 形状：证明命令以 bot: clientId 进入远端并被接纳。
    const ledger = await runSSHCommand(
      prepared.config,
      `grep -rao '"clientId":"bot:[^"]*"' "$HOME/.zcode/cli/db" 2>/dev/null | head -n 5`,
    );
    const clientIds = [...ledger.stdout.matchAll(/"clientId":"([^"]+)"/gu)].map((m) => m[1]!);
    facts.remoteClientIds = clientIds;
    expect(clientIds.some((id) => isBotInputClientId(id) && id.includes(botId))).toBe(true);
  });
});
