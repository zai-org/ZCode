/**
 * 语音输入快捷键 toggleVoiceInput（docs/chat/composer-voice-input.md「快捷键」）。
 *
 * - 按一次等同点击麦克风按钮：先把焦点移到输入框，再调用 hook 的 toggle；状态仍只由 toggle 驱动。
 * - 键位读生效表（默认 CmdOrCtrl+Shift+D，可改绑；被用户显式绑给别的命令时生效表为空，不响应）。
 * - 一个窗口可能挂着多个 Composer：是否归本 Composer 处理由调用方的 ownsEvent 判定
 *   （SessionPane 按事件目标所在的对话区域路由），本 hook 不认识 pane。
 * - 「识别中」与按钮一致完全不响应：不拦截按键，不移动焦点。
 * - 纯 Shift+可打印字符绑定在可编辑目标内不匹配，与 useAppKeyboard 的豁免规则一致。
 * - 每次按键只有一条 lifecycle 日志，不随消息流增长。
 */
import { useEffect, useRef, type MutableRefObject } from "react";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { logger } from "@/logger.js";
import {
  isEditableShortcutEventTarget,
  isShiftOnlyPrintableBinding,
  isShortcutEventNoise,
  isShortcutRecordingActive,
  matchesShortcutBinding,
} from "@/shortcuts/bindings.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import type { VoiceInputState } from "@/voice-input/contract.js";

export function useVoiceInputShortcut(options: {
  /** 麦克风按钮显示时才生效 */
  enabled: boolean;
  /** 这次按键是否归本 Composer 处理；缺省表示本 Composer 不接收快捷键 */
  ownsEvent: ((event: KeyboardEvent) => boolean) | undefined;
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  state: VoiceInputState;
  toggle: () => void;
}): string {
  const { enabled, ownsEvent, inputApiRef, state, toggle } = options;
  const effective = useEffectiveShortcutBindings();
  const bindings = effective.toggleVoiceInput;
  const latestRef = useRef({ bindings, ownsEvent, state, toggle });
  latestRef.current = { bindings, ownsEvent, state, toggle };
  const active = enabled && ownsEvent !== undefined && bindings.length > 0;

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      // 录制快捷键时键盘归录制器独占；长按与输入法组合不触发。
      if (event.defaultPrevented || isShortcutEventNoise(event) || isShortcutRecordingActive()) {
        return;
      }
      const current = latestRef.current;
      // 修复原因：用户可把语音输入改绑为纯 Shift+字符（如 Shift+D），它与「输入大写字母」是同一物理事件。
      // 本监听曾漏掉 useAppKeyboard 的可编辑目标豁免，在输入框里打大写 D 会被吞掉并启动麦克风。
      // 这里复用同一条规则：可编辑目标内跳过这类绑定，非编辑区域照常匹配。
      const editableTarget = isEditableShortcutEventTarget(event.target);
      const matched = current.bindings.some(
        (binding) =>
          !(editableTarget && isShiftOnlyPrintableBinding(binding)) &&
          matchesShortcutBinding(event, binding),
      );
      if (!matched) return;
      if (!current.ownsEvent?.(event)) return;
      // 修复原因：「识别中」toggle 本身是空操作，但这里曾先 preventDefault 和 focus，
      // 会把焦点从其他输入框抢回 Composer。按钮在该状态下不执行回调，快捷键同样完全不响应。
      if (current.state === "finishing") return;
      event.preventDefault();
      logger.lifecycle.info("[voice-input] shortcut");
      // 先聚焦再 toggle：Lexical 的 focus 同步恢复上次选区（没有选区时落到末尾），
      // beginVoiceText 读到的就是用户看到的光标位置。聚焦只改选区，不算用户输入。
      inputApiRef.current?.focus();
      current.toggle();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active, inputApiRef]);

  // tooltip 展示当前生效的首个绑定；未分配时为空串，不显示键位。
  return enabled && bindings[0] ? formatShortcutBindingLabel(bindings[0]) : "";
}
