import { createAppSessionControl } from "@zcode/session-control/app";
import {
  SessionControlError,
  type AccessGrant,
  type AppScope,
  type AppSessionRef,
  type AppTrustedContext,
  type SessionSummary,
} from "@zcode/session-control/contracts";
import type { ProjectTask } from "#src/project/contract.js";
import type {
  AppControlBinding,
  AppControlService,
  AppControlServiceDependencies,
} from "#src/app-control/contract.js";
import { createAppExecutionPorts } from "#src/app-control/execution.js";
import {
  appScopeContains,
  bindAppDiscoverySources,
  createAppDiscoveryPorts,
} from "#src/app-control/discovery.js";
import { zcodeProtocolErrorCodes } from "@zcode/shared";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "#src/zcode-agent/zcodeAgent.js";
import { observeAppOperation, readAppLiveSummary } from "#src/app-control/observation.js";
export type {
  AppControlBinding,
  AppControlCallerConnection,
  AppControlClientBinding,
  AppControlDiscoveryBatch,
  AppControlDiscoveryFailure,
  AppControlDiscoveryPort,
  AppControlDiscoverySource,
  AppControlNavigationPort,
  AppControlService,
  AppControlServiceDependencies,
  AppControlServiceHandle,
} from "#src/app-control/contract.js";

import {
  appControlBindingKey,
  getAppControlBinding,
  type BoundAppContext,
} from "#src/app-control/context.js";
export { createAppControlReverseRpc } from "#src/app-control/reverseRpc.js";
const workspaceKey = (value: { workspacePath: string; workspaceIdentity?: string }) =>
  value.workspaceIdentity?.trim() || value.workspacePath;

/**
 * 把 owner 侧已知的协议错误映射成稳定的 SessionControlError。
 * 反向 RPC 对非 SessionControlError 只回通用文案（底层异常文本可能带路径或远端地址，而响应会
 * 进模型上下文），所以可预期的失败必须在这里表达成明确原因，模型才知道该换哪种做法。
 */
async function readOwnerMessages<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (
      code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE ||
      code === zcodeProtocolErrorCodes.sessionUnavailable
    )
      throw new SessionControlError("unavailable", "Session transcript is not available to read");
    throw error;
  }
}

