import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAllE2ECoverageRunPlan,
  hasRealUpstreamProviderConfig,
} from "../scripts/run-all-e2e-coverage.mjs";

describe("all E2E coverage runner", () => {
  it("runs formal, manual-review and the real provider smoke in one covered invocation", () => {
    const plan = createAllE2ECoverageRunPlan({
      args: ["--mochaOpts.timeout=120000"],
      env: { KEEP_ME: "1" },
      upstreamReady: true,
      sshReady: false,
    });

    expect(plan.command).toBe(process.platform === "win32" ? "pnpm.cmd" : "pnpm");
    expect(plan.env).toMatchObject({
      KEEP_ME: "1",
      ZCODE_E2E_COVERAGE: "1",
      ZCODE_E2E_MANUAL_REVIEW: "1",
    });
    expect(plan.args).toEqual([
      "test:e2e",
      "--",
      "--spec",
      "./test/e2e/**/*.test.ts",
      "--exclude",
      "./test/e2e/conversation-session/**/conversation-session-ssh-remote*.test.ts",
      "--exclude",
      "./test/e2e/conversation-session/**/manual-review/**/conversation-session-ssh-remote*.test.ts",
      "--mochaOpts.timeout=120000",
    ]);
    expect(plan.notes).toEqual([]);
  });

  it("excludes the real provider smoke when no non-placeholder key is available", () => {
    const plan = createAllE2ECoverageRunPlan({
      args: [],
      env: {},
      upstreamReady: false,
      sshReady: false,
    });

    expect(plan.args).toContain("./test/e2e/infrastructure/smoke/upstream-provider.test.ts");
    expect(plan.args).toContain("--exclude");
    expect(plan.notes).toEqual([
      "skipping real provider smoke: configure E2E_PROVIDER_BASE_URL and E2E_PROVIDER_API_KEY to include it",
    ]);
  });

  it("keeps SSH cases when their environment is available", () => {
    const plan = createAllE2ECoverageRunPlan({
      args: [],
      env: {},
      upstreamReady: true,
      sshReady: true,
    });

    expect(plan.args).not.toContain("--exclude");
  });

  it("exposes the same reusable command at the root and desktop package", () => {
    const desktopPackage = JSON.parse(
      readFileSync(resolve(process.cwd(), "packages/desktop/package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };
    const rootPackage = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };

    expect(desktopPackage.scripts["test:e2e:all:coverage"]).toBe(
      "node scripts/run-all-e2e-coverage.mjs",
    );
    expect(rootPackage.scripts["test:e2e:all:coverage"]).toBe(
      "pnpm --filter @zcode/desktop test:e2e:all:coverage",
    );
  });

  // 仓库不再提供共享 key：示例文件只列变量名，真实 key 只能来自 shell 或本机 .env.e2e.local。
  // 真实供应商由环境变量给出地址与 key，两者齐全才纳入真实 smoke；本机 env 文件不参与本用例。
  it("requires both E2E_PROVIDER_BASE_URL and a real E2E_PROVIDER_API_KEY", () => {
    const baseUrl = "https://provider.example.invalid/anthropic";
    const check = (env: Record<string, string>) => hasRealUpstreamProviderConfig(env, []);
    expect(check({ E2E_PROVIDER_API_KEY: "real-key", E2E_PROVIDER_BASE_URL: baseUrl })).toBe(true);
    expect(check({ E2E_PROVIDER_API_KEY: "real-key" })).toBe(false);
    expect(check({ E2E_PROVIDER_BASE_URL: baseUrl })).toBe(false);
    expect(check({ E2E_PROVIDER_API_KEY: "e2e-fixture-key", E2E_PROVIDER_BASE_URL: baseUrl })).toBe(
      false,
    );
  });

  it("ships an example env file without a default key", () => {
    const example = readFileSync(
      resolve(import.meta.dirname, "../../../.env.e2e.local.example"),
      "utf8",
    );
    for (const name of ["BASE_URL", "API_KEY", "MODEL", "SECONDARY_MODEL"]) {
      expect(example).toMatch(new RegExp(`^E2E_PROVIDER_${name}=$`, "m"));
    }
  });
});
