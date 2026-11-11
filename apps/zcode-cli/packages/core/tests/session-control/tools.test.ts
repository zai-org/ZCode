import { describe, expect, it, vi } from "vitest";
import { createToolRegistry, registerBuiltInTools } from "../../src/tool/index.js";
import { isDynamicWorkflowToolName } from "../../src/tool/handlers/index.js";
import {
  sessionControlTools,
  sessionControlToolsByKind,
} from "../../src/tool/session-control/index.js";
import { sessionControlForRuntime } from "../../src/tool/session-control/contract.js";
import { buildToolExposure, buildToolSearchAnnouncement } from "../../src/tool/search/exposure.js";
import { createTestRuntimeModel } from "../test-runtime-model.js";
import type { ToolExecutionContext } from "../../src/tool/types.js";
import type { AppSessionControl, CliSessionControl } from "@zcode/session-control/contracts";

const rootSession = { kind: "cli" as const, workspacePath: "/workspace", sessionId: "caller" };
const target = { ...rootSession, sessionId: "sess_target" };
function context(control: Partial<CliSessionControl>): ToolExecutionContext {
  return {
    toolCallId: "tool-1",
    traceId: "trace-1" as never,
    sessionId: "caller" as never,
    runtimeScope: "main",
    abortSignal: new AbortController().signal,
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    sessionControl: {
      kind: "cli",
      control: control as CliSessionControl,
      context: () => ({ callerId: "trusted-caller", rootSession, allowedScopes: [rootSession] }),
    },
  };
}
const entry = (name: string, kind: "cli" | "app" = "cli") =>
  sessionControlToolsByKind[kind].find((tool) => tool.metadata.name === name)!;
const SHARED = [
  "ListSessions",
  "ReadSession",
  "CreateSession",
  "ForkSession",
  "SendToSession",
  "WaitSessions",
  "InterruptSession",
  "RenameSession",
];
const APP_ONLY = ["ListProjects", "OpenSession", "SetSessionArchived", "SetSessionPinned"];
/** 受动态工作流灰度门管的工具里，ListModels 之外的那十个。 */
const DYNAMIC_WORKFLOW_ONLY = [
  "CreateWorkflow",
  "AmendWorkflow",
  "SaveWorkflow",
  "ListSavedWorkflows",
  "EvalWorkflowSnippet",
  "ListWorkflowRuns",
  "GetWorkflowRun",
  "ResumeWorkflowRun",
  "ResolveWorkflowQuestion",
  "FillWorkflowHole",
];

