import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createRootTraceContext,
  createSessionId,
  SessionEventType,
  type MessageWithParts,
  type SessionId,
  type SessionInfo,
  type TraceContext,
  type TraceId,
  type TurnCompletePayload,
} from "@zcode/contracts";
import { createCliSessionControl } from "@zcode/session-control/cli";
import {
  SessionControlError,
  type AccessGrant,
  type CliScope,
  type CliSessionRef,
  type CliTrustedContext,
  type CreateSessionResult,
  type SendToSessionResult,
  type SessionSummary,
} from "@zcode/session-control/contracts";
import type { ZCodeApp } from "../app/types.js";
import { resolveStableForkTargetFromTranscript } from "../zcode-protocol-v4/stable-fork-target.js";
import {
  isTranscriptVisibleMessage,
  projectActiveSessionMessages,
} from "../active-transcript/index.js";
import type { CliSessionControlRuntime, CliSessionControlRuntimeOptions } from "./contract.js";
import { CliOperationObservations } from "./observation.js";

export type {
  CliRootAppRequest,
  CliSessionControlRuntime,
  CliSessionControlRuntimeOptions,
} from "./contract.js";

const DEFAULT_PAGE_SIZE = 50;
// 读本机会话库的列表只扫描有界窗口，避免一次把全部历史会话行解码进内存。
const MAX_LISTED_SESSIONS = 2000;
const DEFAULT_MAX_REQUESTS = 4096;
const DEFAULT_MAX_ROOTS = 128;
const CLOSE_REASON = "CLI session control owner closed";
const NO_OWNER =
  "No reachable independent CLI owner is registered for this session; history will not be restored";
const ROOT_ACTIONS = [
  "readSession",
  "sendToSession",
  "waitSessions",
  "interruptSession",
  "renameSession",
  "forkSession",
] as const;

type Root = {
  app: ZCodeApp;
  owned: boolean;
  verified: boolean;
  signal: AbortController;
  unsubscribe: () => void;
  completions: Set<Promise<unknown>>;
  prepared: boolean;
  failure?: string;
  preparation?: Promise<void>;
};
type RequestReceipt = { fingerprint: string; result: Promise<unknown> };

