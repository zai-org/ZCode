import type { MentionItem } from "@/mentions/mentionTypes.js";

/**
 * Safety-net cap for virtualized display. Large enough to never feel
 * "incomplete" to users, small enough to keep fuzzy-sort and virtualizer
 * memory in check for enormous monorepos.
 */
const MENTION_DISPLAY_CAP = 1000;
export const MENTION_DEFAULT_GROUP_PREVIEW_LIMIT = 3;
export const MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT = 10;

export function hasMentionQuery(query: string): boolean {
  return query.trim().length > 0;
}

export function getMentionGroupLimitForQuery(
  query: string,
  defaultLimit = MENTION_DEFAULT_GROUP_PREVIEW_LIMIT,
): number | undefined {
  return hasMentionQuery(query) ? undefined : defaultLimit;
}

interface FilterMentionItemsOptions {
  limit?: number;
  requireQuery?: boolean;
}

export interface MentionResultGroup<TItem = MentionItem> {
  id: string;
  title: string;
  items: TItem[];
  loading: boolean;
  errorText: string | null;
  emptyText: string;
  /** 只有这一组可见时也显示组名（插件 composer.mention 的分组靠组名说明来源）。 */
  showHeader?: boolean;
  /**
   * 组内一行弱提示（插件分组的查询失败、扩展已停止）：不用错误行的红底，不影响别的组。
   * DESIGN.md「Extension slots」：插件相关的状态只用文字说明，不用 destructive 填充。
   */
  noticeText?: string | null;
}

export function buildVisibleMentionGroups<TItem>(
  groups: MentionResultGroup<TItem>[],
): MentionResultGroup<TItem>[] {
  return groups.filter(
    (group) =>
      group.loading ||
      group.errorText !== null ||
      Boolean(group.noticeText) ||
      group.items.length > 0,
  );
}

// 中文查询只走前缀/子串两级：逐字符子序列匹配对 CJK 过宽（「浏器」会命中「浏览器操作」），
// 中文用户的预期是连续子串命中；英文 query 保持子序列级不变。
const HAN_QUERY_RE = /\p{Script=Han}/u;

function scoreFuzzyMatch(text: string, query: string): number | null {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedText) {
    return null;
  }

  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  if (HAN_QUERY_RE.test(normalizedQuery)) {
    return null;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

function sortScoredItems<T>(
  items: T[],
  getScore: (item: T) => number | null,
  getLabel: (item: T) => string,
): T[] {
  return items
    .map((item, index) => {
      const score = getScore(item);
      if (score === null) {
        return null;
      }

      return { index, item, score };
    })
    .filter(
      (
        item,
      ): item is {
        index: number;
        item: T;
        score: number;
      } => item !== null,
    )
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      if (left.index !== right.index) {
        return left.index - right.index;
      }

      return getLabel(left.item).localeCompare(getLabel(right.item));
    })
    .map((item) => item.item);
}

export function filterMentionItems(items: MentionItem[], query: string): MentionItem[] {
  return filterMentionItemsWithOptions(items, query);
}

function applyMentionItemLimit(items: MentionItem[], limit?: number): MentionItem[] {
  if (!Number.isFinite(limit)) {
    return items;
  }

  const safeLimit = Math.max(0, Math.trunc(limit ?? 0));
  return items.slice(0, safeLimit);
}

function getDefaultMentionItemPriority(item: MentionItem): number {
  if (item.category !== "files") {
    return 0;
  }
  return item.data?.kind === "directory" ? 1 : 0;
}

function sortDefaultMentionItems(items: MentionItem[]): MentionItem[] {
  return items
    .map((item, index) => ({ index, item, priority: getDefaultMentionItemPriority(item) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ item }) => item);
}

export function filterMentionItemsWithOptions(
  items: MentionItem[],
  query: string,
  options: FilterMentionItemsOptions = {},
): MentionItem[] {
  const effectiveLimit = options.limit ?? MENTION_DISPLAY_CAP;
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    // `@` 面板一打开就会进入这里。之前空 query 直接返回全量文件，
    // 大工作区会瞬间渲染成千上万条 option，随后上下键每切一次都要让整棵列表参与更新，体感就会非常卡。
    // 这里支持按需要求”必须先输入 query 才展示结果”，并保留结果上限，避免再次把大列表打进渲染层。
    return options.requireQuery
      ? []
      : applyMentionItemLimit(sortDefaultMentionItems(items), effectiveLimit);
  }

  return applyMentionItemLimit(
    sortScoredItems(
      items,
      (item) => {
        const labelScore = scoreFuzzyMatch(item.label, normalizedQuery);
        // 插件长描述仅展示，避免子序列匹配把无关候选带入搜索（plugin-reference-mention）。
        const descriptionScore =
          item.category === "plugins" ? null : scoreFuzzyMatch(item.description, normalizedQuery);
        const valueScore = scoreFuzzyMatch(item.value, normalizedQuery);
        const keywordScore = Math.min(
          ...(item.keywords ?? []).map((keyword) => {
            const score = scoreFuzzyMatch(keyword, normalizedQuery);
            return score === null ? Number.POSITIVE_INFINITY : score + 300;
          }),
          Number.POSITIVE_INFINITY,
        );
        const bestScore = Math.min(
          labelScore ?? Number.POSITIVE_INFINITY,
          valueScore !== null ? valueScore + 25 : Number.POSITIVE_INFINITY,
          descriptionScore !== null ? descriptionScore + 100 : Number.POSITIVE_INFINITY,
          keywordScore,
        );

        return Number.isFinite(bestScore) ? bestScore : null;
      },
      (item) => item.label,
    ),
    effectiveLimit,
  );
}
