import { createHash } from "node:crypto";
import { completeNewModelSelection, validateModelSelectionOptions } from "@zcode/provider";
import {
  SessionControlError,
  type AccessGrant,
  type AppScope,
  type AppSessionExecutionPort,
  type AppSessionRef,
  type AppTrustedContext,
  type MutationResult,
} from "@zcode/session-control/contracts";
import {
  type CommandAck,
  type CommandEnvelope,
  type CommandPayloadMap,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import type { ProjectDirectories, ProjectTask } from "#src/project/contract.js";
import type { AppControlServiceDependencies } from "#src/app-control/contract.js";
import { getAppControlBinding } from "#src/app-control/context.js";
import { observeAppConversation } from "#src/app-control/observation.js";
import { withTrustedZCodeAgentV4Connection } from "#src/zcode-agent/zcodeAgentConnectionScope.js";

export function appControlCommandId(context: AppTrustedContext, requestId: string): string {
  return `app-control-${createHash("sha256")
    .update(JSON.stringify([context.callerId, requestId]))
    .digest("hex")}`;
}
function delivery(value: "startNow" | "queue" | "guide" | undefined) {
  return value === "startNow"
    ? ("start_now" as const)
    : value === "queue"
      ? ("queued" as const)
      : ("unknown" as const);
}
function mutation(ack: CommandAck, requestId: string): MutationResult {
  return {
    requestId,
    status:
      ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop"
        ? "applied"
        : "rejected",
    ...(ack.reasonCode ? { reason: ack.reasonCode } : {}),
  };
}

export async function resolveAppCreationDirectories(
  sourceServerId: string,
  directories: ProjectDirectories,
  resolveIdentity?: (workspacePath: string) => Promise<string>,
): Promise<ProjectDirectories> {
  if (sourceServerId === "local") return directories;
  if (!resolveIdentity)
    throw new SessionControlError(
      "unavailable",
      "Remote creation identity resolver is unavailable",
    );
  const workspaceIdentity = await resolveIdentity(directories.workspacePath);
  if (!workspaceIdentity.trim())
    throw new SessionControlError("unavailable", "Remote creation identity is unavailable");
  if (directories.workspaceIdentity && directories.workspaceIdentity !== workspaceIdentity)
    throw new SessionControlError("conflict", "Remote creation identity changed");
  return { ...directories, workspaceIdentity };
}

export async function resolveAppForkBoundary(
  agent: AppControlServiceDependencies["agent"],
  session: AppSessionRef,
  atMessage: string,
  initial: ConversationSnapshot,
  signal?: AbortSignal,
): Promise<{
  target: { rowId: number; entityId: string };
  baseRevision: number;
  baseLogEpoch: string;
}> {
  let rows = initial.rows.window;
  let revision = initial.revision;
  let more =
    initial.rows.firstRowId !== null &&
    (rows.length === 0 || rows[0]!.rowId > initial.rows.firstRowId);
  let before = rows[0]?.rowId;
  while (true) {
    if (signal?.aborted) throw new SessionControlError("cancelled", "Fork lookup cancelled");
    // ReadSession 返回 transcript messageId；新投影 entityId/assistantResponseId 均由该事实派生。
    // 同一 response 可能有多段正文，只选择 owner 标为 canFork 的稳定轮尾段。
    const row = rows.findLast(
      (item) =>
        item.kind === "assistantText" &&
        (item.assistantResponseId === atMessage || item.entityId === atMessage) &&
        item.actions?.canFork,
    );
    if (row) {
      if (!row.actions?.canFork || !row.entityId)
        throw new SessionControlError("unavailable", "Message is not a stable fork boundary");
      return {
        target: { rowId: row.rowId, entityId: row.entityId },
        baseRevision: revision,
        baseLogEpoch: initial.logEpoch,
      };
    }
    if (!more) throw new SessionControlError("unavailable", "Stable fork message was not found");
    const page = await agent.conversationRowsRangeV4({
      workspacePath: session.workspacePath,
      workspaceIdentity: session.workspaceIdentity,
      sessionId: session.sessionId,
      beforeRowId: before,
      limit: 200,
    });
    if (page.atLogEpoch !== initial.logEpoch)
      throw new SessionControlError("conflict", "Fork history changed owner epoch");
    const next = page.rows[0]?.rowId;
    if (page.rows.length === 0 || (before !== undefined && (next === undefined || next >= before)))
      throw new SessionControlError("unavailable", "Fork history cursor did not advance");
    rows = page.rows;
    revision = page.atRevision;
    more = page.hasMore;
    before = next;
  }
}

/**
 * 把 `modelId` 或 `providerId/modelId` 解析成完整选择（createSession 与客户端的 sendToSession 共用，§18.1 H10）。
 * 没给 model 时用偏好选择。必须唯一匹配、provider 不能隐藏、选项合法，否则不发命令。
 */
async function resolveModelSelection(
  models: AppControlServiceDependencies["models"],
  model: string | undefined,
) {
  const view = await models.getView();
  let selection = view.preferredSelection;
  if (model) {
    const matches = view.providers.flatMap((provider) =>
      provider.models
        .filter(
          (candidate) =>
            candidate.modelId === model || `${provider.providerId}/${candidate.modelId}` === model,
        )
        .map((candidate) => ({ providerId: provider.providerId, modelId: candidate.modelId })),
    );
    if (matches.length !== 1)
      throw new SessionControlError("invalid_input", "Model selection is missing or ambiguous");
    selection = completeNewModelSelection(view, matches[0]!);
  }
  const provider = view.providers.find((item) => item.providerId === selection?.providerId);
  const resolved = provider?.models.find((item) => item.modelId === selection?.modelId);
  if (
    !selection ||
    !resolved ||
    provider?.config.visibility === "hidden" ||
    !validateModelSelectionOptions(resolved, selection).ok
  )
    throw new SessionControlError(
      "unavailable",
      "A complete executable model selection is required",
    );
  return { ...selection, options: { ...selection.options } };
}

export function createAppExecutionPorts(
  deps: AppControlServiceDependencies,
  requireTarget: (
    context: AppTrustedContext,
    session: AppSessionRef,
    grant?: AccessGrant<AppScope>,
  ) => Promise<ProjectTask>,
  ref: (task: ProjectTask) => AppSessionRef,
): AppSessionExecutionPort {
  async function command(
    context: AppTrustedContext,
    target: { workspacePath: string; workspaceIdentity?: string },
    envelope: CommandEnvelope,
    projectId?: string | null,
  ) {
    const binding = getAppControlBinding(context);
    return deps.agent.sendConversationCommandV4(
      withTrustedZCodeAgentV4Connection(
        { ...target, ...(projectId !== undefined ? { projectId } : {}), envelope },
        { connectionId: binding.connectionId, clientMode: "desktop-continuous" },
      ),
    );
  }
  function envelope(
    context: AppTrustedContext,
    requestId: string,
    sessionId: string | null,
    type: CommandEnvelope["type"],
    payload: unknown,
  ): CommandEnvelope {
    return {
      commandId: appControlCommandId(context, requestId),
      clientId: context.callerId,
      sessionId,
      type,
      payload,
      issuedAt: Date.now(),
    };
  }
  async function readFacts(
    context: AppTrustedContext,
    session: AppSessionRef,
  ): Promise<ConversationSnapshot> {
    const binding = getAppControlBinding(context);
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) controller.abort();
    try {
      const feed = await observeAppConversation(
        deps.agent,
        { session, sessionId: session.sessionId, commandId: "inspect" },
        controller.signal,
        binding.connectionId,
      );
      try {
        return feed.initial;
      } finally {
        await feed.close();
      }
    } finally {
      controller.abort();
      context.signal?.removeEventListener("abort", abort);
    }
  }
  /**
   * 客户端类调用方（§17.2、§17.8）的输入来源：由可信组件写在绑定上，目标 CLI 必须认识它。
   * 旧 CLI 对 createSession.firstInput.source 会静默剥掉，所以没有能力位时报 unavailable，不退化成不标来源。
   */
  async function clientInputSource(
    context: AppTrustedContext,
    target: { workspacePath: string; workspaceIdentity?: string },
  ) {
    const binding = getAppControlBinding(context);
    const source = "inputSource" in binding ? binding.inputSource : undefined;
    if (!source) throw new SessionControlError("unavailable", "Client input source is missing");
    if (source.kind === "extension") {
      const supported = await deps.agent.supportsExtensionInputSource?.({
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
      if (!supported)
        throw new SessionControlError(
          "unavailable",
          "The session runtime does not support extension input sources",
        );
    }
    getAppControlBinding(context);
    return source;
  }
  /** 派发前的最后复验：会话类复验根会话（既有规则）；客户端类没有根会话，复验授权 fence 与连接代际。 */
  async function assertDispatchable(context: AppTrustedContext, grant: AccessGrant<AppScope>) {
    if (context.caller === "client") {
      const binding = getAppControlBinding(context);
      if (grant.fence !== binding.connectionId)
        throw new SessionControlError("forbidden", "Session grant expired");
      return;
    }
    await requireTarget(context, context.rootSession, grant);
  }
  return {
    async createSession(context, input, grant) {
      getAppControlBinding(context);
      if (grant.fence !== getAppControlBinding(context).connectionId)
        throw new SessionControlError("forbidden", "Creation grant expired");
      if (!deps.prepareCreation)
        throw new SessionControlError("unavailable", "Stable product creation is unavailable");
      const creationCommand = {
        clientId: context.callerId,
        commandId: appControlCommandId(context, input.requestId),
      };
      const receipts = async () => (await deps.findCreationReceipts?.(creationCommand)) ?? [];
      const [receipt, ...otherReceipts] = await receipts();
      if (otherReceipts.length)
        throw new SessionControlError(
          "conflict",
          "Creation request has receipts in several workspaces",
        );
      // Bug 根因：重试原先总按项目当前主目录解析目标；主目录变了就按新目录预留、发往新目录的 owner，
      // 返回的引用也带着新目录。回执是重试的唯一事实源：命中时目标取首次预留的任务目录（cwd 不变）。
      const directories =
        receipt?.directories ??
        (await resolveAppCreationDirectories(
          deps.sourceServerId,
          await deps.prepareCreation({ projectId: input.project.projectId }),
          deps.resolveWorkspaceIdentity,
        ));
      if (directories.projectId !== input.project.projectId)
        throw new SessionControlError(
          "conflict",
          "Creation request now belongs to a different project",
        );
      if (deps.sourceServerId !== "local" && !directories.workspaceIdentity)
        throw new SessionControlError(
          "unavailable",
          "Remote creation requires a trusted workspace identity",
        );
      // 新根会话使用普通 build 权限，不从 actor 的 yolo/bypass 复制。完整 Submission 在首发前固定。
      // 客户端类（扩展）可以指定新会话的权限模式（docs/plugins/extension-host.md §17.12）：完全访问的授权由网关在
      // 进入 facade 前检查；会话类的工具面没有这个字段，端口上收到即拒绝。
      if (input.mode && context.caller !== "client")
        throw new SessionControlError("invalid_input", "Only client callers can choose a mode");
      const submission = {
        modelSelection: await resolveModelSelection(deps.models, input.model),
        mode: input.mode ?? ("build" as const),
        planEnabled: false,
      };
      // 客户端类（扩展）的首条输入带它的来源（§17.8）；会话类沿用原行为。
      const source =
        context.caller === "client" ? await clientInputSource(context, directories) : undefined;
      const request = envelope(context, input.requestId, null, "createSession", {
        workspaceId: directories.workspaceIdentity?.trim() || directories.workspacePath,
        config: submission,
        firstInput: { text: input.prompt, ...submission, ...(source ? { source } : {}) },
      } satisfies CommandPayloadMap["createSession"]);
      const sessionRef = (sessionId: string): AppSessionRef => ({
        kind: "app",
        sourceServerId: deps.sourceServerId,
        workspacePath: directories.workspacePath,
        ...(directories.workspaceIdentity
          ? { workspaceIdentity: directories.workspaceIdentity }
          : {}),
        sessionId,
        project: input.project,
      });
      // 合并 staging 后会话 ID 改由 Host 预留按 (workspace, clientId, commandId) 分配并持久回执；
      // 原先在此派生 session_app_ 哈希，会与该唯一分配点重复。ACK 丢失时只读回执，不再预测 ID。
      const createdSession = async () => {
        const [created, ...others] = await receipts();
        return created && !others.length ? sessionRef(created.sessionId) : undefined;
      };
      // 所有准备 IO 完成后重新读取同一 owner 快照；本次授权在 Host dispatch 固定，后续移动不撤回已派发命令。
      await assertDispatchable(context, grant);
      let ack: CommandAck;
      try {
        ack = await command(context, directories, request, input.project.projectId);
      } catch (error) {
        if (error instanceof SessionControlError) throw error;
        const session = await createdSession().catch(() => undefined);
        return {
          requestId: input.requestId,
          creation: "unknown",
          firstInput: "unknown",
          delivery: "unknown",
          ...(session
            ? {
                session,
                operation: { session, sessionId: session.sessionId, commandId: request.commandId },
              }
            : {}),
          reason: "Creation result unavailable",
        };
      }
      const result = ack.result?.type === "createSession" ? ack.result : undefined;
      if (!result) {
        const rejected = ack.status === "rejected" || ack.status === "stale";
        const session = rejected ? undefined : await createdSession().catch(() => undefined);
        return {
          requestId: input.requestId,
          creation: rejected ? "rejected" : "unknown",
          firstInput: rejected ? "rejected" : "unknown",
          delivery: rejected ? "none" : "unknown",
          ...(session ? { session } : {}),
          reason: ack.reasonCode,
        };
      }
      const session = sessionRef(result.sessionId);
      return {
        requestId: input.requestId,
        creation: "created",
        firstInput: result.input ? "accepted" : "unknown",
        delivery: delivery(result.input?.delivery),
        session,
        operation: { session, sessionId: session.sessionId, commandId: request.commandId },
        ...(ack.reasonCode ? { reason: ack.reasonCode } : {}),
      };
    },
    async sendToSession(context, input, grant) {
      // 曾只传正文，导致跨会话消息丢失来源；由可信 caller 固定来源，再沿 canonical input 持久化。
      // 只带 sessionId（规格 0.13）：标题曾一并快照，但跨会话发送多半发生在发起方第一轮进行中，
      // 此时 titleSource 还是 default，快照到的是首条提示词原文，生成标题落定后也不回写。
      // requireTarget 仍然要跑——它是来源会话的可信校验，不只是为了取标题。
      // 客户端类调用方（扩展）没有来源会话：来源取绑定上的 inputSource（§17.8），可带 model（§18.1 H10）。
      // model 只对客户端开放；会话类的工具面没有这个字段，端口上收到即拒绝。
      if (input.model && context.caller !== "client")
        throw new SessionControlError("invalid_input", "Only client callers can choose a model");
      const caller =
        context.caller === "client"
          ? undefined
          : await requireTarget(context, context.rootSession, grant);
      const task = await requireTarget(context, input.session, grant);
      const source = caller
        ? { kind: "session" as const, sessionId: caller.taskId }
        : await clientInputSource(context, task);
      const modelSelection = input.model
        ? await resolveModelSelection(deps.models, input.model)
        : undefined;
      const request = envelope(context, input.requestId, task.taskId, "sendText", {
        text: input.prompt,
        requestedDelivery: "queue",
        source,
        ...(modelSelection ? { modelSelection } : {}),
      } satisfies CommandPayloadMap["sendText"]);
      // 不覆盖目标的 mode/plan；不带 model 时也不覆盖 model，CLI admission 在唯一 owner 内固定现有配置与 FIFO。
      const session = ref(task);
      try {
        const ack = await command(context, task, request);
        const accepted = ack.result?.type === "inputAccepted" ? ack.result : undefined;
        const rejected =
          ack.status === "failed" || ack.status === "rejected" || ack.status === "stale";
        return {
          requestId: input.requestId,
          session,
          operation: { session, sessionId: session.sessionId, commandId: request.commandId },
          admission: accepted ? "accepted" : rejected ? "rejected" : "unknown",
          delivery: accepted ? delivery(accepted.delivery) : rejected ? "none" : "unknown",
          ...(ack.reasonCode ? { reason: ack.reasonCode } : {}),
        };
      } catch (error) {
        if (error instanceof SessionControlError) throw error;
        return {
          requestId: input.requestId,
          session,
          operation: { session, sessionId: session.sessionId, commandId: request.commandId },
          admission: "unknown",
          delivery: "unknown",
          reason: "Admission result unavailable",
        };
      }
    },
    async interruptSession(context, input, grant) {
      const task = await requireTarget(context, input.session, grant);
      const ack = await command(
        context,
        task,
        envelope(context, input.requestId, task.taskId, "stop", {
          expectedForegroundExecutionId: input.expectedExecutionId,
        } satisfies CommandPayloadMap["stop"]),
      );
      // 目标执行已变化时 owner 未执行停止；noop 及其 duplicate 回放都不能报告已应用。
      return ack.reasonCode === "guard.stopTargetChanged"
        ? { requestId: input.requestId, status: "rejected", reason: ack.reasonCode }
        : mutation(ack, input.requestId);
    },
    async renameSession(context, input, grant) {
      const task = await requireTarget(context, input.session, grant);
      // 标题唯一写者仍是 CLI；Task owner 负责既有意图交接与索引镜像。
      if (deps.controller)
        await deps.controller.mutateTask({
          address: {
            sourceServerId: deps.sourceServerId,
            workspacePath: task.workspacePath,
            workspaceIdentity: task.workspaceIdentity,
            taskId: task.taskId,
          },
          mutation: { kind: "rename", title: input.title },
        });
      else
        await deps.tasks.renameTask({
          workspacePath: task.workspacePath,
          workspaceIdentity: task.workspaceIdentity,
          taskId: task.taskId,
          title: input.title,
        });
      return { requestId: input.requestId, status: "applied" };
    },
    async forkSession(context, input, grant) {
      const task = await requireTarget(context, input.session, grant);
      if (!deps.reserveFork)
        throw new SessionControlError("unavailable", "Fork product ownership is unavailable");
      const facts = await readFacts(context, ref(task));
      const boundary = await resolveAppForkBoundary(
        deps.agent,
        ref(task),
        input.atMessage,
        facts,
        context.signal,
      );
      const request = {
        ...envelope(context, input.requestId, task.taskId, "forkAssistant", {
          target: boundary.target,
        } satisfies CommandPayloadMap["forkAssistant"]),
        baseRevision: boundary.baseRevision,
        baseLogEpoch: boundary.baseLogEpoch,
      };
      await requireTarget(context, input.session, grant);
      const ack = await command(context, task, request);
      if (ack.result?.type !== "forkAssistant")
        return {
          requestId: input.requestId,
          status:
            ack.status === "rejected" || ack.status === "failed" || ack.status === "stale"
              ? "rejected"
              : "unknown",
          reason: ack.reasonCode,
        };
      const session = { ...ref(task), sessionId: ack.result.sessionId };
      try {
        if (!deps.reserveFork)
          throw new SessionControlError("unavailable", "Fork product ownership is unavailable");
        await deps.reserveFork({
          workspacePath: task.workspacePath,
          workspaceIdentity: task.workspaceIdentity,
          taskId: session.sessionId,
          projectId: task.projectId,
          forkedFromTaskId: task.taskId,
        });
        return { requestId: input.requestId, status: "created", session };
      } catch (error) {
        return {
          requestId: input.requestId,
          status: "unknown",
          session,
          reason: error instanceof Error ? error.message : "Fork ownership result unavailable",
        };
      }
    },
  };
}
