import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelErrorCode,
  ModelFailureReason,
  type Logger,
  type ModelNetworkStatusEvent,
  type ModelRequestTarget,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
  type ModelStreamEvent,
} from "@zcode/contracts";
import type { AiSdkModelRuntime } from "../src/model/runner-runtime.js";
import { readAdmissionRetryCooldownMs } from "../src/model/request-admission.js";
import {
  applyAdmissionRetryCooldown,
  retryDelayWithAdmissionCooldown,
} from "../src/model/runner-retry.js";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";

/** 旧 adapter 直接返回 AsyncIterableIterator；夹具返回 AsyncIterable，这里取它的迭代器以逐步驱动。 */
function iterateAdapterStream(
  ...args: Parameters<typeof executeAdapterStreamText>
): AsyncIterator<Awaited<ReturnType<typeof executeAdapterStreamText>> extends AsyncIterable<infer T> ? T : never> {
  return executeAdapterStreamText(...args)[Symbol.asyncIterator]();
}
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";

// docs/dynamic-workflow/concurrency.md「One ticket per request attempt」：runner 每次尝试发出前 acquire、结束即 release；
// 票据是该次尝试专属的状态事件汇；退避 sleep 期间不持票。

interface FakeTicket {
  events: ModelNetworkStatusEvent[];
  releases: number;
  releasedAt?: number;
}

interface FakeAdmission extends ModelRequestAdmission {
  acquires: Array<{ at: number; model: ModelRequestTarget; signal?: AbortSignal }>;
  tickets: FakeTicket[];
  log: string[];
}

