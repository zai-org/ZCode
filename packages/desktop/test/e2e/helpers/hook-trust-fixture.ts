import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_WORKSPACE } from "./desktop-app.js";

/**
 * Workspace Hook Trust e2e fixture（HK05–HK07、HK18）。
 *
 * 与 hooks-lifecycle-fixture 的关键区别：hook trust 的审核对象是 workspace
 * （project）级 `.zcode/config.json`，而不是 user 级 CLI config；且该配置
 * 必须在首个 agent 进程冷启动前落盘（wdio.conf.ts 的 resetE2EHome 会针对
 * 本 spec 再调用一次 installHookTrustFixture），否则 SessionStart 软门禁
 * 不会在首轮 turn 中生效。
 */

export const E2E_HOOK_TRUST_LABELS = {
  sessionStartA: "hook-trust-session-start-a",
  sessionStartB: "hook-trust-session-start-b",
  promptSubmit: "hook-trust-prompt-submit",
} as const;

/** HK18：入口脚本不存在的声明，没有可审核的内容，不能信任也不会执行（D24）。 */
export const E2E_HOOK_TRUST_SCRIPT_MISSING_LABEL = "hook-trust-script-missing";

const WORKSPACE_ZCODE_DIR = join(DEFAULT_WORKSPACE, ".zcode");
const CONFIG_PATH = join(WORKSPACE_ZCODE_DIR, "config.json");
const RECORDER_PATH = join(WORKSPACE_ZCODE_DIR, "hook-trust-e2e-recorder.mjs");
const EVIDENCE_DIR = join(DEFAULT_WORKSPACE, ".hook-trust-e2e");
const EVIDENCE_PATH = join(EVIDENCE_DIR, "executions.jsonl");
// Trust store 位于隔离 E2E HOME（= DEFAULT_WORKSPACE 的上级目录）下，
// 与 adapters 的 resolveWorkspaceHookTrustStorePath 默认值一致。
const TRUST_STORE_PATH = join(
  dirname(DEFAULT_WORKSPACE),
  ".zcode",
  "security",
  "workspace-hook-trust-v1.json",
);

export interface HookTrustExecutionRecord {
  event: string;
  label: string;
  executedAt: string;
}

export interface HookTrustStoreRecord {
  workspaceIdentity: string;
  hookDeclarationDigest: string;
  decision: string;
  eventAtGrant?: string;
}

function processHook(event: string, label: string): Record<string, unknown> {
  return {
    type: "process",
    command: process.execPath,
    // 绝对路径：project hook 属于不可信可执行配置，相对路径解析依赖 cwd，不稳。
    args: [RECORDER_PATH, EVIDENCE_DIR, event, label],
    enabled: true,
    timeoutMs: 10000,
    statusMessage: `Workspace Hook Trust E2E — ${event} ${label}`,
  };
}

// 相对路径的 node 脚本入口会被识别为直接入口；该文件刻意不创建。
function missingScriptHook(): Record<string, unknown> {
  return {
    type: "process",
    command: "node",
    args: [".zcode/hook-trust-missing-script.mjs", E2E_HOOK_TRUST_SCRIPT_MISSING_LABEL],
    enabled: true,
    timeoutMs: 10000,
  };
}

export async function installHookTrustFixture(): Promise<void> {
  await mkdir(WORKSPACE_ZCODE_DIR, { recursive: true });
  await rm(EVIDENCE_DIR, { recursive: true, force: true });

  await writeFile(RECORDER_PATH, RECORDER_SOURCE, "utf8");
  await writeFile(
    CONFIG_PATH,
    `${JSON.stringify(
      {
        hooks: {
          enabled: true,
          timeoutMs: 10000,
          maxOutputBytes: 32768,
          events: {
            SessionStart: [
              {
                matcher: "startup",
                hooks: [
                  processHook("SessionStart", E2E_HOOK_TRUST_LABELS.sessionStartA),
                  processHook("SessionStart", E2E_HOOK_TRUST_LABELS.sessionStartB),
                ],
              },
            ],
            UserPromptSubmit: [
              {
                hooks: [processHook("UserPromptSubmit", E2E_HOOK_TRUST_LABELS.promptSubmit)],
              },
            ],
            Stop: [{ hooks: [missingScriptHook()] }],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function restoreHookTrustFixture(): Promise<void> {
  await rm(CONFIG_PATH, { force: true });
  await rm(RECORDER_PATH, { force: true });
  await rm(EVIDENCE_DIR, { recursive: true, force: true });
}

export async function readHookTrustExecutions(): Promise<HookTrustExecutionRecord[]> {
  try {
    return (await readFile(EVIDENCE_PATH, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HookTrustExecutionRecord);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

export async function waitForHookTrustExecution(
  label: string,
  timeoutMsg: string,
  timeout = 30000,
): Promise<HookTrustExecutionRecord> {
  let record: HookTrustExecutionRecord | undefined;
  await browser.waitUntil(
    async () => {
      record = (await readHookTrustExecutions()).find((item) => item.label === label);
      return Boolean(record);
    },
    { timeout, timeoutMsg },
  );
  return record!;
}

/** 读取持久 Trust store；文件不存在（尚无任何信任）时返回 null。 */
export async function readHookTrustStore(): Promise<HookTrustStoreRecord[] | null> {
  let raw: string;
  try {
    raw = await readFile(TRUST_STORE_PATH, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as { records?: HookTrustStoreRecord[] };
  return parsed.records ?? [];
}

export async function waitForHookTrustStoreRecords(
  predicate: (records: HookTrustStoreRecord[]) => boolean,
  timeoutMsg: string,
  timeout = 30000,
): Promise<HookTrustStoreRecord[]> {
  let latest: HookTrustStoreRecord[] = [];
  await browser.waitUntil(
    async () => {
      const records = await readHookTrustStore();
      if (!records) return false;
      latest = records;
      return predicate(records);
    },
    { timeout, timeoutMsg },
  );
  return latest;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

// recorder 只做一件事：向 evidence JSONL 追加一条执行记录，供 e2e 断言
// “未信任的 Hook 零执行”与“信任后的自然事件执行”。
const RECORDER_SOURCE = String.raw`import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const outputDirectory = process.argv[2];
const event = process.argv[3] ?? "unknown";
const label = process.argv[4] ?? "unknown";
await mkdir(outputDirectory, { recursive: true });
await appendFile(
  join(outputDirectory, "executions.jsonl"),
  JSON.stringify({ event, label, executedAt: new Date().toISOString() }) + "\n",
  "utf8",
);
`;
