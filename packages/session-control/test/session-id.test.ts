import { describe, expect, it } from "vitest";
import { createCliSessionControl } from "#session-control/application/cli/index";
import { createAppSessionControl } from "#session-control/application/app/index";
import { createOperationFeed, createTestPorts } from "#session-control/testing/index";
import { z } from "zod";
import {
  appReadSessionInputSchema,
  appRenameSessionInputSchema,
  appWaitSessionsInputSchema,
  cliReadSessionInputSchema,
  cliSendToSessionInputSchema,
  type AppSessionRef,
  type CliSessionRef,
  cliListSessionsInputSchema,
} from "#session-control/contract";

// 会话 ID 写法：与完整引用二选一，由可信端口解析后沿原有授权与 owner 校验执行。
const cliRoot: CliSessionRef = { kind: "cli", workspacePath: "/workspace", sessionId: "sess_root" };
const appRoot: AppSessionRef = {
  kind: "app",
  workspacePath: "/workspace",
  sourceServerId: "source-a",
  sessionId: "sess_root",
};

function cli() {
  const ports = createTestPorts("cli", cliRoot);
  return { ports, ctx: ports.context, control: createCliSessionControl(ports.cli) };
}
function app() {
  const ports = createTestPorts("app", appRoot);
  return { ports, ctx: ports.context, control: createAppSessionControl(ports.app) };
}

