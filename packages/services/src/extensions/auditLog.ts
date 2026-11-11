import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  EXTENSION_AUDIT_RETENTION_DAYS,
  extensionAuditEntrySchema,
  type ExtensionAuditEntry,
} from "@zcode/shared/extension-host";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

// 审计日志（docs/plugins/extension-host.md §17.8）：`~/.zcode/v2/extensions/audit/<日期>.jsonl`，只由本服务写，
// 保留 30 天。写操作每次一行（P3c）；授权与撤销各一行。字段见 extensionAuditEntrySchema，不写提示词、标题、
// 正文、路径、设置值、错误原文。写入串行；日期按本机时间。

const AUDIT_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECENT_LIMIT = 20;

export interface AuditLogDeps {
  dir: string;
  logger: Pick<ServiceLogger, "warn">;
  now?: () => number;
}

export interface AuditLog {
  /** 追加一行（v、ts 由本函数填）。失败只告警，不让调用方失败。 */
  append(entry: Omit<ExtensionAuditEntry, "v" | "ts">): Promise<void>;
  /** 该插件最近的审计行，新的在前。 */
  recent(pluginId: string, limit?: number): Promise<ExtensionAuditEntry[]>;
}

function localDate(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function createAuditLog(deps: AuditLogDeps): AuditLog {
  const now = deps.now ?? Date.now;
  let chain: Promise<void> = Promise.resolve();
  /** 最近一次清理的日期：日期变了才再清理一次，不用定时器。 */
  let prunedFor: string | null = null;

  const listFiles = async (): Promise<string[]> =>
    (await readdir(deps.dir).catch(() => [] as string[]))
      .filter((name) => AUDIT_FILE_PATTERN.test(name))
      .sort();

  /** 删掉 30 天以前的文件（按文件名里的日期）。 */
  const prune = async (today: string) => {
    if (prunedFor === today) return;
    prunedFor = today;
    const cutoff = localDate(now() - EXTENSION_AUDIT_RETENTION_DAYS * DAY_MS);
    for (const name of await listFiles()) {
      if (name.slice(0, 10) < cutoff) await rm(join(deps.dir, name), { force: true });
    }
  };

  return {
    append(entry) {
      const ts = now();
      const line = extensionAuditEntrySchema.parse({ v: 1, ts, ...entry });
      const today = localDate(ts);
      const run = chain.then(async () => {
        await mkdir(deps.dir, { recursive: true });
        await prune(today);
        await appendFile(join(deps.dir, `${today}.jsonl`), `${JSON.stringify(line)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      });
      chain = run.catch((error: unknown) => {
        deps.logger.warn(undefined, "append extension audit failed", {
          code: (error as { code?: unknown } | null)?.code,
        });
      });
      return chain;
    },
    async recent(pluginId, limit = DEFAULT_RECENT_LIMIT) {
      // 等在途的写完成，刚记下的那一行也能读到。
      await chain;
      const entries: ExtensionAuditEntry[] = [];
      for (const name of (await listFiles()).reverse()) {
        const text = await readFile(join(deps.dir, name), "utf8").catch(() => "");
        const lines = text.split("\n").filter(Boolean).reverse();
        for (const raw of lines) {
          let value: unknown;
          try {
            value = JSON.parse(raw);
          } catch {
            continue;
          }
          const parsed = extensionAuditEntrySchema.safeParse(value);
          if (!parsed.success || parsed.data.pluginId !== pluginId) continue;
          entries.push(parsed.data);
          if (entries.length >= limit) return entries;
        }
      }
      return entries;
    },
  };
}
