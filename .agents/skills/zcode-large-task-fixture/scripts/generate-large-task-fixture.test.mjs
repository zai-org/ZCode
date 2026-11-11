import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal()),
  homedir: () => fixture.home,
}));

const originalArgv = process.argv;
afterEach(async () => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  if (fixture.home) await rm(fixture.home, { recursive: true, force: true });
});

it("生成的本地 fixture 使用路径归属，不把目录哈希写成显式身份", async () => {
  fixture.home = await mkdtemp(join(tmpdir(), "large-task-fixture-"));
  const workspace = join(fixture.home, "workspace");
  await mkdir(workspace);
  const cliPath = join(fixture.home, ".zcode/cli/db/db.sqlite");
  const indexPath = join(fixture.home, ".zcode/v2/tasks-index.sqlite");
  for (const [path, schema] of [
    [cliPath, "apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql"],
    [indexPath, "packages/services/src/project-storage/schema.baseline.sql"],
  ]) {
    await mkdir(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
      db.exec(await readFile(new URL(`../../../../${schema}`, import.meta.url), "utf8"));
    } finally {
      db.close();
    }
  }

  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = [
    process.execPath,
    "generate-large-task-fixture.mjs",
    "--workspace",
    workspace,
    "--turns",
    "1",
    "--no-backup",
  ];
  await import("./generate-large-task-fixture.mjs");
  const manifest = JSON.parse(output.mock.calls.at(-1)[0]);
  const cli = new DatabaseSync(cliPath, { readOnly: true });
  const index = new DatabaseSync(indexPath, { readOnly: true });
  try {
    expect(
      cli
        .prepare("select workspace_id, directory, path from session where id = ?")
        .get(manifest.sessionId),
    ).toEqual({
      workspace_id: null,
      directory: workspace,
      path: workspace,
    });
    expect(
      index
        .prepare(
          "select workspace_identity, workspace_key, workspace_path from tasks where task_id = ?",
        )
        .get(manifest.sessionId),
    ).toEqual({
      workspace_identity: null,
      workspace_key: workspace,
      workspace_path: workspace,
    });
    expect(
      cli.prepare("select count(*) count from message where session_id = ?").get(manifest.sessionId)
        .count,
    ).toBe(2);
    expect(
      cli.prepare("select count(*) count from part where session_id = ?").get(manifest.sessionId)
        .count,
    ).toBe(manifest.partCount);
  } finally {
    cli.close();
    index.close();
  }
});
