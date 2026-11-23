export interface BackgroundTaskOutputMetadata {
  childSessionId?: string;
  outputBytes?: number;
  outputFile?: string;
  outputTail?: string;
  outputTruncated?: boolean;
  stderrBytes?: number;
  stderrFile?: string;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutFile?: string;
  stdoutTail?: string;
}

export function backgroundTaskOutputMetadata(
  snapshot: object | undefined,
  launchOutput?: Record<string, unknown>,
): BackgroundTaskOutputMetadata {
  const result = recordProperty(snapshot, "result");
  // 后台 Agent 的 child session 身份若只留在 Agent output / runtime
  // snapshot，BackgroundTask* 事件就不会带出，V4 Running 行因此无法打开右侧详情。
  const childSessionId =
    stringProperty(snapshot, "childSessionId") ?? stringProperty(launchOutput, "childSessionId");
  const stdout = recordProperty(result, "stdout");
  const stderr = recordProperty(result, "stderr");
  const stdoutFile =
    stringProperty(snapshot, "stdoutPersistedOutputPath") ??
    stringProperty(stdout, "artifactPath") ??
    stringProperty(launchOutput, "stdoutPersistedOutputPath");
  const stderrFile =
    stringProperty(snapshot, "stderrPersistedOutputPath") ??
    stringProperty(stderr, "artifactPath") ??
    stringProperty(launchOutput, "stderrPersistedOutputPath");
  const outputFile =
    stringProperty(snapshot, "outputPath") ??
    stringProperty(snapshot, "outputFile") ??
    stringProperty(snapshot, "persistedOutputPath") ??
    stringProperty(snapshot, "rawOutputPath") ??
    stringProperty(launchOutput, "persistedOutputPath") ??
    stringProperty(launchOutput, "rawOutputPath") ??
    stringProperty(launchOutput, "outputFile") ??
    stdoutFile ??
    stderrFile;
  const stdoutBytes =
    numberProperty(stdout, "bytes") ??
    numberProperty(snapshot, "stdoutBytes");
  const stderrBytes =
    numberProperty(stderr, "bytes") ??
    numberProperty(snapshot, "stderrBytes");
  const stdoutTail =
    stringProperty(stdout, "text") ||
    stringProperty(snapshot, "stdoutTail");
  const stderrTail =
    stringProperty(stderr, "text") ||
    stringProperty(snapshot, "stderrTail");
  const workflowOutput = recordProperty(snapshot, "output");
  const workflowTail = stringProperty(workflowOutput, "response");
  const outputBytes =
    stdoutBytes === undefined && stderrBytes === undefined
      ? undefined
      : (stdoutBytes ?? 0) + (stderrBytes ?? 0);
  const outputTruncated =
    result === undefined
      ? undefined
      : booleanProperty(stdout, "truncated") === true ||
        booleanProperty(stderr, "truncated") === true ||
        booleanProperty(stdout, "artifactTruncated") === true ||
        booleanProperty(stderr, "artifactTruncated") === true;

  return {
    childSessionId,
    outputBytes,
    outputFile,
    outputTail: stdoutTail ?? stderrTail ?? workflowTail,
    outputTruncated,
    stderrBytes,
    stderrFile,
    stderrTail,
    stdoutBytes,
    stdoutFile,
    stdoutTail,
  };
}

function recordProperty(
  record: object | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (!record || !(key in record)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return isRecord(value) ? value : undefined;
}

function stringProperty(record: object | undefined, key: string): string | undefined {
  if (!record || !(key in record)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function numberProperty(record: object | undefined, key: string): number | undefined {
  if (!record || !(key in record)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function booleanProperty(record: object | undefined, key: string): boolean | undefined {
  if (!record || !(key in record)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const READ_TOOL_NAME = "Read";
const BASH_TOOL_NAME = "Bash";

/** 有 Read 或 Bash 工具时，模型能读后台任务的输出文件。 */
export function canReadBackgroundOutputFile(toolNames: readonly string[] | undefined): boolean {
  const names = new Set(toolNames ?? []);
  return names.has(READ_TOOL_NAME) || names.has(BASH_TOOL_NAME);
}
