import { SelectionActionMenu } from "@/v4/SelectionActionMenu.js";
import {
  ConversationAnnotationMarks,
  SelectionCommentEditor,
  annotationVariant,
  deleteConversationAnnotationWithUndo,
  describeSelectionTextAnchor,
  readSelectionText,
  selectionCodeSignature,
  useConversationAnnotationScope,
  type AnnotationMarkItem,
} from "@/selection-comment/index.js";
import { useTextSelection } from "@/hooks/useTextSelection.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  createConversationSelectionReference,
  setHoveredConversationAnnotation,
  subscribeConversationSelectionEdit,
  subscribeHoveredConversationAnnotation,
  updateConversationSelectionCommentInScope,
  type ConversationSelectionAppendResult,
  type ConversationSelectionContentType,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";
import {
  guardConversationSelectionCandidate,
  hasExcludedConversationSelectionEndpoint,
} from "@/lib/conversationSelectionGuard.js";

interface TooltipState {
  center: number;
  bottom: number;
  top: number;
  reference?: ConversationSelectionReference;
  error?: "single";
}

const SELECTABLE_SELECTOR = "[data-conversation-selectable]";

interface AnchorPoint {
  center: number;
  top: number;
  bottom: number;
}

type CommentDraft =
  | { mode: "add"; anchor: AnchorPoint; reference: ConversationSelectionReference }
  | { mode: "edit"; anchor: AnchorPoint; id: string; showQuote: boolean };

function pointOfRect(rect: DOMRect): AnchorPoint {
  return { center: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom };
}

function contentTypeForRow(row: ConversationRow): ConversationSelectionContentType | null {
  if (row.kind === "userInput") return "user";
  if (row.kind === "assistantText") return "assistant";
  if (row.kind === "reasoning") return "reasoning";
  if (row.kind === "toolCall") return "tool";
  return null;
}

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);

/** Agent 工具行展示的是子 agent 的输出；引用带上 agent 类型，模型才能区分来源。 */
function subagentTypeForRow(
  row: ConversationRow,
  rows: readonly ConversationRow[],
): string | undefined {
  if (row.kind !== "toolCall" || !SUBAGENT_TOOL_NAMES.has(row.toolName)) return undefined;
  const subagent = rows.find(
    (candidate) =>
      candidate.kind === "subagent" &&
      candidate.turnId === row.turnId &&
      candidate.parentToolCallId === row.toolCallId,
  );
  if (subagent?.kind === "subagent" && subagent.subagentType) return subagent.subagentType;
  const input = row.input as { subagent_type?: unknown } | undefined;
  return typeof input?.subagent_type === "string" && input.subagent_type
    ? input.subagent_type
    : undefined;
}

function closestRowElement(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>("[data-row-id]") ?? null;
}

