/**
 * 快捷键执行内核 —— 匹配、录制、生效表与冲突检测的唯一实现。
 *
 * - 键位知识（格式解析、平台修饰键语义、保留键）只允许存在于此模块与 shared/shortcutCommands.ts；
 * - 全部为纯函数，DOM 事件以结构化参数传入，便于单测覆盖组合键边界；
 * - IME 组合中（isComposing / Process / Dead / keyCode 229）与长按 repeat 一律不匹配、不录制。
 */
import {
  type ParsedShortcutBinding,
  type ShortcutCommandEntry,
  type ShortcutCommandId,
  parseShortcutBinding,
  serializeShortcutBinding,
  SHORTCUT_COMMANDS,
} from "@zcode/shared";
import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "@/lib/keyboardShortcuts.js";
import { logger } from "@/logger.js";

/** 匹配/录制所需的键盘事件结构（KeyboardEvent 的子集，测试可构造）。 */
export interface ShortcutBindingEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  /** 兼容旧事件模型；中文等 IME 组合中 Chromium 报 keyCode 229。 */
  keyCode?: number;
}

// ============================================================================
// 噪声过滤（IME / 长按）
// ============================================================================

/** 判断事件是否为 IME 组合态事件（isComposing / Process / Dead / keyCode 229）。 */
function isImeEvent(event: ShortcutBindingEvent): boolean {
  return (
    event.isComposing === true ||
    event.key === "Process" ||
    event.key === "Dead" ||
    event.keyCode === 229
  );
}

/** 判断事件是否为不应触发快捷键的噪声：长按 repeat、IME 组合中、死键。 */
export function isShortcutEventNoise(event: ShortcutBindingEvent): boolean {
  return event.repeat === true || isImeEvent(event);
}

// ============================================================================
// event.code → 规范键名映射（键盘布局差异下的可靠来源）
// ============================================================================

const CODE_TO_KEY: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [
      `Key${String.fromCharCode(65 + index)}`,
      String.fromCharCode(97 + index),
    ]),
  ),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`Digit${index}`, String(index)])),
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, `F${index + 1}`]),
  ),
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Backslash: "\\",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  // Enter 供 composer 作用域命令录制/匹配；NumpadEnter 不映射（保持未定义行为）
  Enter: "Enter",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Delete: "Delete",
  Insert: "Insert",
};

/** 规范键名 → 期望的 event.code（现有 keyboardShortcuts.getExpectedShortcutCode 的扩展版）。 */
const KEY_TO_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CODE_TO_KEY).map(([code, key]) => [key, code]),
);

// ============================================================================
// 通用匹配器
// ============================================================================

/**
 * 通用匹配：binding（规范序列化串）与键盘事件是否命中。
 *
 * 修饰键为精确匹配：事件实际按下的修饰键必须与 binding 声明完全一致，
 * 多余修饰键（如 Cmd+Ctrl+K 命中 CmdOrCtrl+K）不算命中。
 * - CmdOrCtrl：macOS = meta 且无 ctrl；Windows/Linux = ctrl 且无 meta（平台隔离沿用 keyboardShortcuts.ts）；
 * - Ctrl：显式 Ctrl；在 Windows/Linux 上与 CmdOrCtrl 同义（录制在这些平台只会产出 CmdOrCtrl）；
 * - AltGr：Windows/Linux 上物理 AltGr 被 Chromium 报为 ctrl+alt 同按。
 */
export function matchesShortcutBinding(
  event: ShortcutBindingEvent,
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  if (isShortcutEventNoise(event)) {
    return false;
  }
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return false;
  }

  const isApple = isAppleKeyboardPlatform(platformInfo);
  if (!modifiersMatch(event, parsed, isApple)) {
    return false;
  }
  return eventMatchesKey(event, parsed.key);
}

