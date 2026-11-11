/**
 * 确定性集成测试（phase 1.5 步骤 7，CI 安全层）：真实 AgentRuntime driver + 脚本化模型，跑通
 * dynamic-workflow 引擎↔真实 runtime 的 submit 桥接。见 docs/execution-engine.md「The driver (Boundary B)」「Typed asks and `submit_result`」。
 *
 * 本文件先立最小的 accept 路径，验证三值→二值裁决映射与 submit→turn-stop；其余场景（同 turn repair、
 * nudge、untyped、world-read）在后续 describe 里铺开。
 */

import { describe, expect, it, vi } from "vitest";
import { createTestAgentRuntime } from "./helpers/test-agent-runtime.js";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  SUBMIT_RESULT_TOOL_NAME,
  type ModelRequest,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import { AgentRuntime } from "@zcode/core";
import {
  inputHash,
  InMemoryJournalStore,
  refToString,
  type ActorRef,
  type ActorSessionSeed,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { workflowActorToolPolicy } from "../src/app/workflow-actor-tools.js";
import type { ActorTranscriptStore } from "../src/app/workflow-actor-transcript.js";
import { createWorkflowEscalationRegistry } from "../src/app/workflow-escalation-registry.js";
import {
  createAgentRuntimeWorkflowDriver,
  mintActorSessionId,
} from "../src/app/workflow-driver.js";
import {
  fakeFileSystemPort,
  runDriverScript,
  unsupportedExecutionPort,
} from "./workflow-driver.helpers.js";

const RUN = "run";

describe("workflow driver — accept path", () => {
  it("bridges a valid submit through the real runtime and returns the artifact", async () => {
    const script = [
      "interface Summary { title: string; points: string[]; }",
      'const worker = agent("worker", "You summarize repos.");',
      'const s = await worker.ask<Summary>("Summarize the repo");',
      "log(`title: ${s.title}`);",
      "return s;",
    ].join("\n");

    const artifact = { title: "The Repo", points: ["a", "b"] };
    const { settlement, journal, events, modelCalls } = await runDriverScript(script, {
      caps: { maxConcurrency: 16 },
      actorScripts: {
        // actor#1@1 的持久 runtime：第一次模型请求即提交合法结果。
        "actor#1@1": [{ kind: "submit", result: artifact }],
      },
    });

    // 结算：脚本 return 的 artifact 原样冒出。
    expect(settlement).toEqual({ status: "completed", artifact });

    // journal：ask 节点 completed，带 actorSeq / inputHash / result / actor 归属。
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("completed");
    expect(node?.result).toEqual(artifact);
    expect(node?.actorSeq).toBe(0);
    expect(node?.inputHash).toBe(inputHash("Summarize the repo"));
    expect(node?.actorSiteId).toBe("actor#1");

    // stats 来自真实 turn 的 usage。accept 路径下 stats 晚于 settle 到达（真实 runtime 只在 turn
    // resolve、即 submit 之后才知道用量），引擎的 post-settle 回填把它写回已结算的 journal 节点。
    expect(node?.stats?.tokens ?? 0).toBeGreaterThan(0);
    expect(node?.stats?.turns).toBeGreaterThanOrEqual(1);

    // run 级用量也被累计（askStats 无条件累加 spentTokens），作为额外覆盖。
    const usageEvents = events.filter((e) => e.type === "usage-updated");
    const lastUsage = usageEvents.at(-1);
    expect(lastUsage?.type === "usage-updated" && lastUsage.spentTokens).toBeGreaterThan(0);

    // 单次模型请求即完成（无 repair、无 nudge）。
    expect(modelCalls["actor#1@1"]?.calls).toBe(1);

    // 事件流：run-started → actor-created → node-dispatched → node-settled(ok) → run-settled(completed)。
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run-started");
    expect(types).toContain("actor-created");
    expect(types).toContain("node-dispatched");
    const settled = events.filter((e) => e.type === "node-settled");
    expect(settled.at(-1)).toMatchObject({ outcome: "ok" });
    expect(types.at(-1)).toBe("run-settled");
  });
});

const TYPED_ASK_SCRIPT = [
  "interface Summary { title: string; points: string[]; }",
  'const worker = agent("worker", "You summarize repos.");',
  'const s = await worker.ask<Summary>("Summarize the repo");',
  "return s;",
].join("\n");

describe("workflow driver — in-session repair (reject)", () => {
  it("rejects an invalid submit, retries within the same turn, then accepts", async () => {
    const valid = { title: "Repo", points: ["x"] };
    const { settlement, journal, events, modelCalls } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: {
        // 同一 turn 内：先提交非法（title 类型错、points 缺失）→ 引擎 reject → error tool_result
        // → 模型在会话内重试 → 提交合法 → accept。
        "actor#1@1": [
          { kind: "submit", result: { title: 42 } },
          { kind: "submit", result: valid },
        ],
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact: valid });
    // repair 是真实的会话内 tool_result 重试：同一 turn 里发生了 2 次模型请求。
    expect(modelCalls["actor#1@1"]?.calls).toBe(2);
    // 引擎发过一次 node-repairing（携违规），最终 settled(ok)。
    const repairing = events.filter((e) => e.type === "node-repairing");
    expect(repairing.length).toBe(1);
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
  });

  it("fails the ask with ValidationFailed after the repair attempts are exhausted", async () => {
    // repair 次数上限 3：4 次非法提交耗尽后引擎 cancelAsk + settleFailed(ValidationFailed)。
    const invalid = { kind: "submit" as const, result: { title: 1 } };
    const { settlement, journal, events } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: { "actor#1@1": [invalid, invalid, invalid, invalid] },
    });

    // ask 拒绝跨 Boundary A 冒泡为脚本抛错 → run 失败。
    expect(settlement.status).toBe("errored");
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("failed");
    expect(node?.error?.code).toBe("ValidationFailed");
    // 3 次 repair 尝试后耗尽。
    expect(events.filter((e) => e.type === "node-repairing").length).toBe(3);
  });
});

