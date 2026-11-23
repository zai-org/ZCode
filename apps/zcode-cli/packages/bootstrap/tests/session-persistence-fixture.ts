import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface LogEntry {
  event?: string;
  context?: Record<string, unknown>;
}

export async function readLogEntries(logDir: string): Promise<LogEntry[]> {
  const files = await readdir(logDir);
  const entries: LogEntry[] = [];

  for (const file of files) {
    const content = await readFile(join(logDir, file), "utf8");
    for (const line of content.trim().split("\n")) {
      if (line) entries.push(JSON.parse(line) as LogEntry);
    }
  }

  return entries;
}
