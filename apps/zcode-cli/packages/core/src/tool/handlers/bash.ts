// ============================================================
// Bash Tool Handler
// ============================================================

import { matchDangerousCommand } from "./guarded/command.js";
import {
  BashInputSchema,
  BashInputJsonSchema,
  BashOutputJsonSchema,
  BashOutputSchema,
  CoreErrorType,
  SessionEventType,
  createCoreError,
  type BashInput,
  type BashOutput,
  type BackgroundExecutionStartResult,
  type CommandCategory,
  type CommandExecutionSpanWriter,
  type CommandShellKind,
  type ExecutionEvent,
  type ExecutionResult,
  type ExecutionRequest,
  type ExecutionRunOptions,
  type ExecutionShellSelection,
  type TraceContext,
} from "@zcode/contracts";
import {
  shouldInjectEmbeddedSearchBashPrelude,
  supportsEmbeddedSearchShellSelection,
} from "../../embedded-search/shell.js";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolRuntimePermissionCapability,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { resolveToolWorkingDirectory } from "../path-policy.js";
import { decideBashCwdPolicy } from "./bash-cwd-policy.js";
export {
  getBashActivityDescription,
  getBashAutoClassifierInput,
  getBashDescription,
  getBashToolUseSummary,
  getBashUserFacingName,
} from "./bash-metadata.js";
import { readStringProperty } from "./bash-metadata.js";
import {
  formatBashModelContent,
  formatPersistedBashModelContent,
  isBashModelContentBounded,
} from "./bash-model-content.js";

/** session shell selection 尚未初始化时 guarded matcher 采用的文法；与 readonly 判定的假设一致。 */
const GUARDED_DEFAULT_DIALECT: ExecutionShellSelection["dialect"] = "posix";
import { createBashProviderDescription } from "./bash-prompt.js";
import {
  createBashBackgroundPerformanceTelemetry,
  createEmptyBashPerformanceTelemetry,
  toBashOutput,
  type BashProgressTiming,
} from "./bash-output.js";
import {
  attachToolExecutionTelemetry,
  classifyCommand,
  classifySafeCommandIdentity,
} from "./tool-perf.js";
import { applyBashReadFileStateEffects } from "./bash-read-file-state.js";
import {
  prepareBashPermissionMatcherForCommand,
  isBashReadOnlyCommand,
  isRuntimeReadOnlyBashCommand,
  type BashPermissionMatcher,
} from "./bash-semantics.js";
import { isBashAutoBackgroundEligible } from "./bash-background-policy.js";
import { supportsBashBackgroundLifecycle } from "./bash-background-lifecycle.js";
import { resolveBashPermissionRulePolicy } from "./bash-command-permission-policy.js";
import {
  DEFAULT_BASH_TIMEOUT_POLICY,
  resolveBashTimeoutMs,
  type BashTimeoutPolicy,
} from "../bash-timeout-policy.js";

const MAX_INLINE_OUTPUT_BYTES = 30_000;
const MAX_RUNTIME_PERSISTED_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;
const BASH_PROVIDER_DESCRIPTION = createBashProviderDescription({
  defaultTimeoutMs: DEFAULT_BASH_TIMEOUT_POLICY.defaultTimeoutMs,
  maxTimeoutMs: DEFAULT_BASH_TIMEOUT_POLICY.maxTimeoutMs,
});

export function getBashPrompt(
  timeoutPolicy: BashTimeoutPolicy = DEFAULT_BASH_TIMEOUT_POLICY,
): string {
  return createBashProviderDescription({
    defaultTimeoutMs: timeoutPolicy.defaultTimeoutMs,
    maxTimeoutMs: timeoutPolicy.maxTimeoutMs,
  });
}

export function isBashInputReadOnly(input: unknown): boolean {
  const command = readStringProperty(input, "command");
  return command ? isBashReadOnlyCommand(command) : false;
}

export function isBashInputConcurrencySafe(input: unknown): boolean {
  return isBashInputReadOnly(input);
}

export function checkBashInputPermissions(input: unknown): { behavior: "allow" } | undefined {
  return resolveBashPermissionCapability(input) ? { behavior: "allow" } : undefined;
}

export function prepareBashPermissionMatcher(input: unknown): BashPermissionMatcher | undefined {
  const command = readStringProperty(input, "command");
  return command === undefined ? undefined : prepareBashPermissionMatcherForCommand(command);
}