export function ConversationSelectionTooltip({
  rootRef,
  rows,
  sourceSessionId,
  enabled,
  sideActionDisabled,
  commentEnabled = false,
  annotationWorkspaceKey,
  onAddToCurrentTask,
  onAskInSideChat,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  rows: readonly ConversationRow[];
  sourceSessionId: string;
  enabled: boolean;
  sideActionDisabled?: boolean;
  /** 当前会话 CLI 声明 conversationQuoteComment 时才提供“注释”；旧 CLI 会剥掉评论。 */
  commentEnabled?: boolean;
  /** 主 composer 引用作用域的 workspaceKey；提供时正文画注释标记，并可点编号编辑。 */
  annotationWorkspaceKey?: string;
  onAddToCurrentTask: (
    reference: ConversationSelectionReference,
  ) => ConversationSelectionAppendResult | undefined;
  /** 不提供时不显示“在辅助对话中提问”：辅助对话自身的时间线不能再开辅助对话。 */
  onAskInSideChat?: (reference: ConversationSelectionReference) => void;
}) {
  const { intl } = useZCodeIntl();
  const selectionTextCacheRef = useRef<{
    rawText: string;
    codeSignature: string;
    startContainer: Node;
    startOffset: number;
    endContainer: Node;
    endOffset: number;
    text: string;
  } | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const inspectSelection = useCallback((): TooltipState | null => {
    if (!enabled) return null;
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount !== 1) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const startRow = closestRowElement(range.startContainer);
    const endRow = closestRowElement(range.endContainer);
    if (!startRow || !endRow) return null;
    const startElement =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const endElement =
      range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
    // 普通 Markdown 跨选到表格单元格时，Range.cloneContents() 会把 DOM 顺序中夹着的
    // select-none 表格工具栏按钮一并克隆，若据此判断会把合法正文误判为控件选区。控件门禁只看
    // Selection 两个端点；跨 row / selectable region 仍由下面的独立 guard 拒绝。
    const excluded = hasExcludedConversationSelectionEndpoint(startElement, endElement);
    const startContent = startElement?.closest(SELECTABLE_SELECTOR);
    const endContent = endElement?.closest(SELECTABLE_SELECTOR);
    const rowId = Number(startRow.dataset.rowId);
    const row = rowsRef.current.find((candidate) => candidate.rowId === rowId);
    const contentType = row ? contentTypeForRow(row) : null;
    // 回答输出时每次滚动都会重新检查选区。选区没变就复用上次算好的原文，不在每一帧重新
    // 遍历节点、读取样式；以端点和浏览器给出的选区文本为准，任何一项变了都重新算。
    // 被跨过的代码块正文在 Shadow DOM 里，不反映在选区文本和端点上，单独记一份摘要。
    const rawText = selection.toString();
    const codeSignature = selectionCodeSignature(range);
    const cached = selectionTextCacheRef.current;
    const text =
      cached &&
      cached.rawText === rawText &&
      cached.codeSignature === codeSignature &&
      cached.startContainer === range.startContainer &&
      cached.startOffset === range.startOffset &&
      cached.endContainer === range.endContainer &&
      cached.endOffset === range.endOffset
        ? cached.text
        : readSelectionText(selection, range).trim();
    selectionTextCacheRef.current = {
      rawText,
      codeSignature,
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
      text,
    };
    const rect = range.getBoundingClientRect();
    const guardResult = guardConversationSelectionCandidate({
      enabled,
      sameRow: startRow === endRow,
      insideTimeline: root.contains(startRow),
      excluded,
      sameSelectableRegion: Boolean(
        startContent && startContent === endContent && startRow.contains(startContent),
      ),
      supportedContent: contentType !== null,
      text,
      hasLayout: rect.width > 0 || rect.height > 0,
    });
    if (guardResult === "ineligible" || !contentType) return null;
    // 选区整体滚出时间线可视范围时不显示浮层（否则会被钳在窗口边缘、指向看不见的文字）；
    // 选区仍在，滚回来后由下一次滚动重新检查并显示。
    const viewport = root.getBoundingClientRect();
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) return null;
    const position = {
      center: rect.left + rect.width / 2,
      top: rect.top,
      bottom: rect.bottom,
    };
    if (guardResult === "single-limit") {
      return { ...position, error: "single" };
    }
    const agent = row ? subagentTypeForRow(row, rowsRef.current) : undefined;
    // 记下选区在来源行里的偏移，正文才能在同一处画注释标记；同一句话出现多次时不会画错位置。
    const anchor = describeSelectionTextAnchor(range, startRow);
    return {
      ...position,
      reference: createConversationSelectionReference({
        sourceSessionId,
        sourceRowId: rowId,
        contentType,
        text,
        ...(agent ? { agent } : {}),
        ...(anchor ? { anchor } : {}),
      }),
    };
  }, [enabled, rootRef, sourceSessionId]);
  const { state, close } = useTextSelection({
    rootRef,
    enabled,
    inspect: inspectSelection,
    scopeKey: sourceSessionId,
    // 问题原因：浮层原先监听时间线的全部 scroll 并直接关闭。回答输出时时间线自动跟随到底，
    // 每个增量都会派发 scroll（scrollTop 不变时也会），浮层出现约 100ms 就被关掉，
    // 用户来不及点“注释”。改为滚动后按当前选区重新定位，选区仍在浮层就在。
    repositionOnScroll: true,
  });

  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [commentLimit, setCommentLimit] = useState<string | null>(null);
  // 切会话、进入阻塞态、分享模式或失去评论能力时，未保存的输入不能路由到新的作用域。
  useEffect(() => {
    setCommentDraft(null);
    setCommentLimit(null);
  }, [enabled, sourceSessionId, commentEnabled]);

  const scopeKey = annotationWorkspaceKey ?? "";
  const { references, sent } = useConversationAnnotationScope(sourceSessionId, scopeKey);
  const annotationsVisible = Boolean(annotationWorkspaceKey);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  useEffect(() => subscribeHoveredConversationAnnotation(setHoveredId), []);

  // 编号 = 在 composer 列表里的位置（每条注释只算一条，有无评论都编号），与 chip 列表一一对应。
  const markItems = useMemo((): AnnotationMarkItem[] => {
    if (!annotationsVisible) return [];
    const markKey = (item: Pick<AnnotationMarkItem, "rowId" | "anchor">) =>
      `${item.rowId}:${item.anchor.regionIndex}:${item.anchor.start}`;
    // 已发送标记：同一段原文被多次注释并发送时只保留最新一条，避免同一处叠两个气泡；
    // 编号按保留下来的顺序重排，只用于区分灰色标记之间的先后。
    const latestSent = new Map<string, AnnotationMarkItem>();
    for (const reference of sent) {
      if (reference.contentType === "markdown" || !reference.anchor) continue;
      if (reference.sourceSessionId !== sourceSessionId) continue;
      const item: AnnotationMarkItem = {
        id: `sent:${reference.id}`,
        number: 0,
        variant: annotationVariant(reference.comment, true),
        rowId: reference.sourceRowId,
        anchor: reference.anchor,
        text: reference.text,
        ...(reference.comment ? { comment: reference.comment } : {}),
      };
      latestSent.delete(markKey(item));
      latestSent.set(markKey(item), item);
    }
    const dedupedSent = [...latestSent.values()].map((item, index) => ({
      ...item,
      number: index + 1,
    }));
    const current: AnnotationMarkItem[] = [];
    references.forEach((reference, index) => {
      if (reference.contentType === "markdown" || !reference.anchor) return;
      if (reference.sourceSessionId !== sourceSessionId) return;
      current.push({
        id: reference.id,
        number: index + 1,
        variant: annotationVariant(reference.comment),
        rowId: reference.sourceRowId,
        anchor: reference.anchor,
        text: reference.text,
      });
    });
    if (commentDraft?.mode === "add") {
      const reference = commentDraft.reference;
      if (reference.contentType !== "markdown" && reference.anchor) {
        current.push({
          id: "__pending__",
          number: references.length + 1,
          variant: "pending",
          rowId: reference.sourceRowId,
          anchor: reference.anchor,
          text: reference.text,
        });
      }
    }
    // 当前注释盖住同一处的已发送标记：同一段再次注释时只显示当前那条。
    const currentKeys = new Set(current.map(markKey));
    return [...dedupedSent.filter((item) => !currentKeys.has(markKey(item))), ...current];
  }, [annotationsVisible, commentDraft, references, sent, sourceSessionId]);

  const openEditor = useCallback(
    (id: string, anchor: AnchorPoint, showQuote = false) => {
      if (!commentEnabled) return;
      setCommentLimit(null);
      setCommentDraft({ mode: "edit", id, anchor, showQuote });
      window.getSelection()?.removeAllRanges();
    },
    [commentEnabled],
  );

  // composer 注释列表点铅笔/“添加评论”：滚到正文编号处打开编辑浮层，编号不可见时指向列表行。
  useEffect(() => {
    // 不按 enabled（聚焦/无阻塞）门禁：composer 里的铅笔不知道时间线是否聚焦，门禁会让铅笔点了没反应。
    // 同一会话分屏时两个时间线都在监听，由第一个响应者置 handled，避免弹出两个浮层。
    if (!annotationWorkspaceKey || !commentEnabled) return;
    return subscribeConversationSelectionEdit((detail) => {
      if (
        detail.handled ||
        detail.sessionId !== sourceSessionId ||
        detail.workspaceKey !== annotationWorkspaceKey
      ) {
        return;
      }
      detail.handled = true;
      const mark = rootRef.current?.querySelector<HTMLElement>(
        `[data-annotation-mark-id="${CSS.escape(detail.id)}"]`,
      );
      if (mark) {
        mark.scrollIntoView({ block: "center", behavior: "instant" });
        openEditor(detail.id, pointOfRect(mark.getBoundingClientRect()));
      } else {
        // 正文里看不到这条注释的划线（来源行未挂载）时，卡片里才带上原文。
        openEditor(detail.id, detail.fallback, true);
      }
    });
  }, [annotationWorkspaceKey, commentEnabled, openEditor, rootRef, sourceSessionId]);

  // 输入卡片跟着正文里的标记走。
  // 问题原因：卡片是 fixed 定位，位置在点“注释”那一刻记下后就不再更新。回答输出时时间线
  // 跟随滚动，被注释的文字往上走，卡片却留在原地，箭头指向别的内容。
  // 时间线滚动或容器尺寸变化后，按标记当前的位置更新卡片锚点；标记不在页面上时保持原位。
  const draftMarkSelector =
    commentDraft?.mode === "add"
      ? '[data-annotation-mark="__pending__"] > div'
      : commentDraft?.mode === "edit"
        ? `[data-annotation-mark-id="${CSS.escape(commentDraft.id)}"]`
        : null;
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !draftMarkSelector) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rects = Array.from(root.querySelectorAll(draftMarkSelector), (element) =>
          element.getBoundingClientRect(),
        );
        if (rects.length === 0) return;
        const left = Math.min(...rects.map((rect) => rect.left));
        const right = Math.max(...rects.map((rect) => rect.right));
        const anchor: AnchorPoint = {
          center: (left + right) / 2,
          top: Math.min(...rects.map((rect) => rect.top)),
          bottom: Math.max(...rects.map((rect) => rect.bottom)),
        };
        setCommentDraft((current) =>
          current &&
          (Math.abs(current.anchor.center - anchor.center) > 0.5 ||
            Math.abs(current.anchor.top - anchor.top) > 0.5 ||
            Math.abs(current.anchor.bottom - anchor.bottom) > 0.5)
            ? { ...current, anchor }
            : current,
        );
      });
    };
    root.addEventListener("scroll", sync, { passive: true, capture: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    resize?.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("scroll", sync, true);
      resize?.disconnect();
    };
  }, [draftMarkSelector, rootRef]);

  const closeDraft = () => {
    setCommentDraft(null);
    setCommentLimit(null);
  };
  const editing =
    commentDraft?.mode === "edit"
      ? references.find((reference) => reference.id === commentDraft.id)
      : undefined;
  // 编辑中的注释在别处被删除（列表垃圾桶、发送清空）时关闭浮层，不能把保存写到不存在的条目。
  useEffect(() => {
    if (commentDraft?.mode === "edit" && !editing) setCommentDraft(null);
  }, [commentDraft, editing]);

  const marks = annotationsVisible ? (
    <ConversationAnnotationMarks
      rootRef={rootRef}
      items={markItems}
      hoveredId={hoveredId}
      onHover={setHoveredConversationAnnotation}
      onActivate={(id, rect) => openEditor(id, pointOfRect(rect))}
    />
  ) : null;

  let overlay: ReactNode = null;
  if (commentDraft?.mode === "add") {
    overlay = (
      <SelectionCommentEditor
        mode="add"
        number={references.length + 1}
        center={commentDraft.anchor.center}
        top={commentDraft.anchor.top}
        bottom={commentDraft.anchor.bottom}
        error={commentLimit}
        onCancel={closeDraft}
        onSave={(comment) => {
          const result = onAddToCurrentTask(
            comment ? { ...commentDraft.reference, comment } : commentDraft.reference,
          );
          if (result && !result.ok) {
            // 注释条数或总长已满时追加会被原子拒绝；保留浮层与输入，让用户先删掉旧注释再保存。
            setCommentLimit(intl.formatMessage({ id: `chat.selections.limit.${result.reason}` }));
            return false;
          }
          closeDraft();
          window.getSelection()?.removeAllRanges();
          return true;
        }}
      />
    );
  } else if (commentDraft?.mode === "edit" && editing && annotationWorkspaceKey) {
    overlay = (
      <SelectionCommentEditor
        key={editing.id}
        mode="edit"
        number={references.indexOf(editing) + 1}
        numberVariant={annotationVariant(editing.comment)}
        center={commentDraft.anchor.center}
        top={commentDraft.anchor.top}
        bottom={commentDraft.anchor.bottom}
        quote={commentDraft.showQuote ? editing.text : undefined}
        initialComment={editing.comment ?? ""}
        onCancel={closeDraft}
        onDelete={() => {
          closeDraft();
          deleteConversationAnnotationWithUndo({
            sessionId: sourceSessionId,
            workspaceKey: annotationWorkspaceKey,
            id: editing.id,
            formatMessage: (id) => intl.formatMessage({ id }),
          });
        }}
        onSave={(comment) => {
          updateConversationSelectionCommentInScope(
            sourceSessionId,
            annotationWorkspaceKey,
            editing.id,
            comment,
          );
          closeDraft();
          return true;
        }}
      />
    );
  } else if (state) {
    overlay = (
      <SelectionActionMenu
        center={state.center}
        top={state.top}
        bottom={state.bottom}
        singleLimit={Boolean(state.error)}
        sideActionDisabled={sideActionDisabled}
        sideDisabledTitle={intl.formatMessage({ id: "chat.selections.sideBlocked" })}
        onAddToCurrentTask={() => {
          if (state.reference) onAddToCurrentTask(state.reference);
          close();
        }}
        onAskInSideChat={
          onAskInSideChat
            ? () => {
                if (state.reference) onAskInSideChat(state.reference);
                close();
              }
            : undefined
        }
        onComment={
          commentEnabled
            ? () => {
                const reference = state.reference;
                if (reference) {
                  setCommentLimit(null);
                  setCommentDraft({ mode: "add", anchor: state, reference });
                }
                close();
              }
            : undefined
        }
      />
    );
  }
  return (
    <>
      {marks}
      {overlay}
    </>
  );
}
