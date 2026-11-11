/* eslint-disable max-lines */
/**
 * LexicalChatInput — 基于 Lexical 的聊天输入框
 *
 * 基于 Lexical 的聊天输入框，支持 slash command 和 mention tag。
 * - Enter 发送，Shift+Enter 换行
 * - 支持 IME 输入
 * - 自动高度（默认显示 3 行，超出后滚动）
 * - disabled 状态
 * - 通过 SlashCommandPlugin / MentionPlugin 支持 `/` / `@` 的触发面板
 *
 * 独立输入展示壳，不承载会话编排逻辑，仅做三处适配：
 * 1. useChatViewActiveTaskProvider 来自 @/v4/activeTaskProvider.js（配置面读取）；
 * 2. ChatComposerPasteEvent 收口为本文件导出的结构类型；
 * 3. mention 面板用 enableMentionPanel 控制；slash command 始终读取 CLI workspace catalog。
 */
import { $getPromptMarkdown } from "@/mentions/promptSerialization.js";
import { PromptClipboardPlugin } from "@/mentions/PromptClipboardPlugin.js";
import {
  resolveComposerKeyAction,
  shouldBareEnterFallThroughToNewline,
} from "@/shortcuts/composerShortcuts.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getSelection,
  $getNodeByKey,
  $setSelection,
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  CLEAR_HISTORY_COMMAND,
  COMPOSITION_END_COMMAND,
  COMPOSITION_START_COMMAND,
  HISTORY_MERGE_TAG,
  KEY_ENTER_COMMAND,
  type EditorState,
  type LexicalEditor,
  type NodeKey,
  type PointType,
  type TextNode,
} from "lexical";
import { SlashCommandPlugin } from "./SlashCommandPlugin.js";
import type { AppSlashCommand } from "./slashCommandHelpers.js";
import { MentionPlugin } from "./mentions/MentionPlugin.js";
import { useChatViewActiveTaskProvider } from "@/v4/activeTaskProvider.js";
import {
  $createPromptMentionNode,
  $isPromptMentionNode,
  PromptMentionNode,
} from "./mentions/nodes/PromptMentionNode.js";
import { logger } from "./logger.js";
import { recordInputLag } from "./lib/uiPerfArmsTelemetry.js";
import { navigatePromptHistory } from "./lib/promptHistory.js";
import { resolveMobileInputTextSizeClassName } from "@/lib/mobileTextInput.js";
import type { MentionItemData } from "@/mentions/mentionTypes.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

/** 旧 useChatComposer 已删；粘贴事件收口为最小结构类型（ClipboardEvent 结构兼容）。 */
export interface ChatComposerPasteEvent {
  clipboardData: DataTransfer | null;
  preventDefault: () => void;
  stopPropagation?: () => void;
}

export interface UserInputPresence {
  raw: boolean;
  trimmed: boolean;
}

export interface LexicalChatInputHandle {
  clear: () => void;
  clearHistory: () => void;
  focus: () => void;
  getEditorState: () => EditorState;
  getMarkdown: () => string;
  getText: () => string;
  appendText: (text: string) => void;
  /**
   * 语音输入：用识别快照替换「语音文字」，首次在光标处插入（docs/chat/composer-voice-input.md）。
   * 用户在语音文字末尾追加的文字保留在其后。preserveSelection 时不移动用户光标。
   * 返回 false 表示语音文字本身已被用户改过，本次不写入。
   */
  setVoiceText: (text: string, options?: { preserveSelection?: boolean }) => boolean;
  /** 语音输入开始：记录此刻的光标，用户在首个识别结果前接管时，最终文本插到这里 */
  beginVoiceText: () => void;
  /** 语音输入结束：remove 时删除语音文字（Escape），否则保留为普通文本 */
  endVoiceText: (options: { remove: boolean }) => void;
  appendFileMention: (
    label: string,
    value: string,
    markdown: string,
    data?: MentionItemData,
    trailingText?: string,
  ) => void;
  prependMentionIfMissing: (mention: ComposerMentionPrefill) => boolean;
  setMention: (mention: ComposerMentionPrefill, trailingText?: string) => void;
  insertMention: (mention: ComposerMentionPrefill, selectionState?: EditorState) => void;
  setText: (text: string) => void;
  setTextWithPluginMentions: (text: string) => void;
  setEditorStateJson: (editorStateJson: string) => void;
  setSkillMention: (skillName: string, markdown?: string, trailingText?: string) => void;
  setSlashCommandMention: (commandName: string, markdown?: string, trailingText?: string) => void;
}

interface LexicalEnterSubmitOptions {
  allowSubmitWhenEmpty?: boolean;
  ctrlKey?: boolean;
  enterSubmits: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  text: string;
}

interface LexicalModifiedEnterSubmitOptions {
  allowSubmitWhenEmpty?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  modifiedEnterSubmits: boolean;
  shiftKey?: boolean;
  text: string;
}

export type LexicalSubmitResult = boolean | void;

interface LeadingChineseSlashAliasInputOptions {
  data: string | null;
  inputType: string;
  isAtEditorStart: boolean;
  isComposing?: boolean;
}

const CHINESE_SLASH_ALIAS = "、";
const STANDARD_SLASH_TRIGGER = "/";

import { HISTORY_NAVIGATION_UPDATE_TAG, PROGRAMMATIC_UPDATE_TAG } from "./lib/editorUpdateTags.js";

export function shouldSubmitLexicalEnter({
  allowSubmitWhenEmpty = false,
  ctrlKey = false,
  enterSubmits,
  isComposing = false,
  metaKey = false,
  shiftKey = false,
  text,
}: LexicalEnterSubmitOptions): boolean {
  if (!enterSubmits) {
    return false;
  }
  if (shiftKey || ctrlKey || metaKey || isComposing) {
    return false;
  }
  return Boolean(text.trim() || allowSubmitWhenEmpty);
}

export function shouldSubmitLexicalModifiedEnter({
  allowSubmitWhenEmpty = false,
  ctrlKey = false,
  isComposing = false,
  metaKey = false,
  modifiedEnterSubmits,
  shiftKey = false,
  text,
}: LexicalModifiedEnterSubmitOptions): boolean {
  return (
    modifiedEnterSubmits &&
    (ctrlKey || metaKey) &&
    !shiftKey &&
    !isComposing &&
    Boolean(text.trim() || allowSubmitWhenEmpty)
  );
}

export function shouldResetLexicalEditorAfterSubmit(result: LexicalSubmitResult): boolean {
  return result !== false;
}

export function shouldNormalizeLeadingChineseSlashAliasInput({
  data,
  inputType,
  isAtEditorStart,
  isComposing = false,
}: LeadingChineseSlashAliasInputOptions): boolean {
  return (
    data === CHINESE_SLASH_ALIAS && inputType === "insertText" && isAtEditorStart && !isComposing
  );
}

/** 提取编辑器内容；mention 节点会在这里输出 markdown */
function getEditorMarkdown(editorState: EditorState): string {
  let text = "";
  editorState.read(() => {
    text = $getPromptMarkdown();
  });
  return text;
}

function replaceEditorText(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();

      // Lexical getTextContent() 用 \n\n 分隔段落，对称处理防止换行翻倍
      for (const line of text.split("\n\n")) {
        const paragraph = $createParagraphNode();
        if (line) {
          paragraph.append($createTextNode(line));
        }
        root.append(paragraph);
      }

      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

const INLINE_PLUGIN_MENTION_PATTERN =
  /\[@((?:\\.|[^\]])+)\]\(plugin:\/\/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)\)/g;

