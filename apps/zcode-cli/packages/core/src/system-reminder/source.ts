export type SystemReminderDeliveryChannel =
  | "current_turn"
  | "tool_result"
  | "history_continuity"
  | "mid_turn_event"
  | "real_user";

export type SystemReminderLifecycle =
  | "per_current_turn"
  | "runtime_local"
  | "tool_result"
  | "resume_history"
  | "mid_turn_event"
  | "real_user";

export type SystemReminderProviderVisibility = "provider_visible" | "provider_hidden";

export const SYSTEM_REMINDER_PERSISTED_SOURCES = [
  "context_prefix",
  "session_context",
  "environment",
  "model",
  "output_style_instructions",
  "date",
  "skills_listing",
  "gen_ui_state",
  "tool_search_announcement",
  "agent_listing_delta",
  "todo_reminder",
  "silent_turn_reminder",
  "total_tokens_reminder",
  "read_truncation_notice",
  "tool_hook_context",
  "hook_context",
  "task_status",
  "tool_result_warning",
  "resume_referenced_session_context",
  "plan_file_reference",
  "resume_goal_state",
  "goal_state_change",
  "plugin_reference",
  "bot_topic_context",
  "target_continuation",
  "goal_completion_verification",
  "rewind_notice",
  "conversation_fork",
  "selection_side_chat",
  "queued_system_notification",
] as const;

export const SYSTEM_REMINDER_PER_REQUEST_SOURCES = [
  "incoming_message",
  "memory_update",
  "relevant_memory",
  "runtime_mode",
  "plan_mode_exit",
  "output_style",
  "referenced_session_context",
  "model_anomaly",
  "prompt_attachment",
  "diagnostics",
] as const;

export type SystemReminderPersistedSource = (typeof SYSTEM_REMINDER_PERSISTED_SOURCES)[number];
export type SystemReminderPerRequestSource = (typeof SYSTEM_REMINDER_PER_REQUEST_SOURCES)[number];

export type SystemReminderSource = SystemReminderPersistedSource | SystemReminderPerRequestSource;

export interface SystemReminderSourceDescriptor {
  source: SystemReminderSource;
  channel: SystemReminderDeliveryChannel;
  lifecycle: SystemReminderLifecycle;
  isMeta: boolean;
  providerVisibility: SystemReminderProviderVisibility;
  evidenceLabel: string;
}

type DescriptorShape = Omit<SystemReminderSourceDescriptor, "source">;

const SYSTEM_REMINDER_TAG_PATTERN = /<\/?system-reminder\b/i;
const SYSTEM_REMINDER_NESTED_TAG_PATTERN = /<\/?system-reminder\b/gi;
const NON_MID_CONVERSATION_SYSTEM_SOURCES = new Set<SystemReminderSource>([
  // 页面状态是不可信数据，必须留在 user 侧 untrusted 包装里，不能升为 system。
  // 它在投影排序结束后才派生，到不了 MCS 合并；这里是防御性登记，顺序由派生步骤保证。
  "gen_ui_state",
  "session_context",
  "context_prefix",
  // Fork 和辅助对话边界必须位于新问题之前；走 MCS 会被移到问题之后，改变上下文顺序。
  "conversation_fork",
  "selection_side_chat",
  "target_continuation",
  "tool_result_warning",
  "goal_completion_verification",
]);