export function createAppControlService(deps: AppControlServiceDependencies): AppControlService {
  const ref = (task: ProjectTask): AppSessionRef => ({
    kind: "app",
    sourceServerId: task.hostId,
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    sessionId: task.taskId,
    ...(task.projectId
      ? { project: { kind: "app", projectId: task.projectId, sourceServerId: task.hostId } }
      : {}),
  });
  function taskFromSnapshot(tasks: readonly ProjectTask[], session: AppSessionRef): ProjectTask {
    if (session.sourceServerId !== deps.sourceServerId)
      throw new SessionControlError("forbidden", "Session source does not match this Host");
    const task = tasks.find(
      (item) =>
        item.taskId === session.sessionId &&
        workspaceKey(item) === workspaceKey(session) &&
        item.workspacePath === session.workspacePath,
    );
    if (!task || task.hostId !== deps.sourceServerId)
      throw new SessionControlError("forbidden", "Product session is not in the authorized source");
    if (
      session.project &&
      (session.project.projectId !== task.projectId ||
        session.project.sourceServerId !== deps.sourceServerId)
    )
      throw new SessionControlError("forbidden", "Session project does not match Host ownership");
    return task;
  }
  async function readTask(session: AppSessionRef): Promise<ProjectTask> {
    return taskFromSnapshot(
      (await deps.projects.readTree({ includeDeleted: true })).tasks,
      session,
    );
  }
  async function requireTarget(
    context: AppTrustedContext,
    session: AppSessionRef,
    grant?: AccessGrant<AppScope>,
  ): Promise<ProjectTask> {
    const binding = getAppControlBinding(context);
    // 项目只是组织信息，不能阻止同 Host 会话互读或界面导航；仍核对真实 caller/target 和连接。
    const tree = await deps.projects.readTree({ includeDeleted: true });
    const task = taskFromSnapshot(tree.tasks, session);
    // 会话类调用方的根会话仍须是本 Host 的真实任务；客户端类没有根会话（§17.2），只核对连接代际。
    if (context.caller !== "client") taskFromSnapshot(tree.tasks, context.rootSession);
    if (grant && grant.fence !== binding.connectionId)
      throw new SessionControlError("forbidden", "Session grant expired");
    binding.assertCurrent();
    return task;
  }
  const summary = (task: ProjectTask): SessionSummary<AppSessionRef> => ({
    session: ref(task),
    title: task.title,
    status:
      task.status === "running" ? "running" : task.status === "completed" ? "idle" : "unknown",
    archived: task.archived,
    pinned: task.pinned,
    availableActions: [
      "readSession",
      "sendToSession",
      "waitSessions",
      "renameSession",
      ...(deps.reserveFork ? ["forkSession" as const] : []),
      "setSessionArchived",
      "setSessionPinned",
      ...(deps.navigation ? ["openSession" as const] : []),
    ],
    ...(task.updatedAt ? { updatedAt: new Date(task.updatedAt).toISOString() } : {}),
  });
  const discovery = createAppDiscoveryPorts(summary);
  const control = createAppSessionControl({
    access: {
      async authorize(context, request) {
        const binding = getAppControlBinding(context);
        if (request.action === "listSessions" || request.action === "listProjects") {
          if (
            !binding.discovery?.sources.some((source) =>
              source.scopes.some((scope) => appScopeContains(scope, request.scope)),
            )
          )
            throw new SessionControlError(
              "forbidden",
              "Source is outside the trusted discovery scope",
            );
          return { scope: request.scope, fence: binding.connectionId };
        }
        if (
          request.scope.sourceServerId !== deps.sourceServerId ||
          binding.sourceServerId !== deps.sourceServerId
        )
          throw new SessionControlError("forbidden", "App source does not match the active Host");
        if (request.session) await requireTarget(context, request.session);
        else if (request.scope.scope === "project") {
          const id = request.scope.projectId;
          const projects = await deps.projects.readProjects();
          if (
            !projects.some(
              (project) =>
                project.id === id && project.hostId === deps.sourceServerId && !project.deleted,
            )
          )
            throw new SessionControlError("forbidden", "Project is unavailable");
        }
        binding.assertCurrent();
        return { scope: request.scope, fence: binding.connectionId };
      },
    },
    projects: discovery.projects,
    sessions: {
      // 只在调用者绑定的 Host 中按唯一 (host_id, task_id) 解析；不跨来源搜索，删除的会话视为不存在。
      async resolveSession(context, sessionId) {
        getAppControlBinding(context);
        const task = (await deps.projects.readTree()).tasks.find(
          (item) => item.taskId === sessionId && item.hostId === deps.sourceServerId,
        );
        getAppControlBinding(context);
        return task ? ref(task) : undefined;
      },
      listSessions: discovery.listSessions,
      async readSession(context, input, grant) {
        const task = await requireTarget(context, input.session, grant);
        if (input.view === "summary") {
          const live = await readAppLiveSummary(deps.agent, ref(task));
          const value = { ...summary(task), ...live };
          if (live?.executionId) value.availableActions.push("interruptSession");
          getAppControlBinding(context);
          return { view: "summary", summary: value };
        }
        const limit = input.limit ?? 50;
        // 旧 getTaskSnapshot 会 resume；正文只经 CLI 持久只读接口，不制造已读/导航事实。
        const messages = await readOwnerMessages(() =>
          deps.agent.readSessionMessages({
            workspacePath: task.workspacePath,
            workspaceIdentity: task.workspaceIdentity,
            sessionId: task.taskId,
            afterMessageId: input.cursor,
            limit: limit + 1,
            direction: "forward",
          }),
        );
        getAppControlBinding(context);
        const page = messages.slice(0, limit);
        return {
          view: "messages",
          session: ref(task),
          messages: page.map((message) => ({
            id: message.info.messageId,
            role: message.info.role,
            text: message.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          })),
          ...(messages.length > limit && page.length
            ? { nextCursor: page.at(-1)!.info.messageId }
            : {}),
        };
      },
    },
    execution: createAppExecutionPorts(deps, requireTarget, ref),
    organization: {
      async setSessionArchived(context, input, grant) {
        const task = await requireTarget(context, input.session, grant);
        const target = {
          workspacePath: task.workspacePath,
          workspaceIdentity: task.workspaceIdentity,
          taskId: task.taskId,
        };
        if (deps.controller)
          await deps.controller.mutateTask({
            address: { ...target, sourceServerId: deps.sourceServerId },
            mutation: { kind: "archive", archived: input.archived },
          });
        else if (input.archived) await deps.tasks.archiveTask(target);
        else await deps.tasks.unarchiveTask(target);
        return { requestId: input.requestId, status: "applied" };
      },
      async setSessionPinned(context, input, grant) {
        const task = await requireTarget(context, input.session, grant);
        const target = {
          workspacePath: task.workspacePath,
          workspaceIdentity: task.workspaceIdentity,
          taskId: task.taskId,
        };
        if (deps.controller)
          await deps.controller.mutateTask({
            address: { ...target, sourceServerId: deps.sourceServerId },
            mutation: { kind: "pin", pinned: input.pinned },
          });
        else await deps.tasks.setTaskPinned({ ...target, pinned: input.pinned });
        return { requestId: input.requestId, status: "applied" };
      },
    },
    ...(deps.navigation
      ? {
          navigation: {
            async openSession(
              context: AppTrustedContext,
              input: { session: AppSessionRef; uiTarget?: string },
              grant: AccessGrant<AppScope>,
            ) {
              await requireTarget(context, input.session, grant);
              return deps.navigation!.openSession({
                ...input,
                binding: getAppControlBinding(context),
              });
            },
          },
        }
      : {}),
    observations: {
      async open(context, operation, signal, grant) {
        await requireTarget(context, operation.session, grant);
        return observeAppOperation(
          deps.agent,
          operation,
          signal,
          getAppControlBinding(context).connectionId,
        );
      },
    },
    deadlines: {
      create(timeoutMs) {
        let timer: ReturnType<typeof setTimeout>;
        const expired = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        return {
          expired,
          close() {
            clearTimeout(timer);
          },
        };
      },
    },
  });
  return {
    control,
    async bind(binding) {
      binding.assertCurrent();
      if (binding.sourceServerId !== deps.sourceServerId)
        throw new SessionControlError("forbidden", "Caller source is not this Host");
      const task = await readTask({
        kind: "app",
        sourceServerId: binding.sourceServerId,
        workspacePath: binding.workspacePath,
        workspaceIdentity: binding.workspaceIdentity,
        sessionId: binding.callerSessionId,
      });
      binding.assertCurrent();
      const rootSession = ref(task);
      const scope: AppScope = { kind: "app", scope: "host", sourceServerId: deps.sourceServerId };
      const discovery = await bindAppDiscoverySources(deps, binding);
      return {
        caller: "session",
        callerId: `${deps.sourceServerId}:${workspaceKey(binding)}:${task.taskId}`,
        rootSession,
        allowedScopes: [scope],
        discoveryScopes: discovery.sources.flatMap((source) => source.scopes),
        signal: binding.signal,
        uiTarget: binding.uiTarget,
        [appControlBindingKey]: {
          ...binding,
          assertCurrent: () => binding.assertCurrent(),
          discovery,
        },
      } as BoundAppContext;
    },
    async bindClient(binding) {
      binding.assertCurrent();
      if (binding.sourceServerId !== deps.sourceServerId)
        throw new SessionControlError("forbidden", "Client source is not this Host");
      // clientId 是幂等键的一部分：不规范的值会让两次请求落到不同键（或合并到同一个），直接拒绝。
      if (
        !binding.clientId ||
        binding.clientId.trim() !== binding.clientId ||
        !binding.connectionId
      )
        throw new SessionControlError("forbidden", "Client identity is not canonical");
      const scope: AppScope = { kind: "app", scope: "host", sourceServerId: deps.sourceServerId };
      // 与会话类相同的发现范围：本 Host 与窗口已连接来源的已添加项目；写仍只到本 Host。
      const discovery = await bindAppDiscoverySources(deps, binding);
      binding.assertCurrent();
      return {
        caller: "client",
        callerId: `${deps.sourceServerId}:client:${binding.clientId}`,
        allowedScopes: [scope],
        discoveryScopes: discovery.sources.flatMap((source) => source.scopes),
        signal: binding.signal,
        [appControlBindingKey]: {
          ...binding,
          assertCurrent: () => binding.assertCurrent(),
          discovery,
        },
      } as BoundAppContext;
    },
  };
}