function replaceEditorTextWithPluginMentions(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      for (const line of text.split("\n\n")) {
        const paragraph = $createParagraphNode();
        let cursor = 0;
        for (const match of line.matchAll(INLINE_PLUGIN_MENTION_PATTERN)) {
          const start = match.index ?? 0;
          if (start > cursor) paragraph.append($createTextNode(line.slice(cursor, start)));
          const markdown = match[0];
          const label = match[1]?.replaceAll("\\]", "]").replaceAll("\\[", "[") ?? "";
          const pluginId = match[2] ?? "";
          paragraph.append(
            $createPromptMentionNode({
              id: `plugin:${pluginId}`,
              category: "plugins",
              label,
              value: pluginId,
              markdown,
              data: { pluginId },
            }),
          );
          cursor = start + markdown.length;
        }
        if (cursor < line.length || paragraph.getChildrenSize() === 0) {
          paragraph.append($createTextNode(line.slice(cursor)));
        }
        root.append(paragraph);
      }
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

export function replaceEditorWithMention(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      // 预填后保留空格供用户直接继续输入；选区正确性由 TextNode 文本/DOM 契约保证。
      const trailing = $createTextNode(trailingText || " ");
      paragraph.append($createPromptMentionNode(mention), trailing);
      root.append(paragraph);
      trailing.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

/**
 * 在草稿开头插入结构化 mention，同时保留已有 Lexical 节点和段落。
 *
 * 不能通过 getMarkdown → setMention 重建：setMention 是替换型预填，会把旧 mention
 * 序列化后作为普通 TextNode 放回编辑器，导致已有 Plugin / 文件 / Skill chip 降级。
 */
export function prependEditorMentionIfMissing(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
): boolean {
  let inserted = false;
  editor.update(
    () => {
      const root = $getRoot();
      const alreadyPresent = root
        .getAllTextNodes()
        .some(
          (node) =>
            $isPromptMentionNode(node) &&
            node.getMention().category === mention.category &&
            node.getMention().value === mention.value,
        );
      if (alreadyPresent) return;

      const mentionNode = $createPromptMentionNode(mention);
      const separator = $createTextNode(" ");
      const firstBlock = root.getFirstChild();
      if ($isParagraphNode(firstBlock)) {
        const firstInline = firstBlock.getFirstChild();
        if (firstInline) {
          firstInline.insertBefore(mentionNode);
          mentionNode.insertAfter(separator);
        } else {
          firstBlock.append(mentionNode, separator);
        }
      } else {
        const paragraph = $createParagraphNode().append(mentionNode, separator);
        if (firstBlock) firstBlock.insertBefore(paragraph);
        else root.append(paragraph);
      }
      separator.selectEnd();
      inserted = true;
    },
    { discrete: true, tag: PROGRAMMATIC_UPDATE_TAG },
  );
  return inserted;
}

function replaceEditorStateJson(editor: LexicalEditor, editorStateJson: string) {
  const editorState = editor.parseEditorState(editorStateJson);
  editor.setEditorState(editorState, { tag: PROGRAMMATIC_UPDATE_TAG });
}

function resetEditor(editor: LexicalEditor) {
  replaceEditorText(editor, "");
}

function replaceEditorWithSkillMention(
  editor: LexicalEditor,
  skillName: string,
  markdown = `$${skillName}`,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createPromptMentionNode({
          id: `prefill-skill:${skillName}`,
          category: "skills",
          // 预填入口之前虽然会插入 skill node，但节点里保存的 markdown 仍固定成 `$slug`，
          // 导致像 New Skill 这种入口即使理论上有完整转译内容，进入输入框后也会被悄悄降级。
          // 这里显式透传原始 markdown，并直接显示 frontmatter name，避免 UI 再加工 skill 标题。
          label: skillName,
          value: skillName,
          markdown,
        }),
        $createTextNode(trailingText),
      );
      root.append(paragraph);
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function replaceEditorWithSlashCommandMention(
  editor: LexicalEditor,
  commandName: string,
  markdown = `/${commandName}`,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createPromptMentionNode({
          id: `prefill-slash:${commandName}`,
          category: "commands",
          label: commandName,
          value: commandName,
          markdown,
        }),
        $createTextNode(trailingText),
      );
      root.append(paragraph);
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function appendEditorFileMention(
  editor: LexicalEditor,
  label: string,
  value: string,
  markdown: string,
  data?: MentionItemData,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      const lastChild = root.getLastChild();
      const paragraph = $isParagraphNode(lastChild) ? lastChild : $createParagraphNode();
      if (!$isParagraphNode(lastChild)) {
        root.append(paragraph);
      }

      const currentText = paragraph.getTextContent();
      if (currentText.length > 0 && !/\s$/.test(currentText)) {
        paragraph.append($createTextNode(" "));
      }

      paragraph.append(
        $createPromptMentionNode({
          id: `dropped-file:${value}`,
          category: "files",
          label,
          value,
          markdown,
          data,
        }),
        $createTextNode(trailingText),
      );
      paragraph.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function appendEditorPlainText(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      const lastChild = root.getLastChild();
      const paragraph = $isParagraphNode(lastChild) ? lastChild : $createParagraphNode();
      if (!$isParagraphNode(lastChild)) {
        root.append(paragraph);
      }

      const currentText = paragraph.getTextContent();
      if (currentText.length > 0 && !/\s$/.test(currentText)) {
        paragraph.append($createTextNode(" "));
      }

      paragraph.append($createTextNode(text));
      paragraph.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

type VoicePoint = { key: NodeKey; offset: number; type: "text" | "element" };

/** 录音开始点：坐标加上记录时开始点之前的内容，用来判断开始点是否仍然指向同一处 */
type VoiceStartPoint = VoicePoint & { before: string };

function $readVoicePoint(point: PointType): VoicePoint {
  return { key: point.key, offset: point.offset, type: point.type };
}

/** 开始点之前的内容：文本节点取 offset 前的文字；元素节点取 offset 前子节点的 key 序列 */
function $readContentBefore(point: VoicePoint): string | null {
  const node = $getNodeByKey(point.key);
  if (point.type === "text") {
    return $isTextNode(node) ? node.getTextContent().slice(0, point.offset) : null;
  }
  return $isElementNode(node)
    ? node
        .getChildren()
        .slice(0, point.offset)
        .map((child) => child.getKey())
        .join(",")
    : null;
}

function $readVoiceStartPoint(point: PointType): VoiceStartPoint | null {
  const value = $readVoicePoint(point);
  const before = $readContentBefore(value);
  return before === null ? null : { ...value, before };
}

/**
 * 修复原因：只检查 offset 是否越界时，用户在开始点之前插入或删除文字后旧 offset 仍被当作有效，
 * 语音文字会插进原有文字中间（E2E：「ab前缀」变成「ab你好世界前缀」）。
 * 现在要求开始点之前的内容与记录时一致，开始点之后的改动（例如用户紧接着打字）不影响。
 */
function $isVoiceStartPointValid(point: VoiceStartPoint): boolean {
  return $isVoicePointValid(point) && $readContentBefore(point) === point.before;
}

function $isVoicePointValid(point: VoicePoint): boolean {
  const node = $getNodeByKey(point.key);
  if (point.type === "text") return $isTextNode(node) && point.offset <= node.getTextContentSize();
  return $isElementNode(node) && point.offset <= node.getChildrenSize();
}

/**
 * 修复原因：用户在首个识别结果前就开始打字时，最终文本曾插在当前光标处并把光标移到其后，
 * 打断用户正在输入的位置。这里插到录音开始时的位置（说话早于打字，顺序也正确），不移动光标。
 * 录音开始点已失效（之前的内容被改过或节点已不存在）时追加到末尾。
 */
function $insertVoiceTextKeepingCaret(node: TextNode, startPoint: VoiceStartPoint | null) {
  const selection = $getSelection();
  const caret = $isRangeSelection(selection)
    ? { anchor: $readVoicePoint(selection.anchor), focus: $readVoicePoint(selection.focus) }
    : null;
  const point = startPoint && $isVoiceStartPointValid(startPoint) ? startPoint : null;
  if (point) {
    const target = $createRangeSelection();
    target.anchor.set(point.key, point.offset, point.type);
    target.focus.set(point.key, point.offset, point.type);
    // insertNodes 内部优先使用当前选区，必须先设为当前选区，否则会插到用户光标处。
    $setSelection(target);
    target.insertNodes([node]);
  } else {
    $getRoot().selectEnd().insertNodes([node]);
  }
  if (!caret) {
    $setSelection(null);
    return;
  }
  // 插入会在开始点拆开文本节点：落在拆分点之后的光标要移到拆出的后半节点。
  const after = node.getNextSibling();
  const remap = (value: VoicePoint): VoicePoint =>
    point &&
    point.type === "text" &&
    value.type === "text" &&
    value.key === point.key &&
    value.offset > point.offset &&
    $isTextNode(after)
      ? { key: after.getKey(), offset: value.offset - point.offset, type: "text" }
      : value;
  const anchor = remap(caret.anchor);
  const focus = remap(caret.focus);
  const restored = $createRangeSelection();
  restored.anchor.set(anchor.key, anchor.offset, anchor.type);
  restored.focus.set(focus.key, focus.offset, focus.type);
  $setSelection(restored);
}

/**
 * 语音文字写入器。唯一数据源是这里记录的节点 key 和上次写入的文本。
 *
 * - 语音文字是不可合并的独立 TextNode：用户在它前面或别处输入的文字不会被并进来。
 * - 光标在语音文字末尾时继续打字，Lexical 会把字符追加进同一个节点。所以写入时只认
 *   「节点内容以上次写入的文本开头」：开头部分替换为新识别结果，用户追加的后缀原样保留。
 *   开头部分被用户改过（例如在语音文字中间编辑）就拒绝写入，保留用户版本。
 * - 普通写入把光标放到节点末尾；用户已接管输入（preserveSelection）时不移动光标，
 *   只把落在节点内的光标按新旧长度差平移，避免最终结果写入时打断用户正在输入的位置。
 * - 第一次写入单独成为一条撤销记录，之后的临时结果用 HISTORY_MERGE_TAG 并入这条记录；
 *   用户接管后的最终结果单独成为一条记录，不与用户的输入合并。
 */
function createVoiceTextWriter(editor: LexicalEditor) {
  let voice: { key: NodeKey; text: string } | null = null;
  let startPoint: VoiceStartPoint | null = null;
  /**
   * 把语音文字（节点开头的 voice.text）替换为 text，用户追加在其后的后缀原样保留。
   * 节点不存在或开头已被用户改过时返回 false，不改动编辑器。
   * preserveSelection 时把落在节点内的光标按长度差平移；否则光标放到节点末尾。
   */
  const $replaceVoicePrefix = (text: string, preserveSelection: boolean): boolean => {
    if (!voice) return false;
    const node = $getNodeByKey(voice.key);
    const current = $isTextNode(node) ? node.getTextContent() : null;
    if (!$isTextNode(node) || current === null || !current.startsWith(voice.text)) return false;
    const previousLength = voice.text.length;
    const next = text + current.slice(previousLength);
    if (!next) {
      node.remove();
      voice = null;
      return true;
    }
    const selection = $getSelection();
    const mapOffset = (offset: number) =>
      offset >= previousLength
        ? offset - previousLength + text.length
        : Math.min(offset, text.length);
    const anchor =
      $isRangeSelection(selection) && selection.anchor.key === node.getKey()
        ? mapOffset(selection.anchor.offset)
        : null;
    const focus =
      $isRangeSelection(selection) && selection.focus.key === node.getKey()
        ? mapOffset(selection.focus.offset)
        : null;
    node.setTextContent(next);
    if (!preserveSelection) node.select();
    else if ($isRangeSelection(selection)) {
      if (anchor !== null) selection.anchor.set(node.getKey(), anchor, "text");
      if (focus !== null) selection.focus.set(node.getKey(), focus, "text");
    }
    voice = { key: node.getKey(), text };
    return true;
  };
  return {
    beginVoiceText() {
      startPoint = editor.getEditorState().read(() => {
        const selection = $getSelection();
        return $isRangeSelection(selection) ? $readVoiceStartPoint(selection.anchor) : null;
      });
    },
    setVoiceText(text: string, options?: { preserveSelection?: boolean }): boolean {
      const preserveSelection = options?.preserveSelection === true;
      const tag =
        voice && !preserveSelection
          ? [PROGRAMMATIC_UPDATE_TAG, HISTORY_MERGE_TAG]
          : [PROGRAMMATIC_UPDATE_TAG];
      let accepted = true;
      editor.update(
        () => {
          if (!voice) {
            if (!text) return;
            const created = $createTextNode(text).toggleUnmergeable();
            if (preserveSelection) {
              $insertVoiceTextKeepingCaret(created, startPoint);
            } else {
              let selection = $getSelection();
              if (!$isRangeSelection(selection)) selection = $getRoot().selectEnd();
              selection.insertNodes([created]);
              created.select();
            }
            voice = { key: created.getKey(), text };
            return;
          }
          accepted = $replaceVoicePrefix(text, preserveSelection);
        },
        { tag, discrete: true },
      );
      return accepted;
    },
    endVoiceText({ remove }: { remove: boolean }) {
      if (!voice) return;
      const key = voice.key;
      editor.update(
        () => {
          // 修复原因：删除曾要求节点全文等于语音文字，用户在语音文字后追加输入（同一节点）再按
          // Escape 时整段都没删（E2E：「前缀模拟临时abc」原样保留）。现在与写入一样按前缀判断：
          // 只删语音文字、保留用户后缀和光标；前缀被用户改写时保留用户版本。
          if (remove) $replaceVoicePrefix("", true);
          // 无论是否删除，留下的节点都恢复为可合并的普通文本节点。
          const node = $getNodeByKey(key);
          if ($isTextNode(node) && node.isUnmergeable()) node.toggleUnmergeable();
          voice = null;
        },
        { tag: [PROGRAMMATIC_UPDATE_TAG, HISTORY_MERGE_TAG], discrete: true },
      );
    },
  };
}

function getPromptMentionIdAfterDomSelection(rootElement: HTMLElement): string | null {
  const selection = window.getSelection();
  if (!selection?.isCollapsed || !selection.anchorNode) {
    return null;
  }

  const anchorNode = selection.anchorNode;
  if (!rootElement.contains(anchorNode)) {
    return null;
  }

  if (anchorNode.nodeType === Node.ELEMENT_NODE) {
    const child = anchorNode.childNodes.item(selection.anchorOffset);
    return getPromptMentionIdFromBoundaryNode(child);
  }

  if (anchorNode.nodeType !== Node.TEXT_NODE) {
    return null;
  }

  if (selection.anchorOffset !== (anchorNode.textContent ?? "").length) {
    return null;
  }

  return getPromptMentionIdFromBoundaryNode(anchorNode.nextSibling);
}

function getPromptMentionIdFromBoundaryNode(node: Node | null): string | null {
  if (!(node instanceof HTMLElement) || !node.matches("[data-mention-id]")) {
    return null;
  }
  return node.dataset.mentionId ?? null;
}

function selectAfterPromptMentionById(mentionId: string): boolean {
  const mentionNode = $getRoot()
    .getAllTextNodes()
    .find(
      (node): node is PromptMentionNode =>
        $isPromptMentionNode(node) && node.getMention().id === mentionId,
    );
  if (!mentionNode) {
    return false;
  }

  const nextSibling = mentionNode.getNextSibling();
  if ($isTextNode(nextSibling)) {
    const text = nextSibling.getTextContent();
    const offset = /^\s/.test(text) ? Math.min(1, text.length) : 0;
    nextSibling.select(offset, offset);
    return true;
  }

  mentionNode.selectNext(0, 0);
  return true;
}

/**
 * 键盘行为插件：Enter 发送，Shift+Enter 换行
 *
 * 用 COMMAND_PRIORITY_HIGH 截获 Enter 按键，
 * 阻止 Lexical 默认的段落插入行为。
 */
function KeyboardPlugin({
  onSubmit,
  onModifiedSubmit,
  disabled,
  submitDisabled,
  allowSubmitWhenEmpty,
  enterSubmits,
}: {
  onSubmit: (text: string) => LexicalSubmitResult;
  onModifiedSubmit?: (text: string) => LexicalSubmitResult;
  disabled?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  // 作用域改绑层：读生效表的 composer 命令切片；ref 透传避免按键监听重挂。
  const effectiveShortcutBindings = useEffectiveShortcutBindings();
  const composerEffectiveRef = useRef({
    composerSend: effectiveShortcutBindings.composerSend ?? [],
    composerInsertNewline: effectiveShortcutBindings.composerInsertNewline ?? [],
  });
  composerEffectiveRef.current = {
    composerSend: effectiveShortcutBindings.composerSend ?? [],
    composerInsertNewline: effectiveShortcutBindings.composerInsertNewline ?? [],
  };

  useEffect(() => {
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event) return false;

        if (disabled) {
          event.preventDefault();
          return true;
        }

        // IME 正在组合中（如中文输入法），不拦截
        if (event.isComposing) {
          return false;
        }

        const text = getEditorMarkdown(editor.getEditorState());

        // 作用域改绑层：用户键位表优先于内置默认。
        // 命中换行 → 放行 Lexical 插段落；命中发送 → 走与主链等价的门禁分支；
        // 未命中 → 落到下方主链（含反转投递 / 修饰组合换行 / 视口门禁）。
        const composerEffective = composerEffectiveRef.current;
        const scopedAction = resolveComposerKeyAction(event, composerEffective);
        if (scopedAction === "newline") {
          return false;
        }
        if (scopedAction === "send") {
          const modifiedScopedEnter = event.shiftKey || event.ctrlKey || event.metaKey;
          // 反转投递开启时带修饰组合让位主链（Ctrl+Enter = 反向 delivery，交付语义比键位更具体）
          if (!(modifiedScopedEnter && onModifiedSubmit)) {
            // 与主链裸 Enter 等价的门禁：无修饰组合受 submitDisabled / 手机视口 enterSubmits；
            // 带修饰组合不受视口门禁（与主链 onModifiedSubmit 路径一致）。
            if (submitDisabled || (!modifiedScopedEnter && !enterSubmits)) {
              return false;
            }
            event.preventDefault();
            if (
              shouldSubmitLexicalEnter({
                allowSubmitWhenEmpty,
                enterSubmits: modifiedScopedEnter ? true : enterSubmits,
                text,
              })
            ) {
              const submitResult = onSubmit(text);
              if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
                resetEditor(editor);
              }
            }
            return true;
          }
        }

        // 主链前置检查：composerSend 已改绑走（生效绑定不含裸 Enter）时，
        // 裸 Enter 不再代表发送，放行 Lexical 换行（"Ctrl+Enter 党"改绑后的预期行为）。
        if (
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          shouldBareEnterFallThroughToNewline(composerEffective)
        ) {
          return false;
        }

        if (
          !submitDisabled &&
          onModifiedSubmit &&
          shouldSubmitLexicalModifiedEnter({
            allowSubmitWhenEmpty,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            modifiedEnterSubmits: true,
            shiftKey: event.shiftKey,
            text,
          })
        ) {
          event.preventDefault();
          const submitResult = onModifiedSubmit(text);
          if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
            resetEditor(editor);
          }
          return true;
        }

        // Shift+Enter，以及未启用反转投递时的 Ctrl/Meta+Enter 继续换行。
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          return false;
        }

        // 当前请求进行中时，输入框仍允许继续编辑草稿，但此时不能再次提交。
        // 之前把状态直接映射成 disabled，导致输入和联想面板一起失效；如果只去掉 disabled，
        // Enter 又会误触发 submit 并清空草稿。这里在 submitDisabled 时把 Enter 退回给 Lexical 处理换行。
        if (submitDisabled || !enterSubmits) {
          return false;
        }

        event.preventDefault();

        if (
          shouldSubmitLexicalEnter({
            allowSubmitWhenEmpty,
            enterSubmits,
            text,
          })
        ) {
          const submitResult = onSubmit(text);
          // 业务层可能拒绝本次提交并要求草稿留在输入框。
          // Enter 键盘层不能无条件 reset，否则即使业务层未发送，用户输入也会被吃掉。
          if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
            resetEditor(editor);
          }
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event: KeyboardEvent | null) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchor = selection.anchor;
        if (anchor.type !== "text") {
          return false;
        }

        const node = anchor.getNode();
        if (!$isTextNode(node)) {
          return false;
        }

        const text = node.getTextContent();
        if (anchor.offset !== 1 || text !== " ") {
          return false;
        }

        const previousSibling = node.getPreviousSibling();
        if (!$isPromptMentionNode(previousSibling)) {
          return false;
        }

        // mention 插入时会自动补一个空格用于继续输入，
        // 之前 Backspace 会先删这个空格，再删 token，用户体感是“要按两次才删掉标签”。
        // 这里在“光标正好位于补位空格后”时，直接一次性删除空格 + mention token。
        event?.preventDefault();
        previousSibling.remove();
        node.remove();
        node.getParent()?.selectEnd();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const handleRootKeyDownCapture = (event: KeyboardEvent) => {
      if (
        disabled ||
        event.key !== "ArrowRight" ||
        !event.altKey ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing
      ) {
        return;
      }

      const rootElement = editor.getRootElement();
      if (!rootElement) {
        return;
      }

      const mentionId = getPromptMentionIdAfterDomSelection(rootElement);
      if (!mentionId) {
        return;
      }

      // macOS Option+ArrowRight 会按 DOM 文本做词级跳转，之前会把光标落进
      // mention token 内部的文件名文本；下一次输入时 Lexical 会把 token 当作被替换内容删除。
      // 在 token 左边界显式把 selection 移到 token 后侧，保持 mention 的原子编辑语义。
      event.preventDefault();
      event.stopImmediatePropagation();
      editor.update(
        () => {
          selectAfterPromptMentionById(mentionId);
        },
        { tag: PROGRAMMATIC_UPDATE_TAG },
      );
    };

    // 作用域改绑层·非 Enter 分发（统一开放策略）：KEY_ENTER_COMMAND 只对 Enter
    // 派发，用户把发送/换行绑成非 Enter 键（如 F9）时由 root keydown capture 分发，
    // 否则改绑是死绑定，且裸 Enter 回退换行会让键盘发送能力整体丢失。
    // 非 Enter 物理键不存在手机软键盘误发问题，send 不受 enterSubmits 视口门禁；
    // 与反转投递（仅响应 Ctrl/Meta+Enter）无交集，无需让位。
    const handleNonEnterScopedKeydown = (event: KeyboardEvent) => {
      if (disabled || event.repeat || event.isComposing || event.key === "Enter") {
        return;
      }
      const scopedAction = resolveComposerKeyAction(event, composerEffectiveRef.current);
      if (!scopedAction) {
        return;
      }
      if (scopedAction === "newline") {
        event.preventDefault();
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertLineBreak();
          }
        });
        return;
      }
      if (submitDisabled) {
        return;
      }
      event.preventDefault();
      const text = getEditorMarkdown(editor.getEditorState());
      if (shouldSubmitLexicalEnter({ allowSubmitWhenEmpty, enterSubmits: true, text })) {
        const submitResult = onSubmit(text);
        if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
          resetEditor(editor);
        }
      }
    };

    const unregisterRootListener = editor.registerRootListener(
      (rootElement, previousRootElement) => {
        previousRootElement?.removeEventListener("keydown", handleRootKeyDownCapture, {
          capture: true,
        });
        rootElement?.addEventListener("keydown", handleRootKeyDownCapture, {
          capture: true,
        });
        previousRootElement?.removeEventListener("keydown", handleNonEnterScopedKeydown, {
          capture: true,
        });
        rootElement?.addEventListener("keydown", handleNonEnterScopedKeydown, {
          capture: true,
        });
      },
    );

    return () => {
      unregisterEnter();
      unregisterBackspace();
      unregisterRootListener();
      editor.getRootElement()?.removeEventListener("keydown", handleRootKeyDownCapture, {
        capture: true,
      });
      editor.getRootElement()?.removeEventListener("keydown", handleNonEnterScopedKeydown, {
        capture: true,
      });
    };
  }, [
    allowSubmitWhenEmpty,
    disabled,
    editor,
    enterSubmits,
    onModifiedSubmit,
    onSubmit,
    submitDisabled,
  ]);

  return null;
}

