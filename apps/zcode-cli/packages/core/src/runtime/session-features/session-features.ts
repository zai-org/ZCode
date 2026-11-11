// ============================================================
// 会话能力标签的 owner（docs/design/v2/model/session-features-header.md）
// ============================================================
// 标签回答「本会话用过哪些能力」，只增不减：compact、rewind、冷恢复都不撤销。runtime 的
// sessionFeatures 是唯一事实源；打点只经 recordSessionFeature，出站请求由 runtime 模型句柄在
// 每次调用时读取快照，adapter 写成 `x-zcode-session-features`。
//
// 状态放在 runtime 字段而不是 config：workflow 子 actor 会展开父 runtime 的整份 config，
// 放进 config 会把父会话的标签带给子会话。

import {
  CREATE_WORKFLOW_TOOL_NAME,
  CoreErrorType,
  ModelRequestSessionFeature,
  PermissionCapabilityGroup,
  SESSION_ENTRY_SESSION_FEATURES,
  ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY,
  ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY,
  isModelRequestSessionFeature,
  isToolSearchName,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionId,
  type ToolSearchExecutionContext,
} from "@zcode/contracts";
import { traceContextToLogContext, type ToolExecutionResult, type TraceContext } from "../deps.js";
import type { ToolEntry } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { WORKFLOW_COMMAND_TEXT_PATTERN } from "../methods/dynamic-workflow-activation.js";

/** session entry 的 data；features 按字典序。 */
export interface SessionFeaturesEntryData {
  features: ModelRequestSessionFeature[];
}

/** CreateWorkflow 成功启动后台 run 时的输出状态（create-workflow handler 的成功分支）。 */
const CREATE_WORKFLOW_BACKGROUNDED_STATUS = "backgrounded";
/** CreateWorkflow 工具结果 display 的 kind（executor/create-workflow-display.ts）。 */
const CREATE_WORKFLOW_DISPLAY_KIND = "create_workflow";
/**
 * 不计入 workflow_auto_attempt 的 CreateWorkflow 失败：权限拒绝（用户、hook、规则拦截在结果层面同一类型）
 * 与工具未注册（workflow 子 actor、灰度关闭时模型凭空调用）。
 */
const CREATE_WORKFLOW_NON_ATTEMPT_ERRORS: ReadonlySet<string> = new Set([
  CoreErrorType.PermissionDenied,
  CoreErrorType.ToolNotFound,
]);
/** node_repl MCP 的 js 工具；只有它的结果里的可信 key 由 node-repl-host 写入。 */
const NODE_REPL_TOOL_NAME = "mcp__node_repl__js";

/**
 * 记录本会话用过一项能力。已有该标签时 no-op 并返回 false。
 * 内存同步更新，所以调用方此后发出的第一个模型请求必然带着它；会话已落盘时排队合并写 entry，
 * 读写失败只记 warn——entry 只是冷恢复的捷径，缺失时 restoreSessionFeaturesOnResume 按历史补回。
 */
export function recordSessionFeature(
  this: AgentRuntimeInternal,
  input: { feature: ModelRequestSessionFeature; traceContext?: TraceContext },
): boolean {
  if (this.sessionFeatures.has(input.feature)) return false;
  this.sessionFeatures.add(input.feature);
  this.logger?.info("Session feature recorded", {
    ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
    event: "session_features.recorded",
    feature: input.feature,
    module: "core.runtime",
    sessionId: this.sessionId,
  });
  if (this.sessionPersisted) void scheduleSessionFeaturesEntryWrite(this, input.traceContext);
  return true;
}

/** 工具结果结算时按结果派生标签（只读结果，不改结算流程）。 */
export function recordSessionFeaturesFromToolResults(
  this: AgentRuntimeInternal,
  results: readonly ToolExecutionResult[],
  traceContext?: TraceContext,
): void {
  for (const result of results) {
    const tool = this.registry.get(result.toolName);
    for (const feature of sessionFeaturesFromToolResult(result, tool ?? {})) {
      recordSessionFeature.call(this, { feature, traceContext });
    }
  }
}

