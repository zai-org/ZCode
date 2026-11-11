// Bugfix：本文件在分享只读时间线闭包里，从 `@/plugin-ui/index.js` 桶文件导入会把 plugin-ui
// 全量组件拖进 web-share 构建，`@zcode/shared/mcp-apps` 等子路径无法解析，分享落地页镜像构建失败。
// 所以直接引用纯函数模块。
import { isPluginUiPinnedToolRow } from "@/plugin-ui/domain/pluginUiRowPolicy.js";
import type {
  ConversationTurnRenderUnit,
  BuildConversationTurnRenderUnitsOptions,
} from "@/v4/conversationTurnRenderUnitTypes.js";
export type {
  ConversationTurnRenderUnit,
  BuildConversationTurnRenderUnitsOptions,
} from "@/v4/conversationTurnRenderUnitTypes.js";
import type {
  AssistantTextRow,
  ConversationRow,
  ConversationRowsPartition,
  HookInvocationRow,
  SessionPhase,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import {
  isWorkflowLaunchUserInputRow,
  resolveWorkflowLaunchMeta,
} from "@/v4/workflowLaunchTurn.js";
import {
  buildConversationTurnWorkSegments,
  resolveConversationTurnWorkDurationMs,
  resolveConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";
import { markHighspeedOutputFooterUnits } from "@/highspeed/highspeedOutputFooter.js";

export type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
export type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";

interface DraftTurnRenderUnit {
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  userInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  hookInvocations: HookInvocationRow[];
  orderedRows: ConversationRow[];
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isTurnHeaderRow(row: ConversationRow): row is TurnHeaderRow {
  return row.kind === "turnHeader";
}

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isTimelineMarkerRow(row: ConversationRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker";
}

function isHookInvocationRow(row: ConversationRow): row is HookInvocationRow {
  return row.kind === "hookInvocation";
}

function isVisibleAssistantWorkRow(row: AssistantWorkRow): boolean {
  // 包装参数未完整时没有权威目标身份，通用卡片会绕过 Todo 等隐藏规则。
  // 仅隐藏参数生成期；目标身份到达后复用原 renderer，失败和停止仍保留反馈。
  if (
    row.kind === "toolCall" &&
    row.toolName === "DeferredToolCall" &&
    row.status === "inputStreaming"
  ) {
    return false;
  }
  if (row.kind === "reasoning" && row.text.trim().length === 0) {
    // reasoning_start/reasoning_end 可能形成空的终态 block；只在共享
    // render-unit 边界裁掉它，避免 completed 状态绕过 streaming renderer 的空行过滤。
    return false;
  }
  // EnterPlanMode 只是内部模式切换边界，把它当普通工具放进“已工作”，
  // 会显示一条没有用户价值的“工具调用已执行”。只在 render unit 过滤，不改写协议投影，
  // 以保留 desktop continuous / web remote replayable 共用的运行态与恢复语义。
  return row.kind !== "toolCall" || row.toolName !== "EnterPlanMode";
}

function isVisibleConversationRow(row: ConversationRow): boolean {
  if (isUserInputRow(row)) return true;
  if (isTurnHeaderRow(row)) return false;
  if (isHookInvocationRow(row)) return false;
  return isVisibleAssistantWorkRow(row);
}

// 落位语义（lane）由 CLI 投影裁决下发（UI 不得按 marker type 自行推断）。
// lane 缺省（不应发生）按 assistantWork 兜底——降级进折叠组，不丢行。
function isTurnEndingTimelineMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "turnTailBoundary";
}

/**
 * artifact 行是分享投影追加到轮尾的产出物（insertDiscoveredArtifacts 插在该
 * productTurn 最后一行之后），但它同样属于 AssistantWorkRow，会成为 flow 的最后一行。
 * 于是折叠锚点的兜底条件「最后一行是 assistantText」失效——公开投影禁止 actions，
 * 分享页只有这条兜底——最终答复被卷进「已工作」并整轮默认展开。
 *
 * 它是追加的产出物、不属于对话流，按轮尾处理即可；与 browserTurnEndRows 摘轮尾截图同理。
 * 注意不能改成「取 flow 里最后一条 assistantText」：那会把 CUA 响应中途的正文
 * 提升成最终答复，拆散同一个 assistantResponseId 的分组。
 */
function isTurnTrailingArtifactRow(row: AssistantWorkRow): boolean {
  return row.kind === "artifact";
}

function splitTurnTailRows(rows: readonly AssistantWorkRow[]): {
  flowRows: AssistantWorkRow[];
  tailRows: AssistantWorkRow[];
} {
  let tailStart = rows.length;
  while (
    tailStart > 0 &&
    (isTurnEndingTimelineMarkerRow(rows[tailStart - 1]!) ||
      isTurnTrailingArtifactRow(rows[tailStart - 1]!))
  ) {
    tailStart -= 1;
  }
  return {
    flowRows: rows.slice(0, tailStart),
    tailRows: rows.slice(tailStart),
  };
}

function isBrowserTurnEndRow(row: AssistantWorkRow): boolean {
  // 自动截图以完成态 tool row 持久化在最终正文之后，旧分组只把
  // timeline boundary 识别为轮尾，导致截图被搬进上方“已工作”折叠区而不可见。
  return (
    row.kind === "toolCall" &&
    row.display?.kind === "node_repl_images" &&
    row.display.source === "browser_turn_end"
  );
}

function isLightBoundaryMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "lightBoundary";
}

function isCompletionBlockingWorkRowRunning(row: AssistantWorkRow): boolean {
  switch (row.kind) {
    case "assistantText":
    case "reasoning":
      return row.state === "streaming";
    case "toolCall":
      return (
        row.backgrounded !== true &&
        (row.status === "inputStreaming" ||
          row.status === "pendingApproval" ||
          row.status === "running")
      );
    case "subagent":
      return row.backgrounded !== true && row.status === "running";
    case "timelineMarker":
      return "status" in row.marker && row.marker.status === "running";
    default:
      return false;
  }
}

function resolveTurnRunning(
  draft: DraftTurnRenderUnit,
  options: BuildConversationTurnRenderUnitsOptions,
): boolean {
  if (draft.header) {
    if (draft.header.executionKind === "controlOnly") return false;
    // turnHeader 是 projection 的权威轮次边界；已终态主轮不能被
    // 同轮仍在运行的 background tool/subagent 行重新推成 running。
    return draft.header.state === "running";
  }
  if (
    options.sessionPhase === "completedSuccess" ||
    options.sessionPhase === "completedInterrupted" ||
    options.sessionPhase === "error"
  ) {
    // cold snapshot 只保留尾窗时可能裁掉 turnHeader；旧 fallback 会把
    // 孤立的 inputStreaming/running tool row 重新推成 thinking，终态 control 必须优先。
    return false;
  }
  // 仅兼容缺少 turnHeader 的旧投影；background-only work 不阻塞主轮完成。
  return draft.assistantWorkRows.some(isCompletionBlockingWorkRowRunning);
}

function shouldForceOpenAbnormalHistory(
  header: TurnHeaderRow | undefined,
  sessionPhase: SessionPhase | undefined,
): boolean {
  if (header) {
    return header.state === "completedInterrupted" || header.state === "failed";
  }
  return sessionPhase === "completedInterrupted" || sessionPhase === "error";
}

function materializeDraftUnit(
  draft: DraftTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const workflowLaunch = resolveWorkflowLaunchMeta(draft.header, draft.userInputs);
  // 启动轮的用户行由 run 卡代言，不进可见输入也不进流。
  const renderedRows =
    workflowLaunch === undefined
      ? draft.orderedRows
      : draft.orderedRows.filter((row) => !isWorkflowLaunchUserInputRow(row));
  const visibleUserInputs = renderedRows.filter(isUserInputRow);
  const visibleAssistantWorkRows = draft.assistantWorkRows.filter(isVisibleAssistantWorkRow);
  const visibleOrderedRows = renderedRows.filter(isVisibleConversationRow);
  const timelineOnly =
    visibleUserInputs.length === 0 &&
    visibleAssistantWorkRows.length > 0 &&
    visibleAssistantWorkRows.every(isTimelineMarkerRow);

  // modelChange 是轮顶轻边界，渲染在 user 输入之前，不进工作流。
  const leadingBoundaryRows = timelineOnly
    ? []
    : visibleAssistantWorkRows.filter(isLightBoundaryMarkerRow);
  const leadingBoundaryRowIds = new Set(leadingBoundaryRows.map((row) => row.rowId));
  const bodyRows = timelineOnly
    ? visibleAssistantWorkRows
    : visibleAssistantWorkRows.filter((row) => !isLightBoundaryMarkerRow(row));
  // Browser 自动截图要越过 file diff 摘要成为最后内容块，因此先单独抽取；
  // 其余 row 仍按 CLI 全序处理，只有连续的真实轮尾 marker 后缀可从 flow 拆出。
  const browserTurnEndRows: AssistantWorkRow[] = [];
  const nonBrowserRows: AssistantWorkRow[] = [];
  if (!timelineOnly) {
    for (const row of bodyRows) {
      if (isBrowserTurnEndRow(row)) {
        browserTurnEndRows.push(row);
      } else {
        nonBrowserRows.push(row);
      }
    }
  }
  // 不能用 filter 抽取所有 turnTailBoundary，并把 ExitPlanMode 也强行归入 tail，
  // 会把计划和中间 marker 从原 tool row 搬到轮底。其余 row 必须留在 flow 中。
  const { flowRows, tailRows: assistantTailRows } = timelineOnly
    ? { flowRows: [], tailRows: [] }
    : splitTurnTailRows(nonBrowserRows);

  const isLastTurn = index === total - 1;
  const isRunning = resolveTurnRunning(draft, options);
  const isInterrupted = draft.header
    ? draft.header.state === "completedInterrupted"
    : options.sessionPhase === "completedInterrupted";
  // 旧展开规则只看 running 和最终正文，异常终态一旦保留 partial assistant text
  // 就会被当作正常完成而收起，隐藏中断/失败上下文。终态必须以 header 为权威；冷恢复
  // 尾窗缺 header 时才回退 session phase，desktop continuous 与 mobile replayable 共用此边界。
  const forceOpenHistory = shouldForceOpenAbnormalHistory(draft.header, options.sessionPhase);

  // product turn 的最终正文仍是唯一 action target；视觉工作段只改变折叠边界。
  const assistantTextRows = flowRows.filter(isAssistantTextRow);
  const actionAssistantTextRow = assistantTextRows.find(
    (row) => row.actions?.canFork === true || row.actions?.canRetry === true,
  );
  const lastFlowRow = flowRows.at(-1);
  const latestAssistantTextRow =
    actionAssistantTextRow ??
    (!isRunning && lastFlowRow && isAssistantTextRow(lastFlowRow) ? lastFlowRow : undefined);
  const workDurationMs = resolveConversationTurnWorkDurationMs(draft.header, options, isRunning);
  const workStatus = resolveConversationTurnWorkStatus(
    draft.header,
    bodyRows,
    isRunning,
    workDurationMs,
    isInterrupted,
  );
  const browserTurnEndRowIds = new Set(browserTurnEndRows.map((row) => row.rowId));
  const orderedBodyRows = visibleOrderedRows.filter(
    // main 的 workSegments 会从 orderedRows 重建 flow；如果这里只从
    // bodyRows 抽取截图，它仍会被塞回正文流并在轮尾再次渲染，造成重复和顺序错乱。
    (row) => !leadingBoundaryRowIds.has(row.rowId) && !browserTurnEndRowIds.has(row.rowId),
  );
  const workSegments = buildConversationTurnWorkSegments({
    key: draft.key,
    header: draft.header,
    orderedRows: orderedBodyRows,
    assistantTailRows,
    latestAssistantTextRow,
    isRunning,
    isLastTurn,
    isInterrupted,
    forceOpenHistory,
    timelineOnly,
    nowMs: options.nowMs,
    ...(options.pluginUiPinResolver ? { pluginUiPinResolver: options.pluginUiPinResolver } : {}),
  });
  const orderedAssistantHistoryRows = workSegments.flatMap(
    (segment) => segment.assistantHistoryRows,
  );
  const assistantFollowingRows = workSegments.flatMap((segment) => segment.assistantFollowingRows);
  const flowItems = workSegments.flatMap((segment) => segment.flowItems);
  const mustOpenHistory = workSegments.at(-1)?.assistantHistoryDefaultOpen ?? false;
  return {
    key: draft.key,
    turnId: draft.turnId,
    ...(draft.header ? { header: draft.header } : {}),
    visibleUserInputs,
    // 轻边界已经由 leadingBoundaryRows 独立承载，不能再算作 assistant work。
    assistantWorkRows: bodyRows,
    assistantHistoryRows: orderedAssistantHistoryRows,
    assistantFollowingRows,
    assistantTailRows,
    browserTurnEndRows,
    hookInvocations: draft.hookInvocations,
    assistantTextRows,
    leadingBoundaryRows,
    ...(latestAssistantTextRow ? { latestAssistantTextRow } : {}),
    flowItems,
    workSegments,
    // renderRows 是查找/诊断用的平面视图，也必须服从 CLI row 全序。
    renderRows: visibleOrderedRows,
    isLastTurn,
    isRunning,
    assistantHistoryDefaultOpen: mustOpenHistory,
    timelineOnly,
    ...(workStatus ? { workStatus } : {}),
    ...(draft.header ? { startedAt: draft.header.startedAt } : {}),
    ...(workflowLaunch ? { workflowLaunch } : {}),
  };
}

function createDraftUnit(turnId: string): DraftTurnRenderUnit {
  return {
    // cold snapshot 可能从同一 turn 的 assistant/tool 行中间截断，补到
    // turnHeader 后首个可见 rowId 会变化。虚拟列表 key 必须只依赖协议稳定的 turnId，
    // 否则补页会把原 turn 当成新节点重挂，丢失测高缓存和视口锚点。
    key: turnId,
    turnId,
    userInputs: [],
    assistantWorkRows: [],
    hookInvocations: [],
    orderedRows: [],
  };
}

function shouldKeepRenderUnit(unit: ConversationTurnRenderUnit): boolean {
  // 隐形行清零后（投影不再产不可渲染 marker），任何工作行都可渲染；
  // 「哪些 marker 可渲染」不再是 UI 的判断。
  return (
    unit.visibleUserInputs.length > 0 ||
    unit.assistantWorkRows.length > 0 ||
    unit.hookInvocations.some((row) => row.executions.some((execution) => execution.didExecute)) ||
    unit.leadingBoundaryRows.length > 0 ||
    // 直接启动轮：用户行不可见、无助手内容，轮由 run 卡呈现——它当然要留下。
    unit.workflowLaunch !== undefined ||
    unit.isRunning
  );
}

function normalizeRenderUnitPosition(
  unit: ConversationTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const isLastTurn = index === total - 1;
  const forceOpenHistory = shouldForceOpenAbnormalHistory(unit.header, options.sessionPhase);
  const assistantHistoryDefaultOpen =
    unit.workSegments && unit.workSegments.length > 0
      ? !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workSegments.at(-1)?.workStatus?.state === "running") ||
          (unit.workSegments.length === 1 &&
            unit.latestAssistantTextRow === undefined &&
            unit.assistantWorkRows.length > 0))
      : !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workStatus?.state === "running") ||
          (unit.latestAssistantTextRow === undefined && unit.assistantWorkRows.length > 0));
  const lastSegment = unit.workSegments?.at(-1);
  const lastSegmentDefaultOpen = lastSegment
    ? !unit.timelineOnly &&
      (forceOpenHistory ||
        (isLastTurn && lastSegment.workStatus?.state === "running") ||
        (unit.workSegments?.length === 1 &&
          unit.latestAssistantTextRow === undefined &&
          lastSegment.assistantWorkRows.length > 0))
    : undefined;
  if (
    unit.isLastTurn === isLastTurn &&
    unit.assistantHistoryDefaultOpen === assistantHistoryDefaultOpen &&
    lastSegmentDefaultOpen === lastSegment?.assistantHistoryDefaultOpen
  ) {
    return unit;
  }
  // 旧实现在判定未变化之前就复制所有轮的 segment；长历史每帧会产生大量随后丢弃的对象。
  const workSegments = unit.workSegments?.map((segment) =>
    segment === lastSegment && segment.assistantHistoryDefaultOpen !== lastSegmentDefaultOpen
      ? { ...segment, assistantHistoryDefaultOpen: lastSegmentDefaultOpen === true }
      : segment,
  );
  return {
    ...unit,
    isLastTurn,
    assistantHistoryDefaultOpen,
    ...(workSegments ? { workSegments } : {}),
  };
}

