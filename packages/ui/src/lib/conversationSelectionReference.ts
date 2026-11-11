import {
  createUuid,
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  CONVERSATION_SELECTION_MAX_COUNT,
  CONVERSATION_SELECTION_MAX_TOTAL_LENGTH,
  type ConversationSelectionText,
} from "@zcode/shared";

export {
  buildPromptWithConversationSelections,
  CONVERSATION_SELECTION_MAX_COMMENT_LENGTH,
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  CONVERSATION_SELECTION_MAX_COUNT,
  CONVERSATION_SELECTION_MAX_TOTAL_LENGTH,
  type ConversationSelectionText,
} from "@zcode/shared";

export type ConversationSelectionContentType = "user" | "assistant" | "reasoning" | "tool";

/**
 * 选区在来源行里的文字位置，只给正文内的注释标记定位用，不进入发送载荷。
 * regionIndex 是行内第几个 [data-conversation-selectable] 区域，start/end 是该区域
 * 文本节点拼接串里的字符偏移（左闭右开）。
 */
export interface ConversationSelectionTextAnchor {
  regionIndex: number;
  start: number;
  end: number;
  /**
   * 描述时 Range.toString() 去空白后的文字，还原时用同一口径校验。
   * 不能拿 Selection.toString() 比：它会跳过 select-none 节点（如表格工具栏），
   * 跨单元格框选时与 Range 文本不一致，标记会被静默丢掉。
   */
  rangeText?: string;
}

export interface MessageSelectionReference extends ConversationSelectionText {
  id: string;
  sourceSessionId: string;
  sourceRowId: number;
  contentType: ConversationSelectionContentType;
  /** 仅渲染层使用的定位信息；缺失（旧引用、无法定位）时正文不画标记，chip 照常。 */
  anchor?: ConversationSelectionTextAnchor;
}

export interface MarkdownSelectionReference extends ConversationSelectionText {
  id: string;
  contentType: "markdown";
  sourceKey: string;
  sourceTitle: string;
}

export type ConversationSelectionReference = MessageSelectionReference | MarkdownSelectionReference;

export interface MarkdownSelectionTarget {
  sessionId: string | null;
  workspaceKey: string;
  draftScopeKey?: string;
}

export type ConversationSelectionDisplayReference =
  | ConversationSelectionText
  | ConversationSelectionReference;

interface ConversationSelectionAddEventDetail {
  targetSessionId: string | null;
  draftScopeKey?: string;
  workspaceKey: string;
  reference: ConversationSelectionReference;
  result?: ConversationSelectionAppendResult;
}

export type ConversationSelectionLimitReason = "count" | "single" | "total";
export type ConversationSelectionAppendResult =
  | {
      ok: true;
      references: readonly ConversationSelectionReference[];
      duplicate: boolean;
    }
  | { ok: false; reason: ConversationSelectionLimitReason };

const ADD_EVENT = "zcode:conversation-selection-add";
const USER_SELECT_KEYS = new Set(["text", "path", "comment", "agent"]);
const USER_SELECT_BLOCK_PATTERN = /(?:\n\n)?# userselect:\n```userselect\n([\s\S]*?)\n```\s*$/;
const LEGACY_BLOCK_PATTERN =
  /(?:\n\n)?# Conversation selections:\n```zcode-conversation-selections\n([\s\S]*?)\n```\s*$/;
const EDIT_EVENT = "zcode:conversation-selection-edit";
const referencesByScope = new Map<string, readonly ConversationSelectionReference[]>();
const limitReasonByScope = new Map<string, ConversationSelectionLimitReason>();
/** 已随消息发出的注释（含锚点），只用于正文里画灰色“已发送”标记；不持久化，刷新后消失。 */
const sentReferencesByScope = new Map<string, readonly ConversationSelectionReference[]>();
const SENT_REFERENCES_MAX = 32;
const scopeListeners = new Set<() => void>();
const EMPTY_REFERENCES: readonly ConversationSelectionReference[] = [];

