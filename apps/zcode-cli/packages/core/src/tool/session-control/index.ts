import { z } from "zod";
import * as schemas from "@zcode/session-control/contracts";
import type { ToolEntry, ToolExecutionContext } from "../types.js";
export type { SessionControlBinding } from "./contract.js";

const OUTPUT_BYTES = 32_768;
const TOOL_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MS = 310_000;
type Shape = z.ZodType;

/**
 * 规格 0.11 / 0.14：模型只看 `tool` 变体——没有完整引用，也没有 `requestId`。
 * 端口与用例层仍用原 schema，list/read 的返回值继续携带完整引用供展示与跨层路由。
 */
function modelFacing(schema: Shape): Shape {
  const variant = (schema as { tool?: Shape }).tool;
  return variant ?? schema;
}

/**
 * 规格 0.14：请求身份由工具层注入，不由模型发明。
 *
 * 正常路径用本次 `toolCallId`——每次调用唯一，首次调用天然得到稳定身份。重试是新的 toolCall，
 * 拿不到同一个身份，所以模型把上一次回执里的 `requestId` 放进 `retryOf`，由这里还原。
 */
function requestIdentity(input: unknown, toolCallId: string): string {
  const retryOf = (input as { retryOf?: unknown } | null)?.retryOf;
  return typeof retryOf === "string" ? retryOf : toolCallId;
}
function withRequestId(parsed: unknown, context: ToolExecutionContext): Record<string, unknown> {
  const { retryOf: _retryOf, ...rest } = parsed as Record<string, unknown>;
  return { ...rest, requestId: requestIdentity(parsed, context.toolCallId) };
}

/**
 * 规格 0.15：回执送不回来时（执行中超时或取消），把同一个身份随错误交给模型。
 *
 * 0.14 只在回执里返回 requestId，可调用在 handler 返回之前就失败时没有回执——模型只看到
 * "timed out"，拿不到身份，只能另起新请求，于是重复建会话或重复发消息。身份与 withRequestId
 * 同源（requestIdentity），否则模型照做也对不上原请求。
 */
function describeUnsettledRequest(input: unknown, toolCallId: string): string {
  return `This request may already have been admitted. Its identity is requestId=${requestIdentity(input, toolCallId)}: to retry this exact request, pass it as \`retryOf\`. Do not start a new request.`;
}

/** 该工具是否需要请求身份：工具面有 `retryOf` 的，端口那边就要 `requestId`。 */
function needsRequestId(schema: Shape): boolean {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  return shape !== undefined && "retryOf" in shape;
}

const sharedInstructions = [
  "Target an existing session by its sessionId. When you do not know the id, find it with ListSessions by title substring; never infer identity from a title or a path.",
  "Create or send work only when authorized by the user or an existing delegation. Keep the target session's permissions; this tool never approves its later permission requests.",
  "Accepted or queued means admitted, not completed. Wait for the returned operation, and surface needs_attention to the user.",
] as const;
/**
 * 重试指令只给真正收 `retryOf` 的写工具（规格 0.14）。
 *
 * 过去这一条和其余三条一起发给全部 12 个工具，于是 ListSessions 这类只读工具也被告知一个它
 * 不接受的参数——模型可见文案必须与该工具的 schema 一致，否则就是在教它传会被拒的字段。
 */
const retryInstruction =
  "An inconclusive result needs reconciliation, not a fresh call: take the requestId from that result and pass it as `retryOf`. Otherwise leave `retryOf` out — there is no requestId input to set." as const;
function instructionsFor(schema: Shape): readonly string[] {
  return needsRequestId(modelFacing(schema))
    ? [...sharedInstructions, retryInstruction]
    : sharedInstructions;
}

