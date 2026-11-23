/**
 * shortcuts 对外契约：快捷键内核（匹配、录制、生效表、冲突策略、展示 label）的公共类型。
 * 命令表与绑定串格式在 @zcode/shared 的 shortcutCommands.ts；实现函数从各公开入口文件导入。
 */
export type {
  EffectiveShortcutBindings,
  ShortcutBindingEvent,
  ShortcutRecordResult,
} from "./bindings.js";
export type { ShortcutBindingConflict } from "./conflicts.js";
