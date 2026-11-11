#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const zcodeRoot = join(homedir(), ".zcode");
const cliDbPath = join(zcodeRoot, "cli", "db", "db.sqlite");
const taskIndexPath = join(zcodeRoot, "v2", "tasks-index.sqlite");

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.verify) {
  verifyTask(String(args.verify));
  process.exit(0);
}

if (args.delete) {
  deleteTask(String(args.delete));
  process.exit(0);
}

const workspacePath = resolve(String(args.workspace ?? process.cwd()));
const turnCount = Number(args.turns ?? 3000);
if (!Number.isInteger(turnCount) || turnCount <= 0) {
  throw new Error(`Invalid --turns value: ${args.turns}`);
}

const result = generateTask({
  workspacePath,
  turnCount,
  title: String(args.title ?? "Performance Fixture Large Mixed Task"),
  backup: args.backup !== false,
});
console.log(JSON.stringify(result, null, 2));

function parseArgs(argv) {
  const out = { backup: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--workspace") out.workspace = argv[++i];
    else if (arg === "--turns") out.turns = argv[++i];
    else if (arg === "--title") out.title = argv[++i];
    else if (arg === "--verify") out.verify = argv[++i];
    else if (arg === "--delete") out.delete = argv[++i];
    else if (arg === "--no-backup") out.backup = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  generate:
    node generate-large-task-fixture.mjs --workspace "$PWD" --turns 3000
  verify:
    node generate-large-task-fixture.mjs --verify <sessionId>
  delete:
    node generate-large-task-fixture.mjs --delete <sessionId>
`);
}

function generateTask({ workspacePath, turnCount, title, backup }) {
  assertDatabases();
  const backupDir = backup ? backupDatabases() : null;
  const now = Date.now();
  const stamp = new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const sessionId = `sess_perf_large_${stamp}_${randomUUID().slice(0, 8)}`;
  const traceId = `trace_perf_large_${stamp}`;
  const workspaceKey = workspacePath;
  const workspaceHash = hash12(workspaceKey);
  const providerId = "693f9c23-72a5-4f1f-bf4a-4b958add6472";
  const modelId = "deepseek-v4-flash";
  const model = `${providerId}/${modelId}`;
  const baseTime = now - 1000 * 60 * 60 * 24;
  const manifestPath = join(zcodeRoot, "perf-task-manifests", `${sessionId}.json`);
  let partCount = 0;

  const cli = openDb(cliDbPath);
  const idx = openDb(taskIndexPath);
  try {
    execTx(cli, () => {
      insertSession(cli, { sessionId, workspacePath, workspaceHash, traceId, title, baseTime, now, turnCount });
      const insertMsg = cli.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)");
      const insertPart = cli.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)");
      const insertTodo = cli.prepare("insert into todo (session_id, content, status, priority, position, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?)");
      const insertEntry = cli.prepare("insert into session_entry (id, session_id, type, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)");
      const insertUsage = cli.prepare(`insert into model_usage (id, logical_request_id, attempt_index, session_id, turn_id, trace_id, span_id, assistant_message_id, parent_user_message_id, query_source, provider_id, model_id, variant, agent, mode, task_type, status, started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms, finish_reason, tool_call_count, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, provider_total_tokens, computed_total_tokens, retry_count, retryable, cancelled_by_user, context_exceeded, error_type, error_code, error_message, raw_usage_json, provider_metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 'zcode-agent', ?, 'interactive', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, null, null, null, ?, ?)`);
      const insertTurnUsage = cli.prepare(`insert into turn_usage (session_id, turn_id, trace_id, user_message_id, status, started_at, first_model_start_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms, model_request_count, model_retry_count, tool_call_count, tool_error_count, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens, retryable, cancelled_by_user, context_exceeded, error_type, error_code) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, null, null)`);

      for (let n = 0; n < turnCount; n += 1) {
        const counts = insertTurn({ insertMsg, insertPart, insertUsage, insertTurnUsage, sessionId, traceId, workspacePath, providerId, modelId, baseTime, n });
        partCount += counts.partCount;
      }

      for (let i = 0; i < 60; i += 1) {
        insertTodo.run(sessionId, `Synthetic large task todo ${i}: validate ${["scroll", "search", "tool rendering", "permission", "diff", "mobile replayable"][i % 6]}`, i % 5 === 0 ? "completed" : i % 3 === 0 ? "in_progress" : "pending", ["high", "medium", "low"][i % 3], i, baseTime + i, now);
      }
      insertEntry.run(`${sessionId}:fixture_note`, sessionId, "perf_fixture/manifest", baseTime, now, json({ sessionId, turnCount, generatedAt: now, workspacePath }));
      cli.prepare("insert into session_target (session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(sessionId, `target_${sessionId}`, "Generate a very large synthetic task for UI and persistence performance testing.", title, "complete", 10000000, 52000000, 7200, baseTime, now);
    });

    execTx(idx, () => {
      const searchable = repeatLine(`Performance Fixture Large Mixed Task ${sessionId}: toolcall thinking content diff permission ask user question patch compaction subagent retry todo usage`, 1800).slice(0, 200000);
      const meta = { taskId: sessionId, traceId, title, workspacePath, createdAt: baseTime, updatedAt: now, mode: "build", model, provider: "glm", status: "completed", changeSummary: { additions: 42000, deletions: 17000, files: 1300 } };
      idx.prepare("delete from tasks where workspace_key = ? and task_id = ?").run(workspaceKey, sessionId);
      idx.prepare(`insert into tasks (workspace_key, workspace_path, workspace_identity, task_id, title, task_status, provider, mode, model, migration_source, forked_from_task_id, created_at, updated_at, unread_at, pinned, archived, deleted, title_overridden, searchable_text, meta_json) values (?, ?, null, ?, ?, ?, ?, ?, ?, null, null, ?, ?, null, 1, 0, 0, 1, ?, ?)`).run(workspaceKey, workspacePath, sessionId, title, "completed", "glm", "build", model, baseTime, now, searchable, json(meta));
    });
  } finally {
    cli.close();
    idx.close();
  }

  const manifest = { sessionId, traceId, title, workspacePath, workspaceKey, workspaceHash, cliDbPath, taskIndexPath, manifestPath, generatedAt: new Date(now).toISOString(), turnCount, messageCount: turnCount * 2, partCount, todoCount: 60, modelUsageCount: turnCount, backupDir };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${json(manifest)}\n`);
  return manifest;
}

