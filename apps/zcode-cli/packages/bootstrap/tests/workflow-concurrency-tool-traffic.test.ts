/**
 * v3 回归场景（docs/dynamic-workflow/concurrency.md「Where the port is bound」）：deep-research 形态——
 * 6 个子代理各发 1 个 turn 请求 + 3 个并行工具侧请求，全部经 runtime 层准入（决策 42/43），
 * provider 在 8 并发以上 429。钉住三件事：provider 观测到的在飞从不超过治理器 cap；首个 429 立即
 * 砍 cap（不再有「治理器看不见工具流量」的一分钟盲区）；排队请求发 queued / admitted（决策 44）。
 * 真治理器 + 真 adapter runner + 假 provider；每个子代理的准入端口走 driver 的窄包装。
 */

import { describe, expect, it } from "vitest";
import {
  ModelRetryBudget,
  runWithModelInvocationContext,
  type ModelNetworkStatusEvent,
  type ModelRequestAdmission,
  type ModelStatusSink,
} from "@zcode/contracts";
import {
  AiSdkModelAdapter,
  ProviderBusinessError,
  type AiSdkModelRuntime,
} from "@zcode/adapters/model";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  type RegistryModelConfig,
  type RegistryProviderConfig,
} from "@zcode/provider";
import { createActorModelActivity } from "../src/app/workflow-driver-concurrency.js";
import {
  createWorkflowConcurrencyGovernor,
  workflowConcurrencyKey,
} from "../src/app/workflow-concurrency-governor.js";

const DEFAULT_CONCURRENCY = 13;
const PROVIDER_LIMIT = 8;
const ACTORS = 6;
const TOOL_REQUESTS_PER_ACTOR = 3;

/** provider 重构后 adapter 只吃完整的单 Provider/Model Config；这里手工拼一份最小的假 provider。 */
function testProviderConfig(providerId: string): RegistryProviderConfig {
  return new ProviderConfig({
    access: new ApiKeyAccessConfig({ apiKey: "test-api-key" }),
    api: new ProviderApiConfig({
      baseUrl: "https://adapter.test/v1",
      type: "openai-chat-completions",
    }),
    builtinModelIds: [],
    enabled: true,
    id: providerId,
    personalModelIds: [],
    name: providerId,
    visibility: "visible",
  }) as RegistryProviderConfig;
}

function testModelConfig(): RegistryModelConfig {
  return new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
      inputFormat: new ModelInputFormatConfig({
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      }),
      outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      maxOutputTokens: { max: 1_000_000, map: '{"max_completion_tokens": maxOutputTokens}' },
      reasoningLevel: { values: ["disabled"], map: "{}" },
    }),
  }) as RegistryModelConfig;
}

