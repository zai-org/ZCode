import {
  cliCreateSessionInputSchema,
  cliForkSessionInputSchema,
  cliInterruptSessionInputSchema,
  cliListSessionsInputSchema,
  cliReadSessionInputSchema,
  cliRenameSessionInputSchema,
  cliSendToSessionInputSchema,
  type CliSessionControl,
  type CliSessionControlDependencies,
} from "#session-control/contract/cli";
import { cliWaitSessionsInputSchema } from "#session-control/contract/observation";
import {
  mutationResultSchema,
  SessionControlError,
  type CliScope,
  type CliSessionRef,
  type CliTrustedContext,
  type SessionControlAction,
} from "#session-control/contract/common";
import {
  createSessionResultSchema,
  forkSessionResultSchema,
  listSessionsResultSchema,
  readSessionResultSchema,
  sendToSessionResultSchema,
  type CreateSessionResult,
  type ForkSessionResult,
  type ListSessionsResult,
  type ReadSessionResult,
  type SendToSessionResult,
} from "#session-control/contract/results";
import {
  assertOutputScope,
  assertOutputSession,
  defaultCliScope,
  sameSession,
  sessionScope,
} from "#session-control/domain/reference-scope";
import {
  authorize,
  parseInput,
  parseOutput,
  resolveTarget,
} from "#session-control/application/common/boundary";
import { waitForOperations } from "#session-control/application/common/wait";

export type {
  CliSessionControl,
  CliSessionControlDependencies,
} from "#session-control/contract/cli";

export function createCliSessionControl(ports: CliSessionControlDependencies): CliSessionControl {
  const accessSession = (
    ctx: CliTrustedContext,
    action: SessionControlAction,
    session: CliSessionRef,
  ) => authorize(ports.access, ctx, action, sessionScope(session) as CliScope, session);
  const target = <T extends { session?: CliSessionRef; sessionId?: string }>(
    ctx: CliTrustedContext,
    input: T,
  ) => resolveTarget(ctx, input, (sessionId) => ports.sessions.resolveSession(ctx, sessionId));
  return {
    async listSessions(ctx, raw) {
      const parsed = parseInput(cliListSessionsInputSchema, raw);
      // 规格 0.14：workspace 过滤器已从工具面删除（发现链循环）。范围恒为调用者绑定的 workspace；
      // 可读本机会话库时不收窄，否则跨目录的历史会话在标题匹配前就被排除。
      const input = { ...parsed, workspace: defaultCliScope(ctx.rootSession) };
      const listInput = ctx.readAnyLocalSession ? { ...parsed } : input;
      const grant = await authorize(ports.access, ctx, "listSessions", input.workspace);
      const result = parseOutput(
        listSessionsResultSchema,
        await ports.sessions.listSessions(ctx, listInput, grant),
      );
      for (const item of result.sessions) {
        if (item.session.kind !== "cli")
          throw new SessionControlError("invalid_output", "Owner returned a non-CLI session");
        // 没有只读全库授权时，返回行必须落在绑定 workspace 内。
        if (!ctx.readAnyLocalSession) assertOutputScope(item.session, grant.scope, ctx);
      }
      return result as ListSessionsResult<CliSessionRef>;
    },
    async readSession(ctx, raw) {
      const input = await target(ctx, parseInput(cliReadSessionInputSchema, raw));
      const grant = await accessSession(ctx, "readSession", input.session);
      const result = parseOutput(
        readSessionResultSchema,
        await ports.sessions.readSession(ctx, input, grant),
      );
      if (result.view !== input.view)
        throw new SessionControlError("invalid_output", "Owner returned a different read view");
      const returned = result.view === "summary" ? result.summary.session : result.session;
      // 读本机会话库时目标可在其他 workspace；仍要求返回同一会话，不能被替换成别的目标。
      if (ctx.readAnyLocalSession) {
        if (returned.kind !== "cli" || !sameSession(returned, input.session))
          throw new SessionControlError("invalid_output", "Owner returned a different session");
      } else assertOutputSession(returned, input.session, ctx);
      return result as ReadSessionResult<CliSessionRef>;
    },
    async createSession(ctx, raw) {
      const input = parseInput(cliCreateSessionInputSchema, raw);
      // 规格 0.14：cwd 已从工具面删除——唯一合法值就是调用者绑定的 workspace，实现侧还会按
      // realpath 复验。这里直接取绑定 workspace，并保留「必须唯一」的 fail-closed 判定。
      const bound = defaultCliScope(ctx.rootSession);
      const scopes = ctx.allowedScopes.filter(
        (scope) => scope.workspacePath === bound.workspacePath,
      );
      const [scope] = scopes;
      if (scopes.length !== 1 || !scope)
        throw new SessionControlError(
          "forbidden",
          "Creation workspace must resolve to one authorized identity",
        );
      const grant = await authorize(ports.access, ctx, "createSession", scope);
      const result = parseOutput(
        createSessionResultSchema,
        await ports.execution.createSession(ctx, input, grant),
      );
      if (result.session) assertOutputScope(result.session, grant.scope, ctx);
      if (result.operation && result.session)
        assertOutputSession(result.operation.session, result.session, ctx);
      return result as CreateSessionResult<CliSessionRef>;
    },
    async forkSession(ctx, raw) {
      const input = await target(ctx, parseInput(cliForkSessionInputSchema, raw));
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
      return result as ForkSessionResult<CliSessionRef>;
    },
    async sendToSession(ctx, raw) {
      const input = await target(ctx, parseInput(cliSendToSessionInputSchema, raw));
      const grant = await accessSession(ctx, "sendToSession", input.session);
      const result = parseOutput(
        sendToSessionResultSchema,
        await ports.execution.sendToSession(ctx, input, grant),
      );
      assertOutputSession(result.session, input.session, ctx);
      assertOutputSession(result.operation.session, input.session, ctx);
      return result as SendToSessionResult<CliSessionRef>;
    },
    async waitSessions(ctx, raw) {
      const parsed = parseInput(cliWaitSessionsInputSchema, raw);
      // 解析后补回 sessionId：OperationRef 同时携带完整引用（路由用）与裸 id（回执给模型用）。
      const operations = await Promise.all(
        parsed.operations.map(async (operation) => {
          const resolved = await target(ctx, operation);
          return { ...resolved, sessionId: resolved.session.sessionId };
        }),
      );
      return waitForOperations(ctx, { ...parsed, operations }, ports);
    },
    async interruptSession(ctx, raw) {
      const input = await target(ctx, parseInput(cliInterruptSessionInputSchema, raw));
      const grant = await accessSession(ctx, "interruptSession", input.session);
      return parseOutput(
        mutationResultSchema,
        await ports.execution.interruptSession(ctx, input, grant),
      );
    },
    async renameSession(ctx, raw) {
      const input = await target(ctx, parseInput(cliRenameSessionInputSchema, raw));
      const grant = await accessSession(ctx, "renameSession", input.session);
      return parseOutput(
        mutationResultSchema,
        await ports.execution.renameSession(ctx, input, grant),
      );
    },
  };
}
