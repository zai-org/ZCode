import {
  CoreErrorType,
  createCoreError,
  isCoreError,
  traceContextToLogContext,
  type CollaborationMode,
  type PermissionBrokerResult,
  type PermissionRuleset,
  type TraceContext,
  type ToolExecutionSpanWriter,
} from "@zcode/contracts";
import type { HookRunResult } from "../../hooks/index.js";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { resolveToolApproval } from "./approval-gate.js";
import { createErrorResult, createPermissionErrorResult } from "./errors.js";
import { emitPermissionDenied, emitPermissionResolved } from "./events.js";
import { applyPreToolPermissionDecision } from "./hook-flow.js";
import { applyMemoryFilePermission } from "./memory-file-permission.js";
import {
  resolveRuntimePermissionCapability,
  resolveRuntimePermissionContext,
} from "./permission-capability.js";
import { preparePermissionInput } from "./permission-input.js";
import { applyPermissionInputAdjustments } from "./permission-input-adjustments.js";
import { recheckPermissionHookModifiedInput } from "./permission-input-recheck.js";
import { requestPermissionResponse } from "./permission-request.js";
import {
  interpretPermissionResponse,
  type PermissionFlowResult,
  type PermissionResponseTransition,
} from "./permission-response.js";
import {
  loadProjectPermissionRuleset,
  applyGrantedPermissionUpdates,
} from "./permission-rules-persistence.js";
import { buildDefaultPermissionUpdates } from "./permission-suggestions.js";
import type { ToolExecutorDeps } from "./types.js";
import { summarizeInput } from "./utils.js";

const READ_TOOL_NAME = "Read";

type PermissionFlowContext = ToolRuntimePermissionCapabilityContext & {
  workingDirectory: string;
  workspaceRoot: string;
};

/**
 * 只判断 Read 是否被模式或权限规则直接拒绝，不跑 hook、不弹确认、不发事件；规则只加载一次。
 * Read 不涉及 memory 文件写权限，所以不经过 applyMemoryFilePermission。
 */
export async function areReadsDeniedWithoutPrompt(
  deps: ToolExecutorDeps,
  filePaths: readonly string[],
  traceContext: TraceContext,
): Promise<boolean[]> {
  const entry = deps.registry.get(READ_TOOL_NAME);
  if (!entry) return filePaths.map(() => true);
  const mode = deps.getMode();
  const context = resolvePermissionFlowContext(deps, mode);
  const projectRules = await loadProjectPermissionRuleset(deps);
  return filePaths.map((filePath) => {
    const { decision } = checkStaticToolPermission(deps, {
      context,
      entry,
      executionInput: { file_path: filePath },
      mode,
      projectRules,
      toolName: READ_TOOL_NAME,
    });
    deps.logger?.debug("Tool permission evaluated without prompt", {
      ...traceContextToLogContext(traceContext),
      decision: decision.decision,
      event: "tool.permission.evaluated",
      mode,
      module: "core.tool.executor",
      reason: decision.reason,
      ruleId: decision.ruleId,
      toolName: READ_TOOL_NAME,
    });
    return decision.decision === "deny";
  });
}

function resolvePermissionFlowContext(
  deps: ToolExecutorDeps,
  mode: CollaborationMode,
  preparedContext?: ToolRuntimePermissionCapabilityContext,
): PermissionFlowContext {
  return {
    ...resolveRuntimePermissionContext(deps),
    ...preparedContext,
    mode,
    workingDirectory: preparedContext?.workingDirectory ?? deps.getWorkingDirectory(),
    workspaceRoot: preparedContext?.workspaceRoot ?? deps.getWorkspaceRoot(),
  };
}

// 模式与权限规则的静态判定；工具调用和无确认的 Read 判定共用，保证两边结论一致。
function checkStaticToolPermission(
  deps: ToolExecutorDeps,
  input: {
    context: PermissionFlowContext;
    entry: ToolEntry;
    executionInput: unknown;
    mode: CollaborationMode;
    projectRules: PermissionRuleset | null;
    toolName: string;
  },
) {
  const { context, entry, executionInput } = input;
  const rulePolicy = entry.resolvePermissionRulePolicy?.(executionInput, context);
  const decision = deps.permissionService.checkPermission(
    {
      toolName: input.toolName,
      input: executionInput,
      riskLevel: entry.metadata.riskLevel,
      mode: input.mode,
      planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
      prePlanMode: deps.sessionModePort?.getPrePlanMode(),
      // 草稿预批与实际工具输入共用已准备的 cwd，不能在合并 Guarded 时漏传。
      workingDirectory: context.workingDirectory,
    },
    resolveRuntimePermissionCapability(entry, executionInput, context),
    input.projectRules,
    rulePolicy,
  );
  return { decision, rulePolicy };
}

