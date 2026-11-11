import assert from "node:assert/strict";
import type { BotRuntimeInfo, BotsConfigFile } from "@zcode/shared";
import {
  createFeishuConfig,
  readBotSyntheticFixture,
} from "#e2e/bots/helpers/bots-service-harness";
import { createTelegramChannelRuntime } from "../../../../../services/src/bots/telegramChannelRuntime.js";
import { createWeixinChannelRuntime } from "../../../../../services/src/bots/weixinChannelRuntime.js";

type CredentialService = Parameters<typeof createWeixinChannelRuntime>[0]["credentialService"];

function createRuntimeDeps(provider: "weixin" | "telegram") {
  const config: BotsConfigFile = createFeishuConfig();
  config.bots = [{ ...config.bots[0]!, id: `${provider}-retry-e2e`, provider }];
  const statuses = new Map<string, BotRuntimeInfo>();
  const warnings: string[] = [];
  return {
    bot: config.bots[0]!,
    warnings,
    deps: {
      // runtime 只读取 token；其余凭据能力与本用例无关。
      credentialService: { load: async () => "token-e2e" } as unknown as CredentialService,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (_traceId: string | undefined, message: string) => warnings.push(message),
      },
      statusSink: {
        getRuntimeStatus: (botId: string) => statuses.get(botId),
        setRuntimeStatus: (status: BotRuntimeInfo) => statuses.set(status.botId, status),
      },
      ensureBotStorageMigrated: async () => undefined,
      readConfig: async () => config,
      acquirePollingLock: async () => ({ release: async () => undefined }),
    },
  };
}

/** 等到第 3 次拉取，返回相邻两次重试的间隔。 */
async function waitForTwoRetryGaps(calls: number[], label: string): Promise<[number, number]> {
  await browser.waitUntil(async () => calls.length >= 3, {
    timeout: 30_000,
    timeoutMsg: `${label} 没有在退避后继续重试`,
  });
  return [calls[1]! - calls[0]!, calls[2]! - calls[1]!];
}

function assertBackoff(label: string, gaps: [number, number], warnings: string[], marker: string) {
  // 第 1 次失败等 5 秒，第 2 次等 10 秒；修复前两次都是 5 秒且没有日志。
  assert.ok(gaps[0] >= 4_500, `${label} 第 1 次重试间隔过短：${gaps[0]}ms`);
  assert.ok(gaps[1] >= 9_500, `${label} 第 2 次重试没有退避：${gaps[1]}ms`);
  assert.ok(
    warnings.some((line) => line.includes("failures=1 retryInMs=5000") && line.includes(marker)),
    `${label} 第 1 次失败没有 warn 日志：${JSON.stringify(warnings)}`,
  );
  assert.ok(
    warnings.some((line) => line.includes("failures=2 retryInMs=10000") && line.includes(marker)),
    `${label} 第 2 次失败没有 warn 日志：${JSON.stringify(warnings)}`,
  );
}

