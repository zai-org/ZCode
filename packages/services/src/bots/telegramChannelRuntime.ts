import type {
  BotConfig,
  BotProviderCallbackResult,
  BotsConfigFile,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { BotProviderAdapter } from "./providers/types.js";
import {
  fetchBotProvider,
  fetchBotProviderJson,
} from "./providers/providerRequest.js";
import {
  acquireTelegramPollingLock,
  assertBotCallbackSucceeded,
  BOT_RUNTIME_LOCK_RETRY_MS,
  createBotConnectionFingerprint,
  createLatestRuntimeRefreshQueue,
  getBotPollingRetryDelayMs,
  type BotRuntimeLogger,
  type BotRuntimeStatusSink,
  waitFor,
} from "./channelRuntime.js";

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: unknown[];
  description?: string;
}

// Telegram 服务端长轮询最多等待 25 秒；客户端额外预留传输时间，但必须覆盖响应体读取，
// 避免半开连接永久占用 polling lock，导致配置刷新无法接管 runtime。
const TELEGRAM_LONG_POLL_REQUEST_TIMEOUT_MS = 40_000;

interface TelegramChannelRuntimeDeps {
  runBackgroundTasks?: boolean;
  credentialService: ICredentialService;
  telegramProvider: BotProviderAdapter | null;
  logger: BotRuntimeLogger;
  statusSink: BotRuntimeStatusSink;
  ensureBotStorageMigrated(): Promise<void>;
  readConfig(): Promise<BotsConfigFile>;
  readTelegramOffset(botId: string): Promise<number | undefined>;
  writeTelegramOffset(botId: string, offset: number): Promise<void>;
  processProviderCallback(
    provider: "telegram",
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
  acquirePollingLock?: typeof acquireTelegramPollingLock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createTelegramChannelRuntime(deps: TelegramChannelRuntimeDeps) {
  interface RuntimeEntry {
    controller: AbortController;
    fingerprint: string;
    done: Promise<void>;
  }

  const runtimes = new Map<string, RuntimeEntry>();
  const refreshQueue = createLatestRuntimeRefreshQueue();

  async function getConnectionFingerprint(bot: BotConfig): Promise<string> {
    const credential = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    return createBotConnectionFingerprint([
      bot.provider,
      bot.credentialRef ?? "",
      credential ?? "",
    ]);
  }

  async function syncCommands(bot: BotConfig): Promise<void> {
    if (deps.runBackgroundTasks === false) {
      // 修复原因：desktop-attached 远端不拥有 Telegram runtime；
      // 删除或禁用 bot 时也不能为了清命令访问第三方 API。
      return;
    }
    await deps.telegramProvider?.syncCommands?.(bot).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `sync Telegram commands failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function pollBot(bot: BotConfig, signal: AbortSignal): Promise<void> {
    const token = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    if (!token?.trim()) {
      deps.statusSink.setRuntimeStatus({
        botId: bot.id,
        provider: "telegram",
        status: "error",
        messageId: "bots.runtime.telegramTokenMissing",
        message: "Telegram bot token is missing.",
      });
      return;
    }

    let consecutiveFailures = 0;
    while (!signal.aborted) {
      let lock: Awaited<ReturnType<typeof acquireTelegramPollingLock>>;
      try {
        lock = await (deps.acquirePollingLock ?? acquireTelegramPollingLock)(
          token,
          bot.id,
        );
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        // Bugfix: 锁目录/rename 的瞬时 I/O 异常发生在轮询 try 之外时会终止后台 Promise。
        // 锁也是 runtime 生命周期的一部分，必须可观测、可取消地退避重试。
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "error",
          message: `Telegram polling lock failed: ${error instanceof Error ? error.message : String(error)}`,
          offset: await deps.readTelegramOffset(bot.id),
        });
        await waitFor(5_000, signal);
        continue;
      }
      if (!lock) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "idle",
          messageId: "bots.runtime.telegramLongPollingHandledElsewhere",
          message: "Telegram long polling is handled by another ZCode window.",
          offset: await deps.readTelegramOffset(bot.id),
        });
        await waitFor(BOT_RUNTIME_LOCK_RETRY_MS, signal);
        continue;
      }
      try {
        try {
          await fetchBotProvider(
            `https://api.telegram.org/bot${token}/deleteWebhook`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ drop_pending_updates: false }),
              signal,
            },
          );
        } catch {
          if (signal.aborted) {
            return;
          }
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "polling",
          // 修复：运行状态会直接展示到 UI。补充 messageId，让前端按当前语言渲染，message 仅作为旧版本兜底。
          message: "Telegram long polling is running.",
          messageId: "bots.runtime.telegramLongPollingRunning",
          offset: await deps.readTelegramOffset(bot.id),
        });

        while (!signal.aborted) {
          const offset = await deps.readTelegramOffset(bot.id);
          const response =
            await fetchBotProviderJson<TelegramGetUpdatesResponse>(
              `https://api.telegram.org/bot${token}/getUpdates`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  timeout: 25,
                  ...(offset !== undefined ? { offset } : {}),
                  allowed_updates: ["message", "callback_query"],
                }),
                signal,
              },
              TELEGRAM_LONG_POLL_REQUEST_TIMEOUT_MS,
            );
          if (!response.ok) {
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: "telegram",
              status: "error",
              message:
                response.status === 409
                  ? "Telegram token is already used by another polling client."
                  : `Telegram getUpdates failed: HTTP ${response.status}`,
              offset,
            });
            await waitFor(response.status === 409 ? 10_000 : 5_000, signal);
            continue;
          }
          const payload = response.payload;
          if (payload?.ok !== true || !Array.isArray(payload.result)) {
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: "telegram",
              status: "error",
              message:
                payload?.description ??
                "Telegram getUpdates returned an invalid response.",
              offset,
            });
            await waitFor(5_000, signal);
            continue;
          }
          if (signal.aborted) {
            return;
          }
          for (const update of payload.result) {
            if (signal.aborted) {
              return;
            }
            const updateId =
              isRecord(update) && typeof update.update_id === "number"
                ? update.update_id
                : null;
            const callbackResult = await deps.processProviderCallback("telegram", {
              botId: bot.id,
              update,
            });
            assertBotCallbackSucceeded("Telegram", callbackResult);
            if (updateId !== null) {
              // Bugfix: offset 是 Telegram 外部队列的消费确认点。业务回调失败前推进会让
              // 用户消息、权限和 elicitation 响应永久跳过；成功后逐条提交才能安全重试。
              await deps.writeTelegramOffset(bot.id, updateId + 1);
            }
          }
          consecutiveFailures = 0;
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "telegram",
            status: "polling",
            // 修复：运行状态会直接展示到 UI。补充 messageId，让前端按当前语言渲染，message 仅作为旧版本兜底。
            message: "Telegram long polling is running.",
            messageId: "bots.runtime.telegramLongPollingRunning",
            offset: await deps.readTelegramOffset(bot.id),
          });
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        consecutiveFailures += 1;
        const retryDelayMs = getBotPollingRetryDelayMs(consecutiveFailures);
        // Bugfix：回调或 offset 提交失败原来连错误都丢弃，并每 5 秒无限重试同一 update；
        // 与微信同一缺陷。失败必须写日志，并按退避降低重试频率。
        deps.logger.warn(
          undefined,
          `telegram polling failed bot=${bot.id} failures=${consecutiveFailures} retryInMs=${retryDelayMs}: ${error instanceof Error ? error.message : String(error)}`,
        );
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "error",
          messageId: "bots.runtime.telegramPollingFailedRetrying",
          message: "Telegram polling failed; retrying.",
          offset: await deps.readTelegramOffset(bot.id),
        });
        await waitFor(retryDelayMs, signal);
      } finally {
        await lock.release().catch((error: unknown) => {
          deps.logger.debug(
            undefined,
            `release Telegram polling lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }

  async function stopPolling(botId: string): Promise<void> {
    const runtime = runtimes.get(botId);
    runtime?.controller.abort();
    if (runtime) {
      await runtime.done;
      if (runtimes.get(botId) === runtime) {
        runtimes.delete(botId);
      }
    }
    const previous = deps.statusSink.getRuntimeStatus(botId);
    if (previous) {
      deps.statusSink.setRuntimeStatus({
        ...previous,
        status: "idle",
        messageId: "bots.runtime.telegramLongPollingStopped",
        message: "Telegram long polling is stopped.",
      });
    }
  }

  function startPolling(bot: BotConfig, fingerprint: string): void {
    if (runtimes.has(bot.id)) {
      return;
    }
    const controller = new AbortController();
    deps.statusSink.setRuntimeStatus({
      botId: bot.id,
      provider: "telegram",
      status: "polling",
      messageId: "bots.runtime.telegramLongPollingStarting",
      message: "Telegram long polling is starting.",
    });
    const runtime: RuntimeEntry = {
      controller,
      fingerprint,
      done: Promise.resolve(),
    };
    runtime.done = pollBot(bot, controller.signal).catch((error: unknown) => {
      // Bugfix: 后台 runtime 的最终 Promise 必须显式收口，避免异常升级为 host 未处理 rejection。
      deps.logger.warn(
        undefined,
        `Telegram polling stopped unexpectedly bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }).finally(() => {
      if (runtimes.get(bot.id) === runtime) {
        runtimes.delete(bot.id);
        const previous = deps.statusSink.getRuntimeStatus(bot.id);
        if (previous?.status === "polling") {
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "telegram",
            status: "idle",
            messageId: "bots.runtime.telegramLongPollingStopped",
            message: "Telegram long polling is stopped.",
            offset: previous.offset,
          });
        }
      }
    });
    runtimes.set(bot.id, runtime);
  }

  async function reconcile(
    config: BotsConfigFile | undefined,
    isLatest: () => boolean,
  ): Promise<void> {
    // Bugfix: polling 游标和微信 buf 会写入 bot-state.v3.json。
    // 启动轮询前必须先完成旧 state 迁移，否则迁移写回可能覆盖刚更新的第三方游标。
    await deps.ensureBotStorageMigrated();
    const currentConfig = config ?? (await deps.readConfig());
    if (!isLatest()) {
      return;
    }
    const activeTelegramIds = new Set(
      currentConfig.bots
        .filter(
          (bot) =>
            bot.provider === "telegram" && bot.enabled && bot.credentialRef,
        )
        .map((bot) => bot.id),
    );
    for (const botId of runtimes.keys()) {
      if (!activeTelegramIds.has(botId)) {
        await stopPolling(botId);
        if (!isLatest()) {
          return;
        }
      }
    }
    for (const bot of currentConfig.bots) {
      if (bot.provider === "telegram" && bot.enabled && bot.credentialRef) {
        await syncCommands(bot);
        if (!isLatest()) {
          return;
        }
        const fingerprint = await getConnectionFingerprint(bot);
        if (!isLatest()) {
          return;
        }
        const runtime = runtimes.get(bot.id);
        if (runtime && runtime.fingerprint !== fingerprint) {
          // Bugfix: Bot id 不变不代表连接身份不变。必须等旧 token 的轮询和锁完全退出，
          // 再启动新凭据，避免配置已更新但后台仍消费旧账号或两个实例短暂并行。
          await stopPolling(bot.id);
          if (!isLatest()) {
            return;
          }
        }
        startPolling(bot, fingerprint);
      } else if (bot.provider === "telegram" && !bot.enabled) {
        await syncCommands(bot);
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "disabled",
          messageId: "bots.runtime.botDisabled",
          message: "Bot is disabled.",
        });
      }
    }
  }

  function refresh(config?: BotsConfigFile): Promise<void> {
    return refreshQueue.enqueue((isLatest) => reconcile(config, isLatest));
  }

  function scheduleRefresh(config?: BotsConfigFile): void {
    if (deps.runBackgroundTasks === false) {
      // 修复原因：配置变更后的轮询刷新也是 bot runtime 后台任务；
      // attached remote 不能绕过构造期保护启动 Telegram polling。
      return;
    }
    void refresh(config).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `refresh Telegram polling failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function dispose(): Promise<void> {
    refreshQueue.invalidate();
    const activeRuntimes = [...runtimes.values()];
    for (const runtime of activeRuntimes) {
      runtime.controller.abort();
    }
    // Bugfix：服务销毁返回前必须等长轮询退出并释放 token 锁，避免新 host 被迫等待下一轮重试。
    await Promise.allSettled(activeRuntimes.map((runtime) => runtime.done));
    for (const [botId, runtime] of runtimes) {
      if (activeRuntimes.includes(runtime)) {
        runtimes.delete(botId);
      }
    }
  }

  return {
    dispose,
    refresh,
    scheduleRefresh,
    stopPolling,
    syncCommands,
  };
}
