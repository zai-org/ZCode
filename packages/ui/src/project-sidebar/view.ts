import {
  buildRemoteHostWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
} from "@/project-sidebar/contract.js";
import type {
  ProjectTask,
  ProjectTree,
  VirtualProject,
  RemoteProjectDirectory,
  RemoteProjectEntry,
  ProjectAvailability,
  WindowHostTaskAddress,
  WindowHostControllerTaskActivity,
} from "@/project-sidebar/contract.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { compareTaskListItemsByTime, compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "@/project-sidebar/contract.js";
import {
  areStabilizedValuesEquivalent,
  stabilizeTaskListItems,
} from "@/v4/taskListItemStabilization.js";

/** 活动态只覆盖已有行的 UI sidecar；Controller 快照不能替代项目树的行集合和事实。 */
export function applyProjectTaskActivities(
  tree: ProjectTree,
  activities: readonly {
    address: WindowHostTaskAddress;
    activity: WindowHostControllerTaskActivity;
  }[],
): ProjectTree {
  const byKey = new Map(
    activities.map(({ address, activity }) => [buildTaskEntityKey(address), activity]),
  );
  return {
    ...tree,
    tasks: tree.tasks.map((task) => {
      const activity = byKey.get(buildTaskEntityKey(task));
      return activity ? attachTaskListRowActivity(task, activity) : task;
    }),
  };
}

/** 复用等价对象以保留行 memo；组织变化和 activity 都参加比较，不把旧项目归属粘在行上。 */
export function stabilizeProjectTree(previous: ProjectTree, next: ProjectTree): ProjectTree {
  const previousProjects = new Map(
    previous.projects.map((project) => [projectKey(project), project]),
  );
  let sameProjects = previous.projects.length === next.projects.length;
  const projects = next.projects.map((project, index) => {
    const old = previousProjects.get(projectKey(project));
    const stable = old && areStabilizedValuesEquivalent(old, project) ? old : project;
    if (previous.projects[index] !== stable) sameProjects = false;
    return stable;
  });
  const tasks = stabilizeTaskListItems(previous.tasks, next.tasks);
  return sameProjects &&
    tasks === previous.tasks &&
    areStabilizedValuesEquivalent(previous.deletedTasks, next.deletedTasks)
    ? previous
    : { ...next, projects: sameProjects ? previous.projects : projects, tasks };
}

export type ProjectRowSelection =
  | { kind: "project"; projectId: string | null; hostId?: string }
  | { kind: "timeline" }
  | { kind: "unread" }
  | { kind: "pinned" };

/** 选择器和行列表共用同一比较器，避免时间线在渲染时又被运行优先覆盖。 */
export function compareProjectTaskRows(
  left: ProjectTask,
  right: ProjectTask,
  kind: ProjectRowSelection["kind"],
): number {
  return (
    (kind === "timeline" || kind === "unread"
      ? compareTaskListItemsByTime(left, right, "updated")
      : compareZCodeTaskListItems(left, right, "updated")) ||
    JSON.stringify([right.hostId, buildTaskEntityKey(right)]).localeCompare(
      JSON.stringify([left.hostId, buildTaskEntityKey(left)]),
    )
  );
}
/** 只从 Host 已提交的行派生显示；相同 cwd 不代表相同项目。 */
export function selectProjectRows(
  tree: ProjectTree,
  selection: ProjectRowSelection,
): ProjectTask[] {
  if (selection.kind === "unread")
    return selectUnreadProjectRows(tree).sort((left, right) =>
      compareProjectTaskRows(left, right, selection.kind),
    );
  return tree.tasks
    .filter((task) => {
      if (selection.kind === "pinned") return task.pinned && !task.archived;
      if (selection.kind === "timeline") return !task.archived;
      return (
        task.projectId === selection.projectId &&
        (!selection.hostId || task.hostId === selection.hostId) &&
        !task.archived &&
        !task.pinned
      );
    })
    .sort((left, right) => compareProjectTaskRows(left, right, selection.kind));
}

