import { isSessionToolName, SessionToolCallBlock } from "@/ToolCallBlocks/session/contract.js";
/** 注册表仅对四个精确工具名选择会话展示，其他工具继续原分流。 */
export function sessionRendererExample(toolName: string) {
  return isSessionToolName(toolName) ? SessionToolCallBlock : undefined;
}
