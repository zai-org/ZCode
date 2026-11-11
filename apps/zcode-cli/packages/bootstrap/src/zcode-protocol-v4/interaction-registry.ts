// v4 交互应答登记表（原生化，resolveInteraction）。
//
// 背景：conversation-product-protocol 的权限/AskUserQuestion 是「反向请求」——CLI 经
// context.requestClient 把请求推给客户端并 await 应答。旧客户端用 RPC RESPONSE 应答
// （resolveClientRequest 按 server-N id 收口）。v4 客户端不回 RPC response，而是发一条
// 前向 `resolveInteraction` COMMAND（先到先得，晚到 noop）。
//
// 本登记表是两条应答路径的汇合点：interaction-broker 发起反向请求时按业务 requestId
// （= v4 的 interactionId）注册一个 deferred，并让 requestClient 与该 deferred 竞态；
// v4 命令面（handlers/interaction-background.ts）拿到 resolveInteraction 后经本表
// resolve 对应 deferred，broker 侧的 Promise.race 立即用 v4 应答收口、abort 掉悬空的
// 反向 RPC。
//
// 分层：本表只做「按 id 找到 deferred 并投递应答」，不懂 permission/userInput 的 schema
// 差异——broker 注册时自带各自的 resolve 回调（闭包已知 kind），本表对应答体透明。
// 归属：本文件是 v4 原生基础设施（放 v4 目录），旧目录（broker/server）import 本文件
// 合法（依赖方向只允许 旧目录 → v4 目录）。
import { ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV } from "@zcode/shared";

export type V4InteractionAnswer = {
  optionId?: string;
  freeText?: string;
  // （elicitation 回执收敛，与 shared command.ts resolveInteraction
  // answer 同步）：action 存在时 broker 按 accept/decline/cancel 精确映射，
  // content 直传旧 userInput response 的 content 语义（多题答案/注解无损）。
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

export const ASK_USER_QUESTION_HIDDEN_GRACE_MS = 60_000;
export const ASK_USER_QUESTION_AUTO_RESOLUTION_MS = 300_000;
export interface V4InteractionRegistryOptions {
  hiddenGraceMs?: number;
  autoResolutionMs?: number;
  now?: () => number;
}

export function resolveV4InteractionRegistryOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): V4InteractionRegistryOptions | undefined {
  if (env.ZCODE_ENV !== "test") return undefined;
  const rawScale = env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV]?.trim();
  if (!rawScale) return undefined;
  const scale = Number(rawScale);
  if (!Number.isFinite(scale) || scale < 1 || scale > 1_000) {
    throw new Error(`${ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV} must be between 1 and 1000`);
  }
  return {
    hiddenGraceMs: Math.max(1, Math.round(ASK_USER_QUESTION_HIDDEN_GRACE_MS / scale)),
    autoResolutionMs: Math.max(1, Math.round(ASK_USER_QUESTION_AUTO_RESOLUTION_MS / scale)),
  };
}

export type V4InteractionAutoResolution =
  | {
      state: "hiddenGrace" | "visibleCountdown";
      startedAt: number;
      visibleAt: number;
      deadlineAt: number;
    }
  | {
      state: "snoozed";
      startedAt: number;
      snoozedAt: number;
    };

export interface V4InteractionRegistrationOptions {
  sessionId: string;
  kind: "askUserQuestion" | "pluginInstall" | "other";
  fullAccess?: (mode: "guarded" | "yolo") => Promise<void>;
  initialAutoResolution?: V4InteractionAutoResolution;
  onAutoResolutionUpdated?: (state: V4InteractionAutoResolution) => void | Promise<void>;
}

