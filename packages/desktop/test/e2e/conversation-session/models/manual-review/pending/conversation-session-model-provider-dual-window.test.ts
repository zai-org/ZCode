/**
 * 从回归目录缺口文件保留的未实现占位，不属于已通过的五条回归。
 * 当前产品没有“新建主窗口”的用户入口；入口确定后补真实双窗口操作，
 * 不用 Electron 内部造窗冒充用户路径，也不计入正式转正结果。
 */
describe("Model Provider 双主窗口待实现 E2E", () => {
  it.skip("F-APP-003: 两个主窗口同时操作同一 workspace 的冲突规则", async function () {
    this.timeout(30000);
  });
});