export function buildConversationTurnRenderUnits(
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions = {},
): ConversationTurnRenderUnit[] {
  return buildRenderUnits(rows, options, materializeDraftUnit);
}

// Bug 根因：selector 的复用判定原先用 zustand shallow。它比较数组或对象时会为两侧各建一个 Map，
// 而判定每帧对每个历史轮都跑一遍。长会话流式输出时这成了 renderer 主线程的头号热点
// （约 8000 行时每帧约 1.75ms；宽屏问题目录补齐完整历史后，成本随历史长度增长）。
// 复用只需要逐项引用比较，因此改为不分配对象的比较。
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** 与 shallow 的对象语义一致：自有字段集合相同且逐字段 Object.is；可忽略一个字段。 */
function sameFields(a: object | undefined, b: object | undefined, ignoredKey?: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let fieldCount = 0;
  for (const key in left) {
    if (key === ignoredKey) continue;
    if (!Object.hasOwn(right, key) || !Object.is(left[key], right[key])) return false;
    fieldCount += 1;
  }
  for (const key in right) {
    if (key !== ignoredKey) fieldCount -= 1;
  }
  return fieldCount === 0;
}

function groupDraftUnits(rows: readonly ConversationRow[]): DraftTurnRenderUnit[] {
  const units: DraftTurnRenderUnit[] = [];
  const unitByTurnId = new Map<string, DraftTurnRenderUnit>();

  const getOrCreateUnit = (turnId: string) => {
    const existing = unitByTurnId.get(turnId);
    if (existing) {
      return existing;
    }
    const unit = createDraftUnit(turnId);
    units.push(unit);
    unitByTurnId.set(turnId, unit);
    return unit;
  };

  for (const row of rows) {
    const unit = getOrCreateUnit(row.turnId);
    if (isTurnHeaderRow(row)) {
      unit.header = row;
      continue;
    }
    unit.orderedRows.push(row);
    if (isUserInputRow(row)) {
      unit.userInputs.push(row);
      continue;
    }
    if (isHookInvocationRow(row)) {
      unit.hookInvocations.push(row);
      continue;
    }
    unit.assistantWorkRows.push(row);
  }
  return units;
}

