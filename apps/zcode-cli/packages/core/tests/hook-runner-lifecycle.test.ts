import { describe, expect, it, vi } from "vitest";
import {
  HookEventName,
  HookOutcome,
  SessionEventType,
  createSessionId,
  createTraceId,
  createTurnId,
  type ExecutionPort,
  type HookExecutionDescriptor,
  type HookRunLifecyclePayload,
  type SessionEvent,
} from "@zcode/contracts";
import {
  createConfiguredHookRunner,
  createInMemoryHookRunner,
  sanitizeHookDisplayText,
} from "../src/hooks/index.js";
import { resolveHookTimeoutMs } from "../src/hooks/configured-runner-input.js";

const visibleDescriptor: HookExecutionDescriptor = {
  clientVisible: true,
  commandDisplay: "hook-command",
  executionMode: "foreground",
  executionType: "process",
  sourceKind: "user",
  sourcePath: "/Users/example/.zcode/cli/config.json",
  timeoutMs: 60_000,
};

function promptInput() {
  return {
    cwd: "/workspace",
    hookEventName: HookEventName.UserPromptSubmit,
    mode: "build" as const,
    prompt: "hello",
    sessionId: createSessionId("hook-lifecycle"),
    timestamp: new Date().toISOString(),
    traceId: createTraceId(),
    turnId: createTurnId("turn-1"),
  };
}

function lifecyclePayload(event: SessionEvent | undefined): HookRunLifecyclePayload | undefined {
  return event?.payload as HookRunLifecyclePayload | undefined;
}

