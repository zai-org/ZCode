/**
 * slashCommandHelpers — 纯函数辅助工具，供 SlashCommandPlugin.tsx 使用
 */
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import type { AgentSummary, Locale, SkillSummary, ZCodeSlashCommand } from "@zcode/shared";
import type { MentionItem } from "@/mentions/mentionTypes.js";
import { mapSubagentsToMentionItemsForTest } from "@/mentions/providers/subagentsMentionProvider.js";
import { mapSkillsToMentionItemsForTest } from "@/mentions/providers/skillsMentionProvider.js";
import {
  extractActivePromptInputTrigger,
  getActivePromptInputTokenTailLength,
} from "./lib/promptInputTriggers.js";
import type { PromptInputSuggestionItem } from "./lib/promptInputTriggers.js";

export interface SlashCommandPluginProps {
  container?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 已有 Session 的 id；null/undefined 表示新建草稿，决定 Skill catalog authority。 */
  sessionId?: string | null;
  disabled?: boolean;
  excludedCommandNames?: readonly string[];
  /**
   * App 层本地命令（如 `/side`）。命令目录仍以 CLI catalog 为权威；这里只允许渲染层
   * 追加"选中即执行 UI 行为"的命令，不参与发送，也不写回 CLI 命令列表。
   */
  appCommands?: readonly AppSlashCommand[];
}

/** App 层斜杠命令：选中即执行 UI 行为（不插入 mention、不发送）。 */
export interface AppSlashCommand {
  /** 命令值（不含 `/`），如 "side"。 */
  value: string;
  /** 本地化操作名称；省略时保留斜杠命令形式。 */
  label?: string;
  /** 本地化描述，直接展示在 `/` 面板。 */
  description: string;
  /** 额外搜索关键词；应同时包含中英文别名，保证两种输入习惯都能搜到。 */
  keywords?: readonly string[];
  /** 选中命令后立即执行的 UI 行为。 */
  recovery?: boolean;
  run: () => void | Promise<boolean>;
}

const APP_SLASH_SUGGESTION_ID_PREFIX = "app-slash:";

export function buildAppSlashCommandSuggestions(
  commands: readonly AppSlashCommand[],
): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.value);
    if (!value) {
      return [];
    }
    return [
      {
        id: `${APP_SLASH_SUGGESTION_ID_PREFIX}${value}`,
        trigger: "/",
        value,
        label: command.label ?? `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.description, ...(command.keywords ?? [])])],
      },
    ];
  });
}

export function isAppSlashCommandSuggestion(suggestion: PromptInputSuggestionItem): boolean {
  return suggestion.id.startsWith(APP_SLASH_SUGGESTION_ID_PREFIX);
}

/**
 * `/side` 门禁：草稿态没有父 session 可挂 child，辅助对话自身不允许再开辅助对话，
 * 只读与手机 viewport 与固定入口保持一致地隐藏。
 */
export function shouldOfferSideSlashCommand(options: {
  isDraft: boolean;
  selectionSideChat: boolean;
  readOnly: boolean;
  isMobileViewport: boolean;
}): boolean {
  return (
    !options.isDraft && !options.selectionSideChat && !options.readOnly && !options.isMobileViewport
  );
}

export function normalizeSlashCommandValue(name: string): string {
  // ZCode Agent 在远端可能直接返回 "/init" 作为命令名。
  // UI 的 value 需要去掉前导斜杠，否则插入 markdown 时会变成 "//init"，并影响 / 面板匹配。
  return name.trim().replace(/^\/+/, "");
}

export function buildSlashSuggestions(commands: ZCodeSlashCommand[]): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.name);
    // Plan 是 Composer 本地操作。旧 Agent 仍可能广播同名命令，不能让它重新
    // 变成插入文本、等到发送时才切模式的旧入口；其余命令仍以 CLI catalog 为准。
    if (!value || value.toLowerCase() === "plan") {
      return [];
    }
    return [
      {
        id: `slash:${value}`,
        trigger: "/",
        value,
        label: command.inputHint?.trim() || `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.name, command.description, command.inputHint ?? ""])],
      },
    ];
  });
}

export function buildSubagentSuggestions(
  agents: Array<
    Pick<
      AgentSummary,
      "id" | "name" | "description" | "path" | "scope" | "source" | "enabled" | "modelSelection"
    >
  >,
): PromptInputSuggestionItem[] {
  return mapSubagentsToMentionItemsForTest(agents).map((item) =>
    mapSubagentMentionItemToSuggestion(item),
  );
}

export function buildSkillSuggestions(
  skills: Array<
    Pick<SkillSummary, "id" | "name" | "description" | "path" | "scope" | "pluginName">
  >,
  locale?: Locale,
): PromptInputSuggestionItem[] {
  return mapSkillsToMentionItemsForTest(skills, locale).map((item) => ({
    id: item.id,
    trigger: "/",
    value: item.value,
    label: `$${item.value}`,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "skill", "skills", item.value])],
    data: item.data,
  }));
}

function mapSubagentMentionItemToSuggestion(item: MentionItem): PromptInputSuggestionItem {
  return {
    id: item.id,
    trigger: "/",
    value: item.value,
    label: item.label,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "subagent", "agent"])],
    data: item.data,
  };
}

export function replaceActiveSlashToken(
  textBeforeCursor: string,
  textAfterCursor: string,
  replacementToken: string,
) {
  const activeTrigger = extractActivePromptInputTrigger(textBeforeCursor);
  if (!activeTrigger || activeTrigger.trigger !== "/") {
    return null;
  }

  const tokenStart = textBeforeCursor.length - activeTrigger.query.length - 1;
  const tailLength = getActivePromptInputTokenTailLength(
    activeTrigger,
    textAfterCursor,
    replacementToken,
  );
  const prefix = textBeforeCursor.slice(0, tokenStart);
  const suffix = textAfterCursor.slice(tailLength);
  return {
    cursorOffset: prefix.length + replacementToken.length + 1,
    text: `${prefix}${replacementToken} ${suffix}`,
  };
}

export function getTextAroundCursor() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }

  const anchor = selection.anchor;
  if (anchor.type !== "text") {
    return {
      textAfterCursor: "",
      textBeforeCursor: $getRoot().getTextContent(),
    };
  }

  const node = anchor.getNode();
  if (!$isTextNode(node)) {
    return null;
  }

  const textContent = node.getTextContent();
  return {
    textAfterCursor: textContent.slice(anchor.offset),
    textBeforeCursor: textContent.slice(0, anchor.offset),
  };
}
