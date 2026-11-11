/**
 * 隐藏子命令 `__zcode-dwf-child` 的分派与执行。
 *
 * Bug 根因（docs/dynamic-workflow/launch.md「Single-executable builds」）：SEA 单文件二进制不解释 Node
 * CLI 旗标，harness 缺省的 `node --max-old-space-size=… <entry>` 在 SEA 下会把旗标交给严格
 * parseArgs，子进程立刻报错退出——SEA 下每一个 dwf run 必然失败。修法与 official plugin host
 * 同款：自 re-exec 本二进制 + 在 parseArgs **之前**分派。
 *
 * 2026-09-09 追记之后 argv 末位是入口文件路径（payload 不再过命令行）。两件事必须钉住：
 *   1. 分派发生在 parseArgs 之前——任何进了 parseArgs 的形态都会把路径当未知参数报错；
 *   2. 子进程真的跑起来：子命令 `import()` 入口文件、注入真实 vm/readline/stdio 调它的 `start`，
 *      把 NDJSON 写回 stdout。入口文件由 harness 同一个 `renderChildEntry` 渲染，与生产同形。
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZCODE_DWF_CHILD_COMMAND } from "@zcode/contracts";
import { isDwfChildInvocation } from "../src/dwf-child-command.js";
import { run } from "../src/run.js";

import { createChildContext } from "./dwf-child-command-fixture.js";

test("recognises the dwf child subcommand only as argv[0]", () => {
  assert.equal(isDwfChildInvocation([ZCODE_DWF_CHILD_COMMAND, "/tmp/run.mjs"]), true);
  assert.equal(isDwfChildInvocation([ZCODE_DWF_CHILD_COMMAND]), true);
  assert.equal(isDwfChildInvocation([]), false);
  assert.equal(isDwfChildInvocation(["--help"]), false);
  // 出现在别处不算：否则一个普通 prompt 里提到这个词就能改变 CLI 的行为。
  assert.equal(isDwfChildInvocation(["-p", ZCODE_DWF_CHILD_COMMAND]), false);
});

test("fails with usage when the entry path argument is missing", async () => {
  const { ctx, stdout, stderr } = createChildContext([ZCODE_DWF_CHILD_COMMAND]);

  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  // stdout 是父进程的 NDJSON 通道，接线错误只许走 stderr。
  assert.equal(stdout(), "");
  assert.match(stderr(), new RegExp(`Usage: ${ZCODE_DWF_CHILD_COMMAND}`));
});

test("fails on stderr when the entry file does not exist", async () => {
  const { ctx, stdout, stderr } = createChildContext([
    ZCODE_DWF_CHILD_COMMAND,
    join(tmpdir(), "dwf-child-cmd-missing", "nope.mjs"),
  ]);

  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  assert.equal(stdout(), "");
  assert.match(stderr(), /Workflow child failed: /);
});
