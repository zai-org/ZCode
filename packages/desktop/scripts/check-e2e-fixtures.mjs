#!/usr/bin/env node
/* eslint-disable max-lines */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const desktopDir = resolve(import.meta.dirname, "..");
const upstreamFixtureRoot = resolve(desktopDir, "test/e2e/fixtures/upstream");
const conversationCaseManifestRoot = resolve(
  desktopDir,
  "test/e2e/fixtures/cases/conversation-session",
);
const pluginCaseManifestRoot = resolve(desktopDir, "test/e2e/fixtures/cases/plugins");
const commonFixturePath = resolve(upstreamFixtureRoot, "common.json");
const conversationFixtureDir = resolve(upstreamFixtureRoot, "conversation-session");
const pluginFixtureDir = resolve(upstreamFixtureRoot, "plugin-management");

const options = parseArgs(process.argv.slice(2));
if (options.help || !options.spec) {
  printUsage();
  process.exit(options.help ? 0 : 1);
}

const specPath = resolve(process.cwd(), options.spec);
const specContract = resolveE2ESpecContract(specPath);
const caseName = specContract?.caseName ?? null;
const canonicalSpecPath = specContract?.canonicalSpecPath ?? specPath;
const errors = [];
const warnings = [];
const specMarkers = existsSync(specPath)
  ? extractSpecE2EMarkers(readFileSync(specPath, "utf8"))
  : [];

if (!existsSync(specPath)) {
  errors.push(`Spec not found: ${specPath}`);
}
if (!specContract) {
  errors.push(
    "Fixture check supports formal/pending conversation-session and plugin specs outside recursive globs.",
  );
}

const fixturePaths = [
  commonFixturePath,
  caseName && specContract ? resolve(specContract.fixtureDir, `${caseName}.json`) : "",
].filter(Boolean);

const fixtureFiles = [];
let caseManifest = null;
for (const fixturePath of fixturePaths) {
  if (!existsSync(fixturePath)) {
    if (fixturePath === commonFixturePath) {
      warnings.push(`Common fixture is missing: ${fixturePath}`);
    } else {
      errors.push(`Case-local fixture is missing: ${fixturePath}`);
    }
    continue;
  }

  const fixtureFile = readFixtureFile(fixturePath, errors);
  if (fixtureFile) {
    fixtureFiles.push({ path: fixturePath, value: fixtureFile });
  }
}

if (caseName) {
  const manifestPath = resolve(specContract.manifestRoot, `${caseName}.json`);
  if (!existsSync(manifestPath)) {
    errors.push(`Case manifest is missing: ${manifestPath}`);
  } else {
    caseManifest = readCaseManifest(manifestPath, errors);
    if (caseManifest) {
      validateCaseManifest(
        caseManifest,
        {
          caseName,
          canonicalSpecPath,
          fixturePaths,
          manifestPath,
        },
        warnings,
        errors,
      );
    }
  }
}

validateFixtureIds(fixtureFiles, errors);
for (const fixtureFile of fixtureFiles) {
  validateFixtureFile(fixtureFile, warnings, errors);
}
validateSpecMarkerCoverage(specMarkers, fixtureFiles, warnings, caseManifest);

const caseFixture = fixtureFiles.find((file) => file.path !== commonFixturePath);
if (caseFixture && specContract) {
  validateCaseFixtureIdentity(
    caseFixture,
    {
      canonicalSpecPath,
      caseName: specContract.caseName,
    },
    errors,
  );
}
if (
  caseFixture &&
  caseFixture.value.fixtures.length === 0 &&
  !allowsEmptyCaseLocalFixture(caseManifest)
) {
  errors.push(`Case-local fixture has no fixtures: ${caseFixture.path}`);
}

printSummary({
  caseName,
  canonicalSpecPath,
  errors,
  fixtureFiles,
  manifest: caseManifest,
  specMarkers,
  specPath,
  warnings,
});

process.exit(errors.length > 0 ? 1 : 0);

