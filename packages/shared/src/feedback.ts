import type { Locale } from "./protocol.js";
export type FeedbackTicketType = "bug" | "usage" | "feature" | "performance";

export type FeedbackTicketStatus =
  | "已提交"
  | "信息不足"
  | "已采纳"
  | "答复关闭"
  | "已归档"
  | "已拒绝"
  | "开发中"
  | "已解决"
  | "已上线";

export type FeedbackAttachmentKind = "log" | "image" | "other";

export type FeedbackTicketModule =
  | "Plugin / MCP"
  | "Agent任务执行失败"
  | "模型配置 / API Key"
  | "模型调用报错"
  | "权限 / 配置保存"
  | "SSH连接失败"
  | "WSL连接失败"
  | "UI布局 / 交互"
  | "模型响应慢 / 额度"
  | "崩溃 / Internal Error"
  | "文档 / 使用咨询"
  | "其它";

export type FeedbackTicketFramework = "zcode-agent";

/**
 * UI 层 Select 不允许空字符串作为可选项 value（Radix 会抛错），
 * 这里给『未指定』提供一个 sentinel；提交工单前会被转换成 undefined。
 */
export const FEEDBACK_FRAMEWORK_NONE = "none" as const;
export type FeedbackTicketFrameworkSelectValue =
  | FeedbackTicketFramework
  | typeof FEEDBACK_FRAMEWORK_NONE;

export type FeedbackTicketSeverity = "P1-高" | "P2-中" | "P3-低";

export interface FeedbackReporter {
  user_id?: string;
  username?: string;
  display_name?: string;
}

export interface FeedbackDeviceInfo {
  appVersion?: string;
  buildCommitId?: string;
  buildTime?: string;
  electronVersion?: string;
  nodeVersion?: string;
  osType?: string;
  osPlatform?: string;
  osRelease?: string;
  osVersion?: string;
  osArch?: string;
  /** 提交反馈时的当前 Agent。单 ZCode Agent 模式下固定为 ZCode Agent。 */
  agentProvider?: string;
  /** 提交反馈时归一到反馈平台的框架标识，当前固定为 zcode-agent。 */
  agentFramework?: FeedbackTicketFramework;
  /** 提交反馈时当前模型配置里的原始选中值。 */
  agentModel?: string;
  /** 提交反馈时从模型列表匹配到的展示名；没有时回退到 agentModel。 */
  agentModelDisplay?: string;
  /** 提交反馈时当前模型列表的可选项数量。 */
  agentModelOptionCount?: number;
  /** 提交反馈时当前模型列表的展示名预览，用于排查配置上下文。 */
  agentModelOptionsPreview?: string[];
  hostname?: string;
  deviceMid?: string;
}

export interface CreateFeedbackTicketInput {
  title: string;
  description: string;
  type: FeedbackTicketType;
  severity?: FeedbackTicketSeverity;
  module?: FeedbackTicketModule;
  framework?: FeedbackTicketFramework;
  source?: string;
  reporter?: FeedbackReporter;
  device?: FeedbackDeviceInfo;
  /** 用户选填的联系方式（邮箱或其他社交账号），后端不强制要求。 */
  contact?: string;
  /** 当前界面语言，仅用于请求头透传，不写入后端工单正文。 */
  locale?: Locale;
}

export interface FeedbackTicketSummary {
  id: string;
  title: string;
  type: FeedbackTicketType;
  severity?: FeedbackTicketSeverity;
  module?: FeedbackTicketModule;
  status: FeedbackTicketStatus;
  assignee_id?: string | null;
  /** 当前处理人的展示名（由后端填充）；未指派为 null */
  assignee_display?: string | null;
  /** 后端返回的报告人展示名 */
  reporter_display?: string | null;
  /** 自上次查看以来是否有新动作 */
  unread?: boolean;
  /** 最近一次用户动作时间 */
  last_user_activity_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type FeedbackTicketEventType =
  | "created"
  | "status_changed"
  | "assignee_changed"
  | "staff_replied"
  | "user_replied";

export interface FeedbackTicketEvent {
  id: number;
  type: FeedbackTicketEventType;
  summary: string;
  actor_display_name?: string | null;
  payload?: Record<string, unknown> | null;
  created_at: string;
}

export interface FeedbackAttachment {
  id: number;
  kind: FeedbackAttachmentKind;
  filename: string;
  size: number;
  sha256?: string | null;
  redacted: boolean;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
  created_at: string;
}

export interface FeedbackCommentAttachment {
  id: number;
  filename: string;
  size: number;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
}

export interface FeedbackComment {
  id: number;
  /** 后端 message_id，用于补充消息创建后继续把附件绑定到该 message。 */
  message_id?: string;
  author_user_id?: string | null;
  author_display_name?: string | null;
  body: string;
  attachments?: FeedbackCommentAttachment[];
  is_staff: boolean;
  created_at: string;
}

export interface FeedbackTicketDetail extends FeedbackTicketSummary {
  description: string;
  framework?: FeedbackTicketFramework;
  reporter?: FeedbackReporter | null;
  device?: FeedbackDeviceInfo | null;
  attachments: FeedbackAttachment[];
  comments: FeedbackComment[];
  events: FeedbackTicketEvent[];
  lark_record_id?: string | null;
}

export interface FeedbackListQuery {
  mine?: boolean;
  status?: FeedbackTicketStatus;
  type?: FeedbackTicketType;
  offset?: number;
  limit?: number;
}

export interface FeedbackListResult {
  items: FeedbackTicketSummary[];
  total: number;
}

export const FEEDBACK_TICKET_MODULES: FeedbackTicketModule[] = [
  "Plugin / MCP",
  "Agent任务执行失败",
  "模型配置 / API Key",
  "模型调用报错",
  "权限 / 配置保存",
  "SSH连接失败",
  "WSL连接失败",
  "UI布局 / 交互",
  "模型响应慢 / 额度",
  "崩溃 / Internal Error",
  "文档 / 使用咨询",
  "其它",
];

export const FEEDBACK_TICKET_TYPES: { value: FeedbackTicketType; label: string }[] = [
  { value: "bug", label: "Bug 反馈" },
  { value: "usage", label: "使用问题" },
  { value: "feature", label: "功能建议" },
  { value: "performance", label: "性能问题" },
];

export const FEEDBACK_TICKET_SEVERITIES: FeedbackTicketSeverity[] = ["P1-高", "P2-中", "P3-低"];

export const DEFAULT_FEEDBACK_TICKET_FRAMEWORK: FeedbackTicketFramework = "zcode-agent";

export const FEEDBACK_TICKET_FRAMEWORK_OPTIONS: {
  value: FeedbackTicketFramework;
  label: string;
}[] = [{ value: "zcode-agent", label: "ZCode Agent" }];

/** 含「未指定」的完整列表，供管理端等场景使用。 */
export const FEEDBACK_TICKET_FRAMEWORKS: {
  value: FeedbackTicketFrameworkSelectValue;
  label: string;
}[] = [{ value: FEEDBACK_FRAMEWORK_NONE, label: "未指定" }, ...FEEDBACK_TICKET_FRAMEWORK_OPTIONS];
