import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE } from "#e2e/helpers/desktop-app";
import { selectUpstreamModel } from "#e2e/helpers/upstream-provider";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "#e2e/helpers/conversation-session-network";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  listRemoteAgentProcesses,
  prepareSSHLifecycle,
  terminateRemoteProcess,
  type SSHLifecycleProvider,
} from "#e2e/helpers/ssh-remote-lifecycle";
import { readRemoteTabSnapshot, runSSHCommand } from "#e2e/helpers/ssh-remote-p0";
import {
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";
import { openWorkspaceDraftFromSidebar } from "#e2e/helpers/workspace-agent-warmup";

const CASE_MARKER = "E2E_R3_REMOTE_HOOKS";
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/r3-remote-hooks");
const REMOTE_MARKER_DIR = "/home/dev/r3-workspace-a/.zcode-e2e/r3-hooks";
const REMOTE_MARKER_FILE = `${REMOTE_MARKER_DIR}/marker.txt`;
const HOOK_MARKER = "R3_DEV08_USER_PROMPT_HOOK";

const REMOTE_CONFIG_PATCH = `python3 - <<'PY'
import json,os
p=os.path.expanduser("~/.zcode/cli/config.json")
os.makedirs(os.path.dirname(p),exist_ok=True)
try:
    j=json.load(open(p))
except Exception:
    j={}
j["hooks"]={"enabled":True,"timeoutMs":10000,"maxOutputBytes":32768,"events":{"UserPromptSubmit":[{"matcher":"matcher-must-not-filter-prompt","hooks":[{"type":"command","command":"mkdir -p .zcode-e2e/r3-hooks && echo ${HOOK_MARKER} $(date +%s) >> .zcode-e2e/r3-hooks/marker.txt","timeoutMs":10000}]}]}}
open(p,"w").write(json.dumps(j,indent=2))
print("patched")
PY`;

async function localExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe(`${CASE_MARKER}: 远端 user-scope Hook 只在目标 Source 执行且不被 Provider 同步覆盖`, () => {
  let provider: SSHLifecycleProvider | null = null;
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(resolve(artifactDir, "remote-hooks.json"), JSON.stringify(facts, null, 2));
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-DEV-08 远端 ~/.zcode/cli/config.json 的 UserPromptSubmit hook 在远端回合执行（marker 落远端），本机无 marker；切回本机 Source 后本机不执行；Provider 同步不覆盖 hooks 配置", async function () {
    this.timeout(30 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER, { tunnelUsername: "tunnel" });
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;
    await runSSHCommand(prepared.config, `rm -rf "${REMOTE_MARKER_DIR}"`);
    const patched = await runSSHCommand(prepared.config, REMOTE_CONFIG_PATCH);
    expect(patched.stdout).toContain("patched");
    // hooks 在 Agent 启动时加载：若目标 workspace 已有存活 Agent（O-01），先终止让其重建。
    const before = await listRemoteAgentProcesses(prepared.config);
    const stale = before.filter(
      (agent) => agent.cwd === workspaceA || agent.cwd.startsWith(`${workspaceA} `),
    );
    for (const agent of stale) await terminateRemoteProcess(prepared.config, agent, CASE_MARKER);
    facts.terminatedStaleAgents = stale.map((agent) => agent.pid);

    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    // 首发已触发一次 UserPromptSubmit。
    const afterFirst = await runSSHCommand(
      prepared.config,
      `cat "${REMOTE_MARKER_FILE}" 2>/dev/null | wc -l`,
    );
    facts.remoteMarkerLinesAfterFirstTurn = Number.parseInt(afterFirst.stdout.trim() || "0", 10);
    expect(facts.remoteMarkerLinesAfterFirstTurn).toBe(1);
    const start = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${CASE_MARKER}_SECOND 请回复`,
      `${CASE_MARKER}_SECOND`,
      `${CASE_MARKER}: 第二回合未被接受`,
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [`${CASE_MARKER}_SECOND`] },
      `${CASE_MARKER}: 第二回合没有到达回放`,
      60_000,
      { afterIndex: start - 1 },
    );
    await waitForV4AssistantMessageContaining("R3_REMOTE_HOOKS_REPLY", 90_000);
    await waitForV4ConversationState(
      (s) => s.taskId === taskA.taskId && s.state === "idle",
      `${CASE_MARKER}: 第二回合没有收口`,
      90_000,
    );
    const afterSecond = await runSSHCommand(
      prepared.config,
      `cat "${REMOTE_MARKER_FILE}" 2>/dev/null`,
    );
    const lines = afterSecond.stdout.trim().split("\n").filter(Boolean);
    facts.remoteMarkerLinesAfterSecondTurn = lines.length;
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.startsWith(HOOK_MARKER))).toBe(true);
    facts.localMarkerExists = await localExists(
      join(DEFAULT_WORKSPACE, ".zcode-e2e", "r3-hooks", "marker.txt"),
    );
    facts.localConfigHasHook = await readFile(
      join(resolveE2EStorageRoot(), "cli", "config.json"),
      "utf8",
    )
      .then((text) => text.includes(HOOK_MARKER))
      .catch(() => false);
    expect(facts.localMarkerExists).toBe(false);
    expect(facts.localConfigHasHook).toBe(false);

    // Provider 同步（连接与首连已发生）后 hooks 配置仍在远端 config.json。
    const remoteConfig = await runSSHCommand(
      prepared.config,
      'grep -c "UserPromptSubmit" "$HOME/.zcode/cli/config.json"; grep -c "R3_DEV08_USER_PROMPT_HOOK" "$HOME/.zcode/cli/config.json"',
    );
    facts.remoteHooksConfigSurvived = remoteConfig.stdout.trim().split("\n");
    expect(
      remoteConfig.stdout
        .trim()
        .split("\n")
        .every((n) => Number.parseInt(n, 10) >= 1),
    ).toBe(true);

    // 真正执行本机回合，才能证明 UserPromptSubmit 没有串到远端 hook。
    // hook 使用相对 cwd 的 marker，若错误继承到本机，也会落到此处检查的本机路径。
    await openWorkspaceDraftFromSidebar(DEFAULT_WORKSPACE);
    await selectUpstreamModel();
    // 本机 Hook 对照不测思考档位；默认回放模型已移除 high，沿用旧菜单会阻断真实作用范围断言。
    const localMarker = `${CASE_MARKER}_LOCAL_CONTROL`;
    const localRequestStart = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${localMarker} 请回复`,
      localMarker,
      `${CASE_MARKER}: 本机对照回合未被接受`,
    );
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [localMarker] },
      `${CASE_MARKER}: 本机对照没有到达回放`,
      60_000,
      { afterIndex: localRequestStart - 1 },
    );
    await waitForV4AssistantMessageContaining("R3_HOOKS_LOCAL_REPLY", 60_000);
    await waitForV4ConversationState(
      (state) => Boolean(state.taskId && state.taskId !== "draft") && state.state === "idle",
      `${CASE_MARKER}: 本机对照没有完成`,
      60_000,
    );
    expect((await readRemoteTabSnapshot()).activeWorkspaceIdentity).toBeNull();
    facts.localMarkerExistsAfterSwitch = await localExists(
      join(DEFAULT_WORKSPACE, ".zcode-e2e", "r3-hooks", "marker.txt"),
    );
    expect(facts.localMarkerExistsAfterSwitch).toBe(false);
    const remoteAfterLocal = await runSSHCommand(prepared.config, `cat "${REMOTE_MARKER_FILE}"`);
    expect(remoteAfterLocal.stdout).toBe(afterSecond.stdout);
    facts.localControl = { completed: true, remoteMarkerUnchanged: true };
    expect((await readRemoteTabSnapshot(taskA.identity)).remoteSessionId).toBe(
      taskA.remoteSessionId,
    );
    // 清理远端 hooks 配置，避免影响后续用例。
    await runSSHCommand(
      prepared.config,
      `python3 - <<'PY'\nimport json,os\np=os.path.expanduser("~/.zcode/cli/config.json")\nj=json.load(open(p)); j.pop("hooks",None); open(p,"w").write(json.dumps(j,indent=2))\nPY`,
    );
  });
});
