import {
  SessionControlError,
  type AccessGrant,
  type AppScope,
  type AppSessionRef,
  type AppTrustedContext,
  type SessionSummary,
  type AppSessionControlDependencies,
} from "@zcode/session-control/contracts";
import type { ProjectTask, ProjectTree } from "#src/project/contract.js";
import type {
  AppControlCallerConnection,
  AppControlDiscoveryBatch,
  AppControlDiscoverySource,
  AppControlServiceDependencies,
} from "#src/app-control/contract.js";
import { getAppControlBinding } from "#src/app-control/context.js";

const workspaceKey = (value: { workspacePath: string; workspaceIdentity?: string }) =>
  value.workspaceIdentity?.trim() || value.workspacePath;
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const reasons = new Set([
  "source_offline",
  "source_changed",
  "source_unavailable",
  "source_unsupported",
  "legacy_project_unsupported",
]);
function sourceReason(value: unknown, fallback = "source_unavailable"): string {
  const reason = value instanceof Error ? value.message : value;
  return typeof reason === "string" && reasons.has(reason) ? reason : fallback;
}

export function appScopeContains(allowed: AppScope, requested: AppScope): boolean {
  if (allowed.sourceServerId !== requested.sourceServerId) return false;
  if (allowed.scope === "host") return true;
  if (allowed.scope === "project")
    return requested.scope === "project" && allowed.projectId === requested.projectId;
  return (
    requested.scope === "workspace" &&
    allowed.workspacePath === requested.workspacePath &&
    workspaceKey(allowed) === workspaceKey(requested)
  );
}

export function appScopeIncludesTask(scope: AppScope, task: ProjectTask): boolean {
  if (scope.sourceServerId !== task.hostId) return false;
  if (scope.scope === "host") return true;
  if (scope.scope === "project") return scope.projectId === task.projectId;
  // 发现范围扩大不改变原 workspace 权限；同 cwd 的项目会话仍不能获得操作能力。
  return (
    task.projectId === null &&
    scope.workspacePath === task.workspacePath &&
    workspaceKey(scope) === workspaceKey(task)
  );
}

export async function bindAppDiscoverySources(
  deps: AppControlServiceDependencies,
  binding: AppControlCallerConnection,
): Promise<AppControlDiscoveryBatch> {
  const batch: AppControlDiscoveryBatch = deps.discovery
    ? await deps.discovery.listSources(binding)
    : {
        sources: [
          {
            sourceServerId: deps.sourceServerId,
            scopes: [{ kind: "app", scope: "host", sourceServerId: deps.sourceServerId }],
            readTree: () => deps.projects.readTree(),
            assertCurrent: () => binding.assertCurrent(),
          },
        ],
        async prepareValidation() {
          return () => [];
        },
      };
  binding.assertCurrent();
  if (binding.signal.aborted)
    throw new SessionControlError("cancelled", "App control call cancelled");
  // 只捕获本 RPC 的来源和能力句柄；实时连接/目录事实仍由注入的 owner 复验。
  return {
    sources: batch.sources.map((source) => ({
      sourceServerId: source.sourceServerId,
      scopes: source.scopes
        .filter((scope) => scope.sourceServerId === source.sourceServerId)
        .map((scope) => ({ ...scope })),
      ...(source.unavailableReason
        ? { unavailableReason: sourceReason(source.unavailableReason) }
        : {}),
      readTree: () => source.readTree(),
      assertCurrent: () => source.assertCurrent(),
    })),
    prepareValidation: () => batch.prepareValidation(),
  };
}

type SourceRead = {
  source: AppControlDiscoverySource;
  scopes: AppScope[];
  tree?: ProjectTree;
  reason?: string;
};

function checkSource(context: AppTrustedContext, source: AppControlDiscoverySource) {
  getAppControlBinding(context);
  try {
    source.assertCurrent();
  } catch (error) {
    getAppControlBinding(context);
    throw new SessionControlError("unavailable", sourceReason(error, "source_changed"));
  }
  getAppControlBinding(context);
}

// 来源上限为 20 个远端加本机；最多同时读取 4 个，避免串行往返或突发占满 RPC。
async function parallelSources<T, R>(
  items: readonly T[],
  visit: (item: T) => Promise<R>,
): Promise<R[]> {
  let next = 0;
  const results: R[] = [];
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++)
        results[index] = await visit(items[index]!);
    }),
  );
  return results;
}

