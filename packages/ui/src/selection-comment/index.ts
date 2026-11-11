export { SelectionCommentEditor } from "@/selection-comment/SelectionCommentEditor.js";
export type { SelectionCommentEditorProps } from "@/selection-comment/contract.js";
export { useSelectionCommentSupport } from "@/selection-comment/useSelectionCommentSupport.js";
export {
  AnnotationNumber,
  annotationVariant,
  type AnnotationNumberVariant,
} from "@/selection-comment/AnnotationNumber.js";
export {
  ConversationAnnotationMarks,
  type AnnotationMarkItem,
} from "@/selection-comment/ConversationAnnotationMarks.js";
export {
  ANNOTATION_UNDO_MS,
  deleteConversationAnnotationWithUndo,
  useConversationAnnotationScope,
} from "@/selection-comment/annotationActions.js";
export { describeSelectionTextAnchor } from "@/selection-comment/textAnchor.js";
