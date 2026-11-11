#!/usr/bin/env node

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { rewriteFormalSpecImports } from "./lib/e2e-promotion-spec-imports.mjs";

const desktopDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopDir, "../..");
const pluginDir = resolve(desktopDir, "test/e2e/plugins");
const matrixPath = resolve(
  repoRoot,
  "docs/testing/plugin-management-lifecycle-e2e-coverage-matrix.md",
);
const fixtureDir = resolve(desktopDir, "test/e2e/fixtures/upstream/plugin-management");
const manifestDir = resolve(desktopDir, "test/e2e/fixtures/cases/plugins");

const options = parseArgs(process.argv.slice(2));
if (options.help || !options.spec) {
  printUsage();
  process.exit(options.help ? 0 : 1);
}

const result = promote(options);
printResult(result);
process.exit(result.errors.length > 0 ? 1 : 0);

function parseArgs(args) {
  const options = { apply: false, help: false, reviewed: false, spec: "" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--" || !arg.trim()) continue;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--reviewed") options.reviewed = true;
    else if (arg === "--spec") options.spec = args[++index] ?? "";
    else if (arg.startsWith("--spec=")) options.spec = arg.slice("--spec=".length);
    else if (!options.spec) options.spec = arg;
  }
  return options;
}

function printUsage() {
  console.log(
    "Usage: pnpm --filter @zcode/desktop e2e:promote:plugins -- --spec ./test/e2e/plugins/<scenario>/manual-review/pending/<case>.test.ts --reviewed --apply",
  );
}

function promote({ apply, reviewed, spec }) {
  const errors = [];
  const warnings = [];
  const actions = [];
  const sourcePath = resolvePath(spec);
  const fileName = basename(sourcePath);
  const caseName = fileName.replace(/\.test\.ts$/u, "");
  const pendingRelative = relative(pluginDir, sourcePath).replaceAll("\\", "/");
  const targetPath = resolve(
    pluginDir,
    pendingRelative.replace(/(?:^|\/)manual-review\/pending\//u, (match) =>
      match.startsWith("/") ? "/" : "",
    ),
  );
  const fixturePath = resolve(fixtureDir, `${caseName}.json`);
  const manifestPath = resolve(manifestDir, `${caseName}.json`);

  if (
    pendingRelative.startsWith("..") ||
    isAbsolute(pendingRelative) ||
    !/(?:^|\/)manual-review\/pending\/[^/]+\.test\.ts$/u.test(pendingRelative)
  ) {
    errors.push(
      `Spec must be under plugin manual-review/pending: ${relative(repoRoot, sourcePath)}`,
    );
  }
  if (!sourcePath.endsWith(".test.ts") || !existsSync(sourcePath)) {
    errors.push(`Pending plugin spec not found: ${relative(repoRoot, sourcePath)}`);
  }
  if (existsSync(targetPath))
    errors.push(`Formal target already exists: ${relative(repoRoot, targetPath)}`);
  if (!existsSync(fixturePath))
    errors.push(`Case-local provider fixture missing: ${relative(repoRoot, fixturePath)}`);
  if (!existsSync(manifestPath))
    errors.push(`Plugin case manifest missing: ${relative(repoRoot, manifestPath)}`);
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.formalAdmission === "never") {
      errors.push(`Plugin case is manual-only and cannot be promoted: ${caseName}`);
    }
  }
  if (apply && !reviewed) errors.push("Use --reviewed when applying plugin promotion.");
  if (!reviewed)
    warnings.push("Do not apply until screenshots and behavior have passed human review.");

  if (errors.length === 0) {
    actions.push(`Move ${relative(repoRoot, sourcePath)} -> ${relative(repoRoot, targetPath)}`);
    actions.push(
      "Rewrite pending helper imports and update the case manifest and coverage matrix paths.",
    );
  }
  if (apply && errors.length === 0) {
    renameSync(sourcePath, targetPath);
    rewriteFormalSpecImports(targetPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.spec = `./${relative(desktopDir, targetPath).replaceAll("\\", "/")}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const matrix = readFileSync(matrixPath, "utf8");
    writeFileSync(
      matrixPath,
      matrix.replaceAll(
        `plugins/${pendingRelative}`,
        `plugins/${relative(pluginDir, targetPath).replaceAll("\\", "/")}`,
      ),
      "utf8",
    );
  }
  return {
    actions,
    apply,
    caseName,
    errors,
    fixturePath,
    manifestPath,
    sourcePath,
    targetPath,
    warnings,
  };
}

function resolvePath(value) {
  const candidates = [
    resolve(process.cwd(), value),
    resolve(desktopDir, value),
    resolve(repoRoot, value),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function printResult(result) {
  console.log(`${result.apply ? "Apply" : "Dry run"} plugin E2E promotion: ${result.caseName}`);
  for (const action of result.actions) console.log(`- ${action}`);
  for (const warning of result.warnings) console.log(`Warning: ${warning}`);
  for (const error of result.errors) console.log(`Error: ${error}`);
}