export function shouldRecordUserInputStart(tags: ReadonlySet<string>): boolean {
  return !tags.has(PROGRAMMATIC_UPDATE_TAG) && !tags.has(HISTORY_NAVIGATION_UPDATE_TAG);
}

interface TextContentPublicationState {
  lastPublishedText: string;
  pendingComposition: boolean;
}

export function resolveTextContentPublication(params: {
  composing: boolean;
  nextText: string;
  state: TextContentPublicationState;
}): { publish: string | null; state: TextContentPublicationState } {
  if (params.composing) {
    return {
      publish: null,
      state: { ...params.state, pendingComposition: true },
    };
  }
  if (params.nextText === params.state.lastPublishedText) {
    return {
      publish: null,
      state: params.state.pendingComposition
        ? { ...params.state, pendingComposition: false }
        : params.state,
    };
  }
  return {
    publish: params.nextText,
    state: { lastPublishedText: params.nextText, pendingComposition: false },
  };
}

/**
 * 文本变化插件
 *
 * 直接用 Lexical 自带的 OnChangePlugin 时，第一次从空编辑器输入字符会被内部的
 * `prevEditorState.isEmpty()` 直接跳过，父组件的 input 状态拿不到首字符，发送按钮和输入内容会错位。
 * 这里改成自己监听 update，只在序列化后的 markdown 真正变化时同步，首字符输入也能稳定回传。
 */
