import { unwrapCommand } from "./guarded/wrappers.js";
import { parse } from "unbash";
import { commandBasename, literalPosixWord, type CommandWord } from "./guarded/word.js";
import type {
  AndOr,
  Command,
  Node,
  Pipeline,
  Redirect,
  Script,
  Statement,
  Word,
  WordPart,
} from "unbash";

export type BashCommandOperator = "&&" | "||" | "|" | "|&" | "sequence";

export interface BashCommandEnvAssignment {
  readonly name: string | undefined;
  readonly value: string | undefined;
}

export interface BashCommandRedirect {
  readonly fileDescriptor: number | undefined;
  readonly operator: Redirect["operator"];
  readonly target: string;
}

export interface BashCommandInvocation {
  readonly words: CommandWord[];
  readonly argv: string[];
  readonly commandText: string;
  readonly envAssignments: BashCommandEnvAssignment[];
  readonly hasAssignmentPrefix: boolean;
  readonly hasDynamicWords: boolean;
  readonly hasRedirects: boolean;
  readonly name: string;
  readonly operatorBefore?: BashCommandOperator;
  readonly redirects: BashCommandRedirect[];
}

export interface BashCommandAnalysis {
  readonly commands: BashCommandInvocation[];
  readonly hasDynamicWords: boolean;
  readonly hasParseErrors: boolean;
  readonly hasRedirects: boolean;
  readonly hasUnsupportedSyntax: boolean;
  readonly unsupportedNodeTypes: string[];
}

const MAX_BASH_PARSE_LENGTH = 10_000;
const SUPPORTED_CONTAINER_NODES = new Set(["AndOr", "Pipeline", "Statement"]);

export function analyzeBashCommand(command: string): BashCommandAnalysis {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return emptyAnalysis();
  }
  if (command.length > MAX_BASH_PARSE_LENGTH) {
    return {
      ...emptyAnalysis(),
      hasParseErrors: true,
    };
  }

  let script: Script & { errors?: unknown[] };
  try {
    script = parse(command);
  } catch {
    return {
      ...emptyAnalysis(),
      hasParseErrors: true,
    };
  }

  const analysis: MutableBashCommandAnalysis = {
    commands: [],
    hasDynamicWords: false,
    hasParseErrors: Boolean(script.errors?.length),
    hasRedirects: false,
    unsupportedNodeTypes: new Set(),
  };

  for (let index = 0; index < script.commands.length; index += 1) {
    collectStatementCommands(command, script.commands[index]!, {
      analysis,
      operatorBefore: index === 0 ? undefined : "sequence",
      statementRedirects: [],
    });
  }

  return freezeAnalysis(analysis);
}

export function isBashCommandPermissionSafe(analysis: BashCommandAnalysis): boolean {
  return !analysis.hasParseErrors && !analysis.hasUnsupportedSyntax && !analysis.hasDynamicWords;
}

/**
 * 命令的顶层元素文本，按出现顺序。展开 `;`、换行、`&`、`&&`、`||`、`|`、`|&`，运算符与注释不保留；简单命令去掉
 * 重定向、保留前置赋值；子 shell、`{ …; }`、控制结构和带 `!` / `time` 的 pipeline 按原文。超过解析上限或
 * 解析有错误时只返回整条命令。
 */
export function splitTopLevelBashCommands(command: string): string[] {
  if (command.length > MAX_BASH_PARSE_LENGTH) return [command];
  let script: Script & { errors?: unknown[] };
  try {
    script = parse(command);
  } catch {
    return [command];
  }
  if (script.errors?.length) return [command];

  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.type === "Statement") return visit(node.command);
    if (node.type === "AndOr" || (node.type === "Pipeline" && !node.negated && !node.time)) {
      return node.commands.forEach(visit);
    }
    const text = (
      node.type === "Command"
        ? textWithoutRedirects(command, node)
        : command.slice(node.pos, node.end)
    ).trim();
    if (text) parts.push(text);
  };
  script.commands.forEach(visit);
  return parts;
}

function textWithoutRedirects(source: string, command: Command): string {
  let text = "";
  let cursor = command.pos;
  for (const redirect of [...command.redirects].sort((a, b) => a.pos - b.pos)) {
    text += source.slice(cursor, redirect.pos);
    cursor = redirect.end;
  }
  return text + source.slice(cursor, command.end);
}