function insertSession(db, input) {
  // 本地会话按目录归属；把目录哈希写成显式身份会使冷恢复报 session-lineage-invalid。
  db.prepare(`insert into session (id, project_id, workspace_id, parent_id, trace_id, task_type, slug, directory, path, title, title_source, title_message_id, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_title_updated, time_compacting, time_archived) values (?, ?, ?, null, ?, 'interactive', ?, ?, ?, ?, 'custom', null, 'perf-fixture', null, ?, ?, ?, ?, null, ?, ?, ?, ?, null, null)`).run(input.sessionId, `perf-${input.workspaceHash}`, null, input.traceId, slug(input.title), input.workspacePath, input.workspacePath, input.title, 42000, 17000, 1300, json([{ path: "synthetic/perf.ts", additions: 42000, deletions: 17000 }]), json({ defaultMode: "ask" }), input.baseTime, input.baseTime + input.turnCount * 1000, input.baseTime);
}

function insertTurn(params) {
  const { insertMsg, insertPart, insertUsage, insertTurnUsage, sessionId, traceId, workspacePath, providerId, modelId, baseTime, n } = params;
  const userId = msgId("msg_user", n, sessionId);
  const assistantId = msgId("msg_assistant", n, sessionId);
  const t = baseTime + n * 1000;
  let partCount = 0;
  insertMsg.run(userId, sessionId, t, t, json(userMessage({ n, t, workspacePath, providerId, modelId })));
  const userText = n % 17 === 0 ? repeatLine(`User large markdown prompt turn ${n}: includes requirements, code fences, tables, screenshot references, and constraints.`, 28) : `Synthetic user prompt turn ${n}: ${["create feature", "fix bug", "review diff", "answer question", "approve permission", "decline option", "upload attachment", "remote follow-up"][n % 8]}.`;
  insertPart.run(`${userId}:part_text`, userId, sessionId, t, t, json(textPart(userText, t, { metadata: { fixture: true } })));
  partCount += 1;
  if (n % 20 === 0) {
    insertPart.run(`${userId}:part_file`, userId, sessionId, t + 1, t + 1, json({ type: "file", mime: "text/plain", filename: `fixture-${n}.txt`, url: `data:text/plain;base64,${Buffer.from(repeatLine(`attachment ${n}`, 20)).toString("base64")}`, metadata: { fixture: true } }));
    partCount += 1;
  }
  const completed = t + 700;
  insertMsg.run(assistantId, sessionId, t + 10, completed, json(assistantMessage({ n, parentId: userId, t: t + 10, completed, workspacePath, providerId, modelId })));
  for (const [suffix, createdAt, value] of assistantParts({ n, sessionId, assistantId, workspacePath, t, completed })) {
    insertPart.run(`${assistantId}:${suffix}`, assistantId, sessionId, createdAt, createdAt, json(value));
    partCount += 1;
  }
  insertUsageRows({ insertUsage, insertTurnUsage, sessionId, traceId, providerId, modelId, n, t, completed, userId, assistantId });
  return { partCount };
}