function modifiersMatch(
  event: ShortcutBindingEvent,
  parsed: ParsedShortcutBinding,
  isApple: boolean,
): boolean {
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = event;

  // AltGr 与 Ctrl+Alt 物理不可区分（Windows/Linux 的 Ctrl+Alt+B 等现有绑定就是同按），
  // 因此 AltGr 绑定与 cmdOrCtrl/ctrl + Alt 绑定匹配同一物理组合，不做独占判定。
  const wantPrimaryOrCtrl = parsed.altGr || parsed.cmdOrCtrl || (!isApple && parsed.ctrl);
  const wantCtrl = !parsed.altGr && !parsed.cmdOrCtrl && parsed.ctrl && isApple;
  const wantAlt = parsed.altGr || parsed.alt;

  // 裸键绑定（Enter/F5/方向键等无主修饰键）必须要求主修饰键抬起，
  // 否则 Cmd+Enter 会误命中裸 Enter 绑定——命令表全带主修饰键时该缺口潜伏，Enter 入表后致命。
  if (!wantPrimaryOrCtrl && !wantCtrl && (meta || ctrl)) {
    return false;
  }

  if (wantPrimaryOrCtrl) {
    const ok = isApple ? meta && !ctrl : ctrl && !meta;
    if (!ok) {
      return false;
    }
  }
  if (wantCtrl) {
    // macOS 显式 Ctrl（系统 Emacs 编辑保留区，用户显式绑定才生效）。
    if (!ctrl || meta) {
      return false;
    }
  }
  if (wantAlt !== alt) {
    return false;
  }
  return parsed.shift === shift;
}

/**
 * 纯 Shift+可打印单字符绑定（如 Shift+f）判定。
 * 这类绑定与「输入大写字母」是同一物理事件；事件目标是可编辑元素时
 * 命中它必须放行，否则用户在输入框打不出该大写字母（按键被 preventDefault 吞掉并触发命令）。
 */
export function isShiftOnlyPrintableBinding(binding: string): boolean {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return false;
  }
  return (
    !parsed.cmdOrCtrl &&
    !parsed.ctrl &&
    !parsed.alt &&
    !parsed.altGr &&
    parsed.shift &&
    parsed.key.length === 1
  );
}

/**
 * 快捷键事件的目标是否为可编辑元素（input/textarea/select 或 contenteditable）。
 * 与 isShiftOnlyPrintableBinding 配套：可编辑目标内跳过纯 Shift 可打印键绑定。
 * 无 DOM 环境（node 单测）下恒为 false。
 */
export function isEditableShortcutEventTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** 键匹配：event.key 小写比较优先，event.code 兜底（macOS Option 改写、非 US 布局）。 */
function eventMatchesKey(event: Pick<ShortcutBindingEvent, "key" | "code">, key: string): boolean {
  if (event.key === key) {
    return true;
  }
  if (event.key.length === 1 && event.key.toLowerCase() === key) {
    return true;
  }
  if (event.code !== undefined) {
    return KEY_TO_CODE[key] === event.code;
  }
  return false;
}

// ============================================================================
// 录制器
// ============================================================================

export type ShortcutRecordResult =
  | { kind: "pending" }
  | { kind: "binding"; binding: string }
  | { kind: "invalid"; reason: "no-modifier" | "unsupported-key" };

function isModifierOnlyKey(key: string): boolean {
  return (
    key === "Shift" ||
    key === "Control" ||
    key === "Meta" ||
    key === "Alt" ||
    key === "AltGraph" ||
    key === "OS"
  );
}

/**
 * 录制键盘事件为规范绑定串。
 *
 * - pending：纯修饰键按下 / 无可反查 code 的 IME 噪声 —— 继续等待用户按出完整组合；
 * - binding：合法组合（主修饰键平台归一：mac 的 Cmd、win/linux 的 Ctrl → CmdOrCtrl；mac 显式 Ctrl 保留为 Ctrl）；
 * - invalid：无修饰键的普通键（F 键与方向键除外）或不支持的键。
 *
 * 键名提取优先 event.code 反查物理基键（Shift+7 在任何布局都录出 "7" 而非 "&"），
 * event.key 仅作 fallback。IME 组合事件（isComposing/Process/229）的 key 不可信，但
 * event.code 仍是物理键 —— 录制是点击录制按钮后的显式意图，中文输入法开启时焦点若在
 * 可编辑元素里，Shift+字母 会被 IME 吞成组合输入，此时仍按 code 录制（匹配侧照旧过滤，
 * 见 isShortcutEventNoise）。Escape / Backspace 的录制态语义（取消/清除）由设置页 UI 处理。
 */
export function recordShortcutBinding(
  event: ShortcutBindingEvent,
  platformInfo?: KeyboardShortcutPlatformInfo,
): ShortcutRecordResult {
  if (event.repeat === true || isModifierOnlyKey(event.key)) {
    return { kind: "pending" };
  }

  if (isImeEvent(event)) {
    const codeKey = event.code !== undefined ? CODE_TO_KEY[event.code] : undefined;
    if (codeKey === undefined) {
      return { kind: "pending" };
    }
    return buildRecordedBinding(event, codeKey, platformInfo);
  }

  const key =
    event.code !== undefined
      ? (CODE_TO_KEY[event.code] ?? normalizeEventKey(event.key))
      : normalizeEventKey(event.key);
  if (key === null) {
    return { kind: "invalid", reason: "unsupported-key" };
  }
  return buildRecordedBinding(event, key, platformInfo);
}

