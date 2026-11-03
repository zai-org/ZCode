import type { TuiSlashCommandSuggestion } from "@zcode/tui";
import { expandCliCustomCommandPrompt } from "./custom-command-expand.js";

const customCommandNotFoundPattern = /not found/i;

export type CommandCenterCustomCommandListOutcome = {
  commands: CommandCenterCustomCommand[];
  diagnostics: unknown[];
  totalDiscovered: number;
};

export type CommandCenterCustomCommand = {
  allowedTools?: string[];
  argumentHint?: string;
  description: string;
  disableNonInteractive?: boolean;
  frontmatterKeys?: string[];
  model?: string;
  name: string;
  path: string;
  plugin?: { dataPath: string; id: string; name: string; rootPath: string };
  rootPath?: string;
  scope: string;
  skills?: string[];
  source: string;
};

export type CommandCenterCustomCommandContent = {
  bytesRead?: number;
  content: string;
  metadata: CommandCenterCustomCommand;
  sizeBytes?: number;
  truncated?: boolean;
};

interface CommandCenterCustomCommandDeps {
  listCustomCommands?: () => Promise<CommandCenterCustomCommandListOutcome>;
  loadCustomCommand?: (name: string) => Promise<CommandCenterCustomCommandContent>;
}

export function listCustomCommandSuggestions(
  customCommands?: CommandCenterCustomCommandListOutcome,
): TuiSlashCommandSuggestion[] {
  return (customCommands?.commands ?? []).map((command) => ({
    name: command.name,
    summary: `${command.description} (${command.scope}/${command.source})`,
    usage: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
  }));
}

export function findCustomCommandHelpEntry(
  name: string,
  customCommands?: CommandCenterCustomCommandListOutcome,
): CommandCenterCustomCommand | undefined {
  return customCommands?.commands.find((command) => command.name === name);
}

export function formatCustomCommandHelpEntry(command: CommandCenterCustomCommand): string {
  return [
    `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
    command.description,
    `Source: ${command.scope}/${command.source}`,
    `Path: ${command.path}`,
  ].join("\n");
}

export function formatAvailableCommandNames(
  builtInCommands: readonly string[],
  customCommands?: CommandCenterCustomCommandListOutcome,
): string {
  const names = [
    ...builtInCommands,
    ...(customCommands?.commands.map((command) => `/${command.name}`) ?? []),
  ];
  return names.join(", ");
}

export async function buildCustomCommandPrompt(
  name: string,
  args: string,
  deps: CommandCenterCustomCommandDeps,
): Promise<string | undefined> {
  if (!deps.loadCustomCommand) return undefined;

  try {
    const command = await deps.loadCustomCommand(name);
    return expandCliCustomCommandPrompt({ args, command }).prompt;
  } catch (error) {
    if (error instanceof Error && customCommandNotFoundPattern.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

export async function listCustomCommandsForHelp(
  deps: CommandCenterCustomCommandDeps,
): Promise<CommandCenterCustomCommandListOutcome | undefined> {
  if (!deps.listCustomCommands) return undefined;
  try {
    return await deps.listCustomCommands();
  } catch {
    return undefined;
  }
}
