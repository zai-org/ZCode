import { describe, expect, it } from "vitest";
import {
  HookEventName,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type CollaborationMode,
  type DynamicWorkflowRunPort,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionRequestedPayload,
  type SessionEvent,
  type ToolExecutionResult,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { resumeWorkflowRunToolEntry } from "../src/tool/handlers/resume-workflow-run.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { HookRunner } from "../src/hooks/index.js";

/**
 * 记录 resume 请求的桩端口。只实现 resume（handler 唯一触达的方法），其余方法在被调用时
 * 抛错——本文件测的是权限 gate，任何对 getTask/waitForTask 的触达都说明接线跑偏了。
 */
function stubResumePort(runId: string): DynamicWorkflowRunPort {
  const unreachable = (name: string) => () => {
    throw new Error(`stubResumePort.${name} 不应被 ResumeWorkflowRun 权限路径触及`);
  };
  return {
    async resume() {
      return { ok: true, runId };
    },
    submit: unreachable("submit"),
    waitForTask: unreachable("waitForTask"),
    cancel: unreachable("cancel"),
    listEvents: unreachable("listEvents"),
  } as unknown as DynamicWorkflowRunPort;
}

interface RunOptions {
  broker?: PermissionBrokerPort;
  hookRunner?: HookRunner;
  mode?: CollaborationMode;
  name: string;
  runId: string;
}

interface RunOutcome {
  brokerRequests: PermissionBrokerRequest[];
  events: SessionEvent[];
  permissionRequested: PermissionRequestedPayload[];
  result: ToolExecutionResult;
}

/**
 * run() 全链路 harness（照 create-workflow-permission.test.ts）：免确认的行为只在 executor
 * 的真实链路里可证——手拼 handler 上下文证明不了「各模式都不发权限请求」。
 */
async function run(options: RunOptions): Promise<RunOutcome> {
  const sessionId = createSessionId(options.name);
  const turnId = createTurnId(options.name);
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const events: SessionEvent[] = [];
  const brokerRequests: PermissionBrokerRequest[] = [];
  const permissionBroker: PermissionBrokerPort = {
    async requestPermission(request, requestOptions) {
      brokerRequests.push(request);
      return (
        options.broker?.requestPermission(request, requestOptions) ?? { decision: "allow" as const }
      );
    },
  };

  const registry = createToolRegistry();
  registry.register(resumeWorkflowRunToolEntry);
  const executor = createToolExecutor({
    dynamicWorkflowRunPort: stubResumePort(options.runId),
    emitEvent: async (event) => {
      events.push(event);
    },
    ...(options.hookRunner ? { hookRunner: options.hookRunner } : {}),
    mode: options.mode ?? "build",
    permissionBroker,
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    turnId,
    traceContext,
  });

  const result = await executor.execute(
    {
      id: createToolCallId(options.name),
      input: { run_id: options.runId },
      name: "ResumeWorkflowRun",
    },
    { traceContext },
  );

  return {
    brokerRequests,
    events,
    permissionRequested: events
      .filter((event) => event.type === SessionEventType.PermissionRequested)
      .map((event) => event.payload as PermissionRequestedPayload),
    result,
  };
}

// 裁决（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Cancel and resume」，2026-08-30）：
// resume 被 scriptHash 钉死在 submit 时已获批准的同一脚本上，与 UI 按钮同一风险档——免确认
// 直行，任何权限模式都不弹窗；拦截面收敛到 PreToolUse deny 与项目 deny 规则。
describe("ResumeWorkflowRun prompt-less execution", () => {
  for (const mode of ["build", "yolo"] as const) {
    it(`${mode} 模式免确认直行：不发权限请求、不触 broker`, async () => {
      const outcome = await run({ mode, name: `resume-run-${mode}`, runId: "dwfrun-gate" });

      // 免确认的核心断言：既无 PermissionRequested 事件，也没有走到 broker——若只在事件面
      // 断言，一个「问了但没发事件」的实现会漏网。
      expect(outcome.permissionRequested).toHaveLength(0);
      expect(outcome.brokerRequests).toHaveLength(0);
      expect(outcome.result.success).toBe(true);
      expect(outcome.result.output).toMatchObject({
        ok: true,
        runId: "dwfrun-gate",
        status: "backgrounded",
        backgroundTaskId: "dwfrun-gate",
      });
    });
  }

  it("plan 模式按 read-only 契约直接拒绝（不是确认窗）", async () => {
    const outcome = await run({ mode: "plan", name: "resume-run-plan", runId: "dwfrun-plan" });

    // plan 模式只放行 readOnly 工具（checkPlanMode 的 mode.plan.nonReadOnly），resume 是
    // 执行面工具——免确认后从「先问」变成「模式级拒绝」，同样不产生权限请求。
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.brokerRequests).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.type).toBe("permission_denied");
    expect(outcome.result.error?.message).toContain(
      "Plan mode only allows read-only, non-destructive tools",
    );
    expect(outcome.events.some((event) => event.type === SessionEventType.ToolCallResult)).toBe(
      false,
    );
  });

  it("PreToolUse hook 的 deny 仍能拦截（拦截面不随免确认消失）", async () => {
    const hookRunner: HookRunner = {
      async run(input) {
        return input.hookEventName === HookEventName.PreToolUse
          ? { additionalContexts: [], permissionBehavior: "deny" }
          : { additionalContexts: [] };
      },
    };

    const outcome = await run({
      hookRunner,
      mode: "yolo",
      name: "resume-run-pretooluse-deny",
      runId: "dwfrun-hook-deny",
    });

    // deny 在执行前拦截（call-runner 的 PreToolUse 分支，与 needsApproval 无关）：
    // 回 permission_denied、handler 未执行（无 ToolCallResult 事件）、全程无权限请求。
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.type).toBe("permission_denied");
    expect(outcome.result.error?.message).toBe(
      "Hook PreToolUse:ResumeWorkflowRun denied this tool",
    );
    expect(outcome.events.some((event) => event.type === SessionEventType.ToolCallResult)).toBe(
      false,
    );
  });
});
