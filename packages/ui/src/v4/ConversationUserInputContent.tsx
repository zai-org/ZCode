import { ConversationImageFileMention } from "@/v4/ConversationImageFileMention.js";
import type { ImageFilePreviewContext } from "@/hooks/useImageFilePreview.js";
import { memo, useState } from "react";
import {
  Bot,
  Cable,
  GoalIcon,
  MessagesSquare,
  MousePointerClick,
  ScrollText,
  SquareSlash,
  WandSparkles,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { isTrustedPluginIconSource } from "@/lib/pluginIconSource.js";
import { usePluginReferenceIconProjection } from "@/v4/pluginReferenceIconContext.js";
import {
  getPromptMentionVariantClassName,
  PROMPT_MENTION_BASE_CLASS_NAME,
} from "@/mentions/mentionChip.js";
import {
  formatSkillMentionDisplayLabel,
  parseMentionMarkdown,
} from "@/mentions/mentionMarkdown.js";
import { parseV4VisibleSlashCommand } from "@/v4/slashCommands.js";

const GOAL_QUERY_TOKEN_PATTERN = /^(\s*)(\/(?:goal|target))(?=\s|$)([\s\S]*)$/i;
const EMPTY_ATTACHMENTS: readonly unknown[] = [];

export interface V4UserInputGoalQueryDisplay {
  leadingText: string;
  commandText: string;
  trailingText: string;
}

/**
 * 只解析发送入口会消费的 goal query；普通正文和携带附件的同名文本保持原样。
 * 原因：用户消息展示不能仅凭包含 `/goal` 就重猜 command intent，否则上下文 prompt
 * 在隐藏附加块后会被误画成 goal 控制命令。
 */
export function parseV4UserInputGoalQuery(
  text: string,
  attachments: readonly unknown[] = EMPTY_ATTACHMENTS,
  contextAttachmentCount = 0,
): V4UserInputGoalQueryDisplay | null {
  const command = parseV4VisibleSlashCommand(text, attachments, {
    contextAttachmentCount,
  });
  if (!command || command.kind === "compact") return null;

  const match = GOAL_QUERY_TOKEN_PATTERN.exec(text);
  if (!match) return null;
  return {
    leadingText: match[1] ?? "",
    commandText: match[2] ?? "",
    trailingText: match[3] ?? "",
  };
}

type V4UserInputMentionPart = ReturnType<typeof parseMentionMarkdown>[number];

function normalizeCommandMentionLabel(label: string): string {
  return label.trim().replace(/^\/+/, "").toLowerCase();
}

function mentionClassName(category: Parameters<typeof getPromptMentionVariantClassName>[0]) {
  return cn(
    "mx-0.5 max-w-full",
    PROMPT_MENTION_BASE_CLASS_NAME,
    // userInput 正文使用 text-ui-base，与 assistant 消息体保持一致；行高跟随所在行，
    // 固定 leading-6 会比气泡正文（21px）高，顶部对齐后 token 文字比旁边正文低约 2px。
    "text-ui-base leading-[inherit]",
    getPromptMentionVariantClassName(category),
  );
}

function V4UserInputMention({
  part,
  authoritativeGoal,
  pluginIcon,
  imagePreviewContext,
}: {
  part: Exclude<V4UserInputMentionPart, { type: "text" }>;
  authoritativeGoal: boolean;
  pluginIcon?: string;
  imagePreviewContext?: ImageFilePreviewContext;
}) {
  if (part.type === "file" || part.type === "directory") {
    const content = (
      <FileDisplayInline
        path={part.label}
        options={{
          className: "inline-flex min-w-0 max-w-full items-center gap-1 align-middle",
          iconSize: 16,
          kind: part.type === "directory" ? "directory" : "file",
          fileNameClassName: "truncate text-ui-base leading-[inherit] font-medium text-current",
        }}
      />
    );
    if (part.type === "file")
      return (
        <ConversationImageFileMention
          href={part.href}
          label={part.label}
          context={imagePreviewContext}
          className={mentionClassName("files")}
        >
          {content}
        </ConversationImageFileMention>
      );
    return <span className={mentionClassName("files")}>{content}</span>;
  }

  if (part.type === "skill") {
    return (
      <span className={mentionClassName("skills")}>
        <WandSparkles aria-hidden="true" className="size-4 shrink-0" />
        {formatSkillMentionDisplayLabel(part.label)}
      </span>
    );
  }

  if (part.type === "session") {
    return (
      <span className={mentionClassName("sessions")}>
        <MessagesSquare aria-hidden="true" className="size-4 shrink-0" />
        {part.label}
      </span>
    );
  }

  if (part.type === "plugin") {
    // Plugin 引用在气泡里渲染为 chip：不进 file 分支、不可作外链打开。
    return (
      <span className={mentionClassName("plugins")} data-plugin-mention-id={part.pluginId}>
        <PluginUserMessageIcon src={pluginIcon} />
        {part.label}
      </span>
    );
  }

  if (part.type === "element") {
    // 设计模式点选的页面元素：与输入框里的元素 token 同样式
    return (
      <span className={mentionClassName("elements")}>
        <MousePointerClick aria-hidden="true" className="size-4 shrink-0" />
        {part.label}
      </span>
    );
  }

  if (part.type === "subagent") {
    return (
      <span className={mentionClassName("subagents")}>
        <Bot aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.5} />
        {part.label}
      </span>
    );
  }

  const commandName = normalizeCommandMentionLabel(part.label);
  if ((commandName === "goal" || commandName === "target") && !authoritativeGoal) {
    // 旧版纯文本嗅探会把带附件的 `/goal` 普通 prompt 也画成控制命令。
    // V4 只允许发送入口确认的首个 goal token 使用特殊 UI，其余情况必须保持用户原文。
    return `/${part.label}`;
  }

  return (
    <span
      {...(authoritativeGoal ? { "data-v4-user-input-command": "goal" } : {})}
      className={mentionClassName("commands")}
    >
      {commandName === "goal" || commandName === "target" ? (
        <GoalIcon aria-hidden="true" className="size-4 shrink-0" />
      ) : commandName === "compact" ? (
        <ScrollText aria-hidden="true" className="size-4 shrink-0" />
      ) : (
        <SquareSlash aria-hidden="true" className="size-4 shrink-0" />
      )}
      {/* Bug 根因：authoritative goal 使用原始 slash token 回显，导致用户气泡重复暴露
          控制语法。标签保留 Goal 语义，只省略 `/`；复制、编辑和协议仍使用原始 row.text。 */}
      {part.label}
    </span>
  );
}