function assistantParts({ n, sessionId, workspacePath, t, completed }) {
  const tools = ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "TodoWrite", "AskUserQuestion", "Agent", "WebSearch", "WebFetch"];
  const stepSnapshot = json({ fixture: true, turn: n });
  const items = [
    ["step_start", t + 11, { type: "step-start", snapshot: stepSnapshot }],
    ["text_intro", t + 20, textPart(repeatLine(`Assistant content turn ${n}: summary, explanation, code review notes, and i18n text.`, 10 + (n % 10)), t + 20, { metadata: { fixture: true } })],
    ["tool_a", t + 40, toolPart({ n, tool: tools[n % tools.length], status: n % 97 === 0 ? "error" : "completed", start: t + 40, workspacePath })],
    ["tool_b", t + 45, toolPart({ n, tool: tools[(n * 7) % tools.length], status: n % 89 === 0 ? "pending" : n % 83 === 0 ? "running" : "completed", start: t + 45, workspacePath })],
    ["step_finish", completed, { type: "step-finish", reason: "stop", cost: 0, tokens: tokenUsage(n), snapshot: stepSnapshot }],
  ];
  if (n % 3 === 0) items.splice(1, 0, ["reasoning", t + 12, reasoningPart(n, t + 12)]);
  if (n % 5 === 0) items.push(["patch", t + 55, patchPart(n, sessionId)]);
  if (n % 37 === 0) items.push(["compaction", t + 58, compactionPart(n, t + 58)]);
  if (n % 41 === 0) items.push(["subtask", t + 60, { type: "subtask", agent: "explore", command: "analyze", description: `Synthetic subagent task ${n}`, prompt: repeatLine(`Subagent prompt ${n}`, 5) }]);
  if (n % 53 === 0) items.push(["agent", t + 61, { type: "agent", name: `synthetic-agent-${n}` }]);
  if (n % 67 === 0) items.push(["retry", t + 62, { type: "retry", attempt: 2, error: { name: "SyntheticRetryableError", data: { message: `retry fixture ${n}` } } }]);
  return items;
}

function insertUsageRows({ insertUsage, insertTurnUsage, sessionId, traceId, providerId, modelId, n, t, completed, userId, assistantId }) {
  const inputTokens = 15000 + (n % 1400);
  const outputTokens = 1200 + (n % 700);
  const reasoningTokens = n % 3 === 0 ? 240 + (n % 200) : 0;
  const total = inputTokens + outputTokens + reasoningTokens;
  insertUsage.run(`usage_${sessionId}_${n}`, `logical_${sessionId}_${n}`, 0, sessionId, `turn_${n}`, traceId, `span_${n}`, assistantId, userId, n % 11 === 0 ? "sidecar" : "main", providerId, modelId, n % 7 === 0 ? "plan" : "build", n % 97 === 0 ? "error" : "completed", t + 10, t + 30, completed, completed - (t + 10), 20, n % 13 === 0 ? "tool-calls" : "stop", 2 + (n % 4), inputTokens, outputTokens, reasoningTokens, n % 11 === 0 ? 256 : 0, n % 5 === 0 ? 4096 : 512, total, total, n % 19 === 0 ? 1 : 0, json({ inputTokens, outputTokens, reasoningTokens }), json({ fixture: true, turn: n }));
  insertTurnUsage.run(sessionId, `turn_${n}`, traceId, userId, n % 97 === 0 ? "error" : "completed", t, t + 10, t + 30, completed, completed - t, 30, 1, n % 19 === 0 ? 1 : 0, 2 + (n % 4), n % 97 === 0 ? 1 : 0, inputTokens, outputTokens, reasoningTokens, n % 11 === 0 ? 256 : 0, n % 5 === 0 ? 4096 : 512, total);
}

