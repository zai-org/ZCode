import { Slot } from "radix-ui";
import {
  cloneElement,
  createContext,
  useContext,
  type ReactElement,
  isValidElement,
  useCallback,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/components/lib/utils.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { ControlShortcutBadge } from "@/ControlShortcutBadge.js";

interface ControlHintTooltipProps {
  children: ReactNode;
  title: ReactNode;
  description?: string;
  shortcut?: string;
  standalone?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: ComponentProps<typeof TooltipContent>["side"];
  align?: ComponentProps<typeof TooltipContent>["align"];
  sideOffset?: ComponentProps<typeof TooltipContent>["sideOffset"];
  /** 与视口边缘的最小间距；默认 0，提示可以贴边。 */
  collisionPadding?: ComponentProps<typeof TooltipContent>["collisionPadding"];
  className?: string;
  triggerClassName?: string;
  triggerRef?: Ref<HTMLElement>;
}

type TriggerChildProps = {
  className?: string;
  ref?: Ref<HTMLElement>;
};

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  ref.current = value;
}

export function ControlHintTooltip({
  children,
  title,
  description,
  shortcut,
  standalone = false,
  open,
  onOpenChange,
  side = "top",
  align = "center",
  sideOffset = 2,
  collisionPadding,
  className,
  triggerClassName,
  triggerRef,
}: ControlHintTooltipProps) {
  const isTriggerElement = isValidElement<TriggerChildProps>(children);
  const childRef = isTriggerElement ? children.props.ref : undefined;
  // Radix Tooltip/Dropdown/Popper 的 asChild trigger 会在 ref 变化时同步 setState。
  // 这里必须稳定 callback ref 身份，否则每次 render 都会触发 ref detach/attach 并形成更新循环。
  const composedTriggerRef = useCallback(
    (value: HTMLElement | null) => {
      setRef(childRef, value);
      setRef(triggerRef, value);
    },
    [childRef, triggerRef],
  );
  const trigger = isTriggerElement ? (
    cloneElement(children, {
      // 以前额外包一层 span，Radix Tooltip/Select/Popover 多层 asChild 组合时，
      // 事件和 ref 会落到不同 DOM 上，触发 SlotClone 渲染栈错误。这里直接合到真实触发器。
      className: cn("shrink-0", children.props.className, triggerClassName),
      ref: composedTriggerRef,
    })
  ) : (
    <span
      ref={triggerRef as Ref<HTMLSpanElement>}
      className={cn("inline-flex shrink-0", triggerClassName)}
    >
      {children}
    </span>
  );

  // 大会话会为每条消息动作渲染大量 ControlHintTooltip，逐个创建 Provider
  // 会把 Radix 上下文树放大到消息数量级；共享 Provider 统一放在 Root。
  const tooltip = (
    <Tooltip open={open} onOpenChange={onOpenChange}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          description
            ? "max-w-72 flex-col items-start gap-1.5 px-3 py-2 text-left"
            : "max-w-[min(28rem,calc(100vw-1rem))] items-center gap-2 px-2.5 py-1 text-left has-data-[slot=kbd]:pr-1",
          className,
        )}
      >
        {description ? (
          <div className="flex w-full items-start justify-between gap-3">
            <span className="text-ui-sm font-medium leading-4 text-tooltip-foreground">
              {title}
            </span>
            {shortcut ? <ControlShortcutBadge>{shortcut}</ControlShortcutBadge> : null}
          </div>
        ) : (
          // 无描述的提示过去同时受 max-w-xs 和 nowrap 约束，长中英文文案会越界裁剪。
          // 短提示继续按内容宽度展示，超过视口安全宽度时允许自然换行；显式换行用于结构化提示。
          <span className="text-ui-sm font-medium whitespace-pre-line break-words text-tooltip-foreground">
            {title}
          </span>
        )}
        {description ? (
          <span className="max-w-64 text-ui-sm/relaxed text-tooltip-foreground/80">
            {description}
          </span>
        ) : null}
        {!description && shortcut ? <ControlShortcutBadge>{shortcut}</ControlShortcutBadge> : null}
      </TooltipContent>
    </Tooltip>
  );

  // 少数组件需要支持脱离 Root 的 SSR/单测渲染；由封装按需补 Provider，
  // 避免业务层重新组合 Tooltip primitives，同时不让列表中的常规提示重复创建上下文。
  return standalone ? <TooltipProvider>{tooltip}</TooltipProvider> : tooltip;
}

const SidebarTooltipContext = createContext(false);

export function SidebarTooltipProvider({ children }: { children: ReactNode }) {
  // 侧栏原先继承全局零延迟，且连续划过按钮会跳过等待；在边界统一配置，每个提示都等待 300ms。
  return (
    <SidebarTooltipContext.Provider value>
      <TooltipProvider
        delayDuration={300}
        skipDelayDuration={0}
        alwaysDelay
        disableHoverableContent
      >
        {children}
      </TooltipProvider>
    </SidebarTooltipContext.Provider>
  );
}

/** 原生 title 无法配置延迟；只在侧栏范围内替换，复用组件在其它页面的行为不变。 */
export function SidebarNativeTooltip({
  children,
  ...triggerProps
}: Omit<ComponentProps<typeof Slot.Root>, "children"> & {
  children: ReactElement<{ title?: string; disabled?: boolean; className?: string }>;
}) {
  const inSidebar = useContext(SidebarTooltipContext);
  if (!inSidebar || !children.props.title)
    return <Slot.Root {...triggerProps}>{children}</Slot.Root>;
  const trigger = cloneElement(children, { title: undefined });
  return (
    <ControlHintTooltip
      title={children.props.title}
      // 原生标题所在元素可能需要收缩；不能继承图标按钮提示的 shrink-0。
      triggerClassName={cn("shrink", children.props.className)}
    >
      {/* 菜单/树行的 asChild 会把事件和 ref 注入这个适配层，必须通过 Slot 合并回真实触发器。 */}
      {children.props.disabled ? (
        <span className="block min-w-0">
          <Slot.Root {...triggerProps}>{trigger}</Slot.Root>
        </span>
      ) : (
        <Slot.Root {...triggerProps}>{trigger}</Slot.Root>
      )}
    </ControlHintTooltip>
  );
}
