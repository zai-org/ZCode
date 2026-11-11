import type {
  PageElementRect,
  PageElementSnapshot,
  PageElementStyleSummary,
} from "@zcode/design-runtime";

export const WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT = "zcode:web-element-context-add-to-chat";
export const WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT =
  "zcode:web-element-context-remove-from-chat";
/** 事件 detail 上的标记键：只更新已有的同 id 引用（不新加） */
export const WEB_ELEMENT_CONTEXT_UPDATE_ONLY = "__zcodeUpdateOnly";
/** 输入框里用户删掉了引用（与上面「浏览器要求撤回」方向相反）；浏览器设计工具据此取消页面上的选中 */
export const WEB_ELEMENT_CONTEXTS_REMOVED_EVENT = "zcode:web-element-contexts-removed";

const WEB_ELEMENT_CONTEXT_BLOCK_TITLE = "# Web page elements:";
const MAX_MARKDOWN_FIELD_LENGTH = 8_000;

export type WebElementRect = PageElementRect;
export type WebElementStyleSummary = PageElementStyleSummary;

/**
 * 选中元素时在 main 侧按元素 rect 裁出的截图（docs/browser-use/2026-11-03-browser-element-screenshot-and-live-reload-spec.md）。
 * 只在内存里随 chip 走：composer 附加时把它预上传为图片附件，不进提示词文本，也不进历史回显。
 */
export interface WebElementScreenshot {
  data: ArrayBuffer;
  mimeType: "image/png";
}

export interface WebElementContextPayload extends PageElementSnapshot {
  id?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  screenshot?: WebElementScreenshot;
  /**
   * 设计模式点选的元素：在输入框正文里以元素 token 出现（可在前后穿插文字），不出单独的标签和缩略图。
   * 普通网页「选择元素」不带它，仍是输入框上方的元素标签。
   */
  inline?: boolean;
}

/** 截图文件名与提示词里的 `## Element N` 共用 chip 的稳定编号，模型才分得清哪张图是哪个元素。 */
export function buildWebElementScreenshotFileName(ordinal: number): string {
  return `element-${ordinal}.png`;
}

export interface WebElementContextComposerAttachment extends WebElementContextPayload {
  id: string;
  /**
   * 提示词 `## Element N` 与截图文件名 `element-N.png` 共用的编号。
   * 加入时取当前最大值 + 1、同 id 覆盖保留原值，所以删掉前面的 chip 后两者仍一一对应（编号可不连续）。
   */
  ordinal: number;
}

/** chip 带的截图 → composer 图片附件文件（没有截图时为空） */
export function webElementScreenshotFiles(context: WebElementContextComposerAttachment): File[] {
  const { screenshot } = context;
  return screenshot
    ? [
        new File([screenshot.data], buildWebElementScreenshotFileName(context.ordinal), {
          type: screenshot.mimeType,
        }),
      ]
    : [];
}

interface ParsedWebElementContextPrompt {
  visibleContent: string;
  webElementContexts: WebElementContextComposerAttachment[];
}

type WebElementContextAddToChatEvent = CustomEvent<WebElementContextPayload>;
type WebElementContextRemoveFromChatEvent = CustomEvent<{
  id: string;
  workspacePath: string;
  workspaceIdentity?: string;
}>;

