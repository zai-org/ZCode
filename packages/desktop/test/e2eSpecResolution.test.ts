import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertNonEmptyE2EScheduledSpecFiles,
  resolveE2EScheduledSpecFiles,
} from "./e2e/helpers/e2e-spec-resolution.js";

function writeSpec(baseDir: string, relativePath: string): void {
  const path = join(baseDir, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "describe('x', () => {});\n");
}

function withFixture<T>(run: (baseDir: string) => T): T {
  const baseDir = mkdtempSync(join(tmpdir(), "zcode-e2e-spec-resolution-"));
  try {
    return run(baseDir);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

describe("E2E spec scheduling resolution", () => {
  it("resolves the formal non-recursive conversation-session CI glob", () => {
    withFixture((baseDir) => {
      writeSpec(baseDir, "test/e2e/conversation-session/formal-a.test.ts");
      writeSpec(baseDir, "test/e2e/conversation-session/formal-b.test.ts");
      writeSpec(baseDir, "test/e2e/conversation-session/manual-review/pending/manual.test.ts");

      expect(
        resolveE2EScheduledSpecFiles({
          baseDir,
          specs: ["./test/e2e/conversation-session/*.test.ts"],
          exclude: [],
        }),
      ).toEqual([
        "test/e2e/conversation-session/formal-a.test.ts",
        "test/e2e/conversation-session/formal-b.test.ts",
      ]);
    });
  });

  it("resolves a formal desktop CI spec list with a domain-specific single spec", () => {
    withFixture((baseDir) => {
      writeSpec(baseDir, "test/e2e/conversation-session/formal.test.ts");
      writeSpec(baseDir, "test/e2e/workspace/files/workspace-file-tree-refresh.test.ts");

      expect(
        resolveE2EScheduledSpecFiles({
          baseDir,
          specs: [
            "./test/e2e/conversation-session/*.test.ts",
            "./test/e2e/workspace/files/workspace-file-tree-refresh.test.ts",
          ],
          exclude: [],
        }),
      ).toEqual([
        "test/e2e/conversation-session/formal.test.ts",
        "test/e2e/workspace/files/workspace-file-tree-refresh.test.ts",
      ]);
    });
  });

  it("applies recursive exclude globs before reporting scheduled specs", () => {
    withFixture((baseDir) => {
      writeSpec(baseDir, "test/e2e/conversation-session/formal.test.ts");
      writeSpec(baseDir, "test/e2e/conversation-session/manual-review/pending/manual.test.ts");

      expect(
        resolveE2EScheduledSpecFiles({
          baseDir,
          specs: ["./test/e2e/**/*.test.ts"],
          exclude: ["./test/e2e/conversation-session/manual-review/**/*.test.ts"],
        }),
      ).toEqual(["test/e2e/conversation-session/formal.test.ts"]);
    });
  });

  it("throws a pre-worker diagnostic when no spec files are scheduled", () => {
    withFixture((baseDir) => {
      expect(() =>
        assertNonEmptyE2EScheduledSpecFiles({
          baseDir,
          specs: ["./test/e2e/conversation-session/*.test.ts"],
          exclude: [],
          requestedSpecs: ["./test/e2e/conversation-session/*.test.ts"],
          envSpec: "./test/e2e/conversation-session/*.test.ts",
          argv: [
            "run",
            "wdio.conf.ts",
            "--",
            "--spec",
            "./test/e2e/conversation-session/*.test.ts",
          ],
        }),
      ).toThrow(/Desktop E2E has no scheduled spec files after applying excludes/);
    });
  });
});
