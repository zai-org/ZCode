import { parseAgentProcessExitDiagnostic, type AgentCrashDiagnostic } from "./contract.js";

// Windows 系统可提交内存耗尽：退出码直接定性，stderr 只保留在 errorStack。
export const nativeOutOfMemoryExample: AgentCrashDiagnostic = parseAgentProcessExitDiagnostic({
  exitCode: 0xe0000008,
  signal: null,
  stderrTail: ["    server: 'example',", "  responseStatus: 429,", "}"],
  workspacePath: "/Users/dev/project",
});
