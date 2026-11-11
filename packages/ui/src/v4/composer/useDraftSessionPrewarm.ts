/* oxlint-disable eslint(max-lines) -- draft prewarm 的创建、复用、回收和首帧 ModelSelection 必须共享同一 owner 状态机；拆到多文件会让 StrictMode/transport 换代清理时序更难审计。 */
// 草稿态 v4 draft session 预热。
//
// 背景：草稿态没有任何 session 在册时，配置面被迫走 workspace-default 旧 RPC，
// 其回包 buildWorkspaceState 每次临建完整 app（140-798ms/次）；首发也要现场
// createSession。v4 协议本就保留 phase=draft 会话实体（「pane 绑 draft
// session 则服务端已有会话实体」）——本模块在 pane 未绑定会话时后台建一个
// draft session 作预热载体：配置写走 v4 CAS 命令直达会话、首发 sendText 复用、
// 未使用则清理。纯内存不落盘，CLI 重启即消失；gateway isDraftSession 过滤保证
// 它不会以「新任务」漏进 sessions-index 侧栏。
//
// 结构：生命周期收敛在纯控制器 startDraftSessionPrewarm（可单测，无 React 依赖），
// useDraftSessionPrewarm 只做 effect 接线与 owner-scoped binding 暴露。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CommandAck, CommandType, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

type DispatchCommand = (
  type: CommandType,
  payload: Record<string, unknown>,
  targetSessionId: string | null,
) => Promise<CommandAck>;

export interface DraftPrewarmController {
  /** 首条 admission 命令已发出、ACK 未收口；dispose 不得删除结果未知的会话。 */
  markPromotionPending(): void;
  /** 首发成功后标记（dispose 不再删除已提升的会话）。 */
  markPromoted(): void;
  /** 会话失效（订阅错误/sendText 被拒）后标记（dispose 不发 deleteSession——会话多半已不存在）。 */
  markDiscarded(): void;
  /**
   * 生命周期终点（effect cleanup / 切 workspace / 绑定真实会话）：
   * 已建且未提升未失效 → deleteSession 清理；创建仍在飞 → ack 到达时就地删除。
   */
  dispose(): void;
}

