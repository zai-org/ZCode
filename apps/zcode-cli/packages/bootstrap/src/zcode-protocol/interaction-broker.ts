import { randomUUID } from "node:crypto";
import { raceClientRequestWithV4Interaction } from "./interaction-response-race.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  CoreErrorType,
  createCoreError,
  AskUserQuestionInputSchema,
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SessionEventType,
  createEventId,
  type AskUserQuestion,
  type McpElicitationRequest,
  type McpElicitationResult,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionBrokerRequestOptions,
  type PermissionBrokerResult,
  type SessionEvent,
} from "@zcode/contracts";
import {
  MCP_ELICITATION_INTERACTION,
  MCP_ELICITATION_TOOL_NAME,
  mcpElicitationContentFromAnswers,
  mcpElicitationQuestions,
} from "../zcode-protocol-v4/mcp-elicitation.js";
import {
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  zcodePermissionResponseSchema,
  zcodeProtocolMethods,
  zcodeUserInputResponseSchema,
  type ZCodePermissionOption,
  type ZCodePermissionResponse,
  type ZCodeUserInputQuestion,
  type ZCodeUserInputResponse,
} from "@zcode/shared";
import type {
  V4InteractionAnswer,
  V4InteractionRegistrationOptions,
} from "../zcode-protocol-v4/interaction-registry.js";
import {
  PROTOCOL_CLIENT_REQUEST_ERROR_CODES,
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";
import {
  buildProtocolPermissionOptions,
  buildSessionPermissionUpdates,
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
  toLegacyPermissionOptionsPolicy,
  buildPermissionDeniedContent,
  PERMISSION_DENIED_BY_USER_CONTENT,
} from "./permission-options.js";
import { withWorkflowSettingsAdjustment } from "./workflow-settings-answer.js";

const EXIT_PLAN_MODE_APPROVAL_QUESTION = "Review this implementation plan.";
const EXIT_PLAN_MODE_APPROVAL_APPROVE = "approve";
const INTERACTION_REQUEST_REANNOUNCE_INTERVAL_MS = 1_000;

interface RegisteredRequestOptions extends PermissionBrokerRequestOptions {
  onRegistered?: () => void;
}

export function createProtocolInteractionBroker(
  context: ZCodeProtocolAgentServerContext,
): PermissionBrokerPort {
  return {
    requestPermission(request, options) {
      const ready = Promise.withResolvers<void>();
      const registeredOptions = { ...options, onRegistered: () => ready.resolve() };
      const requestResult =
        request.toolName === ASK_USER_QUESTION_TOOL_NAME
          ? requestUserInput(context, request, registeredOptions)
          : request.toolName === EXIT_PLAN_MODE_TOOL_NAME
            ? requestExitPlanModeApproval(context, request, registeredOptions)
            : requestPermission(context, request, registeredOptions);
      const result = requestResult.catch((error: unknown) => {
        // 协议错误只在适配层翻译；core 不识别传输错误码，也不能把基础设施故障当用户拒绝。
        if (request.mode === "guarded" && error instanceof ProtocolRequestError) {
          const type =
            error.code === PROTOCOL_CLIENT_REQUEST_ERROR_CODES.cancelled
              ? CoreErrorType.ToolCancelled
              : error.code === PROTOCOL_CLIENT_REQUEST_ERROR_CODES.timedOut
                ? CoreErrorType.PermissionTimeout
                : error.code === PROTOCOL_CLIENT_REQUEST_ERROR_CODES.noClientAttached
                  ? CoreErrorType.ConfigurationError
                  : CoreErrorType.ToolExecutionFailed;
          throw createCoreError(type, error.message, { cause: error, recoverable: true });
        }
        throw error;
      });
      void result.then(
        () => ready.resolve(),
        (error: unknown) => ready.reject(error),
      );
      // 旧调用方只消费 result；它们不观察登记信号时也不能产生未处理拒绝。
      void ready.promise.catch(() => {});
      return Object.assign(result, { registered: ready.promise });
    },
  };
}

async function requestPermission(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: RegisteredRequestOptions,
): Promise<PermissionBrokerResult> {
  const permissionOptions = buildProtocolPermissionOptions(request);
  // v3 反向 RPC 的选项列表：会话免确认只在 v4 投放（旧桌面回传 response 原文，认不出会话语义）。
  const legacyPermissionOptions = buildProtocolPermissionOptions({
    ...request,
    optionsPolicy: toLegacyPermissionOptionsPolicy(request.optionsPolicy),
  });
  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestPermission,
        {
          input: request.input,
          reason: request.reason,
          requestId: request.requestId,
          riskLevel: request.riskLevel,
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          options: legacyPermissionOptions,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodePermissionResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 answer → ZCodePermissionResponse：optionId 语义来自 v4 reducer 合成的
    // allowOnce/allowAlways/deny（见 product-projection onPermissionRequested）。
    (answer) => {
      // 工作流确认窗里调整过的设置随放行应答一起走（docs/dynamic-workflow/launch.md
      // 「Adjusting the settings in the window」）。
      const base = v4AnswerToPermissionResponse(answer, permissionOptions, request.toolName);
      const response = withWorkflowSettingsAdjustment(base, answer, request.toolName);
      return response.decision === "deny" && answer.freeText?.trim()
        ? { ...response, preserveReasonFormatting: true }
        : response;
    },
    {
      ...createInteractionRegistrationOptions(request, "other"),
      ...(!request.origin &&
      !request.optionsPolicy &&
      options?.claimResponse &&
      context.deps?.sessionStore?.commitPermissionFullAccess
        ? {
            fullAccess: async (mode) => {
              if (request.approvalMode === "user-once" && mode !== "yolo")
                throw new Error("Already in autonomous mode");
              if (!options.claimResponse!()) throw new Error("Permission response already settled");
              options.signal?.throwIfAborted();
              const record = context.sessions.get(String(request.sessionId));
              if (!record) throw new Error("Permission session unavailable");
              const eventId = await record.app.runtime.grantPermissionMode(
                request.requestId,
                mode,
                options.signal,
              );
              await context.v4Gateway?.waitForPermissionGrantCommit(
                String(request.sessionId),
                eventId,
              );
            },
          }
        : {}),
    },
    options?.onRegistered,
  );
  return {
    ...response,
    // 兼容原因：legacy 客户端允许省略 reason；普通用户拒绝仍需向模型明确工具未执行，
    // 否则 core 会回退为通用的 `Permission denied for <tool>`，无法阻止绕过式尝试。
    ...(response.decision === "deny" && !response.reason?.trim()
      ? { reason: PERMISSION_DENIED_BY_USER_CONTENT }
      : {}),
    resolvedAt: new Date(),
  };
}

/**
 * v4 permission 应答映射：优先按 optionId 精确匹配 buildProtocolPermissionOptions
 * 合成的选项（allow_project 携带 permissionUpdates 持久化规则，不能丢）；投影侧
 * 合成的 allowAlways 语义等价 allow_project。未知 optionId 按 deny 兜底——权限
 * 语义下宁可拒绝也不放行未知应答。
 *
 * workflow Refine：该选项只在 v4 投影
 * 合成、不进 legacy 选项列表，所以在精确匹配之前特判。freeText 为空、或非
 * CreateWorkflow 工具伪造该 optionId，都落到既有 deny 兜底且不带 reasonSource——
 * 反馈升级为 user message 的通道必须只对真实用户输入开放。
 */
function v4AnswerToPermissionResponse(
  answer: V4InteractionAnswer,
  permissionOptions: ZCodePermissionOption[],
  toolName: string,
): ZCodePermissionResponse & {
  reasonSource?: PermissionBrokerResult["reasonSource"];
  sessionPermissionUpdates?: PermissionBrokerResult["sessionPermissionUpdates"];
} {
  const refineFeedback = answer.freeText?.trim();
  if (
    (toolName === CREATE_WORKFLOW_TOOL_NAME || toolName === AMEND_WORKFLOW_TOOL_NAME) &&
    answer.optionId === WORKFLOW_REFINE_PERMISSION_OPTION_ID &&
    refineFeedback
  ) {
    return {
      decision: "deny",
      reason: refineFeedback,
      reasonSource: "workflow_refine_feedback",
    };
  }
  const exact = permissionOptions.find((option) => option.optionId === answer.optionId);
  if (exact) {
    if (exact.kind === "deny") {
      return { decision: "deny", reason: buildPermissionDeniedContent(answer.freeText) };
    }
    // 会话免确认：会话语义在这里合成，而不是放进
    // option.response——wire 上 zcodePermissionUpdateSchema 是 strict，旧桌面多一个字段就丢事件。
    if (exact.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND) {
      return {
        ...exact.response,
        sessionPermissionUpdates: buildSessionPermissionUpdates(toolName),
      };
    }
    return exact.response;
  }
  if (answer.optionId === "allowAlways") {
    const allowAlways = permissionOptions.find((option) => option.kind === "allow_always");
    if (allowAlways) {
      return allowAlways.response;
    }
  }
  if (answer.optionId === "allowOnce") {
    return { decision: "allow", reason: "Approved once" };
  }
  // deny/rejectOnce/rejectAlways、未知 optionId、无 optionId 全部落 deny。
  return { decision: "deny", reason: buildPermissionDeniedContent(answer.freeText) };
}

/**
 * MCP elicitation：server 在工具执行中向用户提问。
 * 复用 AskUserQuestion 的两条通道——旧 RPC interaction/requestUserInput 与 v4 pending interaction——
 * 后者靠合成（不持久化）的 PermissionRequested / PermissionResolved 事件推进投影。
 */
export async function requestMcpElicitation(
  context: ZCodeProtocolAgentServerContext,
  request: McpElicitationRequest,
  options?: { signal?: AbortSignal },
): Promise<McpElicitationResult> {
  const sessionId = request.trace?.sessionId;
  const record = sessionId ? context.sessions?.get(sessionId) : undefined;
  if (!sessionId || !record) {
    // 没有正在执行的工具调用可归属（如 server 在空闲时主动提问）：拒绝而不是猜会话。
    return { action: "decline" };
  }
  const interactionId = `mcp-elicit-${randomUUID()}`;
  const toolCallId = request.trace?.toolCallId ?? interactionId;
  const questions = mcpElicitationQuestions(request.message, request.requestedSchema);
  const input = {
    serverName: request.serverName,
    message: request.message,
    requestedSchema: request.requestedSchema,
  };
  const traceId = request.trace?.traceId ?? String(record.traceContext.traceId);
  const ingestSynthetic = async (
    type: typeof SessionEventType.PermissionRequested | typeof SessionEventType.PermissionResolved,
    payload: Record<string, unknown>,
  ) => {
    const gateway = context.v4Gateway;
    if (!gateway) return;
    const event: SessionEvent = {
      id: createEventId(),
      sessionId: sessionId as never,
      ...(request.trace?.turnId ? { turnId: request.trace.turnId as never } : {}),
      type,
      timestamp: new Date(),
      traceId: traceId as never,
      // 只进 live 投影、不落盘：raw seq 置 0，让 v4 gateway 分配 transport 序号。
      // 若沿用持久化高水位 +1，第二条合成事件会因 seq 不高于游标被当作重放丢弃，pending 永远清不掉。
      sequenceNumber: 0,
      payload: payload as never,
    };
    gateway.ingest(sessionId, event);
  };
  await ingestSynthetic(SessionEventType.PermissionRequested, {
    requestId: interactionId,
    toolCallId,
    toolName: MCP_ELICITATION_TOOL_NAME,
    riskLevel: "low",
    reason: request.message,
    input,
  });
  let response: ZCodeUserInputResponse;
  try {
    response = await raceClientRequestWithV4Interaction(
      context,
      interactionId,
      options?.signal,
      (signal) =>
        context.requestClient(
          zcodeProtocolMethods.interactionRequestUserInput,
          {
            input,
            prompt: request.message,
            questions,
            requestId: interactionId,
            schema: {
              interaction: MCP_ELICITATION_INTERACTION,
              serverName: request.serverName,
              requestedSchema: request.requestedSchema,
            },
            sessionId,
            toolCallId,
            toolName: MCP_ELICITATION_TOOL_NAME,
            ...(request.trace?.turnId ? { turnId: request.trace.turnId } : {}),
          },
          zcodeUserInputResponseSchema,
          withInteractionRequestRecovery(options, signal),
        ),
      (answer) => v4AnswerToUserInputResponse(answer),
      { sessionId, kind: "other" },
    );
  } finally {
    await ingestSynthetic(SessionEventType.PermissionResolved, {
      requestId: interactionId,
      toolCallId,
      decision: "allow",
    }).catch(() => undefined);
  }
  if (response.action !== "accept") return { action: response.action };
  return {
    action: "accept",
    content: mcpElicitationContentFromAnswers(request.requestedSchema, questions, response.content),
  };
}

async function requestUserInput(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: RegisteredRequestOptions,
): Promise<PermissionBrokerResult> {
  const parsed = AskUserQuestionInputSchema.safeParse(request.input);
  if (!parsed.success) {
    return {
      decision: "deny",
      reason: `Invalid AskUserQuestion input: ${
        parsed.error.issues[0]?.message ?? "schema validation failed"
      }`,
      resolvedAt: new Date(),
    };
  }

  const initialAutoResolution = await readPersistedAutoResolution(context, request);

  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestUserInput,
        {
          input: request.input,
          prompt: request.reason,
          questions: parsed.data.questions.map(mapAskUserQuestion),
          requestId: request.requestId,
          schema: { toolName: request.toolName },
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodeUserInputResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 答 AskUserQuestion：freeText/optionId 落到单题 answer 槽位
    // （normalizeAskUserQuestionResponseContent 的 content.answer 兼容路径）；
    // deny 落 decline。多题场景等 v4 投影建模 userInput kind 后再精确映射。
    (answer) => v4AnswerToUserInputResponse(answer),
    createInteractionRegistrationOptions(
      request,
      "askUserQuestion",
      context,
      initialAutoResolution,
    ),
    options?.onRegistered,
  );

  return userInputResponseToBrokerResult(request, response);
}

function v4AnswerToUserInputResponse(answer: V4InteractionAnswer): ZCodeUserInputResponse {
  // answer.action 存在（host adapter respondElicitation 收敛路径）
  // 时按旧 respondUserInput 语义精确直传——content 携带多题 answers/annotations，
  // normalizeAskUserQuestionResponseContent 继续负责 schema 收敛。
  if (answer.action) {
    return answer.action === "accept"
      ? { action: "accept", content: answer.content ?? {} }
      : { action: answer.action };
  }
  const text = answer.freeText?.trim();
  if (text) {
    return { action: "accept", content: { answer: text } };
  }
  if (answer.optionId === "allowOnce" || answer.optionId === "allowAlways") {
    return { action: "accept", content: {} };
  }
  return { action: "decline" };
}

async function requestExitPlanModeApproval(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: RegisteredRequestOptions,
): Promise<PermissionBrokerResult> {
  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestUserInput,
        {
          input: request.input,
          prompt: request.reason,
          questions: [createExitPlanModeApprovalQuestion()],
          requestId: request.requestId,
          schema: { interaction: "plan_approval", toolName: request.toolName },
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodeUserInputResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 答 plan approval：allow 类 optionId = 批准；freeText = 计划反馈
    // （planApprovalResponseToBrokerResult 走 plan_approval_feedback deny）；否则 decline。
    (answer) => v4AnswerToPlanApprovalResponse(answer),
    createInteractionRegistrationOptions(request, "other"),
    options?.onRegistered,
  );

  return planApprovalResponseToBrokerResult(response);
}

function v4AnswerToPlanApprovalResponse(answer: V4InteractionAnswer): ZCodeUserInputResponse {
  // 同 v4AnswerToUserInputResponse——host adapter 收敛路径直传
  // action/content，planApprovalResponseToBrokerResult 继续做 approve/feedback 归一。
  if (answer.action) {
    return answer.action === "accept"
      ? { action: "accept", content: answer.content ?? {} }
      : { action: answer.action };
  }
  if (answer.optionId === "allowOnce" || answer.optionId === "allowAlways") {
    return {
      action: "accept",
      content: { answer: EXIT_PLAN_MODE_APPROVAL_APPROVE },
    };
  }
  const feedback = answer.freeText?.trim();
  if (feedback) {
    return { action: "accept", content: { answer: feedback } };
  }
  return { action: "decline" };
}

function createExitPlanModeApprovalQuestion(): ZCodeUserInputQuestion {
  return {
    header: "Plan",
    options: [
      {
        description: "Exit plan mode and start implementation.",
        label: "Approve",
        value: EXIT_PLAN_MODE_APPROVAL_APPROVE,
      },
    ],
    question: EXIT_PLAN_MODE_APPROVAL_QUESTION,
  };
}

function withInteractionRequestRecovery(
  options: PermissionBrokerRequestOptions | undefined,
  signal: AbortSignal,
): PermissionBrokerRequestOptions & { reannounceIntervalMs: number } {
  return {
    ...options,
    // v4 竞速：内部 signal 已级联外层 options.signal（见 raceClientRequestWithV4Interaction），
    // v4 应答命中时经它取消悬空的反向 RPC。
    signal,
    // 桌面/恢复链路里 UI 可能只从 snapshot 恢复出 pending 交互，
    // 但 host 里原 protocol id 对应的内存登记已丢失。等待用户响应期间按同一业务
    // requestId 重发现有协议请求，让 host 重新登记可响应的 protocolRequestId。
    reannounceIntervalMs: INTERACTION_REQUEST_REANNOUNCE_INTERVAL_MS,
  };
}

function mapAskUserQuestion(question: AskUserQuestion): ZCodeUserInputQuestion {
  return {
    header: question.header,
    multiSelect: question.multiSelect,
    options: question.options.map((option) => ({
      description: option.description,
      label: option.label,
      preview: option.preview,
      value: option.label,
    })),
    question: question.question,
  };
}

function userInputResponseToBrokerResult(
  request: PermissionBrokerRequest,
  response: ZCodeUserInputResponse,
): PermissionBrokerResult {
  if (response.action !== "accept") {
    return {
      decision: "deny",
      reason:
        response.reason ??
        (response.action === "cancel"
          ? "AskUserQuestion was cancelled"
          : "AskUserQuestion was declined"),
      resolvedAt: new Date(),
    };
  }

  const input = isRecord(request.input) ? request.input : {};
  const content = normalizeAskUserQuestionResponseContent(input, response.content);
  return {
    decision: "modify",
    modifiedInput: {
      ...input,
      ...content,
    },
    reason: response.reason,
    resolvedAt: new Date(),
  };
}

function planApprovalResponseToBrokerResult(
  response: ZCodeUserInputResponse,
): PermissionBrokerResult {
  if (response.action !== "accept") {
    return {
      decision: "deny",
      reason: response.reason,
      resolvedAt: new Date(),
    };
  }

  const answer = normalizePlanApprovalAnswer(response.content);
  if (answer === EXIT_PLAN_MODE_APPROVAL_APPROVE) {
    return {
      decision: "allow",
      reason: response.reason,
      resolvedAt: new Date(),
    };
  }

  if (!answer) {
    return {
      decision: "deny",
      reason: response.reason,
      resolvedAt: new Date(),
    };
  }

  return {
    decision: "deny",
    reason: answer,
    reasonSource: "plan_approval_feedback",
    resolvedAt: new Date(),
  };
}

function normalizePlanApprovalAnswer(
  content: Record<string, unknown> | undefined,
): string | undefined {
  if (!content) {
    return undefined;
  }
  const answers = isRecord(content.answers) ? content.answers : {};
  const answer = normalizeAnswerValue(
    answers[EXIT_PLAN_MODE_APPROVAL_QUESTION] ?? content.answer_0 ?? content.answer,
  )?.trim();
  return answer && answer.length > 0 ? answer : undefined;
}

function normalizeAskUserQuestionResponseContent(
  input: Record<string, unknown>,
  content: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!content) {
    return {};
  }

  const normalized: Record<string, unknown> = {};
  const answers = normalizeAskUserQuestionAnswers(input, content);
  if (answers) {
    normalized.answers = answers;
  }

  const annotations = normalizeAskUserQuestionAnnotations(content.annotations);
  if (annotations) {
    normalized.annotations = annotations;
  }

  // UI 为兼容旧单题路径会同时提交 answer_0 / answer。
  // AskUserQuestionInputSchema 是 strict，直接把这些旧字段合并回 tool input 会触发
  // Tool input failed inputSchema validation，所以这里只保留 schema 明确允许的字段。
  return normalized;
}

