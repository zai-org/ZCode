#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import {
  createPromotionCaseManifest,
  createPromotionProviderFixture,
  runPromotionAuditTransaction,
  runPromotionCoverageAudit,
} from "./lib/e2e-promotion-audit-transaction.mjs";
import { rewriteFormalSpecImports } from "./lib/e2e-promotion-spec-imports.mjs";

const desktopDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopDir, "../..");
const conversationDir = resolve(desktopDir, "test/e2e/conversation-session");
const providerFixtureDir = resolve(desktopDir, "test/e2e/fixtures/upstream/conversation-session");
const caseManifestDir = resolve(desktopDir, "test/e2e/fixtures/cases/conversation-session");
const coverageMatrixPath = resolve(
  repoRoot,
  "docs/testing/conversation-session-e2e-coverage-matrix.md",
);
const coverageAuditPath = resolve(repoRoot, "scripts/audit-conversation-session-case-coverage.mjs");

const options = parseArgs(process.argv.slice(2));
if (options.help || !options.spec) {
  printUsage();
  process.exit(options.help ? 0 : 1);
}

const result = await promote(options);
printResult(result);
process.exit(result.errors.length > 0 ? 1 : 0);

function parseArgs(args) {
  const parsed = {
    apply: false,
    force: false,
    help: false,
    reviewed: false,
    spec: "",
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
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg === "--reviewed") {
      parsed.reviewed = true;
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
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`Usage:
  pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/<scenario>/manual-review/pending/<case>.test.ts --reviewed --apply

Options:
  --apply     Write changes. Without this flag the tool only prints a dry run.
  --reviewed  Confirm the pending case has already passed human review.
  --force     Overwrite generated fixture/manifest files if they already exist.
`);
}

