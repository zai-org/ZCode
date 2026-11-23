import { useEffect, useRef, useState } from "react";
import type { V4ConversationWorkflowRunSummary } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * dwf run 的发现查询。
 *
 * 它不再给卡片 join 兜底——
 * 重启后投影由 CLI 冷物化从 journal 回放补齐。剩下的消费者是 run 目录页与任务列表的
 * 「已结束的工作流 · N」计数：目录列最近 64 条，而投影只留 8 条。冷开首查仍可能先于订阅落地
 * 而失败，所以下面的重试语义原样保留。
 *
 * 这段逻辑原本内联在 `SessionPane`，一次性发出、失败即静默 `null`。
 * 而发现查询的 effect 声明在 lease/订阅 effect 之前，CLI 又严格串行派发请求，于是重启后
 * 打开历史会话时它必然先于订阅落地，宿主 record 还没在册 → `sessionNotFound` → 回退整块
 * 消失，卡片余生停在「编过但无 run」的编译态（点开只有脚本与静态图，没有详情页入口）。
 * CLI 侧已补上冷会话前置；这里补第二半：可重试的那一跳真的重试。
 */

/**
 * 能力缺席（旧 CLI 没有这个 query / dwf journal 不可用，run service 整个没构造）与普通失败
 * 必须分开：前者是稳定事实，重试只会每换一个 pane 就多打一次注定失败的 RPC；后者（冷会话、
 * 连接抖动）再问一次就好了。
 *
 * 与 `isWorkflowRunEventsCapabilityMissing` 同一读法：错误跨 JSON-RPC 之后只剩 message 可靠，
 * 所以两个模式都收——reasonCode 若被透传就命中它，否则命中构造函数写死的能力名。
 * 刻意**不**把 `sessionNotFound` 算成能力缺席：那正是值得重试的那一种。
 */
export function isWorkflowRunsCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("listDynamicWorkflowRuns");
}

/**
 * 某会话名下的 journal run 摘要；查询中为 `undefined`，不可用为 `null`——回退整体缺席，卡片保持
 * 「编过但无 run」形态，绝不假装有入口。
 *
 * historyFirst 的订阅 ACK 只表示历史可读；调用方必须等 runtime ready 才 enabled/live。
 * `live` 抬升后仅补一次查询，不用轮询或退避猜测初始化进度。
 *
 * `refreshKey` 是收口之后**主动**重取的唯一缝（run 目录页与任务列表计数的新鲜度来源）：调用方按「已结算 run 的单调计数」
 * 给它，于是会话中途跑完一个 run 才多一次分页读。刻意不接投影的 `revision`——那个键每来一个
 * 节点事件就抬一次，会把一次读变成一条流。
 */
export function useWorkflowRunJournalSummaries(options: {
  sessionId: string | null;
  live: boolean;
  /**
   * 调用方声明「这条查询对本 pane 有意义」的闸门；缺省 true。
   *
   * journal 按**父会话**建键，而嵌套只读 transcript
   * （dwf actor / subagent）的 SessionPane 曾无差别地带着子会话 id 发出这条查询。
   * 空手而归只是小头；大头是 CLI 的冷会话前置会为一条**正在运行**的 detached 会话
   * 物化第二个（幽灵）runtime——双写同一份事件日志，直播冻结在「已工作 xx 秒」。
   * CLI 侧已按 hasLiveConversation 收口；这里是 UI 侧的那半：不该问的 pane 根本不问。
   */
  enabled?: boolean;
  /** 缺省不带这个键，条数由 CLI 侧裁决（缺省 16 / 上限 64）。 */
  limit?: number;
  refreshKey?: number | string;
}): readonly V4ConversationWorkflowRunSummary[] | null | undefined {
  const { workflowRuns } = useV4Conversation();
  const { enabled = true, limit, live, refreshKey, sessionId } = options;
  // 首帧尚未得到查询结果，不能与失败共用 null，否则目录会先闪现“无法列出”。
  const [summaries, setSummaries] = useState<
    readonly V4ConversationWorkflowRunSummary[] | null | undefined
  >(undefined);
  /**
   * **最近**收口的那个会话及其答案（成功的摘要，或能力缺席时的 `null`）。
   *
   * 记的是「会话 + 答案」而不只是一个「问过了」的布尔：pane 的 `effectiveSessionId` 会变
   * （草稿转正、fork、切任务），而只记会话 id 的话，切回一个问过的会话就会两头落空——
   * 既早退不重查，又因为换会话清了状态而永远空着。换到别的会话再切回来会重查一页 journal，
   * 这很便宜；一个永远空着的入口不便宜。
   *
   * `refreshKey` 一并记下：抬升即视为「这个答案过期了」而重取。**但能力缺席不受它影响**
   * （见下），所以那一档单独记一个标记而不是塞进这里比较。
   */
  const settledRef = useRef<{
    sessionId: string;
    refreshKey: number | string | undefined;
    summaries: readonly V4ConversationWorkflowRunSummary[] | null;
  } | null>(null);
  /**
   * 能力缺席是**按会话**的终局事实：旧 CLI / journal 不可用不会因为跑完一个 run 就变了。
   * 与上面的收口分开记，正是为了让 `refreshKey` 抬升穿不过这一档——否则每跑完一个 run
   * 都要再打一次注定失败的 RPC，而那恰是这条分类当初写下来要避免的抖动。
   */
  const capabilityMissingSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setSummaries(null);
      return;
    }
    if (capabilityMissingSessionRef.current === sessionId) {
      setSummaries(null);
      return;
    }
    const settled = settledRef.current;
    if (settled?.sessionId === sessionId && settled.refreshKey === refreshKey) {
      // 已有答案：`live` 抬升不再多打一次 RPC（活 run 归投影，journal 只补历史）。
      setSummaries(settled.summaries);
      return;
    }
    // 换会话：上一个会话的 run 拿来给这个会话的卡片做 join 就是错的 join。
    // （`refreshKey` 抬升走的是同一条路：清空 → 重取，新答案落地前不显示旧的。）
    setSummaries(undefined);
    let alive = true;
    workflowRuns({ sessionId, ...(limit === undefined ? {} : { limit }) }).then(
      (result) => {
        if (!alive) return;
        settledRef.current = { sessionId, refreshKey, summaries: result.runs };
        setSummaries(result.runs);
      },
      (error: unknown) => {
        if (!alive) return;
        if (isWorkflowRunsCapabilityMissing(error)) {
          capabilityMissingSessionRef.current = sessionId;
        } else {
          // 冷会话是这里最常见的一种，`live` 抬升时会自动再来一次；日志留痕便于排查其余。
          logger.warn("[workflow-run] 读取 run 摘要失败（journal 回退暂缺）", {
            error: error instanceof Error ? error.message : String(error),
            live,
            sessionId,
          });
        }
        setSummaries(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [enabled, limit, live, refreshKey, sessionId, workflowRuns]);

  return summaries;
}
