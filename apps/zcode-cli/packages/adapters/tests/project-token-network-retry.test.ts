// project-token-network-retry：冷缓存换证遇到断网/超时时，Host 原先以 headersApplied:false 应答，
// Agent 把 RuntimeHeadersRefreshError 一律视为不可重试，整轮在首次模型尝试前失败
// （反馈 ZCT-2122890271808978944 等，`reason=unknown retryable=false`）。
// 真实链路：AiSdkModelAdapter → runner-stream / runner-generate → resolveModelForAttempt；
// 只替换外部边界：Host 的 refreshRuntimeHeadersBeforeAttempt 端口与模型 runtime。
import { APICallError } from "@ai-sdk/provider";
import { ModelErrorCode, type ModelStatusEvent } from "@zcode/contracts";
import { ZCODE_PROVIDER_PROJECT_TOKEN_NETWORK_ERROR } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import type { AiSdkModelRuntime } from "../src/model/runner.js";
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";

const PROVIDER_ID = "account:bigmodel-individual-coding-plan";
const NETWORK = "project_token_network_error";
const TIMEOUT = "project_token_timeout";
// -32031 是 Agent 把 headersApplied:false 包装成的不可重试错误，见 provider-runtime-headers.ts。
const NOT_APPLIED = -32031;

function hostFailure(message: string, code: number): Error {
  return Object.assign(new Error(message), { code });
}

function refreshFailingTimes(failures: number, message: string, code: number) {
  const attempts: number[] = [];
  return {
    attempts,
    async refresh({ attempt }: { attempt: number }) {
      attempts.push(attempt);
      if (attempts.length <= failures) throw hostFailure(message, code);
      return { headersApplied: true, requestAuth: { apiKey: "project-token" } };
    },
  };
}

function runtime(upstream: { calls: number }): AiSdkModelRuntime {
  return {
    async generateText() {
      upstream.calls += 1;
      return { text: "done", finishReason: "stop", usage: usage(), totalUsage: usage() } as never;
    },
    streamText() {
      upstream.calls += 1;
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", id: "t1", text: "done" };
          yield { type: "finish", finishReason: "stop", totalUsage: usage() };
        })(),
      } as never;
    },
  };
}

function adapterFor(upstream: { calls: number }, maxAttempts: number) {
  return new AiSdkModelAdapter({
    registry: new TestProviderConfigFixture({
      providers: {
        [PROVIDER_ID]: {
          kind: "anthropic",
          apiKey: "initial",
          baseURL: "https://open.bigmodel.cn/api/anthropic",
        },
      },
    }),
    retry: { baseDelayMs: 0, jitter: false, maxAttempts, maxDelayMs: 0 },
    runtime: runtime(upstream),
  });
}

async function runStream(options: {
  maxAttempts: number;
  failures: number;
  message: string;
  code: number;
}) {
  const upstream = { calls: 0 };
  const statusEvents: ModelStatusEvent[] = [];
  const port = refreshFailingTimes(options.failures, options.message, options.code);
  let text = "";
  const error = await (async () => {
    for await (const event of executeAdapterStreamText(adapterFor(upstream, options.maxAttempts), {
      providerId: PROVIDER_ID as never,
      modelId: "GLM-5.3" as never,
      accountMode: "individual-coding-plan",
      messages: [{ role: "user", content: "Ping" }],
      statusSink: { publish: (event) => statusEvents.push(event) },
      refreshRuntimeHeadersBeforeAttempt: port.refresh,
    })) {
      if (event.type === "text_delta") text += event.text;
    }
  })().then(
    () => undefined,
    (caught: unknown) => caught as Error,
  );
  const retries = statusEvents.flatMap((event) =>
    event.type === "model_retry_scheduled" ? [event] : [],
  );
  return { error, port, retries, text, upstream };
}

