// ============================================================
// Skill Tool Handler
// ============================================================

import {
  CoreErrorType,
  SkillInputJsonSchema,
  SkillInputSchema,
  SkillOutputJsonSchema,
  SkillOutputSchema,
  createCoreError,
  DYNAMIC_WORKFLOW_SKILL_NAME,
  SkillNotFoundError,
  type SkillContent,
  type SkillPort,
  type SkillRuntimeInput,
} from "@zcode/contracts";
import { levenshteinDistance } from "../levenshtein.js";
import type {
  DynamicWorkflowToolSurfaceDeferral,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
  ToolInputValidationResult,
} from "../types.js";

/** 技能正文的默认字节上限；超出部分由 adapter 从尾部截掉。 */
export const MAX_SKILL_BYTES = 100_000;

/**
 * `dynamic-workflows` 技能的字节上限（docs/dynamic-workflow/authoring.md「The skill」）。
 * 2026-09-30 放宽：这份技能从 09-22 起一直贴在 100 000 上，每加一个功能都得先删掉已有的指导。
 * 判据是请求里的名字，与技能门认的是同一个（workflow-skill-gate.ts）。
 */
export const WORKFLOW_SKILL_MAX_BYTES = 200_000;

/** 结果外壳（`<skill_content>` 标签、标题、Base directory 行）的余量；工具级预算要装得下它。 */
export const SKILL_RESULT_WRAPPER_BYTES = 4_096;

/** `skill` 去掉空白后为空。 */
const SKILL_INVALID_FORMAT_CODE = 1;
/** 目录重读之后仍找不到。 */
const SKILL_UNKNOWN_CODE = 2;
/** 相近名称建议的最大编辑距离。 */
const SKILL_SUGGESTION_MAX_DISTANCE = 2;

/**
 * onDemand 会话在激活之前加载 `dynamic-workflows` 技能时，排在 `<skill_content>` 之前的提示
 * （docs/dynamic-workflow/launch.md「On demand: activation」）。
 *
 * 修复原因：onDemand 下技能仍在列表里（`/workflow` 的 `skills:` 预加载要读得到它），用户只用文字说
 * 「用工作流做 X」时模型会加载它；正文要求点名工作流就必须调 CreateWorkflow，而十个工作流工具在激活前
 * 没有注册——模型卡住，或悄悄改用 Agent，用户不知道该发 `/workflow`。
 *
 * 为什么放在 Skill 结果里：只有真的加载这份技能的那一次调用才付这段 token，没提工作流的会话的工具声明、
 * 系统提示、技能列表逐字不变。`/workflow` 命令路径读不到它：命令的激活发生在展开处，早于 `skills:`
 * 预加载，那时探针已经是 false。文字请求仍然不是激活触发条件，这里只告知、不激活。
 */
export const DYNAMIC_WORKFLOW_TOOLS_DEFERRED_NOTICE =
  "Note: the workflow tools (CreateWorkflow and the others this skill names) were not enabled in this session at the moment this skill was loaded, so the instructions below cannot be followed yet. Do not try to call those tools, and do not stand in for a workflow with the Agent tool. Tell the user, in the user's language, to send a message that starts with `/workflow` to enable workflows in this session; the tools appear after that.";

/**
 * 子 runtime 版本的提示（Agent 子代理、`/expert` 等 workflow 子会话）。修复原因（评审 CR-01）：子 runtime
 * 的工具面是创建时从父配置带来的，它没有 `/workflow` 入口，用户在父会话发命令也不会让工具出现在这个已经
 * 启动的子会话里。上面那段话在这里是一条无法兑现的恢复步骤，所以它只被告知「这里跑不了工作流、把限制
 * 报告给父代理」，由有命令入口的父会话去转告用户。
 */
