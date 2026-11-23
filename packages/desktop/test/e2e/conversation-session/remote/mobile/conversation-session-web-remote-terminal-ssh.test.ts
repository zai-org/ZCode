import { createMobileTerminalScenario } from "#e2e/helpers/web-remote-terminal-scenario";

describe("E2E_MRO04: 手机远控终端与桌面隔离（SSH）", () => {
  const scenario = createMobileTerminalScenario(true);
  after(scenario.cleanup);
  it("已配对手机打开、执行和重开终端，桌面原终端持续可用", scenario.terminal);
});