describe("项目 Token 网络/超时失败复用模型重试预算", () => {
  for (const message of [NETWORK, TIMEOUT]) {
    it(`stream：${message} 按 network_error 退避重试，恢复后本轮成功`, async () => {
      const result = await runStream({
        maxAttempts: 3,
        failures: 2,
        message,
        code: ZCODE_PROVIDER_PROJECT_TOKEN_NETWORK_ERROR,
      });
      expect(result.error).toBeUndefined();
      expect(result.text).toBe("done");
      expect(result.port.attempts).toEqual([1, 2, 3]);
      expect(result.upstream.calls).toBe(1);
      expect(result.retries.map((event) => event.reason)).toEqual([
        "network_error",
        "network_error",
      ]);
      // 界面按 errorCode 选文案；不能借用“正在重新读取请求校验配置”。
      expect(
        result.retries.some(
          (event) => event.errorCode === ModelErrorCode.ModelRequestVerificationConfigNetwork,
        ),
      ).toBe(false);
    });
  }

  it("stream：持续失败用尽既有预算后以原错误码结束，不发模型请求", async () => {
    const result = await runStream({
      maxAttempts: 3,
      failures: 99,
      message: NETWORK,
      code: ZCODE_PROVIDER_PROJECT_TOKEN_NETWORK_ERROR,
    });
    expect(result.error?.message).toBe(NETWORK);
    expect(result.port.attempts).toEqual([1, 2, 3]);
    expect(result.upstream.calls).toBe(0);
    expect(result.retries).toHaveLength(2);
  });

  it("旧应答形态（headersApplied:false）即使文案相同也不自动重试", async () => {
    for (const message of [NETWORK, TIMEOUT]) {
      const result = await runStream({ maxAttempts: 3, failures: 99, message, code: NOT_APPLIED });
      expect(result.error?.message).toBe(message);
      expect(result.port.attempts).toEqual([1]);
      expect(result.retries).toHaveLength(0);
    }
  });

  it("其它换证失败码保持立即失败", async () => {
    for (const message of [
      "project_token_http_503",
      "project_token_http_401",
      "project_token_invalid_response",
      "project_token_scope_invalidated",
    ]) {
      const result = await runStream({ maxAttempts: 3, failures: 99, message, code: NOT_APPLIED });
      expect(result.error?.message).toBe(message);
      expect(result.port.attempts).toEqual([1]);
      expect(result.retries).toHaveLength(0);
    }
  });

  it("generate：同一错误同样按网络错误重试", async () => {
    const upstream = { calls: 0 };
    const port = refreshFailingTimes(1, NETWORK, ZCODE_PROVIDER_PROJECT_TOKEN_NETWORK_ERROR);
    const result = await executeAdapterGenerateText(adapterFor(upstream, 2), {
      providerId: PROVIDER_ID as never,
      modelId: "GLM-5.3" as never,
      accountMode: "individual-coding-plan",
      messages: [{ role: "user", content: "Ping" }],
      refreshRuntimeHeadersBeforeAttempt: port.refresh,
    });
    expect(result.text).toBe("done");
    expect(port.attempts).toEqual([1, 2]);
    expect(upstream.calls).toBe(1);
  });

  it("401 恢复换证断网：并入 network_error 预算，下一次按普通请求重新签发", async () => {
    // 401 恢复的重新签发遇到断网/超时同样是传输故障；Host 已删掉被拒 PAT 的缓存，
    // 下一次尝试不带失败指纹也只会拿到新 PAT。恢复预算已用，不再重复走 401 恢复。
    const scope = "a".repeat(64);
    let modelCalls = 0;
    const statusEvents: ModelStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: new TestProviderConfigFixture({
        providers: {
          [PROVIDER_ID]: {
            kind: "anthropic",
            apiKey: "initial",
            baseURL: "https://open.bigmodel.cn/api/anthropic",
          },
        },
      }),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime: {
        async generateText() {
          modelCalls += 1;
          if (modelCalls === 1)
            throw new APICallError({
              message: "Unauthorized",
              statusCode: 401,
              url: "https://open.bigmodel.cn/api/anthropic",
              requestBodyValues: {},
            });
          return { text: "done", finishReason: "stop", usage: usage(), totalUsage: usage() } as never;
        },
        streamText() {
          throw new Error("not used");
        },
      },
    });
    const calls: { rejected: boolean; expectedScope: boolean }[] = [];
    let recoveryFailed = false;
    const result = await executeAdapterGenerateText(adapter, {
      providerId: PROVIDER_ID as never,
      modelId: "GLM-5.3" as never,
      accountMode: "individual-coding-plan",
      messages: [{ role: "user", content: "Ping" }],
      statusSink: { publish: (event) => statusEvents.push(event) },
      refreshRuntimeHeadersBeforeAttempt: async (input) => {
        calls.push({
          rejected: Boolean(input.rejectedProjectTokenFingerprint),
          expectedScope: Boolean(input.expectedAccountScope),
        });
        if (input.rejectedProjectTokenFingerprint && !recoveryFailed) {
          recoveryFailed = true;
          throw hostFailure(NETWORK, ZCODE_PROVIDER_PROJECT_TOKEN_NETWORK_ERROR);
        }
        return {
          headersApplied: true,
          requestAuth: { apiKey: `pat-${calls.length}`, accountScope: scope },
        };
      },
    });
    expect(result.text).toBe("done");
    expect(calls).toEqual([
      { rejected: false, expectedScope: false },
      { rejected: true, expectedScope: true },
      { rejected: false, expectedScope: false },
    ]);
    expect(modelCalls).toBe(2);
    expect(
      statusEvents.flatMap((event) => (event.type === "model_retry_scheduled" ? [event.reason] : [])),
    ).toContain("network_error");
  });

  it("退避等待中取消：不再换证，也不发模型请求", async () => {
    const upstream = { calls: 0 };
    const controller = new AbortController();
    const attempts: number[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: new TestProviderConfigFixture({
        providers: {
          [PROVIDER_ID]: {
            kind: "anthropic",
            apiKey: "initial",
            baseURL: "https://open.bigmodel.cn/api/anthropic",
          },
        },
      }),
      // 首次失败后进入 60 秒退避；取消必须立即结束，而不是等到下一次换证。
      retry: { baseDelayMs: 60_000, jitter: false, maxAttempts: 3, maxDelayMs: 60_000 },
      runtime: runtime(upstream),
    });
    const request = executeAdapterGenerateText(adapter, {
      providerId: PROVIDER_ID as never,
      modelId: "GLM-5.3" as never,
      accountMode: "individual-coding-plan",
      messages: [],
      abortSignal: controller.signal,
      statusSink: {
        publish: (event) => {
          if (event.type === "model_retry_scheduled") controller.abort();
        },
      },
      refreshRuntimeHeadersBeforeAttempt: async ({ attempt }) => {
        attempts.push(attempt);
        throw hostFailure(NETWORK, ZCODE_PROVIDER_PROJECT_TOKEN_NETWORK_ERROR);
      },
    });
    await expect(request).rejects.toThrow();
    expect(attempts).toEqual([1]);
    expect(upstream.calls).toBe(0);
  });
});

function usage() {
  return {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    inputTokenDetails: {
      noCacheTokens: 1,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: { textTokens: 1, reasoningTokens: undefined },
  };
}