/** 录制尾部：修饰键校验 + 平台归一 + 序列化（键名已由调用方提取）。 */
function buildRecordedBinding(
  event: ShortcutBindingEvent,
  key: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): ShortcutRecordResult {
  const isApple = isAppleKeyboardPlatform(platformInfo);
  const hasModifier = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
  // F 键 / 方向键等命名键（多字符）允许无修饰单键；普通字符键必须至少一个修饰键。
  const namedKey = key.length > 1;
  if (!hasModifier && !namedKey) {
    return { kind: "invalid", reason: "no-modifier" };
  }

  const parsed: ParsedShortcutBinding = {
    // AltGr 与 Ctrl+Alt 物理不可区分，录制统一产出 CmdOrCtrl+Alt（用户心智里按的就是 Ctrl+Alt）。
    cmdOrCtrl: isApple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey,
    ctrl: isApple ? event.ctrlKey && !event.metaKey : false,
    alt: event.altKey,
    shift: event.shiftKey,
    altGr: false,
    key,
  };

  // mac 的 Cmd+Ctrl+组合、win/linux 的纯 Meta（Win 键）组合经平台归一后
  // cmdOrCtrl/ctrl 双双归 false，而上面 hasModifier 用原始事件校验已放行，序列化产物会变成
  // 裸单键（如 "k"）——不在保留黑名单、不触发冲突检测，落盘后全应用每次裸按该键都命中
  // 命令并吞掉输入。序列化前校验主修饰键没有在归一中丢失。
  if ((event.metaKey || event.ctrlKey) && !parsed.cmdOrCtrl && !parsed.ctrl) {
    return { kind: "invalid", reason: "unsupported-key" };
  }

  const binding = serializeShortcutBinding(parsed);
  if (binding === null) {
    return { kind: "invalid", reason: "unsupported-key" };
  }
  return { kind: "binding", binding };
}

/** event.key → 规范键名（仅 fallback 路径）：单字符小写化，命名键原样。 */
function normalizeEventKey(rawKey: string): string | null {
  if (rawKey.length === 1) {
    return /^[a-zA-Z0-9[\]=\-,./;'\\`]$/.test(rawKey) ? rawKey.toLowerCase() : null;
  }
  return rawKey in KEY_TO_CODE ? rawKey : null;
}

// ============================================================================
// 录制态抑制
// ============================================================================

let shortcutRecordingActive = false;

/**
 * 设置页进入快捷键录制态时置 true。
 * 录制监听与 useAppKeyboard 同为 window capture 监听，但注册更晚（点击录制按钮才挂），
 * 同阶段先注册先执行——录制按下的组合会先触发原命令再进入录制处理，改键永远不成功。
 * useAppKeyboard 分发前检查此标记短路；menu 通道由 platform.setShortcutRecordingActive
 * 通知 main 暂时摘除菜单 accelerator（macOS 系统菜单会先于 renderer 吃掉按键）。
 */
export function setShortcutRecordingActive(active: boolean): void {
  shortcutRecordingActive = active;
}

export function isShortcutRecordingActive(): boolean {
  return shortcutRecordingActive;
}

// ============================================================================
// 生效表
// ============================================================================

export type EffectiveShortcutBindings = Readonly<Record<ShortcutCommandId, readonly string[]>>;

/**
 * 物理等价归一：匹配侧把平台等价组合视为同一物理键
 * （win/linux 的 CmdOrCtrl ≡ 显式 Ctrl，AltGr 叠加 Alt 位），冲突检测与默认键让位若只做字符串
 * 精确比较，录制器的平台归一产物（如 win 上录 ⌃M 产出 "CmdOrCtrl+m"）会漏掉对
 * 显式 Ctrl 绑定（工具条三键 "Ctrl+m" 等）的比对，造成无提示静默遮蔽。
 * 归一按 modifiersMatch 的语义折算成稳定比较键：
 * - 非 apple：primary = cmdOrCtrl | ctrl | altGr（同一物理主修饰），alt = alt | altGr
 * - apple：primary = cmdOrCtrl（meta），secondaryCtrl = ctrl（独立物理键），alt = alt | altGr
 * 生效表让位（本文件）与冲突检测（conflicts.ts）共用这一份口径。
 */
export function canonicalShortcutBindingKey(binding: string, isApple: boolean): string | null {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) {
    return null;
  }
  if (isApple) {
    // apple 上 modifiersMatch 的 wantPrimaryOrCtrl 同样把 altGr 算作主修饰
    // （AltGr+m ≡ ⌘⌥M ≡ CmdOrCtrl+Alt+m），canonical 主修饰位必须一并折算。
    return `${parsed.cmdOrCtrl || parsed.altGr ? 1 : 0}${parsed.ctrl ? 1 : 0}${
      parsed.alt || parsed.altGr ? 1 : 0
    }${parsed.shift ? 1 : 0}:${parsed.key}`;
  }
  return `${parsed.cmdOrCtrl || parsed.ctrl || parsed.altGr ? 1 : 0}${
    parsed.alt || parsed.altGr ? 1 : 0
  }${parsed.shift ? 1 : 0}:${parsed.key}`;
}

