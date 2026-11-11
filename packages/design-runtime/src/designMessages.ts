import type { DesignCssVariable, DesignTweakControl } from "./contract.js";

// 设计相关的纯计算：颜色解析、CSS 变量 → 面板控件。

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

/** 解析 #rgb / #rgba / #rrggbb / #rrggbbaa 与 rgb() / rgba()；忽略透明度 */
export function parseCssColor(value: string): Rgb | null {
  const normalized = value.trim().toLowerCase();
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/u.exec(normalized)?.[1];
  if (hex) {
    const full =
      hex.length <= 4
        ? hex
            .slice(0, 3)
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex.slice(0, 6);
    return {
      red: Number.parseInt(full.slice(0, 2), 16),
      green: Number.parseInt(full.slice(2, 4), 16),
      blue: Number.parseInt(full.slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/u.exec(normalized);
  if (!rgb) return null;
  const [red, green, blue] = [rgb[1], rgb[2], rgb[3]].map(Number);
  if ([red, green, blue].some((channel) => channel === undefined || Number.isNaN(channel))) {
    return null;
  }
  return { red: red ?? 0, green: green ?? 0, blue: blue ?? 0 };
}

/** 颜色的不透明度（0–1）：#rgba / #rrggbbaa 的末位、rgba() 第四个分量；没写就是 1，解析不了也按 1 */
function parseCssAlpha(value: string): number {
  const normalized = value.trim().toLowerCase();
  const hex = /^#([\da-f]{4}|[\da-f]{8})$/u.exec(normalized)?.[1];
  let alpha = 1;
  if (hex) {
    const digits = hex.length === 4 ? `${hex[3]}${hex[3]}` : hex.slice(6);
    alpha = Number.parseInt(digits, 16) / 255;
  } else {
    const raw = /^rgba?\(([^)]+)\)$/u
      .exec(normalized)?.[1]
      ?.split(/[\s,/]+/u)
      .filter(Boolean)[3];
    if (raw !== undefined) alpha = raw.endsWith("%") ? Number.parseFloat(raw) / 100 : Number(raw);
  }
  return Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
}

export function toHexColor(color: Rgb): string {
  return `#${[color.red, color.green, color.blue]
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const NUMERIC_VALUE_RE = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|%|vh|vw)?$/u;

/** 数字框 ↑↓ 一步的大小：rem / em / 小的无单位数按小数走 */
function numberStep(value: number, unit: string | undefined) {
  const magnitude = Math.abs(value);
  if (unit === "rem" || unit === "em") return 0.05;
  if (!unit && magnitude < 10) return magnitude < 2 ? 0.01 : 0.05;
  return 1;
}

/** 由 :root CSS 变量推出数字 / 颜色控件；推不出的值（字体名、渐变等）不出控件。 */
export function buildCssVariableTweakControls(
  variables: readonly DesignCssVariable[],
): DesignTweakControl[] {
  const controls: DesignTweakControl[] = [];
  for (const { name, value } of variables) {
    const color = parseCssColor(value);
    if (color) {
      // 半透明变量保留透明度：面板显示原来的不透明度，只改颜色时写回仍是半透明（!3450 CR-02）
      const alpha = Math.round(parseCssAlpha(value) * 100) / 100;
      const display =
        alpha < 1
          ? `rgba(${color.red}, ${color.green}, ${color.blue}, ${alpha})`
          : toHexColor(color);
      controls.push({ id: name, label: name, type: "color", value: display });
      continue;
    }
    const numeric = NUMERIC_VALUE_RE.exec(value.trim());
    if (!numeric?.[1]) continue;
    const number = Number(numeric[1]);
    const unit = numeric[2];
    controls.push({
      id: name,
      label: name,
      type: "number",
      value: number,
      step: numberStep(number, unit),
      ...(unit ? { unit } : {}),
    });
  }
  return controls;
}

/** 控件值 → CSS 变量值（数字按步长取整并带回单位） */
export function formatTweakValue(control: DesignTweakControl, value: string | number): string {
  if (control.type === "color") return String(value);
  const decimals = String(control.step).split(".")[1]?.length ?? 0;
  return `${Number(Number(value).toFixed(decimals))}${control.unit ?? ""}`;
}