type Definition = {
  name: string;
  method: string;
  hint: string;
  description: string;
  input: Shape;
  output: Shape;
  readOnly?: boolean;
};
const commonDefinitions = (kind: "cli" | "app"): Definition[] => [
  {
    name: "ListSessions",
    method: "listSessions",
    hint:
      kind === "cli"
        ? "find sessions in the bound workspace by title"
        : "find App sessions across projects by title substring",
    description:
      kind === "cli"
        ? "List authorized sessions and their actual available actions without resuming or navigating."
        : 'List App sessions across projects by case-insensitive title substring, not full-text message search. Search unarchived sessions first: omit archived or use archived:"exclude". If the target is not found, explicitly search archived:"only"; use archived:"include" or "only" immediately only when the user asks for archived sessions. A project filter narrows the search. searchScope.scopes reports searched ranges; empty results apply only there. Empty scopes means no range was successfully searched. Non-empty unavailableSources means partial coverage. availableActions reports supported operations. Does not resume or navigate.',
    input: kind === "cli" ? schemas.cliListSessionsInputSchema : schemas.appListSessionsInputSchema,
    output: kind === "cli" ? schemas.listSessionsResultSchema : schemas.appListSessionsResultSchema,
    readOnly: true,
  },
  {
    name: "ReadSession",
    method: "readSession",
    hint: "read session status or message history",
    description:
      "Read a session summary or bounded history without execution, navigation or marking it read.",
    input: kind === "cli" ? schemas.cliReadSessionInputSchema : schemas.appReadSessionInputSchema,
    output: schemas.readSessionResultSchema,
    readOnly: true,
  },
  {
    name: "CreateSession",
    method: "createSession",
    hint: "create an independent session with a first prompt",
    description:
      "Create a root session and submit its first prompt. Creation and input admission are reported separately. Does not steal focus.",
    input:
      kind === "cli" ? schemas.cliCreateSessionInputSchema : schemas.appCreateSessionInputSchema,
    output: schemas.createSessionResultSchema,
  },
  {
    name: "ForkSession",
    method: "forkSession",
    hint: "fork a session at a stable message",
    description:
      "Fork at an explicit stable message boundary. Does not copy running tools, permission approvals, pending inputs, or change workspace files. Does not send a prompt.",
    input: kind === "cli" ? schemas.cliForkSessionInputSchema : schemas.appForkSessionInputSchema,
    output: schemas.forkSessionResultSchema,
  },
  {
    name: "SendToSession",
    method: "sendToSession",
    hint: "send a prompt to an existing session",
    description:
      "Submit input to the target session owner. Busy targets queue it. Preserve the target model, mode and permissions.",
    input:
      kind === "cli" ? schemas.cliSendToSessionInputSchema : schemas.appSendToSessionInputSchema,
    output: schemas.sendToSessionResultSchema,
  },
  {
    name: "WaitSessions",
    method: "waitSessions",
    hint: "wait for specific session operations",
    description:
      "Wait for the exact create/send operations, using any or all. timeoutMs=0 queries now. Cancelling this wait does not stop target execution. Never wait for your own future completion.",
    input: kind === "cli" ? schemas.cliWaitSessionsInputSchema : schemas.appWaitSessionsInputSchema,
    output: schemas.waitSessionsResultSchema,
    readOnly: true,
  },
  {
    name: "InterruptSession",
    method: "interruptSession",
    hint: "interrupt an observed session execution",
    description:
      "Interrupt only expectedExecutionId. A changed execution is rejected; session history is retained.",
    input:
      kind === "cli"
        ? schemas.cliInterruptSessionInputSchema
        : schemas.appInterruptSessionInputSchema,
    output: schemas.mutationResultSchema,
  },
  {
    name: "RenameSession",
    method: "renameSession",
    hint: "rename a session title",
    description: "Set the target session title through its metadata owner.",
    input:
      kind === "cli" ? schemas.cliRenameSessionInputSchema : schemas.appRenameSessionInputSchema,
    output: schemas.mutationResultSchema,
  },
];

function requireBinding(context: ToolExecutionContext, kind: "cli" | "app") {
  const binding = context.sessionControl;
  if (!binding || binding.kind !== kind || context.runtimeScope === "subagent") {
    throw new schemas.SessionControlError(
      "forbidden",
      "Session control is unavailable in this execution context.",
    );
  }
  const trusted = binding.context();
  if (trusted.rootSession.sessionId !== context.sessionId || trusted.rootSession.kind !== kind) {
    throw new schemas.SessionControlError(
      "forbidden",
      "Session control root binding does not match the executing session.",
    );
  }
  return {
    binding,
    trusted: {
      ...trusted,
      signal: context.abortSignal,
      traceId: context.traceId,
      turnId: context.traceContext?.turnId ?? context.turnId,
      toolCallId: context.toolCallId,
    },
  };
}

