import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolve, join } from "node:path";
import ts from "typescript";
import { resolveE2EScheduledSpecFiles } from "#e2e/helpers/e2e-spec-resolution";

import {
  hasRequiredSshE2EEnvironment,
  isFormalSpecAdmittedByEnvironment,
  isSshFormalSpec,
  isExplicitE2ESpecSelection,
  MANUAL_REVIEW_SPEC_GLOB,
  resolveEnvironmentGatedFormalSpecExcludes,
  SSH_FORMAL_SPEC_GLOB,
} from "../scripts/e2e-formal-spec-selection.mjs";
import {
  DEDICATED_FIXTURE_SPECS,
  QUEUED_SPECIAL_ENVIRONMENT_SPECS,
} from "../scripts/r3-remote-spec-inventory.mjs";
import { listDefaultFormalE2ESpecs } from "../scripts/run-windows-e2e-shards.mjs";

async function loadMochaTimeoutConfig(holdMs = 0) {
  const source = await readFile(new URL("../wdio.conf.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("wdio.conf.ts", source, ts.ScriptTarget.Latest, true);
  let expression = "";
  let workerAssignment = "";
  let resolverSource = "";
  let pluginSpecConstant = "";
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "resolveMochaTimeout") {
      resolverSource = node.getText(file);
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === "PLUGIN_NO_GIT_GITHUB_ARCHIVE_SPEC"
    ) {
      pluginSpecConstant = `const ${node.getText(file)};`;
    }
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file) === "mochaOpts" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const timeout = node.initializer.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) && property.name.getText(file) === "timeout",
      );
      if (timeout && ts.isPropertyAssignment(timeout))
        expression = timeout.initializer.getText(file);
    }
    if (ts.isMethodDeclaration(node) && node.name.getText(file) === "beforeSession") {
      workerAssignment =
        node.body?.statements
          .filter((statement) => statement.getText(file).startsWith("_config.mochaOpts ="))
          .map((statement) => statement.getText(file))
          .join("\n") ?? "";
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(expression).not.toBe("");
  expect(resolverSource).not.toBe("");
  expect(workerAssignment).not.toBe("");
  const context = `
    const requestSecuritySpecTimeout = (_, fallback) => fallback;
    const manualReviewHoldMs = ${holdMs};
    ${pluginSpecConstant}
    ${ts.transpileModule(resolverSource, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText}
  `;
  return {
    readBudget: new Function("configuredE2ESpecs", `${context} return ${expression};`) as (
      specs: string[],
    ) => number,
    applyWorkerBudget: new Function("_config", "specs", `${context} ${workerAssignment}`) as (
      config: { mochaOpts: { timeout: number } },
      specs: string[],
    ) => void,
  };
}