export function resolveBashPermissionCapability(
  input: unknown,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolRuntimePermissionCapability | undefined {
  const command = readStringProperty(input, "command");
  if (command && context?.mode === "guarded") {
    // selection 缺失是基础设施状态而非语法边界；与下方 isRuntimeReadOnlyBashCommand 一致按 POSIX
    // 文法匹配，避免 guarded 在 selection 尚未初始化时静默退回 YOLO。显式 legacy-shell 仍 unsupported。
    const match = matchDangerousCommand(
      command,
      context.bashShellSelection?.dialect ?? GUARDED_DEFAULT_DIALECT,
    );
    if (match.status === "matched") return { userApprovalRule: match.ruleId };
  }
  if (!command || !isRuntimeReadOnlyBashCommand(command, context)) return undefined;
  return {
    destructive: false,
    needsApproval: false,
    readOnly: true,
    riskLevel: "low" as const,
    sideEffectScope: "none" as const,
    permission: {
      needsApproval: false,
      riskLevel: "low" as const,
      sideEffectScope: "none" as const,
    },
  };
}

export const bashHandler: ToolHandler = (input, context) =>
  executeBashHandler(input, context, DEFAULT_BASH_TIMEOUT_POLICY);

function createBashHandler(timeoutPolicy: BashTimeoutPolicy): ToolHandler {
  return (input, context) => executeBashHandler(input, context, timeoutPolicy);
}

async function executeBashHandler(
  input: unknown,
  context: ToolExecutionContext,
  timeoutPolicy: BashTimeoutPolicy,
): Promise<BashOutput> {
  const parsed = BashInputSchema.parse(input) as BashInput;
  const executionPort = context.executionPort;

  if (!executionPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ExecutionPort is not configured for Bash tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Bash",
        },
        recoverable: false,
      },
    );
  }

  if (parsed.command.trim().length === 0) {
    const commandTelemetry = startBashCommandTelemetry(parsed, context);
    commandTelemetry?.finishCompleted();
    return emptyBashOutput(parsed);
  }

  const request = createExecutionRequest(parsed, context, timeoutPolicy);
  const progressTiming: BashProgressTiming = {};
  const commandTelemetry = startBashCommandTelemetry(parsed, context);
  const runOptions = createExecutionRunOptions(context, progressTiming, commandTelemetry);
  // 闲时后台归属由 Runtime 生命周期保留，Bash 复用普通显式/超时后台路径。
  const eligibleForAutoBackground = isBashAutoBackgroundEligible(parsed);
  const backgroundLifecyclePort = supportsBashBackgroundLifecycle(executionPort)
    ? executionPort
    : undefined;

  if (parsed.run_in_background && !backgroundLifecyclePort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ExecutionPort does not support the Bash background lifecycle",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Bash",
        },
        recoverable: false,
      },
    );
  }

  const runCommand = async () =>
    parsed.run_in_background && backgroundLifecyclePort
      ? backgroundLifecyclePort.runBashWithBackgroundLifecycle(
          request,
          { mode: "explicit" },
          runOptions,
        )
      : eligibleForAutoBackground && backgroundLifecyclePort
        ? backgroundLifecyclePort.runBashWithBackgroundLifecycle(
            request,
            { mode: "auto_on_timeout" },
            runOptions,
          )
        : {
            kind: "foreground" as const,
            result: await executionPort.run(request, runOptions),
          };
  const runResult = commandTelemetry
    ? await commandTelemetry.run(async () => {
        const observed = await runCommand();
        if (observed.kind === "backgrounded") {
          commandTelemetry.finishBackgrounded();
        } else {
          finishBashCommandTelemetry(commandTelemetry, observed.result);
        }
        return observed;
      })
    : await runCommand();

  if (runResult.kind === "backgrounded") {
    // auto_on_timeout 只在超时计时器到点时转后台，所以这里记录的就是触发转后台的超时。
    const timedOutAfterMs =
      !parsed.run_in_background && eligibleForAutoBackground ? request.timeoutMs : undefined;
    return toBackgroundedBashOutput(runResult.task, parsed, timedOutAfterMs);
  }

  const result = runResult.result;
  const cwdDecision = decideBashCwdPolicy({
    status: result.status,
    exitCode: result.exitCode,
    resolvedCwd: result.resolvedCwd,
    workspaceRoot: context.workspaceRoot,
    runtimeScope: context.runtimeScope,
  });
  if (cwdDecision.nextWorkingDirectory) {
    // 主线程 Bash 成功后会保留项目内 cwd；
    // 离开项目边界时 reset 回原始工作区，并把 reset 文案放进 Bash stderr。
    await context.setWorkingDirectory?.(cwdDecision.nextWorkingDirectory);
  }
  const output = await toBashOutput(result, parsed, context, {
    progressTiming,
    stderrSuffix: cwdDecision.stderrSuffix,
  });
  await applyBashReadFileStateEffects({
    command: parsed.command,
    context,
    output,
    result,
  });
  return output;
}

