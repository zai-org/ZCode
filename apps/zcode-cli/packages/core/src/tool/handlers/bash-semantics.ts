import type { ExecutionResult } from "@zcode/contracts";
import type { ToolInputValidationContext, ToolInputValidationResult } from "../types.js";
import { supportsBashBackgroundLifecycle } from "./bash-background-lifecycle.js";
import {
  analyzeBashCommand,
  isBashCommandPermissionSafe,
  splitTopLevelBashCommands,
} from "./bash-command-parser.js";
import {
  analysisContainsGitAndDirectoryChange,
  analysisContainsGitCommand,
  isGitRuntimeContextUnsafe,
  type BashReadonlyRuntimeContext,
} from "./bash-git-runtime-safety.js";
import {
  evaluateBashReadonlyPolicy,
  hasKnownBashWriteOption,
  isSedInPlaceOption,
} from "./bash-readonly-policy.js";

export interface BashCommandClassification {
  isSearch: boolean;
  isRead: boolean;
  isList: boolean;
}

export type BashPermissionMatcher = (pattern: string) => boolean;

const EMPTY_CLASSIFICATION: BashCommandClassification = {
  isList: false,
  isRead: false,
  isSearch: false,
};

const BASH_SEARCH_COMMANDS = new Set([
  "ag",
  "ack",
  "egrep",
  "fgrep",
  "grep",
  "locate",
  "rg",
  "which",
  "whereis",
]);
const BASH_READ_COMMANDS = new Set([
  "awk",
  "cat",
  "cut",
  "file",
  "head",
  "jq",
  "less",
  "more",
  "sed",
  "sort",
  "stat",
  "strings",
  "tail",
  "tr",
  "uniq",
  "wc",
  "yq",
]);
const BASH_LIST_COMMANDS = new Set(["du", "find", "ls", "tree"]);
const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(["", ":", "echo", "false", "printf", "true"]);
const BASH_SILENT_COMMANDS = new Set([
  "cd",
  "chgrp",
  "chmod",
  "chown",
  "cp",
  "export",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "touch",
  "unset",
  "wait",
]);
const SEMANTIC_NON_ERROR_MESSAGES = new Set([
  "Condition is false",
  "Files differ",
  "No matches found",
  "Some directories were inaccessible",
]);
const SEMANTIC_NO_MATCH_COMMANDS = new Set(["egrep", "fgrep", "grep", "rg"]);
const CLAUDE_CODE_HINT_LINE_RE = /^[ \t]*<claude-code-hint\s+([^>]*?)\s*\/>[ \t]*$/gm;

export function isSearchOrReadBashCommand(command: string): BashCommandClassification {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax || analysis.hasDynamicWords) {
    return { ...EMPTY_CLASSIFICATION };
  }
  if (analysis.commands.length === 0) return { ...EMPTY_CLASSIFICATION };

  let hasList = false;
  let hasNonNeutralCommand = false;
  let hasRead = false;
  let hasSearch = false;

  for (const commandPart of analysis.commands) {
    if (commandPart.hasAssignmentPrefix) return { ...EMPTY_CLASSIFICATION };
    if (hasKnownBashWriteOption(commandPart)) return { ...EMPTY_CLASSIFICATION };

    const commandName = commandPart.name;
    if (BASH_SEMANTIC_NEUTRAL_COMMANDS.has(commandName)) continue;

    hasNonNeutralCommand = true;
    const isSearch = BASH_SEARCH_COMMANDS.has(commandName);
    const isRead = BASH_READ_COMMANDS.has(commandName);
    const isList = BASH_LIST_COMMANDS.has(commandName);
    if (!isSearch && !isRead && !isList) return { ...EMPTY_CLASSIFICATION };

    hasSearch ||= isSearch;
    hasRead ||= isRead;
    hasList ||= isList;
  }

  if (!hasNonNeutralCommand) return { ...EMPTY_CLASSIFICATION };
  return { isList: hasList, isRead: hasRead, isSearch: hasSearch };
}

export function isBashReadOnlyCommand(command: string): boolean {
  return isRuntimeReadOnlyBashCommand(command);
}

export function isSimpleReadOnlyBashCommand(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis)) return false;
  if (analysis.commands.length !== 1) return false;
  const commandPart = analysis.commands[0]!;
  return commandPart.argv.length > 0 && evaluateBashReadonlyPolicy(commandPart) === true;
}

