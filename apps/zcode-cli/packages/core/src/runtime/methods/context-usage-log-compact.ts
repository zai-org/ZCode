const CONTEXT_USAGE_TOP_CONTRIBUTOR_LIMIT = 5;

export function compactContextUsageSnapshot(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tokenMethod: snapshot.tokenMethod,
    confidence: snapshot.confidence,
    tokenizer: snapshot.tokenizer,
    totalChars: snapshot.totalChars,
    totalTokens: snapshot.totalTokens,
    model: snapshot.model,
    categories: snapshot.categories,
    categoryBreakdown: compactCategoryBreakdown(snapshot.categoryBreakdown),
    messageBreakdown: snapshot.messageBreakdown,
    compositionCategories: compactCompositionCategories(snapshot.composition),
    mcpToolCount: arrayLength(snapshot.mcpTools),
    skillCount: arrayLength(snapshot.skills),
    systemPromptSectionCount: arrayLength(snapshot.systemPromptSections),
    systemToolCount: arrayLength(snapshot.systemTools),
    warningCount: arrayLength(snapshot.warnings),
  };
}

/** 细类别只记 id、大小与条目数，不记条目名，控制 debug 日志体积。 */
function compactCompositionCategories(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!isRecord(value) || !Array.isArray(value.categories)) return undefined;
  return value.categories
    .filter(isRecord)
    .filter((category) => typeof category.tokens === "number" && category.tokens > 0)
    .map((category) => ({
      id: category.id,
      chars: category.chars,
      tokens: category.tokens,
      itemCount: arrayLength(category.items),
    }));
}

function compactCategoryBreakdown(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(isRecord).map((category) => {
    const contributors = Array.isArray(category.contributors)
      ? category.contributors.filter(isRecord)
      : [];
    return {
      ...pickDefined(category, [
        "chars",
        "confidence",
        "name",
        "percentTokens",
        "source",
        "tokenMethod",
        "tokens",
        "tokenizer",
      ]),
      contributorCount: contributors.length,
      contributors: contributors
        .toSorted((left, right) => contributorSortValue(right) - contributorSortValue(left))
        .slice(0, CONTEXT_USAGE_TOP_CONTRIBUTOR_LIMIT)
        .map(compactContextUsageContributor),
    };
  });
}

function compactContextUsageContributor(
  contributor: Record<string, unknown>,
): Record<string, unknown> {
  return pickDefined(contributor, [
    "cacheHint",
    "categorySource",
    "chars",
    "confidence",
    "count",
    "injectionTarget",
    "kind",
    "label",
    "name",
    "path",
    "readOnly",
    "role",
    "scope",
    "serverName",
    "sideEffectScope",
    "source",
    "tokenMethod",
    "tokens",
    "tokenizer",
  ]);
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

function contributorSortValue(contributor: Record<string, unknown>): number {
  const tokens = contributor.tokens;
  if (typeof tokens === "number" && Number.isFinite(tokens)) {
    return tokens;
  }
  const chars = contributor.chars;
  if (typeof chars === "number" && Number.isFinite(chars)) {
    return chars;
  }
  const count = contributor.count;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