export function createWebElementContextId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `web-element-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getWebElementContextWorkspaceKey(
  workspacePath: string,
  workspaceIdentity?: string,
) {
  return workspaceIdentity?.trim() || workspacePath;
}

export function isWebElementContextAddToChatEvent(
  event: Event,
): event is WebElementContextAddToChatEvent {
  return (
    event.type === WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT &&
    "detail" in event &&
    typeof (event as CustomEvent<unknown>).detail === "object" &&
    (event as CustomEvent<unknown>).detail !== null
  );
}

export function isWebElementContextRemoveFromChatEvent(
  event: Event,
): event is WebElementContextRemoveFromChatEvent {
  return (
    event.type === WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT &&
    "detail" in event &&
    typeof (event as CustomEvent<unknown>).detail === "object" &&
    (event as CustomEvent<unknown>).detail !== null
  );
}

export function isWebElementContextPayload(payload: unknown): payload is WebElementContextPayload {
  const candidate = payload as WebElementContextPayload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof candidate.workspacePath === "string" &&
    candidate.workspacePath.length > 0 &&
    (candidate.workspaceIdentity === undefined ||
      typeof candidate.workspaceIdentity === "string") &&
    typeof candidate.pageUrl === "string" &&
    candidate.pageUrl.length > 0 &&
    typeof candidate.pageTitle === "string" &&
    typeof candidate.tagName === "string" &&
    candidate.tagName.length > 0 &&
    typeof candidate.capturedAt === "number"
  );
}

function truncateMarkdownValue(value: string | undefined) {
  if (!value) {
    return "";
  }

  const normalized = value.trim();
  return normalized.length > MAX_MARKDOWN_FIELD_LENGTH
    ? `${normalized.slice(0, MAX_MARKDOWN_FIELD_LENGTH)}\n\n[truncated]`
    : normalized;
}

function appendOptionalLine(lines: string[], label: string, value: string | undefined) {
  const normalized = truncateMarkdownValue(value);
  if (normalized) {
    lines.push(`${label}: ${normalized}`);
  }
}

function formatAttributes(attributes: Record<string, string> | undefined) {
  if (!attributes || Object.keys(attributes).length === 0) {
    return "";
  }

  return Object.entries(attributes)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
}

function formatFont(style: WebElementStyleSummary | undefined) {
  if (!style?.fontSize && !style?.fontFamily) {
    return "";
  }
  return [style.fontSize, style.fontFamily].filter(Boolean).join(" ");
}

function buildWebElementContextMarkdown(payload: WebElementContextComposerAttachment) {
  const lines = [
    `## Element ${payload.ordinal}`,
    // 正文里的元素 token 是 [@名称](zcode-element://id)，靠这一行对到这个元素
    ...(payload.inline ? [`Reference: zcode-element://${payload.id}`] : []),
    `URL: ${payload.pageUrl}`,
    `Title: ${payload.pageTitle || "(untitled)"}`,
    `Tag: ${payload.tagName.toLowerCase()}`,
  ];

  appendOptionalLine(lines, "Role", payload.role);
  appendOptionalLine(lines, "Accessible name", payload.accessibleName);
  appendOptionalLine(lines, "Selector", payload.selector);
  appendOptionalLine(lines, "XPath", payload.xpath);
  appendOptionalLine(lines, "Attributes", formatAttributes(payload.attributes));
  appendOptionalLine(lines, "Color", payload.style?.color);
  appendOptionalLine(lines, "Background", payload.style?.backgroundColor);
  appendOptionalLine(lines, "Font", formatFont(payload.style));
  appendOptionalLine(lines, "Font weight", payload.style?.fontWeight);
  appendOptionalLine(lines, "Display", payload.style?.display);

  if (payload.rect) {
    lines.push(
      `Rect: x=${Math.round(payload.rect.x)}, y=${Math.round(payload.rect.y)}, width=${Math.round(payload.rect.width)}, height=${Math.round(payload.rect.height)}`,
    );
  }

  const text = truncateMarkdownValue(payload.text);
  if (text) {
    lines.push("", "Text:", "```", text, "```");
  }

  const nearbyText = truncateMarkdownValue(payload.nearbyText);
  if (nearbyText) {
    lines.push("", "Nearby context:", "```", nearbyText, "```");
  }

  const htmlExcerpt = truncateMarkdownValue(payload.htmlExcerpt);
  if (htmlExcerpt) {
    lines.push("", "HTML excerpt:", "```html", htmlExcerpt, "```");
  }

  return lines.join("\n");
}

export function buildPromptWithWebElementContexts(
  text: string,
  contexts: readonly WebElementContextComposerAttachment[],
) {
  const content = text.trimEnd();
  if (contexts.length === 0) {
    return content.trim();
  }

  const contextBlock = `${WEB_ELEMENT_CONTEXT_BLOCK_TITLE}\n\n${contexts
    .map((context) => buildWebElementContextMarkdown(context))
    .join("\n\n")}`;

  return `${content}${content ? "\n\n" : ""}${contextBlock}`.trim();
}

function readField(rawItem: string, label: string) {
  const match = new RegExp(`^${label}:\\s*(.*)$`, "m").exec(rawItem);
  return match?.[1]?.trim() ?? "";
}

function readFencedSection(rawItem: string, label: string) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `${escapedLabel}:\\s*\\n\`\`\`(?:html)?\\n([\\s\\S]*?)\\n\`\`\``,
    "m",
  ).exec(rawItem);
  return match?.[1]?.trim() ?? "";
}

function parseFontSummary(font: string): Pick<WebElementStyleSummary, "fontFamily" | "fontSize"> {
  const match = /^([0-9.]+(?:px|rem|em|pt|%))\s+(.+)$/iu.exec(font);
  if (!match) {
    return {
      fontFamily: font,
    };
  }
  const fontSize = match[1];
  const fontFamily = match[2];
  if (!fontSize || !fontFamily) {
    return {
      fontFamily: font,
    };
  }

  return {
    fontSize,
    fontFamily,
  };
}