function fakeAdmission(options: { blockForever?: boolean } = {}): FakeAdmission {
  const admission: FakeAdmission = {
    acquires: [],
    tickets: [],
    log: [],
    acquire({ model, signal }) {
      admission.acquires.push({ at: Date.now(), model, ...(signal ? { signal } : {}) });
      admission.log.push(`acquire#${admission.acquires.length}`);
      if (options.blockForever) {
        return new Promise<ModelRequestAdmissionTicket>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      const record: FakeTicket = { events: [], releases: 0 };
      admission.tickets.push(record);
      const index = admission.tickets.length;
      const ticket: ModelRequestAdmissionTicket = {
        publish(event) {
          record.events.push(event);
        },
        release() {
          record.releases += 1;
          record.releasedAt = Date.now();
          admission.log.push(`release#${index}`);
        },
      };
      return Promise.resolve(ticket);
    },
  };
  return admission;
}

function registry(): TestProviderConfigFixture {
  return new TestProviderConfigFixture({
    providers: {
      test: {
        kind: "custom",
        createLanguageModel: (modelId) => ({ modelId }) as never,
      },
    },
  });
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokenDetails: { noCacheTokens: inputTokens, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokenDetails: { textTokens: outputTokens, reasoningTokens: undefined },
  };
}

function apiError(
  message: string,
  options: { isRetryable: boolean; responseHeaders?: Record<string, string>; statusCode: number },
): Error {
  return Object.assign(new Error(message), {
    isRetryable: options.isRetryable,
    responseHeaders: options.responseHeaders,
    statusCode: options.statusCode,
  });
}

async function* stream(chunks: unknown[]) {
  for (const chunk of chunks) yield chunk;
}

async function* failingStream(error: unknown) {
  throw error;
}

const okChunks = () => [
  { type: "start" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", text: "hello" },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: "stop", totalUsage: usage(1, 1) },
];

describe("runner request admission (generate)", () => {
  it("acquires once per attempt, forwards exactly that attempt's events, releases before the backoff sleep", async () => {
    const admission = fakeAdmission();
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        admission.log.push(`generate#${attempts}`);
        if (attempts === 1) {
          // 不带 Retry-After：让本地退避（backoffMs）生效，才能量「release 在 sleep 之前」。
          throw apiError("rate limited", { isRetryable: true, statusCode: 429 });
        }
        return { text: "ok", finishReason: "stop", usage: usage(1, 1), totalUsage: usage(1, 1) } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const backoffMs = 80;
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: backoffMs, jitter: false, maxAttempts: 2, maxDelayMs: backoffMs },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });

    expect(result.text).toBe("ok");
    expect(admission.acquires).toHaveLength(2);
    expect(String(admission.acquires[0]!.model.modelId)).toBe("model-a");
    expect(admission.log).toEqual(["acquire#1", "generate#1", "release#1", "acquire#2", "generate#2", "release#2"]);
    expect(admission.tickets.map((ticket) => ticket.releases)).toEqual([1, 1]);
    expect(admission.tickets[0]!.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
    ]);
    expect(admission.tickets[1]!.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_completed",
    ]);
    // 退避期间不持票：第 2 次 acquire 与第 1 次 release 之间隔着整段 backoff。
    expect(admission.acquires[1]!.at - admission.tickets[0]!.releasedAt!).toBeGreaterThanOrEqual(backoffMs - 10);
    // 请求级 sink 照常收到全部事件（票据是并列的一路投递，不替代）。
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
  });

  it("releases the ticket exactly once when the attempt throws a permanent failure", async () => {
    const admission = fakeAdmission();
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw apiError("bad request", { isRetryable: false, statusCode: 400 });
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });
    await expect(
      executeAdapterGenerateText(adapter, {
        providerId: "test" as never,
      modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        modelRequestAdmission: admission,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(admission.acquires).toHaveLength(1);
    expect(admission.tickets[0]!.releases).toBe(1);
    expect(admission.tickets[0]!.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(admission.tickets[0]!.events[1]).toMatchObject({ retryable: false });
  });

  it("cancels while waiting for admission like a cancelled backoff: connect-phase cancelled failure, no request sent", async () => {
    const admission = fakeAdmission({ blockForever: true });
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        return { text: "never", finishReason: "stop", usage: usage(1, 1), totalUsage: usage(1, 1) } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });
    const controller = new AbortController();
    const pending = executeAdapterGenerateText(adapter, {
      abortSignal: controller.signal,
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(admission.acquires).toHaveLength(1);
    controller.abort();
    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: ModelErrorCode.ModelRequestCancelled,
      context: { errorPhase: "connect", reason: ModelFailureReason.Cancelled },
    });
    expect(attempts).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["model_request_failed"]);
    expect(events[0]).toMatchObject({ reason: ModelFailureReason.Cancelled, retryable: false });
  });

  it("is a no-op when the request carries no admission", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        return { text: "ok", finishReason: "stop", usage: usage(1, 1), totalUsage: usage(1, 1) } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });
    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: { publish: (event) => void events.push(event) },
    });
    expect(result.text).toBe("ok");
    expect(events.map((event) => event.type)).toEqual(["model_request_started", "model_request_completed"]);
  });
});

describe("runner request admission (stream)", () => {
  it("acquires once per attempt, forwards that attempt's events, releases before the backoff sleep", async () => {
    const admission = fakeAdmission();
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        admission.log.push(`stream#${attempts}`);
        if (attempts === 1) {
          return {
            fullStream: failingStream(apiError("rate limited", { isRetryable: true, statusCode: 429 })),
          } as never;
        }
        return { fullStream: stream(okChunks()) } as never;
      },
    };
    const backoffMs = 80;
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: backoffMs, jitter: false, maxAttempts: 2, maxDelayMs: backoffMs },
      runtime,
    });

    const seen: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
    })) {
      seen.push(event);
    }

    expect(seen.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "finish"]);
    expect(admission.log).toEqual(["acquire#1", "stream#1", "release#1", "acquire#2", "stream#2", "release#2"]);
    expect(admission.tickets.map((ticket) => ticket.releases)).toEqual([1, 1]);
    expect(admission.tickets[0]!.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
    ]);
    expect(admission.tickets[1]!.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_completed",
    ]);
    expect(admission.acquires[1]!.at - admission.tickets[0]!.releasedAt!).toBeGreaterThanOrEqual(backoffMs - 10);
  });

  it("releases the ticket when the consumer abandons the stream early", async () => {
    const admission = fakeAdmission();
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return { fullStream: stream(okChunks()) } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });
    const iterator = iterateAdapterStream(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
    });
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await iterator.return(undefined);
    expect(admission.acquires).toHaveLength(1);
    expect(admission.tickets[0]!.releases).toBe(1);
    expect(admission.tickets[0]!.events[0]?.type).toBe("model_request_started");
  });

  it("cancels while waiting for admission with a connect-phase cancelled failure", async () => {
    const admission = fakeAdmission({ blockForever: true });
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return { fullStream: stream(okChunks()) } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });
    const controller = new AbortController();
    const iterator = iterateAdapterStream(adapter, {
      abortSignal: controller.signal,
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
    });
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: ModelErrorCode.ModelRequestCancelled,
      context: { errorPhase: "connect", reason: ModelFailureReason.Cancelled },
    });
    expect(attempts).toBe(0);
  });
});

