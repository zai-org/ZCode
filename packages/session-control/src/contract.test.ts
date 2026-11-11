import { describe, expect, it } from "vitest";
import {
  appCreateSessionInputSchema,
  appListSessionsResultSchema,
  listProjectsResultSchema,
  listSessionsResultSchema,
  appProjectRefSchema,
  appSessionRefSchema,
  cliCreateSessionInputSchema,
  cliSessionRefSchema,
  createSessionResultSchema,
  operationSnapshotSchema,
  sendToSessionResultSchema,
  workspacePathSchema,
} from "#session-control/contract";

describe("session-control public wire contracts", () => {
  it("keeps project identity distinct from workspace and source identity", () => {
    expect(
      appProjectRefSchema.safeParse({
        kind: "app",
        projectId: "project-1",
        sourceServerId: "source",
      }).success,
    ).toBe(true);
    expect(
      appProjectRefSchema.safeParse({ kind: "app", workspacePath: "/workspace" }).success,
    ).toBe(false);
    expect(
      appCreateSessionInputSchema.safeParse({
        project: { kind: "app", workspacePath: "/workspace" },
        prompt: "run",
        requestId: "r",
      }).success,
    ).toBe(false);
    expect(
      appSessionRefSchema.safeParse({
        kind: "app",
        workspacePath: "/workspace",
        workspaceIdentity: "identity",
        sourceServerId: "source",
        sessionId: "sess_session",
        remoteSessionId: "connection",
      }).success,
    ).toBe(false);
  });
  it("accepts a client-only mode on the App createSession port but not on the model tool", () => {
    const input = {
      project: { kind: "app", projectId: "project-1", sourceServerId: "source" },
      prompt: "run",
      requestId: "r",
    };
    // 扩展新建会话时的权限模式（docs/plugins/extension-host.md §17.12）只进端口；模型的工具 schema 不变。
    expect(appCreateSessionInputSchema.safeParse({ ...input, mode: "yolo" }).success).toBe(true);
    expect(appCreateSessionInputSchema.safeParse({ ...input, mode: "plan" }).success).toBe(false);
    expect(Object.keys(appCreateSessionInputSchema.tool.shape)).not.toContain("mode");
    expect(
      appCreateSessionInputSchema.tool.safeParse({
        project: input.project,
        prompt: "run",
        mode: "yolo",
      }).success,
    ).toBe(false);
  });
  it("requires search coverage only for App lists and keeps CLI list output unchanged", () => {
    const searchScope = {
      scopes: [{ kind: "app", scope: "host", sourceServerId: "source" }],
      unavailableSources: [],
    };
    expect(appListSessionsResultSchema.safeParse({ sessions: [], searchScope }).success).toBe(true);
    expect(listProjectsResultSchema.safeParse({ projects: [], searchScope }).success).toBe(true);
    expect(appListSessionsResultSchema.safeParse({ sessions: [] }).success).toBe(false);
    expect(listProjectsResultSchema.safeParse({ projects: [] }).success).toBe(false);
    expect(listSessionsResultSchema.safeParse({ sessions: [] }).success).toBe(true);
    expect(listSessionsResultSchema.safeParse({ sessions: [], searchScope }).success).toBe(false);
    expect(
      appListSessionsResultSchema.safeParse({
        sessions: [
          {
            session: { kind: "cli", workspacePath: "/workspace", sessionId: "sess_session" },
            title: "CLI",
            status: "idle",
            availableActions: [],
          },
        ],
        searchScope,
      }).success,
    ).toBe(false);
    for (const invalid of [
      { scopes: searchScope.scopes },
      { scopes: [{ kind: "cli", workspacePath: "/workspace" }], unavailableSources: [] },
      { scopes: [], unavailableSources: [{ sourceServerId: "source" }] },
      {
        scopes: [],
        unavailableSources: [{ sourceServerId: "source", reason: "offline", retry: true }],
      },
      { ...searchScope, partial: true },
    ])
      expect(
        appListSessionsResultSchema.safeParse({ sessions: [], searchScope: invalid }).success,
      ).toBe(false);
  });
  it("supports absolute POSIX, drive and UNC paths without using platform IO", () => {
    for (const cwd of [
      "/workspace",
      "C:\\workspace",
      "D:/workspace",
      "\\\\server\\share\\workspace",
    ]) {
      // 规格 0.14 后 cwd 不再是工具参数，但跨平台路径规则仍服务 session 引用，直接测 schema 本身。
      expect(workspacePathSchema.safeParse(cwd).success).toBe(true);
    }
    expect(
      cliSessionRefSchema.safeParse({
        kind: "app",
        workspacePath: "/workspace",
        sessionId: "sess_session",
      }).success,
    ).toBe(false);
  });
  it("rejects invented completion states and impossible accepted creation receipts", () => {
    const session = { kind: "cli", workspacePath: "/workspace", sessionId: "sess_session" };
    const operation = { session, sessionId: session.sessionId, commandId: "command" };
    expect(
      operationSnapshotSchema.safeParse({
        operation,
        epoch: "epoch",
        revision: 1,
        status: "success",
      }).success,
    ).toBe(false);
    expect(
      createSessionResultSchema.safeParse({
        requestId: "r",
        creation: "rejected",
        firstInput: "accepted",
        delivery: "start_now",
        session,
        operation,
      }).success,
    ).toBe(false);
    expect(
      createSessionResultSchema.safeParse({
        requestId: "r",
        creation: "created",
        firstInput: "rejected",
        delivery: "none",
        session,
      }).success,
    ).toBe(true);
  });
  it("preserves request identity exactly, rejects whitespace IDs and contradictory admission delivery", () => {
    expect(
      cliCreateSessionInputSchema.safeParse({ cwd: "/workspace", prompt: "run", requestId: " r " })
        .success,
    ).toBe(false);
    const session = { kind: "cli", workspacePath: "/workspace", sessionId: "sess_session" };
    const operation = { session, commandId: "command" };
    expect(
      sendToSessionResultSchema.safeParse({
        session,
        operation,
        admission: "rejected",
        delivery: "queued",
      }).success,
    ).toBe(false);
    expect(
      sendToSessionResultSchema.safeParse({
        session,
        operation,
        admission: "accepted",
        delivery: "none",
      }).success,
    ).toBe(false);
  });
});
