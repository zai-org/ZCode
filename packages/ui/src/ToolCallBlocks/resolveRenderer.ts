import { SessionToolCallBlock, isSessionToolName } from "@/ToolCallBlocks/session/contract.js";
// ============================================================
// 工具卡 renderer 注册表：tool identity → 具体 renderer 组件
// ============================================================
// 从 ToolCallBlocks.tsx 拆出：这张表随工具种类线性增长，和 renderContext 装配叠在一处后
// ToolCallBlocks.tsx 越过 oxlint max-lines(400)（rows.ts → toolDisplay.ts 是同一先例）。
// 本文件只做纯分流，不含 JSX、不碰 context 装配，ToolCallBlocks.tsx 单向依赖它。

import { EditToolCallBlock } from "@/ToolCallBlocks/renderers/edit.js";
import { AgentToolCallBlock } from "@/ToolCallBlocks/renderers/agent.js";
import { CreateWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/create-workflow.js";
import { EscalateToolCallBlock } from "@/ToolCallBlocks/renderers/escalate.js";
import { EvalWorkflowSnippetToolCallBlock } from "@/ToolCallBlocks/renderers/eval-workflow-snippet.js";
import { ExecuteToolCallBlock } from "@/ToolCallBlocks/renderers/execute.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { GetWorkflowRunToolCallBlock } from "@/ToolCallBlocks/renderers/get-workflow-run.js";
import { ListModelsToolCallBlock } from "@/ToolCallBlocks/renderers/list-models.js";
import { ListSavedWorkflowsToolCallBlock } from "@/ToolCallBlocks/renderers/list-saved-workflows.js";
import { ListWorkflowRunsToolCallBlock } from "@/ToolCallBlocks/renderers/list-workflow-runs.js";
import { ResumeWorkflowRunToolCallBlock } from "@/ToolCallBlocks/renderers/resume-workflow-run.js";
import { ResolveWorkflowQuestionToolCallBlock } from "@/ToolCallBlocks/renderers/resolve-workflow-question.js";
import { SaveWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/save-workflow.js";
import {
  isEscalateToolCall,
  isEvalWorkflowSnippetToolCall,
  isGetWorkflowRunToolCall,
  isListModelsToolCall,
  isListSavedWorkflowsToolCall,
  isListWorkflowRunsToolCall,
  isResolveWorkflowQuestionToolCall,
  isResumeWorkflowRunToolCall,
  isSaveWorkflowToolCall,
} from "@/lib/workflowToolNames.js";
import { CuaToolCallBlock, isCuaToolCall } from "@/ToolCallBlocks/renderers/cua.js";
import { GoalToolCallBlock } from "@/ToolCallBlocks/renderers/goal.js";
import { NodeReplToolCallBlock } from "@/ToolCallBlocks/renderers/node-repl.js";
import { McpToolCallBlock, readMcpToolPresentation } from "@/ToolCallBlocks/renderers/mcp.js";
import { PlanGuidanceToolCallBlock } from "@/ToolCallBlocks/renderers/plan-guidance.js";
import { ReadToolCallBlock } from "@/ToolCallBlocks/renderers/read.js";
import { ReadSessionContextToolCallBlock } from "@/ToolCallBlocks/renderers/read-session-context.js";
import { RespondToCoordinatorToolCallBlock } from "@/ToolCallBlocks/renderers/respond-to-coordinator.js";
import { WebFetchToolCallBlock } from "@/ToolCallBlocks/renderers/web-fetch.js";
import { SearchToolCallBlock, ToolSearchToolCallBlock } from "@/ToolCallBlocks/renderers/search.js";
import { SendMessageToolCallBlock } from "@/ToolCallBlocks/renderers/send-message.js";
import { SkillToolCallBlock } from "@/ToolCallBlocks/renderers/skill.js";
import { SubmitResultToolCallBlock } from "@/ToolCallBlocks/renderers/submit-result.js";
import { SwitchModeToolCallBlock } from "@/ToolCallBlocks/renderers/switch-mode.js";
import { TaskOutputToolCallBlock } from "@/ToolCallBlocks/renderers/task-output.js";
import { TaskStopToolCallBlock } from "@/ToolCallBlocks/renderers/task-stop.js";
import { TodoToolCallBlock } from "@/ToolCallBlocks/renderers/todo.js";
import { AskQuestionToolCallBlock } from "@/ToolCallBlocks/renderers/ask-question.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

export function resolveToolCallRenderer(context: ToolCallBlockRenderContext) {
  if (isCuaToolCall(context.toolCallNode.toolCall)) {
    return CuaToolCallBlock;
  }

  const identity = resolveToolCallIdentity(context.toolCallNode.toolCall);

  // 工具目录查询只复用搜索卡片；不改 search family，避免被聚合为 Explore 内容搜索。
  const toolCall = context.toolCallNode.toolCall;
  const toolName = toolCall.toolName ?? toolCall.kind;
  if (isSessionToolName(toolName)) return SessionToolCallBlock;
  // 参数生成和中途停止尚未经过执行归一化，必须让 Local 名称也复用同一卡片与文案。
  if (toolName === "ToolSearch" || toolName === "LocalToolSearch") {
    return ToolSearchToolCallBlock;
  }

  // 可复用工作流的两个工具按**工具名**先分流，刻意排在 family 之前。两个理由：
  // 它们今天不在 shared 的已知工具表里（identity 回 unknown，会掉进 raw JSON 兜底卡）；
  // 而一旦将来被登记进 `workflow` family，下面那条分支的兜底会把它们渲染成 CreateWorkflow 卡。
  // 按名字先判定让两种世界都成立。
  if (isSaveWorkflowToolCall(context.toolCallNode.toolCall)) {
    return SaveWorkflowToolCallBlock;
  }
  if (isListSavedWorkflowsToolCall(context.toolCallNode.toolCall)) {
    return ListSavedWorkflowsToolCallBlock;
  }

  // 观察类工作流三工具同款按名分流、同样排在 family 之前：它们不在已知工具表里（identity
  // 回 unknown → raw JSON 兜底卡），而 workflow family 的兜底是 CreateWorkflow 卡——
  // 按名先判定让「登记前/登记后」两种世界都成立（workflowToolNames 的同款理由）。
  if (isGetWorkflowRunToolCall(context.toolCallNode.toolCall)) {
    return GetWorkflowRunToolCallBlock;
  }
  if (isListWorkflowRunsToolCall(context.toolCallNode.toolCall)) {
    return ListWorkflowRunsToolCallBlock;
  }
  if (isEvalWorkflowSnippetToolCall(context.toolCallNode.toolCall)) {
    return EvalWorkflowSnippetToolCallBlock;
  }
  // ResumeWorkflowRun 恢复入口同款按名分流（理由同上：不在已知工具表里，且 workflow family
  // 兜底是 CreateWorkflow 卡——恢复卡必须抢在 family 之前认领自己的名字）。
  if (isResumeWorkflowRunToolCall(context.toolCallNode.toolCall)) {
    return ResumeWorkflowRunToolCallBlock;
  }
  // 模型目录同款按名分流：不按名认领，
  // 兜底卡会把模型面那段以 providerId 开头的 `<models>` 文本原样摊进聊天区。
  if (isListModelsToolCall(context.toolCallNode.toolCall)) {
    return ListModelsToolCallBlock;
  }

  // 升级问答两工具同款按名分流、同样排在 family 之前：它们不在已知工具表里（identity 回
  // unknown → raw JSON 兜底卡），而 workflow family 的兜底是 CreateWorkflow 卡——按名先判定让
  // 「登记前/登记后」两种世界都成立。`escalate`（子代理提问）与 `ResolveWorkflowQuestion`
  // （主代理作答）卡面完全不同，各认自己的名字。
  if (isEscalateToolCall(context.toolCallNode.toolCall)) {
    return EscalateToolCallBlock;
  }
  if (isResolveWorkflowQuestionToolCall(context.toolCallNode.toolCall)) {
    return ResolveWorkflowQuestionToolCallBlock;
  }

  // 宿主 Node REPL 也通过 MCP 注册，因此同样带有 mcp_tool presentation。
  // 通用 MCP 分流若先执行，会吞掉代码、错误栈和 artifact 等专用交互。
  // 先按可信 tool identity 保留 Node REPL renderer，再让其余 MCP 使用通用展示。
  if (identity.family === "node-repl") {
    return NodeReplToolCallBlock;
  }
  if (readMcpToolPresentation(context)) {
    return McpToolCallBlock;
  }

  // 当前工具名已经是固定集合。继续用正则扫 kind/title 的话，
  // 会把 TodoWrite 里的 Write 当成文件写入。这里先解析固定 tool identity，再按 family 分流；
  // ZCode 历史投影的工具形态由 identity resolver 统一处理。
  switch (identity.family) {
    case "plan-guidance":
      return PlanGuidanceToolCallBlock;
    case "agent":
      return AgentToolCallBlock;
    case "todo":
      return TodoToolCallBlock;
    case "ask-user-question":
      return AskQuestionToolCallBlock;
    case "message":
      return identity.toolName === "RespondToCoordinator"
        ? RespondToCoordinatorToolCallBlock
        : SendMessageToolCallBlock;
    case "task-control":
      return identity.toolName === "TaskOutput" ? TaskOutputToolCallBlock : TaskStopToolCallBlock;
    case "skill":
      return SkillToolCallBlock;
    case "workflow":
      // family 内按工具名分派（`message` family 对 RespondToCoordinator 的同款先例）：
      // 工作流的两个工具卡面完全不同——一个是脚本/图，一个是 actor 提交的结果。
      return identity.toolName === "submit_result"
        ? SubmitResultToolCallBlock
        : CreateWorkflowToolCallBlock;
    case "session-context":
      return ReadSessionContextToolCallBlock;
    case "file-read":
      return ReadToolCallBlock;
    case "file-write":
      return EditToolCallBlock;
    case "switch-mode":
      return SwitchModeToolCallBlock;
    case "web-fetch":
      return WebFetchToolCallBlock;
    case "search":
      return SearchToolCallBlock;
    case "shell":
      return ExecuteToolCallBlock;
    case "goal":
      return GoalToolCallBlock;
    default:
      return FallbackToolCallBlock;
  }
}
