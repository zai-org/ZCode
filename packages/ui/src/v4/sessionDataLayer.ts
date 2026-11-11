// SessionDataLayer（纯数据层）。
// Map<topic, SessionStore>，不知道「显示」这回事；生命周期 = 引用计数：
// 有 pane 引用 → 订阅；归零 → 延迟退订（keep-warm，防拖拽/切 pane 抖动）。
// 一个实例对应一条 host 连接；跨 workspace 分屏在 shell 层做
// Map<workspaceKey, SessionDataLayer>，本层不感知 workspace。
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { ConversationRowPool } from "@/v4/conversationRowSharing.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { SessionOpenKind } from "@/lib/sessionOpenArmsTelemetry.js";
import { conversationTopic, type ConversationTransport } from "@/v4/transport.js";
import { logger } from "@/logger.js";
import type { CommandsQueryParams, CommandsQueryResult } from "@zcode/shared/zcode-protocol-v4";

/** pane 持有的租约；release 幂等。 */
export interface SessionLease {
  readonly sessionId: string;
  readonly store: ConversationProjectionStore;
  /** 由数据层按 projection 生命周期判定，避免 pane 首次 render 时 snapshot 仍为空。 */
  readonly openKind: SessionOpenKind;
  /** pane acquire 的 Renderer 单调时钟起点。 */
  readonly startedAt: number;
  release(): void;
}

export interface SessionDataLayerOptions {
  transport: ConversationTransport;
  /** 引用归零后延迟退订窗口（ms），默认 30s。 */
  keepWarmMs?: number;
}

export const SESSION_DATA_LAYER_KEEP_WARM_MS = 30_000;
export const E2E_SESSION_DATA_LAYER_KEEP_WARM_MS = 1_000;

export function resolveSessionDataLayerKeepWarmMs(
  e2eStoreBridgeEnabled = shouldExposeE2EStoreBridge(),
): number {
  return e2eStoreBridgeEnabled
    ? E2E_SESSION_DATA_LAYER_KEEP_WARM_MS
    : SESSION_DATA_LAYER_KEEP_WARM_MS;
}

interface SessionEntry {
  store: ConversationProjectionStore;
  refCount: number;
  keepWarmTimer: ReturnType<typeof setTimeout> | null;
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class SessionDataLayer {
  private readonly transport: ConversationTransport;
  private readonly keepWarmMs: number;
  private readonly entries = new Map<string, SessionEntry>();
  // 行结构共享池跨 store 生命周期：keep-warm 过期冷打开的新 store 仍能复用被留住的旧行
  // （docs/performance/conversation-row-structural-sharing.md）。
  private readonly rowPool = new ConversationRowPool();
  private readonly offFrame: () => void;
  private disposed = false;

  constructor(options: SessionDataLayerOptions) {
    this.transport = options.transport;
    this.keepWarmMs = options.keepWarmMs ?? resolveSessionDataLayerKeepWarmMs();
    // 连接级单监听：按 topic 扇入到各 store（pane 间共享的正是这一条连接）。
    this.offFrame = this.transport.onFrame((frame, context) => {
      this.entries.get(frame.topic)?.store.handleFrame(frame, context);
    });
  }

  /**
   * 取得 session 的投影 store。首个引用触发 subscribe（新开 pane 就是一次
   * subscribe，与刷新、新设备同一路径）；重复 acquire 共享同一 store（readonly，
   * 同 session 多 pane = 多视图）。
   */
  acquire(sessionId: string): SessionLease {
    if (this.disposed) {
      throw new Error("SessionDataLayer 已释放，不能再 acquire");
    }
    const topic = conversationTopic(sessionId);
    const startedAt = monotonicNow();
    let entry = this.entries.get(topic);
    let openKind: SessionOpenKind;
    if (entry) {
      openKind = entry.keepWarmTimer !== null ? "keep_warm" : "warm";
      entry.refCount++;
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
        entry.keepWarmTimer = null;
      }
    } else {
      const store = new ConversationProjectionStore(topic, this.transport, this.rowPool);
      entry = { store, refCount: 1, keepWarmTimer: null };
      this.entries.set(topic, entry);
      openKind = "cold";
      // 订阅失败落在 store.state（status=error + retry()），不在这里抛。
      void store.connect({ rendererPrepareStartedAt: startedAt });
    }
    logger.lifecycle.info("v4 session data lease acquired", {
      event: "v4.session_data.acquire",
      keepWarm: entry.keepWarmTimer !== null,
      module: "ui.v4.session_data_layer",
      openKind,
      refCount: entry.refCount,
      sessionId,
      status: "completed",
      topic,
    });

    let released = false;
    return {
      sessionId,
      store: entry.store,
      openKind,
      startedAt,
      release: () => {
        if (released) return;
        released = true;
        this.releaseEntry(topic);
      },
    };
  }

  /** 当前活跃（含 keep-warm 中）的 session 数，测试与调试观测点。 */
  get size(): number {
    return this.entries.size;
  }

  /** renderer pending-command registry 的只读对账入口；仍复用本 layer 的同一 host connection。 */
  queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult> {
    return this.transport.queryCommands(params);
  }

  private releaseEntry(topic: string): void {
    const entry = this.entries.get(topic);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0 || this.disposed) {
      logger.lifecycle.info("v4 session data lease released", {
        event: "v4.session_data.release",
        module: "ui.v4.session_data_layer",
        refCount: entry.refCount,
        status: "completed",
        topic,
      });
      return;
    }
    // 关 pane ≠ 停 session：这里只是退订视图，session 在 CLI 里照跑。
    entry.keepWarmTimer = setTimeout(() => {
      this.entries.delete(topic);
      logger.lifecycle.info("v4 session data keep-warm expired", {
        event: "v4.session_data.keep_warm_expired",
        module: "ui.v4.session_data_layer",
        refCount: 0,
        status: "completed",
        topic,
      });
      void entry.store.close();
    }, this.keepWarmMs);
    logger.lifecycle.info("v4 session data lease released", {
      event: "v4.session_data.release",
      keepWarmMs: this.keepWarmMs,
      module: "ui.v4.session_data_layer",
      refCount: 0,
      status: "keep_warm",
      topic,
    });
  }

  /** 永久删除完成后立即丢弃投影，迟到帧不能重新落入此 entry。 */
  forget(sessionId: string): void {
    const topic = conversationTopic(sessionId);
    const entry = this.entries.get(topic);
    if (entry?.keepWarmTimer) clearTimeout(entry.keepWarmTimer);
    this.entries.delete(topic);
    if (entry) void entry.store.close({ forget: true });
  }

  /** 连接销毁时清场（window/workspace 卸载）。 */
  dispose(): void {
    if (this.disposed) return;
    logger.lifecycle.info("v4 session data layer dispose started", {
      entryCount: this.entries.size,
      event: "v4.session_data.dispose.started",
      module: "ui.v4.session_data_layer",
      status: "started",
    });
    this.disposed = true;
    this.offFrame();
    for (const entry of this.entries.values()) {
      if (entry.keepWarmTimer !== null) {
        clearTimeout(entry.keepWarmTimer);
      }
      void entry.store.close();
    }
    this.entries.clear();
    logger.lifecycle.info("v4 session data layer dispose completed", {
      event: "v4.session_data.dispose.completed",
      module: "ui.v4.session_data_layer",
      status: "completed",
    });
  }
}