function TextContentPlugin({
  onChange,
  onUserInputClear,
  onUserInputPresenceChange,
  onUserInputStart,
  taskId,
}: {
  onChange?: (text: string) => void;
  onUserInputClear?: () => void;
  onUserInputPresenceChange?: (presence: UserInputPresence) => void;
  onUserInputStart?: () => void;
  taskId?: string | null;
}) {
  const [editor] = useLexicalComposerContext();
  // IME 组合态标记:不直接依赖 editor.isComposing(),因为它在 update listener 同步执行时
  // 是否已反映组合态存在时序不确定性,读不到 true 会把中文/日文长文本组合的高耗时误报成打字卡顿。
  // 改由 compositionstart/compositionend 事件自行维护,稳健可控。
  const composingRef = useRef(false);
  const compositionEndFrameRef = useRef<number | null>(null);
  const publicationRef = useRef<TextContentPublicationState | null>(null);
  if (!publicationRef.current) {
    publicationRef.current = {
      lastPublishedText: getEditorMarkdown(editor.getEditorState()),
      pendingComposition: false,
    };
  }

  const publishEditorState = useCallback(() => {
    if (!onChange || composingRef.current) return false;
    const nextText = getEditorMarkdown(editor.getEditorState());
    onUserInputPresenceChange?.({
      raw: nextText.length > 0,
      trimmed: nextText.trim().length > 0,
    });
    const publication = resolveTextContentPublication({
      composing: false,
      nextText,
      state: publicationRef.current!,
    });
    publicationRef.current = publication.state;
    if (publication.publish === null) return false;
    onChange(publication.publish);
    return true;
  }, [editor, onChange, onUserInputPresenceChange]);

  useEffect(() => {
    const startComposition = () => {
      composingRef.current = true;
      publicationRef.current = {
        ...publicationRef.current!,
        pendingComposition: true,
      };
      if (compositionEndFrameRef.current !== null) {
        cancelAnimationFrame(compositionEndFrameRef.current);
        compositionEndFrameRef.current = null;
      }
    };
    const finishComposition = () => {
      composingRef.current = false;
      if (compositionEndFrameRef.current !== null) {
        cancelAnimationFrame(compositionEndFrameRef.current);
      }
      // Chrome 在 compositionend 前已处理 input；Firefox/Safari 可能在随后处理。
      // 下一帧只作跨浏览器兜底；真实 update listener 先发布时这里会因正文相同 no-op。
      compositionEndFrameRef.current = requestAnimationFrame(() => {
        compositionEndFrameRef.current = null;
        publishEditorState();
      });
    };
    const unregisterStart = editor.registerCommand(
      COMPOSITION_START_COMMAND,
      () => {
        startComposition();
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const unregisterEnd = editor.registerCommand(
      COMPOSITION_END_COMMAND,
      () => {
        finishComposition();
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const unregisterRoot = editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("compositionstart", startComposition);
      previousRootElement?.removeEventListener("compositionend", finishComposition);
      rootElement?.addEventListener("compositionstart", startComposition);
      rootElement?.addEventListener("compositionend", finishComposition);
    });
    return () => {
      unregisterStart();
      unregisterEnd();
      unregisterRoot();
      if (compositionEndFrameRef.current !== null) {
        cancelAnimationFrame(compositionEndFrameRef.current);
        compositionEndFrameRef.current = null;
      }
    };
  }, [editor, publishEditorState]);

  useEffect(() => {
    if (!onChange) {
      return;
    }

    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState, tags }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
        return;
      }

      const userInputUpdate = shouldRecordUserInputStart(tags);
      if (userInputUpdate) onUserInputStart?.();
      // 候选正文仍留在 Lexical，但发送按钮沿用旧交互，只订阅有无正文的布尔量。
      if (composingRef.current) {
        editorState.read(() => {
          const nextText = $getRoot().getTextContent();
          onUserInputPresenceChange?.({
            raw: nextText.length > 0,
            trimmed: nextText.trim().length > 0,
          });
        });
        return;
      }
      // 输入卡顿计时：普通输入只序列化当前状态一次；IME 候选阶段完全留在 Lexical，
      // compositionend 后的最终 update 才序列化并发布给 React 草稿 owner。
      const startedAt = performance.now();
      const nextText = getEditorMarkdown(editorState);
      onUserInputPresenceChange?.({
        raw: nextText.length > 0,
        trimmed: nextText.trim().length > 0,
      });
      if (nextText.length === 0 && userInputUpdate) onUserInputClear?.();
      const publicationState = publicationRef.current!;
      const compositionCommit = publicationState.pendingComposition;
      const publication = resolveTextContentPublication({
        composing: composingRef.current,
        nextText,
        state: publicationState,
      });
      publicationRef.current = publication.state;
      if (publication.publish === null) return;

      onChange(publication.publish);

      const lagMs = performance.now() - startedAt;
      // 程序化改写与 IME 组合态不算打字卡顿(判定在 recordInputLag 内统一短路)。
      recordInputLag({
        lagMs,
        textLength: nextText.length,
        isProgrammatic: tags.has(PROGRAMMATIC_UPDATE_TAG),
        isComposing: composingRef.current || compositionCommit,
        taskId: taskId ?? undefined,
      });
    });
  }, [editor, onChange, onUserInputClear, onUserInputPresenceChange, onUserInputStart, taskId]);

  return null;
}

