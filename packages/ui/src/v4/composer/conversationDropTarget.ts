import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEventHandler,
  type RefObject,
} from "react";

/**
 * ConversationComposer 暴露给外层对话表面的文件 drop 接口。
 *
 * controller 只在 renderer 内路由到既有 composer；不创建第二个上传状态机，
 * 也不改变 desktop continuous / web-remote-replayable 的传输边界。
 */
export interface ConversationDropTargetController {
  active: boolean;
  kind: "attachment" | "workspace" | null;
  onDragOver: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
}

/** 注册当前 owner；清理只能撤销本次绑定，不能清掉后来的 Composer。 */
export type RegisterConversationDropTarget = (
  controller: ConversationDropTargetController,
) => () => void;

type DropTargetDisplay = Pick<ConversationDropTargetController, "active" | "kind">;
type DropTargetBinding = { controller: ConversationDropTargetController };

function createDropTargetForwarders(current: RefObject<DropTargetBinding | null>) {
  return {
    onDragOver: ((event) =>
      current.current?.controller.onDragOver(event)) as DragEventHandler<HTMLElement>,
    onDragLeave: ((event) =>
      current.current?.controller.onDragLeave(event)) as DragEventHandler<HTMLElement>,
    onDrop: ((event) => current.current?.controller.onDrop(event)) as DragEventHandler<HTMLElement>,
  };
}

/** 父表面只保存展示状态和稳定转发入口；实际回调只由当前绑定持有。 */
export function useConversationDropTarget(upstream?: RegisterConversationDropTarget) {
  const current = useRef<DropTargetBinding | null>(null);
  const [display, setDisplay] = useState<DropTargetDisplay | null>(null);
  const forwarders = useMemo(() => createDropTargetForwarders(current), []);
  const register = useCallback<RegisterConversationDropTarget>(
    (controller) => {
      const binding = { controller };
      current.current = binding;
      const releaseUpstream = upstream?.(controller);
      // Bug 原因：父组件 state 保存原始回调，其共享闭包把历次 Composer/SessionPane 串成历史链。
      // 仅复制展示标量；旧闭包即使持有转发入口，也只能访问当前 owner。
      setDisplay((previous) =>
        previous?.active === controller.active && previous.kind === controller.kind
          ? previous
          : { active: controller.active, kind: controller.kind },
      );
      return () => {
        releaseUpstream?.();
        if (current.current !== binding) return;
        current.current = null;
        setDisplay(null);
      };
    },
    [upstream],
  );
  const controller = useMemo<ConversationDropTargetController | null>(
    () => (display ? { ...display, ...forwarders } : null),
    [display, forwarders],
  );
  return [controller, register] as const;
}
