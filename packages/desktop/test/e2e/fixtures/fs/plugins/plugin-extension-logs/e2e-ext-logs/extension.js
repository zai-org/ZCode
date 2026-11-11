// E2E 扩展 fixture（docs/plugins/extension-host.md §16.8，PLM-EXT-P2E）：纯 JS，不需要构建。
// 激活时按 info、warn、error 各写一行，再写一行超过 4KB 的长日志（缓冲里应被截断）和一行 stdout；
// 命令每执行一次再按三个级别各写一行。日志里只有固定标记，不输出环境变量。
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

let runs = 0;

export async function activate(ctx) {
  ctx.log.info(`E2E_LOGS_ACTIVATE_INFO pid=${process.pid}`);
  ctx.log.warn("E2E_LOGS_ACTIVATE_WARN");
  ctx.log.error("E2E_LOGS_ACTIVATE_ERROR");
  ctx.log.info(`E2E_LOGS_LONG ${"x".repeat(6000)}`);
  // console.* 在插件上下文里按插件归因（与 ctx.log 相同），不再是没有归属的 [stdout] 行。
  console.log("E2E_LOGS_STDOUT");
  console.warn("E2E_LOGS_CONSOLE_WARN");

  ctx.commands.register("emit", () => {
    runs += 1;
    ctx.log.info(`E2E_LOGS_COMMAND_INFO run=${runs}`);
    ctx.log.warn(`E2E_LOGS_COMMAND_WARN run=${runs}`);
    ctx.log.error(`E2E_LOGS_COMMAND_ERROR run=${runs}`);
  });
  ctx.slots.update("emit", { text: "E2E logs" });

  await writeFile(
    join(ctx.extension.path, "..", "e2e-ext-logs-state.json"),
    JSON.stringify({ pid: process.pid, activatedAt: Date.now() }),
  );
}

export function deactivate() {}
