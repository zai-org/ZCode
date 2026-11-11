#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";
import { hasRequiredSshE2EEnvironment } from "./e2e-formal-spec-selection.mjs";

const DESKTOP_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = resolve(DESKTOP_DIR, "../..");
const UPSTREAM_PROVIDER_SPEC = "./test/e2e/infrastructure/smoke/upstream-provider.test.ts";
const ALL_E2E_SPECS = ["./test/e2e/**/*.test.ts"];
const SSH_E2E_EXCLUDES = [
  "./test/e2e/conversation-session/**/conversation-session-ssh-remote*.test.ts",
  "./test/e2e/conversation-session/**/manual-review/**/conversation-session-ssh-remote*.test.ts",
];
// 仓库不提供供应商地址与 key：两者只来自 shell 或本机 .env.e2e.local，示例文件值留空不参与判断。
const PROVIDER_ENV_FILES = [
  resolve(DESKTOP_DIR, ".env.e2e.local"),
  resolve(REPO_ROOT, ".env.e2e.local"),
];

// 真实 provider smoke 走 capture，需要环境变量同时给出上游地址与真实 key（回放占位 key 不算）。
export function hasRealUpstreamProviderConfig(env = process.env, envFiles = PROVIDER_ENV_FILES) {
  const read = (key) =>
    env[key]?.trim() || envFiles.map((envFile) => readEnvValue(envFile, key)).find(Boolean) || "";
  const apiKey = read("E2E_PROVIDER_API_KEY");
  return Boolean(read("E2E_PROVIDER_BASE_URL") && apiKey && apiKey !== "e2e-fixture-key");
}

function readEnvValue(envFile, key) {
  if (!existsSync(envFile)) return "";
  return parseDotenv(readFileSync(envFile))[key]?.trim() || "";
}

export function createAllE2ECoverageRunPlan({
  args = [],
  env = process.env,
  upstreamReady = hasRealUpstreamProviderConfig(env),
  platform = process.platform,
  sshReady = hasRequiredSshE2EEnvironment(env),
} = {}) {
  return {
    command: platform === "win32" ? "pnpm.cmd" : "pnpm",
    args: [
      "test:e2e",
      "--",
      ...ALL_E2E_SPECS.flatMap((spec) => ["--spec", spec]),
      ...(sshReady ? [] : SSH_E2E_EXCLUDES.flatMap((spec) => ["--exclude", spec])),
      ...(upstreamReady ? [] : ["--exclude", UPSTREAM_PROVIDER_SPEC]),
      ...args,
    ],
    env: {
      ...env,
      ZCODE_E2E_COVERAGE: "1",
      ZCODE_E2E_MANUAL_REVIEW: "1",
    },
    notes: upstreamReady
      ? []
      : [
          "skipping real provider smoke: configure E2E_PROVIDER_BASE_URL and E2E_PROVIDER_API_KEY to include it",
        ],
  };
}

export async function runAllE2ECoverage(options = {}) {
  const plan = createAllE2ECoverageRunPlan(options);
  for (const note of plan.notes) {
    console.warn(`[e2e-all-coverage] ${note}`);
  }
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: options.cwd ?? DESKTOP_DIR,
      env: plan.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`all E2E coverage run exited with code ${exitCode}`);
  }
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  try {
    await runAllE2ECoverage({ args: process.argv.slice(2) });
  } catch (error) {
    console.error(`[e2e-all-coverage] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