export function projectHasUnread(
  tree: ProjectTree,
  project: Pick<VirtualProject, "id" | "hostId">,
): boolean {
  // 置顶只改变显示位置，不改变项目归属；不能只从截断/排除置顶的可见行汇总。
  return tree.tasks.some(
    (task) =>
      task.projectId === project.id &&
      task.hostId === project.hostId &&
      !task.archived &&
      Boolean(task.unreadAt),
  );
}

/**
 * 任务栏/Dock 角标的未读计数：与侧栏蓝点同源（host readTree 的权威树），
 * 过滤条件与 projectHasUnread 一致（非归档 + 有 unreadAt），按 host+workspace+task 去重。
 * 不能改读 renderer 的 taskListCache/taskQueryCache：它们只装载活跃 workspace 的列表，
 * 背景工作区有蓝点时这两份缓存是空的，角标会丢数。
 *
 * 角标语义是「本次 app 运行新增的未读」：启动时已有的历史未读不点亮，基线见
 * mergeBaselineForHostsInTree。分界用任务身份（key）而不是时间比较——远端 workspace 的
 * unreadAt 由远端时钟写入，与本地"启动时刻"比较会被时钟偏差打穿；身份比较全程
 * 同源（同一棵树的两次读取），无外部变量。spec 见 docs/desktop/windows-taskbar-unread-badge.md。
 */

/**
 * 启动基线：hostId → 该 host 首次成功读取时的未读快照（key → unreadAt）。
 * 进程内存，不落盘、不回写，随进程销毁（app 重启即清零）。
 * 粒度是 host 而不是全局一次快照：目录树按 host 逐步补齐（远端 Source Server
 * 连接晚于首读、首读失败走本地兜底），全局一次快照会把迟到 host 的历史未读
 * 误判为本次运行新增。
 */
export type UnreadAtBaseline = Map<string, Map<string, number>>;

/**
 * 幂等合并：只为 onlineHostIds 中尚未建基线的 host 快照，已建基线的 host 不覆盖。
 *
 * onlineHostIds 是读取层显式返回的「本轮成功取得权威快照的 host 集合」（含返回
 * 空树的 host），不能从 tree 推断：缓存项目行在远端读取失败时仍进树（展示投影），
 * 任务又只是成功的结果之一——空树 host 无任务，若靠任务推断成功，它运行期间的
 * 第一个新未读进树时会因「host 无基线」先被计数跳过、随后又被首次基线吸收，
 * 本次运行的新事被吞掉、角标恒 0。显式集合下空 host 读取成功即建空基线，
 * 之后的新未读从第一帧就正确点亮。
 *
 * 基线快照遍历全部 tree.tasks 而不是展示选择器 selectUnreadProjectRows：后者
 * 排除已归档任务，而恢复归档只改 archived、不动 unreadAt——若归档未读不进基线，
 * 恢复那一刻会被误判为新完成点亮角标。归档/项目可见性只约束当前计数，不约束基线。
 */
export function mergeBaselineForHosts(
  onlineHostIds: ReadonlySet<string>,
  tree: ProjectTree,
  baseline: UnreadAtBaseline,
): void {
  for (const hostId of onlineHostIds) {
    if (baseline.has(hostId)) continue;
    const hostBaseline = new Map<string, number>();
    for (const task of tree.tasks) {
      if (task.hostId !== hostId || task.unreadAt == null) continue;
      const key = unreadTaskKey(task);
      // 同 key 保留首次值即可：基线只取「快照时刻的 marker」，重复行不改变语义。
      if (!hostBaseline.has(key)) hostBaseline.set(key, task.unreadAt);
    }
    baseline.set(hostId, hostBaseline);
  }
}