function emptyBashOutput(input: BashInput): BashOutput {
  return attachToolExecutionTelemetry(
    {
      stdout: "",
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      status: "completed",
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    },
    createEmptyBashPerformanceTelemetry(input),
  );
}

function toBackgroundedBashOutput(
  task: BackgroundExecutionStartResult,
  input: BashInput,
  timedOutAfterMs: number | undefined,
): BashOutput {
  return attachToolExecutionTelemetry(
    {
      stdout: "",
      stderr: "",
      interrupted: false,
      status: "backgrounded",
      backgroundTaskId: task.taskId,
      ...(timedOutAfterMs !== undefined && timedOutAfterMs > 0 ? { timedOutAfterMs } : {}),
      rawOutputPath: task.outputPath,
      persistedOutputPath: task.outputPath,
      stdoutPersistedOutputPath: task.stdoutPersistedOutputPath,
      stderrPersistedOutputPath: task.stderrPersistedOutputPath,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    },
    createBashBackgroundPerformanceTelemetry(input),
  );
}

function createExecutionRunOptions(
  context: ToolExecutionContext,
  progressTiming?: BashProgressTiming,
  telemetry?: CommandExecutionSpanWriter,
): ExecutionRunOptions {
  return {
    signal: context.abortSignal,
    onEvent: async (event) => {
      if (event.type !== "progress") return;
      if (
        progressTiming &&
        progressTiming.firstOutputMs === undefined &&
        event.stdoutBytes + event.stderrBytes > 0
      ) {
        progressTiming.firstOutputMs = Math.max(0, Math.round(event.elapsedMs));
        telemetry?.markFirstOutput();
      }
      await emitProgressEvent(event, context);
    },
  };
}

function startBashCommandTelemetry(
  input: BashInput,
  context: ToolExecutionContext,
): CommandExecutionSpanWriter | undefined {
  const identity = classifySafeCommandIdentity(input.command);
  return context.telemetry?.startCommand({
    category: commandCategory(input.command),
    commandCount: identity.count ?? 0,
    safeName: identity.name ?? "other",
    sandboxed: input.dangerouslyDisableSandbox !== true,
    shellKind: commandShellKind(context.bashShellSelection),
  });
}

function finishBashCommandTelemetry(
  telemetry: CommandExecutionSpanWriter | undefined,
  result: ExecutionResult,
): void {
  if (!telemetry) return;
  if (result.exitCode !== undefined) telemetry.setExitCode(result.exitCode);
  if (result.signal) telemetry.setSignal(result.signal);
  telemetry.setOutputBytes(result.stdout.bytes + result.stderr.bytes);
  telemetry.setTimedOut(result.timedOut);

  if (result.timedOut) {
    telemetry.markTerminationRequested("timeout");
    telemetry.finishFailed("timeout", "timeout", result.error);
  } else if (result.cancelled) {
    telemetry.markTerminationRequested("cancelled");
    telemetry.finishCancelled("abort_signal");
  } else if (result.status === "spawn_error") {
    telemetry.finishFailed("spawn", "configuration", result.error);
  } else if (result.status === "failed" && result.error) {
    // 非零退出码是命令事实（例如 grep 未匹配），不等同于执行框架失败。
    // 只有 Adapter 明确提供结构化 failure 时才污染 command failure rate。
    telemetry.finishFailed("execute", "internal", result.error);
  } else {
    telemetry.finishCompleted();
  }
}

