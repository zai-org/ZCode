import { createMobileUnreadScenario } from "#e2e/helpers/web-remote-unread-scenario";

describe("E2E_MRO03: 实际 Web 查看与桌面唯一未读写者（SSH）", () => {
  const scenario = createMobileUnreadScenario();
  after(scenario.cleanup);
  it("MRO03 SSH：前台远端完成不未读，离开完成后回看清除所属Source marker", scenario.ssh);
});
