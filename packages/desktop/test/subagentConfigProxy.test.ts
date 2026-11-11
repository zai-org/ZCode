import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([false, true])(
  "preloads the stdio proxy without replacing CLI startup (failure: %s)",
  async (failed) => {
    const root = await mkdtemp(join(tmpdir(), "subagent-proxy-"));
    roots.push(root);
    await writeFile(
      join(root, "subagent-config-control.json"),
      JSON.stringify({ failedSessionIds: failed ? ["parent"] : [] }),
    );
    const entry = join(root, "cli.mjs");
    await writeFile(
      entry,
      `
    import { createInterface } from "node:readline";
    console.log(JSON.stringify({ method: "storage/startup", params: { ready: true } }));
    console.log(JSON.stringify({ id: 1, method: "subagents/readRuntimeConfig", params: { sessionId: "parent" } }));
    createInterface({ input: process.stdin }).once("line", line => {
      console.log(JSON.stringify({ method: "done", response: JSON.parse(line), args: process.argv.slice(2) }));
      process.exit(0);
    });
  `,
    );
    // 与 WDIO 注入方式一致：Windows 的 ESM loader 不接受裸绝对路径，预加载必须是 file:// URL。
    const proxy = new URL("./e2e/helpers/subagent-config-proxy.mjs", import.meta.url).href;
    const child = spawn(process.execPath, [entry, "app-server", "--stdio"], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${JSON.stringify(proxy)}`,
        ZCODE_E2E_ARTIFACT_DIR: root,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const frames: Array<Record<string, any>> = [];
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const frame = JSON.parse(line);
      frames.push(frame);
      if (frame.method === "subagents/readRuntimeConfig")
        child.stdin.write(
          JSON.stringify({ id: frame.id, result: { kind: "built-in-fallback" } }) + "\n",
        );
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(code, stderr).toBe(0);
    expect(frames.filter((frame) => frame.method === "storage/startup")).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({
      method: "done",
      args: ["app-server", "--stdio"],
      response: failed
        ? { error: { message: "E2E_CONFIG_UNAVAILABLE" } }
        : { result: { kind: "built-in-fallback" } },
    });
    const logs = (await readdir(root)).filter((path) => path.startsWith("subagent-config-rpc-"));
    expect(logs).toHaveLength(1);
    const records = (await readFile(join(root, logs[0]!), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ kind: "read", sessionId: "parent", failed });
  },
);