function commandCategory(command: string): CommandCategory {
  switch (classifyCommand(command)) {
    case "git":
      return "git";
    case "package":
      return "package_manager";
    case "build":
      return "build";
    case "test":
      return "test";
    case "network":
      return "network";
    default:
      return "shell";
  }
}

function commandShellKind(
  selection: ToolExecutionContext["bashShellSelection"],
): CommandShellKind | undefined {
  const displayName = selection?.display.name.toLowerCase();
  if (displayName?.includes("powershell")) return "powershell";
  if (displayName?.includes("zsh")) return "zsh";
  if (displayName?.includes("bash")) return "bash";
  if (selection?.dialect === "cmd") return "cmd";
  if (selection?.dialect === "posix") return "sh";
  return selection ? "other" : undefined;
}

async function emitProgressEvent(
  event: Extract<ExecutionEvent, { type: "progress" }>,
  context: ToolExecutionContext,
): Promise<void> {
  if (!context.emitEvent) return;

  await context.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.ToolCallProgress,
    timestamp: event.timestamp,
    traceId: context.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: context.toolCallId,
      toolName: "Bash",
      elapsedMs: event.elapsedMs,
      pid: event.pid,
      stdoutBytes: event.stdoutBytes,
      stderrBytes: event.stderrBytes,
      outputBytes: event.stdoutBytes + event.stderrBytes,
      outputPreview: event.outputPreview,
      stdoutTail: event.stdoutTail,
      stderrTail: event.stderrTail,
    },
  });
}

function createBashSessionEnv(context: ToolExecutionContext): Record<string, string> {
  // 工作区根目录是会话创建时的工作目录，不随 `cd` 变化。
  return {
    CLAUDE_CODE_SESSION_ID: context.sessionId,
    CLAUDE_PROJECT_DIR: context.workspaceRoot,
    CLAUDE_SESSION_ID: context.sessionId,
    ZCODE_PROJECT_DIR: context.workspaceRoot,
    ZCODE_SESSION_ID: context.sessionId,
  };
}

function createExecutionRequest(
  input: BashInput,
  context: ToolExecutionContext,
  timeoutPolicy: BashTimeoutPolicy,
): ExecutionRequest {
  const shellSelection = context.bashShellSelection;
  const bashPrelude =
    shouldInjectEmbeddedSearchBashPrelude() &&
    context.embeddedSearch?.enabled === true &&
    context.embeddedSearch.backend &&
    supportsEmbeddedSearchShellSelection(shellSelection)
      ? {
          kind: "embedded-search" as const,
          backend: context.embeddedSearch.backend,
          ...(context.embeddedSearch.findAndGrepEnabled === false
            ? { findAndGrepEnabled: false }
            : {}),
        }
      : undefined;
  return {
    command: {
      mode: "shell",
      command: input.command,
      shellProfile: "posix-bash",
      ...(shellSelection ? { shellOverride: shellSelection } : {}),
    },
    cwd: resolveToolWorkingDirectory(undefined, {
      operation: "execute",
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    }),
    ...(bashPrelude ? { bashPrelude } : {}),
    // 会话上下文变量与 hooks 的插件环境一致（configured-runner-input.ts createPluginEnvOverlay）。
    // 自定义命令的 `!` 块改为转交模型经 Bash 执行后，原来由命令解析阶段执行器提供的这组变量
    // 只能在这里提供；插件脚本在自身进程里读取会话 ID 区分会话，缺了它会跨会话生效。
    env: { set: createBashSessionEnv(context) },
    captureCwdAfterSuccess: input.run_in_background ? undefined : true,
    timeoutMs: resolveBashTimeoutMs(input.timeout, timeoutPolicy),
    outputLimit: {
      maxInlineBytes: MAX_INLINE_OUTPUT_BYTES,
      maxBufferBytes: MAX_INLINE_OUTPUT_BYTES,
      maxPersistedBytes: MAX_RUNTIME_PERSISTED_OUTPUT_BYTES,
      persistOutput: input.run_in_background ? "always" : "on_truncate",
    },
    sandbox: {
      enabled: !input.dangerouslyDisableSandbox,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    },
    trace: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      attributes: {
        toolCallId: context.toolCallId,
        toolName: "Bash",
      },
    } as unknown as TraceContext,
  };
}

