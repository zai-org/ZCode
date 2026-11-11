// E2E 扩展 fixture（PLM-EXT-P2E）：第二个扩展，激活时写一行，用来验证按插件过滤。
export function activate(ctx) {
  ctx.log.info("E2E_LOGS_PEER_INFO");
}

export function deactivate() {}
