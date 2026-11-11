import { createBotProjectFixture } from "#e2e/bots/helpers/bots-service-harness";
import { readFile } from "node:fs/promises";

import type { BotsConfigFile, BotsStateFile, ZCodeStreamEvent } from "@zcode/shared";
import { createBotsService } from "@zcode/services/node";
import { createBotModelSelectionView } from "#e2e/bots/helpers/bots-service-harness";
import { resolveE2ERuntimePath } from "#e2e/helpers/e2e-runtime-paths";

const E2E_BOT_WORKSPACE = resolveE2ERuntimePath("bots", "e2e-bot-workspace");

type LifecycleFixture = {
  caseId: string;
  classification: "synthetic";
  syntheticReason: string;
  prompt: string;
  events: Array<Record<string, unknown> & { type: ZCodeStreamEvent["type"] }>;
  expectedTimeline: string[];
  forbiddenCardMarkers: string[];
};

type RecordedRequest = {
  url: string;
  method: string;
  body?: string;
};

const FIXTURE_URL = new URL(
  "../../fixtures/bots/feishu-streaming-card-lifecycle.json",
  import.meta.url,
);

describe("BOT-E2E-SC-01 Feishu streaming card lifecycle", () => {
  const originalFetch = globalThis.fetch;
  let service: ReturnType<typeof createBotsService> | undefined;

  afterEach(() => {
    service?.disposeAll();
    service = undefined;
    globalThis.fetch = originalFetch;
  });

  it("keeps callback, controlled task stream, typing and terminal output on one card", async () => {
    const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as LifecycleFixture;
    expect(fixture.classification).toBe("synthetic");
    expect(fixture.syntheticReason.length).toBeGreaterThan(20);

    const requests: RecordedRequest[] = [];
    globalThis.fetch = createFeishuApiMock(requests);

    let config = createBotConfig();
    let state: BotsStateFile = { version: 3, bots: {} };
    const createTaskCalls: unknown[] = [];
    const sendPromptCalls: unknown[] = [];
    const subscriptions: Array<{
      params: Record<string, unknown>;
      listener: (event: ZCodeStreamEvent) => Promise<void> | void;
    }> = [];

    const zcodeTaskService = {
      listTasks: async () => [],
      createTask: async (params: unknown) => {
        createTaskCalls.push(params);
        return {
          taskId: "task-e2e-bot-streaming-card",
          title: "E2E Bot Streaming Card",
          workspacePath: E2E_BOT_WORKSPACE,
          provider: "glm",
        };
      },
      sendPrompt: async (params: unknown) => {
        sendPromptCalls.push(params);
      },
      setMode: async () => undefined,
      setConfigOption: async () => [],
      setModel: async () => [],
      setAutomationSessionConfig: async () => [],
      getTaskConfigOptions: async () => [],
      getTaskSnapshot: async () => null,
      getTaskTokenUsage: async () => ({
        sessionId: "task-e2e-bot-streaming-card",
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        modelRequestCount: 0,
        modelErrorCount: 0,
        inputBaselineBySource: {},
      }),
      resumeTask: async () => ({
        taskId: "task-e2e-bot-streaming-card",
        title: "E2E Bot Streaming Card",
        workspacePath: E2E_BOT_WORKSPACE,
        provider: "glm",
      }),
      respondPermission: async () => true,
      respondElicitation: async () => true,
      stopGeneration: async () => undefined,
      onDynamicTaskEvent:
        (params: Record<string, unknown>) =>
        (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
          subscriptions.push({ params, listener });
          return { dispose() {} };
        },
      onDynamicStreamEvent: () => () => ({ dispose() {} }),
    };

    service = createBotsService({
      ...createBotProjectFixture([{ workspacePath: E2E_BOT_WORKSPACE }]),
      credentialService: {
        load: async (key: string) => (key === "feishu-secret" ? "app-secret" : null),
        save: async () => undefined,
        delete: async () => undefined,
      },
      zcodeTaskService,
      settingService: {
        get: async () => ({
          locale: "zh-CN",
          recentProjects: [E2E_BOT_WORKSPACE],
          lastWorkspaceSession: [{ kind: "local", workspacePath: E2E_BOT_WORKSPACE }],
          enabledBuiltinAgentCliProviders: ["glm"],
        }),
        update: async () => undefined,
        updateDataBaseDir: async () => undefined,
      },
      repo: {
        readConfig: async () => config,
        writeConfig: async (next: BotsConfigFile) => (config = next),
        readState: async () => state,
        writeState: async (next: BotsStateFile) => (state = next),
        updateContext: async (
          botId: string,
          update: (
            current: BotsStateFile["bots"][string] | undefined,
          ) => BotsStateFile["bots"][string] | undefined,
        ) => {
          const next = update(state.bots[botId]);
          if (next) state.bots[botId] = next;
          else delete state.bots[botId];
          return next;
        },
      },
      modelSelectionService: {
        getView: async () => createBotModelSelectionView(),
      },
      runStartupBackgroundTasks: false,
      warmCandidateCachesOnStartup: false,
    } as never);

    const callbackResult = await service.handleProviderCallbackResponse("feishu", {
      botId: "feishu-e2e",
      event: {
        sender: { sender_id: { open_id: "ou_e2e_user" } },
        message: {
          chat_id: "oc_e2e_private",
          message_id: "om_e2e_inbound",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: fixture.prompt }),
        },
      },
    });

    expect(callbackResult.ok).toBe(true);
    expect(createTaskCalls).toHaveLength(1);
    expect(sendPromptCalls).toHaveLength(1);
    expect(JSON.stringify(sendPromptCalls[0])).toContain(fixture.prompt);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.params).toMatchObject({
      taskId: "task-e2e-bot-streaming-card",
      deliveryKind: "bot-channel-continuous",
    });

    await waitForRequest(
      requests,
      (request) =>
        request.method === "POST" && request.url.endsWith("/messages/om_e2e_inbound/reactions"),
      "Typing reaction creation",
    );

    const listener = subscriptions[0]?.listener;
    expect(listener).toBeDefined();
    for (let index = 0; index < fixture.events.length; index += 1) {
      const event = {
        ...fixture.events[index],
        taskId: "task-e2e-bot-streaming-card",
        traceId: `trace-e2e-bot-${index}`,
      } as ZCodeStreamEvent;
      await listener?.(event);
    }

    await waitForRequest(
      requests,
      (request) => request.method === "DELETE" && request.url.endsWith("/reactions/reaction-e2e"),
      "Typing reaction cleanup",
    );

    const creates = requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url.includes("/open-apis/im/v1/messages?receive_id_type=open_id"),
    );
    const updates = requests.filter(
      (request) => request.method === "PATCH" && request.url.endsWith("/messages/om_e2e_streaming"),
    );
    expect(creates).toHaveLength(1);
    expect(updates.length).toBeGreaterThanOrEqual(2);

    const runningCards = updates
      .map(readCardFromRequest)
      .filter((card) => JSON.stringify(card).includes("工具摘要"));
    expect(
      runningCards.some((card) =>
        readCardElements(card).some(
          (element) => element.tag === "collapsible_panel" && element.expanded === true,
        ),
      ),
    ).toBe(true);

    const finalCard = readCardFromRequest(updates.at(-1));
    const finalElements = readCardElements(finalCard);
    const timeline = finalElements.map((element) =>
      element.tag === "collapsible_panel"
        ? `tools:${String(readPanelTitle(element))}:${String(element.expanded)}`
        : `message:${String(element.content)}`,
    );
    expect(timeline).toEqual(fixture.expectedTimeline);
    expect(
      finalElements
        .filter((element) => element.tag === "collapsible_panel")
        .every((element) => element.expanded === false),
    ).toBe(true);

    const finalCardJson = JSON.stringify(finalCard);
    for (const forbidden of fixture.forbiddenCardMarkers) {
      expect(finalCardJson).not.toContain(forbidden);
    }
  });
});

