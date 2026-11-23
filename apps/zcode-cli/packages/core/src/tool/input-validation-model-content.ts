import type { UnparsedToolInput } from "@zcode/contracts";
import type {
  ToolInputValidationIssue,
  ToolInputValidationPath,
} from "./tool-input-validation-issues.js";
import type { ToolEntry } from "./types.js";

/** other 类 issue 最多列出的行数，超出的写成一行数量。 */
const MAX_OTHER_ISSUE_LINES = 20;
/** other 类 issue 的 message 最多保留的码元数。 */
const MAX_OTHER_ISSUE_MESSAGE_LENGTH = 500;

/** 工具入参不是合法 JSON 时给模型的文字（docs/model-tool-call-validation.md「Malformed tool input JSON」）。 */
export function createUnparsedToolInputModelContent(
  toolName: string,
  unparsed: UnparsedToolInput,
): string {
  return [
    `<tool_use_error>InputValidationError: ${toolName} was called with input that could not be parsed as JSON.`,
    `You sent (first ${unparsed.preview.length} of ${unparsed.length} bytes): ${unparsed.preview}`,
    "Common causes: unescaped backslashes in file paths (use / or \\\\), unescaped control characters, or truncated output. Retry with valid JSON.</tool_use_error>",
  ].join("\n");
}

export function createInitialInputValidationModelContent(
  entry: ToolEntry,
  issues: readonly ToolInputValidationIssue[],
  note = "",
): string {
  return `<tool_use_error>InputValidationError: ${formatToolInputValidationError(
    entry.metadata.name,
    issues,
  )}${note}</tool_use_error>`;
}

/**
 * runtime parse 失败时给模型的 issues，规则见 docs/model-tool-call-validation.md。runtime issues（zod 4 的目标
 * 结构与顺序）原样保留；provider schema 比 runtime schema 严格的地方由 JSON Schema issues 补上：
 * - runtime 在某个位置报 union 失败、JSON Schema 在同一位置没有报 union 失败时，换成 JSON Schema 在这个位置之下的 issues；
 * - 多余参数，以及 provider 要求、没有默认值、runtime 没报的缺参，追加在后面。
 */
export function selectRuntimeFailureIssues(
  inputSchema: ToolEntry["inputSchema"],
  runtimeIssues: readonly ToolInputValidationIssue[],
  jsonIssues: readonly ToolInputValidationIssue[],
): ToolInputValidationIssue[] {
  const issues = runtimeIssues.flatMap((issue) => {
    if (issue.code !== "invalid_union") return [issue];
    if (
      jsonIssues.some((json) => json.code === "invalid_union" && samePath(json.path, issue.path))
    ) {
      return [issue];
    }
    const providerIssues = jsonIssues.filter((json) => isWithinPath(json.path, issue.path));
    return providerIssues.length > 0 ? providerIssues : [issue];
  });
  for (const json of jsonIssues) {
    if (!isProviderOnlyStructuralIssue(json, inputSchema)) continue;
    if (issues.some((issue) => issue.code === json.code && samePath(issue.path, json.path)))
      continue;
    issues.push(json);
  }
  return issues;
}

function isProviderOnlyStructuralIssue(
  issue: ToolInputValidationIssue,
  inputSchema: ToolEntry["inputSchema"],
): boolean {
  if (issue.code === "unrecognized_keys") return true;
  if (issue.code !== "invalid_type" || !issue.message.includes("received undefined")) return false;
  const schemaNode = readSchemaAtPath(inputSchema, issue.path);
  return !schemaNode || !Object.hasOwn(schemaNode, "default");
}

function readSchemaAtPath(
  schema: ToolEntry["inputSchema"],
  path: ToolInputValidationPath,
): Record<string, unknown> | undefined {
  let current: unknown = schema;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    if (typeof segment === "number") {
      current = current.items;
      continue;
    }
    current = isRecord(current.properties) ? current.properties[segment] : undefined;
  }
  return isRecord(current) ? current : undefined;
}

