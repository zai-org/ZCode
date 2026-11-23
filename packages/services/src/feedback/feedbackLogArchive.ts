import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { parseAgentProcessExitDiagnostic } from "@zcode/shared/agent-crash-diagnostic";
import {
  redactFeedbackText,
  ZCODE_VERSION,
  ZCODE_COMMIT,
  CLI_MEMORY_FILE_PATTERN,
  CLI_MEMORY_MAX_FILE_BYTES,
  CLI_MEMORY_MAX_FILES,
  sanitizeCliMemoryDiagnostic,
} from "@zcode/shared";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface FeedbackLogSource {
  directory: string;
  archivePrefix: string;
  exitLogsOnly?: boolean;
  /** 只收集根目录下列出的文件名；用于允许单文件进入归档的配置入口。 */
  includeFileNames?: readonly string[];
  /** 默认只收集本地当天修改的文件；配置文件可关闭该限制。 */
  onlyCurrentDay?: boolean;
  /** 配置文件使用结构化安全投影，避免把插件自定义敏感项上传。 */
  contentPolicy?: "diagnostic" | "cli-config" | "cli-memory";
}

function diagnosticEncoding(buffer: Buffer): "utf-8" | "utf-16le" | "utf-16be" {
  return buffer[0] === 0xff && buffer[1] === 0xfe
    ? "utf-16le"
    : buffer[0] === 0xfe && buffer[1] === 0xff
      ? "utf-16be"
      : "utf-8";
}

function decodeDiagnosticLog(buffer: Buffer, encoding = diagnosticEncoding(buffer)): string | null {
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) return null;
    }
    return text;
  } catch {
    return null;
  }
}

function decodeDiagnosticTail(
  buffer: Buffer,
  encoding: ReturnType<typeof diagnosticEncoding>,
  jsonLines: boolean,
): string | null {
  const newline =
    encoding === "utf-8"
      ? Buffer.from([10])
      : Buffer.from(encoding === "utf-16le" ? [10, 0] : [0, 10]);
  const width = newline.length;
  let first = -1;
  let last = -1;
  for (
    let index = buffer.indexOf(newline);
    index >= 0;
    index = buffer.indexOf(newline, index + width)
  ) {
    if (index % width === 0) {
      if (first < 0) first = index;
      last = index;
    }
  }
  if (first < 0 || last <= first) return "";
  const text = decodeDiagnosticLog(buffer.subarray(first + width, last + width), encoding);
  if (text === null) return null;
  // 截点可能落在多行正文或私钥内部。只保留独立日志记录，不能把无字段名的续行当作安全文本。
  return text
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\[\d{4}-\d{2}-\d{2}[ T][^\]]+\] \[(?:debug|info|warn|error)\]/i.test(line)) return true;
      if (!jsonLines || !line.startsWith("{")) return false;
      try {
        return typeof JSON.parse(line) === "object";
      } catch {
        return false;
      }
    })
    .map((line) => `${line}\n`)
    .join("");
}