function usage(n: number) {
  return {
    inputTokens: n,
    outputTokens: n,
    totalTokens: 2 * n,
    inputTokenDetails: {
      noCacheTokens: n,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: { textTokens: n, reasoningTokens: undefined },
  };
}

describe("workflow concurrency — 工具侧模型请求也过闸门（v3 决策 42/43/44）", () => {
  it("6 子代理 × (1 turn + 3 工具请求)：provider 在飞 ≤ cap，首个 429 即砍，排队者发 queued/admitted", async () => {
    const governor = createWorkflowConcurrencyGovernor({ defaultConcurrency: DEFAULT_CONCURRENCY });
    const key = workflowConcurrencyKey({ providerId: "prov", modelId: "alpha" } as never);

    let inFlight = 0;
    let maxInFlight = 0;
    let rateLimited = 0;
    let capAtFirst429: number | undefined;
    const capAboveProviderObserved: number[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const cap = governor.snapshot(key)?.cap ?? DEFAULT_CONCURRENCY;
        if (inFlight > cap) capAboveProviderObserved.push(inFlight);
        try {
          if (inFlight > PROVIDER_LIMIT) {
            rateLimited += 1;
            capAtFirst429 ??= cap;
            throw Object.assign(new Error("rate limited"), { isRetryable: true, statusCode: 429 });
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
          return {
            text: "ok",
            finishReason: "stop",
            usage: usage(1),
            totalUsage: usage(1),
          } as never;
        } finally {
          inFlight -= 1;
        }
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      retry: { baseDelayMs: 5, jitter: false, maxAttempts: 20, maxDelayMs: 5 },
      runtime,
    });
    const model = adapter.createModel({
      providerId: "prov",
      modelId: "alpha",
      providerConfig: testProviderConfig("prov"),
      modelConfig: testModelConfig(),
      options: { maxOutputTokens: 32_000, reasoningLevel: "disabled" },
    });

    const events: ModelNetworkStatusEvent[] = [];
    const requests: Promise<unknown>[] = [];
    for (let actor = 0; actor < ACTORS; actor += 1) {
      const activity = createActorModelActivity({
        port: governor,
        runId: "run-deep-research",
        handlers: { onWaiting: () => {}, onExecuting: () => {} },
      });
      // 准入端口与状态汇经调用上下文到 runner（adapters/src/model/runner.ts 把上下文整份铺进请求）。
      const statusSink: ModelStatusSink = { publish: (event) => void events.push(event) };
      const send = (querySource: string, toolCallId?: string) =>
        runWithModelInvocationContext(
          {
            metadata: { querySource, ...(toolCallId === undefined ? {} : { toolCallId }) },
            modelRequestAdmission: activity.admission as ModelRequestAdmission,
            statusSink,
          },
          () => model.generateText({ messages: [{ role: "user", content: "Ping" }] }),
        );
      requests.push(send("workflow_child"));
      for (let tool = 0; tool < TOOL_REQUESTS_PER_ACTOR; tool += 1) {
        requests.push(send("web_search_tool", `tc-${actor}-${tool}`));
      }
    }
    await Promise.all(requests);

    // provider 看到的在飞从不超过治理器此刻的 cap（也就从不超过天花板）。
    expect(capAboveProviderObserved).toEqual([]);
    expect(maxInFlight).toBeLessThanOrEqual(DEFAULT_CONCURRENCY);
    // 第一个 429 打在天花板上，之后 cap 立刻降到天花板以下——不再有看不见的流量。
    expect(rateLimited).toBeGreaterThan(0);
    expect(capAtFirst429).toBe(DEFAULT_CONCURRENCY);
    const snapshot = governor.snapshot(key)!;
    expect(snapshot.cap).toBeLessThan(DEFAULT_CONCURRENCY);
    // 24 个请求挤 13 个槽：至少有人排过队，且排队者都拿到了票。
    const queued = events.filter((event) => event.type === "model_request_queued");
    const admitted = events.filter((event) => event.type === "model_request_admitted");
    expect(queued.length).toBeGreaterThan(0);
    expect(admitted.length).toBe(queued.length);
    // 工具侧请求确实经过了闸门：它们中也有排过队的。
    expect(queued.some((event) => event.querySource === "web_search_tool")).toBe(true);
    expect(snapshot.inFlight).toBe(0);
  });
});

/**
 * 终态设计的回归场景（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）：Start Plan 网关在用户并发上限处
 * 回业务码 3008（`user concurrency limit exceeded`），分类器判它 `retryable:false`（主对话的
 * 横幅决策）。workflow 流量带无上限预算，runner 改读策略表：3008 = retry——请求不失败、
 * 以 retry_scheduled{rate_limited} 喂治理器，cap 收敛到上限以下，24 个请求全部完成。
 */
describe("workflow concurrency — Start Plan 3008 在 workflow 内是重试而不是失败", () => {
  it("6 子代理 × (1 turn + 3 工具请求)：无一失败、cap 收敛、每个 3008 都紧跟一条 retry_scheduled", async () => {
    const governor = createWorkflowConcurrencyGovernor({ defaultConcurrency: DEFAULT_CONCURRENCY });
    const key = workflowConcurrencyKey({ providerId: "prov", modelId: "alpha" } as never);

    let inFlight = 0;
    let concurrencyLimited = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        inFlight += 1;
        try {
          if (inFlight > PROVIDER_LIMIT) {
            concurrencyLimited += 1;
            throw new ProviderBusinessError({
              providerCode: "3008",
              providerId: "prov",
              providerKind: "openai-compatible",
              providerMessage: "user concurrency limit exceeded",
              responseStatus: 429,
              statusCode: 429,
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
          return {
            text: "ok",
            finishReason: "stop",
            usage: usage(1),
            totalUsage: usage(1),
          } as never;
        } finally {
          inFlight -= 1;
        }
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      // 有界预算故意给得很小：3008 若仍走分类器的 retryable:false，这里就会立刻失败。
      retry: { baseDelayMs: 5, jitter: false, maxAttempts: 2, maxDelayMs: 5 },
      runtime,
    });
    const model = adapter.createModel({
      providerId: "prov",
      modelId: "alpha",
      providerConfig: testProviderConfig("prov"),
      modelConfig: testModelConfig(),
      options: { maxOutputTokens: 32_000, reasoningLevel: "disabled" },
    });

    const events: ModelNetworkStatusEvent[] = [];
    const requests: Promise<unknown>[] = [];
    for (let actor = 0; actor < ACTORS; actor += 1) {
      const activity = createActorModelActivity({
        port: governor,
        runId: "run-start-plan",
        handlers: { onWaiting: () => {}, onExecuting: () => {} },
      });
      const statusSink: ModelStatusSink = { publish: (event) => void events.push(event) };
      const send = (querySource: string, toolCallId?: string) =>
        runWithModelInvocationContext(
          {
            metadata: { querySource, ...(toolCallId === undefined ? {} : { toolCallId }) },
            modelRequestAdmission: activity.admission as ModelRequestAdmission,
            // 预算走调用上下文（core 的 runtime 层按 taskType 绑定；这里直接给 workflow 档位）。
            modelRetryBudget: ModelRetryBudget.Unbounded,
            statusSink,
          },
          () => model.generateText({ messages: [{ role: "user", content: "Ping" }] }),
        );
      requests.push(send("workflow_child"));
      for (let tool = 0; tool < TOOL_REQUESTS_PER_ACTOR; tool += 1) {
        requests.push(send("web_search_tool", `tc-${actor}-${tool}`));
      }
    }
    const results = await Promise.allSettled(requests);

    // 无一失败：3008 在 workflow 内是重试，不是终止。
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    expect(concurrencyLimited).toBeGreaterThan(0);
    // 治理器收到了信号：cap 收敛到天花板以下。
    const snapshot = governor.snapshot(key)!;
    expect(snapshot.cap).toBeLessThan(DEFAULT_CONCURRENCY);
    expect(snapshot.inFlight).toBe(0);
    // 每个 3008 都作为可重试失败 + 一条 retry_scheduled{rate_limited} 报出；没有终止型 failed。
    const failed = events.filter((event) => event.type === "model_request_failed");
    expect(failed.length).toBe(concurrencyLimited);
    expect(failed.every((event) => event.retryable === true)).toBe(true);
    const scheduled = events.filter((event) => event.type === "model_retry_scheduled");
    expect(scheduled.length).toBe(concurrencyLimited);
    expect(scheduled.every((event) => event.reason === "rate_limited")).toBe(true);
  });
});

/**
 * 主代理重试参考冷却的闭环（docs/dynamic-workflow/concurrency.md「Where the port is bound」）：
 * 真治理器 observer + 真 adapter runner。别的请求在桶上留下的冷却，主代理的首次请求不看、重试会等；
 * 主代理一个人撞墙时，它自己留下的估计冷却不拉长它自己的下一次重试。
 */
describe("workflow concurrency — 主代理重试参考同桶冷却（真治理器 + 真 runner）", () => {
  const MODEL = { providerId: "prov", modelId: "alpha" };

  function mainAgentHarness(options: {
    failures: number;
    backoffMs: number;
    /** 第几次物理请求返回零输出的空 completion（1 起）。 */
    emptyAt?: number[];
  }) {
    const governor = createWorkflowConcurrencyGovernor({ defaultConcurrency: DEFAULT_CONCURRENCY });
    const calls: number[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        calls.push(Date.now());
        if (options.emptyAt?.includes(calls.length)) {
          return { finishReason: "other", text: "", usage: usage(0) } as never;
        }
        if (calls.length <= options.failures) {
          throw Object.assign(new Error("rate limited"), { isRetryable: true, statusCode: 429 });
        }
        return { text: "ok", finishReason: "stop", usage: usage(1), totalUsage: usage(1) } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      retry: {
        backoffFactor: 1,
        baseDelayMs: options.backoffMs,
        jitter: false,
        maxAttempts: options.failures + 2,
        maxDelayMs: options.backoffMs,
      },
      runtime,
    });
    const model = adapter.createModel({
      ...MODEL,
      providerConfig: testProviderConfig(MODEL.providerId),
      modelConfig: testModelConfig(),
      options: { maxOutputTokens: 32_000, reasoningLevel: "disabled" },
    });
    const events: ModelNetworkStatusEvent[] = [];
    const sendAsMainAgent = () =>
      runWithModelInvocationContext(
        {
          metadata: { querySource: "main_turn" },
          modelRequestAdmission: governor.observer(),
          statusSink: { publish: (event) => void events.push(event) },
        },
        () => model.generateText({ messages: [{ role: "user", content: "Ping" }] }),
      );
    const retryDelays = () =>
      events.flatMap((event) => (event.type === "model_retry_scheduled" ? [event.delayMs] : []));
    return { governor, calls, events, sendAsMainAgent, retryDelays };
  }

  it("子 agent 的 1302 留下估计冷却：主代理首次请求立刻发出，重试等到冷却结束；子 agent 池的闸门照常开着", async () => {
    const { governor, calls, sendAsMainAgent, retryDelays } = mainAgentHarness({
      failures: 1,
      backoffMs: 5,
    });
    const key = workflowConcurrencyKey(MODEL as never);
    const subagents = governor.sessionSubagents("parent");
    // 一个子 agent 请求撞 1302、没带 Retry-After，它自己的退避是 400ms。
    const subagentTicket = await subagents.acquire({ model: MODEL });
    void subagentTicket.publish({
      type: "model_retry_scheduled",
      reason: "rate_limited",
      delayMs: 400,
      nextAttempt: 2,
      message: "1302",
    } as never);
    expect(governor.snapshot(key)?.cooldownUntil).toBeUndefined();

    const startedAt = Date.now();
    await sendAsMainAgent();

    // 首次请求不看冷却。
    expect(calls[0]! - startedAt).toBeLessThan(50);
    // 重试等的是剩余冷却（约 400ms），不是 5ms 的本地退避。
    const [delay] = retryDelays();
    expect(delay).toBeGreaterThan(300);
    expect(delay).toBeLessThanOrEqual(400);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(delay! - 10);
    // 估计冷却只给主代理：控制器没有冷却，子 agent 池的快路径照常命中。
    expect(governor.snapshot(key)?.cooldownUntil).toBeUndefined();
    const again = subagents.tryAcquire!({ model: MODEL });
    expect(again).toBeDefined();
    again!.release();
  });

  it("主代理一个人撞墙：重试等待与本地退避逐次相同，自己的估计冷却不拉长自己", async () => {
    const backoffMs = 40;
    const { retryDelays, sendAsMainAgent } = mainAgentHarness({ failures: 3, backoffMs });
    await sendAsMainAgent();
    expect(retryDelays()).toEqual([backoffMs, backoffMs, backoffMs]);
  });

  it("空 completion 重试同样等到同桶冷却结束（第二次物理请求不早于冷却）", async () => {
    const { governor, calls, sendAsMainAgent, retryDelays } = mainAgentHarness({
      failures: 0,
      backoffMs: 5,
      emptyAt: [1],
    });
    const subagentTicket = await governor.sessionSubagents("parent").acquire({ model: MODEL });
    void subagentTicket.publish({
      type: "model_retry_scheduled",
      reason: "rate_limited",
      delayMs: 400,
      nextAttempt: 2,
      message: "1302",
    } as never);

    await sendAsMainAgent();

    expect(calls).toHaveLength(2);
    const [delay] = retryDelays();
    expect(delay).toBeGreaterThan(300);
    expect(delay).toBeLessThanOrEqual(400);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(delay! - 10);
  });

  it("空 completion 重试不改治理器信号：仍按 ended 结算，成功 streak 不被清掉，在飞归零", async () => {
    const { governor, sendAsMainAgent } = mainAgentHarness({
      failures: 0,
      backoffMs: 5,
      emptyAt: [2],
    });
    const key = workflowConcurrencyKey(MODEL as never);
    await sendAsMainAgent(); // 第 1 次物理请求成功：streak 1
    await sendAsMainAgent(); // 第 2 次空 completion（ended，streak 不动）→ 第 3 次成功：streak 2
    const snapshot = governor.snapshot(key)!;
    expect(snapshot.successStreak).toBe(2);
    expect(snapshot.cap).toBe(DEFAULT_CONCURRENCY);
    expect(snapshot.inFlight).toBe(0);
  });
});
