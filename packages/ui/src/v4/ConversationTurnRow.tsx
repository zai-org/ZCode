import type { ConversationRow, ConversationRowTarget } from "@zcode/shared/zcode-protocol-v4";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import type { AssistantCodeCommentCard } from "@/lib/assistantCodeComment.js";
import { extractPlanToolCallContent } from "@/lib/planToolCall.js";
import { ConversationRowView, type UserInputEditHandler } from "@/v4/ConversationRowView.js";
import type {
  AssistantFeedbackHandler,
  EditWorkspaceRewindAvailability,
} from "@/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

interface ConversationTurnRowProps {
  row: ConversationRow;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onEdit?: UserInputEditHandler;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  hideAssistantActions?: boolean;
  deferAssistantActions?: boolean;
  assistantCopyText?: string;
  assistantPreviewCards?: AssistantPreviewCard[];
  assistantPreviewCardsAutoOpenKey?: string;
  assistantCodeCommentCards?: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled?: boolean;
  reasoningContentVariant?: "default" | "nested";
  userInputStatus?: string;
}

export function ConversationTurnRow({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  editWorkspaceRewindAvailability,
  hideAssistantActions,
  deferAssistantActions,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  reasoningContentVariant,
  userInputStatus,
}: ConversationTurnRowProps) {
  return (
    <ConversationRowView
      row={row}
      context={context}
      onFork={onFork}
      onRetry={onRetry}
      onFeedbackChange={onFeedbackChange}
      onEdit={onEdit}
      editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
      hideAssistantActions={hideAssistantActions}
      deferAssistantActions={deferAssistantActions}
      assistantCopyText={assistantCopyText}
      assistantPreviewCards={assistantPreviewCards}
      assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
      assistantCodeCommentCards={assistantCodeCommentCards}
      assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
      reasoningContentVariant={reasoningContentVariant}
      userInputStatus={userInputStatus}
    />
  );
}

export function resolveAssistantCopyText(unit: ConversationTurnRenderUnit): string | undefined {
  if (!unit.latestAssistantTextRow) {
    return undefined;
  }

  const segments =
    unit.assistantTextRows.length > 0
      ? unit.assistantTextRows.map((segment) => segment.text)
      : [unit.latestAssistantTextRow.text];
  const includedSegments = new Set(segments);
  for (const row of unit.assistantWorkRows) {
    if (row.kind !== "toolCall" || row.toolName !== "ExitPlanMode") continue;
    const markdown = extractPlanToolCallContent(toolCallRowToLegacyNode(row).toolCall, "").markdown;
    if (!markdown || includedSegments.has(markdown)) continue;
    // 产品边界：assistant 复制代表本轮完整可见回答。计划正文来自原位结构化 tool row，
    // 不能读取被 max-height/mask 裁切的卡片 DOM，也不能顺手混入普通工具输出。
    segments.push(markdown);
    includedSegments.add(markdown);
  }
  return segments.join("\n\n");
}
