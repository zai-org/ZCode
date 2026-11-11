import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { insertVerifiedDockerSpecRow } from "../scripts/conversation-docker-plan.mjs";

const repoRoot = process.cwd();
const containerScriptPath = resolve(repoRoot, "scripts/test-desktop-e2e-container.sh");

describe("desktop E2E container presets", () => {
  it("keeps the default smoke preset free of stale conversation specs", () => {
    const script = readFileSync(containerScriptPath, "utf-8");
    const defaultAssignment = script.match(/^DEFAULT_E2E_SPEC="([^"]*)"$/m);

    expect(defaultAssignment).not.toBeNull();
    expect(defaultAssignment?.[1]).not.toContain("./test/e2e/conversation-session/");
  });

  it("lists only existing formal conversation specs in the verified preset, and refuses an empty one", () => {
    const script = readFileSync(containerScriptPath, "utf-8");
    const assignment = script.match(/^CONVERSATION_SESSION_VERIFIED_E2E_SPEC="([^"]*)"$/m);
    const specs = assignment?.[1]?.split(",") ?? [];

    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec).toMatch(/^\.\/test\/e2e\/conversation-session\/(?:[^/]+\/)+[^/]+\.test\.ts$/);
      expect(spec).not.toContain("/manual-review/");
      expect(existsSync(resolve(repoRoot, "packages/desktop", spec))).toBe(true);
    }
    expect(script).toContain(
      "No V4 conversation-session spec has Docker replay-isolated admission evidence",
    );
    expect(script).not.toContain("conversation-session-admission)");
    expect(script).not.toContain("conversation-session-needs-docker-fix)");
    expect(script).not.toContain("conversation-session-tool-cross-product)");
  });

  it("retires package commands for stale conversation diagnostic presets", () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["test:e2e:container:conversation"]).toContain(
      "conversation-session-verified",
    );
    expect(packageJson.scripts["test:e2e:container:conversation:admission"]).toBeUndefined();
    expect(packageJson.scripts["test:e2e:container:conversation:needs-docker-fix"]).toBeUndefined();
    expect(
      packageJson.scripts["test:e2e:container:conversation:tool-cross-product"],
    ).toBeUndefined();
    expect(packageJson.scripts["test:e2e:container:conversation:all"]).toBeUndefined();
  });

  it("keeps plugin Docker admission review-gated while exposing the verified preset command", () => {
    const script = readFileSync(containerScriptPath, "utf-8");
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };

    expect(script).toContain("plugins-verified)");
    expect(script).toContain("No plugin-management spec has completed human review");
    expect(packageJson.scripts["test:e2e:container:plugins"]).toContain("plugins-verified");
  });

  it("references only existing conversation spec paths", () => {
    const script = readFileSync(containerScriptPath, "utf-8");
    const conversationPaths = [
      ...script.matchAll(/\.\/test\/e2e\/conversation-session\/[^,"'\\s]+\.test\.ts/g),
    ].map(([path]) => path);
    const missingPaths = conversationPaths.filter(
      (path) => !existsSync(resolve(repoRoot, "packages/desktop", path)),
    );

    expect(missingPaths).toEqual([]);
  });

  it.each(["\n", "\r\n"])(
    "keeps the formatted Docker plan table writable with %j line endings",
    async (newline) => {
      const dockerPlan = (
        await readFile(
          resolve(repoRoot, "docs/testing/conversation-session-docker-automation-plan.md"),
          "utf-8",
        )
      )
        .replaceAll("\r\n", "\n")
        .replaceAll("\n", newline);
      const marker = "<!-- conversation-session-verified-table-end -->";
      const tablePrefix = dockerPlan.slice(0, dockerPlan.indexOf(marker)).trimEnd();

      // 格式化会调整横线宽度和标记前空行；检查表结构，并验证新增行没有被空行隔到表外。
      expect(tablePrefix).toMatch(
        /\|\s*Spec\s*\|\s*迁移状态\s*\|\r?\n\|[ \t]*:?-{3,}:?[ \t]*\|[ \t]*:?-{3,}:?[ \t]*\|(?:\r?\n\|[^\r\n]*\|)*$/u,
      );

      const spec = "./test/e2e/conversation-session/example.test.ts";
      const row = `| \`${spec}\` | verified |`;
      const updated = insertVerifiedDockerSpecRow(dockerPlan, spec);
      expect(updated.inserted).toBe(true);
      expect(updated.text).toContain(`${tablePrefix}${newline}${row}${newline}${marker}`);
      expect(insertVerifiedDockerSpecRow(updated.text, spec)).toEqual({
        inserted: false,
        text: updated.text,
      });

      const nextSpec = "./test/e2e/conversation-session/another.test.ts";
      const next = insertVerifiedDockerSpecRow(updated.text, nextSpec);
      expect(next.inserted).toBe(true);
      expect(next.text).toContain(
        `${row}${newline}| \`${nextSpec}\` | verified |${newline}${marker}`,
      );
    },
  );
});

