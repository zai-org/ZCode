import {
  SessionControlError,
  type AppProjectRef,
  type AppScope,
  type CliScope,
  type Scope,
  type SessionRef,
  type TrustedContext,
} from "#session-control/contract/common";
import { type OperationRef } from "#session-control/contract/observation";

export function sessionScope(session: SessionRef): Scope {
  if (session.kind === "cli")
    return {
      kind: "cli",
      workspacePath: session.workspacePath,
      workspaceIdentity: session.workspaceIdentity,
    };
  return {
    kind: "app",
    scope: "workspace",
    workspacePath: session.workspacePath,
    workspaceIdentity: session.workspaceIdentity,
    sourceServerId: session.sourceServerId,
  };
}
export function projectScope(project: AppProjectRef): AppScope {
  return { ...project, scope: "project" };
}
export function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "cli" && b.kind === "cli") return sameWorkspace(a, b);
  if (
    a.kind !== "app" ||
    b.kind !== "app" ||
    a.sourceServerId !== b.sourceServerId ||
    a.scope !== b.scope
  )
    return false;
  if (a.scope === "host" && b.scope === "host") return true;
  if (a.scope === "project" && b.scope === "project") return a.projectId === b.projectId;
  return a.scope === "workspace" && b.scope === "workspace" && sameWorkspace(a, b);
}
function sameWorkspace(
  a: { workspacePath: string; workspaceIdentity?: string },
  b: { workspacePath: string; workspaceIdentity?: string },
): boolean {
  // identity 与路径是同一 workspaceKey 的两种表达，不能让显式 identity 绕过 self-wait。
  // 路径和 identity 是否真实对应，由生产 access 与 owner 的原子准入验证。
  return (
    (a.workspaceIdentity?.trim() || a.workspacePath) ===
    (b.workspaceIdentity?.trim() || b.workspacePath)
  );
}
export function sameSession(a: SessionRef, b: SessionRef): boolean {
  return a.sessionId === b.sessionId && sameScope(sessionScope(a), sessionScope(b));
}
export function sameOperation(a: OperationRef, b: OperationRef): boolean {
  return a.commandId === b.commandId && sameSession(a.session, b.session);
}
export function scopeAllows(allowed: Scope, target: Scope, session?: SessionRef): boolean {
  if (sameScope(allowed, target)) return true;
  if (
    allowed.kind !== "app" ||
    target.kind !== "app" ||
    allowed.sourceServerId !== target.sourceServerId
  )
    return false;
  if (allowed.scope === "host") return true;
  return (
    allowed.scope === "project" &&
    target.scope === "workspace" &&
    session?.kind === "app" &&
    !!session.project &&
    sameScope(allowed, projectScope(session.project))
  );
}
export function assertScope(ctx: TrustedContext, scope: Scope, session?: SessionRef): void {
  if (!ctx.allowedScopes.some((allowed) => scopeAllows(allowed, scope, session)))
    throw new SessionControlError("forbidden", "Target is outside the trusted scope");
  if (
    session?.kind === "app" &&
    session.project &&
    session.project.sourceServerId !== session.sourceServerId
  )
    throw new SessionControlError("forbidden", "Session and project source differ");
}
export function assertOutputAuthorized(session: SessionRef, ctx: TrustedContext): void {
  // workspace grant 只记录目标路由，不能替代调用者原有的项目授权，也不能证明引用内部一致。
  try {
    assertScope(ctx, sessionScope(session), session);
  } catch {
    throw new SessionControlError(
      "invalid_output",
      "Owner returned an unauthorized or inconsistent session",
    );
  }
}
export function assertOutputScope(session: SessionRef, scope: Scope, ctx: TrustedContext): void {
  assertOutputAuthorized(session, ctx);
  if (!scopeAllows(scope, sessionScope(session), session))
    throw new SessionControlError(
      "invalid_output",
      "Owner returned a session outside the authorized scope",
    );
}
export function assertOutputSession(
  actual: SessionRef,
  expected: SessionRef,
  ctx: TrustedContext,
): void {
  assertOutputAuthorized(actual, ctx);
  if (!sameSession(actual, expected))
    throw new SessionControlError("invalid_output", "Owner returned a different session");
}
export function defaultCliScope(root: SessionRef): CliScope {
  if (root.kind !== "cli")
    throw new SessionControlError("forbidden", "CLI requires a CLI root session");
  return {
    kind: "cli",
    workspacePath: root.workspacePath,
    workspaceIdentity: root.workspaceIdentity,
  };
}
