import {
  DESIGN_PAGE_LIMITS,
  DESIGN_RUNTIME_VERSION,
  type DesignEditableValues,
  type DesignElementKind,
  type DesignInteractionMode,
  type DesignPageInfo,
  type DesignPageSignals,
  type DesignRuntimeCommand,
  type DesignRuntimeEvent,
  type DesignRuntimeReply,
  type DesignSelectedElement,
  type DesignSourcePath,
  type PageElementRect,
  type PageElementSnapshot,
  type PageElementStyleSummary,
} from "./contract.js";
import { buildElementInspectorExpression } from "./elementInspector.js";
import { installDesignRuntime } from "./pageRuntime.js";
import { readDesignPageSignals } from "./pageSignals.js";

// 宿主侧：生成交给 webview.executeJavaScript 的脚本，并校验页面回来的值。
// 页面可以伪造返回值和事件，所以这里做形状校验并给每个字符串、数组设上限；内容最终只会变成
// 用户看得见、能删的上下文。

const RUNTIME_GLOBAL = "window.__zcodeDesignRuntime";
const MISSING_REPLY = JSON.stringify({ ok: false, reason: "missing" });

/** 安装（或复用同版本）运行时；结果是 DesignRuntimeReply<DesignPageInfo>。bridgeKey 见 pageRuntime。 */
export function buildDesignRuntimeInstallScript(bridgeKey: string): string {
  const options = {
    version: DESIGN_RUNTIME_VERSION,
    bridgeKey,
    maxCssVariables: DESIGN_PAGE_LIMITS.cssVariables,
  };
  return `(${installDesignRuntime.toString()})(${JSON.stringify(options)}, ${buildElementInspectorExpression()}, ${readDesignPageSignals.toString()})`;
}

/** 调一个固定命令；运行时不在（页面刚刷新）时返回 missing。 */
export function buildDesignRuntimeCommandScript(command: DesignRuntimeCommand): string {
  return `(() => { const runtime = ${RUNTIME_GLOBAL}; return runtime ? runtime.run(${JSON.stringify(command)}) : ${MISSING_REPLY}; })()`;
}

