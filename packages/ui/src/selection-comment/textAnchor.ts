import type { ConversationSelectionTextAnchor } from "@/lib/conversationSelectionReference.js";

/**
 * 选区文字锚点：把一段 DOM Range 记成“来源行 → 第几个可选区域 → 字符偏移”，
 * 之后（虚拟滚动卸载又挂回、流式追加、页面重排之后）再还原成 Range 来画标记。
 *
 * 不存 DOM 引用，也不靠全文搜索：同一句话在回答里可能出现多次，只有偏移能指到用户真正框的那一处。
 * 还原时必须校验文字，校验不过就放弃画标记，宁可少画也不画到别处。
 */

export const SELECTABLE_REGION_SELECTOR = "[data-conversation-selectable]";

function textNodesOf(region: Element): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

/** 选区文字里的空白（Selection.toString 会在块之间补换行）不参与比较。 */
export function normalizeSelectionText(text: string): string {
  return text.replace(/\s+/g, "");
}

function offsetWithin(region: Element, container: Node, offset: number): number | null {
  // 端点落在元素节点上时，等价于“该元素第 offset 个子节点之前”：换算成它之前所有文本的长度。
  const probe = document.createRange();
  probe.selectNodeContents(region);
  try {
    probe.setEnd(container, offset);
  } catch {
    return null;
  }
  return probe.toString().length;
}

