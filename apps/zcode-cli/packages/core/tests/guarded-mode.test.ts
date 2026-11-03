import { describe, expect, it } from "vitest";
import {
  CronAutomationSchema,
  inheritPermissionMode,
  restrictPermissionMode,
  type CollaborationMode,
} from "@zcode/contracts";
import { PermissionService } from "../src/permission/service.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";

describe("Guarded is an opt-in mode, not a global gate", () => {
  it("independent Plan keeps its restriction over guarded dangerous commands", () => {
    const service = new PermissionService();
    const context = {
      toolName: "Bash",
      input: { command: "rm -rf build" },
      mode: "guarded" as const,
      riskLevel: "high" as const,
    };
    const capability = {
      ...bashToolEntry.metadata,
      userApprovalRule: "safety.bash.remove-critical-path",
    };
    expect(service.checkPermission({ ...context, planEnabled: true }, capability)).toMatchObject({
      decision: "deny",
      ruleId: "mode.plan.nonReadOnly",
    });
    expect(service.checkPermission({ ...context, planEnabled: false }, capability)).toMatchObject({
      decision: "ask",
      approvalMode: "user-once",
    });
  });
  it("guarded retains workflow alwaysAsk and ordinary session grants", () => {
    const service = new PermissionService();
    const context = {
      toolName: "CreateWorkflow",
      input: {},
      mode: "guarded" as const,
      riskLevel: "high" as const,
    };
    const capability = { alwaysAsk: true };
    expect(service.checkPermission(context, capability).decision).toBe("ask");
    service.grantSessionPermission([
      { type: "addRules", behavior: "allow", rules: [{ toolName: "CreateWorkflow" }] },
    ]);
    expect(service.checkPermission(context, capability).decision).toBe("allow");
  });
  it("automation records preserve explicit guarded/yolo and do not migrate absence", () => {
    const record = {
      automationId: "guarded-fixture",
      title: "fixture",
      cronExpr: "0 * * * *",
      prompt: "fixture",
      enabled: true,
      lifecycleStatus: "active",
      runCount: 0,
      recurring: true,
    };
    for (const mode of ["guarded", "yolo", undefined]) {
      const parsed = CronAutomationSchema.parse({ ...record, ...(mode ? { mode } : {}) });
      expect(parsed.mode).toBe(mode);
    }
  });
  it.each(["guarded", "yolo", "build", "edit", "plan", "auto"] as CollaborationMode[])(
    "inheritance from %s only transforms YOLO children",
    (parent) => {
      for (const child of [
        "yolo",
        "build",
        "edit",
        "plan",
        "auto",
        "guarded",
      ] as CollaborationMode[]) {
        expect(inheritPermissionMode(parent, child)).toBe(
          parent === "guarded" && child === "yolo" ? "guarded" : child,
        );
      }
    },
  );
  // 插件 profile 的 permissionMode 只能收紧：从严到宽 plan、build、edit、guarded、yolo；
  // auto 未实现，任一方是 auto 时都继承父会话模式。
  it.each([
    ["build", "yolo", "build"],
    ["build", "guarded", "build"],
    ["build", "edit", "build"],
    ["build", "build", "build"],
    ["build", "plan", "plan"],
    ["build", "auto", "build"],
    ["plan", "edit", "plan"],
    ["plan", "yolo", "plan"],
    ["edit", "yolo", "edit"],
    ["edit", "build", "build"],
    ["edit", "plan", "plan"],
    ["guarded", "yolo", "guarded"],
    ["guarded", "edit", "edit"],
    ["yolo", "yolo", "yolo"],
    ["yolo", "guarded", "guarded"],
    ["yolo", "plan", "plan"],
    ["yolo", "auto", "yolo"],
    ["auto", "plan", "auto"],
    ["auto", "yolo", "auto"],
  ] as Array<[CollaborationMode, CollaborationMode, CollaborationMode]>)(
    "restricting parent %s with child %s yields %s",
    (parent, child, expected) => {
      expect(restrictPermissionMode(parent, child)).toBe(expected);
    },
  );
  it("requires once approval only in guarded and preserves YOLO baseline for nonmatches", () => {
    const service = new PermissionService();
    for (const mode of ["guarded", "yolo"] as const) {
      for (const command of ["rm -rf build", "echo hello", "bash -c 'rm -rf build'"]) {
        const input = { command };
        const capability = bashToolEntry.resolvePermissionCapability?.(input, {
          mode,
          bashShellSelection: {
            dialect: "posix",
            source: "auto-detected",
            display: { name: "bash" },
          },
        });
        const decision = service.checkPermission(
          { toolName: "Bash", input, mode, riskLevel: "high" },
          { ...bashToolEntry.metadata, ...capability },
        );
        expect(decision.decision).toBe(
          mode === "guarded" && command === "rm -rf build" ? "ask" : "allow",
        );
        expect(decision.approvalMode).toBe(
          mode === "guarded" && command === "rm -rf build" ? "user-once" : undefined,
        );
      }
    }
  });

  // 2026-09-17 review：selection 缺失是基础设施状态，不能让 guarded 静默退回 YOLO。
  it("matches with POSIX grammar when the session shell selection is not yet available", () => {
    const input = { command: "rm -rf build" };
    const capability = bashToolEntry.resolvePermissionCapability?.(input, {
      mode: "guarded",
    });
    expect(capability).toEqual({
      userApprovalRule: "safety.bash.remove-critical-path",
    });
    const legacy = bashToolEntry.resolvePermissionCapability?.(input, {
      mode: "guarded",
      bashShellSelection: {
        dialect: "legacy-shell",
        source: "legacy-fallback",
        display: { name: "system shell" },
      },
    });
    expect(legacy).toBeUndefined();
  });
});
