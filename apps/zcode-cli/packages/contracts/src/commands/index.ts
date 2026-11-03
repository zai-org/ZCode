// ============================================================
// Custom Command Contracts - user-defined slash prompt commands
// ============================================================

import type { HookPluginContext } from "../hooks/index.js";
import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export type CustomCommandScope = "project" | "user" | "system" | "admin";

export type CustomCommandSource = "agents" | "zcode" | "plugin";

export type CustomCommandDiagnosticSeverity = "warning" | "error";

export type CustomCommandDiagnosticCode =
  | "custom_command_duplicate_name"
  | "custom_command_invalid_frontmatter"
  | "custom_command_invalid_name"
  | "custom_command_read_failed"
  | "custom_command_root_not_found"
  | "custom_command_scan_failed"
  | "custom_command_too_large"
  | "custom_command_unknown_frontmatter";

export interface CustomCommandRoot {
  /** 附加目录能力的目录限定名；不是项目身份。 */
  namespace?: string;
  path: string;
  plugin?: HookPluginContext;
  scope: CustomCommandScope;
  source: CustomCommandSource;
  priority: number;
}

export interface CustomCommandMetadata {
  allowedTools: string[];
  argumentHint?: string;
  description: string;
  disableNonInteractive: boolean;
  frontmatterKeys: string[];
  model?: string;
  name: string;
  path: string;
  plugin?: HookPluginContext;
  rootPath: string;
  scope: CustomCommandScope;
  skills: string[];
  source: CustomCommandSource;
}

export interface CustomCommandDiagnostic {
  code: CustomCommandDiagnosticCode;
  severity: CustomCommandDiagnosticSeverity;
  message: string;
  path?: string;
  commandName?: string;
}

export interface CustomCommandLoadOutcome {
  commands: CustomCommandMetadata[];
  diagnostics: CustomCommandDiagnostic[];
  totalDiscovered: number;
}

export interface CustomCommandContent {
  metadata: CustomCommandMetadata;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface CustomCommandDiscoverRequest {
  roots?: CustomCommandRoot[];
  trace?: TraceContext;
  workingDirectory: string;
}

export interface CustomCommandLoadRequest {
  maxBytes?: number;
  name: string;
  roots?: CustomCommandRoot[];
  trace?: TraceContext;
  workingDirectory: string;
}

export interface CustomCommandOperationOptions {
  context?: ExecutionContext;
  signal?: AbortSignal;
}

export interface CustomCommandPort {
  discoverCommands(
    request: CustomCommandDiscoverRequest,
    options?: CustomCommandOperationOptions,
  ): Promise<CustomCommandLoadOutcome>;
  loadCommand(
    request: CustomCommandLoadRequest,
    options?: CustomCommandOperationOptions,
  ): Promise<CustomCommandContent>;
}

export interface CustomCommandExpansion {
  argumentCount: number;
  prompt: string;
  usedArgumentsPlaceholder: boolean;
}

interface CustomCommandTemplateExpansion {
  argumentCount: number;
  body: string;
  usedArgumentsPlaceholder: boolean;
}

/** 改写 `!` 块所需的命令身份。 */
export interface CustomCommandShellHandOffInput {
  metadata: {
    name: string;
    plugin?: Pick<HookPluginContext, "dataPath" | "id" | "name" | "rootPath">;
    scope: string;
    source: string;
  };
}

const POSITIONAL_ARGUMENT_PATTERN = /\$(\d+)/g;
const ALL_ARGUMENTS_TOKEN = "$ARGUMENTS";
// fenced 在前：同一位置两种写法都能匹配时按 fenced 处理。行内写法要求 `!` 在行首或空白之后，
// 避免把 `Warning!` 这类正文和后一个代码段误判成命令。
const SHELL_BLOCK_PATTERN = /```!\s*([\s\S]*?)```|(?<=^|\s)!`([^`]*)`/gmu;
// 会话 ID 与工作区目录由 Bash 工具作为环境变量注入（tool/04-bash.md），块里保持原文。
// 这里只处理 Bash 拿不到的变量：插件变量换成插件的真实值，skill 目录变量命令没有。变量名逐个写全。
const SHELL_TEXT_VARIABLES = [
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_SKILL_DIR",
  "ZCODE_PLUGIN_DATA",
  "ZCODE_PLUGIN_ID",
  "ZCODE_PLUGIN_NAME",
  "ZCODE_PLUGIN_ROOT",
  "ZCODE_SKILL_DIR",
].join("|");
// `${...}` 里变量名前的 `#`/`!`（取长度、间接引用）与变量名后除 `}` 以外的部分（`:-x`、`%/` 等）
// 都是修饰符写法。
const SHELL_TEXT_VARIABLE_PATTERN = new RegExp(
  `\\$(?:\\{([#!]?)(${SHELL_TEXT_VARIABLES})(\\}|[^A-Za-z0-9_}][^}]*\\})|(${SHELL_TEXT_VARIABLES})(?![A-Za-z0-9_]))`,
  "gu",
);
// 盘符路径（`C:\`）或 UNC 路径（`\\server`）。
const WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:\\|\\\\)/u;

export function expandCustomCommandPrompt(input: {
  args: string;
  command: CustomCommandContent;
}): CustomCommandExpansion {
  // 改写在参数替换之前：参数文本永远不会被当成 shell 块。
  const content = handOffCustomCommandShellBlocks(input.command.content, {
    metadata: input.command.metadata,
  });
  const expanded = expandCustomCommandTemplate({
    args: input.args,
    command: { ...input.command, content },
  });

  return formatCustomCommandPrompt({
    body: expanded.body,
    command: input.command,
    argumentCount: expanded.argumentCount,
    usedArgumentsPlaceholder: expanded.usedArgumentsPlaceholder,
  });
}

