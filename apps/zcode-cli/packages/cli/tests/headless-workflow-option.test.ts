import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import type { RunContext } from "@zcode/shared-types";
import { run, type RunDependencies } from "../src/run.js";
import { WORKFLOW_MODE_SCOPE_ERROR } from "../src/workflow-mode.js";

/**
 * `--workflow-mode` 在 headless / resume / stdio 各入口上的取值与隔离
 * （docs/dynamic-workflow/launch.md「The standalone CLI: `--workflow-mode`」）。
 * staging 的布尔 `--enable-workflow` 已由 `--workflow-mode` 取代，这里同时钉住它的退役。
 */

function harness(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const appOptions: ZCodeAppOptions[] = [];
  let protocolCalls = 0;
  const ctx: RunContext = {
    argv,
    stdin: { isTTY: true } as NodeJS.ReadStream,
    stdout: {
      isTTY: true,
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
  };
  const result = {
    response: "done",
    events: [],
    projection: { status: "idle", turnCount: 1, totalTokenCount: 0 },
    traceId: "trace-workflow-option",
    turnId: "turn-workflow-option",
  };
  const deps: RunDependencies = {
    skipUserConfig: true,
    env: {},
    loadDotenv: () => ({ keys: [], loaded: false }),
    resolveLatestSession: async () => ({ id: "sess_latest" }) as never,
    resolveWorkspaceGitBranch: async () => undefined,
    listCustomCommands: async () => ({ commands: [], diagnostics: [] }),
    startProcessProviderRegistryRuntime: async () =>
      ({ runtime: { registryService: {} }, dispose: () => {} }) as never,
    createZCodeApp: (options) => {
      appOptions.push(options!);
      return {
        sessionId: "sess_workflow_option",
        traceId: "trace-workflow-option",
        runtime: {},
        close: async () => {},
        getLocale: () => "en-US",
        getModel: () => "openai/test",
        getThoughtLevel: () => "medium",
        getTheme: () => "light",
        clearTarget: async () => false,
        readTarget: async () => null,
        updateTargetStatus: async () => null,
        setTarget: async ({ objective }: { objective: string }) => ({
          objective,
          status: "active",
          targetID: "target-workflow-option",
          sessionID: "sess_workflow_option",
          time: { created: 1, updated: 1 },
        }),
        continueActiveTarget: async () => result,
        submitPrompt: async () => result,
      } as never;
    },
    runTui: async (options) => {
      await options.submitPrompt("hello", {
        abortSignal: new AbortController().signal,
      });
      return 0;
    },
    runZCodeProtocolAgent: async (options) => {
      protocolCalls += 1;
      // stdio 只接收原有协议入口参数，工作流策略继续由 Host 决定。
      assert.equal("dynamicWorkflowEnabled" in options, false);
      assert.equal("workflowMode" in options, false);
    },
  };
  return {
    ctx,
    deps,
    appOptions,
    stdout: () => stdout,
    stderr: () => stderr,
    protocolCalls: () => protocolCalls,
  };
}

const PAIRS = {
  disabled: { enabled: false, onDemand: false },
  onDemand: { enabled: true, onDemand: true },
  alwaysOn: { enabled: true, onDemand: false },
} as const;

function assertPair(options: ZCodeAppOptions, mode: keyof typeof PAIRS) {
  assert.equal(options.runtimeConfig?.dynamicWorkflowEnabled, PAIRS[mode].enabled);
  assert.equal(options.runtimeConfig?.dynamicWorkflowToolsOnDemand, PAIRS[mode].onDemand);
}

for (const promptFlag of ["-p", "--prompt", "--target"]) {
  for (const mode of [undefined, "disabled", "onDemand", "alwaysOn"] as const) {
    test(`${promptFlag}: workflow mode ${mode ?? "defaults to disabled"}`, async () => {
      const h = harness([...(mode ? ["--workflow-mode", mode] : []), promptFlag, "hello"]);
      assert.equal(await run(h.ctx, h.deps), 0, h.stderr());
      assert.equal(h.appOptions.length, 1);
      assertPair(h.appOptions[0], mode ?? "disabled");
      assert.equal(h.stdout(), "done\n");
    });
  }
}

for (const resumeArgs of [["--resume", "sess_existing"], ["--continue"]]) {
  for (const mode of [undefined, "alwaysOn"] as const) {
    test(`${resumeArgs[0]} uses this invocation's workflow mode: ${mode ?? "default"}`, async () => {
      const h = harness(["-p", "hello", ...resumeArgs, ...(mode ? ["--workflow-mode", mode] : [])]);
      assert.equal(await run(h.ctx, h.deps), 0, h.stderr());
      assert.equal(h.appOptions[0].resume, true);
      assert.equal(h.appOptions[0].sessionId, resumeArgs[1] ?? "sess_latest");
      assertPair(h.appOptions[0], mode ?? "disabled");
    });
  }
}

test("an enabling workflow mode preserves the explicit tool disallowlist", async () => {
  const h = harness([
    "--workflow-mode",
    "alwaysOn",
    "--disallowed-tools",
    "CreateWorkflow",
    "-p",
    "hello",
  ]);
  assert.equal(await run(h.ctx, h.deps), 0, h.stderr());
  assertPair(h.appOptions[0], "alwaysOn");
  assert.deepEqual(h.appOptions[0].runtimeConfig?.toolDisallowlist, ["CreateWorkflow"]);
});

for (const argv of [
  ["app-server", "--stdio"],
  ["agent-server", "--stdio"],
]) {
  test(`${argv[0]} leaves the workflow policy to the Host`, async () => {
    const h = harness(argv);
    assert.equal(await run(h.ctx, h.deps), 0, h.stderr());
    assert.equal(h.protocolCalls(), 1);
    assert.equal(h.appOptions.length, 0);
  });
}

for (const argv of [[], ["tui"]]) {
  test(`${argv[0] ?? "implicit TUI"} startup defaults to disabled like headless`, async () => {
    const h = harness(argv);
    assert.equal(await run(h.ctx, h.deps), 0, h.stderr());
    assert.equal(h.appOptions.length, 1);
    assertPair(h.appOptions[0], "disabled");
  });
}

for (const argv of [["app-server", "--stdio"], ["agent-server", "--stdio"], ["doctor"]]) {
  test(`rejects --workflow-mode outside TUI and headless: ${argv[0]}`, async () => {
    const h = harness([...argv, "--workflow-mode", "alwaysOn"]);
    assert.equal(await run(h.ctx, h.deps), 1);
    assert.equal(h.stderr(), `${WORKFLOW_MODE_SCOPE_ERROR}\n`);
    assert.equal(h.appOptions.length, 0);
    assert.equal(h.protocolCalls(), 0);
    assert.equal(h.stdout(), "");
  });
}

test("the retired --enable-workflow flag is an unknown option", async () => {
  const h = harness(["--enable-workflow", "-p", "hello"]);
  assert.notEqual(await run(h.ctx, h.deps), 0);
  assert.match(h.stderr(), /enable-workflow/);
  assert.equal(h.appOptions.length, 0);
});

for (const locale of ["en-US", "zh-CN"]) {
  test(`help documents --workflow-mode and not the retired flag: ${locale}`, async () => {
    const h = harness(["--help", "--locale", locale]);
    assert.equal(await run(h.ctx, h.deps), 0, h.stderr());
    assert.match(h.stdout(), /--workflow-mode <mode>.*disabled.*onDemand.*alwaysOn/);
    assert.doesNotMatch(h.stdout(), /--enable-workflow/);
    assert.equal(h.appOptions.length, 0);
  });
}
