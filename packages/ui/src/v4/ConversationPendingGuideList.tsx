import { memo, useMemo } from "react";
import type { QueueItem, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ConversationTurnRow } from "@/v4/ConversationTurnRow.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

interface ConversationPendingGuideListProps {
  context: ConversationRowRenderContext;
  items: readonly QueueItem[];
  turnId: string;
}

function pendingGuideRow(item: QueueItem, turnId: string): UserInputRow {
  return {
    rowId: -(item.order.admissionSeq + 1),
    turnId,
    productTurnId: turnId,
    entityId: item.queueItemId,
    kind: "userInput",
    text: item.text,
    origin: "realUser",
    sourceCommandId: item.sourceCommandId,
    clientId: item.clientId,
    attachments: item.attachments,
    createdAt: item.admittedAt,
    createdAtSeq: item.order.admissionSeq,
  };
}

function ConversationPendingGuideListImpl({
  context,
  items,
  turnId,
}: ConversationPendingGuideListProps) {
  const { intl } = useZCodeIntl();
  const rows = useMemo(() => items.map((item) => pendingGuideRow(item, turnId)), [items, turnId]);
  const status = intl.formatMessage({ id: "chat.message.turnSteer.pending" });

  if (rows.length === 0) return null;
  return (
    // 待引导消息直接渲染行，绕过了普通轮容器；补齐输入框 dock 的水平留白，避免气泡和状态贴边。
    // 修复原因：856563f260 把输入框 dock 留白从 px-4 改为 px-2，这里仍是 px-4，气泡比输入框
    // 右边缘窄 8px；留白必须与 dock 保持同一值。
    <div data-v4-pending-guide-list="true" className="flex flex-col gap-5 px-2 pt-5">
      {rows.map((row) => (
        <ConversationTurnRow
          key={row.sourceCommandId}
          row={row}
          context={context}
          userInputStatus={status}
        />
      ))}
    </div>
  );
}

export const ConversationPendingGuideList = memo(ConversationPendingGuideListImpl);
