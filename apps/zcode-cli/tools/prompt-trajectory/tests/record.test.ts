import { deepStrictEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRecorderRuntimeConfig, executeFixtureSteps } from "../src/record.js";

describe("buildRecorderRuntimeConfig", () => {
  it("passes fixture outputStyle through while keeping deterministic recorder defaults", () => {
    const outputStyle = {
      keepCodingInstructions: true,
      name: "Trajectory Review Style",
      prompt: "Keep the answer concise and findings-first.",
    };
    const runtimeConfig = buildRecorderRuntimeConfig({
      fixture: {
        name: "output-style",
        runtimeConfig: {
          mcp: { enabled: true },
          mode: "plan",
          modelStreaming: "off",
          outputStyle,
        },
        steps: [{ text: "hello", type: "submitPrompt" }],
      },
      modelSelection: { model: "fake", provider: "openai" },
      workingDirectory: "/tmp/zcode-trajectory",
    });

    deepStrictEqual(runtimeConfig.outputStyle, outputStyle);
    equal(runtimeConfig.mode, "plan");
    equal(runtimeConfig.modelStreaming, "off");
    deepStrictEqual(runtimeConfig.mcp, { enabled: false });
    deepStrictEqual(runtimeConfig.memory, { enabled: false });
    deepStrictEqual(runtimeConfig.subagents, { enabled: false });
    deepStrictEqual(runtimeConfig.titleGeneration, { enabled: false });
  });

  it("passes prompt-shape runtime config through for custom system fixtures", () => {
    const runtimeConfig = buildRecorderRuntimeConfig({
      fixture: {
        name: "custom-system-prompt",
        runtimeConfig: {
          currentDate: "2026-06-04",
          systemPrompt: "Custom prompt from fixture.",
        },
        steps: [{ text: "hello", type: "submitPrompt" }],
      },
      modelSelection: { model: "fake", provider: "openai" },
      workingDirectory: "/tmp/zcode-trajectory",
    });

    equal(runtimeConfig.currentDate, "2026-06-04");
    equal(runtimeConfig.systemPrompt, "Custom prompt from fixture.");
  });

  it("allows fixture runtime config to enable subagents for tool-call trajectory cases", () => {
    const runtimeConfig = buildRecorderRuntimeConfig({
      fixture: {
        name: "subagents",
        runtimeConfig: {
          subagents: {
            enabled: true,
            maxTurns: 1,
          },
        },
        steps: [{ text: "hello", type: "submitPrompt" }],
      },
      modelSelection: { model: "fake", provider: "openai" },
      workingDirectory: "/tmp/zcode-trajectory",
    });

    deepStrictEqual(runtimeConfig.subagents, {
      enabled: true,
      maxTurns: 1,
    });
  });

  it("waits for runtime events between fixture submitPrompt steps", async () => {
    const submitted: string[] = [];
    const observedEvents: Array<{ type: string }> = [];
    const waiters = new Set<() => void>();
    const eventObserver = {
      sink: {
        onSessionEvent(event: { type: string }) {
          observedEvents.push(event);
          for (const waiter of waiters) waiter();
        },
      },
      waitForEvent(input: { eventType: string }) {
        if (observedEvents.some((event) => event.type === input.eventType)) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          waiters.add(() => {
            if (!observedEvents.some((event) => event.type === input.eventType)) return;
            waiters.clear();
            resolve();
          });
        });
      },
    };

    const steps = executeFixtureSteps({
      app: {
        async submitPrompt(prompt: string) {
          submitted.push(prompt);
          if (prompt === "first") {
            queueMicrotask(() =>
              eventObserver.sink.onSessionEvent({ type: "BackgroundTaskCompleted" }),
            );
          }
        },
      },
      eventObserver,
      steps: [
        { text: "first", type: "submitPrompt" },
        { eventType: "BackgroundTaskCompleted", type: "waitForEvent" },
        { text: "second", type: "submitPrompt" },
      ],
    });

    await steps;

    deepStrictEqual(submitted, ["first", "second"]);
  });

  it("passes submitPrompt attachments from fixture steps", async () => {
    const submitted: unknown[] = [];

    await executeFixtureSteps({
      app: {
        async submitPrompt(prompt: unknown) {
          submitted.push(prompt);
        },
      },
      eventObserver: {
        sink: {
          onSessionEvent() {},
        },
        async waitForEvent() {},
      },
      steps: [
        {
          attachments: [{ path: "notes.md", type: "file" }],
          text: "summarize attachment",
          type: "submitPrompt",
        },
      ],
    });

    deepStrictEqual(submitted, [
      {
        attachments: [{ path: "notes.md", type: "file" }],
        text: "summarize attachment",
      },
    ]);
  });
});