/** 预热生命周期纯控制器：创建 → onReady 上抛 → dispose 决策清理。 */
export function startDraftSessionPrewarm(params: {
  workspaceKey: string;
  dispatchCommand: DispatchCommand;
  onReady: (sessionId: string) => void;
  /** single-flight owner 用于等待不可取消的 createSession 收口；无论成功失败都只调用一次。 */
  onSettled?: () => void;
  /** 预热会话初始 config（全局「上次选择」，同步解析）；让投影首帧即全局、不闪。 */
  resolveInitialConfig?: () => Partial<SessionConfigState> | undefined;
}): DraftPrewarmController {
  const { workspaceKey, dispatchCommand, onReady, onSettled, resolveInitialConfig } = params;
  let disposed = false;
  let promotionState: "draft" | "pending" | "promoted" | "discarded" = "draft";
  let createdSessionId: string | null = null;

  const deleteCreatedSession = (sessionId: string) => {
    void dispatchCommand("deleteSession", {}, sessionId)
      .then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn("[v4-draft-prewarm] 清理预热会话被拒", {
            sessionId,
            status: ack.status,
            reasonCode: ack.reasonCode ?? null,
          });
        }
      })
      .catch(() => {
        // 清理失败无碍：内存会话随 CLI 退出消失。
      });
  };

  const createPayload = () => {
    const createPayload: Record<string, unknown> = { workspaceId: workspaceKey };
    const initialConfig = resolveInitialConfig?.();
    if (initialConfig && Object.keys(initialConfig).length > 0) {
      // 预热会话首帧即用全局模型（CLI 归并 createSession.config），不闪 workspace 缺省。
      createPayload.config = initialConfig;
    }
    return createPayload;
  };
  const dispatchCreateSession = () => {
    const createSessionPayload = createPayload();
    if (disposed) {
      return Promise.resolve(null);
    }
    return dispatchCommand("createSession", createSessionPayload, null);
  };
  const createSessionAck = dispatchCreateSession();
  void createSessionAck
    .then((ack) => {
      if (!ack) {
        return;
      }
      if (ack.status !== "accepted" || ack.result?.type !== "createSession") {
        logger.warn("[v4-draft-prewarm] createSession 被拒", {
          status: ack.status,
          reasonCode: ack.reasonCode ?? null,
          workspaceKey,
        });
        return;
      }
      createdSessionId = ack.result.sessionId;
      if (disposed) {
        // 极快切走时创建无法取消：ACK 到达后就地删除，避免遗留内存会话。
        deleteCreatedSession(createdSessionId);
        return;
      }
      logger.info("[v4-draft-prewarm] draft session 预热就绪", {
        sessionId: createdSessionId,
        workspaceKey,
      });
      onReady(createdSessionId);
    })
    .catch((error) => {
      logger.warn("[v4-draft-prewarm] createSession 失败", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
    })
    .finally(() => {
      onSettled?.();
    });

  return {
    markPromotionPending() {
      if (promotionState === "draft") {
        promotionState = "pending";
      }
    },
    markPromoted() {
      promotionState = "promoted";
    },
    markDiscarded() {
      if (promotionState !== "promoted") {
        promotionState = "discarded";
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Agent 可在 MCP 初始化期间先 admission 首发，而 renderer 仍等待 ACK；
      // 此时 owner cleanup 若按普通 draft 删除，会关闭已经运行的 execution adapter。
      // 只有从未开始 promotion 的 draft 才能安全自动回收，pending 必须等待原命令收口。
      if (createdSessionId && promotionState === "draft") {
        deleteCreatedSession(createdSessionId);
      }
    },
  };
}

export interface DraftSessionPrewarm {
  /** 当前 workspace/transport generation 已就绪的预热 binding。 */
  binding: DraftPrewarmBinding | null;
  /** 首发等待本 owner 当前创建任务；失败或换代即拒绝，不在发送路径另建会话。 */
  waitForSession(): Promise<DraftPrewarmBinding>;
}

export interface DraftPrewarmBinding {
  workspaceKey: string;
  sessionId: string;
  /** 页面保活独立于展示订阅；换代时通知页面撤销，首发提升不撤销。 */
  retain(onInvalidated: () => void): () => void;
  /** 首条 admission 命令发出前同步占住生命周期；false 表示 binding 已不是当前 owner。 */
  beginPromotion(): boolean;
  /** 首发成功后标记（阻止清理路径 deleteSession 已提升的会话）。 */
  promote(): void;
  /** 订阅错误 / sendText 被拒后丢弃；只影响创建本 binding 的 controller。 */
  discard(): void;
}

interface DraftPrewarmSubscriber {
  generation: object;
  invalidationVersion: number;
  onBinding: (binding: DraftPrewarmBinding | null) => void;
}

interface DraftPrewarmCurrent {
  retainers: Set<() => void>;
  invalidationVersion: number;
  controller: DraftPrewarmController;
  binding: DraftPrewarmBinding | null;
  settled: boolean;
  completion: Promise<void>;
  retiring: boolean;
  /** 本代是第几次退避重试的产物；0 表示首发。 */
  retryAttempt: number;
}

/**
 * createSession 失败后的退避重试节奏。
 *
 * CUA Helper ready 会触发 workspace-dispose 回收，正在飞的 createSession 被
 * client disposed 打断；只 warn 一次会永久「回落无预热路径」，草稿态从此拿不到
 * sessionId，粘贴的图片永远停在 waitingSession（进度 0%）。回收是瞬态的，隔一会儿重试即可
 * 成功，所以这里做有界退避而不是放弃。
 */
const PREWARM_RETRY_DELAYS_MS = [500, 1000, 2000];

/**
 * 同一逻辑 draft pane 的预热协调器。
 *
 * createSession 不能直接绑在 React effect 实例上。effect cleanup 无法取消已经
 * 发出的协议请求，新 effect 却会立刻再发一个 createSession；Agent 的全局 FIFO 因而被同一草稿
 * 的多个慢创建占满。协调器跨同步重挂保留 owner，并在旧创建 ACK 前阻止下一代创建入队。
 */
class DraftSessionPrewarmCoordinator {
  private readonly subscribers = new Map<symbol, DraftPrewarmSubscriber>();
  private current: DraftPrewarmCurrent | null = null;
  private blockedInvalidationVersion: number | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private dispatchCommand: DispatchCommand;
  private resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined;

  constructor(
    private readonly workspaceKey: string,
    dispatchCommand: DispatchCommand,
    resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined,
    private readonly onEmpty: () => void,
  ) {
    this.dispatchCommand = dispatchCommand;
    this.resolveInitialConfig = resolveInitialConfig;
  }

  update(
    dispatchCommand: DispatchCommand,
    resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined,
  ): void {
    this.dispatchCommand = dispatchCommand;
    this.resolveInitialConfig = resolveInitialConfig;
  }

  async waitForSession(
    invalidationVersion: number,
    generation: object,
  ): Promise<DraftPrewarmBinding> {
    const assertCurrentSubscriber = () => {
      if (
        this.requestedInvalidationVersion() !== invalidationVersion ||
        !Array.from(this.subscribers.values()).some(
          (subscriber) => subscriber.generation === generation,
        )
      )
        throw new Error("草稿会话已切换，请重新发送");
    };
    assertCurrentSubscriber();
    // 新草稿已接管时，旧创建仍可能在回收；这是等待窗口，不是用户再次切换。
    // 资格绑定本次订阅，防止相同版本的离开/重进让旧提交借新草稿继续发送。
    if (this.current?.retiring) {
      await this.current.completion;
      assertCurrentSubscriber();
    }
    // 已确定失败/失效后，用户再次点击可以重试；仍由 owner 创建并合并并发等待者，
    // 不能因后台重试耗尽就让当前草稿永久无法发送。
    if (this.current?.settled && !this.current.binding) {
      this.clearRetryTimer();
      this.blockedInvalidationVersion = null;
      this.current = null;
      this.startCurrent(invalidationVersion);
    }
    const current = this.current;
    if (!current) throw new Error("草稿会话尚未开始创建");
    // Bug 根因：binding=null 同时表示创建在途和失败，首发据此另建会话会与预热并发。
    // 创建只归此 owner；等待捕获的一代，不能在 await 后悄悄换成另一个会话发送。
    await current.completion;
    assertCurrentSubscriber();
    if (
      this.current !== current ||
      current.retiring ||
      current.invalidationVersion !== invalidationVersion ||
      this.requestedInvalidationVersion() !== invalidationVersion
    )
      throw new Error("草稿会话已切换，请重新发送");
    if (!current.binding) throw new Error("草稿会话创建失败，请重试");
    return current.binding;
  }

  acquire(params: {
    generation: object;
    invalidationVersion: number;
    onBinding: (binding: DraftPrewarmBinding | null) => void;
  }): () => void {
    if (this.cleanupTimer !== null) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const token = Symbol("draft-prewarm-subscriber");
    this.subscribers.set(token, params);
    this.reconcile();
    this.emitBindingTo(params);

    return () => {
      if (!this.subscribers.delete(token) || this.subscribers.size > 0) {
        return;
      }
      // React StrictMode 和同 key 同步重挂会先 cleanup 再重新执行 effect。延迟到下一任务确认
      // 是否真的离开，避免“create → cleanup delete → create”的协议 churn。
      this.cleanupTimer = setTimeout(() => {
        this.cleanupTimer = null;
        if (this.subscribers.size > 0 || this.current?.retainers.size) {
          return;
        }
        this.retireCurrent();
        if (!this.current) {
          this.onEmpty();
        }
      }, 0);
    };
  }

  private requestedInvalidationVersion(): number | null {
    let latest: number | null = null;
    for (const subscriber of this.subscribers.values()) {
      latest =
        latest === null
          ? subscriber.invalidationVersion
          : Math.max(latest, subscriber.invalidationVersion);
    }
    return latest;
  }

  private reconcile(): void {
    const requestedVersion = this.requestedInvalidationVersion();
    if (requestedVersion === null) {
      return;
    }
    if (
      this.blockedInvalidationVersion !== null &&
      this.blockedInvalidationVersion !== requestedVersion
    ) {
      this.blockedInvalidationVersion = null;
    }
    if (this.current) {
      if (!this.current.retiring && this.current.invalidationVersion === requestedVersion) {
        return;
      }
      this.retireCurrent();
      // createSession 已经发出时不可取消；onSettled 会在 ACK 后先排 delete，再只启动最新代。
      if (this.current) {
        return;
      }
    }
    if (this.blockedInvalidationVersion === requestedVersion) {
      return;
    }
    this.startCurrent(requestedVersion);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * createSession 收口却没拿到 binding = 失败（被拒或异常）。回收导致的 client disposed 是
   * 瞬态的，按退避重排一次创建；用尽后保留失败态，由下一次生命周期失效重新创建。
   */
  private scheduleRetryAfterFailure(failed: DraftPrewarmCurrent): void {
    const delay = PREWARM_RETRY_DELAYS_MS[failed.retryAttempt];
    if (delay === undefined) return;
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.current !== failed || failed.retiring || failed.binding !== null) return;
      if (this.subscribers.size === 0) return;
      const requestedVersion = this.requestedInvalidationVersion();
      if (requestedVersion === null || this.blockedInvalidationVersion === requestedVersion) return;
      // 释放失败的一代，让下一代能通过 reconcile 的单飞闸。
      this.current = null;
      this.startCurrent(requestedVersion, failed.retryAttempt + 1);
    }, delay);
  }

  private startCurrent(invalidationVersion: number, retryAttempt = 0): void {
    let current!: DraftPrewarmCurrent;
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const controller = startDraftSessionPrewarm({
      workspaceKey: this.workspaceKey,
      dispatchCommand: (type, payload, targetSessionId) =>
        this.dispatchCommand(type, payload, targetSessionId),
      resolveInitialConfig: () => this.resolveInitialConfig?.(),
      onReady: (sessionId) => {
        if (this.current !== current || current.retiring) {
          return;
        }
        let binding!: DraftPrewarmBinding;
        binding = {
          workspaceKey: this.workspaceKey,
          sessionId,
          retain: (onInvalidated) => {
            if (this.current !== current || current.retiring || current.binding !== binding)
              throw new Error("草稿会话已失效");
            const invalidate = () => onInvalidated();
            current.retainers.add(invalidate);
            return () => {
              if (!current.retainers.delete(invalidate)) return;
              if (
                this.current === current &&
                !current.retiring &&
                !current.retainers.size &&
                !this.subscribers.size
              ) {
                this.retireCurrent();
                if (!this.current) this.onEmpty();
              }
            };
          },
          beginPromotion: () => {
            if (this.current !== current || current.binding !== binding) {
              return false;
            }
            current.controller.markPromotionPending();
            return true;
          },
          promote: () => {
            if (this.current !== current || current.binding !== binding) {
              return;
            }
            current.controller.markPromoted();
            // 页面可继续持有原 session；草稿槽位必须立即脱离，不能等页面引用释放。
            current.binding = null;
            current.retiring = true;
            this.current = null;
            // 修复原因：这里原先向订阅者推 null，pane 的预热会话 id 立即清空；正式 sessionId 要等
            // Shell 提交新任务（任务树刷新 + 导航）后才到达。E2E 日志实测两者之间约 260ms 没有有效会话：
            // 会话 lease 退回 keep-warm 再重新取回，插件 UI 与扩展的屏幕会话报告在这段时间消失。
            // 修法：提升时不再通知当前订阅者，它保留已提升的 binding，直到 pane 绑定正式会话
            // （sessionId 非空 → 预热停用 → generation 换代，binding 随之失效）。
            // useSessionPaneLease 的「草稿晋升复用预热 lease」由此成立，交接期间有效会话不变。
          },
          discard: () => {
            if (this.current !== current || current.binding !== binding) {
              return;
            }
            current.controller.markDiscarded();
            current.binding = null;
            this.blockedInvalidationVersion = current.invalidationVersion;
            const retainers = [...current.retainers];
            current.retainers.clear();
            for (const invalidate of retainers) invalidate();
            this.emitBindings();
          },
        };
        current.binding = binding;
        this.emitBindings();
      },
      onSettled: () => {
        current.settled = true;
        complete();
        if (this.current !== current || !current.retiring) {
          // 未被 retire 却没拿到 binding = createSession 失败；瞬态回收可退避重试。
          if (this.current === current && !current.retiring && current.binding === null) {
            this.scheduleRetryAfterFailure(current);
          }
          return;
        }
        this.current = null;
        if (this.subscribers.size > 0) {
          this.reconcile();
        } else {
          this.onEmpty();
        }
      },
    });
    current = {
      retainers: new Set(),
      invalidationVersion,
      controller,
      binding: null,
      settled: false,
      completion,
      retiring: false,
      retryAttempt,
    };
    this.current = current;
  }

  private retireCurrent(): void {
    const current = this.current;
    if (!current || current.retiring) {
      return;
    }
    this.clearRetryTimer();
    current.retiring = true;
    current.binding = null;
    for (const invalidate of [...current.retainers]) invalidate();
    current.retainers.clear();
    current.controller.dispose();
    this.emitBindings();
    if (current.settled) {
      this.current = null;
    }
  }

  private emitBindings(): void {
    for (const subscriber of this.subscribers.values()) {
      this.emitBindingTo(subscriber);
    }
  }

  private emitBindingTo(subscriber: DraftPrewarmSubscriber): void {
    const current = this.current;
    subscriber.onBinding(
      current && !current.retiring && current.invalidationVersion === subscriber.invalidationVersion
        ? current.binding
        : null,
    );
  }
}

