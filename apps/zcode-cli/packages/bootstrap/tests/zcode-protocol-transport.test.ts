import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods, type ZCodeProtocolMessage } from "@zcode/shared";
import { ZCodeProtocolNdjsonConnection } from "../src/zcode-protocol/transport.js";

describe("ZCodeProtocolNdjsonConnection", () => {
  it("stdout 背压时丢弃观测批次，业务响应仍可写入", () => {
    const output = new PassThrough({ highWaterMark: 1 });
    const connection = new ZCodeProtocolNdjsonConnection({
      input: new PassThrough(),
      output,
      handleMessage: async () => undefined,
    });
    output.write("x".repeat(256 * 1024));
    const before = output.writableLength;
    connection.send({
      method: "process/networkRequests",
      params: { captureId: "one", records: [], dropped: 0 },
    });
    expect(output.writableLength).toBe(before);
    connection.send({ id: 1, result: {} });
    expect(output.writableLength).toBeGreaterThan(before);
    output.destroy();
  });
  it("网络观测控制不等待挂起业务请求，并保留启停顺序", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const controls: unknown[] = [];
    const connection = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      handleMessage: async (message) => {
        if ("method" in message && message.method === "process/networkCapture") {
          controls.push(message.params);
          return undefined;
        }
        return new Promise(() => {});
      },
    });
    connection.start();
    input.write(frame({ id: "busy", method: "workspace/readState" }));
    input.write(frame({ method: "process/networkCapture", params: { captureId: "one" } }));
    input.write(frame({ method: "process/networkCapture", params: { captureId: null } }));
    await vi.waitFor(() => expect(controls).toEqual([{ captureId: "one" }, { captureId: null }]));
    input.end();
    await connection.waitForClose();
  });
  it("bounds EOF drain even while a handler never settles", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const closed = vi.fn();
    const connection = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      handleMessage: () => new Promise(() => {}),
      onTransportClosed: closed,
    });
    connection.start();
    input.end(frame({ id: "hung", method: "workspace/readState", params: {} }));
    await connection.waitForClose();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(input.listenerCount("data")).toBe(0);
  }, 1_000);

  it("writes response, every physical notification, then commits the reservation", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const order: string[] = [];
    output.on("data", (chunk: Buffer) => {
      const value = JSON.parse(chunk.toString("utf8")) as {
        id?: string;
        params?: { fragmentIndex?: number };
      };
      order.push(value.id ? "response" : `wire-${value.params?.fragmentIndex}`);
    });
    const connection = new ZCodeProtocolNdjsonConnection({
      handleMessage: async (message) =>
        "id" in message && "method" in message
          ? { id: message.id, result: { ack: {} } }
          : undefined,
      input,
      output,
      takePostResponseBatch: () => ({
        messages: [0, 1].map((fragmentIndex) => ({
          method: "v4/conversation/frame",
          params: { kind: "fragment", fragmentIndex },
        })),
        commit: () => {
          order.push("commit");
          return true;
        },
      }),
    });
    connection.start();
    input.end(frame({ id: "physical-order", method: "v4/conversation/subscribe", params: {} }));
    await connection.waitForClose();
    expect(order).toEqual(["response", "wire-0", "wire-1", "commit"]);
  });

  it("does not commit when a physical notification write throws", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const originalWrite = output.write.bind(output);
    let writes = 0;
    output.write = ((chunk: string | Uint8Array) => {
      writes += 1;
      if (writes === 3) throw new Error("physical write failed");
      return originalWrite(chunk);
    }) as typeof output.write;
    const commit = vi.fn(() => true);
    const connection = new ZCodeProtocolNdjsonConnection({
      handleMessage: async (message) =>
        "id" in message && "method" in message
          ? { id: message.id, result: { ack: {} } }
          : undefined,
      input,
      output,
      takePostResponseBatch: () => ({
        messages: [
          { method: "v4/conversation/frame", params: { fragmentIndex: 0 } },
          { method: "v4/conversation/frame", params: { fragmentIndex: 1 } },
        ],
        commit,
      }),
    });
    connection.start();
    input.end(frame({ id: "physical-fail", method: "v4/conversation/subscribe", params: {} }));
    await expect(connection.waitForClose()).rejects.toThrow("physical write failed");
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits after queue admission, then async EPIPE terminalizes the connection epoch", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    const commit = vi.fn(() => true);
    const clearPostResponseMessages = vi.fn();
    const takePostResponseBatch = vi.fn(() => ({
      messages: [{ method: "v4/conversation/frame", params: { kind: "complete" } }],
      commit,
    }));
    const connection = new ZCodeProtocolNdjsonConnection({
      clearPostResponseMessages,
      handleMessage: async (message) =>
        "id" in message && "method" in message
          ? { id: message.id, result: { ack: { subscriptionId: "sub-epoch" } } }
          : undefined,
      input,
      output,
      takePostResponseBatch,
    });
    connection.start();
    input.write(frame({ id: "async-epipe", method: "v4/conversation/subscribe", params: {} }));
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const acceptedBytes = written;

    output.emit("error", new Error("async write EPIPE"));
    await expect(connection.waitForClose()).rejects.toThrow("async write EPIPE");
    connection.send({ method: "v4/conversation/frame", params: { shouldNotWrite: true } });
    input.write(
      frame({ id: "new-epoch-required", method: "v4/conversation/subscribe", params: {} }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(written).toBe(acceptedBytes);
    expect(takePostResponseBatch).toHaveBeenCalledTimes(1);
    expect(clearPostResponseMessages).toHaveBeenCalledTimes(1);
    input.destroy();
  });

  it("writes the response before request-scoped initial notifications from one input chunk", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    const connection = new ZCodeProtocolNdjsonConnection({
      handleMessage: async (message) => {
        if (!("id" in message) || !("method" in message)) return undefined;
        return {
          id: message.id,
          result: {
            ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" },
          },
        };
      },
      input,
      output,
      takePostResponseMessages: (requestId) =>
        requestId === "subscribe-1"
          ? [
              {
                method: "v4/conversation/frame",
                params: {
                  topic: "conversation/session-1",
                  subscriptionId: "sub-1",
                  fromSeq: 0,
                  toSeq: 0,
                  sentAt: 1,
                  payload: { kind: "deltas", deltas: [] },
                },
              },
            ]
          : [],
    });
    connection.start();

    input.end(
      frame({
        id: "subscribe-1",
        method: "v4/conversation/subscribe",
        params: { topic: "conversation/session-1" },
      }),
    );
    await connection.waitForClose();

    const lines = written
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([
      {
        id: "subscribe-1",
        result: {
          ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" },
        },
      },
      {
        method: "v4/conversation/frame",
        params: expect.objectContaining({
          topic: "conversation/session-1",
          subscriptionId: "sub-1",
        }),
      },
    ]);
  });

  it("writes only the response line when a subscribe has no initial frame", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    const connection = new ZCodeProtocolNdjsonConnection({
      handleMessage: async (message) =>
        "id" in message && "method" in message
          ? {
              id: message.id,
              result: {
                ack: { subscriptionId: "sub-2", mode: "resume", logEpoch: "epoch-1" },
              },
            }
          : undefined,
      input,
      output,
      takePostResponseMessages: () => [],
    });
    connection.start();

    input.end(
      frame({
        id: "subscribe-2",
        method: "v4/conversation/subscribe",
        params: { topic: "conversation/session-1" },
      }),
    );
    await connection.waitForClose();

    expect(written.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(written.trim())).toEqual({
      id: "subscribe-2",
      result: {
        ack: { subscriptionId: "sub-2", mode: "resume", logEpoch: "epoch-1" },
      },
    });
  });

  it("clears post-response messages when queued request processing rejects", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const clearPostResponseMessages = vi.fn();
    const connection = new ZCodeProtocolNdjsonConnection({
      clearPostResponseMessages,
      handleMessage: async () => {
        throw new Error("request failed");
      },
      input,
      output,
    });
    connection.start();

    input.end(
      frame({
        id: "request-failure",
        method: "v4/conversation/subscribe",
        params: { topic: "conversation/session-1" },
      }),
    );

    await expect(connection.waitForClose()).rejects.toThrow("request failed");
    expect(clearPostResponseMessages).toHaveBeenCalledTimes(1);
  });

  it("clears post-response messages when a bypassed handler rejects", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const clearPostResponseMessages = vi.fn();
    const connection = new ZCodeProtocolNdjsonConnection({
      clearPostResponseMessages,
      handleMessage: async () => {
        throw new Error("bypass failed");
      },
      input,
      output,
    });
    connection.start();

    input.write(frame({ id: "server-1", result: {} }));

    await expect(connection.waitForClose()).rejects.toThrow("bypass failed");
    expect(clearPostResponseMessages).toHaveBeenCalledTimes(1);
  });

  it("clears on output EPIPE and discards an in-flight subscribe outbox that completes late", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const clearPostResponseMessages = vi.fn();
    const takePostResponseMessages = vi.fn(() => [
      {
        method: "v4/conversation/frame",
        params: { subscriptionId: "sub-late" },
      },
    ]);
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveResponse!: (value: {
      id: string;
      result: { ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } };
    }) => void;
    const response = new Promise<{
      id: string;
      result: { ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } };
    }>((resolve) => {
      resolveResponse = resolve;
    });
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    const connection = new ZCodeProtocolNdjsonConnection({
      clearPostResponseMessages,
      handleMessage: async () => {
        resolveStarted();
        return await response;
      },
      input,
      output,
      takePostResponseMessages,
    });
    connection.start();
    input.write(
      frame({
        id: "subscribe-late",
        method: "v4/conversation/subscribe",
        params: { topic: "conversation/session-1" },
      }),
    );
    await started;

    const closed = connection.waitForClose().then(
      () => null,
      (error: Error) => error,
    );
    output.emit("error", new Error("write EPIPE"));
    expect((await closed)?.message).toBe("write EPIPE");
    expect(clearPostResponseMessages).toHaveBeenCalledTimes(1);

    resolveResponse({
      id: "subscribe-late",
      result: {
        ack: { subscriptionId: "sub-late", mode: "snapshot", logEpoch: "epoch-1" },
      },
    });
    await vi.waitFor(() => expect(takePostResponseMessages).toHaveBeenCalledWith("subscribe-late"));
    expect(written).toBe("");
    input.destroy();
  });

  it("lets session/stop bypass a long-running request in the serial queue", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const handledMethods: string[] = [];
    const responses: unknown[] = [];
    let resolveStopHandled!: () => void;
    const stopHandled = new Promise<void>((resolve) => {
      resolveStopHandled = resolve;
    });

    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        if (line) {
          responses.push(JSON.parse(line));
        }
      }
    });

    const connection = new ZCodeProtocolNdjsonConnection({
      handleMessage: async (message) => {
        if (!("method" in message)) {
          return undefined;
        }
        handledMethods.push(message.method);
        if (message.method === zcodeProtocolMethods.sessionCompact) {
          return await new Promise<never>(() => undefined);
        }
        if (message.method === zcodeProtocolMethods.sessionStop && "id" in message) {
          resolveStopHandled();
          return { id: message.id, result: {} };
        }
        return undefined;
      },
      input,
      output,
    });
    connection.start();

    input.write(
      [
        frame({
          id: 1,
          method: zcodeProtocolMethods.sessionCompact,
          params: { sessionId: "sess_1" },
        }),
        frame({
          id: 2,
          method: zcodeProtocolMethods.sessionStop,
          params: { sessionId: "sess_1" },
        }),
      ].join(""),
    );

    const stopResult = await Promise.race([
      stopHandled.then(() => "handled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 30)),
    ]);

    expect(stopResult).toBe("handled");
    expect(handledMethods).toEqual([
      zcodeProtocolMethods.sessionCompact,
      zcodeProtocolMethods.sessionStop,
    ]);
    await vi.waitFor(() => {
      expect(responses).toContainEqual({ id: 2, result: {} });
    });
  });

  it("lets workspace cancellation abort an active model request before the serial queue advances", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: unknown[] = [];
    let releaseGenerate!: () => void;
    const generateReleased = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    let resolveCancelHandled!: () => void;
    const cancelHandled = new Promise<void>((resolve) => {
      resolveCancelHandled = resolve;
    });
    let generateActive = false;
    let generateCount = 0;
    let activeGenerateCount = 0;
    let maxActiveGenerateCount = 0;
    let cancelSawActiveGenerate = false;

    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        if (line) {
          responses.push(JSON.parse(line));
        }
      }
    });

    const connection = new ZCodeProtocolNdjsonConnection({
      handleMessage: async (message) => {
        if (!("method" in message) || !("id" in message)) {
          return undefined;
        }
        if (message.method === zcodeProtocolMethods.workspaceGenerateText) {
          generateCount += 1;
          generateActive = true;
          activeGenerateCount += 1;
          maxActiveGenerateCount = Math.max(maxActiveGenerateCount, activeGenerateCount);
          if (generateCount === 1) {
            await generateReleased;
          }
          activeGenerateCount -= 1;
          generateActive = false;
          return { id: message.id, result: { text: `generate-${generateCount}` } };
        }
        if (message.method === zcodeProtocolMethods.workspaceCancelGenerateText) {
          cancelSawActiveGenerate = generateActive;
          releaseGenerate();
          resolveCancelHandled();
          return {
            id: message.id,
            result: { operationId: "workspace-model-1", cancelled: true },
          };
        }
        return { id: message.id, result: {} };
      },
      input,
      output,
    });
    connection.start();

    input.write(
      [
        frame({
          id: 1,
          method: zcodeProtocolMethods.workspaceGenerateText,
          params: {
            operationId: "workspace-model-1",
            workspace: { workspaceKey: "/workspace/app", workspacePath: "/workspace/app" },
          },
        }),
        frame({
          id: 2,
          method: zcodeProtocolMethods.workspaceCancelGenerateText,
          params: { operationId: "workspace-model-1" },
        }),
        frame({
          id: 3,
          method: zcodeProtocolMethods.workspaceGenerateText,
          params: {
            operationId: "workspace-model-2",
            workspace: { workspaceKey: "/workspace/app", workspacePath: "/workspace/app" },
          },
        }),
      ].join(""),
    );

    const cancelResult = await Promise.race([
      cancelHandled.then(() => "handled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);

    expect(cancelResult).toBe("handled");
    expect(cancelSawActiveGenerate).toBe(true);
    input.end();
    await connection.waitForClose();
    expect(generateCount).toBe(2);
    expect(maxActiveGenerateCount).toBe(1);
    expect(responses).toContainEqual({
      id: 2,
      result: { operationId: "workspace-model-1", cancelled: true },
    });
    expect(responses).toContainEqual({ id: 3, result: { text: "generate-2" } });
  });

  it("lets protocol responses bypass a long-running request with later requests queued", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const handled: unknown[] = [];
    let resolveResponseHandled!: () => void;
    const responseHandled = new Promise<void>((resolve) => {
      resolveResponseHandled = resolve;
    });

    const connection = new ZCodeProtocolNdjsonConnection({
      handleMessage: async (message) => {
        handled.push(message);
        if ("method" in message && message.method === zcodeProtocolMethods.sessionCompact) {
          return await new Promise<never>(() => undefined);
        }
        if ("result" in message && "id" in message) {
          resolveResponseHandled();
        }
        return undefined;
      },
      input,
      output,
    });
    connection.start();

    input.write(
      [
        frame({
          id: 1,
          method: zcodeProtocolMethods.sessionCompact,
          params: { sessionId: "sess_1" },
        }),
        frame({
          id: 2,
          method: zcodeProtocolMethods.sessionRead,
          params: { sessionId: "sess_1" },
        }),
        frame({
          id: "server-1",
          result: { headersApplied: true },
        }),
      ].join(""),
    );

    const responseResult = await Promise.race([
      responseHandled.then(() => "handled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 30)),
    ]);

    expect(responseResult).toBe("handled");
    expect(handled).toHaveLength(2);
  });

  it("waits for a queued session/send to start before handling session/stop", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let releaseCompact!: () => void;
    const compactReleased = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    let releaseSend!: () => void;
    const sendReleased = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let resolveStopHandled!: () => void;
    const stopHandled = new Promise<void>((resolve) => {
      resolveStopHandled = resolve;
    });
    let sendActive = false;
    let stopSawActiveSend = false;

    const connection = new ZCodeProtocolNdjsonConnection({
      handleMessage: async (message) => {
        if (!("method" in message)) {
          return undefined;
        }
        if (message.method === zcodeProtocolMethods.sessionCompact) {
          await compactReleased;
        }
        if (message.method === zcodeProtocolMethods.sessionSend) {
          sendActive = true;
          await sendReleased;
          sendActive = false;
        }
        if (message.method === zcodeProtocolMethods.sessionStop) {
          stopSawActiveSend = sendActive;
          releaseSend();
          resolveStopHandled();
        }
        return "id" in message ? { id: message.id, result: {} } : undefined;
      },
      input,
      output,
    });
    connection.start();

    input.write(
      [
        frame({
          id: 1,
          method: zcodeProtocolMethods.sessionCompact,
          params: { sessionId: "sess_blocking" },
        }),
        frame({
          id: 2,
          method: zcodeProtocolMethods.sessionSend,
          params: { sessionId: "sess_target", inputId: "input_target", content: "run" },
        }),
        frame({
          id: 3,
          method: zcodeProtocolMethods.sessionStop,
          params: { sessionId: "sess_target" },
        }),
      ].join(""),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopSawActiveSend).toBe(false);

    releaseCompact();
    await stopHandled;
    expect(stopSawActiveSend).toBe(true);

    input.end();
    await connection.waitForClose();
  });

  it("answers plugin read requests while an install runs and another install waits behind it", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const installEntered = Promise.withResolvers<void>();
    const finishInstall = Promise.withResolvers<void>();
    const readsAnswered = Promise.withResolvers<void>();
    const readMethods: string[] = [
      zcodeProtocolMethods.pluginsDescribe,
      zcodeProtocolMethods.pluginsList,
      zcodeProtocolMethods.pluginsOverview,
    ];
    const order: string[] = [];
    const connection = new ZCodeProtocolNdjsonConnection({
      handleMessage: async (message) => {
        if (!("method" in message) || !("id" in message)) return undefined;
        order.push(`${message.method}#${message.id}`);
        if (message.id === 1) {
          installEntered.resolve();
          await finishInstall.promise;
        }
        if (order.length === 1 + readMethods.length) readsAnswered.resolve();
        return { id: message.id, result: {} };
      },
      input,
      output,
    });
    connection.start();
    try {
      input.write(frame({ id: 1, method: zcodeProtocolMethods.pluginsInstall, params: {} }));
      await installEntered.promise;
      // B 排在 A 后面时，详情和新标签页的列表加载也不能等「最后排队请求开始」这个屏障。
      input.write(
        frame({ id: 2, method: zcodeProtocolMethods.pluginsInstall, params: {} }) +
          readMethods.map((method, index) => frame({ id: index + 3, method, params: {} })).join(""),
      );
      await readsAnswered.promise;
      expect(order).toEqual([
        "plugins/install#1",
        "plugins/describe#3",
        "plugins/list#4",
        "plugins/overview#5",
      ]);
    } finally {
      finishInstall.resolve();
      input.end();
      await connection.waitForClose();
    }
    expect(order.at(-1)).toBe("plugins/install#2");
  });
});