function normalizeAskUserQuestionAnswers(
  input: Record<string, unknown>,
  content: Record<string, unknown>,
): Record<string, string> | undefined {
  const questionTexts = readAskUserQuestionTexts(input);
  if (questionTexts.length === 0) {
    return undefined;
  }

  const rawAnswers = isRecord(content.answers) ? content.answers : {};
  const answers: Record<string, string> = {};
  questionTexts.forEach((questionText, index) => {
    const rawAnswer =
      rawAnswers[questionText] ??
      content[`answer_${index}`] ??
      (questionTexts.length === 1 ? content.answer : undefined);
    const answer = normalizeAnswerValue(rawAnswer);
    if (answer !== undefined) {
      answers[questionText] = answer;
    }
  });

  // action=accept + content.answers={} 是 runtime 自动继续的显式成功语义；
  // 必须保留空对象，和 content 完全缺失（旧客户端批准但未提供答案）区分。
  if (isRecord(content.answers) && Object.keys(content.answers).length === 0) {
    return {};
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function createInteractionRegistrationOptions(
  request: PermissionBrokerRequest,
  kind: V4InteractionRegistrationOptions["kind"],
  context?: ZCodeProtocolAgentServerContext,
  initialAutoResolution?: V4InteractionRegistrationOptions["initialAutoResolution"],
): V4InteractionRegistrationOptions {
  return {
    sessionId: String(request.sessionId),
    kind,
    ...(initialAutoResolution ? { initialAutoResolution } : {}),
    ...(kind === "askUserQuestion" && context
      ? {
          onAutoResolutionUpdated: async (autoResolution) => {
            const record = context.sessions?.get(String(request.sessionId));
            if (!record) return;
            try {
              await record.app.runtime.recordUserInputAutoResolutionUpdate({
                interactionId: request.requestId,
                toolCallId: request.toolCallId,
                autoResolution,
                traceContext: {
                  ...record.traceContext,
                  traceId: request.traceId,
                  turnId: request.turnId,
                },
              });
            } catch (error) {
              context.logger?.error(
                "Failed to persist user input auto-resolution state",
                error instanceof Error ? error : new Error(String(error)),
                {
                  interactionId: request.requestId,
                  sessionId: request.sessionId,
                },
              );
            }
          },
        }
      : {}),
  };
}

async function readPersistedAutoResolution(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
): Promise<V4InteractionRegistrationOptions["initialAutoResolution"]> {
  const sessionStore = context.deps?.sessionStore;
  if (!sessionStore?.sessionEntries) return undefined;
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: request.sessionId,
      type: SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
    });
    const matching = entries
      .filter((entry) => {
        const data = isRecord(entry.data) ? entry.data : {};
        return (
          data.interactionId === request.requestId &&
          String(data.toolCallId ?? "") === String(request.toolCallId)
        );
      })
      .sort((left, right) => right.time.updated - left.time.updated)[0];
    if (!matching || !isRecord(matching.data)) return undefined;
    return parsePersistedAutoResolution(matching.data.autoResolution);
  } catch (error) {
    context.logger?.warn("Failed to restore user input auto-resolution state", {
      error: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.user_input_auto_resolution_restore_failed",
      interactionId: request.requestId,
      module: "bootstrap.zcode_protocol",
      sessionId: request.sessionId,
    });
    return undefined;
  }
}