/**
 * 主循环请求准备之后按 ToolSearch 实际生效模式打标签（只由 turn-loop 调用；compact、目标校验、
 * Memory 的请求准备不打）。在模型调用之前执行，所以本次请求就带上。
 */
export function recordSessionFeatureFromToolSearchExposure(
  this: AgentRuntimeInternal,
  exposure: Pick<ToolSearchExecutionContext, "enabled" | "mode">,
  traceContext?: TraceContext,
): void {
  const feature = sessionFeatureFromToolSearchExposure(exposure);
  if (feature) recordSessionFeature.call(this, { feature, traceContext });
}

/**
 * 取的是请求准备结果里的生效模式，不是设置值：设置为 auto 时按 Model 解析成 native 或 local；
 * 没有 deferred 工具或缺少控制工具时 enabled 为假、mode 为 off。
 */
export function sessionFeatureFromToolSearchExposure(
  exposure: Pick<ToolSearchExecutionContext, "enabled" | "mode">,
): ModelRequestSessionFeature | undefined {
  if (!exposure.enabled) return undefined;
  if (exposure.mode === "native") return ModelRequestSessionFeature.ToolSearchNative;
  if (exposure.mode === "local") return ModelRequestSessionFeature.ToolSearchLocal;
  return undefined;
}

/** 出站请求读取的快照：去重、字典序。 */
export function readSessionFeatures(
  runtime: Pick<AgentRuntimeInternal, "sessionFeatures">,
): readonly ModelRequestSessionFeature[] {
  return [...runtime.sessionFeatures].sort();
}

/**
 * 冷恢复：标签 = entry ∪ 从全部持久化消息（含 rewind 前的）推出的标签。fork 不复制父会话的
 * entry，fork 子会话靠这里从复制来的历史继承到 fork 点为止已有的标签。并集比 entry 多时补写。
 */
export async function restoreSessionFeaturesOnResume(
  this: AgentRuntimeInternal,
  messages: readonly MessageWithParts[],
  traceContext?: TraceContext,
): Promise<void> {
  const saved = await readSessionFeaturesEntry(this, traceContext);
  for (const feature of [...(saved ?? []), ...sessionFeaturesFromPersistedMessages(messages)]) {
    this.sessionFeatures.add(feature);
  }
  // entry 读取失败时不补写：之后的打点在写入前会重新读 entry 并合并（见 scheduleSessionFeaturesEntryWrite）。
  if (saved === undefined) return;
  const savedSet = new Set(saved);
  if ([...this.sessionFeatures].some((feature) => !savedSet.has(feature))) {
    // 恢复中的会话在 store 里必然已经存在，不等 sessionPersisted（resume 收尾才置位）。
    await scheduleSessionFeaturesEntryWrite(this, traceContext);
  }
}

/**
 * 首次落盘（events.ts 的 ensureSessionPersisted）后补写：会话落盘前打的标签只在内存里。
 * 调用方必须先把 sessionPersisted 置位，此后的打点各自排队写入。
 */
export function writeSessionFeaturesEntryAfterFirstPersist(
  runtime: AgentRuntimeInternal,
  traceContext?: TraceContext,
): Promise<void> {
  if (runtime.sessionFeatures.size === 0) return Promise.resolve();
  return scheduleSessionFeaturesEntryWrite(runtime, traceContext);
}

/**
 * 一次结算结果对应的标签。tool 是结果所属工具在 registry 里的 entry（只读认证组）；
 * 工具已不在 registry 时传空对象。
 */
