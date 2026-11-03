import { handOffCustomCommandShellBlocks } from "@zcode/contracts";

interface CliCustomCommandContent {
  content: string;
  metadata: {
    name: string;
    plugin?: { dataPath: string; id: string; name: string; rootPath: string };
    scope: string;
    skills?: string[];
    source: string;
  };
}

interface CliCustomCommandExpansion {
  argumentCount: number;
  prompt: string;
  usedArgumentsPlaceholder: boolean;
}

const ALL_ARGUMENTS_TOKEN = "$ARGUMENTS";
const POSITIONAL_ARGUMENT_PATTERN = /\$(\d+)/g;

export function expandCliCustomCommandPrompt(input: {
  args: string;
  command: CliCustomCommandContent;
}): CliCustomCommandExpansion {
  // 与 app 路径同一规则：`!` shell 块改写成交给模型的 Bash 指令，不执行也不报错；
  // 改写早于参数替换，参数文本不会被当成 shell 块。
  const content = handOffCustomCommandShellBlocks(input.command.content, {
    metadata: input.command.metadata,
  });
  const args = input.args.trim();
  const positional = splitCliCustomCommandArguments(args);
  let usedArgumentsPlaceholder = content.includes(ALL_ARGUMENTS_TOKEN);
  let body = content.replaceAll(ALL_ARGUMENTS_TOKEN, args);
  body = body.replace(POSITIONAL_ARGUMENT_PATTERN, (_match, index: string) => {
    usedArgumentsPlaceholder = true;
    return positional[Number(index) - 1] ?? "";
  });

  if (args.length > 0 && !usedArgumentsPlaceholder) {
    body = `${body.trimEnd()}\n\nUser arguments:\n${args}`;
  }

  return {
    argumentCount: positional.length,
    prompt: [
      `Run custom command /${input.command.metadata.name}.`,
      `Command source: ${input.command.metadata.scope}/${input.command.metadata.source}.`,
      ...formatCommandSkillInstructions(input.command.metadata.skills ?? []),
      "",
      body.trim(),
    ].join("\n"),
    usedArgumentsPlaceholder,
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

function splitCliCustomCommandArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let escaping = false;
  let quote: "'" | '"' | null = null;

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
      if (char === quote) quote = null;
      else current += char;
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