export function isRuntimeReadOnlyBashCommand(
  command: string,
  context?: BashReadonlyRuntimeContext,
): boolean {
  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis)) return false;
  if (analysis.commands.length === 0) return false;
  if (analysisContainsGitAndDirectoryChange(analysis.commands)) return false;
  if (analysisContainsGitCommand(analysis.commands) && isGitRuntimeContextUnsafe(context))
    return false;

  let hasReadOnlyCommand = false;

  for (const commandPart of analysis.commands) {
    if (hasKnownBashWriteOption(commandPart)) return false;

    const policyResult = evaluateBashReadonlyPolicy(commandPart);
    if (policyResult === false) return false;
    if (policyResult === true) {
      hasReadOnlyCommand = true;
      continue;
    }

    return false;
  }

  return hasReadOnlyCommand;
}

export function prepareBashPermissionMatcherForCommand(
  command: string,
): BashPermissionMatcher | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0) return () => false;

  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis) || analysis.commands.length !== 1) {
    return () => true;
  }

  const commandPart = analysis.commands[0]!;
  if (commandPart.hasAssignmentPrefix || commandPart.hasRedirects) return () => true;

  const normalizedCommand = commandPart.argv.join(" ");
  if (normalizedCommand.length === 0) return () => false;
  return (pattern) => matchesBashPermissionPattern(pattern, normalizedCommand);
}

export function hasBestEffortWritePattern(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors) return false;
  return analysis.commands.some(hasKnownBashWriteOption);
}

export function isSedInPlaceBashCommand(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors) return false;
  return analysis.commands.some(
    (commandPart) => commandPart.name === "sed" && commandPart.argv.some(isSedInPlaceOption),
  );
}

export function isSilentBashCommand(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax || analysis.hasDynamicWords)
    return false;
  if (analysis.commands.length === 0) return false;

  let hasNonFallbackCommand = false;

  for (const commandPart of analysis.commands) {
    const commandName = commandPart.name;
    if (!commandName) continue;
    if (commandPart.operatorBefore === "||" && BASH_SEMANTIC_NEUTRAL_COMMANDS.has(commandName)) {
      continue;
    }

    hasNonFallbackCommand = true;
    if (!BASH_SILENT_COMMANDS.has(commandName)) return false;
  }

  return hasNonFallbackCommand;
}

export function extractBashSearchText(output: { stderr?: string; stdout?: string }): string {
  const stdout = output.stdout ?? "";
  const stderr = output.stderr ?? "";
  return stderr ? `${stdout}\n${stderr}` : stdout;
}

export function isBashResultTruncated(output: { stderr?: string; stdout?: string }): boolean {
  return lineCount(output.stdout ?? "") > 4 || lineCount(output.stderr ?? "") > 4;
}

export function stripClaudeCodeHintLines(stdout: string): string {
  if (!stdout.includes("<claude-code-hint")) return stdout;
  // 修复原因：成功路径上先剥离内部 claude-code-hint 行，再继续 image/persisted mapping；
  // 这些内部 hint 不应成为 provider-visible Bash stdout。
  return stdout.replace(CLAUDE_CODE_HINT_LINE_RE, "").replace(/\n{3,}/g, "\n\n");
}

export function interpretBashReturnCode(
  command: string,
  result: Pick<ExecutionResult, "error" | "exitCode" | "signal" | "status">,
): string | undefined {
  if (result.error?.type === "output_limit") {
    return "Command stopped because output exceeded the configured limit";
  }
  if (result.status === "timed_out") return "Command timed out";
  if (result.status === "cancelled") return "Command was cancelled";
  if (result.status === "spawn_error") return "Command failed to start";
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    const semantic = semanticNonErrorExit(command, result.exitCode);
    return semantic ?? `Command exited with code ${result.exitCode}`;
  }
  if (result.signal) return `Command exited due to signal ${result.signal}`;
  return undefined;
}

export function isSemanticNonErrorInterpretation(message: string | undefined): boolean {
  return message !== undefined && SEMANTIC_NON_ERROR_MESSAGES.has(message);
}

/** 非零退出的失败与硬超时（timed_out，exit code 143）都按失败结果交给模型。 */
export function isBashProviderErrorStatus(output: {
  exitCode?: unknown;
  returnCodeInterpretation?: unknown;
  status?: unknown;
}): boolean {
  if (output.status !== "failed" && output.status !== "timed_out") return false;
  if (typeof output.exitCode !== "number" || output.exitCode === 0) return false;
  return !isSemanticNonErrorInterpretation(
    typeof output.returnCodeInterpretation === "string"
      ? output.returnCodeInterpretation
      : undefined,
  );
}

