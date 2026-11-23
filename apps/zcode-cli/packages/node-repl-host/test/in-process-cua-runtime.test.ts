import { describe, expect, it } from "vitest";
import type { InProcessComputerUseBroker } from "@zcode/zcode-cua/broker/in-process";
import { BROKER_SOCKET_ENV, IN_PROCESS_BROKER_SOCKET } from "@zcode/zcode-cua/broker/socketPath";
import {
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_IN_PROCESS_BROKER_SOCKET,
} from "@zcode/shared/runtime-env";
import {
  captureComputerUseRuntimeFromEnvironment,
  createInProcessComputerUseRuntime,
  findSeededCuaAddon,
} from "../src/server.js";

const CONTEXT = { sessionId: "in-process-test", workspacePath: "/tmp" };

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe("in-process Computer Use runtime", () => {
  it("agrees with the CLI on the sentinel the CLI mints", () => {
    expect(IN_PROCESS_BROKER_SOCKET).toBe(ZCODE_CUA_IN_PROCESS_BROKER_SOCKET);
    expect(BROKER_SOCKET_ENV).toBe(ZCODE_CUA_BROKER_SOCKET_ENV_KEY);
  });

  it("uses the in-process path only for the sentinel socket", () => {
    expect(captureComputerUseRuntimeFromEnvironment({})).toBeUndefined();
    expect(
      captureComputerUseRuntimeFromEnvironment({ ZCODE_CUA_PERMISSION_BROKER_SOCKET: "in-process" }),
    ).toBeDefined();
  });

  it("starts the broker on the first execute, not on construction or closeSession", async () => {
    const sockets: string[] = [];
    const runtime = createInProcessComputerUseRuntime(
      { ZCODE_CUA_PERMISSION_BROKER_SOCKET: "in-process" },
      async (socketPath, env) => {
        sockets.push(socketPath);
        expect(env.ZCODE_CUA_PERMISSION_BROKER_SOCKET).toBeUndefined();
        throw new Error("CUA native addon (ax_native.node) not found");
      },
    );
    await runtime.closeSession(CONTEXT);
    expect(sockets).toHaveLength(0);

    const call = () =>
      runtime.execute({ toolName: "list_apps", arguments: {}, context: CONTEXT, signal: abortedSignal() });
    await expect(call()).rejects.toThrow("(ax_native.node) not found");
    await expect(call()).rejects.toThrow("(ax_native.node) not found");
    expect(sockets).toHaveLength(2);
    expect(sockets[0]).toBe(sockets[1]);
    expect(sockets[0]).not.toBe("in-process");
    await runtime.dispose();
  });

  it("shares one start across concurrent calls and stops it on dispose", async () => {
    let starts = 0;
    let stops = 0;
    let resolveStart: (broker: InProcessComputerUseBroker) => void = () => undefined;
    const runtime = createInProcessComputerUseRuntime({}, () => {
      starts += 1;
      return new Promise((resolve) => {
        resolveStart = resolve;
      });
    });
    const call = () =>
      runtime
        .execute({ toolName: "list_apps", arguments: {}, context: CONTEXT, signal: abortedSignal() })
        .catch(() => undefined);
    void call();
    void call();
    const disposed = runtime.dispose();
    resolveStart({
      socketPath: "unused",
      stop: async () => {
        stops += 1;
      },
    });
    await disposed;
    expect(starts).toBe(1);
    expect(stops).toBe(1);
  });
});

describe("seeded Computer Use addon lookup", () => {
  it("returns the plugin-root addon only when it exists", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "zcode-cua-seed-"));
    try {
      expect(await findSeededCuaAddon(undefined)).toBeUndefined();
      expect(await findSeededCuaAddon(root)).toBeUndefined();
      await mkdir(join(root, "native"));
      await writeFile(join(root, "native", "ax_native.node"), "addon");
      expect(await findSeededCuaAddon(root)).toBe(join(root, "native", "ax_native.node"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
