import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

const INSPECTOR_URL = new URL("../lib/conversation-session-formal-admission.mjs", import.meta.url);
const temporaryRoots = [];

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { force: true, recursive: true })));
});

async function inspect(root) {
  let module;
  try {
    module = await import(INSPECTOR_URL.href);
  } catch (error) {
    assert.fail(`formal admission inspector is unavailable: ${error.message}`);
  }
  return module.inspectConversationSessionFormalAdmission(root);
}

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "zcode-formal-admission-"));
  temporaryRoots.push(root);
  return root;
}

async function writeText(root, relativePath, value) {
  const absolutePath = join(root, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, value, "utf8");
}

async function writeJson(root, relativePath, value) {
  await writeText(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function request(
  id,
  { kind = "main", source = "capture", syntheticReason, timingPolicy = "fast-text" } = {},
) {
  return {
    id,
    kind,
    source,
    timingPolicy,
    ...(syntheticReason === undefined ? {} : { syntheticReason }),
  };
}

function providerEntry(manifestRequest) {
  const { id, ...metadata } = manifestRequest;
  return {
    id,
    metadata,
    match: { method: "POST", pathIncludes: "/messages" },
    response: { statusCode: 200, text: { text: "ok" } },
  };
}

async function addFormalCase(
  root,
  caseName,
  {
    caseFixture,
    commonFixture = { version: 1, fixtures: [] },
    manifest,
    specSource = "it('runs', async () => {});\n",
    writeCaseFixture = true,
    writeCommonFixture = true,
    writeManifest = true,
  } = {},
) {
  const spec = `./test/e2e/conversation-session/${caseName}.test.ts`;
  const caseFixturePath = `./test/e2e/fixtures/upstream/conversation-session/${caseName}.json`;
  const defaultRequest = request(`${caseName}-request`);
  const defaultManifest = {
    version: 1,
    caseName,
    spec,
    providerFixtures: ["./test/e2e/fixtures/upstream/common.json", caseFixturePath],
    fileFixtures: [],
    requests: [defaultRequest],
  };
  const defaultCaseFixture = {
    version: 1,
    caseName,
    spec,
    fixtures: [providerEntry(defaultRequest)],
  };

  await writeText(
    root,
    `packages/desktop/test/e2e/conversation-session/${caseName}.test.ts`,
    specSource,
  );
  if (writeCommonFixture) {
    await writeJson(root, "packages/desktop/test/e2e/fixtures/upstream/common.json", commonFixture);
  }
  if (writeCaseFixture) {
    await writeJson(
      root,
      `packages/desktop/test/e2e/fixtures/upstream/conversation-session/${caseName}.json`,
      caseFixture ?? defaultCaseFixture,
    );
  }
  if (writeManifest) {
    const manifestValue = manifest ?? defaultManifest;
    const manifestPath = `packages/desktop/test/e2e/fixtures/cases/conversation-session/${caseName}.json`;
    if (typeof manifestValue === "string") {
      await writeText(root, manifestPath, manifestValue);
    } else {
      await writeJson(root, manifestPath, manifestValue);
    }
  }

  return { caseFixturePath, defaultManifest, defaultRequest, spec };
}

function codes(result, caseName) {
  return result.formal.rejected
    .find((item) => item.caseName === caseName)
    ?.reasons.map((reason) => reason.code);
}

test("admits a valid V4 formal case and permits compatible TID_CHAT_TOOL usage", async () => {
  const root = await makeRoot();
  await addFormalCase(root, "valid-v4", {
    specSource:
      "const selector = '[data-testid=\"TID_CHAT_TOOL_RESULT\"]';\n" +
      "it('runs', async () => selector);\n",
  });

  const result = await inspect(root);

  assert.deepEqual(result.counts, {
    formalAdmitted: 1,
    formalRejected: 0,
    legacyHarness: 0,
    legacyHarnessFormal: 0,
    legacyHarnessPending: 0,
    missingFixture: 0,
    missingManifest: 0,
    pending: 0,
    pendingFixtureRejected: 0,
  });
  assert.deepEqual(result.formal.admitted, [
    {
      caseName: "valid-v4",
      specPath: "packages/desktop/test/e2e/conversation-session/valid-v4.test.ts",
    },
  ]);
});

test("treats an omitted optional fileFixtures field as an empty list", async () => {
  const root = await makeRoot();
  const values = await addFormalCase(root, "no-file-fixtures");
  const { fileFixtures: _fileFixtures, ...manifest } = values.defaultManifest;
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/no-file-fixtures.json",
    manifest,
  );

  const result = await inspect(root);

  assert.equal(result.counts.formalAdmitted, 1);
  assert.equal(result.counts.formalRejected, 0);
});

test("accepts a runtime-created file fixture descriptor without requiring it on disk", async () => {
  const root = await makeRoot();
  const values = await addFormalCase(root, "runtime-file-fixture");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/runtime-file-fixture.json",
    {
      ...values.defaultManifest,
      fileFixtures: [
        {
          description: "provider tool creates this file during the replay",
          path: "/tmp/generated-by-provider.txt",
          source: "created-by-provider-tool",
        },
      ],
    },
  );

  const result = await inspect(root);

  assert.equal(result.counts.formalAdmitted, 1);
  assert.equal(result.counts.formalRejected, 0);
});