/** 编辑器可编辑状态控制插件 */
function EditablePlugin({ editable }: { editable: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  return null;
}

function E2ELexicalInputBridgePlugin({ inputTestId }: { inputTestId?: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!inputTestId || typeof document === "undefined") {
      return;
    }

    const bridge = {
      focus: () => editor.focus(),
      getEditorState: () => editor.getEditorState(),
      getText: () => getEditorMarkdown(editor.getEditorState()),
      setText: (text: string) => replaceEditorText(editor, text),
      setTextWithPluginMentions: (text: string) =>
        replaceEditorTextWithPluginMentions(editor, text),
      setEditorStateJson: (editorStateJson: string) =>
        replaceEditorStateJson(editor, editorStateJson),
    };

    let attachedInput: HTMLElement | null = null;
    const detachBridge = (input: HTMLElement | null) => {
      if (
        input &&
        (input as { __zcodeLexicalInputE2E?: typeof bridge }).__zcodeLexicalInputE2E === bridge
      ) {
        delete (input as { __zcodeLexicalInputE2E?: typeof bridge }).__zcodeLexicalInputE2E;
      }
      input?.removeAttribute("data-e2e-lexical-bridge");
    };
    const attachBridge = (input: HTMLElement | null) => {
      if (attachedInput && attachedInput !== input) {
        detachBridge(attachedInput);
      }
      attachedInput = input;
      if (!input) {
        return;
      }

      // E2E 需要驱动真实 Lexical state；只改 DOM contenteditable 会绕过 editor update，
      // 容易把文本误打到主输入框，导致测试结论和产品行为脱节。
      Object.defineProperty(input, "__zcodeLexicalInputE2E", {
        configurable: true,
        value: bridge,
      });
      input.setAttribute("data-e2e-lexical-bridge", "ready");
    };

    const resolveInput = (rootElement: HTMLElement | null) => {
      if (rootElement?.getAttribute("data-testid") === inputTestId) {
        return rootElement;
      }
      return document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    };

    let retryTimer: number | null = null;
    const tryAttachBridge = () => {
      const nextInput = resolveInput(editor.getRootElement());
      attachBridge(nextInput);
      if (nextInput && retryTimer !== null) {
        window.clearInterval(retryTimer);
        retryTimer = null;
      }
    };
    const unregisterRoot = editor.registerRootListener((rootElement, previousRootElement) => {
      if (previousRootElement !== rootElement) {
        detachBridge(previousRootElement);
      }
      // E2E bridge 之前只在 effect 里查询一次 DOM。
      // 编辑器 root 如果比插件晚挂载或被 Lexical 重挂载，bridge 会永久缺失。
      attachBridge(resolveInput(rootElement));
    });

    tryAttachBridge();
    // edit 场景里 ChatPromptEditor 的 initialValue 回填、Lexical root 注册、
    // React DOM 提交顺序可能跨多个帧。短轮询只负责补挂测试 bridge，不参与产品行为。
    retryTimer = window.setInterval(tryAttachBridge, 100);

    return () => {
      unregisterRoot();
      if (retryTimer !== null) {
        window.clearInterval(retryTimer);
      }
      detachBridge(attachedInput);
    };
  }, [editor, inputTestId]);

  return null;
}

