/**
 * 失败路径：错误是一等公民。墙钟超时 / abort / 脚本抛错 / 子进程输出损坏的 NDJSON 都必须被
 * 归一成清晰结算，绝不静默吞掉。见 docs/execution-engine.md 的"How the bridge settles the run"
 * 与 apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md：脚本之错 → errored；宿主侧故障（超时 / 崩溃 /
 * 协议损坏）→ stopped(interrupted)；abort → stopped(user | model)。
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore, WorkflowError, type Caps, type RunSettlement } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { TEST_CWD } from "./helpers.js";

interface LoweredOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  caps?: Caps;
}

async function runLowered(
  lowered: string,
  opts: LoweredOpts = {},
): Promise<{ settlement: RunSettlement; journal: InMemoryJournalStore }> {
  const journal = new InMemoryJournalStore();
  // HANG 的 ask 永不应答：空动作串让 driver 什么都不做，请求就一直在飞。
  const driver = new AutoDriver(journal, { asks: { "ask#1": () => [] } });
  const settlement = await runWorkflowScript({
    cwd: TEST_CWD,
    lowered,
    runId: "run",
    caps: opts.caps ?? { maxConcurrency: 4 },
    askSpecs: new Map([["ask#1", { typed: false }]]),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  return { settlement, journal };
}

/**
 * 永不结算的沙箱体（用于超时 / abort）：一个 driver 永不应答的 ask。它是 run 「活着却无事可做」
 * 的唯一合法形态——一个裸的永不兑现的 promise如今是停滞，cell 会当场以 ScriptStalled 结束 run
 * （tests/streams.test.ts），再也等不到超时或 abort。
 */
const HANG = 'await __host.ask("ask#1", __host.createActor("actor#1", "waiter"), "wait forever");';

type Stopped = { status: "stopped"; reason: string; error?: WorkflowError };
type Errored = { status: "errored"; error: WorkflowError };

describe("failures — wall-clock timeout", () => {
  it("kills the child and stops the run as interrupted with a clear timeout error", async () => {
    const { settlement, journal } = await runLowered(HANG, { timeoutMs: 400 });
    expect(settlement.status).toBe("stopped");
    const stopped = settlement as Stopped;
    expect(stopped.reason).toBe("interrupted");
    expect(stopped.error).toBeInstanceOf(WorkflowError);
    expect(stopped.error?.code).toBe("Interrupted");
    expect(stopped.error?.message).toContain("wall-clock timeout of 400ms");
    // 引擎裁决落 journal：stopped(interrupted) + failure_json（可 resume），不伪装成用户取消。
    const run = journal.getRun("run");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("interrupted");
    expect(run?.failure?.code).toBe("Interrupted");
  });
});

describe("failures — abort signal", () => {
  it("kills the child and settles stopped(user)", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const { settlement, journal } = await runLowered(HANG, { signal: controller.signal });
    expect(settlement).toEqual({ status: "stopped", reason: "user" });
    // abort 是唯一的真取消：journal 记 stopped(user)（可 resume），不带 failure。
    expect(journal.getRun("run")).toMatchObject({ status: "stopped", stopReason: "user" });
    expect(journal.getRun("run")?.failure).toBeUndefined();
  });

  it('reads the initiator off the abort reason: "model" settles stopped(model)', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort("model"), 200);
    const { settlement, journal } = await runLowered(HANG, { signal: controller.signal });
    expect(settlement).toEqual({ status: "stopped", reason: "model" });
    expect(journal.getRun("run")?.stopReason).toBe("model");
  });

  it('reads `{ superseded }` off the abort reason: settles stopped(superseded) with the successor', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort({ superseded: "run-next" }), 200);
    const { settlement, journal } = await runLowered(HANG, { signal: controller.signal });
    expect(settlement).toEqual({ status: "stopped", reason: "superseded", supersededBy: "run-next" });
    // 后继 id 与原因同一笔落库（docs/execution-engine.md「Amend-resume」）。
    expect(journal.getRun("run")).toMatchObject({
      status: "stopped",
      stopReason: "superseded",
      supersededBy: "run-next",
    });
    expect(journal.getRun("run")?.failure).toBeUndefined();
  });

  // 宿主 App 关闭时停下自己拥有的 run（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Engine ownership」规则二）：
  // run service 的 close() 以 "interrupted" abort 每个在飞条目，归一到与超时 / 沙箱崩溃同一族
  // 的 stopped(interrupted) + Interrupted——而不是 stopped(user)，那在 UI 上读作用户按了停止。
  it('reads "interrupted" off the abort reason: settles stopped(interrupted) with an Interrupted failure', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort("interrupted"), 200);
    const { settlement, journal } = await runLowered(HANG, { signal: controller.signal });
    expect(settlement.status).toBe("stopped");
    const stopped = settlement as Stopped;
    expect(stopped.reason).toBe("interrupted");
    expect(stopped.error).toBeInstanceOf(WorkflowError);
    expect(stopped.error?.code).toBe("Interrupted");
    // 文本指名 run 与成因：下一次激活时详情页据它解释这一行。
    expect(stopped.error?.message).toContain("run run was interrupted");
    expect(stopped.error?.message).toContain("the owning session closed");
    // 引擎自己写的那一笔：可 resume 的 stopped(interrupted) + failure_json。
    expect(journal.getRun("run")).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
    });
    expect(journal.getRun("run")?.failure?.code).toBe("Interrupted");
  });

  it("settles stopped(user) immediately when the signal is already aborted", async () => {
    const { settlement } = await runLowered(HANG, { signal: AbortSignal.abort() });
    expect(settlement).toEqual({ status: "stopped", reason: "user" });
  });
});

describe("failures — script error", () => {
  it("surfaces the script's thrown error as an errored run", async () => {
    const { settlement, journal } = await runLowered('throw new Error("boom from the script");');
    expect(settlement.status).toBe("errored");
    const error = (settlement as Errored).error;
    expect(error.code).toBe("DriverError");
    expect(error.message).toContain("boom from the script");
    expect(journal.getRun("run")?.status).toBe("errored");
    expect(journal.getRun("run")?.stopReason).toBeUndefined();
  });
});

describe("failures — malformed NDJSON from child", () => {
  it("surfaces a garbage line as interrupted rather than swallowing it", async () => {
    // 沙箱内经 cell 侧传输包装 __emitLine 直接吐一行非 JSON，模拟"子进程输出损坏"。
    const { settlement, journal } = await runLowered(
      '__emitLine("this is not json"); await new Promise(() => {});',
    );
    expect(settlement.status).toBe("stopped");
    const stopped = settlement as Stopped;
    expect(stopped.reason).toBe("interrupted");
    expect(stopped.error?.code).toBe("Interrupted");
    expect(stopped.error?.message).toContain("NDJSON");
    // 引擎裁决落 journal。
    expect(journal.getRun("run")).toMatchObject({ status: "stopped", stopReason: "interrupted" });
    expect(journal.getRun("run")?.failure?.code).toBe("Interrupted");
  });
});
