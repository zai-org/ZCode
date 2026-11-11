import { z } from "zod";
import {
  atMessageSchema,
  executionIdSchema,
  withRequestIdentity,
  cliScopeSchema,
  cliSessionRefSchema,
  identifierSchema,
  modelSchema,
  paginationShape,
  promptSchema,
  queryShape,
  requestIdSchema,
  titleSchema,
  withSessionTarget,
  workspacePathSchema,
  type AccessGrant,
  type AccessPort,
  type CliScope,
  type CliSessionRef,
  type CliTrustedContext,
  type DeadlinePort,
  type MutationResult,
  type ResolvedTarget,
} from "#session-control/contract/common";
import {
  type CliWaitSessionsInput,
  type OperationObservationPort,
  type WaitSessionsResult,
} from "#session-control/contract/observation";
import {
  type CreateSessionResult,
  type ForkSessionResult,
  type ListSessionsResult,
  type ReadSessionResult,
  type SendToSessionResult,
} from "#session-control/contract/results";

// 规格 0.14：删除 workspace 过滤器——模型要先 ListSessions 才能拿到 workspace 引用，
// 而它正是用来过滤 ListSessions 的，发现链循环。独立 CLI 本来也只绑定一个 workspace。
export const cliListSessionsInputSchema = z.strictObject({ ...queryShape });
export const cliReadSessionInputSchema = withSessionTarget(cliSessionRefSchema, {
  view: z.enum(["summary", "messages"]),
  ...paginationShape,
});
// 规格 0.14：删除 cwd——唯一合法值是绑定的 workspace（实现侧按 realpath 校验，不等即 forbidden），
// 工具自己已经知道它，让模型复述只会因软链接或尾斜杠而失败。
export const cliCreateSessionInputSchema = withRequestIdentity({
  prompt: promptSchema,
  model: modelSchema.optional(),
  requestId: requestIdSchema,
});
export const cliForkSessionInputSchema = withSessionTarget(cliSessionRefSchema, {
  atMessage: atMessageSchema,
  requestId: requestIdSchema,
});
export const cliSendToSessionInputSchema = withSessionTarget(cliSessionRefSchema, {
  prompt: promptSchema,
  requestId: requestIdSchema,
});
export const cliInterruptSessionInputSchema = withSessionTarget(cliSessionRefSchema, {
  expectedExecutionId: executionIdSchema,
  requestId: requestIdSchema,
});
export const cliRenameSessionInputSchema = withSessionTarget(cliSessionRefSchema, {
  title: titleSchema,
  requestId: requestIdSchema,
});
export type CliListSessionsInput = z.infer<typeof cliListSessionsInputSchema>;
export type CliCreateSessionInput = z.infer<typeof cliCreateSessionInputSchema>;
// 端口收到的输入已由用例解析为完整引用；工具层输入另见 *InputSchema。
export type CliReadSessionInput = ResolvedTarget<
  z.infer<typeof cliReadSessionInputSchema>,
  CliSessionRef
>;
export type CliForkSessionInput = ResolvedTarget<
  z.infer<typeof cliForkSessionInputSchema>,
  CliSessionRef
>;
export type CliSendToSessionInput = ResolvedTarget<
  z.infer<typeof cliSendToSessionInputSchema>,
  CliSessionRef
>;
export type CliInterruptSessionInput = ResolvedTarget<
  z.infer<typeof cliInterruptSessionInputSchema>,
  CliSessionRef
>;
export type CliRenameSessionInput = ResolvedTarget<
  z.infer<typeof cliRenameSessionInputSchema>,
  CliSessionRef
>;

export interface CliSessionQueryPort {
  /** 按会话 ID 在本机 CLI 会话库解析完整引用；找不到返回 undefined。不检查 owner。 */
  resolveSession(ctx: CliTrustedContext, sessionId: string): Promise<CliSessionRef | undefined>;
  /** workspace 缺席表示读本机会话库的全部根会话（仅 readAnyLocalSession 时出现）。 */
  listSessions(
    ctx: CliTrustedContext,
    input: CliListSessionsInput,
    grant: AccessGrant<CliScope>,
  ): Promise<ListSessionsResult<CliSessionRef>>;
  readSession(
    ctx: CliTrustedContext,
    input: CliReadSessionInput,
    grant: AccessGrant<CliScope>,
  ): Promise<ReadSessionResult<CliSessionRef>>;
}
export interface CliSessionExecutionPort {
  createSession(
    ctx: CliTrustedContext,
    input: CliCreateSessionInput,
    grant: AccessGrant<CliScope>,
  ): Promise<CreateSessionResult<CliSessionRef>>;
  forkSession(
    ctx: CliTrustedContext,
    input: CliForkSessionInput,
    grant: AccessGrant<CliScope>,
  ): Promise<ForkSessionResult<CliSessionRef>>;
  sendToSession(
    ctx: CliTrustedContext,
    input: CliSendToSessionInput,
    grant: AccessGrant<CliScope>,
  ): Promise<SendToSessionResult<CliSessionRef>>;
  interruptSession(
    ctx: CliTrustedContext,
    input: CliInterruptSessionInput,
    grant: AccessGrant<CliScope>,
  ): Promise<MutationResult>;
  renameSession(
    ctx: CliTrustedContext,
    input: CliRenameSessionInput,
    grant: AccessGrant<CliScope>,
  ): Promise<MutationResult>;
}
export interface CliSessionControlDependencies {
  access: AccessPort<CliSessionRef, CliScope>;
  sessions: CliSessionQueryPort;
  execution: CliSessionExecutionPort;
  observations: OperationObservationPort<CliSessionRef, CliScope>;
  deadlines: DeadlinePort;
}
/** 用例入口接受工具层输入：目标会话可为完整引用或只传 sessionId。 */
export interface CliSessionControl {
  listSessions(
    ctx: CliTrustedContext,
    input: CliListSessionsInput,
  ): Promise<ListSessionsResult<CliSessionRef>>;
  readSession(
    ctx: CliTrustedContext,
    input: z.input<typeof cliReadSessionInputSchema>,
  ): Promise<ReadSessionResult<CliSessionRef>>;
  createSession(
    ctx: CliTrustedContext,
    input: CliCreateSessionInput,
  ): Promise<CreateSessionResult<CliSessionRef>>;
  forkSession(
    ctx: CliTrustedContext,
    input: z.input<typeof cliForkSessionInputSchema>,
  ): Promise<ForkSessionResult<CliSessionRef>>;
  sendToSession(
    ctx: CliTrustedContext,
    input: z.input<typeof cliSendToSessionInputSchema>,
  ): Promise<SendToSessionResult<CliSessionRef>>;
  waitSessions(
    ctx: CliTrustedContext,
    input: CliWaitSessionsInput,
  ): Promise<WaitSessionsResult<CliSessionRef>>;
  interruptSession(
    ctx: CliTrustedContext,
    input: z.input<typeof cliInterruptSessionInputSchema>,
  ): Promise<MutationResult>;
  renameSession(
    ctx: CliTrustedContext,
    input: z.input<typeof cliRenameSessionInputSchema>,
  ): Promise<MutationResult>;
}
