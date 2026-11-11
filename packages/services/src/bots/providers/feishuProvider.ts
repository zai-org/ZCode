import { getUnavailableReplyFallback } from "#src/bots/groupReply.js";
import {
  createGroupMemberDirectory,
  type GroupMemberPage,
} from "#src/bots/providers/groupMemberDirectory.js";
import { channelContentPartsSchema, channelContentText, botGroupCardSchema } from "@zcode/shared";
import {
  isFeishuBotSender,
  isGroupControlCard,
  readGroupConversationCardText,
  readGroupCardText,
  readGroupMessage,
  readGroupMentionText,
} from "#src/bots/providers/feishuGroupMessages.js";
/* eslint-disable max-lines -- Feishu provider 集中承载鉴权、消息解析、卡片发送和 reaction typing 适配，后续按能力拆分。 */
import { botTopicMessageSchema } from "@zcode/shared";
import { readTopicHistory, TopicHistoryPermissionError } from "#src/bots/topicHistory.js";
import type {
  BotInboundAttachment,
  BotConfig,
  BotInboundMessage,
  BotOutboundMessage,
  BotProvider,
  SelectionPrompt,
} from "@zcode/shared";
import type {
  BotProviderAdapter,
  BotStreamingReplyCardHandle,
  BotStreamingReplyCardState,
  BotTransientInteractionCardHandle,
} from "./types.js";
import { formatBotMessage } from "../messages.js";
import { fetchBotProviderJson } from "#src/bots/providers/providerRequest.js";
import { createGroupInputReactionUpdater } from "#src/bots/providers/groupInputReaction.js";

interface FeishuProviderDeps {
  loadCredential(key: string): Promise<string | null>;
  onDeliveryResult?(bot: BotConfig, error: string | undefined): void;
}

export interface FeishuWebSocketClient {
  close(): void;
  /** SDK 自动重连耗尽后的终态；旧测试替身可不提供。 */
  terminated?: Promise<void>;
}

const FEISHU_APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;
const FEISHU_WEBSOCKET_START_TIMEOUT_MS = 20_000;
const FEISHU_WEBSOCKET_READY_POLL_MS = 100;
// 修复原因：飞书 Card JSON 2.0 最多允许 200 个组件或元素。预留 20 个元素给
// 状态行和服务端计数差异，避免长任务在更新阶段被 11310 拒绝后整轮熔断。
export const FEISHU_STREAMING_CARD_TAGGED_ELEMENT_BUDGET = 180;
const WEBSOCKET_OPEN_READY_STATE = 1;

interface FeishuAccessTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface FeishuSendMessageResponse {
  code?: number;
  msg?: string;
  error?: {
    log_id?: string;
  };
  data?: {
    message_id?: string;
  };
}

interface FeishuReactionResponse {
  code?: number;
  msg?: string;
  data?: {
    reaction_id?: string;
  };
}

const FEISHU_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;

interface FeishuAppInfoResponse {
  code?: number;
  msg?: string;
  data?: {
    app?: {
      app_name?: string;
      primary_language?: string;
      i18n?: Array<{
        i18n_key?: string;
        name?: string;
      }>;
    };
  };
}

interface FeishuUserInfoResponse {
  code?: number;
  msg?: string;
  data?: {
    user?: {
      name?: string;
      en_name?: string;
      nickname?: string;
    };
  };
}

const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();
const typingReactionIds = new Map<string, string>();
const userDisplayNameCache = new Map<string, { name: string | null; expiresAt: number }>();
const FEISHU_ELICITATION_FORM_FIELD_NAME = "answer";
const FEISHU_ELICITATION_FORM_VALUE_PREFIX = "__form__:";
const FEISHU_ELICITATION_CUSTOM_OPTION_ID = "__custom__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPlanApprovalContent(message: BotOutboundMessage): string | null {
  const schema = message.elicitation?.schema;
  if (!isRecord(schema) || schema.interaction !== "plan_approval") {
    return null;
  }
  return typeof schema.plan === "string" && schema.plan.trim() ? schema.plan.trim() : null;
}

function formatSelectionCommand(selection: SelectionPrompt, optionId: string): string {
  if (selection.action === "permission.respond" || selection.action === "queue.cancel") {
    return optionId;
  }
  if (selection.action === "elicitation.respond") {
    return selection.token
      ? `/elicitation ${selection.token} ${optionId}`
      : `/elicitation ${optionId}`;
  }
  if (selection.action === "model.provider.set") {
    return `/model provider ${optionId}`;
  }
  if (selection.action === "model.set") {
    return `/model model ${optionId}`;
  }
  return `/${selection.action.replace(".set", "")} ${optionId}`;
}

function readElicitationAnswerValues(message: BotOutboundMessage, questionIndex: number): string[] {
  return message.elicitation?.answers?.[String(questionIndex)] ?? [];
}

function formatElicitationAnswerLabel(message: BotOutboundMessage, questionIndex: number): string {
  const question = message.elicitation?.questions[questionIndex];
  const values = readElicitationAnswerValues(message, questionIndex);
  if (!question || values.length === 0) {
    return "";
  }
  const labels = values.map((value) => {
    const option = question.options.find((item) => item.value === value);
    return option?.label ?? value;
  });
  return labels.join(", ");
}

function formatFeishuPlainText(content: string): Record<string, string> {
  return { tag: "plain_text", content };
}

function buildFeishuElicitationFormCommand(token: string, value?: unknown): string {
  const suffix =
    value === undefined
      ? FEISHU_ELICITATION_FORM_VALUE_PREFIX
      : `${FEISHU_ELICITATION_FORM_VALUE_PREFIX}${encodeURIComponent(JSON.stringify(value))}`;
  return `/elicitation ${token} ${suffix}`;
}

function readFeishuElicitationCustomValues(
  message: BotOutboundMessage,
  question: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number],
  questionIndex: number,
): string[] {
  const optionValues = new Set(question.options.map((option) => option.value));
  return readElicitationAnswerValues(message, questionIndex).filter(
    (value) => !optionValues.has(value),
  );
}

function buildFeishuElicitationChoiceButton(params: {
  message: BotOutboundMessage;
  question: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number];
  option: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number]["options"][number];
  selectedValues: readonly string[];
}): Record<string, unknown> {
  const selected = params.selectedValues.includes(params.option.value);
  const marker = params.question.multiSelect ? (selected ? "☑" : "☐") : selected ? "●" : "○";
  return buildFeishuButtonElement({
    text: `${marker} ${params.option.label}`,
    type: selected ? "primary" : "default",
    command: buildFeishuElicitationOptionCommand(params.message, params.option.value),
    originalText: params.message.text,
  });
}

function buildFeishuElicitationOptionCommand(
  message: BotOutboundMessage,
  optionId: string,
): string {
  const token = message.selection?.token;
  return token
    ? formatSelectionCommand(
        {
          id: message.selection?.id ?? "",
          token,
          title: message.selection?.title ?? message.text,
          action: "elicitation.respond",
          options: [],
        },
        optionId,
      )
    : optionId;
}

function isFeishuElicitationCustomExpanded(
  message: BotOutboundMessage,
  questionIndex: number,
): boolean {
  return message.elicitation?.expandedCustomAnswerQuestionIndexes?.includes(questionIndex) ?? false;
}

function buildFeishuElicitationCustomButton(
  message: BotOutboundMessage,
  question: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number],
  questionIndex: number,
): Record<string, unknown> {
  const customValues = readFeishuElicitationCustomValues(message, question, questionIndex);
  const expanded = isFeishuElicitationCustomExpanded(message, questionIndex);
  const selected = expanded || customValues.length > 0;
  const marker = question.multiSelect ? (selected ? "☑" : "☐") : selected ? "●" : "○";
  const customLabel = formatBotMessage(message.locale, "elicitationCustomOption");
  return buildFeishuButtonElement({
    text: `${marker} ${customLabel}`,
    type: selected ? "primary" : "default",
    command: buildFeishuElicitationOptionCommand(message, FEISHU_ELICITATION_CUSTOM_OPTION_ID),
    originalText: message.text,
  });
}

function buildFeishuElicitationForm(
  message: BotOutboundMessage,
  question: NonNullable<BotOutboundMessage["elicitation"]>["questions"][number],
  questionIndex: number,
): Record<string, unknown> | null {
  const selection = message.selection;
  if (!selection?.token) {
    return null;
  }
  const customExpanded = isFeishuElicitationCustomExpanded(message, questionIndex);
  const shouldShowInput = question.options.length === 0 || customExpanded;
  const shouldShowSubmit = question.multiSelect || shouldShowInput;
  if (!shouldShowSubmit) {
    return null;
  }
  const customValues = readFeishuElicitationCustomValues(message, question, questionIndex);
  const formElements: Array<Record<string, unknown>> = [];
  if (shouldShowInput) {
    formElements.push({
      tag: "input",
      name: FEISHU_ELICITATION_FORM_FIELD_NAME,
      required: question.options.length === 0,
      width: "fill",
      input_type: "multiline_text",
      rows: 2,
      auto_resize: true,
      max_rows: 5,
      placeholder: formatFeishuPlainText(
        formatBotMessage(message.locale, "elicitationCustomPlaceholder"),
      ),
      default_value: customValues.join(", "),
    });
  }
  formElements.push({
    tag: "button",
    text: formatFeishuPlainText(formatBotMessage(message.locale, "elicitationSubmitOption")),
    type: "primary",
    form_action_type: "submit",
    name: "submit",
    behaviors: [
      {
        type: "callback",
        value: {
          command: buildFeishuElicitationFormCommand(selection.token),
          zcodeCardText: message.text,
        },
      },
    ],
  });
  return {
    tag: "form",
    name: `elicitation_form_${questionIndex}`,
    direction: "vertical",
    vertical_spacing: "8px",
    elements: formElements,
  };
}

function buildFeishuElicitationAnswerElements(
  message: BotOutboundMessage,
): Array<Record<string, unknown>> {
  const elicitation = message.elicitation;
  if (!elicitation) {
    return [];
  }
  const total = elicitation.questions.length;
  const isCompleted = elicitation.status === "completed" || elicitation.status === "cancelled";
  const elements: Array<Record<string, unknown>> = [];
  elicitation.questions.forEach((question, index) => {
    // 修复原因：当前题的多选值只是尚未提交的草稿。如果也放进上方历史区，
    // 同一问题会同时显示为“已回答”和“待回答”。进行中只累积此前已提交的题目。
    if (!isCompleted && index >= elicitation.currentQuestionIndex) {
      return;
    }
    const answer = formatElicitationAnswerLabel(message, index);
    if (!answer) {
      return;
    }
    elements.push(
      {
        tag: "markdown",
        content: formatFeishuCardMarkdownContent(`#### ${index + 1}/${total} ${question.question}`),
      },
      {
        tag: "markdown",
        content: formatFeishuCardMarkdownContent(answer),
      },
    );
  });
  return elements;
}

function addGroupCardContext(
  card: Record<string, unknown>,
  message: BotOutboundMessage,
): Record<string, unknown> {
  const bodyMentions = new Set(
    message.contentParts?.flatMap((part) =>
      part.type === "channelMention" ? [part.targetId] : [],
    ) ?? [],
  );
  if (message.contentParts && isRecord(card.body)) {
    card.body.elements = [
      {
        tag: "markdown",
        content: message.contentParts
          .map((part) =>
            part.type === "channelMention"
              ? `<at id=${part.targetId}></at>`
              : part.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
          )
          .join(""),
      },
    ];
  }
  // 只接受服务注入的个人 ID，不把正文/姓名解析成提醒，也不允许 all 扩大通知范围。
  const ids = [...new Set(message.mentionedUserIds ?? [])].filter(
    (id) => /^ou_[a-zA-Z0-9_-]+$/u.test(id) && !bodyMentions.has(id),
  );
  if (
    message.providerUserId.startsWith("oc_") &&
    ids.length &&
    isRecord(card.body) &&
    Array.isArray(card.body.elements)
  ) {
    card.body.elements.unshift({
      tag: "markdown",
      content: ids.map((id) => `<at id=${id}></at>`).join(" "),
    });
  }
  if (!message.groupCard) return card;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isRecord(node)) return;
    if (isRecord(node.value) && typeof node.value.command === "string")
      node.value = { ...node.value, groupCard: message.groupCard };
    for (const value of Object.values(node)) visit(value);
  };
  visit(card);
  return card;
}
function buildFeishuElicitationCardPayload(message: BotOutboundMessage): Record<string, unknown> {
  return addGroupCardContext(buildFeishuElicitationCardPayloadBody(message), message);
}
function buildFeishuInteractiveCardPayload(message: BotOutboundMessage): Record<string, unknown> {
  return addGroupCardContext(buildFeishuInteractiveCardPayloadBody(message), message);
}