function notifyScopeListeners(): void {
  // setConversationSelectionReferenceScope 会在 React 的 setState updater（渲染阶段）里被调用；
  // 同步通知订阅者会在渲染别的组件时触发它们的更新，必须推迟到微任务。
  queueMicrotask(() => {
    for (const listener of scopeListeners) listener();
  });
}

/** 订阅任一引用作用域的变化（composer 删除 chip、正文标记编辑/删除、发送清空都会触发）。 */
export function subscribeConversationSelectionReferenceScopes(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => {
    scopeListeners.delete(listener);
  };
}

function referenceScopeKey(
  sessionId: string | null,
  workspaceKey: string,
  draftScopeKey?: string,
): string {
  return `${workspaceKey}\0${sessionId ?? (draftScopeKey ? `__draft__:${draftScopeKey}` : "__draft__")}`;
}

export function getConversationSelectionReferenceScope(
  sessionId: string | null,
  workspaceKey: string,
  draftScopeKey?: string,
): readonly ConversationSelectionReference[] {
  return (
    referencesByScope.get(referenceScopeKey(sessionId, workspaceKey, draftScopeKey)) ??
    EMPTY_REFERENCES
  );
}

export function setConversationSelectionReferenceScope(
  sessionId: string | null,
  workspaceKey: string,
  references: readonly ConversationSelectionReference[],
  draftScopeKey?: string,
): void {
  const key = referenceScopeKey(sessionId, workspaceKey, draftScopeKey);
  if (references.length > 0) referencesByScope.set(key, references);
  else referencesByScope.delete(key);
  limitReasonByScope.delete(key);
  notifyScopeListeners();
}

export function getConversationSelectionReferenceLimitReason(
  sessionId: string | null,
  workspaceKey: string,
  draftScopeKey?: string,
): ConversationSelectionLimitReason | null {
  return limitReasonByScope.get(referenceScopeKey(sessionId, workspaceKey, draftScopeKey)) ?? null;
}

export function clearConversationSelectionReferenceScope(
  sessionId: string,
  workspaceKey: string,
): void {
  referencesByScope.delete(referenceScopeKey(sessionId, workspaceKey));
  limitReasonByScope.delete(referenceScopeKey(sessionId, workspaceKey));
  sentReferencesByScope.delete(referenceScopeKey(sessionId, workspaceKey));
  notifyScopeListeners();
}

export function clearConversationSelectionReferenceLimitReason(
  sessionId: string | null,
  workspaceKey: string,
  draftScopeKey?: string,
): void {
  limitReasonByScope.delete(referenceScopeKey(sessionId, workspaceKey, draftScopeKey));
}

export function createConversationSelectionReference(
  input: Omit<MessageSelectionReference, "id"> | Omit<MarkdownSelectionReference, "id">,
): ConversationSelectionReference {
  return { ...input, id: createUuid() };
}

export function getConversationSelectionDedupeKey(
  reference: ConversationSelectionReference,
): string {
  if (reference.contentType === "markdown") {
    return ["markdown", reference.sourceKey, reference.text].join("\0");
  }
  return [
    reference.sourceSessionId,
    reference.sourceRowId,
    reference.contentType,
    reference.text,
  ].join("\0");
}

