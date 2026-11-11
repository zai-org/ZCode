import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

import { validateFormalAdmissionManifest } from "./conversation-session-formal-admission-contract.mjs";
import {
  diagnostic,
  isRecord,
  readJson,
  toRepoPath,
} from "./conversation-session-formal-admission-utils.mjs";

const FORMAL_DIRECTORY = "packages/desktop/test/e2e/conversation-session";
const MANIFEST_DIRECTORY = "packages/desktop/test/e2e/fixtures/cases/conversation-session";
const PROVIDER_FIXTURE_DIRECTORY =
  "packages/desktop/test/e2e/fixtures/upstream/conversation-session";

export async function inspectConversationSessionFormalAdmission(repoRoot) {
  const root = resolve(repoRoot);
  const paths = await listSpecsRecursively(resolve(root, FORMAL_DIRECTORY));
  const formalPaths = paths.filter((path) => !toRepoPath(root, path).includes("/manual-review/"));
  const pendingPaths = paths.filter((path) => toRepoPath(root, path).includes("/manual-review/"));
  const formal = await Promise.all(
    formalPaths.map((specPath) => inspectFormalSpec(root, specPath)),
  );
  const pending = await Promise.all(
    pendingPaths.map((specPath) => inspectPendingSpec(root, specPath)),
  );
  const admitted = formal
    .filter((item) => item.reasons.length === 0)
    .map(({ caseName, specPath }) => ({ caseName, specPath }));
  const rejected = formal.filter((item) => item.reasons.length > 0);
  const legacyHarnessFormal = formal.filter((item) => item.legacyHarness.length > 0).length;
  const legacyHarnessPending = pending.filter((item) => item.legacyHarness.length > 0).length;

  return {
    counts: {
      formalAdmitted: admitted.length,
      formalRejected: rejected.length,
      legacyHarness: legacyHarnessFormal + legacyHarnessPending,
      legacyHarnessFormal,
      legacyHarnessPending,
      missingFixture: rejected.filter((item) =>
        item.reasons.some((reason) => reason.code === "MISSING_CASE_FIXTURE"),
      ).length,
      missingManifest: rejected.filter((item) =>
        item.reasons.some((reason) => reason.code === "MISSING_CASE_MANIFEST"),
      ).length,
      pending: pending.length,
      pendingFixtureRejected: pending.filter((item) => item.reasons.length > 0).length,
    },
    formal: { admitted, rejected },
    pending,
  };
}

async function inspectPendingSpec(root, absoluteSpecPath) {
  const specPath = toRepoPath(root, absoluteSpecPath);
  const fileName = specPath.split("/").at(-1);
  const caseName = fileName.replace(/\.test\.ts$/, "");
  const canonicalSpecPath = specPath.replace("/manual-review/pending/", "/");
  const canonicalAbsoluteSpecPath = resolve(root, canonicalSpecPath);
  const manifestPath = resolve(root, MANIFEST_DIRECTORY, `${caseName}.json`);
  const providerFixturePath = resolve(root, PROVIDER_FIXTURE_DIRECTORY, `${caseName}.json`);
  const [source, manifestResult, providerFixtureResult] = await Promise.all([
    readFile(absoluteSpecPath, "utf8"),
    readJson(manifestPath),
    readJson(providerFixturePath),
  ]);
  const reasons = [];

  // 修复原因：pending 文件仍可能复用已录制 fixture，但这些 JSON 属于未来 formal
  // admission 合同；统一校验 保留场景目录的 canonical target，避免把当前路径和转正目标混用。
  inspectPendingArtifactIdentity({
    absoluteSpecPath: canonicalAbsoluteSpecPath,
    artifactLabel: "case manifest",
    artifactPath: manifestPath,
    artifactResult: manifestResult,
    caseName,
    reasons,
    root,
    specPath,
  });
  inspectPendingArtifactIdentity({
    absoluteSpecPath: canonicalAbsoluteSpecPath,
    artifactLabel: "case fixture",
    artifactPath: providerFixturePath,
    artifactResult: providerFixtureResult,
    caseName,
    reasons,
    root,
    specPath,
  });

  return {
    canonicalSpecPath,
    caseName,
    legacyHarness: inspectLegacyHarness(source),
    reasons,
    specPath,
  };
}