// v3 决策 44：tryAcquire 快路径未命中 → runner 发 queued，拿到票 → admitted（带排队时长）；
// 命中或端口没有快路径 → 一条都不发。

interface QueueingAdmission extends ModelRequestAdmission {
  tryAcquires: number;
  grant: () => void;
}

/** 有快路径的端口：`fastHits` 次快路径命中后转排队；排队由测试 `grant()` 兑现。 */
function queueingAdmission(options: { fastHits?: number; hasFastPath?: boolean } = {}): QueueingAdmission {
  const hasFastPath = options.hasFastPath ?? true;
  let fastHits = options.fastHits ?? 0;
  let pending: (() => void) | undefined;
  const ticket = (): ModelRequestAdmissionTicket => ({ publish() {}, release() {} });
  const admission: QueueingAdmission = {
    tryAcquires: 0,
    grant: () => {
      pending?.();
      pending = undefined;
    },
    acquire({ signal }) {
      return new Promise<ModelRequestAdmissionTicket>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        pending = () => resolve(ticket());
      });
    },
  };
  if (hasFastPath) {
    admission.tryAcquire = () => {
      admission.tryAcquires += 1;
      if (fastHits > 0) {
        fastHits -= 1;
        return ticket();
      }
      return undefined;
    };
  }
  return admission;
}

function okRuntime(): AiSdkModelRuntime {
  return {
    async generateText() {
      return { text: "ok", finishReason: "stop", usage: usage(1, 1), totalUsage: usage(1, 1) } as never;
    },
    streamText() {
      return { fullStream: stream(okChunks()) } as never;
    },
  };
}

describe("runner request admission — queued / admitted 状态事件（v3 决策 44）", () => {
  it("generate：快路径未命中 → queued → 拿到票 admitted(queuedMs) → started → completed", async () => {
    const admission = queueingAdmission();
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime: okRuntime(),
    });
    const pending = executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(admission.tryAcquires).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["model_request_queued"]);
    admission.grant();
    const result = await pending;
    expect(result.text).toBe("ok");
    expect(events.map((event) => event.type)).toEqual([
      "model_request_queued",
      "model_request_admitted",
      "model_request_started",
      "model_request_completed",
    ]);
    const admitted = events[1] as Extract<ModelNetworkStatusEvent, { type: "model_request_admitted" }>;
    expect(admitted.queuedMs).toBeGreaterThanOrEqual(25);
    // 两端事件与该尝试的其余事件同一 requestId：消费方能把它们归到同一条链。
    expect(events.every((event) => event.requestId === events[0]!.requestId)).toBe(true);
  });

  it("stream：同一顺序", async () => {
    const admission = queueingAdmission();
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime: okRuntime(),
    });
    const iterator = iterateAdapterStream(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });
    const first = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.map((event) => event.type)).toEqual(["model_request_queued"]);
    admission.grant();
    await first;
    for await (const _event of { [Symbol.asyncIterator]: () => iterator }) {
      // drain
    }
    expect(events.map((event) => event.type)).toEqual([
      "model_request_queued",
      "model_request_admitted",
      "model_request_started",
      "model_request_completed",
    ]);
  });

  it("快路径命中：不发 queued / admitted", async () => {
    const admission = queueingAdmission({ fastHits: 1 });
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime: okRuntime(),
    });
    await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });
    expect(admission.tryAcquires).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["model_request_started", "model_request_completed"]);
  });

  it("端口没有快路径：分不清排队与放行，一律不发", async () => {
    const admission = queueingAdmission({ hasFastPath: false });
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime: okRuntime(),
    });
    const pending = executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    admission.grant();
    await pending;
    expect(events.map((event) => event.type)).toEqual(["model_request_started", "model_request_completed"]);
  });

  it("排队中被取消：queued 之后只有 connect 阶段的 cancelled failed，没有 admitted", async () => {
    const admission = queueingAdmission();
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime: okRuntime(),
    });
    const controller = new AbortController();
    const pending = executeAdapterGenerateText(adapter, {
      abortSignal: controller.signal,
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: ModelErrorCode.ModelRequestCancelled });
    expect(events.map((event) => event.type)).toEqual(["model_request_queued", "model_request_failed"]);
    expect(events[1]).toMatchObject({ reason: ModelFailureReason.Cancelled });
  });
});

