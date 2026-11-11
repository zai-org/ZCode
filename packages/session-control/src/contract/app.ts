import { z } from "zod";
import {
  atMessageSchema,
  executionIdSchema,
  withRequestIdentity,
  appProjectRefSchema,
  appScopeSchema,
  appSessionRefSchema,
  appWorkspaceRefSchema,
  identifierSchema,
  modelSchema,
  paginationShape,
  promptSchema,
  queryShape,
  requestIdSchema,
  titleSchema,
  withSessionTarget,
  type AccessGrant,
  type AccessPort,
  type AppScope,
  type AppSessionRef,
  type AppTrustedContext,
  type DeadlinePort,
  type MutationResult,
  type OpenSessionResult,
  type ResolvedTarget,
} from "#session-control/contract/common";
import {
  type AppWaitSessionsInput,
  type OperationObservationPort,
  type WaitSessionsResult,
} from "#session-control/contract/observation";
import {
  type CreateSessionResult,
  type ForkSessionResult,
  listSessionsResultSchema,
  sessionSummarySchema,
  type ReadSessionResult,
  type SendToSessionResult,
} from "#session-control/contract/results";

// 规格 0.14：删除 host——它是已连接 Source Server 的 id，没有任何工具返回候选集；
// 不传即搜索全部已连接来源，本来就是正确行为。将来若需定向，应让回执按来源分组。
export const appListProjectsInputSchema = z.strictObject({
  query: z.string().max(4096).optional(),
});
// 规格 0.14：删除 workspace 过滤器——模型要先 ListSessions 才能拿到 workspace 引用，
// 而它正是用来过滤 ListSessions 的，发现链循环。project 有 ListProjects 这条现成的发现链。
export const appListSessionsInputSchema = z.strictObject({
  project: appProjectRefSchema
    .optional()
    .describe("A project from ListProjects, replayed exactly as that result returned it."),
  archived: z.enum(["exclude", "include", "only"]).default("exclude"),
  ...queryShape,
});
// 省略过滤条件时搜索发现范围。
export type AppResolvedListSessionsInput = z.output<typeof appListSessionsInputSchema>;
export const appReadSessionInputSchema = withSessionTarget(appSessionRefSchema, {
  view: z.enum(["summary", "messages"]),
  ...paginationShape,
});
/** 客户端类调用方新建会话时可选的权限模式（宿主权限菜单的三档，§17.12）。 */
export const appClientSessionModeSchema = z.enum(["build", "guarded", "yolo"]);
export type AppClientSessionMode = z.infer<typeof appClientSessionModeSchema>;
export const appCreateSessionInputSchema = withRequestIdentity(
  {
    project: appProjectRefSchema.describe(
      "A project from ListProjects, replayed exactly as that result returned it.",
    ),
    prompt: promptSchema,
    model: modelSchema.optional(),
    requestId: requestIdSchema,
  },
  // mode 只给客户端（扩展，docs/plugins/extension-host.md §17.12）：只进端口，不进工具面；会话类带它由 App owner 拒绝。
  { mode: appClientSessionModeSchema.optional() },
);
export const appForkSessionInputSchema = withSessionTarget(appSessionRefSchema, {
  atMessage: atMessageSchema,
  requestId: requestIdSchema,
});
// model 只给客户端类调用方（扩展，§18.1 H10）：只进端口，不进工具面；会话类带它由 App owner 拒绝。
export const appSendToSessionInputSchema = withSessionTarget(
  appSessionRefSchema,
  { prompt: promptSchema, requestId: requestIdSchema },
  { model: modelSchema.optional() },
);
export const appInterruptSessionInputSchema = withSessionTarget(appSessionRefSchema, {
  expectedExecutionId: executionIdSchema,
  requestId: requestIdSchema,
});
export const appRenameSessionInputSchema = withSessionTarget(appSessionRefSchema, {
  title: titleSchema,
  requestId: requestIdSchema,
});
// 规格 0.14：删除 uiTarget——它是 Electron 窗口 id（window:<id>），模型无从得知合法值；
// 不传即打开在发起方绑定的窗口，本来就是正确行为。按绑定窗口路由属于可信上下文的职责。
export const appOpenSessionInputSchema = withSessionTarget(appSessionRefSchema, {});
export const appSetSessionArchivedInputSchema = withSessionTarget(appSessionRefSchema, {
  archived: z.boolean(),
  requestId: requestIdSchema,
});
export const appSetSessionPinnedInputSchema = withSessionTarget(appSessionRefSchema, {
  pinned: z.boolean(),
  requestId: requestIdSchema,
});
export const appSearchScopeSchema = z.strictObject({
  scopes: z.array(appScopeSchema),
  unavailableSources: z.array(
    z.strictObject({ sourceServerId: identifierSchema, reason: z.string() }),
  ),
});
export type AppSearchScope = z.infer<typeof appSearchScopeSchema>;
export const listProjectsResultSchema = z.strictObject({
  projects: z.array(z.strictObject({ project: appProjectRefSchema, title: z.string() })),
  searchScope: appSearchScopeSchema,
});
// App 列表必须解释真实搜索范围；CLI 继续使用原有列表 schema。
export const appListSessionsResultSchema = listSessionsResultSchema.extend({
  sessions: z.array(sessionSummarySchema.extend({ session: appSessionRefSchema })),
  searchScope: appSearchScopeSchema,
});
export type AppListSessionsResult = z.infer<typeof appListSessionsResultSchema>;
export type AppListProjectsInput = z.infer<typeof appListProjectsInputSchema>;
export type AppListSessionsInput = z.input<typeof appListSessionsInputSchema>;
export type AppCreateSessionInput = z.infer<typeof appCreateSessionInputSchema>;
// 端口收到的输入已由用例解析为完整引用；工具层输入另见 *InputSchema。
type Resolved<S extends z.ZodType> = ResolvedTarget<z.infer<S>, AppSessionRef>;
export type AppReadSessionInput = Resolved<typeof appReadSessionInputSchema>;
export type AppForkSessionInput = Resolved<typeof appForkSessionInputSchema>;
export type AppSendToSessionInput = Resolved<typeof appSendToSessionInputSchema>;
export type AppInterruptSessionInput = Resolved<typeof appInterruptSessionInputSchema>;
export type AppRenameSessionInput = Resolved<typeof appRenameSessionInputSchema>;
export type AppOpenSessionInput = Resolved<typeof appOpenSessionInputSchema>;
export type AppSetSessionArchivedInput = Resolved<typeof appSetSessionArchivedInputSchema>;
export type AppSetSessionPinnedInput = Resolved<typeof appSetSessionPinnedInputSchema>;
export type ListProjectsResult = z.infer<typeof listProjectsResultSchema>;

