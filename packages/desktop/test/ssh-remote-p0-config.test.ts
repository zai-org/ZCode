import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REMOTE_RELEASE_DIR_ENV } from "./e2e/helpers/e2e-remote-release-requirement.js";
import { readSingleSSHWorkspaceRuntimeConfig } from "./e2e/helpers/ssh-remote-p0.js";

const ENV_KEYS = [
  "ZCODE_E2E_SSH_HOST",
  "ZCODE_E2E_SSH_PORT",
  "ZCODE_E2E_SSH_USERNAME",
  "ZCODE_E2E_SSH_PASSWORD",
  "ZCODE_E2E_SSH_WORKSPACE_PATH",
  "ZCODE_E2E_SSH_SHARED_WORKSPACE_PATH",
  REMOTE_RELEASE_DIR_ENV,
  "ZCODE_E2E_PACKAGED_APP_PATH",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("SSH remote E2E config helpers", () => {
  it("reads a single target without requiring a second SSH identity", () => {
    process.env.ZCODE_E2E_SSH_HOST = "e2e.example.test";
    process.env.ZCODE_E2E_SSH_USERNAME = "e2e-user";
    process.env.ZCODE_E2E_SSH_PASSWORD = "e2e-password";
    process.env.ZCODE_E2E_SSH_PORT = "2222";
    process.env.ZCODE_E2E_SSH_WORKSPACE_PATH = "/root/workspace";
    delete process.env.ZCODE_E2E_PACKAGED_APP_PATH;
    const releaseDir = mkdtempSync(join(tmpdir(), "zcode-ssh-release-"));
    writeFileSync(join(releaseDir, "source-server-release.json"), "{}");

    // onPrepare 没有 stage remote release 时，SSH 配置入口直接失败。
    delete process.env[REMOTE_RELEASE_DIR_ENV];
    expect(() => readSingleSSHWorkspaceRuntimeConfig("E2E_SSH_SINGLE")).toThrow(
      /onPrepare 没有准备/u,
    );

    process.env[REMOTE_RELEASE_DIR_ENV] = releaseDir;
    try {
      expect(readSingleSSHWorkspaceRuntimeConfig("E2E_SSH_SINGLE")).toEqual({
        host: "e2e.example.test",
        password: "e2e-password",
        port: 2222,
        username: "e2e-user",
        workspacePath: "/root/workspace",
      });
    } finally {
      rmSync(releaseDir, { force: true, recursive: true });
    }
  });
});
