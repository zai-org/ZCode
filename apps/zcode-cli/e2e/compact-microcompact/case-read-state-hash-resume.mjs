import { createHash } from "node:crypto";
import { access, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FAKE_MODEL } from "./constants.mjs";
import {
  assertCondition,
  assertProviderCapture,
  buildCaseResult,
  buildRuntimeConfig,
  createApp,
  fakeProviderConfig,
  makeCaseDirs,
  writeProviderConfig,
} from "./case-utils.mjs";
import { writeJsonFile } from "./artifacts.mjs";
import { prepareWorkspace } from "./workspace.mjs";
import {
  chatCompletion,
  startScriptedProvider,
  stopScriptedProvider,
  writeScriptedCaptureFile,
} from "./scripted-provider.mjs";

// 规格：docs/design/v2/tool/17-read-file-state-resume.md「快照不存正文」。
// 真实 CLI、真实 SQLite：快照只存 contentSha256；冷恢复后只 touch 放行、内容变化报 stale；
// 升级前带正文、没有 contentSha256 的旧快照照旧恢复。
const CASE_NAME = "read-state-hash-resume";
const COMPLETION_MARKER = "READ_STATE_HASH_RESUME_E2E_DONE";
const UNEXPECTED_MARKER = "READ_STATE_HASH_RESUME_E2E_UNEXPECTED_EXTRA_REQUEST";
const TARGET_FILE = "target.txt";
const BIG_FILE = "big.txt";
const LEGACY_FILE = "legacy.txt";
const TARGET_INITIAL = "alpha\nbeta\n";
const TARGET_AFTER_EDIT = "gamma\nbeta\n";
const TARGET_AFTER_RESUME_EDIT = "delta\nbeta\n";
// 与上一行同样字节数：大小不变，只有正文哈希能发现变化。
const TARGET_EXTERNAL = "delta\nBETA\n";
const LEGACY_INITIAL = "one\n";
const LEGACY_AFTER_EDIT = "two\n";
const LEGACY_AFTER_RESUME_EDIT = "three\n";
const BIG_HEADER = "HEADER\n";
const BIG_HEADER_EDITED = "HEADER EDITED\n";
const BIG_LINE_COUNT = 400;
// Edit 一个约 21 KB 的文件后，这一条 tool part 的大小上限（升级前它包含整份文件，必然超过）。
const BIG_EDIT_PART_MAX_BYTES = 8 * 1024;
const TOUCH_STEP_MS = 10_000;
const EDIT_SUCCESS = "has been updated successfully";
const STALE_ERROR = "File has been modified since read";
const NOT_READ_ERROR = "File has not been read yet";

