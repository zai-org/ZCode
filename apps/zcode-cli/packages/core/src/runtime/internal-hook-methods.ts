import type { HookRunResult, Model, TraceContext, TurnState } from "./deps.js";

// 从 internal-methods.ts 拆出，避免该文件越过
// 400 行边界（runtime-module-boundary 测试），hooks 一组方法自成一段，单独成文件。
export interface AgentRuntimeHookMethods {
  runSessionStartHooks(
    source: "startup" | "resume" | "fork" | "clear" | "compact",
    traceContext: TraceContext,
    signal?: AbortSignal,
    model?: Pick<Model, "providerId" | "modelId">,
  ): Promise<HookRunResult>;
  runUserPromptSubmitHooks(
    prompt: string,
    attachments: TurnState["attachments"] | undefined,
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runStopHooks(
    response: string,
    toolCallCount: number,
    traceContext: TraceContext,
    signal?: AbortSignal,
    stopHookActive?: boolean,
  ): Promise<HookRunResult>;
  shouldContinueAfterStopHooks(result: HookRunResult, continuationCount: number): boolean;
}
