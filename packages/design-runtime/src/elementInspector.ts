import type {
  DesignEditableValues,
  DesignElementKind,
  PageElementRect,
  PageElementSnapshot,
  PageElementStyleSummary,
} from "./contract.js";

// 页面侧的元素读取工具：选择元素脚本和设计运行时共用这一份（以前在 webElementPickerScript.ts 里）。
// 它会被 `.toString()` 序列化后在 guest 页面里执行，所以函数体必须自包含：
// 只能用参数和页面全局对象，不能引用本模块的其他绑定（import type 在编译后不存在，可以用）。

export interface ElementInspectorOptions {
  maxTextChars: number;
  maxHtmlChars: number;
  maxAttributeChars: number;
}

export interface ElementInspector {
  collectElement(element: Element): PageElementSnapshot;
  readStyleSummary(element: Element): PageElementStyleSummary;
  readEditableValues(element: Element): DesignEditableValues;
  classifyElement(element: Element): DesignElementKind;
  /** 只含文字和行内文字标签（br、span、strong…）的元素可以原地改字 */
  isTextEditable(element: Element): boolean;
  getUniqueSelector(element: Element): string;
  formatComputedColor(value: string): string;
}

export const DEFAULT_ELEMENT_INSPECTOR_OPTIONS: ElementInspectorOptions = {
  maxTextChars: 4_000,
  maxHtmlChars: 6_000,
  maxAttributeChars: 500,
};

