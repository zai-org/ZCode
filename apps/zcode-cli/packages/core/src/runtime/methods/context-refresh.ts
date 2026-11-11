import { formatLocalIsoDate, type TraceContext } from "@zcode/contracts";
import { buildCurrentDateSection } from "../../context/sections/current-date.js";
import {
  instructionFileRecord,
  parseLegacyInstructionFiles,
  renderInstructionDelta,
} from "../../context/sections/instruction-files.js";
import type {
  ContextBuildResult,
  ContextMetaUserAttachment,
  InstructionAnnouncement,
  InstructionRefreshReason,
} from "../../context/types.js";
import {
  buildEnvironmentAnnouncement,
  buildGitSystemContextSection,
  buildModelSection,
  environmentSnapshot,
  isEnvInfoGitRepository,
  type EnvironmentSnapshot,
} from "../../context/sections/env-info.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import {
  buildDateChangeReminderBody,
  buildOutputStyleInstructionsBody,
  OUTPUT_STYLE_RESET_REMINDER,
} from "../helpers/runtime-reminders.js";
import { querySourceForTask } from "./turn-model-step-usage.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import type { TurnRequestState } from "./turn-loop-state.js";
import { countContextPrefixMessages } from "../deps.js";
import type { Model, OutputStylePromptConfig } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";
import { throwIfTurnAborted } from "../helpers/turn-errors.js";
import { buildProjectionAnchor } from "./projection-anchor.js";
import { persistRuntimeReminderMessage } from "./runtime-reminder-persistence.js";
import { supersedeContextComposition } from "../context-composition/state.js";
import { promptSnapshotFor } from "../helpers/prompt-snapshot.js";
import { resolveGenUiOutputDirectory } from "../helpers/gen-ui-output.js";

export function rebuildContextPrefix(
  runtime: AgentRuntimeInternal,
  options: { model?: Model; turnRequestEntries?: readonly RuntimeMessageEntry[] } = {},
): readonly RuntimeMessageEntry[] {
  // 通知在 microtask 之后才发出（bootstrap tracker 合并），届时下面的同步重建已经完成。
  supersedeContextComposition(runtime, "context_prefix");
  if (!runtime.contextBuilder || !runtime.contextInitialized) {
    // 首轮 context 初始化前，model/outputStyle/language 变更只能刷新同步预览，
    // 不能把 config-only fallback envInfo 写入 config.envInfo。否则真实 context source
    // 会以为 envInfo 已由外部显式提供，跳过平台和 git 探测。
    if (runtime.contextBuilder) {
      runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
        runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory),
        runtime.memoryRoot,
        {
          memoryIndexContent: runtime.memoryIndexContent,
          model: options.model,
          persistEnvInfo: false,
        },
      );
    }
    return options.turnRequestEntries ?? runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  }

  const contextSnapshot =
    runtime.contextSourceSnapshot ??
    runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory);
  runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
    contextSnapshot,
    runtime.memoryRoot,
    { memoryIndexContent: runtime.memoryIndexContent, model: options.model },
  );
  const effectiveContextResult = runtime.contextBuilder.build();
  // 主会话的 prompt 快照适用于这个模型时，system 用快照记录的字节，不用当前代码的渲染结果。
  // 修复原因：system 原来每次按当前代码重建，升级或冷恢复后已发送的前缀字节改变，prompt cache 失效。
  const snapshot = promptSnapshotFor(runtime, options.model);
  const contextEntries: RuntimeMessageEntry[] = snapshot
    ? snapshot.system.map((message) => ({ message: structuredClone(message) }))
    : buildContextHistoryEntries(effectiveContextResult);
  const canonicalEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const canonicalConversationEntries = canonicalEntries.slice(
    countContextPrefixMessages(canonicalEntries),
  );

  runtime.latestContextBuildResult = effectiveContextResult;
  runtime.messageHistory.replaceMessages([...contextEntries, ...canonicalConversationEntries]);

  const turnEntries = options.turnRequestEntries;
  if (!turnEntries) return runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  return [...contextEntries, ...turnEntries.slice(countContextPrefixMessages(turnEntries))];
}