/** 不装运行时只读设计稿信号（宿主据此决定设计工具是否自动出现）；结果交给 parseDesignPageSignals。 */
export function buildDesignPageSignalsScript(): string {
  return `(${readDesignPageSignals.toString()})(${DESIGN_PAGE_LIMITS.cssVariables})`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function index(value: unknown, max: number): number {
  const number = finite(value);
  return number === undefined ? 0 : Math.max(0, Math.min(max, Math.trunc(number)));
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    if (items.length >= maxItems) break;
    const text = clip(item, maxLength);
    if (text) items.push(text);
  }
  return items;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function parseRect(value: unknown): PageElementRect | undefined {
  if (!isRecord(value)) return undefined;
  const x = finite(value.x);
  const y = finite(value.y);
  const width = finite(value.width);
  const height = finite(value.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

const STYLE_KEYS = [
  "color",
  "backgroundColor",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "display",
] as const satisfies ReadonlyArray<keyof PageElementStyleSummary>;

function parseStyle(value: unknown): PageElementStyleSummary | undefined {
  if (!isRecord(value)) return undefined;
  const style: PageElementStyleSummary = {};
  for (const key of STYLE_KEYS) {
    const text = clip(value[key], DESIGN_PAGE_LIMITS.shortText);
    if (text !== undefined) style[key] = text;
  }
  return style;
}

function parseAttributes(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const attributes: Record<string, string> = {};
  let count = 0;
  for (const [name, raw] of Object.entries(value)) {
    if (count >= DESIGN_PAGE_LIMITS.attributes) break;
    const text = clip(raw, DESIGN_PAGE_LIMITS.shortText);
    if (text === undefined || !name) continue;
    attributes[name.slice(0, DESIGN_PAGE_LIMITS.token)] = text;
    count += 1;
  }
  return attributes;
}

/** 页面给的元素快照；缺 tagName 视为无效 */
export function parsePageElementSnapshot(value: unknown): PageElementSnapshot | null {
  if (!isRecord(value)) return null;
  const tagName = clip(value.tagName, DESIGN_PAGE_LIMITS.token);
  if (!tagName) return null;
  const { longText, shortText, token, url } = DESIGN_PAGE_LIMITS;
  return {
    pageUrl: clip(value.pageUrl, url) ?? "",
    pageTitle: clip(value.pageTitle, shortText) ?? "",
    tagName,
    ...optional("role", clip(value.role, token)),
    ...optional("accessibleName", clip(value.accessibleName, shortText)),
    ...optional("selector", clip(value.selector, shortText)),
    ...optional("xpath", clip(value.xpath, shortText)),
    ...optional("text", clip(value.text, longText)),
    ...optional("nearbyText", clip(value.nearbyText, longText)),
    ...optional("htmlExcerpt", clip(value.htmlExcerpt, longText)),
    ...optional("attributes", parseAttributes(value.attributes)),
    ...optional("rect", parseRect(value.rect)),
    ...optional("style", parseStyle(value.style)),
    capturedAt: finite(value.capturedAt) ?? Date.now(),
  };
}

function parseEditableValues(value: unknown): DesignEditableValues | null {
  if (!isRecord(value)) return null;
  const { longText, token } = DESIGN_PAGE_LIMITS;
  const field = (key: string) => clip(value[key], token) ?? "";
  return {
    text: value.text === null ? null : (clip(value.text, longText) ?? null),
    color: field("color"),
    background: field("background"),
    backgroundColor:
      value.backgroundColor === null ? null : (clip(value.backgroundColor, token) ?? null),
    fontSize: field("fontSize"),
    fontWeight: field("fontWeight"),
    textAlign: field("textAlign"),
    borderRadius: field("borderRadius"),
    padding: field("padding"),
    opacity: field("opacity"),
  };
}

const ELEMENT_KINDS = new Set<DesignElementKind>([
  "button",
  "heading",
  "text",
  "link",
  "image",
  "container",
]);

const MODES = new Set<DesignInteractionMode>(["off", "select"]);

function parseSourcePath(value: unknown): DesignSourcePath {
  const record = isRecord(value) ? value : {};
  const steps: DesignSourcePath["steps"] = [];
  for (const item of Array.isArray(record.steps)
    ? record.steps.slice(0, DESIGN_PAGE_LIMITS.sourceDepth + 1)
    : []) {
    const tag = isRecord(item) ? clip(item.tag, DESIGN_PAGE_LIMITS.token) : undefined;
    const position = isRecord(item) ? finite(item.index) : undefined;
    const siblings = isRecord(item) ? finite(item.siblings) : undefined;
    if (!tag || position === undefined || siblings === undefined) {
      // 有一级读不出就整条作废：写回时一定找不到，不会按半条路径找到别的元素
      return { steps: [{ tag: "#invalid", index: -1, siblings: -1 }], id: null, className: null };
    }
    steps.push({ tag, index: Math.trunc(position), siblings: Math.trunc(siblings) });
  }
  const attribute = (key: string) =>
    record[key] === null ? null : (clip(record[key], DESIGN_PAGE_LIMITS.shortText) ?? null);
  return { steps, id: attribute("id"), className: attribute("className") };
}

function parseSelection(value: unknown): DesignSelectedElement | null {
  if (!isRecord(value)) return null;
  const element = parsePageElementSnapshot(value.element);
  const editable = parseEditableValues(value.editable);
  if (!element || !editable) return null;
  const size = isRecord(value.size) ? value.size : {};
  return {
    element,
    editable,
    kind: ELEMENT_KINDS.has(value.kind as DesignElementKind)
      ? (value.kind as DesignElementKind)
      : "container",
    source: parseSourcePath(value.source),
    size: {
      width: Math.max(0, finite(size.width) ?? 0),
      height: Math.max(0, finite(size.height) ?? 0),
    },
    styleAttribute:
      value.styleAttribute === null
        ? null
        : (clip(value.styleAttribute, DESIGN_PAGE_LIMITS.longText) ?? null),
  };
}

function parseEvent(value: unknown): DesignRuntimeEvent | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "selection-changed": {
      if (!Array.isArray(value.selections)) return null;
      const selections = value.selections
        .slice(0, DESIGN_PAGE_LIMITS.selection)
        .map(parseSelection)
        .filter((selection): selection is DesignSelectedElement => selection !== null);
      return { type: "selection-changed", selections };
    }
    case "slide-changed": {
      const count = index(value.count, DESIGN_PAGE_LIMITS.slideCount);
      return { type: "slide-changed", index: index(value.index, Math.max(0, count - 1)), count };
    }
    case "mode-changed":
      return MODES.has(value.mode as DesignInteractionMode)
        ? { type: "mode-changed", mode: value.mode as DesignInteractionMode }
        : null;
    case "stage-changed":
      return typeof value.stageBackdrop === "boolean"
        ? {
            type: "stage-changed",
            stageBackdrop: value.stageBackdrop,
          }
        : null;
    default:
      return null;
  }
}

export function parseDesignRuntimeReply(value: unknown): DesignRuntimeReply {
  if (!isRecord(value)) return { ok: false, reason: "invalid" };
  if (value.ok === true) return { ok: true, result: value.result };
  return { ok: false, reason: value.reason === "missing" ? "missing" : "invalid" };
}

/** preload 转来的事件数组；无效项丢掉，超出单条消息上限的部分丢掉 */
export function parseDesignRuntimeEvents(value: unknown): DesignRuntimeEvent[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, DESIGN_PAGE_LIMITS.eventsPerMessage)
    .map(parseEvent)
    .filter((event): event is DesignRuntimeEvent => event !== null);
}