export function sessionFeaturesFromToolResult(
  result: Pick<ToolExecutionResult, "error" | "output" | "success" | "toolName">,
  tool: Pick<ToolEntry, "permissionCapabilityGroup"> = {},
): ModelRequestSessionFeature[] {
  if (result.toolName === CREATE_WORKFLOW_TOOL_NAME) {
    // 尝试口径（规格「CreateWorkflow 尝试口径的补充规则」）：有结算结果就打，参数校验、handler 抛错、
    // 权限阶段的基础设施失败与取消都算；只排除权限拒绝和工具未注册。
    if (result.error && CREATE_WORKFLOW_NON_ATTEMPT_ERRORS.has(result.error.type)) return [];
    // workflow_auto 只认真正启动了后台 run 的调用：编译失败（ok:false）和宿主没有 run 端口时也返回
    // success，但输出里没有 backgrounded。
    const backgrounded =
      result.success &&
      isRecord(result.output) &&
      result.output.status === CREATE_WORKFLOW_BACKGROUNDED_STATUS;
    return [
      ...(backgrounded ? [ModelRequestSessionFeature.WorkflowAuto] : []),
      ModelRequestSessionFeature.WorkflowAutoAttempt,
    ];
  }
  // local 模式下模型看到的名字是 LocalToolSearch，执行器换成规范名 ToolSearch；两者都认。
  // 没有匹配结果也是成功调用；请求未启用 ToolSearch 时 handler 抛错，success 为假。
  if (isToolSearchName(result.toolName) && result.success) {
    return [ModelRequestSessionFeature.ToolSearchCalled];
  }
  // BUA/CUA 的口径是"真实尝试"，不看 success 和 isError：只给成功的会话打标签，全失败的会话就不会被
  // 统计方选中，失败率会偏低（规格「BUA/CUA 标签的补充规则」）。
  if (result.toolName === NODE_REPL_TOOL_NAME) {
    const meta =
      isRecord(result.output) && isRecord(result.output._meta) ? result.output._meta : {};
    return [
      ...(meta[ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY] === true
        ? [ModelRequestSessionFeature.BrowserUse]
        : []),
      ...(meta[ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY] === true
        ? [ModelRequestSessionFeature.ComputerUse]
        : []),
    ];
  }
  // 旧版 computer-use MCP 工具只认官方 CUA 认证：认证组只在不可伪造的官方 authority 门成立时写入
  // （core/src/mcp/index.ts）。修复原因（MR !3207 评审 SG-02）：最初按工具名前缀判断，而官方 CUA 自
  // 2026-09-18 起改走 node_repl、插件不再声明 MCP server，带这个前缀的工具多半来自第三方同名 server。
  if (tool.permissionCapabilityGroup === PermissionCapabilityGroup.OfficialCua) {
    return [ModelRequestSessionFeature.ComputerUse];
  }
  return [];
}

/**
 * 从持久化消息推出的标签，冷恢复缺 entry、fork 时使用。
 * - workflow_cmd：用户消息原文以 `/workflow` 开头。灰度关闭或有同名自定义命令时会多报。
 * - workflow_auto：CreateWorkflow 结果的 display 为 create_workflow 且 ok。持久化输出不保留
 *   backgrounded 状态，所以「编译通过、宿主没有 run 端口」也会命中；生产宿主都接了 run 端口。
 * - workflow_auto_attempt：completed 的 CreateWorkflow 工具 part，不看 display（编译失败、无端口也落成
 *   completed）。error 状态的 part 只有自由文本，不保存错误类型，分不出权限拒绝，只靠 entry。
 * - tool_search_called：completed 的 ToolSearch 工具 part。pending/running 写的是模型调用时的原始名
 *   （local 为 LocalToolSearch），completed 写的是规范名，isToolSearchName 都覆盖。
 * - tool_search_native/local 推不出：公告 metadata 与持久化的 tool_reference 结果都与模式无关，只靠 entry。
 * - browser_use、computer_use 推不出，只靠 entry：node_repl 的工具 part 落盘不保存 `_meta`；旧版
 *   computer-use MCP 工具的 part 不带官方认证，只按名字推会把第三方同名 server 算进来。
 */
export function sessionFeaturesFromPersistedMessages(
  messages: readonly MessageWithParts[],
): Set<ModelRequestSessionFeature> {
  const features = new Set<ModelRequestSessionFeature>();
  for (const message of messages) {
    const role = message.info.role;
    for (const part of message.parts) {
      if (
        role === "user" &&
        part.type === "text" &&
        WORKFLOW_COMMAND_TEXT_PATTERN.test(part.text.trim())
      ) {
        features.add(ModelRequestSessionFeature.WorkflowCmd);
      }
      if (
        role === "assistant" &&
        part.type === "tool" &&
        part.tool === CREATE_WORKFLOW_TOOL_NAME &&
        part.state.status === "completed"
      ) {
        features.add(ModelRequestSessionFeature.WorkflowAutoAttempt);
        if (isSuccessfulCreateWorkflowDisplay(part.state.metadata.display)) {
          features.add(ModelRequestSessionFeature.WorkflowAuto);
        }
      }
      if (
        role === "assistant" &&
        part.type === "tool" &&
        isToolSearchName(part.tool) &&
        part.state.status === "completed"
      ) {
        features.add(ModelRequestSessionFeature.ToolSearchCalled);
      }
    }
  }
  return features;
}

