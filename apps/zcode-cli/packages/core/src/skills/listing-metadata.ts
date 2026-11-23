import type { SkillsListingDelta } from "./contract.js";

export type { SkillsListingDelta };

export function parseSkillsListingDelta(value: unknown): SkillsListingDelta | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { names, fingerprints } = value as Record<string, unknown>;
  if (
    !isStringArray(names) ||
    !isStringArray(fingerprints) ||
    names.length !== fingerprints.length ||
    new Set(fingerprints).size !== fingerprints.length
  )
    return undefined;
  return { names: [...names], fingerprints: [...fingerprints] };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