function buildFeishuElicitationCardPayloadBody(
  message: BotOutboundMessage,
): Record<string, unknown> {
  const elicitation = message.elicitation;
  const selection = message.selection;
  if (!elicitation) {
    return buildFeishuInteractiveCardPayloadBody(message);
  }
  const currentQuestion =
    elicitation.questions[elicitation.currentQuestionIndex] ?? elicitation.questions[0];
  const isCompleted = elicitation.status === "completed" || elicitation.status === "cancelled";
  const answerElements = buildFeishuElicitationAnswerElements(message);
  const planApprovalContent = readPlanApprovalContent(message);
  const elements: Array<Record<string, unknown>> = [];
  if (isCompleted && planApprovalContent) {
    // 修复原因：Plan 交互完成后保留卡片时，旧终态分支只渲染审批答案，导致计划正文消失。
    // 只读终态仍需保留完整计划，用户才能在聊天历史中回看自己批准或取消的内容。
    elements.push({
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(planApprovalContent),
    });
    if (answerElements.length > 0) {
      elements.push({ tag: "hr" });
    }
  }
  elements.push(...answerElements);
  if (!isCompleted && currentQuestion) {
    if (answerElements.length > 0) {
      elements.push({ tag: "hr" });
    }
    if (!planApprovalContent) {
      elements.push({
        tag: "markdown",
        content: formatFeishuCardMarkdownContent(
          `#### ${formatBotMessage(message.locale, "elicitationQuestionTitle")}`,
        ),
      });
    }
    // 修复原因：ExitPlanMode 不是普通问答。计划正文若只留在流式消息中，审批卡会失去上下文；
    // 因此计划审批使用专属正文，而 AskUserQuestion 继续沿用通用“提问”结构。
    const contentParts = planApprovalContent
      ? [planApprovalContent]
      : [
          currentQuestion.header && currentQuestion.header !== currentQuestion.question
            ? `**${currentQuestion.header}**`
            : null,
          currentQuestion.question,
        ];
    elements.push({
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(
        contentParts
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("\n\n"),
      ),
    });
    if (planApprovalContent) {
      elements.push(
        { tag: "hr" },
        {
          tag: "markdown",
          content: formatFeishuCardMarkdownContent(
            `**${formatBotMessage(message.locale, "planApprovalTitle")}**`,
          ),
        },
      );
    }
    const selectedValues = readElicitationAnswerValues(message, elicitation.currentQuestionIndex);
    for (const option of currentQuestion.options) {
      const displayOption = planApprovalContent
        ? {
            ...option,
            label: formatBotMessage(message.locale, "planApprovalApprove"),
            description: formatBotMessage(message.locale, "planApprovalApproveDescription"),
          }
        : option;
      elements.push(
        buildFeishuElicitationChoiceButton({
          message,
          question: currentQuestion,
          option: displayOption,
          selectedValues,
        }),
      );
    }
    elements.push(
      buildFeishuElicitationCustomButton(
        message,
        currentQuestion,
        elicitation.currentQuestionIndex,
      ),
    );
    const form = buildFeishuElicitationForm(
      message,
      currentQuestion,
      elicitation.currentQuestionIndex,
    );
    if (form) {
      elements.push(form);
    }
    const shouldShowCancel =
      currentQuestion.multiSelect ||
      currentQuestion.options.length === 0 ||
      isFeishuElicitationCustomExpanded(message, elicitation.currentQuestionIndex);
    if (selection && shouldShowCancel) {
      const customExpanded = isFeishuElicitationCustomExpanded(
        message,
        elicitation.currentQuestionIndex,
      );
      elements.push(
        ...(selection.showCancel === false
          ? []
          : [
              buildFeishuButtonElement({
                text:
                  selection.cancelLabel ??
                  formatBotMessage(message.locale, "selectionCancelOption"),
                type: "default",
                command:
                  customExpanded && currentQuestion.options.length > 0
                    ? buildFeishuElicitationOptionCommand(
                        message,
                        FEISHU_ELICITATION_CUSTOM_OPTION_ID,
                      )
                    : "/cancel",
                originalText: message.text,
              }),
            ]),
      );
    }
  } else if (elicitation.status === "cancelled") {
    elements.push({
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(
        formatBotMessage(message.locale, "elicitationCancelledCard"),
      ),
    });
  }
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

function getFeishuDomainProvider(bot: Pick<BotConfig, "provider">): "feishu" | "lark" {
  return bot.provider === "lark" ? "lark" : "feishu";
}

function readFeishuPayloadProvider(payload: Record<string, unknown>): BotProvider {
  return readString(payload, "zcodeProvider") === "lark" ? "lark" : "feishu";
}

function getFeishuBaseUrl(bot: Pick<BotConfig, "provider">): string {
  return getFeishuDomainProvider(bot) === "lark"
    ? "https://open.larksuite.com"
    : "https://open.feishu.cn";
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function readFeishuCallbackEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const event = isRecord(payload.event) ? payload.event : null;
  return event ?? payload;
}

function readFeishuChatType(value: string): "private" | "group" {
  return value === "group" || value === "group_chat" ? "group" : "private";
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripFeishuMentions(text: string): string {
  return text
    .replace(/<at\b[^>]*>.*?<\/at>/giu, "")
    .replace(/@\S+/gu, "")
    .trim();
}

function readFeishuPostLocaleContent(content: Record<string, unknown>): unknown {
  const post = isRecord(content.post) ? content.post : null;
  const zhCn = isRecord(content.zh_cn) ? content.zh_cn : isRecord(post?.zh_cn) ? post.zh_cn : null;
  const enUs = isRecord(content.en_us) ? content.en_us : isRecord(post?.en_us) ? post.en_us : null;
  return content.content ?? zhCn?.content ?? enUs?.content;
}

function readFeishuPostLocaleTitle(content: Record<string, unknown>): string {
  const post = isRecord(content.post) ? content.post : null;
  const zhCn = isRecord(content.zh_cn) ? content.zh_cn : isRecord(post?.zh_cn) ? post.zh_cn : null;
  const enUs = isRecord(content.en_us) ? content.en_us : isRecord(post?.en_us) ? post.en_us : null;
  return readString(content, "title") || readString(zhCn, "title") || readString(enUs, "title");
}

function formatFeishuPostToken(token: unknown, botOpenId?: string, mentions?: unknown): string {
  if (typeof token === "string") {
    return token;
  }
  if (Array.isArray(token)) {
    return token
      .map((item) => formatFeishuPostToken(item, botOpenId, mentions))
      .filter(Boolean)
      .join("");
  }
  if (!isRecord(token)) {
    return "";
  }
  const tag = readString(token, "tag");
  if (tag === "at") {
    if (!botOpenId) return "";
    // 群富文本中的自身 @ 也须进入有序 mention，不能在转文本时提前丢掉。
    const id = readString(token, "user_id");
    const mention = (Array.isArray(mentions) ? mentions : []).find(
      (item) => isRecord(item) && isRecord(item.id) && item.id.open_id === id,
    );
    if (isRecord(mention) && typeof mention.key === "string") return mention.key;
    return id.startsWith("@_") ? id : `@${readString(token, "user_name") || id}`;
  }
  const nested = token.content ?? token.children ?? token.elements;
  const nestedText = Array.isArray(nested)
    ? formatFeishuPostToken(nested, botOpenId, mentions)
    : "";
  const text =
    readString(token, "text") ||
    readString(token, "un_escape_text") ||
    readString(token, "name") ||
    nestedText;
  if (tag === "a") {
    const href = readString(token, "href");
    if (href && href !== text) {
      return text ? `${text} ${href}` : href;
    }
  }
  return text;
}

function readFeishuPostText(
  content: Record<string, unknown> | null,
  botOpenId?: string,
  mentions?: unknown,
): string {
  if (!content) {
    return "";
  }
  const postContent = readFeishuPostLocaleContent(content);
  const lines = Array.isArray(postContent)
    ? postContent
        .map((line) => formatFeishuPostToken(line, botOpenId, mentions).trim())
        .filter(Boolean)
    : [];
  const title = readFeishuPostLocaleTitle(content).trim();
  const body = lines.join("\n").trim();
  if (title && body) {
    return `${title}\n${body}`;
  }
  return body || title;
}

function inferFeishuAttachmentKind(msgType: string): BotInboundAttachment["kind"] {
  if (msgType === "image") return "image";
  if (msgType === "audio") return "audio";
  if (msgType === "media" || msgType === "video") return "video";
  return "file";
}

function defaultFeishuMimeType(kind: BotInboundAttachment["kind"]): string {
  if (kind === "image") return "image/jpeg";
  if (kind === "audio") return "audio/mpeg";
  if (kind === "video") return "video/mp4";
  return "application/octet-stream";
}

function readFeishuAttachment(
  msgType: string,
  content: Record<string, unknown> | null,
): BotInboundAttachment | null {
  if (!content) {
    return null;
  }
  const providerFileId =
    readString(content, "image_key") ||
    readString(content, "file_key") ||
    readString(content, "media_key") ||
    readString(content, "audio_key") ||
    readString(content, "key");
  if (!providerFileId) {
    return null;
  }
  const kind = inferFeishuAttachmentKind(msgType);
  const filename =
    readString(content, "file_name") ||
    readString(content, "filename") ||
    `${msgType}-${providerFileId.slice(0, 8)}`;
  const mimeType =
    readString(content, "mime_type") ||
    readString(content, "mimeType") ||
    defaultFeishuMimeType(kind);
  return {
    id: providerFileId,
    kind,
    filename,
    mimeType,
    ...(typeof content.size === "number" ? { sizeBytes: content.size } : {}),
    providerFileId,
  };
}

function readFeishuTextMessage(
  botId: string,
  payload: Record<string, unknown>,
): BotInboundMessage | null {
  const provider = readFeishuPayloadProvider(payload);
  // Bugfix: 飞书 node-sdk 的 WebSocket EventDispatcher 在不同事件/版本下可能把 event 字段摊平到顶层。
  // 之前只读 payload.event.message，长连接确实收到消息时也会解析成 0 条 inbound。
  const event = isRecord(payload.event) ? payload.event : payload;
  const message = isRecord(event?.message) ? event.message : null;
  const sender = isRecord(event?.sender) ? event.sender : null;
  const senderId = isRecord(sender?.sender_id) ? sender.sender_id : null;
  const content = isRecord(payload.zcodeNativeCardContent)
    ? payload.zcodeNativeCardContent
    : parseJsonRecord(message?.content);
  const msgType = readString(message, "message_type") || readString(message, "msg_type");
  // 交互卡及其机器人确认回复属于控制流程，过去提取卡片文字会误触发另一机器人。
  if (
    payload.zcodeIgnoreInteractionMessage === true ||
    (isFeishuBotSender(readString(sender, "sender_type")) &&
      msgType === "interactive" &&
      isGroupControlCard(content))
  )
    return null;
  const attachment = readFeishuAttachment(msgType, content);
  const attachments: BotInboundAttachment[] = attachment ? [attachment] : [];
  if (isRecord(payload.zcodeReferencedAttachment)) {
    const ref = payload.zcodeReferencedAttachment;
    if (
      (ref.kind === "image" || ref.kind === "file") &&
      typeof ref.providerFileId === "string" &&
      typeof ref.filename === "string" &&
      typeof ref.mimeType === "string"
    ) {
      const metadata = isRecord(ref.providerMetadata) ? ref.providerMetadata : null;
      const resourceMessageId = readString(metadata, "resourceMessageId");
      if (resourceMessageId)
        attachments.push({
          id: ref.providerFileId,
          kind: ref.kind,
          providerFileId: ref.providerFileId,
          filename: ref.filename,
          mimeType: ref.mimeType,
          providerMetadata: { resourceMessageId },
        });
    }
  }
  if (Array.isArray(payload.zcodeReferencedInlineImages)) {
    for (const image of payload.zcodeReferencedInlineImages) {
      if (
        isRecord(image) &&
        typeof image.imageKey === "string" &&
        typeof image.messageId === "string"
      ) {
        const item = readFeishuAttachment("image", { image_key: image.imageKey });
        if (item)
          attachments.push({ ...item, providerMetadata: { resourceMessageId: image.messageId } });
      }
    }
  }
  let malformedInlineImage = false;
  if (msgType === "post" && content) {
    // 文字与文件一起发送时，文件位于顶层 files；只遍历正文图片会静默丢掉 PDF 等附件。
    if (Array.isArray(content.files)) {
      for (const file of content.files) {
        const attachment = readFeishuAttachment("file", isRecord(file) ? file : null);
        if (attachment) attachments.push(attachment);
      }
    }
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      if (!isRecord(node)) return;
      if (node.tag === "img") {
        const image = readFeishuAttachment("image", node);
        if (image) attachments.push(image);
        else malformedInlineImage = true;
      }
      visit(node.content ?? node.children ?? node.elements);
    };
    visit(readFeishuPostLocaleContent(content));
  }
  // 缺少图片引用不能静默降级成只执行正文。
  if (malformedInlineImage) return null;
  // Bugfix: 飞书客户端里看起来像普通文字的富文本/带链接消息会以 message_type=post 推送。
  // 之前只读 content.text，post 消息被解析成空文本并直接丢弃，所以用户侧表现为“发了普通消息但 app 没反应”。
  const rawText =
    (msgType === "interactive" ? readGroupConversationCardText(content, message?.mentions) : "") ||
    readString(content, "text") ||
    readFeishuPostText(
      content,
      readString(payload, "zcodeBotOpenId") || undefined,
      message?.mentions,
    ) ||
    readString(event, "text_without_at_bot") ||
    readString(event, "text");
  const incomingChatType = readString(message, "chat_type") || readString(event, "chat_type");
  if (incomingChatType === "topic_group") return null;
  const groupMessage =
    incomingChatType === "group"
      ? readGroupMessage(
          rawText,
          message?.mentions,
          readString(payload, "zcodeBotOpenId"),
          readString(sender, "sender_type"),
          readString(senderId, "open_id"),
        )
      : undefined;
  // Provider 验证发送者与 mention 身份；机器人群主聊天必须原生 @，群/话题启用状态由服务校验。
  if (
    isFeishuBotSender(readString(sender, "sender_type")) &&
    (incomingChatType !== "group" ||
      (!readString(message, "thread_id") && !groupMessage?.mentionedBot))
  )
    return null;
  if (
    incomingChatType === "group" &&
    (!groupMessage || (!groupMessage.mentionedBot && !readString(message, "thread_id")))
  )
    return null;
  const text = groupMessage?.text ?? stripFeishuMentions(rawText);
  // 群权限只使用应用内 open_id，不能把其他 ID 命名空间误当作绑定身份。
  if (incomingChatType === "group" && !readString(senderId, "open_id")) return null;
  const userId =
    readString(senderId, "open_id") ||
    readString(senderId, "user_id") ||
    readString(senderId, "union_id") ||
    readString(event, "open_id") ||
    readString(event, "user_id") ||
    readString(event, "union_id");
  const chatId = readString(message, "chat_id") || readString(event, "open_chat_id");
  const messageId = readString(message, "message_id");
  // 群内仅 @ 仍是有效唤起，空需求由服务结合引用/话题背景处理。
  if ((!text && attachments.length === 0 && incomingChatType !== "group") || !userId) {
    return null;
  }
  const chatType = readFeishuChatType(
    readString(message, "chat_type") || readString(event, "chat_type"),
  );
  return {
    botId,
    text,
    ...(groupMessage
      ? {
          ...(isFeishuBotSender(readString(sender, "sender_type"))
            ? { senderType: "app" as const }
            : {}),
          botOpenId: readString(payload, "zcodeBotOpenId") || undefined,
          mentionedBot: groupMessage.mentionedBot,
          commandText: groupMessage.commandText,
          ...(groupMessage.contentParts
            ? {
                contentParts: groupMessage.contentParts.map((part) =>
                  part.type === "text"
                    ? part
                    : {
                        ...part,
                        channel: provider === "lark" ? ("lark" as const) : ("feishu" as const),
                        refId: `${messageId}:${part.refId}`,
                      },
                ),
              }
            : {}),
          topicRootIsCurrentBot: payload.zcodeTopicRootIsCurrentBot === true,
        }
      : {}),
    ...(isRecord(payload.zcodeReferencedMessage) &&
    typeof payload.zcodeReferencedMessage.messageId === "string" &&
    typeof payload.zcodeReferencedMessage.text === "string"
      ? {
          referencedMessage: {
            ...payload.zcodeReferencedMessage,
            messageId: payload.zcodeReferencedMessage.messageId,
            text: payload.zcodeReferencedMessage.text,
          },
        }
      : {}),
    ...(attachments.length ? { attachments } : {}),
    actor: {
      provider,
      botId,
      providerUserId: userId,
      displayName: readString(sender, "sender_name") || undefined,
      chatType,
      chatId: chatType === "group" && chatId ? chatId : undefined,
      ...(chatType === "group" && readString(message, "thread_id")
        ? {
            threadId: readString(message, "thread_id"),
            rootMessageId: readString(message, "root_id") || messageId,
          }
        : {}),
      providerMessageId: messageId || undefined,
    },
  };
}

function readFeishuCardAction(
  botId: string,
  payload: Record<string, unknown>,
): BotInboundMessage | null {
  const provider = readFeishuPayloadProvider(payload);
  const event = readFeishuCallbackEvent(payload);
  const action = isRecord(event.action) ? event.action : null;
  const value = isRecord(action?.value) ? action.value : null;
  const formValue = isRecord(action?.form_value) ? action.form_value : null;
  const behavior = Array.isArray(action?.behaviors) ? action.behaviors.find(isRecord) : null;
  const behaviorValue = isRecord(behavior?.value) ? behavior.value : null;
  const rawCommand =
    readString(value, "command") ||
    readString(value, "text") ||
    readString(behaviorValue, "command") ||
    readString(behaviorValue, "text");
  const submittedAnswer = formValue?.[FEISHU_ELICITATION_FORM_FIELD_NAME];
  const command =
    rawCommand && rawCommand.includes(FEISHU_ELICITATION_FORM_VALUE_PREFIX)
      ? buildFeishuElicitationFormCommand(rawCommand.split(/\s+/u)[1] ?? "", submittedAnswer)
      : rawCommand;
  const operator = isRecord(event.operator) ? event.operator : null;
  const operatorId = isRecord(operator?.operator_id) ? operator.operator_id : null;
  const openId =
    readString(operatorId, "open_id") ||
    readString(operator, "open_id") ||
    readString(event, "open_id") ||
    readString(event, "user_id") ||
    readString(payload, "open_id") ||
    readString(payload, "user_id");
  const context = isRecord(event.context) ? event.context : null;
  const contextChatType =
    readString(context, "chat_type") ||
    readString(event, "chat_type") ||
    readString(payload, "chat_type");
  const chatId = readString(context, "open_chat_id") || readString(context, "chat_id");
  const message = isRecord(event.message) ? event.message : null;
  const header = isRecord(payload.header) ? payload.header : null;
  const providerMessageId =
    readString(event, "event_id") ||
    readString(header, "event_id") ||
    readString(payload, "uuid") ||
    readString(payload, "event_id") ||
    readString(context, "open_message_id") ||
    readString(context, "message_id") ||
    readString(message, "message_id") ||
    readString(action, "value_id");
  if (!command || !openId) {
    return null;
  }
  // Bugfix: 飞书卡片回调的 context.open_chat_id 在私聊按钮里也可能存在。
  // 之前用 chatId 是否存在判断群聊，会把私聊里的卡片按钮误拒成“只支持私聊”。
  const chatType = readFeishuChatType(readString(payload, "zcodeChatType") || contextChatType);
  const groupCard = botGroupCardSchema.safeParse(value?.groupCard ?? behaviorValue?.groupCard);
  return {
    botId,
    ...(chatType === "group"
      ? { groupCardAction: true, ...(groupCard.success ? { groupCard: groupCard.data } : {}) }
      : {}),
    text: command,
    actor: {
      provider,
      botId,
      providerUserId: openId,
      chatType,
      chatId: chatType === "group" && chatId ? chatId : undefined,
      ...(chatType === "group" && groupCard.success && groupCard.data.threadId
        ? { threadId: groupCard.data.threadId }
        : {}),
      ...(providerMessageId ? { providerMessageId } : {}),
    },
  };
}

function readFeishuCardUpdateToken(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }
  const event = readFeishuCallbackEvent(payload);
  const action = isRecord(event.action) ? event.action : null;
  const context = isRecord(event.context) ? event.context : null;
  // Bugfix: Card JSON 2.0 回调的更新 token 不总在旧版 action.token 上。
  // 新版按钮由 behaviors.callback 触发时，飞书/Lark 可能把 token 放在事件或 context 上；漏读会让 card/update 静默跳过，按钮留在原卡片里。
  return (
    readString(event, "token") ||
    readString(event, "card_update_token") ||
    readString(event, "update_token") ||
    readString(payload, "token") ||
    readString(payload, "card_update_token") ||
    readString(payload, "update_token") ||
    readString(action, "token") ||
    readString(action, "card_update_token") ||
    readString(action, "update_token") ||
    readString(context, "token") ||
    readString(context, "card_update_token") ||
    readString(context, "update_token")
  );
}

