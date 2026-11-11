import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("stdio tap credential boundary", () => {
  it("forwards exact bytes while hiding credential request and reply payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stdio-tap-credential-"));
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: "crypto-1",
      method: "interaction/requestCredentialCipher",
      params: { requestId: "opaque-request-id", operation: "encrypt", value: "SYNTHETIC_SECRET_A" },
    });
    const response = JSON.stringify({
      jsonrpc: "2.0",
      id: "crypto-1",
      result: { requestId: "opaque-request-id", result: { ok: true, value: "SYNTHETIC_SECRET_B" } },
    });
    const normal = JSON.stringify({ jsonrpc: "2.0", method: "runtime/status", params: {} });
    try {
      const childCode = `process.stdout.write(${JSON.stringify(`${request}\n${normal}\n`)}); let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { if (input !== ${JSON.stringify(`${response}\n`)}) process.exitCode = 42; else process.stdout.write('input-matched\\n'); });`;
      const child = spawn(
        process.execPath,
        [
          resolve("scripts/dev/zcode-stdio-tap.mjs"),
          "--workspace-key",
          "test",
          "--log-dir",
          dir,
          "--",
          process.execPath,
          "-e",
          childCode,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let replied = false;
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (!replied && stdout.includes(normal)) {
          replied = true;
          child.stdin.end(`${response}\n`);
        }
      });
      const code = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("close", done);
      });
      expect(code).toBe(0);
      expect(stdout).toBe(`${request}\n${normal}\ninput-matched\n`);
      const workspace = join(dir, (await readdir(dir))[0]!);
      const latest = (await readFile(join(workspace, "latest.txt"), "utf8")).trim();
      const rawLog = await readFile(latest, "utf8");
      expect(rawLog).not.toContain("SYNTHETIC_SECRET_A");
      expect(rawLog).not.toContain("SYNTHETIC_SECRET_B");
      expect(rawLog).not.toContain("opaque-request-id");
      const records = rawLog
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.find((record) => record.method === "runtime/status").raw).toBe(normal);
      expect(
        records.some((record) => record.method === "interaction/requestCredentialCipher"),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
