/**
 * 沙箱安全：vm.createContext 求值单元的隔离契约（docs/execution-engine.md 的"The sandbox"）。
 * 这些脚本按设计**无法**通过 facade typecheck（直接摸 process/import 等），故绕开编译器，把手写的
 * lowered 函数体直接喂 harness——vm 契约本身才是被测对象，这是正当做法。
 */

import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { InMemoryJournalStore, type RunSettlement } from "@zcode/dynamic-workflow";
import { CELL_STREAMS_BOOTSTRAP } from "../src/child-cell-streams.js";
import { childMain } from "../src/child-source.js";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { TEST_CWD } from "./helpers.js";

/** 直接投喂手写 lowered 体（自由标识符仅 `__host`），返回结算。 */
async function runLowered(lowered: string): Promise<RunSettlement> {
  const journal = new InMemoryJournalStore();
  const driver = new AutoDriver(journal);
  return runWorkflowScript({
    cwd: TEST_CWD,
    lowered,
    caps: { maxConcurrency: 4 },
    askSpecs: new Map(),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: 15000,
  });
}

/** 便捷：跑一个直接 return 表达式的沙箱体，取回 artifact。 */
async function evalInSandbox(expr: string): Promise<unknown> {
  const settlement = await runLowered(`return ${expr};`);
  expect(settlement.status).toBe("completed");
  return (settlement as { status: "completed"; artifact: unknown }).artifact;
}

describe("sandbox security — Node globals are absent", () => {
  it("process / fetch / require / globalThis.process are undefined", async () => {
    expect(await evalInSandbox('typeof process')).toBe("undefined");
    expect(await evalInSandbox('typeof fetch')).toBe("undefined");
    expect(await evalInSandbox('typeof require')).toBe("undefined");
    expect(await evalInSandbox('typeof globalThis.process')).toBe("undefined");
    expect(await evalInSandbox('typeof Buffer')).toBe("undefined");
    expect(await evalInSandbox('typeof global')).toBe("undefined");
  });

  it("ES intrinsics are present (curated globals, not a stripped realm)", async () => {
    expect(await evalInSandbox('typeof JSON')).toBe("object");
    expect(await evalInSandbox('typeof Promise')).toBe("function");
    expect(await evalInSandbox('Array.isArray([1,2])')).toBe(true);
  });
});

describe("sandbox security — dynamic import throws", () => {
  it("import() rejects with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING", async () => {
    const result = await evalInSandbox(
      '(await (async () => { try { await import("node:fs"); return "NO-THROW"; } catch (e) { return String(e && (e.code || e.name)); } })())',
    );
    expect(result).toContain("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING");
  });
});

describe("sandbox security — runtime nondeterminism bans (belt)", () => {
  it("Date.now() throws", async () => {
    expect(await evalInSandbox('(() => { try { Date.now(); return "NO"; } catch (e) { return e.message; } })()')).toContain(
      "Date.now()",
    );
  });

  it("argless new Date() throws; new Date(ms) is allowed", async () => {
    expect(await evalInSandbox('(() => { try { new Date(); return "NO"; } catch (e) { return e.message; } })()')).toContain(
      "argless new Date()",
    );
    // 带参构造仍可用（只有不确定性的无参形态被禁）。
    expect(await evalInSandbox("new Date(0).getTime()")).toBe(0);
  });

  it("Math.random() throws", async () => {
    expect(
      await evalInSandbox('(() => { try { Math.random(); return "NO"; } catch (e) { return e.message; } })()'),
    ).toContain("Math.random()");
  });
});

describe("sandbox security — eval binds to the same curated globals", () => {
  it('eval("process") sees undefined; eval("Date.now()") throws', async () => {
    // 动态创建的代码也绑定同一套 curated 全局：证明隔离不是靠静态改写脚本文本。
    expect(await evalInSandbox('eval("typeof process")')).toBe("undefined");
    expect(await evalInSandbox('(() => { try { eval("Date.now()"); return "NO"; } catch (e) { return "THREW"; } })()')).toBe(
      "THREW",
    );
  });
});

