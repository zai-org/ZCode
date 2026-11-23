import {
  CoreErrorType,
  HookOutcome,
  createCoreError,
  isCoreError,
  type HookExecutionDescriptor,
  type HookInput,
  type Logger,
} from "@zcode/contracts";
import { matchesHookMatcher } from "./output.js";
import type { HookRegistration, HookRunAdmissionDecision, HookRunOptions } from "./types.js";

export const HOOK_TIMEOUT_ABORT_REASON = Symbol("hook-timeout");

export function resolveHookRunAdmission(
  hook: HookRegistration,
  input: HookInput,
  logger?: Logger,
): HookRunAdmissionDecision {
  if (!hook.admission) return { allowed: true };
  try {
    return hook.admission(input);
  } catch (error) {
    // 安全 gate 自身异常时不能继续创建进程或后台任务。
    logger?.warn("Hook admission gate failed closed", {
      error: error instanceof Error ? error.message : String(error),
      event: "hook.admission.failed_closed",
      hookEventName: input.hookEventName,
      module: "core.hooks",
      source: hook.source,
    });
    return { allowed: false, reasonCode: "workspace_hooks_blocked_untrusted" };
  }
}

const SCRIPT_UNAVAILABLE_REASON = "workspace_hook_script_unavailable";

/**
 * 执行 registration 的派发前复核（D24）。取消、超时与异常都不放行；超时后迟到的结果被忽略。
 * 复核有独立截止时间，不扣减执行的 timeoutMs，没有复核的 Hook 计时不受影响。
 */
export async function verifyHookBeforeDispatch(
  hook: HookRegistration,
  input: HookInput,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  logger?: Logger,
): Promise<HookRunAdmissionDecision> {
  if (!hook.verifyBeforeDispatch) return { allowed: true };
  if (parentSignal?.aborted) return { allowed: false, reasonCode: SCRIPT_UNAVAILABLE_REASON };
  const controller = new AbortController();
  const unlink = linkAbortSignal(parentSignal, controller);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<{ allowed: false; reasonCode: string }>((resolve) => {
    const stop = () => resolve({ allowed: false, reasonCode: SCRIPT_UNAVAILABLE_REASON });
    controller.signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(() => controller.abort(), timeoutMs);
  });
  try {
    return await Promise.race([hook.verifyBeforeDispatch(input, controller.signal), stopped]);
  } catch (error) {
    logger?.warn("Hook pre-dispatch verification failed closed", {
      error: error instanceof Error ? error.message : String(error),
      event: "hook.verify.failed_closed",
      hookEventName: input.hookEventName,
      module: "core.hooks",
      source: hook.source,
    });
    return { allowed: false, reasonCode: SCRIPT_UNAVAILABLE_REASON };
  } finally {
    if (timer) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
    unlink();
  }
}

export function matchesAnyHookMatcher(
  options: HookRunOptions,
  matcher: string | undefined,
): boolean {
  if (!matcher) return true;
  const matchValues = [
    ...(options.matchValues ?? []),
    ...(options.matchValue ? [options.matchValue] : []),
  ];

  if (matchValues.length === 0) return true;
  return [...new Set(matchValues)].some((matchValue) => matchesHookMatcher(matchValue, matcher));
}

export function linkAbortSignal(
  parentSignal: AbortSignal | undefined,
  childController: AbortController,
): () => void {
  if (!parentSignal) return () => {};
  const abortChild = () => {
    if (!childController.signal.aborted) childController.abort(parentSignal.reason);
  };
  if (parentSignal.aborted) {
    abortChild();
    return () => {};
  }
  parentSignal.addEventListener("abort", abortChild);
  return () => parentSignal.removeEventListener("abort", abortChild);
}

export function createHookTimeoutError(timeoutMs: number): Error {
  return createCoreError(CoreErrorType.ToolTimeout, `Hook timed out after ${timeoutMs}ms`, {
    recoverable: true,
  });
}

export function createHookCancelledError(): Error {
  return createCoreError(CoreErrorType.ToolCancelled, "Hook execution cancelled", {
    recoverable: true,
  });
}

export function resolveHookFailureOutcome(error: unknown): HookOutcome {
  if (!isCoreError(error)) return HookOutcome.Failed;
  if (error.type === CoreErrorType.ToolTimeout) return HookOutcome.TimedOut;
  if (error.type === CoreErrorType.ToolCancelled) return HookOutcome.Cancelled;
  return HookOutcome.Failed;
}

export function readHookErrorMessage(error: unknown): string {
  if (isCoreError(error) && error.cause instanceof Error) {
    return error.cause.message || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function resolveHookDescriptor(
  hook: HookRegistration,
  defaultTimeoutMs: number,
  input: HookInput,
): HookExecutionDescriptor {
  if (typeof hook.descriptor === "function") return hook.descriptor(input);
  return (
    hook.descriptor ?? {
      clientVisible: false,
      commandDisplay: hook.source ?? "Internal hook",
      executionMode: hook.async === true ? "background" : "foreground",
      executionType: "process",
      sourceKind: "internal",
      timeoutMs: hook.timeoutMs ?? defaultTimeoutMs,
    }
  );
}
