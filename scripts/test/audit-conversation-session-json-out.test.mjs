import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const AUDIT_SCRIPT = resolve(process.cwd(), "scripts/audit-conversation-session-case-coverage.mjs");

// 准入审计失败时 CI 在 WDIO 前退出，没有 E2E 报告；MR 增量 job 的 after_script 依赖
// --json-out 写出的审计 JSON 判断是否标记 Draft（docs/testing/conversation-session-automatic-e2e-ci.md）。
// 文本输出必须保持不变，job 日志仍要直接看到审计结果。
test("--json-out writes the audit summary with its errors list and keeps the text output", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "zcode-audit-json-out-"));
  const outPath = join(outDir, "nested", "audit.json");

  const { stdout } = await execFileAsync(
    process.execPath,
    [AUDIT_SCRIPT, "--check", "--json-out", outPath],
    { cwd: process.cwd(), maxBuffer: 32 * 1024 * 1024 },
  );

  expect(stdout).toContain("Conversation session case coverage audit");
  const summary = JSON.parse(await readFile(outPath, "utf-8"));
  expect(Array.isArray(summary.errors)).toBe(true);
  expect(summary.errors).toEqual([]);
  expect(summary.main).toBeTruthy();
}, 120_000);
