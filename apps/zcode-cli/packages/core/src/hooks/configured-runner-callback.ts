import {
  CoreErrorType,
  HookEventName,
  HookJSONOutputSchema,
  createCoreError,
  type ExecutionResult,
  type HookConfig,
  type HookInput,
  type HookJSONOutput,
} from "@zcode/contracts";
import {
  createCompatibleHookStdin,
  createPluginEnvOverlay,
  expandPluginVariables,
} from "./configured-runner-input.js";
import type { ConfiguredHookRunnerOptions, HookCallback, HookCallbackResult } from "./types.js";

export function createConfiguredHookCallback(
  options: ConfiguredHookRunnerOptions,
  event: HookEventName,
  hook: HookConfig,
  matcherIndex: number,
  hookIndex: number,
  execution: { maxOutputBytes: number; timeoutMs: number },
): HookCallback {
  switch (hook.type) {
    case "command":
      return async (input, context) => {
        const stdin = await createCompatibleHookStdin(input);
        try {
          const result = await options.executionPort.run(
            {
              command: {
                mode: "shell",
                command: expandPluginVariables(
                  hook.command,
                  hook.plugin,
                  input,
                  options.getWorkingDirectory(),
                ),
                shell: hook.shell,
              },
              cwd: input.cwd || options.getWorkingDirectory(),
              env: createPluginEnvOverlay(hook.plugin, input, options.getWorkingDirectory()),
              stdin: stdin.value,
              timeoutMs: execution.timeoutMs,
              outputLimit: {
                maxBufferBytes: execution.maxOutputBytes,
                maxInlineBytes: execution.maxOutputBytes,
                persistOutput: "none",
              },
              trace: {
                traceId: input.traceId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                attributes: {
                  hookEventName: event,
                  hookIndex,
                  matcherIndex,
                },
              },
            },
            { signal: context.signal },
          );
          return processHookExecutionResult(input, result, event, hook);
        } finally {
          await stdin.cleanup();
        }
      };
    case "process":
      return async (input, context) => {
        const stdin = await createCompatibleHookStdin(input);
        try {
          const result = await options.executionPort.run(
            {
              command: {
                mode: "argv",
                file: expandPluginVariables(
                  hook.command,
                  hook.plugin,
                  input,
                  options.getWorkingDirectory(),
                ),
                args: (hook.args ?? []).map((arg) =>
                  expandPluginVariables(arg, hook.plugin, input, options.getWorkingDirectory()),
                ),
              },
              cwd: input.cwd || options.getWorkingDirectory(),
              env: createPluginEnvOverlay(hook.plugin, input, options.getWorkingDirectory()),
              stdin: stdin.value,
              timeoutMs: execution.timeoutMs,
              outputLimit: {
                maxBufferBytes: execution.maxOutputBytes,
                maxInlineBytes: execution.maxOutputBytes,
                persistOutput: "none",
              },
              trace: {
                traceId: input.traceId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                attributes: {
                  hookEventName: event,
                  hookIndex,
                  matcherIndex,
                },
              },
            },
            { signal: context.signal },
          );
          return processHookExecutionResult(input, result, event, hook);
        } finally {
          await stdin.cleanup();
        }
      };
  }
}

function processHookExecutionResult(
  input: HookInput,
  result: ExecutionResult,
  event: HookEventName,
  hook: HookConfig,
): HookJSONOutput | HookCallbackResult | undefined {
  if (result.status === "completed" && (result.exitCode ?? 0) === 0) {
    return attachHookDiagnostics(parseHookStdout(result.stdout.text, event), result);
  }

  if (result.exitCode === 2) {
    return attachHookDiagnostics(createExitCodeBlockOutput(input, result, hook), result);
  }

  const message =
    result.error?.message ??
    trimForPreview(result.stderr.text) ??
    `Hook process exited with status ${result.status}`;
  throw createCoreError(CoreErrorType.ToolExecutionFailed, "Hook process failed", {
    context: {
      exitCode: result.exitCode,
      hookEventName: event,
      status: result.status,
      stderrPreview: trimForPreview(result.stderr.text),
      stdoutPreview: trimForPreview(result.stdout.text),
    },
    cause: new Error(message),
    recoverable: true,
  });
}

