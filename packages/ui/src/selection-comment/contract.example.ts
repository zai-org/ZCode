import type { SelectionCommentEditorProps } from "@/selection-comment/contract.js";

/** 标准调用：点“注释”时冻结选区位置与原文，保存时把评论（可为空）写回同一条注释。 */
export function exampleSelectionCommentEditorProps(
  anchor: { center: number; top: number; bottom: number },
  quote: string,
  nextNumber: number,
  addReference: (comment: string) => boolean,
  close: () => void,
): SelectionCommentEditorProps {
  // addReference 返回 false（注释已满等）时浮层保持打开，调用方另传 error 提示。
  return {
    ...anchor,
    mode: "add",
    number: nextNumber,
    quote,
    onSave: addReference,
    onCancel: close,
  };
}