function PromptHistoryPlugin({
  entries,
  disabled,
}: {
  entries: readonly string[];
  disabled?: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const historyIndexRef = useRef<number | null>(null);
  const applyingHistoryRef = useRef(false);

  useEffect(() => {
    if (historyIndexRef.current !== null && entries[historyIndexRef.current] === undefined) {
      historyIndexRef.current = null;
    }
  }, [entries]);

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
        return;
      }

      if (applyingHistoryRef.current) {
        applyingHistoryRef.current = false;
        return;
      }

      const currentIndex = historyIndexRef.current;
      if (currentIndex === null) {
        return;
      }

      if (entries[currentIndex] === undefined) {
        historyIndexRef.current = null;
        return;
      }

      if (getEditorMarkdown(editorState) !== entries[currentIndex]) {
        historyIndexRef.current = null;
      }
    });
  }, [editor, entries]);

  const applyHistoryEntry = useCallback(
    (nextIndex: number | null, nextValue: string) => {
      historyIndexRef.current = nextIndex;
      applyingHistoryRef.current = true;
      // 使用专用 HISTORY_NAVIGATION_UPDATE_TAG 而非通用 PROGRAMMATIC_UPDATE_TAG，
      // 使 SlashCommandPlugin 能区分"历史回填"与"用户正在输入 slash 查询"，
      // 防止回填含 / 的历史条目时面板重新打开并以 COMMAND_PRIORITY_CRITICAL 吞掉后续方向键。
      editor.update(
        () => {
          const root = $getRoot();
          root.clear();
          for (const line of nextValue.split("\n\n")) {
            const paragraph = $createParagraphNode();
            if (line) {
              paragraph.append($createTextNode(line));
            }
            root.append(paragraph);
          }
          root.getLastChild()?.selectEnd();
        },
        { tag: HISTORY_NAVIGATION_UPDATE_TAG },
      );
    },
    [editor],
  );

  const handleHistoryNavigation = useCallback(
    (direction: "up" | "down") => (event: KeyboardEvent | null) => {
      if (!event) return false;

      if (
        disabled ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing
      ) {
        return false;
      }

      const text = getEditorMarkdown(editor.getEditorState());
      const currentIndex = historyIndexRef.current;

      // 历史导航只在“空输入”或“已经进入历史浏览态”时接管上下键，
      // 避免抢走多行输入原本的光标移动行为。
      if (currentIndex === null && text.length > 0) {
        return false;
      }

      const result = navigatePromptHistory(entries, currentIndex, direction);
      if (!result.shouldHandle) {
        return false;
      }

      event.preventDefault();
      applyHistoryEntry(result.nextIndex, result.nextValue);
      return true;
    },
    [applyHistoryEntry, disabled, editor, entries],
  );

  useEffect(() => {
    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      handleHistoryNavigation("up"),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      handleHistoryNavigation("down"),
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterUp();
      unregisterDown();
    };
  }, [editor, handleHistoryNavigation]);

  return null;
}