describe("Hook runner lifecycle", () => {
  it("groups visible hooks under one invocation with one terminal event per execution", async () => {
    const events: SessionEvent[] = [];
    const runner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          callback: async () => undefined,
          descriptor: visibleDescriptor,
          event: HookEventName.UserPromptSubmit,
        },
        {
          callback: async () => ({ continue: false, reason: "blocked" }),
          descriptor: visibleDescriptor,
          event: HookEventName.UserPromptSubmit,
        },
      ],
    });

    await runner.run(promptInput());

    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.HookRunStarted,
      SessionEventType.HookRunCompleted,
      SessionEventType.HookRunStarted,
      SessionEventType.HookRunBlocked,
    ]);
    expect(new Set(events.map((event) => lifecyclePayload(event)?.hookInvocationId)).size).toBe(1);
    expect(events.map((event) => lifecyclePayload(event)?.hookCount)).toEqual([2, 2, 2, 2]);
    expect(events.map((event) => lifecyclePayload(event)?.hookIndex)).toEqual([0, 0, 1, 1]);
    expect(
      lifecyclePayload(events.find((event) => event.type === SessionEventType.HookRunBlocked))
        ?.blockReason,
    ).toBe("blocked");
  });

  it("distinguishes timeout and cancellation and continues after a failed hook", async () => {
    const events: SessionEvent[] = [];
    let laterHookRan = false;
    const runner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          callback: () => new Promise<never>(() => {}),
          descriptor: { ...visibleDescriptor, timeoutMs: 1 },
          event: HookEventName.UserPromptSubmit,
          timeoutMs: 1,
        },
        {
          callback: async () => {
            laterHookRan = true;
          },
          descriptor: visibleDescriptor,
          event: HookEventName.UserPromptSubmit,
        },
      ],
    });

    await runner.run(promptInput());

    expect(laterHookRan).toBe(true);
    const timedOut = events.find(
      (event) =>
        event.type === SessionEventType.HookRunFailed && lifecyclePayload(event)?.hookIndex === 0,
    );
    expect(lifecyclePayload(timedOut)?.outcome).toBe(HookOutcome.TimedOut);
    expect(
      events.filter(
        (event) =>
          lifecyclePayload(event)?.hookIndex === 0 &&
          (event.type === SessionEventType.HookRunCompleted ||
            event.type === SessionEventType.HookRunFailed ||
            event.type === SessionEventType.HookRunBlocked),
      ),
    ).toHaveLength(1);

    const cancelledEvents: SessionEvent[] = [];
    const controller = new AbortController();
    controller.abort("user cancelled");
    const cancelledRunner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        cancelledEvents.push(event);
      },
      hooks: [
        {
          callback: async () => undefined,
          descriptor: visibleDescriptor,
          event: HookEventName.UserPromptSubmit,
        },
      ],
    });
    await cancelledRunner.run(promptInput(), { signal: controller.signal });
    expect(
      lifecyclePayload(
        cancelledEvents.find((event) => event.type === SessionEventType.HookRunFailed),
      )?.outcome,
    ).toBe(HookOutcome.Cancelled);
  });

  it("returns immediately for async hooks and emits their terminal lifecycle later", async () => {
    const events: SessionEvent[] = [];
    let release: (() => void) | undefined;
    const runner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          async: true,
          callback: () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
          descriptor: { ...visibleDescriptor, executionMode: "background" },
          event: HookEventName.UserPromptSubmit,
        },
      ],
    });

    await runner.run(promptInput());
    expect(events.map((event) => event.type)).toEqual([SessionEventType.HookRunStarted]);

    release?.();
    await vi.waitFor(() => {
      expect(events.map((event) => event.type)).toEqual([
        SessionEventType.HookRunStarted,
        SessionEventType.HookRunCompleted,
      ]);
    });
  });

  it.each([
    {
      label: "per-hook timeoutMs",
      hook: { type: "process" as const, command: "hook", timeoutMs: 1_000.6 },
      defaultTimeoutMs: 60_000,
      expected: 1_001,
    },
    {
      label: "command timeout seconds",
      hook: { type: "command" as const, command: "hook", timeout: 1.0006 },
      defaultTimeoutMs: 60_000,
      expected: 1_001,
    },
    {
      label: "default timeoutMs",
      hook: { type: "process" as const, command: "hook" },
      defaultTimeoutMs: 60_000.6,
      expected: 60_001,
    },
    {
      label: "sub-millisecond timeout",
      hook: { type: "process" as const, command: "hook", timeoutMs: 0.4 },
      defaultTimeoutMs: 60_000,
      expected: 1,
    },
  ])(
    "normalizes fractional $label to positive integer milliseconds",
    ({ hook, defaultTimeoutMs, expected }) => {
      expect(resolveHookTimeoutMs(hook, defaultTimeoutMs)).toBe(expected);
    },
  );

  it("emits actual configured path, protocol, timeout, and redacted full command", async () => {
    const events: SessionEvent[] = [];
    const now = new Date();
    const executionPort: ExecutionPort = {
      async run() {
        return {
          status: "completed",
          exitCode: 0,
          stdout: { text: "", bytes: 0, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          durationMs: 2,
          timedOut: false,
          cancelled: false,
          startedAt: now,
          completedAt: now,
        };
      },
    };
    const runner = createConfiguredHookRunner({
      config: {
        enabled: true,
        events: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "process",
                  command: "${ZCODE_PLUGIN_ROOT}/hooks/check.mjs",
                  // 带空格的值：参数先逐个加引号再脱敏，整段遮住，不会只遮第一个词。
                  args: ["--token", "secret value"],
                  timeoutMs: 5_000,
                  statusMessage: "Checking policy",
                  plugin: {
                    dataPath: "/tmp/plugin-data",
                    id: "policy@example",
                    name: "Policy",
                    rootPath: "/tmp/policy-plugin",
                    sourcePath: "/tmp/policy-plugin/hooks/hooks.json",
                  },
                },
              ],
            },
          ],
        },
        maxOutputBytes: 1_024,
        timeoutMs: 60_000,
      },
      emitEvent: async (event) => {
        events.push(event);
      },
      executionPort,
      getWorkingDirectory: () => "/workspace",
    });

    await runner?.run(promptInput());

    expect(lifecyclePayload(events[0])?.descriptor).toMatchObject({
      clientVisible: true,
      commandDisplay: "/tmp/policy-plugin/hooks/check.mjs --token ••••",
      executionType: "process",
      pluginId: "policy@example",
      pluginName: "Policy",
      sourceKind: "plugin",
      sourcePath: "/tmp/policy-plugin/hooks/hooks.json",
      statusMessage: "Checking policy",
      timeoutMs: 5_000,
    });
  });

  it("carries stderr diagnostics when a configured hook returns a generic block reason", async () => {
    const events: SessionEvent[] = [];
    const now = new Date();
    const stderr =
      "python3: can't open file '/workspace/a.py': [Errno 2] No such file or directory";
    const executionPort: ExecutionPort = {
      async run() {
        return {
          status: "completed",
          exitCode: 0,
          stdout: {
            text: JSON.stringify({
              continue: false,
              reason: "hooks_prompt_block",
              hookSpecificOutput: { hookEventName: "UserPromptSubmit" },
            }),
            bytes: 100,
            truncated: false,
          },
          stderr: { text: stderr, bytes: stderr.length, truncated: false },
          durationMs: 2,
          timedOut: false,
          cancelled: false,
          startedAt: now,
          completedAt: now,
        };
      },
    };
    const runner = createConfiguredHookRunner({
      config: {
        enabled: true,
        events: {
          UserPromptSubmit: [{ hooks: [{ type: "process", command: "python3" }] }],
        },
        maxOutputBytes: 1_024,
        timeoutMs: 5_000,
      },
      emitEvent: async (event) => {
        events.push(event);
      },
      executionPort,
      getWorkingDirectory: () => "/workspace",
    });

    const result = await runner?.run(promptInput());
    const blocked = events.find((event) => event.type === SessionEventType.HookRunBlocked);

    expect(result?.stopReason).toBe("hooks_prompt_block");
    expect(lifecyclePayload(blocked)).toMatchObject({
      blockReason: "hooks_prompt_block",
      errorMessage: stderr,
      stderrPreview: stderr,
    });
  });

  it("redacts common credential forms before persistence", () => {
    expect(
      sanitizeHookDisplayText(
        "curl https://kevin:secret@example.com?api_key=abc --token xyz password=hunter2",
      ),
    ).toBe("curl https://••••:••••@example.com?api_key=•••• --token •••• password=••••");
    expect(sanitizeHookDisplayText("Authorization: Bearer secret-token")).toBe(
      "Authorization: Bearer ••••",
    );
    expect(
      sanitizeHookDisplayText(
        'curl -H "Authorization: Bearer secret-token" "https://example.com?api_key=abc" "password=hunter2"',
      ),
    ).toBe(
      'curl -H "Authorization: Bearer ••••" "https://example.com?api_key=••••" "password=••••"',
    );
    expect(sanitizeHookDisplayText("GITHUB_TOKEN=abc FOO_GITHUB_TOKEN=def")).toBe(
      "GITHUB_TOKEN=•••• FOO_GITHUB_TOKEN=••••",
    );
    expect(sanitizeHookDisplayText("postgres://user:pass@host/db")).toBe(
      "postgres://••••:••••@host/db",
    );
    expect(sanitizeHookDisplayText('{"password":"secret","api_key":"abc"}')).toBe(
      '{"password":••••,"api_key":••••}',
    );
  });

  // Bug 修复回归（H1）：admission 返回 skipLifecycle 的 hook 不发任何事件，
  // 但 clientVisibleHookCount 之前包含了它们 → 投影层 executions.length < hookCount
  // 永远为 true → hookInvocation row 卡在 running，UI 计时器永不停止。
  // 修复：先解析全部 matchingHooks 的 admission，把 skipLifecycle 的从参与列表
  // 剔除后再计算 clientVisibleHookCount。
  it("excludes skipLifecycle admission hooks from hookCount and emits no events for them", async () => {
    const events: SessionEvent[] = [];
    const runner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          // configured-disabled → admission skipLifecycle → 完全不可见
          admission: () => ({
            allowed: false,
            reasonCode: "workspace_hooks_feature_disabled",
            skipLifecycle: true,
          }),
          callback: async () => undefined,
          descriptor: visibleDescriptor,
          event: HookEventName.UserPromptSubmit,
        },
        {
          // pending → admission blocked 但参与生命周期
          admission: () => ({
            allowed: false,
            reasonCode: "workspace_hooks_pending_trust",
          }),
          callback: async () => undefined,
          descriptor: visibleDescriptor,
          event: HookEventName.UserPromptSubmit,
        },
      ],
    });

    await runner.run(promptInput());

    // skipLifecycle hook 不发任何事件
    expect(events.map((event) => event.type)).toEqual([SessionEventType.HookRunBlocked]);
    // hookCount 必须是 1（不是 2），否则投影层会等一个永远不来的 execution
    expect(lifecyclePayload(events[0])?.hookCount).toBe(1);
    expect(lifecyclePayload(events[0])?.hookIndex).toBe(0);
    expect(lifecyclePayload(events[0])?.errorCode).toBe("workspace_hooks_pending_trust");
  });
});