interface MutableBashCommandAnalysis {
  commands: BashCommandInvocation[];
  hasDynamicWords: boolean;
  hasParseErrors: boolean;
  hasRedirects: boolean;
  unsupportedNodeTypes: Set<string>;
}

interface CollectContext {
  analysis: MutableBashCommandAnalysis;
  operatorBefore?: BashCommandOperator;
  statementRedirects: Redirect[];
}

function collectStatementCommands(
  source: string,
  statement: Statement,
  context: CollectContext,
): void {
  if (statement.background) {
    context.analysis.unsupportedNodeTypes.add("background");
  }
  if (statement.redirects.length > 0) {
    context.analysis.hasRedirects = true;
    if (redirectsHaveDynamicWords(statement.redirects)) context.analysis.hasDynamicWords = true;
  }

  collectNodeCommands(source, statement.command, {
    ...context,
    statementRedirects: [...context.statementRedirects, ...statement.redirects],
  });
}

function collectNodeCommands(source: string, node: Node, context: CollectContext): void {
  switch (node.type) {
    case "Command":
      collectSimpleCommand(source, node, context);
      return;
    case "AndOr":
      collectAndOrCommands(source, node, context);
      return;
    case "Pipeline":
      collectPipelineCommands(source, node, context);
      return;
    case "Statement":
      collectStatementCommands(source, node, context);
      return;
    default:
      context.analysis.unsupportedNodeTypes.add(node.type);
  }
}

function collectAndOrCommands(source: string, node: AndOr, context: CollectContext): void {
  for (let index = 0; index < node.commands.length; index += 1) {
    collectNodeCommands(source, node.commands[index]!, {
      ...context,
      operatorBefore: index === 0 ? context.operatorBefore : node.operators[index - 1],
    });
  }
}

function collectPipelineCommands(source: string, node: Pipeline, context: CollectContext): void {
  const firstCommandIndex = context.analysis.commands.length;
  for (let index = 0; index < node.commands.length; index += 1) {
    collectNodeCommands(source, node.commands[index]!, {
      ...context,
      operatorBefore: index === 0 ? context.operatorBefore : node.operators[index - 1],
    });
  }
  // unbash 将 time 关键字从 argv 提升为 Pipeline.time；恢复这个已定位的 wrapper，
  // 否则 time -o file 的参数会被误当成 executable，漏掉后续真实命令。
  const first = context.analysis.commands[firstCommandIndex];
  if (node.time && first) {
    const prefix = source.slice(node.pos, first.words[0]?.start);
    const time = /\btime\b/.exec(prefix);
    if (time)
      first.words.unshift({
        value: "time",
        dynamic: false,
        hasUnquotedGlob: false,
        start: node.pos + time.index,
        end: node.pos + time.index + 4,
      });
  }
}

function collectSimpleCommand(source: string, command: Command, context: CollectContext): void {
  const redirects = [...context.statementRedirects, ...command.redirects];
  const words = [command.name, ...command.suffix].filter(isWord);
  const argv = words.map(wordValue);
  const envAssignments = command.prefix.map((assignment) => ({
    name: assignment.name,
    value: assignment.value ? wordValue(assignment.value) : undefined,
  }));
  const hasDynamicWords =
    words.some(wordHasDynamicParts) ||
    command.prefix.some(
      (assignment) => assignment.value !== undefined && wordHasDynamicParts(assignment.value),
    ) ||
    redirectsHaveDynamicWords(redirects);

  if (hasDynamicWords) context.analysis.hasDynamicWords = true;
  if (redirects.length > 0) context.analysis.hasRedirects = true;

  const name = command.name ? wordValue(command.name) : "";
  context.analysis.commands.push({
    words: words.map((word) => {
      const fact = literalPosixWord(word.text, word.pos, word.end);
      // 只取顶层字面片段的 glob；变量/命令替换/brace 的载荷不是删除目标的词面证据。
      if (word.parts)
        fact.hasUnquotedGlob = word.parts.some(
          (part) =>
            part.type === "Literal" &&
            literalPosixWord(part.text, 0, part.text.length).hasUnquotedGlob,
        );
      return fact;
    }),
    argv,
    commandText: source.slice(command.pos, command.end),
    envAssignments,
    hasAssignmentPrefix: command.prefix.length > 0,
    hasDynamicWords,
    hasRedirects: redirects.length > 0,
    name,
    operatorBefore: context.operatorBefore,
    redirects: redirects.map((redirect) => ({
      fileDescriptor: redirect.fileDescriptor,
      operator: redirect.operator,
      target: redirectTargetValue(redirect),
    })),
  });
}

