import {
  appCreateSessionInputSchema,
  appForkSessionInputSchema,
  appInterruptSessionInputSchema,
  appListProjectsInputSchema,
  appListSessionsInputSchema,
  appListSessionsResultSchema,
  appOpenSessionInputSchema,
  appReadSessionInputSchema,
  appRenameSessionInputSchema,
  appSendToSessionInputSchema,
  appSetSessionArchivedInputSchema,
  appSetSessionPinnedInputSchema,
  listProjectsResultSchema,
  type AppSearchScope,
  type AppSessionControl,
  type AppSessionControlDependencies,
} from "#session-control/contract/app";
import { appWaitSessionsInputSchema } from "#session-control/contract/observation";
import {
  mutationResultSchema,
  openSessionResultSchema,
  SessionControlError,
  type AccessGrant,
  type AppScope,
  type AppSessionRef,
  type AppTrustedContext,
  type SessionControlAction,
} from "#session-control/contract/common";
import {
  createSessionResultSchema,
  forkSessionResultSchema,
  readSessionResultSchema,
  sendToSessionResultSchema,
  type CreateSessionResult,
  type ForkSessionResult,
  type ReadSessionResult,
  type SendToSessionResult,
} from "#session-control/contract/results";
import {
  assertOutputAuthorized,
  assertOutputScope,
  assertOutputSession,
  projectScope,
  scopeAllows,
  sessionScope,
} from "#session-control/domain/reference-scope";
import {
  assertActive,
  authorize,
  parseInput,
  parseOutput,
  resolveTarget,
} from "#session-control/application/common/boundary";
import { waitForOperations } from "#session-control/application/common/wait";

export type {
  AppSessionControl,
  AppSessionControlDependencies,
} from "#session-control/contract/app";

function assertSearchScope(search: AppSearchScope, grants: readonly AccessGrant<AppScope>[]): void {
  // legacy 来源可能没有可授予的项目范围；不可用来源仅作诊断，不能据此放行范围或列表行。
  if (search.scopes.some((scope) => !grants.some((grant) => scopeAllows(grant.scope, scope))))
    throw new SessionControlError("invalid_output", "Owner returned an unauthorized search scope");
}