function frame(message: ZCodeProtocolMessage): string {
  return `${JSON.stringify(message)}\n`;
}

describe("session lifecycle transport admission", () => {
  it("keeps lifecycle queries and operations available behind a hung ordinary request", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const entered: string[] = [];
    const gate = Promise.withResolvers<void>();
    const connection = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      handleMessage: async (message) => {
        if (!("method" in message) || !("id" in message)) return;
        entered.push(message.method);
        if (message.method === "workspace/readState") await gate.promise;
        return { id: message.id, result: {} };
      },
    });
    connection.start();
    input.write(frame({ id: "busy", method: "workspace/readState" }));
    input.write(frame({ id: "queued", method: "session/read", params: { sessionId: "a" } }));
    const methods = ["getState", "ensureReady", "stop", "restart"].map(
      (method) => `session/lifecycle/${method}`,
    );
    for (const method of methods)
      input.write(frame({ id: method, method: method as never, params: { sessionId: "a" } }));
    try {
      await vi.waitFor(() => expect(entered).toEqual(expect.arrayContaining(methods)));
      expect(entered).not.toContain("session/read");
    } finally {
      gate.resolve();
      input.end();
      await connection.waitForClose();
    }
  });
});

describe("shared CLI session admission", () => {
  it("admits another conversation and its control requests while one command is initializing", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const gate = Promise.withResolvers<void>();
    const entered: string[] = [];
    const connection = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      handleMessage: async (message) => {
        if (!("id" in message) || !("method" in message)) return;
        entered.push(String(message.id));
        if (message.id === "a") await gate.promise;
        return { id: message.id, result: {} };
      },
    });
    connection.start();
    input.write(frame({ id: "a", method: "v4/command", params: { sessionId: "a" } }));
    input.write(frame({ id: "b", method: "v4/command", params: { sessionId: "b" } }));
    input.write(
      frame({
        id: "observe-b",
        method: "v4/conversation/subscribe",
        params: { topic: "conversation/b" },
      }),
    );
    try {
      await vi.waitFor(() => expect(entered).toEqual(["a", "b", "observe-b"]));
    } finally {
      gate.resolve();
      input.end();
      await connection.waitForClose();
    }
  });
});

