/**
 * 快捷键冲突策略——保留键黑名单、物理等价归一、占用检测与二次确认抢绑。
 *
 * 从 bindings.ts 拆出（内核 vs 冲突策略分层，且 bindings.ts 有 max-lines 门禁）：
 * 键位匹配/录制/生效表仍在 bindings.ts，本模块只回答"这个绑定能不能落"。
 */
import { SHORTCUT_COMMANDS, type ShortcutCommandId } from "@zcode/shared";

import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "../lib/keyboardShortcuts.js";
import { canonicalShortcutBindingKey, resolveEffectiveShortcutBindings } from "./bindings.js";

/**
 * 保留键黑名单：浏览器/编辑原生行为、刷新与开发工具、功能键整段、
 * 组件固定交互单键。比较发生在规范化之后（canonical 键，见 checkShortcutBindingConflict）；
 * 命令表默认绑定不得与之相交（单测断言，仅限 global 作用域）。
 * 注：Escape/Enter/Tab/Space/Backspace 中 Enter 已入键名白名单（composer 作用域需要），
 * 显式列在黑名单里挡住 global 作用域；Escape/Tab/Space/Backspace 仍不在键名白名单内。
 */
export const RESERVED_BINDINGS: ReadonlySet<string> = new Set([
  // 编辑类原生行为（主修饰键组合）
  ...["c", "v", "x", "z", "a", "y", "s", "p", "l"].map((key) => `CmdOrCtrl+${key}`),
  "CmdOrCtrl+Shift+z",
  // 刷新与开发工具
  "CmdOrCtrl+r",
  "CmdOrCtrl+Shift+r",
  "CmdOrCtrl+Shift+i",
  "CmdOrCtrl+Shift+j",
  "CmdOrCtrl+Shift+c",
  // 功能键整段（F1-F12 的任何含修饰组合）
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  ...Array.from({ length: 12 }, (_, index) => `CmdOrCtrl+F${index + 1}`),
  ...Array.from({ length: 12 }, (_, index) => `CmdOrCtrl+Shift+F${index + 1}`),
  // 方向键单键（组件固定交互）
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  // Enter：键名白名单放开后 global 作用域必须显式挡住
  // （对话框确认键全局化会毁掉所有确认交互）；composer 作用域不受此限。
  "Enter",
]);

/**
 * macOS 系统菜单 role:"minimize" 的固定 accelerator ⌘M（新 场景 B）：
 * 系统菜单先于 renderer 吃键，绑上去就是死绑定，不可被任何作用域命令占用/抢绑。
 * 仅 mac 生效——win/linux 上 CmdOrCtrl+m 物理等价于 Ctrl+M（openModelMenu 默认键），
 * 走占用检测而不是保留拦截。工具条三键转正后本条是 CmdOrCtrl+m 唯一的 mac 防线。
 */
const MACOS_MENU_RESERVED_BINDINGS: ReadonlySet<string> = new Set(["CmdOrCtrl+m"]);

/**
 * 两个绑定串是否为同一物理组合（canonical 键相等）：冲突检测的归一口径对搜索复用，
 * 设置页「按组合键搜索」用它把 win 上录出的 CmdOrCtrl+m 与显式 Ctrl+m 命中为同一条。
 * 任一串解析失败即不等（与冲突检测的 null 短路语义一致）。
 */
export function isSamePhysicalBinding(
  a: string,
  b: string,
  options?: { platformInfo?: KeyboardShortcutPlatformInfo },
): boolean {
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const keyA = canonicalShortcutBindingKey(a, isApple);
  const keyB = canonicalShortcutBindingKey(b, isApple);
  return keyA !== null && keyA === keyB;
}

