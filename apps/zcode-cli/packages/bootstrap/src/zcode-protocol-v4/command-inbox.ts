// Command inbox：统一命令 admission 与查询入口。
// 三类事实严格分离：in-flight / live input 永远 pinned；只有 settled 进入 512/session LRU。
import { createHash } from "node:crypto";
import type {
  CommandAck,
  CommandEnvelope,
  CommandKey,
  ConversationInputIntent,
} from "@zcode/shared/zcode-protocol-v4";
import {
  COMMAND_QUERY_UNAVAILABLE_REASON,
  COMMANDS_REQUIRING_BASE_REVISION,
  PROTOCOL_V4_LIMITS,
  ROW_TARGETING_COMMANDS,
  parseCommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";

/** guard 裁决结果：拒绝（撤 optimistic）或 noop（晚到者静默收口，§6.3）。 */
export type GuardDecision =
  | { verdict: "allow" }
  | { verdict: "stale"; reasonCode: string; message?: string }
  | { verdict: "reject"; reasonCode: string; message?: string }
  | { verdict: "noop"; reasonCode: string; result?: CommandAck["result"] };

type PersistentLookup = (key: CommandKey) => Promise<CommandAck | null> | CommandAck | null;

export interface CommandInboxHost {
  /** 幂等查询完成后、持有 session admission 时准备冷会话，不另设接受队列。 */
  prepareDecision?(envelope: CommandEnvelope): Promise<void>;

  /** 会话当前 revision；未知会话返回 null（createSession 用 null sessionId）。 */
  getRevision(sessionId: string): number | null;
  /** 会话当前投影代际；CAS 必须先校验 epoch，再校验 revision。 */
  getLogEpoch(sessionId: string): string | null;
  /** row-targeting command 的 entity/action 同源 resolver 裁决。 */
  validateRowTarget?(envelope: CommandEnvelope): GuardDecision;
  /** 业务 guard（product-protocol guard id）。缺省一律放行。 */
  guard?(envelope: CommandEnvelope): GuardDecision;
  /** 以下回调顺序就是持久化事实优先级；实现必须精确匹配 sourceCommandId。 */
  lookupTranscriptCommand?: PersistentLookup;
  lookupTimelineCommand?: PersistentLookup;
  lookupChildCommand?: PersistentLookup;
  lookupDiscardedCommand?: PersistentLookup;
  now?(): number;
}

interface CommandEntry {
  ack: CommandAck;
  requestIdentity?: string;
}

interface InFlightEntry extends CommandEntry {
  final: Promise<CommandAck>;
  resolveFinal: (ack: CommandAck) => void;
}

type CommandFinal = Pick<
  CommandAck,
  "status" | "reasonCode" | "message" | "result" | "memoryEnabled"
>;

interface LiveInputEntry extends CommandEntry {
  intent: ConversationInputIntent;
}

export type CommandInboxOutcome =
  | { kind: "ack"; ack: CommandAck }
  | {
      kind: "execute";
      envelope: CommandEnvelope;
      ack: CommandAck;
      /** CLI 串行 admission 分配的权威顺序；用它构造 ConversationInputIntent。 */
      admissionSeq: number;
      admittedAt: number;
      queueItemId: string;
      /** 执行完成后回填终态。必须调用一次，用于释放 per-session admission gate。 */
      settle: (final: CommandFinal) => void;
    };

// createSession 与 null sessionId query 归全局桶。
const GLOBAL_BUCKET = "@global";
const APP_CONTROL_COMMAND_PREFIX = "app-control-";
// Host 每次派发 createSession 时按当时的项目 roots 和灰度开关补入（zcodeAgentService
// buildConversationCommandEnvelope），不属于调用者请求。
const HOST_DERIVED_CREATE_SESSION_FIELDS = new Set([
  "additionalDirectories",
  "dynamicWorkflowEnabled",
  "dynamicWorkflowMode",
  "offPeakToolEnabled",
]);

function requestIdentity(envelope: CommandEnvelope): string | undefined {
  if (!envelope.commandId.startsWith(APP_CONTROL_COMMAND_PREFIX)) return undefined;
  // 同 requestId 改正文曾被当成合法重试，直接回放旧 ACK。摘要随原 owner 条目存活，
  // 不另建 ledger，也不保存凭据正文；issuedAt 和重读得到的 CAS 水位不是业务请求身份。
  let payload = envelope.payload;
  if (envelope.type === "createSession" && payload && typeof payload === "object") {
    // Bug 根因：项目 roots 在两次重试之间变化时，Host 补入的附加目录随之变化（E2E 实测 [] → [新 root]），
    // 同一创建请求被判成 proto.commandConflict。派发时补入的执行上下文不参与请求身份。
    payload = Object.fromEntries(
      Object.entries(payload).filter(([name]) => !HOST_DERIVED_CREATE_SESSION_FIELDS.has(name)),
    );
  }
  if (payload && typeof payload === "object" && "source" in payload) {
    const source = payload.source;
    if (source && typeof source === "object" && "kind" in source && source.kind === "session") {
      // 来源标题可能在重试前自动更新；只排除展示标题，保留来源身份且不改已接纳的来源事实。
      const { title: _title, ...identity } = source as Record<string, unknown>;
      payload = { ...payload, source: identity };
    }
  }
  if (payload && typeof payload === "object" && "modelExecution" in payload) {
    const execution = payload.modelExecution;
    if (execution && typeof execution === "object") {
      // 临时鉴权会轮换，但显式模型、权限与执行策略仍须属于同一业务请求。
      const { requestAuth: _requestAuth, ...policy } = execution as Record<string, unknown>;
      payload = { ...payload, modelExecution: policy };
    }
  }
  const content = JSON.stringify(
    [envelope.clientId, envelope.type, payload],
    (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
          )
        : value,
  );
  return createHash("sha256").update(content).digest("hex");
}

export function queueItemIdForCommand(commandId: string): string {
  return `queue_${commandId}`;
}

type GateRelease = () => void;

/**
 * FIFO async gate。返回显式 release 是因为 per-session gate 要跨过 gateway execute，
 * 直到 settle 才释放；普通 with-lock 会在 handle 返回时过早放行下一条 admission。
 */
class AsyncGateRegistry {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<GateRelease> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}

export class CommandInbox {
  private readonly inFlight = new Map<string, Map<string, InFlightEntry>>();
  private readonly liveInputs = new Map<string, Map<string, LiveInputEntry>>();
  private readonly settled = new Map<string, Map<string, CommandEntry>>();
  private readonly admissionSeq = new Map<string, number>();
  private readonly keyGates = new AsyncGateRegistry();
  private readonly sessionGates = new AsyncGateRegistry();

  constructor(private readonly host: CommandInboxHost) {}

  async handle(raw: unknown): Promise<CommandInboxOutcome> {
    const parsed = parseCommandEnvelope(raw);
    if (!parsed.ok) {
      return this.ackOnly({
        commandId: this.extractCommandId(raw),
        status: "rejected",
        reasonCode: "proto.invalidPayload",
        message: parsed.error.message,
        revisionAtDecision: 0,
      });
    }
    const envelope = parsed.envelope;
    const identity = requestIdentity(envelope);
    const key = { sessionId: envelope.sessionId, commandId: envelope.commandId };
    const bucketKey = this.bucketKey(envelope.sessionId);
    const releaseKey = await this.keyGates.acquire(this.keyGateKey(key));

    try {
      const conflict = this.requestConflict(key, identity);
      if (conflict) return this.ackOnly(conflict);
      const existing = await this.lookupExact(key);
      if (existing) return this.ackOnly(this.retryAck(existing));

      // 固定锁序：key gate → per-session admission gate。session gate 持有到 settle，
      // 因而同 session 不同 commandId 以 CLI 实际执行 admission 的顺序串行。
      const releaseSession = await this.sessionGates.acquire(bucketKey);
      try {
        // 等待 session gate 期间，上一条命令可能增量写入了本 key 的持久化事实。
        const afterWaitConflict = this.requestConflict(key, identity);
        if (afterWaitConflict) {
          releaseSession();
          return this.ackOnly(afterWaitConflict);
        }
        const afterWait = await this.lookupExact(key);
        if (afterWait) {
          releaseSession();
          return this.ackOnly(this.retryAck(afterWait));
        }

        await this.host.prepareDecision?.(envelope);
        const decision = this.decide(envelope);
        if (decision.kind === "ack") {
          if (decision.remember)
            this.rememberSettled(bucketKey, envelope.commandId, {
              ack: decision.ack,
              requestIdentity: identity,
            });
          releaseSession();
          return this.ackOnly(decision.ack);
        }

        const nextAdmissionSeq = (this.admissionSeq.get(bucketKey) ?? 0) + 1;
        const admittedAt = this.host.now?.() ?? Date.now();
        this.admissionSeq.set(bucketKey, nextAdmissionSeq);
        let resolveFinal!: (ack: CommandAck) => void;
        const final = new Promise<CommandAck>((resolve) => {
          resolveFinal = resolve;
        });
        const entry: InFlightEntry = {
          ack: decision.ack,
          requestIdentity: identity,
          final,
          resolveFinal,
        };
        this.mapFor(this.inFlight, bucketKey).set(envelope.commandId, entry);

        // 旧单表 LRU 会在 >512 条 churn 时淘汰仍在执行/队列里的命令，随后
        // query 返回 unknown、重试再次执行。新命令先 pin，再释放 key gate。
        releaseKey();
        let settled = false;
        return {
          kind: "execute",
          envelope,
          ack: decision.ack,
          admissionSeq: nextAdmissionSeq,
          admittedAt,
          queueItemId: queueItemIdForCommand(envelope.commandId),
          settle: (final) => {
            if (settled) return;
            settled = true;
            const live = this.liveInputs.get(bucketKey)?.get(envelope.commandId);
            const ack = {
              ...decision.ack,
              ...final,
            };
            this.inFlight.get(bucketKey)?.delete(envelope.commandId);
            if (live) {
              live.ack = ack;
            } else {
              this.rememberSettled(bucketKey, envelope.commandId, {
                ack,
                requestIdentity: identity,
              });
            }
            // 在途 duplicate 过去直接拿 admission ACK，fork/create 尚无 child
            // result 时就返回，ACK 丢失重试会导航失败。所有同 key 请求必须共享这一个
            // final promise，并在释放 session FIFO 前看到同一终态。
            entry.resolveFinal(ack);
            releaseSession();
          },
        };
      } catch (error) {
        releaseSession();
        throw error;
      }
    } catch (error) {
      return this.ackOnly(this.queryUnavailableAck(key, error));
    } finally {
      // execute 路径已在 pin 后提前 release；release 幂等，其他路径在这里释放。
      releaseKey();
    }
  }

  /** 1..64 的上层 schema 由 gateway 校验；这里并行查询并保持 Promise.all 输入顺序。 */
  async query(
    keys: readonly CommandKey[],
  ): Promise<Array<{ key: CommandKey; result: CommandAck | "unknown" }>> {
    return Promise.all(keys.map((key) => this.queryOne(key)));
  }

  /** queue/guide admission 后 pin 同一个完整 intent；settled churn 不得触及它。 */
  pinLiveInput(sessionId: string, intent: ConversationInputIntent, ack?: CommandAck): void {
    const bucketKey = this.bucketKey(sessionId);
    const previous =
      this.inFlight.get(bucketKey)?.get(intent.sourceCommandId) ??
      this.liveInputs.get(bucketKey)?.get(intent.sourceCommandId) ??
      this.settled.get(bucketKey)?.get(intent.sourceCommandId);
    this.mapFor(this.liveInputs, bucketKey).set(intent.sourceCommandId, {
      intent,
      requestIdentity: previous?.requestIdentity,
      ack: ack ??
        previous?.ack ?? {
          commandId: intent.sourceCommandId,
          status: "accepted",
          revisionAtDecision: 0,
        },
    });
    this.settled.get(bucketKey)?.delete(intent.sourceCommandId);
  }

  /** queue/guide 进入 transcript、取消或失败时解除 pin，并可把终态转入 settled LRU。 */
  releaseLiveInput(key: CommandKey, finalAck?: CommandAck): void {
    const bucketKey = this.bucketKey(key.sessionId);
    const live = this.liveInputs.get(bucketKey)?.get(key.commandId);
    this.liveInputs.get(bucketKey)?.delete(key.commandId);
    if (finalAck ?? live?.ack) {
      this.rememberSettled(bucketKey, key.commandId, {
        ack: finalAck ?? live!.ack,
        requestIdentity: live?.requestIdentity,
      });
    }
  }

  hasPinnedSessionState(sessionId: string): boolean {
    const bucketKey = this.bucketKey(sessionId);
    return (
      (this.inFlight.get(bucketKey)?.size ?? 0) > 0 ||
      (this.liveInputs.get(bucketKey)?.size ?? 0) > 0
    );
  }

  /**
   * Resident 去激活后，inbox 也必须回到 CLI 冷启动状态。in-flight/live facts 不能清，
   * 调用方必须把它们作为回收保护条件；settled 仍可从 durable transcript/timeline 回源。
   */
  clearSession(sessionId: string): boolean {
    const bucketKey = this.bucketKey(sessionId);
    if (this.hasPinnedSessionState(sessionId)) return false;
    this.inFlight.delete(bucketKey);
    this.liveInputs.delete(bucketKey);
    this.settled.delete(bucketKey);
    this.admissionSeq.delete(bucketKey);
    return true;
  }

  /** 仅供已关闭执行准入并释放旧实例的换代路径；终态事实仍从持久账本回源。 */
  async resetReleasedSession(sessionId: string): Promise<void> {
    const bucketKey = this.bucketKey(sessionId);
    await Promise.all(
      [...(this.inFlight.get(bucketKey)?.values() ?? [])].map((entry) => entry.final),
    );
    this.liveInputs.delete(bucketKey);
    this.clearSession(sessionId);
  }

  private async queryOne(
    key: CommandKey,
  ): Promise<{ key: CommandKey; result: CommandAck | "unknown" }> {
    const releaseKey = await this.keyGates.acquire(this.keyGateKey(key));
    try {
      return { key, result: (await this.lookupExact(key)) ?? "unknown" };
    } catch (error) {
      return { key, result: this.queryUnavailableAck(key, error) };
    } finally {
      releaseKey();
    }
  }

  private async lookupExact(key: CommandKey): Promise<CommandAck | null> {
    const bucketKey = this.bucketKey(key.sessionId);
    const inflight = this.inFlight.get(bucketKey)?.get(key.commandId);
    if (inflight) return await inflight.final;
    const live = this.liveInputs.get(bucketKey)?.get(key.commandId);
    if (live) return live.ack;
    const settled = this.settled.get(bucketKey)?.get(key.commandId);
    if (settled) {
      this.touchSettled(bucketKey, key.commandId, settled);
      return settled.ack;
    }

    for (const lookup of [
      this.host.lookupTranscriptCommand,
      this.host.lookupTimelineCommand,
      this.host.lookupChildCommand,
      this.host.lookupDiscardedCommand,
    ]) {
      const found = await lookup?.(key);
      if (found) return found;
    }
    return null;
  }

  private decide(
    envelope: CommandEnvelope,
  ): { kind: "execute"; ack: CommandAck } | { kind: "ack"; ack: CommandAck; remember: boolean } {
    const revision = envelope.sessionId === null ? 0 : this.host.getRevision(envelope.sessionId);
    if (revision === null || (envelope.type !== "createSession" && envelope.sessionId === null)) {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: "proto.sessionNotFound",
          revisionAtDecision: 0,
        },
      };
    }

    if (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.type)) {
      if (envelope.baseRevision === undefined) {
        return {
          kind: "ack",
          remember: false,
          ack: {
            commandId: envelope.commandId,
            status: "rejected",
            reasonCode: "proto.missingBaseRevision",
            revisionAtDecision: revision,
          },
        };
      }
      const logEpoch =
        envelope.sessionId === null ? null : this.host.getLogEpoch(envelope.sessionId);
      if (ROW_TARGETING_COMMANDS.has(envelope.type) && envelope.baseLogEpoch !== logEpoch) {
        return {
          kind: "ack",
          remember: false,
          ack: {
            commandId: envelope.commandId,
            status: "stale",
            reasonCode: "proto.staleLogEpoch",
            revisionAtDecision: revision,
          },
        };
      }
      if (envelope.baseRevision !== revision) {
        return {
          kind: "ack",
          remember: false,
          ack: {
            commandId: envelope.commandId,
            status: "stale",
            reasonCode: "proto.staleRevision",
            revisionAtDecision: revision,
          },
        };
      }
    }

    const targetDecision = this.host.validateRowTarget?.(envelope);
    if (targetDecision?.verdict === "stale") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: targetDecision.reasonCode,
          message: targetDecision.message,
          revisionAtDecision: revision,
        },
      };
    }
    if (targetDecision?.verdict === "reject") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: targetDecision.reasonCode,
          message: targetDecision.message,
          revisionAtDecision: revision,
        },
      };
    }

    const decision = this.host.guard?.(envelope) ?? {
      verdict: "allow" as const,
    };
    if (decision.verdict === "stale") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "stale",
          reasonCode: decision.reasonCode,
          message: decision.message,
          revisionAtDecision: revision,
        },
      };
    }
    if (decision.verdict === "reject") {
      return {
        kind: "ack",
        remember: false,
        ack: {
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: decision.reasonCode,
          message: decision.message,
          revisionAtDecision: revision,
        },
      };
    }
    if (decision.verdict === "noop") {
      return {
        kind: "ack",
        remember: true,
        ack: {
          commandId: envelope.commandId,
          status: "noop",
          reasonCode: decision.reasonCode,
          revisionAtDecision: revision,
          result: decision.result,
        },
      };
    }
    return {
      kind: "execute",
      ack: {
        commandId: envelope.commandId,
        status: "accepted",
        revisionAtDecision: revision,
      },
    };
  }

  private requestConflict(key: CommandKey, identity: string | undefined): CommandAck | null {
    if (!identity) return null;
    const bucketKey = this.bucketKey(key.sessionId);
    const entry =
      this.inFlight.get(bucketKey)?.get(key.commandId) ??
      this.liveInputs.get(bucketKey)?.get(key.commandId) ??
      this.settled.get(bucketKey)?.get(key.commandId);
    // 冷回源仅有 ACK，不能从派生 intent 或结果反推完整请求；维持原 replay 语义。
    if (!entry?.requestIdentity || entry.requestIdentity === identity) return null;
    return {
      commandId: key.commandId,
      status: "rejected",
      reasonCode: "proto.commandConflict",
      message: "Command ID was already used for a different request.",
      revisionAtDecision: entry.ack.revisionAtDecision,
    };
  }

  private retryAck(ack: CommandAck): CommandAck {
    // failed 是终态事实，不得被 duplicate 状态覆盖后让 UI/服务误判为可接受。
    return ack.status === "failed" ? ack : { ...ack, status: "duplicate" };
  }

  private queryUnavailableAck(key: CommandKey, _error: unknown): CommandAck {
    return {
      commandId: key.commandId,
      status: "failed",
      reasonCode: COMMAND_QUERY_UNAVAILABLE_REASON,
      revisionAtDecision: key.sessionId === null ? 0 : (this.host.getRevision(key.sessionId) ?? 0),
    };
  }

  private ackOnly(ack: CommandAck): CommandInboxOutcome {
    return { kind: "ack", ack };
  }

  private bucketKey(sessionId: string | null): string {
    return sessionId ?? GLOBAL_BUCKET;
  }

  private keyGateKey(key: CommandKey): string {
    return `${this.bucketKey(key.sessionId)}\0${key.commandId}`;
  }

  private mapFor<T>(store: Map<string, Map<string, T>>, bucketKey: string): Map<string, T> {
    let bucket = store.get(bucketKey);
    if (!bucket) {
      bucket = new Map();
      store.set(bucketKey, bucket);
    }
    return bucket;
  }

  private touchSettled(bucketKey: string, commandId: string, entry: CommandEntry): void {
    const bucket = this.mapFor(this.settled, bucketKey);
    bucket.delete(commandId);
    bucket.set(commandId, entry);
  }

  private rememberSettled(bucketKey: string, commandId: string, entry: CommandEntry): void {
    const bucket = this.mapFor(this.settled, bucketKey);
    bucket.delete(commandId);
    bucket.set(commandId, entry);
    while (bucket.size > PROTOCOL_V4_LIMITS.idempotencyTablePerSession) {
      const oldest = bucket.keys().next().value;
      if (oldest === undefined) break;
      bucket.delete(oldest);
    }
  }

  private extractCommandId(raw: unknown): string {
    if (typeof raw === "object" && raw !== null && "commandId" in raw) {
      const id = (raw as { commandId: unknown }).commandId;
      if (typeof id === "string") return id;
    }
    return "";
  }
}