async function promote({ apply, force, reviewed, spec }) {
  const errors = [];
  const warnings = [];
  const actions = [];
  let audit = null;
  const sourcePath = resolve(process.cwd(), spec);

  const relSourceFromPending = relative(conversationDir, sourcePath).replaceAll("\\", "/");
  if (
    relSourceFromPending.startsWith("..") ||
    isAbsolute(relSourceFromPending) ||
    !/(?:^|\/)manual-review\/pending\/[^/]+\.test\.ts$/u.test(relSourceFromPending)
  ) {
    errors.push(`Spec must be under manual-review/pending: ${relative(repoRoot, sourcePath)}`);
  }
  if (!sourcePath.endsWith(".test.ts")) {
    errors.push(`Spec must be a .test.ts file: ${sourcePath}`);
  }
  if (!existsSync(sourcePath)) {
    errors.push(`Spec not found: ${sourcePath}`);
  }
  if (apply && !reviewed) {
    errors.push("Use --reviewed when applying promotion after human review.");
  }

  const fileName = basename(sourcePath);
  const caseName = fileName.replace(/\.test\.ts$/, "");
  const targetPath = resolve(
    conversationDir,
    relSourceFromPending.replace(/(?:^|\/)manual-review\/pending\//u, (match) =>
      match.startsWith("/") ? "/" : "",
    ),
  );
  const providerFixturePath = resolve(providerFixtureDir, `${caseName}.json`);
  const caseManifestPath = resolve(caseManifestDir, `${caseName}.json`);
  const specRelFromDesktop = `./${relative(desktopDir, targetPath).replaceAll("\\", "/")}`;
  const pendingRelFromRepo = relative(repoRoot, sourcePath).replaceAll("\\", "/");
  const targetRelFromRepo = relative(repoRoot, targetPath).replaceAll("\\", "/");

  validateExistingFixtureIdentity(
    {
      caseName,
      filePath: providerFixturePath,
      specRelFromDesktop,
    },
    errors,
  );
  validateExistingFixtureIdentity(
    {
      caseName,
      filePath: caseManifestPath,
      specRelFromDesktop,
    },
    errors,
  );

  if (existsSync(targetPath)) {
    errors.push(`Target spec already exists: ${targetPath}`);
  }

  const markerSummary = existsSync(sourcePath)
    ? extractE2EMarkers(readFileSync(sourcePath, "utf8"))
    : [];

  if (errors.length === 0) {
    actions.push(
      `Move spec: ${relative(repoRoot, sourcePath)} -> ${relative(repoRoot, targetPath)}`,
    );
    actions.push(
      "Rewrite common pending helper, page, and file fixture paths for the formal spec location.",
    );
    actions.push(`Create provider fixture scaffold: ${relative(repoRoot, providerFixturePath)}`);
    actions.push(`Create case manifest scaffold: ${relative(repoRoot, caseManifestPath)}`);
    actions.push(`Update coverage matrix path: ${pendingRelFromRepo} -> ${targetRelFromRepo}`);
    actions.push(
      "Run pnpm audit:conversation-session-coverage and keep the promotion only if it passes.",
    );
  }

  if (!reviewed) {
    warnings.push(
      "This dry run did not include --reviewed; do not apply until human review is complete.",
    );
  }
  if (markerSummary.length === 0) {
    warnings.push("No E2E_* marker found in spec; fixture matching may be too broad.");
  }

  if (apply && errors.length === 0) {
    try {
      const transaction = await runPromotionAuditTransaction({
        affectedPaths: [
          sourcePath,
          targetPath,
          providerFixturePath,
          caseManifestPath,
          coverageMatrixPath,
        ],
        applyChanges: () => {
          mkdirSync(dirname(targetPath), { recursive: true });
          renameSync(sourcePath, targetPath);
          rewriteFormalSpecImports(targetPath);
          writeJsonIfMissing(
            providerFixturePath,
            createPromotionProviderFixture(caseName, specRelFromDesktop),
            { force, warnings },
          );
          writeJsonIfMissing(
            caseManifestPath,
            createPromotionCaseManifest(caseName, specRelFromDesktop),
            { force, warnings },
          );
          updateCoverageMatrix({
            matrixPath: coverageMatrixPath,
            oldPath: pendingRelFromRepo,
            newPath: targetRelFromRepo,
            warnings,
          });
        },
        runAudit: () => runPromotionCoverageAudit({ auditPath: coverageAuditPath, repoRoot }),
      });
      audit = transaction.audit;
      if (!transaction.committed) {
        errors.push(
          "pnpm audit:conversation-session-coverage failed; promotion was rejected and all file changes were rolled back.",
        );
      }
    } catch (error) {
      errors.push(
        `Promotion audit transaction failed; file changes were rolled back: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    actions,
    apply,
    audit,
    caseManifestPath,
    caseName,
    errors,
    markerSummary,
    providerFixturePath,
    specPath: apply && errors.length === 0 ? targetPath : sourcePath,
    targetPath,
    warnings,
  };
}

function validateExistingFixtureIdentity({ caseName, filePath, specRelFromDesktop }, errors) {
  if (!existsSync(filePath)) {
    return;
  }
  let value;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`Invalid fixture JSON: ${relative(repoRoot, filePath)}; ${error.message}`);
    return;
  }
  if (value?.caseName !== caseName) {
    errors.push(
      `${relative(repoRoot, filePath)}: caseName must be ${caseName}; received ${JSON.stringify(value?.caseName)}`,
    );
  }
  // 修复原因：promotion 会保留已有 fixture 内容；若这里接受 pending 物理路径，移动
  // spec 后 manifest 会立刻违反 formal admission，形成“转正成功但门禁不可运行”的半状态。
  if (
    typeof value?.spec !== "string" ||
    resolve(desktopDir, value.spec) !== resolve(desktopDir, specRelFromDesktop)
  ) {
    errors.push(
      `${relative(repoRoot, filePath)}: spec must point at canonical formal target ${specRelFromDesktop}`,
    );
  }
}

function writeJsonIfMissing(filePath, value, { force, warnings }) {
  if (existsSync(filePath) && !force) {
    warnings.push(`Skipped existing file: ${relative(repoRoot, filePath)}`);
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function updateCoverageMatrix({ matrixPath, oldPath, newPath, warnings }) {
  if (!existsSync(matrixPath)) {
    warnings.push(`Coverage matrix not found: ${relative(repoRoot, matrixPath)}`);
    return;
  }

  const original = readFileSync(matrixPath, "utf8");
  if (!original.includes(oldPath)) {
    if (!original.includes(newPath)) {
      warnings.push(`Coverage matrix does not reference pending or formal path for ${newPath}.`);
    }
    return;
  }
  writeFileSync(matrixPath, original.replaceAll(oldPath, newPath), "utf8");
}

function extractE2EMarkers(text) {
  const ignoredMarkers = new Set([
    "E2E_READONLY_TOOL_FILE_CONTENT",
    "E2E_READONLY_TOOL_FILE_PATH",
    "E2E_REPLY_TOKEN",
  ]);
  return (
    [
      ...new Set(
        (text.match(/\bE2E_[A-Z0-9_]+\b/g) ?? []).map((marker) => marker.replace(/_+$/, "")),
      ),
    ]
      // 修复：E2E_PROVIDER_* 是上游供应商配置的环境变量名，不是用例标记；曾被误报为未覆盖的 marker。
      .filter((marker) => !ignoredMarkers.has(marker) && !marker.startsWith("E2E_PROVIDER_"))
      .sort()
  );
}

function printResult(result) {
  console.log(`${result.apply ? "Apply" : "Dry run"} conversation E2E promotion`);
  console.log(`Case: ${result.caseName}`);
  console.log(`Spec: ${relative(repoRoot, result.specPath)}`);
  console.log(`Target: ${relative(repoRoot, result.targetPath)}`);
  console.log(`Provider fixture: ${relative(repoRoot, result.providerFixturePath)}`);
  console.log(`Case manifest: ${relative(repoRoot, result.caseManifestPath)}`);

  if (result.markerSummary.length > 0) {
    console.log(`Markers: ${result.markerSummary.join(", ")}`);
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

  if (result.audit) {
    console.log("\nAudit:");
    console.log(`- Command: ${result.audit.command}`);
    console.log(`- Result: ${result.audit.exitCode === 0 ? "passed" : "failed"}`);
    if (result.audit.stdout.trim().length > 0) {
      console.log(result.audit.stdout.trimEnd());
    }
    if (result.audit.stderr.trim().length > 0) {
      console.error(result.audit.stderr.trimEnd());
    }
  }

  if (result.errors.length > 0) {
    console.log("\nErrors:");
    for (const error of result.errors) {
      console.log(`- ${error}`);
    }
    return;
  }

  const specArg = `./${relative(desktopDir, result.targetPath).replaceAll("\\", "/")}`;
  if (!result.apply) {
    const pendingSpecArg = `./${relative(desktopDir, result.specPath).replaceAll("\\", "/")}`;
    console.log("\nNext:");
    console.log(
      `- Complete the canonical fixtures and requests in ${relative(repoRoot, result.providerFixturePath)} and ${relative(repoRoot, result.caseManifestPath)} while the spec is still pending.`,
    );
    console.log(`- pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ${pendingSpecArg}`);
    console.log(
      `- pnpm --filter @zcode/desktop e2e:promote -- --spec ${pendingSpecArg} --reviewed --apply`,
    );
    console.log(
      "- The apply command keeps the formal promotion only after pnpm audit:conversation-session-coverage passes.",
    );
    return;
  }
  const caseFixture = `packages/desktop/test/e2e/fixtures/upstream/conversation-session/${result.caseName}.json`;
  console.log("\nNext:");
  console.log(`- pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ${specArg}`);
  console.log(
    `- E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,${caseFixture} pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec '${specArg}'`,
  );
  console.log(`- pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec '${specArg}'`);
  console.log(`- E2E_SPEC=${specArg} pnpm run test:e2e:container`);
  console.log(
    `- pnpm --filter @zcode/desktop e2e:docker:admit -- --spec ${specArg} --verified --artifact packages/desktop/.e2e-artifacts/<run-id> --apply`,
  );
}