test("rejects exact legacy helper imports and prepareConversationE2E calls", async () => {
  const root = await makeRoot();
  await addFormalCase(root, "legacy-import", {
    specSource:
      "import { helper } from '../helpers/conversation-session.js';\n" +
      "it('runs', async () => helper);\n",
  });
  await addFormalCase(root, "legacy-prepare", {
    specSource: "it('runs', async () => prepareConversationE2E());\n",
  });

  const result = await inspect(root);

  assert.equal(result.counts.formalRejected, 2);
  assert.equal(result.counts.legacyHarnessFormal, 2);
  assert.ok(codes(result, "legacy-import").includes("LEGACY_HELPER_IMPORT"));
  assert.ok(codes(result, "legacy-prepare").includes("LEGACY_PREPARE_CALL"));
});

test("rejects missing manifests and missing case-local fixtures", async () => {
  const root = await makeRoot();
  await addFormalCase(root, "missing-manifest", { writeManifest: false });
  await addFormalCase(root, "missing-fixture", { writeCaseFixture: false });

  const result = await inspect(root);

  assert.equal(result.counts.missingManifest, 1);
  assert.equal(result.counts.missingFixture, 1);
  assert.ok(codes(result, "missing-manifest").includes("MISSING_CASE_MANIFEST"));
  assert.ok(codes(result, "missing-fixture").includes("MISSING_CASE_FIXTURE"));
});

test("rejects invalid manifest JSON, version, case identity, and spec path", async () => {
  const root = await makeRoot();
  await addFormalCase(root, "invalid-json", { manifest: "{not-json\n" });

  const wrongVersion = await addFormalCase(root, "wrong-version");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/wrong-version.json",
    { ...wrongVersion.defaultManifest, version: 2 },
  );

  const wrongIdentity = await addFormalCase(root, "wrong-identity");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/wrong-identity.json",
    { ...wrongIdentity.defaultManifest, caseName: "someone-else" },
  );

  const wrongSpec = await addFormalCase(root, "wrong-spec");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/wrong-spec.json",
    { ...wrongSpec.defaultManifest, spec: "./test/e2e/other.test.ts" },
  );

  const wrongFixtureSpec = await addFormalCase(root, "wrong-fixture-spec");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/upstream/conversation-session/wrong-fixture-spec.json",
    {
      version: 1,
      caseName: "wrong-fixture-spec",
      spec: "./test/e2e/other.test.ts",
      fixtures: [providerEntry(wrongFixtureSpec.defaultRequest)],
    },
  );

  const result = await inspect(root);

  assert.ok(codes(result, "invalid-json").includes("INVALID_MANIFEST_JSON"));
  assert.ok(codes(result, "wrong-version").includes("INVALID_MANIFEST_VERSION"));
  assert.ok(codes(result, "wrong-identity").includes("MANIFEST_CASE_NAME_MISMATCH"));
  assert.ok(codes(result, "wrong-spec").includes("MANIFEST_SPEC_PATH_MISMATCH"));
  assert.ok(codes(result, "wrong-fixture-spec").includes("CASE_FIXTURE_SPEC_PATH_MISMATCH"));
});

