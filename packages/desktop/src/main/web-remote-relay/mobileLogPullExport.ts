// 「拉取手机日志」：向已配对手机发 mobile-log-pull-request，分片逐片写入
// ~/.zcode/export-log/mobile-logs-<设备>-<时间>.jsonl，结束后弹框给出路径。
// 入口：帮助菜单、远控面板连接卡片。
// 文件结构：首行 header（kind=mobile-log-pull）、中间每行一条日志、末行 summary。
// 文件在首片到达（或成功结束）时才创建，并以 wx 独占打开：busy 等「还没开始就失败」的情况
// 不会碰到磁盘，也不会截断或删除另一次导出的同名文件。
// 失败时：已写入条目 > 0 保留部分文件；否则删除文件。
// 日志统一 `[web-remote-control] zcode_rc_log_pull_start/_result`，result 带 outcome、耗时、字节数、错误码。

import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { toZhOrEnLocale, type Locale } from "@zcode/shared";
import {
  MobileLogPullError,
  type MobileLogPullErrorCode,
  type MobileLogPullQuery,
  type MobileLogPullShard,
  type MobileLogPullSummary,
} from "#src/main/web-remote-relay/mobileLogPull.js";
import {
  sanitizeMobileLogPathSegment,
  serializeMobileLogEntry,
} from "#src/main/web-remote-relay/mobileLogSink.js";

/** 默认拉取最近 24 小时、全部级别；条数安全阀 20 万条。 */
export const MOBILE_LOG_PULL_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MOBILE_LOG_PULL_DEFAULT_MAX_ENTRIES = 200_000;

export interface MobileLogPullExportDependencies {
  findTarget(windowId: number | undefined): { windowId: number; deviceLabel: string } | undefined;
  pull(
    windowId: number,
    query: MobileLogPullQuery,
    onShard: (shard: MobileLogPullShard) => Promise<void>,
  ): Promise<MobileLogPullSummary>;
  exportDir: string;
  locale: Locale;
  now?: () => Date;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  /** 实时上传日志目录，弹框里一并告知。 */
  realtimeLogDir: string;
  /** 返回被点按钮的下标。 */
  showMessage(options: {
    type: "info" | "warning";
    title: string;
    message: string;
    detail: string;
    buttons: string[];
  }): Promise<number>;
  showItemInFolder(path: string): void | Promise<void>;
}

export type MobileLogPullExportResult =
  | { status: "exported"; path: string; summary: MobileLogPullSummary }
  | { status: "failed"; code: MobileLogPullErrorCode; path?: string; error: string };

const TEXT = {
  "zh-CN": {
    title: "拉取手机日志",
    done: (count: number) => `已导出 ${count} 条手机日志。`,
    truncated: "日志超过上限，仅保留了最新的部分。",
    partial: (count: number) => `拉取中断，已保存 ${count} 条日志。`,
    path: "文件",
    realtime: "实时上传日志目录",
    openFolder: "打开所在文件夹",
    ok: "好",
    errors: {
      "not-paired": "当前没有已连接的手机。请先用手机扫码连接远程控制。",
      busy: "正在拉取手机日志，请等待当前拉取完成。",
      unsupported: "手机端版本不支持日志拉取，请升级手机 App 后重试。",
      timeout: "手机长时间未响应，请确认手机 App 在前台且网络正常后重试。",
      disconnected: "远程控制连接已断开，拉取中止。",
      "mobile-error": "手机端返回错误。",
      "invalid-shard": "收到的日志数据无法解析或写入失败。",
    } satisfies Record<MobileLogPullErrorCode, string>,
  },
  "en-US": {
    title: "Pull Mobile Logs",
    done: (count: number) => `Exported ${count} mobile log entries.`,
    truncated: "Logs exceeded the limit; only the newest entries were kept.",
    partial: (count: number) => `Pull interrupted; ${count} entries were saved.`,
    path: "File",
    realtime: "Realtime upload log folder",
    openFolder: "Show in Folder",
    ok: "OK",
    errors: {
      "not-paired": "No mobile device is connected. Pair a phone via remote control first.",
      busy: "A mobile log pull is already running. Please wait for it to finish.",
      unsupported: "The mobile app does not support log pulling. Update the app and try again.",
      timeout: "The phone did not respond. Keep the app in the foreground and try again.",
      disconnected: "Remote control disconnected; the pull was aborted.",
      "mobile-error": "The phone returned an error.",
      "invalid-shard": "Received log data could not be parsed or written.",
    } satisfies Record<MobileLogPullErrorCode, string>,
  },
} as const;

function formatFileTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function toPullError(error: unknown): MobileLogPullError {
  return error instanceof MobileLogPullError
    ? error
    : new MobileLogPullError(
        "invalid-shard",
        error instanceof Error ? error.message : String(error),
      );
}

type MobileLogExportOutcome =
  | { ok: true; path: string; summary: MobileLogPullSummary; bytes: number }
  | { ok: false; error: MobileLogPullError; path?: string; bytes: number };

/** 拉取结果日志：成功与失败共用一行格式，便于 grep zcode_rc_log_pull。 */
function logPullResult(
  dependencies: MobileLogPullExportDependencies,
  input: {
    startedAtMs: number;
    outcome: MobileLogExportOutcome;
  },
): void {
  const { outcome } = input;
  const fields = {
    ...(outcome.ok ? { request_id: outcome.summary.requestId } : {}),
    outcome: outcome.ok ? "ok" : "error",
    ...(outcome.ok ? {} : { error_code: outcome.error.code, error_msg: outcome.error.message }),
    duration_ms: Math.max(0, (dependencies.now?.() ?? new Date()).getTime() - input.startedAtMs),
    bytes: outcome.bytes,
    entries: outcome.ok ? outcome.summary.entryCount : outcome.error.entryCount,
    ...(outcome.ok
      ? {
          shards: outcome.summary.shardCount,
          compressed_shards: outcome.summary.compressedShardCount,
          truncated: outcome.summary.truncated,
        }
      : {}),
    ...(outcome.path ? { file: basename(outcome.path) } : {}),
  };
  if (outcome.ok) {
    dependencies.logger.info("[web-remote-control] zcode_rc_log_pull_result", fields);
  } else {
    dependencies.logger.warn("[web-remote-control] zcode_rc_log_pull_result", fields);
  }
}

