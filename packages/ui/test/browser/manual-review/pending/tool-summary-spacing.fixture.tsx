import { useState } from "react";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationShareReadonlyTimeline } from "@/v4/ConversationShareReadonlyTimeline.js";
import { WorkflowToolSummary } from "@/v4/WorkflowToolSummary.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import { ConsecutiveSummaryGroup } from "@/ToolCallBlocks/ToolSummaryRow.js";
import { SummaryGroupBoundaryContext } from "@/v4/conversationRowContext.js";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning.js";
import type { IServiceAccessor } from "@zcode/services";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useToolPresentationHostCapabilities } from "@/hooks/useToolPresentationHostCapabilities.js";
import { useSubagentsContextStore } from "@/store/subagentsContextStore.js";
import {
  useSubagentsStore,
  refreshLoadedSubagentsStoreForWorkspace,
} from "@/store/subagentsStore.js";
import { createRoot } from "react-dom/client";
import { ToolPresentation } from "@/ToolCallBlocks/ToolPresentation.js";
import { ToolPresentationCapabilitiesProvider } from "@/ToolCallBlocks/presentationCapabilities.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const tool = (
  id: string,
  kind: string,
  input: unknown,
  title: string,
): TaskChatToolCallTreeNode => ({
  toolCall: { toolId: id, toolName: kind, kind, input, title, status: "completed", output: "ok" },
  childToolCalls: [],
});
const rows = [
  tool(
    "node",
    "mcp__node_repl__js",
    { code: "1 + 1", title: "点击定位按钮并截图确认" },
    "点击定位按钮并截图确认",
  ),
  ...["in_progress", "failed", "stopped"].map((status) => ({
    ...tool(
      `node-${status}`,
      "mcp__node_repl__js",
      { code: "1 + 1", title: "检查设置页面" },
      "检查设置页面",
    ),
    toolCall: {
      ...tool(
        `node-${status}`,
        "mcp__node_repl__js",
        { code: "1 + 1", title: "检查设置页面" },
        "检查设置页面",
      ).toolCall,
      status,
    },
  })),
  tool("read", "Read", { file_path: "/workspace/example.ts" }, "Read file"),
  tool("write", "Write", { file_path: "/workspace/package.json", content: "{}" }, "Write file"),
  tool(
    "edit",
    "Edit",
    { file_path: "/workspace/src/App.tsx", old_string: "before", new_string: "after" },
    "Edit file",
  ),
  tool("execute", "Bash", { command: "echo done" }, "Run command"),
  tool("agent", "Agent", { subagent_type: "general-purpose", description: "检查布局" }, "检查布局"),
  ...["pending", "in_progress", "failed", "stopped"].map((status) => ({
    ...tool(
      `agent-${status}`,
      "Agent",
      { subagent_type: "general-purpose", description: "检查布局" },
      "检查布局",
    ),
    toolCall: {
      ...tool(
        `agent-${status}`,
        "Agent",
        { subagent_type: "general-purpose", description: "检查布局" },
        "检查布局",
      ).toolCall,
      status,
    },
  })),
  tool(
    "todo-spacing",
    "TodoWrite",
    {
      todos: [
        { content: "Summarize results", status: "completed", activeForm: "Summarizing results" },
      ],
    },
    "Summarize results",
  ),
  tool("cua-hover", "mcp__computer-use__click", { x: 10, y: 10 }, "检查页面"),
  tool("mcp", "mcp__example__lookup", { query: "example" }, "查询资料"),
];
let configuredFixtureColor = "pink";
const fixtureService = {
  list: async () => ({
    agents: [{ id: "general-purpose", name: "general-purpose", color: configuredFixtureColor }],
    capability: null,
  }),
};
const fixtureServices = { subagentsService: fixtureService } as unknown as IServiceAccessor;
if (params.has("hostColors")) {
  // 同路径的其他设备缓存和全局列表不能覆盖当前服务的配置。
  const foreignContext = {
    workspacePath: "/workspace",
    workspaceIdentity: "other-device",
    provider: ZCODE_AGENT_PROVIDER,
    agents: [{ id: "general-purpose", name: "general-purpose", color: "green" }],
    capability: null,
    loading: false,
    loaded: true,
    error: null,
  };
  useSubagentsContextStore.setState({
    contexts: {
      first: foreignContext,
      second: { ...foreignContext, workspaceIdentity: "another-device" },
    },
  });
  useSubagentsStore.setState({ agents: foreignContext.agents });
}
function HostColorSample() {
  const capabilities = useToolPresentationHostCapabilities("/workspace");
  return (
    <ToolPresentationCapabilitiesProvider value={capabilities}>
      <section data-example="host-color">
        <ToolPresentation
          toolCallNode={tool(
            "host-agent",
            "Agent",
            { subagent_type: "general-purpose", description: "当前工作区配置" },
            "当前工作区配置",
          )}
        />
        <button
          onClick={async () => {
            configuredFixtureColor = "blue";
            await refreshLoadedSubagentsStoreForWorkspace({
              scope: "user",
              subagentsService: fixtureService as unknown as IServiceAccessor["subagentsService"],
            });
          }}
        >
          刷新为蓝色配置
        </button>
      </section>
    </ToolPresentationCapabilitiesProvider>
  );
}
// 用真实分享 renderer 检查连续工具，数据为确定性的浏览器验收 fixture。
const shareRows: ConversationRow[] = [
  {
    rowId: 1,
    turnId: "mixed",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "backgroundResult",
    state: "completedSuccess",
    startedAt: 1,
    endedAt: 10,
  },
  ...(params.has("sessions")
    ? [
        "ListSessions",
        "ReadSession",
        "Reasoning",
        "SendToSession",
        "WaitSessions",
        "Bash",
        "OtherSession",
        "ListSessions",
        "ReadSession",
        "Agent",
        "ListSessions",
        "ReadSession",
      ]
    : params.has("changes")
      ? ["Write", "Edit", "Write", "Edit", "Write", "Write"]
      : [
          "Read",
          "Read",
          "Reasoning",
          "Bash",
          "Write",
          "Edit",
          "mcp__computer-use__list_apps",
          "mcp__computer-use__screenshot",
          "mcp__node_repl__js",
          "Agent",
          "CreateWorkflow",
          "Read",
          "Read",
        ]
  ).map((name, index): ConversationRow => {
    const base = {
      rowId: index + 2,
      turnId: "mixed",
      createdAt: index + 2,
      createdAtSeq: index + 2,
    };
    if (name === "Reasoning")
      return {
        ...base,
        kind: "reasoning",
        text: "检查文件后继续执行构建",
        state: "complete",
        durationMs: 3000,
      };
    return {
      ...base,
      kind: "toolCall",
      toolCallId: `mixed-${index}`,
      inputText: "{}",
      toolName: name,
      status: "success",
      ...(params.has("sessions")
        ? {
            output:
              name === "ListSessions"
                ? {
                    text: JSON.stringify({
                      sessions: [
                        { session: { sessionId: "sess_one" } },
                        { session: { sessionId: "sess_two" } },
                      ],
                    }),
                  }
                : name === "ReadSession"
                  ? {
                      text: JSON.stringify({
                        view: "messages",
                        messages: [{ role: "assistant", text: "Session detail preserved" }],
                      }),
                    }
                  : undefined,
          }
        : {}),
      input:
        params.has("sessions") && ["ReadSession", "SendToSession", "WaitSessions"].includes(name)
          ? name === "WaitSessions"
            ? { operations: [{ sessionId: "sess_one", commandId: "example" }] }
            : { sessionId: "sess_one" }
          : name === "Bash"
            ? { command: "echo example" }
            : name === "Agent"
              ? { subagent_type: "general-purpose", description: "检查布局" }
              : {
                  file_path: params.has("changes")
                    ? [
                        "/workspace/src/App.tsx",
                        "/workspace/src/App.tsx",
                        "/workspace/src/styles.css",
                        "/workspace/src/game.ts",
                        "/workspace/src/lib/a.ts",
                        "/workspace/src/lib/b.ts",
                      ][index]
                    : "/workspace/example.ts",
                  content: "example",
                },
    };
  }),
];
const bashDescription =
  params.get("description") === "empty"
    ? "   "
    : params.get("description") === "missing"
      ? undefined
      : "检查当前项目的构建结果";