export function appendConversationSelectionReference(
  current: readonly ConversationSelectionReference[],
  reference: ConversationSelectionReference,
): ConversationSelectionAppendResult {
  if (reference.text.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH) {
    return { ok: false, reason: "single" };
  }
  const key = getConversationSelectionDedupeKey(reference);
  const existingIndex = current.findIndex(
    (item) => getConversationSelectionDedupeKey(item) === key,
  );
  if (existingIndex >= 0) {
    // 对已注释的同一段再次写评论时更新原条目，不能被去重静默吞掉；不带评论的重复注释不覆盖已有评论。
    const existing = current[existingIndex];
    if (!reference.comment || !existing || existing.comment === reference.comment) {
      return { ok: true, references: current, duplicate: true };
    }
    const references = current.map((item, index) =>
      index === existingIndex ? { ...item, comment: reference.comment } : item,
    );
    return { ok: true, references, duplicate: true };
  }
  if (current.length >= CONVERSATION_SELECTION_MAX_COUNT) {
    return { ok: false, reason: "count" };
  }
  const totalLength = current.reduce((sum, item) => sum + item.text.length, 0);
  if (totalLength + reference.text.length > CONVERSATION_SELECTION_MAX_TOTAL_LENGTH) {
    return { ok: false, reason: "total" };
  }
  return { ok: true, references: [...current, reference], duplicate: false };
}

export function parsePromptConversationSelections(text: string): {
  visibleContent: string;
  references: readonly ConversationSelectionDisplayReference[];
} {
  const userSelectMatch = text.match(USER_SELECT_BLOCK_PATTERN);
  if (userSelectMatch) {
    return parseConversationSelectionBlock(text, userSelectMatch, (value) => {
      if (!isConversationSelectionText(value)) return null;
      // 与发送合同一致，历史保留文件路径、评论与 agent 来源，普通对话继续只恢复正文。
      return {
        ...(value.path ? { path: value.path } : {}),
        text: value.text,
        ...(value.agent ? { agent: value.agent } : {}),
        ...(value.comment ? { comment: value.comment } : {}),
      };
    });
  }
  const legacyMatch = text.match(LEGACY_BLOCK_PATTERN);
  if (!legacyMatch) return { visibleContent: text, references: [] };
  return parseConversationSelectionBlock(text, legacyMatch, (value) =>
    isConversationSelectionReference(value) ? value : null,
  );
}

function parseConversationSelectionBlock<T extends ConversationSelectionDisplayReference>(
  text: string,
  match: RegExpMatchArray,
  parseItem: (value: unknown) => T | null,
): { visibleContent: string; references: readonly T[] } {
  try {
    const parsed = JSON.parse(match[1] ?? "[]");
    if (!Array.isArray(parsed)) throw new Error("selection block is not an array");
    const references: T[] = [];
    for (const value of parsed) {
      const reference = parseItem(value);
      if (!reference) throw new Error("invalid selection reference");
      references.push(reference);
    }
    return {
      visibleContent: text.slice(0, match.index).trimEnd(),
      references,
    };
  } catch {
    return { visibleContent: text, references: [] };
  }
}

export function dispatchConversationSelectionAdd(
  detail: Omit<ConversationSelectionAddEventDetail, "result">,
): ConversationSelectionAppendResult {
  const current = getConversationSelectionReferenceScope(
    detail.targetSessionId,
    detail.workspaceKey,
    detail.draftScopeKey,
  );
  const result = appendConversationSelectionReference(current, detail.reference);
  if (result.ok) {
    setConversationSelectionReferenceScope(
      detail.targetSessionId,
      detail.workspaceKey,
      result.references,
      detail.draftScopeKey,
    );
  } else {
    limitReasonByScope.set(
      referenceScopeKey(detail.targetSessionId, detail.workspaceKey, detail.draftScopeKey),
      result.reason,
    );
  }
  window.dispatchEvent(new CustomEvent(ADD_EVENT, { detail: { ...detail, result } }));
  return result;
}

export function isConversationSelectionAddEvent(
  event: Event,
): event is CustomEvent<ConversationSelectionAddEventDetail> {
  return event.type === ADD_EVENT && event instanceof CustomEvent;
}

export function getConversationSelectionAddEventName(): string {
  return ADD_EVENT;
}

function isConversationSelectionText(value: unknown): value is ConversationSelectionText {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ConversationSelectionText>;
  return (
    typeof candidate.text === "string" &&
    (!("path" in value) ||
      (typeof candidate.path === "string" && candidate.path.trim().length > 0)) &&
    (!("comment" in value) || typeof candidate.comment === "string") &&
    (!("agent" in value) || typeof candidate.agent === "string") &&
    Object.keys(value).every((key) => USER_SELECT_KEYS.has(key))
  );
}

