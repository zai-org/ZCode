// dwf run 冷回放的结算来源（docs/dynamic-workflow/presentation.md「Cold replay」）：
// 行是终态时，回放的尾部 `run-settled` 一律按行铸造——journal 里存着的那条（无论新旧词表）让位；
// 尾部没有结算（进程死亡 / 孤儿收敛只改行）时追加。
//
// 修复原因（2026-09-15，桌面实测）：2026-09-14 终态词表重构之前写下的 `run-settled` 带旧词
// cancelled / failed，事件载荷原样回放，reducer 认不出，run 被留在 running。这里用真实 SQLite
// journal 落下一模一样的字节（appendEvent 原样存 JSON），钉住回放 + reducer 之后 run 必须是终态。
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore, type DwfRunSessionListItem } from "@zcode/adapters/storage";
import type { JournalStorePort, RunEvent } from "@zcode/dynamic-workflow";
import { reduceWorkflowRunsState, type WorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import { toProgressPayload } from "../src/app/dynamic-workflow-run-launch.js";
import { replayRunProgress } from "../src/app/dynamic-workflow-run-replay.js";
import { mintActorSessionId } from "../src/app/workflow-driver.js";
import { resolveDynamicWorkflowJournalStore } from "../src/app/dynamic-workflow-run-service.js";

const PARENT = "sess_replay_parent";
// 冷回放的第三个参数：本进程的并发天花板，只落在 `run-started` 载荷上（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）。
// 这里的用例只看结算，取一个固定值即可；live 侧（toProgressPayload）传同一个值，逐字节契约才成立。
const CEILING = 6;

type Journal = JournalStorePort & {
  listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[];
};

let tempRoot: string;
let store: Awaited<ReturnType<typeof createSqliteSessionStore>>;
let journal: Journal;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-replay-"));
  store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
  const resolved = resolveDynamicWorkflowJournalStore(store as never);
  if (resolved === undefined) throw new Error("sqlite store must expose the dwf journal");
  journal = resolved as Journal;
});

afterEach(async () => {
  await store.close?.();
  await rm(tempRoot, { force: true, recursive: true });
});

function createRun(runId: string): void {
  journal.createRun({
    runId,
    parentSessionId: PARENT,
    cwd: "/repo",
    toolCallId: `call-${runId}`,
    scriptText: "const a = agent('a');",
    scriptHash: "sha-a",
    caps: { maxConcurrency: 4 },
    spentTokens: 0,
    status: "running",
  });
  journal.appendEvent(runId, {
    type: "run-started",
    runId,
    caps: { maxConcurrency: 4 },
  } as RunEvent);
  journal.appendEvent(runId, {
    type: "actor-created",
    actor: { siteId: "actor#1", ordinal: 1 },
    name: "a",
  } as RunEvent);
}

/** 旧词表的结算事件：`appendEvent` 原样存 JSON，落下的就是 2026-09-14 之前的字节。 */
function appendLegacySettle(runId: string, status: "cancelled" | "failed", error?: unknown): void {
  journal.appendEvent(runId, {
    type: "run-settled",
    status,
    ...(error === undefined ? {} : { error }),
  } as unknown as RunEvent);
}

function rowOf(runId: string): DwfRunSessionListItem {
  const row = journal.listRunsByParentSession(PARENT, 8).find((item) => item.runId === runId);
  if (row === undefined) throw new Error(`row missing for ${runId}`);
  return row;
}

function reduce(runId: string): WorkflowRunsState["runs"][number] {
  let state: WorkflowRunsState | undefined;
  for (const payload of replayRunProgress(rowOf(runId), journal, CEILING)) {
    state = reduceWorkflowRunsState(state, payload) ?? state;
  }
  const run = state?.runs.find((item) => item.runId === runId);
  if (run === undefined) throw new Error("run not projected");
  return run;
}

