import { TOTAL_TOKENS_BUDGET } from "../../context/total-tokens.js";

/**
 * 每个 runtime 一份的预算计数（主会话、每个子 agent 各一份）。只在内存，resume 时重新开始。
 * 上下文 = 最近一条带 usage 的 assistant 的 input + output。
 */
export interface TotalTokensBudgetState {
  /** 本 runtime 内 auto / reactive compaction 前的上下文累加。 */
  rolledOver: number;
  /** 最近一次重新起算时的 rolledOver + 上下文。 */
  anchor: number;
  /** 已用量只增不减；重新起算时归零。 */
  maxUsed: number;
}

/** 输入附件的收集原因，在请求收集的位置记录，不从历史尾部反推。 */
export type InputAttachmentCollectionReason = "turn_input" | "tool_batch" | "text_guide";

export function createTotalTokensBudgetState(): TotalTokensBudgetState {
  return { rolledOver: 0, anchor: 0, maxUsed: 0 };
}

export function reanchorTotalTokensBudget(
  state: TotalTokensBudgetState,
  context: number,
): TotalTokensBudgetState {
  return { ...state, anchor: state.rolledOver + context, maxUsed: 0 };
}

export function rollOverTotalTokensBudget(
  state: TotalTokensBudgetState,
  context: number,
): TotalTokensBudgetState {
  return { ...state, rolledOver: state.rolledOver + context };
}

export function consumeTotalTokensBudget(
  state: TotalTokensBudgetState,
  context: number,
): { remaining: number; state: TotalTokensBudgetState } {
  const used = Math.max(state.maxUsed, state.rolledOver + context - state.anchor);
  return {
    remaining: Math.max(0, TOTAL_TOKENS_BUDGET - used),
    state: { ...state, maxUsed: used },
  };
}

/**
 * 只有主会话里出自用户本人的输入重新起算：轮首是真实用户 prompt，或纯文本回复后取出的 guide
 * 里有用户亲手 steer 的。信箱、工具跟进这类 guide 照常提醒，但不把倒数拨回满额。
 * 工具批次之后总是提醒；goal 续跑、子 agent 任务等非真实输入的轮首不提醒。
 */
export function decideTotalTokensReminder(input: {
  reason: InputAttachmentCollectionReason;
  mainSession: boolean;
  /** 触发本次收集的输入出自用户本人；`tool_batch` 不看它。 */
  fromUser: boolean;
}): { emit: boolean; reanchor: boolean } {
  const userInMainSession = input.mainSession && input.fromUser;
  switch (input.reason) {
    case "turn_input":
      return { emit: userInMainSession, reanchor: userInMainSession };
    case "tool_batch":
      return { emit: true, reanchor: false };
    case "text_guide":
      return { emit: true, reanchor: userInMainSession };
  }
}