/**
 * 把命令正文里的 `` !`cmd` `` 和 ```` ```! ```` 块改写成交给模型的 Bash 指令，解析阶段只改写文本、不执行 shell。
 *
 * 执行统一走模型的 Bash 工具调用，由权限服务决定放行、询问或拒绝，用户看得到这次工具调用；
 * 解析本身没有失败路径，不影响发送、队列、编辑、重试的顺序。说明文字写明这一步来自命令文件
 * 而不是 ZCode，让模型按外部内容对待它。
 */
export function handOffCustomCommandShellBlocks(
  content: string,
  input: CustomCommandShellHandOffInput,
): string {
  const { metadata } = input;
  const origin = `the /${metadata.name} command file (${metadata.scope}/${metadata.source})`;
  return content.replace(
    SHELL_BLOCK_PATTERN,
    (_match, fenced: string | undefined, inline: string | undefined) => {
      const shellCommand = (fenced ?? inline ?? "").trim();
      if (shellCommand.length === 0) return "";
      const unresolved = new Set<string>();
      const resolved = shellCommand.replace(
        SHELL_TEXT_VARIABLE_PATTERN,
        (
          variable,
          prefix: string | undefined,
          braced: string | undefined,
          tail: string | undefined,
          bare?: string,
        ) => {
          // 修饰符写法交给 shell 会对空值取默认值、裁剪或取长度，结果与审批时看到的不一致，不替换。
          const plain = bare !== undefined || (prefix === "" && tail === "}");
          const value = plain
            ? resolveShellTextVariable(braced ?? bare ?? "", metadata.plugin)
            : undefined;
          if (value === undefined) unresolved.add(variable);
          return value ?? variable;
        },
      );
      // 这些变量 Bash 环境里没有，交给 shell 会展开成空串，审批时看到的命令和实际执行的不一致，所以整块不转交。
      if (unresolved.size > 0) {
        return `[A shell step from ${origin} was not run: it uses ${[...unresolved].join(", ")}, which cannot be resolved here.]\n`;
      }
      // 统一用代码块：块里的 $ARGUMENTS 在改写之后才替换，参数可能带反引号，行内写法会被打断。
      // 结束标记后补换行：行内块后面的原文要另起一行，否则结束标记不成立，后文都会落进代码块。
      return `[This shell step comes from ${origin}, not from ZCode. Run it with the Bash tool exactly as written and use its output here, unless it looks unsafe or unrelated to the user's request:]\n\`\`\`bash\n${resolved}\n\`\`\`\n`;
    },
  );
}

function resolveShellTextVariable(
  name: string,
  plugin: CustomCommandShellHandOffInput["metadata"]["plugin"],
): string | undefined {
  // *_SKILL_DIR：命令没有 skill 目录，始终拿不到；插件变量只在插件命令里有值。
  if (!plugin || name.endsWith("_SKILL_DIR")) return undefined;
  let value: string;
  if (name.endsWith("_PLUGIN_ROOT")) value = plugin.rootPath;
  else if (name.endsWith("_PLUGIN_DATA")) value = plugin.dataPath;
  else if (name === "ZCODE_PLUGIN_ID") value = plugin.id;
  else value = plugin.name;
  // Windows 路径改用正斜杠：值以文本写进命令，由 shell 解析。Git Bash 会去掉引号外的反斜杠，
  // 未加引号的 `bash ${CLAUDE_PLUGIN_ROOT}/x.sh` 会变成 `C:Usersdev...`；原来按环境变量展开没有这个问题。
  // Git Bash 在引号内外都认 `C:/...` 和 `//server/share`。
  if (WINDOWS_PATH_PATTERN.test(value)) value = value.replaceAll("\\", "/");
  return value || undefined;
}

function expandCustomCommandTemplate(input: {
  args: string;
  command: CustomCommandContent;
}): CustomCommandTemplateExpansion {
  const args = input.args.trim();
  const positional = splitCustomCommandArguments(args);
  let usedArgumentsPlaceholder = input.command.content.includes(ALL_ARGUMENTS_TOKEN);
  let body = input.command.content.replaceAll(ALL_ARGUMENTS_TOKEN, args);
  body = body.replace(POSITIONAL_ARGUMENT_PATTERN, (_match, index: string) => {
    usedArgumentsPlaceholder = true;
    const offset = Number(index) - 1;
    return positional[offset] ?? "";
  });

  if (args.length > 0 && !usedArgumentsPlaceholder) {
    body = `${body.trimEnd()}\n\nUser arguments:\n${args}`;
  }

  return {
    argumentCount: positional.length,
    body,
    usedArgumentsPlaceholder,
  };
}

function formatCustomCommandPrompt(input: {
  argumentCount: number;
  body: string;
  command: CustomCommandContent;
  usedArgumentsPlaceholder: boolean;
}): CustomCommandExpansion {
  return {
    argumentCount: input.argumentCount,
    prompt: [
      `Run custom command /${input.command.metadata.name}.`,
      `Command source: ${input.command.metadata.scope}/${input.command.metadata.source}.`,
      ...formatCommandSkillInstructions(input.command.metadata.skills ?? []),
      "",
      input.body.trim(),
    ].join("\n"),
    usedArgumentsPlaceholder: input.usedArgumentsPlaceholder,
  };
}

function formatCommandSkillInstructions(skills: string[]): string[] {
  if (skills.length === 0) return [];
  const names = skills.map((skill) => `\`${skill}\``).join(", ");
  return [
    `Required skills: ${names}.`,
    `Before following the command body, call the Skill tool for ${names}.`,
  ];
}

export function splitCustomCommandArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current.length > 0) args.push(current);
  return args;
}