function readStyleSummary(rawItem: string): WebElementStyleSummary | undefined {
  const color = readField(rawItem, "Color");
  const backgroundColor = readField(rawItem, "Background");
  const font = readField(rawItem, "Font");
  const fontWeight = readField(rawItem, "Font weight");
  const display = readField(rawItem, "Display");
  const style: WebElementStyleSummary = {
    ...(color ? { color } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(font ? parseFontSummary(font) : {}),
    ...(fontWeight ? { fontWeight } : {}),
    ...(display ? { display } : {}),
  };

  return Object.keys(style).length > 0 ? style : undefined;
}

function parseElementItem(
  rawItem: string,
  index: number,
  workspacePath: string,
  workspaceIdentity?: string,
): WebElementContextComposerAttachment | null {
  const pageUrl = readField(rawItem, "URL");
  const pageTitle = readField(rawItem, "Title");
  const tagName = readField(rawItem, "Tag");

  if (!pageUrl || !tagName) {
    return null;
  }
  const ordinal = Number(/^## Element\s+(\d+)/u.exec(rawItem)?.[1] ?? index + 1);
  // 设计稿元素 token 的引用块带 Reference 行：正文里已经是 token，按原 id 还原成 inline 引用
  const referenceId = /^zcode-element:\/\/(\S+)$/u.exec(readField(rawItem, "Reference"))?.[1];

  return {
    id: referenceId ?? `parsed-web-element-${index + 1}-${tagName}`,
    ...(referenceId ? { inline: true } : {}),
    ordinal,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    pageUrl,
    pageTitle: pageTitle === "(untitled)" ? "" : pageTitle,
    tagName,
    role: readField(rawItem, "Role") || undefined,
    accessibleName: readField(rawItem, "Accessible name") || undefined,
    selector: readField(rawItem, "Selector") || undefined,
    xpath: readField(rawItem, "XPath") || undefined,
    text: readFencedSection(rawItem, "Text") || undefined,
    nearbyText: readFencedSection(rawItem, "Nearby context") || undefined,
    htmlExcerpt: readFencedSection(rawItem, "HTML excerpt") || undefined,
    style: readStyleSummary(rawItem),
    capturedAt: 0,
  };
}

export function parsePromptWebElementContexts(
  content: string,
  options: {
    workspacePath: string;
    workspaceIdentity?: string;
  },
): ParsedWebElementContextPrompt {
  const blockMatch = /(?:^|\n\n)# Web page elements:\s*\n\n([\s\S]*?)\s*$/.exec(content);
  if (!blockMatch || blockMatch.index < 0) {
    return {
      visibleContent: content,
      webElementContexts: [],
    };
  }

  const rawBlock = blockMatch[1];
  if (rawBlock === undefined) {
    return {
      visibleContent: content,
      webElementContexts: [],
    };
  }

  const rawItems = rawBlock
    .split(/\n(?=## Element(?:\s+\d+)?\n)/)
    .map((item) => item.trim())
    .filter(Boolean);
  const webElementContexts = rawItems
    .map((item, index) =>
      parseElementItem(item, index, options.workspacePath, options.workspaceIdentity),
    )
    .filter((item): item is WebElementContextComposerAttachment => item !== null);

  if (webElementContexts.length === 0) {
    return {
      visibleContent: content,
      webElementContexts: [],
    };
  }

  return {
    visibleContent: content.slice(0, blockMatch.index).trimEnd(),
    webElementContexts,
  };
}

/**
 * 返回是否有输入框收下（收下的 composer 会 preventDefault）。
 * updateOnly：只更新已有的同 id 引用（如稍后补上的截图），输入框里没有这条就忽略，不当成新引用加进来。
 */
export function dispatchWebElementContextAddToChat(
  payload: WebElementContextPayload,
  options: { updateOnly?: boolean } = {},
): boolean {
  return !window.dispatchEvent(
    new CustomEvent(WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT, {
      cancelable: true,
      detail: options.updateOnly
        ? { ...payload, [WEB_ELEMENT_CONTEXT_UPDATE_ONLY]: true }
        : payload,
    }),
  );
}

export function dispatchWebElementContextRemoveFromChat(payload: {
  id: string;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  window.dispatchEvent(
    new CustomEvent(WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT, {
      detail: payload,
    }),
  );
}

/**
 * composer 删掉引用后广播（按 workspace 区分）。reason：user 是用户点了删除（浏览器取消对应选中），
 * sent 是随消息发出去了（浏览器只忘掉这些引用，选中留着，再点同一元素会重新引用）。
 */
export function dispatchWebElementContextsRemoved(payload: {
  ids: string[];
  reason: "user" | "sent";
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  if (payload.ids.length === 0) return;
  window.dispatchEvent(new CustomEvent(WEB_ELEMENT_CONTEXTS_REMOVED_EVENT, { detail: payload }));
}

export function subscribeWebElementContextsRemoved(
  target: { workspacePath: string; workspaceIdentity?: string },
  onRemoved: (ids: string[], reason: "user" | "sent") => void,
): () => void {
  const key = getWebElementContextWorkspaceKey(target.workspacePath, target.workspaceIdentity);
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail as
      | { ids?: unknown; reason?: unknown; workspacePath?: unknown; workspaceIdentity?: unknown }
      | undefined;
    if (!detail || !Array.isArray(detail.ids) || typeof detail.workspacePath !== "string") return;
    const identity =
      typeof detail.workspaceIdentity === "string" ? detail.workspaceIdentity : undefined;
    if (getWebElementContextWorkspaceKey(detail.workspacePath, identity) !== key) return;
    onRemoved(
      detail.ids.filter((id): id is string => typeof id === "string"),
      detail.reason === "user" ? "user" : "sent",
    );
  };
  window.addEventListener(WEB_ELEMENT_CONTEXTS_REMOVED_EVENT, handle);
  return () => window.removeEventListener(WEB_ELEMENT_CONTEXTS_REMOVED_EVENT, handle);
}