function readFeishuCardUpdateOpenIds(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  const event = readFeishuCallbackEvent(payload);
  const operator = isRecord(event.operator) ? event.operator : null;
  const operatorId = isRecord(operator?.operator_id) ? operator.operator_id : null;
  const openId =
    readString(operatorId, "open_id") ||
    readString(operator, "open_id") ||
    readString(event, "open_id") ||
    readString(payload, "open_id");
  return openId ? [openId] : [];
}

function readFeishuCardOriginalText(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const event = readFeishuCallbackEvent(payload);
  const action = isRecord(event.action) ? event.action : null;
  const value = isRecord(action?.value) ? action.value : null;
  const behavior = Array.isArray(action?.behaviors) ? action.behaviors.find(isRecord) : null;
  const behaviorValue = isRecord(behavior?.value) ? behavior.value : null;
  return (
    readString(value, "zcodeCardText") ||
    readString(value, "cardText") ||
    readString(behaviorValue, "zcodeCardText") ||
    readString(behaviorValue, "cardText") ||
    null
  );
}

function formatFeishuCardMarkdownContent(text: string): string {
  const lines: Array<{ text: string; hardBreak: boolean }> = [];
  let inCodeFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inCodeFence = !inCodeFence;
    }
    if (!inCodeFence && /^-{3,}$/.test(line.trim())) {
      if (lines.length > 0 && lines.at(-1)?.text !== "") {
        lines.push({ text: "", hardBreak: false });
      }
      lines.push({ text: "---", hardBreak: false }, { text: "", hardBreak: false });
      continue;
    }
    lines.push({ text: line, hardBreak: !inCodeFence });
  }
  return lines
    .map((line, index) => {
      if (!line.text || !line.hardBreak || index >= lines.length - 1 || !lines[index + 1]?.text) {
        return line.text;
      }
      // Bugfix: Card JSON 2.0 的 markdown 按标准 Markdown 处理单换行，会把 /status 多行文本折成一行。
      // 飞书通道内把普通单换行转成 hard break，保留业务层给其他 bot 使用的原始文本。
      return `${line.text}  `;
    })
    .join("\n");
}

