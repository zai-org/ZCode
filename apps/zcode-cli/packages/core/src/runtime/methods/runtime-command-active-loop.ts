import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import type { MessageId } from "../deps.js";
import type { RuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  persistBackgroundTaskNotificationCommand,
  shouldSuppressTaskNotificationRuntimeCommand,
} from "./background-notifications.js";
import { persistSubagentMessageCommand } from "./subagent-messages.js";
import { isStaleBranchRuntimeCommand } from "./runtime-command-generation.js";
import { createRuntimeUserEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";

export interface ActiveLoopRuntimeCommandDrainResult {
  backgroundSubagentResultConsumed: boolean;
  workflowResultConsumed: boolean;
  consumedCommandIds: RuntimeCommandId[];
  drained: number;
  messageIds: MessageId[];
  runtimeEntries: readonly RuntimeMessageEntry[];
}

export async function drainPendingRuntimeCommandsForActiveLoop(
  this: AgentRuntimeInternal,
): Promise<ActiveLoopRuntimeCommandDrainResult> {
  const commands = this.runtimeCommandQueue.getByMaxPriority("next");
  const consumedCommandIds: RuntimeCommandId[] = [];
  let backgroundSubagentResultConsumed = false;
  let workflowResultConsumed = false;
  const messageIds: MessageId[] = [];
  const runtimeEntries: RuntimeMessageEntry[] = [];

  for (const command of commands) {
    // 排队的 controlOnly 轮（GUI「配置」的设置轮）不进活动 turn，而且它之后入队的通知也不能被
    // 这里先吸收：那些通知说的是它刚记下的新 run，模型必须先读到「设置已调整、新 run 是谁」，
    // 再读到新 run 的进展。在它这里停下，
    // 后面的留给外层队列按序跑。
    if (command.mode === "control-only-turn") break;
    if (command.mode !== "task-notification" && command.mode !== "subagent-message") {
      continue;
    }
    const removed = this.runtimeCommandQueue.removeById(command.id);
    if (!removed) continue;
    if (isStaleBranchRuntimeCommand(this, removed)) continue;

    let messageId: MessageId;
    if (removed.mode === "task-notification") {
      if (shouldSuppressTaskNotificationRuntimeCommand.call(this, removed)) {
        continue;
      }
      messageId = await persistBackgroundTaskNotificationCommand.call(this, removed);
    } else if (removed.mode === "subagent-message") {
      messageId = await persistSubagentMessageCommand.call(this, removed, true);
    } else {
      continue;
    }

    consumedCommandIds.push(removed.id);
    // active-loop 不会创建新的 TurnStarted；这里把已消费事实带到当前 turn 的终态，且只认结构化 subagent 来源，避免 Bash 混入。
    if (
      removed.mode === "task-notification" &&
      removed.originMeta?.backgroundSource === "subagent" &&
      removed.originMeta.subagentStall === undefined
    ) {
      backgroundSubagentResultConsumed = true;
    }
    if (
      removed.mode === "task-notification" &&
      removed.originMeta?.backgroundSource === "workflow"
    ) {
      workflowResultConsumed = true;
    }
    messageIds.push(messageId);
    runtimeEntries.push(
      createRuntimeUserEntry(
        removed.text,
        runtimeInputMetadata(
          removed.mode === "task-notification" ? "task_notification_steer" : "subagent_reply_steer",
        ),
      ),
    );
  }

  return {
    backgroundSubagentResultConsumed,
    workflowResultConsumed,
    consumedCommandIds,
    drained: consumedCommandIds.length,
    messageIds,
    runtimeEntries,
  };
}