type SafeScalarType = "boolean" | "number" | "string";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickSafeSection(
  value: unknown,
  scalarFields: Readonly<Record<string, SafeScalarType>> = {},
  stringArrayFields: readonly string[] = [],
  booleanMapFields: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(scalarFields)) {
    if (typeof value[key] === type) result[key] = value[key];
  }
  for (const key of stringArrayFields) {
    const candidate = value[key];
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === "string")) {
      result[key] = candidate;
    }
  }
  for (const key of booleanMapFields) {
    const candidate = value[key];
    if (
      isRecord(candidate) &&
      Object.values(candidate).every((item) => typeof item === "boolean")
    ) {
      result[key] = candidate;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 只投影 CLI 的非敏感配置；插件 options、MCP、网络和 hooks 等未知字段全部舍弃。 */
function sanitizeCliConfig(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const projection: Record<string, unknown> = {};
  const root = pickSafeSection(parsed, { model: "string" });
  if (root) Object.assign(projection, root);
  const sections: ReadonlyArray<{
    key: string;
    scalarFields: Readonly<Record<string, SafeScalarType>>;
    stringArrayFields?: readonly string[];
    booleanMapFields?: readonly string[];
  }> = [
    { key: "modelStream", scalarFields: { idleTimeoutMs: "number" } },
    {
      key: "permission",
      scalarFields: {
        mode: "string",
        autoApproveHighRisk: "boolean",
        allowMediumRiskInAuto: "boolean",
      },
      stringArrayFields: ["allowedTools", "disallowedTools"],
    },
    {
      key: "features",
      scalarFields: {
        compact: "boolean",
        rewind: "boolean",
        subagent: "boolean",
        memory: "boolean",
        skill: "boolean",
        mcp: "boolean",
      },
    },
    { key: "memory", scalarFields: { use: "boolean" } },
    {
      key: "plugins",
      scalarFields: { enabled: "boolean" },
      stringArrayFields: ["suppressedBuiltins"],
      booleanMapFields: ["enabledPlugins"],
    },
    {
      key: "skills",
      scalarFields: {
        enabled: "boolean",
        includeInstructions: "boolean",
        metadataBudget: "number",
      },
    },
    { key: "logging", scalarFields: { level: "string", format: "string" } },
    { key: "ui", scalarFields: { locale: "string", theme: "string" } },
    { key: "toolConcurrency", scalarFields: { maxConcurrency: "number" } },
    {
      key: "modelAnomalyGuard",
      scalarFields: {
        toolCallWarningThreshold: "number",
        repeatedToolCallWarningThreshold: "number",
        maxBudgetWarningsPerTurn: "number",
      },
    },
  ];
  for (const sectionDefinition of sections) {
    const section = pickSafeSection(
      parsed[sectionDefinition.key],
      sectionDefinition.scalarFields,
      sectionDefinition.stringArrayFields,
      sectionDefinition.booleanMapFields,
    );
    if (section) projection[sectionDefinition.key] = section;
  }
  return redactFeedbackText(JSON.stringify(projection, null, 2), { diagnostic: true });
}

function sanitizeCliMemory(text: string): string | null {
  try {
    const record = sanitizeCliMemoryDiagnostic(JSON.parse(text));
    return record ? JSON.stringify(record) + "\n" : null;
  } catch {
    return null;
  }
}

function sanitizeDiagnosticLog(text: string): string {
  // stderr 整体属于敏感正文，不能放宽通用脱敏。只从已有的异常退出记录投影有界错误证据。
  const projected = text
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(
        /^(\[\d{4}-\d{2}-\d{2}[ T][^\]]+\] \[error\].*?ZCode agent process exited unexpectedly[^{}]*)(\{.*\})$/,
      );
      if (!match) return line;
      try {
        const record: unknown = JSON.parse(match[2]!);
        if (!isRecord(record) || !isRecord(record.stderr) || !Array.isArray(record.stderr.tail))
          return line;
        if (
          record.code !== null &&
          (typeof record.code !== "number" || !Number.isFinite(record.code))
        )
          return line;
        if (record.signal !== null && typeof record.signal !== "string") return line;
        const stderrTail = record.stderr.tail
          .slice(-20)
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.slice(0, 1000))
          // 仅认错误头和标准栈帧；未知正文不进入安全投影。
          .flatMap((value) => {
            // 裸地址前缀也会匹配日期和号码；只重建真实 Windows 的符号+偏移，舍弃附加正文。
            const nativeFrame = value.match(
              /^([ \t]*\d+:[ \t]*[0-9a-f]{16}[ \t]+)([A-Za-z_$~][\w:$~<>.]*\+\d+)(?=[ \t\r]|$)/i,
            );
            if (nativeFrame) return [nativeFrame[1]! + nativeFrame[2]!];
            return /^(?:FATAL ERROR:|(?:[A-Za-z_$][\w$]*Error|Error):|\s+at\s+|[ \t]*\d+:[ \t]*0x[0-9a-f]+(?=[ \t]|$))/i.test(
              value,
            )
              ? [value]
              : [];
          });
        const agentCrash = parseAgentProcessExitDiagnostic({
          exitCode: record.code as number | null,
          signal: record.signal as string | null,
          stderrTail,
          workspacePath: "",
        });
        // 错误头后常附带 token=... 等上下文；通用规则会删除整行。先舍弃附加字段，
        // 再走完整脱敏，保留错误前缀；不为原始 stderr 或未知正文开例外。
        const withoutContext = (value: string) =>
          value.replace(/(^|[ \t]+)["']?[\w.-]+["']?[ \t]*(?:=|:[ \t]+)[^\r\n]*/g, "$1[REDACTED]");
        // 原先对整段栈剥离字段，ERROR:、编号帧和后续错误头会被误删，\s 还会吞掉换行。
        // 逐行保护结构前缀，只处理错误摘要；栈帧继续交给下方完整脱敏，不能按键值字段截断。
        const errorStack = agentCrash.errorStack
          .split(/\r?\n/)
          .map((line) => {
            const header = line.match(
              /^((?:FATAL ERROR|[A-Za-z_$][\w$]*Error|Error):[ \t]*)(.*)$/i,
            );
            return header ? header[1] + withoutContext(header[2]!) : line;
          })
          .join("\n");
        return (
          match[1] +
          JSON.stringify({
            ...record,
            // 原始 stderr 只用于上面的安全投影；先删除，避免其中转义引号被文本脱敏改坏 JSON。
            stderr: "[REDACTED]",
            agentCrash: {
              ...agentCrash,
              errorMessage: withoutContext(agentCrash.errorMessage),
              errorStack,
            },
          })
        );
      } catch {
        return line;
      }
    })
    .join("\n");
  return redactFeedbackText(projected, { diagnostic: true });
}

