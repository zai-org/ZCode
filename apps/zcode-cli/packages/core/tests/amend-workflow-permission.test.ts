import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CoreErrorType,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type CollaborationMode,
  type CreateWorkflowOutput,
  type DynamicWorkflowRunAmendRequest,
  type DynamicWorkflowRunAmendResult,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunRetuneRequest,
  type DynamicWorkflowRunRetuneResult,
  type DynamicWorkflowRunSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPort,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionRequestedPayload,
  type SessionEvent,
  type ToolExecutionResult,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { amendWorkflowToolEntry } from "../src/tool/handlers/amend-workflow.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { AMEND_WORKFLOW_ERROR_CODE } from "../src/tool/handlers/amend-workflow-resolve.js";
import { workflowRunNotFoundFailure } from "../src/tool/handlers/workflow-run-introspection.js";

// docs/dynamic-workflow/launch.md「The `AmendWorkflow` tool」与「Amending this session's runs」：
// resolveInput 把 run_id 解析成 predecessor 事实块 → 权限服务据它放行本会话的 run / 照常 ask 别的
// → handler 调 port.amend（service 负责停在飞前驱、等结算、导入、启动）。

function cleanScript(actor: string): string {
  return [
    "interface R { done: boolean }",
    `const r = await agent("${actor}").ask<R>("do");`,
    "return r.done;",
  ].join("\n");
}

