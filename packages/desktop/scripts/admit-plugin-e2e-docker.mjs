#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

const desktopDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopDir, "../..");
const formalPluginDir = resolve(desktopDir, "test/e2e/plugins");
const containerScript = resolve(repoRoot, "scripts/test-desktop-e2e-container.sh");
const fixtureDir = resolve(desktopDir, "test/e2e/fixtures/upstream/plugin-management");
const manifestDir = resolve(desktopDir, "test/e2e/fixtures/cases/plugins");
const suitePattern = /^(PLUGIN_MANAGEMENT_VERIFIED_E2E_SPEC=")([^"]*)(")$/m;

const options = parseArgs(process.argv.slice(2));
if (options.help || !options.spec) {
  printUsage();
  process.exit(options.help ? 0 : 1);
}
const result = admit(options);
printResult(result);
process.exit(result.errors.length > 0 ? 1 : 0);

function parseArgs(args) {
  const options = { apply: false, artifact: "", help: false, spec: "", verified: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--" || !arg.trim()) continue;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--verified") options.verified = true;
    else if (arg === "--artifact") options.artifact = args[++index] ?? "";
    else if (arg.startsWith("--artifact=")) options.artifact = arg.slice("--artifact=".length);
    else if (arg === "--spec") options.spec = args[++index] ?? "";
    else if (arg.startsWith("--spec=")) options.spec = arg.slice("--spec=".length);
    else if (!options.spec) options.spec = arg;
  }
  return options;
}

function printUsage() {
  console.log(
    "Usage: pnpm --filter @zcode/desktop e2e:docker:admit:plugins -- --spec ./test/e2e/plugins/<scenario>/<case>.test.ts --verified --artifact <path> --apply",
  );
}

function admit({ apply, artifact, spec, verified }) {
  const errors = [];
  const warnings = [];
  const actions = [];
  const specPath = resolvePath(spec);
  const relativeFormal = relative(formalPluginDir, specPath);
  const fileName = basename(specPath);
  const caseName = fileName.replace(/\.test\.ts$/u, "");
  const fixturePath = resolve(fixtureDir, `${caseName}.json`);
  const manifestPath = resolve(manifestDir, `${caseName}.json`);
  const specEntry = `./${relative(desktopDir, specPath).replaceAll("\\", "/")}`;
  const script = readFileSync(containerScript, "utf8");
  const match = script.match(suitePattern);
  const specs = match?.[2].split(",").filter(Boolean) ?? [];

  if (
    relativeFormal.startsWith("..") ||
    isAbsolute(relativeFormal) ||
    relativeFormal.includes("manual-review")
  ) {
    errors.push(`Spec must be a promoted formal plugin case: ${relative(repoRoot, specPath)}`);
  }
  if (!existsSync(specPath))
    errors.push(`Formal plugin spec missing: ${relative(repoRoot, specPath)}`);
  if (!existsSync(fixturePath))
    errors.push(`Case fixture missing: ${relative(repoRoot, fixturePath)}`);
  if (!existsSync(manifestPath))
    errors.push(`Case manifest missing: ${relative(repoRoot, manifestPath)}`);
  if (!match)
    errors.push("PLUGIN_MANAGEMENT_VERIFIED_E2E_SPEC assignment is missing from container script.");
  if (apply && !verified) errors.push("Use --verified only after replay-isolated Docker passes.");
  if (!artifact)
    warnings.push("Record the passing Docker artifact path before applying admission.");
  else if (!existsSync(resolvePath(artifact)))
    warnings.push(`Artifact path not found locally: ${artifact}`);

  if (errors.length === 0)
    actions.push(
      `${specs.includes(specEntry) ? "Keep" : "Add"} ${specEntry} in plugins-verified preset.`,
    );
  if (apply && errors.length === 0 && match && !specs.includes(specEntry)) {
    writeFileSync(
      containerScript,
      script.replace(suitePattern, `$1${[...specs, specEntry].join(",")}$3`),
      "utf8",
    );
  }
  return { actions, apply, errors, warnings, caseName };
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
  console.log(`${result.apply ? "Apply" : "Dry run"} plugin Docker admission: ${result.caseName}`);
  for (const action of result.actions) console.log(`- ${action}`);
  for (const warning of result.warnings) console.log(`Warning: ${warning}`);
  for (const error of result.errors) console.log(`Error: ${error}`);
}
