import { FACE_COLORS } from "@/components/workflow-timeline/WorkflowAgentFace.js";
import type { AgentColor } from "@zcode/shared";

export const SUBAGENT_COLORS: AgentColor[] = [
  "yellow",
  "red",
  "orange",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
];

// 配置标识保持兼容，色值与 workflow 共用，选择器、头像和名称不能各自维护色阶。
export const SUBAGENT_WORKFLOW_COLOR: Record<AgentColor, string> = {
  yellow: FACE_COLORS[1],
  red: FACE_COLORS[8],
  orange: FACE_COLORS[5],
  green: FACE_COLORS[7],
  cyan: FACE_COLORS[0],
  blue: FACE_COLORS[4],
  purple: FACE_COLORS[3],
  pink: FACE_COLORS[6],
};

export const SUBAGENT_COLOR_CLASS: Record<AgentColor, string> = {
  blue: "bg-sky-300 text-sky-900 dark:bg-sky-400/32 dark:text-sky-50",
  cyan: "bg-cyan-300 text-cyan-900 dark:bg-cyan-400/32 dark:text-cyan-50",
  green: "bg-emerald-300 text-emerald-900 dark:bg-emerald-400/32 dark:text-emerald-50",
  orange: "bg-orange-300 text-orange-900 dark:bg-orange-400/32 dark:text-orange-50",
  pink: "bg-pink-300 text-pink-900 dark:bg-pink-400/32 dark:text-pink-50",
  purple: "bg-violet-300 text-violet-900 dark:bg-violet-400/32 dark:text-violet-50",
  red: "bg-rose-300 text-rose-900 dark:bg-rose-400/32 dark:text-rose-50",
  yellow: "bg-amber-300 text-amber-900 dark:bg-amber-300/32 dark:text-amber-50",
};

export const SUBAGENT_TEXT_COLOR_CLASS: Record<AgentColor, string> = {
  blue: "text-sky-700 dark:text-sky-300",
  cyan: "text-cyan-700 dark:text-cyan-300",
  green: "text-emerald-700 dark:text-emerald-300",
  orange: "text-orange-700 dark:text-orange-300",
  pink: "text-pink-700 dark:text-pink-300",
  purple: "text-violet-700 dark:text-violet-300",
  red: "text-rose-700 dark:text-rose-300",
  yellow: "text-amber-700 dark:text-amber-300",
};

export function isSubagentColor(value: string): value is AgentColor {
  return (SUBAGENT_COLORS as readonly string[]).includes(value);
}

export function resolveSubagentColorFromName(name: string): AgentColor {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return SUBAGENT_COLORS[hash % SUBAGENT_COLORS.length] ?? "blue";
}