const draftPrewarmCoordinatorsByTransport = new Map<
  unknown,
  Map<string, DraftSessionPrewarmCoordinator>
>();

function logicalDraftOwnerKey(workspaceKey: string, paneId: string): string {
  return JSON.stringify([workspaceKey, paneId]);
}

function getDraftSessionPrewarmCoordinator(params: {
  workspaceKey: string;
  paneId: string;
  transportIdentity: unknown;
  dispatchCommand: DispatchCommand;
  resolveInitialConfig: (() => Partial<SessionConfigState> | undefined) | undefined;
}): DraftSessionPrewarmCoordinator {
  let transportCoordinators = draftPrewarmCoordinatorsByTransport.get(params.transportIdentity);
  if (!transportCoordinators) {
    transportCoordinators = new Map();
    draftPrewarmCoordinatorsByTransport.set(params.transportIdentity, transportCoordinators);
  }
  const ownerKey = logicalDraftOwnerKey(params.workspaceKey, params.paneId);
  let coordinator = transportCoordinators.get(ownerKey);
  if (!coordinator) {
    coordinator = new DraftSessionPrewarmCoordinator(
      params.workspaceKey,
      params.dispatchCommand,
      params.resolveInitialConfig,
      () => {
        if (transportCoordinators?.get(ownerKey) !== coordinator) {
          return;
        }
        transportCoordinators.delete(ownerKey);
        if (transportCoordinators.size === 0) {
          draftPrewarmCoordinatorsByTransport.delete(params.transportIdentity);
        }
      },
    );
    transportCoordinators.set(ownerKey, coordinator);
  }
  return coordinator;
}

