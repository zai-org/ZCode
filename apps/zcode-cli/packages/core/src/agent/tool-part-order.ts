import { sortByCompleteIndex, type ToolPart } from "@zcode/contracts";

export function selectToolPartsForHistory(parts: ToolPart[]): ToolPart[] {
  // 提前执行失败或断流恢复会另建 part；同一声明只恢复最后新建的记录，旧 part 迟到更新不影响选择。
  // 保留所选记录的物理顺序，原始 parts 仍供 UI 和文件读取状态恢复使用。
  const latestByCallId = new Map(parts.map((part) => [part.callID, part]));
  const latestParts = parts.filter((part) => latestByCallId.get(part.callID) === part);
  // 只读工具可能先落盘；provider calls/results 共用同一份排序，不改 UI 的原始 parts。
  // 依次按 blockIndex（新记录）、declarationIndex（旧记录）排序；整组缺序号时保留原序。
  // 序号是否合法和库、请求投影一样用 isBlockIndex 判定：null、负数、小数按缺失处理，不参与排序。
  return (
    sortByCompleteIndex(latestParts, (part) => part.blockIndex) ??
    sortByCompleteIndex(latestParts, (part) => part.declarationIndex) ??
    latestParts
  );
}
