import type { GoalStatus } from "@zcode/contracts";

/**
 * 普通 queue 的唯一自动提升闸门。fail-open 不在这里开旁路：verifier 仍先把
 * target 持久化为 complete，再与显式 pass 共用这一条判断。
 */
export function shouldAutoDrainV4QueueHead(input: {
  autoDrain: boolean;
  dispatchState: "queued" | "reserved" | "promoting";
  /** 队首正被 composer 编辑态冻结：续跑停在这里，后面的项保持顺序等待。 */
  editLocked?: boolean;
  sessionBusy: boolean;
  targetStatus: GoalStatus | null;
}): boolean {
  return (
    input.autoDrain &&
    input.dispatchState === "queued" &&
    input.editLocked !== true &&
    !input.sessionBusy &&
    (input.targetStatus === null || input.targetStatus === "complete")
  );
}
