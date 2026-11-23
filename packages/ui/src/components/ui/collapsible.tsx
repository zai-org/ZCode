import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { cn } from "@/components/lib/utils.js";

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      className={cn(
        "overflow-hidden",
        "data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up data-[state=closed]:[animation-fill-mode:forwards] transition-none duration-300 ease-in-out",
        "data-[state=open]:[&>div]:animate-in data-[state=open]:[&>div]:fade-in-0",
        "data-[state=closed]:[&>div]:animate-out data-[state=closed]:[&>div]:fade-out-0 data-[state=closed]:[&>div]:[animation-fill-mode:forwards]",
        className,
      )}
      {...props}
    >
      <div className="transition-none duration-300 ease-in-out [--radix-collapsible-content-height:initial] [--radix-collapsible-content-width:initial]">
        {/* 折叠尺寸只供外层高度动画消费；继承到大型详情子树会在测量更新时
            使无关后代重算样式。内部截断继承，嵌套折叠仍使用自身的测量值。 */}
        {/* Bugfix: 大会话 resize trace 显示 collapsible 动画层只设置 duration/ease 时，
            浏览器会用默认 transition-property: all 动画 scrollbar-color，拖拽窗口时触发非合成动画。
            这里显式禁用 CSS transition，只保留 animate-in/out 的关键帧动画。 */}
        {/* 嵌套 content 的同名 group 会匹配祖先 open，覆盖当前 closed 的淡出。
            动画只由当前 content 的 data-state 作用于直接子层，保持高度/透明度分层。 */}
        {children}
      </div>
    </CollapsiblePrimitive.CollapsibleContent>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
