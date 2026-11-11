// PromptMentionNode.ts 承载 Lexical 节点行为 + 全部分类图标 DOM 数据，
// 新增 plugin 图标后超出 max-lines(400) 门禁。图标数据/DOM 构建是纯展示常量，
// 与节点行为解耦到本文件；PromptMentionNode 继续 re-export 保持既有导入面兼容。
//
// PromptMentionNode 是 Lexical 自定义 DOM 节点，不能直接渲染 lucide-react 组件。
// 这里保留 lucide 的 IconNode 数据形状，再用原生 SVG DOM 生成图标。
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export type MentionLucideIconNode = ReadonlyArray<
  readonly ["path" | "circle" | "rect", Readonly<Record<string, string>>]
>;

export const SKILL_MENTION_LUCIDE_ICON_NAME = "WandSparkles";
export const SKILL_MENTION_ICON_NODE = [
  [
    "path",
    {
      d: "m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72",
    },
  ],
  ["path", { d: "m14 7 3 3" }],
  ["path", { d: "M5 6v4" }],
  ["path", { d: "M19 14v4" }],
  ["path", { d: "M10 2v2" }],
  ["path", { d: "M7 8H3" }],
  ["path", { d: "M21 16h-4" }],
  ["path", { d: "M11 3H9" }],
] as const satisfies MentionLucideIconNode;

export const SUBAGENT_MENTION_LUCIDE_ICON_NAME = "Bot";
export const SUBAGENT_MENTION_ICON_NODE = [
  ["path", { d: "M12 8V4H8" }],
  ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }],
  ["path", { d: "M2 14h2" }],
  ["path", { d: "M20 14h2" }],
  ["path", { d: "M15 13v2" }],
  ["path", { d: "M9 13v2" }],
] as const satisfies MentionLucideIconNode;

// 与地址栏「选择元素」按钮同一个图标（MousePointerClick），一眼看出是点选来的元素
export const ELEMENT_MENTION_LUCIDE_ICON_NAME = "MousePointerClick";
export const ELEMENT_MENTION_ICON_NODE = [
  ["path", { d: "M14 4.1 12 6" }],
  ["path", { d: "m5.1 8-2.9-.8" }],
  ["path", { d: "m6 12-1.9 2" }],
  ["path", { d: "M7.2 2.2 8 5.1" }],
  [
    "path",
    {
      d: "M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z",
    },
  ],
] as const satisfies MentionLucideIconNode;

export const WHITEBOARD_MENTION_LUCIDE_ICON_NAME = "Palette";
export const WHITEBOARD_MENTION_ICON_NODE = [
  [
    "path",
    {
      d: "M12 22a8 8 0 0 1-8-8 8.5 8.5 0 0 1 8.5-8.5H16a4 4 0 0 1 0 8h-1.5a2 2 0 0 0 0 4H16a6 6 0 0 1-4 4.5Z",
    },
  ],
  ["path", { d: "M7.5 14h.01" }],
  ["path", { d: "M9.5 10h.01" }],
  ["path", { d: "M14.5 9h.01" }],
  ["path", { d: "M17 12h.01" }],
] as const satisfies MentionLucideIconNode;

export const GOAL_COMMAND_MENTION_LUCIDE_ICON_NAME = "Goal";
export const GOAL_COMMAND_MENTION_ICON_NODE = [
  ["path", { d: "M12 13V2l8 4-8 4" }],
  ["path", { d: "M20.561 10.222a9 9 0 1 1-12.55-5.29" }],
  ["path", { d: "M8.002 9.997a5 5 0 1 0 8.9 2.02" }],
] as const satisfies MentionLucideIconNode;

export const WORKFLOW_COMMAND_MENTION_LUCIDE_ICON_NAME = "Workflow";
export const WORKFLOW_COMMAND_MENTION_ICON_NODE = [
  ["rect", { width: "8", height: "8", x: "3", y: "3", rx: "2" }],
  ["path", { d: "M7 11v4a2 2 0 0 0 2 2h4" }],
  ["rect", { width: "8", height: "8", x: "13", y: "13", rx: "2" }],
] as const satisfies MentionLucideIconNode;

export const COMPACT_COMMAND_MENTION_LUCIDE_ICON_NAME = "ScrollText";
export const COMPACT_COMMAND_MENTION_ICON_NODE = [
  ["path", { d: "M15 12h-5" }],
  ["path", { d: "M15 8h-5" }],
  ["path", { d: "M19 17V5a2 2 0 0 0-2-2H4" }],
  [
    "path",
    {
      d: "M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3",
    },
  ],
] as const satisfies MentionLucideIconNode;

export const COMMAND_MENTION_LUCIDE_ICON_NAME = "SquareSlash";
export const COMMAND_MENTION_ICON_NODE = [
  [
    "path",
    {
      d: "M21 5v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
    },
  ],
  ["path", { d: "m9 15 6-6" }],
] as const satisfies MentionLucideIconNode;

export const SESSION_MENTION_LUCIDE_ICON_NAME = "MessagesSquare";
export const SESSION_MENTION_ICON_NODE = [
  [
    "path",
    {
      d: "M14 9a2 2 0 0 1-2 2H6l-4 4V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z",
    },
  ],
  ["path", { d: "M18 9h2a2 2 0 0 1 2 2v10l-4-4h-6a2 2 0 0 1-2-2v-1" }],
] as const satisfies MentionLucideIconNode;

export const PLUGIN_MENTION_LUCIDE_ICON_NAME = "Cable";
export const PLUGIN_MENTION_ICON_NODE = [
  ["path", { d: "M17 19a1 1 0 0 1-1-1v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1z" }],
  ["path", { d: "M17 21v-2" }],
  ["path", { d: "M19 14V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V10" }],
  ["path", { d: "M21 21v-2" }],
  ["path", { d: "M3 5V3" }],
  ["path", { d: "M4 10a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2z" }],
  ["path", { d: "M7 5V3" }],
] as const satisfies MentionLucideIconNode;

export function createMentionSvgIcon(iconNode: MentionLucideIconNode): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("inline-block", "align-middle", "shrink-0");

  for (const [tagName, attributes] of iconNode) {
    const node = document.createElementNS(SVG_NAMESPACE, tagName);
    for (const [name, value] of Object.entries(attributes)) {
      node.setAttribute(name, value);
    }
    svg.append(node);
  }

  return svg;
}
