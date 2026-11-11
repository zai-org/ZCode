/**
 * `renderChildEntry` 在 **esbuild 打包 / minify 之后**依然渲染出一份可运行的自包含入口文件。
 *
 * 为什么必须有这条测试：入口文件里的子进程逻辑是 `childMain.toString()` 拼出来的，而真实发布形态
 * 里这个函数先经 esbuild 打包（CLI 是单文件 bundle），desktop-agent 构建还会 minify。一旦
 * childMain 引用了模块作用域的任何绑定（常量、辅助函数、import），打包后那个标识符会被改名或
 * 提到别处，内嵌出来的文本就成了引用未定义标识符的非法程序——而且**只在发布产物里**坏，
 * 源码跑测试全绿。所以这里不测源码形态，专测打包形态，并且不止 `--check` 语法：真 spawn 一次
 * 跑到 complete，因为语法合法的坏程序（比如少了 bootstrap）照样能通过语法检查。
 *
 * esbuild 从 workspace 根解析而来（`apps/zcode-cli/package.json` 的依赖，CLI 的
 * `scripts/build.mjs` 用的是同一份）。
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import type { renderChildEntry as renderChildEntryType } from "../src/child-source.js";

const ENTRY = new URL("../src/child-source.ts", import.meta.url);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** 打包 child-source.ts 并取出打包产物里的 renderChildEntry（不是源码形态的那一份）。 */
async function bundledRenderChildEntry(minify: boolean): Promise<typeof renderChildEntryType> {
  const root = await tempRoot("dwf-child-bundle-");
  const outfile = join(root, "child-source.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL(ENTRY).pathname],
    format: "esm",
    // 与 CLI 发布构建同参：desktop-agent 是 minify + keepNames，普通/SEA 构建不压缩。
    keepNames: minify,
    minify,
    outfile,
    platform: "node",
    target: "node22",
  });
  const module = (await import(pathToFileURL(outfile).href)) as {
    renderChildEntry: typeof renderChildEntryType;
  };
  return module.renderChildEntry;
}

/** 按 harness 缺省策略写入口文件、真跑一次子进程，返回它写回的 NDJSON 行。 */
async function runChild(
  render: typeof renderChildEntryType,
  payload: { lowered: string; args?: Record<string, unknown> },
): Promise<unknown[]> {
  const root = await tempRoot("dwf-child-entry-");
  const entryPath = join(root, "run.mjs");
  // run 身份是 payload 的必备字段（沙箱据它构造冻结的 `run` 全局）。
  await writeFile(
    entryPath,
    render({ ...payload, run: { id: "run" }, maxOldSpaceSizeMb: 256 }, { runId: "run" }),
    "utf8",
  );
  const result = spawnSync(process.execPath, ["--max-old-space-size=256", entryPath], {
    encoding: "utf8",
    input: "",
    timeout: 30_000,
  });
  // 子进程的 stderr 是这条测试唯一的归因材料——ReferenceError 之类会在这里现形。
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe.each([
  { label: "bundled", minify: false },
  { label: "bundled + minified", minify: true },
])("renderChildEntry ($label)", ({ minify }) => {
  it("runs the sandbox to completion", async () => {
    const render = await bundledRenderChildEntry(minify);

    const lines = await runChild(render, {
      lowered: '__host.log("from the sandbox");\nreturn { ok: 42 };',
    });

    expect(lines).toEqual([
      { kind: "event", type: "log", message: "from the sandbox" },
      { kind: "complete", ok: true, value: { ok: 42 } },
    ]);
  });

  it("lets no outer-realm function reach the script", async () => {
    // 跨 realm 边界（tests/security.test.ts 的 "realm boundary"）在发布形态下同样成立：
    // 打包 / 压缩若把 null 原型沙箱或传输闭包弄丢，这里会拿到宿主 process。
    const render = await bundledRenderChildEntry(minify);

    const lines = await runChild(render, {
      lowered: [
        'const foreign = (v) => (typeof v === "function" || (typeof v === "object" && v !== null)) && v.constructor !== undefined && v.constructor.constructor !== Function;',
        "const hits = [];",
        "for (const k of Object.getOwnPropertyNames(globalThis)) { let v; try { v = globalThis[k]; } catch (e) { continue; } if (foreign(v)) hits.push(k); }",
        'let viaGlobal = "blocked";',
        'try { viaGlobal = typeof globalThis.constructor.constructor("return process")(); } catch (e) {}',
        "return { hits, viaGlobal, send: typeof globalThis.__send, finish: typeof globalThis.__finish };",
      ].join("\n"),
    });

    expect(lines).toEqual([
      {
        kind: "complete",
        ok: true,
        value: { hits: [], viaGlobal: "blocked", send: "undefined", finish: "undefined" },
      },
    ]);
  });

  it("keeps the sandbox bans and the curated realm intact", async () => {
    const render = await bundledRenderChildEntry(minify);

    // bootstrap 若被打包丢掉，脚本会拿到一个没有禁令的裸 context——那时这里会返回 ok:true。
    const lines = await runChild(render, {
      lowered: [
        "let bans = [];",
        'try { Date.now(); } catch (e) { bans.push("Date.now"); }',
        'try { Math.random(); } catch (e) { bans.push("Math.random"); }',
        'return { bans, hasProcess: typeof process !== "undefined", hostKeys: Object.keys(__host).sort() };',
      ].join("\n"),
    });

    expect(lines).toEqual([
      {
        kind: "complete",
        ok: true,
        value: {
          bans: ["Date.now", "Math.random"],
          hasProcess: false,
          // Boundary A 的全部成员。产物的两族在这里就分得开：publishArtifact 是效应
          // （request/response），declareArtifact 是声明（事件通道）。
          hostKeys: [
            "args",
            "ask",
            "channel",
            "createActor",
            "declareArtifact",
            "enterPhase",
            "future",
            "hole",
            "log",
            "publishArtifact",
            "report",
            // run 身份（facade 的 `run`）：与 args 一样是值，不是可调用物。
            "run",
            "worldRead",
          ],
        },
      },
    ]);
  });
});
