import {
  HookEventName,
  HookOnError,
  HookOutcome,
  SessionEventType,
  isCoreError,
  traceContextToLogContext,
  type HookExecutionDescriptor,
  type HookInput,
  type HookJSONOutput,
  type Logger,
  type SessionEvent,
} from "@zcode/contracts";
import { mergeHookRunResult, processHookOutput } from "./output.js";
import { sanitizeHookDisplayText } from "./display-metadata.js";
import {
  HOOK_TIMEOUT_ABORT_REASON,
  createHookCancelledError,
  createHookTimeoutError,
  linkAbortSignal,
  matchesAnyHookMatcher,
  readHookErrorMessage,
  resolveHookDescriptor,
  resolveHookFailureOutcome,
  resolveHookRunAdmission,
  verifyHookBeforeDispatch,
} from "./runner-helpers.js";
import type {
  HookRegistration,
  HookCallbackDiagnostics,
  HookCallbackResult,
  HookRunOptions,
  HookRunResult,
  HookRunner,
  HookRunnerOptions,
} from "./types.js";

export class InMemoryHookRunner implements HookRunner {
  private readonly defaultTimeoutMs: number;
  private readonly emitEvent?: (event: SessionEvent) => Promise<void>;
  private readonly hooks: HookRegistration[];
  private readonly logger?: Logger;

  constructor(options: HookRunnerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60000;
    this.emitEvent = options.emitEvent;
    this.hooks = [...(options.hooks ?? [])];
    this.logger = options.logger;
  }

  register(hook: HookRegistration): void {
    this.hooks.push(hook);
  }

