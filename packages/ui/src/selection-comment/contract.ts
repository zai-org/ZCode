import type { SelectionCommentEditor } from "@/selection-comment/SelectionCommentEditor.js";

/**
 * 选区批注输入浮层的输入契约，以实际组件为唯一类型源。
 * 调用方持有被批注的引用与锚点；组件只收集批注文字，保存（非空、已 trim）或取消后由调用方关闭。
 */
export type SelectionCommentEditorProps = Parameters<typeof SelectionCommentEditor>[0];
