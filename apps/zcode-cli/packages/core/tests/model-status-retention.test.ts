import { setImmediate } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type ModelStatusSink,
  type SessionEvent,
  type TraceContext,
} from "@zcode/contracts";
import { createModelStatusSink } from "../src/runtime/methods/model-status.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

const status = { type: "model_request_started", attempt: 1 } as const;
const trace = { traceId: "trace", spanId: "span" } as TraceContext;

function fixture() {
  const events: SessionEvent[] = [];
  const runtime = {
    logModelNetworkStatus() {},
    createEvent(type: string, payload: unknown) {
      return { type, payload };
    },
    async appendEvent() {},
  } as unknown as AgentRuntimeInternal;
  const sink = createModelStatusSink.call(runtime, trace, events);
  return { sink, events, runtime };
}

describe("model status sink lifetime", () => {
  it("releases captured runtime/events even when a copied ALS context retains the sink", async () => {
    const retained = (() => {
      const f = fixture();
      const refs = [new WeakRef(f.events), new WeakRef(f.runtime)];
      return runWithModelInvocationContext({ statusSink: f.sink }, () => ({
        context: { ...getCurrentModelInvocationContext() },
        refs,
      }));
    })();
    const sink = retained.context.statusSink as ModelStatusSink & Disposable;
    await sink.publish(status as never);
    sink[Symbol.dispose]();
    sink[Symbol.dispose]();
    await sink.publish(status as never);
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    for (let round = 0; round < 3; round++) {
      await setImmediate();
      gc();
    }
    for (const ref of retained.refs) expect(ref.deref()).toBeUndefined();
    expect(retained.context.statusSink).toBe(sink);
  });

  it("allows admitted publish to finish but ignores statuses after disposal", async () => {
    const f = fixture();
    const appended = Promise.withResolvers<void>();
    f.runtime.appendEvent = () => appended.promise;
    const pending = f.sink.publish(status as never);
    (f.sink as ModelStatusSink & Disposable)[Symbol.dispose]();
    await f.sink.publish(status as never);
    expect(f.events).toHaveLength(0);
    appended.resolve();
    await pending;
    expect(f.events).toHaveLength(1);
  });
});
