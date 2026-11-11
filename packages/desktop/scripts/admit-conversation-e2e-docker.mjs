#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { insertVerifiedDockerSpecRow } from "./conversation-docker-plan.mjs";

const desktopDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopDir, "../..");
const conversationDir = resolve(desktopDir, "test/e2e/conversation-session");
const providerFixtureDir = resolve(desktopDir, "test/e2e/fixtures/upstream/conversation-session");
const caseManifestDir = resolve(desktopDir, "test/e2e/fixtures/cases/conversation-session");
const containerScriptPath = resolve(repoRoot, "scripts/test-desktop-e2e-container.sh");
const dockerPlanPath = resolve(
  repoRoot,
  "docs/testing/conversation-session-docker-automation-plan.md",
);
const suiteAssignmentPattern = /^(CONVERSATION_SESSION_VERIFIED_E2E_SPEC=")([^"]*)(")$/m;

const options = parseArgs(process.argv.slice(2));
if (options.help || !options.spec) {
  printUsage();
  process.exit(options.help ? 0 : 1);
}

const result = admit(options);
printResult(result);
process.exit(result.errors.length > 0 ? 1 : 0);

function parseArgs(args) {
  const parsed = {
    apply: false,
    artifact: "",
    help: false,
    spec: "",
    verified: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--" || arg.trim().length === 0) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (arg === "--verified") {
      parsed.verified = true;
      continue;
    }
    if (arg === "--artifact") {
      parsed.artifact = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--artifact=")) {
      parsed.artifact = arg.slice("--artifact=".length);
      continue;
    }
    if (arg === "--spec") {
      parsed.spec = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--spec=")) {
      parsed.spec = arg.slice("--spec=".length);
      continue;
    }
    if (!parsed.spec) {
      parsed.spec = arg;
      continue;
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`Usage:
  pnpm --filter @zcode/desktop e2e:docker:admit -- --spec ./test/e2e/conversation-session/<scenario>/<case>.test.ts --verified --artifact packages/desktop/.e2e-artifacts/<run-id> --apply

Options:
  --apply      Write changes. Without this flag the tool only prints a dry run.
  --verified   Confirm the formal case already passed Docker replay-isolated.
  --artifact   Optional artifact path from the passing Docker run.
`);
}

function admit({ apply, artifact, spec, verified }) {
  const errors = [];
  const warnings = [];
  const actions = [];
  const specPath = resolveSpecPath(spec);
  const fileName = basename(specPath);
  const caseName = fileName.replace(/\.test\.ts$/, "");
  const specRelFromDesktop = `./${relative(desktopDir, specPath).replaceAll("\\", "/")}`;
  const providerFixturePath = resolve(providerFixtureDir, `${caseName}.json`);
  const caseManifestPath = resolve(caseManifestDir, `${caseName}.json`);
  const suite = readConversationDockerSuite({ errors });
  const alreadyInSuite = suite.specs.includes(specRelFromDesktop);
  const alreadyInPlan = dockerPlanIncludes(specRelFromDesktop);

  const relFromConversation = relative(conversationDir, specPath);
  if (relFromConversation.startsWith("..") || isAbsolute(relFromConversation)) {
    errors.push(
      `Spec must be under formal conversation-session dir: ${relative(repoRoot, specPath)}`,
    );
  }
  if (relFromConversation.includes("manual-review/")) {
    errors.push(
      `Manual review specs cannot enter Docker suite directly: ${relative(repoRoot, specPath)}`,
    );
  }
  if (!specPath.endsWith(".test.ts")) {
    errors.push(`Spec must be a .test.ts file: ${specPath}`);
  }
  if (!existsSync(specPath)) {
    errors.push(`Spec not found: ${specPath}`);
  }
  if (!alreadyInSuite && !existsSync(providerFixturePath)) {
    errors.push(`Provider fixture not found: ${relative(repoRoot, providerFixturePath)}`);
  }
  if (alreadyInSuite && !existsSync(providerFixturePath)) {
    warnings.push(
      `Existing Docker suite member has no case-local provider fixture: ${relative(repoRoot, providerFixturePath)}`,
    );
  }
  if (!alreadyInSuite && !existsSync(caseManifestPath)) {
    errors.push(`Case manifest not found: ${relative(repoRoot, caseManifestPath)}`);
  }
  if (alreadyInSuite && !existsSync(caseManifestPath)) {
    warnings.push(
      `Existing Docker suite member has no case manifest: ${relative(repoRoot, caseManifestPath)}`,
    );
  }
  if (apply && !verified) {
    errors.push("Use --verified when applying Docker admission after replay-isolated passes.");
  }
  if (artifact && !existsSync(resolveSpecPath(artifact))) {
    warnings.push(
      `Artifact path was not found locally; keep it in the PR/run record if it is external: ${artifact}`,
    );
  }
  if (!artifact) {
    warnings.push(
      "No --artifact path provided; record the passing Docker artifact path in the PR or run log.",
    );
  }

  if (errors.length === 0) {
    if (alreadyInSuite) {
      actions.push(`Docker suite already contains ${specRelFromDesktop}.`);
    } else {
      actions.push(`Add ${specRelFromDesktop} to conversation-session-verified Docker preset.`);
    }
    if (alreadyInPlan) {
      actions.push(`Docker plan already lists ${specRelFromDesktop}.`);
    } else {
      actions.push(`Add ${specRelFromDesktop} to ${relative(repoRoot, dockerPlanPath)}.`);
    }
  }

  if (apply && errors.length === 0) {
    if (!alreadyInSuite) {
      updateConversationDockerSuite({ specRelFromDesktop, suite });
    }
    if (!alreadyInPlan) {
      updateDockerPlan({ specRelFromDesktop, warnings });
    }
  }

  return {
    actions,
    alreadyInPlan,
    alreadyInSuite,
    apply,
    artifact,
    caseManifestPath,
    caseName,
    errors,
    providerFixturePath,
    specPath,
    specRelFromDesktop,
    warnings,
  };
}

function resolveSpecPath(pathText) {
  if (isAbsolute(pathText)) {
    return pathText;
  }

  const candidates = [
    resolve(process.cwd(), pathText),
    resolve(desktopDir, pathText),
    resolve(repoRoot, pathText),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function readConversationDockerSuite({ errors }) {
  if (!existsSync(containerScriptPath)) {
    errors.push(`Container script not found: ${relative(repoRoot, containerScriptPath)}`);
    return { specs: [], text: "" };
  }

  const text = readFileSync(containerScriptPath, "utf8");
  const match = text.match(suiteAssignmentPattern);
  if (!match) {
    errors.push(
      `Cannot find CONVERSATION_SESSION_VERIFIED_E2E_SPEC in ${relative(repoRoot, containerScriptPath)}`,
    );
    return { specs: [], text };
  }

  return {
    specs: match[2].split(",").filter((entry) => entry.length > 0),
    text,
  };
}

function updateConversationDockerSuite({ specRelFromDesktop, suite }) {
  const nextSpecs = [...suite.specs, specRelFromDesktop];
  const nextLine = `CONVERSATION_SESSION_VERIFIED_E2E_SPEC="${nextSpecs.join(",")}"`;
  writeFileSync(containerScriptPath, suite.text.replace(suiteAssignmentPattern, nextLine), "utf8");
}

function updateDockerPlan({ specRelFromDesktop, warnings }) {
  if (!existsSync(dockerPlanPath)) {
    warnings.push(`Docker plan not found: ${relative(repoRoot, dockerPlanPath)}`);
    return;
  }

  const original = readFileSync(dockerPlanPath, "utf8");
  const updated = insertVerifiedDockerSpecRow(original, specRelFromDesktop);
  if (!updated.inserted && !updated.error) {
    return;
  }
  if (updated.error) {
    warnings.push(`${updated.error} in ${relative(repoRoot, dockerPlanPath)}`);
    return;
  }

  writeFileSync(dockerPlanPath, updated.text, "utf8");
}

function dockerPlanIncludes(specRelFromDesktop) {
  if (!existsSync(dockerPlanPath)) {
    return false;
  }

  const text = readFileSync(dockerPlanPath, "utf8");
  return text.includes(`| \`${specRelFromDesktop}\` |`);
}

function printResult(result) {
  console.log(`${result.apply ? "Apply" : "Dry run"} conversation Docker admission`);
  console.log(`Case: ${result.caseName}`);
  console.log(`Spec: ${relative(repoRoot, result.specPath)}`);
  console.log(`Provider fixture: ${relative(repoRoot, result.providerFixturePath)}`);
  console.log(`Case manifest: ${relative(repoRoot, result.caseManifestPath)}`);

  if (result.artifact) {
    console.log(`Artifact: ${result.artifact}`);
  }

  if (result.actions.length > 0) {
    console.log("\nActions:");
    for (const action of result.actions) {
      console.log(`- ${action}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
  }

  if (result.errors.length > 0) {
    console.log("\nErrors:");
    for (const error of result.errors) {
      console.log(`- ${error}`);
    }
    return;
  }

  const specArg = result.specRelFromDesktop;
  console.log("\nNext:");
  if (!result.alreadyInSuite) {
    console.log(`- E2E_SPEC=${specArg} pnpm run test:e2e:container`);
    console.log(
      `- pnpm --filter @zcode/desktop e2e:docker:admit -- --spec ${specArg} --verified --artifact packages/desktop/.e2e-artifacts/<run-id> --apply`,
    );
  } else if (!result.alreadyInPlan) {
    console.log(
      `- pnpm --filter @zcode/desktop e2e:docker:admit -- --spec ${specArg} --verified --artifact packages/desktop/.e2e-artifacts/<run-id> --apply`,
    );
  }
  console.log("- pnpm run test:e2e:container:conversation");
}
