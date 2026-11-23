import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "./artifacts.mjs";
import {
  assertCondition,
  assertProviderCapture,
  buildCaseResult,
  buildRuntimeConfig,
  createApp,
  makeCaseDirs,
  writeProviderConfig,
} from "./case-utils.mjs";
import { FAKE_MODEL } from "./constants.mjs";
import {
  chatCompletion,
  startScriptedProvider,
  stopScriptedProvider,
} from "./scripted-provider.mjs";
import { prepareWorkspace } from "./workspace.mjs";
import {
  assistantContents,
  captureDurableAssistantHistory,
  captureDurableContinueCount,
  captureRuntimeHistory,
} from "./output-token-continuation-history.mjs";

const CASE_NAME = "output-token-continuation";
const OUTPUT_TOKEN_CONTINUE_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";
const OUTPUT_TOKEN_LIMIT_ERROR = "The model's response exceeded the output token maximum.";
const SUCCESS_PARTIAL = "OUTPUT_CONTINUE_E2E_PARTIAL";
const SUCCESS_DONE = "OUTPUT_CONTINUE_E2E_DONE";
const COLD_DONE = "OUTPUT_CONTINUE_E2E_COLD_DONE";
const AFTER_ERROR_DONE = "OUTPUT_CONTINUE_E2E_AFTER_ERROR_DONE";
const SCENARIOS = ["success", "exhausted"];
const CONTEXT_WINDOW = 100_000;
const MAX_OUTPUT_TOKENS = 16_000;

export const outputTokenContinuationCase = {
  name: CASE_NAME,
  requiresApiKey: false,
  async run(input) {
    const scenarioResults = [];
    for (const scenario of SCENARIOS) {
      scenarioResults.push(
        await runScenario({
          ...input,
          caseRoot: join(input.caseRoot, scenario),
          scenario,
        }),
      );
    }

    const artifactsDir = `${input.artifactsRoot}/cases/${CASE_NAME}`;
    const capturePath = `${artifactsDir}/capture.json`;
    const eventsPath = `${artifactsDir}/events.json`;
    const resultPath = `${artifactsDir}/result.json`;
    await mkdir(artifactsDir, { recursive: true });
    await writeJsonFile(capturePath, {
      case: CASE_NAME,
      scenarios: scenarioResults.map((result) => ({
        name: result.scenario,
        records: result.records,
      })),
    });
    await writeJsonFile(eventsPath, {
      case: CASE_NAME,
      scenarios: scenarioResults.map((result) => ({
        events: result.events,
        name: result.scenario,
      })),
    });
    const result = buildCaseResult({
      capturedProviderRequestCount: scenarioResults.reduce(
        (total, scenario) => total + scenario.records.length,
        0,
      ),
      caseName: CASE_NAME,
      capturePath,
      events: scenarioResults.flatMap((scenario) => scenario.events),
      eventsPath,
      response: scenarioResults.map((scenario) => scenario.response).join("\n"),
      resultPath,
      traceId: scenarioResults.at(-1)?.traceId,
    });
    await writeJsonFile(resultPath, {
      ...result,
      scenarios: scenarioResults.map(
        ({ events: _events, records: _records, ...scenario }) => scenario,
      ),
    });
    return result;
  },
};

async function runScenario(input) {
  const scenarioName = `${CASE_NAME}-${input.scenario}`;
  const paths = await makeCaseDirs({ ...input, caseName: scenarioName });
  const events = [];
  let app;
  let provider;
  try {
    await prepareWorkspace({ fixtureDir: input.fixtureDir, workspace: paths.workspace });
    provider = await startScriptedProvider({
      handler: createScenarioHandler(input.scenario),
      name: scenarioName,
    });
    await writeProviderConfig(paths.configPath, {
      apiKeyRequired: false,
      baseURL: provider.baseURL,
      contextWindow: CONTEXT_WINDOW,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      model: FAKE_MODEL,
      providerId: "output-continuation-e2e-fake",
      providerName: "Output Continuation E2E Provider",
      storageDir: paths.storageDir,
    });
    const runtimeConfig = {
      ...buildRuntimeConfig({
        compact: { enabled: false, microcompact: { enabled: false } },
        maxTurns: 12,
        workspace: paths.workspace,
      }),
      titleGeneration: { enabled: false },
    };
    // Bug 根因：createApp 已异步化，漏 await 会在第一条 provider 请求前直接失败。
    app = await createApp({
      configPath: paths.configPath,
      modules: input.modules,
      runtimeConfig,
      storageDir: paths.storageDir,
    });

    const scenarioResult =
      input.scenario === "success"
        ? await runSuccessScenario({
            app,
            events,
            input,
            paths,
            provider,
            runtimeConfig,
          })
        : await runExhaustedScenario({
            app,
            events,
            input,
            paths,
            provider,
            runtimeConfig,
          });
    assertProviderCapture(provider.records);
    await writeJsonFile(paths.capturePath, { records: provider.records, scenario: input.scenario });
    await writeJsonFile(paths.eventsPath, events);
    return {
      ...scenarioResult,
      events,
      records: provider.records,
      scenario: input.scenario,
    };
  } catch (error) {
    await writeJsonFile(paths.capturePath, {
      error: error instanceof Error ? error.message : String(error),
      records: provider?.records ?? [],
      scenario: input.scenario,
    });
    await writeJsonFile(paths.eventsPath, events);
    throw error;
  } finally {
    await app?.close?.();
    await stopScriptedProvider(provider);
  }
}