describe("replayRunProgress — 结算按行铸造", () => {
  it("旧词表 run-settled{cancelled}（行已译成 stopped）→ 回放尾部是行铸的 stopped，reducer 落终态且可恢复", () => {
    createRun("dwfrun-legacy-cancelled");
    appendLegacySettle("dwfrun-legacy-cancelled", "cancelled");
    journal.updateRunStatus("dwfrun-legacy-cancelled", "stopped", { stopReason: "user" });

    const payloads = replayRunProgress(rowOf("dwfrun-legacy-cancelled"), journal, CEILING);
    const stored = journal.listEvents("dwfrun-legacy-cancelled", {
      types: "all",
      reportItems: "all",
    });
    // 一进一出：存着的结算被替换，不是追加——条数与 journal 一致，水位沿用被替换那条的 sequence。
    expect(payloads).toHaveLength(stored.length);
    const last = payloads.at(-1);
    expect(last).toMatchObject({
      eventType: "run-settled",
      sequence: stored.at(-1)?.sequence,
      payload: { status: "stopped", stopReason: "user", resumable: true },
    });
    expect(
      payloads.some((payload) => (payload.payload as { status?: unknown }).status === "cancelled"),
    ).toBe(false);

    const run = reduce("dwfrun-legacy-cancelled");
    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("user");
    expect(run.resumable).toBe(true);
  });

  it("旧词表 run-settled{failed}（行是 errored）→ errored，失败文案来自行", () => {
    createRun("dwfrun-legacy-failed");
    appendLegacySettle("dwfrun-legacy-failed", "failed", { code: "DriverError", message: "boom" });
    journal.updateRunStatus("dwfrun-legacy-failed", "errored", {
      failure: { code: "DriverError", message: "boom" },
    });

    const run = reduce("dwfrun-legacy-failed");
    expect(run.status).toBe("errored");
    expect(run.error).toBe("boom");
    expect(run.resumable).toBeUndefined();
  });

  it("当前词表：行铸的结算与存着的那条逐字节相同（live 与冷回放同一份字节的契约不变）", () => {
    createRun("dwfrun-current");
    journal.updateRunStatus("dwfrun-current", "stopped", { stopReason: "model" });
    journal.appendEvent("dwfrun-current", {
      type: "run-settled",
      status: "stopped",
      stopReason: "model",
    } as RunEvent);

    const row = rowOf("dwfrun-current");
    const live = journal
      .listEvents("dwfrun-current", { types: "all", reportItems: "all" })
      .map((entry) =>
        toProgressPayload({
          event: entry.event,
          runId: row.runId,
          sequence: entry.sequence,
          toolCallId: row.toolCallId!,
          concurrencyCeiling: CEILING,
        }),
      );
    expect(JSON.stringify(replayRunProgress(row, journal, CEILING))).toBe(JSON.stringify(live));
  });

  it("行是终态而事件流没有结算（孤儿收敛只改了行）→ 追加一条 interrupted 结算，显式合成结算不推进真实水位", () => {
    createRun("dwfrun-orphan");
    journal.updateRunStatus("dwfrun-orphan", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owner exited" },
    });

    const stored = journal.listEvents("dwfrun-orphan", { types: "all", reportItems: "all" });
    const payloads = replayRunProgress(rowOf("dwfrun-orphan"), journal, CEILING);
    expect(payloads).toHaveLength(stored.length + 1);
    expect(payloads.at(-1)).toMatchObject({
      eventType: "run-settled",
      sequence: stored.at(-1)?.sequence ?? 0,
      syntheticSettlement: true,
      payload: { status: "stopped", stopReason: "interrupted", resumable: true },
    });
    expect(reduce("dwfrun-orphan").status).toBe("stopped");
  });

  it("中途的上一世结算（cancel → resume）原样保留，只替换尾部那条", () => {
    createRun("dwfrun-resumed");
    appendLegacySettle("dwfrun-resumed", "cancelled");
    journal.appendEvent("dwfrun-resumed", {
      type: "run-started",
      runId: "dwfrun-resumed",
      caps: { maxConcurrency: 4 },
    } as RunEvent);
    journal.updateRunStatus("dwfrun-resumed", "completed");
    journal.appendEvent("dwfrun-resumed", { type: "run-settled", status: "completed" } as RunEvent);

    const payloads = replayRunProgress(rowOf("dwfrun-resumed"), journal, CEILING);
    const settles = payloads.filter((payload) => payload.eventType === "run-settled");
    expect(settles.map((payload) => (payload.payload as { status: string }).status)).toEqual([
      "cancelled",
      "completed",
    ]);
    expect(reduce("dwfrun-resumed").status).toBe("completed");
  });

  // ── 本 run 的子代理模型（docs/dynamic-workflow/launch.md）───────────────────
  // 它与发起锚点同住 `run-launched`（零 SQL，dwf_run 上没有这一列）：live 侧从 launch 入参拿到
  // 规范串并挂在 `run-started` 载荷上，冷回放从同一条事件读回。两侧必须给出同一个键，
  // 否则重启前后的投影就不再逐字节一致。
  it("run-launched 上的 subagentModel 进 run-started 载荷；冷回放与 live 逐字节相等", () => {
    const SUBAGENT = "zhipu/glm-5.3-flash$high";
    createRun("dwfrun-subagent");
    journal.appendEvent("dwfrun-subagent", {
      type: "run-launched",
      inputId: "input-origin",
      subagentModel: SUBAGENT,
    } as RunEvent);
    journal.updateRunStatus("dwfrun-subagent", "completed");
    journal.appendEvent("dwfrun-subagent", {
      type: "run-settled",
      status: "completed",
    } as RunEvent);

    const row = rowOf("dwfrun-subagent");
    const payloads = replayRunProgress(row, journal, CEILING);
    const started = payloads.find((payload) => payload.eventType === "run-started");
    expect(started?.payload).toMatchObject({
      subagentModel: SUBAGENT,
      concurrencyCeiling: CEILING,
    });
    // 派生字段只挂在 run-started 上：其余事件带着它只会让每一条载荷都重复同一条 run 级事实。
    // `run-launched` 自己不算——那条载荷是事件的原样内容，模型串本来就写在里面。
    for (const payload of payloads) {
      if (payload.eventType === "run-started" || payload.eventType === "run-launched") continue;
      expect("subagentModel" in payload.payload).toBe(false);
    }

    // live 侧同一条铸造链、同一个值 → 逐字节相等（本模块唯一的契约）。
    const live = journal
      .listEvents("dwfrun-subagent", { types: "all", reportItems: "all" })
      .map((entry) =>
        toProgressPayload({
          event: entry.event,
          runId: row.runId,
          sequence: entry.sequence,
          toolCallId: row.toolCallId!,
          launchInputId: "input-origin",
          concurrencyCeiling: CEILING,
          subagentModel: SUBAGENT,
        }),
      );
    expect(JSON.stringify(payloads)).toBe(JSON.stringify(live));
  });

  it("run-launched 没带子代理模型：run-started 载荷整个不带这个键", () => {
    createRun("dwfrun-no-subagent");
    journal.appendEvent("dwfrun-no-subagent", {
      type: "run-launched",
      inputId: "input-origin",
    } as RunEvent);
    const started = replayRunProgress(rowOf("dwfrun-no-subagent"), journal, CEILING).find(
      (payload) => payload.eventType === "run-started",
    );
    // 缺席而不是空串：读侧据此判断这个 run 有没有设过子代理模型。
    expect("subagentModel" in started!.payload).toBe(false);
  });

  // ── 脚本点名的模型（docs/dynamic-workflow/launch.md「Models the script names」）──────────
  // 绑定表同住 `run-launched`；actor-created 的派生 `model` 据它把 persona 的名字映射成规范串。
  // 冷回放从同一条事件读回同一张表，两侧载荷逐字节相等。
  it("actor-created 载荷的派生 model 来自 run-launched 的绑定表；冷回放与 live 逐字节相等", () => {
    const BINDINGS = { "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash" };
    createRun("dwfrun-bindings");
    journal.appendEvent("dwfrun-bindings", {
      type: "run-launched",
      inputId: "input-origin",
      modelBindings: BINDINGS,
    } as RunEvent);
    journal.appendEvent("dwfrun-bindings", {
      type: "actor-created",
      actor: { siteId: "actor#7", ordinal: 1 },
      name: "评审员",
      persona: { name: "评审员", model: "GLM-5.3-Flash" },
    } as RunEvent);
    journal.appendEvent("dwfrun-bindings", {
      type: "actor-created",
      actor: { siteId: "actor#8", ordinal: 1 },
      name: "旁观者",
      persona: { name: "旁观者" },
    } as RunEvent);

    const row = rowOf("dwfrun-bindings");
    const payloads = replayRunProgress(row, journal, CEILING);
    // createRun 自己也建了一个子代理（无模型）；这里只看本用例加的两个。
    const created = payloads.filter(
      (payload) =>
        payload.eventType === "actor-created" &&
        ["评审员", "旁观者"].includes(String(payload.payload.name)),
    );
    expect(created[0]?.payload).toMatchObject({ model: "zhipu/GLM-5.3-Flash" });
    expect("model" in created[1]!.payload).toBe(false);

    const live = journal
      .listEvents("dwfrun-bindings", { types: "all", reportItems: "all" })
      .map((entry) =>
        toProgressPayload({
          event: entry.event,
          runId: row.runId,
          sequence: entry.sequence,
          toolCallId: row.toolCallId!,
          launchInputId: "input-origin",
          concurrencyCeiling: CEILING,
          modelBindings: BINDINGS,
        }),
      );
    expect(JSON.stringify(payloads)).toBe(JSON.stringify(live));
  });

  // ── ask 的 node-dispatched（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Events」）─────
  // 它重复实例的出生事实并点名子代理，所以与 actor-created 一样在接缝上补 `actorSessionId`。
  // 冷回放走的是同一条铸造链，envelope 必须一字不差——否则重启前后投影就能收不同的实例进表。
  it("ask 的 node-dispatched 带出生事实与 actorSessionId；冷回放与 live 逐字节相等", () => {
    const actor = { siteId: "actor#1", ordinal: 1 };
    createRun("dwfrun-dispatch");
    journal.appendEvent("dwfrun-dispatch", {
      type: "node-dispatched",
      instance: { siteId: "ask#1", ordinal: 1 },
      kind: "ask",
      actor,
      actorName: "planner",
      actorPhaseName: "Prepare",
      phaseName: "Work",
      instructionsHead: "写一份调研大纲",
    } as RunEvent);
    // 同一条 journal 上的 world-read 派发：没有 actor，就不该长出会话 id。
    journal.appendEvent("dwfrun-dispatch", {
      type: "node-dispatched",
      instance: { siteId: "world-read#1", ordinal: 1 },
    } as RunEvent);

    const row = rowOf("dwfrun-dispatch");
    const payloads = replayRunProgress(row, journal, CEILING);
    const [ask, world] = payloads.filter((payload) => payload.eventType === "node-dispatched");
    expect(ask).toMatchObject({
      actorSessionId: mintActorSessionId("dwfrun-dispatch", actor),
      payload: {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor,
        actorName: "planner",
        actorPhaseName: "Prepare",
        phaseName: "Work",
        instructionsHead: "写一份调研大纲",
      },
    });
    // 铸的是与 actor-created 同一个 id：两条事件说的是同一个子代理的同一份转录。
    const created = payloads.find((payload) => payload.eventType === "actor-created");
    expect(ask?.actorSessionId).toBe(created?.actorSessionId);
    expect(world).toMatchObject({ payload: { instance: { siteId: "world-read#1", ordinal: 1 } } });
    expect("actorSessionId" in world!).toBe(false);

    const live = journal
      .listEvents("dwfrun-dispatch", { types: "all", reportItems: "all" })
      .map((entry) =>
        toProgressPayload({
          event: entry.event,
          runId: row.runId,
          sequence: entry.sequence,
          toolCallId: row.toolCallId!,
          concurrencyCeiling: CEILING,
        }),
      );
    expect(JSON.stringify(payloads)).toBe(JSON.stringify(live));
  });

  it("ask 的缓存结算带出生事实与 actorSessionId；world 与 live 的结算不补；冷回放与 live 逐字节相等", () => {
    const actor = { siteId: "actor#1", ordinal: 1 };
    createRun("dwfrun-cached");
    // 导入命中：答案读自前驱的会话。
    journal.appendEvent("dwfrun-cached", {
      type: "node-settled",
      instance: { siteId: "ask#1", ordinal: 1 },
      outcome: "ok",
      cached: true,
      kind: "ask",
      actor,
      actorSeq: 0,
      instructionsHead: "调研",
      sourceSessionId: "sess-predecessor",
    } as RunEvent);
    // 重放命中：答案是本 run 自己跑出来的。
    journal.appendEvent("dwfrun-cached", {
      type: "node-settled",
      instance: { siteId: "ask#2", ordinal: 1 },
      outcome: "ok",
      cached: true,
      kind: "ask",
      actor,
      actorSeq: 1,
    } as RunEvent);
    // 没有子代理的两条：world-read 的缓存结算，以及 live 的结算（不是出生事件，不点名子代理）。
    journal.appendEvent("dwfrun-cached", {
      type: "node-settled",
      instance: { siteId: "world-read#1", ordinal: 1 },
      outcome: "ok",
      cached: true,
    } as RunEvent);
    journal.appendEvent("dwfrun-cached", {
      type: "node-settled",
      instance: { siteId: "ask#3", ordinal: 1 },
      outcome: "ok",
    } as RunEvent);

    const row = rowOf("dwfrun-cached");
    const payloads = replayRunProgress(row, journal, CEILING);
    const settles = payloads.filter((payload) => payload.eventType === "node-settled");
    const own = mintActorSessionId("dwfrun-cached", actor);
    expect(settles.map((payload) => payload.actorSessionId)).toEqual([
      own,
      own,
      undefined,
      undefined,
    ]);
    // 载荷原样：前驱会话留在载荷里（引擎发了什么），派生字段在载荷之外。
    expect(settles[0]).toMatchObject({
      payload: { kind: "ask", actor, actorSeq: 0, sourceSessionId: "sess-predecessor" },
    });
    expect("actorSessionId" in settles[2]!).toBe(false);
    expect("actorSessionId" in settles[3]!).toBe(false);

    const live = journal
      .listEvents("dwfrun-cached", { types: "all", reportItems: "all" })
      .map((entry) =>
        toProgressPayload({
          event: entry.event,
          runId: row.runId,
          sequence: entry.sequence,
          toolCallId: row.toolCallId!,
          concurrencyCeiling: CEILING,
        }),
      );
    expect(JSON.stringify(payloads)).toBe(JSON.stringify(live));

    // 归约面：两条缓存结算都归到子代理名下；最后一条是本 run 的重放命中，sessionId 指回本 run。
    const run = reduce("dwfrun-cached");
    expect(
      run.nodes.filter((node) => node.actorSiteId === "actor#1").map((node) => node.siteId),
    ).toEqual(["ask#1", "ask#2"]);
    expect(run.actors[0]?.sessionId).toBe(own);
  });

  it("行不是终态（本会话真在飞的 run 由调用方排除；这里是另一进程的）→ 事件原样回放，不追加结算", () => {
    createRun("dwfrun-live");
    const stored = journal.listEvents("dwfrun-live", { types: "all", reportItems: "all" });
    const payloads = replayRunProgress(rowOf("dwfrun-live"), journal, CEILING);
    expect(payloads).toHaveLength(stored.length);
    expect(payloads.some((payload) => payload.eventType === "run-settled")).toBe(false);
    expect(reduce("dwfrun-live").status).toBe("running");
  });
});

