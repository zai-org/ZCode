// E2E 扩展 fixture（docs/plugins/extension-host.md §17.7，P3b）：从插件商店安装的带代码扩展。
// 激活时写一行日志；已有别的扩展持有会话权限时，它应等用户确认后才激活。
export function activate(ctx) {
  ctx.log.info("E2E_STORE_ACTIVATED plugin=" + ctx.extension.id);
}

export function deactivate() {}
