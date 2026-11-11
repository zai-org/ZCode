import {
  SessionEventType,
  type SessionEvent,
  type TurnCompletePayload,
  type TurnStartedPayload,
} from "@zcode/contracts";
import { SessionControlError } from "@zcode/session-control/contracts";
import type {
  CliOperationRef,
  CliSessionRef,
  OperationFeed,
  OperationSnapshot,
  OperationStatus,
  OperationUpdate,
} from "@zcode/session-control/contracts";

const MAX_FEED_BUFFER = 64;
const MAX_FEEDS_PER_INPUT = 100;
const TERMINAL = new Set<OperationStatus>(["completed", "interrupted", "failed"]);
const RELEVANT_EVENTS = new Set<string>([
  SessionEventType.TurnStarted,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
  SessionEventType.PermissionRequested,
  SessionEventType.WorkspaceHookReviewRequested,
  SessionEventType.ToolCallStarted,
  SessionEventType.PermissionResolved,
  SessionEventType.PermissionDenied,
  SessionEventType.WorkspaceHookReviewSettled,
  SessionEventType.ToolCallResult,
]);

export interface ObservedInput {
  snapshot: OperationSnapshot<CliSessionRef>;
  turnId?: string;
  readonly done: Promise<void>;
  settle(): void;
  listeners: Set<(update: OperationUpdate<CliSessionRef>) => void>;
}

/** 本对象仅投影 owner 的输入事件，不持有 accepted queue，也不驱动执行。 */
export class CliOperationObservations {
  private readonly inputs = new Map<string, ObservedInput>();
  private readonly byTurn = new Map<string, ObservedInput>();
  private readonly attention = new Set<string>();
  constructor(private readonly epoch: string) {}

  register(operation: CliOperationRef): ObservedInput {
    const current = this.inputs.get(operation.commandId);
    if (current) return current;
    let settle!: () => void;
    const input: ObservedInput = {
      snapshot: { operation, epoch: this.epoch, revision: 0, status: "accepted" },
      done: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      settle: () => settle(),
      listeners: new Set(),
    };
    this.inputs.set(operation.commandId, input);
    return input;
  }

  update(
    input: ObservedInput,
    status: OperationStatus,
    fields: Partial<
      Pick<OperationSnapshot<CliSessionRef>, "executionId" | "reason" | "attention">
    > = {},
  ): void {
    if (TERMINAL.has(input.snapshot.status)) return;
    input.snapshot = {
      ...input.snapshot,
      ...fields,
      status,
      revision: input.snapshot.revision + 1,
      ...(status !== "needs_attention" ? { attention: undefined } : {}),
    };
    for (const listener of input.listeners)
      listener({ type: "snapshot", snapshot: input.snapshot });
    if (status === "needs_attention")
      this.attention.add(input.snapshot.operation.session.sessionId);
    else this.attention.delete(input.snapshot.operation.session.sessionId);
    if (TERMINAL.has(status)) {
      input.settle();
      if (input.turnId)
        this.byTurn.delete(
          JSON.stringify([input.snapshot.operation.session.sessionId, input.turnId]),
        );
    }
  }

  onEvent(event: SessionEvent): void {
    // 高频 streaming/tool delta 不遍历历史 operation；只按 inputId 或 active turn 索引。
    if (!RELEVANT_EVENTS.has(event.type)) return;
    const payload = event.payload as Record<string, unknown>;
    const input =
      typeof payload.inputId === "string"
        ? this.inputs.get(payload.inputId)
        : this.byTurn.get(JSON.stringify([event.sessionId, event.turnId]));
    if (
      !input ||
      input.snapshot.operation.session.sessionId !== event.sessionId ||
      TERMINAL.has(input.snapshot.status)
    )
      return;
    if (event.type === SessionEventType.TurnStarted) {
      input.turnId = event.turnId;
      this.byTurn.set(JSON.stringify([event.sessionId, event.turnId]), input);
      this.update(input, "running", {
        executionId: (event.payload as TurnStartedPayload).foregroundExecutionId,
      });
    } else if (event.type === SessionEventType.TurnComplete) {
      const result = (event.payload as TurnCompletePayload).resultType;
      this.update(
        input,
        result === "success" ? "completed" : result === "cancelled" ? "interrupted" : "failed",
      );
    } else if (event.type === SessionEventType.TurnError) {
      // Core turn.ts 的 catch 在所有 retry 结束后写 TurnError 并 reject completion；ModelError 不在此列。
      this.update(input, "failed");
    } else if (
      event.type === SessionEventType.PermissionRequested ||
      event.type === SessionEventType.WorkspaceHookReviewRequested
    ) {
      this.update(input, "needs_attention", { attention: { kind: "approval" } });
    } else if (
      event.type === SessionEventType.ToolCallStarted &&
      payload.toolName === "AskUserQuestion"
    ) {
      this.update(input, "needs_attention", { attention: { kind: "question" } });
    } else if (
      event.type === SessionEventType.PermissionResolved ||
      event.type === SessionEventType.PermissionDenied ||
      event.type === SessionEventType.WorkspaceHookReviewSettled ||
      event.type === SessionEventType.ToolCallResult
    ) {
      if (input.snapshot.status === "needs_attention") this.update(input, "running");
    }
  }

  statusForSession(sessionId: string): "needs_attention" | undefined {
    return this.attention.has(sessionId) ? "needs_attention" : undefined;
  }

  open(operation: CliOperationRef, signal: AbortSignal): OperationFeed<CliSessionRef> {
    const candidate = this.inputs.get(operation.commandId);
    const input =
      candidate?.snapshot.operation.session.sessionId === operation.session.sessionId &&
      candidate.snapshot.operation.session.workspacePath === operation.session.workspacePath &&
      candidate.snapshot.operation.session.workspaceIdentity === operation.session.workspaceIdentity
        ? candidate
        : undefined;
    if (input && input.listeners.size >= MAX_FEEDS_PER_INPUT)
      throw new SessionControlError("unavailable", "Operation observer capacity reached");
    const initial: OperationSnapshot<CliSessionRef> = input?.snapshot ?? {
      operation,
      epoch: this.epoch,
      revision: 0,
      status: "unknown",
      reason: "This owner has no receipt for the operation",
    };
    const pending: OperationUpdate<CliSessionRef>[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let invalidated = false;
    const listener = (update: OperationUpdate<CliSessionRef>) => {
      if (closed || invalidated) return;
      if (update.type === "invalidated" || pending.length >= MAX_FEED_BUFFER) {
        invalidated = true;
        pending.splice(
          0,
          pending.length,
          update.type === "invalidated"
            ? update
            : { type: "invalidated", operation, reason: "Operation observer buffer exceeded" },
        );
        input?.listeners.delete(listener);
        signal.removeEventListener("abort", onAbort);
      } else pending.push(update);
      wake?.();
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      input?.listeners.delete(listener);
      signal.removeEventListener("abort", onAbort);
      wake?.();
    };
    const onAbort = () => {
      void close();
    };
    // 同一同步片先订阅再取水位；中间没有 await，因此不会丢终态。
    input?.listeners.add(listener);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) void close();
    return {
      initial,
      updates: {
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            if (pending.length) {
              const update = pending.shift()!;
              yield update;
              if (update.type === "invalidated") return;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
        },
      },
      close,
    };
  }

  close(): void {
    for (const input of this.inputs.values()) {
      for (const listener of input.listeners)
        listener({
          type: "invalidated",
          operation: input.snapshot.operation,
          reason: "CLI owner closed",
        });
      input.listeners.clear();
    }
  }
}