/** 反馈上传唯一归档入口：白名单来源、有界读取、无法安全解码时禁止原文兜底。 */
export async function createFeedbackDiagnosticArchive(options: {
  sources: readonly FeedbackLogSource[];
  outputRootDir: string;
  now?: () => Date;
  maxTotalBytes?: number;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}): Promise<{ path: string; size: number }> {
  const now = options.now?.() ?? new Date();
  // 按本地自然日筛选文件；次日零点由日历计算，兼容夏令时的 23/25 小时日。
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const isToday = (mtimeMs: number) => mtimeMs >= dayStart && mtimeMs < dayEnd;
  await mkdir(options.outputRootDir, { recursive: true });
  const outputDir = await mkdtemp(join(options.outputRootDir, "archive-"));
  const path = join(outputDir, "zcode-diagnostic-logs.zip");
  const entries: Array<{ name: string; data: Buffer }> = [];
  const skippedLogFilesByReason: Record<string, number> = {};
  const skipLogFile = (reason: string) => {
    skippedLogFilesByReason[reason] = (skippedLogFilesByReason[reason] ?? 0) + 1;
  };
  let truncatedLogFiles = 0;
  let totalBytes = 0;
  let visited = 0;
  const budget = Math.min(options.maxTotalBytes ?? MAX_TOTAL_BYTES, MAX_TOTAL_BYTES);
  try {
    options.onProgress?.({ processedBytes: 0, totalBytes: 0 });
    // 为每个实际来源保留读取与遍历预算，避免第一份大日志挤掉 CLI 证据。
    const availableSources = await Promise.all(
      options.sources.map(async (source) => {
        // 不存在的目录没有诊断数据，不为它预留预算；仍拒绝根目录本身为链接。
        const root = await realpath(source.directory).catch(() => null);
        return root && (await lstat(source.directory).catch(() => null))?.isDirectory()
          ? { ...source, root }
          : undefined;
      }),
    );
    const sources = availableSources
      .filter((source) => source !== undefined)
      .sort(
        (a, b) =>
          Number(b.contentPolicy === "cli-memory") - Number(a.contentPolicy === "cli-memory") ||
          Number(Boolean(b.includeFileNames || b.exitLogsOnly)) -
            Number(Boolean(a.includeFileNames || a.exitLogsOnly)),
      );
    for (const [sourceIndex, source] of sources.entries()) {
      const { root } = source;
      const remainingSources = sources.length - sourceIndex;
      const sourceByteLimit = totalBytes + Math.floor((budget - totalBytes) / remainingSources);
      const sourceVisitLimit = visited + Math.floor((2000 - visited) / remainingSources);
      let memoryFiles = 0;
      const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
        if (depth > 4 || visited >= sourceVisitLimit) return;
        const names = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
          if (visited >= sourceVisitLimit) return;
          visited += 1;
          if (entry.isSymbolicLink()) continue;
          const absolutePath = join(directory, entry.name);
          const name = posix.join(prefix, entry.name);
          const isExplicitFileSource = source.includeFileNames !== undefined;
          if (
            entry.isDirectory() &&
            !source.exitLogsOnly &&
            !isExplicitFileSource &&
            source.contentPolicy !== "cli-memory"
          ) {
            await walk(absolutePath, name, depth + 1);
            continue;
          }
          if (
            !entry.isFile() ||
            (isExplicitFileSource
              ? !source.includeFileNames!.includes(entry.name)
              : !(source.exitLogsOnly
                  ? entry.name.endsWith(".exit.log")
                  : /(?:\.log(?:\.\d+)?|\.jsonl|\.ndjson)$/i.test(entry.name)))
          )
            continue;
          if (
            source.contentPolicy === "cli-memory" &&
            (!CLI_MEMORY_FILE_PATTERN.test(entry.name) || memoryFiles >= CLI_MEMORY_MAX_FILES)
          )
            continue;
          if ((await realpath(absolutePath).catch(() => null)) !== absolutePath) {
            skipLogFile("unsafe-path");
            continue;
          }
          const info = await lstat(absolutePath).catch(() => null);
          const metadataFailure = !info?.isFile()
            ? "not-regular-file"
            : info.nlink !== 1
              ? "hard-link"
              : source.onlyCurrentDay !== false && !isToday(info.mtimeMs)
                ? "not-current-day"
                : null;
          if (metadataFailure || !info) {
            skipLogFile(metadataFailure ?? "not-regular-file");
            continue;
          }
          // O_NOFOLLOW 防止检查后把文件替换为链接；按打开后的 inode 再校验。
          const handle = await open(
            absolutePath,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          ).catch(() => null);
          if (!handle) {
            skipLogFile("open-failed");
            continue;
          }
          try {
            const opened = await handle.stat();
            if (
              !opened.isFile() ||
              opened.nlink !== 1 ||
              opened.ino !== info.ino ||
              opened.dev !== info.dev ||
              (source.onlyCurrentDay !== false && !isToday(opened.mtimeMs))
            ) {
              skipLogFile("opened-file-policy");
              continue;
            }
            const fileLimit =
              source.contentPolicy === "cli-memory" ? CLI_MEMORY_MAX_FILE_BYTES : MAX_FILE_BYTES;
            const limit = Math.min(fileLimit, sourceByteLimit - totalBytes);
            if (
              limit <= 0 ||
              ((source.contentPolicy === "cli-config" || source.contentPolicy === "cli-memory") &&
                opened.size > limit)
            ) {
              skipLogFile(
                limit >= fileLimit
                  ? "file-size-limit"
                  : sourceByteLimit < budget
                    ? "source-size-limit"
                    : "total-size-limit",
              );
              continue;
            }
            // 当天主日志常超过上限，整份跳过会丢失更新错误。固定本次快照末尾，按剩余预算读尾部。
            // 配置仍须完整投影；追加不改变已选窗口，短读仍跳过，避免混入后续写入或半份数据。
            let offset = Math.max(0, opened.size - limit);
            let encoding: ReturnType<typeof diagnosticEncoding> = "utf-8";
            if (offset > 0) {
              const header = Buffer.alloc(2);
              await handle.read(header, 0, 2, 0);
              encoding = diagnosticEncoding(header);
              if (encoding !== "utf-8" && offset % 2 !== 0) offset += 1;
            }
            const bytes = Buffer.alloc(opened.size - offset);
            let length = 0;
            while (length < bytes.length) {
              const read = await handle.read(bytes, length, bytes.length - length, offset + length);
              if (!read.bytesRead) break;
              length += read.bytesRead;
            }
            if (length !== bytes.length) {
              skipLogFile("short-read");
              continue;
            }
            const text =
              offset > 0
                ? decodeDiagnosticTail(bytes, encoding, /\.(?:jsonl|ndjson)$/i.test(name))
                : decodeDiagnosticLog(bytes);
            if (text === null) {
              skipLogFile("unsupported-text");
              continue;
            }
            if (offset > 0 && !text) {
              skipLogFile("no-complete-record");
              continue;
            }
            const sanitizedText =
              source.contentPolicy === "cli-memory"
                ? sanitizeCliMemory(text)
                : source.contentPolicy === "cli-config"
                  ? sanitizeCliConfig(text)
                  : sanitizeDiagnosticLog(text);
            if (sanitizedText === null) {
              skipLogFile(
                source.contentPolicy === "cli-memory"
                  ? "invalid-memory-diagnostic"
                  : "invalid-config",
              );
              continue;
            }
            let data = Buffer.from(sanitizedText);
            const outputTruncated =
              data.length > limit &&
              source.contentPolicy !== "cli-config" &&
              source.contentPolicy !== "cli-memory";
            if (outputTruncated) {
              // 脱敏标记可能比原值更长；已脱敏内容仍按完整行保留末尾，不能再因膨胀丢掉整个日志。
              const boundary = data.indexOf(10, data.length - limit - 1);
              if (boundary >= 0) data = data.subarray(boundary + 1);
            }
            if (!data.length || data.length > limit) {
              skipLogFile("redacted-size-limit");
              continue;
            }
            if (source.contentPolicy === "cli-memory") memoryFiles += 1;
            entries.push({ name, data });
            if (offset > 0 || outputTruncated) truncatedLogFiles += 1;
            totalBytes += Math.max(length, data.length);
          } finally {
            await handle.close();
          }
        }
      };
      await walk(root, source.archivePrefix, 0);
    }
    const zip = new ZipFile();
    const output = createWriteStream(path, { mode: 0o600 });
    // pipeline 同时监听 ZIP 和输出错误，失败统一清理本次目录。
    const writing = pipeline(zip.outputStream, output);
    for (const entry of entries) zip.addBuffer(entry.data, entry.name);
    zip.addBuffer(
      Buffer.from(
        [
          "ZCode diagnostic logs",
          `timestamp: ${now.toISOString()}`,
          `appVersion: ${ZCODE_VERSION}`,
          `commit: ${ZCODE_COMMIT}`,
          `node: ${process.version}`,
          `os: ${platform()} ${release()} (${arch()})`,
          `includedLogFiles: ${entries.length}`,
          `truncatedLogFiles: ${truncatedLogFiles}`,
          `skippedLogFiles: ${Object.values(skippedLogFilesByReason).reduce((sum, count) => sum + count, 0)}`,
          `skippedLogFilesByReason: ${JSON.stringify(skippedLogFilesByReason)}`,
          "Scope: diagnostic text logs modified today (oversized logs retain complete tail records), bounded CLI memory evidence and a non-sensitive CLI config projection; credentials and payloads redacted.",
        ].join("\n"),
      ),
      "about.txt",
    );
    zip.end();
    await writing;
    const { size } = await stat(path);
    options.onProgress?.({ processedBytes: size, totalBytes: size });
    return { path, size };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}
