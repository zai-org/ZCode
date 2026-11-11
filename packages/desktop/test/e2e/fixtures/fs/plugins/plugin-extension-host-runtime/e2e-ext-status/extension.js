// E2E 扩展 fixture（docs/plugins/extension-host.md §15）：纯 JS，不需要构建。
// 激活时设置 composer.status 的 App 作用域文字；命令按调用作用域写入点击次数；注册启动页条目的视图。
// 文字保持短小（像真实的 "42 tok/s"），让草稿的窄输入框也能显示文字。
// 同时把运行时护栏的结果写进日志，供 E2E 从 Main 日志取证。
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

let clicks = 0;

export async function activate(ctx) {
  const envKeys = Object.keys(process.env).sort();
  ctx.log.info(`E2E_EXT_ENV_KEYS ${JSON.stringify(envKeys)}`);

  let frozen = false;
  try {
    ctx.slots.extra = 1;
  } catch {
    frozen = true;
  }
  ctx.log.info(
    `E2E_EXT_CTX_FROZEN ${frozen && Object.isFrozen(ctx) && Object.isFrozen(ctx.slots)}`,
  );

  let exitCode = "none";
  try {
    process.exit(0);
  } catch (error) {
    exitCode = error?.code ?? "unknown";
  }
  ctx.log.info(`E2E_EXT_EXIT_BLOCKED ${exitCode}`);

  try {
    ctx.slots.update("undeclared", { text: "x" });
  } catch (error) {
    ctx.log.info(`E2E_EXT_NOT_DECLARED ${error?.code}`);
  }

  ctx.commands.register("bump", (call) => {
    clicks += 1;
    const scope =
      call.scope.kind === "session"
        ? { sessionId: call.scope.sessionId }
        : call.scope.kind === "workspace"
          ? { workspace: call.scope.workspace }
          : "app";
    ctx.slots.update(
      "status",
      { text: `E2E #${clicks}`, tooltip: "E2E_EXT_TOOLTIP_CLICKED" },
      scope,
    );
    ctx.log.info(`E2E_EXT_COMMAND_RUN scope=${call.scope.kind} clicks=${clicks}`);
  });
  ctx.slots.update("status", { text: "E2E ok", tooltip: "E2E_EXT_TOOLTIP" });
  // 启动页条目 open-panel 的视图：扩展进程停止后条目照常显示，但打不开（§16.1）。
  ctx.views.register("panel", { entry: "./view.html" });
  // 条目 broken 引用了未声明的视图，只有它不可用；Window Host 不把它交给扩展进程。
  try {
    ctx.slots.update("broken", { text: "x" });
  } catch (error) {
    ctx.log.info(`E2E_EXT_UNUSABLE_ITEM ${error?.code}`);
  }

  await writeFile(
    join(ctx.extension.path, "..", "e2e-ext-status-state.json"),
    JSON.stringify({ pid: process.pid, envKeys, activatedAt: Date.now() }),
  );
  // 扩展里的未捕获错误只记日志并归因到本插件，不让扩展进程退出。
  setTimeout(() => {
    throw new Error("E2E_EXT_UNCAUGHT");
  }, 10);
}

export function deactivate() {}