function PluginUserMessageIcon({ src }: { src?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = isTrustedPluginIconSource(src) && failedSrc !== src;

  if (!showImage) {
    return <Cable aria-hidden="true" className="size-4 shrink-0" />;
  }

  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-plugin-mention-icon="true"
      className="inline-block size-4 shrink-0 rounded-sm object-contain align-middle"
      onError={() => setFailedSrc(src ?? null)}
    />
  );
}

export const ConversationUserInputContent = memo(function ConversationUserInputContent({
  text,
  attachments = EMPTY_ATTACHMENTS,
  contextAttachmentCount = 0,
  imagePreviewContext,
}: {
  text: string;
  attachments?: readonly unknown[];
  contextAttachmentCount?: number;
  imagePreviewContext?: ImageFilePreviewContext;
}) {
  const pluginIconProjection = usePluginReferenceIconProjection();
  const goalQuery = parseV4UserInputGoalQuery(text, attachments, contextAttachmentCount);
  const parts = parseMentionMarkdown(text);
  const authoritativeGoalPartIndex = goalQuery
    ? parts.findIndex(
        (part) =>
          part.type === "command" &&
          ["goal", "target"].includes(normalizeCommandMentionLabel(part.label)),
      )
    : -1;

  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "text") {
          return part.text;
        }

        return (
          <V4UserInputMention
            key={`${part.type}-${index}`}
            part={part}
            imagePreviewContext={imagePreviewContext}
            authoritativeGoal={index === authoritativeGoalPartIndex}
            pluginIcon={
              part.type === "plugin" && part.pluginId
                ? pluginIconProjection?.iconByPluginId.get(part.pluginId)
                : undefined
            }
          />
        );
      })}
    </>
  );
});