/** 分析器语料里的脚本（与 create-workflow-tool.test.ts 同一份 corpus、同一条读法）。 */
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../dynamic-workflow/tests/graphs/${name}`, import.meta.url),
    "utf8",
  );
}

const BROKEN_SCRIPT = 'const x: number = "s";';

// 真目录而不是一个写死的 /tmp 路径：内联修订会往 `<cwd>/.zcode/workflow-drafts/` 写草稿
// （docs/dynamic-workflow/launch.md「Script files」），用例之间不该互相看见对方的草稿。
const AMEND_CWD = mkdtempSync(join(tmpdir(), "dwf-amend-cwd-"));
afterAll(() => {
  rmSync(AMEND_CWD, { force: true, recursive: true });
});

/** 本会话的 id 由用例名派生（run() 里同一条派生），所以「归属」在这里可控。 */
function sessionOf(name: string): string {
  return createSessionId(name) as unknown as string;
}

interface StubPortOptions {
  /** getTask 的答案：缺席即「run 不存在」。 */
  snapshot?: Partial<DynamicWorkflowRunSnapshot>;
  /** amend 的答案；缺省成功铸 `dwfrun-amended`。 */
  amend?: DynamicWorkflowRunAmendResult;
  /** 默认并发 D；缺席即端口没有 `defaultConcurrency`（老宿主的形状）。 */
  defaultConcurrency?: number;
  /**
   * 前驱存档的脚本，即 `getScript` 的答案（docs/dynamic-workflow/launch.md「Keeping the
   * predecessor's script」）。缺席即端口**没有** `getScript`（老宿主的形状）；`null` 即方法在、
   * 记录里却没有脚本（脚本落库之前的老 run）。
   */
  storedScript?: string | null;
  /**
   * `retuneConcurrency` 的答复（docs/dynamic-workflow/launch.md「Changing only the parallelism of a
   * live run」）。缺席即端口**没有**这个方法（老宿主的形状）——那时只改并发的调用照旧走修订。
   */
  retune?:
    | DynamicWorkflowRunRetuneResult
    | ((request: DynamicWorkflowRunRetuneRequest) => DynamicWorkflowRunRetuneResult);
}

function stubRunPort(options: StubPortOptions = {}): {
  port: DynamicWorkflowRunPort;
  amends: DynamicWorkflowRunAmendRequest[];
  getTaskCalls: string[];
  getScriptCalls: string[];
  retunes: DynamicWorkflowRunRetuneRequest[];
} {
  const amends: DynamicWorkflowRunAmendRequest[] = [];
  const getTaskCalls: string[] = [];
  const getScriptCalls: string[] = [];
  const retunes: DynamicWorkflowRunRetuneRequest[] = [];
  const unreachable = (name: string) => () => {
    throw new Error(`stubRunPort.${name} 不应被 AmendWorkflow 触及`);
  };
  return {
    port: {
      async getTask(taskId: string) {
        getTaskCalls.push(taskId);
        if (options.snapshot === undefined) return undefined;
        // 只给基类字段；`runStatus` 由用例决定——缺席即「还在跑」（resolveInput 据此读作 running）。
        return {
          runId: taskId,
          taskId,
          startedAt: new Date(0),
          status: "running",
          ...options.snapshot,
        } as DynamicWorkflowRunSnapshot;
      },
      async amend(request) {
        amends.push(request);
        return options.amend ?? { ok: true, runId: "dwfrun-amended" };
      },
      ...(options.defaultConcurrency === undefined
        ? {}
        : { defaultConcurrency: () => options.defaultConcurrency as number }),
      ...(options.storedScript === undefined
        ? {}
        : {
            async getScript(runId: string) {
              getScriptCalls.push(runId);
              return options.storedScript ?? undefined;
            },
          }),
      ...(options.retune === undefined
        ? {}
        : {
            async retuneConcurrency(request: DynamicWorkflowRunRetuneRequest) {
              retunes.push(request);
              return typeof options.retune === "function"
                ? options.retune(request)
                : (options.retune as DynamicWorkflowRunRetuneResult);
            },
          }),
      submit: unreachable("submit"),
      waitForTask: unreachable("waitForTask"),
      cancel: unreachable("cancel"),
      listEvents: unreachable("listEvents"),
    } as unknown as DynamicWorkflowRunPort,
    amends,
    getTaskCalls,
    getScriptCalls,
    retunes,
  };
}

interface RunOptions {
  broker?: PermissionBrokerPort;
  input?: Record<string, unknown>;
  /** 宿主的模型目录；缺席即「这台机器不能选子代理模型」。 */
  modelCatalogPort?: ModelCatalogPort;
  mode?: CollaborationMode;
  name: string;
  port?: DynamicWorkflowRunPort;
  runId?: string;
  script?: string;
}

interface RunOutcome {
  brokerRequests: PermissionBrokerRequest[];
  permissionRequested: PermissionRequestedPayload[];
  result: ToolExecutionResult;
}

async function run(options: RunOptions): Promise<RunOutcome> {
  const sessionId = createSessionId(options.name);
  const turnId = createTurnId(options.name);
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const events: SessionEvent[] = [];
  const brokerRequests: PermissionBrokerRequest[] = [];
  const permissionBroker: PermissionBrokerPort = {
    async requestPermission(request, requestOptions) {
      brokerRequests.push(request);
      return (
        options.broker?.requestPermission(request, requestOptions) ?? { decision: "allow" as const }
      );
    },
  };
  const registry = createToolRegistry();
  registry.register(amendWorkflowToolEntry);
  const executor = createToolExecutor({
    emitEvent: async (event) => {
      events.push(event);
    },
    ...(options.port ? { dynamicWorkflowRunPort: options.port } : {}),
    ...(options.modelCatalogPort ? { modelCatalogPort: options.modelCatalogPort } : {}),
    mode: options.mode ?? "build",
    permissionBroker,
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    turnId,
    traceContext,
    workingDirectory: AMEND_CWD,
  });
  const result = await executor.execute(
    {
      id: createToolCallId(options.name),
      input: options.input ?? {
        run_id: options.runId ?? "dwfrun-prev",
        script: options.script ?? cleanScript(options.name),
      },
      name: "AmendWorkflow",
    },
    { traceContext },
  );
  return {
    brokerRequests,
    permissionRequested: events
      .filter((event) => event.type === SessionEventType.PermissionRequested)
      .map((event) => event.payload as PermissionRequestedPayload),
    result,
  };
}

describe("AmendWorkflow — owner rule", () => {
  it("amends a settled run this session started without a window, naming both runs", async () => {
    const name = "amend-owned-settled";
    const { port, amends, getTaskCalls } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), runStatus: "errored", status: "failed" },
    });
    const outcome = await run({ name, port });

    // 第一次 getTask 是 resolveInput 解析前驱；之后的是后台追踪器轮询新 run（与 CreateWorkflow 同）。
    expect(getTaskCalls[0]).toBe("dwfrun-prev");
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.brokerRequests).toHaveLength(0);
    expect(outcome.result.success).toBe(true);
    expect(amends).toHaveLength(1);
    expect(amends[0]).toMatchObject({
      cwd: AMEND_CWD,
      predecessorRunId: "dwfrun-prev",
      parentSessionId: sessionOf(name),
    });
    expect("name" in amends[0]!).toBe(false);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.status).toBe("backgrounded");
    expect(output.backgroundTaskId).toBe("dwfrun-amended");
    expect(output.response).toContain("dwfrun-prev had already settled");
    expect(output.response).toContain("run dwfrun-amended");
    expect(output.response).toContain("Do not wait for it");
  });

  it("amends a RUNNING run this session started without a window and reports the supersede", async () => {
    const name = "amend-owned-running";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), status: "running" },
      amend: { ok: true, runId: "dwfrun-next", supersededRunId: "dwfrun-prev" },
    });
    const outcome = await run({ name, port, mode: "plan" });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(1);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.backgroundTaskId).toBe("dwfrun-next");
    expect(output.response).toContain("dwfrun-prev was still running");
    expect(output.response).toContain("stopped and superseded");
    expect(output.response).toContain("will not send a notification of its own");
  });

  // 轨道画的是**新脚本**的站点：修订沿用前驱的锚点，两张表却必须一起从新脚本的图上取。
  it("passes the new script's phase table and its alongside table through", async () => {
    const name = "amend-alongside";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), status: "completed", runStatus: "completed" },
    });
    await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", script: fixture("strand-fanout-two-phases-join.ts") },
    });
    expect(amends).toHaveLength(1);
    expect(amends[0]!.phaseNames).toEqual(["A", "B", "C"]);
    expect(amends[0]!.phaseAlongside).toEqual([[], [0], []]);
  });

  it("passes the optional display name through", async () => {
    const name = "amend-owned-named";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), status: "completed", runStatus: "completed" },
    });
    await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", script: cleanScript(name), name: "second pass" },
    });
    expect(amends[0]?.name).toBe("second pass");
  });

  // 别的进程的在飞 run：批准之后导入缓存也必败（前驱未结算），所以窗不能开（launch.md「Amending」）。
  it("refuses a run live in another process before any window", async () => {
    const name = "amend-other-process";
    const { port, amends } = stubRunPort({
      snapshot: {
        parentSessionId: "sess_someone-else",
        status: "running",
        liveInThisProcess: false,
      },
    });
    const outcome = await run({ name, port });
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message).toContain("workflow_run_held_elsewhere");
    expect(amends).toHaveLength(0);
  });

  it("asks for another session's run, with the create_workflow graph and the predecessor facts in the input", async () => {
    const name = "amend-foreign";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "running", name: "triage" },
    });
    const outcome = await run({ name, port });

    expect(outcome.permissionRequested).toHaveLength(1);
    const payload = outcome.permissionRequested[0]!;
    expect(payload.toolName).toBe("AmendWorkflow");
    expect(payload.optionsPolicy).toBe("session-always-allow");
    expect(payload.display?.kind).toBe("create_workflow");
    expect(
      (payload.display as { causalityGraph?: { steps: unknown[] } }).causalityGraph?.steps,
    ).toHaveLength(1);
    // 确认窗从**入参**读 lineage 行与「仍在运行」的注记（协议零新载荷）。
    expect(payload.input).toMatchObject({
      run_id: "dwfrun-prev",
      predecessor: { name: "triage", status: "running", owned_by_this_session: false },
    });
    // Allow → amend 照常。
    expect(amends).toHaveLength(1);
  });

  it("asks again for an own run the user stopped", async () => {
    const name = "amend-user-stopped";
    const { port } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf(name),
        status: "cancelled",
        runStatus: "stopped",
        stopReason: "user",
      },
    });
    const outcome = await run({ name, port });
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.permissionRequested[0]?.input).toMatchObject({
      predecessor: { status: "stopped", stop_reason: "user", owned_by_this_session: true },
    });
  });

  it("Deny leaves the predecessor untouched", async () => {
    const name = "amend-deny";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: "sess_other", status: "completed", runStatus: "completed" },
    });
    const outcome = await run({
      name,
      port,
      broker: {
        async requestPermission() {
          return { decision: "deny", reason: "User declined" };
        },
      },
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.type).toBe("permission_denied");
    expect(amends).toHaveLength(0);
  });

  it("overwrites a predecessor block the model tries to supply", async () => {
    // 模型面 JSON schema 不列 predecessor（strict），所以带它的入参在 schema 校验就被拒——
    // 伪造「本会话的 run」拿不到免确认。
    const name = "amend-forged";
    const { port, amends, getTaskCalls } = stubRunPort({ snapshot: { parentSessionId: "x" } });
    const outcome = await run({
      name,
      port,
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript(name),
        predecessor: { status: "completed", owned_by_this_session: true },
      },
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(getTaskCalls).toHaveLength(0);
    expect(amends).toHaveLength(0);
  });
});

describe("AmendWorkflow — refusals and failures", () => {
  it("an unknown run is refused at resolveInput: no window, no amend, the shared run_not_found key", async () => {
    const { port, amends } = stubRunPort();
    const outcome = await run({ name: "amend-unknown", port });

    expect(outcome.result.success).toBe(false);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith(workflowRunNotFoundFailure("dwfrun-prev").message)).toBe(true);
    expect(message).toContain("Nothing was stopped or created");
    expect(message).toContain("run_id");
  });

  it.each(["run_not_found", "missing_boundaries", "teapot"] as const)(
    "maps the port's %s refusal to an actionable structured failure",
    async (reason) => {
      const name = `amend-refused-${reason}`;
      const { port } = stubRunPort({
        snapshot: { parentSessionId: sessionOf(name), status: "completed", runStatus: "completed" },
        amend: { ok: false, reason: reason as "run_not_found" },
      });
      const outcome = await run({ name, port });
      expect(outcome.result.success).toBe(false);
      const message = String(outcome.result.error?.message ?? "");
      if (reason === "run_not_found") {
        expect(message.startsWith("run_not_found:")).toBe(true);
      } else if (reason === "missing_boundaries") {
        expect(message.startsWith("workflow_amend_missing_boundaries:")).toBe(true);
        expect(message).toMatch(/fresh CreateWorkflow/u);
      } else {
        expect(message.startsWith("workflow_amend_refused:")).toBe(true);
        expect(message).toContain("teapot");
      }
      expect(message).toContain("dwfrun-prev");
      expect(message).toMatch(/nothing was stopped or created/iu);
    },
  );

  it("a script that does not compile never asks and never touches the predecessor", async () => {
    const name = "amend-broken";
    const { port, amends } = stubRunPort({ snapshot: { parentSessionId: "sess_other" } });
    const outcome = await run({ name, port, script: BROKEN_SCRIPT });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(0);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(false);
    expect(output.diagnostics.length).toBeGreaterThan(0);
    expect(output.response).toContain("Run dwfrun-prev was not touched");
  });

  it("without a run port the script is only typechecked", async () => {
    const outcome = await run({ name: "amend-no-port" });
    // 端口缺席：resolveInput 放行、权限照常 ask（没有归属事实）、handler 只报编译通过。
    expect(outcome.permissionRequested).toHaveLength(1);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(true);
    expect(output.backgroundTaskId).toBeUndefined();
    expect(output.response).toContain("NOT executed");
  });
});

// 并发上界的三态（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）：省略 = 沿用前驱、
// `null` = 解除、数 = 设定。三态只活到 resolveInput——handler 与确认窗此后只面对「一个数或没有」，
// 而 handler 自己会用 .strict() 重新 parse 一遍归一化后的入参，所以形状越界在这些用例里必炸。
describe("AmendWorkflow — max_concurrency", () => {
  /** 归一化后递到端口的那个数；键缺席即 undefined。 */
  async function amendWith(
    name: string,
    options: { defaultConcurrency?: number; inherited?: number; requested?: number | null },
  ): Promise<{ amends: DynamicWorkflowRunAmendRequest[]; outcome: RunOutcome }> {
    const { port, amends } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf(name),
        status: "completed",
        runStatus: "completed",
        ...(options.inherited === undefined ? {} : { maxConcurrency: options.inherited }),
      },
      ...(options.defaultConcurrency === undefined
        ? {}
        : { defaultConcurrency: options.defaultConcurrency }),
    });
    const outcome = await run({
      name,
      port,
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript(name),
        ...(options.requested === undefined ? {} : { max_concurrency: options.requested }),
      },
    });
    return { amends, outcome };
  }

  it("a number above the default goes through unclamped and is named in the result", async () => {
    const { amends, outcome } = await amendWith("amend-maxconc-raised", {
      defaultConcurrency: 8,
      requested: 32,
    });
    expect(amends[0]?.maxConcurrency).toBe(32);
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "At most 32 subagents run at once.",
    );
  });

  it("a number equal to the default is named as the default", async () => {
    const { amends, outcome } = await amendWith("amend-maxconc-at-default", {
      defaultConcurrency: 8,
      requested: 8,
    });
    expect(amends[0]?.maxConcurrency).toBe(8);
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "At most 8 subagents run at once (the default).",
    );
  });

  it("a number under the default goes through unchanged", async () => {
    const { amends, outcome } = await amendWith("amend-maxconc-set", {
      defaultConcurrency: 8,
      requested: 2,
    });
    expect(amends[0]?.maxConcurrency).toBe(2);
    const response = (outcome.result.output as CreateWorkflowOutput).response;
    expect(response).toContain("At most 2 subagents run at once.");
    expect(response).not.toContain("(the default)");
  });

  it("null removes the predecessor's limit: the key is gone, not zeroed", async () => {
    const { amends, outcome } = await amendWith("amend-maxconc-null", {
      defaultConcurrency: 8,
      inherited: 2,
      requested: null,
    });
    expect(amends).toHaveLength(1);
    expect("maxConcurrency" in amends[0]!).toBe(false);
    expect((outcome.result.output as CreateWorkflowOutput).response).not.toContain("At most");
  });

  it("omitting the field inherits the predecessor's limit", async () => {
    const { amends, outcome } = await amendWith("amend-maxconc-inherit", {
      defaultConcurrency: 8,
      inherited: 2,
    });
    expect(amends[0]?.maxConcurrency).toBe(2);
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "At most 2 subagents run at once.",
    );
  });

  it("omitting the field inherits a raised predecessor's limit as is", async () => {
    // 快照只在不等于默认时带 maxConcurrency：一个被调高过的前驱把它的数原样传下去，不再被钳。
    const { amends } = await amendWith("amend-maxconc-inherit-raised", {
      defaultConcurrency: 8,
      inherited: 40,
    });
    expect(amends[0]?.maxConcurrency).toBe(40);
  });

  it("omitting it stays absent when the predecessor ran at the default", async () => {
    // 快照只在不等于默认时带 maxConcurrency，所以「前驱没设过」在这里就是字段缺席。
    const { amends } = await amendWith("amend-maxconc-none", { defaultConcurrency: 8 });
    expect(amends).toHaveLength(1);
    expect("maxConcurrency" in amends[0]!).toBe(false);
  });

  it("shows the inherited limit in the confirmation window of another session's run", async () => {
    // 确认窗读的是归一化后的入参：沿用下来的上界必须在那里，否则用户批准的是另一个 run。
    const { port } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "running", maxConcurrency: 2 },
      defaultConcurrency: 8,
    });
    const outcome = await run({
      name: "amend-maxconc-window",
      port,
      input: { run_id: "dwfrun-prev", script: cleanScript("amend-maxconc-window") },
    });
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.permissionRequested[0]!.input).toMatchObject({ max_concurrency: 2 });
  });

  it("strips null and passes a number through when the session has no run port", async () => {
    // 端口缺席：既没有前驱也没有默认并发，三态塌成「一个数或没有」，且归一化后的入参仍要
    // 过得了 handler 的 .strict() 重解析。
    const removed = await run({
      name: "amend-maxconc-no-port-null",
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript("amend-maxconc-no-port-null"),
        max_concurrency: null,
      },
    });
    expect(removed.result.success).toBe(true);
    expect(removed.permissionRequested[0]!.input).not.toHaveProperty("max_concurrency");

    const kept = await run({
      name: "amend-maxconc-no-port-number",
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript("amend-maxconc-no-port-number"),
        max_concurrency: 4,
      },
    });
    expect(kept.permissionRequested[0]!.input).toMatchObject({ max_concurrency: 4 });
  });
});

// 子代理模型的三态（docs/dynamic-workflow/launch.md）：省略 = 沿用前驱、`null` = 回到会话模型、
// 字符串 = 设定。与并发上界逐条同构，唯一的差别是**沿用的那一个也要重新解析一遍**——前驱可能
// 是几天前起的，它选的模型此后可能被删掉或停用。
describe("AmendWorkflow — subagent_model", () => {
  function entry(
    providerId: string,
    modelId: string,
    extra: Partial<ModelCatalogEntry> = {},
  ): ModelCatalogEntry {
    return { providerId, modelId, reasoningLevels: [], current: false, ...extra };
  }

  const CATALOG: ModelCatalogPort = {
    listModels: () => [entry("bigmodel", "GLM-4.6", { current: true }), entry("openai", "gpt-5")],
  };

  /** 目录里只剩一个模型：前驱选过的那一个已经不在了。 */
  const SHRUNK_CATALOG: ModelCatalogPort = {
    listModels: () => [entry("openai", "gpt-5", { current: true })],
  };

  async function amendWith(
    name: string,
    options: {
      catalog?: ModelCatalogPort;
      inherited?: string;
      requested?: string | null;
    },
  ): Promise<{ amends: DynamicWorkflowRunAmendRequest[]; outcome: RunOutcome }> {
    const { port, amends } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf(name),
        status: "completed",
        runStatus: "completed",
        ...(options.inherited === undefined ? {} : { subagentModel: options.inherited }),
      },
    });
    const outcome = await run({
      name,
      port,
      ...(options.catalog === undefined ? {} : { modelCatalogPort: options.catalog }),
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript(name),
        ...(options.requested === undefined ? {} : { subagent_model: options.requested }),
      },
    });
    return { amends, outcome };
  }

  it("a model id is resolved to its canonical form and named in the result", async () => {
    const { amends, outcome } = await amendWith("amend-model-set", {
      catalog: CATALOG,
      // 全称：`gpt-5` 不在会话的 provider（bigmodel）下，裸名会被 provider 边界挡回。
      requested: "openai/gpt-5",
    });
    // 换到前驱没用过的 provider：本会话的 run 也要开窗（下一组用例），桩 broker 默认 Allow。
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(amends[0]?.subagentModel).toEqual({ providerId: "openai", modelId: "gpt-5" });
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "Subagents run on openai/gpt-5 (the main agent stays on the session model).",
    );
  });

  it("null puts the subagents back on the session model: the key is gone, not blanked", async () => {
    const { amends, outcome } = await amendWith("amend-model-null", {
      catalog: CATALOG,
      inherited: "bigmodel/GLM-4.6",
      requested: null,
    });
    expect(amends).toHaveLength(1);
    expect("subagentModel" in amends[0]!).toBe(false);
    expect((outcome.result.output as CreateWorkflowOutput).response).not.toContain(
      "Subagents run on",
    );
  });

  it("omitting the field inherits the predecessor's model", async () => {
    const { amends, outcome } = await amendWith("amend-model-inherit", {
      catalog: CATALOG,
      inherited: "bigmodel/GLM-4.6",
    });
    expect(amends[0]?.subagentModel).toEqual({ providerId: "bigmodel", modelId: "GLM-4.6" });
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "Subagents run on bigmodel/GLM-4.6",
    );
  });

  it("omitting it stays absent when the predecessor ran on the session model", async () => {
    const { amends } = await amendWith("amend-model-none", { catalog: CATALOG });
    expect(amends).toHaveLength(1);
    expect("subagentModel" in amends[0]!).toBe(false);
  });

  /**
   * 沿用的那一个也要重新解析：不重解的话，失败要等到子代理第一次开口时才发生，那时看起来像
   * 运行时故障而不是一次可以当场改掉的选择。
   */
  it("fails now, not at the first ask, when the inherited model has vanished from the catalog", async () => {
    const { amends, outcome } = await amendWith("amend-model-vanished", {
      catalog: SHRUNK_CATALOG,
      inherited: "bigmodel/GLM-4.6",
    });
    expect(outcome.result.success).toBe(false);
    expect(amends).toHaveLength(0);
    expect(outcome.permissionRequested).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    // 文案必须说清它是**继承来的**：这次调用压根没提模型名。
    expect(message).toContain("inherited the predecessor run's subagent model");
    expect(message).toContain("bigmodel/GLM-4.6");
    expect(message).toContain("subagent_model: null");
    expect(message).toContain("Nothing was stopped or created.");
  });

  it("an unresolvable id stops the call before anything is stopped or created", async () => {
    const { amends, outcome } = await amendWith("amend-model-miss", {
      catalog: CATALOG,
      requested: "gemini-3",
    });
    expect(outcome.result.success).toBe(false);
    expect(amends).toHaveLength(0);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(String(outcome.result.error?.message ?? "")).toContain("No configured model matches");
  });

  it("shows the inherited model in the confirmation window of another session's run", async () => {
    // 确认窗读的是归一化后的入参：沿用下来的模型必须在那里，否则用户批准的是另一个 run。
    const { port } = stubRunPort({
      snapshot: {
        parentSessionId: "sess_someone-else",
        status: "running",
        subagentModel: "bigmodel/GLM-4.6",
      },
    });
    const outcome = await run({
      name: "amend-model-window",
      port,
      modelCatalogPort: CATALOG,
      input: { run_id: "dwfrun-prev", script: cleanScript("amend-model-window") },
    });
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.permissionRequested[0]!.input).toMatchObject({
      subagent_model: "bigmodel/GLM-4.6",
    });
  });

  it("refuses a model id on a host with no catalog, and still strips null", async () => {
    const refused = await amendWith("amend-model-no-catalog", { requested: "gpt-5" });
    expect(refused.outcome.result.success).toBe(false);
    expect(String(refused.outcome.result.error?.message ?? "")).toContain(
      "This host cannot choose a subagent model",
    );

    const removed = await amendWith("amend-model-no-catalog-null", { requested: null });
    expect(removed.outcome.result.success).toBe(true);
    expect("subagentModel" in removed.amends[0]!).toBe(false);
  });

  it("strips the field and passes a resolved id through when the session has no run port", async () => {
    // 端口缺席：没有前驱可沿用，`null` 与省略都塌成缺席，而给了字符串仍然要解析一次——
    // 归一化后的入参还要过得了 handler 的 .strict() 重解析。
    const resolved = await run({
      name: "amend-model-no-port",
      modelCatalogPort: CATALOG,
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript("amend-model-no-port"),
        // 全称：`gpt-5` 不在会话的 provider（bigmodel）下，裸名会被 provider 边界挡回。
        subagent_model: "openai/gpt-5",
      },
    });
    expect(resolved.result.success).toBe(true);
    expect(resolved.permissionRequested[0]!.input).toMatchObject({
      subagent_model: "openai/gpt-5",
    });

    const removed = await run({
      name: "amend-model-no-port-null",
      modelCatalogPort: CATALOG,
      input: {
        run_id: "dwfrun-prev",
        script: cleanScript("amend-model-no-port-null"),
        subagent_model: null,
      },
    });
    expect(removed.result.success).toBe(true);
    expect(removed.permissionRequested[0]!.input).not.toHaveProperty("subagent_model");
  });
});

// 本会话的 run 免确认，但换 provider 不在免确认之内（docs/dynamic-workflow/launch.md「Amending
// this session's runs」）：resolveInput 从会话模型、前驱用过的模型与这次将要用的模型算出
// `predecessor.introduces_providers`，权限服务见它在场就照常 ask。全称模型名只证明写法明确，
// 不证明用户点过名——跨 provider 的那一下要留下用户的 Allow / Deny。
describe("AmendWorkflow — a new provider on this session's run", () => {
  function entry(providerId: string, modelId: string, current = false): ModelCatalogEntry {
    return { providerId, modelId, reasoningLevels: [], current };
  }

  const CATALOG: ModelCatalogPort = {
    listModels: () => [
      entry("bigmodel", "GLM-4.6", true),
      entry("bigmodel", "GLM-4.5"),
      entry("openai", "gpt-5"),
      entry("acme", "atlas"),
    ],
  };

  function personaScript(actor: string, model: string): string {
    return [
      "interface R { done: boolean }",
      `const r = await agent("${actor}", { model: "${model}" }).ask<R>("do");`,
      "return r.done;",
    ].join("\n");
  }

  async function amendOwn(
    name: string,
    options: {
      requested?: string | null;
      script?: string;
      inherited?: string;
      inheritedBindings?: Record<string, string>;
      broker?: PermissionBrokerPort;
      forged?: Record<string, unknown>;
    },
  ) {
    const { port, amends } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf(name),
        status: "completed",
        runStatus: "completed",
        ...(options.inherited === undefined ? {} : { subagentModel: options.inherited }),
        ...(options.inheritedBindings === undefined
          ? {}
          : { modelBindings: options.inheritedBindings }),
      },
    });
    const outcome = await run({
      name,
      port,
      modelCatalogPort: CATALOG,
      ...(options.broker === undefined ? {} : { broker: options.broker }),
      input: {
        run_id: "dwfrun-prev",
        script: options.script ?? cleanScript(name),
        ...(options.requested === undefined ? {} : { subagent_model: options.requested }),
        ...(options.forged === undefined ? {} : { predecessor: options.forged }),
      },
    });
    return { amends, outcome };
  }

  it("asks when the amendment moves the subagents to a provider the run never used", async () => {
    const { amends, outcome } = await amendOwn("amend-provider-new", {
      requested: "openai/gpt-5",
    });
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.permissionRequested[0]!.input).toMatchObject({
      predecessor: { owned_by_this_session: true, introduces_providers: ["openai"] },
    });
    // 桩 broker 默认 Allow：批准之后照常修订。
    expect(amends).toHaveLength(1);
  });

  it("Deny leaves the predecessor untouched", async () => {
    const { amends, outcome } = await amendOwn("amend-provider-deny", {
      requested: "openai/gpt-5",
      broker: { requestPermission: async () => ({ decision: "deny" as const }) },
    });
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.result.success).toBe(false);
    expect(amends).toHaveLength(0);
  });

  it("asks when a model the new script names brings in a new provider", async () => {
    const { amends, outcome } = await amendOwn("amend-provider-binding", {
      script: personaScript("amend-provider-binding", "openai/gpt-5"),
    });
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.permissionRequested[0]!.input).toMatchObject({
      model_bindings: { "openai/gpt-5": "openai/gpt-5" },
      predecessor: { introduces_providers: ["openai"] },
    });
    expect(amends).toHaveLength(1);
  });

  it("stays window-free for another model under the session's provider", async () => {
    const { amends, outcome } = await amendOwn("amend-provider-same", {
      requested: "bigmodel/GLM-4.5",
    });
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends[0]?.subagentModel).toEqual({ providerId: "bigmodel", modelId: "GLM-4.5" });
  });

  it("stays window-free when the provider is one the run already used", async () => {
    // 前驱的子代理已经跑在 openai 上（那次 CreateWorkflow 的确认窗里用户批过）：沿用它、
    // 或在它下面换一个名字，都不是新的选择。
    const inheritedModel = await amendOwn("amend-provider-inherited", {
      inherited: "openai/gpt-5",
    });
    expect(inheritedModel.outcome.permissionRequested).toHaveLength(0);
    expect(inheritedModel.amends[0]?.subagentModel).toEqual({
      providerId: "openai",
      modelId: "gpt-5",
    });

    const inheritedBinding = await amendOwn("amend-provider-inherited-binding", {
      script: personaScript("amend-provider-inherited-binding", "gpt-5"),
      inheritedBindings: { "gpt-5": "openai/gpt-5" },
    });
    expect(inheritedBinding.outcome.permissionRequested).toHaveLength(0);
    expect(inheritedBinding.amends).toHaveLength(1);
  });

  it("names only the providers that are new, once each", async () => {
    const { outcome } = await amendOwn("amend-provider-two", {
      requested: "acme/atlas",
      script: personaScript("amend-provider-two", "openai/gpt-5"),
      inherited: "bigmodel/GLM-4.5",
    });
    expect(outcome.permissionRequested).toHaveLength(1);
    const predecessor = (outcome.permissionRequested[0]!.input as Record<string, unknown>)
      .predecessor as Record<string, unknown>;
    expect(predecessor.introduces_providers).toEqual(["acme", "openai"]);
  });

  it("the model cannot suppress the fact by supplying its own predecessor block", async () => {
    // 模型面 JSON schema 不列 predecessor（strict）：带它的入参在 schema 校验就被拒，
    // 不带这个键、带空列表都一样——什么都没停、没建、没开窗。
    for (const forged of [
      { status: "completed", owned_by_this_session: true },
      { status: "completed", owned_by_this_session: true, introduces_providers: [] },
    ]) {
      const { amends, outcome } = await amendOwn("amend-provider-forged", {
        requested: "openai/gpt-5",
        forged,
      });
      expect(outcome.result.success).toBe(false);
      expect(outcome.permissionRequested).toHaveLength(0);
      expect(amends).toHaveLength(0);
    }
  });

  it("carries no such key when nothing new is introduced", async () => {
    const { outcome } = await amendOwn("amend-provider-none", {});
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(true);
  });
});

// 省略 `script` = 沿用前驱的脚本（docs/dynamic-workflow/launch.md「Keeping the predecessor's
// script」）：与两个设定同一条规则、同一个生命周期——resolveInput 读前驱存档的脚本回填进入参并
// 盖上 `predecessor.script_inherited`，此后 hook、确认窗、prepareApproval 与 handler 面对的都是
// 「一份脚本」，端口也永远收到一份脚本。
describe("AmendWorkflow — omitted script", () => {
  const STORED = fixture("strand-fanout-two-phases-join.ts");

  it("keeps the predecessor's script byte for byte and changes only the settings", async () => {
    const name = "amend-keep-script";
    const { port, amends, getScriptCalls } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), status: "completed", runStatus: "completed" },
      defaultConcurrency: 8,
      storedScript: STORED,
    });
    const outcome = await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 2 },
    });

    expect(outcome.result.success).toBe(true);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(getScriptCalls).toEqual(["dwfrun-prev"]);
    expect(amends).toHaveLength(1);
    expect(amends[0]!.scriptText).toBe(STORED);
    expect(amends[0]!.maxConcurrency).toBe(2);
    // 阶段表从回填的脚本上取：侧栏轨道画的仍是将要跑的那份脚本。
    expect(amends[0]!.phaseNames).toEqual(["A", "B", "C"]);
    expect(amends[0]!.phaseAlongside).toEqual([[], [0], []]);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.status).toBe("backgrounded");
    expect(output.response).toContain(
      "The script of run dwfrun-prev started unchanged in the background as run dwfrun-amended.",
    );
    expect(output.response).not.toContain("revised script");
    expect(output.response).toContain("At most 2 subagents run at once.");
  });

  it("with nothing but run_id, re-runs the script under the predecessor's settings", async () => {
    const name = "amend-keep-everything";
    const catalog: ModelCatalogPort = {
      listModels: () => [
        { providerId: "openai", modelId: "gpt-5", reasoningLevels: [], current: true },
      ],
    };
    const { port, amends } = stubRunPort({
      snapshot: {
        parentSessionId: sessionOf(name),
        status: "failed",
        runStatus: "errored",
        maxConcurrency: 3,
        subagentModel: "openai/gpt-5",
      },
      defaultConcurrency: 8,
      storedScript: STORED,
    });
    const outcome = await run({
      name,
      port,
      modelCatalogPort: catalog,
      input: { run_id: "dwfrun-prev" },
    });

    expect(outcome.result.success).toBe(true);
    expect(amends).toHaveLength(1);
    expect(amends[0]).toMatchObject({
      scriptText: STORED,
      maxConcurrency: 3,
      subagentModel: { providerId: "openai", modelId: "gpt-5" },
    });
  });

  it("asks for another session's run with the predecessor's script, its graph and the inherited flag", async () => {
    const stored = cleanScript("amend-keep-foreign");
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "running", name: "triage" },
      storedScript: stored,
    });
    const outcome = await run({
      name: "amend-keep-foreign",
      port,
      input: { run_id: "dwfrun-prev" },
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    const payload = outcome.permissionRequested[0]!;
    // 确认窗与 hook 读的是归一化后的入参：脚本就是将要跑的那一份，flag 让窗上说「脚本不变」。
    expect(payload.input).toMatchObject({
      run_id: "dwfrun-prev",
      script: stored,
      predecessor: {
        name: "triage",
        status: "running",
        owned_by_this_session: false,
        script_inherited: true,
      },
    });
    expect(payload.display?.kind).toBe("create_workflow");
    expect(
      (payload.display as { causalityGraph?: { steps: unknown[] } }).causalityGraph?.steps,
    ).toHaveLength(1);
    expect(amends).toHaveLength(1);
    expect(amends[0]!.scriptText).toBe(stored);
  });

  it("a passed script never reads the stored one and carries no inherited flag", async () => {
    const script = cleanScript("amend-pass-script");
    const { port, amends, getScriptCalls } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "completed" },
      storedScript: "return 'stale';",
    });
    const outcome = await run({ name: "amend-pass-script", port, script });

    expect(getScriptCalls).toHaveLength(0);
    const predecessor = (outcome.permissionRequested[0]!.input as Record<string, unknown>)
      .predecessor as Record<string, unknown>;
    expect(predecessor).not.toHaveProperty("script_inherited");
    expect(amends[0]!.scriptText).toBe(script);
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "The revised script started in the background as run dwfrun-amended.",
    );
  });

  it("an unknown run is refused as run_not_found before the script is read", async () => {
    const { port, amends, getScriptCalls } = stubRunPort({ storedScript: STORED });
    const outcome = await run({
      name: "amend-keep-unknown",
      port,
      input: { run_id: "dwfrun-prev" },
    });

    expect(outcome.result.success).toBe(false);
    expect(String(outcome.result.error?.message ?? "").startsWith("run_not_found:")).toBe(true);
    expect(getScriptCalls).toHaveLength(0);
    expect(amends).toHaveLength(0);
  });

  it.each([
    [
      "a predecessor whose record has no script",
      "no-record",
      { storedScript: null },
      "has no stored script",
    ],
    ["a host whose port cannot read scripts", "no-method", {}, "cannot read"],
  ] as const)(
    "%s is refused before any window, pointing at the whole script",
    async (_label, key, options, detail) => {
      const name = `amend-keep-unavailable-${key}`;
      const { port, amends } = stubRunPort({
        snapshot: { parentSessionId: sessionOf(name), status: "completed", runStatus: "completed" },
        ...options,
      });
      const outcome = await run({
        name,
        port,
        input: { run_id: "dwfrun-prev", max_concurrency: 2 },
      });

      expect(outcome.result.success).toBe(false);
      expect(outcome.permissionRequested).toHaveLength(0);
      expect(amends).toHaveLength(0);
      const message = String(outcome.result.error?.message ?? "");
      expect(message.startsWith("workflow_amend_script_unavailable:")).toBe(true);
      expect(message).toContain("dwfrun-prev");
      expect(message).toContain(detail);
      expect(message).toContain("pass the whole script");
      expect(message).toContain("Nothing was stopped or created.");
    },
  );

  it("a session without a run port is refused the same way: there is nothing to typecheck", async () => {
    const outcome = await run({ name: "amend-keep-no-port", input: { run_id: "dwfrun-prev" } });

    expect(outcome.result.success).toBe(false);
    expect(outcome.permissionRequested).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_amend_script_unavailable:")).toBe(true);
    expect(message).toContain("pass the whole script");
  });

  /**
   * 继承来的脚本编不过（facade 在前驱之后变过）：模型这次调用没写这些行，不说清就会把诊断读成
   * 自己传错了参数——与「继承来的模型已不可用」同一条理由。
   */
  it("an inherited script that no longer compiles says it was inherited, and touches nothing", async () => {
    const name = "amend-keep-broken";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), status: "running" },
      storedScript: BROKEN_SCRIPT,
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(0);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(false);
    expect(output.diagnostics.length).toBeGreaterThan(0);
    const [lead] = output.response.split("\n");
    expect(lead).toContain("run dwfrun-prev's script");
    expect(lead).toContain("inherited because you omitted both `script` and `path`");
    expect(output.response).toMatch(/L\d+:C\d+ /u);
    // 沿用的脚本与任何不来自文件的脚本一样落成草稿（docs/dynamic-workflow/launch.md「Script files」），
    // 所以下一步是去改那个文件，而不是把整份脚本内联再抄一遍。
    expect(output.response).toContain("Edit that file in place and resubmit with `path:");
    expect(output.response).toContain("Run dwfrun-prev was not touched");
  });
});

