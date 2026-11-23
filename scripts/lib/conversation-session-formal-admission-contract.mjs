import { resolve } from "node:path";

import {
  validateProviderFixture,
  validateRequestArray,
  validateRequestLedger,
  validateSyntheticReasons,
} from "./conversation-session-formal-admission-ledger.mjs";
import {
  diagnostic,
  isRecord,
  readJson,
  toRepoPath,
} from "./conversation-session-formal-admission-utils.mjs";
import {
  resolveProviderFixturePaths,
  validateFileFixtures,
  validateStaticFilePaths,
} from "./conversation-session-formal-admission-paths.mjs";

export async function validateFormalAdmissionManifest({
  absoluteSpecPath,
  caseFixture,
  caseFixturePath,
  caseName,
  manifest,
  manifestPath,
  reasons,
  root,
  specPath,
}) {
  const manifestSubjectPath = toRepoPath(root, manifestPath);
  if (!isRecord(manifest)) {
    reasons.push(
      diagnostic({
        code: "INVALID_MANIFEST_SHAPE",
        message: "case manifest must be a JSON object",
        specPath,
        subjectPath: manifestSubjectPath,
      }),
    );
    return;
  }
  validateManifestIdentity({
    absoluteSpecPath,
    caseName,
    manifest,
    manifestSubjectPath,
    reasons,
    root,
    specPath,
  });
  validateCaseFixtureIdentity({
    absoluteSpecPath,
    caseFixture,
    caseFixturePath,
    caseName,
    reasons,
    root,
    specPath,
  });

  const providerFixtures = validateStringArray(
    manifest.providerFixtures,
    "providerFixtures",
    manifestSubjectPath,
    specPath,
    reasons,
  );
  const fileFixtures = validateFileFixtures(
    manifest.fileFixtures ?? [],
    manifestSubjectPath,
    specPath,
    reasons,
  );
  const requests = validateRequestArray(manifest.requests, manifestSubjectPath, specPath, reasons);
  if (!providerFixtures || !fileFixtures || !requests) {
    return;
  }

  const desktopRoot = resolve(root, "packages/desktop");
  const providerFixtureRoot = resolve(desktopRoot, "test/e2e/fixtures/upstream");
  const staticFileFixtureRoot = resolve(desktopRoot, "test/e2e/fixtures");
  const resolvedProviderFixtures = await resolveProviderFixturePaths({
    desktopRoot,
    providerFixtureRoot,
    providerFixtures,
    reasons,
    root,
    specPath,
  });
  if (!resolvedProviderFixtures.some((fixture) => fixture.absolutePath === caseFixturePath)) {
    reasons.push(
      diagnostic({
        code: "MANIFEST_OMITS_CASE_FIXTURE",
        message: "providerFixtures does not include the case-local provider fixture",
        specPath,
        subjectPath: manifestSubjectPath,
      }),
    );
  }

  const providerFiles = await readProviderFiles({
    canonicalCommonPath: resolve(providerFixtureRoot, "common.json"),
    reasons,
    resolvedProviderFixtures,
    root,
    specPath,
  });
  await validateStaticFilePaths({
    desktopRoot,
    fixtureRoot: staticFileFixtureRoot,
    reasons,
    root,
    specPath,
    staticPaths: fileFixtures.staticPaths,
  });
  validateProviderPolicy({
    manifest,
    manifestSubjectPath,
    reasons,
    requests,
    specPath,
  });
  validateSyntheticReasons(requests, manifestSubjectPath, specPath, reasons);
  for (const providerFile of providerFiles) {
    validateSyntheticReasons(
      providerFile.fixtures.map((fixture) => ({
        id: fixture.id,
        ...(isRecord(fixture.metadata) ? fixture.metadata : {}),
      })),
      providerFile.subjectPath,
      specPath,
      reasons,
    );
  }

  const declaredCaseFixture = providerFiles.find(
    (fixture) => fixture.absolutePath === caseFixturePath,
  );
  const fallbackCaseFixtures = validateProviderFixture(
    caseFixture,
    toRepoPath(root, caseFixturePath),
    specPath,
    reasons,
    { reportShapeError: false },
  );
  const caseFixtures = declaredCaseFixture?.fixtures ?? fallbackCaseFixtures ?? null;
  if (
    caseFixtures?.length === 0 &&
    !["none", "external-live"].includes(manifest.providerRequestPolicy)
  ) {
    reasons.push(
      diagnostic({
        code: "EMPTY_CASE_FIXTURE_WITHOUT_NONE",
        message:
          'an empty case-local provider fixture requires providerRequestPolicy "none" or "external-live"',
        specPath,
        subjectPath: manifestSubjectPath,
      }),
    );
  }
  validateRequestLedger({
    caseFixtures: caseFixtures ?? [],
    manifestSubjectPath,
    providerFiles,
    reasons,
    requests,
    specPath,
  });
}

