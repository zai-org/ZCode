import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { seedProviderReadinessHistoryFixture } from "./provider-readiness-history-fixture.js";
import {
  seedPersonalProviderConfig,
  seedPersonalDefaultModelSelection,
} from "./model-provider-restart-config.js";

/** 在启动 App 前准备隔离历史；工具仅作为已完成的持久记录，不实际执行或调用模型。 */
export async function seedSessionPaneRetentionFixture(options: {
  e2eHomeDir: string;
  cliEntryPoint: string;
  crossWorkspace?: boolean;
}) {
  const home = resolve(options.e2eHomeDir);
  if (home === resolve(homedir())) throw new Error("不能向用户 HOME 写入合成历史");
  const workspacePath = join(home, "Workspace");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(join(home, ".zcode/v2"), { recursive: true });
  const workspaceFor = (index: number) =>
    options.crossWorkspace ? join(home, `Workspace-${index}`) : workspacePath;
  for (let index = 0; index < 8; index++) {
    await mkdir(workspaceFor(index), { recursive: true });
    await seedProviderReadinessHistoryFixture({
      ...options,
      workspacePath: workspaceFor(index),
      history: {
        sessionId: `sess_probe_retention_${index}`,
        title: `Retention Probe ${index}`,
        userText: `RETENTION_USER_${index} Inspect the synthetic test file.`,
        assistantText: `RETENTION_REPLY_${index}\n\n${`Synthetic reply for session ${index}. This fixture tests retained history.\n`.repeat(160)}`,
        assistantInputTokens: 100,
        assistantOutputTokens: 100,
        modelId: "probe-model",
        runtimeProviderId: "probe-local",
        taskProviderId: "glm",
      },
    });
  }
  // node:sqlite 只有同步 API；此处仅离线播种测试 fixture，不在产品 IO 路径执行。
  const db = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
  try {
    for (let index = 0; index < 8; index++) {
      const sessionId = `sess_probe_retention_${index}`;
      const at = Date.now() - 30_000;
      const content = `RETENTION_PAYLOAD_${index}\n${Array.from(
        { length: 2800 },
        (_, line) =>
          `line ${line} session ${index}: diagnostic synthetic content with a stable unique value.`,
      ).join("\n")}`;
      const part = {
        type: "tool",
        callID: `probe_call_${index}`,
        tool: "Write",
        state: {
          status: "completed",
          input: { file_path: join(workspaceFor(index), `fixture-${index}.txt`), content },
          output: `Synthetic write completed for session ${index}.`,
          title: "Write",
          time: { start: at, end: at + 10 },
          metadata: { fixture: true },
        },
        time: { start: at, end: at + 10 },
      };
      db.prepare(
        "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
      ).run(
        `part_tool_${sessionId}`,
        `msg_assistant_${sessionId}`,
        sessionId,
        at,
        at + 10,
        JSON.stringify(part),
      );
      db.prepare(
        "INSERT INTO session_entry(id,session_id,type,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
      ).run(
        `model_${sessionId}`,
        sessionId,
        "runtime/model_selection",
        at,
        at,
        JSON.stringify({ modelSelection: { providerId: "probe-local", modelId: "probe-model" } }),
      );
    }
  } finally {
    db.close();
  }
  const providerFile = join(home, ".zcode/v2/provider_config.json");
  await seedPersonalProviderConfig(providerFile, {
    id: "probe-local",
    label: "Retention Local Fixture",
    apiFormat: "openai-chat-completions",
    baseURL: "http://127.0.0.1:19326/v1",
    apiKey: "synthetic-no-remote-access",
    enabled: true,
    models: [{ id: "probe-model", contextWindow: 200_000, maxOutputTokens: 4096 }],
  });
  await seedPersonalDefaultModelSelection(providerFile, {
    providerId: "probe-local",
    modelId: "probe-model",
  });
  await writeFile(
    join(home, ".zcode/v2/setting.json"),
    JSON.stringify({
      providerFamilyDomain: "zai",
      providerFamilyDomainMigrated: true,
      providerFamilyDomainUpdatedAt: Date.now(),
      providerFamilyConnectionSelections: {},
      recentProjects: [workspacePath],
      lastWorkspaceSession: [{ kind: "local", workspacePath, workspacePurpose: "project" }],
      lastActiveTabIndex: 0,
    }),
  );
  await writeFile(join(home, ".zcode/v2/credentials.json"), "{}");
  return { home, workspacePath, sessions: 8, messages: 16, parts: 24 };
}
