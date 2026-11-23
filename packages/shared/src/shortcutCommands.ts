/**
 * 快捷键命令表与绑定序列化格式 —— 全仓库快捷键的唯一数据源。
 *
 * 设计约束：
 * - 本文件只含纯数据 + 纯函数，不依赖 DOM / Electron，供 renderer / main / services 共用；
 * - 绑定字符串同一形式同时用于 setting.json 持久化、renderer 匹配与 Electron 菜单 accelerator 透传；
 * - 键位知识只允许收敛在这里，消费方（useAppKeyboard、设置页、菜单）不得自行解析键位。
 */

/** 快捷键命令的分发通道：window = renderer 键盘分发（三端一致）；menu = 桌面应用菜单 accelerator。 */
export type ShortcutChannel = "window" | "menu";

/** 可配置快捷键的命令 ID，与 SHORTCUT_COMMANDS 一一对应。 */
export type ShortcutCommandId =
  | "toggleInterfaceMode"
  | "openOnboarding"
  | "openCommandCenter"
  | "openSettings"
  | "findInTask"
  | "toggleSidebar"
  | "switchTheme"
  | "toggleTerminal"
  | "toggleSidePane"
  | "toggleSidePaneFullView"
  | "previousConversation"
  | "nextConversation"
  | "navigateBack"
  | "navigateForward"
  | "openModelMenu"
  | "cycleSessionMode"
  | "cycleThoughtLevel"
  | "newTask"
  | "openWorkspace"
  | "closeActiveContext"
  | "zoomIn"
  | "zoomOut"
  | "resetZoom"
  | "composerSend"
  | "composerInsertNewline"
  | "toggleVoiceInput";

/**
 * 命令作用域：global = 全局分发（useAppKeyboard / 菜单 accelerator）；
 * composer = 聊天输入框聚焦时由 Lexical 键盘行为插件消费，其余分发方零感知。
 * Enter 族键因此可以安全入表——杀伤半径被限制在输入框内。
 */
export type ShortcutScope = "global" | "composer";

export interface ShortcutCommandEntry {
  readonly id: ShortcutCommandId;
  readonly channel: ShortcutChannel;
  /** 作用域；缺省 global。 */
  readonly scope?: ShortcutScope;
  /** 默认绑定，规范形式序列化串；多条表示双默认（覆盖时整组替换）。 */
  readonly defaultBindings: readonly string[];
}

/**
 * 命令表：快捷键命令的唯一事实来源。
 * 注意：navigateBack/navigateForward 是历史前进/后退；previousConversation/nextConversation
 * 才是"上一个/下一个任务"（早期原型曾把两者标混，以本表为准）。
 */
