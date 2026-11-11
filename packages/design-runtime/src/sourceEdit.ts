import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import type { DesignSourcePath } from "./contract.js";

// 属性面板写回源码（docs/browser-use/2026-11-03-browser-design-mode-spec.md 第五节）。只在宿主侧用，不进页面。
// 只改目标元素开始标签里的 style 属性、只含文字的元素的文字、或 :root 里一条 CSS 变量声明的值，文件其余字节原样保留。
// 找不到或对不上就返回 null，调用方不写：宁可不写，也不能写到另一个元素上。

type ParsedNode = DefaultTreeAdapterMap["node"];
type ParsedElement = DefaultTreeAdapterMap["element"];

interface SourceRange {
  start: number;
  end: number;
}

export interface SourceElementLocation {
  /** 开始标签的范围 */
  startTag: SourceRange;
  /** 整个 style 属性（`style="…"`）的范围与解码后的值；没有这个属性为 null */
  style: (SourceRange & { value: string }) | null;
  /** 元素只含文字时，开始标签与结束标签之间的范围与解码后的文字；含子元素、没有结束标签或是原始文本元素时为 null */
  text: (SourceRange & { value: string }) | null;
}

/** 这些元素的内容不是普通文字，不替换 */
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title", "noscript", "template"]);

const isElement = (node: ParsedNode): node is ParsedElement => "tagName" in node;

function elementChildren(node: ParsedNode): ParsedElement[] {
  return "childNodes" in node ? node.childNodes.filter(isElement) : [];
}

function attribute(element: ParsedElement, name: string): string | null {
  return element.attrs.find((attr) => attr.name === name)?.value ?? null;
}

/**
 * 沿页面给的路径在源码里找元素：每一级标签相同、父元素的元素子节点个数相同，最后一级 id / class 相同才算找到。
 * 兄弟数对不上说明页面脚本增删过节点，这时按序号找到的可能是另一个元素，直接放弃。
 */
export function locateSourceElement(
  source: string,
  path: DesignSourcePath,
): SourceElementLocation | null {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const root = elementChildren(document)[0];
  if (!root || root.tagName !== "html") return null;
  let current: ParsedElement = root;
  for (const step of path.steps) {
    const children = elementChildren(current);
    const next = children[step.index];
    if (children.length !== step.siblings || !next || next.tagName !== step.tag.toLowerCase()) {
      return null;
    }
    current = next;
  }
  if (attribute(current, "id") !== path.id || attribute(current, "class") !== path.className) {
    return null;
  }
  const location = current.sourceCodeLocation;
  const startTag = location?.startTag;
  // html / head / body 可以省略标签（由解析器补出来），这时源码里没有可以改的开始标签
  if (!location || !startTag) return null;
  const styleRange = location.attrs?.style;
  const styleValue = attribute(current, "style");
  const onlyText =
    !RAW_TEXT_TAGS.has(current.tagName) &&
    current.childNodes.every((child) => child.nodeName === "#text");
  return {
    startTag: { start: startTag.startOffset, end: startTag.endOffset },
    style:
      styleRange && styleValue !== null
        ? { start: styleRange.startOffset, end: styleRange.endOffset, value: styleValue }
        : null,
    text:
      onlyText && location.endTag
        ? {
            start: startTag.endOffset,
            end: location.endTag.startOffset,
            value: current.childNodes
              .map((child) => ("value" in child ? child.value : ""))
              .join(""),
          }
        : null,
  };
}

type StyleItem = { name: string; value: string } | { comment: string };

const IMPORTANT_RE = /!\s*important\s*$/iu;

/**
 * 面板写的属性 → 会和它抢同一样式的简写 / 分项（pageRuntime 的 RELATED_STYLE_PROPERTIES 是同一份，改时两边一起改）。
 * 例：写 background-color 时 background 带 !important、写 padding 时 padding-top 带 !important。
 */
const RELATED_STYLE_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  "background-color": ["background"],
  "font-size": ["font"],
  "font-weight": ["font"],
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  "border-radius": [
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
  ],
};

/**
 * 按分号拆 style 声明；括号、引号里的分号（url(…;…)、content: ";"）不算。
 * 注释里的分号、冒号不当声明分隔（!3450 CR-03）：声明之间的注释原样留成单独一项，值里的注释留在值里。
 */