test("rejects providerRequestPolicy none when requests are declared", async () => {
  const root = await makeRoot();
  const values = await addFormalCase(root, "policy-none");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/policy-none.json",
    { ...values.defaultManifest, providerRequestPolicy: "none" },
  );

  const result = await inspect(root);

  assert.ok(codes(result, "policy-none").includes("PROVIDER_REQUEST_POLICY_NONE_WITH_REQUESTS"));
});

test("rejects synthetic requests without a non-empty synthetic reason", async () => {
  const root = await makeRoot();
  const values = await addFormalCase(root, "synthetic-no-reason");
  const syntheticRequest = request("synthetic-request", {
    source: "synthetic",
  });
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/synthetic-no-reason.json",
    { ...values.defaultManifest, requests: [syntheticRequest] },
  );
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/upstream/conversation-session/synthetic-no-reason.json",
    { version: 1, fixtures: [providerEntry(syntheticRequest)] },
  );

  const result = await inspect(root);

  assert.ok(codes(result, "synthetic-no-reason").includes("SYNTHETIC_REASON_MISSING"));
});

test("rejects case-local request ledger ID, order, and metadata mismatches", async () => {
  const root = await makeRoot();

  const idValues = await addFormalCase(root, "ledger-id");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/ledger-id.json",
    { ...idValues.defaultManifest, requests: [request("invented-id")] },
  );

  const orderValues = await addFormalCase(root, "ledger-order");
  const first = request("first");
  const second = request("second");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/ledger-order.json",
    { ...orderValues.defaultManifest, requests: [second, first] },
  );
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/upstream/conversation-session/ledger-order.json",
    { version: 1, fixtures: [providerEntry(first), providerEntry(second)] },
  );

  const metadataValues = await addFormalCase(root, "ledger-metadata");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/ledger-metadata.json",
    {
      ...metadataValues.defaultManifest,
      requests: [request("ledger-metadata-request", { timingPolicy: "fault-stream" })],
    },
  );

  const result = await inspect(root);

  assert.ok(codes(result, "ledger-id").includes("REQUEST_LEDGER_ID_MISMATCH"));
  assert.ok(codes(result, "ledger-order").includes("REQUEST_LEDGER_ORDER_MISMATCH"));
  assert.ok(codes(result, "ledger-metadata").includes("REQUEST_LEDGER_METADATA_MISMATCH"));
});

test("rejects omitted case fixtures and missing declared provider or file paths", async () => {
  const root = await makeRoot();

  const omitted = await addFormalCase(root, "omitted-case-fixture");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/omitted-case-fixture.json",
    {
      ...omitted.defaultManifest,
      providerFixtures: ["./test/e2e/fixtures/upstream/common.json"],
    },
  );

  const missingProvider = await addFormalCase(root, "missing-provider-path");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/missing-provider-path.json",
    {
      ...missingProvider.defaultManifest,
      providerFixtures: [
        ...missingProvider.defaultManifest.providerFixtures,
        "./test/e2e/fixtures/upstream/not-there.json",
      ],
    },
  );

  const missingFile = await addFormalCase(root, "missing-file-path");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/missing-file-path.json",
    {
      ...missingFile.defaultManifest,
      fileFixtures: ["./test/e2e/fixtures/fs/not-there/input.txt"],
    },
  );

  const result = await inspect(root);

  assert.ok(codes(result, "omitted-case-fixture").includes("MANIFEST_OMITS_CASE_FIXTURE"));
  assert.ok(codes(result, "missing-provider-path").includes("MISSING_PROVIDER_FIXTURE"));
  assert.ok(codes(result, "missing-file-path").includes("MISSING_FILE_FIXTURE"));
});

