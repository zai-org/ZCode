import { levenshteinDistance } from "./levenshtein.js";

type EditMatchStrategy =
  | "exact"
  | "quote_normalized"
  | "line_number_prefix_stripped"
  | "escape_normalized"
  | "unicode_escape_normalized"
  | "line_trimmed"
  | "indentation_flexible"
  | "block_anchor";

type EditMatchResult =
  | {
      status: "matched";
      actualString: string;
      strategy: EditMatchStrategy;
      candidateCount: number;
    }
  | {
      status: "ambiguous";
      strategy: EditMatchStrategy;
      candidateCount: number;
    }
  | { status: "not_found" };

const BROAD_MATCHERS = new Set<EditMatchStrategy>([
  "line_trimmed",
  "indentation_flexible",
  "block_anchor",
]);
const BLOCK_ANCHOR_MIN_SIMILARITY = 0.8;
const LEFT_SINGLE_CURLY_QUOTE = "‘";
const RIGHT_SINGLE_CURLY_QUOTE = "’";
const LEFT_DOUBLE_CURLY_QUOTE = "“";
const RIGHT_DOUBLE_CURLY_QUOTE = "”";

interface Candidate {
  value: string;
  index: number;
}

export function findEditMatch(input: {
  content: string;
  search: string;
  replaceAll: boolean;
}): EditMatchResult {
  const exact = collectExactCandidates(input.content, input.search);
  if (exact.length > 0) {
    return toMatchResult("exact", exact);
  }

  const strategies: EditMatchStrategy[] = [
    "quote_normalized",
    "line_number_prefix_stripped",
    "escape_normalized",
    "unicode_escape_normalized",
    "line_trimmed",
    "indentation_flexible",
    "block_anchor",
  ];

  for (const strategy of strategies) {
    if (input.replaceAll && BROAD_MATCHERS.has(strategy)) continue;
    const candidates = collectCandidates(strategy, input.content, input.search);
    if (candidates.length === 0) continue;
    return toMatchResult(strategy, candidates);
  }

  return { status: "not_found" };
}

export function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

export function normalizeReplacementForMatch(
  strategy: EditMatchStrategy,
  newString: string,
): string {
  return strategy === "escape_normalized" ? unescapeVisibleCharacters(newString) : newString;
}

export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) {
    return newString;
  }

  let result = newString;
  if (
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  ) {
    result = applyCurlyDoubleQuotes(result);
  }
  if (
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)
  ) {
    result = applyCurlySingleQuotes(result);
  }
  return result;
}

function collectCandidates(
  strategy: EditMatchStrategy,
  content: string,
  search: string,
): Candidate[] {
  switch (strategy) {
    case "exact":
      return collectExactCandidates(content, search);
    case "quote_normalized":
      return collectQuoteNormalizedCandidates(content, search);
    case "line_number_prefix_stripped":
      return collectLineNumberPrefixCandidates(content, search);
    case "escape_normalized":
      return collectEscapeNormalizedCandidates(content, search);
    case "unicode_escape_normalized":
      return collectUnicodeEscapeNormalizedCandidates(content, search);
    case "line_trimmed":
      return collectLineTrimmedCandidates(content, search);
    case "indentation_flexible":
      return collectIndentationFlexibleCandidates(content, search);
    case "block_anchor":
      return collectBlockAnchorCandidates(content, search);
  }
}

function toMatchResult(strategy: EditMatchStrategy, candidates: Candidate[]): EditMatchResult {
  const uniqueValues = [...new Set(candidates.map((candidate) => candidate.value))];
  if (uniqueValues.length !== 1) {
    return { status: "ambiguous", strategy, candidateCount: candidates.length };
  }

  return {
    status: "matched",
    actualString: uniqueValues[0] ?? "",
    strategy,
    candidateCount: candidates.length,
  };
}

function collectExactCandidates(content: string, search: string): Candidate[] {
  return collectSubstringCandidates(content, search);
}

