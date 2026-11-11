import { pinyin } from "pinyin-pro";

function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, "");
}

export function settingsNavigationSearchKeys(labels: readonly string[]): readonly string[] {
  return labels.flatMap((label) => {
    const keys = [normalizeSearchText(label)];
    if (/\p{Script=Han}/u.test(label)) {
      const syllables = pinyin(label, { toneType: "none", type: "array" });
      keys.push(
        normalizeSearchText(syllables.join("")),
        normalizeSearchText(syllables.map((part) => part[0] ?? "").join("")),
      );
    }
    return keys;
  });
}

export function matchesSettingsNavigation(query: string, keys: readonly string[]): boolean {
  const keyword = normalizeSearchText(query);
  if (!keyword) return true;
  return keys.some((key) => {
    let offset = 0;
    for (const character of keyword) {
      const index = key.indexOf(character, offset);
      if (index < 0) return false;
      offset = index + character.length;
    }
    return true;
  });
}