  async run(input: HookInput, options: HookRunOptions = {}): Promise<HookRunResult> {
    const matchingHooks = this.hooks.filter(
      (hook) => hook.event === input.hookEventName && matchesAnyHookMatcher(options, hook.matcher),
    );
    const result: HookRunResult = {
      additionalContexts: [],
    };
    const hookInvocationId = crypto.randomUUID();

    // skipLifecycle 的 hook 不发事件，不能计入客户端等待完成的 hookCount。
    // 修复：先解析全部 matchingHooks 的 admission，把 skipLifecycle 的从参与列表
    // 剔除后再计算 clientVisibleHookCount，保证 hookCount === 实际会发事件的 hook 数。
    //
    // 注意：这里的 admission 结果只用于 skipLifecycle 剔除与 hookCount 计算——
    // 二者取决于「配置是否启用」这一稳定属性。allowed 授权决定绝不能沿用本阶段的
    // 缓存：一次事件匹配多个顺序执行的 Hook 时，前序 Hook 运行期间发生的
    // revoke / policy 收紧 / trust store reload 必须对尚未开始的 Hook 立即生效，
    // 因此循环内在每个 Hook 实际 dispatch 前重新调用 resolveHookRunAdmission。
    const participatingHooks: { hook: HookRegistration }[] = [];
    for (const hook of matchingHooks) {
      const admission = resolveHookRunAdmission(hook, input, this.logger);
      if (admission.skipLifecycle) continue;
      participatingHooks.push({ hook });
    }

    const clientVisibleHookCount = participatingHooks.filter(
      ({ hook }) => resolveHookDescriptor(hook, this.defaultTimeoutMs, input).clientVisible,
    ).length;
    let clientVisibleHookIndex = 0;

    for (const [runtimeIndex, { hook }] of participatingHooks.entries()) {
      const descriptor = resolveHookDescriptor(hook, this.defaultTimeoutMs, input);
      const hookIndex = descriptor.clientVisible ? clientVisibleHookIndex++ : runtimeIndex;
      const hookRunId = crypto.randomUUID();
      const startedAt = Date.now();
      // dispatch 前重新解析授权决定。预扫描结果可能已过时——前序 Hook
      // 执行期间用户 revoke、管理员收紧 policy 或 trust store reload 都会改变
      // 结论。security revision 的价值就在执行边界重验，授权决定不得缓存。
      let admission = resolveHookRunAdmission(hook, input, this.logger);
      let verifyFailed = false;
      if (admission.allowed && hook.verifyBeforeDispatch) {
        // 项目 Hook 入口脚本复核（D24）：等待期间可能发生 revoke / policy 收紧，复核通过后必须再验一次。
        admission = await verifyHookBeforeDispatch(
          hook,
          input,
          hook.timeoutMs ?? this.defaultTimeoutMs,
          options.signal,
          this.logger,
        );
        if (admission.allowed) admission = resolveHookRunAdmission(hook, input, this.logger);
        else verifyFailed = true;
      }
      if (!admission.allowed) {
        // 已信任 Hook 的入口脚本复核失败（被删、不可读、内容变化、超时）按 Hook 出错处理：
        // 修复前脚本缺失会以非零退出触发 onError: deny，复核前移后不能变成静默放行（第二轮 CR 需确认项）。
        // 未信任、被撤销或用户中断不算出错，不拦截。
        const denyReason =
          verifyFailed && !hook.async && !options.signal?.aborted
            ? resolveDenyOnErrorReason(
                hook,
                input,
                HookOutcome.Failed,
                admission.reasonCode ?? "workspace_hook_script_unavailable",
              )
            : undefined;
        if (denyReason !== undefined) {
          mergeHookRunResult(
            result,
            processHookOutput(input.hookEventName, preToolUseDenyOutput(denyReason)),
          );
        }
        await this.emitHookEvent(
          SessionEventType.HookRunBlocked,
          input,
          hookInvocationId,
          hookRunId,
          hookIndex,
          clientVisibleHookCount,
          hook,
          descriptor,
          startedAt,
          {
            durationMs: 0,
            errorCode: admission.reasonCode,
            outcome: HookOutcome.Blocked,
            ...(denyReason !== undefined
              ? { blockReason: denyReason }
              : admission.reasonCode
                ? { blockReason: sanitizeHookDisplayText(admission.reasonCode) }
                : {}),
          },
        );
        continue;
      }
      await this.emitHookEvent(
        SessionEventType.HookRunStarted,
        input,
        hookInvocationId,
        hookRunId,
        hookIndex,
        clientVisibleHookCount,
        hook,
        descriptor,
        startedAt,
      );

      if (hook.async) {
        // async command 的生命周期独立于当前 turn；输出不得反向改变已经继续执行的动作。
        void this.runBackgroundHook({
          clientVisibleHookCount,
          descriptor,
          hook,
          hookIndex,
          hookInvocationId,
          hookRunId,
          input,
          parentSignal: options.signal,
          runtimeIndex,
          startedAt,
        }).catch((error) => {
          this.logger?.warn("Async hook lifecycle reporting failed", {
            ...traceContextToLogContext({
              traceId: input.traceId,
              sessionId: input.sessionId,
              turnId: input.turnId,
            }),
            error: error instanceof Error ? error.message : String(error),
            event: "hook.run.async_reporting_failed",
            hookEventName: input.hookEventName,
            hookIndex,
            module: "core.hooks",
            source: hook.source,
          });
        });
        continue;
      }

      try {
        const callbackResult = await this.runCallbackWithTimeout(
          hook,
          input,
          runtimeIndex,
          options.signal,
        );
        const { output, diagnostics } = unwrapHookCallbackResult(callbackResult);
        const durationMs = Date.now() - startedAt;
        const processed = processHookOutput(input.hookEventName, output);
        mergeHookRunResult(result, processed);
        const blocked =
          processed.permissionBehavior === "deny" ||
          processed.permissionRequestResult?.behavior === "deny" ||
          processed.preventContinuation ||
          processed.blockRequested;
        // 阻断原因必须随终态事件进入持久化投影；只放在 TurnResult/tooltip 会在
        // 重放或移动端恢复时丢失，用户无法从 Hooks 明细判断是哪条 Hook 拦截了请求。
        const blockReason = blocked
          ? sanitizeHookDisplayText(
              processed.stopReason ??
                processed.hookPermissionDecisionReason ??
                (processed.permissionRequestResult?.behavior === "deny"
                  ? processed.permissionRequestResult.message
                  : undefined) ??
                "Hook blocked execution",
            )
          : undefined;
        const safeDiagnostics = blocked ? sanitizeHookDiagnostics(diagnostics) : undefined;
        if (!blocked) this.logAllowedToolCall(input, hook, hookIndex, durationMs);

        await this.emitHookEvent(
          blocked ? SessionEventType.HookRunBlocked : SessionEventType.HookRunCompleted,
          input,
          hookInvocationId,
          hookRunId,
          hookIndex,
          clientVisibleHookCount,
          hook,
          descriptor,
          startedAt,
          {
            durationMs,
            outcome: blocked ? HookOutcome.Blocked : HookOutcome.Success,
            ...(blockReason ? { blockReason } : {}),
            ...(safeDiagnostics?.errorMessage
              ? { errorMessage: safeDiagnostics.errorMessage }
              : {}),
            ...(safeDiagnostics?.stderrPreview
              ? { stderrPreview: safeDiagnostics.stderrPreview }
              : {}),
            ...(safeDiagnostics?.stdoutPreview
              ? { stdoutPreview: safeDiagnostics.stdoutPreview }
              : {}),
          },
        );
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const outcome = resolveHookFailureOutcome(error);
        const errorMessage = sanitizeHookDisplayText(readHookErrorMessage(error));
        // hook 自身出错，原先一律放行（fail-open）：一条读错字段而崩溃的守卫等于不存在，且没人知道。
        // `onError: "deny"` 让这次出错与「hook 以退出码 2 拦截」同形，交给下游同一条 deny 路径。
        const denyReason = resolveDenyOnErrorReason(hook, input, outcome, errorMessage);
        if (denyReason !== undefined) {
          mergeHookRunResult(
            result,
            processHookOutput(input.hookEventName, preToolUseDenyOutput(denyReason)),
          );
        }
        await this.emitHookEvent(
          denyReason === undefined
            ? SessionEventType.HookRunFailed
            : SessionEventType.HookRunBlocked,
          input,
          hookInvocationId,
          hookRunId,
          hookIndex,
          clientVisibleHookCount,
          hook,
          descriptor,
          startedAt,
          {
            durationMs,
            errorCode: isCoreError(error) ? error.code : undefined,
            errorMessage,
            outcome: denyReason === undefined ? outcome : HookOutcome.Blocked,
            stderrPreview: errorMessage,
            ...(denyReason === undefined ? {} : { blockReason: denyReason }),
          },
        );

        this.logger?.warn("Hook execution failed", {
          ...traceContextToLogContext({
            traceId: input.traceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
          }),
          durationMs,
          event: "hook.run.failed",
          hookEventName: input.hookEventName,
          hookIndex,
          matcher: hook.matcher,
          module: "core.hooks",
          ...(denyReason === undefined ? {} : { onError: HookOnError.Deny }),
          outcome,
          source: hook.source,
        });
      }
    }

    return result;
  }