export function isConversationSelectionReference(
  value: unknown,
): value is ConversationSelectionReference {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ConversationSelectionReference>;
  if (candidate.contentType === "markdown") {
    return (
      typeof candidate.id === "string" &&
      typeof candidate.text === "string" &&
      typeof candidate.sourceKey === "string" &&
      typeof candidate.sourceTitle === "string"
    );
  }
  return (
    typeof candidate.id === "string" &&
    "sourceSessionId" in candidate &&
    typeof candidate.sourceSessionId === "string" &&
    "sourceRowId" in candidate &&
    typeof candidate.sourceRowId === "number" &&
    typeof candidate.text === "string" &&
    ["user", "assistant", "reasoning", "tool"].includes(candidate.contentType ?? "")
  );
}

/**
 * rewind（edit/retry/回滚）删除来源行后，带评论的注释失去所指回答，必须随之删除。
 * rowId 在 session 内单调且不复用，因此已加载窗口内缺失的来源行就是被删除的行；
 * 窗口之前尚未分页加载的历史不能当作已删除。不带评论的注释是冻结文字，保持原行为不删。
 */
export function retainSelectionCommentsWithLiveSource(
  references: readonly ConversationSelectionReference[],
  sourceSessionId: string,
  rows: { window: readonly { rowId: number }[]; firstRowId: number | null },
): readonly ConversationSelectionReference[] {
  const liveRowIds = new Set(rows.window.map((row) => row.rowId));
  const windowStart = rows.window.reduce<number | null>(
    (min, row) => (min === null ? row.rowId : Math.min(min, row.rowId)),
    null,
  );
  // 整个活动分支被回滚时窗口为空且 firstRowId 归零；仍有 firstRowId 的空窗口无法判断，保守保留。
  if (windowStart === null && rows.firstRowId !== null) return references;
  const next = references.filter(
    (reference) =>
      reference.contentType === "markdown" ||
      !reference.comment?.trim() ||
      reference.sourceSessionId !== sourceSessionId ||
      (windowStart !== null && reference.sourceRowId < windowStart) ||
      liveRowIds.has(reference.sourceRowId),
  );
  return next.length === references.length ? references : next;
}

/** 修改作用域内一条注释的评论；空评论表示回到“只保留原文”，不会删除这条注释。 */
export function updateConversationSelectionCommentInScope(
  sessionId: string | null,
  workspaceKey: string,
  id: string,
  comment: string,
  draftScopeKey?: string,
): void {
  const current = getConversationSelectionReferenceScope(sessionId, workspaceKey, draftScopeKey);
  const trimmed = comment.trim();
  let changed = false;
  const next = current.map((reference) => {
    if (reference.id !== id || (reference.comment ?? "") === trimmed) return reference;
    changed = true;
    const { comment: _previous, ...rest } = reference;
    return (trimmed ? { ...rest, comment: trimmed } : rest) as ConversationSelectionReference;
  });
  if (changed) setConversationSelectionReferenceScope(sessionId, workspaceKey, next, draftScopeKey);
}

export interface RemovedConversationSelectionReference {
  reference: ConversationSelectionReference;
  index: number;
}

/** 从作用域删除一条注释，返回原位置供撤销；composer chip 与正文标记共用，保证两边同一份数据。 */
export function removeConversationSelectionReferenceFromScope(
  sessionId: string | null,
  workspaceKey: string,
  id: string,
  draftScopeKey?: string,
): RemovedConversationSelectionReference | null {
  const current = getConversationSelectionReferenceScope(sessionId, workspaceKey, draftScopeKey);
  const index = current.findIndex((reference) => reference.id === id);
  const reference = current[index];
  if (index < 0 || !reference) return null;
  setConversationSelectionReferenceScope(
    sessionId,
    workspaceKey,
    current.filter((item) => item.id !== id),
    draftScopeKey,
  );
  return { reference, index };
}