function createBotConfig(): BotsConfigFile {
  return {
    version: 3,
    bots: [
      {
        id: "feishu-e2e",
        name: "Feishu E2E",
        provider: "feishu",
        enabled: true,
        credentialRef: "feishu-secret",
        feishuAppId: "cli_e2e",
        providerUserId: "ou_e2e_user",
        allowedWorkspaces: ["*"],
        allowedCommands: {
          status: true,
          new: true,
          workspace: true,
          model: true,
          thoughtLevel: true,
          sandboxMode: true,
          approvalPolicy: true,
          reply: true,
        },
        currentOptions: {},
        replyMode: "streaming_card",
      },
    ],
  };
}

function createFeishuApiMock(requests: RecordedRequest[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (url.endsWith("/tenant_access_token/internal")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token-e2e" }));
    }
    if (url.endsWith("/messages/om_e2e_inbound/reactions") && method === "POST") {
      return new Response(JSON.stringify({ code: 0, data: { reaction_id: "reaction-e2e" } }));
    }
    if (url.includes("/open-apis/im/v1/messages?receive_id_type=open_id")) {
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_e2e_streaming" } }));
    }
    if (url.includes("/contact/v3/users/")) {
      return new Response(JSON.stringify({ code: 0, data: { user: { name: "E2E User" } } }));
    }
    return new Response(JSON.stringify({ code: 0 }));
  };
}

async function waitForRequest(
  requests: RecordedRequest[],
  predicate: (request: RecordedRequest) => boolean,
  label: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (requests.some(predicate)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function readCardFromRequest(request: RecordedRequest | undefined): Record<string, unknown> {
  const body = JSON.parse(request?.body ?? "{}") as { content?: string };
  return JSON.parse(body.content ?? "{}") as Record<string, unknown>;
}

function readCardElements(card: Record<string, unknown>): Array<Record<string, unknown>> {
  return (card.body as { elements?: Array<Record<string, unknown>> } | undefined)?.elements ?? [];
}

function readPanelTitle(element: Record<string, unknown>): string | undefined {
  return (element.header as { title?: { content?: string } } | undefined)?.title?.content;
}