/** 拉取并写文件（不含任何 UI）；所有失败都收敛成 MobileLogPullError，不向外抛。 */
async function exportMobileLogsToFile(
  dependencies: MobileLogPullExportDependencies,
  input: {
    target: { windowId: number; deviceLabel: string };
    query: MobileLogPullQuery;
  },
): Promise<MobileLogExportOutcome> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const deviceSegment = sanitizeMobileLogPathSegment(input.target.deviceLabel, "mobile");
  const filePath = join(
    dependencies.exportDir,
    `mobile-logs-${deviceSegment}-${formatFileTimestamp(startedAt)}.jsonl`,
  );
  dependencies.logger.info("[web-remote-control] zcode_rc_log_pull_start", {
    window: input.target.windowId,
    since_ts: input.query.sinceTs,
    until_ts: input.query.untilTs,
    max_entries: input.query.maxEntries,
  });

  // 闭包里懒创建文件，用对象承载句柄，避免 let 变量在闭包赋值后被 TS 误收窄。
  const file: { handle?: FileHandle } = {};
  let bytes = 0;
  const write = async (text: string) => {
    let handle = file.handle;
    if (!handle) {
      await mkdir(dependencies.exportDir, { recursive: true });
      // wx：同名文件已存在时失败，绝不截断别的导出。
      handle = await open(filePath, "wx");
      file.handle = handle;
      const header = `${JSON.stringify({
        kind: "mobile-log-pull",
        startedAt: startedAt.toISOString(),
        device: input.target.deviceLabel,
        query: input.query,
      })}\n`;
      await handle.write(header);
      bytes += Buffer.byteLength(header);
    }
    if (!text) return;
    await handle.write(text);
    bytes += Buffer.byteLength(text);
  };

  let outcome: MobileLogExportOutcome;
  try {
    const summary = await dependencies.pull(input.target.windowId, input.query, async (shard) => {
      if (shard.entries.length === 0) return;
      await write(`${shard.entries.map(serializeMobileLogEntry).join("\n")}\n`);
    });
    await write(
      `${JSON.stringify({ kind: "mobile-log-pull-summary", finishedAt: now().toISOString(), ...summary })}\n`,
    );
    outcome = { ok: true, path: filePath, summary, bytes };
  } catch (error) {
    outcome = { ok: false, error: toPullError(error), bytes };
  } finally {
    await file.handle?.close();
  }

  if (!outcome.ok && file.handle) {
    if (outcome.error.entryCount > 0) outcome = { ...outcome, path: filePath };
    else await rm(filePath, { force: true });
  }
  logPullResult(dependencies, { startedAtMs: startedAt.getTime(), outcome });
  return outcome;
}

/** 帮助菜单 / 远控面板入口：拉取最近 24 小时并弹框告知结果。 */
export async function pullAndExportMobileLogs(
  windowId: number | undefined,
  dependencies: MobileLogPullExportDependencies,
): Promise<MobileLogPullExportResult> {
  // 提示框只内置中英；其它界面语言用英文。
  const text = TEXT[toZhOrEnLocale(dependencies.locale)];
  const now = dependencies.now ?? (() => new Date());
  const showResult = async (input: {
    type: "info" | "warning";
    message: string;
    path?: string;
  }) => {
    const detailLines = [
      ...(input.path ? [`${text.path}: ${input.path}`] : []),
      `${text.realtime}: ${dependencies.realtimeLogDir}`,
    ];
    const buttons = input.path ? [text.openFolder, text.ok] : [text.ok];
    const response = await dependencies.showMessage({
      type: input.type,
      title: text.title,
      message: input.message,
      detail: detailLines.join("\n"),
      buttons,
    });
    if (input.path && response === 0) await dependencies.showItemInFolder(input.path);
  };
  const reportFailure = async (
    error: MobileLogPullError,
    path?: string,
  ): Promise<MobileLogPullExportResult> => {
    const reason = text.errors[error.code];
    const message = path !== undefined ? `${text.partial(error.entryCount)}\n${reason}` : reason;
    await showResult({ type: "warning", message, path });
    return { status: "failed", code: error.code, error: error.message, ...(path ? { path } : {}) };
  };

  const target = dependencies.findTarget(windowId);
  if (!target) {
    const error = new MobileLogPullError("not-paired", "no paired mobile");
    logPullResult(dependencies, {
      startedAtMs: now().getTime(),
      outcome: { ok: false, error, bytes: 0 },
    });
    return reportFailure(error);
  }

  const outcome = await exportMobileLogsToFile(dependencies, {
    target,
    query: {
      sinceTs: now().getTime() - MOBILE_LOG_PULL_DEFAULT_WINDOW_MS,
      maxEntries: MOBILE_LOG_PULL_DEFAULT_MAX_ENTRIES,
    },
  });
  if (!outcome.ok) return reportFailure(outcome.error, outcome.path);

  const { summary, path } = outcome;
  await showResult({
    type: "info",
    message: summary.truncated
      ? `${text.done(summary.entryCount)}\n${text.truncated}`
      : text.done(summary.entryCount),
    path,
  });
  return { status: "exported", path, summary };
}
