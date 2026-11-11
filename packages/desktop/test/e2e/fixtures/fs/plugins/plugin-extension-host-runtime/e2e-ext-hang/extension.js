// E2E 扩展 fixture：命令里写死循环，卡住扩展进程的事件循环，供存活探测与崩溃预算验收。
export function activate(ctx) {
  ctx.commands.register("hang", () => {
    ctx.log.warn("E2E_EXT_HANG_START");
    for (;;) {
      // 故意不返回。
    }
  });
  ctx.slots.update("hang", { text: "E2E hang", tooltip: "E2E_EXT_HANG_TOOLTIP" });
}
