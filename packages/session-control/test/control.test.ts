import { describe, expect, it, vi } from "vitest";
import { createCliSessionControl } from "#session-control/application/cli/index";
import { createAppSessionControl } from "#session-control/application/app/index";
import { createTestPorts } from "#session-control/testing/index";
import {
  appListProjectsInputSchema,
  appListSessionsInputSchema,
  cliCreateSessionInputSchema,
  type AppScope,
  type AppSessionRef,
  type CliSessionRef,
} from "#session-control/contract";

const cliRoot: CliSessionRef = { kind: "cli", workspacePath: "/workspace", sessionId: "sess_root" };
const cliTarget: CliSessionRef = { ...cliRoot, sessionId: "sess_target" };
const appRoot: AppSessionRef = {
  kind: "app",
  workspacePath: "/workspace",
  sourceServerId: "source-a",
  sessionId: "sess_root",
};
const appTarget: AppSessionRef = { ...appRoot, sessionId: "sess_target" };

function cliFixture() {
  const ports = createTestPorts("cli", cliRoot);
  return { ports, ctx: ports.context, control: createCliSessionControl(ports.cli) };
}
function appFixture() {
  const ports = createTestPorts("app", appRoot);
  return { ports, ctx: ports.context, control: createAppSessionControl(ports.app) };
}