function userMessage({ n, t, workspacePath, providerId, modelId }) {
  return { role: "user", time: { created: t }, agent: "zcode-agent", model: { providerID: providerId, modelID: modelId }, contextSnapshot: { envInfo: { cwd: workspacePath, platform: process.platform, shell: process.env.SHELL ?? "zsh", nodeVersion: process.version, isGitRepository: true, gitStatus: n % 2 === 0 ? "clean" : "modified synthetic fixture files" } }, tools: { Read: true, Write: true, Edit: true, Bash: true, Glob: true, Grep: true, WebFetch: true, WebSearch: true, TodoRead: true, TodoWrite: true, AskUserQuestion: true, Agent: true, Skill: true }, metadata: { fixture: true, clientMode: n % 10 === 0 ? "web-remote-replayable" : "desktop-continuous" } };
}

function assistantMessage({ n, parentId, t, completed, workspacePath, providerId, modelId }) {
  return { role: "assistant", time: { created: t, completed }, parentID: parentId, modelID: modelId, providerID: providerId, mode: n % 7 === 0 ? "plan" : "build", agent: "zcode-agent", path: { cwd: workspacePath, root: workspacePath }, cost: 0, tokens: tokenUsage(n), finish: n % 13 === 0 ? "tool-calls" : "stop" };
}

function toolPart({ n, tool, status, start, workspacePath }) {
  const input = toolInput(tool, n, workspacePath);
  if (status === "pending") return { type: "tool", callID: toolCallId(n, tool), tool, state: { status, input, raw: json(input) }, time: { start, end: start + 100 } };
  if (status === "running") return { type: "tool", callID: toolCallId(n, tool), tool, state: { status, input, title: tool, time: { start }, metadata: { fixture: true, progress: n % 100 } }, time: { start, end: start + 100 } };
  if (status === "error") return { type: "tool", callID: toolCallId(n, tool), tool, state: { status, input, error: `SyntheticToolError: Synthetic tool error at turn ${n} (PERF_FIXTURE)`, time: { start, end: start + 100 }, metadata: { fixture: true } }, time: { start, end: start + 100 } };
  const output = tool === "Bash" || tool === "Grep" || tool === "Glob" ? repeatLine(`${tool} output turn ${n}`, 18 + (n % 18)) : tool === "AskUserQuestion" ? json({ question: input.question, selected: "Proceed", freeform: `Synthetic user answer ${n}` }) : tool === "Edit" || tool === "Write" ? diffText(n, 1 + (n % 3), 4 + (n % 5)) : repeatLine(`${tool} structured result turn ${n}`, 10 + (n % 12));
  return { type: "tool", callID: toolCallId(n, tool), tool, state: { status: "completed", input, output, title: tool, time: { start, end: start + 100 }, metadata: { fixture: true, permission: tool === "Bash" ? "approved" : undefined, serialization: { truncated: false, originalBytes: output.length, returnedBytes: output.length } } }, time: { start, end: start + 100 } };
}

function toolInput(tool, n, workspacePath) {
  const values = {
    Read: { file_path: `${workspacePath}/packages/ui/src/App.tsx`, offset: n % 50, limit: 80 },
    Grep: { pattern: `perf-fixture-${n % 37}`, path: workspacePath, output_mode: "content" },
    Glob: { pattern: "**/*.{ts,tsx,md}", path: workspacePath },
    Bash: { command: `printf 'synthetic turn ${n}'; sleep 0`, description: "Synthetic perf command" },
    Edit: { file_path: `${workspacePath}/tmp/perf-${n}.txt`, old_string: "before", new_string: "after" },
    Write: { file_path: `${workspacePath}/tmp/perf-${n}.txt`, content: repeatLine(`written content ${n}`, 10) },
    TodoWrite: { todos: [{ content: `Synthetic todo ${n}`, status: "in_progress", priority: "medium" }] },
    AskUserQuestion: { question: `Synthetic decision question for turn ${n}?`, options: ["Proceed", "Skip", "Change scope"] },
    Agent: { prompt: `Explore synthetic subtask ${n}`, agent_type: n % 2 === 0 ? "explore" : "main" },
    WebSearch: { query: `synthetic zcode performance fixture ${n}` },
    WebFetch: { url: "https://example.com", prompt: `summarize fixture ${n}` },
  };
  return values[tool] ?? { turn: n };
}

