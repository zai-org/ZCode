// E2E 扩展 fixture（docs/plugins/extension-host.md §17.7「启用确认」）：带代码的扩展，初始为禁用。
// 启用后激活时记一行，证明启用确认之后扩展真的运行了。
export function activate(ctx) {
  ctx.log.info("E2E_SESSIONS_LATE_ACTIVATED plugin=e2e-ext-sessions-late@inline");
}

export function deactivate() {}