describe("workflow driver — nudge", () => {
  it("nudges a turn that ended without a submit, then accepts on the fresh turn", async () => {
    const valid = { title: "Repo", points: ["x"] };
    const { settlement, events, modelCalls } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: {
        // 第一 turn 只发文本（不提交）→ 引擎 nudge → 全新 turn 提交合法 → accept。
        "actor#1@1": [
          { kind: "text", text: "Here is the summary." },
          { kind: "submit", result: valid },
        ],
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact: valid });
    // nudge 是同一持久 runtime 上的一次全新 executeTurn：共 2 次模型请求。
    expect(modelCalls["actor#1@1"]?.calls).toBe(2);
    expect(events.filter((e) => e.type === "node-nudged").length).toBe(1);
  });

  it("fails with ResultNotSubmitted when nudge is exhausted", async () => {
    // nudge 预算 1：两次 turn 都不提交 → cancelAsk + settleFailed(ResultNotSubmitted)。
    const { settlement, journal, events } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: {
        "actor#1@1": [
          { kind: "text", text: "no submit 1" },
          { kind: "text", text: "no submit 2" },
        ],
      },
    });

    expect(settlement.status).toBe("errored");
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("failed");
    expect(node?.error?.code).toBe("ResultNotSubmitted");
    expect(events.filter((e) => e.type === "node-nudged").length).toBe(1);
  });
});

describe("workflow driver — untyped ask", () => {
  it("settles an untyped ask from the turn's final text (no submit_result)", async () => {
    const script = [
      'const worker = agent("worker");',
      'const answer = await worker.ask("What is 2 + 2?");',
      "return answer;",
    ].join("\n");

    const { settlement, journal } = await runDriverScript(script, {
      actorScripts: { "actor#1@1": [{ kind: "text", text: "The answer is 4." }] },
    });

    expect(settlement).toEqual({ status: "completed", artifact: "The answer is 4." });
    expect(journal.getNode(RUN, "ask#1", 1)?.result).toBe("The answer is 4.");
  });

  it("guards submit_result called on an untyped ask without hanging", async () => {
    // untyped ask 若被模型误调 submit_result：driver 本地拦截并回合成 rejection（不上报引擎、不悬挂），
    // 模型改用纯文本，untyped ask 据 final text 结算。
    const script = [
      'const worker = agent("worker");',
      'const answer = await worker.ask("Say hello.");',
      "return answer;",
    ].join("\n");

    const { settlement, modelCalls } = await runDriverScript(script, {
      actorScripts: {
        "actor#1@1": [
          { kind: "submit", result: { foo: "bar" } },
          { kind: "text", text: "hello there" },
        ],
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact: "hello there" });
    // 拦截未悬挂：第一 turn 内 submit 被拒 → 模型再答文本 → 共 2 次模型请求。
    expect(modelCalls["actor#1@1"]?.calls).toBe(2);
  });
});

describe("workflow driver — lenient stringified submit", () => {
  it("accepts a submit whose result is a stringified JSON object and journals the parsed object", async () => {
    // 实盘发现：真实模型（GLM-5.3 经 Anthropic 兼容端点）常把 submit_result 的 result 传成 JSON
    // 字符串而非对象。引擎 schema-aware 地宽松解析（scheduler.normalizeSubmit），端到端应 accept
    // 并把解析后的对象落 journal。
    const artifact = { title: "The Repo", points: ["a", "b"] };
    const { settlement, journal, modelCalls } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: {
        // result 是 STRING（对象的 JSON 编码），而非对象本身。
        "actor#1@1": [{ kind: "submit", result: JSON.stringify(artifact) }],
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact });
    // 单次模型请求即被 accept（无 repair）。
    expect(modelCalls["actor#1@1"]?.calls).toBe(1);
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("completed");
    // 落库的是解析后的对象，而非原始字符串。
    expect(node?.result).toEqual(artifact);
  });
});