function scopeKey(scope: CliScope): string {
  return scope.workspaceIdentity?.trim() || resolve(scope.workspacePath);
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function pageOffset(cursor?: string): number {
  if (cursor === undefined) return 0;
  if (!/^offset:(0|[1-9][0-9]*)$/.test(cursor))
    throw new SessionControlError("invalid_input", "Invalid page cursor");
  const offset = Number(cursor.slice("offset:".length));
  if (!Number.isSafeInteger(offset))
    throw new SessionControlError("invalid_input", "Invalid page cursor");
  return offset;
}
function page<T>(
  items: T[],
  cursor?: string,
  limit = DEFAULT_PAGE_SIZE,
): { items: T[]; nextCursor?: string } {
  const offset = pageOffset(cursor);
  return {
    items: items.slice(offset, offset + limit),
    ...(offset + limit < items.length ? { nextCursor: `offset:${offset + limit}` } : {}),
  };
}

export function createCliSessionControlRuntime(
  options: CliSessionControlRuntimeOptions,
): CliSessionControlRuntime {
  const epoch = randomUUID();
  const maxRequests = options.limits?.requests ?? DEFAULT_MAX_REQUESTS;
  const maxRoots = options.limits?.roots ?? DEFAULT_MAX_ROOTS;
  if (![maxRequests, maxRoots].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new SessionControlError("invalid_input", "CLI owner capacity must be a positive integer");
  let rootReservations = 0;
  const workspace: CliScope = {
    ...options.workspace,
    workspacePath: resolve(options.workspace.workspacePath),
  };
  const roots = new Map<string, Root>();
  // 这是创建/请求 owner 的回执，不是第二份 accepted input queue；执行队列仍只归 Core。
  const receipts = new Map<string, RequestReceipt>();
  const observations = new CliOperationObservations(epoch);
  const pendingMutations = new Set<Promise<unknown>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  function assertOpen(): void {
    if (closing)
      throw new SessionControlError("unavailable", "CLI session control owner is closed");
  }
  function ref(sessionId: string): CliSessionRef {
    return { ...workspace, sessionId };
  }
  function owner(session: CliSessionRef): Root {
    if (
      scopeKey(session) !== scopeKey(workspace) ||
      resolve(session.workspacePath) !== workspace.workspacePath
    )
      throw new SessionControlError("forbidden", "Session workspace does not match this owner");
    const root = roots.get(session.sessionId);
    if (!root) throw new SessionControlError("unavailable", NO_OWNER);
    return root;
  }
  function writable(session: CliSessionRef): Root {
    const root = owner(session);
    // 关闭责任与来源证明独立；只有来源不明的恢复历史不能反向变成控制目标。
    if (root.failure) throw new SessionControlError("unavailable", root.failure);
    if (!root.verified)
      throw new SessionControlError(
        "unavailable",
        "Session source is not verified as an independent CLI root",
      );
    return root;
  }
  function reserveRoot(): void {
    if (roots.size + rootReservations >= maxRoots)
      throw new SessionControlError("unavailable", "CLI root capacity reached");
    rootReservations += 1;
  }
  function fence(ctx: CliTrustedContext): string {
    return digest([epoch, ctx.callerId, ctx.rootSession]);
  }
  function validate(ctx: CliTrustedContext, grant: AccessGrant<CliScope>): void {
    assertOpen();
    owner(ctx.rootSession);
    if (
      grant.fence !== fence(ctx) ||
      scopeKey(grant.scope) !== scopeKey(workspace) ||
      !ctx.allowedScopes.some((scope) => scopeKey(scope) === scopeKey(workspace))
    ) {
      throw new SessionControlError(
        "forbidden",
        "CLI authorization scope or owner generation changed",
      );
    }
  }
  // 读本机会话库只要求调用者 fence 有效；写操作仍用 validate 校验 owner 与 workspace。
  function validateRead(ctx: CliTrustedContext, grant: AccessGrant<CliScope>): void {
    if (!ctx.readAnyLocalSession) return validate(ctx, grant);
    assertOpen();
    owner(ctx.rootSession);
    if (grant.fence !== fence(ctx))
      throw new SessionControlError("forbidden", "CLI owner generation changed");
  }
  async function listStored(filter?: CliScope): Promise<SessionSummary<CliSessionRef>[]> {
    const stored = await options.sessionStore.listSessions({
      roots: true,
      ...(filter ? { directory: resolve(filter.workspacePath) } : {}),
      limit: MAX_LISTED_SESSIONS,
    });
    return Promise.all(
      stored
        .filter((item) => !filter || scopeKey(storedRef(item)) === scopeKey(filter))
        .map((item) => {
          const root = roots.get(item.id);
          return root?.verified ? summary(root) : storedSummary(item);
        }),
    );
  }
  function trace(ctx: CliTrustedContext, sessionId: SessionId): TraceContext {
    return createRootTraceContext({
      traceId: (ctx.traceId ?? roots.get(ctx.rootSession.sessionId)!.app.traceId) as TraceId,
      sessionId,
    });
  }
  function remember<T>(
    ctx: CliTrustedContext,
    action: string,
    input: { requestId: string },
    run: () => Promise<T>,
  ): Promise<T> {
    const key = digest([ctx.callerId, ctx.rootSession, input.requestId]);
    const fingerprint = digest([action, input]);
    const previous = receipts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new SessionControlError(
          "conflict",
          "requestId already belongs to a different request",
        );
      return previous.result as Promise<T>;
    }
    if (receipts.size >= maxRequests)
      throw new SessionControlError(
        "unavailable",
        "CLI request capacity reached; existing receipts remain queryable",
      );
    // 同步登记在调用任何异步工厂之前，重入与重试只能复用同一请求。
    const result = Promise.resolve().then(run);
    receipts.set(key, { fingerprint, result });
    pendingMutations.add(result);
    void result.then(
      () => pendingMutations.delete(result),
      () => pendingMutations.delete(result),
    );
    return result;
  }
  function commandId(ctx: CliTrustedContext, requestId: string): string {
    return `cli-control-${digest([ctx.callerId, ctx.rootSession, requestId])}`;
  }
  function attach(app: ZCodeApp, owned: boolean, verified = true): Root {
    if (roots.has(app.sessionId)) {
      const existing = roots.get(app.sessionId)!;
      if (existing.app !== app)
        throw new SessionControlError("conflict", "A different runtime already owns this session");
      return existing;
    }
    const root: Root = {
      app,
      owned,
      verified,
      prepared: false,
      signal: new AbortController(),
      completions: new Set(),
      unsubscribe: app.runtime.subscribeEvents({
        onSessionEvent: (event) => observations.onEvent(event),
      }),
    };
    roots.set(app.sessionId, root);
    return root;
  }
  function track(root: Root, completion: Promise<unknown>): void {
    root.completions.add(completion);
    void completion.then(
      () => root.completions.delete(completion),
      () => root.completions.delete(completion),
    );
  }
  // 本机会话库中的任意会话：只读持久事实，不恢复 runtime，也不认领 owner。
  function storedRef(stored: SessionInfo): CliSessionRef {
    return {
      kind: "cli",
      workspacePath: stored.directory,
      ...(stored.workspaceID ? { workspaceIdentity: stored.workspaceID } : {}),
      sessionId: stored.id,
    };
  }
  // 其他会话只有持久事实：状态未知，只宣称可读，不宣称可写。
  function storedSummary(stored: SessionInfo): SessionSummary<CliSessionRef> {
    return {
      session: storedRef(stored),
      title: stored.title,
      status: "unknown",
      availableActions: ["readSession"],
      updatedAt: new Date(stored.time.updated).toISOString(),
    };
  }
  async function readStored(sessionId: string): Promise<SessionInfo | undefined> {
    const stored = await options.sessionStore.getSession(sessionId as SessionId);
    return stored && !stored.time.deleted ? stored : undefined;
  }
  // 只返回 active 分支，并按产品界面同一判据去掉隐藏提醒，读取方看到的就是用户在界面里看到的对话。
  async function readVisibleMessages(stored: SessionInfo): Promise<MessageWithParts[]> {
    const messages = await options.sessionStore.messages({ sessionID: stored.id });
    const live = roots.get(stored.id);
    const rewindEvents = live
      ? (await live.app.runtime.getSessionEventStore().getEvents(stored.id)).filter(
          (event) => event.type === SessionEventType.RewindTriggered,
        )
      : [];
    return projectActiveSessionMessages(messages, stored, rewindEvents).filter(
      isTranscriptVisibleMessage,
    );
  }
  async function summary(root: Root): Promise<SessionSummary<CliSessionRef>> {
    const stored = await options.sessionStore.getSession(root.app.sessionId);
    if (stored?.time.deleted)
      throw new SessionControlError("unavailable", "Session has been deleted");
    const executionId = root.app.runtime.getActiveForegroundExecutionId();
    return {
      session: ref(root.app.sessionId),
      title: stored?.title ?? "New session",
      status:
        observations.statusForSession(root.app.sessionId) ??
        (root.app.runtime.hasActiveOrQueuedTurnWork() ? "running" : "idle"),
      availableActions: root.failure ? ["readSession"] : root.verified ? [...ROOT_ACTIONS] : [],
      ...(stored ? { updatedAt: new Date(stored.time.updated).toISOString() } : {}),
      ...(executionId ? { executionId } : {}),
    };
  }
  async function submit(
    ctx: CliTrustedContext,
    root: Root,
    prompt: string,
    requestId: string,
    grant: AccessGrant<CliScope>,
  ): Promise<SendToSessionResult<CliSessionRef>> {
    const session = ref(root.app.sessionId);
    // 回执带裸 sessionId，模型才能把整个 operation 原样放回 WaitSessions（规格 0.14）。
    const operation = {
      session,
      sessionId: session.sessionId,
      commandId: commandId(ctx, requestId),
    };
    const observed = observations.register(operation);
    const executionOptions = {
      inputId: operation.commandId,
      abortSignal: root.signal.signal,
      traceContext: trace(ctx, root.app.sessionId),
    };
    const watch = (completion: ReturnType<ZCodeApp["submitPrompt"]>): void => {
      track(
        root,
        completion.then(
          (result) => {
            for (const event of result.events) observations.onEvent(event);
            if (!["completed", "interrupted", "failed"].includes(observed.snapshot.status))
              observations.update(observed, "unknown", {
                reason: "Runtime completed without a correlated terminal event",
              });
          },
          (error: unknown) =>
            observations.update(observed, root.signal.signal.aborted ? "interrupted" : "failed", {
              reason: error instanceof Error ? error.message : String(error),
            }),
        ),
      );
    };
    try {
      if (!root.owned && root.app.runtime.getActiveForegroundExecutionId()) root.prepared = true;
      if (root.preparation) await root.preparation;
      validate(ctx, grant);
      if (root.failure) throw new SessionControlError("unavailable", root.failure);
      if (root.prepared) {
        // 根因：sendInput(queueDelivery=queue) 只建 V4 deferred 项，独立 CLI 没有 V4 消费者。
        // 已初始化的独立根直接进入 Core 原有 command FIFO；同步调用之间无 await，无第二队列。
        const queued = root.app.runtime.hasActiveOrQueuedTurnWork();
        const completion = root.app.runtime.executeTurn(prompt, undefined, executionOptions);
        if (queued) observations.update(observed, "queued");
        watch(completion);
        return {
          session,
          operation,
          requestId,
          admission: "accepted",
          delivery: queued ? "queued" : "start_now",
        };
      }
      const prepare = (async () => {
        const admission = await root.app.sendInput(prompt, {
          ...executionOptions,
          requireIdle: true,
        });
        if (admission.kind !== "started_turn") return admission;
        root.prepared = true;
        observed.turnId = admission.turnId;
        watch(admission.completion);
        return admission;
      })();
      root.preparation = prepare.then(
        () => undefined,
        () => undefined,
      );
      const admission = await prepare;
      if (admission.kind !== "started_turn") {
        observations.update(observed, "failed", { reason: "Initial execution was not admitted" });
        return {
          session,
          operation,
          requestId,
          admission: "rejected",
          delivery: "none",
          reason: "Initial execution was not admitted",
        };
      }
      return { requestId, session, operation, admission: "accepted", delivery: "start_now" };
    } catch (error) {
      // Bug 根因：这里原先把任意 admission 异常写进 root.failure，而 writable() 把该字段当成
      // 永久不可写。于是 provider 抖动、网络错误等可恢复失败会让刚建好的会话再也发不出消息。
      // admission 的不确定属于**这一个请求**：只把该 operation 记为 unknown 并保留原回执，
      // root 的可写性仍由关闭、runtime 损坏与 owner 代际失效决定（见 createSession / fork 的
      // catch 与 close 路径）。调用方换新 requestId 即可重试。
      observations.update(observed, "unknown", {
        reason: error instanceof Error ? error.message : String(error),
      });
      observed.settle();
      return {
        session,
        operation,
        requestId,
        admission: "unknown",
        delivery: "unknown",
        reason: "Input admission failed without a conclusive receipt",
      };
    }
  }

  const control = createCliSessionControl({
    access: {
      async authorize(ctx, request) {
        assertOpen();
        owner(ctx.rootSession);
        // 读本机会话库不要求目标由本进程托管；仍要求调用者是本 manager 的根。
        if (
          (ctx as CliTrustedContext).readAnyLocalSession &&
          (request.action === "listSessions" || request.action === "readSession")
        )
          return { scope: request.scope, fence: fence(ctx) };
        if (scopeKey(request.scope) !== scopeKey(workspace))
          throw new SessionControlError(
            "forbidden",
            "This CLI owner is bound to a different workspace",
          );
        if (request.session) {
          const target = owner(request.session);
          if (!target.verified)
            throw new SessionControlError(
              "unavailable",
              "Session source is not verified as an independent CLI root",
            );
        }
        return { scope: workspace, fence: fence(ctx) };
      },
    },
    sessions: {
      async resolveSession(ctx, sessionId) {
        assertOpen();
        owner(ctx.rootSession);
        // 托管根返回 manager 的规范引用，保证与 create/list 结果及写操作授权使用同一身份。
        if (roots.has(sessionId)) return ref(sessionId);
        const stored = await readStored(sessionId);
        return stored ? storedRef(stored) : undefined;
      },
      async listSessions(ctx, input, grant) {
        validateRead(ctx, grant);
        // 规格 0.14：workspace 过滤器已从工具面删除；只读全库授权在场时读整个本机会话库。
        const items = ctx.readAnyLocalSession
          ? await listStored(undefined)
          : await Promise.all([...roots.values()].filter((root) => root.verified).map(summary));
        const query = input.query?.toLocaleLowerCase();
        const paged = page(
          items
            .filter((item) => !query || item.title.toLocaleLowerCase().includes(query))
            .sort(
              (a, b) =>
                (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
                a.session.sessionId.localeCompare(b.session.sessionId),
            ),
          input.cursor,
          input.limit,
        );
        return {
          sessions: paged.items,
          ...(paged.nextCursor ? { nextCursor: paged.nextCursor } : {}),
        };
      },
      async readSession(ctx, input, grant) {
        validateRead(ctx, grant);
        // 托管根沿用 manager 的规范引用与实时摘要；其他会话只在可读本机会话库时按 ID 读持久层。
        const root =
          roots.has(input.session.sessionId) || !ctx.readAnyLocalSession
            ? owner(input.session)
            : undefined;
        const stored = await readStored(input.session.sessionId);
        if (!root && (!stored || scopeKey(storedRef(stored)) !== scopeKey(input.session)))
          throw new SessionControlError("forbidden", "Session is not in the local session store");
        if (input.view === "summary")
          return { view: "summary", summary: root ? await summary(root) : storedSummary(stored!) };
        const visible = stored ? await readVisibleMessages(stored) : [];
        const paged = page(visible, input.cursor, input.limit);
        return {
          view: "messages",
          session: input.session,
          messages: paged.items.map((message) => ({
            id: String(message.info.id),
            role: message.info.role,
            text: message.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          })),
          ...(paged.nextCursor ? { nextCursor: paged.nextCursor } : {}),
        };
      },
    },
    execution: {
      async createSession(ctx, input, grant) {
        validate(ctx, grant);
        return remember(
          ctx,
          "createSession",
          input,
          async (): Promise<CreateSessionResult<CliSessionRef>> => {
            validate(ctx, grant);
            reserveRoot();
            const sessionId = createSessionId();
            let app: ZCodeApp | undefined;
            try {
              app = await options.createRootApp({
                sessionId,
                cwd: workspace.workspacePath,
                resume: false,
                ...(input.model ? { model: input.model } : {}),
                traceContext: trace(ctx, sessionId),
              });
              if (app.sessionId !== sessionId) {
                await app.close?.();
                throw new SessionControlError("conflict", "Factory returned a different session");
              }
              const root = attach(app, true);
              assertOpen();
              // 新根采用独立安全模式；不从 actor 继承 yolo 或审批。
              await app.setMode("build");
              await app.runtime.ensureSessionPersistedForExternalActivity(input.prompt, {
                traceContext: trace(ctx, sessionId),
              });
              validate(ctx, grant);
              const first = await submit(ctx, root, input.prompt, input.requestId, grant);
              return {
                requestId: input.requestId,
                creation: "created",
                firstInput: first.admission,
                delivery: first.delivery,
                session: first.session,
                operation: first.operation,
                ...(first.reason ? { reason: first.reason } : {}),
              };
            } catch (error) {
              const root = roots.get(sessionId);
              if (root) root.failure = error instanceof Error ? error.message : String(error);
              // 创建后持久化失败可能已写入 session；保留稳定引用与回执，禁止重试再建。
              return {
                requestId: input.requestId,
                creation: app ? "created" : "unknown",
                firstInput: "unknown",
                delivery: "unknown",
                session: ref(sessionId),
                reason: error instanceof Error ? error.message : String(error),
              };
            } finally {
              rootReservations -= 1;
            }
          },
        );
      },
      async sendToSession(ctx, input, grant) {
        validate(ctx, grant);
        return remember(ctx, "sendToSession", input, async () => {
          validate(ctx, grant);
          return submit(ctx, writable(input.session), input.prompt, input.requestId, grant);
        });
      },
      async interruptSession(ctx, input, grant) {
        validate(ctx, grant);
        return remember(ctx, "interruptSession", input, async () => {
          validate(ctx, grant);
          const result = writable(input.session).app.runtime.stopActiveForegroundExecution({
            expectedForegroundExecutionId: input.expectedExecutionId,
            reason: "CLI session control interrupt",
          });
          return result.kind === "stopped"
            ? { requestId: input.requestId, status: "applied" as const }
            : {
                requestId: input.requestId,
                status: "rejected" as const,
                reason: result.kind === "mismatch" ? "Execution changed" : "No active execution",
              };
        });
      },
      async renameSession(ctx, input, grant) {
        validate(ctx, grant);
        return remember(ctx, "renameSession", input, async () => {
          validate(ctx, grant);
          const root = writable(input.session);
          await root.app.setCustomSessionTitle({
            title: input.title,
            traceContext: trace(ctx, root.app.sessionId),
          });
          return { requestId: input.requestId, status: "applied" as const };
        });
      },
      async forkSession(ctx, input, grant) {
        validate(ctx, grant);
        // 规格 0.14：每个回执都要带请求身份，收成一个构造器，避免逐处重复三行。
        const rejected = (reason: string) =>
          ({ requestId: input.requestId, status: "rejected", reason }) as const;
        return remember(ctx, "forkSession", input, async () => {
          const source = writable(input.session);
          const leaseId = commandId(ctx, input.requestId);
          const lease = source.app.runtime.acquireForegroundPromotionLease({
            leaseId,
            mode: "idle-only",
            promotedInputId: leaseId,
          });
          if (lease.kind !== "acquired")
            return rejected("Fork requires an idle owner to validate independent permissions");
          try {
            const stored = await options.sessionStore.getSession(source.app.sessionId);
            // 现有 stable fork 原子 bundle 会复制 permission；build 不会清掉 allow/deny/ask。
            // 无安全清除参数前只允许无持久权限规则、无后台写者的 idle 来源，绝不在 adapter 改库。
            if (
              !stored ||
              source.app.runtime.hasRunningBackgroundTasks() ||
              Object.keys(stored.permission ?? {}).some((key) => key !== "mode") ||
              (stored.permission?.mode && stored.permission.mode !== "build")
            )
              return rejected(
                "Stable fork cannot copy session permission rules into an independent root",
              );
            const messages = await options.sessionStore.messages({
              sessionID: source.app.sessionId,
            });
            const boundary = messages.find((message) => message.info.id === input.atMessage);
            if (
              !boundary ||
              boundary.info.role !== "assistant" ||
              boundary.info.error ||
              !boundary.info.anchor?.turnId
            )
              return rejected("Message has no verifiable stable assistant boundary");
            if (boundary.info.mode !== "build")
              return rejected(
                "Stable fork cannot copy historical permission mode into an independent root",
              );
            const turnId = boundary.info.anchor.turnId;
            const events = await source.app.runtime
              .getSessionEventStore()
              .getEvents(source.app.sessionId);
            const complete = events.find(
              (event) =>
                event.turnId === turnId &&
                event.type === SessionEventType.TurnComplete &&
                (event.payload as TurnCompletePayload).resultType === "success",
            );
            const laterAssistant = messages
              .slice(messages.indexOf(boundary) + 1)
              .some(
                (message) =>
                  message.info.role === "assistant" && message.info.anchor?.turnId === turnId,
              );
            if (!complete || laterAssistant)
              return rejected("Target turn is not a completed stable assistant boundary");
            const resolution = await resolveStableForkTargetFromTranscript({
              candidate: {
                productTurnId: boundary.info.anchor.productTurnId ?? turnId,
                transcriptTurnId: turnId,
                boundaryMessageId: input.atMessage,
                startMessageId: boundary.info.parentID,
              },
              messages,
              store: options.sessionStore,
            });
            if (!resolution.ok) return rejected(resolution.reasonCode);
            validate(ctx, grant);
            reserveRoot();
            const childId = createSessionId();
            let committed = false;
            try {
              await source.app.runtime.forkStableConversationAtMessage({
                forkedSessionId: childId,
                target: resolution.target,
                goalBoundary: resolution.goalBoundary,
                sourceCommandId: commandId(ctx, input.requestId),
                traceContext: trace(ctx, source.app.sessionId),
              });
              committed = true;
              const app = await options.createRootApp({
                sessionId: childId,
                cwd: workspace.workspacePath,
                resume: true,
                traceContext: trace(ctx, childId),
              });
              if (app.sessionId !== childId) {
                await app.close?.();
                throw new SessionControlError(
                  "conflict",
                  "Factory returned a different fork session",
                );
              }
              const root = attach(app, true);
              assertOpen();
              await app.resume({ traceContext: trace(ctx, childId) });
              // 历史模型属于 fork 点；权限模式不沿 actor/fork 的旧 yolo 扩散。
              await app.setMode("build");
              root.prepared = true;
              return {
                requestId: input.requestId,
                status: "created" as const,
                session: ref(childId),
              };
            } catch (error) {
              const root = roots.get(childId);
              if (root) root.failure = error instanceof Error ? error.message : String(error);
              return {
                requestId: input.requestId,
                status: committed ? ("created" as const) : ("unknown" as const),
                session: ref(childId),
                reason: error instanceof Error ? error.message : String(error),
              };
            } finally {
              rootReservations -= 1;
            }
          } finally {
            source.app.runtime.releaseForegroundPromotionLease(leaseId);
          }
        });
      },
    },
    observations: {
      async open(ctx, operation, signal, grant) {
        validate(ctx, grant);
        owner(operation.session);
        return observations.open(operation, signal);
      },
    },
    deadlines: {
      create(timeoutMs) {
        let timer: ReturnType<typeof setTimeout>;
        const expired = new Promise<void>((resolveDeadline) => {
          timer = setTimeout(resolveDeadline, timeoutMs);
        });
        return { expired, close: () => clearTimeout(timer) };
      },
    },
  });

  async function closeRoot(root: Root): Promise<void> {
    if (!root.owned) return;
    root.app.runtime.beginShutdown();
    root.signal.abort(new Error(CLOSE_REASON));
    root.app.runtime.stopActiveForegroundExecution({ reason: CLOSE_REASON });
    // 一个清理步骤失败不能跳过 App 资源释放；所有失败由 close 汇总报告。
    const results = await Promise.allSettled([
      root.app.clearQueueItems(),
      root.app.runtime.cancelRunningRuntimeBackgroundTasks({ reason: "subagent_cancelled" }),
      Promise.allSettled(root.completions),
    ]);
    results.push(...(await Promise.allSettled([root.app.close?.()])));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "CLI root cleanup failed");
  }
  return {
    control,
    attachRoot(app, provenance) {
      assertOpen();
      const root = attach(app, false, provenance === "new-independent-root");
      // 新建主根首次活动由它自己的 App/TUI 驱动；一旦已有执行，后续用原 FIFO。
      root.prepared = app.runtime.hasActiveOrQueuedTurnWork();
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      // 先同步中断，避免等待在途 admission 时错过退出；晚到新 app 由创建路径立即关闭。
      for (const root of roots.values())
        if (root.owned) {
          root.app.runtime.beginShutdown();
          root.signal.abort(new Error(CLOSE_REASON));
          root.app.runtime.stopActiveForegroundExecution({ reason: CLOSE_REASON });
        }
      closePromise = (async () => {
        await Promise.allSettled(pendingMutations);
        const results = await Promise.allSettled([...roots.values()].map(closeRoot));
        observations.close();
        for (const root of roots.values()) root.unsubscribe();
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, "CLI roots could not close cleanly");
      })();
      return closePromise;
    },
  };
}
