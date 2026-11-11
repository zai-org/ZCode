// V4 已提交命令的 renderer 持久账本。
// 它只保存客户端恢复线索，不参与 conversation projection，也绝不能据此自动重放。
import { permissionGrantMode } from "@zcode/shared/zcode-protocol-v4";
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import {
  resolvePendingCommandWorkspaceKey,
  type PendingCommandClientContext,
} from "@/v4/pendingCommandWorkspace.js";
import { pendingCommandReplayFor, type PendingCommandReplay } from "@/v4/pendingCommandReplay.js";
import { logger } from "@/logger.js";
import { acceptComposerRecentReceipt, type FullAccessRecentReceipt } from "@/lib/composerRecent.js";
import {
  completePendingTaskDraft,
  markPendingTaskDraftCommand,
  releasePendingTaskDraftCommand,
  readPendingTaskDraft,
  readV4ComposerDraft,
  persistV4ComposerDraft,
  clearV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
export type { PendingCommandReplay } from "@/v4/pendingCommandReplay.js";

export type PendingCommandResolution =
  | "accepted"
  | "duplicate"
  | "authoritative"
  | "failed"
  | "discarded";

export const PENDING_COMMAND_TTL_MS = 24 * 60 * 60 * 1_000;
const STORAGE_KEY = "zcode-v4-pending-commands:v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PendingCommandRecoveryReason = "discarded";

export interface PendingCommandEntry {
  commandId: string;
  clientId: string;
  sessionId: string | null;
  issuedAt: number;
  expiresAt: number;
  replay: PendingCommandReplay;
  clientContext?: PendingCommandClientContext;
  recovery?: PendingCommandRecoveryReason;
  recoveryDismissed?: boolean;
}

export interface PendingCommandReplayRequest {
  type: "sendText" | "sendGoalCommand" | "compact" | "createSession";
  payload: Record<string, unknown>;
  sessionId: string | null;
  baseRevision?: number;
  clientContext?: PendingCommandClientContext;
}

export interface PendingCommandRegistryOptions {
  storage?: StorageLike;
  now?: () => number;
}

type QueryCommands = (params: CommandsQueryParams) => Promise<CommandsQueryResult>;

function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function keyOf(sessionId: string | null, commandId: string): string {
  return `${sessionId ?? "<global>"}\u0000${commandId}`;
}

function clonePayload(payload: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function isEntry(value: unknown): value is PendingCommandEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PendingCommandEntry>;
  return (
    typeof entry.commandId === "string" &&
    typeof entry.clientId === "string" &&
    (typeof entry.sessionId === "string" || entry.sessionId === null) &&
    typeof entry.issuedAt === "number" &&
    typeof entry.expiresAt === "number" &&
    Boolean(entry.replay) &&
    typeof entry.replay === "object"
  );
}

function isRuntimeLocalDiscard(ack: CommandAck): boolean {
  return (
    ack.reasonCode === "fault.command.inputDiscardedOnRestart" &&
    ack.result?.type === "inputDisposition" &&
    (ack.result.delivery === "queue" || ack.result.delivery === "guide")
  );
}

/**
 * ACK、queue 与 transcript 曾分别维护临时状态；renderer 刷新或 ACK 丢失后，
 * UI 已清空但无法证明 CLI 是否 admission。这里把“待对账线索”先于上行持久化，并用
 * queue/guided/transcript sourceCommandId 或显式终态收口；registry 本身永远不产生权威事实。
 */
export class PendingCommandRegistry {
  private readonly storage: StorageLike | undefined;
  private readonly now: () => number;
  private readonly entries = new Map<string, PendingCommandEntry>();
  private readonly preparingGrant = new WeakMap<PendingCommandEntry, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly resolutionListeners = new Map<
    string,
    Set<(resolution: PendingCommandResolution) => void>
  >();
  private readonly reconcileInFlight = new Map<string, Promise<void>>();

  constructor(options: PendingCommandRegistryOptions = {}) {
    this.storage = options.storage ?? browserStorage();
    this.now = options.now ?? Date.now;
    this.load();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeResolution(
    commandId: string,
    listener: (resolution: PendingCommandResolution) => void,
  ): () => void {
    const listeners = this.resolutionListeners.get(commandId) ?? new Set();
    listeners.add(listener);
    this.resolutionListeners.set(commandId, listeners);
    return () => {
      const current = this.resolutionListeners.get(commandId);
      current?.delete(listener);
      if (current?.size === 0) this.resolutionListeners.delete(commandId);
    };
  }

  record(
    envelope: CommandEnvelope,
    clientContext?: PendingCommandClientContext,
    resolveGrant?: () => Promise<FullAccessRecentReceipt>,
  ): PendingCommandEntry | null {
    this.pruneExpired();
    const replay = pendingCommandReplayFor(envelope);
    if (!replay) return null;
    const key = keyOf(envelope.sessionId, envelope.commandId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: PendingCommandEntry = {
      commandId: envelope.commandId,
      clientId: envelope.clientId,
      sessionId: envelope.sessionId,
      issuedAt: envelope.issuedAt,
      // TTL 锚定首次登记时间；reload/reconcile 不得续期。
      expiresAt: this.now() + PENDING_COMMAND_TTL_MS,
      replay,
      ...(clientContext ? { clientContext } : {}),
    };
    this.entries.set(key, entry);
    const composer = clientContext?.composer;
    // 首发恢复线索必须先持久化；失败时拒绝上行，不能留下无法查询的待发送身份。
    if (!this.commit() && composer?.draftId) {
      this.entries.delete(key);
      throw new Error("composer.draft-storage-unavailable");
    }
    try {
      if (composer?.draftId)
        markPendingTaskDraftCommand(
          composer.scope,
          composer.draftId,
          envelope.commandId,
          envelope.sessionId,
        );
    } catch (error) {
      this.entries.delete(key);
      this.commit();
      throw error;
    }
    if (resolveGrant) {
      // 先登记命令，再并行查询归属。慢查询只影响偏好，不推迟工具审批或错误提示。
      const ready = Promise.resolve()
        .then(resolveGrant)
        .then((grant) => {
          if (this.entries.get(key) !== entry) return;
          entry.clientContext = { ...entry.clientContext, fullAccess: grant };
          this.commit();
        })
        .catch((error) => {
          logger.warn("[v4-interaction] 未能确定项目归属，跳过权限偏好记录", {
            commandId: envelope.commandId,
            error,
          });
        })
        .finally(() => this.preparingGrant.delete(entry));
      this.preparingGrant.set(entry, ready);
    }
    return entry;
  }

  list(sessionId: string | null): readonly PendingCommandEntry[] {
    this.pruneExpired();
    return [...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .sort((left, right) => left.issuedAt - right.issuedAt);
  }

  findCommand(commandId: string): PendingCommandEntry | undefined {
    return [...this.entries.values()].find((entry) => entry.commandId === commandId);
  }

  // 随每个流式帧调用：直接遍历，不为一次存在性判断复制条目数组。
  private hasEntriesForSession(sessionId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  listRecoverable(sessionId: string | null): readonly PendingCommandEntry[] {
    return this.list(sessionId).filter(
      // 兼容 V4 初版已经写入 localStorage 的 unknown：它不是可操作错误，不能再进入 UI。
      (entry) => entry.recovery === "discarded" && !entry.recoveryDismissed,
    );
  }

  settle(sessionId: string | null, commandId: string): void {
    if (!this.entries.delete(keyOf(sessionId, commandId))) return;
    this.commit();
  }

  rejectCommand(sessionId: string | null, commandId: string): void {
    const entry = this.entries.get(keyOf(sessionId, commandId));
    if (entry) this.rejectComposer(entry);
    this.settle(sessionId, commandId);
  }

  dismissRecovery(sessionId: string | null, commandId: string): void {
    const key = keyOf(sessionId, commandId);
    const entry = this.entries.get(key);
    if (!entry?.recovery || entry.recoveryDismissed) return;
    this.entries.set(key, { ...entry, recoveryDismissed: true });
    this.commit();
  }

  applyAck(envelope: CommandEnvelope, ack: CommandAck): void {
    let entry = this.entries.get(keyOf(envelope.sessionId, envelope.commandId));
    if (!entry) return;
    if (entry.replay.kind === "sensitiveDigest") {
      void this.settleSensitive(entry, ack);
      return;
    }
    entry = this.remapCreatedSession(entry, ack);
    if (ack.status === "accepted" || ack.status === "duplicate") {
      if (!this.acceptComposer(entry)) return;
      this.clearRecovery(entry);
      this.notifyResolution(entry.commandId, ack.status);
      return;
    }
    if (ack.status === "failed" && ack.reasonCode === "fault.command.inputDiscardedOnRestart") {
      this.rejectComposer(entry);
      if (isRuntimeLocalDiscard(ack)) {
        this.notifyResolution(entry.commandId, "discarded");
        this.settle(entry.sessionId, entry.commandId);
        return;
      }
      this.notifyResolution(entry.commandId, "failed");
      this.markRecovery(entry, "discarded");
      return;
    }
    this.rejectComposer(entry);
    this.notifyResolution(entry.commandId, "failed");
    this.settle(entry.sessionId, entry.commandId);
  }

  applyQuery(result: CommandsQueryResult): void {
    for (const item of result.results) {
      let entry = this.entries.get(keyOf(item.key.sessionId, item.key.commandId));
      if (!entry) continue;
      if (item.result === "unknown") {
        // 查询可能越过仍在 Host 准备的发送；未命中不是拒绝。提前清账会恢复已发送正文，
        // 并丢掉迟到 ACK 的结算订阅。保留线索，交给明确结果、权威投影或既有 TTL 收口。
        continue;
      }
      if (
        item.result.status === "failed" &&
        item.result.reasonCode === "fault.command.queryUnavailable"
      ) {
        continue;
      }
      if (
        item.result.status === "failed" &&
        item.result.reasonCode === "fault.command.inputDiscardedOnRestart"
      ) {
        this.rejectComposer(entry);
        if (isRuntimeLocalDiscard(item.result)) {
          this.notifyResolution(entry.commandId, "discarded");
          this.settle(entry.sessionId, entry.commandId);
          continue;
        }
        this.notifyResolution(entry.commandId, "failed");
        this.markRecovery(entry, "discarded");
        continue;
      }
      entry = this.remapCreatedSession(entry, item.result);
      if (entry.replay.kind === "sensitiveDigest") {
        void this.settleSensitive(entry, item.result);
        continue;
      }
      if (item.result.status === "accepted" || item.result.status === "duplicate") {
        if (!this.acceptComposer(entry)) continue;
        this.clearRecovery(entry);
        this.notifyResolution(entry.commandId, item.result.status);
      } else {
        this.rejectComposer(entry);
        this.notifyResolution(entry.commandId, "failed");
        this.settle(entry.sessionId, entry.commandId);
      }
    }
  }

  reconcileSnapshot(snapshot: ConversationSnapshot): void {
    // Bug 根因：每个流式帧都会逐行扫描全部历史来收集 sourceCommandId。只有本会话还有待对账条目、
    // 或有人在等某个命令的结算时，扫描才可能产生效果；两者都没有时直接返回，结果不变。
    if (this.resolutionListeners.size === 0 && !this.hasEntriesForSession(snapshot.sessionId)) {
      return;
    }
    const settled = new Set<string>();
    for (const item of snapshot.queue.items) {
      if (item.sourceCommandId) {
        // 把“进入 queue”当成仍未投递的话，直到 transcript 才清理
        // localStorage；App/CLI 重启后旧 runtime queue 被正常丢弃，却又触发重发提示。
        // queue projection 已是 CLI 权威接收证据，renderer ingress 账本应在此结算。
        settled.add(item.sourceCommandId);
      }
    }
    for (const row of snapshot.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        settled.add(row.sourceCommandId);
      }
      if (row.kind === "timelineMarker" && row.marker.type === "compact" && row.sourceCommandId) {
        // compact 不产生 user row；timeline marker 是该维护命令已开始执行的权威证据。
        settled.add(row.sourceCommandId);
      }
    }
    if (settled.size === 0) return;
    let changed = false;
    for (const commandId of settled) {
      const entry = this.entries.get(keyOf(snapshot.sessionId, commandId));
      if (entry && !this.acceptComposer(entry)) continue;
      this.notifyResolution(commandId, "authoritative");
      changed = this.entries.delete(keyOf(snapshot.sessionId, commandId)) || changed;
    }
    if (changed) this.commit();
  }

  private async settleSensitive(entry: PendingCommandEntry, ack: CommandAck): Promise<void> {
    const resolved = ack.result?.type === "resolveInteraction" ? ack.result.resolvedBy : undefined;
    if (
      (ack.status === "accepted" || ack.status === "duplicate") &&
      resolved?.clientId === entry.clientId
    ) {
      const preparing = this.preparingGrant.get(entry);
      if (preparing) {
        await preparing;
        // ACK 和 query 可同时确认同一命令，清账之后不再回写。
        if (this.entries.get(keyOf(entry.sessionId, entry.commandId)) !== entry) return;
      }
      const grant = entry.clientContext?.fullAccess;
      if (
        grant &&
        permissionGrantMode(resolved.optionId) === grant.mode &&
        !acceptComposerRecentReceipt(grant, this.storage)
      )
        return;
    }
    this.settle(entry.sessionId, entry.commandId);
  }

  private acceptComposer(entry: PendingCommandEntry): boolean {
    const composer = entry.clientContext?.composer;
    if (!composer) return true;
    if (!acceptComposerRecentReceipt(composer, this.storage)) return false;
    try {
      if (composer.draftId && this.ownsPendingDraft(entry)) {
        const workspace = entry.clientContext?.workspace;
        if (!workspace || !entry.sessionId) return false;
        const draft = readV4ComposerDraft(
          workspace.workspacePath,
          workspace.workspaceIdentity,
          V4_DRAFT_SCOPE_ROOT,
          composer.scope,
        );
        // 首发期间可能已经切走；下一条输入仍归该 session，不能遗留给下一份任务目录。
        // 传输失败恢复的原文已被权威接纳，应清除而不是再次放入正式会话输入框。
        if (draft && entry.replay.kind === "input") {
          const payload = entry.replay.payload;
          const sentText =
            composer.submittedText ??
            (entry.replay.type === "createSession"
              ? (payload.firstInput as { text?: string } | undefined)?.text
              : (payload.displayText ?? payload.text));
          if (
            draft.text !== sentText &&
            !readV4ComposerDraft(
              workspace.workspacePath,
              workspace.workspaceIdentity,
              entry.sessionId,
            ) &&
            !persistV4ComposerDraft(
              workspace.workspacePath,
              workspace.workspaceIdentity,
              entry.sessionId,
              draft,
            )
          )
            return false;
        }
        if (
          !clearV4ComposerDraft(
            workspace.workspacePath,
            workspace.workspaceIdentity,
            V4_DRAFT_SCOPE_ROOT,
            composer.scope,
          )
        )
          return false;
        completePendingTaskDraft(composer.scope, composer.draftId);
      }
      return true;
    } catch {
      return false;
    }
  }

  private rejectComposer(entry: PendingCommandEntry): void {
    const composer = entry.clientContext?.composer;
    if (composer?.draftId)
      releasePendingTaskDraftCommand(composer.scope, composer.draftId, entry.commandId);
  }

  reconcileSession(
    sessionId: string | null,
    query: QueryCommands,
    workspaceKey?: string,
  ): Promise<void> {
    const inFlightKey = JSON.stringify([workspaceKey, sessionId]);
    const existing = this.reconcileInFlight.get(inFlightKey);
    if (existing) return existing;
    const pending = this.runReconcile(sessionId, query, workspaceKey).finally(() => {
      if (this.reconcileInFlight.get(inFlightKey) === pending) {
        this.reconcileInFlight.delete(inFlightKey);
      }
    });
    this.reconcileInFlight.set(inFlightKey, pending);
    return pending;
  }

  consumeReplay(key: {
    sessionId: string | null;
    commandId: string;
  }): PendingCommandReplayRequest | null {
    const entry = this.entries.get(keyOf(key.sessionId, key.commandId));
    if (!entry || entry.replay.kind !== "input") return null;
    const request: PendingCommandReplayRequest = {
      type: entry.replay.type,
      payload: clonePayload(entry.replay.payload),
      sessionId: entry.sessionId,
      ...(entry.replay.baseRevision !== undefined
        ? { baseRevision: entry.replay.baseRevision }
        : {}),
      ...(entry.clientContext ? { clientContext: entry.clientContext } : {}),
    };
    // Bug 原因：首发 admission 已持久化旧会话，确认重发沿用旧 ID 会被 CLI 拒绝。
    // 只在用户确认生成新命令时去掉 ID；同命令重试仍保留原信封，也兼容旧恢复记录。
    if (request.type === "createSession") delete request.payload.sessionId;
    // 用户已确认以新 commandId 重发，旧 discarded 线索在本地完成收口。
    this.rejectComposer(entry);
    this.settle(entry.sessionId, entry.commandId);
    return request;
  }

  private async runReconcile(
    sessionId: string | null,
    query: QueryCommands,
    workspaceKey?: string,
  ): Promise<void> {
    // null bucket 会收集各 workspace 的创建；只能向命令原属 Agent 查询。
    const entries = this.list(sessionId).filter(
      (entry) =>
        workspaceKey === undefined ||
        resolvePendingCommandWorkspaceKey(entry) === workspaceKey ||
        (sessionId !== null && resolvePendingCommandWorkspaceKey(entry) === null),
    );
    for (let offset = 0; offset < entries.length; offset += 64) {
      const batch = entries.slice(offset, offset + 64);
      const result = await query({
        commands: batch.map((entry) => ({
          sessionId: entry.sessionId,
          commandId: entry.commandId,
        })),
      });
      this.applyQuery(result);
    }
  }

  private markRecovery(entry: PendingCommandEntry, recovery: PendingCommandRecoveryReason): void {
    if (entry.recovery === recovery) return;
    this.entries.set(keyOf(entry.sessionId, entry.commandId), {
      ...entry,
      recovery,
      recoveryDismissed: false,
    });
    this.commit();
  }

  private clearRecovery(entry: PendingCommandEntry): void {
    if (!entry.recovery && !entry.recoveryDismissed) return;
    const { recovery: _recovery, recoveryDismissed: _dismissed, ...settled } = entry;
    this.entries.set(keyOf(entry.sessionId, entry.commandId), settled);
    this.commit();
  }

  private remapCreatedSession(entry: PendingCommandEntry, ack: CommandAck): PendingCommandEntry {
    if (
      entry.replay.kind !== "input" ||
      entry.replay.type !== "createSession" ||
      (ack.status !== "accepted" && ack.status !== "duplicate") ||
      ack.result?.type !== "createSession" ||
      entry.sessionId === ack.result.sessionId
    ) {
      return entry;
    }
    this.entries.delete(keyOf(entry.sessionId, entry.commandId));
    const remapped = { ...entry, sessionId: ack.result.sessionId };
    this.entries.set(keyOf(remapped.sessionId, remapped.commandId), remapped);
    this.commit();
    return remapped;
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        if (isEntry(value)) {
          this.entries.set(keyOf(value.sessionId, value.commandId), value);
        }
      }
      this.pruneExpired();
    } catch {
      // storage 损坏不能阻断聊天；丢弃的是客户端恢复线索，不影响 CLI 权威事实。
      this.entries.clear();
    }
  }

  private ownsPendingDraft(entry: PendingCommandEntry): boolean {
    const composer = entry.clientContext?.composer;
    return Boolean(
      composer?.draftId && readPendingTaskDraft(composer.scope)?.draftId === composer.draftId,
    );
  }

  private pruneExpired(): void {
    const now = this.now();
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now && !this.ownsPendingDraft(entry)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.commit();
  }

  private commit(): boolean {
    let written = Boolean(this.storage);
    if (this.storage) {
      try {
        if (this.entries.size === 0) {
          this.storage.removeItem(STORAGE_KEY);
        } else {
          this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.entries.values()]));
        }
      } catch {
        // 普通命令保持原有内存降级；首发目录交接由 record 检查写入结果。
        written = false;
      }
    }
    for (const listener of this.listeners) listener();
    return written;
  }

  private notifyResolution(commandId: string, resolution: PendingCommandResolution): void {
    const listeners = this.resolutionListeners.get(commandId);
    if (!listeners) return;
    this.resolutionListeners.delete(commandId);
    for (const listener of listeners) listener(resolution);
  }
}

export const pendingCommandRegistry = new PendingCommandRegistry();
