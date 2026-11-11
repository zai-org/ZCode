import { describe, expect, it } from "vitest";
import { NodeReplSession } from "../src/repl/node-repl-session.js";

describe("NodeReplSession", () => {
  it("persists globalThis state across runs", async () => {
    const s = new NodeReplSession();
    await s.run("globalThis.x = 41;");
    const r = await s.run("return globalThis.x + 1;");
    expect(r.error).toBeUndefined();
    expect(r.result).toBe("42");
    s.dispose();
  });

  it("supports top-level await", async () => {
    const s = new NodeReplSession();
    const r = await s.run("return await Promise.resolve(42);");
    expect(r.result).toBe("42");
    s.dispose();
  });

  it("returns the last bare expression's value without explicit return (REPL 回显)", async () => {
    // Bugfix 回归：模型按 REPL 习惯写裸表达式（如 `await tab.snapshot()`）期望看到结果；
    // 修复前 async-IIFE 吞掉完成值 → 工具回 "(no output)" → 模型误以为 browser-use 不工作。
    const s = new NodeReplSession();
    expect((await s.run("1 + 1;")).result).toBe("2");
    expect((await s.run("await Promise.resolve('ok');")).result).toBe("ok");
    // 先赋值到 globalThis 再裸引用它（对应轨迹里 `globalThis.lastSnapshot; ` 的用法）。
    await s.run("globalThis.snap = { a: 1 };");
    const r = await s.run("globalThis.snap;");
    expect(r.result).toContain('"a": 1');
    s.dispose();
  });

  it("collects nodeRepl.write output as logs", async () => {
    const s = new NodeReplSession();
    const r = await s.run('nodeRepl.write("hi"); nodeRepl.write("there");');
    expect(r.logs).toContain("hi");
    expect(r.logs).toContain("there");
    s.dispose();
  });

  it("collects nodeRepl.emitImage (base64) into run result images", async () => {
    const s = new NodeReplSession();
    const r = await s.run('nodeRepl.emitImage({ base64: "AAAA", mimeType: "image/png" });');
    expect(r.images).toEqual([{ base64: "AAAA", mimeType: "image/png" }]);
    s.dispose();
  });

  it("collects structured SDK results without routing them through console logs", async () => {
    const s = new NodeReplSession();
    const r = await s.run(`
      nodeRepl.emitStructuredResult({
        content: [
          { type: "image", data: "AQID", mimeType: "image/png" },
          { type: "text", text: '{"image_ref":"frame-1"}' },
        ],
        structuredContent: { state_id: "state-1" },
        _meta: { "zcode-cua": "official" },
      });
      console.log("model diagnostics only");
    `);
    expect(r.logs).toContain("model diagnostics only");
    expect(r.structuredResults).toEqual([
      {
        content: [
          { type: "image", data: "AQID", mimeType: "image/png" },
          { type: "text", text: '{"image_ref":"frame-1"}' },
        ],
        structuredContent: { state_id: "state-1" },
        _meta: { "zcode-cua": "official" },
      },
    ]);
    s.dispose();
  });

  it("nodeRepl.emitImage encodes bytes to base64; defaults mimeType to image/png", async () => {
    const s = new NodeReplSession();
    const r = await s.run("nodeRepl.emitImage({ bytes: new Uint8Array([1,2,3]) });");
    expect(r.images?.[0]?.mimeType).toBe("image/png");
    expect(r.images?.[0]?.base64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    s.dispose();
  });

  it("nodeRepl.emitImage accepts direct Uint8Array bytes", async () => {
    const s = new NodeReplSession();
    const r = await s.run("nodeRepl.emitImage(new Uint8Array([4,5,6]));");
    expect(r.images?.[0]?.base64).toBe(Buffer.from([4, 5, 6]).toString("base64"));
    s.dispose();
  });

  it("marks only emitted images that match an explicit browser screenshot", async () => {
    let s!: NodeReplSession;
    s = new NodeReplSession({
      injectedGlobals: {
        captureBrowserScreenshot: () => {
          const image = { base64: "AQID", mimeType: "image/png" };
          s.recordBrowserScreenshot(image);
          return image;
        },
      },
    });

    const r = await s.run(`
      nodeRepl.emitImage({ base64: "BAUG", mimeType: "image/png" });
      nodeRepl.emitImage(captureBrowserScreenshot());
    `);

    expect(r.browserScreenshotImageIndices).toEqual([1]);
    s.dispose();
  });

  it("exposes requestMeta and returns responseMeta", async () => {
    const s = new NodeReplSession();
    const r = await s.run(
      "nodeRepl.setResponseMeta({ screenshotId: 'shot-1' }); return nodeRepl.requestMeta.title;",
      { requestMeta: { title: "Browser check", toolCallId: "tool-1" } },
    );
    expect(r.result).toBe("Browser check");
    expect(r.responseMeta).toEqual({ screenshotId: "shot-1" });
    s.dispose();
  });

  it("nodeRepl.emitImage throws on missing base64/bytes (surfaces as run error)", async () => {
    const s = new NodeReplSession();
    const r = await s.run('nodeRepl.emitImage({ mimeType: "image/png" });');
    expect(r.error?.name).toBe("TypeError");
    expect(r.error?.message).toContain("emitImage requires");
    s.dispose();
  });

  it("tees console.log into logs", async () => {
    const s = new NodeReplSession();
    const r = await s.run('console.log("yo", 123);');
    expect(r.logs).toContain("yo");
    expect(r.logs).toContain("123");
    s.dispose();
  });

  it("returns structured error without throwing out of the engine", async () => {
    const s = new NodeReplSession();
    const r = await s.run('throw new Error("boom");');
    expect(r.error?.name).toBe("Error");
    expect(r.error?.message).toBe("boom");
    expect(r.result).toBeUndefined();
    s.dispose();
  });

  it("supports dynamic module loading via injected importModule", async () => {
    const s = new NodeReplSession();
    const r = await s.run('const m = await importModule("node:path"); return m.sep;');
    expect(r.error).toBeUndefined();
    expect(typeof r.result).toBe("string");
    expect(r.result!.length).toBeGreaterThan(0);
    s.dispose();
  });

  it("supports standard dynamic import syntax", async () => {
    const s = new NodeReplSession();
    const r = await s.run('const m2 = await import("node:path"); return m2.sep;');
    expect(r.error).toBeUndefined();
    expect(typeof r.result).toBe("string");
    expect(r.result!.length).toBeGreaterThan(0);
    s.dispose();
  });

  it("protects MCP stdio and process lifecycle behind the restricted process facade", async () => {
    const s = new NodeReplSession({ protectProtocolStdio: true });
    const result = await s.run(`
      const requiredProcess = require("node:process");
      const importedProcess = await import("node:process");
      ({
        sameRequire: requiredProcess === process,
        sameImport: importedProcess.default === process,
        stdout: typeof process.stdout,
        exit: typeof process.exit,
        cwd: process.cwd()
      });
    `);

    expect(result.error).toBeUndefined();
    expect(result.result).toContain('"sameRequire": true');
    expect(result.result).toContain('"sameImport": true');
    expect(result.result).toContain('"stdout": "undefined"');
    expect(result.result).toContain('"exit": "undefined"');
    s.dispose();
  });

  it("exposes injected globals", async () => {
    const s = new NodeReplSession({ injectedGlobals: { ping: () => "pong" } });
    const r = await s.run("return ping();");
    expect(r.result).toBe("pong");
    s.dispose();
  });

  it("stringifies object results as JSON", async () => {
    const s = new NodeReplSession();
    const r = await s.run("return { a: 1, b: [2, 3] };");
    expect(r.result).toContain('"a": 1');
    expect(r.result).toContain('"b"');
    s.dispose();
  });

  it("formats screenshot-like Uint8Array results without expanding every byte as JSON", async () => {
    const s = new NodeReplSession();

    const r = await s.run("new Uint8Array(1000).fill(137)");

    expect(r.result).toContain("Uint8Array(1000)");
    expect(r.result).toContain("... 900 more items");
    expect(r.result).not.toContain('"999": 137');
    expect(r.result?.length).toBeLessThan(1_000);
    s.dispose();
  });

  it("returns AbortError when signal is already aborted", async () => {
    const s = new NodeReplSession();
    const controller = new AbortController();
    controller.abort();
    const r = await s.run("return await new Promise(() => {});", {
      signal: controller.signal,
    });
    expect(r.error?.name).toBe("AbortError");
    expect(r.error?.message).toContain("kernel reset, all previous bindings were cleared");
    s.dispose();
  });

  it("preserves AbortSignal timeout reason and exposes kernel reset recovery", async () => {
    const s = new NodeReplSession();
    await s.run("globalThis.oldBrowserBinding = 1;");

    const result = await s.run("return await new Promise(() => {});", {
      signal: AbortSignal.timeout(10),
    });

    expect(result.error?.name).toBe("TimeoutError");
    expect(result.error?.message).toContain("kernel reset, all previous bindings were cleared");
    expect(result.error?.message).toContain("reinitialize browser/tab bindings");
    expect((await s.run("return typeof oldBrowserBinding;")).result).toBe("undefined");
    s.dispose();
  });

  it("interrupts a synchronous infinite loop without wedging the REPL", async () => {
    const s = new NodeReplSession();
    const startedAt = Date.now();
    const r = await s.run("while (true) {}", { syncTimeoutMs: 25 });
    expect(r.error?.message).toContain("Script execution timed out");
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    const after = await s.run("return 2 + 3;");
    expect(after.result).toBe("5");
    s.dispose();
  });

  it("does not enter synchronous user code when the request is already cancelled", async () => {
    const s = new NodeReplSession();
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();

    const result = await s.run("while (true) {}", {
      signal: controller.signal,
      syncTimeoutMs: 5_000,
    });

    expect(result.error?.name).toBe("AbortError");
    expect(Date.now() - startedAt).toBeLessThan(500);
    s.dispose();
  });

  it("run after dispose returns DisposedError", async () => {
    const s = new NodeReplSession();
    s.dispose();
    const r = await s.run("return 1;");
    expect(r.error?.name).toBe("DisposedError");
  });

  it("persists top-level const across calls", async () => {
    const s = new NodeReplSession();
    const r1 = await s.run("const tab = 1;");
    expect(r1.error).toBeUndefined();
    const r2 = await s.run("return tab + 1;");
    expect(r2.error).toBeUndefined();
    expect(r2.result).toBe("2");
    s.dispose();
  });

  it("persists destructured top-level bindings across calls", async () => {
    const s = new NodeReplSession();
    const r1 = await s.run("const { x, y } = { x: 1, y: 2 };");
    expect(r1.error).toBeUndefined();
    const r2 = await s.run("return x + y;");
    expect(r2.error).toBeUndefined();
    expect(r2.result).toBe("3");
    s.dispose();
  });

  it("persists top-level bindings created via top-level await", async () => {
    const s = new NodeReplSession();
    const r1 = await s.run("const v = await Promise.resolve(9);");
    expect(r1.error).toBeUndefined();
    const r2 = await s.run("return v;");
    expect(r2.result).toBe("9");
    s.dispose();
  });

  it("does NOT persist block-scoped declarations", async () => {
    const s = new NodeReplSession();
    await s.run("{ const z = 1; }");
    const r = await s.run("return typeof z;");
    expect(r.result).toBe("undefined");
    s.dispose();
  });

  it("falls back gracefully and still runs later code after a parse error", async () => {
    const s = new NodeReplSession();
    // 故意语法错：instrument 解析失败 → 回退原样执行，此处仍是运行时语法错，归一为结构化 error。
    const bad = await s.run("const x = (");
    expect(bad.error).toBeDefined();
    // 后续合法代码继续能跑（引擎不崩）。
    const ok = await s.run("return 1 + 1;");
    expect(ok.error).toBeUndefined();
    expect(ok.result).toBe("2");
    s.dispose();
  });

  it("persists declarations executed before a later throw (per-statement instrument)", async () => {
    const s = new NodeReplSession();
    // 第一条声明成功执行并持久，第二条 throw；throw 前的 const 应已复制到 globalThis。
    const r1 = await s.run("const kept = 7;\nthrow new Error('boom');");
    expect(r1.error?.message).toBe("boom");
    const r2 = await s.run("return kept;");
    expect(r2.result).toBe("7");
    s.dispose();
  });
});
