import type { ZCodeStreamEvent } from "@zcode/shared";

import {
  createBotsServiceHarness,
  createFeishuCallback,
  createFeishuConfig,
  createRecordingFeishuFetch,
  readBotSyntheticFixture,
  type RecordedRequest,
} from "#e2e/bots/helpers/bots-service-harness";

describe("Bot provider interaction E2E", () => {
  const originalFetch = globalThis.fetch;
  const services: Array<ReturnType<typeof createBotsServiceHarness>["service"]> = [];

  afterEach(() => {
    for (const service of services) service.disposeAll();
    services.length = 0;
    globalThis.fetch = originalFetch;
  });

  it("BOT-E2E-AQ-01 keeps multi-select and custom AskUserQuestion answers on one card", async () => {
    const fixture = await readBotSyntheticFixture("feishu-ask-user-question.json");
    expect(fixture).toMatchObject({ caseId: "BOT-E2E-AQ-01", classification: "synthetic" });
    expect(fixture.syntheticReason.length).toBeGreaterThan(20);
    const requests: RecordedRequest[] = [];
    globalThis.fetch = createRecordingFeishuFetch(requests);
    const harness = createBotsServiceHarness({ config: createFeishuConfig() });
    services.push(harness.service);

    await harness.service.handleProviderCallbackResponse(
      "feishu",
      createFeishuCallback("feishu-e2e", "E2E_BOT_ASK_USER_QUESTION"),
    );
    const listener = harness.subscriptions[0]?.listener;
    expect(listener).toBeDefined();
    await listener?.({
      type: "elicitation_request",
      taskId: "task-e2e-bot",
      traceId: "run-e2e-aq",
      requestId: "request-e2e-aq",
      message: "请选择技术方案",
      options: [{ value: "web", label: "纯前端" }],
      questions: [
        {
          question: "请选择技术方案",
          options: [{ value: "web", label: "纯前端" }],
        },
        {
          question: "请选择交付内容",
          options: [
            { value: "tests", label: "测试" },
            { value: "docs", label: "文档" },
          ],
          multiSelect: true,
        },
      ],
    } as ZCodeStreamEvent);

    const token = requests
      .map((request) => request.body ?? "")
      .join("\n")
      .match(/\/elicitation ([a-f0-9]{12}) web/u)?.[1];
    expect(token).toMatch(/^[a-f0-9]{12}$/u);

    const callback = (command: string, formValue?: Record<string, string>) =>
      harness.service.handleProviderCallbackResponse("feishu", {
        botId: "feishu-e2e",
        zcodeFeishuSynchronousCardAction: true,
        event: {
          operator: { operator_id: { open_id: "ou_e2e_user" } },
          action: {
            behaviors: [{ type: "callback", value: { command, zcodeCardText: "Question" } }],
            ...(formValue ? { form_value: formValue } : {}),
          },
          context: { card_update_token: "card-update-token-e2e" },
        },
      });

    const advanced = await callback(`/elicitation ${token} web`);
    const nextToken = advanced.replies[0]?.selection?.token;
    expect(nextToken).toMatch(/^[a-f0-9]{12}$/u);
    await callback(`/elicitation ${nextToken} tests`);
    await callback(`/elicitation ${nextToken} __custom__`);
    const completed = await callback(`/elicitation ${nextToken} __form__:`, { answer: "发布说明" });

    expect(completed.replies[0]?.elicitation).toMatchObject({
      requestId: "request-e2e-aq",
      status: "completed",
    });
    expect(harness.respondElicitationCalls).toEqual([
      expect.objectContaining({
        taskId: "task-e2e-bot",
        runId: "run-e2e-aq",
        requestId: "request-e2e-aq",
        content: expect.objectContaining({
          answers: {
            请选择技术方案: "web",
            请选择交付内容: "tests, 发布说明",
          },
          answer_0: "web",
          answer_1: ["tests", "发布说明"],
        }),
      }),
    ]);
    const interactionPosts = requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url.includes("/open-apis/im/v1/messages?receive_id_type="),
    );
    const interactionUpdates = requests.filter(
      (request) =>
        request.method === "POST" && request.url.includes("/open-apis/interactive/v1/card/update"),
    );
    expect(interactionPosts).toHaveLength(1);
    expect(interactionUpdates).toHaveLength(0);
    expect(
      requests.filter(
        (request) =>
          request.method === "PATCH" && request.url.includes("/open-apis/im/v1/messages/"),
      ),
    ).toHaveLength(0);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    const nextQuestionJson = JSON.stringify(advanced.replies[0]);
    expect(advanced.replies[0]?.elicitation).toMatchObject({
      currentQuestionIndex: 1,
      answers: { "0": ["web"] },
    });
    expect(advanced.replies[0]?.selection?.token).toBe(nextToken);
    expect(nextQuestionJson).toContain("请选择技术方案");
    expect(nextQuestionJson).toContain("请选择交付内容");
    expect(nextQuestionJson).toContain("纯前端");
    const finalJson = JSON.stringify(completed.replies[0]);
    expect(completed.replies[0]?.elicitation?.answers).toEqual({
      "0": ["web"],
      "1": ["tests", "发布说明"],
    });
    expect(finalJson).not.toContain('"command"');
  });

  it("BOT-E2E-IL-01 seals streaming output and retains the completed interaction card", async () => {
    const fixture = await readBotSyntheticFixture("feishu-interaction-card-lifecycle.json");
    expect(fixture).toMatchObject({ caseId: "BOT-E2E-IL-01", classification: "synthetic" });
    const requests: RecordedRequest[] = [];
    globalThis.fetch = createRecordingFeishuFetch(requests);
    const harness = createBotsServiceHarness({ config: createFeishuConfig() });
    services.push(harness.service);

    await harness.service.handleProviderCallbackResponse(
      "feishu",
      createFeishuCallback("feishu-e2e", "E2E_BOT_INTERACTION_CARD_LIFECYCLE"),
    );
    const listener = harness.subscriptions[0]?.listener;
    expect(listener).toBeDefined();
    await listener?.({
      type: "agent_message_chunk",
      taskId: "task-e2e-bot",
      traceId: "run-e2e-il-before",
      content: "交互前的普通输出",
    } as ZCodeStreamEvent);
    await listener?.({
      type: "elicitation_request",
      taskId: "task-e2e-bot",
      traceId: "run-e2e-il-plan",
      requestId: "request-e2e-il-plan",
      message: "Review this implementation plan.",
      options: [{ value: "approve", label: "Approve" }],
      schema: {
        interaction: "plan_approval",
        plan: "# 完整计划\n\n执行生命周期调整。",
      },
    } as ZCodeStreamEvent);

    const token = requests
      .map((request) => request.body ?? "")
      .join("\n")
      .match(/\/elicitation ([a-f0-9]{12}) approve/u)?.[1];
    expect(token).toMatch(/^[a-f0-9]{12}$/u);
    await harness.service.handleProviderCallbackResponse("feishu", {
      botId: "feishu-e2e",
      event: {
        operator: { operator_id: { open_id: "ou_e2e_user" } },
        action: {
          behaviors: [
            {
              type: "callback",
              value: {
                command: `/elicitation ${token} approve`,
                zcodeCardText: "Review this implementation plan.",
              },
            },
          ],
        },
        context: { card_update_token: "card-update-token-e2e-il" },
      },
    });
    await listener?.({
      type: "agent_message_chunk",
      taskId: "task-e2e-bot",
      traceId: "run-e2e-il-after",
      content: "交互后的新输出",
    } as ZCodeStreamEvent);

    const messagePosts = requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url.includes("/open-apis/im/v1/messages?receive_id_type="),
    );
    expect(messagePosts).toHaveLength(3);
    expect(messagePosts[0]?.body).toContain("交互前的普通输出");
    expect(messagePosts[1]?.body).toContain("完整计划");
    expect(messagePosts[2]?.body).toContain("交互后的新输出");
    expect(messagePosts[2]?.body).not.toContain("完整计划");

    const messagePatches = requests.filter(
      (request) => request.method === "PATCH" && request.url.includes("/open-apis/im/v1/messages/"),
    );
    expect(
      messagePatches.some(
        (request) => request.body?.includes("交互前的普通输出") && !request.body.includes("运行中"),
      ),
    ).toBe(true);
    const interactionUpdates = requests.filter(
      (request) =>
        request.method === "POST" && request.url.includes("/open-apis/interactive/v1/card/update"),
    );
    expect(
      interactionUpdates.some(
        (request) =>
          request.body?.includes("完整计划") && !request.body.includes('\\"tag\\":\\"button\\"'),
      ),
    ).toBe(true);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("BOT-E2E-PV-01 keeps Feishu and Lark OpenAPI domains isolated", async () => {
    const fixture = await readBotSyntheticFixture("feishu-lark-domain-isolation.json");
    expect(fixture).toMatchObject({ caseId: "BOT-E2E-PV-01", classification: "synthetic" });
    expect(fixture.syntheticReason.length).toBeGreaterThan(20);
    const requests: RecordedRequest[] = [];
    globalThis.fetch = createRecordingFeishuFetch(requests);
    for (const provider of ["feishu", "lark"] as const) {
      const harness = createBotsServiceHarness({ config: createFeishuConfig(provider) });
      services.push(harness.service);
      await harness.service.handleProviderCallbackResponse(
        provider,
        createFeishuCallback(`${provider}-e2e`, `E2E_BOT_PROVIDER_DOMAIN_${provider}`),
      );
    }
    const urls = requests.map((request) => request.url);
    expect(urls.some((url) => url.startsWith("https://open.feishu.cn/open-apis/"))).toBe(true);
    expect(urls.some((url) => url.startsWith("https://open.larksuite.com/open-apis/"))).toBe(true);
    expect(
      requests
        .filter((request) => request.url.includes("open.larksuite.com"))
        .every((request) => !request.url.includes("open.feishu.cn")),
    ).toBe(true);
  });
});
