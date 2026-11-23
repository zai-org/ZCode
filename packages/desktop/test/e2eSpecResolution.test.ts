import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertNonEmptyE2EScheduledSpecFiles,
  resolveE2EMaxInstances,
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

// 回归（评审 CR-01，2026-11-18）：worker 共用 .e2e-home（beforeSession 递归删除）与 launcher 的账号
// mock 状态（case-mode、Team 闲时灰度等），并行时后写入的 worker 会改掉先启动 worker 读到的配置。
// 串行是这些共享资源的前提，所以在调度前拒绝其他取值，而不是运行中出现交错。
describe("resolveE2EMaxInstances", () => {
  it("defaults to one serial worker", () => {
    expect(resolveE2EMaxInstances({})).toBe(1);
    expect(resolveE2EMaxInstances({ ZCODE_E2E_MAX_INSTANCES: "1" })).toBe(1);
    expect(resolveE2EMaxInstances({ ZCODE_E2E_MAX_INSTANCES: " " })).toBe(1);
  });

  it("rejects parallel or invalid worker counts before scheduling", () => {
    for (const value of ["2", "4", "0", "abc"]) {
      expect(() => resolveE2EMaxInstances({ ZCODE_E2E_MAX_INSTANCES: value })).toThrow(
        /ZCODE_E2E_MAX_INSTANCES/u,
      );
    }
  });
});
