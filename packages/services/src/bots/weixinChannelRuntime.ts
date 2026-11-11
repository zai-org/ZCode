import type {
  BotConfig,
  BotProviderCallbackResult,
  BotsConfigFile,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { getWeixinUpdates } from "./providers/weixinProvider.js";
import {
  acquireWeixinPollingLock,
  assertBotCallbackSucceeded,
  BOT_RUNTIME_LOCK_RETRY_MS,
  createBotConnectionFingerprint,
  createLatestRuntimeRefreshQueue,
  getBotPollingRetryDelayMs,
  type BotRuntimeLogger,
  type BotRuntimeStatusSink,
  waitFor,
} from "./channelRuntime.js";

interface WeixinChannelRuntimeDeps {
  runBackgroundTasks?: boolean;
  credentialService: ICredentialService;
  logger: BotRuntimeLogger;
  statusSink: BotRuntimeStatusSink;
  ensureBotStorageMigrated(): Promise<void>;
  readConfig(): Promise<BotsConfigFile>;
  readWeixinGetUpdatesBuf(botId: string): Promise<string | undefined>;
  writeWeixinGetUpdatesBuf(botId: string, buf: string): Promise<void>;
  processProviderCallback(
    provider: "weixin",
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
  getUpdates?: typeof getWeixinUpdates;
  acquirePollingLock?: typeof acquireWeixinPollingLock;
}

export function createWeixinChannelRuntime(deps: WeixinChannelRuntimeDeps) {
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

  async function pollBot(bot: BotConfig, signal: AbortSignal): Promise<void> {
    const token = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    if (!token?.trim()) {
      deps.statusSink.setRuntimeStatus({
        botId: bot.id,
        provider: "weixin",
        status: "error",
        message: "Weixin bot token is missing.",
      });
      return;
    }

    let consecutiveFailures = 0;
    while (!signal.aborted) {
      let lock: Awaited<ReturnType<typeof acquireWeixinPollingLock>>;
      try {
        lock = await (deps.acquirePollingLock ?? acquireWeixinPollingLock)(
          token,
          bot.id,
        );
      } catch (error) {
        if (signal.aborted) return;
        // Bugfix：每个窗口都有独立 host。微信锁 I/O 失败必须退避重试，不能让后台 Promise 退出。
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "error",
          message: `Weixin polling lock failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        await waitFor(5_000, signal);
        continue;
      }
      if (!lock) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "idle",
          message: "Weixin long polling is handled by another ZCode window.",
        });
        await waitFor(BOT_RUNTIME_LOCK_RETRY_MS, signal);
        continue;
      }
      try {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "polling",
          // 修复：运行状态会直接展示到 UI。补充 messageId，让前端按当前语言渲染，message 仅作为旧版本兜底。
          message: "Weixin long polling is running.",
          messageId: "bots.runtime.weixinLongPollingRunning",
        });
        while (!signal.aborted) {
          const buf = await deps.readWeixinGetUpdatesBuf(bot.id);
          const result = await (deps.getUpdates ?? getWeixinUpdates)({
            bot,
            deps: { loadCredential: (key) => deps.credentialService.load(key) },
            buf,
            signal,
          });
          if (signal.aborted) {
            return;
          }
          if ((result.rawMessageCount ?? 0) > 0 || result.messages.length > 0) {
            const attachmentCount = result.messages.reduce(
              (count, message) => count + (message.attachments?.length ?? 0),
              0,
            );
            // Bugfix 调试：微信附件可能没有文本，记录原始/解析数量来定位是否在 provider 层被过滤。
            deps.logger.debug(
              undefined,
              `weixin polling received bot=${bot.id} raw=${result.rawMessageCount ?? 0} parsed=${result.messages.length} attachments=${attachmentCount}`,
            );
            if (result.messages.length === 0) {
              // Bugfix 调试：只记录字段形状，不记录正文，定位微信图片/附件为何被过滤。
              deps.logger.debug(
                undefined,
                `weixin polling diagnostics bot=${bot.id} ${(result.rawMessageDiagnostics ?? []).join(" | ")}`,
              );
            }
          }
          for (const inbound of result.messages) {
            if (signal.aborted) {
              return;
            }
            const callbackResult = await deps.processProviderCallback("weixin", {
              botId: bot.id,
              messages: [
                {
                  id: inbound.actor.providerMessageId,
                  text: inbound.text,
                  from: inbound.actor.providerUserId,
                  chatId: inbound.actor.chatId,
                  displayName: inbound.actor.displayName,
                  context_token: inbound.actor.providerContextToken,
                  // Bugfix: 微信轮询已经解析出的附件在重新包装给 callback 管线时不能丢。
                  // 否则纯图片消息会因为 text 为空、attachments 被吞而静默无响应。
                  attachments: inbound.attachments,
                },
              ],
              ...(result.buf ? { buf: result.buf } : {}),
            });
            assertBotCallbackSucceeded("Weixin", callbackResult);
          }
          if (result.buf) {
            // Bugfix: 微信 get_updates_buf 代表服务端游标，必须等本批消息全部进入业务处理后再持久化。
            // 之前先写游标再处理回复，进程在中途失败会跳过未完成消息，导致 AskUserQuestion 回复顺序错乱或丢失。
            await deps.writeWeixinGetUpdatesBuf(bot.id, result.buf);
          }
          consecutiveFailures = 0;
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "weixin",
            status: "polling",
            // 修复：运行状态会直接展示到 UI。补充 messageId，让前端按当前语言渲染，message 仅作为旧版本兜底。
            message: "Weixin long polling is running.",
            messageId: "bots.runtime.weixinLongPollingRunning",
          });
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        consecutiveFailures += 1;
        const retryDelayMs = getBotPollingRetryDelayMs(consecutiveFailures);
        // Bugfix：游标提交失败原来只改运行状态、不写日志，并每 5 秒用旧游标无限重拉；
        // 线上同一条消息被重投约 23 小时，日志里看不到原因。失败必须可见，并按退避降低重拉频率。
        deps.logger.warn(
          undefined,
          `weixin polling failed bot=${bot.id} failures=${consecutiveFailures} retryInMs=${retryDelayMs}: ${message}`,
        );
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "error",
          message: `Weixin polling failed: ${message}`,
        });
        await waitFor(retryDelayMs, signal);
      } finally {
        // Bugfix：微信 buf 是第三方队列确认点；只有持锁 owner 能消费和写入，退出时必须释放给其他 host 接管。
        await lock.release().catch((error: unknown) => {
          deps.logger.debug(
            undefined,
            `release Weixin polling lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
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
        messageId: "bots.runtime.weixinLongPollingStopped",
        message: "Weixin long polling is stopped.",
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
      provider: "weixin",
      status: "polling",
      messageId: "bots.runtime.weixinLongPollingStarting",
      message: "Weixin long polling is starting.",
    });
    const runtime: RuntimeEntry = {
      controller,
      fingerprint,
      done: Promise.resolve(),
    };
    runtime.done = pollBot(bot, controller.signal).finally(() => {
      if (runtimes.get(bot.id) === runtime) {
        runtimes.delete(bot.id);
        const previous = deps.statusSink.getRuntimeStatus(bot.id);
        if (previous?.status === "polling") {
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "weixin",
            status: "idle",
            messageId: "bots.runtime.weixinLongPollingStopped",
            message: "Weixin long polling is stopped.",
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
    await deps.ensureBotStorageMigrated();
    const currentConfig = config ?? (await deps.readConfig());
    if (!isLatest()) {
      return;
    }
    const activeWeixinIds = new Set(
      currentConfig.bots
        .filter(
          (bot) =>
            bot.provider === "weixin" && bot.enabled && bot.credentialRef,
        )
        .map((bot) => bot.id),
    );
    for (const botId of runtimes.keys()) {
      if (!activeWeixinIds.has(botId)) {
        await stopPolling(botId);
        if (!isLatest()) {
          return;
        }
      }
    }
    for (const bot of currentConfig.bots) {
      if (bot.provider === "weixin" && bot.enabled && bot.credentialRef) {
        const fingerprint = await getConnectionFingerprint(bot);
        if (!isLatest()) {
          return;
        }
        const runtime = runtimes.get(bot.id);
        if (runtime && runtime.fingerprint !== fingerprint) {
          // Bugfix: 微信凭据更新后旧 getupdates 循环仍闭包持有旧 BotConfig。
          // 串行等待旧请求退出后再接管，避免旧账号继续消费或新旧游标并发推进。
          await stopPolling(bot.id);
          if (!isLatest()) {
            return;
          }
        }
        startPolling(bot, fingerprint);
      } else if (bot.provider === "weixin" && !bot.enabled) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
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
      // 修复原因：配置变更后的微信 long polling 属于本地桌面 host 后台任务；
      // attached remote 仅应暴露远端文件/agent 控制面。
      return;
    }
    void refresh(config).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `refresh Weixin polling failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async function dispose(): Promise<void> {
    refreshQueue.invalidate();
    const activeRuntimes = [...runtimes.values()];
    for (const runtime of activeRuntimes) {
      runtime.controller.abort();
    }
    // Bugfix：微信 buf 只能由锁 owner 提交；销毁必须等待请求退出和 finally 释放锁后才完成。
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
  };
}
