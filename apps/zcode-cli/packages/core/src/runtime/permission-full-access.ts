import {
  PERMISSION_FULL_ACCESS_ENTRY,
  permissionFullAccessReceiptSchema,
  SessionEventType,
  type SessionEvent,
  type SessionModeChangedPayload,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import { buildExecutionStateEntry, readRuntimeExecutionState } from "./execution-state.js";
import { getPendingSessionPersistence } from "./methods/events.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "./permission-grant-recovery.js";

const appliedGrants = new WeakMap<AgentRuntimeInternal, Map<string, SessionEvent>>();

/** 完全访问只改当前任务；receipt 固定目标集合，发布失败后不能重新抓取后来队列。 */
export async function grantPermissionFullAccess(
  this: AgentRuntimeInternal,
  interactionId: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!this.sessionStore?.commitPermissionFullAccess) throw new Error("Full access is unsupported");
  if (
    this.permissionFullAccessPending ||
    this.pendingInputReservations.size > 0 ||
    this.pendingInputDrains
  ) {
    throw new Error("Queue mutation is busy; retry approval");
  }
  const unpublished = unpublishedPermissionGrants.get(this);
  if (unpublished && unpublished.interactionId !== interactionId)
    await recoverPendingPermissionGrant(this);
  this.permissionFullAccessPending = true;
  try {
    signal?.throwIfAborted();
    const receiptId = `${this.sessionId}:permission-full-access:${interactionId}`;
    const entries = await this.sessionStore.sessionEntries?.({
      sessionID: this.sessionId,
      type: PERMISSION_FULL_ACCESS_ENTRY,
    });
    const saved = entries?.find((entry) => entry.id === receiptId);
    const appliedEvent = appliedGrants.get(this)?.get(interactionId);
    let event: SessionEvent;
    if (saved) {
      const data = permissionFullAccessReceiptSchema.parse(saved.data);
      if (data.event.sessionId !== this.sessionId || data.interactionId !== interactionId) {
        throw new Error("Permission receipt scope mismatch");
      }
      event = data.event as SessionEvent;
    } else if (appliedEvent) {
      // 草稿没有 receipt；发布失败后必须复用原事件，不能重复提权或覆盖后续用户选择。
      event = appliedEvent;
    } else {
      const projection = await this.rebuildProjection();
      // sampling 可并发创建父记录；最后一次异步准备后等待它，避免写子行或被旧权限覆盖。
      const pendingPersistence = getPendingSessionPersistence(this);
      if (pendingPersistence) await pendingPersistence;
      signal?.throwIfAborted();
      const queueItemIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
      const previous = readRuntimeExecutionState(this);
      const next = { ...previous, mode: "yolo" as const };
      event = this.createEvent(
        SessionEventType.SessionModeChanged,
        {
          ...next,
          previousMode: previous.mode,
          previousPlanEnabled: previous.planEnabled,
          source: "command",
          permissionGrant: { interactionId, queueItemIds },
        },
        this.rootTraceContext,
      );
      signal?.throwIfAborted();
      // 草稿尚无 session 父行；首发会按当前内存配置统一保存，不能为授权提前登记任务。
      if (this.sessionPersisted)
        await this.sessionStore.commitPermissionFullAccess({
          sessionID: this.sessionId,
          queueItemIds,
          signal,
          execution: buildExecutionStateEntry(this.sessionId, next),
          receipt: {
            id: receiptId,
            sessionID: this.sessionId,
            type: PERMISSION_FULL_ACCESS_ENTRY,
            touchSession: false,
            time: { created: Date.now(), updated: Date.now() },
            data: { interactionId, event },
          },
        });
    }
    const payload = event.payload as SessionModeChangedPayload;
    unpublishedPermissionGrants.set(this, {
      interactionId,
      recover: () => grantPermissionFullAccess.call(this, interactionId),
    });
    const ids = new Set(payload.permissionGrant!.queueItemIds);
    // 授权从这里同步应用；之后即使传输取消也必须完成投影发布，不能制造半个授权。
    const applied = appliedGrants.get(this) ?? new Map<string, SessionEvent>();
    if (!applied.has(interactionId)) {
      this.lastPermissionGrantId = interactionId;
      this.config.mode = payload.mode;
      this.config.planEnabled = payload.planEnabled;
      for (const item of this.activeTurn?.pendingInputs ?? []) {
        if (ids.has(item.id) && item.intent) item.intent = { ...item.intent, mode: "yolo" };
      }
      applied.set(interactionId, event);
      appliedGrants.set(this, applied);
    }
    const existing = (await this.eventStore.getEvents(this.sessionId)).find(
      (item) => item.id === event.id,
    );
    if (existing) await this.notifyEventSinks(existing, this.rootTraceContext);
    else await this.appendEvent(event, this.rootTraceContext);
    unpublishedPermissionGrants.delete(this);
    return String(event.id);
  } finally {
    this.permissionFullAccessPending = false;
  }
}