const SYSTEM_REMINDER_DESCRIPTORS: Record<SystemReminderSource, DescriptorShape> = {
  gen_ui_state: descriptor("current_turn", "resume_history", true, "sr.gen_ui_state"),
  tool_search_announcement: descriptor(
    "current_turn",
    "resume_history",
    true,
    "sr.tool_search_announcement",
  ),
  session_context: descriptor("current_turn", "resume_history", true, "sr.session_context"),
  environment: descriptor("current_turn", "resume_history", true, "sr.environment"),
  model: descriptor("current_turn", "resume_history", true, "sr.model"),
  // output style 指令：内容变化时宣告一次，清除时宣告重置；compaction 后按最近一次重述。
  output_style_instructions: descriptor(
    "current_turn",
    "resume_history",
    true,
    "sr.output_style_instructions",
  ),
  date: descriptor("current_turn", "resume_history", true, "sr.date"),
  agent_listing_delta: descriptor("current_turn", "resume_history", true, "sr.agent_listing_delta"),
  incoming_message: descriptor("mid_turn_event", "mid_turn_event", true, "sr.incoming_message"),
  bot_topic_context: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.bot_topic_context",
  ),
  context_prefix: descriptor("current_turn", "resume_history", true, "sr.context_prefix"),
  skills_listing: descriptor("current_turn", "resume_history", true, "sr.skills_listing"),
  // 生命周期 Hook（SessionStart / UserPromptSubmit / Stop）的附加上下文：先写库再进历史，冷恢复原样回放。
  // 修复原因：以前只写内存，冷恢复后丢失，provider 请求前缀改变、缓存失效。
  hook_context: descriptor("current_turn", "resume_history", true, "sr.hook_context"),
  memory_update: descriptor("current_turn", "per_current_turn", true, "sr.memory_update"),
  relevant_memory: descriptor("current_turn", "per_current_turn", true, "sr.relevant_memory"),
  runtime_mode: descriptor("current_turn", "per_current_turn", true, "sr.runtime_mode"),
  plan_mode_exit: descriptor("current_turn", "runtime_local", true, "sr.plan_mode_exit"),
  output_style: descriptor("current_turn", "per_current_turn", true, "sr.output_style"),
  referenced_session_context: descriptor(
    "current_turn",
    "per_current_turn",
    true,
    "sr.referenced_session_context",
  ),
  // Plugin 对话引用：当轮生成后按
  // model-only synthetic notice 固化，后续只追加、不改写；冷恢复按原文重建以保持缓存前缀。
  plugin_reference: descriptor("current_turn", "per_current_turn", true, "sr.plugin_reference"),
  todo_reminder: descriptor("current_turn", "per_current_turn", true, "sr.todo_reminder"),
  silent_turn_reminder: descriptor(
    "current_turn",
    "resume_history",
    true,
    "sr.silent_turn_reminder",
  ),
  // token 预算倒数：收集时写库再提交，后续请求只追加；冷恢复按原文回放。
  total_tokens_reminder: descriptor(
    "current_turn",
    "resume_history",
    true,
    "sr.total_tokens_reminder",
  ),
  // Read 部分视图提示：紧跟在该批 tool result 之后，和工具批次之后的其他附件一样投影。
  read_truncation_notice: descriptor(
    "current_turn",
    "resume_history",
    true,
    "sr.read_truncation_notice",
  ),
  // 工具 Hook 的附加上下文：与 Read 部分视图提示同一批次通道，排在这批 tool result 之后、提示之前。
  tool_hook_context: descriptor("current_turn", "resume_history", true, "sr.tool_hook_context"),
  task_status: descriptor("mid_turn_event", "mid_turn_event", true, "sr.task_status"),
  // 只用于 Read 等 tool result 内容内联 warning，不作为 synthetic user notice 持久化。
  tool_result_warning: descriptor("tool_result", "tool_result", true, "sr.tool_result_warning"),
  // compaction 附件（文件恢复、plan 文件）与 runtime_mode/environment/model 一样参与冒泡，
  // 附件之间保持生成顺序；MCS 下合成同一条 system。
  // 修复原因：两者是 history_continuity 时不冒泡，文件恢复留在 user 侧；
  // 冒泡的 runtime_mode/environment/model 会越过它们，compaction 附件顺序与生成顺序不同。
  resume_referenced_session_context: descriptor(
    "current_turn",
    "resume_history",
    true,
    "sr.resume_referenced_session_context",
  ),
  plan_file_reference: descriptor("current_turn", "resume_history", true, "sr.plan_file_reference"),
  resume_goal_state: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.resume_goal_state",
  ),
  goal_state_change: descriptor("mid_turn_event", "mid_turn_event", true, "sr.goal_state_change"),
  target_continuation: descriptor("real_user", "real_user", false, "sr.target_continuation"),
  goal_completion_verification: descriptor(
    "tool_result",
    "tool_result",
    true,
    "sr.goal_completion_verification",
  ),
  model_anomaly: descriptor("mid_turn_event", "mid_turn_event", true, "sr.model_anomaly"),
  rewind_notice: descriptor("history_continuity", "resume_history", true, "sr.rewind_notice"),
  conversation_fork: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.conversation_fork",
  ),
  selection_side_chat: descriptor(
    "history_continuity",
    "resume_history",
    true,
    "sr.selection_side_chat",
  ),
  prompt_attachment: descriptor("current_turn", "per_current_turn", true, "sr.prompt_attachment"),
  queued_system_notification: descriptor(
    "mid_turn_event",
    "mid_turn_event",
    true,
    "sr.queued_system_notification",
  ),
  diagnostics: descriptor("mid_turn_event", "mid_turn_event", true, "sr.diagnostics"),
  // 第四批 4a-0（2026-09-12）：原 plugin_ui_state 源已删除，插件给模型的信息改走 ui/update-model-context。
};