/** 为刚创建的引用记录文字锚点；选区不在单个可选区域内时返回 null。 */
export function describeSelectionTextAnchor(
  range: Range,
  rowElement: HTMLElement,
): ConversationSelectionTextAnchor | null {
  const regions = Array.from(rowElement.querySelectorAll(SELECTABLE_REGION_SELECTOR));
  const startElement =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const region = startElement?.closest(SELECTABLE_REGION_SELECTOR);
  if (!region || !region.contains(range.endContainer)) return null;
  const regionIndex = regions.indexOf(region);
  if (regionIndex < 0) return null;
  const start = offsetWithin(region, range.startContainer, range.startOffset);
  const end = offsetWithin(region, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return { regionIndex, start, end, rangeText: normalizeSelectionText(range.toString()) };
}

/** 还原锚点；行没挂载、内容变了或文字对不上时返回 null。 */
export function resolveSelectionTextAnchor(
  rowElement: HTMLElement,
  anchor: ConversationSelectionTextAnchor,
  expectedText: string,
): Range | null {
  const region = rowElement.querySelectorAll(SELECTABLE_REGION_SELECTOR)[anchor.regionIndex];
  if (!region) return null;
  let cursor = 0;
  let startNode: { node: Text; offset: number } | null = null;
  let endNode: { node: Text; offset: number } | null = null;
  for (const node of textNodesOf(region)) {
    const length = node.data.length;
    if (!startNode && anchor.start < cursor + length) {
      startNode = { node, offset: anchor.start - cursor };
    }
    if (anchor.end <= cursor + length) {
      endNode = { node, offset: anchor.end - cursor };
      break;
    }
    cursor += length;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  try {
    range.setStart(startNode.node, startNode.offset);
    range.setEnd(endNode.node, endNode.offset);
  } catch {
    return null;
  }
  const expected = anchor.rangeText ?? normalizeSelectionText(expectedText);
  return normalizeSelectionText(range.toString()) === expected ? range : null;
}

export interface SelectionLineRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** KaTeX 渲染的公式根节点。 */
const FORMULA_SELECTOR = ".katex";
/** 代码块正文的宿主元素（内容在 open Shadow DOM 里）与其中的代码行。 */
export const CODE_BLOCK_HOST_SELECTOR = "diffs-container";
const CODE_LINE_SELECTOR = "[data-line]";

/** 被选区跨过的代码块宿主，按文档顺序。选区端点进不了 Shadow DOM，所以相交即整块被选中。 */
function selectedCodeBlocks(range: Range): Element[] {
  const root =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!root) return [];
  return Array.from(root.querySelectorAll(CODE_BLOCK_HOST_SELECTOR)).filter(
    (host) => host.shadowRoot && range.intersectsNode(host),
  );
}

/**
 * 被选区跨过的代码块当前内容的摘要。代码正文在 Shadow DOM 里，它变了（高亮异步完成、仍在输出）
 * 浏览器给出的选区文本和端点都不会变，缓存选区原文时要把它一起作为失效条件。
 */
export function selectionCodeSignature(range: Range): string {
  return selectedCodeBlocks(range)
    .map((host) => {
      const lines = host.shadowRoot?.querySelectorAll(CODE_LINE_SELECTOR) ?? [];
      let length = 0;
      for (const line of lines) length += line.textContent?.length ?? 0;
      return `${lines.length}:${length}`;
    })
    .join("|");
}

/** 非空白字符，按码点计（公式里的数学斜体字母是代理对，按 UTF-16 长度数会多算）。 */
function visibleChars(text: string): string[] {
  return Array.from(text).filter((char) => !/\s/.test(char));
}

function fencedCode(code: string): string {
  return `\`\`\`\n${code}\n\`\`\``;
}

/** 选区文本里的一段：普通文字逐字保留；公式整体替换成 TeX；代码块在两段文字之间插入。 */
type SelectionPiece =
  | { kind: "text"; count: number; spaceBefore: boolean; newBlock: boolean }
  | {
      kind: "formula";
      count: number;
      tex: string;
      display: boolean;
      /** 原文里这一段前面是否有空白、是否另起一个块；公式两侧的空白以原文为准。 */
      spaceBefore: boolean;
      newBlock: boolean;
    }
  | { kind: "code"; code: string };

/** 最近的非行内祖先（段落、列表项、表格单元格）。 */
function blockAncestor(element: Element): Element {
  let block = element;
  while (block.parentElement && getComputedStyle(block).display.startsWith("inline")) {
    block = block.parentElement;
  }
  return block;
}

/**
 * 按文档顺序把选区拆成若干段，并数出每段在浏览器选区文本里占多少个非空白字符。
 * 只数真正渲染出来、且可选的文本节点——浏览器的选区文本也只包含这些。
 */
function describeSelectionPieces(range: Range): SelectionPiece[] {
  const root =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!root) return [];
  const pieces: SelectionPiece[] = [];
  const formulaPieces = new Map<Element, Extract<SelectionPiece, { kind: "formula" }>>();
  const probe = document.createRange();
  // 代码块宿主夹在文本节点之间；按文档顺序在走到它后面的第一个文本节点之前插入。
  const hosts = selectedCodeBlocks(range);
  const flushCodeBefore = (node: Node | null) => {
    while (hosts.length > 0) {
      const host = hosts[0]!;
      if (node && !(host.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      hosts.shift();
      const code = Array.from(host.shadowRoot?.querySelectorAll(CODE_LINE_SELECTOR) ?? [])
        .map((line) => (line.textContent ?? "").replace(/\n$/, ""))
        .join("\n");
      if (code.trim()) pieces.push({ kind: "code", code });
    }
  };
  // 上一段文字是否以空白结尾、落在哪个块里：用来还原公式两侧的空格和分段。
  let trailingSpace = false;
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  // 只走选区覆盖的那一段文本节点：从选区起点开始，越过终点就停，不遍历整条消息。
  walker.currentNode = range.startContainer;
  const first = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer : null;
  for (let node = first ?? walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (range.comparePoint(text, 0) > 0) break;
    if (!range.intersectsNode(text) || !text.parentElement) continue;
    flushCodeBefore(text);
    if (getComputedStyle(text.parentElement).userSelect === "none") continue;
    const from = text === range.startContainer ? range.startOffset : 0;
    const to = text === range.endContainer ? range.endOffset : text.data.length;
    const slice = text.data.slice(from, to);
    const count = visibleChars(slice).length;
    if (count === 0) {
      if (slice.length > 0) trailingSpace = true;
      continue;
    }
    // display:none 的节点（公式里存放 TeX 源码的 annotation）不在选区文本里。
    probe.selectNodeContents(text);
    if (probe.getClientRects().length === 0) continue;
    const formula = text.parentElement.closest(FORMULA_SELECTOR);
    const tex = formula?.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (formula && tex?.trim()) {
      let piece = formulaPieces.get(formula);
      if (!piece) {
        const block = blockAncestor(formula.parentElement ?? formula);
        piece = {
          kind: "formula",
          count: 0,
          tex: tex.trim(),
          display: formula.closest(".katex-display") !== null,
          spaceBefore: trailingSpace,
          newBlock: block !== lastBlock,
        };
        lastBlock = block;
        formulaPieces.set(formula, piece);
        pieces.push(piece);
      }
      piece.count += count;
      trailingSpace = false;
      continue;
    }
    const block = blockAncestor(text.parentElement);
    const last = pieces[pieces.length - 1];
    if (last?.kind === "text" && block === lastBlock) {
      last.count += count;
    } else {
      pieces.push({
        kind: "text",
        count,
        spaceBefore: trailingSpace || /^\s/.test(slice),
        newBlock: block !== lastBlock,
      });
    }
    lastBlock = block;
    trailingSpace = /\s$/.test(slice);
  }
  flushCodeBefore(null);
  return pieces;
}

/**
 * 选区对应的原文，发给模型用。以浏览器给出的选区文本为底，做两处修正：
 *
 * - 代码块：正文渲染在 Shadow DOM 里，Selection.toString() 不包含它。用户从代码块上方拖到
 *   下方，引用里却没有代码。这里把被跨过的代码块以围栏代码块形式补到它所在的位置。
 * - 公式：浏览器给出的是视觉隐藏的 MathML 和渲染层的字符，一个字符一行，模型读不懂。
 *   这里整体替换成公式的 TeX 源码（行内 $…$，独立 $$…$$）。
 *
 * 做法是把选区拆成段并数出每段的非空白字符数，再对着选区文本逐字符消费。前提是两边的字符数
 * 一致；对不上时（未知的渲染形态）不做替换，只把代码块附在末尾，保证内容不丢、不插错位置。
 */
export function readSelectionText(selection: Selection, range: Range): string {
  const text = selection.toString();
  // 绝大多数选区里既没有代码块也没有公式：先用便宜的查询排除，不做逐节点的统计。
  const root =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!root) return text;
  const hasFormula =
    root.closest(FORMULA_SELECTOR) !== null ||
    Array.from(root.querySelectorAll(FORMULA_SELECTOR)).some((formula) =>
      range.intersectsNode(formula),
    );
  if (!hasFormula && selectedCodeBlocks(range).length === 0) return text;
  const pieces = describeSelectionPieces(range);
  if (!pieces.some((piece) => piece.kind !== "text")) return text;
  const chars = Array.from(text);
  const expected = pieces.reduce(
    (sum, piece) => sum + (piece.kind === "code" ? 0 : piece.count),
    0,
  );
  if (expected !== chars.filter((char) => !/\s/.test(char)).length) {
    const blocks = pieces.flatMap((piece) =>
      piece.kind === "code" ? [fencedCode(piece.code)] : [],
    );
    return [text.trimEnd(), ...blocks].join("\n\n");
  }
  // 问题原因：原先把代码正文拼进 output 后，对整段结果做“三个以上换行压成两个”。代码里的
  // 连续空行（比如模板字符串里的）也被压掉，模型拿到的代码和用户选的不一样。
  // 现在代码正文单独成段、原样保留，换行整理只作用在正文文字上。
  const chunks: string[] = [];
  let output = "";
  const flushProse = () => {
    const prose = output.replace(/\n{3,}/g, "\n\n").trim();
    if (prose) chunks.push(prose);
    output = "";
  };
  let index = 0;
  /** 消费选区文本里接下来的 count 个非空白字符（连同它们之间的空白），返回这一段原文。 */
  const take = (count: number): string => {
    const start = index;
    let remaining = count;
    while (remaining > 0 && index < chars.length) {
      if (!/\s/.test(chars[index]!)) remaining -= 1;
      index += 1;
    }
    return chars.slice(start, index).join("");
  };
  /** 段与段之间的空白。 */
  const takeGap = (): string => {
    const start = index;
    while (index < chars.length && /\s/.test(chars[index]!)) index += 1;
    return chars.slice(start, index).join("");
  };
  // 公式内部排版会在选区文本里留下换行和空格，它们不是原文的一部分。公式和代码块两侧的
  // 空白按原文重建：同一块内看原文有没有空格，另起一块时保留分段，独立公式和代码块自带空行。
  // previous 记录上一段是什么：text 之后的间隔原样保留，其余要重建。
  let previous: "start" | "text" | "inline" | "block" = "start";
  /** 另起一块时的分隔：沿用浏览器给的换行数（列表项之间一个，段落之间两个）。 */
  const blockBreak = (gap: string): string => {
    const newlines = gap.split("\n").length - 1;
    return "\n".repeat(Math.min(Math.max(newlines, 1), 2));
  };
  for (const piece of pieces) {
    const gap = takeGap();
    if (piece.kind === "text") {
      if (previous === "inline") {
        output += piece.newBlock ? blockBreak(gap) : piece.spaceBefore ? " " : "";
      } else if (previous === "text") {
        output += gap;
      }
      output += take(piece.count);
      previous = "text";
    } else if (piece.kind === "formula") {
      take(piece.count);
      if (piece.display) {
        output = `${output.trimEnd()}\n\n$$${piece.tex}$$\n\n`;
        previous = "block";
      } else {
        const separator =
          previous === "start" || previous === "block"
            ? ""
            : piece.newBlock
              ? blockBreak(gap)
              : piece.spaceBefore
                ? " "
                : "";
        output = `${previous === "block" ? output : output.trimEnd()}${separator}$${piece.tex}$`;
        previous = "inline";
      }
    } else {
      flushProse();
      chunks.push(fencedCode(piece.code));
      previous = "block";
    }
  }
  flushProse();
  return chunks.join("\n\n");
}

/**
 * Range 在每一行上的文字矩形，按从上到下排序。
 *
 * 问题原因：Range.getClientRects() 对被整块选中的元素会额外返回它的 border box。原先按
 * “不高于最矮矩形 1.8 倍”过滤，单行段落的 border box 和文字行差不多高，过滤不掉，
 * 跨多个段落的注释就会多出一条撑满整行、位置偏下的下划线。
 * 改为只取选区内各文本节点自身的矩形：元素盒子不会出现，也不需要按高度猜。
 */
export function getSelectionLineRects(range: Range): SelectionLineRect[] {
  const root =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!root) return [];
  // 每个文字矩形记下它所在的块级容器（段落、列表项、表格单元格）。
  const rects: (SelectionLineRect & { block: Element })[] = [];
  const blocks = new Map<Element, Element>();
  const blockOf = (element: Element): Element => {
    let block = blocks.get(element);
    if (!block) {
      block = element;
      while (block.parentElement && getComputedStyle(block).display.startsWith("inline")) {
        block = block.parentElement;
      }
      blocks.set(element, block);
    }
    return block;
  };
  const formulas = new Set<Element>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const part = document.createRange();
  // 从选区起点开始走到选区终点为止：流式输出时每帧都会重算，不能每次遍历整条消息的文本节点。
  walker.currentNode = range.startContainer;
  const first = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer : null;
  for (let node = first ?? walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (range.comparePoint(text, 0) > 0) break;
    if (!range.intersectsNode(text) || !text.parentElement) continue;
    // 夹在选区中间的界面文字（表格工具栏、代码块语言标签）不可选，不属于被注释的原文。
    if (getComputedStyle(text.parentElement).userSelect === "none") continue;
    // 数学公式整体算一个矩形。公式内部每个字符、上下标、分数线都是独立定位的小盒子，
    // 还带一份视觉隐藏的 MathML；逐个文本节点取矩形会把一个公式画成几十段高低不一的碎线。
    const formula = text.parentElement.closest(FORMULA_SELECTOR);
    if (formula) {
      if (formulas.has(formula)) continue;
      formulas.add(formula);
      // 独立公式的外层盒子撑满整行；取公式各段内容（.base）的并集才是公式本身的宽度。
      const parts = Array.from(formula.querySelectorAll(".base"), (base) =>
        base.getBoundingClientRect(),
      ).filter((rect) => rect.width > 0.5 && rect.height > 0.5);
      const boxes = parts.length > 0 ? parts : [formula.getBoundingClientRect()];
      const box = {
        left: Math.min(...boxes.map((rect) => rect.left)),
        right: Math.max(...boxes.map((rect) => rect.right)),
        top: Math.min(...boxes.map((rect) => rect.top)),
        bottom: Math.max(...boxes.map((rect) => rect.bottom)),
      };
      if (box.right - box.left > 0.5 && box.bottom - box.top > 0.5) {
        rects.push({ ...box, block: blockOf(formula.parentElement ?? formula) });
      }
      continue;
    }
    part.setStart(text, text === range.startContainer ? range.startOffset : 0);
    part.setEnd(text, text === range.endContainer ? range.endOffset : text.data.length);
    const block = blockOf(text.parentElement);
    for (const rect of part.getClientRects()) {
      if (rect.width > 0.5 && rect.height > 0.5) {
        rects.push({
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          block,
        });
      }
    }
  }
  // 被选区整个跨过的代码块：正文在 Shadow DOM 里，上面的遍历进不去，这里逐行补上。
  // 每行文字的矩形裁到代码块可视范围内（代码块可横向滚动，超出的部分不画）。
  for (const host of selectedCodeBlocks(range)) {
    const clip = (host.parentElement ?? host).getBoundingClientRect();
    for (const line of host.shadowRoot?.querySelectorAll(CODE_LINE_SELECTOR) ?? []) {
      part.selectNodeContents(line);
      for (const rect of part.getClientRects()) {
        const left = Math.max(rect.left, clip.left);
        const right = Math.min(rect.right, clip.right);
        if (
          right - left > 0.5 &&
          rect.height > 0.5 &&
          rect.bottom > clip.top &&
          rect.top < clip.bottom
        ) {
          rects.push({ left, right, top: rect.top, bottom: rect.bottom, block: line });
        }
      }
    }
  }
  // 同一个块里的同一视觉行合并成一条线。加粗、链接、行内代码各是独立的文本节点，行内代码
  // 两侧还有内边距、字号也更小：逐个矩形画线会在行内代码两边断开，线的高度也对不齐。
  // 选区是连续的，所以同一块同一行里从最左到最右都属于选区，可以直接取并集。
  // 垂直方向重叠超过较矮者一半就算同一行；不同的块（如同一行的两个表格单元格）不合并。
  const lines: (SelectionLineRect & { block: Element })[] = [];
  for (const rect of rects) {
    const line = lines.find((candidate) => {
      if (candidate.block !== rect.block) return false;
      const overlap = Math.min(candidate.bottom, rect.bottom) - Math.max(candidate.top, rect.top);
      return overlap > Math.min(candidate.bottom - candidate.top, rect.bottom - rect.top) / 2;
    });
    if (line) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      lines.push({ ...rect });
    }
  }
  // 列表项从开头被选中时，下划线向左带上序号/圆点。序号是浏览器生成的标记，没有文本节点，
  // 只画文字的话每个列表项开头都缺一截。只处理标记排在行内的列表（首行文字比列表项内容区
  // 靠右）；标记在内容区之外的列表，首行左边界本来就是内容区左边界，结果不变。
  const firstLineOfItem = new Map<Element, SelectionLineRect>();
  for (const line of lines) {
    const item = line.block.closest("li");
    if (!item || !range.isPointInRange(item, 0)) continue;
    const current = firstLineOfItem.get(item);
    if (!current || line.top < current.top) firstLineOfItem.set(item, line);
  }
  for (const [item, line] of firstLineOfItem) {
    const style = getComputedStyle(item);
    const contentLeft =
      item.getBoundingClientRect().left +
      Number.parseFloat(style.borderLeftWidth) +
      Number.parseFloat(style.paddingLeft);
    line.left = Math.min(line.left, contentLeft);
  }
  return lines
    .map(({ left, right, top, bottom }) => ({ left, right, top, bottom }))
    .sort((a, b) => a.top - b.top || a.left - b.left);
}