function CrossGroupPreview() {
  const [size, setSize] = useState(3);
  const [boundary, setBoundary] = useState(false);
  const [finished, setFinished] = useState(false);
  const [toolFinished, setToolFinished] = useState(false);
  const [lateTool, setLateTool] = useState(false);
  const [unknownPath, setUnknownPath] = useState(false);
  const [failed, setFailed] = useState(false);
  const [earlierRunning, setEarlierRunning] = useState(false);
  const displayed = shareRows.slice(0, size).map((row, index): ConversationRow => {
    if (params.has("bash") && index === 2 && row.kind === "toolCall")
      row = {
        ...row,
        toolName: "Bash",
        input: { command: "echo bash-summary-output", description: bashDescription },
        output: { text: "bash-summary-output" },
      };
    if (params.get("first") === "cua" && index === 1 && row.kind === "toolCall")
      return { ...row, toolName: "mcp__computer-use__screenshot", input: {} };
    if (row.kind === "turnHeader")
      return {
        ...row,
        state: finished ? "completedSuccess" : "running",
        endedAt: finished ? 10 : undefined,
      };
    if (earlierRunning && index === 1 && row.kind === "toolCall")
      return { ...row, status: "running" };
    if (unknownPath && row.kind === "toolCall" && row.toolName === "Write")
      return { ...row, input: { content: "example" } };
    if (failed && index === size - 1 && row.kind === "toolCall")
      return { ...row, status: "error", error: { code: "fixture", message: "Example failure" } };
    if (lateTool && index === size - 1 && row.kind === "toolCall")
      return { ...row, status: "running" };
    if (index !== size - 1 || finished || toolFinished) return row;
    if (row.kind === "toolCall") return { ...row, status: "running" };
    if (row.kind === "reasoning") return { ...row, state: "streaming" };
    return row;
  });
  if (boundary)
    displayed.splice(3, 0, {
      rowId: 100,
      turnId: "mixed",
      createdAt: 3,
      createdAtSeq: 3,
      kind: "assistantText",
      text: "正文切断分组",
      state: "complete",
    });
  return (
    <main className="min-h-dvh bg-background text-foreground">
      {params.has("bash") && (
        <ZCodeIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
          <section data-bash-standalone>
            <ToolPresentation
              toolCallNode={tool(
                "bash-standalone",
                "Bash",
                { command: "echo bash-summary-output", description: bashDescription },
                "Bash",
              )}
            />
          </section>
        </ZCodeIntlProvider>
      )}
      <nav className="flex flex-wrap gap-4 p-4 text-ui-base">
        <button
          onClick={() => {
            setFinished(false);
            setFailed(false);
            setToolFinished(false);
            setLateTool(false);
            setSize((value) => Math.min(value + 1, shareRows.length));
          }}
        >
          Next summary
        </button>
        <button
          onClick={() => {
            setFinished(false);
            setFailed(false);
            setToolFinished(false);
            setLateTool(false);
            setSize(2);
          }}
        >
          Reset
        </button>
        <button onClick={() => setBoundary((value) => !value)}>Text boundary</button>
        <button
          onClick={() => {
            setLateTool(false);
            setFinished(true);
          }}
        >
          Finish
        </button>
        <button onClick={() => setToolFinished(true)}>Tool done</button>
        <button onClick={() => setEarlierRunning((value) => !value)}>Earlier running</button>
        <button
          onClick={() => {
            setFinished(true);
            setLateTool(true);
          }}
        >
          Late tool
        </button>
        <button onClick={() => setUnknownPath((value) => !value)}>Unknown path</button>
        <button
          onClick={() => {
            setFinished(true);
            setFailed(true);
          }}
        >
          Failed call
        </button>
      </nav>
      <ConversationShareReadonlyTimeline
        rows={displayed}
        theme={theme}
        locale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}
      />
    </main>
  );
}
function ScrollPreview() {
  const [count, setCount] = useState(20);
  const [extra, setExtra] = useState(false);
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>
        <main
          data-scroll-parent
          className="bg-background p-4 text-foreground text-ui-base"
          style={params.has("chain") ? { height: 600, overflowY: "auto" } : undefined}
        >
          <button onClick={() => setCount((value) => value + 1)}>Append</button>
          <button onClick={() => setExtra((value) => !value)}>Grow</button>
          <button onClick={() => setCount(12)}>Short</button>
          <SummaryGroupBoundaryContext.Provider value={{ taskRunning: true, tailRowId: count }}>
            <ConsecutiveSummaryGroup
              summary="Reading"
              statistics={`Read ${count} files`}
              contentKey={String(count)}
              refreshVersion={count}
              lastRowId={count}
              hasActiveItem={false}
            >
              {Array.from({ length: count }, (_, i) => (
                <div key={i} className="summary-hover-text" data-scroll-row>
                  {`Read file ${i}`}
                  {extra && i === count - 1 ? <div style={{ height: 100 }}>Details</div> : null}
                </div>
              ))}
            </ConsecutiveSummaryGroup>
          </SummaryGroupBoundaryContext.Provider>
          {params.has("chain") && <div style={{ height: 1000 }} />}
          <Reasoning defaultOpen>
            <ReasoningTrigger />
            <ReasoningContent>
              {Array.from({ length: count * 2 }, (_, i) => `Thought ${i}`).join("\n")}
            </ReasoningContent>
          </Reasoning>
        </main>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
if (params.has("scroll")) {
  createRoot(document.getElementById("root")!).render(<ScrollPreview />);
} else if (params.has("share")) {
  createRoot(document.getElementById("root")!).render(
    <TooltipProvider>
      <CrossGroupPreview />
    </TooltipProvider>,
  );
} else {
  createRoot(document.getElementById("root")!).render(
    <ZCodeIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
      <TooltipProvider>
        <ToolPresentationCapabilitiesProvider value={{ readonly: true }}>
          <main
            data-conversation-work-items
            className="@container/conversation min-h-screen flex flex-col gap-1 bg-background p-6 text-foreground"
          >
            <section data-example="workflow-summary-spacing">
              <WorkflowToolSummary
                toolCallId="workflow-summary-spacing"
                summary={{ runId: "workflow-example", agents: 2 } as WorkflowRunCardSummary}
                onOpen={() => undefined}
              />
            </section>
            <section data-example="reasoning-hover">
              <Reasoning duration={3}>
                <ReasoningTrigger />
              </Reasoning>
            </section>
            <section data-example="reasoning-running-hover">
              <Reasoning isStreaming>
                <ReasoningTrigger />
              </Reasoning>
            </section>
            {params.has("hostColors") ? (
              <ServiceProvider services={fixtureServices}>
                <TabStoreProvider>
                  <HostColorSample />
                </TabStoreProvider>
              </ServiceProvider>
            ) : null}
            <section data-example="body-spacing">正文段落间距保持原值。</section>
            {rows.map((node) => (
              <section key={node.toolCall.toolId} data-example={node.toolCall.toolId}>
                <ToolPresentation toolCallNode={node} showTodoToolCalls />
              </section>
            ))}
          </main>
        </ToolPresentationCapabilitiesProvider>
      </TooltipProvider>
    </ZCodeIntlProvider>,
  );
}