describe("session control production tools", () => {
  it.each(["cli", "app"] as const)("advertises the %s surface under shared names", (kind) => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { sessionControlKind: kind });
    const model = createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop" }),
    });
    const input = {
      registry,
      model,
      tools: registry.toContracts(),
      entries: [],
      mode: "local" as const,
    };
    const exposure = buildToolExposure(input);
    const names = new Set([...SHARED, ...APP_ONLY]);
    const controls = exposure.context.catalog.filter((tool) => names.has(tool.name));
    expect(controls.map((tool) => tool.name).sort()).toEqual(
      [...SHARED, ...(kind === "cli" ? [] : APP_ONLY)].sort(),
    );
    expect(controls.every((tool) => tool.deferred && tool.searchHint)).toBe(true);
    expect(exposure.tools.some((tool) => names.has(tool.name))).toBe(false);
    const announcement = buildToolSearchAnnouncement(input);
    expect(announcement?.metadata?.toolSearchAnnouncement?.addedNames).toEqual(
      expect.arrayContaining(controls.map((tool) => tool.name)),
    );
  });
  it("registers the variant chosen by the trusted launch binding, with no fallback", () => {
    for (const mode of [undefined, "cli", "app"] as const) {
      const registry = createToolRegistry();
      registerBuiltInTools(registry, { sessionControlKind: mode });
      expect(sessionControlTools.filter((tool) => registry.has(tool.metadata.name))).toHaveLength(
        mode === "cli" ? 8 : mode === "app" ? 12 : 0,
      );
      expect(registry.has("OpenSession")).toBe(mode === "app");
      if (mode) expect(registry.get("CreateSession")).toBe(entry("CreateSession", mode));
    }
    // App 是独立 CLI 的父集：共有工具同名，App 版只多出自己的参数。
    expect(sessionControlToolsByKind.cli.map((tool) => tool.metadata.name)).toEqual(SHARED);
    expect(sessionControlToolsByKind.app.map((tool) => tool.metadata.name)).toEqual([
      ...SHARED,
      ...APP_ONLY,
    ]);
    // 规格 0.14：CLI 的 cwd 已删除（唯一合法值是绑定 workspace，工具自己已知）；
    // App 的 project 保留，因为 ListProjects 是它现成的发现链。
    expect(entry("CreateSession", "cli").inputSchema.required).toEqual(["prompt"]);
    expect(entry("CreateSession", "app").inputSchema.required).toContain("project");
  });
  /**
   * 规格 0.15：ListModels 有消费者才注册，且不计入冷恢复判据。
   *
   * 它的两个消费者是 CreateWorkflow（灰度开启）与 CreateSession（会话控制在场）。0.14 无条件注册，
   * 于是「灰度关 + 无会话控制」的会话（例如子代理）也有它，描述却叫模型去填两个不存在的工具。
   */
  it("registers ListModels only where one of its consumers exists", () => {
    for (const [options, registered] of [
      [{ sessionControlKind: "cli" as const, includeDynamicWorkflow: false }, true],
      [{ sessionControlKind: "app" as const, includeDynamicWorkflow: false }, true],
      [{ includeDynamicWorkflow: true }, true],
      [{}, true],
      [{ includeDynamicWorkflow: false }, false],
    ] as const) {
      const registry = createToolRegistry();
      registerBuiltInTools(registry, options);
      expect({ options, registered: registry.has("ListModels") }).toEqual({ options, registered });
    }
    // 会话控制在场时灰度关闭也照常注册，另外十个工作流工具仍随灰度下架。
    const sessionOnly = createToolRegistry();
    registerBuiltInTools(sessionOnly, { sessionControlKind: "cli", includeDynamicWorkflow: false });
    expect(DYNAMIC_WORKFLOW_ONLY.filter((name) => sessionOnly.has(name))).toEqual([]);
    // 冷恢复判据：只为挑模型调过一次 ListModels，不说明会话用过工作流。
    expect(isDynamicWorkflowToolName("ListModels")).toBe(false);
  });
  /**
   * 规格 0.14：模型可见文案不得指向已从工具面删除的参数。
   *
   * 这一条是审出来的真实缺陷：`requestId` 退出工具面后，公共指令仍写着 "Reuse requestId"，
   * 而 strictObject 会拒绝它——模型照字面做就卡死，改为省略身份则拿到新的 toolCallId，
   * 于是重复建会话或重复发消息。描述与 schema 必须同源校验，不能靠人读。
   */
  it("never names a parameter the tool surface does not accept", () => {
    // 这几个参数是**直接删除**的（规格 0.14），没有替代写法，所以模型可见文案里出现任何一次
    // 都是错的。`requestId` 不在此列：它仍是回执字段，重试指令要指着它说「从结果里取」，
    // 那层语义正则判不了，由下面一条单独断言。
    const deleted = ["cwd", "uiTarget", "host"];
    for (const kind of ["cli", "app"] as const)
      for (const tool of sessionControlToolsByKind[kind]) {
        const text = [
          tool.metadata.description,
          tool.metadata.searchHint,
          ...(tool.metadata.modelInstructions ?? []),
        ].join(" ");
        expect({
          tool: `${kind}:${tool.metadata.name}`,
          named: deleted.filter((name) => new RegExp(`\\b${name}\\b`).test(text)),
        }).toEqual({ tool: `${kind}:${tool.metadata.name}`, named: [] });
      }
  });

  /**
   * 规格 0.14：`requestId` 退出工具面后，公共指令仍写着 "Reuse requestId"——strictObject 会拒绝它，
   * 模型照字面做就卡死；改为省略身份重新调用则拿到新的 toolCallId，于是重复建会话或重复发消息。
   * 所以提到 requestId 的唯一合法语境是「从回执取值，作为 retryOf 传回」，且必须写明没有
   * requestId 输入字段；而这条指令只能出现在真正收 retryOf 的写工具上。
   */
  it("only mentions requestId as a value to replay through retryOf", () => {
    for (const kind of ["cli", "app"] as const)
      for (const tool of sessionControlToolsByKind[kind]) {
        const properties = tool.inputSchema.properties ?? {};
        expect(properties, `${kind}:${tool.metadata.name}`).not.toHaveProperty("requestId");
        const text = [
          tool.metadata.description,
          tool.metadata.searchHint,
          ...(tool.metadata.modelInstructions ?? []),
        ].join(" ");
        const retryable = "retryOf" in properties;
        expect({ tool: tool.metadata.name, mentions: /\brequestId\b/.test(text) }).toEqual({
          tool: tool.metadata.name,
          mentions: retryable,
        });
        if (!retryable) continue;
        expect(tool.inputSchema.required ?? [], tool.metadata.name).not.toContain("retryOf");
        expect(
          text,
          `${kind}:${tool.metadata.name} 没说清 requestId 要作为 retryOf 回放`,
        ).toContain("`retryOf`");
        expect(text, `${kind}:${tool.metadata.name} 没说明没有 requestId 输入字段`).toContain(
          "no requestId input",
        );
      }
  });

  /**
   * 规格 0.15：回执送不回来时，重试身份要随超时/取消的错误一起送到模型手里。
   * 说明里的身份必须与 handler 实际注入的完全一致，否则模型照做也对不上原请求。
   */
  it("describes the injected request identity on every write tool, and only there", () => {
    for (const kind of ["cli", "app"] as const)
      for (const tool of sessionControlToolsByKind[kind]) {
        const retryable = "retryOf" in (tool.inputSchema.properties ?? {});
        expect({
          tool: `${kind}:${tool.metadata.name}`,
          declares: tool.describeUnsettledCall !== undefined,
        }).toEqual({ tool: `${kind}:${tool.metadata.name}`, declares: retryable });
        if (!retryable) continue;
        // 首次调用：身份是本次 toolCallId；重试：身份是模型回放的 retryOf。
        expect(tool.describeUnsettledCall!({}, "toolu_first")).toContain("requestId=toolu_first");
        expect(tool.describeUnsettledCall!({ retryOf: "toolu_first" }, "toolu_second")).toContain(
          "requestId=toolu_first",
        );
        expect(tool.describeUnsettledCall!({}, "toolu_first")).toContain("`retryOf`");
      }
  });

  // 规格 0.12：名字必须是无下划线的 PascalCase。snake_case 会命中 App 端
  // resolveLegacyKindFamily 的 `^read(?:_|$)` / `^list(?:_|$)` / `(?:^|_)create(?:_|$)` 前缀启发式，
  // 把 ReadSession 渲染成读文件卡、ListSessions 渲染成搜索卡、CreateSession 渲染成写文件卡。
  it("names every tool in PascalCase so no underscore prefix heuristic can claim it", () => {
    for (const tool of sessionControlTools)
      expect(tool.metadata.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });
  // 规格 0.11：工具层只暴露 sessionId。模型曾把 session 也当必填、用 "dummy" 补齐嵌套引用，
  // 整轮调用因此全部失败；完整引用退回端口与返回值，模型不再看见。
  it("exposes only sessionId on every target tool", () => {
    for (const kind of ["cli", "app"] as const)
      for (const tool of sessionControlToolsByKind[kind]) {
        const properties = Object.keys(tool.inputSchema.properties ?? {});
        if (!properties.includes("sessionId")) continue;
        expect(properties, `${kind}:${tool.metadata.name}`).not.toContain("session");
        expect(tool.inputSchema.required ?? [], tool.metadata.name).toContain("sessionId");
      }
    const wait = entry("WaitSessions", "app").inputSchema.properties?.operations as {
      items: { properties: Record<string, unknown>; required: string[] };
    };
    expect(Object.keys(wait.items.properties)).toEqual(["sessionId", "commandId"]);
    expect([...wait.items.required].sort()).toEqual(["commandId", "sessionId"]);
  });

  // 会话输入来源（docs/design/v2/conversation-input-source.md §3）：来源只由可信 Host 写入。
  // 模型能调用的会话控制工具一律不暴露 source，多带即被 strict 入参拒绝，facade 不会被调用。
  it("never lets the model set a conversation input source", async () => {
    const forged = { kind: "extension", pluginId: "forged@zcode-plugins-example" };
    for (const kind of ["cli", "app"] as const)
      for (const tool of sessionControlToolsByKind[kind]) {
        expect(
          tool.inputSchema.properties ?? {},
          `${kind}:${tool.metadata.name}`,
        ).not.toHaveProperty("source");
        expect(tool.inputSchema.additionalProperties, `${kind}:${tool.metadata.name}`).toBe(false);
      }
    const sendToSession = vi.fn();
    const createSession = vi.fn();
    const ctx = context({ sendToSession, createSession });
    await expect(
      entry("SendToSession").handler(
        { sessionId: target.sessionId, prompt: "hello", source: forged },
        ctx,
      ),
    ).rejects.toThrow();
    await expect(
      entry("CreateSession").handler({ prompt: "hello", source: forged }, ctx),
    ).rejects.toThrow();
    expect(sendToSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("hides control bindings from every child kind and from a different root", () => {
    const binding = context({}).sessionControl;
    for (const taskType of [
      "subagent_child",
      "workflow_child",
      "nested_workflow_child",
      "selection_side_chat",
    ] as const) {
      expect(sessionControlForRuntime(binding, taskType, "caller")).toBeUndefined();
    }
    expect(sessionControlForRuntime(binding, "interactive", "other")).toBeUndefined();
    expect(sessionControlForRuntime(binding, "interactive", "caller")).toBe(binding);
  });

  it("declares deferred discoverable bounded tools and conservative mutation permissions", () => {
    for (const tool of sessionControlTools) {
      expect(tool.metadata.shouldDefer).toBe(true);
      expect(tool.metadata.searchHint).toBeTruthy();
      expect(tool.resultBudget.maxModelBytes).toBeLessThanOrEqual(32_768);
      expect(tool.runtimeInputSchema).toBeDefined();
      expect(tool.runtimeOutputSchema).toBeDefined();
      expect(tool.metadata.sideEffectScope).toBe(tool.metadata.readOnly ? "none" : "system");
      expect(tool.permission.needsApproval).toBe(!tool.metadata.readOnly);
      expect(tool.permission.denyPriority).toBe("beforeAsk");
      expect(tool.cancellation.supported).toBe(true);
    }
  });

  it("binds identity and cancellation to execution context, preserving request identity", async () => {
    const readSession = vi.fn(async () => ({ view: "messages", session: target, messages: [] }));
    const ctx = context({ readSession });
    await entry("ReadSession").handler({ sessionId: "sess_target", view: "messages" }, ctx);
    expect(readSession).toHaveBeenCalledWith(
      expect.objectContaining({ callerId: "trusted-caller", rootSession, signal: ctx.abortSignal }),
      { sessionId: "sess_target", view: "messages" },
    );
  });

  it("rejects model supplied identities and any full reference before calling the port", async () => {
    const readSession = vi.fn();
    const tool = entry("ReadSession");
    await expect(
      tool.handler(
        { sessionId: "sess_target", view: "summary", callerId: "forged" },
        context({ readSession }),
      ),
    ).rejects.toThrow();
    // 完整引用已不在工具面上：无论本 surface 还是跨 surface 的引用都被 strictObject 拒绝。
    for (const session of [target, { ...target, kind: "app" }])
      await expect(
        tool.handler({ session, view: "summary" }, context({ readSession })),
      ).rejects.toThrow();
    expect(readSession).not.toHaveBeenCalled();
  });

  it("rejects a child and a mismatched root even if a binding was accidentally supplied", async () => {
    const readSession = vi.fn();
    const input = { sessionId: "sess_target", view: "summary" };
    await expect(
      entry("ReadSession").handler(input, {
        ...context({ readSession }),
        runtimeScope: "subagent",
      }),
    ).rejects.toThrow();
    await expect(
      entry("ReadSession").handler(input, {
        ...context({ readSession }),
        sessionId: "other" as never,
      }),
    ).rejects.toThrow();
    await expect(
      entry("ReadSession", "app").handler(
        { sessionId: "sess_target", view: "summary" },
        context({ readSession }),
      ),
    ).rejects.toThrow();
    expect(readSession).not.toHaveBeenCalled();
  });

  it("keeps App discovery schemas and descriptions separate from CLI lists", async () => {
    const searchScope = {
      scopes: [{ kind: "app" as const, scope: "host" as const, sourceServerId: "source" }],
      unavailableSources: [{ sourceServerId: "remote", reason: "disconnected" }],
    };
    const listSessions = vi.fn(async () => ({ sessions: [], searchScope }));
    const listProjects = vi.fn(async () => ({ projects: [], searchScope }));
    const trusted = {
      callerId: "trusted-caller",
      rootSession: { ...rootSession, kind: "app" as const },
      allowedScopes: [],
      discoveryScopes: searchScope.scopes,
    };
    const ctx: ToolExecutionContext = {
      ...context({}),
      sessionControl: {
        kind: "app",
        context: () => trusted,
        control: { listSessions, listProjects } as unknown as AppSessionControl,
      },
    };
    await expect(entry("ListSessions", "app").handler({ query: "小说" }, ctx)).resolves.toEqual({
      sessions: [],
      searchScope,
    });
    expect(listSessions).toHaveBeenCalledWith(expect.objectContaining(trusted), {
      query: "小说",
      archived: "exclude",
    });
    await expect(entry("ListProjects", "app").handler({}, ctx)).resolves.toEqual({
      projects: [],
      searchScope,
    });
    for (const name of ["ListSessions", "ListProjects"]) {
      expect(entry(name, "app").outputSchema.required).toContain("searchScope");
      expect(entry(name, "app").metadata.description).toContain("searchScope");
      expect(entry(name, "app").metadata.description).toContain("unavailableSources");
      expect(entry(name, "app").metadata.description).toContain("empty");
      expect(entry(name, "app").metadata.description).toContain(
        "Empty scopes means no range was successfully searched",
      );
    }
    expect(entry("ListSessions", "app").metadata.description).toContain("across projects");
    expect(entry("ListSessions", "app").metadata.description).toContain("title substring");
    expect(entry("ListSessions", "app").metadata.description).toContain("not full-text");
    expect(entry("ListSessions", "app").metadata.description).toContain(
      "Search unarchived sessions first",
    );
    expect(entry("ListSessions", "app").metadata.description).toContain('archived:"only"');
    await entry("ListSessions", "app").handler({ query: "小说", archived: "only" }, ctx);
    expect(listSessions).toHaveBeenLastCalledWith(expect.objectContaining(trusted), {
      query: "小说",
      archived: "only",
    });
    listSessions.mockResolvedValue({ sessions: [] } as never);
    listProjects.mockResolvedValue({ projects: [] } as never);
    await expect(entry("ListSessions", "app").handler({}, ctx)).rejects.toThrow();
    await expect(entry("ListProjects", "app").handler({}, ctx)).rejects.toThrow();
    expect(entry("ListSessions").outputSchema.required).not.toContain("searchScope");
    await expect(
      entry("ListSessions").handler({}, context({ listSessions: async () => ({ sessions: [] }) })),
    ).resolves.toEqual({ sessions: [] });
  });
  it("describes stable forks, input-bound waits and permission isolation", () => {
    expect(entry("ForkSession").metadata.description).toContain("stable");
    expect(entry("WaitSessions").metadata.description).toContain("does not stop");
    expect(entry("SendToSession", "app").metadata.modelInstructions?.join(" ")).toContain(
      "permissions",
    );
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { sessionControlKind: "app" });
    expect(
      registry.toContracts().find((tool) => tool.name === "CreateSession")?.description,
    ).toContain("permissions");
  });
});