function verifyTask(sessionId) {
  assertSafeFixtureId(sessionId);
  const idx = openDb(taskIndexPath);
  const cli = openDb(cliDbPath);
  try {
    const task = idx.prepare("select task_id,title,workspace_path,provider,mode,task_status,pinned,archived,deleted,length(searchable_text) searchable_len,length(meta_json) meta_len from tasks where task_id = ?").get(sessionId);
    const counts = {
      session: cli.prepare("select count(*) count from session where id = ?").get(sessionId).count,
      messages: cli.prepare("select count(*) count from message where session_id = ?").get(sessionId).count,
      parts: cli.prepare("select count(*) count from part where session_id = ?").get(sessionId).count,
      todos: cli.prepare("select count(*) count from todo where session_id = ?").get(sessionId).count,
      modelUsage: cli.prepare("select count(*) count from model_usage where session_id = ?").get(sessionId).count,
      turnUsage: cli.prepare("select count(*) count from turn_usage where session_id = ?").get(sessionId).count,
    };
    const types = cli.prepare("select json_extract(data,'$.type') type, count(*) count from part where session_id = ? group by type order by count desc").all(sessionId);
    const shapeCheck = validateFixtureProtocolShapes(cli, sessionId);
    console.log(JSON.stringify({ task, counts, types, shapeCheck }, null, 2));
    if (shapeCheck.errors.length > 0) {
      throw new Error(`Fixture protocol shape check failed: ${shapeCheck.errors.slice(0, 5).join("; ")}`);
    }
  } finally {
    idx.close();
    cli.close();
  }
}

function validateFixtureProtocolShapes(db, sessionId) {
  const errors = [];
  const messageRows = db.prepare("select id,data from message where session_id = ? order by time_created asc").all(sessionId);
  const partRows = db.prepare("select id,data from part where session_id = ? order by time_created asc").all(sessionId);
  const syntheticSources = new Set(["background_task", "fork", "goal-continuation", "rewind", "subagent", "todo_reminder"]);
  const internalPartTypes = new Set(["agent", "compaction", "file", "patch", "reasoning", "retry", "snapshot", "step-finish", "step-start", "subtask", "text", "tool"]);
  for (const row of messageRows) {
    const data = parseJson(row.data, `message ${row.id}`, errors);
    if (!data) continue;
    if (data.role === "user" && data.source !== undefined && !syntheticSources.has(data.source)) {
      errors.push(`${row.id}: invalid user source ${data.source}`);
    }
    if (data.role === "assistant" && !data.tokens?.cache) {
      errors.push(`${row.id}: assistant tokens.cache is missing`);
    }
  }
  for (const row of partRows) {
    const data = parseJson(row.data, `part ${row.id}`, errors);
    if (!data) continue;
    // 这里覆盖 UI 打开时的协议校验失败点，避免 SQLite 写入成功但会话恢复失败。
    if (!internalPartTypes.has(data.type)) {
      errors.push(`${row.id}: unsupported internal part type ${String(data.type)}`);
    }
    if ((data.type === "step-start" || data.type === "step-finish") && data.snapshot !== undefined && typeof data.snapshot !== "string") {
      errors.push(`${row.id}: ${data.type}.snapshot must be a string`);
    }
    if (data.type === "step-finish" && !data.tokens?.cache) {
      errors.push(`${row.id}: step-finish tokens.cache is missing`);
    }
    if (data.type === "tool" && data.state?.status === "error" && typeof data.state.error !== "string") {
      errors.push(`${row.id}: tool error state.error must be a string`);
    }
    if (data.type === "patch" && !data.files?.every((file) => typeof file === "string")) {
      errors.push(`${row.id}: patch files must be string paths`);
    }
    if (data.type === "subagent") {
      errors.push(`${row.id}: raw session DB must use internal subtask; mapper emits protocol subagent`);
    }
  }
  return { checkedMessages: messageRows.length, checkedParts: partRows.length, errors };
}

function parseJson(value, label, errors) {
  try {
    return JSON.parse(value);
  } catch (error) {
    errors.push(`${label}: invalid JSON ${error.message}`);
    return null;
  }
}

function deleteTask(sessionId) {
  assertSafeFixtureId(sessionId);
  const backupDir = backupDatabases();
  const idx = openDb(taskIndexPath);
  const cli = openDb(cliDbPath);
  try {
    execTx(idx, () => idx.prepare("delete from tasks where task_id = ?").run(sessionId));
    execTx(cli, () => cli.prepare("delete from session where id = ?").run(sessionId));
  } finally {
    idx.close();
    cli.close();
  }
  console.log(JSON.stringify({ deleted: sessionId, backupDir }, null, 2));
}

