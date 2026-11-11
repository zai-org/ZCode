import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ServiceChannels } from "@zcode/shared";
import type { ProjectTask, ProjectTree, VirtualProject } from "@zcode/services";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session-readonly-tool";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { seedProviderReadinessHistoryFixture } from "#e2e/helpers/provider-readiness-history-fixture";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  readAppControlToolResult,
  type AppControlToolEvidence,
} from "#e2e/helpers/app-control-evidence";
import { waitForUpstreamNetworkCapture } from "#e2e/helpers/upstream-capture";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

// 会话工具设计 0.6 / 0.7 / 0.9：SCT05 创建重试换主目录、SCT06 长轮次 wait，
// 以及 SCT02 读一个从未打开过的冷会话。
// 目标会话一轮 70 个工具调用，超过快照尾窗 60 行，turnHeader 只在 owner 全量投影里。
const CASE = "E2E_SCT06";
const LONG_TURN_TOOL_CALLS = 70;
const SECOND_ROOT = join(dirname(DEFAULT_WORKSPACE), "ZCodeProjectSCT06Second");
// 冷会话：只写两个库，不启动运行态；读取前它从未被打开，CLI 侧没有 record。
const COLD_SESSION = "session_e2e_sct06_cold";
const COLD_TITLE = "E2E_SCT06_COLD_TITLE";
const COLD_USER_TEXT = "E2E_SCT06_COLD_USER";
const COLD_ASSISTANT_TEXT = "E2E_SCT06_COLD_ASSISTANT";
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR!;
const tools: AppControlToolEvidence = {};
const assertions: Record<string, unknown> = {};
const evidence = { tools, assertions };
interface SessionRef {
  kind: "app";
  sourceServerId: string;
  workspacePath: string;
  sessionId: string;
  workspaceIdentity?: string;
  project?: { kind: "app"; sourceServerId: string; projectId: string };
}
interface Operation {
  session: SessionRef;
  commandId: string;
}
interface Creation {
  creation: string;
  firstInput: string;
  delivery: string;
  session: SessionRef;
  operation: Operation;
}
interface Admission {
  admission: string;
  delivery: string;
  session: SessionRef;
  operation: Operation;
}
interface Wait {
  status: string;
  operations: Array<{ operation: Operation; status: string; attention?: { kind: string } }>;
}

async function action<T>(key: string, intent: string, approval = false): Promise<T> {
  await sendV4Prompt(
    `${CASE}_ACTION_${key.toUpperCase()}: ${intent} Use complete identities from the earlier actual tool results. Do not navigate or invent a result. After the tool returns reply exactly SCT06_${key.toUpperCase()}_RETURNED.`,
  );
  if (approval) expect(await approveV4Permission()).toBe(true);
  await waitForV4AssistantMessageContaining(`SCT06_${key.toUpperCase()}_RETURNED`, 120_000);
  await waitForV4Pane((value) => !value.canStop, `SCT06 ${key} caller has not completed`);
  const request = (await waitForUpstreamNetworkCapture(`toolu_sct06_${key}`)).requestJson;
  return readAppControlToolResult<T>(request, `toolu_sct06_${key}`, tools);
}
function operationStatus(result: Wait, operation: Operation) {
  return result.operations.find((value) => value.operation.commandId === operation.commandId);
}
async function readTree(): Promise<ProjectTree> {
  // 只读 Host 持久组织事实；被测动作全部来自真实 Agent 工具。
  return callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [{}]);
}

