/*
 * Derived from vercel/ai-elements (packages/elements/src/queue.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { Button } from "../ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { ScrollArea } from "../ui/scroll-area.js";
import { cn } from "../lib/utils.js";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  LoaderCircle,
  PaperclipIcon,
} from "lucide-react";
import type { ComponentProps } from "react";

export interface QueueMessagePart {
  type: string;
  text?: string;
  url?: string;
  filename?: string;
  mediaType?: string;
}

export interface QueueMessage {
  id: string;
  parts: QueueMessagePart[];
}

export interface QueueTodo {
  id: string;
  title: string;
  description?: string;
  status?: QueueItemStatus;
}

export type QueueItemStatus = "pending" | "in_progress" | "completed";

export type QueueItemProps = ComponentProps<"li">;

export const QueueItem = ({ className, ...props }: QueueItemProps) => (
  <li
    className={cn(
      "group flex flex-col gap-1 rounded-md px-3 py-1 text-ui-base transition-colors hover:bg-muted",
      className,
    )}
    {...props}
  />
);

export type QueueItemIndicatorProps = ComponentProps<"span"> & {
  status?: QueueItemStatus;
  completed?: boolean;
};

const queueItemIndicatorIconMap = {
  pending: CircleIcon,
  in_progress: LoaderCircle,
  completed: CheckCircle2Icon,
} satisfies Record<QueueItemStatus, typeof CircleIcon>;

const queueItemIndicatorClassMap: Record<QueueItemStatus, string> = {
  pending: "text-muted-foreground/70",
  in_progress: "text-blue-500",
  completed: "text-green-500",
};

export const QueueItemIndicator = ({
  status,
  completed = false,
  className,
  ...props
}: QueueItemIndicatorProps) => {
  const resolvedStatus = status ?? (completed ? "completed" : "pending");
  const IndicatorIcon = queueItemIndicatorIconMap[resolvedStatus];

  return (
    <span
      className={cn(
        "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center",
        queueItemIndicatorClassMap[resolvedStatus],
        className,
      )}
      {...props}
    >
      {/* 原来只靠圆点颜色区分状态，计划里“进行中”和“未开始”很难一眼看出来；改成图标后再让进行中旋转，状态识别更直接。*/}
      <IndicatorIcon
        className={cn("size-4", resolvedStatus === "in_progress" ? "animate-spin" : undefined)}
      />
    </span>
  );
};

export type QueueItemContentProps = ComponentProps<"span"> & {
  completed?: boolean;
};

export const QueueItemContent = ({
  completed = false,
  className,
  ...props
}: QueueItemContentProps) => (
  <span
    className={cn(
      "line-clamp-1 grow break-words",
      completed ? "text-muted-foreground/50 line-through" : "text-muted-foreground",
      className,
    )}
    {...props}
  />
);

export type QueueItemDescriptionProps = ComponentProps<"div"> & {
  completed?: boolean;
};

export const QueueItemDescription = ({
  completed = false,
  className,
  ...props
}: QueueItemDescriptionProps) => (
  <div
    className={cn(
      "ml-6 text-ui-base",
      completed ? "text-muted-foreground/40 line-through" : "text-muted-foreground",
      className,
    )}
    {...props}
  />
);

export type QueueItemActionsProps = ComponentProps<"div">;

export const QueueItemActions = ({ className, ...props }: QueueItemActionsProps) => (
  <div className={cn("flex gap-1", className)} {...props} />
);

export type QueueItemActionProps = Omit<ComponentProps<typeof Button>, "variant" | "size">;

export const QueueItemAction = ({ className, ...props }: QueueItemActionProps) => (
  <Button
    className={cn(
      "size-auto rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted-foreground/10 hover:text-foreground group-hover:opacity-100",
      className,
    )}
    size="icon"
    type="button"
    variant="ghost"
    {...props}
  />
);

export type QueueItemAttachmentProps = ComponentProps<"div">;

export const QueueItemAttachment = ({ className, ...props }: QueueItemAttachmentProps) => (
  <div className={cn("mt-1 flex flex-wrap gap-2", className)} {...props} />
);

export type QueueItemImageProps = ComponentProps<"img">;

export const QueueItemImage = ({ className, ...props }: QueueItemImageProps) => (
  <img
    alt=""
    className={cn("h-8 w-8 rounded border object-cover", className)}
    height={32}
    width={32}
    {...props}
  />
);

export type QueueItemFileProps = ComponentProps<"span">;

export const QueueItemFile = ({ children, className, ...props }: QueueItemFileProps) => (
  <span
    className={cn(
      "flex items-center gap-1 rounded border bg-muted px-2 py-1 text-ui-base",
      className,
    )}
    {...props}
  >
    <PaperclipIcon size={12} />
    <span className="max-w-[100px] truncate">{children}</span>
  </span>
);

export type QueueListProps = ComponentProps<typeof ScrollArea>;

export const QueueList = ({ children, className, ...props }: QueueListProps) => (
  <ScrollArea className={cn("", className)} {...props}>
    <div className="max-h-40">
      <ul>{children}</ul>
    </div>
  </ScrollArea>
);

// QueueSection - collapsible section container
export type QueueSectionProps = ComponentProps<typeof Collapsible>;

export const QueueSection = ({ className, defaultOpen = true, ...props }: QueueSectionProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

// QueueSectionTrigger - section header/trigger
export type QueueSectionTriggerProps = ComponentProps<"button">;

export const QueueSectionTrigger = ({
  children,
  className,
  ...props
}: QueueSectionTriggerProps) => (
  <CollapsibleTrigger asChild>
    <button
      className={cn(
        "group flex w-full items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-left font-medium text-muted-foreground text-ui-base transition-colors hover:bg-muted",
        className,
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  </CollapsibleTrigger>
);

// QueueSectionLabel - label content with icon and count
export type QueueSectionLabelProps = ComponentProps<"span"> & {
  count?: number;
  label: string;
  icon?: React.ReactNode;
};

export const QueueSectionLabel = ({
  count,
  label,
  icon,
  className,
  ...props
}: QueueSectionLabelProps) => (
  <span className={cn("flex items-center gap-2", className)} {...props}>
    <ChevronDownIcon className="size-4 transition-transform group-data-[state=closed]:-rotate-90" />
    {icon}
    <span>
      {count} {label}
    </span>
  </span>
);

// QueueSectionContent - collapsible content area
export type QueueSectionContentProps = ComponentProps<typeof CollapsibleContent>;

export const QueueSectionContent = ({ className, ...props }: QueueSectionContentProps) => (
  <CollapsibleContent className={cn(className)} {...props} />
);

export type QueueProps = ComponentProps<"div">;

export const Queue = ({ className, ...props }: QueueProps) => (
  <div
    className={cn(
      "flex flex-col gap-2 rounded-xl border border-border bg-background px-3 pt-2 pb-2 shadow-xs",
      className,
    )}
    {...props}
  />
);