function collectQuoteNormalizedCandidates(content: string, search: string): Candidate[] {
  return collectNormalizedCandidates(content, search, normalizeQuotes);
}

function collectLineNumberPrefixCandidates(content: string, search: string): Candidate[] {
  const stripped = stripReadLineNumberPrefixes(search);
  if (stripped === null || stripped === search) return [];
  return collectSubstringCandidates(content, stripped);
}

function collectEscapeNormalizedCandidates(content: string, search: string): Candidate[] {
  const unescaped = unescapeVisibleCharacters(search);
  if (unescaped === search) return [];
  return collectSubstringCandidates(content, unescaped);
}

function collectUnicodeEscapeNormalizedCandidates(content: string, search: string): Candidate[] {
  const unescaped = unescapeUnicodeCharacters(search);
  if (unescaped === search) return [];

  // Unicode 转义回退允许 old_string 里的 \uXXXX 匹配文件中的真实字符。
  // 这里直接返回文件中的真实片段，后续 replacement 会按真实片段写入。
  return collectSubstringCandidates(content, unescaped);
}

function collectLineTrimmedCandidates(content: string, search: string): Candidate[] {
  const contentLines = content.split("\n");
  const searchLines = trimTrailingEmptyLine(search.split("\n"));
  if (searchLines.length === 0) return [];

  const candidates: Candidate[] = [];
  for (let index = 0; index <= contentLines.length - searchLines.length; index += 1) {
    const block = contentLines.slice(index, index + searchLines.length);
    if (!block.every((line, offset) => line.trim() === searchLines[offset]!.trim())) continue;
    candidates.push(blockCandidate(contentLines, index, searchLines.length));
  }
  return candidates;
}

function collectIndentationFlexibleCandidates(content: string, search: string): Candidate[] {
  const contentLines = content.split("\n");
  const searchLines = trimTrailingEmptyLine(search.split("\n"));
  if (searchLines.length < 2) return [];

  const normalizedSearch = removeCommonIndent(searchLines);
  const candidates: Candidate[] = [];
  for (let index = 0; index <= contentLines.length - searchLines.length; index += 1) {
    const block = contentLines.slice(index, index + searchLines.length);
    if (removeCommonIndent(block) !== normalizedSearch) continue;
    candidates.push(blockCandidate(contentLines, index, searchLines.length));
  }
  return candidates;
}

function collectBlockAnchorCandidates(content: string, search: string): Candidate[] {
  const contentLines = content.split("\n");
  const searchLines = trimTrailingEmptyLine(search.split("\n"));
  if (searchLines.length < 3) return [];

  const first = searchLines[0]!.trim();
  const last = searchLines[searchLines.length - 1]!.trim();
  const candidates: Candidate[] = [];
  for (let index = 0; index <= contentLines.length - searchLines.length; index += 1) {
    const block = contentLines.slice(index, index + searchLines.length);
    if (block[0]!.trim() !== first) continue;
    if (block[block.length - 1]!.trim() !== last) continue;
    if (averageMiddleSimilarity(block, searchLines) < BLOCK_ANCHOR_MIN_SIMILARITY) continue;
    candidates.push(blockCandidate(contentLines, index, searchLines.length));
  }
  return candidates;
}

function collectSubstringCandidates(content: string, search: string): Candidate[] {
  if (search.length === 0) return [];
  const candidates: Candidate[] = [];
  let position = 0;
  while (position <= content.length) {
    const index = content.indexOf(search, position);
    if (index === -1) break;
    candidates.push({ value: search, index });
    position = index + Math.max(search.length, 1);
  }
  return candidates;
}

function collectNormalizedCandidates(
  content: string,
  search: string,
  normalize: (value: string) => string,
): Candidate[] {
  const normalizedContent = normalize(content);
  const normalizedSearch = normalize(search);
  const candidates: Candidate[] = [];
  let position = 0;
  while (position <= normalizedContent.length) {
    const index = normalizedContent.indexOf(normalizedSearch, position);
    if (index === -1) break;
    candidates.push({ value: content.slice(index, index + search.length), index });
    position = index + Math.max(normalizedSearch.length, 1);
  }
  return candidates;
}

