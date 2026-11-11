// PRO02 独立成 spec：它会新建项目、切换当前工作区并打开远控弹窗，中途失败时不恢复这些状态。
// 原先与 VP13 同文件共用一个 app，PRO02 失败会让 VP13 等不到默认工作区而连带失败；
// 独立 spec 由 beforeSession 重置隔离 HOME，不再需要为后续用例恢复状态。
import { clearAppData } from "#e2e/helpers/desktop-app";
import { verifyNewProjectOrderOnMobile } from "#e2e/helpers/project-new-order";
import { restoreHandoffProbes } from "#e2e/helpers/remote-project-handoff-probe";

describe("虚拟项目手机 shared-host 新项目排序", () => {
  after(async () => {
    await restoreHandoffProbes();
    await clearAppData();
  });
  it("PRO02：新项目在桌面和手机前插，保留旧手动顺序及重载结果", async function () {
    this.timeout(180_000);
    await verifyNewProjectOrderOnMobile();
  });
});