export function countUnreadTasksSinceBaseline(
  tree: ProjectTree,
  baseline: UnreadAtBaseline,
): number {
  let count = 0;
  for (const task of selectUnreadProjectRows(tree)) {
    if (task.unreadAt == null) continue;
    const hostBaseline = baseline.get(task.hostId);
    // host 尚无基线 = 它还没成功读取过：整 host 不计。它的历史未读会在下一次
    // merge 建基线时吸收（host 读取成功瞬间的在途未读一并并入，属启动边界）。
    if (!hostBaseline) continue;
    const baselineAt = hostBaseline.get(unreadTaskKey(task));
    // key 不在基线 = 该 host 上线后新出现的未读；unreadAt 与基线不同 = 基线任务再次完成。
    if (baselineAt === undefined || baselineAt !== task.unreadAt) count += 1;
  }
  return count;
}

function unreadTaskKey(task: ProjectTask): string {
  return JSON.stringify([
    task.hostId,
    task.workspaceIdentity?.trim() || task.workspacePath,
    task.taskId,
  ]);
}

/** 筛选与角标共用同一集合，避免未读列表显示无法对应角标的历史孤儿任务。 */
function selectUnreadProjectRows(tree: ProjectTree): ProjectTask[] {
  // 只统计侧边栏实际渲染的项目（非软删）：孤儿任务（项目不存在）与已删项目的
  // 未读在界面上没有蓝点落点，计入只会产生「有角标没蓝点」的幽灵提醒。
  const renderedProjectKeys = new Set(
    tree.projects
      .filter((project) => !project.deleted)
      .map((project) => `${project.hostId}::${project.id}`),
  );
  const seen = new Set<string>();
  const rows: ProjectTask[] = [];
  for (const task of tree.tasks) {
    if (task.archived || !task.unreadAt) {
      continue;
    }

    // 可见性对齐渲染分区：置顶区跨项目渲染；本地无项目任务区只渲染
    // host=local 的 null-project 任务；其余任务必须归属渲染项目。
    const visible =
      task.pinned ||
      (task.projectId == null && task.hostId === "local") ||
      renderedProjectKeys.has(`${task.hostId}::${task.projectId}`);
    if (!visible) {
      continue;
    }

    const key = unreadTaskKey(task);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(task);
  }

  return rows;
}

export function projectKey(project: Pick<VirtualProject, "id" | "hostId">): string {
  return JSON.stringify([project.hostId, project.id]);
}

