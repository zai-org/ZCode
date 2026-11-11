import {
  buildElementInspectorExpression,
  type ElementInspector,
  type ElementInspectorOptions,
  type PageElementSnapshot,
  type PageElementStyleSummary,
} from "@zcode/design-runtime";

// 选择元素的悬停高亮与浮窗；元素读取（选择器、样式、文字等）与设计模式共用 @zcode/design-runtime 的 inspector。
// 本函数经 `.toString()` 注入页面，函数体只能用参数和页面全局对象。

export type WebElementPickerScriptResult =
  | { status: "cancelled" }
  | { status: "selected"; element: PageElementSnapshot };

interface WebElementPickerScriptOptions {
  labels: WebElementPickerScriptLabels;
}

export interface WebElementPickerScriptLabels {
  background: string;
  color: string;
  font: string;
}

type WebElementPickerScriptBuildOptions = Partial<ElementInspectorOptions> & {
  labels?: Partial<WebElementPickerScriptLabels>;
};

const DEFAULT_OPTIONS: WebElementPickerScriptOptions = {
  labels: {
    background: "Background",
    color: "Color",
    font: "Font",
  },
};

function webElementPickerScript(
  options: WebElementPickerScriptOptions,
  inspector: ElementInspector,
) {
  const stateKey = "__zcodeWebElementPicker";
  const existing = (window as unknown as Record<string, { cancel?: () => void }>)[stateKey];
  existing?.cancel?.();

  const truncate = (value: string | null | undefined, maxLength: number) => {
    const normalized = (value ?? "").replace(/\s+/g, " ").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
  };

  const formatFont = (style: PageElementStyleSummary) =>
    truncate([style.fontSize, style.fontFamily].filter(Boolean).join(" "), 96);

  const formatElementSize = (rect: DOMRect) =>
    `${Math.round(rect.width)}x${Math.round(rect.height)}`;

  const hasVisibleBackground = (style: PageElementStyleSummary) =>
    Boolean(
      style.backgroundColor &&
      style.backgroundColor !== "transparent" &&
      style.backgroundColor !== "rgba(0, 0, 0, 0)",
    );

  const overlay = document.createElement("div");
  overlay.setAttribute("data-zcode-web-element-picker", "overlay");
  Object.assign(overlay.style, {
    background: "rgba(37, 99, 235, 0.12)",
    border: "2px solid #2563eb",
    borderRadius: "4px",
    boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.10)",
    boxSizing: "border-box",
    display: "none",
    left: "0",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    zIndex: "2147483647",
  } satisfies Partial<CSSStyleDeclaration>);

  const label = document.createElement("div");
  Object.assign(label.style, {
    backdropFilter: "blur(10px)",
    background: "rgba(17, 24, 39, 0.92)",
    border: "1px solid rgba(255, 255, 255, 0.14)",
    borderRadius: "18px",
    boxShadow: "0 18px 38px rgba(15, 23, 42, 0.28)",
    boxSizing: "border-box",
    color: "#f9fafb",
    display: "none",
    font: "12px/1.4 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    left: "0",
    maxWidth: "calc(100vw - 16px)",
    minWidth: "214px",
    padding: "12px 18px 14px",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    width: "min(320px, calc(100vw - 16px))",
    zIndex: "2147483647",
  } satisfies Partial<CSSStyleDeclaration>);

  document.documentElement.append(overlay, label);

  let hoveredElement: Element | null = null;
  let settled = false;
  let finishPicker: ((result: WebElementPickerScriptResult) => void) | null = null;

  const cleanup = () => {
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("keydown", handleKeyDown, true);
    overlay.remove();
    label.remove();
    delete (window as unknown as Record<string, unknown>)[stateKey];
    document.documentElement.style.cursor = "";
  };

  const appendPopoverRow = (name: string, value: string | undefined) => {
    if (!value) {
      return;
    }

    const row = document.createElement("div");
    Object.assign(row.style, {
      alignItems: "baseline",
      columnGap: "16px",
      display: "grid",
      gridTemplateColumns: "auto minmax(0, 1fr)",
      minWidth: "0",
    } satisfies Partial<CSSStyleDeclaration>);

    const nameNode = document.createElement("span");
    nameNode.textContent = name;
    Object.assign(nameNode.style, {
      color: "rgba(255, 255, 255, 0.62)",
      fontSize: "15px",
      fontWeight: "600",
      minWidth: "0",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    const valueNode = document.createElement("span");
    valueNode.textContent = value;
    Object.assign(valueNode.style, {
      color: "#ffffff",
      fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace",
      fontSize: "15px",
      fontWeight: "700",
      minWidth: "0",
      overflow: "hidden",
      textAlign: "right",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    row.append(nameNode, valueNode);
    label.append(row);
  };

  const renderPopover = (target: Element, rect: DOMRect) => {
    const style = inspector.readStyleSummary(target);
    label.replaceChildren();

    const header = document.createElement("div");
    Object.assign(header.style, {
      alignItems: "baseline",
      columnGap: "16px",
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) auto",
      minWidth: "0",
    } satisfies Partial<CSSStyleDeclaration>);

    const tagNode = document.createElement("span");
    tagNode.textContent = target.tagName.toLowerCase();
    Object.assign(tagNode.style, {
      color: "#ffffff",
      fontSize: "16px",
      fontWeight: "800",
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    const sizeNode = document.createElement("span");
    sizeNode.textContent = formatElementSize(rect);
    Object.assign(sizeNode.style, {
      color: "#ffffff",
      fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace",
      fontSize: "15px",
      fontWeight: "800",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    header.append(tagNode, sizeNode);
    label.append(header);
    appendPopoverRow(options.labels.color, style.color);
    if (hasVisibleBackground(style)) {
      appendPopoverRow(options.labels.background, style.backgroundColor);
    }
    appendPopoverRow(options.labels.font, formatFont(style));
  };

  const clampPosition = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value));

  const getPopoverPosition = (rect: DOMRect, labelWidth: number, labelHeight: number) => {
    const padding = 8;
    const gap = 12;
    const maxLeft = Math.max(padding, window.innerWidth - labelWidth - padding);
    const maxTop = Math.max(padding, window.innerHeight - labelHeight - padding);
    const centeredLeft = rect.left + rect.width / 2 - labelWidth / 2;
    const centeredTop = rect.top + rect.height / 2 - labelHeight / 2;
    const candidates = [
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        top: rect.bottom + gap,
      },
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        top: rect.top - labelHeight - gap,
      },
      {
        left: rect.right + gap,
        top: clampPosition(centeredTop, padding, maxTop),
      },
      {
        left: rect.left - labelWidth - gap,
        top: clampPosition(centeredTop, padding, maxTop),
      },
    ];
    const viewportSafeCandidate = candidates.find(
      (candidate) =>
        candidate.left >= padding &&
        candidate.top >= padding &&
        candidate.left + labelWidth <= window.innerWidth - padding &&
        candidate.top + labelHeight <= window.innerHeight - padding,
    );

    if (viewportSafeCandidate) {
      return viewportSafeCandidate;
    }

    const availableSpaces = [
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        size: window.innerHeight - rect.bottom - padding,
        top: clampPosition(rect.bottom + gap, padding, maxTop),
      },
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        size: rect.top - padding,
        top: clampPosition(rect.top - labelHeight - gap, padding, maxTop),
      },
      {
        left: clampPosition(rect.right + gap, padding, maxLeft),
        size: window.innerWidth - rect.right - padding,
        top: clampPosition(centeredTop, padding, maxTop),
      },
      {
        left: clampPosition(rect.left - labelWidth - gap, padding, maxLeft),
        size: rect.left - padding,
        top: clampPosition(centeredTop, padding, maxTop),
      },
    ].sort((a, b) => b.size - a.size);

    // 交互修正：目标元素靠近边缘或几乎铺满视口时，浮窗无法完全放到元素外侧。
    // 这时选择可用空间最大的方向，并继续夹在视口内，尽量减少对当前选区的遮挡。
    return availableSpaces[0] ?? { left: padding, top: padding };
  };

  const updateOverlay = (target: Element | null) => {
    if (!target || target === overlay || target === label || label.contains(target)) {
      overlay.style.display = "none";
      label.style.display = "none";
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      overlay.style.display = "none";
      label.style.display = "none";
      return;
    }

    overlay.style.display = "block";
    overlay.style.left = `${Math.max(0, rect.left)}px`;
    overlay.style.top = `${Math.max(0, rect.top)}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    label.style.display = "block";
    renderPopover(target, rect);

    const labelWidth = label.offsetWidth || 240;
    const labelHeight = label.offsetHeight || 90;
    const position = getPopoverPosition(rect, labelWidth, labelHeight);
    label.style.left = `${position.left}px`;
    label.style.top = `${position.top}px`;
  };

  function handleMouseMove(event: MouseEvent) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    hoveredElement = target;
    updateOverlay(target);
  }

  function handleClick(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (!hoveredElement) {
      finishPicker?.({ status: "cancelled" });
      return;
    }
    finishPicker?.({
      status: "selected",
      element: inspector.collectElement(hoveredElement),
    });
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    finishPicker?.({ status: "cancelled" });
  }

  return new Promise<WebElementPickerScriptResult>((resolve) => {
    const finish = (result: WebElementPickerScriptResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    finishPicker = finish;

    function cancel() {
      finish({ status: "cancelled" });
    }

    (window as unknown as Record<string, { cancel: () => void }>)[stateKey] = {
      cancel,
    };

    document.documentElement.style.cursor = "crosshair";
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeyDown, true);
  });
}

export function buildWebElementPickerScript({
  labels,
  ...inspectorOptions
}: WebElementPickerScriptBuildOptions = {}) {
  const resolvedOptions: WebElementPickerScriptOptions = {
    labels: { ...DEFAULT_OPTIONS.labels, ...labels },
  };
  return `(${webElementPickerScript.toString()})(${JSON.stringify(resolvedOptions)}, ${buildElementInspectorExpression(inspectorOptions)})`;
}

export function buildCancelWebElementPickerScript() {
  return [
    "(() => {",
    "const picker = window.__zcodeWebElementPicker;",
    "if (picker && typeof picker.cancel === 'function') picker.cancel();",
    "})()",
  ].join("\n");
}