describe("strict schemas and independent facades", () => {
  it("has only the eight CLI and twelve App application actions", () => {
    const { control } = cliFixture();
    expect(Object.keys(control).sort()).toEqual([
      "createSession",
      "forkSession",
      "interruptSession",
      "listSessions",
      "readSession",
      "renameSession",
      "sendToSession",
      "waitSessions",
    ]);
    expect(Object.keys(appFixture().control)).toHaveLength(12);
  });
  it("rejects unknown fields, blank input and spoofed context", async () => {
    const { control, ctx, ports } = cliFixture();
    // 规格 0.14：cwd 已从契约删除，多传即被 strictObject 拒。
    expect(
      cliCreateSessionInputSchema.safeParse({ cwd: "/workspace", prompt: "run", requestId: "r" })
        .success,
    ).toBe(false);
    expect(cliCreateSessionInputSchema.safeParse({ prompt: "run", requestId: "r" }).success).toBe(
      true,
    );
    await expect(
      control.sendToSession(ctx, {
        session: cliTarget,
        prompt: "run",
        requestId: "r",
        callerId: "spoof",
      } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      control.sendToSession(ctx, { session: cliTarget, prompt: " ", requestId: "r" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(ports.calls).toEqual([]);
  });
  it("rejects kind, workspace and source crossings before owner calls", async () => {
    const { control, ctx, ports } = appFixture();
    await expect(
      control.readSession(ctx, { session: cliTarget as never, view: "summary" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    for (const session of [
      { ...appTarget, workspacePath: "/other" },
      { ...appTarget, sourceServerId: "source-b" },
    ]) {
      await expect(control.readSession(ctx, { session, view: "summary" })).rejects.toMatchObject({
        code: "forbidden",
      });
    }
    expect(ports.calls).toEqual([]);
  });
  it("checks access grants and output schema instead of trusting adapter types", async () => {
    const { control, ctx, ports } = cliFixture();
    ports.cli.access.authorize = async () => ({
      scope: { kind: "cli", workspacePath: "/other" },
      fence: "epoch",
    });
    await expect(
      control.readSession(ctx, { session: cliTarget, view: "summary" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const other = cliFixture();
    other.ports.cli.execution.sendToSession = async () =>
      ({
        session: cliTarget,
        operation: { session: cliTarget, sessionId: cliTarget.sessionId, commandId: "r" },
        admission: "accepted",
        delivery: "queued",
        unexpected: true,
      }) as never;
    await expect(
      other.control.sendToSession(other.ctx, { session: cliTarget, prompt: "go", requestId: "r" }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });
  it("rejects wrong-session receipts and cross-scope list output", async () => {
    const { control, ctx, ports } = cliFixture();
    ports.cli.execution.sendToSession = async () => ({
      requestId: "r",
      session: cliRoot,
      operation: { session: cliRoot, sessionId: cliRoot.sessionId, commandId: "r" },
      admission: "accepted",
      delivery: "queued",
    });
    await expect(
      control.sendToSession(ctx, { session: cliTarget, prompt: "go", requestId: "r" }),
    ).rejects.toMatchObject({ code: "invalid_output" });
    ports.cli.sessions.listSessions = async () => ({
      sessions: [
        {
          session: { ...cliTarget, workspacePath: "/other" },
          title: "private",
          status: "idle",
          availableActions: [],
        },
      ],
    });
    await expect(control.listSessions(ctx, {})).rejects.toMatchObject({ code: "invalid_output" });
  });
});

describe("CLI owner boundary", () => {
  it("preserves trace fields and keeps different workspace identities isolated", async () => {
    const { control, ctx, ports } = cliFixture();
    const traced = { ...ctx, traceId: "trace-1", turnId: "turn-1", toolCallId: "tool-1" };
    await control.renameSession(traced, {
      session: cliTarget,
      title: "Renamed",
      requestId: "rename",
    });
    expect(ports.calls.at(-1)?.ctx).toBe(traced);
    await expect(
      control.readSession(ctx, {
        session: { ...cliTarget, workspaceIdentity: "other-identity" },
        view: "summary",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("passes stable identity and fence without retries or another admission queue", async () => {
    const { control, ctx, ports } = cliFixture();
    const input = { session: cliTarget, prompt: "go", requestId: "stable-request" };
    const result = await control.sendToSession(ctx, input);
    expect(result.admission).toBe("accepted");
    expect(result.delivery).toBe("queued");
    expect(ports.calls.map((call) => call.method)).toEqual(["authorize", "sendToSession"]);
    expect(ports.calls[1]).toMatchObject({ ctx, input, grant: { fence: "test-epoch" } });
    ports.cli.execution.sendToSession = vi.fn(async () => {
      throw new Error("owner unknown");
    });
    await expect(control.sendToSession(ctx, input)).rejects.toThrow("owner unknown");
    expect(ports.cli.execution.sendToSession).toHaveBeenCalledTimes(1);
  });
  it("keeps partial create results and never retries rejected first input", async () => {
    const { control, ctx, ports } = cliFixture();
    ports.cli.execution.createSession = async () => ({
      requestId: "r",
      creation: "created",
      firstInput: "rejected",
      delivery: "none",
      session: cliTarget,
      reason: "provider unavailable",
    });
    await expect(
      control.createSession(ctx, { prompt: "go", requestId: "r" }),
    ).resolves.toMatchObject({ creation: "created", firstInput: "rejected" });
    expect(ports.calls.map((call) => call.method)).toEqual(["authorize"]);
  });
  it("defaults lists to the trusted root workspace, and forwards explicit execution guards", async () => {
    const { control, ctx, ports } = cliFixture();
    await control.listSessions(ctx, {});
    expect(ports.calls[1]?.input).toMatchObject({
      workspace: { kind: "cli", workspacePath: "/workspace" },
    });
    await control.interruptSession(ctx, {
      session: cliTarget,
      expectedExecutionId: "execution-2",
      requestId: "stop",
    });
    expect(ports.calls.at(-1)?.input).toMatchObject({
      expectedExecutionId: "execution-2",
      requestId: "stop",
    });
  });
  it("forks without automatically sending and preserves the stable history point", async () => {
    const { control, ctx, ports } = cliFixture();
    await control.forkSession(ctx, {
      session: cliTarget,
      atMessage: "message-5",
      requestId: "fork",
    });
    expect(ports.calls.map((call) => call.method)).toEqual(["authorize", "forkSession"]);
    expect(ports.calls.at(-1)?.input).toMatchObject({ atMessage: "message-5" });
  });
});

describe("App side effect boundaries", () => {
  it("defaults to discovery across projects and sources even when the root is unclassified", async () => {
    const { control, ctx, ports } = appFixture();
    const discoveryScopes: AppScope[] = [
      { kind: "app", scope: "host", sourceServerId: "source-a" },
      { kind: "app", scope: "project", projectId: "remote", sourceServerId: "source-b" },
    ];
    const discovery = { ...ctx, rootSession: appRoot, discoveryScopes };
    const sessions = [
      {
        ...appTarget,
        project: { kind: "app" as const, projectId: "novel", sourceServerId: "source-a" },
      },
      {
        ...appTarget,
        sourceServerId: "source-b",
        project: { kind: "app" as const, projectId: "remote", sourceServerId: "source-b" },
      },
      appTarget,
    ].map((session) => ({
      session,
      title: "2000字小说创作",
      status: "idle" as const,
      availableActions: [],
    }));
    const result = { sessions, searchScope: { scopes: discoveryScopes, unavailableSources: [] } };
    const listSessions = vi.fn(async () => result);
    ports.app.sessions.listSessions = listSessions;
    await expect(control.listSessions(discovery, { query: "小说" })).resolves.toEqual(result);
    expect(listSessions).toHaveBeenCalledWith(
      discovery,
      { query: "小说", archived: "exclude" },
      discoveryScopes.map((scope) => ({ scope, fence: "test-epoch" })),
    );
    expect(ports.calls.every((call) => call.ctx === discovery)).toBe(true);
    expect(discovery.allowedScopes).toBe(ctx.allowedScopes);
    const projects = sessions.flatMap(({ session }) =>
      session.project ? [{ project: session.project, title: "小说项目" }] : [],
    );
    ports.app.projects.listProjects = vi.fn(async () => ({
      projects,
      searchScope: result.searchScope,
    }));
    await expect(control.listProjects(discovery, {})).resolves.toEqual({
      projects,
      searchScope: result.searchScope,
    });
    expect(ports.app.projects.listProjects).toHaveBeenCalledWith(
      discovery,
      {},
      discoveryScopes.map((scope) => ({ scope, fence: "test-epoch" })),
    );
  });
  it("falls back to existing grants without injecting a root project or workspace", async () => {
    const { control, ctx, ports } = appFixture();
    await expect(control.listSessions(ctx, {})).resolves.toEqual({
      sessions: [],
      searchScope: { scopes: ctx.allowedScopes, unavailableSources: [] },
    });
    expect(ports.calls.at(-1)?.input).toEqual({ archived: "exclude" });
    expect(ports.calls.at(-1)?.grant).toEqual(
      ctx.allowedScopes.map((scope) => ({ scope, fence: "test-epoch" })),
    );
    await control.listSessions({ ...ctx, rootSession: appRoot }, {});
    expect(ports.calls.at(-1)?.input).toEqual({ archived: "exclude" });
  });
  it("does not fall back to operation permissions when discovery is explicitly empty", async () => {
    const { control, ctx, ports } = appFixture();
    const discovery = { ...ctx, discoveryScopes: [] };
    await expect(control.listSessions(discovery, {})).resolves.toEqual({
      sessions: [],
      searchScope: { scopes: [], unavailableSources: [] },
    });
    await expect(control.listProjects(discovery, {})).resolves.toEqual({
      projects: [],
      searchScope: { scopes: [], unavailableSources: [] },
    });
    expect(ports.calls.some((call) => call.method === "authorize")).toBe(false);
    await expect(
      control.listSessions(discovery, { project: ctx.rootSession.project }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("narrows explicit project, workspace and host filters without changing the caller context", async () => {
    const { control, ctx, ports } = appFixture();
    const discovery = {
      ...ctx,
      discoveryScopes: [{ kind: "app", scope: "host", sourceServerId: "source-a" }] as AppScope[],
    };
    const project = {
      kind: "app" as const,
      projectId: "other-project",
      sourceServerId: "source-a",
    };
    await control.listSessions(discovery, { project });
    expect(ports.calls.at(-1)).toMatchObject({
      ctx: discovery,
      input: { project, archived: "exclude" },
      grant: [{ scope: { ...project, scope: "project" }, fence: "test-epoch" }],
    });
    const workspace = {
      kind: "app" as const,
      workspacePath: "/other-workspace",
      sourceServerId: "source-a",
    };
    // 规格 0.14：workspace 过滤器已从契约删除（发现链循环），多传即被 strictObject 拒。
    expect(appListSessionsInputSchema.safeParse({ workspace }).success).toBe(false);
    const callsBeforeForbidden = ports.calls.length;
    await expect(
      control.listSessions(discovery, { project: { ...project, sourceServerId: "source-b" } }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // 规格 0.14：host 过滤器已删除，发现范围恒为可信上下文授予的全部来源。
    expect(appListProjectsInputSchema.safeParse({ host: "source-b" }).success).toBe(false);
    expect(ports.calls).toHaveLength(callsBeforeForbidden);
  });
  it("rejects project rows and other identities in an explicit unclassified workspace result", async () => {
    const { control, ctx, ports } = appFixture();
    const workspace = {
      kind: "app" as const,
      workspacePath: "/workspace",
      sourceServerId: "source-a",
    };
    const discovery = {
      ...ctx,
      discoveryScopes: [{ kind: "app", scope: "host", sourceServerId: "source-a" }] as AppScope[],
    };
    const searchScope = {
      scopes: [{ ...workspace, scope: "workspace" as const }],
      unavailableSources: [],
    };
    for (const session of [
      { ...appTarget, project: ctx.rootSession.project },
      { ...appTarget, workspaceIdentity: "other-workspace" },
      { ...appTarget, sourceServerId: "source-b" },
    ]) {
      ports.app.sessions.listSessions = async () => ({
        sessions: [{ session, title: "hidden", status: "idle", availableActions: [] }],
        searchScope,
      });
      // 不再有显式 workspace 过滤；输出复验仍按回执声明的搜索范围拒绝越界行。
      await expect(control.listSessions(discovery, {})).rejects.toMatchObject({
        code: "invalid_output",
      });
    }
    ports.app.sessions.listSessions = async () => ({
      sessions: [
        { session: appTarget, title: "unclassified", status: "idle", availableActions: [] },
      ],
      searchScope,
    });
    await expect(control.listSessions(discovery, {})).resolves.toMatchObject({
      sessions: [{ session: appTarget }],
    });
  });
  it("rejects wrong source, project or inconsistent project source from a discovered project", async () => {
    const { control, ctx, ports } = appFixture();
    const project = ctx.rootSession.project!;
    const scope: AppScope = { ...project, scope: "project" };
    const searchScope = { scopes: [scope], unavailableSources: [] };
    for (const session of [
      { ...appTarget, project: { ...project, projectId: "forbidden" } },
      { ...appTarget, sourceServerId: "source-b", project },
      { ...appTarget, project: { ...project, sourceServerId: "source-b" } },
      appTarget,
    ]) {
      ports.app.sessions.listSessions = async () => ({
        sessions: [{ session, title: "hidden", status: "idle", availableActions: [] }],
        searchScope,
      });
      await expect(
        control.listSessions({ ...ctx, discoveryScopes: [scope] }, {}),
      ).rejects.toMatchObject({ code: "invalid_output" });
      await expect(
        control.listSessions(
          { ...ctx, discoveryScopes: [{ kind: "app", scope: "host", sourceServerId: "source-a" }] },
          { project },
        ),
      ).rejects.toMatchObject({ code: "invalid_output" });
    }
  });
  it("keeps discovered sessions outside operation grants forbidden for read and send", async () => {
    const { control, ctx, ports } = appFixture();
    const discovery = {
      ...ctx,
      allowedScopes: [{ ...ctx.rootSession.project!, scope: "project" as const }],
      discoveryScopes: [{ kind: "app", scope: "host", sourceServerId: "source-a" }] as AppScope[],
    };
    const session = {
      ...appTarget,
      project: { ...ctx.rootSession.project!, projectId: "other-project" },
    };
    ports.app.sessions.listSessions = async () => ({
      sessions: [{ session, title: "2000字小说创作", status: "idle", availableActions: [] }],
      searchScope: { scopes: discovery.discoveryScopes, unavailableSources: [] },
    });
    const result = await control.listSessions(discovery, {});
    const returned = result.sessions[0]!.session;
    const callsAfterDiscovery = ports.calls.length;
    await expect(
      control.readSession(discovery, { session: returned, view: "messages" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      control.sendToSession(discovery, { session: returned, prompt: "go", requestId: "denied" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(ports.calls).toHaveLength(callsAfterDiscovery);
  });
  it("preserves successful subscopes and reports unavailable sources as partial coverage", async () => {
    const { control, ctx, ports } = appFixture();
    const discoveryScopes: AppScope[] = [
      { kind: "app", scope: "host", sourceServerId: "source-a" },
      { kind: "app", scope: "host", sourceServerId: "source-b" },
    ];
    const project = ctx.rootSession.project!;
    const searchScope = {
      scopes: [{ ...project, scope: "project" as const }],
      unavailableSources: [{ sourceServerId: "source-b", reason: "disconnected" }],
    };
    ports.app.sessions.listSessions = async () => ({ sessions: [], searchScope });
    ports.app.projects.listProjects = async () => ({ projects: [], searchScope });
    await expect(control.listSessions({ ...ctx, discoveryScopes }, {})).resolves.toEqual({
      sessions: [],
      searchScope,
    });
    await expect(control.listProjects({ ...ctx, discoveryScopes }, {})).resolves.toEqual({
      projects: [],
      searchScope,
    });
    const unavailableOnly = {
      scopes: [],
      unavailableSources: [{ sourceServerId: "source-a", reason: "disconnected" }],
    };
    ports.app.sessions.listSessions = async () => ({ sessions: [], searchScope: unavailableOnly });
    await expect(control.listSessions({ ...ctx, discoveryScopes }, {})).resolves.toEqual({
      sessions: [],
      searchScope: unavailableOnly,
    });
  });
  it.each(["host-widening", "wrong-source", "wrong-project"])(
    "rejects %s in list searchScope even when no rows are returned",
    async (kind) => {
      const { control, ctx, ports } = appFixture();
      const project = ctx.rootSession.project!;
      const allowed: AppScope = { ...project, scope: "project" };
      const scopes: AppScope[] =
        kind === "host-widening"
          ? [{ kind: "app", scope: "host", sourceServerId: "source-a" }]
          : [
              {
                ...allowed,
                ...(kind === "wrong-source"
                  ? { sourceServerId: "source-b" }
                  : kind === "wrong-project"
                    ? { projectId: "private" }
                    : {}),
              },
            ];
      const searchScope = {
        scopes,
        unavailableSources: [],
      };
      ports.app.sessions.listSessions = async () => ({ sessions: [], searchScope });
      ports.app.projects.listProjects = async () => ({ projects: [], searchScope });
      const discovery = { ...ctx, discoveryScopes: [allowed] };
      await expect(control.listSessions(discovery, {})).rejects.toMatchObject({
        code: "invalid_output",
      });
      await expect(control.listProjects(discovery, {})).rejects.toMatchObject({
        code: "invalid_output",
      });
    },
  );
  it("reports unavailable legacy sources without granting discovery or accepting their rows", async () => {
    const { control, ctx, ports } = appFixture();
    const discovery = { ...ctx, discoveryScopes: [] };
    const searchScope = {
      scopes: [],
      unavailableSources: [
        { sourceServerId: "legacy-source", reason: "project identity unavailable" },
      ],
    };
    ports.app.sessions.listSessions = async () => ({ sessions: [], searchScope });
    ports.app.projects.listProjects = async () => ({ projects: [], searchScope });
    await expect(control.listSessions(discovery, {})).resolves.toEqual({
      sessions: [],
      searchScope,
    });
    await expect(control.listProjects(discovery, {})).resolves.toEqual({
      projects: [],
      searchScope,
    });
    expect(ports.calls).toEqual([]);
    const project = { kind: "app" as const, projectId: "private", sourceServerId: "legacy-source" };
    const session = { ...appTarget, sourceServerId: "legacy-source", project };
    ports.app.sessions.listSessions = async () => ({
      sessions: [{ session, title: "private", status: "idle", availableActions: [] }],
      searchScope,
    });
    ports.app.projects.listProjects = async () => ({
      projects: [{ project, title: "private" }],
      searchScope,
    });
    await expect(control.listSessions(discovery, {})).rejects.toMatchObject({
      code: "invalid_output",
    });
    await expect(control.listProjects(discovery, {})).rejects.toMatchObject({
      code: "invalid_output",
    });
    await expect(control.listSessions(discovery, { project })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      control.readSession(discovery, { session, view: "messages" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      control.sendToSession(discovery, { session, prompt: "go", requestId: "legacy-denied" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("validates searchScope against an explicit project filter and against the granted sources", async () => {
    const { control, ctx, ports } = appFixture();
    const discoveryScopes: AppScope[] = [
      { kind: "app", scope: "host", sourceServerId: "source-a" },
      { kind: "app", scope: "host", sourceServerId: "source-b" },
    ];
    const discovery = { ...ctx, discoveryScopes };
    ports.app.sessions.listSessions = async () => ({
      sessions: [],
      searchScope: { scopes: discoveryScopes, unavailableSources: [] },
    });
    // host 过滤器已删除（规格 0.14），发现范围恒为全部授权来源；回执仍不得声明超出授权的范围。
    ports.app.projects.listProjects = async () => ({
      projects: [],
      searchScope: {
        scopes: [...discoveryScopes, { kind: "app", scope: "host", sourceServerId: "source-c" }],
        unavailableSources: [],
      },
    });
    await expect(
      control.listSessions(discovery, { project: ctx.rootSession.project }),
    ).rejects.toMatchObject({ code: "invalid_output" });
    await expect(control.listProjects(discovery, {})).rejects.toMatchObject({
      code: "invalid_output",
    });
  });
  it("rejects rows that are authorized but absent from the reported successful search", async () => {
    const { control, ctx, ports } = appFixture();
    const discovery = {
      ...ctx,
      discoveryScopes: [{ kind: "app", scope: "host", sourceServerId: "source-a" }] as AppScope[],
    };
    const project = ctx.rootSession.project!;
    const searchScope = {
      scopes: [],
      unavailableSources: [{ sourceServerId: "source-a", reason: "disconnected" }],
    };
    ports.app.sessions.listSessions = async () => ({
      sessions: [
        { session: { ...appTarget, project }, title: "late", status: "idle", availableActions: [] },
      ],
      searchScope,
    });
    ports.app.projects.listProjects = async () => ({
      projects: [{ project, title: "late" }],
      searchScope,
    });
    await expect(control.listSessions(discovery, {})).rejects.toMatchObject({
      code: "invalid_output",
    });
    await expect(control.listProjects(discovery, {})).rejects.toMatchObject({
      code: "invalid_output",
    });
  });
  it("read, archive and pin do not navigate, stop or send", async () => {
    const { control, ctx, ports } = appFixture();
    await control.readSession(ctx, { session: appTarget, view: "messages" });
    await control.setSessionArchived(ctx, {
      session: appTarget,
      archived: true,
      requestId: "archive",
    });
    await control.setSessionPinned(ctx, { session: appTarget, pinned: true, requestId: "pin" });
    expect(ports.calls.map((call) => call.method)).toEqual([
      "authorize",
      "readSession",
      "authorize",
      "setSessionArchived",
      "authorize",
      "setSessionPinned",
    ]);
  });
  it("uses target project configuration and retains creation versus first-input outcomes", async () => {
    const { control, ctx, ports } = appFixture();
    const project = { kind: "app" as const, projectId: "project-1", sourceServerId: "source-a" };
    await control.createSession(ctx, {
      project,
      prompt: "go",
      requestId: "create",
      model: "model-choice",
    });
    expect(ports.calls.at(-1)?.input).toEqual({
      project,
      prompt: "go",
      requestId: "create",
      model: "model-choice",
    });
    expect(ports.calls.map((call) => call.method)).toEqual(["authorize", "createSession"]);
  });
  it("uses trusted UI target and reports missing navigation without affecting reads", async () => {
    const { control, ctx, ports } = appFixture();
    await control.openSession({ ...ctx, uiTarget: "window-1" }, { session: appTarget });
    expect(ports.calls.at(-1)?.input).toMatchObject({ uiTarget: "window-1" });
    const noUi = createAppSessionControl({ ...ports.app, navigation: undefined });
    await expect(noUi.openSession(ctx, { session: appTarget })).resolves.toEqual({
      status: "unavailable",
      reason: "navigation_unavailable",
    });
    await expect(
      noUi.readSession(ctx, { session: appTarget, view: "summary" }),
    ).resolves.toMatchObject({ view: "summary" });
  });
  it("lists only authorized project grants and rejects source leakage", async () => {
    const { control, ctx, ports } = appFixture();
    await control.listProjects(ctx, {});
    expect(ports.calls.map((call) => call.method)).toEqual(["authorize", "listProjects"]);
    ports.app.projects.listProjects = async () => ({
      projects: [
        {
          project: { kind: "app", projectId: "project-1", sourceServerId: "source-b" },
          title: "private",
        },
      ],
      searchScope: { scopes: [ctx.allowedScopes[0]!], unavailableSources: [] },
    });
    await expect(control.listProjects(ctx, {})).rejects.toMatchObject({ code: "invalid_output" });
  });
  it("does not enter an owner after cancellation during access", async () => {
    const { control, ctx, ports } = appFixture();
    const controller = new AbortController();
    ports.app.access.authorize = async (_ctx, request) => {
      controller.abort();
      return { scope: request.scope, fence: "epoch" };
    };
    await expect(
      control.sendToSession(
        { ...ctx, signal: controller.signal },
        { session: appTarget, prompt: "go", requestId: "r" },
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(ports.calls).toEqual([]);
  });
});
