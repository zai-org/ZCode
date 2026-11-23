import { cn } from "@/components/lib/utils.js";

/**
 * 注释编号气泡。正文标记、composer 注释列表与编辑浮层共用，保证三处同一条注释长得一样：
 * - comment：有评论，实心
 * - quote：仅原文，空心
 * - sent：已随消息发出，同形态换中性灰
 * - pending：正在新增、尚未保存，虚线预占编号
 */
export type AnnotationNumberVariant =
  | "comment"
  | "quote"
  | "sent-comment"
  | "sent-quote"
  | "pending";

export function annotationVariant(
  comment: string | undefined,
  sent = false,
): Exclude<AnnotationNumberVariant, "pending"> {
  const hasComment = Boolean(comment?.trim());
  if (sent) return hasComment ? "sent-comment" : "sent-quote";
  return hasComment ? "comment" : "quote";
}

export function AnnotationNumber({
  value,
  variant,
  highlighted = false,
  size = "default",
  className,
}: {
  value: number;
  variant: AnnotationNumberVariant;
  highlighted?: boolean;
  /** mark：正文里的角标，比列表和卡片里的编号大一号，左下角收尖指向选区末尾。 */
  size?: "default" | "mark";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-annotation-number-variant={variant}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none tabular-nums transition-shadow",
        size === "mark" ? "size-4.5 rounded-bl-sm text-ui-sm" : "size-4 text-[10px]",
        variant === "comment" && "bg-icon-blue text-white",
        variant === "quote" && "border border-icon-blue bg-background text-icon-blue",
        variant === "sent-comment" && "bg-foreground-subtlest text-background",
        variant === "sent-quote" &&
          "border border-foreground-subtlest bg-background text-foreground-subtle",
        variant === "pending" &&
          "border border-dashed border-icon-blue bg-background text-icon-blue",
        highlighted && "ring-2 ring-icon-blue/35",
        className,
      )}
    >
      {value}
    </span>
  );
}
