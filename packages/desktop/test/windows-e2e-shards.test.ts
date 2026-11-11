import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createWindowsE2EShardPlan,
  executeWindowsE2EShardPlan,
  listDefaultFormalE2ESpecs,
  partitionE2ESpecsByWeight,
  resolveWindowsE2EShardTotal,
} from "../scripts/run-windows-e2e-shards.mjs";

const repoRoot = resolve("C:/repo");
const desktopDir = join(repoRoot, "packages/desktop");

function createPlan(overrides: Record<string, unknown> = {}) {
  return createWindowsE2EShardPlan({
    args: [],
    desktopDir,
    env: { ZCODE_E2E_RUN_ID: "local-full", ZCODE_E2E_SHARD_TOTAL: "2" },
    platform: "win32",
    repoRoot,
    ...overrides,
  });
}

describe("Windows E2E shard runner", () => {
  it("derives disjoint paths from automatic run IDs while preserving an explicit run ID", () => {
    const timestamp = new Date("2026-07-11T00:30:00.123Z");
    vi.useFakeTimers();
    vi.setSystemTime(timestamp);

    try {
      const firstPlan = createPlan({
        // 修复原因：默认 full run 已改为单 shard；路径隔离断言必须显式进入并发分片场景。
        env: { ZCODE_E2E_SHARD_TOTAL: "2" },
        processId: 4242,
        runIdEntropy: "entropy-a",
        runIdTimestamp: timestamp,
      });
      const secondPlan = createPlan({
        env: { ZCODE_E2E_SHARD_TOTAL: "2" },
        processId: 4242,
        runIdEntropy: "entropy-b",
        runIdTimestamp: timestamp,
      });

      expect(firstPlan.runId).not.toBe(secondPlan.runId);
      for (const key of [
        "ZCODE_E2E_HOME_DIR",
        "ZCODE_E2E_ARTIFACT_DIR",
        "ZCODE_E2E_NETWORK_CAPTURE_DIR",
      ] as const) {
        const firstPaths = new Set(firstPlan.children.map((child) => child.env[key]));
        const secondPaths = new Set(secondPlan.children.map((child) => child.env[key]));
        expect([...firstPaths].filter((path) => secondPaths.has(path))).toEqual([]);
      }

      const explicitPlan = createPlan({
        env: { ZCODE_E2E_RUN_ID: "explicit-compatible-run" },
        processId: 4242,
        runIdEntropy: "ignored-entropy",
        runIdTimestamp: timestamp,
      });
      expect(explicitPlan.runId).toBe("explicit-compatible-run");
    } finally {
      vi.useRealTimers();
    }
  });

  it("plans a default full Windows run as a single shard", () => {
    const plan = createPlan({
      env: { ZCODE_E2E_RUN_ID: "default-single" },
    });
    expect(plan.shardTotal).toBe(1);
    expect(plan.children).toHaveLength(1);
    expect(plan.children[0]?.args.some((arg) => arg.startsWith("--shard"))).toBe(false);
    expect(plan.children[0]?.env.ZCODE_E2E_HOME_DIR).toBe(
      join(desktopDir, ".e2e-home-default-single"),
    );
  });

  it("lists the default formal specs without manual-review or live provider cases", () => {
    const specs = listDefaultFormalE2ESpecs(resolve(process.cwd(), "packages/desktop"));

    // Bug 根因：formal case 由目录动态发现，固定总数会让新增或删除合法 case 误伤 pre-push。
    // 用稳定的 smoke 包含关系确认发现结果非空，其余断言只校验默认集合的语义边界。
    expect(specs).toContain("./test/e2e/infrastructure/smoke/smoke.test.ts");
    expect(specs).not.toContain("./test/e2e/infrastructure/smoke/upstream-provider.test.ts");
    expect(specs.some((spec) => spec.includes("/manual-review/"))).toBe(false);
    expect(specs.some((spec) => spec.includes("conversation-session-ssh-remote"))).toBe(false);

    const sshSpecs = listDefaultFormalE2ESpecs(resolve(process.cwd(), "packages/desktop"), {
      ZCODE_E2E_SSH_HOST: "ssh.example.test",
      ZCODE_E2E_SSH_USERNAME: "root",
      ZCODE_E2E_SSH_PASSWORD: "secret-from-test-env",
    });
    // 只有 SSH 凭据、没有 harness 容器时，远程队列用例不能进入共享主机的分片。
    expect(sshSpecs.some((spec) => spec.includes("conversation-session-ssh-remote"))).toBe(false);
    expect(sshSpecs).not.toContain(
      "./test/e2e/conversation-session/remote/configuration/conversation-session-r3-model-switch.test.ts",
    );

    const harnessSpecs = listDefaultFormalE2ESpecs(resolve(process.cwd(), "packages/desktop"), {
      ZCODE_E2E_SSH_HOST: "ssh.example.test",
      ZCODE_E2E_SSH_USERNAME: "root",
      ZCODE_E2E_SSH_PASSWORD: "secret-from-test-env",
      ZCODE_E2E_SSH_CONTAINER: "zcode-r3-server-example",
    });
    expect(harnessSpecs).toContain(
      "./test/e2e/conversation-session/remote/connection/conversation-session-ssh-remote-connection-p0.test.ts",
    );
    expect(harnessSpecs).toContain(
      "./test/e2e/conversation-session/remote/configuration/conversation-session-r3-model-switch.test.ts",
    );
  });

  it("uses deterministic LPT weights and a fallback for new specs", () => {
    const buckets = partitionE2ESpecsByWeight(
      ["./a.test.ts", "./b.test.ts", "./c.test.ts", "./new.test.ts"],
      2,
      {
        defaultWeightMs: 40,
        weights: {
          "./a.test.ts": 100,
          "./b.test.ts": 80,
          "./c.test.ts": 20,
        },
      },
    );

    expect(buckets).toEqual([
      { estimatedWeightMs: 120, specs: ["./a.test.ts", "./c.test.ts"] },
      { estimatedWeightMs: 120, specs: ["./b.test.ts", "./new.test.ts"] },
    ]);
  });

  it("passes weighted spec groups explicitly instead of native contiguous shards", () => {
    const weightedSpecBuckets = [
      { estimatedWeightMs: 100, specs: ["./test/e2e/infrastructure/smoke/smoke.test.ts"] },
      { estimatedWeightMs: 90, specs: ["./test/e2e/infrastructure/smoke/container-boot.test.ts"] },
    ];
    const plan = createPlan({ weightedSpecBuckets });

    expect(plan.distributionKind).toBe("historical-lpt");
    expect(plan.children.map((child) => child.env.ZCODE_E2E_SPEC)).toEqual([
      "./test/e2e/infrastructure/smoke/smoke.test.ts",
      "./test/e2e/infrastructure/smoke/container-boot.test.ts",
    ]);
    expect(
      plan.children.every((child) => child.args.every((arg) => !arg.startsWith("--shard"))),
    ).toBe(true);
  });

  it("plans two isolated shards for an explicit two-shard run", () => {
    const plan = createPlan();

    expect(plan.shardTotal).toBe(2);
    expect(plan.children).toHaveLength(2);
    expect(plan.children.map((child) => child.shardId)).toEqual(["1/2", "2/2"]);
    expect(plan.children.map((child) => child.args.at(-1))).toEqual(["--shard=1/2", "--shard=2/2"]);

    for (const key of [
      "ZCODE_E2E_HOME_DIR",
      "ZCODE_E2E_RUN_ID",
      "ZCODE_E2E_ARTIFACT_DIR",
      "ZCODE_E2E_NETWORK_CAPTURE_DIR",
    ] as const) {
      expect(new Set(plan.children.map((child) => child.env[key])).size).toBe(2);
    }

    for (const child of plan.children) {
      expect(child.env.ZCODE_E2E_SKIP_BUILD).toBe("1");
      expect(child.env.ZCODE_E2E_SKIP_AGENT_BUILD).toBe("1");
      expect(child.summaryPath).toBe(join(child.artifactDir, "summary.json"));
    }
  });

  it("keeps every default HOME disjoint across concurrent runner run IDs", () => {
    const firstPlan = createPlan({
      // 修复原因：覆盖 env 会同时移除 createPlan 默认的 shard 数，需保留显式分片前提。
      env: {
        ZCODE_E2E_RUN_ID: "concurrent-run-a",
        ZCODE_E2E_SHARD_TOTAL: "2",
      },
    });
    const secondPlan = createPlan({
      env: {
        ZCODE_E2E_RUN_ID: "concurrent-run-b",
        ZCODE_E2E_SHARD_TOTAL: "2",
      },
    });
    const firstHomes = new Set(firstPlan.children.map((child) => child.env.ZCODE_E2E_HOME_DIR));
    const secondHomes = new Set(secondPlan.children.map((child) => child.env.ZCODE_E2E_HOME_DIR));

    expect([...firstHomes].filter((home) => secondHomes.has(home))).toEqual([]);
    expect([...firstHomes].every((home) => home.includes("concurrent-run-a"))).toBe(true);
    expect([...secondHomes].every((home) => home.includes("concurrent-run-b"))).toBe(true);
  });

  it("preserves an explicit HOME for a single-child run", () => {
    const explicitHomeRoot = resolve("C:/e2e-homes/single");
    const plan = createPlan({
      env: {
        ZCODE_E2E_HOME_DIR: explicitHomeRoot,
        ZCODE_E2E_RUN_ID: "explicit-single-home-run",
      },
    });

    expect(plan.shardTotal).toBe(1);
    expect(plan.children[0]?.env.ZCODE_E2E_HOME_DIR).toBe(explicitHomeRoot);
  });

  it("adds run and shard identity below an explicit sharded HOME base", () => {
    const explicitHomeRoot = resolve("C:/e2e-homes");
    const plan = createPlan({
      env: {
        ZCODE_E2E_HOME_DIR: explicitHomeRoot,
        ZCODE_E2E_RUN_ID: "explicit-home-run",
        ZCODE_E2E_SHARD_TOTAL: "2",
      },
    });

    expect(plan.children.map((child) => child.env.ZCODE_E2E_HOME_DIR)).toEqual([
      join(explicitHomeRoot, "explicit-home-run", "shard-1-of-2"),
      join(explicitHomeRoot, "explicit-home-run", "shard-2-of-2"),
    ]);
  });

  it("builds desktop and agent once before starting both children concurrently", async () => {
    const plan = createPlan();
    expect(plan.buildSteps[1]?.env.ZCODE_DESKTOP_AGENT_BUILD_MODE).toBe("turbo");
    const events: string[] = [];
    const childResolvers: Array<(result: { exitCode: number }) => void> = [];

    const execution = executeWindowsE2EShardPlan(plan, {
      now: (() => {
        let value = 1_000;
        return () => (value += 50);
      })(),
      summaryExists: () => true,
      spawnStep: vi.fn(async (step) => {
        events.push(`start:${step.id}`);
        if (step.kind === "build") {
          events.push(`finish:${step.id}`);
          return { exitCode: 0 };
        }
        return await new Promise<{ exitCode: number }>((resolveChild) => {
          childResolvers.push(resolveChild);
        });
      }),
      writeManifest: vi.fn(),
      printManifest: vi.fn(),
    });

    await vi.waitFor(() => expect(childResolvers).toHaveLength(2));
    expect(events).toEqual([
      "start:build-desktop",
      "finish:build-desktop",
      "start:build-agent",
      "finish:build-agent",
      "start:shard-1-of-2",
      "start:shard-2-of-2",
    ]);

    childResolvers[1]?.({ exitCode: 0 });
    childResolvers[0]?.({ exitCode: 0 });
    const manifest = await execution;
    expect(manifest.wallDurationMs).toBe(50);
    expect(manifest.children.map((child) => child.exitCode)).toEqual([0, 0]);
  });

  it.each([
    {
      label: "targeted CLI",
      args: ["--spec=./test/e2e/infrastructure/smoke/container-boot.test.ts", "--shards=10"],
      env: { ZCODE_E2E_SHARD_TOTAL: "4" },
    },
    {
      label: "targeted env",
      args: ["--shards=10"],
      env: {
        ZCODE_E2E_SPEC: "./test/e2e/infrastructure/smoke/container-boot.test.ts",
        ZCODE_E2E_SHARD_TOTAL: "4",
      },
    },
    {
      label: "capture",
      args: ["--shards=10"],
      env: { E2E_PROVIDER_HTTP_MODE: "capture", ZCODE_E2E_SHARD_TOTAL: "4" },
    },
    {
      label: "manual review",
      args: ["--shards=10"],
      env: { ZCODE_E2E_MANUAL_REVIEW: "1", ZCODE_E2E_SHARD_TOTAL: "4" },
    },
  ])("keeps $label runs single despite explicit shard overrides", ({ args, env }) => {
    const plan = createPlan({ args, env });
    expect(plan.shardTotal).toBe(1);
    expect(plan.children).toHaveLength(1);
  });

  it("keeps non-Windows runs single by default", () => {
    expect(resolveWindowsE2EShardTotal({ args: [], env: {}, platform: "darwin" })).toBe(1);
  });

  it("validates explicit overrides and strips the runner-only option", () => {
    const plan = createPlan({
      args: ["--logLevel=warn", "--shards=3", "--mochaOpts.timeout=9000"],
      env: { ZCODE_E2E_SHARD_TOTAL: "4", ZCODE_E2E_RUN_ID: "override" },
    });

    expect(plan.shardTotal).toBe(3);
    expect(plan.wdioArgs).toEqual(["--logLevel=warn", "--mochaOpts.timeout=9000"]);
    expect(plan.children.map((child) => child.args.at(-1))).toEqual([
      "--shard=1/3",
      "--shard=2/3",
      "--shard=3/3",
    ]);
    expect(() =>
      resolveWindowsE2EShardTotal({ args: ["--shards=0"], env: {}, platform: "win32" }),
    ).toThrow("positive integer");
    expect(() =>
      resolveWindowsE2EShardTotal({
        args: [],
        env: { ZCODE_E2E_SHARD_TOTAL: "two" },
        platform: "win32",
      }),
    ).toThrow("positive integer");
  });

  it("does not reshard a native WDIO shard from any override", () => {
    expect(
      resolveWindowsE2EShardTotal({
        args: ["--shard=1/2"],
        env: { ZCODE_E2E_SHARD_TOTAL: "4" },
        platform: "win32",
      }),
    ).toBe(1);
    expect(
      resolveWindowsE2EShardTotal({
        args: ["--shard=1/2", "--shards=3"],
        env: { ZCODE_E2E_SHARD_TOTAL: "4" },
        platform: "win32",
      }),
    ).toBe(1);
  });

  it("waits for every child, writes one manifest, and fails when any shard fails", async () => {
    const plan = createPlan();
    const completed: string[] = [];
    const writeManifest = vi.fn();
    const printManifest = vi.fn();

    let caught: unknown;
    try {
      await executeWindowsE2EShardPlan(plan, {
        now: () => 2_000,
        summaryExists: () => true,
        spawnStep: async (step) => {
          if (step.kind === "build") return { exitCode: 0 };
          completed.push(step.id);
          return { exitCode: step.shardIndex === 1 ? 7 : 0 };
        },
        writeManifest,
        printManifest,
      });
    } catch (error) {
      caught = error;
    }

    expect(completed).toEqual(["shard-1-of-2", "shard-2-of-2"]);
    expect(writeManifest).toHaveBeenCalledOnce();
    expect(printManifest).toHaveBeenCalledOnce();
    expect(caught).toMatchObject({
      message: expect.stringContaining("shard 1/2 exited with code 7"),
      manifest: {
        runId: "local-full",
        shardTotal: 2,
        wallDurationMs: 0,
        children: [
          {
            shardId: "1/2",
            exitCode: 7,
            artifactDir: plan.children[0]?.artifactDir,
            summaryPath: plan.children[0]?.summaryPath,
          },
          {
            shardId: "2/2",
            exitCode: 0,
            artifactDir: plan.children[1]?.artifactDir,
            summaryPath: plan.children[1]?.summaryPath,
          },
        ],
      },
    });
  });

  it("rejects a zero-exit shard that produced no summary", async () => {
    const plan = createPlan();

    await expect(
      executeWindowsE2EShardPlan(plan, {
        now: () => 2_000,
        spawnStep: async () => ({ exitCode: 0 }),
        summaryExists: () => false,
        writeManifest: vi.fn(),
        printManifest: vi.fn(),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("missing shard summary"),
      manifest: {
        children: expect.arrayContaining([
          expect.objectContaining({ exitCode: 1, error: expect.stringContaining("summary.json") }),
        ]),
      },
    });
  });

  it("records a rejected shard start, waits for the delayed shard, and writes one manifest", async () => {
    const plan = createPlan();
    const writeManifest = vi.fn();
    const printManifest = vi.fn();
    let finishDelayedShard: (() => void) | undefined;

    const execution = executeWindowsE2EShardPlan(plan, {
      now: () => 2_000,
      summaryExists: () => true,
      spawnStep: (step) => {
        if (step.kind === "build") return Promise.resolve({ exitCode: 0 });
        if (step.shardIndex === 1) return Promise.reject(new Error("spawn pnpm EAGAIN"));
        return new Promise<{ exitCode: number }>((resolveChild) => {
          finishDelayedShard = () => resolveChild({ exitCode: 0 });
        });
      },
      writeManifest,
      printManifest,
    });

    await vi.waitFor(() => expect(finishDelayedShard).toBeTypeOf("function"));
    await Promise.resolve();
    expect(writeManifest).not.toHaveBeenCalled();

    finishDelayedShard?.();
    await expect(execution).rejects.toMatchObject({
      message: expect.stringContaining("shard 1/2 failed to start: spawn pnpm EAGAIN"),
      manifest: {
        children: [
          expect.objectContaining({
            shardId: "1/2",
            exitCode: 1,
            error: "spawn pnpm EAGAIN",
          }),
          expect.objectContaining({ shardId: "2/2", exitCode: 0 }),
        ],
      },
    });
    expect(writeManifest).toHaveBeenCalledOnce();
    expect(printManifest).toHaveBeenCalledOnce();
  });

  it("terminates another cancellable shard after an unrecoverable start error", async () => {
    const plan = createPlan();
    let finishSecondShard: ((result: { exitCode: number; signal?: string }) => void) | undefined;
    const terminateSecondShard = vi.fn(() => {
      finishSecondShard?.({ exitCode: 1, signal: "SIGTERM" });
    });

    const execution = executeWindowsE2EShardPlan(plan, {
      now: () => 2_000,
      summaryExists: () => true,
      spawnStep: (step) => {
        if (step.kind === "build") return Promise.resolve({ exitCode: 0 });
        if (step.shardIndex === 1) return Promise.reject(new Error("spawn pnpm ENOMEM"));
        return {
          result: new Promise<{ exitCode: number; signal?: string }>((resolveChild) => {
            finishSecondShard = resolveChild;
          }),
          terminate: terminateSecondShard,
        };
      },
      writeManifest: vi.fn(),
      printManifest: vi.fn(),
    });

    await expect(execution).rejects.toMatchObject({
      manifest: {
        children: [
          expect.objectContaining({ error: "spawn pnpm ENOMEM" }),
          expect.objectContaining({ signal: "SIGTERM" }),
        ],
      },
    });
    expect(terminateSecondShard).toHaveBeenCalledOnce();
  });

  it("terminates active shards on a parent signal and reports the interrupted run", async () => {
    const plan = createPlan();
    const signalSource = new EventEmitter();
    const childResolvers = new Map<
      number,
      (result: { exitCode: number; signal?: string }) => void
    >();
    const terminates: Array<ReturnType<typeof vi.fn>> = [];

    const execution = executeWindowsE2EShardPlan(plan, {
      now: () => 2_000,
      summaryExists: () => true,
      signalSource,
      spawnStep: (step) => {
        if (step.kind === "build") return Promise.resolve({ exitCode: 0 });
        const terminate = vi.fn(() => {
          childResolvers.get(step.shardIndex)?.({ exitCode: 1, signal: "SIGTERM" });
        });
        terminates.push(terminate);
        return {
          result: new Promise<{ exitCode: number; signal?: string }>((resolveChild) => {
            childResolvers.set(step.shardIndex, resolveChild);
          }),
          terminate,
        };
      },
      writeManifest: vi.fn(),
      printManifest: vi.fn(),
    });

    await vi.waitFor(() => expect(childResolvers.size).toBe(2));
    signalSource.emit("SIGTERM");

    await expect(execution).rejects.toMatchObject({
      message: expect.stringContaining("parent received SIGTERM"),
      manifest: expect.objectContaining({ interruptedBySignal: "SIGTERM" }),
    });
    expect(terminates).toHaveLength(2);
    expect(terminates.every((terminate) => terminate.mock.calls.length === 1)).toBe(true);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("separates the single-shard default from the fixed 10-shard performance entry", () => {
    const desktopPackage = JSON.parse(
      readFileSync(resolve(process.cwd(), "packages/desktop/package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };
    const rootPackage = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };

    expect(desktopPackage.scripts["pretest:e2e"]).toBe(
      "pnpm --filter @zcode/e2e-report build:node",
    );
    expect(desktopPackage.scripts["test:e2e"]).toBe("node scripts/run-windows-e2e-shards.mjs");
    expect(rootPackage.scripts["test:e2e"]).toBe("pnpm --filter @zcode/desktop test:e2e");
    expect(desktopPackage.scripts["test:e2e:windows:sharded"]).toBe("pnpm test:e2e -- --shards=10");
    expect(rootPackage.scripts["test:e2e:windows:sharded"]).toBe(
      "pnpm --filter @zcode/desktop test:e2e:windows:sharded",
    );
  });
});
