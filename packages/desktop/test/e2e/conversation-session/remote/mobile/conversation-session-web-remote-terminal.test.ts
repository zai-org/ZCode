import { createMobileTerminalScenario } from "#e2e/helpers/web-remote-terminal-scenario";

describe("E2E_MRO04: 手机远控终端与桌面隔离", () => {
  const scenario = createMobileTerminalScenario(false);
  after(scenario.cleanup);
  it("已配对手机打开、执行和重开终端，桌面原终端持续可用", scenario.terminal);
  it("已回收终端的迟到订阅被拒绝，真实 Host 和原桌面终端继续工作", scenario.lateSubscription);
});
