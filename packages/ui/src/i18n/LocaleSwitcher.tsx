import { useCallback } from "react";
import { SUPPORTED_LOCALES, type Locale } from "@zcode/shared";
import { TID_LOCALE_TOGGLE } from "@zcode/shared/test-ids";
import { useZCodeIntl } from "./IntlProvider.js";

/** 按钮上的短标签用各语言本名缩写，不随界面语言翻译。 */
const LOCALE_LABELS: Record<Locale, string> = {
  "zh-CN": "中",
  "en-US": "En",
  "ja-JP": "日",
  "ru-RU": "Ру",
  "ko-KR": "한",
};

/**
 * 语言切换按钮 —— 点击按 SUPPORTED_LOCALES 顺序循环切换语言
 */
export function LocaleSwitcher() {
  const { intl, locale, setLocale } = useZCodeIntl();

  const cycleLocale = useCallback(() => {
    const idx = SUPPORTED_LOCALES.indexOf(locale);
    const next = SUPPORTED_LOCALES[(idx + 1) % SUPPORTED_LOCALES.length] ?? SUPPORTED_LOCALES[0];
    setLocale(next);
  }, [locale, setLocale]);

  return (
    <button
      onClick={cycleLocale}
      data-testid={TID_LOCALE_TOGGLE}
      lang={locale}
      className="cursor-pointer rounded-lg bg-btn-alt-bg px-3 py-1 text-ui-base text-btn-alt-text transition hover:bg-surface-raised"
      title={intl.formatMessage({ id: "locale.switchLanguage" })}
    >
      {LOCALE_LABELS[locale]}
    </button>
  );
}