it("孤儿行合成结算不占用恢复启动序号，恢复后停止控制可用且成功只计一次", () => {
  const runId = "orphan-resume";
  createRun(runId);
  journal.updateRunStatus(runId, "stopped", { stopReason: "interrupted" });
  const projection = new ProductProjection(PARENT, "epoch");
  let seq = 0;
  const emit = (payload: ReturnType<typeof replayRunProgress>[number]) => {
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: PARENT,
      sequenceNumber: seq,
      timestamp: new Date(),
      traceId: "trace",
      type: SessionEventType.DynamicWorkflowRunProgress,
      payload,
    } as SessionEvent);
  };
  const coldPayloads = replayRunProgress(rowOf(runId), journal, CEILING);
  for (const payload of coldPayloads) emit(payload);
  expect(projection.getSnapshot().workflowRuns?.runs[0]?.status).toBe("stopped");
  const started = journal.appendEvent(runId, {
    type: "run-started",
    runId,
    caps: { maxConcurrency: 4 },
  } as RunEvent);
  emit(
    toProgressPayload({
      event: started.event,
      runId,
      sequence: started.sequence,
      concurrencyCeiling: CEILING,
    }),
  );
  // stop control 由运行态派生；下一条引擎事件尚未发生时必须已恢复运行态。
  // 迟到的旧合成停止也不能覆盖已经恢复的真实运行态。
  emit(coldPayloads.at(-1)!);
  expect(projection.getSnapshot().workflowRuns?.runs[0]?.status).toBe("running");
  expect(projection.getSnapshot().completedActivityCount).toBe(0);
  const settled = journal.appendEvent(runId, {
    type: "run-settled",
    status: "completed",
  } as RunEvent);
  const payload = toProgressPayload({
    event: settled.event,
    runId,
    sequence: settled.sequence,
    concurrencyCeiling: CEILING,
  });
  emit(payload);
  emit(payload);
  expect(projection.getSnapshot().completedActivityCount).toBe(1);
});
