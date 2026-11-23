export const DEFAULT_MODEL = "deepseek-v4-flash";
export const DEFAULT_PROVIDER = "deepseek";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const FAKE_MODEL = "compact-e2e-fake-model";
export const FAKE_PROVIDER = "compact-e2e-fake";

export const CASE_NAMES = [
  "background-bash",
  "bash-read-state",
  "read-state-hash-resume",
  "microcompact",
  "manual-full-compact",
  "auto-full-compact",
  "compact-ptl-retry",
  "reactive-compact",
  "openai-responses-compact",
  "usage-anchor",
  "output-token-continuation",
];

export const REAL_CASE_NAMES = ["microcompact", "manual-full-compact", "auto-full-compact"];
export const FAKE_CASE_NAMES = [
  "background-bash",
  "bash-read-state",
  "read-state-hash-resume",
  "compact-ptl-retry",
  "reactive-compact",
  "openai-responses-compact",
  "usage-anchor",
  "output-token-continuation",
];

export const FULL_COMPACT_CONTEXT_WINDOW = 1_000_000;
export const FULL_COMPACT_BUFFER_TOKENS = 1_000;
export const MAX_TURNS = 8;