export function stripReadLineNumberPrefixes(search: string): string | null {
  const lines = search.split("\n");
  const stripped = lines.map((line) => {
    const colonMatch = line.match(/^\d+: (.*)$/);
    if (colonMatch) return colonMatch[1] ?? "";
    const tabMatch = line.match(/^\d+\t(.*)$/);
    if (tabMatch) return tabMatch[1] ?? "";
    return null;
  });
  return stripped.every((line): line is string => line !== null) ? stripped.join("\n") : null;
}

function unescapeVisibleCharacters(search: string): string {
  return search.replace(/\\([ntr"'`\\$])/g, (match, token: string) => {
    switch (token) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
      case "'":
      case "`":
      case "\\":
      case "$":
        return token;
      default:
        return match;
    }
  });
}

function unescapeUnicodeCharacters(search: string): string {
  return search.replace(/(\\\\)|\\u([0-9a-fA-F]{4})/g, (match, escapedBackslash, hex: string) => {
    if (escapedBackslash !== undefined) return match;
    return String.fromCharCode(Number.parseInt(hex, 16));
  });
}

function blockCandidate(lines: string[], startLine: number, lineCount: number): Candidate {
  const index = offsetForLine(lines, startLine);
  return {
    value: lines.slice(startLine, startLine + lineCount).join("\n"),
    index,
  };
}

function offsetForLine(lines: string[], lineIndex: number): number {
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    offset += lines[index]!.length + 1;
  }
  return offset;
}

function trimTrailingEmptyLine(lines: string[]): string[] {
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}

function removeCommonIndent(lines: string[]): string {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return lines.join("\n");
  const minIndent = Math.min(...nonEmpty.map((line) => line.match(/^[\t ]*/)?.[0].length ?? 0));
  return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n");
}

function averageMiddleSimilarity(actual: string[], expected: string[]): number {
  if (actual.length <= 2) return 1;
  let total = 0;
  let count = 0;
  for (let index = 1; index < actual.length - 1; index += 1) {
    total += lineSimilarity(actual[index]!.trim(), expected[index]!.trim());
    count += 1;
  }
  return count === 0 ? 1 : total / count;
}

function lineSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 1;
  return 1 - levenshteinDistance(left, right) / maxLength;
}

function normalizeQuotes(value: string): string {
  return value
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

function applyCurlyDoubleQuotes(value: string): string {
  return [...value]
    .map((char, index, chars) => {
      if (char !== '"') return char;
      return isOpeningQuoteContext(chars, index)
        ? LEFT_DOUBLE_CURLY_QUOTE
        : RIGHT_DOUBLE_CURLY_QUOTE;
    })
    .join("");
}

function applyCurlySingleQuotes(value: string): string {
  return [...value]
    .map((char, index, chars) => {
      if (char !== "'") return char;
      const previous = chars[index - 1];
      const next = chars[index + 1];
      if (isLetter(previous) && isLetter(next)) {
        return RIGHT_SINGLE_CURLY_QUOTE;
      }
      return isOpeningQuoteContext(chars, index)
        ? LEFT_SINGLE_CURLY_QUOTE
        : RIGHT_SINGLE_CURLY_QUOTE;
    })
    .join("");
}

function isOpeningQuoteContext(chars: string[], index: number): boolean {
  if (index === 0) return true;
  const previous = chars[index - 1];
  return (
    previous === " " ||
    previous === "\t" ||
    previous === "\n" ||
    previous === "\r" ||
    previous === "(" ||
    previous === "[" ||
    previous === "{" ||
    previous === "—" ||
    previous === "–"
  );
}

function isLetter(value: string | undefined): boolean {
  return value !== undefined && /\p{L}/u.test(value);
}
