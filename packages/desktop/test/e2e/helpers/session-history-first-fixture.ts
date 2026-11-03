import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedProviderReadinessHistoryFixture } from "./provider-readiness-history-fixture.js";

export const HISTORY_FIRST_SESSION = "sess_e2e_history_first";
export const HISTORY_FIRST_FAILED_SESSION = "sess_e2e_history_first_failed";
export const HISTORY_FIRST_TEXT = "E2E_HISTORY_FIRST 已持久化的历史正文";

export async function seedSessionHistoryFirstFixture(options: {
  cliEntryPoint: string;
  e2eHomeDir: string;
  workspacePath: string;
  providerId: string;
  modelId: string;
  thoughtLevel?: string;
}) {
  for (const sessionId of [HISTORY_FIRST_SESSION, HISTORY_FIRST_FAILED_SESSION]) {
    await seedProviderReadinessHistoryFixture({
      ...options,
      history: {
        sessionId,
        title:
          sessionId === HISTORY_FIRST_SESSION ? "E2E_HISTORY_FIRST" : "E2E_HISTORY_FIRST_FAILURE",
        userText: "E2E_HISTORY_FIRST 历史问题",
        assistantText:
          sessionId === HISTORY_FIRST_SESSION
            ? HISTORY_FIRST_TEXT
            : `${HISTORY_FIRST_TEXT}\n\n${Array.from({ length: 80 }, (_, i) => `历史段落 ${i + 1}：初始化失败后仍可阅读。`).join("\n\n")}`,
        assistantInputTokens: 10,
        assistantOutputTokens: 10,
        modelId: options.modelId,
        runtimeProviderId: options.providerId,
        taskProviderId: "glm",
      },
    });
    // 通用 fixture 用于测试缺失 provider；此处补齐正式会话的 durable 模型选择，验证 ready 后续发。
    const database = new DatabaseSync(join(options.e2eHomeDir, ".zcode", "cli", "db", "db.sqlite"));
    try {
      // 旧版本可能保存不同的词法路径表示；真实 Host 仍从原 attachment 打开，不能靠迁库修正。
      if (sessionId === HISTORY_FIRST_SESSION) {
        database
          .prepare("UPDATE session SET directory = ?, path = ? WHERE id = ?")
          .run(options.workspacePath + sep, options.workspacePath + sep, sessionId);
      }
      database
        .prepare(`INSERT INTO session_entry (id, session_id, type, time_created, time_updated, data)
      VALUES (?, ?, 'runtime/model_selection', ?, ?, ?)`)
        .run(
          `entry_model_${sessionId}`,
          sessionId,
          Date.now(),
          Date.now(),
          JSON.stringify({
            modelSelection: {
              providerId: options.providerId,
              modelId: options.modelId,
              ...(options.thoughtLevel
                ? { options: { reasoningLevel: options.thoughtLevel } }
                : {}),
            },
          }),
        );
    } finally {
      database.close();
    }
  }
  const root = join(options.workspacePath, ".zcode", "history-first-e2e");
  await mkdir(root, { recursive: true });
  const script = join(root, "resume-gate.mjs");
  // 文件事件屏障证明首帧不等待 hook；不用固定 sleep 猜测初始化进度。
  await writeFile(
    script,
    `import { watch } from 'node:fs';
import { writeFile, appendFile, access } from 'node:fs/promises';
const [entered, release] = process.argv.slice(2);
await appendFile(${JSON.stringify(join(root, "attempts"))}, 'resume\\n');
await new Promise((resolve, reject) => {
  const watcher = watch(${JSON.stringify(root)}, async () => {
    try { await access(release); watcher.close(); resolve(); } catch {}
  });
  watcher.on('error', reject);
  writeFile(entered, 'entered').catch(reject);
});
process.stdout.write('{}');
`,
  );
  const config = join(options.e2eHomeDir, ".zcode", "cli", "config.json");
  const settings = JSON.parse(await readFile(config, "utf8").catch(() => "{}"));
  await writeFile(
    config,
    JSON.stringify({
      ...settings,
      hooks: {
        enabled: true,
        events: {
          SessionStart: [
            {
              matcher: "resume",
              hooks: [
                {
                  type: "process",
                  command: process.execPath,
                  args: [script, join(root, "entered"), join(root, "release")],
                  timeoutMs: 120_000,
                },
              ],
            },
          ],
        },
      },
    }),
  );
}
