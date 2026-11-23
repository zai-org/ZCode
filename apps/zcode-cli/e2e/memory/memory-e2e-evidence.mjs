import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeScriptedCaptureFile } from "../compact-microcompact/scripted-provider.mjs";
import {
  classifyRequest,
  existingMemoryFile,
  initialProjectMemoryIndex,
  memoryE2EText,
  requestText,
  updatedProjectMemoryIndex,
} from "./memory-e2e-provider.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../../..");

export async function verifyMemoryE2EEvidence({
  paths,
  provider,
  retrievalBranch,
  scenarioResults,
}) {
  const records = provider.records
    .map((record, index) => normalizeRecord(record, index + 1))
    .sort(
      (left, right) => left.startedAt.localeCompare(right.startedAt) || left.index - right.index,
    );
  const categoryCounts = countBy(records, (record) => record.category);
  const assertions = [];

  const retrievalBranchRequests = records.filter(
    (record) =>
      record.category === "main" &&
      record.text.includes(memoryE2EText.defaultBranchPrompt) &&
      !record.text.includes(memoryE2EText.extractionPrompt),
  );
  assertCondition(
    retrievalBranchRequests.length === 2,
    "Memory retrieval turn must contain one initial request and one tool continuation",
    retrievalBranchRequests.map(({ index }) => index),
  );
  const mainMemoryFixture = await fixture(
    retrievalBranch === "semantic-recall"
      ? "main-memory-semantic-recall.md"
      : "main-memory-default-index.md",
  );
  const expectedMainMemory = mainMemoryFixture.replaceAll(
    "<MEMORY_ROOT>",
    paths.project.memoryRoot,
  );
  const mainMemoryIndexFixture = await fixture("main-memory-index.md");
  const expectedMainMemoryIndex = mainMemoryIndexFixture.replaceAll(
    "<MEMORY_INDEX_PATH>",
    paths.project.indexFile,
  );
  for (const request of retrievalBranchRequests) {
    assertContains(
      request.text,
      expectedMainMemory,
      "every Main request must contain the exact active-branch Memory section",
    );
  }
  if (retrievalBranch === "default-index") {
    for (const request of retrievalBranchRequests) {
      assertContains(
        request.text,
        expectedMainMemoryIndex,
        "every default-branch Main request must contain the exact MEMORY.md user-context source",
      );
    }
    assertCondition(
      records.every((record) => record.category !== "selector"),
      "default Memory branch must not issue Selector requests",
      categoryCounts,
    );
    assertCondition(
      records.every((record) => !record.text.includes(memoryE2EText.recalledPrefix)),
      "default Memory branch must not inject relevant_memory",
    );
    assertions.push("default-main-memory-index-without-selector-recall");
  } else {
    assertCondition(
      retrievalBranchRequests.every((request) => !request.text.includes(expectedMainMemoryIndex)),
      "semantic Memory branch must not load MEMORY.md",
    );
    const recalledRequest = requireRecord(
      retrievalBranchRequests,
      (record) => record.text.includes(memoryE2EText.recalledPrefix),
      "semantic Memory continuation with relevant_memory",
    );
    assertContains(
      recalledRequest.text,
      existingMemoryFile().trimEnd(),
      "semantic Memory continuation must contain the selected fact",
    );
    assertions.push("semantic-main-recall-without-pointer-index");
  }
  const existingFile = await readFile(paths.project.existingFile, "utf8");
  assertCondition(
    existingFile === existingMemoryFile(),
    "Memory retrieval must not mutate an existing fact",
    existingFile,
  );

  const extraction = requireRecord(
    records,
    (record) =>
      record.category === "extraction" && record.text.includes(memoryE2EText.extractionPrompt),
    "background Extraction request",
  );
  assertContains(
    extraction.text,
    memoryE2EText.extractionPrompt,
    "Extraction must use the successful Main turn snapshot",
  );
  assertContains(
    extraction.text,
    memoryE2EText.extractionMarker,
    "Extraction request must contain the Memory extraction prompt",
  );
  const extractedFile = await readFile(paths.project.extractedFile, "utf8");
  assertContains(
    extractedFile,
    memoryE2EText.extractionWriteMarker,
    "Extraction must write the scripted fact",
  );
  assertContains(
    extractedFile,
    "node_type: memory",
    "Extraction Write must add the fixed Memory node type",
  );
  assertContains(
    extractedFile,
    "originSessionId: memory-e2e-project-session",
    "Extraction Write must add the creating session",
  );
  assertions.push("background-extraction-trajectory-and-file");

  const updatedIndex = await readFile(paths.project.indexFile, "utf8");
  assertCondition(
    updatedIndex === updatedProjectMemoryIndex(),
    "Extraction must append the new fact pointer to MEMORY.md",
    updatedIndex,
  );
  if (retrievalBranch === "default-index") {
    const nextSessionRequest = requireRecord(
      records,
      (record) =>
        record.category === "main" && record.text.includes(memoryE2EText.extractedDefaultPrompt),
      "next-session default Memory request",
    );
    const expectedUpdatedMainMemoryIndex = expectedMainMemoryIndex.replace(
      initialProjectMemoryIndex().trimEnd(),
      updatedProjectMemoryIndex().trimEnd(),
    );
    assertContains(
      nextSessionRequest.text,
      expectedUpdatedMainMemoryIndex,
      "next session must consume the Extraction pointer through the default MEMORY.md source",
    );
    assertions.push("extraction-to-next-session-default-index-consumption");
  } else {
    const nextSessionRequest = requireRecord(
      records,
      (record) =>
        record.category === "main" &&
        record.text.includes(memoryE2EText.extractedDefaultPrompt) &&
        record.text.includes(memoryE2EText.recalledPrefix),
      "next-session semantic Memory continuation",
    );
    assertContains(
      nextSessionRequest.text,
      memoryE2EText.extractionWriteMarker,
      "next session must consume the fact produced by Extraction",
    );
    assertContains(
      nextSessionRequest.text,
      "originSessionId: memory-e2e-project-session",
      "semantic Recall must preserve the extracted fact metadata",
    );
    assertCondition(
      !nextSessionRequest.text.includes(expectedMainMemoryIndex),
      "semantic next session must not also load MEMORY.md",
    );
    assertions.push("extraction-to-next-session-semantic-recall-consumption");
  }

  const customRequest = requireRecord(
    records,
    (record) => record.category === "custom_agent",
    "custom agent Memory request",
  );
  assertContains(
    customRequest.text,
    memoryE2EText.customMemoryMarker,
    "custom child must contain the persistent Memory prompt",
  );
  assertContains(
    customRequest.text,
    "Keep review findings evidence-first",
    "custom child must read its existing MEMORY.md",
  );
  const customTools = toolNames(customRequest.body);
  for (const tool of ["Grep", "Write", "Edit"]) {
    assertCondition(customTools.includes(tool), `custom child must expose ${tool}`, customTools);
  }
  assertCondition(!customTools.includes("Read"), "custom Memory must not add Read", customTools);
  const customFile = await readFile(paths.custom.memoryFile, "utf8");
  assertContains(
    customFile,
    memoryE2EText.customWriteMarker,
    "custom agent must write its scoped fact",
  );
  assertCondition(
    /node_type:\s*memory/u.test(customFile),
    "custom agent Write must add the fixed Memory node type",
    customFile,
  );
  assertCondition(
    /originSessionId:\s*[^\s]+/u.test(customFile),
    "custom agent Write must add its child session id",
    customFile,
  );
  assertCondition(
    !(await fileExists(join(paths.project.memoryRoot, "review-convention.md"))),
    "custom agent fact must not leak into the Main project Memory root",
  );
  assertions.push("custom-agent-memory-prompt-tools-file");

  const disabledRequest = requireRecord(
    records,
    (record) => record.category === "main" && record.text.includes(memoryE2EText.disabledPrompt),
    "disabled Memory Main request",
  );
  // 只看 Memory 段标题；默认 prompt 总带 `# Memory, notes and feedback`，那一段不算 Memory 注入。
  assertCondition(
    !disabledRequest.text.includes("# Memory\n"),
    "disabled Memory request must not contain the Memory section",
  );
  const disabledScenarioRequests = records.filter((record) => record.scenario === "disabled");
  assertCondition(
    disabledScenarioRequests.length === 1 && disabledScenarioRequests[0]?.category === "main",
    "disabled Memory must not issue selector or Extraction requests",
    disabledScenarioRequests.map(({ category }) => category),
  );
  assertCondition(
    !(await fileExists(paths.disabled.memoryRoot)),
    "disabled Memory must not create the project root",
  );
  assertions.push("memory-disabled-gate");

  const headlessBoundary = verifyHeadlessRequestBoundary(records);
  const headlessRequest = headlessBoundary.mainRequest;
  const expectedHeadlessMemory = mainMemoryFixture.replaceAll(
    "<MEMORY_ROOT>",
    paths.headless.memoryRoot,
  );
  assertContains(
    headlessRequest.text,
    expectedHeadlessMemory,
    "headless Main request must retain the active Memory system section",
  );
  if (retrievalBranch === "default-index") {
    const expectedHeadlessMemoryIndex = mainMemoryIndexFixture.replaceAll(
      "<MEMORY_INDEX_PATH>",
      paths.headless.indexFile,
    );
    assertContains(
      headlessRequest.text,
      expectedHeadlessMemoryIndex,
      "headless Main request must retain the default MEMORY.md source",
    );
  }
  const headlessExistingFile = await readFile(paths.headless.existingFile, "utf8");
  const headlessIndex = await readFile(paths.headless.indexFile, "utf8");
  const headlessMemoryFiles = (await readdir(paths.headless.memoryRoot)).sort();
  assertCondition(
    headlessExistingFile === existingMemoryFile(),
    "headless runtime must not mutate an existing Memory fact",
    headlessExistingFile,
  );
  assertCondition(
    headlessIndex === initialProjectMemoryIndex(),
    "headless runtime must not mutate MEMORY.md",
    headlessIndex,
  );
  assertCondition(
    headlessMemoryFiles.join("\n") === ["MEMORY.md", "database-test-policy.md"].sort().join("\n"),
    "headless runtime must not create an extracted Memory file",
    headlessMemoryFiles,
  );
  assertions.push("headless-main-memory-without-extraction");

  const shutdownRequests = records.filter((record) => record.scenario === "shutdown");
  assertCondition(
    shutdownRequests.length === 2 &&
      shutdownRequests[0]?.category === "main" &&
      shutdownRequests[1]?.category === "extraction",
    "session close must stop after the in-flight Extraction request without a tool continuation",
    shutdownRequests.map(({ category, index }) => ({ category, index })),
  );
  assertCondition(
    scenarioResults.closeCancellation.closeDurationMs < 2_000,
    "session close must not wait for the blocked Extraction provider response",
    scenarioResults.closeCancellation,
  );
  assertCondition(
    !(await fileExists(paths.shutdown.cancelledFile)),
    "late Extraction tool-use must not write after session close",
    paths.shutdown.cancelledFile,
  );
  assertions.push("session-close-cancels-in-flight-extraction");

  // 固定完整 trajectory，避免额外的 Main retry 或重放被 requireRecord 忽略。
  assertCondition(
    categoryCounts.main === (retrievalBranch === "semantic-recall" ? 10 : 9),
    `expected the exact ${retrievalBranch} Main request count`,
    categoryCounts,
  );
  // Bug 根因：headless 只关闭 Extraction；semantic Recall prefetch 与 Main 并发，direct-answer
  // 结束时 Selector 可能已经到达 provider，也可能在到达前被取消，不能计入固定 trajectory。
  const stableSelectorRequestCount = countStableSelectorRequests(records);
  assertCondition(
    stableSelectorRequestCount === (retrievalBranch === "semantic-recall" ? 2 : 0),
    `expected the exact ${retrievalBranch} Selector request count`,
    { categoryCounts, headlessSelectorRequestCount: headlessBoundary.selectorRequestCount },
  );
  verifyStableExtractionRequestCount(categoryCounts.extraction);
  assertCondition(
    categoryCounts.custom_agent === 2,
    "expected one custom-agent tool turn and one completion turn",
    categoryCounts,
  );

  return {
    assertions,
    categoryCounts,
    files: {
      customFile,
      existingFile,
      extractedFile,
      headlessExistingFile,
      headlessIndex,
      updatedIndex,
    },
    records,
  };
}