function buildFeishuButtonElement(params: {
  text: string;
  type: "default" | "primary";
  command: string;
  originalText: string;
}): Record<string, unknown> {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: params.text,
    },
    type: params.type,
    // Bugfix: Card JSON 2.0 不再支持旧版 action/actions 容器。
    // 按钮必须直接作为 body.elements 组件，并通过 behaviors.callback 回传业务值，否则飞书会返回 HTTP 400。
    behaviors: [
      {
        type: "callback",
        value: {
          command: params.command,
          zcodeCardText: params.originalText,
        },
      },
    ],
  };
}

function buildFeishuInteractiveCardPayloadBody(
  message: BotOutboundMessage,
): Record<string, unknown> {
  const selection = message.selection;
  if (selection?.action === "queue.cancel") {
    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      body: {
        padding: "8px 12px 8px 12px",
        elements: [
          {
            tag: "column_set",
            flex_mode: "none",
            horizontal_spacing: "8px",
            columns: [
              {
                tag: "column",
                width: "weighted",
                weight: 1,
                vertical_align: "center",
                elements: [
                  { tag: "markdown", content: formatFeishuCardMarkdownContent(message.text) },
                ],
              },
              {
                tag: "column",
                width: "auto",
                vertical_align: "center",
                elements: selection.options.map((option) =>
                  buildFeishuButtonElement({
                    text: option.label,
                    type: "default",
                    command: formatSelectionCommand(selection, option.id),
                    originalText: message.text,
                  }),
                ),
              },
            ],
          },
        ],
      },
    };
  }
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(message.text),
    },
  ];
  if (selection) {
    elements.push(
      ...selection.options.map((option, index) =>
        buildFeishuButtonElement({
          text: option.label || String(index + 1),
          type: "primary",
          command: formatSelectionCommand(selection, option.id),
          originalText: message.text,
        }),
      ),
      ...(selection.showCancel === false
        ? []
        : [
            buildFeishuButtonElement({
              text:
                selection.cancelLabel ?? formatBotMessage(message.locale, "selectionCancelOption"),
              type: "default",
              // Bugfix: 飞书走结构化选项卡，不应复用微信纯文本菜单的 0 取消语义。
              command: "/cancel",
              originalText: message.text,
            }),
          ]),
    );
  }
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

function formatFeishuStreamingStatus(state: BotStreamingReplyCardState): string {
  // Bugfix: 流式卡片状态行由 provider 生成，必须读取 BotService 传入的 locale，
  // 否则中文环境里会固定显示 Running/Completed。
  const locale = state.locale;
  const status = state.status;
  if (status === "completed") {
    return formatBotMessage(locale, "streamingStatusCompleted");
  }
  if (status === "error") {
    return formatBotMessage(locale, "streamingStatusFailed");
  }
  return formatBotMessage(locale, "streamingStatusRunning");
}

function buildFeishuStreamingToolPanel(
  toolSummaries: readonly string[],
  options: { expanded: boolean; title: string },
): Record<string, unknown> | null {
  const summaries = toolSummaries
    .map((summary) => summary.trim())
    .filter((summary) => summary.length > 0);
  if (summaries.length === 0) {
    return null;
  }
  return {
    tag: "collapsible_panel",
    // Bugfix: 流式卡片运行中需要让用户看到当前工具摘要；任务终态后再自动收起，减少最终消息占用空间。
    expanded: options.expanded,
    // Bugfix: Tool summaries 之前只是裸 collapsible panel，和正文没有清晰视觉边界。
    // 飞书 Card JSON 2.0 的折叠面板本身支持背景与边框，这里把它作为 <tools> 容器承载 header/content。
    background_color: "grey-50",
    border: {
      color: "grey",
      corner_radius: "8px",
    },
    padding: "8px 8px 8px 8px",
    header: {
      title: {
        tag: "plain_text",
        content: `🛠️ ${options.title} (${summaries.length})`,
      },
      vertical_align: "center",
      padding: "8px 8px 8px 8px",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        color: "grey",
        size: "16px 16px",
      },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    elements: [
      {
        tag: "markdown",
        content: formatFeishuCardMarkdownContent(summaries.join("\n")),
      },
    ],
  };
}

function buildFeishuStreamingCardPayload(
  state: BotStreamingReplyCardState,
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];
  for (const block of state.blocks) {
    if (block.type === "message") {
      const text = block.text.trim();
      if (text) {
        elements.push({
          tag: "markdown",
          content: formatFeishuCardMarkdownContent(text),
        });
      }
      continue;
    }
    const toolPanel = buildFeishuStreamingToolPanel(block.summaries, {
      expanded: block.expanded ?? state.status === "running",
      title: block.title?.trim() || formatBotMessage(state.locale, "streamingToolSummaries"),
    });
    if (toolPanel) {
      elements.push(toolPanel);
    }
  }
  if (elements.length === 0) {
    elements.push({
      tag: "markdown",
      content: " ",
    });
  }
  if (state.status !== "sealed") {
    elements.push({
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(formatFeishuStreamingStatus(state)),
    });
  }
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

function countTaggedElements(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countTaggedElements(item), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  const record = value as Record<string, unknown>;
  return (
    (typeof record.tag === "string" ? 1 : 0) +
    Object.values(record).reduce<number>((total, item) => total + countTaggedElements(item), 0)
  );
}

export function countFeishuCardTaggedElements(state: BotStreamingReplyCardState): number {
  return countTaggedElements(buildFeishuStreamingCardPayload(state));
}

export function splitFeishuStreamingCardStates(
  state: BotStreamingReplyCardState,
): BotStreamingReplyCardState[] {
  const blockGroups: BotStreamingReplyCardState["blocks"][] = [];
  let current: BotStreamingReplyCardState["blocks"] = [];
  for (const block of state.blocks) {
    const candidate = [...current, block];
    // 始终为状态行预留预算，使 running/completed 切换不会改变既有分段边界。
    const candidateState = { ...state, blocks: candidate, status: "running" as const };
    if (
      current.length > 0 &&
      countFeishuCardTaggedElements(candidateState) > FEISHU_STREAMING_CARD_TAGGED_ELEMENT_BUDGET
    ) {
      blockGroups.push(current);
      current = [block];
    } else {
      current = candidate;
    }
  }
  blockGroups.push(current);
  return blockGroups.map((blocks, index) => ({
    ...state,
    blocks,
    status: index === blockGroups.length - 1 ? state.status : "sealed",
  }));
}

export function splitFeishuText(text: string): string[] {
  const limit = 1900;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks.length > 0 ? chunks : [text];
}

async function readTenantAccessToken(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!bot.feishuAppId || !bot.credentialRef) {
    return null;
  }
  const appSecret = await deps.loadCredential(bot.credentialRef);
  if (!appSecret) {
    return null;
  }
  const cacheKey = `${getFeishuDomainProvider(bot)}:${bot.feishuAppId}:${bot.credentialRef}`;
  const cached = accessTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const requestedAt = Date.now();
  const response = await fetchBotProviderJson<FeishuAccessTokenResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_id: bot.feishuAppId,
        app_secret: appSecret,
      }),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu tenant_access_token failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(payload.msg || "Feishu tenant_access_token failed.");
  }
  // 飞书可能返回尚未过期的旧令牌；固定缓存 90 分钟会超过其真实剩余有效期。
  // 从请求开始计时，避免网络耗时被错误计入令牌的可用时间。
  if (typeof payload.expire === "number" && Number.isFinite(payload.expire) && payload.expire > 0) {
    accessTokenCache.set(cacheKey, {
      token: payload.tenant_access_token,
      expiresAt: requestedAt + payload.expire * 1_000,
    });
  } else {
    accessTokenCache.delete(cacheKey);
  }
  return payload.tenant_access_token;
}

function resolveFeishuReceiveIdType(receiveId: string): "chat_id" | "open_id" {
  return receiveId.startsWith("oc_") ? "chat_id" : "open_id";
}

function createFeishuMessageError(
  operation: string,
  status: number,
  payload: FeishuSendMessageResponse | undefined,
  responseLogId?: string,
  receiveIdType?: string,
): Error {
  const details = [
    typeof payload?.code === "number" ? `code=${payload.code}` : null,
    payload?.msg ? `msg=${payload.msg}` : null,
    payload?.error?.log_id || responseLogId
      ? `log_id=${payload?.error?.log_id ?? responseLogId}`
      : null,
    receiveIdType ? `receive_id_type=${receiveIdType}` : null,
  ].filter((detail): detail is string => Boolean(detail));
  // 修复原因：飞书的 HTTP 400 会在响应体中携带业务错误码、原因和排查 log_id。
  // 旧实现先按 HTTP 状态抛错，导致这些已解析的信息永久丢失，无法区分权限、限流和卡片错误。
  return Object.assign(
    new Error(
      `Feishu ${operation} failed: HTTP ${status}${details.length > 0 ? `, ${details.join(", ")}` : ""}`,
    ),
    {
      // 无业务回执的服务端错误，以及“正在发送”，都不能证明本次发送未发生。
      deliveryRejected:
        payload?.code !== 230049 &&
        ((typeof payload?.code === "number" && payload.code !== 0) ||
          (status >= 400 && status < 500 && status !== 408)),
      ...(payload?.code === 230011 ? { deliveryReplyUnavailable: true } : {}),
      ...(status === 429 || payload?.code === 230020 || payload?.code === 99991400
        ? { retryAfterMs: 1000 }
        : {}),
    },
  );
}

function resolveFeishuReplyTarget(message: BotOutboundMessage) {
  const replyToMessageId =
    message.replyToMessageId || (message.threadId ? message.rootMessageId : undefined);
  // 原因：临时审批／问答卡曾跳过话题路由，直接发到群主聊天；统一解析并拒绝无锚点投递。
  if (message.threadId && !replyToMessageId)
    throw Object.assign(new Error("Topic reply target is unavailable"), {
      deliveryRejected: true,
    });
  return { replyToMessageId, replyInThread: Boolean(message.threadId) };
}

async function sendFeishuInteractiveCard(
  bot: BotConfig,
  token: string,
  receiveId: string,
  card: Record<string, unknown>,
  signal?: AbortSignal,
  delivery?: { replyToMessageId?: string; uuid?: string; replyInThread?: boolean },
): Promise<string | null> {
  const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
    delivery?.replyToMessageId
      ? `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(delivery.replyToMessageId)}/reply`
      : `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages?receive_id_type=${resolveFeishuReceiveIdType(receiveId)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...(!delivery?.replyToMessageId ? { receive_id: receiveId } : {}),
        ...(delivery?.uuid ? { uuid: delivery.uuid } : {}),
        ...(delivery?.replyInThread ? { reply_in_thread: true } : {}),
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
      signal,
    },
  );
  const payload = response.payload ?? {};
  // HTTP 成功也可能携带业务拒绝，必须保留错误码和请求 ID。
  if (!response.ok || payload.code !== 0) {
    throw createFeishuMessageError(
      "send interactive message",
      response.status,
      payload,
      response.responseLogId,
      resolveFeishuReceiveIdType(receiveId),
    );
  }
  if ((delivery?.uuid || delivery?.replyToMessageId) && !payload.data?.message_id)
    throw new Error("Feishu delivery outcome is unknown: no message_id");
  return payload.data?.message_id ?? null;
}

async function updateFeishuInteractiveMessage(
  bot: BotConfig,
  token: string,
  handle: BotStreamingReplyCardHandle,
  card: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(handle.providerMessageId)}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
      signal,
    },
  );
  const payload = response.payload ?? {};
  // HTTP 成功也可能携带业务拒绝，必须保留错误码和请求 ID。
  if (!response.ok || payload.code !== 0) {
    throw createFeishuMessageError(
      "update streaming card",
      response.status,
      payload,
      response.responseLogId,
    );
  }
}

async function deleteFeishuInteractiveMessage(
  bot: BotConfig,
  token: string,
  handle: BotTransientInteractionCardHandle,
): Promise<void> {
  const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(handle.providerMessageId)}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu recall interaction card failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || "Feishu recall interaction card failed.");
  }
}

function resolveFeishuAppDisplayName(payload: FeishuAppInfoResponse): string | null {
  const app = payload.data?.app;
  const appName = app?.app_name?.trim();
  if (appName) {
    return appName;
  }
  const primaryLanguage = app?.primary_language?.trim();
  const primaryI18nName = app?.i18n
    ?.find((item) => item.i18n_key === primaryLanguage)
    ?.name?.trim();
  if (primaryI18nName) {
    return primaryI18nName;
  }
  return app?.i18n?.find((item) => item.name?.trim())?.name?.trim() ?? null;
}

async function fetchFeishuAppDisplayName(
  bot: BotConfig,
  token: string,
  appId: string,
): Promise<string | null> {
  const response = await fetchBotProviderJson<FeishuAppInfoResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/application/v6/applications/${appId}?lang=zh_cn`,
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu get application info failed app=${appId}: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || `Feishu get application info failed app=${appId}.`);
  }
  return resolveFeishuAppDisplayName(payload);
}

