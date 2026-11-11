// PLM-EXT-STORE fixture: 只记一行激活日志。
export function activate(ctx) {
  ctx.log.info("E2E_EXT_COMPAT_ACTIVATED plugin=" + ctx.extension.id);
}