function parseArgs(args) {
  const parsed = { help: false, spec: "" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--") {
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
  console.log(
    "Usage:\n" +
      "  pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/<scenario>/<case>.test.ts\n" +
      "  pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/<scenario>/manual-review/pending/<case>.test.ts\n" +
      "  pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/plugins/<scenario>/<case>.test.ts\n" +
      "  pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/plugins/<scenario>/manual-review/pending/<case>.test.ts\n",
  );
}

function resolveE2ESpecContract(specPath) {
  const normalized = specPath.replaceAll("\\", "/");
  const candidates = [
    {
      marker: "/test/e2e/conversation-session/",
      fixtureDir: conversationFixtureDir,
      manifestRoot: conversationCaseManifestRoot,
      formalDir: resolve(desktopDir, "test/e2e/conversation-session"),
    },
    {
      marker: "/test/e2e/plugins/",
      fixtureDir: pluginFixtureDir,
      manifestRoot: pluginCaseManifestRoot,
      formalDir: resolve(desktopDir, "test/e2e/plugins"),
    },
  ];
  for (const candidate of candidates) {
    const markerIndex = normalized.lastIndexOf(candidate.marker);
    if (markerIndex < 0) continue;
    const relativeSpecPath = normalized.slice(markerIndex + candidate.marker.length);
    const canonicalRelative = relativeSpecPath.replace(
      /(?:^|\/)manual-review\/pending\//u,
      (match) => (match.startsWith("/") ? "/" : ""),
    );
    if (
      canonicalRelative.includes("manual-review/") ||
      /[*?\[{}]/u.test(canonicalRelative) ||
      !canonicalRelative.endsWith(".test.ts")
    ) {
      return null;
    }
    // 候选转正只去掉 review 层级，场景目录属于 fixture 的正式身份。
    return {
      canonicalSpecPath: resolve(candidate.formalDir, canonicalRelative),
      caseName: basename(canonicalRelative, ".test.ts"),
      fixtureDir: candidate.fixtureDir,
      manifestRoot: candidate.manifestRoot,
    };
  }
  return null;
}

function readFixtureFile(fixturePath, nextErrors) {
  try {
    const value = JSON.parse(readFileSync(fixturePath, "utf8"));
    if (value?.version !== 1 || !Array.isArray(value.fixtures)) {
      nextErrors.push(`Invalid fixture file shape: ${fixturePath}`);
      return null;
    }
    return value;
  } catch (error) {
    nextErrors.push(`Failed to parse fixture JSON: ${fixturePath}; ${error.message}`);
    return null;
  }
}

function readCaseManifest(manifestPath, nextErrors) {
  try {
    const value = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (value?.version !== 1 || typeof value.caseName !== "string") {
      nextErrors.push(`Invalid case manifest shape: ${manifestPath}`);
      return null;
    }
    return { path: manifestPath, value };
  } catch (error) {
    nextErrors.push(`Failed to parse case manifest JSON: ${manifestPath}; ${error.message}`);
    return null;
  }
}

function validateCaseManifest(
  manifest,
  { canonicalSpecPath, caseName, fixturePaths, manifestPath },
  nextWarnings,
  nextErrors,
) {
  const value = manifest.value;
  const requests = Array.isArray(value.requests) ? value.requests : [];
  if (value.caseName !== caseName) {
    nextErrors.push(
      `Case manifest caseName mismatch in ${manifestPath}: ${value.caseName} !== ${caseName}`,
    );
  }
  if (value.noProviderRequests === true && requests.length > 0) {
    nextErrors.push(`${manifestPath}: noProviderRequests=true requires requests to stay empty`);
  }
  if (
    typeof value.spec !== "string" ||
    !samePath(resolve(desktopDir, value.spec), canonicalSpecPath)
  ) {
    nextErrors.push(
      `${manifestPath}: spec must point at canonical formal target ${canonicalSpecPath}`,
    );
  }
  for (const providerFixture of asStringArray(value.providerFixtures)) {
    const resolvedProviderFixture = resolve(desktopDir, providerFixture);
    if (!fixturePaths.some((fixturePath) => samePath(fixturePath, resolvedProviderFixture))) {
      nextWarnings.push(
        `${manifestPath}: provider fixture is not in resolved WDIO fixture set: ${providerFixture}`,
      );
    }
  }
  for (const request of requests) {
    if (
      (request.kind === "synthetic" || request.source === "synthetic") &&
      typeof request.syntheticReason !== "string"
    ) {
      nextErrors.push(
        `${manifestPath}: synthetic request ${request.id ?? "<missing-id>"} must include syntheticReason`,
      );
    }
  }
  if (value.providerRequestPolicy !== undefined && value.providerRequestPolicy !== "none") {
    nextErrors.push(`${manifestPath}: providerRequestPolicy must be "none" when present`);
  }
  if (
    value.providerRequestPolicy === "none" &&
    Array.isArray(value.requests) &&
    value.requests.length > 0
  ) {
    nextErrors.push(
      `${manifestPath}: providerRequestPolicy "none" requires an empty requests array`,
    );
  }
}

function validateCaseFixtureIdentity(fixtureFile, { canonicalSpecPath, caseName }, nextErrors) {
  const value = fixtureFile.value;
  if (value.caseName !== caseName) {
    nextErrors.push(
      `${fixtureFile.path}: caseName must be ${caseName}; received ${JSON.stringify(value.caseName)}`,
    );
  }
  if (
    typeof value.spec !== "string" ||
    !samePath(resolve(desktopDir, value.spec), canonicalSpecPath)
  ) {
    nextErrors.push(
      `${fixtureFile.path}: spec must point at canonical formal target ${canonicalSpecPath}`,
    );
  }
}

function allowsEmptyCaseLocalFixture(manifest) {
  const value = manifest?.value;
  // pure UI cases must opt in via empty provider contract
  return (
    (value?.noProviderRequests === true || value?.providerRequestPolicy === "none") &&
    Array.isArray(value.requests) &&
    value.requests.length === 0
  );
}

function validateFixtureIds(fixtureFiles, nextErrors) {
  const seen = new Map();
  for (const fixtureFile of fixtureFiles) {
    for (const fixture of fixtureFile.value.fixtures) {
      if (!fixture?.id || typeof fixture.id !== "string") {
        nextErrors.push(`Fixture without string id in ${fixtureFile.path}`);
        continue;
      }
      const previous = seen.get(fixture.id);
      if (previous) {
        nextErrors.push(
          `Duplicate fixture id "${fixture.id}" in ${fixtureFile.path}; first seen in ${previous}`,
        );
      } else {
        seen.set(fixture.id, fixtureFile.path);
      }
    }
  }
}

function validateFixtureFile(fixtureFile, nextWarnings, nextErrors) {
  for (const fixture of fixtureFile.value.fixtures) {
    const prefix = `${fixture.id ?? "<missing-id>"} (${fixtureFile.path})`;
    if (!fixture.match || typeof fixture.match !== "object") {
      nextErrors.push(`${prefix}: missing match object`);
      continue;
    }
    if (!fixture.response || typeof fixture.response !== "object") {
      nextErrors.push(`${prefix}: missing response object`);
    }
    if (!fixture.match.method) {
      nextWarnings.push(`${prefix}: match.method is missing`);
    }
    if (!fixture.match.pathIncludes) {
      nextWarnings.push(`${prefix}: match.pathIncludes is missing`);
    }

    const matchTexts = [
      ...asStringArray(fixture.match.bodyIncludes),
      ...asStringArray(fixture.match.lastUserMessageIncludes),
    ];
    if (matchTexts.length === 0) {
      nextWarnings.push(`${prefix}: matcher has no bodyIncludes or lastUserMessageIncludes`);
    } else if (!matchTexts.some((text) => text.includes("E2E_"))) {
      nextWarnings.push(`${prefix}: matcher has no E2E marker`);
    }

    const metadata = fixture.metadata ?? {};
    if (
      (metadata.kind === "synthetic" || metadata.source === "synthetic") &&
      typeof metadata.syntheticReason !== "string"
    ) {
      nextErrors.push(`${prefix}: synthetic fixture must include metadata.syntheticReason`);
    }
  }
}

function validateSpecMarkerCoverage(specMarkers, fixtureFiles, nextWarnings, manifest) {
  if (allowsEmptyCaseLocalFixture(manifest)) {
    return;
  }
  const matcherTexts = fixtureFiles.flatMap((fixtureFile) =>
    fixtureFile.value.fixtures.flatMap((fixture) => [
      ...asStringArray(fixture.match?.bodyIncludes),
      ...asStringArray(fixture.match?.lastUserMessageIncludes),
    ]),
  );
  for (const marker of specMarkers) {
    if (!matcherTexts.some((text) => text.includes(marker))) {
      nextWarnings.push(`Spec marker is not covered by fixture matchers: ${marker}`);
    }
  }
}

function extractSpecE2EMarkers(text) {
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

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function samePath(left, right) {
  return resolve(left) === resolve(right);
}

function printSummary({
  caseName,
  canonicalSpecPath,
  errors,
  fixtureFiles,
  manifest,
  specMarkers,
  specPath,
  warnings,
}) {
  console.log(`Spec: ${specPath}`);
  console.log(`Canonical formal spec: ${canonicalSpecPath}`);
  console.log(`Case: ${caseName ?? "(unresolved)"}`);
  console.log(`Manifest: ${manifest?.path ?? "(missing)"}`);
  console.log(`Spec markers: ${specMarkers.length > 0 ? specMarkers.join(", ") : "(none)"}`);
  console.log("Fixtures:");
  for (const fixtureFile of fixtureFiles) {
    console.log(`- ${fixtureFile.path} (${fixtureFile.value.fixtures.length} fixtures)`);
  }
  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of warnings) console.log(`- ${warning}`);
  }
  if (errors.length > 0) {
    console.log("\nErrors:");
    for (const error of errors) console.log(`- ${error}`);
  } else {
    console.log("\nFixture check passed.");
  }
}