function splitDeclarations(style: string): StyleItem[] {
  const items: StyleItem[] = [];
  const pushDeclaration = (part: string) => {
    const colon = part.indexOf(":");
    if (colon <= 0) return;
    const name = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (name && value) items.push({ name, value });
  };
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  let unclosedCommentAt: number | null = null;
  for (let index = 0; index < style.length; index += 1) {
    const char = style[index];
    if (quote) {
      if (char === quote && style[index - 1] !== "\\") quote = null;
    } else if (char === "/" && style[index + 1] === "*") {
      const close = style.indexOf("*/", index + 2);
      const commentEnd = close === -1 ? style.length : close + 2;
      // 只有在声明之间的注释才单独成一项；写在值里的（color: /* brand */ red）留在这条声明里。
      // 没闭合的注释补上 */：否则后面追加的声明会被吞进注释，页面改了源码没改（!3450 CR-01）
      if (depth === 0 && style.slice(start, index).trim() === "") {
        const comment = style.slice(index, commentEnd);
        items.push({ comment: close === -1 ? `${comment.trimEnd()} */` : comment });
        start = commentEnd;
      } else if (close === -1) {
        unclosedCommentAt = index;
      }
      index = commentEnd - 1;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) {
      pushDeclaration(style.slice(start, index));
      start = index + 1;
    }
  }
  pushDeclaration(
    unclosedCommentAt === null ? style.slice(start) : `${style.slice(start).trimEnd()} */`,
  );
  return items;
}

/** 在原 style 上改几条声明：已有的原位替换、没有的追加、值为 null 的删除；其余声明和注释保持原顺序 */
export function mergeStyleDeclarations(
  style: string,
  changes: Readonly<Record<string, string | null>>,
): string {
  const targets = new Map(
    Object.entries(changes).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const applied = new Set<string>();
  const merged: StyleItem[] = [];
  const items = splitDeclarations(style);
  // 原来生效的那条带 !important（同名多条时带 !important 的赢），改值时保留：面板只改值，不该悄悄降优先级（!3450 CR-01）
  const important = new Set(
    items.flatMap((item) =>
      "name" in item && IMPORTANT_RE.test(item.value) ? [item.name.toLowerCase()] : [],
    ),
  );
  // 相关的简写 / 分项带 !important（!3450 SG-01）：新值也带 !important 并挪到最后，同优先级后写的赢，
  // 页面预览按同一规则设成 important，源码与预览一致
  const relatedImportant = new Set(
    [...targets.keys()].filter((key) =>
      (RELATED_STYLE_PROPERTIES[key] ?? []).some((related) => important.has(related)),
    ),
  );
  for (const item of items) {
    if ("comment" in item) {
      merged.push(item);
      continue;
    }
    const key = item.name.toLowerCase();
    if (!targets.has(key)) {
      merged.push(item);
      continue;
    }
    if (relatedImportant.has(key)) continue;
    // Bugfix（!3450 SG-01）：同名声明可能写了不止一次（color: red; color: blue），以后面的为准。
    // 以前只改第一条，后面那条照样生效，页面颜色不变。现在第一处放新值，其余同名声明都去掉。
    if (applied.has(key)) continue;
    applied.add(key);
    const next = targets.get(key);
    if (next !== null && next !== undefined) {
      const value = important.has(key) && !IMPORTANT_RE.test(next) ? `${next} !important` : next;
      merged.push({ name: item.name, value });
    }
  }
  for (const [name, value] of targets) {
    if (applied.has(name) || value === null) continue;
    const forced = relatedImportant.has(name) && !IMPORTANT_RE.test(value);
    merged.push({ name, value: forced ? `${value} !important` : value });
  }
  return merged
    .map((item) => ("comment" in item ? item.comment : `${item.name}: ${item.value};`))
    .join(" ")
    .replace(/;$/u, "");
}

const escapeAttribute = (value: string) => value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");

/** 换行原样写成文本换行，不写 `<br>`：写回后元素仍只含文字，下次还能改（!3450 SG-01） */
const escapeText = (value: string) =>
  value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/**
 * 改元素：styles 合并进 style 属性（合并后为空则去掉属性），text 替换只含文字的元素内容。
 * 要改文字但元素不是只含文字时返回 null。
 */
export function rewriteSourceElement(
  source: string,
  location: SourceElementLocation,
  edit: { styles?: Readonly<Record<string, string | null>>; text?: string },
): string | null {
  const replacements: Array<SourceRange & { content: string }> = [];
  if (edit.styles && Object.keys(edit.styles).length > 0) {
    const style = mergeStyleDeclarations(location.style?.value ?? "", edit.styles);
    const attributeText = style ? `style="${escapeAttribute(style)}"` : "";
    if (location.style) {
      // 去掉属性时连同它前面的一个空白一起删，开始标签里不留双空格
      const removeSpace = !attributeText && /\s/u.test(source[location.style.start - 1] ?? "");
      replacements.push({
        start: removeSpace ? location.style.start - 1 : location.style.start,
        end: location.style.end,
        content: attributeText,
      });
    } else if (attributeText) {
      // 插在开始标签的 `>` / `/>` 前面
      const { end } = location.startTag;
      const insertAt = source[end - 2] === "/" ? end - 2 : end - 1;
      replacements.push({ start: insertAt, end: insertAt, content: ` ${attributeText}` });
    }
  }
  if (edit.text !== undefined) {
    if (!location.text) return null;
    replacements.push({ ...location.text, content: escapeText(edit.text) });
  }
  // 从后往前替换，前面的偏移不受影响（文字范围在开始标签之后）
  let result = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result =
      result.slice(0, replacement.start) + replacement.content + result.slice(replacement.end);
  }
  return result;
}

