import type { PermissionRuleValue, PermissionUpdate } from "@zcode/contracts";
import type { ToolPermissionRulePolicy, ToolRuntimePermissionCapabilityContext } from "../types.js";
import {
  analyzeBashCommand,
  isBashCommandPermissionSafe,
  type BashCommandAnalysis,
  type BashCommandInvocation,
} from "./bash-command-parser.js";
import { evaluateBashRules } from "./bash-command-rule-evaluator.js";
import {
  BASH_COMMAND_REGISTRY,
  type BashCommandRegistryNode,
} from "./generated/bash-command-registry.js";
import { isRuntimeReadOnlyBashCommand } from "./bash-semantics.js";

const MAX_SUGGESTED_RULES = 5;
const ARG_IS_COMMAND = 1;
const ARG_IS_MODULE = 2;
const HIGH_RISK_ROOT_COMMANDS = new Set([
  "bash",
  "chgrp",
  "chmod",
  "chown",
  "cmd",
  "dd",
  "fish",
  "mkfs",
  "mount",
  "powershell",
  "pwsh",
  "rm",
  "rmdir",
  "sh",
  "umount",
  "zsh",
]);
const WRAPPER_OPTIONS_WITH_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  command: new Set(),
  env: new Set(["-C", "-S", "-u", "--argv0", "--chdir", "--split-string", "--unset"]),
  nohup: new Set(),
  sudo: new Set([
    "-C",
    "-D",
    "-R",
    "-T",
    "-a",
    "-c",
    "-g",
    "-h",
    "-p",
    "-r",
    "-t",
    "-u",
    "--askpass",
    "--chdir",
    "--chroot",
    "--close-from",
    "--group",
    "--host",
    "--prompt",
    "--role",
    "--type",
    "--user",
  ]),
  time: new Set(["-f", "-o", "--format", "--output"]),
};
const WRAPPER_OPTIONS = new Set(["-p", "-v", "-V", "--ignore-environment"]);
const SCRIPT_ACTIONS = new Map([
  ["bun", new Set(["run"])],
  ["deno", new Set(["task"])],
  ["npm", new Set(["run", "run-script"])],
  ["pnpm", new Set(["run"])],
  ["yarn", new Set(["run"])],
]);
const TARGET_ACTIONS = new Set(["just", "make"]);
const PYTHON_EXECUTABLES = new Set(["python", "python3", "py"]);
const FAMILY_DEPTH_OVERRIDES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  aws: { "*": 2 },
  az: { "*": 2 },
  docker: { compose: 2 },
  gcloud: { "*": 3 },
  kubectl: { config: 2 },
};

