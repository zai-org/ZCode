// ============================================================
// Skills 列表格式（skills_listing 收集器使用）
// ============================================================

import type { SkillMetadata } from "@zcode/contracts";

export const DEFAULT_SKILL_METADATA_BUDGET = 20_000;
const MAX_DESCRIPTION_CHARS = 250;
const SKILLS_LISTING_HEADING = "The following skills are available for use with the Skill tool:";

/** 列表公告正文：完整格式超过预算时，本次所有行降级为名称加路径。增量公告用同一规则。 */
export function buildSkillsContent(skills: readonly SkillMetadata[], budget: number): string {
  const lines = [SKILLS_LISTING_HEADING, ""];

  const sortedSkills = sortSkillsForListing(skills);
  const skillLines = sortedSkills.map((skill) => formatSkillLine(skill));
  const full = [...lines, ...skillLines].join("\n");
  if (full.length <= budget) {
    return full;
  }

  const namesOnly = sortedSkills.map(
    (skill) => `- ${skillDisplayName(skill)}${bareAliasSuffix(skill)} (file: ${skill.path})`,
  );
  return [...lines, ...namesOnly].join("\n");
}

/** 列表的固定顺序：按显示名比较。 */
export function sortSkillsForListing(skills: readonly SkillMetadata[]): SkillMetadata[] {
  return [...skills].sort((a, b) => skillDisplayName(a).localeCompare(skillDisplayName(b)));
}

/** 完整格式的一行；增量公告的指纹按这一行计算，不受预算降级影响。 */
export function formatSkillLine(
  skill: SkillMetadata,
  maxDescriptionChars = MAX_DESCRIPTION_CHARS,
): string {
  const description = skill.whenToUse
    ? `${skill.description} - ${skill.whenToUse}`
    : skill.description;
  const trimmed =
    description.length > maxDescriptionChars
      ? `${description.slice(0, maxDescriptionChars - 1)}...`
      : description;
  return `- ${skillDisplayName(skill)}: ${trimmed}${bareAliasSuffix(skill)} (file: ${skill.path})`;
}

export function skillDisplayName(skill: SkillMetadata): string {
  return skill.qualifiedName ?? skill.name;
}

function bareAliasSuffix(skill: SkillMetadata): string {
  return skill.qualifiedName && skill.qualifiedName !== skill.name
    ? ` (also loadable as ${skill.name})`
    : "";
}