/**
 * 计算生效表：命令表默认绑定 + 用户覆盖（整组替换）。
 * 显式空数组 = 用户清除为「未设置」（生效表为空，不回退默认——抢绑会把被抢命令清到这个状态）；
 * 全部条目非法时回退默认（手改 setting.json 写入非法条目不得让快捷键整体失效）。
 *
 * 默认键让位显式覆盖（docs/desktop/shortcut-settings-spec.md §5）：快捷键自定义发版后再新增命令，
 * 它的默认键可能已被用户显式绑给别的命令。没有覆盖的 window 通道命令去掉与「同作用域其他命令
 * 显式覆盖」物理等价的默认键，用户原有绑定不被静默抢占，设置页随之显示「未分配」。
 * 结果只由 overrides 推导，不写盘：用户撤掉那条覆盖后默认键自动回来。
 * menu 通道默认键由 main 侧 resolveMenuAccelerator 解析，不做让位，避免两侧不一致。
 */
export function resolveEffectiveShortcutBindings(
  overrides?: Record<string, readonly string[]>,
  platformInfo?: KeyboardShortcutPlatformInfo,
): EffectiveShortcutBindings {
  // 用户显式覆盖的合法条目；全部非法的命令按未覆盖处理（回退默认）。
  const explicit = new Map<ShortcutCommandId, readonly string[]>();
  for (const entry of SHORTCUT_COMMANDS) {
    const override = overrides?.[entry.id];
    if (override === undefined) {
      continue;
    }
    const valid = override.filter((binding) => parseShortcutBinding(binding) !== null);
    if (override.length > 0 && valid.length === 0) {
      logger.warn("[shortcuts] 覆盖绑定全部非法，回退默认", { commandId: entry.id, override });
      continue;
    }
    if (valid.length !== override.length) {
      logger.warn("[shortcuts] 忽略非法覆盖条目", { commandId: entry.id, override });
    }
    explicit.set(entry.id, valid);
  }

  const isApple = isAppleKeyboardPlatform(platformInfo);
  const effective = {} as Record<ShortcutCommandId, readonly string[]>;
  for (const entry of SHORTCUT_COMMANDS) {
    const own = explicit.get(entry.id);
    if (own !== undefined) {
      effective[entry.id] = own;
      continue;
    }
    if (entry.channel === "menu" || explicit.size === 0) {
      effective[entry.id] = entry.defaultBindings;
      continue;
    }
    const kept = entry.defaultBindings.filter(
      (binding) => !isTakenByOtherExplicitOverride(entry, binding, explicit, isApple),
    );
    effective[entry.id] =
      kept.length === entry.defaultBindings.length ? entry.defaultBindings : kept;
  }
  return effective;
}

/** 默认键是否已被同作用域其他命令的显式覆盖占用（物理等价比较）。 */
function isTakenByOtherExplicitOverride(
  entry: ShortcutCommandEntry,
  binding: string,
  explicit: ReadonlyMap<ShortcutCommandId, readonly string[]>,
  isApple: boolean,
): boolean {
  const key = canonicalShortcutBindingKey(binding, isApple);
  if (key === null) {
    return false;
  }
  const scope = entry.scope ?? "global";
  for (const other of SHORTCUT_COMMANDS) {
    if (other.id === entry.id || (other.scope ?? "global") !== scope) {
      continue;
    }
    const otherBindings = explicit.get(other.id);
    if (
      otherBindings?.some((candidate) => canonicalShortcutBindingKey(candidate, isApple) === key)
    ) {
      return true;
    }
  }
  return false;
}
