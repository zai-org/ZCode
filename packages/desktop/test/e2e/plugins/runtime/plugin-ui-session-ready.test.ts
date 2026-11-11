import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

describe("PLM-UI-SESSION-READY plugin cold recovery", () => {
  it("waits for session readiness and opens once without reload", async () => {
    const repo = resolve(process.cwd(), "../..");
    const artifacts =
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(repo, "packages/desktop/.e2e-artifacts");
    await mkdir(artifacts, { recursive: true });
    const output = await mkdtemp(join(artifacts, "plugin-ui-session-ready-"));
    let stdout = "";
    let stderr = "";
    try {
      // 同一套真实 Electron / Agent / MCP 断言；正式集合不另写一份近似实现。
      // WDIO onPrepare 已构建并校验当前 Agent；重复构建会耗尽外层用例预算，遮住实际断言。
      ({ stdout, stderr } = await exec(
        process.execPath,
        [
          join(repo, "packages/desktop/scripts/mcp-apps-host-e2e.mjs"),
          "--session-ready-only",
          "--reuse-agent-build",
          "--output-dir",
          output,
        ],
        { cwd: repo, timeout: 100_000, maxBuffer: 8 * 1024 * 1024 },
      ));
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      stdout = failure.stdout ?? "";
      stderr = failure.stderr ?? "";
      throw error;
    } finally {
      await writeFile(join(output, "runner.log"), stdout + stderr);
    }
    // 构建成功或零收集都不能算回归通过，必须读取本例完成后的结果。
    const result = JSON.parse(await readFile(join(output, "session-ready-results.json"), "utf8"));
    assert.equal(result.caseId, "PLM-UI-SESSION-READY");
    assert.equal(result.checks.length, 1);
    assert.equal(
      result.checks[0].name,
      "cold session restore and App opening share readiness without reload",
    );
  });
});