interface RegisteredInteraction {
  /** broker 侧回调：把 v4 answer 映射成对应 schema 的应答并 resolve 反向请求。 */
  resolve: (answer: V4InteractionAnswer) => void;
  options?: V4InteractionRegistrationOptions;
  autoResolution?: V4InteractionAutoResolution;
  /**
   * AskUserQuestion 注册时固化的计时资格。关闭后永久置 false，重新开启不会追溯旧问题。
   */
  fullAccessPending?: Promise<void>;
  autoResolutionEligible: boolean;
  visibleTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  token: symbol;
}

export class V4InteractionRegistry {
  private readonly pending = new Map<string, RegisteredInteraction>();
  private readonly queuesBySession = new Map<string, string[]>();
  private readonly hiddenGraceMs: number;
  private readonly autoResolutionMs: number;
  private readonly now: () => number;
  private askUserQuestionAutoResolutionEnabled = true;
  private interactionPreferenceCommandApplied = false;

  constructor(options: V4InteractionRegistryOptions = {}) {
    this.hiddenGraceMs = options.hiddenGraceMs ?? ASK_USER_QUESTION_HIDDEN_GRACE_MS;
    this.autoResolutionMs = options.autoResolutionMs ?? ASK_USER_QUESTION_AUTO_RESOLUTION_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * broker 发起反向请求时注册。返回注销函数（broker 在 finally 里调用，无论走 v4 还是
   * RPC-response 收口都清理，防泄漏）。同一 interactionId 重注册（reannounce 重发）覆盖
   * 旧回调——旧的反向请求已被 broker 的 race/abort 作废，指向最新一次等待。
   */
  register(
    interactionId: string,
    resolve: (answer: V4InteractionAnswer) => void,
    options?: V4InteractionRegistrationOptions,
  ): () => void {
    const previous = this.pending.get(interactionId);
    const token = Symbol(interactionId);
    if (previous) {
      this.clearTimers(previous);
    }
    const entry: RegisteredInteraction = {
      resolve,
      options,
      token,
      autoResolutionEligible:
        previous?.autoResolutionEligible ??
        (options?.kind === "askUserQuestion" ? this.askUserQuestionAutoResolutionEnabled : false),
      ...(previous?.autoResolution || options?.initialAutoResolution
        ? { autoResolution: previous?.autoResolution ?? options?.initialAutoResolution }
        : {}),
    };
    this.pending.set(interactionId, entry);
    if (options && !previous) {
      const queue = this.queuesBySession.get(options.sessionId) ?? [];
      queue.push(interactionId);
      this.queuesBySession.set(options.sessionId, queue);
    }
    if (options) {
      if (entry.autoResolution) {
        if (options.kind === "askUserQuestion" && !entry.autoResolutionEligible) {
          void this.convertToSnoozed(entry);
        } else {
          this.resumeAutoResolution(interactionId, entry);
        }
      } else {
        this.activateHead(options.sessionId);
      }
    }
    return () => {
      const current = this.pending.get(interactionId);
      if (!current || current.token !== token) return;
      this.remove(interactionId, current);
    };
  }

  /**
   * v4 resolveInteraction 命令收口：投递应答给等待中的 broker deferred。
   * 返回是否命中——未命中（已被应答/已注销/未知 id）时命令面按幂等成功收口
   * （proto.alreadyResolved 语义，多端先到先得，晚到应答无害）。
   */
  resolve(
    interactionId: string,
    answer: V4InteractionAnswer,
    expectedSessionId?: string | null,
    pluginDiscoveryUi = false,
  ): boolean {
    const entry = this.pending.get(interactionId);
    if (!entry || entry.fullAccessPending) return false;
    // 交互 ID 可由工具行得知。只有支持卡片的同会话输入才能消费 resolver，旧端不能代为批准/跳过。
    if (
      entry.options?.kind === "pluginInstall" &&
      (!pluginDiscoveryUi || entry.options.sessionId !== expectedSessionId)
    )
      return false;
    if (
      expectedSessionId !== undefined &&
      entry.options?.sessionId &&
      entry.options.sessionId !== expectedSessionId
    )
      return false;
    // 先删再 resolve：resolve 可能同步触发 broker finally 的注销，避免重入下重复投递。
    this.remove(interactionId, entry);
    entry.resolve(answer);
    return true;
  }

  /** 带权限副作用的应答只对已登记的同 session 能力开放；失败保留请求供重试。 */
  async resolvePermissionMode(
    interactionId: string,
    sessionId: string,
    mode: "guarded" | "yolo",
  ): Promise<boolean> {
    const entry = this.pending.get(interactionId);
    if (!entry) return false;
    if (entry.options?.sessionId !== sessionId || !entry.options.fullAccess) {
      throw new Error("Full access is not supported for this interaction");
    }
    if (entry.fullAccessPending) {
      await entry.fullAccessPending;
      // 并发请求共享事务，但只有取得应答权的命令能证明本端授权。
      return false;
    }
    const operation = entry.options.fullAccess(mode);
    entry.fullAccessPending = operation;
    try {
      await operation;
      if (this.pending.get(interactionId) !== entry) return false;
      this.remove(interactionId, entry);
      entry.resolve({ optionId: "allowOnce" });
      return true;
    } finally {
      delete entry.fullAccessPending;
    }
  }

  /** 首次有效操作永久暂停当前 AskUserQuestion 的自动结束；重复/迟到调用为 noop。 */
  async snoozeAutoResolution(interactionId: string): Promise<boolean> {
    const entry = this.pending.get(interactionId);
    if (
      !entry?.options ||
      entry.options.kind !== "askUserQuestion" ||
      !entry.autoResolution ||
      entry.autoResolution.state === "snoozed"
    ) {
      return false;
    }
    await this.convertToSnoozed(entry);
    return true;
  }

  /**
   * 更新全局 gate。关闭会同步取消所有 timer，并在 ACK 前等待活动倒计时持久化为 snoozed；
   * 重新开启只允许之后新注册的问题计时。
   */
  async setAskUserQuestionAutoResolutionEnabled(enabled: boolean): Promise<number> {
    this.interactionPreferenceCommandApplied = true;
    return this.applyAskUserQuestionAutoResolutionEnabled(enabled);
  }

  /**
   * session 启动握手只负责旧 Host 兼容和首个 runtime 的初值。显式 workspace 命令一旦
   * 到达，迟到的启动握手不得覆盖更晚的设置提交。
   */
  async initializeAskUserQuestionAutoResolutionEnabled(enabled: boolean): Promise<number> {
    if (this.interactionPreferenceCommandApplied) return 0;
    return this.applyAskUserQuestionAutoResolutionEnabled(enabled);
  }

  private async applyAskUserQuestionAutoResolutionEnabled(enabled: boolean): Promise<number> {
    this.askUserQuestionAutoResolutionEnabled = enabled;
    if (enabled) return 0;

    const persistence: Promise<void>[] = [];
    let snoozedInteractionCount = 0;
    for (const entry of this.pending.values()) {
      if (entry.options?.kind !== "askUserQuestion") continue;
      entry.autoResolutionEligible = false;
      if (entry.autoResolution && entry.autoResolution.state !== "snoozed") {
        snoozedInteractionCount += 1;
        persistence.push(this.convertToSnoozed(entry));
      }
    }
    await Promise.all(persistence);
    return snoozedInteractionCount;
  }

  has(interactionId: string): boolean {
    return this.pending.has(interactionId);
  }

  /** Resident 回收判定：该 session 是否仍有等待用户应答的交互（去激活会让应答落空）。 */
  hasPendingForSession(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.options?.sessionId === sessionId) return true;
    }
    return false;
  }

  private activateHead(sessionId: string): void {
    const queue = this.queuesBySession.get(sessionId);
    const interactionId = queue?.[0];
    if (!interactionId) return;
    const entry = this.pending.get(interactionId);
    if (
      !entry?.options ||
      entry.options.kind !== "askUserQuestion" ||
      !entry.autoResolutionEligible ||
      entry.autoResolution
    ) {
      return;
    }
    const startedAt = this.now();
    const visibleAt = startedAt + this.hiddenGraceMs;
    const deadlineAt = startedAt + this.autoResolutionMs;
    entry.autoResolution = {
      state: "hiddenGrace",
      startedAt,
      visibleAt,
      deadlineAt,
    };
    this.notifyAutoResolution(entry);
    this.scheduleActiveAutoResolution(interactionId, entry);
  }

  private resumeAutoResolution(interactionId: string, entry: RegisteredInteraction): void {
    const sessionId = entry.options?.sessionId;
    if (!sessionId || this.queuesBySession.get(sessionId)?.[0] !== interactionId) {
      return;
    }
    const autoResolution = entry.autoResolution;
    if (!autoResolution) return;
    if (autoResolution.state === "snoozed") {
      this.notifyAutoResolution(entry);
      return;
    }
    const now = this.now();
    if (now >= autoResolution.deadlineAt) {
      queueMicrotask(() => {
        this.resolve(interactionId, {
          action: "accept",
          content: { answers: {} },
        });
      });
      return;
    }
    if (autoResolution.state === "hiddenGrace" && now >= autoResolution.visibleAt) {
      entry.autoResolution = {
        ...autoResolution,
        state: "visibleCountdown",
      };
    }
    this.notifyAutoResolution(entry);
    this.scheduleActiveAutoResolution(interactionId, entry);
  }

  private scheduleActiveAutoResolution(interactionId: string, entry: RegisteredInteraction): void {
    const autoResolution = entry.autoResolution;
    if (!autoResolution || autoResolution.state === "snoozed") return;
    const now = this.now();
    if (autoResolution.state === "hiddenGrace") {
      entry.visibleTimer = setTimeout(
        () => {
          const current = this.pending.get(interactionId);
          if (current !== entry || current.autoResolution?.state !== "hiddenGrace") {
            return;
          }
          current.autoResolution = {
            state: "visibleCountdown",
            startedAt: autoResolution.startedAt,
            visibleAt: autoResolution.visibleAt,
            deadlineAt: autoResolution.deadlineAt,
          };
          this.notifyAutoResolution(current);
        },
        Math.max(0, autoResolution.visibleAt - now),
      );
    }
    entry.deadlineTimer = setTimeout(
      () => {
        this.resolve(interactionId, {
          action: "accept",
          content: { answers: {} },
        });
      },
      Math.max(0, autoResolution.deadlineAt - now),
    );
  }

  private notifyAutoResolution(entry: RegisteredInteraction): void {
    if (!entry.autoResolution) return;
    void entry.options?.onAutoResolutionUpdated?.(entry.autoResolution);
  }

  private async convertToSnoozed(entry: RegisteredInteraction): Promise<void> {
    const autoResolution = entry.autoResolution;
    if (!autoResolution || autoResolution.state === "snoozed") return;
    this.clearTimers(entry);
    entry.autoResolution = {
      state: "snoozed",
      startedAt: autoResolution.startedAt,
      snoozedAt: this.now(),
    };
    await entry.options?.onAutoResolutionUpdated?.(entry.autoResolution);
  }

  private clearTimers(entry: RegisteredInteraction): void {
    if (entry.visibleTimer) clearTimeout(entry.visibleTimer);
    if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
    delete entry.visibleTimer;
    delete entry.deadlineTimer;
  }

  private remove(interactionId: string, entry: RegisteredInteraction): void {
    this.pending.delete(interactionId);
    this.clearTimers(entry);
    const sessionId = entry.options?.sessionId;
    if (!sessionId) return;
    const queue = this.queuesBySession.get(sessionId);
    if (!queue) return;
    const index = queue.indexOf(interactionId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) {
      this.queuesBySession.delete(sessionId);
      return;
    }
    this.activateHead(sessionId);
  }
}
