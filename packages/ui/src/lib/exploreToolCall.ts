import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const stripWrappingQuotes = (value: string) => {
    const normalized = value.trim();
    if (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      return normalized.slice(1, -1).trim();
    }
    return normalized;
  };
  const shellCommandMatch = trimmed.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i);
  if (shellCommandMatch?.[1]) {
    return stripWrappingQuotes(shellCommandMatch[1]);
  }

  const powershellCommandMatch = trimmed.match(
    /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[\s\S]*?\s-(?:command|c)\s+([\s\S]+)$/i,
  );
  if (powershellCommandMatch?.[1]) {
    return stripWrappingQuotes(powershellCommandMatch[1]);
  }

  return trimmed;
}

function normalizeCommandCandidate(candidate: string): string[] {
  const unwrapped = unwrapShellCommand(candidate);
  if (unwrapped.length === 0) {
    return [];
  }

  return splitCommandSegments(unwrapped);
}

function extractToolCommands(input: unknown): string[] {
  const commandCandidates: string[] = [];

  const collectFromValue = (value: unknown) => {
    if (typeof value === "string") {
      const command = value.trim();
      if (command.length > 0) {
        commandCandidates.push(command);
      }
      return;
    }

    if (!Array.isArray(value)) {
      return;
    }

    if (value.every((item) => typeof item === "string")) {
      const commandParts = value as string[];
      const shellCommandIndex = commandParts.findIndex((part) => part === "-lc");
      if (shellCommandIndex >= 0 && typeof commandParts[shellCommandIndex + 1] === "string") {
        const shellCommand = commandParts[shellCommandIndex + 1]!.trim();
        if (shellCommand.length > 0) {
          commandCandidates.push(shellCommand);
          return;
        }
      }

      const joinedCommand = commandParts.join(" ").trim();
      if (joinedCommand.length > 0) {
        commandCandidates.push(joinedCommand);
      }
      return;
    }

    for (const item of value) {
      if (!isPlainRecord(item)) {
        continue;
      }

      const parsedCommand = item.cmd;
      if (typeof parsedCommand === "string" && parsedCommand.trim().length > 0) {
        commandCandidates.push(parsedCommand.trim());
      }
    }
  };

  collectFromValue(input);

  if (!isPlainRecord(input)) {
    return Array.from(
      new Set(commandCandidates.flatMap((candidate) => normalizeCommandCandidate(candidate))),
    );
  }

  for (const key of ["command", "cmd", "script", "parsed_cmd"] as const) {
    collectFromValue(input[key]);
  }

  return Array.from(
    new Set(commandCandidates.flatMap((candidate) => normalizeCommandCandidate(candidate))),
  );
}

export function isShellToolCallAwaitingCommand({ kind, input }: { kind: string; input: unknown }) {
  const identity = resolveToolCallIdentity({ kind, input });
  return identity.family === "shell" && extractToolCommands(input).length === 0;
}
