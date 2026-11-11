import type { ImageFilePreviewContext } from "@/hooks/useImageFilePreview.js";
import type { ChannelContentPart } from "@zcode/shared";
import { ChannelMentionContent } from "@/v4/ChannelMentionContent.js";
import { ConversationUserInputEpilogue } from "@/v4/ConversationUserInputEpilogue.js";
import { ConversationUserInputBody } from "@/v4/ConversationUserInputBody.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";

/** 正式消息和准备态共用完整正文渲染；状态由消息来源行展示。 */
export function ConversationUserInputBubble({
  text,
  contentParts,
  rowId,
  attachments,
  contextAttachmentCount,
  epilogue,
  imagePreviewContext,
}: {
  text: string;
  contentParts?: readonly ChannelContentPart[];
  rowId: string | number;
  attachments?: readonly unknown[];
  contextAttachmentCount?: number;
  epilogue?: string;
  imagePreviewContext?: ImageFilePreviewContext;
}) {
  if (!text.trim() && epilogue === undefined) return null;
  return (
    <div
      data-v4-user-input-bubble="true"
      className="flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground @min-[624px]/conversation:max-w-xl"
    >
      {text.trim() ? (
        <ConversationUserInputBody contentText={text} rowId={rowId}>
          {contentParts?.some((part) => part.type === "channelMention") ? (
            <ChannelMentionContent parts={contentParts} text={text} />
          ) : (
            <ConversationUserInputContent
              text={text}
              imagePreviewContext={imagePreviewContext}
              attachments={attachments}
              contextAttachmentCount={contextAttachmentCount}
            />
          )}
        </ConversationUserInputBody>
      ) : null}
      {epilogue === undefined ? null : <ConversationUserInputEpilogue text={epilogue} />}
    </div>
  );
}