export function parseDesignPageSignals(value: unknown): DesignPageSignals | null {
  if (!isRecord(value)) return null;
  const { cssVariables, token, variants } = DESIGN_PAGE_LIMITS;
  return {
    isDesignDocument: value.isDesignDocument === true,
    cssVariableNames: stringList(value.cssVariableNames, cssVariables, token).filter((name) =>
      name.startsWith("--"),
    ),
    variants: stringList(value.variants, variants, token),
    slideCount: index(value.slideCount, DESIGN_PAGE_LIMITS.slideCount),
  };
}

export function parseDesignPageInfo(value: unknown): DesignPageInfo | null {
  if (!isRecord(value)) return null;
  const { cssVariables, shortText, slideCount, token, url, variants } = DESIGN_PAGE_LIMITS;
  if (!Array.isArray(value.variants) || !Array.isArray(value.cssVariables)) return null;
  const count = index(value.slideCount, slideCount);
  const variables: DesignPageInfo["cssVariables"] = [];
  for (const item of value.cssVariables) {
    if (variables.length >= cssVariables) break;
    if (!isRecord(item)) continue;
    const name = clip(item.name, token);
    const variableValue = clip(item.value, shortText);
    if (name?.startsWith("--") && variableValue !== undefined) {
      variables.push({ name, value: variableValue });
    }
  }
  return {
    pageUrl: clip(value.pageUrl, url) ?? "",
    pageTitle: clip(value.pageTitle, shortText) ?? "",
    isDesignDocument: value.isDesignDocument === true,
    variants: stringList(value.variants, variants, token),
    activeVariant: clip(value.activeVariant, token) ?? null,
    slideCount: count,
    currentSlide: index(value.currentSlide, Math.max(0, count - 1)),
    cssVariables: variables,
    stageBackdrop: value.stageBackdrop === true,
  };
}
