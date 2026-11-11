import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ProjectAvailability,
  ProjectSidebarView,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { projectKey } from "@/project-sidebar/view.js";
import { getSafeLocalStorage } from "@/lib/browserEnvironment.js";
import { readWorkspaceExpansionState } from "@/lib/workspaceExpansionPreference.js";

import { reconcileProjectOrder, moveProjectOrder } from "@/project-sidebar/projectOrder.js";

import { readProjectSidebarView } from "@/project-sidebar/view-preference.js";

const KEY = "zcode-project-sidebar-preferences";
const EMPTY_AVAILABILITY: ReadonlyMap<string, ProjectAvailability> = new Map();
interface Preferences {
  order: string[];
  view: ProjectSidebarView;
  expanded: Record<string, boolean>;
}
function read(key: string): Record<string, unknown> {
  try {
    return JSON.parse(getSafeLocalStorage()?.getItem(key) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function write(key: string, value: unknown) {
  try {
    getSafeLocalStorage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* 浏览器禁用存储时仍保持当前窗口偏好，不影响 Host 命令。 */
  }
}
export function useProjectSidebarPreferences(
  projects: VirtualProject[],
  loading: boolean,
  availability: ReadonlyMap<string, ProjectAvailability> = EMPTY_AVAILABILITY,
) {
  const upgradeKeys = useMemo(
    () =>
      new Map(
        [...availability].flatMap(([key, value]) =>
          value.upgradeEntryId ? [[`legacy:${value.upgradeEntryId}`, key] as const] : [],
        ),
      ),
    [availability],
  );
  const [legacyExpansion] = useState(readWorkspaceExpansionState);
  const [preferences, setPreferences] = useState<Preferences>(() => {
    const saved = read(KEY);
    return {
      order: reconcileProjectOrder(
        Array.isArray(saved.order)
          ? saved.order.filter((key): key is string => typeof key === "string")
          : [],
        loading ? [] : projects.map(projectKey),
        upgradeKeys,
      ),
      // 视图兼容旧选择；项目/时间线沿用各自排序，分组使用 Host 的手动顺序。
      view: readProjectSidebarView(),
      expanded:
        saved.expanded && typeof saved.expanded === "object"
          ? Object.fromEntries(
              Object.entries(saved.expanded).filter(([, v]) => typeof v === "boolean"),
            )
          : {},
    };
  });
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.key !== KEY || !event.newValue) return;
      try {
        const value = JSON.parse(event.newValue) as Partial<Preferences>;
        if (!Array.isArray(value.order) || !value.order.every((key) => typeof key === "string"))
          return;
        // storage 事件来自同一控制端的其他窗口；接收时不回写，避免相互覆盖新顺序。
        setPreferences((previous) => ({
          ...previous,
          order: [...new Set(value.order)],
          view:
            value.view === "timeline" || value.view === "grouped" || value.view === "unread"
              ? value.view
              : "projects",
          expanded:
            value.expanded && typeof value.expanded === "object"
              ? Object.fromEntries(
                  Object.entries(value.expanded).filter(
                    ([, expanded]) => typeof expanded === "boolean",
                  ),
                )
              : previous.expanded,
        }));
      } catch {
        /* 损坏的偏好不影响当前项目目录。 */
      }
    };
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, []);
  const currentKeys = JSON.stringify(projects.map(projectKey));
  useEffect(() => {
    if (loading) return;
    setPreferences((previous) => {
      const order = reconcileProjectOrder(
        previous.order,
        JSON.parse(currentKeys) as string[],
        upgradeKeys,
      );
      if (
        order.length === previous.order.length &&
        order.every((key, index) => key === previous.order[index])
      )
        return previous;
      const next = { ...previous, order };
      write(KEY, next);
      return next;
    });
  }, [currentKeys, loading, upgradeKeys]);
  const changeOrder = useCallback(
    (change: (order: string[]) => string[]) => {
      setPreferences((previous) => {
        const next = {
          ...previous,
          order: change(reconcileProjectOrder(previous.order, [], upgradeKeys)),
        };
        write(KEY, next);
        return next;
      });
    },
    [upgradeKeys],
  );
  const update = useCallback(
    (patch: Partial<Preferences>) =>
      setPreferences((previous) => {
        const next = { ...previous, ...patch };
        write(KEY, next);
        return next;
      }),
    [],
  );
  const setView = useCallback((view: ProjectSidebarView) => update({ view }), [update]);
  // 原因：偏好变化时重建展开回调会穿透所有项目的 memo，阻塞折叠动画首帧。
  // 命令保持稳定，函数式更新读取最新偏好，连续切换和跨窗口更新不会覆盖其它项目。
  const setExpanded = useCallback((project: VirtualProject, expanded: boolean) => {
    setPreferences((previous) => {
      const next = {
        ...previous,
        expanded: { ...previous.expanded, [projectKey(project)]: expanded },
      };
      write(KEY, next);
      return next;
    });
  }, []);
  return useMemo(
    () => ({
      order: preferences.order,
      prepend: (project: VirtualProject) =>
        changeOrder((order) => [
          projectKey(project),
          ...order.filter((key) => key !== projectKey(project)),
        ]),
      sort: (items: VirtualProject[]) => {
        // 删除只由权威目录移除行；提前清理排序键会把刷新前的旧行追加到末尾，造成跳动。
        const order = reconcileProjectOrder(preferences.order, items.map(projectKey), upgradeKeys);
        const positions = new Map(order.map((key, index) => [key, index]));
        return [...items].sort(
          (a, b) => positions.get(projectKey(a))! - positions.get(projectKey(b))!,
        );
      },
      reorder: (section: VirtualProject[], active: string, over: string) =>
        changeOrder((order) => moveProjectOrder(order, section.map(projectKey), active, over)),
      view: preferences.view,
      setView,
      isExpanded: (project: VirtualProject) =>
        preferences.expanded[projectKey(project)] ??
        // 重构不能丢掉旧单目录的收起偏好；远端与多 root 不以本机路径猜身份。
        (project.hostId === "local" && project.roots.length === 1
          ? legacyExpansion[project.roots[0]!.rootPath] !== false
          : true),
      setAllExpanded: (items: VirtualProject[], expanded: boolean) =>
        setPreferences((previous) => {
          // 批量操作仍写同一个偏好对象，避免逐项更新覆盖同批次中的其他项目。
          const next = {
            ...previous,
            expanded: {
              ...previous.expanded,
              ...Object.fromEntries(items.map((project) => [projectKey(project), expanded])),
            },
          };
          write(KEY, next);
          return next;
        }),
      setExpanded,
    }),
    [preferences, changeOrder, setView, setExpanded, legacyExpansion, upgradeKeys],
  );
}