function isCollapsedSelectionAtEditorStart(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return false;
  }

  const [startPoint] = selection.getStartEndPoints() ?? [];
  if (!startPoint || startPoint.offset !== 0) {
    return false;
  }

  const root = $getRoot();
  const startNode = startPoint.getNode();
  if (startPoint.type === "text") {
    const firstTextNode = root.getAllTextNodes()[0] ?? null;
    return firstTextNode?.is(startNode) ?? root.getTextContentSize() === 0;
  }

  if (startNode.is(root)) {
    return true;
  }

  const firstDescendant = root.getFirstDescendant();
  return firstDescendant?.is(startNode) ?? root.getTextContentSize() === 0;
}

function LeadingChineseSlashAliasPlugin({ disabled }: { disabled?: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (disabled) {
      return;
    }

    const handleBeforeInput = (event: InputEvent) => {
      let shouldNormalize = false;
      editor.getEditorState().read(() => {
        shouldNormalize = shouldNormalizeLeadingChineseSlashAliasInput({
          data: event.data,
          inputType: event.inputType,
          isAtEditorStart: isCollapsedSelectionAtEditorStart(),
          isComposing: event.isComposing,
        });
      });

      if (!shouldNormalize) {
        return;
      }

      // 中文输入法下用户在输入框第一位想打 `/` 唤起命令时，
      // 可能会实际输入顿号 `、`。这里只拦截真实手输且位于全文开头的顿号，
      // 立即归一成标准 `/`，避免把顿号扩散成 slash command 的另一套匹配语法。
      event.preventDefault();
      editor.update(
        () => {
          if (!isCollapsedSelectionAtEditorStart()) {
            return;
          }

          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return;
          }

          selection.insertText(STANDARD_SLASH_TRIGGER);
        },
        { tag: PROGRAMMATIC_UPDATE_TAG },
      );
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("beforeinput", handleBeforeInput as EventListener);
      rootElement?.addEventListener("beforeinput", handleBeforeInput as EventListener);
    });
  }, [disabled, editor]);

  return null;
}

function PasteCapturePlugin({
  disabled,
  onPaste,
}: {
  disabled?: boolean;
  onPaste?: (event: ChatComposerPasteEvent) => void;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!onPaste) {
      return;
    }

    const handlePaste = (event: ClipboardEvent) => {
      if (disabled) {
        return;
      }

      const wasDefaultPrevented = event.defaultPrevented;
      onPaste(event);
      if (event.defaultPrevented && !wasDefaultPrevented) {
        // 长文本已经被转成附件后，必须阻断 Lexical 后续 paste command，
        // 否则会出现“附件有了，正文也被插入”的双份内容。
        event.stopImmediatePropagation();
      }
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("paste", handlePaste, {
        capture: true,
      });
      rootElement?.addEventListener("paste", handlePaste, { capture: true });
    });
  }, [disabled, editor, onPaste]);

  return null;
}