describe(`${CASE}: App session tools on a long turn and a retried creation`, () => {
  // 冷会话必须在 Host 启动前落盘，否则 Host 的 source snapshot 不含这一行。
  before(async () => {
    const home = process.env.ZCODE_E2E_HOME_DIR ?? "";
    if (!basename(home).startsWith(".e2e-home-")) throw new Error("需要隔离 E2E HOME");
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        await seedProviderReadinessHistoryFixture({
          cliEntryPoint: resolve("../../apps/zcode-cli/packages/cli/dist/zcode.cjs"),
          e2eHomeDir: home,
          workspacePath: DEFAULT_WORKSPACE,
          history: {
            sessionId: COLD_SESSION,
            title: COLD_TITLE,
            userText: COLD_USER_TEXT,
            assistantText: COLD_ASSISTANT_TEXT,
            modelId: "deepseek-v4-flash",
            runtimeProviderId: "e2e-upstream",
            taskProviderId: "glm",
            assistantInputTokens: 0,
            assistantOutputTokens: 0,
          },
        });
      },
    });
  });

  after(async () => {
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        join(artifacts, "SCT06-long-turn-retry.json"),
        JSON.stringify(evidence, null, 2),
      );
      await browser.saveScreenshot(join(artifacts, "SCT06-desktop.png"));
    }
    await restoreHandoffProbes();
    await clearAppData();
  });

  it("reports long-turn outcomes past the snapshot tail and reuses the first creation on retry", async function () {
    this.timeout(900_000);
    await ensureReadonlyToolFixtureFile();
    await mkdir(SECOND_ROOT, { recursive: true });
    await prepareV4ConversationE2E();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await sendV4Prompt(buildReadonlyToolPrompt(`${CASE}_CALLER`));
    await waitForV4AssistantMessageContaining("upstream-e2e-ok", 90_000);
    await waitForV4Pane(
      (value) => !value.canStop && value.sessionId !== "draft",
      "SCT06 caller missing",
    );
    await installHandoffRpcProbe();

    const projects = await action<{
      projects: Array<{ project: NonNullable<SessionRef["project"]> }>;
    }>("projects", "Call ListProjects with query=ZCodeProject.");
    expect(projects.projects).toHaveLength(1);
    const project = projects.projects[0]!.project;

    const created = await action<Creation>(
      "create",
      "Call CreateSession in that project with prompt E2E_SCT06_LONG_TARGET (step marker E2E_SCT06_CREATE; do not pass requestId).",
      true,
    );
    expect(created).toMatchObject({ creation: "created", firstInput: "accepted" });
    expect(created.session.workspacePath).toBe(DEFAULT_WORKSPACE);

    // 有界等待：观察期间 header 的增量照常到达，作为对照。
    const live = await action<Wait>(
      "completed",
      "Call WaitSessions for the create operation, mode=all, timeoutMs=60000.",
    );
    expect(operationStatus(live, created.operation)?.status).toBe("completed");
    // 回合已结束且 header 已滚出尾窗：只读当前结果，必须仍为 completed，不能是 unknown。
    const settled = await action<Wait>(
      "settled",
      "Call WaitSessions for the same create operation, mode=all, timeoutMs=0.",
    );
    expect(settled.status).toBe("completed");
    expect(operationStatus(settled, created.operation)?.status).toBe("completed");
    assertions.longTurnCompletion = { live, settled, toolCalls: LONG_TURN_TOOL_CALLS };

    // 测试准备：把项目主目录换成第二个 root，再用首次回执里的 requestId（retryOf）重试创建。
    const before = (await readTree()).projects.find((value) => value.id === project.projectId)!;
    await callHandoffHost<VirtualProject>(ServiceChannels.Project, "saveProject", [
      { id: before.id, roots: [DEFAULT_WORKSPACE, SECOND_ROOT], primaryRoot: SECOND_ROOT },
    ]);
    const moved = (await readTree()).projects.find((value) => value.id === project.projectId)!;
    expect(moved.roots.find((root) => root.isPrimary)?.rootPath).toBe(SECOND_ROOT);
    const retried = await action<Creation>(
      "retry",
      "Call CreateSession again with exactly the same project and prompt E2E_SCT06_LONG_TARGET (step marker E2E_SCT06_CREATE), passing retryOf set to the requestId from the first CreateSession result.",
      true,
    );
    expect(retried.creation).toBe("created");
    expect(retried.session).toEqual(created.session);
    expect(retried.operation).toEqual(created.operation);
    const tree = await readTree();
    expect(tree.tasks.filter((task) => task.workspacePath === SECOND_ROOT)).toHaveLength(0);
    assertions.retryReusesFirstCreation = { created, retried, primaryRoot: SECOND_ROOT };

    // 长回合后等审批：有界等待必须返回 needs_attention，不能一直报 running 到超时。
    const asked = await action<Admission>(
      "send",
      "Call SendToSession on the created session with prompt E2E_SCT06_LONG_ASK (step marker E2E_SCT06_ASK; do not pass requestId).",
      true,
    );
    expect(asked.session).toEqual(created.session);
    const attention = await action<Wait>(
      "attention",
      "Call WaitSessions for the send operation, mode=all, timeoutMs=20000.",
    );
    expect(attention.status).toBe("completed");
    expect(operationStatus(attention, asked.operation)).toMatchObject({
      status: "needs_attention",
      attention: { kind: "approval" },
    });
    assertions.longTurnAttention = { asked, attention };

    // 规格 0.9：读一个从未打开过的冷会话。summary 一直可用；messages 原先失败于 App control failed。
    const coldBefore = (await readTree()).tasks.find((task) => task.taskId === COLD_SESSION);
    expect(coldBefore).toBeDefined();
    const coldSummary = await action<{ summary: { title: string; status: string } }>(
      "cold_summary",
      `Call ReadSession with sessionId=${COLD_SESSION} and view=summary.`,
    );
    expect(coldSummary.summary.title).toBe(COLD_TITLE);
    const coldMessages = await action<{
      session: SessionRef;
      messages: Array<{ id: string; role: string; text: string }>;
    }>(
      "cold_messages",
      `Call ReadSession with sessionId=${COLD_SESSION}, view=messages, limit=20.`,
    );
    expect(coldMessages.session.sessionId).toBe(COLD_SESSION);
    expect(coldMessages.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(coldMessages.messages[0]!.text).toContain(COLD_USER_TEXT);
    expect(coldMessages.messages[1]!.text).toContain(COLD_ASSISTANT_TEXT);
    // 读取不恢复 runtime、不认领 owner、不标已读：Host 的组织事实必须逐字不变。
    const coldAfter = (await readTree()).tasks.find((task) => task.taskId === COLD_SESSION);
    expect(coldAfter).toEqual(coldBefore);
    const coldSummaryAfter = await action<{ summary: { status: string; executionId?: string } }>(
      "cold_idle",
      `Call ReadSession with sessionId=${COLD_SESSION} and view=summary.`,
    );
    expect(coldSummaryAfter.summary.executionId).toBeUndefined();
    assertions.coldSessionRead = {
      coldSummary,
      coldMessages,
      taskUnchanged: coldAfter as ProjectTask | undefined,
    };
  });
});
