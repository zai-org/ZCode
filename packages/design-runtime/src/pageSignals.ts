import type { DesignPageSignals } from "./contract.js";

// 读设计稿信号：data-zcode-design 标记、:root / html 规则里声明的 CSS 变量名、data-variant 方案、section.slide。
// 宿主据此决定设计工具要不要自动出现；运行时的 read-info 也用它，两边口径一致。
// 经 `.toString()` 注入页面，函数体只能用参数和页面全局对象。

export function readDesignPageSignals(maxCount: number): DesignPageSignals {
  const cssVariableNames: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (cssVariableNames.length >= maxCount) return;
      if (rule instanceof CSSStyleRule && /(^|,)\s*(:root|html)\s*(,|$)/u.test(rule.selectorText)) {
        for (const property of Array.from(rule.style)) {
          if (cssVariableNames.length >= maxCount) return;
          if (property.startsWith("--") && !cssVariableNames.includes(property)) {
            cssVariableNames.push(property);
          }
        }
      } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
        visit(rule.cssRules);
      }
    }
  };
  for (const styleSheet of Array.from(document.styleSheets)) {
    try {
      visit(styleSheet.cssRules);
    } catch {
      // 跨域样式表不可读，跳过。
    }
  }
  const variants: string[] = [];
  for (const element of Array.from(document.body?.querySelectorAll("[data-variant]") ?? [])) {
    const value = element.getAttribute("data-variant")?.trim();
    if (value && !variants.includes(value)) variants.push(value);
    if (variants.length >= maxCount) break;
  }
  return {
    isDesignDocument: document.documentElement.hasAttribute("data-zcode-design"),
    cssVariableNames,
    variants,
    slideCount: document.querySelectorAll("section.slide").length,
  };
}