export async function writeMemoryE2EArtifacts({
  artifactsRoot,
  evidence,
  paths,
  provider,
  result,
}) {
  await writeScriptedCaptureFile(provider, join(artifactsRoot, "provider-capture.json"));
  await writeFile(
    join(artifactsRoot, "trajectory.jsonl"),
    evidence.records
      .map((record) =>
        JSON.stringify({
          category: record.category,
          index: record.index,
          requestBody: record.body,
          scenario: record.scenario,
          startedAt: record.startedAt,
        }),
      )
      .join("\n") + "\n",
  );
  await writeFile(
    join(artifactsRoot, "trajectory-summary.json"),
    `${JSON.stringify(
      {
        assertions: evidence.assertions,
        categoryCounts: evidence.categoryCounts,
        retrievalBranch: result.retrievalBranch,
        requests: evidence.records.map(({ category, index, scenario, startedAt }) => ({
          category,
          index,
          scenario,
          startedAt,
        })),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(artifactsRoot, "memory-files.json"),
    `${JSON.stringify(
      {
        custom: { content: evidence.files.customFile, path: paths.custom.memoryFile },
        extraction: { content: evidence.files.extractedFile, path: paths.project.extractedFile },
        headlessExistingFact: {
          content: evidence.files.headlessExistingFile,
          path: paths.headless.existingFile,
        },
        headlessIndex: {
          content: evidence.files.headlessIndex,
          path: paths.headless.indexFile,
        },
        projectIndex: { content: evidence.files.updatedIndex, path: paths.project.indexFile },
        existingFact: { content: evidence.files.existingFile, path: paths.project.existingFile },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(artifactsRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
}

function normalizeRecord(record, index) {
  const body = JSON.parse(record.requestBody);
  const text = requestText(body);
  return {
    body,
    category: classifyRequest(body),
    index,
    scenario: classifyScenario(text),
    startedAt: record.startedAt,
    text,
  };
}

function classifyScenario(text) {
  if (text.includes(memoryE2EText.closeCancellationPrompt)) return "shutdown";
  if (text.includes(memoryE2EText.disabledPrompt)) return "disabled";
  if (text.includes(memoryE2EText.headlessPrompt)) return "headless";
  if (
    text.includes(memoryE2EText.customParentPrompt) ||
    text.includes(memoryE2EText.customTaskPrompt) ||
    text.includes(memoryE2EText.customMemoryMarker)
  ) {
    return "custom";
  }
  return "project";
}

function toolNames(body) {
  return Array.isArray(body.tools)
    ? body.tools
        .map((tool) => tool?.function?.name ?? tool?.name)
        .filter((name) => typeof name === "string")
    : [];
}

async function fixture(name) {
  return (
    await readFile(
      join(repoRoot, "apps/zcode-cli/packages/core/tests/fixtures/memory", name),
      "utf8",
    )
  ).trimEnd();
}

function requireRecord(records, predicate, label) {
  const record = records.find(predicate);
  assertCondition(
    record,
    `Missing ${label}`,
    records.map(({ category, scenario }) => ({ category, scenario })),
  );
  return record;
}

export function verifyHeadlessRequestBoundary(records) {
  const headlessRequests = records.filter((record) => record.scenario === "headless");
  const mainRequests = headlessRequests.filter((record) => record.category === "main");
  const selectorRequests = headlessRequests.filter((record) => record.category === "selector");
  const extractionRequests = headlessRequests.filter((record) => record.category === "extraction");
  const details = headlessRequests.map(({ category, index }) => ({ category, index }));

  assertCondition(
    mainRequests.length === 1,
    "headless Memory must issue exactly one Main request",
    details,
  );
  assertCondition(
    extractionRequests.length === 0,
    "headless Memory must not issue Extraction requests",
    details,
  );
  assertCondition(
    selectorRequests.length <= 1,
    "headless Memory must not issue duplicate Selector requests",
    details,
  );

  return {
    mainRequest: mainRequests[0],
    selectorRequestCount: selectorRequests.length,
  };
}

export function countStableSelectorRequests(records) {
  return records.filter(
    (record) => record.category === "selector" && record.scenario !== "headless",
  ).length;
}

export function verifyStableExtractionRequestCount(count) {
  // Bug 根因：首个 no-op Extraction 与紧随其后的用户提交并发；scheduler 明确只保留
  // latest pending snapshot，因此它若尚未开始会被下一份快照合并，完整轨迹会少一次 no-op。
  assertCondition(
    count === 5 || count === 6,
    "expected five or six Extraction requests after optional initial no-op coalescing",
    { count },
  );
}

function assertContains(actual, expected, message) {
  assertCondition(actual.includes(expected), message, {
    expected,
    tail: actual.slice(-2_000),
  });
}

function assertCondition(condition, message, details) {
  if (condition) return;
  const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
