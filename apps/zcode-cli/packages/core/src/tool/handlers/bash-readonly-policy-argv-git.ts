import {
  GIT_GLOBAL_DANGEROUS_FLAGS,
  GIT_GLOBAL_NO_VALUE_FLAGS,
  GIT_GLOBAL_VALUE_FLAGS,
  GIT_READONLY_SUBCOMMAND_POLICIES,
} from "./bash-readonly-policy-commands.js";
import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";
import { isArgvAllowedByPolicy } from "./bash-readonly-policy-argv-flags.js";

const GIT_ATTACHED_DANGEROUS_SHORT_FLAGS = ["-c", "-C"];

export function isGitReadOnlyCommand(argv: readonly string[]): boolean {
  // `git --version` 只打印版本，不读仓库配置；只放行这一个精确形态，其他全局参数仍按下面的规则拒绝。
  if (argv.length === 2 && argv[1] === "--version") return true;
  const normalized = normalizeGitArgv(argv);
  if (!normalized) return false;

  for (const [commandPrefix, policy] of sortedGitPolicies()) {
    const prefixWords = commandPrefix.split(" ");
    if (!prefixWords.every((word, index) => normalized[index] === word)) continue;
    if (
      policy.additionalCommandIsDangerousCallback?.(
        commandPrefix,
        normalized.slice(prefixWords.length),
      )
    )
      return false;
    return isArgvAllowedByPolicy(normalized, policy, "git", prefixWords.length);
  }

  return false;
}

function normalizeGitArgv(argv: readonly string[]): readonly string[] | undefined {
  const normalized = ["git"];
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index];
    if (!word) continue;
    if (GIT_GLOBAL_NO_VALUE_FLAGS.has(word)) continue;
    if (hasDangerousGitGlobalOptionWord(word)) return undefined;
    if (GIT_GLOBAL_VALUE_FLAGS.has(word)) {
      index += 1;
      if (!argv[index]) return undefined;
      continue;
    }
    if (word.startsWith("-")) return undefined;
    normalized.push(...argv.slice(index));
    return normalized;
  }

  return undefined;
}

export function hasDangerousGitGlobalOption(argv: readonly string[]): boolean {
  // 只看子命令之前的全局参数区。子命令之后的 -c/-C 是子命令自己的参数
  // （git grep -c 计数、git diff/blame -C 找复制），由各子命令的安全参数表判定。
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index];
    if (!word) continue;
    if (hasDangerousGitGlobalOptionWord(word)) return true;
    if (GIT_GLOBAL_VALUE_FLAGS.has(word)) {
      index += 1;
      continue;
    }
    if (!word.startsWith("-")) return false;
  }
  return false;
}

function hasDangerousGitGlobalOptionWord(word: string): boolean {
  if (hasDangerousAttachedGitShortOptionWord(word)) return true;
  if (GIT_GLOBAL_DANGEROUS_FLAGS.has(word)) return true;
  return [...GIT_GLOBAL_DANGEROUS_FLAGS].some((flag) => word.startsWith(`${flag}=`));
}

function hasDangerousAttachedGitShortOptionWord(word: string): boolean {
  return GIT_ATTACHED_DANGEROUS_SHORT_FLAGS.some((flag) => {
    return (
      word.length > flag.length &&
      word.startsWith(flag) &&
      (flag === "-C" || word[flag.length] !== "-")
    );
  });
}

let gitPoliciesByLength: Array<[string, BashReadonlyCommandPolicy]> | undefined;

function sortedGitPolicies(): Array<[string, BashReadonlyCommandPolicy]> {
  gitPoliciesByLength ??= [...GIT_READONLY_SUBCOMMAND_POLICIES.entries()].sort((left, right) => {
    return right[0].split(" ").length - left[0].split(" ").length;
  });
  return gitPoliciesByLength;
}
