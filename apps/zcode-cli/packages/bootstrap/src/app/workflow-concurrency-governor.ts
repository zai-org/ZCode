// ============================================================
// Workflow 并发治理器（进程级，按 provider key 分桶，**每个模型请求**准入）
// ============================================================
// 一个 CLI 进程里所有 run 加主代理
// 共用一个 provider 配额，所以治理器是**进程级**的：每个 `${providerId}/${modelId}` 一个桶，
// 桶里一台纯 AIMD 状态机（`ConcurrencyController`，@zcode/dynamic-workflow）+ 一条按 run 轮转的
// 准入队列。
//
// 闸门粒度是**模型请求的每一次尝试**：runner 每次尝试前 `acquire`、尝试结束 `release`，
// 退避 sleep 期间不持槽。ticket 就是该次尝试的状态事件汇：runner 把该尝试的
// `ModelNetworkStatus` 事件同时投递给 ticket，治理器从 ticket 上读结果。本方案
// **不**再用 adapter 级 `addStatusSink`——同一事件不能既经 ticket 又经 adapter sink 各喂一次。
//
// 这里是治理器里**唯一**会碰时钟与定时器的地方：控制器只收 `now`；冷却到期要唤醒等待者，
// 所以需要一个 setTimeout（可注入，unref）。

import { resolveWorkflowModelFailurePolicy, retryWaitJitterSpreadMs } from "@zcode/adapters/model";
import {
  ModelErrorCode,
  type ModelNetworkStatusEvent,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
  type ModelRequestFailedStatusEvent,
  type ModelRequestTarget,
} from "@zcode/contracts";
import {
  ConcurrencyController,
  type ConcurrencyChange,
  type ConcurrencyControllerSnapshot,
  type ConcurrencyThrottleReason,
} from "@zcode/dynamic-workflow";
import {
  resolveWorkflowDefaultConcurrency,
  WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR,
} from "./workflow-default-concurrency.js";

/** provider key：最具体的配额键。 */
export function workflowConcurrencyKey(model: ModelRequestTarget): string {
  return `${String(model.providerId)}/${String(model.modelId)}`;
}

/**
 * driver 看到的窄端口（不是整个治理器）。
 *
 * - `tryAdmit`：同步快路径——闸门开着**且没有任何人在排队**才给 ticket；否则 undefined，调用方再走
 *   `admit` 并报「等待槽位」。有等待者时不走快路径是公平性：否则一个请求密集的 run 会靠
 *   快路径越过别的 run 的队列。
 * - `admit`：排队（run 间轮转）直到 `inFlight < cap` 且不在 Retry-After 冷却；`signal` 被 abort 即
 *   出队并 reject（reject 原因是 `signal.reason`）。
 * - `subscribe`：本 run 触到的任何 key 上的 cap 变化。扇出只到**此刻在该 key 上有在飞或排队请求**的
 *   run（决策 8）。
 * - `setRunBound` / `clearRunBound`：本 run 自己的并发上界（launch 时登记、每次 retune 覆盖、launch
 *   结算时清掉）。它抬的是这个 run **用过的** key 的增长上限：`max(2D, 这些 run 的最大上界)`
 *   （docs/dynamic-workflow/concurrency.md「The governor」）——用户把一个 run 调到 40，桶的 cap 才
 *   爬得到 40，否则 40 个子代理会有一大半停在「等待槽位」。
 */
export interface WorkflowConcurrencyPort {
  tryAdmit(runId: string, key: string): ModelRequestAdmissionTicket | undefined;
  admit(runId: string, key: string, signal: AbortSignal): Promise<ModelRequestAdmissionTicket>;
  subscribe(runId: string, listener: (change: ConcurrencyChange) => void): () => void;
  setRunBound(runId: string, bound: number): void;
  clearRunBound(runId: string): void;
}