  /**
   * 放行也留痕：用户、项目、插件配置的 PreToolUse hook 放行一次工具调用记一条 info。原先只有
   * 拦截与失败落盘，一条静默放行一切的守卫在日志里与「没装守卫」无法区分。内置 hook 不记
   * （它们挂在别的事件上，且与消息流同量级）；只在配置了 PreToolUse hook 的工具调用上产生。
   */
  private logAllowedToolCall(
    input: HookInput,
    hook: HookRegistration,
    hookIndex: number,
    durationMs: number,
  ): void {
    if (input.hookEventName !== HookEventName.PreToolUse) return;
    if (hook.sourceKind === undefined || hook.sourceKind === "internal") return;
    this.logger?.info("PreToolUse hook allowed tool call", {
      ...traceContextToLogContext({
        traceId: input.traceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
      }),
      durationMs,
      event: "hook.run.allowed",
      hookIndex,
      matcher: hook.matcher,
      module: "core.hooks",
      source: hook.source,
      sourceKind: hook.sourceKind,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
    });
  }

  private async runBackgroundHook(options: {
    clientVisibleHookCount: number;
    descriptor: HookExecutionDescriptor;
    hook: HookRegistration;
    hookIndex: number;
    hookInvocationId: string;
    hookRunId: string;
    input: HookInput;
    parentSignal: AbortSignal | undefined;
    runtimeIndex: number;
    startedAt: number;
  }): Promise<void> {
    const {
      clientVisibleHookCount,
      descriptor,
      hook,
      hookIndex,
      hookInvocationId,
      hookRunId,
      input,
      parentSignal,
      runtimeIndex,
      startedAt,
    } = options;
    try {
      await this.runCallbackWithTimeout(hook, input, runtimeIndex, parentSignal);
      await this.emitHookEvent(
        SessionEventType.HookRunCompleted,
        input,
        hookInvocationId,
        hookRunId,
        hookIndex,
        clientVisibleHookCount,
        hook,
        descriptor,
        startedAt,
        {
          durationMs: Date.now() - startedAt,
          outcome: HookOutcome.Success,
        },
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const outcome = resolveHookFailureOutcome(error);
      const errorMessage = sanitizeHookDisplayText(readHookErrorMessage(error));
      await this.emitHookEvent(
        SessionEventType.HookRunFailed,
        input,
        hookInvocationId,
        hookRunId,
        hookIndex,
        clientVisibleHookCount,
        hook,
        descriptor,
        startedAt,
        {
          durationMs,
          errorCode: isCoreError(error) ? error.code : undefined,
          errorMessage,
          outcome,
          stderrPreview: errorMessage,
        },
      );
      this.logger?.warn("Async hook execution failed", {
        ...traceContextToLogContext({
          traceId: input.traceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
        }),
        durationMs,
        event: "hook.run.async_failed",
        hookEventName: input.hookEventName,
        hookIndex,
        matcher: hook.matcher,
        module: "core.hooks",
        source: hook.source,
      });
    }
  }

  private async runCallbackWithTimeout(
    hook: HookRegistration,
    input: HookInput,
    hookIndex: number,
    parentSignal?: AbortSignal,
  ): Promise<HookJSONOutput | HookCallbackResult | void> {
    const timeoutMs = hook.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const unlink = linkAbortSignal(parentSignal, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await new Promise<HookJSONOutput | HookCallbackResult | void>((resolve, reject) => {
        if (controller.signal.aborted) {
          reject(createHookCancelledError());
          return;
        }

        timer = setTimeout(() => {
          controller.abort(HOOK_TIMEOUT_ABORT_REASON);
          reject(createHookTimeoutError(timeoutMs));
        }, timeoutMs);
        timer.unref?.();

        controller.signal.addEventListener(
          "abort",
          () => {
            reject(
              controller.signal.reason === HOOK_TIMEOUT_ABORT_REASON
                ? createHookTimeoutError(timeoutMs)
                : createHookCancelledError(),
            );
          },
          { once: true },
        );

        Promise.resolve(hook.callback(input, { hookIndex, signal: controller.signal })).then(
          resolve,
          reject,
        );
      });
    } finally {
      if (timer) clearTimeout(timer);
      unlink();
    }
  }

  private async emitHookEvent(
    type: SessionEventType,
    input: HookInput,
    hookInvocationId: string,
    hookRunId: string,
    hookIndex: number,
    hookCount: number,
    hook: HookRegistration,
    descriptor: HookExecutionDescriptor,
    startedAt: number,
    extra: Partial<SessionEvent["payload"] & Record<string, unknown>> = {},
  ): Promise<void> {
    if (!this.emitEvent) return;
    await this.emitEvent({
      id: crypto.randomUUID() as any,
      sessionId: input.sessionId,
      turnId: input.turnId,
      type,
      timestamp: type === SessionEventType.HookRunStarted ? new Date(startedAt) : new Date(),
      traceId: input.traceId,
      sequenceNumber: 0,
      payload: {
        agentName: input.agentName,
        descriptor,
        hookEventName: input.hookEventName,
        hookIndex,
        hookCount,
        hookInvocationId,
        hookRunId,
        hookSource: hook.source,
        matcher: hook.matcher,
        requestId: "requestId" in input ? input.requestId : undefined,
        startedAt,
        toolCallId: "toolCallId" in input ? input.toolCallId : undefined,
        toolName: "toolName" in input ? input.toolName : undefined,
        ...extra,
      },
    });
  }
}

function unwrapHookCallbackResult(result: HookJSONOutput | HookCallbackResult | void): {
  output: HookJSONOutput | undefined;
  diagnostics: HookCallbackDiagnostics | undefined;
} {
  if (isHookCallbackResult(result)) {
    return { output: result.output, diagnostics: result.diagnostics };
  }
  return { output: result as HookJSONOutput | undefined, diagnostics: undefined };
}

function isHookCallbackResult(value: unknown): value is HookCallbackResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "hookCallbackResult",
  );
}