async function runSuccessScenario({ app, events, input, paths, provider, runtimeConfig }) {
  const result = await app.submitPrompt("Run successful output continuation.", {
    onEvent: async (event) => events.push(event),
  });
  const firstTurnRecords = [...provider.records];
  const runtimeHistory = captureRuntimeHistory(app);
  const durableHistory = await captureDurableAssistantHistory(app);

  assertCondition(
    result.response === SUCCESS_DONE,
    "successful chain must return only final text",
    {
      response: result.response,
    },
  );
  assertContinueRequestSequence(firstTurnRecords);
  assertRecordedContinueMatchesRequests(events, input.modules.SessionEventType, firstTurnRecords);
  // Continue 按隐藏提醒记录写库：三次续写各一条。
  assertCondition(
    (await captureDurableContinueCount(app)) === 3,
    "each Continue must be persisted as a hidden reminder row",
  );
  assertCondition(
    assistantContents(runtimeHistory).join("|") === `${SUCCESS_PARTIAL}|${SUCCESS_DONE}`,
    "only real partial and final assistants may enter runtime history",
    { runtimeHistory },
  );
  assertCondition(
    durableHistory.map((message) => message.content).join("|") ===
      `${SUCCESS_PARTIAL}|${SUCCESS_DONE}`,
    "only real partial and final assistants may enter durable history",
    { durableHistory },
  );

  const sessionId = app.sessionId;
  await app.close?.();
  let resumedApp;
  try {
    resumedApp = await createApp({
      configPath: paths.configPath,
      modules: input.modules,
      resume: true,
      runtimeConfig,
      sessionId,
      storageDir: paths.storageDir,
    });
    await resumedApp.resume?.();
    // 恢复成功必须同时证明身份和历史，避免新建空 session 也满足下面的前缀断言。
    assertCondition(
      resumedApp.sessionId === sessionId,
      "cold App must retain the original session",
    );
    assertCondition(
      assistantContents(captureRuntimeHistory(resumedApp)).join("|") ===
        `${SUCCESS_PARTIAL}|${SUCCESS_DONE}`,
      "cold App must restore the original partial and final assistants before the next prompt",
    );
    const coldResult = await resumedApp.submitPrompt("Cold follow-up after output continuation.", {
      onEvent: async (event) => events.push(event),
    });
    const coldRequest = parseRecordBody(provider.records.at(-1));

    assertCondition(coldResult.response === COLD_DONE, "cold follow-up must complete normally");
    // 冷恢复后的第一个请求以重启前最后一个请求为前缀（含三条 Continue），缓存断点不算内容。
    const lastLive = parseRecordBody(firstTurnRecords.at(-1));
    assertCondition(
      JSON.stringify(
        withoutCacheControl(coldRequest.messages?.slice(0, lastLive.messages?.length)),
      ) === JSON.stringify(withoutCacheControl(lastLive.messages)),
      "cold follow-up request must start with the last live request",
      { cold: coldRequest.messages, live: lastLive.messages },
    );
    assertCondition(
      countContinuePrompts(coldRequest) === 3,
      "cold follow-up request must replay the three persisted Continue messages",
      { messages: coldRequest.messages },
    );
    assertCondition(
      JSON.stringify(coldRequest.messages ?? []).includes(
        "Cold follow-up after output continuation.",
      ),
      "cold follow-up request must include the new real user input",
    );
    return { response: coldResult.response, traceId: coldResult.traceId };
  } finally {
    await resumedApp?.close?.();
  }
}