export function buildSessionFeaturesEntry(
  sessionId: SessionId,
  features: Iterable<ModelRequestSessionFeature>,
): SessionEntryInfo {
  const timestamp = Date.now();
  const data: SessionFeaturesEntryData = { features: [...new Set(features)].sort() };
  return {
    id: `${sessionId}:runtime-session-features`,
    sessionID: sessionId,
    type: SESSION_ENTRY_SESSION_FEATURES,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data,
  };
}

/**
 * entry 里的词表外标签（例如从更新的版本降级回来）直接忽略；它不进入内存，后续合并写入时会被删除
 * （spec「继承与恢复」）。
 */
export function parseSessionFeaturesEntryData(data: unknown): ModelRequestSessionFeature[] {
  if (!isRecord(data) || !Array.isArray(data.features)) return [];
  return data.features.filter(isModelRequestSessionFeature);
}

/**
 * 读取 entry 中的标签；读取失败返回 undefined 并记 warn。
 * 修复原因（MR !3185 评审 SG-01）：最初直接 await 读取，store 抛错（SQLite busy、数据损坏）会让
 * 整个冷恢复失败。标签只用于统计，读写两侧都按 best-effort 处理，不能改变恢复主流程的结果。
 */
async function readSessionFeaturesEntry(
  runtime: AgentRuntimeInternal,
  traceContext?: TraceContext,
): Promise<ModelRequestSessionFeature[] | undefined> {
  try {
    const entries = await runtime.sessionStore?.sessionEntries?.({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_SESSION_FEATURES,
    });
    return parseSessionFeaturesEntryData(entries?.at(-1)?.data);
  } catch (error) {
    runtime.logger?.warn("Session features entry read failed", {
      ...traceContextToLogContext(traceContext ?? runtime.rootTraceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "session_features.entry_read_failed",
      module: "core.runtime",
      sessionId: runtime.sessionId,
    });
    return undefined;
  }
}

/**
 * 写入串行执行，并在执行时读取最新集合：后完成的写入一定包含先完成的写入的全部标签，
 * 并发打点不会让旧集合覆盖新集合。返回的 Promise 不会 reject。
 *
 * 每次写入前先读 entry、与内存集合取并集再写；读不到就跳过这次写入。
 * 修复原因（MR !3185 评审第二轮 SG-01）：冷恢复时 entry 读取失败，内存集合缺少 entry 里那些
 * 历史推导不出的标签；之后任意一次打点若直接用内存集合整体覆盖，这些标签会永久丢失。
 * 标签只增不减，所以合并写就是正确语义；读到的标签同时并回内存，后续请求也带上。
 */
function scheduleSessionFeaturesEntryWrite(
  runtime: AgentRuntimeInternal,
  traceContext?: TraceContext,
): Promise<void> {
  const next = runtime.sessionFeaturesWrite
    .then(async () => {
      const stored = await readSessionFeaturesEntry(runtime, traceContext);
      if (stored === undefined) return;
      for (const feature of stored) runtime.sessionFeatures.add(feature);
      await runtime.sessionStore?.saveSessionEntry?.(
        buildSessionFeaturesEntry(runtime.sessionId, runtime.sessionFeatures),
      );
    })
    .catch((error: unknown) => {
      runtime.logger?.warn("Session features entry write failed", {
        ...traceContextToLogContext(traceContext ?? runtime.rootTraceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "session_features.entry_write_failed",
        module: "core.runtime",
        sessionId: runtime.sessionId,
      });
    });
  runtime.sessionFeaturesWrite = next;
  return next;
}

function isSuccessfulCreateWorkflowDisplay(display: unknown): boolean {
  return isRecord(display) && display.kind === CREATE_WORKFLOW_DISPLAY_KIND && display.ok === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