function inspectPendingArtifactIdentity({
  absoluteSpecPath,
  artifactLabel,
  artifactPath,
  artifactResult,
  caseName,
  reasons,
  root,
  specPath,
}) {
  if (artifactResult.missing) {
    return;
  }
  const subjectPath = toRepoPath(root, artifactPath);
  if (artifactResult.error) {
    reasons.push(
      diagnostic({
        code: "INVALID_PENDING_FIXTURE_METADATA_JSON",
        message: `${artifactLabel} is not valid JSON: ${artifactResult.error.message}`,
        specPath,
        subjectPath,
      }),
    );
    return;
  }
  const value = artifactResult.value;
  if (!isRecord(value)) {
    reasons.push(
      diagnostic({
        code: "INVALID_PENDING_FIXTURE_METADATA_SHAPE",
        message: `${artifactLabel} must be a JSON object`,
        specPath,
        subjectPath,
      }),
    );
    return;
  }
  if (value.caseName !== caseName) {
    reasons.push(
      diagnostic({
        code: "PENDING_FIXTURE_CASE_NAME_MISMATCH",
        message: `${artifactLabel} caseName must be ${caseName}; received ${JSON.stringify(value.caseName)}`,
        specPath,
        subjectPath,
      }),
    );
  }
  if (
    typeof value.spec !== "string" ||
    resolve(root, "packages/desktop", value.spec) !== absoluteSpecPath
  ) {
    reasons.push(
      diagnostic({
        code: "PENDING_FIXTURE_FORMAL_TARGET_MISMATCH",
        message: `${artifactLabel} spec must resolve to ${toRepoPath(root, absoluteSpecPath)}; received ${JSON.stringify(value.spec)}`,
        specPath,
        subjectPath,
      }),
    );
  }
}

async function inspectFormalSpec(root, absoluteSpecPath) {
  const specPath = toRepoPath(root, absoluteSpecPath);
  const caseName = specPath
    .split("/")
    .at(-1)
    .replace(/\.test\.ts$/, "");
  const reasons = [];
  const source = await readFile(absoluteSpecPath, "utf8");
  const legacyHarness = inspectLegacyHarness(source);
  for (const code of legacyHarness) {
    reasons.push(
      diagnostic({
        code,
        message:
          code === "LEGACY_HELPER_IMPORT"
            ? "formal spec imports the exact legacy helpers/conversation-session.js module"
            : "formal spec calls prepareConversationE2E",
        specPath,
        subjectPath: specPath,
      }),
    );
  }

  const manifestPath = resolve(root, MANIFEST_DIRECTORY, `${caseName}.json`);
  const caseFixturePath = resolve(root, PROVIDER_FIXTURE_DIRECTORY, `${caseName}.json`);
  const manifestResult = await readJson(manifestPath);
  const caseFixtureResult = await readJson(caseFixturePath);

  if (manifestResult.missing) {
    reasons.push(
      diagnostic({
        code: "MISSING_CASE_MANIFEST",
        message: "case manifest is missing",
        specPath,
        subjectPath: toRepoPath(root, manifestPath),
      }),
    );
  } else if (manifestResult.error) {
    reasons.push(
      diagnostic({
        code: "INVALID_MANIFEST_JSON",
        message: `case manifest is not valid JSON: ${manifestResult.error.message}`,
        specPath,
        subjectPath: toRepoPath(root, manifestPath),
      }),
    );
  }

  if (caseFixtureResult.missing) {
    reasons.push(
      diagnostic({
        code: "MISSING_CASE_FIXTURE",
        message: "case-local provider fixture is missing",
        specPath,
        subjectPath: toRepoPath(root, caseFixturePath),
      }),
    );
  } else if (caseFixtureResult.error) {
    reasons.push(
      diagnostic({
        code: "INVALID_CASE_FIXTURE_JSON",
        message: `case-local provider fixture is not valid JSON: ${caseFixtureResult.error.message}`,
        specPath,
        subjectPath: toRepoPath(root, caseFixturePath),
      }),
    );
  }

  if (manifestResult.value !== undefined) {
    await validateFormalAdmissionManifest({
      absoluteSpecPath,
      caseFixture: caseFixtureResult.value,
      caseFixturePath,
      caseName,
      manifest: manifestResult.value,
      manifestPath,
      reasons,
      root,
      specPath,
    });
  }

  return { caseName, legacyHarness, reasons, specPath };
}

function inspectLegacyHarness(source) {
  const codes = [];
  const sourceFile = ts.createSourceFile(
    "conversation-session.test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let legacyImport = false;
  let legacyPrepareCall = false;
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /(?:^|\/)helpers\/conversation-session\.js$/.test(node.moduleSpecifier.text)
    ) {
      legacyImport = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(unwrapTransparentExpression(node.expression)) &&
      unwrapTransparentExpression(node.expression).text === "prepareConversationE2E"
    ) {
      legacyPrepareCall = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (legacyImport) {
    codes.push("LEGACY_HELPER_IMPORT");
  }
  if (legacyPrepareCall) {
    codes.push("LEGACY_PREPARE_CALL");
  }
  return codes;
}

function unwrapTransparentExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isPartiallyEmittedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

async function listSpecsRecursively(directory) {
  const entries = await readDirectory(directory);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return listSpecsRecursively(path);
      }
      return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

async function readDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
