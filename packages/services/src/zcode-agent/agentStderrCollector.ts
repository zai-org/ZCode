import { redactAgentDiagnosticSecrets } from "@zcode/shared/agent-crash-diagnostic";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export const EXIT_STDERR_DRAIN_MS = 250;

/** stderr 的寿命独立于协议；child exit 时管道中仍可能有最后一行诊断。 */
export class AgentStderrCollector {
  private readonly reader;
  private readonly drained: Promise<void>;
  private resolveDrained!: () => void;
  private done = false;
  private deadlineAt = Infinity;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(input: Readable, onLine?: (line: string) => void) {
    this.drained = new Promise((resolve) => {
      this.resolveDrained = resolve;
    });
    this.reader = createInterface({ input });
    this.reader.on("line", (line) => onLine?.(line));
    this.reader.once("close", this.finish);
    this.reader.on("error", this.finish);
    // 只有诊断出口不可用，不能因此撤销仍然健康的 stdin/stdout 协议。
    input.on("error", this.finish);
    input.once("close", this.finish);
    if (input.destroyed || input.readableEnded) this.finish();
  }

  waitForDrain(timeoutMs = EXIT_STDERR_DRAIN_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    if (!this.done && deadline < this.deadlineAt) {
      this.deadlineAt = deadline;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(this.finish, Math.max(0, timeoutMs));
    }
    return this.drained;
  }

  private readonly finish = (): void => {
    if (this.done) return;
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.reader.close();
    this.resolveDrained();
  };
}

const AGENT_STDERR_TAIL_MAX_LINES = 20;
const AGENT_STDERR_LINE_MAX_CHARS = 1_000;

export function createAgentStderrTail(): {
  append(line: string): void;
  snapshot(): { lineCount: number; tail: string[] };
} {
  const tail: string[] = [];
  let lineCount = 0;

  return {
    append(line) {
      lineCount += 1;
      const redacted = redactAgentDiagnosticSecrets(line);
      const bounded =
        redacted.length > AGENT_STDERR_LINE_MAX_CHARS
          ? `${redacted.slice(0, AGENT_STDERR_LINE_MAX_CHARS)}…[truncated]`
          : redacted;
      tail.push(bounded);
      if (tail.length > AGENT_STDERR_TAIL_MAX_LINES) {
        const continuingStack = /^\s*(?:$|\d+:\s*(?:0x)?[0-9a-f]{6,}\b|at\s+|---|<---)/i.test(line);
        const preserveFatal = tail[0]?.startsWith("FATAL ERROR:") && continuingStack;
        // native 栈常超过 20 行，原先会把真正的 OOM 错误头挤掉；仍保留同样大小的尾部。
        tail.splice(preserveFatal ? 1 : 0, 1);
      }
    },
    snapshot() {
      return { lineCount, tail: [...tail] };
    },
  };
}
