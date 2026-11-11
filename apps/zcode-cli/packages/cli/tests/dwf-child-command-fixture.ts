import { Readable } from "node:stream";
import type { RunContext } from "@zcode/shared-types";

export const createCapturedStdout = () => {
  let output = "";
  return {
    output: () => output,
    stream: {
      isTTY: false,
      write: (chunk: string | Uint8Array): boolean => {
        output += typeof chunk === "string" ? chunk : chunk.toString();
        return true;
      },
    } as unknown as NodeJS.WriteStream,
  };
};

/**
 * 子进程语境的 RunContext：stdin 必须是**真** Readable（childMain 拿它建 readline，
 * cli.unit.test.ts 里那个 `{ isTTY: false }` 假 stdin 会直接让 readline 抛错）。
 * 这里给一条立即 EOF 的空流：本用例的脚本不发 ask，父进程也就没有 response 要喂。
 */
export const createChildContext = (
  argv: string[],
): { ctx: RunContext; stdout: () => string; stderr: () => string } => {
  const stdout = createCapturedStdout();
  const stderr = createCapturedStdout();
  return {
    ctx: {
      argv,
      stderr: stderr.stream,
      stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
      stdout: stdout.stream,
    },
    stdout: stdout.output,
    stderr: stderr.output,
  };
};