export function resolveBashPermissionRulePolicy(
  input: unknown,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolPermissionRulePolicy | undefined {
  const command = readCommand(input);
  if (command === undefined) return undefined;
  return createBashPermissionRulePolicy(command, context);
}

export function createBashPermissionRulePolicy(
  command: string,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolPermissionRulePolicy {
  const rawCommand = command.trim();
  const exactCommands = command === rawCommand ? [rawCommand] : [command, rawCommand];
  const analysis = analyzeBashCommand(command);
  const safe = isAnalysisSafeForPrefix(analysis);
  // CMD/未知 shell 的 Bash AST 可能漏掉实际执行的后续命令，只保留完整命令的明确授权。
  // 此限制只收紧 allow，不能让已有 deny/ask 规则失效。
  const dialect = context?.bashShellSelection?.dialect;
  const allowParsedRules = dialect !== "cmd" && dialect !== "legacy-shell";
  const allSubjectGroups = safe ? analysis.commands.map(buildInvocationRuleSubjects) : [];
  const requiredCommands = safe
    ? analysis.commands.filter(
        (invocation) => !isRuntimeReadOnlyBashCommand(invocation.commandText, context),
      )
    : [];
  const requiredSubjectGroups = requiredCommands.map(buildInvocationRuleSubjects);
  const suggestedPermissionUpdates = buildSuggestedUpdates(
    rawCommand,
    safe && allowParsedRules,
    requiredCommands,
  );

  return {
    evaluateRules(behavior, rules) {
      return evaluateBashRules({
        allSubjectGroups,
        behavior,
        exactCommands,
        requiredSubjectGroups,
        rules,
        safe: safe && (behavior !== "allow" || allowParsedRules),
      });
    },
    suggestedPermissionUpdates,
  };
}

function buildInvocationRuleSubjects(invocation: BashCommandInvocation): string[] {
  const rawSubject = normalizeInvocation(invocation);
  const stablePrefix = resolveStableCommandPrefix(invocation);
  // 保存规则会移除 --dir/-C 等全局 flag，但旧 evaluator 只拿原始 invocation
  // 比较，导致 UI 明明保存了 `pnpm run lint:*`，下一轮仍无法命中。保留 raw subject
  // 兼容历史 wildcard，同时加入相同 resolver 得出的稳定 action subject。
  return stablePrefix && stablePrefix !== rawSubject ? [rawSubject, stablePrefix] : [rawSubject];
}

function buildSuggestedUpdates(
  rawCommand: string,
  safe: boolean,
  requiredCommands: readonly BashCommandInvocation[],
): PermissionUpdate[] {
  if (rawCommand.length === 0) return [];
  if (!safe || requiredCommands.length === 0 || requiredCommands.length > MAX_SUGGESTED_RULES) {
    return exactUpdate(rawCommand);
  }

  const rules: PermissionRuleValue[] = [];
  const seen = new Set<string>();
  for (const invocation of requiredCommands) {
    const prefix = resolveStableCommandPrefix(invocation);
    if (!prefix) return exactUpdate(rawCommand);
    const ruleContent = `${prefix}:*`;
    if (seen.has(ruleContent)) continue;
    seen.add(ruleContent);
    rules.push({ ruleContent, toolName: "Bash" });
  }
  if (rules.length === 0 || rules.length > MAX_SUGGESTED_RULES) return exactUpdate(rawCommand);
  return [{ behavior: "allow", rules, type: "addRules" }];
}

function exactUpdate(rawCommand: string): PermissionUpdate[] {
  return [
    {
      behavior: "allow",
      rules: [{ ruleContent: rawCommand, toolName: "Bash" }],
      type: "addRules",
    },
  ];
}

function isAnalysisSafeForPrefix(analysis: BashCommandAnalysis): boolean {
  return (
    isBashCommandPermissionSafe(analysis) &&
    !analysis.hasRedirects &&
    analysis.commands.length > 0 &&
    analysis.commands.every(
      (invocation) =>
        !invocation.hasRedirects &&
        !invocation.hasDynamicWords &&
        staticAssignmentTokens(invocation) !== undefined,
    )
  );
}

function normalizeInvocation(invocation: BashCommandInvocation): string {
  return [...(staticAssignmentTokens(invocation) ?? []), ...invocation.argv].join(" ");
}

function resolveStableCommandPrefix(invocation: BashCommandInvocation): string | undefined {
  const assignments = staticAssignmentTokens(invocation);
  if (!assignments || invocation.argv.length === 0) return undefined;
  const unwrapped = unwrapCommand(invocation.argv);
  if (!unwrapped) return undefined;
  const executableName = executableBasename(unwrapped.executable);
  if (HIGH_RISK_ROOT_COMMANDS.has(executableName)) return undefined;

  const prefix = [...assignments, ...unwrapped.prefix, unwrapped.executable];
  const remaining = invocation.argv.slice(unwrapped.nextIndex);
  const directOverride = resolveDepthOverride(executableName, remaining);
  if (directOverride) {
    prefix.push(...directOverride);
    return serializePrefix(prefix);
  }

  let node = BASH_COMMAND_REGISTRY[executableName];
  if (!node) return undefined;
  const override = resolveDepthOverride(executableName, skipLeadingKnownOptions(node, remaining));
  if (override) {
    prefix.push(...override);
    return serializePrefix(prefix);
  }

  let index = 0;
  let matchedAction = false;
  while (index < remaining.length) {
    const optionEnd = skipKnownOption(node, remaining, index);
    if (optionEnd !== undefined) {
      index = optionEnd;
      continue;
    }

    const token = remaining[index]!;
    const child = node[3].find((candidate) => candidate[0].includes(token));
    if (child) {
      prefix.push(token);
      matchedAction = true;
      node = child;
      index += 1;
      continue;
    }

    if ((node[2] & (ARG_IS_COMMAND | ARG_IS_MODULE)) !== 0 && !looksLikePathOrUrl(token)) {
      prefix.push(token);
      matchedAction = true;
    }
    break;
  }

  return matchedAction ? serializePrefix(prefix) : undefined;
}

function skipLeadingKnownOptions(
  node: BashCommandRegistryNode,
  args: readonly string[],
): readonly string[] {
  let index = 0;
  while (index < args.length) {
    const optionEnd = skipKnownOption(node, args, index);
    if (optionEnd === undefined) break;
    index = optionEnd;
  }
  return args.slice(index);
}

interface UnwrappedCommand {
  executable: string;
  nextIndex: number;
  prefix: string[];
}

function unwrapCommand(argv: readonly string[]): UnwrappedCommand | undefined {
  const prefix: string[] = [];
  let index = 0;
  let wrapperDepth = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    const name = executableBasename(token);
    const optionsWithValues = WRAPPER_OPTIONS_WITH_VALUES[name];
    if (!optionsWithValues) {
      return { executable: token, nextIndex: index + 1, prefix };
    }
    wrapperDepth += 1;
    if (wrapperDepth > 2) return undefined;
    prefix.push(token);
    index += 1;
    while (index < argv.length) {
      const wrapperToken = argv[index]!;
      if (name === "env" && isStaticAssignmentToken(wrapperToken)) {
        prefix.push(wrapperToken);
        index += 1;
        continue;
      }
      const optionName = wrapperToken.includes("=")
        ? wrapperToken.slice(0, wrapperToken.indexOf("="))
        : wrapperToken;
      if (optionsWithValues.has(optionName)) {
        index += wrapperToken.includes("=") ? 1 : 2;
        continue;
      }
      if (WRAPPER_OPTIONS.has(optionName) || wrapperToken.startsWith("-")) {
        index += 1;
        continue;
      }
      break;
    }
  }
  return undefined;
}

function resolveDepthOverride(
  executableName: string,
  args: readonly string[],
): string[] | undefined {
  if (PYTHON_EXECUTABLES.has(executableName) && args[0] === "-m" && isStableActionToken(args[1])) {
    return [args[0]!, args[1]!];
  }
  const scriptActions = SCRIPT_ACTIONS.get(executableName);
  if (scriptActions?.has(args[0] ?? "") && isStableActionToken(args[1])) {
    return [args[0]!, args[1]!];
  }
  if (TARGET_ACTIONS.has(executableName) && isStableActionToken(args[0])) {
    return [args[0]!];
  }
  const familyDepth = FAMILY_DEPTH_OVERRIDES[executableName];
  const depth = familyDepth?.[args[0] ?? ""] ?? familyDepth?.["*"];
  if (depth && args.length >= depth) {
    const action = args.slice(0, depth);
    if (action.every(isStableActionToken)) return action;
  }
  return undefined;
}

function skipKnownOption(
  node: BashCommandRegistryNode,
  args: readonly string[],
  index: number,
): number | undefined {
  const token = args[index]!;
  if (!token.startsWith("-") || token === "-") return undefined;
  if (token === "--") return index + 1;
  const optionName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
  const option = node[1].find((candidate) => candidate[0].includes(optionName));
  if (!option) return undefined;
  return index + (option[1] === 1 && !token.includes("=") ? 2 : 1);
}

function staticAssignmentTokens(invocation: BashCommandInvocation): string[] | undefined {
  const tokens: string[] = [];
  for (const assignment of invocation.envAssignments) {
    if (!assignment.name || assignment.value === undefined) return undefined;
    const token = `${assignment.name}=${assignment.value}`;
    if (!isStaticAssignmentToken(token)) return undefined;
    tokens.push(token);
  }
  return tokens;
}

function isStaticAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:@,+-]*$/.test(token);
}

function isStableActionToken(token: string | undefined): token is string {
  return (
    Boolean(token) && !token!.startsWith("-") && !looksLikePathOrUrl(token!) && !/\s/.test(token!)
  );
}

function looksLikePathOrUrl(token: string): boolean {
  return (
    token.includes("://") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("/") ||
    token.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(token)
  );
}

function serializePrefix(tokens: readonly string[]): string | undefined {
  if (tokens.length < 2 || tokens.some((token) => token.length === 0 || /\s/.test(token))) {
    return undefined;
  }
  return tokens.join(" ");
}

function executableBasename(token: string): string {
  const normalized = token.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function readCommand(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}