// 输入附件中的环境、模型与 output style 指令（environment → model → output_style_instructions）。
// ToolSearch 公告、agent listing、skills 由 turn-loop 紧随其后追加。
export async function appendRuntimeContextAnnouncements(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  model: Model,
  outputStyle: OutputStylePromptConfig | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<void> {
  const contextResult = runtime.latestContextBuildResult;
  const environment = announcesEnvironment(contextResult)
    ? await resolveCurrentEnvironment(
        runtime,
        latestAnnouncedEnvironment(state.entries),
        traceContext,
        signal,
      )
    : undefined;
  const attachments = buildRuntimeContextAnnouncements(runtime, state.entries, {
    contextResult,
    environment,
    model,
    outputStyle,
  });
  throwIfTurnAborted(signal);
  await persistAnnouncements(runtime, state, attachments, traceContext);
}

function announcesEnvironment(contextResult: ContextBuildResult | undefined): boolean {
  return contextResult?.sections.some((section) => section.source === "env_info") === true;
}

/**
 * 环境、模型与 output style 指令公告的纯计算部分；当前环境由调用方先读好传入。
 * 输入附件收集（读当前环境）与 context 组成预演（只用历史或启动快照）共用，二者产出同一组公告。
 */
export function buildRuntimeContextAnnouncements(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  input: {
    contextResult: ContextBuildResult | undefined;
    environment: EnvironmentSnapshot | undefined;
    model: Model;
    outputStyle: OutputStylePromptConfig | undefined;
  },
): RuntimeAttachmentEntry[] {
  if (!announcesEnvironment(input.contextResult)) return [];
  const last = lastAnnouncedAttachments(entries);
  const attachments: RuntimeAttachmentEntry[] = [];
  const previous = environmentOf(last.get("environment"))?.snapshot;
  const hasFullBlock = entries.some((entry) => environmentOf(entry)?.full);
  // 环境公告带 Desktop 段与会话的 Gen UI 输出目录（withDesktopContext，纯计算，不建目录）：
  // 正式请求与 context 组成预演走同一份规则，预演出的环境公告与真实首个请求一致。
  const environment = input.environment && withDesktopContext(runtime, input.environment);
  const announcement = environment
    ? buildEnvironmentAnnouncement(environment, previous, hasFullBlock)
    : null;
  if (announcement) attachments.push(environmentAttachment(announcement));
  const identity = buildModelSection(input.model)!;
  if (last.get("model")?.content !== identity.content) {
    attachments.push(systemReminderAttachmentEntry("model", identity.content));
  }
  // output style 只对主线程宣告。内容与最近一次宣告不同时再宣告；
  // 清除风格时，若最近一次宣告的是某个风格，宣告一次重置。
  if (querySourceForTask(runtime.config.taskType) === "main_turn") {
    const previousStyle = last.get("output_style_instructions")?.content;
    const instructions =
      buildOutputStyleInstructionsBody(input.outputStyle) ??
      (previousStyle === undefined ? undefined : OUTPUT_STYLE_RESET_REMINDER);
    if (instructions !== undefined && instructions !== previousStyle) {
      attachments.push(systemReminderAttachmentEntry("output_style_instructions", instructions));
    }
  }
  return attachments;
}

/**
 * 不做 IO 的当前环境：沿用历史里最近一次公告（没有时用启动快照），只换上当前 cwd 与 shell。
 * 输入附件收集在目录未变时用它；context 组成预演一律用它（不重新探测仓库属性）。
 */
export function baselineCurrentEnvironment(
  runtime: AgentRuntimeInternal,
  previous: EnvironmentSnapshot | undefined,
): EnvironmentSnapshot | undefined {
  const initial = runtime.contextSourceSnapshot?.envInfo ?? runtime.config.envInfo;
  const additionalWorkingDirectories = runtime.config.additionalDirectories ?? [];
  const baseline =
    previous ?? (initial ? environmentSnapshot(initial, additionalWorkingDirectories) : undefined);
  if (!baseline) return undefined;
  return {
    ...baseline,
    cwd: runtime.workingDirectory,
    shell: runtime.config.bashShellSelection?.display.name ?? baseline.shell,
    additionalWorkingDirectories: [...additionalWorkingDirectories],
  };
}

async function resolveCurrentEnvironment(
  runtime: AgentRuntimeInternal,
  previous: EnvironmentSnapshot | undefined,
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<EnvironmentSnapshot | undefined> {
  const initial = runtime.contextSourceSnapshot?.envInfo ?? runtime.config.envInfo;
  const additionalWorkingDirectories = runtime.config.additionalDirectories ?? [];
  const baseline =
    previous ?? (initial ? environmentSnapshot(initial, additionalWorkingDirectories) : undefined);
  if (!baseline) return undefined;
  const cwd = runtime.workingDirectory;
  const shell = runtime.config.bashShellSelection?.display.name;
  const port = runtime.contextSourcePort;
  if (cwd === baseline.cwd || !port) {
    const current = baselineCurrentEnvironment(runtime, previous)!;
    if (!runtime.repositoryRecheckPending || !port) return current;
    // 修复原因：目录不变时沿用历史，冷恢复后的新 runtime 就一直报告存储里的"是否仓库"；
    // 会话中途 git init 后冷恢复，环境公告仍写 false。新 runtime 第一次公告重读一次，只取是否仓库，
    // 平台、shell、系统版本仍沿用历史。
    const facts = await port.resolveEnvironment(
      { workingDirectory: cwd, effectiveShellDisplayName: shell, trace },
      { signal },
    );
    throwIfTurnAborted(signal);
    runtime.repositoryRecheckPending = false;
    return { ...current, isGitRepository: isEnvInfoGitRepository(facts) };
  }
  // 新目录的仓库属性必须重新探测，不能沿用起始目录冻结的 envInfo。
  const facts = await port.resolveEnvironment(
    { workingDirectory: cwd, effectiveShellDisplayName: shell, trace },
    { signal },
  );
  throwIfTurnAborted(signal);
  runtime.repositoryRecheckPending = false;
  // cwd/shell 与事实来自同一次读取，公告自洽。IO 期间的变化不重试：
  // 历史是唯一基线，下一次请求比较最新公告与当前状态时再宣告。
  return environmentSnapshot(
    { ...facts, cwd, shell: shell ?? facts.shell },
    additionalWorkingDirectories,
  );
}

/**
 * context builder 加了 Desktop 段（zcode_desktop，且不是 custom system prompt、workflow 子代理、subagent）时，
 * 环境公告带 Desktop 段与会话的 Gen UI 输出目录；否则都不带。
 * 目录按 sessionId 取（默认当前会话）；fork 时传子会话 id，给子会话写入环境更新（buildChildEnvironmentUpdate）。
 * fork 到另一个 cwd 时再传子会话的 workspace 路径（即它的 cwd），目录与子会话自己的公告用同一个键。
 */
function withDesktopContext(
  runtime: AgentRuntimeInternal,
  snapshot: EnvironmentSnapshot,
  sessionId: string = runtime.sessionId,
  workspacePath?: string,
): EnvironmentSnapshot {
  const { visualizationDirectory: _directory, desktopContext: _desktop, ...current } = snapshot;
  if (
    !runtime.latestContextBuildResult?.sections.some(
      (section) => section.source === "desktop_context",
    )
  )
    return current;
  const directory = resolveGenUiOutputDirectory(runtime, sessionId, workspacePath);
  return {
    ...current,
    desktopContext: true,
    ...(directory ? { visualizationDirectory: directory } : {}),
  };
}

/**
 * fork 给子会话写的环境更新：其余事实沿用 previous（子会话恢复后的模型视图里最近一次公告），Desktop 段与
 * Gen UI 目录按 runtime 当前状态重新取，目录用子会话 id；没有变化时返回 undefined。
 * 修复原因：原来整份沿用父会话的事实、只换目录，"是否在 Desktop"也照抄父会话。在终端里分叉来自 Desktop
 * 的会话时，更新仍带整段 Desktop 说明，与子会话实际的运行面不符。现在与普通环境公告共用 withDesktopContext。
 * 修复原因：fork 到受管 worktree 时子会话换了 cwd，原来 cwd 沿用父会话、目录按父会话的 workspace 路径计算。
 * 子会话第一个请求若是新轮通知，模型看到的工作目录是父会话的，可能用绝对路径改动父会话目录里的文件，
 * 而不是 worktree 里的；生成的文件也写进按父会话路径算出的目录，不是子会话自己的目录。
 * 现在传入 childCwd 时 cwd 取它，目录也按它计算。
 */
export function buildChildEnvironmentUpdate(
  runtime: AgentRuntimeInternal,
  previous: EnvironmentSnapshot,
  childSessionId: string,
  hasFullBlock: boolean,
  childCwd?: string,
): RuntimeAttachmentEntry | undefined {
  const child = childCwd ? { ...previous, cwd: childCwd } : previous;
  const announcement = buildEnvironmentAnnouncement(
    withDesktopContext(runtime, child, childSessionId, childCwd),
    previous,
    hasFullBlock,
  );
  return announcement ? environmentAttachment(announcement) : undefined;
}

/**
 * 给定历史里没有 skill 列表、且当前目录不为空时返回完整列表。
 * 输入附件收集对比整段历史，compaction 对比保留段（否则 compact 后第一次请求没有 skill 名单）。
 * 目录变化不在这里宣告，由 refreshRestoredAnnouncements 在加载历史时原位更新。
 */
export function collectSkillsListing(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  contextResult: ContextBuildResult | undefined = runtime.latestContextBuildResult,
): RuntimeAttachmentEntry | undefined {
  const content = currentSkillsListing(contextResult);
  if (!content || lastAnnouncedAttachments(entries).has("skills_listing")) return undefined;
  return systemReminderAttachmentEntry("skills_listing", content);
}

/**
 * 从库加载历史后（冷恢复、rewind），已恢复的 skill 列表按 runtime 当前目录原位更新：
 * 内容不同就在原位置改成当前内容，当前为空就删除。只改内存，库里的记录只决定位置，每次加载都重新套用。
 * 目录只在 runtime 启动时读取，运行中不变；内容变化时之前的请求字节变一次，prompt cache 失效一次。
 * 指令公告（含 Memory 索引）不在这里处理：发出后不改写，变化由请求前公告追加增量。
 */
export function refreshRestoredAnnouncements(runtime: AgentRuntimeInternal): void {
  if (!runtime.latestContextBuildResult) return;
  const current = currentSkillsListing(runtime.latestContextBuildResult);
  const entries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const isStale = (entry: RuntimeMessageEntry) =>
    entry.kind === "attachment" &&
    entry.metadata.source === "skills_listing" &&
    entry.content !== current;
  if (!entries.some(isStale)) return;
  runtime.messageHistory.replaceMessages(
    entries.flatMap((entry) => {
      if (entry.kind !== "attachment" || !isStale(entry)) return [entry];
      return current ? [{ ...entry, content: current }] : [];
    }),
  );
}

function currentSkillsListing(contextResult: ContextBuildResult | undefined): string | undefined {
  return contextResult?.metaUserAttachments.find((item) => item.source === "skills_listing")
    ?.content;
}

export async function appendRuntimeSkillsAnnouncement(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  traceContext: TraceContext,
): Promise<void> {
  const entry = collectSkillsListing(runtime, state.entries);
  await persistAnnouncements(runtime, state, entry ? [entry] : [], traceContext);
}

/**
 * 请求前公告：instructions → session_context → date。
 * 每次模型请求前都运行，不受输入附件的跳过规则影响。
 */
export async function appendRequestAnnouncements(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<void> {
  const sessionContext = await resolveSessionContextAnnouncement(
    runtime,
    state.entries,
    "request",
    traceContext,
    signal,
  );
  await persistAnnouncements(
    runtime,
    state,
    buildRequestAnnouncements(runtime, state.entries, sessionContext),
    traceContext,
  );
}

/**
 * 按给定历史去重后需要宣告的请求前公告。
 * 指令文件（含 Memory 索引）按已公告的文件比较，见 buildInstructionAnnouncement；增量的 reason
 * 取 runtime 状态（启动时 session_start，compaction 提交重读后 compaction）。
 * compact 移除旧公告后按剩余历史重新宣告一次。Git 会话上下文由调用方按同一规则先读好传入。
 */
export function buildRequestAnnouncements(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  sessionContext?: RuntimeAttachmentEntry,
  contextResult: ContextBuildResult | undefined = runtime.latestContextBuildResult,
): RuntimeAttachmentEntry[] {
  const instructions = buildInstructionAnnouncement(
    currentInstructions(contextResult),
    entries,
    runtime.instructionRefreshReason ?? "session_start",
    runtime.unreadableInstructionPaths,
  );
  return [
    ...(instructions ? [instructions] : []),
    ...buildSessionContextAndDate(runtime, entries, sessionContext),
  ];
}

function buildSessionContextAndDate(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  sessionContext?: RuntimeAttachmentEntry,
): RuntimeAttachmentEntry[] {
  const attachments = sessionContext ? [sessionContext] : [];
  const previousDate = lastAnnouncedAttachments(entries).get("date");
  // 日期一律取运行时时钟：context snapshot 的日期在会话起点冻结，跨天 compact 后
  // 剩余历史没有日期公告时，回退到它会先宣告一次过期日期。
  const date = formatLocalIsoDate(runtime.now());
  const initialDate = buildCurrentDateSection(date)!.content;
  const changedDate = buildDateChangeReminderBody(date);
  if (previousDate?.content !== initialDate && previousDate?.content !== changedDate) {
    attachments.push(
      systemReminderAttachmentEntry("date", previousDate ? changedDate : initialDate),
    );
  }
  return attachments;
}

/**
 * compaction 放在 summary 之前的请求前公告：保留段已有的来源不重复，date 也按来源判断。
 * date 不比较内容：保留段里是过期日期时，summary 前若再加一条日期变化，
 * 下一次请求又以保留段里的旧日期为基准追加一条，同一请求出现两次。
 * 指令公告只认完整块：保留段有完整块时不放，内容变化由下一次请求追加增量；保留段没有完整块时
 * （只有增量也算没有）放完整块，内容取 instructionSource（compaction 重读的结果，提交前不交给 runtime）。
 * 修复原因：原来指令公告例外，保留段有完整块且内容变化时在 summary 之前放增量；增量落在保留段之前，
 * 与保留段里的旧公告顺序颠倒，下一次请求以保留段的旧公告为最新，又追加一次同样的增量。
 */
export function buildCompactLeadingAnnouncements(
  runtime: AgentRuntimeInternal,
  keptEntries: readonly RuntimeMessageEntry[],
  sessionContext?: RuntimeAttachmentEntry,
  instructionSource: ContextBuildResult | undefined = runtime.latestContextBuildResult,
): RuntimeAttachmentEntry[] {
  const kept = lastAnnouncedAttachments(keptEntries);
  const current = announcedInstructionFiles(keptEntries)
    ? undefined
    : currentInstructions(instructionSource);
  return [
    ...(current ? [fullInstructionAttachment(current)] : []),
    ...buildSessionContextAndDate(runtime, keptEntries, sessionContext).filter(
      (entry) => !kept.has(entry.metadata.source),
    ),
  ];
}

function currentInstructions(
  result: ContextBuildResult | undefined,
): ContextMetaUserAttachment | undefined {
  return result?.metaUserAttachments.find((item) => item.source === "context_prefix");
}

/**
 * 指令公告（指令文件与 Memory 索引）发出后不改写，变化在末尾追加增量。
 * 已公告的文件只从历史推出：最后一条完整公告，再按顺序套用之后的增量（files 覆盖同路径，removed 删除）。
 * 当前文件来自 runtime 最近一次构建（启动时与 compaction 提交后读取）。历史里没有完整公告时发完整公告；
 * 有变化或新增的文件、或已公告的文件不再存在时，追加一条增量；全部相同时不发。
 * 修复原因：原来冷恢复与 rewind 时把历史里的指令公告原位改成当前内容，已发送的前缀字节改变，
 * prompt cache 失效，也会让 provider 对已绑定前缀的 thinking 签名校验失败。
 */
function buildInstructionAnnouncement(
  current: ContextMetaUserAttachment | undefined,
  entries: readonly RuntimeMessageEntry[],
  reason: InstructionRefreshReason,
  unreadable: ReadonlySet<string> = new Set(),
): RuntimeAttachmentEntry | undefined {
  const announced = announcedInstructionFiles(entries);
  if (!announced) return current ? fullInstructionAttachment(current) : undefined;
  const currentFiles = current?.files ?? [];
  const changed = currentFiles.filter((file) => {
    const previous = announced.get(file.path);
    const record = instructionFileRecord(file);
    return !previous || previous.hash !== record.hash || previous.type !== record.type;
  });
  // 读不出来的文件不算删除，模型保留已宣告的副本。
  const removed = [...announced.keys()].filter(
    (path) => !unreadable.has(path) && !currentFiles.some((file) => file.path === path),
  );
  if (changed.length === 0 && removed.length === 0) return undefined;
  return instructionAttachment(renderInstructionDelta(changed, removed, reason), {
    files: changed.map(instructionFileRecord),
    ...(removed.length > 0 ? { removed } : {}),
    reason,
  });
}

function fullInstructionAttachment(current: ContextMetaUserAttachment): RuntimeAttachmentEntry {
  return instructionAttachment(current.content, {
    files: (current.files ?? []).map(instructionFileRecord),
  });
}

function announcedInstructionFiles(
  entries: readonly RuntimeMessageEntry[],
): Map<string, InstructionAnnouncement["files"][number]> | undefined {
  const records = entries.filter(
    (entry): entry is RuntimeAttachmentEntry =>
      entry.kind === "attachment" && entry.metadata.source === "context_prefix",
  );
  const fullIndex = records.findLastIndex((record) => !record.metadata.instructions?.reason);
  if (fullIndex === -1) return undefined;
  const files = new Map<string, InstructionAnnouncement["files"][number]>();
  for (const record of records.slice(fullIndex)) {
    // 旧记录没有 metadata，只可能是完整公告；按标题行拆出文件。
    const announcement = record.metadata.instructions ?? {
      files: parseLegacyInstructionFiles(record.content),
    };
    for (const file of announcement.files) files.set(file.path, file);
    for (const path of announcement.removed ?? []) files.delete(path);
  }
  return files;
}

function instructionAttachment(
  content: string,
  instructions: InstructionAnnouncement,
): RuntimeAttachmentEntry {
  return {
    ...systemReminderAttachmentEntry("context_prefix", content),
    metadata: { source: "context_prefix", instructions },
  };
}

/**
 * compaction 重述环境、模型与 output style 指令：
 * 保留段已有完整环境块或同类公告时不重复；否则取 compact 前最近一次公告。
 * 历史里没有时不重述，由下一次请求的输入附件收集补上。
 * 最近一次 output style 公告是重置时不重述。
 */
export function restateContextAfterCompact(
  runtime: AgentRuntimeInternal,
  preCompactEntries: readonly RuntimeMessageEntry[],
  keptEntries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry[] {
  return [
    ...(runtime.latestContextBuildResult?.sections.some((section) => section.source === "env_info")
      ? restateEnvironmentAndModel(preCompactEntries, keptEntries)
      : []),
    ...restateOutputStyle(preCompactEntries, keptEntries),
  ];
}

function restateEnvironmentAndModel(
  preCompactEntries: readonly RuntimeMessageEntry[],
  keptEntries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry[] {
  const attachments: RuntimeAttachmentEntry[] = [];
  if (!keptEntries.some((entry) => environmentOf(entry)?.full)) {
    const snapshot = preCompactEntries
      .map(environmentOf)
      .findLast((value) => value !== undefined)?.snapshot;
    const announcement = snapshot ? buildEnvironmentAnnouncement(snapshot, undefined, false) : null;
    if (announcement) attachments.push(environmentAttachment(announcement));
  }
  const latestModel = lastAnnouncedAttachments(preCompactEntries).get("model");
  if (latestModel && !lastAnnouncedAttachments(keptEntries).has("model")) {
    attachments.push(systemReminderAttachmentEntry("model", latestModel.content));
  }
  return attachments;
}

// 已恢复和克隆的条目在 hydrate / clone 时校验过 environment 元数据，这里直接读取。
function environmentOf(entry: RuntimeMessageEntry | undefined) {
  return entry?.kind === "attachment" && entry.metadata.source === "environment"
    ? entry.metadata.environment
    : undefined;
}

/** 历史中最近一次环境公告的快照。 */
export function latestAnnouncedEnvironment(entries: readonly RuntimeMessageEntry[]) {
  return environmentOf(lastAnnouncedAttachments(entries).get("environment"))?.snapshot;
}

function environmentAttachment(
  announcement: NonNullable<ReturnType<typeof buildEnvironmentAnnouncement>>,
): RuntimeAttachmentEntry {
  return {
    ...systemReminderAttachmentEntry("environment", announcement.content),
    metadata: { source: "environment", environment: announcement.environment },
  };
}

function restateOutputStyle(
  preCompactEntries: readonly RuntimeMessageEntry[],
  keptEntries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry[] {
  if (lastAnnouncedAttachments(keptEntries).has("output_style_instructions")) return [];
  const latest = lastAnnouncedAttachments(preCompactEntries).get("output_style_instructions");
  return latest && latest.content !== OUTPUT_STYLE_RESET_REMINDER
    ? [systemReminderAttachmentEntry("output_style_instructions", latest.content)]
    : [];
}

/**
 * Git 会话上下文每个窗口（会话开始或 compaction 之后的历史）只决定一次，只看历史：
 * 已有 Git 公告就沿用，什么都不读（切目录也不重读）。请求前已有 date 公告，说明本窗口的首个请求
 * 决定过（决定后同一批写入 date），也什么都不读：当时没有 Git、之后进入仓库或冷恢复后继续都一样。
 * 否则按当前目录读取 Git，是仓库才宣告；不在仓库时不宣告，并记住该目录（是否在仓库由文件系统查找
 * .git 决定，总是确定的）。compaction 为压缩后的历史决定：保留段已有 Git 公告就沿用，否则读取。
 * 新会话初始化时刚读过 Git，只给第一次判断用一次（目录未变时）；恢复的快照来自存储，不算。
 * 读到的 Git 只进入公告，不改 runtime 的 context 快照。
 * 修复原因：原来按「上一次构建结果里有没有 Git 段」决定是否读取；会话从非仓库目录开始，
 * 或在非仓库目录 compact 一次之后，进入仓库也永远不再宣告 Git。现在进入仓库后，从下一个窗口开始宣告。
 * 修复原因（date 判断）：非仓库窗口没有 Git 公告，"已决定"原来只记在 runtime 内存里；冷恢复后的
 * 新 runtime 又读 Git 并宣告，与环境公告里的 "Is a git repository: false" 矛盾。现在恢复的窗口与 live
 * 一样沿用历史、不读 Git；新 runtime 只在环境公告里报告自己读到的是否仓库。
 */
export async function resolveSessionContextAnnouncement(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  occasion: "request" | "compaction",
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<RuntimeAttachmentEntry | undefined> {
  // 子 agent 与自定义 system prompt 不带 Git（与 context builder 的分支相同）。
  if (runtime.config.subagentContext || runtime.config.systemPrompt?.trim()) return undefined;
  // 预取只服务第一次判断，不论这次历史里有没有 Git；否则很久之后的 compaction 会用到旧快照。
  const prefetched = runtime.sessionStartGitPrefetch === true;
  runtime.sessionStartGitPrefetch = false;
  const last = lastAnnouncedAttachments(entries);
  if (last.has("session_context")) return undefined;
  if (occasion === "request" && last.has("date")) return undefined;
  const directory = runtime.workingDirectory;
  // 本 runtime 已确认不是仓库的目录，之后的窗口不再检查。修复原因：不在仓库时每次判断都要跑一次
  // git 检查，慢文件系统上可能等到 git 命令超时。
  if (runtime.nonGitDirectories?.has(directory)) return undefined;
  const snapshot = runtime.contextSourceSnapshot;
  const port = runtime.contextSourcePort;
  if (!snapshot || !port) {
    // 没有 context port 时，会话起始快照是唯一的 Git 来源。
    return startSnapshotSessionContext(runtime);
  }
  if (prefetched && directory === snapshot.workingDirectory) {
    // 修复原因：起始快照原来分不清"确定不是仓库"与"没读到"，为空时不记住，第二个请求还要再查一次。
    // 现在它来自文件系统查找，说"不是仓库"就是确定结论，同样记住目录。
    if (snapshot.envInfo.isGitRepository === false) rememberNonGitDirectory(runtime, directory);
    return startSnapshotSessionContext(runtime);
  }
  const git = await port.resolveGitContext({ workingDirectory: directory, trace }, { signal });
  throwIfTurnAborted(signal);
  const content = buildGitSystemContextSection({ ...snapshot.envInfo, ...git })?.content;
  if (content) return systemReminderAttachmentEntry("session_context", content);
  if (git.isGitRepository === false) rememberNonGitDirectory(runtime, directory);
  return undefined;
}

/**
 * context 组成预演用的 Git 会话上下文：判断规则同 resolveSessionContextAnnouncement，但不做 IO、
 * 不消费 sessionStartGitPrefetch、不记住非仓库目录；需要读 Git 时一律取启动快照。
 */
export function previewSessionContextAnnouncement(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  contextResult: ContextBuildResult | undefined,
): RuntimeAttachmentEntry | undefined {
  if (runtime.config.subagentContext || runtime.config.systemPrompt?.trim()) return undefined;
  const last = lastAnnouncedAttachments(entries);
  if (last.has("session_context") || last.has("date")) return undefined;
  if (runtime.nonGitDirectories?.has(runtime.workingDirectory)) return undefined;
  const content = contextResult?.metaUserAttachments.find(
    (item) => item.source === "session_context",
  )?.content;
  return content ? systemReminderAttachmentEntry("session_context", content) : undefined;
}

function rememberNonGitDirectory(runtime: AgentRuntimeInternal, directory: string): void {
  (runtime.nonGitDirectories ??= new Set()).add(directory);
}

function startSnapshotSessionContext(
  runtime: AgentRuntimeInternal,
): RuntimeAttachmentEntry | undefined {
  const content = runtime.latestContextBuildResult?.metaUserAttachments.find(
    (item) => item.source === "session_context",
  )?.content;
  return content ? systemReminderAttachmentEntry("session_context", content) : undefined;
}

function lastAnnouncedAttachments(
  entries: readonly RuntimeMessageEntry[],
): Map<string, RuntimeAttachmentEntry> {
  const last = new Map<string, RuntimeAttachmentEntry>();
  for (const entry of entries) {
    if (entry.kind === "attachment") last.set(entry.metadata.source, entry);
  }
  return last;
}

export async function persistAnnouncements(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  attachments: readonly RuntimeAttachmentEntry[],
  traceContext: TraceContext,
  model?: Model,
): Promise<void> {
  for (const entry of attachments) {
    // 持久化成功才算已宣告；同一历史同时负责恢复、去重和 provider 投影。
    // 与 ToolSearch 公告、compaction 附件同一种隐藏提醒记录：不写顶层 source，
    // 旧版本 App 按封闭列表校验该字段，新值会让它拒绝整个会话。
    // 隐藏提醒不是对话消息，不移动对话指针（compaction 覆盖边界、timeline 锚点读它）。
    await persistRuntimeReminderMessage.call(runtime, entry, traceContext, {
      model,
      anchor: buildProjectionAnchor(traceContext, "synthetic"),
    });
    commitTurnRequestEntries(runtime, state, [entry]);
  }
}
