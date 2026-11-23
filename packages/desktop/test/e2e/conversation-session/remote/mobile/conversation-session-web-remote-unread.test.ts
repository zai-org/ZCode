import { createMobileUnreadScenario } from "#e2e/helpers/web-remote-unread-scenario";

describe("E2E_MRO03: 实际 Web 查看与桌面唯一未读写者", () => {
  const scenario = createMobileUnreadScenario();
  after(scenario.cleanup);
  it(
    "MRO03 本地：宽窄屏前台完成不未读，离开/断线完成后回看清除，Web首发晋升立即查看",
    scenario.local,
  );
  it(
    "MRO03 后台：原生Chrome实际hidden时完成写未读，visible后真实Reporter触发清除",
    scenario.background,
  );
});
