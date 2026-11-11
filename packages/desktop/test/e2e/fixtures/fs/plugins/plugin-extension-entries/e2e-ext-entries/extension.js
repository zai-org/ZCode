// E2E 扩展 fixture（docs/plugins/extension-host.md §16.4、§16.5）：纯 JS，不需要构建。
// - 视图 nav：nav.primary 的 view 条目打开它。
// - 视图 file：file.viewer 为 .e2eview 打开它，实例带 view.input = { kind: "file", path, workspace }。
// 两个视图共用一个页面；页面调工具 describe 读实例的 viewId、作用域与 input，写进 body 的 data-*。
// 运行时证据写进日志（E2E_ENTRY_*）；每次激活把扩展进程 pid 写进状态文件，E2E 用它杀进程。
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function activate(ctx) {
  const track = (view) => {
    ctx.log.info(
      `E2E_ENTRY_VIEW_OPEN view=${view.viewId} instance=${view.id} scope=${view.scope.kind} input=${JSON.stringify(view.input ?? null)}`,
    );
  };
  for (const viewId of ["nav", "file"]) {
    ctx.views.register(viewId, {
      entry: "./view.html",
      onDidOpen: track,
      tools: {
        describe: {
          description: "Describe this view instance",
          inputSchema: { type: "object", properties: {} },
          run: (_input, call) => ({
            viewId: call.view.viewId,
            instance: call.view.id,
            scope: call.view.scope.kind,
            input: call.view.input ?? null,
          }),
        },
      },
    });
  }
  await writeFile(
    join(ctx.extension.path, "..", "e2e-ext-entries-state.json"),
    JSON.stringify({ pid: process.pid, activatedAt: Date.now() }),
  );
}

export function deactivate() {}
