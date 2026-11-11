import type { LogContext, Logger, LoggerFactory } from "@zcode/contracts";
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

export function createRecordingLoggerFactory(): LoggerFactory & {
  events: string[];
  scheduleCalls: number;
  scheduleLogRetentionCleanup(options?: { logger?: Logger }): void;
} {
  const events: string[] = [];
  let scheduleCalls = 0;

  const loggerFor = (context: LogContext = {}): Logger => ({
    child(childContext) {
      return loggerFor({ ...context, ...childContext });
    },
    debug(_message, logContext) {
      recordEvent(events, context, logContext);
    },
    error(_message, _error, logContext) {
      recordEvent(events, context, logContext);
    },
    info(_message, logContext) {
      recordEvent(events, context, logContext);
    },
    warn(_message, logContext) {
      recordEvent(events, context, logContext);
    },
  });

  return {
    createLogger: () => loggerFor(),
    events,
    get scheduleCalls() {
      return scheduleCalls;
    },
    scheduleLogRetentionCleanup() {
      scheduleCalls += 1;
      events.push("scheduleLogRetentionCleanup");
    },
    setLevel: () => {},
    withContext: (context) => loggerFor(context),
  };
}

function recordEvent(events: string[], baseContext: LogContext, context?: LogContext): void {
  const event = context?.event ?? baseContext.event;
  if (typeof event === "string") {
    events.push(event);
  }
}