export async function resolveToolPermission(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  entry: ToolEntry,
  executionInput: unknown,
  preToolHookResult: HookRunResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
  telemetry?: ToolExecutionSpanWriter,
  preparedContext?: ToolRuntimePermissionCapabilityContext,
): Promise<PermissionFlowResult> {
  const context = resolvePermissionFlowContext(deps, mode, preparedContext);
  let projectRules: PermissionRuleset | null;
  try {
    projectRules = await loadProjectPermissionRuleset(deps);
  } catch (error) {
    return {
      allowed: false,
      result: createErrorResult(
        toolCall,
        createCoreError(CoreErrorType.StorageError, "Failed to load project permission rules", {
          cause: error instanceof Error ? error : undefined,
          recoverable: true,
        }),
      ),
    };
  }
  let firstInput = true;
  let hooksAvailable = true;
  let permissionWaitMs = 0;
  // 根因：递归重入会重跑 Hook，并把问答答案当新操作；显式转换仅重判新输入。
  while (true) {
    if (signal?.aborted)
      return {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled", {
            recoverable: true,
          }),
        ),
      };
    const { decision: staticDecision, rulePolicy } = checkStaticToolPermission(deps, {
      context,
      entry,
      executionInput,
      mode,
      projectRules,
      toolName: toolCall.name,
    });
    let decision = staticDecision;
    if (firstInput && decision.approvalMode !== "user-once") {
      decision = applyPreToolPermissionDecision(decision, preToolHookResult, mode);
    }
    firstInput = false;
    decision = applyMemoryFilePermission({
      decision,
      executionInput,
      memoryRoot: deps.getMemoryRoot?.(),
      toolName: toolCall.name,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    });
    // 修复原因：统一审批流程曾丢失原日志合同；恢复关联字段，输入仍只记录结构摘要。
    deps.logger?.debug("Tool permission evaluated", {
      ...traceContextToLogContext(traceContext),
      decision: decision.decision,
      event: "tool.permission.evaluated",
      inputSummary: summarizeInput(toolCall.input),
      mode,
      module: "core.tool.executor",
      reason: decision.reason,
      riskLevel: decision.riskLevel,
      ruleId: decision.ruleId,
      sideEffectScope: decision.sideEffectScope,
      status:
        decision.decision === "allow"
          ? "completed"
          : decision.decision === "ask"
            ? "waiting"
            : "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    if (decision.allowed) {
      telemetry?.setPermissionDecision(permissionWaitMs ? "granted" : "not_required");
      return { allowed: true, executionInput, permissionWaitMs };
    }
    if (decision.decision === "deny") {
      telemetry?.setPermissionDecision("denied");
      await emitPermissionDenied(deps, toolCall, decision.reason, traceContext);
      deps.logger?.warn("Tool permission denied", {
        ...traceContextToLogContext(traceContext),
        decision: decision.decision,
        event: "tool.permission.denied",
        mode,
        module: "core.tool.executor",
        reason: decision.reason,
        ruleId: decision.ruleId,
        status: "failed",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
      return {
        allowed: false,
        result: createPermissionErrorResult(toolCall, decision.reason, {
          mode,
          ruleId: decision.ruleId,
        }),
      };
    }

    // 工具预览只能控制普通审批，不能覆盖 Guarded 的单次确认。
    const toolApproval =
      decision.approvalMode === "user-once"
        ? { gate: "ask" as const }
        : resolveToolApproval(deps, toolCall, entry, executionInput, traceContext);
    // 判定自带的选项策略（Plan 下的 MCP 询问）覆盖工具声明的策略。
    const approval =
      decision.optionsPolicy && toolApproval.gate === "ask"
        ? { ...toolApproval, optionsPolicy: decision.optionsPolicy }
        : toolApproval;
    if (approval.gate === "proceed") {
      telemetry?.setPermissionDecision("not_required");
      return { allowed: true, executionInput, permissionWaitMs };
    }

    const requestId = "perm_" + crypto.randomUUID();
    const startedAt = Date.now();
    const suggestedPermissionUpdates =
      decision.approvalMode === "user-once"
        ? []
        : (rulePolicy?.suggestedPermissionUpdates ??
          buildDefaultPermissionUpdates(
            toolCall.name,
            executionInput,
            entry.permissionCapabilityGroup,
          ));
    telemetry?.markPermissionRequested();
    let transition: PermissionResponseTransition;
    let resolved: PermissionBrokerResult;
    try {
      let outcome = await requestPermissionResponse({
        deps,
        toolCall,
        input: executionInput,
        decision,
        mode,
        requestId,
        traceContext,
        suggestedPermissionUpdates,
        approval,
        runHooks: hooksAvailable && decision.approvalMode !== "user-once",
        signal,
      });
      hooksAvailable = false;
      let rewrite: PermissionResponseTransition | undefined;
      // 非 guarded 保留已发布的 Hook/project/Memory 重判范围与授权语义。
      if (mode !== "guarded" && outcome.source === "hook" && outcome.result.decision === "modify") {
        const normalized = preparePermissionInput(
          outcome.result.modifiedInput ?? executionInput,
          entry,
          deps,
        );
        const recheck = recheckPermissionHookModifiedInput({
          context,
          deps,
          entry,
          mode,
          modifiedInput: normalized,
          projectRules,
          toolCall,
        });
        if (recheck.permissionDecision?.decision === "ask") {
          // 旧分支用同一 requestId 再次调用 broker，迟到响应可能批准新输入。
          // 保留原有 project/Memory 重判范围，生命周期改走相同的结束→新建转换。
          rewrite = { kind: "rewrite", input: normalized };
        } else {
          executionInput = normalized;
          outcome = {
            source: "hook",
            result: {
              ...outcome.result,
              modifiedInput: undefined,
              decision: recheck.permissionDecision?.decision === "deny" ? "deny" : "allow",
              reason: recheck.permissionDecision?.reason ?? outcome.result.reason,
            },
          };
        }
      }
      transition =
        rewrite ??
        interpretPermissionResponse({
          deps,
          toolCall,
          entry,
          input: executionInput,
          mode,
          decision,
          outcome,
          requestId,
        });
      resolved = { ...outcome.result, resolvedAt: outcome.result.resolvedAt ?? new Date() };
    } catch (error) {
      const coreError = isCoreError(error)
        ? error
        : createCoreError(
            mode === "guarded" ? CoreErrorType.ToolExecutionFailed : CoreErrorType.PermissionDenied,
            "Permission request failed",
            {
              cause: error instanceof Error ? error : undefined,
              context: { requestId, toolCallId: toolCall.id, toolName: toolCall.name },
              recoverable: true,
            },
          );
      resolved = { decision: "deny", reason: coreError.message, resolvedAt: new Date() };
      transition = {
        kind: "complete",
        result: { allowed: false, result: createErrorResult(toolCall, coreError) },
      };
    }
    permissionWaitMs += Math.max(0, Date.now() - startedAt);
    // 只有此处结束请求：校验错误、取消、改写和正常响应都发一次终态。
    await emitPermissionResolved(deps, toolCall, requestId, resolved, traceContext);
    deps.logger?.info("Tool permission resolved", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.resolved",
      module: "core.tool.executor",
      requestId,
      mode,
      ruleId: decision.ruleId,
      decision: resolved.decision,
      reason: resolved.reason,
      status:
        resolved.decision === "allow" || resolved.decision === "modify" ? "completed" : "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    if (transition.kind === "rewrite") {
      executionInput = transition.input;
      continue;
    }
    const result = transition.result;
    telemetry?.setPermissionDecision(result.allowed ? "granted" : "denied");
    if (!result.allowed) return result;
    if (signal?.aborted)
      return {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled", {
            recoverable: true,
          }),
        ),
      };
    const updateFailure = await applyGrantedPermissionUpdates({
      deps,
      permissionUpdates: resolved.permissionUpdates,
      requestId,
      sessionPermissionUpdates: resolved.sessionPermissionUpdates,
      toolCall,
      traceContext,
    });
    if (updateFailure) return { allowed: false, result: updateFailure };
    const adjusted = applyPermissionInputAdjustments({
      deps,
      entry,
      toolCall,
      executionInput: result.executionInput,
      adjustments: resolved.inputAdjustments,
      traceContext,
    });
    if (!adjusted.ok) return { allowed: false, result: adjusted.result };
    return {
      ...result,
      executionInput: adjusted.executionInput,
      permissionWaitMs,
      ...(adjusted.applied === undefined ? {} : { inputAdjustments: adjusted.applied }),
    };
  }
}
