import type {
  DesignCssVariable,
  DesignInteractionMode,
  DesignPageInfo,
  DesignPageSignals,
  DesignRuntimeCommand,
  DesignRuntimeEvent,
  DesignRuntimeReply,
  DesignSelectedElement,
  DesignSourcePath,
  PageElementRect,
} from "./contract.js";
import type { ElementInspector } from "./elementInspector.js";

// 注入 guest 页面的设计运行时（docs/browser-use/2026-11-03-browser-design-mode-spec.md）。
// 和 createElementInspector 一样经 `.toString()` 序列化执行，函数体必须自包含。
// 页面状态（选中框、预览）只是投影：选中集合、样式改动、CSS 变量、当前方案的 owner 是宿主，页面刷新后由宿主重新推送。
// 页面 → 宿主：`window.postMessage({ [bridgeKey]: 1, events })`，由内置浏览器固定 guest preload 校验后
// sendToHost 转给宿主；宿主 → 页面：executeJavaScript 调 run(command)。

export interface DesignRuntimeInstallOptions {
  version: string;
  /** postMessage 信封上的命名空间键；preload 只转发带这个键的消息 */
  bridgeKey: string;
  maxCssVariables: number;
}

export function installDesignRuntime(
  options: DesignRuntimeInstallOptions,
  inspector: ElementInspector,
  readSignals: (maxCount: number) => DesignPageSignals,
): DesignRuntimeReply<DesignPageInfo> {
  const stateKey = "__zcodeDesignRuntime";
  type RuntimeHandle = {
    version: string;
    run: (command: DesignRuntimeCommand) => DesignRuntimeReply;
  };
  const globals = window as unknown as Record<string, RuntimeHandle | undefined>;
  const existing = globals[stateKey];
  if (existing?.version === options.version) {
    return existing.run({ type: "read-info" }) as DesignRuntimeReply<DesignPageInfo>;
  }
  existing?.run({ type: "dispose" });

  // ---- 页面 → 宿主：发给自己窗口，固定 preload 在隔离世界里收下并转给宿主 ----
  const emit = (event: DesignRuntimeEvent) => {
    window.postMessage({ [options.bridgeKey]: 1, events: [event] }, "*");
  };

  // ---- 浮层：放进 closed shadow root，页面样式影响不到，也不参与命中测试 ----
  const host = document.createElement("div");
  host.setAttribute("data-zcode-design-runtime", "");
  Object.assign(host.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "0",
    height: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  const shadow = host.attachShadow({ mode: "closed" });
  const sheet = document.createElement("style");
  sheet.textContent = [
    ".box{position:fixed;box-sizing:border-box;border-radius:4px;pointer-events:none;display:none}",
    ".hover{border:2px solid #2563eb;background:rgba(37,99,235,.10)}",
    ".selected{border:2px solid #7c3aed;background:rgba(124,58,237,.08)}",
    // 多选时的序号：贴在选中框左上角外侧（放不下时放进框里），压在所有框上面，不会被后画的框盖住
    ".badge{position:fixed;display:none;z-index:2;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;",
    "border-radius:4px;background:#7c3aed;color:#fff;font:600 11px/18px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;",
    "text-align:center;white-space:nowrap;pointer-events:none}",
  ].join("");
  const createBox = (className: string) => {
    const box = document.createElement("div");
    box.className = `box ${className}`;
    shadow.append(box);
    return box;
  };
  shadow.append(sheet);
  const hoverBox = createBox("hover");
  // 选中框按需加：每个选中元素一个框 + 一个序号
  const selectedBoxes: Array<{ box: HTMLElement; badge: HTMLElement }> = [];
  const selectedBox = (index: number) => {
    while (selectedBoxes.length <= index) {
      const badge = document.createElement("div");
      badge.className = "badge";
      shadow.append(badge);
      selectedBoxes.push({ box: createBox("selected"), badge });
    }
    return selectedBoxes[index]!;
  };
  document.documentElement.append(host);

  let mode: DesignInteractionMode = "off";
  let hovered: Element | null = null;
  /** 选中集合，最后一个是主选中（属性面板显示它的值） */
  let selected: Element[] = [];
  const primary = () => selected[selected.length - 1] ?? null;
  // 被覆盖前页面自己的内联值：撤销时原样恢复（含 !important），原本没有才删（!3450 CR-03）
  const cssVariableOriginals = new Map<string, { value: string; priority: string } | null>();
  let variantStyle: HTMLStyleElement | null = null;
  let activeVariant: string | null = null;
  let currentSlide = 0;
  let layoutFrame = 0;
  // 每份文档装一次运行时：同地址刷新或导航回来也会换一个新令牌。页面被放进往返缓存（BFCache）时也换：
  // 从缓存恢复的是同一份文档、同一个闭包，不换的话异步操作前后读到的令牌会重新对上（!3450 需要确认）
  const newDocumentToken = () =>
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let documentToken = newDocumentToken();
  const handlePageHide = () => {
    documentToken = newDocumentToken();
  };

  const isOwnNode = (node: EventTarget | null) => node === host;
  const queryOne = (selector: string) => {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };

  const placeBox = (box: HTMLElement, element: Element | null) => {
    const rect = element?.isConnected ? element.getBoundingClientRect() : null;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      box.style.display = "none";
      return;
    }
    Object.assign(box.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };

  const slides = () => Array.from(document.querySelectorAll("section.slide"));
  const readCurrentSlide = (list: Element[]) => {
    const middle = window.innerHeight / 2;
    const index = list.findIndex((slide) => {
      const rect = slide.getBoundingClientRect();
      return rect.top <= middle && rect.bottom > middle;
    });
    return index >= 0 ? index : currentSlide;
  };

  const visibleRect = (element: Element | null) => {
    const rect = element?.isConnected ? element.getBoundingClientRect() : null;
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    if (
      rect.bottom < 0 ||
      rect.right < 0 ||
      rect.top > window.innerHeight ||
      rect.left > window.innerWidth
    )
      return null;
    return rect;
  };
  const layout = () => {
    layoutFrame = 0;
    placeBox(hoverBox, mode === "off" ? null : hovered);
    const showBoxes = mode === "select";
    selected = selected.filter((element) => element.isConnected);
    for (let index = 0; index < Math.max(selected.length, selectedBoxes.length); index += 1) {
      const { box, badge } = selectedBox(index);
      const element = showBoxes ? (selected[index] ?? null) : null;
      placeBox(box, element);
      const rect = selected.length > 1 ? visibleRect(element) : null;
      badge.style.display = rect ? "block" : "none";
      if (rect) {
        badge.textContent = String(index + 1);
        const outside = rect.top >= 20;
        Object.assign(badge.style, {
          left: `${Math.max(0, rect.left)}px`,
          top: `${outside ? rect.top - 20 : rect.top + 2}px`,
        });
      }
    }
    const list = slides();
    const slideIndex = readCurrentSlide(list);
    if (list.length > 0 && slideIndex !== currentSlide) {
      currentSlide = slideIndex;
      emit({ type: "slide-changed", index: slideIndex, count: list.length });
    }
  };
  const scheduleLayout = () => {
    if (!layoutFrame) layoutFrame = window.requestAnimationFrame(layout);
  };

  // 页面背景：<html>、<body>，以及从 body 一路唯一子元素下来、和 body 一样大的外层容器（设计稿常把整页底色画在这里）。
  // 点它不选中、悬停也不画框，否则一点空白处就选中整页、盖住想调的元素（11-05 体验反馈）。按住 Option / Alt 仍能选中它改底色。
  const LAYOUT_TAGS = new Set([
    "DIV",
    "MAIN",
    "SECTION",
    "ARTICLE",
    "ASIDE",
    "HEADER",
    "FOOTER",
    "NAV",
    "FORM",
  ]);
  const isLayoutContainer = (element: Element) =>
    LAYOUT_TAGS.has(element.tagName) &&
    !Array.from(element.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
    );
  const backdropChain = (): Element[] => {
    const body = document.body;
    if (!body) return [document.documentElement];
    const chain: Element[] = [document.documentElement, body];
    const bodyRect = body.getBoundingClientRect();
    let node: Element = body;
    while (true) {
      const children = sourceChildren(node);
      if (children.length !== 1) return chain;
      const child = children[0]!;
      // 只穿过布局容器：标题、段落、按钮、图片这类内容，或自己直接带文字的元素，是用户要选的东西，不是背景（!3450 CR-03）
      if (!isLayoutContainer(child)) return chain;
      const rect = child.getBoundingClientRect();
      if (
        Math.abs(rect.width - bodyRect.width) > 2 ||
        Math.abs(rect.height - bodyRect.height) > 2
      ) {
        return chain;
      }
      chain.push(child);
      node = child;
    }
  };
  // 舞台式页面：页面底色上摆着几块自带底色的画板（常见是并排的手机稿），而直接落在底色上的文字在深色画布上也看得清。
  // 设计模式里把这层底色在预览里设成透明，画板直接落在宿主的画布上，不再「画布里套一块页面底」（11-05 体验反馈）。
  // 落地页这类整页就是画板的（深色标题直接压在浅底上）不算，保持原样。只改预览，不动源码。
  const hasOwnBackground = (element: Element) => {
    const style = getComputedStyle(element);
    return (
      style.backgroundImage !== "none" ||
      !/^rgba\(.*,\s*0\)$|^transparent$/u.test(style.backgroundColor)
    );
  };
  const isLightColor = (color: string) => {
    const [r = 0, g = 0, b = 0, a = 1] = (color.match(/[\d.]+/gu) ?? []).map(Number);
    return a === 0 || (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55;
  };
  const STAGE_SCAN_LIMIT = 3000;
  const findBoards = (): Element[] => {
    const boards: Element[] = [];
    const elements = document.body ? document.body.querySelectorAll("*") : [];
    for (let index = 0; index < elements.length && index < STAGE_SCAN_LIMIT; index += 1) {
      const element = elements[index]!;
      if (isOwnElement(element) || boards.some((board) => board.contains(element))) continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.width >= 160 &&
        rect.height >= 160 &&
        rect.width <= window.innerWidth * 0.7 &&
        hasOwnBackground(element)
      ) {
        boards.push(element);
      }
    }
    return boards;
  };
  // 不在画板里的文字都要在深色画布上看得清（文字所在元素往上找到画板或有底色的元素之前，都算落在页面底上）
  const textOnBackdropIsLight = (boards: Element[], chain: Element[]) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let count = 0; count < STAGE_SCAN_LIMIT; count += 1) {
      const node = walker.nextNode();
      if (!node) return true;
      const parent = node.parentElement;
      // 没渲染出来的文字（display: none 的说明、<script> 源码）不算
      if (!parent || !node.textContent?.trim() || parent.getClientRects().length === 0) continue;
      if (boards.some((board) => board.contains(parent))) continue;
      // 往上找最近的有底色元素；找到的是背景链里的（马上要设成透明），文字就等于直接压在画布上（!3450 CR-01）
      let painted: Element | null = parent;
      while (painted && !chain.includes(painted) && !hasOwnBackground(painted)) {
        painted = painted.parentElement;
      }
      const onBackdrop = !painted || chain.includes(painted);
      if (onBackdrop && !isLightColor(getComputedStyle(parent).color)) return false;
    }
    return true;
  };
  let stageBoards: Element[] = [];
  // 舞台页里的页面背景：html / body / 撑满的外层容器，以及包着画板、自己没有底色的布局容器
  const isPageBackdrop = (element: Element) =>
    backdropChain().includes(element) ||
    (stageBoards.length > 0 &&
      !stageBoards.some((board) => board.contains(element)) &&
      stageBoards.some((board) => element.contains(board)) &&
      !hasOwnBackground(element));
  // 按页面原始底色判断：先撤掉自己注入的透明样式，否则下一次判断会把上一次的结果当成页面本来的样子（!3450 CR-01）
  const stageBackdrop = (): Element[] | null => {
    stageStyle.remove();
    const chain = backdropChain();
    const boards = findBoards().filter((board) => !chain.includes(board));
    // 内容要滚动（超出视口）就不算舞台页：页面底透明后视口边界看不见，超出视口的画板会像被凭空截断（11-05 实机）
    const root = document.documentElement;
    const fitsViewport =
      root.scrollHeight <= window.innerHeight + 1 && root.scrollWidth <= window.innerWidth + 1;
    stageBoards =
      fitsViewport && boards.length > 0 && textOnBackdropIsLight(boards, chain) ? boards : [];
    return stageBoards.length > 0 ? chain : null;
  };
  const stageStyle = document.createElement("style");
  stageStyle.setAttribute("data-zcode-design-runtime", "");
  const backdropSelector = (element: Element): string => {
    if (element === document.documentElement) return "html";
    if (element === document.body) return "body";
    const parent = element.parentElement!;
    return `${backdropSelector(parent)} > :nth-child(${Array.from(parent.children).indexOf(element) + 1})`;
  };
  let isStage = false;
  const updateStage = () => {
    const chain = stageBackdrop();
    const changed = isStage !== (chain !== null);
    isStage = chain !== null;
    stageStyle.textContent = chain
      ? `${chain.map(backdropSelector).join(",")}{background:transparent!important;box-shadow:none!important}`
      : "";
    if (isStage && !stageStyle.isConnected)
      (document.head ?? document.documentElement).append(stageStyle);
    if (!isStage) stageStyle.remove();
    return changed;
  };
  // resize 后跨过阈值：告诉宿主同步外框与 webview 底色（只影响外观，页面伪造也写不了源码，!3450 CR-02）
  const handleStageResize = () => {
    if (updateStage()) emit({ type: "stage-changed", stageBackdrop: isStage });
  };
  const handleMouseMove = (event: MouseEvent) => {
    if (mode === "off" || isOwnNode(event.target) || !(event.target instanceof Element)) return;
    hovered = !event.altKey && isPageBackdrop(event.target) ? null : event.target;
    scheduleLayout();
  };
  // 点到按钮 / 链接里的文字或图标时，选中按钮本身（设计师心里点的是按钮）
  const meaningfulTarget = (target: Element) =>
    target.closest("button,a,[role=button],label,summary") ?? target;
  const isOwnElement = (element: Element) => element.hasAttribute("data-zcode-design-runtime");
  const sourceChildren = (parent: Element) =>
    Array.from(parent.children).filter((child) => !isOwnElement(child));
  // 元素在源码里的位置：从 <html> 往下每级的标签、序号、兄弟数（运行时自己的节点不算）。
  // 走不到 <html>（shadow DOM 里的元素）时给一级不可能对上的路径，宿主写回时自然找不到。
  const sourcePath = (element: Element): DesignSourcePath => {
    const steps: DesignSourcePath["steps"] = [];
    let node: Element = element;
    while (node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) {
        steps.unshift({ tag: "#detached", index: -1, siblings: -1 });
        break;
      }
      const children = sourceChildren(parent);
      steps.unshift({
        tag: node.tagName.toLowerCase(),
        index: children.indexOf(node),
        siblings: children.length,
      });
      node = parent;
    }
    return { steps, id: element.getAttribute("id"), className: element.getAttribute("class") };
  };
  const describe = (element: Element): DesignSelectedElement => {
    const rect = element.getBoundingClientRect();
    return {
      element: inspector.collectElement(element),
      editable: inspector.readEditableValues(element),
      kind: inspector.classifyElement(element),
      source: sourcePath(element),
      size: { width: Math.round(rect.width), height: Math.round(rect.height) },
      styleAttribute: element.getAttribute("style"),
    };
  };
  const reportSelection = () => {
    emit({ type: "selection-changed", selections: selected.map(describe) });
    scheduleLayout();
  };
  const setSelected = (next: Element[]) => {
    selected = next;
    reportSelection();
  };
  const handleClick = (event: MouseEvent) => {
    if (mode === "off" || !(event.target instanceof Element) || isOwnNode(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const target = meaningfulTarget(event.target);
    // 点到页面背景什么都不变：不选中它，也不清掉已选的（清掉会把输入框里正在描述的元素引用一起撤掉）
    if (!event.altKey && isPageBackdrop(target)) return;
    // Shift + 点击：加进 / 移出选中（像 Figma）；普通点击替换选中
    if (event.shiftKey) {
      setSelected(
        selected.includes(target)
          ? selected.filter((element) => element !== target)
          : [...selected, target],
      );
      return;
    }
    // 已经是唯一选中也重新上报：引用随消息发出后，再点同一元素要能重新引用进输入框（宿主对账，不会重复加）
    setSelected([target]);
  };
  // 点选时按下鼠标不让浏览器开始选文字：Shift + 点击多选会把两次点击之间的文字整段选中（11-05 反馈）
  const handleMouseDown = (event: MouseEvent) => {
    if (mode === "off" || !(event.target instanceof Element) || isOwnNode(event.target)) return;
    event.preventDefault();
  };
  // Bugfix（!3450 CR-01）：页面能伪造发给宿主的消息，所以页面这边不再有任何会引起写回的事件
  //（以前的双击改字 / 拖圆点改留白 / 页面里的 Cmd+Z 都改到宿主侧：面板字段、main 的可信键盘事件）。
  const handleKeyDown = (event: KeyboardEvent) => {
    if (mode === "off" || event.key !== "Escape") return;
    event.preventDefault();
    setMode("off");
    emit({ type: "mode-changed", mode: "off" });
  };
  const setMode = (next: DesignInteractionMode) => {
    mode = next;
    document.documentElement.style.cursor = next === "off" ? "" : "crosshair";
    if (next === "off") hovered = null;
    scheduleLayout();
  };

  const setElementStyle = (selector: string, style: string | null) => {
    const element = queryOne(selector);
    if (!(element instanceof HTMLElement)) return false;
    if (style === null || style === "") element.removeAttribute("style");
    else element.setAttribute("style", style);
    scheduleLayout();
    return true;
  };
  const setElementProperties = (selector: string, styles: Record<string, string>) => {
    const element = queryOne(selector);
    if (!(element instanceof HTMLElement)) return false;
    // 预览也保留原来的 !important，和写回的源码一致（!3450 CR-01）：自己或相关的简写 / 分项带 !important 就按 important 设（SG-01）
    // 与 sourceEdit 的 RELATED_STYLE_PROPERTIES 是同一份；这里随运行时 toString 注入，不能 import
    const related: Record<string, readonly string[]> = {
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
    for (const [property, value] of Object.entries(styles)) {
      const important = [property, ...(related[property] ?? [])].some(
        (name) => element.style.getPropertyPriority(name) === "important",
      );
      element.style.setProperty(property, value, important ? "important" : "");
    }
    scheduleLayout();
    return true;
  };
  const setElementText = (selector: string, text: string) => {
    const element = queryOne(selector);
    if (!(element instanceof HTMLElement)) return false;
    if (element.textContent !== text) element.textContent = text;
    scheduleLayout();
    return true;
  };

  const readCssVariables = (names: readonly string[]): DesignCssVariable[] => {
    const computed = window.getComputedStyle(document.documentElement);
    return names.map((name) => ({ name, value: computed.getPropertyValue(name).trim() }));
  };
  const setCssVariables = (values: Record<string, string>) => {
    const rootStyle = document.documentElement.style;
    for (const [name, original] of cssVariableOriginals) {
      if (name in values) continue;
      if (original) rootStyle.setProperty(name, original.value, original.priority);
      else rootStyle.removeProperty(name);
      cssVariableOriginals.delete(name);
    }
    for (const [name, value] of Object.entries(values)) {
      if (!name.startsWith("--")) continue;
      if (!cssVariableOriginals.has(name)) {
        const existing = rootStyle.getPropertyValue(name);
        cssVariableOriginals.set(
          name,
          existing ? { value: existing, priority: rootStyle.getPropertyPriority(name) } : null,
        );
      }
      // 原值带 !important 时预览也要带，否则盖不过它
      rootStyle.setProperty(name, value, cssVariableOriginals.get(name)?.priority ?? "");
    }
    scheduleLayout();
  };

  const setVariant = (variant: string | null) => {
    variantStyle?.remove();
    variantStyle = null;
    activeVariant = variant;
    if (variant === null) {
      document.documentElement.removeAttribute("data-zcode-active-variant");
    } else {
      variantStyle = document.createElement("style");
      variantStyle.setAttribute("data-zcode-design-runtime", "variant");
      variantStyle.textContent = `body [data-variant]:not([data-variant="${CSS.escape(variant)}"]){display:none !important}`;
      document.head.append(variantStyle);
      document.documentElement.setAttribute("data-zcode-active-variant", variant);
    }
    scheduleLayout();
  };

  const readInfo = (): DesignPageInfo => {
    const list = slides();
    currentSlide = readCurrentSlide(list);
    const signals = readSignals(options.maxCssVariables);
    return {
      pageUrl: location.href,
      pageTitle: document.title,
      isDesignDocument: signals.isDesignDocument,
      variants: signals.variants,
      activeVariant,
      slideCount: list.length,
      currentSlide,
      cssVariables: readCssVariables(signals.cssVariableNames),
      stageBackdrop: (updateStage(), isStage),
    };
  };

  const locateForCapture = (selector: string): PageElementRect | null => {
    const element = queryOne(selector);
    if (!element) return null;
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    host.style.display = "none";
    const box = element.getBoundingClientRect();
    // 标题、段落这类块级文字元素占满整行，文字只在一侧：截文字实际占的范围（四周留一点），
    // 否则截图大半是空白，输入框里按中间裁的缩略图看起来就是一张白图
    if (inspector.isTextEditable(element)) {
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      if (text.width > 0 && text.height > 0 && text.width < box.width * 0.8) {
        const pad = 8;
        const left = Math.max(box.left, text.left - pad);
        const top = Math.max(box.top, text.top - pad);
        const right = Math.min(box.right, text.right + pad);
        const bottom = Math.min(box.bottom, text.bottom + pad);
        return { x: left, y: top, width: right - left, height: bottom - top };
      }
    }
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };

  const observer = new MutationObserver(scheduleLayout);
  const dispose = () => {
    setMode("off");
    setCssVariables({});
    setVariant(null);
    observer.disconnect();
    stageStyle.remove();
    window.removeEventListener("resize", handleStageResize);
    if (layoutFrame) window.cancelAnimationFrame(layoutFrame);
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("mousedown", handleMouseDown, true);
    document.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("scroll", scheduleLayout, true);
    window.removeEventListener("resize", scheduleLayout);
    window.removeEventListener("pagehide", handlePageHide);
    document.documentElement.style.cursor = "";
    host.remove();
    delete globals[stateKey];
  };

  const run = (command: DesignRuntimeCommand): DesignRuntimeReply => {
    switch (command.type) {
      case "set-mode":
        setMode(command.mode);
        return { ok: true, result: null };
      case "set-selection": {
        const elements = command.selectors
          .map(queryOne)
          .filter((element): element is Element => element !== null);
        setSelected(elements);
        return { ok: true, result: null };
      }
      case "set-element-style":
        return { ok: true, result: setElementStyle(command.selector, command.style) };
      case "set-element-properties":
        return { ok: true, result: setElementProperties(command.selector, command.styles) };
      case "set-element-text":
        return { ok: true, result: setElementText(command.selector, command.text) };
      case "select-parent": {
        const current = primary();
        const parent = current?.parentElement;
        if (!current || !parent || parent === document.documentElement || current === document.body)
          return { ok: true, result: false };
        setSelected([...selected.slice(0, -1).filter((element) => element !== parent), parent]);
        return { ok: true, result: true };
      }
      case "set-css-variables":
        setCssVariables(command.values);
        return { ok: true, result: null };
      case "set-variant":
        setVariant(command.variant);
        return { ok: true, result: null };
      case "go-to-slide": {
        const target = slides()[command.index];
        target?.scrollIntoView({ block: "start" });
        return { ok: true, result: Boolean(target) };
      }
      case "locate-for-capture":
        return { ok: true, result: locateForCapture(command.selector) };
      case "end-capture":
        host.style.display = "";
        scheduleLayout();
        return { ok: true, result: null };
      case "read-info":
        return { ok: true, result: readInfo() };
      case "read-document-token":
        return { ok: true, result: documentToken };
      case "dispose":
        dispose();
        return { ok: true, result: null };
      default:
        return { ok: false, reason: "invalid" };
    }
  };

  document.addEventListener("mousemove", handleMouseMove, true);
  document.addEventListener("click", handleClick, true);
  document.addEventListener("mousedown", handleMouseDown, true);
  document.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("scroll", scheduleLayout, { capture: true, passive: true });
  window.addEventListener("resize", scheduleLayout);
  window.addEventListener("resize", handleStageResize);
  window.addEventListener("pagehide", handlePageHide);
  observer.observe(document.documentElement, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  globals[stateKey] = { version: options.version, run };
  return { ok: true, result: readInfo() };
}