async function readSources(
  context: AppTrustedContext,
  grants: readonly AccessGrant<AppScope>[],
  sourceServerId?: string,
) {
  const binding = getAppControlBinding(context);
  if (grants.some((grant) => grant.fence !== binding.connectionId))
    throw new SessionControlError("forbidden", "Discovery grant is no longer current");
  const batch = binding.discovery;
  if (!batch) throw new SessionControlError("forbidden", "Missing trusted App discovery batch");
  const sources = batch.sources.filter(
    (source) =>
      (!sourceServerId || source.sourceServerId === sourceServerId) &&
      (source.unavailableReason ||
        grants.some((grant) =>
          source.scopes.some((scope) => appScopeContains(scope, grant.scope)),
        )),
  );
  const results = await parallelSources(sources, async (source): Promise<SourceRead> => {
    const scopes = grants
      .filter((grant) => source.scopes.some((scope) => appScopeContains(scope, grant.scope)))
      .map((grant) => grant.scope);
    if (source.unavailableReason) return { source, scopes: [], reason: source.unavailableReason };
    try {
      checkSource(context, source);
      const tree = await source.readTree();
      checkSource(context, source);
      return { source, scopes, tree };
    } catch (error) {
      // caller 取消或换代必须终止整次调用，不能被来源的部分失败吞掉。
      getAppControlBinding(context);
      return { source, scopes: [], reason: sourceReason(error) };
    }
  });
  let validate: Awaited<ReturnType<AppControlDiscoveryBatch["prepareValidation"]>>;
  try {
    validate = await batch.prepareValidation();
  } catch (error) {
    getAppControlBinding(context);
    throw error;
  }
  getAppControlBinding(context);
  // 异步 helper 返回仍会让出执行权，最终校验必须交给最外层 list 在最后一次 await 后同步执行。
  return () => {
    getAppControlBinding(context);
    let failures: ReturnType<typeof validate>;
    try {
      failures = validate();
    } catch (error) {
      getAppControlBinding(context);
      throw error;
    }
    for (const result of results) {
      if (!result.tree) continue;
      try {
        const failure = failures.find(
          (item) => item.sourceServerId === result.source.sourceServerId,
        );
        if (failure) throw new SessionControlError("unavailable", sourceReason(failure.reason));
        checkSource(context, result.source);
      } catch (error) {
        getAppControlBinding(context);
        result.tree = undefined;
        result.scopes = [];
        result.reason = sourceReason(error);
      }
    }
    getAppControlBinding(context);
    return {
      results,
      searchScope: {
        scopes: results.flatMap((result) => result.scopes),
        unavailableSources: results
          .filter((result) => result.reason)
          .map((result) => ({
            sourceServerId: result.source.sourceServerId,
            reason: result.reason!,
          })),
      },
    };
  };
}

export function createAppDiscoveryPorts(
  summarize: (task: ProjectTask) => SessionSummary<AppSessionRef>,
): {
  projects: AppSessionControlDependencies["projects"];
  listSessions: AppSessionControlDependencies["sessions"]["listSessions"];
} {
  return {
    projects: {
      async listProjects(context, input, grants) {
        // 规格 0.14：host 过滤器已删除，发现范围恒为可信上下文授予的全部来源。
        const validate = await readSources(context, grants);
        const { results, searchScope } = validate();
        const query = input.query?.toLowerCase();
        return {
          projects: results.flatMap(({ source, scopes, tree }) =>
            (tree?.projects ?? [])
              .filter(
                (project) =>
                  project.hostId === source.sourceServerId &&
                  !project.deleted &&
                  scopes.some(
                    (scope) =>
                      scope.scope === "host" ||
                      (scope.scope === "project" && scope.projectId === project.id),
                  ) &&
                  (!query || project.name.toLowerCase().includes(query)),
              )
              .map((project) => ({
                project: {
                  kind: "app" as const,
                  projectId: project.id,
                  sourceServerId: source.sourceServerId,
                },
                title: project.name,
              })),
          ),
          searchScope,
        };
      },
    },
    async listSessions(context, input, grants) {
      const validate = await readSources(context, grants, input.project?.sourceServerId);
      const { results, searchScope } = validate();
      const query = input.query?.toLowerCase();
      const items = results
        .flatMap(({ source, scopes, tree }) => {
          const projects = new Set(
            (tree?.projects ?? [])
              .filter((project) => project.hostId === source.sourceServerId && !project.deleted)
              .map((project) => project.id),
          );
          return (tree?.tasks ?? []).filter(
            (task) =>
              task.hostId === source.sourceServerId &&
              (task.projectId === null || projects.has(task.projectId)) &&
              scopes.some((scope) => appScopeIncludesTask(scope, task)) &&
              (!input.project || task.projectId === input.project.projectId) &&
              (input.archived === "include" || task.archived === (input.archived === "only")) &&
              (!query || task.title.toLowerCase().includes(query)),
          );
        })
        .sort(
          (a, b) =>
            b.updatedAt - a.updatedAt ||
            compare(a.hostId, b.hostId) ||
            compare(workspaceKey(a), workspaceKey(b)) ||
            compare(a.workspacePath, b.workspacePath) ||
            compare(a.taskId, b.taskId),
        );
      const cursorFor = (task: ProjectTask) =>
        Buffer.from(
          JSON.stringify([task.hostId, workspaceKey(task), task.workspacePath, task.taskId]),
        ).toString("base64url");
      const start = input.cursor
        ? items.findIndex((task) => cursorFor(task) === input.cursor) + 1
        : 0;
      if (input.cursor && start === 0)
        throw new SessionControlError("invalid_input", "Session cursor is no longer available");
      const limit = input.limit ?? 50;
      const page = items.slice(start, start + limit);
      return {
        sessions: page.map((task) => ({
          ...summarize(task),
          ...(!context.allowedScopes.some((scope) => appScopeIncludesTask(scope, task))
            ? { availableActions: [] }
            : {}),
        })),
        searchScope,
        ...(start + limit < items.length && page.length
          ? { nextCursor: cursorFor(page.at(-1)!) }
          : {}),
      };
    },
  };
}
