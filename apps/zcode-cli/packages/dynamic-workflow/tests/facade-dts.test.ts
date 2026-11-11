import { describe, expect, it } from "vitest";
import {
  analyzeWorkflowScript,
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  FACADE_DTS,
  lowerWorkflow,
  SNIPPET_FACADE_DTS,
  WORLD_READ_CAPS,
  WORLD_RUN_LITERAL_CODE,
} from "../src/index.js";

describe("facade dts segments", () => {
  // 注释只写参考层：做什么、返回什么、何时拒绝或让 run 失败、上限、实参的编译期规则
  // （docs/dynamic-workflow/authoring.md「The facade」）。判断层在技能正文里只说一次；facade
  // 只经技能 §16.2 进上下文，注释复述正文等于每次写作会话付两遍，且是会漂移的那一份。
  // 2026-09-30 去重前是 23 275 字节，其中约 2 万是注释。
  // 2026-11-02 上限 14 000 → 14 200：persona 新增 `budget.webSearch`（一行声明 + 一行参考注释，
  // 约 110 字节）时 facade 只剩 1 字节余量；新成员的参考层文字是真增量，规则仍是只放参考层。
  it("stays a reference: FACADE_DTS is under 14 200 bytes", () => {
    expect(Buffer.byteLength(FACADE_DTS, "utf8")).toBeLessThan(14_200);
  });

  // args 在**两个** facade 里都在：snippet 的「逐字可迁移」不变式要求一段引用 args 的
  // saved 脚本能原样丢进 EvalWorkflowSnippet 编译（运行时它是 `{}`）。
  it("SNIPPET_FACADE_DTS keeps world reads, world.run, log and args, drops actors/report/artifact/phase", () => {
    expect(SNIPPET_FACADE_DTS).toContain("declare const args");
    expect(FACADE_DTS).toContain("declare const args");
    // run 身份同理：引用 run.id 的片段要能逐字迁进工作流（片段里是一个一次性的 dwfeval- id）。
    expect(SNIPPET_FACADE_DTS).toContain("declare const run");
    expect(FACADE_DTS).toContain("declare const run");
    expect(SNIPPET_FACADE_DTS).toContain("declare const files");
    expect(SNIPPET_FACADE_DTS).toContain("declare const git");
    expect(SNIPPET_FACADE_DTS).toContain("declare const world");
    expect(SNIPPET_FACADE_DTS).toContain("declare function log");
    // stream 段在两个 facade 里都在：流水线的纯逻辑正是片段要排练的东西。
    expect(SNIPPET_FACADE_DTS).toContain("declare function channel");
    expect(SNIPPET_FACADE_DTS).toContain("declare function future");
    expect(SNIPPET_FACADE_DTS).toContain("declare interface Channel<T>");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function agent");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function report");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function phase");
    // 模型声明属于 actor：snippet 里没有子代理，也就没有可选的模型。
    expect(FACADE_DTS).toContain("declare function model");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function model");
    expect(SNIPPET_FACADE_DTS).not.toContain("ModelRef");
    // 产物是「run 交给用户的产出」，而 snippet 没有 run：整段刻意缺席，连类型都不留。
    expect(FACADE_DTS).toContain("declare const artifact");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare const artifact");
    expect(SNIPPET_FACADE_DTS).not.toContain("ArtifactRef");
    // 留白只在完整 facade 里（docs/dynamic-workflow/authoring.md「Holes」）：片段没有 run。
    expect(FACADE_DTS).toContain(
      "declare function hole<T>(name: string, prompt?: string): Promise<T>;",
    );
    expect(FACADE_DTS).toContain(
      "declare function hole<T>(name: string, body: () => Promise<T>): Promise<T>;",
    );
    expect(FACADE_DTS).toContain(
      "declare function hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;",
    );
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function hole");
  });

  it("rejects hole() in the snippet facade at compile time (TS2304)", () => {
    const workflow = createWorkflowProgram(`return await hole<string>("决定");`, {
      facadeDts: SNIPPET_FACADE_DTS,
    });
    const diagnostics = collectDiagnostics(workflow.program);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'hole'");
  });
});