export const DYNAMIC_WORKFLOW_TOOLS_DEFERRED_SUBAGENT_NOTICE =
  "Note: the workflow tools (CreateWorkflow and the others this skill names) are not available in this child agent session and will not become available in it, so the instructions below cannot be followed here. Do not try to call those tools, and do not stand in for a workflow with the Agent tool. Report this limitation in your result to the parent agent: workflows can only be started from the main session, after the user sends a message there that starts with `/workflow`.";

/** 未激活形态 → 提示；`none` 没有提示。 */
const DEFERRED_NOTICE_BY_DEFERRAL: Record<DynamicWorkflowToolSurfaceDeferral, string> = {
  none: "",
  session: DYNAMIC_WORKFLOW_TOOLS_DEFERRED_NOTICE,
  subagent: DYNAMIC_WORKFLOW_TOOLS_DEFERRED_SUBAGENT_NOTICE,
};

/** 工具级结果预算是静态的，所以取最大的正文上限，再加外壳与较长的那段未激活提示。 */
const MAX_SKILL_RESULT_BYTES =
  WORKFLOW_SKILL_MAX_BYTES +
  SKILL_RESULT_WRAPPER_BYTES +
  Math.max(
    Buffer.byteLength(DYNAMIC_WORKFLOW_TOOLS_DEFERRED_NOTICE, "utf8"),
    Buffer.byteLength(DYNAMIC_WORKFLOW_TOOLS_DEFERRED_SUBAGENT_NOTICE, "utf8"),
  );

function skillMaxBytes(skill: string): number {
  return skill === DYNAMIC_WORKFLOW_SKILL_NAME ? WORKFLOW_SKILL_MAX_BYTES : MAX_SKILL_BYTES;
}

export const skillHandler: ToolHandler = async (input, context) => {
  const { skill } = SkillInputSchema.parse(input) as SkillRuntimeInput;
  const skillPort = context.skillPort;

  if (!skillPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SkillPort is not configured for Skill tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Skill",
        },
        recoverable: false,
      },
    );
  }

  let loaded: SkillContent;
  try {
    loaded = await skillPort.loadSkill(
      {
        name: skill,
        workingDirectory: context.workingDirectory,
        maxBytes: skillMaxBytes(skill),
        trace: skillTrace(context),
      },
      { signal: context.abortSignal },
    );
  } catch (error) {
    // 修复原因：找不到 skill 原来是不带 <tool_use_error> 的 `Skill not found: X`。它是可预期的输入错误，
    // 现在返回失败由 executor 包装，并给出目录里最相近的名称。只能在端口重读目录之后判定，所以在 handler 里转换。
    if (!(error instanceof SkillNotFoundError)) throw error;
    return unknownSkillFailure(skill, skillPort, context);
  }

  context.recordSkillTelemetryMetadata?.({
    name: loaded.metadata.name,
    ...(loaded.metadata.qualifiedName ? { qualifiedName: loaded.metadata.qualifiedName } : {}),
    ...(loaded.metadata.pluginId ? { pluginId: loaded.metadata.pluginId } : {}),
    source: loaded.metadata.source,
  });

  // 判据是请求里的名字，与字节上限、技能门认的是同一个；探针缺席时不加提示。
  const deferredNotice =
    skill === DYNAMIC_WORKFLOW_SKILL_NAME
      ? DEFERRED_NOTICE_BY_DEFERRAL[context.getDynamicWorkflowToolSurfaceDeferral?.() ?? "none"]
      : "";

  return [
    deferredNotice,
    `<skill_content name="${loaded.metadata.name}">`,
    `# Skill: ${loaded.metadata.name}`,
    "",
    expandSkillContextVariables(loaded.content, loaded.baseDirectory),
    "",
    `Base directory for this skill: ${loaded.baseDirectory}`,
    "Relative paths in this skill are relative to this base directory.",
    loaded.truncated ? "[Skill content truncated]" : "",
    "</skill_content>",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
};

function skillTrace(context: ToolExecutionContext) {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  };
}