interface WorkflowConcurrencyGovernor extends WorkflowConcurrencyPort {
  /**
   * 主代理用的 admission：acquire 立即放行——不排队、不看冷却——但**计入 inFlight**
   * 且喂信号（它的请求 provider 同样看得见）。主代理的 turn 永不被 workflow 流量阻塞。
   * 只有它实现 `retryCooldownMs`：首次请求照常立刻发，重试时 runner 等到 max(本地退避, 剩余冷却)。
   */
  observer(): ModelRequestAdmission;
  /**
   * 主代理 subagent（`Agent` 工具，taskType `subagent_child`）用的 admission：和 workflow run 一样
   * 排队、看冷却、喂信号。一个父会话的全部 subagent 共用**一条**队列（run 身份
   * `\0subagents:<parentSessionId>`），在轮转里只占一份；不登记上界、不订阅、不进桶的 `runs`，
   * 会话结束后不留状态（docs/dynamic-workflow/concurrency.md「Where the port is bound」）。
   */
  sessionSubagents(parentSessionId: string): ModelRequestAdmission;
  /** 控制器只读快照；没有这个 key 的桶时为 undefined。 */
  snapshot(key: string): ConcurrencyControllerSnapshot | undefined;
}

interface WorkflowConcurrencyGovernorOptions {
  /** 默认并发 D：桶创建时的初值与空闲重置的落点；自动增长到 `2 × D`。进程启动时算一次。 */
  defaultConcurrency: number;
  /** 时钟（可注入）。 */
  now?: () => number;
  /** 定时器（可注入）：冷却到期唤醒等待者。返回取消函数。 */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** 限流类 retry 原因 → 控制器的 throttled 信号。 */
const THROTTLE_REASONS: ReadonlySet<string> = new Set<ConcurrencyThrottleReason>([
  "rate_limited",
  "provider_overloaded",
  "offpeak_queued",
]);
/** 不是 provider 失败的 retry 原因：既不减 cap 也不清 streak——只当尝试终结。 */
const NON_FAILURE_RETRY_REASONS: ReadonlySet<string> = new Set([
  "reasoning_signature_repair",
  "auth_refresh",
]);

interface Waiter {
  runId: string;
  resolve: (ticket: ModelRequestAdmissionTicket) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

interface Bucket {
  readonly key: string;
  readonly controller: ConcurrencyController;
  /** 每个 run 在飞（已准入未结算）的请求数（扇出的依据：有在飞或排队请求的 run 才收 cap 变化）。 */
  readonly inFlightByRun: Map<string, number>;
  /** 等待者按 run 分队列（run 间轮转，大 fan-out 不能饿死后来的小 run）。 */
  readonly queues: Map<string, Waiter[]>;
  /** 轮转游标：上一次放行的 run，下一次从它之后开始找。 */
  lastGrantedRun?: string;
  /**
   * 在这个 key 上请求过准入的 run（observer 与 subagent 池除外）。增长上限只看它们登记的上界：一个跑在别的
   * 模型上的大 run 不该抬这个 key。run 清掉上界时一并移出。
   */
  readonly runs: Set<string>;
  cancelCooldownWake?: () => void;
  /**
   * 估计冷却：`rate_limited` 重试**没带** Retry-After 时，按那个请求自己算出的退避（`delayMs`）估计 provider
   * 还要拒多久，取更晚者。**只给主代理（observer）的重试等待参考**（`retryCooldownMs`），不进控制器：
   * 闸门、排队者的冷却唤醒、cap 的增减都不读它，subagent 与 workflow 的准入行为不变。
   *
   * 为什么要它：线上 1302 的 Retry-After 时有时无（2026-11 按服务端看到的重试间隔推断：glm-5.3 的大多带、
   * glm-5.3-flash 的大多不带），不带时控制器的 `cooldownUntil` 永远不被设置，主代理的重试只能看见自己的本地退避。
   */
  estimatedCooldownUntil?: number;
}

/** observer（主代理）的 run 身份：不排队、不订阅，只在扇出过滤里作为「不是任何 run」出现。 */
const OBSERVER_RUN_ID = "\0observer";
/** 主代理 subagent 池的 run 身份前缀；`\0` 起头，和任何 workflow run id 都不会撞。 */
const SESSION_SUBAGENTS_RUN_PREFIX = "\0subagents:";
/**
 * 估计冷却的上限：与 runner 采信 Retry-After 的上限（`MAX_REASONABLE_RETRY_AFTER_MS`）同值，runner 叠加冷却时
 * 也再封顶一次。
 */
const MAX_ESTIMATED_COOLDOWN_MS = 5 * 60_000;
/**
 * 认「跟随者」时给的时间余量：runner 读冷却到 retry_scheduled 投递到 ticket 之间隔着日志与状态汇，
 * 实际只有几毫秒；留 1 秒足够，又远小于任何一次真实退避的增量。
 */
const ESTIMATE_FOLLOWER_SLACK_MS = 1_000;
/** runner 没给 signal 时的占位：永不 abort（用户取消走请求自己的 signal）。 */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // 不让一个等冷却的定时器把进程钉住：run 结束、进程要退出时它不该有投票权。
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

export function createWorkflowConcurrencyGovernor(
  options: WorkflowConcurrencyGovernorOptions,
): WorkflowConcurrencyGovernor {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const buckets = new Map<string, Bucket>();
  /** run 级订阅（不按 key）：扇出时按桶的 engaged 集合过滤。 */
  const listeners = new Map<string, Set<(change: ConcurrencyChange) => void>>();
  const baseGrowthLimit = WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR * options.defaultConcurrency;
  /** 在飞 run 登记的自有上界（setRunBound / clearRunBound）。 */
  const runBounds = new Map<string, number>();

  const bucketFor = (key: string): Bucket => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      // 惰性建桶，初值 = 默认并发；此后 run 来来去去都不重置它（只有空闲 5 分钟会，决策 19/20）。
      bucket = {
        key,
        controller: new ConcurrencyController(key, options.defaultConcurrency, baseGrowthLimit),
        inFlightByRun: new Map(),
        queues: new Map(),
        runs: new Set(),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const waiterCount = (bucket: Bucket): number => {
    let total = 0;
    for (const queue of bucket.queues.values()) total += queue.length;
    return total;
  };

  /**
   * 扇出：只给此刻在该 key 上有在飞或排队请求的 run（决策 8）；`alsoTo` 另加一批收件人（上界引起的
   * 变化要到在这个 key 上登记着的 run，见 refreshGrowthLimit）。
   */
  const fanOut = (
    bucket: Bucket,
    changes: ConcurrencyChange[],
    alsoTo?: ReadonlySet<string>,
  ): void => {
    if (changes.length === 0) return;
    for (const [runId, set] of listeners) {
      const engaged =
        (bucket.inFlightByRun.get(runId) ?? 0) > 0 ||
        (bucket.queues.get(runId)?.length ?? 0) > 0 ||
        alsoTo?.has(runId) === true;
      if (!engaged) continue;
      for (const change of changes) {
        for (const listener of set) listener(change);
      }
    }
  };

  /**
   * 重算一个桶的增长上限：`max(2D, 用过它的 run 里登记过的最大上界)`，并在同一刻试着**起跳**到那个
   * 最大上界（docs/dynamic-workflow/concurrency.md「Seeding」）：用户把 run 调到 32，cap 就当场是
   * 32，而不是每四次成功爬一级。压低到 cap 之下时控制器当场拉低 cap（`limit_lowered`）；起跳在五分钟
   * 内被拒过时由控制器拒绝（`seeded` 不发），cap 照常爬。
   *
   * 这两种变化的起因是某个 run 的上界，而不是某个请求，所以扇出除了此刻 engaged 的 run，还要到
   * 每个在这个 key 上登记着的 run——retune 的那一刻，调高的那个 run 很可能一个请求都不在飞。
   */
  const refreshGrowthLimit = (bucket: Bucket): void => {
    let largestBound: number | undefined;
    for (const runId of bucket.runs) {
      const bound = runBounds.get(runId);
      if (bound !== undefined && (largestBound === undefined || bound > largestBound)) {
        largestBound = bound;
      }
    }
    const limit = Math.max(baseGrowthLimit, largestBound ?? 0);
    const changes =
      limit === bucket.controller.snapshot().growthLimit
        ? []
        : bucket.controller.setGrowthLimit(now(), limit);
    if (largestBound !== undefined) changes.push(...bucket.controller.seed(now(), largestBound));
    fanOut(bucket, changes, bucket.runs);
  };

  /** 一个 run 第一次在这个 key 上请求准入：记下它，它登记过的上界从此算进这个桶。 */
  const noteRunUsed = (bucket: Bucket, runId: string): void => {
    if (bucket.runs.has(runId)) return;
    bucket.runs.add(runId);
    if (runBounds.has(runId)) refreshGrowthLimit(bucket);
  };

  const bumpInFlight = (bucket: Bucket, runId: string, delta: number): void => {
    const next = (bucket.inFlightByRun.get(runId) ?? 0) + delta;
    if (next <= 0) bucket.inFlightByRun.delete(runId);
    else bucket.inFlightByRun.set(runId, next);
  };

  /**
   * 记一次缺 Retry-After 的限流的估计冷却（见 `Bucket.estimatedCooldownUntil`）；封顶 5 分钟。
   *
   * 不记「跟随者」：桶上已有冷却，而这次的等待落在「已有冷却 + 抖动档」之内。那是主代理按冷却等、再往后加了
   * 抖动的重试（runner-retry.ts `retryDelayWithAdmissionCooldown`），它的 `delayMs` 不是新的限流证据。
   * 记下来会让冷却每被跟随一次就往后推一段抖动，几个主会话互相跟随就能把冷却越推越远。代价是：一次真实退避
   * 恰好只比已有冷却晚不到「抖动档 + 1 秒」时不被记下，最多少等这么一点。
   */
  const noteEstimatedCooldown = (bucket: Bucket, delayMs: number): void => {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    const at = now();
    const until = at + Math.min(delayMs, MAX_ESTIMATED_COOLDOWN_MS);
    const existing = Math.max(
      bucket.controller.snapshot().cooldownUntil ?? 0,
      bucket.estimatedCooldownUntil ?? 0,
    );
    if (
      existing > at &&
      until <= existing + retryWaitJitterSpreadMs(delayMs) + ESTIMATE_FOLLOWER_SLACK_MS
    ) {
      return;
    }
    bucket.estimatedCooldownUntil = Math.max(bucket.estimatedCooldownUntil ?? 0, until);
  };

  /**
   * 主代理重试前还要等多久：控制器的 Retry-After 冷却与估计冷却取更晚者，减去 now，≤0 即 0。只读：不建桶、
   * 不做空闲重置、不扇出。
   */
  const retryCooldownMs = (key: string): number => {
    const bucket = buckets.get(key);
    if (bucket === undefined) return 0;
    const until = Math.max(
      bucket.controller.snapshot().cooldownUntil ?? 0,
      bucket.estimatedCooldownUntil ?? 0,
    );
    return Math.max(0, until - now());
  };

  /**
   * 一次已准入尝试的 ticket：事件映射保持一致。任一终结映射后结算（幂等）；`release()`
   * 未见终结事件即按 `ended` 处理。结算后的 publish / release 一律惰性——runner 在极少数路径上
   * （尝试已结束后的兜底事件）可能仍会投递。
   */
  const mintTicket = (bucket: Bucket, runId: string, epoch: number): ModelRequestAdmissionTicket => {
    let settled = false;
    const settle = (signal: (at: number) => ConcurrencyChange[]): void => {
      if (settled) return;
      settled = true;
      const changes = signal(now());
      // 先扇出再减在飞：产生这条变化的请求正是本 run 的，它此刻仍算 engaged——否则一个 run 唯一的
      // 在飞请求撞出的减半，会因为「已经不在飞」而漏发给它自己。
      fanOut(bucket, changes);
      bumpInFlight(bucket, runId, -1);
      // 结算释放了一个名额（或改了 cap），排队者可能可以放行。
      drain(bucket);
    };
    return {
      publish(event: ModelNetworkStatusEvent) {
        if (settled) return;
        switch (event.type) {
          case "model_request_started":
            // 准入时已计入 inFlight，这里没有新信息。
            return;
          case "model_request_completed":
            settle((at) => bucket.controller.succeeded(at, epoch));
            return;
          case "model_retry_scheduled": {
            const reason: string = event.reason;
            if (NON_FAILURE_RETRY_REASONS.has(reason)) {
              settle((at) => bucket.controller.ended(at));
              return;
            }
            if (THROTTLE_REASONS.has(reason)) {
              if (reason === "rate_limited" && event.retryAfterMs === undefined) {
                noteEstimatedCooldown(bucket, event.delayMs);
              }
              settle((at) =>
                bucket.controller.throttled(
                  at,
                  epoch,
                  reason as ConcurrencyThrottleReason,
                  event.retryAfterMs,
                ),
              );
              return;
            }
            settle((at) => bucket.controller.failedTransient(at));
            return;
          }
          case "model_request_failed":
            // retryable:true 的 failed 紧随一条 retry_scheduled——那条才是信号。
            if (event.retryable) return;
            // Stop 集（配额、认证…）不是并发信号，只终结尝试。曾经配额 429 走下面的限流分支：
            // 1308 带的 Retry-After 指到额度窗口结束（可达数小时），冷却冻住整个桶、活得比停下的 run
            // 还久；用户用重置卡恢复额度后 resume，子代理全卡在闸门上一个请求不发，主代理（observer
            // 不看冷却）却照常工作，换模型（换桶）才继续。何时再试由用户决定，与 driver 读同一张策略表。
            if (isWorkflowStopFailure(event)) {
              settle((at) => bucket.controller.ended(at));
              return;
            }
            // 不可重试的限流：
            // 主对话 / 工具侧撞上 3008 这类被分类器判终止的 429，仍是一次字面意义上的并发信号——
            // 只当「链结束」会让 cap 从未因它降过。
            if (event.reason === "rate_limited") {
              settle((at) =>
                bucket.controller.throttled(at, epoch, "rate_limited", event.retryAfterMs),
              );
              return;
            }
            settle((at) => bucket.controller.ended(at));
            return;
          default:
            return;
        }
      },
      release() {
        settle((at) => bucket.controller.ended(at));
      },
    };
  };

  /** 放行一个请求：`observe` 在前（准入也是一次「信号」），再 `admitted` 拿 epoch。 */
  const grant = (bucket: Bucket, runId: string): ModelRequestAdmissionTicket => {
    fanOut(bucket, bucket.controller.observe(now()));
    const epoch = bucket.controller.admitted(now());
    bumpInFlight(bucket, runId, 1);
    bucket.lastGrantedRun = runId;
    return mintTicket(bucket, runId, epoch);
  };

  /** 按轮转挑下一个有等待者的 run。 */
  const nextRunWithWaiters = (bucket: Bucket): string | undefined => {
    const runs = [...bucket.queues.keys()].filter((runId) => (bucket.queues.get(runId)?.length ?? 0) > 0);
    if (runs.length === 0) return undefined;
    const last = bucket.lastGrantedRun;
    const lastIndex = last === undefined ? -1 : runs.indexOf(last);
    return runs[(lastIndex + 1) % runs.length];
  };

  const armCooldownWake = (bucket: Bucket): void => {
    bucket.cancelCooldownWake?.();
    bucket.cancelCooldownWake = undefined;
    if (waiterCount(bucket) === 0) return;
    const until = bucket.controller.snapshot().cooldownUntil;
    if (until === undefined) return;
    const delay = Math.max(0, until - now());
    bucket.cancelCooldownWake = schedule(() => {
      bucket.cancelCooldownWake = undefined;
      drain(bucket);
    }, delay);
  };

  /** 放行尽可能多的等待者（闸门：inFlight < cap 且不在冷却），喂 waiters，必要时定冷却闹钟。 */
  const drain = (bucket: Bucket): void => {
    fanOut(bucket, bucket.controller.observe(now()));
    for (;;) {
      fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
      if (!bucket.controller.canAdmit(now())) break;
      const runId = nextRunWithWaiters(bucket);
      if (runId === undefined) break;
      const queue = bucket.queues.get(runId)!;
      const waiter = queue.shift()!;
      if (queue.length === 0) bucket.queues.delete(runId);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(grant(bucket, runId));
    }
    fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
    armCooldownWake(bucket);
  };

  /** 快路径的本体；`trackRun` 为 false 时（subagent 池）不把 run 记进桶的 `runs`。 */
  const tryAdmitIn = (
    bucket: Bucket,
    runId: string,
    trackRun: boolean,
  ): ModelRequestAdmissionTicket | undefined => {
    if (trackRun) noteRunUsed(bucket, runId);
    fanOut(bucket, bucket.controller.observe(now()));
    if (waiterCount(bucket) > 0 || !bucket.controller.canAdmit(now())) return undefined;
    return grant(bucket, runId);
  };

  /** 排队的本体；`trackRun` 同上。 */
  const admitIn = (
    bucket: Bucket,
    runId: string,
    signal: AbortSignal,
    trackRun: boolean,
  ): Promise<ModelRequestAdmissionTicket> => {
    if (signal.aborted) return Promise.reject(abortedError(signal));
    if (trackRun) noteRunUsed(bucket, runId);
    return new Promise<ModelRequestAdmissionTicket>((resolve, reject) => {
      const waiter: Waiter = { runId, resolve, reject, signal, onAbort: () => {} };
      waiter.onAbort = () => {
        const queue = bucket.queues.get(runId);
        if (queue !== undefined) {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          if (queue.length === 0) bucket.queues.delete(runId);
        }
        reject(abortedError(signal));
        fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
        armCooldownWake(bucket);
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      const queue = bucket.queues.get(runId) ?? [];
      queue.push(waiter);
      bucket.queues.set(runId, queue);
      drain(bucket);
    });
  };

  const tryAdmit: WorkflowConcurrencyPort["tryAdmit"] = (runId, key) =>
    tryAdmitIn(bucketFor(key), runId, true);

  const admit: WorkflowConcurrencyPort["admit"] = (runId, key, signal) =>
    admitIn(bucketFor(key), runId, signal, true);

  const subscribe: WorkflowConcurrencyPort["subscribe"] = (runId, listener) => {
    const set = listeners.get(runId) ?? new Set();
    set.add(listener);
    listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(runId);
    };
  };

  const setRunBound: WorkflowConcurrencyPort["setRunBound"] = (runId, bound) => {
    runBounds.set(runId, bound);
    for (const bucket of buckets.values()) {
      if (bucket.runs.has(runId)) refreshGrowthLimit(bucket);
    }
  };

  const clearRunBound: WorkflowConcurrencyPort["clearRunBound"] = (runId) => {
    runBounds.delete(runId);
    for (const bucket of buckets.values()) {
      if (bucket.runs.delete(runId)) refreshGrowthLimit(bucket);
    }
  };

  // 首次请求不排队、不看冷却（决策 37/47）：用户自己的对话永不排在 workflow 后面；observe 在 grant 里。
  // 快路径总命中，所以 runner 永远不会为主代理的请求发 queued / admitted（决策 44）。
  // 重试时参考冷却：runner 在退避里读 `retryCooldownMs`，等待取 max(本地退避, 剩余冷却)——冷却期里的重试
  // 几乎一定还是 1302，只会白白耗掉重试次数（docs/dynamic-workflow/concurrency.md「Where the port is bound」）。
  const observerAdmission: ModelRequestAdmission = {
    tryAcquire: ({ model }) => grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID),
    acquire: ({ model }) =>
      Promise.resolve(grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID)),
    retryCooldownMs: ({ model }) => retryCooldownMs(workflowConcurrencyKey(model)),
  };

