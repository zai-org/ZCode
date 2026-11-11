// ============================================================
// Workflow WebSearch Budget Port - 动态工作流子代理每个 ask 的 WebSearch 次数预算
// ============================================================
// 计数、上限与重置都归 driver（按 ask 归零，nudge / repair 轮共用）；WebSearch handler 只在发出内部
// 请求前问一句「这次还能不能搜」。端口缺席 = 没有预算（主会话、Agent 子代理）。
// 规格：packages/dynamic-workflow/docs/execution-engine.md「Search budget」。

/** 预算耗尽时 WebSearch 失败结果的错误码（流程判断用码，不用文案）。 */
export const WEB_SEARCH_BUDGET_EXHAUSTED_ERROR_CODE = 2;

/**
 * 一次扣减的结局。`charged`：已计入本 ask，照常搜索。`exhausted`：本 ask 的预算已用完，
 * 不发请求，`message` 原样成为模型看到的错误文本。
 */
export type WebSearchBudgetCharge =
  | { kind: "charged" }
  | {
      kind: "exhausted";
      /** 本 ask 的上限（persona 的 `budget.webSearch` 或默认值）。 */
      limit: number;
      /** 面向模型的文案：预算已用完、不要再调、用已有信息完成并在结果里说明。 */
      message: string;
    };

export interface WorkflowWebSearchBudgetPort {
  /**
   * 为一次 WebSearch 调用扣减一次。**同步**：同一批并行调用在单线程上逐个扣减，计数精确，
   * 不会出现两个调用都看到「还剩一次」。
   */
  charge(): WebSearchBudgetCharge;
}