describe("BOT-E2E-RD-02 polling failure log and backoff", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("weixin: logs each failed poll and doubles the retry delay without moving the cursor", async () => {
    const fixture = await readBotSyntheticFixture("polling-retry-backoff.json");
    assert.equal(fixture.caseId, "BOT-E2E-RD-02");
    const marker = `${fixture.promptMarker}_WEIXIN_DOWN`;
    const { bot, deps, warnings } = createRuntimeDeps("weixin");
    const calls: number[] = [];
    const bufs: Array<string | undefined> = [];
    const writtenBufs: string[] = [];
    const runtime = createWeixinChannelRuntime({
      ...deps,
      readWeixinGetUpdatesBuf: async () => "e2e-buf-before-failure",
      writeWeixinGetUpdatesBuf: async (_botId, buf) => {
        writtenBufs.push(buf);
      },
      processProviderCallback: async () => ({ ok: true, replies: [] }),
      getUpdates: async (params) => {
        calls.push(Date.now());
        bufs.push(params.buf);
        throw new Error(marker);
      },
    });
    try {
      await runtime.refresh();
      const gaps = await waitForTwoRetryGaps(calls, "weixin");
      assertBackoff("weixin", gaps, warnings, marker);
      assert.ok(warnings.every((line) => line.includes(`bot=${bot.id}`)));
      assert.deepEqual(
        new Set(bufs),
        new Set(["e2e-buf-before-failure"]),
        "失败后必须用原游标重试",
      );
      assert.deepEqual(writtenBufs, [], "失败的批次不能提交游标");
    } finally {
      await runtime.dispose();
    }
  });

  it("weixin: a committed batch resets the backoff, and dispose ends the wait at once", async () => {
    const fixture = await readBotSyntheticFixture("polling-retry-backoff.json");
    const marker = `${fixture.promptMarker}_WEIXIN_FLAKY`;
    const { deps, warnings } = createRuntimeDeps("weixin");
    let call = 0;
    const writtenBufs: string[] = [];
    const runtime = createWeixinChannelRuntime({
      ...deps,
      readWeixinGetUpdatesBuf: async () => "e2e-buf-before-failure",
      writeWeixinGetUpdatesBuf: async (_botId, buf) => {
        writtenBufs.push(buf);
      },
      processProviderCallback: async () => ({ ok: true, replies: [] }),
      // 失败、失败、成功提交、之后再失败。
      getUpdates: async () => {
        call += 1;
        if (call === 3) return { messages: [], buf: "e2e-buf-after-success" };
        throw new Error(marker);
      },
    });
    const firstFailureLogs = () =>
      warnings.filter(
        (line) => line.includes("failures=1 retryInMs=5000") && line.includes(marker),
      );
    try {
      await runtime.refresh();
      await browser.waitUntil(async () => firstFailureLogs().length >= 2, {
        timeout: 30_000,
        timeoutMsg: `成功提交后没有从 5 秒重新退避：${JSON.stringify(warnings)}`,
      });
      assert.deepEqual(writtenBufs, ["e2e-buf-after-success"], "只有完整成功的批次提交游标");
      assert.ok(
        warnings.some((line) => line.includes("failures=2 retryInMs=10000")),
        "成功前应已退避到 10 秒",
      );
    } finally {
      // 此时 runtime 正在 5 秒退避中；dispose 必须中止等待并释放轮询锁，不能等退避结束。
      const startedAt = Date.now();
      await runtime.dispose();
      assert.ok(
        Date.now() - startedAt < 2_000,
        `dispose 被退避等待阻塞：${Date.now() - startedAt}ms`,
      );
    }
  });

  it("telegram: logs each failed callback and doubles the retry delay without moving the offset", async () => {
    const fixture = await readBotSyntheticFixture("polling-retry-backoff.json");
    const marker = "Telegram callback failed: status=503";
    const { bot, deps, warnings } = createRuntimeDeps("telegram");
    const calls: number[] = [];
    const offsets: Array<number | undefined> = [];
    const writtenOffsets: number[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getUpdates")) {
        calls.push(Date.now());
        offsets.push((JSON.parse(String(init?.body ?? "{}")) as { offset?: number }).offset);
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 41,
              message: {
                message_id: 1,
                chat: { id: 1, type: "private" },
                from: { id: 1 },
                text: `${fixture.promptMarker} telegram`,
              },
            },
          ],
        });
      }
      return Response.json({ ok: true, result: true });
    };
    const runtime = createTelegramChannelRuntime({
      ...deps,
      telegramProvider: null,
      readTelegramOffset: async () => 41,
      writeTelegramOffset: async (_botId, offset) => {
        writtenOffsets.push(offset);
      },
      // 业务回调返回可恢复失败，offset 不能提交。
      processProviderCallback: async () => ({ ok: false, replies: [], status: 503 }),
    });
    try {
      await runtime.refresh();
      const gaps = await waitForTwoRetryGaps(calls, "telegram");
      assertBackoff("telegram", gaps, warnings, marker);
      assert.ok(warnings.every((line) => line.includes(`bot=${bot.id}`)));
      assert.deepEqual(new Set(offsets), new Set([41]), "失败后必须用原 offset 重试");
      assert.deepEqual(writtenOffsets, [], "失败的 update 不能提交 offset");
    } finally {
      await runtime.dispose();
    }
  });
});