describe("snippet compilation (scratch facade)", () => {
  const compileSnippet = (scriptText: string) =>
    createWorkflowProgram(scriptText, { facadeDts: SNIPPET_FACADE_DTS });

  it("compiles a world-read + pure-logic snippet cleanly", () => {
    const workflow = compileSnippet(
      `const paths = await files.glob("src/**/*.ts");\n` +
        `log(\`found \${paths.length}\`);\n` +
        `return paths.filter((p) => p.endsWith(".test.ts"));`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
  });

  it("rejects agent() at compile time (TS2304, not a runtime surprise)", () => {
    const workflow = compileSnippet(`return await agent("a").ask("do it");`);
    const diagnostics = collectDiagnostics(workflow.program);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'agent'");
  });

  it("rejects report() and phase() the same way", () => {
    for (const source of [`report({ found: 1 });`, `phase("gate");`]) {
      const workflow = compileSnippet(source);
      expect(collectDiagnostics(workflow.program).length).toBeGreaterThan(0);
    }
  });

  // facade 身份按声明文件名判定（registry / sites / misuse / lowering 五处）；scratch
  // facade 若换了文件名，站点收集会静默变空、files.glob 不再降级到 __host.worldRead——
  // snippet 编译通过却什么都不做。这条钉住「同名注入」的不变量。
  it("lowers files.glob in a snippet to a world-read site (facade filename invariant)", () => {
    const workflow = compileSnippet(`return await files.glob("*.ts");`);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain(`__host.worldRead("world-read#1", "glob"`);
  });
});

// 产物的**类型面**（docs/dynamic-workflow/authoring.md「Two families」）：两族成员的语义
// 不对称必须在类型上就成立——内容成员可 await 出 ArtifactRef，预置成员是 void。
describe("artifact facade (type surface)", () => {
  const diagnosticsOf = (scriptText: string) =>
    collectDiagnostics(createWorkflowProgram(scriptText).program);

  it("types content members as Promise<ArtifactRef>", () => {
    expect(
      diagnosticsOf(
        `const ref = await artifact.file("book", "out/book.pdf", { title: "Book", contentType: "application/pdf" });\n` +
          `const md = await artifact.markdown("notes", "# hi", { description: "d" });\n` +
          `return ref.id + String(ref.version) + md.id;`,
      ),
    ).toEqual([]);
  });

  it("rejects using a content member's result as anything but an ArtifactRef", () => {
    const diagnostics = diagnosticsOf(`const n: number = await artifact.file("book", "b.pdf");`);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("not assignable");
  });

  it("types preset members as void (a declaration has nothing to await)", () => {
    expect(
      diagnosticsOf(
        `artifact.chart("perf", { type: "line", x: { field: "round" }, y: [{ field: "ms", label: "ms" }], scale: "log", baseline: { field: "budget" } });\n` +
          `artifact.table("rows", { columns: [{ field: "name" }], key: "name" });\n` +
          `artifact.metrics("m", { metrics: [{ field: "p95", unit: "ms" }] });\n` +
          `artifact.board("b", { key: "id", status: "state", columns: ["todo", "done"], detail: [{ field: "owner" }] });`,
      ),
    ).toEqual([]);
    const diagnostics = diagnosticsOf(
      `const v: number = artifact.chart("perf", { x: { field: "r" }, y: { field: "m" } });`,
    );
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("lets a board name itself and its cards separately (the cardTitle rename)", () => {
    expect(
      diagnosticsOf(
        `artifact.board("b", { title: "内存回归", key: "id", status: "state", columns: ["todo"], cardTitle: "name" });`,
      ),
    ).toEqual([]);
    // 旧名字不再是 BoardSpec 的字段名之外的东西：写 title 就是给板子起名，不是给卡片取标题。
    expect(FACADE_DTS).toContain("cardTitle?: string");
  });

  it("accepts primary on every member and rejects a non-boolean one", () => {
    expect(
      diagnosticsOf(
        `await artifact.file("book", "b.pdf", { primary: true });\n` +
          `await artifact.markdown("notes", "# hi", { title: "Notes", primary: false });\n` +
          `artifact.board("b", { key: "id", status: "state", columns: ["todo"], primary: true });`,
      ),
    ).toEqual([]);
    expect(
      diagnosticsOf(`await artifact.file("book", "b.pdf", { primary: "yes" });`).length,
    ).toBeGreaterThan(0);
    expect(FACADE_DTS).toContain("primary?: boolean");
  });

  it("rejects a malformed spec at compile time (missing y, wrong chart type)", () => {
    expect(diagnosticsOf(`artifact.chart("perf", { x: { field: "r" } });`).length).toBeGreaterThan(
      0,
    );
    expect(
      diagnosticsOf(
        `artifact.chart("perf", { x: { field: "r" }, y: { field: "m" }, type: "pie" });`,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("makes report's second argument an optional string", () => {
    expect(diagnosticsOf(`report({ a: 1 });\nreport({ a: 1 }, "perf");`)).toEqual([]);
    expect(diagnosticsOf(`report({ a: 1 }, 1);`).length).toBeGreaterThan(0);
  });

  it("leaves artifact out of the snippet facade (TS2304, not a runtime surprise)", () => {
    const workflow = createWorkflowProgram(`await artifact.file("book", "b.pdf");`, {
      facadeDts: SNIPPET_FACADE_DTS,
    });
    const diagnostics = collectDiagnostics(workflow.program);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'artifact'");
  });
});

describe("world.run (compile side)", () => {
  it("typechecks and lowers to the run op with positional args", () => {
    const workflow = createWorkflowProgram(
      `const r = await world.run("lean", ["--make", "proof.lean"], { timeoutMs: 60000 });\n` +
        `return r.exitCode === 0;`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain(`__host.worldRead("world-read#1", "run"`);
  });

  it("typechecks every opts.output mode and rejects other shapes at compile time", () => {
    const ok =
      `const a = await world.run("pnpm", ["test"], { output: "full" });\n` +
      `const b = await world.run("pnpm", ["test"], { output: "discard", timeoutMs: 600000 });\n` +
      `const c = await world.run("pnpm", ["test"], { output: { tail: 16384 } });\n` +
      `return a.exitCode + b.exitCode + c.stderr.length;`;
    for (const facadeDts of [FACADE_DTS, SNIPPET_FACADE_DTS]) {
      expect(collectDiagnostics(createWorkflowProgram(ok, { facadeDts }).program)).toEqual([]);
    }
    for (const bad of [`"quiet"`, `{ head: 10 }`, `{ tail: "10" }`]) {
      const workflow = createWorkflowProgram(
        `await world.run("pnpm", ["test"], { output: ${bad} });`,
      );
      expect(collectDiagnostics(workflow.program).length).toBeGreaterThan(0);
    }
  });

  it("states the run output cap the driver enforces (the prose number follows the constant)", () => {
    expect(WORLD_READ_CAPS.runStdoutMaxBytes).toBe(WORLD_READ_CAPS.runStderrMaxBytes);
    expect(FACADE_DTS).toContain(`n <= ${WORLD_READ_CAPS.runStdoutMaxBytes} (16 MiB)`);
    expect(WORLD_READ_CAPS.runStdoutMaxBytes).toBe(16 * 1024 * 1024);
  });

  it("collects the deduplicated, sorted command set from literals", () => {
    const workflow = createWorkflowProgram(
      `await world.run("node", ["-e", "0"]);\n` +
        `await world.run(\`lean\`, ["a.lean"]);\n` +
        `await world.run("node", ["-e", "1"]);`,
    );
    const table = collectSites(workflow);
    const { commands, diagnostics } = collectWorldRunCommands(workflow, table);
    expect(diagnostics).toEqual([]);
    expect(commands).toEqual(["lean", "node"]);
  });

  it("rejects a non-literal cmd with a positioned WORLD_RUN_LITERAL_CODE diagnostic", () => {
    const workflow = createWorkflowProgram(
      `const cmd = "lean";\nconst r = await world.run(cmd, []);\nreturn r.exitCode;`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const { diagnostics } = collectWorldRunCommands(workflow, table);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(WORLD_RUN_LITERAL_CODE);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.message).toContain("string literal");
    // analyzeWorkflowScript 把它与 misuse 同席（ok:false）。
    const analyzed = analyzeWorkflowScript(
      `const cmd = "lean";\nconst r = await world.run(cmd, []);\nreturn r.exitCode;`,
    );
    expect(analyzed.ok).toBe(false);
    expect(analyzed.diagnostics[0]?.code).toBe(WORLD_RUN_LITERAL_CODE);
  });

  it("rejects a substitution template cmd", () => {
    const workflow = createWorkflowProgram(
      `const suffix = "n";\nawait world.run(\`lea\${suffix}\`, []);`,
    );
    const table = collectSites(workflow);
    const { diagnostics } = collectWorldRunCommands(workflow, table);
    expect(diagnostics).toHaveLength(1);
  });

  it("keeps the world.run step label carrying the command (confirmation surface)", () => {
    const analyzed = analyzeWorkflowScript(`await world.run("lean", ["a.lean"]);`);
    expect(analyzed.ok).toBe(true);
    const step = analyzed.causality?.steps.find((s) => s.label.includes("lean"));
    expect(step).toBeDefined();
    expect(step?.label).toBe("run lean");
  });
});

// args 的降级（docs/dynamic-workflow/launch.md「Running a saved workflow」）：
// 它是 facade 里唯一一个**值**而不是可调用物，所以走标识符级改写而不是站点。
describe("args lowering", () => {
  it("lowers a facade args read to __host.args, with no site of its own", () => {
    const workflow = createWorkflowProgram(`const target = String(args.target);\nreturn target;`);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain("__host.args.target");
    // 读一个值不是等待点：它不占 site id，也就不会长出因果图节点。
    expect(lowered.siteIds).toEqual([]);
  });

  it("lowers args in the snippet facade too (verbatim portability)", () => {
    const workflow = createWorkflowProgram(`return String(args.x);`, {
      facadeDts: SNIPPET_FACADE_DTS,
    });
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).toContain("__host.args.x");
  });

  // 判定按 checker 解析结果，不按名字：脚本自己声明的 args 解析到脚本文件的符号。
  // 名字启发式会把这段改写成 `const __host.args = ...`，一个运行期 SyntaxError。
  it("leaves a script-declared local `args` alone", () => {
    const workflow = createWorkflowProgram(`const args = { local: 1 };\nreturn args.local;`);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).not.toContain("__host.args");
    expect(lowered.code).toContain("args.local");
  });

  it("leaves a parameter named args and an unrelated `.args` property alone", () => {
    const workflow = createWorkflowProgram(
      [
        "function pick(args: { a: number }): number { return args.a; }",
        "const holder = { args: 7 };",
        "return pick({ a: 1 }) + holder.args;",
      ].join("\n"),
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).not.toContain("__host.args");
  });

  // 一段同时用 args 和 ask 的脚本：改写不能破坏站点，站点也不能吞掉 args。
  it("coexists with ask sites", () => {
    const workflow = createWorkflowProgram(
      `const r = await agent("w").ask(String(args.topic));\nreturn r;`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain("__host.args.topic");
    expect(lowered.code).toContain('__host.ask("ask#1"');
  });
});

// run 身份的降级：与 args 同一条标识符级改写（docs/dynamic-workflow/authoring.md「The run's
// identity」）。读它不是等待点，不占站点。
describe("run identity lowering", () => {
  it("lowers a facade run read to __host.run, with no site of its own", () => {
    const workflow = createWorkflowProgram(
      `log(\`run \${run.id} amends \${run.resumedFrom ?? "none"}\`);\nreturn run.id;`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).toContain("__host.run.id");
    expect(lowered.code).toContain("__host.run.resumedFrom");
    expect(lowered.siteIds).toEqual([]);
  });

  // `world.run` 的 `run` 是属性名，不是这个值；改写它会得到 `world.__host.run`。
  it("leaves world.run alone next to a run read", () => {
    const workflow = createWorkflowProgram(
      `const r = await world.run("node", ["-v"]);\nreturn [run.id, r.exitCode];`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).toContain("__host.run.id");
    expect(lowered.code).not.toContain("world.__host");
    expect(lowered.siteIds).toHaveLength(1);
  });

  // 已有脚本常把一次命令结果叫 `run`：它解析到脚本自己的符号，原样保留、照常遮蔽。
  it("leaves a script-declared local `run` alone", () => {
    const workflow = createWorkflowProgram(`const run = { id: "mine" };\nreturn run.id;`);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).not.toContain("__host.run");
  });

  it("lowers run in the snippet facade too (verbatim portability)", () => {
    const workflow = createWorkflowProgram(`return run.id;`, { facadeDts: SNIPPET_FACADE_DTS });
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).toContain("__host.run.id");
  });
});