function assertDatabases() {
  for (const path of [cliDbPath, taskIndexPath]) {
    if (!existsSync(path)) throw new Error(`Missing SQLite database: ${path}`);
  }
}

function backupDatabases() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const backupDir = join(zcodeRoot, "perf-task-backups", stamp);
  mkdirSync(backupDir, { recursive: true });
  sqliteBackup(taskIndexPath, join(backupDir, "tasks-index.sqlite"));
  sqliteBackup(cliDbPath, join(backupDir, "cli-db.sqlite"));
  return backupDir;
}

function sqliteBackup(source, target) {
  const result = spawnSync("sqlite3", [source, `.backup '${target.replaceAll("'", "''")}'`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sqlite3 backup failed for ${source}: ${result.stderr || result.stdout}`);
}

function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

function execTx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function assertSafeFixtureId(sessionId) {
  if (!/^sess_perf_large_[0-9]{14}_[a-f0-9]{8}$/.test(sessionId)) {
    throw new Error(`Refusing non-fixture session id: ${sessionId}`);
  }
}

function json(value) {
  return JSON.stringify(value);
}

function hash12(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function msgId(prefix, n, sessionId) {
  return `${prefix}_${String(n).padStart(5, "0")}_${sessionId}`;
}

function toolCallId(n, tool) {
  return `call_perf_${String(n).padStart(5, "0")}_${tool}_${randomUUID().slice(0, 8)}`;
}

function textPart(text, start, extra = {}) {
  return { type: "text", text, time: { start, end: start }, ...extra };
}

function reasoningPart(n, start) {
  return { type: "reasoning", text: repeatLine(`Reasoning turn ${n}: analyzing state, tool outputs, permission boundaries, UI rendering, mobile replayable recovery, and diff summaries.`, 8 + (n % 8)), metadata: { anthropic: { signature: randomUUID() }, fixture: true }, time: { start, end: start + 50 } };
}

function patchPart(n, sessionId) {
  return { type: "patch", hash: createHash("sha256").update(`patch-${sessionId}-${n}`).digest("hex"), files: [`src/perf-${n}.ts`, `docs/perf-${n}.md`] };
}

function tokenUsage(n) {
  const input = 15000 + (n % 1400);
  const output = 1200 + (n % 700);
  const reasoning = n % 3 === 0 ? 240 + (n % 200) : 0;
  return { total: input + output + reasoning, input, output, reasoning, cache: { read: n % 5 === 0 ? 4096 : 512, write: n % 11 === 0 ? 256 : 0 } };
}

function compactionPart(n, start) {
  return { type: "compaction", reason: "manual", auto: n % 2 === 0, phase: "completed", attempt: 1, maxAttempts: 1, preCompactTokenCount: 180000 + n, postCompactTokenCount: 42000 + n, truePostCompactTokenCount: 43000 + n, operationId: `compact_${n}`, boundaryId: `boundary_${n}`, timelineStatus: "completed", time: { start, end: start + 80 } };
}

function repeatLine(seed, count) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(`${seed} line ${String(i).padStart(4, "0")}: ${"x".repeat(72)} ${i % 7 === 0 ? "包含中文内容与 i18n 文本，用于验证渲染和搜索。" : "mixed english content for scroll/search/layout."}`);
  }
  return lines.join("\n");
}

function diffText(turn, files = 3, hunks = 8) {
  const out = [];
  for (let f = 0; f < files; f += 1) {
    out.push(`diff --git a/src/perf-${turn}-${f}.ts b/src/perf-${turn}-${f}.ts`);
    out.push(`index ${String(turn).padStart(6, "0")}..${String(turn + f + 1).padStart(6, "0")} 100644`);
    out.push(`--- a/src/perf-${turn}-${f}.ts`);
    out.push(`+++ b/src/perf-${turn}-${f}.ts`);
    for (let h = 0; h < hunks; h += 1) {
      out.push(`@@ -${h * 9 + 1},7 +${h * 9 + 1},9 @@\n-const oldValue${h} = ${turn + h};\n+const newValue${h} = ${turn + h + 1};\n+// synthetic perf fixture change ${turn}/${f}/${h}\n export function perfCase${h}() {\n   return newValue${h};\n }`);
    }
  }
  return out.join("\n");
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