// 用假的 docker 记录参数，验证容器脚本透传给容器的上游供应商配置；取最后一次 docker run（前面一次是驱动预取）。
function runContainerScriptWithFakeDocker(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "zcode-e2e-container-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const logPath = join(dir, "docker.log");
    // 只记录 run：容器脚本的后台采样会并发调用 docker inspect/stats，长的 run 参数行分多次写入时
    // 会与之交错（曾出现 "-e E2inspect ..."）；两次 docker run 本身串行，只记 run 就没有并发写。
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env bash\nif [ "$1" = run ]; then printf '%s\\n' "$*" >> "${logPath}"; if [[ "$*" == *"chromedriver-preflight.mjs path"* ]]; then printf '%s\\n' '/cache/chromedriver-fixture'; fi; fi\n`,
      {
        mode: 0o755,
      },
    );
    const result = spawnSync("bash", [containerScriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        SKIP_IMAGE_BUILD: "1",
        E2E_ARTIFACT_DIR: join(dir, "artifacts"),
        PERF_SAMPLE_INTERVAL_SECONDS: "1",
        ...env,
      },
    });
    const runArgs = existsSync(logPath)
      ? (readFileSync(logPath, "utf8")
          .split("\n")
          .findLast((line) => line.startsWith("run ")) ?? "")
      : "";
    return { status: result.status, stderr: result.stderr, runArgs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("desktop E2E container upstream provider env", () => {
  it("插件验证集将已准入的 session ready 回归传给容器", () => {
    const result = runContainerScriptWithFakeDocker({ E2E_SPEC_PRESET: "plugins-verified" });

    expect(result.status).toBe(0);
    expect(result.runArgs).toContain(
      "ZCODE_E2E_SPEC=./test/e2e/plugins/runtime/plugin-ui-session-ready.test.ts",
    );
    expect(result.runArgs).toContain("E2E_PROVIDER_HTTP_MODE=replay");
  });

  it("capture 模式把上游地址、模型与 preset 透传给容器", () => {
    const result = runContainerScriptWithFakeDocker({
      E2E_NETWORK_MODE: "capture",
      E2E_PROVIDER_API_KEY: "test-key",
      E2E_PROVIDER_BASE_URL: "https://upstream.example/v1",
      E2E_PROVIDER_MODEL: "model-a",
      E2E_PROVIDER_SECONDARY_MODEL: "model-b",
      E2E_PROVIDER_PRESET: "env",
    });

    expect(result.status).toBe(0);
    expect(result.runArgs).toContain("CHROMEDRIVER_PATH=/cache/chromedriver-fixture");
    expect(result.runArgs).toContain("E2E_PROVIDER_HTTP_MODE=capture");
    expect(result.runArgs).toContain("E2E_PROVIDER_BASE_URL=https://upstream.example/v1");
    expect(result.runArgs).toContain("E2E_PROVIDER_MODEL=model-a");
    expect(result.runArgs).toContain("E2E_PROVIDER_SECONDARY_MODEL=model-b");
    expect(result.runArgs).toContain("E2E_PROVIDER_PRESET=env");
  });

  it("capture 模式缺少上游地址时在启动容器前失败", () => {
    const result = runContainerScriptWithFakeDocker({
      E2E_NETWORK_MODE: "capture",
      E2E_PROVIDER_API_KEY: "test-key",
      E2E_PROVIDER_BASE_URL: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires E2E_PROVIDER_BASE_URL");
    expect(result.runArgs).toBe("");
  });
});
