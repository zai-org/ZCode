import { parseCssColor, toHexColor, type DesignEditableProperty } from "@zcode/design-runtime";

// 属性面板里能改的样式项与页面身份。纯函数，状态在 useBrowserDesignMode。

export type DesignStyleProperty = Exclude<DesignEditableProperty, "text">;

/** 面板项 → 写进 style 属性的 CSS 名 */
export const DESIGN_STYLE_CSS_NAMES: Record<DesignStyleProperty, string> = {
  color: "color",
  background: "background-color",
  fontSize: "font-size",
  fontWeight: "font-weight",
  textAlign: "text-align",
  borderRadius: "border-radius",
  padding: "padding",
  opacity: "opacity",
};

/** 同一页面（忽略 hash）的 key：刷新后是否恢复选中、撤销栈是否作废都按它算 */
export function toDesignPageKey(url: string): string {
  return url.split("#")[0] ?? url;
}

/** 颜色拆成十六进制（不含 alpha）与不透明度百分比；解析不了按黑色 100% */
export function splitColor(value: string): { hex: string; alpha: number } {
  const rgba = /^rgba?\(([^)]+)\)$/iu.exec(value.trim());
  let alpha = 1;
  if (rgba?.[1]) {
    const parts = rgba[1].split(/[\s,/]+/u).filter(Boolean);
    const raw = parts[3];
    if (raw !== undefined) alpha = raw.endsWith("%") ? Number.parseFloat(raw) / 100 : Number(raw);
  } else {
    const hex8 = /^#([0-9a-f]{8})$/iu.exec(value.trim());
    if (hex8?.[1]) alpha = Number.parseInt(hex8[1].slice(6), 16) / 255;
  }
  if (value.trim() === "transparent") alpha = 0;
  const color = parseCssColor(value.trim() === "transparent" ? "#000000" : value);
  return {
    hex: toHexColor(color ?? { red: 0, green: 0, blue: 0 }),
    alpha: Math.round(Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1)) * 100),
  };
}

/** 十六进制 + 不透明度 → 写进样式的颜色：100% 用 #RRGGBB，否则 rgba() */
export function joinColor(hex: string, alpha: number): string {
  if (alpha >= 100) return hex.toUpperCase();
  const color = parseCssColor(hex) ?? { red: 0, green: 0, blue: 0 };
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${Math.max(0, alpha) / 100})`;
}
