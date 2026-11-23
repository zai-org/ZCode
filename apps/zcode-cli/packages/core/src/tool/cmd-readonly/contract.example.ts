import {
  isCmdExecutedShellSelection,
  isCmdShellReadOnlyCommand,
} from "../handlers/bash-cmd-readonly-policy.js";
import type { CmdExecutedShellCheck, CmdShellReadOnlyCheck } from "./contract.js";

/** Bash 运行时 capability 只在 dialect 为 cmd / legacy-shell 时调用这个判定，替代 Bash AST 判定。 */
export const exampleCmdShellReadOnlyCheck: CmdShellReadOnlyCheck = (command, context) =>
  isCmdShellReadOnlyCommand(command, context);

export const exampleCmdExecutedShellCheck: CmdExecutedShellCheck = (selection) =>
  isCmdExecutedShellSelection(selection);
