export const SSH_FORMAL_SPEC_GLOB: string;
export const MANUAL_REVIEW_SPEC_GLOB: string;

export function hasRequiredSshE2EEnvironment(env: Record<string, string | undefined>): boolean;

export function isSshFormalSpec(spec: string): boolean;

export function isFormalSpecAdmittedByEnvironment(
  spec: string,
  env: Record<string, string | undefined>,
): boolean;

export function resolveEnvironmentGatedFormalSpecExcludes(options: {
  env: Record<string, string | undefined>;
  targeted: boolean;
}): string[];

export function isExplicitE2ESpecSelection(specs: readonly string[]): boolean;
