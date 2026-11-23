import { describe, expect, it } from "vitest";
import { createComputerUseRuntime } from "../index.js";
import { callBrokerMethod } from "../broker.js";
import { startInProcessComputerUseBroker } from "../broker-in-process.js";
import { BROKER_SOCKET_ENV, IN_PROCESS_BROKER_SOCKET, mintBrokerSocketPath } from "../broker-socket-path.js";

describe("Computer Use placeholder", () => {
  it("执行入口明确报告不可用，且不触发真实 broker 准备", async () => {
    let prepared = false;
    const runtime = createComputerUseRuntime({
      ensureBrokerAvailable: async () => {
        prepared = true;
      },
    });
    await expect(
      runtime.execute({
        toolName: "computer_use",
        arguments: {},
        context: { sessionId: "example", runtimeScope: "main", workspaceKey: "example" },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(prepared).toBe(false);
    await runtime.dispose();
  });

  it("broker 方法拒绝执行真实系统能力", async () => {
    await expect(
      callBrokerMethod({ method: "example", socketPath: "unused" }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("进程内 broker 入口明确报告不可用，socketPath 入口保留独立 CLI 需要的常量", async () => {
    await expect(startInProcessComputerUseBroker()).rejects.toMatchObject({
      code: "helper_unavailable",
    });
    expect(BROKER_SOCKET_ENV).toBe("ZCODE_CUA_PERMISSION_BROKER_SOCKET");
    expect(IN_PROCESS_BROKER_SOCKET).toBe("in-process");
    expect(mintBrokerSocketPath()).toMatch(/\.sock$/u);
  });
});