export function createElementInspector(options: ElementInspectorOptions): ElementInspector {
  const truncate = (value: string | null | undefined, maxLength: number) => {
    const normalized = (value ?? "").replace(/\s+/g, " ").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
  };

  const clampColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

  const toHexColor = (red: number, green: number, blue: number) =>
    `#${[red, green, blue]
      .map((channel) => clampColorChannel(channel).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;

  const parseAlpha = (value: string | undefined) => {
    if (!value) return 1;
    if (value.endsWith("%")) return Number(value.slice(0, -1)) / 100;
    return Number(value);
  };

  const formatComputedColor = (value: string) => {
    const normalized = value.trim();
    const match =
      /^rgba?\(\s*([0-9.]+)(?:,|\s)+([0-9.]+)(?:,|\s)+([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/iu.exec(
        normalized,
      );
    if (!match) return normalized;
    const redValue = match[1];
    const greenValue = match[2];
    const blueValue = match[3];
    if (!redValue || !greenValue || !blueValue) return normalized;
    const red = Number(redValue);
    const green = Number(greenValue);
    const blue = Number(blueValue);
    const alpha = parseAlpha(match[4]);
    if ([red, green, blue, alpha].some((channel) => Number.isNaN(channel))) return normalized;
    if (alpha <= 0) return "transparent";
    return toHexColor(red, green, blue);
  };

  const readStyleSummary = (element: Element): PageElementStyleSummary => {
    const style = window.getComputedStyle(element);
    const backgroundColor = formatComputedColor(style.backgroundColor);
    return {
      ...(backgroundColor !== "transparent" ? { backgroundColor } : {}),
      color: formatComputedColor(style.color),
      display: style.display,
      fontFamily: truncate(style.fontFamily, 160),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
    };
  };

  const cssEscape = (value: string) => {
    const escape = (window.CSS as { escape?: (input: string) => string } | undefined)?.escape;
    if (escape) return escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };

  const readElementText = (element: Element) => {
    if (element instanceof HTMLInputElement) {
      if (element.type.toLowerCase() === "password") return "[masked password input]";
      return truncate(
        element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.name ||
          element.type,
        options.maxTextChars,
      );
    }
    if (element instanceof HTMLTextAreaElement) {
      return truncate(
        element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.name ||
          "textarea",
        options.maxTextChars,
      );
    }
    return truncate(
      (element as HTMLElement).innerText || element.textContent,
      options.maxTextChars,
    );
  };

  const getImplicitRole = (element: Element) => {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "button") return "button";
    if (tagName === "a" && element.hasAttribute("href")) return "link";
    if (tagName === "img") return "img";
    if (tagName === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "textbox";
    }
    if (tagName === "textarea") return "textbox";
    if (tagName === "select") return "combobox";
    if (tagName === "nav") return "navigation";
    if (tagName === "main") return "main";
    if (tagName === "form") return "form";
    if (/^h[1-6]$/u.test(tagName)) return "heading";
    return "";
  };

  const getAccessibleName = (element: Element) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const normalizedLabel = truncate(label, options.maxTextChars);
      if (normalizedLabel) return normalizedLabel;
    }
    return truncate(
      element.getAttribute("aria-label") ||
        element.getAttribute("alt") ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        readElementText(element),
      options.maxTextChars,
    );
  };

  const getAttributes = (element: Element) => {
    const attributes: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const allowed =
        name === "id" ||
        name === "class" ||
        name === "href" ||
        name === "src" ||
        name === "alt" ||
        name === "title" ||
        name === "name" ||
        name === "type" ||
        name === "placeholder" ||
        name.startsWith("aria-");
      if (!allowed || name === "value") continue;
      attributes[name] = truncate(attribute.value, options.maxAttributeChars);
    }
    return attributes;
  };

  const sameTagIndex = (element: Element) => {
    const parent = element.parentElement;
    if (!parent) return { index: 1, count: 1 };
    const siblings = Array.from(parent.children).filter(
      (sibling) => sibling.tagName === element.tagName,
    );
    return { index: siblings.indexOf(element) + 1, count: siblings.length };
  };

  /** 可读选择器：最近的 id 祖先为锚点，每层带前两个 class，同名兄弟才加 :nth-of-type。 */
  const getReadableSelector = (element: Element) => {
    if (element.id) return `#${cssEscape(element.id)}`;
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      const tagName = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`${tagName}#${cssEscape(current.id)}`);
        break;
      }
      const classNames = Array.from(current.classList)
        .filter(Boolean)
        .slice(0, 2)
        .map((className) => `.${cssEscape(className)}`)
        .join("");
      const { index, count } = sameTagIndex(current);
      parts.unshift(`${tagName}${classNames}${count > 1 ? `:nth-of-type(${index})` : ""}`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };

  /** 从 html 起逐层 :nth-of-type 的完整路径；可读选择器不唯一时用它保证能重新定位到同一个元素。 */
  const getStructuralSelector = (element: Element) => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tagName = current.tagName.toLowerCase();
      if (!current.parentElement) {
        parts.unshift(tagName);
        break;
      }
      parts.unshift(`${tagName}:nth-of-type(${sameTagIndex(current).index})`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };

  const matchesOnly = (selector: string, element: Element) => {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === element;
    } catch {
      return false;
    }
  };

  const getUniqueSelector = (element: Element) => {
    const readable = getReadableSelector(element);
    return matchesOnly(readable, element) ? readable : getStructuralSelector(element);
  };

  const getXPath = (element: Element) => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 12) {
      const tagName = current.tagName.toLowerCase();
      if (!current.parentElement) {
        parts.unshift(`/${tagName}`);
        break;
      }
      parts.unshift(`${tagName}[${sameTagIndex(current).index}]`);
      current = current.parentElement;
    }
    return `/${parts.join("/")}`.replace(/^\/\//u, "/");
  };

  const getNearbyText = (element: Element) => {
    const container =
      element.closest("article, section, main, form, li, tr, dialog") ||
      element.parentElement ||
      element;
    return truncate(
      (container as HTMLElement).innerText || container.textContent,
      options.maxTextChars,
    );
  };

  const getHtmlExcerpt = (element: Element) => {
    const clone = element.cloneNode(true);
    if (!(clone instanceof Element)) return "";
    clone.querySelectorAll("script, style, noscript, template").forEach((node) => {
      node.remove();
    });
    clone.querySelectorAll("input, textarea").forEach((node) => {
      if (node instanceof HTMLInputElement) node.removeAttribute("value");
      if (node instanceof HTMLTextAreaElement) node.textContent = "";
    });
    return truncate(clone.outerHTML, options.maxHtmlChars);
  };

  const rectToPlainObject = (rect: DOMRect): PageElementRect => ({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });

  const collectElement = (element: Element): PageElementSnapshot => ({
    pageUrl: location.href,
    pageTitle: document.title,
    tagName: element.tagName.toLowerCase(),
    role: element.getAttribute("role") || getImplicitRole(element) || undefined,
    accessibleName: getAccessibleName(element) || undefined,
    selector: getUniqueSelector(element),
    xpath: getXPath(element),
    text: readElementText(element) || undefined,
    nearbyText: getNearbyText(element) || undefined,
    htmlExcerpt: getHtmlExcerpt(element) || undefined,
    attributes: getAttributes(element),
    rect: rectToPlainObject(element.getBoundingClientRect()),
    style: readStyleSummary(element),
    capturedAt: Date.now(),
  });

  const readEffectiveBackground = (element: Element) => {
    let current: Element | null = element;
    while (current) {
      const color = formatComputedColor(window.getComputedStyle(current).backgroundColor);
      if (color !== "transparent" && color.startsWith("#")) return color;
      current = current.parentElement;
    }
    return null;
  };

  const INLINE_TEXT_TAGS = /^(BR|SPAN|EM|STRONG|B|I|U|S|SMALL|MARK|SUB|SUP|CODE|ABBR|TIME)$/u;
  const isTextEditable = (element: Element): boolean =>
    element instanceof HTMLElement &&
    !/^(INPUT|TEXTAREA|SELECT|IMG|SVG|VIDEO|CANVAS|IFRAME)$/u.test(element.tagName) &&
    Array.from(element.children).every(
      (child) =>
        INLINE_TEXT_TAGS.test(child.tagName) &&
        Array.from(child.children).every((grandchild) => grandchild.tagName === "BR"),
    ) &&
    element.innerText.trim() !== "";

  const readEditableValues = (element: Element): DesignEditableValues => {
    const style = window.getComputedStyle(element);
    const align =
      style.textAlign === "start" ? "left" : style.textAlign === "end" ? "right" : style.textAlign;
    return {
      text: isTextEditable(element) ? (element.textContent ?? "") : null,
      // 原样给 computed 值（rgb / rgba）：面板要读出不透明度，转十六进制会丢掉 alpha
      color: style.color,
      background: style.backgroundColor,
      backgroundColor: readEffectiveBackground(element),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      textAlign: align,
      borderRadius: style.borderTopLeftRadius,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join(
        " ",
      ),
      opacity: style.opacity,
    };
  };

  const classifyElement = (element: Element): DesignElementKind => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    if (
      tag === "button" ||
      role === "button" ||
      (tag === "input" && /^(button|submit|reset)$/u.test((element as HTMLInputElement).type))
    )
      return "button";
    if (tag === "img" || tag === "svg" || tag === "picture" || tag === "video" || tag === "canvas")
      return "image";
    if (/^h[1-6]$/u.test(tag) || role === "heading") return "heading";
    if (tag === "a") {
      // 有背景色的链接在设计上就是按钮
      const background = formatComputedColor(window.getComputedStyle(element).backgroundColor);
      return background !== "transparent" ? "button" : "link";
    }
    if (isTextEditable(element)) {
      const style = window.getComputedStyle(element);
      // 叶子元素自带背景和圆角（span.btn 一类）也按按钮处理
      const background = formatComputedColor(style.backgroundColor);
      const bordered = style.borderTopStyle !== "none" && parseFloat(style.borderTopWidth) > 0;
      if ((background !== "transparent" || bordered) && parseFloat(style.borderTopLeftRadius) > 0)
        return "button";
      return "text";
    }
    return "container";
  };

  return {
    collectElement,
    readStyleSummary,
    readEditableValues,
    classifyElement,
    isTextEditable,
    getUniqueSelector,
    formatComputedColor,
  };
}

/** 序列化成页面里可执行的表达式；求值结果是 ElementInspector。 */
export function buildElementInspectorExpression(
  options: Partial<ElementInspectorOptions> = {},
): string {
  return `(${createElementInspector.toString()})(${JSON.stringify({
    ...DEFAULT_ELEMENT_INSPECTOR_OPTIONS,
    ...options,
  })})`;
}
