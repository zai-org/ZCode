import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $nodesOfType,
  HISTORY_MERGE_TAG,
  type EditorState,
  type TextNode,
} from "lexical";
import { HISTORY_NAVIGATION_UPDATE_TAG, PROGRAMMATIC_UPDATE_TAG } from "@/lib/editorUpdateTags.js";
import { buildElementMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { $createPromptMentionNode, PromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";

// 设计模式点选的元素在输入框正文里是元素 token（docs/browser-use/2026-11-03-browser-design-mode-spec.md 第四节），
// 像 Skill / Goal 一样能在前后穿插文字。引用列表（useWebElementContexts）是唯一来源，这里只做两个方向的同步：
// 列表多了 → 在正文末尾插入 token、光标落到它后面；列表少了 → 删掉对应 token；用户在正文里删掉 token → 通知调用方移除这条引用；
// 撤销等把已移除引用的 token 带回正文 → 直接去掉（引用的截图和页面信息已经丢了，不能留一个空壳 token 发出去）。

export interface ElementMention {
  id: string;
  label: string;
}

// 按显示宽度截断：中日韩等宽字算 2，其余算 1，约 10 个汉字 / 20 个字母
const LABEL_WIDTH = 20;
const WIDE_CHAR =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

function elementMentionLabel(label: string) {
  const chars = [...label.replace(/\s+/gu, " ").trim()];
  let width = 0;
  for (let index = 0; index < chars.length; index += 1) {
    width += WIDE_CHAR.test(chars[index]!) ? 2 : 1;
    if (width > LABEL_WIDTH) return `${chars.slice(0, index).join("").trimEnd()}…`;
  }
  return chars.join("");
}

/** 删 token 时连同插入时跟在它后面的那个空格一起删，免得正文里留下前导空格 */
function $removeElementMention(node: PromptMentionNode) {
  const next = node.getNextSibling();
  if ($isTextNode(next)) {
    const text = next.getTextContent();
    if (text === " ") next.remove();
    else if (text.startsWith(" ")) next.setTextContent(text.slice(1));
  }
  node.remove();
}

function readElementMentionIds(state: EditorState): Set<string> {
  return state.read(
    () =>
      new Set(
        $nodesOfType(PromptMentionNode)
          .filter((node) => node.__category === "elements")
          .map((node) => node.__mentionId),
      ),
  );
}

export function ElementMentionSyncPlugin({
  mentions,
  onRemovedByUser,
}: {
  mentions: readonly ElementMention[];
  /** 用户在正文里删掉了 token（程序化清空、发送后清空、历史回填不算） */
  onRemovedByUser: (ids: string[]) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions;
  const onRemovedRef = useRef(onRemovedByUser);
  onRemovedRef.current = onRemovedByUser;

  // 引用列表 → 正文
  useEffect(() => {
    editor.update(
      () => {
        const wanted = new Map(mentions.map((mention) => [mention.id, mention]));
        const present = new Set<string>();
        for (const node of $nodesOfType(PromptMentionNode)) {
          if (node.__category !== "elements") continue;
          if (wanted.has(node.__mentionId)) present.add(node.__mentionId);
          else $removeElementMention(node);
        }
        const missing = mentions.filter((mention) => !present.has(mention.id));
        if (missing.length === 0) return;
        const root = $getRoot();
        // 正文没有字（只剩空行 / 空格）时从头放，免得 token 被前面的空段落顶到第二行
        if (present.size === 0 && root.getTextContent().trim() === "") root.clear();
        const last = root.getLastChild();
        const paragraph = $isElementNode(last) ? last : $createParagraphNode();
        if (paragraph !== last) root.append(paragraph);
        let trailing: TextNode | null = null;
        for (const mention of missing) {
          const label = elementMentionLabel(mention.label);
          trailing = $createTextNode(" ");
          paragraph.append(
            $createPromptMentionNode({
              id: mention.id,
              category: "elements",
              label,
              value: mention.id,
              markdown: buildElementMentionMarkdown(label, mention.id),
            }),
            trailing,
          );
        }
        // 光标落在新 token 后面，接着打字就是在描述这个元素
        trailing?.select();
      },
      { tag: PROGRAMMATIC_UPDATE_TAG },
    );
  }, [editor, mentions]);

  // 正文 → 引用列表：只认用户自己的编辑
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState, prevEditorState, tags }) => {
        if (tags.has(PROGRAMMATIC_UPDATE_TAG)) return;
        const after = readElementMentionIds(editorState);
        const known = new Set(mentionsRef.current.map((mention) => mention.id));
        const orphans = [...after].filter((id) => !known.has(id));
        if (orphans.length > 0) {
          // 合进触发它的那一步历史，免得再按一次撤销又把空壳 token 带回来
          editor.update(
            () => {
              for (const node of $nodesOfType(PromptMentionNode)) {
                if (node.__category === "elements" && orphans.includes(node.__mentionId)) {
                  $removeElementMention(node);
                }
              }
            },
            { tag: [PROGRAMMATIC_UPDATE_TAG, HISTORY_MERGE_TAG] },
          );
        }
        if (tags.has(HISTORY_NAVIGATION_UPDATE_TAG)) return;
        const before = readElementMentionIds(prevEditorState);
        const removed = [...before].filter((id) => !after.has(id) && known.has(id));
        if (removed.length > 0) onRemovedRef.current(removed);
      }),
    [editor],
  );

  return null;
}