function buildRenderUnits(
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions,
  materialize: typeof materializeDraftUnit,
): ConversationTurnRenderUnit[] {
  const units = groupDraftUnits(rows);
  const materializedUnits = units.map((unit, index) =>
    materialize(unit, index, units.length, options),
  );
  const keptUnits = materializedUnits.filter(shouldKeepRenderUnit);
  const normalizedUnits = keptUnits.map((unit, index) =>
    normalizeRenderUnitPosition(unit, index, keptUnits.length, options),
  );
  return markHighspeedOutputFooterUnits(normalizedUnits, options.nowMs ?? Date.now());
}

function hasHighspeedCard(unit: ConversationTurnRenderUnit): boolean {
  return unit.visibleUserInputs.some((row) => row.highspeed !== undefined);
}

/** 与 rows 分区对应的 render unit（spec：docs/ui/chat-virtual-scroll.md「每帧派生成本」）。 */
export interface ConversationTurnRenderUnitsPartition {
  /** 历史段的 unit；只在历史派生结果变化时更换引用。 */
  readonly history: readonly ConversationTurnRenderUnit[];
  /** 尾轮的 unit（通常 0–1 个）。 */
  readonly tail: readonly ConversationTurnRenderUnit[];
}

/**
 * 输出与对 history ++ tail 全量构建逐项相等，但每帧只 materialize 尾轮。
 *
 * Bug 根因：原选择器每帧都要对全部 rows 分组，并对每个历史轮逐行确认“没变”，
 * 成本随历史长度线性增长；宽屏问题目录补齐完整历史后，长会话流式输出明显卡顿。
 * 现在历史段结果按 history 数组引用缓存。只有历史中存在无 header 的轮次（读 phase）、
 * 仍在运行的轮次（读时钟）或可固定的插件卡片（读固定裁决）时，缓存键才额外带上对应输入。
 * 跨轮规则在合并时处理：尾轮 unit 被过滤掉时，历史末项按最后一轮重新归一化；
 * highspeed footer 只在含卡片的 unit 上收口，不含卡片的 unit 既不影响也不会得到 footer，
 * 所以在“含卡片历史 unit + 尾轮 unit”子序列上收口，结果与全量收口相同。
 */