export const bashToolEntry: ToolEntry = {
  capability: "Execute platform shell commands through the execution adapter",
  metadata: {
    name: "Bash",
    description: BASH_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: DEFAULT_BASH_TIMEOUT_POLICY.defaultTimeoutMs,
    maxOutputBytes: 10_000_000,
    sideEffectScope: "system",
    riskLevel: "high",
    needsApproval: true,
  },
  formatModelContent: formatBashModelContent,
  formatPersistedModelContent: formatPersistedBashModelContent,
  // 失败正文已按字符保留头尾，不再按字节预算落盘。
  isModelContentBounded: isBashModelContentBounded,
  handler: bashHandler,
  resolveTimeoutBudgetMs: createBashTimeoutBudgetResolver(DEFAULT_BASH_TIMEOUT_POLICY),
  resolvePermissionCapability: resolveBashPermissionCapability,
  resolvePermissionRulePolicy: resolveBashPermissionRulePolicy,
  inputSchema: BashInputJsonSchema,
  outputSchema: BashOutputJsonSchema,
  runtimeInputSchema: BashInputSchema,
  runtimeOutputSchema: BashOutputSchema,
  permission: {
    permission: "bash",
    reason: "Bash can run subprocesses and may affect workspace, git, network, or system state",
    riskLevel: "high",
    sideEffectScope: "system",
    needsApproval: true,
    patternSources: ["command"],
    alwaysAllowPatternSources: ["command"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_INLINE_OUTPUT_BYTES,
    maxModelBytes: 30_000,
    strategy: "artifact",
    preview: {
      maxBytes: 30_000,
      direction: "tail",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: {
    defaultMs: DEFAULT_BASH_TIMEOUT_POLICY.defaultTimeoutMs,
    maxMs: DEFAULT_BASH_TIMEOUT_POLICY.maxTimeoutMs,
    allowCallOverride: true,
    cleanupGraceMs: 6_000,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "Bash was cancelled and the child process was asked to stop",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export function createBashToolEntry(
  options: {
    bashTimeoutPolicy?: BashTimeoutPolicy;
    embeddedSearchEnabled?: boolean;
  } = {},
): ToolEntry {
  const timeoutPolicy = options.bashTimeoutPolicy ?? DEFAULT_BASH_TIMEOUT_POLICY;
  return {
    ...bashToolEntry,
    handler: createBashHandler(timeoutPolicy),
    inputSchema: createBashInputJsonSchema(timeoutPolicy),
    resolveTimeoutBudgetMs: createBashTimeoutBudgetResolver(timeoutPolicy),
    metadata: {
      ...bashToolEntry.metadata,
      description: createBashProviderDescription({
        defaultTimeoutMs: timeoutPolicy.defaultTimeoutMs,
        embeddedSearchEnabled: options.embeddedSearchEnabled,
        maxTimeoutMs: timeoutPolicy.maxTimeoutMs,
      }),
      timeoutMs: timeoutPolicy.defaultTimeoutMs,
    },
    timeout: {
      defaultMs: timeoutPolicy.defaultTimeoutMs,
      maxMs: timeoutPolicy.maxTimeoutMs,
      allowCallOverride: true,
      cleanupGraceMs: 6_000,
    },
  };
}

function createBashTimeoutBudgetResolver(
  timeoutPolicy: BashTimeoutPolicy,
): NonNullable<ToolEntry["resolveTimeoutBudgetMs"]> {
  return (input) => {
    const parsed = BashInputSchema.safeParse(input);
    // 旧 watchdog 直接读取 raw timeout，导致 0 被压成 1ms，且字符串数字绕过
    // Bash policy。这里和 handler 共用 timeout || default / max 解析后再加 cleanup grace。
    return resolveBashTimeoutMs(parsed.success ? parsed.data.timeout : undefined, timeoutPolicy);
  };
}

function createBashInputJsonSchema(timeoutPolicy: BashTimeoutPolicy): Record<string, unknown> {
  const schema = BashInputJsonSchema as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown> | undefined;
  const timeoutProperty = properties?.timeout as Record<string, unknown> | undefined;
  if (!properties || !timeoutProperty) return schema;

  return {
    ...schema,
    properties: {
      ...properties,
      timeout: {
        ...timeoutProperty,
        description: `Optional timeout in milliseconds (max ${timeoutPolicy.maxTimeoutMs} for a foreground command)`,
      },
    },
  };
}
