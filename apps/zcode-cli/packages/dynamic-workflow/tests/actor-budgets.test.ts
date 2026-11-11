import { describe, expect, it } from "vitest";
import { analyzeWorkflowScript } from "../src/index.js";
import { BUDGET_VALUE_CODE } from "../src/analysis/actor-budgets.js";
import { normalizePersona, personaIdentity } from "../src/engine/persona.js";

// 子代理 WebSearch 预算（9013，docs/dynamic-workflow/authoring.md「A subagent's search budget」）：
// `budget.webSearch` 的类型必须是 0–1024 整数字面量或其联合；引擎只保留合法值，且预算不进缓存身份。

function hits(scriptText: string) {
  return analyzeWorkflowScript(scriptText).diagnostics.filter((d) => d.code === BUDGET_VALUE_CODE);
}

describe("persona budget: compile-time rule 9013", () => {
  it("accepts an inline literal, a const, a ternary, 0 and 1024", () => {
    expect(
      hits(
        `const N = 512;\nconst wide = args.wide === true;\n` +
          `agent("a", { budget: { webSearch: 256 } });\n` +
          `agent("b", { budget: { webSearch: N } });\n` +
          `agent("c", { budget: { webSearch: wide ? 1024 : 0 } });\n` +
          `agent("d", "just a system prompt");\nreturn 1;`,
      ),
    ).toEqual([]);
  });

  it("rejects a widened number, an out-of-range value and a fraction", () => {
    const found = hits(
      `let n = 10;\n` +
        `agent("a", { budget: { webSearch: n } });\n` +
        `agent("b", { budget: { webSearch: 5000 } });\n` +
        `agent("c", { budget: { webSearch: 1.5 } });\n` +
        `agent("d", { budget: { webSearch: -1 } });\nreturn 1;`,
    );
    expect(found.map((d) => d.line)).toEqual([2, 3, 4, 5]);
  });

  it("rejects a persona object built into a variable, whose number widens", () => {
    expect(
      hits(`const p = { budget: { webSearch: 64 } };\nagent("a", p);\nreturn 1;`),
    ).toHaveLength(1);
  });
});

describe("persona budget: engine normalization and cache identity", () => {
  it("keeps a legal budget and drops an illegal one", () => {
    expect(normalizePersona("a", { budget: { webSearch: 0 } } as never).budget).toEqual({
      webSearch: 0,
    });
    expect(normalizePersona("a", { budget: { webSearch: 5000 } } as never).budget).toBeUndefined();
    expect(normalizePersona("a", { budget: { webSearch: "9" } } as never).budget).toBeUndefined();
  });

  it("leaves budget out of the cache identity, like model", () => {
    expect(
      personaIdentity({ name: "a", system: "s", model: "m", budget: { webSearch: 9 } }),
    ).toEqual({ name: "a", system: "s" });
  });
});