export interface AppSessionQueryPort {
  /** 只在调用者绑定的 Host 中按会话 ID 解析产品会话；不跨来源搜索，找不到返回 undefined。 */
  resolveSession(ctx: AppTrustedContext, sessionId: string): Promise<AppSessionRef | undefined>;
  listSessions(
    ctx: AppTrustedContext,
    input: AppResolvedListSessionsInput,
    grants: readonly AccessGrant<AppScope>[],
  ): Promise<AppListSessionsResult>;
  readSession(
    ctx: AppTrustedContext,
    input: AppReadSessionInput,
    grant: AccessGrant<AppScope>,
  ): Promise<ReadSessionResult<AppSessionRef>>;
}
export interface AppSessionExecutionPort {
  createSession(
    ctx: AppTrustedContext,
    input: AppCreateSessionInput,
    grant: AccessGrant<AppScope>,
  ): Promise<CreateSessionResult<AppSessionRef>>;
  forkSession(
    ctx: AppTrustedContext,
    input: AppForkSessionInput,
    grant: AccessGrant<AppScope>,
  ): Promise<ForkSessionResult<AppSessionRef>>;
  sendToSession(
    ctx: AppTrustedContext,
    input: AppSendToSessionInput,
    grant: AccessGrant<AppScope>,
  ): Promise<SendToSessionResult<AppSessionRef>>;
  interruptSession(
    ctx: AppTrustedContext,
    input: AppInterruptSessionInput,
    grant: AccessGrant<AppScope>,
  ): Promise<MutationResult>;
  renameSession(
    ctx: AppTrustedContext,
    input: AppRenameSessionInput,
    grant: AccessGrant<AppScope>,
  ): Promise<MutationResult>;
}
export interface AppProjectPort {
  listProjects(
    ctx: AppTrustedContext,
    input: AppListProjectsInput,
    grants: readonly AccessGrant<AppScope>[],
  ): Promise<ListProjectsResult>;
}
export interface AppOrganizationPort {
  setSessionArchived(
    ctx: AppTrustedContext,
    input: AppSetSessionArchivedInput,
    grant: AccessGrant<AppScope>,
  ): Promise<MutationResult>;
  setSessionPinned(
    ctx: AppTrustedContext,
    input: AppSetSessionPinnedInput,
    grant: AccessGrant<AppScope>,
  ): Promise<MutationResult>;
}
export interface UiNavigationPort {
  openSession(
    ctx: AppTrustedContext,
    input: AppOpenSessionInput,
    grant: AccessGrant<AppScope>,
  ): Promise<OpenSessionResult>;
}
export interface AppSessionControlDependencies {
  access: AccessPort<AppSessionRef, AppScope>;
  sessions: AppSessionQueryPort;
  execution: AppSessionExecutionPort;
  observations: OperationObservationPort<AppSessionRef, AppScope>;
  projects: AppProjectPort;
  organization: AppOrganizationPort;
  navigation?: UiNavigationPort;
  deadlines: DeadlinePort;
}
/** 用例入口接受工具层输入：目标会话可为完整引用或只传 sessionId。 */
export interface AppSessionControl {
  listProjects(ctx: AppTrustedContext, input: AppListProjectsInput): Promise<ListProjectsResult>;
  listSessions(ctx: AppTrustedContext, input: AppListSessionsInput): Promise<AppListSessionsResult>;
  readSession(
    ctx: AppTrustedContext,
    input: z.input<typeof appReadSessionInputSchema>,
  ): Promise<ReadSessionResult<AppSessionRef>>;
  createSession(
    ctx: AppTrustedContext,
    input: AppCreateSessionInput,
  ): Promise<CreateSessionResult<AppSessionRef>>;
  forkSession(
    ctx: AppTrustedContext,
    input: z.input<typeof appForkSessionInputSchema>,
  ): Promise<ForkSessionResult<AppSessionRef>>;
  sendToSession(
    ctx: AppTrustedContext,
    input: z.input<typeof appSendToSessionInputSchema>,
  ): Promise<SendToSessionResult<AppSessionRef>>;
  waitSessions(
    ctx: AppTrustedContext,
    input: AppWaitSessionsInput,
  ): Promise<WaitSessionsResult<AppSessionRef>>;
  interruptSession(
    ctx: AppTrustedContext,
    input: z.input<typeof appInterruptSessionInputSchema>,
  ): Promise<MutationResult>;
  renameSession(
    ctx: AppTrustedContext,
    input: z.input<typeof appRenameSessionInputSchema>,
  ): Promise<MutationResult>;
  openSession(
    ctx: AppTrustedContext,
    input: z.input<typeof appOpenSessionInputSchema>,
  ): Promise<OpenSessionResult>;
  setSessionArchived(
    ctx: AppTrustedContext,
    input: z.input<typeof appSetSessionArchivedInputSchema>,
  ): Promise<MutationResult>;
  setSessionPinned(
    ctx: AppTrustedContext,
    input: z.input<typeof appSetSessionPinnedInputSchema>,
  ): Promise<MutationResult>;
}
