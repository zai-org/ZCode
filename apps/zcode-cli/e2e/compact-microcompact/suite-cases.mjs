import { backgroundBashCase } from "./case-background-bash.mjs";
import { bashReadStateCase } from "./case-bash-read-state.mjs";
import { readStateHashResumeCase } from "./case-read-state-hash-resume.mjs";
import { microcompactCase } from "./case-microcompact.mjs";
import { autoFullCompactCase, manualFullCompactCase } from "./case-full-compact.mjs";
import { compactPtlRetryCase, reactiveCompactCase } from "./case-fake-compact.mjs";
import { openAiResponsesCompactCase } from "./case-openai-responses-compact.mjs";
import { usageAnchorCase } from "./case-usage-anchor.mjs";
import { outputTokenContinuationCase } from "./case-output-token-continuation.mjs";

const cases = [
  backgroundBashCase,
  bashReadStateCase,
  readStateHashResumeCase,
  microcompactCase,
  manualFullCompactCase,
  autoFullCompactCase,
  compactPtlRetryCase,
  reactiveCompactCase,
  openAiResponsesCompactCase,
  usageAnchorCase,
  outputTokenContinuationCase,
];

export function getCaseDefinitions(caseNames) {
  return caseNames.map((name) => {
    const found = cases.find((caseDef) => caseDef.name === name);
    if (!found) throw new Error(`Unknown case: ${name}`);
    return found;
  });
}