function semanticNonErrorExit(command: string, exitCode: number): string | undefined {
  if (exitCode !== 1) return undefined;
  const commandName = statusCommandNameForExitOne(command);
  return commandName === undefined ? undefined : semanticExitOneInterpretation(commandName);
}

function statusCommandNameForExitOne(command: string): string | undefined {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax) return undefined;
  const statusCommand = analysis.commands.at(-1);
  if (statusCommand === undefined) return undefined;

  // 不能因为命令行前面出现过 rg/grep，就把后续 test/exit 的 1 误判成 No matches found。
  if (statusCommand.name === "git") {
    const gitSubcommand = gitSemanticSubcommandName(statusCommand.argv);
    if (gitSubcommand === "grep") return "grep";
    if (gitSubcommand === "diff") return "diff";
  }
  return statusCommand.name;
}

function semanticExitOneInterpretation(commandName: string): string | undefined {
  if (SEMANTIC_NO_MATCH_COMMANDS.has(commandName)) return "No matches found";
  if (commandName === "find") return "Some directories were inaccessible";
  if (commandName === "diff") return "Files differ";
  if (commandName === "test" || commandName === "[") return "Condition is false";
  return undefined;
}

function gitSemanticSubcommandName(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg.startsWith("-")) {
      if (arg === "-C" || arg === "-c") index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

function matchesBashPermissionPattern(pattern: string, command: string): boolean {
  const prefix = permissionPatternPrefix(pattern);
  if (prefix !== null) return command === prefix || command.startsWith(`${prefix} `);
  return wildcardToRegExp(pattern).test(command);
}

function permissionPatternPrefix(pattern: string): string | null {
  return pattern.endsWith(":*") ? pattern.slice(0, -2) : null;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  return value.split("\n").length;
}

// 前台长 sleep 拦截，规则见 04-bash.md「前台 sleep 拦截」。
const FOREGROUND_SLEEP_PATTERN = /^sleep\s+(\d+(?:\.\d*)?)\s*$/;
export const FOREGROUND_SLEEP_MIN_SECONDS = 25;
const FOREGROUND_SLEEP_ERROR_CODE = 10;

/** 第一个顶层元素是 `sleep N`（N ≥ 25）时返回拒绝原因，否则返回 undefined。 */
export function describeBlockedForegroundSleep(command: string): string | undefined {
  const [first, ...rest] = splitTopLevelBashCommands(command);
  const match = FOREGROUND_SLEEP_PATTERN.exec(first?.trim() ?? "");
  if (!match) return undefined;
  const seconds = Number.parseFloat(match[1]!);
  if (seconds < FOREGROUND_SLEEP_MIN_SECONDS) return undefined;
  const followedBy = rest.join(" ").trim();
  return followedBy ? `sleep ${seconds} followed by: ${followedBy}` : `standalone sleep ${seconds}`;
}

/**
 * Bash 的 validateInput：在 hook 与权限之前拒绝前台长 sleep。后台命令、不支持后台生命周期的执行端口
 * （拒绝文字指向的后台做法不可用）、cmd 与 legacy-shell（不是 Bash 语法，until 循环也不能用）放行。
 */
export function validateBashForegroundSleep(
  input: unknown,
  context: ToolInputValidationContext,
): ToolInputValidationResult {
  const { command, run_in_background } = input as {
    command?: unknown;
    run_in_background?: unknown;
  };
  const dialect = context.bashShellSelection?.dialect;
  if (
    typeof command !== "string" ||
    run_in_background === true ||
    !context.executionPort ||
    !supportsBashBackgroundLifecycle(context.executionPort) ||
    dialect === "cmd" ||
    dialect === "legacy-shell"
  ) {
    return { result: true };
  }
  const reason = describeBlockedForegroundSleep(command);
  if (!reason) return { result: true };
  return {
    result: false,
    errorCode: FOREGROUND_SLEEP_ERROR_CODE,
    message: `Blocked: ${reason}. To wait for a condition, run an until-loop with run_in_background: true (e.g. \`until <check>; do sleep 2; done\`); you are notified when it exits. To wait for a command you started, use run_in_background: true. Do not chain shorter sleeps to work around this block.`,
  };
}
