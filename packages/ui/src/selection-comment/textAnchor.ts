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

/** Range 在每一行上的文字矩形（去掉整块容器的大矩形与零宽矩形），按从上到下排序。 */
export function getSelectionLineRects(range: Range): SelectionLineRect[] {
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0.5 && rect.height > 0.5,
  );
  if (rects.length === 0) return [];
  // 整块被选中的元素（段落、表格单元格）也会产生 border box，比文字行高得多；
  // 用最矮矩形的高度做基准把它们剔除，剩下的才是真实的文字行。
  const baseline = Math.min(...rects.map((rect) => rect.height));
  const lines = rects.filter((rect) => rect.height <= baseline * 1.8);
  return (lines.length > 0 ? lines : rects)
    .map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }))
    .sort((a, b) => a.top - b.top || a.left - b.left);
}
