import type { Locale, PostUpdateReleaseNotesPayload } from "@zcode/shared";

export type LocalizedUpdateReleaseNotes = {
  title: string;
  markdown: string;
};

export function getLocalizedUpdateReleaseNotes(
  payload: PostUpdateReleaseNotesPayload | undefined,
  locale: Locale,
): LocalizedUpdateReleaseNotes | null {
  if (!payload) {
    return null;
  }

  const defaultReleaseNotes = {
    title: payload.title,
    markdown: payload.markdown,
  };

  return (
    payload.releaseNotesByLocale?.[locale] ??
    // 发版说明只有中英两套；ja-JP/ru-RU/ko-KR 先用英文，不能直接落到中文。
    (locale !== "zh-CN" ? payload.releaseNotesByLocale?.["en-US"] : undefined) ??
    (locale === "zh-CN"
      ? defaultReleaseNotes
      : (payload.releaseNotesByLocale?.["zh-CN"] ?? defaultReleaseNotes))
  );
}

export function formatUpdateReleaseDate(
  releaseDate: string | undefined,
  locale: Locale,
): string | null {
  if (!releaseDate) {
    return null;
  }

  const date = new Date(releaseDate);
  if (Number.isNaN(date.getTime())) {
    return releaseDate;
  }

  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    // update feed 的 releaseDate 通常是 UTC 零点。按用户本地时区格式化会让
    // 美洲等时区显示成前一天，hover 中只展示发布日期时应保持 feed 日期稳定。
    timeZone: "UTC",
  }).format(date);
}