// 只改并发、run 还活着 = 就地调并发，不是一次修订（docs/dynamic-workflow/launch.md「Changing only
// the parallelism of a live run」）：同一个 run id、不铸后继、不 supersede、不读脚本、不编译、
// 一个窗都不弹。路由在 resolveInput 判定，handler 调的是 `port.retuneConcurrency`。
describe("AmendWorkflow — 只改并发即就地生效", () => {
  const STORED = fixture("strand-fanout-two-phases-join.ts");

  /** 一个还在跑、属于本会话、端口带 retuneConcurrency 的前驱。 */
  function liveRetunablePort(
    name: string,
    options: {
      defaultConcurrency?: number;
      inherited?: number;
      owner?: string;
      retune?: StubPortOptions["retune"];
      runStatus?: DynamicWorkflowRunSnapshot["runStatus"];
      storedScript?: string | null;
    } = {},
  ): ReturnType<typeof stubRunPort> {
    return stubRunPort({
      snapshot: {
        parentSessionId: options.owner ?? sessionOf(name),
        status: "running",
        ...(options.runStatus === undefined ? {} : { runStatus: options.runStatus }),
        ...(options.inherited === undefined ? {} : { maxConcurrency: options.inherited }),
      },
      defaultConcurrency: options.defaultConcurrency ?? 8,
      retune: options.retune ?? { ok: true, maxConcurrency: 2, previous: 8, defaultConcurrency: 8 },
      ...(options.storedScript === undefined ? {} : { storedScript: options.storedScript }),
    });
  }

  it("retunes in place: one run named, no successor, no compile, no script read, no window", async () => {
    const name = "retune-ok";
    const { port, amends, retunes, getScriptCalls } = liveRetunablePort(name, {
      retune: { ok: true, maxConcurrency: 2, previous: 8, defaultConcurrency: 8 },
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.result.success).toBe(true);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.brokerRequests).toHaveLength(0);
    // 这条路不读脚本、不编译、不起后继。
    expect(getScriptCalls).toHaveLength(0);
    expect(amends).toHaveLength(0);
    expect(retunes).toEqual([{ runId: "dwfrun-prev", maxConcurrency: 2 }]);

    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(true);
    expect(output.diagnostics).toEqual([]);
    expect(output.status).toBeUndefined();
    expect(output.backgroundTaskId).toBeUndefined();
    expect(output.causalityGraph).toBeUndefined();
    // 「就地生效」是一个显式的块，消费方不按形状猜；工具卡据它不画「已编译」。
    expect(output.retuned).toEqual({
      runId: "dwfrun-prev",
      maxConcurrency: 2,
      previous: 8,
      defaultConcurrency: 8,
    });
    // 没有 display 载荷：这条路一行脚本都没编译，而 `create_workflow` 的 `ok` 在卡上读作「已编译」。
    expect(outcome.result.display).toBeUndefined();
    expect(output.response).toContain("Applied to the running run dwfrun-prev");
    expect(output.response).toContain("at most 2 subagents run at once");
    expect(output.response).toContain("no new run was started");
    // 只点名一个 run：模型据此分辨这次调用走的是哪条路。
    expect(output.response).not.toContain("superseded");
  });

  it("null travels to the port as null and the applied default is named as the default", async () => {
    const name = "retune-null";
    const { port, retunes } = liveRetunablePort(name, {
      inherited: 2,
      retune: { ok: true, maxConcurrency: 8, previous: 2, defaultConcurrency: 8 },
    });
    const outcome = await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: null },
    });

    // 端口收的是三态里的 `null` 本身：默认并发那个数只有端口知道，工具不猜第二遍。
    expect(retunes).toEqual([{ runId: "dwfrun-prev", maxConcurrency: null }]);
    const response = (outcome.result.output as CreateWorkflowOutput).response;
    expect(response).toContain("Applied to the running run dwfrun-prev");
    expect(response).toContain("at most 8 subagents run at once (the default)");
  });

  it("a number above the default reaches the port as is and is applied as is", async () => {
    const name = "retune-raised";
    const { port, retunes } = liveRetunablePort(name, {
      defaultConcurrency: 16,
      inherited: 2,
      retune: { ok: true, maxConcurrency: 32, previous: 2, defaultConcurrency: 16 },
    });
    const outcome = await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 32 },
    });

    // 默认并发不是上限：工具不钳，端口也不钳，模型读到的就是它要的那个 32。
    expect(retunes[0]?.maxConcurrency).toBe(32);
    const response = (outcome.result.output as CreateWorkflowOutput).response;
    expect(response).toContain("at most 32 subagents run at once");
    expect(response).not.toContain("(the default)");
  });

  it("the same bound is refused `unchanged` before any hook, naming the bound in force", async () => {
    const name = "retune-unchanged";
    const { port, retunes, amends, getScriptCalls } = liveRetunablePort(name, { inherited: 2 });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.result.success).toBe(false);
    expect(outcome.permissionRequested).toHaveLength(0);
    // 早于 hook 与确认窗：端口一次都没被碰过。
    expect(retunes).toHaveLength(0);
    expect(amends).toHaveLength(0);
    expect(getScriptCalls).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_retune_unchanged:")).toBe(true);
    expect(message).toContain("dwfrun-prev");
    expect(message).toContain("2");
    expect(message).toMatch(/nothing was stopped/iu);
  });

  it("null against a run already at the default is `unchanged` too", async () => {
    const name = "retune-unchanged-default";
    const { port, retunes } = liveRetunablePort(name);
    const outcome = await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: null },
    });

    expect(outcome.result.success).toBe(false);
    expect(retunes).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_retune_unchanged:")).toBe(true);
    expect(message).toContain(
      "already runs at the default parallelism (at most 8 subagents at once)",
    );
  });

  it("the port's own `unchanged` (the value moved under us) is the same refusal", async () => {
    const name = "retune-unchanged-race";
    const { port, amends } = liveRetunablePort(name, {
      inherited: 4,
      retune: { ok: false, reason: "unchanged", current: 2 },
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.result.success).toBe(false);
    expect(amends).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_retune_unchanged:")).toBe(true);
    expect(message).toContain("2");
  });

  it.each([
    ["a revised script", { script: cleanScript("retune-with-script") }],
    ["a script file", { path: "nope.ts" }],
    ["a subagent model", { subagent_model: null }],
    ["a name", { name: "second pass" }],
  ] as const)("%s sends the call down the amendment path", async (_label, extra) => {
    const name = `retune-not-only-${Object.keys(extra)[0]}`;
    const { port, retunes, amends } = liveRetunablePort(name, { storedScript: STORED });
    const outcome = await run({
      name,
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 2, ...extra },
    });

    expect(retunes).toHaveLength(0);
    if ("path" in extra) {
      // 读不出来的文件是修订自己的失败——证明这次调用确实走了修订。
      expect(outcome.result.success).toBe(false);
      expect(String(outcome.result.error?.message ?? "")).toContain(
        "workflow_script_file_unreadable:",
      );
      return;
    }
    expect(amends).toHaveLength(1);
    expect((outcome.result.output as CreateWorkflowOutput).status).toBe("backgrounded");
  });

  it("a run that already settled takes the amendment, unchanged", async () => {
    const name = "retune-settled";
    const { port, retunes, amends, getScriptCalls } = liveRetunablePort(name, {
      runStatus: "errored",
      storedScript: STORED,
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(retunes).toHaveLength(0);
    expect(getScriptCalls).toEqual(["dwfrun-prev"]);
    expect(amends).toHaveLength(1);
    expect(amends[0]?.maxConcurrency).toBe(2);
    expect((outcome.result.output as CreateWorkflowOutput).status).toBe("backgrounded");
  });

  it("a port with no retuneConcurrency keeps today's amendment, window and all", async () => {
    const { port, amends, getScriptCalls } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "running", name: "triage" },
      defaultConcurrency: 8,
      storedScript: STORED,
    });
    const outcome = await run({
      name: "retune-old-host",
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 2 },
    });

    expect(getScriptCalls).toEqual(["dwfrun-prev"]);
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(amends).toHaveLength(1);
    expect((outcome.result.output as CreateWorkflowOutput).status).toBe("backgrounded");
  });

  // 「没有窗」对任何归属都成立：窗是为了把脚本摆到人面前，而这条路一段脚本都不跑。
  /**
   * 拒绝必须与本工具既有的那些（run_not_found / missing_boundaries / script_unchanged）走**同一个
   * 出口**：`success: false` + 带码的 `error`，没有 output。这条路不带 display 载荷，读侧（工具卡）
   * 因此只能靠「是不是错误」分辨「调成功了」与「被拒了」——两种结局的入参长得一模一样。
   */
  /**
   * 回话文本是**唯一**过得了 v4 的事实（这条路没有 display 载荷，协议的 toolOutput 只带 text），
   * 工具卡拿它当整行画。所以两种上界都逐字钉住：改词等于改 UI。
   */
  it.each([
    [
      "a bound below the default",
      { ok: true, maxConcurrency: 2, previous: 8, defaultConcurrency: 8 } as const,
      "Applied to the running run dwfrun-prev; at most 2 subagents run at once. Run dwfrun-prev keeps running under it: nothing was stopped and no new run was started.",
    ],
    [
      "a bound of one",
      { ok: true, maxConcurrency: 1, previous: 8, defaultConcurrency: 8 } as const,
      "Applied to the running run dwfrun-prev; at most 1 subagent runs at once. Run dwfrun-prev keeps running under it: nothing was stopped and no new run was started.",
    ],
    [
      "the default",
      { ok: true, maxConcurrency: 8, previous: 2, defaultConcurrency: 8 } as const,
      "Applied to the running run dwfrun-prev; at most 8 subagents run at once (the default). Run dwfrun-prev keeps running under it: nothing was stopped and no new run was started.",
    ],
    [
      "a bound above the default",
      { ok: true, maxConcurrency: 40, previous: 8, defaultConcurrency: 8 } as const,
      "Applied to the running run dwfrun-prev; at most 40 subagents run at once. Run dwfrun-prev keeps running under it: nothing was stopped and no new run was started.",
    ],
  ] as const)("reads back verbatim for %s", async (label, retune, expected) => {
    const name = `retune-text-${label.replace(/\s+/gu, "-")}`;
    const { port } = liveRetunablePort(name, { inherited: 4, retune });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect((outcome.result.output as CreateWorkflowOutput).response).toBe(expected);
  });

  it("a refusal comes back as a tool error with no output, like every other one", async () => {
    const name = "retune-refusal-shape";
    const { port } = liveRetunablePort(name, { inherited: 2 });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.output).toBeNull();
    expect(outcome.result.error?.type).toBe(CoreErrorType.ToolExecutionFailed);
    // 码是稳定判别键（house rule：不拿错误文本做流程判断），取自码表而不是散落的字面量。
    expect(outcome.result.error?.code).toBe(String(AMEND_WORKFLOW_ERROR_CODE.RETUNE_UNCHANGED));
    expect(
      String(outcome.result.error?.message ?? "").startsWith("workflow_retune_unchanged:"),
    ).toBe(true);
  });

  it("another session's live run is retuned with no window either", async () => {
    const { port, retunes } = liveRetunablePort("retune-foreign-live", {
      owner: "sess_someone-else",
    });
    const outcome = await run({
      name: "retune-foreign-live",
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 2 },
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.brokerRequests).toHaveLength(0);
    expect(retunes).toHaveLength(1);
    expect(outcome.result.success).toBe(true);
  });
});