function redirectTargetValue(redirect: Redirect): string {
  if (redirect.target !== undefined) return wordValue(redirect.target);
  return redirect.content ?? "";
}

function redirectsHaveDynamicWords(redirects: Redirect[]): boolean {
  return redirects.some((redirect) => {
    return (
      (redirect.target !== undefined && wordHasDynamicParts(redirect.target)) ||
      (redirect.body !== undefined && wordHasDynamicParts(redirect.body))
    );
  });
}

function wordHasDynamicParts(word: Word): boolean {
  // 命令替换和进程替换会在主命令前执行，权限判断不能把它们当成普通 argv。
  return word.parts?.some(partHasDynamicExecution) ?? false;
}

function partHasDynamicExecution(part: WordPart): boolean {
  switch (part.type) {
    case "AnsiCQuoted":
    case "Literal":
    case "SingleQuoted":
      return false;
    case "DoubleQuoted":
    case "LocaleString":
      return part.parts.some(partHasDynamicExecution);
    case "CommandExpansion":
    case "ProcessSubstitution":
      return true;
    case "ArithmeticExpansion":
    case "BraceExpansion":
    case "ExtendedGlob":
    case "ParameterExpansion":
    case "SimpleExpansion":
      return true;
    default:
      return true;
  }
}

function wordValue(word: Word): string {
  return word.value ?? word.text;
}

function isWord(word: Word | undefined): word is Word {
  return word !== undefined;
}

function emptyAnalysis(): BashCommandAnalysis {
  return {
    commands: [],
    hasDynamicWords: false,
    hasParseErrors: false,
    hasRedirects: false,
    hasUnsupportedSyntax: false,
    unsupportedNodeTypes: [],
  };
}

function freezeAnalysis(analysis: MutableBashCommandAnalysis): BashCommandAnalysis {
  const unsupportedNodeTypes = [...analysis.unsupportedNodeTypes].filter(
    (type) => !SUPPORTED_CONTAINER_NODES.has(type),
  );

  return {
    commands: analysis.commands,
    hasDynamicWords: analysis.hasDynamicWords,
    hasParseErrors: analysis.hasParseErrors,
    hasRedirects: analysis.hasRedirects,
    hasUnsupportedSyntax: unsupportedNodeTypes.length > 0,
    unsupportedNodeTypes,
  };
}

export function directAdbWord(
  input: CommandWord[],
  windows: boolean,
  cmd: boolean,
  source: string,
): CommandWord | undefined {
  const unwrap = (input: CommandWord[]) => {
    let words = input;
    // CMD 的 @ 只关闭回显；解析词仍保留它，曾让 @adb.exe 漏过禁令。
    // 只按原始命令位置去掉前缀，保留引号/转义中的字面 @，替换路径时仍保留命令前缀。
    while (cmd && words[0]) {
      const word = words[0];
      const prefix = /^@+/.exec(source.slice(word.start, word.end))?.[0];
      if (!prefix) break;
      const value = word.value.slice(prefix.length);
      if (value) {
        words = [{ ...word, value, start: word.start + prefix.length }, ...words.slice(1)];
        break;
      }
      words = words.slice(1);
    }
    return unwrapCommand(words, windows);
  };
  let words = unwrap(input);
  while (words?.[0]) {
    const name = commandBasename(words[0], windows);
    if (!name) return undefined;
    if (/^adb(?:\.(?:exe|com|cmd|bat))?$/.test(name)) return words[0];
    if (cmd ? name !== "call" : name !== "command" && name !== "exec") return undefined;
    words = words.slice(1);
    while (words[0] && !words[0].dynamic && words[0].value.startsWith("-")) {
      const option = words.shift()!.value;
      if (option === "--") break;
      if (name === "command" && (option === "-v" || option === "-V")) return undefined;
      if (name === "exec" && option === "-a") words.shift();
      else if (!(name === "command" ? ["-p"] : ["-c", "-l"]).includes(option)) return undefined;
    }
    words = unwrap(words);
  }
  return undefined;
}