test("counts a pending legacy spec without rejecting formal admission", async () => {
  const root = await makeRoot();
  await writeText(
    root,
    "packages/desktop/test/e2e/conversation-session/manual-review/pending/legacy.test.ts",
    "import { prepareConversationE2E } from '../../../helpers/conversation-session.js';\n" +
      "it('runs', async () => prepareConversationE2E());\n",
  );

  const result = await inspect(root);

  assert.equal(result.counts.formalAdmitted, 0);
  assert.equal(result.counts.formalRejected, 0);
  assert.equal(result.counts.pending, 1);
  assert.equal(result.counts.pendingFixtureRejected, 0);
  assert.equal(result.counts.legacyHarness, 1);
  assert.equal(result.counts.legacyHarnessPending, 1);
  assert.deepEqual(result.formal.rejected, []);
});

test("checks pending fixture metadata against the canonical formal target", async () => {
  const root = await makeRoot();
  const caseName = "pending-contract";
  const pendingSpec = `./test/e2e/conversation-session/manual-review/pending/${caseName}.test.ts`;
  const canonicalSpec = `./test/e2e/conversation-session/${caseName}.test.ts`;
  await writeText(
    root,
    `packages/desktop/test/e2e/conversation-session/manual-review/pending/${caseName}.test.ts`,
    "it('runs', async () => {});\n",
  );
  await writeJson(
    root,
    `packages/desktop/test/e2e/fixtures/cases/conversation-session/${caseName}.json`,
    { version: 1, caseName, spec: canonicalSpec },
  );
  await writeJson(
    root,
    `packages/desktop/test/e2e/fixtures/upstream/conversation-session/${caseName}.json`,
    { version: 1, caseName, spec: pendingSpec, fixtures: [] },
  );

  const result = await inspect(root);

  assert.equal(result.counts.pendingFixtureRejected, 1);
  assert.deepEqual(
    result.pending[0].reasons.map((reason) => reason.code),
    ["PENDING_FIXTURE_FORMAL_TARGET_MISMATCH"],
  );
  assert.equal(result.pending[0].canonicalSpecPath.endsWith(`${caseName}.test.ts`), true);
});

test("discovers nested scenarios and retains pending canonical scenario", async () => {
  const root = await makeRoot();
  await addFormalCase(root, "nested-formal");
  const domain = "packages/desktop/test/e2e/conversation-session";
  await mkdir(join(root, domain, "queue"), { recursive: true });
  await rename(
    join(root, domain, "nested-formal.test.ts"),
    join(root, domain, "queue/nested-formal.test.ts"),
  );
  for (const area of ["cases", "upstream"]) {
    const file = `packages/desktop/test/e2e/fixtures/${area}/conversation-session/nested-formal.json`;
    const value = JSON.parse(await readFile(join(root, file), "utf8"));
    value.spec = "./test/e2e/conversation-session/queue/nested-formal.test.ts";
    await writeJson(root, file, value);
  }
  await writeText(
    root,
    `${domain}/remote/connection/manual-review/pending/nested-pending.test.ts`,
    "it('pending', () => {});",
  );
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/nested-pending.json",
    {
      version: 1,
      caseName: "nested-pending",
      spec: "./test/e2e/conversation-session/remote/connection/nested-pending.test.ts",
    },
  );
  const result = await inspect(root);
  assert.equal(result.counts.formalAdmitted, 1);
  assert.equal(result.counts.formalRejected, 0);
  assert.equal(result.counts.pending, 1);
  assert.equal(result.counts.pendingFixtureRejected, 0);
  assert.equal(
    result.pending[0].canonicalSpecPath,
    `${domain}/remote/connection/nested-pending.test.ts`,
  );
});
