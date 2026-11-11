import {
  type AccessGrant,
  type AppScope,
  type AppSessionControlDependencies,
  type AppSessionRef,
  type AppSessionTrustedContext,
  type CliSessionControlDependencies,
  type CliSessionRef,
  type CliTrustedContext,
  type DeadlinePort,
  type OperationFeed,
  type OperationSnapshot,
  type OperationUpdate,
  type Scope,
  type SessionRef,
  type MutationResult,
} from "#session-control/contract";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

export function createManualDeadlines() {
  const pending = new Set<ReturnType<typeof deferred<void>>>();
  const port: DeadlinePort & { readonly pendingCount: number; expireAll(): void } = {
    get pendingCount() {
      return pending.size;
    },
    create() {
      const deadline = deferred<void>();
      pending.add(deadline);
      return {
        expired: deadline.promise,
        close() {
          pending.delete(deadline);
        },
      };
    },
    expireAll() {
      for (const deadline of pending) deadline.resolve();
    },
  };
  return port;
}

// 可控事件源只保存测试事件，不模拟真实 owner 的队列或持久去重。
export function createOperationFeed<R extends SessionRef>(initial: OperationSnapshot<R>) {
  const events: OperationUpdate<R>[] = [];
  let waiter: ReturnType<typeof deferred<IteratorResult<OperationUpdate<R>>>> | undefined;
  let ended = false;
  let failure: unknown;
  let closeCount = 0;
  const feed: OperationFeed<R> & {
    readonly closeCount: number;
    push(update: OperationUpdate<R>): void;
    end(): void;
    fail(error: unknown): void;
  } = {
    initial,
    get closeCount() {
      return closeCount;
    },
    updates: {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (events.length) return { done: false as const, value: events.shift()! };
            if (failure) throw failure;
            if (ended) return { done: true as const, value: undefined };
            waiter = deferred<IteratorResult<OperationUpdate<R>>>();
            return waiter.promise;
          },
          async return() {
            feed.end();
            return { done: true as const, value: undefined };
          },
        };
      },
    },
    push(update) {
      if (ended) throw new Error("Feed is closed");
      if (waiter) {
        const next = waiter;
        waiter = undefined;
        next.resolve({ done: false, value: update });
      } else events.push(update);
    },
    end() {
      ended = true;
      waiter?.resolve({ done: true, value: undefined });
      waiter = undefined;
    },
    fail(error) {
      failure = error;
      waiter?.reject(error);
      waiter = undefined;
    },
    async close() {
      if (closeCount === 0) {
        closeCount += 1;
        feed.end();
      }
    },
  };
  return feed;
}

