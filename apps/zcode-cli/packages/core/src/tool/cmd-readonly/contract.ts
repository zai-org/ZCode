import type { ExecutionShellSelection } from "@zcode/contracts";
import type { ToolRuntimePermissionCapabilityContext } from "../types.js";

export type { CmdReadonlyHost } from "../handlers/bash-cmd-readonly-policy.js";

/**
 * dialect 为 cmd / legacy-shell 的 Bash 调用是否可以按只读处理。
 * 只有实际执行器是 cmd.exe 时才可能返回 true；其余一律 false，交回审批 / Plan 拒绝。
 */
export type CmdShellReadOnlyCheck = (
  command: string,
  context: ToolRuntimePermissionCapabilityContext | undefined,
) => boolean;

/** session 固定的 shell 选择是否实际经 cmd.exe（`/d /s /c`）执行。 */
export type CmdExecutedShellCheck = (selection: ExecutionShellSelection | undefined) => boolean;
