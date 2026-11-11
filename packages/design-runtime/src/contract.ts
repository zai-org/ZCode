// 设计运行时与宿主之间的数据形状（docs/browser-use/2026-11-03-browser-design-mode-spec.md）。
// 页面侧脚本、宿主 hook、提示词拼装都只依赖这里的类型；不含宿主或 React 依赖。

/** 运行时版本：页面里已装同版本时复用，不同版本先 dispose 再装。 */
export const DESIGN_RUNTIME_VERSION = "22";

/**
 * 宿主解析页面数据时的上限：页面可以伪造任何东西，超长字符串截断、超长数组丢掉多余项，
 * 最终只会变成用户看得见、能删的上下文。
 */
export const DESIGN_PAGE_LIMITS = {
  /** 元素文字、附近文字、HTML 片段 */
  longText: 6_000,
  url: 2_048,
  /** 选择器、XPath、标题、无障碍名、属性值、CSS 变量值 */
  shortText: 500,
  /** 标签名、角色、样式值、CSS 变量名、方案名、属性名 */
  token: 120,
  attributes: 24,
  cssVariables: 24,
  variants: 24,
  /** 多选的元素数、源码路径层数 */
  selection: 32,
  sourceDepth: 64,
  slideCount: 500,
  eventsPerMessage: 32,
} as const;

export interface PageElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageElementStyleSummary {
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  display?: string;
}

/** 页面里一个元素的可读快照；选择元素与设计模式共用（rect 为视口 CSS px）。 */
export interface PageElementSnapshot {
  pageUrl: string;
  pageTitle: string;
  tagName: string;
  role?: string;
  accessibleName?: string;
  selector?: string;
  xpath?: string;
  text?: string;
  nearbyText?: string;
  htmlExcerpt?: string;
  attributes?: Record<string, string>;
  rect?: PageElementRect;
  style?: PageElementStyleSummary;
  capturedAt: number;
}

/**
 * 选中修改可编辑的当前值（computed style），只放设计师常改的几项。
 * text 为 null 表示元素含子元素，不提供改文字。
 */
export interface DesignEditableValues {
  text: string | null;
  color: string;
  /** 元素自己的背景；透明时为 "transparent" */
  background: string;
  /** 向上找到的第一个不透明背景；都透明时为 null（按白色算对比度） */
  backgroundColor: string | null;
  fontSize: string;
  fontWeight: string;
  textAlign: string;
  borderRadius: string;
  /** 四边写全的 "上 右 下 左" */
  padding: string;
  /** computed opacity，0–1 */
  opacity: string;
}

export type DesignEditableProperty = Exclude<keyof DesignEditableValues, "backgroundColor">;

/** 选中元素按设计师的说法归类，决定工具条给哪些控件 */
export type DesignElementKind = "button" | "heading" | "text" | "link" | "image" | "container";

/** 从 `<html>` 往下一级：元素在父元素的元素子节点里排第几（不算运行时自己的节点）、标签、父元素一共几个元素子节点 */
export interface DesignSourceStep {
  tag: string;
  index: number;
  siblings: number;
}

/** 写回源码时找元素用：路径每级对得上、最后一级 id / class 也一样才算找到（sourceEdit） */
export interface DesignSourcePath {
  steps: DesignSourceStep[];
  id: string | null;
  className: string | null;
}

export interface DesignSelectedElement {
  element: PageElementSnapshot;
  editable: DesignEditableValues;
  kind: DesignElementKind;
  source: DesignSourcePath;
  /** 宽高（CSS px，取整），属性面板只读显示 */
  size: { width: number; height: number };
  /** 读取时元素的 style 属性；写回失败时宿主按它把页面上的预览撤回 */
  styleAttribute: string | null;
}

export type DesignInteractionMode = "off" | "select";

export interface DesignCssVariable {
  name: string;
  value: string;
}

/** 决定设计工具要不要自动出现的页面信号（不装运行时也能读） */
export interface DesignPageSignals {
  /** `<html data-zcode-design>` 标记 */
  isDesignDocument: boolean;
  cssVariableNames: string[];
  variants: string[];
  slideCount: number;
}

export interface DesignPageInfo {
  pageUrl: string;
  pageTitle: string;
  /** `<html data-zcode-design>` 标记 */
  isDesignDocument: boolean;
  variants: string[];
  activeVariant: string | null;
  slideCount: number;
  currentSlide: number;
  cssVariables: DesignCssVariable[];
  /** 舞台式页面：整页底色里只摆了几块画板，设计模式里这层底色已在预览里设成透明（宿主据此去掉视口外框和白底） */
  stageBackdrop: boolean;
}

export type DesignRuntimeEvent =
  /** 选中集合变了（点击替换、Shift + 点击增减、选中外层、刷新后按选择器恢复）；最后一个是主选中 */
  | { type: "selection-changed"; selections: DesignSelectedElement[] }
  | { type: "slide-changed"; index: number; count: number }
  /** 页面里按 Esc 退出点选。页面能伪造这些消息，所以这里没有任何会引起写回的事件（!3450 CR-01） */
  | { type: "mode-changed"; mode: DesignInteractionMode }
  /** resize 后舞台式页面的判断变了（只影响宿主外框与底色） */
  | { type: "stage-changed"; stageBackdrop: boolean };

export type DesignRuntimeCommand =
  | { type: "set-mode"; mode: DesignInteractionMode }
  /** 按选择器设选中集合（刷新后恢复、宿主清空）；找不到的跳过，结果为 selection-changed 同形的列表 */
  | { type: "set-selection"; selectors: string[] }
  /** 直接设元素的 style 属性（预览、撤销都走它）；null 表示去掉属性。结果为是否找到 */
  | { type: "set-element-style"; selector: string; style: string | null }
  /** 面板改值时的预览：在元素当前 style 上设几条属性。结果为是否找到 */
  | { type: "set-element-properties"; selector: string; styles: Record<string, string> }
  /** 面板改字的预览、撤销 / 重做时放回文字（textContent，与源码文字一一对应） */
  | { type: "set-element-text"; selector: string; text: string }
  /** 选中当前主选中元素的外层（到 body 为止） */
  | { type: "select-parent" }
  /** 整份替换：不在表里的已设变量会被移除，传空表即还原 */
  | { type: "set-css-variables"; values: Record<string, string> }
  /** null 表示显示全部方案 */
  | { type: "set-variant"; variant: string | null }
  | { type: "go-to-slide"; index: number }
  /** 隐藏全部浮层并把元素滚进视口；结果为元素当前 rect，找不到为 null */
  | { type: "locate-for-capture"; selector: string }
  | { type: "end-capture" }
  | { type: "read-info" }
  /** 当前文档的随机令牌：每装进一份新文档（刷新、导航后回到同一地址）都不同，用来判断异步操作期间页面是否换过 */
  | { type: "read-document-token" }
  | { type: "dispose" };

export type DesignRuntimeReply<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; reason: "missing" | "invalid" };

/** 由 CSS 变量推出的面板控件（数值或颜色） */
export type DesignTweakControl =
  | {
      id: string;
      label: string;
      type: "number";
      value: number;
      step: number;
      unit?: string;
    }
  | { id: string; label: string; type: "color"; value: string };