async function runExhaustedScenario({ app, events, input, paths, provider, runtimeConfig }) {
  const { SessionEventType } = input.modules;
  let terminalError;
  try {
    await app.submitPrompt("Exhaust output continuation.", {
      onEvent: async (event) => events.push(event),
    });
  } catch (error) {
    terminalError = error;
  }
  const exhaustedHistory = captureRuntimeHistory(app);
  const exhaustedDurableHistory = await captureDurableAssistantHistory(app);

  assertCondition(
    terminalError instanceof Error && terminalError.message === OUTPUT_TOKEN_LIMIT_ERROR,
    "fourth output limit must reject the current Turn with the stable error",
    { error: terminalError instanceof Error ? terminalError.message : terminalError },
  );
  assertCondition(provider.records.length === 4, "exhaustion must not send a fifth request");
  assertContinueRequestSequence(provider.records);
  const exhaustedRuntimeAssistants = exhaustedHistory.filter((entry) => entry.role === "assistant");
  assertCondition(
    exhaustedRuntimeAssistants.length === 0 &&
      exhaustedDurableHistory.length === 1 &&
      exhaustedDurableHistory[0]?.content === "" &&
      exhaustedDurableHistory[0]?.error?.data?.message === OUTPUT_TOKEN_LIMIT_ERROR &&
      exhaustedDurableHistory[0]?.tokens?.input === 0 &&
      exhaustedDurableHistory[0]?.tokens?.output === 0,
    "fully empty exhaustion must persist only the durable assistant error",
    { exhaustedDurableHistory, exhaustedHistory },
  );
  assertRecordedContinueMatchesRequests(events, SessionEventType, provider.records);
  assertCondition(
    events.some((event) => event.type === SessionEventType.TurnError) &&
      !events.some((event) => event.type === SessionEventType.TurnComplete),
    "exhausted Turn must end in TurnError without TurnComplete(success)",
    { eventTypes: events.map((event) => event.type) },
  );

  const sessionId = app.sessionId;
  await app.close?.();
  const resumedApp = await createApp({
    configPath: paths.configPath,
    modules: input.modules,
    resume: true,
    runtimeConfig,
    sessionId,
    storageDir: paths.storageDir,
  });
  try {
    await resumedApp.resume?.({ onEvent: async (event) => events.push(event) });
    assertCondition(
      resumedApp.sessionId === sessionId,
      "exhausted App must resume the original session",
    );
    assertCondition(
      captureRuntimeHistory(resumedApp).some(
        (entry) => entry.role === "user" && entry.content.includes("Exhaust output continuation."),
      ),
      "exhausted cold App must restore the original user history",
    );
    const nextResult = await resumedApp.submitPrompt("Continue after the output-limit error.", {
      onEvent: async (event) => events.push(event),
    });
    const nextRequest = parseRecordBody(provider.records.at(-1));
    assertCondition(
      nextResult.response === AFTER_ERROR_DONE,
      "cold runtime must accept the next Turn",
    );
    assertCondition(provider.records.length === 5, "next Turn must issue exactly one new request");
    assertCondition(
      countContinuePrompts(nextRequest) === 3 &&
        !nextRequest.messages?.some((message) => message.role === "assistant"),
      "cold provider history must replay the persisted Continue and exclude the error-only assistant",
      { messages: nextRequest.messages },
    );
    return { response: nextResult.response, traceId: nextResult.traceId };
  } finally {
    await resumedApp.close?.();
  }
}

function createScenarioHandler(scenario) {
  let requestCount = 0;
  return async ({ body }) => {
    assertCondition(
      body?.max_tokens === MAX_OUTPUT_TOKENS,
      "every request must retain the case output budget",
      {
        max_tokens: body?.max_tokens,
      },
    );
    requestCount += 1;
    if (scenario === "success") {
      const responses = [
        { content: "", finishReason: "length" },
        { content: SUCCESS_PARTIAL, finishReason: "length" },
        { content: "", finishReason: "length" },
        { content: SUCCESS_DONE, finishReason: "stop" },
        { content: COLD_DONE, finishReason: "stop" },
      ];
      const response = responses[requestCount - 1];
      if (!response) throw new Error(`Unexpected success request ${requestCount}`);
      return { body: chatCompletion({ ...response, model: body?.model }) };
    }
    if (requestCount <= 4) {
      return {
        body: chatCompletion({
          completionTokens: 0,
          content: "",
          finishReason: "length",
          model: body?.model,
        }),
      };
    }
    if (requestCount === 5) {
      return { body: chatCompletion({ content: AFTER_ERROR_DONE, model: body?.model }) };
    }
    throw new Error(`Unexpected exhausted request ${requestCount}`);
  };
}

function assertContinueRequestSequence(records) {
  assertCondition(records.length === 4, "recovery chain must contain exactly four requests", {
    requestCount: records.length,
  });
  const counts = records.map((record) => countContinuePrompts(parseRecordBody(record)));
  assertCondition(
    JSON.stringify(counts) === JSON.stringify([0, 1, 2, 3]),
    "requests 1-4 must contain 0/1/2/3 exact Continue messages",
    { counts },
  );
}

// ModelRequest 事件与实际请求是同一份消息：每个事件记录的 Continue 条数与对应 HTTP 请求相同。
function assertRecordedContinueMatchesRequests(events, SessionEventType, records) {
  const recorded = events
    .filter((event) => event.type === SessionEventType.ModelRequest)
    .map((event) => countContinuePrompts(event.payload));
  const sent = records.map((record) => countContinuePrompts(parseRecordBody(record)));
  assertCondition(
    JSON.stringify(recorded) === JSON.stringify(sent),
    "ModelRequest events must record the same Continue messages as the HTTP requests",
    { recorded, sent },
  );
}

function withoutCacheControl(value) {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, withoutCacheControl(item)]),
  );
}

function countContinuePrompts(body) {
  return JSON.stringify(body?.messages ?? []).split(OUTPUT_TOKEN_CONTINUE_PROMPT).length - 1;
}

function parseRecordBody(record) {
  try {
    return JSON.parse(record?.requestBody ?? "{}");
  } catch {
    return {};
  }
}
