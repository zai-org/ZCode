import type { MentionCategory } from "@/mentions/mentionTypes.js";

export const PROMPT_MENTION_BASE_CLASS_NAME =
  // inline-flex token 用 align-middle 会按父文本基线 + x-height 对齐，不是和行盒视觉中心对齐。
  // 在输入框里 token 后继续输入正文时会低约 1px；align-top 让同 line-height 的 token 和正文共用行盒顶部基准。
  "inline-flex cursor-default items-center gap-1 align-top text-ui-base leading-5 font-medium";

export function getPromptMentionVariantClassName(category: MentionCategory): string {
  if (category === "skills") {
    return "text-skill-node-foreground";
  }
  if (category === "subagents") {
    return "text-subagent-node-foreground";
  }
  if (category === "commands") {
    return "text-command-node-foreground capitalize";
  }
  if (category === "sessions") {
    return "text-session-node-foreground";
  }
  if (category === "plugins" || category === "extensions") {
    return "text-plugin-node-foreground";
  }
  if (category === "whiteboards" || category === "elements") {
    return "text-file-node-foreground";
  }
  return "text-file-node-foreground";
}