/** 保留键黑名单的 canonical 比较键（按平台惰性构建；canonical 化让手改 setting.json 的等价变体同样被拦）。 */
let reservedCanonicalKeysCache: {
  apple: ReadonlySet<string>;
  nonApple: ReadonlySet<string>;
} | null = null;
function getReservedCanonicalKeys(): {
  apple: ReadonlySet<string>;
  nonApple: ReadonlySet<string>;
} {
  if (reservedCanonicalKeysCache === null) {
    const apple = new Set<string>();
    const nonApple = new Set<string>();
    for (const binding of RESERVED_BINDINGS) {
      const appleKey = canonicalShortcutBindingKey(binding, true);
      if (appleKey !== null) {
        apple.add(appleKey);
      }
      const nonAppleKey = canonicalShortcutBindingKey(binding, false);
      if (nonAppleKey !== null) {
        nonApple.add(nonAppleKey);
      }
    }
    reservedCanonicalKeysCache = { apple, nonApple };
  }
  return reservedCanonicalKeysCache;
}

export interface ShortcutBindingConflict {
  kind: "reserved" | "occupied";
  /** occupied 时的占用命令。 */
  ownerCommandId?: ShortcutCommandId;
  binding: string;
}

/**
 * 冲突检测（拒绝 + 标红策略）：把 newBinding 绑定到 commandId 是否会被拒绝。
 * 返回 null 表示可绑定。commandId 自身的现有绑定不构成冲突（覆盖语义为整组替换）。
 * 作用域隔离：占用只与**同作用域**命令比对（composer 的 CmdOrCtrl+Enter
 * 与全局命令并存不算冲突）；保留黑名单只拦截 global 作用域的重绑。
 * 物理等价归一（新）：黑名单与占用比对都在 canonical 键上进行，平台等价
 * 组合（win/linux 的 CmdOrCtrl ≡ Ctrl）不会漏检。
 */
export function checkShortcutBindingConflict(
  commandId: ShortcutCommandId,
  newBinding: string,
  overrides?: Record<string, readonly string[]>,
  options?: {
    menuChannelReserved?: boolean;
    /** 缺省读运行时 navigator（单测显式传入以固定平台语义）。 */
    platformInfo?: KeyboardShortcutPlatformInfo;
  },
): ShortcutBindingConflict | null {
  const commandEntry = SHORTCUT_COMMANDS.find((entry) => entry.id === commandId);
  const commandScope = commandEntry?.scope ?? "global";
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const newKey = canonicalShortcutBindingKey(newBinding, isApple);
  // macOS ⌘M minimize 防线与作用域无关：系统菜单先于任何 renderer 分发吃键，
  // 绑到 composer 命令同样是死绑定。
  if (isApple && MACOS_MENU_RESERVED_BINDINGS.has(newBinding)) {
    return { kind: "reserved", binding: newBinding };
  }
  if (commandScope === "global") {
    if (newKey !== null && getReservedCanonicalKeys()[isApple ? "apple" : "nonApple"].has(newKey)) {
      return { kind: "reserved", binding: newBinding };
    }
  }
  const effective = resolveEffectiveShortcutBindings(overrides, options?.platformInfo);
  for (const entry of SHORTCUT_COMMANDS) {
    if (entry.id === commandId) {
      continue;
    }
    // 作用域隔离：跨作用域同键不算冲突
    if ((entry.scope ?? "global") !== commandScope) {
      continue;
    }
    for (const binding of effective[entry.id] ?? []) {
      const candidateKey = canonicalShortcutBindingKey(binding, isApple);
      if (newKey !== null && candidateKey === newKey) {
        // Web 端 menu 通道命令不可配置，但其默认键仍被根级回退监听
        // （useRootPlatformEffects 固定响应 Cmd/Ctrl+N、O）消费——按保留键拒绝，
        // 不提供抢绑入口，否则抢绑后同键双动作。
        if (options?.menuChannelReserved && entry.channel === "menu") {
          return { kind: "reserved", binding: newBinding };
        }
        return { kind: "occupied", ownerCommandId: entry.id, binding: newBinding };
      }
    }
  }
  return null;
}

/**
 * 二次确认后的「抢绑」（app 内命令占用经确认允许改绑）：
 * 把 newBinding 按行级语义绑到 commandId，并从当前占用该绑定的其他命令生效表里移除它——
 * 被抢命令写入 overrides = 其生效绑定减去 newBinding，可能为显式空数组（= 未设置，不回退默认）。
 * 物理等价归一（新）：平台等价条目（如 win 的 Ctrl+m 与 CmdOrCtrl+m）一并清除。
 * 行级语义：抢绑只改变「冲突处理方式」，不改变用户原本选择的行级操作——
 * options.mode/bindingIndex 与录制态一致：replace + 下标 → 替换该条（其余绑定保留）；
 * add 或 bindingIndex 为 null（未分配录第一条）→ 追加；缺省（旧调用方）→ 整组替换为单键。
 */