/**
 * 撤销删除：放回原位置，其余编号随之恢复。撤销窗口内用户可能又加了注释，
 * 仍按追加规则校验条数与总长，超限时放弃撤销而不是挤掉别的注释。
 */
export function restoreConversationSelectionReferenceInScope(
  sessionId: string | null,
  workspaceKey: string,
  removed: RemovedConversationSelectionReference,
  draftScopeKey?: string,
): boolean {
  const current = getConversationSelectionReferenceScope(sessionId, workspaceKey, draftScopeKey);
  const appended = appendConversationSelectionReference(current, removed.reference);
  if (!appended.ok) return false;
  if (appended.duplicate) return true;
  const next = [...current];
  next.splice(Math.min(removed.index, next.length), 0, removed.reference);
  setConversationSelectionReferenceScope(sessionId, workspaceKey, next, draftScopeKey);
  return true;
}

/** 消息发出后记下这批注释，正文里改画中性灰的“已发送”标记。 */
export function recordSentConversationSelections(
  sessionId: string,
  workspaceKey: string,
  references: readonly ConversationSelectionReference[],
): void {
  const anchored = references.filter(
    (reference) => reference.contentType !== "markdown" && reference.anchor,
  );
  if (anchored.length === 0) return;
  const key = referenceScopeKey(sessionId, workspaceKey);
  const sentIds = new Set(anchored.map((reference) => reference.id));
  const previous = (sentReferencesByScope.get(key) ?? []).filter(
    (reference) => !sentIds.has(reference.id),
  );
  sentReferencesByScope.set(key, [...previous, ...anchored].slice(-SENT_REFERENCES_MAX));
  notifyScopeListeners();
}

export function getSentConversationSelections(
  sessionId: string,
  workspaceKey: string,
): readonly ConversationSelectionReference[] {
  return sentReferencesByScope.get(referenceScopeKey(sessionId, workspaceKey)) ?? EMPTY_REFERENCES;
}

interface ConversationSelectionEditEventDetail {
  /** 同一会话分屏时多个时间线都在监听，第一个打开浮层的置 true，其余跳过。 */
  handled?: boolean;
  sessionId: string;
  workspaceKey: string;
  id: string;
  /** 正文标记不可见（行未挂载、锚点失效）时，编辑浮层退回指向这个位置。 */
  fallback: { center: number; top: number; bottom: number };
}

/** composer 注释列表点铅笔/“添加评论”：请求时间线在正文编号处打开编辑浮层。 */
export function dispatchConversationSelectionEdit(
  detail: ConversationSelectionEditEventDetail,
): void {
  window.dispatchEvent(new CustomEvent(EDIT_EVENT, { detail }));
}

export function subscribeConversationSelectionEdit(
  listener: (detail: ConversationSelectionEditEventDetail) => void,
): () => void {
  const handle = (event: Event) => {
    if (event instanceof CustomEvent)
      listener(event.detail as ConversationSelectionEditEventDetail);
  };
  window.addEventListener(EDIT_EVENT, handle);
  return () => window.removeEventListener(EDIT_EVENT, handle);
}

let hoveredAnnotationId: string | null = null;
const hoverListeners = new Set<(id: string | null) => void>();

/** 列表行与正文气泡互相高亮：任一侧悬停都写同一个 id。 */
export function setHoveredConversationAnnotation(id: string | null): void {
  if (hoveredAnnotationId === id) return;
  hoveredAnnotationId = id;
  for (const listener of hoverListeners) listener(id);
}

export function subscribeHoveredConversationAnnotation(
  listener: (id: string | null) => void,
): () => void {
  hoverListeners.add(listener);
  listener(hoveredAnnotationId);
  return () => {
    hoverListeners.delete(listener);
  };
}