interface AcquiredDraftPrewarm {
  generation: object;
  coordinator: DraftSessionPrewarmCoordinator;
}

// Bug 原因：等待回调与订阅 effect 共享作用域，隐式捕获旧 dispatch，再经 pane 回调串起历次草稿。
// 工厂只持有等待所需的 ref/代次；过期调用仍按原 generation 拒绝，不把旧请求改投新 owner。
function createWaitForDraftSession(
  acquired: RefObject<AcquiredDraftPrewarm | null>,
  enabled: boolean,
  generation: object,
  invalidationVersion: number,
): DraftSessionPrewarm["waitForSession"] {
  return async () => {
    if (!enabled) throw new Error("草稿会话尚未启用");
    const current = acquired.current;
    if (current?.generation !== generation) throw new Error("草稿会话已切换，请重新发送");
    return current.coordinator.waitForSession(invalidationVersion, generation);
  };
}

export function useDraftSessionPrewarm(params: {
  /** pane 未绑定会话（sessionId===null）时启用。 */
  enabled: boolean;
  workspaceKey: string;
  /** 同一 workspace 内的逻辑 pane 身份；同步重挂必须保持稳定。 */
  paneId: string;
  /** 外部能力变化时递增；仅用于回收并重建尚未提升的草稿预热会话。 */
  invalidationVersion?: number;
  /** conversation provider 的 transport identity；同 workspace lease 变化时保持不变。 */
  transportIdentity: unknown;
  dispatchCommand: DispatchCommand;
  /** 预热会话初始 config（全局「上次选择」，同步解析）；让投影首帧即全局、不闪。 */
  resolveInitialConfig?: () => Partial<SessionConfigState> | undefined;
}): DraftSessionPrewarm {
  const {
    enabled,
    workspaceKey,
    paneId,
    transportIdentity,
    invalidationVersion = 0,
    dispatchCommand,
    resolveInitialConfig,
  } = params;
  // workspace/pane/transport 共同定义逻辑 owner：同 owner 重挂复用 single-flight，transport
  // 换代仍生成新 coordinator，确保旧 session 的清理不会误走新 transport。
  const owner = useMemo(
    () => ({ workspaceKey, paneId, transportIdentity }),
    [paneId, transportIdentity, workspaceKey],
  );
  const generation = useMemo(() => ({ owner }), [enabled, invalidationVersion, owner]);
  const acquired = useRef<AcquiredDraftPrewarm | null>(null);
  useLayoutEffect(() => {
    if (acquired.current?.generation === generation) {
      acquired.current.coordinator.update(dispatchCommand, resolveInitialConfig);
    }
  }, [dispatchCommand, generation, resolveInitialConfig]);
  const [ready, setReady] = useState<{
    generation: typeof generation;
    binding: DraftPrewarmBinding;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    // 原先在 render 登记，未启用预热的历史页没有 acquire/release，Map 会永久保留闭包中的
    // 已关闭 store 和历史。登记与订阅必须同属已提交的 effect，中止 render 也不能留下 owner。
    const coordinator = getDraftSessionPrewarmCoordinator({
      ...owner,
      dispatchCommand,
      resolveInitialConfig,
    });
    coordinator.update(dispatchCommand, resolveInitialConfig);
    acquired.current = { generation, coordinator };
    const release = coordinator.acquire({
      generation,
      invalidationVersion,
      onBinding: (binding) => {
        setReady((current) => {
          if (!binding) {
            return current?.generation === generation ? null : current;
          }
          return { generation, binding };
        });
      },
    });
    return () => {
      acquired.current = null;
      release();
    };
  }, [enabled, generation, invalidationVersion, owner]);

  const waitForSession = useMemo(
    () => createWaitForDraftSession(acquired, enabled, generation, invalidationVersion),
    [enabled, generation, invalidationVersion],
  );

  return { binding: ready?.generation === generation ? ready.binding : null, waitForSession };
}