function validateCaseFixtureIdentity({
  absoluteSpecPath,
  caseFixture,
  caseFixturePath,
  caseName,
  reasons,
  root,
  specPath,
}) {
  if (!isRecord(caseFixture)) {
    return;
  }
  const subjectPath = toRepoPath(root, caseFixturePath);
  if (caseFixture.caseName !== caseName) {
    reasons.push(
      diagnostic({
        code: "CASE_FIXTURE_CASE_NAME_MISMATCH",
        message: `case fixture caseName must be ${caseName}; received ${JSON.stringify(caseFixture.caseName)}`,
        specPath,
        subjectPath,
      }),
    );
  }
  if (
    typeof caseFixture.spec !== "string" ||
    resolve(root, "packages/desktop", caseFixture.spec) !== absoluteSpecPath
  ) {
    reasons.push(
      diagnostic({
        code: "CASE_FIXTURE_SPEC_PATH_MISMATCH",
        message: `case fixture spec must resolve to ${specPath}; received ${JSON.stringify(caseFixture.spec)}`,
        specPath,
        subjectPath,
      }),
    );
  }
}

function validateManifestIdentity({
  absoluteSpecPath,
  caseName,
  manifest,
  manifestSubjectPath,
  reasons,
  root,
  specPath,
}) {
  if (manifest.version !== 1) {
    reasons.push(
      diagnostic({
        code: "INVALID_MANIFEST_VERSION",
        message: `case manifest version must be 1; received ${JSON.stringify(manifest.version)}`,
        specPath,
        subjectPath: manifestSubjectPath,
      }),
    );
  }
  if (manifest.caseName !== caseName) {
    reasons.push(
      diagnostic({
        code: "MANIFEST_CASE_NAME_MISMATCH",
        message: `case manifest caseName must be ${caseName}; received ${JSON.stringify(manifest.caseName)}`,
        specPath,
        subjectPath: manifestSubjectPath,
      }),
    );
  }
  const desktopRoot = resolve(root, "packages/desktop");
  if (
    typeof manifest.spec !== "string" ||
    resolve(desktopRoot, manifest.spec) !== absoluteSpecPath
  ) {
    reasons.push(
      diagnostic({
        code: "MANIFEST_SPEC_PATH_MISMATCH",
        message: `case manifest spec must resolve to ${specPath}; received ${JSON.stringify(manifest.spec)}`,
        specPath,
        subjectPath: manifestSubjectPath,
      }),
    );
  }
}

async function readProviderFiles({
  canonicalCommonPath,
  reasons,
  resolvedProviderFixtures,
  root,
  specPath,
}) {
  const providerFiles = [];
  for (const fixture of resolvedProviderFixtures) {
    const result = await readJson(fixture.absolutePath);
    const subjectPath = toRepoPath(root, fixture.absolutePath);
    if (result.missing) {
      reasons.push(
        diagnostic({
          code: "MISSING_PROVIDER_FIXTURE",
          message: `declared provider fixture is missing: ${fixture.manifestPath}`,
          specPath,
          subjectPath,
        }),
      );
      continue;
    }
    if (result.error) {
      reasons.push(
        diagnostic({
          code: "INVALID_PROVIDER_FIXTURE_JSON",
          message: `declared provider fixture is not valid JSON: ${result.error.message}`,
          specPath,
          subjectPath,
        }),
      );
      continue;
    }
    const fixtures = validateProviderFixture(result.value, subjectPath, specPath, reasons);
    if (fixtures) {
      providerFiles.push({
        absolutePath: fixture.absolutePath,
        fixtures,
        isCanonicalCommon: fixture.absolutePath === canonicalCommonPath,
        subjectPath,
      });
    }
  }
  return providerFiles;
}

function validateProviderPolicy({ manifest, manifestSubjectPath, reasons, requests, specPath }) {
  if (
    manifest.providerRequestPolicy !== undefined &&
    !["none", "external-live"].includes(manifest.providerRequestPolicy)
  ) {
    reasons.push(
      diagnostic({
        code: "INVALID_PROVIDER_REQUEST_POLICY",
        message: 'providerRequestPolicy must be "none" or "external-live" when present',
        specPath,
        subjectPath: manifestSubjectPath,
      }),
    );
  }
  // 真实账号专项绕过回放服务器；不能为了空 fixture 把真实模型请求声明为不存在。
  if (
    manifest.providerRequestPolicy === "external-live" &&
    (typeof manifest.externalProviderReason !== "string" ||
      !manifest.externalProviderReason.trim() ||
      manifest.noProviderRequests === true ||
      requests.length > 0)
  ) {
    reasons.push(
      diagnostic({
        code: "INVALID_EXTERNAL_LIVE_CONTRACT",
        message:
          "external-live requires a reason, an empty replay ledger and no noProviderRequests claim",
        specPath,
        subjectPath: manifestSubjectPath,
      }),
    );
  }
  if (manifest.providerRequestPolicy === "none" && requests.length > 0) {
    reasons.push(
      diagnostic({
        code: "PROVIDER_REQUEST_POLICY_NONE_WITH_REQUESTS",
        message: 'providerRequestPolicy "none" requires an empty requests ledger',
        specPath,
        subjectPath: manifestSubjectPath,
      }),
    );
  }
}

function validateStringArray(value, field, subjectPath, specPath, reasons) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    reasons.push(
      diagnostic({
        code: "INVALID_MANIFEST_SHAPE",
        message: `case manifest ${field} must be an array of strings`,
        specPath,
        subjectPath,
      }),
    );
    return null;
  }
  return value;
}