async function readFeishuAppDisplayName(
  bot: BotConfig,
  deps: FeishuProviderDeps,
): Promise<string | null> {
  if (!bot.feishuAppId) {
    return null;
  }
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return null;
  }
  let appIdError: unknown;
  try {
    const appName = await fetchFeishuAppDisplayName(bot, token, bot.feishuAppId);
    if (appName?.trim()) {
      return appName;
    }
  } catch (error) {
    appIdError = error;
  }
  try {
    // Bugfix: 飞书 / Lark 扫码创建后 app_id 路径可能因为权限或同步延迟暂不可读；me 路径更适合读取当前应用名称。
    return await fetchFeishuAppDisplayName(bot, token, "me");
  } catch (error) {
    throw appIdError ?? error;
  }
}

function resolveFeishuUserIdType(userId: string): "open_id" | "union_id" | "user_id" {
  if (userId.startsWith("ou_")) {
    return "open_id";
  }
  if (userId.startsWith("on_")) {
    return "union_id";
  }
  return "user_id";
}

function resolveFeishuUserDisplayName(payload: FeishuUserInfoResponse): string | null {
  const user = payload.data?.user;
  return user?.name?.trim() || user?.en_name?.trim() || user?.nickname?.trim() || null;
}

async function readFeishuUserDisplayName(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  userId: string,
): Promise<string | null> {
  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    return null;
  }
  const cacheKey = `${getFeishuDomainProvider(bot)}:${bot.feishuAppId ?? ""}:${bot.credentialRef ?? ""}:${trimmedUserId}`;
  const cached = userDisplayNameCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.name;
  }
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return null;
  }
  const userIdType = resolveFeishuUserIdType(trimmedUserId);
  const response = await fetchBotProviderJson<FeishuUserInfoResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/contact/v3/users/${encodeURIComponent(trimmedUserId)}?user_id_type=${userIdType}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu get user info failed user=${trimmedUserId}: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || `Feishu get user info failed user=${trimmedUserId}.`);
  }
  const name = resolveFeishuUserDisplayName(payload);
  // Bugfix: 飞书消息事件只稳定携带 sender_id，不携带发送者名称。
  // 这里缓存通讯录查询结果，避免同一个用户连续发消息时每条都请求 contact API。
  userDisplayNameCache.set(cacheKey, {
    name,
    expiresAt: Date.now() + 10 * 60_000,
  });
  return name;
}

function getFeishuTypingReactionKey(bot: BotConfig, messageId: string): string {
  return `${bot.id}:${messageId}`;
}

async function addFeishuTypingReaction(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  messageId: string,
): Promise<void> {
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return;
  }
  const key = getFeishuTypingReactionKey(bot, messageId);
  if (typingReactionIds.has(key)) {
    return;
  }
  const response = await fetchBotProviderJson<FeishuReactionResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${messageId}/reactions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        reaction_type: {
          emoji_type: "Typing",
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu add typing reaction failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || "Feishu add typing reaction failed.");
  }
  if (payload.data?.reaction_id) {
    typingReactionIds.set(key, payload.data.reaction_id);
  }
}

async function deleteFeishuTypingReaction(
  bot: BotConfig,
  deps: FeishuProviderDeps,
  messageId: string,
): Promise<void> {
  const key = getFeishuTypingReactionKey(bot, messageId);
  const reactionId = typingReactionIds.get(key);
  if (!reactionId) {
    return;
  }
  const token = await readTenantAccessToken(bot, deps);
  if (!token) {
    return;
  }
  const response = await fetchBotProviderJson<FeishuReactionResponse>(
    `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu delete typing reaction failed: HTTP ${response.status}`);
  }
  const payload = response.payload ?? {};
  if (payload.code !== 0) {
    throw new Error(payload.msg || "Feishu delete typing reaction failed.");
  }
  typingReactionIds.delete(key);
}

async function readFeishuAppSecret(
  bot: BotConfig,
  deps: FeishuProviderDeps,
): Promise<string | null> {
  if (!bot.feishuAppId || !bot.credentialRef) {
    return null;
  }
  return deps.loadCredential(bot.credentialRef);
}

export function createFeishuWebSocketEventHandlers(params: {
  bot: BotConfig;
  onPayload: (payload: unknown) => Promise<BotOutboundMessage | undefined>;
}) {
  const { bot, onPayload } = params;
  return {
    "im.message.receive_v1": async (payload: unknown) => {
      await onPayload({
        ...(isRecord(payload) ? payload : { payload }),
        botId: bot.id,
        zcodeProvider: bot.provider,
      });
    },
    "im.chat.member.bot.deleted_v1": async (payload: unknown) => {
      await onPayload({
        ...(isRecord(payload) ? payload : {}),
        botId: bot.id,
        zcodeProvider: bot.provider,
        zcodeBotRemoved: true,
      });
    },
    // Bugfix: 我们用 Typing reaction 模拟输入中状态，飞书会把自己创建的 reaction 再推回长连接。
    // 业务不需要处理这个事件，但不注册 handler 时 SDK 会持续打印 warn 干扰排查。
    "im.message.reaction.created_v1": async () => undefined,
    "card.action.trigger": async (payload: unknown) => {
      const responseState = { deferred: false };
      const callbackPayload = {
        ...(isRecord(payload) ? payload : { payload }),
        zcodeFeishuCardResponseState: responseState,
        botId: bot.id,
        zcodeProvider: bot.provider,
        zcodeFeishuSynchronousCardAction: true,
      };
      // 修复原因：飞书点击后的同步响应才是客户端可靠采用的卡片状态。传输层不能再从
      // zcodeCardText 拼简化卡，也不能返回 undefined 后依赖旁路 PATCH；它必须消费业务层
      // 已推进完成的完整 outbound，并用同一份 elicitation 状态生成下一题卡片。
      // 飞书要求三秒内响应。超时只切换卡片投递方式，业务请求仍执行一次。
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const pending = onPayload(callbackPayload);
      const message = await Promise.race([
        pending,
        new Promise<null>((resolve) => {
          deadline = setTimeout(() => {
            responseState.deferred = true;
            resolve(null);
          }, 2000);
        }),
      ]).finally(() => {
        if (deadline) clearTimeout(deadline);
      });
      if (responseState.deferred) return {};
      if (!message) {
        return undefined;
      }
      if (message.callbackToastOnly) return { toast: { type: "error", content: message.text } };
      return {
        card: {
          type: "raw",
          data: message.elicitation
            ? buildFeishuElicitationCardPayload(message)
            : buildFeishuInteractiveCardPayload(message),
        },
      };
    },
  };
}

export async function startFeishuBotWebSocket(params: {
  bot: BotConfig;
  deps: FeishuProviderDeps;
  onPayload: (payload: unknown) => Promise<BotOutboundMessage | undefined>;
  signal?: AbortSignal;
  onConnectionStateChange?: (state: "reconnecting" | "connected") => void;
}): Promise<FeishuWebSocketClient> {
  const { bot, deps, onPayload, signal, onConnectionStateChange } = params;
  const appId = bot.feishuAppId;
  if (!appId || !FEISHU_APP_ID_PATTERN.test(appId)) {
    throw new Error("Invalid Feishu App ID.");
  }
  const appSecret = await readFeishuAppSecret(bot, deps);
  if (!appSecret) {
    throw new Error("Feishu App ID and App Secret are required.");
  }
  if (signal?.aborted) {
    throw new Error("Feishu WebSocket startup aborted.");
  }
  // SDK 全量源码会常驻 Host；只有实际启动长连接才加载，卡片和 HTTP 路径不承担这份开销。
  const Lark = await import("@larksuiteoapi/node-sdk");
  // 加载期间 channel 可能已停用，迟到的模块不能重新创建连接。
  if (signal?.aborted) {
    throw new Error("Feishu WebSocket startup aborted.");
  }
  const eventDispatcher = new Lark.EventDispatcher({});
  eventDispatcher.register(createFeishuWebSocketEventHandlers({ bot, onPayload }));
  return new Promise<FeishuWebSocketClient>((resolve, reject) => {
    let startupSettled = false;
    let lifecycleSettled = false;
    let clientClosed = false;
    let connectionUnavailable = false;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let connectionPoll: ReturnType<typeof setInterval> | undefined;
    let resolveTerminated: (() => void) | undefined;
    let rejectTerminated: ((error: unknown) => void) | undefined;
    const terminated = new Promise<void>((resolveLifecycle, rejectLifecycle) => {
      resolveTerminated = resolveLifecycle;
      rejectTerminated = rejectLifecycle;
    });
    const finishLifecycle = (error?: unknown) => {
      if (lifecycleSettled) return;
      lifecycleSettled = true;
      if (connectionPoll) clearInterval(connectionPoll);
      if (error) {
        rejectTerminated?.(error);
      } else {
        resolveTerminated?.();
      }
    };
    const fail = (error: unknown) => {
      if (startupSettled) return;
      startupSettled = true;
      if (startupTimer) clearTimeout(startupTimer);
      signal?.removeEventListener("abort", handleAbort);
      closeClient();
      reject(error);
    };
    function handleAbort() {
      fail(new Error("Feishu WebSocket startup aborted."));
    }
    function closeClient() {
      if (clientClosed) return;
      clientClosed = true;
      finishLifecycle();
      wsClient.close();
    }
    const wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain: getFeishuDomainProvider(bot) === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.info,
    });
    // 修复原因：当前飞书 SDK 不支持 onReady 回调，start() 也会在连接完成前返回。
    // 必须观察 SDK 持有的真实 WebSocket，避免连接已经 OPEN 后仍触发 20 秒超时并被主动关闭。
    connectionPoll = setInterval(() => {
      const sdkClient = wsClient as unknown as {
        isConnecting?: boolean;
        wsConfig?: {
          getWSInstance?(): { readyState?: number } | null;
        };
      };
      const connected =
        sdkClient.wsConfig?.getWSInstance?.()?.readyState === WEBSOCKET_OPEN_READY_STATE;
      if (!connected) {
        if (!startupSettled || clientClosed) return;
        if (!connectionUnavailable) {
          connectionUnavailable = true;
          onConnectionStateChange?.("reconnecting");
        }
        if (sdkClient.isConnecting === false) {
          const error = new Error("Feishu WebSocket reconnect exhausted.");
          finishLifecycle(error);
          closeClient();
        }
        return;
      }
      if (startupSettled) {
        if (connectionUnavailable) {
          connectionUnavailable = false;
          onConnectionStateChange?.("connected");
        }
        return;
      }
      startupSettled = true;
      if (startupTimer) clearTimeout(startupTimer);
      signal?.removeEventListener("abort", handleAbort);
      resolve({ close: closeClient, terminated });
    }, FEISHU_WEBSOCKET_READY_POLL_MS);
    startupTimer = setTimeout(() => {
      fail(
        new Error(
          `Feishu WebSocket startup timed out after ${FEISHU_WEBSOCKET_START_TIMEOUT_MS}ms.`,
        ),
      );
    }, FEISHU_WEBSOCKET_START_TIMEOUT_MS);
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    // 飞书不需要公网回调地址；这里由本机主动建立长连接接收事件，适配家用网络/NAT 环境。
    void wsClient.start({ eventDispatcher }).catch((error: unknown) => {
      if (!startupSettled) {
        fail(error);
        return;
      }
      finishLifecycle(error);
      closeClient();
    });
  });
}