  // 修复原因：subagent 曾继承父的 observer，一轮并行十个 Agent 调用就是十路既不排队也不看
  // Retry-After 的请求，各自退避重试——线上 1302 的最大来源（2026-10-20 抽样占 46%），还连带把
  // workflow 和用户自己的 turn 一起拒掉。subagent 是委派出去的工作，和 workflow subagent 同类，
  // 所以过同一道闸门；用户自己的 turn 仍是 observer。
  const sessionSubagents = (parentSessionId: string): ModelRequestAdmission => {
    const runId = `${SESSION_SUBAGENTS_RUN_PREFIX}${parentSessionId}`;
    return {
      tryAcquire: ({ model }) => tryAdmitIn(bucketFor(workflowConcurrencyKey(model)), runId, false),
      acquire: ({ model, signal }) =>
        admitIn(bucketFor(workflowConcurrencyKey(model)), runId, signal ?? NEVER_ABORTED, false),
    };
  };

  return {
    tryAdmit,
    admit,
    subscribe,
    setRunBound,
    clearRunBound,
    observer: () => observerAdmission,
    sessionSubagents,
    snapshot(key) {
      return buckets.get(key)?.controller.snapshot();
    },
  };
}

/**
 * 不可重试的失败是否落在 workflow 策略表的 Stop 集里（docs/dynamic-workflow/concurrency.md
 * 「Retry budget and the model-error policy」）。runner 与 driver 读的是同一个函数，三层对 Stop 集的
 * 判断不会分叉；缺 `errorCode` 时按通用请求失败读，配额判定只看业务码。
 */
function isWorkflowStopFailure(event: ModelRequestFailedStatusEvent): boolean {
  return (
    resolveWorkflowModelFailurePolicy(
      {
        code: event.errorCode ?? ModelErrorCode.ModelRequestFailed,
        reason: event.reason,
        retryable: event.retryable,
      },
      event.providerErrorCode,
    ).decision === "stop"
  );
}

function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error("workflow request admission aborted");
}

let processGovernor: WorkflowConcurrencyGovernor | undefined;

/**
 * 进程级单例（决策 5）：默认并发在首次取用时算一次；此后每个 app（会话）的主 runtime 挂它的
 * observer，run service 拿同一个端口给 driver。
 */
export function getWorkflowConcurrencyGovernor(): WorkflowConcurrencyGovernor {
  processGovernor ??= createWorkflowConcurrencyGovernor({
    defaultConcurrency: resolveWorkflowDefaultConcurrency(),
  });
  return processGovernor;
}
