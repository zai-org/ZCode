import { createRoot } from "react-dom/client";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationShareReadonlyTimeline } from "@/v4/ConversationShareReadonlyTimeline.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import "@/styles.css";

// 同一份公开投影形状的 Rows 分别交给 App 时间线和分享只读时间线，逐组件对照展示一致性。
const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "dark" ? "dark" : "light";
const locale = query.get("locale") === "en-US" ? "en-US" : "zh-CN";
const view = query.get("view") ?? "both";
document.documentElement.className = `${theme} theme-zai-${theme}`;

let rowId = 0;
let seq = 0;
const T0 = 1_700_000_000_000;
function base(turnId: string) {
  rowId += 1;
  seq += 1;
  return { rowId, turnId, productTurnId: turnId, createdAt: T0 + seq, createdAtSeq: seq };
}
function header(turnId: string, state: "completedSuccess" | "completedInterrupted", ms: number) {
  return {
    ...base(turnId),
    kind: "turnHeader" as const,
    origin: "userInput" as const,
    executionKind: "agent" as const,
    state,
    startedAt: T0,
    endedAt: T0 + ms,
    activeMs: ms,
  };
}
function user(turnId: string, text: string) {
  return { ...base(turnId), kind: "userInput" as const, origin: "realUser" as const, text };
}
function text(turnId: string, value: string) {
  return {
    ...base(turnId),
    kind: "assistantText" as const,
    text: value,
    state: "complete" as const,
  };
}
function reasoning(turnId: string, value: string) {
  return {
    ...base(turnId),
    kind: "reasoning" as const,
    text: value,
    state: "complete" as const,
    durationMs: 3200,
  };
}
function tool(turnId: string, toolName: string, input: Record<string, unknown>, output?: string) {
  const row = base(turnId);
  return {
    ...row,
    kind: "toolCall" as const,
    toolCallId: `call-${row.rowId}`,
    toolName,
    status: "success" as const,
    inputText: JSON.stringify(input),
    input,
    ...(output === undefined ? {} : { output: { text: output } }),
    startedAt: T0 + seq,
    endedAt: T0 + seq + 800,
  };
}

const rows: ConversationRow[] = [
  // 1. 有过程的普通轮：思考、探索/执行/变更分组、Todo、正文。
  header("t1", "completedSuccess", 72_000),
  user("t1", "请帮我检查项目结构，然后修复构建失败的问题。"),
  reasoning("t1", "先读取 package.json 和构建脚本，再定位报错。"),
  tool("t1", "Read", { file_path: "/workspace/package.json" }, '{ "name": "example" }'),
  tool("t1", "Grep", { pattern: "build", path: "/workspace/src" }, "src/build.ts:1: build"),
  tool("t1", "Bash", { command: "pnpm build" }, "error TS2322: Type 'string' is not assignable"),
  tool(
    "t1",
    "Edit",
    { file_path: "/workspace/src/build.ts", old_string: "const a = 1", new_string: "const a = 2" },
    "ok",
  ),
  tool("t1", "TodoWrite", { todos: [{ content: "修复构建", status: "completed" }] }, "ok"),
  tool("t1", "Bash", { command: "pnpm build" }, "Build succeeded"),
  text(
    "t1",
    "构建已修复。\n\n- 修改了 `src/build.ts` 的类型\n- 重新构建通过\n\n```ts\nconst a = 2;\n```",
  ),
  // 2. 只有正文、没有过程的轮。
  header("t2", "completedSuccess", 4_000),
  user("t2", "总结一下改动"),
  text("t2", "本次只改了一处类型声明，构建恢复正常。"),
  // 3. 独立压缩轮（timelineOnly）与轮首模型切换边界。
  header("tc", "completedSuccess", 2_000),
  {
    ...base("tc"),
    kind: "timelineMarker",
    marker: { type: "compact", origin: "manual", status: "success" },
  },
  header("t3", "completedSuccess", 9_000),
  {
    ...base("t3"),
    kind: "timelineMarker",
    lane: "lightBoundary",
    marker: {
      type: "modelChange",
      fromProvider: "zai",
      fromModel: "glm-4.6",
      toProvider: "zai",
      toModel: "glm-5",
      toThought: "high",
    },
  },
  user("t3", "再用子代理检查一下测试"),
  tool(
    "t3",
    "Agent",
    { subagent_type: "general-purpose", description: "检查测试" },
    "测试全部通过",
  ),
  tool("t3", "Read", { file_path: "/workspace/test/a.test.ts" }, "ok"),
  text("t3", "子代理确认测试全部通过。"),
  // 4. 被中断的轮。
  header("t4", "completedInterrupted", 6_000),
  user("t4", "顺便升级依赖"),
  tool("t4", "Bash", { command: "pnpm up" }, "Progress: resolved 10"),
  // 5. 过程只有被隐藏的 Todo：不能留下空的收纳容器。
  header("t5", "completedSuccess", 5_000),
  user("t5", "记一下待办"),
  tool("t5", "TodoWrite", { todos: [{ content: "发布", status: "pending" }] }, "ok"),
  text("t5", "已记录。"),
];

const desktopUnits = buildConversationTurnRenderUnits(rows);
const context = {
  workspacePath: "/workspace",
  theme,
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  // 分享按产品默认设置展示：显示思考，隐藏 Todo。
  messageStreamShowReasoning: true,
  messageStreamShowTodos: false,
} as const;

function DesktopColumn() {
  return (
    <ZCodeIntlProvider initialLocale={locale}>
      <div data-parity-column="desktop" className="@container/conversation flex flex-col">
        {desktopUnits.map((unit) => (
          <ConversationTurnGroup key={unit.key} unit={unit} context={context} />
        ))}
      </div>
    </ZCodeIntlProvider>
  );
}

function ShareColumn() {
  return (
    <div data-parity-column="share">
      <ConversationShareReadonlyTimeline rows={rows} theme={theme} locale={locale} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main
      className="min-h-dvh bg-background p-4 text-foreground"
      style={{
        display: "grid",
        gridAutoFlow: "column",
        gridAutoColumns: "minmax(0, 1fr)",
        gap: 24,
      }}
    >
      {view !== "share" ? <DesktopColumn /> : null}
      {view !== "desktop" ? <ShareColumn /> : null}
    </main>
  </TooltipProvider>,
);
