// worktree 相关的 SessionPane → 行组件通道（docs/git/worktree.md §3.6）。
// 用 context 而非逐层透传 props：fork 目的地只在桌面主工作区存在，手机与旧壳缺省为不可用。
import { createContext, useContext } from "react";
import type { ConversationRowTarget } from "@zcode/shared/zcode-protocol-v4";

/**
 * 分叉目的地。forkToWorktree 为 null 时只保留"在当前目录分叉"的一键行为；
 * available=false 表示入口可见但 Agent 不支持，显示为禁用；
 * inWorktree 表示父任务运行在受管 worktree 中，第一项文案为"在当前 worktree 中分叉"。
 * value 必须由提供方 memo，保持行组件的稳定引用优化。
 */
export interface ForkDestinationValue {
  forkToWorktree: ((target: ConversationRowTarget) => void) | null;
  available: boolean;
  inWorktree: boolean;
}

export const ForkDestinationContext = createContext<ForkDestinationValue>({
  forkToWorktree: null,
  available: false,
  inWorktree: false,
});

export function useForkDestination(): ForkDestinationValue {
  return useContext(ForkDestinationContext);
}
