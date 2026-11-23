const CJK_PUNCTUATION_RE = new RegExp("[\\u3000-\\u303f\\uff00-\\uffef]", "u");
const CJK_LETTER_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CODE_FENCE_RE = /^[\s>]*(`{3,}|~{3,})/u;
const INDENTED_CODE_RE = /^(?: {4}|\t)/u;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s/u;
const URL_START_RE = /https?:\/\/|www\./giu;
const GFM_TRAILING_PUNCTUATION = new Set(["?", "!", ".", ",", ":", "*", "_", "~"]);
const EMPHASIS_MARKERS = new Set(["*", "_", "~"]);
const WWW_PREVIOUS_CHARS = new Set(["*", "_", "~", "("]);

function isCjkBoundary(text: string, index: number): boolean {
  const char = text.charAt(index);
  if (CJK_PUNCTUATION_RE.test(char)) {
    return true;
  }
  return CJK_LETTER_RE.test(char) && index > 0 && EMPHASIS_MARKERS.has(text.charAt(index - 1));
}

function getCodeFence(line: string): { marker: string; length: number } | null {
  const sequence = CODE_FENCE_RE.exec(line)?.[1];
  return sequence ? { marker: sequence.charAt(0), length: sequence.length } : null;
}

function canStartBareUrl(text: string, start: number, isWww: boolean): boolean {
  if (start === 0) {
    return true;
  }
  const previous = text.charAt(start - 1);
  if (/\s/u.test(previous)) {
    return true;
  }
  if (isWww) {
    return (
      WWW_PREVIOUS_CHARS.has(previous) && !(previous === "(" && text.charAt(start - 2) === "]")
    );
  }
  if (/[A-Za-z0-9<"'=/]/u.test(previous)) {
    return false;
  }
  return !(previous === "(" && text.charAt(start - 2) === "]");
}

function trimGfmTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0) {
    const char = url.charAt(end - 1);
    if (GFM_TRAILING_PUNCTUATION.has(char)) {
      end--;
      continue;
    }
    if (char === ")") {
      const body = url.slice(0, end);
      const opens = body.split("(").length - 1;
      const closes = body.split(")").length - 1;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

function isInsideLinkLabel(text: string, index: number): boolean {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor++) {
    const char = text.charAt(cursor);
    if (char === "\\") {
      cursor++;
    } else if (char === "[") {
      depth++;
    } else if (char === "]" && depth > 0) {
      depth--;
    }
  }
  return depth > 0;
}

/*
 * Bugfix：GFM 裸 URL 只在 ASCII 空白或 `<` 处结束，全角标点和中文不算边界。
 * `**https://a.site**（说明` 会把收尾的 `**（说明` 吞进 URL，开头的 `**` 失去配对后按原文显示；
 * @streamdown/cjk 只能在 AST 上按中文标点切开链接，已经被吞掉的强调符恢复不了。
 * 所以在解析前按中文边界确定 URL 结尾，裁掉 GFM 规定的尾部标点后改写成 `<url>`，
 * 让强调符在解析期正常配对。只改写真正被中文边界截断的 URL，其余文本保持原样。
 *
 * Bugfix：最初只用行首最多 3 个空格的 fence 判断代码区，列表内缩进的 fence、引用块 `>` 内的 fence
 * 和 4 空格缩进代码块都被当成正文改写，代码里出现字面量 `<url>`。fence 行允许任意空白和 `>` 前缀，
 * 非列表项的 4 空格缩进行整行跳过；跨行 inline code 仍按行处理，属于已知限制。
 */
function normalizeCjkBareUrlsInText(text: string): string {
  let output = "";
  let cursor = 0;
  let scanFrom = 0;

  for (const match of text.matchAll(URL_START_RE)) {
    const start = match.index;
    if (start < scanFrom) {
      continue;
    }
    const isWww = match[0].toLowerCase() === "www.";
    if (!canStartBareUrl(text, start, isWww) || isInsideLinkLabel(text, start)) {
      continue;
    }

    let end = start + match[0].length;
    while (end < text.length && !/\s/u.test(text.charAt(end)) && text.charAt(end) !== "<") {
      if (isCjkBoundary(text, end)) {
        break;
      }
      end++;
    }
    scanFrom = end;
    if (end >= text.length || !isCjkBoundary(text, end)) {
      continue;
    }

    const url = trimGfmTrailingPunctuation(text.slice(start, end));
    if (url.length <= match[0].length || url.includes(">")) {
      continue;
    }

    output += text.slice(cursor, start);
    output += isWww ? `[${url}](http://${url})` : `<${url}>`;
    cursor = start + url.length;
  }

  return output + text.slice(cursor);
}

function normalizeCjkBareUrlsOutsideInlineCode(line: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < line.length) {
    const codeStart = line.indexOf("`", cursor);
    if (codeStart === -1) {
      output += normalizeCjkBareUrlsInText(line.slice(cursor));
      break;
    }

    output += normalizeCjkBareUrlsInText(line.slice(cursor, codeStart));

    let codeMarkerEnd = codeStart + 1;
    while (line[codeMarkerEnd] === "`") {
      codeMarkerEnd++;
    }
    const codeMarker = line.slice(codeStart, codeMarkerEnd);
    const codeEnd = line.indexOf(codeMarker, codeMarkerEnd);
    if (codeEnd === -1) {
      output += line.slice(codeStart);
      break;
    }

    output += line.slice(codeStart, codeEnd + codeMarker.length);
    cursor = codeEnd + codeMarker.length;
  }

  return output;
}

export function normalizeMarkdownCjkBareUrls(markdown: string): string {
  if (!/https?:\/\/|www\./iu.test(markdown)) {
    return markdown;
  }

  let output = "";
  let cursor = 0;
  let activeFence: { marker: string; length: number } | null = null;

  while (cursor < markdown.length) {
    const newlineIndex = markdown.indexOf("\n", cursor);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
    const line = markdown.slice(cursor, lineEnd);
    const newline = newlineIndex === -1 ? "" : "\n";
    const fence = getCodeFence(line);

    if (activeFence) {
      output += line + newline;
      if (fence && fence.marker === activeFence.marker && fence.length >= activeFence.length) {
        activeFence = null;
      }
    } else if (fence) {
      output += line + newline;
      activeFence = fence;
    } else if (INDENTED_CODE_RE.test(line) && !LIST_ITEM_RE.test(line)) {
      output += line + newline;
    } else {
      output += normalizeCjkBareUrlsOutsideInlineCode(line) + newline;
    }

    cursor = lineEnd + newline.length;
  }

  return output;
}
