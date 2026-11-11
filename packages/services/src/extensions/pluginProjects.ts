import { mkdir } from "node:fs/promises";
import { join, normalize } from "node:path";
import { ExtensionError } from "@zcode/shared/extension-host";
import type { AppProjectRef } from "@zcode/session-control/contracts";
import type { IProjectService, VirtualProject } from "#src/project/contract.js";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

// 插件项目（docs/plugins/extension-host.md §17.4，实现 P3c-2）：扩展 createSession 不带 project 时放进这里。
//
//   ensure(pluginId)
//     ├─ 同一插件同时只有一次在途，并发调用共用它
//     ├─ workspace = <dataPath>/workspace；mkdir -p（每次都做，目录被删了就重建）
//     ├─ readProjects() 找本机未删除、roots 含 workspace 的项目（主要目录优先）── 有 ─► 用它
//     └─ 没有 ─► saveProject({ name: 插件名, roots: [workspace], primaryRoot: workspace })
//
// 项目库是唯一事实源（按目录找，不另存映射）：数据库只由现有的项目服务写，本模块不碰数据库（用户决策）。

/** 插件项目的唯一目录（H7）：插件数据目录下的 workspace，会话 cwd 就是它。 */
export const PLUGIN_WORKSPACE_DIRNAME = "workspace";

export interface PluginProjectSource {
  /** 项目名：静态表里的插件名。 */
  name: string;
  /** H6 的数据目录（来自 CLI 的 plugins/list）；旧 CLI 不报告时缺省。 */
  dataPath?: string;
}

export interface PluginProjectsDeps {
  projects: Pick<IProjectService, "readProjects" | "saveProject">;
  /** 插件当前的名字与数据目录（同一份静态表与扩展声明）；插件不在里面时返回 null。 */
  plugin(pluginId: string): PluginProjectSource | null;
  /** 本机 Host 的来源 id，写进项目引用（与 ListProjects 返回的引用一致）。 */
  sourceServerId(): string | undefined;
  logger: Pick<ServiceLogger, "info" | "debug" | "warn">;
}

export interface PluginProjects {
  /** 返回插件项目的引用；没有（或已被移除）时经项目服务新建。 */
  ensure(pluginId: string): Promise<AppProjectRef>;
  /**
   * 插件项目的 id（只读，不新建）：本机未删除、目录含插件 workspace 的项目。回答审批与切换权限模式
   * 只对这些项目里的会话开放（§17.12）。没有数据目录或还没有项目时为空集合。
   */
  projectIds(pluginId: string): Promise<ReadonlySet<string>>;
}

function pluginProjectCandidates(
  projects: readonly VirtualProject[],
  workspace: string,
): VirtualProject[] {
  return projects.filter(
    (project) =>
      !project.deleted && project.roots.some((root) => normalize(root.rootPath) === workspace),
  );
}

function findPluginProject(
  projects: readonly VirtualProject[],
  workspace: string,
): VirtualProject | undefined {
  const candidates = pluginProjectCandidates(projects, workspace);
  return (
    candidates.find((project) =>
      project.roots.some((root) => root.isPrimary && normalize(root.rootPath) === workspace),
    ) ?? candidates[0]
  );
}

export function createPluginProjects(deps: PluginProjectsDeps): PluginProjects {
  const inFlight = new Map<string, Promise<AppProjectRef>>();

  const resolve = async (pluginId: string): Promise<AppProjectRef> => {
    const plugin = deps.plugin(pluginId);
    if (!plugin?.dataPath)
      throw new ExtensionError("unavailable", "the plugin data path is unavailable");
    const workspace = normalize(join(plugin.dataPath, PLUGIN_WORKSPACE_DIRNAME));
    // saveProject 提交前校验目录存在；已有项目的目录被删了也要重建，否则建会话时项目服务拒绝失效的主目录。
    await mkdir(workspace, { recursive: true });
    const sourceServerId = deps.sourceServerId();
    const ref = (projectId: string): AppProjectRef => ({
      kind: "app",
      projectId,
      ...(sourceServerId ? { sourceServerId } : {}),
    });
    const existing = findPluginProject(await deps.projects.readProjects(), workspace);
    if (existing) {
      deps.logger.debug(
        undefined,
        `plugin project reused plugin=${pluginId} project=${existing.id}`,
      );
      return ref(existing.id);
    }
    const created = await deps.projects.saveProject({
      name: plugin.name,
      roots: [workspace],
      primaryRoot: workspace,
    });
    deps.logger.info(undefined, `plugin project created plugin=${pluginId} project=${created.id}`);
    return ref(created.id);
  };

  return {
    async projectIds(pluginId) {
      const plugin = deps.plugin(pluginId);
      if (!plugin?.dataPath) return new Set();
      const workspace = normalize(join(plugin.dataPath, PLUGIN_WORKSPACE_DIRNAME));
      // 与 ensure 同一条规则（按目录，项目库是唯一事实源）；这里不建目录，也不新建项目。
      return new Set(
        pluginProjectCandidates(await deps.projects.readProjects(), workspace).map(
          (project) => project.id,
        ),
      );
    },
    ensure(pluginId) {
      const current = inFlight.get(pluginId);
      if (current) return current;
      const next = resolve(pluginId).finally(() => {
        if (inFlight.get(pluginId) === next) inFlight.delete(pluginId);
      });
      inFlight.set(pluginId, next);
      return next;
    },
  };
}