function parsePersistedAutoResolution(
  value: unknown,
): V4InteractionRegistrationOptions["initialAutoResolution"] {
  if (!isRecord(value) || typeof value.startedAt !== "number") return undefined;
  if (
    (value.state === "hiddenGrace" || value.state === "visibleCountdown") &&
    typeof value.visibleAt === "number" &&
    typeof value.deadlineAt === "number"
  ) {
    return {
      state: value.state,
      startedAt: value.startedAt,
      visibleAt: value.visibleAt,
      deadlineAt: value.deadlineAt,
    };
  }
  if (value.state === "snoozed" && typeof value.snoozedAt === "number") {
    return {
      state: "snoozed",
      startedAt: value.startedAt,
      snoozedAt: value.snoozedAt,
    };
  }
  return undefined;
}

function readAskUserQuestionTexts(input: Record<string, unknown>): string[] {
  const questions = input.questions;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions
    .map((question) =>
      isRecord(question) && typeof question.question === "string" ? question.question : undefined,
    )
    .filter((question): question is string => question !== undefined);
}

function normalizeAnswerValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    // 旧客户端曾用空字符串表示跳过；统一丢弃 blank，避免其进入
    // answers 后被 core 当作用户偏好。非空答案同时在协议边界去除外围空白。
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0)
      .join(", ");
  }
  return undefined;
}

function normalizeAskUserQuestionAnnotations(
  value: unknown,
): Record<string, { preview?: string; notes?: string }> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([question, annotation]) => {
      if (!isRecord(annotation)) {
        return undefined;
      }
      const normalizedAnnotation = {
        ...(typeof annotation.preview === "string" ? { preview: annotation.preview } : {}),
        ...(typeof annotation.notes === "string" ? { notes: annotation.notes } : {}),
      };
      return Object.keys(normalizedAnnotation).length > 0
        ? ([question, normalizedAnnotation] as const)
        : undefined;
    })
    .filter(
      (entry): entry is readonly [string, { preview?: string; notes?: string }] =>
        entry !== undefined,
    );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