describe("sessionId target", () => {
  it("resolves sessionId through the trusted port before authorizing and calling the owner", async () => {
    const { control, ctx, ports } = cli();
    await control.sendToSession(ctx, { sessionId: "sess_target", prompt: "go", requestId: "r" });
    expect(ports.calls.map((call) => call.method)).toEqual([
      "resolveSession",
      "authorize",
      "sendToSession",
    ]);
    // owner 收到的是解析后的完整引用，不再带 sessionId。
    expect(ports.calls.at(-1)?.input).toEqual({
      session: { ...cliRoot, sessionId: "sess_target" },
      prompt: "go",
      requestId: "r",
    });
  });

  it("requires exactly one of session or sessionId on every target tool", async () => {
    const { control, ctx, ports } = app();
    const session = { ...appRoot, sessionId: "sess_target" };
    await expect(
      control.readSession(ctx, { session, sessionId: "sess_target", view: "summary" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(control.readSession(ctx, { view: "summary" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      control.setSessionPinned(ctx, { pinned: true, requestId: "r" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(ports.calls).toEqual([]);
  });

  it("reports an unknown ID as outside the trusted scope without reaching the owner", async () => {
    const { control, ctx, ports } = app();
    await expect(
      control.renameSession(ctx, { sessionId: "sess_missing-1", title: "x", requestId: "r" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(ports.calls.map((call) => call.method)).toEqual(["resolveSession"]);
  });

  // 规格 0.10：模型只有裸 ID 时仍自造 session 引用，被拒后只看到结果、不知道下一步。
  // 传 session 被拒时追加固定引导；传 sessionId 被拒时不加，避免暗示该 ID 存在于别处。
  it("tells a caller that guessed a full reference to use sessionId instead", async () => {
    const { control, ctx } = app();
    const foreign = { ...appRoot, sessionId: "sess_guessed", workspacePath: "/elsewhere" };
    await expect(
      control.readSession(ctx, { session: foreign, view: "summary" }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("sessionId"),
    });
  });

  it("does not add the sessionId hint when the caller already used sessionId", async () => {
    const { control, ctx } = app();
    await expect(
      control.readSession(ctx, { sessionId: "sess_missing-hint", view: "summary" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      control.readSession(ctx, { sessionId: "sess_missing-hint", view: "summary" }),
    ).rejects.not.toMatchObject({ message: expect.stringContaining("Pass only the session id") });
  });

  it("rejects a resolver that returns a different session", async () => {
    const { control, ctx, ports } = app();
    ports.app.sessions.resolveSession = async () => ({ ...appRoot, sessionId: "sess_other" });
    await expect(
      control.readSession(ctx, { sessionId: "sess_target", view: "summary" }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("keeps full references working unchanged and never calls the resolver for them", async () => {
    const { control, ctx, ports } = app();
    await control.openSession(ctx, { session: { ...appRoot, sessionId: "sess_target" } });
    expect(ports.calls.map((call) => call.method)).toEqual(["authorize", "openSession"]);
  });

  it("accepts sessionId on each wait operation and still rejects self-wait", async () => {
    const { control, ctx, ports } = cli();
    ports.cli.observations.open = async (_ctx, operation) =>
      createOperationFeed({ operation, epoch: "e", revision: 0, status: "completed" });
    await expect(
      control.waitSessions(ctx, {
        operations: [{ sessionId: "sess_target", commandId: "c" }],
        mode: "all",
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      operations: [{ operation: { session: { sessionId: "sess_target" }, commandId: "c" } }],
    });
    await expect(
      control.waitSessions(ctx, {
        operations: [{ sessionId: "sess_root", commandId: "future" }],
        mode: "all",
      }),
    ).rejects.toMatchObject({ code: "self_wait" });
    await expect(
      control.waitSessions(ctx, {
        operations: [{ commandId: "c" }],
        mode: "all",
      } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// 规格 0.11：工具层只暴露 sessionId。模型曾把两个字段都当必填并用 "dummy" 补齐完整引用，
// 一整轮调用因此全部失败；多传 session 必须被明确拒绝，不能静默忽略。
describe("model-facing target schema", () => {
  const targets = [
    ["app read", appReadSessionInputSchema],
    ["app rename", appRenameSessionInputSchema],
    ["cli read", cliReadSessionInputSchema],
    ["cli send", cliSendToSessionInputSchema],
  ] as const;

  it.each(targets)("%s exposes sessionId only", (_name, schema) => {
    const tool = (schema as unknown as { tool: { safeParse(v: unknown): { success: boolean } } })
      .tool;
    expect(tool).toBeDefined();
    const properties = Object.keys(
      (z.toJSONSchema(tool as never) as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(properties).toContain("sessionId");
    expect(properties).not.toContain("session");
  });

  // 会话 ID 有两种历史格式，都是真实身份（本机库实测 sess_ 6006 个、session_ 139 个），
  // 必须按原样精确查找，不能改写前缀。占位值要在 schema 这层就被挡住，而不是拖到授权才报越权。
  it.each([
    ["current sess_ form", "sess_159c9866-62b8-4e86-ba6f-e1bf544e859c", true],
    ["legacy session_ 32hex", "session_18f18883641b08761914d1f73bebeb5f", true],
    ["legacy session_ uuid", "session_12345678-1234-4234-8234-123456789abc", true],
    ["placeholder", "dummy", false],
    ["title instead of id", "创建 Markdown 语法示例文档", false],
    ["bare uuid without prefix", "159c9866-62b8-4e86-ba6f-e1bf544e859c", false],
    ["empty suffix", "sess_", false],
    ["path traversal", "sess_../escape", false],
  ] as const)("accepts %s: %s", (_name, sessionId, ok) => {
    const tool = (
      appReadSessionInputSchema as unknown as { tool: typeof appReadSessionInputSchema }
    ).tool;
    expect(tool.safeParse({ sessionId, view: "summary" }).success).toBe(ok);
  });

  it("rejects a caller that also sends a full reference", () => {
    const tool = (
      appReadSessionInputSchema as unknown as { tool: typeof appReadSessionInputSchema }
    ).tool;
    expect(tool.safeParse({ sessionId: "sess_s-1", view: "summary" }).success).toBe(true);
    // 旧行为下模型会补一个 dummy 引用；strictObject 必须直接拒绝，而不是忽略该字段。
    expect(
      tool.safeParse({
        sessionId: "sess_s-1",
        view: "summary",
        session: {
          kind: "app",
          sessionId: "dummy",
          sourceServerId: "dummy",
          workspacePath: "dummy",
        },
      }).success,
    ).toBe(false);
    expect(tool.safeParse({ view: "summary" }).success).toBe(false);
  });

  it("exposes wait operations without a full reference", () => {
    const tool = (
      appWaitSessionsInputSchema as unknown as { tool: typeof appWaitSessionsInputSchema }
    ).tool;
    expect(
      tool.safeParse({ operations: [{ sessionId: "sess_s-1", commandId: "c-1" }], mode: "all" })
        .success,
    ).toBe(true);
    // 规格 0.14：回执里的 operation 同时带 session 与 sessionId，必须能原样放回来——
    // 多出来的 session 被剥掉，而不是拒绝整次调用。
    const replayed = tool.safeParse({
      operations: [
        {
          sessionId: "sess_s-1",
          commandId: "c-1",
          session: { kind: "app", sessionId: "sess_s-1" },
        },
      ],
      mode: "all",
    });
    expect(replayed.success).toBe(true);
    expect(replayed.data?.operations[0]).toEqual({ sessionId: "sess_s-1", commandId: "c-1" });
  });
});

describe("standalone CLI read scope", () => {
  const otherWorkspace: CliSessionRef = {
    kind: "cli",
    workspacePath: "/elsewhere",
    sessionId: "sess_history",
  };

  it("reads a session from another workspace only when the trusted context grants local reads", async () => {
    const { control, ctx, ports } = cli();
    ports.cli.sessions.resolveSession = async () => otherWorkspace;
    await expect(
      control.readSession(ctx, { sessionId: "sess_history", view: "messages" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const reader = { ...ctx, readAnyLocalSession: true };
    await expect(
      control.readSession(reader, { sessionId: "sess_history", view: "messages" }),
    ).resolves.toMatchObject({ view: "messages", session: otherWorkspace });
  });

  it("does not widen write access to other workspaces", async () => {
    const { control, ctx, ports } = cli();
    ports.cli.sessions.resolveSession = async () => otherWorkspace;
    const reader = { ...ctx, readAnyLocalSession: true };
    await expect(
      control.renameSession(reader, { sessionId: "sess_history", title: "x", requestId: "r" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      control.sendToSession(reader, { sessionId: "sess_history", prompt: "go", requestId: "r" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(ports.calls.some((call) => call.method === "sendToSession")).toBe(false);
  });

  // 规格 0.14：workspace 过滤器已从工具面删除（发现链循环）。只读全库授权在场时读整个本机会话库，
  // 不在场时仍收窄到绑定 workspace 并复验返回行。
  it("lists the whole local store with the read grant and narrows to the bound workspace without it", async () => {
    const { control, ctx, ports } = cli();
    const reader = { ...ctx, readAnyLocalSession: true };
    ports.cli.sessions.listSessions = async () => ({
      sessions: [
        {
          session: otherWorkspace,
          title: "t",
          status: "unknown",
          availableActions: ["readSession"],
        },
      ],
    });
    await expect(control.listSessions(reader, {})).resolves.toMatchObject({
      sessions: [{ session: otherWorkspace }],
    });
    // 没有只读全库授权时，返回行必须落在绑定 workspace 内。
    await expect(control.listSessions(ctx, {})).rejects.toMatchObject({ code: "invalid_output" });
    expect(
      cliListSessionsInputSchema.safeParse({ workspace: { kind: "cli", workspacePath: "/w" } })
        .success,
    ).toBe(false);
  });
});