describe("workspace presentation admission", () => {
  it.each(["desktop-continuous", "web-remote-replayable"])(
    "%s: waits for prior policy, then preserves Provider FIFO without waiting for the catalog",
    async (clientMode) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const policy = Promise.withResolvers<void>();
      const catalog = Promise.withResolvers<void>();
      const firstAccount = Promise.withResolvers<void>();
      const entered: string[] = [];
      const replies: Array<{ id: string; result: { revision: number } }> = [];
      const workspace = {
        workspacePath: "/workspace/project",
        workspaceIdentity: "fixture-workspace",
        remoteSessionId: "fixture-attachment",
      };
      let policyApplied = false;
      let revision = 0;
      output.on("data", (chunk: Buffer) => {
        const reply = JSON.parse(chunk.toString("utf8"));
        replies.push(reply);
        // Host 只有在刷新 ACK 后才发历史订阅；目录完成与否不参与这个一致性屏障。
        if (reply.id === "refresh" && !input.writableEnded) {
          input.write(
            frame({
              id: "history",
              method: "v4/conversation/subscribe",
              params: { topic: "conversation/history", clientMode, workspace },
            }),
          );
        }
      });
      const connection = new ZCodeProtocolNdjsonConnection({
        input,
        output,
        handleMessage: async (message) => {
          if (!("id" in message) || !("method" in message)) return;
          entered.push(String(message.id));
          if (message.id === "policy") {
            await policy.promise;
            policyApplied = true;
          } else if (message.id === "catalog") {
            expect(policyApplied).toBe(true);
            expect(message.params).toEqual({ workspace });
            await catalog.promise;
          } else if (message.id === "account-1") {
            await firstAccount.promise;
            revision = 1;
          } else if (message.id === "account-2") {
            revision = 2;
          } else if (message.id === "history") {
            expect(message.params).toEqual({
              topic: "conversation/history",
              clientMode,
              workspace,
            });
          }
          return { id: message.id, result: { revision } };
        },
      });
      connection.start();
      try {
        input.write(
          [
            frame({
              id: "policy",
              method: zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy,
            }),
            frame({
              id: "catalog",
              method: zcodeProtocolMethods.workspaceReadPresentation,
              params: { workspace },
            }),
            frame({ id: "account-1", method: zcodeProtocolMethods.providerUpdateAccountConfig }),
            frame({ id: "account-2", method: zcodeProtocolMethods.providerUpdateAccountConfig }),
            frame({ id: "refresh", method: zcodeProtocolMethods.providerRefreshRegistry }),
          ].join(""),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(entered).toEqual(["policy"]);
        policy.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(entered).toEqual(["policy", "catalog", "account-1"]);
        expect(replies.map((reply) => reply.id)).not.toContain("history");
        firstAccount.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(entered).toEqual([
          "policy",
          "catalog",
          "account-1",
          "account-2",
          "refresh",
          "history",
        ]);
        expect(replies.filter((reply) => ["refresh", "history"].includes(reply.id))).toEqual([
          { id: "refresh", result: { revision: 2 } },
          { id: "history", result: { revision: 2 } },
        ]);
        expect(replies.map((reply) => reply.id)).not.toContain("catalog");
      } finally {
        policy.resolve();
        firstAccount.resolve();
        catalog.resolve();
        input.end();
        await connection.waitForClose();
      }
      expect(replies.at(-1)?.id).toBe("catalog");
    },
  );

  it("drains every admitted catalog response after EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const entered: number[] = [];
    const replied: number[] = [];
    const closed = vi.fn();
    output.on("data", (chunk: Buffer) => replied.push(JSON.parse(chunk.toString()).id));
    const connection = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      handleMessage: async (message) => {
        if (!("id" in message)) return;
        const id = Number(message.id);
        entered.push(id);
        await gates[id]!.promise;
        return { id, result: {} };
      },
    });
    connection.start();
    const closing = connection.waitForClose().then(closed);
    try {
      input.write(
        gates
          .map((_, id) => frame({ id, method: zcodeProtocolMethods.workspaceReadPresentation }))
          .join(""),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(entered).toEqual([0, 1]);
      input.end();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).not.toHaveBeenCalled();
      gates[1]!.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(replied).toEqual([1]);
      expect(closed).not.toHaveBeenCalled();
    } finally {
      for (const gate of gates) gate.resolve();
      input.end();
      await closing;
    }
    expect(replied).toEqual([1, 0]);
  });

  it("bounds EOF drain for a hung catalog and drops its late response", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const catalog = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const write = vi.fn();
    output.on("data", write);
    const connection = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      handleMessage: async (message) => {
        entered.resolve();
        await catalog.promise;
        return "id" in message ? { id: message.id, result: {} } : undefined;
      },
    });
    connection.start();
    input.write(frame({ id: "catalog", method: zcodeProtocolMethods.workspaceReadPresentation }));
    await entered.promise;
    input.end();
    await connection.waitForClose();
    catalog.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(write).not.toHaveBeenCalled();
    expect(input.listenerCount("data")).toBe(0);
  }, 1_000);

  it("does not start a queued catalog after the connection is aborted", async () => {
    const input = new PassThrough();
    const gate = Promise.withResolvers<void>();
    const controller = new AbortController();
    const entered: string[] = [];
    const connection = new ZCodeProtocolNdjsonConnection({
      input,
      output: new PassThrough(),
      signal: controller.signal,
      handleMessage: async (message) => {
        if (!("method" in message)) return;
        entered.push(message.method);
        await gate.promise;
        return "id" in message ? { id: message.id, result: {} } : undefined;
      },
    });
    connection.start();
    input.write(frame({ id: "config", method: zcodeProtocolMethods.providerUpdateAccountConfig }));
    input.write(frame({ id: "catalog", method: zcodeProtocolMethods.workspaceReadPresentation }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await connection.waitForClose();
    gate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(entered).toEqual([zcodeProtocolMethods.providerUpdateAccountConfig]);
    input.destroy();
  });

  it("fails the connection and clears outbox when catalog handling rejects", async () => {
    const input = new PassThrough();
    const clearPostResponseMessages = vi.fn();
    const connection = new ZCodeProtocolNdjsonConnection({
      input,
      output: new PassThrough(),
      clearPostResponseMessages,
      handleMessage: async () => {
        throw new Error("catalog failed");
      },
    });
    connection.start();
    const failed = expect(connection.waitForClose()).rejects.toThrow("catalog failed");
    input.write(frame({ id: "catalog", method: zcodeProtocolMethods.workspaceReadPresentation }));
    await failed;
    expect(clearPostResponseMessages).toHaveBeenCalledTimes(1);
    input.destroy();
  });
});