export function createFeishuBotProvider(deps: FeishuProviderDeps): BotProviderAdapter {
  const reactionBots = new Map<string, BotConfig>();
  const updateReaction = createGroupInputReactionUpdater(async (key, state) => {
    const [botKey, messageId] = JSON.parse(key) as [string, string];
    const bot = reactionBots.get(botKey)!;
    const token = await readTenantAccessToken(bot, deps);
    if (!token) throw new Error("Feishu reaction credentials unavailable");
    const url = `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const emoji = {
      waiting: "OneSecond",
      working: "OnIt",
      done: "CheckMark",
      failed: "CrossMark",
      cancelled: null,
    }[state];
    const ownedTypes = new Set(["OK", "OneSecond", "OnIt", "CheckMark", "CrossMark"]);
    const obsolete: string[] = [];
    let found = false;
    let cursor = "";
    const cursors = new Set<string>();
    do {
      if (cursors.has(cursor)) throw new Error("Feishu reaction pagination repeated");
      cursors.add(cursor);
      const response = await fetchBotProviderJson<{
        code?: number;
        msg?: string;
        data?: {
          has_more?: boolean;
          page_token?: string;
          items?: Array<{
            reaction_id: string;
            operator?: { operator_type?: string; operator_id?: string };
            reaction_type?: { emoji_type?: string };
          }>;
        };
      }>(`${url}?page_size=50${cursor ? `&page_token=${encodeURIComponent(cursor)}` : ""}`, {
        method: "GET",
        headers,
      });
      if (!response.ok || response.payload?.code !== 0)
        throw new Error(response.payload?.msg || "Feishu list reactions failed");
      for (const item of response.payload.data?.items ?? []) {
        // 重启后从平台核对本应用状态，绝不删除群成员或其他机器人的表情。
        if (
          item.operator?.operator_type !== "app" ||
          item.operator.operator_id !== bot.feishuAppId ||
          !ownedTypes.has(item.reaction_type?.emoji_type ?? "")
        )
          continue;
        if (item.reaction_type?.emoji_type === emoji && !found) found = true;
        else obsolete.push(item.reaction_id);
      }
      cursor = response.payload.data?.has_more ? (response.payload.data.page_token ?? "") : "";
      if (response.payload.data?.has_more && !cursor)
        throw new Error("Feishu reaction cursor missing");
    } while (cursor);
    for (const id of obsolete) {
      const response = await fetchBotProviderJson<FeishuReactionResponse>(
        `${url}/${encodeURIComponent(id)}`,
        { method: "DELETE", headers },
      );
      if (!response.ok || response.payload?.code !== 0)
        throw new Error(response.payload?.msg || "Feishu delete status reaction failed");
    }
    if (emoji && !found) {
      const response = await fetchBotProviderJson<FeishuReactionResponse>(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ reaction_type: { emoji_type: emoji } }),
      });
      if (!response.ok || response.payload?.code !== 0)
        throw new Error(response.payload?.msg || "Feishu add status reaction failed");
    }
  });
  const readDirectory = createGroupMemberDirectory();
  const getGroupMemberNames = (bot: BotConfig, chatId: string) => {
    const key = JSON.stringify([
      getFeishuDomainProvider(bot),
      bot.id,
      bot.feishuAppId,
      bot.credentialRef,
      chatId,
    ]);
    return readDirectory(key, async (cursor) => {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) throw new Error("Feishu credentials are unavailable");
      const query = new URLSearchParams({ member_id_type: "open_id", page_size: "100" });
      if (cursor) query.set("page_token", cursor);
      const response = await fetchBotProviderJson<{
        code?: number;
        msg?: string;
        data?: GroupMemberPage;
      }>(
        `${getFeishuBaseUrl(bot)}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?${query}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!response.ok || response.payload?.code !== 0 || !response.payload.data)
        throw new Error(response.payload?.msg || "Cannot read group members");
      return response.payload.data;
    });
  };
  async function trackDelivery<T>(
    bot: BotConfig,
    signal: AbortSignal | undefined,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await write();
      if (!signal?.aborted) deps.onDeliveryResult?.(bot, undefined);
      return result;
    } catch (error) {
      // 主动取消不代表飞书拒绝投递，也不能覆盖已有诊断；任务超时仍由 watcher 处理。
      if (!signal?.aborted)
        deps.onDeliveryResult?.(bot, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  const sendCard = (...args: Parameters<typeof sendFeishuInteractiveCard>) =>
    trackDelivery(args[0], args[4], () => sendFeishuInteractiveCard(...args));
  const updateCard = (...args: Parameters<typeof updateFeishuInteractiveMessage>) =>
    trackDelivery(args[0], args[4], () => updateFeishuInteractiveMessage(...args));
  const sendReplyCard = async (
    bot: BotConfig,
    token: string,
    message: BotOutboundMessage,
    card: Record<string, unknown>,
    uuid?: string,
  ): Promise<string | null> => {
    let target = message;
    for (;;) {
      try {
        return await sendCard(bot, token, message.providerUserId, card, undefined, {
          ...resolveFeishuReplyTarget(target),
          ...(uuid ? { uuid } : {}),
        });
      } catch (error) {
        const details = error as {
          deliveryRejected?: boolean;
          deliveryReplyUnavailable?: boolean;
        } | null;
        // 持久化结果由 delivery owner 记录降级目标；这里只处理命令和临时卡。
        if (
          message.deliveryId ||
          !message.providerUserId.startsWith("oc_") ||
          !details?.deliveryRejected ||
          !details.deliveryReplyUnavailable
        )
          throw error;
        const fallback = getUnavailableReplyFallback(target);
        if (!fallback) throw error;
        target = { ...target, ...fallback };
      }
    }
  };
  const botOpenIds = new Map<string, string>();
  return {
    getGroupMemberNames,
    async resolveTopic(bot, actor) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token || !actor.chatId || !actor.providerMessageId)
        throw new Error("Topic identity unavailable");
      const get = async (id: string) => {
        const response = await fetchBotProviderJson<{
          code?: number;
          data?: { items?: Array<Record<string, unknown>> };
        }>(`${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const item = response.payload?.data?.items?.find((entry) => entry.message_id === id);
        if (!response.ok || response.payload?.code !== 0 || !item || item.chat_id !== actor.chatId)
          throw new Error("Topic message scope could not be verified");
        return item;
      };
      const message = await get(actor.providerMessageId);
      const threadId = readString(message, "thread_id");
      if (!threadId || (actor.threadId && actor.threadId !== threadId))
        throw new Error("Topic scope mismatch");
      const rootMessageId = readString(message, "root_id") || actor.providerMessageId;
      const root = rootMessageId === actor.providerMessageId ? message : await get(rootMessageId);
      if (root.thread_id !== threadId) throw new Error("Topic root scope mismatch");
      const body = isRecord(root.body) ? root.body : null;
      const content = parseJsonRecord(readString(body, "content"));
      const title = readString(content, "text") || readFeishuPostText(content) || threadId;
      const position = root.thread_message_position;
      const topicUrl =
        (typeof position === "number" || typeof position === "string") &&
        /^\d+$/.test(String(position))
          ? `https://${bot.provider === "lark" ? "applink.larksuite.com" : "applink.feishu.cn"}/client/thread/open?${new URLSearchParams(
              {
                openthreadid: threadId,
                openchatid: actor.chatId,
                open_thread_id: threadId,
                open_chat_id: actor.chatId,
                thread_position: String(position),
              },
            )}`
          : undefined;
      return {
        threadId,
        rootMessageId,
        topicTitle: title.replace(/\s+/gu, " ").slice(0, 80),
        ...(topicUrl ? { topicUrl } : {}),
      };
    },
    async readTopicResourceMessage(bot, target, signal) {
      signal?.throwIfAborted();
      const token = await readTenantAccessToken(bot, deps, signal);
      if (!token) throw new Error("Feishu credentials unavailable");
      const response = await fetchBotProviderJson<{
        code?: number;
        data?: { items?: Array<Record<string, unknown>> };
      }>(
        `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(target.messageId)}`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal,
        },
      );
      const native = response.payload?.data?.items?.find(
        (item) => item.message_id === target.messageId,
      );
      if (
        !response.ok ||
        response.payload?.code !== 0 ||
        !native ||
        native.deleted === true ||
        native.chat_id !== target.chatId ||
        native.thread_id !== target.threadId
      )
        throw new Error("Archived resource must be readable in the same topic");
      const body = isRecord(native.body) ? native.body : null;
      const content = parseJsonRecord(readString(body, "content"));
      const kind = readString(native, "msg_type");
      const attachments: BotInboundAttachment[] = [];
      const add = (attachment: BotInboundAttachment | null | undefined) => {
        if (!attachment) throw new Error("Archived resource metadata unavailable");
        attachments.push({
          ...attachment,
          providerMetadata: { resourceMessageId: target.messageId },
        });
      };
      if (kind === "file" || kind === "image") add(readFeishuAttachment(kind, content));
      else if (kind === "post") {
        const visit = (value: unknown): void => {
          if (Array.isArray(value)) {
            value.forEach(visit);
            return;
          }
          if (!isRecord(value)) return;
          if (value.tag === "img") add(readFeishuAttachment("image", value));
          else Object.values(value).forEach(visit);
        };
        visit(content);
      }
      if (!attachments.length) throw new Error("Archived message has no supported resources");
      return { ...target, attachments };
    },
    async readTopicHistory(bot, request) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) throw new Error("Feishu credentials unavailable");
      const read = async (suffix: string) => {
        const response = await fetchBotProviderJson<{
          code?: number;
          msg?: string;
          data?: { items?: unknown[]; has_more?: boolean; page_token?: string };
        }>(`${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages${suffix}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok || response.payload?.code !== 0) {
          const message = response.payload?.msg || "Topic history unavailable";
          if (response.payload?.code === 99991672 || message.includes("im:message.group_msg"))
            throw new TopicHistoryPermissionError(message);
          throw new Error(message);
        }
        return response.payload.data;
      };
      const readHistoryAttachments = (kind: string, content: Record<string, unknown> | null) => {
        const items: Array<{ name: string; kind: string }> = [];
        const add = (type: "image" | "file", value: Record<string, unknown> | null) => {
          const attachment = readFeishuAttachment(type, value);
          if (attachment) items.push({ name: attachment.filename, kind: type });
        };
        if (kind === "image" || kind === "file") add(kind, content);
        else if (kind === "post") {
          const visit = (value: unknown): void => {
            if (Array.isArray(value)) {
              value.forEach(visit);
              return;
            }
            if (!isRecord(value)) return;
            if (value.tag === "img") add("image", value);
            else Object.values(value).forEach(visit);
          };
          visit(content);
        }
        return items;
      };
      const rawMessages = new Map<string, unknown>();
      const normalize = async (raw: unknown, expandCard = false) => {
        if (!isRecord(raw)) throw new Error("Invalid topic history message");
        const sender = isRecord(raw.sender) ? raw.sender : null;
        const body = isRecord(raw.body) ? raw.body : null;
        let content = parseJsonRecord(readString(body, "content"));
        const kind = readString(raw, "msg_type");
        if (
          expandCard &&
          kind === "interactive" &&
          readString(sender, "sender_type") === "app" &&
          !isRecord(content?.body)
        ) {
          // 历史接口也会返回升级客户端占位图，不能据此把操作卡片误判为普通回复。
          const data = await read(
            `/${encodeURIComponent(readString(raw, "message_id"))}?card_msg_content_type=user_card_content`,
          );
          const native = data?.items?.find(
            (item) => isRecord(item) && item.message_id === readString(raw, "message_id"),
          );
          if (
            !isRecord(native) ||
            native.chat_id !== raw.chat_id ||
            native.thread_id !== raw.thread_id
          )
            throw new Error("History card scope unavailable");
          content = parseJsonRecord(isRecord(native.body) ? native.body.content : undefined);
          if (!content) throw new Error("History card content unavailable");
        }
        rawMessages.set(readString(raw, "message_id"), raw);
        return botTopicMessageSchema.parse({
          id: readString(raw, "message_id"),
          chatId: readString(raw, "chat_id"),
          threadId: readString(raw, "thread_id"),
          senderId: readString(sender, "id"),
          senderType: readString(sender, "sender_type"),
          senderName: readString(sender, "name") || undefined,
          parentId: readString(raw, "parent_id") || undefined,
          attachments: readHistoryAttachments(kind, content),
          createdAt: Number(readString(raw, "create_time")),
          kind,
          ...(kind === "interactive" ? { controlCard: isGroupControlCard(content) } : {}),
          text:
            kind === "interactive"
              ? readGroupCardText(content)
              : kind === "text"
                ? readString(content, "text")
                : kind === "post"
                  ? readFeishuPostText(content)
                  : `[${kind}${readString(content, "file_name") ? `: ${readString(content, "file_name")}` : ""}]`,
          deleted: raw.deleted === true,
        });
      };
      const history = await readTopicHistory(request, {
        list: async (page) => {
          const query = new URLSearchParams({
            container_id_type: "thread",
            container_id: request.threadId,
            sort_type: "ByCreateTimeDesc",
            page_size: "50",
            ...(page ? { page_token: page } : {}),
          });
          const data = await read(`?${query}`);
          if (!Array.isArray(data?.items)) throw new Error("Topic history page unavailable");
          if (data.has_more && !data.page_token)
            throw new Error("Topic history cursor unavailable");
          return {
            messages: await Promise.all(data.items.map((raw) => normalize(raw))),
            next: data.has_more ? data.page_token : undefined,
          };
        },
        // 由历史读取器先确定窗口，正文展开不再作用于整页消息。
        hydrate: (message) => normalize(rawMessages.get(message.id), true),
        get: async (id) => {
          const data = await read(`/${encodeURIComponent(id)}`);
          const raw = data?.items?.find((item) => isRecord(item) && item.message_id === id);
          return normalize(raw);
        },
      });
      if (history.messages.length) {
        const names = await getGroupMemberNames(bot, request.chatId).catch(
          () => ({}) as Record<string, string>,
        );
        history.messages = history.messages.map((message) => ({
          ...message,
          senderName: names[message.senderId] || message.senderName,
        }));
      }
      return history;
    },
    async getGroupInfo(bot, chatId) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) throw new Error("Feishu credentials are unavailable");
      const response = await fetchBotProviderJson<{
        code?: number;
        msg?: string;
        data?: { name?: string; chat_mode?: string };
      }>(`${getFeishuBaseUrl(bot)}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok || response.payload?.code !== 0)
        throw new Error(response.payload?.msg || "Cannot read group information");
      return {
        name: response.payload.data?.name || chatId,
        chatMode: response.payload.data?.chat_mode === "topic" ? "topic" : "group",
      };
    },
    async prepareCallbackPayload(bot, payload) {
      if (!isRecord(payload)) return payload;
      const event = isRecord(payload.event) ? payload.event : payload;
      const action = isRecord(event.action) ? event.action : null;
      const actionValue = isRecord(action?.value) ? action.value : null;
      const behavior = Array.isArray(action?.behaviors) ? action.behaviors.find(isRecord) : null;
      const behaviorValue = isRecord(behavior?.value) ? behavior.value : null;
      const card = botGroupCardSchema.safeParse(actionValue?.groupCard ?? behaviorValue?.groupCard);
      if (card.success) {
        const context = isRecord(event.context) ? event.context : null;
        const chatId = readString(context, "open_chat_id") || readString(context, "chat_id");
        const cardId = readString(context, "open_message_id") || readString(context, "message_id");
        // 卡片回调只有短响应窗口，位置验证与 token 请求共用同一 deadline。
        const signal = AbortSignal.timeout(1500);
        const token = await readTenantAccessToken(bot, deps, signal);
        signal.throwIfAborted();
        if (!token || !cardId || chatId !== card.data.chatId)
          throw new Error("Card scope unavailable");
        const response = await fetchBotProviderJson<{
          code?: number;
          data?: { items?: Array<Record<string, unknown>> };
        }>(`${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(cardId)}`, {
          headers: { authorization: `Bearer ${token}` },
          signal,
        });
        const native = response.payload?.data?.items?.find((item) => item.message_id === cardId);
        // 按钮参数不是原生位置真源；必须验证卡片实际所在的话题。
        if (
          !response.ok ||
          response.payload?.code !== 0 ||
          native?.chat_id !== chatId ||
          (readString(native ?? null, "thread_id") || undefined) !== card.data.threadId
        )
          throw new Error("Card topic scope mismatch");
        return payload;
      }
      const message = isRecord(event.message) ? event.message : null;
      if (readString(message, "chat_type") !== "group") return payload;
      const messageSender = isRecord(event.sender) ? event.sender : null;
      if (
        isFeishuBotSender(readString(messageSender, "sender_type")) &&
        (readString(message, "message_type") || readString(message, "msg_type")) ===
          "interactive" &&
        isGroupControlCard(parseJsonRecord(message?.content))
      )
        return payload;
      const identityKey = `${bot.provider}:${bot.feishuAppId}`;
      let openId = botOpenIds.get(identityKey);
      if (!openId) {
        const token = await readTenantAccessToken(bot, deps);
        if (!token) throw new Error("Feishu credentials are unavailable");
        const response = await fetchBotProviderJson<{
          code?: number;
          msg?: string;
          bot?: { open_id?: string };
        }>(`${getFeishuBaseUrl(bot)}/open-apis/bot/v3/info`, {
          headers: { authorization: `Bearer ${token}` },
        });
        openId = response.payload?.bot?.open_id;
        if (!response.ok || response.payload?.code !== 0 || !openId)
          throw new Error(response.payload?.msg || "Cannot resolve Feishu bot identity");
        botOpenIds.set(identityKey, openId);
      }
      let nativeCardContent: Record<string, unknown> | undefined;
      if (
        isFeishuBotSender(readString(messageSender, "sender_type")) &&
        (readString(message, "message_type") || readString(message, "msg_type")) === "interactive"
      ) {
        const currentContent = parseJsonRecord(message?.content);
        // 默认事件/历史内容可能只是升级客户端占位图；先读取真实正文再分类。
        if (!isRecord(currentContent?.body)) {
          const token = await readTenantAccessToken(bot, deps);
          if (!token) throw new Error("Card credentials unavailable");
          const response = await fetchBotProviderJson<{
            code?: number;
            data?: {
              items?: Array<{
                message_id?: string;
                chat_id?: string;
                thread_id?: string;
                body?: { content?: string };
              }>;
            };
          }>(
            `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(readString(message, "message_id"))}?card_msg_content_type=user_card_content`,
            { headers: { authorization: `Bearer ${token}` } },
          );
          const native = response.payload?.data?.items?.[0];
          if (
            !response.ok ||
            response.payload?.code !== 0 ||
            native?.message_id !== readString(message, "message_id") ||
            native.chat_id !== readString(message, "chat_id") ||
            (native.thread_id || "") !== readString(message, "thread_id")
          )
            throw new Error("Card message scope unavailable");
          nativeCardContent = parseJsonRecord(native.body?.content) ?? undefined;
          if (!nativeCardContent) throw new Error("Card content unavailable");
        }
      }
      const sender = isRecord(event.sender) ? event.sender : null;
      const parentId = readString(message, "parent_id");
      const rootId = readString(message, "root_id");
      let topicRootIsCurrentBot = false;
      let referencedAttachment: BotInboundAttachment | undefined;
      let referencedMessage: BotInboundMessage["referencedMessage"];
      const referencedInlineImages: Array<{ imageKey: string; messageId: string }> = [];
      if (
        parentId &&
        (readString(sender, "sender_type") === "user" ||
          (isFeishuBotSender(readString(sender, "sender_type")) &&
            readString(isRecord(sender?.sender_id) ? sender.sender_id : null, "open_id") !==
              openId)) &&
        !(
          payload.zcodeTopicHasAcceptedInput === true &&
          parentId === rootId &&
          !isFeishuBotSender(readString(sender, "sender_type"))
        ) &&
        (Boolean(readString(message, "thread_id")) ||
          readGroupMentionText(
            "",
            message?.mentions,
            openId,
            readString(sender, "sender_type"),
            readString(isRecord(sender?.sender_id) ? sender.sender_id : null, "open_id"),
          ) !== null)
      ) {
        const token = await readTenantAccessToken(bot, deps);
        const response = await fetchBotProviderJson<{
          code?: number;
          msg?: string;
          data?: {
            items?: Array<{
              message_id?: string;
              chat_id?: string;
              thread_id?: string;
              msg_type?: string;
              deleted?: boolean;
              create_time?: string;
              sender?: { id?: string; id_type?: string; sender_type?: string };
              body?: { content?: string };
            }>;
          };
        }>(
          // 默认卡片响应仅含“升级客户端”占位文案；必须请求真实卡片正文供引用解析。
          `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(parentId)}?card_msg_content_type=user_card_content`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        const referenced = response.payload?.data?.items?.[0];
        if (
          !response.ok ||
          response.payload?.code !== 0 ||
          referenced?.message_id !== parentId ||
          referenced.chat_id !== readString(message, "chat_id") ||
          referenced.deleted
        )
          throw new Error("Referenced attachment must be readable in the same group");
        // 引用消息可来自同群另一个话题，不能只用 chat_id 证明附件归属。
        if (
          (referenced.thread_id || undefined) !== (readString(message, "thread_id") || undefined) &&
          !(parentId === rootId && !referenced.thread_id)
        )
          throw new Error("Referenced attachment must be readable in the same topic");
        topicRootIsCurrentBot =
          parentId === rootId &&
          referenced.sender?.sender_type === "app" &&
          ((referenced.sender.id_type === "app_id" && referenced.sender.id === bot.feishuAppId) ||
            (referenced.sender.id_type === "open_id" && referenced.sender.id === openId));
        if (!["text", "post", "image", "file", "interactive"].includes(referenced.msg_type ?? "")) {
          throw new Error("Referenced message type is unsupported");
        }
        if (referenced.msg_type === "interactive") {
          // 确认文字没有专用事件类型，须通过可信 parent 消息识别，不能依赖翻译文案。
          if (
            isFeishuBotSender(readString(sender, "sender_type")) &&
            isFeishuBotSender(referenced.sender?.sender_type ?? "") &&
            isGroupControlCard(parseJsonRecord(referenced.body?.content))
          )
            return { ...payload, zcodeIgnoreInteractionMessage: true };
          const text = readGroupCardText(parseJsonRecord(referenced.body?.content));
          if (!text) throw new Error("Referenced message has no readable text");
          referencedMessage = { messageId: parentId, text };
        }
        // 文字引用此前只做权限检查后丢弃，导致仅 @ 被误判为空消息。
        if (referenced.msg_type === "text" || referenced.msg_type === "post") {
          const body = parseJsonRecord(referenced.body?.content);
          const quotedText =
            referenced.msg_type === "text" ? readString(body, "text") : readFeishuPostText(body);
          if (referenced.msg_type === "post") {
            const visit = (value: unknown): void => {
              if (Array.isArray(value)) {
                value.forEach(visit);
                return;
              }
              if (!isRecord(value)) return;
              if (value.tag === "img") {
                const image = readFeishuAttachment("image", value);
                if (!image?.providerFileId) throw new Error("Referenced image is invalid");
                referencedInlineImages.push({
                  imageKey: image.providerFileId,
                  messageId: parentId,
                });
              }
              visit(value.content ?? value.children ?? value.elements);
            };
            if (body) visit(readFeishuPostLocaleContent(body));
          }
          if (!quotedText.trim() && !referencedInlineImages.length)
            throw new Error("Referenced message is empty or unavailable");
          referencedMessage = { messageId: parentId, text: quotedText };
        }
        if (referencedMessage) {
          const senderId = referenced.sender?.id;
          const names = senderId
            ? await getGroupMemberNames(bot, referenced.chat_id!).catch(
                () => ({}) as Record<string, string>,
              )
            : {};
          const sentAt = Number(referenced.create_time);
          referencedMessage = {
            ...referencedMessage,
            ...(senderId
              ? {
                  senderId,
                  senderName:
                    names[senderId] ||
                    (senderId === openId ||
                    (referenced.sender?.sender_type === "app" && senderId === bot.feishuAppId)
                      ? bot.name
                      : undefined),
                }
              : {}),
            ...(Number.isFinite(sentAt) && sentAt > 0
              ? { sentAt: new Date(sentAt).toISOString() }
              : {}),
          };
        }
        if (referenced.msg_type === "image" || referenced.msg_type === "file") {
          const attachment = readFeishuAttachment(
            referenced.msg_type,
            parseJsonRecord(referenced.body?.content),
          );
          if (!attachment) throw new Error("Referenced attachment is invalid");
          referencedAttachment = {
            ...attachment,
            providerMetadata: { resourceMessageId: parentId },
          };
        }
      }
      return {
        ...payload,
        zcodeBotOpenId: openId,
        ...(nativeCardContent ? { zcodeNativeCardContent: nativeCardContent } : {}),
        zcodeTopicRootIsCurrentBot: topicRootIsCurrentBot,
        zcodeReferencedAttachment: referencedAttachment,
        zcodeReferencedMessage: referencedMessage,
        zcodeReferencedInlineImages: referencedInlineImages,
      };
    },
    splitStreamingReplyCardStates: splitFeishuStreamingCardStates,
    async test(bot) {
      if (!bot.enabled) {
        return { ok: false, message: "Feishu bot is disabled." };
      }
      if (!bot.feishuAppId || !bot.credentialRef) {
        return {
          ok: false,
          message: "Feishu App ID and App Secret are required.",
        };
      }
      const token = await readTenantAccessToken(bot, deps);
      return token
        ? { ok: true, message: "Feishu app credentials are valid." }
        : { ok: false, message: "Feishu app credentials are missing." };
    },

    async resolveName(bot) {
      // Bugfix: Feishu 创建向导以前只能使用手填/默认名称，容易和真实机器人名称不一致。
      // 飞书机器人能力挂在自建应用上，这里读取应用信息中的名称作为 bot 展示名。
      return readFeishuAppDisplayName(bot, deps);
    },

    async resolveActorDisplayName(bot, actor) {
      // 群事件不保证携带姓名；群成员接口避免依赖组织通讯录可见范围。
      if (actor.chatType === "group") {
        if (!actor.chatId) return null;
        return (await getGroupMemberNames(bot, actor.chatId))[actor.providerUserId] ?? null;
      }
      return readFeishuUserDisplayName(bot, deps, actor.providerUserId);
    },

    async send(bot, message) {
      resolveFeishuReplyTarget(message);
      if (message.contentParts) {
        const parts = channelContentPartsSchema.parse(message.contentParts);
        if (
          message.selection ||
          !message.providerUserId.startsWith("oc_") ||
          parts.some((part) => part.type === "channelMention" && part.channel !== bot.provider) ||
          channelContentText(parts) !== message.text ||
          message.text.length > 2000
        )
          throw Object.assign(new Error("Invalid native channel reply"), {
            deliveryRejected: true,
          });
      }
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        if (message.deliveryId)
          throw Object.assign(new Error("Feishu credentials unavailable"), {
            deliveryRejected: true,
          });
        return;
      }
      if (message.selection) {
        const providerMessageId = await sendReplyCard(
          bot,
          token,
          message,
          message.elicitation
            ? buildFeishuElicitationCardPayload(message)
            : buildFeishuInteractiveCardPayload(message),
        );
        return message.selection.action === "queue.cancel" && providerMessageId
          ? { providerMessageId }
          : undefined;
      }
      let partIndex = 0;
      let providerMessageId: string | null = null;
      for (const text of splitFeishuText(message.text)) {
        // Bugfix: Feishu 普通文本消息会把 Markdown 原样展示，和 Telegram 的 Markdown 回复不一致。
        // 改用交互卡片的 markdown 元素承载普通回复，选择消息也继续复用同一套卡片结构。
        providerMessageId = await sendReplyCard(
          bot,
          token,
          message,
          buildFeishuInteractiveCardPayload({
            ...message,
            text,
            mentionedUserIds: partIndex === 0 ? message.mentionedUserIds : undefined,
            selection: undefined,
          }),
          message.deliveryId ? `${message.deliveryId.slice(0, 40)}-${partIndex}` : undefined,
        );
        partIndex += 1;
      }
      return message.deliveryId && providerMessageId ? { providerMessageId } : undefined;
    },

    async createStreamingReplyCard(bot, state, signal) {
      const token = await readTenantAccessToken(bot, deps, signal);
      if (!token) {
        return null;
      }
      const providerMessageId = await sendCard(
        bot,
        token,
        state.providerUserId,
        buildFeishuStreamingCardPayload(state),
        signal,
      );
      return providerMessageId ? { providerMessageId } : null;
    },

    async updateStreamingReplyCard(bot, handle, state, signal) {
      const token = await readTenantAccessToken(bot, deps, signal);
      if (!token) {
        return;
      }
      await updateCard(bot, token, handle, buildFeishuStreamingCardPayload(state), signal);
    },

    async createTransientInteractionCard(bot, message) {
      resolveFeishuReplyTarget(message);
      if (message.contentParts) {
        const parts = channelContentPartsSchema.parse(message.contentParts);
        if (
          message.selection ||
          !message.providerUserId.startsWith("oc_") ||
          parts.some((part) => part.type === "channelMention" && part.channel !== bot.provider) ||
          channelContentText(parts) !== message.text ||
          message.text.length > 2000
        )
          throw Object.assign(new Error("Invalid native channel reply"), {
            deliveryRejected: true,
          });
      }
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        return null;
      }
      const providerMessageId = await sendReplyCard(
        bot,
        token,
        message,
        message.elicitation
          ? buildFeishuElicitationCardPayload(message)
          : buildFeishuInteractiveCardPayload(message),
      );
      return providerMessageId ? { providerMessageId } : null;
    },

    async updateTransientInteractionCard(bot, handle, message) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        return;
      }
      await updateCard(
        bot,
        token,
        handle,
        message.elicitation
          ? buildFeishuElicitationCardPayload(message)
          : buildFeishuInteractiveCardPayload(message),
      );
    },

    async deleteTransientInteractionCard(bot, handle) {
      const token = await readTenantAccessToken(bot, deps);
      if (!token) {
        return;
      }
      await deleteFeishuInteractiveMessage(bot, token, handle);
    },

    async updateInputReaction(bot, messageId, state) {
      const botKey = JSON.stringify([bot.provider, bot.id, bot.feishuAppId, bot.credentialRef]);
      reactionBots.set(botKey, bot);
      await updateReaction(JSON.stringify([botKey, messageId]), state);
    },

    async sendTyping(bot, target) {
      if (!target.providerMessageId) {
        return;
      }
      // Bugfix: 飞书/Lark 普通命令不会进入长任务 stream，之前只实现 startTyping/stopTyping，
      // 所以 /状态、/项目 等命令没有任何处理中反馈。这里只加 Typing reaction，删除由 BotService 在同步回复发送完成后显式收口。
      await addFeishuTypingReaction(bot, deps, target.providerMessageId);
    },

    async startTyping(bot, target) {
      if (!target.providerMessageId) {
        return;
      }
      // Bugfix: 飞书没有原生 typing 状态，只能用 Typing reaction 模拟。
      // reaction 不会自动消失，所以必须记录 reaction_id，任务结束或进入权限等待时再删除。
      await addFeishuTypingReaction(bot, deps, target.providerMessageId);
    },

    async stopTyping(bot, target) {
      if (!target.providerMessageId) {
        return;
      }
      await deleteFeishuTypingReaction(bot, deps, target.providerMessageId);
    },

    async acknowledgeCallback(bot, payload, text, message, signal) {
      const token = await readTenantAccessToken(bot, deps, signal);
      const cardUpdateToken = readFeishuCardUpdateToken(payload);
      const openIds = readFeishuCardUpdateOpenIds(payload);
      const originalText = readFeishuCardOriginalText(payload);
      if (!token || !cardUpdateToken || (!text?.trim() && !message?.elicitation)) {
        return;
      }
      // Bugfix: 飞书卡片按钮点击后不会像 Telegram inline keyboard 一样自动消失。
      // 使用回调携带的 card update token 更新原卡片为处理结果，避免旧选项继续留在聊天里被重复点击。
      // 非共享卡片延时更新还需要带 open_ids，否则飞书会返回 300090，旧卡片会继续留在会话里。
      // Bugfix: 用户选择后应保留原问题文案并移除按钮；仅依赖 WebSocket 回调 return 的卡片更新不稳定。
      // 因此即使按钮 value 里带了原文，也必须继续调用 card/update，只是更新文案优先使用原文。
      const response = await fetchBotProviderJson<FeishuSendMessageResponse>(
        `${getFeishuBaseUrl(bot)}/open-apis/interactive/v1/card/update`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          signal,
          body: JSON.stringify({
            token: cardUpdateToken,
            // Bugfix: Card JSON 2.0 根节点不接受 open_ids；把 open_ids 塞进 card 会触发
            // “unknown property: open_ids” 并导致按钮点击后原卡片无法移除选项。
            ...(openIds.length > 0 ? { open_ids: openIds } : {}),
            // 修复原因：新建下一题再撤回旧卡会在飞书会话中显示明显的撤回痕迹。
            // callback token 是本次点击对应的权威原地更新能力，问答推进和终态都复用同一张卡。
            card: message?.elicitation
              ? buildFeishuElicitationCardPayload(message)
              : buildFeishuInteractiveCardPayload({
                  botId: bot.id,
                  provider: bot.provider,
                  providerUserId: "",
                  // Bugfix: 飞书按钮点击后业务结果会另发一条消息；原卡片只需要移除选项按钮。
                  // 之前把原卡片改成结果文案，飞书侧会出现额外状态变化，也不符合用户对“选项消失”的预期。
                  text: originalText?.trim() || (text ?? ""),
                }),
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`Feishu update interactive card failed: HTTP ${response.status}`);
      }
      const result = response.payload ?? {};
      if (result.code !== 0) {
        throw new Error(result.msg || "Feishu update interactive card failed.");
      }
      return message?.elicitation ? { handled: true } : undefined;
    },

    async downloadAttachment(bot, attachment, actor, signal) {
      signal?.throwIfAborted();
      const token = await readTenantAccessToken(bot, deps, signal);
      if (!token || !attachment.providerFileId || !actor?.providerMessageId) {
        return null;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FEISHU_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
      try {
        const response = await fetch(
          `${getFeishuBaseUrl(bot)}/open-apis/im/v1/messages/${encodeURIComponent(attachment.providerMetadata?.resourceMessageId ?? actor.providerMessageId)}/resources/${encodeURIComponent(attachment.providerFileId)}?type=${attachment.kind === "image" ? "image" : attachment.kind === "video" ? "media" : attachment.kind}`,
          {
            headers: {
              authorization: `Bearer ${token}`,
            },
            signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          },
        );
        if (!response.ok) {
          throw new Error(`Feishu attachment download failed: HTTP ${response.status}`);
        }
        return {
          attachment,
          data: new Uint8Array(await response.arrayBuffer()),
        };
      } catch (error) {
        signal?.throwIfAborted();
        if ((error as { name?: unknown })?.name === "AbortError") {
          // Bugfix: 飞书资源接口偶发长时间不返回，必须让 bot 回调在可预期时间内给用户失败提示。
          throw new Error("Feishu attachment download timed out.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },

    parseCallback(payload): BotInboundMessage[] {
      if (!isRecord(payload)) {
        return [];
      }
      const botId = readString(payload, "botId");
      if (!botId) {
        return [];
      }
      const message = readFeishuTextMessage(botId, payload) ?? readFeishuCardAction(botId, payload);
      return message ? [message] : [];
    },
  };
}
