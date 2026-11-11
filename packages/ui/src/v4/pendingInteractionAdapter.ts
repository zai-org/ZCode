import type {
  ZCodePermissionOption,
  ZCodePermissionRequest,
  ZCodePermissionResponse,
  ZCodeElicitationRequest,
} from "@zcode/shared";
import {
  PERMISSION_FULL_ACCESS_OPTION_ID,
  type PendingInteraction,
  type PermissionRequestPayload,
  type UserInputRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";

const LEGACY_PERMISSION_RULE_INPUT_KEYS = [
  "command",
  "url",
  "file_path",
  "path",
  "pattern",
] as const;

function permissionKindToResponse(
  kind: string,
  payload: PermissionRequestPayload,
): ZCodePermissionResponse {
  if (kind === "deny" || kind === "rejectOnce" || kind === "rejectAlways") {
    return { decision: "deny" };
  }
  if (kind === "allowAlways") {
    const detail =
      typeof payload.detail === "object" && payload.detail !== null
        ? (payload.detail as Record<string, unknown>)
        : {};
    const ruleContent = LEGACY_PERMISSION_RULE_INPUT_KEYS.map((key) => detail[key]).find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    // 旧 v4 snapshot 的 option 没有 response；若只回退 allow，项目级授权会
    // 丢失持久规则。兼容路径只生成原始 exact，不在 UI 重算 CLI 的 AST prefix。
    return {
      decision: "allow",
      permissionUpdates: [
        {
          behavior: "allow",
          rules: [
            {
              toolName: payload.toolName,
              ...(ruleContent ? { ruleContent } : {}),
            },
          ],
          type: "addRules",
        },
      ],
    };
  }
  return { decision: "allow" };
}

/** v4 permission payload → 旧 PermissionDialog 可消费的 ZCodePermissionRequest。 */
export function pendingPermissionToLegacyRequest(
  sessionId: string,
  interaction: PendingInteraction & { payload: PermissionRequestPayload },
): ZCodePermissionRequest {
  const { payload } = interaction;
  // 自主模式的危险请求仍给旧端两个普通选项；新版单独呈现显式切换动作。
  const switchOption =
    payload.fullAccessOption ??
    (payload.modeSwitch === "fullAccessOnly"
      ? {
          optionId: PERMISSION_FULL_ACCESS_OPTION_ID,
          label: "Full access",
          kind: "custom" as const,
          response: { decision: "deny" as const },
        }
      : undefined);
  const advertisedOptions = switchOption ? [...payload.options, switchOption] : payload.options;
  const options: ZCodePermissionOption[] = advertisedOptions.map((option) => ({
    optionId: option.optionId,
    kind: option.kind,
    name: option.label,
    response: option.response ?? permissionKindToResponse(option.kind, payload),
  }));

  return {
    type: "permission_request",
    taskId: sessionId,
    traceId: sessionId,
    requestId: interaction.interactionId,
    description: payload.summary,
    kind: payload.toolName,
    title: payload.toolName,
    options,
    ...(payload.freeText ? { freeText: true } : {}),
    // V4 permission 的 subagent 来源已经存在于 pendingInteraction，
    // 旧适配器漏传后 PermissionDialog 无法展示来源，用户会误以为是主 Agent 在申请权限。
    ...(payload.origin ? { origin: payload.origin } : {}),
    // 工具自报的确认预览走独立的 display 通道，不塞进 raw/detail：detail 的形状被所有
    // 工具的预览解析共用，改一处会波及全部权限弹窗。
    ...(payload.display ? { display: payload.display } : {}),
    raw: payload.detail ?? {
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
    },
  };
}

export interface V4UserInputViewModel {
  interactionId: string;
  prompt: string;
  freeText: boolean;
  sensitive?: boolean;
  options: ReadonlyArray<{ optionId: string; label: string }>;
}

export function pendingUserInputToViewModel(
  interaction: PendingInteraction & { payload: UserInputRequestPayload },
): V4UserInputViewModel {
  return {
    interactionId: interaction.interactionId,
    prompt: interaction.payload.prompt,
    freeText: interaction.payload.freeText,
    sensitive: interaction.payload.sensitive,
    options: interaction.payload.options ?? [],
  };
}

export function pendingUserInputToElicitationRequest(
  sessionId: string,
  interaction: PendingInteraction & { payload: UserInputRequestPayload },
): ZCodeElicitationRequest | null {
  const { payload } = interaction;
  if (!payload.questions || payload.questions.length === 0) {
    return null;
  }
  const firstQuestion = payload.questions[0];
  return {
    type: "elicitation_request",
    taskId: sessionId,
    traceId: payload.traceId ?? sessionId,
    requestId: interaction.interactionId,
    message: firstQuestion?.question ?? payload.prompt,
    header: firstQuestion?.header,
    options: firstQuestion?.options ?? [],
    ...(firstQuestion?.multiSelect ? { multiSelect: true } : {}),
    questions: payload.questions,
    ...(payload.currentQuestionIndex !== undefined
      ? { currentQuestionIndex: payload.currentQuestionIndex }
      : {}),
    ...(payload.answerDrafts ? { answerDrafts: payload.answerDrafts } : {}),
    ...(payload.origin ? { origin: payload.origin } : {}),
    schema: payload.schema ?? payload.input,
  };
}