export function createConversationTurnRenderUnitsSelector() {
  type Entry = {
    draft: DraftTurnRenderUnit;
    isLast: boolean;
    phase: SessionPhase | undefined;
    clock: number | undefined;
    pinnedRows: ConversationRow[];
    unit: ConversationTurnRenderUnit;
  };
  type UnitMap = Map<string, ConversationTurnRenderUnit>;
  type HistoryCache = {
    rows: readonly ConversationRow[];
    draftCount: number;
    phaseDependent: boolean;
    phase: SessionPhase | undefined;
    clockDependent: boolean;
    clock: number;
    pinDependent: boolean;
    resolver: BuildConversationTurnRenderUnitsOptions["pluginUiPinResolver"];
    // 已过滤并按“后面还有尾轮”归一化，尚未收口 footer。
    units: ConversationTurnRenderUnit[];
    cardIndexes: number[];
    /**
     * 尾轮 unit 全部被过滤时，历史末项按最后一轮重新归一化后的历史数组。
     * Bug 根因：原先每次调用都新建这个数组，history 引用每次都变，下游按 history 缓存的派生全部失效。
     * 归一化只读 unit 与 session phase，所以按 phase 缓存即可。
     */
    tailDropped?: { phase: SessionPhase | undefined; units: readonly ConversationTurnRenderUnit[] };
  };
  // materialize 复用表按 turn key 分历史段与尾段；轮次在两段之间迁移时两边都查。
  let historyEntries = new Map<string, Entry>();
  let tailEntries = new Map<string, Entry>();
  // 最终 unit（footer 收口后）的复用表。
  let historyFinalByKey: UnitMap = new Map();
  let tailFinalByKey: UnitMap = new Map();
  let history: HistoryCache | null = null;
  let historyFinal: {
    base: readonly ConversationTurnRenderUnit[];
    units: ConversationTurnRenderUnit[];
  } | null = null;

  const materializeReusing = (
    draft: DraftTurnRenderUnit,
    index: number,
    total: number,
    options: BuildConversationTurnRenderUnitsOptions & { nowMs: number },
    lookup: (key: string) => Entry | undefined,
    next: Map<string, Entry>,
  ): Entry => {
    const old = lookup(draft.key);
    const isLast = index === total - 1;
    const phase = draft.header ? undefined : options.sessionPhase;
    const clock = resolveTurnRunning(draft, options) ? options.nowMs : undefined;
    // resolver 随插件派生重建，但普通消息不会改变插件的实际折叠裁决。
    const pinnedRows = draft.orderedRows.filter((row) =>
      isPluginUiPinnedToolRow(row, options.pluginUiPinResolver),
    );
    const unchanged =
      old &&
      old.draft.header === draft.header &&
      sameItems(old.draft.orderedRows, draft.orderedRows) &&
      old.isLast === isLast &&
      old.phase === phase &&
      old.clock === clock &&
      sameItems(old.pinnedRows, pinnedRows);
    const entry: Entry = {
      draft,
      isLast,
      phase,
      clock,
      pinnedRows,
      unit: unchanged ? old.unit : materializeDraftUnit(draft, index, total, options),
    };
    next.set(draft.key, entry);
    return entry;
  };

  // 卡级 footer 每次重新收口；仅当数值与其他派生字段都未变时复用上一份最终 unit。
  const reuseFinal = (
    unit: ConversationTurnRenderUnit,
    lookup: (key: string) => ConversationTurnRenderUnit | undefined,
  ): ConversationTurnRenderUnit => {
    const old = lookup(unit.key);
    if (!old || old === unit) return unit;
    const target = unit.highspeedOutputFooterTarget;
    const oldTarget = old.highspeedOutputFooterTarget;
    return sameFields(unit, old, "highspeedOutputFooterTarget") &&
      target?.cardId === oldTarget?.cardId &&
      sameFields(target?.metrics, oldTarget?.metrics)
      ? old
      : unit;
  };

  const isHistoryReusable = (
    cache: HistoryCache | null,
    rows: readonly ConversationRow[],
    options: BuildConversationTurnRenderUnitsOptions & { nowMs: number },
  ): cache is HistoryCache =>
    cache !== null &&
    cache.rows === rows &&
    (!cache.phaseDependent || cache.phase === options.sessionPhase) &&
    (!cache.clockDependent || cache.clock === options.nowMs) &&
    (!cache.pinDependent || cache.resolver === options.pluginUiPinResolver);

  return (
    partition: ConversationRowsPartition,
    options: BuildConversationTurnRenderUnitsOptions = {},
  ): ConversationTurnRenderUnitsPartition => {
    const currentOptions = { ...options, nowMs: options.nowMs ?? Date.now() };
    const previousHistoryEntries = historyEntries;
    const previousTailEntries = tailEntries;
    const previousHistoryFinalByKey = historyFinalByKey;
    const previousTailFinalByKey = tailFinalByKey;
    const tailDrafts = groupDraftUnits(partition.tail);

    if (!isHistoryReusable(history, partition.history, currentOptions)) {
      const drafts = groupDraftUnits(partition.history);
      // 尾轮非空时历史 draft 都不是最后一个；窗口为空时两段都为空。
      const total = drafts.length + tailDrafts.length;
      const next = new Map<string, Entry>();
      let clockDependent = false;
      const materialized = drafts.map((draft, index) => {
        const entry = materializeReusing(
          draft,
          index,
          total,
          currentOptions,
          (key) => previousHistoryEntries.get(key) ?? previousTailEntries.get(key),
          next,
        );
        if (entry.clock !== undefined) clockDependent = true;
        return entry.unit;
      });
      historyEntries = next;
      const kept = materialized.filter(shouldKeepRenderUnit);
      // 先按“后面还有一个尾轮 unit”归一化；尾轮被过滤掉的情况在下面合并时处理。
      const units = kept.map((unit, index) =>
        normalizeRenderUnitPosition(unit, index, kept.length + 1, currentOptions),
      );
      history = {
        rows: partition.history,
        draftCount: drafts.length,
        phaseDependent: drafts.some((draft) => !draft.header),
        phase: currentOptions.sessionPhase,
        clockDependent,
        clock: currentOptions.nowMs,
        // 不传 resolver 时，isPluginUiPinnedToolRow 恰好判定“该行是否受固定裁决影响”。
        pinDependent: drafts.some((draft) =>
          draft.orderedRows.some((row) => isPluginUiPinnedToolRow(row)),
        ),
        resolver: currentOptions.pluginUiPinResolver,
        units,
        cardIndexes: units.flatMap((unit, index) => (hasHighspeedCard(unit) ? [index] : [])),
      };
    }

    const historyDraftCount = history.draftCount;
    const tailNext = new Map<string, Entry>();
    const tailKept = tailDrafts
      .map(
        (draft, index) =>
          materializeReusing(
            draft,
            historyDraftCount + index,
            historyDraftCount + tailDrafts.length,
            currentOptions,
            (key) => previousTailEntries.get(key) ?? previousHistoryEntries.get(key),
            tailNext,
          ).unit,
      )
      .filter(shouldKeepRenderUnit);
    tailEntries = tailNext;
    const historyCount = history.units.length;
    const tailUnits = tailKept.map((unit, index) =>
      normalizeRenderUnitPosition(
        unit,
        historyCount + index,
        historyCount + tailKept.length,
        currentOptions,
      ),
    );

    let historyUnits: readonly ConversationTurnRenderUnit[] = history.units;
    const lastIndex = historyCount - 1;
    if (tailUnits.length === 0 && lastIndex >= 0) {
      if (!history.tailDropped || history.tailDropped.phase !== currentOptions.sessionPhase) {
        // 归一化只改 isLastTurn 与默认展开，且只读其他字段，所以对已归一化的 unit 再做一次即可。
        const last = normalizeRenderUnitPosition(
          history.units[lastIndex]!,
          lastIndex,
          historyCount,
          currentOptions,
        );
        history.tailDropped = {
          phase: currentOptions.sessionPhase,
          units:
            last === history.units[lastIndex]
              ? history.units
              : [...history.units.slice(0, -1), last],
        };
      }
      historyUnits = history.tailDropped.units;
    }

    const cardIndexes = history.cardIndexes;
    const marked = markHighspeedOutputFooterUnits(
      [...cardIndexes.map((index) => historyUnits[index]!), ...tailUnits],
      currentOptions.nowMs,
    );
    const historyLookup = (key: string) =>
      previousHistoryFinalByKey.get(key) ?? previousTailFinalByKey.get(key);
    const markedCards = cardIndexes.map((_, index) => reuseFinal(marked[index]!, historyLookup));
    const previousFinal = historyFinal;
    if (
      previousFinal?.base !== historyUnits ||
      cardIndexes.some((unitIndex, index) => previousFinal.units[unitIndex] !== markedCards[index])
    ) {
      const units = historyUnits.map((unit) => reuseFinal(unit, historyLookup));
      cardIndexes.forEach((unitIndex, index) => {
        units[unitIndex] = markedCards[index]!;
      });
      historyFinal = { base: historyUnits, units };
      historyFinalByKey = new Map(units.map((unit) => [unit.key, unit]));
    }
    const tailFinal = marked
      .slice(cardIndexes.length)
      .map((unit) =>
        reuseFinal(
          unit,
          (key) => previousTailFinalByKey.get(key) ?? previousHistoryFinalByKey.get(key),
        ),
      );
    tailFinalByKey = new Map(tailFinal.map((unit) => [unit.key, unit]));
    return { history: historyFinal!.units, tail: tailFinal };
  };
}
