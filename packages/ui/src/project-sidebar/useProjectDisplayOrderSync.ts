import { useEffect, useMemo } from "react";
import type { VirtualProject } from "@/project-sidebar/contract.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

/**
 * 把桌面侧栏实际显示的项目顺序（置顶区在前，本机与远端 Host 混排）上报给 Window Host。
 *
 * Bug 原因：侧栏手动顺序只存在 renderer 的 localStorage 偏好里，有意不写 Host/远端 projects.position
 * （远端 position 被多个控制端共享，且不同 Host 的 position 不能比较）。手机远控只能按 position 排，
 * 桌面拖动后两端顺序对不上，刷新也不会变。这里只上报显示投影，由 Host 叠加到手机 readTree 并广播
 * state:projects；不改 position，也不改桌面自身的排序来源。手机 Web 不上报，避免覆盖桌面顺序。
 */
export function useProjectDisplayOrderSync(
  projects: readonly Pick<VirtualProject, "hostId" | "id">[],
  enabled: boolean,
) {
  const controller = useBaseWorkspaceServices().windowControllerService;
  const order = useMemo(
    () =>
      JSON.stringify(
        projects.map((project) => ({ hostId: project.hostId, projectId: project.id })),
      ),
    [projects],
  );
  useEffect(() => {
    if (!enabled || !controller) return;
    controller
      .setProjectDisplayOrder({
        order: JSON.parse(order) as { hostId: string; projectId: string }[],
      })
      .catch((error: unknown) =>
        logger.warn("[ProjectSidebar] sync project display order failed", error),
      );
  }, [controller, enabled, order]);
}