function attachHookDiagnostics(
  output: HookJSONOutput | undefined,
  result: ExecutionResult,
): HookJSONOutput | HookCallbackResult | undefined {
  const stderrPreview = trimForPreview(result.stderr.text);
  const stdoutPreview = result.exitCode === 2 ? trimForPreview(result.stdout.text) : undefined;
  if (!stderrPreview && !stdoutPreview) return output;
  return {
    kind: "hookCallbackResult",
    ...(output ? { output } : {}),
    diagnostics: {
      ...(stderrPreview ? { errorMessage: stderrPreview, stderrPreview } : {}),
      ...(stdoutPreview ? { stdoutPreview } : {}),
    },
  };
}

function parseHookStdout(stdout: string, event: HookEventName): HookJSONOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed || !trimmed.startsWith("{")) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 非 JSON stdout 是诊断文本，不能因为 hook 打印日志而让当前动作失败。
    return undefined;
  }

  const validation = HookJSONOutputSchema.safeParse(parsed);
  if (!validation.success) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Hook stdout failed HookJSONOutput schema validation",
      {
        context: {
          errors: validation.error.issues.slice(0, 20),
          hookEventName: event,
        },
        recoverable: true,
      },
    );
  }

  return validation.data as HookJSONOutput;
}

function createExitCodeBlockOutput(
  input: HookInput,
  result: ExecutionResult,
  hook: HookConfig,
): HookJSONOutput {
  const reason =
    trimForPreview(result.stderr.text) ??
    trimForPreview(result.stdout.text) ??
    "Hook blocked execution";

  if (input.hookEventName === HookEventName.PreToolUse) {
    return {
      continue: false,
      reason,
      hookSpecificOutput: {
        hookEventName: HookEventName.PreToolUse,
        permissionDecision: "deny",
        permissionDecisionReason: formatPreToolUseExitCodeReason(input.toolName, result, hook),
      },
    };
  }

  if (input.hookEventName === HookEventName.PermissionRequest) {
    return {
      continue: false,
      reason,
      hookSpecificOutput: {
        hookEventName: HookEventName.PermissionRequest,
        decision: {
          behavior: "deny",
          message: reason,
        },
      },
    };
  }

  if (input.hookEventName === HookEventName.Stop) {
    return {
      decision: "block",
      reason,
    };
  }

  return {
    continue: false,
    reason,
  };
}

/** stderr 为空时的占位；退出码 2 时不再用 stdout 代替。 */
const NO_STDERR_OUTPUT = "No stderr output";
/** 拒绝文字里代替 Hook 命令的占位：命令可能带凭据，不发给模型。 */
const HIDDEN_COMMAND = "command hidden";
/** 插件 Hook 在拒绝文字后追加的来源行。 */
const PLUGIN_SOURCE_LINE = (pluginName: string): string =>
  `\nThis hook comes from the ${pluginName} plugin.`;

/**
 * 退出码 2 拒绝工具时模型看到的文字（docs/hooks-runtime-contract.md「PreToolUse 拒绝时模型看到的文字」）。
 * 修复原因：原来只给 stderr 预览（为空时用 stdout），模型会把 stdout 的诊断输出当成拒绝理由；现在 stderr 为空时
 * 写 No stderr output，并写出来源插件。Hooks 明细的 blockReason 仍用旧预览。
 * 修复原因：Hook 命令可能带凭据，而这段文字会进入 tool_result、会话持久化和之后的 provider 请求，所以固定写
 * 占位词。不能改回写脱敏后的命令：脱敏是黑名单，覆盖不了 `curl -u user:pass` 这类写法。
 */
function formatPreToolUseExitCodeReason(
  toolName: string,
  result: ExecutionResult,
  hook: HookConfig,
): string {
  const stderr = trimForPreview(result.stderr.text) ?? NO_STDERR_OUTPUT;
  const pluginLine = hook.plugin ? PLUGIN_SOURCE_LINE(hook.plugin.name) : "";
  return `PreToolUse:${toolName} hook error: [${HIDDEN_COMMAND}]: ${stderr}${pluginLine}`;
}

function trimForPreview(value: string, maxLength = 4000): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