// 主代理（observer）重试时参考冷却（docs/dynamic-workflow/concurrency.md「Where the port is bound」）：
// 首次请求照常立刻发出；只有重试的退避读端口的 `retryCooldownMs`，等待取 max(本地退避, 剩余冷却)，
// 冷却部分封顶 5 分钟；等待期间照常发 retry_scheduled、照常响应 abort。

/** 带 `retryCooldownMs` 的 fakeAdmission：记录每次读冷却的时刻与模型身份，读一次也记进 log。 */
function cooldownAdmission(cooldownMs: number) {
  const admission = fakeAdmission();
  const reads: Array<{ at: number; model: ModelRequestTarget }> = [];
  admission.retryCooldownMs = ({ model }) => {
    reads.push({ at: Date.now(), model });
    admission.log.push(`cooldown#${reads.length}`);
    return cooldownMs;
  };
  return { admission, reads };
}

/** 第一次尝试以 429（不带 Retry-After）失败、之后成功的流式 runtime；`asErrorChunk` 让 429 以 SSE error chunk 到达。 */
function rateLimitedOnceStreamRuntime(
  admission: FakeAdmission,
  options: { asErrorChunk?: boolean } = {},
): AiSdkModelRuntime {
  let attempts = 0;
  return {
    async generateText() {
      throw new Error("not used");
    },
    streamText() {
      attempts += 1;
      admission.log.push(`stream#${attempts}`);
      if (attempts === 1) {
        const error = apiError("rate limited", { isRetryable: true, statusCode: 429 });
        return {
          fullStream: options.asErrorChunk
            ? stream([{ type: "start" }, { type: "error", error }])
            : failingStream(error),
        } as never;
      }
      return { fullStream: stream(okChunks()) } as never;
    },
  };
}

async function drainStream(
  adapter: AiSdkModelAdapter,
  admission: FakeAdmission,
  events: ModelNetworkStatusEvent[],
  abortSignal?: AbortSignal,
): Promise<ModelStreamEvent[]> {
  const seen: ModelStreamEvent[] = [];
  for await (const event of executeAdapterStreamText(adapter, {
    ...(abortSignal ? { abortSignal } : {}),
    providerId: "test" as never,
    modelId: "model-a" as never,
    messages: [{ role: "user", content: "Ping" }],
    modelRequestAdmission: admission,
    statusSink: { publish: (event) => void events.push(event) },
  })) {
    seen.push(event);
  }
  return seen;
}

function retryScheduledDelays(events: ModelNetworkStatusEvent[]): number[] {
  return events.flatMap((event) => (event.type === "model_retry_scheduled" ? [event.delayMs] : []));
}