function sanitizeHookDiagnostics(
  diagnostics: HookCallbackDiagnostics | undefined,
): HookCallbackDiagnostics | undefined {
  if (!diagnostics) return undefined;
  const sanitize = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? sanitizeHookDisplayText(trimmed).slice(0, 4000) : undefined;
  };
  const errorMessage = sanitize(diagnostics.errorMessage);
  const stderrPreview = sanitize(diagnostics.stderrPreview);
  const stdoutPreview = sanitize(diagnostics.stdoutPreview);
  if (!errorMessage && !stderrPreview && !stdoutPreview) return undefined;
  return {
    ...(errorMessage ? { errorMessage } : {}),
    ...(stderrPreview ? { stderrPreview } : {}),
    ...(stdoutPreview ? { stdoutPreview } : {}),
  };
}

export function createInMemoryHookRunner(options?: HookRunnerOptions): InMemoryHookRunner {
  return new InMemoryHookRunner(options);
}

/**
 * `onError: "deny"` 只在 PreToolUse 上、且 hook 真的运行过并出错时生效。用户中断不算出错：
 * 把它变成拦截，会让「取消」看起来像策略拒绝。返回拦截理由；不拦截时返回 undefined。
 */
function resolveDenyOnErrorReason(
  hook: HookRegistration,
  input: HookInput,
  outcome: HookOutcome,
  errorMessage: string,
): string | undefined {
  if (hook.onError !== HookOnError.Deny) return undefined;
  if (input.hookEventName !== HookEventName.PreToolUse) return undefined;
  if (outcome === HookOutcome.Cancelled) return undefined;
  return sanitizeHookDisplayText(
    `PreToolUse hook failed and its onError is "deny", so the tool call is blocked: ${errorMessage}`,
  );
}

/** 与退出码 2 的拦截同形（configured-runner-callback.ts 的 createExitCodeBlockOutput）。 */
function preToolUseDenyOutput(reason: string): HookJSONOutput {
  return {
    continue: false,
    reason,
    hookSpecificOutput: {
      hookEventName: HookEventName.PreToolUse,
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