/** 暴露 focus / clear / getText 给外部 */
export function insertEditorMention(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
  selectionState?: EditorState,
) {
  const selection = selectionState?.read(() => $getSelection()?.clone() ?? null);
  editor.update(
    () => {
      // 浮层获取焦点后 Lexical 选区会丢失，恢复打开菜单前的光标，避免覆盖整份草稿。
      // 草稿可能在菜单打开期间被替换；旧节点不存在时不能恢复选区，否则 Lexical 会抛错。
      if ($isRangeSelection(selection)) {
        if ($getNodeByKey(selection.anchor.key) && $getNodeByKey(selection.focus.key)) {
          $setSelection(selection);
        } else {
          $getRoot().selectEnd();
        }
      }
      let target = $getSelection();
      if (!$isRangeSelection(target)) target = $getRoot().selectEnd();
      const trailing = $createTextNode(" ");
      target.insertNodes([$createPromptMentionNode(mention), trailing]);
      trailing.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

function EditorApiPlugin({
  editorApiRef,
}: {
  editorApiRef?: React.MutableRefObject<LexicalChatInputHandle | null>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editorApiRef) {
      return;
    }

    const voiceText = createVoiceTextWriter(editor);
    editorApiRef.current = {
      clear: () => resetEditor(editor),
      clearHistory: () => {
        editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
      },
      focus: () => editor.focus(),
      getEditorState: () => editor.getEditorState(),
      getMarkdown: () => getEditorMarkdown(editor.getEditorState()),
      getText: () => getEditorMarkdown(editor.getEditorState()),
      appendText: (text: string) => appendEditorPlainText(editor, text),
      appendFileMention: (
        label: string,
        value: string,
        markdown: string,
        data?: MentionItemData,
        trailingText = " ",
      ) => appendEditorFileMention(editor, label, value, markdown, data, trailingText),
      beginVoiceText: voiceText.beginVoiceText,
      setVoiceText: voiceText.setVoiceText,
      endVoiceText: voiceText.endVoiceText,
      insertMention: (mention, selectionState) =>
        insertEditorMention(editor, mention, selectionState),
      prependMentionIfMissing: (mention) => prependEditorMentionIfMissing(editor, mention),
      setMention: (mention, trailingText) =>
        replaceEditorWithMention(editor, mention, trailingText),
      setText: (text: string) => replaceEditorText(editor, text),
      setTextWithPluginMentions: (text: string) =>
        replaceEditorTextWithPluginMentions(editor, text),
      setEditorStateJson: (editorStateJson: string) =>
        replaceEditorStateJson(editor, editorStateJson),
      setSkillMention: (skillName: string, markdown = `$${skillName}`, trailingText = " ") =>
        replaceEditorWithSkillMention(editor, skillName, markdown, trailingText),
      setSlashCommandMention: (
        commandName: string,
        markdown = `/${commandName}`,
        trailingText = " ",
      ) => replaceEditorWithSlashCommandMention(editor, commandName, markdown, trailingText),
    };

    return () => {
      editorApiRef.current = null;
    };
  }, [editor, editorApiRef]);

  return null;
}

interface LexicalChatInputProps {
  placeholder?: string;
  disabled?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits?: boolean;
  onSubmit: (text: string) => LexicalSubmitResult;
  onModifiedSubmit?: (text: string) => LexicalSubmitResult;
  onChange?: (text: string) => void;
  onUserInputClear?: () => void;
  onUserInputPresenceChange?: (presence: UserInputPresence) => void;
  onUserInputStart?: () => void;
  onFocus?: () => void;
  triggerPanelContainer?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  /** 仅影响 Skill 引用目录；草稿可使用 prewarm Session runtime。 */
  skillCatalogSessionId?: string | null;
  inputTestId?: string;
  editorApiRef?: React.MutableRefObject<LexicalChatInputHandle | null>;
  promptHistory?: readonly string[];
  avoidIosInputFocusZoom?: boolean;
  compactPlaceholder?: boolean;
  onWhiteboardMentionSelected?: (boardId: string) => void | Promise<void>;
  onPaste?: (event: ChatComposerPasteEvent) => void;
  excludedSlashCommandNames?: readonly string[];
  /** App 层本地斜杠命令（如 `/side`），选中即执行 UI 行为，不发送。 */
  appSlashCommands?: readonly AppSlashCommand[];
  /** mention（@/#）面板开关。v4 数据面未就绪时显式关闭，入口保留。 */
  enableMentionPanel?: boolean;
  /** 调用方额外挂在同一个 LexicalComposer 里的插件（如设计模式元素 token 同步） */
  extraPlugins?: React.ReactNode;
}

const EDITOR_THEME = {
  paragraph: "m-0",
};

export function LexicalChatInput({
  placeholder,
  disabled = false,
  submitDisabled = false,
  allowSubmitWhenEmpty = false,
  enterSubmits = true,
  onSubmit,
  onModifiedSubmit,
  onChange,
  onUserInputClear,
  onUserInputPresenceChange,
  onUserInputStart,
  onFocus,
  triggerPanelContainer,
  workspacePath,
  workspaceIdentity,
  taskId,
  skillCatalogSessionId,
  inputTestId,
  editorApiRef,
  promptHistory = [],
  avoidIosInputFocusZoom = false,
  compactPlaceholder = false,
  onWhiteboardMentionSelected,
  onPaste,
  excludedSlashCommandNames,
  appSlashCommands,
  extraPlugins,
  enableMentionPanel = true,
}: LexicalChatInputProps) {
  const inputMountedAtRef = useRef(Date.now());
  const lastReadyLogKeyRef = useRef<string | null>(null);
  const activeTaskProvider = useChatViewActiveTaskProvider(
    taskId,
    workspacePath,
    workspaceIdentity,
  );
  useEffect(() => {
    const readyLogKey = [
      workspaceIdentity ?? workspacePath,
      taskId ?? "draft",
      activeTaskProvider,
      triggerPanelContainer ? "trigger-ready" : "trigger-missing",
    ].join("|");
    if (lastReadyLogKeyRef.current === readyLogKey) {
      return;
    }
    lastReadyLogKeyRef.current = readyLogKey;

    let frameId: number | null = null;
    const logReady = () => {
      logger.info("[LexicalChatInput] 输入编辑器首帧完成", {
        durationMs: Date.now() - inputMountedAtRef.current,
        activeTaskProvider,
        disabled,
        hasPromptHistory: promptHistory.length > 0,
        submitDisabled,
        taskId,
        triggerPanelReady: Boolean(triggerPanelContainer),
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      });
    };

    // Lexical 编辑器初始化、slash/mention plugin 和外部 portal 分属不同组件。
    // 这里等浏览器下一帧再打点，才能和 composer shell 首帧、toolbar portal ready 对齐。
    if (typeof requestAnimationFrame === "function") {
      frameId = requestAnimationFrame(logReady);
    } else {
      logReady();
    }

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [
    activeTaskProvider,
    disabled,
    promptHistory.length,
    submitDisabled,
    taskId,
    triggerPanelContainer,
    workspaceIdentity,
    workspacePath,
  ]);
  const handleSubmit = useCallback(
    (text: string) => {
      const submitResult = onSubmit(text);
      requestAnimationFrame(() => {
        editorApiRef?.current?.focus();
      });
      return submitResult;
    },
    [editorApiRef, onSubmit],
  );
  // Lexical 的 ContentEditable props 是一个互斥联合类型，
  // aria-placeholder 一旦出现就要求 placeholder 同时存在。
  // 之前直接写三元 JSX，TypeScript 在合并两条分支时没有正确保留这组联动约束，导致误报缺少 placeholder。
  const contentEditableProps: React.ComponentProps<typeof ContentEditable> = placeholder
    ? {
        "aria-placeholder": placeholder,
        placeholder: (
          <div
            className={`pointer-events-none absolute left-0 top-0 ${compactPlaceholder ? "line-clamp-2" : ""} ${resolveMobileInputTextSizeClassName(
              {
                avoidIosInputFocusZoom,
              },
            )} text-foreground-subtlest`}
          >
            {placeholder}
          </div>
        ),
      }
    : {
        placeholder: null,
      };

  const contentEditable = (
    <ContentEditable
      // Bugfix: mention node 使用固定行高的 inline-flex chip，普通正文如果继承浏览器 normal line-height，
      // 在 token 后继续输入文字时会按不同 line box 计算基线；这里显式收口正文行高，并允许手机远控使用 16px 防止 iOS 聚焦放大。
      className={`min-h-10 max-h-40 overflow-y-auto ${resolveMobileInputTextSizeClassName({
        avoidIosInputFocusZoom,
      })} text-foreground outline-none`}
      data-testid={inputTestId}
      onFocus={onFocus}
      {...contentEditableProps}
    />
  );

  const initialConfig = useMemo(
    () => ({
      namespace: "ChatInput",
      theme: EDITOR_THEME,
      nodes: [PromptMentionNode],
      // LexicalComposer initialConfig 每次 render 新建会让输入区子树被记录为 props 变化；
      // 配置内容本身是静态的，固定引用能避免无关状态更新触发 composer 子树冒泡。
      onError: (error: Error) => {
        logger.error("[LexicalChatInput] editor error:", error);
      },
    }),
    [],
  );

  return (
    <div className="relative flex-1">
      <LexicalComposer initialConfig={initialConfig}>
        <div className="relative">
          <PlainTextPlugin contentEditable={contentEditable} ErrorBoundary={LexicalErrorBoundary} />
          <HistoryPlugin />
          <PromptClipboardPlugin />
          <TextContentPlugin
            onChange={onChange}
            onUserInputClear={onUserInputClear}
            onUserInputPresenceChange={onUserInputPresenceChange}
            onUserInputStart={onUserInputStart}
            taskId={taskId}
          />
          <KeyboardPlugin
            onSubmit={handleSubmit}
            onModifiedSubmit={onModifiedSubmit}
            disabled={disabled}
            submitDisabled={submitDisabled}
            allowSubmitWhenEmpty={allowSubmitWhenEmpty}
            enterSubmits={enterSubmits}
          />
          <PromptHistoryPlugin entries={promptHistory} disabled={disabled} />
          <EditablePlugin editable={!disabled} />
          <E2ELexicalInputBridgePlugin inputTestId={inputTestId} />
          <EditorApiPlugin editorApiRef={editorApiRef} />
          <LeadingChineseSlashAliasPlugin disabled={disabled} />
          <PasteCapturePlugin disabled={disabled} onPaste={onPaste} />
        </div>
        <SlashCommandPlugin
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          sessionId={skillCatalogSessionId ?? taskId}
          provider={activeTaskProvider}
          container={triggerPanelContainer}
          disabled={disabled}
          excludedCommandNames={excludedSlashCommandNames}
          appCommands={appSlashCommands}
        />
        {enableMentionPanel ? (
          <MentionPlugin
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            sessionId={skillCatalogSessionId ?? taskId}
            provider={activeTaskProvider}
            container={triggerPanelContainer}
            disabled={disabled}
            onWhiteboardMentionSelected={onWhiteboardMentionSelected}
          />
        ) : null}
        {extraPlugins}
      </LexicalComposer>
    </div>
  );
}

/** 简单的错误边界 */
function LexicalErrorBoundary({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
