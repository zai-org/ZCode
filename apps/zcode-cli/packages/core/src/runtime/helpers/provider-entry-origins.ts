import { parseRuntimeInputPresentation } from "@zcode/contracts";
import {
  INTERRUPT_MARKER_SOURCE,
  isKnownSystemReminderSource,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import {
  formatIncomingMessage,
  inputPresentationRole,
  isMidTurnInputPresentation,
  type InputPresentationRole,
} from "../../system-reminder/incoming-message.js";
import {
  getSystemReminderDescriptor,
  wrapSystemReminderForSource,
} from "../../system-reminder/source.js";

const INCOMING_MESSAGE_SOURCE = "incoming_message";
// 空闲整批相邻两条通知块之间的分隔。
const TASK_NOTIFICATION_BLOCK_SEPARATOR = "\n";

/** 仅单次请求拥有的投影映射；不写入 canonical history 或 provider payload。 */
export class ProviderEntryOrigins {
  private readonly origins = new WeakMap<RuntimeMessageEntry, readonly RuntimeMessageEntry[]>();

  get(entry: RuntimeMessageEntry): readonly RuntimeMessageEntry[] {
    return this.origins.get(entry) ?? [entry];
  }

  set(entry: RuntimeMessageEntry, inputs: readonly RuntimeMessageEntry[]): void {
    this.origins.set(
      entry,
      inputs.flatMap((input) => this.get(input)),
    );
  }

  /**
   * 承载原始顺序中最后一条真实用户输入的投影条目位置；没有时为 -1。
   * 修复原因：MCS 下 guide 并入 run 末尾的 system，可能排到之后的真实 prompt 后面；按投影位置
   * 取最后一个带真实用户来源的条目会选中这条 system，prompt 里的图片失去媒体预算保护。
   */
  latestRealUserIndex(
    projected: readonly RuntimeMessageEntry[],
    canonical: readonly RuntimeMessageEntry[],
  ): number {
    const latest = canonical.findLast(isCanonicalRealUser);
    return latest ? projected.findIndex((entry) => this.get(entry).includes(latest)) : -1;
  }

  representative(entry: RuntimeMessageEntry): RuntimeMessageEntry | undefined {
    const entries = this.get(entry);
    return (
      entries.findLast(isCanonicalRealUser) ??
      entries.findLast((item) => !isRuntimeAttachmentEntry(item))
    );
  }
}

function isCanonicalRealUser(entry: RuntimeMessageEntry): boolean {
  return (
    !isRuntimeAttachmentEntry(entry) &&
    entry.queryScope !== "output_token_continuation" &&
    entry.message.role === "user" &&
    !entry.message.toolCallId &&
    !entry.message.toolName &&
    (!entry.metadata || entry.metadata.source === "real_user")
  );
}

export function isPresentedInput(entry: RuntimeMessageEntry): boolean {
  return parseRuntimeInputPresentation(entry.metadata?.inputPresentation) !== undefined;
}

export function inputRoleOf(entry: RuntimeMessageEntry): InputPresentationRole | undefined {
  const presentation = parseRuntimeInputPresentation(entry.metadata?.inputPresentation);
  return presentation && inputPresentationRole(presentation);
}

/**
 * 投影后仍是 user 消息的输入（真实 prompt、child 任务、新轮通知）。
 * 只看投影后的 entry 本身：投影成 attachment 的中途消息与 MCS 降级块都不算。
 * 不看来源映射：user_steer 的来源是 real_user，投影成 attachment 后不是 prompt。
 */
export function isUserInputMessage(entry: RuntimeMessageEntry): boolean {
  if (isRuntimeAttachmentEntry(entry) || entry.message.role !== "user") return false;
  // 带媒体的中途消息只能保留 user 消息形态，合并规则仍同 attachment。
  if (entry.metadata?.source === INCOMING_MESSAGE_SOURCE) return false;
  // compact summary 是普通 user 消息，前一条 user 文本同样以换行结尾。
  // 按 compactBoundary 判断，不按来源：summary 与旧的后台通知都用 legacy_synthetic。
  if (entry.metadata?.compactBoundary) return true;
  if (entry.metadata?.source === INTERRUPT_MARKER_SOURCE) return true;
  return isCanonicalRealUser(entry) || isPresentedInput(entry);
}

export function isMidTurnInput(entry: RuntimeMessageEntry): boolean {
  return inputRoleOf(entry) === "mid_turn";
}

/** 用户真实输入的 prompt：不含中途消息、child 任务、新轮通知、goal 续跑、中断标记和 compact summary。 */
export function isRealUserPrompt(entry: RuntimeMessageEntry): boolean {
  return isCanonicalRealUser(entry) && !isPresentedInput(entry);
}

/**
 * 开启用户轮次的输入：历史里作为普通 user 消息的输入（真实 prompt、child 任务、新轮通知、
 * 中断标记、compact summary）。中途消息是附件，不算。
 * 提醒节奏计数与中途消息的冒泡边界都按它划分。
 */
export function isUserTurnInput(entry: RuntimeMessageEntry): boolean {
  return isUserInputMessage(entry) && !isMidTurnInput(entry);
}

export function projectIncomingMessageEntries(
  entries: readonly RuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): RuntimeMessageEntry[] {
  return entries.map((entry, index) => {
    if (isRuntimeAttachmentEntry(entry) || entry.message.role !== "user") return entry;
    const presentation = parseRuntimeInputPresentation(entry.metadata?.inputPresentation);
    if (!presentation) return entry;
    const content = entry.message.content;
    const media =
      typeof content === "string" ? [] : content.filter((block) => block.type !== "text");
    const textBlocks =
      typeof content === "string"
        ? [content]
        : content.flatMap((block) => (block.type === "text" ? [block.text] : []));
    // 新轮通知不经过 Attachment 包装；在同一投影边界补齐标签与转义，保持 user 身份和原始历史。
    // 修复原因：空闲整批原来在这里按 <task-notification> 开头把连接字符串拆回各条，workflow 运行中
    // 通知不以它开头，会被并进前一条的包装。现在整批每条通知存为一个文本块，这里逐块包装，
    // 除最后一块外末尾一个 "\n"：与逐条 user 消息相邻合并后的 content 块相同，live 与冷恢复一致。
    if (presentation === "task_notification" && media.length === 0 && textBlocks.length > 1) {
      const projected: RuntimeMessageEntry = {
        ...entry,
        message: {
          ...entry.message,
          content: textBlocks.map((notification, blockIndex) => ({
            type: "text",
            text: `${wrapSystemReminderForSource(
              INCOMING_MESSAGE_SOURCE,
              formatIncomingMessage(notification, presentation),
            )}${blockIndex < textBlocks.length - 1 ? TASK_NOTIFICATION_BLOCK_SEPARATOR : ""}`,
          })),
        },
      };
      origins.set(projected, [entry]);
      return projected;
    }
    const body = textBlocks.join("\n");
    // 单条通知与旧版本存成一个连接字符串的整批都只包装一次，与已发布版本相同。
    const text =
      presentation === "task_notification"
        ? wrapSystemReminderForSource(
            INCOMING_MESSAGE_SOURCE,
            formatIncomingMessage(body, presentation),
          )
        : formatIncomingMessage(body, presentation, {
            inHumanTurn:
              presentation === "task_notification_steer" && isInHumanTurn(entries, index),
          });
    // 中途消息（含人类 guide）都走 attachment，MCS 下并入 run 的 system。
    // 修复原因：人类 guide 曾在 MCS 下单独投影为 user 文本并移到 run 末尾，与其他中途消息、
    // MCS 关和已发布版本都不同；guide 是轮内提示，按同一规则投影。
    const asAttachment = isMidTurnInputPresentation(presentation);
    // 带图中途消息同样需要前缀与说明，否则模型会把它当作新的用户轮次。
    // 文本块换行连接后只包装一次放在首块，媒体按原顺序在后。
    // attachment 只能是字符串，这里保留 user 消息形态并在本处补齐包装。
    const projected: RuntimeMessageEntry =
      media.length > 0
        ? {
            message: {
              ...entry.message,
              content: [
                {
                  type: "text",
                  text: asAttachment
                    ? wrapSystemReminderForSource(INCOMING_MESSAGE_SOURCE, text)
                    : text,
                },
                ...media,
              ],
            },
            metadata: asAttachment
              ? { source: INCOMING_MESSAGE_SOURCE, inputPresentation: presentation }
              : entry.metadata,
          }
        : asAttachment
          ? {
              kind: "attachment",
              content: text,
              metadata: { source: INCOMING_MESSAGE_SOURCE, inputPresentation: presentation },
            }
          : { ...entry, message: { ...entry.message, content: text } };
    origins.set(projected, [entry]);
    return projected;
  });
}

// 从通知往前找，跳过 attachment、system、提醒与其他中途消息；先遇到真实 prompt 即同一轮。
// 遇到 assistant、tool result 或其他 user 消息（新轮通知、child 任务、compact 摘要等）即不是。
function isInHumanTurn(entries: readonly RuntimeMessageEntry[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const entry = entries[cursor]!;
    if (isRuntimeAttachmentEntry(entry) || entry.message.role === "system") continue;
    if (entry.message.role !== "user" || entry.message.toolCallId || entry.message.toolName) {
      return false;
    }
    if (isMidTurnInput(entry) || isReminderMessage(entry)) continue;
    return isCanonicalRealUser(entry) && !isPresentedInput(entry);
  }
  return false;
}

export function isReminderMessage(entry: RuntimeMessageEntry): boolean {
  const source = entry.metadata?.source;
  if (!isKnownSystemReminderSource(source)) return false;
  const descriptor = getSystemReminderDescriptor(source);
  return descriptor.isMeta && descriptor.channel !== "real_user";
}