export interface TestPortCall {
  method: string;
  ctx: unknown;
  input: unknown;
  grant?: unknown;
}
interface CommonTestPorts {
  calls: TestPortCall[];
  deadlines: ReturnType<typeof createManualDeadlines>;
}
export interface CliTestPorts extends CommonTestPorts {
  context: CliTrustedContext;
  cli: CliSessionControlDependencies;
}
export interface AppTestPorts extends CommonTestPorts {
  /** 会话类调用方（模型工具）的上下文；客户端类由测试按需自行构造。 */
  context: AppSessionTrustedContext;
  app: AppSessionControlDependencies;
}
export function createTestPorts(kind: "cli", root: CliSessionRef): CliTestPorts;
export function createTestPorts(kind: "app", root: AppSessionRef): AppTestPorts;
export function createTestPorts(
  kind: "cli" | "app",
  root: SessionRef,
): CliTestPorts | AppTestPorts {
  const calls: TestPortCall[] = [];
  const deadlines = createManualDeadlines();
  function record(method: string, ctx: unknown, input: unknown, grant?: unknown) {
    calls.push({ method, ctx, input, grant });
  }
  const summary = <R extends SessionRef>(session: R) => ({
    session,
    title: "test session",
    status: "idle" as const,
    availableActions: [],
  });
  const applied = (requestId: string): MutationResult => ({ status: "applied", requestId });
  const authorize = async <S extends Scope>(
    ctx: unknown,
    request: { scope: S },
  ): Promise<AccessGrant<S>> => {
    record("authorize", ctx, request);
    return { scope: request.scope, fence: "test-epoch" };
  };
  const observations = {
    async open<R extends SessionRef>(
      _ctx: unknown,
      operation: { session: R; sessionId: string; commandId: string },
    ) {
      return createOperationFeed({
        operation,
        epoch: "test-epoch",
        revision: 0,
        status: "unknown",
      });
    },
  };
  if (kind === "cli" && root.kind === "cli") {
    const scope = {
      kind: "cli" as const,
      workspacePath: root.workspacePath,
      workspaceIdentity: root.workspaceIdentity,
    };
    const context: CliTrustedContext = {
      callerId: "test-caller",
      rootSession: root,
      allowedScopes: [scope],
    };
    const cli: CliSessionControlDependencies = {
      access: { authorize },
      deadlines,
      observations,
      sessions: {
        async resolveSession(ctx, sessionId) {
          record("resolveSession", ctx, sessionId);
          return sessionId.startsWith("sess_missing") ? undefined : { ...root, sessionId };
        },
        async listSessions(ctx, input, grant) {
          record("listSessions", ctx, input, grant);
          return { sessions: [] };
        },
        async readSession(ctx, input, grant) {
          record("readSession", ctx, input, grant);
          return input.view === "summary"
            ? { view: "summary", summary: summary(input.session) }
            : { view: "messages", session: input.session, messages: [] };
        },
      },
      execution: {
        async createSession(ctx, input, grant) {
          record("createSession", ctx, input, grant);
          const session: CliSessionRef = {
            ...scope,
            workspacePath: scope.workspacePath,
            sessionId: "sess_created",
          };
          return {
            requestId: input.requestId,
            creation: "created",
            firstInput: "accepted",
            delivery: "start_now",
            session,
            operation: { session, sessionId: session.sessionId, commandId: input.requestId },
          };
        },
        async forkSession(ctx, input, grant) {
          record("forkSession", ctx, input, grant);
          return {
            requestId: input.requestId,
            status: "created",
            session: { ...input.session, sessionId: "sess_fork" },
          };
        },
        async sendToSession(ctx, input, grant) {
          record("sendToSession", ctx, input, grant);
          return {
            requestId: input.requestId,
            session: input.session,
            operation: {
              session: input.session,
              sessionId: input.session.sessionId,
              commandId: input.requestId,
            },
            admission: "accepted",
            delivery: "queued",
          };
        },
        async interruptSession(ctx, input, grant) {
          record("interruptSession", ctx, input, grant);
          return applied(input.requestId);
        },
        async renameSession(ctx, input, grant) {
          record("renameSession", ctx, input, grant);
          return applied(input.requestId);
        },
      },
    };
    return { calls, context, deadlines, cli };
  }
  if (root.kind !== "app") throw new Error("Expected App root");
  const project = root.project ?? {
    kind: "app" as const,
    projectId: "project-1",
    sourceServerId: root.sourceServerId,
  };
  const scope: AppScope = { ...project, scope: "project" };
  const context: AppSessionTrustedContext = {
    callerId: "test-caller",
    rootSession: { ...root, project },
    allowedScopes: [
      scope,
      {
        kind: "app",
        scope: "workspace",
        workspacePath: root.workspacePath,
        workspaceIdentity: root.workspaceIdentity,
        sourceServerId: root.sourceServerId,
      },
    ],
  };
  const app: AppSessionControlDependencies = {
    access: { authorize },
    deadlines,
    observations,
    sessions: {
      async resolveSession(ctx, sessionId) {
        record("resolveSession", ctx, sessionId);
        return sessionId.startsWith("sess_missing") ? undefined : { ...root, sessionId };
      },
      async listSessions(ctx, input, grants) {
        record("listSessions", ctx, input, grants);
        return {
          sessions: [],
          searchScope: { scopes: grants.map((grant) => grant.scope), unavailableSources: [] },
        };
      },
      async readSession(ctx, input, grant) {
        record("readSession", ctx, input, grant);
        return input.view === "summary"
          ? { view: "summary", summary: summary(input.session) }
          : { view: "messages", session: input.session, messages: [] };
      },
    },
    execution: {
      async createSession(ctx, input, grant) {
        record("createSession", ctx, input, grant);
        const session: AppSessionRef = {
          ...root,
          sessionId: "sess_created",
          project: input.project,
        };
        return {
          requestId: input.requestId,
          creation: "created",
          firstInput: "accepted",
          delivery: "start_now",
          session,
          operation: { session, sessionId: session.sessionId, commandId: input.requestId },
        };
      },
      async forkSession(ctx, input, grant) {
        record("forkSession", ctx, input, grant);
        return {
          requestId: input.requestId,
          status: "created",
          session: { ...input.session, sessionId: "sess_fork" },
        };
      },
      async sendToSession(ctx, input, grant) {
        record("sendToSession", ctx, input, grant);
        return {
          requestId: input.requestId,
          session: input.session,
          operation: {
            session: input.session,
            sessionId: input.session.sessionId,
            commandId: input.requestId,
          },
          admission: "accepted",
          delivery: "queued",
        };
      },
      async interruptSession(ctx, input, grant) {
        record("interruptSession", ctx, input, grant);
        return applied(input.requestId);
      },
      async renameSession(ctx, input, grant) {
        record("renameSession", ctx, input, grant);
        return applied(input.requestId);
      },
    },
    projects: {
      async listProjects(ctx, input, grants) {
        record("listProjects", ctx, input, grants);
        return {
          projects: [],
          searchScope: { scopes: grants.map((grant) => grant.scope), unavailableSources: [] },
        };
      },
    },
    organization: {
      async setSessionArchived(ctx, input, grant) {
        record("setSessionArchived", ctx, input, grant);
        return applied(input.requestId);
      },
      async setSessionPinned(ctx, input, grant) {
        record("setSessionPinned", ctx, input, grant);
        return applied(input.requestId);
      },
    },
    navigation: {
      async openSession(ctx, input, grant) {
        record("openSession", ctx, input, grant);
        return { status: "opened", ...(ctx.uiTarget ? { uiTarget: ctx.uiTarget } : {}) };
      },
    },
  };
  return { calls, context, deadlines, app };
}

// 生产适配器夹具可以复用该断言，避免测试替身接受真实接口不满足的序列。
export async function assertOperationFeedContract(
  feed: OperationFeed,
  expected: { commandId: string; epoch: string; revision: number },
): Promise<void> {
  if (
    feed.initial.operation.commandId !== expected.commandId ||
    feed.initial.epoch !== expected.epoch ||
    feed.initial.revision !== expected.revision
  )
    throw new Error("Unexpected observation baseline");
  await feed.close();
  await feed.close();
}