export const SHORTCUT_COMMANDS: readonly ShortcutCommandEntry[] = [
  {
    id: "openCommandCenter",
    channel: "window",
    defaultBindings: ["CmdOrCtrl+k", "CmdOrCtrl+Shift+p"],
  },
  // 打开设置页：mac ⌘, / win·linux Ctrl+,（系统惯例，如 macOS Settings…、VSCode）
  { id: "openSettings", channel: "window", defaultBindings: ["CmdOrCtrl+,"] },
  { id: "findInTask", channel: "window", defaultBindings: ["CmdOrCtrl+f"] },
  { id: "toggleSidebar", channel: "window", defaultBindings: ["CmdOrCtrl+b"] },
  { id: "switchTheme", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+l"] },
  { id: "toggleTerminal", channel: "window", defaultBindings: ["CmdOrCtrl+j"] },
  { id: "toggleSidePane", channel: "window", defaultBindings: ["CmdOrCtrl+Alt+b"] },
  // Side Pane 完整视图（仅桌面注册处理器）：mac ⇧⌘F / win·linux Ctrl+Shift+F
  { id: "toggleSidePaneFullView", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+f"] },
  { id: "previousConversation", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+["] },
  { id: "nextConversation", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+]"] },
  { id: "navigateBack", channel: "window", defaultBindings: ["CmdOrCtrl+["] },
  { id: "navigateForward", channel: "window", defaultBindings: ["CmdOrCtrl+]"] },
  // composer 工具条动作（原固定热键转正）：显式 Ctrl 修饰（mac 上也是 Ctrl，
  // 与旧 matchesCtrlShortcut 语义一致），由工具条的 window capture 监听按生效表消费。
  { id: "openModelMenu", channel: "window", defaultBindings: ["Ctrl+m"] },
  { id: "cycleSessionMode", channel: "window", defaultBindings: ["Ctrl+Shift+m"] },
  { id: "cycleThoughtLevel", channel: "window", defaultBindings: ["Ctrl+t"] },
  { id: "newTask", channel: "menu", defaultBindings: ["CmdOrCtrl+n"] },
  { id: "openWorkspace", channel: "menu", defaultBindings: ["CmdOrCtrl+o"] },
  { id: "closeActiveContext", channel: "menu", defaultBindings: ["CmdOrCtrl+w"] },
  { id: "zoomIn", channel: "menu", defaultBindings: ["CmdOrCtrl+="] },
  { id: "zoomOut", channel: "menu", defaultBindings: ["CmdOrCtrl+-"] },
  { id: "resetZoom", channel: "menu", defaultBindings: ["CmdOrCtrl+0"] },
  // composer 作用域：由输入框 Lexical 插件消费，不进 useAppKeyboard / 菜单。
  // channel 仅作类型占位（渲染进程行为），分发方按 scope 识别。
  { id: "composerSend", channel: "window", scope: "composer", defaultBindings: ["Enter"] },
  {
    id: "composerInsertNewline",
    channel: "window",
    scope: "composer",
    defaultBindings: ["Shift+Enter"],
  },
  { id: "toggleInterfaceMode", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+u"] },
  { id: "openOnboarding", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+o"] },
  // 语音输入（仅桌面）：由 voice-input 模块的 window capture 监听消费，useAppKeyboard 不注册处理器。
  // 快捷键自定义发版后新增，默认键遵守「让位显式覆盖」（docs/desktop/shortcut-settings-spec.md §5、§12.7）。
  { id: "toggleVoiceInput", channel: "window", defaultBindings: ["CmdOrCtrl+Shift+d"] },
];

/** 按命令 ID 取默认绑定；未知命令返回空数组（生效表 resolve 对未知命令整体忽略）。 */
export function getDefaultShortcutBindings(id: string): readonly string[] {
  return SHORTCUT_COMMANDS.find((entry) => entry.id === id)?.defaultBindings ?? [];
}

// ============================================================================
// 绑定序列化格式（Electron accelerator 兼容子集）
// ============================================================================

/** 解析后的绑定：四个修饰键开关 + 规范化键名。 */
export interface ParsedShortcutBinding {
  cmdOrCtrl: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  altGr: boolean;
  /** 规范化键名：小写字母 / 数字 / 符号字符（= - [ ] , . / ; ' ` \）/ 命名键（F1..F12、ArrowUp…）。 */
  key: string;
}

/** 序列化时修饰键的固定顺序。 */
const MODIFIER_ORDER = [
  ["CmdOrCtrl", "cmdOrCtrl"],
  ["Ctrl", "ctrl"],
  ["Alt", "alt"],
  ["Shift", "shift"],
  ["AltGr", "altGr"],
] as const satisfies ReadonlyArray<readonly [string, keyof ParsedShortcutBinding]>;

/** 菜单兼容别名归一：Plus/Equal → "="，Minus → "-"。 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  Plus: "=",
  Equal: "=",
  Minus: "-",
};

/** 单字符键：小写字母、数字与符号。大写字母不合法（录制/序列化统一小写化）。 */
const SINGLE_CHAR_KEY = /^[a-z0-9[\]=\-,./;'\\`]$/;

/** 命名键白名单（大小写敏感）。Enter 供 composer 作用域命令使用。 */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Delete",
  "Insert",
  "Enter",
]);

/** 键名规范化：合法返回规范化键名，非法返回 null。 */
export function normalizeShortcutKey(rawKey: string): string | null {
  const aliased = KEY_ALIASES[rawKey] ?? rawKey;
  if (SINGLE_CHAR_KEY.test(aliased)) {
    return aliased;
  }
  return NAMED_KEYS.has(aliased) ? aliased : null;
}

/**
 * 解析绑定串。宽容点：修饰键顺序不敏感（"Shift+CmdOrCtrl+p" 可解析）；
 * 严格点：键名必须规范形式（大写字母、裸 "+"、未知命名键均非法），重复修饰键非法。
 */
export function parseShortcutBinding(binding: string): ParsedShortcutBinding | null {
  const tokens = binding.split("+");
  // 末位必须是键；"+" 自身不是合法键（用 "=" 或别名 Plus），split 产生空 token 即非法。
  const keyToken = tokens[tokens.length - 1];
  if (keyToken === undefined || keyToken === "") {
    return null;
  }

  const parsed: ParsedShortcutBinding = {
    cmdOrCtrl: false,
    ctrl: false,
    alt: false,
    shift: false,
    altGr: false,
    key: "",
  };

  for (const token of tokens.slice(0, -1)) {
    const modifier = MODIFIER_ORDER.find(([name]) => name === token);
    if (!modifier || parsed[modifier[1]]) {
      // 未知修饰键（含 Meta/Command 等 Electron 修饰名）或重复修饰键均非法。
      return null;
    }
    parsed[modifier[1]] = true;
  }

  const key = normalizeShortcutKey(keyToken);
  if (key === null) {
    return null;
  }
  parsed.key = key;
  return parsed;
}

/** 序列化为规范形式（修饰键按固定顺序 + 规范键名）；任一部分非法返回 null。 */
export function serializeShortcutBinding(parsed: ParsedShortcutBinding): string | null {
  const key = normalizeShortcutKey(parsed.key);
  if (key === null) {
    return null;
  }

  const parts: string[] = [];
  for (const [name, field] of MODIFIER_ORDER) {
    if (parsed[field]) {
      parts.push(name);
    }
  }
  parts.push(key);
  return parts.join("+");
}

/** 绑定串是否为合法规范形式（parse 后重新 serialize 与原串一致）。 */
export function isValidShortcutBinding(binding: string): boolean {
  const parsed = parseShortcutBinding(binding);
  return parsed !== null && serializeShortcutBinding(parsed) === binding;
}