describe("desktop E2E environment-gated formal spec admission", () => {
  // 混合文件曾被 SSH 门禁整份排除；分开入口后，本地覆盖不能再依赖远端环境。
  it.each([
    ...["terminal", "unread"].map((scenario) => {
      const local = `conversation-session/remote/mobile/conversation-session-web-remote-${scenario}.test.ts`;
      return [scenario, local, local.replace(".test.ts", "-ssh.test.ts")];
    }),
    [
      "settings polish",
      "settings/general/settings-ui-polish.test.ts",
      "settings/general/settings-ui-polish-ssh.test.ts",
    ],
    [
      "settings notice",
      "conversation-session/remote/configuration/conversation-session-settings-no-editing-notice.test.ts",
      "conversation-session/remote/configuration/conversation-session-remote-settings-safeguards.test.ts",
    ],
  ])("keeps local %s coverage without SSH", (_scenario, localSpec, sshSpec) => {
    const local = `./test/e2e/${localSpec}`;
    const ssh = `./test/e2e/${sshSpec}`;
    const credentials = {
      ZCODE_E2E_SSH_HOST: "ssh.example.test",
      ZCODE_E2E_SSH_USERNAME: "example",
      ZCODE_E2E_SSH_PASSWORD: "example",
    };
    for (const env of [{}, credentials]) {
      const selected = listDefaultFormalE2ESpecs(resolve("packages/desktop"), env);
      expect(selected).toContain(local);
      expect(selected).not.toContain(ssh);
      const excludes = resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: false });
      expect(excludes).not.toContain(local);
      expect(excludes).toContain(ssh);
      expect(isFormalSpecAdmittedByEnvironment(local, env)).toBe(true);
      expect(isFormalSpecAdmittedByEnvironment(ssh, env)).toBe(false);
    }
    const harness = { ...credentials, ZCODE_E2E_SSH_CONTAINER: "example" };
    const selected = listDefaultFormalE2ESpecs(resolve("packages/desktop"), harness);
    expect(selected).toContain(local);
    expect(selected).toContain(ssh);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: true })).toEqual([]);
  });

  it("keeps the remote draft wrapper budget after promotion and preserves larger shard budgets", async () => {
    const { readBudget } = await loadMochaTimeoutConfig();
    const formal =
      "./test/e2e/conversation-session/remote/connection/conversation-session-remote-draft-prewarm.test.ts";
    expect(readBudget([formal])).toBe(20 * 60_000);
    expect(readBudget([formal.replace("remote/connection/", "manual-review/pending/")])).toBe(
      20 * 60_000,
    );
    expect(readBudget([formal, "conversation-session-r3-mobile.test.ts"])).toBe(40 * 60_000);
    // 合并时两侧在同一预算表扩展用例，须同时保留预装工具预算与远端草稿预算。
    expect(
      readBudget([formal, "conversation-session-preinstalled-tools-real-loopback.test.ts"]),
    ).toBe(25 * 60_000);
    expect(
      readBudget([formal, "conversation-session-preinstalled-tools-builtin-cdn.test.ts"]),
    ).toBe(60 * 60_000);
    expect(readBudget(["smoke.test.ts"])).toBe(120_000);
    expect(
      readBudget([
        "./test/e2e/conversation-session/hooks/conversation-session-hook-trust-worktree.test.ts",
      ]),
    ).toBe(180_000);
  });

  it("preserves the local runtime scenario budget for explicit files and glob workers", async () => {
    const { readBudget, applyWorkerBudget } = await loadMochaTimeoutConfig();
    const relative =
      "test/e2e/conversation-session/runtime/conversation-session-local-config-runtime-usage.test.ts";
    const paths = [
      `./${relative}`,
      resolve("packages/desktop", relative),
      `C:\\workspace\\z-code\\packages\\desktop\\${relative.replaceAll("/", "\\")}`,
    ];
    for (const spec of paths) {
      expect(readBudget([spec])).toBe(40 * 60_000);
      const config = { mochaOpts: { timeout: readBudget(["./test/e2e/**/*.test.ts"]) } };
      applyWorkerBudget(config, [spec]);
      expect(config.mochaOpts.timeout).toBe(40 * 60_000);
    }
    expect(
      readBudget([relative, "conversation-session-preinstalled-tools-builtin-cdn.test.ts"]),
    ).toBe(60 * 60_000);
    expect(readBudget(["smoke.test.ts"])).toBe(120_000);
  });

  it("applies actual worker budgets when macOS CI keeps its formal globs", async () => {
    // GitLab 构建图测试核对这组原样入参；公开准入测试不依赖闭源 CI YAML。
    const patterns = [
      "./test/e2e/conversation-session/**/*.test.ts",
      "./test/e2e/plugins/**/*.test.ts",
      "./test/e2e/workspace/files/workspace-file-tree-refresh.test.ts",
      "./test/e2e/feedback/logs/export-logs-jsonl-redaction.test.ts",
      "./test/e2e/settings/general/settings-ui-polish.test.ts",
    ];
    const { readBudget, applyWorkerBudget } = await loadMochaTimeoutConfig();
    const selected = resolveE2EScheduledSpecFiles({
      baseDir: resolve("packages/desktop"),
      specs: patterns,
      exclude: [
        MANUAL_REVIEW_SPEC_GLOB,
        ...resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false }),
      ],
    });
    for (const scenario of ["terminal", "unread"]) {
      const spec = `test/e2e/conversation-session/remote/mobile/conversation-session-web-remote-${scenario}.test.ts`;
      expect(selected).toContain(spec);
      const config = { mochaOpts: { timeout: readBudget(patterns) } };
      applyWorkerBudget(config, [resolve("packages/desktop", spec)]);
      expect(config.mochaOpts.timeout).toBe(15 * 60_000);
    }
    const config = { mochaOpts: { timeout: 30 * 60_000 } };
    applyWorkerBudget(config, ["test/e2e/infrastructure/smoke/smoke.test.ts"]);
    expect(config.mochaOpts.timeout).toBe(30 * 60_000);
    const unlimited = { mochaOpts: { timeout: 0 } };
    applyWorkerBudget(unlimited, [
      "test/e2e/conversation-session/remote/mobile/conversation-session-web-remote-terminal.test.ts",
    ]);
    expect(unlimited.mochaOpts.timeout).toBe(0);
  });

  it("retains manual-review time and Mocha options without inflating short workers", async () => {
    const { readBudget, applyWorkerBudget } = await loadMochaTimeoutConfig(3_000);
    const rootHooks = { beforeAll: () => undefined };
    const config = {
      mochaOpts: { timeout: readBudget(["./test/e2e/**/*.test.ts"]), grep: "example", rootHooks },
    };
    applyWorkerBudget(config, ["test/e2e/infrastructure/smoke/smoke.test.ts"]);
    expect(config.mochaOpts).toEqual({ timeout: 123_000, grep: "example", rootHooks });
    applyWorkerBudget(config, [
      "test/e2e/conversation-session/remote/mobile/conversation-session-web-remote-terminal.test.ts",
    ]);
    expect(config.mochaOpts.timeout).toBe(903_000);
    expect(config.mochaOpts.rootHooks).toBe(rootHooks);
  });

  it("loads public admission rules without the internal remote harness", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "e2e-public-admission-"));
    try {
      const scripts = join(fixture, "packages/desktop/scripts");
      await mkdir(scripts, { recursive: true });
      for (const file of [
        "e2e-formal-spec-selection.mjs",
        "e2e-remote-target-specs.json",
        "r3-remote-spec-inventory.mjs",
      ]) {
        await copyFile(resolve("packages/desktop/scripts", file), join(scripts, file));
      }
      const admission = await import(
        pathToFileURL(join(scripts, "e2e-formal-spec-selection.mjs")).href
      );
      expect(
        admission.resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false }),
      ).toContain(
        "./test/e2e/conversation-session/remote/configuration/conversation-session-r3-model-switch.test.ts",
      );
      expect(
        admission.isSshFormalSpec(
          "./test/e2e/conversation-session/remote/connection/conversation-session-remote-offline-icons.test.ts",
        ),
      ).toBe(false);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("excludes every manual-review domain from the default recursive glob", () => {
    const scheduled = resolveE2EScheduledSpecFiles({
      baseDir: resolve("packages/desktop"),
      specs: ["./test/e2e/**/*.test.ts"],
      exclude: [MANUAL_REVIEW_SPEC_GLOB],
    });
    expect(scheduled).toContain("test/e2e/infrastructure/smoke/smoke.test.ts");
    expect(scheduled.some((spec) => spec.includes("/manual-review/"))).toBe(false);
  });

  it.each(["bots", "settings", "feedback"])(
    "keeps explicit %s candidates discoverable",
    async (domain) => {
      const fixture = await mkdtemp(join(tmpdir(), "e2e-spec-discovery-"));
      try {
        // 转正后领域可以没有候选；发现规则必须使用独立 fixture，不能依赖仓库一直留有 pending。
        const directory = join(fixture, "test/e2e", domain, "manual-review/pending");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "example.test.ts"), "");
        const scheduled = resolveE2EScheduledSpecFiles({
          baseDir: fixture,
          specs: [`./test/e2e/${domain}/manual-review/**/*.test.ts`],
          exclude: [],
        });
        expect(scheduled).toEqual([`test/e2e/${domain}/manual-review/pending/example.test.ts`]);
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );

  it("applies environment gates to formal globs but keeps exact-file runs fail-closed", () => {
    const glob = ["./test/e2e/conversation-session/*.test.ts"];
    // 此处验证 canonical 正式目标；实际候选可以暂留 pending，不能随目录回退改掉门禁输入。
    const file = [
      "./test/e2e/conversation-session/remote/configuration/conversation-session-r3-model-switch.test.ts",
    ];
    expect(isExplicitE2ESpecSelection(glob)).toBe(false);
    expect(isExplicitE2ESpecSelection([])).toBe(false);
    expect(isExplicitE2ESpecSelection(file)).toBe(true);
    expect(
      resolveEnvironmentGatedFormalSpecExcludes({
        env: {},
        targeted: isExplicitE2ESpecSelection(glob),
      }),
    ).toContain(file[0]);
    expect(
      resolveEnvironmentGatedFormalSpecExcludes({
        env: {},
        targeted: isExplicitE2ESpecSelection(file),
      }),
    ).toEqual([]);
  });

  it("gates promoted remote targets while retaining local offline coverage", () => {
    expect(
      isSshFormalSpec(
        "./test/e2e/conversation-session/remote/configuration/conversation-session-r3-model-switch.test.ts",
      ),
    ).toBe(true);
    expect(
      isSshFormalSpec(
        "./test/e2e/conversation-session/remote/navigation/conversation-session-chat-remote-folder.test.ts",
      ),
    ).toBe(true);
    expect(
      isSshFormalSpec(
        "./test/e2e/conversation-session/remote/connection/conversation-session-remote-offline-icons.test.ts",
      ),
    ).toBe(false);
    expect(isSshFormalSpec("./test/e2e/bots/runtime/bot-r3-workspace-identity.test.ts")).toBe(
      false,
    );
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false })).toContain(
      "./test/e2e/conversation-session/remote/configuration/conversation-session-r3-model-switch.test.ts",
    );
  });

  it("excludes real SSH specs from default runs without complete credentials", () => {
    expect(hasRequiredSshE2EEnvironment({})).toBe(false);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false })).toContain(
      "./test/e2e/conversation-session/**/conversation-session-ssh-remote*.test.ts",
    );
  });

  it("keeps explicit SSH runs fail-closed and admits configured default runs", () => {
    const env = {
      ZCODE_E2E_SSH_HOST: "ssh.example.test",
      ZCODE_E2E_SSH_USERNAME: "root",
      ZCODE_E2E_SSH_PASSWORD: "secret-from-test-env",
      ZCODE_E2E_SSH_CONTAINER: "zcode-r3-server-example",
    };
    expect(hasRequiredSshE2EEnvironment(env)).toBe(true);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: false })).toEqual(
      expect.arrayContaining(
        [...DEDICATED_FIXTURE_SPECS, ...QUEUED_SPECIAL_ENVIRONMENT_SPECS].map(
          (spec) => `./test/e2e/${spec.replace("/manual-review/pending/", "/")}`,
        ),
      ),
    );
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: true })).toEqual([]);
  });

  it.each(["python-resource", "rewrite"])(
    "keeps preinstalled tools %s in explicitly prepared runs",
    (suffix) => {
      const formal = `./test/e2e/conversation-session/conversation-session-preinstalled-tools-${suffix}.test.ts`;
      const env = {
        ZCODE_E2E_SSH_HOST: "ssh.example.test",
        ZCODE_E2E_SSH_USERNAME: "dev",
        ZCODE_E2E_SSH_PASSWORD: "test-password",
        ZCODE_E2E_SSH_CONTAINER: "ordinary-ssh-target",
        ZCODE_E2E_PYTHON_ARTIFACT: "/tmp/example.artifact.json",
      };
      for (const batchEnv of [{}, env]) {
        expect(isFormalSpecAdmittedByEnvironment(formal, batchEnv)).toBe(false);
        expect(
          resolveEnvironmentGatedFormalSpecExcludes({ env: batchEnv, targeted: false }),
        ).toContain(formal);
        expect(
          listDefaultFormalE2ESpecs(resolve(process.cwd(), "packages/desktop"), batchEnv),
        ).not.toContain(formal);
      }
      expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: true })).toEqual([]);
    },
  );

  it("keeps dedicated fixture cases out of ordinary batches even with an SSH container", () => {
    const env = {
      ZCODE_E2E_SSH_HOST: "ssh.example.test",
      ZCODE_E2E_SSH_USERNAME: "dev",
      ZCODE_E2E_SSH_PASSWORD: "test-password",
      ZCODE_E2E_SSH_CONTAINER: "ordinary-ssh-target",
    };
    for (const spec of DEDICATED_FIXTURE_SPECS) {
      const formal = `./test/e2e/${spec.replace("/manual-review/pending/", "/")}`;
      expect(isFormalSpecAdmittedByEnvironment(formal, env)).toBe(false);
      expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: false })).toContain(formal);
    }
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: true })).toEqual([]);
  });

  it.each([
    "configuration/conversation-session-r3-live-zapi.test.ts",
    "configuration/conversation-session-r3-live-bigmodel-team.test.ts",
    "installation/conversation-session-r3-install-environment.test.ts",
  ])("requires explicit specialized setup for %s", (suffix) => {
    const env = {
      ZCODE_E2E_SSH_HOST: "ssh.example.test",
      ZCODE_E2E_SSH_USERNAME: "dev",
      ZCODE_E2E_SSH_PASSWORD: "test-password",
      ZCODE_E2E_SSH_CONTAINER: "ordinary-ssh-target",
    };
    const formal = `./test/e2e/conversation-session/remote/${suffix}`;
    expect(isFormalSpecAdmittedByEnvironment(formal, env)).toBe(false);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: false })).toContain(formal);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: true })).toEqual([]);
  });

  it("requires the harness container for queued remote targets", () => {
    // 远程队列按 case 准备干净目标；只有共享 SSH 凭据的 runner 不能运行这些用例。
    const credentials = {
      ZCODE_E2E_SSH_HOST: "ssh.example.test",
      ZCODE_E2E_SSH_USERNAME: "root",
      ZCODE_E2E_SSH_PASSWORD: "secret-from-test-env",
    };
    const queued =
      "./test/e2e/conversation-session/remote/configuration/conversation-session-r3-model-switch.test.ts";
    const queuedSshRemote =
      "./test/e2e/conversation-session/remote/connection/conversation-session-ssh-remote-development-p0.test.ts";
    // 尚未排进队列的 ssh-remote 用例只依赖真实服务器凭据。
    const unqueuedSshRemote =
      "./test/e2e/conversation-session/conversation-session-ssh-remote-example.test.ts";
    const excludes = resolveEnvironmentGatedFormalSpecExcludes({
      env: credentials,
      targeted: false,
    });
    expect(excludes).toContain(queued);
    expect(excludes).toContain(queuedSshRemote);
    expect(excludes).not.toContain(SSH_FORMAL_SPEC_GLOB);
    expect(isFormalSpecAdmittedByEnvironment(queued, credentials)).toBe(false);
    expect(isFormalSpecAdmittedByEnvironment(queuedSshRemote, credentials)).toBe(false);
    expect(isFormalSpecAdmittedByEnvironment(unqueuedSshRemote, credentials)).toBe(true);
    expect(isFormalSpecAdmittedByEnvironment(unqueuedSshRemote, {})).toBe(false);
    expect(
      isFormalSpecAdmittedByEnvironment(queued, {
        ...credentials,
        ZCODE_E2E_SSH_CONTAINER: "zcode-r3-server-example",
      }),
    ).toBe(true);
    expect(
      isFormalSpecAdmittedByEnvironment(
        "./test/e2e/conversation-session/remote/connection/conversation-session-remote-offline-icons.test.ts",
        {},
      ),
    ).toBe(true);
  });

  it("keeps nested formal scenarios discoverable and nested candidates excluded", () => {
    const formal = resolveE2EScheduledSpecFiles({
      baseDir: resolve("packages/desktop"),
      specs: ["./test/e2e/conversation-session/**/*.test.ts"],
      exclude: [MANUAL_REVIEW_SPEC_GLOB],
    });
    expect(formal).toContain(
      "test/e2e/conversation-session/composer/conversation-session-first-send.test.ts",
    );
    expect(formal).toContain(
      "test/e2e/conversation-session/remote/connection/conversation-session-ssh-remote-banner-reconnect.test.ts",
    );
    expect(formal.some((spec) => spec.includes("/manual-review/"))).toBe(false);
    expect(
      isSshFormalSpec(
        "./test/e2e/conversation-session/remote/connection/conversation-session-ssh-remote-example.test.ts",
      ),
    ).toBe(true);
  });

  it("uses the shared admission helper in the WDIO exclude list", () => {
    const source = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");
    expect(source).toContain("resolveEnvironmentGatedFormalSpecExcludes({");
    expect(source).toContain("hasRequiredSshE2EEnvironment(process.env)");
  });
});
