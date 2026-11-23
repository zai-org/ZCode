/**
 * shortcuts 标准用法：消费方只认命令 ID，键位匹配交给内核，生效表来自 useEffectiveShortcutBindings。
 */
import type { ShortcutCommandId } from "@zcode/shared";
import { isShortcutEventNoise, matchesShortcutBinding } from "./bindings.js";
import type { EffectiveShortcutBindings } from "./contract.js";

export function exampleMatchesCommand(
  event: KeyboardEvent,
  effective: EffectiveShortcutBindings,
  commandId: ShortcutCommandId,
): boolean {
  // 生效表为空（用户清除，或默认键让位给用户的显式绑定）时不响应。
  if (isShortcutEventNoise(event)) return false;
  return (effective[commandId] ?? []).some((binding) => matchesShortcutBinding(event, binding));
}
