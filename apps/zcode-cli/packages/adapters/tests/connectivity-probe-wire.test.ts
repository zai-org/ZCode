import { streamText } from "ai";
import { describe, expect, it } from "vitest";
import { createStreamTextOptions } from "../src/model/runner-options.js";
import { TestProviderConfigFixture } from "./test-provider-config.js";
import { createTestModelProperties } from "./test-model-format.js";

describe("connectivity probe wire contract", () => {
  it.each([
    { providerId: "api-anthropic", kind: "anthropic" },
    { providerId: "api-chat", kind: "openai-compatible" },
    { providerId: "api-responses", kind: "openai" },
    { providerId: "account:bigmodel-start-plan", kind: "anthropic", accountMode: "start-plan" },
    {
      providerId: "account:bigmodel-individual-coding-plan",
      kind: "anthropic",
      accountMode: "individual-coding-plan",
    },
    {
      providerId: "account:zai-team-coding-plan",
      kind: "anthropic",
      accountMode: "team-coding-plan",
    },
  ] as const)(
    "preserves roles, text and identity for $providerId",
    async ({ providerId, kind, ...scope }) => {
      const requests: Request[] = [];
      const bodies: Record<string, unknown>[] = [];
      const apiKey = `fake-${providerId}`;
      const fixture = new TestProviderConfigFixture(
        {
          env: {},
          providers: {
            [providerId]: { kind, apiKey, baseURL: "https://probe.invalid/v1", ...scope },
          },
        },
        {
          requestSecurityState: {
            createExecution: () => ({
              protectTransport: ({ transport }) => transport,
              take: () => [],
            }),
          },
          // 离线拦截所有请求，包含意外的鉴权/控制面请求；绝不回落真实账号网络。
          transport: async (input, init) => {
            const request = new Request(input, init);
            requests.push(request);
            bodies.push((await request.json()) as Record<string, unknown>);
            return new Response(
              JSON.stringify({
                error: { type: "invalid_request_error", message: "probe captured" },
              }),
              {
                status: 400,
                headers: { "content-type": "application/json" },
              },
            );
          },
        },
      );
      const modelId = "probe-model-unchanged";
      const resolved = fixture.resolve(
        { providerId, modelId },
        { maxOutputTokens: 512, reasoningLevel: "disabled" },
      );
      const result = streamText(
        createStreamTextOptions({
          includeModelIO: false,
          resolved: { ...resolved, properties: createTestModelProperties() },
          request: {
            messages: [
              { role: "system", content: "You are ZCode connectivity probe." },
              { role: "user", content: "hi" },
            ],
          },
          statusContext: {
            providerId,
            modelId,
            providerKind: resolved.providerKind,
            requestId: "probe-wire",
          } as never,
        }),
      );
      const events = [];
      for await (const event of result.fullStream) events.push(event);
      expect(events.some((event) => event.type === "error")).toBe(true);
      expect(requests).toHaveLength(1);
      // 配置名变为api.baseUrl，但SDK仍要求baseURL；不能丢失endpoint回落到默认域名。
      expect(requests[0]?.url).toBe(
        `https://probe.invalid/v1/${kind === "anthropic" ? "messages" : kind === "openai-compatible" ? "chat/completions" : "responses"}`,
      );
      expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
      const body = bodies[0]!;
      expect(body.model).toBe(modelId);
      expect(body.stream).toBe(true);
      expect(body.tools).toBeUndefined();
      const budgetField =
        kind === "openai"
          ? "max_output_tokens"
          : kind === "anthropic"
            ? "max_tokens"
            : "max_completion_tokens";
      expect(body[budgetField]).toBe(512);
      if (kind === "anthropic") {
        expect(body.system).toEqual([{ type: "text", text: "You are ZCode connectivity probe." }]);
        expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
      } else if (kind === "openai-compatible") {
        expect(body.messages).toEqual([
          { role: "system", content: "You are ZCode connectivity probe." },
          { role: "user", content: "hi" },
        ]);
      } else {
        expect(body.input).toEqual([
          { role: "system", content: "You are ZCode connectivity probe." },
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
        ]);
      }
    },
  );
});