describe("runner request admission — 主代理重试参考冷却", () => {
  it("首次请求不读冷却、立刻发出；重试等到 max(退避, 剩余冷却)", async () => {
    const cooldownMs = 150;
    const backoffMs = 20;
    const { admission, reads } = cooldownAdmission(cooldownMs);
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: backoffMs, jitter: false, maxAttempts: 2, maxDelayMs: backoffMs },
      runtime: rateLimitedOnceStreamRuntime(admission),
    });

    const startedAt = Date.now();
    const seen = await drainStream(adapter, admission, events);

    expect(seen.map((event) => event.type)).toContain("finish");
    // 第一次尝试发出之前没有读冷却：冷却只进重试的退避。
    expect(admission.log).toEqual([
      "acquire#1",
      "stream#1",
      "cooldown#1",
      "release#1",
      "acquire#2",
      "stream#2",
      "release#2",
    ]);
    expect(admission.acquires[0]!.at - startedAt).toBeLessThan(50);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.model).toEqual({ providerId: "test", modelId: "model-a" });
    // retry_scheduled 报的就是实际等待（界面据此显示「等待中」），退避期间不持票。
    expect(retryScheduledDelays(events)).toEqual([cooldownMs]);
    expect(admission.acquires[1]!.at - admission.tickets[0]!.releasedAt!).toBeGreaterThanOrEqual(
      cooldownMs - 10,
    );
  });

  it.each([
    { name: "冷却已过期（端口报 0）", cooldownMs: 0 },
    { name: "剩余冷却短于退避", cooldownMs: 10 },
  ])("$name 时只用本地退避", async ({ cooldownMs }) => {
    const backoffMs = 60;
    const { admission } = cooldownAdmission(cooldownMs);
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: backoffMs, jitter: false, maxAttempts: 2, maxDelayMs: backoffMs },
      runtime: rateLimitedOnceStreamRuntime(admission),
    });

    await drainStream(adapter, admission, events);

    expect(retryScheduledDelays(events)).toEqual([backoffMs]);
  });

  it("SSE error chunk 送来的限流（BigModel 1302 的常见形态）同样等到剩余冷却", async () => {
    const cooldownMs = 120;
    const { admission } = cooldownAdmission(cooldownMs);
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime: rateLimitedOnceStreamRuntime(admission, { asErrorChunk: true }),
    });

    const seen = await drainStream(adapter, admission, events);

    expect(seen.map((event) => event.type)).toContain("finish");
    expect(retryScheduledDelays(events)).toEqual([cooldownMs]);
    expect(admission.acquires[1]!.at - admission.tickets[0]!.releasedAt!).toBeGreaterThanOrEqual(
      cooldownMs - 10,
    );
  });

  it("等待封顶 5 分钟；等待中 abort 立刻结束，retry_scheduled 照常先发出", async () => {
    const { admission } = cooldownAdmission(30 * 60_000);
    const events: ModelNetworkStatusEvent[] = [];
    const controller = new AbortController();
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime: rateLimitedOnceStreamRuntime(admission),
    });

    const pending = drainStream(adapter, admission, events, controller.signal);
    while (!events.some((event) => event.type === "model_retry_scheduled")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const abortedAt = Date.now();
    controller.abort();
    const error = await pending.catch((cause: unknown) => cause);

    expect(Date.now() - abortedAt).toBeLessThan(1_000);
    expect(error).toMatchObject({
      code: ModelErrorCode.ModelRequestCancelled,
      context: { errorPhase: "connect", reason: ModelFailureReason.Cancelled },
    });
    expect(retryScheduledDelays(events)).toEqual([5 * 60_000]);
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_failed",
    ]);
    // 没有发出第二次请求。
    expect(admission.acquires).toHaveLength(1);
  });

  it("generate 路径同样等到 max(退避, 剩余冷却)", async () => {
    const cooldownMs = 120;
    const { admission, reads } = cooldownAdmission(cooldownMs);
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        if (attempts === 1) {
          throw apiError("rate limited", { isRetryable: true, statusCode: 429 });
        }
        return {
          text: "ok",
          finishReason: "stop",
          usage: usage(1, 1),
          totalUsage: usage(1, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 10, jitter: false, maxAttempts: 2, maxDelayMs: 10 },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });

    expect(result.text).toBe("ok");
    expect(reads).toHaveLength(1);
    expect(retryScheduledDelays(events)).toEqual([cooldownMs]);
    expect(admission.acquires[1]!.at - admission.tickets[0]!.releasedAt!).toBeGreaterThanOrEqual(
      cooldownMs - 10,
    );
  });
});

