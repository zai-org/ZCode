import type { IProjectService, ProjectTask, ProjectTree } from "#src/project/contract.js";
import type { ProjectDisplayOrderKey } from "#src/window-controller/windowController.js";
import type {
  PendingInteractionSummary,
  WindowHostControllerTaskRow,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 手机项目树的实时待处理交互叠加。
 *
 * 3.16 手机经 RPC `project.readTree` 读任务列表；readTree 只读 SQLite，拿不到 sessions-index
 * 里的实时交互，手机列表因此无法显示「待处理」。这里在手机 attachment 的 project 服务上，
 * 用 WindowHostController 投影行（与桌面侧栏 activity 同源）给每个任务补上：
 * - `pendingInteractions`: { permissionCount, userInputCount }（RN 契约格式）
 * - `pendingInteraction`: `{ kind }` 轻量标记（KMP 现有 ProjectTreeTask 只判断该字段是否存在）；
 *   投影行只有计数、没有交互 id，因此不下发 interactionId，也不携带问题/命令等敏感内容
 * 交互增减时广播一次 `state:projects`，复用手机已有的「收到即重读」链路。
 *
 * 项目顺序（2026-11-12）：桌面侧栏的手动顺序只存在 renderer 的侧栏偏好里（不写 Host / 远端
 * `projects.position`，见 docs/superpowers/specs/2026-09-09-virtual-project-design.md §3.4.1），
 * 手机只能按 position 排，拖动后两端顺序对不上。桌面 renderer 经 window-controller 上报实际显示顺序，
 * 这里在手机 readTree 上加顶层 `projectOrder`（本机与远端 Host 统一的一份列表，置顶区在前），
 * 顺序变化时同样广播 `state:projects`。旧 App 不认识该字段，行为不变。
 */
/** 手机 readTree 的线上扩展：桌面侧栏实际显示的项目顺序；桌面没上报时省略。 */
export type WebRemoteProjectTree = ProjectTree & { projectOrder?: ProjectDisplayOrderKey[] };

/** renderer 上报的数据只保留合法、去重后的键；上限防止异常调用撑大每次 readTree 的响应。 */
const MAX_PROJECT_ORDER = 5000;
export function normalizeProjectDisplayOrder(input: unknown): ProjectDisplayOrderKey[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const order: ProjectDisplayOrderKey[] = [];
  for (const item of input) {
    if (order.length >= MAX_PROJECT_ORDER) break;
    const { hostId, projectId } = (item ?? {}) as Partial<ProjectDisplayOrderKey>;
    if (typeof hostId !== "string" || typeof projectId !== "string" || !hostId || !projectId)
      continue;
    const key = JSON.stringify([hostId, projectId]);
    if (seen.has(key)) continue;
    seen.add(key);
    order.push({ hostId, projectId });
  }
  return order;
}

function sameProjectOrder(
  left: readonly ProjectDisplayOrderKey[] | undefined,
  right: readonly ProjectDisplayOrderKey[],
): boolean {
  return (
    left?.length === right.length &&
    left.every(
      (key, index) =>
        key.hostId === right[index]!.hostId && key.projectId === right[index]!.projectId,
    )
  );
}

export type WebRemoteProjectTask = Omit<ProjectTask, "pendingInteraction"> & {
  pendingInteractions?: PendingInteractionSummary;
  pendingInteraction?: ProjectTask["pendingInteraction"] | { kind: "permission" | "userInput" };
};

type TaskRows = () => readonly WindowHostControllerTaskRow[];

function taskKey(task: { workspacePath: string; workspaceIdentity?: string; taskId: string }) {
  return `${task.workspaceIdentity?.trim() || task.workspacePath}\0${task.taskId}`;
}

/** 一行的待处理交互计数；没有或全为 0 时返回 undefined（手机不显示「待处理」）。 */
export function summarizeTaskRowPendingInteractions(
  row: Pick<WindowHostControllerTaskRow, "activity">,
): PendingInteractionSummary | undefined {
  const summary = row.activity?.pendingInteractions;
  if (!summary || summary.permissionCount + summary.userInputCount <= 0) return undefined;
  return { permissionCount: summary.permissionCount, userInputCount: summary.userInputCount };
}

export function overlayProjectTreeTaskActivity(
  tree: ProjectTree,
  rows: readonly WindowHostControllerTaskRow[],
): ProjectTree {
  if (rows.length === 0 || tree.tasks.length === 0) return tree;
  const byKey = new Map(rows.map((row) => [taskKey(row.address), row]));
  return {
    ...tree,
    // 仅线上扩展字段（RPC 原样序列化），桌面侧不消费，故在此收窄回 ProjectTree。
    tasks: tree.tasks.map((task): WebRemoteProjectTask => {
      const row = byKey.get(taskKey(task));
      const summary = row && summarizeTaskRowPendingInteractions(row);
      if (!row || !summary) return task;
      return {
        ...task,
        // 权限优先：与桌面侧栏「等待授权」优先展示一致。
        pendingInteraction: task.pendingInteraction ?? {
          kind: summary.permissionCount > 0 ? "permission" : "userInput",
        },
        pendingInteractions: summary,
      };
    }) as ProjectTree["tasks"],
  };
}

/** 只含有待处理交互的任务及计数；同签名不重复广播。 */
export function buildPendingInteractionSignature(
  rows: readonly WindowHostControllerTaskRow[],
): string {
  return rows
    .flatMap((row) => {
      const summary = summarizeTaskRowPendingInteractions(row);
      return summary
        ? [`${taskKey(row.address)}\0${summary.permissionCount}\0${summary.userInputCount}`]
        : [];
    })
    .sort()
    .join("\n");
}

export function decorateProjectServiceWithTaskActivity(
  base: IProjectService,
  readRows: TaskRows,
  readProjectOrder: () => readonly ProjectDisplayOrderKey[] | undefined = () => undefined,
): IProjectService {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "readTree") {
        return async (params?: Parameters<IProjectService["readTree"]>[0]) => {
          const tree = overlayProjectTreeTaskActivity(await target.readTree(params), readRows());
          const projectOrder = readProjectOrder();
          // 每个 Host 的 readTree 都带同一份完整列表：手机按 Host 分别读再合并，离线入口也要能排到原位。
          return projectOrder
            ? ({ ...tree, projectOrder: [...projectOrder] } satisfies WebRemoteProjectTree)
            : tree;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * 按手机 attachment 引用计数启停交互变化监听：没有手机连接时不订阅投影、不额外广播，
 * 桌面侧栏行为与改动前完全一致。
 */
export function createWebRemoteProjectTreeActivityBridge(options: {
  readRows: TaskRows;
  subscribeRows: (onChange: () => void) => { dispose(): void };
  notifyProjectChange: () => void;
}) {
  let retained = 0;
  let subscription: { dispose(): void } | null = null;
  let projectOrder: ProjectDisplayOrderKey[] | undefined;
  return {
    decorate: (base: IProjectService) =>
      decorateProjectServiceWithTaskActivity(base, options.readRows, () => projectOrder),
    /** 桌面 renderer 上报的侧栏显示顺序；内容不变不广播，没有手机连接时只记录不广播。 */
    setProjectOrder(input: unknown): void {
      const next = normalizeProjectDisplayOrder(input);
      if (sameProjectOrder(projectOrder, next)) return;
      projectOrder = next;
      if (retained > 0) options.notifyProjectChange();
    },
    retain(): { dispose(): void } {
      retained += 1;
      if (!subscription) {
        let last = buildPendingInteractionSignature(options.readRows());
        subscription = options.subscribeRows(() => {
          const next = buildPendingInteractionSignature(options.readRows());
          if (next === last) return;
          last = next;
          options.notifyProjectChange();
        });
      }
      let released = false;
      return {
        dispose() {
          if (released) return;
          released = true;
          retained -= 1;
          if (retained === 0) {
            subscription?.dispose();
            subscription = null;
          }
        },
      };
    },
  };
}