function createEntry(kind: "cli" | "app", definition: Definition): ToolEntry {
  // 同一工具名在两种运行位置共用声明，只按可信装配选择输入 schema 与实现。
  // 名字用 PascalCase（规格 0.12）：snake_case 会命中 UI 的 legacy kind 前缀启发式，
  // 把 ReadSession 渲染成读文件卡、CreateSession 渲染成写文件卡。
  const name = definition.name;
  const readOnly = definition.readOnly === true;
  const timeoutMs = definition.method === "waitSessions" ? WAIT_TIMEOUT_MS : TOOL_TIMEOUT_MS;
  const sideEffectScope = readOnly ? "none" : "system";
  const riskLevel = readOnly ? "low" : "medium";
  return {
    capability: definition.description,
    metadata: {
      name,
      description: definition.description,
      searchHint: definition.hint,
      modelInstructions: instructionsFor(definition.input),
      shouldDefer: true,
      readOnly,
      destructive: false,
      concurrentSafe: readOnly,
      sideEffectScope,
      riskLevel,
      needsApproval: !readOnly,
      maxOutputBytes: OUTPUT_BYTES,
      timeoutMs,
    },
    // io: "input" —— 默认按 output 投影会把 .default() 的字段算进 required，于是 archived、
    // timeoutMs 带着默认值却被标成必填，与「可以省略」的工具说明直接矛盾（规格 0.14）。
    inputSchema: z.toJSONSchema(modelFacing(definition.input), { io: "input" }),
    outputSchema: z.toJSONSchema(definition.output),
    runtimeInputSchema: modelFacing(definition.input),
    runtimeOutputSchema: definition.output,
    permission: {
      permission: `session_control.${definition.method}`,
      reason: definition.description,
      riskLevel,
      sideEffectScope,
      needsApproval: !readOnly,
      patternSources: ["toolName", "input"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: OUTPUT_BYTES,
      maxModelBytes: OUTPUT_BYTES,
      strategy: "artifact",
      preview: { maxBytes: OUTPUT_BYTES, direction: "head" },
      artifact: { enabled: true, retention: "session" },
    },
    timeout: { defaultMs: timeoutMs, maxMs: timeoutMs, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "required",
      // 规格 0.15：不再叫模型「用原始身份对账」——它拿不到。写工具的身份由 describeUnsettledCall 追加。
      userVisibleMessage: "Session control cancelled. Target work is not stopped.",
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
    // 只给接受 retryOf 的写工具：只读工具没有可重复执行的副作用，不需要对账。
    ...(needsRequestId(modelFacing(definition.input))
      ? { describeUnsettledCall: describeUnsettledRequest }
      : {}),
    handler: async (input, context) => {
      const { binding, trusted } = requireBinding(context, kind);
      context.abortSignal.throwIfAborted();
      const tool = modelFacing(definition.input);
      const raw = tool.parse(input);
      const parsed = needsRequestId(tool) ? withRequestId(raw, context) : raw;
      // 此表只包含静态声明的有限方法；schema 与 facade 均来自核心公共契约，不读存储或选择另一 surface。
      const method = (
        binding.control as unknown as Record<
          string,
          (ctx: typeof trusted, value: unknown) => Promise<unknown>
        >
      )[definition.method];
      if (!method)
        throw new schemas.SessionControlError(
          "unavailable",
          "Session control capability is unavailable.",
        );
      return definition.output.parse(await method(trusted, parsed));
    },
  };
}

const appOnlyTools: ToolEntry[] = [
  {
    name: "ListProjects",
    method: "listProjects",
    hint: "list accessible App projects and devices",
    description:
      "List projects in trusted discovery scopes across connected sources without starting a session. searchScope.scopes reports successfully searched ranges; empty results mean no matches only there. Empty scopes means no range was successfully searched. Non-empty unavailableSources means partial coverage. Discovery does not grant read or control access.",
    input: schemas.appListProjectsInputSchema,
    output: schemas.listProjectsResultSchema,
    readOnly: true,
  },
  {
    name: "OpenSession",
    method: "openSession",
    hint: "open a session in an App interface",
    description:
      "Explicitly open the session in the UI bound to this caller. Unavailable UI is reported without fallback navigation.",
    input: schemas.appOpenSessionInputSchema,
    output: schemas.openSessionResultSchema,
  },
  {
    name: "SetSessionArchived",
    method: "setSessionArchived",
    hint: "archive or restore an App session",
    description:
      "Archive or restore a product session. Archiving does not interrupt its execution.",
    input: schemas.appSetSessionArchivedInputSchema,
    output: schemas.mutationResultSchema,
  },
  {
    name: "SetSessionPinned",
    method: "setSessionPinned",
    hint: "pin or unpin an App session",
    description: "Pin or unpin a product session without changing its execution.",
    input: schemas.appSetSessionPinnedInputSchema,
    output: schemas.mutationResultSchema,
  },
].map((definition) => createEntry("app", definition));

/** 两种运行位置注册的工具：同名，按可信装配选择变体。App 是独立 CLI 的父集。 */
export const sessionControlToolsByKind: Readonly<Record<"cli" | "app", readonly ToolEntry[]>> = {
  cli: commonDefinitions("cli").map((definition) => createEntry("cli", definition)),
  app: [
    ...commonDefinitions("app").map((definition) => createEntry("app", definition)),
    ...appOnlyTools,
  ],
};

/** 不重复的工具名清单（以 App 变体为代表），用于内置工具表与工具契约检查。 */
export const sessionControlTools: readonly ToolEntry[] = sessionControlToolsByKind.app;
export const SESSION_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set(
  sessionControlTools.map((entry) => entry.metadata.name),
);