describe("applyAdmissionRetryCooldown / readAdmissionRetryCooldownMs", () => {
  it("冷却只会拉长等待，冷却部分封顶 5 分钟；本地退避本身不受影响", () => {
    expect(applyAdmissionRetryCooldown(2_000, 0)).toBe(2_000);
    expect(applyAdmissionRetryCooldown(2_000, 500)).toBe(2_000);
    expect(applyAdmissionRetryCooldown(2_000, 9_000)).toBe(9_000);
    expect(applyAdmissionRetryCooldown(2_000, 60 * 60_000)).toBe(5 * 60_000);
    expect(applyAdmissionRetryCooldown(2_000, Number.NaN)).toBe(2_000);
  });

  it("端口不实现、报负数或非有限值时按 0 算", () => {
    const model = { providerId: "p", modelId: "m" };
    const port = (value: number): ModelRequestAdmission => ({
      acquire: () => Promise.reject(new Error("not used")),
      retryCooldownMs: () => value,
    });
    expect(readAdmissionRetryCooldownMs(undefined, model)).toBe(0);
    expect(readAdmissionRetryCooldownMs(fakeAdmission(), model)).toBe(0);
    expect(readAdmissionRetryCooldownMs(port(-5), model)).toBe(0);
    expect(readAdmissionRetryCooldownMs(port(Number.POSITIVE_INFINITY), model)).toBe(0);
    expect(readAdmissionRetryCooldownMs(port(1_500), model)).toBe(1_500);
  });
});

describe("retryDelayWithAdmissionCooldown — 冷却拉长等待时的正向抖动", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const statusContext = { providerId: "p", modelId: "m" } as never;
  const port = (cooldownMs: number): ModelRequestAdmission => ({
    acquire: () => Promise.reject(new Error("not used")),
    retryCooldownMs: () => cooldownMs,
  });

  it("冷却拉长了等待且开了 jitter：往后加最多 20%、不超过 5 秒的抖动，绝不早于冷却", () => {
    const random = vi.spyOn(Math, "random");
    random.mockReturnValue(1);
    expect(
      retryDelayWithAdmissionCooldown({
        admission: port(10_000),
        backoffMs: 2_000,
        jitter: true,
        statusContext,
      }),
    ).toEqual({ admissionCooldownMs: 10_000, backoffMs: 2_000, delayMs: 12_000 });
    // 档位封顶 5 秒：60s 冷却最多加 5s。
    expect(
      retryDelayWithAdmissionCooldown({
        admission: port(60_000),
        backoffMs: 0,
        jitter: true,
        statusContext,
      }).delayMs,
    ).toBe(65_000);
    random.mockReturnValue(0);
    expect(
      retryDelayWithAdmissionCooldown({
        admission: port(10_000),
        backoffMs: 2_000,
        jitter: true,
        statusContext,
      }).delayMs,
    ).toBe(10_000);
  });

  it("加了抖动的总等待仍不超过 5 分钟", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(
      retryDelayWithAdmissionCooldown({
        admission: port(4 * 60_000 + 58_000),
        backoffMs: 0,
        jitter: true,
        statusContext,
      }).delayMs,
    ).toBe(5 * 60_000);
    expect(
      retryDelayWithAdmissionCooldown({
        admission: port(60 * 60_000),
        backoffMs: 0,
        jitter: true,
        statusContext,
      }).delayMs,
    ).toBe(5 * 60_000);
  });

  it("冷却没有拉长等待、或关了 jitter、或端口不报冷却：等待就是本地退避，不叠加抖动", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    expect(
      retryDelayWithAdmissionCooldown({
        admission: port(1_000),
        backoffMs: 2_000,
        jitter: true,
        statusContext,
      }).delayMs,
    ).toBe(2_000);
    expect(
      retryDelayWithAdmissionCooldown({
        admission: port(0),
        backoffMs: 2_000,
        jitter: true,
        statusContext,
      }).delayMs,
    ).toBe(2_000);
    expect(
      retryDelayWithAdmissionCooldown({
        admission: fakeAdmission(),
        backoffMs: 2_000,
        jitter: true,
        statusContext,
      }).delayMs,
    ).toBe(2_000);
    expect(
      retryDelayWithAdmissionCooldown({
        admission: port(10_000),
        backoffMs: 2_000,
        jitter: false,
        statusContext,
      }).delayMs,
    ).toBe(10_000);
    // 以上分支都不该抽随机数（退避自己的抖动在 calculateRetryDelay 里已经抽过）。
    expect(random).not.toHaveBeenCalled();
  });

  it("runner 里：开 jitter 时 retry_scheduled 报的是冷却 + 抖动，实际也等了这么久", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const cooldownMs = 150;
    const { admission } = cooldownAdmission(cooldownMs);
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      // 本地退避 = 10 × (0.5 + 1 × 0.5) = 10，远小于冷却。
      retry: { baseDelayMs: 10, jitter: true, maxAttempts: 2, maxDelayMs: 10 },
      runtime: rateLimitedOnceStreamRuntime(admission),
    });

    await drainStream(adapter, admission, events);

    // 150 + min(150 × 20%, 5s) = 180。
    expect(retryScheduledDelays(events)).toEqual([180]);
    expect(admission.acquires[1]!.at - admission.tickets[0]!.releasedAt!).toBeGreaterThanOrEqual(
      170,
    );
  });
});