describe("workflow driver — actor tool surface", () => {
  // actor 的工具面此前被 runtime 工厂整个忽略——实盘 transcript 里裁判也拿到了
  // AskUserQuestion / CreateWorkflow。这里断言的是模型请求里**实际**带上的工具名，
  // 而不是配置字段，因为中间还叠着 core 的过滤与 embedded-search 分支。
  const PROFILE_SCRIPT = (persona: string) =>
    [
      "interface Verdict { approved: boolean; }",
      `const judge = ${persona};`,
      'const v = await judge.ask<Verdict>("Approve it?");',
      "return v;",
    ].join("\n");

  /** 跑一次单 ask 的 typed 脚本并取回该 actor 第一次模型请求的工具名列表。 */
  async function toolNamesForPersona(persona: string): Promise<string[]> {
    const { settlement, modelCalls } = await runDriverScript(PROFILE_SCRIPT(persona), {
      actorScripts: { "actor#1@1": [{ kind: "submit", result: { approved: true } }] },
    });
    // 先确认 ask 真的跑通了：工具面若把 submit_result 滤掉，run 会失败而不是给出空列表。
    expect(settlement).toEqual({ status: "completed", artifact: { approved: true } });
    const names = modelCalls["actor#1@1"]?.toolNames[0];
    return names ?? [];
  }

  it("keeps the full working set for every actor, minus question, plan-mode and meta tools", async () => {
    const names = await toolNamesForPersona('agent("worker", "You do work.")');
    // 每个 actor 都照常干活（2026-09-12 起没有工具档位，docs/dynamic-workflow/authoring.md）。
    for (const expected of ["Bash", "Edit", "Write", SUBMIT_RESULT_TOOL_NAME]) {
      expect(names).toContain(expected);
    }
    // 子代理不问人：要人判断时用 escalate 交给主代理（docs/dynamic-workflow/launch.md
    // 「Permissions inside a run」）；plan 审批不属于子代理，CreateWorkflow 会递归提交工作流，
    // ReadTopicResource 越界读父会话的话题资源——全部减掉。
    for (const forbidden of [
      "AskUserQuestion",
      "EnterPlanMode",
      "ExitPlanMode",
      "CreateWorkflow",
      "ReadTopicResource",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("workflow driver — resume by replay", () => {
  it("short-circuits journaled nodes on resume with zero actor dispatches", async () => {
    const script = [
      "interface Verdict { approved: boolean; }",
      'const paths = await files.glob("src/**/*.ts");',
      'const v = await agent("reviewer").ask<Verdict>(`Review ${paths.length} files`);',
      "return { count: paths.length, approved: v.approved };",
    ].join("\n");

    const journal = new InMemoryJournalStore();
    const files = { glob: ["src/a.ts", "src/b.ts"] };
    const artifact = { count: 2, approved: true };

    // 首次运行：live 派发一次 ask，落 journal。
    const first = await runDriverScript(script, {
      journal,
      files,
      actorScripts: { "actor#1@1": [{ kind: "submit", result: { approved: true } }] },
    });
    expect(first.settlement).toEqual({ status: "completed", artifact });
    expect(first.modelCalls["actor#1@1"]?.calls).toBe(1);

    // 复用同一 journal 重跑同一脚本：所有节点命中 journal 短路，driver 不创建任何 actor 会话
    // （runtimeFactory 从不被调用 → modelCalls 为空），也不 startAsk。
    const resumed = await runDriverScript(script, {
      journal,
      files,
      // 若 resume 误触发 live 派发，脚本会因缺应答而挂起/失败——空脚本即断言「零派发」。
      actorScripts: {},
    });
    expect(resumed.settlement).toEqual({ status: "completed", artifact });
    expect(Object.keys(resumed.modelCalls)).toHaveLength(0);
    // Boundary C：resume 的 ask 结算事件带 cached 标志。
    const cachedSettles = resumed.events.filter(
      (e) => e.type === "node-settled" && e.cached === true,
    );
    expect(cachedSettles.length).toBeGreaterThan(0);
  });
});

describe("workflow driver — world reads", () => {
  it("executes glob/read via the fs port and threads results into a typed ask", async () => {
    const script = [
      "interface Verdict { approved: boolean; }",
      'const paths = await files.glob("src/**/*.ts");',
      'const first = paths[0] ?? "none";',
      "const text = await files.read(first);",
      'const v = await agent("reviewer").ask<Verdict>(`Review ${first} (${text.length} bytes)`);',
      "return { count: paths.length, first, approved: v.approved };",
    ].join("\n");

    const { settlement, journal } = await runDriverScript(script, {
      files: { glob: ["src/a.ts", "src/b.ts"], read: "export const x = 1;\n" },
      actorScripts: { "actor#1@1": [{ kind: "submit", result: { approved: true } }] },
    });

    expect(settlement).toEqual({
      status: "completed",
      artifact: { count: 2, first: "src/a.ts", approved: true },
    });
    // world-read 落 journal，带结果。
    const glob = journal.getNode(RUN, "world-read#1", 1);
    expect(glob?.kind).toBe("world-read");
    expect(glob?.result).toEqual(["src/a.ts", "src/b.ts"]);
    const read = journal.getNode(RUN, "world-read#2", 1);
    expect(read?.result).toBe("export const x = 1;\n");
  });
});

describe("workflow driver — actor session ids", () => {
  /**
   * 会话 id 的两条性质（spec 的 Invariants：无碰撞、字符集安全无 `#`/`@`/`/`）。
   *
   * sanitize 是两步且顺序即契约：先把字面 `_` 转义成 `__`，再把 `[A-Za-z0-9.-]` 之外的字符
   * 映射成单个 `_`。没有转义那一步，`a_b` 与 `a#b` 会折叠成同一个串——这不是假想：它把
   * 「不碰撞」建立在「站点 id 词汇表里没有下划线」这个由分析器（而非本文件）拥有的前提上。
   */
  async function sessionIdsFor(runId: string): Promise<string[]> {
    const ids: string[] = [];
    await runDriverScript(['const a = await agent("w").ask("go");', "return a;"].join("\n"), {
      actorScripts: {},
      runId,
      runtimeFactory: ({ sessionId }) => {
        ids.push(sessionId);
        // 最小 stub：driver 只需要一个能 executeTurn 的对象；本用例只看会话 id。
        return {
          close: async () => {},
          executeTurn: async () => ({ response: "ok", events: [], usage: undefined }),
        } as never;
      },
    });
    return ids;
  }

  it("会话 id 含 runId 且不含 # @ /", async () => {
    const ids = await sessionIdsFor("dwfrun-plain");

    expect(ids).toHaveLength(1);
    expect(ids[0]).toContain("dwfrun-plain");
    // refToString(actor) 是 `actor#1@1`——两个字符都必须已被折叠。
    expect(ids[0]).not.toMatch(/[#@/]/);
  });

  it("下划线转义使 sanitize 可逆到不碰撞：a_b 与 a#b 不折叠成同一个 id", async () => {
    const [underscore] = await sessionIdsFor("a_b");
    const [hash] = await sessionIdsFor("a#b");

    // 朴素白名单方案下这两个会相等；转义先行使它们保持可区分。
    expect(underscore).not.toBe(hash);
    expect(underscore).toContain("a__b");
    expect(hash).toContain("a_b");
  });

  // 对抗性对子：站点 id 词汇表里的特殊字符（`#`/`@`）与字面下划线的每一种同形风险。
  // 朴素白名单（`_` 既在白名单里又当替换字符）会把每一对都折叠成同一个串——
  // 这三对就是那个方案的反例，也是转义先行这一步存在的全部理由。
  it("对抗性对子逐对不碰撞（actor#1 vs actor_1 等）", async () => {
    const pairs: readonly [string, string][] = [
      ["actor#1", "actor_1"],
      ["actor#1@2", "actor_1@2"],
      ["ask#3/2", "ask_3_2"],
    ];

    for (const [left, right] of pairs) {
      const [leftId] = await sessionIdsFor(left);
      const [rightId] = await sessionIdsFor(right);
      expect(leftId, `${left} vs ${right}`).not.toBe(rightId);
      // 且两者都字符集安全（会话 id 会进 URL / 文件路径 / 日志）。
      expect(leftId).not.toMatch(/[#@/]/);
      expect(rightId).not.toMatch(/[#@/]/);
    }
  });
});

describe("workflow driver — resume 会话身份互证", () => {
  const NOOP_SINK: WorkflowReportSink = {
    askSubmitAttempted: () => {},
    askTurnEnded: () => {},
    askProgress: () => {},
    askStats: () => {},
    askFailed: () => {},
    askWaiting: () => {},
    askExecuting: () => {},
    askMutating: () => {},
    concurrencyChanged: () => {},
    stopRun: () => {},
    runStalled: () => {},
  };

  function driverWith(journal: InMemoryJournalStore, onFactory?: () => void) {
    const makeDriver = createAgentRuntimeWorkflowDriver({
      journal,
      emit: () => {},
      escalationRegistry: createWorkflowEscalationRegistry(),
      fileSystemPort: fakeFileSystemPort({}),
      cwd: process.cwd(),
      runId: RUN,
      runtimeFactory: () => {
        onFactory?.();
        // 最小 stub：互证通过后 driver 只需要一个可持有的 runtime 对象。
        return {
          close: async () => {},
          executeTurn: async () => ({ response: "ok", events: [], usage: undefined }),
        } as never;
      },
    });
    return makeDriver(NOOP_SINK);
  }

  it("journal 记录的 sessionId 与铸造结果不一致时大声失败，且不构造 runtime", async () => {
    // journal 的会话 id 是记录、铸造函数才是权威（spec 的 Invariants）。两者不一致意味着
    // 铸造规则漂移（改名/第二处实现），后果是重水化读错会话、详情页打开不存在的会话——
    // 离成因很远，所以必须在重挂的第一步大声失败，携结构化 mismatch（与哈希不匹配同形）。
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({
      runId: RUN,
      siteId: "actor#1",
      ordinal: 1,
      sessionId: "sess_drifted-scheme",
    });

    let factoryCalls = 0;
    const driver = driverWith(journal, () => factoryCalls++);
    await expect(
      driver.createActorSession({ siteId: "actor#1", ordinal: 1 }, {}),
    ).rejects.toMatchObject({
      code: "DriverError",
      mismatch: {
        expected: "sess_drifted-scheme",
        got: mintActorSessionId(RUN, { siteId: "actor#1", ordinal: 1 }),
      },
    });
    expect(factoryCalls).toBe(0);
  });

  it("journal 记录与铸造结果一致时正常重挂（同一个会话 id）", async () => {
    const minted = mintActorSessionId(RUN, { siteId: "actor#1", ordinal: 1 });
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1, sessionId: minted });

    let factoryCalls = 0;
    const driver = driverWith(journal, () => factoryCalls++);
    await expect(driver.createActorSession({ siteId: "actor#1", ordinal: 1 }, {})).resolves.toEqual(
      {
        id: minted,
      },
    );
    expect(factoryCalls).toBe(1);
  });

  it("journal 无记录（全新 actor）时不做互证，正常建会话", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });

    const driver = driverWith(journal);
    await expect(driver.createActorSession({ siteId: "actor#1", ordinal: 1 }, {})).resolves.toEqual(
      {
        id: mintActorSessionId(RUN, { siteId: "actor#1", ordinal: 1 }),
      },
    );
  });
});

// ————————————————————————————————————————————————————————————————
// amend-resume 的 driver 半身：ask 边界记账 + 转录截断
// 见 apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Amend-resume」「转录截断（driver）」两行。
//
// 这两族**必须走真库**：被测的正是「数的与抄的是不是同一批消息」，而消息只有接上真实
// session store 才会真的落库。用一个只会返回固定数字的替身，等于把被测语义换成复制品。
// ————————————————————————————————————————————————————————————————

/** 一次性 sqlite session store（真实持久层），用完即删。 */
async function withSessionStore(run: (store: SessionStorePort) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-dwf-transcript-"));
  const store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
  try {
    await run(store as unknown as SessionStorePort);
  } finally {
    (store as unknown as { close(): void }).close();
    await rm(root, { force: true, recursive: true });
  }
}

/** 轮询等一个条件成立（fire-and-forget 的 startAsk 没有可 await 的句柄）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const TWO_ASK_SCRIPT = [
  "interface A { text: string }",
  'const w = agent("worker", "You work.");',
  'const a = await w.ask<A>("first question");',
  'const b = await w.ask<A>("second question");',
  "return `${a.text}/${b.text}`;",
].join("\n");

const ACTOR_ONE: ActorRef = { siteId: "actor#1", ordinal: 1 };

describe("workflow driver — ask 边界记账", () => {
  it("每个 ask 结算后写下该 actor 会话的消息数，第二个 ask 的边界更大", async () => {
    await withSessionStore(async (store) => {
      const runId = "dwfrun-boundary";
      const { settlement, journal } = await runDriverScript(TWO_ASK_SCRIPT, {
        runId,
        sessionStore: store,
        actorScripts: {
          "actor#1@1": [
            { kind: "submit", result: { text: "one" } },
            { kind: "submit", result: { text: "two" } },
          ],
        },
      });
      expect(settlement).toEqual({ status: "completed", artifact: "one/two" });

      const first = journal.getNode(runId, "ask#1", 1);
      const second = journal.getNode(runId, "ask#2", 1);
      // 边界是**同一个存取面**数出来的长度：driver 计数、种子复制与 core 的重水化都读
      // `sessionStore.messages`，三者口径必须一致，否则同一个 N 在两个读者眼里长度不同。
      const persisted = await store.messages({
        sessionID: mintActorSessionId(runId, ACTOR_ONE),
      });
      expect(second?.messageBoundary).toBe(persisted.length);
      expect(first?.messageBoundary).toBeGreaterThan(0);
      expect(second?.messageBoundary).toBeGreaterThan(first?.messageBoundary ?? 0);

      // 读改写（与 stats 回填同族）：引擎写下的字段一个不许掉。
      expect(first).toMatchObject({
        status: "completed",
        actorSeq: 0,
        inputHash: inputHash("first question"),
        result: { text: "one" },
      });
      expect(first?.stats?.tokens).toBeGreaterThan(0);
      expect(second?.actorSeq).toBe(1);
      expect(second?.stats?.tokens).toBeGreaterThan(0);
    });
  }, 30_000);

  it("多 actor 各数各的会话（边界不串台）", async () => {
    await withSessionStore(async (store) => {
      const runId = "dwfrun-boundary-multi";
      const script = [
        "interface A { text: string }",
        'const a = agent("a", "You are A.");',
        'const b = agent("b", "You are B.");',
        'const one = await a.ask<A>("a-first");',
        'const other = await b.ask<A>("b-only");',
        'const two = await a.ask<A>("a-second");',
        "return `${one.text}${other.text}${two.text}`;",
      ].join("\n");
      const answer: { kind: "submit"; result: { text: string } } = {
        kind: "submit",
        result: { text: "x" },
      };
      const { settlement, journal } = await runDriverScript(script, {
        runId,
        sessionStore: store,
        actorScripts: { "actor#1@1": [answer, answer], "actor#2@1": [answer] },
      });
      expect(settlement.status).toBe("completed");

      const aFirst = journal.getNode(runId, "ask#1", 1)?.messageBoundary;
      const bOnly = journal.getNode(runId, "ask#2", 1)?.messageBoundary;
      const aSecond = journal.getNode(runId, "ask#3", 1)?.messageBoundary;
      // b 只问过一次，所以它的边界必须停在自己那一轮上——而不是跟着 a 一起长。
      expect(bOnly).toBe(aFirst);
      // 首个 ask 还会持久化一条 date 公告，各 ask 新增条数不同；边界按各自会话的实际条数核对。
      const aPersisted = await store.messages({
        sessionID: mintActorSessionId(runId, { siteId: "actor#1", ordinal: 1 }),
      });
      expect(aSecond).toBeGreaterThan(aFirst ?? 0);
      expect(aSecond).toBe(aPersisted.length);
      const bPersisted = await store.messages({
        sessionID: mintActorSessionId(runId, { siteId: "actor#2", ordinal: 1 }),
      });
      expect(bOnly).toBe(bPersisted.length);
    });
  }, 30_000);

  it("无转录存取面时不写边界（既有装配原样不变）", async () => {
    const runId = "dwfrun-no-store";
    const { journal } = await runDriverScript(TWO_ASK_SCRIPT, {
      runId,
      actorScripts: {
        "actor#1@1": [
          { kind: "submit", result: { text: "one" } },
          { kind: "submit", result: { text: "two" } },
        ],
      },
    });
    // 缺席即缺席：不写 0，也不写猜的值。代价是这个 run 不能作修订前驱（service 侧的门会挡）。
    expect(journal.getNode(runId, "ask#1", 1)?.messageBoundary).toBeUndefined();
    expect(journal.getNode(runId, "ask#2", 1)?.status).toBe("completed");
  }, 30_000);
});

describe("workflow driver — 转录截断（会话种子）", () => {
  const NOOP_SINK: WorkflowReportSink = {
    askSubmitAttempted: () => {},
    askTurnEnded: () => {},
    askProgress: () => {},
    askStats: () => {},
    askFailed: () => {},
    askWaiting: () => {},
    askExecuting: () => {},
    askMutating: () => {},
    concurrencyChanged: () => {},
    stopRun: () => {},
    runStalled: () => {},
  };

  /** 跑一次源 run，留下一个真实转录 + 它的边界记账。 */
  async function recordSourceRun(
    store: SessionStorePort,
    runId: string,
  ): Promise<{ boundaries: number[]; sessionId: SessionId }> {
    const { settlement, journal } = await runDriverScript(TWO_ASK_SCRIPT, {
      runId,
      sessionStore: store,
      actorScripts: {
        "actor#1@1": [
          { kind: "submit", result: { text: "one" } },
          { kind: "submit", result: { text: "two" } },
        ],
      },
    });
    expect(settlement.status).toBe("completed");
    return {
      boundaries: [
        journal.getNode(runId, "ask#1", 1)?.messageBoundary ?? 0,
        journal.getNode(runId, "ask#2", 1)?.messageBoundary ?? 0,
      ],
      sessionId: mintActorSessionId(runId, ACTOR_ONE),
    };
  }

  /** 数写入次数的转录面（幂等用例的观察点：跳过复制 = 一次写都没发生）。 */
  function countingTranscriptStore(store: SessionStorePort): {
    store: ActorTranscriptStore;
    writes: { messages: number; parts: number };
  } {
    const writes = { messages: 0, parts: 0 };
    return {
      writes,
      store: {
        messages: (input) => store.messages(input),
        saveMessage: async (message) => {
          writes.messages++;
          await store.saveMessage(message);
        },
        savePart: async (part) => {
          writes.parts++;
          await store.savePart(part);
        },
      },
    };
  }

  /** 修订 run 的 driver：真 runtime（接真库）+ 记下工厂收到的种子与模型请求。 */
  function amendDriver(input: {
    journal: InMemoryJournalStore;
    runId: string;
    store: SessionStorePort;
    transcriptStore?: ActorTranscriptStore;
  }) {
    const seeds: (ActorSessionSeed | undefined)[] = [];
    const requests: ModelRequest[] = [];
    const fileSystemPort = fakeFileSystemPort({});
    const driver = createAgentRuntimeWorkflowDriver({
      journal: input.journal,
      emit: () => {},
      escalationRegistry: createWorkflowEscalationRegistry(),
      executionPort: unsupportedExecutionPort(),
      fileSystemPort,
      cwd: process.cwd(),
      runId: input.runId,
      actorTranscriptStore: input.transcriptStore ?? input.store,
      runtimeFactory: async ({ actor, persona, seed, sessionId, submitPort }) => {
        seeds.push(seed);
        const runtime = createTestAgentRuntime(
          sessionId,
          {
            systemPrompt: persona.system ?? "You are a workflow actor.",
            mode: "yolo",
            taskType: "workflow_child",
            subagents: { enabled: false },
            ...workflowActorToolPolicy(persona),
          },
          {
            eventStore: createInMemorySessionEventStore(),
            modelAdapter: {
              async generateText(request: ModelRequest) {
                requests.push(request);
                return {
                  finishReason: "stop",
                  model: "scripted",
                  providerMetadata: undefined,
                  text: "ok",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              },
            } as never,
            workflowSubmitPort: submitPort,
            fileSystemPort,
            sessionStore: input.store,
          },
        );
        // 照生产（persistActorSession）：会话行先落库，复制才有 FK 可依。
        await runtime.ensureSessionPersistedForExternalActivity(
          `workflow actor ${refToString(actor)}`,
        );
        return runtime;
      },
    })(NOOP_SINK);
    return { driver, requests, seeds };
  }

  function journalFor(runId: string): InMemoryJournalStore {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    return journal;
  }

  it("按边界复制源会话前缀进新铸会话，且前驱转录一字不动", async () => {
    await withSessionStore(async (store) => {
      const source = await recordSourceRun(store, "dwfrun-src");
      const sourceMessages = await store.messages({ sessionID: source.sessionId });
      const amendRunId = "dwfrun-amend";
      const { driver, seeds } = amendDriver({
        journal: journalFor(amendRunId),
        runId: amendRunId,
        store,
      });

      // 第一条 ask 命中缓存、第二条分歧：种子 = 第一条 ask 的边界。
      const ref = await driver.createActorSession(
        ACTOR_ONE,
        { name: "worker" },
        {
          sourceSessionId: source.sessionId,
          messageCount: source.boundaries[0]!,
          resolvedModel: "anthropic/some-model",
        },
      );

      // 新会话 id 照常铸（mint 规则不变），不是源会话。
      expect(ref.id).toBe(mintActorSessionId(amendRunId, ACTOR_ONE));
      expect(ref.id).not.toBe(source.sessionId);

      const copied = await store.messages({ sessionID: ref.id as SessionId });
      expect(copied).toHaveLength(source.boundaries[0]!);
      expect(copied.map((m) => m.info.role)).toEqual(
        sourceMessages.slice(0, source.boundaries[0]!).map((m) => m.info.role),
      );
      // 每条都是**副本**：id 必须是新的，否则 upsert 会把前驱那一行搬进新会话。
      for (const [index, message] of copied.entries()) {
        expect(message.info.id).not.toBe(sourceMessages[index]!.info.id);
        expect(message.info.sessionID).toBe(ref.id);
        for (const part of message.parts) expect(part.sessionID).toBe(ref.id);
      }
      // 前驱只读：源会话还是原来那四条，一条不多不少、id 不变。
      const sourceAfter = await store.messages({ sessionID: source.sessionId });
      expect(sourceAfter.map((m) => m.info.id)).toEqual(sourceMessages.map((m) => m.info.id));

      // 种子原样交到 runtime 工厂手上——pin 承袭（launch 侧据它算 pinnedModel）的接缝。
      expect(seeds).toEqual([
        {
          sourceSessionId: source.sessionId,
          messageCount: source.boundaries[0]!,
          resolvedModel: "anthropic/some-model",
        },
      ]);
    });
  }, 40_000);

  it("复制来的转录进入 runtime 上下文：分歧后的第一次模型请求带着它", async () => {
    await withSessionStore(async (store) => {
      const source = await recordSourceRun(store, "dwfrun-src2");
      const amendRunId = "dwfrun-amend2";
      const { driver, requests } = amendDriver({
        journal: journalFor(amendRunId),
        runId: amendRunId,
        store,
      });

      const ref = await driver.createActorSession(
        ACTOR_ONE,
        { name: "worker" },
        {
          sourceSessionId: source.sessionId,
          messageCount: source.boundaries[0]!,
        },
      );

      // startAsk 是 fire-and-forget（Boundary B 契约），所以观察面是模型请求本身。
      driver.startAsk(
        ref,
        { siteId: "ask#1", ordinal: 1 },
        {
          instructions: "continue from where we left off",
          typed: false,
        },
      );
      await waitFor(() => requests.length > 0);

      const conversation = JSON.stringify(requests[0]?.messages ?? []);
      // 源转录的第一句问话必须在上下文里——全保真截断的全部意义。
      expect(conversation).toContain("first question");
      expect(conversation).toContain("continue from where we left off");
      // 边界之后的那一轮不在（截断，不是全量复制）。
      expect(conversation).not.toContain("second question");
    });
  }, 40_000);

  it("幂等：目标会话已有内容时不再复制（崩溃后重挂同一个会话 id）", async () => {
    await withSessionStore(async (store) => {
      const source = await recordSourceRun(store, "dwfrun-src3");
      const amendRunId = "dwfrun-amend3";
      const journal = journalFor(amendRunId);
      const seed: ActorSessionSeed = {
        sourceSessionId: source.sessionId,
        messageCount: source.boundaries[0]!,
      };

      const first = amendDriver({ journal, runId: amendRunId, store });
      const ref = await first.driver.createActorSession(ACTOR_ONE, { name: "worker" }, seed);
      const afterFirst = await store.messages({ sessionID: ref.id as SessionId });
      expect(afterFirst).toHaveLength(seed.messageCount);

      // 重挂：会话 id 由 (runId, actorRef) 纯确定，所以第二次铸出的是同一个，且已装着上一世
      // 「复制来的 + 新产的」内容。再抄一遍就是把上文翻倍——所以这一次必须一个字都不写。
      journal.putActor({ ...ACTOR_ONE, runId: amendRunId, sessionId: ref.id });
      const counting = countingTranscriptStore(store);
      const second = amendDriver({
        journal,
        runId: amendRunId,
        store,
        transcriptStore: counting.store,
      });
      await second.driver.createActorSession(ACTOR_ONE, { name: "worker" }, seed);

      expect(counting.writes).toEqual({ messages: 0, parts: 0 });
      const afterSecond = await store.messages({ sessionID: ref.id as SessionId });
      expect(afterSecond.map((m) => m.info.id)).toEqual(afterFirst.map((m) => m.info.id));
    });
  }, 40_000);

  it("源会话不存在或短于边界 → 结构化大声失败", async () => {
    await withSessionStore(async (store) => {
      const source = await recordSourceRun(store, "dwfrun-src4");
      const amendRunId = "dwfrun-amend4";

      const missing = amendDriver({ journal: journalFor(amendRunId), runId: amendRunId, store });
      await expect(
        missing.driver.createActorSession(
          ACTOR_ONE,
          { name: "worker" },
          {
            sourceSessionId: "sess_never-existed",
            messageCount: 2,
          },
        ),
      ).rejects.toMatchObject({ code: "DriverError", mismatch: { expected: "2", got: "0" } });

      const short = amendDriver({
        journal: journalFor("dwfrun-amend4b"),
        runId: "dwfrun-amend4b",
        store,
      });
      const tooFar = source.boundaries[1]! + 1;
      await expect(
        short.driver.createActorSession(
          ACTOR_ONE,
          { name: "worker" },
          {
            sourceSessionId: source.sessionId,
            messageCount: tooFar,
          },
        ),
      ).rejects.toMatchObject({
        code: "DriverError",
        mismatch: { expected: String(tooFar), got: String(source.boundaries[1]) },
      });
    });
  }, 40_000);

  it("无种子 → 全新空会话（byte-for-byte 今天的行为）", async () => {
    await withSessionStore(async (store) => {
      await recordSourceRun(store, "dwfrun-src5");
      const amendRunId = "dwfrun-fresh";
      const { driver, seeds } = amendDriver({
        journal: journalFor(amendRunId),
        runId: amendRunId,
        store,
      });

      const ref = await driver.createActorSession(ACTOR_ONE, { name: "worker" });

      expect(seeds).toEqual([undefined]);
      expect(await store.messages({ sessionID: ref.id as SessionId })).toHaveLength(0);
    });
  }, 40_000);
});

// ── ask 质量尾注（docs/dynamic-workflow/authoring.md「Each ask」）──
//
// 每个 ask 的指令后面都跟一段内容标准；typed 时 schema 尾注紧随其后。两段都在 scheduler 算完
// inputHash 之后追加，所以缓存身份不变——这里顺带钉住 journal 里的 inputHash 与原始指令一致。
describe("workflow driver — quality epilogue on every ask", () => {
  const STANDARD = "Standard for this result:";

  it("typed ask: instructions, then the standard, then the schema epilogue", async () => {
    const valid = { title: "Repo", points: ["x"] };
    const { modelCalls } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: { "actor#1@1": [{ kind: "submit", result: valid }] },
    });
    const prompt = modelCalls["actor#1@1"]?.prompts[0] ?? "";
    const instructions = prompt.indexOf("Summarize the repo");
    const standard = prompt.indexOf(STANDARD);
    const schema = prompt.indexOf("call the `submit_result` tool to submit your final result");
    expect(instructions).toBeGreaterThanOrEqual(0);
    expect(instructions).toBeLessThan(standard);
    expect(standard).toBeLessThan(schema);
    expect(prompt).toContain("A check counts as passed only if you ran it during this ask.");
    // 2026-09-08 追记：default 档还要求按 ask 点名的尺度跑检查，替身不算。
    expect(prompt).toContain("Run the check the ask names, at the scale it names.");
    expect(prompt).toContain("call `escalate` instead of inventing a value");
    // schema 没有 evidence / confidence 字段：两行不出现。
    expect(prompt).not.toContain("`evidence` field");
    expect(prompt).not.toContain("Rate `confidence`");
  });

  it("untyped ask: instructions then the standard, no schema epilogue", async () => {
    const script = [
      'const worker = agent("worker");',
      'const answer = await worker.ask("What is 2 + 2?");',
      "return answer;",
    ].join("\n");
    const { modelCalls, settlement } = await runDriverScript(script, {
      actorScripts: { "actor#1@1": [{ kind: "text", text: "4" }] },
    });
    expect(settlement.status).toBe("completed");
    const prompt = modelCalls["actor#1@1"]?.prompts[0] ?? "";
    expect(prompt.indexOf("What is 2 + 2?")).toBeLessThan(prompt.indexOf(STANDARD));
    expect(prompt).not.toContain("submit_result");
  });

  it("names the evidence and confidence fields when the schema declares them", async () => {
    const script = [
      "interface Finding { where: string; evidence: string; confidence: number; }",
      'const worker = agent("worker");',
      'const f = await worker.ask<Finding>("Find the bug");',
      "return f;",
    ].join("\n");
    const { modelCalls } = await runDriverScript(script, {
      actorScripts: {
        "actor#1@1": [
          { kind: "submit", result: { where: "a.ts:1", evidence: "read it", confidence: 0.5 } },
        ],
      },
    });
    const prompt = modelCalls["actor#1@1"]?.prompts[0] ?? "";
    expect(prompt).toContain("Put each finding's citation in its `evidence` field.");
    expect(prompt).toContain("Rate `confidence` honestly");
  });

  it("nudge prompts carry no epilogue and the journaled inputHash ignores it", async () => {
    const valid = { title: "Repo", points: ["x"] };
    const { modelCalls, journal } = await runDriverScript(TYPED_ASK_SCRIPT, {
      actorScripts: {
        "actor#1@1": [
          { kind: "text", text: "no submit yet" },
          { kind: "submit", result: valid },
        ],
      },
    });
    const prompts = modelCalls["actor#1@1"]?.prompts ?? [];
    expect(prompts.length).toBe(2);
    expect(prompts[0]).toContain(STANDARD);
    expect(prompts[1]).not.toContain(STANDARD);
    expect(prompts[1]).toContain("You ended your turn without submitting a result.");
    // 缓存身份 = 原始指令的哈希，与尾注无关。
    expect(journal.getNode(RUN, "ask#1", 1)?.inputHash).toBe(inputHash("Summarize the repo"));
  });

  // docs/dynamic-workflow/transcript-and-notifications.md：GUI 要把尾注折起来，边界由 driver 标记——
  // 它是拼这段文本的人。边界随用户消息 metadata 落库（全文仍在 text part 里，模型历史与
  // 转录复制不变）；nudge 轮整条都是引擎文本，边界为 0。
  it("marks where the epilogue starts on the persisted user message; nudge is all epilogue", async () => {
    await withSessionStore(async (store) => {
      const runId = "dwfrun-epilogue-fold";
      const valid = { title: "Repo", points: ["x"] };
      await runDriverScript(TYPED_ASK_SCRIPT, {
        runId,
        sessionStore: store,
        actorScripts: {
          "actor#1@1": [
            { kind: "text", text: "no submit yet" },
            { kind: "submit", result: valid },
          ],
        },
      });
      const persisted = await store.messages({ sessionID: mintActorSessionId(runId, ACTOR_ONE) });
      // model-only 的上下文公告（如 date）不是 ask 消息，不带 epilogue 标记。
      const users = persisted.filter(
        (message) =>
          message.info.role === "user" && message.info.semantics?.kind !== "system_reminder",
      );
      expect(users.length).toBe(2);
      const askText = users[0]?.parts.find((part) => part.type === "text");
      expect(askText?.type === "text" ? askText.text : "").toContain(STANDARD);
      expect(users[0]?.info.metadata?.epilogueStart).toBe("Summarize the repo".length);
      expect(users[1]?.info.metadata?.epilogueStart).toBe(0);
    });
  }, 30_000);
});

// ————————————————————————————————————————————————————————————————
// run 结算后的 actor runtime 收口（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）
// 引擎在 run-settled 之后恰好调一次 driver.dispose；driver 对每个 actor runtime 跑 app 关会话的
// 同一条链（closeBrowserSession），有在飞 turn 的会话等它落地再关。
// ————————————————————————————————————————————————————————————————

describe("workflow driver — 结算后释放 actor runtime", () => {
  const NOOP_SINK: WorkflowReportSink = {
    askSubmitAttempted: () => {},
    askTurnEnded: () => {},
    askProgress: () => {},
    askStats: () => {},
    askFailed: () => {},
    askWaiting: () => {},
    askExecuting: () => {},
    askMutating: () => {},
    concurrencyChanged: () => {},
    stopRun: () => {},
    runStalled: () => {},
  };

  /** 桩 runtime：executeTurn 在 abort 时 reject（模拟被取消的在飞 turn），closeBrowserSession 可被 spy。 */
  function stubRuntime(close: () => Promise<void> = async () => {}) {
    const closeBrowserSession = vi.fn(close);
    const executeTurn = vi.fn(
      (_input: string, _b: unknown, opts?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("workflow ask cancelled")),
            {
              once: true,
            },
          );
        }),
    );
    return {
      closeBrowserSession,
      executeTurn,
      close: async () => {
        await Promise.allSettled(executeTurn.mock.results.map((result) => result.value));
        await closeBrowserSession();
      },
    };
  }

  function driverWith(
    runtimes: Record<string, ReturnType<typeof stubRuntime>>,
    logger?: { warn: (message: string, context?: Record<string, unknown>) => void },
  ) {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    const makeDriver = createAgentRuntimeWorkflowDriver({
      journal,
      emit: () => {},
      escalationRegistry: createWorkflowEscalationRegistry(),
      fileSystemPort: fakeFileSystemPort({}),
      cwd: process.cwd(),
      runId: RUN,
      ...(logger === undefined ? {} : { logger: logger as never }),
      runtimeFactory: ({ actor }) => runtimes[refToString(actor)] as never,
    });
    return makeDriver(NOOP_SINK);
  }

  const A1: ActorRef = { siteId: "actor#1", ordinal: 1 };
  const A2: ActorRef = { siteId: "actor#2", ordinal: 1 };
  const flushMicrotasks = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it("创建 actor 尚未返回时关闭，等待迟到实例释放且不再接收新 actor", async () => {
    const factory = Promise.withResolvers<ReturnType<typeof stubRuntime>>();
    const cleanup = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const runtime = stubRuntime(async () => {
      released.resolve();
      await cleanup.promise;
    });
    let probe!: { drain(): Promise<void> };
    const driver = createAgentRuntimeWorkflowDriver({
      journal: new InMemoryJournalStore(),
      emit: () => {},
      escalationRegistry: createWorkflowEscalationRegistry(),
      fileSystemPort: fakeFileSystemPort({}),
      cwd: process.cwd(),
      runId: RUN,
      runtimeFactory: async () => (await factory.promise) as never,
      onQuiescenceProbe: (value) => {
        probe = value;
      },
    })(NOOP_SINK);
    const creating = driver.createActorSession(A1, {});
    const rejected = expect(creating).rejects.toThrow(/closed/);
    driver.dispose?.();
    let drained = false;
    const draining = probe.drain().then(() => {
      drained = true;
    });
    await flushMicrotasks();
    expect(drained).toBe(false);
    factory.resolve(runtime);
    await released.promise;
    expect(drained).toBe(false);
    cleanup.resolve();
    await rejected;
    await draining;
    expect(runtime.closeBrowserSession).toHaveBeenCalledTimes(1);
    await expect(driver.createActorSession(A2, {})).rejects.toThrow(/closed/);
  });

  it("无在飞 turn 的会话立即关；有在飞 turn 的会话等 turn 落地后才关", async () => {
    const idle = stubRuntime();
    const busy = stubRuntime();
    const driver = driverWith({ "actor#1@1": idle, "actor#2@1": busy });
    await driver.createActorSession(A1, {});
    const s2 = await driver.createActorSession(A2, {});
    const instance = { siteId: "ask#1", ordinal: 1 };
    driver.startAsk(s2, instance, { instructions: "go", typed: false });
    expect(busy.executeTurn).toHaveBeenCalledTimes(1);

    // 引擎结算：先 cancelAsk（在飞 ask 中止），再 dispose——与 engine.cancel / complete 的顺序一致。
    driver.cancelAsk(instance);
    driver.dispose?.();
    expect(idle.closeBrowserSession).not.toHaveBeenCalled(); // 经 Promise.resolve().then 排队
    await flushMicrotasks();
    expect(idle.closeBrowserSession).toHaveBeenCalledTimes(1);
    expect(busy.closeBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("在飞 turn 未落地前不关它的 runtime（等待是载荷性的：askStats 在 settle 之后才到）", async () => {
    const busy = stubRuntime();
    // 这个桩的 turn 不响应 abort：模拟一条仍在收尾的 turn。
    busy.executeTurn.mockImplementation(() => new Promise(() => {}));
    const driver = driverWith({ "actor#1@1": busy });
    const s1 = await driver.createActorSession(A1, {});
    driver.startAsk(s1, { siteId: "ask#1", ordinal: 1 }, { instructions: "go", typed: false });

    driver.dispose?.();
    await flushMicrotasks();
    expect(busy.closeBrowserSession).not.toHaveBeenCalled();
  });

  it("幂等：dispose 两次，每个 runtime 只关一次", async () => {
    const r = stubRuntime();
    const driver = driverWith({ "actor#1@1": r });
    await driver.createActorSession(A1, {});
    driver.dispose?.();
    driver.dispose?.();
    await flushMicrotasks();
    expect(r.closeBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("关闭失败只 warn（带 sessionId），结算不因它抛", async () => {
    const r = stubRuntime(async () => {
      throw new Error("browser backend gone");
    });
    const warns: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const driver = driverWith(
      { "actor#1@1": r },
      { warn: (message, context) => warns.push({ message, context }) },
    );
    await driver.createActorSession(A1, {});
    expect(() => driver.dispose?.()).not.toThrow();
    await flushMicrotasks();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.context).toMatchObject({
      errorMessage: "browser backend gone",
      event: "dynamic_workflow.actor_runtime.close_failed",
      sessionId: mintActorSessionId(RUN, A1),
    });
  });

  it("真实管线：run 结算后每个 actor runtime 关闭链恰好一次，且 runtime 可被 GC 回收", async () => {
    const script = [
      "interface A { text: string }",
      'const w1 = agent("w1", "You work.");',
      'const w2 = agent("w2", "You also work.");',
      'const [a, b] = await Promise.all([w1.ask<A>("first"), w2.ask<A>("second")]);',
      "return `${a.text}/${b.text}`;",
    ].join("\n");

    // 计数器不用 vi.spyOn：spy 注册表是模块级的，会把被 spy 的实例根住，GC 断言就废了。
    // 包装器只挂在实例自己身上，不从外部引用 runtime。
    const closes = new Map<string, number>();
    const refs = new Map<string, WeakRef<object>>();
    const { settlement } = await runDriverScript(script, {
      actorScripts: {
        "actor#1@1": [{ kind: "submit", result: { text: "A" } }],
        "actor#2@1": [{ kind: "submit", result: { text: "B" } }],
      },
      onRuntimeCreated: (runtime, key) => {
        closes.set(key, 0);
        const original = runtime.closeBrowserSession.bind(runtime);
        (runtime as { closeBrowserSession: () => Promise<void> }).closeBrowserSession = () => {
          closes.set(key, (closes.get(key) ?? 0) + 1);
          return original();
        };
        refs.set(key, new WeakRef(runtime));
      },
    });
    expect(settlement).toEqual({ status: "completed", artifact: "A/B" });
    expect([...closes.keys()].sort()).toEqual(["actor#1@1", "actor#2@1"]);

    // 关闭链在 turn 落地后才跑（accept 路径 stats 晚于 settle，turn 的收尾还要等持久化）：轮询等它。
    await waitFor(() => [...closes.values()].every((count) => count >= 1));
    for (const [key, count] of closes) expect(count, key).toBe(1);

    // GC 可回收性：强制 full GC 后，没有任何根再握着 actor runtime。
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    for (
      let round = 0;
      round < 3 && [...refs.values()].some((ref) => ref.deref() !== undefined);
      round++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc();
    }
    for (const [key, ref] of refs) expect(ref.deref(), `${key} 仍被某个根引用`).toBeUndefined();
  });
});
