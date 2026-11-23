import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";

// 结束的 agent 在这段时间内仍补回；超过后只能靠摘要里的 agentId 找回。
const ENDED_AGENT_RESTATE_WINDOW_MS = 30_000;
const SHELL_DESCRIPTION_MAX_CHARS = 200;
const SHELL_COMMAND_MAX_CHARS = 500;
const STOPPED_STATUSES = new Set<RuntimeTaskSnapshot["status"]>(["killed", "cancelled", "stopped"]);
// 不可见字符：不成对的代理码位、格式字符、私用区字符、未分配码位和 Default_Ignorable 字符。
const INVISIBLE_CHARS = /[\p{Cs}\p{Cf}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * compaction 后补回的后台任务状态：summary 返回后由调用方读一次本 runtime 的注册表传进来。
 * 先 agent 后 Bash，各按登记顺序；规则与文字见 docs/design/v2/rewind-compact.md「后台任务状态」。
 * 修复原因：压缩后不补回任务状态，摘要没写到的运行中任务会被模型遗忘，可能重复启动同一个任务。
 */
export function buildCompactTaskStatusEntries(input: {
  tasks: readonly RuntimeTaskSnapshot[];
  branchGeneration: number;
  now: Date;
  /** 有 SendMessage 工具。 */
  canContinueAgent: boolean;
  /** 有 Read 或 Bash 工具，可以读输出文件。 */
  canReadOutputFile: boolean;
}): RuntimeAttachmentEntry[] {
  const current = input.tasks.filter(
    (task) => (task.branchGeneration ?? input.branchGeneration) === input.branchGeneration,
  );
  const agents = current.flatMap((task) => {
    const text = agentStatusText(task, input);
    return text === undefined ? [] : [text];
  });
  const shells = current.flatMap((task) => {
    const text = shellStatusText(task, input.canReadOutputFile);
    return text === undefined ? [] : [text];
  });
  return [...agents, ...shells].map((text) => systemReminderAttachmentEntry("task_status", text));
}

function agentStatusText(
  task: RuntimeTaskSnapshot,
  input: { now: Date; canContinueAgent: boolean },
): string | undefined {
  if (task.type !== "local_agent") return undefined;
  const id = escapeText(task.taskId);
  const description = escapeText(task.description ?? "");
  if (task.status === "running") {
    return [
      `Background agent "${description}" (${id}) is still running.`,
      `Do NOT spawn a duplicate. You will be notified when it completes.${
        input.canContinueAgent
          ? " Send it a message with SendMessage if you need a progress report before then."
          : ""
      }`,
    ].join(" ");
  }
  const completedAt = task.completedAt?.getTime();
  if (
    completedAt === undefined ||
    input.now.getTime() - completedAt >= ENDED_AGENT_RESTATE_WINDOW_MS
  ) {
    return undefined;
  }
  if (STOPPED_STATUSES.has(task.status)) return `Task "${description}" (${id}) was stopped.`;
  return [
    `Task ${id}`,
    "(type: local_agent)",
    `(status: ${escapeText(task.status)})`,
    `(description: ${description})`,
    ...(task.error ? [`Delta: ${escapeText(task.error)}`] : []),
    ...(input.canContinueAgent
      ? ["Send it a message with SendMessage to retrieve its result."]
      : []),
  ].join(" ");
}

function shellStatusText(
  task: RuntimeTaskSnapshot,
  canReadOutputFile: boolean,
): string | undefined {
  if (task.type !== "local_bash" || task.status !== "running" || task.isBackgrounded !== true) {
    return undefined;
  }
  const description = truncate(oneLine(task.description ?? ""), SHELL_DESCRIPTION_MAX_CHARS);
  const command =
    task.command === undefined
      ? ""
      : ` (command, shown on one line: \`${truncate(oneLine(task.command), SHELL_COMMAND_MAX_CHARS)}\`)`;
  return [
    `Background shell ${escapeText(task.taskId)} ("${description}") is still running${command}.`,
    "Do not start it again; to restart it, stop it with TaskStop first.",
    ...(canReadOutputFile && task.outputFile
      ? [`You can read its output at ${escapePath(task.outputFile)}.`]
      : []),
  ].join(" ");
}

// 去掉不可见字符和控制字符（空白类控制字符 \t \n \v \f \r 留给下一步），连续空白换成一个空格。
// 修复原因：零宽字符、双向控制符等留在补回文字里，模型看到的命令和实际命令不同，也可能藏进不可见内容。
function oneLine(text: string): string {
  const visible = Array.from(text.replace(INVISIBLE_CHARS, ""))
    .filter((char) => !isControlChar(char) || isWhitespaceControl(char))
    .join("");
  return visible.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let kept = text.slice(0, maxChars);
  // 不把代理对切成半个字符。
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return `${kept}\u2026 [+${text.length - kept.length} chars]`;
}

function escapeText(text: string): string {
  return escapeControlChars(
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );
}

function escapePath(path: string): string {
  return escapeControlChars(path.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
}

// 控制字符与 U+2028、U+2029 写成 HTML 实体。
function escapeControlChars(text: string): string {
  return Array.from(text, (char) =>
    isControlChar(char) || char === "\u2028" || char === "\u2029"
      ? `&#${char.charCodeAt(0)};`
      : char,
  ).join("");
}

// C0 与 C1 控制字符（U+0000–U+001F、U+007F–U+009F）。
function isControlChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function isWhitespaceControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x09 && code <= 0x0d;
}