export function resolveEntryProject(
  entry: RemoteProjectEntry,
  tree: ProjectTree,
): VirtualProject | undefined {
  const exact = tree.projects.find(
    (project) => project.hostId === entry.hostId && project.id === entry.projectId,
  );
  if (exact) return exact;
  const legacyRoot =
    entry.projectId?.startsWith(LEGACY_SINGLE_ROOT_PROJECT_PREFIX) && entry.roots.length === 1
      ? entry.roots[0]!.rootPath
      : entry.projectId
        ? undefined
        : entry.legacyWorkspace?.workspacePath;
  const candidates = tree.projects.filter(
    (project) =>
      project.hostId === entry.hostId &&
      !project.deleted &&
      legacyRoot !== undefined &&
      project.roots.some((root) => root.rootPath === legacyRoot),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** 聚合是展示投影，不复制远端事实；离线后只保留本机入口基础缓存。 */
export function mergeProjectTrees(
  local: ProjectTree,
  directory: RemoteProjectDirectory,
  remote: ReadonlyMap<string, ProjectTree>,
): {
  tree: ProjectTree;
  availability: Map<string, ProjectAvailability>;
  /**
   * 本轮成功取得权威快照的 host 集合（local + 读取成功的远端，含返回空树的 host）。
   * 角标基线等消费方要用它判定「读取成功」，不能从 tree 推断：缓存项目行在远端
   * 失败时仍进树（展示投影），任务只是成功的结果之一而非全部（空树 host 无任务）。
   */
  onlineHostIds: Set<string>;
} {
  const projects = [...local.projects];
  const tasks = [...local.tasks];
  const deletedTasks = [...(local.deletedTasks ?? [])];
  const availability = new Map(
    local.projects.map((project) => [projectKey(project), { online: true } as ProjectAvailability]),
  );
  const retainedHosts = new Set(directory.hosts.map((host) => host.id));
  for (const entry of directory.entries) {
    if (!retainedHosts.has(entry.hostId)) continue;
    const tree = remote.get(entry.hostId);
    const resolved = tree && resolveEntryProject(entry, tree);
    const source: VirtualProject = resolved ?? {
      id: entry.projectId ?? `legacy:${entry.id}`,
      hostId: entry.hostId,
      name: entry.name,
      roots: entry.roots,
      pinned: false,
      // Bug 原因：缓存行曾写死未删除，在线删除的项目在离线或远端读取失败时复现；改读刷新写入的删除态缓存。
      deleted: entry.deleted === true,
      nameOverridden: false,
      position: projects.length,
      createdAt: 0,
      updatedAt: 0,
    };
    const project =
      entry.initialPosition == null ? source : { ...source, position: entry.initialPosition };
    const key = projectKey(project);
    if (!availability.has(key)) projects.push(project);
    availability.set(key, {
      entryId: entry.id,
      ...(entry.initialPosition == null ? {} : { upgradeEntryId: entry.id }),
      online: Boolean(resolved),
      ...(!resolved && tree ? { unresolved: true } : {}),
    });
  }
  for (const [hostId, tree] of remote) {
    if (!retainedHosts.has(hostId)) continue;
    deletedTasks.push(...(tree.deletedTasks ?? []).filter((task) => task.hostId === hostId));
    for (const task of tree.tasks) {
      if (task.hostId !== hostId) continue;
      if (
        task.projectId == null ||
        availability.get(projectKey({ hostId, id: task.projectId }))?.online
      )
        tasks.push(task);
    }
  }
  // retainedHosts 之外成员实例的树已在读取层剔除，这里再按入口名单收敛一次；
  // local 恒成功（走到合并即本地 readTree 已返回）。
  const onlineHostIds = new Set<string>(["local"]);
  for (const hostId of remote.keys()) {
    if (retainedHosts.has(hostId)) onlineHostIds.add(hostId);
  }
  return {
    tree: { projects, tasks, ...(deletedTasks.length ? { deletedTasks } : {}) },
    availability,
    onlineHostIds,
  };
}

/** Host position 仅作为控制端首次初始化的种子；实际显示顺序由侧栏偏好覆盖。 */
export function selectSortedProjects(tree: ProjectTree): VirtualProject[] {
  return tree.projects
    .filter((project) => !project.deleted)
    .sort((a, b) => a.position - b.position);
}

export function projectSourceServerId(project: VirtualProject): string | undefined {
  return project.hostId === "local"
    ? undefined
    : parseRemoteWorkspaceIdentity(
        buildRemoteHostWorkspaceIdentity(project.hostId, project.roots[0]?.rootPath ?? "/"),
      )?.sourceServerId;
}

/** 内部错误码只用于判断；展示边界翻译已知状态，保留未知服务错误的诊断信息。 */
export function formatProjectError(
  cause: unknown,
  formatMessage: (descriptor: { id: string }) => string,
): string {
  const code = cause instanceof Error ? cause.message : String(cause);
  if (code === "remote-project.host-removed") return formatMessage({ id: "project.hostRemoved" });
  if (code === "project.connection-unavailable")
    return formatMessage({ id: "project.connectionUnavailable" });
  if (code === "project.undo-unavailable") return formatMessage({ id: "project.undoUnavailable" });
  if (code === "project.data-session-running")
    return formatMessage({ id: "project.dataSessionRunning" });
  if (code === "project.data-session-referenced")
    return formatMessage({ id: "project.dataSessionReferenced" });
  if (code === "project.data-delete-failed")
    return formatMessage({ id: "project.dataDeleteFailed" });
  if (code === "project.data-unavailable") return formatMessage({ id: "project.dataUnavailable" });
  return String(cause);
}