// 结算竞态（docs/dynamic-workflow/launch.md「When the port says `not_live`」）：同一份入参此刻
// 描述的是一次修订，能不能做取决于「那次修订本来要不要开窗」。
describe("AmendWorkflow — 就地调并发遇上 not_live", () => {
  const STORED = fixture("strand-fanout-two-phases-join.ts");

  /**
   * resolveInput 看到的还是活的（端口随后答 not_live）；handler 再读一次快照时它已是 `settled`
   * 描述的那个终态。两次 getTask 答不同的事实，正是这条路要覆盖的竞态。
   */
  function racingPort(options: {
    owner: string;
    inherited?: number;
    settled?: Partial<DynamicWorkflowRunSnapshot>;
    storedScript?: string | null;
  }): ReturnType<typeof stubRunPort> {
    const base = stubRunPort({
      snapshot: {
        parentSessionId: options.owner,
        status: "running",
        ...(options.inherited === undefined ? {} : { maxConcurrency: options.inherited }),
      },
      defaultConcurrency: 8,
      retune: { ok: false, reason: "not_live" },
      ...(options.storedScript === undefined ? {} : { storedScript: options.storedScript }),
    });
    let reads = 0;
    const port = base.port as unknown as Record<string, unknown>;
    const first = port.getTask as (runId: string) => Promise<DynamicWorkflowRunSnapshot>;
    port.getTask = async (runId: string) => {
      const snapshot = await first(runId);
      reads += 1;
      // 第一次（resolveInput）仍读作在跑；第二次（handler 的落回路）读到终态。
      return reads === 1 ? snapshot : ({ ...snapshot, ...options.settled } as typeof snapshot);
    };
    return base;
  }

  it("this session's own run falls through to a real amendment, reading the script at that point", async () => {
    const name = "retune-race-own";
    const { port, retunes, amends, getScriptCalls } = racingPort({
      owner: sessionOf(name),
      settled: { status: "completed", runStatus: "completed" },
      storedScript: STORED,
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(retunes).toHaveLength(1);
    // 脚本是**这时候**才读的：retune 路上一次都没读过。
    expect(getScriptCalls).toEqual(["dwfrun-prev"]);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(1);
    expect(amends[0]).toMatchObject({ scriptText: STORED, maxConcurrency: 2 });
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.status).toBe("backgrounded");
    expect(output.response).toContain("started unchanged in the background as run dwfrun-amended");
  });

  it("null on the fall-through removes the limit: the port gets no maxConcurrency key", async () => {
    const name = "retune-race-own-null";
    const { port, amends } = racingPort({
      owner: sessionOf(name),
      // 前驱本来压在 2 上，所以 `null`（回默认）确实是一次改动，不是 `unchanged`。
      inherited: 2,
      settled: { status: "completed", runStatus: "completed" },
      storedScript: STORED,
    });
    await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: null } });

    expect(amends).toHaveLength(1);
    expect("maxConcurrency" in amends[0]!).toBe(false);
  });

  it("a missing script on the fall-through is reported as the amendment's own refusal", async () => {
    const name = "retune-race-own-no-script";
    const { port, amends } = racingPort({
      owner: sessionOf(name),
      settled: { status: "completed", runStatus: "completed" },
      storedScript: null,
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.result.success).toBe(false);
    expect(amends).toHaveLength(0);
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_amend_script_unavailable:")).toBe(true);
    expect(message).toContain("pass the whole script");
  });

  it("a script that no longer compiles on the fall-through comes back as diagnostics", async () => {
    const name = "retune-race-own-broken";
    const { port, amends } = racingPort({
      owner: sessionOf(name),
      settled: { status: "failed", runStatus: "errored" },
      storedScript: BROKEN_SCRIPT,
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(amends).toHaveLength(0);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(false);
    expect(output.diagnostics.length).toBeGreaterThan(0);
    expect(output.response).toContain("Run dwfrun-prev was not touched");
  });

  it("another session's settled run is refused `run_settled`, not amended", async () => {
    const { port, amends } = racingPort({
      owner: "sess_someone-else",
      settled: { status: "completed", runStatus: "completed" },
      storedScript: STORED,
    });
    const outcome = await run({
      name: "retune-race-foreign-settled",
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 2 },
    });

    expect(outcome.result.success).toBe(false);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(0);
    // 与既有拒绝同一个出口：错误 + output 为 null（读侧没有 display 可看，只能靠这个分辨结局）。
    expect(outcome.result.output).toBeNull();
    expect(outcome.result.error?.type).toBe(CoreErrorType.ToolExecutionFailed);
    expect(outcome.result.error?.code).toBe(String(AMEND_WORKFLOW_ERROR_CODE.RUN_SETTLED));
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_run_settled:")).toBe(true);
    expect(message).toContain("dwfrun-prev");
    expect(message).toMatch(/call .*again/iu);
  });

  it("another session's run this agent never held live is refused `not_retunable`", async () => {
    const { port, amends } = racingPort({
      owner: "sess_someone-else",
      settled: { runStatus: "pending" },
      storedScript: STORED,
    });
    const outcome = await run({
      name: "retune-race-foreign-pending",
      port,
      input: { run_id: "dwfrun-prev", max_concurrency: 2 },
    });

    expect(outcome.result.success).toBe(false);
    expect(amends).toHaveLength(0);
    expect(outcome.result.output).toBeNull();
    expect(outcome.result.error?.type).toBe(CoreErrorType.ToolExecutionFailed);
    expect(outcome.result.error?.code).toBe(String(AMEND_WORKFLOW_ERROR_CODE.NOT_RETUNABLE));
    const message = String(outcome.result.error?.message ?? "");
    expect(message.startsWith("workflow_run_not_retunable:")).toBe(true);
    expect(message).toContain("dwfrun-prev");
  });

  // 用户亲手停下的 run 在修订路上本来要开窗（owner 规则把它排除在外），所以落回路不能替它跳过。
  it("an own run the user stopped is refused instead of silently amended", async () => {
    const name = "retune-race-own-user-stopped";
    const { port, amends } = racingPort({
      owner: sessionOf(name),
      settled: { status: "cancelled", runStatus: "stopped", stopReason: "user" },
      storedScript: STORED,
    });
    const outcome = await run({ name, port, input: { run_id: "dwfrun-prev", max_concurrency: 2 } });

    expect(outcome.result.success).toBe(false);
    expect(amends).toHaveLength(0);
    expect(String(outcome.result.error?.message ?? "").startsWith("workflow_run_settled:")).toBe(
      true,
    );
  });
});