export const readStateHashResumeCase = {
  name: CASE_NAME,
  requiresApiKey: false,
  async run(input) {
    const events = [];
    const failures = [];
    const paths = await makeCaseDirs({ ...input, caseName: CASE_NAME });
    const sessionDbPath = join(paths.storageDir, "db", "db.sqlite");
    const files = {
      big: join(paths.workspace, BIG_FILE),
      legacy: join(paths.workspace, LEGACY_FILE),
      target: join(paths.workspace, TARGET_FILE),
    };
    const bigContent = buildBigContent();
    const steps = buildSteps({ bigContent, files });
    let provider;
    let app;

    try {
      await prepareWorkspace({ fixtureDir: input.fixtureDir, workspace: paths.workspace });
      await writeFile(files.target, TARGET_INITIAL);
      await writeFile(files.legacy, LEGACY_INITIAL);
      provider = await startScriptedProvider({
        handler: createStepHandler({ failures, steps }),
        name: CASE_NAME,
      });
      await writeProviderConfig(
        paths.configPath,
        fakeProviderConfig({
          baseURL: provider.baseURL,
          model: FAKE_MODEL,
          storageDir: paths.storageDir,
        }),
      );
      const runtimeConfig = buildRuntimeConfig({
        compact: { contextWindow: 1_000_000, microcompact: { enabled: false } },
        maxTurns: 12,
        workspace: paths.workspace,
      });
      const appInput = {
        configPath: paths.configPath,
        modules: input.modules,
        runtimeConfig,
        sessionDbPath,
        storageDir: paths.storageDir,
      };
      const onEvent = async (event) => events.push(event);

      // 第一段：Read/Edit target，Write/Edit 大文件，Read/Edit legacy。
      app = await createApp(appInput);
      const sessionId = app.sessionId;
      const first = await app.submitPrompt("Run read-state hash phase 1.", { onEvent });
      await app.close?.();
      app = undefined;
      assertPhase({ failures, phase: 1, response: first.response });
      await assertFileContent(files.target, TARGET_AFTER_EDIT);
      await assertFileContent(files.big, bigContent.replace(BIG_HEADER, BIG_HEADER_EDITED));
      await assertFileContent(files.legacy, LEGACY_AFTER_EDIT);
      await access(sessionDbPath);

      const phase1 = readToolParts(sessionDbPath, sessionId);
      assertHashSnapshot(phase1, "call_hash_read_target", "Read", TARGET_INITIAL);
      assertHashSnapshot(phase1, "call_hash_edit_target", "Edit", TARGET_AFTER_EDIT);
      assertHashSnapshot(phase1, "call_hash_write_big", "Write", bigContent);
      const bigEdit = assertHashSnapshot(
        phase1,
        "call_hash_edit_big",
        "Edit",
        bigContent.replace(BIG_HEADER, BIG_HEADER_EDITED),
      );
      assertCondition(
        bigEdit.bytes < BIG_EDIT_PART_MAX_BYTES,
        "Edit on a large file must not persist the whole file in its tool part",
        { partBytes: bigEdit.bytes, fileBytes: Buffer.byteLength(bigContent, "utf8") },
      );
      // 模拟升级前写下的数据：legacy 的 Edit 快照去掉 contentSha256、改回带正文。
      rewriteAsLegacySnapshot(
        sessionDbPath,
        phase1.get("call_hash_edit_legacy"),
        LEGACY_AFTER_EDIT,
      );

      // 第二段：只 touch，冷恢复后 Edit 两个文件都应放行。
      await touch(files.target);
      await touch(files.legacy);
      app = await createApp({ ...appInput, resume: true, sessionId });
      await app.resume?.();
      assertCondition(app.sessionId === sessionId, "phase 2 must resume the original session");
      const second = await app.submitPrompt("Run read-state hash phase 2.", { onEvent });
      await app.close?.();
      app = undefined;
      assertPhase({ failures, phase: 2, response: second.response });
      await assertFileContent(files.target, TARGET_AFTER_RESUME_EDIT);
      await assertFileContent(files.legacy, LEGACY_AFTER_RESUME_EDIT);
      assertHashSnapshot(
        readToolParts(sessionDbPath, sessionId),
        "call_hash_resume_edit_target",
        "Edit",
        TARGET_AFTER_RESUME_EDIT,
      );

      // 第三段：外部改了内容（大小不变），冷恢复后 Edit 必须报 stale 且不改文件。
      await writeFile(files.target, TARGET_EXTERNAL);
      await touch(files.target);
      app = await createApp({ ...appInput, resume: true, sessionId });
      await app.resume?.();
      const third = await app.submitPrompt("Run read-state hash phase 3.", { onEvent });
      await app.close?.();
      app = undefined;
      assertPhase({ failures, phase: 3, response: third.response });
      await assertFileContent(files.target, TARGET_EXTERNAL);
      assertCondition(steps.length === 0, "all scripted steps must be consumed", {
        remaining: steps.map((step) => step.id),
      });
      assertProviderCapture(provider.records);

      await writeScriptedCaptureFile(provider, paths.capturePath);
      await writeJsonFile(paths.eventsPath, events);
      const resultPayload = buildCaseResult({
        capturedProviderRequestCount: provider.records.length,
        caseName: CASE_NAME,
        capturePath: paths.capturePath,
        events,
        eventsPath: paths.eventsPath,
        response: third.response,
        resultPath: paths.resultPath,
        traceId: third.traceId,
      });
      await writeJsonFile(paths.resultPath, resultPayload);
      return resultPayload;
    } catch (error) {
      await writeScriptedCaptureFile(provider, paths.capturePath);
      await writeJsonFile(paths.eventsPath, events);
      throw error;
    } finally {
      await app?.close?.();
      await stopScriptedProvider(provider);
    }
  },
};

/** 每个 step 是一次 provider 请求的回复；check 检查上一条 tool result。 */
function buildSteps({ bigContent, files }) {
  const succeeded = { includes: EDIT_SUCCESS };
  return [
    {
      id: "phase1-read-target",
      phase: 1,
      call: ["call_hash_read_target", "Read", { file_path: files.target }],
    },
    {
      id: "phase1-edit-target",
      phase: 1,
      check: { includes: "alpha" },
      call: [
        "call_hash_edit_target",
        "Edit",
        { file_path: files.target, old_string: "alpha", new_string: "gamma" },
      ],
    },
    {
      id: "phase1-write-big",
      phase: 1,
      check: succeeded,
      call: ["call_hash_write_big", "Write", { file_path: files.big, content: bigContent }],
    },
    {
      id: "phase1-edit-big",
      phase: 1,
      check: { includes: "File created successfully" },
      call: [
        "call_hash_edit_big",
        "Edit",
        { file_path: files.big, old_string: BIG_HEADER, new_string: BIG_HEADER_EDITED },
      ],
    },
    {
      id: "phase1-read-legacy",
      phase: 1,
      check: succeeded,
      call: ["call_hash_read_legacy", "Read", { file_path: files.legacy }],
    },
    {
      id: "phase1-edit-legacy",
      phase: 1,
      check: { includes: "one" },
      call: [
        "call_hash_edit_legacy",
        "Edit",
        { file_path: files.legacy, old_string: "one", new_string: "two" },
      ],
    },
    { id: "phase1-done", phase: 1, check: succeeded },
    {
      id: "phase2-edit-target",
      phase: 2,
      call: [
        "call_hash_resume_edit_target",
        "Edit",
        { file_path: files.target, old_string: "gamma", new_string: "delta" },
      ],
    },
    {
      id: "phase2-edit-legacy",
      phase: 2,
      check: succeeded,
      call: [
        "call_hash_resume_edit_legacy",
        "Edit",
        { file_path: files.legacy, old_string: "two", new_string: "three" },
      ],
    },
    { id: "phase2-done", phase: 2, check: succeeded },
    {
      id: "phase3-edit-target",
      phase: 3,
      call: [
        "call_hash_stale_edit_target",
        "Edit",
        { file_path: files.target, old_string: "delta", new_string: "epsilon" },
      ],
    },
    { id: "phase3-done", phase: 3, check: { includes: STALE_ERROR, allowStale: true } },
  ];
}