export function createAppSessionControl(ports: AppSessionControlDependencies): AppSessionControl {
  const accessSession = (
    ctx: AppTrustedContext,
    action: SessionControlAction,
    session: AppSessionRef,
  ) => authorize(ports.access, ctx, action, sessionScope(session) as AppScope, session);
  const target = <T extends { session?: AppSessionRef; sessionId?: string }>(
    ctx: AppTrustedContext,
    input: T,
  ) => resolveTarget(ctx, input, (sessionId) => ports.sessions.resolveSession(ctx, sessionId));
  return {
    async listProjects(ctx, raw) {
      const input = parseInput(appListProjectsInputSchema, raw);
      assertActive(ctx);
      // 规格 0.14：host 过滤已从工具面删除，发现范围恒为可信上下文授予的全部来源。
      const scopes = (ctx.discoveryScopes ?? ctx.allowedScopes).filter(
        (scope) => scope.scope === "host" || scope.scope === "project",
      );
      const grants = await Promise.all(
        scopes.map((scope) => authorize(ports.access, ctx, "listProjects", scope)),
      );
      const result = parseOutput(
        listProjectsResultSchema,
        await ports.projects.listProjects(ctx, input, grants),
      );
      assertActive(ctx);
      assertSearchScope(result.searchScope, grants);
      for (const item of result.projects) {
        if (
          !result.searchScope.scopes.some((scope) => scopeAllows(scope, projectScope(item.project)))
        )
          throw new SessionControlError("invalid_output", "Owner returned an unauthorized project");
      }
      return result;
    },
    async listSessions(ctx, raw) {
      const input = parseInput(appListSessionsInputSchema, raw);
      assertActive(ctx);
      // 默认补 caller 条件会在标题匹配前漏掉其他项目；仅显式过滤可收窄 Host 发现范围。
      const scopes: readonly AppScope[] = input.project
        ? [projectScope(input.project)]
        : (ctx.discoveryScopes ?? ctx.allowedScopes);
      const grants = await Promise.all(
        scopes.map((scope) => authorize(ports.access, ctx, "listSessions", scope)),
      );
      const result = parseOutput(
        appListSessionsResultSchema,
        await ports.sessions.listSessions(ctx, input, grants),
      );
      assertActive(ctx);
      assertSearchScope(result.searchScope, grants);
      for (const item of result.sessions) {
        // 只在输出复验时使用实际成功搜索范围，不改写 owner 收到的操作权限。
        assertOutputAuthorized(item.session, { ...ctx, allowedScopes: result.searchScope.scopes });
        const classified = item.session.project;
        if (
          classified &&
          !result.searchScope.scopes.some((scope) => scopeAllows(scope, projectScope(classified)))
        )
          throw new SessionControlError(
            "invalid_output",
            "Unclassified workspace query returned a project session",
          );
      }
      return result;
    },
    async readSession(ctx, raw) {
      const input = await target(ctx, parseInput(appReadSessionInputSchema, raw));
      const grant = await accessSession(ctx, "readSession", input.session);
      const result = parseOutput(
        readSessionResultSchema,
        await ports.sessions.readSession(ctx, input, grant),
      );
      if (result.view !== input.view)
        throw new SessionControlError("invalid_output", "Owner returned a different read view");
      assertOutputSession(
        result.view === "summary" ? result.summary.session : result.session,
        input.session,
        ctx,
      );
      return result as ReadSessionResult<AppSessionRef>;
    },
    async createSession(ctx, raw) {
      const input = parseInput(appCreateSessionInputSchema, raw);
      const grant = await authorize(
        ports.access,
        ctx,
        "createSession",
        projectScope(input.project),
      );
      const result = parseOutput(
        createSessionResultSchema,
        await ports.execution.createSession(ctx, input, grant),
      );
      if (result.session) assertOutputScope(result.session, grant.scope, ctx);
      if (result.operation && result.session)
        assertOutputSession(result.operation.session, result.session, ctx);
      return result as CreateSessionResult<AppSessionRef>;
    },
    async forkSession(ctx, raw) {
      const input = await target(ctx, parseInput(appForkSessionInputSchema, raw));
      const grant = await accessSession(ctx, "forkSession", input.session);
      const result = parseOutput(
        forkSessionResultSchema,
        await ports.execution.forkSession(ctx, input, grant),
      );
      if (result.session) {
        assertOutputScope(result.session, grant.scope, ctx);
        if (result.session.sessionId === input.session.sessionId)
          throw new SessionControlError("invalid_output", "Fork must create a new root session");
      }
      return result as ForkSessionResult<AppSessionRef>;
    },
    async sendToSession(ctx, raw) {
      const input = await target(ctx, parseInput(appSendToSessionInputSchema, raw));
      const grant = await accessSession(ctx, "sendToSession", input.session);
      const result = parseOutput(
        sendToSessionResultSchema,
        await ports.execution.sendToSession(ctx, input, grant),
      );
      assertOutputSession(result.session, input.session, ctx);
      assertOutputSession(result.operation.session, input.session, ctx);
      return result as SendToSessionResult<AppSessionRef>;
    },
    async waitSessions(ctx, raw) {
      const parsed = parseInput(appWaitSessionsInputSchema, raw);
      // 解析后补回 sessionId：OperationRef 同时携带完整引用（路由用）与裸 id（回执给模型用）。
      const operations = await Promise.all(
        parsed.operations.map(async (operation) => {
          const resolved = await target(ctx, operation);
          return { ...resolved, sessionId: resolved.session.sessionId };
        }),
      );
      return waitForOperations<AppSessionRef, AppScope>(ctx, { ...parsed, operations }, ports);
    },
    async interruptSession(ctx, raw) {
      const input = await target(ctx, parseInput(appInterruptSessionInputSchema, raw));
      const grant = await accessSession(ctx, "interruptSession", input.session);
      return parseOutput(
        mutationResultSchema,
        await ports.execution.interruptSession(ctx, input, grant),
      );
    },
    async renameSession(ctx, raw) {
      const input = await target(ctx, parseInput(appRenameSessionInputSchema, raw));
      const grant = await accessSession(ctx, "renameSession", input.session);
      return parseOutput(
        mutationResultSchema,
        await ports.execution.renameSession(ctx, input, grant),
      );
    },
    async openSession(ctx, raw) {
      const parsed = await target(ctx, parseInput(appOpenSessionInputSchema, raw));
      // 规格 0.14：uiTarget 已从工具面删除。目标 UI 只由可信上下文绑定决定——模型无从得知
      // window:<id> 这种内部标识，而绑定窗口本来就是正确答案。
      const input = { ...parsed, ...(ctx.uiTarget ? { uiTarget: ctx.uiTarget } : {}) };
      const grant = await accessSession(ctx, "openSession", input.session);
      if (!ports.navigation) return { status: "unavailable", reason: "navigation_unavailable" };
      return parseOutput(
        openSessionResultSchema,
        await ports.navigation.openSession(ctx, input, grant),
      );
    },
    async setSessionArchived(ctx, raw) {
      const input = await target(ctx, parseInput(appSetSessionArchivedInputSchema, raw));
      const grant = await accessSession(ctx, "setSessionArchived", input.session);
      return parseOutput(
        mutationResultSchema,
        await ports.organization.setSessionArchived(ctx, input, grant),
      );
    },
    async setSessionPinned(ctx, raw) {
      const input = await target(ctx, parseInput(appSetSessionPinnedInputSchema, raw));
      const grant = await accessSession(ctx, "setSessionPinned", input.session);
      return parseOutput(
        mutationResultSchema,
        await ports.organization.setSessionPinned(ctx, input, grant),
      );
    },
  };
}