// docs/dynamic-workflow/launch.md「What the model is told」：三条 bullet 说的是**同一条**规则（省略即
// 沿用前驱），脚本在最前——模型若以为脚本必填，就会为了改一个数把几千 token 的脚本再抄一遍。
// 2026-09-21 起描述只剩路由（docs/dynamic-workflow/launch.md「What the model is told」）：沿用规则的
// 三态字段、两条来路的先后与就地调并发那一句都搬进了 dynamic-workflows 技能 §16.4，由技能门保证
// 读过；它们的顺序断言在 bootstrap/tests/dynamic-workflow-skill.test.ts。这里只钉描述必须留下的路由。
describe("AmendWorkflow — description", () => {
  it("routes: a settings-only revision names neither script field, resume is another tool", () => {
    const description = amendWorkflowToolEntry.metadata.description;
    expect(description).toContain("neither `path` nor `script`");
    // 停下的 run 不改任何东西就继续：那是 ResumeWorkflowRun 的活，不是一次空修订。
    expect(description).toContain("To continue a stopped run unchanged, use ResumeWorkflowRun");
    // 跑到一半就修，不先停不等结束——门的边界也写在这里：带脚本才需要技能。
    expect(description).toContain("Do not TaskStop it first");
    expect(description).toContain("a settings-only call is not");
  });
});

// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」：另一个会话的 run 才开窗，
// 窗里的调整与 CreateWorkflow 同一条路——回填块、批准后落进入参、结果先说一句。
describe("AmendWorkflow — settings adjusted in the confirmation window", () => {
  const CATALOG: ModelCatalogPort = {
    listModels: () => [
      { providerId: "openai", modelId: "gpt-5", reasoningLevels: [], current: true },
    ],
  };

  it("the ask carries the adjustable_settings block next to the predecessor facts", async () => {
    const { port } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "running", maxConcurrency: 2 },
      defaultConcurrency: 8,
    });
    const outcome = await run({ modelCatalogPort: CATALOG, name: "amend-adjustable", port });
    expect(outcome.permissionRequested[0]!.input).toMatchObject({
      max_concurrency: 2,
      adjustable_settings: { subagent_model: true, concurrency_ceiling: 8 },
    });
  });

  it("applies the adjustments to the amendment and names them in the result", async () => {
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: "sess_someone-else", status: "running", maxConcurrency: 2 },
      defaultConcurrency: 8,
    });
    const outcome = await run({
      broker: {
        async requestPermission() {
          return {
            decision: "allow",
            inputAdjustments: { subagent_model: "gpt-5", max_concurrency: null },
          };
        },
      },
      modelCatalogPort: CATALOG,
      name: "amend-adjusted",
      port,
    });
    expect(amends).toHaveLength(1);
    expect(amends[0]!.subagentModel).toEqual({ providerId: "openai", modelId: "gpt-5" });
    expect("maxConcurrency" in amends[0]!).toBe(false);
    const response = (outcome.result.output as CreateWorkflowOutput).response;
    expect(response).toContain(
      "Before approving, the user adjusted the settings in the confirmation window: subagents run on openai/gpt-5 (the main agent stays on the session model); the limit on subagents at once is back to the default.",
    );
    expect(response).not.toContain("At most 2");
  });

  it("an own run amends without a window, so it carries the block but never an adjustment", async () => {
    const name = "amend-adjustable-owned";
    const { port, amends } = stubRunPort({
      snapshot: { parentSessionId: sessionOf(name), status: "completed", runStatus: "completed" },
      defaultConcurrency: 8,
    });
    const outcome = await run({ name, port });
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(amends).toHaveLength(1);
    expect((outcome.result.output as CreateWorkflowOutput).response).not.toContain(
      "Before approving",
    );
  });
});