// 跨 realm 逃逸回归（execution-engine.md「The vm cell」的边界规则）。每条都是一条曾经真实可用的
// 逃逸路径：脚本拿到任何一个外层 realm 的函数，`.constructor` 就是外层的 Function，
// `Function("return process")()` 即拿到宿主 process——以当前用户权限执行任意命令，且不经任何审批门。
// 断言一律写成「脚本看不到外层 realm 的 Function」，而不是「process 拿不到」，以免漏掉别的出口。
describe("sandbox security — realm boundary: no outer-realm function reaches the script", () => {
  /** 在 cell 内把「这个值是否来自外层 realm」判成字符串；`Function` 是 context 自己的。 */
  const FOREIGN = "(v) => (typeof v === 'function' || (typeof v === 'object' && v !== null)) && v.constructor !== undefined && v.constructor.constructor !== Function";

  it("the global object does not inherit from the outer realm", async () => {
    // 曾经：沙箱对象是外层 realm 的 `{}`，context 全局的属性查找落到外层 Object.prototype 上。
    expect(
      await evalInSandbox(
        '(() => { try { return typeof globalThis.constructor.constructor("return process")(); } catch (e) { return "blocked"; } })()',
      ),
    ).toBe("blocked");
  });

  it("the transport functions are not reachable from the script", async () => {
    // 曾经：宿主箭头函数 `__send` 原样挂在全局上，`__send.constructor` 即外层 Function。
    expect(await evalInSandbox("[typeof globalThis.__send, typeof globalThis.__finish]")).toEqual([
      "undefined",
      "undefined",
    ]);
  });

  it("no global and no __host member is an outer-realm value", async () => {
    const foreign = await evalInSandbox(
      `(() => {
        const foreign = ${FOREIGN};
        const hits = [];
        for (const k of Object.getOwnPropertyNames(globalThis)) {
          let v; try { v = globalThis[k]; } catch (e) { continue; }
          if (foreign(v)) hits.push(k);
        }
        for (const k of Object.keys(__host)) if (foreign(__host[k])) hits.push("__host." + k);
        return hits;
      })()`,
    );
    expect(foreign).toEqual([]);
  });

  it("a failing transport call throws a context-native error (non-string payload)", async () => {
    // 曾经：`${line}` 在宿主函数里对 Symbol 求值，抛出的是外层 realm 的 TypeError。
    // __emitLine 是 bootstrap 包在传输外面的 cell 侧函数，脚本能直接调到它。
    const result = await evalInSandbox(
      `(() => { const foreign = ${FOREIGN}; try { __emitLine(Symbol("x")); return "no-throw"; } catch (e) { return foreign(e) ? "FOREIGN" : "native"; } })()`,
    );
    expect(result).not.toBe("FOREIGN");
  });

  it("the outer realm never calls a function the script swapped in", async () => {
    // 曾经：外层每次都按 `sandbox.__deliver(line)` 现取现调，`this` 是外层的沙箱对象；脚本换掉
    // __deliver 就能拿到它。现在外层在脚本运行前就取走三个入口，之后对全局的改写不起作用。
    const result = await evalInSandbox(
      `await (async () => {
        const foreign = ${FOREIGN};
        const seen = [];
        globalThis.__deliver = function () { seen.push(foreign(this) ? "FOREIGN-this" : "called"); };
        globalThis.__checkStalled = function () { seen.push(foreign(this) ? "FOREIGN-this" : "called"); return false; };
        const paths = await __host.worldRead("world-read#1", "glob", ["*"]);
        return { paths, seen };
      })()`,
    );
    expect(result).toEqual({ paths: [], seen: [] });
  });

  it("the outer realm never calls then() on a cell promise", async () => {
    // 曾经：外层对 __execute 返回的 promise 调 `.then(hostFn, hostFn)`；脚本先改写
    // Promise.prototype.then，就能收到这两个宿主函数。
    const result = await evalInSandbox(
      `await (async () => {
        const foreign = ${FOREIGN};
        const origThen = Promise.prototype.then;
        let leaked = "none";
        Promise.prototype.then = function (a, b) {
          if (foreign(a) || foreign(b)) leaked = "host";
          return origThen.call(this, a, b);
        };
        // 外层的 .then 调用（若有）发生在 __execute 同步返回之后、微任务之前。
        await null;
        await __host.worldRead("world-read#1", "glob", ["*"]);
        Promise.prototype.then = origThen;
        return leaked;
      })()`,
    );
    expect(result).toBe("none");
  });
});

describe("sandbox security — realm boundary: stack overflow at the transport", () => {
  it("a stack overflow on entry to the transport throws a context-native error", async () => {
    // 曾经：在栈将满时调用宿主函数，栈溢出的 RangeError 生成于外层 realm。
    // 这条直接驱动 childMain 而不走真子进程：溢出也可能落在真 stdout 管道流的内部，把流写坏，
    // run 于是以 interrupted 告终（脚本只坑了自己，不泄漏任何东西），结果就读不回来了。
    // 这里换成最简的 stdout，让探针结果稳定回传。
    const lines: string[] = [];
    await childMain({
      vm,
      createInterface,
      stdin: new PassThrough(),
      stdout: {
        write: (chunk: string) => lines.push(chunk),
      },
      streamsBootstrap: CELL_STREAMS_BOOTSTRAP,
      payload: {
        run: { id: "run" },
        maxOldSpaceSizeMb: 256,
        lowered: `
          const foreign = (v) => (typeof v === "function" || (typeof v === "object" && v !== null)) && v.constructor !== undefined && v.constructor.constructor !== Function;
          // 预先序列化：栈将满时 JSON.stringify 自己就会先溢出，探不到传输入口。
          const line = JSON.stringify({ kind: "event", type: "log", message: "probe" });
          let probes = 0;
          let hits = 0;
          let transportThrows = 0;
          function dive() {
            try { dive(); } catch (e) {
              if (foreign(e)) hits++;
              if (probes >= 64) return;
              probes++;
              try { __emitLine(line); } catch (e2) { transportThrows++; if (foreign(e2)) hits++; }
              // 重新抛出，让上一帧也探一次：每往回一帧栈余量多一点，总有一次溢出落在传输入口上。
              throw e;
            }
          }
          dive();
          return { probes, hits, transportThrows };`,
      },
    });
    const complete = JSON.parse(lines.at(-1) ?? "null") as { kind: string; ok: boolean; value: unknown };
    expect(complete).toMatchObject({ kind: "complete", ok: true });
    const value = complete.value as { probes: number; hits: number; transportThrows: number };
    expect(value.probes).toBe(64);
    // 至少一次溢出真的落在了传输上，否则这条测试什么也没证明。
    expect(value.transportThrows).toBeGreaterThan(0);
    expect(value.hits).toBe(0);
  });
});