/** 注释换成等长空白：位置不变，注释里的 `--x: 1` 不会被当成声明 */
const blankComments = (css: string) =>
  css.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));

const ROOT_SELECTORS = new Set([":root", "html"]);

/**
 * 找 `<style>` 里 `:root` / `html` 规则中这个变量的声明值范围（不含 `!important` 与两端空白）。
 * 找不到、或整份源码里声明了不止一处（媒体查询、主题切换），返回 null：不知道该改哪一处。
 */
export function locateSourceCssVariable(source: string, name: string): SourceRange | null {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const found: SourceRange[] = [];
  const declaration = new RegExp(
    `(?:^|[;{\\s])${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*:([^;}]*)`,
    "gu",
  );
  const visit = (node: ParsedNode) => {
    if (isElement(node) && node.tagName === "style") {
      const text = node.childNodes[0];
      const location = text?.sourceCodeLocation;
      if (text && text.nodeName === "#text" && location) {
        const css = blankComments(source.slice(location.startOffset, location.endOffset));
        for (const rule of css.matchAll(/([^{}]*)\{([^{}]*)\}/gu)) {
          const selectors = (rule[1] ?? "").split(",").map((part) => part.trim());
          const body = rule[2] ?? "";
          const bodyStart = location.startOffset + (rule.index ?? 0) + (rule[1] ?? "").length + 1;
          for (const match of body.matchAll(declaration)) {
            const raw = match[1] ?? "";
            const value = raw.replace(/\s*!important\s*$/iu, "");
            const leading = value.length - value.trimStart().length;
            const valueStart =
              bodyStart + (match.index ?? 0) + match[0].length - raw.length + leading;
            const record = { start: valueStart, end: valueStart + value.trim().length };
            // 非 :root / html 规则里的同名声明也算一处：改了 :root 那条，页面可能仍显示另一条
            found.push(
              selectors.every((selector) => ROOT_SELECTORS.has(selector))
                ? record
                : { start: -1, end: -1 },
            );
          }
        }
      }
    }
    for (const child of "childNodes" in node ? node.childNodes : []) visit(child);
    if (isElement(node) && "content" in node) visit(node.content);
  };
  visit(document);
  const only = found.length === 1 ? found[0] : undefined;
  return only && only.start >= 0 ? only : null;
}

export function rewriteSourceCssVariable(
  source: string,
  name: string,
  value: string,
): string | null {
  const range = locateSourceCssVariable(source, name);
  if (!range) return null;
  return source.slice(0, range.start) + value + source.slice(range.end);
}