function samePath(left: ToolInputValidationPath, right: ToolInputValidationPath): boolean {
  return left.length === right.length && isWithinPath(left, right);
}

function isWithinPath(path: ToolInputValidationPath, parent: ToolInputValidationPath): boolean {
  return path.length >= parent.length && parent.every((segment, index) => path[index] === segment);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatToolInputValidationError(
  toolName: string,
  issues: readonly ToolInputValidationIssue[],
): string {
  const missingParameters = issues
    .filter(
      (issue) => issue.code === "invalid_type" && issue.message.includes("received undefined"),
    )
    .map((issue) => formatValidationPath(issue.path));
  // 修复原因：嵌套对象里的多余参数原来只写 key，看不出在哪一层；现在拼上 issue 自身的路径。
  const unexpectedParameters = issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => formatValidationPath([...issue.path, key]))
      : [],
  );
  const wrongTypes = issues.flatMap((issue) => {
    if (issue.code !== "invalid_type" || issue.message.includes("received undefined")) {
      return [];
    }
    return [
      {
        expected: issue.expected,
        param: formatValidationPath(issue.path),
        received: issue.message.match(/received (\w+)/)?.[1] ?? "unknown",
      },
    ];
  });

  const lines: string[] = [
    ...missingParameters.map((parameter) => `The required parameter \`${parameter}\` is missing`),
    ...unexpectedParameters.map(
      (parameter) => `An unexpected parameter \`${parameter}\` was provided`,
    ),
    ...wrongTypes.map(
      ({ expected, param, received }) =>
        `The parameter \`${param}\` type is expected as \`${expected}\` but provided as \`${received}\``,
    ),
  ];
  if (lines.length > 0) {
    // 修复原因：原来有参数类问题时，同一批的其他问题（范围、格式、枚举）整行丢掉，模型修好缺参后还要再错一次。
    const otherLines = issues.filter((issue) => !isParameterIssue(issue)).map(formatOtherIssue);
    lines.push(...otherLines.slice(0, MAX_OTHER_ISSUE_LINES));
    const unlisted = otherLines.length - MAX_OTHER_ISSUE_LINES;
    if (unlisted > 0) {
      lines.push(`(${unlisted} more ${unlisted === 1 ? "issue" : "issues"} not listed)`);
    }
    return `${toolName} failed due to the following ${
      lines.length > 1 ? "issues" : "issue"
    }:\n${lines.join("\n")}`;
  }

  return (
    JSON.stringify(
      issues,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ) ?? "[]"
  );
}

function isParameterIssue(issue: ToolInputValidationIssue): boolean {
  return issue.code === "invalid_type" || issue.code === "unrecognized_keys";
}

function formatOtherIssue(issue: ToolInputValidationIssue): string {
  const path = formatValidationPath(issue.path);
  const subject = path === "" ? "The input" : `The parameter \`${path}\``;
  const message = truncateIssueMessage(issue.message.replace(/^Invalid input(?:: |$)/u, ""));
  if (message !== "") return `${subject} is invalid: ${message}`;
  return issue.code === "invalid_union"
    ? `${subject} matches none of the accepted forms`
    : `${subject} is invalid`;
}

function truncateIssueMessage(message: string): string {
  if (message.length <= MAX_OTHER_ISSUE_MESSAGE_LENGTH) return message;
  let head = message.slice(0, MAX_OTHER_ISSUE_MESSAGE_LENGTH);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}\u2026 [+${message.length - head.length} chars]`;
}

function formatValidationPath(path: ToolInputValidationPath): string {
  if (path.length === 0) return "";
  return path.reduce<string>((formatted, segment, index) => {
    if (typeof segment === "number") return `${formatted}[${segment.toString()}]`;
    return index === 0 ? segment : `${formatted}.${segment}`;
  }, "");
}