async function unknownSkillFailure(
  skill: string,
  skillPort: SkillPort,
  context: ToolExecutionContext,
): Promise<ToolHandlerFailure> {
  // 建议只是附加信息：读目录失败时只报找不到。
  const outcome = await skillPort
    .discoverSkills(
      { workingDirectory: context.workingDirectory, trace: skillTrace(context) },
      { signal: context.abortSignal },
    )
    .catch(() => undefined);
  // 候选按目录顺序：先显示名（插件 skill 是限定名），再是短名；距离相同取靠前的。
  const candidates = (outcome?.skills ?? []).flatMap((metadata) =>
    metadata.qualifiedName && metadata.qualifiedName !== metadata.name
      ? [metadata.qualifiedName, metadata.name]
      : [metadata.name],
  );
  let suggestion: string | undefined;
  let bestDistance = SKILL_SUGGESTION_MAX_DISTANCE + 1;
  for (const candidate of candidates) {
    // 目录里有同名项但端口仍找不到（读正文时文件刚被删除等）：不提示同一个名字。
    if (candidate === skill) continue;
    if (Math.abs(candidate.length - skill.length) > SKILL_SUGGESTION_MAX_DISTANCE) continue;
    const distance = levenshteinDistance(skill, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      suggestion = candidate;
    }
  }
  return {
    result: false,
    errorCode: SKILL_UNKNOWN_CODE,
    message: suggestion
      ? `Unknown skill: ${skill}. Did you mean ${suggestion}?`
      : `Unknown skill: ${skill}`,
  };
}

function validateSkillInput(input: unknown): ToolInputValidationResult {
  const skill = (input as { skill?: unknown } | undefined)?.skill;
  if (typeof skill === "string" && skill.trim() === "") {
    return {
      result: false,
      errorCode: SKILL_INVALID_FORMAT_CODE,
      message: `Invalid skill format: ${skill}`,
    };
  }
  return { result: true };
}

function expandSkillContextVariables(content: string, baseDirectory: string): string {
  // 只有 Skill 工具加载后才有明确的当前 skill 目录，因此变量替换限定在这里完成。
  return content.replace(/\$\{(CLAUDE_SKILL_DIR|ZCODE_SKILL_DIR)\}/gu, baseDirectory);
}

export const skillToolEntry: ToolEntry = {
  capability: "Load local skill instructions into the current session context",
  metadata: {
    name: "Skill",
    // 描述只写已支持的能力：不含 fork/后台 skill、目录作用域 skill 名。
    description: `Invoke a skill.

A skill is a packaged set of instructions the user or project has set up for a particular kind of task (deploy steps, a review checklist, a repo-specific workflow). Available skills appear in a system-reminder listing with one-line descriptions. When the task at hand is one a listed skill covers, call this tool first — the skill's instructions load into the turn for you to follow in place of your default approach. Users may also ask for one by name (\`/<name>\`, or "slash command"); that's a request to invoke it.

- \`skill\`: exact name from the listing, no leading slash. Plugin skills use \`plugin:skill\`.
- \`args\`: optional arguments to pass through.

Only names from the listing (or that the user typed explicitly) are valid. Built-in CLI commands (\`/help\`, \`/clear\`, …) aren't skills. If a \`<command-name>\` block is already present this turn, the skill is loaded — follow it directly rather than calling again.
`,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_SKILL_RESULT_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: skillHandler,
  validateInput: validateSkillInput,
  inputSchema: SkillInputJsonSchema,
  outputSchema: SkillOutputJsonSchema,
  runtimeInputSchema: SkillInputSchema,
  runtimeOutputSchema: SkillOutputSchema,
  permission: {
    permission: "skill",
    reason: "Skill loads local instructions into session context",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SKILL_RESULT_BYTES,
    maxModelBytes: MAX_SKILL_RESULT_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_SKILL_RESULT_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Skill loading was cancelled before content was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