export function buildShortcutOverridesAfterSteal(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  newBinding: string,
  options?: {
    platformInfo?: KeyboardShortcutPlatformInfo;
    /** 录制模式（来自设置页 RecordingState）：replace = 行级替换，add = 追加；缺省 = 整组替换。 */
    mode?: "replace" | "add";
    /** replace 模式的目标下标。 */
    bindingIndex?: number | null;
  },
): Record<string, string[]> {
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const newKey = canonicalShortcutBindingKey(newBinding, isApple);
  const effective = resolveEffectiveShortcutBindings(overrides, options?.platformInfo);
  const commandEntry = SHORTCUT_COMMANDS.find((entry) => entry.id === commandId);
  const commandScope = commandEntry?.scope ?? "global";
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  const currentBindings = effective[commandId] ?? [];
  if (options?.mode === "replace" && options.bindingIndex != null) {
    const target = options.bindingIndex;
    next[commandId] = currentBindings.map((binding, index) =>
      index === target ? newBinding : binding,
    );
  } else if (options?.mode === "add" || options?.bindingIndex === null) {
    next[commandId] = [...currentBindings, newBinding];
  } else {
    next[commandId] = [newBinding];
  }
  for (const entry of SHORTCUT_COMMANDS) {
    if (entry.id === commandId) {
      continue;
    }
    // 作用域隔离：抢绑只清除同作用域命令的占用
    if ((entry.scope ?? "global") !== commandScope) {
      continue;
    }
    const remaining = (effective[entry.id] ?? []).filter((binding) => {
      const candidateKey = canonicalShortcutBindingKey(binding, isApple);
      return newKey === null || candidateKey !== newKey;
    });
    if (remaining.length !== (effective[entry.id] ?? []).length) {
      next[entry.id] = remaining;
    }
  }
  return next;
}

/**
 * 「添加绑定」（一个命令可挂多组键，展示 A / B）：在命令现有生效绑定
 * （含默认键）之后追加 newBinding。覆盖语义是整组替换，所以追加必须把
 * 默认+已有覆盖的完整列表写进 overrides，否则会丢掉未覆盖的默认键。
 * 同命令内的物理等价重复由调用方（设置页录制入口）先行拒绝，这里不重复校验。
 */
export function buildShortcutOverridesAfterAppend(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  newBinding: string,
): Record<string, string[]> {
  const effective = resolveEffectiveShortcutBindings(overrides);
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  next[commandId] = [...(effective[commandId] ?? []), newBinding];
  return next;
}

/**
 * 拆行模型的行级操作都基于「生效列表整体写回 overrides」，三个构建器配套使用：
 * AfterAppend（追加一条）、WithoutBindingAt（删除第 index 条，删空即显式 [] 未分配）、
 * WithBindingAt（替换第 index 条）。同命令物理等价重复由设置页录制入口先行拒绝。
 */

/** 拆行删除：把生效列表第 bindingIndex 条移除后整组写回 overrides（spec §8）。 */
export function buildShortcutOverridesWithoutBindingAt(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  bindingIndex: number,
): Record<string, string[]> {
  const effective = resolveEffectiveShortcutBindings(overrides);
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  next[commandId] = (effective[commandId] ?? []).filter((_, index) => index !== bindingIndex);
  return next;
}

/** 拆行替换：把生效列表第 bindingIndex 条换成 newBinding 后整组写回 overrides（spec §8）。 */
export function buildShortcutOverridesWithBindingAt(
  overrides: Record<string, readonly string[]> | undefined,
  commandId: ShortcutCommandId,
  bindingIndex: number,
  newBinding: string,
): Record<string, string[]> {
  const effective = resolveEffectiveShortcutBindings(overrides);
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    next[key] = [...value];
  }
  next[commandId] = (effective[commandId] ?? []).map((binding, index) =>
    index === bindingIndex ? newBinding : binding,
  );
  return next;
}
