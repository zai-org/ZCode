// ============================================================
// Todo Tool Handlers
// ============================================================

import {
  CoreErrorType,
  TodoReadInputJsonSchema,
  TodoReadInputSchema,
  TodoReadOutputJsonSchema,
  TodoReadOutputSchema,
  TodoWriteInputJsonSchema,
  TodoWriteInputSchema,
  TodoWriteOutputJsonSchema,
  TodoWriteOutputSchema,
  createCoreError,
  type TodoItem,
  type TodoReadOutput,
  type TodoWriteInput,
  type TodoWriteOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TODO_MODEL_BYTES = 100_000;

export const todoReadHandler: ToolHandler = async (input, context) => {
  TodoReadInputSchema.parse(input);

  if (!context.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort is not configured for TodoRead",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "TodoRead",
        },
        recoverable: false,
      },
    );
  }

  return {
    todos: await context.sessionStore.readTodos({ sessionID: context.sessionId }),
  } satisfies TodoReadOutput;
};

export const todoWriteHandler: ToolHandler = async (input, context) => {
  const { todos } = TodoWriteInputSchema.parse(input) as TodoWriteInput;

  if (!context.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort is not configured for TodoWrite",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "TodoWrite",
        },
        recoverable: false,
      },
    );
  }

  const oldTodos = await context.sessionStore.readTodos({ sessionID: context.sessionId });
  await context.sessionStore.updateTodos({ sessionID: context.sessionId, todos });

  return {
    oldTodos,
    todos,
    summary: summarizeTodos(todos),
  } satisfies TodoWriteOutput;
};

export const todoReadToolEntry: ToolEntry = {
  capability: "Read the current session todo list without modifying external state",
  metadata: {
    shouldDefer: true,
    name: "TodoRead",
    description: "Read the current session todo list",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_TODO_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: todoReadHandler,
  inputSchema: TodoReadInputJsonSchema,
  outputSchema: TodoReadOutputJsonSchema,
  runtimeInputSchema: TodoReadInputSchema,
  runtimeOutputSchema: TodoReadOutputSchema,
  permission: {
    permission: "todo.read",
    reason: "TodoRead only reads session-local task state",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TODO_MODEL_BYTES,
    maxModelBytes: MAX_TODO_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TODO_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TodoRead was cancelled before todo state was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const todoWriteToolEntry: ToolEntry = {
  capability:
    "Replace the current session todo list to track multi-step task progress and resume state",
  metadata: {
    name: "TodoWrite",
    searchHint: "manage the session task checklist",
    description: `Create and update a task list for the current session. The list is rendered to the user as your working plan.

- Each todo has \`content\`, \`status\` ("pending" | "in_progress" | "completed"), and \`priority\` ("high" | "medium" | "low").
- Send the full list each call; it replaces the previous one.
- Keep one item \`in_progress\` at a time and mark it \`completed\` when done.`,
    readOnly: true,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: MAX_TODO_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: todoWriteHandler,
  inputSchema: TodoWriteInputJsonSchema,
  outputSchema: TodoWriteOutputJsonSchema,
  runtimeInputSchema: TodoWriteInputSchema,
  runtimeOutputSchema: TodoWriteOutputSchema,
  permission: {
    permission: "todo.write",
    reason: "TodoWrite only updates session-local task state for progress tracking",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TODO_MODEL_BYTES,
    maxModelBytes: MAX_TODO_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TODO_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TodoWrite was cancelled before todo state was updated",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function summarizeTodos(todos: TodoItem[]) {
  return {
    total: todos.length,
    pending: todos.filter((todo) => todo.status === "pending").length,
    inProgress: todos.filter((todo) => todo.status === "in_progress").length,
    completed: todos.filter((todo) => todo.status === "completed").length,
  };
}