export const SYSTEM_REMINDER_SOURCES = Object.freeze([
  ...SYSTEM_REMINDER_PERSISTED_SOURCES,
  ...SYSTEM_REMINDER_PER_REQUEST_SOURCES,
]);

const MID_CONVERSATION_SYSTEM_SOURCES = new Set<SystemReminderSource>(
  SYSTEM_REMINDER_SOURCES.filter((source) => !NON_MID_CONVERSATION_SYSTEM_SOURCES.has(source)),
);

export function getSystemReminderDescriptor(
  source: SystemReminderSource,
): SystemReminderSourceDescriptor {
  const descriptor = SYSTEM_REMINDER_DESCRIPTORS[source];
  return {
    source,
    ...descriptor,
  };
}

export function isSystemReminderMetaSource(source: SystemReminderSource): boolean {
  return getSystemReminderDescriptor(source).isMeta;
}

export function isMidConversationSystemSource(source: SystemReminderSource): boolean {
  return MID_CONVERSATION_SYSTEM_SOURCES.has(source);
}

export function wrapSystemReminderForSource(
  source: SystemReminderSource,
  body: string | readonly string[],
): string {
  const sourceDescriptor = getSystemReminderDescriptor(source);
  if (sourceDescriptor.providerVisibility !== "provider_visible") {
    throw new Error(`System reminder source ${source} is not provider-visible`);
  }
  return wrapSystemReminder(sanitizeSystemReminderBody(body));
}

export function wrapSystemReminder(body: string | readonly string[]): string {
  const content = typeof body === "string" ? body : body.join("\n");
  if (content.length === 0) {
    throw new Error("System reminder body cannot be empty");
  }
  if (SYSTEM_REMINDER_TAG_PATTERN.test(content)) {
    throw new Error("System reminder body must not include nested system-reminder tags");
  }
  return ["<system-reminder>", content, "</system-reminder>"].join("\n");
}

export function sanitizeSystemReminderBody(body: string | readonly string[]): string {
  return escapeNestedSystemReminderTags(body);
}

function descriptor(
  channel: SystemReminderDeliveryChannel,
  lifecycle: SystemReminderLifecycle,
  isMeta: boolean,
  evidenceLabel: string,
): DescriptorShape {
  return {
    channel,
    lifecycle,
    isMeta,
    providerVisibility: "provider_visible",
    evidenceLabel,
  };
}

function escapeNestedSystemReminderTags(body: string | readonly string[]): string {
  const content = typeof body === "string" ? body : body.join("\n");
  // 与 wrapper 的拒绝规则一致，含空格/大小写变体的关闭标签也只中和起始 <。
  return content.replace(SYSTEM_REMINDER_NESTED_TAG_PATTERN, (tag) => `&lt;${tag.slice(1)}`);
}
