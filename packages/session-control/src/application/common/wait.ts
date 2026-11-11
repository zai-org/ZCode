import {
  SessionControlError,
  type AccessGrant,
  type AccessPort,
  type DeadlinePort,
  type Scope,
  type SessionRef,
  type TrustedContext,
} from "#session-control/contract/common";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  operationSnapshotSchema,
  operationUpdateSchema,
  type OperationFeed,
  type OperationObservationPort,
  type OperationRef,
  type OperationSnapshot,
  type WaitSessionsResult,
} from "#session-control/contract/observation";
import {
  assertScope,
  assertOutputSession,
  sameOperation,
  sameSession,
  sessionScope,
} from "#session-control/domain/reference-scope";
import { isOperationSettled, isWaitSatisfied } from "#session-control/domain/operation-outcome";
import { authorize } from "#session-control/application/common/boundary";

export async function waitForOperations<R extends SessionRef, S extends Scope>(
  ctx: TrustedContext<R, S>,
  input: { operations: OperationRef<R>[]; mode: "any" | "all"; timeoutMs: number },
  ports: {
    access: AccessPort<R, S>;
    observations: OperationObservationPort<R, S>;
    deadlines: DeadlinePort;
  },
): Promise<WaitSessionsResult<R>> {
  const { operations, mode, timeoutMs } = input;
  for (const [index, operation] of operations.entries()) {
    assertScope(ctx, sessionScope(operation.session), operation.session);
    // self_wait 只对会话类调用方有意义：客户端类没有根会话，等待任何会话都不会等到自己。
    if (ctx.caller !== "client" && sameSession(operation.session, ctx.rootSession))
      throw new SessionControlError("self_wait", "Cannot wait for the calling root session");
    if (operations.slice(0, index).some((earlier) => sameOperation(earlier, operation)))
      throw new SessionControlError("invalid_input", "Duplicate operation reference");
  }
  // 将目标和可替换快照放在同一项，避免跨异步阶段用数组索引关联身份与状态。
  type ObservationTarget = { operation: OperationRef<R>; snapshot: OperationSnapshot<R> };
  const targets: ObservationTarget[] = operations.map((operation) => ({
    operation,
    snapshot: { operation, epoch: "unobserved", revision: 0, status: "unknown" },
  }));
  const snapshots = () => targets.map((target) => target.snapshot);
  if (ctx.signal?.aborted) return { status: "cancelled", operations: snapshots() };

  // timeout=0 不订阅未来变化，但授权和快照获取仍需有界；先建 deadline，失败时不留下监听器。
  const deadline = ports.deadlines.create(timeoutMs || DEFAULT_WAIT_TIMEOUT_MS);
  const controller = new AbortController();
  const callContext = { ...ctx, signal: controller.signal };
  const feeds = new Set<OperationFeed<R>>();
  const closed = new Map<OperationFeed<R>, Promise<void>>();
  let finished = false;
  let opened = 0;
  let resolve!: (value: WaitSessionsResult<R>) => void;
  let reject!: (error: unknown) => void;
  const outcome = new Promise<WaitSessionsResult<R>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const close = (feed: OperationFeed<R>): Promise<void> => {
    let result = closed.get(feed);
    if (!result) {
      result = Promise.resolve().then(() => feed.close());
      // 迟到 open 的清理没有调用方可再等待；保留有界结果并避免未处理拒绝。
      void result.catch(() => undefined);
      closed.set(feed, result);
    }
    return result;
  };
  const finish = (status: WaitSessionsResult["status"]) => {
    if (finished) return;
    finished = true;
    resolve({ status, operations: snapshots() });
    controller.abort();
  };
  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    reject(error);
    controller.abort();
  };
  const cancel = () => finish("cancelled");
  ctx.signal?.addEventListener("abort", cancel, { once: true });
  if (ctx.signal?.aborted) cancel();
  void deadline.expired.then(() => finish("timed_out"), fail);

  const invalid = (target: ObservationTarget, reason: string) => {
    target.snapshot = { ...target.snapshot, status: "unknown", reason };
    finish("unknown");
  };
  const check = () => {
    // 零等待是全量快照查询，any 也必须收齐各目标 baseline 后再判断。
    if (timeoutMs === 0 && opened !== operations.length) return;
    const states = snapshots();
    if (isWaitSatisfied(states, mode)) finish("completed");
    else if (opened === operations.length && states.some((value) => value.status === "unknown"))
      finish("unknown");
    else if (opened === operations.length && timeoutMs === 0) finish("timed_out");
  };

  async function observe(target: ObservationTarget, grant: AccessGrant<S>): Promise<void> {
    const { operation } = target;
    let feed: OperationFeed<R>;
    try {
      if (finished) return;
      feed = await ports.observations.open(callContext, operation, controller.signal, grant);
    } catch (error) {
      fail(error);
      return;
    }
    feeds.add(feed);
    // 截止或取消不证明 open 已结束；迟到 feed 仍归当前调用负责释放。
    if (finished) {
      await close(feed);
      return;
    }
    const initial = operationSnapshotSchema.safeParse(feed.initial);
    if (!initial.success || !sameOperation(initial.data.operation, operation)) {
      invalid(target, "Invalid observation baseline");
      return;
    }
    try {
      assertOutputSession(initial.data.operation.session, operation.session, ctx);
    } catch {
      invalid(target, "Unauthorized observation baseline");
      return;
    }
    target.snapshot = initial.data as OperationSnapshot<R>;
    opened += 1;
    check();
    if (finished) return;
    // 单个 operation 已进入终态后不再消费其流；正常关闭不能撤销已确认结果。
    if (timeoutMs === 0 || isOperationSettled(target.snapshot.status)) {
      await close(feed);
      return;
    }
    try {
      for await (const raw of feed.updates) {
        if (finished) break;
        const update = operationUpdateSchema.safeParse(raw);
        if (!update.success) {
          invalid(target, "Invalid observation update");
          return;
        }
        if (update.data.type === "invalidated") {
          invalid(
            target,
            sameOperation(update.data.operation, operation)
              ? update.data.reason
              : "Observation identity changed",
          );
          return;
        }
        const next = update.data.snapshot;
        const previous = target.snapshot;
        // 同 epoch 的更新必须递增；旧 idle、别的 command 和换代事实都不能充当本次完成。
        if (
          !sameOperation(next.operation, operation) ||
          next.epoch !== previous.epoch ||
          next.revision <= previous.revision
        ) {
          invalid(target, "Observation identity, epoch or order changed");
          return;
        }
        try {
          assertOutputSession(next.operation.session, operation.session, ctx);
        } catch {
          invalid(target, "Unauthorized observation update");
          return;
        }
        target.snapshot = next as OperationSnapshot<R>;
        check();
        if (finished) return;
        if (isOperationSettled(next.status)) {
          await close(feed);
          return;
        }
      }
      if (!finished) invalid(target, "Observation ended before operation settled");
    } catch (error) {
      if (!finished) invalid(target, error instanceof Error ? error.message : "Observation failed");
    }
  }
  // any 也必须先验证全部目标，不能用首个完成结果绕过另一个目标的权限拒绝。
  void Promise.all(
    targets.map(async (target) => ({
      target,
      grant: await authorize(
        ports.access,
        callContext,
        "waitSessions",
        sessionScope(target.operation.session) as S,
        target.operation.session,
      ),
    })),
  ).then((authorizedTargets) => {
    for (const { target, grant } of authorizedTargets) {
      if (!finished) void observe(target, grant).catch(fail);
    }
  }, fail);

  async function cleanup() {
    ctx.signal?.removeEventListener("abort", cancel);
    controller.abort();
    // 某个资源释放失败不能阻止其他 feed 释放，否则错误路径会留下观察订阅。
    const results = await Promise.allSettled([
      Promise.resolve().then(() => deadline.close()),
      ...[...feeds].map(close),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  return outcome.then(
    async (value) => {
      await cleanup();
      return value;
    },
    async (error) => {
      try {
        await cleanup();
      } catch {
        /* 保留导致等待失败的原始错误。 */
      }
      throw error;
    },
  );
}