describe("model.retry.delay.resolved 日志：叠加冷却时记 admissionCooldownMs 与 backoffMs", () => {
  type Captured = { message: string; context?: Record<string, unknown> };
  const captureLogger = (entries: Captured[]): Logger => {
    const logger: Logger = {
      child: () => logger,
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: (message, context) => void entries.push({ message, context: context as never }),
    };
    return logger;
  };
  const retryDelayLog = (entries: Captured[]) =>
    entries.find((entry) => entry.context?.event === "model.retry.delay.resolved")?.context;

  it.each([
    {
      name: "冷却拉长了等待",
      cooldownMs: 150,
      expected: { admissionCooldownMs: 150, backoffMs: 20, delayMs: 150 },
    },
    { name: "端口报 0", cooldownMs: 0, expected: { delayMs: 20 } },
  ])("$name", async ({ cooldownMs, expected }) => {
    const entries: Captured[] = [];
    const { admission } = cooldownAdmission(cooldownMs);
    const adapter = new AiSdkModelAdapter({
      logger: captureLogger(entries),
      registry: registry(),
      retry: { baseDelayMs: 20, jitter: false, maxAttempts: 2, maxDelayMs: 20 },
      runtime: rateLimitedOnceStreamRuntime(admission),
    });

    await drainStream(adapter, admission, []);

    const log = retryDelayLog(entries);
    expect(log).toMatchObject({ ...expected, canRetry: true, status: "waiting" });
    if (cooldownMs === 0) {
      expect(log).not.toHaveProperty("admissionCooldownMs");
      expect(log).not.toHaveProperty("backoffMs");
    }
  });
});