function createStepHandler({ failures, steps }) {
  // 断言失败不抛：provider 返回 500 会触发重试，掩盖真正的失败点。记下来，由每段收尾统一检查。
  return async ({ body }) => {
    const step = steps.shift();
    if (!step) {
      failures.push({ reason: "unexpected extra provider request" });
      return { body: chatCompletion({ content: UNEXPECTED_MARKER, model: body?.model }) };
    }
    const previous = lastToolResult(body);
    if (step.check?.includes && !previous.includes(step.check.includes)) {
      failures.push({ step: step.id, reason: `missing "${step.check.includes}"`, previous });
    }
    for (const forbidden of step.check?.allowStale
      ? [NOT_READ_ERROR]
      : [NOT_READ_ERROR, STALE_ERROR]) {
      if (step.check && previous.includes(forbidden)) {
        failures.push({ step: step.id, reason: `unexpected "${forbidden}"`, previous });
      }
    }
    if (!step.call) {
      return {
        body: chatCompletion({ content: `${COMPLETION_MARKER}:${step.phase}`, model: body?.model }),
      };
    }
    const [id, name, args] = step.call;
    return {
      body: chatCompletion({
        model: body?.model,
        toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      }),
    };
  };
}

function lastToolResult(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tool = messages.filter((message) => message?.role === "tool").at(-1);
  if (!tool) return "";
  return typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content ?? "");
}

function assertPhase({ failures, phase, response }) {
  assertCondition(failures.length === 0, `phase ${phase} tool results must match the script`, {
    failures: failures.map((failure) => ({
      ...failure,
      previous: failure.previous?.slice(0, 600),
    })),
  });
  assertCondition(
    response.includes(`${COMPLETION_MARKER}:${phase}`),
    `phase ${phase} must finish`,
    {
      response,
    },
  );
}

/** 只读本会话的 tool part，按 provider 的 tool call id 索引。 */
function readToolParts(dbPath, sessionId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "select id, data, length(cast(data as blob)) as bytes from part where session_id = ?",
      )
      .all(sessionId);
    const parts = new Map();
    for (const row of rows) {
      const data = JSON.parse(row.data);
      if (data.type === "tool") parts.set(data.callID, { bytes: row.bytes, data, id: row.id });
    }
    return parts;
  } finally {
    db.close();
  }
}

function assertHashSnapshot(parts, callID, tool, expectedContent) {
  const part = parts.get(callID);
  const snapshot = part?.data.state?.metadata?.readFileState;
  assertCondition(
    part?.data.state?.status === "completed",
    `${callID} must be a completed tool part`,
    {
      callIDs: [...parts.keys()],
    },
  );
  assertCondition(
    snapshot?.tool === tool &&
      snapshot.contentSha256 === sha256(expectedContent) &&
      !("content" in snapshot),
    `${callID} must persist a hash-only read-state snapshot`,
    { snapshot: snapshot && { ...snapshot, content: snapshot.content?.slice(0, 80) } },
  );
  return part;
}

function rewriteAsLegacySnapshot(dbPath, part, content) {
  assertCondition(Boolean(part), "legacy Edit part must exist before rewriting it");
  const { contentSha256: _hash, ...rest } = part.data.state.metadata.readFileState;
  part.data.state.metadata.readFileState = { ...rest, content };
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("update part set data = ? where id = ?").run(JSON.stringify(part.data), part.id);
  } finally {
    db.close();
  }
}

async function touch(path) {
  const info = await stat(path);
  const mtime = new Date(info.mtimeMs + TOUCH_STEP_MS);
  await utimes(path, mtime, mtime);
}

async function assertFileContent(path, expected) {
  const actual = await readFile(path, "utf8");
  assertCondition(actual === expected, `unexpected content in ${path}`, {
    actual: actual.slice(0, 200),
    expected: expected.slice(0, 200),
  });
}

function buildBigContent() {
  const lines = [BIG_HEADER];
  for (let index = 1; index <= BIG_LINE_COUNT; index += 1) {
    lines.push(`line ${index} read-state hash resume payload ${"x".repeat(16)}\n`);
  }
  return lines.join("");
}

// 与 hashReadFileStateContent 相同：sha256 按 UTF-16LE（JS 字符串码元）计算。
function sha256(text) {
  return createHash("sha256").update(text, "utf16le").digest("hex");
}