describe("空 completion 重试：参考准入冷却，退避前归还票据，治理器信号不变", () => {
  function emptyThenOkGenerate(admission: FakeAdmission): AiSdkModelRuntime {
    let attempts = 0;
    return {
      async generateText() {
        attempts += 1;
        admission.log.push(`generate#${attempts}`);
        if (attempts === 1) {
          return { finishReason: "other", text: "", usage: usage(0, 0) } as never;
        }
        return {
          text: "recovered",
          finishReason: "stop",
          usage: usage(1, 1),
          totalUsage: usage(1, 1),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
  }

  function emptyThenOkStream(admission: FakeAdmission): AiSdkModelRuntime {
    let attempts = 0;
    return {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        admission.log.push(`stream#${attempts}`);
        if (attempts === 1) {
          return {
            fullStream: stream([
              { type: "start" },
              { type: "finish", finishReason: "other", totalUsage: usage(0, 0) },
            ]),
          } as never;
        }
        return { fullStream: stream(okChunks()) } as never;
      },
    };
  }

  const backoffMs = 20;
  const retryOptions = {
    baseDelayMs: backoffMs,
    jitter: false,
    maxAttempts: 3,
    maxDelayMs: backoffMs,
  };

  it("generate：重试等到 max(退避, 剩余冷却)，冷却只在重试前读，票据在 sleep 前归还且只见 started", async () => {
    const cooldownMs = 150;
    const { admission, reads } = cooldownAdmission(cooldownMs);
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: retryOptions,
      runtime: emptyThenOkGenerate(admission),
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });

    expect(result.text).toBe("recovered");
    expect(reads).toHaveLength(1);
    expect(admission.log).toEqual([
      "acquire#1",
      "generate#1",
      "cooldown#1",
      "release#1",
      "acquire#2",
      "generate#2",
      "release#2",
    ]);
    expect(retryScheduledDelays(events)).toEqual([cooldownMs]);
    expect(admission.acquires[1]!.at - admission.tickets[0]!.releasedAt!).toBeGreaterThanOrEqual(
      cooldownMs - 10,
    );
    // 两条状态事件不转投票据：治理器对这次尝试的信号仍是 release 即 ended。
    expect(admission.tickets[0]!.events.map((event) => event.type)).toEqual([
      "model_request_started",
    ]);
    expect(admission.tickets[0]!.releases).toBe(1);
    // 请求级状态汇照常收到 failed → retry_scheduled（界面照常显示重试中）。
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
  });

  it("stream：同样等到剩余冷却、sleep 前归还票据", async () => {
    const cooldownMs = 150;
    const { admission, reads } = cooldownAdmission(cooldownMs);
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: retryOptions,
      runtime: emptyThenOkStream(admission),
    });

    const seen = await drainStream(adapter, admission, events);

    expect(seen.map((event) => event.type)).toContain("finish");
    expect(reads).toHaveLength(1);
    expect(admission.log).toEqual([
      "acquire#1",
      "stream#1",
      "cooldown#1",
      "release#1",
      "acquire#2",
      "stream#2",
      "release#2",
    ]);
    expect(retryScheduledDelays(events)).toEqual([cooldownMs]);
    expect(admission.acquires[1]!.at - admission.tickets[0]!.releasedAt!).toBeGreaterThanOrEqual(
      cooldownMs - 10,
    );
    expect(admission.tickets[0]!.events.map((event) => event.type)).toEqual([
      "model_request_started",
    ]);
  });

  it("不报冷却的端口（子 agent / workflow）：等待仍是本地退避，同样在 sleep 前归还", async () => {
    const admission = fakeAdmission();
    const events: ModelNetworkStatusEvent[] = [];
    const slowBackoffMs = 80;
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: {
        baseDelayMs: slowBackoffMs,
        jitter: false,
        maxAttempts: 3,
        maxDelayMs: slowBackoffMs,
      },
      runtime: emptyThenOkGenerate(admission),
    });

    await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });

    expect(retryScheduledDelays(events)).toEqual([slowBackoffMs]);
    expect(admission.log).toEqual([
      "acquire#1",
      "generate#1",
      "release#1",
      "acquire#2",
      "generate#2",
      "release#2",
    ]);
    expect(admission.acquires[1]!.at - admission.tickets[0]!.releasedAt!).toBeGreaterThanOrEqual(
      slowBackoffMs - 10,
    );
    expect(admission.tickets[0]!.events.map((event) => event.type)).toEqual([
      "model_request_started",
    ]);
  });
});
